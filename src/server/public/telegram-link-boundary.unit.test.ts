import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramLinkOperations } from "../../modules/telegram/server/link-service";
import type { AppointmentTelegramOperations } from "../../modules/telegram/server/appointment-connection-service";
import { createPublicTelegramLinkBoundary } from "./telegram-link-boundary";

const headers = new Headers({ origin: "https://salon.example", "sec-fetch-site": "same-origin" });
const service: TelegramLinkOperations = {
  issueAppointmentLink: vi.fn(),
  revokeAppointmentLink: vi.fn(),
  issueAdminLink: vi.fn(),
  revokeAdminLink: vi.fn(),
};
const appointments: AppointmentTelegramOperations = {
  getState: vi.fn(),
  disconnect: vi.fn(),
};
const boundary = createPublicTelegramLinkBoundary(service, appointments);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PUBLIC_ORIGIN", "https://salon.example");
});
afterEach(() => vi.unstubAllEnvs());

describe("public Telegram link boundary", () => {
  it("requires exact same-origin headers before either mutation", async () => {
    for (const value of [
      new Headers(),
      new Headers({ origin: "https://evil.example" }),
      new Headers({ origin: "https://salon.example", "sec-fetch-site": "cross-site" }),
    ]) {
      expect(await boundary.issue(value, "secret")).toEqual({ ok: false, code: "FORBIDDEN" });
      expect(await boundary.revoke(value, "secret")).toEqual({ ok: false, code: "FORBIDDEN" });
      expect(await boundary.disconnect(value, "secret")).toEqual({
        ok: false,
        code: "FORBIDDEN",
      });
    }
    expect(service.issueAppointmentLink).not.toHaveBeenCalled();
    expect(service.revokeAppointmentLink).not.toHaveBeenCalled();
    expect(appointments.disconnect).not.toHaveBeenCalled();
  });

  it("passes only the cancellation token and maps exceptions to safe UNAVAILABLE", async () => {
    vi.mocked(service.issueAppointmentLink).mockResolvedValueOnce({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await boundary.issue(headers, "cancellation-canary")).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    vi.mocked(service.revokeAppointmentLink).mockRejectedValueOnce(
      new Error("Prisma cancellation-canary"),
    );
    expect(await boundary.revoke(headers, "cancellation-canary")).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
  });

  it("reads without consuming a mutation guard and normalizes read/disconnect exceptions", async () => {
    vi.mocked(appointments.getState).mockResolvedValueOnce({ ok: true, state: "CONNECTED" });
    expect(await boundary.state("cancellation-canary")).toEqual({
      ok: true,
      state: "CONNECTED",
    });
    expect(appointments.getState).toHaveBeenCalledWith("cancellation-canary");

    vi.mocked(appointments.getState).mockRejectedValueOnce(new Error("DATABASE_CREDENTIAL_CANARY"));
    expect(await boundary.state("cancellation-canary")).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });

    vi.mocked(appointments.disconnect).mockRejectedValueOnce(
      new Error("Prisma cancellation-canary"),
    );
    const result = await boundary.disconnect(headers, "cancellation-canary");
    expect(result).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("canary");
  });
});
