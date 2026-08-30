import { InvalidIntervalError } from "./errors";

const MINUTE_IN_MILLISECONDS = 60_000;

export interface TimeInterval {
  startsAt: Date;
  endsAt: Date;
}

export interface GenerateAvailabilitySlotsInput {
  workingIntervals: readonly TimeInterval[];
  unavailableIntervals?: readonly TimeInterval[];
  candidateStarts?: readonly Date[];
  durationMinutes: number;
  stepMinutes?: number;
  earliestStart?: Date;
}

function validInstant(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function intervalBounds(interval: TimeInterval): [number, number] {
  if (!validInstant(interval.startsAt) || !validInstant(interval.endsAt)) {
    throw new InvalidIntervalError("Interval boundaries must be valid Date values");
  }

  const startsAt = interval.startsAt.getTime();
  const endsAt = interval.endsAt.getTime();

  if (startsAt >= endsAt) {
    throw new InvalidIntervalError("Interval start must be earlier than its end");
  }

  return [startsAt, endsAt];
}

function intervalFromMilliseconds(startsAt: number, endsAt: number): TimeInterval {
  return {
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
  };
}

export function intervalsOverlap(first: TimeInterval, second: TimeInterval): boolean {
  const [firstStart, firstEnd] = intervalBounds(first);
  const [secondStart, secondEnd] = intervalBounds(second);

  return firstStart < secondEnd && secondStart < firstEnd;
}

export function intervalContains(container: TimeInterval, candidate: TimeInterval): boolean {
  const [containerStart, containerEnd] = intervalBounds(container);
  const [candidateStart, candidateEnd] = intervalBounds(candidate);

  return containerStart <= candidateStart && candidateEnd <= containerEnd;
}

export function normalizeIntervals(intervals: readonly TimeInterval[]): TimeInterval[] {
  const sorted = intervals
    .map((interval) => {
      const [startsAt, endsAt] = intervalBounds(interval);
      return { startsAt, endsAt };
    })
    .sort((first, second) => first.startsAt - second.startsAt || first.endsAt - second.endsAt);

  const normalized: Array<{ startsAt: number; endsAt: number }> = [];

  for (const interval of sorted) {
    const previous = normalized.at(-1);

    if (!previous || interval.startsAt > previous.endsAt) {
      normalized.push({ ...interval });
      continue;
    }

    previous.endsAt = Math.max(previous.endsAt, interval.endsAt);
  }

  return normalized.map(({ startsAt, endsAt }) => intervalFromMilliseconds(startsAt, endsAt));
}

export function subtractIntervals(
  sourceIntervals: readonly TimeInterval[],
  intervalsToSubtract: readonly TimeInterval[],
): TimeInterval[] {
  const sources = normalizeIntervals(sourceIntervals);
  const blockers = normalizeIntervals(intervalsToSubtract);
  const result: TimeInterval[] = [];

  for (const source of sources) {
    const [sourceStart, sourceEnd] = intervalBounds(source);
    let cursor = sourceStart;

    for (const blocker of blockers) {
      const [blockerStart, blockerEnd] = intervalBounds(blocker);

      if (blockerEnd <= cursor) {
        continue;
      }

      if (blockerStart >= sourceEnd) {
        break;
      }

      if (blockerStart > cursor) {
        result.push(intervalFromMilliseconds(cursor, Math.min(blockerStart, sourceEnd)));
      }

      cursor = Math.max(cursor, blockerEnd);

      if (cursor >= sourceEnd) {
        break;
      }
    }

    if (cursor < sourceEnd) {
      result.push(intervalFromMilliseconds(cursor, sourceEnd));
    }
  }

  return result;
}

export function generateAvailabilitySlots({
  workingIntervals,
  unavailableIntervals = [],
  candidateStarts,
  durationMinutes,
  stepMinutes = 15,
  earliestStart,
}: GenerateAvailabilitySlotsInput): TimeInterval[] {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new InvalidIntervalError("Service duration must be a positive integer number of minutes");
  }

  if (!Number.isInteger(stepMinutes) || stepMinutes <= 0) {
    throw new InvalidIntervalError("Slot step must be a positive integer number of minutes");
  }

  if (earliestStart && !validInstant(earliestStart)) {
    throw new InvalidIntervalError("Earliest slot start must be a valid Date");
  }

  const work = normalizeIntervals(workingIntervals);
  const blockers = normalizeIntervals(unavailableIntervals);
  const duration = durationMinutes * MINUTE_IN_MILLISECONDS;
  const step = stepMinutes * MINUTE_IN_MILLISECONDS;
  const earliest = earliestStart?.getTime() ?? Number.NEGATIVE_INFINITY;
  const slots: TimeInterval[] = [];

  if (candidateStarts) {
    const uniqueStarts = [
      ...new Set(
        candidateStarts.map((candidateStart) => {
          if (!validInstant(candidateStart)) {
            throw new InvalidIntervalError("Candidate slot start must be a valid Date");
          }

          return candidateStart.getTime();
        }),
      ),
    ].sort((first, second) => first - second);

    for (const startsAt of uniqueStarts) {
      if (startsAt < earliest) {
        continue;
      }

      const candidate = intervalFromMilliseconds(startsAt, startsAt + duration);

      if (
        work.some((workingInterval) => intervalContains(workingInterval, candidate)) &&
        !blockers.some((blocker) => intervalsOverlap(candidate, blocker))
      ) {
        slots.push(candidate);
      }
    }

    return slots;
  }

  for (const interval of work) {
    const [workStart, workEnd] = intervalBounds(interval);

    for (let startsAt = workStart; startsAt + duration <= workEnd; startsAt += step) {
      if (startsAt < earliest) {
        continue;
      }

      const candidate = intervalFromMilliseconds(startsAt, startsAt + duration);

      if (!blockers.some((blocker) => intervalsOverlap(candidate, blocker))) {
        slots.push(candidate);
      }
    }
  }

  return slots;
}

export function intersectionMinutes(interval: TimeInterval, boundary: TimeInterval): number {
  const [intervalStart, intervalEnd] = intervalBounds(interval);
  const [boundaryStart, boundaryEnd] = intervalBounds(boundary);
  const overlap = Math.min(intervalEnd, boundaryEnd) - Math.max(intervalStart, boundaryStart);

  return Math.max(0, overlap) / MINUTE_IN_MILLISECONDS;
}
