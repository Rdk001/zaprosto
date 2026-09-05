export const TELEGRAM_SAFE_ERROR_CODES = [
  "NETWORK_UNREACHABLE",
  "DELIVERY_OUTCOME_UNKNOWN",
  "TELEGRAM_RATE_LIMIT",
  "TELEGRAM_5XX",
  "INVALID_REQUEST",
  "CHAT_NOT_FOUND",
  "BOT_BLOCKED",
  "CHAT_WRITE_FORBIDDEN",
  "TELEGRAM_USER_DEACTIVATED",
  "CONFIG_UNAUTHORIZED",
  "BOT_IDENTITY_MISMATCH",
  "WEBHOOK_ACTIVE",
  "POLL_OFFSET_CONFLICT",
  "POLLING_CONFLICT",
  "RESPONSE_INVALID",
  "RESPONSE_TOO_LARGE",
  "PAYLOAD_VERSION_UNSUPPORTED",
  "REMINDER_EXPIRED",
  "CONNECTION_INACTIVE",
  "APPOINTMENT_NOT_SCHEDULED",
  "VISIT_MISMATCH",
] as const;

export type TelegramSafeErrorCode = (typeof TELEGRAM_SAFE_ERROR_CODES)[number];

export const TELEGRAM_ADAPTER_ERROR_CODES = [
  "NETWORK_UNREACHABLE",
  "DELIVERY_OUTCOME_UNKNOWN",
  "TELEGRAM_RATE_LIMIT",
  "TELEGRAM_5XX",
  "INVALID_REQUEST",
  "CHAT_NOT_FOUND",
  "BOT_BLOCKED",
  "CHAT_WRITE_FORBIDDEN",
  "TELEGRAM_USER_DEACTIVATED",
  "CONFIG_UNAUTHORIZED",
  "RESPONSE_INVALID",
  "RESPONSE_TOO_LARGE",
] as const satisfies readonly TelegramSafeErrorCode[];

export type TelegramAdapterErrorCode = (typeof TELEGRAM_ADAPTER_ERROR_CODES)[number];

export type TelegramDomainErrorCode =
  "INVALID_DEDUPE_INPUT" | "INVALID_RANDOM_SOURCE" | "INVALID_RETRY_INPUT";

export class TelegramDomainError extends Error {
  readonly code: TelegramDomainErrorCode;

  constructor(code: TelegramDomainErrorCode) {
    super(code);
    this.name = "TelegramDomainError";
    this.code = code;
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}
