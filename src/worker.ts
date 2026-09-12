import pg from "pg";

import { createTelegramBotApi, type TelegramBotApi } from "./modules/telegram/server/bot-api.js";
import { TelegramBotStateRepository } from "./modules/telegram/server/bot-state-repository.js";
import { createTelegramFetchTransport } from "./modules/telegram/server/fetch-transport.js";
import { PostgresTelegramPollingLeaderSource } from "./modules/telegram/server/polling-leader.js";
import {
  TelegramPollingOrchestrator,
  type TelegramPollingDiagnosticCode,
} from "./modules/telegram/server/polling-orchestrator.js";
import { PrismaTelegramPollingStore } from "./modules/telegram/server/polling-store.js";
import { verifyTelegramBotReadiness } from "./modules/telegram/server/readiness-service.js";
import { parseTelegramRuntimeConfiguration } from "./modules/telegram/server/runtime-config.js";
import { registerTelegramWorkerPoolErrorHandler } from "./modules/telegram/server/worker-pool.js";
import { createPrismaClient } from "./server/db/create-prisma-client.js";

const databaseUrl = process.env.DATABASE_URL;

function log(
  code: TelegramPollingDiagnosticCode | "WORKER_STARTED" | "WORKER_STOPPED" | "WORKER_FATAL",
) {
  console.log(`[zaprosto-worker] ${code}`);
}

const inactiveApi = new Proxy({} as TelegramBotApi, {
  get() {
    return async () => {
      throw new Error("INACTIVE_TELEGRAM_API_CALLED");
    };
  },
});

async function main(connectionString: string): Promise<void> {
  const database = createPrismaClient(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  const unregisterPoolErrorHandler = registerTelegramWorkerPoolErrorHandler(pool, { log });
  const state = new TelegramBotStateRepository(database);
  const orchestrator = new TelegramPollingOrchestrator({
    configuration: () => parseTelegramRuntimeConfiguration(),
    createApi: (configuration) =>
      createTelegramBotApi(createTelegramFetchTransport({ botToken: configuration.botToken })),
    leader: new PostgresTelegramPollingLeaderSource(pool),
    store: new PrismaTelegramPollingStore(database),
    verifyReadiness: ({ configuration, api, signal }) =>
      verifyTelegramBotReadiness({
        configuration,
        api: api ?? inactiveApi,
        state,
        signal,
      }),
    logger: { log },
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      await orchestrator.stop().catch(() => undefined);
      await Promise.allSettled([pool.end(), database.$disconnect()]);
      unregisterPoolErrorHandler();
      log("WORKER_STOPPED");
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  log("WORKER_STARTED");
  try {
    await orchestrator.run();
  } catch {
    log("WORKER_FATAL");
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

if (!databaseUrl) {
  log("WORKER_FATAL");
  process.exitCode = 1;
} else {
  await main(databaseUrl);
}
