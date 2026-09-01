import { z } from "zod";
import { parseLocalDate } from "../../scheduling/time/business-time";

export const statusLabels = {
  SCHEDULED: "Запланирована",
  COMPLETED: "Выполнена",
  NO_SHOW: "Клиент не пришёл",
  CANCELLED: "Отменена",
} as const;
export type Status = keyof typeof statusLabels;
export const actorLabels = { ADMIN: "Администратор", CLIENT: "Клиент", SYSTEM: "Система" } as const;
export const sourceLabels = { ONLINE: "Онлайн-запись", ADMIN: "Администратор" } as const;
export const statusSchema = z.enum(["SCHEDULED", "COMPLETED", "NO_SHOW", "CANCELLED"]);
export const appointmentIdSchema = z.uuid().transform((v) => v.toLowerCase());
export const PAGE_SIZE = 25;
export const MAX_REASON = 1000;
const page = z
  .string()
  .regex(/^[1-9]\d{0,6}$/)
  .transform(Number)
  .default(1);
const date = z.string().refine((v) => {
  try {
    return parseLocalDate(v) === v;
  } catch {
    return false;
  }
}, "Укажите существующую дату ГГГГ-ММ-ДД");
export const journalQuerySchema = z.strictObject({
  date: date.optional(),
  masterId: z.union([appointmentIdSchema, z.literal("")]).optional(),
  status: z
    .enum(["ACTIVE", "ALL", "SCHEDULED", "COMPLETED", "NO_SHOW", "CANCELLED"])
    .default("ACTIVE"),
  page,
  mastersAfter: appointmentIdSchema.optional(),
});
export const detailQuerySchema = journalQuerySchema.extend({ historyPage: page });
export type JournalQuery = z.infer<typeof journalQuerySchema>;
export type DetailQuery = z.infer<typeof detailQuerySchema>;
export const changeStatusSchema = z.strictObject({
  id: appointmentIdSchema,
  version: z.number().int().min(0).max(2147483647),
  expectedBusinessContext: z.string().regex(/^[a-f0-9]{64}$/),
  status: statusSchema,
  confirmed: z.boolean(),
  reason: z
    .string()
    .max(MAX_REASON)
    .transform((v) => v.trim())
    .optional(),
});
export type AppointmentFailure = {
  ok: false;
  code:
    | "INVALID_INPUT"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "UNAVAILABLE"
    | "NOT_FOUND"
    | "CONFLICT"
    | "INVALID_TRANSITION"
    | "NOT_STARTED"
    | "CONFIRMATION_REQUIRED"
    | "INVALID_DAY";
};
export function allowedTransition(previous: Status, next: Status) {
  return previous === "SCHEDULED"
    ? next === "CANCELLED" || next === "COMPLETED" || next === "NO_SHOW"
    : previous === "COMPLETED"
      ? next === "NO_SHOW"
      : previous === "NO_SHOW" && next === "COMPLETED";
}
export function journalHref(query: Partial<JournalQuery>, id?: string, historyPage?: number) {
  const params = new URLSearchParams();
  for (const key of ["date", "masterId", "status", "page", "mastersAfter"] as const) {
    const value = query[key];
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  if (historyPage !== undefined) params.set("historyPage", String(historyPage));
  return "/admin/appointments" + (id ? "/" + id : "") + (params.size ? "?" + params : "");
}

/** Result statuses are permitted from the exact start instant; cancellation has no deadline. */
export function statusTimeAllowed(status: Status, startsAt: Date, now: Date) {
  return status === "CANCELLED" || (Number.isFinite(now.getTime()) && now >= startsAt);
}
