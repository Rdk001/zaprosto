import type { TelegramBotApi } from "./bot-api";
import type {
  TelegramDeliveryVerificationReason,
  TelegramDeliveryVerificationResult,
} from "./delivery-readiness-service";
import type { TelegramRuntimeConfiguration } from "./runtime-config";

export const TELEGRAM_DELIVERY_READINESS_RECHECK_MS = 60_000;

type EnabledConfiguration = Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }>;

export type TelegramDeliverySupervisorDiagnosticCode =
  | TelegramDeliveryVerificationReason
  | "TELEGRAM_DELIVERY_READINESS_FAILED"
  | "TELEGRAM_DELIVERY_LIFECYCLE_EXITED";

export interface TelegramDeliveryLifecycle {
  run(): Promise<void>;
  stop(): Promise<void>;
}

export type TelegramDeliverySupervisorDependencies = {
  configuration: () => TelegramRuntimeConfiguration;
  createApi: (configuration: EnabledConfiguration) => TelegramBotApi;
  verifyReadiness: (input: {
    configuration: TelegramRuntimeConfiguration;
    api?: TelegramBotApi;
    signal: AbortSignal;
  }) => Promise<TelegramDeliveryVerificationResult>;
  createLifecycle: (input: {
    configuration: EnabledConfiguration;
    api: TelegramBotApi;
  }) => TelegramDeliveryLifecycle;
  logger: { log(code: TelegramDeliverySupervisorDiagnosticCode): void };
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readinessRecheckMs?: number;
};

export class TelegramDeliverySupervisorError extends Error {
  constructor(readonly code: "TELEGRAM_DELIVERY_LIFECYCLE_EXITED") {
    super(code);
    this.name = "TelegramDeliverySupervisorError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

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

type ActiveSession = {
  botToken: string;
  lifecycle: TelegramDeliveryLifecycle;
  running: Promise<void>;
};

export class TelegramDeliverySupervisor {
  private readonly shutdown = new AbortController();
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly readinessRecheckMs: number;
  private runPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private active: ActiveSession | undefined;

  constructor(private readonly dependencies: TelegramDeliverySupervisorDependencies) {
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.readinessRecheckMs =
      dependencies.readinessRecheckMs ?? TELEGRAM_DELIVERY_READINESS_RECHECK_MS;
    if (!Number.isSafeInteger(this.readinessRecheckMs) || this.readinessRecheckMs < 1) {
      throw new Error("TELEGRAM_DELIVERY_SUPERVISOR_CONFIGURATION_INVALID");
    }
  }

  run(): Promise<void> {
    this.runPromise ??= this.runLoop();
    return this.runPromise;
  }

  stop(): Promise<void> {
    if (!this.shutdown.signal.aborted) this.shutdown.abort();
    this.stopPromise ??= (async () => {
      await this.stopActive();
      await (this.runPromise ?? Promise.resolve()).catch(() => undefined);
    })();
    return this.stopPromise;
  }

  private log(code: TelegramDeliverySupervisorDiagnosticCode): void {
    try {
      this.dependencies.logger.log(code);
    } catch {
      // Diagnostics never change lifecycle control flow.
    }
  }

  private async stopActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    await active.lifecycle.stop().catch(() => undefined);
    await active.running.catch(() => undefined);
  }

  private async pauseOrLifecycleExit(): Promise<"PAUSED" | "EXITED" | "STOPPED"> {
    if (this.shutdown.signal.aborted) return "STOPPED";
    const active = this.active;
    const pause = this.sleep(this.readinessRecheckMs, this.shutdown.signal).then(
      () => "PAUSED" as const,
      () => "STOPPED" as const,
    );
    if (!active) return pause;
    return Promise.race([
      pause,
      active.running.then(
        () => "EXITED" as const,
        () => "EXITED" as const,
      ),
    ]);
  }

  private async verify(configuration: TelegramRuntimeConfiguration) {
    let api: TelegramBotApi | undefined;
    try {
      if (configuration.kind === "ENABLED") api = this.dependencies.createApi(configuration);
      const result = await this.dependencies.verifyReadiness({
        configuration,
        ...(api === undefined ? {} : { api }),
        signal: this.shutdown.signal,
      });
      return { result, api };
    } catch {
      return { result: undefined, api };
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      const configuration = this.dependencies.configuration();
      const { result, api } = await this.verify(configuration);
      if (this.shutdown.signal.aborted) break;

      if (!result) {
        this.log("TELEGRAM_DELIVERY_READINESS_FAILED");
        await this.stopActive();
      } else if (result.status !== "VERIFIED") {
        if (result.status === "NOT_READY") this.log(result.reasonCode);
        await this.stopActive();
      } else if (configuration.kind === "ENABLED" && api) {
        if (this.active?.botToken !== configuration.botToken) {
          await this.stopActive();
          if (this.shutdown.signal.aborted) break;
          const lifecycle = this.dependencies.createLifecycle({ configuration, api });
          const running = Promise.resolve().then(() => lifecycle.run());
          this.active = { botToken: configuration.botToken, lifecycle, running };
        }
      } else {
        this.log("TELEGRAM_DELIVERY_READINESS_FAILED");
        await this.stopActive();
      }

      const waitResult = await this.pauseOrLifecycleExit();
      if (waitResult === "STOPPED") break;
      if (waitResult === "EXITED") {
        this.log("TELEGRAM_DELIVERY_LIFECYCLE_EXITED");
        await this.stopActive();
        throw new TelegramDeliverySupervisorError("TELEGRAM_DELIVERY_LIFECYCLE_EXITED");
      }
    }
    await this.stopActive();
  }
}
