import { randomBytes } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { expect, test, type Page, type Locator } from "@playwright/test";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { hashPassword } from "../../src/modules/auth/server/password";
import { seedDemo } from "../../scripts/demo-data";
import { localDateForInstant } from "../../src/modules/scheduling/time/business-time";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url);
const credentials = { login: "schedule.e2e", password: randomBytes(24).toString("base64url") };
let passwordHash: string, masterId: string, emptyId: string, serviceId: string;
const localDate = Temporal.PlainDate.from(localDateForInstant(new Date(), "Europe/Moscow"))
  .add({ days: 2 })
  .toString();
const origin = "http://localhost:3108";
const endpoint = () => `/admin/schedule?masterId=${masterId}&month=${localDate.slice(0, 7)}`;
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
  await db.businessSettings.upsert({
    where: { id: 1 },
    create: { businessName: "Тест" },
    update: { timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  await db.adminUser.create({ data: { login: credentials.login, passwordHash } });
  serviceId = (
    await db.service.create({
      data: { name: "Расписание: стрижка", priceKopecks: 150000, durationMinutes: 37 },
    })
  ).id;
  masterId = (
    await db.master.create({
      data: {
        name: "Тестовый мастер",
        services: { create: { serviceId } },
        weeklyWorkIntervals: {
          create: Array.from({ length: 7 }, (_, i) => ({
            dayOfWeek: i + 1,
            startsAt: new Date("1970-01-01T09:00Z"),
            endsAt: new Date("1970-01-01T18:00Z"),
          })),
        },
      },
    })
  ).id;
  emptyId = (
    await db.master.create({ data: { name: "Новый мастер", isActive: false, displayOrder: 1 } })
  ).id;
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
  await page.goto(endpoint());
}
const monday = (page: Page) => page.getByRole("group", { name: "Понедельник", exact: true });
async function fillRow(group: Locator, start: string, end: string, index = 0) {
  await group
    .locator("input")
    .nth(index * 2)
    .fill(start);
  await group
    .locator("input")
    .nth(index * 2 + 1)
    .fill(end);
}
async function saveWeek(page: Page) {
  await page.getByRole("button", { name: "Сохранить неделю", exact: true }).click();
  await expect(page.getByText("Недельный график сохранён.", { exact: true })).toBeVisible();
}
async function dayOff(page: Page) {
  await page.getByRole("button", { name: "Добавить исключение" }).click();
  await page.getByLabel("Дата исключения").fill(localDate);
  await page.getByRole("button", { name: "Сохранить исключение", exact: true }).click();
  await expect(page.getByText(/Исключение сохранено/)).toBeVisible();
}

test("несколько интервалов, перерывы, минуты, пустой день, клавиатура и серверные ошибки", async ({
  page,
}) => {
  await login(page);
  const group = monday(page),
    work = group.locator(".schedule-intervals").nth(0),
    breaks = group.locator(".schedule-intervals").nth(1);
  await fillRow(work, "09:07", "12:00");
  await work.getByRole("button", { name: "Добавить рабочий интервал" }).focus();
  await page.keyboard.press("Enter");
  await expect(work.locator("input").nth(2)).toBeFocused();
  await fillRow(work, "14:00", "18:00", 1);
  await breaks.getByRole("button", { name: "Добавить перерыв" }).click();
  await fillRow(breaks, "10:03", "10:22");
  await breaks.getByRole("button", { name: "Добавить перерыв" }).click();
  await fillRow(breaks, "19:00", "20:00", 1);
  await fillRow(work, "09:07", "09:07");
  await page.getByRole("button", { name: "Сохранить неделю" }).click();
  await expect(page.locator(".catalog-status").getByRole("alert")).toContainText(
    "Начало должно быть раньше конца",
  );
  await expect(page.locator(".catalog-status")).toBeFocused();
  await expect(work.locator("input").first()).toHaveValue("09:07");
  await fillRow(work, "09:07", "12:00");
  await saveWeek(page);
  expect(await db.weeklyWorkInterval.count({ where: { masterId, dayOfWeek: 1 } })).toBe(2);
  expect(await db.weeklyBreak.count({ where: { masterId, dayOfWeek: 1 } })).toBe(2);
  await work.getByRole("button", { name: "Удалить рабочий интервал 2" }).focus();
  await page.keyboard.press("Enter");
  await expect(work.getByRole("button", { name: "Добавить рабочий интервал" })).toBeFocused();
  await work.getByRole("button", { name: "Удалить рабочий интервал 1" }).click();
  await saveWeek(page);
  expect(await db.weeklyWorkInterval.count({ where: { masterId, dayOfWeek: 1 } })).toBe(0);
  expect(await db.weeklyBreak.count({ where: { masterId, dayOfWeek: 1 } })).toBe(2);
});
test("исключение: особые часы, пустая форма, смена типа и подтверждённое удаление", async ({
  page,
}) => {
  await login(page);
  await dayOff(page);
  await page.getByRole("button", { name: `Изменить исключение ${localDate}` }).click();
  await page.getByLabel("Тип исключения").selectOption("CUSTOM_HOURS");
  await page.getByRole("button", { name: "Сохранить исключение", exact: true }).click();
  await expect(page.locator(".catalog-status").getByRole("alert")).toContainText(
    "Добавьте рабочий интервал",
  );
  const form = page.locator(".schedule-exceptions .admin-form");
  await form.getByRole("button", { name: "Добавить особый интервал" }).click();
  await fillRow(form.locator(".schedule-intervals"), "11:03", "15:37");
  await page.getByRole("button", { name: "Сохранить исключение", exact: true }).click();
  await expect(page.getByText("11:03–15:37", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Изменить исключение ${localDate}` }).click();
  await page.getByLabel("Тип исключения").selectOption("DAY_OFF");
  await page.getByRole("button", { name: "Сохранить исключение", exact: true }).click();
  await expect(page.getByText(/Исключение сохранено/)).toBeVisible();
  expect(await db.exceptionWorkInterval.count()).toBe(0);
  await page.getByRole("button", { name: `Удалить исключение ${localDate}` }).click();
  await expect(
    page.getByRole("button", { name: "Удалить и вернуть недельный график" }),
  ).toBeDisabled();
  await expect(form).toContainText("Существующие записи не изменятся");
  await page.getByLabel("Подтверждаю возврат к недельному графику").check();
  await page.getByRole("button", { name: "Удалить и вернуть недельный график" }).click();
  await expect(
    page.getByText("Исключение удалено. Снова действует недельный график."),
  ).toBeVisible();
  expect(await db.scheduleException.count()).toBe(0);
});
test("два редактора: конфликт недели и исключения сохраняет черновик", async ({
  page,
  context,
}) => {
  await login(page);
  const other = await context.newPage();
  await other.goto(endpoint());
  await fillRow(monday(page).locator(".schedule-intervals").first(), "09:07", "17:00");
  await saveWeek(page);
  await fillRow(monday(other).locator(".schedule-intervals").first(), "10:03", "16:00");
  await other.getByRole("button", { name: "Сохранить неделю" }).click();
  await expect(other.locator(".catalog-status").getByRole("alert")).toContainText(
    "Данные изменились",
  );
  await expect(monday(other).locator("input").first()).toHaveValue("10:03");
  await expect(other.getByRole("button", { name: "Сохранить неделю" })).toBeDisabled();
  await other.goto(endpoint());
  await other.getByRole("button", { name: "Добавить исключение" }).click();
  await other.getByLabel("Дата исключения").fill(localDate);
  await dayOff(page);
  await other.getByRole("button", { name: "Сохранить исключение", exact: true }).click();
  await expect(other.locator(".catalog-status").getByRole("alert")).toContainText(
    "Данные изменились",
  );
  await expect(other.getByLabel("Дата исключения")).toHaveValue(localDate);
  expect(await db.scheduleException.count()).toBe(1);
  await other.close();
});
test("потеря подтверждённого сервером ответа: черновик остаётся, автоматического повтора нет", async ({
  page,
}) => {
  await login(page);
  await fillRow(monday(page).locator(".schedule-intervals").first(), "09:07", "17:37");
  let count = 0;
  await page.route("**/admin/schedule**", async (route) => {
    if (route.request().method() === "POST") {
      count++;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Сохранить неделю" }).click();
  await expect(page.locator(".catalog-status").getByRole("alert")).toContainText(
    "Сохранение не подтверждено",
  );
  await expect(monday(page).locator("input").first()).toHaveValue("09:07");
  await expect(page.getByRole("button", { name: "Сохранить неделю" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /Проверить актуальное расписание/ })).toBeVisible();
  expect(count).toBe(1);
  expect(
    (
      await db.weeklyWorkInterval.findFirstOrThrow({ where: { masterId, dayOfWeek: 1 } })
    ).startsAt.toISOString(),
  ).toBe("1970-01-01T09:07:00.000Z");
  await page.unroute("**/admin/schedule**");
});
for (const operation of ["week", "exception", "delete"] as const)
  test(`каждая Action ${operation}: Origin, сессия, подстановка полей и GET`, async ({
    page,
    request,
  }) => {
    await login(page);
    if (operation === "delete") {
      await dayOff(page);
      await page.getByRole("button", { name: `Удалить исключение ${localDate}` }).click();
      await page.getByLabel("Подтверждаю возврат к недельному графику").check();
    }
    if (operation === "exception") {
      await page.getByRole("button", { name: "Добавить исключение" }).click();
      await page.getByLabel("Дата исключения").fill(localDate);
    }
    const captured = page.waitForRequest(
      (r) => r.method() === "POST" && Boolean(r.headers()["next-action"]),
    );
    await page
      .getByRole("button", {
        name:
          operation === "week"
            ? "Сохранить неделю"
            : operation === "exception"
              ? "Сохранить исключение"
              : "Удалить и вернуть недельный график",
        exact: true,
      })
      .click();
    await expect(page.locator(".catalog-status .notice[role=status]")).toContainText(
      operation === "week"
        ? "Недельный график сохранён"
        : operation === "exception"
          ? "Исключение сохранено"
          : "Исключение удалено",
    );
    const action = await captured;
    const cookie = (await page.context().cookies()).find((c) => c.name === "zaprosto-admin-local")!;
    const headers = {
      "next-action": action.headers()["next-action"],
      "content-type": action.headers()["content-type"],
      origin,
      cookie: cookie.name + "=" + cookie.value,
    };
    const snapshot = async () =>
      JSON.stringify([
        await db.master.findMany({ orderBy: { id: "asc" } }),
        await db.weeklyWorkInterval.findMany({ orderBy: { id: "asc" } }),
        await db.weeklyBreak.findMany({ orderBy: { id: "asc" } }),
        await db.scheduleException.findMany({ orderBy: { id: "asc" } }),
        await db.exceptionWorkInterval.findMany({ orderBy: { id: "asc" } }),
      ]);
    const before = await snapshot();
    for (const mode of ["missing", "expired", "revoked", "disabled", "origin"]) {
      await db.adminSession.updateMany({
        data: { expiresAt: new Date(Date.now() + 3600000), revokedAt: null },
      });
      await db.adminUser.updateMany({ data: { isActive: true } });
      if (mode === "expired")
        await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
      if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
      if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
      const response = await request.post(endpoint(), {
        headers: {
          ...headers,
          ...(mode === "missing" ? { cookie: "" } : {}),
          ...(mode === "origin" ? { origin: "https://evil.example" } : {}),
        },
        data: action.postData()!,
      });
      if (mode === "origin") expect(response.status()).toBeGreaterThanOrEqual(400);
      else expect(await response.text()).toContain("UNAUTHORIZED");
      expect(await snapshot()).toBe(before);
    }
    const [input] = JSON.parse(action.postData()!);
    const response = await request.post(endpoint(), {
      headers,
      data: JSON.stringify([{ ...input, isActive: true, timezone: "UTC" }]),
    });
    expect(await response.text()).toContain("INVALID_INPUT");
    expect(await snapshot()).toBe(before);
    await request.get(endpoint(), { headers: { cookie: headers.cookie } });
    expect(await snapshot()).toBe(before);
  });
test("закрытые HTML/RSC защищены, no-store и nonce-CSP; новый мастер без графика", async ({
  page,
  request,
}) => {
  for (const headers of [{}, { rsc: "1" }] as Record<string, string>[]) {
    const response = await request.get(endpoint(), { headers });
    expect(await response.text()).not.toContain("Тестовый мастер");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["content-security-policy"]).toContain("'strict-dynamic'");
  }
  await login(page);
  await page.getByRole("link", { name: "Мастера", exact: true }).click();
  await page.getByRole("link", { name: "Расписание: Новый мастер" }).click();
  await expect(page.getByRole("heading", { name: "Новый мастер · Неактивен" })).toBeVisible();
  await expect(page.getByText("Нет регулярных рабочих часов")).toHaveCount(7);
  await fillRowAfterAdd(monday(page).locator(".schedule-intervals").first(), "10:00", "11:00");
  await saveWeek(page);
  expect((await db.master.findUniqueOrThrow({ where: { id: emptyId } })).isActive).toBe(false);
  expect(await db.masterService.count({ where: { masterId: emptyId } })).toBe(0);
});
async function fillRowAfterAdd(group: Locator, start: string, end: string) {
  await group.getByRole("button", { name: "Добавить рабочий интервал" }).click();
  await fillRow(group, start, end);
}
test("360/390/1440: снимки недели и исключений, фокус, ожидание, зона браузера", async ({
  browser,
}, info) => {
  const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(endpoint());
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "К содержимому" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Обзор", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByText(/Часовой пояс бизнеса/)).toContainText("Europe/Moscow");
    await page.screenshot({ path: info.outputPath(`schedule-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Добавить исключение" }).click();
    await page.getByLabel("Дата исключения").fill(localDate);
    await page.getByLabel("Тип исключения").selectOption("CUSTOM_HOURS");
    await page.getByRole("button", { name: "Добавить особый интервал" }).click();
    await fillRow(page.locator(".schedule-exceptions .schedule-intervals"), "09:07", "17:37");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page
      .locator(".schedule-exceptions")
      .screenshot({ path: info.outputPath(`exception-${width}.png`) });
  }
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/admin/schedule**", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Сохранить исключение", exact: true }).click();
  await expect(page.getByText("Сохраняем расписание…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить неделю" })).toBeDisabled();
  release();
  await expect(page.getByText(/Исключение сохранено/)).toBeVisible();
  const row = await db.scheduleException.findFirstOrThrow({ include: { intervals: true } });
  expect(row.localDate.toISOString().slice(0, 10)).toBe(localDate);
  expect(row.intervals[0].startsAt.toISOString()).toBe("1970-01-01T09:07:00.000Z");
  expect(errors).toEqual([]);
  await context.close();
});
for (const any of [false, true])
  test(`старая публичная форма после закрытия дня отклонена: ${any ? "ANY" : "SPECIFIC"}`, async ({
    page,
    context,
  }) => {
    await login(page);
    const client = await context.newPage();
    await client.goto("/");
    await client.getByRole("button", { name: /Расписание: стрижка/ }).click();
    await client.getByRole("button", { name: "Выбрать мастера →" }).click();
    await client.getByRole("button", { name: any ? /Любой мастер/ : /Тестовый мастер/ }).click();
    await client.getByRole("button", { name: "Выбрать время →" }).click();
    await client.getByLabel("Дата визита").selectOption(localDate);
    await client.getByRole("button", { name: "10:00", exact: true }).click();
    await client.getByRole("button", { name: "Продолжить →" }).click();
    await client.getByLabel("Ваше имя").fill("Тест Клиент");
    await client.getByLabel("Номер телефона").fill("+79990000000");
    await client.getByRole("button", { name: "Проверить запись →" }).click();
    await dayOff(page);
    await client.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
    await expect(client.getByRole("heading", { name: "Вы записаны." })).toHaveCount(0);
    await expect(
      client.getByRole("button", { name: "Подтвердить запись", exact: true }),
    ).toHaveCount(0);
    await expect(
      client.getByText(/нет свободного времени|свободных окон|Время уже недоступно/i).first(),
    ).toBeVisible();
    expect(await db.appointment.count()).toBe(0);
    expect(await db.bookingRequest.count()).toBe(0);
    await client.close();
  });

test("публичный replay после закрытия дня сохраняет запись, историю и защищённую ссылку", async ({
  page,
  context,
}) => {
  await login(page);
  const client = await context.newPage();
  await client.goto("/");
  await client.getByRole("button", { name: /Расписание: стрижка/ }).click();
  await client.getByRole("button", { name: "Выбрать мастера →" }).click();
  await client.getByRole("button", { name: /Тестовый мастер/ }).click();
  await client.getByRole("button", { name: "Выбрать время →" }).click();
  await client.getByLabel("Дата визита").selectOption(localDate);
  await client.getByRole("button", { name: "10:00", exact: true }).click();
  await client.getByRole("button", { name: "Продолжить →" }).click();
  await client.getByLabel("Ваше имя").fill("Тест Клиент");
  await client.getByLabel("Номер телефона").fill("+79990000000");
  await client.getByRole("button", { name: "Проверить запись →" }).click();
  let lost = false;
  await client.route("**/*", async (route) => {
    const request = route.request();
    if (!lost && request.method() === "POST" && request.postData()?.includes("clientPhone")) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await client.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(client.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
  const before = await db.appointment.findFirstOrThrow({
    include: { statusHistory: true, bookingRequest: true },
  });
  const link = await client
    .getByRole("link", { name: "Проверить по защищённой ссылке" })
    .getAttribute("href");
  await dayOff(page);
  await client.unroute("**/*");
  await client.reload();
  await client.getByRole("button", { name: "Повторить исходный запрос" }).click();
  await expect(client.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
  expect(
    await client.getByRole("link", { name: "Открыть мою запись ↗" }).getAttribute("href"),
  ).toBe(link);
  expect(
    await db.appointment.findFirstOrThrow({
      include: { statusHistory: true, bookingRequest: true },
    }),
  ).toEqual(before);
  expect(await db.appointment.count()).toBe(1);
  await client.goto(link!);
  await expect(client.getByText("Запланирована", { exact: true })).toBeVisible();
  await client.close();
});
