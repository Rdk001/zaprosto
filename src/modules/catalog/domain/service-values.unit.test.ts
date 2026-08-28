import { describe, expect, it } from "vitest";

import { positivePriceKopecksSchema, serviceDurationMinutesSchema } from "./service-values";

describe("service values", () => {
  it("accepts a positive price", () => {
    expect(positivePriceKopecksSchema.parse(2_500)).toBe(2_500);
  });

  it.each([0, -1])("rejects a non-positive price: %s", (price) => {
    expect(positivePriceKopecksSchema.safeParse(price).success).toBe(false);
  });

  it.each([5, 30, 75])("accepts an exact positive integer duration: %s", (duration) => {
    expect(serviceDurationMinutesSchema.parse(duration)).toBe(duration);
  });

  it.each([0, -15, 30.5])("rejects an invalid duration: %s", (duration) => {
    expect(serviceDurationMinutesSchema.safeParse(duration).success).toBe(false);
  });
});
