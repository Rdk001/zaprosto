import { randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { hashPassword } from "../../src/modules/auth/server/password";
import { seedDemo, demoMasterIds } from "../../scripts/demo-data";
import {
  prepareBookingAttempt,
  hashBookingToken,
} from "../../src/modules/booking/server/booking-security";
import { createClientAppointmentService } from "../../src/modules/appointments/server/client-appointment-service";
import { businessContextHash } from "../../src/modules/settings/server/context";
import { localDateForInstant } from "../../src/modules/scheduling/time/business-time";
import type { AppointmentStatus } from "../../src/generated/prisma/client";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/zaprosto_test_[a-f0-9]+$/.test(new URL(url).pathname))
  throw new Error("Use isolated runner");
const db = createPrismaClient(url);
const credentials = { login: "appointments.e2e", password: randomBytes(24).toString("base64url") };
let passwordHash: string, id: string, serviceId: string, clientToken: string;
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
async function fixture(start = "2026-01-15T07:00:00Z", status: AppointmentStatus = "SCHEDULED") {
  const secret = prepareBookingAttempt();
  const row = await db.appointment.create({
    data: {
      bookingRequest: { create: { idempotencyKey: secret.idempotencyKey } },
      master: { connect: { id: demoMasterIds[0] } },
      service: { connect: { id: serviceId } },
      startsAt: new Date(start),
      endsAt: new Date(new Date(start).getTime() + 35 * 60000),
      clientName: "Вымышленный Клиент",
      clientPhone: "+79990000000",
      status,
      source: "ONLINE",
      masterSelection: "SPECIFIC",
      serviceNameSnapshot: "Историческая стрижка",
      servicePriceSnapshot: 123456,
      serviceDurationSnapshot: 35,
      cancellationTokenHash: hashBookingToken(secret.cancellationToken),
      ...(status === "CANCELLED"
        ? { cancelledAt: new Date(0), cancelledBy: "CLIENT" as const }
        : {}),
      statusHistory: { create: { previousStatus: null, newStatus: status, changedBy: "CLIENT" } },
    },
  });
  return { id: row.id, token: secret.cancellationToken };
}
test.beforeEach(async () => {
  await clear();
  await seedDemo(db);
  await db.businessSettings.update({
    where: { id: 1 },
    data: { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 },
  });
  await db.adminUser.create({ data: { login: credentials.login, passwordHash } });
  serviceId = (await db.service.findFirstOrThrow()).id;
  const a = await fixture();
  id = a.id;
  clientToken = a.token;
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
const path = () => "/admin/appointments/" + id;
const save = (page: Page) => page.getByRole("button", { name: "Сохранить статус", exact: true });
const saveContacts = (page: Page) =>
  page.getByRole("button", { name: "Сохранить имя и телефон", exact: true });
async function fillContacts(
  page: Page,
  name = "Исправленный вымышленный клиент",
  phone = "8 (999) 111-22-33",
) {
  await page.getByLabel("Имя клиента", { exact: true }).fill(name);
  await page.getByLabel("Телефон клиента", { exact: true }).fill(phone);
}
async function choose(page: Page, status = "CANCELLED", reason = "Вымышленная причина") {
  await page.getByRole("combobox", { name: "Новый статус", exact: true }).selectOption(status);
  if (status === "CANCELLED") {
    await page.getByLabel("Причина отмены (необязательно)").fill(reason);
    await page.getByLabel("Подтверждаю отмену записи", { exact: true }).check();
  }
}
function waitAction(page: Page) {
  return page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === path());
}
function actionHeaders(req: Request, origin = "http://localhost:3108") {
  return {
    "content-type": "text/plain;charset=UTF-8",
    "next-action": req.headers()["next-action"],
    origin,
  };
}
async function currentInput(status = "CANCELLED") {
  const a = await db.appointment.findUniqueOrThrow({ where: { id } });
  return {
    id,
    status,
    version: a.version,
    confirmed: true,
    expectedBusinessContext: businessContextHash(
      await db.businessSettings.findUniqueOrThrow({ where: { id: 1 } }),
    ),
  };
}
test("journal defaults, past/future, cancelled/master filters, snapshots and navigation", async ({
  page,
}, info) => {
  await fixture("2026-01-15T08:00Z", "CANCELLED");
  await fixture("2099-01-15T08:00Z");
  await db.service.update({
    where: { id: serviceId },
    data: {
      name: "Новое название каталога",
      priceKopecks: 999999,
      durationMinutes: 90,
      isActive: false,
    },
  });
  await db.master.update({ where: { id: demoMasterIds[0] }, data: { isActive: false } });
  await login(page);
  await page.getByRole("link", { name: "Записи", exact: true }).click();
  await expect(page.getByLabel("Дата визитов")).toHaveValue(
    localDateForInstant(new Date(), "Europe/Moscow"),
  );
  await expect(page.getByRole("combobox", { name: "Статус", exact: true })).toHaveValue("ACTIVE");
  await page.getByLabel("Дата визитов").fill("2026-01-15");
  await page.getByRole("button", { name: "Показать записи" }).click();
  await expect(page.locator(".journal-item")).toHaveCount(1);
  await expect(page.locator(".journal-item")).toContainText("Историческая стрижка");
  await expect(page.locator(".journal-item")).toContainText("35 мин");
  await expect(page.locator(".journal-item")).not.toContainText("Новое название каталога");
  await page.getByRole("combobox", { name: "Статус", exact: true }).selectOption("ALL");
  await page.getByRole("combobox", { name: "Мастер", exact: true }).selectOption(demoMasterIds[0]);
  await page.getByRole("button", { name: "Показать записи" }).click();
  await expect(page.locator(".journal-item")).toHaveCount(2);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("journal-" + width + ".png"), fullPage: true });
  }
  const journalUrl = page.url();
  await page.getByRole("link", { name: "Историческая стрижка" }).first().click();
  await expect(page.getByRole("heading", { name: "Карточка записи" })).toBeVisible();
  await expect(page.locator(".appointment-facts")).toContainText("+79990000000");
  expect(page.url()).not.toContain("7999");
  await page.getByRole("link", { name: "Вернуться к журналу" }).click();
  expect(new URL(page.url()).searchParams.get("masterId")).toBe(
    new URL(journalUrl).searchParams.get("masterId"),
  );
  await expect(page.getByRole("combobox", { name: "Статус", exact: true })).toHaveValue("ALL");
  await page.getByRole("combobox", { name: "Статус", exact: true }).selectOption("CANCELLED");
  await page.getByRole("button", { name: "Показать записи" }).click();
  await expect(page.locator(".journal-item")).toHaveCount(1);
  await page.getByLabel("Дата визитов").fill("2099-01-15");
  await page.getByRole("combobox", { name: "Статус", exact: true }).selectOption("ACTIVE");
  await page.getByRole("button", { name: "Показать записи" }).click();
  await expect(page.locator(".journal-item")).toHaveCount(1);
});
test("list and history pagination preserve filters and do not truncate", async ({ page }) => {
  for (let i = 0; i < 26; i++) await fixture("2026-01-15T07:00Z", "CANCELLED");
  await db.appointmentStatusHistory.createMany({
    data: Array.from({ length: 26 }, () => ({
      appointmentId: id,
      previousStatus: "COMPLETED",
      newStatus: "NO_SHOW",
      changedBy: "SYSTEM",
      changedAt: new Date(0),
    })),
  });
  await login(page);
  await page.goto("/admin/appointments?date=2026-01-15&status=ALL&masterId=" + demoMasterIds[0]);
  await expect(page.locator(".journal-item")).toHaveCount(25);
  await page.getByRole("link", { name: "Следующая страница", exact: true }).click();
  await expect(page.locator(".journal-item")).toHaveCount(2);
  await page.getByRole("link", { name: "Историческая стрижка" }).first().click();
  await page.getByRole("link", { name: "Вернуться к журналу" }).click();
  expect(new URL(page.url()).searchParams.get("page")).toBe("2");
  await page.goto(path() + "?date=2026-01-15&status=ALL&page=2");
  await expect(page.locator(".status-history li")).toHaveCount(25);
  await page.getByRole("link", { name: "Следующие события" }).click();
  await expect(page.locator(".status-history li")).toHaveCount(2);
  await page.getByRole("link", { name: "Вернуться к журналу" }).click();
  expect(new URL(page.url()).searchParams.get("page")).toBe("2");
});
test("confirmed cancellation, keyboard, full navigation, history and responsive detail", async ({
  page,
}, info) => {
  await login(page);
  await page.goto(path());
  await page.getByLabel("Новый статус").selectOption("CANCELLED");
  await expect(save(page)).toBeDisabled();
  await expect(
    page.getByText("Автоматические уведомления ещё не реализованы.", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Причина отмены (необязательно)")
    .fill("Вымышленная причина\nВторая строка");
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("detail-" + width + ".png"), fullPage: true });
  }
  await page.getByLabel("Подтверждаю отмену записи", { exact: true }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(save(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".appointment-status-label")).toHaveText("Отменена");
  await expect(page.locator(".status-history")).toContainText("Запланирована → Отменена");
  await expect(page.locator(".status-history")).toContainText("Вымышленная причина");
  await expect(save(page)).toHaveCount(0);
  const a = await db.appointment.findUniqueOrThrow({
    where: { id },
    include: { statusHistory: true },
  });
  expect(a.statusHistory).toHaveLength(2);
  expect(a.version).toBe(1);
  expect(a.cancelledBy).toBe("ADMIN");
});
test("result corrections and future result error focus", async ({ page }) => {
  await login(page);
  await page.goto(path());
  for (const [status, label] of [
    ["COMPLETED", "Выполнена"],
    ["NO_SHOW", "Клиент не пришёл"],
    ["COMPLETED", "Выполнена"],
  ]) {
    await choose(page, status);
    await save(page).click();
    await expect(page.locator(".appointment-status-label")).toHaveText(label);
    await expect(page.getByLabel("Новый статус").locator('option[value="CANCELLED"]')).toHaveCount(
      0,
    );
  }
  expect(await db.appointmentStatusHistory.count({ where: { appointmentId: id } })).toBe(4);
  const future = await fixture("2099-01-01T07:00Z");
  await page.goto("/admin/appointments/" + future.id);
  await choose(page, "COMPLETED");
  await save(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Визит ещё не начался");
  await expect(page.locator(".catalog-status")).toBeFocused();
  expect((await db.appointment.findUniqueOrThrow({ where: { id: future.id } })).version).toBe(0);
});
for (const conflict of ["admin", "client", "timezone", "ABA"] as const)
  test("stale form preserves reason: " + conflict, async ({ page }) => {
    await login(page);
    await page.goto(path());
    await choose(page);
    const other = await page.context().newPage();
    if (conflict === "client")
      await createClientAppointmentService(db).cancelBooking({
        token: clientToken,
        confirmed: true,
      });
    else if (conflict === "timezone") {
      await other.goto("/admin/settings");
      await other.getByLabel("Часовой пояс бизнеса", { exact: true }).fill("Europe/Berlin");
      await other.getByLabel("Подтверждаю смену зоны и понимаю последствия").check();
      await other.getByRole("button", { name: "Сохранить настройки" }).click();
      await expect(other.getByText(/Настройки сохранены\./)).toBeVisible();
    } else {
      await other.goto(path());
      await choose(other, "COMPLETED");
      await save(other).click();
      await expect(other.locator(".appointment-status-label")).toHaveText("Выполнена");
      if (conflict === "ABA") {
        await page.reload();
        await choose(page, "NO_SHOW");
        for (const status of ["NO_SHOW", "COMPLETED"]) {
          await choose(other, status);
          await save(other).click();
          await expect(other.locator(".appointment-status-label")).toHaveText(
            status === "NO_SHOW" ? "Клиент не пришёл" : "Выполнена",
          );
        }
      }
    }
    const before = await db.appointment.findUniqueOrThrow({
      where: { id },
      include: { statusHistory: true },
    });
    await save(page).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "Запись или настройки времени уже изменились",
    );
    await expect(save(page)).toBeDisabled();
    if (conflict !== "ABA")
      await expect(page.getByLabel("Причина отмены (необязательно)")).toHaveValue(
        "Вымышленная причина",
      );
    await expect(
      page.getByRole("link", { name: "Сверить карточку (новая вкладка)" }),
    ).toBeVisible();
    await expect(page.locator(".catalog-status")).toBeFocused();
    expect(
      await db.appointment.findUniqueOrThrow({ where: { id }, include: { statusHistory: true } }),
    ).toEqual(before);
  });
for (const commit of [false, true])
  test(
    "unknown outcome " +
      (commit ? "after commit" : "before commit") +
      ", pending and no automatic retry",
    async ({ page }) => {
      await login(page);
      await page.goto(path());
      await choose(page);
      let posts = 0,
        release!: () => void,
        reached!: () => void;
      const gate = new Promise<void>((r) => {
          release = r;
        }),
        ready = new Promise<void>((r) => {
          reached = r;
        });
      await page.route("**/admin/appointments/**", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        if (commit) expect((await route.fetch()).ok()).toBe(true);
        reached();
        await gate;
        await route.abort("failed");
      });
      await save(page).click();
      await ready;
      await expect(page.getByText("Сохраняем статус…")).toBeVisible();
      await expect(save(page)).toBeDisabled();
      release();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("Результат неизвестен");
      await expect(page.getByLabel("Причина отмены (необязательно)")).toHaveValue(
        "Вымышленная причина",
      );
      await expect(save(page)).toBeDisabled();
      await page.getByLabel("Причина отмены (необязательно)").press("Tab");
      await expect(page.locator(".appointment-status-label")).toHaveText("Запланирована");
      const fresh = await page.context().newPage();
      await fresh.goto(path());
      await expect(fresh.locator(".appointment-status-label")).toHaveText(
        commit ? "Отменена" : "Запланирована",
      );
      expect(posts).toBe(1);
      expect((await db.appointment.findUniqueOrThrow({ where: { id } })).version).toBe(
        commit ? 1 : 0,
      );
      expect(await db.appointmentStatusHistory.count({ where: { appointmentId: id } })).toBe(
        commit ? 2 : 1,
      );
    },
  );
for (const mode of ["missing", "expired", "revoked", "disabled"] as const)
  test("direct Action and protected GET deny session " + mode, async ({ page }) => {
    await login(page);
    await page.goto(path());
    const captured = waitAction(page);
    await choose(page, "COMPLETED");
    await save(page).click();
    const req = await captured;
    await expect(page.locator(".appointment-status-label")).toHaveText("Выполнена");
    const intent = await currentInput("NO_SHOW");
    if (mode === "expired") await db.adminSession.updateMany({ data: { expiresAt: new Date(0) } });
    if (mode === "revoked") await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
    if (mode === "disabled") await db.adminUser.updateMany({ data: { isActive: false } });
    const headers = { ...actionHeaders(req), ...(mode === "missing" ? { cookie: "" } : {}) };
    const result = await page.request.post(path(), { headers, data: JSON.stringify([intent]) });
    const body = await result.text();
    expect(body).toContain("UNAUTHORIZED");
    expect(body).not.toContain("+79990000000");
    for (const p of ["/admin/appointments", path()]) {
      const get = await page.request.get(p, { headers: mode === "missing" ? { cookie: "" } : {} });
      expect(get.url()).toContain("/admin/login");
      expect(await get.text()).not.toContain("+79990000000");
    }
    expect((await db.appointment.findUniqueOrThrow({ where: { id } })).version).toBe(1);
  });
test("direct Action DTO/Origin/repeat, GET no writes, no-store and fresh CSP", async ({ page }) => {
  await login(page);
  await page.goto(path());
  const before = await db.appointment.findUniqueOrThrow({
    where: { id },
    include: { statusHistory: true },
  });
  const get1 = await page.request.get(path()),
    get2 = await page.request.get(path());
  expect(get1.headers()["cache-control"]).toContain("no-store");
  expect(get1.headers()["content-security-policy"]).toContain("nonce-");
  expect(get1.headers()["content-security-policy"]).not.toBe(
    get2.headers()["content-security-policy"],
  );
  const body = await get1.text();
  expect(body).not.toMatch(/cancellationTokenHash|tokenHash|passwordHash/);
  expect(body).not.toContain(clientToken);
  expect(
    await db.appointment.findUniqueOrThrow({ where: { id }, include: { statusHistory: true } }),
  ).toEqual(before);
  // Capture a real rejected (future) action without changing this visit.
  const future = await fixture("2099-01-01T07:00Z");
  await page.goto("/admin/appointments/" + future.id);
  const captured = page.waitForRequest((r) => r.method() === "POST" && r.url().includes(future.id));
  await choose(page, "COMPLETED");
  await save(page).click();
  const req = await captured;
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Визит ещё не начался");
  const intent = await currentInput();
  for (const extra of [
    { changedBy: "CLIENT" },
    { changedByAdminId: randomUUID() },
    { reason: "x".repeat(1001) },
    { version: "0" },
    { status: "BAD" },
    { id: "bad" },
    { confirmed: "true" },
  ]) {
    const r = await page.request.post(path(), {
      headers: actionHeaders(req),
      data: JSON.stringify([{ ...intent, ...extra }]),
    });
    expect(await r.text()).toContain("INVALID_INPUT");
  }
  const unconfirmed = await page.request.post(path(), {
    headers: actionHeaders(req),
    data: JSON.stringify([{ ...intent, confirmed: false }]),
  });
  expect(await unconfirmed.text()).toContain("CONFIRMATION_REQUIRED");
  const foreign = await page.request.post(path(), {
    headers: actionHeaders(req, "https://evil.example"),
    data: JSON.stringify([intent]),
  });
  expect(foreign.status() >= 400 || (await foreign.text()).includes("FORBIDDEN")).toBe(true);
  expect(
    await db.appointment.findUniqueOrThrow({ where: { id }, include: { statusHistory: true } }),
  ).toEqual(before);
  const success = await page.request.post(path(), {
    headers: actionHeaders(req),
    data: JSON.stringify([intent]),
  });
  expect(await success.text()).toContain('"ok":true');
  const cancelled = await db.appointment.findUniqueOrThrow({
    where: { id },
    include: { statusHistory: true },
  });
  const repeat = await page.request.post(path(), {
    headers: actionHeaders(req),
    data: JSON.stringify([intent]),
  });
  expect(await repeat.text()).toContain("CONFLICT");
  expect(
    await db.appointment.findUniqueOrThrow({ where: { id }, include: { statusHistory: true } }),
  ).toEqual(cancelled);
});
test("business DST date differs from browser zone", async ({ browser }) => {
  await db.businessSettings.update({ where: { id: 1 }, data: { timezone: "Europe/Berlin" } });
  const a = await fixture("2026-10-24T22:30:00Z");
  const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
  try {
    const page = await context.newPage();
    await login(page);
    await page.goto("/admin/appointments?date=2026-10-25");
    await expect(page.locator(".journal-item")).toHaveCount(1);
    await expect(page.locator(".journal-time")).toHaveText("00:30–01:05");
    await page.getByRole("link", { name: "Историческая стрижка" }).click();
    expect(page.url()).toContain(a.id);
    await expect(page.locator(".appointment-facts")).toContainText("25 октября 2026");
  } finally {
    await context.close();
  }
});
test("empty, missing and invalid query states are explicit", async ({ page }) => {
  await login(page);
  await page.goto("/admin/appointments?date=1900-01-01");
  await expect(page.getByRole("status")).toContainText("нет записей");
  await page.goto("/admin/appointments?date=2026-02-30");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Проверьте дату");
  await page.goto("/admin/appointments/" + randomUUID());
  await expect(page.getByRole("main").getByRole("alert")).toContainText("не найдены");
});

test("real Action rechecks access after appointment lock wait", async ({ page }) => {
  await login(page);
  await page.goto(path());
  await choose(page);
  const before = await db.appointment.findUniqueOrThrow({
    where: { id },
    include: { statusHistory: true },
  });
  let ready!: () => void, release!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      ready = r;
    });
  const holder = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id}::uuid FOR UPDATE`;
      ready();
      await gate;
    },
    { timeout: 10000 },
  );
  await started;
  try {
    await save(page).click();
    await expect
      .poll(async () => {
        const rows = await db.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        return Number(rows[0].count);
      })
      .toBeGreaterThan(0);
    await db.adminSession.updateMany({ data: { revokedAt: new Date() } });
  } finally {
    release();
    await holder;
  }
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Сеанс завершён");
  await expect(page.getByLabel("Причина отмены (необязательно)")).toHaveValue(
    "Вымышленная причина",
  );
  await expect(save(page)).toBeDisabled();
  expect(
    await db.appointment.findUniqueOrThrow({ where: { id }, include: { statusHistory: true } }),
  ).toEqual(before);
});

for (const status of ["SCHEDULED", "COMPLETED", "NO_SHOW"] as const)
  test("edit contacts for " + status + " with full nonce navigation", async ({ page }, info) => {
    const target =
      status === "SCHEDULED"
        ? { id, token: clientToken }
        : await fixture(
            status === "COMPLETED" ? "2026-01-15T08:00:00Z" : "2026-01-15T09:00:00Z",
            status,
          );
    const cardPath = "/admin/appointments/" + target.id;
    await login(page);
    const firstResponse = await page.goto(cardPath);
    const firstCsp = firstResponse?.headers()["content-security-policy"];
    await expect(page.getByLabel("Имя клиента", { exact: true })).toHaveValue("Вымышленный Клиент");
    await expect(page.getByLabel("Телефон клиента", { exact: true })).toHaveValue("+79990000000");
    await expect(saveContacts(page)).toBeDisabled();
    await fillContacts(page);
    await expect(page.getByText("Будет сохранён номер: +79991112233")).toBeVisible();
    if (status === "SCHEDULED") {
      for (const width of [360, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: info.outputPath("contact-editor-" + width + ".png"),
          fullPage: true,
        });
      }
      await page.getByLabel("Телефон клиента", { exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(saveContacts(page)).toBeFocused();
    }
    const navigation = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === cardPath &&
        new URL(response.url()).searchParams.get("contactsUpdated") === "1",
    );
    await saveContacts(page).click();
    const refreshed = await navigation;
    await expect(page.getByRole("status")).toContainText("Имя и телефон клиента сохранены");
    expect(new URL(page.url()).searchParams.get("contactsUpdated")).toBe("1");
    expect(refreshed.headers()["content-security-policy"]).toContain("nonce-");
    expect(refreshed.headers()["content-security-policy"]).not.toBe(firstCsp);
    await expect(page.locator(".appointment-facts")).toContainText(
      "Исправленный вымышленный клиент",
    );
    await expect(page.locator(".appointment-facts")).toContainText("+79991112233");
    const stored = await db.appointment.findUniqueOrThrow({
      where: { id: target.id },
      include: { statusHistory: true },
    });
    expect(stored).toMatchObject({
      status,
      version: 1,
      clientName: "Исправленный вымышленный клиент",
      clientPhone: "+79991112233",
    });
    expect(stored.statusHistory).toHaveLength(1);
    expect(await db.telegramLink.count({ where: { appointmentId: target.id } })).toBe(0);
    expect(await db.notificationOutbox.count({ where: { appointmentId: target.id } })).toBe(0);
  });

test("cancelled card has the historical message and no contact form", async ({ page }) => {
  const cancelled = await fixture("2026-01-15T08:00:00Z", "CANCELLED");
  await login(page);
  await page.goto("/admin/appointments/" + cancelled.id);
  await expect(
    page.getByText("Отменённая запись хранится как историческая и не редактируется.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Имя клиента", { exact: true })).toHaveCount(0);
  await expect(saveContacts(page)).toHaveCount(0);
});

test("contact validation and real-change detection are normalized", async ({ page }) => {
  await login(page);
  await page.goto(path());
  await fillContacts(page, "  Вымышленный Клиент  ", "8 (999) 000-00-00");
  await expect(page.getByText("Будет сохранён номер: +79990000000")).toBeVisible();
  await expect(saveContacts(page)).toBeDisabled();
  await page.getByLabel("Телефон клиента", { exact: true }).fill("+1 999 000-00-00");
  await expect(page.getByLabel("Телефон клиента", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByText(/Укажите российский номер с префиксом/)).toBeVisible();
  await expect(saveContacts(page)).toBeDisabled();
  await page.getByLabel("Имя клиента", { exact: true }).fill(" ");
  await expect(page.getByLabel("Имя клиента", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByText("Укажите имя клиента.")).toBeVisible();
  expect((await db.appointment.findUniqueOrThrow({ where: { id } })).version).toBe(0);
});

test("two tabs preserve the stale contact draft until explicit reread", async ({ page }) => {
  await login(page);
  await page.goto(path());
  await fillContacts(page, "Черновик первой вкладки", "8 999 111-11-11");
  const other = await page.context().newPage();
  await other.goto(path());
  await fillContacts(other, "Данные второй вкладки", "8 999 222-22-22");
  await saveContacts(other).click();
  await expect(other.getByRole("status")).toContainText("Имя и телефон клиента сохранены");

  await saveContacts(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Запись уже изменена");
  await expect(page.getByLabel("Имя клиента", { exact: true })).toHaveValue(
    "Черновик первой вкладки",
  );
  await expect(page.getByLabel("Телефон клиента", { exact: true })).toHaveValue("8 999 111-11-11");
  await expect(saveContacts(page)).toBeDisabled();
  await expect(page.getByRole("link", { name: "Сверить карточку (новая вкладка)" })).toBeVisible();
  const reread = page.getByRole("link", {
    name: "Перечитать текущую карточку перед новой попыткой",
  });
  await expect(reread).toBeVisible();
  await reread.click();
  await expect(page.getByLabel("Имя клиента", { exact: true })).toHaveValue(
    "Данные второй вкладки",
  );
  await expect(page.getByLabel("Телефон клиента", { exact: true })).toHaveValue("+79992222222");
  expect((await db.appointment.findUniqueOrThrow({ where: { id } })).version).toBe(1);
});

test("client cancellation in another tab preserves the stale contact draft", async ({ page }) => {
  await login(page);
  await page.goto(path());
  await fillContacts(page, "Черновик до отмены", "8 999 333-44-55");
  const client = await page.context().newPage();
  await client.goto("/appointment#" + clientToken);
  await expect(client.getByText("Вымышленный Клиент", { exact: true })).toBeVisible();
  await client.getByRole("button", { name: "Отменить запись" }).click();
  await client.getByLabel("Я хочу отменить эту запись").check();
  await client.getByRole("button", { name: "Да, отменить запись" }).click();
  await expect(client.locator(".cancellation").getByRole("status")).toContainText(
    "Запись отменена",
  );

  await saveContacts(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Запись уже изменена");
  await expect(page.getByLabel("Имя клиента", { exact: true })).toHaveValue("Черновик до отмены");
  await expect(saveContacts(page)).toBeDisabled();
  const after = await db.appointment.findUniqueOrThrow({ where: { id } });
  expect(after).toMatchObject({
    status: "CANCELLED",
    version: 1,
    clientName: "Вымышленный Клиент",
    clientPhone: "+79990000000",
  });
});

for (const commit of [false, true])
  test(
    "unknown contact outcome " + (commit ? "after commit" : "before commit") + " blocks retry",
    async ({ page }) => {
      await login(page);
      await page.goto(path());
      await fillContacts(page, "Черновик неизвестного ответа", "8 999 555-66-77");
      let posts = 0;
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      await page.route("**/admin/appointments/**", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        if (commit) expect((await route.fetch()).ok()).toBe(true);
        reached();
        await gate;
        await route.abort("failed");
      });
      await saveContacts(page).click();
      await ready;
      await expect(page.getByText("Сохраняем имя и телефон…")).toBeVisible();
      release();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("Результат неизвестен");
      await expect(page.getByLabel("Имя клиента", { exact: true })).toHaveValue(
        "Черновик неизвестного ответа",
      );
      await expect(saveContacts(page)).toBeDisabled();
      await page.getByLabel("Имя клиента", { exact: true }).fill("Попытка изменить черновик");
      await expect(saveContacts(page)).toBeDisabled();
      const fresh = await page.context().newPage();
      await fresh.goto(path());
      await expect(fresh.locator(".appointment-facts")).toContainText(
        commit ? "Черновик неизвестного ответа" : "Вымышленный Клиент",
      );
      expect(posts).toBe(1);
      expect((await db.appointment.findUniqueOrThrow({ where: { id } })).version).toBe(
        commit ? 1 : 0,
      );
    },
  );

test("direct contact Action enforces Origin, session and strict DTO", async ({ page }) => {
  await login(page);
  await page.goto(path());
  const captured = waitAction(page);
  await fillContacts(page, "Первое исправление", "8 999 111-22-33");
  await saveContacts(page).click();
  const request = await captured;
  await expect(page.getByRole("status")).toContainText("Имя и телефон клиента сохранены");
  const row = await db.appointment.findUniqueOrThrow({ where: { id } });
  const intent = {
    id,
    version: row.version,
    clientName: "Прямое исправление",
    clientPhone: "8 999 777-88-99",
  };
  for (const extra of [
    { status: "COMPLETED" },
    { source: "ADMIN" },
    { serviceId },
    { masterId: demoMasterIds[0] },
    { startsAt: new Date().toISOString() },
    { cancellationToken: clientToken },
    { bookingRequestId: row.bookingRequestId },
    { history: [] },
    { adminId: randomUUID() },
    { expectedBusinessContext: "a".repeat(64) },
  ]) {
    const response = await page.request.post(path(), {
      headers: actionHeaders(request),
      data: JSON.stringify([{ ...intent, ...extra }]),
    });
    const body = await response.text();
    expect(body).toContain("INVALID_INPUT");
    expect(body).not.toContain(intent.clientPhone);
    expect(body).not.toContain(clientToken);
  }
  const foreign = await page.request.post(path(), {
    headers: actionHeaders(request, "https://evil.example"),
    data: JSON.stringify([intent]),
  });
  expect(foreign.status() >= 400 || (await foreign.text()).includes("FORBIDDEN")).toBe(true);
  const missing = await page.request.post(path(), {
    headers: { ...actionHeaders(request), cookie: "" },
    data: JSON.stringify([intent]),
  });
  expect(await missing.text()).toContain("UNAUTHORIZED");
  const success = await page.request.post(path(), {
    headers: actionHeaders(request),
    data: JSON.stringify([intent]),
  });
  expect(await success.text()).toContain('"ok":true');
  const after = await db.appointment.findUniqueOrThrow({
    where: { id },
    include: { statusHistory: true },
  });
  expect(after).toMatchObject({
    version: 2,
    clientName: "Прямое исправление",
    clientPhone: "+79997778899",
  });
  expect(after.statusHistory).toHaveLength(1);
});

test("protected fragment page shows corrected contacts without exposing them in URL", async ({
  page,
}) => {
  await login(page);
  await page.goto(path());
  await fillContacts(page, "Контакты для клиента", "8 999 444-55-66");
  await saveContacts(page).click();
  await expect(page.getByRole("status")).toContainText("Имя и телефон клиента сохранены");
  expect(page.url()).not.toContain("Контакты");
  expect(page.url()).not.toContain("7999");
  await page.goto("/appointment#" + clientToken);
  await expect(page.getByText("Контакты для клиента", { exact: true })).toBeVisible();
  await expect(page.getByText("+79994445566", { exact: true })).toBeVisible();
});
