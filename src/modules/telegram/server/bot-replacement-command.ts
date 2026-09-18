import type { TelegramBotApi } from "./bot-api";
import {
  requireEnabledTelegramReplacementConfiguration,
  TelegramBotReplacementError,
  type TelegramBotReplacementPreflightResult,
  type TelegramBotReplacementSummary,
} from "./bot-replacement-service";
import type { TelegramMaintenanceLockSource } from "./maintenance-lock";
import {
  parseTelegramRuntimeConfiguration,
  type TelegramEnvironment,
  type TelegramRuntimeConfiguration,
} from "./runtime-config";

export const TELEGRAM_REPLACEMENT_CONFIRMATION = "REPLACE TELEGRAM BOT";

export type TelegramBotReplacementCommandCode =
  | "ARGUMENTS_FORBIDDEN"
  | "TTY_REQUIRED"
  | "CONFIRMATION_MISMATCH"
  | "WORKER_ACTIVE"
  | "OPERATION_FAILED";

export class TelegramBotReplacementCommandError extends Error {
  constructor(readonly code: TelegramBotReplacementCommandCode) {
    super(code);
    this.name = "TelegramBotReplacementCommandError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export interface TelegramBotReplacementCommandService {
  preflight(): Promise<TelegramBotReplacementPreflightResult>;
  replace(): Promise<TelegramBotReplacementSummary>;
}

export type TelegramBotReplacementCommandResult =
  { status: "NO_CHANGE" } | TelegramBotReplacementSummary;

export async function runTelegramBotReplacementCommand(input: {
  argv: readonly string[];
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  environment: TelegramEnvironment;
  readConfirmation(maximum: number): Promise<string>;
  write(message: string): void;
  createApi(
    configuration: Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }>,
  ): Pick<TelegramBotApi, "getMe">;
  createService(input: {
    configuration: Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }>;
    api: Pick<TelegramBotApi, "getMe">;
  }): TelegramBotReplacementCommandService;
  maintenance: Pick<TelegramMaintenanceLockSource, "tryAcquireOperator">;
}): Promise<TelegramBotReplacementCommandResult> {
  if (input.argv.length !== 0) {
    throw new TelegramBotReplacementCommandError("ARGUMENTS_FORBIDDEN");
  }
  if (!input.stdinIsTTY || !input.stdoutIsTTY) {
    throw new TelegramBotReplacementCommandError("TTY_REQUIRED");
  }

  const configuration = requireEnabledTelegramReplacementConfiguration(
    parseTelegramRuntimeConfiguration(input.environment),
  );
  const service = input.createService({
    configuration,
    api: input.createApi(configuration),
  });
  const preflight = await service.preflight();
  if (preflight.status === "NO_CHANGE") {
    input.write("NO_CHANGE: сохранённая Telegram bot identity уже совпадает.\n");
    return { status: "NO_CHANGE" };
  }

  input.write(
    "ВНИМАНИЕ: замена необратимо отключит все прежние Telegram-связи, отзовёт ссылки и отменит незавершённые сообщения. Worker должен быть остановлен.\n",
  );
  const confirmation = await input.readConfirmation(TELEGRAM_REPLACEMENT_CONFIRMATION.length);
  if (confirmation !== TELEGRAM_REPLACEMENT_CONFIRMATION) {
    throw new TelegramBotReplacementCommandError("CONFIRMATION_MISMATCH");
  }

  const session = await input.maintenance.tryAcquireOperator();
  if (!session) throw new TelegramBotReplacementCommandError("WORKER_ACTIVE");
  try {
    const result = await service.replace();
    input.write(
      `REPLACED: connections=${result.appointmentConnectionsDisabled + result.adminConnectionsDisabled}, tokens=${result.linkTokensRevoked}, jobs=${result.jobsCancelled}.\n`,
    );
    return result;
  } finally {
    await session.release();
  }
}

export function telegramBotReplacementCommandSafeCode(error: unknown): string {
  if (error instanceof TelegramBotReplacementCommandError) return error.code;
  if (error instanceof TelegramBotReplacementError) return error.code;
  return "OPERATION_FAILED";
}
