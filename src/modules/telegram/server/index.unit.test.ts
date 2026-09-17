import { describe, expect, it } from "vitest";

describe("Telegram production entrypoint", () => {
  it("импортируется в обычном Node runtime без Next server-only sentinel", async () => {
    const entrypoint = await import("./index");

    expect(Object.keys(entrypoint).sort()).toEqual([
      "AppointmentTelegramRepository",
      "AppointmentTelegramRepositoryError",
      "AppointmentTelegramService",
      "PostgresTelegramPollingLeaderSource",
      "PrismaTelegramPollingStore",
      "TELEGRAM_POLLING_ADVISORY_LOCK_KEY",
      "TelegramBotApiError",
      "TelegramBotStateError",
      "TelegramBotStateRepository",
      "TelegramDeliveryAttempt",
      "TelegramDeliveryPreflight",
      "TelegramDeliveryPreflightError",
      "TelegramDeliveryRateGate",
      "TelegramDeliveryRateGateError",
      "TelegramLinkRepository",
      "TelegramLinkRepositoryError",
      "TelegramLinkService",
      "TelegramLinkServiceError",
      "TelegramPollingOrchestrator",
      "TelegramPollingStoreError",
      "TelegramStartProcessorError",
      "calculateTelegramPollingBackoffMs",
      "createTelegramBotApi",
      "createTelegramFetchTransport",
      "parseTelegramRuntimeConfiguration",
      "parseTelegramStartCommand",
      "processTelegramStart",
      "processTelegramUpdateBatch",
      "registerTelegramWorkerPoolErrorHandler",
      "verifyTelegramBotReadiness",
    ]);
    expect(entrypoint).not.toHaveProperty("FakeTelegramTransport");
    expect(entrypoint).not.toHaveProperty("TelegramTransport");
    expect(entrypoint).not.toHaveProperty("botToken");
  });
});
