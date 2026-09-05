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
const ADMIN_USER_ID = "44444444-4444-4444-8444-444444444444";

function allKeys() {
  return [
    buildAdminAppointmentCreatedDedupeKey({
      appointmentId: APPOINTMENT_ID,
      version: 7,
      adminConnectionId: CONNECTION_ID,
    }),
    buildClientConnectionConfirmedDedupeKey({
      appointmentId: APPOINTMENT_ID,
      appointmentConnectionId: CONNECTION_ID,
    }),
    buildAdminConnectionConfirmedDedupeKey({
      adminUserId: ADMIN_USER_ID,
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
      reminderEpochMillis: 1_799_999_999_999,
      appointmentConnectionId: CONNECTION_ID,
    }),
    buildTelegramConnectionRejectedDedupeKey({ updateId: 987_654_321 }),
  ];
}

describe("Telegram dedupe keys", () => {
  it("строит восемь точных утверждённых строк", () => {
    expect(allKeys()).toEqual([
      `admin-appointment-created:v1:${APPOINTMENT_ID}:v7:c${CONNECTION_ID}`,
      `client-connection-confirmed:v1:${APPOINTMENT_ID}:c${CONNECTION_ID}`,
      `admin-connection-confirmed:v1:${ADMIN_USER_ID}:c${CONNECTION_ID}`,
      `admin-appointment-cancelled:v1:${APPOINTMENT_ID}:v8:c${CONNECTION_ID}`,
      `client-appointment-cancelled:v1:${APPOINTMENT_ID}:v8:c${CONNECTION_ID}`,
      `client-appointment-changed:v1:${APPOINTMENT_ID}:v9:c${CONNECTION_ID}`,
      `client-appointment-reminder:v1:${APPOINTMENT_ID}:v9:at1799999999999:c${CONNECTION_ID}`,
      "telegram-connection-rejected:v1:u987654321",
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

  it("различает version, connection identity, reminder epoch и update", () => {
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
        reminderEpochMillis: 11,
        appointmentConnectionId: CONNECTION_ID,
      }),
    ).not.toBe(
      buildClientAppointmentReminderDedupeKey({
        appointmentId: APPOINTMENT_ID,
        visitVersion: 1,
        reminderEpochMillis: 12,
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
          appointmentId,
          appointmentConnectionId: CONNECTION_ID,
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
});
