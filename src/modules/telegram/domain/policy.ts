export const TELEGRAM_POLICY = {
  linkTokenRandomBytes: 32,
  linkTokenTtlMs: 30 * 60 * 1000,
  startParameterMaxCharacters: 64,
  payloadVersion: 1,
  maxSerializedPayloadBytes: 16 * 1024,
  maxAttempts: 6,
  claimBatchSize: 20,
  leaseDurationMs: 60 * 1000,
  retryBaseDelayMs: 30 * 1000,
  retryMaxDelayMs: 15 * 60 * 1000,
  retryJitterMin: 0.5,
  retryJitterMax: 1,
  maxRetryAfterSeconds: 86_400,
  reminderGraceMs: 15 * 60 * 1000,
  globalSendStartsPerSecond: 25,
  perChatSendStartsPerSecond: 1,
  linkIssuance: {
    windowMs: 15 * 60 * 1000,
    maxAttemptsPerTarget: 5,
    maxAttemptsPerInstallation: 20,
  },
} as const;

export type TelegramPolicy = typeof TELEGRAM_POLICY;
