import { describe, expect, it } from "vitest";

import {
  isCurrentTelegramRequest,
  mapTelegramIssueFailure,
  readIssuedTelegramLink,
  visibleTelegramLink,
} from "./appointment-telegram-ui";

const tokenA = "A".repeat(43);
const tokenB = "B".repeat(43);

describe("Appointment Telegram UI state helpers", () => {
  it("rejects stale responses and hides a deep link after the fragment token changes", () => {
    expect(isCurrentTelegramRequest(4, 5)).toBe(false);
    const link = readIssuedTelegramLink(
      {
        deepLink: `https://t.me/zaprosto_test_bot?start=c_${"x".repeat(43)}`,
        expiresAt: new Date("2030-01-01T00:30:00.000Z"),
      },
      tokenA,
    );
    expect(link).not.toBeNull();
    expect(visibleTelegramLink(link, tokenA)).toBe(link);
    expect(visibleTelegramLink(link, tokenB)).toBeNull();
  });

  it("accepts only the exact safe Telegram deep-link shape", () => {
    const expiresAt = new Date("2030-01-01T00:30:00.000Z");
    expect(
      readIssuedTelegramLink(
        {
          deepLink: `https://evil.example/zaprosto_test_bot?start=c_${"x".repeat(43)}`,
          expiresAt,
        },
        tokenA,
      ),
    ).toBeNull();
    expect(
      readIssuedTelegramLink(
        {
          deepLink: `https://t.me/zaprosto_test_bot?start=c_${"x".repeat(43)}&extra=1`,
          expiresAt,
        },
        tokenA,
      ),
    ).toBeNull();
  });

  it("maps issue outcomes without exposing internal codes", () => {
    expect(mapTelegramIssueFailure("ALREADY_CONNECTED")).toMatchObject({ refresh: true });
    expect(mapTelegramIssueFailure("TELEGRAM_NOT_READY")).toEqual({
      nextState: "UNAVAILABLE",
      refresh: false,
      message: "",
    });
    expect(mapTelegramIssueFailure("APPOINTMENT_NOT_ELIGIBLE").nextState).toBe("UNAVAILABLE");
    expect(mapTelegramIssueFailure("RATE_LIMITED").message).toContain("подождите");
    expect(mapTelegramIssueFailure("UNAVAILABLE").message).not.toContain("UNAVAILABLE");
  });
});
