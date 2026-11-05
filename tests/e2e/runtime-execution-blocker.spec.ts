import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark", "black"]) {
 for (const clarification of [false, true]) {
  test(`durable ${clarification ? "clarification" : "execution choice"} restores from its ledger and dispatches the same Run in ${theme}`, async ({ page }, testInfo) => {
    await page.goto("/?e2eScenario=awaiting-choice");
    await page.evaluate(async ({ appearance, clarification }) => {
      const store = await import("/src/store/useAppStore.ts");
      const runtime = await import("/src/lib/runtime-v2/index.ts");
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
      aggregate = runtime.transition(aggregate, event("run.paused", { run, blocker: { requestId: "durable-blocker", reasonCode: clarification ? "intent_clarification" : "recovery_stalled",
        evidenceSequence: 1, message: clarification ? "请选择目标：staging 或 production。" : "当前需要的条件尚未满足，执行已暂停。", options: ["recheck", "stop"],
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
    }, { appearance: theme, clarification });

    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
    await expect(page.getByTestId("execution-capsule-reply-option-0")).toContainText(clarification ? "staging" : "重新检查");
    await expect(page.getByTestId(`execution-capsule-reply-option-${clarification ? 2 : 1}`)).toContainText("停止任务");
    await expect(page.getByTestId("execution-capsule-custom-reply-input")).toHaveCount(clarification ? 1 : 0);
    await expect(page.getByText("继续其他可行工作", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${clarification ? "clarification" : "execution-pause"}-${theme}.png`), fullPage: true });
    await page.getByTestId("execution-capsule-reply-option-0").click();
    await expect.poll(async () => page.evaluate(() => (window as any).__BLOCKER_TEST_DISPATCHES__)).toEqual([
      expect.objectContaining({ decision: "recheck", options: expect.objectContaining({ reuseCurrentTurn: true,
        turnIdOverride: "e2e-awaiting-choice-turn", runIdOverride: "run-e2e-awaiting-choice", executionResumeRequestId: "durable-blocker" }) }),
    ]);
  });
 }
}
