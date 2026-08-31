import { z } from "zod";
import { parseLocalDate } from "../time/business-time";
import { normalizeIntervals } from "./intervals";

// At most 224 short intervals per weekly request, comfortably below the 16 KiB Action limit.
export const MAX_DAY_INTERVALS = 16;
export const WEEKDAYS = [
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
  "Воскресенье",
];
const version = z.number().int().min(0).max(2_147_483_647);
export const localDateSchema = z
  .string()
  .length(10, "Укажите дату в формате ГГГГ-ММ-ДД")
  .refine((value) => {
    try {
      return parseLocalDate(value) === value && value >= "0001-01-01";
    } catch {
      return false;
    }
  }, "Укажите существующую дату в формате ГГГГ-ММ-ДД");
export const monthSchema = z
  .string()
  .length(7, "Укажите месяц в формате ГГГГ-ММ")
  .refine((value) => localDateSchema.safeParse(`${value}-01`).success, "Укажите корректный месяц");
const time = z
  .string()
  .length(5, "Введите время в формате HH:mm")
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Введите время HH:mm от 00:00 до 23:59");
export const intervalSchema = z
  .strictObject({ start: time, end: time })
  .refine(({ start, end }) => start < end, {
    message: "Начало должно быть раньше конца в пределах одних суток",
    path: ["end"],
  });
const intervals = z
  .array(intervalSchema)
  .max(MAX_DAY_INTERVALS, "Не более 16 интервалов одного типа на день");
export const weekSchema = z
  .array(
    z.strictObject({
      dayOfWeek: z.number().int().min(1).max(7),
      work: intervals,
      breaks: intervals,
    }),
  )
  .length(7, "Укажите все семь дней недели")
  .refine(
    (days) => new Set(days.map((d) => d.dayOfWeek)).size === 7,
    "Укажите каждый день недели один раз",
  );
const target = { masterId: z.uuid(), version };
export const saveWeekSchema = z.strictObject({ ...target, days: weekSchema });
export const saveExceptionSchema = z
  .strictObject({
    ...target,
    id: z.uuid().nullable(),
    localDate: localDateSchema,
    type: z.enum(["DAY_OFF", "CUSTOM_HOURS"]),
    intervals,
  })
  .superRefine((input, ctx) => {
    if (input.type === "DAY_OFF" && input.intervals.length !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["intervals"],
        message: "У выходного не должно быть особых часов",
      });
    if (input.type === "CUSTOM_HOURS" && input.intervals.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["intervals"],
        message: "Добавьте рабочий интервал или выберите выходной",
      });
  });
export const deleteExceptionSchema = z.strictObject({
  ...target,
  id: z.uuid(),
  confirmed: z.literal(true, { error: "Подтвердите возврат к недельному графику" }),
});
export const scheduleQuerySchema = z.strictObject({
  masterId: z.uuid().optional(),
  month: monthSchema.optional(),
  after: z.uuid().optional(),
});
export type ScheduleInterval = z.infer<typeof intervalSchema>;
export type ScheduleWeek = z.infer<typeof weekSchema>;
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;
export type ScheduleFailure = {
  ok: false;
  code:
    | "INVALID_INPUT"
    | "INVALID_TIME"
    | "NOT_FOUND"
    | "CONFLICT"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "UNAVAILABLE"
    | "LIMIT_EXCEEDED";
  fields?: Record<string, string>;
};
export function scheduleIssues(error: z.ZodError): ScheduleFailure {
  const fields: Record<string, string> = {};
  for (const issue of error.issues.slice(0, 30))
    fields[issue.path.join(".") || "form"] ??=
      issue.code === "unrecognized_keys"
        ? "Переданы недопустимые поля"
        : /^(Invalid|Too)/.test(issue.message)
          ? "Проверьте формат и допустимый размер значения"
          : issue.message;
  return { ok: false, code: "INVALID_INPUT", fields };
}
export function databaseTime(time: string) {
  return new Date(`1970-01-01T${time}:00.000Z`);
}
export function databaseInterval(interval: ScheduleInterval) {
  return { startsAt: databaseTime(interval.start), endsAt: databaseTime(interval.end) };
}
export function displayInterval(interval: { startsAt: Date; endsAt: Date }): ScheduleInterval {
  // Do not silently truncate legacy seconds or PostgreSQL's 24:00 boundary.
  for (const value of [interval.startsAt, interval.endsAt])
    if (
      value.getUTCSeconds() ||
      value.getUTCMilliseconds() ||
      value.toISOString().slice(0, 10) !== "1970-01-01"
    )
      throw new Error("Unsupported stored schedule precision");
  return {
    start: interval.startsAt.toISOString().slice(11, 16),
    end: interval.endsAt.toISOString().slice(11, 16),
  };
}
export function normalizeScheduleIntervals(values: ScheduleInterval[]) {
  return normalizeIntervals(values.map(databaseInterval)).map(displayInterval);
}
