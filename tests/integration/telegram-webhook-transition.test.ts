import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { TelegramBotApi } from "../../src/modules/telegram/server/bot-api";
import { TelegramBotStateRepository } from "../../src/modules/telegram/server/bot-state-repository";
import {
  PostgresTelegramMaintenanceLockSource,
  TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY,
} from "../../src/modules/telegram/server/maintenance-lock";
import {
  runTelegramWebhookTransitionCommand,
  TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION,
} from "../../src/modules/telegram/server/webhook-transition-command";
import { TelegramWebhookTransitionService } from "../../src/modules/telegram/server/webhook-transition-service";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { isolatedOutboxDatabaseUrl } from "./telegram-outbox-fixture";

const databaseUrl = isolatedOutboxDatabaseUrl();
const database = createPrismaClient(databaseUrl);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const source = new PostgresTelegramMaintenanceLockSource(pool);
const environment = {
  TELEGRAM_BOT_TOKEN: "123456:INTEGRATION_TOKEN_CANARY_123456789",
  TELEGRAM_BOT_USERNAME: "Transition_Test_Bot",
};

beforeAll(async () => {
  await database.telegramBotState.update({
    where: { id: 1 },
    data: {
      botUserId: 5001n,
      botUsername: "transition_test_bot",
      nextUpdateId: 123n,
      lastVerifiedAt: new Date("2026-09-18T00:00:00.000Z"),
      lastPollAt: new Date("2026-09-18T00:00:00.000Z"),
      lastErrorCode: "WEBHOOK_ACTIVE",
    },
  });
});

afterAll(async () => {
  await database.$disconnect();
  await pool.end();
});

describe("Telegram webhook transition PostgreSQL maintenance protocol", () => {
  it("blocks behind a real worker guard, then transitions with fake API and leaves no locks", async () => {
    const worker = await source.acquireWorker();
    const createApi = vi.fn();
    try {
      await expect(
        runTelegramWebhookTransitionCommand({
          argv: [],
          stdinIsTTY: true,
          stdoutIsTTY: true,
          environment,
          readConfirmation: vi.fn(async () => TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION),
          write: vi.fn(),
          createApi,
          createService: vi.fn(),
          maintenance: source,
        }),
      ).rejects.toMatchObject({ code: "WORKER_ACTIVE" });
      expect(createApi).not.toHaveBeenCalled();
    } finally {
      await worker.release();
    }

    const calls: string[] = [];
    const api = {
      getMe: vi.fn(async () => {
        calls.push("getMe");
        return { id: 5001n, username: "Transition_Test_Bot" };
      }),
      getWebhookInfo: vi
        .fn()
        .mockImplementationOnce(async () => {
          calls.push("getWebhookInfo");
          return { hasWebhook: true, hasCustomCertificate: false, pendingUpdateCount: 7 };
        })
        .mockImplementationOnce(async () => {
          calls.push("getWebhookInfo");
          return { hasWebhook: false, hasCustomCertificate: false, pendingUpdateCount: 7 };
        }),
      deleteWebhook: vi.fn(async (input: { dropPendingUpdates: false }) => {
        calls.push("deleteWebhook");
        expect(input).toEqual({ dropPendingUpdates: false });
      }),
    } satisfies Pick<TelegramBotApi, "getMe" | "getWebhookInfo" | "deleteWebhook">;
    const before = await database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } });

    await expect(
      runTelegramWebhookTransitionCommand({
        argv: [],
        stdinIsTTY: true,
        stdoutIsTTY: true,
        environment,
        readConfirmation: vi.fn(async () => TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION),
        write: vi.fn(),
        createApi: vi.fn(() => api),
        createService: ({ configuration, api: currentApi }) =>
          new TelegramWebhookTransitionService(
            new TelegramBotStateRepository(database),
            currentApi,
            configuration,
          ),
        maintenance: source,
      }),
    ).resolves.toEqual({ status: "TRANSITIONED" });

    expect(calls).toEqual(["getMe", "getWebhookInfo", "deleteWebhook", "getWebhookInfo"]);
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toEqual(before);
    const locks = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory' AND classid = ($1::integer)::oid
         AND objid = ($2::integer)::oid AND granted`,
      [
        TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY.namespace,
        TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY.key,
      ],
    );
    expect(locks.rows[0]?.count).toBe("0");
  });
});
