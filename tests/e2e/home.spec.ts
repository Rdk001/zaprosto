import { expect, test } from "@playwright/test";
test("публичный каталог и health", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Хорошая стрижка");
  await expect(page.getByRole("button", { name: /Мужская стрижка/ })).toBeVisible();
  expect((await request.get("/api/health")).ok()).toBe(true);
});
