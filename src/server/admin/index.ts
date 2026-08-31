import "server-only";
import { cookies } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { createAuthService } from "../../modules/auth/server/auth-service";
import { prisma } from "../db/prisma";
import { createRateLimiter } from "../public/security";
import { createAdminBoundary } from "./boundary";

const limit = createRateLimiter(prisma);
export const adminBoundary = createAdminBoundary({
  auth: createAuthService(prisma),
  limit: (identity) => limit("adminLogin", identity),
});
export async function getAdminHome() {
  try {
    const cookie = sessionCookie();
    return await adminBoundary.home((await cookies()).get(cookie.name)?.value);
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
