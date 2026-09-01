import { describe, expect, it } from "vitest";

import { prepareBookingAttempt } from "../server/booking-security";
import {
  ADMIN_ATTEMPT_STORAGE_KEY,
  ADMIN_CONTACT_TTL_MS,
  readAdminAttempt,
  writeAdminAttempt,
  type SavedAdminAttempt,
} from "./admin-attempt-storage";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const input = {
  ...prepareBookingAttempt(),
  serviceId: "de000000-0000-4000-8000-000000000001",
  expectedServiceTerms: "a".repeat(64),
  expectedBusinessContext: "b".repeat(64),
  master: { type: "ANY" as const },
  localDate: "2026-09-01",
  startsAt: "2026-09-01T10:00:00+03:00",
  clientName: "Вымышленный",
  clientPhone: "8 (999) 000-00-00",
  confirmed: true as const,
};

describe("admin booking attempt storage", () => {
  it("restores the exact pending payload for a safe replay", () => {
    const target = storage();
    const pending: SavedAdminAttempt = { state: "pending", input, savedAt: 100 };
    writeAdminAttempt(target, pending);
    expect(readAdminAttempt(target, 200)).toEqual(pending);
  });

  it("removes contact data after 30 minutes but retains the protected lookup token", () => {
    const target = storage();
    writeAdminAttempt(target, { state: "pending", input, savedAt: 100 });
    expect(readAdminAttempt(target, 100 + ADMIN_CONTACT_TTL_MS)).toEqual({
      state: "expired",
      token: input.cancellationToken,
    });
    expect(target.getItem(ADMIN_ATTEMPT_STORAGE_KEY)).not.toContain(input.clientPhone);
    expect(target.getItem(ADMIN_ATTEMPT_STORAGE_KEY)).not.toContain(input.clientName);
  });

  it("blocks a new attempt for damaged or unverifiable values", () => {
    for (const value of [
      "{broken",
      JSON.stringify({ state: "pending", savedAt: 100, input: { ...input, extra: true } }),
    ]) {
      const target = storage();
      target.setItem(ADMIN_ATTEMPT_STORAGE_KEY, value);
      expect(readAdminAttempt(target, 150)).toEqual({ state: "damaged" });
    }
  });

  it("treats a future-dated pending value as expired and retains only its token", () => {
    const target = storage();
    target.setItem(
      ADMIN_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ state: "pending", savedAt: 200, input }),
    );
    expect(readAdminAttempt(target, 150)).toEqual({
      state: "expired",
      token: input.cancellationToken,
    });
  });

  it("surfaces storage failures before a mutation can be sent", () => {
    const target = storage();
    target.setItem = () => {
      throw new Error("quota");
    };
    expect(() => writeAdminAttempt(target, { state: "pending", input, savedAt: 100 })).toThrow();
  });
});
