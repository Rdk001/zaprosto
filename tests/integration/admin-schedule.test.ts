import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import { createScheduleBoundary } from "../../src/server/admin/schedule-boundary";
import { createCatalogBoundary } from "../../src/server/admin/catalog-boundary";
import { createSchedulingAvailabilityService } from "../../src/modules/scheduling/server/availability-service";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import { prepareBookingAttempt } from "../../src/modules/booking/server/booking-security";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import {
  databaseInterval,
  type ScheduleWeek,
} from "../../src/modules/scheduling/domain/admin-input";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url),
  other = createPrismaClient(url);
const boundary = createScheduleBoundary(db),
  second = createScheduleBoundary(other),
  catalog = createCatalogBoundary(db);
const h = new Headers({ origin: "https://salon.example" });
const clock = { now: () => new Date("2026-10-01T00:00:00Z") };
const booking = createBookingService(db, clock),
  availability = createSchedulingAvailabilityService(db, clock);
let token: string, masterId: string, anotherId: string, serviceId: string;
function ok<T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> {
  expect(value).toMatchObject({ ok: true });
  return value as Extract<T, { ok: true }>;
}
const interval = (start = "09:07", end = "18:00") => ({ start, end });
const week = (): ScheduleWeek =>
  Array.from({ length: 7 }, (_, i) => ({
    dayOfWeek: i + 1,
    work: i === 0 ? [interval()] : [],
    breaks: i === 0 ? [interval("12:00", "13:00")] : [],
  }));
async function version(id = masterId) {
  return (await db.master.findUniqueOrThrow({ where: { id } })).version;
}
async function read(id = masterId, month = "2026-10") {
  return ok(await boundary.read(token, { masterId: id, month })).schedule;
}
async function save(days = week(), id = masterId) {
  return ok(await boundary.saveWeek(h, token, { masterId: id, version: await version(id), days }));
}
async function exception(
  type: "DAY_OFF" | "CUSTOM_HOURS" = "DAY_OFF",
  id: string | null = null,
  date = "2026-10-05",
) {
  return ok(
    await boundary.saveException(h, token, {
      masterId,
      version: await version(),
      id,
      localDate: date,
      type,
      intervals: type === "DAY_OFF" ? [] : [interval("11:00", "15:00")],
    }),
  );
}
beforeEach(async () => {
  vi.stubEnv("PUBLIC_ORIGIN", "https://salon.example");
  await db.appointment.deleteMany();
  await db.bookingRequest.deleteMany();
  await db.master.deleteMany();
  await db.service.deleteMany();
  await db.adminSession.deleteMany();
  await db.adminUser.deleteMany();
  await db.businessSettings.upsert({
    where: { id: 1 },
    create: { businessName: "Тест" },
    update: { timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  token = randomBytes(32).toString("base64url");
  await db.adminUser.create({
    data: {
      login: "schedule.test",
      passwordHash: "not-login-fixture",
      sessions: {
        create: { tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600000) },
      },
    },
  });
  serviceId = (
    await db.service.create({
      data: { name: "Стрижка", durationMinutes: 37, priceKopecks: 150000 },
    })
  ).id;
  masterId = (
    await db.master.create({ data: { name: "Первый", services: { create: { serviceId } } } })
  ).id;
  anotherId = (
    await db.master.create({
      data: { name: "Второй", displayOrder: 1, services: { create: { serviceId } } },
    })
  ).id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await other.$disconnect();
});

it("неделя: объединение, несколько перерывов, пустой день и независимость мастеров", async () => {
  const before = await read(anotherId);
  const days = week();
  days[0].work = [
    interval("09:07", "11:00"),
    interval("10:00", "12:00"),
    interval("14:00", "18:00"),
  ];
  days[0].breaks.push(interval("19:00", "20:00"));
  days[1].breaks = [interval("12:00", "13:00")];
  const result = await save(days);
  expect(result.days![0].work).toEqual([interval("09:07", "12:00"), interval("14:00", "18:00")]);
  const stored = await read();
  expect(stored.selected!.days[1]).toEqual(days[1]);
  expect(stored.selected!.days[0].breaks).toEqual(days[0].breaks);
  expect(await read(anotherId)).toEqual({ ...before, masters: (await read(anotherId)).masters });
  expect(
    (await availability.getMasterAvailability({ masterId, serviceId, localDate: "2026-10-06" }))
      .slots,
  ).toEqual([]);
  const monday = await availability.getMasterAvailability({
    masterId,
    serviceId,
    localDate: "2026-10-05",
  });
  expect(monday.slots[0]).toEqual({
    startsAt: new Date("2026-10-05T06:07:00Z"),
    endsAt: new Date("2026-10-05T06:44:00Z"),
  });
  await db.master.update({ where: { id: anotherId }, data: { isActive: false } });
  await db.masterService.deleteMany({ where: { masterId: anotherId } });
  await save(week(), anotherId);
  expect((await db.master.findUniqueOrThrow({ where: { id: anotherId } })).isActive).toBe(false);
  expect(await db.masterService.count({ where: { masterId: anotherId } })).toBe(0);
});
it("CUSTOM_HOURS вычитает недельные перерывы, смена типа атомарно убирает часы, удаление возвращает неделю", async () => {
  await save();
  const created = (await exception("CUSTOM_HOURS")).exception!;
  const slots = (
    await availability.getMasterAvailability({ masterId, serviceId, localDate: created.localDate })
  ).slots;
  expect(slots[0].startsAt.toISOString()).toBe("2026-10-05T08:00:00.000Z");
  expect(
    slots.every(
      (s) =>
        s.endsAt <= new Date("2026-10-05T09:00Z") || s.startsAt >= new Date("2026-10-05T10:00Z"),
    ),
  ).toBe(true);
  await exception("DAY_OFF", created.id);
  expect(await db.exceptionWorkInterval.count()).toBe(0);
  expect(
    (
      await availability.getMasterAvailability({
        masterId,
        serviceId,
        localDate: created.localDate,
      })
    ).slots,
  ).toEqual([]);
  await exception("CUSTOM_HOURS", created.id);
  expect(await db.exceptionWorkInterval.count()).toBe(1);
  ok(
    await boundary.deleteException(h, token, {
      masterId,
      version: await version(),
      id: created.id,
      confirmed: true,
    }),
  );
  expect((await read()).exceptions).toEqual([]);
  expect(await db.exceptionWorkInterval.count()).toBe(0);
  expect(
    (
      await availability.getMasterAvailability({
        masterId,
        serviceId,
        localDate: created.localDate,
      })
    ).slots[0].startsAt.toISOString(),
  ).toBe("2026-10-05T06:07:00.000Z");
});
it.each(["week", "exception"])(
  "ошибка после начала сохранения %s откатывает строки и версию",
  async (mode) => {
    await save();
    const old = (await exception("CUSTOM_HOURS")).exception!;
    const before = await read();
    const table = mode === "week" ? "weekly_breaks" : "exception_work_intervals";
    await db.$executeRawUnsafe(
      "CREATE FUNCTION fail_schedule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$",
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fail_schedule BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_schedule()`,
    );
    try {
      const result =
        mode === "week"
          ? await boundary.saveWeek(h, token, { masterId, version: await version(), days: week() })
          : await boundary.saveException(h, token, {
              masterId,
              version: await version(),
              id: old.id,
              localDate: "2026-10-06",
              type: "CUSTOM_HOURS",
              intervals: [interval()],
            });
      expect(result).toEqual({ ok: false, code: "UNAVAILABLE" });
      expect(await read()).toEqual(before);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER fail_schedule ON ${table}`);
      await db.$executeRawUnsafe("DROP FUNCTION fail_schedule()");
    }
  },
);
it("две недели, ABA и изменения каталога/порядка согласуют Master.version", async () => {
  const request = { masterId, version: 0, days: week() };
  const results = await Promise.all([
    boundary.saveWeek(h, token, request),
    second.saveWeek(h, token, request),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toMatchObject({ code: "CONFLICT" });
  expect(
    await catalog.saveMaster(h, token, {
      target: { id: masterId, version: 0 },
      name: "Устарело",
      description: "",
      isActive: true,
      confirmDeactivation: false,
      serviceIds: [serviceId],
    }),
  ).toMatchObject({ code: "CONFLICT" });
  const oldVersion = await version();
  const catalogBefore = ok(await catalog.list(token)).catalog;
  ok(
    await catalog.move(h, token, {
      kind: "masters",
      id: catalogBefore.masters[0].id,
      direction: "down",
      orderVersion: catalogBefore.masterOrderVersion,
    }),
  );
  expect(await boundary.saveWeek(h, token, { ...request, version: oldVersion })).toMatchObject({
    code: "CONFLICT",
  });
  await save();
  expect(await boundary.saveWeek(h, token, request)).toMatchObject({ code: "CONFLICT" });
  expect(
    await catalog.move(h, token, {
      kind: "masters",
      id: masterId,
      direction: "up",
      orderVersion: catalogBefore.masterOrderVersion,
    }),
  ).toMatchObject({ code: "CONFLICT" });
});
it("создание на одну дату и редактирование против удаления не перезаписывают друг друга", async () => {
  const input = {
    masterId,
    version: 0,
    id: null,
    localDate: "2026-10-05",
    type: "DAY_OFF",
    intervals: [],
  };
  const results = await Promise.all([
    boundary.saveException(h, token, input),
    second.saveException(h, token, input),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toMatchObject({ code: "CONFLICT" });
  expect(
    await boundary.saveException(h, token, { ...input, version: await version() }),
  ).toMatchObject({ code: "CONFLICT" });
  const old = (await read()).exceptions[0];
  const v = await version();
  const race = await Promise.all([
    boundary.saveException(h, token, {
      ...input,
      id: old.id,
      version: v,
      type: "CUSTOM_HOURS",
      intervals: [interval()],
    }),
    second.deleteException(h, token, { masterId, version: v, id: old.id, confirmed: true }),
  ]);
  expect(race.filter((r) => r.ok)).toHaveLength(1);
  expect(race.find((r) => !r.ok)).toMatchObject({ code: "CONFLICT" });
});
it.each(["missing", "expired", "revoked", "disabled"])(
  "каждое чтение и изменение проверяет доступ: %s",
  async (mode) => {
    if (mode === "expired") await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
    const supplied = mode === "missing" ? undefined : token;
    for (const result of [
      await boundary.read(supplied, {}),
      await boundary.saveWeek(h, supplied, {}),
      await boundary.saveException(h, supplied, {}),
      await boundary.deleteException(h, supplied, {}),
    ])
      expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
  },
);
it("Origin, ID другого мастера, произвольные поля и неверные значения ничего не меняют", async () => {
  const item = (await exception()).exception!;
  const before = await read();
  for (const headers of [
    new Headers(),
    new Headers({ origin: "https://evil.example" }),
    new Headers({ origin: "https://salon.example", "sec-fetch-site": "cross-site" }),
  ])
    for (const method of [boundary.saveWeek, boundary.saveException, boundary.deleteException])
      expect(await method(headers, token, {})).toMatchObject({ code: "FORBIDDEN" });
  expect(
    await boundary.deleteException(h, token, {
      masterId: anotherId,
      version: 0,
      id: item.id,
      confirmed: true,
    }),
  ).toMatchObject({ code: "NOT_FOUND" });
  expect(
    await boundary.saveException(h, token, {
      masterId: anotherId,
      version: 0,
      id: item.id,
      localDate: "2026-10-05",
      type: "DAY_OFF",
      intervals: [],
    }),
  ).toMatchObject({ code: "NOT_FOUND" });
  expect(
    await boundary.saveWeek(h, token, {
      masterId,
      version: await version(),
      days: week(),
      isActive: false,
    }),
  ).toMatchObject({ code: "INVALID_INPUT" });
  expect(
    await boundary.saveWeek(h, token, { masterId: randomUUID(), version: 0, days: week() }),
  ).toMatchObject({ code: "NOT_FOUND" });
  for (const localDate of ["2026-02-30", "2026-10-5"])
    expect(
      await boundary.saveException(h, token, {
        masterId,
        version: await version(),
        id: null,
        localDate,
        type: "DAY_OFF",
        intervals: [],
      }),
    ).toMatchObject({ code: "INVALID_INPUT" });
  expect(
    await boundary.deleteException(h, token, {
      masterId,
      version: await version(),
      id: item.id,
      confirmed: false,
    }),
  ).toMatchObject({ code: "INVALID_INPUT" });
  expect(await read()).toEqual(before);
  expect(JSON.stringify(before)).not.toMatch(/clientPhone|clientName|password|tokenHash/);
});
it.each(["saveWeek", "saveException", "deleteException"] as const)(
  "отзыв во время ожидания замка: %s",
  async (method) => {
    const item = (await exception()).exception!;
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        locked = r;
      });
    const holder = other.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(526008, 52)`;
        locked();
        await gate;
      },
      { timeout: 10000 },
    );
    await ready;
    const input =
      method === "saveWeek"
        ? { masterId, version: 1, days: week() }
        : method === "saveException"
          ? {
              masterId,
              version: 1,
              id: item.id,
              localDate: "2026-10-05",
              type: "DAY_OFF",
              intervals: [],
            }
          : { masterId, version: 1, id: item.id, confirmed: true };
    const pending = boundary[method](h, token, input);
    try {
      await vi.waitFor(
        async () => {
          const rows = await other.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'`;
          expect(Number(rows[0].count)).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
      await other.adminSession.updateMany({ data: { revokedAt: new Date() } });
    } finally {
      release();
      await holder;
    }
    expect(await pending).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await version()).toBe(1);
  },
);
it.each(["2026-03-29", "2026-10-25"])(
  "DST %s: не сдвигает и не скрывает неоднозначные границы при слиянии; DAY_OFF не конвертирует часы",
  async (localDate) => {
    await db.businessSettings.update({ where: { id: 1 }, data: { timezone: "Europe/Berlin" } });
    const input = {
      masterId,
      version: 0,
      id: null,
      localDate,
      type: "CUSTOM_HOURS",
      intervals: [interval("01:00", "04:00"), interval("02:30", "03:30")],
    };
    expect(await boundary.saveException(h, token, input)).toMatchObject({ code: "INVALID_TIME" });
    expect(await db.scheduleException.count()).toBe(0);
    expect(await version()).toBe(0);
    await db.weeklyBreak.create({
      data: { masterId, dayOfWeek: 7, ...databaseInterval(interval("02:30", "03:30")) },
    });
    expect(
      await boundary.saveException(h, token, { ...input, intervals: [interval("01:00", "04:00")] }),
    ).toMatchObject({ code: "INVALID_TIME" });
    ok(await boundary.saveException(h, token, { ...input, type: "DAY_OFF", intervals: [] }));
    const scheduling = createSchedulingAvailabilityService(db, {
      now: () => new Date(`${localDate.slice(0, 7)}-01T00:00:00Z`),
    });
    expect(
      (await scheduling.getMasterAvailability({ masterId, serviceId, localDate })).slots,
    ).toEqual([]);
  },
);
it("публичные SPECIFIC/ANY до и после, устаревшая запись отклонена, replay и снимки неизменны", async () => {
  await save();
  await save(week(), anotherId);
  const s = await db.service.findUniqueOrThrow({ where: { id: serviceId } });
  const input = {
    ...prepareBookingAttempt(),
    serviceId,
    expectedServiceTerms: publicServiceTerms(s).termsHash,
    master: { type: "SPECIFIC", masterId },
    localDate: "2026-10-05",
    startsAt: "2026-10-05T09:07:00+03:00",
    clientName: "Тест Клиент",
    clientPhone: "+79990000000",
  };
  const result = ok(await booking.createBooking(input));
  const before = await db.appointment.findUniqueOrThrow({
    where: { id: result.confirmation.id },
    include: { statusHistory: true, bookingRequest: true },
  });
  await exception();
  expect(
    (await availability.getMasterAvailability({ masterId, serviceId, localDate: input.localDate }))
      .slots,
  ).toEqual([]);
  expect(
    (
      await availability.getAnyMasterAvailability({ serviceId, localDate: input.localDate })
    ).slots[0].candidates.map((m) => m.id),
  ).toEqual([anotherId]);
  expect(
    await booking.createBooking({
      ...input,
      ...prepareBookingAttempt(),
      startsAt: "2026-10-05T14:07:00+03:00",
    }),
  ).toMatchObject({ ok: false });
  const replay = ok(await booking.createBooking(input));
  expect(replay.replayed).toBe(true);
  expect(replay.confirmation.id).toBe(result.confirmation.id);
  expect(
    await db.appointment.findUniqueOrThrow({
      where: { id: result.confirmation.id },
      include: { statusHistory: true, bookingRequest: true },
    }),
  ).toEqual(before);
  expect(
    (await createClientAppointmentService(db, clock).getConfirmation(input.cancellationToken)).ok,
  ).toBe(true);
  await save(
    Array.from({ length: 7 }, (_, i) => ({ dayOfWeek: i + 1, work: [], breaks: [] })),
    anotherId,
  );
  expect(
    (await availability.getAnyMasterAvailability({ serviceId, localDate: input.localDate })).slots,
  ).toEqual([]);
  expect(
    await booking.createBooking({ ...input, ...prepareBookingAttempt(), master: { type: "ANY" } }),
  ).toMatchObject({ ok: false });
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
});
it("чтения ограничены месяцем и страницей мастеров, неверные параметры отклоняются", async () => {
  await exception();
  await exception("DAY_OFF", null, "2026-11-01");
  expect((await read()).exceptions).toHaveLength(1);
  expect((await read(masterId, "2026-11")).exceptions).toHaveLength(1);
  expect(await boundary.read(token, { month: "2026-13" })).toMatchObject({ code: "INVALID_INPUT" });
  await db.master.createMany({
    data: Array.from({ length: 51 }, (_, i) => ({ name: `Проверка ${i}` })),
  });
  const first = ok(await boundary.read(token, {})).schedule;
  expect(first.masters).toHaveLength(50);
  expect(first.nextAfter).toBeTruthy();
  const next = ok(await boundary.read(token, { after: first.nextAfter })).schedule;
  expect(next.masters).toHaveLength(3);
  expect(next.nextAfter).toBeNull();
  expect(new Set([...first.masters, ...next.masters].map((m) => m.id)).size).toBe(53);
});
