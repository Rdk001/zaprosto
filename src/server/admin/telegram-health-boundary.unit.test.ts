import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramHealthSnapshot } from "../../modules/telegram/server/health-snapshot";
import { createAdminTelegramHealthBoundary } from "./telegram-health-boundary";

const snapshot = { generatedAt: "2036-01-02T03:04:05.000Z" } as TelegramHealthSnapshot;
const authorize = vi.fn();
const readSnapshot = vi.fn();
const boundary = createAdminTelegramHealthBoundary({
  authorize,
  snapshot: readSnapshot,
  configuration: () => ({ kind: "DISABLED" }),
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("admin Telegram health boundary", () => {
  it("denies anonymous access without reading detailed metrics", async () => {
    authorize.mockResolvedValue(false);
    expect(await boundary.read(undefined)).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it("returns the strict snapshot to an authenticated administrator", async () => {
    authorize.mockResolvedValue(true);
    readSnapshot.mockResolvedValue(snapshot);
    expect(await boundary.read("session")).toEqual({ ok: true, snapshot });
  });

  it("keeps auth and snapshot storage failures bounded", async () => {
    authorize.mockRejectedValueOnce(new Error("session SQL token"));
    expect(await boundary.read("secret")).toEqual({ ok: false, code: "UNAVAILABLE" });

    authorize.mockResolvedValueOnce(true);
    readSnapshot.mockRejectedValueOnce(new Error("raw SQL chat payload"));
    expect(await boundary.read("secret")).toEqual({
      ok: false,
      code: "TELEGRAM_HEALTH_STORAGE_FAILURE",
    });
  });
});
