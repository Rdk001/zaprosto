import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramLinkOperations } from "../../modules/telegram/server/link-service";
import { createAdminTelegramLinkBoundary } from "./telegram-link-boundary";

const headers = new Headers({ origin: "https://salon.example", "sec-fetch-site": "same-origin" });
const service: TelegramLinkOperations = {
  issueAppointmentLink: vi.fn(),
  revokeAppointmentLink: vi.fn(),
  issueAdminLink: vi.fn(),
  revokeAdminLink: vi.fn(),
};
const boundary = createAdminTelegramLinkBoundary(service);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PUBLIC_ORIGIN", "https://salon.example");
});
afterEach(() => vi.unstubAllEnvs());

describe("admin Telegram link boundary", () => {
  it("requires exact same-origin headers and accepts no adminUserId", async () => {
    for (const value of [
      new Headers(),
      new Headers({ origin: "https://evil.example" }),
      new Headers({ origin: "https://salon.example", "sec-fetch-site": "cross-site" }),
    ]) {
      expect(await boundary.issue(value, "session")).toEqual({ ok: false, code: "FORBIDDEN" });
      expect(await boundary.revoke(value, "session")).toEqual({ ok: false, code: "FORBIDDEN" });
    }
    expect(service.issueAdminLink).not.toHaveBeenCalled();
    expect(service.revokeAdminLink).not.toHaveBeenCalled();
  });

  it("maps repository exceptions without exposing the session", async () => {
    vi.mocked(service.issueAdminLink).mockRejectedValueOnce(new Error("Prisma session-canary"));
    expect(await boundary.issue(headers, "session-canary")).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
    expect(service.issueAdminLink).toHaveBeenCalledExactlyOnceWith("session-canary");
  });
});
