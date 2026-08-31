import "server-only";
import { cookies } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { prisma } from "../db/prisma";
import { createScheduleBoundary } from "./schedule-boundary";

export const scheduleBoundary = createScheduleBoundary(prisma);
export async function getAdminSchedule(query: unknown) {
  try {
    return await scheduleBoundary.read((await cookies()).get(sessionCookie().name)?.value, query);
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
