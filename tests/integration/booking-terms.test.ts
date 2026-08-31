import { createHash } from "node:crypto";
import { afterAll, beforeEach, expect, it } from "vitest";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import {
  prepareBookingAttempt,
  hashBookingToken,
} from "../../src/modules/booking/server/booking-security";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url);
const clock = { now: () => new Date("2026-10-01T00:00:00Z") };
const booking = createBookingService(db, clock);
const appointments = createClientAppointmentService(db, clock);
beforeEach(async () => {
  await db.appointment.deleteMany();
  await db.bookingRequest.deleteMany();
  await db.master.deleteMany();
  await db.service.deleteMany();
  await db.businessSettings.upsert({
    where: { id: 1 },
    create: { businessName: "Тест" },
    update: { timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
});
afterAll(async () => {
  await db.$disconnect();
});
async function fixture(any = false) {
  const service = await db.service.create({
    data: { name: "Стрижка", priceKopecks: 150000, durationMinutes: 35 },
  });
  const master = await db.master.create({
    data: {
      name: "Мастер",
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
  const input = {
    ...prepareBookingAttempt(),
    serviceId: service.id,
    expectedServiceTerms: publicServiceTerms(service).termsHash,
    master: any ? { type: "ANY" as const } : { type: "SPECIFIC" as const, masterId: master.id },
    localDate: "2026-10-05",
    startsAt: "2026-10-05T10:00:00+03:00",
    clientName: "Тест Клиент",
    clientPhone: "+79990000000",
  };
  return { service, master, input };
}
async function counts(expected: number) {
  expect(await db.bookingRequest.count()).toBe(expected);
  expect(await db.appointment.count()).toBe(expected);
  expect(await db.appointmentStatusHistory.count()).toBe(expected);
}
const changes = [{ priceKopecks: 250000 }, { durationMinutes: 60 }, { name: "Новое название" }];
for (const any of [false, true]) {
  it.each(changes)(
    "устаревшие показанные условия %j, ANY=" +
      any +
      ": отказ, свежие окна, повторное подтверждение",
    async (change) => {
      const { service, input } = await fixture(any);
      await db.service.update({ where: { id: service.id }, data: change });
      const result = await booking.createBooking(input);
      expect(result).toMatchObject({ ok: false, code: "SERVICE_TERMS_CHANGED" });
      if (result.ok || result.code !== "SERVICE_TERMS_CHANGED")
        throw new Error("Expected changed terms");
      const expected = { name: "Стрижка", priceKopecks: 150000, durationMinutes: 35, ...change };
      expect(result.service).toMatchObject(expected);
      expect(result.service.termsHash).not.toBe(input.expectedServiceTerms);
      const slot = result.availability.slots.find(
        (s) => s.startsAt.toISOString() === "2026-10-05T07:00:00.000Z",
      );
      expect(slot).toBeDefined(); // The duration-only change still fits: not a slot-conflict test.
      expect(slot!.endsAt.getTime() - slot!.startsAt.getTime()).toBe(
        expected.durationMinutes * 60000,
      );
      await counts(0);
      const repeated = await booking.createBooking(input);
      expect(repeated).toMatchObject({ code: "SERVICE_TERMS_CHANGED" });
      await counts(0);
      const confirmed = await booking.createBooking({
        ...input,
        ...prepareBookingAttempt(),
        expectedServiceTerms: result.service.termsHash,
      });
      expect(confirmed).toMatchObject({
        ok: true,
        replayed: false,
        confirmation: { service: expected },
      });
      await counts(1);
    },
  );
}
it.each(changes)("старый формат без отпечатка после %j тоже не создаёт запись", async (change) => {
  const { service, input } = await fixture();
  await db.service.update({ where: { id: service.id }, data: change });
  const legacy = { ...input, expectedServiceTerms: undefined };
  expect(await booking.createBooking(legacy)).toMatchObject({ code: "SERVICE_TERMS_CHANGED" });
  await counts(0);
});
it("отсутствующий отпечаток даже без изменения каталога требует подтверждения", async () => {
  const { input } = await fixture();
  expect(await booking.createBooking({ ...input, expectedServiceTerms: undefined })).toMatchObject({
    code: "SERVICE_TERMS_CHANGED",
  });
  await counts(0);
});
it.each([
  { expectedServiceTerms: "" },
  { expectedServiceTerms: null },
  { expectedServiceTerms: { priceKopecks: 150000 } },
  { expectedServiceTerms: "a".repeat(63) },
  { expectedServiceTerms: "A".repeat(64) },
  { priceKopecks: 1 },
  { durationMinutes: 1 },
])("неполный/подменённый запрос %# не обходит проверку", async (override) => {
  const { input } = await fixture();
  expect(await booking.createBooking({ ...input, ...override })).toMatchObject({
    code: "INVALID_INPUT",
  });
  await counts(0);
});
it("валидный по формату, но чужой отпечаток отвергается", async () => {
  const { input } = await fixture();
  expect(
    await booking.createBooking({ ...input, expectedServiceTerms: "0".repeat(64) }),
  ).toMatchObject({ code: "SERVICE_TERMS_CHANGED" });
  await counts(0);
});
it("длительность без доступного нового интервала возвращает актуальные условия и пустые окна", async () => {
  const { service, input } = await fixture();
  await db.service.update({ where: { id: service.id }, data: { durationMinutes: 600 } });
  expect(await booking.createBooking(input)).toMatchObject({
    code: "SERVICE_TERMS_CHANGED",
    service: { durationMinutes: 600 },
    availability: { slots: [] },
  });
  await counts(0);
});
it("второе изменение после обновления экрана тоже требует подтверждения", async () => {
  const { service, input } = await fixture();
  const fresh = await db.service.update({
    where: { id: service.id },
    data: { priceKopecks: 250000 },
  });
  const refreshedInput = { ...input, expectedServiceTerms: publicServiceTerms(fresh).termsHash };
  await db.service.update({ where: { id: service.id }, data: { durationMinutes: 60 } });
  expect(await booking.createBooking(refreshedInput)).toMatchObject({
    code: "SERVICE_TERMS_CHANGED",
  });
  await counts(0);
});
it("административная версия и порядок без изменения условий не мешают подтверждению", async () => {
  const { service, input } = await fixture();
  await db.service.update({
    where: { id: service.id },
    data: { version: { increment: 1 }, displayOrder: 99 },
  });
  expect(await booking.createBooking(input)).toMatchObject({ ok: true });
  await counts(1);
});
it("потеря успешного ответа, изменение каталога, replay сохраняют снимки, ссылку и историю", async () => {
  const { service, input } = await fixture();
  const original = await booking.createBooking(input); // The caller loses this response.
  if (!original.ok) throw new Error("Expected booking");
  const before = await db.appointment.findUniqueOrThrow({
    where: { id: original.confirmation.id },
    include: { statusHistory: true, bookingRequest: true },
  });
  await db.service.update({
    where: { id: service.id },
    data: { name: "Другая", priceKopecks: 250000, durationMinutes: 60 },
  });
  expect(await booking.createBooking(input)).toEqual({ ...original, replayed: true });
  expect(await appointments.getConfirmation(input.cancellationToken)).toEqual({
    ok: true,
    confirmation: original.confirmation,
  });
  expect(
    await db.appointment.findUniqueOrThrow({
      where: { id: before.id },
      include: { statusHistory: true, bookingRequest: true },
    }),
  ).toEqual(before);
  for (const expectedServiceTerms of [
    undefined,
    publicServiceTerms({ ...service, priceKopecks: 250000 }).termsHash,
  ]) {
    expect(await booking.createBooking({ ...input, expectedServiceTerms })).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  }
  await counts(1);
});
it("существующая попытка booking-v1 без условий воспроизводится после изменения каталога", async () => {
  const { service, master, input } = await fixture();
  const legacy = { ...input, expectedServiceTerms: undefined };
  // Persist the historical wire contract independently of the new fingerprint implementation.
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        "booking-v1",
        legacy.serviceId,
        "SPECIFIC",
        master.id,
        legacy.localDate,
        new Date(legacy.startsAt).toISOString(),
        legacy.clientName,
        legacy.clientPhone,
      ]),
    )
    .digest("hex");
  const row = await db.bookingRequest.create({
    data: {
      idempotencyKey: legacy.idempotencyKey,
      requestHash,
      appointment: {
        create: {
          serviceId: service.id,
          masterId: master.id,
          startsAt: new Date(legacy.startsAt),
          endsAt: new Date("2026-10-05T07:35:00Z"),
          clientName: legacy.clientName,
          clientPhone: legacy.clientPhone,
          status: "SCHEDULED",
          source: "ONLINE",
          masterSelection: "SPECIFIC",
          serviceNameSnapshot: service.name,
          servicePriceSnapshot: service.priceKopecks,
          serviceDurationSnapshot: service.durationMinutes,
          cancellationTokenHash: hashBookingToken(legacy.cancellationToken),
          statusHistory: {
            create: {
              previousStatus: null,
              newStatus: "SCHEDULED",
              changedBy: "CLIENT",
              changedAt: clock.now(),
            },
          },
        },
      },
    },
    include: { appointment: true },
  });
  await db.service.update({
    where: { id: service.id },
    data: { name: "Другая", priceKopecks: 250000, durationMinutes: 60 },
  });
  const replay = await booking.createBooking(legacy);
  expect(replay).toMatchObject({
    ok: true,
    replayed: true,
    cancellationToken: legacy.cancellationToken,
    confirmation: {
      id: row.appointment!.id,
      service: { name: "Стрижка", priceKopecks: 150000, durationMinutes: 35 },
    },
  });
  expect(await appointments.getConfirmation(legacy.cancellationToken)).toMatchObject({
    ok: true,
    confirmation: { id: row.appointment!.id },
  });
  expect(await db.bookingRequest.findUnique({ where: { id: row.id } })).toMatchObject({
    requestHash,
  });
  await counts(1);
});
