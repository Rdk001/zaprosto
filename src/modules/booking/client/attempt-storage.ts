import { z } from "zod";
import { bookingTokenSchema, createBookingSchema } from "../domain/booking-input";
export const ATTEMPT_STORAGE_KEY = "zaprosto.booking.v1";
export const CONTACT_TTL_MS = 30 * 60 * 1000;
export type BookingPayload = z.input<typeof createBookingSchema>;
export type SavedAttempt =
  | { state: "pending"; savedAt: number; input: BookingPayload }
  | { state: "receipt" | "expired"; token: string }
  | { state: "damaged" };
const marker = z.strictObject({ state: z.enum(["receipt", "expired"]), token: bookingTokenSchema });
export function writeAttempt(storage: Storage, attempt: SavedAttempt) {
  const raw = JSON.stringify(attempt);
  storage.setItem(ATTEMPT_STORAGE_KEY, raw);
  if (storage.getItem(ATTEMPT_STORAGE_KEY) !== raw) throw new Error("Storage unavailable");
}
export function readAttempt(storage: Storage, now = Date.now()): SavedAttempt | null {
  const raw = storage.getItem(ATTEMPT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const compact = marker.safeParse(value);
    if (compact.success) return compact.data;
    if (
      value.state !== "pending" ||
      !Number.isFinite(value.savedAt) ||
      !createBookingSchema.safeParse(value.input).success
    )
      throw new Error("Invalid attempt");
    if (now - value.savedAt >= CONTACT_TTL_MS || value.savedAt > now) {
      const expired = { state: "expired" as const, token: value.input.cancellationToken };
      writeAttempt(storage, expired);
      return expired;
    }
    return value as SavedAttempt;
  } catch {
    // Remove malformed/expired contacts but retain a blocker; never silently create anew.
    const damaged = { state: "damaged" as const };
    writeAttempt(storage, damaged);
    return damaged;
  }
}
