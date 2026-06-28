import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
    const files = ((window as any).__PLAN_FLOW_E2E_FILES__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "write_file") {
        files[String(args?.path ?? "")] = String(args?.content ?? "");
        return null;
      }
      if (cmd === "read_file") {
        const path = String(args?.path ?? "");
        if (Object.prototype.hasOwnProperty.call(files, path)) return files[path];
        throw new Error(`ENOENT: ${path}`);
      }
      if (cmd === "get_file_metadata") return { path: String(args?.path ?? ""), sizeBytes: 1, modifiedMs: 1 };
      if (cmd === "delete_plan_files") {
        for (const key of Object.keys(files)) {
          if (key.startsWith(".MAIN/plans/")) delete files[key];
        }
        return null;
      }
      return null;
    };
  });
});

test("ExecutionCapsule plan adjustment input can be clicked, focused, and submitted", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-flow");

  await expect(page.locator("body")).not.toContainText("[PROPOSAL START]");
  await expect(page.locator("body")).not.toContainText("<user_options>");
  await expect(page.locator("body")).not.toContainText("<tool_use>");
  await expect(page.getByTestId("plan-save-button")).toBeVisible();
  await page.getByTestId("plan-save-button").click();
  await expect(page.getByTestId("plan-save-button")).toHaveAttribute("data-save-state", "saved");

  const adjustmentInput = page.getByTestId("execution-capsule-plan-adjust-input");
  await expect(adjustmentInput).toBeVisible();
  await adjustmentInput.click();
  await expect(adjustmentInput).toBeFocused();
  await adjustmentInput.pressSequentially("请把验证步骤写得更具体");

  await page.getByTestId("execution-capsule-plan-adjust-submit").click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as any).__CODELY_E2E__?.events?.some(
          (item: { type: string; text?: string }) =>
            item.type === "plan-adjustment-submitted" &&
            item.text === "请把验证步骤写得更具体",
        ) ?? false,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          isPlanApproved: snapshot?.isPlanApproved,
          planStage: snapshot?.planStage,
        };
      }),
    )
    .toEqual({
      isPlanApproved: false,
      planStage: "design",
    });
});

test("plan flow supports save then approve and finish", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-flow");

  await expect(page.getByTestId("plan-stage-badge")).toContainText("待审批");
  await expect(page.getByTestId("plan-save-button")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().planTasks?.length ?? -1),
    )
    .toBe(0);

  await page.getByTestId("plan-save-button").click();
  await expect(page.getByTestId("plan-save-button")).toHaveAttribute("data-save-state", "saved");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.savedDocuments?.length ?? 0),
    )
    .toBe(1);

  await expect(page.getByTestId("execution-capsule-plan-approve")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-plan-reject-keep")).toContainText("拒绝并保留");
  await expect(page.getByTestId("execution-capsule-plan-reject-delete")).toContainText("拒绝并删除");
  await expect(page.getByTestId("execution-capsule-plan-adjust-input")).toBeVisible();
  await page.getByTestId("execution-capsule-plan-adjust-input").fill("请把验证步骤写得更具体");
  await page.getByTestId("execution-capsule-plan-adjust-submit").click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as any).__CODELY_E2E__?.events?.some(
          (item: { type: string; text?: string }) =>
            item.type === "plan-adjustment-submitted" &&
            item.text === "请把验证步骤写得更具体",
        ) ?? false,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          isPlanApproved: snapshot?.isPlanApproved,
          planStage: snapshot?.planStage,
        };
      }),
    )
    .toEqual({
      isPlanApproved: false,
      planStage: "design",
    });

  const userCountBeforeApproval = await page.evaluate(
    () => (window as any).__CODELY_E2E__?.getSnapshot?.().taskFlowUserCount ?? 0,
  );

  await expect(page.getByTestId("execution-capsule-plan-approve")).toBeVisible();
  await page.getByTestId("execution-capsule-plan-approve").click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const event = (window as any).__CODELY_E2E__?.events?.find(
          (item: { type: string }) => item.type === "tasks-rewritten",
        );
        if (!event) return null;
        return {
          stage: event.stage,
          firstStatuses: event.statuses.slice(0, 3),
          preservedRuntimeTasks: event.statuses.length >= 3,
        };
      }),
    )
    .toEqual({
      stage: "executing",
      firstStatuses: ["completed", "in_progress", "pending"],
      preservedRuntimeTasks: true,
    });

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const visibleTurns = snapshot?.visibleConversationTurns || [];
        const planTurn = visibleTurns.find((turn: { id?: string }) => turn.id === "e2e-plan-flow-turn");
        const executionTurn = visibleTurns.find(
          (turn: { parentPlanTurnId?: string | null }) =>
            turn.parentPlanTurnId === "e2e-plan-flow-turn",
        );
        return {
          taskFlowUserCount: snapshot?.taskFlowUserCount,
          visibleTurnCount: visibleTurns.length,
          planTurnStatus: planTurn?.status || null,
          executionTurnTitle: executionTurn?.title || null,
          executionTurnParent: executionTurn?.parentPlanTurnId || null,
          currentTurnParent: snapshot?.currentTurnParentPlanTurnId || null,
        };
      }),
    )
    .toEqual({
      taskFlowUserCount: userCountBeforeApproval,
      visibleTurnCount: 2,
      planTurnStatus: "done",
      executionTurnTitle: "执行已批准计划",
      executionTurnParent: "e2e-plan-flow-turn",
      currentTurnParent: "e2e-plan-flow-turn",
    });

  await expect(page.getByTestId("plan-stage-badge")).toContainText("已完成");
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Boolean(
          (window as any).__CODELY_E2E__?.getSnapshot?.().planTasks?.every(
            (task: { status: string }) => task.status === "completed",
          ),
        ),
      ),
    )
    .toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.completed)),
    )
    .toBe(true);
});

test("clearing plan files from file panel removes the global plan toolbar button", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-flow");

  await expect(page.getByTestId("top-plan-panel-button")).toBeVisible();
  await expect(page.getByText("计划工作区").first()).toBeVisible();

  await page.getByLabel("文件").click();
  await expect(page.getByTestId("workspace-clear-plan-files-button")).toBeVisible();
  await page.getByTestId("workspace-clear-plan-files-button").click();

  await expect(page.getByTestId("top-plan-panel-button")).toHaveCount(0);
  await expect(page.getByText("计划工作区")).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          artifacts: snapshot?.planArtifactPaths?.length ?? -1,
          tasks: snapshot?.planTasks?.length ?? -1,
          stage: snapshot?.planStage ?? null,
          showPlanPanel: snapshot?.showPlanPanel ?? null,
          rightPanelTab: snapshot?.rightPanelTab ?? null,
        };
      }),
    )
    .toEqual({
      artifacts: 0,
      tasks: 0,
      stage: "idle",
      showPlanPanel: false,
      rightPanelTab: "terminal",
    });
});

test("plan approval quick reply approves instead of re-sending an unapproved plan turn", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-quick-reply-approval");

  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toContainText("批准执行");

  await page.getByTestId("execution-capsule-reply-option-0").click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          isPlanApproved: snapshot?.isPlanApproved,
          planStage: snapshot?.planStage,
          taskFlowUserCount: snapshot?.taskFlowUserCount,
        };
      }),
    )
    .toEqual({
      isPlanApproved: true,
      planStage: "executing",
      taskFlowUserCount: 1,
    });

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const entries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
        return entries.some((entry: { source?: string; message?: string }) =>
          entry.source === "ui.quickReply_plan_approval" &&
          String(entry.message || "").includes("先运行诊断脚本"),
        );
      }),
    )
    .toBe(true);
});

for (const scenario of ["plan-quick-reply-materialize-gemma", "plan-quick-reply-materialize-qwen"] as const) {
  test(`${scenario} materializes visible plan before approval`, async ({ page }) => {
    await page.goto(`/?e2eScenario=${scenario}`);

    await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
    await expect(page.getByTestId("execution-capsule-reply-option-0")).toContainText("批准执行");

    await page.getByTestId("execution-capsule-reply-option-0").click();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
          return {
            isPlanApproved: snapshot?.isPlanApproved,
            planStage: snapshot?.planStage,
            planArtifactPaths: snapshot?.planArtifactPaths || [],
            taskFlowUserCount: snapshot?.taskFlowUserCount,
          };
        }),
      )
      .toEqual({
        isPlanApproved: true,
        planStage: "executing",
        planArtifactPaths: [".MAIN/plans/plan.md"],
        taskFlowUserCount: 1,
      });

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const entries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
          return {
            materialized: entries.some((entry: { source?: string }) =>
              entry.source === "ui.quickReply_plan_materialized",
            ),
            bypassedExecute: entries.some((entry: { source?: string; message?: string }) =>
              entry.source === "store.session_run_start" &&
              String(entry.message || "").includes('"intent":"execute"') &&
              String(entry.message || "").includes('"planStage":"idle"'),
            ),
          };
        }),
      )
      .toEqual({
        materialized: true,
        bypassedExecute: false,
      });
  });
}
