import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import { isTelegramBotUsername } from "../domain/config-contract";
import { TELEGRAM_NOTIFICATION_TYPES, type TelegramNotificationType } from "../domain/payload-v1";
import { TELEGRAM_POLICY } from "../domain/policy";
import { isTelegramSafeErrorCode, type TelegramSafeErrorCode } from "../domain/safe-error";
import type {
  TelegramRuntimeConfigErrorCode,
  TelegramRuntimeConfiguration,
} from "./runtime-config";

const DUE_QUEUE_STALE_MS = 5 * 60_000;

export type TelegramHealthConfiguration =
  | Readonly<{ kind: "DISABLED" }>
  | Readonly<{
      kind: "INCOMPLETE" | "INVALID";
      reasonCode: TelegramRuntimeConfigErrorCode;
    }>
  | Readonly<{ kind: "ENABLED"; botUsername: string }>;

export type TelegramHealthReasonCode =
  | "READY"
  | "DISABLED"
  | "IDENTITY_UNVERIFIED"
  | "BOT_USERNAME_MISMATCH"
  | "VERIFICATION_UNINITIALIZED"
  | "VERIFICATION_TIMESTAMP_INVALID"
  | "VERIFICATION_STALE"
  | "POLLING_UNINITIALIZED"
  | "POLLING_TIMESTAMP_INVALID"
  | "POLLING_STALE"
  | TelegramRuntimeConfigErrorCode
  | TelegramSafeErrorCode;

export type TelegramHealthStatusCounts = Readonly<{
  pending: number;
  processing: number;
  dead: number;
}>;

export type TelegramHealthSnapshot = Readonly<{
  generatedAt: string;
  status: "HEALTHY" | "DEGRADED" | "NOT_READY";
  configuration: Readonly<{
    status: "DISABLED" | "INCOMPLETE" | "INVALID" | "ENABLED";
    reasonCode: TelegramRuntimeConfigErrorCode | null;
  }>;
  readiness: Readonly<{
    polling: Readonly<{
      status: "DISABLED" | "NOT_READY" | "STALE" | "READY";
      reasonCode: TelegramHealthReasonCode;
      lastVerifiedAgeMs: number | null;
      lastPollAgeMs: number | null;
    }>;
    delivery: Readonly<{
      status: "DISABLED" | "NOT_READY" | "READY";
      reasonCode: TelegramHealthReasonCode;
    }>;
  }>;
  diagnostics: Readonly<{
    lastGlobalErrorCode: TelegramSafeErrorCode | null;
  }>;
  queue: Readonly<{
    byNotificationType: Readonly<Record<TelegramNotificationType, TelegramHealthStatusCounts>>;
    oldestDueAgeMs: number | null;
    dueQueueStale: boolean;
    expiredLeases: number;
    skippedClientReminders: number;
    newestDeadAt: string | null;
  }>;
  deliveryMetrics: Readonly<{
    sentJobs: number;
    additionalAttemptClaims: number;
    jobsWithLastRateLimitCode: number;
    confirmedSendLatencyMs: Readonly<{
      sampleSize: number;
      average: number | null;
      maximum: number | null;
    }>;
  }>;
}>;

type RawSnapshotRow = {
  statePresent: boolean;
  now: Date;
  botUserId: bigint | null;
  botUsername: string | null;
  lastVerifiedAt: Date | null;
  lastPollAt: Date | null;
  lastErrorCode: string | null;
  statusCounts: unknown;
  oldestDueAt: Date | null;
  expiredLeases: bigint;
  skippedClientReminders: bigint;
  newestDeadAt: Date | null;
  sentJobs: bigint;
  additionalAttemptClaims: bigint;
  jobsWithLastRateLimitCode: bigint;
  latencySampleSize: bigint;
  averageConfirmedSendLatencyMs: bigint | null;
  maximumConfirmedSendLatencyMs: bigint | null;
};

type RawStatusCount = {
  type: TelegramNotificationType;
  pending: bigint;
  processing: bigint;
  dead: bigint;
};

export class TelegramHealthSnapshotError extends Error {
  constructor(readonly code: "TELEGRAM_HEALTH_STORAGE_FAILURE") {
    super(code);
    this.name = "TelegramHealthSnapshotError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export function toTelegramHealthConfiguration(
  configuration: TelegramRuntimeConfiguration,
): TelegramHealthConfiguration {
  if (configuration.kind === "DISABLED") return { kind: "DISABLED" };
  if (configuration.kind !== "ENABLED") {
    return { kind: configuration.kind, reasonCode: configuration.reasonCode };
  }
  return { kind: "ENABLED", botUsername: configuration.botUsername };
}

function fail(): never {
  throw new TelegramHealthSnapshotError("TELEGRAM_HEALTH_STORAGE_FAILURE");
}

function validDate(value: unknown): value is Date {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getTime() >= 0 &&
    value.getUTCFullYear() <= 9999
  );
}

function boundedCount(value: unknown): number {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail();
  }
  return Number(value);
}

function boundedMilliseconds(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

function ageMilliseconds(now: Date, value: Date | null): number | null {
  if (value === null || !validDate(value)) return null;
  const age = now.getTime() - value.getTime();
  return Number.isSafeInteger(age) && age >= 0 ? age : null;
}

function emptyStatusCounts(): Record<TelegramNotificationType, TelegramHealthStatusCounts> {
  return Object.fromEntries(
    TELEGRAM_NOTIFICATION_TYPES.map((type) => [type, { pending: 0, processing: 0, dead: 0 }]),
  ) as Record<TelegramNotificationType, TelegramHealthStatusCounts>;
}

function parseCountText(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fail();
  try {
    return BigInt(value);
  } catch {
    return fail();
  }
}

function parseStatusCounts(value: unknown): RawStatusCount[] {
  if (!Array.isArray(value)) return fail();
  const allowed = new Set<string>(TELEGRAM_NOTIFICATION_TYPES);
  const seen = new Set<string>();
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !["type", "pending", "processing", "dead"].includes(key))
    ) {
      return fail();
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.type !== "string" || !allowed.has(row.type) || seen.has(row.type)) {
      return fail();
    }
    seen.add(row.type);
    return {
      type: row.type as TelegramNotificationType,
      pending: parseCountText(row.pending),
      processing: parseCountText(row.processing),
      dead: parseCountText(row.dead),
    };
  });
}

function configurationSnapshot(configuration: TelegramHealthConfiguration) {
  return configuration.kind === "DISABLED"
    ? ({ status: "DISABLED", reasonCode: null } as const)
    : configuration.kind === "ENABLED"
      ? ({ status: "ENABLED", reasonCode: null } as const)
      : ({ status: configuration.kind, reasonCode: configuration.reasonCode } as const);
}

function configurationReadiness(
  configuration: TelegramHealthConfiguration,
):
  | Readonly<{ status: "DISABLED"; reasonCode: "DISABLED" }>
  | Readonly<{ status: "NOT_READY"; reasonCode: TelegramRuntimeConfigErrorCode }>
  | null {
  if (configuration.kind === "DISABLED") {
    return { status: "DISABLED", reasonCode: "DISABLED" };
  }
  if (configuration.kind !== "ENABLED") {
    return { status: "NOT_READY", reasonCode: configuration.reasonCode };
  }
  return null;
}

function identityReason(
  configuration: Extract<TelegramHealthConfiguration, { kind: "ENABLED" }>,
  row: RawSnapshotRow,
): "IDENTITY_UNVERIFIED" | "BOT_USERNAME_MISMATCH" | null {
  if (row.botUserId === null && row.botUsername === null) return "IDENTITY_UNVERIFIED";
  if (
    typeof row.botUserId !== "bigint" ||
    row.botUserId <= 0n ||
    row.botUsername === null ||
    !isTelegramBotUsername(row.botUsername)
  ) {
    return fail();
  }
  return row.botUsername.toLowerCase() === configuration.botUsername.toLowerCase()
    ? null
    : "BOT_USERNAME_MISMATCH";
}

export function buildTelegramHealthSnapshot(
  configuration: TelegramHealthConfiguration,
  row: RawSnapshotRow,
): TelegramHealthSnapshot {
  if (!row.statePresent || !validDate(row.now)) return fail();
  if ((row.botUserId === null) !== (row.botUsername === null)) return fail();
  if (
    (row.lastVerifiedAt !== null && !validDate(row.lastVerifiedAt)) ||
    (row.lastPollAt !== null && !validDate(row.lastPollAt)) ||
    (row.newestDeadAt !== null && !validDate(row.newestDeadAt)) ||
    (row.oldestDueAt !== null && !validDate(row.oldestDueAt)) ||
    (row.lastErrorCode !== null && !isTelegramSafeErrorCode(row.lastErrorCode))
  ) {
    return fail();
  }

  const statusCounts = emptyStatusCounts();
  for (const count of parseStatusCounts(row.statusCounts)) {
    statusCounts[count.type] = {
      pending: boundedCount(count.pending),
      processing: boundedCount(count.processing),
      dead: boundedCount(count.dead),
    };
  }

  const lastVerifiedAgeMs = ageMilliseconds(row.now, row.lastVerifiedAt);
  const lastPollAgeMs = ageMilliseconds(row.now, row.lastPollAt);
  const configured = configurationReadiness(configuration);

  let polling: TelegramHealthSnapshot["readiness"]["polling"];
  let delivery: TelegramHealthSnapshot["readiness"]["delivery"];
  if (configured !== null) {
    polling = { ...configured, lastVerifiedAgeMs, lastPollAgeMs };
    delivery = configured;
  } else {
    if (configuration.kind !== "ENABLED") return fail();
    const identity = identityReason(configuration, row);
    if (identity !== null) {
      polling = { status: "NOT_READY", reasonCode: identity, lastVerifiedAgeMs, lastPollAgeMs };
      delivery = { status: "NOT_READY", reasonCode: identity };
    } else {
      const deliveryBlocked =
        row.lastErrorCode === "BOT_IDENTITY_MISMATCH" ||
        row.lastErrorCode === "CONFIG_UNAUTHORIZED";
      delivery = deliveryBlocked
        ? { status: "NOT_READY", reasonCode: row.lastErrorCode! }
        : { status: "READY", reasonCode: "READY" };

      if (row.lastErrorCode !== null) {
        polling = {
          status: "NOT_READY",
          reasonCode: row.lastErrorCode,
          lastVerifiedAgeMs,
          lastPollAgeMs,
        };
      } else if (row.lastVerifiedAt === null) {
        polling = {
          status: "NOT_READY",
          reasonCode: "VERIFICATION_UNINITIALIZED",
          lastVerifiedAgeMs,
          lastPollAgeMs,
        };
      } else if (lastVerifiedAgeMs === null) {
        polling = {
          status: "NOT_READY",
          reasonCode: "VERIFICATION_TIMESTAMP_INVALID",
          lastVerifiedAgeMs,
          lastPollAgeMs,
        };
      } else if (row.lastPollAt === null) {
        polling = {
          status: "NOT_READY",
          reasonCode: "POLLING_UNINITIALIZED",
          lastVerifiedAgeMs,
          lastPollAgeMs,
        };
      } else if (lastPollAgeMs === null) {
        polling = {
          status: "NOT_READY",
          reasonCode: "POLLING_TIMESTAMP_INVALID",
          lastVerifiedAgeMs,
          lastPollAgeMs,
        };
      } else if (lastVerifiedAgeMs > TELEGRAM_POLICY.readinessFreshnessMs) {
        polling = {
          status: "STALE",
          reasonCode: "VERIFICATION_STALE",
          lastVerifiedAgeMs,
          lastPollAgeMs,
        };
      } else if (lastPollAgeMs > TELEGRAM_POLICY.readinessFreshnessMs) {
        polling = {
          status: "STALE",
          reasonCode: "POLLING_STALE",
          lastVerifiedAgeMs,
          lastPollAgeMs,
        };
      } else {
        polling = {
          status: "READY",
          reasonCode: "READY",
          lastVerifiedAgeMs,
          lastPollAgeMs,
        };
      }
    }
  }

  const oldestDueAgeMs = ageMilliseconds(row.now, row.oldestDueAt);
  const expiredLeases = boundedCount(row.expiredLeases);
  const dueQueueStale = oldestDueAgeMs !== null && oldestDueAgeMs > DUE_QUEUE_STALE_MS;
  const notReady =
    polling.status === "DISABLED" ||
    polling.status === "NOT_READY" ||
    delivery.status === "DISABLED" ||
    delivery.status === "NOT_READY";
  const degraded = polling.status === "STALE" || dueQueueStale || expiredLeases > 0;

  return {
    generatedAt: row.now.toISOString(),
    status: notReady ? "NOT_READY" : degraded ? "DEGRADED" : "HEALTHY",
    configuration: configurationSnapshot(configuration),
    readiness: { polling, delivery },
    diagnostics: { lastGlobalErrorCode: row.lastErrorCode },
    queue: {
      byNotificationType: statusCounts,
      oldestDueAgeMs,
      dueQueueStale,
      expiredLeases,
      skippedClientReminders: boundedCount(row.skippedClientReminders),
      newestDeadAt: row.newestDeadAt?.toISOString() ?? null,
    },
    deliveryMetrics: {
      sentJobs: boundedCount(row.sentJobs),
      additionalAttemptClaims: boundedCount(row.additionalAttemptClaims),
      jobsWithLastRateLimitCode: boundedCount(row.jobsWithLastRateLimitCode),
      confirmedSendLatencyMs: {
        sampleSize: boundedCount(row.latencySampleSize),
        average: boundedMilliseconds(row.averageConfirmedSendLatencyMs),
        maximum: boundedMilliseconds(row.maximumConfirmedSendLatencyMs),
      },
    },
  };
}

export class TelegramHealthSnapshotRepository {
  constructor(private readonly database: PrismaClient) {}

  async getSnapshot(configuration: TelegramHealthConfiguration): Promise<TelegramHealthSnapshot> {
    try {
      return await this.database.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
          await transaction.$executeRaw`SET LOCAL statement_timeout = '4s'`;
          const rows = await transaction.$queryRaw<RawSnapshotRow[]>(Prisma.sql`
            WITH snapshot_time AS MATERIALIZED (
              SELECT clock_timestamp()::timestamptz(3) AS now
            ), grouped AS MATERIALIZED (
              SELECT
                o.type::text AS type,
                (count(*) FILTER (WHERE o.status = 'PENDING'))::text AS pending,
                (count(*) FILTER (WHERE o.status = 'PROCESSING'))::text AS processing,
                (count(*) FILTER (WHERE o.status = 'DEAD'))::text AS dead
              FROM notification_outbox o
              WHERE o.status IN ('PENDING', 'PROCESSING', 'DEAD')
              GROUP BY o.type
            ), grouped_json AS MATERIALIZED (
              SELECT COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'type', grouped.type,
                    'pending', grouped.pending,
                    'processing', grouped.processing,
                    'dead', grouped.dead
                  ) ORDER BY grouped.type
                ),
                '[]'::jsonb
              ) AS counts
              FROM grouped
            ), metrics AS MATERIALIZED (
              SELECT
                min(o.next_attempt_at) FILTER (
                  WHERE o.status = 'PENDING' AND o.next_attempt_at <= t.now
                ) AS "oldestDueAt",
                (count(*) FILTER (
                  WHERE o.status = 'PROCESSING' AND o.lease_expires_at <= t.now
                ))::bigint AS "expiredLeases",
                (count(*) FILTER (
                  WHERE o.status = 'SKIPPED' AND o.type = 'CLIENT_APPOINTMENT_REMINDER'
                ))::bigint AS "skippedClientReminders",
                max(o.finished_at) FILTER (WHERE o.status = 'DEAD') AS "newestDeadAt",
                (count(*) FILTER (WHERE o.status = 'SENT'))::bigint AS "sentJobs",
                COALESCE(sum(GREATEST(o.attempts - 1, 0)), 0)::bigint
                  AS "additionalAttemptClaims",
                (count(*) FILTER (
                  WHERE o.last_error_code = 'TELEGRAM_RATE_LIMIT'
                ))::bigint AS "jobsWithLastRateLimitCode",
                (count(*) FILTER (
                  WHERE o.status = 'SENT' AND o.sent_at >= o.scheduled_at
                ))::bigint AS "latencySampleSize",
                floor(avg(
                  extract(epoch FROM (o.sent_at - o.scheduled_at)) * 1000
                ) FILTER (
                  WHERE o.status = 'SENT' AND o.sent_at >= o.scheduled_at
                ))::bigint AS "averageConfirmedSendLatencyMs",
                floor(max(
                  extract(epoch FROM (o.sent_at - o.scheduled_at)) * 1000
                ) FILTER (
                  WHERE o.status = 'SENT' AND o.sent_at >= o.scheduled_at
                ))::bigint AS "maximumConfirmedSendLatencyMs"
              FROM notification_outbox o
              CROSS JOIN snapshot_time t
            )
            SELECT
              (s.id IS NOT NULL) AS "statePresent",
              t.now,
              s.bot_user_id AS "botUserId",
              s.bot_username AS "botUsername",
              s.last_verified_at AS "lastVerifiedAt",
              s.last_poll_at AS "lastPollAt",
              s.last_error_code AS "lastErrorCode",
              g.counts AS "statusCounts",
              m."oldestDueAt",
              m."expiredLeases",
              m."skippedClientReminders",
              m."newestDeadAt",
              m."sentJobs",
              m."additionalAttemptClaims",
              m."jobsWithLastRateLimitCode",
              m."latencySampleSize",
              m."averageConfirmedSendLatencyMs",
              m."maximumConfirmedSendLatencyMs"
            FROM snapshot_time t
            CROSS JOIN grouped_json g
            CROSS JOIN metrics m
            LEFT JOIN telegram_bot_state s ON s.id = 1
          `);
          if (rows.length !== 1 || !rows[0]) return fail();
          return buildTelegramHealthSnapshot(configuration, rows[0]);
        },
        { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 5_000 },
      );
    } catch (error) {
      if (error instanceof TelegramHealthSnapshotError) throw error;
      throw new TelegramHealthSnapshotError("TELEGRAM_HEALTH_STORAGE_FAILURE");
    }
  }
}
