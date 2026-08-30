import { describe, expect, it } from "vitest";

import {
  BookingDateOutOfRangeError,
  InvalidLocalDateError,
  InvalidLocalDateTimeError,
  InvalidTimeZoneError,
} from "../domain/errors";
import {
  generateLocalScheduleSlotStarts,
  getBookingDateContext,
  getLocalDayInterval,
  localScheduleIntervalToUtc,
} from "./business-time";

function databaseTime(time: string): Date {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

function isoStarts(starts: Date[]): string[] {
  return starts.map((startsAt) => startsAt.toISOString());
}

describe("business local dates", () => {
  it("treats a 30-day horizon as today plus the next 29 local dates", () => {
    const now = new Date("2026-08-28T21:30:00.000Z");

    expect(getBookingDateContext("2026-08-29", "Europe/Moscow", 30, now).lastBookableDate).toBe(
      "2026-09-27",
    );
    expect(() => getBookingDateContext("2026-09-28", "Europe/Moscow", 30, now)).toThrow(
      BookingDateOutOfRangeError,
    );
  });

  it("rejects a malformed or nonexistent local date", () => {
    expect(() =>
      getBookingDateContext(
        "2026-02-30",
        "Europe/Moscow",
        30,
        new Date("2026-02-01T00:00:00.000Z"),
      ),
    ).toThrow(InvalidLocalDateError);
  });

  it("rejects an invalid IANA time zone", () => {
    expect(() => getLocalDayInterval("2026-08-29", "Europe/Not_A_Zone")).toThrow(
      InvalidTimeZoneError,
    );
  });

  it("converts local day boundaries to UTC across DST", () => {
    const day = getLocalDayInterval("2026-03-08", "America/New_York");

    expect(day.startsAt.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(day.endsAt.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it.each([
    ["2026-03-08", "02:30"],
    ["2026-11-01", "01:30"],
  ])("rejects a nonexistent or ambiguous local moment: %sT%s", (localDate, localTime) => {
    expect(() =>
      localScheduleIntervalToUtc(
        localDate,
        databaseTime(localTime),
        databaseTime("03:30"),
        "America/New_York",
      ),
    ).toThrow(InvalidLocalDateTimeError);
  });

  it("omits ambiguous fallback starts instead of generating both offsets", () => {
    const starts = generateLocalScheduleSlotStarts(
      "2026-11-01",
      [{ startsAt: databaseTime("00:00"), endsAt: databaseTime("04:00") }],
      "America/New_York",
    );

    expect(isoStarts(starts)).toEqual([
      "2026-11-01T04:00:00.000Z",
      "2026-11-01T04:15:00.000Z",
      "2026-11-01T04:30:00.000Z",
      "2026-11-01T04:45:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:15:00.000Z",
      "2026-11-01T07:30:00.000Z",
      "2026-11-01T07:45:00.000Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T08:15:00.000Z",
      "2026-11-01T08:30:00.000Z",
      "2026-11-01T08:45:00.000Z",
    ]);
    expect(() =>
      generateLocalScheduleSlotStarts(
        "2026-11-01",
        [{ startsAt: databaseTime("01:00"), endsAt: databaseTime("04:00") }],
        "America/New_York",
      ),
    ).toThrow(InvalidLocalDateTimeError);
  });

  it("omits nonexistent spring-forward starts without shifting them to 03:xx", () => {
    const starts = generateLocalScheduleSlotStarts(
      "2026-03-08",
      [{ startsAt: databaseTime("00:00"), endsAt: databaseTime("04:00") }],
      "America/New_York",
    );

    expect(isoStarts(starts)).toEqual([
      "2026-03-08T05:00:00.000Z",
      "2026-03-08T05:15:00.000Z",
      "2026-03-08T05:30:00.000Z",
      "2026-03-08T05:45:00.000Z",
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T06:15:00.000Z",
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T06:45:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:15:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T07:45:00.000Z",
    ]);
  });

  it("keeps the ordinary Europe/Moscow quarter-hour grid", () => {
    const starts = generateLocalScheduleSlotStarts(
      "2026-10-05",
      [{ startsAt: databaseTime("09:00"), endsAt: databaseTime("10:00") }],
      "Europe/Moscow",
    );

    expect(isoStarts(starts)).toEqual([
      "2026-10-05T06:00:00.000Z",
      "2026-10-05T06:15:00.000Z",
      "2026-10-05T06:30:00.000Z",
      "2026-10-05T06:45:00.000Z",
    ]);
  });
});
