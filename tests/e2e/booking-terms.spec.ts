import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { seedDemo, demoServiceIds } from "../../scripts/demo-data";
import type { BookingPayload } from "../../src/modules/booking/client/attempt-storage";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/zaprosto_test_"))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url);
const storageKey = "zaprosto.booking.v1";
async function clear() {
  await db.appointment.deleteMany();
  await db.bookingRequest.deleteMany();
  await db.master.deleteMany();
  await db.service.deleteMany();
  await db.publicRateLimit.deleteMany();
}
test.beforeEach(async () => {
  await clear();
  await seedDemo(db);
  await db.service.update({
    where: { id: demoServiceIds[0] },
    data: { name: "Условия: стрижка", priceKopecks: 150000, durationMinutes: 35 },
  });
});
test.afterAll(async () => {
  await clear();
  await seedDemo(db);
  await db.$disconnect();
});
async function review(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Условия: стрижка/ }).click();
  await page.getByRole("button", { name: "Выбрать мастера →" }).click();
  await page.getByRole("button", { name: /Алексей · демо/ }).click();
  await page.getByRole("button", { name: "Выбрать время →" }).click();
  await page.getByLabel("Дата визита").selectOption({ index: 2 });
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить →" }).click();
  await page.getByLabel("Ваше имя").fill("Тест Клиент");
  await page.getByLabel("Номер телефона").fill("+79990000000");
  await page.getByRole("button", { name: "Проверить запись →" }).click();
}
async function noWrites() {
  expect(await db.bookingRequest.count()).toBe(0);
  expect(await db.appointment.count()).toBe(0);
  expect(await db.appointmentStatusHistory.count()).toBe(0);
}
async function refreshedReview(page: Page) {
  await expect(page.getByRole("button", { name: "Продолжить →" })).toBeDisabled();
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить →" }).click();
  await expect(page.getByLabel("Ваше имя")).toHaveValue("Тест Клиент");
  await expect(page.getByLabel("Номер телефона")).toHaveValue("+79990000000");
  await page.getByRole("button", { name: "Проверить запись →" }).click();
}
const changes = [
  {
    label: "только цена",
    data: { priceKopecks: 250000 },
    name: "Условия: стрижка",
    price: "2 500",
    duration: 35,
  },
  {
    label: "только длительность при доступном новом интервале",
    data: { durationMinutes: 60 },
    name: "Условия: стрижка",
    price: "1 500",
    duration: 60,
  },
  {
    label: "только название",
    data: { name: "Обновлённая стрижка" },
    name: "Обновлённая стрижка",
    price: "1 500",
    duration: 35,
  },
];
for (const change of changes) {
  test(change.label + ": отказ и явное повторное подтверждение", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await review(page);
    await expect(page.locator(".review-details")).toContainText("1 500");
    await expect(page.locator(".review-details")).toContainText("35 мин");
    const sent: BookingPayload[] = [];
    let availabilityRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/availability?")) availabilityRequests++;
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.postData()?.includes("clientPhone"))
        sent.push(JSON.parse(request.postData()!)[0]);
      await route.continue();
    });
    await db.service.update({ where: { id: demoServiceIds[0] }, data: change.data });
    await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
    await expect(page.getByText(/Условия услуги изменились/)).toBeVisible();
    const fresh = page.getByLabel("Обновлённые условия услуги");
    await expect(fresh).toContainText(change.name);
    await expect(fresh).toContainText(change.price);
    await expect(fresh).toContainText(change.duration + " мин");
    await expect(page.getByRole("button", { name: "10:00", exact: true })).toBeVisible();
    expect(availabilityRequests).toBeGreaterThan(0);
    expect(sent).toHaveLength(1); // Refresh never submits fresh terms automatically.
    await noWrites();
    await page.screenshot({ path: testInfo.outputPath("changed-terms-360.png"), fullPage: true });
    await refreshedReview(page);
    await expect(page.locator(".review-details")).toContainText(change.name);
    await expect(page.locator(".review-details")).toContainText(change.price);
    await expect(page.locator(".review-details")).toContainText(change.duration + " мин");
    await noWrites();
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath("reconfirm-" + width + ".png"),
        fullPage: true,
      });
    }
    await page
      .getByRole("button", { name: "Подтвердить обновлённые условия", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[1].expectedServiceTerms).not.toBe(sent[0].expectedServiceTerms);
    expect(sent[1].idempotencyKey).not.toBe(sent[0].idempotencyKey);
    const row = await db.appointment.findFirstOrThrow();
    expect(row.serviceNameSnapshot).toBe(change.name);
    expect(row.servicePriceSnapshot).toBe(change.data.priceKopecks ?? 150000);
    expect(row.serviceDurationSnapshot).toBe(change.duration);
    expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(change.duration * 60000);
    expect(await db.appointment.count()).toBe(1);
    expect(await db.bookingRequest.count()).toBe(1);
    expect(await db.appointmentStatusHistory.count()).toBe(1);
  });
}

for (const legacy of [false, true]) {
  test(
    "потеря успешного ответа, изменение каталога, reload и replay: " +
      (legacy ? "существующая booking-v1" : "новый формат"),
    async ({ page }) => {
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
      await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
      await expect.poll(() => db.appointment.count()).toBe(1);
      const pending = await page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key)!),
        storageKey,
      );
      const input: BookingPayload = pending.input;
      if (legacy) {
        // Emulate data persisted by the old deployment. No production code derives or rewrites v1.
        delete input.expectedServiceTerms;
        delete input.expectedBusinessContext;
        const requestHash = createHash("sha256")
          .update(
            JSON.stringify([
              "booking-v1",
              input.serviceId,
              input.master.type,
              input.master.type === "SPECIFIC" ? input.master.masterId : null,
              input.localDate,
              new Date(input.startsAt).toISOString(),
              input.clientName,
              input.clientPhone,
            ]),
          )
          .digest("hex");
        await db.bookingRequest.update({
          where: { idempotencyKey: input.idempotencyKey },
          data: { requestHash },
        });
        await page.evaluate(
          ({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)),
          { key: storageKey, value: pending },
        );
      }
      const before = await db.appointment.findFirstOrThrow({
        include: { statusHistory: true, bookingRequest: true },
      });
      const link = await page
        .getByRole("link", { name: "Проверить по защищённой ссылке" })
        .getAttribute("href");
      await db.service.update({
        where: { id: demoServiceIds[0] },
        data: { name: "После ответа", priceKopecks: 250000, durationMinutes: 60 },
      });
      await page.unroute("**/*");
      await page.reload();
      await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
      expect(
        await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).input, storageKey),
      ).toEqual(input);
      await page.getByRole("button", { name: "Повторить исходный запрос" }).click();
      await expect(page.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
      await expect(page.getByRole("region", { name: "Подтверждение записи" })).toContainText(
        "1 500",
      );
      await expect(page.getByRole("region", { name: "Подтверждение записи" })).toContainText(
        "35 мин",
      );
      expect(
        await page.getByRole("link", { name: "Открыть мою запись ↗" }).getAttribute("href"),
      ).toBe(link);
      expect(
        await db.appointment.findFirstOrThrow({
          include: { statusHistory: true, bookingRequest: true },
        }),
      ).toEqual(before);
      expect(await db.appointment.count()).toBe(1);
      await page.goto(link!);
      await expect(page.getByText("Запланирована", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Подтверждение записи" })).toContainText(
        "Условия: стрижка",
      );
    },
  );
}

test("старый sessionStorage без исхода не получает новую версию автоматически", async ({
  page,
}) => {
  await review(page);
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.postData()?.includes("clientPhone"))
      await route.abort("failed");
    else await route.continue();
  });
  await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
  await page.evaluate((key) => {
    const pending = JSON.parse(sessionStorage.getItem(key)!);
    delete pending.input.expectedServiceTerms;
    sessionStorage.setItem(key, JSON.stringify(pending));
  }, storageKey);
  await db.service.update({
    where: { id: demoServiceIds[0] },
    data: { priceKopecks: 250000, durationMinutes: 60 },
  });
  await page.unroute("**/*");
  await page.reload();
  await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
  await noWrites();
  await page.getByRole("button", { name: "Повторить исходный запрос" }).click();
  await expect(page.getByText(/Условия услуги изменились/)).toBeVisible();
  await expect(page.getByLabel("Обновлённые условия услуги")).toContainText("2 500");
  await expect(page.getByLabel("Обновлённые условия услуги")).toContainText("60 мин");
  await noWrites();
  await refreshedReview(page);
  await noWrites();
  await page.getByRole("button", { name: "Подтвердить обновлённые условия", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Вы записаны." })).toBeVisible();
  expect(await db.appointment.count()).toBe(1);
});

for (const mode of ["missing", "malformed", "forged"] as const) {
  test("неполный HTTP-запрос не обходит проверку: " + mode, async ({ page }) => {
    await review(page);
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.postData()?.includes("clientPhone")) {
        const body = JSON.parse(request.postData()!);
        if (mode === "missing") delete body[0].expectedServiceTerms;
        else body[0].expectedServiceTerms = mode === "malformed" ? "" : "0".repeat(64);
        await route.continue({ postData: JSON.stringify(body) });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
    await expect(
      page.getByText(
        mode === "malformed" ? /Запись не создана. Проверьте услугу/ : /Условия услуги изменились/,
      ),
    ).toBeVisible();
    await noWrites();
    await expect(page.getByRole("button", { name: "Продолжить →" })).toBeDisabled();
  });
}
test("удаление отпечатка существующей новой попытки не превращает неизвестный исход в новую запись", async ({
  page,
}) => {
  await review(page);
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.postData()?.includes("clientPhone")) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Подтвердить запись", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
  await expect.poll(() => db.appointment.count()).toBe(1);
  await page.evaluate((key) => {
    const pending = JSON.parse(sessionStorage.getItem(key)!);
    delete pending.input.expectedServiceTerms;
    sessionStorage.setItem(key, JSON.stringify(pending));
  }, storageKey);
  await page.unroute("**/*");
  await page.reload();
  await page.getByRole("button", { name: "Повторить исходный запрос" }).click();
  await expect(page.getByText(/Результат пока не подтверждён/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить исходный запрос" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Подтвердить запись", exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).state, storageKey),
  ).toBe("pending");
  expect(await db.appointment.count()).toBe(1);
  expect(await db.bookingRequest.count()).toBe(1);
  expect(await db.appointmentStatusHistory.count()).toBe(1);
});
