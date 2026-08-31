import { describe, expect, it } from "vitest";
import { credentialsSchema, safeReturnTo, sessionCookie } from "./policy";
describe("политика аутентификации", () => {
  it("ограничивает вход до хеширования, не обрезает пароль, нормализует логин", () => {
    const password = "  длинный пароль  ";
    expect(credentialsSchema.parse({ login: "Admin.Test", password })).toEqual({
      login: "admin.test",
      password,
    });
    for (const input of [
      { login: "a".repeat(65), password },
      { login: "admin", password: "short" },
      { login: "admin", password: "x".repeat(129) },
      { login: "admin", password, sessionId: "fixed" },
      { login: "../admin", password },
      { login: [], password },
      null,
    ])
      expect(credentialsSchema.safeParse(input).success).toBe(false);
  });
  it("HTTPS cookie с __Host; локальный HTTP только loopback", () => {
    expect(sessionCookie("https://salon.example")).toEqual({
      name: "__Host-zaprosto-admin",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(sessionCookie("http://localhost:3108").secure).toBe(false);
    expect(sessionCookie("http://127.0.0.1:3000").secure).toBe(false);
    for (const origin of [
      "http://salon.example",
      "https://salon.example/",
      "null",
      "ftp://salon.example",
      "http://localhost.evil",
    ])
      expect(() => sessionCookie(origin)).toThrow();
  });
  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "%2f%2fevil.example",
    "/admin/../evil",
    "/admin?next=https://evil.example",
    "/admin#secret",
    ["//evil"],
    null,
    "/admin",
  ])("возврат %s ограничен единственной реализованной страницей", (value) => {
    expect(safeReturnTo(value)).toBe("/admin");
  });
});
