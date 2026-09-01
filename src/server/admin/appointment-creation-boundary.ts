import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { getActiveAdmin } from "../../modules/auth/server/auth-service";
import { adminAvailabilitySchema } from "../../modules/appointments/domain/admin-create-input";
import type {
  AdminBookingService,
  AdminBookingResult,
} from "../../modules/booking/server/admin-booking-service";
import { readBookingCatalog } from "../../modules/booking/server/booking-catalog";
import { prepareBookingAttempt } from "../../modules/booking/server/booking-security";
import { SchedulingError } from "../../modules/scheduling/domain/errors";
import {
  createSchedulingAvailabilityService,
  systemClock,
  type Clock,
} from "../../modules/scheduling/server/availability-service";
import { readTimeContext } from "../../modules/settings/server/context";
import { validOrigin } from "../public/security";

export type AdminCreationFailure = {
  ok: false;
  code: "UNAUTHORIZED" | "FORBIDDEN" | "UNAVAILABLE";
};

export function createAppointmentCreationBoundary(deps: {
  database: PrismaClient;
  booking: AdminBookingService;
  clock?: Clock;
}) {
  const clock = deps.clock ?? systemClock;
  async function read<T>(
    token: unknown,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | AdminCreationFailure> {
    try {
      const result = await deps.database.$transaction(
        async (tx) => {
          if (!(await getActiveAdmin(tx, token)))
            return { ok: false as const, code: "UNAUTHORIZED" as const };
          return operation(tx);
        },
        { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
      );
      if (!(await getActiveAdmin(deps.database, token))) return { ok: false, code: "UNAUTHORIZED" };
      return result;
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
  }

  return {
    form: (token: unknown) =>
      read(token, async (tx) => {
        const catalog = await readBookingCatalog(tx, clock.now());
        return catalog
          ? { ok: true as const, catalog }
          : { ok: false as const, code: "UNAVAILABLE" as const };
      }),
    availability: (token: unknown, raw: unknown) =>
      read(token, async (tx) => {
        const parsed = adminAvailabilitySchema.safeParse(raw);
        if (!parsed.success) return { ok: false as const, code: "INVALID_INPUT" as const };
        const context = await readTimeContext(tx, clock.now());
        if (parsed.data.expectedBusinessContext !== context.contextHash)
          return { ok: false as const, code: "BUSINESS_CONTEXT_CHANGED" as const, context };
        const scheduling = createSchedulingAvailabilityService(tx, clock);
        try {
          const result = parsed.data.masterId
            ? await scheduling.getMasterAvailability({
                serviceId: parsed.data.serviceId,
                localDate: parsed.data.localDate,
                masterId: parsed.data.masterId,
              })
            : await scheduling.getAnyMasterAvailability({
                serviceId: parsed.data.serviceId,
                localDate: parsed.data.localDate,
              });
          return {
            ok: true as const,
            context,
            timeZone: result.timeZone,
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
      }),
    async prepare(headers: Headers, token: unknown) {
      if (!validOrigin(headers)) return { ok: false as const, code: "FORBIDDEN" as const };
      try {
        if (!(await getActiveAdmin(deps.database, token)))
          return { ok: false as const, code: "UNAUTHORIZED" as const };
        const attempt = prepareBookingAttempt();
        if (!(await getActiveAdmin(deps.database, token)))
          return { ok: false as const, code: "UNAUTHORIZED" as const };
        return { ok: true as const, attempt };
      } catch {
        return { ok: false as const, code: "UNAVAILABLE" as const };
      }
    },
    async create(
      headers: Headers,
      token: unknown,
      raw: unknown,
    ): Promise<AdminBookingResult | AdminCreationFailure> {
      if (!validOrigin(headers)) return { ok: false, code: "FORBIDDEN" };
      try {
        if (!(await getActiveAdmin(deps.database, token)))
          return { ok: false, code: "UNAUTHORIZED" };
        const result = await deps.booking.createBooking(token, raw);
        if (!(await getActiveAdmin(deps.database, token)))
          return { ok: false, code: "UNAUTHORIZED" };
        return result;
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
  };
}
