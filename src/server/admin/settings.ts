import "server-only";
import { cookies } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { prisma } from "../db/prisma";
import { createSettingsBoundary } from "./settings-boundary";

export const settingsBoundary = createSettingsBoundary(prisma);
export async function getAdminSettings() {
  try {
    return await settingsBoundary.read((await cookies()).get(sessionCookie().name)?.value);
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
