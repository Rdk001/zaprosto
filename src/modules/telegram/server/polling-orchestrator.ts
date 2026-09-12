import { isTelegramAdapterErrorCode, type TelegramSafeErrorCode } from "../domain/safe-error";
import { TelegramBotApiError, type TelegramBotApi, type TelegramUpdate } from "./bot-api";
import type { TelegramPollingLeaderSession, TelegramPollingLeaderSource } from "./polling-leader";
import type { TelegramPollingStore } from "./polling-store";
import type { TelegramVerificationReason, TelegramVerificationResult } from "./readiness-service";
import type { TelegramRuntimeConfiguration } from "./runtime-config";

export const TELEGRAM_LEADER_RETRY_MS = 1_000;
export const TELEGRAM_READINESS_RECHECK_MS = 60_000;

export type TelegramPollingDiagnosticCode =
  | TelegramSafeErrorCode
  | TelegramVerificationReason
  | "LEADER_SESSION_FAILURE"
  | "POLL_STORAGE_FAILURE";

export type TelegramBatchResult =
  | Readonly<{ kind: "COMPLETED"; nextExpectedOffset: bigint }>
  | Readonly<{ kind: "LEADERSHIP_LOST" }>
  | Readonly<{ kind: "OFFSET_CONFLICT" }>;

export interface TelegramPollingLogger {
  log(code: TelegramPollingDiagnosticCode): void;
}

type EnabledConfiguration = Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }>;

type OrchestratorDependencies = {
  configuration: () => TelegramRuntimeConfiguration;
  createApi: (configuration: EnabledConfiguration) => TelegramBotApi;
  leader: TelegramPollingLeaderSource;
  store: TelegramPollingStore;
  verifyReadiness: (input: {
    configuration: TelegramRuntimeConfiguration;
    api?: TelegramBotApi;
    signal: AbortSignal;
  }) => Promise<TelegramVerificationResult>;
  logger: TelegramPollingLogger;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  monotonicNow?: () => number;
  rng?: () => number;
  leaderRetryMs?: number;
  readinessRecheckMs?: number;
};

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizedPollingCode(error: unknown): TelegramSafeErrorCode {
  if (error instanceof TelegramBotApiError && isTelegramAdapterErrorCode(error.code)) {
    return error.code;
  }
  return "NETWORK_UNREACHABLE";
}

export function calculateTelegramPollingBackoffMs(
  failedPolls: number,
  randomValue: number,
): number {
  const baseDelay =
    Number.isSafeInteger(failedPolls) && failedPolls >= 0
      ? Math.min(30_000, 1_000 * 2 ** Math.min(failedPolls, 5))
      : 30_000;
  const normalizedRandomValue = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0;
  const lowerBound = Math.max(1_000, Math.floor(baseDelay * 0.75));
  return lowerBound + Math.floor((baseDelay - lowerBound) * normalizedRandomValue);
}

export async function processTelegramUpdateBatch(input: {
  updates: readonly TelegramUpdate[];
  requestedOffset: bigint;
  botUsername: string;
  leader: TelegramPollingLeaderSession;
  store: TelegramPollingStore;
}): Promise<TelegramBatchResult> {
  let expectedStoredOffset = input.requestedOffset;
  const updates = [...input.updates].sort((left, right) =>
    left.updateId < right.updateId ? -1 : left.updateId > right.updateId ? 1 : 0,
  );

  if (updates.length === 0) {
    const result = await input.store.recordEmptyPoll(expectedStoredOffset);
    return result.kind === "OFFSET_CONFLICT"
      ? { kind: "OFFSET_CONFLICT" }
      : { kind: "COMPLETED", nextExpectedOffset: result.nextExpectedOffset };
  }

  for (const update of updates) {
    if (!(await input.leader.confirmLeadership())) return { kind: "LEADERSHIP_LOST" };
    const result = await input.store.processUpdate({
      update,
      expectedOffset: expectedStoredOffset,
      botUsername: input.botUsername,
    });
    if (result.kind === "OFFSET_CONFLICT") return { kind: "OFFSET_CONFLICT" };
    expectedStoredOffset = result.nextExpectedOffset;
  }

  return { kind: "COMPLETED", nextExpectedOffset: expectedStoredOffset };
}

export class TelegramPollingOrchestrator {
  private readonly shutdown = new AbortController();
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly monotonicNow: () => number;
  private readonly rng: () => number;
  private readonly leaderRetryMs: number;
  private readonly readinessRecheckMs: number;
  private runPromise: Promise<void> | undefined;

  constructor(private readonly dependencies: OrchestratorDependencies) {
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.rng = dependencies.rng ?? Math.random;
    this.leaderRetryMs = dependencies.leaderRetryMs ?? TELEGRAM_LEADER_RETRY_MS;
    this.readinessRecheckMs = dependencies.readinessRecheckMs ?? TELEGRAM_READINESS_RECHECK_MS;
  }

  run(): Promise<void> {
    this.runPromise ??= this.runLoop();
    return this.runPromise;
  }

  stop(): Promise<void> {
    if (!this.shutdown.signal.aborted) this.shutdown.abort();
    return this.runPromise ?? Promise.resolve();
  }

  private async pause(milliseconds: number, signal = this.shutdown.signal): Promise<boolean> {
    try {
      await this.sleep(milliseconds, signal);
      return !signal.aborted;
    } catch {
      return false;
    }
  }

  private pollingBackoff(failedPolls: number): number {
    let randomValue = 0;
    try {
      randomValue = this.rng();
    } catch {
      // A broken optional RNG degrades to the predictable bounded lower delay.
    }
    return calculateTelegramPollingBackoffMs(failedPolls, randomValue);
  }

  private async runLoop(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      const configuration = this.dependencies.configuration();
      if (configuration.kind !== "ENABLED") {
        const result = await this.dependencies.verifyReadiness({
          configuration,
          signal: this.shutdown.signal,
        });
        if (result.status === "NOT_READY") this.dependencies.logger.log(result.reasonCode);
        if (!(await this.pause(this.readinessRecheckMs))) return;
        continue;
      }

      let leader: TelegramPollingLeaderSession | null;
      try {
        leader = await this.dependencies.leader.tryAcquire();
      } catch {
        this.dependencies.logger.log("LEADER_SESSION_FAILURE");
        if (!(await this.pause(this.leaderRetryMs))) return;
        continue;
      }
      if (leader === null) {
        if (!(await this.pause(this.leaderRetryMs))) return;
        continue;
      }

      try {
        await this.runAsLeader(configuration, leader);
      } finally {
        try {
          await leader.close();
        } catch {
          this.dependencies.logger.log("LEADER_SESSION_FAILURE");
        }
      }
      if (!this.shutdown.signal.aborted && !(await this.pause(this.leaderRetryMs))) return;
    }
  }

  private async runAsLeader(
    configuration: EnabledConfiguration,
    leader: TelegramPollingLeaderSession,
  ): Promise<void> {
    const signal = AbortSignal.any([this.shutdown.signal, leader.signal]);
    const api = this.dependencies.createApi(configuration);
    let nextReadinessCheck = 0;
    let failedPolls = 0;

    while (!signal.aborted) {
      if (this.monotonicNow() >= nextReadinessCheck) {
        const readiness = await this.dependencies.verifyReadiness({
          configuration,
          api,
          signal,
        });
        if (readiness.status !== "VERIFIED") {
          if (readiness.status === "NOT_READY") this.dependencies.logger.log(readiness.reasonCode);
          await this.pause(this.readinessRecheckMs, signal);
          return;
        }
        nextReadinessCheck = this.monotonicNow() + this.readinessRecheckMs;
      }

      if (!(await leader.confirmLeadership())) return;
      let requestedOffset: bigint;
      try {
        requestedOffset = await this.dependencies.store.getOffset();
      } catch {
        this.dependencies.logger.log("POLL_STORAGE_FAILURE");
        if (!(await this.pause(this.pollingBackoff(failedPolls++), signal))) return;
        continue;
      }

      let updates: readonly TelegramUpdate[];
      try {
        updates = await api.getUpdates(
          {
            offset: requestedOffset,
            limit: 100,
            timeoutSeconds: configuration.pollTimeoutSeconds,
            allowedUpdates: ["message"],
          },
          { signal },
        );
      } catch (error) {
        if (signal.aborted) return;
        const code = normalizedPollingCode(error);
        try {
          await this.dependencies.store.setError(code);
        } catch {
          this.dependencies.logger.log("POLL_STORAGE_FAILURE");
        }
        this.dependencies.logger.log(code);

        if (code === "POLLING_CONFLICT") {
          const readiness = await this.dependencies.verifyReadiness({
            configuration,
            api,
            signal,
          });
          if (readiness.status === "VERIFIED") {
            try {
              await this.dependencies.store.setError("POLLING_CONFLICT");
            } catch {
              this.dependencies.logger.log("POLL_STORAGE_FAILURE");
            }
          } else if (readiness.status === "NOT_READY") {
            this.dependencies.logger.log(readiness.reasonCode);
          }
          nextReadinessCheck = this.monotonicNow() + this.readinessRecheckMs;
        }

        if (!(await this.pause(this.pollingBackoff(failedPolls++), signal))) return;
        continue;
      }

      failedPolls = 0;
      if (!(await leader.confirmLeadership())) return;

      let result: TelegramBatchResult;
      try {
        result = await processTelegramUpdateBatch({
          updates,
          requestedOffset,
          botUsername: configuration.botUsername,
          leader,
          store: this.dependencies.store,
        });
      } catch {
        this.dependencies.logger.log("POLL_STORAGE_FAILURE");
        return;
      }
      if (result.kind === "OFFSET_CONFLICT") {
        this.dependencies.logger.log("POLL_OFFSET_CONFLICT");
        return;
      }
      if (result.kind === "LEADERSHIP_LOST") return;
    }
  }
}
