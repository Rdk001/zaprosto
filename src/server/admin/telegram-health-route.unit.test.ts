import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramHealthSnapshot } from "../../modules/telegram/server/health-snapshot";
import { createAdminTelegramHealthRouteHandler } from "./telegram-health-route";

const sessionToken = vi.fn();
const read = vi.fn();
const GET = createAdminTelegramHealthRouteHandler({ sessionToken, read });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/admin/telegram/health", () => {
  it("returns only a neutral 401 code to an anonymous caller", async () => {
    sessionToken.mockResolvedValue(undefined);
    read.mockResolvedValue({ ok: false, code: "UNAUTHORIZED" });
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns an authenticated snapshot without BigInt", async () => {
    const snapshot = {
      generatedAt: "2036-01-02T03:04:05.000Z",
      status: "HEALTHY",
    } as TelegramHealthSnapshot;
    sessionToken.mockResolvedValue("session");
    read.mockResolvedValue({ ok: true, snapshot });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, snapshot });
  });

  it("maps storage and cookie failures to bounded 503 responses", async () => {
    sessionToken.mockResolvedValueOnce("session");
    read.mockResolvedValueOnce({ ok: false, code: "TELEGRAM_HEALTH_STORAGE_FAILURE" });
    const storage = await GET();
    expect(storage.status).toBe(503);
    expect(await storage.json()).toEqual({
      ok: false,
      code: "TELEGRAM_HEALTH_STORAGE_FAILURE",
    });

    sessionToken.mockRejectedValueOnce(new Error("cookie secret"));
    const cookie = await GET();
    expect(cookie.status).toBe(503);
    expect(await cookie.json()).toEqual({ ok: false, code: "UNAVAILABLE" });
  });
});
