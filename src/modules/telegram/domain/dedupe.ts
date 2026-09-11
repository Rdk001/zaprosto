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

function nonNegativeInteger(value: unknown): string {
  if (typeof value === "bigint") {
    if (value < 0n) throw new TelegramDomainError("INVALID_DEDUPE_INPUT");
    return value.toString();
  }
  return String(nonNegativeSafeInteger(value));
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
  appointmentConnectionId: string;
}): string {
  return checkedKey(
    `telegram:v1:appointment-connection:${canonicalUuid(input.appointmentConnectionId)}:confirmed`,
  );
}

export function buildAdminConnectionConfirmedDedupeKey(input: {
  adminConnectionId: string;
}): string {
  return checkedKey(
    `telegram:v1:admin-connection:${canonicalUuid(input.adminConnectionId)}:confirmed`,
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
  appointmentConnectionId: string;
}): string {
  return checkedKey(
    `telegram:v1:appointment:${canonicalUuid(input.appointmentId)}:version:${nonNegativeSafeInteger(input.visitVersion)}:connection:${canonicalUuid(input.appointmentConnectionId)}:reminder`,
  );
}

export function buildTelegramConnectionRejectedDedupeKey(input: {
  updateId: number | bigint;
}): string {
  return checkedKey(`telegram:v1:update:${nonNegativeInteger(input.updateId)}:connection-rejected`);
}
