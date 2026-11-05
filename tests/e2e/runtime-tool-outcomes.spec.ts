import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark", "black"]) {
  test(`canonical tool outcomes restore readable steps and disclosed diagnostics in ${theme}`, async ({ page }, testInfo) => {
    await page.goto("/?e2eScenario=awaiting-choice");
    await page.evaluate(async appearance => {
      const store = await import("/src/store/useAppStore.ts");
      const runtime = await import("/src/lib/runtime-v2/index.ts");
      const { formatReadFileWindowForModel } = await import("/src/lib/readFileWindow.ts");
      window.history.replaceState(null, "", "/?e2eScenario=runtime-tool-outcomes");
      const state = store.useAppStore.getState();
      const marker = state.harnessRunMarker!;
      const turn = { workspaceKey: state.currentWorkspace!, sessionKey: marker.sessionKey,
        sessionEpoch: "plan-session-e2e-awaiting-choice", clientSubmissionId: "submit-outcomes", turnId: marker.turnId };
      const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId,
        runId: marker.runId, parentRunId: null, attemptId: "attempt-outcomes" };
      let sequence = 0;
      let aggregate: any = null;
      const append = (type: string, fields: any) => {
        aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
          type, eventId: `outcome-${sequence}`, sequence: sequence++, at: Date.now() + sequence, ...fields } as any);
      };
      append("turn.admitted", { turn, strategy: "execute", objective: "检查工具执行结果", constraints: [], acceptanceCriteria: [] });
      append("run.started", { run, phase: "acting" });
      const longSkill = JSON.stringify({ type: "skill.loaded", id: "global:private-skill-version", name: "Unity CLI", content: '# Unity CLI\n' + 'Use the documented command schema.\n'.repeat(160) });
      const examples = [
        { toolName: "load_skill", target: "Unity CLI", status: "blocked", failureKind: "execution_failed", failureReasonCode: "provider_batch_predecessor_failed", code: "TOOL_NOT_EXECUTED" },
        { toolName: "load_skill", target: "s:internal-ref", status: "succeeded", failureKind: undefined, failureReasonCode: undefined, code: "skill.loaded",
          raw: longSkill, presentationRaw: longSkill.slice(0, 3962) + "\n[Tool output truncated by Runtime v2.]" },
        { toolName: "run_command", target: "outside-scope command", status: "blocked", failureKind: "not_authorized", failureReasonCode: "scope_denied", code: "TOOL_BLOCKED" },
        { toolName: "run_command", target: "exit 6", status: "failed", failureKind: "execution_failed", failureReasonCode: "command_exit_nonzero", code: "TOOL_ERROR" },
        { toolName: "read_file", target: "literal.txt", status: "succeeded", failureKind: undefined, failureReasonCode: undefined, code: "READ_FILE_RESULT",
          raw: formatReadFileWindowForModel("literal.txt", 'const literal = "TOOL_ERROR";\n', { start_line: 1, end_line: 1 }) },
      ];
      const blocks = state.taskFlow.filter(block => block.type === "user");
      examples.forEach((item, index) => {
        const idempotencyKey = `outcome-command-${index}`;
        const raw = item.raw || `${item.code}: ${item.failureReasonCode}; provider-call-${index}`;
        append("command.scheduled", { run, command: { idempotencyKey, kind: "execute_tool", run, phase: "acting",
          payload: { toolName: item.toolName, arguments: { command: item.target } } } });
        append("tool.completed", { run, idempotencyKey, status: item.status, failureKind: item.failureKind,
          failureReasonCode: item.failureReasonCode, evidence: [], modelContent: raw,
          presentation: { toolName: item.toolName, target: item.target, message: item.presentationRaw || raw, observationSummary: item.presentationRaw || raw } });
        // Deliberately restore old, already-settled rows with raw protocol copy.
        blocks.push({ id: 900 + index, type: "tool", turnId: turn.turnId, runId: run.runId,
          toolCallId: idempotencyKey, toolName: item.toolName, target: item.target, toolStatus: "failed", status: "error", message: raw } as any);
      });
      append("run.paused", { run, blocker: { requestId: "outcome-pause", reasonCode: "recovery_stalled", evidenceSequence: sequence - 1,
        message: "执行已暂停，可检查结果。", options: ["recheck", "stop"] } });
      const checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
      const paused = { ...state, config: { ...state.config, workflowMode: "edit", themeMode: appearance },
        taskFlow: blocks, activeActionRequest: null, planArtifacts: [], planTasks: [], planStage: "idle", isPlanApproved: false,
        harnessRunMarker: { ...marker, workflowMode: "edit", runtimeIntent: "execute", status: "paused" },
        conversationTurns: state.conversationTurns.map(item => ({ ...item, mode: "edit", displayIntent: "execute", status: "awaiting_input", blockIds: blocks.map(block => block.id) })),
        runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: checkpoint }), runtimeEvents: [] };
      const snapshot = store.buildSessionRuntimeSnapshotFromStoreState(paused as any);
      const restored = store.buildRestoredSessionRuntimePatch({ snapshot, fallbackState: paused as any,
        workspacePath: turn.workspaceKey, expectedSessionKey: turn.sessionKey, expectedSessionEpoch: turn.sessionEpoch });
      store.useAppStore.setState({ ...restored, config: paused.config } as any);
    }, theme);

    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const steps = page.getByTestId("live-turn-step");
    await expect(steps).toHaveCount(5);
    await expect(steps.nth(0)).toHaveAttribute("data-status", "not_executed");
    await expect(steps.nth(0)).toContainText("未执行");
    await expect(steps.nth(1)).toHaveAttribute("data-status", "done");
    await expect(steps.nth(1)).toContainText("已读取技能「Unity CLI」");
    await expect(steps.nth(2)).toHaveAttribute("data-status", "blocked");
    await expect(steps.nth(2)).toContainText("被阻止");
    await expect(steps.nth(3)).toHaveAttribute("data-status", "failed");
    await expect(steps.nth(3)).toContainText("执行失败");
    await expect(steps.nth(4)).toHaveAttribute("data-status", "done");
    await expect(steps.nth(4)).toContainText("已读取文件第 1–1 行");
    await expect(page.locator("body")).not.toContainText(/TOOL_NOT_EXECUTED|TOOL_BLOCKED|READ_FILE_RESULT|provider-call-|skill\.loaded|global:private-skill-version/);
    await page.screenshot({ path: testInfo.outputPath(`tool-outcomes-${theme}.png`), fullPage: true });
    const first = steps.nth(0);
    // Open the operation card, then its separately disclosed raw diagnostics.
    const details = first.getByTestId("tool-debug-details");
    const toggle = first.getByTestId("turn-archive-step-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await first.getByRole("button", { name: "读取技能：Unity CLI 未执行", exact: true }).click();
    await expect(details).toBeVisible();
    await expect(details.locator("pre")).not.toBeVisible();
    await details.locator("summary").click();
    await expect(details.locator("pre")).toContainText("TOOL_NOT_EXECUTED");
    await expect(details.locator("pre")).toContainText("provider-call-0");
    await page.screenshot({ path: testInfo.outputPath(`tool-diagnostics-${theme}.png`), fullPage: true });
  });
}
