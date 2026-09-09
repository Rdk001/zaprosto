import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import { isTelegramBotUsername } from "../domain/config-contract";
import { isTelegramSafeErrorCode, type TelegramSafeErrorCode } from "../domain/safe-error";

const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5000,
  timeout: 5000,
} as const;

export type TelegramBotStateSnapshot = {
  botUserId: bigint | null;
  botUsername: string | null;
  nextUpdateId: bigint;
  lastVerifiedAt: Date | null;
  lastPollAt: Date | null;
  lastErrorCode: TelegramSafeErrorCode | null;
};

export interface TelegramBotStateStore {
  getState(): Promise<TelegramBotStateSnapshot>;
  setError(code: TelegramSafeErrorCode): Promise<void>;
  recordVerifiedIdentity(input: {
    botUserId: bigint;
    botUsername: string;
    verifiedAt: Date;
  }): Promise<"VERIFIED" | "BOT_IDENTITY_MISMATCH">;
}

export class TelegramBotStateError extends Error {
  constructor(
    readonly code:
      "BOT_STATE_INPUT_INVALID" | "BOT_STATE_STORAGE_FAILURE" | "BOT_STATE_DATA_INVALID",
  ) {
    super(code);
    this.name = "TelegramBotStateError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

type BotStateRow = {
  botUserId: bigint | null;
  botUsername: string | null;
  nextUpdateId: bigint;
  lastVerifiedAt: Date | null;
  lastPollAt: Date | null;
  lastErrorCode: string | null;
};

function validDate(value: Date): boolean {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getTime() >= 0 &&
    value.getUTCFullYear() <= 9999
  );
}

function checkedState(row: BotStateRow | null): TelegramBotStateSnapshot {
  if (
    row === null ||
    typeof row.nextUpdateId !== "bigint" ||
    row.nextUpdateId < 0n ||
    (row.botUserId === null) !== (row.botUsername === null) ||
    (row.botUserId !== null &&
      (typeof row.botUserId !== "bigint" ||
        row.botUserId <= 0n ||
        row.botUsername === null ||
        !isTelegramBotUsername(row.botUsername))) ||
    (row.lastVerifiedAt !== null && !validDate(row.lastVerifiedAt)) ||
    (row.lastPollAt !== null && !validDate(row.lastPollAt)) ||
    (row.lastErrorCode !== null && !isTelegramSafeErrorCode(row.lastErrorCode))
  ) {
    throw new TelegramBotStateError("BOT_STATE_DATA_INVALID");
  }

  return {
    botUserId: row.botUserId,
    botUsername: row.botUsername,
    nextUpdateId: row.nextUpdateId,
    lastVerifiedAt: row.lastVerifiedAt,
    lastPollAt: row.lastPollAt,
    lastErrorCode: row.lastErrorCode,
  };
}

function checkedIdentity(input: { botUserId: bigint; botUsername: string; verifiedAt: Date }) {
  if (
    typeof input.botUserId !== "bigint" ||
    input.botUserId <= 0n ||
    input.botUserId > BigInt(Number.MAX_SAFE_INTEGER) ||
    !isTelegramBotUsername(input.botUsername) ||
    !validDate(input.verifiedAt)
  ) {
    throw new TelegramBotStateError("BOT_STATE_INPUT_INVALID");
  }
  return input;
}

function storageFailure(error: unknown): never {
  if (error instanceof TelegramBotStateError) throw error;
  throw new TelegramBotStateError("BOT_STATE_STORAGE_FAILURE");
}

export class TelegramBotStateRepository implements TelegramBotStateStore {
  constructor(private readonly database: PrismaClient) {}

  async getState(): Promise<TelegramBotStateSnapshot> {
    try {
      const row = await this.database.telegramBotState.findUnique({
        where: { id: 1 },
        select: {
          botUserId: true,
          botUsername: true,
          nextUpdateId: true,
          lastVerifiedAt: true,
          lastPollAt: true,
          lastErrorCode: true,
        },
      });
      return checkedState(row);
    } catch (error) {
      storageFailure(error);
    }
  }

  async setError(code: TelegramSafeErrorCode): Promise<void> {
    if (!isTelegramSafeErrorCode(code)) {
      throw new TelegramBotStateError("BOT_STATE_INPUT_INVALID");
    }
    try {
      await this.database.telegramBotState.update({
        where: { id: 1 },
        data: { lastErrorCode: code },
      });
    } catch (error) {
      storageFailure(error);
    }
  }

  async recordVerifiedIdentity(input: {
    botUserId: bigint;
    botUsername: string;
    verifiedAt: Date;
  }): Promise<"VERIFIED" | "BOT_IDENTITY_MISMATCH"> {
    const identity = checkedIdentity(input);
    try {
      return await this.database.$transaction(async (transaction) => {
        const rows = await transaction.$queryRaw<BotStateRow[]>(Prisma.sql`
          SELECT
            bot_user_id AS "botUserId",
            bot_username AS "botUsername",
            next_update_id AS "nextUpdateId",
            last_verified_at AS "lastVerifiedAt",
            last_poll_at AS "lastPollAt",
            last_error_code AS "lastErrorCode"
          FROM telegram_bot_state
          WHERE id = 1
          FOR UPDATE
        `);
        const state = checkedState(rows.length === 1 ? rows[0]! : null);

        if (state.botUserId !== null) {
          if (
            state.botUserId !== identity.botUserId ||
            state.botUsername === null ||
            state.botUsername.toLowerCase() !== identity.botUsername.toLowerCase()
          ) {
            await transaction.telegramBotState.update({
              where: { id: 1 },
              data: { lastErrorCode: "BOT_IDENTITY_MISMATCH" },
            });
            return "BOT_IDENTITY_MISMATCH";
          }

          await transaction.telegramBotState.update({
            where: { id: 1 },
            data: {
              lastVerifiedAt: identity.verifiedAt,
              lastErrorCode: null,
            },
          });
          return "VERIFIED";
        }

        await transaction.telegramBotState.update({
          where: { id: 1 },
          data: {
            botUserId: identity.botUserId,
            botUsername: identity.botUsername,
            lastVerifiedAt: identity.verifiedAt,
            lastErrorCode: null,
          },
        });
        return "VERIFIED";
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      storageFailure(error);
    }
  }
}
