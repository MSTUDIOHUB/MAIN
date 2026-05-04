import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("black appearance mode persists and applies the pure black theme", async ({ page }) => {
  await page.goto("/?e2eScenario=thought-display-mode");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await page.getByRole("button", { name: "黑色" }).click();

  await expect(page.getByRole("button", { name: "黑色" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().themeMode ?? null))
    .toBe("black");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().themeMode ?? null))
    .toBe("black");
});
