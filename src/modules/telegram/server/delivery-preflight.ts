import { z } from "zod";

import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import {
  buildTelegramMessage,
  type TelegramMessageBuilderInput,
  type TelegramResolvedVisit,
  type TelegramScheduledResolvedVisit,
} from "../domain/message-builder";
import {
  parseTelegramPayloadV1,
  TELEGRAM_NOTIFICATION_TYPES,
  type TelegramNotificationType,
  type TelegramPayloadV1ByType,
} from "../domain/payload-v1";
import {
  OUTBOX_INVALIDATION_CODES,
  outboxInvalidationSkipCode,
  outboxUuidSchema,
  type OutboxInvalidationCode,
  type OutboxSkipCode,
} from "./outbox-contract";

const inputSchema = z.strictObject({
  jobId: outboxUuidSchema,
  leaseToken: outboxUuidSchema,
});

export type TelegramDeliveryPreflightInput = z.input<typeof inputSchema>;
export type TelegramDeliveryPreflightResult =
  | Readonly<{ kind: "READY"; chatId: bigint; text: string }>
  | Readonly<{ kind: "SKIP"; code: OutboxSkipCode }>
  | Readonly<{
      kind: "DEAD";
      code: "PAYLOAD_VERSION_UNSUPPORTED" | "RESPONSE_INVALID";
    }>
  | Readonly<{ kind: "LEASE_LOST" }>;

type AppointmentStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";

export type TelegramDeliveryPreflightSnapshot = Readonly<{
  databaseNow: Date;
  id: string;
  type: string;
  status: string;
  scheduledAt: Date;
  expiresAt: Date | null;
  leaseToken: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  invalidatedAt: Date | null;
  invalidationCode: string | null;
  payloadVersion: unknown;
  payload: unknown;
  recipientKind: string;
  appointmentId: string | null;
  appointmentConnectionId: string | null;
  adminConnectionId: string | null;
  directChatId: bigint | null;
  appointmentConnectionAppointmentId: string | null;
  appointmentConnectionChatId: bigint | null;
  appointmentConnectionDisabledAt: Date | null;
  adminConnectionChatId: bigint | null;
  adminConnectionDisabledAt: Date | null;
  adminUserActive: boolean | null;
  appointmentStatus: string | null;
  appointmentStartsAt: Date | null;
  appointmentEndsAt: Date | null;
  appointmentServiceId: string | null;
  appointmentMasterId: string | null;
  appointmentServiceDurationSnapshot: number | null;
  appointmentServiceNameSnapshot: string | null;
  appointmentMasterName: string | null;
  businessTimeZone: string | null;
}>;

const uuidOrNullSchema = outboxUuidSchema.nullable();
const timestampOrNullSchema = z.date().nullable();
const snapshotSchema = z.strictObject({
  databaseNow: z.date(),
  id: outboxUuidSchema,
  type: z.string(),
  status: z.string(),
  scheduledAt: z.date(),
  expiresAt: timestampOrNullSchema,
  leaseToken: uuidOrNullSchema,
  claimedAt: timestampOrNullSchema,
  leaseExpiresAt: timestampOrNullSchema,
  invalidatedAt: timestampOrNullSchema,
  invalidationCode: z.string().nullable(),
  payloadVersion: z.unknown(),
  payload: z.unknown(),
  recipientKind: z.string(),
  appointmentId: uuidOrNullSchema,
  appointmentConnectionId: uuidOrNullSchema,
  adminConnectionId: uuidOrNullSchema,
  directChatId: z.bigint().nullable(),
  appointmentConnectionAppointmentId: uuidOrNullSchema,
  appointmentConnectionChatId: z.bigint().nullable(),
  appointmentConnectionDisabledAt: timestampOrNullSchema,
  adminConnectionChatId: z.bigint().nullable(),
  adminConnectionDisabledAt: timestampOrNullSchema,
  adminUserActive: z.boolean().nullable(),
  appointmentStatus: z.string().nullable(),
  appointmentStartsAt: timestampOrNullSchema,
  appointmentEndsAt: timestampOrNullSchema,
  appointmentServiceId: uuidOrNullSchema,
  appointmentMasterId: uuidOrNullSchema,
  appointmentServiceDurationSnapshot: z.number().int().positive().safe().nullable(),
  appointmentServiceNameSnapshot: z.string().nullable(),
  appointmentMasterName: z.string().nullable(),
  businessTimeZone: z.string().nullable(),
});

const supportedStatuses = new Set<AppointmentStatus>([
  "SCHEDULED",
  "CANCELLED",
  "COMPLETED",
  "NO_SHOW",
]);
const reminderLeadMs = 2 * 60 * 60_000;
const safeChatId = (value: bigint | null): value is bigint =>
  value !== null && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
const dead = (): TelegramDeliveryPreflightResult => ({ kind: "DEAD", code: "RESPONSE_INVALID" });

function exactRecipient(snapshot: TelegramDeliveryPreflightSnapshot): boolean {
  const noAppointmentConnection = snapshot.appointmentConnectionId === null;
  const noAdminConnection = snapshot.adminConnectionId === null;
  const noDirect = snapshot.directChatId === null;
  switch (snapshot.type) {
    case "ADMIN_APPOINTMENT_CREATED":
    case "ADMIN_APPOINTMENT_CANCELLED":
      return (
        snapshot.recipientKind === "ADMIN_CONNECTION" &&
        snapshot.appointmentId !== null &&
        noAppointmentConnection &&
        snapshot.adminConnectionId !== null &&
        noDirect
      );
    case "CLIENT_APPOINTMENT_CANCELLED":
    case "CLIENT_APPOINTMENT_CHANGED":
    case "CLIENT_APPOINTMENT_REMINDER":
    case "CLIENT_CONNECTION_CONFIRMED":
      return (
        snapshot.recipientKind === "APPOINTMENT_CONNECTION" &&
        snapshot.appointmentId !== null &&
        snapshot.appointmentConnectionId !== null &&
        noAdminConnection &&
        noDirect
      );
    case "ADMIN_CONNECTION_CONFIRMED":
      return (
        snapshot.recipientKind === "ADMIN_CONNECTION" &&
        snapshot.appointmentId === null &&
        noAppointmentConnection &&
        snapshot.adminConnectionId !== null &&
        noDirect
      );
    case "TELEGRAM_CONNECTION_REJECTED":
      return (
        snapshot.recipientKind === "DIRECT_CHAT" &&
        snapshot.appointmentId === null &&
        noAppointmentConnection &&
        noAdminConnection &&
        snapshot.directChatId !== null
      );
    default:
      return false;
  }
}

function activeConnection(
  snapshot: TelegramDeliveryPreflightSnapshot,
): { chatId: bigint } | TelegramDeliveryPreflightResult {
  if (snapshot.recipientKind === "APPOINTMENT_CONNECTION") {
    if (
      snapshot.appointmentConnectionAppointmentId !== snapshot.appointmentId ||
      snapshot.appointmentConnectionDisabledAt !== null ||
      !safeChatId(snapshot.appointmentConnectionChatId)
    ) {
      return { kind: "SKIP", code: "CONNECTION_INACTIVE" };
    }
    return { chatId: snapshot.appointmentConnectionChatId };
  }
  if (snapshot.recipientKind === "ADMIN_CONNECTION") {
    if (
      snapshot.adminConnectionDisabledAt !== null ||
      snapshot.adminUserActive !== true ||
      !safeChatId(snapshot.adminConnectionChatId)
    ) {
      return { kind: "SKIP", code: "CONNECTION_INACTIVE" };
    }
    return { chatId: snapshot.adminConnectionChatId };
  }
  return safeChatId(snapshot.directChatId) ? { chatId: snapshot.directChatId } : dead();
}

function resolvedVisit(snapshot: TelegramDeliveryPreflightSnapshot): TelegramResolvedVisit | null {
  if (
    !snapshot.appointmentStatus ||
    !supportedStatuses.has(snapshot.appointmentStatus as AppointmentStatus) ||
    !snapshot.appointmentStartsAt ||
    !snapshot.businessTimeZone ||
    !snapshot.appointmentServiceNameSnapshot ||
    !snapshot.appointmentMasterName
  ) {
    return null;
  }
  return {
    status: snapshot.appointmentStatus as AppointmentStatus,
    startsAt: snapshot.appointmentStartsAt.toISOString(),
    businessTimeZone: snapshot.businessTimeZone,
    serviceName: snapshot.appointmentServiceNameSnapshot,
    masterName: snapshot.appointmentMasterName,
  };
}

function reminderDecision(
  snapshot: TelegramDeliveryPreflightSnapshot,
  payload: TelegramPayloadV1ByType["CLIENT_APPOINTMENT_REMINDER"],
): TelegramScheduledResolvedVisit | TelegramDeliveryPreflightResult {
  if (snapshot.appointmentStatus !== "SCHEDULED") {
    return { kind: "SKIP", code: "APPOINTMENT_NOT_SCHEDULED" };
  }
  if (
    !snapshot.appointmentStartsAt ||
    !snapshot.appointmentEndsAt ||
    !snapshot.appointmentServiceId ||
    !snapshot.appointmentMasterId ||
    !snapshot.appointmentServiceDurationSnapshot
  ) {
    return { kind: "SKIP", code: "APPOINTMENT_NOT_SCHEDULED" };
  }
  const expected = payload.expectedVisit;
  if (
    snapshot.appointmentStartsAt.toISOString() !== expected.startsAt ||
    snapshot.appointmentEndsAt.toISOString() !== expected.endsAt ||
    snapshot.appointmentServiceId !== expected.serviceId ||
    snapshot.appointmentMasterId !== expected.masterId ||
    snapshot.appointmentServiceDurationSnapshot !== expected.durationMinutes ||
    snapshot.scheduledAt.getTime() !== snapshot.appointmentStartsAt.getTime() - reminderLeadMs
  ) {
    return { kind: "SKIP", code: "VISIT_MISMATCH" };
  }
  if (
    snapshot.expiresAt === null ||
    snapshot.databaseNow > snapshot.expiresAt ||
    snapshot.databaseNow >= snapshot.appointmentStartsAt
  ) {
    return { kind: "SKIP", code: "REMINDER_EXPIRED" };
  }
  const visit = resolvedVisit(snapshot);
  return visit?.status === "SCHEDULED" ? { ...visit, status: "SCHEDULED" } : dead();
}

export function classifyTelegramDeliveryPreflight(
  rawSnapshot: TelegramDeliveryPreflightSnapshot,
  expectedLeaseToken: string,
): TelegramDeliveryPreflightResult {
  const parsedSnapshot = snapshotSchema.safeParse(rawSnapshot);
  const parsedToken = outboxUuidSchema.safeParse(expectedLeaseToken);
  if (!parsedSnapshot.success || !parsedToken.success) return dead();
  const snapshot = parsedSnapshot.data;
  const now = snapshot.databaseNow;
  if (
    snapshot.status !== "PROCESSING" ||
    snapshot.leaseToken !== parsedToken.data ||
    snapshot.claimedAt === null ||
    snapshot.leaseExpiresAt === null ||
    snapshot.claimedAt > now ||
    snapshot.leaseExpiresAt <= now ||
    snapshot.leaseExpiresAt <= snapshot.claimedAt
  ) {
    return { kind: "LEASE_LOST" };
  }

  if ((snapshot.invalidatedAt === null) !== (snapshot.invalidationCode === null)) return dead();
  if (snapshot.invalidationCode !== null) {
    if (!(OUTBOX_INVALIDATION_CODES as readonly string[]).includes(snapshot.invalidationCode)) {
      return dead();
    }
    return {
      kind: "SKIP",
      code: outboxInvalidationSkipCode(snapshot.invalidationCode as OutboxInvalidationCode),
    };
  }
  if (snapshot.expiresAt !== null && now > snapshot.expiresAt) {
    return { kind: "SKIP", code: "REMINDER_EXPIRED" };
  }
  if (
    !(TELEGRAM_NOTIFICATION_TYPES as readonly string[]).includes(snapshot.type) ||
    !exactRecipient(snapshot)
  ) {
    return dead();
  }
  if (
    (snapshot.type === "CLIENT_APPOINTMENT_REMINDER" ||
      snapshot.type === "TELEGRAM_CONNECTION_REJECTED") &&
    snapshot.expiresAt === null
  ) {
    return dead();
  }

  const connection = activeConnection(snapshot);
  if (!("chatId" in connection)) return connection;
  const notificationType = snapshot.type as TelegramNotificationType;
  const payload = parseTelegramPayloadV1({
    notificationType,
    payloadVersion: snapshot.payloadVersion,
    payload: snapshot.payload,
  });
  if (!payload.ok) {
    return {
      kind: "DEAD",
      code:
        payload.code === "PAYLOAD_VERSION_UNSUPPORTED"
          ? "PAYLOAD_VERSION_UNSUPPORTED"
          : "RESPONSE_INVALID",
    };
  }

  let builderInput: TelegramMessageBuilderInput;
  if (notificationType === "CLIENT_APPOINTMENT_REMINDER") {
    const context = reminderDecision(
      snapshot,
      payload.payload as TelegramPayloadV1ByType["CLIENT_APPOINTMENT_REMINDER"],
    );
    if ("kind" in context) return context;
    builderInput = {
      notificationType,
      payloadVersion: payload.payloadVersion,
      payload: payload.payload,
      resolvedContext: context,
    };
  } else if (notificationType === "CLIENT_CONNECTION_CONFIRMED") {
    const context = resolvedVisit(snapshot);
    if (!context) return dead();
    builderInput = {
      notificationType,
      payloadVersion: payload.payloadVersion,
      payload: payload.payload,
      resolvedContext: context,
    };
  } else if (notificationType === "ADMIN_CONNECTION_CONFIRMED") {
    builderInput = {
      notificationType,
      payloadVersion: payload.payloadVersion,
      payload: payload.payload,
      resolvedContext: { adminStatus: "ACTIVE" },
    };
  } else {
    builderInput = {
      notificationType,
      payloadVersion: payload.payloadVersion,
      payload: payload.payload,
    } as TelegramMessageBuilderInput;
  }

  try {
    const message = buildTelegramMessage(builderInput);
    return { kind: "READY", chatId: connection.chatId, text: message.text };
  } catch {
    return dead();
  }
}

export class TelegramDeliveryPreflightError extends Error {
  constructor(readonly code: "PREFLIGHT_INPUT_INVALID" | "PREFLIGHT_STORAGE_FAILURE") {
    super(code);
    this.name = "TelegramDeliveryPreflightError";
  }

  toJSON() {
    return { name: this.name, code: this.code };
  }
}

const columns = Prisma.sql`
  clock_timestamp()::timestamptz(3) AS "databaseNow",
  o.id, o.type::text, o.status::text, o.scheduled_at AS "scheduledAt",
  o.expires_at AS "expiresAt", o.lease_token AS "leaseToken",
  o.claimed_at AS "claimedAt", o.lease_expires_at AS "leaseExpiresAt",
  o.invalidated_at AS "invalidatedAt", o.invalidation_code AS "invalidationCode",
  o.payload_version AS "payloadVersion", o.payload,
  o.recipient_kind::text AS "recipientKind", o.appointment_id AS "appointmentId",
  o.appointment_connection_id AS "appointmentConnectionId",
  o.admin_connection_id AS "adminConnectionId", o.direct_chat_id AS "directChatId",
  ac.appointment_id AS "appointmentConnectionAppointmentId",
  ac.telegram_chat_id AS "appointmentConnectionChatId",
  ac.disabled_at AS "appointmentConnectionDisabledAt",
  adc.telegram_chat_id AS "adminConnectionChatId",
  adc.disabled_at AS "adminConnectionDisabledAt", au.is_active AS "adminUserActive",
  a.status::text AS "appointmentStatus", a.starts_at AS "appointmentStartsAt",
  a.ends_at AS "appointmentEndsAt", a.service_id AS "appointmentServiceId",
  a.master_id AS "appointmentMasterId",
  a.service_duration_snapshot AS "appointmentServiceDurationSnapshot",
  a.service_name_snapshot AS "appointmentServiceNameSnapshot",
  m.name AS "appointmentMasterName", bs.timezone AS "businessTimeZone"
`;

export class TelegramDeliveryPreflight {
  constructor(private readonly database: PrismaClient) {}

  async check(input: TelegramDeliveryPreflightInput): Promise<TelegramDeliveryPreflightResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new TelegramDeliveryPreflightError("PREFLIGHT_INPUT_INVALID");
    try {
      const [snapshot] = await this.database.$queryRaw<TelegramDeliveryPreflightSnapshot[]>`
        SELECT ${columns}
        FROM notification_outbox o
        LEFT JOIN appointment_telegram_connections ac
          ON ac.id = o.appointment_connection_id
        LEFT JOIN admin_telegram_connections adc
          ON adc.id = o.admin_connection_id
        LEFT JOIN admin_users au ON au.id = adc.admin_user_id
        LEFT JOIN appointments a ON a.id = o.appointment_id
        LEFT JOIN masters m ON m.id = a.master_id
        LEFT JOIN business_settings bs ON bs.id = 1
        WHERE o.id = ${parsed.data.jobId}::uuid
      `;
      return snapshot
        ? classifyTelegramDeliveryPreflight(snapshot, parsed.data.leaseToken)
        : { kind: "LEASE_LOST" };
    } catch (error) {
      if (error instanceof TelegramDeliveryPreflightError) throw error;
      throw new TelegramDeliveryPreflightError("PREFLIGHT_STORAGE_FAILURE");
    }
  }
}
