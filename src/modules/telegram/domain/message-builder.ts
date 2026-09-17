import { z } from "zod";

import {
  TELEGRAM_NOTIFICATION_TYPES,
  parseTelegramPayloadV1,
  type TelegramNotificationType,
  type TelegramPayloadParseErrorCode,
  type TelegramPayloadV1ByType,
  type VisitSnapshotV1,
} from "./payload-v1";
import { normalizeTelegramPlainText } from "./plain-text";

export const TELEGRAM_MESSAGE_MAX_CODE_POINTS = 2_000;

const UTC_TIMESTAMP_SCHEMA = z.iso
  .datetime({ offset: false })
  .refine((value) => value.endsWith("Z"));

const resolvedVisitSchema = z.strictObject({
  status: z.enum(["SCHEDULED", "CANCELLED", "COMPLETED", "NO_SHOW"]),
  startsAt: UTC_TIMESTAMP_SCHEMA,
  businessTimeZone: z.string().trim().min(1),
  serviceName: z.string().trim().min(1),
  masterName: z.string().trim().min(1),
});

const scheduledResolvedVisitSchema = resolvedVisitSchema.extend({
  status: z.literal("SCHEDULED"),
});

const activeAdminContextSchema = z.strictObject({
  adminStatus: z.literal("ACTIVE"),
});

export type TelegramResolvedVisit = z.input<typeof resolvedVisitSchema>;
export type TelegramScheduledResolvedVisit = z.input<typeof scheduledResolvedVisitSchema>;
export type TelegramActiveAdminContext = z.input<typeof activeAdminContextSchema>;

type SnapshotMessageInput<Type extends TelegramNotificationType> = Readonly<{
  notificationType: Type;
  payloadVersion: unknown;
  payload: unknown;
}>;

export type TelegramMessageBuilderInput =
  | SnapshotMessageInput<"ADMIN_APPOINTMENT_CREATED">
  | SnapshotMessageInput<"ADMIN_APPOINTMENT_CANCELLED">
  | SnapshotMessageInput<"CLIENT_APPOINTMENT_CANCELLED">
  | SnapshotMessageInput<"CLIENT_APPOINTMENT_CHANGED">
  | Readonly<{
      notificationType: "CLIENT_APPOINTMENT_REMINDER";
      payloadVersion: unknown;
      payload: unknown;
      resolvedContext: TelegramScheduledResolvedVisit;
    }>
  | Readonly<{
      notificationType: "CLIENT_CONNECTION_CONFIRMED";
      payloadVersion: unknown;
      payload: unknown;
      resolvedContext: TelegramResolvedVisit;
    }>
  | Readonly<{
      notificationType: "ADMIN_CONNECTION_CONFIRMED";
      payloadVersion: unknown;
      payload: unknown;
      resolvedContext: TelegramActiveAdminContext;
    }>
  | SnapshotMessageInput<"TELEGRAM_CONNECTION_REJECTED">;

export type TelegramMessageBuildErrorCode =
  | TelegramPayloadParseErrorCode
  | "NOTIFICATION_TYPE_UNSUPPORTED"
  | "RESOLVED_CONTEXT_INVALID"
  | "TIME_ZONE_INVALID"
  | "CONTENT_INVALID"
  | "MESSAGE_TOO_LONG";

export class TelegramMessageBuildError extends Error {
  readonly code: TelegramMessageBuildErrorCode;

  constructor(code: TelegramMessageBuildErrorCode) {
    super(code);
    this.name = "TelegramMessageBuildError";
    this.code = code;
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export type TelegramBuiltMessage = Readonly<{ text: string }>;

function buildError(code: TelegramMessageBuildErrorCode): TelegramMessageBuildError {
  return new TelegramMessageBuildError(code);
}

function isNotificationType(value: unknown): value is TelegramNotificationType {
  return (
    typeof value === "string" && (TELEGRAM_NOTIFICATION_TYPES as readonly string[]).includes(value)
  );
}

function parsePayload<Type extends TelegramNotificationType>(
  notificationType: Type,
  payloadVersion: unknown,
  payload: unknown,
): TelegramPayloadV1ByType[Type] {
  const parsed = parseTelegramPayloadV1({ notificationType, payloadVersion, payload });
  if (!parsed.ok) {
    throw buildError(parsed.code);
  }
  return parsed.payload;
}

function parseContext<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw buildError("RESOLVED_CONTEXT_INVALID");
  }
  return parsed.data;
}

function safeContent(value: string): string {
  const normalized = normalizeTelegramPlainText(value).trim();
  if (!normalized || !normalized.isWellFormed()) {
    throw buildError("CONTENT_INVALID");
  }
  return normalized;
}

function formatVisitDateTime(startsAt: string, businessTimeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("ru-RU", {
      timeZone: businessTimeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(startsAt));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value;
    const day = part("day");
    const month = part("month");
    const year = part("year");
    const hour = part("hour");
    const minute = part("minute");
    if (!day || !month || !year || !hour || !minute) {
      throw buildError("CONTENT_INVALID");
    }
    return { date: `${day}.${month}.${year}`, time: `${hour}:${minute}` };
  } catch (error) {
    if (error instanceof TelegramMessageBuildError) {
      throw error;
    }
    throw buildError("TIME_ZONE_INVALID");
  }
}

type DisplayVisit = Pick<
  VisitSnapshotV1,
  "startsAt" | "businessTimeZone" | "serviceName" | "masterName"
>;

function visitLines(visit: DisplayVisit): string[] {
  const { date, time } = formatVisitDateTime(visit.startsAt, visit.businessTimeZone);
  return [
    `Услуга: ${safeContent(visit.serviceName)}`,
    `Мастер: ${safeContent(visit.masterName)}`,
    `Дата: ${date}`,
    `Время: ${time}`,
  ];
}

function changedVisitLines(
  visit: VisitSnapshotV1,
  changedFields: readonly ("SERVICE" | "MASTER" | "STARTS_AT")[],
): string[] {
  const dateTime = formatVisitDateTime(visit.startsAt, visit.businessTimeZone);
  const lines: string[] = [];
  if (changedFields.includes("SERVICE")) {
    lines.push(`Услуга: ${safeContent(visit.serviceName)}`);
  }
  if (changedFields.includes("MASTER")) {
    lines.push(`Мастер: ${safeContent(visit.masterName)}`);
  }
  if (changedFields.includes("STARTS_AT")) {
    lines.push(`Дата и время: ${dateTime.date}, ${dateTime.time}`);
  }
  return lines;
}

function finalize(lines: readonly string[]): TelegramBuiltMessage {
  const text = normalizeTelegramPlainText(lines.join("\n"));
  if (!text || !text.isWellFormed()) {
    throw buildError("CONTENT_INVALID");
  }
  if (Array.from(text).length > TELEGRAM_MESSAGE_MAX_CODE_POINTS) {
    throw buildError("MESSAGE_TOO_LONG");
  }
  return { text };
}

export function buildTelegramMessage(input: TelegramMessageBuilderInput): TelegramBuiltMessage {
  if (typeof input !== "object" || input === null) {
    throw buildError("NOTIFICATION_TYPE_UNSUPPORTED");
  }

  const candidate = input as TelegramMessageBuilderInput & Record<string, unknown>;
  if (!isNotificationType(candidate.notificationType)) {
    throw buildError("NOTIFICATION_TYPE_UNSUPPORTED");
  }

  switch (candidate.notificationType) {
    case "ADMIN_APPOINTMENT_CREATED": {
      const payload = parsePayload(
        candidate.notificationType,
        candidate.payloadVersion,
        candidate.payload,
      );
      const source =
        payload.source === "PUBLIC" ? "онлайн-запись клиента" : "создана администратором";
      return finalize(["Новая запись.", `Источник: ${source}`, ...visitLines(payload.visit)]);
    }
    case "ADMIN_APPOINTMENT_CANCELLED": {
      const payload = parsePayload(
        candidate.notificationType,
        candidate.payloadVersion,
        candidate.payload,
      );
      const actor = payload.actor === "CLIENT" ? "клиентом" : "администратором";
      return finalize([`Запись отменена ${actor}.`, ...visitLines(payload.visit)]);
    }
    case "CLIENT_APPOINTMENT_CANCELLED": {
      const payload = parsePayload(
        candidate.notificationType,
        candidate.payloadVersion,
        candidate.payload,
      );
      return finalize(["Ваша запись отменена администратором.", ...visitLines(payload.visit)]);
    }
    case "CLIENT_APPOINTMENT_CHANGED": {
      const payload = parsePayload(
        candidate.notificationType,
        candidate.payloadVersion,
        candidate.payload,
      );
      return finalize([
        "Ваша запись изменена.",
        "Было:",
        ...changedVisitLines(payload.before, payload.changedFields),
        "Стало:",
        ...changedVisitLines(payload.after, payload.changedFields),
      ]);
    }
    case "CLIENT_APPOINTMENT_REMINDER": {
      parsePayload(candidate.notificationType, candidate.payloadVersion, candidate.payload);
      const visit = parseContext(scheduledResolvedVisitSchema, candidate.resolvedContext);
      return finalize(["Напоминание о записи.", ...visitLines(visit)]);
    }
    case "CLIENT_CONNECTION_CONFIRMED": {
      parsePayload(candidate.notificationType, candidate.payloadVersion, candidate.payload);
      const visit = parseContext(resolvedVisitSchema, candidate.resolvedContext);
      const statusLine = {
        SCHEDULED: "Текущая запись подтверждена.",
        CANCELLED: "Текущая запись уже отменена.",
        COMPLETED: "Текущая запись уже завершена.",
        NO_SHOW: "Текущая запись завершена как несостоявшаяся.",
      }[visit.status];
      return finalize([
        "Подключение клиента к Telegram подтверждено.",
        statusLine,
        ...visitLines(visit),
      ]);
    }
    case "ADMIN_CONNECTION_CONFIRMED": {
      parsePayload(candidate.notificationType, candidate.payloadVersion, candidate.payload);
      parseContext(activeAdminContextSchema, candidate.resolvedContext);
      return finalize(["Подключение администратора к Telegram подтверждено."]);
    }
    case "TELEGRAM_CONNECTION_REJECTED": {
      parsePayload(candidate.notificationType, candidate.payloadVersion, candidate.payload);
      return finalize([
        "Не удалось подключить Telegram.",
        "Получите новую ссылку и повторите подключение.",
      ]);
    }
  }
}
