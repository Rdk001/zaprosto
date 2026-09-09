import { describe, expect, it } from "vitest";

import type { TelegramWebConfiguration } from "./config-contract";
import { computeTelegramWebReadiness, type TelegramReadinessState } from "./readiness";

const now = new Date("2032-02-01T08:02:00.000Z");
const configuration: TelegramWebConfiguration = {
  kind: "ENABLED",
  botUsername: "Zaprosto_Test_Bot",
};

function readyState(overrides: Partial<TelegramReadinessState> = {}): TelegramReadinessState {
  return {
    botUserId: 5_000_000_001n,
    botUsername: "zaprosto_test_bot",
    lastVerifiedAt: now,
    lastPollAt: now,
    lastErrorCode: null,
    ...overrides,
  };
}

function readiness(
  state: TelegramReadinessState | null,
  config: TelegramWebConfiguration = configuration,
) {
  return computeTelegramWebReadiness({ configuration: config, state, now });
}

describe("Telegram web readiness", () => {
  it("returns a token-free disabled result", () => {
    expect(readiness(null, { kind: "DISABLED" })).toEqual({
      enabled: false,
      ready: false,
      reasonCode: "DISABLED",
    });
  });

  it("preserves the safe reason for invalid web configuration", () => {
    expect(readiness(null, { kind: "INVALID", reasonCode: "BOT_USERNAME_INVALID" })).toEqual({
      enabled: false,
      ready: false,
      reasonCode: "BOT_USERNAME_INVALID",
    });
  });

  it("rejects a forged enabled configuration with an invalid username", () => {
    expect(
      readiness(null, {
        kind: "ENABLED",
        botUsername: "@invalid",
      }),
    ).toEqual({ enabled: false, ready: false, reasonCode: "BOT_USERNAME_INVALID" });
  });

  it("fails closed when singleton state is unavailable", () => {
    expect(readiness(null)).toEqual({
      enabled: true,
      ready: false,
      reasonCode: "STATE_UNAVAILABLE",
      botUsername: "Zaprosto_Test_Bot",
    });
  });

  it("is false when identity or timestamps are null", () => {
    expect(readiness(readyState({ botUserId: null, botUsername: null }))).toMatchObject({
      ready: false,
      reasonCode: "IDENTITY_UNVERIFIED",
    });
    expect(readiness(readyState({ lastVerifiedAt: null, lastPollAt: null }))).toMatchObject({
      ready: false,
      reasonCode: "VERIFICATION_STALE",
    });
  });

  it("requires the saved username to match configuration case-insensitively", () => {
    expect(readiness(readyState({ botUsername: "Another_Bot" }))).toMatchObject({
      ready: false,
      reasonCode: "BOT_USERNAME_MISMATCH",
    });
    expect(readiness(readyState({ botUsername: "ZAPROSTO_TEST_BOT" }))).toMatchObject({
      ready: true,
      reasonCode: "READY",
    });
  });

  it("returns only an allowlisted global error", () => {
    expect(readiness(readyState({ lastErrorCode: "WEBHOOK_ACTIVE" }))).toMatchObject({
      ready: false,
      reasonCode: "WEBHOOK_ACTIVE",
    });
    expect(readiness(readyState({ lastErrorCode: "unsafe free-form error" }))).toMatchObject({
      ready: false,
      reasonCode: "STATE_INVALID",
    });
  });

  it("is false when lastVerifiedAt is older than two minutes", () => {
    expect(
      readiness(readyState({ lastVerifiedAt: new Date(now.getTime() - 2 * 60_000 - 1) })),
    ).toMatchObject({ ready: false, reasonCode: "VERIFICATION_STALE" });
  });

  it("is false when lastPollAt is older than two minutes", () => {
    expect(
      readiness(readyState({ lastPollAt: new Date(now.getTime() - 2 * 60_000 - 1) })),
    ).toMatchObject({ ready: false, reasonCode: "POLLING_STALE" });
  });

  it("treats the exact two-minute boundary as fresh", () => {
    const boundary = new Date(now.getTime() - 2 * 60_000);
    expect(readiness(readyState({ lastVerifiedAt: boundary, lastPollAt: boundary }))).toEqual({
      enabled: true,
      ready: true,
      reasonCode: "READY",
      botUsername: "Zaprosto_Test_Bot",
    });
  });

  it("fails closed for future timestamps", () => {
    expect(readiness(readyState({ lastPollAt: new Date(now.getTime() + 1) }))).toMatchObject({
      ready: false,
      reasonCode: "POLLING_STALE",
    });
  });

  it("is true only with the complete verified and fresh state", () => {
    expect(readiness(readyState())).toEqual({
      enabled: true,
      ready: true,
      reasonCode: "READY",
      botUsername: "Zaprosto_Test_Bot",
    });
  });
});
