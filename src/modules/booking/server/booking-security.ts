import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { CreateBookingInput } from "../domain/booking-input";

/** Retain both values before submitting; retries must reuse the same pair. */
export function prepareBookingAttempt() {
  return { idempotencyKey: randomUUID(), cancellationToken: randomBytes(32).toString("base64url") };
}

export function hashBookingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function matchesBookingToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashBookingToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashBookingRequest(input: CreateBookingInput): string {
  // Fixed field order and normalized values; independent of mutable appointment/catalog data.
  return createHash("sha256")
    .update(
      JSON.stringify([
        "booking-v1",
        input.serviceId,
        input.master.type,
        input.master.type === "SPECIFIC" ? input.master.masterId : null,
        input.localDate,
        input.startsAt.toISOString(),
        input.clientName,
        input.clientPhone,
      ]),
    )
    .digest("hex");
}
