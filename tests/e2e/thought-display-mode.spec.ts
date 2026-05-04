import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("thought display modes stay hidden by default and persist when enabled", async ({ page }) => {
  await page.goto("/?e2eScenario=thought-display-mode");

  await expect(page.getByTestId("thought-block")).toHaveCount(0);

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await expect(page.getByTestId("settings-tab-general")).toHaveClass(/theme-bg/);
  await expect(page.getByTestId("thought-display-hidden")).toContainText("只显示最终回复和执行状态");
  await expect(page.getByTestId("thought-display-summary")).toContainText("过滤后的关键过程");
  await expect(page.getByTestId("thought-display-detailed")).toContainText("仍会限长去噪");
  await expect(page.getByTestId("thought-display-hidden")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("thought-display-summary").click();
  await expect(page.getByTestId("thought-display-summary")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-close").click();

  await expect(page.getByTestId("thought-block")).toBeVisible();
  const summary = page.getByTestId("thought-summary-lines");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("SettingsModal");
  await expect(summary).toContainText("三档配置");
  await expect(summary).not.toContainText("data:");
  await expect(summary).not.toContainText("read_file");
  await expect(summary).not.toContainText("const noisy");
  await expect(summary).toHaveCSS("font-size", "13px");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await page.locator('input[type="range"]').fill("18");
  await page.getByTestId("settings-close").click();
  await expect(summary).toHaveCSS("font-size", "18px");

  await page.reload();
  await expect(page.getByTestId("thought-block")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().thoughtDisplayMode ?? null)).toBe("summary");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await page.getByTestId("thought-display-detailed").click();
  await expect(page.getByTestId("thought-display-detailed")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-close").click();

  const detail = page.getByTestId("thought-detail");
  const detailToggle = page.getByTestId("thought-detail-toggle");
  await expect(detailToggle).toBeVisible();
  await expect(detailToggle).toContainText("思考详情");
  await expect(detailToggle).not.toContainText("字符");
  await expect(detailToggle).not.toContainText("chars");
  await expect(detail).toBeVisible();
  await expect(detail).toHaveCSS("font-size", "18px");
  await expect(detail).toContainText("SettingsModal");
  await expect(detail).toContainText("三档配置");
  await expect(detail.locator("strong").filter({ hasText: "检查范围" })).toBeVisible();
  await expect(detail).not.toContainText("data:");
  await expect(detail).not.toContainText("read_file");
  await expect(detail).not.toContainText("const noisy");
  await expect(detail).not.toContainText("陷入了循环");
});
