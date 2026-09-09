import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../../generated/prisma/client";
import { TelegramBotStateError, TelegramBotStateRepository } from "./bot-state-repository";

describe("TelegramBotState repository boundary", () => {
  it("rejects non-allowlisted errors before database access", async () => {
    const update = vi.fn();
    const repository = new TelegramBotStateRepository({
      telegramBotState: { update },
    } as unknown as PrismaClient);

    await expect(repository.setError("raw Telegram description" as never)).rejects.toMatchObject({
      code: "BOT_STATE_INPUT_INVALID",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects invalid verified identity before opening a transaction", async () => {
    const transaction = vi.fn();
    const repository = new TelegramBotStateRepository({
      $transaction: transaction,
    } as unknown as PrismaClient);

    await expect(
      repository.recordVerifiedIdentity({
        botUserId: 0n,
        botUsername: "@invalid",
        verifiedAt: new Date("invalid"),
      }),
    ).rejects.toMatchObject({ code: "BOT_STATE_INPUT_INVALID" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("replaces driver causes with one safe repository error", async () => {
    const canary = "DATABASE_CAUSE_WITH_BOT_TOKEN_CANARY_06_3A";
    const repository = new TelegramBotStateRepository({
      telegramBotState: {
        findUnique: vi.fn().mockRejectedValue(
          Object.assign(new Error(canary), {
            cause: new Error(canary),
            requestUrl: canary,
            responseBody: canary,
          }),
        ),
      },
    } as unknown as PrismaClient);

    const error = await repository.getState().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TelegramBotStateError);
    expect(error).toMatchObject({
      name: "TelegramBotStateError",
      code: "BOT_STATE_STORAGE_FAILURE",
      message: "BOT_STATE_STORAGE_FAILURE",
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(String(error)).not.toContain(canary);
  });
});
