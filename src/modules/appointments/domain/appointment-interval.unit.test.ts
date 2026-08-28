import { describe, expect, it } from "vitest";

import { appointmentIntervalSchema } from "./appointment-interval";

describe("appointmentIntervalSchema", () => {
  it("accepts starts_at < ends_at without rounding to 15 minutes", () => {
    const interval = {
      startsAt: new Date("2026-09-01T07:02:00.000Z"),
      endsAt: new Date("2026-09-01T07:37:00.000Z"),
    };

    expect(appointmentIntervalSchema.parse(interval)).toEqual(interval);
  });

  it.each([
    ["2026-09-01T08:00:00.000Z", "2026-09-01T08:00:00.000Z"],
    ["2026-09-01T09:00:00.000Z", "2026-09-01T08:00:00.000Z"],
  ])("rejects starts_at >= ends_at", (startsAt, endsAt) => {
    expect(
      appointmentIntervalSchema.safeParse({
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
      }).success,
    ).toBe(false);
  });
});
