import pg from "pg";

import { createPrismaClient } from "../src/server/db/create-prisma-client";
import { createTelegramBotApi } from "../src/modules/telegram/server/bot-api";
import { TelegramBotStateRepository } from "../src/modules/telegram/server/bot-state-repository";
import { createTelegramFetchTransport } from "../src/modules/telegram/server/fetch-transport";
import { PostgresTelegramMaintenanceLockSource } from "../src/modules/telegram/server/maintenance-lock";
import type { TelegramEnvironment } from "../src/modules/telegram/server/runtime-config";
import {
  runTelegramWebhookTransitionCommand,
  telegramWebhookTransitionCommandSafeCode,
  TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION,
} from "../src/modules/telegram/server/webhook-transition-command";
import { TelegramWebhookTransitionService } from "../src/modules/telegram/server/webhook-transition-service";
import { readTerminalLine } from "./admin-terminal";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const database = createPrismaClient(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  try {
    await runTelegramWebhookTransitionCommand({
      argv: process.argv.slice(2),
      stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
      environment: process.env as TelegramEnvironment,
      readConfirmation: (maximum) =>
        readTerminalLine(
          `Для подтверждения введите ${TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION}: `,
          false,
          maximum,
        ),
      write: (message) => process.stdout.write(message),
      createApi: (configuration) =>
        createTelegramBotApi(createTelegramFetchTransport({ botToken: configuration.botToken })),
      createService: ({ configuration, api }) =>
        new TelegramWebhookTransitionService(
          new TelegramBotStateRepository(database),
          api,
          configuration,
        ),
      maintenance: new PostgresTelegramMaintenanceLockSource(pool),
    });
  } finally {
    await Promise.allSettled([pool.end(), database.$disconnect()]);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Переход Telegram webhook → polling не выполнен: ${telegramWebhookTransitionCommandSafeCode(error)}. Секреты и ответы API не выводятся.\n`,
  );
  process.exitCode = 1;
});
