import type { TimeInterval } from "./intervals";

export interface MasterDailyLoad {
  bookedMinutes: number;
  appointmentCount: number;
}

export interface AnyMasterAvailabilityInput {
  masterId: string;
  displayOrder: number;
  isActive: boolean;
  isAssigned: boolean;
  dailyLoad: MasterDailyLoad;
  slots: readonly TimeInterval[];
}

export interface CombinedAvailabilitySlot extends TimeInterval {
  candidateMasterIds: string[];
}

function compareIds(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function compareDisplayOrderThenId(
  first: AnyMasterAvailabilityInput,
  second: AnyMasterAvailabilityInput,
): number {
  return first.displayOrder - second.displayOrder || compareIds(first.masterId, second.masterId);
}

function isEligible(master: AnyMasterAvailabilityInput): boolean {
  return master.isActive && master.isAssigned;
}

export function combineMasterAvailability(
  masters: readonly AnyMasterAvailabilityInput[],
): CombinedAvailabilitySlot[] {
  const eligibleMasters = masters.filter(isEligible).toSorted(compareDisplayOrderThenId);
  const combined = new Map<
    string,
    { startsAt: number; endsAt: number; candidateMasterIds: string[] }
  >();

  for (const master of eligibleMasters) {
    for (const slot of master.slots) {
      const startsAt = slot.startsAt.getTime();
      const endsAt = slot.endsAt.getTime();
      const key = `${startsAt}:${endsAt}`;
      const existing = combined.get(key);

      if (existing) {
        existing.candidateMasterIds.push(master.masterId);
      } else {
        combined.set(key, {
          startsAt,
          endsAt,
          candidateMasterIds: [master.masterId],
        });
      }
    }
  }

  return [...combined.values()]
    .sort((first, second) => first.startsAt - second.startsAt || first.endsAt - second.endsAt)
    .map(({ startsAt, endsAt, candidateMasterIds }) => ({
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      candidateMasterIds,
    }));
}

export function selectAnyMasterForSlot(
  masters: readonly AnyMasterAvailabilityInput[],
  selectedInterval: TimeInterval,
): AnyMasterAvailabilityInput | null {
  const selectedStart = selectedInterval.startsAt.getTime();
  const selectedEnd = selectedInterval.endsAt.getTime();

  return (
    masters
      .filter(
        (master) =>
          isEligible(master) &&
          master.slots.some(
            ({ startsAt, endsAt }) =>
              startsAt.getTime() === selectedStart && endsAt.getTime() === selectedEnd,
          ),
      )
      .toSorted(
        (first, second) =>
          first.dailyLoad.bookedMinutes - second.dailyLoad.bookedMinutes ||
          first.dailyLoad.appointmentCount - second.dailyLoad.appointmentCount ||
          compareDisplayOrderThenId(first, second),
      )[0] ?? null
  );
}
