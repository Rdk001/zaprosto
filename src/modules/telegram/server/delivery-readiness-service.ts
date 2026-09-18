import { isTelegramAdapterErrorCode, type TelegramSafeErrorCode } from "../domain/safe-error";
import type { TelegramBotApi } from "./bot-api";
import type { TelegramBotStateStore } from "./bot-state-repository";
import type {
  TelegramRuntimeConfigErrorCode,
  TelegramRuntimeConfiguration,
} from "./runtime-config";

export type TelegramDeliveryVerificationReason =
  TelegramRuntimeConfigErrorCode | TelegramSafeErrorCode | "BOT_STATE_STORAGE_FAILURE";

export type TelegramDeliveryVerificationResult =
  | Readonly<{ status: "DISABLED"; verified: false }>
  | Readonly<{
      status: "NOT_READY";
      verified: false;
      reasonCode: TelegramDeliveryVerificationReason;
      botUsername?: string;
    }>
  | Readonly<{ status: "VERIFIED"; verified: true; botUsername: string }>;

function notReady(
  reasonCode: TelegramDeliveryVerificationReason,
  botUsername?: string,
): TelegramDeliveryVerificationResult {
  return {
    status: "NOT_READY",
    verified: false,
    reasonCode,
    ...(botUsername === undefined ? {} : { botUsername }),
  };
}

function adapterCode(error: unknown): TelegramSafeErrorCode {
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

async function persistIdentityMismatch(state: TelegramBotStateStore): Promise<boolean> {
  try {
    await state.setError("BOT_IDENTITY_MISMATCH");
    return true;
  } catch {
    return false;
  }
}

export async function verifyTelegramDeliveryReadiness(input: {
  configuration: TelegramRuntimeConfiguration;
  api?: Pick<TelegramBotApi, "getMe">;
  state: TelegramBotStateStore;
  clock?: () => Date;
  signal?: AbortSignal;
}): Promise<TelegramDeliveryVerificationResult> {
  const { configuration, state } = input;
  if (configuration.kind === "DISABLED") {
    return { status: "DISABLED", verified: false };
  }
  if (configuration.kind !== "ENABLED") {
    return notReady(configuration.reasonCode);
  }
  if (!input.api) return notReady("CONFIG_UNAUTHORIZED", configuration.botUsername);

  let identity: Awaited<ReturnType<Pick<TelegramBotApi, "getMe">["getMe"]>>;
  try {
    identity = await input.api.getMe({ signal: input.signal });
  } catch (error) {
    return notReady(adapterCode(error), configuration.botUsername);
  }

  if (identity.username.toLowerCase() !== configuration.botUsername.toLowerCase()) {
    return notReady(
      (await persistIdentityMismatch(state))
        ? "BOT_IDENTITY_MISMATCH"
        : "BOT_STATE_STORAGE_FAILURE",
      configuration.botUsername,
    );
  }

  let stored;
  try {
    stored = await state.getState();
  } catch {
    return notReady("BOT_STATE_STORAGE_FAILURE", configuration.botUsername);
  }

  if (stored.botUserId !== null) {
    if (
      stored.botUserId !== identity.id ||
      stored.botUsername === null ||
      stored.botUsername.toLowerCase() !== identity.username.toLowerCase()
    ) {
      return notReady(
        (await persistIdentityMismatch(state))
          ? "BOT_IDENTITY_MISMATCH"
          : "BOT_STATE_STORAGE_FAILURE",
        configuration.botUsername,
      );
    }

    // Polling owns webhook diagnostics and polling freshness. A current getMe proof
    // is sufficient for outbound delivery, so do not clear WEBHOOK_ACTIVE (or any
    // other polling diagnostic) from the shared singleton here.
    return {
      status: "VERIFIED",
      verified: true,
      botUsername: configuration.botUsername,
    };
  }

  let verifiedAt: Date;
  try {
    verifiedAt = (input.clock ?? (() => new Date()))();
    if (!Number.isFinite(verifiedAt.getTime())) {
      return notReady("BOT_STATE_STORAGE_FAILURE", configuration.botUsername);
    }
  } catch {
    return notReady("BOT_STATE_STORAGE_FAILURE", configuration.botUsername);
  }

  try {
    const result = await state.recordVerifiedIdentity({
      botUserId: identity.id,
      botUsername: identity.username,
      verifiedAt,
    });
    if (result === "BOT_IDENTITY_MISMATCH") {
      return notReady("BOT_IDENTITY_MISMATCH", configuration.botUsername);
    }
  } catch {
    return notReady("BOT_STATE_STORAGE_FAILURE", configuration.botUsername);
  }

  return {
    status: "VERIFIED",
    verified: true,
    botUsername: configuration.botUsername,
  };
}
