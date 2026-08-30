import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Prisma } from "../../src/generated/prisma/client";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import {
  hashBookingToken,
  prepareBookingAttempt,
} from "../../src/modules/booking/server/booking-security";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import type { CreateBookingResult } from "../../src/modules/booking/server/types";
import {
  SchedulingAvailabilityService,
  createSchedulingAvailabilityService,
} from "../../src/modules/scheduling/server/availability-service";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { isAppointmentOverlap } from "../../src/server/db/transaction-errors";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for integration tests");

const database = createPrismaClient(connectionString);
const secondDatabase = createPrismaClient(connectionString);
const clock = { now: () => new Date("2026-10-01T00:00:00Z") };
const booking = createBookingService(database, clock);
const secondBooking = createBookingService(secondDatabase, clock);
const appointments = createClientAppointmentService(database, clock);
const secondAppointments = createClientAppointmentService(secondDatabase, clock);
const scheduling = createSchedulingAvailabilityService(database, clock);
const suiteId = randomUUID();
const masterIds: string[] = [];
const serviceIds: string[] = [];
const keys: string[] = [];
let originalSettings: Awaited<ReturnType<typeof database.businessSettings.findUnique>>;

async function fixture(count = 1, durationMinutes = 30) {
  const service = await database.service.create({
    data: { name: `Вымышленная услуга ${suiteId}`, priceKopecks: 123_400, durationMinutes },
  });
  serviceIds.push(service.id);
  const masters = [];
  for (let index = 0; index < count; index += 1) {
    const master = await database.master.create({
      data: {
        name: `Вымышленный мастер ${suiteId} ${index}`,
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
    masterIds.push(master.id);
    masters.push(master);
  }
  return { service, masters };
}

function inputFor(data: Awaited<ReturnType<typeof fixture>>, any = false) {
  const attempt = prepareBookingAttempt();
  keys.push(attempt.idempotencyKey);
  return {
    ...attempt,
    serviceId: data.service.id,
    master: any
      ? { type: "ANY" as const }
      : { type: "SPECIFIC" as const, masterId: data.masters[0].id },
    localDate: "2026-10-05",
    startsAt: "2026-10-05T10:00:00+03:00",
    clientName: "  Вымышленный Клиент  ",
    clientPhone: "8 (999) 000-00-00",
  };
}

function success(result: CreateBookingResult) {
  if (!result.ok) throw new Error(`Expected successful booking, got ${result.code}`);
  return result;
}

async function history(id: string) {
  return database.appointmentStatusHistory.findMany({
    where: { appointmentId: id },
    orderBy: { changedAt: "asc" },
  });
}

// Deterministically hold both callers after their real scheduling checks.
function synchronizeTwoChecks() {
  const original = SchedulingAvailabilityService.prototype.checkMasterInterval;
  let arrivals = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(SchedulingAvailabilityService.prototype, "checkMasterInterval").mockImplementation(
    async function (this: SchedulingAvailabilityService, query) {
      const result = await original.call(this, query);
      arrivals += 1;
      if (arrivals === 2) release();
      if (arrivals <= 2) await both;
      return result;
    },
  );
}

describe("online booking and protected cancellation application services", () => {
  beforeAll(async () => {
    originalSettings = await database.businessSettings.findUnique({ where: { id: 1 } });
    await database.businessSettings.upsert({
      where: { id: 1 },
      update: { timezone: "Europe/Moscow", bookingHorizonDays: 30 },
      create: {
        businessName: `Booking integration ${suiteId}`,
        timezone: "Europe/Moscow",
        bookingHorizonDays: 30,
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    try {
      await database.appointment.deleteMany({ where: { masterId: { in: masterIds } } });
      await database.bookingRequest.deleteMany({ where: { idempotencyKey: { in: keys } } });
      await database.master.deleteMany({ where: { id: { in: masterIds } } });
      await database.service.deleteMany({ where: { id: { in: serviceIds } } });
      if (originalSettings) {
        await database.businessSettings.update({
          where: { id: 1 },
          data: {
            timezone: originalSettings.timezone,
            bookingHorizonDays: originalSettings.bookingHorizonDays,
          },
        });
      } else {
        await database.businessSettings.deleteMany({
          where: { id: 1, businessName: `Booking integration ${suiteId}` },
        });
      }
    } finally {
      await Promise.all([database.$disconnect(), secondDatabase.$disconnect()]);
    }
  });

  it("creates a specific-master booking with normalized contacts, exact snapshots and initial history", async () => {
    const data = await fixture(1, 35);
    const input = inputFor(data);
    const result = success(await booking.createBooking(input));
    expect(result.replayed).toBe(false);
    expect(result.confirmation).toMatchObject({
      status: "SCHEDULED",
      clientName: "Вымышленный Клиент",
      clientPhone: "+79990000000",
      master: { id: data.masters[0].id },
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
      include: { bookingRequest: true },
    });
    expect(row).toMatchObject({
      source: "ONLINE",
      masterSelection: "SPECIFIC",
      cancellationTokenHash: hashBookingToken(input.cancellationToken),
    });
    expect(row.bookingRequest.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(input.cancellationToken);
    expect(await history(row.id)).toMatchObject([
      { previousStatus: null, newStatus: "SCHEDULED", changedBy: "CLIENT", changedAt: clock.now() },
    ]);
    await database.service.update({
      where: { id: data.service.id },
      data: {
        name: "Обновлённая вымышленная услуга",
        priceKopecks: 999_999,
        durationMinutes: 60,
        isActive: false,
      },
    });
    const confirmation = await appointments.getConfirmation(input.cancellationToken);
    expect(confirmation).toEqual({ ok: true, confirmation: result.confirmation });
    expect(JSON.stringify(confirmation)).not.toContain("cancellationTokenHash");
    expect(JSON.stringify(confirmation)).not.toContain("requestHash");
  });

  it("delegates ANY choice to scheduling, records ANY and rechecks its selected master", async () => {
    const data = await fixture(2);
    const first = success(await booking.createBooking(inputFor(data)));
    const input = inputFor(data, true);
    const selected = await scheduling.selectAnyMaster({
      serviceId: input.serviceId,
      localDate: input.localDate,
      startsAt: new Date(input.startsAt),
    });
    const spy = vi.spyOn(SchedulingAvailabilityService.prototype, "checkMasterInterval");
    const result = success(await booking.createBooking(input));
    expect(result.confirmation.master.id).toBe(selected.selectedMaster?.id);
    expect(result.confirmation.master.id).not.toBe(first.confirmation.master.id);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ masterId: result.confirmation.master.id }),
    );
    expect(
      await database.appointment.findUnique({ where: { id: result.confirmation.id } }),
    ).toMatchObject({ masterSelection: "ANY" });
  });

  it("validates all input at the service boundary without writing anything", async () => {
    const data = await fixture();
    const input = inputFor(data);
    for (const invalid of [
      null,
      {},
      { ...input, clientName: " " },
      { ...input, clientPhone: "+19990000000" },
      { ...input, startsAt: "not-a-date" },
      { ...input, localDate: "2026-02-30" },
      { ...input, servicePriceSnapshot: 1 },
      { ...input, status: "CANCELLED" },
    ]) {
      expect(await booking.createBooking(invalid)).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
      });
    }
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);
    expect(await database.appointment.count({ where: { masterId: data.masters[0].id } })).toBe(0);
  });

  it.each([
    "inactive-service",
    "inactive-master",
    "unassigned",
    "missing-service",
    "missing-master",
  ])("rejects %s and rolls back the booking request", async (mode) => {
    const data = await fixture();
    const input = inputFor(data);
    if (mode === "inactive-service")
      await database.service.update({ where: { id: data.service.id }, data: { isActive: false } });
    if (mode === "inactive-master")
      await database.master.update({
        where: { id: data.masters[0].id },
        data: { isActive: false },
      });
    if (mode === "unassigned")
      await database.masterService.delete({
        where: { masterId_serviceId: { masterId: data.masters[0].id, serviceId: data.service.id } },
      });
    if (mode === "missing-service") input.serviceId = randomUUID();
    if (mode === "missing-master") input.master = { type: "SPECIFIC", masterId: randomUUID() };
    expect(await booking.createBooking(input)).toMatchObject({
      ok: false,
      code: "REQUEST_REJECTED",
      reason:
        mode === "inactive-service"
          ? "INACTIVE_SERVICE"
          : mode === "missing-service"
            ? "SERVICE_NOT_FOUND"
            : "MASTER_NOT_ELIGIBLE",
    });
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);
  });

  it("returns empty availability for ANY without eligible masters", async () => {
    const data = await fixture(0);
    const input = inputFor(data, true);
    expect(await booking.createBooking(input)).toMatchObject({
      ok: false,
      code: "SLOT_UNAVAILABLE",
      availability: { slots: [] },
    });
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);
  });

  it.each([
    { startsAt: "2026-10-05T07:01:00Z" },
    { startsAt: "2026-10-05T15:45:00Z" },
    { startsAt: "2026-10-06T07:00:00Z" },
  ])("does not book an off-grid, out-of-hours or date-mismatched interval %#", async (override) => {
    const input = { ...inputFor(await fixture()), ...override };
    const result = await booking.createBooking(input);
    expect(result).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);
  });

  it("applies the horizon and current-time check through scheduling", async () => {
    const data = await fixture();
    expect(
      await booking.createBooking({
        ...inputFor(data),
        localDate: "2026-11-09",
        startsAt: "2026-11-09T07:00:00Z",
      }),
    ).toMatchObject({ ok: false, code: "REQUEST_REJECTED", reason: "BOOKING_DATE_OUT_OF_RANGE" });
    const later = createBookingService(database, { now: () => new Date("2026-10-05T07:01:00Z") });
    expect(await later.createBooking(inputFor(data))).toMatchObject({
      ok: false,
      code: "SLOT_UNAVAILABLE",
    });
  });

  it("returns fresh availability for an occupied slot without leaving a request behind", async () => {
    const data = await fixture();
    success(await booking.createBooking(inputFor(data)));
    const input = inputFor(data);
    const result = await booking.createBooking(input);
    if (result.ok || result.code !== "SLOT_UNAVAILABLE")
      throw new Error("Expected an unavailable slot");
    expect(result.availability.slots.length).toBeGreaterThan(0);
    expect(
      result.availability.slots.some(
        (slot) => slot.startsAt.toISOString() === "2026-10-05T07:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);
  });

  it("permits only one of two concurrent requests for overlapping intervals", async () => {
    const data = await fixture();
    synchronizeTwoChecks();
    const results = await Promise.all([
      booking.createBooking(inputFor(data)),
      secondBooking.createBooking({ ...inputFor(data), startsAt: "2026-10-05T07:15:00Z" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ code: "SLOT_UNAVAILABLE" }]);
    expect(await database.appointment.count({ where: { masterId: data.masters[0].id } })).toBe(1);
    expect(
      await database.appointmentStatusHistory.count({
        where: { appointment: { masterId: data.masters[0].id } },
      }),
    ).toBe(1);
  });

  it("replays sequential and parallel submissions with one appointment, link and initial history", async () => {
    const data = await fixture();
    const input = inputFor(data);
    const results = await Promise.all([
      booking.createBooking(input),
      secondBooking.createBooking(input),
    ]);
    const first = success(results[0]);
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    expect(success(results[1]).confirmation.id).toBe(first.confirmation.id);
    const replay = success(
      await booking.createBooking({
        ...input,
        clientPhone: "+7 999 000 00 00",
        startsAt: new Date(input.startsAt),
      }),
    );
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(1);
    expect(await history(first.confirmation.id)).toHaveLength(1);
    expect(await appointments.getConfirmation(first.cancellationToken)).toEqual({
      ok: true,
      confirmation: first.confirmation,
    });
  });

  it("rejects the same key with changed data, including a parallel changed submission", async () => {
    const data = await fixture();
    const input = inputFor(data);
    const results = await Promise.all([
      booking.createBooking(input),
      secondBooking.createBooking({ ...input, clientName: "Другой Вымышленный Клиент" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "IDEMPOTENCY_CONFLICT" },
    ]);
    const winner = results[0].ok ? input : { ...input, clientName: "Другой Вымышленный Клиент" };
    for (const override of [
      { clientPhone: "+79990000001" },
      { serviceId: randomUUID() },
      { master: { type: "ANY" } },
      { startsAt: "2026-10-05T08:00:00Z" },
      { localDate: "2026-10-06" },
    ]) {
      expect(await booking.createBooking({ ...winner, ...override })).toEqual({
        ok: false,
        code: "IDEMPOTENCY_CONFLICT",
      });
    }
    expect(await database.appointment.count({ where: { masterId: data.masters[0].id } })).toBe(1);
  });

  it("requires the original secret for a lost-response replay and never rotates the issued link", async () => {
    const input = inputFor(await fixture());
    const original = success(await booking.createBooking(input));
    const wrongToken = prepareBookingAttempt().cancellationToken;
    expect(await booking.createBooking({ ...input, cancellationToken: wrongToken })).toEqual({
      ok: false,
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(await appointments.getConfirmation(wrongToken)).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await appointments.cancelBooking({ token: wrongToken, confirmed: true })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await appointments.getConfirmation(original.confirmation.id)).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await appointments.getConfirmation(null)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(success(await secondBooking.createBooking(input))).toEqual({
      ...original,
      replayed: true,
    });
    expect(await appointments.getConfirmation(input.cancellationToken)).toEqual({
      ok: true,
      confirmation: original.confirmation,
    });
  });

  it("returns the original ANY booking after catalog changes, cancellation and the date leaving the horizon", async () => {
    const data = await fixture(2);
    const input = inputFor(data, true);
    const original = success(await booking.createBooking(input));
    await appointments.cancelBooking({ token: input.cancellationToken, confirmed: true });
    await database.service.update({
      where: { id: data.service.id },
      data: { isActive: false, priceKopecks: 555_000, durationMinutes: 90 },
    });
    const future = createBookingService(database, { now: () => new Date("2027-01-01T00:00:00Z") });
    const replay = success(await future.createBooking(input));
    expect(replay).toMatchObject({
      replayed: true,
      cancellationToken: input.cancellationToken,
      confirmation: {
        id: original.confirmation.id,
        status: "CANCELLED",
        service: original.confirmation.service,
        master: original.confirmation.master,
      },
    });
    expect(await history(original.confirmation.id)).toHaveLength(2);
  });

  it("treats legacy requests without a fingerprint as conflicts, not authenticated replays", async () => {
    const input = inputFor(await fixture());
    const original = success(await booking.createBooking(input));
    await database.bookingRequest.update({
      where: { idempotencyKey: input.idempotencyKey },
      data: { requestHash: null },
    });
    expect(await booking.createBooking(input)).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await appointments.getConfirmation(input.cancellationToken)).toEqual({
      ok: true,
      confirmation: original.confirmation,
    });
  });

  it("does not cancel on read or without explicit confirmation", async () => {
    const input = inputFor(await fixture());
    const original = success(await booking.createBooking(input));
    await appointments.getConfirmation(input.cancellationToken);
    expect(await appointments.cancelBooking({ token: input.cancellationToken })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(
      await appointments.cancelBooking({ token: input.cancellationToken, confirmed: false }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await appointments.getConfirmation(input.cancellationToken)).toEqual({
      ok: true,
      confirmation: original.confirmation,
    });
    expect(await history(original.confirmation.id)).toHaveLength(1);
  });

  it("cancels once, retains original data and first reason, and releases the interval", async () => {
    const data = await fixture();
    const input = inputFor(data);
    const original = success(await booking.createBooking(input));
    const cancelled = await appointments.cancelBooking({
      token: input.cancellationToken,
      confirmed: true,
      reason: "  Изменились планы  ",
    });
    expect(cancelled).toMatchObject({
      ok: true,
      alreadyCancelled: false,
      confirmation: {
        ...original.confirmation,
        status: "CANCELLED",
        cancelledBy: "CLIENT",
        cancelledAt: clock.now(),
        cancellationReason: "Изменились планы",
      },
    });
    const replay = await appointments.cancelBooking({
      token: input.cancellationToken,
      confirmed: true,
      reason: "Другая причина",
    });
    expect(replay).toEqual({ ...cancelled, alreadyCancelled: true });
    expect(await history(original.confirmation.id)).toMatchObject([
      { previousStatus: null, newStatus: "SCHEDULED" },
      {
        previousStatus: "SCHEDULED",
        newStatus: "CANCELLED",
        changedBy: "CLIENT",
        changedAt: clock.now(),
        reason: "Изменились планы",
      },
    ]);
    const available = await scheduling.checkMasterInterval({
      serviceId: data.service.id,
      masterId: data.masters[0].id,
      localDate: input.localDate,
      startsAt: new Date(input.startsAt),
    });
    expect(available.isAvailable).toBe(true);
    expect(success(await booking.createBooking(inputFor(data))).confirmation.id).not.toBe(
      original.confirmation.id,
    );
  });

  it("makes parallel cancellations safe without duplicate history or overwriting the winner", async () => {
    const input = inputFor(await fixture());
    const original = success(await booking.createBooking(input));
    const results = await Promise.all([
      appointments.cancelBooking({
        token: input.cancellationToken,
        confirmed: true,
        reason: "Первая причина",
      }),
      secondAppointments.cancelBooking({
        token: input.cancellationToken,
        confirmed: true,
        reason: "Вторая причина",
      }),
    ]);
    expect(results.filter((result) => result.ok && !result.alreadyCancelled)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.alreadyCancelled)).toHaveLength(1);
    if (!results[0].ok || !results[1].ok) throw new Error("Expected successful cancellations");
    expect(results[0].confirmation).toEqual(results[1].confirmation);
    expect(await history(original.confirmation.id)).toHaveLength(2);
  });

  it("rolls back cancellation if writing its history fails", async () => {
    const input = inputFor(await fixture());
    const original = success(await booking.createBooking(input));
    const failure = new Error("Simulated history storage failure");
    const failingDatabase = database.$extends({
      query: {
        appointmentStatusHistory: {
          async create() {
            throw failure;
          },
        },
      },
    });
    // The extension retains the real transactional Prisma client; only this write fails.
    const failingService = createClientAppointmentService(
      failingDatabase as unknown as typeof database,
      clock,
    );
    await expect(
      failingService.cancelBooking({ token: input.cancellationToken, confirmed: true }),
    ).rejects.toBe(failure);
    expect(await appointments.getConfirmation(input.cancellationToken)).toEqual({
      ok: true,
      confirmation: original.confirmation,
    });
    expect(await history(original.confirmation.id)).toHaveLength(1);
    expect(
      await appointments.cancelBooking({ token: input.cancellationToken, confirmed: true }),
    ).toMatchObject({ ok: true, alreadyCancelled: false });
    expect(await history(original.confirmation.id)).toHaveLength(2);
  });

  it("allows cancellation of a past SCHEDULED appointment without a new cutoff", async () => {
    const input = inputFor(await fixture());
    success(await booking.createBooking(input));
    const late = createClientAppointmentService(database, {
      now: () => new Date("2027-01-01T00:00:00Z"),
    });
    expect(
      await late.cancelBooking({ token: input.cancellationToken, confirmed: true }),
    ).toMatchObject({ ok: true, confirmation: { status: "CANCELLED", cancellationReason: null } });
  });

  it.each(["COMPLETED", "NO_SHOW"] as const)(
    "does not let the client cancel %s",
    async (status) => {
      const input = inputFor(await fixture());
      const original = success(await booking.createBooking(input));
      await database.appointment.update({
        where: { id: original.confirmation.id },
        data: { status },
      });
      expect(
        await appointments.cancelBooking({ token: input.cancellationToken, confirmed: true }),
      ).toEqual({ ok: false, code: "STATUS_NOT_CANCELLABLE", status });
      expect(await history(original.confirmation.id)).toHaveLength(1);
      expect(
        await database.appointment.findUnique({ where: { id: original.confirmation.id } }),
      ).toMatchObject({ status, cancelledAt: null, cancelledBy: null });
    },
  );

  it("propagates a different unique constraint and rolls back the entire failed booking", async () => {
    const data = await fixture(2);
    const input = inputFor(data);
    success(await booking.createBooking(input));
    const second = {
      ...inputFor(data),
      master: { type: "SPECIFIC", masterId: data.masters[1].id },
      cancellationToken: input.cancellationToken,
    };
    await expect(booking.createBooking(second)).rejects.toMatchObject({ code: "P2002" });
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: second.idempotencyKey } }),
    ).toBe(0);
    expect(await database.appointment.count({ where: { masterId: data.masters[1].id } })).toBe(0);
    expect(
      await database.appointmentStatusHistory.count({
        where: { appointment: { serviceId: data.service.id } },
      }),
    ).toBe(1);
  });

  it("verifies the actual Prisma overlap shape and translates a concurrent SQL writer's conflict", async () => {
    const data = await fixture();
    const input = inputFor(data);
    const originalCheck = SchedulingAvailabilityService.prototype.checkMasterInterval;
    let injected = false;
    let blockingId = "";
    vi.spyOn(SchedulingAvailabilityService.prototype, "checkMasterInterval").mockImplementation(
      async function (this: SchedulingAvailabilityService, query) {
        const checked = await originalCheck.call(this, query);
        if (!injected) {
          injected = true;
          const attempt = prepareBookingAttempt();
          keys.push(attempt.idempotencyKey);
          const blocking = await secondDatabase.$transaction(async (tx) => {
            const request = await tx.bookingRequest.create({
              data: { idempotencyKey: attempt.idempotencyKey },
            });
            return tx.appointment.create({
              data: {
                masterId: data.masters[0].id,
                serviceId: data.service.id,
                bookingRequestId: request.id,
                startsAt: new Date(input.startsAt),
                endsAt: new Date("2026-10-05T07:30:00Z"),
                clientName: "Вымышленный конкурент SQL",
                clientPhone: "+79990000000",
                source: "ADMIN",
                masterSelection: "SPECIFIC",
                serviceNameSnapshot: data.service.name,
                servicePriceSnapshot: data.service.priceKopecks,
                serviceDurationSnapshot: 30,
                cancellationTokenHash: hashBookingToken(attempt.cancellationToken),
              },
            });
          });
          blockingId = blocking.id;
        }
        return checked;
      },
    );
    const result = await booking.createBooking(input);
    expect(result).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    if (result.ok || result.code !== "SLOT_UNAVAILABLE")
      throw new Error("Expected overlap conflict");
    expect(
      result.availability.slots.some(
        (slot) => slot.startsAt.getTime() === new Date(input.startsAt).getTime(),
      ),
    ).toBe(false);
    expect(
      await database.bookingRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);

    // Deterministic write against the committed blocker captures the real adapter error.
    const blocked = await database.appointment.findUniqueOrThrow({ where: { id: blockingId } });
    let observed: unknown;
    try {
      await database.$transaction(async (tx) => {
        const attempt = prepareBookingAttempt();
        const request = await tx.bookingRequest.create({
          data: { idempotencyKey: attempt.idempotencyKey },
        });
        await tx.appointment.create({
          data: {
            ...blocked,
            id: randomUUID(),
            bookingRequestId: request.id,
            cancellationTokenHash: hashBookingToken(attempt.cancellationToken),
          },
        });
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((observed as Prisma.PrismaClientKnownRequestError).code).toBe("P2039");
    expect(isAppointmentOverlap(observed)).toBe(true);
  });
});
