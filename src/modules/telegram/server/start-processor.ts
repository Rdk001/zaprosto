import { createHash } from "node:crypto";

import type { Prisma } from "../../../generated/prisma/client";
import {
  buildAdminConnectionConfirmedDedupeKey,
  buildClientAppointmentReminderDedupeKey,
  buildClientConnectionConfirmedDedupeKey,
  buildTelegramConnectionRejectedDedupeKey,
} from "../domain/dedupe";
import { parseTelegramPayloadV1 } from "../domain/payload-v1";
import { calculateClientAppointmentReminderSchedule } from "../domain/reminder-schedule";
import type { ParsedTelegramStart } from "./start-command-parser";

const TOKEN_HASH = /^[0-9a-f]{64}$/;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const REJECTION_EXPIRY_MS = 5 * 60_000;
const UPDATE_LOCK_DOMAIN = "zaprosto:telegram-update:v1";
const ADMIN_CHAT_LOCK_DOMAIN = "zaprosto:telegram-admin-chat:v1";

type TelegramStartOutcomeKind = "CONNECTED" | "ALREADY_PROCESSED" | "REJECTED";
export type TelegramStartOutcome = Readonly<{ kind: TelegramStartOutcomeKind }>;

type InitialTokenRow = {
  id: string;
  tokenHash: string;
  purpose: string;
  appointmentId: string | null;
  adminUserId: string | null;
};

type LockedTokenRow = InitialTokenRow & {
  expiresAt: Date;
  usedAt: Date | null;
  usedByUpdateId: bigint | null;
  revokedAt: Date | null;
};

type AppointmentTarget = {
  id: string;
  version: number;
  serviceId: string;
  masterId: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  status: string;
};

type AdminTarget = { id: string; isActive: boolean };

export class TelegramStartProcessorError extends Error {
  constructor(readonly code: "START_PROCESSOR_INPUT_INVALID" | "START_PROCESSOR_STORAGE_FAILURE") {
    super(code);
    this.name = "TelegramStartProcessorError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

function inputFailure(): never {
  throw new TelegramStartProcessorError("START_PROCESSOR_INPUT_INVALID");
}

function storageFailure(): never {
  throw new TelegramStartProcessorError("START_PROCESSOR_STORAGE_FAILURE");
}

function checkedInput(input: unknown): ParsedTelegramStart {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    inputFailure();
  }

  const candidate = input as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join(",");
  if (
    keys !== "purpose,telegramChatId,telegramUserId,tokenHash,updateId" ||
    typeof candidate.updateId !== "bigint" ||
    candidate.updateId < 0n ||
    candidate.updateId > MAX_POSTGRES_BIGINT ||
    typeof candidate.telegramUserId !== "bigint" ||
    typeof candidate.telegramChatId !== "bigint" ||
    candidate.telegramUserId <= 0n ||
    candidate.telegramChatId <= 0n ||
    candidate.telegramUserId > MAX_POSTGRES_BIGINT ||
    candidate.telegramChatId > MAX_POSTGRES_BIGINT ||
    candidate.telegramUserId !== candidate.telegramChatId ||
    (candidate.purpose !== "APPOINTMENT" && candidate.purpose !== "ADMIN_USER") ||
    typeof candidate.tokenHash !== "string" ||
    !TOKEN_HASH.test(candidate.tokenHash)
  ) {
    inputFailure();
  }
  return candidate as ParsedTelegramStart;
}

function advisoryKey(domain: string, value: bigint): bigint {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value.toString(), "ascii")
    .digest()
    .readBigInt64BE(0);
}

async function acquireAdvisoryLock(
  tx: Prisma.TransactionClient,
  domain: string,
  value: bigint,
): Promise<void> {
  const rows = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT TRUE AS locked
    FROM (SELECT pg_advisory_xact_lock(${advisoryKey(domain, value)})) AS acquired
  `;
  if (rows.length !== 1 || rows[0]?.locked !== true) storageFailure();
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp()::timestamptz(3) AS now
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) storageFailure();
  return now;
}

async function alreadyProcessed(
  tx: Prisma.TransactionClient,
  input: ParsedTelegramStart,
): Promise<boolean> {
  const rejectionKey = buildTelegramConnectionRejectedDedupeKey({ updateId: input.updateId });
  const rows = await tx.$queryRaw<{ processed: boolean }[]>`
    SELECT (
      EXISTS (
        SELECT 1 FROM appointment_telegram_connections
        WHERE source_update_id = ${input.updateId}
      )
      OR EXISTS (
        SELECT 1 FROM admin_telegram_connections
        WHERE source_update_id = ${input.updateId}
      )
      OR EXISTS (
        SELECT 1 FROM telegram_link_tokens
        WHERE used_by_update_id = ${input.updateId}
      )
      OR EXISTS (
        SELECT 1 FROM notification_outbox
        WHERE dedupe_key = ${rejectionKey}
      )
    ) AS processed
  `;
  if (rows.length !== 1 || typeof rows[0]?.processed !== "boolean") storageFailure();
  return rows[0].processed;
}

async function findInitialToken(
  tx: Prisma.TransactionClient,
  tokenHash: string,
): Promise<InitialTokenRow | null> {
  const rows = await tx.$queryRaw<InitialTokenRow[]>`
    SELECT id, token_hash AS "tokenHash", purpose::text AS purpose,
      appointment_id AS "appointmentId", admin_user_id AS "adminUserId"
    FROM telegram_link_tokens
    WHERE token_hash = ${tokenHash}
  `;
  if (rows.length > 1) storageFailure();
  return rows[0] ?? null;
}

async function lockToken(
  tx: Prisma.TransactionClient,
  tokenHash: string,
): Promise<LockedTokenRow | null> {
  const rows = await tx.$queryRaw<LockedTokenRow[]>`
    SELECT id, token_hash AS "tokenHash", purpose::text AS purpose,
      appointment_id AS "appointmentId", admin_user_id AS "adminUserId",
      expires_at AS "expiresAt", used_at AS "usedAt",
      used_by_update_id AS "usedByUpdateId", revoked_at AS "revokedAt"
    FROM telegram_link_tokens
    WHERE token_hash = ${tokenHash}
    FOR UPDATE
  `;
  if (rows.length > 1) storageFailure();
  return rows[0] ?? null;
}

function hasExactTarget(token: InitialTokenRow, input: ParsedTelegramStart, targetId: string) {
  return (
    token.tokenHash === input.tokenHash &&
    token.purpose === input.purpose &&
    (input.purpose === "APPOINTMENT"
      ? token.appointmentId === targetId && token.adminUserId === null
      : token.adminUserId === targetId && token.appointmentId === null)
  );
}

async function reject(
  tx: Prisma.TransactionClient,
  input: ParsedTelegramStart,
  now?: Date,
): Promise<TelegramStartOutcome> {
  const at = now ?? (await databaseNow(tx));
  const created = await tx.notificationOutbox.createMany({
    data: {
      recipientKind: "DIRECT_CHAT",
      directChatId: input.telegramChatId,
      appointmentId: null,
      appointmentConnectionId: null,
      adminConnectionId: null,
      type: "TELEGRAM_CONNECTION_REJECTED",
      status: "PENDING",
      scheduledAt: at,
      nextAttemptAt: at,
      expiresAt: new Date(at.getTime() + REJECTION_EXPIRY_MS),
      payloadVersion: 1,
      payload: {},
      dedupeKey: buildTelegramConnectionRejectedDedupeKey({ updateId: input.updateId }),
    },
    skipDuplicates: true,
  });
  return { kind: created.count === 0 ? "ALREADY_PROCESSED" : "REJECTED" };
}

function validLockedToken(
  initial: InitialTokenRow,
  locked: LockedTokenRow | null,
  input: ParsedTelegramStart,
  targetId: string,
): locked is LockedTokenRow {
  return (
    locked !== null &&
    locked.id === initial.id &&
    hasExactTarget(locked, input, targetId) &&
    locked.expiresAt instanceof Date &&
    Number.isFinite(locked.expiresAt.getTime()) &&
    (locked.usedAt === null || locked.usedAt instanceof Date) &&
    (locked.revokedAt === null || locked.revokedAt instanceof Date)
  );
}

async function repeatedConnectionMatches(
  tx: Prisma.TransactionClient,
  input: ParsedTelegramStart,
  token: LockedTokenRow,
  targetId: string,
): Promise<boolean> {
  if (!(token.usedAt instanceof Date) || token.usedByUpdateId === null) return false;
  if (input.purpose === "APPOINTMENT") {
    const row = await tx.appointmentTelegramConnection.findFirst({
      where: { sourceUpdateId: token.usedByUpdateId, appointmentId: targetId },
      select: { telegramUserId: true, telegramChatId: true },
    });
    return (
      row?.telegramUserId === input.telegramUserId && row.telegramChatId === input.telegramChatId
    );
  }
  const row = await tx.adminTelegramConnection.findFirst({
    where: { sourceUpdateId: token.usedByUpdateId, adminUserId: targetId },
    select: { telegramUserId: true, telegramChatId: true },
  });
  return (
    row?.telegramUserId === input.telegramUserId && row.telegramChatId === input.telegramChatId
  );
}

async function processAppointment(
  tx: Prisma.TransactionClient,
  input: ParsedTelegramStart,
  initial: InitialTokenRow,
  appointmentId: string,
): Promise<TelegramStartOutcome> {
  const targets = await tx.$queryRaw<AppointmentTarget[]>`
    SELECT id, version, service_id AS "serviceId", master_id AS "masterId",
      starts_at AS "startsAt", ends_at AS "endsAt",
      service_duration_snapshot AS "durationMinutes", status::text AS status
    FROM appointments
    WHERE id = ${appointmentId}::uuid
    FOR UPDATE
  `;
  if (targets.length > 1) storageFailure();
  const target = targets[0];
  if (!target) return reject(tx, input);

  const token = await lockToken(tx, input.tokenHash);
  const now = await databaseNow(tx);
  if (!validLockedToken(initial, token, input, target.id)) return reject(tx, input, now);
  if (token.usedAt !== null || token.usedByUpdateId !== null) {
    return token.usedAt !== null &&
      token.usedByUpdateId !== null &&
      (await repeatedConnectionMatches(tx, input, token, target.id))
      ? { kind: "ALREADY_PROCESSED" }
      : reject(tx, input, now);
  }
  if (
    token.revokedAt !== null ||
    token.expiresAt <= now ||
    target.status !== "SCHEDULED" ||
    !(target.startsAt instanceof Date) ||
    !(target.endsAt instanceof Date) ||
    !Number.isSafeInteger(target.version) ||
    target.version < 0 ||
    !Number.isSafeInteger(target.durationMinutes) ||
    target.durationMinutes <= 0 ||
    target.startsAt <= now ||
    target.endsAt <= target.startsAt
  ) {
    return reject(tx, input, now);
  }
  const existing = await tx.appointmentTelegramConnection.findFirst({
    where: { appointmentId: target.id, disabledAt: null },
    select: { id: true },
  });
  if (existing) return reject(tx, input, now);

  const connection = await tx.appointmentTelegramConnection.create({
    data: {
      appointmentId: target.id,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      sourceUpdateId: input.updateId,
      connectedAt: now,
    },
    select: { id: true },
  });
  const used = await tx.telegramLinkToken.updateMany({
    where: { id: token.id, usedAt: null, usedByUpdateId: null, revokedAt: null },
    data: { usedAt: now, usedByUpdateId: input.updateId },
  });
  if (used.count !== 1) storageFailure();

  await tx.notificationOutbox.create({
    data: {
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: target.id,
      appointmentConnectionId: connection.id,
      adminConnectionId: null,
      directChatId: null,
      type: "CLIENT_CONNECTION_CONFIRMED",
      status: "PENDING",
      scheduledAt: now,
      nextAttemptAt: now,
      expiresAt: null,
      payloadVersion: 1,
      payload: {},
      dedupeKey: buildClientConnectionConfirmedDedupeKey({
        appointmentConnectionId: connection.id,
      }),
    },
    select: { id: true },
  });

  const reminderSchedule = calculateClientAppointmentReminderSchedule({
    startsAt: target.startsAt,
    now,
  });

  if (reminderSchedule !== null) {
    const { scheduledAt, expiresAt } = reminderSchedule;
    const payload = parseTelegramPayloadV1({
      notificationType: "CLIENT_APPOINTMENT_REMINDER",
      payloadVersion: 1,
      payload: {
        visitVersion: target.version,
        expectedVisit: {
          serviceId: target.serviceId,
          masterId: target.masterId,
          startsAt: target.startsAt.toISOString(),
          endsAt: target.endsAt.toISOString(),
          durationMinutes: target.durationMinutes,
        },
      },
    });
    if (!payload.ok) storageFailure();
    await tx.notificationOutbox.create({
      data: {
        recipientKind: "APPOINTMENT_CONNECTION",
        appointmentId: target.id,
        appointmentConnectionId: connection.id,
        adminConnectionId: null,
        directChatId: null,
        type: "CLIENT_APPOINTMENT_REMINDER",
        status: "PENDING",
        scheduledAt,
        nextAttemptAt: scheduledAt,
        expiresAt,
        payloadVersion: 1,
        payload: payload.payload,
        dedupeKey: buildClientAppointmentReminderDedupeKey({
          appointmentId: target.id,
          visitVersion: target.version,
          appointmentConnectionId: connection.id,
        }),
      },
      select: { id: true },
    });
  }

  return { kind: "CONNECTED" };
}

async function processAdmin(
  tx: Prisma.TransactionClient,
  input: ParsedTelegramStart,
  initial: InitialTokenRow,
  adminUserId: string,
): Promise<TelegramStartOutcome> {
  const targets = await tx.$queryRaw<AdminTarget[]>`
    SELECT id, is_active AS "isActive"
    FROM admin_users
    WHERE id = ${adminUserId}::uuid
    FOR UPDATE
  `;
  if (targets.length > 1) storageFailure();
  const target = targets[0];
  if (!target) return reject(tx, input);

  // Every administrative connection path takes this lock after AdminUser and before link-token.
  await acquireAdvisoryLock(tx, ADMIN_CHAT_LOCK_DOMAIN, input.telegramChatId);
  const token = await lockToken(tx, input.tokenHash);
  const now = await databaseNow(tx);
  if (!validLockedToken(initial, token, input, target.id)) return reject(tx, input, now);
  if (token.usedAt !== null || token.usedByUpdateId !== null) {
    return token.usedAt !== null &&
      token.usedByUpdateId !== null &&
      (await repeatedConnectionMatches(tx, input, token, target.id))
      ? { kind: "ALREADY_PROCESSED" }
      : reject(tx, input, now);
  }
  if (token.revokedAt !== null || token.expiresAt <= now || target.isActive !== true) {
    return reject(tx, input, now);
  }
  const [targetConnection, chatConnection] = await Promise.all([
    tx.adminTelegramConnection.findFirst({
      where: { adminUserId: target.id, disabledAt: null },
      select: { id: true },
    }),
    tx.adminTelegramConnection.findFirst({
      where: { telegramChatId: input.telegramChatId, disabledAt: null },
      select: { id: true, adminUserId: true },
    }),
  ]);
  if (targetConnection || (chatConnection && chatConnection.adminUserId !== target.id)) {
    return reject(tx, input, now);
  }

  const connection = await tx.adminTelegramConnection.create({
    data: {
      adminUserId: target.id,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      sourceUpdateId: input.updateId,
      connectedAt: now,
    },
    select: { id: true },
  });
  const used = await tx.telegramLinkToken.updateMany({
    where: { id: token.id, usedAt: null, usedByUpdateId: null, revokedAt: null },
    data: { usedAt: now, usedByUpdateId: input.updateId },
  });
  if (used.count !== 1) storageFailure();
  await tx.notificationOutbox.create({
    data: {
      recipientKind: "ADMIN_CONNECTION",
      appointmentId: null,
      appointmentConnectionId: null,
      adminConnectionId: connection.id,
      directChatId: null,
      type: "ADMIN_CONNECTION_CONFIRMED",
      status: "PENDING",
      scheduledAt: now,
      nextAttemptAt: now,
      expiresAt: null,
      payloadVersion: 1,
      payload: {},
      dedupeKey: buildAdminConnectionConfirmedDedupeKey({
        adminConnectionId: connection.id,
      }),
    },
    select: { id: true },
  });
  return { kind: "CONNECTED" };
}

// Caller owns the transaction. This function performs no network calls and never starts a nested tx.
export async function processTelegramStart(
  tx: Prisma.TransactionClient,
  rawInput: unknown,
): Promise<TelegramStartOutcome> {
  try {
    const input = checkedInput(rawInput);

    await acquireAdvisoryLock(tx, UPDATE_LOCK_DOMAIN, input.updateId);
    if (await alreadyProcessed(tx, input)) return { kind: "ALREADY_PROCESSED" };

    // Phase 1 is intentionally unlocked: it identifies which target must be locked first.
    const initial = await findInitialToken(tx, input.tokenHash);
    if (!initial || initial.purpose !== input.purpose) return reject(tx, input);
    if (
      input.purpose === "APPOINTMENT" &&
      initial.appointmentId !== null &&
      initial.adminUserId === null
    ) {
      return await processAppointment(tx, input, initial, initial.appointmentId);
    }
    if (
      input.purpose === "ADMIN_USER" &&
      initial.adminUserId !== null &&
      initial.appointmentId === null
    ) {
      return await processAdmin(tx, input, initial, initial.adminUserId);
    }
    return reject(tx, input);
  } catch (error) {
    if (error instanceof TelegramStartProcessorError) throw error;
    throw new TelegramStartProcessorError("START_PROCESSOR_STORAGE_FAILURE");
  }
}
