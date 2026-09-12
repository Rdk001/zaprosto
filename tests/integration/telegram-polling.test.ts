import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import type { TelegramUpdate } from "../../src/modules/telegram/server/bot-api";
import {
  PostgresTelegramPollingLeaderSource,
  type TelegramPollingLeaderSession,
} from "../../src/modules/telegram/server/polling-leader";
import { processTelegramUpdateBatch } from "../../src/modules/telegram/server/polling-orchestrator";
import {
  PrismaTelegramPollingStore,
  TelegramPollingStoreError,
} from "../../src/modules/telegram/server/polling-store";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createTelegramStartFixture, startDatabaseUrl } from "./telegram-start-fixture";
import { bounded } from "./telegram-outbox-fixture";

const url = startDatabaseUrl();
const database: PrismaClient = createPrismaClient(url);
const other: PrismaClient = createPrismaClient(url);
const firstPool = new pg.Pool({ connectionString: url, max: 1 });
const secondPool = new pg.Pool({ connectionString: url, max: 1 });
const testLockKey = {
  namespace: 526_009,
  key: 1_000 + (process.pid % 1_000_000),
} as const;
let fixture: Awaited<ReturnType<typeof createTelegramStartFixture>>;

const alwaysLeader: TelegramPollingLeaderSession = {
  signal: new AbortController().signal,
  confirmLeadership: vi.fn(async () => true),
  close: vi.fn(async () => undefined),
};

function telegramUpdate(updateId: bigint, text?: string, chatId = 7_000_000_001n): TelegramUpdate {
  return {
    updateId,
    ...(text === undefined
      ? {}
      : {
          message: {
            messageId: updateId,
            from: { id: chatId, isBot: false },
            dateUnixSeconds: 1,
            chat: { id: chatId, type: "private" },
            text,
          },
        }),
  };
}

async function resetState(nextUpdateId = 0n) {
  await database.telegramBotState.update({
    where: { id: 1 },
    data: {
      nextUpdateId,
      lastPollAt: null,
      lastErrorCode: null,
    },
  });
}

beforeAll(async () => {
  await Promise.all([database.$connect(), other.$connect()]);
  fixture = await createTelegramStartFixture(database);
});

beforeEach(async () => {
  await fixture.cleanupRows();
  await resetState();
  vi.mocked(alwaysLeader.confirmLeadership).mockClear();
});

afterEach(async () => {
  await fixture.cleanupRows();
  await resetState();
});

afterAll(async () => {
  await fixture?.cleanup();
  await Promise.all([
    database.$disconnect(),
    other.$disconnect(),
    firstPool.end(),
    secondPool.end(),
  ]);
});

describe("Telegram polling advisory lock with real PostgreSQL sessions", () => {
  it("allows exactly one leader and transfers leadership after release", async () => {
    const firstSource = new PostgresTelegramPollingLeaderSource(firstPool, testLockKey);
    const secondSource = new PostgresTelegramPollingLeaderSource(secondPool, testLockKey);

    const first = await firstSource.tryAcquire();
    expect(first).not.toBeNull();
    await expect(first?.confirmLeadership()).resolves.toBe(true);
    await expect(secondSource.tryAcquire()).resolves.toBeNull();

    await first?.close();
    const second = await secondSource.tryAcquire();
    expect(second).not.toBeNull();
    await expect(second?.confirmLeadership()).resolves.toBe(true);
    await second?.close();
  });

  it("invalidates a terminated leader session and lets another session acquire", async () => {
    const firstSource = new PostgresTelegramPollingLeaderSource(firstPool, testLockKey);
    const secondSource = new PostgresTelegramPollingLeaderSource(secondPool, testLockKey);
    const first = await firstSource.tryAcquire();
    expect(first).not.toBeNull();

    const holders = await other.$queryRaw<{ pid: number }[]>`
      SELECT pid
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = ${testLockKey.namespace}::integer::oid
        AND objid = ${testLockKey.key}::integer::oid
        AND objsubid = 2
        AND granted
    `;
    expect(holders).toHaveLength(1);
    await other.$queryRaw<{ terminated: boolean }[]>`
      SELECT pg_terminate_backend(${holders[0]!.pid}) AS terminated
    `;
    await bounded(
      new Promise<void>((resolve) => {
        if (first?.signal.aborted) resolve();
        else first?.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
      2_000,
    );

    await expect(first?.confirmLeadership()).resolves.toBe(false);
    const second = await secondSource.tryAcquire();
    expect(second).not.toBeNull();
    await second?.close();
    await first?.close();
  });
});

describe("Telegram polling transactional offset protocol", () => {
  it("commits start effects and nextUpdateId atomically", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const store = new PrismaTelegramPollingStore(database);
    const result = await store.processUpdate({
      update: telegramUpdate(10n, `/start ${token.raw}`),
      expectedOffset: 0n,
      botUsername: "Zaprosto_Test_Bot",
    });

    expect(result).toEqual({ kind: "COMMITTED", nextExpectedOffset: 11n });
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      nextUpdateId: 11n,
      lastErrorCode: null,
    });
    await expect(
      database.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
    ).resolves.toBe(1);
    await expect(
      database.notificationOutbox.count({ where: { appointmentId: appointment.id } }),
    ).resolves.toBe(2);
    await expect(
      database.telegramLinkToken.findUniqueOrThrow({ where: { id: token.id } }),
    ).resolves.toMatchObject({
      usedByUpdateId: 10n,
    });
  });

  it("rolls back connection, jobs, token usage, and offset on a failure before offset update", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const store = new PrismaTelegramPollingStore(database, {
      beforeOffsetUpdate: async () => {
        throw new Error("ARTIFICIAL_FAILURE_AFTER_PROCESSOR");
      },
    });

    await expect(
      store.processUpdate({
        update: telegramUpdate(20n, `/start ${token.raw}`),
        expectedOffset: 0n,
        botUsername: "Zaprosto_Test_Bot",
      }),
    ).rejects.toBeInstanceOf(TelegramPollingStoreError);
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      nextUpdateId: 0n,
      lastPollAt: null,
    });
    await expect(
      database.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
    ).resolves.toBe(0);
    await expect(
      database.notificationOutbox.count({ where: { appointmentId: appointment.id } }),
    ).resolves.toBe(0);
    await expect(
      database.telegramLinkToken.findUniqueOrThrow({ where: { id: token.id } }),
    ).resolves.toMatchObject({
      usedAt: null,
      usedByUpdateId: null,
    });
  });

  it("stops on external singleton movement without applying the update", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    await other.telegramBotState.update({ where: { id: 1 }, data: { nextUpdateId: 5n } });

    await expect(
      new PrismaTelegramPollingStore(database).processUpdate({
        update: telegramUpdate(8n, `/start ${token.raw}`),
        expectedOffset: 0n,
        botUsername: "Zaprosto_Test_Bot",
      }),
    ).resolves.toEqual({ kind: "OFFSET_CONFLICT" });
    await expect(
      database.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
    ).resolves.toBe(0);
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      nextUpdateId: 5n,
      lastErrorCode: "POLL_OFFSET_CONFLICT",
    });
  });

  it("sorts out-of-order updates and accepts gaps as updateId plus one", async () => {
    const store = new PrismaTelegramPollingStore(database);
    const result = await processTelegramUpdateBatch({
      updates: [telegramUpdate(40n), telegramUpdate(3n), telegramUpdate(15n)],
      requestedOffset: 0n,
      botUsername: "Zaprosto_Test_Bot",
      leader: alwaysLeader,
      store,
    });

    expect(result).toEqual({ kind: "COMPLETED", nextExpectedOffset: 41n });
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      nextUpdateId: 41n,
      lastErrorCode: null,
    });
    expect(alwaysLeader.confirmLeadership).toHaveBeenCalledTimes(3);
  });

  it("treats a replay as no-op without creating duplicate effects", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const store = new PrismaTelegramPollingStore(database);
    const value = telegramUpdate(50n, `/start ${token.raw}`);
    await store.processUpdate({
      update: value,
      expectedOffset: 0n,
      botUsername: "Zaprosto_Test_Bot",
    });
    const before = await Promise.all([
      database.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
      database.notificationOutbox.count({ where: { appointmentId: appointment.id } }),
    ]);

    await expect(
      store.processUpdate({
        update: value,
        expectedOffset: 51n,
        botUsername: "Zaprosto_Test_Bot",
      }),
    ).resolves.toEqual({ kind: "COMMITTED", nextExpectedOffset: 51n });
    await expect(
      Promise.all([
        database.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
        database.notificationOutbox.count({ where: { appointmentId: appointment.id } }),
      ]),
    ).resolves.toEqual(before);
  });

  it("commits ignored updates and duplicates by advancing only once", async () => {
    const store = new PrismaTelegramPollingStore(database);
    await database.telegramBotState.update({
      where: { id: 1 },
      data: { lastErrorCode: "NETWORK_UNREACHABLE" },
    });
    await expect(
      processTelegramUpdateBatch({
        updates: [telegramUpdate(70n, "ignored"), telegramUpdate(70n, "ignored")],
        requestedOffset: 0n,
        botUsername: "Zaprosto_Test_Bot",
        leader: alwaysLeader,
        store,
      }),
    ).resolves.toEqual({ kind: "COMPLETED", nextExpectedOffset: 71n });
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      nextUpdateId: 71n,
      lastErrorCode: null,
    });
    expect(
      (await database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } })).lastPollAt,
    ).toBeInstanceOf(Date);
  });

  it("updates lastPollAt for an empty batch only when offset is unchanged", async () => {
    const store = new PrismaTelegramPollingStore(database);
    await expect(store.recordEmptyPoll(0n)).resolves.toEqual({
      kind: "COMMITTED",
      nextExpectedOffset: 0n,
    });
    const first = await database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } });
    expect(first.lastPollAt).toBeInstanceOf(Date);

    await other.telegramBotState.update({ where: { id: 1 }, data: { nextUpdateId: 9n } });
    await expect(store.recordEmptyPoll(0n)).resolves.toEqual({ kind: "OFFSET_CONFLICT" });
    const conflicted = await database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } });
    expect(conflicted.nextUpdateId).toBe(9n);
    expect(conflicted.lastPollAt).toEqual(first.lastPollAt);
    expect(conflicted.lastErrorCode).toBe("POLL_OFFSET_CONFLICT");
  });

  it("does not process later updates after one update fails", async () => {
    const firstAppointment = await fixture.appointment();
    const secondAppointment = await fixture.appointment({ startsInMs: 5 * 60 * 60_000 });
    const firstToken = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: firstAppointment.id,
    });
    const secondToken = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: secondAppointment.id,
    });
    const store = new PrismaTelegramPollingStore(database, {
      beforeOffsetUpdate: async (_tx, value) => {
        if (value.updateId === 80n) throw new Error("FIRST_UPDATE_FAILURE");
      },
    });

    await expect(
      processTelegramUpdateBatch({
        updates: [
          telegramUpdate(80n, `/start ${firstToken.raw}`, 7_000_000_080n),
          telegramUpdate(81n, `/start ${secondToken.raw}`, 7_000_000_081n),
        ],
        requestedOffset: 0n,
        botUsername: "Zaprosto_Test_Bot",
        leader: alwaysLeader,
        store,
      }),
    ).rejects.toBeInstanceOf(TelegramPollingStoreError);
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      nextUpdateId: 0n,
    });
    await expect(
      database.appointmentTelegramConnection.count({
        where: { appointmentId: { in: [firstAppointment.id, secondAppointment.id] } },
      }),
    ).resolves.toBe(0);
    await expect(
      database.telegramLinkToken.count({
        where: { id: { in: [firstToken.id, secondToken.id] }, usedAt: { not: null } },
      }),
    ).resolves.toBe(0);
  });
});
