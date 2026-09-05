import {
  TelegramTransportFailure,
  type TelegramMethod,
  type TelegramTransport,
  type TelegramTransportRequest,
  type TelegramTransportResponse,
} from "./transport";

export type FakeTelegramTransportStep =
  | {
      kind: "RESPONSE";
      status?: number;
      body: unknown | string | Uint8Array;
      contentLength?: number | null;
      chunkSize?: number;
    }
  | { kind: "NETWORK_FAILURE" }
  | { kind: "DELIVERY_OUTCOME_UNKNOWN" }
  | { kind: "WAIT_FOR_ABORT" };

export type FakeTelegramTransportCall = {
  method: TelegramMethod;
  body: Readonly<Record<string, unknown>>;
};

function bytesFor(body: unknown | string | Uint8Array): Uint8Array {
  if (body instanceof Uint8Array) {
    return body;
  }
  return new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
}

async function* chunks(bytes: Uint8Array, chunkSize: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAborted = () => reject(new TelegramTransportFailure("ABORTED"));
    if (signal.aborted) {
      rejectAborted();
      return;
    }
    signal.addEventListener("abort", rejectAborted, { once: true });
  });
}

export class FakeTelegramTransport implements TelegramTransport {
  readonly calls: FakeTelegramTransportCall[] = [];
  readonly #steps: FakeTelegramTransportStep[];

  constructor(steps: readonly FakeTelegramTransportStep[]) {
    this.#steps = [...steps];
  }

  async request(input: TelegramTransportRequest): Promise<TelegramTransportResponse> {
    this.calls.push({ method: input.method, body: structuredClone(input.body) });
    const step = this.#steps.shift();
    if (step === undefined) {
      throw new TelegramTransportFailure("NETWORK_UNREACHABLE");
    }

    if (step.kind === "NETWORK_FAILURE") {
      throw new TelegramTransportFailure("NETWORK_UNREACHABLE");
    }
    if (step.kind === "DELIVERY_OUTCOME_UNKNOWN") {
      throw new TelegramTransportFailure("DELIVERY_OUTCOME_UNKNOWN");
    }
    if (step.kind === "WAIT_FOR_ABORT") {
      return waitForAbort(input.signal);
    }

    const bytes = bytesFor(step.body);
    const chunkSize = step.chunkSize ?? Math.max(1, bytes.byteLength);
    return {
      status: step.status ?? 200,
      contentLength: step.contentLength === undefined ? bytes.byteLength : step.contentLength,
      body: chunks(bytes, chunkSize),
    };
  }

  get remainingSteps(): number {
    return this.#steps.length;
  }
}
