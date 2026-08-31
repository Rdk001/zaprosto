import { randomBytes } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { hashPassword } from "../../src/modules/auth/server/password";
import { seedDemo } from "../../scripts/demo-data";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url);
const credentials = { login: "catalog.e2e", password: randomBytes(24).toString("base64url") };
let passwordHash: string;
const origin = "http://localhost:3108";
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
  await db.adminUser.create({ data: { login: credentials.login, passwordHash } });
  const a = await db.service.create({
    data: { name: "Тестовая стрижка", priceKopecks: 150050, durationMinutes: 35, displayOrder: 0 },
  });
  await db.service.create({
    data: { name: "Тестовая борода", priceKopecks: 90000, durationMinutes: 20, displayOrder: 1 },
  });
  const inactive = await db.service.create({
    data: {
      name: "Неактивная услуга",
      priceKopecks: 10000,
      durationMinutes: 10,
      isActive: false,
      displayOrder: 2,
    },
  });
  for (const [index, name] of ["Тестовый мастер", "Второй мастер"].entries()) {
    await db.master.create({
      data: {
        name,
        displayOrder: index,
        services: { create: [{ serviceId: a.id }, { serviceId: inactive.id }] },
        weeklyWorkIntervals: {
          create: Array.from({ length: 7 }, (_, i) => ({
            dayOfWeek: i + 1,
            startsAt: new Date("1970-01-01T09:00:00Z"),
            endsAt: new Date("1970-01-01T18:00:00Z"),
          })),
        },
      },
    });
  }
});
test.afterAll(async () => {
  await clear();
  await seedDemo(db);
  await db.$disconnect();
});
async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Логин", { exact: true }).fill(credentials.login);
  await page.getByLabel("Пароль", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Вы вошли" })).toBeVisible();
}
async function services(page: Page) {
  await login(page);
  await page.getByRole("link", { name: "Услуги", exact: true }).click();
}
async function fillService(page: Page, name = "Новая услуга") {
  await page.getByRole("button", { name: "Добавить услугу" }).click();
  await page.getByLabel("Название", { exact: true }).fill(name);
  await page.getByLabel("Цена, ₽", { exact: true }).fill("12,34");
  await page.getByLabel("Длительность, минут", { exact: true }).fill("37");
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Сохранено. Каталог обновлён.", { exact: true })).toBeVisible();
}
test("услуга: создание, точная цена, ошибки, редактирование и HTML как текст", async ({
  page,
  context,
}) => {
  await services(page);
  await fillService(page, "<b>Обычный текст</b>");
  await page.getByLabel("Цена, ₽", { exact: true }).fill("0.001");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByLabel("Цена, ₽", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("<b>Обычный текст</b>");
  await page.getByLabel("Цена, ₽", { exact: true }).fill("12,34");
  await save(page);
  const row = await db.service.findFirstOrThrow({ where: { name: "<b>Обычный текст</b>" } });
  expect(row.priceKopecks).toBe(1234);
  expect(row.durationMinutes).toBe(37);
  await expect(
    page.getByRole("heading", { name: "<b>Обычный текст</b>", exact: true }),
  ).toBeVisible();
  expect(await page.locator(".catalog-list h2 b").count()).toBe(0);
  await page
    .getByRole("button", { name: "Редактировать: <b>Обычный текст</b>", exact: true })
    .click();
  await page.getByLabel("Название", { exact: true }).fill("Обновлённая услуга");
  await save(page);
  const publicPage = await context.newPage();
  await publicPage.goto("/");
  await expect(publicPage.getByRole("button", { name: /Обновлённая услуга/ })).toBeVisible();
  await publicPage.close();
});
test("мастер: несколько назначений, неактивные, пустой список и отсутствие графика", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "Мастера", exact: true }).click();
  await page.getByRole("button", { name: "Добавить мастера" }).click();
  await expect(page.getByText(/Свободные окна появятся после настройки расписания/)).toBeVisible();
  await page.getByLabel("Имя", { exact: true }).fill("Новый мастер");
  await page.getByLabel("Описание", { exact: true }).fill("<img src=x onerror=alert(1)>");
  await page.getByLabel("Тестовая стрижка", { exact: true }).check();
  await page.getByLabel("Тестовая борода", { exact: true }).check();
  await save(page);
  const master = await db.master.findFirstOrThrow({
    where: { name: "Новый мастер" },
    include: { services: true, weeklyWorkIntervals: true },
  });
  expect(master.services).toHaveLength(2);
  expect(master.weeklyWorkIntervals).toHaveLength(0);
  expect(await page.locator(".catalog-description img").count()).toBe(0);
  await page.getByRole("button", { name: "Редактировать: Новый мастер", exact: true }).click();
  await page.getByLabel("Тестовая стрижка", { exact: true }).uncheck();
  await page.getByLabel("Тестовая борода", { exact: true }).uncheck();
  await save(page);
  await expect(
    page.getByText("Нет назначенных услуг — онлайн-запись недоступна.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Редактировать: Тестовый мастер", exact: true }).click();
  await expect(page.getByLabel(/Неактивная услуга/)).toBeChecked();
  await page.getByLabel("Активен", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Подтвердите деактивацию ниже.")).toBeVisible();
  await page.getByLabel("Подтверждаю деактивацию").check();
  await save(page);
  await page.getByRole("button", { name: "Редактировать: Тестовый мастер", exact: true }).click();
  await expect(page.getByLabel(/Неактивная услуга/)).toBeChecked();
  await page.getByLabel("Активен", { exact: true }).check();
  await save(page);
});
test("порядок услуг и мастеров обновляется публично, две вкладки получают конфликт", async ({
  page,
  context,
}) => {
  await services(page);
  const other = await context.newPage();
  await other.goto("/admin/services");
  await page.getByRole("button", { name: "Ниже: Тестовая стрижка", exact: true }).click();
  await expect(page.getByText("Порядок сохранён.", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Ниже: Тестовая стрижка", exact: true }).click();
  await expect(other.getByText(/Данные изменились в другой вкладке/)).toBeVisible();
  await page.getByRole("button", { name: "Редактировать: Тестовая стрижка", exact: true }).click();
  await other.goto("/admin/services");
  await other.getByRole("button", { name: "Редактировать: Тестовая стрижка", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Новое название");
  await save(page);
  await other.getByLabel("Название", { exact: true }).fill("Устаревшая форма");
  await other.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(other.getByText(/Данные изменились в другой вкладке/)).toBeVisible();
  await expect(other.getByLabel("Название", { exact: true })).toHaveValue("Устаревшая форма");
  await page.getByRole("link", { name: "Мастера", exact: true }).click();
  await page.getByRole("button", { name: "Выше: Второй мастер", exact: true }).click();
  await expect(page.getByText("Порядок сохранён.", { exact: true })).toBeVisible();
  await other.goto("/");
  const names = await other.locator(".service-choice strong").allTextContents();
  expect(names[0]).toBe("Тестовая борода");
  await other.getByRole("button", { name: /Новое название/ }).click();
  await other.getByRole("button", { name: "Выбрать мастера →" }).click();
  const choices = await other.locator(".master-copy strong").allTextContents();
  expect(choices.indexOf("Второй мастер")).toBeLessThan(choices.indexOf("Тестовый мастер"));
  await other.close();
});
test("потеря успешного ответа не вызывает повторного создания, ввод сохранён", async ({ page }) => {
  await services(page);
  await fillService(page, "Потерянный ответ");
  let count = 0;
  await page.route("**/admin/services", async (route) => {
    if (route.request().method() === "POST") {
      count++;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText(/Сохранение не подтверждено/)).toBeVisible();
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("Потерянный ответ");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: /Проверить актуальный список/ })).toBeVisible();
  expect(count).toBe(1);
  expect(await db.service.count({ where: { name: "Потерянный ответ" } })).toBe(1);
  await page.unroute("**/admin/services");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Потерянный ответ", exact: true })).toBeVisible();
});
for (const operation of ["service", "master", "move"] as const) {
  test(
    "прямой Action " +
      operation +
      ": Origin, анонимный/истёкший/отозванный/отключённый сеанс, подстановка полей",
    async ({ page, request }) => {
      await services(page);
      if (operation === "master") {
        await page.getByRole("link", { name: "Мастера", exact: true }).click();
        await page.getByRole("button", { name: "Добавить мастера" }).click();
        await page.getByLabel("Имя", { exact: true }).fill("Action мастер");
      } else if (operation === "service") await fillService(page, "Action услуга");
      const pending = page.waitForRequest(
        (r) => r.method() === "POST" && Boolean(r.headers()["next-action"]),
      );
      if (operation === "move") {
        await page.getByRole("button", { name: "Ниже: Тестовая стрижка", exact: true }).click();
        await expect(page.getByText("Порядок сохранён.", { exact: true })).toBeVisible();
      } else await save(page);
      const action: Request = await pending;
      const endpoint = operation === "master" ? "/admin/masters" : "/admin/services";
      const cookie = (await page.context().cookies()).find(
        (c) => c.name === "zaprosto-admin-local",
      )!;
      const headers = {
        "next-action": action.headers()["next-action"],
        "content-type": action.headers()["content-type"],
        origin,
        cookie: cookie.name + "=" + cookie.value,
      };
      const snapshot = async () =>
        JSON.stringify([
          await db.service.findMany({ orderBy: { id: "asc" } }),
          await db.master.findMany({ orderBy: { id: "asc" } }),
          await db.masterService.findMany({ orderBy: [{ masterId: "asc" }, { serviceId: "asc" }] }),
        ]);
      const before = await snapshot();
      for (const mode of ["missing", "expired", "revoked", "disabled", "origin"]) {
        await db.adminSession.updateMany({
          data: { expiresAt: new Date(Date.now() + 3600000), revokedAt: null },
        });
        await db.adminUser.updateMany({ data: { isActive: true } });
        if (mode === "expired")
          await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
        if (mode === "revoked")
          await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
        if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
        const response = await request.post(endpoint, {
          headers: {
            ...headers,
            ...(mode === "missing" ? { cookie: "" } : {}),
            ...(mode === "origin" ? { origin: "https://evil.example" } : {}),
          },
          data: action.postData()!,
        });
        if (mode !== "origin") expect(await response.text()).toContain("UNAUTHORIZED");
        else expect(response.status()).toBeGreaterThanOrEqual(400);
        expect(await snapshot()).toBe(before);
      }
      const [input] = JSON.parse(action.postData()!);
      const response = await request.post(endpoint, {
        headers,
        data: JSON.stringify([{ ...input, photoMediaId: "fake", displayOrder: 999 }]),
      });
      expect(await response.text()).toContain("INVALID_INPUT");
      expect(await snapshot()).toBe(before);
      await request.get(endpoint);
      expect(await snapshot()).toBe(before);
    },
  );
}
test("новые страницы защищены: HTML и RSC, no-store и CSP", async ({ request }) => {
  for (const path of ["/admin/services", "/admin/masters"]) {
    for (const headers of [{}, { rsc: "1" }] as Record<string, string>[]) {
      const response = await request.get(path, { headers });
      expect(await response.text()).not.toContain("Неактивная услуга");
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(response.headers()["content-security-policy"]).toContain("'strict-dynamic'");
    }
  }
});
test("360/390/1440: снимки списков и форм, клавиатура, ожидание, пустые состояния", async ({
  page,
}, info) => {
  await login(page);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const kind of ["services", "masters"]) {
      await page.goto("/admin/" + kind);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "К содержимому", exact: true })).toBeFocused();
      const before = page.url();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      expect(page.url()).toBe(before);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Обзор", exact: true })).toBeFocused();
      expect(
        await page
          .getByRole("link", { name: "Обзор", exact: true })
          .evaluate((el) => getComputedStyle(el).outlineStyle),
      ).not.toBe("none");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(kind + "-list-" + width + ".png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: kind === "services" ? "Добавить услугу" : "Добавить мастера" })
        .click();
      await expect(
        page.getByRole("heading", { name: kind === "services" ? "Новая услуга" : "Новый мастер" }),
      ).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(kind + "-form-" + width + ".png"),
        fullPage: true,
      });
    }
  }
  await page.goto("/admin/services");
  await fillService(page, "Ожидание");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/services", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Сохраняем…" })).toBeDisabled();
  await expect(page.getByLabel("Название", { exact: true })).toBeDisabled();
  release();
  await expect(page.getByText("Сохранено. Каталог обновлён.")).toBeVisible();
  await page.unroute("**/admin/services");
  await db.master.deleteMany();
  await db.service.deleteMany();
  await page.goto("/admin/services");
  await expect(page.getByText("Услуг пока нет. Добавьте первую услугу.")).toBeVisible();
  await page.goto("/admin/masters");
  await expect(page.getByText("Мастеров пока нет. Добавьте первого мастера.")).toBeVisible();
});

for (const mode of ["service", "master", "assignment"]) {
  test(
    "устаревшая публичная страница, старый fragment и отмена после " + mode,
    async ({ page, context }) => {
      await services(page);
      const client = await context.newPage();
      async function reviewClient(target: Page, time: string) {
        await target.goto("/");
        await target.getByRole("button", { name: /Тестовая стрижка/ }).click();
        await target.getByRole("button", { name: "Выбрать мастера →" }).click();
        await target.getByRole("button", { name: /Тестовый мастер/ }).click();
        await target.getByRole("button", { name: "Выбрать время →" }).click();
        await target.getByLabel("Дата визита").selectOption({ index: 2 });
        await target.getByRole("button", { name: time, exact: true }).click();
        await target.getByRole("button", { name: "Продолжить →" }).click();
        await target.getByLabel("Ваше имя").fill("Тестовый клиент");
        await target.getByLabel("Номер телефона").fill("+79990000000");
        await target.getByRole("button", { name: "Проверить запись →" }).click();
      }
      await reviewClient(client, "10:00");
      await client.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
      await expect(client.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
      const href = await client
        .getByRole("link", { name: "Открыть мою запись ↗" })
        .getAttribute("href");
      const old = await db.appointment.findFirstOrThrow({ include: { statusHistory: true } });
      const stale = await context.newPage();
      await reviewClient(stale, "12:00");
      await page
        .getByRole("button", { name: "Редактировать: Тестовая стрижка", exact: true })
        .click();
      await page.getByLabel("Название", { exact: true }).fill("Изменённая стрижка");
      await page.getByLabel("Цена, ₽", { exact: true }).fill("99.99");
      await page.getByLabel("Длительность, минут", { exact: true }).fill("37");
      if (mode === "service") {
        await page.getByLabel("Активна", { exact: true }).uncheck();
        await page.getByLabel("Подтверждаю деактивацию").check();
      }
      await save(page);
      if (mode !== "service") {
        await page.getByRole("link", { name: "Мастера", exact: true }).click();
        await page
          .getByRole("button", { name: "Редактировать: Тестовый мастер", exact: true })
          .click();
        if (mode === "master") {
          await page.getByLabel("Активен", { exact: true }).uncheck();
          await page.getByLabel("Подтверждаю деактивацию").check();
        } else await page.getByLabel("Изменённая стрижка", { exact: true }).uncheck();
        await save(page);
      }
      expect(
        await db.appointment.findUniqueOrThrow({
          where: { id: old.id },
          include: { statusHistory: true },
        }),
      ).toEqual(old);
      await stale.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
      if (mode === "service") {
        await expect(stale.getByText(/Запись не создана. Проверьте услугу/)).toBeVisible();
      } else {
        await expect(stale.getByText(/Условия услуги изменились/)).toBeVisible();
        await expect(stale.getByLabel("Обновлённые условия услуги")).toContainText(
          "Изменённая стрижка",
        );
        await expect(stale.getByLabel("Обновлённые условия услуги")).toContainText("99,99");
        await expect(stale.getByLabel("Обновлённые условия услуги")).toContainText("37 мин");
      }
      await expect(stale.getByRole("button", { name: "Продолжить →" })).toBeDisabled();
      await expect(stale.getByRole("button", { name: "12:00", exact: true })).toHaveCount(0);
      expect(await db.bookingRequest.count()).toBe(1);
      expect(await db.appointmentStatusHistory.count()).toBe(1);
      expect(await db.appointment.count()).toBe(1);
      await client.goto(href!);
      await expect(client.getByText("Запланирована", { exact: true })).toBeVisible();
      await expect(client.getByText("Тестовая стрижка", { exact: true })).toBeVisible();
      await client.getByRole("button", { name: "К содержимому", exact: true }).focus();
      const before = client.url();
      await client.keyboard.press("Enter");
      expect(client.url()).toBe(before);
      await client.getByRole("button", { name: "Отменить запись", exact: true }).click();
      await client.getByLabel("Я хочу отменить эту запись").check();
      await client.getByRole("button", { name: "Да, отменить запись" }).click();
      await expect(client.getByText("Отменена", { exact: true })).toBeVisible();
      expect(
        await db.appointmentStatusHistory.count({
          where: { appointmentId: old.id, newStatus: "CANCELLED" },
        }),
      ).toBe(1);
      if (mode === "service") {
        await page
          .getByRole("button", { name: "Редактировать: Изменённая стрижка", exact: true })
          .click();
        await page.getByLabel("Активна", { exact: true }).check();
        await save(page);
        await stale.goto("/");
        await expect(stale.getByRole("button", { name: /Изменённая стрижка/ })).toBeVisible();
      }
      await stale.close();
      await client.close();
    },
  );
}
