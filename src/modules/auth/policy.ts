import { z } from "zod";

export const SESSION_SECONDS = 12 * 60 * 60;
export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;
export const LOGIN_FAILURE =
  "Неверный логин или пароль. Если вход временно ограничен, попробуйте через 15 минут.";
export const loginSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/)
  .transform((s) => s.toLowerCase());
export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((s) => Buffer.byteLength(s, "utf8") <= 512);
export const credentialsSchema = z.strictObject({
  login: loginSchema,
  password: passwordSchema,
});

// Only the implemented destination is accepted. No URL parsing/normalization loopholes.
export function safeReturnTo(value: unknown): string {
  return value === "/admin" ? value : "/admin";
}

export function sessionCookie(origin = process.env.PUBLIC_ORIGIN) {
  if (!origin) throw new Error("Authentication origin is not configured");
  const url = new URL(origin);
  if (url.origin !== origin || !["https:", "http:"].includes(url.protocol))
    throw new Error("Invalid authentication origin");
  const secure = url.protocol === "https:";
  if (!secure && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Authentication requires HTTPS outside loopback");
  return {
    name: secure ? "__Host-zaprosto-admin" : "zaprosto-admin-local",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
  };
}
