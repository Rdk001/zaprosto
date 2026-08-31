import { createHash } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import type { Prisma } from "../../../generated/prisma/client";
import { getBookingDateContext, localDateForInstant } from "../../scheduling/time/business-time";

export const settingsSelect = { version: true, timezone: true, bookingHorizonDays: true } as const;
export type BusinessTimeSettings = {
  version: number;
  timezone: string;
  bookingHorizonDays: number;
};
export function businessContextHash(settings: BusinessTimeSettings) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "business-time-v1",
        settings.version,
        settings.timezone,
        settings.bookingHorizonDays,
      ]),
    )
    .digest("hex");
}
export function publicTimeContext(settings: BusinessTimeSettings, now: Date) {
  const context = getBookingDateContext(
    localDateForInstant(now, settings.timezone),
    settings.timezone,
    settings.bookingHorizonDays,
    now,
  );
  return {
    version: settings.version,
    contextHash: businessContextHash(settings),
    timeZone: settings.timezone,
    dates: Array.from({ length: settings.bookingHorizonDays }, (_, i) =>
      Temporal.PlainDate.from(context.today).add({ days: i }).toString(),
    ),
  };
}
export type PublicTimeContext = ReturnType<typeof publicTimeContext>;
export async function readTimeContext(tx: Prisma.TransactionClient, now: Date) {
  return publicTimeContext(
    await tx.businessSettings.findUniqueOrThrow({ where: { id: 1 }, select: settingsSelect }),
    now,
  );
}
