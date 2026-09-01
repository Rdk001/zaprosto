import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import {
  hashBookingToken,
  prepareBookingAttempt,
} from "../../src/modules/booking/server/booking-security";
import { createAdminBookingService } from "../../src/modules/booking/server/admin-booking-service";
import { SchedulingAvailabilityService } from "../../src/modules/scheduling/server/availability-service";
import { businessContextHash } from "../../src/modules/settings/server/context";
import { createAppointmentCreationBoundary } from "../../src/server/admin/appointment-creation-boundary";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for integration tests");

const database = createPrismaClient(connectionString);
const secondDatabase = createPrismaClient(connectionString);
const clock = { now: () => new Date("2026-10-01T00:00:00Z") };
const booking = createAdminBookingService(database, clock);
const secondBooking = createAdminBookingService(secondDatabase, clock);
const boundary = createAppointmentCreationBoundary({ database, booking, clock });
const secondBoundary = createAppointmentCreationBoundary({
  database: secondDatabase,
  booking: secondBooking,
  clock,
});
const clients = createClientAppointmentService(database, clock);
const suiteId = randomUUID();
const serviceIds: string[] = [];
const masterIds: string[] = [];
const adminIds: string[] = [];
const requestKeys: string[] = [];
const origin = process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";
const goodHeaders = new Headers({ origin, "sec-fetch-site": "same-origin" });
const badHeaders = new Headers({ origin: "https://evil.example" });
let originalSettings: Awaited<ReturnType<typeof database.businessSettings.findUnique>>;

async function adminSession() {
  const admin = await database.adminUser.create({
    data: { login: `manual-${randomUUID()}@example.test`, passwordHash: "not-used" },
  });
  adminIds.push(admin.id);
  const token = prepareBookingAttempt().cancellationToken;
  await database.adminSession.create({
    data: {
      adminId: admin.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
  return { admin, token };
}

async function fixture(masterCount = 1) {
  const service = await database.service.create({
    data: {
      name: `Ручная услуга ${suiteId}`,
      priceKopecks: 123_400,
      durationMinutes: 35,
    },
  });
  serviceIds.push(service.id);
  const masters = [];
  for (let index = 0; index < masterCount; index += 1) {
    const master = await database.master.create({
      data: {
        name: `Ручной мастер ${suiteId} ${index}`,
        displayOrder: index,
        services: { create: { serviceId: service.id } },
        weeklyWorkIntervals: {
          create: {
            dayOfWeek: 1,
            startsAt: new Date("1970-01-01T09:00:00Z"),
            endsAt: new Date("1970-01-01T18:00:00Z"),
          },
        },
      },
    });
    masters.push(master);
    masterIds.push(master.id);
  }
  return {
    service,
    masters,
    context: businessContextHash(
      await database.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
    ),
  };
}

function inputFor(
  data: Awaited<ReturnType<typeof fixture>>,
  master: { type: "ANY" } | { type: "SPECIFIC"; masterId: string } = {
    type: "SPECIFIC",
    masterId: data.masters[0].id,
  },
) {
  const attempt = prepareBookingAttempt();
  requestKeys.push(attempt.idempotencyKey);
  return {
    ...attempt,
    serviceId: data.service.id,
    expectedServiceTerms: publicServiceTerms(data.service).termsHash,
    expectedBusinessContext: data.context,
    master,
    localDate: "2026-10-05",
    startsAt: "2026-10-05T10:00:00+03:00",
    clientName: "  Вымышленный Клиент  ",
    clientPhone: "8 (999) 000-00-00",
    confirmed: true as const,
  };
}

function successful<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error("Expected successful admin booking");
  return result as Extract<T, { ok: true }>;
}

describe("manual admin appointment creation", () => {
  beforeAll(async () => {
    originalSettings = await database.businessSettings.findUnique({ where: { id: 1 } });
    await database.businessSettings.upsert({
      where: { id: 1 },
      update: { timezone: "Europe/Moscow", bookingHorizonDays: 30 },
      create: {
        id: 1,
        businessName: `Manual booking ${suiteId}`,
        timezone: "Europe/Moscow",
        bookingHorizonDays: 30,
      },
    });
  });

  afterAll(async () => {
    try {
      await database.appointment.deleteMany({ where: { serviceId: { in: serviceIds } } });
      await database.bookingRequest.deleteMany({ where: { idempotencyKey: { in: requestKeys } } });
      await database.master.deleteMany({ where: { id: { in: masterIds } } });
      await database.service.deleteMany({ where: { id: { in: serviceIds } } });
      await database.adminUser.deleteMany({ where: { id: { in: adminIds } } });
      if (originalSettings) {
        await database.businessSettings.update({
          where: { id: 1 },
          data: {
            businessName: originalSettings.businessName,
            timezone: originalSettings.timezone,
            bookingHorizonDays: originalSettings.bookingHorizonDays,
          },
        });
      } else {
        await database.businessSettings.deleteMany({
          where: { id: 1, businessName: `Manual booking ${suiteId}` },
        });
      }
    } finally {
      await Promise.all([database.$disconnect(), secondDatabase.$disconnect()]);
    }
  });

  it.each([
    ["SPECIFIC", false],
    ["ANY", true],
  ] as const)(
    "creates a %s appointment with ADMIN source, snapshots, history and no messaging side effects",
    async (_label, anyMaster) => {
      const data = await fixture(2);
      const session = await adminSession();
      const input = inputFor(
        data,
        anyMaster ? { type: "ANY" } : { type: "SPECIFIC", masterId: data.masters[0].id },
      );
      const result = successful(await boundary.create(goodHeaders, session.token, input));
      expect(result.replayed).toBe(false);
      expect(result.confirmation).toMatchObject({
        status: "SCHEDULED",
        clientName: "Вымышленный Клиент",
        clientPhone: "+79990000000",
        service: {
          id: data.service.id,
          name: data.service.name,
          priceKopecks: 123_400,
          durationMinutes: 35,
        },
        startsAt: new Date("2026-10-05T07:00:00Z"),
        endsAt: new Date("2026-10-05T07:35:00Z"),
      });
      const row = await database.appointment.findUniqueOrThrow({
        where: { id: result.confirmation.id },
        include: { bookingRequest: true, statusHistory: true },
      });
      expect(row).toMatchObject({
        source: "ADMIN",
        masterSelection: anyMaster ? "ANY" : "SPECIFIC",
        status: "SCHEDULED",
        serviceNameSnapshot: data.service.name,
        servicePriceSnapshot: 123_400,
        serviceDurationSnapshot: 35,
        cancellationTokenHash: hashBookingToken(input.cancellationToken),
      });
      expect(row.bookingRequest.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.statusHistory).toMatchObject([
        {
          previousStatus: null,
          newStatus: "SCHEDULED",
          changedBy: "ADMIN",
          changedByAdminId: session.admin.id,
        },
      ]);
      expect(JSON.stringify(row)).not.toContain(input.cancellationToken);
      expect(await database.telegramLink.count({ where: { appointmentId: row.id } })).toBe(0);
      expect(await database.notificationOutbox.count({ where: { appointmentId: row.id } })).toBe(0);
    },
  );

  it("returns the original result for an identical replay and rejects changed payload or token", async () => {
    const data = await fixture();
    const session = await adminSession();
    const input = inputFor(data);
    const first = successful(await boundary.create(goodHeaders, session.token, input));
    const replay = successful(await boundary.create(goodHeaders, session.token, input));
    expect(replay.replayed).toBe(true);
    expect(replay.confirmation.id).toBe(first.confirmation.id);
    expect(replay.cancellationToken).toBe(input.cancellationToken);
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(1);
    expect(
      await database.appointment.count({
        where: { bookingRequest: { idempotencyKey: input.idempotencyKey } },
      }),
    ).toBe(1);

    const changed = await boundary.create(goodHeaders, session.token, {
      ...input,
      clientName: "Другой клиент",
    });
    expect(changed).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(JSON.stringify(changed)).not.toContain(input.cancellationToken);

    const wrongToken = await boundary.create(goodHeaders, session.token, {
      ...input,
      cancellationToken: prepareBookingAttempt().cancellationToken,
    });
    expect(wrongToken).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(JSON.stringify(wrongToken)).not.toContain(input.cancellationToken);
  });

  it("enforces strict Origin and strict DTOs before mutation", async () => {
    const data = await fixture();
    const session = await adminSession();
    const input = inputFor(data);
    expect(await boundary.prepare(badHeaders, session.token)).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await boundary.create(badHeaders, session.token, input)).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(
      await boundary.create(goodHeaders, session.token, { ...input, source: "ADMIN" }),
    ).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(
      await boundary.availability(session.token, {
        serviceId: data.service.id,
        localDate: input.localDate,
        expectedBusinessContext: data.context,
        clientPhone: input.clientPhone,
      }),
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);
  });

  it("returns only active catalog choices from one snapshot and rechecks the schedule", async () => {
    const data = await fixture();
    const session = await adminSession();
    const inactiveService = await database.service.create({
      data: {
        name: `Inactive service ${suiteId}`,
        priceKopecks: 100,
        durationMinutes: 15,
        isActive: false,
      },
    });
    serviceIds.push(inactiveService.id);
    const inactiveMaster = await database.master.create({
      data: {
        name: `Inactive master ${suiteId}`,
        isActive: false,
        services: { create: { serviceId: data.service.id } },
      },
    });
    const unassignedMaster = await database.master.create({
      data: { name: `Unassigned master ${suiteId}` },
    });
    masterIds.push(inactiveMaster.id, unassignedMaster.id);

    const form = await boundary.form(session.token);
    if (!form.ok) throw new Error("Expected an authorized form");
    expect(form.catalog.services.some((service) => service.id === inactiveService.id)).toBe(false);
    const choice = form.catalog.services.find((service) => service.id === data.service.id);
    expect(choice?.masters.map((master) => master.id)).toEqual([data.masters[0].id]);

    const availability = await boundary.availability(session.token, {
      serviceId: data.service.id,
      masterId: data.masters[0].id,
      localDate: "2026-10-05",
      expectedBusinessContext: data.context,
    });
    expect(availability.ok && availability.slots.length).toBeTruthy();

    const input = inputFor(data);
    await database.weeklyWorkInterval.deleteMany({ where: { masterId: data.masters[0].id } });
    const result = await boundary.create(goodHeaders, session.token, input);
    expect(result).toMatchObject({
      ok: false,
      code: "SLOT_UNAVAILABLE",
      availability: { slots: [] },
    });
  });

  it("rejects stale service terms and business time context with fresh replacements", async () => {
    const termsData = await fixture();
    const termsSession = await adminSession();
    const termsInput = inputFor(termsData);
    await database.service.update({
      where: { id: termsData.service.id },
      data: { priceKopecks: 222_200, durationMinutes: 40 },
    });
    const terms = await boundary.create(goodHeaders, termsSession.token, termsInput);
    expect(terms).toMatchObject({
      ok: false,
      code: "SERVICE_TERMS_CHANGED",
      service: { priceKopecks: 222_200, durationMinutes: 40 },
    });

    const contextData = await fixture();
    const contextSession = await adminSession();
    const contextInput = inputFor(contextData);
    await database.businessSettings.update({
      where: { id: 1 },
      data: { bookingHorizonDays: 31 },
    });
    const context = await boundary.create(goodHeaders, contextSession.token, contextInput);
    expect(context).toMatchObject({
      ok: false,
      code: "BUSINESS_CONTEXT_CHANGED",
      context: { timeZone: "Europe/Moscow" },
    });
    expect(!context.ok && "context" in context && context.context.dates).toHaveLength(31);
    await database.businessSettings.update({
      where: { id: 1 },
      data: { bookingHorizonDays: 30 },
    });
  });

  it.each(["service", "master", "assignment"] as const)(
    "rechecks an inactive or removed %s before insertion",
    async (mode) => {
      const data = await fixture();
      const session = await adminSession();
      const input = inputFor(data);
      if (mode === "service")
        await database.service.update({
          where: { id: data.service.id },
          data: { isActive: false },
        });
      if (mode === "master")
        await database.master.update({
          where: { id: data.masters[0].id },
          data: { isActive: false },
        });
      if (mode === "assignment")
        await database.masterService.delete({
          where: {
            masterId_serviceId: {
              masterId: data.masters[0].id,
              serviceId: data.service.id,
            },
          },
        });
      const result = await boundary.create(goodHeaders, session.token, input);
      expect(result).toMatchObject({ ok: false, code: "REQUEST_REJECTED" });
      expect(await database.appointment.count({ where: { serviceId: data.service.id } })).toBe(0);
    },
  );

  it.each(["expired", "revoked", "inactive", "forged"] as const)(
    "does not return form data, personal data or token for %s admin access",
    async (mode) => {
      const data = await fixture();
      const session = await adminSession();
      const input = inputFor(data);
      if (mode === "expired")
        await database.adminSession.updateMany({
          where: { adminId: session.admin.id },
          data: { expiresAt: new Date("2000-01-01T00:00:00Z") },
        });
      if (mode === "revoked")
        await database.adminSession.updateMany({
          where: { adminId: session.admin.id },
          data: { revokedAt: new Date() },
        });
      if (mode === "inactive")
        await database.adminUser.update({
          where: { id: session.admin.id },
          data: { isActive: false },
        });
      const token = mode === "forged" ? "x".repeat(43) : session.token;
      expect(await boundary.form(token)).toEqual({ ok: false, code: "UNAUTHORIZED" });
      const result = await boundary.create(goodHeaders, token, input);
      expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
      expect(JSON.stringify(result)).not.toContain(input.cancellationToken);
      expect(
        await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
      ).toBe(0);
    },
  );

  it("allows exactly one concurrent overlapping insert and reports fresh availability", async () => {
    const data = await fixture();
    const session = await adminSession();
    const first = inputFor(data);
    const second = { ...inputFor(data), clientName: "Другой клиент" };
    const results = await Promise.all([
      boundary.create(goodHeaders, session.token, first),
      secondBoundary.create(goodHeaders, session.token, second),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const rejected = results.find((result) => !result.ok);
    expect(rejected).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    expect(
      await database.appointment.count({
        where: {
          masterId: data.masters[0].id,
          startsAt: new Date("2026-10-05T07:00:00Z"),
        },
      }),
    ).toBe(1);
  });

  it("client link can view and cancel an ADMIN booking, freeing the slot without changing source", async () => {
    const data = await fixture();
    const session = await adminSession();
    const firstInput = inputFor(data);
    const first = successful(await boundary.create(goodHeaders, session.token, firstInput));
    expect(await clients.getConfirmation(firstInput.cancellationToken)).toMatchObject({
      ok: true,
      confirmation: { id: first.confirmation.id, status: "SCHEDULED" },
    });
    expect(
      await clients.cancelBooking({
        token: firstInput.cancellationToken,
        confirmed: true,
        reason: "Звонок клиента",
      }),
    ).toMatchObject({
      ok: true,
      alreadyCancelled: false,
      confirmation: { status: "CANCELLED" },
    });
    const second = successful(
      await boundary.create(goodHeaders, session.token, {
        ...inputFor(data),
        clientName: "Следующий клиент",
        clientPhone: "+79990000001",
      }),
    );
    expect(second.confirmation.startsAt).toEqual(first.confirmation.startsAt);
    expect(
      await database.appointment.findUniqueOrThrow({
        where: { id: first.confirmation.id },
        select: { source: true, status: true },
      }),
    ).toEqual({ source: "ADMIN", status: "CANCELLED" });
  });

  it("rechecks a revoked session after waiting on the exclusion lock and rolls back all data", async () => {
    const data = await fixture();
    const session = await adminSession();
    const input = inputFor(data);
    const blockerAttempt = prepareBookingAttempt();
    requestKeys.push(blockerAttempt.idempotencyKey);
    let releaseBlocker!: () => void;
    let reportBlocker!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerReady = new Promise<void>((resolve) => {
      reportBlocker = resolve;
    });
    const blocker = secondDatabase
      .$transaction(async (tx) => {
        const request = await tx.bookingRequest.create({
          data: { idempotencyKey: blockerAttempt.idempotencyKey },
        });
        await tx.appointment.create({
          data: {
            bookingRequestId: request.id,
            masterId: data.masters[0].id,
            serviceId: data.service.id,
            startsAt: new Date("2026-10-05T07:00:00Z"),
            endsAt: new Date("2026-10-05T07:35:00Z"),
            clientName: "Временный блокировщик",
            clientPhone: "+79990000002",
            status: "SCHEDULED",
            source: "ONLINE",
            masterSelection: "SPECIFIC",
            serviceNameSnapshot: data.service.name,
            servicePriceSnapshot: data.service.priceKopecks,
            serviceDurationSnapshot: data.service.durationMinutes,
            cancellationTokenHash: hashBookingToken(blockerAttempt.cancellationToken),
          },
        });
        reportBlocker();
        await release;
        throw new Error("rollback test blocker");
      })
      .catch(() => undefined);
    await blockerReady;

    const original = SchedulingAvailabilityService.prototype.checkMasterInterval;
    let checked!: () => void;
    const reachedCheck = new Promise<void>((resolve) => {
      checked = resolve;
    });
    const spy = vi
      .spyOn(SchedulingAvailabilityService.prototype, "checkMasterInterval")
      .mockImplementation(async function (this: SchedulingAvailabilityService, query) {
        const result = await original.call(this, query);
        checked();
        return result;
      });
    try {
      const creation = boundary.create(goodHeaders, session.token, input);
      await reachedCheck;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await database.adminSession.updateMany({
        where: { adminId: session.admin.id },
        data: { revokedAt: new Date() },
      });
      releaseBlocker();
      await blocker;
      const result = await creation;
      expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
      expect(JSON.stringify(result)).not.toContain(input.cancellationToken);
      expect(
        await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
      ).toBe(0);
      expect(await database.appointment.count({ where: { serviceId: data.service.id } })).toBe(0);
    } finally {
      releaseBlocker();
      await blocker;
      spy.mockRestore();
    }
  });
});
