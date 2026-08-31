import "server-only";
import { cookies } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { prisma } from "../db/prisma";
import { createCatalogBoundary } from "./catalog-boundary";

export const catalogBoundary = createCatalogBoundary(prisma);
export async function getAdminCatalog() {
  try {
    return await catalogBoundary.list((await cookies()).get(sessionCookie().name)?.value);
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
