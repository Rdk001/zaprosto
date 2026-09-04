import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { demoMasterIds, demoServiceIds, seedDemo } from "../../scripts/demo-data";
import type { AppointmentStatus } from "../../src/generated/prisma/client";
import { hashPassword } from "../../src/modules/auth/server/password";
import { sessionCookie } from "../../src/modules/auth/policy";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import {
  hashBookingToken,
  prepareBookingAttempt,
} from "../../src/modules/booking/server/booking-security";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import {
  getLocalDayInterval,
  localDateForInstant,
} from "../../src/modules/scheduling/time/business-time";
import { businessContextHash } from "../../src/modules/settings/server/context";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/zaprosto_test_[a-f0-9]+$/.test(new URL(databaseUrl).pathname)) {
  throw new Error("E2E requires the isolated runner");
}

const db = createPrismaClient(databaseUrl);
const credentials = {
  login: "appointment-reschedule.e2e",
  password: randomBytes(24).toString("base64url"),
};
const timeZone = "Europe/Moscow";
let passwordHash: string;
let appointmentId: string;

function dateAtOffset(days: number) {
  return localDateForInstant(new Date(Date.now() + days * 24 * 60 * 60 * 1000), timeZone);
}

function startsAt(localDate: string, hour: number, minute = 0) {
  const day = getLocalDayInterval(localDate, timeZone).startsAt;
  return new Date(day.getTime() + (hour * 60 + minute) * 60_000);
}

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

async function createAppointment(status: AppointmentStatus = "SCHEDULED") {
  const secret = prepareBookingAttempt();
  const start = startsAt(dateAtOffset(1), 10);
  const appointment = await db.appointment.create({
    data: {
      bookingRequest: { create: { idempotencyKey: secret.idempotencyKey } },
      master: { connect: { id: demoMasterIds[0] } },
      service: { connect: { id: demoServiceIds[0] } },
      startsAt: start,
      endsAt: new Date(start.getTime() + 35 * 60_000),
      clientName: "Вымышленный Клиент",
      clientPhone: "+79990000000",
      status,
      source: "ONLINE",
      masterSelection: "SPECIFIC",
      serviceNameSnapshot: "Историческая стрижка",
      servicePriceSnapshot: 123_456,
      serviceDurationSnapshot: 35,
      cancellationTokenHash: hashBookingToken(secret.cancellationToken),
      ...(status === "CANCELLED"
        ? { cancelledAt: new Date(), cancelledBy: "CLIENT" as const }
        : {}),
      statusHistory: {
        create: { previousStatus: null, newStatus: status, changedBy: "CLIENT" },
      },
    },
  });
  return appointment;
}

test.beforeAll(async () => {
  passwordHash = await hashPassword(credentials.password);
});

test.beforeEach(async () => {
  await clear();
  await seedDemo(db);
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: 0, timezone: timeZone, bookingHorizonDays: 30 },
  });
  await db.adminUser.create({ data: { login: credentials.login, passwordHash } });
  appointmentId = (await createAppointment()).id;
});

test.afterAll(async () => {
  await clear();
  await seedDemo(db);
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: 0, timezone: timeZone, bookingHorizonDays: 30 },
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

function cardPath() {
  return `/admin/appointments/${appointmentId}`;
}

function actionGlob() {
  return `**${cardPath()}**`;
}

function availabilityButton(page: Page) {
  return page.getByRole("button", { name: /^(Показать свободное время|Обновить время)$/ });
}

function saveButton(page: Page) {
  return page.getByRole("button", { name: "Сохранить параметры визита", exact: true });
}

function dateSelect(page: Page) {
  return page.locator("#visit-local-date");
}

async function openCard(page: Page, query = "") {
  await login(page);
  const response = await page.goto(cardPath() + query);
  await expect(page.getByRole("heading", { name: "Карточка записи" })).toBeVisible();
  await expect(page.locator(".reschedule-editor")).toBeVisible();
  return response;
}

async function prepareDraft(
  page: Page,
  options: {
    mode?: "KEEP_CURRENT" | "CATALOG";
    master?: "ANY" | string;
    localDate?: string;
    slot?: string;
  } = {},
) {
  const mode = options.mode ?? "KEEP_CURRENT";
  const master = options.master ?? demoMasterIds[0];
  const localDate = options.localDate ?? dateAtOffset(2);
  const slot = options.slot ?? (mode === "CATALOG" ? "10:00–10:45" : "10:45–11:20");

  if (mode === "CATALOG") {
    await page
      .getByRole("radio", { name: /Применить актуальную услугу: Мужская стрижка · демо/ })
      .check();
  } else {
    await page.getByRole("radio", { name: /Оставить текущую услугу и условия записи/ }).check();
  }
  await page
    .getByRole("radio", {
      name:
        master === "ANY"
          ? "Любой свободный мастер (ANY)"
          : master === demoMasterIds[0]
            ? "Алексей · демо"
            : "Михаил · демо",
      exact: true,
    })
    .check();
  await dateSelect(page).selectOption(localDate);
  await availabilityButton(page).click();
  await expect(page.getByRole("button", { name: slot, exact: true })).toBeVisible();
  await page.getByRole("button", { name: slot, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Подтверждение переноса" })).toBeVisible();
  return { localDate, slot };
}

async function assertOnlySafeBrowserState(page: Page) {
  const allowedQuery = new Set([
    "date",
    "status",
    "masterId",
    "page",
    "historyPage",
    "visitUpdated",
  ]);
  expect([...new URL(page.url()).searchParams.keys()].every((key) => allowedQuery.has(key))).toBe(
    true,
  );
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
  expect((await page.context().cookies()).map((cookie) => cookie.name)).toEqual([
    sessionCookie().name,
  ]);
}

test("KEEP_CURRENT переносит запись, сохраняет filters/historyPage и делает полное чтение", async ({
  page,
}) => {
  const query =
    `?date=${dateAtOffset(1)}&status=ALL&masterId=${demoMasterIds[0]}` + "&page=2&historyPage=3";
  const firstResponse = await openCard(page, query);
  const firstCsp = firstResponse?.headers()["content-security-policy"];

  const editor = page.locator(".reschedule-editor");
  await expect(editor.getByRole("heading", { name: "Параметры визита" })).toBeVisible();
  await expect(editor).toContainText("Историческая стрижка");
  await expect(editor).toContainText("1 234,56 ₽");
  await expect(editor).toContainText("35 мин");
  await expect(
    editor.getByText(
      "Автоматическое уведомление о переносе пока не отправляется. Свяжитесь с клиентом самостоятельно.",
      { exact: true },
    ),
  ).toBeVisible();

  const { localDate } = await prepareDraft(page, { master: demoMasterIds[1] });
  await expect(page.getByRole("region", { name: "Было" })).toContainText("Историческая стрижка");
  await expect(page.getByRole("region", { name: "Станет" })).toContainText("Михаил · демо");
  await expect(saveButton(page)).toBeDisabled();
  const confirmation = page.getByLabel("Подтверждаю изменение параметров этого визита");
  await confirmation.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(saveButton(page)).toBeFocused();

  const navigated = page.waitForResponse(
    (response) =>
      response.request().resourceType() === "document" &&
      new URL(response.url()).pathname === cardPath() &&
      new URL(response.url()).searchParams.get("visitUpdated") === "1",
  );
  await page.keyboard.press("Enter");
  const finalResponse = await navigated;
  await expect(page).toHaveURL(new RegExp(`${cardPath()}\\?.*visitUpdated=1`));
  await expect(
    page.getByText("Параметры визита сохранены. Карточка полностью перечитана.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(finalResponse.headers()["content-security-policy"]).not.toBe(firstCsp);

  const params = new URL(page.url()).searchParams;
  expect(Object.fromEntries(params)).toEqual({
    date: dateAtOffset(1),
    status: "ALL",
    masterId: demoMasterIds[0],
    page: "2",
    historyPage: "3",
    visitUpdated: "1",
  });
  const saved = await db.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
    include: { statusHistory: true },
  });
  expect(saved).toMatchObject({
    version: 1,
    status: "SCHEDULED",
    serviceId: demoServiceIds[0],
    serviceNameSnapshot: "Историческая стрижка",
    servicePriceSnapshot: 123_456,
    serviceDurationSnapshot: 35,
    masterId: demoMasterIds[1],
    masterSelection: "SPECIFIC",
    startsAt: startsAt(localDate, 10, 45),
    endsAt: startsAt(localDate, 11, 20),
  });
  expect(saved.statusHistory).toHaveLength(1);
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
  await assertOnlySafeBrowserState(page);
});

test("CATALOG с тем же serviceId явно применяет актуальные условия и ANY", async ({ page }) => {
  await openCard(page);
  const current = page.getByRole("radio", {
    name: /Оставить текущую услугу и условия записи/,
  });
  const catalog = page.getByRole("radio", {
    name: /Применить актуальную услугу: Мужская стрижка · демо/,
  });
  await expect(current).toBeChecked();
  await expect(current.locator("xpath=..")).toContainText("Историческая стрижка");
  await expect(current.locator("xpath=..")).toContainText("35 мин");
  await expect(catalog.locator("xpath=..")).toContainText(/1\s*800,00\s*₽/);
  await expect(catalog.locator("xpath=..")).toContainText("45 мин");
  await expect(catalog.locator("xpath=..")).toContainText(
    "Это та же услуга по ID, но выбор применит её актуальные условия.",
  );

  const { localDate } = await prepareDraft(page, { mode: "CATALOG", master: "ANY" });
  await expect(page.getByRole("region", { name: "Было" })).toContainText("35 мин");
  const after = page.getByRole("region", { name: "Станет" });
  await expect(after).toContainText("Мужская стрижка · демо");
  await expect(after).toContainText("45 мин");
  await expect(after).toContainText("Любой свободный мастер");
  await page.getByLabel("Подтверждаю изменение параметров этого визита").check();
  await saveButton(page).click();
  await expect(page).toHaveURL(new RegExp(`${cardPath()}\\?.*visitUpdated=1`));

  const saved = await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  expect(saved).toMatchObject({
    version: 1,
    serviceId: demoServiceIds[0],
    serviceNameSnapshot: "Мужская стрижка · демо",
    servicePriceSnapshot: 180_000,
    serviceDurationSnapshot: 45,
    masterSelection: "ANY",
    masterId: demoMasterIds[0],
    startsAt: startsAt(localDate, 10),
    endsAt: startsAt(localDate, 10, 45),
  });
  await assertOnlySafeBrowserState(page);
});

for (const status of ["COMPLETED", "NO_SHOW", "CANCELLED"] as const) {
  test(`${status} не показывает перенос и сохраняет отдельные правила контактов`, async ({
    page,
  }) => {
    await db.appointment.update({
      where: { id: appointmentId },
      data: {
        status,
        ...(status === "CANCELLED"
          ? { cancelledAt: new Date(), cancelledBy: "ADMIN", cancellationReason: "Тест" }
          : {}),
      },
    });
    await login(page);
    await page.goto(cardPath());
    await expect(page.locator(".reschedule-editor")).toHaveCount(0);
    if (status === "CANCELLED") {
      await expect(
        page.getByText(/Отменённая запись хранится как единое историческое состояние/),
      ).toBeVisible();
      await expect(page.getByLabel("Имя клиента", { exact: true })).toHaveCount(0);
      await expect(
        page.getByText("Отменённая запись хранится как историческая и не редактируется.", {
          exact: true,
        }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByText(/Параметры завершённого визита больше не редактируются/),
      ).toBeVisible();
      await expect(page.getByLabel("Имя клиента", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Сохранить имя и телефон" })).toBeVisible();
    }
  });
}

test("устаревший черновик получает CONFLICT, остаётся видимым и не повторяется", async ({
  page,
}) => {
  await openCard(page);
  const draft = await prepareDraft(page, { master: demoMasterIds[1] });
  await page.getByLabel("Подтверждаю изменение параметров этого визита").check();

  const other = await page.context().newPage();
  await other.goto(cardPath());
  await other.getByLabel("Имя клиента", { exact: true }).fill("Исправленный клиент");
  await other.getByLabel("Телефон клиента", { exact: true }).fill("8 (999) 111-22-33");
  await other.getByRole("button", { name: "Сохранить имя и телефон", exact: true }).click();
  await expect(other).toHaveURL(/contactsUpdated=1/);
  await expect
    .poll(
      async () =>
        (await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).version,
    )
    .toBe(1);

  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === cardPath()) posts++;
  });
  await saveButton(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Запись уже изменилась. Черновик сохранён в этой вкладке",
  );
  await expect(page.getByRole("radio", { name: "Михаил · демо", exact: true })).toBeChecked();
  await expect(dateSelect(page)).toHaveValue(draft.localDate);
  await expect(page.getByRole("button", { name: draft.slot, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Подтверждаю изменение параметров этого визита")).toBeChecked();
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.getByRole("link", { name: "Сверить карточку в новой вкладке" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Полностью перечитать эту карточку" })).toBeVisible();
  expect(posts).toBe(1);
  const saved = await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  expect(saved).toMatchObject({
    version: 1,
    clientName: "Исправленный клиент",
    clientPhone: "+79991112233",
    masterId: demoMasterIds[0],
    serviceNameSnapshot: "Историческая стрижка",
  });
  await assertOnlySafeBrowserState(page);
});

test("занятый перед сохранением интервал сбрасывается и заменяется свежей availability", async ({
  page,
}) => {
  await openCard(page);
  const draft = await prepareDraft(page);
  await page.getByLabel("Подтверждаю изменение параметров этого визита").check();

  const service = await db.service.findUniqueOrThrow({ where: { id: demoServiceIds[0] } });
  const competitor = await createBookingService(db).createBooking({
    ...prepareBookingAttempt(),
    serviceId: demoServiceIds[0],
    expectedServiceTerms: publicServiceTerms(service).termsHash,
    expectedBusinessContext: businessContextHash(
      await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
    ),
    master: { type: "SPECIFIC", masterId: demoMasterIds[0] },
    localDate: draft.localDate,
    startsAt: startsAt(draft.localDate, 10, 45),
    clientName: "Вымышленный конкурент",
    clientPhone: "+79990000001",
  });
  expect(competitor.ok).toBe(true);

  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === cardPath()) posts++;
  });
  await saveButton(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Выбранный интервал уже недоступен",
  );
  await expect(page.getByRole("heading", { name: "Подтверждение переноса" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Алексей · демо", exact: true })).toBeChecked();
  await expect(dateSelect(page)).toHaveValue(draft.localDate);
  await expect(page.getByRole("button", { name: draft.slot, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "10:00–10:35", exact: true })).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  expect(posts).toBe(1);
  expect(await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).toMatchObject({
    version: 0,
    masterId: demoMasterIds[0],
    startsAt: startsAt(dateAtOffset(1), 10),
  });
  expect(await db.appointment.count()).toBe(2);
  expect(await db.bookingRequest.count()).toBe(2);
});

test("потерянный ответ после COMMIT блокирует повтор и сохраняет черновик в памяти вкладки", async ({
  page,
}) => {
  await openCard(page);
  const draft = await prepareDraft(page, { master: demoMasterIds[1] });
  await page.getByLabel("Подтверждаю изменение параметров этого визита").check();
  let posts = 0;
  await page.route(actionGlob(), async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });

  await saveButton(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Результат сохранения неизвестен",
  );
  await expect(page.getByRole("radio", { name: "Михаил · демо", exact: true })).toBeChecked();
  await expect(dateSelect(page)).toHaveValue(draft.localDate);
  await expect(page.getByRole("button", { name: draft.slot, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Подтверждаю изменение параметров этого визита")).toBeChecked();
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.getByRole("link", { name: "Сверить карточку в новой вкладке" })).toBeVisible();
  expect(posts).toBe(1);
  await assertOnlySafeBrowserState(page);

  await expect
    .poll(
      async () =>
        (await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).version,
    )
    .toBe(1);
  const fresh = await page.context().newPage();
  await fresh.goto(cardPath());
  await expect(fresh.locator(".appointment-facts")).toContainText("Михаил · демо");
  expect(await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).toMatchObject({
    version: 1,
    masterId: demoMasterIds[1],
  });
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
});

test("loading, late response, retryable error, empty day, focus and responsive layout", async ({
  page,
}, testInfo) => {
  await openCard(page);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`appointment-reschedule-${width}.png`),
      fullPage: true,
    });
  }
  const keepCurrent = page.getByRole("radio", {
    name: /Оставить текущую услугу и условия записи/,
  });
  await keepCurrent.focus();
  expect(await keepCurrent.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    "none",
  );

  const oldDate = dateAtOffset(2);
  const newDate = dateAtOffset(3);
  await dateSelect(page).selectOption(oldDate);
  let release!: () => void;
  let reached!: () => void;
  let delivered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  let first = true;
  await page.route(actionGlob(), async (route) => {
    if (route.request().method() !== "POST" || !first) return route.continue();
    first = false;
    reached();
    await gate;
    const response = await route.fetch();
    await route.fulfill({ response });
    delivered();
  });
  await availabilityButton(page).click();
  await started;
  await expect(page.getByText("Проверяем свободное время…", { exact: true })).toBeVisible();
  await dateSelect(page).selectOption(newDate);
  await expect(page.getByText("Свободное время ещё не запрошено.", { exact: true })).toBeVisible();
  release();
  await completed;
  await expect(dateSelect(page)).toHaveValue(newDate);
  await expect(page.getByText("Свободное время ещё не запрошено.", { exact: true })).toBeVisible();
  await page.unroute(actionGlob());

  await page.route(actionGlob(), async (route) => {
    if (route.request().method() === "POST") return route.abort("failed");
    return route.continue();
  });
  await availabilityButton(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Не удалось получить свободное время",
  );
  await expect(page.getByText("Свободное время не загружено.", { exact: true })).toBeVisible();
  await expect(availabilityButton(page)).toBeEnabled();
  await page.unroute(actionGlob());

  await availabilityButton(page).click();
  await expect(page.getByRole("button", { name: "10:00–10:35", exact: true })).toBeVisible();
  await db.scheduleException.create({
    data: {
      masterId: demoMasterIds[0],
      localDate: new Date(`${newDate}T00:00:00Z`),
      type: "DAY_OFF",
    },
  });
  await availabilityButton(page).click();
  await expect(
    page.getByText("На выбранную дату свободных интервалов нет.", { exact: true }),
  ).toBeVisible();
  await assertOnlySafeBrowserState(page);
});
