import { describe, expect, it } from "vitest";

import { calculateMasterAvailability } from "./availability";
import type { TimeInterval } from "./intervals";

function at(time: string): Date {
  return new Date(`2030-01-01T${time}:00.000Z`);
}

function interval(startsAt: string, endsAt: string): TimeInterval {
  return { startsAt: at(startsAt), endsAt: at(endsAt) };
}

function quarterHourStarts(startsAt: string, endsAt: string): Date[] {
  const starts: Date[] = [];
  const end = at(endsAt).getTime();

  for (let cursor = at(startsAt).getTime(); cursor < end; cursor += 15 * 60_000) {
    starts.push(new Date(cursor));
  }

  return starts;
}

function startsAt(availability: ReturnType<typeof calculateMasterAvailability>) {
  return availability.slots.map((slot) => slot.startsAt.toISOString().slice(11, 16));
}

describe("master availability rules", () => {
  it("does not let a cancelled appointment block time", () => {
    const availability = calculateMasterAvailability({
      weeklyWorkIntervals: [interval("09:00", "10:00")],
      appointments: [
        {
          ...interval("09:00", "09:30"),
          status: "CANCELLED",
        },
      ],
      candidateStarts: quarterHourStarts("09:00", "10:00"),
      durationMinutes: 30,
    });

    expect(startsAt(availability)).toEqual(["09:00", "09:15", "09:30"]);
  });

  it.each(["COMPLETED", "NO_SHOW"] as const)(
    "keeps a %s appointment blocking its saved interval",
    (status) => {
      const availability = calculateMasterAvailability({
        weeklyWorkIntervals: [interval("09:00", "10:30")],
        appointments: [{ ...interval("09:30", "10:00"), status }],
        candidateStarts: quarterHourStarts("09:00", "10:30"),
        durationMinutes: 30,
      });

      expect(startsAt(availability)).toEqual(["09:00", "10:00"]);
    },
  );

  it("makes a DAY_OFF exception prohibit all work", () => {
    const availability = calculateMasterAvailability({
      weeklyWorkIntervals: [interval("09:00", "18:00")],
      scheduleException: { type: "DAY_OFF" },
      candidateStarts: quarterHourStarts("09:00", "18:00"),
      durationMinutes: 30,
    });

    expect(availability.workingIntervals).toEqual([]);
    expect(availability.slots).toEqual([]);
  });

  it("uses CUSTOM_HOURS instead of weekly work and still subtracts weekly breaks", () => {
    const availability = calculateMasterAvailability({
      weeklyWorkIntervals: [interval("09:00", "12:00")],
      weeklyBreakIntervals: [interval("14:00", "14:30")],
      scheduleException: {
        type: "CUSTOM_HOURS",
        intervals: [interval("13:00", "15:00")],
      },
      candidateStarts: quarterHourStarts("13:00", "15:00"),
      durationMinutes: 30,
    });

    expect(availability.workingIntervals).toEqual([interval("13:00", "15:00")]);
    expect(startsAt(availability)).toEqual(["13:00", "13:15", "13:30", "14:30"]);
  });
});
