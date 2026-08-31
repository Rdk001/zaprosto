import {
  businessContextHash,
  readTimeContext,
  settingsSelect,
} from "../../settings/server/context";
import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "../../../generated/prisma/client";
import { isAppointmentOverlap, retryTransaction } from "../../../server/db/transaction-errors";
import { confirmationSelect, toConfirmation } from "../../appointments/server/confirmation";
import { publicServiceTerms } from "../../catalog/server/service-terms";
import {
  InactiveServiceError,
  ServiceNotFoundError,
  SchedulingError,
} from "../../scheduling/domain/errors";
import {
  createSchedulingAvailabilityService,
  systemClock,
  type Clock,
} from "../../scheduling/server/availability-service";
import { createBookingSchema, inputIssues, type CreateBookingInput } from "../domain/booking-input";
import { hashBookingRequest, hashBookingToken, matchesBookingToken } from "./booking-security";
import type { BookingAvailability, BookingRejectionReason, CreateBookingResult } from "./types";

class SlotUnavailable extends Error {}
class ServiceTermsChanged extends Error {}
class BusinessContextChanged extends Error {}

function rejectionReason(error: unknown): BookingRejectionReason | null {
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

export class BookingService {
  constructor(
    private readonly database: PrismaClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async createBooking(rawInput: unknown): Promise<CreateBookingResult> {
    const parsed = createBookingSchema.safeParse(rawInput);
    if (!parsed.success)
      return { ok: false, code: "INVALID_INPUT", issues: inputIssues(parsed.error) };
    const input = parsed.data;
    try {
      return await retryTransaction(() =>
        this.database.$transaction((tx) => this.createInTransaction(tx, input), {
          isolationLevel: "Serializable",
          maxWait: 5_000,
          timeout: 10_000,
        }),
      );
    } catch (error) {
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
      if (error instanceof SlotUnavailable || isAppointmentOverlap(error)) {
        // The failed transaction has rolled back. Read availability in a new snapshot.
        return {
          ok: false,
          code: "SLOT_UNAVAILABLE",
          availability: await this.freshAvailability(input),
        };
      }
      const reason = rejectionReason(error);
      if (reason) return { ok: false, code: "REQUEST_REJECTED", reason };
      throw error;
    }
  }

  private async createInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateBookingInput,
  ): Promise<CreateBookingResult> {
    const requestHash = hashBookingRequest(input);
    const requestId = randomUUID();
    // Only this unique key is a replay. Other uniqueness violations must still fail.
    // Concurrent same-key inserts wait here; Serializable may require a fresh transaction.
    const inserted = await tx.$executeRaw`
      INSERT INTO booking_requests (id, idempotency_key, request_hash)
      VALUES (${requestId}::uuid, ${input.idempotencyKey}, ${requestHash})
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    if (inserted === 0) {
      const previous = await tx.bookingRequest.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
        select: {
          requestHash: true,
          appointment: { select: { ...confirmationSelect, cancellationTokenHash: true } },
        },
      });
      if (
        !previous.appointment ||
        !previous.requestHash ||
        previous.requestHash !== requestHash ||
        !matchesBookingToken(input.cancellationToken, previous.appointment.cancellationTokenHash)
      ) {
        return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
      }
      // A replay is authenticated with the original token and returns current status,
      // even after cancellation, a catalog change or the original date leaving the horizon.
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
        cancellationToken: input.cancellationToken,
      };
    }

    // Compare the exact terms shown by the client inside the creating transaction.
    // Throw to roll back the attempt row as well as any subsequent writes.
    const service = await this.activeService(tx, input.serviceId);
    if (input.expectedServiceTerms !== publicServiceTerms(service).termsHash)
      throw new ServiceTermsChanged();

    // Lock the singleton row through COMMIT. A settings update after this snapshot causes
    // a serialization retry rather than accepting a context from before the wait.
    await tx.$queryRaw`SELECT id FROM business_settings WHERE id = 1 FOR SHARE`;
    const settings = await tx.businessSettings.findUniqueOrThrow({
      where: { id: 1 },
      select: settingsSelect,
    });
    if (input.expectedBusinessContext !== businessContextHash(settings))
      throw new BusinessContextChanged();
    const scheduling = createSchedulingAvailabilityService(tx, this.clock);
    const query = {
      serviceId: input.serviceId,
      localDate: input.localDate,
      startsAt: input.startsAt,
    };
    let masterId: string;
    if (input.master.type === "ANY") {
      const selection = await scheduling.selectAnyMaster(query);
      if (!selection.selectedMaster) throw new SlotUnavailable();
      masterId = selection.selectedMaster.id;
    } else {
      masterId = input.master.masterId;
    }
    const checked = await scheduling.checkMasterInterval({ ...query, masterId });
    if (!checked.isAvailable) throw new SlotUnavailable();

    // Scheduling and snapshots see the same serializable database snapshot.
    const appointment = await tx.appointment.create({
      data: {
        bookingRequestId: requestId,
        masterId,
        serviceId: input.serviceId,
        startsAt: checked.interval.startsAt,
        endsAt: checked.interval.endsAt,
        clientName: input.clientName,
        clientPhone: input.clientPhone,
        status: "SCHEDULED",
        source: "ONLINE",
        masterSelection: input.master.type,
        serviceNameSnapshot: service.name,
        servicePriceSnapshot: service.priceKopecks,
        serviceDurationSnapshot: service.durationMinutes,
        cancellationTokenHash: hashBookingToken(input.cancellationToken),
        statusHistory: {
          create: {
            previousStatus: null,
            newStatus: "SCHEDULED",
            changedBy: "CLIENT",
            changedAt: this.clock.now(),
          },
        },
      },
      select: confirmationSelect,
    });
    return {
      ok: true,
      replayed: false,
      timeZone: settings.timezone,
      confirmation: toConfirmation(appointment),
      cancellationToken: input.cancellationToken,
    };
  }

  private async activeService(tx: Prisma.TransactionClient, serviceId: string) {
    const service = await tx.service.findUnique({
      where: { id: serviceId },
      select: { id: true, name: true, priceKopecks: true, durationMinutes: true, isActive: true },
    });
    if (!service) throw new ServiceNotFoundError(serviceId);
    if (!service.isActive) throw new InactiveServiceError(serviceId);
    return service;
  }

  private async freshTerms(input: CreateBookingInput): Promise<CreateBookingResult> {
    try {
      // The rejected create has rolled back. Terms and availability share a fresh snapshot.
      return await this.database.$transaction(
        async (tx) => ({
          ok: false as const,
          code: "SERVICE_TERMS_CHANGED" as const,
          service: publicServiceTerms(await this.activeService(tx, input.serviceId)),
          availability: await this.availabilityInTransaction(tx, input),
        }),
        { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      const reason = rejectionReason(error);
      if (reason) return { ok: false, code: "REQUEST_REJECTED", reason };
      throw error;
    }
  }

  private async freshAvailability(input: CreateBookingInput): Promise<BookingAvailability> {
    return this.database.$transaction((tx) => this.availabilityInTransaction(tx, input), {
      isolationLevel: "RepeatableRead",
      maxWait: 5_000,
      timeout: 10_000,
    });
  }

  private async availabilityInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateBookingInput,
  ): Promise<BookingAvailability> {
    const scope = { serviceId: input.serviceId, localDate: input.localDate };
    try {
      const scheduling = createSchedulingAvailabilityService(tx, this.clock);
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
      const reason = rejectionReason(error);
      if (reason) return { ...scope, slots: [], unavailableReason: reason };
      throw error;
    }
  }
}

export function createBookingService(database: PrismaClient, clock: Clock = systemClock) {
  return new BookingService(database, clock);
}
