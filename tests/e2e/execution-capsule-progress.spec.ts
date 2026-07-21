import { expect, test, type Page } from "@playwright/test";

const ACTIVE_CAPSULE_STATUSES = ["analyzing", "planning", "executing", "validating", "recovering"] as const;
const INACTIVE_CAPSULE_STATUSES = [
  "awaiting_approval",
  "awaiting_permission",
  "awaiting_choice",
  "paused",
  "completed",
  "partial",
  "blocked",
  "canceled",
  "error",
] as const;

async function readCapsuleBeam(page: Page) {
  return page.getByTestId("agent-explanation-capsule").evaluate((capsule) => {
    const beam = capsule.querySelector<SVGSVGElement>("[data-testid='capsule-rotate-beam']");
    const segments = Array.from(capsule.querySelectorAll<SVGRectElement>(".capsule-rotate-beam__segment"));
    const beamStyle = beam ? getComputedStyle(beam) : null;
    return {
      beamOpacity: Number(beamStyle?.opacity || 0),
      beamPointerEvents: beamStyle?.pointerEvents || "",
      beamTransitionDuration: beamStyle?.transitionDuration || "",
      segments: segments.map((segment) => {
        const style = getComputedStyle(segment);
        return {
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          animationTimingFunction: style.animationTimingFunction,
          animationIterationCount: style.animationIterationCount,
          animationPlayState: style.animationPlayState,
          dashArray: style.strokeDasharray,
          filter: style.filter,
          pathLength: Number(segment.getAttribute("pathLength")),
          perimeter: segment.getTotalLength(),
          stroke: style.stroke,
        };
      }),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("Capsule beam follows a normalized rounded-rect path at constant speed", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/?e2eScenario=execution-capsule-execution-progress");

  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toBeVisible();
  await expect(page.getByTestId("capsule-rotate-beam")).toHaveCount(1);

  for (const status of ACTIVE_CAPSULE_STATUSES) {
    await capsule.evaluate((element, nextStatus) => element.setAttribute("data-capsule-status", nextStatus), status);
    const beam = await readCapsuleBeam(page);
    expect(beam.beamOpacity).toBeGreaterThan(0);
    expect(beam.beamPointerEvents).toBe("none");
    expect(beam.beamTransitionDuration).toBe("0.2s");
    expect(beam.segments).toHaveLength(4);
    for (const segment of beam.segments) {
      expect(segment.animationName).toBe("capsule-beam-travel");
      expect(segment.animationDuration).toBe("4.2s");
      expect(segment.animationTimingFunction).toBe("linear");
      expect(segment.animationIterationCount).toBe("infinite");
      expect(segment.animationPlayState).toBe("running");
      expect(segment.pathLength).toBe(100);
      expect(segment.perimeter).toBeGreaterThan(0);
      expect(segment.filter).toBe("none");
    }
    expect(beam.segments[0]?.dashArray).toMatch(/40(?:px)?[, ]+60(?:px)?/);
  }

  for (const status of INACTIVE_CAPSULE_STATUSES) {
    await capsule.evaluate((element, nextStatus) => element.setAttribute("data-capsule-status", nextStatus), status);
    await expect.poll(async () => (await readCapsuleBeam(page)).beamOpacity).toBeLessThan(0.01);
    expect((await readCapsuleBeam(page)).segments.every((segment) => segment.animationPlayState === "paused")).toBe(true);
  }
});

test("Capsule beam follows theme intensity and keeps the same motion when collapsed", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?e2eScenario=execution-capsule-execution-progress");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.setTheme?.("green"));

  const capsule = page.getByTestId("agent-explanation-capsule");
  const expectedStrength = { light: 0.56, dark: 0.72, black: 0.78 } as const;
  for (const mode of ["light", "dark", "black"] as const) {
    await page.evaluate((themeMode) => (window as any).__CODELY_E2E__?.setThemeMode?.(themeMode), mode);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await expect.poll(async () => (await readCapsuleBeam(page)).beamOpacity).toBeCloseTo(expectedStrength[mode], 2);

    const colors = await capsule.evaluate((element) => {
      const segment = element.querySelector<SVGRectElement>(".capsule-rotate-beam__segment--head");
      const accentLight = getComputedStyle(document.documentElement).getPropertyValue("--accent-light").trim();
      const probe = document.createElement("span");
      probe.style.color = accentLight;
      document.body.appendChild(probe);
      const normalizedAccentLight = getComputedStyle(probe).color;
      probe.remove();
      return {
        normalizedAccentLight,
        segmentStroke: segment ? getComputedStyle(segment).stroke : "",
      };
    });
    const beam = await readCapsuleBeam(page);
    expect(beam.beamOpacity).toBeCloseTo(expectedStrength[mode], 2);
    expect(colors.segmentStroke).toBe(colors.normalizedAccentLight);
    await capsule.screenshot({ path: testInfo.outputPath(`capsule-rotate-beam-${mode}.png`) });
  }

  await page.getByTitle("隐藏").click();
  await expect(capsule).toHaveClass(/collapsed-ring/);
  const collapsed = await readCapsuleBeam(page);
  expect(collapsed.segments.every((segment) => segment.animationPlayState === "running")).toBe(true);
  const collapsedAnimations = await capsule.evaluate((element) => ({
    capsule: getComputedStyle(element).animationName,
    icon: getComputedStyle(element.querySelector<HTMLElement>(".animate-pulse")!).animationName,
  }));
  expect(collapsedAnimations.capsule).toBe("none");
  expect(collapsedAnimations.icon).toBe("none");
  await capsule.screenshot({ path: testInfo.outputPath("capsule-rotate-beam-collapsed.png") });
});

test("Capsule beam becomes a static low-intensity indicator for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?e2eScenario=execution-capsule-execution-progress");

  const beam = await readCapsuleBeam(page);
  expect(beam.beamOpacity).toBeCloseTo(0.72 * 0.42, 2);
  expect(beam.segments.every((segment) => segment.animationName === "none")).toBe(true);
  expect(beam.segments.every((segment) => segment.animationPlayState === "running")).toBe(true);
});

test("ExecutionCapsule does not invent execution step progress from plain tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-execution-progress");

  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-execution-badge")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-execution-progress")).toHaveCount(0);
});

test("active Capsule shows exact-run public model commentary alongside structured activity", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-execution-progress");

  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toBeVisible();
  await expect(capsule.getByTestId("capsule-status-label")).toHaveText("正在执行");
  await expect(capsule.getByTestId("capsule-commentary-label")).toHaveText(
    "模型进展：当前判断：已确认展示层入口，正在核对活动状态与运行身份。",
  );
  await expect(capsule.getByTestId("capsule-activity-label")).toBeVisible();
  await expect(capsule).not.toContainText("**");
});

test("pure plan execution keeps the runtime checkpoint in the main Capsule without duplicating its task tracker", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-plan-task-progress");

  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-plan-badge")).toHaveCount(0);
  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toBeVisible();
  await expect(capsule.getByTestId("capsule-status-label")).toHaveText("正在执行");
  await expect(capsule.getByTestId("capsule-activity-label")).toHaveText("正在执行已批准计划");
  await expect(capsule).not.toContainText("apply_patch");
  await expect(capsule).not.toContainText("src/task-9.ts");
  await expect(capsule).not.toContainText("阶段：tool_start");
  await expect(page.getByTestId("plan-execution-runtime-progress")).toHaveCount(0);
  await expect(page.getByTestId("plan-task-progress")).toContainText("8/9");
  await expect(page.getByTestId("plan-task-progress")).toContainText("T1: 更新");
  await expect(page.getByTestId("plan-task-progress")).toContainText("T8: 更新");
  await expect(page.getByTestId("plan-task-progress")).toContainText("T9: 更新");
});

test("approved child-run progress replaces its parent review pause in Run Status", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-plan-task-progress");

  await page.getByTitle("查看运行状态").click();
  const progressPopover = page.getByTestId("effective-progress-popover");
  await expect(progressPopover).toBeVisible();
  await expect(progressPopover).toContainText("正在执行已批准计划");
  await expect(progressPopover).toContainText("apply_patch · src/task-9.ts");
  await expect(progressPopover).not.toContainText("等待审核");
  await expect(progressPopover).not.toContainText("计划产物已物化");
  await expect(progressPopover).not.toContainText("旧审核进度");
});

test("preapproval Plan recovery keeps internal phases and heartbeats out of user UI", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.showPlanDraftRecovery?.());

  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toBeVisible();
  await expect(capsule.getByTestId("capsule-status-label")).toHaveText("正在制定计划");
  await expect(capsule).not.toContainText("正在整理已确认信息，生成可审批计划");
  await expect(capsule).not.toContainText("我已读取 tauri.conf.json");
  await expect(capsule).not.toHaveAttribute("data-plan-runtime-phase", /.+/);
  await expect(page.getByTestId("plan-draft-runtime-progress")).toHaveCount(0);
  await expect(page.locator("[data-plan-runtime-phase]")).toHaveCount(0);
  await expect(page.getByTestId("plan-review-capsule")).toHaveCount(0);
  await expect(page.getByTestId("plan-execution-runtime-progress")).toHaveCount(0);
  await page.getByTitle("查看运行状态").click();
  await expect(page.getByTestId("effective-progress-popover")).toContainText("暂无运行状态");
  await expect(page.locator("body")).not.toContainText(/Needs rewrite|Drafting|草稿结构不完整|65 秒|隐藏推理正文不会展示|SECRET MODEL REASONING/);
});

test("pending user choice renders only in the global Capsule with its exact action identity", async ({ page }) => {
  await page.goto("/?e2eScenario=awaiting-choice");

  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toBeVisible();
  await expect(capsule).toHaveAttribute("data-action-kind", "user_choice");
  await expect(capsule).toHaveAttribute("data-session-key", "/tmp/e2e-awaiting-choice:999006");
  await expect(capsule).toHaveAttribute("data-turn-id", "e2e-awaiting-choice-turn");
  await expect(capsule).toHaveAttribute("data-run-id", "run-e2e-awaiting-choice");
  await expect(capsule).toHaveAttribute("data-request-id", "request-e2e-awaiting-choice");
  await expect(capsule.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(capsule.getByTestId("execution-capsule-reply-option-0")).toContainText("先修暂停等待选择");
  await expect(page.getByTestId("turn-choice-checkpoint")).toHaveCount(0);
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
  await expect(page.getByTestId("execution-capsule-tool-review")).not.toContainText("printf");
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

test("task tracking popover preserves authored checklist order with runtime-only current highlight", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-pending-tool-review");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.showPendingToolReviewPrompt?.());

  await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
  await page.getByTitle("任务跟踪").click();
  await expect(page.getByTestId("tasks-progress-popover")).toBeVisible();

  const taskIds = await page.locator("[data-testid='tasks-progress-popover'] [data-task-id]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-task-id"))
  );
  expect(taskIds.slice(0, 4)).toEqual([
    "review-plan-task-1",
    "review-plan-task-2",
    "review-plan-task-3",
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

  await expect(page.getByTestId("capsule-status-label")).toHaveText("等待权限");
  await expect(page.getByTestId("agent-explanation-capsule")).not.toContainText("run_command");
  await expect(page.getByTestId("agent-explanation-capsule")).not.toContainText("阶段：waiting_review");
  await expect(page.getByTestId("plan-execution-runtime-progress")).toHaveCount(0);
});

test("ExecutionCapsule renders approval controls from pendingToolCall when the pending tool card is missing", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-orphan-pending-review");

  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().agentStatus ?? null)).toBe("idle");
  await expect(page.getByTestId("execution-capsule-shell")).toHaveCount(0);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.showOrphanPendingReviewPrompt?.());
  await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-tool-review")).toContainText("批准此工具请求");
  await expect(page.getByTestId("execution-capsule-tool-review")).not.toContainText("SnakeController.cs");

  await page.getByTestId("execution-capsule-tool-approve-once").click();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().pendingReviewTaskId ?? null))
    .toBeNull();
});

test("a second permission request owned by a child run stays in the global Capsule", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.showChildRunToolApprovalPrompt?.());

  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toHaveAttribute("data-action-kind", "tool_permission");
  await expect(capsule).toHaveAttribute("data-run-id", /-child$/);
  await expect(page.getByTestId("execution-capsule-tool-review")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-tool-approve-once")).toBeVisible();
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
  await expect(page.getByTestId("execution-capsule-tool-review")).toHaveCount(0);
  await expect(page.getByTestId("plan-review-capsule")).toBeVisible();
  await expect(page.getByTestId("plan-review-panel")).toBeVisible();
  await expect(page.getByTestId("plan-approve-button")).toBeVisible();
}

test("typed Plan review Capsule preserves the exact request and artifact identity", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await prepareFormalPlanReview(page, {
    runId: "run-e2e-plan-review",
    requestId: "request-e2e-plan-review",
    reset: false,
  });

  await expect(page.getByTestId("plan-review-panel")).toContainText("ExecutionCapsule 面板稳定回归");
  const capsule = page.getByTestId("plan-review-capsule");
  await expect(capsule).toHaveAttribute("data-action-kind", "plan_review");
  await expect(capsule).toHaveAttribute("data-turn-id", "e2e-execution-capsule-panel-stability-turn");
  await expect(capsule).toHaveAttribute("data-run-id", "run-e2e-plan-review");
  await expect(capsule).toHaveAttribute("data-request-id", "request-e2e-plan-review");
  await expect(capsule).toHaveAttribute("data-plan-revision", "1");
  await expect(capsule).toHaveAttribute("data-artifact-hash", /.+/);
  await expect(page.getByTestId("plan-review-capsule-open")).toContainText("审阅计划");
  await expect(page.getByTestId("plan-review-capsule-approve")).toContainText("批准执行");
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
  test(`Plan review Capsule remains visible and opens PlanPanel from: ${mode}`, async ({ page }) => {
    await page.goto("/?e2eScenario=execution-capsule-panel-stability");
    await prepareFormalPlanReview(page);
    await page.evaluate((nextMode) => (window as any).__CODELY_E2E__?.setPanelMode?.(nextMode), mode);

    await expect(page.getByTestId("plan-review-capsule")).toBeVisible();
    await expect(page.getByTestId("plan-review-capsule")).toHaveAttribute("data-action-kind", "plan_review");
    if (mode !== "plan") {
      await page.getByTestId("plan-review-capsule-open").click();
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

test("Plan review Capsule approves the exact request while the right panel is closed", async ({ page }) => {
  await page.goto("/?e2eScenario=execution-capsule-panel-stability");
  await prepareFormalPlanReview(page, {
    runId: "run-e2e-plan-review-capsule",
    requestId: "request-e2e-plan-review-capsule",
    reset: false,
  });
  await page.evaluate(() => (window as any).__CODELY_E2E__?.setPanelMode?.("closed"));

  await expect(page.getByTestId("right-panel")).toHaveCount(0);
  await expect(page.getByTestId("plan-review-capsule")).toHaveAttribute(
    "data-request-id",
    "request-e2e-plan-review-capsule",
  );
  await page.getByTestId("plan-review-capsule-approve").click();

  await expect.poll(async () => (
    page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().isPlanApproved ?? false)
  )).toBe(true);
  await expect(page.getByTestId("plan-review-capsule")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-tool-review")).toHaveCount(0);
});

test("double-clicking PlanPanel approval remains one same-Turn ActionDecision", async ({ page }) => {
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
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().conversationTurns ?? null))
    .toBe(1);
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().taskFlowUserCount ?? null))
    .toBe(1);
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnId ?? ""))
    .toBe("e2e-execution-capsule-panel-stability-turn");
  await expect
    .poll(async () => page.evaluate(() => {
      const entries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
      const queued = entries
        .filter((entry: { source?: string }) => entry.source === "store.plan_approval_same_turn_execution_queued")
        .map((entry: { message?: string }) => JSON.parse(String(entry.message || "{}")));
      return {
        count: queued.length,
        planTurnId: queued[0]?.planTurnId ?? null,
        executionTurnId: queued[0]?.executionTurnId ?? null,
      };
    }))
    .toEqual({
      count: 1,
      planTurnId: "e2e-execution-capsule-panel-stability-turn",
      executionTurnId: "e2e-execution-capsule-panel-stability-turn",
    });
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().executionChildTurns ?? null))
    .toBe(0);
  await expect.poll(async () => page.evaluate(() => {
    const entries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
    return entries.filter(
      (entry: { source?: string }) => entry.source === "store.workspace_instruction_admitted",
    ).length;
  })).toBe(0);
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
        currentTurnResultKind: snapshot?.currentTurnResultKind ?? null,
        startedForTurnId: snapshot?.planApprovalExecutionStartedForTurnId ?? null,
        pendingHandoff: snapshot?.pendingPlanApprovalHandoff ?? null,
      };
    }))
    .toEqual({
      isPlanApproved: false,
      currentTurnStatus: "done",
      currentTurnResultKind: "canceled",
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
        planLifecycleStatus: snapshot?.planLifecycleStatus ?? null,
        startedForTurnId: snapshot?.planApprovalExecutionStartedForTurnId ?? null,
        pendingPlanTurnId: snapshot?.pendingPlanApprovalHandoff?.planTurnId ?? null,
      };
    }))
    .toEqual({
      conversationTurns: 1,
      currentTurnStatus: "paused",
      agentStatus: "idle",
      planLifecycleStatus: "paused",
      startedForTurnId: null,
      pendingPlanTurnId: null,
    });

  await page.getByTestId("plan-resume-button").click();

  await expect
    .poll(async () => page.evaluate(() => {
      const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
      return {
        conversationTurns: snapshot?.conversationTurns ?? null,
        startedForTurnId: snapshot?.planApprovalExecutionStartedForTurnId ?? null,
        pendingPlanTurnId: snapshot?.pendingPlanApprovalHandoff?.planTurnId ?? null,
      };
    }))
    .toEqual({
      conversationTurns: 1,
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
  await expect(page.getByTestId("plan-review-capsule")).toBeVisible();
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
