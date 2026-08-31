import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createAuthService, hashSessionToken } from "../../src/modules/auth/server/auth-service";
import { createFirstAdmin, resetAdminPassword } from "../../src/modules/auth/server/admin-operator";
import { hashPassword } from "../../src/modules/auth/server/password";
import { createAdminBoundary } from "../../src/server/admin/boundary";
import { createRateLimiter } from "../../src/server/public/security";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated test:postgres runner");
const db = createPrismaClient(url);
const other = createPrismaClient(url);
const auth = createAuthService(db),
  second = createAuthService(other);
const limit = createRateLimiter(db);
const boundary = createAdminBoundary({ auth, limit: (id) => limit("adminLogin", id) });
const h = new Headers({ origin: "https://salon.example" });
const input = { login: "test.admin", password: "isolated-test passphrase" };
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(input.password);
  vi.stubEnv("PUBLIC_ORIGIN", "https://salon.example");
});
beforeEach(async () => {
  await db.adminSession.deleteMany();
  await db.adminUser.deleteMany();
  await db.publicRateLimit.deleteMany();
  await db.adminUser.create({ data: { login: input.login, passwordHash } });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await other.$disconnect();
});

describe("аутентификация с настоящим PostgreSQL", () => {
  it("успех, новый непрозрачный токен и только hashes в БД", async () => {
    const first = await auth.login(input);
    const next = await second.login(input);
    expect(first && next && first.token !== next.token).toBe(true);
    if (!first) throw new Error("Expected test session");
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await auth.getAdmin(first.token))?.login).toBe(input.login);
    const sessions = await db.adminSession.findMany();
    expect(sessions).toHaveLength(2);
    expect(JSON.stringify(sessions)).not.toContain(first.token);
    expect(sessions.some((s) => s.tokenHash === hashSessionToken(first.token))).toBe(true);
    const user = await db.adminUser.findFirstOrThrow();
    expect(user.passwordHash).not.toContain(input.password);
    expect((first.expiresAt.getTime() - Date.now()) / 3600000).toBeGreaterThan(11.9);
  });
  it("неуспешный, неизвестный и неактивный пользователь имеют один ответ", async () => {
    const issue = vi.fn();
    const expected = { ok: false, code: "INVALID_CREDENTIALS" };
    expect(
      await boundary.login(h, { ...input, password: "incorrect-test passphrase" }, null, issue),
    ).toEqual(expected);
    expect(await boundary.login(h, { ...input, login: "unknown" }, null, issue)).toEqual(expected);
    await db.adminUser.updateMany({ data: { isActive: false } });
    expect(await boundary.login(h, input, null, issue)).toEqual(expected);
    expect(issue).not.toHaveBeenCalled();
    expect(await db.adminSession.count()).toBe(0);
  });
  it("5 ошибок блокируют на 15 минут; срок не продлевается; истечение сбрасывает счётчик", async () => {
    for (let i = 0; i < 5; i++)
      expect(await auth.login({ ...input, password: "incorrect-test passphrase" })).toBeNull();
    const locked = await db.adminUser.findFirstOrThrow();
    expect(locked.failedLoginAttempts).toBe(5);
    expect(locked.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60000);
    expect(await auth.login(input)).toBeNull();
    expect((await db.adminUser.findFirstOrThrow()).lockedUntil).toEqual(locked.lockedUntil);
    await db.adminUser.updateMany({ data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect(await auth.login({ ...input, password: "incorrect-test passphrase" })).toBeNull();
    expect(await db.adminUser.findFirst()).toMatchObject({
      failedLoginAttempts: 1,
      lockedUntil: null,
    });
    expect(await auth.login(input)).not.toBeNull();
    expect(await db.adminUser.findFirst()).toMatchObject({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  });
  it("параллельные ошибки двух процессов не теряются, блокировка насыщается", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? auth : second).login({ ...input, password: "incorrect-test passphrase" }),
      ),
    );
    expect(results.every((r) => r === null)).toBe(true);
    expect(await db.adminUser.findFirst()).toMatchObject({
      failedLoginAttempts: 5,
      lockedUntil: expect.any(Date),
    });
    expect(await second.login(input)).toBeNull();
  });
  it("PostgreSQL limiter общий между клиентами и новым экземпляром сервиса", async () => {
    const a = createRateLimiter(db),
      b = createRateLimiter(other);
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b)("adminLogin", "shared")),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await createRateLimiter(other)("adminLogin", "shared")).toBe(false);
    await db.publicRateLimit.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await a("adminLogin", "shared")).toBe(true);
    await db.publicRateLimit.update({ where: { key: "adminLogin:global" }, data: { hits: 60 } });
    expect(await b("adminLogin", "new-client")).toBe(false);
  });
  it.each(["expired", "revoked", "forged", "inactive"])(
    "сессия %s не получает закрытые данные",
    async (mode) => {
      const session = await auth.login(input);
      if (!session) throw new Error("Expected test session");
      if (mode === "expired")
        await db.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
      if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
      if (mode === "inactive") await db.adminUser.updateMany({ data: { isActive: false } });
      expect(await boundary.home(mode === "forged" ? "x".repeat(43) : session.token)).toEqual({
        ok: false,
        code: "UNAUTHORIZED",
      });
    },
  );
  it("выход отзывает только текущую сессию и запрещает повтор токена", async () => {
    const first = await auth.login(input),
      next = await auth.login(input);
    if (!first || !next) throw new Error("Expected test sessions");
    expect(await boundary.logout(h, first.token)).toEqual({ ok: true });
    expect(await second.getAdmin(first.token)).toBeNull();
    expect(await second.getAdmin(next.token)).not.toBeNull();
    expect(await boundary.logout(h, first.token)).toEqual({ ok: true });
    expect(await boundary.home(undefined)).toEqual({ ok: false, code: "UNAUTHORIZED" });
  });
  it("Origin проверяется и при входе, и при выходе; ответ не раскрывает секрет", async () => {
    const session = await auth.login(input);
    if (!session) throw new Error("Expected test session");
    const bad = new Headers({ origin: "https://evil.example", host: "evil.example" });
    expect(await boundary.logout(bad, session.token)).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(await auth.getAdmin(session.token)).not.toBeNull();
    expect(await boundary.login(bad, input, "//evil.example", vi.fn())).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    const issue = vi.fn();
    const result = await boundary.login(h, input, "//evil.example", issue);
    expect(result).toEqual({ ok: true, redirectTo: "/admin" });
    expect(JSON.stringify(result)).not.toContain(issue.mock.calls[0][0].token);
    expect(Object.keys(await boundary.home(session.token))).toEqual(["ok", "admin"]);
  });
});
describe("операторский CLI-сервис", () => {
  it("повтор создания не меняет существующий пароль, сессии или блокировку", async () => {
    await auth.login(input);
    const before = await db.adminUser.findMany();
    const sessions = await db.adminSession.findMany();
    await expect(
      createFirstAdmin(db, { ...input, password: "different-test passphrase" }),
    ).rejects.toThrow("уже существует");
    await expect(createFirstAdmin(db, { ...input, login: "another.admin" })).rejects.toThrow(
      "уже существует",
    );
    expect(await db.adminUser.findMany()).toEqual(before);
    expect(await db.adminSession.findMany()).toEqual(sessions);
  });
  it("параллельное первоначальное создание допускает только одного администратора", async () => {
    await db.adminUser.deleteMany();
    const results = await Promise.allSettled([
      createFirstAdmin(db, input),
      createFirstAdmin(other, { ...input, login: "another.admin" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.adminUser.count()).toBe(1);
  });
  it("сброс пароля отзывает все сессии, старый пароль не подходит, не создаёт неизвестного пользователя", async () => {
    const session = await auth.login(input);
    const another = await second.login(input);
    const changed = { ...input, password: "new-isolated passphrase" };
    await resetAdminPassword(db, changed);
    expect(await auth.getAdmin(session?.token)).toBeNull();
    expect(await second.getAdmin(another?.token)).toBeNull();
    expect(await auth.login(input)).toBeNull();
    expect(await auth.login(changed)).not.toBeNull();
    await expect(resetAdminPassword(db, { ...changed, login: "unknown" })).rejects.toThrow(
      "не найден",
    );
    expect(await db.adminUser.count()).toBe(1);
  });
  it("reset не активирует отключённый аккаунт", async () => {
    await db.adminUser.updateMany({ data: { isActive: false } });
    await resetAdminPassword(db, input);
    expect(await auth.login(input)).toBeNull();
  });
});
