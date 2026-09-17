import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../../generated/prisma/client";
import {
  classifyTelegramDeliveryPreflight,
  TelegramDeliveryPreflight,
  type TelegramDeliveryPreflightSnapshot,
} from "./delivery-preflight";

const ids = {
  job: "11111111-1111-4111-8111-111111111111",
  lease: "22222222-2222-4222-8222-222222222222",
  appointment: "33333333-3333-4333-8333-333333333333",
  appointmentConnection: "44444444-4444-4444-8444-444444444444",
  adminConnection: "55555555-5555-4555-8555-555555555555",
  service: "66666666-6666-4666-8666-666666666666",
  master: "77777777-7777-4777-8777-777777777777",
};
const now = new Date("2032-02-01T08:00:00.000Z");
const startsAt = new Date("2032-02-01T11:00:00.000Z");
const endsAt = new Date("2032-02-01T11:30:00.000Z");
const scheduledAt = new Date("2032-02-01T09:00:00.000Z");
const expiresAt = new Date("2032-02-01T09:15:00.000Z");

const visit = {
  serviceId: ids.service,
  masterId: ids.master,
  startsAt: startsAt.toISOString(),
  endsAt: endsAt.toISOString(),
  durationMinutes: 30,
};
const visitSnapshot = {
  ...visit,
  businessTimeZone: "Europe/Moscow",
  serviceName: "Стрижка",
  masterName: "Иван",
};

function snapshot(
  type: TelegramDeliveryPreflightSnapshot["type"],
): TelegramDeliveryPreflightSnapshot {
  const client = type.startsWith("CLIENT_");
  const direct = type === "TELEGRAM_CONNECTION_REJECTED";
  const appointmentEvent =
    client || type === "ADMIN_APPOINTMENT_CREATED" || type === "ADMIN_APPOINTMENT_CANCELLED";
  const payload = {
    ADMIN_APPOINTMENT_CREATED: {
      source: "PUBLIC",
      appointmentVersion: 0,
      occurredAt: now.toISOString(),
      visit: visitSnapshot,
    },
    ADMIN_APPOINTMENT_CANCELLED: {
      actor: "CLIENT",
      appointmentVersion: 1,
      occurredAt: now.toISOString(),
      visit: visitSnapshot,
    },
    CLIENT_APPOINTMENT_CANCELLED: {
      actor: "ADMIN",
      appointmentVersion: 1,
      occurredAt: now.toISOString(),
      visit: visitSnapshot,
    },
    CLIENT_APPOINTMENT_CHANGED: {
      appointmentVersion: 1,
      occurredAt: now.toISOString(),
      changedFields: ["STARTS_AT"],
      before: {
        ...visitSnapshot,
        startsAt: "2032-02-01T10:30:00.000Z",
        endsAt: "2032-02-01T11:00:00.000Z",
      },
      after: visitSnapshot,
    },
    CLIENT_APPOINTMENT_REMINDER: { visitVersion: 0, expectedVisit: visit },
    CLIENT_CONNECTION_CONFIRMED: {},
    ADMIN_CONNECTION_CONFIRMED: {},
    TELEGRAM_CONNECTION_REJECTED: {},
  }[type];
  return {
    databaseNow: now,
    id: ids.job,
    type,
    status: "PROCESSING",
    scheduledAt: type === "CLIENT_APPOINTMENT_REMINDER" ? scheduledAt : now,
    expiresAt: type === "CLIENT_APPOINTMENT_REMINDER" || direct ? expiresAt : null,
    leaseToken: ids.lease,
    claimedAt: new Date(now.getTime() - 1_000),
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    invalidatedAt: null,
    invalidationCode: null,
    payloadVersion: 1,
    payload,
    recipientKind: direct ? "DIRECT_CHAT" : client ? "APPOINTMENT_CONNECTION" : "ADMIN_CONNECTION",
    appointmentId: appointmentEvent ? ids.appointment : null,
    appointmentConnectionId: client ? ids.appointmentConnection : null,
    adminConnectionId: !client && !direct ? ids.adminConnection : null,
    directChatId: direct ? 103n : null,
    appointmentConnectionAppointmentId: client ? ids.appointment : null,
    appointmentConnectionChatId: client ? 101n : null,
    appointmentConnectionDisabledAt: null,
    adminConnectionChatId: !client && !direct ? 102n : null,
    adminConnectionDisabledAt: null,
    adminUserActive: !client && !direct ? true : null,
    appointmentStatus: appointmentEvent ? "SCHEDULED" : null,
    appointmentStartsAt: appointmentEvent ? startsAt : null,
    appointmentEndsAt: appointmentEvent ? endsAt : null,
    appointmentServiceId: appointmentEvent ? ids.service : null,
    appointmentMasterId: appointmentEvent ? ids.master : null,
    appointmentServiceDurationSnapshot: appointmentEvent ? 30 : null,
    appointmentServiceNameSnapshot: appointmentEvent ? "Стрижка" : null,
    appointmentMasterName: appointmentEvent ? "Иван" : null,
    businessTimeZone: appointmentEvent ? "Europe/Moscow" : null,
  };
}

const classify = (value: TelegramDeliveryPreflightSnapshot, token = ids.lease) =>
  classifyTelegramDeliveryPreflight(value, token);

describe("Telegram delivery preflight classification", () => {
  it.each([
    ["ADMIN_APPOINTMENT_CREATED", 102n],
    ["ADMIN_APPOINTMENT_CANCELLED", 102n],
    ["CLIENT_APPOINTMENT_CANCELLED", 101n],
    ["CLIENT_APPOINTMENT_CHANGED", 101n],
    ["CLIENT_APPOINTMENT_REMINDER", 101n],
    ["CLIENT_CONNECTION_CONFIRMED", 101n],
    ["ADMIN_CONNECTION_CONFIRMED", 102n],
    ["TELEGRAM_CONNECTION_REJECTED", 103n],
  ] as const)("%s becomes READY with its immutable recipient", (type, chatId) => {
    expect(classify(snapshot(type))).toMatchObject({ kind: "READY", chatId });
  });

  it("maps inactive appointment and admin recipients to CONNECTION_INACTIVE", () => {
    expect(
      classify({
        ...snapshot("CLIENT_APPOINTMENT_CHANGED"),
        appointmentConnectionDisabledAt: now,
      }),
    ).toEqual({ kind: "SKIP", code: "CONNECTION_INACTIVE" });
    expect(
      classify({
        ...snapshot("ADMIN_APPOINTMENT_CREATED"),
        adminConnectionDisabledAt: now,
      }),
    ).toEqual({ kind: "SKIP", code: "CONNECTION_INACTIVE" });
    expect(classify({ ...snapshot("ADMIN_CONNECTION_CONFIRMED"), adminUserActive: false })).toEqual(
      { kind: "SKIP", code: "CONNECTION_INACTIVE" },
    );
  });

  it("rejects a corrupt recipient matrix and payload without exposing details", () => {
    expect(
      classify({
        ...snapshot("CLIENT_APPOINTMENT_CHANGED"),
        recipientKind: "ADMIN_CONNECTION",
      }),
    ).toEqual({ kind: "DEAD", code: "RESPONSE_INVALID" });
    expect(classify({ ...snapshot("ADMIN_CONNECTION_CONFIRMED"), payloadVersion: 2 })).toEqual({
      kind: "DEAD",
      code: "PAYLOAD_VERSION_UNSUPPORTED",
    });
    expect(
      classify({ ...snapshot("ADMIN_CONNECTION_CONFIRMED"), payload: { extra: "canary" } }),
    ).toEqual({ kind: "DEAD", code: "RESPONSE_INVALID" });
  });

  it("loses an expired, foreign, absent or malformed lease before building", () => {
    expect(classify(snapshot("ADMIN_CONNECTION_CONFIRMED"), ids.job)).toEqual({
      kind: "LEASE_LOST",
    });
    expect(
      classify({
        ...snapshot("ADMIN_CONNECTION_CONFIRMED"),
        leaseExpiresAt: now,
      }),
    ).toEqual({ kind: "LEASE_LOST" });
    expect(classify({ ...snapshot("ADMIN_CONNECTION_CONFIRMED"), status: "SENT" })).toEqual({
      kind: "LEASE_LOST",
    });
  });

  it.each([
    ["APPOINTMENT_CANCELLED", "APPOINTMENT_NOT_SCHEDULED"],
    ["APPOINTMENT_COMPLETED", "APPOINTMENT_NOT_SCHEDULED"],
    ["APPOINTMENT_NO_SHOW", "APPOINTMENT_NOT_SCHEDULED"],
    ["VISIT_CHANGED", "VISIT_MISMATCH"],
    ["CONNECTION_DISABLED", "CONNECTION_INACTIVE"],
    ["ADMIN_USER_DEACTIVATED", "CONNECTION_INACTIVE"],
    ["BOT_REPLACED", "CONNECTION_INACTIVE"],
  ] as const)("maps invalidation %s to %s", (invalidationCode, code) => {
    expect(
      classify({
        ...snapshot("CLIENT_APPOINTMENT_REMINDER"),
        invalidatedAt: now,
        invalidationCode,
      }),
    ).toEqual({ kind: "SKIP", code });
  });

  it("does not require appointment version equality for a current reminder", () => {
    const value = snapshot("CLIENT_APPOINTMENT_REMINDER");
    expect(
      classify({
        ...value,
        payload: { visitVersion: 999, expectedVisit: visit },
      }),
    ).toMatchObject({ kind: "READY" });
  });

  it("classifies reminder cancellation, identity drift and old invalidation", () => {
    expect(
      classify({ ...snapshot("CLIENT_APPOINTMENT_REMINDER"), appointmentStatus: "CANCELLED" }),
    ).toEqual({ kind: "SKIP", code: "APPOINTMENT_NOT_SCHEDULED" });
    expect(
      classify({
        ...snapshot("CLIENT_APPOINTMENT_REMINDER"),
        appointmentStartsAt: new Date(startsAt.getTime() + 60_000),
      }),
    ).toEqual({ kind: "SKIP", code: "VISIT_MISMATCH" });
    expect(
      classify({
        ...snapshot("CLIENT_APPOINTMENT_REMINDER"),
        invalidatedAt: now,
        invalidationCode: "VISIT_CHANGED",
      }),
    ).toEqual({ kind: "SKIP", code: "VISIT_MISMATCH" });
  });

  it("requires exact two-hour reminder schedule and enforces both deadlines", () => {
    expect(classify(snapshot("CLIENT_APPOINTMENT_REMINDER"))).toMatchObject({ kind: "READY" });
    expect(
      classify({
        ...snapshot("CLIENT_APPOINTMENT_REMINDER"),
        scheduledAt: new Date(scheduledAt.getTime() + 1),
      }),
    ).toEqual({ kind: "SKIP", code: "VISIT_MISMATCH" });
    expect(
      classify({
        ...snapshot("CLIENT_APPOINTMENT_REMINDER"),
        databaseNow: new Date(expiresAt.getTime() + 1),
        leaseExpiresAt: new Date(expiresAt.getTime() + 60_000),
      }),
    ).toEqual({ kind: "SKIP", code: "REMINDER_EXPIRED" });
    expect(
      classify({
        ...snapshot("CLIENT_APPOINTMENT_REMINDER"),
        databaseNow: startsAt,
        expiresAt: new Date(startsAt.getTime() + 1),
        leaseExpiresAt: new Date(startsAt.getTime() + 60_000),
      }),
    ).toEqual({ kind: "SKIP", code: "REMINDER_EXPIRED" });
  });

  it("passes live timezone and public snapshot names to the builder", () => {
    const result = classify(snapshot("CLIENT_CONNECTION_CONFIRMED"));
    expect(result).toMatchObject({ kind: "READY" });
    if (result.kind === "READY") {
      expect(result.text).toContain("Стрижка");
      expect(result.text).toContain("Иван");
      expect(result.text).toContain("14:00");
    }
  });

  it("sanitizes driver failures and performs no fetch", async () => {
    const canary = "postgresql://unsafe-canary";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const preflight = new TelegramDeliveryPreflight({
      $queryRaw: vi.fn().mockRejectedValue(new Error(canary)),
    } as unknown as PrismaClient);
    const error = await preflight
      .check({ jobId: ids.job, leaseToken: ids.lease })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "TelegramDeliveryPreflightError",
      code: "PREFLIGHT_STORAGE_FAILURE",
    });
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).toBe(
      '{"name":"TelegramDeliveryPreflightError","code":"PREFLIGHT_STORAGE_FAILURE"}',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
