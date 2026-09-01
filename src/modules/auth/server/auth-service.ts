import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "../../../generated/prisma/client";
import { credentialsSchema, LOCK_MINUTES, MAX_FAILURES, SESSION_SECONDS } from "../policy";
import { verifyPassword } from "./password";

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function validSessionToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}
export type AdminIdentity = { id: string; login: string };
export function createAuthService(db: PrismaClient) {
  return {
    async login(input: unknown) {
      const parsed = credentialsSchema.safeParse(input);
      if (!parsed.success) return null;
      const { login, password } = parsed.data;
      const candidate = await db.adminUser.findUnique({ where: { login } });
      const matches = await verifyPassword(password, candidate?.passwordHash);
      if (!candidate) return null;
      return db.$transaction(async (tx) => {
        // Serialize decisions for this account, including concurrent login/reset.
        await tx.$queryRaw`SELECT id FROM admin_users WHERE id = ${candidate.id}::uuid FOR UPDATE`;
        const admin = await tx.adminUser.findUnique({ where: { id: candidate.id } });
        const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        if (
          !admin ||
          !admin.isActive ||
          admin.passwordHash !== candidate.passwordHash ||
          (admin.lockedUntil && admin.lockedUntil > now)
        )
          return null;
        if (!matches) {
          const failures = admin.lockedUntil
            ? 1
            : Math.min(admin.failedLoginAttempts + 1, MAX_FAILURES);
          await tx.adminUser.update({
            where: { id: admin.id },
            data: {
              failedLoginAttempts: failures,
              lockedUntil:
                failures >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MINUTES * 60000) : null,
            },
          });
          return null;
        }
        await tx.adminUser.update({
          where: { id: admin.id },
          data: { failedLoginAttempts: 0, lockedUntil: null },
        });
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
        await tx.adminSession.create({
          data: { adminId: admin.id, tokenHash: hashSessionToken(token), expiresAt },
        });
        return { token, expiresAt };
      });
    },
    async getAdmin(token: unknown): Promise<AdminIdentity | null> {
      return getActiveAdmin(db, token);
    },
    async logout(token: unknown) {
      // Idempotent even for inactive/expired sessions. Never revokes another session.
      if (!validSessionToken(token)) return;
      await db.$executeRaw`UPDATE admin_sessions SET revoked_at = clock_timestamp()
        WHERE token_hash = ${hashSessionToken(token)} AND revoked_at IS NULL`;
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;

export async function getActiveAdmin(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  token: unknown,
): Promise<AdminIdentity | null> {
  if (!validSessionToken(token)) return null;
  // No caching; DB time and active account are checked at every data boundary.
  const rows = await db.$queryRaw<AdminIdentity[]>`
        SELECT a.id, a.login FROM admin_sessions s
        JOIN admin_users a ON a.id = s.admin_id
        WHERE s.token_hash = ${hashSessionToken(token)}
          AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND a.is_active = true
        LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Recheck access after a Serializable transaction has waited on booking locks.
 * FOR SHARE detects a concurrent session/account update with a serialization
 * failure and keeps a successful authorization stable through COMMIT.
 */
export async function getActiveAdminForShare(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  token: unknown,
): Promise<AdminIdentity | null> {
  if (!validSessionToken(token)) return null;
  const rows = await db.$queryRaw<AdminIdentity[]>`
        SELECT a.id, a.login FROM admin_sessions s
        JOIN admin_users a ON a.id = s.admin_id
        WHERE s.token_hash = ${hashSessionToken(token)}
          AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND a.is_active = true
        LIMIT 1
        FOR SHARE OF s, a`;
  return rows[0] ?? null;
}
