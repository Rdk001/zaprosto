import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { getActiveAdmin } from "../../src/modules/auth/server/auth-service";
import {
  generateTelegramLinkToken,
  hashTelegramLinkToken,
} from "../../src/modules/telegram/domain/link-token";
import { TELEGRAM_POLICY } from "../../src/modules/telegram/domain/policy";
import {
  TelegramLinkRepository,
  TelegramLinkRepositoryError,
} from "../../src/modules/telegram/server/link-repository";
import { TelegramLinkService } from "../../src/modules/telegram/server/link-service";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { bounded, deferred } from "./telegram-outbox-fixture";
import {
  LINK_CONFIGURATION,
  createLinkService,
  createTelegramLinkFixture,
  linkDatabaseUrl,
} from "./telegram-link-fixture";

const url = linkDatabaseUrl();
const first = createPrismaClient(url);
const second = createPrismaClient(url);
const blocker = new pg.Client({
  connectionString: url,
  statement_timeout: 5_000,
  query_timeout: 6_000,
});
let fixture: Awaited<ReturnType<typeof createTelegramLinkFixture>>;
const forbiddenFetch = vi.fn(() => {
  throw new Error("External network is forbidden");
});

beforeAll(async () => {
  await Promise.all([first.$connect(), second.$connect(), blocker.connect()]);
  const [[left], [right]] = await Promise.all([
    first.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
    second.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
  ]);
  expect(left.pid).not.toBe(right.pid);
  fixture = await createTelegramLinkFixture(first);
});
beforeEach(async () => {
  vi.stubGlobal("fetch", forbiddenFetch);
  await fixture.cleanupRows();
  await fixture.readyBot();
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

async function waitForBlocked() {
  const limit = Date.now() + 2_000;
  while (Date.now() < limit) {
    const result = await blocker.query<{ found: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND wait_event_type = 'Lock'
      ) AS found`,
    );
    if (result.rows[0]?.found) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a PostgreSQL row lock");
}

function start(result: { ok: boolean; deepLink?: string }) {
  if (!result.ok || !result.deepLink) throw new Error("Expected successful link");
  return new URL(result.deepLink).searchParams.get("start");
}

function failBeforeLinkInsert(database: PrismaClient): PrismaClient {
  return new Proxy(database, {
    get(target, property) {
      if (property !== "$transaction") return Reflect.get(target, property);
      return (run: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
        target.$transaction(async (tx) => {
          const guarded = new Proxy(tx, {
            get(txTarget, txProperty) {
              if (txProperty !== "telegramLinkToken") return Reflect.get(txTarget, txProperty);
              return new Proxy(txTarget.telegramLinkToken, {
                get(delegate, delegateProperty) {
                  if (delegateProperty === "create")
                    return () => Promise.reject(new Error("LINK_INSERT_FAULT_CANARY"));
                  return Reflect.get(delegate, delegateProperty);
                },
              });
            },
          }) as Prisma.TransactionClient;
          return run(guarded);
        }, options);
    },
  }) as PrismaClient;
}

describe("Telegram link concurrency on independent PostgreSQL sessions", () => {
  it("serializes two appointment issuances and leaves one active credential", async () => {
    const appointment = await fixture.appointment();
    const results = await bounded(
      Promise.all([
        createLinkService(first).issueAppointmentLink(appointment.token),
        createLinkService(second).issueAppointmentLink(appointment.token),
      ]),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(start(results[0]!)).not.toBe(start(results[1]!));
    const rows = await first.telegramLinkToken.findMany({
      where: { appointmentId: appointment.id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.usedAt === null && row.revokedAt === null)).toHaveLength(1);
  });

  it("serializes two admin issuances and leaves one active credential", async () => {
    const admin = await fixture.admin();
    const results = await bounded(
      Promise.all([
        createLinkService(first).issueAdminLink(admin.token),
        createLinkService(second).issueAdminLink(admin.token),
      ]),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(start(results[0]!)).not.toBe(start(results[1]!));
    const rows = await first.telegramLinkToken.findMany({ where: { adminUserId: admin.id } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.usedAt === null && row.revokedAt === null)).toHaveLength(1);
  });

  it("rechecks appointment status after waiting for the target lock", async () => {
    const appointment = await fixture.appointment();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [appointment.id]);
    await blocker.query("UPDATE appointments SET status = 'CANCELLED' WHERE id = $1", [
      appointment.id,
    ]);
    const issuing = createLinkService(second).issueAppointmentLink(appointment.token);
    await waitForBlocked();
    await blocker.query("COMMIT");
    await expect(bounded(issuing)).resolves.toEqual({
      ok: false,
      code: "APPOINTMENT_NOT_ELIGIBLE",
    });
    expect(await first.telegramLinkToken.count({ where: { appointmentId: appointment.id } })).toBe(
      0,
    );
  });

  it("uses the same target lock protocol for concurrent connection creation", async () => {
    const appointment = await fixture.appointment();
    const external = fixture.nextExternal();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [appointment.id]);
    await blocker.query(
      `INSERT INTO appointment_telegram_connections
        (id, appointment_id, telegram_user_id, telegram_chat_id, source_update_id, connected_at)
       VALUES ($1, $2, $3, $3, $3, clock_timestamp())`,
      [randomUUID(), appointment.id, external.toString()],
    );
    const issuing = createLinkService(second).issueAppointmentLink(appointment.token);
    await waitForBlocked();
    await blocker.query("COMMIT");
    await expect(bounded(issuing)).resolves.toEqual({ ok: false, code: "ALREADY_CONNECTED" });
    expect(await first.telegramLinkToken.count({ where: { appointmentId: appointment.id } })).toBe(
      0,
    );
  });

  it("uses the admin target lock protocol for concurrent active connection creation", async () => {
    const admin = await fixture.admin();
    const external = fixture.nextExternal();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM admin_users WHERE id = $1 FOR UPDATE", [admin.id]);
    await blocker.query(
      `INSERT INTO admin_telegram_connections
        (id, admin_user_id, telegram_user_id, telegram_chat_id, source_update_id, connected_at)
       VALUES ($1, $2, $3, $3, $3, clock_timestamp())`,
      [randomUUID(), admin.id, external.toString()],
    );
    const issuing = createLinkService(second).issueAdminLink(admin.token);
    await waitForBlocked();
    await blocker.query("COMMIT");
    await expect(bounded(issuing)).resolves.toEqual({ ok: false, code: "ALREADY_CONNECTED" });
    expect(await first.telegramLinkToken.count({ where: { adminUserId: admin.id } })).toBe(0);
  });

  it.each(["DEACTIVATE", "REVOKE_SESSION"] as const)(
    "denies admin issuance when access changes while waiting: %s",
    async (change) => {
      const admin = await fixture.admin();
      const authorized = deferred();
      const service = new TelegramLinkService(
        second,
        new TelegramLinkRepository(second, LINK_CONFIGURATION),
        {
          readActiveAdmin: async (database, token) => {
            const result = await getActiveAdmin(database, token);
            authorized.resolve();
            return result;
          },
        },
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM admin_users WHERE id = $1 FOR UPDATE", [admin.id]);
      const issuing = service.issueAdminLink(admin.token);
      await bounded(authorized.promise);
      await waitForBlocked();
      if (change === "DEACTIVATE")
        await blocker.query("UPDATE admin_users SET is_active = false WHERE id = $1", [admin.id]);
      else
        await blocker.query(
          "UPDATE admin_sessions SET revoked_at = clock_timestamp() WHERE id = $1",
          [admin.sessionId],
        );
      await blocker.query("COMMIT");
      await expect(bounded(issuing)).resolves.toEqual({
        ok: false,
        code: change === "DEACTIVATE" ? "FORBIDDEN" : "UNAUTHORIZED",
      });
      expect(await first.telegramLinkToken.count({ where: { adminUserId: admin.id } })).toBe(0);
    },
  );

  it("does not exceed five target grants under concurrent increments", async () => {
    const appointment = await fixture.appointment();
    const services = [createLinkService(first), createLinkService(second)];
    const results = await bounded(
      Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          services[index % services.length]!.issueAppointmentLink(appointment.token),
        ),
      ),
      8_000,
    );
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(results.filter((result) => !result.ok && result.code === "RATE_LIMITED")).toHaveLength(
      1,
    );
    expect(
      await first.telegramLinkToken.count({
        where: { appointmentId: appointment.id, usedAt: null, revokedAt: null },
      }),
    ).toBe(1);
  });

  it("shares one twenty-attempt installation limit across client and admin purposes", async () => {
    const appointments = [];
    const admins = [];
    for (let index = 0; index < 11; index++)
      appointments.push(
        await fixture.appointment({ startsAt: new Date(Date.now() + (index + 1) * 60 * 60_000) }),
      );
    for (let index = 0; index < 10; index++) admins.push(await fixture.admin());
    const services = [createLinkService(first), createLinkService(second)];
    const operations = [
      ...appointments.map((appointment, index) =>
        services[index % 2]!.issueAppointmentLink(appointment.token),
      ),
      ...admins.map((admin, index) => services[index % 2]!.issueAdminLink(admin.token)),
    ];
    const results = await bounded(Promise.all(operations), 15_000);
    expect(results.filter((result) => result.ok)).toHaveLength(20);
    expect(results.filter((result) => !result.ok && result.code === "RATE_LIMITED")).toHaveLength(
      1,
    );
    expect(
      await first.publicRateLimit.findUniqueOrThrow({
        where: { key: "telegram-link:installation:v1" },
      }),
    ).toMatchObject({ hits: TELEGRAM_POLICY.linkIssuance.maxAttemptsPerInstallation + 1 });
  }, 20_000);

  it("rolls back old-token revocation when insertion fails", async () => {
    const appointment = await fixture.appointment();
    expect((await createLinkService(first).issueAppointmentLink(appointment.token)).ok).toBe(true);
    const old = await first.telegramLinkToken.findFirstOrThrow({
      where: { appointmentId: appointment.id },
    });
    const generated = generateTelegramLinkToken("APPOINTMENT", (size) =>
      new Uint8Array(size).fill(0xcd),
    );
    const hashed = hashTelegramLinkToken(generated.startParameter);
    if (!hashed.ok) throw new Error("Expected deterministic test hash");
    const failing = new TelegramLinkRepository(failBeforeLinkInsert(first), LINK_CONFIGURATION);
    const error = await failing
      .issueAppointment({
        cancellationTokenHash: appointment.cancellationTokenHash,
        linkTokenHash: hashed.hash,
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TelegramLinkRepositoryError);
    expect(JSON.stringify(error)).not.toContain("LINK_INSERT_FAULT_CANARY");
    expect(await first.telegramLinkToken.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await first.telegramLinkToken.count({ where: { tokenHash: hashed.hash } })).toBe(0);
  });

  it("retains the partial UNIQUE index as the last active-token defense", async () => {
    const appointment = await fixture.appointment();
    const at = new Date();
    const firstHash = hashTelegramLinkToken(
      generateTelegramLinkToken("APPOINTMENT", (size) => new Uint8Array(size).fill(1))
        .startParameter,
    );
    const secondHash = hashTelegramLinkToken(
      generateTelegramLinkToken("APPOINTMENT", (size) => new Uint8Array(size).fill(2))
        .startParameter,
    );
    if (!firstHash.ok || !secondHash.ok) throw new Error("Expected deterministic test hashes");
    await first.telegramLinkToken.create({
      data: {
        purpose: "APPOINTMENT",
        tokenHash: firstHash.hash,
        appointmentId: appointment.id,
        createdAt: at,
        expiresAt: new Date(at.getTime() + TELEGRAM_POLICY.linkTokenTtlMs),
      },
    });
    await expect(
      second.telegramLinkToken.create({
        data: {
          purpose: "APPOINTMENT",
          tokenHash: secondHash.hash,
          appointmentId: appointment.id,
          createdAt: at,
          expiresAt: new Date(at.getTime() + TELEGRAM_POLICY.linkTokenTtlMs),
        },
      }),
    ).rejects.toBeDefined();
    expect(
      await first.telegramLinkToken.count({
        where: { appointmentId: appointment.id, usedAt: null, revokedAt: null },
      }),
    ).toBe(1);
  });
});
