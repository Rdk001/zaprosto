import { describe, expect, it } from "vitest";

import { TelegramLinkRepositoryError, telegramLinkTargetRateLimitKey } from "./link-repository";

const id = "00000000-0000-4000-8000-000000000001";

describe("Telegram link repository security helpers", () => {
  it("uses stable purpose-separated opaque target keys", () => {
    const client = telegramLinkTargetRateLimitKey("APPOINTMENT", id);
    const admin = telegramLinkTargetRateLimitKey("ADMIN_USER", id);
    expect(client).toMatch(/^telegram-link:target:appointment:v1:[0-9a-f]{64}$/);
    expect(admin).toMatch(/^telegram-link:target:admin_user:v1:[0-9a-f]{64}$/);
    expect(client).not.toBe(admin);
    expect(client).not.toContain(id);
    expect(admin).not.toContain(id);
  });

  it("rejects invalid ids without reflecting them", () => {
    const canary = "SESSION_OR_CANCELLATION_CANARY";
    const error = (() => {
      try {
        telegramLinkTargetRateLimitKey("APPOINTMENT", canary);
      } catch (value) {
        return value;
      }
    })();
    expect(error).toBeInstanceOf(TelegramLinkRepositoryError);
    expect(JSON.stringify(error)).not.toContain(canary);
  });
});
