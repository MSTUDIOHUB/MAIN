import { expect, test, type Page } from "@playwright/test";

/** Exercise the real ChatArea, typed resolver and serialized session ledger without inference. */
async function mountPlanQuestions(page: Page, theme: "light" | "dark" | "black") {
  await page.addInitScript(() => {
    localStorage.clear();
    let callback = 1;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => callback++, unregisterCallback() {},
      invoke: async (command: string) => {
        if (["list_all_session_snapshots", "list_legacy_session_files", "list_project_sessions", "discover_personal_agent_skills"].includes(command)) return [];
        if (command === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
        if (command === "plugin:event|listen") return callback++;
        if (command === "get_system_memory") return { total_gb: 32, available_gb: 24 };
        if (["start_chat_stream", "stream_chat", "proxy_request"].includes(command)) throw new Error("No model transport is allowed in this history fixture");
        return null;
      },
    };
  });
  await page.goto("/?e2eScenario=awaiting-choice");
  await expect.poll(() => page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    return useAppStore.getState().harnessRunMarker?.runId;
  })).toBe("run-e2e-awaiting-choice");
  await page.evaluate(async theme => {
    const store = await import("/src/store/useAppStore.ts");
    const runtime = await import("/src/lib/runtime-v2/index.ts");
    window.history.replaceState(null, "", "/?e2eScenario=question-answer-history");
    const state = store.useAppStore.getState();
    const marker = state.harnessRunMarker!;
    const turn = { workspaceKey: state.currentWorkspace!, sessionKey: marker.sessionKey,
      sessionEpoch: "plan-session-e2e-awaiting-choice", clientSubmissionId: "submit-question-history", turnId: marker.turnId };
    const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId,
      runId: marker.runId, parentRunId: null, attemptId: "attempt-question-history" };
    let sequence = 0;
    const event = (type: string, fields: any) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      type, eventId: `question-history-${sequence}`, sequence: sequence++, at: Date.now() + sequence, ...fields });
    let aggregate = runtime.transition(null, event("turn.admitted", { turn, strategy: "plan", planPurpose: "plan",
      objective: "设计一个可离线运行的应用", constraints: [], acceptanceCriteria: [] }) as any);
    aggregate = runtime.transition(aggregate, event("run.started", { run, phase: "planning" }) as any);
    aggregate = runtime.transition(aggregate, event("run.paused", { run, blocker: { requestId: "history-question-1",
      reasonCode: "user_questionnaire", evidenceSequence: 1, message: "先确认交付范围", options: ["recheck", "stop"],
      questionnaire: { revision: 1, purpose: "plan_interview", title: "确认交付范围", summary: "设计一个可离线运行的应用，保留现有资料。", questions: [
        { id: "platform", prompt: "希望交付到哪个平台？", selectionMode: "single", required: true,
          options: [{ id: "desktop", label: "桌面应用", description: "在本地运行" }, { id: "web", label: "网页应用" }] },
        { id: "checks", prompt: "需要哪些验证？", selectionMode: "multiple", required: true,
          options: [{ id: "unit", label: "单元验证" }, { id: "ui", label: "界面验证" }] },
        { id: "notes", prompt: "还有哪些补充要求？", selectionMode: "text", required: false, options: [] },
      ] } } }) as any);
    const checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
    const paused = { ...state, config: { ...state.config, themeMode: theme, workflowMode: "plan" },
      taskFlow: state.taskFlow.filter(block => block.type === "user"), activeActionRequest: null,
      planArtifacts: [], planTasks: [], planStage: "idle", showPlanPanel: false, isPlanApproved: false,
      runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: checkpoint }), runtimeEvents: [] };
    const snapshot = store.buildSessionRuntimeSnapshotFromStoreState(paused);
    const restored = store.buildRestoredSessionRuntimePatch({ snapshot, fallbackState: paused,
      workspacePath: turn.workspaceKey, expectedSessionKey: turn.sessionKey, expectedSessionEpoch: turn.sessionEpoch });
    store.useAppStore.setState({ ...restored, config: paused.config, showPlanPanel: false } as any);
    (window as any).__QUESTION_HISTORY_DISPATCHES__ = [];
    store.useAppStore.setState({ sendMessage: (_text: string, _files: any, options: any) => {
      if (!options?.executionResumeRequestId) throw new Error("Unexpected model dispatch in question history fixture");
      const current = store.useAppStore.getState();
      const checkpoint = runtime.normalizeRuntimeV2Checkpoint(current.runtimeV2Checkpoints[turn.turnId])!;
      const aggregate = checkpoint.aggregate;
      (window as any).__QUESTION_HISTORY_DISPATCHES__.push({ options, answer: aggregate.run?.blocker?.decisionAnswer,
        turnIds: current.conversationTurns.map(item => item.id) });
      const resumed = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
        type: "run.resumed", sequence: aggregate.nextSequence, eventId: `question-history-resumed:${options.executionResumeRequestId}`, at: aggregate.updatedAt + 1,
        run, requestId: options.executionResumeRequestId });
      const nextCheckpoint = runtime.createRuntimeV2Checkpoint({ aggregate: resumed, revision: checkpoint.revision + 1, updatedAt: resumed.updatedAt });
      store.useAppStore.setState({ activeActionRequest: null,
        runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: nextCheckpoint }),
        harnessRunMarker: { ...current.harnessRunMarker!, status: "running" },
        conversationTurns: current.conversationTurns.map(item => ({ ...item, collapsed: true, status: "running" })),
      } as any);
      return true;
    } } as any);
  }, theme);
  await expect(page.getByTestId("structured-user-questionnaire")).toBeVisible();
}

test("a restored validation question opens the hidden capsule and resumes the original plan", async ({ page }) => {
  await mountPlanQuestions(page, "dark");
  const form = page.getByTestId("structured-user-questionnaire");
  const capsule = page.getByTestId("agent-explanation-capsule");
  const turnId = await capsule.getAttribute("data-turn-id");
  const runId = await capsule.getAttribute("data-run-id");
  expect(turnId).toBeTruthy();
  expect(runId).toBeTruthy();
  await form.getByRole("radio", { name: /桌面应用/ }).check();
  await form.getByRole("checkbox", { name: "单元验证", exact: true }).check();
  await form.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    useAppStore.setState({ agentStatus: "running" });
  });
  await capsule.getByTitle("隐藏", { exact: true }).click();
  await expect(capsule).toHaveClass(/collapsed-ring/);

  const requestId = "history-execution-validation";
  const prompt = "是否允许为当前方案加入自动验收？";
  await page.evaluate(async ({ requestId, prompt }) => {
    const store = await import("/src/store/useAppStore.ts");
    const runtime = await import("/src/lib/runtime-v2/index.ts");
    const state = store.useAppStore.getState();
    const marker = state.harnessRunMarker!;
    const checkpoint = runtime.normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[marker.turnId])!;
    const aggregate = checkpoint.aggregate;
    const paused = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      type: "run.paused", sequence: aggregate.nextSequence, eventId: "history-validation-paused", at: aggregate.updatedAt + 1,
      run: aggregate.run!.identity, blocker: { requestId, reasonCode: "user_questionnaire",
        evidenceSequence: aggregate.nextSequence - 1, message: prompt, options: ["recheck", "stop"],
        questionnaire: { revision: 2, purpose: "plan_interview", title: "补全计划验证", questions: [
          { id: "execution_validation", prompt, selectionMode: "text", required: true, options: [] },
        ] },
      },
    });
    const next = runtime.createRuntimeV2Checkpoint({ aggregate: paused, revision: checkpoint.revision + 1, updatedAt: paused.updatedAt });
    const persisted = JSON.parse(JSON.stringify(store.buildSessionRuntimeSnapshotFromStoreState({ ...state,
      harnessRunMarker: { ...marker, status: "paused" },
      runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ [marker.turnId]: next }),
    })));
    const restored = store.buildRestoredSessionRuntimePatch({ snapshot: persisted, fallbackState: state,
      workspacePath: state.currentWorkspace!, expectedSessionKey: marker.sessionKey, expectedSessionEpoch: checkpoint.owner.sessionEpoch });
    store.useAppStore.setState({ ...restored, agentStatus: "idle" } as any);
  }, { requestId, prompt });

  await expect(capsule).toHaveAttribute("data-request-id", requestId);
  await expect(capsule).toHaveAttribute("data-turn-id", turnId!);
  await expect(capsule).toHaveAttribute("data-run-id", runId!);
  await expect(capsule).not.toHaveClass(/collapsed-ring/);
  await expect(form).toBeVisible();
  await expect(form.getByRole("button", { name: /批准/ })).toHaveCount(0);
  const reply = "允许新增自动验收，请沿用已经读过的项目资料。";
  await form.getByRole("textbox", { name: prompt }).fill(reply);
  await form.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect(form).toHaveCount(0);
  const dispatches = await page.evaluate(() => (window as any).__QUESTION_HISTORY_DISPATCHES__);
  expect(dispatches).toHaveLength(2);
  expect(dispatches[1]).toMatchObject({ options: { hidden: true, reuseCurrentTurn: true, turnIdOverride: turnId,
    runIdOverride: runId, executionResumeRequestId: requestId, resolvedIntent: "plan" }, turnIds: [turnId],
    answer: { requestId, revision: 2, answers: [{ questionId: "execution_validation", selectedValues: [], text: reply }] } });
  await expect(page.getByTestId("user-question-answer-card").last()).toContainText(reply);
});

for (const theme of ["light", "dark", "black"] as const) {
  test(`confirmed answers stay paired with their questions in ChatArea and session restore in ${theme}`, async ({ page }, testInfo) => {
    await mountPlanQuestions(page, theme);
    const form = page.getByTestId("structured-user-questionnaire");
    const history = page.getByTestId("user-question-answer-history");
    await expect(history).toHaveCount(0);
    await form.getByRole("radio", { name: /桌面应用/ }).check();
    await form.getByRole("checkbox", { name: "单元验证", exact: true }).check();
    await form.getByRole("checkbox", { name: "界面验证", exact: true }).check();
    await form.getByRole("textbox", { name: "还有哪些补充要求？", exact: true }).fill("保留现有资料。\n全程离线运行。");
    await expect(history).toHaveCount(0);
    await form.getByRole("button", { name: "确认并继续", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__QUESTION_HISTORY_DISPATCHES__.length)).toBe(1);
    await expect(history).toBeVisible();
    await expect(form).toHaveCount(0);
    const card = page.getByTestId("user-question-answer-card");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-request-id", "history-question-1");
    await expect(card).toContainText("确认交付范围");
    await expect(card).toContainText("已确认");
    const rows = card.getByTestId("user-question-answer-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("希望交付到哪个平台？");
    await expect(rows.nth(0)).toContainText("桌面应用");
    await expect(rows.nth(0)).not.toContainText("网页应用");
    await expect(rows.nth(1)).toContainText("需要哪些验证？");
    await expect(rows.nth(1)).toContainText("单元验证");
    await expect(rows.nth(1)).toContainText("界面验证");
    await expect(rows.nth(2)).toContainText("还有哪些补充要求？");
    await expect(rows.nth(2)).toContainText("保留现有资料。");
    await expect(rows.nth(2)).toContainText("全程离线运行。");
    await expect(card).not.toContainText("selectedValues");
    await expect(card).not.toContainText("questionId");
    await card.screenshot({ path: testInfo.outputPath(`question-answer-history-${theme}.png`), animations: "disabled" });

    await page.evaluate(async () => {
      const store = await import("/src/store/useAppStore.ts");
      const runtime = await import("/src/lib/runtime-v2/index.ts");
      const state = store.useAppStore.getState();
      const marker = state.harnessRunMarker!;
      const snapshot = store.buildSessionRuntimeSnapshotFromStoreState(state);
      // Round-trip the on-disk form: history must not depend on a second materialized aggregate.
      const serialized = JSON.parse(JSON.stringify(snapshot));
      serialized.runtimeV2Checkpoints = runtime.serializeRuntimeV2CheckpointMap(serialized.runtimeV2Checkpoints);
      const restored = store.buildRestoredSessionRuntimePatch({ snapshot: serialized, fallbackState: state,
        workspacePath: state.currentWorkspace!, expectedSessionKey: marker.sessionKey,
        expectedSessionEpoch: "plan-session-e2e-awaiting-choice" });
      store.useAppStore.setState(restored as any);
    });
    await expect(card).toHaveCount(1);
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("桌面应用");
    await expect(rows.nth(2)).toContainText("全程离线运行。");
    await expect(history).toBeVisible();
  });
}
