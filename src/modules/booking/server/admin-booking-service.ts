import type { PrismaClient } from "../../../generated/prisma/client";
import { isAppointmentOverlap, retryTransaction } from "../../../server/db/transaction-errors";
import { getActiveAdmin, getActiveAdminForShare } from "../../auth/server/auth-service";
import {
  adminCreateAppointmentSchema,
  adminCreateInputIssues,
  hashAdminAppointmentRequest,
} from "../../appointments/domain/admin-create-input";
import { publicServiceTerms } from "../../catalog/server/service-terms";
import { systemClock, type Clock } from "../../scheduling/server/availability-service";
import { readTimeContext } from "../../settings/server/context";
import {
  activeBookingService,
  bookingAvailabilityInTransaction,
  bookingRejectionReason,
  BookingAuthorizationLost,
  BusinessContextChanged,
  createBookingInTransaction,
  ServiceTermsChanged,
  SlotUnavailable,
} from "./booking-engine";
import type { BookingAvailability, CreateBookingResult } from "./types";

export type AdminBookingResult = CreateBookingResult | { ok: false; code: "UNAUTHORIZED" };

export class AdminBookingService {
  constructor(
    private readonly database: PrismaClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async createBooking(token: unknown, rawInput: unknown): Promise<AdminBookingResult> {
    const parsed = adminCreateAppointmentSchema.safeParse(rawInput);
    if (!parsed.success)
      return { ok: false, code: "INVALID_INPUT", issues: adminCreateInputIssues(parsed.error) };
    const input = parsed.data;
    try {
      return await retryTransaction(() =>
        this.database.$transaction(
          async (tx) => {
            if (!(await getActiveAdmin(tx, token))) throw new BookingAuthorizationLost();
            return createBookingInTransaction({
              tx,
              booking: input,
              requestHash: hashAdminAppointmentRequest(input),
              source: "ADMIN",
              changedBy: "ADMIN",
              clock: this.clock,
              verifyAdminAfterWait: () => getActiveAdminForShare(tx, token),
            });
          },
          { isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
        ),
      );
    } catch (error) {
      if (error instanceof BookingAuthorizationLost) return { ok: false, code: "UNAUTHORIZED" };
      if (error instanceof BusinessContextChanged)
        return this.database.$transaction(
          async (tx) => ({
            ok: false as const,
            code: "BUSINESS_CONTEXT_CHANGED" as const,
            context: await readTimeContext(tx, this.clock.now()),
          }),
          { isolationLevel: "RepeatableRead" },
        );
      if (error instanceof ServiceTermsChanged) return this.freshTerms(input);
      if (error instanceof SlotUnavailable || isAppointmentOverlap(error))
        return {
          ok: false,
          code: "SLOT_UNAVAILABLE",
          availability: await this.freshAvailability(input),
        };
      const reason = bookingRejectionReason(error);
      if (reason) return { ok: false, code: "REQUEST_REJECTED", reason };
      throw error;
    }
  }

  private async freshTerms(input: ReturnType<typeof adminCreateAppointmentSchema.parse>) {
    try {
      return await this.database.$transaction(
        async (tx) => ({
          ok: false as const,
          code: "SERVICE_TERMS_CHANGED" as const,
          service: publicServiceTerms(await activeBookingService(tx, input.serviceId)),
          availability: await bookingAvailabilityInTransaction(tx, input, this.clock),
        }),
        { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      const reason = bookingRejectionReason(error);
      if (reason) return { ok: false as const, code: "REQUEST_REJECTED" as const, reason };
      throw error;
    }
  }

  private async freshAvailability(
    input: ReturnType<typeof adminCreateAppointmentSchema.parse>,
  ): Promise<BookingAvailability> {
    return this.database.$transaction(
      (tx) => bookingAvailabilityInTransaction(tx, input, this.clock),
      { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
    );
  }
}

export function createAdminBookingService(database: PrismaClient, clock: Clock = systemClock) {
  return new AdminBookingService(database, clock);
}
