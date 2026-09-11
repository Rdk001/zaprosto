import { describe, expect, it } from "vitest";

import {
  TELEGRAM_DEDUPE_KEY_MAX_LENGTH,
  buildAdminAppointmentCancelledDedupeKey,
  buildAdminAppointmentCreatedDedupeKey,
  buildAdminConnectionConfirmedDedupeKey,
  buildClientAppointmentCancelledDedupeKey,
  buildClientAppointmentChangedDedupeKey,
  buildClientAppointmentReminderDedupeKey,
  buildClientConnectionConfirmedDedupeKey,
  buildTelegramConnectionRejectedDedupeKey,
} from "./dedupe";

const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";

function allKeys() {
  return [
    buildAdminAppointmentCreatedDedupeKey({
      appointmentId: APPOINTMENT_ID,
      version: 7,
      adminConnectionId: CONNECTION_ID,
    }),
    buildClientConnectionConfirmedDedupeKey({
      appointmentConnectionId: CONNECTION_ID,
    }),
    buildAdminConnectionConfirmedDedupeKey({
      adminConnectionId: CONNECTION_ID,
    }),
    buildAdminAppointmentCancelledDedupeKey({
      appointmentId: APPOINTMENT_ID,
      version: 8,
      adminConnectionId: CONNECTION_ID,
    }),
    buildClientAppointmentCancelledDedupeKey({
      appointmentId: APPOINTMENT_ID,
      version: 8,
      appointmentConnectionId: CONNECTION_ID,
    }),
    buildClientAppointmentChangedDedupeKey({
      appointmentId: APPOINTMENT_ID,
      version: 9,
      appointmentConnectionId: CONNECTION_ID,
    }),
    buildClientAppointmentReminderDedupeKey({
      appointmentId: APPOINTMENT_ID,
      visitVersion: 9,
      appointmentConnectionId: CONNECTION_ID,
    }),
    buildTelegramConnectionRejectedDedupeKey({ updateId: 987_654_321 }),
  ];
}

describe("Telegram dedupe keys", () => {
  it("строит восемь точных утверждённых строк", () => {
    expect(allKeys()).toEqual([
      `admin-appointment-created:v1:${APPOINTMENT_ID}:v7:c${CONNECTION_ID}`,
      `telegram:v1:appointment-connection:${CONNECTION_ID}:confirmed`,
      `telegram:v1:admin-connection:${CONNECTION_ID}:confirmed`,
      `admin-appointment-cancelled:v1:${APPOINTMENT_ID}:v8:c${CONNECTION_ID}`,
      `client-appointment-cancelled:v1:${APPOINTMENT_ID}:v8:c${CONNECTION_ID}`,
      `client-appointment-changed:v1:${APPOINTMENT_ID}:v9:c${CONNECTION_ID}`,
      `telegram:v1:appointment:${APPOINTMENT_ID}:version:9:connection:${CONNECTION_ID}:reminder`,
      "telegram:v1:update:987654321:connection-rejected",
    ]);
  });

  it("канонизирует UUID и replay возвращает тот же ключ", () => {
    const input = {
      appointmentId: APPOINTMENT_ID.toUpperCase(),
      version: 7,
      adminConnectionId: CONNECTION_ID.toUpperCase(),
    };
    expect(buildAdminAppointmentCreatedDedupeKey(input)).toBe(
      buildAdminAppointmentCreatedDedupeKey(input),
    );
    expect(buildAdminAppointmentCreatedDedupeKey(input)).toContain(APPOINTMENT_ID);
  });

  it("различает version, connection identity и update", () => {
    const base = buildClientAppointmentChangedDedupeKey({
      appointmentId: APPOINTMENT_ID,
      version: 1,
      appointmentConnectionId: CONNECTION_ID,
    });
    expect(
      buildClientAppointmentChangedDedupeKey({
        appointmentId: APPOINTMENT_ID,
        version: 2,
        appointmentConnectionId: CONNECTION_ID,
      }),
    ).not.toBe(base);
    expect(
      buildClientAppointmentChangedDedupeKey({
        appointmentId: APPOINTMENT_ID,
        version: 1,
        appointmentConnectionId: OTHER_CONNECTION_ID,
      }),
    ).not.toBe(base);
    expect(
      buildClientAppointmentReminderDedupeKey({
        appointmentId: APPOINTMENT_ID,
        visitVersion: 1,
        appointmentConnectionId: CONNECTION_ID,
      }),
    ).not.toBe(
      buildClientAppointmentReminderDedupeKey({
        appointmentId: APPOINTMENT_ID,
        visitVersion: 2,
        appointmentConnectionId: CONNECTION_ID,
      }),
    );
    expect(buildTelegramConnectionRejectedDedupeKey({ updateId: 1 })).not.toBe(
      buildTelegramConnectionRejectedDedupeKey({ updateId: 2 }),
    );
  });

  it.each(["not-a-uuid", "11111111-1111-1111-1111-111111111111"])(
    "отклоняет невалидный UUID %s",
    (appointmentId) => {
      expect(() =>
        buildClientConnectionConfirmedDedupeKey({
          appointmentConnectionId: appointmentId,
        }),
      ).toThrow("INVALID_DEDUPE_INPUT");
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "отклоняет невалидное целое %s",
    (updateId) => {
      expect(() => buildTelegramConnectionRejectedDedupeKey({ updateId })).toThrow(
        "INVALID_DEDUPE_INPUT",
      );
    },
  );

  it("каждый построенный ключ укладывается в varchar(255)", () => {
    for (const key of allKeys()) {
      expect(key.length).toBeLessThanOrEqual(TELEGRAM_DEDUPE_KEY_MAX_LENGTH);
      expect(key).not.toMatch(/attempt|job/i);
    }
  });

  it("принимает bigint updateId и не включает запрещённые credentials", () => {
    const key = buildTelegramConnectionRejectedDedupeKey({ updateId: 9_007_199_254_740_993n });
    expect(key).toBe("telegram:v1:update:9007199254740993:connection-rejected");
    for (const canary of [
      "c_TOKEN_CANARY",
      "0123456789abcdef".repeat(4),
      "+79990001122",
      "SESSION_CANARY",
    ]) {
      expect(allKeys().join("|")).not.toContain(canary);
    }
  });
});
