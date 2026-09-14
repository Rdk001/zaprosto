import type {
  TelegramAppointmentLinkResult,
  TelegramAppointmentRevokeResult,
  TelegramLinkOperations,
} from "../../modules/telegram/server/link-service";
import type {
  AppointmentTelegramDisconnectServiceResult,
  AppointmentTelegramOperations,
  AppointmentTelegramStateResult,
} from "../../modules/telegram/server/appointment-connection-service";
import { validOrigin } from "./security";

type StateResult = AppointmentTelegramStateResult | { ok: false; code: "UNAVAILABLE" };
type DisconnectResult =
  AppointmentTelegramDisconnectServiceResult | { ok: false; code: "FORBIDDEN" | "UNAVAILABLE" };

export function createPublicTelegramLinkBoundary(
  service: TelegramLinkOperations,
  appointments?: AppointmentTelegramOperations,
) {
  async function mutation<
    T extends TelegramAppointmentLinkResult | TelegramAppointmentRevokeResult,
  >(
    headers: Headers,
    work: () => Promise<T>,
  ): Promise<T | { ok: false; code: "FORBIDDEN" | "UNAVAILABLE" }> {
    if (!validOrigin(headers)) return { ok: false, code: "FORBIDDEN" };
    try {
      return await work();
    } catch {
      // Never log raw credentials or database exceptions at this boundary.
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
  return {
    state: async (token: unknown): Promise<StateResult> => {
      try {
        return appointments
          ? await appointments.getState(token)
          : { ok: false, code: "UNAVAILABLE" };
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
    issue: (headers: Headers, token: unknown) =>
      mutation(headers, () => service.issueAppointmentLink(token)),
    revoke: (headers: Headers, token: unknown) =>
      mutation(headers, () => service.revokeAppointmentLink(token)),
    disconnect: async (headers: Headers, token: unknown): Promise<DisconnectResult> => {
      if (!validOrigin(headers)) return { ok: false, code: "FORBIDDEN" };
      try {
        return appointments
          ? await appointments.disconnect(token)
          : { ok: false, code: "UNAVAILABLE" };
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
  };
}
