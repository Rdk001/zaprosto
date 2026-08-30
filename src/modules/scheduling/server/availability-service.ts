import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/client";
import {
  combineMasterAvailability,
  selectAnyMasterForSlot,
  type AnyMasterAvailabilityInput,
  type MasterDailyLoad,
} from "../domain/any-master";
import {
  calculateMasterAvailability,
  type AppointmentInterval,
  type ScheduleExceptionInput,
} from "../domain/availability";
import {
  BusinessSettingsNotFoundError,
  InactiveServiceError,
  InvalidIdentifierError,
  InvalidInstantError,
  MasterNotEligibleError,
  ServiceNotFoundError,
} from "../domain/errors";
import { intersectionMinutes } from "../domain/intervals";
import {
  generateLocalScheduleSlotStarts,
  getBookingDateContext,
  localScheduleIntervalToUtc,
} from "../time/business-time";
import type {
  AnyMasterAvailabilityResult,
  AnyMasterSelectionQuery,
  AnyMasterSelectionResult,
  AnyMasterSlotCandidate,
  AvailabilityQuery,
  MasterAvailabilityQuery,
  MasterAvailabilityResult,
  MasterIntervalCheckQuery,
  MasterIntervalCheckResult,
  SchedulingScope,
} from "./types";

const uuidSchema = z.uuid();
const SLOT_STEP_MINUTES = 15;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

interface LoadedAvailability {
  scope: SchedulingScope;
  masters: MasterAvailabilityResult[];
  anyMasterInputs: AnyMasterAvailabilityInput[];
}

function assertUuid(value: string, field: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidIdentifierError(field, value);
  }
}

function assertInstant(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidInstantError(field);
  }
}

function compareMasterSummaries(
  first: MasterAvailabilityResult,
  second: MasterAvailabilityResult,
): number {
  return (
    first.master.displayOrder - second.master.displayOrder ||
    (first.master.id < second.master.id ? -1 : first.master.id > second.master.id ? 1 : 0)
  );
}

export class SchedulingAvailabilityService {
  constructor(
    private readonly database: Prisma.TransactionClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async getMasterAvailability(query: MasterAvailabilityQuery): Promise<MasterAvailabilityResult> {
    assertUuid(query.masterId, "masterId");
    const availability = await this.loadAvailability(query, query.masterId);
    const master = availability.masters[0];

    if (!master) {
      throw new MasterNotEligibleError(query.masterId, query.serviceId);
    }

    return master;
  }

  async getAnyMasterAvailability(query: AvailabilityQuery): Promise<AnyMasterAvailabilityResult> {
    const availability = await this.loadAvailability(query);
    const mastersById = new Map(availability.masters.map((master) => [master.master.id, master]));
    const slots = combineMasterAvailability(availability.anyMasterInputs).map(
      ({ startsAt, endsAt, candidateMasterIds }) => ({
        startsAt,
        endsAt,
        candidates: candidateMasterIds.map((masterId) => {
          const master = mastersById.get(masterId);

          if (!master) {
            throw new Error(`Availability candidate ${masterId} was not loaded`);
          }

          return {
            ...master.master,
            dailyLoad: master.dailyLoad,
          };
        }),
      }),
    );

    return {
      ...availability.scope,
      masters: availability.masters,
      slots,
    };
  }

  async checkMasterInterval(query: MasterIntervalCheckQuery): Promise<MasterIntervalCheckResult> {
    assertInstant(query.startsAt, "startsAt");
    const availability = await this.getMasterAvailability(query);
    const interval = {
      startsAt: new Date(query.startsAt),
      endsAt: new Date(query.startsAt.getTime() + availability.serviceDurationMinutes * 60_000),
    };
    const isAvailable = availability.slots.some(
      (slot) =>
        slot.startsAt.getTime() === interval.startsAt.getTime() &&
        slot.endsAt.getTime() === interval.endsAt.getTime(),
    );

    return {
      serviceId: availability.serviceId,
      serviceDurationMinutes: availability.serviceDurationMinutes,
      localDate: availability.localDate,
      timeZone: availability.timeZone,
      day: availability.day,
      master: availability.master,
      interval,
      isAvailable,
      reason: isAvailable ? "AVAILABLE" : "NOT_AVAILABLE",
    };
  }

  async selectAnyMaster(query: AnyMasterSelectionQuery): Promise<AnyMasterSelectionResult> {
    assertInstant(query.startsAt, "startsAt");
    const availability = await this.loadAvailability(query);
    const interval = {
      startsAt: new Date(query.startsAt),
      endsAt: new Date(
        query.startsAt.getTime() + availability.scope.serviceDurationMinutes * 60_000,
      ),
    };
    const selected = selectAnyMasterForSlot(availability.anyMasterInputs, interval);
    const availableSlot = combineMasterAvailability(availability.anyMasterInputs).find(
      (slot) =>
        slot.startsAt.getTime() === interval.startsAt.getTime() &&
        slot.endsAt.getTime() === interval.endsAt.getTime(),
    );
    const mastersById = new Map(availability.masters.map((master) => [master.master.id, master]));
    const candidates: AnyMasterSlotCandidate[] =
      availableSlot?.candidateMasterIds.map((masterId) => {
        const master = mastersById.get(masterId);

        if (!master) {
          throw new Error(`Availability candidate ${masterId} was not loaded`);
        }

        return { ...master.master, dailyLoad: master.dailyLoad };
      }) ?? [];
    const selectedMaster = selected
      ? (candidates.find(({ id }) => id === selected.masterId) ?? null)
      : null;

    return {
      ...availability.scope,
      interval,
      isAvailable: selectedMaster !== null,
      candidates,
      selectedMaster,
    };
  }

  private async loadAvailability(
    query: AvailabilityQuery,
    requestedMasterId?: string,
  ): Promise<LoadedAvailability> {
    assertUuid(query.serviceId, "serviceId");

    if (query.excludeAppointmentId) {
      assertUuid(query.excludeAppointmentId, "excludeAppointmentId");
    }

    const settings = await this.database.businessSettings.findUnique({
      where: { id: 1 },
      select: { timezone: true, bookingHorizonDays: true },
    });

    if (!settings) {
      throw new BusinessSettingsNotFoundError();
    }

    const now = this.clock.now();
    const dateContext = getBookingDateContext(
      query.localDate,
      settings.timezone,
      settings.bookingHorizonDays,
      now,
    );
    const databaseLocalDate = new Date(`${dateContext.localDate}T00:00:00.000Z`);
    const service = await this.database.service.findUnique({
      where: { id: query.serviceId },
      select: {
        id: true,
        isActive: true,
        durationMinutes: true,
        masters: {
          where: {
            ...(requestedMasterId ? { masterId: requestedMasterId } : {}),
            master: { isActive: true },
          },
          select: {
            master: {
              select: {
                id: true,
                name: true,
                displayOrder: true,
                weeklyWorkIntervals: {
                  where: { dayOfWeek: dateContext.dayOfWeek },
                  orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }],
                  select: { startsAt: true, endsAt: true },
                },
                weeklyBreaks: {
                  where: { dayOfWeek: dateContext.dayOfWeek },
                  orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }],
                  select: { startsAt: true, endsAt: true },
                },
                scheduleExceptions: {
                  where: { localDate: databaseLocalDate },
                  take: 1,
                  select: {
                    type: true,
                    intervals: {
                      orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }],
                      select: { startsAt: true, endsAt: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!service) {
      throw new ServiceNotFoundError(query.serviceId);
    }

    if (!service.isActive) {
      throw new InactiveServiceError(query.serviceId);
    }

    const masterIds = service.masters.map(({ master }) => master.id);
    const appointments =
      masterIds.length === 0
        ? []
        : await this.database.appointment.findMany({
            where: {
              masterId: { in: masterIds },
              status: { not: "CANCELLED" },
              startsAt: { lt: dateContext.day.endsAt },
              endsAt: { gt: dateContext.day.startsAt },
              ...(query.excludeAppointmentId ? { id: { not: query.excludeAppointmentId } } : {}),
            },
            orderBy: [{ masterId: "asc" }, { startsAt: "asc" }],
            select: {
              id: true,
              masterId: true,
              startsAt: true,
              endsAt: true,
              status: true,
            },
          });
    const appointmentsByMaster = new Map<string, typeof appointments>();

    for (const appointment of appointments) {
      const masterAppointments = appointmentsByMaster.get(appointment.masterId) ?? [];
      masterAppointments.push(appointment);
      appointmentsByMaster.set(appointment.masterId, masterAppointments);
    }

    const scope: SchedulingScope = {
      serviceId: service.id,
      serviceDurationMinutes: service.durationMinutes,
      localDate: dateContext.localDate,
      timeZone: settings.timezone,
      day: dateContext.day,
    };
    const masters = service.masters
      .map(({ master }): MasterAvailabilityResult => {
        const toUtc = ({ startsAt, endsAt }: { startsAt: Date; endsAt: Date }) =>
          localScheduleIntervalToUtc(dateContext.localDate, startsAt, endsAt, settings.timezone);
        const exception = master.scheduleExceptions[0];
        let localSlotIntervals = master.weeklyWorkIntervals;

        if (exception?.type === "DAY_OFF") {
          localSlotIntervals = [];
        } else if (exception?.type === "CUSTOM_HOURS") {
          localSlotIntervals = exception.intervals;
        }

        // Resolve overrides before validating local boundaries that may fall on DST transitions.
        const effectiveWorkIntervals = localSlotIntervals.map(toUtc);
        const weeklyWorkIntervals = exception ? [] : effectiveWorkIntervals;
        const weeklyBreakIntervals =
          exception?.type === "DAY_OFF" ? [] : master.weeklyBreaks.map(toUtc);
        let scheduleException: ScheduleExceptionInput | null = null;

        if (exception?.type === "DAY_OFF") {
          scheduleException = { type: "DAY_OFF" };
        } else if (exception?.type === "CUSTOM_HOURS") {
          scheduleException = {
            type: "CUSTOM_HOURS",
            intervals: effectiveWorkIntervals,
          };
        }

        const masterAppointments = appointmentsByMaster.get(master.id) ?? [];
        const appointmentIntervals: AppointmentInterval[] = masterAppointments.map(
          (appointment) => ({
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            status: appointment.status,
          }),
        );
        const calculated = calculateMasterAvailability({
          weeklyWorkIntervals,
          weeklyBreakIntervals,
          scheduleException,
          appointments: appointmentIntervals,
          candidateStarts: generateLocalScheduleSlotStarts(
            dateContext.localDate,
            localSlotIntervals,
            settings.timezone,
            SLOT_STEP_MINUTES,
          ),
          durationMinutes: service.durationMinutes,
          earliestStart: dateContext.localDate === dateContext.today ? now : undefined,
        });
        const dailyLoad: MasterDailyLoad = {
          bookedMinutes: masterAppointments.reduce(
            (total, appointment) => total + intersectionMinutes(appointment, dateContext.day),
            0,
          ),
          appointmentCount: masterAppointments.length,
        };

        return {
          ...scope,
          master: {
            id: master.id,
            name: master.name,
            displayOrder: master.displayOrder,
          },
          dailyLoad,
          workingIntervals: calculated.workingIntervals,
          freeIntervals: calculated.freeIntervals,
          slots: calculated.slots,
        };
      })
      .sort(compareMasterSummaries);
    const anyMasterInputs = masters.map((master): AnyMasterAvailabilityInput => ({
      masterId: master.master.id,
      displayOrder: master.master.displayOrder,
      isActive: true,
      isAssigned: true,
      dailyLoad: master.dailyLoad,
      slots: master.slots,
    }));

    return { scope, masters, anyMasterInputs };
  }
}

export function createSchedulingAvailabilityService(
  database: Prisma.TransactionClient,
  clock: Clock = systemClock,
): SchedulingAvailabilityService {
  return new SchedulingAvailabilityService(database, clock);
}
