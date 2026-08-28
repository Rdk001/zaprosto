import { z } from "zod";

const russianPhoneInputSchema = z
  .string()
  .trim()
  .regex(/^(?:\+7|8)[\d ()-]+$/, "Укажите российский номер с префиксом +7 или 8");

export function normalizeRussianPhone(input: string): string {
  const validated = russianPhoneInputSchema.parse(input);
  const digits = validated.replace(/\D/g, "");

  if (digits.length !== 11 || (digits[0] !== "7" && digits[0] !== "8")) {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "Российский номер должен содержать 11 цифр",
      },
    ]);
  }

  return `+7${digits.slice(1)}`;
}
