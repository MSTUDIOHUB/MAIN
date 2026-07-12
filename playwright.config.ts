import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
const shouldUseExternalServer =
  process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1" ||
  process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1" ||
  process.env.PLAYWRIGHT_BASE_URL !== undefined;
const browserChannel =
  process.env.PLAYWRIGHT_BROWSER_CHANNEL ||
  (process.env.PLAYWRIGHT_USE_CHROME_FOR_TESTING === "1" ? "chromium" : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1440, height: 960 },
    ...(browserChannel ? { channel: browserChannel } : {}),
  },
  webServer: shouldUseExternalServer
    ? undefined
    : {
        command: "npm run dev -- --host 127.0.0.1 --port 4173",
        url: baseURL,
        reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER !== "0",
        timeout: 120_000,
      },
});
