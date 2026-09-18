import { describe, expect, it, vi } from "vitest";

import type { TelegramSafeErrorCode } from "../domain/safe-error";
import type { TelegramBotApi } from "./bot-api";
import type { TelegramBotStateSnapshot, TelegramBotStateStore } from "./bot-state-repository";
import { verifyTelegramDeliveryReadiness } from "./delivery-readiness-service";
import type { TelegramRuntimeConfiguration } from "./runtime-config";

const enabled = {
  kind: "ENABLED",
  botToken: "123456:DELIVERY_READINESS_TOKEN_123456",
  botUsername: "Zaprosto_Test_Bot",
  pollTimeoutSeconds: 30,
} as const satisfies TelegramRuntimeConfiguration;

class MemoryState implements TelegramBotStateStore {
  current: TelegramBotStateSnapshot;
  readonly setError = vi.fn(async (code: TelegramSafeErrorCode) => {
    this.current.lastErrorCode = code;
  });
  readonly recordVerifiedIdentity = vi.fn(
    async (input: { botUserId: bigint; botUsername: string; verifiedAt: Date }) => {
      if (
        this.current.botUserId !== null &&
        (this.current.botUserId !== input.botUserId ||
          this.current.botUsername?.toLowerCase() !== input.botUsername.toLowerCase())
      ) {
        return "BOT_IDENTITY_MISMATCH" as const;
      }
      this.current = {
        ...this.current,
        botUserId: input.botUserId,
        botUsername: input.botUsername,
        lastVerifiedAt: input.verifiedAt,
        lastErrorCode: null,
      };
      return "VERIFIED" as const;
    },
  );

  constructor(overrides: Partial<TelegramBotStateSnapshot> = {}) {
    this.current = {
      botUserId: 42n,
      botUsername: "zaprosto_test_bot",
      nextUpdateId: 0n,
      lastVerifiedAt: null,
      lastPollAt: null,
      lastErrorCode: null,
      ...overrides,
    };
  }

  async getState() {
    return { ...this.current };
  }
}

function api(identity = { id: 42n, username: "ZAPROSTO_TEST_BOT" }) {
  return {
    getMe: vi.fn(async () => identity),
    getWebhookInfo: vi.fn(async () => {
      throw new Error("getWebhookInfo must not be called");
    }),
    deleteWebhook: vi.fn(),
    getUpdates: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as TelegramBotApi;
}

describe("Telegram delivery readiness", () => {
  it("verifies the current saved identity using getMe only", async () => {
    const state = new MemoryState();
    const telegram = api();

    await expect(
      verifyTelegramDeliveryReadiness({ configuration: enabled, api: telegram, state }),
    ).resolves.toEqual({
      status: "VERIFIED",
      verified: true,
      botUsername: enabled.botUsername,
    });
    expect(telegram.getMe).toHaveBeenCalledOnce();
    expect(telegram.getWebhookInfo).not.toHaveBeenCalled();
    expect(state.recordVerifiedIdentity).not.toHaveBeenCalled();
  });

  it("does not let WEBHOOK_ACTIVE from polling block verified outbound delivery", async () => {
    const state = new MemoryState({ lastErrorCode: "WEBHOOK_ACTIVE" });
    await expect(
      verifyTelegramDeliveryReadiness({ configuration: enabled, api: api(), state }),
    ).resolves.toMatchObject({ status: "VERIFIED" });
    expect(state.current.lastErrorCode).toBe("WEBHOOK_ACTIVE");
  });

  it("atomically records the first valid identity", async () => {
    const state = new MemoryState({ botUserId: null, botUsername: null });
    const verifiedAt = new Date("2033-01-01T00:00:00.000Z");

    await expect(
      verifyTelegramDeliveryReadiness({
        configuration: enabled,
        api: api(),
        state,
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({ status: "VERIFIED" });
    expect(state.recordVerifiedIdentity).toHaveBeenCalledWith({
      botUserId: 42n,
      botUsername: "ZAPROSTO_TEST_BOT",
      verifiedAt,
    });
  });

  it.each([
    [api({ id: 42n, username: "another_bot" }), new MemoryState()],
    [api({ id: 43n, username: "Zaprosto_Test_Bot" }), new MemoryState()],
    [api(), new MemoryState({ botUsername: "stored_other_bot" })],
  ])("rejects configured or stored identity mismatch", async (telegram, state) => {
    await expect(
      verifyTelegramDeliveryReadiness({ configuration: enabled, api: telegram, state }),
    ).resolves.toMatchObject({
      status: "NOT_READY",
      reasonCode: "BOT_IDENTITY_MISMATCH",
    });
    expect(telegram.getWebhookInfo).not.toHaveBeenCalled();
    expect(state.current.lastErrorCode).toBe("BOT_IDENTITY_MISMATCH");
  });

  it.each([
    { kind: "DISABLED", pollTimeoutSeconds: 30 } as const,
    { kind: "INCOMPLETE", reasonCode: "BOT_TOKEN_REQUIRED" } as const,
    { kind: "INVALID", reasonCode: "BOT_USERNAME_INVALID" } as const,
  ])("does not call API for $kind configuration", async (configuration) => {
    const telegram = api();
    const state = new MemoryState();
    await verifyTelegramDeliveryReadiness({ configuration, api: telegram, state });
    expect(telegram.getMe).not.toHaveBeenCalled();
    expect(state.recordVerifiedIdentity).not.toHaveBeenCalled();
  });
});
