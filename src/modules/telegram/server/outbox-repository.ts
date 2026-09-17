import { z } from "zod";

import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import { parseTelegramPayloadV1, TELEGRAM_NOTIFICATION_TYPES } from "../domain/payload-v1";
import { TELEGRAM_POLICY } from "../domain/policy";
import { decideTelegramRetry, type TelegramRetryRandom } from "../domain/retry";
import type { TelegramSafeErrorCode } from "../domain/safe-error";
import {
  OUTBOX_INVALIDATION_CODES,
  TelegramOutboxError,
  checkedOutboxInput,
  claimOutboxSchema,
  finishOutboxSchema,
  invalidateOutboxSchema,
  outboxInvalidationSkipCode,
  outboxOwnerSchema,
  outboxTimestampSchema,
  outboxUuidSchema,
  recoverOutboxSchema,
  type ClaimedOutboxJob,
  type ClaimOutboxInput,
  type FinishOutboxInput,
  type InvalidateOutboxInput,
  type OutboxTransitionResult,
  type RecoveredOutboxJob,
} from "./outbox-contract";

const CONFIGURATION_RETRY_DELAY_MS = 5 * 60_000;
const CONNECTION_DISABLING_ERROR_CODES = [
  "CHAT_NOT_FOUND",
  "BOT_BLOCKED",
  "CHAT_WRITE_FORBIDDEN",
  "TELEGRAM_USER_DEACTIVATED",
] as const;
type ConnectionDisablingErrorCode = (typeof CONNECTION_DISABLING_ERROR_CODES)[number];
const rowSchema = z.object({
  id: outboxUuidSchema,
  recipientKind: z.enum(["APPOINTMENT_CONNECTION", "ADMIN_CONNECTION", "DIRECT_CHAT"]),
  appointmentConnectionId: outboxUuidSchema.nullable(),
  adminConnectionId: outboxUuidSchema.nullable(),
  directChatId: z.bigint().nullable(),
  type: z.enum(TELEGRAM_NOTIFICATION_TYPES),
  status: z.enum(["PENDING", "PROCESSING", "SENT", "DEAD", "CANCELLED", "SKIPPED"]),
  attempts: z.number().int().min(0).max(TELEGRAM_POLICY.maxAttempts),
  scheduledAt: outboxTimestampSchema,
  nextAttemptAt: outboxTimestampSchema,
  expiresAt: outboxTimestampSchema.nullable(),
  leaseToken: outboxUuidSchema.nullable(),
  leaseOwner: outboxOwnerSchema.nullable(),
  claimedAt: outboxTimestampSchema.nullable(),
  leaseExpiresAt: outboxTimestampSchema.nullable(),
  invalidatedAt: outboxTimestampSchema.nullable(),
  invalidationCode: z.enum(OUTBOX_INVALIDATION_CODES).nullable(),
});
type OutboxRow = z.infer<typeof rowSchema>;

const rowColumns = Prisma.sql`
  o.id, o.recipient_kind AS "recipientKind",
  o.appointment_connection_id AS "appointmentConnectionId",
  o.admin_connection_id AS "adminConnectionId", o.direct_chat_id AS "directChatId",
  o.type, o.status, o.attempts,
  o.scheduled_at AS "scheduledAt", o.next_attempt_at AS "nextAttemptAt",
  o.expires_at AS "expiresAt", o.lease_token AS "leaseToken",
  o.lease_owner AS "leaseOwner", o.claimed_at AS "claimedAt",
  o.lease_expires_at AS "leaseExpiresAt", o.invalidated_at AS "invalidatedAt",
  o.invalidation_code AS "invalidationCode"
`;

function readRow(raw: unknown): OutboxRow {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) throw new TelegramOutboxError("OUTBOX_DATA_INVALID");
  const row = parsed.data;
  if ((row.invalidatedAt === null) !== (row.invalidationCode === null)) {
    throw new TelegramOutboxError("OUTBOX_DATA_INVALID");
  }
  return row;
}

type ConnectionTarget =
  | { kind: "APPOINTMENT_CONNECTION"; id: string }
  | { kind: "ADMIN_CONNECTION"; id: string }
  | { kind: "DIRECT_CHAT" };

function connectionTarget(row: OutboxRow): ConnectionTarget {
  if (
    row.recipientKind === "APPOINTMENT_CONNECTION" &&
    row.appointmentConnectionId !== null &&
    row.adminConnectionId === null &&
    row.directChatId === null
  ) {
    return { kind: row.recipientKind, id: row.appointmentConnectionId };
  }
  if (
    row.recipientKind === "ADMIN_CONNECTION" &&
    row.appointmentConnectionId === null &&
    row.adminConnectionId !== null &&
    row.directChatId === null
  ) {
    return { kind: row.recipientKind, id: row.adminConnectionId };
  }
  if (
    row.recipientKind === "DIRECT_CHAT" &&
    row.appointmentConnectionId === null &&
    row.adminConnectionId === null &&
    row.directChatId !== null
  ) {
    return { kind: row.recipientKind };
  }
  throw new TelegramOutboxError("OUTBOX_DATA_INVALID");
}

function isConnectionDisablingError(errorCode: string): errorCode is ConnectionDisablingErrorCode {
  return CONNECTION_DISABLING_ERROR_CODES.some((candidate) => candidate === errorCode);
}

type Change = {
  status: "PENDING" | "SENT" | "DEAD" | "SKIPPED";
  nextAttemptAt: Date;
  attempts: number;
  errorCode: TelegramSafeErrorCode | null;
};

function retryChange(
  row: OutboxRow,
  now: Date,
  errorCode: Extract<FinishOutboxInput, { outcome: "RETRY" }>["errorCode"],
  random: TelegramRetryRandom,
  retryAfterSeconds?: number,
): Change {
  const base = { nextAttemptAt: row.nextAttemptAt, attempts: row.attempts };
  if (row.invalidationCode !== null) {
    return {
      ...base,
      status: "SKIPPED",
      errorCode: outboxInvalidationSkipCode(row.invalidationCode),
    };
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() < now.getTime()) {
    return { ...base, status: "SKIPPED", errorCode: "REMINDER_EXPIRED" };
  }
  const retry = decideTelegramRetry({
    attempts: row.attempts,
    errorCode,
    retryAfterSeconds,
    expiresAt: row.expiresAt ?? undefined,
    clock: () => now,
    random,
  });
  if (retry.kind === "RETRY") {
    return { ...base, status: "PENDING", nextAttemptAt: retry.nextAttemptAt, errorCode };
  }
  return retry.reason === "DEADLINE_EXCEEDED"
    ? { ...base, status: "SKIPPED", errorCode: "REMINDER_EXPIRED" }
    : { ...base, status: "DEAD", errorCode };
}

// Never expose driver errors, SQL values, raw JSON or a nested cause to callers.
async function safeStorage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TelegramOutboxError) throw error;
    throw new TelegramOutboxError("OUTBOX_STORAGE_FAILURE");
  }
}

export class TelegramOutboxRepository {
  constructor(
    private readonly database: PrismaClient,
    private readonly options: { clock?: () => Date; random?: TelegramRetryRandom } = {},
  ) {}

  private overrideNow(): Date | null {
    const value = this.options.clock?.();
    return value === undefined ? null : new Date(checkedOutboxInput(outboxTimestampSchema, value));
  }

  private transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return safeStorage(() =>
      this.database.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
          return run(tx);
        },
        { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 5_000 },
      ),
    );
  }

  private async now(tx: Prisma.TransactionClient, override: Date | null): Promise<Date> {
    if (override !== null) return override;
    const [row] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp()::timestamptz(3) AS now`;
    return checkedOutboxInput(outboxTimestampSchema, row?.now);
  }

  async claimDue(input: ClaimOutboxInput): Promise<ClaimedOutboxJob[]> {
    const { capacity, leaseOwner } = checkedOutboxInput(claimOutboxSchema, input);
    const now = this.overrideNow();
    if (capacity === 0) return [];
    const limit = Math.min(capacity, TELEGRAM_POLICY.claimBatchSize);
    return this.transaction(async (tx) => {
      // One snapshot of time, one locking selection and one UPDATE for the whole claim.
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        WITH claim_time AS MATERIALIZED (
          SELECT COALESCE(${now}::timestamptz, clock_timestamp()::timestamptz(3)) AS now
        ), due AS MATERIALIZED (
          SELECT o.id
          FROM notification_outbox o
          WHERE o.status = 'PENDING'
            AND o.next_attempt_at <= (SELECT now FROM claim_time)
            AND o.attempts < ${TELEGRAM_POLICY.maxAttempts}
          ORDER BY o.next_attempt_at, o.id
          LIMIT ${limit}
          FOR UPDATE OF o SKIP LOCKED
        ), claimed AS (
          UPDATE notification_outbox o
          SET status = 'PROCESSING', attempts = o.attempts + 1,
              lease_token = gen_random_uuid(), lease_owner = ${leaseOwner},
              claimed_at = t.now,
              lease_expires_at = t.now + ${TELEGRAM_POLICY.leaseDurationMs} * INTERVAL '1 millisecond',
              updated_at = t.now
          FROM due, claim_time t
          WHERE o.id = due.id AND o.status = 'PENDING'
          RETURNING ${rowColumns}, o.payload_version AS "payloadVersion", o.payload
        )
        SELECT * FROM claimed ORDER BY "nextAttemptAt", id
      `;
      return rows.map((raw): ClaimedOutboxJob => {
        const row = readRow(raw);
        if (
          !row.leaseToken ||
          !row.leaseOwner ||
          !row.claimedAt ||
          !row.leaseExpiresAt ||
          row.attempts < 1 ||
          row.leaseExpiresAt <= row.claimedAt
        ) {
          throw new TelegramOutboxError("OUTBOX_DATA_INVALID");
        }
        const payload = parseTelegramPayloadV1({
          notificationType: row.type,
          payloadVersion: raw.payloadVersion,
          payload: raw.payload,
        });
        return {
          id: row.id,
          type: row.type,
          attempts: row.attempts,
          leaseToken: row.leaseToken,
          leaseOwner: row.leaseOwner,
          claimedAt: row.claimedAt,
          leaseExpiresAt: row.leaseExpiresAt,
          expiresAt: row.expiresAt,
          invalidated: row.invalidatedAt !== null,
          payloadCheck: payload.ok
            ? { ok: true, payloadVersion: 1 }
            : {
                ok: false,
                code:
                  payload.code === "PAYLOAD_VERSION_UNSUPPORTED"
                    ? payload.code
                    : "RESPONSE_INVALID",
              },
        };
      });
    });
  }

  async finish(input: FinishOutboxInput): Promise<OutboxTransitionResult> {
    const command = checkedOutboxInput(finishOutboxSchema, input);
    const override = this.overrideNow();
    return this.transaction(async (tx) => {
      const [raw] = await tx.$queryRaw<unknown[]>`
        SELECT ${rowColumns} FROM notification_outbox o
        WHERE o.id = ${command.id}::uuid FOR UPDATE OF o
      `;
      if (!raw) return { kind: "LEASE_LOST" };
      const row = readRow(raw);
      if (row.status !== "PROCESSING") {
        return row.status === "PENDING"
          ? { kind: "TRANSITION_NOT_ALLOWED" }
          : { kind: "TERMINAL", status: row.status };
      }
      // Read the production clock after waiting for the row lock.
      const now = await this.now(tx, override);
      if (
        row.leaseToken !== command.leaseToken ||
        !row.leaseExpiresAt ||
        row.leaseExpiresAt <= now
      ) {
        return { kind: "LEASE_LOST" };
      }
      if (!row.claimedAt || now < row.claimedAt) {
        return { kind: "TRANSITION_NOT_ALLOWED" };
      }
      const base = { nextAttemptAt: row.nextAttemptAt, attempts: row.attempts };
      let change: Change;
      let invalidateCurrentForDisabledConnection = false;
      if (command.outcome === "SENT") {
        change = { ...base, status: "SENT", errorCode: null };
      } else if (row.invalidationCode !== null) {
        change = {
          ...base,
          status: "SKIPPED",
          attempts:
            command.outcome === "CONFIGURATION_FAILURE"
              ? Math.max(0, row.attempts - 1)
              : row.attempts,
          errorCode: outboxInvalidationSkipCode(row.invalidationCode),
        };
      } else if (command.outcome === "CONFIGURATION_FAILURE") {
        const retryAt = checkedOutboxInput(
          outboxTimestampSchema,
          new Date(now.getTime() + CONFIGURATION_RETRY_DELAY_MS),
        );
        const expired = row.expiresAt !== null && retryAt > row.expiresAt;
        change = {
          status: expired ? "SKIPPED" : "PENDING",
          attempts: Math.max(0, row.attempts - 1),
          nextAttemptAt: expired ? row.nextAttemptAt : retryAt,
          errorCode: "CONFIG_UNAUTHORIZED",
        };
      } else if (command.outcome === "RETRY") {
        if (row.attempts < 1) return { kind: "TRANSITION_NOT_ALLOWED" };
        change = retryChange(
          row,
          now,
          command.errorCode,
          this.options.random ?? Math.random,
          command.retryAfterSeconds,
        );
      } else {
        change = { ...base, status: command.outcome, errorCode: command.errorCode };
      }
      if (
        command.outcome === "DEAD" &&
        change.status === "DEAD" &&
        isConnectionDisablingError(command.errorCode)
      ) {
        const connection = await disableRecipientConnection(tx, row, command.errorCode, now);
        if (connection === "ALREADY_DISABLED") {
          change = {
            ...base,
            status: "SKIPPED",
            errorCode: "CONNECTION_INACTIVE",
          };
          invalidateCurrentForDisabledConnection = true;
        }
      }
      const changed = await tx.$executeRaw`
        UPDATE notification_outbox
        SET status = ${change.status}::"NotificationStatus", attempts = ${change.attempts},
            next_attempt_at = ${change.nextAttemptAt}, last_error_code = ${change.errorCode},
            invalidated_at = COALESCE(
              invalidated_at,
              ${invalidateCurrentForDisabledConnection ? now : null}::timestamptz
            ),
            invalidation_code = COALESCE(
              invalidation_code,
              ${invalidateCurrentForDisabledConnection ? "CONNECTION_DISABLED" : null}
            ),
            sent_at = ${change.status === "SENT" ? now : null}::timestamptz,
            finished_at = ${change.status === "PENDING" ? null : now}::timestamptz,
            lease_token = NULL, lease_owner = NULL, claimed_at = NULL, lease_expires_at = NULL,
            updated_at = ${now}
        WHERE id = ${command.id}::uuid AND status = 'PROCESSING'
          AND lease_token = ${command.leaseToken}::uuid
      `;
      return changed === 1 ? { kind: "APPLIED", status: change.status } : { kind: "LEASE_LOST" };
    });
  }

  async recoverExpired(input: { batchSize: number }): Promise<RecoveredOutboxJob[]> {
    const { batchSize } = checkedOutboxInput(recoverOutboxSchema, input);
    const override = this.overrideNow();
    return this.transaction(async (tx) => {
      const now = await this.now(tx, override);
      const rows = await tx.$queryRaw<unknown[]>`
        SELECT ${rowColumns} FROM notification_outbox o
        WHERE o.status = 'PROCESSING' AND o.lease_expires_at <= ${now}
        ORDER BY o.lease_expires_at, o.id
        LIMIT ${Math.min(batchSize, TELEGRAM_POLICY.claimBatchSize)}
        FOR UPDATE OF o SKIP LOCKED
      `;
      if (rows.length === 0) return [];
      const changes = rows.map((raw) => {
        const row = readRow(raw);
        if (!row.leaseToken || row.attempts < 1)
          throw new TelegramOutboxError("OUTBOX_DATA_INVALID");
        return {
          id: row.id,
          token: row.leaseToken,
          ...retryChange(row, now, "DELIVERY_OUTCOME_UNKNOWN", this.options.random ?? Math.random),
        };
      });
      // Keep the bounded row locks through the pure retry calculation and fenced batch UPDATE.
      const values = changes.map(
        (change) => Prisma.sql`(
        ${change.id}::uuid, ${change.token}::uuid, ${change.status}::"NotificationStatus",
        ${change.nextAttemptAt}::timestamptz, ${change.errorCode}::text,
        ${change.status === "PENDING" ? null : now}::timestamptz
      )`,
      );
      const updated = await tx.$queryRaw<RecoveredOutboxJob[]>`
        UPDATE notification_outbox o
        SET status = v.status, next_attempt_at = v.retry_at, last_error_code = v.error_code,
            finished_at = v.finished_at, lease_token = NULL, lease_owner = NULL,
            claimed_at = NULL, lease_expires_at = NULL, updated_at = ${now}
        FROM (VALUES ${Prisma.join(values)}) AS v(id, token, status, retry_at, error_code, finished_at)
        WHERE o.id = v.id AND o.status = 'PROCESSING' AND o.lease_token = v.token
        RETURNING o.id, o.status
      `;
      const byId = new Map(updated.map((row) => [row.id, row]));
      return changes.flatMap(({ id }) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
    });
  }
}

async function disableRecipientConnection(
  tx: Prisma.TransactionClient,
  row: OutboxRow,
  errorCode: ConnectionDisablingErrorCode,
  now: Date,
): Promise<"DIRECT_CHAT" | "DISABLED" | "ALREADY_DISABLED"> {
  const target = connectionTarget(row);
  if (target.kind === "DIRECT_CHAT") return "DIRECT_CHAT";

  const connections =
    target.kind === "APPOINTMENT_CONNECTION"
      ? await tx.$queryRaw<{ id: string; disabledAt: Date | null }[]>`
          SELECT id, disabled_at AS "disabledAt"
          FROM appointment_telegram_connections
          WHERE id = ${target.id}::uuid
          FOR UPDATE
        `
      : await tx.$queryRaw<{ id: string; disabledAt: Date | null }[]>`
          SELECT id, disabled_at AS "disabledAt"
          FROM admin_telegram_connections
          WHERE id = ${target.id}::uuid
          FOR UPDATE
        `;
  const connection = connections.length === 1 ? connections[0] : null;
  if (!connection || connection.id !== target.id) {
    throw new TelegramOutboxError("OUTBOX_DATA_INVALID");
  }
  if (connection.disabledAt !== null) return "ALREADY_DISABLED";

  const changed =
    target.kind === "APPOINTMENT_CONNECTION"
      ? await tx.$executeRaw`
          UPDATE appointment_telegram_connections
          SET disabled_at = ${now},
              disabled_reason = ${errorCode}::"TelegramConnectionDisabledReason"
          WHERE id = ${target.id}::uuid AND disabled_at IS NULL
        `
      : await tx.$executeRaw`
          UPDATE admin_telegram_connections
          SET disabled_at = ${now},
              disabled_reason = ${errorCode}::"TelegramConnectionDisabledReason"
          WHERE id = ${target.id}::uuid AND disabled_at IS NULL
        `;
  if (changed !== 1) throw new Error("Telegram connection changed after its row lock");

  await invalidateTelegramOutboxRows(
    tx,
    {
      target: { kind: target.kind, id: target.id },
      code: "CONNECTION_DISABLED",
      now,
    },
    { excludeId: row.id, skipLocked: true },
  );
  return "DISABLED";
}

// Can participate in a caller-owned transaction; never starts a nested transaction.
export async function invalidateTelegramOutbox(
  tx: Prisma.TransactionClient,
  input: InvalidateOutboxInput,
): Promise<{ cancelled: number; invalidated: number }> {
  return invalidateTelegramOutboxRows(tx, input);
}

async function invalidateTelegramOutboxRows(
  tx: Prisma.TransactionClient,
  input: InvalidateOutboxInput,
  options: { excludeId?: string; skipLocked?: boolean } = {},
): Promise<{ cancelled: number; invalidated: number }> {
  const { target, code, now } = checkedOutboxInput(invalidateOutboxSchema, input);
  const predicate =
    target.kind === "APPOINTMENT"
      ? Prisma.sql`o.appointment_id = ${target.id}::uuid AND o.type::text IN (${Prisma.join(target.types)})`
      : target.kind === "APPOINTMENT_CONNECTION"
        ? Prisma.sql`o.appointment_connection_id = ${target.id}::uuid`
        : Prisma.sql`o.admin_connection_id = ${target.id}::uuid`;
  const exclusion =
    options.excludeId === undefined
      ? Prisma.sql``
      : Prisma.sql`AND o.id <> ${options.excludeId}::uuid`;
  return safeStorage(async () => {
    const update = (
      statusPredicate: Prisma.Sql,
      skipLocked: boolean,
    ): Promise<{ status: "CANCELLED" | "PROCESSING" }[]> =>
      tx.$queryRaw`
        WITH targets AS MATERIALIZED (
          SELECT o.id
          FROM notification_outbox o
          WHERE (${predicate}) AND (${statusPredicate}) ${exclusion}
          ORDER BY o.id
          FOR UPDATE OF o ${skipLocked ? Prisma.sql`SKIP LOCKED` : Prisma.sql``}
        )
        UPDATE notification_outbox o
        SET status = CASE WHEN o.status = 'PENDING' THEN 'CANCELLED'::"NotificationStatus" ELSE o.status END,
            invalidated_at = COALESCE(o.invalidated_at, ${now}),
            invalidation_code = COALESCE(o.invalidation_code, ${code}),
            finished_at = CASE WHEN o.status = 'PENDING' THEN ${now}::timestamptz ELSE o.finished_at END,
            updated_at = ${now}
        FROM targets
        WHERE o.id = targets.id
        RETURNING o.status
      `;
    const rows = options.skipLocked
      ? [
          ...(await update(Prisma.sql`o.status = 'PENDING'`, false)),
          ...(await update(Prisma.sql`o.status = 'PROCESSING' AND o.invalidated_at IS NULL`, true)),
        ]
      : await update(
          Prisma.sql`o.status = 'PENDING' OR (o.status = 'PROCESSING' AND o.invalidated_at IS NULL)`,
          false,
        );
    return {
      cancelled: rows.filter((row) => row.status === "CANCELLED").length,
      invalidated: rows.filter((row) => row.status === "PROCESSING").length,
    };
  });
}
