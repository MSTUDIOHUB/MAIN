import { expect, test } from "@playwright/test";
import { installCapsuleFixtureStartup } from "./capsuleFixtureStartup";

for (const theme of ["light", "dark", "black"]) {
 for (const scenario of ["execution choice", "clarification", "verification"] as const) {
  test(`durable ${scenario} restores from its ledger and dispatches the same Run in ${theme}`, async ({ page }, testInfo) => {
    await installCapsuleFixtureStartup(page);
    await page.goto("/?e2eScenario=awaiting-choice");
    await expect.poll(() => page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      return useAppStore.getState().harnessRunMarker?.runId;
    })).toBe("run-e2e-awaiting-choice");
    const clarification = scenario === "clarification";
    const verification = scenario === "verification";
    await page.evaluate(async ({ appearance, clarification, verification }) => {
      const store = await import("/src/store/useAppStore.ts");
      const runtime = await import("/src/lib/runtime-v2/index.ts");
      const { executionRecoveryOptions } = await import("/src/store/runtimeV2/executionBlocker.ts");
      // Disable the old presentation-only choice fixture's click shortcut.
      window.history.replaceState(null, "", "/?e2eScenario=runtime-execution-blocker");
      const state = store.useAppStore.getState();
      const marker = state.harnessRunMarker!;
      const turn = { workspaceKey: state.currentWorkspace!, sessionKey: marker.sessionKey,
        sessionEpoch: "plan-session-e2e-awaiting-choice", clientSubmissionId: "submit-blocker", turnId: marker.turnId };
      const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId,
        runId: marker.runId, parentRunId: null, attemptId: "attempt-blocker" };
      let sequence = 0;
      const event = (type: string, fields: any) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
        type, eventId: `blocker-event-${sequence}`, sequence: sequence++, at: Date.now() + sequence, ...fields });
      let aggregate = runtime.transition(null, event("turn.admitted", { turn, strategy: "execute", objective: "检查缺失条件并继续", constraints: [], acceptanceCriteria: ["条件可用"] }) as any);
      aggregate = runtime.transition(aggregate, event("run.started", { run, phase: "observing" }) as any);
      if (verification) {
        const append = (type: string, fields: Record<string, unknown>) => { aggregate = runtime.transition(aggregate, event(type, { run, ...fields }) as any); };
        const schedule = (decision = {}) => {
          const command = runtime.decideNextCommands(aggregate, decision)[0]!;
          append("command.scheduled", { command });
          return command;
        };
        const path = "Assets/Game.cs";
        const version = `sha256-${"b".repeat(64)}`;
        const model = schedule();
        append("provider.responded", { idempotencyKey: model.idempotencyKey, result: { visibleText: "", toolCalls: [{ id: "write-game", name: "write_file", arguments: { path, content: "class Game {}" } }], diagnostics: [] } });
        append("phase.changed", { phase: "acting", reason: "pending_mutation_call" });
        const write = schedule();
        append("tool.completed", { idempotencyKey: write.idempotencyKey, status: "succeeded", effectKind: "workspace_change", evidence: [{ id: "game-write", kind: "mutation", target: path, previousVersion: "absent", version }] });
        append("phase.changed", { phase: "validating", reason: "mutation_committed" });
        const compile = schedule({ checkUnityCompilation: true });
        append("tool.completed", { idempotencyKey: compile.idempotencyKey, status: "succeeded", evidence: [], modelContent: JSON.stringify({
          status: "passed", kind: "csharp", projectRoot: ".", editor: "connected", editorPid: 42, editorVersion: "6000.6.5f1", targets: [{ path, version }],
        }) });
      }
      aggregate = runtime.transition(aggregate, event("run.paused", { run, blocker: { requestId: "durable-blocker", reasonCode: clarification ? "intent_clarification" : verification ? "recovery_stalled" : "external_state_required",
        evidenceSequence: aggregate.nextSequence - 1, message: clarification ? "请选择目标：staging 或 production。" : "当前需要的条件尚未满足，执行已暂停。", ...executionRecoveryOptions(aggregate),
        ...(clarification ? { clarification: { kind: "target_ambiguity", field: "target", evidence: "staging or production", question: "请选择目标。", choices: ["staging", "production"] } } : {}) } }) as any);
      const checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
      const paused = { ...state, config: { ...state.config, workflowMode: "edit", themeMode: appearance },
        taskFlow: state.taskFlow.filter(block => block.type === "user"), activeActionRequest: null,
        planArtifacts: [], planTasks: [], planStage: "idle", isPlanApproved: false,
        harnessRunMarker: { ...marker, workflowMode: "edit", runtimeIntent: "execute", status: "paused" },
        conversationTurns: state.conversationTurns.map(item => ({ ...item, mode: "edit", displayIntent: "execute", status: "awaiting_input" })),
        runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: checkpoint }), runtimeEvents: [] };
      const snapshot = store.buildSessionRuntimeSnapshotFromStoreState(paused);
      const restored = store.buildRestoredSessionRuntimePatch({ snapshot, fallbackState: paused,
        workspacePath: turn.workspaceKey, expectedSessionKey: turn.sessionKey, expectedSessionEpoch: turn.sessionEpoch });
      store.useAppStore.setState({ ...restored, config: paused.config } as any);
      (window as any).__BLOCKER_TEST_DISPATCHES__ = [];
      const submit = store.useAppStore.getState().sendMessage;
      store.useAppStore.setState({ sendMessage: (text: string, files: any, options: any) => {
        if (options?.executionResumeRequestId) {
          const current = store.useAppStore.getState();
          (window as any).__BLOCKER_TEST_DISPATCHES__.push({ options,
            decision: (runtime.normalizeRuntimeV2Checkpoint(current.runtimeV2Checkpoints[turn.turnId]) as any)?.aggregate.run.blocker.decision });
          // Only the scheduler boundary is captured here. Real inference/tool execution has its own lane.
          store.useAppStore.setState({ activeActionRequest: null });
          return true;
        }
        return submit(text, files, options);
      } } as any);
    }, { appearance: theme, clarification, verification });

    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
    await expect(page.getByTestId("execution-capsule-reply-option-0")).toContainText(clarification ? "staging" : verification ? "重新验收" : "重新检查");
    if (verification) {
      const details = page.getByTestId("execution-capsule-verification");
      await expect(details).toContainText("Unity C# 编译通过");
      await expect(details).toContainText("当前修改仍缺与任务目标对应的自动验收结果");
      await expect(details).toContainText("请按实际场景核对「条件可用」");
      await expect(details).toContainText("如果已手动确认结果，或打算稍后再验证，选“保留修改并结束”");
      await expect(page.getByTestId("execution-capsule-reply-option-1")).toContainText("保留修改并结束");
      await expect(page.getByTestId("execution-capsule-reply-option-2")).toContainText("取消本轮");
      await expect(page.getByTestId("execution-capsule-reply-option-1")).toBeInViewport();
      await expect(page.getByRole("button", { name: "结束本轮", exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByTestId(`execution-capsule-reply-option-${clarification ? 2 : 1}`)).toContainText("停止任务");
    }
    await expect(page.getByTestId("execution-capsule-custom-reply-input")).toHaveCount(clarification ? 1 : 0);
    await expect(page.getByText("继续其他可行工作", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.replaceAll(" ", "-")}-${theme}.png`), fullPage: true });
    const choice = page.getByTestId(`execution-capsule-reply-option-${verification ? 1 : 0}`);
    if (verification) {
      await choice.focus();
      await expect(choice).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      await choice.click();
    }
    await expect.poll(async () => page.evaluate(() => (window as any).__BLOCKER_TEST_DISPATCHES__)).toEqual([
      expect.objectContaining({ decision: verification ? "continue" : "recheck", options: expect.objectContaining({ reuseCurrentTurn: true,
        turnIdOverride: "e2e-awaiting-choice-turn", runIdOverride: "run-e2e-awaiting-choice", executionResumeRequestId: "durable-blocker" }) }),
    ]);
  });
 }
}
