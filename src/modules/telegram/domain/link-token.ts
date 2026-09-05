import { createHash, randomBytes } from "node:crypto";

import { TELEGRAM_POLICY } from "./policy";
import { TelegramDomainError } from "./safe-error";

export const TELEGRAM_LINK_PURPOSES = ["APPOINTMENT", "ADMIN_USER"] as const;
export type TelegramLinkPurpose = (typeof TELEGRAM_LINK_PURPOSES)[number];

const PURPOSE_CONFIG = {
  APPOINTMENT: {
    prefix: "c_",
    domainSeparator: "zaprosto:telegram-client-link:v1",
  },
  ADMIN_USER: {
    prefix: "a_",
    domainSeparator: "zaprosto:telegram-admin-link:v1",
  },
} as const satisfies Record<
  TelegramLinkPurpose,
  { readonly prefix: string; readonly domainSeparator: string }
>;

const RANDOM_PART_LENGTH = 43;
const START_PARAMETER_LENGTH = 45;
const CANONICAL_32_BYTE_BASE64URL = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export type TelegramStartParameter = string & { readonly __telegramStartParameter: unique symbol };

export type ParsedTelegramLinkToken = {
  purpose: TelegramLinkPurpose;
  startParameter: TelegramStartParameter;
};

export type TelegramLinkTokenParseResult =
  { ok: true; value: ParsedTelegramLinkToken } | { ok: false; code: "MALFORMED_LINK_TOKEN" };

export type TelegramLinkTokenHashResult =
  | { ok: true; purpose: TelegramLinkPurpose; hash: string }
  | { ok: false; code: "MALFORMED_LINK_TOKEN" };

export type TelegramRandomSource = (size: number) => Uint8Array;

function productionRandomSource(size: number): Uint8Array {
  return randomBytes(size);
}

export function generateTelegramLinkToken(
  purpose: TelegramLinkPurpose,
  randomSource: TelegramRandomSource = productionRandomSource,
): ParsedTelegramLinkToken {
  const bytes = randomSource(TELEGRAM_POLICY.linkTokenRandomBytes);

  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TELEGRAM_POLICY.linkTokenRandomBytes) {
    throw new TelegramDomainError("INVALID_RANDOM_SOURCE");
  }

  const randomPart = Buffer.from(bytes).toString("base64url");
  const startParameter = `${PURPOSE_CONFIG[purpose].prefix}${randomPart}`;

  if (
    randomPart.length !== RANDOM_PART_LENGTH ||
    startParameter.length !== START_PARAMETER_LENGTH ||
    startParameter.length > TELEGRAM_POLICY.startParameterMaxCharacters
  ) {
    throw new TelegramDomainError("INVALID_RANDOM_SOURCE");
  }

  return { purpose, startParameter: startParameter as TelegramStartParameter };
}

export function parseTelegramLinkToken(input: unknown): TelegramLinkTokenParseResult {
  if (typeof input !== "string" || input.length !== START_PARAMETER_LENGTH) {
    return { ok: false, code: "MALFORMED_LINK_TOKEN" };
  }

  const purpose = input.startsWith(PURPOSE_CONFIG.APPOINTMENT.prefix)
    ? "APPOINTMENT"
    : input.startsWith(PURPOSE_CONFIG.ADMIN_USER.prefix)
      ? "ADMIN_USER"
      : null;

  if (purpose === null) {
    return { ok: false, code: "MALFORMED_LINK_TOKEN" };
  }

  const randomPart = input.slice(PURPOSE_CONFIG[purpose].prefix.length);
  if (!CANONICAL_32_BYTE_BASE64URL.test(randomPart)) {
    return { ok: false, code: "MALFORMED_LINK_TOKEN" };
  }

  return {
    ok: true,
    value: { purpose, startParameter: input as TelegramStartParameter },
  };
}

export function hashTelegramLinkToken(input: unknown): TelegramLinkTokenHashResult {
  const parsed = parseTelegramLinkToken(input);
  if (!parsed.ok) {
    return parsed;
  }

  const { purpose, startParameter } = parsed.value;
  const hash = createHash("sha256")
    .update(PURPOSE_CONFIG[purpose].domainSeparator, "utf8")
    .update("\0", "utf8")
    .update(startParameter, "utf8")
    .digest("hex");

  return { ok: true, purpose, hash };
}
