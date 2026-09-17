import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeEach, expect, it } from "vitest";

import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import {
  hashBookingToken,
  prepareBookingAttempt,
} from "../../src/modules/booking/server/booking-security";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import { businessContextHash } from "../../src/modules/settings/server/context";
import {
  buildAdminAppointmentCancelledDedupeKey,
  buildClientAppointmentCancelledDedupeKey,
} from "../../src/modules/telegram/domain/dedupe";
import { parseTelegramPayloadV1 } from "../../src/modules/telegram/domain/payload-v1";
import { createAppointmentsBoundary } from "../../src/server/admin/appointments-boundary";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/zaprosto_test_[a-f0-9]+$/.test(new URL(url).pathname)) {
  throw new Error("Use isolated runner");
}

const database = createPrismaClient(url);
const concurrentDatabase = createPrismaClient(url);
const clientAppointments = createClientAppointmentService(database);
const concurrentClients = createClientAppointmentService(concurrentDatabase);
const adminAppointments = createAppointmentsBoundary(database);
const STARTS_AT = new Date("2026-01-15T07:00:00.000Z");
let externalId = 9_000_000n;
let serviceId: string;
let masterId: string;

function nextExternalId() {
  externalId += 1n;
  return externalId;
}

function headers() {
  return new Headers({ origin: process.env.PUBLIC_ORIGIN ?? "http://localhost:3000" });
}

async function clear() {
  await database.notificationOutbox.deleteMany();
  await database.appointmentTelegramConnection.deleteMany();
  await database.adminTelegramConnection.deleteMany();
  await database.appointment.deleteMany();
  await database.bookingRequest.deleteMany();
  await database.adminSession.deleteMany();
  await database.adminUser.deleteMany();
  await database.master.deleteMany();
  await database.service.deleteMany();
}

beforeEach(async () => {
  await clear();
  await database.businessSettings.upsert({
    where: { id: 1 },
    create: { id: 1, businessName: "Cancellation producer", timezone: "Europe/Moscow" },
    update: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  serviceId = (
    await database.service.create({
      data: { name: "Snapshot service", priceKopecks: 123_400, durationMinutes: 35 },
    })
  ).id;
  masterId = (
    await database.master.create({
      data: { name: "Snapshot master", services: { create: { serviceId } } },
    })
  ).id;
});

afterAll(async () => {
  await clear();
  await Promise.all([database.$disconnect(), concurrentDatabase.$disconnect()]);
});

async function appointment() {
  const secret = prepareBookingAttempt();
  const row = await database.appointment.create({
    data: {
      bookingRequest: { create: { idempotencyKey: secret.idempotencyKey } },
      master: { connect: { id: masterId } },
      service: { connect: { id: serviceId } },
      startsAt: STARTS_AT,
      endsAt: new Date(STARTS_AT.getTime() + 35 * 60_000),
      clientName: "PII_CLIENT_NAME_CANARY",
      clientPhone: "+79990000000",
      source: "ONLINE",
      masterSelection: "SPECIFIC",
      serviceNameSnapshot: "Snapshot service",
      servicePriceSnapshot: 123_400,
      serviceDurationSnapshot: 35,
      cancellationTokenHash: hashBookingToken(secret.cancellationToken),
      statusHistory: {
        create: { previousStatus: null, newStatus: "SCHEDULED", changedBy: "CLIENT" },
      },
    },
  });
  return { ...row, token: secret.cancellationToken };
}

async function admin(input: { active?: boolean; disabled?: boolean; session?: boolean } = {}) {
  const token = randomBytes(32).toString("base64url");
  const row = await database.adminUser.create({
    data: {
      login: `cancel-${randomUUID()}@example.test`,
      passwordHash: "PASSWORD_HASH_CANARY",
      isActive: input.active ?? true,
      ...(input.session
        ? {
            sessions: {
              create: {
                tokenHash: hashSessionToken(token),
                expiresAt: new Date("2099-01-01T00:00:00.000Z"),
              },
            },
          }
        : {}),
    },
  });
  const connection = await database.adminTelegramConnection.create({
    data: {
      adminUserId: row.id,
      telegramUserId: nextExternalId(),
      telegramChatId: nextExternalId(),
      sourceUpdateId: nextExternalId(),
      connectedAt: new Date("2026-01-01T00:00:00.000Z"),
      disabledAt: input.disabled ? new Date("2026-01-02T00:00:00.000Z") : null,
      disabledReason: input.disabled ? "USER_DISCONNECTED" : null,
    },
  });
  return { row, connection, token };
}

async function clientConnection(appointmentId: string, disabled = false) {
  return database.appointmentTelegramConnection.create({
    data: {
      appointmentId,
      telegramUserId: nextExternalId(),
      telegramChatId: nextExternalId(),
      sourceUpdateId: nextExternalId(),
      connectedAt: new Date("2026-01-01T00:00:00.000Z"),
      disabledAt: disabled ? new Date("2026-01-02T00:00:00.000Z") : null,
      disabledReason: disabled ? "USER_DISCONNECTED" : null,
    },
  });
}

async function reminder(input: {
  appointmentId: string;
  connectionId: string;
  status?: "PENDING" | "PROCESSING";
}) {
  const now = new Date();
  return database.notificationOutbox.create({
    data: {
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: input.appointmentId,
      appointmentConnectionId: input.connectionId,
      type: "CLIENT_APPOINTMENT_REMINDER",
      status: input.status ?? "PENDING",
      scheduledAt: now,
      nextAttemptAt: now,
      expiresAt: new Date(now.getTime() + 15 * 60_000),
      payload: {
        visitVersion: 0,
        expectedVisit: {
          serviceId,
          masterId,
          startsAt: STARTS_AT.toISOString(),
          endsAt: new Date(STARTS_AT.getTime() + 35 * 60_000).toISOString(),
          durationMinutes: 35,
        },
      },
      dedupeKey: `cancellation-reminder-${randomUUID()}`,
      ...(input.status === "PROCESSING"
        ? {
            attempts: 1,
            leaseToken: randomUUID(),
            leaseOwner: "cancellation-producer-test",
            claimedAt: now,
            leaseExpiresAt: new Date(now.getTime() + 60_000),
          }
        : {}),
    },
  });
}

async function changeInput(id: string, status: "CANCELLED" | "COMPLETED" | "NO_SHOW") {
  const settings = await database.businessSettings.findUniqueOrThrow({ where: { id: 1 } });
  const row = await database.appointment.findUniqueOrThrow({ where: { id } });
  return {
    id,
    status,
    version: row.version,
    expectedBusinessContext: businessContextHash(settings),
    confirmed: true,
  };
}

it("client cancellation atomically invalidates reminders and fans out only to active admins", async () => {
  const visit = await appointment();
  const first = await admin();
  const second = await admin();
  await admin({ active: false });
  await admin({ disabled: true });
  const client = await clientConnection(visit.id);
  const pending = await reminder({ appointmentId: visit.id, connectionId: client.id });
  const processing = await reminder({
    appointmentId: visit.id,
    connectionId: client.id,
    status: "PROCESSING",
  });

  await expect(
    clientAppointments.cancelBooking({ token: visit.token, confirmed: true, reason: "Private" }),
  ).resolves.toMatchObject({ ok: true, alreadyCancelled: false });

  const jobs = await database.notificationOutbox.findMany({
    where: { appointmentId: visit.id, type: "ADMIN_APPOINTMENT_CANCELLED" },
    orderBy: { adminConnectionId: "asc" },
  });
  expect(jobs).toHaveLength(2);
  expect(jobs.map((job) => job.adminConnectionId).sort()).toEqual(
    [first.connection.id, second.connection.id].sort(),
  );
  expect(
    await database.notificationOutbox.count({
      where: { appointmentId: visit.id, type: "CLIENT_APPOINTMENT_CANCELLED" },
    }),
  ).toBe(0);
  for (const job of jobs) {
    expect(job.dedupeKey).toBe(
      buildAdminAppointmentCancelledDedupeKey({
        appointmentId: visit.id,
        version: 1,
        adminConnectionId: job.adminConnectionId!,
      }),
    );
    expect(
      parseTelegramPayloadV1({
        notificationType: "ADMIN_APPOINTMENT_CANCELLED",
        payloadVersion: job.payloadVersion,
        payload: job.payload,
      }),
    ).toMatchObject({
      ok: true,
      payload: {
        actor: "CLIENT",
        appointmentVersion: 1,
        occurredAt: job.scheduledAt.toISOString(),
        visit: {
          serviceId,
          masterId,
          startsAt: STARTS_AT.toISOString(),
          durationMinutes: 35,
          businessTimeZone: "Europe/Moscow",
          serviceName: "Snapshot service",
          masterName: "Snapshot master",
        },
      },
    });
    expect(JSON.stringify(job.payload)).not.toMatch(
      /PII_CLIENT_NAME_CANARY|79990000000|Private|price|token|chat/i,
    );
  }
  await expect(
    database.notificationOutbox.findUniqueOrThrow({ where: { id: pending.id } }),
  ).resolves.toMatchObject({
    status: "CANCELLED",
    invalidationCode: "APPOINTMENT_CANCELLED",
    finishedAt: expect.any(Date),
  });
  await expect(
    database.notificationOutbox.findUniqueOrThrow({ where: { id: processing.id } }),
  ).resolves.toMatchObject({
    status: "PROCESSING",
    invalidationCode: "APPOINTMENT_CANCELLED",
    leaseToken: processing.leaseToken,
    leaseOwner: processing.leaseOwner,
    finishedAt: null,
  });

  await expect(
    clientAppointments.cancelBooking({ token: visit.token, confirmed: true, reason: "Replay" }),
  ).resolves.toMatchObject({ ok: true, alreadyCancelled: true });
  expect(
    await database.notificationOutbox.count({
      where: { appointmentId: visit.id, type: "ADMIN_APPOINTMENT_CANCELLED" },
    }),
  ).toBe(2);
});

it("admin cancellation includes its author and targets the one active client connection", async () => {
  const visit = await appointment();
  const author = await admin({ session: true });
  const other = await admin();
  await admin({ active: false });
  await admin({ disabled: true });
  const disabledClient = await clientConnection(visit.id, true);
  const activeClient = await clientConnection(visit.id);
  const oldReminder = await reminder({ appointmentId: visit.id, connectionId: activeClient.id });

  await expect(
    adminAppointments.change(headers(), author.token, await changeInput(visit.id, "CANCELLED")),
  ).resolves.toEqual({ ok: true, status: "CANCELLED" });

  const adminJobs = await database.notificationOutbox.findMany({
    where: { appointmentId: visit.id, type: "ADMIN_APPOINTMENT_CANCELLED" },
  });
  expect(adminJobs).toHaveLength(2);
  expect(adminJobs.map((job) => job.adminConnectionId).sort()).toEqual(
    [author.connection.id, other.connection.id].sort(),
  );
  for (const job of adminJobs) {
    expect(
      parseTelegramPayloadV1({
        notificationType: "ADMIN_APPOINTMENT_CANCELLED",
        payloadVersion: job.payloadVersion,
        payload: job.payload,
      }),
    ).toMatchObject({ ok: true, payload: { actor: "ADMIN", appointmentVersion: 1 } });
  }
  const clientJobs = await database.notificationOutbox.findMany({
    where: { appointmentId: visit.id, type: "CLIENT_APPOINTMENT_CANCELLED" },
  });
  expect(clientJobs).toHaveLength(1);
  expect(clientJobs[0]).toMatchObject({
    recipientKind: "APPOINTMENT_CONNECTION",
    appointmentConnectionId: activeClient.id,
    adminConnectionId: null,
    scheduledAt: clientJobs[0]!.nextAttemptAt,
  });
  expect(clientJobs[0]!.appointmentConnectionId).not.toBe(disabledClient.id);
  expect(clientJobs[0]!.dedupeKey).toBe(
    buildClientAppointmentCancelledDedupeKey({
      appointmentId: visit.id,
      version: 1,
      appointmentConnectionId: activeClient.id,
    }),
  );
  expect(
    parseTelegramPayloadV1({
      notificationType: "CLIENT_APPOINTMENT_CANCELLED",
      payloadVersion: clientJobs[0]!.payloadVersion,
      payload: clientJobs[0]!.payload,
    }),
  ).toMatchObject({ ok: true, payload: { actor: "ADMIN", appointmentVersion: 1 } });
  await expect(
    database.notificationOutbox.findUniqueOrThrow({ where: { id: oldReminder.id } }),
  ).resolves.toMatchObject({
    status: "CANCELLED",
    invalidationCode: "APPOINTMENT_CANCELLED",
  });
  expect(
    new Set([...adminJobs, ...clientJobs].map((job) => job.scheduledAt.toISOString())).size,
  ).toBe(1);
});

it.each([
  ["COMPLETED", "APPOINTMENT_COMPLETED"],
  ["NO_SHOW", "APPOINTMENT_NO_SHOW"],
] as const)(
  "%s invalidates only the reminder with the first terminal code",
  async (status, code) => {
    const visit = await appointment();
    const author = await admin({ session: true });
    const client = await clientConnection(visit.id);
    const oldReminder = await reminder({ appointmentId: visit.id, connectionId: client.id });

    await expect(
      adminAppointments.change(headers(), author.token, await changeInput(visit.id, status)),
    ).resolves.toEqual({ ok: true, status });
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: oldReminder.id } }),
    ).resolves.toMatchObject({
      status: "CANCELLED",
      invalidationCode: code,
    });
    const correction = status === "COMPLETED" ? "NO_SHOW" : "COMPLETED";
    await expect(
      adminAppointments.change(headers(), author.token, await changeInput(visit.id, correction)),
    ).resolves.toEqual({ ok: true, status: correction });
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: oldReminder.id } }),
    ).resolves.toMatchObject({ status: "CANCELLED", invalidationCode: code });
    expect(
      await database.notificationOutbox.count({
        where: {
          appointmentId: visit.id,
          type: { in: ["ADMIN_APPOINTMENT_CANCELLED", "CLIENT_APPOINTMENT_CANCELLED"] },
        },
      }),
    ).toBe(0);
  },
);

it("duplicate cancellation dedupe rolls back appointment, history, invalidation and partial fan-out", async () => {
  const visit = await appointment();
  const author = await admin({ session: true });
  const other = await admin();
  const client = await clientConnection(visit.id);
  const oldReminder = await reminder({ appointmentId: visit.id, connectionId: client.id });
  const occurredAt = new Date("2026-01-01T00:00:00.000Z");
  await database.notificationOutbox.create({
    data: {
      recipientKind: "ADMIN_CONNECTION",
      appointmentId: visit.id,
      adminConnectionId: author.connection.id,
      type: "ADMIN_APPOINTMENT_CANCELLED",
      scheduledAt: occurredAt,
      nextAttemptAt: occurredAt,
      payload: {
        actor: "ADMIN",
        appointmentVersion: 1,
        occurredAt: occurredAt.toISOString(),
        visit: {
          serviceId,
          masterId,
          startsAt: STARTS_AT.toISOString(),
          endsAt: new Date(STARTS_AT.getTime() + 35 * 60_000).toISOString(),
          durationMinutes: 35,
          businessTimeZone: "Europe/Moscow",
          serviceName: "Snapshot service",
          masterName: "Snapshot master",
        },
      },
      dedupeKey: buildAdminAppointmentCancelledDedupeKey({
        appointmentId: visit.id,
        version: 1,
        adminConnectionId: author.connection.id,
      }),
    },
  });

  await expect(
    adminAppointments.change(headers(), author.token, await changeInput(visit.id, "CANCELLED")),
  ).resolves.toMatchObject({ ok: false, code: "UNAVAILABLE" });
  await expect(
    database.appointment.findUniqueOrThrow({ where: { id: visit.id } }),
  ).resolves.toMatchObject({
    status: "SCHEDULED",
    version: 0,
    cancelledAt: null,
  });
  expect(
    await database.appointmentStatusHistory.count({ where: { appointmentId: visit.id } }),
  ).toBe(1);
  await expect(
    database.notificationOutbox.findUniqueOrThrow({ where: { id: oldReminder.id } }),
  ).resolves.toMatchObject({
    status: "PENDING",
    invalidationCode: null,
  });
  expect(
    await database.notificationOutbox.count({
      where: { appointmentId: visit.id, adminConnectionId: other.connection.id },
    }),
  ).toBe(0);
  expect(
    await database.notificationOutbox.count({
      where: { appointmentId: visit.id, type: "CLIENT_APPOINTMENT_CANCELLED" },
    }),
  ).toBe(0);
});

it("contact-only edit leaves reminders and Telegram jobs untouched", async () => {
  const visit = await appointment();
  const author = await admin({ session: true });
  const client = await clientConnection(visit.id);
  const oldReminder = await reminder({ appointmentId: visit.id, connectionId: client.id });

  await expect(
    adminAppointments.updateContacts(headers(), author.token, {
      id: visit.id,
      version: 0,
      clientName: "Corrected client",
      clientPhone: "+79991112233",
    }),
  ).resolves.toEqual({ ok: true });
  await expect(
    database.notificationOutbox.findUniqueOrThrow({ where: { id: oldReminder.id } }),
  ).resolves.toMatchObject({ status: "PENDING", invalidatedAt: null, invalidationCode: null });
  expect(
    await database.notificationOutbox.count({
      where: {
        appointmentId: visit.id,
        type: { in: ["ADMIN_APPOINTMENT_CANCELLED", "CLIENT_APPOINTMENT_CANCELLED"] },
      },
    }),
  ).toBe(0);
});

it("parallel client cancellations leave one transition and one fan-out", async () => {
  const visit = await appointment();
  await admin();
  await admin();
  const client = await clientConnection(visit.id);
  await reminder({ appointmentId: visit.id, connectionId: client.id });

  const results = await Promise.all([
    clientAppointments.cancelBooking({ token: visit.token, confirmed: true }),
    concurrentClients.cancelBooking({ token: visit.token, confirmed: true }),
  ]);
  expect(results.filter((result) => result.ok && !result.alreadyCancelled)).toHaveLength(1);
  expect(results.filter((result) => result.ok && result.alreadyCancelled)).toHaveLength(1);
  expect(
    await database.appointmentStatusHistory.count({ where: { appointmentId: visit.id } }),
  ).toBe(2);
  expect(
    await database.notificationOutbox.count({
      where: { appointmentId: visit.id, type: "ADMIN_APPOINTMENT_CANCELLED" },
    }),
  ).toBe(2);
});
