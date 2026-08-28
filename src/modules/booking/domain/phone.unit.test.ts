import { describe, expect, it } from "vitest";

import { normalizeRussianPhone } from "./phone";

describe("normalizeRussianPhone", () => {
  it.each([
    ["+7 (999) 123-45-67", "+79991234567"],
    ["8 999 123 45 67", "+79991234567"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRussianPhone(input)).toBe(expected);
  });

  it.each(["9991234567", "79991234567", "+1 999 123-45-67"])(
    "rejects a number without an allowed prefix: %s",
    (input) => {
      expect(() => normalizeRussianPhone(input)).toThrow();
    },
  );
});
