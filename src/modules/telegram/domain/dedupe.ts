import { z } from "zod";

import { TelegramDomainError } from "./safe-error";

export const TELEGRAM_DEDUPE_KEY_MAX_LENGTH = 255;

const canonicalUuidSchema = z.uuid().transform((value) => value.toLowerCase());
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

function canonicalUuid(value: unknown): string {
  const parsed = canonicalUuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new TelegramDomainError("INVALID_DEDUPE_INPUT");
  }
  return parsed.data;
}

function nonNegativeSafeInteger(value: unknown): number {
  const parsed = nonNegativeSafeIntegerSchema.safeParse(value);
  if (!parsed.success) {
    throw new TelegramDomainError("INVALID_DEDUPE_INPUT");
  }
  return parsed.data;
}

function checkedKey(value: string): string {
  if (value.length > TELEGRAM_DEDUPE_KEY_MAX_LENGTH) {
    throw new TelegramDomainError("INVALID_DEDUPE_INPUT");
  }
  return value;
}

export function buildAdminAppointmentCreatedDedupeKey(input: {
  appointmentId: string;
  version: number;
  adminConnectionId: string;
}): string {
  return checkedKey(
    `admin-appointment-created:v1:${canonicalUuid(input.appointmentId)}:v${nonNegativeSafeInteger(input.version)}:c${canonicalUuid(input.adminConnectionId)}`,
  );
}

export function buildClientConnectionConfirmedDedupeKey(input: {
  appointmentId: string;
  appointmentConnectionId: string;
}): string {
  return checkedKey(
    `client-connection-confirmed:v1:${canonicalUuid(input.appointmentId)}:c${canonicalUuid(input.appointmentConnectionId)}`,
  );
}

export function buildAdminConnectionConfirmedDedupeKey(input: {
  adminUserId: string;
  adminConnectionId: string;
}): string {
  return checkedKey(
    `admin-connection-confirmed:v1:${canonicalUuid(input.adminUserId)}:c${canonicalUuid(input.adminConnectionId)}`,
  );
}

export function buildAdminAppointmentCancelledDedupeKey(input: {
  appointmentId: string;
  version: number;
  adminConnectionId: string;
}): string {
  return checkedKey(
    `admin-appointment-cancelled:v1:${canonicalUuid(input.appointmentId)}:v${nonNegativeSafeInteger(input.version)}:c${canonicalUuid(input.adminConnectionId)}`,
  );
}

export function buildClientAppointmentCancelledDedupeKey(input: {
  appointmentId: string;
  version: number;
  appointmentConnectionId: string;
}): string {
  return checkedKey(
    `client-appointment-cancelled:v1:${canonicalUuid(input.appointmentId)}:v${nonNegativeSafeInteger(input.version)}:c${canonicalUuid(input.appointmentConnectionId)}`,
  );
}

export function buildClientAppointmentChangedDedupeKey(input: {
  appointmentId: string;
  version: number;
  appointmentConnectionId: string;
}): string {
  return checkedKey(
    `client-appointment-changed:v1:${canonicalUuid(input.appointmentId)}:v${nonNegativeSafeInteger(input.version)}:c${canonicalUuid(input.appointmentConnectionId)}`,
  );
}

export function buildClientAppointmentReminderDedupeKey(input: {
  appointmentId: string;
  visitVersion: number;
  reminderEpochMillis: number;
  appointmentConnectionId: string;
}): string {
  return checkedKey(
    `client-appointment-reminder:v1:${canonicalUuid(input.appointmentId)}:v${nonNegativeSafeInteger(input.visitVersion)}:at${nonNegativeSafeInteger(input.reminderEpochMillis)}:c${canonicalUuid(input.appointmentConnectionId)}`,
  );
}

export function buildTelegramConnectionRejectedDedupeKey(input: { updateId: number }): string {
  return checkedKey(`telegram-connection-rejected:v1:u${nonNegativeSafeInteger(input.updateId)}`);
}
