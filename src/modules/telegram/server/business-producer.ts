import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/client";
import { buildAdminAppointmentCreatedDedupeKey } from "../domain/dedupe";
import {
  parseTelegramPayloadV1,
  visitSnapshotV1Schema,
  type VisitSnapshotV1,
} from "../domain/payload-v1";

const producerInputSchema = z.strictObject({
  source: z.enum(["ONLINE", "ADMIN"]),
  appointment: z.strictObject({
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
  }),
});

export type AdminAppointmentCreatedProducerInput = z.input<typeof producerInputSchema>;

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

function checkedInput(rawInput: unknown) {
  const parsed = producerInputSchema.safeParse(rawInput);
  if (!parsed.success) inputFailure();
  return parsed.data;
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
  const input = checkedInput(rawInput);
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
