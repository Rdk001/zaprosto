import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramBotApi } from "../../src/modules/telegram/server/bot-api";
import {
  runTelegramBotReplacementCommand,
  TELEGRAM_REPLACEMENT_CONFIRMATION,
} from "../../src/modules/telegram/server/bot-replacement-command";
import { TelegramBotReplacementService } from "../../src/modules/telegram/server/bot-replacement-service";
import {
  PostgresTelegramMaintenanceLockSource,
  TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY,
} from "../../src/modules/telegram/server/maintenance-lock";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import {
  OUTBOX_NOW,
  createOutboxFixture,
  isolatedOutboxDatabaseUrl,
  owner,
} from "./telegram-outbox-fixture";

const databaseUrl = isolatedOutboxDatabaseUrl();
const database = createPrismaClient(databaseUrl);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const configuration = {
  kind: "ENABLED" as const,
  botToken: "123456:INTEGRATION_TOKEN_CANARY_123456789",
  botUsername: "Replacement_Test_Bot",
  pollTimeoutSeconds: 30,
};
const oldIdentity = { botUserId: 1001n, botUsername: "Old_Test_Bot" };
const newIdentity = { id: 2002n, username: configuration.botUsername };
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;
const createdTokenIds: string[] = [];
const createdConnectionIds: string[] = [];

function fakeApi(): Pick<TelegramBotApi, "getMe"> {
  return { getMe: vi.fn(async () => newIdentity) };
}

async function resetState() {
  await database.telegramBotState.update({
    where: { id: 1 },
    data: {
      ...oldIdentity,
      nextUpdateId: 987n,
      lastVerifiedAt: OUTBOX_NOW,
      lastPollAt: OUTBOX_NOW,
      lastErrorCode: "NETWORK_UNREACHABLE",
    },
  });
  await database.appointmentTelegramConnection.update({
    where: { id: fixture.clientConnectionId },
    data: { disabledAt: null, disabledReason: null },
  });
  await database.adminTelegramConnection.update({
    where: { id: fixture.adminConnectionId },
    data: { disabledAt: null, disabledReason: null },
  });
}

async function seedToken(
  data: Partial<{
    usedAt: Date;
    usedByUpdateId: bigint;
    revokedAt: Date;
  }> = {},
) {
  const token = await database.telegramLinkToken.create({
    data: {
      purpose: "APPOINTMENT",
      tokenHash: randomUUID().replaceAll("-", "").repeat(2),
      appointmentId: fixture.appointmentId,
      expiresAt: new Date(OUTBOX_NOW.getTime() + 60_000),
      ...data,
    },
  });
  createdTokenIds.push(token.id);
  return token;
}

beforeAll(async () => {
  fixture = await createOutboxFixture(database);
});
beforeEach(resetState);
afterEach(async () => {
  await fixture.cleanupJobs();
  if (createdTokenIds.length) {
    await database.telegramLinkToken.deleteMany({
      where: { id: { in: createdTokenIds.splice(0) } },
    });
  }
  if (createdConnectionIds.length) {
    await database.appointmentTelegramConnection.deleteMany({
      where: { id: { in: createdConnectionIds.splice(0) } },
    });
  }
});
afterAll(async () => {
  await fixture.cleanup();
  await database.$disconnect();
  await pool.end();
});

describe("Telegram bot replacement PostgreSQL protocol", () => {
  it("lets workers share the guard, rejects exclusive mode, then releases every advisory lock", async () => {
    const source = new PostgresTelegramMaintenanceLockSource(pool);
    const first = await source.acquireWorker();
    const second = await source.acquireWorker();
    try {
      await expect(source.tryAcquireOperator()).resolves.toBeNull();
    } finally {
      await Promise.all([first.release(), second.release()]);
    }

    const exclusive = await source.tryAcquireOperator();
    expect(exclusive?.mode).toBe("OPERATOR_EXCLUSIVE");
    await exclusive?.release();
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

  it("returns WORKER_ACTIVE without mutation while a real shared worker guard is alive", async () => {
    const source = new PostgresTelegramMaintenanceLockSource(pool);
    const worker = await source.acquireWorker();
    const stateBefore = await database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } });
    try {
      await expect(
        runTelegramBotReplacementCommand({
          argv: [],
          stdinIsTTY: true,
          stdoutIsTTY: true,
          environment: {
            TELEGRAM_BOT_TOKEN: configuration.botToken,
            TELEGRAM_BOT_USERNAME: configuration.botUsername,
          },
          readConfirmation: vi.fn(async () => TELEGRAM_REPLACEMENT_CONFIRMATION),
          write: vi.fn(),
          createApi: () => fakeApi(),
          createService: ({ configuration: current, api }) =>
            new TelegramBotReplacementService(database, api, current),
          maintenance: source,
        }),
      ).rejects.toMatchObject({ code: "WORKER_ACTIVE" });
    } finally {
      await worker.release();
    }
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toEqual(stateBefore);
    await expect(
      database.appointmentTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.clientConnectionId },
      }),
    ).resolves.toMatchObject({ disabledAt: null, disabledReason: null });
  });

  it("atomically replaces identity, connections, tokens, and every unfinished job", async () => {
    const alreadyDisabled = await database.appointmentTelegramConnection.create({
      data: {
        appointmentId: fixture.appointmentId,
        telegramUserId: fixture.externalId + 10n,
        telegramChatId: fixture.externalId + 10n,
        sourceUpdateId: fixture.externalId + 10n,
        connectedAt: OUTBOX_NOW,
        disabledAt: OUTBOX_NOW,
        disabledReason: "USER_DISCONNECTED",
      },
    });
    createdConnectionIds.push(alreadyDisabled.id);
    const unused = await seedToken();
    const used = await seedToken({
      usedAt: OUTBOX_NOW,
      usedByUpdateId: fixture.externalId + 20n,
    });
    const revoked = await seedToken({ revokedAt: OUTBOX_NOW });
    const pending = await fixture.seed();
    const processing = await fixture.seed({
      type: "TELEGRAM_CONNECTION_REJECTED",
      status: "PROCESSING",
      attempts: 1,
      leaseToken: randomUUID(),
      leaseOwner: owner(),
      claimedAt: OUTBOX_NOW,
      leaseExpiresAt: new Date(OUTBOX_NOW.getTime() + 60_000),
    });
    const terminal = await Promise.all([
      fixture.seed({ status: "SENT", sentAt: OUTBOX_NOW, finishedAt: OUTBOX_NOW }),
      fixture.seed({ status: "DEAD", finishedAt: OUTBOX_NOW }),
      fixture.seed({
        status: "CANCELLED",
        invalidatedAt: OUTBOX_NOW,
        invalidationCode: "CONNECTION_DISABLED",
        finishedAt: OUTBOX_NOW,
      }),
      fixture.seed({ status: "SKIPPED", finishedAt: OUTBOX_NOW }),
    ]);
    const terminalBefore = await database.notificationOutbox.findMany({
      where: { id: { in: terminal.map((job) => job.id) } },
      orderBy: { id: "asc" },
    });
    const service = new TelegramBotReplacementService(database, fakeApi(), configuration);
    await expect(service.preflight()).resolves.toEqual({ status: "READY" });
    await expect(service.replace()).resolves.toEqual({
      status: "REPLACED",
      appointmentConnectionsDisabled: 1,
      adminConnectionsDisabled: 1,
      linkTokensRevoked: 1,
      jobsCancelled: 2,
    });

    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      botUserId: newIdentity.id,
      botUsername: newIdentity.username,
      nextUpdateId: 0n,
      lastVerifiedAt: null,
      lastPollAt: null,
      lastErrorCode: null,
    });
    await expect(
      database.appointmentTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.clientConnectionId },
      }),
    ).resolves.toMatchObject({ disabledReason: "BOT_REPLACED" });
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).resolves.toMatchObject({ disabledReason: "BOT_REPLACED" });
    await expect(
      database.appointmentTelegramConnection.findUniqueOrThrow({
        where: { id: alreadyDisabled.id },
      }),
    ).resolves.toMatchObject({ disabledAt: OUTBOX_NOW, disabledReason: "USER_DISCONNECTED" });
    await expect(
      database.telegramLinkToken.findUniqueOrThrow({ where: { id: unused.id } }),
    ).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    });
    await expect(
      database.telegramLinkToken.findUniqueOrThrow({ where: { id: used.id } }),
    ).resolves.toMatchObject({
      revokedAt: null,
    });
    await expect(
      database.telegramLinkToken.findUniqueOrThrow({ where: { id: revoked.id } }),
    ).resolves.toMatchObject({
      revokedAt: OUTBOX_NOW,
    });
    for (const job of [pending, processing]) {
      await expect(
        database.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } }),
      ).resolves.toMatchObject({
        status: "CANCELLED",
        invalidationCode: "BOT_REPLACED",
        invalidatedAt: expect.any(Date),
        finishedAt: expect.any(Date),
        leaseToken: null,
        leaseOwner: null,
        claimedAt: null,
        leaseExpiresAt: null,
      });
    }
    await expect(
      database.notificationOutbox.findMany({
        where: { id: { in: terminal.map((job) => job.id) } },
        orderBy: { id: "asc" },
      }),
    ).resolves.toEqual(terminalBefore);
  });

  it("detects a state change between preflight and transaction and rolls back", async () => {
    const service = new TelegramBotReplacementService(database, fakeApi(), configuration);
    await service.preflight();
    await database.telegramBotState.update({
      where: { id: 1 },
      data: { nextUpdateId: 999n, botUsername: "Changed_Old_Bot" },
    });

    await expect(service.replace()).rejects.toMatchObject({ code: "BOT_STATE_CONFLICT" });
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      botUserId: oldIdentity.botUserId,
      botUsername: "Changed_Old_Bot",
      nextUpdateId: 999n,
    });
    await expect(
      database.appointmentTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.clientConnectionId },
      }),
    ).resolves.toMatchObject({ disabledAt: null, disabledReason: null });
  });

  it("rolls back every mutation after an artificial mid-transaction failure", async () => {
    const pending = await fixture.seed();
    const unused = await seedToken();
    const service = new TelegramBotReplacementService(database, fakeApi(), configuration, {
      beforeCommit: async () => {
        throw new Error("ROLLBACK_SECRET_CANARY");
      },
    });
    await service.preflight();
    const error = await service.replace().catch((caught) => caught);
    expect(error).toMatchObject({ code: "REPLACEMENT_STORAGE_FAILURE" });
    expect(JSON.stringify(error)).not.toContain("ROLLBACK_SECRET_CANARY");

    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      ...oldIdentity,
      nextUpdateId: 987n,
    });
    await expect(
      database.appointmentTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.clientConnectionId },
      }),
    ).resolves.toMatchObject({ disabledAt: null, disabledReason: null });
    await expect(
      database.telegramLinkToken.findUniqueOrThrow({ where: { id: unused.id } }),
    ).resolves.toMatchObject({
      revokedAt: null,
    });
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: pending.id } }),
    ).resolves.toMatchObject({
      status: "PENDING",
      invalidatedAt: null,
      finishedAt: null,
    });
  });
});
