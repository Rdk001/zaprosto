import { describe, expect, it } from "vitest";

import { TELEGRAM_POLICY } from "./policy";

describe("TELEGRAM_POLICY", () => {
  it("фиксирует утверждённые runtime-константы 06.2", () => {
    expect(TELEGRAM_POLICY).toEqual({
      linkTokenRandomBytes: 32,
      linkTokenTtlMs: 1_800_000,
      startParameterMaxCharacters: 64,
      payloadVersion: 1,
      maxSerializedPayloadBytes: 16_384,
      maxAttempts: 6,
      claimBatchSize: 20,
      leaseDurationMs: 60_000,
      retryBaseDelayMs: 30_000,
      retryMaxDelayMs: 900_000,
      retryJitterMin: 0.5,
      retryJitterMax: 1,
      maxRetryAfterSeconds: 86_400,
      reminderGraceMs: 900_000,
      globalSendStartsPerSecond: 25,
      perChatSendStartsPerSecond: 1,
      linkIssuance: {
        windowMs: 900_000,
        maxAttemptsPerTarget: 5,
        maxAttemptsPerInstallation: 20,
      },
    });
  });
});
