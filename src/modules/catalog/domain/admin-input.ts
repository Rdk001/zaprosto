import { z } from "zod";

const MAX_INT = 2_147_483_647;
export const rublesSchema = z
  .string()
  .max(12, "Слишком большая цена")
  .regex(/^\d{1,8}([.,]\d{1,2})?$/, "Укажите рубли и не более двух знаков копеек")
  .transform((text) => {
    const [rubles, kopecks = ""] = text.replace(",", ".").split(".");
    return Number(BigInt(rubles) * 100n + BigInt(kopecks.padEnd(2, "0")));
  })
  .pipe(
    z.number().int().min(1, "Цена должна быть больше нуля").max(MAX_INT, "Цена слишком велика"),
  );
export const minutesInputSchema = z
  .string()
  .max(10)
  .regex(/^\d+$/, "Укажите целое число минут")
  .transform(Number)
  .pipe(
    z
      .number()
      .int()
      .min(1, "Длительность должна быть больше нуля")
      .max(MAX_INT, "Длительность слишком велика"),
  );
const target = z.strictObject({ id: z.uuid(), version: z.number().int().min(0).max(MAX_INT) });
const common = {
  target: target.nullable(),
  name: z.string().trim().min(1, "Введите название или имя").max(160, "Не более 160 символов"),
  isActive: z.boolean(),
  confirmDeactivation: z.boolean(),
};
export const saveServiceSchema = z.strictObject({
  ...common,
  priceRubles: rublesSchema,
  durationMinutes: minutesInputSchema,
});
export const saveMasterSchema = z.strictObject({
  ...common,
  description: z.string().trim().max(2000, "Не более 2000 символов"),
  serviceIds: z
    .array(z.uuid())
    .max(100, "Не более 100 назначений за один запрос")
    .refine((ids) => new Set(ids).size === ids.length, "Услуги не должны повторяться"),
});
export const moveCatalogSchema = z.strictObject({
  kind: z.enum(["services", "masters"]),
  id: z.uuid(),
  direction: z.enum(["up", "down"]),
  orderVersion: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CatalogFailure = {
  ok: false;
  code:
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "CONFLICT"
    | "CONFIRM_REQUIRED"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "UNAVAILABLE";
  fields?: Record<string, string>;
};
export function catalogIssues(error: z.ZodError): CatalogFailure {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    fields[key] ??=
      issue.code === "unrecognized_keys" ? "Переданы недопустимые поля" : issue.message;
  }
  return { ok: false, code: "INVALID_INPUT", fields };
}
