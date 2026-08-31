import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { hashPassword } from "../../src/modules/auth/server/password";
import { seedDemo, demoMasterIds } from "../../scripts/demo-data";
import type { BookingPayload } from "../../src/modules/booking/client/attempt-storage";
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/zaprosto_test_[a-f0-9]+$/.test(new URL(url).pathname))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url);
const credentials = { login: "settings.e2e", password: randomBytes(24).toString("base64url") };
const storageKey = "zaprosto.booking.v1";
let passwordHash: string;
async function clear() {
  await db.appointment.deleteMany();
  await db.bookingRequest.deleteMany();
  await db.master.deleteMany();
  await db.service.deleteMany();
  await db.adminSession.deleteMany();
  await db.adminUser.deleteMany();
  await db.publicRateLimit.deleteMany();
}
test.beforeAll(async () => {
  passwordHash = await hashPassword(credentials.password);
});
test.beforeEach(async () => {
  await clear();
  await seedDemo(db);
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  await db.adminUser.create({ data: { login: credentials.login, passwordHash } });
});
test.afterAll(async () => {
  await clear();
  await seedDemo(db);
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  await db.$disconnect();
});
async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Логин", { exact: true }).fill(credentials.login);
  await page.getByLabel("Пароль", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Вы вошли" })).toBeVisible();
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
}
const horizon = (page: Page) => page.getByLabel("Горизонт бронирования, дней");
const zone = (page: Page) => page.getByLabel("Часовой пояс бизнеса", { exact: true });
const save = (page: Page) => page.getByRole("button", { name: "Сохранить настройки", exact: true });
async function change(page: Page, timezone = "Europe/Berlin", days = "30") {
  await zone(page).fill(timezone);
  await horizon(page).fill(days);
  if (await page.getByLabel("Подтверждаю смену зоны и понимаю последствия").count())
    await page.getByLabel("Подтверждаю смену зоны и понимаю последствия").check();
  await save(page).click();
  await expect(
    page.getByText("Настройки сохранены. Новые расчёты используют эти значения.", { exact: true }),
  ).toBeVisible();
}
async function review(page: Page, any = false, dateIndex = 2) {
  await page.goto("/");
  await page.getByRole("button", { name: /Мужская стрижка/ }).click();
  await page.getByRole("button", { name: "Выбрать мастера →" }).click();
  await page.getByRole("button", { name: any ? /Любой мастер/ : /Алексей · демо/ }).click();
  await page.getByRole("button", { name: "Выбрать время →" }).click();
  await page.getByLabel("Дата визита").selectOption({ index: dateIndex });
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить →" }).click();
  await page.getByLabel("Ваше имя").fill("Тест Клиент");
  await page.getByLabel("Номер телефона").fill("+79990000000");
  await page.getByRole("button", { name: "Проверить запись →" }).click();
}
async function confirmAgain(page: Page) {
  await expect(page.getByRole("button", { name: "Продолжить →" })).toBeDisabled();
  await page.getByLabel("Дата визита").selectOption({ index: 2 });
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить →" }).click();
  await expect(page.getByLabel("Ваше имя")).toHaveValue("Тест Клиент");
  await expect(page.getByLabel("Номер телефона")).toHaveValue("+79990000000");
  await page.getByRole("button", { name: "Проверить запись →" }).click();
  expect(await db.appointment.count()).toBe(0);
  await page.getByRole("button", { name: "Подтвердить обновлённые условия", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
}
test("текущие значения, явное сохранение, ошибки, клавиатура, mobile/desktop", async ({
  page,
}, info) => {
  await db.businessSettings.update({
    where: { id: 1 },
    data: { timezone: "Asia/Kathmandu", bookingHorizonDays: 14 },
  });
  await page.setViewportSize({ width: 360, height: 900 });
  await login(page);
  await expect(horizon(page)).toHaveValue("14");
  await expect(zone(page)).toHaveValue("Asia/Kathmandu");
  await horizon(page).fill("");
  await save(page).click();
  await expect(horizon(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".catalog-status")).toBeFocused();
  await horizon(page).fill("7");
  await zone(page).fill("Europe/Berlin");
  await expect(save(page)).toBeDisabled();
  await expect(page.locator(".settings-warning")).toContainText("Asia/Kathmandu");
  await expect(page.locator(".settings-warning")).toContainText("Europe/Berlin");
  expect(
    (await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } })).bookingHorizonDays,
  ).toBe(14);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("settings-" + width + ".png"), fullPage: true });
  }
  await page.getByLabel("Подтверждаю смену зоны и понимаю последствия").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(save(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Настройки сохранены\./)).toBeVisible();
  await expect(page.locator(".catalog-status")).toBeFocused();
  await page.reload();
  await expect(horizon(page)).toHaveValue("7");
  await expect(zone(page)).toHaveValue("Europe/Berlin");
});
test("две формы: конфликт сохраняет черновик и не подставляет версию", async ({ page }) => {
  await login(page);
  const other = await page.context().newPage();
  await other.goto("/admin/settings");
  await horizon(other).fill("90");
  await change(page, "Europe/Moscow", "7");
  await save(other).click();
  await expect(other.getByText(/Настройки уже изменились/)).toBeVisible();
  await expect(horizon(other)).toHaveValue("90");
  await expect(save(other)).toBeDisabled();
  await expect(
    other.getByRole("link", { name: "Проверить актуальные настройки (новая вкладка)" }),
  ).toBeVisible();
  expect(
    (await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } })).bookingHorizonDays,
  ).toBe(7);
});
test("потеря реального успешного ответа: ожидание, черновик, без успеха и автоповтора", async ({
  page,
}) => {
  await login(page);
  await horizon(page).fill("7");
  let posts = 0,
    release!: () => void,
    reached!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      reached = r;
    });
  await page.route("**/admin/settings", async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      reached();
      await gate;
      await route.abort("failed");
    } else await route.continue();
  });
  await save(page).click();
  await ready;
  await expect(page.getByText("Сохраняем настройки…")).toBeVisible();
  await expect(horizon(page)).toBeDisabled();
  release();
  await expect(page.getByText(/Сохранение не подтверждено/)).toBeVisible();
  await expect(horizon(page)).toHaveValue("7");
  await expect(save(page)).toBeDisabled();
  await expect(page.getByText(/Настройки сохранены\./)).toHaveCount(0);
  expect(posts).toBe(1);
  expect((await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } })).version).toBe(1);
  const fresh = await page.context().newPage();
  await fresh.goto("/admin/settings");
  await expect(horizon(fresh)).toHaveValue("7");
  expect(posts).toBe(1);
});
for (const mode of ["missing", "expired", "revoked", "disabled"] as const)
  test("прямая Server Action и GET после " + mode, async ({ page }) => {
    await login(page);
    const captured = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith("/admin/settings"),
    );
    await save(page).click();
    const request = await captured;
    await expect(page.getByText(/Настройки сохранены\./)).toBeVisible();
    const headers = {
      "content-type": "text/plain;charset=UTF-8",
      "next-action": request.headers()["next-action"],
      origin: "http://localhost:3108",
      ...(mode === "missing" ? { cookie: "" } : {}),
    };
    if (mode === "expired") await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
    const before = await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } });
    const response = await page.request.post("/admin/settings", {
      headers,
      data: JSON.stringify([
        {
          version: before.version,
          timezone: "Europe/Moscow",
          bookingHorizonDays: "7",
          confirmedTimezoneChange: false,
        },
      ]),
    });
    expect(await response.text()).toContain("UNAUTHORIZED");
    const get = await page.request.get("/admin/settings", {
      headers: mode === "missing" ? { cookie: "" } : {},
    });
    expect(get.url()).toContain("/admin/login");
    expect(await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
  });
test("прямая Action: Origin, лишние поля, подтверждение зоны, GET без записи и no-store/CSP", async ({
  page,
}) => {
  await login(page);
  const captured = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/admin/settings"),
  );
  await save(page).click();
  const req = await captured;
  await expect(page.getByText(/Настройки сохранены\./)).toBeVisible();
  const before = await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } });
  const headers = {
    "content-type": "text/plain;charset=UTF-8",
    "next-action": req.headers()["next-action"],
    origin: "http://localhost:3108",
  };
  const input = {
    version: before.version,
    timezone: "Europe/Berlin",
    bookingHorizonDays: "7",
    confirmedTimezoneChange: false,
  };
  const confirmation = await page.request.post("/admin/settings", {
    headers,
    data: JSON.stringify([input]),
  });
  expect(await confirmation.text()).toContain("CONFIRMATION_REQUIRED");
  for (const extra of [
    { id: 2 },
    { bookingHorizonDays: "7.5" },
    { timezone: "+03:00" },
    { timezone: "" },
  ]) {
    const response = await page.request.post("/admin/settings", {
      headers,
      data: JSON.stringify([{ ...input, ...extra }]),
    });
    expect(await response.text()).toContain("INVALID_INPUT");
  }
  const foreign = await page.request.post("/admin/settings", {
    headers: { ...headers, origin: "https://evil.example" },
    data: JSON.stringify([{ ...input, confirmedTimezoneChange: true }]),
  });
  expect(foreign.ok()).toBe(false);
  const get = await page.request.get("/admin/settings?bookingHorizonDays=7");
  expect(get.headers()["cache-control"]).toContain("no-store");
  expect(get.headers()["content-security-policy"]).toContain("nonce-");
  expect(await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
});
for (const mode of ["week", "exception", "delete"] as const)
  test("старая форма расписания: " + mode, async ({ page }) => {
    await login(page);
    const row = await db.scheduleException.create({
      data: {
        masterId: demoMasterIds[0],
        localDate: new Date("2026-10-05T00:00Z"),
        type: "DAY_OFF",
      },
    });
    await page.goto("/admin/schedule?masterId=" + demoMasterIds[0] + "&month=2026-10");
    if (mode === "week")
      await page
        .getByRole("group", { name: "Понедельник", exact: true })
        .locator("input")
        .first()
        .fill("11:07");
    if (mode === "exception") {
      await page.getByRole("button", { name: "Изменить исключение 2026-10-05" }).click();
      await page.getByLabel("Дата исключения").fill("2026-10-06");
    }
    if (mode === "delete") {
      await page.getByRole("button", { name: "Удалить исключение 2026-10-05" }).click();
      await page.getByLabel("Подтверждаю возврат к недельному графику").check();
    }
    const admin = await page.context().newPage();
    await admin.goto("/admin/settings");
    await change(admin);
    const button = page.getByRole("button", {
      name:
        mode === "week"
          ? "Сохранить неделю"
          : mode === "exception"
            ? "Сохранить исключение"
            : "Удалить и вернуть недельный график",
      exact: true,
    });
    await button.click();
    await expect(page.getByText(/Данные изменились/)).toBeVisible();
    await expect(button).toBeDisabled();
    if (mode === "week")
      await expect(
        page.getByRole("group", { name: "Понедельник", exact: true }).locator("input").first(),
      ).toHaveValue("11:07");
    if (mode === "exception")
      await expect(page.getByLabel("Дата исключения")).toHaveValue("2026-10-06");
    expect(await db.scheduleException.findUnique({ where: { id: row.id } })).toEqual(row);
  });
for (const any of [false, true])
  for (const shrink of [false, true])
    test("старая клиентская форма ANY=" + any + " сокращение=" + shrink, async ({ page }) => {
      await review(page, any, shrink ? 20 : 2);
      const sent: BookingPayload[] = [];
      page.on("request", (req) => {
        if (req.method() === "POST" && req.postData()?.includes("clientPhone"))
          sent.push(JSON.parse(req.postData()!)[0]);
      });
      const admin = await page.context().newPage();
      await login(admin);
      await change(admin, shrink ? "Europe/Moscow" : "Europe/Berlin", shrink ? "7" : "30");
      await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
      await expect(page.getByText(/Настройки времени изменились/)).toBeVisible();
      await expect(page.getByLabel("Дата визита").locator("option")).toHaveCount(shrink ? 7 : 30);
      await expect(page.locator(".booking-main")).toContainText(
        shrink ? "Europe/Moscow" : "Europe/Berlin",
      );
      expect(sent).toHaveLength(1);
      expect(await db.bookingRequest.count()).toBe(0);
      await confirmAgain(page);
      expect(sent).toHaveLength(2);
      expect(sent[1].expectedBusinessContext).not.toBe(sent[0].expectedBusinessContext);
      expect(sent[1].idempotencyKey).not.toBe(sent[0].idempotencyKey);
      expect(await db.appointment.count()).toBe(1);
    });
test("запоздавшая доступность не возвращает старую зону и горизонт", async ({ page }) => {
  await review(page);
  await page.getByRole("button", { name: /Дата и время/ }).click();
  let release!: () => void,
    reached!: () => void,
    held = false;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      reached = r;
    });
  await page.route("**/api/availability?**", async (route) => {
    if (!held) {
      held = true;
      const response = await route.fetch();
      reached();
      await gate;
      try {
        await route.fulfill({ response });
      } catch {}
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await ready;
  const admin = await page.context().newPage();
  await login(admin);
  await change(admin, "Europe/Berlin", "7");
  await page.getByLabel("Дата визита").selectOption({ index: 3 });
  await expect(page.getByText(/Настройки времени изменились/)).toBeVisible();
  await expect(page.getByRole("button", { name: "10:00", exact: true })).toBeVisible();
  release();
  await expect(page.getByLabel("Дата визита").locator("option")).toHaveCount(7);
  await expect(page.locator(".booking-main")).toContainText("Europe/Berlin");
  await confirmAgain(page);
});
for (const version of [1, 2, 3])
  test(
    "потерянный успешный ответ booking-v" + version + ": смена настроек, reload и исходный replay",
    async ({ page }) => {
      await review(page);
      let lost = false;
      const sent: BookingPayload[] = [];
      await page.route("**/*", async (route) => {
        if (
          route.request().method() === "POST" &&
          route.request().postData()?.includes("clientPhone")
        ) {
          sent.push(JSON.parse(route.request().postData()!)[0]);
          if (!lost) {
            lost = true;
            await route.fetch();
            await route.abort("failed");
            return;
          }
        }
        await route.continue();
      });
      await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
      await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
      const pending = await page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key)!),
        storageKey,
      );
      const input = pending.input as BookingPayload;
      if (version < 3) {
        delete input.expectedBusinessContext;
        if (version === 1) delete input.expectedServiceTerms;
        const hash = createHash("sha256")
          .update(
            JSON.stringify([
              "booking-v" + version,
              input.serviceId,
              input.master.type,
              input.master.type === "SPECIFIC" ? input.master.masterId : null,
              input.localDate,
              new Date(input.startsAt).toISOString(),
              input.clientName,
              input.clientPhone,
              ...(version === 2 ? [input.expectedServiceTerms] : []),
            ]),
          )
          .digest("hex");
        // Historical fixture only: emulate an already committed old release, independently of v3.
        await db.bookingRequest.updateMany({ data: { requestHash: hash } });
        await page.evaluate(
          ({ key, pending }) => sessionStorage.setItem(key, JSON.stringify(pending)),
          { key: storageKey, pending },
        );
      }
      const before = await db.appointment.findFirstOrThrow({
        include: { statusHistory: true, bookingRequest: true },
      });
      const admin = await page.context().newPage();
      await login(admin);
      await change(admin, "America/New_York", "7");
      await page.reload();
      await page.getByRole("button", { name: "Повторить исходный запрос" }).click();
      await expect(page.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(input);
      expect(
        await db.appointment.findFirstOrThrow({
          include: { statusHistory: true, bookingRequest: true },
        }),
      ).toEqual(before);
      const href = await page
        .getByRole("link", { name: "Открыть мою запись ↗" })
        .getAttribute("href");
      expect(href).toBe("/appointment#" + input.cancellationToken);
      await page.goto(href!);
      await expect(page.getByText("Запланирована", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Отменить запись", exact: true }).click();
      await page.getByLabel("Я хочу отменить эту запись").check();
      await page.getByRole("button", { name: "Да, отменить запись" }).click();
      await expect(page.getByText("Отменена", { exact: true })).toBeVisible();
    },
  );
test("неизвестный исход до COMMIT не создаёт новую пару после смены настроек", async ({ page }) => {
  await review(page);
  let creates = 0;
  await page.route("**/*", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postData()?.includes("clientPhone")
    ) {
      creates++;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
  const saved = await page.evaluate((key) => sessionStorage.getItem(key), storageKey);
  const admin = await page.context().newPage();
  await login(admin);
  await change(admin);
  await page.reload();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(saved);
  expect(creates).toBe(1);
  expect(await db.appointment.count()).toBe(0);
  await page.unroute("**/*");
  await page.getByRole("button", { name: "Повторить исходный запрос" }).click();
  await expect(page.getByText(/Настройки времени изменились/)).toBeVisible();
  expect(await db.appointment.count()).toBe(0);
  await confirmAgain(page);
});
