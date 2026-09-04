import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { AppointmentStatus, PrismaClient } from "../../src/generated/prisma/client";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import { createAdminBookingService } from "../../src/modules/booking/server/admin-booking-service";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import {
  hashBookingToken,
  prepareBookingAttempt,
} from "../../src/modules/booking/server/booking-security";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import { businessContextHash } from "../../src/modules/settings/server/context";
import { createAppointmentsBoundary } from "../../src/server/admin/appointments-boundary";
import { createAppointmentCreationBoundary } from "../../src/server/admin/appointment-creation-boundary";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/zaprosto_test_[a-f0-9]+$/.test(new URL(url).pathname)) {
  throw new Error("Use isolated runner");
}

const db = createPrismaClient(url);
const other = createPrismaClient(url);
const locker = createPrismaClient(url);
const boundary = createAppointmentsBoundary(db);
const secondBoundary = createAppointmentsBoundary(other);
const clients = createClientAppointmentService(other);
const adminCreationBoundary = createAppointmentCreationBoundary({
  database: other,
  booking: createAdminBookingService(other),
});
const configuredOrigin = process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";
const originHeaders = new Headers({ origin: configuredOrigin });
const foreignHeaders = new Headers({ origin: "https://attacker.example" });

let token: string;
let adminId: string;
let serviceId: string;
let firstMasterId: string;
let secondMasterId: string;
let localDate: string;

function dateAfterToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function instant(date: string, hour: number, minute = 0): Date {
  return new Date(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`,
  );
}

async function clear() {
  await db.appointment.deleteMany();
  await db.bookingRequest.deleteMany();
  await db.master.deleteMany();
  await db.service.deleteMany();
  await db.adminSession.deleteMany();
  await db.adminUser.deleteMany();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await clear();
  await db.businessSettings.upsert({
    where: { id: 1 },
    create: {
      businessName: "Reschedule tests",
      timezone: "UTC",
      bookingHorizonDays: 30,
    },
    update: {
      version: 0,
      timezone: "UTC",
      bookingHorizonDays: 30,
    },
  });
  token = randomBytes(32).toString("base64url");
  adminId = (
    await db.adminUser.create({
      data: {
        login: "reschedule.test",
        passwordHash: "fixture-no-login",
        sessions: {
          create: {
            tokenHash: hashSessionToken(token),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        },
      },
    })
  ).id;
  serviceId = (
    await db.service.create({
      data: {
        name: "Historical service",
        priceKopecks: 123_456,
        durationMinutes: 35,
      },
    })
  ).id;
  const schedule = Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    startsAt: new Date("1970-01-01T09:00:00.000Z"),
    endsAt: new Date("1970-01-01T18:00:00.000Z"),
  }));
  firstMasterId = (
    await db.master.create({
      data: {
        name: "First master",
        displayOrder: 1,
        services: { create: { serviceId } },
        weeklyWorkIntervals: { create: schedule },
      },
    })
  ).id;
  secondMasterId = (
    await db.master.create({
      data: {
        name: "Second master",
        displayOrder: 2,
        services: { create: { serviceId } },
        weeklyWorkIntervals: { create: schedule },
      },
    })
  ).id;
  localDate = dateAfterToday(3);
});

afterAll(async () => {
  await clear();
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  await db.$disconnect();
  await other.$disconnect();
  await locker.$disconnect();
});

async function createAppointment(
  options: {
    client?: PrismaClient;
    status?: AppointmentStatus;
    start?: Date;
    masterId?: string;
    selectedServiceId?: string;
    serviceName?: string;
    priceKopecks?: number;
    durationMinutes?: number;
    masterSelection?: "SPECIFIC" | "ANY";
  } = {},
) {
  const client = options.client ?? db;
  const start = options.start ?? instant(localDate, 10);
  const durationMinutes = options.durationMinutes ?? 35;
  const status = options.status ?? "SCHEDULED";
  const attempt = prepareBookingAttempt();
  const appointment = await client.appointment.create({
    data: {
      bookingRequest: {
        create: { idempotencyKey: attempt.idempotencyKey },
      },
      master: { connect: { id: options.masterId ?? firstMasterId } },
      service: { connect: { id: options.selectedServiceId ?? serviceId } },
      startsAt: start,
      endsAt: new Date(start.getTime() + durationMinutes * 60_000),
      clientName: "Private reschedule client",
      clientPhone: "+79990000000",
      status,
      source: "ONLINE",
      masterSelection: options.masterSelection ?? "SPECIFIC",
      serviceNameSnapshot: options.serviceName ?? "Historical service",
      servicePriceSnapshot: options.priceKopecks ?? 123_456,
      serviceDurationSnapshot: durationMinutes,
      cancellationTokenHash: hashBookingToken(attempt.cancellationToken),
      ...(status === "CANCELLED"
        ? {
            cancelledAt: new Date(),
            cancelledBy: "CLIENT" as const,
          }
        : {}),
      statusHistory: {
        create: {
          previousStatus: null,
          newStatus: status,
          changedBy: "CLIENT",
        },
      },
    },
    include: { statusHistory: true },
  });
  return { ...appointment, cancellationToken: attempt.cancellationToken };
}

async function contextHash() {
  return businessContextHash(await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }));
}

async function input(appointmentId: string, overrides: Record<string, unknown> = {}) {
  const appointment = await db.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
  });
  return {
    appointmentId,
    expectedVersion: appointment.version,
    service: { mode: "KEEP_CURRENT" as const },
    master: { type: "SPECIFIC" as const, masterId: appointment.masterId },
    localDate,
    expectedBusinessContext: await contextHash(),
    startsAt: instant(localDate, 11),
    confirmed: true,
    ...overrides,
  };
}

async function adminCreateInput(startsAt: Date) {
  const service = await db.service.findUniqueOrThrow({ where: { id: serviceId } });
  return {
    ...prepareBookingAttempt(),
    serviceId,
    expectedServiceTerms: publicServiceTerms(service).termsHash,
    expectedBusinessContext: await contextHash(),
    master: { type: "SPECIFIC" as const, masterId: firstMasterId },
    localDate,
    startsAt,
    clientName: "Concurrent admin client",
    clientPhone: "+79991112233",
    confirmed: true as const,
  };
}

async function stored(id: string) {
  return db.appointment.findUniqueOrThrow({
    where: { id },
    include: {
      statusHistory: { orderBy: [{ changedAt: "asc" }, { id: "asc" }] },
      bookingRequest: true,
    },
  });
}

function availabilityOnly(save: Awaited<ReturnType<typeof input>>) {
  return {
    appointmentId: save.appointmentId,
    expectedVersion: save.expectedVersion,
    service: save.service,
    master: save.master,
    localDate: save.localDate,
    expectedBusinessContext: save.expectedBusinessContext,
  };
}

async function holdAppointment(id: string) {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holder = locker.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id}::uuid FOR UPDATE`;
      ready();
      await gate;
    },
    { timeout: 10_000 },
  );
  await started;
  return { release, holder };
}

async function holdTestAdvisoryLock(objectId: number) {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holder = locker.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(526009, ${objectId})`;
      ready();
      await gate;
    },
    { timeout: 10_000 },
  );
  await started;
  return { release, holder };
}

async function waitForLock() {
  await vi.waitFor(
    async () => {
      const rows = await locker.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      expect(Number(rows[0].count)).toBeGreaterThan(0);
    },
    { timeout: 3_000 },
  );
}

async function activeOverlapCount(masterId: string, startsAt: Date, durationMinutes = 35) {
  return db.appointment.count({
    where: {
      masterId,
      status: { not: "CANCELLED" },
      startsAt: { lt: new Date(startsAt.getTime() + durationMinutes * 60_000) },
      endsAt: { gt: startsAt },
    },
  });
}

it("KEEP_CURRENT exposes the self-excluded slot and preserves every historical snapshot", async () => {
  const appointment = await createAppointment();
  const before = await stored(appointment.id);
  await db.service.update({
    where: { id: serviceId },
    data: {
      name: "Changed catalog name",
      priceKopecks: 999_999,
      durationMinutes: 60,
      isActive: false,
    },
  });
  const save = await input(appointment.id);
  const available = await boundary.rescheduleAvailability(
    originHeaders,
    token,
    availabilityOnly({ ...save, startsAt: appointment.startsAt }),
  );
  expect(available).toMatchObject({
    ok: true,
    service: {
      id: serviceId,
      name: "Historical service",
      priceKopecks: 123_456,
      durationMinutes: 35,
    },
  });
  if (!available.ok) throw new Error("Expected historical availability");
  expect(available.slots).toContainEqual({
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
  });

  const result = await boundary.rescheduleAppointment(originHeaders, token, save);
  expect(result).toEqual({ ok: true, appointmentId: appointment.id, version: 1 });
  const after = await stored(appointment.id);
  for (const key of [
    "serviceId",
    "serviceNameSnapshot",
    "servicePriceSnapshot",
    "serviceDurationSnapshot",
    "clientName",
    "clientPhone",
    "bookingRequestId",
    "cancellationTokenHash",
    "source",
  ] as const) {
    expect(after[key]).toEqual(before[key]);
  }
  expect(after.statusHistory).toEqual(before.statusHistory);
  expect(after.endsAt.getTime() - after.startsAt.getTime()).toBe(35 * 60_000);
});

it("moves atomically to a specific master, frees the old slot and updates protected client data", async () => {
  const appointment = await createAppointment();
  const save = await input(appointment.id, {
    master: { type: "SPECIFIC", masterId: secondMasterId },
    startsAt: instant(localDate, 12),
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, save)).toEqual({
    ok: true,
    appointmentId: appointment.id,
    version: 1,
  });
  const moved = await stored(appointment.id);
  expect(moved).toMatchObject({
    masterId: secondMasterId,
    masterSelection: "SPECIFIC",
    version: 1,
  });
  expect(moved.startsAt).toEqual(instant(localDate, 12));
  const protectedView = await clients.getConfirmation(appointment.cancellationToken);
  expect(protectedView).toMatchObject({
    ok: true,
    confirmation: {
      id: appointment.id,
      startsAt: instant(localDate, 12),
    },
  });
  await expect(
    createAppointment({ start: appointment.startsAt, masterId: firstMasterId }),
  ).resolves.toBeTruthy();
});

it("ANY deterministically selects the least-loaded eligible master", async () => {
  const appointment = await createAppointment();
  await createAppointment({
    start: instant(localDate, 9),
    masterId: firstMasterId,
  });
  const save = await input(appointment.id, {
    master: { type: "ANY" },
    startsAt: instant(localDate, 13),
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, save)).toMatchObject({
    ok: true,
  });
  expect(await stored(appointment.id)).toMatchObject({
    masterId: secondMasterId,
    masterSelection: "ANY",
  });
});

it("CATALOG requires current active terms and writes only their verified snapshots", async () => {
  const appointment = await createAppointment();
  const catalogService = await db.service.create({
    data: {
      name: "New catalog service",
      priceKopecks: 222_333,
      durationMinutes: 45,
      masters: { create: { masterId: secondMasterId } },
    },
  });
  const terms = publicServiceTerms(catalogService);
  const save = await input(appointment.id, {
    service: {
      mode: "CATALOG",
      serviceId: catalogService.id,
      expectedServiceTerms: terms.termsHash,
    },
    master: { type: "SPECIFIC", masterId: secondMasterId },
    startsAt: instant(localDate, 14),
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, save)).toMatchObject({
    ok: true,
  });
  const after = await stored(appointment.id);
  expect(after).toMatchObject({
    serviceId: catalogService.id,
    serviceNameSnapshot: terms.name,
    servicePriceSnapshot: terms.priceKopecks,
    serviceDurationSnapshot: terms.durationMinutes,
  });
  expect(after.endsAt.getTime() - after.startsAt.getTime()).toBe(45 * 60_000);
});

it("rejects stale catalog terms and an inactive service without changing the appointment", async () => {
  const appointment = await createAppointment();
  const before = await stored(appointment.id);
  const catalogService = await db.service.create({
    data: {
      name: "Candidate",
      priceKopecks: 100,
      durationMinutes: 30,
      masters: { create: { masterId: firstMasterId } },
    },
  });
  const staleTerms = publicServiceTerms(catalogService);
  await db.service.update({
    where: { id: catalogService.id },
    data: { priceKopecks: 101 },
  });
  const stale = await input(appointment.id, {
    service: {
      mode: "CATALOG",
      serviceId: catalogService.id,
      expectedServiceTerms: staleTerms.termsHash,
    },
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, stale)).toMatchObject({
    ok: false,
    code: "SERVICE_TERMS_CHANGED",
    service: { priceKopecks: 101 },
  });
  await db.service.update({
    where: { id: catalogService.id },
    data: { isActive: false },
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, stale)).toMatchObject({
    ok: false,
    code: "SELECTION_UNAVAILABLE",
  });
  expect(await stored(appointment.id)).toEqual(before);
});

it.each(["COMPLETED", "NO_SHOW", "CANCELLED"] as const)(
  "does not edit a %s appointment",
  async (status) => {
    const appointment = await createAppointment({ status });
    const before = await stored(appointment.id);
    expect(
      await boundary.rescheduleAppointment(originHeaders, token, await input(appointment.id)),
    ).toEqual({ ok: false, code: "EDIT_NOT_ALLOWED" });
    expect(await stored(appointment.id)).toEqual(before);
  },
);

it("rejects a past start, a no-op and an ABA-stale version", async () => {
  const appointment = await createAppointment();
  const same = await input(appointment.id, {
    startsAt: appointment.startsAt,
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, same)).toEqual({
    ok: false,
    code: "NO_CHANGES",
  });
  expect(
    await boundary.rescheduleAppointment(
      originHeaders,
      token,
      await input(appointment.id, { startsAt: new Date(0) }),
    ),
  ).toEqual({ ok: false, code: "START_NOT_IN_FUTURE" });
  const stale = await input(appointment.id);
  await db.appointment.update({
    where: { id: appointment.id },
    data: { clientName: "Temporary", version: { increment: 1 } },
  });
  await db.appointment.update({
    where: { id: appointment.id },
    data: { clientName: appointment.clientName, version: { increment: 1 } },
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, stale)).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect((await stored(appointment.id)).version).toBe(2);
});

it("returns fresh availability when a newly committed booking wins the exclusion race", async () => {
  const appointment = await createAppointment();
  const target = instant(localDate, 15);
  const save = await input(appointment.id, { startsAt: target });
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_reschedule_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER test_reschedule_pause BEFORE UPDATE OF starts_at ON appointments FOR EACH ROW EXECUTE FUNCTION test_reschedule_pause()",
  );
  try {
    const pending = boundary.rescheduleAppointment(originHeaders, token, save);
    await vi.waitFor(
      async () => {
        const rows = await other.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'PgSleep'`;
        expect(Number(rows[0].count)).toBeGreaterThan(0);
      },
      { timeout: 3_000 },
    );
    const service = await other.service.findUniqueOrThrow({ where: { id: serviceId } });
    const booking = createBookingService(other);
    const attempt = prepareBookingAttempt();
    const created = await booking.createBooking({
      ...attempt,
      serviceId,
      expectedServiceTerms: publicServiceTerms(service).termsHash,
      expectedBusinessContext: await contextHash(),
      master: { type: "SPECIFIC", masterId: firstMasterId },
      localDate,
      startsAt: target,
      clientName: "Concurrent client",
      clientPhone: "+79991112233",
    });
    expect(created).toMatchObject({ ok: true, replayed: false });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    if (result.ok || result.code !== "SLOT_UNAVAILABLE") {
      throw new Error("Expected occupied slot");
    }
    expect(result.availability.slots.map((slot) => slot.startsAt)).not.toContain(
      target.toISOString(),
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER test_reschedule_pause ON appointments");
    await db.$executeRawUnsafe("DROP FUNCTION test_reschedule_pause()");
  }
  expect(await stored(appointment.id)).toMatchObject({
    version: 0,
    startsAt: appointment.startsAt,
  });
});

it("keeps the original visit unchanged when manual admin creation wins the target slot", async () => {
  const appointment = await createAppointment();
  const before = await stored(appointment.id);
  const target = instant(localDate, 15);
  const save = await input(appointment.id, { startsAt: target });
  const manualInput = await adminCreateInput(target);
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_pause_transfer_for_admin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(526009, 72); RETURN NULL; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER test_pause_transfer_for_admin BEFORE UPDATE OF starts_at ON appointments FOR EACH STATEMENT EXECUTE FUNCTION test_pause_transfer_for_admin()",
  );
  let transferResult;
  let manualResult;
  try {
    const gate = await holdTestAdvisoryLock(72);
    const transfer = boundary.rescheduleAppointment(originHeaders, token, save);
    try {
      await waitForLock();
      manualResult = await adminCreationBoundary.create(originHeaders, token, manualInput);
    } finally {
      gate.release();
      await gate.holder;
    }
    transferResult = await transfer;
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER test_pause_transfer_for_admin ON appointments");
    await db.$executeRawUnsafe("DROP FUNCTION test_pause_transfer_for_admin()");
  }

  expect(manualResult).toMatchObject({ ok: true, replayed: false });
  expect(transferResult).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
  expect(await stored(appointment.id)).toEqual(before);
  const request = await db.bookingRequest.findUniqueOrThrow({
    where: { idempotencyKey: manualInput.idempotencyKey },
    include: { appointment: true },
  });
  expect(request.appointment).toMatchObject({
    source: "ADMIN",
    masterId: firstMasterId,
    startsAt: target,
  });
  expect(await activeOverlapCount(firstMasterId, target)).toBe(1);
  expect(await db.appointment.count()).toBe(2);
  expect(await db.bookingRequest.count()).toBe(2);
});

it("rolls back manual admin creation when reschedule wins the target slot", async () => {
  const appointment = await createAppointment();
  const before = await stored(appointment.id);
  const target = instant(localDate, 15);
  const save = await input(appointment.id, { startsAt: target });
  const manualInput = await adminCreateInput(target);
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_pause_admin_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(526009, 73); RETURN NULL; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER test_pause_admin_insert BEFORE INSERT ON appointments FOR EACH STATEMENT EXECUTE FUNCTION test_pause_admin_insert()",
  );
  let transferResult;
  let manualResult;
  try {
    const gate = await holdTestAdvisoryLock(73);
    const manual = adminCreationBoundary.create(originHeaders, token, manualInput);
    try {
      await waitForLock();
      transferResult = await boundary.rescheduleAppointment(originHeaders, token, save);
    } finally {
      gate.release();
      await gate.holder;
    }
    manualResult = await manual;
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER test_pause_admin_insert ON appointments");
    await db.$executeRawUnsafe("DROP FUNCTION test_pause_admin_insert()");
  }

  expect(transferResult).toEqual({
    ok: true,
    appointmentId: appointment.id,
    version: 1,
  });
  expect(manualResult).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
  const after = await stored(appointment.id);
  expect(after).toMatchObject({
    version: 1,
    startsAt: target,
    endsAt: new Date(target.getTime() + 35 * 60_000),
  });
  expect(after.statusHistory).toEqual(before.statusHistory);
  expect(
    await db.bookingRequest.findUnique({
      where: { idempotencyKey: manualInput.idempotencyKey },
    }),
  ).toBeNull();
  expect(await activeOverlapCount(firstMasterId, target)).toBe(1);
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
});

it("serializes two concurrent reschedules by version", async () => {
  const appointment = await createAppointment();
  const first = await input(appointment.id, { startsAt: instant(localDate, 12) });
  const second = { ...first, startsAt: instant(localDate, 13) };
  const results = await Promise.all([
    boundary.rescheduleAppointment(originHeaders, token, first),
    secondBoundary.rescheduleAppointment(originHeaders, token, second),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok && result.code === "CONFLICT")).toHaveLength(1);
  expect((await stored(appointment.id)).version).toBe(1);
});

it("serializes contact and status races without a partial visit edit", async () => {
  const appointment = await createAppointment();
  const save = await input(appointment.id, { startsAt: instant(localDate, 12) });
  const contactResults = await Promise.all([
    boundary.rescheduleAppointment(originHeaders, token, save),
    secondBoundary.updateContacts(originHeaders, token, {
      id: appointment.id,
      version: 0,
      clientName: "Corrected client",
      clientPhone: "+79992223344",
    }),
  ]);
  expect(contactResults.filter((result) => result.ok)).toHaveLength(1);
  expect(contactResults.filter((result) => !result.ok && result.code === "CONFLICT")).toHaveLength(
    1,
  );
  const afterContacts = await stored(appointment.id);
  expect(afterContacts.version).toBe(1);

  const nextSave = await input(appointment.id, { startsAt: instant(localDate, 13) });
  const statusResults = await Promise.all([
    boundary.rescheduleAppointment(originHeaders, token, nextSave),
    secondBoundary.change(originHeaders, token, {
      id: appointment.id,
      version: afterContacts.version,
      expectedBusinessContext: await contextHash(),
      status: "CANCELLED",
      confirmed: true,
    }),
  ]);
  expect(statusResults.filter((result) => result.ok)).toHaveLength(1);
  expect(statusResults.filter((result) => !result.ok && result.code === "CONFLICT")).toHaveLength(
    1,
  );
  const final = await stored(appointment.id);
  expect(final.version).toBe(2);
  expect(
    final.status === "CANCELLED" || final.startsAt.getTime() === instant(localDate, 13).getTime(),
  ).toBe(true);
});

it("cancels the moved appointment when reschedule deterministically commits first", async () => {
  const appointment = await createAppointment();
  const before = await stored(appointment.id);
  const target = instant(localDate, 14);
  const save = await input(appointment.id, { startsAt: target });
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_pause_client_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(526009, 71); RETURN NULL; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER test_pause_client_cancel BEFORE UPDATE OF status ON appointments FOR EACH STATEMENT EXECUTE FUNCTION test_pause_client_cancel()",
  );
  try {
    const gate = await holdTestAdvisoryLock(71);
    const cancellation = clients.cancelBooking({
      token: appointment.cancellationToken,
      confirmed: true,
      reason: "Client changed plans after transfer",
    });
    let rescheduled;
    try {
      await waitForLock();
      rescheduled = await boundary.rescheduleAppointment(originHeaders, token, save);
    } finally {
      gate.release();
      await gate.holder;
    }
    expect(rescheduled).toEqual({
      ok: true,
      appointmentId: appointment.id,
      version: 1,
    });
    expect(await cancellation).toMatchObject({
      ok: true,
      alreadyCancelled: false,
      confirmation: {
        id: appointment.id,
        startsAt: target,
        status: "CANCELLED",
      },
    });
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER test_pause_client_cancel ON appointments");
    await db.$executeRawUnsafe("DROP FUNCTION test_pause_client_cancel()");
  }

  const after = await stored(appointment.id);
  expect(after).toMatchObject({
    id: appointment.id,
    version: 2,
    status: "CANCELLED",
    startsAt: target,
    endsAt: new Date(target.getTime() + 35 * 60_000),
    cancelledBy: "CLIENT",
    cancellationReason: "Client changed plans after transfer",
  });
  for (const key of [
    "masterId",
    "serviceId",
    "serviceNameSnapshot",
    "servicePriceSnapshot",
    "serviceDurationSnapshot",
    "bookingRequestId",
    "cancellationTokenHash",
    "clientName",
    "clientPhone",
  ] as const) {
    expect(after[key]).toEqual(before[key]);
  }
  expect(after.statusHistory).toHaveLength(2);
  expect(after.statusHistory[1]).toMatchObject({
    previousStatus: "SCHEDULED",
    newStatus: "CANCELLED",
    changedBy: "CLIENT",
    reason: "Client changed plans after transfer",
  });
  expect(await activeOverlapCount(firstMasterId, appointment.startsAt)).toBe(0);
  expect(await activeOverlapCount(firstMasterId, target)).toBe(0);
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
});

it("keeps cancellation intact when it deterministically commits before reschedule", async () => {
  const appointment = await createAppointment();
  const before = await stored(appointment.id);
  const target = instant(localDate, 14);
  const staleSave = await input(appointment.id, { startsAt: target });

  expect(
    await clients.cancelBooking({
      token: appointment.cancellationToken,
      confirmed: true,
      reason: "Client cancelled before transfer",
    }),
  ).toMatchObject({
    ok: true,
    alreadyCancelled: false,
    confirmation: {
      id: appointment.id,
      startsAt: appointment.startsAt,
      status: "CANCELLED",
    },
  });
  const cancelled = await stored(appointment.id);
  expect(cancelled).toMatchObject({
    version: 1,
    status: "CANCELLED",
    startsAt: before.startsAt,
    endsAt: before.endsAt,
    masterId: before.masterId,
    serviceId: before.serviceId,
    cancelledBy: "CLIENT",
    cancellationReason: "Client cancelled before transfer",
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, staleSave)).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect(
    await boundary.rescheduleAppointment(
      originHeaders,
      token,
      await input(appointment.id, { startsAt: target }),
    ),
  ).toEqual({ ok: false, code: "EDIT_NOT_ALLOWED" });
  expect(await stored(appointment.id)).toEqual(cancelled);
  expect(cancelled.statusHistory).toHaveLength(2);
  expect(await activeOverlapCount(firstMasterId, appointment.startsAt)).toBe(0);
  expect(await activeOverlapCount(firstMasterId, target)).toBe(0);
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
});

it("revalidates business context, service terms and schedule at save time", async () => {
  const contextAppointment = await createAppointment();
  const contextInput = await input(contextAppointment.id);
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: { increment: 1 } },
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, contextInput)).toMatchObject({
    ok: false,
    code: "BUSINESS_CONTEXT_CHANGED",
  });
  expect((await stored(contextAppointment.id)).version).toBe(0);

  const scheduleAppointment = await createAppointment({
    start: instant(localDate, 16),
    masterId: secondMasterId,
  });
  const scheduleInput = await input(scheduleAppointment.id, {
    startsAt: instant(localDate, 17),
  });
  await db.weeklyWorkInterval.deleteMany({
    where: { masterId: secondMasterId },
  });
  expect(await boundary.rescheduleAppointment(originHeaders, token, scheduleInput)).toMatchObject({
    ok: false,
    code: "SLOT_UNAVAILABLE",
  });
  expect((await stored(scheduleAppointment.id)).version).toBe(0);
});

it.each(["missing", "expired", "revoked", "disabled"] as const)(
  "does not disclose appointment existence to a %s admin session",
  async (mode) => {
    const appointment = await createAppointment();
    const save = await input(appointment.id);
    if (mode === "expired") {
      await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    } else if (mode === "revoked") {
      await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    } else if (mode === "disabled") {
      await db.adminUser.update({ where: { id: adminId }, data: { isActive: false } });
    }
    const supplied = mode === "missing" ? undefined : token;
    for (const appointmentId of [appointment.id, randomUUID()]) {
      expect(
        await boundary.rescheduleAvailability(originHeaders, supplied, {
          ...availabilityOnly(save),
          appointmentId,
        }),
      ).toEqual({ ok: false, code: "UNAUTHORIZED" });
      expect(
        await boundary.rescheduleAppointment(originHeaders, supplied, {
          ...save,
          appointmentId,
        }),
      ).toEqual({ ok: false, code: "UNAUTHORIZED" });
    }
  },
);

it("rejects foreign Origin and strict DTO fields before exposing protected availability", async () => {
  const appointment = await createAppointment();
  const save = await input(appointment.id);
  expect(
    await boundary.rescheduleAvailability(foreignHeaders, token, availabilityOnly(save)),
  ).toEqual({ ok: false, code: "FORBIDDEN" });
  expect(await boundary.rescheduleAppointment(foreignHeaders, token, save)).toEqual({
    ok: false,
    code: "FORBIDDEN",
  });
  expect(
    await boundary.rescheduleAvailability(originHeaders, token, {
      ...availabilityOnly(save),
      excludeAppointmentId: appointment.id,
    }),
  ).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(
    await boundary.rescheduleAppointment(originHeaders, token, {
      ...save,
      serviceDurationSnapshot: 1,
    }),
  ).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it.each(["revoked", "expired", "disabled"] as const)(
  "%s access loss while waiting on SELECT FOR UPDATE denies the mutation",
  async (mode) => {
    const appointment = await createAppointment();
    const before = await stored(appointment.id);
    const save = await input(appointment.id);
    const gate = await holdAppointment(appointment.id);
    const pending = boundary.rescheduleAppointment(originHeaders, token, save);
    try {
      await waitForLock();
      if (mode === "revoked") {
        await other.adminSession.updateMany({ data: { revokedAt: new Date() } });
      } else if (mode === "expired") {
        await other.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
      } else {
        await other.adminUser.update({
          where: { id: adminId },
          data: { isActive: false },
        });
      }
    } finally {
      gate.release();
      await gate.holder;
    }
    const result = await pending;
    expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(JSON.stringify(result)).toBe('{"ok":false,"code":"UNAUTHORIZED"}');
    expect(await stored(appointment.id)).toEqual(before);
  },
);

it("rolls back every visit field and version when the UPDATE fails", async () => {
  const appointment = await createAppointment();
  const before = await stored(appointment.id);
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_reschedule_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER test_reschedule_failure BEFORE UPDATE OF starts_at ON appointments FOR EACH ROW EXECUTE FUNCTION test_reschedule_failure()",
  );
  try {
    expect(
      await boundary.rescheduleAppointment(originHeaders, token, await input(appointment.id)),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER test_reschedule_failure ON appointments");
    await db.$executeRawUnsafe("DROP FUNCTION test_reschedule_failure()");
  }
  expect(await stored(appointment.id)).toEqual(before);
});

it("returns a redacted unknown outcome without retrying the transaction", async () => {
  const appointment = await createAppointment();
  const save = await input(appointment.id);
  const transaction = vi
    .spyOn(db, "$transaction")
    .mockRejectedValueOnce(new Error("private +79990000000 token session snapshot master service"));
  try {
    const result = await boundary.rescheduleAppointment(originHeaders, token, save);
    expect(result).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toMatch(/7999|token|session|snapshot|master|service/i);
    expect(transaction).toHaveBeenCalledTimes(1);
  } finally {
    transaction.mockRestore();
  }
});

it("does not retry or guess success when the transaction committed but its result was lost", async () => {
  const appointment = await createAppointment();
  const save = await input(appointment.id);
  const actualTransaction = db.$transaction.bind(db);
  const transaction = vi.spyOn(db, "$transaction");
  transaction.mockImplementationOnce((async (...args: unknown[]) => {
    await Reflect.apply(actualTransaction, db, args);
    throw new Error("connection lost after commit");
  }) as never);
  try {
    expect(await boundary.rescheduleAppointment(originHeaders, token, save)).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  } finally {
    transaction.mockRestore();
  }
  expect(await stored(appointment.id)).toMatchObject({
    version: 1,
    startsAt: save.startsAt,
  });
});
