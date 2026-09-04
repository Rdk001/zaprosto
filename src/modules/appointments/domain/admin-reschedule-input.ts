import { z } from "zod";

import {
  bookingHashSchema,
  bookingMasterSchema,
  bookingStartsAtSchema,
  bookingUuidSchema,
} from "../../booking/domain/booking-input";
import { appointmentIdSchema } from "./admin-input";

export const appointmentServiceSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("KEEP_CURRENT") }),
  z.strictObject({
    mode: z.literal("CATALOG"),
    serviceId: bookingUuidSchema,
    expectedServiceTerms: bookingHashSchema,
  }),
]);

export const appointmentRescheduleAvailabilitySchema = z.strictObject({
  appointmentId: appointmentIdSchema,
  expectedVersion: z.number().int().min(0).max(2147483647),
  service: appointmentServiceSelectionSchema,
  master: bookingMasterSchema,
  localDate: z.iso.date(),
  expectedBusinessContext: bookingHashSchema,
});

export const rescheduleAppointmentSchema = appointmentRescheduleAvailabilitySchema.extend({
  startsAt: bookingStartsAtSchema,
  confirmed: z.literal(true),
});

export type AppointmentServiceSelection = z.infer<typeof appointmentServiceSelectionSchema>;
export type AppointmentRescheduleAvailabilityInput = z.infer<
  typeof appointmentRescheduleAvailabilitySchema
>;
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;
