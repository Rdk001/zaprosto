import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../../generated/prisma/client";
import { prepareBookingAttempt } from "../../booking/server/booking-security";
import type { AdminTelegramStore } from "./admin-connection-repository";
import { AdminTelegramService } from "./admin-connection-service";

const admin = { id: "11111111-1111-4111-8111-111111111111", login: "admin" };

function setup() {
  const store: AdminTelegramStore = {
    readAdmin: vi.fn(async () => ({ kind: "AVAILABLE" as const })),
    disconnectAdmin: vi.fn(async () => ({
      kind: "DISCONNECTED" as const,
      alreadyDisconnected: false,
    })),
  };
  const readActiveAdmin = vi.fn(async (): Promise<typeof admin | null> => admin);
  const service = new AdminTelegramService({} as PrismaClient, store, { readActiveAdmin });
  return { store, readActiveAdmin, service };
}

describe("Admin Telegram service", () => {
  it("runtime-validates the session before storage access", async () => {
    const { service, store, readActiveAdmin } = setup();
    for (const token of [undefined, null, "malformed", { token: "not-a-string" }]) {
      await expect(service.getState(token)).resolves.toEqual({
        ok: false,
        code: "UNAUTHORIZED",
      });
      await expect(service.disconnect(token)).resolves.toEqual({
        ok: false,
        code: "UNAUTHORIZED",
      });
    }
    expect(readActiveAdmin).not.toHaveBeenCalled();
    expect(store.readAdmin).not.toHaveBeenCalled();
    expect(store.disconnectAdmin).not.toHaveBeenCalled();
  });

  it.each(["AVAILABLE", "CONNECTED", "UNAVAILABLE"] as const)(
    "returns only the strict %s read state",
    async (state) => {
      const { service, store } = setup();
      vi.mocked(store.readAdmin).mockResolvedValueOnce({ kind: state });
      const token = prepareBookingAttempt().cancellationToken;
      await expect(service.getState(token)).resolves.toEqual({ ok: true, state });
      expect(store.readAdmin).toHaveBeenCalledExactlyOnceWith({
        adminUserId: admin.id,
        sessionToken: token,
      });
    },
  );

  it("uses only the administrator resolved from the active session", async () => {
    const { service, store, readActiveAdmin } = setup();
    const token = prepareBookingAttempt().cancellationToken;
    await expect(service.disconnect(token)).resolves.toEqual({
      ok: true,
      alreadyDisconnected: false,
    });
    expect(readActiveAdmin).toHaveBeenCalledExactlyOnceWith(expect.anything(), token);
    expect(store.disconnectAdmin).toHaveBeenCalledExactlyOnceWith({
      adminUserId: admin.id,
      sessionToken: token,
    });
  });

  it("returns UNAUTHORIZED for missing and concurrently invalidated sessions", async () => {
    const { service, store, readActiveAdmin } = setup();
    const token = prepareBookingAttempt().cancellationToken;
    readActiveAdmin.mockResolvedValueOnce(null);
    await expect(service.getState(token)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    expect(store.readAdmin).not.toHaveBeenCalled();

    vi.mocked(store.disconnectAdmin).mockResolvedValueOnce({ kind: "UNAUTHORIZED" });
    await expect(service.disconnect(token)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
  });

  it("normalizes authentication failures without exposing their cause", async () => {
    const { service, readActiveAdmin } = setup();
    const token = prepareBookingAttempt().cancellationToken;
    readActiveAdmin.mockRejectedValueOnce(new Error("DATABASE_SESSION_CANARY"));
    const error = await service.getState(token).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ADMIN_TELEGRAM_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("CANARY");
    expect((error as Error).cause).toBeUndefined();
  });
});
