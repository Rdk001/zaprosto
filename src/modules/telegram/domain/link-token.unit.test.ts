import { describe, expect, it, vi } from "vitest";

import { TelegramLinkPurpose as PrismaTelegramLinkPurpose } from "../../../generated/prisma/enums";
import { TELEGRAM_POLICY } from "./policy";
import {
  generateTelegramLinkToken,
  hashTelegramLinkToken,
  parseTelegramLinkToken,
  TELEGRAM_LINK_PURPOSES,
} from "./link-token";

const ZERO_RANDOM_PART = "A".repeat(43);
const APPOINTMENT_TOKEN = `c_${ZERO_RANDOM_PART}`;
const ADMIN_USER_TOKEN = `a_${ZERO_RANDOM_PART}`;

describe("Telegram link tokens", () => {
  it("совпадает по значениям purpose с Prisma enum", () => {
    expect(TELEGRAM_LINK_PURPOSES).toEqual([
      PrismaTelegramLinkPurpose.APPOINTMENT,
      PrismaTelegramLinkPurpose.ADMIN_USER,
    ]);
  });

  it.each([
    ["APPOINTMENT", "c_"],
    ["ADMIN_USER", "a_"],
  ] as const)("генерирует 32 random bytes для %s", (purpose, prefix) => {
    const random = vi.fn((size: number) => new Uint8Array(size).fill(0xab));
    const generated = generateTelegramLinkToken(purpose, random);

    expect(random).toHaveBeenCalledExactlyOnceWith(TELEGRAM_POLICY.linkTokenRandomBytes);
    expect(generated.purpose).toBe(purpose);
    expect(generated.startParameter).toHaveLength(45);
    expect(generated.startParameter.startsWith(prefix)).toBe(true);
    expect(generated.startParameter).not.toContain("=");
    expect(generated.startParameter.slice(2)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(generated.startParameter.slice(2), "base64url")).toHaveLength(32);
    expect(generated.startParameter.length).toBeLessThanOrEqual(
      TELEGRAM_POLICY.startParameterMaxCharacters,
    );
  });

  it("сохраняет все 256 бит внедрённой энтропии", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const generated = generateTelegramLinkToken("APPOINTMENT", () => bytes);

    expect(Buffer.from(generated.startParameter.slice(2), "base64url")).toEqual(Buffer.from(bytes));
  });

  it("разделяет purpose и даёт стабильные lowercase SHA-256 vectors", () => {
    expect(hashTelegramLinkToken(APPOINTMENT_TOKEN)).toEqual({
      ok: true,
      purpose: "APPOINTMENT",
      hash: "8611c3617157ac64455ea001d7247df013ffe41ef43f55e997bc8ae80b900bf3",
    });
    expect(hashTelegramLinkToken(ADMIN_USER_TOKEN)).toEqual({
      ok: true,
      purpose: "ADMIN_USER",
      hash: "c0f90b9286ea627aeee3014a0708e5f5c6836ceba8e1968f56cf3605b7612b0b",
    });
    expect(hashTelegramLinkToken(APPOINTMENT_TOKEN)).not.toEqual(
      hashTelegramLinkToken(ADMIN_USER_TOKEN),
    );
  });

  it.each([
    null,
    42,
    "",
    `x_${ZERO_RANDOM_PART}`,
    `C_${ZERO_RANDOM_PART}`,
    `c_${"A".repeat(42)}`,
    `c_${"A".repeat(44)}`,
    `c_${"A".repeat(42)}B`,
    `c_${"A".repeat(42)}=`,
    `c_${"A".repeat(42)}/`,
    `a_${"я".repeat(43)}`,
  ])("отклоняет malformed start parameter до hash lookup", (input) => {
    expect(parseTelegramLinkToken(input)).toEqual({ ok: false, code: "MALFORMED_LINK_TOKEN" });
    expect(hashTelegramLinkToken(input)).toEqual({ ok: false, code: "MALFORMED_LINK_TOKEN" });
  });

  it("не копирует raw token в ошибку или диагностический DTO", () => {
    const canary = `c_${"Z".repeat(43)}_RAW_TOKEN_CANARY`;
    const parsed = parseTelegramLinkToken(canary);
    const hashed = hashTelegramLinkToken(canary);

    expect(JSON.stringify({ parsed, hashed })).not.toContain(canary);
    expect(JSON.stringify({ parsed, hashed })).toBe(
      '{"parsed":{"ok":false,"code":"MALFORMED_LINK_TOKEN"},"hashed":{"ok":false,"code":"MALFORMED_LINK_TOKEN"}}',
    );
  });

  it("отклоняет ослабляющий random source безопасной ошибкой", () => {
    expect(() => generateTelegramLinkToken("APPOINTMENT", () => new Uint8Array(31))).toThrow(
      "INVALID_RANDOM_SOURCE",
    );
  });
});
