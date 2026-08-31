import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { getActiveAdmin } from "../../modules/auth/server/auth-service";
import { settingsSchema, type SettingsFailure } from "../../modules/settings/domain/input";
import { settingsSelect, type BusinessTimeSettings } from "../../modules/settings/server/context";
import { validOrigin } from "../public/security";

export type SettingsResult = { ok: true; settings: BusinessTimeSettings } | SettingsFailure;
export function createSettingsBoundary(db: PrismaClient) {
  async function run(
    token: unknown,
    write: boolean,
    operation: (tx: Prisma.TransactionClient) => Promise<SettingsResult>,
  ): Promise<SettingsResult> {
    try {
      return await db.$transaction(
        async (tx) => {
          if (!(await getActiveAdmin(tx, token))) return { ok: false, code: "UNAUTHORIZED" };
          if (write) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(526008, 52)`;
            // Wait for bookings holding FOR SHARE before the final access check.
            await tx.$queryRaw`SELECT id FROM business_settings WHERE id = 1 FOR UPDATE`;
            if (!(await getActiveAdmin(tx, token))) return { ok: false, code: "UNAUTHORIZED" };
          }
          return operation(tx);
        },
        {
          isolationLevel: write ? "ReadCommitted" : "RepeatableRead",
          maxWait: 5000,
          timeout: 10000,
        },
      );
    } catch {
      // No retry: loss of COMMIT acknowledgement is not a confirmed rejection.
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
  return {
    read: (token: unknown) =>
      run(token, false, async (tx) => ({
        ok: true,
        settings: await tx.businessSettings.findUniqueOrThrow({
          where: { id: 1 },
          select: settingsSelect,
        }),
      })),
    save: (headers: Headers, token: unknown, raw: unknown): Promise<SettingsResult> => {
      if (!validOrigin(headers)) return Promise.resolve({ ok: false, code: "FORBIDDEN" });
      return run(token, true, async (tx) => {
        const parsed = settingsSchema.safeParse(raw);
        if (!parsed.success) {
          const fields: Record<string, string> = {};
          for (const issue of parsed.error.issues)
            fields[issue.path.join(".") || "form"] ??=
              issue.code === "unrecognized_keys"
                ? "Переданы недопустимые поля"
                : /^(Invalid|Too)/.test(issue.message)
                  ? "Проверьте формат и допустимый размер значения"
                  : issue.message;
          return { ok: false, code: "INVALID_INPUT", fields };
        }
        const current = await tx.businessSettings.findUniqueOrThrow({
          where: { id: 1 },
          select: settingsSelect,
        });
        const input = parsed.data;
        if (current.version !== input.version) return { ok: false, code: "CONFLICT" };
        if (current.timezone !== input.timezone && !input.confirmedTimezoneChange)
          return { ok: false, code: "CONFIRMATION_REQUIRED" };
        const settings = await tx.businessSettings.update({
          where: { id: 1, version: input.version },
          data: {
            timezone: input.timezone,
            bookingHorizonDays: input.bookingHorizonDays,
            version: { increment: 1 },
          },
          select: settingsSelect,
        });
        return { ok: true, settings };
      });
    },
  };
}
