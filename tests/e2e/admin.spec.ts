import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { expect, test, type Page, type Request } from "@playwright/test";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { hashPassword } from "../../src/modules/auth/server/password";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated E2E runner");
const db = createPrismaClient(url);
const credentials = { login: "e2e.admin", password: randomBytes(24).toString("base64url") };
const origin = "http://localhost:3108";
const cookieName = "zaprosto-admin-local";
let passwordHash: string;
test.beforeAll(async () => {
  passwordHash = await hashPassword(credentials.password);
});
test.beforeEach(async () => {
  await db.adminSession.deleteMany();
  await db.adminUser.deleteMany();
  await db.publicRateLimit.deleteMany();
  await db.adminUser.create({ data: { login: credentials.login, passwordHash } });
});
test.afterAll(async () => {
  await db.$disconnect();
});
async function fill(page: Page, login = credentials.login, password = credentials.password) {
  await page.goto("/admin/login");
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
}
async function login(page: Page) {
  await fill(page);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Вы вошли" })).toBeVisible();
}
function actionHeaders(request: Request, suppliedOrigin = origin) {
  return {
    "next-action": request.headers()["next-action"],
    "content-type": request.headers()["content-type"],
    origin: suppliedOrigin,
  };
}
test("анонимный HTML/RSC не получает закрытые данные; форма и CSP", async ({ page, request }) => {
  for (const headers of [{}, { rsc: "1" }] as Record<string, string>[]) {
    const response = await request.get("/admin", { headers });
    expect(await response.text()).not.toContain(credentials.login);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByLabel("Логин", { exact: true })).toHaveAttribute(
    "autocomplete",
    "username",
  );
  await expect(page.getByLabel("Пароль", { exact: true })).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  const response = await request.get("/admin/login");
  expect(response.headers()["content-security-policy"]).toContain("'strict-dynamic'");
  expect(response.headers()["content-security-policy"]).not.toContain("'unsafe-eval'");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});
test("вход, HttpOnly cookie, отсутствие секретов, выход и replay старого токена", async ({
  page,
  context,
  request,
}) => {
  const actions: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) actions.push(r);
  });
  await login(page);
  const cookie = (await context.cookies()).find((c) => c.name === cookieName)!;
  expect(Boolean(cookie)).toBe(true);
  expect({
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    path: cookie.path,
    secure: cookie.secure,
  }).toEqual({ httpOnly: true, sameSite: "Lax", path: "/", secure: false });
  expect(await page.evaluate(() => document.cookie)).not.toContain(cookieName);
  const storage = await page.evaluate(() =>
    JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
  );
  expect(storage.includes(cookie.value)).toBe(false);
  expect(storage.includes(credentials.password)).toBe(false);
  const privateResponse = await request.get("/admin");
  const body = await privateResponse.text();
  expect(
    body.includes(cookie.value) ||
      body.includes(passwordHash) ||
      body.includes(credentials.password),
  ).toBe(false);
  expect(privateResponse.headers()["cache-control"]).toContain("no-store");
  const row = await db.adminSession.findFirstOrThrow();
  expect(row.tokenHash === hashSessionToken(cookie.value)).toBe(true);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect((await context.cookies()).some((c) => c.name === cookieName)).toBe(false);
  expect((await db.adminSession.findFirstOrThrow()).revokedAt).not.toBeNull();
  const replay = await request.get("/admin", {
    headers: { cookie: cookieName + "=" + cookie.value },
    maxRedirects: 0,
  });
  expect(await replay.text()).not.toContain(credentials.login);
  expect(replay.status()).toBe(307);
  // Direct invocation of the logout action remains idempotent, never resurrects a session.
  const logout = actions.at(-1)!;
  await request.post("/admin", {
    headers: { ...actionHeaders(logout), cookie: cookieName + "=" + cookie.value },
    data: logout.postData()!,
  });
  expect((await db.adminSession.findFirstOrThrow()).revokedAt).not.toBeNull();
});
test("ошибка, неизвестный и неактивный логин неразличимы", async ({ page }) => {
  let message = "";
  for (const variant of ["wrong", "unknown", "inactive"]) {
    if (variant === "inactive") await db.adminUser.updateMany({ data: { isActive: false } });
    await fill(
      page,
      variant === "unknown" ? "unknown.admin" : credentials.login,
      variant === "wrong" ? "wrong-test passphrase" : credentials.password,
    );
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: /\S/ });
    await expect(alert).toBeVisible();
    const text = await alert.innerText();
    if (message) expect(text).toBe(message);
    else message = text;
    await expect(page.getByLabel("Пароль", { exact: true })).toHaveValue("");
  }
  expect(await db.adminSession.count()).toBe(0);
});
test("блокировка и завершение её срока", async ({ page }) => {
  await db.adminUser.updateMany({ data: { failedLoginAttempts: 4 } });
  await fill(page, credentials.login, "wrong-test passphrase");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
  expect((await db.adminUser.findFirstOrThrow()).lockedUntil).not.toBeNull();
  await fill(page);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
  expect(await db.adminSession.count()).toBe(0);
  await db.adminUser.updateMany({ data: { lockedUntil: new Date(Date.now() - 1000) } });
  await login(page);
});
for (const mode of ["expired", "revoked", "inactive", "forged"]) {
  test("ранее выданная сессия: " + mode, async ({ page, context }) => {
    await login(page);
    if (mode === "expired")
      await db.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    if (mode === "inactive") await db.adminUser.updateMany({ data: { isActive: false } });
    if (mode === "forged")
      await context.addCookies([
        { name: cookieName, value: randomBytes(32).toString("base64url"), url: origin },
      ]);
    await page.reload();
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByText(credentials.login, { exact: true })).toHaveCount(0);
  });
}
test("прямой вызов login: Origin, предел ввода и внешние returnTo", async ({ page, request }) => {
  const pending = page.waitForRequest(
    (r) => r.method() === "POST" && Boolean(r.headers()["next-action"]),
  );
  await login(page);
  const action = await pending;
  const before = await db.adminSession.count();
  const bad = await request.post("/admin/login", {
    headers: actionHeaders(action, "https://evil.example"),
    data: action.postData()!,
  });
  expect(bad.status()).toBeGreaterThanOrEqual(400);
  expect(await db.adminSession.count()).toBe(before);
  const oversized = await request.post("/admin/login", {
    headers: actionHeaders(action),
    data: JSON.stringify([{ ...credentials, password: "a".repeat(129) }, "/admin"]),
  });
  expect(await oversized.text()).toContain("INVALID_CREDENTIALS");
  expect(await db.adminSession.count()).toBe(before);
  const response = await request.post("/admin/login", {
    headers: actionHeaders(action),
    data: JSON.stringify([credentials, "//evil.example"]),
  });
  const text = await response.text();
  expect(text).toContain("redirectTo");
  expect(text).not.toContain("evil.example");
  expect(text.includes(credentials.password) || text.includes(passwordHash)).toBe(false);
  const setCookie = response.headers()["set-cookie"];
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=lax");
  expect(await db.adminSession.count()).toBe(before + 1);
});
test("logout отклоняет чужой Origin до отзыва", async ({ page, request }) => {
  await login(page);
  let action: Request | undefined;
  await page.route("**/admin", async (route) => {
    if (route.request().method() === "POST") {
      action = route.request();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText(
    "Выход не подтверждён",
  );
  if (!action) throw new Error("Missing action request");
  const response = await request.post("/admin", {
    headers: actionHeaders(action, "https://evil.example"),
    data: action.postData()!,
  });
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect((await db.adminSession.findFirstOrThrow()).revokedAt).toBeNull();
  await page.unroute("**/admin");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
});
test("360/390/1440: клавиатура, skip-link, ожидание и отсутствие переполнения", async ({
  page,
}, info) => {
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/login?returnTo=https://evil.example");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "К содержимому", exact: true })).toBeFocused();
    const original = page.url();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    expect(page.url()).toBe(original);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Логин", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Пароль", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath("admin-login-" + width + ".png"),
      fullPage: true,
    });
  }
  await fill(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/login", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Входим…" })).toBeDisabled();
  release();
  await expect(page).toHaveURL(origin + "/admin");
  await page.unroute("**/admin/login");
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath("admin-home-" + width + ".png"),
      fullPage: true,
    });
  }
});
test("CLI отклоняет pipe/аргументы, ничего не меняя", async () => {
  const before = await db.adminUser.findMany();
  for (const args of [["create"], ["create", "--password", "test-not-a-real-secret"]]) {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/admin.ts", ...args], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
        windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (data) => {
        output += data.toString();
      });
      child.stderr.on("data", (data) => {
        output += data.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, output }));
      child.stdin.end("never echo this input");
    });
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("never echo");
    expect(result.output).not.toContain("test-not-a-real-secret");
  }
  expect(await db.adminUser.findMany()).toEqual(before);
});
