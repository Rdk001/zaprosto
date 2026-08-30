import { describe, expect, it } from "vitest";

import {
  combineMasterAvailability,
  selectAnyMasterForSlot,
  type AnyMasterAvailabilityInput,
} from "./any-master";
import type { TimeInterval } from "./intervals";

function interval(startsAt: string, endsAt: string): TimeInterval {
  return {
    startsAt: new Date(`2030-01-01T${startsAt}:00.000Z`),
    endsAt: new Date(`2030-01-01T${endsAt}:00.000Z`),
  };
}

const selectedSlot = interval("09:00", "09:30");

function master(
  masterId: string,
  overrides: Partial<AnyMasterAvailabilityInput> = {},
): AnyMasterAvailabilityInput {
  return {
    masterId,
    displayOrder: 0,
    isActive: true,
    isAssigned: true,
    dailyLoad: { bookedMinutes: 0, appointmentCount: 0 },
    slots: [selectedSlot],
    ...overrides,
  };
}

describe("combined any-master availability", () => {
  it("combines several masters and keeps all free candidates", () => {
    const combined = combineMasterAvailability([
      master("master-b", {
        displayOrder: 2,
        slots: [selectedSlot, interval("09:15", "09:45")],
      }),
      master("master-a", { displayOrder: 1 }),
    ]);

    expect(combined).toEqual([
      { ...selectedSlot, candidateMasterIds: ["master-a", "master-b"] },
      {
        ...interval("09:15", "09:45"),
        candidateMasterIds: ["master-b"],
      },
    ]);
  });

  it("excludes inactive and unassigned masters", () => {
    const combined = combineMasterAvailability([
      master("active"),
      master("inactive", { isActive: false }),
      master("unassigned", { isAssigned: false }),
    ]);

    expect(combined[0]?.candidateMasterIds).toEqual(["active"]);
  });
});

describe("any-master selection", () => {
  it("chooses the fewest booked minutes", () => {
    const selected = selectAnyMasterForSlot(
      [
        master("busy", {
          dailyLoad: { bookedMinutes: 90, appointmentCount: 1 },
        }),
        master("free", {
          dailyLoad: { bookedMinutes: 30, appointmentCount: 1 },
        }),
      ],
      selectedSlot,
    );

    expect(selected?.masterId).toBe("free");
  });

  it("uses appointment count as the second tie-breaker", () => {
    const selected = selectAnyMasterForSlot(
      [
        master("two", {
          dailyLoad: { bookedMinutes: 60, appointmentCount: 2 },
        }),
        master("one", {
          dailyLoad: { bookedMinutes: 60, appointmentCount: 1 },
        }),
      ],
      selectedSlot,
    );

    expect(selected?.masterId).toBe("one");
  });

  it("uses displayOrder as the third tie-breaker", () => {
    const selected = selectAnyMasterForSlot(
      [master("later", { displayOrder: 2 }), master("earlier", { displayOrder: 1 })],
      selectedSlot,
    );

    expect(selected?.masterId).toBe("earlier");
  });

  it("uses id as the final deterministic tie-breaker", () => {
    const selected = selectAnyMasterForSlot([master("master-b"), master("master-a")], selectedSlot);

    expect(selected?.masterId).toBe("master-a");
  });

  it("selects only among masters free for the whole chosen interval", () => {
    const selected = selectAnyMasterForSlot(
      [
        master("lower-load-but-busy", {
          slots: [interval("10:00", "10:30")],
        }),
        master("available", {
          dailyLoad: { bookedMinutes: 120, appointmentCount: 2 },
        }),
      ],
      selectedSlot,
    );

    expect(selected?.masterId).toBe("available");
  });

  it("does not select an inactive or unassigned master", () => {
    const selected = selectAnyMasterForSlot(
      [
        master("inactive", { isActive: false }),
        master("unassigned", { isAssigned: false }),
        master("eligible", {
          dailyLoad: { bookedMinutes: 90, appointmentCount: 1 },
        }),
      ],
      selectedSlot,
    );

    expect(selected?.masterId).toBe("eligible");
  });
});
