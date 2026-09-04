import { describe, expect, it } from "vitest";

import {
  appointmentRescheduleAvailabilitySchema,
  rescheduleAppointmentSchema,
} from "./admin-reschedule-input";

const appointmentId = "10000000-0000-4000-8000-0000000000AA";
const masterId = "20000000-0000-4000-8000-0000000000BB";
const serviceId = "30000000-0000-4000-8000-0000000000CC";
const expectedBusinessContext = "a".repeat(64);
const expectedServiceTerms = "b".repeat(64);

const availability = {
  appointmentId,
  expectedVersion: 7,
  service: { mode: "KEEP_CURRENT" as const },
  master: { type: "SPECIFIC" as const, masterId },
  localDate: "2026-09-03",
  expectedBusinessContext,
};

describe("administrative appointment reschedule DTO", () => {
  it("normalizes identifiers and accepts only the KEEP_CURRENT availability fields", () => {
    expect(appointmentRescheduleAvailabilitySchema.parse(availability)).toEqual({
      ...availability,
      appointmentId: appointmentId.toLowerCase(),
      master: { type: "SPECIFIC", masterId: masterId.toLowerCase() },
    });
  });

  it("accepts current catalog terms and converts an offset instant for confirmed save", () => {
    const parsed = rescheduleAppointmentSchema.parse({
      ...availability,
      service: { mode: "CATALOG", serviceId, expectedServiceTerms },
      master: { type: "ANY" },
      startsAt: "2026-09-03T10:15:00+03:00",
      confirmed: true,
    });
    expect(parsed).toEqual({
      ...availability,
      appointmentId: appointmentId.toLowerCase(),
      service: {
        mode: "CATALOG",
        serviceId: serviceId.toLowerCase(),
        expectedServiceTerms,
      },
      master: { type: "ANY" },
      startsAt: new Date("2026-09-03T07:15:00.000Z"),
      confirmed: true,
    });
  });

  it.each([
    { expectedVersion: "7" },
    { expectedVersion: -1 },
    { expectedVersion: 2_147_483_648 },
    { expectedBusinessContext: "not-a-hash" },
    { appointmentId: "not-a-uuid" },
    { localDate: "2026-02-29" },
    { master: { type: "SPECIFIC" } },
    { master: { type: "ANY", masterId } },
    { service: { mode: "CATALOG", serviceId } },
    { service: { mode: "CATALOG", serviceId, expectedServiceTerms: "bad" } },
    { service: { mode: "KEEP_CURRENT", serviceId, expectedServiceTerms } },
  ])("rejects an invalid availability field %#", (replacement) => {
    expect(
      appointmentRescheduleAvailabilitySchema.safeParse({
        ...availability,
        ...replacement,
      }).success,
    ).toBe(false);
  });

  it.each([
    { excludeAppointmentId: appointmentId },
    { status: "SCHEDULED" },
    { source: "ADMIN" },
    { serviceId },
    { masterId },
    { startsAt: new Date() },
    { endsAt: new Date() },
    { serviceNameSnapshot: "secret" },
    { servicePriceSnapshot: 1 },
    { serviceDurationSnapshot: 1 },
    { cancellationToken: "secret" },
    { cancellationTokenHash: "c".repeat(64) },
    { bookingRequestId: appointmentId },
    { cancelledAt: new Date() },
    { cancelledBy: "ADMIN" },
    { cancellationReason: "secret" },
    { history: [] },
    { adminId: appointmentId },
  ])("rejects a browser-supplied server field %#", (extra) => {
    expect(
      appointmentRescheduleAvailabilitySchema.safeParse({
        ...availability,
        ...extra,
      }).success,
    ).toBe(false);
  });

  it.each([
    {},
    { startsAt: "not-an-instant", confirmed: true },
    { startsAt: "2026-09-03T10:00:00", confirmed: true },
    { startsAt: "2026-09-03T10:00:00Z", confirmed: false },
    { startsAt: "2026-09-03T10:00:00Z", confirmed: "true" },
  ])("requires an explicit valid instant and confirmation for mutation %#", (saveFields) => {
    expect(
      rescheduleAppointmentSchema.safeParse({
        ...availability,
        ...saveFields,
      }).success,
    ).toBe(false);
  });
});
