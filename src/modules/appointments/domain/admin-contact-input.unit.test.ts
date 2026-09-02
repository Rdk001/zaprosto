import { describe, expect, it } from "vitest";

import { updateAppointmentContactsSchema } from "./admin-contact-input";

const base = {
  id: "10000000-0000-4000-8000-0000000000AA",
  version: 7,
  clientName: "  Вымышленный Клиент  ",
  clientPhone: "8 (999) 000-00-00",
};

describe("administrative contact correction DTO", () => {
  it("is strict and normalizes only the approved fields", () => {
    expect(updateAppointmentContactsSchema.parse(base)).toEqual({
      id: "10000000-0000-4000-8000-0000000000aa",
      version: 7,
      clientName: "Вымышленный Клиент",
      clientPhone: "+79990000000",
    });
  });

  it.each([
    ["+7 999 000 00 00", "+79990000000"],
    ["8-999-000-00-00", "+79990000000"],
    ["+7 (999) 000-00-00", "+79990000000"],
  ])("accepts and normalizes Russian phone %s", (clientPhone, expected) => {
    expect(updateAppointmentContactsSchema.parse({ ...base, clientPhone }).clientPhone).toBe(
      expected,
    );
  });

  it.each([
    "9990000000",
    "+19990000000",
    "79990000000",
    "+7999000000",
    "+799900000000",
    "8bad9990000000",
  ])("rejects invalid phone %s", (clientPhone) => {
    expect(updateAppointmentContactsSchema.safeParse({ ...base, clientPhone }).success).toBe(false);
  });

  it("trims the name and enforces its minimum and maximum", () => {
    expect(
      updateAppointmentContactsSchema.parse({ ...base, clientName: ` ${"я".repeat(200)} ` })
        .clientName,
    ).toHaveLength(200);
    for (const clientName of ["", "   ", "я".repeat(201)]) {
      expect(updateAppointmentContactsSchema.safeParse({ ...base, clientName }).success).toBe(
        false,
      );
    }
  });

  it.each([{ id: "not-a-uuid" }, { version: "7" }, { version: -1 }, { version: 2147483648 }])(
    "rejects invalid identity/version %#",
    (replacement) => {
      expect(updateAppointmentContactsSchema.safeParse({ ...base, ...replacement }).success).toBe(
        false,
      );
    },
  );

  it.each([
    { status: "SCHEDULED" },
    { source: "ADMIN" },
    { serviceId: base.id },
    { masterId: base.id },
    { startsAt: new Date() },
    { endsAt: new Date() },
    { serviceNameSnapshot: "Private" },
    { cancellationToken: "secret" },
    { cancellationTokenHash: "a".repeat(64) },
    { bookingRequestId: base.id },
    { cancelledAt: new Date() },
    { cancellationReason: "Private" },
    { history: [] },
    { adminId: base.id },
    { expectedBusinessContext: "a".repeat(64) },
  ])("rejects browser-supplied server field %#", (extra) => {
    expect(updateAppointmentContactsSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});
