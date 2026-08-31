"use server";
import { cookies, headers } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { settingsBoundary } from "../../server/admin/settings";

export async function saveSettingsAction(input: unknown) {
  try {
    return await settingsBoundary.save(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
