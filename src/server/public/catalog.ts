import "server-only";
import { publicServiceTerms } from "../../modules/catalog/server/service-terms";
import { publicTimeContext } from "../../modules/settings/server/context";
import { prisma } from "../db/prisma";

export async function getPublicCatalog() {
  return prisma.$transaction(
    async (tx) => {
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
      const now = new Date();
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
    },
    { isolationLevel: "RepeatableRead" },
  );
}
export type PublicCatalog = NonNullable<Awaited<ReturnType<typeof getPublicCatalog>>>;
