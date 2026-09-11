import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { hashTelegramLinkToken } from "../../src/modules/telegram/domain/link-token";
import { TELEGRAM_POLICY } from "../../src/modules/telegram/domain/policy";
import {
  TelegramLinkRepository,
  telegramLinkTargetRateLimitKey,
} from "../../src/modules/telegram/server/link-repository";
import { TelegramLinkService } from "../../src/modules/telegram/server/link-service";
import { prepareBookingAttempt } from "../../src/modules/booking/server/booking-security";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import {
  LINK_BOT_USERNAME,
  createLinkService,
  createTelegramLinkFixture,
  linkDatabaseUrl,
} from "./telegram-link-fixture";

const database = createPrismaClient(linkDatabaseUrl());
let fixture: Awaited<ReturnType<typeof createTelegramLinkFixture>>;
const forbiddenFetch = vi.fn(() => {
  throw new Error("External network is forbidden");
});

beforeAll(async () => {
  await database.$connect();
  fixture = await createTelegramLinkFixture(database);
});
beforeEach(async () => {
  vi.stubGlobal("fetch", forbiddenFetch);
  await fixture.cleanupRows();
  await fixture.readyBot();
});
afterEach(() => {
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await fixture?.cleanup();
  await database.$disconnect();
});

function rawFrom(
  result: Awaited<ReturnType<ReturnType<typeof createLinkService>["issueAppointmentLink"]>>,
) {
  if (!result.ok) throw new Error("Expected successful link");
  return new URL(result.deepLink).searchParams.get("start")!;
}

describe("Telegram one-time link PostgreSQL lifecycle", () => {
  it("stores only a lowercase purpose hash and uses an exact 30 minute DB TTL", async () => {
    const appointment = await fixture.appointment();
    const result = await createLinkService(database).issueAppointmentLink(appointment.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = rawFrom(result);
    expect(result.deepLink).toBe(`https://t.me/${LINK_BOT_USERNAME}?start=${raw}`);
    expect(raw).toMatch(/^c_[A-Za-z0-9_-]{43}$/);

    const row = await database.telegramLinkToken.findFirstOrThrow({
      where: { appointmentId: appointment.id },
    });
    const hashed = hashTelegramLinkToken(raw);
    expect(hashed.ok && hashed.hash).toBe(row.tokenHash);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(TELEGRAM_POLICY.linkTokenTtlMs);
    expect(result.expiresAt).toEqual(row.expiresAt);
    expect(JSON.stringify(row)).not.toContain(raw);
  });

  it("rotation after a lost response returns a new raw value and revokes only the old unused row", async () => {
    const appointment = await fixture.appointment();
    const service = createLinkService(database);
    const first = await service.issueAppointmentLink(appointment.token);
    const second = await service.issueAppointmentLink(appointment.token);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.deepLink).not.toBe(second.deepLink);
    const rows = await database.telegramLinkToken.findMany({
      where: { appointmentId: appointment.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.usedAt === null && row.revokedAt === null)).toHaveLength(1);
    expect(rows[0]!.revokedAt).not.toBeNull();
    expect(rows[1]!.revokedAt).toBeNull();
  });

  it("preserves used tokens and revoke is idempotent and purpose-scoped", async () => {
    const appointment = await fixture.appointment();
    const admin = await fixture.admin();
    const service = createLinkService(database);
    expect((await service.issueAppointmentLink(appointment.token)).ok).toBe(true);
    const used = await database.telegramLinkToken.findFirstOrThrow({
      where: { appointmentId: appointment.id },
    });
    await database.telegramLinkToken.update({
      where: { id: used.id },
      data: { usedAt: new Date(), usedByUpdateId: fixture.nextExternal() },
    });
    expect((await service.issueAppointmentLink(appointment.token)).ok).toBe(true);
    expect((await service.issueAdminLink(admin.token)).ok).toBe(true);

    await expect(service.revokeAppointmentLink(appointment.token)).resolves.toEqual({ ok: true });
    await expect(service.revokeAppointmentLink(appointment.token)).resolves.toEqual({ ok: true });
    expect(
      await database.telegramLinkToken.findUniqueOrThrow({ where: { id: used.id } }),
    ).toMatchObject({
      usedAt: expect.any(Date),
      revokedAt: null,
    });
    expect(
      await database.telegramLinkToken.count({
        where: { adminUserId: admin.id, usedAt: null, revokedAt: null },
      }),
    ).toBe(1);
    expect((await service.issueAppointmentLink(appointment.token)).ok).toBe(true);
    await expect(service.revokeAdminLink(admin.token)).resolves.toEqual({ ok: true });
    await expect(service.revokeAdminLink(admin.token)).resolves.toEqual({ ok: true });
    expect(
      await database.telegramLinkToken.count({
        where: { appointmentId: appointment.id, usedAt: null, revokedAt: null },
      }),
    ).toBe(1);
  });

  it("revokes pending links without consuming quota or disabling existing connections", async () => {
    const appointment = await fixture.appointment();
    const admin = await fixture.admin();
    const service = createLinkService(database);
    expect((await service.issueAppointmentLink(appointment.token)).ok).toBe(true);
    expect((await service.issueAdminLink(admin.token)).ok).toBe(true);
    const clientConnection = await fixture.clientConnection(appointment.id);
    const adminConnection = await fixture.adminConnection(admin.id);
    const limitsBefore = await database.publicRateLimit.findMany({ orderBy: { key: "asc" } });

    await expect(service.revokeAppointmentLink(appointment.token)).resolves.toEqual({ ok: true });
    await expect(service.revokeAdminLink(admin.token)).resolves.toEqual({ ok: true });
    expect(await database.publicRateLimit.findMany({ orderBy: { key: "asc" } })).toEqual(
      limitsBefore,
    );
    expect(
      await database.appointmentTelegramConnection.findUniqueOrThrow({
        where: { id: clientConnection.id },
      }),
    ).toMatchObject({ disabledAt: null, disabledReason: null });
    expect(
      await database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: adminConnection.id },
      }),
    ).toMatchObject({ disabledAt: null, disabledReason: null });
  });

  it("does not disclose malformed or unknown cancellation credentials or create their rate keys", async () => {
    const service = createLinkService(database);
    await expect(service.issueAppointmentLink("malformed-canary")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    await expect(
      service.issueAppointmentLink(prepareBookingAttempt().cancellationToken),
    ).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await database.publicRateLimit.count()).toBe(0);
    expect(await database.telegramLinkToken.count()).toBe(0);
  });

  it.each(["CANCELLED", "COMPLETED", "NO_SHOW"] as const)(
    "rejects %s appointments without consuming quota",
    async (status) => {
      const appointment = await fixture.appointment({ status });
      await expect(
        createLinkService(database).issueAppointmentLink(appointment.token),
      ).resolves.toEqual({ ok: false, code: "APPOINTMENT_NOT_ELIGIBLE" });
      expect(await database.publicRateLimit.count()).toBe(0);
    },
  );

  it("uses a strict startsAt > clock_timestamp() check for equal/past DB time", async () => {
    const appointment = await fixture.appointment();
    await database.$executeRaw`
      UPDATE appointments SET starts_at = clock_timestamp(), ends_at = clock_timestamp() + interval '30 minutes'
      WHERE id = ${appointment.id}::uuid
    `;
    await expect(
      createLinkService(database).issueAppointmentLink(appointment.token),
    ).resolves.toEqual({ ok: false, code: "APPOINTMENT_NOT_ELIGIBLE" });
    await database.appointment.update({
      where: { id: appointment.id },
      data: {
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      createLinkService(database).issueAppointmentLink(appointment.token),
    ).resolves.toEqual({ ok: false, code: "APPOINTMENT_NOT_ELIGIBLE" });
  });

  it("blocks active connections but ignores disabled historical connections", async () => {
    const appointment = await fixture.appointment();
    const active = await fixture.clientConnection(appointment.id);
    await expect(
      createLinkService(database).issueAppointmentLink(appointment.token),
    ).resolves.toEqual({ ok: false, code: "ALREADY_CONNECTED" });
    await database.appointmentTelegramConnection.delete({ where: { id: active.id } });
    await fixture.clientConnection(appointment.id, false);
    expect((await createLinkService(database).issueAppointmentLink(appointment.token)).ok).toBe(
      true,
    );

    const admin = await fixture.admin();
    const activeAdmin = await fixture.adminConnection(admin.id);
    await expect(createLinkService(database).issueAdminLink(admin.token)).resolves.toEqual({
      ok: false,
      code: "ALREADY_CONNECTED",
    });
    await database.adminTelegramConnection.delete({ where: { id: activeAdmin.id } });
    await fixture.adminConnection(admin.id, false);
    expect((await createLinkService(database).issueAdminLink(admin.token)).ok).toBe(true);
  });

  it("fails closed for disabled, stale and safe-error readiness states", async () => {
    const appointment = await fixture.appointment();
    const disabled = new TelegramLinkService(
      database,
      new TelegramLinkRepository(database, { kind: "DISABLED" }),
    );
    await expect(disabled.issueAppointmentLink(appointment.token)).resolves.toEqual({
      ok: false,
      code: "TELEGRAM_NOT_READY",
    });
    const invalid = new TelegramLinkService(
      database,
      new TelegramLinkRepository(database, {
        kind: "INVALID",
        reasonCode: "BOT_USERNAME_INVALID",
      }),
    );
    await expect(invalid.issueAppointmentLink(appointment.token)).resolves.toEqual({
      ok: false,
      code: "TELEGRAM_NOT_READY",
    });
    for (const change of [
      {
        lastVerifiedAt: new Date(Date.now() - TELEGRAM_POLICY.readinessFreshnessMs - 1_000),
      },
      { lastPollAt: new Date(Date.now() - TELEGRAM_POLICY.readinessFreshnessMs - 1_000) },
      { lastErrorCode: "WEBHOOK_ACTIVE" as const },
      { lastErrorCode: "CONFIG_UNAUTHORIZED" as const },
      { botUsername: "different_bot" },
    ]) {
      await fixture.readyBot();
      await database.telegramBotState.update({ where: { id: 1 }, data: change });
      await expect(
        createLinkService(database).issueAppointmentLink(appointment.token),
      ).resolves.toEqual({ ok: false, code: "TELEGRAM_NOT_READY" });
    }
    expect(await database.telegramLinkToken.count()).toBe(0);
    expect(await database.publicRateLimit.count()).toBe(0);
  });

  it("authorizes admin links only through the current active session and active account", async () => {
    const service = createLinkService(database);
    for (const input of [
      { session: "EXPIRED" as const },
      { session: "REVOKED" as const },
      { isActive: false },
    ]) {
      const admin = await fixture.admin(input);
      await expect(service.issueAdminLink(admin.token)).resolves.toEqual({
        ok: false,
        code: "UNAUTHORIZED",
      });
      await expect(service.revokeAdminLink(admin.token)).resolves.toEqual({
        ok: false,
        code: "UNAUTHORIZED",
      });
    }
    expect(await database.telegramLinkToken.count()).toBe(0);
  });

  it("enforces five target attempts, saturates denied hits and resets at the exact 15 minute boundary", async () => {
    const appointment = await fixture.appointment();
    const service = createLinkService(database);
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await service.issueAppointmentLink(appointment.token)).ok).toBe(true);
    await expect(service.issueAppointmentLink(appointment.token)).resolves.toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
    await expect(service.issueAppointmentLink(appointment.token)).resolves.toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
    const key = telegramLinkTargetRateLimitKey("APPOINTMENT", appointment.id);
    expect(await database.publicRateLimit.findUniqueOrThrow({ where: { key } })).toMatchObject({
      hits: TELEGRAM_POLICY.linkIssuance.maxAttemptsPerTarget + 1,
    });
    await database.$executeRaw`
      UPDATE public_rate_limits SET expires_at = clock_timestamp()
      WHERE key IN (${key}, 'telegram-link:installation:v1')
    `;
    expect((await service.issueAppointmentLink(appointment.token)).ok).toBe(true);
    expect(await database.publicRateLimit.findUniqueOrThrow({ where: { key } })).toMatchObject({
      hits: 1,
    });
  });
});
