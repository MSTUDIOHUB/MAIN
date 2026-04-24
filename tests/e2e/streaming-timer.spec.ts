import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("top bar processing timer appears and increments while streaming", async ({ page }) => {
  await page.goto("/?e2eScenario=streaming-timer");

  await expect(page.getByText("处理中... 0m0s")).toBeVisible();

  await expect
    .poll(async () =>
      page.locator("div").filter({ hasText: /^处理中\.\.\. \d+m\d+s$/ }).first().textContent(),
    )
    .toContain("处理中...");

  await expect
    .poll(async () =>
      page.locator("div").filter({ hasText: /^处理中\.\.\. \d+m\d+s$/ }).first().textContent(),
      { timeout: 2500 },
    )
    .toContain("0m1s");
});
