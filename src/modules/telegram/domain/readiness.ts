import {
  isTelegramBotUsername,
  type TelegramWebConfigErrorCode,
  type TelegramWebConfiguration,
} from "./config-contract";
import { TELEGRAM_POLICY } from "./policy";
import { isTelegramSafeErrorCode, type TelegramSafeErrorCode } from "./safe-error";

export type TelegramReadinessState = {
  botUserId: bigint | null;
  botUsername: string | null;
  lastVerifiedAt: Date | null;
  lastPollAt: Date | null;
  lastErrorCode: string | null;
};

export type TelegramWebReadinessReason =
  | "READY"
  | "DISABLED"
  | "STATE_UNAVAILABLE"
  | "STATE_INVALID"
  | "IDENTITY_UNVERIFIED"
  | "BOT_USERNAME_MISMATCH"
  | "VERIFICATION_STALE"
  | "POLLING_STALE"
  | TelegramWebConfigErrorCode
  | TelegramSafeErrorCode;

export type TelegramWebReadiness = {
  enabled: boolean;
  ready: boolean;
  reasonCode: TelegramWebReadinessReason;
  botUsername?: string;
};

function validTimestamp(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function freshAtBoundary(value: Date, now: Date): boolean {
  const age = now.getTime() - value.getTime();
  return age >= 0 && age <= TELEGRAM_POLICY.readinessFreshnessMs;
}

export function computeTelegramWebReadiness(input: {
  configuration: TelegramWebConfiguration;
  state: TelegramReadinessState | null;
  now: Date;
}): TelegramWebReadiness {
  const { configuration, state, now } = input;

  if (configuration.kind === "DISABLED") {
    return { enabled: false, ready: false, reasonCode: "DISABLED" };
  }
  if (configuration.kind !== "ENABLED") {
    return { enabled: false, ready: false, reasonCode: configuration.reasonCode };
  }
  if (!isTelegramBotUsername(configuration.botUsername)) {
    return { enabled: false, ready: false, reasonCode: "BOT_USERNAME_INVALID" };
  }

  const base = { enabled: true, ready: false, botUsername: configuration.botUsername } as const;
  if (!validTimestamp(now)) {
    return { ...base, reasonCode: "STATE_INVALID" };
  }
  if (state === null) {
    return { ...base, reasonCode: "STATE_UNAVAILABLE" };
  }
  if (
    state.botUserId === null ||
    typeof state.botUserId !== "bigint" ||
    state.botUserId <= 0n ||
    state.botUsername === null ||
    !isTelegramBotUsername(state.botUsername)
  ) {
    return { ...base, reasonCode: "IDENTITY_UNVERIFIED" };
  }
  if (state.botUsername.toLowerCase() !== configuration.botUsername.toLowerCase()) {
    return { ...base, reasonCode: "BOT_USERNAME_MISMATCH" };
  }
  if (state.lastErrorCode !== null) {
    return {
      ...base,
      reasonCode: isTelegramSafeErrorCode(state.lastErrorCode)
        ? state.lastErrorCode
        : "STATE_INVALID",
    };
  }
  if (
    state.lastVerifiedAt === null ||
    !validTimestamp(state.lastVerifiedAt) ||
    !freshAtBoundary(state.lastVerifiedAt, now)
  ) {
    return { ...base, reasonCode: "VERIFICATION_STALE" };
  }
  if (
    state.lastPollAt === null ||
    !validTimestamp(state.lastPollAt) ||
    !freshAtBoundary(state.lastPollAt, now)
  ) {
    return { ...base, reasonCode: "POLLING_STALE" };
  }

  return {
    enabled: true,
    ready: true,
    reasonCode: "READY",
    botUsername: configuration.botUsername,
  };
}
