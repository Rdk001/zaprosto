import { describe, expect, it } from "vitest";

import { TELEGRAM_POLICY } from "./policy";
import {
  TELEGRAM_NOTIFICATION_TYPES,
  parseTelegramPayloadV1,
  type TelegramNotificationType,
} from "./payload-v1";

const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const MASTER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_MASTER_ID = "44444444-4444-4444-8444-444444444444";

function visit(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: SERVICE_ID,
    masterId: MASTER_ID,
    startsAt: "2026-09-10T10:00:00.000Z",
    endsAt: "2026-09-10T11:00:00.000Z",
    durationMinutes: 60,
    businessTimeZone: "Europe/Moscow",
    serviceName: "Стрижка",
    masterName: "Анна",
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  const snapshot = visit(overrides);
  return {
    serviceId: snapshot.serviceId,
    masterId: snapshot.masterId,
    startsAt: snapshot.startsAt,
    endsAt: snapshot.endsAt,
    durationMinutes: snapshot.durationMinutes,
  };
}

const validExamples: readonly [TelegramNotificationType, unknown][] = [
  [
    "ADMIN_APPOINTMENT_CREATED",
    {
      source: "PUBLIC",
      appointmentVersion: 0,
      occurredAt: "2026-09-05T08:00:00.000Z",
      visit: visit(),
    },
  ],
  [
    "ADMIN_APPOINTMENT_CANCELLED",
    {
      actor: "CLIENT",
      appointmentVersion: 1,
      occurredAt: "2026-09-05T08:00:00.000Z",
      visit: visit(),
    },
  ],
  [
    "CLIENT_APPOINTMENT_CANCELLED",
    {
      actor: "ADMIN",
      appointmentVersion: 2,
      occurredAt: "2026-09-05T08:00:00.000Z",
      visit: visit(),
    },
  ],
  [
    "CLIENT_APPOINTMENT_CHANGED",
    {
      appointmentVersion: 3,
      occurredAt: "2026-09-05T08:00:00.000Z",
      changedFields: ["SERVICE", "MASTER", "STARTS_AT"],
      before: visit(),
      after: visit({
        serviceId: OTHER_SERVICE_ID,
        serviceName: "Окрашивание",
        durationMinutes: 90,
        masterId: OTHER_MASTER_ID,
        masterName: "Мария",
        startsAt: "2026-09-10T12:00:00.000Z",
        endsAt: "2026-09-10T13:30:00.000Z",
      }),
    },
  ],
  ["CLIENT_APPOINTMENT_REMINDER", { visitVersion: 4, expectedVisit: identity() }],
  ["CLIENT_CONNECTION_CONFIRMED", {}],
  ["ADMIN_CONNECTION_CONFIRMED", {}],
  ["TELEGRAM_CONNECTION_REJECTED", {}],
];

function parse(type: TelegramNotificationType, payload: unknown, payloadVersion: unknown = 1) {
  return parseTelegramPayloadV1({ notificationType: type, payloadVersion, payload });
}

describe("Telegram payload v1", () => {
  it("имеет валидный пример каждого NotificationType", () => {
    expect(validExamples.map(([type]) => type)).toEqual(TELEGRAM_NOTIFICATION_TYPES);
    for (const [notificationType, payload] of validExamples) {
      expect(parse(notificationType, payload)).toMatchObject({
        ok: true,
        notificationType,
        payloadVersion: 1,
      });
    }
  });

  it("канонизирует UUID и принимает только UTC ISO 8601", () => {
    const result = parse("CLIENT_APPOINTMENT_REMINDER", {
      visitVersion: 0,
      expectedVisit: identity({
        serviceId: SERVICE_ID.toUpperCase(),
        masterId: MASTER_ID.toUpperCase(),
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      payload: { expectedVisit: { serviceId: SERVICE_ID, masterId: MASTER_ID } },
    });

    for (const startsAt of [
      "not-a-date",
      "2026-02-30T10:00:00.000Z",
      "2026-09-10T13:00:00+03:00",
      "2026-09-10 10:00:00Z",
    ]) {
      expect(
        parse("CLIENT_APPOINTMENT_REMINDER", {
          visitVersion: 0,
          expectedVisit: identity({ startsAt }),
        }),
      ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
    }
  });

  it("запрещает дополнительные поля на каждом уровне", () => {
    expect(
      parse("ADMIN_APPOINTMENT_CREATED", {
        source: "ADMIN",
        appointmentVersion: 1,
        occurredAt: "2026-09-05T08:00:00.000Z",
        visit: visit(),
        extra: true,
      }),
    ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
    expect(
      parse("ADMIN_APPOINTMENT_CREATED", {
        source: "ADMIN",
        appointmentVersion: 1,
        occurredAt: "2026-09-05T08:00:00.000Z",
        visit: visit({ extra: true }),
      }),
    ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
    expect(parse("CLIENT_CONNECTION_CONFIRMED", { anything: true })).toEqual({
      ok: false,
      code: "PAYLOAD_INVALID",
    });
  });

  it.each([
    ["serviceId", "bad"],
    ["masterId", "bad"],
    ["durationMinutes", 0],
    ["durationMinutes", -1],
    ["durationMinutes", 1.5],
    ["durationMinutes", Number.MAX_SAFE_INTEGER + 1],
    ["businessTimeZone", "Mars/Olympus"],
  ])("отклоняет неверное поле visit %s", (field, value) => {
    expect(
      parse("ADMIN_APPOINTMENT_CREATED", {
        source: "PUBLIC",
        appointmentVersion: 0,
        occurredAt: "2026-09-05T08:00:00.000Z",
        visit: visit({ [field]: value }),
      }),
    ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
  });

  it("требует endsAt строго позже startsAt", () => {
    for (const endsAt of ["2026-09-10T10:00:00.000Z", "2026-09-10T09:59:59.999Z"]) {
      expect(
        parse("CLIENT_APPOINTMENT_REMINDER", {
          visitVersion: 1,
          expectedVisit: identity({ endsAt }),
        }),
      ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
    }
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "отклоняет appointmentVersion=%s",
    (appointmentVersion) => {
      expect(
        parse("ADMIN_APPOINTMENT_CREATED", {
          source: "PUBLIC",
          appointmentVersion,
          occurredAt: "2026-09-05T08:00:00.000Z",
          visit: visit(),
        }),
      ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
    },
  );

  it("проверяет enum source и actor", () => {
    expect(
      parse("ADMIN_APPOINTMENT_CREATED", {
        source: "CLIENT",
        appointmentVersion: 0,
        occurredAt: "2026-09-05T08:00:00.000Z",
        visit: visit(),
      }),
    ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
    expect(
      parse("CLIENT_APPOINTMENT_CANCELLED", {
        actor: "CLIENT",
        appointmentVersion: 1,
        occurredAt: "2026-09-05T08:00:00.000Z",
        visit: visit(),
      }),
    ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
  });

  it.each([
    [["MASTER", "SERVICE"], visit({ masterId: OTHER_MASTER_ID, serviceId: OTHER_SERVICE_ID })],
    [["SERVICE", "SERVICE"], visit({ serviceId: OTHER_SERVICE_ID })],
    [[], visit({ serviceId: OTHER_SERVICE_ID })],
    [["MASTER"], visit({ serviceId: OTHER_SERVICE_ID })],
    [["SERVICE"], visit()],
    [["SERVICE"], visit({ endsAt: "2026-09-10T12:00:00.000Z" })],
    [["STARTS_AT"], visit({ businessTimeZone: "UTC" })],
  ])("отклоняет changedFields, не соответствующие before/after", (changedFields, after) => {
    expect(
      parse("CLIENT_APPOINTMENT_CHANGED", {
        appointmentVersion: 1,
        occurredAt: "2026-09-05T08:00:00.000Z",
        changedFields,
        before: visit(),
        after,
      }),
    ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
  });

  it("сопоставляет endsAt/duration с SERVICE или STARTS_AT", () => {
    expect(
      parse("CLIENT_APPOINTMENT_CHANGED", {
        appointmentVersion: 2,
        occurredAt: "2026-09-05T08:00:00.000Z",
        changedFields: ["SERVICE"],
        before: visit(),
        after: visit({ durationMinutes: 90, endsAt: "2026-09-10T11:30:00.000Z" }),
      }),
    ).toMatchObject({ ok: true });
    expect(
      parse("CLIENT_APPOINTMENT_CHANGED", {
        appointmentVersion: 2,
        occurredAt: "2026-09-05T08:00:00.000Z",
        changedFields: ["STARTS_AT"],
        before: visit(),
        after: visit({
          startsAt: "2026-09-10T12:00:00.000Z",
          endsAt: "2026-09-10T13:00:00.000Z",
        }),
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    "clientName",
    "clientPhone",
    "cancellationReason",
    "cancellationToken",
    "cancellationHash",
    "telegramLinkToken",
    "telegramLinkHash",
    "botToken",
    "cookie",
    "session",
    "credential",
    "startUrl",
    "telegramChatId",
    "telegramUserId",
    "telegramResponse",
  ])("запрещает чувствительное поле %s", (forbiddenField) => {
    expect(
      parse("ADMIN_APPOINTMENT_CREATED", {
        source: "ADMIN",
        appointmentVersion: 1,
        occurredAt: "2026-09-05T08:00:00.000Z",
        visit: visit(),
        [forbiddenField]: "SECRET_CANARY",
      }),
    ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
  });

  it("не принимает целую Appointment вместо минимального snapshot", () => {
    expect(
      parse("ADMIN_APPOINTMENT_CREATED", {
        source: "PUBLIC",
        appointmentVersion: 1,
        occurredAt: "2026-09-05T08:00:00.000Z",
        visit: visit({ status: "SCHEDULED", clientName: "Иван", clientPhone: "+79990000000" }),
      }),
    ).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
  });

  it("принимает ровно 16 KiB сериализации и отклоняет следующий байт", () => {
    const base = {
      source: "PUBLIC",
      appointmentVersion: 1,
      occurredAt: "2026-09-05T08:00:00.000Z",
      visit: visit({ serviceName: "" }),
    };
    const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
    const exact = structuredClone(base);
    exact.visit.serviceName = "x".repeat(TELEGRAM_POLICY.maxSerializedPayloadBytes - overhead);
    const oversized = structuredClone(exact);
    oversized.visit.serviceName += "x";

    const accepted = parse("ADMIN_APPOINTMENT_CREATED", exact);
    expect(accepted).toMatchObject({ ok: true });
    if (accepted.ok) {
      expect(Buffer.byteLength(accepted.serialized, "utf8")).toBe(
        TELEGRAM_POLICY.maxSerializedPayloadBytes,
      );
    }
    expect(parse("ADMIN_APPOINTMENT_CREATED", oversized)).toEqual({
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("не трактует неизвестную payloadVersion как v1", () => {
    expect(parse("CLIENT_CONNECTION_CONFIRMED", {}, 2)).toEqual({
      ok: false,
      code: "PAYLOAD_VERSION_UNSUPPORTED",
    });
    expect(parse("CLIENT_CONNECTION_CONFIRMED", {}, "1")).toEqual({
      ok: false,
      code: "PAYLOAD_VERSION_UNSUPPORTED",
    });
  });

  it("возвращает контролируемую ошибку без исходного payload и PII", () => {
    const piiCanary = "CLIENT_PHONE_AND_SECRET_CANARY";
    const result = parse("ADMIN_APPOINTMENT_CREATED", {
      source: "PUBLIC",
      appointmentVersion: 1,
      occurredAt: "invalid",
      visit: visit(),
      clientPhone: piiCanary,
    });
    expect(result).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
    expect(JSON.stringify(result)).not.toContain(piiCanary);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(parse("CLIENT_CONNECTION_CONFIRMED", circular)).toEqual({
      ok: false,
      code: "PAYLOAD_INVALID",
    });
  });
});
