import pg, { type Pool } from "pg";

import type { PrismaClient } from "../../../generated/prisma/client";
import { createPrismaClient } from "../../../server/db/create-prisma-client";
import { createTelegramBotApi, type TelegramBotApi } from "./bot-api";
import { TelegramBotStateRepository } from "./bot-state-repository";
import { TelegramCleanupRepository } from "./cleanup-repository";
import {
  TelegramCleanupSupervisor,
  type TelegramCleanupDiagnosticCode,
} from "./cleanup-supervisor";
import { TelegramDeliveryAttempt } from "./delivery-attempt";
import { TelegramDeliveryOrchestrator } from "./delivery-orchestrator";
import { TelegramDeliveryPreflight } from "./delivery-preflight";
import { TelegramDeliveryRateGate } from "./delivery-rate-gate";
import { verifyTelegramDeliveryReadiness } from "./delivery-readiness-service";
import {
  TelegramDeliverySupervisor,
  type TelegramDeliverySupervisorDiagnosticCode,
} from "./delivery-supervisor";
import { createTelegramFetchTransport } from "./fetch-transport";
import { TelegramOutboxDispatcher } from "./outbox-dispatcher";
import { TelegramOutboxRepository } from "./outbox-repository";
import {
  PostgresTelegramMaintenanceLockSource,
  type TelegramMaintenanceLockSession,
  type TelegramMaintenanceLockSource,
} from "./maintenance-lock";
import { PostgresTelegramPollingLeaderSource } from "./polling-leader";
import {
  TelegramPollingOrchestrator,
  type TelegramPollingDiagnosticCode,
} from "./polling-orchestrator";
import { PrismaTelegramPollingStore } from "./polling-store";
import { verifyTelegramBotReadiness } from "./readiness-service";
import { parseTelegramRuntimeConfiguration, type TelegramEnvironment } from "./runtime-config";
import { registerTelegramWorkerPoolErrorHandler } from "./worker-pool";

export const TELEGRAM_WORKER_DELIVERY_CONCURRENCY = 4;
export const TELEGRAM_WORKER_POOL_MAX = TELEGRAM_WORKER_DELIVERY_CONCURRENCY + 2;

export type TelegramWorkerDiagnosticCode =
  | TelegramPollingDiagnosticCode
  | TelegramDeliverySupervisorDiagnosticCode
  | TelegramCleanupDiagnosticCode
  | "TELEGRAM_DELIVERY_DISPATCH_FAILED"
  | "TELEGRAM_DELIVERY_RECOVERY_FAILED"
  | "WORKER_STARTED"
  | "WORKER_STOPPED"
  | "WORKER_FATAL";

export interface TelegramWorkerLogger {
  log(code: TelegramWorkerDiagnosticCode): void;
}

export interface TelegramWorkerRootLoop {
  run(): Promise<void>;
  stop(): Promise<void>;
}

type WorkerDatabase = Pick<PrismaClient, "$disconnect">;
type WorkerPool = Pick<Pool, "end">;

export class TelegramWorkerRuntimeError extends Error {
  constructor(
    readonly code:
      | "WORKER_ROOT_LOOP_EXITED"
      | "WORKER_MAINTENANCE_GUARD_FAILED"
      | "WORKER_MAINTENANCE_GUARD_LOST",
  ) {
    super(code);
    this.name = "TelegramWorkerRuntimeError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export class TelegramWorkerRuntime {
  private runPromise: Promise<void> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private maintenanceAcquirePromise: Promise<TelegramMaintenanceLockSession> | undefined;
  private maintenanceSession: TelegramMaintenanceLockSession | undefined;
  private stopping = false;

  constructor(
    private readonly dependencies: {
      polling: TelegramWorkerRootLoop;
      delivery: TelegramWorkerRootLoop;
      dataCleanup: TelegramWorkerRootLoop;
      maintenance: Pick<TelegramMaintenanceLockSource, "acquireWorker">;
      pool: WorkerPool;
      database: WorkerDatabase;
      unregisterPoolErrorHandler: () => void;
    },
  ) {}

  run(): Promise<void> {
    this.runPromise ??= this.runRootLoops();
    return this.runPromise;
  }

  stop(): Promise<void> {
    this.stopping = true;
    return this.cleanup();
  }

  private cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      await Promise.allSettled([
        this.dependencies.polling.stop(),
        this.dependencies.delivery.stop(),
        this.dependencies.dataCleanup.stop(),
      ]);
      if (this.maintenanceAcquirePromise) {
        const acquired = await this.maintenanceAcquirePromise.catch(() => undefined);
        this.maintenanceSession ??= acquired;
      }
      await Promise.allSettled([this.maintenanceSession?.release()]);
      await Promise.allSettled([
        this.dependencies.pool.end(),
        this.dependencies.database.$disconnect(),
      ]);
      try {
        this.dependencies.unregisterPoolErrorHandler();
      } catch {
        // Listener cleanup is best-effort after both database resources settled.
      }
    })();
    return this.cleanupPromise;
  }

  private async runRootLoops(): Promise<void> {
    if (this.stopping) {
      await this.cleanup();
      return;
    }

    this.maintenanceAcquirePromise = this.dependencies.maintenance.acquireWorker();
    try {
      this.maintenanceSession = await this.maintenanceAcquirePromise;
    } catch {
      await this.cleanup();
      if (this.stopping) return;
      throw new TelegramWorkerRuntimeError("WORKER_MAINTENANCE_GUARD_FAILED");
    }
    if (this.stopping) {
      await this.cleanup();
      return;
    }

    const polling = Promise.resolve().then(() => this.dependencies.polling.run());
    const delivery = Promise.resolve().then(() => this.dependencies.delivery.run());
    const dataCleanup = Promise.resolve().then(() => this.dependencies.dataCleanup.run());
    const guardLost = new Promise<"GUARD_LOST">((resolve) => {
      const signal = this.maintenanceSession?.signal;
      if (signal?.aborted) resolve("GUARD_LOST");
      else signal?.addEventListener("abort", () => resolve("GUARD_LOST"), { once: true });
    });
    const first = await Promise.race([
      polling.then(
        () => "ROOT_EXIT" as const,
        () => "ROOT_EXIT" as const,
      ),
      delivery.then(
        () => "ROOT_EXIT" as const,
        () => "ROOT_EXIT" as const,
      ),
      dataCleanup.then(
        () => "ROOT_EXIT" as const,
        () => "ROOT_EXIT" as const,
      ),
      guardLost,
    ]);

    if (this.stopping) {
      await this.cleanup();
      return;
    }

    await this.cleanup();
    throw new TelegramWorkerRuntimeError(
      first === "GUARD_LOST" ? "WORKER_MAINTENANCE_GUARD_LOST" : "WORKER_ROOT_LOOP_EXITED",
    );
  }
}

export type TelegramWorkerRuntimeFactoryInput = Readonly<{
  databaseUrl: string;
  environment: TelegramEnvironment;
  logger: TelegramWorkerLogger;
}>;

const inactiveApi: TelegramBotApi = new Proxy({} as TelegramBotApi, {
  get() {
    return async () => {
      throw new Error("INACTIVE_TELEGRAM_API_CALLED");
    };
  },
});

export function createTelegramWorkerRuntime(
  input: TelegramWorkerRuntimeFactoryInput,
): TelegramWorkerRuntime {
  const database = createPrismaClient(input.databaseUrl);
  const pool = new pg.Pool({
    connectionString: input.databaseUrl,
    max: TELEGRAM_WORKER_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  const unregisterPoolErrorHandler = registerTelegramWorkerPoolErrorHandler(pool, input.logger);
  const maintenance = new PostgresTelegramMaintenanceLockSource(pool);
  const state = new TelegramBotStateRepository(database);
  const configuration = () => parseTelegramRuntimeConfiguration(input.environment);
  const createApi = (
    enabled: Extract<ReturnType<typeof configuration>, { kind: "ENABLED" }>,
  ): TelegramBotApi =>
    createTelegramBotApi(createTelegramFetchTransport({ botToken: enabled.botToken }));

  const polling = new TelegramPollingOrchestrator({
    configuration,
    createApi,
    leader: new PostgresTelegramPollingLeaderSource(pool),
    store: new PrismaTelegramPollingStore(database),
    verifyReadiness: ({ configuration: current, api, signal }) =>
      verifyTelegramBotReadiness({
        configuration: current,
        api: api ?? inactiveApi,
        state,
        signal,
      }),
    logger: input.logger,
  });

  const outbox = new TelegramOutboxRepository(database);
  const preflight = new TelegramDeliveryPreflight(database);
  const rateGate = new TelegramDeliveryRateGate(pool);
  const delivery = new TelegramDeliverySupervisor({
    configuration,
    createApi,
    verifyReadiness: ({ configuration: current, api, signal }) =>
      verifyTelegramDeliveryReadiness({ configuration: current, api, state, signal }),
    createLifecycle: ({ api }) => {
      const attempt = new TelegramDeliveryAttempt({ preflight, rateGate, api, outbox });
      const dispatcher = new TelegramOutboxDispatcher(
        { outbox, attempt },
        { concurrency: TELEGRAM_WORKER_DELIVERY_CONCURRENCY },
      );
      return new TelegramDeliveryOrchestrator({ dispatcher, outbox, logger: input.logger });
    },
    logger: input.logger,
  });
  const dataCleanup = new TelegramCleanupSupervisor({
    cleanup: new TelegramCleanupRepository(database),
    logger: input.logger,
  });

  return new TelegramWorkerRuntime({
    polling,
    delivery,
    dataCleanup,
    maintenance,
    pool,
    database,
    unregisterPoolErrorHandler,
  });
}

type WorkerProcess = {
  exitCode?: string | number | null;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export async function runTelegramWorkerProcess(input: {
  runtime: TelegramWorkerRuntime;
  process: WorkerProcess;
  logger: TelegramWorkerLogger;
}): Promise<void> {
  const shutdown = () => void input.runtime.stop();
  input.process.once("SIGINT", shutdown);
  input.process.once("SIGTERM", shutdown);
  input.logger.log("WORKER_STARTED");
  try {
    await input.runtime.run();
  } catch {
    input.logger.log("WORKER_FATAL");
    input.process.exitCode = 1;
  } finally {
    await input.runtime.stop();
    input.process.off("SIGINT", shutdown);
    input.process.off("SIGTERM", shutdown);
    input.logger.log("WORKER_STOPPED");
  }
}
