import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseTelegramWebConfiguration,
  type TelegramWebConfiguration,
  type TelegramWebEnvironment,
} from "./config-contract";
import { computeTelegramWebReadiness } from "./readiness";

const tokenCanary = "123456:TELEGRAM_BOT_TOKEN_CANARY_06_3A";

describe("Telegram web-safe configuration", () => {
  it("accepts an input contract whose only key is TELEGRAM_BOT_USERNAME", () => {
    type ForbiddenInputKeys = Extract<
      keyof TelegramWebEnvironment,
      "TELEGRAM_BOT_TOKEN" | "TELEGRAM_POLL_TIMEOUT_SECONDS"
    >;
    type EnabledOutputKeys = keyof Extract<TelegramWebConfiguration, { kind: "ENABLED" }>;
    type ForbiddenOutputKeys = Extract<EnabledOutputKeys, "botToken" | "pollTimeoutSeconds">;

    expectTypeOf<keyof TelegramWebEnvironment>().toEqualTypeOf<"TELEGRAM_BOT_USERNAME">();
    expectTypeOf<ForbiddenInputKeys>().toEqualTypeOf<never>();
    expectTypeOf<ForbiddenOutputKeys>().toEqualTypeOf<never>();
  });

  it("treats an absent username as safely disabled", () => {
    expect(parseTelegramWebConfiguration({})).toEqual({ kind: "DISABLED" });
  });

  it.each(["", "   ", "@Zaprosto_Test_Bot", "bad"])(
    "returns an allowlisted reason for invalid username %j",
    (username) => {
      expect(parseTelegramWebConfiguration({ TELEGRAM_BOT_USERNAME: username })).toEqual({
        kind: "INVALID",
        reasonCode: "BOT_USERNAME_INVALID",
      });
    },
  );

  it("passes a valid username to readiness without worker settings", () => {
    const configuration = parseTelegramWebConfiguration({
      TELEGRAM_BOT_USERNAME: "Zaprosto_Test_Bot",
    });
    const now = new Date("2032-02-01T08:02:00.000Z");

    expect(
      computeTelegramWebReadiness({
        configuration,
        state: {
          botUserId: 5_000_000_001n,
          botUsername: "zaprosto_test_bot",
          lastVerifiedAt: now,
          lastPollAt: now,
          lastErrorCode: null,
        },
        now,
      }),
    ).toEqual({
      enabled: true,
      ready: true,
      reasonCode: "READY",
      botUsername: "Zaprosto_Test_Bot",
    });
  });

  it("keeps worker-only fields and token canaries out of the serialized DTO", () => {
    const configuration = parseTelegramWebConfiguration({
      TELEGRAM_BOT_USERNAME: "Zaprosto_Test_Bot",
    });
    const serialized = JSON.stringify(configuration);

    expect(serialized).not.toContain(tokenCanary);
    expect(configuration).not.toHaveProperty("botToken");
    expect(configuration).not.toHaveProperty("pollTimeoutSeconds");
  });
});
