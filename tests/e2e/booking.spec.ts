import { businessContextHash } from "../../src/modules/settings/server/context";
import { publicServiceTerms } from "../../src/modules/catalog/server/service-terms";
import { expect, test, type Page } from "@playwright/test";
import { demoMasterIds, demoServiceIds } from "../../scripts/demo-data";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createBookingService } from "../../src/modules/booking/server/booking-service";
import { prepareBookingAttempt } from "../../src/modules/booking/server/booking-security";
import { getLocalDayInterval } from "../../src/modules/scheduling/time/business-time";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/zaprosto_test_"))
  throw new Error("E2E requires the isolated runner");
const db = createPrismaClient(databaseUrl);
test.beforeEach(async () => {
  await db.appointmentStatusHistory.deleteMany();
  await db.appointment.deleteMany();
  await db.bookingRequest.deleteMany();
  await db.publicRateLimit.deleteMany();
  await db.scheduleException.deleteMany();
});
test.afterAll(async () => {
  await db.$disconnect();
});
async function toTime(page: Page, any = false) {
  await page.goto("/");
  await page.getByRole("button", { name: /Мужская стрижка/ }).click();
  await page.getByRole("button", { name: "Выбрать мастера →" }).click();
  await page.getByRole("button", { name: any ? /Любой мастер/ : /Алексей · демо/ }).click();
  await page.getByRole("button", { name: "Выбрать время →" }).click();
  await page.getByLabel("Дата визита").selectOption({ index: 2 });
  await expect(page.getByRole("button", { name: "10:00", exact: true })).toBeVisible();
}
async function review(page: Page, phone = "8 (999) 000-00-00") {
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить →" }).click();
  await page.getByLabel("Ваше имя").fill("Вымышленный Клиент");
  await page.getByLabel("Номер телефона").fill(phone);
  await page.getByRole("button", { name: "Проверить запись →" }).click();
}
async function create(page: Page) {
  await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
}
test("конкретный мастер, подтверждение и явная отмена", async ({ page, request }) => {
  await toTime(page);
  await review(page);
  await create(page);
  const region = page.getByRole("region", { name: "Подтверждение записи" });
  await expect(region).toContainText("Алексей · демо");
  await expect(region).toContainText("+79990000000");
  const href = await page.getByRole("link", { name: "Открыть мою запись ↗" }).getAttribute("href");
  expect(href).toMatch(/^\/appointment#[A-Za-z0-9_-]{43}$/);
  const response = await request.get("/appointment", { headers: { purpose: "prefetch" } });
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  expect((await db.appointment.findFirstOrThrow()).status).toBe("SCHEDULED");
  await page.goto(href!);
  await expect(page.getByText("Запланирована", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Отменить запись", exact: true }).click();
  await expect(page.getByRole("button", { name: "Да, отменить запись" })).toBeDisabled();
  await page.getByLabel(/Причина отмены/).fill("Вымышленная причина");
  await page.getByLabel("Я хочу отменить эту запись").check();
  await page.getByRole("button", { name: "Да, отменить запись" }).click();
  await expect(page.getByText("Отменена", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Эта запись уже отменена. Повторная отмена не требуется."),
  ).toBeVisible();
  expect(await db.appointmentStatusHistory.count({ where: { newStatus: "CANCELLED" } })).toBe(1);
});
test("любой мастер назначается сервером, телефон с +7", async ({ page }) => {
  await toTime(page, true);
  await review(page, "+7 (999) 000-00-00");
  await create(page);
  const appointment = await db.appointment.findFirstOrThrow();
  expect(appointment.masterSelection).toBe("ANY");
  expect(demoMasterIds).toContain(appointment.masterId);
  await expect(page.getByRole("region", { name: "Подтверждение записи" })).toContainText(
    "Алексей · демо",
  );
});
test("неверный телефон не отправляется", async ({ page }) => {
  await toTime(page);
  await review(page, "+1 999 000-00-00");
  await expect(page.getByText("Укажите российский номер с +7 или 8 и 11 цифрами.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить запись", exact: true })).toHaveCount(
    0,
  );
  expect(await db.appointment.count()).toBe(0);
});
test("пустые окна и горизонт", async ({ page }) => {
  await toTime(page);
  const date = await page.getByLabel("Дата визита").inputValue();
  await db.scheduleException.create({
    data: { masterId: demoMasterIds[0], localDate: new Date(date + "T00:00:00Z"), type: "DAY_OFF" },
  });
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByText(/На эту дату свободных окон нет/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Продолжить →" })).toBeDisabled();
  await expect(page.getByLabel("Дата визита").locator("option")).toHaveCount(30);
});
test("конфликт сбрасывает слот и сохраняет контакты", async ({ page }) => {
  await toTime(page);
  const localDate = await page.getByLabel("Дата визита").inputValue();
  await review(page);
  const start = getLocalDayInterval(localDate, "Europe/Moscow").startsAt;
  start.setUTCHours(start.getUTCHours() + 10);
  const competitor = await createBookingService(db).createBooking({
    ...prepareBookingAttempt(),
    serviceId: demoServiceIds[0],
    expectedBusinessContext: businessContextHash(
      await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
    ),
    expectedServiceTerms: publicServiceTerms(
      await db.service.findUniqueOrThrow({ where: { id: demoServiceIds[0] } }),
    ).termsHash,
    master: { type: "SPECIFIC", masterId: demoMasterIds[0] },
    localDate,
    startsAt: start,
    clientName: "Вымышленный конкурент",
    clientPhone: "+79990000001",
  });
  expect(competitor.ok).toBe(true);
  await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(page.getByText(/Это время уже занято/)).toBeVisible();
  await expect(page.getByRole("button", { name: "10:00", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Продолжить →" })).toBeDisabled();
  await page.getByRole("button", { name: "10:45", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить →" }).click();
  await expect(page.getByLabel("Ваше имя")).toHaveValue("Вымышленный Клиент");
  await expect(page.getByLabel("Номер телефона")).toHaveValue("8 (999) 000-00-00");
});
test("двойной клик создаёт одну запись", async ({ page }) => {
  await toTime(page);
  await review(page);
  await page
    .getByRole("button", { name: "Подтвердить запись", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(page.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
});
test("потеря реального ответа и reload повторяют исходную пару", async ({ page }) => {
  await toTime(page);
  await review(page);
  let lost = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!lost && request.method() === "POST" && request.postData()?.includes("clientPhone")) {
      lost = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeVisible();
  await expect.poll(() => db.appointment.count()).toBe(1);
  const id = (await db.appointment.findFirstOrThrow()).id;
  await page.unroute("**/*");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Проверим предыдущую попытку" })).toBeVisible();
  await page.getByRole("button", { name: "Повторить исходный запрос" }).click();
  await expect(page.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
  expect(await db.appointment.count()).toBe(1);
  expect((await db.appointment.findFirstOrThrow()).id).toBe(id);
});
test("неверная ссылка и недопустимый статус", async ({ page }) => {
  await page.goto("/appointment#" + prepareBookingAttempt().cancellationToken);
  await expect(page.getByRole("heading", { name: "Ссылка недействительна" })).toBeVisible();
  await toTime(page);
  await review(page);
  await create(page);
  const href = await page.getByRole("link", { name: "Открыть мою запись ↗" }).getAttribute("href");
  await db.appointment.updateMany({ data: { status: "COMPLETED" } });
  await page.goto(href!);
  await expect(page.getByText("Статус «Выполнена» не допускает отмену.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить запись", exact: true })).toHaveCount(0);
});
test("время бизнеса в часовом поясе Los Angeles", async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  await toTime(page);
  await review(page);
  await create(page);
  await expect(page.getByRole("region", { name: "Подтверждение записи" })).toContainText("10:00");
  expect((await db.appointment.findFirstOrThrow()).startsAt.getUTCHours()).toBe(7);
  await context.close();
});
test("запоздалые окна и смена мастера", async ({ page }) => {
  await toTime(page);
  const oldDate = await page.getByLabel("Дата визита").inputValue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route("**/api/availability?**", async (route) => {
    if (route.request().url().includes(oldDate)) {
      entered();
      await gate;
      try {
        await route.fulfill({
          json: { ok: true, slots: [{ startsAt: oldDate + "T23:45:00+03:00" }] },
        });
      } catch {
        /* aborted old request */
      }
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await started;
  await page.getByLabel("Дата визита").selectOption({ index: 3 });
  await expect(page.getByRole("button", { name: "10:00", exact: true })).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: "23:45", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "← К мастерам" }).click();
  await page.getByRole("button", { name: /Михаил · демо/ }).click();
  await page.getByRole("button", { name: "Выбрать время →" }).click();
  await expect(page.getByRole("button", { name: "Продолжить →" })).toBeDisabled();
});
test("360, 390 и desktop: переполнение, фокус, снимки", async ({ page }, testInfo) => {
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.getByRole("button", { name: /Мужская стрижка/ }).focus();
    expect(
      await page
        .getByRole("button", { name: /Мужская стрижка/ })
        .evaluate((el) => getComputedStyle(el).outlineStyle),
    ).not.toBe("none");
    await page.screenshot({ path: testInfo.outputPath(`catalog-${width}.png`), fullPage: true });
  }
});

test("пустой каталог и отсутствие подходящих мастеров", async ({ page }) => {
  try {
    await db.service.updateMany({ data: { isActive: false } });
    await page.goto("/");
    await expect(page.getByText("Пока нет доступных услуг. Попробуйте зайти позже.")).toBeVisible();
    await db.service.updateMany({ data: { isActive: true } });
    await db.master.updateMany({ data: { isActive: false } });
    await page.reload();
    await page.getByRole("button", { name: /Мужская стрижка/ }).click();
    await page.getByRole("button", { name: "Выбрать мастера →" }).click();
    await expect(page.getByText(/Для этой услуги пока нет доступных мастеров/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Выбрать время →" })).toBeDisabled();
  } finally {
    await db.service.updateMany({ data: { isActive: true } });
    await db.master.updateMany({ data: { isActive: true } });
  }
});
test("недоступное хранилище не допускает create; сеть доступности можно повторить", async ({
  page,
}) => {
  await toTime(page);
  await page.route("**/api/availability?**", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByText(/Нет связи с сервером/)).toBeVisible();
  await page.unroute("**/api/availability?**");
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByRole("button", { name: "10:00", exact: true })).toBeVisible();
  await review(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "zaprosto.booking.v1")
        throw new DOMException("Unavailable", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(page.getByText(/Запрос на создание не отправлен/)).toBeVisible();
  expect(await db.appointment.count()).toBe(0);
});
test("HTTP лимит и Origin нельзя обойти forwarded заголовками", async ({ page, request }) => {
  await db.publicRateLimit.create({
    data: { key: "availability:shared", hits: 120, expiresAt: new Date(Date.now() + 60000) },
  });
  const limited = await request.get(
    "/api/availability?serviceId=" + demoServiceIds[0] + "&localDate=2026-09-01",
  );
  expect(limited.status()).toBe(429);
  expect(limited.headers()["retry-after"]).toBe("60");
  await db.publicRateLimit.deleteMany();
  await toTime(page);
  await review(page);
  let captured: { body: string; headers: Record<string, string> } | undefined;
  await page.route("**/*", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postData()?.includes("clientPhone")
    ) {
      captured = { body: route.request().postData()!, headers: await route.request().allHeaders() };
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeVisible();
  expect(captured).toBeDefined();
  const denied = await request.post("/", {
    data: captured!.body,
    headers: {
      ...captured!.headers,
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
    },
  });
  const body = await denied.text();
  expect(body).toContain("FORBIDDEN");
  expect(body).not.toContain("Prisma");
  expect(await db.appointment.count()).toBe(0);
});
test("визуальная проверка всех шагов и копирование ссылки", async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 900 });
  await toTime(page);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`time-${width}.png`), fullPage: true });
  }
  await review(page);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`review-${width}.png`), fullPage: true });
  }
  await create(page);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`confirmation-${width}.png`),
      fullPage: true,
    });
  }
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Копировать ссылку" }).click();
  await expect(page.getByText("Ссылка скопирована")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("/appointment#");
  await page.goto(copied);
  await expect(page.getByText("Запланирована", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 900 });
  await page.getByRole("button", { name: "Отменить запись", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("cancellation-360.png"), fullPage: true });
  expect(errors).toEqual([]);
});

async function skipToMainWithKeyboard(page: Page) {
  const originalUrl = page.url();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("button", { name: "К содержимому", exact: true });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  expect(page.url()).toBe(originalUrl);
}

test("skip-link сохраняет секрет реальной записи и переносит фокус", async ({ page }, testInfo) => {
  await toTime(page);
  await review(page);
  await create(page);
  const href = await page.getByRole("link", { name: "Открыть мою запись ↗" }).getAttribute("href");
  expect(href).toMatch(/^\/appointment#[A-Za-z0-9_-]{43}$/);
  for (const width of [360, 1440]) {
    // Open the protected link in a fresh tab: navigating to the same fragment
    // in an existing document preserves its previous keyboard focus.
    const appointmentPage = await page.context().newPage();
    try {
      await appointmentPage.setViewportSize({ width, height: 900 });
      await appointmentPage.goto(href!);
      await expect(appointmentPage.getByText("Запланирована", { exact: true })).toBeVisible();
      await skipToMainWithKeyboard(appointmentPage);
      const confirmation = appointmentPage.getByRole("region", { name: "Подтверждение записи" });
      await expect(confirmation).toContainText("Вымышленный Клиент");
      await expect(confirmation).toContainText("Алексей · демо");
      await expect(
        appointmentPage.getByRole("heading", { name: "Ссылка недействительна" }),
      ).toHaveCount(0);
      await expect(
        appointmentPage.getByRole("button", { name: "Отменить запись", exact: true }),
      ).toBeEnabled();
      await appointmentPage.screenshot({
        path: testInfo.outputPath("skip-appointment-" + width + ".png"),
        fullPage: true,
      });
      for (const control of [
        appointmentPage.getByRole("link", { name: "Открыть мою запись ↗" }),
        appointmentPage.getByRole("button", { name: "Копировать ссылку" }),
        appointmentPage.getByRole("button", { name: "Обновить статус" }),
        appointmentPage.getByRole("button", { name: "Отменить запись", exact: true }),
      ]) {
        await appointmentPage.keyboard.press("Tab");
        await expect(control).toBeFocused();
      }
      await appointmentPage.keyboard.press("Enter");
      await expect(
        appointmentPage.getByRole("heading", { name: "Подтвердите отмену" }),
      ).toBeVisible();
      await expect(appointmentPage.getByLabel("Я хочу отменить эту запись")).toBeEnabled();
      expect(new URL(appointmentPage.url()).pathname + new URL(appointmentPage.url()).hash).toBe(
        href,
      );
      expect(new URL(appointmentPage.url()).search).toBe("");
    } finally {
      await appointmentPage.close();
    }
  }
  expect((await db.appointment.findFirstOrThrow()).status).toBe("SCHEDULED");
});

for (const available of [true, false]) {
  test(`skip-link на главной: каталог ${available ? "доступен" : "недоступен"}`, async ({
    page,
  }, testInfo) => {
    const settings = await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } });
    try {
      if (!available) await db.businessSettings.delete({ where: { id: 1 } });
      for (const width of [360, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1 })).toContainText(
          available ? "Хорошая стрижка" : "Пока не можем показать расписание",
        );
        if (available)
          await expect(page.getByRole("button", { name: /Мужская стрижка/ })).toBeVisible();
        await skipToMainWithKeyboard(page);
        await page.screenshot({
          path: testInfo.outputPath("skip-home-" + width + ".png"),
          fullPage: true,
        });
        await page.keyboard.press("Tab");
        await expect(
          available
            ? page.getByRole("button", { name: /01 Услуга/ })
            : page.getByRole("link", { name: "Обновить страницу" }),
        ).toBeFocused();
      }
    } finally {
      if (!available) await db.businessSettings.create({ data: settings });
    }
  });
}
