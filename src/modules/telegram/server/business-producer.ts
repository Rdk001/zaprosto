import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/client";
import {
  buildAdminAppointmentCancelledDedupeKey,
  buildAdminAppointmentCreatedDedupeKey,
  buildClientAppointmentCancelledDedupeKey,
  buildClientAppointmentChangedDedupeKey,
  buildClientAppointmentReminderDedupeKey,
} from "../domain/dedupe";
import {
  parseTelegramPayloadV1,
  visitSnapshotV1Schema,
  type TelegramChangedField,
  type VisitSnapshotV1,
} from "../domain/payload-v1";
import { invalidateTelegramOutbox } from "./outbox-repository";

import { calculateClientAppointmentReminderSchedule } from "../domain/reminder-schedule";

const appointmentEventSchema = z.strictObject({
  id: z.uuid(),
  version: z.number().int().nonnegative().safe(),
  serviceId: z.uuid(),
  masterId: z.uuid(),
  startsAt: z.date(),
  endsAt: z.date(),
  durationMinutes: z.number().int().positive().safe(),
  businessTimeZone: z.string(),
  serviceName: z.string(),
  masterName: z.string(),
});

const createdProducerInputSchema = z.strictObject({
  source: z.enum(["ONLINE", "ADMIN"]),
  appointment: appointmentEventSchema,
});
const cancellationProducerInputSchema = z.strictObject({
  actor: z.enum(["CLIENT", "ADMIN"]),
  appointment: appointmentEventSchema,
});
const appointmentRescheduledProducerInputSchema = z.strictObject({
  appointmentId: z.uuid(),
  appointmentVersion: z.number().int().nonnegative().safe(),
  occurredAt: z.date(),
  before: appointmentEventSchema.omit({ id: true, version: true }),
  after: appointmentEventSchema.omit({ id: true, version: true }),
});
const terminalInvalidationInputSchema = z.strictObject({
  appointmentId: z.uuid(),
  code: z.enum(["APPOINTMENT_COMPLETED", "APPOINTMENT_NO_SHOW"]),
});

export type AdminAppointmentCreatedProducerInput = z.input<typeof createdProducerInputSchema>;
export type AppointmentCancelledProducerInput = z.input<typeof cancellationProducerInputSchema>;
export type AppointmentRescheduledProducerInput = z.input<
  typeof appointmentRescheduledProducerInputSchema
>;
export type AppointmentTerminalInvalidationInput = z.input<typeof terminalInvalidationInputSchema>;

export class TelegramBusinessProducerError extends Error {
  constructor(readonly code: "BUSINESS_PRODUCER_INPUT_INVALID" | "BUSINESS_PRODUCER_DATA_INVALID") {
    super(code);
    this.name = "TelegramBusinessProducerError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

function inputFailure(): never {
  throw new TelegramBusinessProducerError("BUSINESS_PRODUCER_INPUT_INVALID");
}

function checkedInput<Schema extends z.ZodType>(
  schema: Schema,
  rawInput: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) inputFailure();
  return parsed.data;
}

function changedFields(before: VisitSnapshotV1, after: VisitSnapshotV1): TelegramChangedField[] {
  const fields: TelegramChangedField[] = [];
  if (
    before.serviceId !== after.serviceId ||
    before.serviceName !== after.serviceName ||
    before.durationMinutes !== after.durationMinutes
  ) {
    fields.push("SERVICE");
  }
  if (before.masterId !== after.masterId || before.masterName !== after.masterName) {
    fields.push("MASTER");
  }
  if (before.startsAt !== after.startsAt) {
    fields.push("STARTS_AT");
  }
  return fields;
}

export function adminAppointmentCreatedSource(source: "ONLINE" | "ADMIN"): "PUBLIC" | "ADMIN" {
  return source === "ONLINE" ? "PUBLIC" : "ADMIN";
}

export function buildVisitSnapshotV1(input: {
  serviceId: string;
  masterId: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  businessTimeZone: string;
  serviceName: string;
  masterName: string;
}): VisitSnapshotV1 {
  if (
    !(input.startsAt instanceof Date) ||
    !Number.isFinite(input.startsAt.getTime()) ||
    !(input.endsAt instanceof Date) ||
    !Number.isFinite(input.endsAt.getTime())
  ) {
    inputFailure();
  }
  const parsed = visitSnapshotV1Schema.safeParse({
    serviceId: input.serviceId,
    masterId: input.masterId,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
    durationMinutes: input.durationMinutes,
    businessTimeZone: input.businessTimeZone,
    serviceName: input.serviceName,
    masterName: input.masterName,
  });
  if (!parsed.success) inputFailure();
  return parsed.data;
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp()::timestamptz(3) AS now
  `;
  const now = rows[0]?.now;
  if (rows.length !== 1 || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TelegramBusinessProducerError("BUSINESS_PRODUCER_DATA_INVALID");
  }
  return now;
}

// Caller owns the business transaction. This helper never opens another transaction or performs network I/O.
export async function produceAdminAppointmentCreated(
  tx: Prisma.TransactionClient,
  rawInput: AdminAppointmentCreatedProducerInput,
): Promise<{ created: number }> {
  const input = checkedInput(createdProducerInputSchema, rawInput);
  const recipients = await tx.adminTelegramConnection.findMany({
    where: { disabledAt: null, adminUser: { isActive: true } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (recipients.length === 0) return { created: 0 };

  const occurredAt = await databaseNow(tx);
  const visit = buildVisitSnapshotV1({
    serviceId: input.appointment.serviceId,
    masterId: input.appointment.masterId,
    startsAt: input.appointment.startsAt,
    endsAt: input.appointment.endsAt,
    durationMinutes: input.appointment.durationMinutes,
    businessTimeZone: input.appointment.businessTimeZone,
    serviceName: input.appointment.serviceName,
    masterName: input.appointment.masterName,
  });
  const payload = parseTelegramPayloadV1({
    notificationType: "ADMIN_APPOINTMENT_CREATED",
    payloadVersion: 1,
    payload: {
      source: adminAppointmentCreatedSource(input.source),
      appointmentVersion: input.appointment.version,
      occurredAt: occurredAt.toISOString(),
      visit,
    },
  });
  if (!payload.ok) inputFailure();

  const created = await tx.notificationOutbox.createMany({
    data: recipients.map(({ id: adminConnectionId }) => ({
      recipientKind: "ADMIN_CONNECTION" as const,
      appointmentId: input.appointment.id,
      appointmentConnectionId: null,
      adminConnectionId,
      directChatId: null,
      type: "ADMIN_APPOINTMENT_CREATED" as const,
      status: "PENDING" as const,
      scheduledAt: occurredAt,
      nextAttemptAt: occurredAt,
      expiresAt: null,
      attempts: 0,
      leaseToken: null,
      leaseOwner: null,
      claimedAt: null,
      leaseExpiresAt: null,
      invalidatedAt: null,
      invalidationCode: null,
      lastErrorCode: null,
      payloadVersion: 1,
      payload: payload.payload,
      dedupeKey: buildAdminAppointmentCreatedDedupeKey({
        appointmentId: input.appointment.id,
        version: input.appointment.version,
        adminConnectionId,
      }),
      sentAt: null,
      finishedAt: null,
    })),
  });
  return { created: created.count };
}

// Invalidates the old reminder and creates every cancellation notification in the caller's
// business transaction. One database timestamp is shared by invalidation and the entire fan-out.
export async function produceAppointmentCancelled(
  tx: Prisma.TransactionClient,
  rawInput: AppointmentCancelledProducerInput,
): Promise<{
  adminCreated: number;
  clientCreated: number;
  reminderCancelled: number;
  reminderInvalidated: number;
}> {
  const input = checkedInput(cancellationProducerInputSchema, rawInput);
  // Stabilize active administrative recipients through COMMIT. A concurrent disable/deactivate
  // either wins before this read and is excluded, or waits and invalidates the newly committed job.
  const adminRecipients = await tx.$queryRaw<{ id: string }[]>`
    SELECT c.id
    FROM admin_telegram_connections c
    JOIN admin_users a ON a.id = c.admin_user_id
    WHERE c.disabled_at IS NULL AND a.is_active = true
    ORDER BY c.id
    FOR SHARE OF c, a
  `;
  const clientRecipient =
    input.actor === "ADMIN"
      ? await tx.appointmentTelegramConnection.findFirst({
          where: { appointmentId: input.appointment.id, disabledAt: null },
          select: { id: true },
        })
      : null;
  const occurredAt = await databaseNow(tx);
  const invalidation = await invalidateTelegramOutbox(tx, {
    target: {
      kind: "APPOINTMENT",
      id: input.appointment.id,
      types: ["CLIENT_APPOINTMENT_REMINDER"],
    },
    code: "APPOINTMENT_CANCELLED",
    now: occurredAt,
  });
  const visit = buildVisitSnapshotV1(input.appointment);
  const adminPayload = parseTelegramPayloadV1({
    notificationType: "ADMIN_APPOINTMENT_CANCELLED",
    payloadVersion: 1,
    payload: {
      actor: input.actor,
      appointmentVersion: input.appointment.version,
      occurredAt: occurredAt.toISOString(),
      visit,
    },
  });
  if (!adminPayload.ok) inputFailure();

  const jobs: Prisma.NotificationOutboxCreateManyInput[] = adminRecipients.map(
    ({ id: adminConnectionId }) => ({
      recipientKind: "ADMIN_CONNECTION" as const,
      appointmentId: input.appointment.id,
      appointmentConnectionId: null,
      adminConnectionId,
      directChatId: null,
      type: "ADMIN_APPOINTMENT_CANCELLED" as const,
      status: "PENDING" as const,
      scheduledAt: occurredAt,
      nextAttemptAt: occurredAt,
      expiresAt: null,
      attempts: 0,
      leaseToken: null,
      leaseOwner: null,
      claimedAt: null,
      leaseExpiresAt: null,
      invalidatedAt: null,
      invalidationCode: null,
      lastErrorCode: null,
      payloadVersion: 1,
      payload: adminPayload.payload,
      dedupeKey: buildAdminAppointmentCancelledDedupeKey({
        appointmentId: input.appointment.id,
        version: input.appointment.version,
        adminConnectionId,
      }),
      sentAt: null,
      finishedAt: null,
    }),
  );

  if (clientRecipient) {
    const clientPayload = parseTelegramPayloadV1({
      notificationType: "CLIENT_APPOINTMENT_CANCELLED",
      payloadVersion: 1,
      payload: {
        actor: "ADMIN",
        appointmentVersion: input.appointment.version,
        occurredAt: occurredAt.toISOString(),
        visit,
      },
    });
    if (!clientPayload.ok) inputFailure();
    jobs.push({
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: input.appointment.id,
      appointmentConnectionId: clientRecipient.id,
      adminConnectionId: null,
      directChatId: null,
      type: "CLIENT_APPOINTMENT_CANCELLED",
      status: "PENDING",
      scheduledAt: occurredAt,
      nextAttemptAt: occurredAt,
      expiresAt: null,
      attempts: 0,
      leaseToken: null,
      leaseOwner: null,
      claimedAt: null,
      leaseExpiresAt: null,
      invalidatedAt: null,
      invalidationCode: null,
      lastErrorCode: null,
      payloadVersion: 1,
      payload: clientPayload.payload,
      dedupeKey: buildClientAppointmentCancelledDedupeKey({
        appointmentId: input.appointment.id,
        version: input.appointment.version,
        appointmentConnectionId: clientRecipient.id,
      }),
      sentAt: null,
      finishedAt: null,
    });
  }

  if (jobs.length > 0) {
    await tx.notificationOutbox.createMany({ data: jobs });
  }
  return {
    adminCreated: adminRecipients.length,
    clientCreated: clientRecipient ? 1 : 0,
    reminderCancelled: invalidation.cancelled,
    reminderInvalidated: invalidation.invalidated,
  };
}

// The caller holds the Appointment lock and owns the business transaction. The shared
// connection lock keeps disconnect from invalidating a job between recipient selection and COMMIT.
export async function produceAdminAppointmentRescheduled(
  tx: Prisma.TransactionClient,
  rawInput: AppointmentRescheduledProducerInput,
): Promise<{
  changedCreated: number;
  reminderCreated: number;
  reminderCancelled: number;
  reminderInvalidated: number;
}> {
  const input = checkedInput(appointmentRescheduledProducerInputSchema, rawInput);
  const invalidation = await invalidateTelegramOutbox(tx, {
    target: {
      kind: "APPOINTMENT",
      id: input.appointmentId,
      types: ["CLIENT_APPOINTMENT_REMINDER"],
    },
    code: "VISIT_CHANGED",
    now: input.occurredAt,
  });
  const recipients = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM appointment_telegram_connections
    WHERE appointment_id = ${input.appointmentId}::uuid AND disabled_at IS NULL
    ORDER BY id
    FOR SHARE
  `;
  if (recipients.length > 1) {
    throw new TelegramBusinessProducerError("BUSINESS_PRODUCER_DATA_INVALID");
  }
  const recipient = recipients[0];
  if (!recipient) {
    return {
      changedCreated: 0,
      reminderCreated: 0,
      reminderCancelled: invalidation.cancelled,
      reminderInvalidated: invalidation.invalidated,
    };
  }

  const before = buildVisitSnapshotV1(input.before);
  const after = buildVisitSnapshotV1(input.after);
  const fields = changedFields(before, after);
  const jobs: Prisma.NotificationOutboxCreateManyInput[] = [];

  if (fields.length > 0) {
    const changedPayload = parseTelegramPayloadV1({
      notificationType: "CLIENT_APPOINTMENT_CHANGED",
      payloadVersion: 1,
      payload: {
        appointmentVersion: input.appointmentVersion,
        occurredAt: input.occurredAt.toISOString(),
        changedFields: fields,
        before,
        after,
      },
    });
    if (!changedPayload.ok) inputFailure();
    jobs.push({
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: input.appointmentId,
      appointmentConnectionId: recipient.id,
      adminConnectionId: null,
      directChatId: null,
      type: "CLIENT_APPOINTMENT_CHANGED",
      status: "PENDING",
      scheduledAt: input.occurredAt,
      nextAttemptAt: input.occurredAt,
      expiresAt: null,
      attempts: 0,
      leaseToken: null,
      leaseOwner: null,
      claimedAt: null,
      leaseExpiresAt: null,
      invalidatedAt: null,
      invalidationCode: null,
      lastErrorCode: null,
      payloadVersion: 1,
      payload: changedPayload.payload,
      dedupeKey: buildClientAppointmentChangedDedupeKey({
        appointmentId: input.appointmentId,
        version: input.appointmentVersion,
        appointmentConnectionId: recipient.id,
      }),
      sentAt: null,
      finishedAt: null,
    });
  }

  const reminderSchedule = calculateClientAppointmentReminderSchedule({
    startsAt: input.after.startsAt,
    now: input.occurredAt,
  });
  if (reminderSchedule) {
    const reminderPayload = parseTelegramPayloadV1({
      notificationType: "CLIENT_APPOINTMENT_REMINDER",
      payloadVersion: 1,
      payload: {
        visitVersion: input.appointmentVersion,
        expectedVisit: {
          serviceId: after.serviceId,
          masterId: after.masterId,
          startsAt: after.startsAt,
          endsAt: after.endsAt,
          durationMinutes: after.durationMinutes,
        },
      },
    });
    if (!reminderPayload.ok) inputFailure();
    jobs.push({
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: input.appointmentId,
      appointmentConnectionId: recipient.id,
      adminConnectionId: null,
      directChatId: null,
      type: "CLIENT_APPOINTMENT_REMINDER",
      status: "PENDING",
      scheduledAt: reminderSchedule.scheduledAt,
      nextAttemptAt: reminderSchedule.scheduledAt,
      expiresAt: reminderSchedule.expiresAt,
      attempts: 0,
      leaseToken: null,
      leaseOwner: null,
      claimedAt: null,
      leaseExpiresAt: null,
      invalidatedAt: null,
      invalidationCode: null,
      lastErrorCode: null,
      payloadVersion: 1,
      payload: reminderPayload.payload,
      dedupeKey: buildClientAppointmentReminderDedupeKey({
        appointmentId: input.appointmentId,
        visitVersion: input.appointmentVersion,
        appointmentConnectionId: recipient.id,
      }),
      sentAt: null,
      finishedAt: null,
    });
  }

  if (jobs.length > 0) {
    await tx.notificationOutbox.createMany({ data: jobs });
  }
  return {
    changedCreated: fields.length > 0 ? 1 : 0,
    reminderCreated: reminderSchedule ? 1 : 0,
    reminderCancelled: invalidation.cancelled,
    reminderInvalidated: invalidation.invalidated,
  };
}

export async function invalidateAppointmentReminderForTerminalStatus(
  tx: Prisma.TransactionClient,
  rawInput: AppointmentTerminalInvalidationInput,
): Promise<{ cancelled: number; invalidated: number }> {
  const input = checkedInput(terminalInvalidationInputSchema, rawInput);
  const occurredAt = await databaseNow(tx);
  return invalidateTelegramOutbox(tx, {
    target: {
      kind: "APPOINTMENT",
      id: input.appointmentId,
      types: ["CLIENT_APPOINTMENT_REMINDER"],
    },
    code: input.code,
    now: occurredAt,
  });
}
