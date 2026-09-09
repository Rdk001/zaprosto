import { describe, expect, it, vi } from "vitest";

import type { TelegramSafeErrorCode } from "../domain/safe-error";
import { createTelegramBotApi, TelegramBotApiError, type TelegramBotApi } from "./bot-api";
import type { TelegramBotStateSnapshot, TelegramBotStateStore } from "./bot-state-repository";
import { FakeTelegramTransport } from "./fake-transport";
import { verifyTelegramBotReadiness } from "./readiness-service";
import type { TelegramRuntimeConfiguration } from "./runtime-config";

const tokenCanary = "123456:TELEGRAM_BOT_TOKEN_CANARY_06_3A";
const verifiedAt = new Date("2032-02-01T08:00:00.000Z");
const enabledConfiguration: TelegramRuntimeConfiguration = {
  kind: "ENABLED",
  botToken: tokenCanary,
  botUsername: "Zaprosto_Test_Bot",
  pollTimeoutSeconds: 30,
};

class MemoryBotState implements TelegramBotStateStore {
  current: TelegramBotStateSnapshot;

  constructor(overrides: Partial<TelegramBotStateSnapshot> = {}) {
    this.current = {
      botUserId: null,
      botUsername: null,
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

  async setError(code: TelegramSafeErrorCode) {
    this.current.lastErrorCode = code;
  }

  async recordVerifiedIdentity(input: {
    botUserId: bigint;
    botUsername: string;
    verifiedAt: Date;
  }) {
    if (this.current.botUserId !== null) {
      if (
        this.current.botUserId !== input.botUserId ||
        this.current.botUsername === null ||
        this.current.botUsername.toLowerCase() !== input.botUsername.toLowerCase()
      ) {
        this.current.lastErrorCode = "BOT_IDENTITY_MISMATCH";
        return "BOT_IDENTITY_MISMATCH" as const;
      }
      this.current = {
        ...this.current,
        lastVerifiedAt: input.verifiedAt,
        lastErrorCode: null,
      };
      return "VERIFIED" as const;
    }
    this.current = {
      ...this.current,
      botUserId: input.botUserId,
      botUsername: input.botUsername,
      lastVerifiedAt: input.verifiedAt,
      lastErrorCode: null,
    };
    return "VERIFIED" as const;
  }
}

function fakeApi(input: {
  id?: bigint;
  username?: string;
  webhook?: boolean;
  getMeError?: unknown;
  webhookError?: unknown;
}) {
  const getMe = vi.fn(async () => {
    if (input.getMeError !== undefined) throw input.getMeError;
    return { id: input.id ?? 5_000_000_001n, username: input.username ?? "zaprosto_test_bot" };
  });
  const getWebhookInfo = vi.fn(async () => {
    if (input.webhookError !== undefined) throw input.webhookError;
    return {
      hasWebhook: input.webhook ?? false,
      hasCustomCertificate: false,
      pendingUpdateCount: 0,
    };
  });
  const api = {
    getMe,
    getWebhookInfo,
    deleteWebhook: vi.fn(async () => undefined),
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ messageId: 1n })),
  } satisfies TelegramBotApi;
  return { api, getMe, getWebhookInfo };
}

describe("Telegram identity readiness service", () => {
  it.each([
    { kind: "DISABLED", pollTimeoutSeconds: 30 } as const,
    { kind: "INCOMPLETE", reasonCode: "BOT_TOKEN_REQUIRED" } as const,
  ])("does not call Bot API for $kind configuration", async (configuration) => {
    const state = new MemoryBotState();
    const { api, getMe, getWebhookInfo } = fakeApi({});

    await verifyTelegramBotReadiness({ configuration, api, state, clock: () => verifiedAt });

    expect(getMe).not.toHaveBeenCalled();
    expect(getWebhookInfo).not.toHaveBeenCalled();
    expect(state.current.lastErrorCode).toBe(
      configuration.kind === "DISABLED" ? null : "CONFIG_UNAUTHORIZED",
    );
  });

  it("records the first successful identity without inventing a polling heartbeat", async () => {
    const state = new MemoryBotState();
    const { api } = fakeApi({});

    await expect(
      verifyTelegramBotReadiness({
        configuration: enabledConfiguration,
        api,
        state,
        clock: () => verifiedAt,
      }),
    ).resolves.toEqual({
      status: "VERIFIED",
      verified: true,
      botUsername: "Zaprosto_Test_Bot",
    });
    expect(state.current).toEqual({
      botUserId: 5_000_000_001n,
      botUsername: "zaprosto_test_bot",
      nextUpdateId: 0n,
      lastVerifiedAt: verifiedAt,
      lastPollAt: null,
      lastErrorCode: null,
    });
  });

  it("re-verifies the same bot case-insensitively and preserves offset and lastPollAt", async () => {
    const lastPollAt = new Date("2032-02-01T07:59:00.000Z");
    const state = new MemoryBotState({
      botUserId: 5_000_000_001n,
      botUsername: "zaprosto_test_bot",
      nextUpdateId: 9_000_000_123n,
      lastPollAt,
      lastErrorCode: "NETWORK_UNREACHABLE",
    });
    const { api } = fakeApi({ username: "ZAPROSTO_TEST_BOT" });

    await expect(
      verifyTelegramBotReadiness({
        configuration: enabledConfiguration,
        api,
        state,
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({ status: "VERIFIED", verified: true });
    expect(state.current).toMatchObject({
      botUserId: 5_000_000_001n,
      botUsername: "zaprosto_test_bot",
      nextUpdateId: 9_000_000_123n,
      lastVerifiedAt: verifiedAt,
      lastPollAt,
      lastErrorCode: null,
    });
  });

  it("fails closed when the same bot id has a different username", async () => {
    const previousVerifiedAt = new Date("2032-02-01T07:00:00.000Z");
    const lastPollAt = new Date("2032-02-01T07:59:00.000Z");
    const state = new MemoryBotState({
      botUserId: 5_000_000_001n,
      botUsername: "old_case_bot",
      nextUpdateId: 9_000_000_123n,
      lastVerifiedAt: previousVerifiedAt,
      lastPollAt,
      lastErrorCode: "NETWORK_UNREACHABLE",
    });
    const { api, getWebhookInfo } = fakeApi({ username: "ZAPROSTO_TEST_BOT" });

    await expect(
      verifyTelegramBotReadiness({
        configuration: enabledConfiguration,
        api,
        state,
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({
      status: "NOT_READY",
      reasonCode: "BOT_IDENTITY_MISMATCH",
    });
    expect(getWebhookInfo).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      botUserId: 5_000_000_001n,
      botUsername: "old_case_bot",
      nextUpdateId: 9_000_000_123n,
      lastVerifiedAt: previousVerifiedAt,
      lastPollAt,
      lastErrorCode: "BOT_IDENTITY_MISMATCH",
    });
  });

  it("rejects an env/getMe username mismatch before webhook inspection", async () => {
    const state = new MemoryBotState();
    const { api, getWebhookInfo } = fakeApi({ username: "another_bot" });
    await expect(
      verifyTelegramBotReadiness({
        configuration: enabledConfiguration,
        api,
        state,
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({
      status: "NOT_READY",
      reasonCode: "BOT_IDENTITY_MISMATCH",
    });
    expect(getWebhookInfo).not.toHaveBeenCalled();
    expect(state.current.botUserId).toBeNull();
    expect(state.current.lastErrorCode).toBe("BOT_IDENTITY_MISMATCH");
  });

  it("does not replace a saved bot identity", async () => {
    const state = new MemoryBotState({
      botUserId: 5_000_000_099n,
      botUsername: "zaprosto_test_bot",
      nextUpdateId: 777n,
    });
    const { api, getWebhookInfo } = fakeApi({ id: 5_000_000_001n });
    await expect(
      verifyTelegramBotReadiness({
        configuration: enabledConfiguration,
        api,
        state,
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({ reasonCode: "BOT_IDENTITY_MISMATCH" });
    expect(getWebhookInfo).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      botUserId: 5_000_000_099n,
      nextUpdateId: 777n,
      lastErrorCode: "BOT_IDENTITY_MISMATCH",
    });
  });

  it("blocks an active webhook without deleting it or confirming a new identity", async () => {
    const state = new MemoryBotState();
    const { api } = fakeApi({ webhook: true });
    await expect(
      verifyTelegramBotReadiness({
        configuration: enabledConfiguration,
        api,
        state,
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({ reasonCode: "WEBHOOK_ACTIVE" });
    expect(api.deleteWebhook).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      botUserId: null,
      botUsername: null,
      lastVerifiedAt: null,
      lastErrorCode: "WEBHOOK_ACTIVE",
    });
  });

  it.each([
    ["CONFIG_UNAUTHORIZED", "CONFIG_UNAUTHORIZED"],
    ["NETWORK_UNREACHABLE", "NETWORK_UNREACHABLE"],
  ] as const)("persists normalized adapter error %s", async (code, expected) => {
    const state = new MemoryBotState();
    const { api } = fakeApi({
      getMeError: new TelegramBotApiError({ code, operation: "getMe" }),
    });
    await expect(
      verifyTelegramBotReadiness({
        configuration: enabledConfiguration,
        api,
        state,
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({ status: "NOT_READY", reasonCode: expected });
    expect(state.current.lastErrorCode).toBe(expected);
  });

  it("normalizes an unknown adapter failure without exposing its message", async () => {
    const secretCause = new Error(tokenCanary);
    const state = new MemoryBotState();
    const { api } = fakeApi({ webhookError: secretCause });
    const result = await verifyTelegramBotReadiness({
      configuration: enabledConfiguration,
      api,
      state,
      clock: () => verifiedAt,
    });
    expect(result).toMatchObject({ reasonCode: "NETWORK_UNREACHABLE" });
    expect(JSON.stringify(result)).not.toContain(tokenCanary);
    expect(state.current.lastErrorCode).toBe("NETWORK_UNREACHABLE");
  });

  it("keeps bot token and webhook URL out of DTOs, errors, state, and logs", async () => {
    const webhookCanary = "https://example.invalid/WEBHOOK_URL_CANARY_06_3A";
    const transport = new FakeTelegramTransport([
      {
        kind: "RESPONSE",
        body: {
          ok: true,
          result: { id: 5_000_000_001, is_bot: true, username: "zaprosto_test_bot" },
        },
      },
      {
        kind: "RESPONSE",
        body: {
          ok: true,
          result: {
            url: webhookCanary,
            has_custom_certificate: false,
            pending_update_count: 0,
          },
        },
      },
    ]);
    const state = new MemoryBotState();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await verifyTelegramBotReadiness({
      configuration: enabledConfiguration,
      api: createTelegramBotApi(transport),
      state,
      clock: () => verifiedAt,
    });
    const serialized = JSON.stringify({
      result,
      lastErrorCode: state.current.lastErrorCode,
      logs: [...consoleLog.mock.calls, ...consoleError.mock.calls],
    });

    expect(serialized).not.toContain(tokenCanary);
    expect(serialized).not.toContain(webhookCanary);
    expect(serialized).toContain("WEBHOOK_ACTIVE");
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });
});
