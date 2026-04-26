import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
const shouldUseExternalServer =
  process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1" ||
  process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1" ||
  process.env.PLAYWRIGHT_BASE_URL !== undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1440, height: 960 },
  },
  webServer: shouldUseExternalServer
    ? undefined
    : {
        command: "npm run dev -- --host 127.0.0.1 --port 4173",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
