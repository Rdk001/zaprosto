import { describe, expect, it } from "vitest";

import { createTelegramBotApi, normalizeTelegramPlainText } from "./bot-api";
import { FakeTelegramTransport, type FakeTelegramTransportStep } from "./fake-transport";

function success(result: unknown): FakeTelegramTransportStep {
  return { kind: "RESPONSE", body: { ok: true, result } };
}

function apiFor(...steps: FakeTelegramTransportStep[]) {
  const transport = new FakeTelegramTransport(steps);
  return { api: createTelegramBotApi(transport), transport };
}

describe("TelegramBotApi success contract", () => {
  it("разбирает group message с отрицательным chat ID", async () => {
    const { api } = apiFor(
      success([
        {
          update_id: 1,
          message: {
            message_id: 2,
            date: 1_799_999_999,
            chat: { id: -1_001_234_567_890, type: "group" },
            text: "group message",
          },
        },
      ]),
    );

    await expect(
      api.getUpdates({
        offset: 0n,
        limit: 100,
        timeoutSeconds: 30,
        allowedUpdates: ["message"],
      }),
    ).resolves.toEqual([
      {
        updateId: 1n,
        message: {
          messageId: 2n,
          dateUnixSeconds: 1_799_999_999,
          chat: { id: -1_001_234_567_890n, type: "group" },
          text: "group message",
        },
      },
    ]);
  });

  it("разбирает целиком batch с group update и следующим private update", async () => {
    const { api } = apiFor(
      success([
        {
          update_id: 10,
          message: {
            message_id: 20,
            date: 1_799_999_999,
            chat: { id: -1_001_234_567_890, type: "group" },
          },
        },
        {
          update_id: 11,
          message: {
            message_id: 21,
            date: 1_800_000_000,
            chat: { id: 5_000_000_002, type: "private" },
          },
        },
      ]),
    );

    const updates = await api.getUpdates({
      offset: 0n,
      limit: 100,
      timeoutSeconds: 30,
      allowedUpdates: ["message"],
    });

    expect(updates).toHaveLength(2);
    expect(updates.map((update) => update.updateId)).toEqual([10n, 11n]);
    expect(updates[0]?.message?.chat).toEqual({
      id: -1_001_234_567_890n,
      type: "group",
    });
    expect(updates[1]?.message?.chat).toEqual({ id: 5_000_000_002n, type: "private" });
  });

  it("не классифицирует отрицательный supergroup chat ID как RESPONSE_INVALID", async () => {
    const { api } = apiFor(
      success([
        {
          update_id: 30,
          message: {
            message_id: 40,
            date: 1_800_000_000,
            chat: { id: -1_009_876_543_210, type: "supergroup" },
          },
        },
      ]),
    );

    await expect(
      api.getUpdates({
        offset: 0n,
        limit: 1,
        timeoutSeconds: 5,
        allowedUpdates: ["message"],
      }),
    ).resolves.toMatchObject([
      {
        message: {
          chat: { id: -1_009_876_543_210n, type: "supergroup" },
        },
      },
    ]);
  });

  it("выполняет пять строго типизированных операций и возвращает минимальные DTO", async () => {
    const { api, transport } = apiFor(
      success({
        id: 5_000_000_001,
        is_bot: true,
        first_name: "Secret display name",
        username: "zaprosto_test_bot",
      }),
      success({
        url: "https://webhook.example/SECRET_PATH",
        has_custom_certificate: false,
        pending_update_count: 3,
        last_error_message: "unsafe diagnostic",
      }),
      success(true),
      success([
        {
          update_id: 7_000_000_001,
          message: {
            message_id: 0,
            from: { id: 5_000_000_002, is_bot: false, first_name: "PII is ignored" },
            date: 1_799_999_999,
            chat: { id: 5_000_000_002, type: "private", first_name: "PII is ignored" },
            text: "/start c_token",
            contact: { phone_number: "+79990000000" },
          },
        },
        { update_id: 7_000_000_002, edited_message: { arbitrary: true } },
      ]),
      success({ message_id: 4_000_000_001, chat: { id: 5_000_000_002 }, text: "ignored" }),
    );

    await expect(api.getMe()).resolves.toEqual({
      id: 5_000_000_001n,
      username: "zaprosto_test_bot",
    });
    await expect(api.getWebhookInfo()).resolves.toEqual({
      hasWebhook: true,
      hasCustomCertificate: false,
      pendingUpdateCount: 3,
    });
    await expect(api.deleteWebhook({ dropPendingUpdates: false })).resolves.toBeUndefined();
    await expect(
      api.getUpdates({
        offset: 7_000_000_001n,
        limit: 100,
        timeoutSeconds: 30,
        allowedUpdates: ["message"],
      }),
    ).resolves.toEqual([
      {
        updateId: 7_000_000_001n,
        message: {
          messageId: 0n,
          from: { id: 5_000_000_002n, isBot: false },
          dateUnixSeconds: 1_799_999_999,
          chat: { id: 5_000_000_002n, type: "private" },
          text: "/start c_token",
        },
      },
      { updateId: 7_000_000_002n },
    ]);
    await expect(
      api.sendMessage({ chatId: 5_000_000_002n, text: "\u0000Привет\r\nмир\t!" }),
    ).resolves.toEqual({ messageId: 4_000_000_001n });

    expect(transport.calls).toEqual([
      { method: "getMe", body: {} },
      { method: "getWebhookInfo", body: {} },
      { method: "deleteWebhook", body: { drop_pending_updates: false } },
      {
        method: "getUpdates",
        body: {
          offset: 7_000_000_001,
          limit: 100,
          timeout: 30,
          allowed_updates: ["message"],
        },
      },
      { method: "sendMessage", body: { chat_id: 5_000_000_002, text: "Привет\nмир!" } },
    ]);
    expect(transport.calls[4]?.body).not.toHaveProperty("parse_mode");
  });

  it("getWebhookInfo не возвращает сам webhook URL", async () => {
    const webhookCanary = "https://example.invalid/WEBHOOK_SECRET_CANARY";
    const { api } = apiFor(
      success({ url: webhookCanary, has_custom_certificate: true, pending_update_count: 0 }),
    );
    const result = await api.getWebhookInfo();

    expect(result).toEqual({
      hasWebhook: true,
      hasCustomCertificate: true,
      pendingUpdateCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain(webhookCanary);
  });

  it("deleteWebhook допускает только явный false и не расходует fake-step на true", async () => {
    const { api, transport } = apiFor(success(true));
    await expect(api.deleteWebhook({ dropPendingUpdates: true } as never)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      operation: "deleteWebhook",
    });
    expect(transport.calls).toEqual([]);

    await expect(api.deleteWebhook({ dropPendingUpdates: false })).resolves.toBeUndefined();
    expect(transport.calls[0]?.body).toEqual({ drop_pending_updates: false });
  });

  it("нормализует CR и удаляет controls, сохраняя LF", () => {
    expect(normalizeTelegramPlainText("a\r\nb\rc\n\u2028e\u2029f\t\u0000\u009fd")).toBe(
      "a\nb\nc\n\ne\nfd",
    );
  });

  it("принимает ровно 4096 Unicode code points без parse_mode", async () => {
    const text = "😀".repeat(4096);
    const { api, transport } = apiFor(success({ message_id: 1 }));
    await expect(api.sendMessage({ chatId: 1n, text })).resolves.toEqual({ messageId: 1n });
    expect(transport.calls[0]?.body).toEqual({ chat_id: 1, text });
    expect(transport.calls[0]?.body).not.toHaveProperty("parse_mode");
  });

  it.each([
    null,
    { offset: -1n, limit: 100, timeoutSeconds: 30, allowedUpdates: ["message"] as const },
    {
      offset: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      limit: 100,
      timeoutSeconds: 30,
      allowedUpdates: ["message"] as const,
    },
    { offset: 0n, limit: 0, timeoutSeconds: 30, allowedUpdates: ["message"] as const },
    { offset: 0n, limit: 101, timeoutSeconds: 30, allowedUpdates: ["message"] as const },
    { offset: 0n, limit: 100, timeoutSeconds: 4, allowedUpdates: ["message"] as const },
    { offset: 0n, limit: 100, timeoutSeconds: 51, allowedUpdates: ["message"] as const },
    { offset: 0n, limit: 100, timeoutSeconds: 30, allowedUpdates: ["edited_message"] },
  ])("валидирует getUpdates input %#", async (input) => {
    const { api, transport } = apiFor(success([]));
    await expect(api.getUpdates(input as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(transport.calls).toEqual([]);
  });

  it.each([
    null,
    { chatId: 0n, text: "ok" },
    { chatId: -1n, text: "ok" },
    { chatId: BigInt(Number.MAX_SAFE_INTEGER) + 1n, text: "ok" },
    { chatId: 1n, text: "" },
    { chatId: 1n, text: "\u0000\t" },
    { chatId: 1n, text: "x".repeat(4097) },
    { chatId: 1n, text: "\ud800" },
  ])("валидирует sendMessage input %#", async (input) => {
    const { api, transport } = apiFor(success({ message_id: 1 }));
    await expect(api.sendMessage(input as never)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(transport.calls).toEqual([]);
  });

  it.each([
    { id: Number.MAX_SAFE_INTEGER + 1, is_bot: true, username: "zaprosto_bot" },
    { id: 1, is_bot: false, username: "zaprosto_bot" },
    { id: 1, is_bot: true, username: "@bad_bot" },
    { id: 1, is_bot: true },
  ])("отклоняет невалидный getMe result %#", async (result) => {
    const { api } = apiFor(success(result));
    await expect(api.getMe()).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
      operation: "getMe",
    });
  });

  it.each([
    [{ update_id: Number.MAX_SAFE_INTEGER + 1 }],
    [
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: Number.MAX_SAFE_INTEGER + 1, type: "private" },
        },
      },
    ],
    [
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: Number.MIN_SAFE_INTEGER - 1, type: "group" },
        },
      },
    ],
    [
      {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false },
          date: 1,
          chat: { id: 1, type: "private" },
        },
      },
    ],
  ])("отклоняет unsafe Telegram ID в updates", async (result) => {
    const { api } = apiFor(success(result));
    await expect(
      api.getUpdates({
        offset: 0n,
        limit: 100,
        timeoutSeconds: 30,
        allowedUpdates: ["message"],
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID", operation: "getUpdates" });
  });

  it("отклоняет нулевой входящий Telegram Chat.id", async () => {
    const { api } = apiFor(
      success([
        {
          update_id: 1,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 0, type: "private" },
          },
        },
      ]),
    );

    await expect(
      api.getUpdates({
        offset: 0n,
        limit: 100,
        timeoutSeconds: 30,
        allowedUpdates: ["message"],
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID", operation: "getUpdates" });
  });

  it("валидирует bounded timeout option до transport", async () => {
    const { api, transport } = apiFor(success({ id: 1, is_bot: true, username: "valid_bot" }));
    await expect(api.getMe({ timeoutMs: 60_001 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(transport.calls).toEqual([]);
  });
});
