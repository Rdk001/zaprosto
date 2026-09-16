import {
  getActiveAdmin,
  validSessionToken,
  type AdminIdentity,
} from "../../auth/server/auth-service";
import type { Prisma, PrismaClient } from "../../../generated/prisma/client";
import type { AdminTelegramState, AdminTelegramStore } from "./admin-connection-repository";

export type AdminTelegramStateResult =
  { ok: true; state: AdminTelegramState } | { ok: false; code: "UNAUTHORIZED" };
export type AdminTelegramDisconnectResult =
  { ok: true; alreadyDisconnected: boolean } | { ok: false; code: "UNAUTHORIZED" };

export interface AdminTelegramOperations {
  getState(sessionToken: unknown): Promise<AdminTelegramStateResult>;
  disconnect(sessionToken: unknown): Promise<AdminTelegramDisconnectResult>;
}

type ActiveAdminReader = (
  database: Pick<Prisma.TransactionClient, "$queryRaw">,
  token: unknown,
) => Promise<AdminIdentity | null>;

export class AdminTelegramServiceError extends Error {
  constructor(readonly code: "ADMIN_TELEGRAM_UNAVAILABLE") {
    super(code);
    this.name = "AdminTelegramServiceError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export class AdminTelegramService implements AdminTelegramOperations {
  constructor(
    private readonly database: PrismaClient,
    private readonly store: AdminTelegramStore,
    private readonly options: { readActiveAdmin?: ActiveAdminReader } = {},
  ) {}

  private async activeAdmin(sessionToken: unknown): Promise<AdminIdentity | null> {
    if (!validSessionToken(sessionToken)) return null;
    try {
      return await (this.options.readActiveAdmin ?? getActiveAdmin)(this.database, sessionToken);
    } catch {
      throw new AdminTelegramServiceError("ADMIN_TELEGRAM_UNAVAILABLE");
    }
  }

  async getState(sessionToken: unknown): Promise<AdminTelegramStateResult> {
    const admin = await this.activeAdmin(sessionToken);
    if (!admin) return { ok: false, code: "UNAUTHORIZED" };
    const result = await this.store.readAdmin({ adminUserId: admin.id, sessionToken });
    return result.kind === "UNAUTHORIZED"
      ? { ok: false, code: "UNAUTHORIZED" }
      : { ok: true, state: result.kind };
  }

  async disconnect(sessionToken: unknown): Promise<AdminTelegramDisconnectResult> {
    const admin = await this.activeAdmin(sessionToken);
    if (!admin) return { ok: false, code: "UNAUTHORIZED" };
    const result = await this.store.disconnectAdmin({ adminUserId: admin.id, sessionToken });
    return result.kind === "UNAUTHORIZED"
      ? { ok: false, code: "UNAUTHORIZED" }
      : { ok: true, alreadyDisconnected: result.alreadyDisconnected };
  }
}
