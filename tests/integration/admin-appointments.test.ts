import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { AppointmentStatus } from "../../src/generated/prisma/client";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createAppointmentsBoundary } from "../../src/server/admin/appointments-boundary";
import { createSettingsBoundary } from "../../src/server/admin/settings-boundary";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import * as auth from "../../src/modules/auth/server/auth-service";
import * as appointmentReads from "../../src/modules/appointments/server/admin-appointments";
import { businessContextHash } from "../../src/modules/settings/server/context";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { createAdminBookingService } from "../../src/modules/booking/server/admin-booking-service";
import {
  hashBookingRequest,
  hashBookingToken,
  prepareBookingAttempt,
} from "../../src/modules/booking/server/booking-security";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import {
  getLocalDayInterval,
  localDateForInstant,
} from "../../src/modules/scheduling/time/business-time";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/zaprosto_test_[a-f0-9]+$/.test(new URL(url).pathname))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url),
  other = createPrismaClient(url);
const boundary = createAppointmentsBoundary(db),
  second = createAppointmentsBoundary(other);
const clients = createClientAppointmentService(other);
const headers = new Headers({ origin: "https://salon.example" });
let token: string, adminId: string, masterId: string, serviceId: string;
async function clear() {
  await db.appointment.deleteMany();
  await db.bookingRequest.deleteMany();
  await db.master.deleteMany();
  await db.service.deleteMany();
  await db.adminSession.deleteMany();
  await db.adminUser.deleteMany();
}
beforeEach(async () => {
  vi.stubEnv("PUBLIC_ORIGIN", "https://salon.example");
  await clear();
  await db.businessSettings.upsert({
    where: { id: 1 },
    create: { businessName: "Test" },
    update: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  token = randomBytes(32).toString("base64url");
  adminId = (
    await db.adminUser.create({
      data: {
        login: "appointments.test",
        passwordHash: "fixture-no-login",
        sessions: {
          create: { tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600000) },
        },
      },
    })
  ).id;
  serviceId = (
    await db.service.create({
      data: { name: "Historical service", priceKopecks: 123456, durationMinutes: 35 },
    })
  ).id;
  masterId = (
    await db.master.create({
      data: {
        name: "Historical master",
        services: { create: { serviceId } },
        weeklyWorkIntervals: {
          create: Array.from({ length: 7 }, (_, i) => ({
            dayOfWeek: i + 1,
            startsAt: new Date("1970-01-01T09:00Z"),
            endsAt: new Date("1970-01-01T18:00Z"),
          })),
        },
      },
    })
  ).id;
});
afterAll(async () => {
  await clear();
  vi.unstubAllEnvs();
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  await db.$disconnect();
  await other.$disconnect();
});
async function fixture(
  status: AppointmentStatus = "SCHEDULED",
  start = new Date("2026-01-15T07:00Z"),
  master = masterId,
) {
  const secret = prepareBookingAttempt();
  const appointment = await db.appointment.create({
    data: {
      bookingRequest: { create: { idempotencyKey: secret.idempotencyKey } },
      master: { connect: { id: master } },
      service: { connect: { id: serviceId } },
      startsAt: start,
      endsAt: new Date(start.getTime() + 35 * 60000),
      clientName: "Private test client",
      clientPhone: "+79990000000",
      status,
      source: "ONLINE",
      masterSelection: "SPECIFIC",
      serviceNameSnapshot: "Historical service",
      servicePriceSnapshot: 123456,
      serviceDurationSnapshot: 35,
      cancellationTokenHash: hashBookingToken(secret.cancellationToken),
      ...(status === "CANCELLED"
        ? { cancelledAt: new Date(0), cancelledBy: "CLIENT" as const }
        : {}),
      statusHistory: { create: { previousStatus: null, newStatus: status, changedBy: "CLIENT" } },
    },
  });
  return { ...appointment, token: secret.cancellationToken };
}
async function input(id: string, status: AppointmentStatus = "CANCELLED") {
  const r = await boundary.detail(token, id, {});
  if (!r.ok) throw new Error("Expected readable fixture");
  return {
    id,
    status,
    version: r.detail.appointment.version,
    expectedBusinessContext: r.detail.businessContext,
    confirmed: true,
  };
}
async function contactInput(
  id: string,
  clientName = "Исправленный вымышленный клиент",
  clientPhone = "8 (999) 111-22-33",
) {
  const appointment = await db.appointment.findUniqueOrThrow({ where: { id } });
  return { id, version: appointment.version, clientName, clientPhone };
}
const stored = (id: string) =>
  db.appointment.findUniqueOrThrow({
    where: { id },
    include: { statusHistory: { orderBy: { id: "asc" } } },
  });
async function list(q: Record<string, unknown> = {}) {
  const r = await boundary.list(token, q);
  if (!r.ok) throw new Error("Expected list: " + r.code);
  return r.journal;
}
it("today uses business zone, past/future filters, default cancelled exclusion, snapshots and inactive masters", async () => {
  const a = await fixture(),
    c = await fixture("CANCELLED");
  await db.service.update({
    where: { id: serviceId },
    data: { name: "New catalog", priceKopecks: 999, durationMinutes: 60, isActive: false },
  });
  await db.master.update({ where: { id: masterId }, data: { isActive: false } });
  const before = await stored(a.id);
  const rows = (await list({ date: "2026-01-15" })).appointments;
  expect(rows.map((a) => a.id)).toEqual([a.id]);
  expect(rows[0]).toMatchObject({
    serviceNameSnapshot: "Historical service",
    servicePriceSnapshot: 123456,
    serviceDurationSnapshot: 35,
    master: { isActive: false },
  });
  expect(
    (await list({ date: "2026-01-15", status: "CANCELLED" })).appointments.map((a) => a.id),
  ).toEqual([c.id]);
  expect((await list({ date: "2026-01-15", status: "ALL", masterId })).appointments).toHaveLength(
    2,
  );
  await fixture("SCHEDULED", new Date("2099-01-01T10:00Z"));
  expect((await list({ date: "2099-01-01" })).appointments).toHaveLength(1);
  await db.businessSettings.update({
    where: { id: 1 },
    data: { timezone: "Pacific/Kiritimati", bookingHorizonDays: 7 },
  });
  expect((await list()).query.date).toBe(localDateForInstant(new Date(), "Pacific/Kiritimati"));
  const detail = await boundary.detail(token, a.id, {});
  expect(detail).toMatchObject({
    ok: true,
    detail: { appointment: { clientPhone: "+79990000000" } },
  });
  for (const value of [detail, rows])
    expect(JSON.stringify(value)).not.toMatch(
      /cancellationTokenHash|bookingRequest|passwordHash|tokenHash|notificationJobs|telegram/,
    );
  expect(JSON.stringify(rows)).not.toContain("+79990000000");
  expect(await stored(a.id)).toEqual(before);
});
it.each([
  ["2026-03-29", 23],
  ["2026-10-25", 25],
] as const)("half-open local day %s, DST=%s", async (date, hours) => {
  await db.businessSettings.update({ where: { id: 1 }, data: { timezone: "Europe/Berlin" } });
  const day = getLocalDayInterval(date, "Europe/Berlin");
  expect(day.endsAt.getTime() - day.startsAt.getTime()).toBe(hours * 3600000);
  const ids = [];
  for (const offset of [-1, 0, hours * 3600000 - 1, hours * 3600000])
    ids.push((await fixture("CANCELLED", new Date(day.startsAt.getTime() + offset))).id);
  expect((await list({ date, status: "ALL" })).appointments.map((a) => a.id)).toEqual(
    ids.slice(1, 3),
  );
});
it("pagination is bounded and stable for tied starts, history is not silently truncated", async () => {
  const all: Awaited<ReturnType<typeof fixture>>[] = [];
  for (let i = 0; i < 27; i++) all.push(await fixture("CANCELLED"));
  const one = await list({ date: "2026-01-15", status: "ALL" });
  const two = await list({ date: "2026-01-15", status: "ALL", page: "2" });
  expect(one.appointments).toHaveLength(25);
  expect(one.hasNext).toBe(true);
  expect(two.appointments).toHaveLength(2);
  expect(two.hasNext).toBe(false);
  expect([...one.appointments, ...two.appointments].map((a) => a.id)).toEqual(
    all.map((a) => a.id).sort(),
  );
  await db.appointmentStatusHistory.createMany({
    data: Array.from({ length: 26 }, () => ({
      appointmentId: all[0].id,
      previousStatus: "SCHEDULED",
      newStatus: "CANCELLED",
      changedBy: "SYSTEM",
      changedAt: new Date(0),
    })),
  });
  const h1 = await boundary.detail(token, all[0].id, {}),
    h2 = await boundary.detail(token, all[0].id, { historyPage: "2" });
  if (!h1.ok || !h2.ok) throw Error("history");
  expect(h1.detail.history).toHaveLength(25);
  expect(h1.detail.hasNextHistory).toBe(true);
  expect(h2.detail.history).toHaveLength(2);
  expect(h2.detail.hasNextHistory).toBe(false);
  expect(new Set([...h1.detail.history, ...h2.detail.history].map((h) => h.id)).size).toBe(27);
});
it("master choices are paginated and selected inactive master remains available", async () => {
  await db.master.createMany({
    data: Array.from({ length: 51 }, (_, i) => ({ name: "Master " + i })),
  });
  const first = await list();
  expect(first.masters).toHaveLength(50);
  expect(first.nextMasters).toBeTruthy();
  const last = await list({ mastersAfter: first.nextMasters, masterId: first.masters[0].id });
  expect(last.masters).toHaveLength(3);
  expect(last.nextMasters).toBeNull();
  expect(last.masters[0].id).toBe(first.masters[0].id);
});
const allowed: Record<AppointmentStatus, AppointmentStatus[]> = {
  SCHEDULED: ["CANCELLED", "COMPLETED", "NO_SHOW"],
  COMPLETED: ["NO_SHOW"],
  NO_SHOW: ["COMPLETED"],
  CANCELLED: [],
};
for (const from of Object.keys(allowed) as AppointmentStatus[])
  for (const to of Object.keys(allowed) as AppointmentStatus[])
    it(from + " -> " + to, async () => {
      const a = await fixture(from),
        before = await stored(a.id);
      const result = await boundary.change(headers, token, await input(a.id, to));
      if (allowed[from].includes(to)) {
        expect(result).toEqual({ ok: true, status: to });
        const after = await stored(a.id);
        expect(after.version).toBe(1);
        expect(after.statusHistory).toHaveLength(2);
        expect(after.statusHistory.find((h) => h.previousStatus)).toMatchObject({
          previousStatus: from,
          newStatus: to,
          changedBy: "ADMIN",
          changedByAdminId: adminId,
        });
        for (const key of [
          "startsAt",
          "endsAt",
          "serviceNameSnapshot",
          "servicePriceSnapshot",
          "serviceDurationSnapshot",
          "cancellationTokenHash",
          "bookingRequestId",
          "clientName",
          "clientPhone",
          "source",
          "masterId",
          "serviceId",
        ] as const)
          expect(after[key]).toEqual(before[key]);
      } else {
        expect(result).toMatchObject({ code: "INVALID_TRANSITION" });
        expect(await stored(a.id)).toEqual(before);
      }
    });
it.each(["COMPLETED", "NO_SHOW"] as const)(
  "reject future %s including corrections",
  async (status) => {
    for (const from of ["SCHEDULED", status === "COMPLETED" ? "NO_SHOW" : "COMPLETED"] as const) {
      const a = await fixture(
        from,
        new Date("2099-01-01T10:00Z"),
        (await db.master.create({ data: { name: from } })).id,
      );
      expect(await boundary.change(headers, token, await input(a.id, status))).toMatchObject({
        code: "NOT_STARTED",
      });
      expect((await stored(a.id)).version).toBe(0);
    }
  },
);
it("cancellation confirmation, bounded reason, strict DTO, own session identity and foreign Origin", async () => {
  const a = await fixture(),
    intent = await input(a.id),
    before = await stored(a.id);
  expect(await boundary.change(headers, token, { ...intent, confirmed: false })).toMatchObject({
    code: "CONFIRMATION_REQUIRED",
  });
  for (const extra of [
    { id: "bad" },
    { version: "0" },
    { version: -1 },
    { status: "OTHER" },
    { confirmed: "true" },
    { expectedBusinessContext: undefined },
    { changedBy: "CLIENT" },
    { changedByAdminId: adminId },
    { reason: "x".repeat(1001) },
    { clientPhone: "+79990000000" },
  ])
    expect(await boundary.change(headers, token, { ...intent, ...extra })).toMatchObject({
      code: "INVALID_INPUT",
    });
  expect(
    await boundary.change(
      new Headers({ origin: "https://evil.example", host: "evil.example" }),
      token,
      intent,
    ),
  ).toMatchObject({ code: "FORBIDDEN" });
  expect(await stored(a.id)).toEqual(before);
  expect(
    await boundary.change(headers, token, { ...intent, reason: "  Test reason\nsecond line  " }),
  ).toMatchObject({ ok: true });
  const after = await stored(a.id);
  expect(after).toMatchObject({
    cancellationReason: "Test reason\nsecond line",
    cancelledBy: "ADMIN",
  });
  const history = after.statusHistory.find((h) => h.previousStatus)!;
  expect(history.changedAt).toEqual(after.cancelledAt);
  expect(history.reason).toBe(after.cancellationReason);
});
it("two administrators, duplicate requests and ABA cannot duplicate history", async () => {
  const a = await fixture();
  const secondToken = randomBytes(32).toString("base64url");
  await db.adminUser.create({
    data: {
      login: "other.admin",
      passwordHash: "fixture",
      sessions: {
        create: {
          tokenHash: hashSessionToken(secondToken),
          expiresAt: new Date(Date.now() + 3600000),
        },
      },
    },
  });
  const intent = await input(a.id, "COMPLETED");
  const results = await Promise.all([
    boundary.change(headers, token, intent),
    second.change(headers, secondToken, intent),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok && r.code === "CONFLICT")).toHaveLength(1);
  const old = await input(a.id, "NO_SHOW");
  expect(await boundary.change(headers, token, old)).toMatchObject({ ok: true });
  expect(await boundary.change(headers, token, await input(a.id, "COMPLETED"))).toMatchObject({
    ok: true,
  });
  expect(await boundary.change(headers, token, old)).toMatchObject({ code: "CONFLICT" });
  const after = await stored(a.id);
  expect(after.version).toBe(3);
  expect(after.statusHistory).toHaveLength(4);
});
it.each(["CANCELLED", "COMPLETED", "NO_SHOW"] as const)(
  "client cancellation races admin %s",
  async (status) => {
    const a = await fixture(),
      intent = await input(a.id, status);
    const [admin, client] = await Promise.all([
      boundary.change(headers, token, intent),
      clients.cancelBooking({ token: a.token, confirmed: true, reason: "Client reason" }),
    ]);
    const after = await stored(a.id);
    expect(after.version).toBe(1);
    expect(after.statusHistory).toHaveLength(2);
    expect(after.status === "CANCELLED" || after.status === status).toBe(true);
    if (!admin.ok) expect(admin.code).toBe("CONFLICT");
    if (!client.ok) expect(client.code).toBe("STATUS_NOT_CANCELLABLE");
    const retry = await clients.cancelBooking({
      token: a.token,
      confirmed: true,
      reason: "Different reason",
    });
    expect(retry.ok).toBe(after.status === "CANCELLED");
    expect(await boundary.change(headers, token, intent)).toMatchObject({ code: "CONFLICT" });
    expect(await stored(a.id)).toEqual(after);
  },
);
it("client cancellation increments version seen by stale admin and survives replay", async () => {
  const a = await fixture(),
    intent = await input(a.id);
  await clients.cancelBooking({ token: a.token, confirmed: true });
  expect(await boundary.change(headers, token, intent)).toMatchObject({ code: "CONFLICT" });
  expect((await stored(a.id)).version).toBe(1);
});
it("history failure rolls back status, cancellation fields and version", async () => {
  const a = await fixture(),
    before = await stored(a.id);
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_appointments_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER test_appointments_failure BEFORE INSERT ON appointment_status_history FOR EACH ROW EXECUTE FUNCTION test_appointments_failure()",
  );
  try {
    expect(
      await boundary.change(headers, token, { ...(await input(a.id)), reason: "must roll back" }),
    ).toMatchObject({ code: "UNAVAILABLE" });
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER test_appointments_failure ON appointment_status_history",
    );
    await db.$executeRawUnsafe("DROP FUNCTION test_appointments_failure()");
  }
  expect(await stored(a.id)).toEqual(before);
});
for (const mode of ["missing", "expired", "revoked", "disabled"] as const)
  it("session " + mode + " denies every boundary without contacts", async () => {
    const a = await fixture(),
      intent = await input(a.id),
      before = await stored(a.id);
    if (mode === "expired") await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
    const supplied = mode === "missing" ? undefined : token;
    expect(await boundary.list(supplied, {})).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await boundary.detail(supplied, a.id, {})).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await boundary.change(headers, supplied, intent)).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    expect(await stored(a.id)).toEqual(before);
  });
async function hold(kind: "advisory" | "settings" | "appointment", id: string) {
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      ready = r;
    });
  const holder = other.$transaction(
    async (tx) => {
      if (kind === "advisory") await tx.$executeRaw`SELECT pg_advisory_xact_lock(526008, 52)`;
      if (kind === "settings")
        await tx.$queryRaw`SELECT id FROM business_settings WHERE id = 1 FOR UPDATE`;
      if (kind === "appointment")
        await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id}::uuid FOR UPDATE`;
      ready();
      await gate;
    },
    { timeout: 10000 },
  );
  await started;
  return { release, holder };
}
async function waitLock() {
  await vi.waitFor(
    async () => {
      const rows = await other.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      expect(Number(rows[0].count)).toBeGreaterThan(0);
    },
    { timeout: 3000 },
  );
}
it.each(["advisory", "settings", "appointment"] as const)(
  "revocation while waiting for %s denies write",
  async (kind) => {
    const a = await fixture(),
      intent = await input(a.id),
      before = await stored(a.id),
      gate = await hold(kind, a.id);
    const pending = boundary.change(headers, token, intent);
    try {
      await waitLock();
      await other.adminSession.updateMany({ data: { revokedAt: new Date() } });
    } finally {
      gate.release();
      await gate.holder;
    }
    expect(await pending).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await stored(a.id)).toEqual(before);
  },
);
it("visit begins while waiting: fresh database clock is used", async () => {
  const a = await fixture("SCHEDULED", new Date(Date.now() + 1200)),
    intent = await input(a.id, "COMPLETED");
  expect(await boundary.change(headers, token, intent)).toMatchObject({ code: "NOT_STARTED" });
  const gate = await hold("appointment", a.id),
    pending = boundary.change(headers, token, intent);
  try {
    await waitLock();
    await vi.waitFor(
      async () => {
        const [{ begun }] = await other.$queryRaw<
          Array<{ begun: boolean }>
        >`SELECT clock_timestamp() >= ${a.startsAt}::timestamptz AS begun`;
        expect(begun).toBe(true);
      },
      { timeout: 3000 },
    );
  } finally {
    gate.release();
    await gate.holder;
  }
  expect(await pending).toEqual({ ok: true, status: "COMPLETED" });
  const after = await stored(a.id);
  expect(after.statusHistory.find((h) => h.previousStatus)!.changedAt >= a.startsAt).toBe(true);
});
it("timezone changes and ABA invalidate old intention without touching visits", async () => {
  const a = await fixture(),
    intent = await input(a.id),
    before = await stored(a.id);
  for (const timezone of ["Asia/Kathmandu", "Europe/Moscow"]) {
    const settings = await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(
      await createSettingsBoundary(other).save(headers, token, {
        version: settings.version,
        timezone,
        bookingHorizonDays: "30",
        confirmedTimezoneChange: true,
      }),
    ).toMatchObject({ ok: true });
    expect(await boundary.change(headers, token, intent)).toMatchObject({ code: "CONFLICT" });
    expect(await stored(a.id)).toEqual(before);
  }
});
it.each(["COMPLETED", "NO_SHOW", "CANCELLED"] as const)(
  "only cancellation releases exclusion constraint: %s",
  async (status) => {
    const a = await fixture();
    await boundary.change(headers, token, await input(a.id, status));
    if (status === "CANCELLED") expect((await fixture()).id).not.toBe(a.id);
    else await expect(fixture()).rejects.toThrow();
  },
);
for (const version of [1, 2, 3])
  for (const status of ["COMPLETED", "NO_SHOW", "CANCELLED"] as const)
    it("booking-v" + version + " replay after admin " + status, async () => {
      const service = await db.service.findUniqueOrThrow({ where: { id: serviceId } });
      const request = {
        ...prepareBookingAttempt(),
        serviceId,
        expectedServiceTerms: publicServiceTerms(service).termsHash,
        expectedBusinessContext: businessContextHash(
          await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
        ),
        master: { type: "SPECIFIC" as const, masterId },
        localDate: "2026-01-15",
        startsAt: new Date("2026-01-15T07:00Z"),
        clientName: "Replay client",
        clientPhone: "+79990000000",
      };
      const booking = createBookingService(db, { now: () => new Date("2026-01-01T00:00Z") });
      const result = await booking.createBooking(request);
      if (!result.ok) throw Error(result.code);
      const historic = {
        ...request,
        ...(version < 3 ? { expectedBusinessContext: undefined } : {}),
        ...(version === 1 ? { expectedServiceTerms: undefined } : {}),
      };
      if (version < 3)
        await db.bookingRequest.update({
          where: { idempotencyKey: request.idempotencyKey },
          data: { requestHash: hashBookingRequest(historic) },
        });
      expect(
        await boundary.change(headers, token, await input(result.confirmation.id, status)),
      ).toMatchObject({ ok: true });
      const before = await stored(result.confirmation.id);
      await db.service.update({
        where: { id: serviceId },
        data: { isActive: false, name: "Changed" },
      });
      await db.businessSettings.update({
        where: { id: 1 },
        data: { timezone: "Asia/Kathmandu", version: { increment: 1 }, bookingHorizonDays: 7 },
      });
      const replay = await createBookingService(db).createBooking(historic);
      expect(replay).toMatchObject({
        ok: true,
        replayed: true,
        confirmation: { id: before.id, status, service: { name: "Historical service" } },
        cancellationToken: request.cancellationToken,
        timeZone: "Asia/Kathmandu",
      });
      expect(await stored(before.id)).toEqual(before);
      expect(await db.appointment.count()).toBe(1);
    });
it("invalid read DTOs and not found reveal no private values", async () => {
  for (const q of [
    { date: "2026-02-30" },
    { page: "0" },
    { page: ["1", "2"] },
    { clientPhone: "private" },
    { status: "bad" },
  ])
    expect(await boundary.list(token, q)).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(await boundary.detail(token, "bad", {})).toMatchObject({ code: "INVALID_INPUT" });
  expect(await boundary.detail(token, randomUUID(), {})).toMatchObject({ code: "NOT_FOUND" });
  await db.businessSettings.update({ where: { id: 1 }, data: { timezone: "Pacific/Apia" } });
  expect(await boundary.list(token, { date: "2011-12-30" })).toMatchObject({ code: "INVALID_DAY" });
});

it.each(["expired", "disabled"] as const)("access becomes %s during row wait", async (mode) => {
  const a = await fixture(),
    intent = await input(a.id),
    before = await stored(a.id);
  const gate = await hold("appointment", a.id),
    pending = boundary.change(headers, token, intent);
  try {
    await waitLock();
    if (mode === "expired")
      await other.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    else await other.adminUser.updateMany({ data: { isActive: false } });
  } finally {
    gate.release();
    await gate.holder;
  }
  expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
  expect(await stored(a.id)).toEqual(before);
});
it("context change commits while admin waits for settings row", async () => {
  const a = await fixture(),
    intent = await input(a.id),
    before = await stored(a.id);
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      ready = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const holder = other.$transaction(
    async (tx) => {
      await tx.businessSettings.update({
        where: { id: 1 },
        data: { timezone: "Asia/Kathmandu", version: { increment: 1 } },
      });
      ready();
      await gate;
    },
    { timeout: 10000 },
  );
  await started;
  const pending = boundary.change(headers, token, intent);
  try {
    await waitLock();
  } finally {
    release();
    await holder;
  }
  expect(await pending).toMatchObject({ code: "CONFLICT" });
  expect(await stored(a.id)).toEqual(before);
});
it("unavailable read does not expose underlying error or retry", async () => {
  const error = new Error("sensitive fixture detail");
  const spy = vi.spyOn(db, "$transaction").mockRejectedValueOnce(error);
  try {
    expect(await boundary.list(token, {})).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
it("version overflow rolls back without resetting the counter", async () => {
  const a = await fixture();
  await db.appointment.update({ where: { id: a.id }, data: { version: 2147483647 } });
  const before = await stored(a.id);
  expect(await boundary.change(headers, token, await input(a.id))).toMatchObject({
    code: "UNAVAILABLE",
  });
  expect(await stored(a.id)).toEqual(before);
});

// Keep the real PostgreSQL reads, pausing only after their snapshot has been read.
function interceptRead(kind: "list" | "detail", afterRead: () => Promise<void>) {
  if (kind === "list") {
    const actual = appointmentReads.readJournal;
    return vi.spyOn(appointmentReads, "readJournal").mockImplementation(async (...args) => {
      const result = await actual(...args);
      await afterRead();
      return result;
    });
  }
  const actual = appointmentReads.readAppointment;
  return vi.spyOn(appointmentReads, "readAppointment").mockImplementation(async (...args) => {
    const result = await actual(...args);
    await afterRead();
    return result;
  });
}

function readFixture(kind: "list" | "detail", id: string) {
  return kind === "list"
    ? boundary.list(token, { date: "2026-01-15" })
    : boundary.detail(token, id, {});
}

it.each(["list", "detail"] as const)(
  "parallel %s reads release all 10 default pool connections before final authorization",
  async (kind) => {
    const a = await fixture();
    let arrivals = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = interceptRead(kind, async () => {
      // Every transaction owns one connection before any final check can begin.
      if (++arrivals === 10) release();
      await gate;
    });
    try {
      const results = await Promise.all(Array.from({ length: 10 }, () => readFixture(kind, a.id)));
      expect(arrivals).toBe(10);
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        if ("journal" in result) {
          expect(result.journal.appointments.map((row) => row.id)).toEqual([a.id]);
        } else {
          expect(result.detail.appointment.id).toBe(a.id);
          expect(result.detail.appointment.clientPhone).toBe(a.clientPhone);
        }
      }
    } finally {
      release();
      spy.mockRestore();
    }
  },
);

for (const kind of ["list", "detail"] as const) {
  it.each(["revoked", "expired", "disabled"] as const)(
    kind + " withholds the snapshot when access is %s before final authorization",
    async (mode) => {
      const a = await fixture();
      let dataRead = false,
        finalChecks = 0;
      let initialAuthorized = false,
        readBeforeFinal = false;
      let openTransactions: number | undefined;
      const readSpy = interceptRead(kind, async () => {
        dataRead = true;
      });
      const actual = auth.getActiveAdmin;
      const authSpy = vi
        .spyOn(auth, "getActiveAdmin")
        .mockImplementation(async (client, supplied) => {
          if (client !== db) {
            const admin = await actual(client, supplied);
            initialAuthorized = !!admin;
            return admin;
          }
          finalChecks++;
          readBeforeFinal = dataRead;
          // Inspect the real database from another connection before the fresh auth query.
          const rows = await other.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'idle in transaction'
        `;
          openTransactions = rows[0].count;
          if (mode === "disabled") {
            await other.adminUser.update({ where: { id: adminId }, data: { isActive: false } });
          } else {
            await other.adminSession.update({
              where: { tokenHash: hashSessionToken(token) },
              data: mode === "revoked" ? { revokedAt: new Date() } : { expiresAt: new Date(0) },
            });
          }
          return actual(client, supplied);
        });
      try {
        const result = await readFixture(kind, a.id);
        expect(initialAuthorized).toBe(true);
        expect(readBeforeFinal).toBe(true);
        expect(finalChecks).toBe(1);
        expect(openTransactions).toBe(0);
        expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
        expect(JSON.stringify(result)).not.toContain(a.clientName);
        expect(JSON.stringify(result)).not.toContain(a.clientPhone);
      } finally {
        authSpy.mockRestore();
        readSpy.mockRestore();
      }
    },
  );

  it(kind + " withholds contacts if the final authorization query fails", async () => {
    const a = await fixture();
    let dataRead = false,
      finalChecks = 0;
    const readSpy = interceptRead(kind, async () => {
      dataRead = true;
    });
    const actual = auth.getActiveAdmin;
    const authSpy = vi
      .spyOn(auth, "getActiveAdmin")
      .mockImplementation(async (client, supplied) => {
        if (client !== db) return actual(client, supplied);
        finalChecks++;
        throw new Error("private final authorization failure");
      });
    try {
      expect(await readFixture(kind, a.id)).toEqual({ ok: false, code: "UNAVAILABLE" });
      expect(dataRead).toBe(true);
      expect(finalChecks).toBe(1);
    } finally {
      authSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
}

it.each(["SCHEDULED", "COMPLETED", "NO_SHOW"] as const)(
  "contact correction atomically updates only approved fields for %s",
  async (status) => {
    const a = await fixture(status);
    const before = await stored(a.id);
    const requestBefore = await db.bookingRequest.findUniqueOrThrow({
      where: { id: before.bookingRequestId },
    });
    expect(
      await boundary.updateContacts(headers, token, {
        ...(await contactInput(a.id)),
        clientName: "  Исправленный вымышленный клиент  ",
        clientPhone: "+7 (999) 111-22-33",
      }),
    ).toEqual({ ok: true });
    const after = await stored(a.id);
    expect(after.clientName).toBe("Исправленный вымышленный клиент");
    expect(after.clientPhone).toBe("+79991112233");
    expect(after.version).toBe(before.version + 1);
    for (const key of [
      "status",
      "source",
      "serviceId",
      "masterId",
      "startsAt",
      "endsAt",
      "serviceNameSnapshot",
      "servicePriceSnapshot",
      "serviceDurationSnapshot",
      "cancellationTokenHash",
      "bookingRequestId",
      "cancelledAt",
      "cancelledBy",
      "cancellationReason",
    ] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after.statusHistory).toEqual(before.statusHistory);
    expect(
      await db.bookingRequest.findUniqueOrThrow({ where: { id: before.bookingRequestId } }),
    ).toEqual(requestBefore);
    expect(await db.telegramLinkToken.count({ where: { appointmentId: a.id } })).toBe(0);
    expect(await db.appointmentTelegramConnection.count({ where: { appointmentId: a.id } })).toBe(
      0,
    );
    expect(await db.notificationOutbox.count({ where: { appointmentId: a.id } })).toBe(0);
  },
);

it("cancelled contacts are historical and cannot be edited", async () => {
  const a = await fixture("CANCELLED");
  const before = await stored(a.id);
  expect(await boundary.updateContacts(headers, token, await contactInput(a.id))).toEqual({
    ok: false,
    code: "EDIT_NOT_ALLOWED",
  });
  expect(await stored(a.id)).toEqual(before);
});

it("contact DTO, Origin, not found and failures reveal no private data", async () => {
  const a = await fixture();
  const intent = await contactInput(a.id);
  const before = await stored(a.id);
  for (const extra of [
    { status: "COMPLETED" },
    { source: "ADMIN" },
    { serviceId },
    { masterId },
    { startsAt: new Date() },
    { serviceNameSnapshot: "Server value" },
    { cancellationToken: a.token },
    { cancellationTokenHash: before.cancellationTokenHash },
    { bookingRequestId: before.bookingRequestId },
    { history: [] },
    { adminId },
    { expectedBusinessContext: "a".repeat(64) },
    { version: "0" },
    { id: "bad" },
    { clientPhone: "+19990000000" },
  ]) {
    const result = await boundary.updateContacts(headers, token, { ...intent, ...extra });
    expect(result).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify(result)).not.toMatch(
      /Исправленный|7999|token|hash|cancellation|session/i,
    );
  }
  expect(
    await boundary.updateContacts(
      new Headers({ origin: "https://evil.example", host: "evil.example" }),
      token,
      intent,
    ),
  ).toEqual({ ok: false, code: "FORBIDDEN" });
  const missing = await boundary.updateContacts(headers, token, {
    ...intent,
    id: randomUUID(),
  });
  expect(missing).toEqual({ ok: false, code: "NOT_FOUND" });
  expect(JSON.stringify(missing)).not.toContain(intent.clientName);
  expect(await stored(a.id)).toEqual(before);
});

it("two forms and contact ABA preserve one atomic intention", async () => {
  const a = await fixture();
  const original = await contactInput(a.id);
  const [one, two] = await Promise.all([
    boundary.updateContacts(headers, token, {
      ...original,
      clientName: "Первая форма",
      clientPhone: "8 999 111-11-11",
    }),
    second.updateContacts(headers, token, {
      ...original,
      clientName: "Вторая форма",
      clientPhone: "8 999 222-22-22",
    }),
  ]);
  expect([one, two].filter((result) => result.ok)).toHaveLength(1);
  expect([one, two].filter((result) => !result.ok && result.code === "CONFLICT")).toHaveLength(1);
  const afterRace = await stored(a.id);
  expect([
    ["Первая форма", "+79991111111"],
    ["Вторая форма", "+79992222222"],
  ]).toContainEqual([afterRace.clientName, afterRace.clientPhone]);
  expect(afterRace.version).toBe(1);

  expect(
    await boundary.updateContacts(headers, token, {
      ...(await contactInput(a.id)),
      clientName: "Private test client",
      clientPhone: "+79990000000",
    }),
  ).toEqual({ ok: true });
  expect(await boundary.updateContacts(headers, token, original)).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect((await stored(a.id)).version).toBe(2);
});

it("contact correction races administrative status without lost updates", async () => {
  const a = await fixture();
  const contacts = await contactInput(a.id);
  const status = await input(a.id, "COMPLETED");
  const [contactResult, statusResult] = await Promise.all([
    boundary.updateContacts(headers, token, contacts),
    second.change(headers, token, status),
  ]);
  expect([contactResult, statusResult].filter((result) => result.ok)).toHaveLength(1);
  expect(
    [contactResult, statusResult].filter((result) => !result.ok && result.code === "CONFLICT"),
  ).toHaveLength(1);
  const after = await stored(a.id);
  expect(after.version).toBe(1);
  if (contactResult.ok) {
    expect(after).toMatchObject({
      status: "SCHEDULED",
      clientName: "Исправленный вымышленный клиент",
      clientPhone: "+79991112233",
    });
    expect(after.statusHistory).toHaveLength(1);
  } else {
    expect(after).toMatchObject({
      status: "COMPLETED",
      clientName: "Private test client",
      clientPhone: "+79990000000",
    });
    expect(after.statusHistory).toHaveLength(2);
  }
});

it("client cancellation and correction serialize in either valid order", async () => {
  const cancelledFirst = await fixture();
  const stale = await contactInput(cancelledFirst.id);
  expect(
    await clients.cancelBooking({ token: cancelledFirst.token, confirmed: true }),
  ).toMatchObject({ ok: true });
  expect(await boundary.updateContacts(headers, token, stale)).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect(
    await boundary.updateContacts(headers, token, await contactInput(cancelledFirst.id)),
  ).toEqual({ ok: false, code: "EDIT_NOT_ALLOWED" });

  const editedFirst = await fixture("SCHEDULED", new Date("2026-01-15T08:00Z"));
  expect(await boundary.updateContacts(headers, token, await contactInput(editedFirst.id))).toEqual(
    { ok: true },
  );
  expect(await clients.cancelBooking({ token: editedFirst.token, confirmed: true })).toMatchObject({
    ok: true,
  });
  const after = await stored(editedFirst.id);
  expect(after).toMatchObject({
    status: "CANCELLED",
    version: 2,
    clientName: "Исправленный вымышленный клиент",
    clientPhone: "+79991112233",
  });
  expect(after.statusHistory).toHaveLength(2);
});

it("a concurrent client cancellation has no partial or lost contact update", async () => {
  const a = await fixture();
  const [edit, cancel] = await Promise.all([
    boundary.updateContacts(headers, token, await contactInput(a.id)),
    clients.cancelBooking({ token: a.token, confirmed: true }),
  ]);
  expect(cancel).toMatchObject({ ok: true });
  const after = await stored(a.id);
  expect(after.status).toBe("CANCELLED");
  if (edit.ok) {
    expect(after).toMatchObject({
      version: 2,
      clientName: "Исправленный вымышленный клиент",
      clientPhone: "+79991112233",
    });
  } else {
    expect(edit.code).toBe("CONFLICT");
    expect(after).toMatchObject({
      version: 1,
      clientName: "Private test client",
      clientPhone: "+79990000000",
    });
  }
});

for (const mode of ["missing", "expired", "revoked", "disabled"] as const)
  it("contact correction denies " + mode + " session without private data", async () => {
    const a = await fixture();
    const intent = await contactInput(a.id);
    const before = await stored(a.id);
    if (mode === "expired") await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
    const result = await boundary.updateContacts(
      headers,
      mode === "missing" ? undefined : token,
      intent,
    );
    expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(JSON.stringify(result)).not.toContain(intent.clientName);
    expect(JSON.stringify(result)).not.toContain(intent.clientPhone);
    expect(await stored(a.id)).toEqual(before);
  });

it("revocation while contact correction waits for the appointment denies the write", async () => {
  const a = await fixture();
  const before = await stored(a.id);
  const gate = await hold("appointment", a.id);
  const pending = boundary.updateContacts(headers, token, await contactInput(a.id));
  try {
    await waitLock();
    await other.adminSession.updateMany({ data: { revokedAt: new Date() } });
  } finally {
    gate.release();
    await gate.holder;
  }
  expect(await pending).toEqual({ ok: false, code: "UNAUTHORIZED" });
  expect(await stored(a.id)).toEqual(before);
});

it("revocation after the appointment read but before save denies the write", async () => {
  const a = await fixture();
  const before = await stored(a.id);
  const actual = auth.getActiveAdminForShare;
  const spy = vi
    .spyOn(auth, "getActiveAdminForShare")
    .mockImplementation(async (client, supplied) => {
      await other.adminSession.updateMany({ data: { revokedAt: new Date() } });
      return actual(client, supplied);
    });
  try {
    expect(await boundary.updateContacts(headers, token, await contactInput(a.id))).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
  } finally {
    spy.mockRestore();
  }
  expect(await stored(a.id)).toEqual(before);
});

it("unknown contact outcome is unavailable, redacted and never retried", async () => {
  const a = await fixture();
  const intent = await contactInput(a.id);
  const spy = vi
    .spyOn(db, "$transaction")
    .mockRejectedValueOnce(new Error("private +79990000000 hash token session"));
  try {
    const result = await boundary.updateContacts(headers, token, intent);
    expect(result).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toMatch(/7999|hash|token|session|Исправленный/i);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

it("a failed contact UPDATE rolls back both fields and version", async () => {
  const a = await fixture();
  const before = await stored(a.id);
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_contacts_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER test_contacts_failure BEFORE UPDATE OF client_name, client_phone ON appointments FOR EACH ROW EXECUTE FUNCTION test_contacts_failure()",
  );
  try {
    expect(await boundary.updateContacts(headers, token, await contactInput(a.id))).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER test_contacts_failure ON appointments");
    await db.$executeRawUnsafe("DROP FUNCTION test_contacts_failure()");
  }
  expect(await stored(a.id)).toEqual(before);
});

it("protected client view and public replay return corrected contacts", async () => {
  const service = await db.service.findUniqueOrThrow({ where: { id: serviceId } });
  const request = {
    ...prepareBookingAttempt(),
    serviceId,
    expectedServiceTerms: publicServiceTerms(service).termsHash,
    expectedBusinessContext: businessContextHash(
      await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
    ),
    master: { type: "SPECIFIC" as const, masterId },
    localDate: "2026-01-15",
    startsAt: new Date("2026-01-15T08:00Z"),
    clientName: "Replay client",
    clientPhone: "+79990000000",
  };
  const booking = createBookingService(db, { now: () => new Date("2026-01-01T00:00Z") });
  const created = await booking.createBooking(request);
  if (!created.ok) throw new Error(created.code);
  expect(
    await boundary.updateContacts(headers, token, {
      ...(await contactInput(created.confirmation.id)),
      clientName: "Исправленный replay",
      clientPhone: "8 999 444-55-66",
    }),
  ).toEqual({ ok: true });
  expect(await clients.getConfirmation(request.cancellationToken)).toMatchObject({
    ok: true,
    confirmation: { clientName: "Исправленный replay", clientPhone: "+79994445566" },
  });
  expect(await booking.createBooking(request)).toMatchObject({
    ok: true,
    replayed: true,
    confirmation: {
      id: created.confirmation.id,
      clientName: "Исправленный replay",
      clientPhone: "+79994445566",
    },
  });
  expect(await db.appointment.count()).toBe(1);
});

it("administrative replay returns corrected contacts without a new booking", async () => {
  const service = await db.service.findUniqueOrThrow({ where: { id: serviceId } });
  const request = {
    ...prepareBookingAttempt(),
    serviceId,
    expectedServiceTerms: publicServiceTerms(service).termsHash,
    expectedBusinessContext: businessContextHash(
      await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
    ),
    master: { type: "SPECIFIC" as const, masterId },
    localDate: "2026-01-15",
    startsAt: new Date("2026-01-15T08:00Z"),
    clientName: "Admin replay",
    clientPhone: "+79990000000",
    confirmed: true as const,
  };
  const booking = createAdminBookingService(db, { now: () => new Date("2026-01-01T00:00Z") });
  const created = await booking.createBooking(token, request);
  if (!created.ok) throw new Error(created.code);
  expect(
    await boundary.updateContacts(headers, token, {
      ...(await contactInput(created.confirmation.id)),
      clientName: "Исправленный admin replay",
      clientPhone: "8 999 777-88-99",
    }),
  ).toEqual({ ok: true });
  expect(await booking.createBooking(token, request)).toMatchObject({
    ok: true,
    replayed: true,
    confirmation: {
      id: created.confirmation.id,
      clientName: "Исправленный admin replay",
      clientPhone: "+79997778899",
    },
  });
  expect(await db.appointment.count()).toBe(1);
});
