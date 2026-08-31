"use server";
import { cookies, headers } from "next/headers";
import { adminBoundary } from "../../server/admin";
import { sessionCookie } from "../../modules/auth/policy";

export async function loginAdminAction(input: unknown, returnTo: unknown) {
  try {
    const options = sessionCookie();
    return await adminBoundary.login(await headers(), input, returnTo, async (session) => {
      (await cookies()).set(options.name, session.token, {
        ...options,
        expires: session.expiresAt,
      });
    });
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
export async function logoutAdminAction() {
  try {
    const options = sessionCookie();
    const store = await cookies();
    const result = await adminBoundary.logout(await headers(), store.get(options.name)?.value);
    if (result.ok) store.set(options.name, "", { ...options, expires: new Date(0), maxAge: 0 });
    return result;
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
