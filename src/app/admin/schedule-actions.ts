"use server";
import { cookies, headers } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { scheduleBoundary } from "../../server/admin/schedule";

export async function saveWeekAction(input: unknown) {
  try {
    return await scheduleBoundary.saveWeek(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
export async function saveExceptionAction(input: unknown) {
  try {
    return await scheduleBoundary.saveException(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
export async function deleteExceptionAction(input: unknown) {
  try {
    return await scheduleBoundary.deleteException(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
