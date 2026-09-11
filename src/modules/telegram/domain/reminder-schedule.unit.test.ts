import { describe, expect, it } from "vitest";

import { calculateClientAppointmentReminderSchedule } from "./reminder-schedule";

describe("calculateClientAppointmentReminderSchedule", () => {
  const now = new Date("2026-09-11T09:00:00.000Z");

  it("does not schedule a reminder at the exact two-hour boundary", () => {
    expect(
      calculateClientAppointmentReminderSchedule({
        now,
        startsAt: new Date(now.getTime() + 2 * 60 * 60_000),
      }),
    ).toBeNull();
  });

  it("schedules a reminder one millisecond beyond the boundary", () => {
    expect(
      calculateClientAppointmentReminderSchedule({
        now,
        startsAt: new Date(now.getTime() + 2 * 60 * 60_000 + 1),
      }),
    ).toEqual({
      scheduledAt: new Date(now.getTime() + 1),
      expiresAt: new Date(now.getTime() + 15 * 60_000 + 1),
    });
  });
});
