import { z } from "zod";

import type { TelegramAdapterErrorCode } from "../domain/safe-error";
import {
  TelegramTransportFailure,
  type TelegramMethod,
  type TelegramTransport,
  type TelegramTransportResponse,
} from "./transport";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MIN_SECONDS = 5;
const POLL_TIMEOUT_MAX_SECONDS = 50;
const NORMAL_RESPONSE_MAX_BYTES = 256 * 1024;
const UPDATES_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const SEND_MESSAGE_MAX_CHARACTERS = 4096;

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonZeroSafeIntegerSchema = z
  .number()
  .int()
  .safe()
  .refine((value) => value !== 0);

const successEnvelopeSchema = z.object({ ok: z.literal(true), result: z.unknown() });
const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error_code: z.number().int().safe(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
});
const envelopeSchema = z.discriminatedUnion("ok", [successEnvelopeSchema, errorEnvelopeSchema]);
const retryParametersSchema = z.strictObject({ retry_after: positiveSafeIntegerSchema });

const botIdentitySchema = z.object({
  id: positiveSafeIntegerSchema,
  is_bot: z.literal(true),
  username: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/),
});

const webhookInfoSchema = z.object({
  url: z.string(),
  has_custom_certificate: z.boolean(),
  pending_update_count: nonNegativeSafeIntegerSchema,
});

const telegramUserSchema = z.object({
  id: positiveSafeIntegerSchema,
  is_bot: z.boolean(),
});

const telegramChatSchema = z.object({
  id: nonZeroSafeIntegerSchema,
  type: z.enum(["private", "group", "supergroup", "channel"]),
});

const telegramMessageSchema = z.object({
  message_id: nonNegativeSafeIntegerSchema,
  from: telegramUserSchema.optional(),
  date: positiveSafeIntegerSchema,
  chat: telegramChatSchema,
  text: z.string().optional(),
});

const telegramUpdateSchema = z.object({
  update_id: nonNegativeSafeIntegerSchema,
  message: telegramMessageSchema.optional(),
});

export type TelegramCallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type TelegramBotIdentity = { id: bigint; username: string };
export type TelegramWebhookInfo = {
  hasWebhook: boolean;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
};
export type TelegramUpdate = {
  updateId: bigint;
  message?: {
    messageId: bigint;
    from?: { id: bigint; isBot: boolean };
    dateUnixSeconds: number;
    chat: { id: bigint; type: "private" | "group" | "supergroup" | "channel" };
    text?: string;
  };
};

export interface TelegramBotApi {
  getMe(options?: TelegramCallOptions): Promise<TelegramBotIdentity>;
  getWebhookInfo(options?: TelegramCallOptions): Promise<TelegramWebhookInfo>;
  deleteWebhook(input: { dropPendingUpdates: false }, options?: TelegramCallOptions): Promise<void>;
  getUpdates(
    input: {
      offset: bigint;
      limit: number;
      timeoutSeconds: number;
      allowedUpdates: readonly ["message"];
    },
    options?: TelegramCallOptions,
  ): Promise<readonly TelegramUpdate[]>;
  sendMessage(
    input: { chatId: bigint; text: string },
    options?: TelegramCallOptions,
  ): Promise<{ messageId: bigint }>;
}

export type TelegramAbortSource = "CALLER" | "TIMEOUT";

export class TelegramBotApiError extends Error {
  readonly code: TelegramAdapterErrorCode;
  readonly operation: TelegramMethod;
  readonly retryAfterSeconds?: number;
  readonly abortSource?: TelegramAbortSource;

  constructor(input: {
    code: TelegramAdapterErrorCode;
    operation: TelegramMethod;
    retryAfterSeconds?: number;
    abortSource?: TelegramAbortSource;
  }) {
    super(input.code);
    this.name = "TelegramBotApiError";
    this.code = input.code;
    this.operation = input.operation;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.abortSource = input.abortSource;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: this.retryAfterSeconds }),
      ...(this.abortSource === undefined ? {} : { abortSource: this.abortSource }),
    };
  }
}

function apiError(
  operation: TelegramMethod,
  code: TelegramAdapterErrorCode,
  extras: { retryAfterSeconds?: number; abortSource?: TelegramAbortSource } = {},
) {
  return new TelegramBotApiError({ operation, code, ...extras });
}

function safeTimeout(
  value: number | undefined,
  fallback: number,
  operation: TelegramMethod,
): number {
  const timeoutMs = value ?? fallback;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw apiError(operation, "INVALID_REQUEST");
  }
  return timeoutMs;
}

function bigintAsSafeNumber(
  value: bigint,
  operation: TelegramMethod,
  options: { positive?: boolean } = {},
): number {
  if (
    typeof value !== "bigint" ||
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < (options.positive ? 1n : 0n)
  ) {
    throw apiError(operation, "INVALID_REQUEST");
  }
  return Number(value);
}

function errorCodeForAbort(operation: TelegramMethod) {
  return operation === "sendMessage" ? "DELIVERY_OUTCOME_UNKNOWN" : "NETWORK_UNREACHABLE";
}

function classifiedTelegramError(
  operation: TelegramMethod,
  status: number,
  envelope: z.infer<typeof errorEnvelopeSchema>,
): TelegramBotApiError {
  const code = envelope.error_code;
  const description = envelope.description ?? "";

  if (status === 401 || code === 401) {
    return apiError(operation, "CONFIG_UNAUTHORIZED");
  }
  if (status === 429 || code === 429) {
    const parameters = retryParametersSchema.safeParse(envelope.parameters);
    return apiError(operation, "TELEGRAM_RATE_LIMIT", {
      ...(parameters.success ? { retryAfterSeconds: parameters.data.retry_after } : {}),
    });
  }
  if (status >= 500 || code >= 500) {
    return apiError(operation, "TELEGRAM_5XX");
  }

  if (operation === "sendMessage") {
    if (/\bchat not found\b/i.test(description)) {
      return apiError(operation, "CHAT_NOT_FOUND");
    }
    if (/bot (?:was|is) blocked by the user|user is blocked/i.test(description)) {
      return apiError(operation, "BOT_BLOCKED");
    }
    if (/user is deactivated|input_user_deactivated/i.test(description)) {
      return apiError(operation, "TELEGRAM_USER_DEACTIVATED");
    }
    if (status === 403 || code === 403) {
      return apiError(operation, "CHAT_WRITE_FORBIDDEN");
    }
  }

  return apiError(operation, "INVALID_REQUEST");
}

async function readBoundedResponse(
  operation: TelegramMethod,
  response: TelegramTransportResponse,
  maxBytes: number,
): Promise<Uint8Array> {
  if (
    response.contentLength !== null &&
    (!Number.isSafeInteger(response.contentLength) || response.contentLength < 0)
  ) {
    throw apiError(operation, "RESPONSE_INVALID");
  }
  if (response.contentLength !== null && response.contentLength > maxBytes) {
    throw apiError(operation, "RESPONSE_TOO_LARGE");
  }

  if (response.body instanceof Uint8Array) {
    if (response.body.byteLength > maxBytes) {
      throw apiError(operation, "RESPONSE_TOO_LARGE");
    }
    return response.body;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    if (!(chunk instanceof Uint8Array)) {
      throw apiError(operation, "RESPONSE_INVALID");
    }
    total += chunk.byteLength;
    if (!Number.isSafeInteger(total) || total > maxBytes) {
      throw apiError(operation, "RESPONSE_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJsonBody(operation: TelegramMethod, bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw apiError(operation, "RESPONSE_INVALID");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw apiError(operation, "RESPONSE_INVALID");
  }
}

export function normalizeTelegramPlainText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");
}

export function createTelegramBotApi(transport: TelegramTransport): TelegramBotApi {
  async function call(
    operation: TelegramMethod,
    body: Readonly<Record<string, unknown>>,
    options: TelegramCallOptions | undefined,
    fallbackTimeoutMs: number,
    maxResponseBytes: number,
  ): Promise<unknown> {
    const timeoutMs = safeTimeout(options?.timeoutMs, fallbackTimeoutMs, operation);
    const controller = new AbortController();
    let abortSource: TelegramAbortSource | undefined;
    let requestStarted = false;

    const abortFromCaller = () => {
      abortSource = "CALLER";
      controller.abort();
    };
    if (options?.signal?.aborted) {
      throw apiError(operation, "NETWORK_UNREACHABLE", { abortSource: "CALLER" });
    }
    options?.signal?.addEventListener("abort", abortFromCaller, { once: true });

    const timer = setTimeout(() => {
      abortSource = "TIMEOUT";
      controller.abort();
    }, timeoutMs);
    timer.unref();

    try {
      requestStarted = true;
      const response = await transport.request({
        method: operation,
        body,
        signal: controller.signal,
      });
      const bytes = await readBoundedResponse(operation, response, maxResponseBytes);

      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        throw apiError(operation, "RESPONSE_INVALID");
      }

      if (response.status >= 500) {
        throw apiError(operation, "TELEGRAM_5XX");
      }

      const envelope = envelopeSchema.safeParse(parseJsonBody(operation, bytes));
      if (!envelope.success) {
        throw apiError(operation, "RESPONSE_INVALID");
      }
      if (!envelope.data.ok) {
        throw classifiedTelegramError(operation, response.status, envelope.data);
      }
      if (response.status < 200 || response.status >= 300) {
        throw apiError(operation, "RESPONSE_INVALID");
      }
      return envelope.data.result;
    } catch (error) {
      if (error instanceof TelegramBotApiError) {
        throw error;
      }
      if (error instanceof TelegramTransportFailure) {
        if (error.kind === "ABORTED") {
          throw apiError(operation, errorCodeForAbort(operation), {
            abortSource: abortSource ?? "TIMEOUT",
          });
        }
        throw apiError(operation, error.kind);
      }
      if (controller.signal.aborted) {
        throw apiError(operation, errorCodeForAbort(operation), {
          abortSource: abortSource ?? "TIMEOUT",
        });
      }
      throw apiError(
        operation,
        operation === "sendMessage" && requestStarted
          ? "DELIVERY_OUTCOME_UNKNOWN"
          : "NETWORK_UNREACHABLE",
      );
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  return {
    async getMe(options) {
      const result = await call(
        "getMe",
        {},
        options,
        DEFAULT_TIMEOUT_MS,
        NORMAL_RESPONSE_MAX_BYTES,
      );
      const parsed = botIdentitySchema.safeParse(result);
      if (!parsed.success) {
        throw apiError("getMe", "RESPONSE_INVALID");
      }
      return { id: BigInt(parsed.data.id), username: parsed.data.username };
    },

    async getWebhookInfo(options) {
      const result = await call(
        "getWebhookInfo",
        {},
        options,
        DEFAULT_TIMEOUT_MS,
        NORMAL_RESPONSE_MAX_BYTES,
      );
      const parsed = webhookInfoSchema.safeParse(result);
      if (!parsed.success) {
        throw apiError("getWebhookInfo", "RESPONSE_INVALID");
      }
      return {
        hasWebhook: parsed.data.url.length > 0,
        hasCustomCertificate: parsed.data.has_custom_certificate,
        pendingUpdateCount: parsed.data.pending_update_count,
      };
    },

    async deleteWebhook(input, options) {
      if (
        typeof input !== "object" ||
        input === null ||
        input.dropPendingUpdates !== false ||
        Object.keys(input).length !== 1
      ) {
        throw apiError("deleteWebhook", "INVALID_REQUEST");
      }
      const result = await call(
        "deleteWebhook",
        { drop_pending_updates: false },
        options,
        DEFAULT_TIMEOUT_MS,
        NORMAL_RESPONSE_MAX_BYTES,
      );
      if (result !== true) {
        throw apiError("deleteWebhook", "RESPONSE_INVALID");
      }
    },

    async getUpdates(input, options) {
      if (typeof input !== "object" || input === null) {
        throw apiError("getUpdates", "INVALID_REQUEST");
      }
      const offset = bigintAsSafeNumber(input.offset, "getUpdates");
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100 ||
        !Number.isSafeInteger(input.timeoutSeconds) ||
        input.timeoutSeconds < POLL_TIMEOUT_MIN_SECONDS ||
        input.timeoutSeconds > POLL_TIMEOUT_MAX_SECONDS ||
        !Array.isArray(input.allowedUpdates) ||
        input.allowedUpdates.length !== 1 ||
        input.allowedUpdates[0] !== "message"
      ) {
        throw apiError("getUpdates", "INVALID_REQUEST");
      }

      const result = await call(
        "getUpdates",
        {
          offset,
          limit: input.limit,
          timeout: input.timeoutSeconds,
          allowed_updates: ["message"],
        },
        options,
        input.timeoutSeconds * 1000 + 5000,
        UPDATES_RESPONSE_MAX_BYTES,
      );
      const parsed = z.array(telegramUpdateSchema).safeParse(result);
      if (!parsed.success) {
        throw apiError("getUpdates", "RESPONSE_INVALID");
      }

      return parsed.data.map((update): TelegramUpdate => ({
        updateId: BigInt(update.update_id),
        ...(update.message
          ? {
              message: {
                messageId: BigInt(update.message.message_id),
                ...(update.message.from
                  ? {
                      from: {
                        id: BigInt(update.message.from.id),
                        isBot: update.message.from.is_bot,
                      },
                    }
                  : {}),
                dateUnixSeconds: update.message.date,
                chat: {
                  id: BigInt(update.message.chat.id),
                  type: update.message.chat.type,
                },
                ...(update.message.text === undefined ? {} : { text: update.message.text }),
              },
            }
          : {}),
      }));
    },

    async sendMessage(input, options) {
      if (typeof input !== "object" || input === null) {
        throw apiError("sendMessage", "INVALID_REQUEST");
      }
      const chatId = bigintAsSafeNumber(input.chatId, "sendMessage", { positive: true });
      if (typeof input.text !== "string" || !input.text.isWellFormed()) {
        throw apiError("sendMessage", "INVALID_REQUEST");
      }
      const text = normalizeTelegramPlainText(input.text);
      const characters = Array.from(text).length;
      if (characters < 1 || characters > SEND_MESSAGE_MAX_CHARACTERS) {
        throw apiError("sendMessage", "INVALID_REQUEST");
      }

      const result = await call(
        "sendMessage",
        { chat_id: chatId, text },
        options,
        DEFAULT_TIMEOUT_MS,
        NORMAL_RESPONSE_MAX_BYTES,
      );
      const parsed = z.object({ message_id: nonNegativeSafeIntegerSchema }).safeParse(result);
      if (!parsed.success) {
        throw apiError("sendMessage", "RESPONSE_INVALID");
      }
      return { messageId: BigInt(parsed.data.message_id) };
    },
  };
}
