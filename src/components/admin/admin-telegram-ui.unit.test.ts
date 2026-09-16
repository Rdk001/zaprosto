import { describe, expect, it } from "vitest";

import {
  createAdminTelegramUiModel,
  isCurrentAdminTelegramRequest,
  mapAdminTelegramIssueFailure,
  readIssuedAdminTelegramLink,
} from "./admin-telegram-ui";

const raw = "x".repeat(43);
const expiresAt = new Date("2030-01-01T00:30:00.000Z");

describe("Admin Telegram UI state helpers", () => {
  it("accepts only an exact admin deep link and rejects appointment credentials", () => {
    expect(
      readIssuedAdminTelegramLink({
        deepLink: `https://t.me/zaprosto_test_bot?start=a_${raw}`,
        expiresAt,
      }),
    ).toEqual({
      url: `https://t.me/zaprosto_test_bot?start=a_${raw}`,
      expiresAt,
    });
    expect(
      readIssuedAdminTelegramLink({
        deepLink: `https://t.me/zaprosto_test_bot?start=c_${raw}`,
        expiresAt,
      }),
    ).toBeNull();
    expect(
      readIssuedAdminTelegramLink({
        deepLink: `https://evil.example/zaprosto_test_bot?start=a_${raw}`,
        expiresAt,
      }),
    ).toBeNull();
    expect(
      readIssuedAdminTelegramLink({
        deepLink: `https://t.me/zaprosto_test_bot?start=a_${raw}&extra=1`,
        expiresAt,
      }),
    ).toBeNull();
  });

  it("rejects stale async responses", () => {
    expect(isCurrentAdminTelegramRequest(4, 5)).toBe(false);
    expect(isCurrentAdminTelegramRequest(5, 5)).toBe(true);
  });

  it("maps issue outcomes without exposing internal codes", () => {
    expect(mapAdminTelegramIssueFailure("ALREADY_CONNECTED")).toMatchObject({ refresh: true });
    expect(mapAdminTelegramIssueFailure("TELEGRAM_NOT_READY")).toMatchObject({
      nextState: "UNAVAILABLE",
    });
    expect(mapAdminTelegramIssueFailure("RATE_LIMITED").message).toContain("подождите");
    expect(mapAdminTelegramIssueFailure("UNAUTHORIZED").unauthorized).toBe(true);
    expect(mapAdminTelegramIssueFailure("UNAVAILABLE").message).not.toContain("UNAVAILABLE");
  });

  it("starts every mount without a raw link or disconnect confirmation", () => {
    expect(createAdminTelegramUiModel("AVAILABLE")).toEqual({
      state: "AVAILABLE",
      link: null,
      confirmingDisconnect: false,
    });
    expect(createAdminTelegramUiModel("AVAILABLE").link).toBeNull();
  });
});
