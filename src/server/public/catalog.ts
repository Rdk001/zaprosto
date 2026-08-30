import "server-only";
import { Temporal } from "temporal-polyfill";
import { prisma } from "../db/prisma";
import {
  getBookingDateContext,
  localDateForInstant,
} from "../../modules/scheduling/time/business-time";

export async function getPublicCatalog() {
  const [settings, services] = await Promise.all([
    prisma.businessSettings.findUnique({ where: { id: 1 } }),
    prisma.service.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        priceKopecks: true,
        durationMinutes: true,
        masters: {
          where: { master: { isActive: true } },
          orderBy: [{ master: { displayOrder: "asc" } }, { masterId: "asc" }],
          select: { master: { select: { id: true, name: true, description: true } } },
        },
      },
    }),
  ]);
  if (!settings) return null;
  const now = new Date();
  const context = getBookingDateContext(
    localDateForInstant(now, settings.timezone),
    settings.timezone,
    settings.bookingHorizonDays,
    now,
  );
  const dates = Array.from({ length: settings.bookingHorizonDays }, (_, i) =>
    Temporal.PlainDate.from(context.today).add({ days: i }).toString(),
  );
  return {
    businessName: settings.businessName,
    timeZone: settings.timezone,
    dates,
    services: services.map((service) => ({
      ...service,
      masters: service.masters.map((row) => row.master),
    })),
  };
}
export type PublicCatalog = NonNullable<Awaited<ReturnType<typeof getPublicCatalog>>>;
