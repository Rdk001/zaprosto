import type { Pool } from "pg";

import type { TelegramPollingLogger } from "./polling-orchestrator";

type WorkerPoolErrorSource = Pick<Pool, "on" | "removeListener">;

export function registerTelegramWorkerPoolErrorHandler(
  pool: WorkerPoolErrorSource,
  logger: TelegramPollingLogger,
): () => void {
  const onError = () => {
    try {
      logger.log("LEADER_SESSION_FAILURE");
    } catch {
      // Logging failures must not turn an idle client error into a worker crash.
    }
  };

  pool.on("error", onError);
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    pool.removeListener("error", onError);
  };
}
