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
  await page.evaluate(() => (window as any).__CODELY_E2E__?.showPendingToolReviewPrompt?.());

  await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("拒绝");
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("开启自动审查并批准");
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("批准此工具请求");
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("printf");
  await expect(page.getByTestId("execution-capsule-plan-badge")).toContainText("任务 8/12");
  await expect(page.getByTestId("execution-capsule-plan-progress")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-current-plan-task")).toHaveCount(0);
});

type PermissionIdentity = {
  sessionKey: string;
  turnId: string;
  runId: string;
  requestId: string;
  taskId: number;
};

async function showExactPendingToolReview(page: Page): Promise<PermissionIdentity> {
  await page.goto("/?e2eScenario=execution-capsule-pending-tool-review");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.showPendingToolReviewPrompt?.());
  const capsule = page.getByTestId("execution-capsule-shell");
  await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
  const identity = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.getPendingToolReviewIdentity?.() as PermissionIdentity | null
  );
  expect(identity).not.toBeNull();
  await expect(capsule).toHaveAttribute("data-session-key", identity!.sessionKey);
  await expect(capsule).toHaveAttribute("data-turn-id", identity!.turnId);
  await expect(capsule).toHaveAttribute("data-run-id", identity!.runId);
  await expect(capsule).toHaveAttribute("data-request-id", identity!.requestId);
  await expect(capsule).toHaveAttribute("data-task-id", String(identity!.taskId));
  return identity!;
}

for (const action of ["approve_once", "approve_session", "reject"] as const) {
  test(`stale ${action} permission identity cannot resolve a replacement request`, async ({ page }) => {
    const staleIdentity = await showExactPendingToolReview(page);
    const replacementIdentity = await page.evaluate(() =>
      (window as any).__CODELY_E2E__?.rotatePendingToolReviewIdentity?.() as PermissionIdentity
    );

    await page.evaluate(
      ({ staleAction, identity }) =>
        (window as any).__CODELY_E2E__?.resolvePendingToolReviewWithIdentity?.(staleAction, identity),
      { staleAction: action, identity: staleIdentity },
    );

    await expect.poll(async () => page.evaluate(() => {
      const bridge = (window as any).__CODELY_E2E__;
      const snapshot = bridge?.getSnapshot?.();
      return {
        pendingReviewTaskId: snapshot?.pendingReviewTaskId ?? null,
        autoApproveTools: snapshot?.autoApproveTools ?? null,
        resolvedEvents: (bridge?.events || []).filter((event: { type?: string }) =>
          event.type === "pending_tool_review_resolved"
        ).length,
        identity: bridge?.getPendingToolReviewIdentity?.() ?? null,
      };
    })).toEqual({
      pendingReviewTaskId: replacementIdentity.taskId,
      autoApproveTools: false,
      resolvedEvents: 0,
      identity: replacementIdentity,
    });

    const capsule = page.getByTestId("execution-capsule-shell");
    await expect(capsule).toHaveAttribute("data-run-id", replacementIdentity.runId);
    await expect(capsule).toHaveAttribute("data-request-id", replacementIdentity.requestId);
  });
}

test("task tracking popover follows execution evidence order with ring-only current highlight", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-pending-tool-review");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.showPendingToolReviewPrompt?.());

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

async function prepareFormalPlanReview(
  page: Page,
  options: { runId?: string; requestId?: string; reset?: boolean } = {},
) {
  const runId = options.runId || "run-e2e-plan-review";
  const requestId = options.requestId || "request-e2e-plan-review";
  await page.evaluate(
    ({ nextRunId, nextRequestId }) => (window as any).__CODELY_E2E__?.setExecutionCapsuleIdentity?.(
      nextRunId,
      nextRequestId,
    ),
    { nextRunId: runId, nextRequestId: requestId },
  );
  if (options.reset !== false) {
    await page.evaluate(() => (window as any).__CODELY_E2E__?.resetPlanApprovalPrompt?.());
  }

  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);
  await expect(page.getByTestId("plan-review-panel")).toBeVisible();
  await expect(page.getByTestId("plan-approve-button")).toBeVisible();
}

test("Plan review stays in PlanPanel while preserving its runtime identity", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await prepareFormalPlanReview(page, {
    runId: "run-e2e-plan-review",
    requestId: "request-e2e-plan-review",
    reset: false,
  });

  await expect(page.getByTestId("plan-review-panel")).toContainText("ExecutionCapsule 面板稳定回归");
  await expect
    .poll(async () => page.evaluate(() => {
      const event = [...((window as any).__CODELY_E2E__?.events || [])]
        .reverse()
        .find((item: { type?: string }) => item.type === "execution_capsule_identity");
      return event
        ? { runId: event.runId, requestId: event.requestId, turnId: event.turnId }
        : null;
    }))
    .toEqual({
      runId: "run-e2e-plan-review",
      requestId: "request-e2e-plan-review",
      turnId: "e2e-execution-capsule-panel-stability-turn",
    });
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
  test(`PlanPanel approval preserves panel state after opening from: ${mode}`, async ({ page }) => {
    await page.goto("/?e2eScenario=execution-capsule-panel-stability");
    await prepareFormalPlanReview(page);
    await page.evaluate((nextMode) => (window as any).__CODELY_E2E__?.setPanelMode?.(nextMode), mode);
    if (mode !== "plan") {
      await page.getByTestId("top-plan-panel-button").click();
    }

    await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);
    await expect(page.getByTestId("plan-review-panel")).toBeVisible();
    await expect(page.getByTestId("plan-approve-button")).toBeVisible();
    const before = await getPanelSnapshot(page);

    await page.getByTestId("plan-approve-button").click();
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

test("double-clicking PlanPanel approval does not create a queued instruction", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await prepareFormalPlanReview(page);

  const approve = page.getByTestId("plan-approve-button");
  await expect(approve).toBeVisible();
  await approve.evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

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
      return {
        executionTurnId,
        consentTurnId,
        currentTurnId: snapshot?.currentTurnId ?? "",
      };
    }))
    .toEqual({
      executionTurnId: "e2e-execution-capsule-panel-stability-turn",
      consentTurnId: "e2e-execution-capsule-panel-stability-turn",
      currentTurnId: "e2e-execution-capsule-panel-stability-turn",
    });
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

test("plan approval without a live loop restarts execution on the same conversation turn", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await prepareFormalPlanReview(page);
  await page.evaluate(() => (window as any).__CODELY_E2E__?.dropPlanRunOwner?.());

  await page.getByTestId("plan-approve-button").click();

  await expect
    .poll(async () => page.evaluate(() => {
      const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
      return {
        conversationTurns: snapshot?.conversationTurns ?? null,
        currentTurnId: snapshot?.currentTurnId ?? null,
        startedForTurnId: snapshot?.planApprovalExecutionStartedForTurnId ?? null,
        pendingHandoff: snapshot?.pendingPlanApprovalHandoff ?? null,
      };
    }))
    .toEqual({
      conversationTurns: 1,
      currentTurnId: "e2e-execution-capsule-panel-stability-turn",
      startedForTurnId: "e2e-execution-capsule-panel-stability-turn",
      pendingHandoff: null,
  });
});

test("revoked plan approval cannot be executed by a stale store fallback", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.resetPlanApprovalPrompt?.());
  await page.evaluate(() => (window as any).__CODELY_E2E__?.dropPlanRunOwner?.());
  await page.evaluate(() => (window as any).__CODELY_E2E__?.approveThenRejectBeforeFallback?.());

  await page.waitForTimeout(100);
  await expect
    .poll(async () => page.evaluate(() => {
      const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
      return {
        isPlanApproved: snapshot?.isPlanApproved ?? null,
        currentTurnStatus: snapshot?.currentTurnStatus ?? null,
        startedForTurnId: snapshot?.planApprovalExecutionStartedForTurnId ?? null,
        pendingHandoff: snapshot?.pendingPlanApprovalHandoff ?? null,
      };
    }))
    .toEqual({
      isPlanApproved: false,
      currentTurnStatus: "stopped_no_action",
      startedForTurnId: null,
      pendingHandoff: null,
  });
});

test("busy plan resume queues the visible request without replacing the active owner", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");

  const result = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.attemptBusyPlanResume?.()
  );

  expect(result).toEqual({
    accepted: false,
    ownerPreserved: true,
    queuedText: "继续",
    startedForTurnId: "e2e-execution-capsule-panel-stability-turn",
  });
});

test("failed same-turn execution submission rolls back the started marker and preserves a retry checkpoint", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await prepareFormalPlanReview(page);
  await page.evaluate(() => (window as any).__CODELY_E2E__?.dropPlanRunOwner?.());
  await page.evaluate(() => (window as any).__CODELY_E2E__?.failNextPlanExecutionSubmission?.());

  await page.getByTestId("plan-approve-button").click();

  await expect
    .poll(async () => page.evaluate(() => {
      const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
      return {
        conversationTurns: snapshot?.conversationTurns ?? null,
        currentTurnStatus: snapshot?.currentTurnStatus ?? null,
        agentStatus: snapshot?.agentStatus ?? null,
        startedForTurnId: snapshot?.planApprovalExecutionStartedForTurnId ?? null,
        pendingPlanTurnId: snapshot?.pendingPlanApprovalHandoff?.planTurnId ?? null,
      };
    }))
    .toEqual({
      conversationTurns: 1,
      currentTurnStatus: "paused",
      agentStatus: "idle",
      startedForTurnId: null,
      pendingPlanTurnId: "e2e-execution-capsule-panel-stability-turn",
    });

  await page.getByTestId("plan-resume-button").click();

  await expect
    .poll(async () => page.evaluate(() => {
      const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
      return {
        conversationTurns: snapshot?.conversationTurns ?? null,
        currentTurnStatus: snapshot?.currentTurnStatus ?? null,
        startedForTurnId: snapshot?.planApprovalExecutionStartedForTurnId ?? null,
        pendingPlanTurnId: snapshot?.pendingPlanApprovalHandoff?.planTurnId ?? null,
      };
    }))
    .toEqual({
      conversationTurns: 1,
      currentTurnStatus: "executing",
      startedForTurnId: "e2e-execution-capsule-panel-stability-turn",
      pendingPlanTurnId: null,
    });
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
  await prepareFormalPlanReview(page);

  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);
  await expect(page.getByTestId("plan-approve-button")).toBeVisible();
  await expect(page.locator("blockquote.theme-plan-surface").first()).toBeVisible();

  for (const mode of ["light", "dark", "black"] as const) {
    await page.evaluate((themeMode) => (window as any).__CODELY_E2E__?.setThemeMode?.(themeMode), mode);
    await expect.poll(async () => (
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().themeMode ?? null)
    )).toBe(mode);

    const styles = await page.evaluate(() => {
      const planSurface = document.querySelector<HTMLElement>(".theme-plan-surface");
      const quote = document.querySelector<HTMLElement>("blockquote.theme-plan-surface");
      const primary = document.querySelector<HTMLElement>("[data-testid='plan-approve-button']");
      const rootStyle = getComputedStyle(document.documentElement);
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
