import { expect, test } from "@playwright/test";

test("shows the Zaprosto application shell", async ({ page, request }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Запросто" })).toBeVisible();
  await expect(page.getByText("Каркас приложения запущен.", { exact: false })).toBeVisible();

  const healthResponse = await request.get("/api/health");
  expect(healthResponse.ok()).toBe(true);
  await expect(healthResponse.json()).resolves.toEqual({
    status: "ok",
    service: "zaprosto-web",
  });
});
