import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramBotApi, TelegramBotApiError } from "./bot-api";
import { FakeTelegramTransport, type FakeTelegramTransportStep } from "./fake-transport";
import { createTelegramFetchTransport } from "./fetch-transport";

function response(
  body: unknown | string | Uint8Array,
  status = 200,
  options: Pick<
    Extract<FakeTelegramTransportStep, { kind: "RESPONSE" }>,
    "contentLength" | "chunkSize"
  > = {},
): FakeTelegramTransportStep {
  return { kind: "RESPONSE", status, body, ...options };
}

function telegramError(
  status: number,
  errorCode: number,
  description: string,
  parameters?: unknown,
): FakeTelegramTransportStep {
  return response(
    {
      ok: false,
      error_code: errorCode,
      description,
      ...(parameters === undefined ? {} : { parameters }),
    },
    status,
  );
}

function apiFor(...steps: FakeTelegramTransportStep[]) {
  const transport = new FakeTelegramTransport(steps);
  return { api: createTelegramBotApi(transport), transport };
}

async function sendFailure(step: FakeTelegramTransportStep) {
  const { api } = apiFor(step);
  try {
    await api.sendMessage({ chatId: 123n, text: "safe text" });
    throw new Error("expected TelegramBotApiError");
  } catch (error) {
    return error as TelegramBotApiError;
  }
}

async function captureBotApiError(promise: Promise<unknown>): Promise<TelegramBotApiError> {
  try {
    await promise;
    throw new Error("expected TelegramBotApiError");
  } catch (error) {
    if (error instanceof TelegramBotApiError) {
      return error;
    }
    throw error;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TelegramBotApi failures", () => {
  it.each([
    [400, 400, "Bad Request: unknown", "INVALID_REQUEST"],
    [400, 400, "Bad Request: chat not found", "CHAT_NOT_FOUND"],
    [401, 401, "Unauthorized", "CONFIG_UNAUTHORIZED"],
    [403, 403, "Forbidden: bot was blocked by the user", "BOT_BLOCKED"],
    [403, 403, "Forbidden: user is deactivated", "TELEGRAM_USER_DEACTIVATED"],
    [403, 403, "Forbidden: future unknown wording", "CHAT_WRITE_FORBIDDEN"],
    [418, 418, "unexpected client failure", "INVALID_REQUEST"],
  ])("классифицирует HTTP %i/error %i как %s", async (status, code, description, expected) => {
    await expect(sendFailure(telegramError(status, code, description))).resolves.toMatchObject({
      name: "TelegramBotApiError",
      code: expected,
      operation: "sendMessage",
    });
  });

  it("не применяет chat-specific description к read-методу", async () => {
    const { api } = apiFor(telegramError(400, 400, "Bad Request: chat not found"));
    await expect(api.getMe()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("извлекает retry_after только из strict ResponseParameters", async () => {
    const valid = await sendFailure(
      telegramError(429, 429, "Too Many Requests", { retry_after: 45 }),
    );
    expect(valid).toMatchObject({ code: "TELEGRAM_RATE_LIMIT", retryAfterSeconds: 45 });

    const invalid = await sendFailure(
      telegramError(429, 429, "Too Many Requests", {
        retry_after: 45,
        migrate_to_chat_id: 123,
      }),
    );
    expect(invalid.code).toBe("TELEGRAM_RATE_LIMIT");
    expect(invalid.retryAfterSeconds).toBeUndefined();
  });

  it.each([500, 502, 599])("классифицирует HTTP %i как TELEGRAM_5XX", async (status) => {
    const { api } = apiFor(response("upstream html is discarded", status));
    await expect(api.getMe()).rejects.toMatchObject({
      code: "TELEGRAM_5XX",
      operation: "getMe",
    });
  });

  it.each([
    "{not json",
    { result: {} },
    { ok: "true", result: {} },
    { ok: false, error_code: "400", description: "wrong envelope" },
  ])("отклоняет malformed JSON/envelope %#", async (body) => {
    const { api } = apiFor(response(typeof body === "string" ? body : body));
    await expect(api.getMe()).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
      operation: "getMe",
    });
  });

  it("отклоняет невалидный UTF-8", async () => {
    const { api } = apiFor(response(new Uint8Array([0xff]), 200, { contentLength: null }));
    await expect(api.getMe()).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });

  it("останавливает oversized response по Content-Length и во время чтения", async () => {
    const early = apiFor(response("{}", 200, { contentLength: 256 * 1024 + 1 })).api.getMe();
    await expect(early).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const streamed = apiFor(
      response(new Uint8Array(256 * 1024 + 1), 200, {
        contentLength: null,
        chunkSize: 1024,
      }),
    ).api.getMe();
    await expect(streamed).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("применяет отдельный 4 MiB предел к getUpdates batch", async () => {
    const { api } = apiFor(
      response(new Uint8Array(4 * 1024 * 1024 + 1), 200, {
        contentLength: null,
        chunkSize: 64 * 1024,
      }),
    );
    await expect(
      api.getUpdates({
        offset: 0n,
        limit: 100,
        timeoutSeconds: 30,
        allowedUpdates: ["message"],
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE", operation: "getUpdates" });
  });

  it("отличает сетевой отказ до ответа от потерянного результата sendMessage", async () => {
    await expect(sendFailure({ kind: "NETWORK_FAILURE" })).resolves.toMatchObject({
      code: "NETWORK_UNREACHABLE",
    });
    await expect(sendFailure({ kind: "DELIVERY_OUTCOME_UNKNOWN" })).resolves.toMatchObject({
      code: "DELIVERY_OUTCOME_UNKNOWN",
    });
  });

  it("различает внутренний timeout и caller abort", async () => {
    vi.useFakeTimers();
    const timed = apiFor({ kind: "WAIT_FOR_ABORT" }).api.getMe({ timeoutMs: 10 });
    const timedAssertion = expect(timed).rejects.toMatchObject({
      code: "NETWORK_UNREACHABLE",
      abortSource: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(10);
    await timedAssertion;

    vi.useRealTimers();
    const controller = new AbortController();
    const caller = apiFor({ kind: "WAIT_FOR_ABORT" }).api.getMe({ signal: controller.signal });
    controller.abort();
    await expect(caller).rejects.toMatchObject({
      code: "NETWORK_UNREACHABLE",
      abortSource: "CALLER",
    });
  });

  it("abort после начала sendMessage имеет неизвестный delivery outcome", async () => {
    const controller = new AbortController();
    const pending = apiFor({ kind: "WAIT_FOR_ABORT" }).api.sendMessage(
      { chatId: 123n, text: "hello" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "DELIVERY_OUTCOME_UNKNOWN",
      abortSource: "CALLER",
    });
  });

  it("отклоняет unsafe webhook state и sendMessage result", async () => {
    const webhook = apiFor(
      response({
        ok: true,
        result: {
          url: "",
          has_custom_certificate: false,
          pending_update_count: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).api;
    await expect(webhook.getWebhookInfo()).rejects.toMatchObject({ code: "RESPONSE_INVALID" });

    const sent = apiFor(
      response({ ok: true, result: { message_id: Number.MAX_SAFE_INTEGER + 1 } }),
    ).api;
    await expect(sent.sendMessage({ chatId: 1n, text: "ok" })).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
    });
  });

  it("invalid local bot token даёт безопасный CONFIG_UNAUTHORIZED", async () => {
    const tokenCanary = "INVALID_BOT_TOKEN_SECRET_CANARY";
    const api = createTelegramBotApi(createTelegramFetchTransport({ botToken: tokenCanary }));
    const error = await captureBotApiError(api.getMe());
    expect(error).toMatchObject({ code: "CONFIG_UNAUTHORIZED" });
    expect(JSON.stringify(error)).not.toContain(tokenCanary);
  });

  it("не выпускает token, URL, raw link, chat ID, text или description из errors/results/logs", async () => {
    const botToken = "777777:BOT_TOKEN_CANARY_06_2B_SECRET";
    const fullApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const rawLinkToken = `c_${"A".repeat(43)}`;
    const chatId = 5_555_555_555n;
    const messageText = `MESSAGE_TEXT_CANARY ${rawLinkToken}`;
    const telegramDescription = [
      "Forbidden: bot was blocked by the user",
      "TELEGRAM_DESCRIPTION_CANARY",
      botToken,
      fullApiUrl,
      rawLinkToken,
      chatId.toString(),
      messageText,
    ].join(" | ");
    const captured: { url: string; body: string }[] = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      captured.push({ url: String(input), body: String(init?.body) });
      if (captured.length === 1) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 11,
              chat: { id: Number(chatId), first_name: "RESULT_PII_CANARY" },
              text: messageText,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: false, error_code: 403, description: telegramDescription }),
        { status: 403 },
      );
    }) as unknown as typeof fetch;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = createTelegramBotApi(createTelegramFetchTransport({ botToken, fetchImpl }));

    const result = await api.sendMessage({ chatId, text: messageText });
    const error = await captureBotApiError(api.sendMessage({ chatId, text: messageText }));
    const serialized = JSON.stringify(
      {
        result,
        error,
        errorMessage: error.message,
        errorStack: error.stack,
      },
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );

    expect(result).toEqual({ messageId: 11n });
    expect(error).toMatchObject({ code: "BOT_BLOCKED", operation: "sendMessage" });
    for (const canary of [
      botToken,
      fullApiUrl,
      rawLinkToken,
      chatId.toString(),
      messageText,
      telegramDescription,
      "TELEGRAM_DESCRIPTION_CANARY",
      "RESULT_PII_CANARY",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual({
      url: fullApiUrl,
      body: JSON.stringify({ chat_id: Number(chatId), text: messageText }),
    });
    expect(captured[0]?.body).not.toContain("parse_mode");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("отбрасывает исходный fetch cause.message целиком", async () => {
    const botToken = "888888:ANOTHER_BOT_TOKEN_CANARY_SECRET";
    const causeCanary = "FETCH_CAUSE_WITH_TOKEN_URL_CHAT_AND_TEXT_CANARY";
    const fetchImpl = vi.fn(async () => {
      throw new Error(
        `${causeCanary} ${botToken} https://api.telegram.org/bot${botToken}/sendMessage`,
      );
    }) as unknown as typeof fetch;
    const api = createTelegramBotApi(createTelegramFetchTransport({ botToken, fetchImpl }));
    const error = await captureBotApiError(
      api.sendMessage({ chatId: 99n, text: "CAUSE_MESSAGE_TEXT_CANARY" }),
    );
    const serialized = JSON.stringify({ error, stack: error.stack });

    expect(error).toMatchObject({ code: "DELIVERY_OUTCOME_UNKNOWN" });
    expect(serialized).not.toContain(causeCanary);
    expect(serialized).not.toContain(botToken);
    expect(serialized).not.toContain("CAUSE_MESSAGE_TEXT_CANARY");
  });
});
