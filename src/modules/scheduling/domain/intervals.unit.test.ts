import { describe, expect, it } from "vitest";

import {
  generateAvailabilitySlots,
  intervalsOverlap,
  normalizeIntervals,
  subtractIntervals,
  type TimeInterval,
} from "./intervals";

function at(time: string): Date {
  return new Date(`2030-01-01T${time}:00.000Z`);
}

function interval(startsAt: string, endsAt: string): TimeInterval {
  return { startsAt: at(startsAt), endsAt: at(endsAt) };
}

function slotStarts(slots: readonly TimeInterval[]): string[] {
  return slots.map(({ startsAt }) => startsAt.toISOString().slice(11, 16));
}

describe("half-open scheduling intervals", () => {
  it("normalizes overlapping and continuous working intervals", () => {
    expect(
      normalizeIntervals([
        interval("10:00", "11:00"),
        interval("09:00", "10:15"),
        interval("11:00", "12:00"),
      ]),
    ).toEqual([interval("09:00", "12:00")]);
  });

  it("does not treat intervals touching only at a boundary as overlapping", () => {
    expect(intervalsOverlap(interval("09:00", "10:00"), interval("10:00", "11:00"))).toBe(false);
  });

  it("subtracts a partial break and a break covering the whole work interval", () => {
    expect(subtractIntervals([interval("09:00", "12:00")], [interval("10:00", "10:30")])).toEqual([
      interval("09:00", "10:00"),
      interval("10:30", "12:00"),
    ]);
    expect(subtractIntervals([interval("09:00", "12:00")], [interval("08:00", "13:00")])).toEqual(
      [],
    );
  });
});

describe("availability slot generation", () => {
  it("generates a working interval without obstacles", () => {
    expect(
      slotStarts(
        generateAvailabilitySlots({
          workingIntervals: [interval("09:00", "10:00")],
          durationMinutes: 30,
        }),
      ),
    ).toEqual(["09:00", "09:15", "09:30"]);
  });

  it("supports several working intervals", () => {
    expect(
      slotStarts(
        generateAvailabilitySlots({
          workingIntervals: [interval("09:00", "10:00"), interval("14:00", "15:00")],
          durationMinutes: 30,
        }),
      ),
    ).toEqual(["09:00", "09:15", "09:30", "14:00", "14:15", "14:30"]);
  });

  it("removes starts whose service intersects a partial break", () => {
    expect(
      slotStarts(
        generateAvailabilitySlots({
          workingIntervals: [interval("09:00", "10:00")],
          unavailableIntervals: [interval("09:20", "09:40")],
          durationMinutes: 15,
        }),
      ),
    ).toEqual(["09:00", "09:45"]);
  });

  it("accounts for an existing appointment inside working time", () => {
    expect(
      slotStarts(
        generateAvailabilitySlots({
          workingIntervals: [interval("09:00", "11:00")],
          unavailableIntervals: [interval("09:30", "10:00")],
          durationMinutes: 30,
        }),
      ),
    ).toEqual(["09:00", "10:00", "10:15", "10:30"]);
  });

  it("allows an appointment to touch the candidate only at its boundary", () => {
    expect(
      slotStarts(
        generateAvailabilitySlots({
          workingIntervals: [interval("09:00", "11:00")],
          unavailableIntervals: [interval("09:30", "10:00")],
          durationMinutes: 30,
        }),
      ),
    ).toContain("10:00");
  });

  it("keeps a non-15-minute service duration exact", () => {
    const slots = generateAvailabilitySlots({
      workingIntervals: [interval("09:00", "10:00")],
      durationMinutes: 20,
    });

    expect(slotStarts(slots)).toEqual(["09:00", "09:15", "09:30"]);
    expect(slots[1]?.endsAt.toISOString().slice(11, 16)).toBe("09:35");
  });

  it("rejects a start when the service does not fit completely", () => {
    expect(
      generateAvailabilitySlots({
        workingIntervals: [interval("09:00", "09:19")],
        durationMinutes: 20,
      }),
    ).toEqual([]);
  });

  it("does not offer past starts on the current day", () => {
    expect(
      slotStarts(
        generateAvailabilitySlots({
          workingIntervals: [interval("09:00", "10:00")],
          durationMinutes: 15,
          earliestStart: at("09:07"),
        }),
      ),
    ).toEqual(["09:15", "09:30", "09:45"]);
  });

  it("does not restart a supplied slot grid after an unavailable interval", () => {
    expect(
      slotStarts(
        generateAvailabilitySlots({
          workingIntervals: [interval("09:00", "11:00")],
          unavailableIntervals: [interval("09:20", "09:40")],
          candidateStarts: [at("09:00"), at("09:15"), at("09:30"), at("09:45"), at("10:00")],
          durationMinutes: 15,
        }),
      ),
    ).toEqual(["09:00", "09:45", "10:00"]);
  });
});
