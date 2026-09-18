import { z } from "zod";

import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import type { TelegramBotApi } from "./bot-api";
import type { TelegramRuntimeConfiguration } from "./runtime-config";

const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 10_000,
} as const;

const stateRowSchema = z.object({
  botUserId: z.bigint().nullable(),
  botUsername: z.string().nullable(),
});
const countSchema = z.number().int().nonnegative().max(2_147_483_647);

export type TelegramBotReplacementSafeCode =
  | "CONFIG_DISABLED"
  | "CONFIG_INCOMPLETE"
  | "CONFIG_INVALID"
  | "BOT_VERIFICATION_FAILED"
  | "BOT_USERNAME_MISMATCH"
  | "BOT_STATE_UNINITIALIZED"
  | "BOT_STATE_CONFLICT"
  | "SAME_BOT_USERNAME_CHANGED"
  | "REPLACEMENT_STORAGE_FAILURE";

export class TelegramBotReplacementError extends Error {
  constructor(readonly code: TelegramBotReplacementSafeCode) {
    super(code);
    this.name = "TelegramBotReplacementError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export type TelegramBotReplacementPreflightResult = { status: "READY" } | { status: "NO_CHANGE" };

export type TelegramBotReplacementSummary = Readonly<{
  status: "REPLACED";
  appointmentConnectionsDisabled: number;
  adminConnectionsDisabled: number;
  linkTokensRevoked: number;
  jobsCancelled: number;
}>;

type PreparedReplacement = {
  oldBotUserId: bigint;
  oldBotUsername: string;
  newBotUserId: bigint;
  newBotUsername: string;
};

export function requireEnabledTelegramReplacementConfiguration(
  configuration: TelegramRuntimeConfiguration,
): Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }> {
  if (configuration.kind === "DISABLED") {
    throw new TelegramBotReplacementError("CONFIG_DISABLED");
  }
  if (configuration.kind !== "ENABLED") {
    throw new TelegramBotReplacementError(
      configuration.kind === "INCOMPLETE" ? "CONFIG_INCOMPLETE" : "CONFIG_INVALID",
    );
  }
  return configuration;
}

export class TelegramBotReplacementService {
  private prepared: PreparedReplacement | null = null;

  constructor(
    private readonly database: PrismaClient,
    private readonly api: Pick<TelegramBotApi, "getMe">,
    private readonly configuration: Extract<TelegramRuntimeConfiguration, { kind: "ENABLED" }>,
    private readonly testHooks: { beforeCommit?: () => Promise<void> } = {},
  ) {}

  async preflight(): Promise<TelegramBotReplacementPreflightResult> {
    let actual: Awaited<ReturnType<TelegramBotApi["getMe"]>>;
    try {
      actual = await this.api.getMe();
    } catch {
      throw new TelegramBotReplacementError("BOT_VERIFICATION_FAILED");
    }
    if (actual.username.toLowerCase() !== this.configuration.botUsername.toLowerCase()) {
      throw new TelegramBotReplacementError("BOT_USERNAME_MISMATCH");
    }

    let rawState: unknown;
    try {
      rawState = await this.database.telegramBotState.findUnique({
        where: { id: 1 },
        select: { botUserId: true, botUsername: true },
      });
    } catch {
      throw new TelegramBotReplacementError("REPLACEMENT_STORAGE_FAILURE");
    }
    const parsed = stateRowSchema.safeParse(rawState);
    if (!parsed.success || parsed.data.botUserId === null || parsed.data.botUsername === null) {
      throw new TelegramBotReplacementError("BOT_STATE_UNINITIALIZED");
    }
    if (
      parsed.data.botUserId === actual.id &&
      parsed.data.botUsername.toLowerCase() === actual.username.toLowerCase()
    ) {
      this.prepared = null;
      return { status: "NO_CHANGE" };
    }
    if (parsed.data.botUserId === actual.id) {
      throw new TelegramBotReplacementError("SAME_BOT_USERNAME_CHANGED");
    }
    this.prepared = {
      oldBotUserId: parsed.data.botUserId,
      oldBotUsername: parsed.data.botUsername,
      newBotUserId: actual.id,
      newBotUsername: actual.username,
    };
    return { status: "READY" };
  }

  async replace(): Promise<TelegramBotReplacementSummary> {
    const prepared = this.prepared;
    this.prepared = null;
    if (!prepared) throw new TelegramBotReplacementError("BOT_STATE_CONFLICT");

    try {
      return await this.database.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
        const [rawState] = await tx.$queryRaw<unknown[]>`
          SELECT bot_user_id AS "botUserId", bot_username AS "botUsername"
          FROM telegram_bot_state
          WHERE id = 1
          FOR UPDATE
        `;
        const state = stateRowSchema.safeParse(rawState);
        if (
          !state.success ||
          state.data.botUserId !== prepared.oldBotUserId ||
          state.data.botUsername !== prepared.oldBotUsername
        ) {
          throw new TelegramBotReplacementError("BOT_STATE_CONFLICT");
        }
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp()::timestamptz(3) AS now
        `;
        if (!(clock?.now instanceof Date) || Number.isNaN(clock.now.getTime())) {
          throw new Error("INVALID_DATABASE_TIME");
        }
        const now = clock.now;

        const appointmentConnectionsDisabled = await tx.$executeRaw`
          UPDATE appointment_telegram_connections
          SET disabled_at = ${now}, disabled_reason = 'BOT_REPLACED'::"TelegramConnectionDisabledReason"
          WHERE disabled_at IS NULL
        `;
        const adminConnectionsDisabled = await tx.$executeRaw`
          UPDATE admin_telegram_connections
          SET disabled_at = ${now}, disabled_reason = 'BOT_REPLACED'::"TelegramConnectionDisabledReason"
          WHERE disabled_at IS NULL
        `;
        const linkTokensRevoked = await tx.$executeRaw`
          UPDATE telegram_link_tokens
          SET revoked_at = ${now}
          WHERE used_at IS NULL AND revoked_at IS NULL
        `;
        const jobsCancelled = await tx.$executeRaw`
          UPDATE notification_outbox
          SET status = 'CANCELLED'::"NotificationStatus",
              invalidated_at = ${now}, invalidation_code = 'BOT_REPLACED', finished_at = ${now},
              lease_token = NULL, lease_owner = NULL, claimed_at = NULL, lease_expires_at = NULL,
              updated_at = ${now}
          WHERE status IN ('PENDING'::"NotificationStatus", 'PROCESSING'::"NotificationStatus")
        `;
        await tx.$executeRaw`
          UPDATE telegram_bot_state
          SET bot_user_id = ${prepared.newBotUserId}, bot_username = ${prepared.newBotUsername},
              next_update_id = 0, last_verified_at = NULL, last_poll_at = NULL,
              last_error_code = NULL, updated_at = ${now}
          WHERE id = 1
        `;
        await this.testHooks.beforeCommit?.();

        return {
          status: "REPLACED",
          appointmentConnectionsDisabled: countSchema.parse(appointmentConnectionsDisabled),
          adminConnectionsDisabled: countSchema.parse(adminConnectionsDisabled),
          linkTokensRevoked: countSchema.parse(linkTokensRevoked),
          jobsCancelled: countSchema.parse(jobsCancelled),
        };
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof TelegramBotReplacementError) throw error;
      throw new TelegramBotReplacementError("REPLACEMENT_STORAGE_FAILURE");
    }
  }
}
