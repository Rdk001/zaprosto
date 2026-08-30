import "server-only";

import { prisma } from "../../../server/db/prisma";
import { createClientAppointmentService } from "./client-appointment-service";

export const clientAppointments = createClientAppointmentService(prisma);
export type { ConfirmationResult, CancelBookingResult } from "./client-appointment-service";
export type { AppointmentConfirmation } from "./confirmation";
