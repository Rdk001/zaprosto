import {
  createTelegramWorkerRuntime,
  runTelegramWorkerProcess,
  type TelegramWorkerDiagnosticCode,
} from "./modules/telegram/server/worker-runtime.js";
import type { TelegramEnvironment } from "./modules/telegram/server/runtime-config.js";

const databaseUrl = process.env.DATABASE_URL;

function log(code: TelegramWorkerDiagnosticCode) {
  console.log(`[zaprosto-worker] ${code}`);
}

if (!databaseUrl) {
  log("WORKER_FATAL");
  process.exitCode = 1;
} else {
  await runTelegramWorkerProcess({
    runtime: createTelegramWorkerRuntime({
      databaseUrl,
      environment: process.env as TelegramEnvironment,
      logger: { log },
    }),
    process,
    logger: { log },
  });
}
