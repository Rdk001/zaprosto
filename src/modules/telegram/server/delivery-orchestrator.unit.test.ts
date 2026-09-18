import { describe, expect, it, vi } from "vitest";

import { TELEGRAM_POLICY } from "../domain/policy";
import {
  TELEGRAM_DELIVERY_ORCHESTRATOR_DEFAULTS,
  TelegramDeliveryOrchestrator,
  type TelegramDeliveryDiagnosticCode,
  type TelegramDeliveryOrchestratorConfiguration,
} from "./delivery-orchestrator";
import type { TelegramOutboxDispatcher } from "./outbox-dispatcher";
import type { TelegramOutboxRepository } from "./outbox-repository";

const configuration: TelegramDeliveryOrchestratorConfiguration = {
  dispatchIntervalMs: 10,
  recoveryIntervalMs: 25,
  recoveryBatchSize: 3,
  errorBackoffMs: 7,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  overrides: {
    dispatchOnce?: ReturnType<typeof vi.fn>;
    recoverExpired?: ReturnType<typeof vi.fn>;
    logger?: { log: (code: TelegramDeliveryDiagnosticCode) => void };
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    monotonicNow?: () => number;
    configuration?: TelegramDeliveryOrchestratorConfiguration;
  } = {},
) {
  const dispatchOnce = overrides.dispatchOnce ?? vi.fn().mockResolvedValue({ claimed: 0 });
  const recoverExpired = overrides.recoverExpired ?? vi.fn().mockResolvedValue([]);
  const logger = overrides.logger ?? { log: vi.fn() };
  const orchestrator = new TelegramDeliveryOrchestrator(
    {
      dispatcher: {
        dispatchOnce: dispatchOnce as unknown as TelegramOutboxDispatcher["dispatchOnce"],
      },
      outbox: {
        recoverExpired: recoverExpired as unknown as TelegramOutboxRepository["recoverExpired"],
      },
      logger,
      ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
      ...(overrides.monotonicNow === undefined ? {} : { monotonicNow: overrides.monotonicNow }),
    },
    overrides.configuration ?? configuration,
  );
  return { orchestrator, dispatchOnce, recoverExpired, logger };
}

describe("TelegramDeliveryOrchestrator", () => {
  it("makes run and stop idempotent and waits for started dispatch settlement", async () => {
    const started = deferred<void>();
    const release = deferred<unknown>();
    const dispatchOnce = vi.fn(async () => {
      started.resolve();
      return release.promise;
    });
    const { orchestrator } = setup({ dispatchOnce });

    const firstRun = orchestrator.run();
    const secondRun = orchestrator.run();
    expect(secondRun).toBe(firstRun);
    await started.promise;

    let stopped = false;
    const firstStop = orchestrator.stop().then(() => {
      stopped = true;
    });
    const secondStop = orchestrator.stop();
    await Promise.resolve();
    expect(stopped).toBe(false);

    release.resolve({ claimed: 0 });
    await Promise.all([firstRun, secondRun, firstStop, secondStop]);
    expect(dispatchOnce).toHaveBeenCalledOnce();
  });

  it("allows stop before run and starts no recovery or dispatch afterwards", async () => {
    const { orchestrator, dispatchOnce, recoverExpired } = setup();

    await expect(orchestrator.stop()).resolves.toBeUndefined();
    await expect(orchestrator.stop()).resolves.toBeUndefined();
    const first = orchestrator.run();
    expect(orchestrator.run()).toBe(first);
    await first;

    expect(recoverExpired).not.toHaveBeenCalled();
    expect(dispatchOnce).not.toHaveBeenCalled();
  });

  it("runs startup recovery before the first dispatch with the configured bounded batch", async () => {
    const order: string[] = [];
    const recoverExpired = vi.fn(async () => {
      order.push("recover");
      return [];
    });
    const dispatchOnce = vi.fn(async () => {
      order.push("dispatch");
      void orchestrator.stop();
      return { claimed: 0 };
    });
    const { orchestrator } = setup({ dispatchOnce, recoverExpired });

    await orchestrator.run();

    expect(order).toEqual(["recover", "dispatch"]);
    expect(recoverExpired).toHaveBeenCalledOnce();
    expect(recoverExpired).toHaveBeenCalledWith({ batchSize: 3 });
  });

  it("repeats one bounded recovery only when monotonic cadence becomes due", async () => {
    let now = 0;
    const recoveryTimes: number[] = [];
    const recoverExpired = vi.fn(async () => {
      recoveryTimes.push(now);
      return [];
    });
    const dispatchOnce = vi.fn(async () => {
      if (dispatchOnce.mock.calls.length === 4) void orchestrator.stop();
      return { claimed: 0 };
    });
    const { orchestrator } = setup({
      dispatchOnce,
      recoverExpired,
      monotonicNow: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await orchestrator.run();

    expect(dispatchOnce).toHaveBeenCalledTimes(4);
    expect(recoverExpired).toHaveBeenCalledTimes(2);
    expect(recoveryTimes).toEqual([0, 30]);
    const recoveryCalls = recoverExpired.mock.calls as unknown as Array<[{ batchSize: number }]>;
    expect(recoveryCalls.every(([input]) => input.batchSize === 3)).toBe(true);
  });

  it("does not overlap slow recovery, dispatch, or a following tick", async () => {
    const recoveryRelease = deferred<unknown[]>();
    const dispatchRelease = deferred<unknown>();
    const recoverExpired = vi.fn(() => recoveryRelease.promise);
    let active = 0;
    let maximum = 0;
    const dispatchOnce = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        return await dispatchRelease.promise;
      } finally {
        active -= 1;
      }
    });
    const { orchestrator } = setup({ recoverExpired, dispatchOnce });

    const running = orchestrator.run();
    await vi.waitFor(() => expect(recoverExpired).toHaveBeenCalledOnce());
    expect(dispatchOnce).not.toHaveBeenCalled();
    recoveryRelease.resolve([]);
    await vi.waitFor(() => expect(dispatchOnce).toHaveBeenCalledOnce());
    expect(maximum).toBe(1);

    const stopping = orchestrator.stop();
    await Promise.resolve();
    expect(dispatchOnce).toHaveBeenCalledOnce();
    expect(recoverExpired).toHaveBeenCalledOnce();
    dispatchRelease.resolve({ claimed: 0 });
    await Promise.all([running, stopping]);
  });

  it("pauses between empty batches instead of busy-spinning", async () => {
    const delays: number[] = [];
    const { orchestrator } = setup({
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        void orchestrator.stop();
      },
    });

    await orchestrator.run();

    expect(delays).toEqual([configuration.dispatchIntervalMs]);
  });

  it("logs only safe codes and continues after bounded recovery and dispatch backoff", async () => {
    const secret = "postgres://secret BOT_TOKEN chatId payload raw-error";
    let now = 0;
    const logged: TelegramDeliveryDiagnosticCode[] = [];
    const delays: number[] = [];
    const recoverExpired = vi.fn().mockRejectedValueOnce(new Error(secret)).mockResolvedValue([]);
    const dispatchOnce = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error(secret), { cause: secret }))
      .mockImplementationOnce(async () => {
        void orchestrator.stop();
        return { claimed: 0 };
      });
    const { orchestrator } = setup({
      recoverExpired,
      dispatchOnce,
      logger: { log: (code) => logged.push(code) },
      monotonicNow: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      configuration: { ...configuration, recoveryIntervalMs: 1_000 },
    });

    await orchestrator.run();

    expect(delays).toEqual([configuration.errorBackoffMs, configuration.errorBackoffMs]);
    expect(logged).toEqual([
      "TELEGRAM_DELIVERY_RECOVERY_FAILED",
      "TELEGRAM_DELIVERY_DISPATCH_FAILED",
    ]);
    expect(dispatchOnce).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it("passes abort to dispatch and starts no work after stop while settlement is pending", async () => {
    const started = deferred<AbortSignal>();
    const release = deferred<unknown>();
    const dispatchOnce = vi.fn(async (input: { signal?: AbortSignal }) => {
      if (!input.signal) throw new Error("Expected signal");
      started.resolve(input.signal);
      return release.promise;
    });
    const { orchestrator, recoverExpired } = setup({ dispatchOnce });

    const running = orchestrator.run();
    const signal = await started.promise;
    const stopping = orchestrator.stop();
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(dispatchOnce).toHaveBeenCalledOnce();
    expect(recoverExpired).toHaveBeenCalledOnce();

    release.resolve({ claimed: 1, completed: 1 });
    await Promise.all([running, stopping]);
    expect(dispatchOnce).toHaveBeenCalledOnce();
    expect(recoverExpired).toHaveBeenCalledOnce();
  });

  it("contains logger and sleeper failures without exposing their errors or spinning", async () => {
    const secret = "DATABASE_URL=secret raw logger cause";
    const dispatchOnce = vi.fn().mockRejectedValue(new Error(secret));
    const logger = {
      log: vi.fn(() => {
        throw new Error(secret);
      }),
    };
    const sleep = vi.fn(async () => {
      throw new Error(secret);
    });
    const { orchestrator } = setup({ dispatchOnce, logger, sleep });

    await expect(orchestrator.run()).resolves.toBeUndefined();

    expect(dispatchOnce).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith("TELEGRAM_DELIVERY_DISPATCH_FAILED");
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("uses production-safe defaults", () => {
    expect(TELEGRAM_DELIVERY_ORCHESTRATOR_DEFAULTS).toEqual({
      dispatchIntervalMs: 1_000,
      recoveryIntervalMs: 60_000,
      recoveryBatchSize: TELEGRAM_POLICY.claimBatchSize,
      errorBackoffMs: 1_000,
    });
  });

  it.each([
    { ...configuration, dispatchIntervalMs: 0 },
    { ...configuration, dispatchIntervalMs: 1.5 },
    { ...configuration, recoveryIntervalMs: 0 },
    { ...configuration, recoveryBatchSize: 0 },
    { ...configuration, recoveryBatchSize: TELEGRAM_POLICY.claimBatchSize + 1 },
    { ...configuration, errorBackoffMs: Number.POSITIVE_INFINITY },
    { ...configuration, extra: true },
  ])("strictly rejects invalid lifecycle configuration %#", (invalid) => {
    expect(() => setup({ configuration: invalid })).toThrowError(
      expect.objectContaining({
        code: "DELIVERY_LIFECYCLE_CONFIGURATION_INVALID",
        message: "DELIVERY_LIFECYCLE_CONFIGURATION_INVALID",
      }),
    );
  });

  it("serializes configuration errors without secret fields or raw causes", () => {
    const canary = "secret-canary raw-error";
    let error: unknown;
    try {
      setup({ configuration: { ...configuration, recoveryBatchSize: canary } as never });
    } catch (value) {
      error = value;
    }

    expect(JSON.stringify(error)).toBe(
      '{"name":"TelegramDeliveryOrchestratorError","code":"DELIVERY_LIFECYCLE_CONFIGURATION_INVALID"}',
    );
    expect(JSON.stringify(error)).not.toContain(canary);
  });
});
