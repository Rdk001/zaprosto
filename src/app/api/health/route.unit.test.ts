import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/health liveness", () => {
  it("remains the cheap Telegram/database-independent contract", async () => {
    const forbiddenFetch = vi.fn(() => {
      throw new Error("Network is forbidden for liveness");
    });
    vi.stubGlobal("fetch", forbiddenFetch);

    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "zaprosto-web" });
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });
});
