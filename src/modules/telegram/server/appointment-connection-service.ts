import { bookingTokenSchema } from "../../booking/domain/booking-input";
import { hashBookingToken } from "../../booking/server/booking-security";
import type {
  AppointmentTelegramState,
  AppointmentTelegramStore,
} from "./appointment-connection-repository";

export type AppointmentTelegramStateResult =
  | { ok: true; state: AppointmentTelegramState }
  | { ok: false; code: "INVALID_INPUT" | "NOT_FOUND" };
export type AppointmentTelegramDisconnectServiceResult =
  { ok: true; alreadyDisconnected: boolean } | { ok: false; code: "INVALID_INPUT" | "NOT_FOUND" };

export interface AppointmentTelegramOperations {
  getState(token: unknown): Promise<AppointmentTelegramStateResult>;
  disconnect(token: unknown): Promise<AppointmentTelegramDisconnectServiceResult>;
}

export class AppointmentTelegramService implements AppointmentTelegramOperations {
  constructor(private readonly store: AppointmentTelegramStore) {}

  async getState(token: unknown): Promise<AppointmentTelegramStateResult> {
    const parsed = bookingTokenSchema.safeParse(token);
    if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
    const result = await this.store.readAppointment(hashBookingToken(parsed.data));
    return result.kind === "NOT_FOUND"
      ? { ok: false, code: "NOT_FOUND" }
      : { ok: true, state: result.kind };
  }

  async disconnect(token: unknown): Promise<AppointmentTelegramDisconnectServiceResult> {
    const parsed = bookingTokenSchema.safeParse(token);
    if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
    const result = await this.store.disconnectAppointment(hashBookingToken(parsed.data));
    return result.kind === "NOT_FOUND"
      ? { ok: false, code: "NOT_FOUND" }
      : { ok: true, alreadyDisconnected: result.alreadyDisconnected };
  }
}
