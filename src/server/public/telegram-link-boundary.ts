import type {
  TelegramAppointmentLinkResult,
  TelegramAppointmentRevokeResult,
  TelegramLinkOperations,
} from "../../modules/telegram/server/link-service";
import { validOrigin } from "./security";

type Result =
  | TelegramAppointmentLinkResult
  | TelegramAppointmentRevokeResult
  | { ok: false; code: "FORBIDDEN" | "UNAVAILABLE" };

export function createPublicTelegramLinkBoundary(service: TelegramLinkOperations) {
  async function mutation(
    headers: Headers,
    work: () => Promise<TelegramAppointmentLinkResult | TelegramAppointmentRevokeResult>,
  ): Promise<Result> {
    if (!validOrigin(headers)) return { ok: false, code: "FORBIDDEN" };
    try {
      return await work();
    } catch {
      // Never log raw credentials or database exceptions at this boundary.
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
  return {
    issue: (headers: Headers, token: unknown) =>
      mutation(headers, () => service.issueAppointmentLink(token)),
    revoke: (headers: Headers, token: unknown) =>
      mutation(headers, () => service.revokeAppointmentLink(token)),
  };
}
