import { z } from "zod";
import { assertValidTimeZone } from "../../scheduling/time/business-time";

export const settingsVersionSchema = z.number().int().min(0).max(2_147_483_647);
export const settingsSchema = z.strictObject({
  version: settingsVersionSchema,
  bookingHorizonDays: z
    .string()
    .max(2)
    .regex(/^(?:[7-9]|[1-8]\d|90)$/, "Укажите целое число от 7 до 90")
    .transform(Number),
  timezone: z
    .string()
    .max(100)
    .refine((value) => {
      try {
        assertValidTimeZone(value);
        return !/^[+\-]/.test(value);
      } catch {
        return false;
      }
    }, "Укажите именованный часовой пояс IANA, например Europe/Moscow"),
  confirmedTimezoneChange: z.boolean(),
});
export type SettingsFailure = {
  ok: false;
  code:
    | "INVALID_INPUT"
    | "CONFLICT"
    | "CONFIRMATION_REQUIRED"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "UNAVAILABLE";
  fields?: Record<string, string>;
};
