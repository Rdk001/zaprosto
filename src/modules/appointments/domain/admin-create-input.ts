import { createHash } from "node:crypto";
import { z } from "zod";

import {
  bookingClientNameSchema,
  bookingHashSchema,
  bookingMasterSchema,
  bookingStartsAtSchema,
  bookingTokenSchema,
  bookingUuidSchema,
  inputIssues,
  russianPhoneSchema,
  type InputIssue,
} from "../../booking/domain/booking-input";

export const adminCreateAppointmentSchema = z.strictObject({
  idempotencyKey: bookingUuidSchema,
  cancellationToken: bookingTokenSchema,
  serviceId: bookingUuidSchema,
  expectedServiceTerms: bookingHashSchema,
  expectedBusinessContext: bookingHashSchema,
  master: bookingMasterSchema,
  localDate: z.iso.date(),
  startsAt: bookingStartsAtSchema,
  clientName: bookingClientNameSchema,
  clientPhone: russianPhoneSchema,
  confirmed: z.literal(true),
});

export const adminAvailabilitySchema = z.strictObject({
  serviceId: bookingUuidSchema,
  localDate: z.iso.date(),
  masterId: bookingUuidSchema.optional(),
  expectedBusinessContext: bookingHashSchema,
});

export type AdminCreateAppointmentInput = z.infer<typeof adminCreateAppointmentSchema>;
export type AdminCreateInputIssue = InputIssue;

export function adminCreateInputIssues(error: z.ZodError): AdminCreateInputIssue[] {
  return inputIssues(error);
}

export function hashAdminAppointmentRequest(input: AdminCreateAppointmentInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "admin-booking-v1",
        input.serviceId,
        input.master.type,
        input.master.type === "SPECIFIC" ? input.master.masterId : null,
        input.localDate,
        input.startsAt.toISOString(),
        input.clientName,
        input.clientPhone,
        input.expectedServiceTerms,
        input.expectedBusinessContext,
      ]),
    )
    .digest("hex");
}
