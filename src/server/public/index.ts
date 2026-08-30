import "server-only";
import { booking } from "../../modules/booking/server";
import { clientAppointments } from "../../modules/appointments/server";
import { schedulingAvailability } from "../../modules/scheduling/server";
import { prisma } from "../db/prisma";
import { createPublicBoundary } from "./boundary";
import { createRateLimiter } from "./security";
export const publicBooking = createPublicBoundary({
  booking,
  appointments: clientAppointments,
  scheduling: schedulingAvailability,
  limit: createRateLimiter(prisma),
});
