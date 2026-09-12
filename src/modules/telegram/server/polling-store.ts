import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import type { TelegramSafeErrorCode } from "../domain/safe-error";
import type { TelegramUpdate } from "./bot-api";
import { parseTelegramStartCommand } from "./start-command-parser";
import { processTelegramStart } from "./start-processor";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 10_000,
} as const;

type LockedOffsetRow = { nextUpdateId: bigint };

export type TelegramPollCommitResult =
  | Readonly<{ kind: "COMMITTED"; nextExpectedOffset: bigint }>
  | Readonly<{ kind: "OFFSET_CONFLICT" }>;

export interface TelegramPollingStore {
  getOffset(): Promise<bigint>;
  setError(code: TelegramSafeErrorCode): Promise<void>;
  recordEmptyPoll(expectedOffset: bigint): Promise<TelegramPollCommitResult>;
  processUpdate(input: {
    update: TelegramUpdate;
    expectedOffset: bigint;
    botUsername: string;
  }): Promise<TelegramPollCommitResult>;
}

export class TelegramPollingStoreError extends Error {
  constructor(readonly code: "POLL_STORAGE_FAILURE") {
    super(code);
    this.name = "TelegramPollingStoreError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

class OffsetConflict extends Error {}

type PollingStoreOptions = {
  beforeOffsetUpdate?: (tx: Prisma.TransactionClient, update: TelegramUpdate) => Promise<void>;
  processStart?: typeof processTelegramStart;
};

async function lockedOffset(tx: Prisma.TransactionClient): Promise<bigint> {
  const rows = await tx.$queryRaw<LockedOffsetRow[]>(Prisma.sql`
    SELECT next_update_id AS "nextUpdateId"
    FROM telegram_bot_state
    WHERE id = 1
    FOR UPDATE
  `);
  const value = rows.length === 1 ? rows[0]?.nextUpdateId : undefined;
  if (typeof value !== "bigint" || value < 0n)
    throw new TelegramPollingStoreError("POLL_STORAGE_FAILURE");
  return value;
}

async function updatePollState(
  tx: Prisma.TransactionClient,
  nextUpdateId: bigint | undefined,
): Promise<void> {
  const changed =
    nextUpdateId === undefined
      ? await tx.$executeRaw(Prisma.sql`
          UPDATE telegram_bot_state
          SET last_poll_at = clock_timestamp()::timestamptz(3),
              last_error_code = NULL,
              updated_at = clock_timestamp()::timestamptz(3)
          WHERE id = 1
        `)
      : await tx.$executeRaw(Prisma.sql`
          UPDATE telegram_bot_state
          SET next_update_id = ${nextUpdateId},
              last_poll_at = clock_timestamp()::timestamptz(3),
              last_error_code = NULL,
              updated_at = clock_timestamp()::timestamptz(3)
          WHERE id = 1
        `);
  if (changed !== 1) throw new TelegramPollingStoreError("POLL_STORAGE_FAILURE");
}

export class PrismaTelegramPollingStore implements TelegramPollingStore {
  private readonly processStart: typeof processTelegramStart;

  constructor(
    private readonly database: PrismaClient,
    private readonly options: PollingStoreOptions = {},
  ) {
    this.processStart = options.processStart ?? processTelegramStart;
  }

  async getOffset(): Promise<bigint> {
    try {
      const row = await this.database.telegramBotState.findUnique({
        where: { id: 1 },
        select: { nextUpdateId: true },
      });
      if (!row || typeof row.nextUpdateId !== "bigint" || row.nextUpdateId < 0n) {
        throw new TelegramPollingStoreError("POLL_STORAGE_FAILURE");
      }
      return row.nextUpdateId;
    } catch (error) {
      if (error instanceof TelegramPollingStoreError) throw error;
      throw new TelegramPollingStoreError("POLL_STORAGE_FAILURE");
    }
  }

  async setError(code: TelegramSafeErrorCode): Promise<void> {
    try {
      await this.database.telegramBotState.update({
        where: { id: 1 },
        data: { lastErrorCode: code },
      });
    } catch {
      throw new TelegramPollingStoreError("POLL_STORAGE_FAILURE");
    }
  }

  async recordEmptyPoll(expectedOffset: bigint): Promise<TelegramPollCommitResult> {
    return this.transactional(expectedOffset, async (tx, storedOffset) => {
      await updatePollState(tx, undefined);
      return storedOffset;
    });
  }

  async processUpdate(input: {
    update: TelegramUpdate;
    expectedOffset: bigint;
    botUsername: string;
  }): Promise<TelegramPollCommitResult> {
    const { update, expectedOffset, botUsername } = input;
    if (
      typeof update.updateId !== "bigint" ||
      update.updateId < 0n ||
      update.updateId >= MAX_POSTGRES_BIGINT
    ) {
      throw new TelegramPollingStoreError("POLL_STORAGE_FAILURE");
    }

    return this.transactional(expectedOffset, async (tx, storedOffset) => {
      if (update.updateId < storedOffset) {
        await updatePollState(tx, undefined);
        return storedOffset;
      }

      const parsed = parseTelegramStartCommand(update, botUsername);
      if (parsed.kind === "PARSED") await this.processStart(tx, parsed.value);
      await this.options.beforeOffsetUpdate?.(tx, update);

      const nextUpdateId = update.updateId + 1n;
      await updatePollState(tx, nextUpdateId);
      return nextUpdateId;
    });
  }

  private async transactional(
    expectedOffset: bigint,
    operation: (tx: Prisma.TransactionClient, storedOffset: bigint) => Promise<bigint>,
  ): Promise<TelegramPollCommitResult> {
    if (typeof expectedOffset !== "bigint" || expectedOffset < 0n) {
      throw new TelegramPollingStoreError("POLL_STORAGE_FAILURE");
    }
    try {
      const nextExpectedOffset = await this.database.$transaction(async (tx) => {
        const storedOffset = await lockedOffset(tx);
        if (storedOffset !== expectedOffset) throw new OffsetConflict();
        return operation(tx, storedOffset);
      }, TRANSACTION_OPTIONS);
      return { kind: "COMMITTED", nextExpectedOffset };
    } catch (error) {
      if (error instanceof OffsetConflict) {
        try {
          await this.setError("POLL_OFFSET_CONFLICT");
        } catch {
          // The conflict remains the authoritative outcome even if diagnostics cannot be persisted.
        }
        return { kind: "OFFSET_CONFLICT" };
      }
      if (error instanceof TelegramPollingStoreError) throw error;
      throw new TelegramPollingStoreError("POLL_STORAGE_FAILURE");
    }
  }
}
