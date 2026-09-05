import {
  TelegramTransportFailure,
  type TelegramTransport,
  type TelegramTransportRequest,
  type TelegramTransportResponse,
} from "./transport";

const TELEGRAM_BOT_API_ORIGIN = "https://api.telegram.org";
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;

export type TelegramFetch = typeof fetch;

async function* responseChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (body === null) {
    return;
  }

  const reader = body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        return;
      }
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function createTelegramFetchTransport(input: {
  botToken: string;
  fetchImpl?: TelegramFetch;
}): TelegramTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const botToken = input.botToken;

  return {
    async request(request: TelegramTransportRequest): Promise<TelegramTransportResponse> {
      if (typeof botToken !== "string" || !BOT_TOKEN_PATTERN.test(botToken)) {
        throw new TelegramTransportFailure("CONFIG_UNAUTHORIZED");
      }

      let response: Response;
      try {
        response = await fetchImpl(`${TELEGRAM_BOT_API_ORIGIN}/bot${botToken}/${request.method}`, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(request.body),
          signal: request.signal,
        });
      } catch {
        if (request.signal.aborted) {
          throw new TelegramTransportFailure("ABORTED");
        }
        throw new TelegramTransportFailure(
          request.method === "sendMessage" ? "DELIVERY_OUTCOME_UNKNOWN" : "NETWORK_UNREACHABLE",
        );
      }

      return {
        status: response.status,
        contentLength: contentLength(response),
        body: responseChunks(response.body),
      };
    },
  };
}
