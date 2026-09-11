import type { Prisma, PrismaClient } from "../../../generated/prisma/client";
import { getActiveAdmin, type AdminIdentity } from "../../auth/server/auth-service";
import { bookingTokenSchema } from "../../booking/domain/booking-input";
import { hashBookingToken } from "../../booking/server/booking-security";
import { isTelegramBotUsername } from "../domain/config-contract";
import {
  generateTelegramLinkToken,
  hashTelegramLinkToken,
  type TelegramLinkPurpose,
  type TelegramRandomSource,
} from "../domain/link-token";
import type { TelegramAdminLinkRepositoryResult, TelegramLinkStore } from "./link-repository";

export type TelegramLinkSuccess = { ok: true; deepLink: string; expiresAt: Date };
export type TelegramAppointmentLinkResult =
  | TelegramLinkSuccess
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "APPOINTMENT_NOT_ELIGIBLE"
        | "ALREADY_CONNECTED"
        | "TELEGRAM_NOT_READY"
        | "RATE_LIMITED";
    };
export type TelegramAppointmentRevokeResult =
  { ok: true } | { ok: false; code: "INVALID_INPUT" | "NOT_FOUND" };
export type TelegramAdminLinkResult =
  | TelegramLinkSuccess
  | {
      ok: false;
      code:
        "UNAUTHORIZED" | "FORBIDDEN" | "ALREADY_CONNECTED" | "TELEGRAM_NOT_READY" | "RATE_LIMITED";
    };
export type TelegramAdminRevokeResult =
  { ok: true } | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN" };

type ActiveAdminReader = (
  database: Pick<Prisma.TransactionClient, "$queryRaw">,
  token: unknown,
) => Promise<AdminIdentity | null>;

export interface TelegramLinkOperations {
  issueAppointmentLink(token: unknown): Promise<TelegramAppointmentLinkResult>;
  revokeAppointmentLink(token: unknown): Promise<TelegramAppointmentRevokeResult>;
  issueAdminLink(token: unknown): Promise<TelegramAdminLinkResult>;
  revokeAdminLink(token: unknown): Promise<TelegramAdminRevokeResult>;
}

export class TelegramLinkServiceError extends Error {
  constructor(readonly code: "LINK_UNAVAILABLE") {
    super(code);
    this.name = "TelegramLinkServiceError";
  }
  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

function credential(purpose: TelegramLinkPurpose, randomSource?: TelegramRandomSource) {
  const generated = generateTelegramLinkToken(purpose, randomSource);
  const hashed = hashTelegramLinkToken(generated.startParameter);
  if (!hashed.ok || hashed.purpose !== purpose)
    throw new TelegramLinkServiceError("LINK_UNAVAILABLE");
  return { raw: generated.startParameter, hash: hashed.hash };
}

function deepLink(username: string | undefined, raw: string) {
  if (!username || !isTelegramBotUsername(username) || !hashTelegramLinkToken(raw).ok)
    throw new TelegramLinkServiceError("LINK_UNAVAILABLE");
  return `https://t.me/${username}?start=${raw}`;
}

export class TelegramLinkService implements TelegramLinkOperations {
  constructor(
    private readonly database: PrismaClient,
    private readonly store: TelegramLinkStore,
    private readonly options: {
      randomSource?: TelegramRandomSource;
      readActiveAdmin?: ActiveAdminReader;
    } = {},
  ) {}

  async issueAppointmentLink(token: unknown): Promise<TelegramAppointmentLinkResult> {
    const parsed = bookingTokenSchema.safeParse(token);
    if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
    const created = credential("APPOINTMENT", this.options.randomSource);
    const result = await this.store.issueAppointment({
      cancellationTokenHash: hashBookingToken(parsed.data),
      linkTokenHash: created.hash,
    });
    if (result.kind !== "ISSUED") return { ok: false, code: result.kind };
    return {
      ok: true,
      deepLink: deepLink(result.botUsername, created.raw),
      expiresAt: result.expiresAt,
    };
  }

  async revokeAppointmentLink(token: unknown): Promise<TelegramAppointmentRevokeResult> {
    const parsed = bookingTokenSchema.safeParse(token);
    if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
    const result = await this.store.revokeAppointment(hashBookingToken(parsed.data));
    return result.kind === "REVOKED" ? { ok: true } : { ok: false, code: "NOT_FOUND" };
  }

  private async activeAdmin(token: unknown) {
    const reader = this.options.readActiveAdmin ?? getActiveAdmin;
    try {
      return await reader(this.database, token);
    } catch {
      throw new TelegramLinkServiceError("LINK_UNAVAILABLE");
    }
  }

  async issueAdminLink(token: unknown): Promise<TelegramAdminLinkResult> {
    const admin = await this.activeAdmin(token);
    if (!admin) return { ok: false, code: "UNAUTHORIZED" };
    const created = credential("ADMIN_USER", this.options.randomSource);
    const result: TelegramAdminLinkRepositoryResult = await this.store.issueAdmin({
      adminUserId: admin.id,
      sessionToken: token,
      linkTokenHash: created.hash,
    });
    if (result.kind !== "ISSUED") return { ok: false, code: result.kind };
    return {
      ok: true,
      deepLink: deepLink(result.botUsername, created.raw),
      expiresAt: result.expiresAt,
    };
  }

  async revokeAdminLink(token: unknown): Promise<TelegramAdminRevokeResult> {
    const admin = await this.activeAdmin(token);
    if (!admin) return { ok: false, code: "UNAUTHORIZED" };
    const result = await this.store.revokeAdmin({ adminUserId: admin.id, sessionToken: token });
    return result.kind === "REVOKED" ? { ok: true } : { ok: false, code: result.kind };
  }
}
