import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { PrismaClient } from "../../generated/prisma/client";

export type PublicOperation = "prepare" | "create" | "lookup" | "cancel" | "availability";
export const limits: Record<PublicOperation, { client: number; global: number }> = {
  prepare: { client: 20, global: 200 },
  create: { client: 12, global: 120 },
  lookup: { client: 60, global: 600 },
  cancel: { client: 20, global: 200 },
  availability: { client: 120, global: 1200 },
};
export function validOrigin(headers: Headers, origin = process.env.PUBLIC_ORIGIN): boolean {
  if (!origin) return false;
  try {
    return (
      new URL(origin).origin === origin &&
      headers.get("origin") === origin &&
      (!headers.get("sec-fetch-site") || headers.get("sec-fetch-site") === "same-origin")
    );
  } catch {
    return false;
  }
}
export function clientIdentity(
  headers: Headers,
  trusted = process.env.TRUST_PROXY_CLIENT_IP === "true",
) {
  // Only enable behind a proxy which overwrites this header and blocks direct access.
  const supplied = trusted ? headers.get("x-zaprosto-client-ip") : null;
  if (!supplied || !isIP(supplied)) return "shared";
  const normalized = isIP(supplied) === 6 ? new URL(`http://[${supplied}]/`).hostname : supplied;
  return createHash("sha256").update(normalized).digest("hex");
}
export function createRateLimiter(database: PrismaClient) {
  return async (operation: PublicOperation, identity: string) => {
    const policy = limits[operation];
    // DB time and atomic UPSERT work across processes. Denied counters saturate.
    return database.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM public_rate_limits WHERE expires_at < CURRENT_TIMESTAMP`;
      for (const [key, maximum] of [
        [`${operation}:global`, policy.global],
        [`${operation}:${identity}`, policy.client],
      ] as const) {
        const rows = await tx.$queryRaw<Array<{ hits: number }>>`
          INSERT INTO public_rate_limits (key, hits, expires_at)
          VALUES (${key}, 1, CURRENT_TIMESTAMP + interval '1 minute')
          ON CONFLICT (key) DO UPDATE SET hits = LEAST(public_rate_limits.hits + 1, ${maximum + 1})
          RETURNING hits`;
        if (rows[0].hits > maximum) return false;
      }
      return true;
    });
  };
}
