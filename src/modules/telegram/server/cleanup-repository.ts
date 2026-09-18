import { z } from "zod";

import { Prisma, type PrismaClient } from "../../../generated/prisma/client";

export const TELEGRAM_CLEANUP_MAX_BATCH_SIZE = 500;

const cleanupInputSchema = z.object({
  batchSize: z.number().int().positive().max(TELEGRAM_CLEANUP_MAX_BATCH_SIZE),
  now: z.date().optional(),
});

export type TelegramCleanupResult = Readonly<{
  deletedDirectRejectedOutbox: number;
  deletedOtherOutbox: number;
  deletedLinkTokens: number;
  deletedDisabledAppointmentConnections: number;
  deletedDisabledAdminConnections: number;
  deletedRetiredAppointmentConnections: number;
}>;

export class TelegramCleanupRepositoryError extends Error {
  constructor(readonly code: "TELEGRAM_CLEANUP_INPUT_INVALID" | "TELEGRAM_CLEANUP_STORAGE_FAILED") {
    super(code);
    this.name = "TelegramCleanupRepositoryError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

type CleanupTransaction = Prisma.TransactionClient;

async function deleteCount(transaction: CleanupTransaction, query: Prisma.Sql): Promise<number> {
  const rows = await transaction.$queryRaw<{ count: bigint }[]>(query);
  const count = rows[0]?.count;
  if (typeof count !== "bigint" || count < 0n || count > BigInt(TELEGRAM_CLEANUP_MAX_BATCH_SIZE)) {
    throw new TelegramCleanupRepositoryError("TELEGRAM_CLEANUP_STORAGE_FAILED");
  }
  return Number(count);
}

export class TelegramCleanupRepository {
  constructor(private readonly database: PrismaClient) {}

  async run(input: { batchSize: number; now?: Date }): Promise<TelegramCleanupResult> {
    const parsed = cleanupInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new TelegramCleanupRepositoryError("TELEGRAM_CLEANUP_INPUT_INVALID");
    }

    try {
      return await this.database.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SET LOCAL statement_timeout = '4s'`;
          await transaction.$executeRaw`SET LOCAL lock_timeout = '1s'`;
          const [clock] = await transaction.$queryRaw<{ now: Date }[]>(Prisma.sql`
            SELECT COALESCE(
              ${parsed.data.now ?? null}::timestamptz,
              clock_timestamp()::timestamptz(3)
            ) AS now
          `);
          if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) {
            throw new TelegramCleanupRepositoryError("TELEGRAM_CLEANUP_STORAGE_FAILED");
          }

          const now = clock.now;
          let remaining = parsed.data.batchSize;
          const take = async (query: (limit: number) => Prisma.Sql): Promise<number> => {
            if (remaining === 0) return 0;
            const count = await deleteCount(transaction, query(remaining));
            remaining -= count;
            return count;
          };

          // Address-bearing rejection rows have the shortest retention and are removed first.
          const deletedDirectRejectedOutbox = await take(
            (limit) => Prisma.sql`
            WITH candidates AS MATERIALIZED (
              SELECT o.id
              FROM notification_outbox o
              WHERE o.status IN ('SENT', 'DEAD', 'CANCELLED', 'SKIPPED')
                AND o.type = 'TELEGRAM_CONNECTION_REJECTED'
                AND o.direct_chat_id IS NOT NULL
                AND o.finished_at <= (${now}::timestamptz - INTERVAL '24 hours')
              ORDER BY o.finished_at, o.id
              LIMIT ${limit}
              FOR UPDATE OF o SKIP LOCKED
            ), deleted AS (
              DELETE FROM notification_outbox o
              USING candidates c
              WHERE o.id = c.id
              RETURNING o.id
            )
            SELECT count(*)::bigint AS count FROM deleted
          `,
          );

          const deletedOtherOutbox = await take(
            (limit) => Prisma.sql`
            WITH candidates AS MATERIALIZED (
              SELECT o.id
              FROM notification_outbox o
              WHERE o.status IN ('SENT', 'DEAD', 'CANCELLED', 'SKIPPED')
                AND o.finished_at < (${now}::timestamptz - INTERVAL '90 days')
              ORDER BY o.finished_at, o.id
              LIMIT ${limit}
              FOR UPDATE OF o SKIP LOCKED
            ), deleted AS (
              DELETE FROM notification_outbox o
              USING candidates c
              WHERE o.id = c.id
              RETURNING o.id
            )
            SELECT count(*)::bigint AS count FROM deleted
          `,
          );

          const deletedLinkTokens = await take(
            (limit) => Prisma.sql`
            WITH candidates AS MATERIALIZED (
              SELECT t.id
              FROM telegram_link_tokens t
              WHERE LEAST(
                t.expires_at,
                COALESCE(t.used_at, 'infinity'::timestamptz),
                COALESCE(t.revoked_at, 'infinity'::timestamptz)
              ) < (${now}::timestamptz - INTERVAL '30 days')
              ORDER BY LEAST(
                t.expires_at,
                COALESCE(t.used_at, 'infinity'::timestamptz),
                COALESCE(t.revoked_at, 'infinity'::timestamptz)
              ), t.id
              LIMIT ${limit}
              FOR UPDATE OF t SKIP LOCKED
            ), deleted AS (
              DELETE FROM telegram_link_tokens t
              USING candidates c
              WHERE t.id = c.id
              RETURNING t.id
            )
            SELECT count(*)::bigint AS count FROM deleted
          `,
          );

          const deletedDisabledAppointmentConnections = await take(
            (limit) => Prisma.sql`
            WITH candidates AS MATERIALIZED (
              SELECT c.id
              FROM appointment_telegram_connections c
              WHERE c.disabled_at < (${now}::timestamptz - INTERVAL '90 days')
                AND NOT EXISTS (
                  SELECT 1 FROM notification_outbox o
                  WHERE o.appointment_connection_id = c.id
                )
              ORDER BY c.disabled_at, c.id
              LIMIT ${limit}
              FOR UPDATE OF c SKIP LOCKED
            ), deleted AS (
              DELETE FROM appointment_telegram_connections c
              USING candidates d
              WHERE c.id = d.id
                AND NOT EXISTS (
                  SELECT 1 FROM notification_outbox o
                  WHERE o.appointment_connection_id = c.id
                )
              RETURNING c.id
            )
            SELECT count(*)::bigint AS count FROM deleted
          `,
          );

          const deletedDisabledAdminConnections = await take(
            (limit) => Prisma.sql`
            WITH candidates AS MATERIALIZED (
              SELECT c.id
              FROM admin_telegram_connections c
              WHERE c.disabled_at < (${now}::timestamptz - INTERVAL '90 days')
                AND NOT EXISTS (
                  SELECT 1 FROM notification_outbox o
                  WHERE o.admin_connection_id = c.id
                )
              ORDER BY c.disabled_at, c.id
              LIMIT ${limit}
              FOR UPDATE OF c SKIP LOCKED
            ), deleted AS (
              DELETE FROM admin_telegram_connections c
              USING candidates d
              WHERE c.id = d.id
                AND NOT EXISTS (
                  SELECT 1 FROM notification_outbox o
                  WHERE o.admin_connection_id = c.id
                )
              RETURNING c.id
            )
            SELECT count(*)::bigint AS count FROM deleted
          `,
          );

          const deletedRetiredAppointmentConnections = await take(
            (limit) => Prisma.sql`
            WITH candidates AS MATERIALIZED (
              SELECT c.id
              FROM appointment_telegram_connections c
              JOIN appointments a ON a.id = c.appointment_id
              WHERE c.disabled_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM notification_outbox o
                  WHERE o.appointment_connection_id = c.id
                )
                AND (
                  (
                    a.status = 'SCHEDULED'
                    AND a.ends_at < (${now}::timestamptz - INTERVAL '90 days')
                  )
                  OR (
                    a.status IN ('COMPLETED', 'NO_SHOW', 'CANCELLED')
                    AND EXISTS (
                      SELECT 1
                      FROM appointment_status_history h
                      WHERE h.appointment_id = a.id
                        AND h.new_status = a.status
                        AND h.changed_at < (${now}::timestamptz - INTERVAL '90 days')
                    )
                  )
                )
              ORDER BY c.connected_at, c.id
              LIMIT ${limit}
              FOR UPDATE OF c SKIP LOCKED
            ), deleted AS (
              DELETE FROM appointment_telegram_connections c
              USING candidates d
              WHERE c.id = d.id
                AND c.disabled_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM notification_outbox o
                  WHERE o.appointment_connection_id = c.id
                )
              RETURNING c.id
            )
            SELECT count(*)::bigint AS count FROM deleted
          `,
          );

          return {
            deletedDirectRejectedOutbox,
            deletedOtherOutbox,
            deletedLinkTokens,
            deletedDisabledAppointmentConnections,
            deletedDisabledAdminConnections,
            deletedRetiredAppointmentConnections,
          };
        },
        { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 5_000 },
      );
    } catch (error) {
      if (error instanceof TelegramCleanupRepositoryError) throw error;
      throw new TelegramCleanupRepositoryError("TELEGRAM_CLEANUP_STORAGE_FAILED");
    }
  }
}
