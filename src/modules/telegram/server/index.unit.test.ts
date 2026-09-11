import { describe, expect, it } from "vitest";

describe("Telegram production entrypoint", () => {
  it("импортируется в обычном Node runtime без Next server-only sentinel", async () => {
    const entrypoint = await import("./index");

    expect(Object.keys(entrypoint).sort()).toEqual([
      "TelegramBotApiError",
      "TelegramBotStateError",
      "TelegramBotStateRepository",
      "TelegramLinkRepository",
      "TelegramLinkRepositoryError",
      "TelegramLinkService",
      "TelegramLinkServiceError",
      "TelegramStartProcessorError",
      "createTelegramBotApi",
      "createTelegramFetchTransport",
      "parseTelegramRuntimeConfiguration",
      "parseTelegramStartCommand",
      "processTelegramStart",
      "verifyTelegramBotReadiness",
    ]);
    expect(entrypoint).not.toHaveProperty("FakeTelegramTransport");
    expect(entrypoint).not.toHaveProperty("TelegramTransport");
    expect(entrypoint).not.toHaveProperty("botToken");
  });
});
