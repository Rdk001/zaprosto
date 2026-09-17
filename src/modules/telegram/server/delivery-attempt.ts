import type { TelegramAdapterErrorCode } from "../domain/safe-error";
import { TelegramBotApiError, type TelegramBotApi } from "./bot-api";
import type {
  TelegramDeliveryPreflight,
  TelegramDeliveryPreflightInput,
} from "./delivery-preflight";
import type { FinishOutboxInput, OutboxTransitionResult } from "./outbox-contract";
import type { TelegramOutboxRepository } from "./outbox-repository";

export type TelegramDeliveryAttemptInput = TelegramDeliveryPreflightInput & {
  signal?: AbortSignal;
};

export type TelegramDeliveryAttemptResult =
  | Readonly<{ kind: "PREFLIGHT_LEASE_LOST" }>
  | Readonly<{ kind: "FINISHED"; finish: OutboxTransitionResult }>;

type DeliveryPreflight = Pick<TelegramDeliveryPreflight, "check">;
type DeliveryApi = Pick<TelegramBotApi, "sendMessage">;
type DeliveryOutbox = Pick<TelegramOutboxRepository, "finish">;

const retryableCodes = new Set<TelegramAdapterErrorCode>([
  "NETWORK_UNREACHABLE",
  "DELIVERY_OUTCOME_UNKNOWN",
  "TELEGRAM_RATE_LIMIT",
  "TELEGRAM_5XX",
  "RESPONSE_INVALID",
  "RESPONSE_TOO_LARGE",
]);

const deadCodes = new Set<TelegramAdapterErrorCode>([
  "INVALID_REQUEST",
  "CHAT_NOT_FOUND",
  "BOT_BLOCKED",
  "CHAT_WRITE_FORBIDDEN",
  "TELEGRAM_USER_DEACTIVATED",
]);

function deliveryFailureCommand(id: string, leaseToken: string, error: unknown): FinishOutboxInput {
  if (!(error instanceof TelegramBotApiError)) {
    return { id, leaseToken, outcome: "RETRY", errorCode: "DELIVERY_OUTCOME_UNKNOWN" };
  }
  if (error.code === "CONFIG_UNAUTHORIZED") {
    return { id, leaseToken, outcome: "CONFIGURATION_FAILURE", errorCode: error.code };
  }
  if (deadCodes.has(error.code)) {
    return {
      id,
      leaseToken,
      outcome: "DEAD",
      errorCode: error.code as Extract<FinishOutboxInput, { outcome: "DEAD" }>["errorCode"],
    };
  }
  if (retryableCodes.has(error.code)) {
    return {
      id,
      leaseToken,
      outcome: "RETRY",
      errorCode: error.code as Extract<FinishOutboxInput, { outcome: "RETRY" }>["errorCode"],
      ...(error.code === "TELEGRAM_RATE_LIMIT" && error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
  return { id, leaseToken, outcome: "RETRY", errorCode: "DELIVERY_OUTCOME_UNKNOWN" };
}

export class TelegramDeliveryAttempt {
  constructor(
    private readonly dependencies: {
      preflight: DeliveryPreflight;
      api: DeliveryApi;
      outbox: DeliveryOutbox;
    },
  ) {}

  async run(input: TelegramDeliveryAttemptInput): Promise<TelegramDeliveryAttemptResult> {
    const { jobId, leaseToken } = input;
    const preflight = await this.dependencies.preflight.check({ jobId, leaseToken });

    if (preflight.kind === "LEASE_LOST") return { kind: "PREFLIGHT_LEASE_LOST" };

    let command: FinishOutboxInput;
    if (preflight.kind === "SKIP") {
      command = { id: jobId, leaseToken, outcome: "SKIPPED", errorCode: preflight.code };
    } else if (preflight.kind === "DEAD") {
      command = { id: jobId, leaseToken, outcome: "DEAD", errorCode: preflight.code };
    } else {
      try {
        await this.dependencies.api.sendMessage(
          { chatId: preflight.chatId, text: preflight.text },
          input.signal === undefined ? undefined : { signal: input.signal },
        );
        command = { id: jobId, leaseToken, outcome: "SENT" };
      } catch (error) {
        command = deliveryFailureCommand(jobId, leaseToken, error);
      }
    }

    return { kind: "FINISHED", finish: await this.dependencies.outbox.finish(command) };
  }
}
