import { TELEGRAM_CLEANUP_MAX_BATCH_SIZE, type TelegramCleanupResult } from "./cleanup-repository";

export const TELEGRAM_CLEANUP_DEFAULT_INTERVAL_MS = 15 * 60_000;
export const TELEGRAM_CLEANUP_DEFAULT_BATCH_SIZE = 100;

export type TelegramCleanupDiagnosticCode = "TELEGRAM_CLEANUP_FAILED";

type CleanupRunner = {
  run(input: { batchSize: number }): Promise<TelegramCleanupResult>;
};

type CleanupSupervisorOptions = {
  intervalMs?: number;
  batchSize?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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

export class TelegramCleanupSupervisor {
  private readonly shutdown = new AbortController();
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private runPromise: Promise<void> | undefined;

  constructor(
    private readonly dependencies: {
      cleanup: CleanupRunner;
      logger: { log(code: TelegramCleanupDiagnosticCode): void };
    },
    options: CleanupSupervisorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? TELEGRAM_CLEANUP_DEFAULT_INTERVAL_MS;
    this.batchSize = options.batchSize ?? TELEGRAM_CLEANUP_DEFAULT_BATCH_SIZE;
    this.sleep = options.sleep ?? defaultSleep;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new Error("TELEGRAM_CLEANUP_CONFIGURATION_INVALID");
    }
    if (
      !Number.isSafeInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > TELEGRAM_CLEANUP_MAX_BATCH_SIZE
    ) {
      throw new Error("TELEGRAM_CLEANUP_CONFIGURATION_INVALID");
    }
  }

  run(): Promise<void> {
    this.runPromise ??= this.runLoop();
    return this.runPromise;
  }

  async stop(): Promise<void> {
    if (!this.shutdown.signal.aborted) this.shutdown.abort();
    await (this.runPromise ?? Promise.resolve()).catch(() => undefined);
  }

  private logFailure(): void {
    try {
      this.dependencies.logger.log("TELEGRAM_CLEANUP_FAILED");
    } catch {
      // Diagnostics never affect worker lifecycle.
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      try {
        await this.dependencies.cleanup.run({ batchSize: this.batchSize });
      } catch {
        this.logFailure();
      }
      if (this.shutdown.signal.aborted) break;
      try {
        await this.sleep(this.intervalMs, this.shutdown.signal);
      } catch {
        if (!this.shutdown.signal.aborted) this.logFailure();
      }
    }
  }
}
