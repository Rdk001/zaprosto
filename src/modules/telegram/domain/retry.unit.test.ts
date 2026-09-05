import { describe, expect, it, vi } from "vitest";

import { calculateTelegramBackoffDelayMs, decideTelegramRetry } from "./retry";

describe("Telegram retry primitives", () => {
  it.each([
    [1, 15_000, 30_000],
    [2, 30_000, 60_000],
    [3, 60_000, 120_000],
    [4, 120_000, 240_000],
    [5, 240_000, 480_000],
    [6, 450_000, 900_000],
  ])("attempt %i использует jitter 0.5–1.0 и cap", (attempts, lower, upper) => {
    expect(calculateTelegramBackoffDelayMs(attempts, () => 0)).toBe(lower);
    expect(calculateTelegramBackoffDelayMs(attempts, () => 1)).toBe(upper);
  });

  it("использует внедрённые clock и RNG", () => {
    const clock = vi.fn(() => new Date("2026-09-05T10:00:00.000Z"));
    const random = vi.fn(() => 0.25);
    const decision = decideTelegramRetry({
      attempts: 1,
      errorCode: "TELEGRAM_5XX",
      clock,
      random,
    });

    expect(clock).toHaveBeenCalledOnce();
    expect(random).toHaveBeenCalledOnce();
    expect(decision).toEqual({
      kind: "RETRY",
      delayMs: 18_750,
      nextAttemptAt: new Date("2026-09-05T10:00:18.750Z"),
      source: "BACKOFF",
    });
  });

  it.each([undefined, 0, -1, 1.5, "30", Number.NaN])(
    "невалидный retry_after %s использует обычный backoff",
    (retryAfterSeconds) => {
      expect(
        decideTelegramRetry({
          attempts: 2,
          errorCode: "TELEGRAM_RATE_LIMIT",
          retryAfterSeconds,
          clock: () => new Date(0),
          random: () => 0,
        }),
      ).toEqual({
        kind: "RETRY",
        delayMs: 30_000,
        nextAttemptAt: new Date(30_000),
        source: "BACKOFF",
      });
    },
  );

  it("принимает retry_after=86400 и добавляет jitter 0–1 секунду", () => {
    expect(
      decideTelegramRetry({
        attempts: 1,
        errorCode: "TELEGRAM_RATE_LIMIT",
        retryAfterSeconds: 86_400,
        clock: () => new Date(0),
        random: () => 1,
      }),
    ).toEqual({
      kind: "RETRY",
      delayMs: 86_401_000,
      nextAttemptAt: new Date(86_401_000),
      source: "RETRY_AFTER",
    });
  });

  it("retry_after выше 86400 даёт terminal-решение без раннего retry", () => {
    expect(
      decideTelegramRetry({
        attempts: 1,
        errorCode: "TELEGRAM_RATE_LIMIT",
        retryAfterSeconds: 86_401,
      }),
    ).toEqual({ kind: "TERMINAL", reason: "RETRY_AFTER_TOO_LARGE" });
  });

  it("не назначает retry после expiresAt, но разрешает точную границу", () => {
    expect(
      decideTelegramRetry({
        attempts: 1,
        errorCode: "TELEGRAM_5XX",
        expiresAt: new Date(14_999),
        clock: () => new Date(0),
        random: () => 0,
      }),
    ).toEqual({ kind: "TERMINAL", reason: "DEADLINE_EXCEEDED" });
    expect(
      decideTelegramRetry({
        attempts: 1,
        errorCode: "TELEGRAM_5XX",
        expiresAt: new Date(15_000),
        clock: () => new Date(0),
        random: () => 0,
      }),
    ).toMatchObject({ kind: "RETRY", nextAttemptAt: new Date(15_000) });
  });

  it("после шестой попытки возвращает terminal-решение", () => {
    expect(decideTelegramRetry({ attempts: 6, errorCode: "TELEGRAM_5XX" })).toEqual({
      kind: "TERMINAL",
      reason: "ATTEMPTS_EXHAUSTED",
    });
  });

  it.each([0, 7, 1.5, Number.MAX_SAFE_INTEGER])("отклоняет attempts=%s", (attempts) => {
    expect(() => calculateTelegramBackoffDelayMs(attempts, () => 0)).toThrow("INVALID_RETRY_INPUT");
  });

  it.each([-0.1, 1.1, Number.NaN])("отклоняет RNG=%s", (value) => {
    expect(() => calculateTelegramBackoffDelayMs(1, () => value)).toThrow("INVALID_RETRY_INPUT");
  });
});
