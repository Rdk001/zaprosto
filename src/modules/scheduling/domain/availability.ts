import {
  generateAvailabilitySlots,
  normalizeIntervals,
  subtractIntervals,
  type TimeInterval,
} from "./intervals";

export type BlockingAppointmentStatus = "SCHEDULED" | "COMPLETED" | "NO_SHOW" | "CANCELLED";

export interface AppointmentInterval extends TimeInterval {
  status: BlockingAppointmentStatus;
}

export type ScheduleExceptionInput =
  { type: "DAY_OFF" } | { type: "CUSTOM_HOURS"; intervals: readonly TimeInterval[] };

export interface CalculateMasterAvailabilityInput {
  weeklyWorkIntervals: readonly TimeInterval[];
  weeklyBreakIntervals?: readonly TimeInterval[];
  scheduleException?: ScheduleExceptionInput | null;
  appointments?: readonly AppointmentInterval[];
  candidateStarts: readonly Date[];
  durationMinutes: number;
  earliestStart?: Date;
}

export interface CalculatedMasterAvailability {
  workingIntervals: TimeInterval[];
  unavailableIntervals: TimeInterval[];
  freeIntervals: TimeInterval[];
  slots: TimeInterval[];
}

export function resolveWorkingIntervals(
  weeklyWorkIntervals: readonly TimeInterval[],
  scheduleException?: ScheduleExceptionInput | null,
): TimeInterval[] {
  if (scheduleException?.type === "DAY_OFF") {
    return [];
  }

  if (scheduleException?.type === "CUSTOM_HOURS") {
    return normalizeIntervals(scheduleException.intervals);
  }

  return normalizeIntervals(weeklyWorkIntervals);
}

export function calculateMasterAvailability({
  weeklyWorkIntervals,
  weeklyBreakIntervals = [],
  scheduleException,
  appointments = [],
  candidateStarts,
  durationMinutes,
  earliestStart,
}: CalculateMasterAvailabilityInput): CalculatedMasterAvailability {
  const workingIntervals = resolveWorkingIntervals(weeklyWorkIntervals, scheduleException);
  const blockingAppointments = appointments.filter(({ status }) => status !== "CANCELLED");
  const unavailableIntervals = normalizeIntervals([
    ...weeklyBreakIntervals,
    ...blockingAppointments,
  ]);

  return {
    workingIntervals,
    unavailableIntervals,
    freeIntervals: subtractIntervals(workingIntervals, unavailableIntervals),
    slots: generateAvailabilitySlots({
      workingIntervals,
      unavailableIntervals,
      candidateStarts,
      durationMinutes,
      earliestStart,
    }),
  };
}
