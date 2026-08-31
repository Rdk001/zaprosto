import { businessContextHash } from "../../src/modules/settings/server/context";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemo, demoMasterIds, demoServiceIds } from "../../scripts/demo-data";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createPublicBoundary } from "../../src/server/public/boundary";
import { createRateLimiter } from "../../src/server/public/security";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import { prepareBookingAttempt } from "../../src/modules/booking/server/booking-security";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated test:postgres runner");
const db = createPrismaClient(url);
const other = createPrismaClient(url);
const clock = { now: () => new Date("2026-09-01T00:00:00Z") };
const booking = createBookingService(db, clock);
const appointments = createClientAppointmentService(db, clock);
const boundary = createPublicBoundary({
  booking,
  appointments,
  database: db,
  clock,
  limit: createRateLimiter(db),
});
const headers = new Headers({ origin: "https://booking.example", "sec-fetch-site": "same-origin" });
const keys: string[] = [];
let expectedServiceTerms: string;
let expectedBusinessContext: string;
function input(any = false) {
  const pair = prepareBookingAttempt();
  keys.push(pair.idempotencyKey);
  return {
    ...pair,
    serviceId: demoServiceIds[0],
    expectedServiceTerms,
    expectedBusinessContext,
    master: any ? { type: "ANY" } : { type: "SPECIFIC", masterId: demoMasterIds[0] },
    localDate: "2026-09-02",
    startsAt: "2026-09-02T10:00:00+03:00",
    clientName: "Вымышленный Клиент",
    clientPhone: "8 (999) 000-00-00",
  };
}
beforeAll(async () => {
  vi.stubEnv("PUBLIC_ORIGIN", "https://booking.example");
  await seedDemo(db);
  expectedBusinessContext = businessContextHash(
    await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
  );
  expectedServiceTerms = publicServiceTerms(
    await db.service.findUniqueOrThrow({ where: { id: demoServiceIds[0] } }),
  ).termsHash;
});
beforeEach(async () => {
  await db.publicRateLimit.deleteMany();
  await db.appointmentStatusHistory.deleteMany({
    where: { appointment: { bookingRequest: { idempotencyKey: { in: keys } } } },
  });
  await db.appointment.deleteMany({ where: { bookingRequest: { idempotencyKey: { in: keys } } } });
  await db.bookingRequest.deleteMany({ where: { idempotencyKey: { in: keys } } });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await other.$disconnect();
});
describe("реальные публичные операции", () => {
  it.each([false, true])("создание, чтение и подтверждённая отмена (ANY=%s)", async (any) => {
    const request = input(any);
    const result = await boundary.create(headers, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confirmation.clientPhone).toBe("+79990000000");
    expect(result.confirmation.service.priceKopecks).toBe(180000);
    const read = await boundary.lookup(headers, request.cancellationToken);
    expect(read.ok).toBe(true);
    expect(
      await boundary.cancel(headers, { token: request.cancellationToken, confirmed: false }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(
      (await db.appointment.findUniqueOrThrow({ where: { id: result.confirmation.id } })).status,
    ).toBe("SCHEDULED");
    expect(
      await boundary.cancel(headers, {
        token: request.cancellationToken,
        confirmed: true,
        reason: "Вымышленная причина",
      }),
    ).toMatchObject({ ok: true, alreadyCancelled: false });
    expect(
      await boundary.cancel(headers, { token: request.cancellationToken, confirmed: true }),
    ).toMatchObject({ ok: true, alreadyCancelled: true });
  });
  it("повтор исходного запроса не создаёт вторую запись; другой секрет не даёт доступ", async () => {
    const request = input();
    const a = await boundary.create(headers, request);
    const b = await boundary.create(headers, request);
    expect(a.ok && b.ok && a.confirmation.id === b.confirmation.id).toBe(true);
    expect(
      await boundary.create(headers, {
        ...request,
        cancellationToken: prepareBookingAttempt().cancellationToken,
      }),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await boundary.lookup(headers, request.idempotencyKey)).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await boundary.lookup(headers, prepareBookingAttempt().cancellationToken)).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });
  it("подменённые серверные поля, телефон и excludeAppointmentId отвергаются", async () => {
    for (const extra of [
      { priceKopecks: 1 },
      { endsAt: "2030-01-01" },
      { status: "CANCELLED" },
      { clientPhone: "+18000000000" },
    ])
      expect(await boundary.create(headers, { ...input(), ...extra })).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
      });
    expect(
      await boundary.availability(headers, {
        serviceId: demoServiceIds[0],
        localDate: "2026-09-02",
        excludeAppointmentId: demoMasterIds[0],
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
  it("Origin проверяется до выполнения сервиса, Host и proxy не разрешают обход", async () => {
    for (const h of [
      new Headers(),
      new Headers({
        origin: "https://evil.example",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
      }),
    ]) {
      expect(await boundary.create(h, input())).toEqual({ ok: false, code: "FORBIDDEN" });
      expect(await boundary.prepare(h)).toEqual({ ok: false, code: "FORBIDDEN" });
      expect(await boundary.lookup(h, prepareBookingAttempt().cancellationToken)).toEqual({
        ok: false,
        code: "FORBIDDEN",
      });
      expect(await boundary.cancel(h, {})).toEqual({ ok: false, code: "FORBIDDEN" });
    }
    expect(await db.publicRateLimit.count()).toBe(0);
  });
  it("неожиданная ошибка не раскрывает Prisma/PII и не считается отказом", async () => {
    const spy = vi
      .spyOn(booking, "createBooking")
      .mockRejectedValueOnce(new Error("Prisma secret phone token"));
    expect(await boundary.create(headers, input())).toEqual({ ok: false, code: "UNAVAILABLE" });
    spy.mockRestore();
  });
  it("fail-closed при недоступности limiter", async () => {
    const failed = createPublicBoundary({
      booking,
      appointments,
      database: db,
      clock,
      limit: async () => {
        throw new Error("database down");
      },
    });
    expect(await failed.create(headers, input())).toEqual({ ok: false, code: "UNAVAILABLE" });
  });
  it("лимит атомарен для двух клиентов БД", async () => {
    const one = createRateLimiter(db),
      two = createRateLimiter(other);
    const results = await Promise.all(
      Array.from({ length: 26 }, (_, i) => (i % 2 ? one : two)("prepare", "test-client")),
    );
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(await one("prepare", "another-client")).toBe(true);
  });
  it.each(["create", "lookup", "cancel"] as const)(
    "ограничивает %s до обращения к сервису",
    async (operation) => {
      await db.publicRateLimit.create({
        data: { key: operation + ":shared", hits: 9999, expiresAt: new Date(Date.now() + 60000) },
      });
      const raw = operation === "lookup" ? prepareBookingAttempt().cancellationToken : input();
      expect(await boundary[operation](headers, raw)).toEqual({ ok: false, code: "RATE_LIMITED" });
    },
  );
  it("истёкший счётчик очищается; глобальный ограничивает смену IP", async () => {
    await db.publicRateLimit.create({
      data: { key: "lookup:global", hits: 9999, expiresAt: new Date(Date.now() - 1000) },
    });
    const limit = createRateLimiter(db);
    expect(await limit("lookup", "first")).toBe(true);
    await db.publicRateLimit.update({ where: { key: "lookup:global" }, data: { hits: 600 } });
    expect(await limit("lookup", "new-identity")).toBe(false);
  });
});

it("demo:seed повторяется без изменения существующих строк", async () => {
  const before = await db.master.findMany({
    where: { id: { in: demoMasterIds } },
    include: { weeklyWorkIntervals: true, weeklyBreaks: true },
  });
  await seedDemo(db);
  const after = await db.master.findMany({
    where: { id: { in: demoMasterIds } },
    include: { weeklyWorkIntervals: true, weeklyBreaks: true },
  });
  expect(after).toEqual(before);
  expect(await db.service.count({ where: { id: { in: demoServiceIds } } })).toBe(3);
});
