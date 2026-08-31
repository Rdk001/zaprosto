import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import { createCatalogBoundary } from "../../src/server/admin/catalog-boundary";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { prepareBookingAttempt } from "../../src/modules/booking/server/booking-security";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import { createSchedulingAvailabilityService } from "../../src/modules/scheduling/server/availability-service";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url),
  other = createPrismaClient(url);
const boundary = createCatalogBoundary(db),
  second = createCatalogBoundary(other);
const h = new Headers({ origin: "https://salon.example" });
let token: string;
const clock = { now: () => new Date("2026-10-01T00:00:00Z") };
const booking = createBookingService(db, clock);
const appointments = createClientAppointmentService(db, clock);
const serviceInput = {
  target: null,
  name: "Тестовая услуга",
  priceRubles: "1234,56",
  durationMinutes: "35",
  isActive: true,
  confirmDeactivation: false,
};
const masterInput = {
  target: null,
  name: "Тестовый мастер",
  description: "",
  serviceIds: [] as string[],
  isActive: true,
  confirmDeactivation: false,
};
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
async function list() {
  return ok(await boundary.list(token)).catalog;
}
async function service() {
  return ok(await boundary.saveService(h, token, serviceInput)).catalog.services.at(-1)!;
}
async function master(serviceIds: string[] = []) {
  return ok(await boundary.saveMaster(h, token, { ...masterInput, serviceIds })).catalog.masters.at(
    -1,
  )!;
}
beforeAll(() => {
  vi.stubEnv("PUBLIC_ORIGIN", "https://salon.example");
});
beforeEach(async () => {
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
      login: "catalog.test",
      passwordHash: "not-a-login-fixture",
      sessions: {
        create: { tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600000) },
      },
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await other.$disconnect();
});

it("создание, общие цена/длительность, редактирование, одинаковые названия", async () => {
  const a = await service();
  const b = await service();
  expect(a.id).not.toBe(b.id);
  expect(a).toMatchObject({ priceKopecks: 123456, durationMinutes: 35, version: 0 });
  const m = await master([a.id, b.id]);
  expect(await db.weeklyWorkInterval.count()).toBe(0);
  const updated = ok(
    await boundary.saveService(h, token, {
      ...serviceInput,
      target: { id: a.id, version: a.version },
      name: "Новое название",
      priceRubles: "0.29",
      durationMinutes: "37",
    }),
  );
  expect(updated.catalog.services.find((s) => s.id === a.id)).toMatchObject({
    name: "Новое название",
    priceKopecks: 29,
    durationMinutes: 37,
    version: 1,
  });
  expect(await db.masterService.findMany({ where: { masterId: m.id } })).toHaveLength(2);
});
it("назначения меняются атомарно; неизвестный ID ничего не меняет", async () => {
  const a = await service(),
    b = await service(),
    c = await service();
  const m = await master([a.id, b.id]);
  const request = {
    ...masterInput,
    name: "Изменён",
    target: { id: m.id, version: m.version },
    serviceIds: [b.id, c.id],
  };
  expect(
    (await boundary.saveMaster(h, token, { ...request, serviceIds: [b.id, randomUUID()] })).ok,
  ).toBe(false);
  expect((await list()).masters[0]).toEqual(m);
  const changed = ok(await boundary.saveMaster(h, token, request)).catalog.masters[0];
  expect(changed.services.map((s) => s.serviceId).sort()).toEqual([b.id, c.id].sort());
  ok(
    await boundary.saveMaster(h, token, {
      ...request,
      target: { id: m.id, version: changed.version },
      serviceIds: [],
    }),
  );
  expect(await db.masterService.count()).toBe(0);
  const before = await list();
  expect(
    await boundary.saveMaster(h, token, { ...masterInput, serviceIds: [a.id, randomUUID()] }),
  ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  expect(await list()).toEqual(before);
});
it("ошибка БД после снятия назначений откатывает весь запрос", async () => {
  const a = await service(),
    b = await service();
  const m = await master([a.id]);
  await db.$executeRawUnsafe(
    "CREATE FUNCTION fail_catalog_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_catalog_assignment BEFORE INSERT ON master_services FOR EACH ROW EXECUTE FUNCTION fail_catalog_assignment()",
  );
  try {
    expect(
      await boundary.saveMaster(h, token, {
        ...masterInput,
        target: { id: m.id, version: m.version },
        name: "Не сохранять",
        serviceIds: [b.id],
      }),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect((await list()).masters[0]).toEqual(m);
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_catalog_assignment ON master_services");
    await db.$executeRawUnsafe("DROP FUNCTION fail_catalog_assignment()");
  }
});
it("деактивация с подтверждением и активация сохраняют назначения и фото", async () => {
  const a = await service();
  const m = await master([a.id]);
  const media = await db.mediaObject.create({
    data: { storageKey: randomUUID(), mimeType: "image/png", sizeBytes: 12, checksum: "fixture" },
  });
  await db.master.update({ where: { id: m.id }, data: { photoMediaId: media.id } });
  const edit = {
    ...masterInput,
    target: { id: m.id, version: m.version },
    serviceIds: [a.id],
    isActive: false,
  };
  expect(await boundary.saveMaster(h, token, edit)).toMatchObject({
    ok: false,
    code: "CONFIRM_REQUIRED",
  });
  ok(await boundary.saveMaster(h, token, { ...edit, confirmDeactivation: true }));
  ok(
    await boundary.saveService(h, token, {
      ...serviceInput,
      target: { id: a.id, version: a.version },
      isActive: false,
      confirmDeactivation: true,
    }),
  );
  expect(await db.masterService.count()).toBe(1);
  expect((await list()).services[0].isActive).toBe(false);
  ok(
    await boundary.saveMaster(h, token, {
      ...edit,
      target: { id: m.id, version: m.version + 1 },
      isActive: true,
    }),
  );
  ok(
    await boundary.saveService(h, token, {
      ...serviceInput,
      target: { id: a.id, version: a.version + 1 },
    }),
  );
  expect((await db.master.findUniqueOrThrow({ where: { id: m.id } })).photoMediaId).toBe(media.id);
  expect(await db.masterService.count()).toBe(1);
  await db.master.update({ where: { id: m.id }, data: { photoMediaId: null } });
  await db.mediaObject.delete({ where: { id: media.id } });
});
it("две вкладки: только одно изменение сохраняется, включая назначения и ABA", async () => {
  const a = await service(),
    m = await master([a.id]);
  const request = { ...masterInput, target: { id: m.id, version: m.version }, serviceIds: [] };
  const results = await Promise.all([
    boundary.saveMaster(h, token, { ...request, name: "A" }),
    second.saveMaster(h, token, { ...request, name: "B" }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toMatchObject({ code: "CONFLICT" });
  ok(
    await boundary.saveMaster(h, token, {
      ...masterInput,
      target: { id: m.id, version: 1 },
      serviceIds: [a.id],
    }),
  );
  expect(await boundary.saveMaster(h, token, request)).toMatchObject({ code: "CONFLICT" });
  const services = await Promise.all([
    boundary.saveService(h, token, {
      ...serviceInput,
      target: { id: a.id, version: 0 },
      name: "A",
    }),
    second.saveService(h, token, { ...serviceInput, target: { id: a.id, version: 0 }, name: "B" }),
  ]);
  expect(services.filter((r) => r.ok)).toHaveLength(1);
});
it.each(["services", "masters"] as const)(
  "порядок %s: атомарная гонка, одинаковые исходные позиции и новая строка",
  async (kind) => {
    if (kind === "services") {
      await service();
      await service();
      await service();
      await db.service.updateMany({ data: { displayOrder: 0 } });
    } else {
      await master();
      await master();
      await master();
      await db.master.updateMany({ data: { displayOrder: 0 } });
    }
    const before = await list();
    const rows = before[kind];
    const move = {
      kind,
      id: rows[2].id,
      direction: "up",
      orderVersion: kind === "services" ? before.serviceOrderVersion : before.masterOrderVersion,
    };
    const results = await Promise.all([boundary.move(h, token, move), second.move(h, token, move)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "CONFLICT" });
    const after = await list();
    expect(after[kind].map((r) => r.id)).toEqual([rows[0].id, rows[2].id, rows[1].id]);
    expect(after[kind].map((r) => r.displayOrder)).toEqual([0, 1, 2]);
    const orderVersion = kind === "services" ? after.serviceOrderVersion : after.masterOrderVersion;
    if (kind === "services") await service();
    else await master();
    expect(await boundary.move(h, token, { ...move, orderVersion })).toMatchObject({
      code: "CONFLICT",
    });
  },
);
async function bookedFixture() {
  const s = await service();
  const m = await master([s.id]),
    m2 = await master([s.id]);
  await db.weeklyWorkInterval.createMany({
    data: [m, m2].map((row) => ({
      masterId: row.id,
      dayOfWeek: 1,
      startsAt: new Date("1970-01-01T09:00:00Z"),
      endsAt: new Date("1970-01-01T18:00:00Z"),
    })),
  });
  const input = {
    ...prepareBookingAttempt(),
    serviceId: s.id,
    expectedServiceTerms: publicServiceTerms(s).termsHash,
    master: { type: "SPECIFIC", masterId: m.id },
    localDate: "2026-10-05",
    startsAt: "2026-10-05T10:00:00+03:00",
    clientName: "Тест Клиент",
    clientPhone: "+79990000000",
  };
  return { s, m, m2, input };
}
it("порядок мастеров определяет «Любого мастера» при равной нагрузке", async () => {
  const { m2, input } = await bookedFixture();
  const current = await list();
  ok(
    await boundary.move(h, token, {
      kind: "masters",
      id: m2.id,
      direction: "up",
      orderVersion: current.masterOrderVersion,
    }),
  );
  const result = ok(await booking.createBooking({ ...input, master: { type: "ANY" } }));
  expect(result.confirmation.master.id).toBe(m2.id);
});
it.each(["service", "master", "assignment"])(
  "старые снимки, ссылка, replay и отмена после изменения %s; новая запись запрещена",
  async (mode) => {
    const { s, m, input } = await bookedFixture();
    const result = ok(await booking.createBooking(input));
    const before = await db.appointment.findUniqueOrThrow({
      where: { id: result.confirmation.id },
      include: { statusHistory: true },
    });
    ok(
      await boundary.saveService(h, token, {
        ...serviceInput,
        target: { id: s.id, version: s.version },
        name: "Новое имя",
        priceRubles: "99.99",
        durationMinutes: "37",
        isActive: mode !== "service",
        confirmDeactivation: true,
      }),
    );
    ok(
      await boundary.saveMaster(h, token, {
        ...masterInput,
        target: { id: m.id, version: m.version },
        isActive: mode !== "master",
        serviceIds: mode === "assignment" ? [] : [s.id],
        confirmDeactivation: true,
      }),
    );
    expect(
      await db.appointment.findUniqueOrThrow({
        where: { id: result.confirmation.id },
        include: { statusHistory: true },
      }),
    ).toEqual(before);
    const replay = ok(await booking.createBooking(input));
    expect(replay.replayed).toBe(true);
    expect(replay.confirmation.service).toEqual(result.confirmation.service);
    expect((await appointments.getConfirmation(input.cancellationToken)).ok).toBe(true);
    const fresh = await booking.createBooking({
      ...input,
      ...prepareBookingAttempt(),
      expectedServiceTerms: publicServiceTerms(
        await db.service.findUniqueOrThrow({ where: { id: s.id } }),
      ).termsHash,
      startsAt: "2026-10-05T12:00:00+03:00",
    });
    expect(fresh).toMatchObject({ ok: false, code: "REQUEST_REJECTED" });
    expect(await db.appointment.count()).toBe(1);
    expect(
      (await appointments.cancelBooking({ token: input.cancellationToken, confirmed: true })).ok,
    ).toBe(true);
  },
);
it("у нового мастера без графика нет окон", async () => {
  const s = await service(),
    m = await master([s.id]);
  const availability = await createSchedulingAvailabilityService(db, clock).getMasterAvailability({
    serviceId: s.id,
    masterId: m.id,
    localDate: "2026-10-05",
  });
  expect(availability.slots).toEqual([]);
});
it.each(["missing", "expired", "revoked", "disabled"])(
  "каждая граница отклоняет сессию: %s, без закрытых данных",
  async (mode) => {
    const a = await service();
    const snapshot = await list();
    if (mode === "expired") await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
    const supplied = mode === "missing" ? undefined : token;
    for (const result of [
      await boundary.list(supplied),
      await boundary.saveService(h, supplied, serviceInput),
      await boundary.saveMaster(h, supplied, masterInput),
      await boundary.move(h, supplied, {
        kind: "services",
        id: a.id,
        direction: "down",
        orderVersion: snapshot.serviceOrderVersion,
      }),
    ])
      expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await db.service.count()).toBe(1);
    expect(await db.master.count()).toBe(0);
  },
);
it("Origin и неожиданные поля отклоняются без частичных изменений", async () => {
  const before = await list();
  for (const headers of [
    new Headers(),
    new Headers({ origin: "https://evil.example" }),
    new Headers({ origin: "https://salon.example", "sec-fetch-site": "cross-site" }),
  ]) {
    expect(await boundary.saveService(headers, token, serviceInput)).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await boundary.saveMaster(headers, token, masterInput)).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await boundary.move(headers, token, {})).toMatchObject({ code: "FORBIDDEN" });
  }
  expect(await boundary.saveService(h, token, { ...serviceInput, priceKopecks: 1 })).toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(
    await boundary.saveMaster(h, token, { ...masterInput, photoMediaId: randomUUID() }),
  ).toMatchObject({ code: "INVALID_INPUT" });
  expect(
    await boundary.saveService(h, token, {
      ...serviceInput,
      target: { id: randomUUID(), version: 0 },
    }),
  ).toMatchObject({ code: "NOT_FOUND" });
  expect(await list()).toEqual(before);
});

it("отозванная во время ожидания блокировки сессия не допускает запись", async () => {
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
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
  const pending = boundary.saveService(h, token, serviceInput);
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
  expect(await db.service.count()).toBe(0);
});
