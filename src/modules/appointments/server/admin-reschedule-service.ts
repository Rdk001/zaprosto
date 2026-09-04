import type { Prisma, PrismaClient } from "../../../generated/prisma/client";
import { getActiveAdmin, getActiveAdminForShare } from "../../auth/server/auth-service";
import {
  appointmentRescheduleAvailabilitySchema,
  rescheduleAppointmentSchema,
  type AppointmentRescheduleAvailabilityInput,
  type AppointmentServiceSelection,
  type RescheduleAppointmentInput,
} from "../domain/admin-reschedule-input";
import { activeBookingService } from "../../booking/server/booking-engine";
import { publicServiceTerms, type PublicServiceTerms } from "../../catalog/server/service-terms";
import { SchedulingError } from "../../scheduling/domain/errors";
import {
  createSchedulingAvailabilityService,
  type Clock,
} from "../../scheduling/server/availability-service";
import type { HistoricalServiceTerms } from "../../scheduling/server/types";
import {
  businessContextHash,
  publicTimeContext,
  settingsSelect,
  type PublicTimeContext,
} from "../../settings/server/context";
import { isAppointmentOverlap } from "../../../server/db/transaction-errors";

const currentAppointmentSelect = {
  id: true,
  version: true,
  status: true,
  serviceId: true,
  masterId: true,
  masterSelection: true,
  startsAt: true,
  endsAt: true,
  serviceNameSnapshot: true,
  servicePriceSnapshot: true,
  serviceDurationSnapshot: true,
} satisfies Prisma.AppointmentSelect;

type CurrentAppointment = Prisma.AppointmentGetPayload<{
  select: typeof currentAppointmentSelect;
}>;

type RescheduleService = {
  id: string;
  name: string;
  priceKopecks: number;
  durationMinutes: number;
};

export type AdminRescheduleAvailability = {
  ok: true;
  context: PublicTimeContext;
  timeZone: string;
  service: RescheduleService;
  slots: Array<{ startsAt: string; endsAt: string }>;
};

export type AdminRescheduleFailure =
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "UNAUTHORIZED"
        | "FORBIDDEN"
        | "UNAVAILABLE"
        | "NOT_FOUND"
        | "CONFLICT"
        | "EDIT_NOT_ALLOWED";
    }
  | { ok: false; code: "SELECTION_UNAVAILABLE"; context: PublicTimeContext }
  | {
      ok: false;
      code: "SERVICE_TERMS_CHANGED";
      service: PublicServiceTerms;
    }
  | {
      ok: false;
      code: "BUSINESS_CONTEXT_CHANGED";
      context: PublicTimeContext;
    };

export type AdminRescheduleAvailabilityResult =
  AdminRescheduleAvailability | AdminRescheduleFailure;

export type AdminRescheduleMutationResult =
  | {
      ok: true;
      appointmentId: string;
      version: number;
    }
  | AdminRescheduleFailure
  | {
      ok: false;
      code: "START_NOT_IN_FUTURE" | "NO_CHANGES";
    }
  | {
      ok: false;
      code: "SLOT_UNAVAILABLE";
      availability: AdminRescheduleAvailability;
    };

type SelectedService = {
  service: RescheduleService;
  historicalTerms?: HistoricalServiceTerms;
};

function isSelectionError(error: unknown): boolean {
  return (
    error instanceof SchedulingError &&
    [
      "BOOKING_DATE_OUT_OF_RANGE",
      "MASTER_NOT_ELIGIBLE",
      "SERVICE_NOT_FOUND",
      "INACTIVE_SERVICE",
    ].includes(error.code)
  );
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return now;
}

async function resolveSelectedService(
  tx: Prisma.TransactionClient,
  current: CurrentAppointment,
  selection: AppointmentServiceSelection,
  context: PublicTimeContext,
): Promise<SelectedService | AdminRescheduleFailure> {
  if (selection.mode === "KEEP_CURRENT") {
    return {
      service: {
        id: current.serviceId,
        name: current.serviceNameSnapshot,
        priceKopecks: current.servicePriceSnapshot,
        durationMinutes: current.serviceDurationSnapshot,
      },
      historicalTerms: { durationMinutes: current.serviceDurationSnapshot },
    };
  }

  let activeService;
  try {
    activeService = await activeBookingService(tx, selection.serviceId);
  } catch (error) {
    if (isSelectionError(error)) {
      return { ok: false, code: "SELECTION_UNAVAILABLE", context };
    }
    throw error;
  }
  const terms = publicServiceTerms(activeService);
  if (terms.termsHash !== selection.expectedServiceTerms) {
    return { ok: false, code: "SERVICE_TERMS_CHANGED", service: terms };
  }
  return { service: terms };
}

function isFailure(
  value: SelectedService | AdminRescheduleFailure,
): value is AdminRescheduleFailure {
  return "ok" in value && value.ok === false;
}

function samePersistedVisit(
  current: CurrentAppointment,
  input: RescheduleAppointmentInput,
  selected: SelectedService,
  masterId: string,
  endsAt: Date,
): boolean {
  return (
    current.serviceId === selected.service.id &&
    current.serviceNameSnapshot === selected.service.name &&
    current.servicePriceSnapshot === selected.service.priceKopecks &&
    current.serviceDurationSnapshot === selected.service.durationMinutes &&
    current.masterId === masterId &&
    current.masterSelection === input.master.type &&
    current.startsAt.getTime() === input.startsAt.getTime() &&
    current.endsAt.getTime() === endsAt.getTime()
  );
}

function sameRequestedVisit(
  current: CurrentAppointment,
  input: RescheduleAppointmentInput,
  selected: SelectedService,
): boolean {
  const masterIsSame =
    input.master.type === "ANY"
      ? current.masterSelection === "ANY"
      : current.masterSelection === "SPECIFIC" && current.masterId === input.master.masterId;
  const endsAt = new Date(input.startsAt.getTime() + selected.service.durationMinutes * 60_000);
  return (
    masterIsSame &&
    current.serviceId === selected.service.id &&
    current.serviceNameSnapshot === selected.service.name &&
    current.servicePriceSnapshot === selected.service.priceKopecks &&
    current.serviceDurationSnapshot === selected.service.durationMinutes &&
    current.startsAt.getTime() === input.startsAt.getTime() &&
    current.endsAt.getTime() === endsAt.getTime()
  );
}

function availabilityInput(input: RescheduleAppointmentInput) {
  return {
    appointmentId: input.appointmentId,
    expectedVersion: input.expectedVersion,
    service: input.service,
    master: input.master,
    localDate: input.localDate,
    expectedBusinessContext: input.expectedBusinessContext,
  };
}

export class AdminAppointmentRescheduleService {
  constructor(private readonly database: PrismaClient) {}

  async availability(token: unknown, raw: unknown): Promise<AdminRescheduleAvailabilityResult> {
    try {
      const result = await this.database.$transaction(
        async (tx): Promise<AdminRescheduleAvailabilityResult> => {
          if (!(await getActiveAdmin(tx, token))) {
            return { ok: false, code: "UNAUTHORIZED" };
          }
          const parsed = appointmentRescheduleAvailabilitySchema.safeParse(raw);
          if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
          return this.buildAvailability(tx, parsed.data);
        },
        { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
      );
      if (!(await getActiveAdmin(this.database, token))) {
        return { ok: false, code: "UNAUTHORIZED" };
      }
      return result;
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
  }

  async reschedule(token: unknown, raw: unknown): Promise<AdminRescheduleMutationResult> {
    const parsed = rescheduleAppointmentSchema.safeParse(raw);
    if (!parsed.success) {
      if (!(await getActiveAdmin(this.database, token))) {
        return { ok: false, code: "UNAUTHORIZED" };
      }
      return { ok: false, code: "INVALID_INPUT" };
    }
    const input = parsed.data;

    try {
      return await this.database.$transaction(
        async (tx): Promise<AdminRescheduleMutationResult> => {
          if (!(await getActiveAdmin(tx, token))) {
            return { ok: false, code: "UNAUTHORIZED" };
          }

          // Keep the same global lock order as settings/status mutations, then
          // serialize every visit edit on the appointment row itself.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(526008, 52)`;
          await tx.$queryRaw`SELECT id FROM business_settings WHERE id = 1 FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM appointments
            WHERE id = ${input.appointmentId}::uuid FOR UPDATE`;

          if (!(await getActiveAdmin(tx, token))) {
            return { ok: false, code: "UNAUTHORIZED" };
          }
          const settings = await tx.businessSettings.findUniqueOrThrow({
            where: { id: 1 },
            select: settingsSelect,
          });
          const current = await tx.appointment.findUnique({
            where: { id: input.appointmentId },
            select: currentAppointmentSelect,
          });
          const now = await databaseNow(tx);
          if (!current) return { ok: false, code: "NOT_FOUND" };
          if (current.version !== input.expectedVersion) {
            return { ok: false, code: "CONFLICT" };
          }
          if (current.status !== "SCHEDULED") {
            return { ok: false, code: "EDIT_NOT_ALLOWED" };
          }
          const context = publicTimeContext(settings, now);
          if (input.expectedBusinessContext !== businessContextHash(settings)) {
            return { ok: false, code: "BUSINESS_CONTEXT_CHANGED", context };
          }

          const selected = await resolveSelectedService(tx, current, input.service, context);
          if (isFailure(selected)) return selected;
          if (input.startsAt <= now) {
            return { ok: false, code: "START_NOT_IN_FUTURE" };
          }
          if (sameRequestedVisit(current, input, selected)) {
            return { ok: false, code: "NO_CHANGES" };
          }

          const scheduling = createSchedulingAvailabilityService(tx, {
            now: () => now,
          } satisfies Clock);
          const query = {
            serviceId: selected.service.id,
            localDate: input.localDate,
            startsAt: input.startsAt,
            excludeAppointmentId: current.id,
          };
          let masterId: string;
          let endsAt: Date;
          try {
            if (input.master.type === "ANY") {
              const selection = await scheduling.selectAnyMaster(query, selected.historicalTerms);
              if (!selection.selectedMaster) {
                const availability = await this.buildAvailability(tx, availabilityInput(input));
                return availability.ok
                  ? { ok: false, code: "SLOT_UNAVAILABLE", availability }
                  : availability;
              }
              masterId = selection.selectedMaster.id;
            } else {
              masterId = input.master.masterId;
            }
            const checked = await scheduling.checkMasterInterval(
              { ...query, masterId },
              selected.historicalTerms,
            );
            if (!checked.isAvailable) {
              const availability = await this.buildAvailability(tx, availabilityInput(input));
              return availability.ok
                ? { ok: false, code: "SLOT_UNAVAILABLE", availability }
                : availability;
            }
            endsAt = checked.interval.endsAt;
          } catch (error) {
            if (isSelectionError(error)) {
              return { ok: false, code: "SELECTION_UNAVAILABLE", context };
            }
            throw error;
          }

          if (samePersistedVisit(current, input, selected, masterId, endsAt)) {
            return { ok: false, code: "NO_CHANGES" };
          }
          // Hold the session and account stable through the write and COMMIT.
          if (!(await getActiveAdminForShare(tx, token))) {
            return { ok: false, code: "UNAUTHORIZED" };
          }
          const updated = await tx.appointment.update({
            where: { id: current.id, version: input.expectedVersion },
            data: {
              masterId,
              masterSelection: input.master.type,
              startsAt: input.startsAt,
              endsAt,
              version: { increment: 1 },
              ...(input.service.mode === "CATALOG"
                ? {
                    serviceId: selected.service.id,
                    serviceNameSnapshot: selected.service.name,
                    servicePriceSnapshot: selected.service.priceKopecks,
                    serviceDurationSnapshot: selected.service.durationMinutes,
                  }
                : {}),
            },
            select: { id: true, version: true },
          });
          return {
            ok: true,
            appointmentId: updated.id,
            version: updated.version,
          };
        },
        { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      if (isAppointmentOverlap(error)) {
        const fresh = await this.availability(token, availabilityInput(input));
        return fresh.ok ? { ok: false, code: "SLOT_UNAVAILABLE", availability: fresh } : fresh;
      }
      // Unknown COMMIT outcome: never retry and never infer success/current version.
      return { ok: false, code: "UNAVAILABLE" };
    }
  }

  private async buildAvailability(
    tx: Prisma.TransactionClient,
    input: AppointmentRescheduleAvailabilityInput,
  ): Promise<AdminRescheduleAvailabilityResult> {
    const now = await databaseNow(tx);
    const settings = await tx.businessSettings.findUniqueOrThrow({
      where: { id: 1 },
      select: settingsSelect,
    });
    const context = publicTimeContext(settings, now);
    if (input.expectedBusinessContext !== context.contextHash) {
      return { ok: false, code: "BUSINESS_CONTEXT_CHANGED", context };
    }
    const current = await tx.appointment.findUnique({
      where: { id: input.appointmentId },
      select: currentAppointmentSelect,
    });
    if (!current) return { ok: false, code: "NOT_FOUND" };
    if (current.version !== input.expectedVersion) {
      return { ok: false, code: "CONFLICT" };
    }
    if (current.status !== "SCHEDULED") {
      return { ok: false, code: "EDIT_NOT_ALLOWED" };
    }

    const selected = await resolveSelectedService(tx, current, input.service, context);
    if (isFailure(selected)) return selected;
    const scheduling = createSchedulingAvailabilityService(tx, {
      now: () => now,
    } satisfies Clock);
    try {
      const query = {
        serviceId: selected.service.id,
        localDate: input.localDate,
        excludeAppointmentId: current.id,
      };
      const result =
        input.master.type === "SPECIFIC"
          ? await scheduling.getMasterAvailability(
              { ...query, masterId: input.master.masterId },
              selected.historicalTerms,
            )
          : await scheduling.getAnyMasterAvailability(query, selected.historicalTerms);
      return {
        ok: true,
        context,
        timeZone: result.timeZone,
        service: selected.service,
        slots: result.slots.map((slot) => ({
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
        })),
      };
    } catch (error) {
      if (isSelectionError(error)) {
        return { ok: false, code: "SELECTION_UNAVAILABLE", context };
      }
      throw error;
    }
  }
}

export function createAdminAppointmentRescheduleService(database: PrismaClient) {
  return new AdminAppointmentRescheduleService(database);
}
