import type {
  TelegramAdminLinkResult,
  TelegramAdminRevokeResult,
  TelegramLinkOperations,
} from "../../modules/telegram/server/link-service";
import { validOrigin } from "../public/security";

type Result =
  | TelegramAdminLinkResult
  | TelegramAdminRevokeResult
  | { ok: false; code: "FORBIDDEN" | "UNAVAILABLE" };

export function createAdminTelegramLinkBoundary(service: TelegramLinkOperations) {
  async function mutation(
    headers: Headers,
    work: () => Promise<TelegramAdminLinkResult | TelegramAdminRevokeResult>,
  ): Promise<Result> {
    if (!validOrigin(headers)) return { ok: false, code: "FORBIDDEN" };
    try {
      return await work();
    } catch {
      // Never log raw credentials, session values or database exceptions here.
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
  return {
    issue: (headers: Headers, token: unknown) =>
      mutation(headers, () => service.issueAdminLink(token)),
    revoke: (headers: Headers, token: unknown) =>
      mutation(headers, () => service.revokeAdminLink(token)),
  };
}
