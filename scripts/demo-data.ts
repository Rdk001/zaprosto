import type { PrismaClient } from "../src/generated/prisma/client";
export const demoServiceIds = [
  "de000000-0000-4000-8000-000000000001",
  "de000000-0000-4000-8000-000000000002",
  "de000000-0000-4000-8000-000000000003",
];
export const demoMasterIds = [
  "de000000-0000-4000-8000-000000000011",
  "de000000-0000-4000-8000-000000000012",
];
export async function seedDemo(database: PrismaClient) {
  await database.$transaction(async (tx) => {
    await tx.businessSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, businessName: "Барбершоп · демо" },
    });
    const services = [
      { name: "Мужская стрижка · демо", priceKopecks: 180000, durationMinutes: 45 },
      { name: "Борода и контур · демо", priceKopecks: 120000, durationMinutes: 30 },
      { name: "Стрижка и борода · демо", priceKopecks: 270000, durationMinutes: 75 },
    ];
    for (const [index, service] of services.entries())
      await tx.service.upsert({
        where: { id: demoServiceIds[index] },
        update: {},
        create: { id: demoServiceIds[index], ...service, displayOrder: index },
      });
    for (const [index, id] of demoMasterIds.entries()) {
      // Existing demo rows (including edited schedules) are intentionally left untouched.
      if (await tx.master.findUnique({ where: { id } })) continue;
      await tx.master.create({
        data: {
          id,
          name: index === 0 ? "Алексей · демо" : "Михаил · демо",
          description: "Вымышленный мастер для демонстрации",
          displayOrder: index,
          services: { create: demoServiceIds.map((serviceId) => ({ serviceId })) },
          weeklyWorkIntervals: {
            create: Array.from({ length: 7 }, (_, i) => ({
              dayOfWeek: i + 1,
              startsAt: new Date("1970-01-01T10:00:00Z"),
              endsAt: new Date("1970-01-01T20:00:00Z"),
            })),
          },
          weeklyBreaks: {
            create: Array.from({ length: 7 }, (_, i) => ({
              dayOfWeek: i + 1,
              startsAt: new Date("1970-01-01T14:00:00Z"),
              endsAt: new Date("1970-01-01T15:00:00Z"),
            })),
          },
        },
      });
    }
  });
}
