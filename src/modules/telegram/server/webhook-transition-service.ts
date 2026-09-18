import { isTelegramAdapterErrorCode, type TelegramSafeErrorCode } from "../domain/safe-error";
import type { TelegramBotApi } from "./bot-api";
import type { TelegramBotStateStore } from "./bot-state-repository";
import type { TelegramRuntimeConfiguration } from "./runtime-config";

export type TelegramWebhookTransitionSafeCode =
  | "CONFIG_DISABLED"
  | "CONFIG_INCOMPLETE"
  | "CONFIG_INVALID"
  | "BOT_STATE_STORAGE_FAILURE"
  | "BOT_STATE_UNINITIALIZED"
  | "BOT_IDENTITY_MISMATCH"
  | "BOT_USERNAME_MISMATCH"
  | "MAINTENANCE_SESSION_LOST"
  | "TRANSITION_UNCONFIRMED"
  | "OPERATION_FAILED"
  | TelegramSafeErrorCode;

export class TelegramWebhookTransitionError extends Error {
  constructor(readonly code: TelegramWebhookTransitionSafeCode) {
    super(code);
    this.name = "TelegramWebhookTransitionError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export type TelegramWebhookTransitionResult =
  Readonly<{ status: "NO_CHANGE" }> | Readonly<{ status: "TRANSITIONED" }>;

export function requireEnabledTelegramWebhookTransitionConfiguration(
  configuration: TelegramRuntimeConfiguration,
): Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }> {
  if (configuration.kind === "DISABLED") {
    throw new TelegramWebhookTransitionError("CONFIG_DISABLED");
  }
  if (configuration.kind !== "ENABLED") {
    throw new TelegramWebhookTransitionError(
      configuration.kind === "INCOMPLETE" ? "CONFIG_INCOMPLETE" : "CONFIG_INVALID",
    );
  }
  return configuration;
}

function apiFailure(error: unknown, signal: AbortSignal): TelegramWebhookTransitionError {
  if (signal.aborted) {
    return new TelegramWebhookTransitionError("MAINTENANCE_SESSION_LOST");
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    isTelegramAdapterErrorCode(error.code)
  ) {
    return new TelegramWebhookTransitionError(error.code);
  }
  return new TelegramWebhookTransitionError("OPERATION_FAILED");
}

function requireActiveSession(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TelegramWebhookTransitionError("MAINTENANCE_SESSION_LOST");
  }
}

export class TelegramWebhookTransitionService {
  constructor(
    private readonly state: Pick<TelegramBotStateStore, "getState">,
    private readonly api: Pick<TelegramBotApi, "getMe" | "getWebhookInfo" | "deleteWebhook">,
    private readonly configuration: Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }>,
  ) {}

  async transition(input: { signal: AbortSignal }): Promise<TelegramWebhookTransitionResult> {
    const { signal } = input;
    requireActiveSession(signal);

    let actual: Awaited<ReturnType<TelegramBotApi["getMe"]>>;
    try {
      actual = await this.api.getMe({ signal });
    } catch (error) {
      throw apiFailure(error, signal);
    }
    requireActiveSession(signal);

    if (actual.username.toLowerCase() !== this.configuration.botUsername.toLowerCase()) {
      throw new TelegramWebhookTransitionError("BOT_USERNAME_MISMATCH");
    }

    let stored: Awaited<ReturnType<TelegramBotStateStore["getState"]>>;
    try {
      stored = await this.state.getState();
    } catch {
      throw new TelegramWebhookTransitionError("BOT_STATE_STORAGE_FAILURE");
    }
    requireActiveSession(signal);
    if (stored.botUserId === null || stored.botUsername === null) {
      throw new TelegramWebhookTransitionError("BOT_STATE_UNINITIALIZED");
    }
    if (
      stored.botUserId !== actual.id ||
      stored.botUsername.toLowerCase() !== actual.username.toLowerCase()
    ) {
      throw new TelegramWebhookTransitionError("BOT_IDENTITY_MISMATCH");
    }

    let webhook: Awaited<ReturnType<TelegramBotApi["getWebhookInfo"]>>;
    try {
      webhook = await this.api.getWebhookInfo({ signal });
    } catch (error) {
      throw apiFailure(error, signal);
    }
    requireActiveSession(signal);
    if (!webhook.hasWebhook) return { status: "NO_CHANGE" };

    try {
      await this.api.deleteWebhook({ dropPendingUpdates: false }, { signal });
    } catch (error) {
      throw apiFailure(error, signal);
    }

    if (signal.aborted) {
      throw new TelegramWebhookTransitionError("TRANSITION_UNCONFIRMED");
    }
    try {
      const postCheck = await this.api.getWebhookInfo({ signal });
      if (signal.aborted || postCheck.hasWebhook) {
        throw new TelegramWebhookTransitionError("TRANSITION_UNCONFIRMED");
      }
    } catch (error) {
      if (
        error instanceof TelegramWebhookTransitionError &&
        error.code === "TRANSITION_UNCONFIRMED"
      ) {
        throw error;
      }
      throw new TelegramWebhookTransitionError("TRANSITION_UNCONFIRMED");
    }

    return { status: "TRANSITIONED" };
  }
}
