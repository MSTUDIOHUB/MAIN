import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  collectBlockingPlanTaskTextsForTerminalSummary,
  collectPlanTaskTerminalProjection,
  resolveCompletedTurnFinalPresentation,
  resolvePausedTurnFinalPresentation,
  resolveTerminalTurnOwnership,
  shouldCommitCompletedTurnFinalPresentation,
  shouldCommitPausedTurnFinalPresentation,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/terminalAssistantFinal.ts"),
);
const { buildCanonicalCompletedTurnMessages } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnContext.ts"),
);
const { isNoOpToolFeedback } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/toolFeedbackEnvelope.ts"),
);

const userBlock = { id: 1, turnId: "turn-1", type: "user", content: "修复并验证问题" };
const writeBlock = {
  id: 2,
  turnId: "turn-1",
  type: "tool",
  toolName: "replace_in_file",
  target: "src/main.ts",
  status: "done",
  toolStatus: "executed",
  message: "replacement applied",
  diff: { old: "before", new: "after", path: "src/main.ts" },
};
const validationBlock = {
  id: 3,
  turnId: "turn-1",
  type: "tool",
  toolName: "run_command",
  target: "npm test",
  status: "done",
  toolStatus: "executed",
  message: "Process exited with code 0\n12 tests passed",
};

test("published model final remains canonical while durable evidence determines change status", () => {
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, writeBlock, validationBlock],
    publishedModelFinalText: "修复完成，测试已通过。",
    language: "zh",
  });

  assert.equal(result.source, "model_final");
  assert.equal(result.text, "修复完成，测试已通过。");
  assert.equal(result.hasChanges, true);
  assert.deepEqual(result.execution.modifiedFiles, ["src/main.ts"]);
  assert.deepEqual(result.execution.validations, ["run_command: npm test"]);
});

test("tool-only completion gets a deterministic Codex-style final from durable evidence", () => {
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, writeBlock, validationBlock],
    publishedModelFinalText: null,
    language: "zh",
  });

  assert.equal(result.source, "durable_evidence_fallback");
  assert.match(result.text, /^已完成本轮工作。/);
  assert.match(result.text, /修改\n- `src\/main\.ts`/);
  assert.match(result.text, /验证\n- run_command: npm test/);
  assert.doesNotMatch(result.text, /agent_loop_completed/);
});

test("no-op workspace mutations do not claim file changes or completed_with_changes", () => {
  const noOpWrite = {
    ...writeBlock,
    id: 9,
    diff: undefined,
    message: JSON.stringify({ success: true, noOp: true, message: "File already matched requested content." }),
  };
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, noOpWrite],
    publishedModelFinalText: null,
    language: "zh",
  });

  assert.equal(isNoOpToolFeedback(noOpWrite.message), true);
  assert.equal(result.hasChanges, false);
  assert.deepEqual(result.execution.modifiedFiles, []);
  assert.doesNotMatch(result.text, /修改\n|`src\/main\.ts`/);
});

test("multi-file apply_patch summaries retain every structured changed file", () => {
  const changedFiles = [
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/d.ts",
    "src/e.ts",
    "src/f.ts",
  ];
  const multiFilePatch = {
    ...writeBlock,
    id: 10,
    toolName: "apply_patch",
    target: "Workspace patch",
    diff: {
      old: "combined old preview",
      new: "combined new preview",
      path: "src/a.ts, src/b.ts, src/c.ts, and 3 more",
    },
    message: JSON.stringify({ success: true, changedFiles }),
  };
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, multiFilePatch],
    publishedModelFinalText: null,
    language: "zh",
  });

  assert.deepEqual(result.execution.modifiedFiles, changedFiles);
  for (const path of changedFiles) assert.match(result.text, new RegExp(path.replace("/", "\\/")));
  assert.doesNotMatch(result.text, /and 3 more|Workspace patch/);
});

test("structured no-effect feedback uses the same no-op classifier", () => {
  const feedback = '[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"no_effect_mutation","tool_call_id":"call-1","tool":"replace_in_file","target":"src/main.ts"}\nNo durable change';
  assert.equal(isNoOpToolFeedback(feedback), true);
});

test("held draft cannot masquerade as final when completion falls back to durable evidence", () => {
  const heldDraft = {
    id: 4,
    turnId: "turn-1",
    type: "agent",
    content: "我将继续修改另一个文件。",
    visibility: "assistant_update",
  };
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, heldDraft, writeBlock],
    publishedModelFinalText: null,
    language: "zh",
  });

  assert.equal(result.source, "durable_evidence_fallback");
  assert.doesNotMatch(result.text, /继续修改另一个文件/);
  assert.match(result.text, /`src\/main\.ts`/);
  assert.match(result.text, /未记录独立的自动验证结果/);
});

test("durable recovery pause gets a self-contained non-success assistant conclusion", () => {
  const heldDraft = {
    id: 11,
    turnId: "turn-1",
    type: "agent",
    content: "我已经全部完成，现在准备收尾。",
    visibility: "assistant_update",
  };
  const result = resolvePausedTurnFinalPresentation({
    turnBlocks: [userBlock, heldDraft, writeBlock],
    durableMutationPaths: ["src/main.ts"],
    unfinished: ["修复文件打开后的预览同步", "运行浏览器交互验收"],
    nextStep: "从保留的文件版本继续精确修改并重新验证。",
    language: "zh",
  });

  assert.equal(result.source, "durable_progress_checkpoint");
  assert.equal(result.hasChanges, true);
  assert.match(result.text, /^本轮执行已暂停，已完成的修改与持久证据均已保留。/);
  assert.match(result.text, /已做\n- 已修改 `src\/main\.ts`/);
  assert.match(result.text, /未做\n- 修复文件打开后的预览同步\n- 运行浏览器交互验收/);
  assert.match(result.text, /验证\n- 未记录独立的自动验证结果。/);
  assert.match(result.text, /下一步\n- 从保留的文件版本继续精确修改并重新验证。/);
  assert.doesNotMatch(result.text, /我已经全部完成|已完成本轮工作/);
});

test("unfinished evidence produces a non-success terminal report", () => {
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, writeBlock],
    publishedModelFinalText: null,
    unfinished: ["验证预览同步"],
    language: "zh",
  });

  assert.match(result.text, /^本轮执行已结束，但仍有未完成项。/);
  assert.match(result.text, /未完成\n- 验证预览同步/);
  assert.doesNotMatch(result.text, /^已完成本轮工作。/);
});

test("blocking unfinished evidence overrides a model-authored success claim", () => {
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, writeBlock],
    publishedModelFinalText: "全部完成，所有要求均已满足。",
    unfinished: ["仍需运行真实桌面验证"],
    language: "zh",
  });

  assert.equal(result.source, "durable_evidence_fallback");
  assert.match(result.text, /^本轮执行已结束，但仍有未完成项。/);
  assert.match(result.text, /仍需运行真实桌面验证/);
  assert.doesNotMatch(result.text, /全部完成，所有要求均已满足/);
});

test("accepted Plan validation advisories do not become terminal unfinished work", () => {
  const projection = collectPlanTaskTerminalProjection({
    availableToolNames: ["read_file", "run_command"],
    evidenceLedger: [{
      id: "source-change-evidence",
      kind: "file",
      value: "src/main.ts",
      target: "src/main.ts",
      sourceTool: "replace_in_file",
      planTaskId: "source-change",
      createdAt: 1,
    }],
    tasks: [
      {
        id: "source-change",
        text: "修改源码",
        status: "completed",
        evidenceStatus: "satisfied",
        evidence: [{ kind: "file", value: "src/main.ts" }],
      },
      {
        id: "user-review",
        text: "请用户确认桌面窗口",
        status: "in_progress",
        evidenceStatus: "requires_user_confirmation",
        evidence: [{ kind: "manual_user_validation", value: "确认桌面窗口" }],
      },
      {
        id: "tauri-review",
        text: "在 Tauri 中复核系统文件对话框",
        status: "in_progress",
        evidenceStatus: "requires_tauri_validation",
        evidence: [
          { kind: "manual_user_validation", value: "复核系统文件对话框" },
          { kind: "tauri_required", value: "desktop runtime" },
        ],
      },
      {
        id: "browser-review",
        text: "在浏览器中复核最终布局",
        status: "in_progress",
        evidenceStatus: "requires_browser_validation",
        validationCapability: "browser_dom",
        evidence: [{ kind: "browser_dom", value: "browser DOM validation", inferred: true }],
      },
    ],
  });
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, writeBlock],
    publishedModelFinalText: null,
    unfinished: projection.blocking,
    advisories: projection.advisories,
    language: "zh",
  });

  assert.deepEqual(projection.blocking, []);
  assert.deepEqual(projection.advisories, [
    "请用户确认桌面窗口",
    "在 Tauri 中复核系统文件对话框",
    "在浏览器中复核最终布局",
  ]);
  assert.match(result.text, /^已完成本轮工作。/);
  assert.doesNotMatch(result.text, /仍有未完成项|未完成\n/);
  assert.match(result.text, /建议复核/);
  assert.match(result.text, /在浏览器中复核最终布局/);
  assert.deepEqual(result.execution.unfinished, []);
  assert.deepEqual(result.execution.advisories, projection.advisories);
});

test("a model-authored final keeps non-blocking manual review visible", () => {
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock, writeBlock],
    publishedModelFinalText: "实现与自动验证均已完成。",
    advisories: ["在 Tauri 中复核系统文件对话框"],
    language: "zh",
  });

  assert.equal(result.source, "model_final");
  assert.match(result.text, /^实现与自动验证均已完成。/);
  assert.match(result.text, /建议复核\n- 在 Tauri 中复核系统文件对话框/);
});

test("explicit interactive browser acceptance remains blocking when browser tools are unavailable", () => {
  const blocking = collectBlockingPlanTaskTextsForTerminalSummary({
    availableToolNames: ["read_file", "run_command"],
    evidenceLedger: [],
    tasks: [{
      id: "browser-interaction",
      requirementRef: "USER-VALIDATION-1234",
      text: "点击打开并确认预览内容更新",
      status: "in_progress",
      evidenceStatus: "requires_browser_validation",
      validationCapability: "browser_dom",
      evidence: [{
        kind: "browser_dom",
        value: "browser interaction: open preview",
        requiresInteraction: true,
      }],
    }],
  });

  assert.deepEqual(blocking, ["点击打开并确认预览内容更新"]);
});

test("terminal turn ownership binds hidden continuation evidence to the visible owner", () => {
  assert.deepEqual(resolveTerminalTurnOwnership({
    turnId: "turn-hidden-execution",
    uiDisplayTurnId: "turn-visible-plan",
  }), {
    ownerTurnId: "turn-visible-plan",
    evidenceTurnIds: ["turn-hidden-execution", "turn-visible-plan"],
  });
});

test("browser validation remains terminal unfinished work when browser tools are available", () => {
  const blocking = collectBlockingPlanTaskTextsForTerminalSummary({
    availableToolNames: ["read_file", "browser_evaluate"],
    evidenceLedger: [],
    tasks: [{
      id: "browser-review",
      text: "在浏览器中复核最终交互",
      status: "in_progress",
      evidenceStatus: "requires_browser_validation",
      validationCapability: "browser_dom",
      evidence: [{ kind: "browser_dom", value: "最终交互", requiresInteraction: true }],
    }],
  });

  assert.deepEqual(blocking, ["在浏览器中复核最终交互"]);
});

test("Plan terminal summary keeps genuinely blocking evidence gaps", () => {
  const blocking = collectBlockingPlanTaskTextsForTerminalSummary({
    evidenceLedger: [],
    tasks: [{
      id: "missing-validation",
      text: "运行聚焦测试",
      status: "in_progress",
      evidenceStatus: "missing",
      evidence: [{ kind: "cmd", value: "npm test" }],
    }],
  });

  assert.deepEqual(blocking, ["运行聚焦测试"]);
});

test("blank completion without evidence is visible but does not invent an outcome reason", () => {
  const result = resolveCompletedTurnFinalPresentation({
    turnBlocks: [userBlock],
    publishedModelFinalText: "",
    language: "zh",
  });

  assert.match(result.text, /没有留下可恢复的最终说明/);
  assert.doesNotMatch(result.text, /agent_loop_completed/);
});

test("canonical persisted history prefers assistant_final over later progress prose", () => {
  const messages = buildCanonicalCompletedTurnMessages({
    turnBlocks: [
      userBlock,
      { id: 5, turnId: "turn-1", type: "agent", content: "最终结论", visibility: "assistant_final" },
      { id: 6, turnId: "turn-1", type: "agent", content: "正在继续处理", visibility: "user_progress" },
    ],
    fallbackAssistantText: "fallback",
  });

  assert.deepEqual(messages, [
    { role: "user", content: "修复并验证问题" },
    { role: "assistant", content: "最终结论" },
  ]);
});

test("assistant_final visibility survives a persisted JSON reload", () => {
  const restoredBlocks = JSON.parse(JSON.stringify([
    userBlock,
    { id: 7, turnId: "turn-1", type: "agent", content: "持久最终结论", visibility: "assistant_final" },
    { id: 8, turnId: "turn-1", type: "agent", content: "旧进度", visibility: "user_progress" },
  ]));
  const messages = buildCanonicalCompletedTurnMessages({
    turnBlocks: restoredBlocks,
    fallbackAssistantText: "fallback",
  });

  assert.equal(restoredBlocks[1].visibility, "assistant_final");
  assert.equal(messages.at(-1).content, "持久最终结论");
});

test("paused, error, stopped, and pending continuation outcomes never synthesize a success final", () => {
  for (const outcomeStatus of ["paused", "error", "stopped_no_output", "stopped_no_action", "aborted"]) {
    assert.equal(shouldCommitCompletedTurnFinalPresentation({ outcomeStatus }), false, outcomeStatus);
  }
  assert.equal(shouldCommitCompletedTurnFinalPresentation({
    outcomeStatus: "completed",
    hasPendingSameTurnExecution: true,
  }), false);
  assert.equal(shouldCommitCompletedTurnFinalPresentation({ outcomeStatus: "completed" }), true);
});

test("recoverable no-progress pauses commit a partial assistant final", () => {
  assert.equal(shouldCommitPausedTurnFinalPresentation({
    outcomeStatus: "paused",
    recoveryReason: "execute_recovery_no_progress_limit",
    hasDurableMutationEvidence: true,
  }), true);
  assert.equal(shouldCommitPausedTurnFinalPresentation({
    outcomeStatus: "paused",
    recoveryReason: "execute_no_progress_batch_loop",
    hasDurableMutationEvidence: false,
  }), true);
  for (const input of [
    { outcomeStatus: "stopped_no_action", recoveryReason: "execute_recovery_no_progress_limit", hasDurableMutationEvidence: true },
    { outcomeStatus: "paused", recoveryReason: "awaiting_user_choice", hasDurableMutationEvidence: true },
    { outcomeStatus: "paused", recoveryReason: "execute_recovery_no_progress_limit", hasDurableMutationEvidence: false },
    { outcomeStatus: "paused", recoveryReason: "execute_recovery_no_progress_limit", hasDurableMutationEvidence: true, hasPendingSameTurnExecution: true },
  ]) {
    assert.equal(shouldCommitPausedTurnFinalPresentation(input), false, JSON.stringify(input));
  }
});

test("execute batch-loop exhaustion commits a paused final without mutation evidence", () => {
  assert.equal(shouldCommitPausedTurnFinalPresentation({
    outcomeStatus: "paused",
    recoveryReason: "execute_no_progress_batch_loop",
    hasDurableMutationEvidence: false,
  }), true);

  const workflowSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );
  const pausedFinalStart = workflowSource.indexOf("const ensurePausedTurnFinalPresentation");
  const pausedFinalEnd = workflowSource.indexOf("const projectHarnessForAgentLoopOutcome", pausedFinalStart);
  const pausedFinalSource = workflowSource.slice(pausedFinalStart, pausedFinalEnd);
  assert.match(pausedFinalSource, /outcome\.reason !== "execute_no_progress_batch_loop"/);
  assert.match(
    pausedFinalSource,
    /outcome\.reason === "execute_recovery_no_progress_limit"[\s\S]*durableMutationEvidence\.length === 0/,
  );
  assert.match(pausedFinalSource, /visibility: "assistant_final" as const/);
});

test("pause then completion reuses one assistant_final for the same logical turn", () => {
  const workflowSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );
  const completedStart = workflowSource.indexOf("const ensureCompletedTurnFinalPresentation");
  const completedEnd = workflowSource.indexOf("const ensurePausedTurnFinalPresentation", completedStart);
  const completedSource = workflowSource.slice(completedStart, completedEnd);
  const pausedStart = completedEnd;
  const pausedEnd = workflowSource.indexOf("const projectHarnessForAgentLoopOutcome", pausedStart);
  const pausedSource = workflowSource.slice(pausedStart, pausedEnd);

  assert.match(pausedSource, /const existingTerminalFinalBlock = \[\.\.\.turnBlocks\]\.reverse\(\)\.find/);
  assert.match(pausedSource, /const finalBlockId = existingTerminalFinalBlock\?\.id \?\? current\._nextTaskId\(\)/);
  assert.match(completedSource, /const reusableFinalBlock = matchingPublishedBlock \|\| existingTerminalFinalBlock \|\| null/);
  assert.match(completedSource, /const finalBlockId = reusableFinalBlock\?\.id \?\? current\._nextTaskId\(\)/);
  assert.match(
    completedSource,
    /block\.visibility === "assistant_final"[\s\S]*block\.id !== finalBlockId[\s\S]*visibility: "assistant_update"/,
  );
});

test("workflow terminal contract persists only completed finals and uses supported ChatArea statuses", () => {
  const workflowSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const chatSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");

  assert.match(workflowSource, /if \(outcome\.status !== "completed"\) return null;/);
  assert.match(workflowSource, /shouldCommitCompletedTurnFinalPresentation\(\{/);
  assert.match(workflowSource, /shouldCommitPausedTurnFinalPresentation\(\{/);
  assert.match(workflowSource, /ensurePausedTurnFinalPresentation\(loopOutcome\)/);
  assert.match(workflowSource, /emitLocalPlanExecutionProgress\("paused",\s*\{/);
  assert.match(workflowSource, /paused_turn_final_presentation_committed/);
  assert.match(workflowSource, /!context\.executionEvidenceDraftHeld/);
  assert.match(workflowSource, /visibility: "assistant_final" as const/);
  assert.match(workflowSource, /completedTurnHasChanges \? "completed_with_changes" : "done"/);
  assert.match(workflowSource, /collectPlanTaskTerminalProjection\(\{/);
  assert.match(workflowSource, /resolveTerminalTurnOwnership\(\{/);
  assert.match(workflowSource, /candidate\.id === terminalOwnership\.ownerTurnId/);
  assert.match(workflowSource, /advisories: planTerminalProjection\.advisories/);
  assert.match(workflowSource, /availableToolNames: terminalAvailableToolNames/);
  assert.doesNotMatch(workflowSource, /filter\(\(task: any\) => task\.evidenceStatus !== "satisfied"\)/);
  assert.doesNotMatch(workflowSource, /outcome\.status === "completed"\s*\? "completed"/);
  assert.match(storeSource, /\.\.\.\(b\.visibility \? \{ visibility: b\.visibility \} : \{\}\)/);
  assert.match(storeSource, /block\.visibility !== "assistant_final"/);
  assert.match(chatSource, /block\.visibility === "assistant_final"/);
  assert.match(chatSource, /isPausedWithFinalConclusion/);
  assert.match(chatSource, /data-testid=\{block\.visibility === "assistant_final" \? "assistant-final" : undefined\}/);
});

test("Feishu completion cards are emitted only after completed terminal commitment", () => {
  const workflowSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );
  const callbackStart = workflowSource.indexOf("onAssistantFinalText:");
  const callbackEnd = workflowSource.indexOf("onToolExecuting:", callbackStart);
  const callbackSource = workflowSource.slice(callbackStart, callbackEnd);
  const terminalStart = workflowSource.indexOf("return prepareSubagentsForNewTurn().then(executeLoopStrategy)");
  const completionGate = workflowSource.indexOf("shouldCommitCompletedTurnFinalPresentation({", terminalStart);
  const terminalCommit = workflowSource.indexOf("commitTerminalProjectionBeforeStatusPublication(", completionGate);
  const terminalCommitGuard = workflowSource.indexOf("if (!terminalProjectionCommitted)", terminalCommit);
  const completionCard = workflowSource.indexOf('feishuCardTitle: language === "en" ? "Task Complete" : "任务处理完成"', terminalCommitGuard);

  assert.notEqual(callbackStart, -1);
  assert.ok(callbackEnd > callbackStart);
  assert.doesNotMatch(callbackSource, /Task Complete|任务处理完成/);
  assert.match(callbackSource, /remoteFeishu && awaitingInput[\s\S]*?"Input Required"[\s\S]*?"需要用户选择"/);
  assert.ok(completionGate >= terminalStart);
  assert.ok(terminalCommit > completionGate);
  assert.ok(terminalCommitGuard > terminalCommit);
  assert.ok(completionCard > terminalCommitGuard);
});
