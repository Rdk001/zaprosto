import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashBookingRequest,
  hashBookingToken,
  matchesBookingToken,
  prepareBookingAttempt,
} from "../server/booking-security";
import {
  bookingTokenSchema,
  cancelBookingSchema,
  createBookingSchema,
  inputIssues,
} from "./booking-input";

function validInput() {
  return {
    ...prepareBookingAttempt(),
    serviceId: randomUUID(),
    master: { type: "SPECIFIC", masterId: randomUUID() },
    localDate: "2026-10-05",
    startsAt: "2026-10-05T10:00:00+03:00",
    clientName: "  Вымышленный Клиент  ",
    clientPhone: "8 (999) 000-00-00",
  };
}

describe("booking input and attempt credentials", () => {
  it("normalizes contacts, UUIDs and equivalent instants before fingerprinting", () => {
    const raw = validInput();
    const first = createBookingSchema.parse(raw);
    const second = createBookingSchema.parse({
      ...raw,
      serviceId: raw.serviceId.toUpperCase(),
      clientName: "Вымышленный Клиент",
      clientPhone: "+7 999 000 00 00",
      startsAt: new Date("2026-10-05T07:00:00Z"),
    });
    expect(first.clientName).toBe("Вымышленный Клиент");
    expect(first.clientPhone).toBe("+79990000000");
    expect(first.startsAt).toEqual(new Date("2026-10-05T07:00:00Z"));
    expect(hashBookingRequest(first)).toBe(hashBookingRequest(second));
  });

  it.each([
    { clientName: " " },
    { clientName: 42 },
    { clientName: "я".repeat(201) },
    { clientPhone: "9990000000" },
    { clientPhone: "+19990000000" },
    { clientPhone: "79990000000" },
    { clientPhone: "8bad9990000000" },
    { serviceId: "invalid" },
    { localDate: "2026-02-30" },
    { startsAt: "2026-10-05T10:00:00" },
    { startsAt: new Date(NaN) },
    { master: { type: "ANY", masterId: randomUUID() } },
    { master: { type: "SPECIFIC" } },
    { cancellationToken: "weak" },
    { idempotencyKey: "weak" },
    { priceKopecks: 1 },
    { endsAt: "2026-10-05T07:01:00Z" },
    { status: "CANCELLED" },
    { source: "ADMIN" },
    { excludeAppointmentId: randomUUID() },
  ])("rejects malformed or server-owned input %#", (overrides) => {
    expect(createBookingSchema.safeParse({ ...validInput(), ...overrides }).success).toBe(false);
  });

  it("binds every original booking field, including ANY versus SPECIFIC", () => {
    const original = createBookingSchema.parse(validInput());
    const changes = [
      { serviceId: randomUUID() },
      { master: { type: "ANY" as const } },
      { master: { type: "SPECIFIC" as const, masterId: randomUUID() } },
      { localDate: "2026-10-06" },
      { startsAt: new Date("2026-10-05T08:00:00Z") },
      { clientName: "Другой вымышленный клиент" },
      { clientPhone: "+79990000001" },
    ];
    for (const change of changes)
      expect(hashBookingRequest({ ...original, ...change })).not.toBe(hashBookingRequest(original));
  });

  it("generates independent canonical 256-bit tokens and stores only their hashes", () => {
    const first = prepareBookingAttempt();
    const second = prepareBookingAttempt();
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(first.cancellationToken).not.toBe(second.cancellationToken);
    expect(bookingTokenSchema.safeParse(first.cancellationToken).success).toBe(true);
    expect(Buffer.from(first.cancellationToken, "base64url")).toHaveLength(32);
    expect(hashBookingToken(first.cancellationToken)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      matchesBookingToken(first.cancellationToken, hashBookingToken(first.cancellationToken)),
    ).toBe(true);
    expect(
      matchesBookingToken(second.cancellationToken, hashBookingToken(first.cancellationToken)),
    ).toBe(false);
    expect(matchesBookingToken(first.cancellationToken, "legacy-hash")).toBe(false);
    expect(bookingTokenSchema.safeParse("A".repeat(42) + "B").success).toBe(false);
  });

  it("requires explicit cancellation confirmation and limits optional reason", () => {
    const token = prepareBookingAttempt().cancellationToken;
    expect(cancelBookingSchema.safeParse({ token }).success).toBe(false);
    expect(cancelBookingSchema.safeParse({ token, confirmed: false }).success).toBe(false);
    expect(
      cancelBookingSchema.parse({ token, confirmed: true, reason: "  Изменились планы  " }).reason,
    ).toBe("Изменились планы");
    expect(
      cancelBookingSchema.safeParse({ token, confirmed: true, reason: "я".repeat(1001) }).success,
    ).toBe(false);
  });

  it("does not include submitted values in validation issues", () => {
    const parsed = createBookingSchema.safeParse({
      ...validInput(),
      clientPhone: "+19990000000",
      cancellationToken: "secret-invalid-token",
    });
    if (parsed.success) throw new Error("Expected invalid input");
    const issues = JSON.stringify(inputIssues(parsed.error));
    expect(issues).not.toContain("+19990000000");
    expect(issues).not.toContain("secret-invalid-token");
  });
});
