import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("TopIsland does not invent execution step progress from plain tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-execution-progress");

  await expect(page.getByTestId("top-island-shell")).toHaveCount(0);
  await expect(page.getByTestId("top-island-execution-badge")).toHaveCount(0);
  await expect(page.getByTestId("top-island-execution-progress")).toHaveCount(0);
});

test("TopIsland shows the full approved plan task list during execution", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-plan-task-progress");

  await expect(page.getByTestId("top-island-plan-badge")).toContainText("任务 8/9");
  await page.getByTestId("top-island-shell").hover();
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("共 9 个任务，已完成 8 个");
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("T1: 更新");
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("T8: 更新");
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("T9: 更新");
  await expect(page.getByTestId("top-island-current-plan-task")).toContainText("T9: 更新");
  await expect(page.getByTestId("top-island-current-plan-task")).not.toContainText("当前");
});

test("TopIsland counts only trusted evidence, not claimed completed checkboxes", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-strict-evidence-progress");

  await expect(page.getByTestId("top-island-plan-badge")).toContainText("任务 1/8");
  await page.getByTestId("top-island-shell").hover();
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("共 8 个任务，已完成 1 个");
  await expect(page.getByTestId("top-island-current-plan-task")).toContainText("1.1 修复 useTrendData 回退逻辑");
});

test("TopIsland keeps approval buttons visible for a long command with plan tasks", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-pending-tool-review");

  await expect(page.getByTestId("top-island-tool-review")).toBeVisible();
  await expect(page.getByTestId("top-island-tool-review")).toContainText("拒绝");
  await expect(page.getByTestId("top-island-tool-review")).toContainText("开启自动审查并批准");
  await expect(page.getByTestId("top-island-tool-review")).toContainText("批准此工具请求");
  await expect(page.getByTestId("top-island-tool-review")).toContainText("printf");
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("任务明细已收起");
  await expect(page.getByTestId("top-island-current-plan-task")).toHaveCount(0);
});

test("TopIsland renders approval controls from pendingToolCall when the pending tool card is missing", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-orphan-pending-review");

  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().agentStatus ?? null)).toBe("idle");
  await expect(page.getByTestId("top-island-shell")).toHaveCount(0);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.showOrphanPendingReviewPrompt?.());
  await expect(page.getByTestId("top-island-tool-review")).toBeVisible();
  await expect(page.getByTestId("top-island-tool-review")).toContainText("批准此工具请求");
  await expect(page.getByTestId("top-island-tool-review")).toContainText("SnakeController.cs");

  await page.getByTestId("top-island-tool-approve-once").click();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().pendingReviewTaskId ?? null))
    .toBeNull();
});

const panelModes = ["plan", "diff", "terminal", "closed"] as const;

async function getPanelSnapshot(page: Page) {
  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  return {
    showPlanPanel: Boolean(snapshot?.showPlanPanel),
    showDiff: Boolean(snapshot?.showDiff),
    showTerminal: Boolean(snapshot?.showTerminal),
    rightPanelTab: snapshot?.rightPanelTab ?? null,
  };
}

for (const mode of panelModes) {
  test(`TopIsland plan approval preserves right panel state: ${mode}`, async ({ page }) => {
    await page.goto("/?e2eScenario=top-island-panel-stability");
    await page.evaluate((nextMode) => (window as any).__CODELY_E2E__?.setPanelMode?.(nextMode), mode);
    await page.evaluate(() => (window as any).__CODELY_E2E__?.resetPlanApprovalPrompt?.());

    await expect(page.getByTestId("top-island-plan-approve")).toBeVisible();
    const before = await getPanelSnapshot(page);

    await page.getByTestId("top-island-plan-approve").click();
    await expect.poll(async () => (
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().isPlanApproved ?? false)
    )).toBe(true);

    expect(await getPanelSnapshot(page)).toEqual(before);
  });

  test(`TopIsland tool approval preserves right panel state: ${mode}`, async ({ page }) => {
    await page.goto("/?e2eScenario=top-island-panel-stability");
    await page.evaluate((nextMode) => (window as any).__CODELY_E2E__?.setPanelMode?.(nextMode), mode);
    await page.evaluate(() => (window as any).__CODELY_E2E__?.showToolApprovalPrompt?.());

    await expect(page.getByTestId("top-island-tool-review")).toBeVisible();
    const before = await getPanelSnapshot(page);

    await page.getByTestId("top-island-tool-approve-once").click();
    await expect.poll(async () => (
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().pendingReviewTaskId ?? null)
    )).toBeNull();

    expect(await getPanelSnapshot(page)).toEqual(before);
  });
}

test("TopIsland run-active ring follows only the real running execution state", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-panel-stability");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setRunState?.("running"));
  await expect(page.getByTestId("top-island-shell")).toHaveAttribute("data-run-active", "true");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setRunState?.("pending_review"));
  await expect(page.getByTestId("top-island-shell")).toHaveAttribute("data-run-active", "false");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setRunState?.("idle"));
  await expect.poll(async () => {
    const shell = page.getByTestId("top-island-shell");
    const count = await shell.count();
    if (count === 0) return "gone";
    return await shell.first().getAttribute("data-run-active");
  }).not.toBe("true");
});

test("plan UI accents follow a non-purple theme across appearance modes", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-panel-stability");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.setTheme?.("green"));

  await expect(page.getByTestId("top-island-plan-approve")).toBeVisible();
  await expect(page.locator("blockquote.theme-plan-surface").first()).toBeVisible();

  for (const mode of ["light", "dark", "black"] as const) {
    await page.evaluate((themeMode) => (window as any).__CODELY_E2E__?.setThemeMode?.(themeMode), mode);
    await expect.poll(async () => (
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().themeMode ?? null)
    )).toBe(mode);

    const styles = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("[style*='--accent']");
      const planSurface = document.querySelector<HTMLElement>(".theme-plan-surface");
      const quote = document.querySelector<HTMLElement>("blockquote.theme-plan-surface");
      const primary = document.querySelector<HTMLElement>("[data-testid='top-island-plan-approve']");
      const rootStyle = appRoot ? getComputedStyle(appRoot) : null;
      return {
        accent: rootStyle?.getPropertyValue("--accent").trim() || "",
        contrast: rootStyle?.getPropertyValue("--accent-contrast").trim() || "",
        surfaceBorder: planSurface ? getComputedStyle(planSurface).borderTopColor : "",
        quoteBorder: quote ? getComputedStyle(quote).borderLeftColor : "",
        primaryColor: primary ? getComputedStyle(primary).color : "",
      };
    });

    expect(styles.accent).toBe("#059669");
    expect(styles.contrast).toBe("#ffffff");
    expect(styles.primaryColor).toBe("rgb(255, 255, 255)");
    expect(styles.surfaceBorder).not.toBe("rgb(147, 51, 234)");
    expect(styles.quoteBorder).not.toBe("rgb(147, 51, 234)");
  }
});
