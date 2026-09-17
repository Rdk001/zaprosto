import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TELEGRAM_MESSAGE_MAX_CODE_POINTS,
  TelegramMessageBuildError,
  buildTelegramMessage,
  type TelegramMessageBuilderInput,
} from "./message-builder";
import { normalizeTelegramPlainText } from "./plain-text";

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

function identity() {
  const snapshot = visit();
  return {
    serviceId: snapshot.serviceId,
    masterId: snapshot.masterId,
    startsAt: snapshot.startsAt,
    endsAt: snapshot.endsAt,
    durationMinutes: snapshot.durationMinutes,
  };
}

function resolvedVisit(overrides: Record<string, unknown> = {}) {
  return {
    status: "SCHEDULED" as const,
    startsAt: "2026-09-10T10:00:00.000Z",
    businessTimeZone: "Europe/Moscow",
    serviceName: "Стрижка",
    masterName: "Анна",
    ...overrides,
  };
}

function changedPayload(changedFields: ("SERVICE" | "MASTER" | "STARTS_AT")[]) {
  const after = visit({
    ...(changedFields.includes("SERVICE")
      ? {
          serviceId: OTHER_SERVICE_ID,
          serviceName: "Окрашивание",
          durationMinutes: 90,
          endsAt: "2026-09-10T11:30:00.000Z",
        }
      : {}),
    ...(changedFields.includes("MASTER") ? { masterId: OTHER_MASTER_ID, masterName: "Мария" } : {}),
    ...(changedFields.includes("STARTS_AT")
      ? {
          startsAt: "2026-09-11T12:30:00.000Z",
          endsAt: changedFields.includes("SERVICE")
            ? "2026-09-11T14:00:00.000Z"
            : "2026-09-11T13:30:00.000Z",
        }
      : {}),
  });
  return {
    appointmentVersion: 3,
    occurredAt: "2026-09-05T08:00:00.000Z",
    changedFields,
    before: visit(),
    after,
  };
}

function buildCreated(snapshot = visit()) {
  return buildTelegramMessage({
    notificationType: "ADMIN_APPOINTMENT_CREATED",
    payloadVersion: 1,
    payload: {
      source: "PUBLIC",
      appointmentVersion: 0,
      occurredAt: "2026-09-05T08:00:00.000Z",
      visit: snapshot,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Telegram message builder", () => {
  it.each<[TelegramMessageBuilderInput, string]>([
    [
      {
        notificationType: "ADMIN_APPOINTMENT_CREATED",
        payloadVersion: 1,
        payload: {
          source: "PUBLIC",
          appointmentVersion: 0,
          occurredAt: "2026-09-05T08:00:00.000Z",
          visit: visit(),
        },
      },
      "Новая запись",
    ],
    [
      {
        notificationType: "ADMIN_APPOINTMENT_CANCELLED",
        payloadVersion: 1,
        payload: {
          actor: "CLIENT",
          appointmentVersion: 1,
          occurredAt: "2026-09-05T08:00:00.000Z",
          visit: visit(),
        },
      },
      "отменена клиентом",
    ],
    [
      {
        notificationType: "CLIENT_APPOINTMENT_CANCELLED",
        payloadVersion: 1,
        payload: {
          actor: "ADMIN",
          appointmentVersion: 2,
          occurredAt: "2026-09-05T08:00:00.000Z",
          visit: visit(),
        },
      },
      "отменена администратором",
    ],
    [
      {
        notificationType: "CLIENT_APPOINTMENT_CHANGED",
        payloadVersion: 1,
        payload: changedPayload(["SERVICE", "MASTER", "STARTS_AT"]),
      },
      "Ваша запись изменена",
    ],
    [
      {
        notificationType: "CLIENT_APPOINTMENT_REMINDER",
        payloadVersion: 1,
        payload: { visitVersion: 4, expectedVisit: identity() },
        resolvedContext: resolvedVisit(),
      },
      "Напоминание о записи",
    ],
    [
      {
        notificationType: "CLIENT_CONNECTION_CONFIRMED",
        payloadVersion: 1,
        payload: {},
        resolvedContext: resolvedVisit(),
      },
      "Подключение клиента к Telegram подтверждено",
    ],
    [
      {
        notificationType: "ADMIN_CONNECTION_CONFIRMED",
        payloadVersion: 1,
        payload: {},
        resolvedContext: { adminStatus: "ACTIVE" },
      },
      "Подключение администратора к Telegram подтверждено",
    ],
    [
      {
        notificationType: "TELEGRAM_CONNECTION_REJECTED",
        payloadVersion: 1,
        payload: {},
      },
      "Не удалось подключить Telegram",
    ],
  ])("строит понятный русский текст для %#", (input, expected) => {
    const result = buildTelegramMessage(input);
    expect(result.text).toContain(expected);
    expect(result.text).not.toMatch(/[<>]/);
  });

  it("форматирует одну UTC-дату в разных business timezone", () => {
    const moscow = buildCreated(visit({ businessTimeZone: "Europe/Moscow" })).text;
    const newYork = buildCreated(visit({ businessTimeZone: "America/New_York" })).text;

    expect(moscow).toContain("Дата: 10.09.2026\nВремя: 13:00");
    expect(newYork).toContain("Дата: 10.09.2026\nВремя: 06:00");
  });

  it("не зависит от системной timezone и не читает clock", () => {
    const originalTimeZone = process.env.TZ;
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock must not be read");
    });
    process.env.TZ = "Pacific/Honolulu";
    const first = buildCreated().text;
    process.env.TZ = "Asia/Tokyo";
    const second = buildCreated().text;
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }

    expect(first).toBe(second);
    expect(first).toContain("Время: 13:00");
    expect(now).not.toHaveBeenCalled();
  });

  it("использует общий sanitizer: удаляет controls, сохраняет переносы и Unicode", () => {
    expect(normalizeTelegramPlainText("a\r\nb\rc\u2028d\u2029e\t\u0000Я😀")).toBe(
      "a\nb\nc\nd\neЯ😀",
    );
    const result = buildCreated(visit({ serviceName: "СПА\r\nУход\u0000😀" }));
    expect(result.text).toContain("Услуга: СПА\nУход😀");
    expect(result.text.isWellFormed()).toBe(true);
  });

  it("считает Unicode code points и принимает ровно 2000", () => {
    const oneCharacter = buildCreated(visit({ serviceName: "x" })).text;
    const fixedLength = Array.from(oneCharacter).length - 1;
    const serviceName = "😀".repeat(TELEGRAM_MESSAGE_MAX_CODE_POINTS - fixedLength);
    const result = buildCreated(visit({ serviceName }));

    expect(Array.from(result.text)).toHaveLength(TELEGRAM_MESSAGE_MAX_CODE_POINTS);
    expect(result.text.length).toBeGreaterThan(TELEGRAM_MESSAGE_MAX_CODE_POINTS);
  });

  it("не обрезает сообщение при превышении внутреннего лимита", () => {
    const oneCharacter = buildCreated(visit({ serviceName: "x" })).text;
    const fixedLength = Array.from(oneCharacter).length - 1;
    const serviceName = "😀".repeat(TELEGRAM_MESSAGE_MAX_CODE_POINTS - fixedLength + 1);

    expect(() => buildCreated(visit({ serviceName }))).toThrowError(
      expect.objectContaining({ code: "MESSAGE_TOO_LONG" }),
    );
  });

  it.each([
    [
      {
        notificationType: "CLIENT_CONNECTION_CONFIRMED",
        payloadVersion: 2,
        payload: {},
        resolvedContext: resolvedVisit(),
      },
      "PAYLOAD_VERSION_UNSUPPORTED",
    ],
    [
      {
        notificationType: "ADMIN_APPOINTMENT_CREATED",
        payloadVersion: 1,
        payload: { secret: "PII_SECRET_CANARY" },
      },
      "PAYLOAD_INVALID",
    ],
    [
      { notificationType: "UNKNOWN", payloadVersion: 1, payload: {} },
      "NOTIFICATION_TYPE_UNSUPPORTED",
    ],
  ])("возвращает безопасную постоянную ошибку для неверного input", (input, code) => {
    let error: unknown;
    try {
      buildTelegramMessage(input as never);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TelegramMessageBuildError);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain("PII_SECRET_CANARY");
  });

  it("возвращает типизированную ошибку для невалидной timezone", () => {
    expect(() =>
      buildTelegramMessage({
        notificationType: "CLIENT_CONNECTION_CONFIRMED",
        payloadVersion: 1,
        payload: {},
        resolvedContext: resolvedVisit({ businessTimeZone: "Mars/Olympus" }),
      }),
    ).toThrowError(expect.objectContaining({ code: "TIME_ZONE_INVALID" }));
  });

  it("честно показывает отменённое live-состояние при клиентском подключении", () => {
    const result = buildTelegramMessage({
      notificationType: "CLIENT_CONNECTION_CONFIRMED",
      payloadVersion: 1,
      payload: {},
      resolvedContext: resolvedVisit({ status: "CANCELLED" }),
    });

    expect(result.text).toContain("запись уже отменена");
    expect(result.text).not.toContain("Текущая запись подтверждена");
    expect(result.text).not.toContain("SCHEDULED");
    expect(result.text).not.toContain("CANCELLED");
  });

  it("делает отказ подключения нейтральным", () => {
    const result = buildTelegramMessage({
      notificationType: "TELEGRAM_CONNECTION_REJECTED",
      payloadVersion: 1,
      payload: {},
    });

    expect(result.text).toBe(
      "Не удалось подключить Telegram.\nПолучите новую ссылку и повторите подключение.",
    );
    expect(result.text).not.toMatch(/токен|ист[её]к|пользователь|администратор/i);
  });

  it("показывает в changed только заявленные изменения", () => {
    const result = buildTelegramMessage({
      notificationType: "CLIENT_APPOINTMENT_CHANGED",
      payloadVersion: 1,
      payload: changedPayload(["MASTER"]),
    });

    expect(result.text).toContain("Было:\nМастер: Анна\nСтало:\nМастер: Мария");
    expect(result.text).not.toContain("Услуга:");
    expect(result.text).not.toContain("Дата и время:");
    expect(result.text).not.toMatch(/\bMASTER\b/);
  });

  it("не выводит UUID, версии и запрещённые персональные или технические поля", () => {
    const result = buildCreated();
    for (const forbidden of [
      SERVICE_ID,
      MASTER_ID,
      "+79990000000",
      "Иван Клиент",
      "1234 ₽",
      "telegramUserId",
      "telegramChatId",
      "appointmentVersion",
      "dedupe",
      "token",
      "http://",
      "https://",
    ]) {
      expect(result.text).not.toContain(forbidden);
    }
  });

  it("не вызывает fetch, Prisma, clock или environment", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("no clock");
    });
    const source = readFileSync(new URL("./message-builder.ts", import.meta.url), "utf8");
    const result = buildCreated();

    expect(result.text).toContain("Новая запись");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
    expect(source).not.toMatch(/@prisma|\bfetch\b|Date\.now|process\.env/);
  });

  it("не мутирует payload и resolved-контекст", () => {
    const input = {
      notificationType: "CLIENT_APPOINTMENT_REMINDER" as const,
      payloadVersion: 1,
      payload: { visitVersion: 4, expectedVisit: identity() },
      resolvedContext: resolvedVisit(),
    };
    const before = structuredClone(input);

    buildTelegramMessage(input);

    expect(input).toEqual(before);
  });
});
