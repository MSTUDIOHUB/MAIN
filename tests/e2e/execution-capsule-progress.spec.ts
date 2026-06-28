import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("ExecutionCapsule does not invent execution step progress from plain tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-execution-progress");

  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-execution-badge")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-execution-progress")).toHaveCount(0);
});

test("pure plan execution progress stays in the PlanPanel instead of the chat capsule", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-plan-task-progress");

  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-plan-badge")).toHaveCount(0);
  await expect(page.getByTestId("plan-task-progress")).toContainText("8/9");
  await expect(page.getByTestId("plan-task-progress")).toContainText("T1: 更新");
  await expect(page.getByTestId("plan-task-progress")).toContainText("T8: 更新");
  await expect(page.getByTestId("plan-task-progress")).toContainText("T9: 更新");
});

test("PlanPanel counts only trusted evidence, not claimed completed checkboxes", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-strict-evidence-progress");

  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-plan-badge")).toHaveCount(0);
  await expect(page.getByTestId("plan-task-progress")).toContainText("1/8");
  await expect(page.getByTestId("plan-task-progress")).toContainText("1.1 修复 useTrendData 回退逻辑");
  await expect(page.getByTestId("plan-task-status").nth(1)).toContainText("待验证");
  await expect(page.getByTestId("plan-task-progress")).not.toContainText("缺少真实执行证据");
});

test("ExecutionCapsule keeps approval buttons visible for a long command with plan tasks", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-pending-tool-review");

  await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("拒绝");
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("开启自动审查并批准");
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("批准此工具请求");
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("printf");
  await expect(page.getByTestId("execution-capsule-plan-badge")).toContainText("任务 8/12");
  await expect(page.getByTestId("execution-capsule-plan-progress")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-current-plan-task")).toHaveCount(0);
});

test("task tracking popover follows execution evidence order with ring-only current highlight", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-pending-tool-review");

  await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
  await page.getByTitle("任务跟踪").click();
  await expect(page.getByTestId("tasks-progress-popover")).toBeVisible();

  const taskIds = await page.locator("[data-testid='tasks-progress-popover'] [data-task-id]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-task-id"))
  );
  expect(taskIds.slice(0, 4)).toEqual([
    "review-plan-task-3",
    "review-plan-task-1",
    "review-plan-task-2",
    "review-plan-task-4",
  ]);

  const currentTask = page.getByTestId("execution-capsule-current-plan-task");
  await expect(currentTask).toHaveAttribute("data-task-id", "review-plan-task-9");
  const styles = await currentTask.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      className: element.className,
      backgroundColor: computed.backgroundColor,
      borderLeftColor: computed.borderLeftColor,
    };
  });

  expect(styles.className).toContain("ring-2");
  expect(styles.className).toContain("ring-[color-mix(in_srgb,var(--accent)_72%,transparent)]");
  expect(styles.className).not.toContain("shadow-[inset_3px_0_0");
  expect(styles.borderLeftColor).not.toBe("rgb(5, 150, 105)");
});

test("ExecutionCapsule renders approval controls from pendingToolCall when the pending tool card is missing", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-orphan-pending-review");

  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().agentStatus ?? null)).toBe("idle");
  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.showOrphanPendingReviewPrompt?.());
  await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("批准此工具请求");
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("SnakeController.cs");

  await page.getByTestId("execution-capsule-tool-approve-once").click();
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
  test(`ExecutionCapsule plan approval preserves right panel state: ${mode}`, async ({ page }) => {
    await page.goto("/?e2eScenario=execution-capsule-panel-stability");
    await page.evaluate((nextMode) => (window as any).__CODELY_E2E__?.setPanelMode?.(nextMode), mode);
    await page.evaluate(() => (window as any).__CODELY_E2E__?.resetPlanApprovalPrompt?.());

    await expect(page.getByTestId("execution-capsule-plan-approve")).toBeVisible();
    const before = await getPanelSnapshot(page);

    await page.getByTestId("execution-capsule-plan-approve").click();
    await expect.poll(async () => (
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().isPlanApproved ?? false)
    )).toBe(true);

    expect(await getPanelSnapshot(page)).toEqual(before);
  });

  test(`ExecutionCapsule tool approval preserves right panel state: ${mode}`, async ({ page }) => {
    await page.goto("/?e2eScenario=execution-capsule-panel-stability");
    await page.evaluate((nextMode) => (window as any).__CODELY_E2E__?.setPanelMode?.(nextMode), mode);
    await page.evaluate(() => (window as any).__CODELY_E2E__?.showToolApprovalPrompt?.());

    await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
    const before = await getPanelSnapshot(page);

    await page.getByTestId("execution-capsule-tool-approve-once").click();
    await expect.poll(async () => (
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().pendingReviewTaskId ?? null)
    )).toBeNull();

    expect(await getPanelSnapshot(page)).toEqual(before);
  });
}

test("double-clicking plan approval does not create a queued instruction", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.resetPlanApprovalPrompt?.());

  const approve = page.getByTestId("execution-capsule-plan-approve");
  await expect(approve).toBeVisible();
  await approve.dblclick();

  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().isPlanApproved ?? false))
    .toBe(true);
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().queuedUserMessage?.text ?? null))
    .toBeNull();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().conversationTurns ?? null))
    .toBe(1);
  await expect
    .poll(async () => page.evaluate(() => {
      const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
      const executionTurnId = snapshot?.pendingPlanApprovalHandoff?.executionTurnId ?? "";
      const consentTurnId = snapshot?.currentTurnExecutionConsent?.turnId ?? "";
      return Boolean(executionTurnId && consentTurnId === executionTurnId);
    }))
    .toBe(true);
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().pendingPlanApprovalHandoff?.planTurnId ?? null))
    .toBe("e2e-execution-capsule-panel-stability-turn");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().planApprovalExecutionStartedForTurnId ?? null))
    .toBeNull();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().executionChildTurns ?? null))
    .toBe(0);
  await expect(page.getByTestId("composer-queued-message")).toHaveCount(0);
});

test("ExecutionCapsule appears for pending review but not pure running progress", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setRunState?.("running"));
  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setRunState?.("pending_review"));
  await expect(page.getByTestId("execution-capsule-shell")).toHaveAttribute("data-run-active", "false");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setRunState?.("idle"));
  await expect.poll(async () => {
    const shell = page.getByTestId("execution-capsule-shell");
    const count = await shell.count();
    if (count === 0) return "gone";
    return await shell.first().getAttribute("data-run-active");
  }).not.toBe("true");
});

test("plan UI accents follow a non-purple theme across appearance modes", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.setTheme?.("green"));

  await expect(page.getByTestId("execution-capsule-plan-approve")).toBeVisible();
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
      const primary = document.querySelector<HTMLElement>("[data-testid='execution-capsule-plan-approve']");
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
