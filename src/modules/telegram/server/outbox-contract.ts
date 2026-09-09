import { z } from "zod";

import { TELEGRAM_NOTIFICATION_TYPES, type TelegramNotificationType } from "../domain/payload-v1";

export const OUTBOX_INVALIDATION_CODES = [
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_COMPLETED",
  "APPOINTMENT_NO_SHOW",
  "VISIT_CHANGED",
  "CONNECTION_DISABLED",
  "ADMIN_USER_DEACTIVATED",
  "BOT_REPLACED",
] as const;
export const OUTBOX_SKIP_CODES = [
  "REMINDER_EXPIRED",
  "CONNECTION_INACTIVE",
  "APPOINTMENT_NOT_SCHEDULED",
  "VISIT_MISMATCH",
] as const;
export const OUTBOX_RETRY_CODES = [
  "NETWORK_UNREACHABLE",
  "DELIVERY_OUTCOME_UNKNOWN",
  "TELEGRAM_RATE_LIMIT",
  "TELEGRAM_5XX",
  "RESPONSE_INVALID",
  "RESPONSE_TOO_LARGE",
] as const;
export const OUTBOX_DEAD_CODES = [
  "INVALID_REQUEST",
  "CHAT_NOT_FOUND",
  "BOT_BLOCKED",
  "CHAT_WRITE_FORBIDDEN",
  "TELEGRAM_USER_DEACTIVATED",
  "PAYLOAD_VERSION_UNSUPPORTED",
  "RESPONSE_INVALID",
] as const;

export type OutboxInvalidationCode = (typeof OUTBOX_INVALIDATION_CODES)[number];
export type OutboxSkipCode = (typeof OUTBOX_SKIP_CODES)[number];
export type OutboxTerminalStatus = "SENT" | "DEAD" | "CANCELLED" | "SKIPPED";
export type OutboxTransitionResult =
  | { kind: "APPLIED"; status: "PENDING" | OutboxTerminalStatus }
  | { kind: "LEASE_LOST" }
  | { kind: "TERMINAL"; status: OutboxTerminalStatus }
  | { kind: "TRANSITION_NOT_ALLOWED" };

export type OutboxPayloadCheck =
  | { ok: true; payloadVersion: 1 }
  | { ok: false; code: "PAYLOAD_VERSION_UNSUPPORTED" | "RESPONSE_INVALID" };

// Lifecycle DTO only. Payload, recipient identities and dedupe keys never leave this repository.
export type ClaimedOutboxJob = {
  id: string;
  type: TelegramNotificationType;
  attempts: number;
  leaseToken: string;
  leaseOwner: string;
  claimedAt: Date;
  leaseExpiresAt: Date;
  expiresAt: Date | null;
  invalidated: boolean;
  payloadCheck: OutboxPayloadCheck;
};

export type RecoveredOutboxJob = {
  id: string;
  status: "PENDING" | "DEAD" | "SKIPPED";
};

export const outboxUuidSchema = z.uuid().transform((value) => value.toLowerCase());
// Caller-generated opaque process identity, never hostname/path/operator-supplied text.
export const outboxOwnerSchema = z.string().trim().max(100).pipe(outboxUuidSchema);
export const outboxTimestampSchema = z
  .date()
  .refine((value) => value.getTime() >= 0 && value.getUTCFullYear() <= 9999);
export const claimOutboxSchema = z.strictObject({
  capacity: z.number().int().nonnegative().safe(),
  leaseOwner: outboxOwnerSchema,
});
export const recoverOutboxSchema = z.strictObject({
  batchSize: z.number().int().positive().safe(),
});

const lease = { id: outboxUuidSchema, leaseToken: outboxUuidSchema };
export const finishOutboxSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ ...lease, outcome: z.literal("SENT") }),
  z.strictObject({
    ...lease,
    outcome: z.literal("RETRY"),
    errorCode: z.enum(OUTBOX_RETRY_CODES),
    retryAfterSeconds: z.number().int().positive().safe().optional(),
  }),
  z.strictObject({ ...lease, outcome: z.literal("DEAD"), errorCode: z.enum(OUTBOX_DEAD_CODES) }),
  z.strictObject({ ...lease, outcome: z.literal("SKIPPED"), errorCode: z.enum(OUTBOX_SKIP_CODES) }),
  z.strictObject({
    ...lease,
    outcome: z.literal("CONFIGURATION_FAILURE"),
    errorCode: z.literal("CONFIG_UNAUTHORIZED"),
  }),
]);

// No arbitrary SQL or broad unscoped target. Business producers choose the exact types.
const targetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("APPOINTMENT"),
    id: outboxUuidSchema,
    types: z.array(z.enum(TELEGRAM_NOTIFICATION_TYPES)).min(1).max(8),
  }),
  z.strictObject({ kind: z.literal("APPOINTMENT_CONNECTION"), id: outboxUuidSchema }),
  z.strictObject({ kind: z.literal("ADMIN_CONNECTION"), id: outboxUuidSchema }),
]);
export const invalidateOutboxSchema = z.strictObject({
  target: targetSchema,
  code: z.enum(OUTBOX_INVALIDATION_CODES),
  now: outboxTimestampSchema,
});

export type ClaimOutboxInput = z.input<typeof claimOutboxSchema>;
export type FinishOutboxInput = z.input<typeof finishOutboxSchema>;
export type InvalidateOutboxInput = z.input<typeof invalidateOutboxSchema>;

export class TelegramOutboxError extends Error {
  constructor(
    readonly code: "OUTBOX_INPUT_INVALID" | "OUTBOX_STORAGE_FAILURE" | "OUTBOX_DATA_INVALID",
  ) {
    super(code);
    this.name = "TelegramOutboxError";
  }

  toJSON() {
    return { name: this.name, code: this.code };
  }
}

export function checkedOutboxInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TelegramOutboxError("OUTBOX_INPUT_INVALID");
  return parsed.data;
}
