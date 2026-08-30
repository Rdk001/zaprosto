import "server-only";

import { prisma } from "../../../server/db/prisma";
import { createBookingService } from "./booking-service";

export const booking = createBookingService(prisma);
export { prepareBookingAttempt } from "./booking-security";
export type { BookingAvailability, CreateBookingResult } from "./types";
