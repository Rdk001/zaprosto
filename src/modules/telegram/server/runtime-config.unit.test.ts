import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseTelegramRuntimeConfiguration, type TelegramEnvironment } from "./runtime-config";

const tokenCanary = "123456:TELEGRAM_BOT_TOKEN_CANARY_06_3A";
const validEnvironment = {
  TELEGRAM_BOT_TOKEN: tokenCanary,
  TELEGRAM_BOT_USERNAME: "Zaprosto_Test_Bot",
} satisfies TelegramEnvironment;

describe("Telegram runtime configuration", () => {
  it("treats two absent required variables as disabled with the default timeout", () => {
    expect(parseTelegramRuntimeConfiguration({})).toEqual({
      kind: "DISABLED",
      pollTimeoutSeconds: 30,
    });
  });

  it("distinguishes a missing username from disabled configuration", () => {
    expect(parseTelegramRuntimeConfiguration({ TELEGRAM_BOT_TOKEN: tokenCanary })).toEqual({
      kind: "INCOMPLETE",
      reasonCode: "BOT_USERNAME_REQUIRED",
    });
  });

  it("distinguishes a missing token from disabled configuration", () => {
    expect(
      parseTelegramRuntimeConfiguration({ TELEGRAM_BOT_USERNAME: "Zaprosto_Test_Bot" }),
    ).toEqual({ kind: "INCOMPLETE", reasonCode: "BOT_TOKEN_REQUIRED" });
  });

  it.each([
    [{ ...validEnvironment, TELEGRAM_BOT_TOKEN: "" }, "CONFIG_UNAUTHORIZED"],
    [{ ...validEnvironment, TELEGRAM_BOT_TOKEN: "   " }, "CONFIG_UNAUTHORIZED"],
    [{ ...validEnvironment, TELEGRAM_BOT_USERNAME: "" }, "BOT_USERNAME_INVALID"],
    [{ ...validEnvironment, TELEGRAM_BOT_USERNAME: "   " }, "BOT_USERNAME_INVALID"],
    [{ ...validEnvironment, TELEGRAM_BOT_USERNAME: "@Zaprosto_Test_Bot" }, "BOT_USERNAME_INVALID"],
  ] as const)("rejects empty, whitespace, and @-prefixed values", (environment, reasonCode) => {
    expect(parseTelegramRuntimeConfiguration(environment)).toEqual({
      kind: "INVALID",
      reasonCode,
    });
  });

  it("returns one typed enabled configuration", () => {
    expect(parseTelegramRuntimeConfiguration(validEnvironment)).toEqual({
      kind: "ENABLED",
      botToken: tokenCanary,
      botUsername: "Zaprosto_Test_Bot",
      pollTimeoutSeconds: 30,
    });
  });

  it("uses timeout 30 when the optional variable is absent", () => {
    expect(parseTelegramRuntimeConfiguration(validEnvironment)).toMatchObject({
      kind: "ENABLED",
      pollTimeoutSeconds: 30,
    });
  });

  it.each([5, 50])("accepts timeout boundary %i", (pollTimeoutSeconds) => {
    expect(
      parseTelegramRuntimeConfiguration({
        ...validEnvironment,
        TELEGRAM_POLL_TIMEOUT_SECONDS: String(pollTimeoutSeconds),
      }),
    ).toMatchObject({ kind: "ENABLED", pollTimeoutSeconds });
  });

  it.each(["4", "51", "5.5", "NaN", "", " 30 "])("rejects unsafe timeout %j", (timeout) => {
    expect(
      parseTelegramRuntimeConfiguration({
        ...validEnvironment,
        TELEGRAM_POLL_TIMEOUT_SECONDS: timeout,
      }),
    ).toEqual({ kind: "INVALID", reasonCode: "POLL_TIMEOUT_INVALID" });
  });

  it("keeps credential canaries out of documentation and committed examples", () => {
    const webhookCanary = "https://example.invalid/WEBHOOK_URL_CANARY_06_3A";
    const documentation = [
      ".env.example",
      "docs/telegram-runtime.md",
      "docs/progress.md",
      "docs/telegram-notifications-plan.md",
      "docs/decisions/0014-telegram-notifications.md",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(documentation).not.toContain(tokenCanary);
    expect(documentation).not.toContain(webhookCanary);
  });
});
