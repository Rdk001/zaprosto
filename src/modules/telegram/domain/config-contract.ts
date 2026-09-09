export const TELEGRAM_WEB_CONFIG_ERROR_CODES = ["BOT_USERNAME_INVALID"] as const;

export type TelegramWebConfigErrorCode = (typeof TELEGRAM_WEB_CONFIG_ERROR_CODES)[number];

const BOT_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export function isTelegramBotUsername(value: unknown): value is string {
  return typeof value === "string" && BOT_USERNAME_PATTERN.test(value);
}

export type TelegramWebEnvironment = Readonly<
  Partial<Record<"TELEGRAM_BOT_USERNAME", string | undefined>>
>;

export type TelegramWebConfiguration =
  | { kind: "DISABLED" }
  | { kind: "INVALID"; reasonCode: TelegramWebConfigErrorCode }
  | { kind: "ENABLED"; botUsername: string };

export function parseTelegramWebConfiguration(
  environment: TelegramWebEnvironment,
): TelegramWebConfiguration {
  const username = environment.TELEGRAM_BOT_USERNAME;
  if (username === undefined) {
    return { kind: "DISABLED" };
  }
  if (!isTelegramBotUsername(username)) {
    return { kind: "INVALID", reasonCode: "BOT_USERNAME_INVALID" };
  }
  return { kind: "ENABLED", botUsername: username };
}
