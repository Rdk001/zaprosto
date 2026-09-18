import { describe, expect, it, vi } from "vitest";

import { TelegramBotReplacementService } from "./bot-replacement-service";

const configuration = {
  kind: "ENABLED" as const,
  botToken: "123456:SECRET_CANARY_12345678901234567890",
  botUsername: "Replacement_Test_Bot",
  pollTimeoutSeconds: 30,
};

function service(input: {
  actual?: { id: bigint; username: string } | Error;
  state?: { botUserId: bigint | null; botUsername: string | null } | null;
}) {
  const actual = input.actual ?? { id: 22n, username: configuration.botUsername };
  const api = {
    getMe: vi.fn(async () => {
      if (actual instanceof Error) throw actual;
      return actual;
    }),
  };
  const database = {
    telegramBotState: {
      findUnique: vi.fn(async () =>
        input.state === undefined ? { botUserId: 11n, botUsername: "Old_Bot" } : input.state,
      ),
    },
  };
  return new TelegramBotReplacementService(database as never, api, configuration);
}

describe("TelegramBotReplacementService preflight", () => {
  it("accepts a configured username that differs only by case", async () => {
    await expect(
      service({ actual: { id: 22n, username: "replacement_test_bot" } }).preflight(),
    ).resolves.toEqual({ status: "READY" });
  });

  it("rejects a genuinely different configured username", async () => {
    await expect(
      service({ actual: { id: 22n, username: "Different_Test_Bot" } }).preflight(),
    ).rejects.toMatchObject({ code: "BOT_USERNAME_MISMATCH" });
  });

  it("maps raw getMe failures to a safe code without a nested cause", async () => {
    const canary = "raw URL token response canary";
    const error = await service({ actual: new Error(canary) })
      .preflight()
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: "BOT_VERIFICATION_FAILED" });
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(configuration.botToken);
  });

  it.each([null, { botUserId: null, botUsername: null }, { botUserId: 11n, botUsername: null }])(
    "refuses an uninitialized bot state",
    async (state) => {
      await expect(service({ state }).preflight()).rejects.toMatchObject({
        code: "BOT_STATE_UNINITIALIZED",
      });
    },
  );

  it("returns bounded NO_CHANGE without ids or usernames", async () => {
    const result = await service({
      state: { botUserId: 22n, botUsername: configuration.botUsername },
    }).preflight();
    expect(result).toEqual({ status: "NO_CHANGE" });
    expect(Object.keys(result)).toEqual(["status"]);
  });

  it("returns NO_CHANGE when the stored username differs only by case", async () => {
    await expect(
      service({
        actual: { id: 22n, username: "replacement_test_bot" },
        state: { botUserId: 22n, botUsername: "REPLACEMENT_TEST_BOT" },
      }).preflight(),
    ).resolves.toEqual({ status: "NO_CHANGE" });
  });

  it("does not use destructive replacement for a username change on the same bot id", async () => {
    await expect(
      service({ state: { botUserId: 22n, botUsername: "Previous_Test_Bot" } }).preflight(),
    ).rejects.toMatchObject({ code: "SAME_BOT_USERNAME_CHANGED" });
  });
});
