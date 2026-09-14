import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import type { TelegramWebConfiguration } from "../domain/config-contract";
import { computeTelegramWebReadiness, type TelegramReadinessState } from "../domain/readiness";
import { invalidateTelegramOutbox } from "./outbox-repository";

const TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 10_000,
} as const;
const HASH = /^[0-9a-f]{64}$/;

export type AppointmentTelegramState = "AVAILABLE" | "CONNECTED" | "UNAVAILABLE";
export type AppointmentTelegramReadResult =
  { kind: AppointmentTelegramState } | { kind: "NOT_FOUND" };
export type AppointmentTelegramDisconnectResult =
  { kind: "DISCONNECTED"; alreadyDisconnected: boolean } | { kind: "NOT_FOUND" };

export interface AppointmentTelegramStore {
  readAppointment(hash: string): Promise<AppointmentTelegramReadResult>;
  disconnectAppointment(hash: string): Promise<AppointmentTelegramDisconnectResult>;
}

export class AppointmentTelegramRepositoryError extends Error {
  constructor(
    readonly code: "APPOINTMENT_TELEGRAM_INPUT_INVALID" | "APPOINTMENT_TELEGRAM_STORAGE_FAILURE",
  ) {
    super(code);
    this.name = "AppointmentTelegramRepositoryError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

function checkedHash(value: string) {
  if (!HASH.test(value))
    throw new AppointmentTelegramRepositoryError("APPOINTMENT_TELEGRAM_INPUT_INVALID");
}

function storageFailure(error: unknown): never {
  if (error instanceof AppointmentTelegramRepositoryError) throw error;
  throw new AppointmentTelegramRepositoryError("APPOINTMENT_TELEGRAM_STORAGE_FAILURE");
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp()::timestamptz(3) AS now
  `;
  if (!(row?.now instanceof Date) || !Number.isFinite(row.now.getTime()))
    throw new AppointmentTelegramRepositoryError("APPOINTMENT_TELEGRAM_STORAGE_FAILURE");
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

export class AppointmentTelegramRepository implements AppointmentTelegramStore {
  constructor(
    private readonly database: PrismaClient,
    private readonly configuration: TelegramWebConfiguration,
    private readonly options: { invalidateOutbox?: Invalidate } = {},
  ) {}

  async readAppointment(hash: string): Promise<AppointmentTelegramReadResult> {
    checkedHash(hash);
    try {
      return await this.database.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string; cancellationTokenHash: string; status: string; startsAt: Date }[]
        >`
          SELECT id, cancellation_token_hash AS "cancellationTokenHash",
            status::text AS status, starts_at AS "startsAt"
          FROM appointments WHERE cancellation_token_hash = ${hash}
        `;
        const appointment = rows.length === 1 ? rows[0]! : null;
        if (!appointment || appointment.cancellationTokenHash !== hash)
          return { kind: "NOT_FOUND" } as const;

        const connected = await tx.appointmentTelegramConnection.findFirst({
          where: { appointmentId: appointment.id, disabledAt: null },
          select: { id: true },
        });
        if (connected) return { kind: "CONNECTED" } as const;

        const now = await databaseNow(tx);
        if (appointment.status !== "SCHEDULED" || appointment.startsAt <= now)
          return { kind: "UNAVAILABLE" } as const;
        return (await webReady(tx, this.configuration, now))
          ? ({ kind: "AVAILABLE" } as const)
          : ({ kind: "UNAVAILABLE" } as const);
      }, TX);
    } catch (error) {
      storageFailure(error);
    }
  }

  async disconnectAppointment(hash: string): Promise<AppointmentTelegramDisconnectResult> {
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

        // Appointment is the common first lock for issue, revoke, /start and disconnect.
        const now = await databaseNow(tx);
        const connections = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM appointment_telegram_connections
          WHERE appointment_id = ${appointment.id}::uuid AND disabled_at IS NULL
          FOR UPDATE
        `;
        if (connections.length > 1)
          throw new AppointmentTelegramRepositoryError("APPOINTMENT_TELEGRAM_STORAGE_FAILURE");
        const connection = connections[0] ?? null;

        await tx.telegramLinkToken.updateMany({
          where: {
            purpose: "APPOINTMENT",
            appointmentId: appointment.id,
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });

        if (!connection) return { kind: "DISCONNECTED", alreadyDisconnected: true } as const;
        const disabled = await tx.appointmentTelegramConnection.updateMany({
          where: { id: connection.id, appointmentId: appointment.id, disabledAt: null },
          data: { disabledAt: now, disabledReason: "USER_DISCONNECTED" },
        });
        if (disabled.count !== 1)
          throw new AppointmentTelegramRepositoryError("APPOINTMENT_TELEGRAM_STORAGE_FAILURE");

        await (this.options.invalidateOutbox ?? invalidateTelegramOutbox)(tx, {
          target: { kind: "APPOINTMENT_CONNECTION", id: connection.id },
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
