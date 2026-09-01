import { randomUUID } from "node:crypto";

import type { Prisma } from "../../../generated/prisma/client";
import type { AdminIdentity } from "../../auth/server/auth-service";
import { confirmationSelect, toConfirmation } from "../../appointments/server/confirmation";
import { publicServiceTerms } from "../../catalog/server/service-terms";
import {
  InactiveServiceError,
  SchedulingError,
  ServiceNotFoundError,
} from "../../scheduling/domain/errors";
import {
  createSchedulingAvailabilityService,
  type Clock,
} from "../../scheduling/server/availability-service";
import { businessContextHash, settingsSelect } from "../../settings/server/context";
import type { CreateBookingInput } from "../domain/booking-input";
import { hashBookingToken, matchesBookingToken } from "./booking-security";
import type { BookingAvailability, BookingRejectionReason, CreateBookingResult } from "./types";

export class SlotUnavailable extends Error {}
export class ServiceTermsChanged extends Error {}
export class BusinessContextChanged extends Error {}
export class BookingAuthorizationLost extends Error {}

export function bookingRejectionReason(error: unknown): BookingRejectionReason | null {
  if (!(error instanceof SchedulingError)) return null;
  switch (error.code) {
    case "SERVICE_NOT_FOUND":
    case "INACTIVE_SERVICE":
    case "MASTER_NOT_ELIGIBLE":
    case "BOOKING_DATE_OUT_OF_RANGE":
      return error.code;
    default:
      return null;
  }
}

export async function activeBookingService(tx: Prisma.TransactionClient, serviceId: string) {
  const service = await tx.service.findUnique({
    where: { id: serviceId },
    select: { id: true, name: true, priceKopecks: true, durationMinutes: true, isActive: true },
  });
  if (!service) throw new ServiceNotFoundError(serviceId);
  if (!service.isActive) throw new InactiveServiceError(serviceId);
  return service;
}

export async function bookingAvailabilityInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateBookingInput,
  clock: Clock,
): Promise<BookingAvailability> {
  const scope = { serviceId: input.serviceId, localDate: input.localDate };
  try {
    const scheduling = createSchedulingAvailabilityService(tx, clock);
    if (input.master.type === "SPECIFIC") {
      const result = await scheduling.getMasterAvailability({
        ...scope,
        masterId: input.master.masterId,
      });
      return {
        ...scope,
        timeZone: result.timeZone,
        slots: result.slots.map((slot) => ({
          ...slot,
          masters: [{ id: result.master.id, name: result.master.name }],
        })),
      };
    }
    const result = await scheduling.getAnyMasterAvailability(scope);
    return {
      ...scope,
      timeZone: result.timeZone,
      slots: result.slots.map((slot) => ({
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        masters: slot.candidates.map(({ id, name }) => ({ id, name })),
      })),
    };
  } catch (error) {
    const reason = bookingRejectionReason(error);
    if (reason) return { ...scope, slots: [], unavailableReason: reason };
    throw error;
  }
}

export async function createBookingInTransaction(input: {
  tx: Prisma.TransactionClient;
  booking: CreateBookingInput;
  requestHash: string;
  source: "ONLINE" | "ADMIN";
  changedBy: "CLIENT" | "ADMIN";
  clock: Clock;
  verifyAdminAfterWait?: () => Promise<AdminIdentity | null>;
}): Promise<CreateBookingResult> {
  const { tx, booking, requestHash, source, changedBy, clock, verifyAdminAfterWait } = input;
  const requestId = randomUUID();
  const inserted = await tx.$executeRaw`
    INSERT INTO booking_requests (id, idempotency_key, request_hash)
    VALUES (${requestId}::uuid, ${booking.idempotencyKey}, ${requestHash})
    ON CONFLICT (idempotency_key) DO NOTHING
  `;

  if (inserted === 0) {
    if (verifyAdminAfterWait && !(await verifyAdminAfterWait()))
      throw new BookingAuthorizationLost();
    const previous = await tx.bookingRequest.findUniqueOrThrow({
      where: { idempotencyKey: booking.idempotencyKey },
      select: {
        requestHash: true,
        appointment: { select: { ...confirmationSelect, cancellationTokenHash: true } },
      },
    });
    if (
      !previous.appointment ||
      !previous.requestHash ||
      previous.requestHash !== requestHash ||
      !matchesBookingToken(booking.cancellationToken, previous.appointment.cancellationTokenHash)
    )
      return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
    return {
      ok: true,
      replayed: true,
      timeZone: (
        await tx.businessSettings.findUniqueOrThrow({
          where: { id: 1 },
          select: { timezone: true },
        })
      ).timezone,
      confirmation: toConfirmation(previous.appointment),
      cancellationToken: booking.cancellationToken,
    };
  }

  const service = await activeBookingService(tx, booking.serviceId);
  if (booking.expectedServiceTerms !== publicServiceTerms(service).termsHash)
    throw new ServiceTermsChanged();

  await tx.$queryRaw`SELECT id FROM business_settings WHERE id = 1 FOR SHARE`;
  const settings = await tx.businessSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: settingsSelect,
  });
  if (booking.expectedBusinessContext !== businessContextHash(settings))
    throw new BusinessContextChanged();

  const scheduling = createSchedulingAvailabilityService(tx, clock);
  const query = {
    serviceId: booking.serviceId,
    localDate: booking.localDate,
    startsAt: booking.startsAt,
  };
  let masterId: string;
  if (booking.master.type === "ANY") {
    const selection = await scheduling.selectAnyMaster(query);
    if (!selection.selectedMaster) throw new SlotUnavailable();
    masterId = selection.selectedMaster.id;
  } else {
    masterId = booking.master.masterId;
  }
  const checked = await scheduling.checkMasterInterval({ ...query, masterId });
  if (!checked.isAvailable) throw new SlotUnavailable();

  const appointment = await tx.appointment.create({
    data: {
      bookingRequestId: requestId,
      masterId,
      serviceId: booking.serviceId,
      startsAt: checked.interval.startsAt,
      endsAt: checked.interval.endsAt,
      clientName: booking.clientName,
      clientPhone: booking.clientPhone,
      status: "SCHEDULED",
      source,
      masterSelection: booking.master.type,
      serviceNameSnapshot: service.name,
      servicePriceSnapshot: service.priceKopecks,
      serviceDurationSnapshot: service.durationMinutes,
      cancellationTokenHash: hashBookingToken(booking.cancellationToken),
    },
    select: confirmationSelect,
  });

  const admin = verifyAdminAfterWait ? await verifyAdminAfterWait() : null;
  if (verifyAdminAfterWait && !admin) throw new BookingAuthorizationLost();
  await tx.appointmentStatusHistory.create({
    data: {
      appointmentId: appointment.id,
      previousStatus: null,
      newStatus: "SCHEDULED",
      changedBy,
      changedByAdminId: admin?.id,
      changedAt: clock.now(),
    },
    select: { id: true },
  });
  return {
    ok: true,
    replayed: false,
    timeZone: settings.timezone,
    confirmation: toConfirmation(appointment),
    cancellationToken: booking.cancellationToken,
  };
}
