import { randomBytes } from "node:crypto";

import { expect, test, type Page, type Request } from "@playwright/test";

import { demoMasterIds, demoServiceIds, seedDemo } from "../../scripts/demo-data";
import { hashPassword } from "../../src/modules/auth/server/password";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { prepareBookingAttempt } from "../../src/modules/booking/server/booking-security";
import { getLocalDayInterval } from "../../src/modules/scheduling/time/business-time";
import { businessContextHash } from "../../src/modules/settings/server/context";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/zaprosto_test_"))
  throw new Error("E2E requires the isolated runner");
const db = createPrismaClient(databaseUrl);
const credentials = {
  login: "manual-create.e2e",
  password: randomBytes(24).toString("base64url"),
};
let passwordHash: string;

async function clear() {
  await db.notificationOutbox.deleteMany();
  await db.telegramLink.deleteMany();
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
}

async function toTime(page: Page, any = false) {
  await login(page);
  await page.getByRole("link", { name: "Записи", exact: true }).click();
  await page.getByRole("link", { name: "Создать запись", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/appointments\/new$/);
  await page.getByLabel("Активная услуга").selectOption(demoServiceIds[0]);
  await page.getByLabel("Мастер").selectOption(any ? "ANY" : demoMasterIds[0]);
  await page.getByRole("button", { name: "Выбрать время →" }).click();
  await page.getByLabel("Дата визита").selectOption({ index: 2 });
  await expect(page.getByRole("button", { name: "10:00", exact: true })).toBeVisible();
}

async function toReview(page: Page, phone = "8 (999) 000-00-00") {
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "Ввести клиента →" }).click();
  await page.getByLabel("Имя клиента").fill("Вымышленный Клиент");
  await page.getByLabel("Российский телефон").fill(phone);
  await page.getByRole("button", { name: "Проверить данные →" }).click();
}

async function confirm(page: Page) {
  const checkbox = page.getByLabel("Подтверждаю создание этой записи");
  await expect(page.getByRole("button", { name: "Подтвердить создание" })).toBeDisabled();
  await checkbox.check();
  await page.getByRole("button", { name: "Подтвердить создание" }).click();
  await expect(page.getByRole("heading", { name: "Запись готова" })).toBeVisible();
}

function createRequest(page: Page) {
  return page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.postData()?.includes("clientPhone") === true,
  );
}

function actionHeaders(request: Request, origin = "http://localhost:3108") {
  return {
    "content-type": request.headers()["content-type"],
    "next-action": request.headers()["next-action"],
    origin,
  };
}

test("full SPECIFIC flow, copy actions, admin card and protected client cancellation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          const target = window as typeof window & { __copied?: string[] };
          target.__copied = [...(target.__copied ?? []), value];
        },
      },
    });
  });
  await toTime(page);
  await toReview(page);
  await confirm(page);
  const protectedUrl = await page.getByLabel("Защищённая клиентская ссылка").inputValue();
  expect(protectedUrl).toMatch(/^http:\/\/localhost:3108\/appointment#[A-Za-z0-9_-]{43}$/);
  expect(page.url()).not.toContain("#");
  expect(page.url()).not.toContain("appointment#");
  await expect(page.getByLabel("Текст подтверждения")).toContainText("Мужская стрижка · демо");
  await expect(page.getByLabel("Текст подтверждения")).toContainText("Не передавайте эту ссылку");
  await page.getByRole("button", { name: "Копировать текст" }).click();
  await page.getByRole("button", { name: "Копировать ссылку" }).click();
  const copied = await page.evaluate(
    () => (window as typeof window & { __copied?: string[] }).__copied ?? [],
  );
  expect(copied).toHaveLength(2);
  expect(copied[1]).toBe(protectedUrl);

  const appointment = await db.appointment.findFirstOrThrow({
    include: { statusHistory: true },
  });
  expect(appointment.source).toBe("ADMIN");
  expect(appointment.masterSelection).toBe("SPECIFIC");
  expect(appointment.statusHistory[0]).toMatchObject({
    changedBy: "ADMIN",
    previousStatus: null,
    newStatus: "SCHEDULED",
  });
  await page.getByRole("link", { name: "Открыть карточку записи" }).click();
  await expect(page).toHaveURL(new RegExp("/admin/appointments/" + appointment.id + "$"));
  await expect(page.getByRole("heading", { name: "Карточка записи" })).toBeVisible();

  await page.goto(protectedUrl);
  await expect(page.getByText("Запланирована", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Отменить запись", exact: true }).click();
  await page.getByLabel("Я хочу отменить эту запись").check();
  await page.getByRole("button", { name: "Да, отменить запись" }).click();
  await expect(page.getByText("Отменена", { exact: true })).toBeVisible();
  expect(
    await db.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
      select: { source: true, status: true },
    }),
  ).toEqual({ source: "ADMIN", status: "CANCELLED" });
});

test("ANY flow and a physical double click create one deterministic appointment", async ({
  page,
}) => {
  await toTime(page, true);
  await toReview(page, "+7 (999) 000-00-00");
  await page.getByLabel("Подтверждаю создание этой записи").check();
  await page
    .getByRole("button", { name: "Подтвердить создание" })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(page.getByRole("heading", { name: "Запись готова" })).toBeVisible();
  const appointment = await db.appointment.findFirstOrThrow();
  expect(appointment.masterSelection).toBe("ANY");
  expect(appointment.source).toBe("ADMIN");
  expect(demoMasterIds).toContain(appointment.masterId);
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
});

test("phone validation and an empty day prevent submission with clear states", async ({ page }) => {
  await toTime(page);
  await toReview(page, "+1 999 000-00-00");
  await expect(page.getByText("Укажите российский номер с +7 или 8 и 11 цифрами.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить создание" })).toHaveCount(0);
  expect(await db.appointment.count()).toBe(0);

  await page.getByRole("button", { name: "← Ко времени" }).click();
  const localDate = await page.getByLabel("Дата визита").inputValue();
  await db.scheduleException.create({
    data: {
      masterId: demoMasterIds[0],
      localDate: new Date(localDate + "T00:00:00Z"),
      type: "DAY_OFF",
    },
  });
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByText("На выбранную дату свободных интервалов нет.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ввести клиента →" })).toBeDisabled();
});

test("a stale slot resets time, preserves contacts and focuses the actionable conflict", async ({
  page,
}) => {
  await toTime(page);
  const localDate = await page.getByLabel("Дата визита").inputValue();
  await toReview(page);
  const startsAt = getLocalDayInterval(localDate, "Europe/Moscow").startsAt;
  startsAt.setUTCHours(startsAt.getUTCHours() + 10);
  const service = await db.service.findUniqueOrThrow({ where: { id: demoServiceIds[0] } });
  const competitor = await createBookingService(db).createBooking({
    ...prepareBookingAttempt(),
    serviceId: demoServiceIds[0],
    expectedServiceTerms: publicServiceTerms(service).termsHash,
    expectedBusinessContext: businessContextHash(
      await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
    ),
    master: { type: "SPECIFIC", masterId: demoMasterIds[0] },
    localDate,
    startsAt,
    clientName: "Вымышленный конкурент",
    clientPhone: "+79990000001",
  });
  expect(competitor.ok).toBe(true);
  await page.getByLabel("Подтверждаю создание этой записи").check();
  await page.getByRole("button", { name: "Подтвердить создание" }).click();
  const conflict = page.getByText(
    "Выбранное время уже недоступно. Выберите другое; контакты сохранены.",
  );
  await expect(conflict).toBeVisible();
  await expect(conflict).toBeFocused();
  await expect(page.getByRole("button", { name: "10:00", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "10:45", exact: true }).click();
  await page.getByRole("button", { name: "Ввести клиента →" }).click();
  await expect(page.getByLabel("Имя клиента")).toHaveValue("Вымышленный Клиент");
  await expect(page.getByLabel("Российский телефон")).toHaveValue("8 (999) 000-00-00");
});

test("changed service terms force a new time choice and explicit reconfirmation", async ({
  page,
}) => {
  await toTime(page);
  await toReview(page);
  await db.service.update({
    where: { id: demoServiceIds[0] },
    data: { priceKopecks: 199_900, durationMinutes: 50 },
  });
  await page.getByLabel("Подтверждаю создание этой записи").check();
  await page.getByRole("button", { name: "Подтвердить создание" }).click();
  await expect(page.getByText(/Условия услуги изменились/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Ввести клиента →" })).toBeDisabled();
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "Ввести клиента →" }).click();
  await expect(page.getByLabel("Имя клиента")).toHaveValue("Вымышленный Клиент");
  await expect(page.getByLabel("Российский телефон")).toHaveValue("8 (999) 000-00-00");
  await page.getByRole("button", { name: "Проверить данные →" }).click();
  await expect(page.getByRole("button", { name: "Подтвердить создание" })).toBeDisabled();
  await expect(page.locator(".appointment-facts")).toContainText("1 999");
});

for (const commit of [false, true])
  test(`unknown result ${commit ? "after" : "before"} COMMIT replays only the original attempt`, async ({
    page,
  }) => {
    await toTime(page);
    await toReview(page);
    let lost = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!lost && request.method() === "POST" && request.postData()?.includes("clientPhone")) {
        lost = true;
        if (commit) {
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
        }
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });
    await page.getByLabel("Подтверждаю создание этой записи").check();
    await page.getByRole("button", { name: "Подтвердить создание" }).click();
    await expect(page.getByRole("heading", { name: "Есть незавершённая попытка" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeVisible();
    await expect.poll(() => db.appointment.count()).toBe(commit ? 1 : 0);
    await page.unroute("**/*");
    await page.getByRole("button", { name: "Повторить исходный запрос" }).click();
    await expect(page.getByRole("heading", { name: "Запись готова" })).toBeVisible();
    expect(await db.appointment.count()).toBe(1);
    expect(await db.bookingRequest.count()).toBe(1);
  });

test("Clipboard failure selects the protected link for manual copying", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error("denied")) },
    });
  });
  await toTime(page);
  await toReview(page);
  await confirm(page);
  const link = page.getByLabel("Защищённая клиентская ссылка");
  await page.getByRole("button", { name: "Копировать ссылку" }).click();
  await expect(page.getByText(/Поле выделено — скопируйте вручную/)).toBeVisible();
  await expect(link).toBeFocused();
  expect(
    await link.evaluate((field: HTMLInputElement) => [
      field.selectionStart,
      field.selectionEnd,
      field.value.length,
    ]),
  ).toEqual([0, (await link.inputValue()).length, (await link.inputValue()).length]);
});

test("protected GET and captured direct Action deny lost access and foreign Origin", async ({
  page,
}) => {
  await toTime(page);
  await toReview(page);
  const captured = createRequest(page);
  await page.getByLabel("Подтверждаю создание этой записи").check();
  await page.getByRole("button", { name: "Подтвердить создание" }).click();
  const request = await captured;
  await expect(page.getByRole("heading", { name: "Запись готова" })).toBeVisible();
  const payload = request.postData()!;
  await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
  const denied = await page.request.post("/admin/appointments/new", {
    headers: actionHeaders(request),
    data: payload,
  });
  const deniedBody = await denied.text();
  expect(deniedBody).toContain("UNAUTHORIZED");
  expect(deniedBody).not.toContain("cancellationToken");

  const foreign = await page.request.post("/admin/appointments/new", {
    headers: actionHeaders(request, "https://evil.example"),
    data: payload,
  });
  expect(foreign.status() >= 400 || (await foreign.text()).includes("FORBIDDEN")).toBe(true);
  const protectedPage = await page.request.get("/admin/appointments/new", {
    headers: { cookie: "" },
  });
  expect(protectedPage.url()).toContain("/admin/login");
  expect(await protectedPage.text()).not.toContain("Мужская стрижка · демо");
  expect(await db.appointment.count()).toBe(1);
});

test("360, 390 and 1440 layouts, keyboard confirmation and focus remain usable", async ({
  page,
}, testInfo) => {
  await login(page);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/appointments/new");
    await expect(page.getByRole("heading", { name: "Создать запись" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.getByLabel("Активная услуга").focus();
    expect(
      await page
        .getByLabel("Активная услуга")
        .evaluate((element) => getComputedStyle(element).outlineStyle),
    ).not.toBe("none");
    await page.screenshot({
      path: testInfo.outputPath(`admin-create-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByLabel("Активная услуга").selectOption(demoServiceIds[0]);
  await page.getByLabel("Мастер").selectOption(demoMasterIds[0]);
  await page.getByRole("button", { name: "Выбрать время →" }).click();
  await page.getByLabel("Дата визита").selectOption({ index: 2 });
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "Ввести клиента →" }).click();
  await page.getByLabel("Имя клиента").fill("Клавиатурный клиент");
  await page.getByLabel("Российский телефон").fill("8 999 000 00 00");
  await page.getByRole("button", { name: "Проверить данные →" }).click();
  const confirmation = page.getByLabel("Подтверждаю создание этой записи");
  await confirmation.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Изменить данные" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Подтвердить создание" })).toBeFocused();
});
