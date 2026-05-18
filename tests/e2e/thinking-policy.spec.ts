import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("thinking policy is the only thought visibility control and persists", async ({ page }) => {
  await page.goto("/?e2eScenario=thinking-policy");

  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("turn-process-archive-toggle")).toBeVisible();
  await page.getByTestId("turn-process-archive-toggle").click();

  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  await expect(page.locator('[data-testid="turn-archive-step"][data-kind="inspect"]')).toContainText("收集上下文");
  await expect(page.locator('[data-testid="turn-archive-step"][data-kind="inspect"]')).toContainText("SettingsModal");
  await expect(page.locator('[data-testid="turn-archive-step"][data-kind="inspect"]')).toContainText("避免原始长文本刷屏");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await expect(page.getByTestId("settings-tab-general")).toHaveClass(/theme-bg/);
  await expect(page.getByTestId("thinking-policy-normal")).toContainText("过滤后的关键过程说明");
  await expect(page.getByTestId("thinking-policy-action_only")).toContainText("仅保留结论与执行动作");
  await expect(page.getByTestId("thinking-policy-normal")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("thinking-policy-action_only")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("thinking-policy-normal")).toHaveCount(1);
  await expect(page.getByTestId("thinking-policy-action_only")).toHaveCount(1);
  await expect(page.getByTestId("session-recording-switch")).toBeVisible();
  await expect(page.getByTestId("settings-tab-general")).not.toContainText("思考显示");

  await page.locator('input[type="range"]').fill("18");
  await page.getByTestId("settings-close").click();

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await page.getByTestId("thinking-policy-action_only").click();
  await expect(page.getByTestId("thinking-policy-action_only")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-close").click();

  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.locator('[data-testid="turn-archive-step"][data-kind="inspect"]')).toBeVisible();
  await expect(page.locator('[data-testid="turn-archive-step"][data-kind="inspect"]')).toContainText("核对必要上下文");
  await expect(page.locator('[data-testid="turn-archive-step"][data-kind="inspect"]')).not.toContainText("SettingsModal");
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().thinkingPolicy ?? null)).toBe("action_only");

  await page.reload();
  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().thinkingPolicy ?? null)).toBe("action_only");
});
