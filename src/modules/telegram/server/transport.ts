export const TELEGRAM_METHODS = [
  "getMe",
  "getWebhookInfo",
  "deleteWebhook",
  "getUpdates",
  "sendMessage",
] as const;

export type TelegramMethod = (typeof TELEGRAM_METHODS)[number];

export type TelegramTransportRequest = {
  method: TelegramMethod;
  body: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
};

export type TelegramTransportResponse = {
  status: number;
  contentLength: number | null;
  body: Uint8Array | AsyncIterable<Uint8Array>;
};

export interface TelegramTransport {
  request(input: TelegramTransportRequest): Promise<TelegramTransportResponse>;
}

export type TelegramTransportFailureKind =
  "NETWORK_UNREACHABLE" | "DELIVERY_OUTCOME_UNKNOWN" | "CONFIG_UNAUTHORIZED" | "ABORTED";

export class TelegramTransportFailure extends Error {
  readonly kind: TelegramTransportFailureKind;

  constructor(kind: TelegramTransportFailureKind) {
    super("TELEGRAM_TRANSPORT_FAILURE");
    this.name = "TelegramTransportFailure";
    this.kind = kind;
  }

  toJSON() {
    return { name: this.name, kind: this.kind } as const;
  }
}
