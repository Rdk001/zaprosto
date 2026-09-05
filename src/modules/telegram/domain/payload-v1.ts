import { z } from "zod";

import { TELEGRAM_POLICY } from "./policy";

export const TELEGRAM_NOTIFICATION_TYPES = [
  "ADMIN_APPOINTMENT_CREATED",
  "ADMIN_APPOINTMENT_CANCELLED",
  "CLIENT_APPOINTMENT_CANCELLED",
  "CLIENT_APPOINTMENT_CHANGED",
  "CLIENT_APPOINTMENT_REMINDER",
  "CLIENT_CONNECTION_CONFIRMED",
  "ADMIN_CONNECTION_CONFIRMED",
  "TELEGRAM_CONNECTION_REJECTED",
] as const;

export type TelegramNotificationType = (typeof TELEGRAM_NOTIFICATION_TYPES)[number];

const canonicalUuidSchema = z.uuid().transform((value) => value.toLowerCase());
const utcTimestampSchema = z.iso
  .datetime({ offset: false })
  .refine((value) => value.endsWith("Z"), "UTC timestamp is required");
const nonNegativeVersionSchema = z.number().int().nonnegative().safe();
const positiveDurationSchema = z.number().int().positive().safe();
const snapshotNameSchema = z.string().trim().min(1);

function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const visitIdentityV1Schema = z
  .strictObject({
    serviceId: canonicalUuidSchema,
    masterId: canonicalUuidSchema,
    startsAt: utcTimestampSchema,
    endsAt: utcTimestampSchema,
    durationMinutes: positiveDurationSchema,
  })
  .superRefine((visit, context) => {
    if (Date.parse(visit.endsAt) <= Date.parse(visit.startsAt)) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be later than startsAt",
      });
    }
  });

export const visitSnapshotV1Schema = z
  .strictObject({
    serviceId: canonicalUuidSchema,
    masterId: canonicalUuidSchema,
    startsAt: utcTimestampSchema,
    endsAt: utcTimestampSchema,
    durationMinutes: positiveDurationSchema,
    businessTimeZone: z.string().trim().min(1).refine(isSupportedTimeZone),
    serviceName: snapshotNameSchema,
    masterName: snapshotNameSchema,
  })
  .superRefine((visit, context) => {
    if (Date.parse(visit.endsAt) <= Date.parse(visit.startsAt)) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be later than startsAt",
      });
    }
  });

export type VisitIdentityV1 = z.infer<typeof visitIdentityV1Schema>;
export type VisitSnapshotV1 = z.infer<typeof visitSnapshotV1Schema>;

export const TELEGRAM_CHANGED_FIELDS = ["SERVICE", "MASTER", "STARTS_AT"] as const;
export type TelegramChangedField = (typeof TELEGRAM_CHANGED_FIELDS)[number];

const changedFieldsSchema = z
  .array(z.enum(TELEGRAM_CHANGED_FIELDS))
  .min(1)
  .max(TELEGRAM_CHANGED_FIELDS.length)
  .superRefine((fields, context) => {
    if (new Set(fields).size !== fields.length) {
      context.addIssue({ code: "custom", message: "changedFields must not contain duplicates" });
    }

    const canonical = TELEGRAM_CHANGED_FIELDS.filter((field) => fields.includes(field));
    if (canonical.some((field, index) => field !== fields[index])) {
      context.addIssue({ code: "custom", message: "changedFields must use canonical order" });
    }
  });

export const adminAppointmentCreatedPayloadV1Schema = z.strictObject({
  source: z.enum(["PUBLIC", "ADMIN"]),
  appointmentVersion: nonNegativeVersionSchema,
  occurredAt: utcTimestampSchema,
  visit: visitSnapshotV1Schema,
});

export const adminAppointmentCancelledPayloadV1Schema = z.strictObject({
  actor: z.enum(["CLIENT", "ADMIN"]),
  appointmentVersion: nonNegativeVersionSchema,
  occurredAt: utcTimestampSchema,
  visit: visitSnapshotV1Schema,
});

export const clientAppointmentCancelledPayloadV1Schema = z.strictObject({
  actor: z.literal("ADMIN"),
  appointmentVersion: nonNegativeVersionSchema,
  occurredAt: utcTimestampSchema,
  visit: visitSnapshotV1Schema,
});

function actualChangedFields(before: VisitSnapshotV1, after: VisitSnapshotV1) {
  const changed = new Set<TelegramChangedField>();

  if (
    before.serviceId !== after.serviceId ||
    before.serviceName !== after.serviceName ||
    before.durationMinutes !== after.durationMinutes
  ) {
    changed.add("SERVICE");
  }
  if (before.masterId !== after.masterId || before.masterName !== after.masterName) {
    changed.add("MASTER");
  }
  if (before.startsAt !== after.startsAt) {
    changed.add("STARTS_AT");
  }

  return TELEGRAM_CHANGED_FIELDS.filter((field) => changed.has(field));
}

export const clientAppointmentChangedPayloadV1Schema = z
  .strictObject({
    appointmentVersion: nonNegativeVersionSchema,
    occurredAt: utcTimestampSchema,
    changedFields: changedFieldsSchema,
    before: visitSnapshotV1Schema,
    after: visitSnapshotV1Schema,
  })
  .superRefine((payload, context) => {
    const expected = actualChangedFields(payload.before, payload.after);
    if (
      expected.length !== payload.changedFields.length ||
      expected.some((field, index) => field !== payload.changedFields[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["changedFields"],
        message: "changedFields do not match before/after",
      });
    }

    const endsAtChanged = payload.before.endsAt !== payload.after.endsAt;
    if (
      endsAtChanged &&
      !payload.changedFields.includes("SERVICE") &&
      !payload.changedFields.includes("STARTS_AT")
    ) {
      context.addIssue({
        code: "custom",
        path: ["changedFields"],
        message: "endsAt change requires SERVICE or STARTS_AT",
      });
    }

    if (payload.before.businessTimeZone !== payload.after.businessTimeZone) {
      context.addIssue({
        code: "custom",
        path: ["after", "businessTimeZone"],
        message: "businessTimeZone is not a supported appointment change",
      });
    }
  });

export const clientAppointmentReminderPayloadV1Schema = z.strictObject({
  visitVersion: nonNegativeVersionSchema,
  expectedVisit: visitIdentityV1Schema,
});

const emptyPayloadSchema = z.strictObject({});

export const telegramPayloadV1Schemas = {
  ADMIN_APPOINTMENT_CREATED: adminAppointmentCreatedPayloadV1Schema,
  ADMIN_APPOINTMENT_CANCELLED: adminAppointmentCancelledPayloadV1Schema,
  CLIENT_APPOINTMENT_CANCELLED: clientAppointmentCancelledPayloadV1Schema,
  CLIENT_APPOINTMENT_CHANGED: clientAppointmentChangedPayloadV1Schema,
  CLIENT_APPOINTMENT_REMINDER: clientAppointmentReminderPayloadV1Schema,
  CLIENT_CONNECTION_CONFIRMED: emptyPayloadSchema,
  ADMIN_CONNECTION_CONFIRMED: emptyPayloadSchema,
  TELEGRAM_CONNECTION_REJECTED: emptyPayloadSchema,
} as const;

export type TelegramPayloadV1ByType = {
  [Type in TelegramNotificationType]: z.infer<(typeof telegramPayloadV1Schemas)[Type]>;
};

export type TelegramPayloadParseErrorCode =
  "PAYLOAD_INVALID" | "PAYLOAD_TOO_LARGE" | "PAYLOAD_VERSION_UNSUPPORTED";

export type TelegramPayloadParseResult<
  Type extends TelegramNotificationType = TelegramNotificationType,
> =
  | {
      ok: true;
      notificationType: Type;
      payloadVersion: 1;
      payload: TelegramPayloadV1ByType[Type];
      serialized: string;
    }
  | { ok: false; code: TelegramPayloadParseErrorCode };

function serializedSize(input: unknown): { serialized: string; bytes: number } | null {
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) {
      return null;
    }
    return { serialized, bytes: Buffer.byteLength(serialized, "utf8") };
  } catch {
    return null;
  }
}

export function parseTelegramPayloadV1<Type extends TelegramNotificationType>(input: {
  notificationType: Type;
  payloadVersion: unknown;
  payload: unknown;
}): TelegramPayloadParseResult<Type> {
  if (input.payloadVersion !== TELEGRAM_POLICY.payloadVersion) {
    return { ok: false, code: "PAYLOAD_VERSION_UNSUPPORTED" };
  }

  if (!TELEGRAM_NOTIFICATION_TYPES.includes(input.notificationType)) {
    return { ok: false, code: "PAYLOAD_INVALID" };
  }

  const raw = serializedSize(input.payload);
  if (raw === null) {
    return { ok: false, code: "PAYLOAD_INVALID" };
  }
  if (raw.bytes > TELEGRAM_POLICY.maxSerializedPayloadBytes) {
    return { ok: false, code: "PAYLOAD_TOO_LARGE" };
  }

  const schema = telegramPayloadV1Schemas[input.notificationType];
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) {
    return { ok: false, code: "PAYLOAD_INVALID" };
  }

  const normalized = serializedSize(parsed.data);
  if (normalized === null) {
    return { ok: false, code: "PAYLOAD_INVALID" };
  }
  if (normalized.bytes > TELEGRAM_POLICY.maxSerializedPayloadBytes) {
    return { ok: false, code: "PAYLOAD_TOO_LARGE" };
  }

  return {
    ok: true,
    notificationType: input.notificationType,
    payloadVersion: TELEGRAM_POLICY.payloadVersion,
    payload: parsed.data as TelegramPayloadV1ByType[Type],
    serialized: normalized.serialized,
  };
}
