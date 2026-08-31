"use server";
import { cookies, headers } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { catalogBoundary } from "../../server/admin/catalog";

export async function saveServiceAction(input: unknown) {
  try {
    return await catalogBoundary.saveService(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
export async function saveMasterAction(input: unknown) {
  try {
    return await catalogBoundary.saveMaster(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
export async function moveCatalogAction(input: unknown) {
  try {
    return await catalogBoundary.move(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
