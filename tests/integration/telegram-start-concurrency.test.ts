import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { processTelegramStart } from "../../src/modules/telegram/server/start-processor";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { bounded } from "./telegram-outbox-fixture";
import {
  createTelegramStartFixture,
  failBeforeOutboxInsert,
  runStart,
  startDatabaseUrl,
} from "./telegram-start-fixture";

const url = startDatabaseUrl();
const first: PrismaClient = createPrismaClient(url);
const second: PrismaClient = createPrismaClient(url);
const blocker = new pg.Client({
  connectionString: url,
  statement_timeout: 5_000,
  query_timeout: 6_000,
});
let fixture: Awaited<ReturnType<typeof createTelegramStartFixture>>;
const forbiddenFetch = vi.fn(() => {
  throw new Error("External Telegram network is forbidden");
});

beforeAll(async () => {
  await Promise.all([first.$connect(), second.$connect(), blocker.connect()]);
  const [[left], [right]] = await Promise.all([
    first.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
    second.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
  ]);
  expect(left.pid).not.toBe(right.pid);
  fixture = await createTelegramStartFixture(first);
});

beforeEach(async () => {
  vi.stubGlobal("fetch", forbiddenFetch);
  await fixture.cleanupRows();
});

afterEach(async () => {
  await blocker.query("ROLLBACK");
  await fixture.cleanupRows();
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fixture?.cleanup();
  await Promise.all([first.$disconnect(), second.$disconnect(), blocker.end()]);
});

async function waitForDatabaseLock(): Promise<void> {
  await bounded(
    (async () => {
      for (;;) {
        const result = await blocker.query<{ found: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND cardinality(pg_blocking_pids(pid)) > 0
           ) AS found`,
        );
        if (result.rows[0]?.found) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    2_000,
  );
}

describe("Telegram /start PostgreSQL lock protocol", () => {
  it("serializes two simultaneous starts of one client token", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const chatId = fixture.nextExternal();
    const outcomes = await bounded(
      Promise.all([
        runStart(first, fixture.command(token, { chatId })),
        runStart(second, fixture.command(token, { chatId })),
      ]),
      5_000,
    );
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual(["ALREADY_PROCESSED", "CONNECTED"]);
    expect(
      await first.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
    ).toBe(1);
    expect(await first.notificationOutbox.count({ where: { appointmentId: appointment.id } })).toBe(
      2,
    );
  });

  it("connects one of two different chats racing for one token and neutrally rejects the other", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const outcomes = await bounded(
      Promise.all([
        runStart(first, fixture.command(token)),
        runStart(second, fixture.command(token)),
      ]),
      5_000,
    );
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual(["CONNECTED", "REJECTED"]);
    expect(
      await first.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
    ).toBe(1);
    expect(
      await first.notificationOutbox.count({ where: { type: "TELEGRAM_CONNECTION_REJECTED" } }),
    ).toBe(1);
  });

  it("serializes different AdminUser tokens for one private chat with the admin-chat advisory lock", async () => {
    const left = await fixture.admin();
    const right = await fixture.admin();
    const leftToken = await fixture.createToken({
      hashPurpose: "ADMIN_USER",
      adminUserId: left.id,
    });
    const rightToken = await fixture.createToken({
      hashPurpose: "ADMIN_USER",
      adminUserId: right.id,
    });
    const chatId = fixture.nextExternal();
    const outcomes = await bounded(
      Promise.all([
        runStart(first, fixture.command(leftToken, { chatId })),
        runStart(second, fixture.command(rightToken, { chatId })),
      ]),
      5_000,
    );
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual(["CONNECTED", "REJECTED"]);
    expect(
      await first.adminTelegramConnection.count({
        where: { telegramChatId: chatId, disabledAt: null },
      }),
    ).toBe(1);
    expect(
      await first.notificationOutbox.count({ where: { type: "ADMIN_CONNECTION_CONFIRMED" } }),
    ).toBe(1);
    expect(
      await first.notificationOutbox.count({ where: { type: "TELEGRAM_CONNECTION_REJECTED" } }),
    ).toBe(1);
  });

  it.each(["REVOKE", "ROTATE"] as const)(
    "rechecks the token after waiting for Appointment during concurrent %s",
    async (action) => {
      const appointment = await fixture.appointment();
      const token = await fixture.createToken({
        hashPurpose: "APPOINTMENT",
        appointmentId: appointment.id,
      });
      const replacement = fixture.credential("APPOINTMENT");
      const command = fixture.command(token);
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [appointment.id]);
      const processing = runStart(second, command);
      await waitForDatabaseLock();
      await blocker.query(
        "UPDATE telegram_link_tokens SET revoked_at = clock_timestamp() WHERE id = $1",
        [token.id],
      );
      if (action === "ROTATE") {
        await blocker.query(
          `INSERT INTO telegram_link_tokens
             (id, purpose, token_hash, appointment_id, created_at, expires_at)
           VALUES ($1, 'APPOINTMENT', $2, $3, clock_timestamp(), clock_timestamp() + interval '30 minutes')`,
          [randomUUID(), replacement.hash, appointment.id],
        );
      }
      await blocker.query("COMMIT");
      await expect(bounded(processing, 5_000)).resolves.toEqual({ kind: "REJECTED" });
      expect(
        await first.appointmentTelegramConnection.count({
          where: { appointmentId: appointment.id },
        }),
      ).toBe(0);
      expect(
        await first.telegramLinkToken.findUniqueOrThrow({ where: { id: token.id } }),
      ).toMatchObject({
        usedAt: null,
        usedByUpdateId: null,
      });
    },
  );

  it("rechecks Appointment status after waiting for its target row lock", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const command = fixture.command(token);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [appointment.id]);
    const processing = runStart(second, command);
    await waitForDatabaseLock();
    await blocker.query("UPDATE appointments SET status = 'CANCELLED' WHERE id = $1", [
      appointment.id,
    ]);
    await blocker.query("COMMIT");
    await expect(bounded(processing, 5_000)).resolves.toEqual({ kind: "REJECTED" });
    expect(
      await first.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
    ).toBe(0);
  });

  it("rechecks AdminUser activity after waiting for its target row lock", async () => {
    const admin = await fixture.admin();
    const token = await fixture.createToken({ hashPurpose: "ADMIN_USER", adminUserId: admin.id });
    const command = fixture.command(token);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM admin_users WHERE id = $1 FOR UPDATE", [admin.id]);
    const processing = runStart(second, command);
    await waitForDatabaseLock();
    await blocker.query("UPDATE admin_users SET is_active = false WHERE id = $1", [admin.id]);
    await blocker.query("COMMIT");
    await expect(bounded(processing, 5_000)).resolves.toEqual({ kind: "REJECTED" });
    expect(await first.adminTelegramConnection.count({ where: { adminUserId: admin.id } })).toBe(0);
  });

  it("rolls back all effects when the second outbox insert fails", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const command = fixture.command(token);
    await expect(
      second.$transaction((tx) => processTelegramStart(failBeforeOutboxInsert(tx, 2), command)),
    ).rejects.toMatchObject({ code: "START_PROCESSOR_STORAGE_FAILURE" });
    expect(
      await first.appointmentTelegramConnection.count({ where: { appointmentId: appointment.id } }),
    ).toBe(0);
    expect(await first.notificationOutbox.count({ where: { appointmentId: appointment.id } })).toBe(
      0,
    );
    expect(
      await first.telegramLinkToken.findUniqueOrThrow({ where: { id: token.id } }),
    ).toMatchObject({
      usedAt: null,
      usedByUpdateId: null,
    });
  });
});
