import "server-only";
import { booking } from "../../modules/booking/server";
import { clientAppointments } from "../../modules/appointments/server";
import { prisma } from "../db/prisma";
import { createPublicBoundary } from "./boundary";
import { createRateLimiter } from "./security";
export const publicBooking = createPublicBoundary({
  booking,
  appointments: clientAppointments,
  database: prisma,
  limit: createRateLimiter(prisma),
});
