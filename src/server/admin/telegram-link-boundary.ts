import type {
  AdminTelegramDisconnectResult,
  AdminTelegramOperations,
  AdminTelegramStateResult,
} from "../../modules/telegram/server/admin-connection-service";
import type {
  TelegramAdminLinkResult,
  TelegramAdminRevokeResult,
  TelegramLinkOperations,
} from "../../modules/telegram/server/link-service";
import { validOrigin } from "../public/security";

type StateResult = AdminTelegramStateResult | { ok: false; code: "UNAVAILABLE" };
type MutationResult =
  TelegramAdminLinkResult | TelegramAdminRevokeResult | AdminTelegramDisconnectResult;
type BoundaryFailure = { ok: false; code: "FORBIDDEN" | "UNAVAILABLE" };

export function createAdminTelegramLinkBoundary(
  service: TelegramLinkOperations,
  connections?: AdminTelegramOperations,
) {
  async function mutation<T extends MutationResult>(
    headers: Headers,
    work: () => Promise<T>,
  ): Promise<T | BoundaryFailure> {
    if (!validOrigin(headers)) return { ok: false, code: "FORBIDDEN" };
    try {
      return await work();
    } catch {
      // Never log raw credentials, session values or database exceptions here.
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
  return {
    state: async (token: unknown): Promise<StateResult> => {
      try {
        return connections ? await connections.getState(token) : { ok: false, code: "UNAVAILABLE" };
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
    issue: (headers: Headers, token: unknown) =>
      mutation(headers, () => service.issueAdminLink(token)),
    revoke: (headers: Headers, token: unknown) =>
      mutation(headers, () => service.revokeAdminLink(token)),
    disconnect: (headers: Headers, token: unknown) =>
      mutation(headers, async () =>
        connections
          ? connections.disconnect(token)
          : ({ ok: false, code: "UNAUTHORIZED" } as const),
      ),
  };
}
