import { describe, expect, it, vi } from "vitest";

import type { TelegramSafeErrorCode } from "../domain/safe-error";
import { TelegramBotApiError, type TelegramBotApi, type TelegramUpdate } from "./bot-api";
import type { TelegramPollingLeaderSession, TelegramPollingLeaderSource } from "./polling-leader";
import {
  calculateTelegramPollingBackoffMs,
  processTelegramUpdateBatch,
  TelegramPollingOrchestrator,
  type TelegramPollingDiagnosticCode,
} from "./polling-orchestrator";
import type { TelegramPollCommitResult, TelegramPollingStore } from "./polling-store";
import type { TelegramVerificationResult } from "./readiness-service";
import type { TelegramRuntimeConfiguration } from "./runtime-config";

const enabled = {
  kind: "ENABLED",
  botToken: "123456:SAFE_TEST_TOKEN_1234567890",
  botUsername: "Zaprosto_Test_Bot",
  pollTimeoutSeconds: 30,
} as const satisfies TelegramRuntimeConfiguration;

function update(updateId: bigint, text?: string): TelegramUpdate {
  return {
    updateId,
    ...(text === undefined
      ? {}
      : {
          message: {
            messageId: updateId,
            from: { id: 123n, isBot: false },
            dateUnixSeconds: 1,
            chat: { id: 123n, type: "private" as const },
            text,
          },
        }),
  };
}

class FakeLeader implements TelegramPollingLeaderSession {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly confirmLeadership = vi.fn(async () => !this.signal.aborted);
  readonly close = vi.fn(async () => this.controller.abort());

  lose() {
    this.controller.abort();
  }
}

class MemoryStore implements TelegramPollingStore {
  offset = 0n;
  readonly processed: bigint[] = [];
  readonly errors: TelegramSafeErrorCode[] = [];
  readonly recordEmptyPoll = vi.fn(
    async (expectedOffset: bigint): Promise<TelegramPollCommitResult> => {
      if (expectedOffset !== this.offset) return { kind: "OFFSET_CONFLICT" };
      return { kind: "COMMITTED", nextExpectedOffset: this.offset };
    },
  );

  async getOffset() {
    return this.offset;
  }

  async setError(code: TelegramSafeErrorCode) {
    this.errors.push(code);
  }

  async processUpdate(input: {
    update: TelegramUpdate;
    expectedOffset: bigint;
    botUsername: string;
  }): Promise<TelegramPollCommitResult> {
    if (input.expectedOffset !== this.offset) return { kind: "OFFSET_CONFLICT" };
    this.processed.push(input.update.updateId);
    if (input.update.updateId >= this.offset) this.offset = input.update.updateId + 1n;
    return { kind: "COMMITTED", nextExpectedOffset: this.offset };
  }
}

function api(getUpdates: TelegramBotApi["getUpdates"]): TelegramBotApi {
  return {
    getMe: vi.fn(async () => ({ id: 1n, username: enabled.botUsername })),
    getWebhookInfo: vi.fn(async () => ({
      hasWebhook: false,
      hasCustomCertificate: false,
      pendingUpdateCount: 0,
    })),
    deleteWebhook: vi.fn(async () => undefined),
    getUpdates,
    sendMessage: vi.fn(async () => ({ messageId: 1n })),
  };
}

function verified(): TelegramVerificationResult {
  return { status: "VERIFIED", verified: true, botUsername: enabled.botUsername };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Telegram polling batch protocol", () => {
  it("sorts updates, permits gaps, and turns duplicates/replays into sequential no-ops", async () => {
    const leader = new FakeLeader();
    const store = new MemoryStore();
    const result = await processTelegramUpdateBatch({
      updates: [update(7n), update(2n), update(7n), update(1n)],
      requestedOffset: 0n,
      botUsername: enabled.botUsername,
      leader,
      store,
    });

    expect(store.processed).toEqual([1n, 2n, 7n, 7n]);
    expect(store.offset).toBe(8n);
    expect(result).toEqual({ kind: "COMPLETED", nextExpectedOffset: 8n });
    expect(leader.confirmLeadership).toHaveBeenCalledTimes(4);
  });

  it("re-checks leadership before every next update and stops without later effects", async () => {
    const leader = new FakeLeader();
    leader.confirmLeadership.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const store = new MemoryStore();

    await expect(
      processTelegramUpdateBatch({
        updates: [update(1n), update(2n), update(3n)],
        requestedOffset: 0n,
        botUsername: enabled.botUsername,
        leader,
        store,
      }),
    ).resolves.toEqual({ kind: "LEADERSHIP_LOST" });
    expect(store.processed).toEqual([1n]);
  });

  it("stops the batch on offset conflict or update failure", async () => {
    const leader = new FakeLeader();
    const conflictStore = new MemoryStore();
    conflictStore.processUpdate = vi.fn(async () => ({ kind: "OFFSET_CONFLICT" as const }));
    await expect(
      processTelegramUpdateBatch({
        updates: [update(1n), update(2n)],
        requestedOffset: 0n,
        botUsername: enabled.botUsername,
        leader,
        store: conflictStore,
      }),
    ).resolves.toEqual({ kind: "OFFSET_CONFLICT" });
    expect(conflictStore.processUpdate).toHaveBeenCalledOnce();

    const failingStore = new MemoryStore();
    failingStore.processUpdate = vi.fn(async () => {
      throw new Error("storage canary");
    });
    await expect(
      processTelegramUpdateBatch({
        updates: [update(1n), update(2n)],
        requestedOffset: 0n,
        botUsername: enabled.botUsername,
        leader: new FakeLeader(),
        store: failingStore,
      }),
    ).rejects.toThrow();
    expect(failingStore.processUpdate).toHaveBeenCalledOnce();
  });

  it("updates an empty poll only through the expected-offset boundary", async () => {
    const store = new MemoryStore();
    store.offset = 9n;
    await expect(
      processTelegramUpdateBatch({
        updates: [],
        requestedOffset: 8n,
        botUsername: enabled.botUsername,
        leader: new FakeLeader(),
        store,
      }),
    ).resolves.toEqual({ kind: "OFFSET_CONFLICT" });
    expect(store.recordEmptyPoll).toHaveBeenCalledWith(8n);
  });
});

describe("Telegram polling read loop", () => {
  it("never creates an API or calls getUpdates when it is not leader", async () => {
    const createApi = vi.fn();
    const orchestrator = new TelegramPollingOrchestrator({
      configuration: () => enabled,
      createApi,
      leader: { tryAcquire: vi.fn(async () => null) },
      store: new MemoryStore(),
      verifyReadiness: vi.fn(async () => verified()),
      logger: { log: vi.fn() },
      sleep: vi.fn(async () => void orchestrator.stop()),
    });

    await orchestrator.run();
    expect(createApi).not.toHaveBeenCalled();
  });

  it("aborts an active long poll when the dedicated leader session is lost", async () => {
    const leader = new FakeLeader();
    const started = deferred<void>();
    const getUpdates = vi.fn(
      async (
        _input: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<readonly TelegramUpdate[]> => {
        started.resolve();
        return new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
    );
    const orchestrator = new TelegramPollingOrchestrator({
      configuration: () => enabled,
      createApi: () => api(getUpdates),
      leader: { tryAcquire: vi.fn(async () => leader) },
      store: new MemoryStore(),
      verifyReadiness: vi.fn(async () => verified()),
      logger: { log: vi.fn() },
    });

    const running = orchestrator.run();
    await started.promise;
    leader.lose();
    await orchestrator.stop();
    await running;
    expect(leader.close).toHaveBeenCalledOnce();
  });

  it("drops a response delivered after leadership loss before any effect", async () => {
    const leader = new FakeLeader();
    const response = deferred<readonly TelegramUpdate[]>();
    const started = deferred<void>();
    const store = new MemoryStore();
    const orchestrator = new TelegramPollingOrchestrator({
      configuration: () => enabled,
      createApi: () =>
        api(async () => {
          started.resolve();
          return response.promise;
        }),
      leader: { tryAcquire: vi.fn(async () => leader) },
      store,
      verifyReadiness: vi.fn(async () => verified()),
      logger: { log: vi.fn() },
    });

    const running = orchestrator.run();
    await started.promise;
    leader.lose();
    response.resolve([update(1n)]);
    await orchestrator.stop();
    await running;
    expect(store.processed).toEqual([]);
    expect(store.recordEmptyPoll).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "DISABLED", pollTimeoutSeconds: 30 } as const,
    { kind: "INCOMPLETE", reasonCode: "BOT_TOKEN_REQUIRED" } as const,
    { kind: "INVALID", reasonCode: "BOT_USERNAME_INVALID" } as const,
  ])("keeps $kind configuration idle without polling", async (configuration) => {
    const getUpdates = vi.fn();
    const acquire = vi.fn();
    const orchestrator = new TelegramPollingOrchestrator({
      configuration: () => configuration,
      createApi: () => api(getUpdates),
      leader: { tryAcquire: acquire } as TelegramPollingLeaderSource,
      store: new MemoryStore(),
      verifyReadiness: vi.fn(async (): Promise<TelegramVerificationResult> =>
        configuration.kind === "DISABLED"
          ? { status: "DISABLED", verified: false }
          : { status: "NOT_READY", verified: false, reasonCode: configuration.reasonCode },
      ),
      logger: { log: vi.fn() },
      sleep: vi.fn(async () => void orchestrator.stop()),
    });
    await orchestrator.run();
    expect(acquire).not.toHaveBeenCalled();
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it("does not poll when readiness reports an active webhook", async () => {
    const leader = new FakeLeader();
    const getUpdates = vi.fn();
    const orchestrator = new TelegramPollingOrchestrator({
      configuration: () => enabled,
      createApi: () => api(getUpdates),
      leader: { tryAcquire: vi.fn(async () => leader) },
      store: new MemoryStore(),
      verifyReadiness: vi.fn(async (): Promise<TelegramVerificationResult> => ({
        status: "NOT_READY",
        verified: false,
        reasonCode: "WEBHOOK_ACTIVE",
      })),
      logger: { log: vi.fn() },
      sleep: vi.fn(async () => void orchestrator.stop()),
    });
    await orchestrator.run();
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it("adds deterministic bounded jitter for minimum, intermediate, and maximum RNG values", () => {
    expect(
      Array.from({ length: 8 }, (_, index) => calculateTelegramPollingBackoffMs(index, 1)),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(calculateTelegramPollingBackoffMs(5, 0)).toBe(22_500);
    expect(calculateTelegramPollingBackoffMs(5, 0.5)).toBe(26_250);
    expect(calculateTelegramPollingBackoffMs(5, 1)).toBe(30_000);
    expect(new Set([0, 0.5, 1].map((rng) => calculateTelegramPollingBackoffMs(5, rng))).size).toBe(
      3,
    );

    for (const failedPolls of [0, 1, 2, 3, 4, 5, 20]) {
      for (const rng of [0, 0.5, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(calculateTelegramPollingBackoffMs(failedPolls, rng)).toBeGreaterThanOrEqual(1_000);
        expect(calculateTelegramPollingBackoffMs(failedPolls, rng)).toBeLessThanOrEqual(30_000);
      }
    }

    expect(calculateTelegramPollingBackoffMs(5, Number.NaN)).toBe(22_500);
    expect(calculateTelegramPollingBackoffMs(5, Number.POSITIVE_INFINITY)).toBe(22_500);
    expect(calculateTelegramPollingBackoffMs(5, Number.NEGATIVE_INFINITY)).toBe(22_500);
    expect(calculateTelegramPollingBackoffMs(5, -1)).toBe(22_500);
    expect(calculateTelegramPollingBackoffMs(5, 2)).toBe(30_000);
  });

  it("resets the failed poll counter after a successful poll", async () => {
    const leader = new FakeLeader();
    const store = new MemoryStore();
    const failure = new TelegramBotApiError({
      code: "NETWORK_UNREACHABLE",
      operation: "getUpdates",
    });
    const getUpdates = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(failure);
    const delays: number[] = [];
    const orchestrator = new TelegramPollingOrchestrator({
      configuration: () => enabled,
      createApi: () => api(getUpdates),
      leader: { tryAcquire: vi.fn(async () => leader) },
      store,
      verifyReadiness: vi.fn(async () => verified()),
      logger: { log: vi.fn() },
      monotonicNow: () => 1,
      rng: () => 0,
      sleep: vi.fn(async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 3) void orchestrator.stop();
      }),
    });
    await orchestrator.run();
    expect(delays).toEqual([1_000, 1_500, 1_000]);
    expect(store.recordEmptyPoll).toHaveBeenCalledOnce();
  });

  it("records POLLING_CONFLICT, re-runs readiness, and backs off", async () => {
    const leader = new FakeLeader();
    const store = new MemoryStore();
    const verifyReadiness = vi.fn(async () => verified());
    const loggerCodes: TelegramPollingDiagnosticCode[] = [];
    const orchestrator = new TelegramPollingOrchestrator({
      configuration: () => enabled,
      createApi: () =>
        api(async () => {
          throw new TelegramBotApiError({ code: "POLLING_CONFLICT", operation: "getUpdates" });
        }),
      leader: { tryAcquire: vi.fn(async () => leader) },
      store,
      verifyReadiness,
      logger: { log: (code) => loggerCodes.push(code) },
      rng: () => 0,
      sleep: vi.fn(async (milliseconds) => {
        expect(milliseconds).toBe(1_000);
        void orchestrator.stop();
      }),
    });
    await orchestrator.run();
    expect(store.errors).toEqual(["POLLING_CONFLICT", "POLLING_CONFLICT"]);
    expect(verifyReadiness).toHaveBeenCalledTimes(2);
    expect(loggerCodes).toEqual(["POLLING_CONFLICT"]);
  });

  it("makes shutdown idempotent and aborts outstanding work without unsafe logs", async () => {
    const secret = "BOT_TOKEN UPDATE_TEXT RAW_START CHAT_ID DATABASE_URL";
    const leader = new FakeLeader();
    const started = deferred<void>();
    const logged: TelegramPollingDiagnosticCode[] = [];
    const orchestrator = new TelegramPollingOrchestrator({
      configuration: () => enabled,
      createApi: () =>
        api(async (_input, options) => {
          started.resolve();
          return new Promise((_, reject) =>
            options?.signal?.addEventListener("abort", () => reject(new Error(secret)), {
              once: true,
            }),
          );
        }),
      leader: { tryAcquire: vi.fn(async () => leader) },
      store: new MemoryStore(),
      verifyReadiness: vi.fn(async () => verified()),
      logger: { log: (code) => logged.push(code) },
    });
    const running = orchestrator.run();
    await started.promise;
    await Promise.all([orchestrator.stop(), orchestrator.stop(), running]);
    expect(leader.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
