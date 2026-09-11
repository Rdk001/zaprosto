import { isTelegramBotUsername } from "../domain/config-contract";
import { hashTelegramLinkToken, parseTelegramLinkToken } from "../domain/link-token";
import type { TelegramUpdate } from "./bot-api";

export type ParsedTelegramStart = Readonly<{
  updateId: bigint;
  telegramUserId: bigint;
  telegramChatId: bigint;
  purpose: "APPOINTMENT" | "ADMIN_USER";
  tokenHash: string;
}>;

export type TelegramStartParseResult =
  Readonly<{ kind: "IGNORED" }> | Readonly<{ kind: "PARSED"; value: ParsedTelegramStart }>;

const IGNORED = { kind: "IGNORED" } as const;
const START_COMMAND = /^\/start(?:@([A-Za-z][A-Za-z0-9_]{4,31}))? ([A-Za-z0-9_-]+)$/;

export function parseTelegramStartCommand(
  update: TelegramUpdate,
  configuredBotUsername: string,
): TelegramStartParseResult {
  if (!isTelegramBotUsername(configuredBotUsername) || update.updateId < 0n) return IGNORED;

  const message = update.message;
  const sender = message?.from;
  if (
    !message ||
    message.chat.type !== "private" ||
    !sender ||
    sender.isBot !== false ||
    message.chat.id <= 0n ||
    sender.id <= 0n ||
    message.chat.id !== sender.id ||
    message.text === undefined ||
    message.text.includes("\n") ||
    message.text.includes("\r")
  ) {
    return IGNORED;
  }

  const match = START_COMMAND.exec(message.text);
  if (!match) return IGNORED;
  const mentionedUsername = match[1];
  if (
    mentionedUsername !== undefined &&
    mentionedUsername.toLowerCase() !== configuredBotUsername.toLowerCase()
  ) {
    return IGNORED;
  }

  const startParameter = match[2];
  const parsed = parseTelegramLinkToken(startParameter);
  if (!parsed.ok) return IGNORED;
  const hashed = hashTelegramLinkToken(parsed.value.startParameter);
  if (!hashed.ok || hashed.purpose !== parsed.value.purpose) return IGNORED;

  return {
    kind: "PARSED",
    value: {
      updateId: update.updateId,
      telegramUserId: sender.id,
      telegramChatId: message.chat.id,
      purpose: hashed.purpose,
      tokenHash: hashed.hash,
    },
  };
}
