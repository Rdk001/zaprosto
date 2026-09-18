import { describe, expect, it, vi } from "vitest";

import { TelegramBotApiError, type TelegramBotApi } from "./bot-api";
import type { TelegramBotStateSnapshot } from "./bot-state-repository";
import {
  requireEnabledTelegramWebhookTransitionConfiguration,
  TelegramWebhookTransitionService,
} from "./webhook-transition-service";

const configuration = {
  kind: "ENABLED" as const,
  botToken: "123456:TRANSITION_TOKEN_CANARY_123456789",
  botUsername: "Transition_Test_Bot",
  pollTimeoutSeconds: 30,
};

const storedState: TelegramBotStateSnapshot = {
  botUserId: 1001n,
  botUsername: "transition_test_bot",
  nextUpdateId: 777n,
  lastVerifiedAt: new Date("2026-09-18T00:00:00.000Z"),
  lastPollAt: new Date("2026-09-18T00:00:00.000Z"),
  lastErrorCode: "WEBHOOK_ACTIVE" as const,
};

function setup(
  input: {
    identity?: { id: bigint; username: string };
    state?: TelegramBotStateSnapshot;
    webhooks?: Array<boolean | Error>;
    deleteError?: Error;
  } = {},
) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const webhooks = [...(input.webhooks ?? [false])];
  const api = {
    getMe: vi.fn(async (options?: { signal?: AbortSignal }) => {
      calls.push("getMe");
      if (options?.signal) signals.push(options.signal);
      return input.identity ?? { id: 1001n, username: "Transition_Test_Bot" };
    }),
    getWebhookInfo: vi.fn(async (options?: { signal?: AbortSignal }) => {
      calls.push("getWebhookInfo");
      if (options?.signal) signals.push(options.signal);
      const next = webhooks.shift();
      if (next instanceof Error) throw next;
      return {
        hasWebhook: next ?? false,
        hasCustomCertificate: false,
        pendingUpdateCount: 9,
      };
    }),
    deleteWebhook: vi.fn(
      async (
        value: { dropPendingUpdates: false },
        options?: { signal?: AbortSignal },
      ): Promise<void> => {
        calls.push("deleteWebhook");
        if (options?.signal) signals.push(options.signal);
        if (input.deleteError) throw input.deleteError;
        expect(value).toEqual({ dropPendingUpdates: false });
      },
    ),
  } satisfies Pick<TelegramBotApi, "getMe" | "getWebhookInfo" | "deleteWebhook">;
  const state = {
    getState: vi.fn(async () => input.state ?? storedState),
  };
  return { api, state, calls, signals };
}

describe("Telegram webhook transition service", () => {
  it.each([
    [{ kind: "DISABLED", pollTimeoutSeconds: 30 }, "CONFIG_DISABLED"],
    [{ kind: "INCOMPLETE", reasonCode: "BOT_TOKEN_REQUIRED" }, "CONFIG_INCOMPLETE"],
    [{ kind: "INVALID", reasonCode: "CONFIG_UNAUTHORIZED" }, "CONFIG_INVALID"],
  ] as const)("requires enabled configuration", (value, code) => {
    expect(() => requireEnabledTelegramWebhookTransitionConfiguration(value)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("accepts username case-only differences and returns NO_CHANGE without delete", async () => {
    const { api, state, calls } = setup();
    const service = new TelegramWebhookTransitionService(state, api, configuration);
    await expect(service.transition({ signal: new AbortController().signal })).resolves.toEqual({
      status: "NO_CHANGE",
    });
    expect(calls).toEqual(["getMe", "getWebhookInfo"]);
    expect(api.deleteWebhook).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        state: { ...storedState, botUserId: null, botUsername: null },
      },
      "BOT_STATE_UNINITIALIZED",
    ],
    [
      {
        state: { ...storedState, botUserId: 9999n },
      },
      "BOT_IDENTITY_MISMATCH",
    ],
    [
      {
        state: { ...storedState, botUsername: "Different_Test_Bot" },
      },
      "BOT_IDENTITY_MISMATCH",
    ],
    [
      {
        identity: { id: 1001n, username: "Different_Test_Bot" },
      },
      "BOT_USERNAME_MISMATCH",
    ],
  ] as const)("rejects uninitialized or mismatched identity", async (override, code) => {
    const { api, state } = setup(override);
    const service = new TelegramWebhookTransitionService(state, api, configuration);
    await expect(
      service.transition({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code,
    });
    expect(api.getWebhookInfo).not.toHaveBeenCalled();
    expect(api.deleteWebhook).not.toHaveBeenCalled();
  });

  it("uses the exact transition sequence and passes one session signal to every API call", async () => {
    const { api, state, calls, signals } = setup({ webhooks: [true, false] });
    const signal = new AbortController().signal;
    const service = new TelegramWebhookTransitionService(state, api, configuration);
    await expect(service.transition({ signal })).resolves.toEqual({ status: "TRANSITIONED" });
    expect(calls).toEqual(["getMe", "getWebhookInfo", "deleteWebhook", "getWebhookInfo"]);
    expect(api.deleteWebhook).toHaveBeenCalledWith({ dropPendingUpdates: false }, { signal });
    expect(signals).toEqual([signal, signal, signal, signal]);
    expect(JSON.stringify(api.deleteWebhook.mock.calls)).not.toContain("true");
  });

  it.each([
    [true, true],
    [
      true,
      new TelegramBotApiError({
        operation: "getWebhookInfo",
        code: "NETWORK_UNREACHABLE",
      }),
    ],
  ] as const)(
    "returns TRANSITION_UNCONFIRMED after a failed post-check without retrying delete",
    async (...webhooks) => {
      const { api, state } = setup({ webhooks });
      const service = new TelegramWebhookTransitionService(state, api, configuration);
      await expect(
        service.transition({ signal: new AbortController().signal }),
      ).rejects.toMatchObject({
        code: "TRANSITION_UNCONFIRMED",
      });
      expect(api.deleteWebhook).toHaveBeenCalledOnce();
      expect(api.getWebhookInfo).toHaveBeenCalledTimes(2);
    },
  );

  it("stops before API when the maintenance session is already lost", async () => {
    const controller = new AbortController();
    controller.abort(new Error("RAW_SESSION_CANARY"));
    const { api, state } = setup({ webhooks: [true, false] });
    const service = new TelegramWebhookTransitionService(state, api, configuration);
    const error = await service.transition({ signal: controller.signal }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "MAINTENANCE_SESSION_LOST" });
    expect(api.getMe).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain("RAW_SESSION_CANARY");
  });

  it("returns bounded errors without secret, URL, identity, raw response, or cause", async () => {
    const raw = "https://example.invalid/RAW_WEBHOOK_CANARY?token=TOKEN_CANARY";
    const { api, state } = setup({
      webhooks: [
        new TelegramBotApiError({
          operation: "getWebhookInfo",
          code: "RESPONSE_INVALID",
        }),
      ],
    });
    api.getWebhookInfo.mockRejectedValueOnce(Object.assign(new Error(raw), { raw }));
    const service = new TelegramWebhookTransitionService(state, api, configuration);
    const error = await service
      .transition({ signal: new AbortController().signal })
      .catch((caught) => caught);
    const serialized = JSON.stringify(error);
    expect(error).toMatchObject({ code: "OPERATION_FAILED" });
    expect(serialized).not.toContain("RAW_WEBHOOK_CANARY");
    expect(serialized).not.toContain(configuration.botToken);
    expect(serialized).not.toContain(configuration.botUsername);
    expect(serialized).not.toContain("1001");
  });
});
