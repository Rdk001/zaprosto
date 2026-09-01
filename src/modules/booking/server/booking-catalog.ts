import type { Prisma } from "../../../generated/prisma/client";
import { publicServiceTerms } from "../../catalog/server/service-terms";
import { publicTimeContext } from "../../settings/server/context";

export async function readBookingCatalog(tx: Prisma.TransactionClient, now: Date) {
  const [settings, services] = await Promise.all([
    tx.businessSettings.findUnique({ where: { id: 1 } }),
    tx.service.findMany({
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
  const context = publicTimeContext(settings, now);
  return {
    businessName: settings.businessName,
    timeZone: context.timeZone,
    dates: context.dates,
    context,
    services: services.map((service) => ({
      ...publicServiceTerms(service),
      masters: service.masters.map((row) => row.master),
    })),
  };
}

export type BookingCatalog = NonNullable<Awaited<ReturnType<typeof readBookingCatalog>>>;
