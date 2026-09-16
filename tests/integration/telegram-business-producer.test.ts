import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Prisma } from "../../src/generated/prisma/client";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import { createBookingSchema } from "../../src/modules/booking/domain/booking-input";
import { createAdminBookingService } from "../../src/modules/booking/server/admin-booking-service";
import {
  hashBookingRequest,
  prepareBookingAttempt,
} from "../../src/modules/booking/server/booking-security";
import { createBookingInTransaction } from "../../src/modules/booking/server/booking-engine";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import { buildAdminAppointmentCreatedDedupeKey } from "../../src/modules/telegram/domain/dedupe";
import { parseTelegramPayloadV1 } from "../../src/modules/telegram/domain/payload-v1";
import { produceAdminAppointmentCreated } from "../../src/modules/telegram/server/business-producer";
import { businessContextHash } from "../../src/modules/settings/server/context";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const database = createPrismaClient(connectionString);
const secondDatabase = createPrismaClient(connectionString);
const clock = { now: () => new Date("2026-10-01T00:00:00.000Z") };
const publicBooking = createBookingService(database, clock);
const secondPublicBooking = createBookingService(secondDatabase, clock);
const adminBooking = createAdminBookingService(database, clock);
const suiteId = randomUUID();
const serviceIds: string[] = [];
const masterIds: string[] = [];
const adminIds: string[] = [];
const requestKeys: string[] = [];
let externalId = BigInt("0x" + suiteId.replaceAll("-", "").slice(0, 12));
let originalSettings: Awaited<ReturnType<typeof database.businessSettings.findUnique>>;

function nextExternal() {
  externalId += 11n;
  return externalId;
}

async function fixture() {
  const service = await database.service.create({
    data: {
      name: `Producer service ${suiteId}`,
      priceKopecks: 123_400,
      durationMinutes: 35,
    },
  });
  serviceIds.push(service.id);
  const master = await database.master.create({
    data: {
      name: `Producer master ${suiteId}`,
      services: { create: { serviceId: service.id } },
      weeklyWorkIntervals: {
        create: {
          dayOfWeek: 1,
          startsAt: new Date("1970-01-01T09:00:00.000Z"),
          endsAt: new Date("1970-01-01T18:00:00.000Z"),
        },
      },
    },
  });
  masterIds.push(master.id);
  return {
    service,
    master,
    context: businessContextHash(
      await database.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
    ),
  };
}

function bookingInput(data: Awaited<ReturnType<typeof fixture>>) {
  const attempt = prepareBookingAttempt();
  requestKeys.push(attempt.idempotencyKey);
  return {
    ...attempt,
    serviceId: data.service.id,
    expectedServiceTerms: publicServiceTerms(data.service).termsHash,
    expectedBusinessContext: data.context,
    master: { type: "SPECIFIC" as const, masterId: data.master.id },
    localDate: "2026-10-05",
    startsAt: "2026-10-05T10:00:00+03:00",
    clientName: "PII_CLIENT_NAME_CANARY",
    clientPhone: "+79990000000",
  };
}

async function admin(input: { active?: boolean; connected?: boolean; disabled?: boolean } = {}) {
  const row = await database.adminUser.create({
    data: {
      login: `producer-${randomUUID()}@example.test`,
      passwordHash: "PRODUCER_PASSWORD_HASH_CANARY",
      isActive: input.active ?? true,
    },
  });
  adminIds.push(row.id);
  const connection =
    input.connected === false
      ? null
      : await database.adminTelegramConnection.create({
          data: {
            adminUserId: row.id,
            telegramUserId: nextExternal(),
            telegramChatId: nextExternal(),
            sourceUpdateId: nextExternal(),
            connectedAt: new Date("2026-09-16T00:00:00.000Z"),
            disabledAt: input.disabled ? new Date("2026-09-16T01:00:00.000Z") : null,
            disabledReason: input.disabled ? "USER_DISCONNECTED" : null,
          },
        });
  return { admin: row, connection };
}

async function session(adminId: string) {
  const token = prepareBookingAttempt().cancellationToken;
  await database.adminSession.create({
    data: {
      adminId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  return token;
}

function successful<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error("Expected a successful booking");
  return result as Extract<T, { ok: true }>;
}

function failOutboxCreateMany(tx: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property) {
      if (property !== "notificationOutbox") return Reflect.get(target, property);
      return new Proxy(target.notificationOutbox, {
        get(delegate, delegateProperty) {
          if (delegateProperty !== "createMany") return Reflect.get(delegate, delegateProperty);
          return () => Promise.reject(new Error("PRODUCER_INSERT_FAILURE_CANARY"));
        },
      });
    },
  }) as Prisma.TransactionClient;
}

async function cleanupRows() {
  await database.notificationOutbox.deleteMany({
    where: {
      OR: [
        { appointment: { serviceId: { in: serviceIds } } },
        { adminConnection: { adminUserId: { in: adminIds } } },
      ],
    },
  });
  await database.adminTelegramConnection.deleteMany({
    where: { adminUserId: { in: adminIds } },
  });
  await database.adminSession.deleteMany({ where: { adminId: { in: adminIds } } });
  await database.appointment.deleteMany({ where: { serviceId: { in: serviceIds } } });
  await database.bookingRequest.deleteMany({ where: { idempotencyKey: { in: requestKeys } } });
  await database.master.deleteMany({ where: { id: { in: masterIds } } });
  await database.service.deleteMany({ where: { id: { in: serviceIds } } });
  await database.adminUser.deleteMany({ where: { id: { in: adminIds } } });
  serviceIds.length = 0;
  masterIds.length = 0;
  adminIds.length = 0;
  requestKeys.length = 0;
}

describe("ADMIN_APPOINTMENT_CREATED transactional producer", () => {
  beforeAll(async () => {
    originalSettings = await database.businessSettings.findUnique({ where: { id: 1 } });
    await database.businessSettings.upsert({
      where: { id: 1 },
      update: { timezone: "Europe/Moscow", bookingHorizonDays: 30 },
      create: {
        id: 1,
        businessName: `Producer integration ${suiteId}`,
        timezone: "Europe/Moscow",
        bookingHorizonDays: 30,
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupRows();
  });

  afterAll(async () => {
    try {
      await cleanupRows();
      if (originalSettings) {
        await database.businessSettings.update({
          where: { id: 1 },
          data: {
            businessName: originalSettings.businessName,
            timezone: originalSettings.timezone,
            bookingHorizonDays: originalSettings.bookingHorizonDays,
          },
        });
      }
    } finally {
      await Promise.all([database.$disconnect(), secondDatabase.$disconnect()]);
    }
  });

  it("fans a public creation out only to active connections with exact validated payloads", async () => {
    const data = await fixture();
    const first = await admin({ disabled: true });
    const firstActiveConnection = await database.adminTelegramConnection.create({
      data: {
        adminUserId: first.admin.id,
        telegramUserId: nextExternal(),
        telegramChatId: nextExternal(),
        sourceUpdateId: nextExternal(),
        connectedAt: new Date("2026-09-16T02:00:00.000Z"),
      },
    });
    const second = await admin();
    await admin({ active: false });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const input = bookingInput(data);

    const result = successful(await publicBooking.createBooking(input));
    const replay = successful(await publicBooking.createBooking(input));
    expect(result.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, confirmation: { id: result.confirmation.id } });
    expect(fetchSpy).not.toHaveBeenCalled();

    const appointment = await database.appointment.findUniqueOrThrow({
      where: { id: result.confirmation.id },
      include: { master: true },
    });
    const jobs = await database.notificationOutbox.findMany({
      where: { appointmentId: appointment.id, type: "ADMIN_APPOINTMENT_CREATED" },
      orderBy: { adminConnectionId: "asc" },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.map(({ adminConnectionId }) => adminConnectionId).sort()).toEqual(
      [firstActiveConnection.id, second.connection!.id].sort(),
    );
    expect(new Set(jobs.map(({ scheduledAt }) => scheduledAt.toISOString())).size).toBe(1);
    for (const job of jobs) {
      expect(job).toMatchObject({
        recipientKind: "ADMIN_CONNECTION",
        appointmentId: appointment.id,
        appointmentConnectionId: null,
        directChatId: null,
        status: "PENDING",
        expiresAt: null,
        attempts: 0,
        leaseToken: null,
        invalidatedAt: null,
        payloadVersion: 1,
      });
      expect(job.nextAttemptAt).toEqual(job.scheduledAt);
      expect(job.dedupeKey).toBe(
        buildAdminAppointmentCreatedDedupeKey({
          appointmentId: appointment.id,
          version: appointment.version,
          adminConnectionId: job.adminConnectionId!,
        }),
      );
      const parsed = parseTelegramPayloadV1({
        notificationType: "ADMIN_APPOINTMENT_CREATED",
        payloadVersion: job.payloadVersion,
        payload: job.payload,
      });
      expect(parsed).toMatchObject({
        ok: true,
        payload: {
          source: "PUBLIC",
          appointmentVersion: appointment.version,
          occurredAt: job.scheduledAt.toISOString(),
          visit: {
            serviceId: data.service.id,
            masterId: data.master.id,
            startsAt: appointment.startsAt.toISOString(),
            endsAt: appointment.endsAt.toISOString(),
            durationMinutes: 35,
            businessTimeZone: "Europe/Moscow",
            serviceName: data.service.name,
            masterName: data.master.name,
          },
        },
      });
      expect(JSON.stringify(job.payload)).not.toMatch(
        /PII_CLIENT_NAME_CANARY|79990000000|clientName|clientPhone|price|token|chat/i,
      );
    }
  });

  it("creates no job when no active administrative connection exists", async () => {
    const data = await fixture();
    await admin({ active: false });
    await admin({ disabled: true });
    const result = successful(await publicBooking.createBooking(bookingInput(data)));
    expect(
      await database.notificationOutbox.count({ where: { appointmentId: result.confirmation.id } }),
    ).toBe(0);
  });

  it("fans an administrative creation out to the author and other active admins without replay", async () => {
    const data = await fixture();
    const author = await admin();
    const other = await admin();
    await admin({ active: false });
    const token = await session(author.admin.id);
    const input = { ...bookingInput(data), confirmed: true as const };
    const result = successful(await adminBooking.createBooking(token, input));
    expect(successful(await adminBooking.createBooking(token, input)).replayed).toBe(true);

    const jobs = await database.notificationOutbox.findMany({
      where: { appointmentId: result.confirmation.id, type: "ADMIN_APPOINTMENT_CREATED" },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.map(({ adminConnectionId }) => adminConnectionId).sort()).toEqual(
      [author.connection!.id, other.connection!.id].sort(),
    );
    for (const job of jobs) {
      expect(
        parseTelegramPayloadV1({
          notificationType: "ADMIN_APPOINTMENT_CREATED",
          payloadVersion: job.payloadVersion,
          payload: job.payload,
        }),
      ).toMatchObject({ ok: true, payload: { source: "ADMIN" } });
    }
  });

  it("keeps one appointment and one fan-out for parallel identical idempotency requests", async () => {
    const data = await fixture();
    await admin();
    await admin();
    const input = bookingInput(data);
    const results = await Promise.all([
      publicBooking.createBooking(input),
      secondPublicBooking.createBooking(input),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const appointment = await database.appointment.findFirstOrThrow({
      where: { bookingRequest: { idempotencyKey: input.idempotencyKey } },
    });
    expect(
      await database.appointment.count({
        where: { bookingRequest: { idempotencyKey: input.idempotencyKey } },
      }),
    ).toBe(1);
    expect(
      await database.notificationOutbox.count({
        where: { appointmentId: appointment.id, type: "ADMIN_APPOINTMENT_CREATED" },
      }),
    ).toBe(2);
  });

  it("rolls BookingRequest, Appointment, history and outbox back when producer insertion fails", async () => {
    const data = await fixture();
    await admin();
    const input = bookingInput(data);
    const parsed = createBookingSchema.parse(input);
    await expect(
      database.$transaction(
        (tx) =>
          createBookingInTransaction({
            tx: failOutboxCreateMany(tx),
            booking: parsed,
            requestHash: hashBookingRequest(parsed),
            source: "ONLINE",
            changedBy: "CLIENT",
            clock,
          }),
        { isolationLevel: "Serializable" },
      ),
    ).rejects.toThrow("PRODUCER_INSERT_FAILURE_CANARY");
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);
    expect(await database.appointment.count({ where: { serviceId: data.service.id } })).toBe(0);
    expect(
      await database.appointmentStatusHistory.count({
        where: { appointment: { serviceId: data.service.id } },
      }),
    ).toBe(0);
    expect(
      await database.notificationOutbox.count({
        where: { appointment: { serviceId: data.service.id } },
      }),
    ).toBe(0);
  });

  it("lets a duplicate dedupe key abort the whole createMany without partial fan-out", async () => {
    const data = await fixture();
    const result = successful(await publicBooking.createBooking(bookingInput(data)));
    const first = await admin();
    const second = await admin();
    const appointment = await database.appointment.findUniqueOrThrow({
      where: { id: result.confirmation.id },
      include: { master: true },
    });
    const settings = await database.businessSettings.findUniqueOrThrow({ where: { id: 1 } });
    const payload = {
      source: "PUBLIC" as const,
      appointmentVersion: appointment.version,
      occurredAt: "2026-09-16T00:00:00.000Z",
      visit: {
        serviceId: appointment.serviceId,
        masterId: appointment.masterId,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        durationMinutes: appointment.serviceDurationSnapshot,
        businessTimeZone: settings.timezone,
        serviceName: appointment.serviceNameSnapshot,
        masterName: appointment.master.name,
      },
    };
    await database.notificationOutbox.create({
      data: {
        recipientKind: "ADMIN_CONNECTION",
        appointmentId: appointment.id,
        adminConnectionId: first.connection!.id,
        type: "ADMIN_APPOINTMENT_CREATED",
        scheduledAt: new Date(payload.occurredAt),
        nextAttemptAt: new Date(payload.occurredAt),
        payload,
        dedupeKey: buildAdminAppointmentCreatedDedupeKey({
          appointmentId: appointment.id,
          version: appointment.version,
          adminConnectionId: first.connection!.id,
        }),
      },
    });

    await expect(
      database.$transaction((tx) =>
        produceAdminAppointmentCreated(tx, {
          source: appointment.source,
          appointment: {
            id: appointment.id,
            version: appointment.version,
            serviceId: appointment.serviceId,
            masterId: appointment.masterId,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            durationMinutes: appointment.serviceDurationSnapshot,
            businessTimeZone: settings.timezone,
            serviceName: appointment.serviceNameSnapshot,
            masterName: appointment.master.name,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await database.notificationOutbox.count({
        where: { appointmentId: appointment.id, type: "ADMIN_APPOINTMENT_CREATED" },
      }),
    ).toBe(1);
    expect(
      await database.notificationOutbox.count({
        where: { appointmentId: appointment.id, adminConnectionId: second.connection!.id },
      }),
    ).toBe(0);
  });
});
