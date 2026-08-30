import { Temporal } from "temporal-polyfill";

import {
  BookingDateOutOfRangeError,
  InvalidBookingHorizonError,
  InvalidInstantError,
  InvalidIntervalError,
  InvalidLocalDateError,
  InvalidLocalDateTimeError,
  InvalidTimeZoneError,
} from "../domain/errors";
import type { TimeInterval } from "../domain/intervals";

const ISO_LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_TIME_ZONE = /^(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

export interface BookingDateContext {
  localDate: string;
  today: string;
  lastBookableDate: string;
  dayOfWeek: number;
  day: TimeInterval;
}

export interface LocalScheduleIntervalInput {
  startsAt: Date;
  endsAt: Date;
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidInstantError(field);
  }
}

export function assertValidTimeZone(timeZone: string): string {
  if (
    typeof timeZone !== "string" ||
    timeZone.length === 0 ||
    timeZone.trim() !== timeZone ||
    OFFSET_TIME_ZONE.test(timeZone)
  ) {
    throw new InvalidTimeZoneError(timeZone);
  }

  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone);
    return timeZone;
  } catch (cause) {
    throw new InvalidTimeZoneError(timeZone, { cause });
  }
}

export function parseLocalDate(localDate: string): string {
  if (typeof localDate !== "string" || !ISO_LOCAL_DATE.test(localDate)) {
    throw new InvalidLocalDateError(localDate);
  }

  try {
    const parsed = Temporal.PlainDate.from(localDate);

    if (parsed.toString() !== localDate) {
      throw new RangeError("Date was not canonical");
    }

    return parsed.toString();
  } catch (cause) {
    throw new InvalidLocalDateError(localDate, { cause });
  }
}

export function localDateForInstant(instant: Date, timeZone: string): string {
  assertValidDate(instant, "instant");
  assertValidTimeZone(timeZone);

  return Temporal.Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

function localDateTimeToInstant(
  localDate: string,
  localTime: Temporal.PlainTime,
  timeZone: string,
): Date {
  const date = Temporal.PlainDate.from(localDate);

  try {
    const instant = date
      .toPlainDateTime(localTime)
      .toZonedDateTime(timeZone, { disambiguation: "reject" })
      .toInstant();

    return new Date(instant.epochMilliseconds);
  } catch (cause) {
    throw new InvalidLocalDateTimeError(
      localDate,
      localTime.toString({ smallestUnit: "second" }),
      timeZone,
      { cause },
    );
  }
}

function midnightForDate(localDate: string, timeZone: string): Date {
  return localDateTimeToInstant(localDate, Temporal.PlainTime.from("00:00"), timeZone);
}

export function getLocalDayInterval(localDate: string, timeZone: string): TimeInterval {
  const parsedDate = parseLocalDate(localDate);
  assertValidTimeZone(timeZone);
  const nextDate = Temporal.PlainDate.from(parsedDate).add({ days: 1 }).toString();

  return {
    startsAt: midnightForDate(parsedDate, timeZone),
    endsAt: midnightForDate(nextDate, timeZone),
  };
}

function plainTimeFromDatabaseTime(value: Date): Temporal.PlainTime {
  assertValidDate(value, "database time");

  return Temporal.PlainTime.from(
    {
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
      millisecond: value.getUTCMilliseconds(),
    },
    { overflow: "reject" },
  );
}

export function localScheduleIntervalToUtc(
  localDate: string,
  startsAt: Date,
  endsAt: Date,
  timeZone: string,
): TimeInterval {
  const parsedDate = parseLocalDate(localDate);
  const zone = assertValidTimeZone(timeZone);
  const startTime = plainTimeFromDatabaseTime(startsAt);
  const endTime = plainTimeFromDatabaseTime(endsAt);
  const interval = {
    startsAt: localDateTimeToInstant(parsedDate, startTime, zone),
    endsAt: localDateTimeToInstant(parsedDate, endTime, zone),
  };

  if (interval.startsAt >= interval.endsAt) {
    throw new InvalidIntervalError(
      `Local schedule interval ${startTime.toString()}..${endTime.toString()} does not produce an increasing UTC interval`,
    );
  }

  return interval;
}

export function generateLocalScheduleSlotStarts(
  localDate: string,
  intervals: readonly LocalScheduleIntervalInput[],
  timeZone: string,
  stepMinutes = 15,
): Date[] {
  const parsedDate = parseLocalDate(localDate);
  const zone = assertValidTimeZone(timeZone);

  if (!Number.isInteger(stepMinutes) || stepMinutes <= 0) {
    throw new InvalidIntervalError("Slot step must be a positive integer number of minutes");
  }

  const date = Temporal.PlainDate.from(parsedDate);
  const localIntervals = intervals
    .map(({ startsAt, endsAt }) => {
      const startTime = plainTimeFromDatabaseTime(startsAt);
      const endTime = plainTimeFromDatabaseTime(endsAt);

      localScheduleIntervalToUtc(parsedDate, startsAt, endsAt, zone);

      return {
        startsAt: date.toPlainDateTime(startTime),
        endsAt: date.toPlainDateTime(endTime),
      };
    })
    .sort(
      (first, second) =>
        Temporal.PlainDateTime.compare(first.startsAt, second.startsAt) ||
        Temporal.PlainDateTime.compare(first.endsAt, second.endsAt),
    );
  const normalized: Array<{
    startsAt: Temporal.PlainDateTime;
    endsAt: Temporal.PlainDateTime;
  }> = [];

  for (const interval of localIntervals) {
    const previous = normalized.at(-1);

    if (!previous || Temporal.PlainDateTime.compare(interval.startsAt, previous.endsAt) > 0) {
      normalized.push({ ...interval });
      continue;
    }

    if (Temporal.PlainDateTime.compare(interval.endsAt, previous.endsAt) > 0) {
      previous.endsAt = interval.endsAt;
    }
  }

  const starts: Date[] = [];

  for (const interval of normalized) {
    for (
      let candidate = interval.startsAt;
      Temporal.PlainDateTime.compare(candidate, interval.endsAt) < 0;
      candidate = candidate.add({ minutes: stepMinutes })
    ) {
      try {
        starts.push(localDateTimeToInstant(parsedDate, candidate.toPlainTime(), zone));
      } catch (error) {
        if (!(error instanceof InvalidLocalDateTimeError)) {
          throw error;
        }
      }
    }
  }

  return starts;
}

export function getBookingDateContext(
  requestedLocalDate: string,
  timeZone: string,
  bookingHorizonDays: number,
  now: Date,
): BookingDateContext {
  const localDate = parseLocalDate(requestedLocalDate);
  const zone = assertValidTimeZone(timeZone);
  assertValidDate(now, "clock.now()");

  if (!Number.isInteger(bookingHorizonDays) || bookingHorizonDays < 7 || bookingHorizonDays > 90) {
    throw new InvalidBookingHorizonError(bookingHorizonDays);
  }

  const today = localDateForInstant(now, zone);
  const todayDate = Temporal.PlainDate.from(today);
  const requestedDate = Temporal.PlainDate.from(localDate);
  const horizonEndExclusive = todayDate.add({ days: bookingHorizonDays });
  const lastBookableDate = horizonEndExclusive.subtract({ days: 1 }).toString();

  if (
    Temporal.PlainDate.compare(requestedDate, todayDate) < 0 ||
    Temporal.PlainDate.compare(requestedDate, horizonEndExclusive) >= 0
  ) {
    throw new BookingDateOutOfRangeError(localDate, today, lastBookableDate);
  }

  return {
    localDate,
    today,
    lastBookableDate,
    dayOfWeek: requestedDate.dayOfWeek,
    day: getLocalDayInterval(localDate, zone),
  };
}
