import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import {
  getActiveAdmin,
  getActiveAdminForShare,
  validSessionToken,
} from "../../auth/server/auth-service";
import type { TelegramWebConfiguration } from "../domain/config-contract";
import { computeTelegramWebReadiness, type TelegramReadinessState } from "../domain/readiness";
import { invalidateTelegramOutbox } from "./outbox-repository";

const TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 10_000,
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type AdminTelegramState = "AVAILABLE" | "CONNECTED" | "UNAVAILABLE";
export type AdminTelegramReadRepositoryResult =
  { kind: AdminTelegramState } | { kind: "UNAUTHORIZED" };
export type AdminTelegramDisconnectRepositoryResult =
  { kind: "DISCONNECTED"; alreadyDisconnected: boolean } | { kind: "UNAUTHORIZED" };

type AdminSessionInput = {
  adminUserId: string;
  sessionToken: unknown;
};

export interface AdminTelegramStore {
  readAdmin(input: AdminSessionInput): Promise<AdminTelegramReadRepositoryResult>;
  disconnectAdmin(input: AdminSessionInput): Promise<AdminTelegramDisconnectRepositoryResult>;
}

export class AdminTelegramRepositoryError extends Error {
  constructor(readonly code: "ADMIN_TELEGRAM_INPUT_INVALID" | "ADMIN_TELEGRAM_STORAGE_FAILURE") {
    super(code);
    this.name = "AdminTelegramRepositoryError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

function checkedId(value: string) {
  if (!UUID.test(value)) throw new AdminTelegramRepositoryError("ADMIN_TELEGRAM_INPUT_INVALID");
}

function storageFailure(error: unknown): never {
  if (error instanceof AdminTelegramRepositoryError) throw error;
  throw new AdminTelegramRepositoryError("ADMIN_TELEGRAM_STORAGE_FAILURE");
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp()::timestamptz(3) AS now
  `;
  if (!(row?.now instanceof Date) || !Number.isFinite(row.now.getTime()))
    throw new AdminTelegramRepositoryError("ADMIN_TELEGRAM_STORAGE_FAILURE");
  return row.now;
}

async function webReady(
  tx: Prisma.TransactionClient,
  configuration: TelegramWebConfiguration,
  now: Date,
): Promise<boolean> {
  const rows = await tx.$queryRaw<TelegramReadinessState[]>`
    SELECT bot_user_id AS "botUserId", bot_username AS "botUsername",
      last_verified_at AS "lastVerifiedAt", last_poll_at AS "lastPollAt",
      last_error_code AS "lastErrorCode"
    FROM telegram_bot_state WHERE id = 1
  `;
  return computeTelegramWebReadiness({
    configuration,
    state: rows.length === 1 ? rows[0]! : null,
    now,
  }).ready;
}

type Invalidate = typeof invalidateTelegramOutbox;

export class AdminTelegramRepository implements AdminTelegramStore {
  constructor(
    private readonly database: PrismaClient,
    private readonly configuration: TelegramWebConfiguration,
    private readonly options: { invalidateOutbox?: Invalidate } = {},
  ) {}

  async readAdmin(input: AdminSessionInput): Promise<AdminTelegramReadRepositoryResult> {
    checkedId(input.adminUserId);
    if (!validSessionToken(input.sessionToken)) return { kind: "UNAUTHORIZED" };
    try {
      return await this.database.$transaction(async (tx) => {
        const authorized = await getActiveAdmin(tx, input.sessionToken);
        if (!authorized || authorized.id !== input.adminUserId)
          return { kind: "UNAUTHORIZED" } as const;

        const connected = await tx.adminTelegramConnection.findFirst({
          where: { adminUserId: authorized.id, disabledAt: null },
          select: { id: true },
        });
        if (connected) return { kind: "CONNECTED" } as const;

        const now = await databaseNow(tx);
        return (await webReady(tx, this.configuration, now))
          ? ({ kind: "AVAILABLE" } as const)
          : ({ kind: "UNAVAILABLE" } as const);
      }, TX);
    } catch (error) {
      storageFailure(error);
    }
  }

  async disconnectAdmin(
    input: AdminSessionInput,
  ): Promise<AdminTelegramDisconnectRepositoryResult> {
    checkedId(input.adminUserId);
    if (!validSessionToken(input.sessionToken)) return { kind: "UNAUTHORIZED" };
    try {
      return await this.database.$transaction(async (tx) => {
        // AdminUser is the common first row lock for issue, revoke, /start and disconnect.
        const admins = await tx.$queryRaw<{ id: string; isActive: boolean }[]>(Prisma.sql`
          SELECT id, is_active AS "isActive" FROM admin_users
          WHERE id = ${input.adminUserId}::uuid FOR UPDATE
        `);
        const admin = admins.length === 1 ? admins[0]! : null;
        if (!admin || !admin.isActive) return { kind: "UNAUTHORIZED" } as const;

        // The session and account remain stable through COMMIT after any lock wait.
        const authorized = await getActiveAdminForShare(tx, input.sessionToken);
        if (!authorized || authorized.id !== admin.id) return { kind: "UNAUTHORIZED" } as const;

        const now = await databaseNow(tx);
        const connections = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM admin_telegram_connections
          WHERE admin_user_id = ${admin.id}::uuid AND disabled_at IS NULL
          FOR UPDATE
        `;
        if (connections.length > 1)
          throw new AdminTelegramRepositoryError("ADMIN_TELEGRAM_STORAGE_FAILURE");
        const connection = connections[0] ?? null;

        await tx.telegramLinkToken.updateMany({
          where: {
            purpose: "ADMIN_USER",
            adminUserId: admin.id,
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });

        if (!connection) return { kind: "DISCONNECTED", alreadyDisconnected: true } as const;
        const disabled = await tx.adminTelegramConnection.updateMany({
          where: { id: connection.id, adminUserId: admin.id, disabledAt: null },
          data: { disabledAt: now, disabledReason: "USER_DISCONNECTED" },
        });
        if (disabled.count !== 1)
          throw new AdminTelegramRepositoryError("ADMIN_TELEGRAM_STORAGE_FAILURE");

        await (this.options.invalidateOutbox ?? invalidateTelegramOutbox)(tx, {
          target: { kind: "ADMIN_CONNECTION", id: connection.id },
          code: "CONNECTION_DISABLED",
          now,
        });
        return { kind: "DISCONNECTED", alreadyDisconnected: false } as const;
      }, TX);
    } catch (error) {
      storageFailure(error);
    }
  }
}
