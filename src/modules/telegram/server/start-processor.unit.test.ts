import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "../../../generated/prisma/client";
import type { ParsedTelegramStart } from "./start-command-parser";
import { processTelegramStart, TelegramStartProcessorError } from "./start-processor";

const input: ParsedTelegramStart = {
  updateId: 77n,
  telegramUserId: 88n,
  telegramChatId: 88n,
  purpose: "APPOINTMENT",
  tokenHash: "a".repeat(64),
};

describe("Telegram start processor safe boundary", () => {
  async function expectInvalidInput(value: unknown) {
    const error = await processTelegramStart({} as Prisma.TransactionClient, value).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TelegramStartProcessorError);
    expect(error).toMatchObject({
      code: "START_PROCESSOR_INPUT_INVALID",
      message: "START_PROCESSOR_INPUT_INVALID",
    });
    expect(JSON.stringify(error)).toBe(
      '{"name":"TelegramStartProcessorError","code":"START_PROCESSOR_INPUT_INVALID"}',
    );
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("input-canary");
  }

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "input-canary"],
    ["number", 42],
    ["boolean", true],
    ["bigint", 42n],
    ["array", []],
    ["function", () => undefined],
    ["empty object", {}],
  ])("rejects runtime %s input safely", async (_label, value) => {
    await expectInvalidInput(value);
  });

  it.each(Object.keys(input))("rejects input missing the %s field", async (field) => {
    const incomplete = { ...input } as Record<string, unknown>;
    delete incomplete[field];

    await expectInvalidInput(incomplete);
  });

  it.each([
    ["negative update id", { ...input, updateId: -1n }],
    ["update id above PostgreSQL bigint", { ...input, updateId: 9_223_372_036_854_775_808n }],
    ["negative Telegram ids", { ...input, telegramUserId: -1n, telegramChatId: -1n }],
    [
      "Telegram ids above PostgreSQL bigint",
      {
        ...input,
        telegramUserId: 9_223_372_036_854_775_808n,
        telegramChatId: 9_223_372_036_854_775_808n,
      },
    ],
  ])("rejects %s", async (_label, value) => {
    await expectInvalidInput(value);
  });

  it("отклоняет DTO с дополнительным credential-полем без его отражения", async () => {
    const canary = "RAW_START_PARAMETER_CANARY";
    const error = await processTelegramStart(
      {} as Prisma.TransactionClient,
      {
        ...input,
        rawToken: canary,
      } as ParsedTelegramStart,
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TelegramStartProcessorError);
    expect(error).toMatchObject({ code: "START_PROCESSOR_INPUT_INVALID" });
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  it("заменяет driver/SQL cause на закрытую storage error", async () => {
    const canary = "SQL_DRIVER_CAUSE_TOKEN_HASH_CANARY";
    const tx = {
      $queryRaw: vi.fn(async () => Promise.reject(new Error(canary))),
    } as unknown as Prisma.TransactionClient;
    const error = await processTelegramStart(tx, input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TelegramStartProcessorError);
    if (!(error instanceof TelegramStartProcessorError)) throw new Error("Expected safe error");
    expect(error).toMatchObject({ code: "START_PROCESSOR_STORAGE_FAILURE" });
    expect(error.message).toBe("START_PROCESSOR_STORAGE_FAILURE");
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(input.tokenHash);
    expect(error).not.toHaveProperty("cause");
  });

  it("возвращает закрытый ALREADY_PROCESSED outcome", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ processed: true }]);
    const outcome = await processTelegramStart(
      { $queryRaw: query } as unknown as Prisma.TransactionClient,
      input,
    );
    expect(outcome).toEqual({ kind: "ALREADY_PROCESSED" });
    expect(Object.keys(outcome)).toEqual(["kind"]);
    expect(JSON.stringify(outcome)).not.toContain(input.tokenHash);
    expect(JSON.stringify(outcome)).not.toContain("77");
    expect(JSON.stringify(outcome)).not.toContain("88");
  });

  it("возвращает закрытый REJECTED outcome без причины", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ processed: false }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ now: new Date("2030-01-01T00:00:00.000Z") }]);
    const createMany = vi.fn(async () => ({ count: 1 }));
    const outcome = await processTelegramStart(
      {
        $queryRaw: query,
        notificationOutbox: { createMany },
      } as unknown as Prisma.TransactionClient,
      input,
    );
    expect(outcome).toEqual({ kind: "REJECTED" });
    expect(Object.keys(outcome)).toEqual(["kind"]);
    expect(outcome).not.toHaveProperty("reason");
    expect(JSON.stringify(outcome)).not.toContain(input.tokenHash);
  });
});
