import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createAdminBoundary } from "./boundary";
const h = new Headers({ origin: "https://salon.example", "sec-fetch-site": "same-origin" });
const credentials = { login: "admin", password: "test-only passphrase" };
const auth = { login: vi.fn(), getAdmin: vi.fn(), logout: vi.fn() };
const limit = vi.fn();
const issue = vi.fn();
const boundary = createAdminBoundary({ auth, limit });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PUBLIC_ORIGIN", "https://salon.example");
  vi.stubEnv("TRUST_PROXY_CLIENT_IP", "false");
  limit.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
describe("серверные границы администратора", () => {
  it("отклоняет Origin, отсутствующий Origin, Fetch-Site и подменённый Host", async () => {
    for (const headers of [
      new Headers(),
      new Headers({
        origin: "https://evil.example",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
      }),
      new Headers({ origin: "https://salon.example", "sec-fetch-site": "cross-site" }),
    ]) {
      expect(await boundary.login(headers, credentials, "/admin", issue)).toEqual({
        ok: false,
        code: "FORBIDDEN",
      });
      expect(await boundary.logout(headers, "token")).toEqual({ ok: false, code: "FORBIDDEN" });
    }
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });
  it("ограничивает ввод и частоту перед Argon2, игнорирует IP-заголовки", async () => {
    await boundary.login(h, { ...credentials, password: "x".repeat(129) }, null, issue);
    expect(auth.login).not.toHaveBeenCalled();
    limit.mockResolvedValue(false);
    const forged = new Headers(h);
    forged.set("x-forwarded-for", "8.8.8.8");
    forged.set("x-zaprosto-client-ip", "8.8.8.8");
    expect(await boundary.login(forged, credentials, null, issue)).toEqual({
      ok: false,
      code: "INVALID_CREDENTIALS",
    });
    expect(limit).toHaveBeenCalledWith("shared");
    expect(auth.login).not.toHaveBeenCalled();
  });
  it("секрет передаётся только установщику cookie, redirect безопасен", async () => {
    const session = { token: "private session token", expiresAt: new Date() };
    auth.login.mockResolvedValue(session);
    const result = await boundary.login(h, credentials, "//evil.example", issue);
    expect(result).toEqual({ ok: true, redirectTo: "/admin" });
    expect(issue).toHaveBeenCalledWith(session);
    expect(JSON.stringify(result)).not.toContain(session.token);
  });
  it("проверяет авторизацию непосредственно при каждом чтении", async () => {
    auth.getAdmin.mockResolvedValueOnce({ id: "one", login: "admin" }).mockResolvedValueOnce(null);
    expect((await boundary.home("same token")).ok).toBe(true);
    expect(await boundary.home("same token")).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(auth.getAdmin).toHaveBeenCalledTimes(2);
  });
  it("ошибки БД, limiter, cookie не раскрываются; выход при сбое не подтверждён", async () => {
    const error = new Error("password hash cookie Prisma secret");
    limit.mockRejectedValueOnce(error);
    expect(await boundary.login(h, credentials, null, issue)).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
    auth.getAdmin.mockRejectedValueOnce(error);
    expect(await boundary.home("secret")).toEqual({ ok: false, code: "UNAVAILABLE" });
    auth.logout.mockRejectedValueOnce(error);
    expect(await boundary.logout(h, "secret")).toEqual({ ok: false, code: "UNAVAILABLE" });
    auth.login.mockResolvedValue({ token: "secret", expiresAt: new Date() });
    issue.mockRejectedValueOnce(error);
    expect(await boundary.login(h, credentials, null, issue)).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
  });
});
