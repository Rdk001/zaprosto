import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createSettingsBoundary } from "../../src/server/admin/settings-boundary";
import { createScheduleBoundary } from "../../src/server/admin/schedule-boundary";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import { businessContextHash, readTimeContext } from "../../src/modules/settings/server/context";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import {
  prepareBookingAttempt,
  hashBookingToken,
} from "../../src/modules/booking/server/booking-security";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import { createPublicBoundary } from "../../src/server/public/boundary";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/zaprosto_test_[a-f0-9]+$/.test(new URL(url).pathname))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url),
  other = createPrismaClient(url);
const boundary = createSettingsBoundary(db),
  second = createSettingsBoundary(other);
const schedule = createScheduleBoundary(db);
const h = new Headers({ origin: "https://salon.example" });
const clock = { now: () => new Date("2026-10-01T00:00Z") };
const booking = createBookingService(db, clock),
  appointments = createClientAppointmentService(db, clock);
const publicBoundary = createPublicBoundary({
  database: db,
  clock,
  booking,
  appointments,
  limit: async () => true,
});
let token: string, masterId: string, serviceId: string;
const settings = () => db.businessSettings.findUniqueOrThrow({ where: { id: 1 } });
async function input(extra: Record<string, unknown> = {}) {
  const s = await settings();
  return {
    version: s.version,
    timezone: s.timezone,
    bookingHorizonDays: String(s.bookingHorizonDays),
    confirmedTimezoneChange: false,
    ...extra,
  };
}
async function bookInput(any = false, localDate = "2026-10-20") {
  const s = await db.service.findUniqueOrThrow({ where: { id: serviceId } });
  return {
    ...prepareBookingAttempt(),
    serviceId,
    expectedServiceTerms: publicServiceTerms(s).termsHash,
    expectedBusinessContext: businessContextHash(await settings()),
    master: any ? { type: "ANY" as const } : { type: "SPECIFIC" as const, masterId },
    localDate,
    startsAt: localDate + "T07:00:00Z",
    clientName: "Тест Клиент",
    clientPhone: "+79990000000",
  };
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
  vi.stubEnv("PUBLIC_ORIGIN", "https://salon.example");
  await clear();
  await db.businessSettings.upsert({
    where: { id: 1 },
    create: { businessName: "Тест" },
    update: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  token = randomBytes(32).toString("base64url");
  await db.adminUser.create({
    data: {
      login: "settings.test",
      passwordHash: "fixture-no-login",
      sessions: {
        create: { tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600000) },
      },
    },
  });
  serviceId = (
    await db.service.create({
      data: { name: "Стрижка", priceKopecks: 150000, durationMinutes: 35 },
    })
  ).id;
  masterId = (
    await db.master.create({
      data: {
        name: "Мастер",
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
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  vi.unstubAllEnvs();
  await db.$disconnect();
  await other.$disconnect();
});
it("read-only DTO без контактов/секретов, сохранение только двух параметров", async () => {
  const before = await settings();
  expect(await boundary.read(token)).toEqual({
    ok: true,
    settings: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  expect(await settings()).toEqual(before);
  expect(
    await boundary.save(
      h,
      token,
      await input({
        bookingHorizonDays: "90",
        timezone: "America/New_York",
        confirmedTimezoneChange: true,
      }),
    ),
  ).toEqual({
    ok: true,
    settings: { version: 1, timezone: "America/New_York", bookingHorizonDays: 90 },
  });
  expect(await settings()).toMatchObject({
    businessName: before.businessName,
    logoMediaId: before.logoMediaId,
    createdAt: before.createdAt,
  });
});
it.each([
  { bookingHorizonDays: "6" },
  { bookingHorizonDays: "91" },
  { bookingHorizonDays: "7.1" },
  { bookingHorizonDays: "" },
  { bookingHorizonDays: 7 },
  { timezone: "+03:00" },
  { timezone: "Invalid/Zone" },
  { id: 2 },
  { logoMediaId: null },
  { businessName: "Подмена" },
])("сервер отклоняет %j атомарно", async (extra) => {
  const before = await settings();
  expect(await boundary.save(h, token, await input(extra))).toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(await settings()).toEqual(before);
});
it("подтверждение смены зоны на сервере, две границы горизонта", async () => {
  expect(
    await boundary.save(
      h,
      token,
      await input({ timezone: "Europe/Berlin", bookingHorizonDays: "7" }),
    ),
  ).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  expect(await settings()).toMatchObject({
    version: 0,
    bookingHorizonDays: 30,
    timezone: "Europe/Moscow",
  });
  for (const value of ["7", "90"])
    expect(await boundary.save(h, token, await input({ bookingHorizonDays: value }))).toMatchObject(
      { ok: true, settings: { bookingHorizonDays: Number(value) } },
    );
});
it("конкурирующие формы и ABA не перезаписывают чужие значения", async () => {
  const old = await input();
  const results = await Promise.all([
    boundary.save(h, token, { ...old, bookingHorizonDays: "7" }),
    second.save(h, token, { ...old, bookingHorizonDays: "90" }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok && r.code === "CONFLICT")).toHaveLength(1);
  expect(await boundary.save(h, token, await input({ bookingHorizonDays: "30" }))).toMatchObject({
    ok: true,
  });
  expect(await boundary.save(h, token, old)).toMatchObject({ code: "CONFLICT" });
  expect(await settings()).toMatchObject({ version: 2, bookingHorizonDays: 30 });
});
it("ошибка AFTER UPDATE откатывает оба значения и версию", async () => {
  const before = await settings();
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_settings_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER test_settings_failure AFTER UPDATE ON business_settings FOR EACH ROW EXECUTE FUNCTION test_settings_failure()",
  );
  try {
    expect(
      await boundary.save(
        h,
        token,
        await input({
          timezone: "Europe/Berlin",
          bookingHorizonDays: "7",
          confirmedTimezoneChange: true,
        }),
      ),
    ).toMatchObject({ code: "UNAVAILABLE" });
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER test_settings_failure ON business_settings");
    await db.$executeRawUnsafe("DROP FUNCTION test_settings_failure()");
  }
  expect(await settings()).toEqual(before);
});
for (const mode of ["missing", "expired", "revoked", "disabled"] as const)
  it("доступ: " + mode, async () => {
    const before = await settings();
    if (mode === "expired") await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
    const supplied = mode === "missing" ? undefined : token;
    expect(await boundary.read(supplied)).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await boundary.save(h, supplied, await input())).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await settings()).toEqual(before);
  });
it("чужой Origin не разрешается Host/forwarded-заголовками", async () => {
  const before = await settings();
  expect(
    await boundary.save(
      new Headers({
        origin: "https://evil.example",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
      }),
      token,
      await input(),
    ),
  ).toMatchObject({ code: "FORBIDDEN" });
  expect(await settings()).toEqual(before);
});
for (const kind of ["advisory", "row"] as const)
  it("повторная авторизация после ожидания " + kind, async () => {
    const before = await settings();
    const request = await input({ bookingHorizonDays: "7" });
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
        else await tx.$queryRaw`SELECT id FROM business_settings WHERE id = 1 FOR SHARE`;
        ready();
        await gate;
      },
      { timeout: 10000 },
    );
    await started;
    const pending = boundary.save(h, token, request);
    try {
      await vi.waitFor(
        async () => {
          const rows = await other.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          expect(Number(rows[0].count)).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
      await other.adminSession.updateMany({ data: { revokedAt: new Date() } });
    } finally {
      release();
      await holder;
    }
    expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await settings()).toEqual(before);
  });
it.each(["saveWeek", "saveException", "deleteException"] as const)(
  "старое расписание %s после смены зоны и ABA",
  async (method) => {
    const read = await schedule.read(token, { masterId, month: "2026-10" });
    if (!read.ok) throw Error("read");
    const exception = await db.scheduleException.create({
      data: { masterId, localDate: new Date("2026-10-05T00:00Z"), type: "DAY_OFF" },
    });
    const target = {
      masterId,
      version: read.schedule.selected!.version,
      expectedBusinessContext: read.schedule.businessContext,
    };
    const request =
      method === "saveWeek"
        ? { ...target, days: read.schedule.selected!.days }
        : method === "saveException"
          ? { ...target, id: exception.id, localDate: "2026-10-06", type: "DAY_OFF", intervals: [] }
          : { ...target, id: exception.id, confirmed: true };
    for (const timezone of ["Europe/Berlin", "Europe/Moscow"]) {
      expect(
        await boundary.save(h, token, await input({ timezone, confirmedTimezoneChange: true })),
      ).toMatchObject({ ok: true });
      expect(await schedule[method](h, token, request)).toMatchObject({ code: "CONFLICT" });
    }
    expect((await db.master.findUniqueOrThrow({ where: { id: masterId } })).version).toBe(0);
    expect(await db.scheduleException.findUnique({ where: { id: exception.id } })).toEqual(
      exception,
    );
  },
);
for (const any of [false, true])
  for (const change of [
    { timezone: "Europe/Berlin", confirmedTimezoneChange: true },
    { bookingHorizonDays: "7" },
  ])
    it("старое создание и доступность ANY=" + any + JSON.stringify(change), async () => {
      const request = await bookInput(any);
      const result = await booking.createBooking(request);
      expect(result.ok).toBe(true);
      const before = await db.appointment.findMany({
        include: { statusHistory: true, bookingRequest: true },
      });
      const scheduleBefore = await db.weeklyWorkInterval.findMany();
      expect(await boundary.save(h, token, await input(change))).toMatchObject({ ok: true });
      const stale = { ...request, ...prepareBookingAttempt() };
      expect(await booking.createBooking(stale)).toMatchObject({
        code: "BUSINESS_CONTEXT_CHANGED",
      });
      const av = await publicBoundary.availability(h, {
        serviceId,
        masterId: any ? undefined : masterId,
        localDate: request.localDate,
        expectedBusinessContext: request.expectedBusinessContext,
      });
      expect(av).toMatchObject({
        code: "BUSINESS_CONTEXT_CHANGED",
        context: { timeZone: change.timezone ?? "Europe/Moscow" },
      });
      expect(await db.bookingRequest.count()).toBe(1);
      expect(
        await db.appointment.findMany({ include: { statusHistory: true, bookingRequest: true } }),
      ).toEqual(before);
      expect(await db.weeklyWorkInterval.findMany()).toEqual(scheduleBefore);
      expect(await booking.createBooking(request)).toMatchObject({
        ok: true,
        replayed: true,
        timeZone: change.timezone ?? "Europe/Moscow",
        confirmation: result.ok ? result.confirmation : {},
      });
      expect(await appointments.getConfirmation(request.cancellationToken)).toMatchObject({
        ok: true,
      });
      const fresh = await readTimeContext(db, clock.now());
      if (change.bookingHorizonDays)
        expect(
          await booking.createBooking({ ...stale, expectedBusinessContext: fresh.contextHash }),
        ).toMatchObject({ code: "REQUEST_REJECTED", reason: "BOOKING_DATE_OUT_OF_RANGE" });
      else
        expect(
          await booking.createBooking({
            ...stale,
            expectedBusinessContext: fresh.contextHash,
            startsAt: request.localDate + "T09:00Z",
          }),
        ).toMatchObject({ ok: true });
      expect(
        await appointments.cancelBooking({ token: request.cancellationToken, confirmed: true }),
      ).toMatchObject({ ok: true });
    });
it.each([1, 2])(
  "исторический booking-v%s: независимый hash, replay после настроек, новый запрос без контекста запрещён",
  async (v) => {
    const modern = await bookInput();
    const legacy = {
      ...modern,
      expectedBusinessContext: undefined,
      expectedServiceTerms: v === 1 ? undefined : modern.expectedServiceTerms,
    };
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          `booking-v${v}`,
          serviceId,
          "SPECIFIC",
          masterId,
          legacy.localDate,
          new Date(legacy.startsAt).toISOString(),
          legacy.clientName,
          legacy.clientPhone,
          ...(v === 2 ? [legacy.expectedServiceTerms] : []),
        ]),
      )
      .digest("hex");
    const row = await db.bookingRequest.create({
      data: {
        idempotencyKey: legacy.idempotencyKey,
        requestHash,
        appointment: {
          create: {
            serviceId,
            masterId,
            startsAt: new Date(legacy.startsAt),
            endsAt: new Date("2026-10-20T07:35Z"),
            clientName: legacy.clientName,
            clientPhone: legacy.clientPhone,
            source: "ONLINE",
            masterSelection: "SPECIFIC",
            serviceNameSnapshot: "Стрижка",
            servicePriceSnapshot: 150000,
            serviceDurationSnapshot: 35,
            cancellationTokenHash: hashBookingToken(legacy.cancellationToken),
            statusHistory: { create: { newStatus: "SCHEDULED", changedBy: "CLIENT" } },
          },
        },
      },
      include: { appointment: true },
    });
    expect(
      await boundary.save(
        h,
        token,
        await input({
          timezone: "America/New_York",
          bookingHorizonDays: "7",
          confirmedTimezoneChange: true,
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(await booking.createBooking(legacy)).toMatchObject({
      ok: true,
      replayed: true,
      confirmation: { id: row.appointment!.id },
      timeZone: "America/New_York",
    });
    expect(await db.bookingRequest.findUnique({ where: { id: row.id } })).toMatchObject({
      requestHash,
    });
    expect(await booking.createBooking({ ...legacy, ...prepareBookingAttempt() })).toMatchObject({
      code: v === 1 ? "SERVICE_TERMS_CHANGED" : "BUSINESS_CONTEXT_CHANGED",
    });
    expect(await db.bookingRequest.count()).toBe(1);
    expect(await db.appointmentStatusHistory.count()).toBe(1);
  },
);
it("настройки изменились пока booking ждёт row lock: новая транзакция отклоняет старый контекст", async () => {
  const request = await bookInput();
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      ready = r;
    });
  const holder = other.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM business_settings WHERE id = 1 FOR UPDATE`;
      ready();
      await gate;
      await tx.businessSettings.update({
        where: { id: 1 },
        data: { timezone: "Europe/Berlin", version: { increment: 1 } },
      });
    },
    { timeout: 10000 },
  );
  await started;
  const pending = booking.createBooking(request);
  try {
    await vi.waitFor(
      async () => {
        const rows = await other.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(Number(rows[0].count)).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
  } finally {
    release();
    await holder;
  }
  expect(await pending).toMatchObject({ code: "BUSINESS_CONTEXT_CHANGED" });
  expect(await db.bookingRequest.count()).toBe(0);
  expect(await db.appointment.count()).toBe(0);
});
