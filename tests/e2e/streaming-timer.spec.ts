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

test("chat history remains scrollable during rapid streaming updates", async ({ page }) => {
  await page.goto("/?e2eScenario=streaming-responsiveness");

  const scroller = page.getByTestId("chat-scroll-container");
  await expect(page.getByText("处理中... 0m0s")).toBeVisible();

  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const bottom = await scroller.evaluate((el) => el.scrollTop);

  await scroller.hover();
  await page.mouse.wheel(0, -900);

  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop), { timeout: 2500 })
    .toBeLessThan(bottom - 100);

  await expect
    .poll(async () =>
      page.locator("div").filter({ hasText: /^处理中\.\.\. \d+m\d+s$/ }).first().textContent(),
      { timeout: 2500 },
    )
    .toContain("0m1s");

  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().tickCount ?? 0))
    .toBeGreaterThan(5);
});
