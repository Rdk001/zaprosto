import { z } from "zod";

import { bookingClientNameSchema, russianPhoneSchema } from "../../booking/domain/booking-input";
import { appointmentIdSchema } from "./admin-input";

export const updateAppointmentContactsSchema = z.strictObject({
  id: appointmentIdSchema,
  version: z.number().int().min(0).max(2147483647),
  clientName: bookingClientNameSchema,
  clientPhone: russianPhoneSchema,
});

export type UpdateAppointmentContactsInput = z.infer<typeof updateAppointmentContactsSchema>;
