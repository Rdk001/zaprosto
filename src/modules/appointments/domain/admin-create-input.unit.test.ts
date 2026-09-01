import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prepareBookingAttempt } from "../../booking/server/booking-security";
import {
  adminAvailabilitySchema,
  adminCreateAppointmentSchema,
  hashAdminAppointmentRequest,
} from "./admin-create-input";

function validInput() {
  return {
    ...prepareBookingAttempt(),
    serviceId: randomUUID(),
    expectedServiceTerms: "a".repeat(64),
    expectedBusinessContext: "b".repeat(64),
    master: { type: "SPECIFIC" as const, masterId: randomUUID() },
    localDate: "2026-10-05",
    startsAt: "2026-10-05T10:00:00+03:00",
    clientName: "  Вымышленный Клиент  ",
    clientPhone: "8 (999) 000-00-00",
    confirmed: true as const,
  };
}

describe("admin appointment creation input", () => {
  it("normalizes the existing +7/8 phone formats and canonical fields", () => {
    const raw = validInput();
    const fromEight = adminCreateAppointmentSchema.parse(raw);
    const fromSeven = adminCreateAppointmentSchema.parse({
      ...raw,
      clientPhone: "+7 999 000 00 00",
      serviceId: raw.serviceId.toUpperCase(),
      startsAt: new Date("2026-10-05T07:00:00Z"),
    });
    expect(fromEight.clientPhone).toBe("+79990000000");
    expect(fromEight.clientName).toBe("Вымышленный Клиент");
    expect(fromSeven.clientPhone).toBe("+79990000000");
    expect(hashAdminAppointmentRequest(fromEight)).toBe(hashAdminAppointmentRequest(fromSeven));
  });

  it.each([
    { confirmed: false },
    { confirmed: undefined },
    { clientPhone: "79990000000" },
    { master: { type: "SPECIFIC" } },
    { master: { type: "ANY", masterId: randomUUID() } },
    { source: "ADMIN" },
    { status: "SCHEDULED" },
    { changedByAdminId: randomUUID() },
    { cancellationTokenHash: "secret" },
  ])("rejects malformed and server-owned fields %#", (override) => {
    expect(adminCreateAppointmentSchema.safeParse({ ...validInput(), ...override }).success).toBe(
      false,
    );
  });

  it("accepts only the valid SPECIFIC and ANY discriminated variants", () => {
    expect(adminCreateAppointmentSchema.safeParse(validInput()).success).toBe(true);
    expect(
      adminCreateAppointmentSchema.safeParse({
        ...validInput(),
        master: { type: "ANY" },
      }).success,
    ).toBe(true);
  });

  it("binds every business field into a stable idempotency fingerprint", () => {
    const original = adminCreateAppointmentSchema.parse(validInput());
    expect(hashAdminAppointmentRequest(original)).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { serviceId: randomUUID() },
      { expectedServiceTerms: "c".repeat(64) },
      { expectedBusinessContext: "d".repeat(64) },
      { master: { type: "ANY" as const } },
      { master: { type: "SPECIFIC" as const, masterId: randomUUID() } },
      { localDate: "2026-10-06" },
      { startsAt: new Date("2026-10-05T08:00:00Z") },
      { clientName: "Другой клиент" },
      { clientPhone: "+79990000001" },
    ])
      expect(hashAdminAppointmentRequest({ ...original, ...change })).not.toBe(
        hashAdminAppointmentRequest(original),
      );
  });

  it("keeps availability DTO strict and uses omitted masterId for ANY", () => {
    const input = {
      serviceId: randomUUID(),
      localDate: "2026-10-05",
      expectedBusinessContext: "a".repeat(64),
    };
    expect(adminAvailabilitySchema.safeParse(input).success).toBe(true);
    expect(adminAvailabilitySchema.safeParse({ ...input, masterId: randomUUID() }).success).toBe(
      true,
    );
    expect(adminAvailabilitySchema.safeParse({ ...input, extra: true }).success).toBe(false);
  });
});
