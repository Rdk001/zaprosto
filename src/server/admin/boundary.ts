import { credentialsSchema, safeReturnTo } from "../../modules/auth/policy";
import type { AuthService } from "../../modules/auth/server/auth-service";
import { clientIdentity, validOrigin } from "../public/security";

export type AdminFailure = {
  ok: false;
  code: "INVALID_CREDENTIALS" | "FORBIDDEN" | "UNAUTHORIZED" | "UNAVAILABLE";
};
const unavailable: AdminFailure = { ok: false, code: "UNAVAILABLE" };
export function createAdminBoundary(deps: {
  auth: AuthService;
  limit: (identity: string) => Promise<boolean>;
}) {
  return {
    async login(
      headers: Headers,
      input: unknown,
      returnTo: unknown,
      issueCookie: (session: { token: string; expiresAt: Date }) => Promise<void>,
    ) {
      if (!validOrigin(headers)) return { ok: false as const, code: "FORBIDDEN" as const };
      try {
        const parsed = credentialsSchema.safeParse(input);
        if (!parsed.success || !(await deps.limit(clientIdentity(headers))))
          return { ok: false as const, code: "INVALID_CREDENTIALS" as const };
        const session = await deps.auth.login(parsed.data);
        if (!session) return { ok: false as const, code: "INVALID_CREDENTIALS" as const };
        await issueCookie(session);
        // The opaque token must never enter an action's serialized result.
        return { ok: true as const, redirectTo: safeReturnTo(returnTo) };
      } catch {
        return unavailable;
      }
    },
    async home(token: unknown) {
      try {
        const admin = await deps.auth.getAdmin(token);
        if (!admin) return { ok: false as const, code: "UNAUTHORIZED" as const };
        return { ok: true as const, admin };
      } catch {
        return unavailable;
      }
    },
    async logout(headers: Headers, token: unknown) {
      if (!validOrigin(headers)) return { ok: false as const, code: "FORBIDDEN" as const };
      try {
        await deps.auth.logout(token);
        return { ok: true as const };
      } catch {
        // Do not claim a successful logout until the server revocation commits.
        return unavailable;
      }
    },
  };
}
