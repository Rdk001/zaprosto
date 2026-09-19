import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { NotificationType, Prisma } from "../../src/generated/prisma/client";
import { TelegramDeliveryPreflight } from "../../src/modules/telegram/server/delivery-preflight";
import { TelegramOutboxRepository } from "../../src/modules/telegram/server/outbox-repository";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createOutboxFixture, isolatedOutboxDatabaseUrl, owner } from "./telegram-outbox-fixture";

const connectionString = isolatedOutboxDatabaseUrl();
const database = createPrismaClient(connectionString);
const concurrentDatabase = createPrismaClient(connectionString);
const outbox = new TelegramOutboxRepository(database);
const preflight = new TelegramDeliveryPreflight(database);
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;
let originalSettings: {
  businessName: string;
  timezone: string;
  bookingHorizonDays: number;
  version: number;
} | null;

const databaseNow = async () => {
  const [row] = await database.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp()::timestamptz(3) AS now
  `;
  if (!row) throw new Error("Database clock unavailable");
  return row.now;
};

async function visitAtSchedule() {
  const scheduledAt = await databaseNow();
  const startsAt = new Date(scheduledAt.getTime() + 2 * 60 * 60_000);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  const appointment = await database.appointment.update({
    where: { id: fixture.appointmentId },
    data: {
      status: "SCHEDULED",
      startsAt,
      endsAt,
      serviceDurationSnapshot: 30,
    },
    include: { master: true },
  });
  const settings = await database.businessSettings.findUniqueOrThrow({ where: { id: 1 } });
  return {
    scheduledAt,
    startsAt,
    endsAt,
    appointment,
    snapshot: {
      serviceId: appointment.serviceId,
      masterId: appointment.masterId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      durationMinutes: 30,
      businessTimeZone: settings.timezone,
      serviceName: appointment.serviceNameSnapshot,
      masterName: appointment.master.name,
    },
  };
}

function payloadFor(
  type: NotificationType,
  data: Awaited<ReturnType<typeof visitAtSchedule>>,
): Prisma.InputJsonValue {
  switch (type) {
    case "ADMIN_APPOINTMENT_CREATED":
      return {
        source: "PUBLIC",
        appointmentVersion: 0,
        occurredAt: data.scheduledAt.toISOString(),
        visit: data.snapshot,
      };
    case "ADMIN_APPOINTMENT_CANCELLED":
      return {
        actor: "CLIENT",
        appointmentVersion: 1,
        occurredAt: data.scheduledAt.toISOString(),
        visit: data.snapshot,
      };
    case "CLIENT_APPOINTMENT_CANCELLED":
      return {
        actor: "ADMIN",
        appointmentVersion: 1,
        occurredAt: data.scheduledAt.toISOString(),
        visit: data.snapshot,
      };
    case "CLIENT_APPOINTMENT_CHANGED":
      return {
        appointmentVersion: 1,
        occurredAt: data.scheduledAt.toISOString(),
        changedFields: ["STARTS_AT"],
        before: {
          ...data.snapshot,
          startsAt: new Date(data.startsAt.getTime() - 30 * 60_000).toISOString(),
          endsAt: new Date(data.endsAt.getTime() - 30 * 60_000).toISOString(),
        },
        after: data.snapshot,
      };
    case "CLIENT_APPOINTMENT_REMINDER":
      return {
        visitVersion: 0,
        expectedVisit: {
          serviceId: data.snapshot.serviceId,
          masterId: data.snapshot.masterId,
          startsAt: data.snapshot.startsAt,
          endsAt: data.snapshot.endsAt,
          durationMinutes: data.snapshot.durationMinutes,
        },
      };
    default:
      return {};
  }
}

async function seedAndClaim(
  type: NotificationType,
  overrides: Partial<Prisma.NotificationOutboxUncheckedCreateInput> = {},
) {
  const data = await visitAtSchedule();
  const job = await fixture.seed({
    type,
    scheduledAt: data.scheduledAt,
    nextAttemptAt: data.scheduledAt,
    expiresAt:
      type === "CLIENT_APPOINTMENT_REMINDER" || type === "TELEGRAM_CONNECTION_REJECTED"
        ? new Date(
            data.scheduledAt.getTime() + (type === "CLIENT_APPOINTMENT_REMINDER" ? 15 : 5) * 60_000,
          )
        : null,
    payload: payloadFor(type, data),
    ...overrides,
  });
  const claimed = await outbox.claimDue({ capacity: 1, leaseOwner: owner() });
  const lease = claimed.find((candidate) => candidate.id === job.id);
  expect(lease).toBeDefined();
  return { data, job, lease: lease! };
}

async function check(jobId: string, leaseToken: string) {
  return preflight.check({ jobId, leaseToken });
}

describe("Telegram delivery preflight PostgreSQL boundary", () => {
  beforeAll(async () => {
    originalSettings = await database.businessSettings.findUnique({
      where: { id: 1 },
      select: {
        businessName: true,
        timezone: true,
        bookingHorizonDays: true,
        version: true,
      },
    });
    await database.businessSettings.upsert({
      where: { id: 1 },
      create: { id: 1, businessName: "Preflight fixture", timezone: "Europe/Moscow" },
      update: {
        businessName: "Preflight fixture",
        timezone: "Europe/Moscow",
        bookingHorizonDays: 30,
        version: 0,
      },
    });
    fixture = await createOutboxFixture(database);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanupJobs();
    await database.appointmentTelegramConnection.update({
      where: { id: fixture.clientConnectionId },
      data: { disabledAt: null, disabledReason: null },
    });
    const adminConnection = await database.adminTelegramConnection.update({
      where: { id: fixture.adminConnectionId },
      data: { disabledAt: null, disabledReason: null },
      select: { adminUserId: true },
    });
    await database.adminUser.update({
      where: { id: adminConnection.adminUserId },
      data: { isActive: true },
    });
  });

  afterAll(async () => {
    await fixture.cleanup();
    if (originalSettings) {
      await database.businessSettings.update({
        where: { id: 1 },
        data: originalSettings,
      });
    } else {
      await database.businessSettings.delete({ where: { id: 1 } });
    }
    await concurrentDatabase.$disconnect();
    await database.$disconnect();
  });

  it("returns READY for all eight types and uses each immutable job recipient", async () => {
    const cases = [
      ["ADMIN_APPOINTMENT_CREATED", fixture.externalId + 1n],
      ["ADMIN_APPOINTMENT_CANCELLED", fixture.externalId + 1n],
      ["CLIENT_APPOINTMENT_CANCELLED", fixture.externalId],
      ["CLIENT_APPOINTMENT_CHANGED", fixture.externalId],
      ["CLIENT_APPOINTMENT_REMINDER", fixture.externalId],
      ["CLIENT_CONNECTION_CONFIRMED", fixture.externalId],
      ["ADMIN_CONNECTION_CONFIRMED", fixture.externalId + 1n],
      ["TELEGRAM_CONNECTION_REJECTED", fixture.externalId + 2n],
    ] as const;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const [type, chatId] of cases) {
      const { job, lease } = await seedAndClaim(type);
      expect(await check(job.id, lease.leaseToken)).toMatchObject({
        kind: "READY",
        chatId,
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads disabled connections and inactive admins immediately before delivery", async () => {
    const client = await seedAndClaim("CLIENT_APPOINTMENT_CHANGED");
    await concurrentDatabase.appointmentTelegramConnection.update({
      where: { id: fixture.clientConnectionId },
      data: { disabledAt: await databaseNow(), disabledReason: "USER_DISCONNECTED" },
    });
    expect(await check(client.job.id, client.lease.leaseToken)).toEqual({
      kind: "SKIP",
      code: "CONNECTION_INACTIVE",
    });

    await fixture.cleanupJobs();
    await database.appointmentTelegramConnection.update({
      where: { id: fixture.clientConnectionId },
      data: { disabledAt: null, disabledReason: null },
    });
    const admin = await seedAndClaim("ADMIN_CONNECTION_CONFIRMED");
    const connection = await database.adminTelegramConnection.findUniqueOrThrow({
      where: { id: fixture.adminConnectionId },
    });
    await concurrentDatabase.adminUser.update({
      where: { id: connection.adminUserId },
      data: { isActive: false },
    });
    expect(await check(admin.job.id, admin.lease.leaseToken)).toEqual({
      kind: "SKIP",
      code: "CONNECTION_INACTIVE",
    });
  });

  it("supports direct rejection without reading a connection", async () => {
    const { job, lease } = await seedAndClaim("TELEGRAM_CONNECTION_REJECTED");
    expect(await check(job.id, lease.leaseToken)).toMatchObject({
      kind: "READY",
      chatId: fixture.externalId + 2n,
    });
  });

  it("maps payload version and strict payload failures to safe DEAD decisions", async () => {
    const version = await seedAndClaim("ADMIN_CONNECTION_CONFIRMED", { payloadVersion: 2 });
    expect(await check(version.job.id, version.lease.leaseToken)).toEqual({
      kind: "DEAD",
      code: "PAYLOAD_VERSION_UNSUPPORTED",
    });
    await fixture.cleanupJobs();
    const payload = await seedAndClaim("ADMIN_CONNECTION_CONFIRMED", {
      payload: { unsafe: "raw-canary" },
    });
    expect(await check(payload.job.id, payload.lease.leaseToken)).toEqual({
      kind: "DEAD",
      code: "RESPONSE_INVALID",
    });
  });

  it("returns LEASE_LOST for foreign and expired leases", async () => {
    const foreign = await seedAndClaim("ADMIN_CONNECTION_CONFIRMED");
    expect(await check(foreign.job.id, owner())).toEqual({ kind: "LEASE_LOST" });
    await database.notificationOutbox.update({
      where: { id: foreign.job.id },
      data: { leaseExpiresAt: new Date((await databaseNow()).getTime() - 1) },
    });
    expect(await check(foreign.job.id, foreign.lease.leaseToken)).toEqual({ kind: "LEASE_LOST" });
  });

  it("maps PROCESSING invalidation and does not mutate any outbox field", async () => {
    const { job, lease } = await seedAndClaim("CLIENT_APPOINTMENT_REMINDER");
    const invalidatedAt = await databaseNow();
    await database.notificationOutbox.update({
      where: { id: job.id },
      data: { invalidatedAt, invalidationCode: "VISIT_CHANGED" },
    });
    const before = await database.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } });
    expect(await check(job.id, lease.leaseToken)).toEqual({
      kind: "SKIP",
      code: "VISIT_MISMATCH",
    });
    const after = await database.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toEqual(before);
  });

  it("accepts a current reminder after contact-only version bump", async () => {
    const { job, lease } = await seedAndClaim("CLIENT_APPOINTMENT_REMINDER");
    await concurrentDatabase.appointment.update({
      where: { id: fixture.appointmentId },
      data: { clientPhone: "+79991111111", version: { increment: 1 } },
    });
    expect(await check(job.id, lease.leaseToken)).toMatchObject({ kind: "READY" });
  });

  it("classifies cancellation and reschedule before preflight", async () => {
    const cancelled = await seedAndClaim("CLIENT_APPOINTMENT_REMINDER");
    await concurrentDatabase.appointment.update({
      where: { id: fixture.appointmentId },
      data: { status: "CANCELLED" },
    });
    expect(await check(cancelled.job.id, cancelled.lease.leaseToken)).toEqual({
      kind: "SKIP",
      code: "APPOINTMENT_NOT_SCHEDULED",
    });

    await fixture.cleanupJobs();
    const moved = await seedAndClaim("CLIENT_APPOINTMENT_REMINDER");
    await concurrentDatabase.appointment.update({
      where: { id: fixture.appointmentId },
      data: { startsAt: new Date(moved.data.startsAt.getTime() + 60_000) },
    });
    expect(await check(moved.job.id, moved.lease.leaseToken)).toEqual({
      kind: "SKIP",
      code: "VISIT_MISMATCH",
    });
  });

  it("does not revive an invalidated reminder after moving back", async () => {
    const { data, job, lease } = await seedAndClaim("CLIENT_APPOINTMENT_REMINDER");
    await database.notificationOutbox.update({
      where: { id: job.id },
      data: { invalidatedAt: await databaseNow(), invalidationCode: "VISIT_CHANGED" },
    });
    await database.appointment.update({
      where: { id: fixture.appointmentId },
      data: { startsAt: data.startsAt, endsAt: data.endsAt },
    });
    expect(await check(job.id, lease.leaseToken)).toEqual({
      kind: "SKIP",
      code: "VISIT_MISMATCH",
    });
  });

  it("uses live timezone and public snapshot names without exposing private fields", async () => {
    const { job, lease } = await seedAndClaim("CLIENT_CONNECTION_CONFIRMED");
    const result = await check(job.id, lease.leaseToken);
    expect(result).toMatchObject({ kind: "READY" });
    if (result.kind === "READY") {
      expect(result.text).toContain("Outbox fixture service");
      expect(result.text).toContain("Outbox fixture master");
      expect(result.text).not.toContain("Outbox fixture client");
      expect(result.text).not.toContain("+79990000000");
    }
  });
});
