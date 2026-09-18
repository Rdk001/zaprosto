import { z } from "zod";

import { TELEGRAM_POLICY } from "../domain/policy";
import type { TelegramOutboxDispatcher } from "./outbox-dispatcher";
import type { TelegramOutboxRepository } from "./outbox-repository";

const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

const configurationSchema = z.strictObject({
  dispatchIntervalMs: z.number().int().min(1).max(MAX_INTERVAL_MS),
  recoveryIntervalMs: z.number().int().min(1).max(MAX_INTERVAL_MS),
  recoveryBatchSize: z.number().int().min(1).max(TELEGRAM_POLICY.claimBatchSize),
  errorBackoffMs: z.number().int().min(1).max(MAX_INTERVAL_MS),
});

type DeliveryDispatcher = Pick<TelegramOutboxDispatcher, "dispatchOnce">;
type DeliveryOutbox = Pick<TelegramOutboxRepository, "recoverExpired">;

export const TELEGRAM_DELIVERY_ORCHESTRATOR_DEFAULTS = {
  dispatchIntervalMs: 1_000,
  recoveryIntervalMs: 60_000,
  recoveryBatchSize: TELEGRAM_POLICY.claimBatchSize,
  errorBackoffMs: 1_000,
} as const;

export type TelegramDeliveryDiagnosticCode =
  "TELEGRAM_DELIVERY_DISPATCH_FAILED" | "TELEGRAM_DELIVERY_RECOVERY_FAILED";

export interface TelegramDeliveryLogger {
  log(code: TelegramDeliveryDiagnosticCode): void;
}

export type TelegramDeliveryOrchestratorConfiguration = Readonly<{
  dispatchIntervalMs: number;
  recoveryIntervalMs: number;
  recoveryBatchSize: number;
  errorBackoffMs: number;
}>;

export type TelegramDeliveryOrchestratorErrorCode = "DELIVERY_LIFECYCLE_CONFIGURATION_INVALID";

export class TelegramDeliveryOrchestratorError extends Error {
  constructor(readonly code: TelegramDeliveryOrchestratorErrorCode) {
    super(code);
    this.name = "TelegramDeliveryOrchestratorError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export type TelegramDeliveryOrchestratorDependencies = {
  dispatcher: DeliveryDispatcher;
  outbox: DeliveryOutbox;
  logger: TelegramDeliveryLogger;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  monotonicNow?: () => number;
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

function nextCadence(previous: number, now: number, interval: number): number {
  const elapsed = Math.max(0, now - previous);
  return previous + (Math.floor(elapsed / interval) + 1) * interval;
}

export class TelegramDeliveryOrchestrator {
  private readonly shutdown = new AbortController();
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly monotonicNow: () => number;
  private readonly configuration: TelegramDeliveryOrchestratorConfiguration;
  private runPromise: Promise<void> | undefined;

  constructor(
    private readonly dependencies: TelegramDeliveryOrchestratorDependencies,
    configuration: TelegramDeliveryOrchestratorConfiguration = TELEGRAM_DELIVERY_ORCHESTRATOR_DEFAULTS,
  ) {
    const parsed = configurationSchema.safeParse(configuration);
    if (!parsed.success) {
      throw new TelegramDeliveryOrchestratorError("DELIVERY_LIFECYCLE_CONFIGURATION_INVALID");
    }
    this.configuration = parsed.data;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }

  run(): Promise<void> {
    this.runPromise ??= this.runLoop();
    return this.runPromise;
  }

  stop(): Promise<void> {
    if (!this.shutdown.signal.aborted) this.shutdown.abort();
    return this.runPromise ?? Promise.resolve();
  }

  private now(): number {
    try {
      const value = this.monotonicNow();
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      // A broken optional clock falls back to the process monotonic clock.
    }
    return performance.now();
  }

  private log(code: TelegramDeliveryDiagnosticCode): void {
    try {
      this.dependencies.logger.log(code);
    } catch {
      // Logging is best-effort and never changes delivery control flow.
    }
  }

  private async pause(milliseconds: number): Promise<boolean> {
    try {
      await this.sleep(milliseconds, this.shutdown.signal);
      return !this.shutdown.signal.aborted;
    } catch {
      // Abort and a broken injected sleeper both end the loop without a retry spin.
      return false;
    }
  }

  private async runLoop(): Promise<void> {
    let nextRecoveryAt = this.now();

    while (!this.shutdown.signal.aborted) {
      const beforeWork = this.now();
      if (beforeWork >= nextRecoveryAt) {
        try {
          await this.dependencies.outbox.recoverExpired({
            batchSize: this.configuration.recoveryBatchSize,
          });
        } catch {
          this.log("TELEGRAM_DELIVERY_RECOVERY_FAILED");
          nextRecoveryAt = nextCadence(
            nextRecoveryAt,
            this.now(),
            this.configuration.recoveryIntervalMs,
          );
          if (!(await this.pause(this.configuration.errorBackoffMs))) return;
          continue;
        }
        nextRecoveryAt = nextCadence(
          nextRecoveryAt,
          this.now(),
          this.configuration.recoveryIntervalMs,
        );
      }

      if (this.shutdown.signal.aborted) return;
      try {
        await this.dependencies.dispatcher.dispatchOnce({ signal: this.shutdown.signal });
      } catch {
        if (this.shutdown.signal.aborted) return;
        this.log("TELEGRAM_DELIVERY_DISPATCH_FAILED");
        if (!(await this.pause(this.configuration.errorBackoffMs))) return;
        continue;
      }

      if (this.shutdown.signal.aborted) return;
      if (!(await this.pause(this.configuration.dispatchIntervalMs))) return;
    }
  }
}
