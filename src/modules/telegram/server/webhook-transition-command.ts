import type { TelegramBotApi } from "./bot-api";
import type { TelegramMaintenanceLockSource } from "./maintenance-lock";
import {
  parseTelegramRuntimeConfiguration,
  type TelegramEnvironment,
  type TelegramRuntimeConfiguration,
} from "./runtime-config";
import {
  requireEnabledTelegramWebhookTransitionConfiguration,
  TelegramWebhookTransitionError,
  type TelegramWebhookTransitionResult,
} from "./webhook-transition-service";

export const TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION = "DELETE TELEGRAM WEBHOOK";

export type TelegramWebhookTransitionCommandCode =
  | "ARGUMENTS_FORBIDDEN"
  | "TTY_REQUIRED"
  | "CONFIRMATION_MISMATCH"
  | "WORKER_ACTIVE"
  | "OPERATION_FAILED";

export class TelegramWebhookTransitionCommandError extends Error {
  constructor(readonly code: TelegramWebhookTransitionCommandCode) {
    super(code);
    this.name = "TelegramWebhookTransitionCommandError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export interface TelegramWebhookTransitionCommandService {
  transition(input: { signal: AbortSignal }): Promise<TelegramWebhookTransitionResult>;
}

export async function runTelegramWebhookTransitionCommand(input: {
  argv: readonly string[];
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  environment: TelegramEnvironment;
  readConfirmation(maximum: number): Promise<string>;
  write(message: string): void;
  createApi(
    configuration: Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }>,
  ): Pick<TelegramBotApi, "getMe" | "getWebhookInfo" | "deleteWebhook">;
  createService(input: {
    configuration: Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }>;
    api: Pick<TelegramBotApi, "getMe" | "getWebhookInfo" | "deleteWebhook">;
  }): TelegramWebhookTransitionCommandService;
  maintenance: Pick<TelegramMaintenanceLockSource, "tryAcquireOperator">;
}): Promise<TelegramWebhookTransitionResult> {
  if (input.argv.length !== 0) {
    throw new TelegramWebhookTransitionCommandError("ARGUMENTS_FORBIDDEN");
  }
  if (!input.stdinIsTTY || !input.stdoutIsTTY) {
    throw new TelegramWebhookTransitionCommandError("TTY_REQUIRED");
  }

  const configuration = requireEnabledTelegramWebhookTransitionConfiguration(
    parseTelegramRuntimeConfiguration(input.environment),
  );
  input.write(
    "ВНИМАНИЕ: внешний Telegram webhook будет удалён, pending updates сохранятся, а после запуска worker перейдёт к long polling.\n",
  );
  const confirmation = await input.readConfirmation(
    TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION.length,
  );
  if (confirmation !== TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION) {
    throw new TelegramWebhookTransitionCommandError("CONFIRMATION_MISMATCH");
  }

  const session = await input.maintenance.tryAcquireOperator();
  if (!session) throw new TelegramWebhookTransitionCommandError("WORKER_ACTIVE");
  try {
    const api = input.createApi(configuration);
    const service = input.createService({ configuration, api });
    const result = await service.transition({ signal: session.signal });
    input.write(
      result.status === "NO_CHANGE"
        ? "NO_CHANGE: Telegram webhook уже отсутствует.\n"
        : "TRANSITIONED: удаление Telegram webhook подтверждено.\n",
    );
    return result;
  } finally {
    await session.release();
  }
}

export function telegramWebhookTransitionCommandSafeCode(error: unknown): string {
  if (error instanceof TelegramWebhookTransitionCommandError) return error.code;
  if (error instanceof TelegramWebhookTransitionError) return error.code;
  return "OPERATION_FAILED";
}
