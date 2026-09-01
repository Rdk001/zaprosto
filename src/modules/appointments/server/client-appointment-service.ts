import type { PrismaClient } from "../../../generated/prisma/client";
import { retryTransaction } from "../../../server/db/transaction-errors";
import {
  bookingTokenSchema,
  cancelBookingSchema,
  inputIssues,
  type InputIssue,
} from "../../booking/domain/booking-input";
import { hashBookingToken } from "../../booking/server/booking-security";
import { systemClock, type Clock } from "../../scheduling/server/availability-service";
import { confirmationSelect, toConfirmation, type AppointmentConfirmation } from "./confirmation";

export type ConfirmationResult =
  { ok: true; confirmation: AppointmentConfirmation } | { ok: false; code: "NOT_FOUND" };
export type CancelBookingResult =
  | { ok: true; alreadyCancelled: boolean; confirmation: AppointmentConfirmation }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "INVALID_INPUT"; issues: InputIssue[] }
  | { ok: false; code: "STATUS_NOT_CANCELLABLE"; status: "COMPLETED" | "NO_SHOW" };

export class ClientAppointmentService {
  constructor(
    private readonly database: PrismaClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async getConfirmation(rawToken: unknown): Promise<ConfirmationResult> {
    const parsed = bookingTokenSchema.safeParse(rawToken);
    if (!parsed.success) return { ok: false, code: "NOT_FOUND" };
    const appointment = await this.database.appointment.findUnique({
      where: { cancellationTokenHash: hashBookingToken(parsed.data) },
      select: confirmationSelect,
    });
    return appointment
      ? { ok: true, confirmation: toConfirmation(appointment) }
      : { ok: false, code: "NOT_FOUND" };
  }

  async cancelBooking(rawInput: unknown): Promise<CancelBookingResult> {
    const parsed = cancelBookingSchema.safeParse(rawInput);
    if (!parsed.success)
      return { ok: false, code: "INVALID_INPUT", issues: inputIssues(parsed.error) };
    const { token, reason } = parsed.data;
    const cancellationTokenHash = hashBookingToken(token);
    return retryTransaction(() =>
      this.database.$transaction(
        async (tx): Promise<CancelBookingResult> => {
          const cancelledAt = this.clock.now();
          const cancellationReason = reason || null;
          // PostgreSQL rechecks the predicate after waiting for a concurrent updater.
          // Only the winner changes the status and appends history in this transaction.
          const changed = await tx.appointment.updateMany({
            where: { cancellationTokenHash, status: "SCHEDULED" },
            data: {
              status: "CANCELLED",
              cancelledBy: "CLIENT",
              cancelledAt,
              cancellationReason,
              version: { increment: 1 },
            },
          });
          const appointment = await tx.appointment.findUnique({
            where: { cancellationTokenHash },
            select: confirmationSelect,
          });
          if (!appointment) return { ok: false, code: "NOT_FOUND" };
          if (changed.count === 1) {
            await tx.appointmentStatusHistory.create({
              data: {
                appointmentId: appointment.id,
                previousStatus: "SCHEDULED",
                newStatus: "CANCELLED",
                changedBy: "CLIENT",
                changedAt: cancelledAt,
                reason: cancellationReason,
              },
            });
            return { ok: true, alreadyCancelled: false, confirmation: toConfirmation(appointment) };
          }
          if (appointment.status === "CANCELLED")
            return { ok: true, alreadyCancelled: true, confirmation: toConfirmation(appointment) };
          if (appointment.status === "COMPLETED" || appointment.status === "NO_SHOW")
            return { ok: false, code: "STATUS_NOT_CANCELLABLE", status: appointment.status };
          throw new Error("Appointment status changed outside the supported transitions");
        },
        { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
      ),
    );
  }
}

export function createClientAppointmentService(database: PrismaClient, clock: Clock = systemClock) {
  return new ClientAppointmentService(database, clock);
}
