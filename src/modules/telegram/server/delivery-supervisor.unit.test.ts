import { describe, expect, it, vi } from "vitest";

import type { TelegramBotApi } from "./bot-api";
import type { TelegramDeliveryVerificationResult } from "./delivery-readiness-service";
import {
  TelegramDeliverySupervisor,
  type TelegramDeliveryLifecycle,
  type TelegramDeliverySupervisorDiagnosticCode,
} from "./delivery-supervisor";
import type { TelegramRuntimeConfiguration } from "./runtime-config";

const enabled = {
  kind: "ENABLED",
  botToken: "123456:SUPERVISOR_TOKEN_123456789",
  botUsername: "Zaprosto_Test_Bot",
  pollTimeoutSeconds: 30,
} as const satisfies TelegramRuntimeConfiguration;
const verified: TelegramDeliveryVerificationResult = {
  status: "VERIFIED",
  verified: true,
  botUsername: enabled.botUsername,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lifecycle(onStop?: () => Promise<void>): TelegramDeliveryLifecycle & {
  run: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const settled = deferred<void>();
  return {
    run: vi.fn(() => settled.promise),
    stop: vi.fn(async () => {
      await onStop?.();
      settled.resolve();
    }),
  };
}

function fakeApi(): TelegramBotApi {
  return {} as TelegramBotApi;
}

describe("TelegramDeliverySupervisor", () => {
  it("keeps disabled configuration idle without creating API or lifecycle", async () => {
    const createApi = vi.fn();
    const createLifecycle = vi.fn();
    const supervisor = new TelegramDeliverySupervisor({
      configuration: () => ({ kind: "DISABLED", pollTimeoutSeconds: 30 }),
      createApi,
      verifyReadiness: vi.fn(async () => ({ status: "DISABLED", verified: false }) as const),
      createLifecycle,
      logger: { log: vi.fn() },
      readinessRecheckMs: 5,
      sleep: vi.fn(async () => void supervisor.stop()),
    });

    await supervisor.run();
    expect(createApi).not.toHaveBeenCalled();
    expect(createLifecycle).not.toHaveBeenCalled();
  });

  it("starts one lifecycle only after VERIFIED and makes run/stop idempotent", async () => {
    const active = lifecycle();
    const createLifecycle = vi.fn(() => active);
    const checked = deferred<void>();
    const supervisor = new TelegramDeliverySupervisor({
      configuration: () => enabled,
      createApi: () => fakeApi(),
      verifyReadiness: vi.fn(async () => verified),
      createLifecycle,
      logger: { log: vi.fn() },
      readinessRecheckMs: 5,
      sleep: vi.fn(async (_milliseconds, signal) => {
        checked.resolve();
        return new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }),
    });

    const firstRun = supervisor.run();
    expect(supervisor.run()).toBe(firstRun);
    await checked.promise;
    expect(createLifecycle).toHaveBeenCalledOnce();
    expect(active.run).toHaveBeenCalledOnce();
    await Promise.all([supervisor.stop(), supervisor.stop(), firstRun]);
    expect(active.stop).toHaveBeenCalledOnce();
  });

  it("stops and settles delivery when periodic readiness is lost before another session", async () => {
    const active = lifecycle();
    const verifyReadiness = vi
      .fn<() => Promise<TelegramDeliveryVerificationResult>>()
      .mockResolvedValueOnce(verified)
      .mockResolvedValueOnce({
        status: "NOT_READY",
        verified: false,
        reasonCode: "NETWORK_UNREACHABLE",
      });
    let pauses = 0;
    const supervisor = new TelegramDeliverySupervisor({
      configuration: () => enabled,
      createApi: () => fakeApi(),
      verifyReadiness,
      createLifecycle: vi.fn(() => active),
      logger: { log: vi.fn() },
      readinessRecheckMs: 5,
      sleep: vi.fn(async () => {
        pauses += 1;
        if (pauses === 2) void supervisor.stop();
      }),
    });

    await supervisor.run();
    expect(verifyReadiness).toHaveBeenCalledTimes(2);
    expect(active.stop).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight readiness check and starts no lifecycle", async () => {
    const started = deferred<AbortSignal>();
    const createLifecycle = vi.fn();
    const supervisor = new TelegramDeliverySupervisor({
      configuration: () => enabled,
      createApi: () => fakeApi(),
      verifyReadiness: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        started.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {
          status: "NOT_READY",
          verified: false,
          reasonCode: "NETWORK_UNREACHABLE",
        } as const;
      }),
      createLifecycle,
      logger: { log: vi.fn() },
    });

    const running = supervisor.run();
    const signal = await started.promise;
    await supervisor.stop();
    await running;
    expect(signal.aborted).toBe(true);
    expect(createLifecycle).not.toHaveBeenCalled();
  });

  it("settles an old token session before starting the rotated same-bot session", async () => {
    const releaseStop = deferred<void>();
    const first = lifecycle(() => releaseStop.promise);
    const second = lifecycle();
    let current: TelegramRuntimeConfiguration = enabled;
    const createLifecycle = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    let pauses = 0;
    const supervisor = new TelegramDeliverySupervisor({
      configuration: () => current,
      createApi: () => fakeApi(),
      verifyReadiness: vi.fn(async () => verified),
      createLifecycle,
      logger: { log: vi.fn() },
      readinessRecheckMs: 5,
      sleep: vi.fn(async () => {
        pauses += 1;
        if (pauses === 1) current = { ...enabled, botToken: `${enabled.botToken}_ROTATED` };
        if (pauses === 2) void supervisor.stop();
      }),
    });

    const running = supervisor.run();
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());
    expect(createLifecycle).toHaveBeenCalledOnce();
    releaseStop.resolve();
    await vi.waitFor(() => expect(createLifecycle).toHaveBeenCalledTimes(2));
    await supervisor.stop();
    await running;
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("uses bounded pause and safe diagnostics after readiness failure", async () => {
    const secret = "BOT_TOKEN DATABASE_URL raw Error chatId payload";
    const logged: TelegramDeliverySupervisorDiagnosticCode[] = [];
    const delays: number[] = [];
    const supervisor = new TelegramDeliverySupervisor({
      configuration: () => enabled,
      createApi: () => {
        throw new Error(secret);
      },
      verifyReadiness: vi.fn(),
      createLifecycle: vi.fn(),
      logger: { log: (code) => logged.push(code) },
      readinessRecheckMs: 17,
      sleep: vi.fn(async (milliseconds) => {
        delays.push(milliseconds);
        void supervisor.stop();
      }),
    });

    await supervisor.run();
    expect(delays).toEqual([17]);
    expect(logged).toEqual(["TELEGRAM_DELIVERY_READINESS_FAILED"]);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
