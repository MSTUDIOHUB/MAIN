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
    .poll(async () => {
      const text = await page.locator("div").filter({ hasText: /^处理中\.\.\. \d+m\d+s$/ }).first().textContent();
      const match = String(text || "").match(/(\d+)m(\d+)s/);
      return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
    }, { timeout: 2500 })
    .toBeGreaterThanOrEqual(1);
});

test("composer queues and guides additional input while a run is active", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-running-guidance");

  const textarea = page.getByTestId("composer-textarea");
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
  await expect(page.getByTestId("composer-send-button")).toHaveCount(0);
  const autoReviewToggle = page.getByTestId("composer-auto-review-toggle");
  await expect(autoReviewToggle).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await autoReviewToggle.click();
  await expect
    .poll(async () => page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().autoApproveTools)))
    .toBe(true);
  await expect(autoReviewToggle).toBeDisabled();

  await textarea.fill("追加检查导入后的空状态");
  await expect(page.getByTestId("composer-send-button")).toBeVisible();
  await expect(page.getByTestId("composer-stop-button")).toHaveCount(0);

  await page.getByTestId("composer-send-button").click();
  await expect(textarea).toHaveValue("");
  await expect(page.getByTestId("composer-queued-message")).toContainText("追加检查导入后的空状态");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().input ?? "missing"))
    .toBe("");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().queuedUserMessage?.text ?? null))
    .toBe("追加检查导入后的空状态");

  await page.getByTestId("composer-guidance-button").click();
  await expect(page.getByTestId("composer-queued-message")).toHaveCount(0);
  await expect(page.getByTestId("composer-active-guidance")).toContainText("追加检查导入后的空状态");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGuidance?.text ?? null))
    .toBe("追加检查导入后的空状态");
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
    .poll(async () => {
      const text = await page.locator("div").filter({ hasText: /^处理中\.\.\. \d+m\d+s$/ }).first().textContent();
      const match = String(text || "").match(/(\d+)m(\d+)s/);
      return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
    }, { timeout: 2500 })
    .toBeGreaterThanOrEqual(1);

  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().tickCount ?? 0))
    .toBeGreaterThan(5);
});
