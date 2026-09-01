import { z } from "zod";

import { adminCreateAppointmentSchema } from "../../appointments/domain/admin-create-input";
import { bookingTokenSchema } from "../domain/booking-input";

export const ADMIN_ATTEMPT_STORAGE_KEY = "zaprosto.admin-booking.v1";
export const ADMIN_CONTACT_TTL_MS = 30 * 60 * 1000;
export type AdminBookingPayload = z.input<typeof adminCreateAppointmentSchema>;
export type SavedAdminAttempt =
  | { state: "pending"; savedAt: number; input: AdminBookingPayload }
  | { state: "receipt" | "expired"; token: string }
  | { state: "damaged" };

const marker = z.strictObject({
  state: z.enum(["receipt", "expired"]),
  token: bookingTokenSchema,
});

export function writeAdminAttempt(storage: Storage, attempt: SavedAdminAttempt) {
  const raw = JSON.stringify(attempt);
  storage.setItem(ADMIN_ATTEMPT_STORAGE_KEY, raw);
  if (storage.getItem(ADMIN_ATTEMPT_STORAGE_KEY) !== raw) throw new Error("Storage unavailable");
}

export function readAdminAttempt(storage: Storage, now = Date.now()): SavedAdminAttempt | null {
  const raw = storage.getItem(ADMIN_ATTEMPT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const compact = marker.safeParse(value);
    if (compact.success) return compact.data;
    if (
      value.state !== "pending" ||
      !Number.isFinite(value.savedAt) ||
      !adminCreateAppointmentSchema.safeParse(value.input).success
    )
      throw new Error("Invalid attempt");
    if (now - value.savedAt >= ADMIN_CONTACT_TTL_MS || value.savedAt > now) {
      const expired = { state: "expired" as const, token: value.input.cancellationToken };
      writeAdminAttempt(storage, expired);
      return expired;
    }
    return value as SavedAdminAttempt;
  } catch {
    const damaged = { state: "damaged" as const };
    writeAdminAttempt(storage, damaged);
    return damaged;
  }
}
