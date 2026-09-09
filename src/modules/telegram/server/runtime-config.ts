import { isTelegramBotUsername } from "../domain/config-contract";

const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const MIN_POLL_TIMEOUT_SECONDS = 5;
const MAX_POLL_TIMEOUT_SECONDS = 50;

export const TELEGRAM_RUNTIME_CONFIG_ERROR_CODES = [
  "BOT_TOKEN_REQUIRED",
  "BOT_USERNAME_REQUIRED",
  "CONFIG_UNAUTHORIZED",
  "BOT_USERNAME_INVALID",
  "POLL_TIMEOUT_INVALID",
] as const;

export type TelegramRuntimeConfigErrorCode = (typeof TELEGRAM_RUNTIME_CONFIG_ERROR_CODES)[number];

export type TelegramEnvironment = Readonly<
  Partial<
    Record<
      "TELEGRAM_BOT_TOKEN" | "TELEGRAM_BOT_USERNAME" | "TELEGRAM_POLL_TIMEOUT_SECONDS",
      string | undefined
    >
  >
>;

export type TelegramRuntimeConfiguration =
  | { kind: "DISABLED"; pollTimeoutSeconds: 30 }
  | { kind: "INCOMPLETE" | "INVALID"; reasonCode: TelegramRuntimeConfigErrorCode }
  | {
      kind: "ENABLED";
      botToken: string;
      botUsername: string;
      pollTimeoutSeconds: number;
    };

function invalid(reasonCode: TelegramRuntimeConfigErrorCode): TelegramRuntimeConfiguration {
  return { kind: "INVALID", reasonCode };
}

export function parseTelegramRuntimeConfiguration(
  environment: TelegramEnvironment = process.env as TelegramEnvironment,
): TelegramRuntimeConfiguration {
  const token = environment.TELEGRAM_BOT_TOKEN;
  const username = environment.TELEGRAM_BOT_USERNAME;

  if (token === undefined && username === undefined) {
    return { kind: "DISABLED", pollTimeoutSeconds: DEFAULT_POLL_TIMEOUT_SECONDS };
  }
  if (token !== undefined && !BOT_TOKEN_PATTERN.test(token)) {
    return invalid("CONFIG_UNAUTHORIZED");
  }
  if (username !== undefined && !isTelegramBotUsername(username)) {
    return invalid("BOT_USERNAME_INVALID");
  }
  if (token === undefined) {
    return { kind: "INCOMPLETE", reasonCode: "BOT_TOKEN_REQUIRED" };
  }
  if (username === undefined) {
    return { kind: "INCOMPLETE", reasonCode: "BOT_USERNAME_REQUIRED" };
  }

  const rawTimeout = environment.TELEGRAM_POLL_TIMEOUT_SECONDS;
  const pollTimeoutSeconds =
    rawTimeout === undefined ? DEFAULT_POLL_TIMEOUT_SECONDS : Number(rawTimeout);
  if (
    (rawTimeout !== undefined && !/^\d+$/.test(rawTimeout)) ||
    !Number.isSafeInteger(pollTimeoutSeconds) ||
    pollTimeoutSeconds < MIN_POLL_TIMEOUT_SECONDS ||
    pollTimeoutSeconds > MAX_POLL_TIMEOUT_SECONDS
  ) {
    return invalid("POLL_TIMEOUT_INVALID");
  }

  return { kind: "ENABLED", botToken: token, botUsername: username, pollTimeoutSeconds };
}
