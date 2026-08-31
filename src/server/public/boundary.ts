import { z } from "zod";
import type { BookingService } from "../../modules/booking/server/booking-service";
import type { ClientAppointmentService } from "../../modules/appointments/server/client-appointment-service";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  createSchedulingAvailabilityService,
  systemClock,
  type Clock,
} from "../../modules/scheduling/server/availability-service";
import { readTimeContext } from "../../modules/settings/server/context";
import { prepareBookingAttempt } from "../../modules/booking/server/booking-security";
import { SchedulingError } from "../../modules/scheduling/domain/errors";
import { clientIdentity, validOrigin, type PublicOperation } from "./security";

export type PublicFailure = { ok: false; code: "FORBIDDEN" | "RATE_LIMITED" | "UNAVAILABLE" };
const availabilitySchema = z.strictObject({
  serviceId: z.uuid(),
  localDate: z.iso.date(),
  masterId: z.uuid().optional(),
  expectedBusinessContext: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export function createPublicBoundary(deps: {
  booking: BookingService;
  appointments: ClientAppointmentService;
  database: PrismaClient;
  clock?: Clock;
  limit: (operation: PublicOperation, identity: string) => Promise<boolean>;
}) {
  async function guard<T>(
    headers: Headers,
    operation: PublicOperation,
    mutation: boolean,
    work: () => Promise<T>,
  ): Promise<T | PublicFailure> {
    if (mutation && !validOrigin(headers)) return { ok: false, code: "FORBIDDEN" };
    try {
      if (!(await deps.limit(operation, clientIdentity(headers))))
        return { ok: false, code: "RATE_LIMITED" };
      return await work();
    } catch {
      // Never log the exception: Prisma messages may contain PII and inputs.
      // A create may already have committed: this is NOT a confirmed rejection.
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
  return {
    prepare: (h: Headers) =>
      guard(h, "prepare", true, async () => ({
        ok: true as const,
        attempt: prepareBookingAttempt(),
      })),
    create: (h: Headers, input: unknown) =>
      guard(h, "create", true, () => deps.booking.createBooking(input)),
    lookup: (h: Headers, token: unknown) =>
      guard(h, "lookup", true, () => deps.appointments.getConfirmation(token)),
    cancel: (h: Headers, input: unknown) =>
      guard(h, "cancel", true, () => deps.appointments.cancelBooking(input)),
    availability: (h: Headers, input: unknown) =>
      guard(h, "availability", false, async () => {
        const parsed = availabilitySchema.safeParse(input);
        if (!parsed.success) return { ok: false as const, code: "INVALID_INPUT" as const };
        return deps.database.$transaction(
          async (tx) => {
            const clock = deps.clock ?? systemClock;
            const context = await readTimeContext(tx, clock.now());
            if (
              parsed.data.expectedBusinessContext &&
              parsed.data.expectedBusinessContext !== context.contextHash
            )
              return { ok: false as const, code: "BUSINESS_CONTEXT_CHANGED" as const, context };
            const scheduling = createSchedulingAvailabilityService(tx, clock);
            try {
              const result = parsed.data.masterId
                ? await scheduling.getMasterAvailability({
                    ...parsed.data,
                    masterId: parsed.data.masterId,
                  })
                : await scheduling.getAnyMasterAvailability(parsed.data);
              return {
                ok: true as const,
                timeZone: result.timeZone,
                context,
                slots: result.slots.map((slot) => ({ startsAt: slot.startsAt.toISOString() })),
              };
            } catch (error) {
              if (
                error instanceof SchedulingError &&
                [
                  "BOOKING_DATE_OUT_OF_RANGE",
                  "MASTER_NOT_ELIGIBLE",
                  "SERVICE_NOT_FOUND",
                  "INACTIVE_SERVICE",
                ].includes(error.code)
              )
                return { ok: false as const, code: "SELECTION_UNAVAILABLE" as const, context };
              throw error;
            }
          },
          { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 10000 },
        );
      }),
  };
}
