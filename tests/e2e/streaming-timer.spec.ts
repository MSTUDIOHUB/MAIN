import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("ordinary running turn stays in the continuous flow while streaming", async ({ page }) => {
  await page.goto("/?e2eScenario=streaming-timer");

  await expect(page.getByTestId("turn-state-anchor")).toHaveCount(0);
  await expect(page.getByText("请检查计时器是否正常增长。")).toBeVisible();
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
});

test("composer queues and guides additional input while a run is active", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-running-guidance");

  const textarea = page.getByTestId("composer-textarea");
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
  await expect(page.getByTestId("composer-send-button")).toHaveCount(0);
  const autoReviewToggle = page.getByTestId("composer-auto-review-toggle");
  const subagentToggle = page.getByTestId("composer-subagent-preference-toggle");
  await expect(autoReviewToggle).toBeVisible();
  await expect(subagentToggle).toBeVisible();
  await expect(subagentToggle).toBeDisabled();
  await expect(subagentToggle).toHaveAttribute("aria-pressed", "false");

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

test("composer subagent preference toggle activates after the current run stops", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=composer-running-guidance");

  const subagentToggle = page.getByTestId("composer-subagent-preference-toggle");
  await expect(subagentToggle).toBeDisabled();
  await page.evaluate(() => (window as any).__CODELY_E2E__?.clearModelRuntimeLock?.());
  await expect(subagentToggle).toBeEnabled();
  await subagentToggle.click();
  await expect(subagentToggle).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().preferSubagents)))
    .toBe(true);

  const autoReviewToggle = page.getByTestId("composer-auto-review-toggle");
  await expect(
    page.locator('[data-testid="composer-subagent-preference-toggle"] + [data-testid="composer-auto-review-toggle"]'),
  ).toHaveCount(1);
  for (const theme of ["light", "dark", "black"] as const) {
    await page.evaluate((nextTheme) => (window as any).__CODELY_E2E__?.setThemeMode?.(nextTheme), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(subagentToggle).toBeVisible();
    await expect(subagentToggle).toHaveClass(/is-active/);
    await expect(autoReviewToggle).toBeVisible();
    await subagentToggle.screenshot({ path: testInfo.outputPath(`subagent-toggle-${theme}.png`) });
  }
});

test("chat history remains scrollable during rapid streaming updates", async ({ page }) => {
  await page.goto("/?e2eScenario=streaming-responsiveness");

  const scroller = page.getByTestId("chat-scroll-container");
  await expect(page.getByTestId("turn-state-anchor")).toHaveCount(0);
  await expect(page.getByText("请持续输出，同时保持历史滚动流畅。")).toBeAttached();
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();

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
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().tickCount ?? 0))
    .toBeGreaterThan(5);
});
