import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import { getActiveAdminForShare } from "../../auth/server/auth-service";
import type { TelegramWebConfiguration } from "../domain/config-contract";
import { TELEGRAM_POLICY } from "../domain/policy";
import { computeTelegramWebReadiness, type TelegramReadinessState } from "../domain/readiness";

const TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 10_000,
} as const;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALLATION_KEY = "telegram-link:installation:v1";
type Purpose = "APPOINTMENT" | "ADMIN_USER";
type Issued = { kind: "ISSUED"; expiresAt: Date; botUsername: string };

export type TelegramAppointmentLinkRepositoryResult =
  | Issued
  | {
      kind:
        | "NOT_FOUND"
        | "APPOINTMENT_NOT_ELIGIBLE"
        | "ALREADY_CONNECTED"
        | "TELEGRAM_NOT_READY"
        | "RATE_LIMITED";
    };
export type TelegramAdminLinkRepositoryResult =
  | Issued
  | {
      kind:
        "UNAUTHORIZED" | "FORBIDDEN" | "ALREADY_CONNECTED" | "TELEGRAM_NOT_READY" | "RATE_LIMITED";
    };
export type TelegramAppointmentLinkRevokeResult = { kind: "REVOKED" } | { kind: "NOT_FOUND" };
export type TelegramAdminLinkRevokeResult =
  { kind: "REVOKED" } | { kind: "UNAUTHORIZED" | "FORBIDDEN" };

export interface TelegramLinkStore {
  issueAppointment(input: {
    cancellationTokenHash: string;
    linkTokenHash: string;
  }): Promise<TelegramAppointmentLinkRepositoryResult>;
  revokeAppointment(hash: string): Promise<TelegramAppointmentLinkRevokeResult>;
  issueAdmin(input: {
    adminUserId: string;
    sessionToken: unknown;
    linkTokenHash: string;
  }): Promise<TelegramAdminLinkRepositoryResult>;
  revokeAdmin(input: {
    adminUserId: string;
    sessionToken: unknown;
  }): Promise<TelegramAdminLinkRevokeResult>;
}

export class TelegramLinkRepositoryError extends Error {
  constructor(readonly code: "LINK_INPUT_INVALID" | "LINK_STORAGE_FAILURE") {
    super(code);
    this.name = "TelegramLinkRepositoryError";
  }
  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

function checkedHash(value: string) {
  if (!HASH.test(value)) throw new TelegramLinkRepositoryError("LINK_INPUT_INVALID");
}
function checkedId(value: string) {
  if (!UUID.test(value)) throw new TelegramLinkRepositoryError("LINK_INPUT_INVALID");
}
function storageFailure(error: unknown): never {
  if (error instanceof TelegramLinkRepositoryError) throw error;
  throw new TelegramLinkRepositoryError("LINK_STORAGE_FAILURE");
}

export function telegramLinkTargetRateLimitKey(purpose: Purpose, targetId: string): string {
  checkedId(targetId);
  const domain =
    purpose === "APPOINTMENT"
      ? "zaprosto:telegram-link-appointment-target:v1"
      : "zaprosto:telegram-link-admin-target:v1";
  const id = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(targetId, "utf8")
    .digest("hex");
  return `telegram-link:target:${purpose.toLowerCase()}:v1:${id}`;
}

async function now(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp()::timestamptz(3) AS now
  `;
  const value = rows[0]?.now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new TelegramLinkRepositoryError("LINK_STORAGE_FAILURE");
  return value;
}

async function ready(
  tx: Prisma.TransactionClient,
  configuration: TelegramWebConfiguration,
  at: Date,
): Promise<string | null> {
  const rows = await tx.$queryRaw<TelegramReadinessState[]>`
    SELECT bot_user_id AS "botUserId", bot_username AS "botUsername",
      last_verified_at AS "lastVerifiedAt", last_poll_at AS "lastPollAt",
      last_error_code AS "lastErrorCode"
    FROM telegram_bot_state WHERE id = 1
  `;
  const result = computeTelegramWebReadiness({
    configuration,
    state: rows.length === 1 ? rows[0]! : null,
    now: at,
  });
  return result.ready ? (result.botUsername ?? null) : null;
}

async function increment(tx: Prisma.TransactionClient, key: string, maximum: number) {
  const rows = await tx.$queryRaw<{ hits: number }[]>(Prisma.sql`
    WITH rate_time AS MATERIALIZED (
      SELECT clock_timestamp()::timestamptz(3) AS now
    ), changed AS (
      INSERT INTO public_rate_limits (key, hits, expires_at)
      SELECT ${key}, 1,
        now + (${TELEGRAM_POLICY.linkIssuance.windowMs} * interval '1 millisecond')
      FROM rate_time
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE
          WHEN public_rate_limits.expires_at <= (SELECT now FROM rate_time) THEN 1
          ELSE LEAST(public_rate_limits.hits + 1, ${maximum + 1})
        END,
        expires_at = CASE
          WHEN public_rate_limits.expires_at <= (SELECT now FROM rate_time)
            THEN (SELECT now FROM rate_time)
              + (${TELEGRAM_POLICY.linkIssuance.windowMs} * interval '1 millisecond')
          ELSE public_rate_limits.expires_at
        END
      RETURNING hits
    )
    SELECT hits FROM changed
  `);
  const hits = rows[0]?.hits;
  if (!Number.isSafeInteger(hits) || hits === undefined || hits < 1)
    throw new TelegramLinkRepositoryError("LINK_STORAGE_FAILURE");
  return hits;
}

async function consume(tx: Prisma.TransactionClient, purpose: Purpose, targetId: string) {
  // Stable for both purposes: installation first, then the purpose-separated target.
  const global = await increment(
    tx,
    INSTALLATION_KEY,
    TELEGRAM_POLICY.linkIssuance.maxAttemptsPerInstallation,
  );
  const target = await increment(
    tx,
    telegramLinkTargetRateLimitKey(purpose, targetId),
    TELEGRAM_POLICY.linkIssuance.maxAttemptsPerTarget,
  );
  return (
    global <= TELEGRAM_POLICY.linkIssuance.maxAttemptsPerInstallation &&
    target <= TELEGRAM_POLICY.linkIssuance.maxAttemptsPerTarget
  );
}

export class TelegramLinkRepository implements TelegramLinkStore {
  constructor(
    private readonly database: PrismaClient,
    private readonly configuration: TelegramWebConfiguration,
  ) {}

  async issueAppointment(input: {
    cancellationTokenHash: string;
    linkTokenHash: string;
  }): Promise<TelegramAppointmentLinkRepositoryResult> {
    checkedHash(input.cancellationTokenHash);
    checkedHash(input.linkTokenHash);
    try {
      return await this.database.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string; cancellationTokenHash: string; status: string; startsAt: Date }[]
        >(Prisma.sql`
          SELECT id, cancellation_token_hash AS "cancellationTokenHash",
            status::text AS status, starts_at AS "startsAt"
          FROM appointments
          WHERE cancellation_token_hash = ${input.cancellationTokenHash}
          FOR UPDATE
        `);
        const appointment = rows.length === 1 ? rows[0]! : null;
        if (!appointment || appointment.cancellationTokenHash !== input.cancellationTokenHash)
          return { kind: "NOT_FOUND" } as const;
        const at = await now(tx);
        if (appointment.status !== "SCHEDULED" || appointment.startsAt <= at)
          return { kind: "APPOINTMENT_NOT_ELIGIBLE" } as const;
        if (
          await tx.appointmentTelegramConnection.findFirst({
            where: { appointmentId: appointment.id, disabledAt: null },
            select: { id: true },
          })
        )
          return { kind: "ALREADY_CONNECTED" } as const;
        const botUsername = await ready(tx, this.configuration, at);
        if (!botUsername) return { kind: "TELEGRAM_NOT_READY" } as const;
        if (!(await consume(tx, "APPOINTMENT", appointment.id)))
          return { kind: "RATE_LIMITED" } as const;
        await tx.telegramLinkToken.updateMany({
          where: {
            purpose: "APPOINTMENT",
            appointmentId: appointment.id,
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: at },
        });
        const expiresAt = new Date(at.getTime() + TELEGRAM_POLICY.linkTokenTtlMs);
        await tx.telegramLinkToken.create({
          data: {
            purpose: "APPOINTMENT",
            tokenHash: input.linkTokenHash,
            appointmentId: appointment.id,
            createdAt: at,
            expiresAt,
          },
          select: { id: true },
        });
        return { kind: "ISSUED", expiresAt, botUsername } as const;
      }, TX);
    } catch (error) {
      storageFailure(error);
    }
  }

  async revokeAppointment(hash: string): Promise<TelegramAppointmentLinkRevokeResult> {
    checkedHash(hash);
    try {
      return await this.database.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; cancellationTokenHash: string }[]>`
          SELECT id, cancellation_token_hash AS "cancellationTokenHash"
          FROM appointments WHERE cancellation_token_hash = ${hash} FOR UPDATE
        `;
        const appointment = rows.length === 1 ? rows[0]! : null;
        if (!appointment || appointment.cancellationTokenHash !== hash)
          return { kind: "NOT_FOUND" } as const;
        await tx.telegramLinkToken.updateMany({
          where: {
            purpose: "APPOINTMENT",
            appointmentId: appointment.id,
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: await now(tx) },
        });
        return { kind: "REVOKED" } as const;
      }, TX);
    } catch (error) {
      storageFailure(error);
    }
  }

  async issueAdmin(input: {
    adminUserId: string;
    sessionToken: unknown;
    linkTokenHash: string;
  }): Promise<TelegramAdminLinkRepositoryResult> {
    checkedId(input.adminUserId);
    checkedHash(input.linkTokenHash);
    try {
      return await this.database.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; isActive: boolean }[]>(Prisma.sql`
          SELECT id, is_active AS "isActive" FROM admin_users
          WHERE id = ${input.adminUserId}::uuid FOR UPDATE
        `);
        const admin = rows.length === 1 ? rows[0]! : null;
        if (!admin || !admin.isActive) return { kind: "FORBIDDEN" } as const;
        const authorized = await getActiveAdminForShare(tx, input.sessionToken);
        if (!authorized || authorized.id !== admin.id) return { kind: "UNAUTHORIZED" } as const;
        const at = await now(tx);
        if (
          await tx.adminTelegramConnection.findFirst({
            where: { adminUserId: admin.id, disabledAt: null },
            select: { id: true },
          })
        )
          return { kind: "ALREADY_CONNECTED" } as const;
        const botUsername = await ready(tx, this.configuration, at);
        if (!botUsername) return { kind: "TELEGRAM_NOT_READY" } as const;
        if (!(await consume(tx, "ADMIN_USER", admin.id))) return { kind: "RATE_LIMITED" } as const;
        await tx.telegramLinkToken.updateMany({
          where: {
            purpose: "ADMIN_USER",
            adminUserId: admin.id,
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: at },
        });
        const expiresAt = new Date(at.getTime() + TELEGRAM_POLICY.linkTokenTtlMs);
        await tx.telegramLinkToken.create({
          data: {
            purpose: "ADMIN_USER",
            tokenHash: input.linkTokenHash,
            adminUserId: admin.id,
            createdAt: at,
            expiresAt,
          },
          select: { id: true },
        });
        return { kind: "ISSUED", expiresAt, botUsername } as const;
      }, TX);
    } catch (error) {
      storageFailure(error);
    }
  }

  async revokeAdmin(input: {
    adminUserId: string;
    sessionToken: unknown;
  }): Promise<TelegramAdminLinkRevokeResult> {
    checkedId(input.adminUserId);
    try {
      return await this.database.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; isActive: boolean }[]>(Prisma.sql`
          SELECT id, is_active AS "isActive" FROM admin_users
          WHERE id = ${input.adminUserId}::uuid FOR UPDATE
        `);
        const admin = rows.length === 1 ? rows[0]! : null;
        if (!admin || !admin.isActive) return { kind: "FORBIDDEN" } as const;
        const authorized = await getActiveAdminForShare(tx, input.sessionToken);
        if (!authorized || authorized.id !== admin.id) return { kind: "UNAUTHORIZED" } as const;
        await tx.telegramLinkToken.updateMany({
          where: {
            purpose: "ADMIN_USER",
            adminUserId: admin.id,
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: await now(tx) },
        });
        return { kind: "REVOKED" } as const;
      }, TX);
    } catch (error) {
      storageFailure(error);
    }
  }
}
