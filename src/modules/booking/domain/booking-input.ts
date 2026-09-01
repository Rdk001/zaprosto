import { z } from "zod";

import { normalizeRussianPhone } from "./phone";

export const bookingUuidSchema = z.uuid().transform((value) => value.toLowerCase());

// Canonical, unpadded base64url encoding of 32 random bytes (256 bits).
export const bookingTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

export const russianPhoneSchema = z
  .string()
  .max(64)
  .transform((value, context) => {
    try {
      return normalizeRussianPhone(value);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      context.issues.push({
        code: "custom",
        input: value,
        message: "Укажите российский номер с префиксом +7 или 8 и 11 цифрами",
      });
      return z.NEVER;
    }
  });

export const bookingHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const bookingMasterSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("SPECIFIC"), masterId: bookingUuidSchema }),
  z.strictObject({ type: z.literal("ANY") }),
]);

export const bookingStartsAtSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
]);

export const bookingClientNameSchema = z.string().trim().min(1).max(200);

export const createBookingSchema = z.strictObject({
  idempotencyKey: bookingUuidSchema,
  cancellationToken: bookingTokenSchema,
  serviceId: bookingUuidSchema,
  // Optional only for replay of pre-terms attempts; new bookings require a match in the transaction.
  expectedServiceTerms: bookingHashSchema.optional(),
  expectedBusinessContext: bookingHashSchema.optional(),
  master: bookingMasterSchema,
  localDate: z.iso.date(),
  startsAt: bookingStartsAtSchema,
  clientName: bookingClientNameSchema,
  clientPhone: russianPhoneSchema,
});

export const cancelBookingSchema = z.strictObject({
  token: bookingTokenSchema,
  confirmed: z.literal(true),
  reason: z.string().trim().max(1000).optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type InputIssue = { field: string; message: string };

// Do not return submitted values, Zod internals or secrets to callers/loggers.
export function inputIssues(error: z.ZodError): InputIssue[] {
  return error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
}
