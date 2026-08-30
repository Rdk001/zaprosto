import { defineConfig, devices } from "@playwright/test";
const port = 3108;
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: `http://localhost:${port}`, trace: "off", screenshot: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node node_modules/next/dist/bin/next start -p ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PUBLIC_ORIGIN: `http://localhost:${port}` },
  },
});
