import { TELEGRAM_POLICY } from "./policy";
import { TelegramDomainError, type TelegramAdapterErrorCode } from "./safe-error";

export type TelegramRetryClock = () => Date;
export type TelegramRetryRandom = () => number;

export type TelegramRetryDecision =
  | {
      kind: "RETRY";
      delayMs: number;
      nextAttemptAt: Date;
      source: "BACKOFF" | "RETRY_AFTER";
    }
  | {
      kind: "TERMINAL";
      reason: "ATTEMPTS_EXHAUSTED" | "RETRY_AFTER_TOO_LARGE" | "DEADLINE_EXCEEDED";
    };

function checkedAttempts(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > TELEGRAM_POLICY.maxAttempts) {
    throw new TelegramDomainError("INVALID_RETRY_INPUT");
  }
  return attempts;
}

function checkedRandom(random: TelegramRetryRandom): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TelegramDomainError("INVALID_RETRY_INPUT");
  }
  return value;
}

function checkedNow(clock: TelegramRetryClock): Date {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TelegramDomainError("INVALID_RETRY_INPUT");
  }
  return now;
}

export function calculateTelegramBackoffDelayMs(
  attempts: number,
  random: TelegramRetryRandom = Math.random,
): number {
  const checked = checkedAttempts(attempts);
  const cappedBase = Math.min(
    TELEGRAM_POLICY.retryBaseDelayMs * 2 ** (checked - 1),
    TELEGRAM_POLICY.retryMaxDelayMs,
  );
  const jitterFactor =
    TELEGRAM_POLICY.retryJitterMin +
    checkedRandom(random) * (TELEGRAM_POLICY.retryJitterMax - TELEGRAM_POLICY.retryJitterMin);

  return Math.max(0, Math.round(cappedBase * jitterFactor));
}

function isValidDeadline(value: Date | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function retryDecision(
  delayMs: number,
  source: "BACKOFF" | "RETRY_AFTER",
  clock: TelegramRetryClock,
  expiresAt?: Date,
): TelegramRetryDecision {
  const now = checkedNow(clock);
  if (expiresAt !== undefined && !isValidDeadline(expiresAt)) {
    throw new TelegramDomainError("INVALID_RETRY_INPUT");
  }

  const nextTimestamp = now.getTime() + delayMs;
  const nextAttemptAt = new Date(nextTimestamp);
  if (
    !Number.isSafeInteger(nextTimestamp) ||
    !Number.isFinite(nextTimestamp) ||
    !Number.isFinite(nextAttemptAt.getTime())
  ) {
    throw new TelegramDomainError("INVALID_RETRY_INPUT");
  }

  if (expiresAt && nextTimestamp > expiresAt.getTime()) {
    return { kind: "TERMINAL", reason: "DEADLINE_EXCEEDED" };
  }

  return { kind: "RETRY", delayMs, nextAttemptAt, source };
}

export function decideTelegramRetry(input: {
  attempts: number;
  errorCode: TelegramAdapterErrorCode;
  retryAfterSeconds?: unknown;
  expiresAt?: Date;
  clock?: TelegramRetryClock;
  random?: TelegramRetryRandom;
}): TelegramRetryDecision {
  const attempts = checkedAttempts(input.attempts);
  const clock = input.clock ?? (() => new Date());
  const random = input.random ?? Math.random;

  if (attempts >= TELEGRAM_POLICY.maxAttempts) {
    return { kind: "TERMINAL", reason: "ATTEMPTS_EXHAUSTED" };
  }

  if (input.errorCode === "TELEGRAM_RATE_LIMIT") {
    const retryAfter = input.retryAfterSeconds;
    if (
      typeof retryAfter === "number" &&
      Number.isSafeInteger(retryAfter) &&
      retryAfter > TELEGRAM_POLICY.maxRetryAfterSeconds
    ) {
      return { kind: "TERMINAL", reason: "RETRY_AFTER_TOO_LARGE" };
    }

    if (
      typeof retryAfter === "number" &&
      Number.isSafeInteger(retryAfter) &&
      retryAfter > 0 &&
      retryAfter <= TELEGRAM_POLICY.maxRetryAfterSeconds
    ) {
      const jitterMs = Math.round(checkedRandom(random) * 1000);
      return retryDecision(retryAfter * 1000 + jitterMs, "RETRY_AFTER", clock, input.expiresAt);
    }
  }

  return retryDecision(
    calculateTelegramBackoffDelayMs(attempts, random),
    "BACKOFF",
    clock,
    input.expiresAt,
  );
}
