import { describe, expect, it } from "vitest";

describe("Telegram production entrypoint", () => {
  it("импортируется в обычном Node runtime без Next server-only sentinel", async () => {
    const entrypoint = await import("./index");

    expect(Object.keys(entrypoint).sort()).toEqual([
      "AppointmentTelegramRepository",
      "AppointmentTelegramRepositoryError",
      "AppointmentTelegramService",
      "PostgresTelegramMaintenanceLockSource",
      "PostgresTelegramPollingLeaderSource",
      "PrismaTelegramPollingStore",
      "TELEGRAM_DELIVERY_ORCHESTRATOR_DEFAULTS",
      "TELEGRAM_DELIVERY_READINESS_RECHECK_MS",
      "TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY",
      "TELEGRAM_POLLING_ADVISORY_LOCK_KEY",
      "TELEGRAM_REPLACEMENT_CONFIRMATION",
      "TELEGRAM_WORKER_DELIVERY_CONCURRENCY",
      "TELEGRAM_WORKER_POOL_MAX",
      "TelegramBotApiError",
      "TelegramBotReplacementCommandError",
      "TelegramBotReplacementError",
      "TelegramBotReplacementService",
      "TelegramBotStateError",
      "TelegramBotStateRepository",
      "TelegramDeliveryAttempt",
      "TelegramDeliveryOrchestrator",
      "TelegramDeliveryOrchestratorError",
      "TelegramDeliveryPreflight",
      "TelegramDeliveryPreflightError",
      "TelegramDeliveryRateGate",
      "TelegramDeliveryRateGateError",
      "TelegramDeliverySupervisor",
      "TelegramDeliverySupervisorError",
      "TelegramLinkRepository",
      "TelegramLinkRepositoryError",
      "TelegramLinkService",
      "TelegramLinkServiceError",
      "TelegramMaintenanceLockError",
      "TelegramOutboxDispatcher",
      "TelegramOutboxDispatcherError",
      "TelegramPollingOrchestrator",
      "TelegramPollingStoreError",
      "TelegramStartProcessorError",
      "TelegramWorkerRuntime",
      "TelegramWorkerRuntimeError",
      "calculateTelegramPollingBackoffMs",
      "createTelegramBotApi",
      "createTelegramFetchTransport",
      "createTelegramWorkerRuntime",
      "parseTelegramRuntimeConfiguration",
      "parseTelegramStartCommand",
      "processTelegramStart",
      "processTelegramUpdateBatch",
      "registerTelegramWorkerPoolErrorHandler",
      "requireEnabledTelegramReplacementConfiguration",
      "runTelegramBotReplacementCommand",
      "runTelegramWorkerProcess",
      "telegramBotReplacementCommandSafeCode",
      "verifyTelegramBotReadiness",
      "verifyTelegramDeliveryReadiness",
    ]);
    expect(entrypoint).not.toHaveProperty("FakeTelegramTransport");
    expect(entrypoint).not.toHaveProperty("TelegramTransport");
    expect(entrypoint).not.toHaveProperty("botToken");
  });
});
