import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  cookies: vi.fn(),
  headers: vi.fn(),
  state: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
  disconnect: vi.fn(),
}));
const requestHeaders = new Headers({
  origin: "https://salon.example",
  "sec-fetch-site": "same-origin",
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("../../modules/auth/policy", () => ({
  sessionCookie: () => ({ name: "__Host-test-admin" }),
}));
vi.mock("../../server/admin/telegram", () => ({
  adminTelegram: {
    state: mocks.state,
    issue: mocks.issue,
    revoke: mocks.revoke,
    disconnect: mocks.disconnect,
  },
}));

import {
  disconnectAdminTelegramAction,
  getAdminTelegramStateAction,
  issueAdminTelegramLinkAction,
  revokeAdminTelegramLinkAction,
} from "./notifications-actions";

const token = "s".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: mocks.cookieGet });
  mocks.headers.mockResolvedValue(requestHeaders);
  mocks.cookieGet.mockReturnValue({ value: token });
  mocks.state.mockResolvedValue({ ok: true, state: "AVAILABLE" });
  mocks.issue.mockResolvedValue({ ok: false, code: "TELEGRAM_NOT_READY" });
  mocks.revoke.mockResolvedValue({ ok: true });
  mocks.disconnect.mockResolvedValue({ ok: true, alreadyDisconnected: false });
});

describe("admin Telegram Server Actions", () => {
  it("has no browser-supplied session or admin id parameters", () => {
    expect(getAdminTelegramStateAction.length).toBe(0);
    expect(issueAdminTelegramLinkAction.length).toBe(0);
    expect(revokeAdminTelegramLinkAction.length).toBe(0);
    expect(disconnectAdminTelegramAction.length).toBe(0);
  });

  it("reads the HttpOnly session cookie inside every action", async () => {
    await expect(getAdminTelegramStateAction()).resolves.toEqual({
      ok: true,
      state: "AVAILABLE",
    });
    await issueAdminTelegramLinkAction();
    await revokeAdminTelegramLinkAction();
    await disconnectAdminTelegramAction();

    expect(mocks.cookies).toHaveBeenCalledTimes(4);
    expect(mocks.cookieGet).toHaveBeenCalledTimes(4);
    expect(mocks.cookieGet).toHaveBeenCalledWith("__Host-test-admin");
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(token);
    expect(mocks.issue).toHaveBeenCalledExactlyOnceWith(requestHeaders, token);
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(requestHeaders, token);
    expect(mocks.disconnect).toHaveBeenCalledExactlyOnceWith(requestHeaders, token);
  });

  it("normalizes unknown action failures without serializing session details", async () => {
    mocks.issue.mockRejectedValueOnce(new Error("DATABASE_SESSION_CANARY"));
    const result = await issueAdminTelegramLinkAction();
    expect(result).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });
});
