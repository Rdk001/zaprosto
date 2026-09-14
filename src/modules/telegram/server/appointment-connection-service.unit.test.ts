import { describe, expect, it, vi } from "vitest";

import { prepareBookingAttempt } from "../../booking/server/booking-security";
import type { AppointmentTelegramStore } from "./appointment-connection-repository";
import { AppointmentTelegramService } from "./appointment-connection-service";

function setup() {
  const store: AppointmentTelegramStore = {
    readAppointment: vi.fn(async () => ({ kind: "AVAILABLE" as const })),
    disconnectAppointment: vi.fn(async () => ({
      kind: "DISCONNECTED" as const,
      alreadyDisconnected: false,
    })),
  };
  return { store, service: new AppointmentTelegramService(store) };
}

describe("Appointment Telegram service", () => {
  it("runtime-validates input before storage access", async () => {
    const { service, store } = setup();
    await expect(service.getState({ token: "not-a-string" })).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    await expect(service.disconnect("malformed")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(store.readAppointment).not.toHaveBeenCalled();
    expect(store.disconnectAppointment).not.toHaveBeenCalled();
  });

  it("passes only the cancellation hash to read and disconnect", async () => {
    const { service, store } = setup();
    const token = prepareBookingAttempt().cancellationToken;
    await expect(service.getState(token)).resolves.toEqual({ ok: true, state: "AVAILABLE" });
    await expect(service.disconnect(token)).resolves.toEqual({
      ok: true,
      alreadyDisconnected: false,
    });
    for (const call of [
      vi.mocked(store.readAppointment).mock.calls[0]![0],
      vi.mocked(store.disconnectAppointment).mock.calls[0]![0],
    ]) {
      expect(call).toMatch(/^[0-9a-f]{64}$/);
      expect(call).not.toContain(token);
    }
  });

  it("maps missing appointments without returning storage details", async () => {
    const { service, store } = setup();
    vi.mocked(store.readAppointment).mockResolvedValueOnce({ kind: "NOT_FOUND" });
    vi.mocked(store.disconnectAppointment).mockResolvedValueOnce({ kind: "NOT_FOUND" });
    const token = prepareBookingAttempt().cancellationToken;
    await expect(service.getState(token)).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
    await expect(service.disconnect(token)).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
  });
});
