import { isTelegramAdapterErrorCode, type TelegramSafeErrorCode } from "../domain/safe-error";
import type { TelegramBotApi } from "./bot-api";
import type { TelegramBotStateStore } from "./bot-state-repository";
import type {
  TelegramRuntimeConfigErrorCode,
  TelegramRuntimeConfiguration,
} from "./runtime-config";

export type TelegramVerificationReason =
  TelegramRuntimeConfigErrorCode | TelegramSafeErrorCode | "BOT_STATE_STORAGE_FAILURE";

export type TelegramVerificationResult =
  | { status: "DISABLED"; verified: false }
  | {
      status: "NOT_READY";
      verified: false;
      reasonCode: TelegramVerificationReason;
      botUsername?: string;
    }
  | { status: "VERIFIED"; verified: true; botUsername: string };

function normalizedAdapterCode(error: unknown): TelegramSafeErrorCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    isTelegramAdapterErrorCode(error.code)
  ) {
    return error.code;
  }
  return "NETWORK_UNREACHABLE";
}

async function persistError(
  state: TelegramBotStateStore,
  code: TelegramSafeErrorCode,
): Promise<boolean> {
  try {
    await state.setError(code);
    return true;
  } catch {
    return false;
  }
}

function notReady(
  reasonCode: TelegramVerificationReason,
  botUsername?: string,
): TelegramVerificationResult {
  return {
    status: "NOT_READY",
    verified: false,
    reasonCode,
    ...(botUsername === undefined ? {} : { botUsername }),
  };
}

export async function verifyTelegramBotReadiness(input: {
  configuration: TelegramRuntimeConfiguration;
  api: TelegramBotApi;
  state: TelegramBotStateStore;
  clock?: () => Date;
}): Promise<TelegramVerificationResult> {
  const { configuration, api, state } = input;

  if (configuration.kind === "DISABLED") {
    return { status: "DISABLED", verified: false };
  }
  if (configuration.kind !== "ENABLED") {
    if (!(await persistError(state, "CONFIG_UNAUTHORIZED"))) {
      return notReady("BOT_STATE_STORAGE_FAILURE");
    }
    return notReady(configuration.reasonCode);
  }

  const botUsername = configuration.botUsername;
  let identity: Awaited<ReturnType<TelegramBotApi["getMe"]>>;
  try {
    identity = await api.getMe();
  } catch (error) {
    const code = normalizedAdapterCode(error);
    if (!(await persistError(state, code)))
      return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
    return notReady(code, botUsername);
  }

  if (identity.username.toLowerCase() !== botUsername.toLowerCase()) {
    if (!(await persistError(state, "BOT_IDENTITY_MISMATCH"))) {
      return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
    }
    return notReady("BOT_IDENTITY_MISMATCH", botUsername);
  }

  let storedState;
  try {
    storedState = await state.getState();
  } catch {
    return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
  }
  if (
    storedState.botUserId !== null &&
    (storedState.botUserId !== identity.id ||
      storedState.botUsername === null ||
      storedState.botUsername.toLowerCase() !== identity.username.toLowerCase())
  ) {
    if (!(await persistError(state, "BOT_IDENTITY_MISMATCH"))) {
      return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
    }
    return notReady("BOT_IDENTITY_MISMATCH", botUsername);
  }

  let webhook;
  try {
    webhook = await api.getWebhookInfo();
  } catch (error) {
    const code = normalizedAdapterCode(error);
    if (!(await persistError(state, code)))
      return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
    return notReady(code, botUsername);
  }
  if (webhook.hasWebhook) {
    if (!(await persistError(state, "WEBHOOK_ACTIVE"))) {
      return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
    }
    return notReady("WEBHOOK_ACTIVE", botUsername);
  }

  let verifiedAt: Date;
  try {
    verifiedAt = (input.clock ?? (() => new Date()))();
    if (!Number.isFinite(verifiedAt.getTime())) {
      return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
    }
  } catch {
    return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
  }

  try {
    const result = await state.recordVerifiedIdentity({
      botUserId: identity.id,
      botUsername: identity.username,
      verifiedAt,
    });
    if (result === "BOT_IDENTITY_MISMATCH") {
      return notReady("BOT_IDENTITY_MISMATCH", botUsername);
    }
  } catch {
    return notReady("BOT_STATE_STORAGE_FAILURE", botUsername);
  }

  return { status: "VERIFIED", verified: true, botUsername };
}
