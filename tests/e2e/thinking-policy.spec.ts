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

  await expect(page.getByTestId("thought-block")).toBeVisible();
  const summary = page.getByTestId("thought-summary-lines");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("SettingsModal");
  await expect(summary).toContainText("两档配置");
  await expect(summary).not.toContainText("data:");
  await expect(summary).not.toContainText("read_file");
  await expect(summary).not.toContainText("const noisy");
  await expect(summary).toHaveCSS("font-size", "13px");

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
  await expect(summary).toHaveCSS("font-size", "18px");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await page.getByTestId("thinking-policy-action_only").click();
  await expect(page.getByTestId("thinking-policy-action_only")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-close").click();

  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().thinkingPolicy ?? null)).toBe("action_only");

  await page.reload();
  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().thinkingPolicy ?? null)).toBe("action_only");
});
