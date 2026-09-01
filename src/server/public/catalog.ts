import "server-only";
import { readBookingCatalog } from "../../modules/booking/server/booking-catalog";
import { prisma } from "../db/prisma";

export async function getPublicCatalog() {
  return prisma.$transaction((tx) => readBookingCatalog(tx, new Date()), {
    isolationLevel: "RepeatableRead",
  });
}
export type PublicCatalog = NonNullable<Awaited<ReturnType<typeof getPublicCatalog>>>;
