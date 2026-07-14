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
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildExecuteNoProgressLoopPauseNotice,
  buildFailedFiniteValidationRecoveryPrompt,
  buildExecuteRecoveryPrompt,
  buildExecuteValidationRecoveryPrompt,
  describeExecuteRecoveryToolSurface,
  isExecutePatchMismatchRecoveryActivity,
  isExecuteRecoveryToolName,
  resolveExecuteRecoveryBatchDecision,
  resolveExecuteReadOnlyRecoveryTrigger,
  resolveExecutePatchRecoveryTarget,
  resolveReadOnlyNoProgressTrigger,
  shouldAllowExecuteRecoveryFileRead,
  shouldBypassExecuteReadCacheForPatchRecovery,
  shouldUseExecutePatchRecoveryReadLease,
  summarizeRepeatedExecuteTargets,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/executeRecoveryTools.ts"));

const {
  buildChatFinalSynthesisPrompt,
  buildEmptyModelResponsePauseNotice,
  buildMaxStepsFinalTextPrompt,
  resolveAgentLoopIterationBudget,
  resolveAgentLoopMaxIterations,
  shouldTriggerChatFinalSynthesis,
  shouldUseMaxStepsFinalTextOnly,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/agentLoopSafety.ts"));

const {
  compactContextForExecuteRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/contextTrim.ts"));

const {
  handleExecuteNoToolRecovery,
  isExecuteRuntimeRequiringEvidence,
  resolveExecuteNoToolCheckpointLimit,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeNoToolRecovery.ts"));

const {
  handleMaxIterationBoundary,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/maxIterationBoundary.ts"));

const {
  resolveIterationToolSurface,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"));

const {
  handleNoProgressRecovery,
  handleRepeatedEditValidationRecovery,
  resolveDirectMutationPreflightRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"));

const {
  partitionToolCallsForExecution,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"));

const readOnlyTools = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

function createExecuteNoToolHarness(language = "en") {
  const appended = [];
  const statuses = [];
  const streamTokens = [];
  const stops = [];
  return {
    appended,
    statuses,
    streamTokens,
    stops,
    callbacks: {
      getPreferredLanguage: () => language,
      appendMessage: (message) => appended.push(message),
      onStatusChange: (status) => statuses.push(status),
      onStreamToken: (token, id) => streamTokens.push({ token, id }),
      onNonActionableStop: (message, reason, progress) => stops.push({ message, reason, progress }),
    },
  };
}

function createExecuteNoToolInput(harness, overrides = {}) {
  return {
    callbacks: harness.callbacks,
    activeProfile: "cloud",
    iteration: 2,
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    forceXmlTools: false,
    availableToolNames: new Set(["read_file", "apply_patch", "run_command"]),
    effectiveToolCallCount: 0,
    finalReplyOptionsCount: 0,
    shouldPauseForUserChoice: false,
    sawExecuteOperationEvidence: false,
    visibleText: "I have completed the requested changes and verified them.",
    assistantMsgId: "assistant-1",
    consecutiveNoToolCount: 0,
    ...overrides,
  };
}

test("execute no-tool recovery reprompts completion claims without evidence", () => {
  const harness = createExecuteNoToolHarness("en");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.deepEqual(harness.streamTokens, [{ token: "__ESCALATION_RESET__:", id: "assistant-1" }]);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /no real tool evidence/i);
  assert.match(harness.appended[0].content, /Start real tool actions/i);
  assert.equal(harness.stops.length, 0);
});

test("generic max-iteration boundary emits stop, idle, and a resumable run pause in order", async () => {
  const order = [];
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      onNonActionableStop: (_message, reason, progress) => {
        order.push(`stop:${reason}:${progress?.recoveryReason}`);
      },
      onStatusChange: (status) => order.push(`status:${status}`),
    },
    workflowMode: "chat",
    runtimeIntent: "respond",
    effectiveMaxIterations: 8,
    recentPlanToolActivity: [],
    recentToolActivity: [],
    lastAssistantTextForCheckpoint: "",
    sawExecuteOperationEvidence: false,
    executeRecoveryMode: "off",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: (reason) => order.push(`run:paused:${reason}`),
  });

  assert.deepEqual(order, [
    "stop:no_action:max_iterations_boundary",
    "status:idle",
    "run:paused:max_iterations_boundary",
  ]);
});

test("execute max-iteration callback can schedule auto-resume without consuming the counter", async () => {
  let autoResumeCount = 0;
  const stops = [];
  const statuses = [];
  const pausedRuns = [];

  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => autoResumeCount,
      onExecuteMaxIterationsCheckpoint: (checkpoint) => ({
        status: "auto_resume_scheduled",
        checkpoint: { ...checkpoint, autoResumeCount: 1 },
      }),
      onNonActionableStop: (...args) => stops.push(args),
      onStatusChange: (status) => statuses.push(status),
    },
    workflowMode: "edit",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: [],
    recentToolActivity: [],
    lastAssistantTextForCheckpoint: "still working",
    sawExecuteOperationEvidence: true,
    executeRecoveryMode: "normal",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: (reason, message) => pausedRuns.push({ reason, message }),
  });

  assert.equal(autoResumeCount, 0);
  assert.deepEqual(stops, []);
  assert.deepEqual(statuses, ["idle"]);
  assert.equal(pausedRuns[0].reason, "max_iterations_auto_resume");
  assert.match(pausedRuns[0].message, /auto-resume once in a fresh context/);
});

test("execute no-tool recovery stops local completion loops at checkpoint", () => {
  const harness = createExecuteNoToolHarness("zh");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness, {
    activeProfile: "local",
    consecutiveNoToolCount: 4,
    visibleText: "已经修复完成并验证通过。",
  }));

  assert.equal(resolveExecuteNoToolCheckpointLimit("local"), 5);
  assert.equal(resolveExecuteNoToolCheckpointLimit("cloud") < resolveExecuteNoToolCheckpointLimit("local"), true);
  assert.equal(result.status, "stopped");
  assert.equal(result.consecutiveNoToolCount, 5);
  assert.deepEqual(harness.statuses, ["running", "idle"]);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "no_action");
  assert.match(harness.stops[0].message, /没有产生真实工具调用或文件变更/);
});

test("execute no-tool recovery reprompts XML profiles to emit executable tool calls", () => {
  const harness = createExecuteNoToolHarness("zh");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness, {
    activeProfile: "local",
    forceXmlTools: true,
    turnIntent: "respond",
    runtimeIntent: "studio_workflow",
    visibleText: "我会先修改文件，然后运行验证。",
  }));

  assert.equal(isExecuteRuntimeRequiringEvidence({
    workflowMode: "plan",
    turnIntent: "respond",
    runtimeIntent: "studio_workflow",
  }), true);
  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /uses XML tool calls/i);
  assert.match(harness.appended[0].content, /<tool_use>/);
  assert.match(harness.appended[0].content, /read_file, apply_patch, run_command/);
});

test("execute recovery mutation-first surface removes broad reads and search tools", () => {
  const names = [
    "list_directory",
    "glob_search",
    "grep_search",
    "read_file",
    "read_document",
    "index_workspace_documents",
    "get_file_outline",
    "apply_patch",
    "replace_in_file",
    "write_file",
    "execute_command",
    "run_command",
    "browser_evaluate",
    "send_pty_input",
    "get_pty_status",
  ];
  const scoped = names.filter((name) => isExecuteRecoveryToolName(name, readOnlyTools, {
    mode: "mutation_first",
  }));

  assert.deepEqual(scoped, [
    "apply_patch",
    "replace_in_file",
    "write_file",
  ]);
  assert.equal(describeExecuteRecoveryToolSurface("mutation_first"), "mutation_only");
  assert.equal(describeExecuteRecoveryToolSurface("mutation_first", true), "mutation_only");
  assert.equal(describeExecuteRecoveryToolSurface("action_plus_targeting", true), "action_plus_targeted_file_read");
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "mutation_first",
    allowFileRead: true,
  }), false);
  assert.equal(isExecuteRecoveryToolName("grep_search", readOnlyTools, {
    mode: "mutation_first",
    allowFileRead: true,
  }), false);
});

test("a repeated read-only loop enters mutation-first instead of patch-context reread", () => {
  const activations = [];
  const result = handleNoProgressRecovery({
    callbacks: {
      getIsPlanApproved: () => false,
      getPreferredLanguage: () => "zh",
    },
    activeProfile: "local",
    workflowMode: "edit",
    runtimeIntent: "goal",
    iteration: 3,
    results: [{
      toolCallId: "read-3",
      name: "read_file",
      target: "src/App.tsx",
      content: "FILE_UNCHANGED_STUB: src/App.tsx",
      isError: false,
    }],
    recentToolActivity: [
      { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "READ_FILE_RESULT" },
      { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "FILE_UNCHANGED_STUB" },
    ],
    recentPlanToolActivity: [],
    sawExecuteOperationEvidence: false,
    executeRecoveryMode: "normal",
    executeRecoveryReason: "",
    executeRecoveryAttempts: 0,
    repairExecutionRequestInChat: false,
    latestUserPromptText: "修复白屏",
    isUnapprovedPlanReadOnlyBatch: false,
    planReadOnlyConvergenceBatches: 0,
    planReadOnlyConvergenceTools: 0,
    approvedPlanNoProgressRecoveryAttempts: 0,
    tracking: {
      lastNoProgressBatchSignature: "",
      noProgressBatchRepeatCount: 0,
      consecutiveReadFileOnlyCacheHits: 2,
    },
    activateExecuteRecovery: (mode, reason, context) => activations.push({ mode, reason, context }),
    activateChatFinalSynthesis: () => {},
    emitTaskOrchestratorPhase: () => {},
  });

  assert.equal(result.status, "none");
  assert.equal(activations[0].mode, "mutation_first");
  assert.equal(activations[0].reason, "read_file_only_loop");
  assert.match(result.pendingExecuteRecoveryPrompt, /mutation_only/);
  assert.doesNotMatch(result.pendingExecuteRecoveryPrompt, /可使用定向 `read_file`/);
});

test("an unavailable stale read is blocked before execute-recovery batch deferral", async () => {
  const toolErrors = [];
  const toolDone = [];
  const result = await partitionToolCallsForExecution({
    toolCalls: [{ id: "stale-read", name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx" }) }],
    workspace: workspaceRoot,
    callbacks: {
      getIsPlanApproved: () => false,
      getPreferredLanguage: () => "zh",
      onToolError: (...args) => toolErrors.push(args),
      onToolDone: (...args) => toolDone.push(args),
    },
    iteration: 6,
    workflowMode: "edit",
    runtimeIntent: "goal",
    planRuntimePhase: "idle",
    availableToolNames: new Set(["apply_patch", "replace_in_file", "write_file"]),
    toolCapabilityRegistry: new Map(),
    toolPermissionPolicy: {},
    recentPlanToolActivity: [],
    recentToolActivity: [],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "修复白屏",
    managedAgentMessages: [],
    failedToolCallCounts: new Map(),
    buildCurrentTaskTargetingProfile: () => ({}),
    approvedPlanActionOnlyRecoveryActive: false,
    allowApprovedPlanRecoveryFileRead: false,
    executeRecoveryState: {
      mode: "mutation_first",
      reason: "read_file_only_loop",
      expectedTarget: "src/App.tsx",
      attempts: 1,
      iterationCount: 1,
      consecutiveBlockedReadFileCount: 0,
      repeatedEditValidationAttempts: 0,
    },
    effectiveExecuteRecoveryFileRead: false,
    readOnlyResultCache: new Map(),
    readOnlyDuplicateSkipCounts: new Map(),
    fileReadStates: new Map(),
    browserValidationCache: new Map(),
    iterationContext: { eventThreadId: "thread", eventTurnId: "turn" },
    emitTurnEvent: () => {},
  });

  assert.equal(toolDone.length, 0, "unavailable calls must not be reported as successful deferrals");
  assert.equal(toolErrors.length, 1);
  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].isError, true);
  assert.equal(result.preExecutionResults[0].lifecycleState, "blocked");
  assert.equal(result.preExecutionResults[0].qualityGateReason, "execute_recovery_tool_unavailable");
  assert.doesNotMatch(result.preExecutionResults[0].content, /BATCH_DEFERRED/);
});

test("an actual patch mismatch opens one context-read phase before mutation recovery", () => {
  const tools = ["read_file", "grep_search", "apply_patch", "run_command"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const decision = resolveIterationToolSurface({
    callbacks: {
      getIsPlanApproved: () => false,
      getPlanTasks: () => [],
      getPlanExecutionEvidenceLedger: () => [],
      getMessages: () => [],
      getPlanStage: () => "idle",
    },
    iteration: 4,
    workflowMode: "edit",
    runtimeIntent: "goal",
    rawIterationAllTools: tools,
    executeRecoveryMode: "patch_recovery_read",
    executeRecoveryReason: "target_progress_patch_mismatch",
    executeRecoveryAttempts: 1,
    recoveryIterationCount: 1,
    maxRecoveryIterations: 6,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanLongReasoningNoActionCount: 0,
    recentToolActivity: Array.from({ length: 3 }, () => ({
      name: "read_file",
      status: "succeeded",
      target: "src/App.tsx",
      detail: "FILE_UNCHANGED_STUB",
    })),
    recentPlanToolActivity: [],
    planRuntimePhase: "idle",
    planDraftingRecoveryReadCount: 0,
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
  });

  assert.equal(decision.isExecuteRecoveryEligible, true);
  assert.deepEqual(decision.iterationAllTools.map((tool) => tool.function.name), ["read_file"]);
});

function createApprovedPlanToolSurfaceInput(overrides = {}) {
  const tools = [
    "list_directory",
    "grep_search",
    "read_file",
    "apply_patch",
    "replace_in_file",
    "write_file",
    "run_command",
    "execute_command",
    "send_pty_input",
    "read_pty_buffer",
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
    "browser_evaluate",
  ].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  return {
    callbacks: {
      getIsPlanApproved: () => true,
      getPlanTasks: () => [{
        id: "edit-main",
        text: "修改 src/main.rs 的后端逻辑",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "file", value: "src/main.rs" }],
      }],
      getPlanExecutionEvidenceLedger: () => [],
      getMessages: () => [],
      getPlanStage: () => "executing",
    },
    iteration: 8,
    workflowMode: "plan",
    runtimeIntent: "execute",
    rawIterationAllTools: tools,
    executeRecoveryMode: "normal",
    executeRecoveryReason: "",
    executeRecoveryAttempts: 0,
    recoveryIterationCount: 0,
    maxRecoveryIterations: 6,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanLongReasoningNoActionCount: 0,
    recentToolActivity: [],
    recentPlanToolActivity: [{
      name: "write_file",
      status: "succeeded",
      target: ".MAIN/plans/plan.md",
      detail: "plan materialized",
    }],
    planRuntimePhase: "executing",
    planDraftingRecoveryReadCount: 0,
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
    ...overrides,
  };
}

test("approved plan execution keeps targeted source reads after planning activity", () => {
  const decision = resolveIterationToolSurface(createApprovedPlanToolSurfaceInput());

  assert.equal(decision.approvedPlanSourceEditFirstActive, true);
  assert.equal(decision.allowApprovedPlanRecoveryFileRead, true);
  assert.deepEqual(decision.iterationAllTools.map((tool) => tool.function.name), [
    "read_file",
    "apply_patch",
    "replace_in_file",
    "write_file",
  ]);
});

test("source edits under hyphenated or nested src roots release the edit-first gate", () => {
  const input = createApprovedPlanToolSurfaceInput();
  input.callbacks = {
    ...input.callbacks,
    getPlanTasks: () => [{
      id: "edit-tauri-main",
      text: "修改 src-tauri/src/main.rs 的后端逻辑",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "file", value: "src-tauri/src/main.rs" }],
    }],
    getPlanExecutionEvidenceLedger: () => [{
      id: "source-write",
      kind: "file",
      value: "src-tauri/src/main.rs",
      target: "src-tauri/src/main.rs",
      sourceTool: "apply_patch",
      createdAt: 1,
    }],
  };

  const decision = resolveIterationToolSurface(input);

  assert.equal(decision.approvedPlanSourceEditFirstActive, false);
  assert.equal(decision.availableToolNames.has("run_command"), true);
  assert.equal(decision.availableToolNames.has("browser_evaluate"), true);
  assert.equal(decision.availableToolNames.has("get_pty_status"), true);
});

test("a pending long-running command keeps PTY lifecycle tools available behind the edit-first gate", () => {
  const input = createApprovedPlanToolSurfaceInput();
  input.callbacks = {
    ...input.callbacks,
    getPlanExecutionEvidenceLedger: () => [{
      id: "dev-server-dispatch",
      kind: "cmd",
      value: "npm run dev",
      target: "npm run dev",
      sourceTool: "execute_command",
      observationStatus: "pending",
      createdAt: 1,
    }],
  };

  const decision = resolveIterationToolSurface(input);

  assert.equal(decision.approvedPlanSourceEditFirstActive, true);
  for (const toolName of [
    "send_pty_input",
    "read_pty_buffer",
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
  ]) {
    assert.equal(decision.availableToolNames.has(toolName), true, toolName);
  }
  assert.equal(decision.availableToolNames.has("browser_evaluate"), false);
});

test("approved plan action-only recovery reopens read_file only for its unresolved patch target", () => {
  const actionOnly = resolveIterationToolSurface(createApprovedPlanToolSurfaceInput({
    approvedPlanActionOnlyRecoveryActive: true,
  }));
  assert.deepEqual(actionOnly.iterationAllTools.map((tool) => tool.function.name), [
    "apply_patch",
    "replace_in_file",
    "write_file",
    "run_command",
    "execute_command",
    "send_pty_input",
    "read_pty_buffer",
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
    "browser_evaluate",
  ]);

  const patchRecovery = resolveIterationToolSurface(createApprovedPlanToolSurfaceInput({
    approvedPlanActionOnlyRecoveryActive: true,
    recentPlanToolActivity: [{
      name: "replace_in_file",
      status: "failed",
      target: "src/main.rs",
      detail: "search_text mismatch",
    }],
  }));
  assert.equal(patchRecovery.iterationAllTools.some((tool) => tool.function.name === "read_file"), true);
  assert.equal(patchRecovery.iterationAllTools.some((tool) => tool.function.name === "grep_search"), false);
});

test("repeat-edit validation recovery exposes only validation tools and forbids more edits", () => {
  assert.equal(isExecuteRecoveryToolName("run_command", readOnlyTools, {
    mode: "validation_only",
  }), true);
  assert.equal(isExecuteRecoveryToolName("browser_evaluate", readOnlyTools, {
    mode: "validation_only",
  }), true);
  assert.equal(isExecuteRecoveryToolName("replace_in_file", readOnlyTools, {
    mode: "validation_only",
  }), false);
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "validation_only",
  }), false);
  assert.equal(describeExecuteRecoveryToolSurface("validation_only"), "validation_only");

  const prompt = buildExecuteValidationRecoveryPrompt({
    language: "zh",
    reason: "repeat_edit_target_without_validation",
    target: "src/components/Dashboard/CourseBarChart.tsx",
    editCount: 3,
    availableValidationTools: ["run_command", "browser_evaluate"],
  });
  assert.match(prompt, /连续修改同一目标/);
  assert.match(prompt, /必须只调用一个验证工具/);
  assert.match(prompt, /不要继续编辑文件/);
});

test("failed finite validation recovery exposes only run_command", () => {
  assert.equal(isExecuteRecoveryToolName("run_command", readOnlyTools, {
    mode: "finite_validation_only",
  }), true);
  for (const blocked of [
    "execute_command",
    "read_pty_since",
    "read_file",
    "replace_in_file",
    "browser_evaluate",
  ]) {
    assert.equal(isExecuteRecoveryToolName(blocked, readOnlyTools, {
      mode: "finite_validation_only",
    }), false, blocked);
  }
  assert.equal(
    describeExecuteRecoveryToolSurface("finite_validation_only"),
    "finite_validation_only",
  );
  const prompt = buildFailedFiniteValidationRecoveryPrompt({
    command: "node -e require('./src/example.js')",
    result: '{"exitCode":1,"stderr":"module not found"}',
  });
  assert.match(prompt, /intentionally limited to `run_command`/);
  assert.match(prompt, /do not reread an already-modified source file/i);
  assert.match(prompt, /exitCode 0/);
});

test("third consecutive edit to one target forces validation before another write", () => {
  const editCounts = new Map();
  const activations = [];
  const statuses = [];
  let recoveryAttempts = 0;
  const makeInput = () => ({
    callbacks: {
      getPreferredLanguage: () => "zh",
      getIsPlanApproved: () => true,
      onStatusChange: (status) => statuses.push(status),
      onNonActionableStop: () => assert.fail("third edit should recover before pausing"),
    },
    workflowMode: "plan",
    runtimeIntent: "execute",
    iteration: 3,
    results: [{
      toolCallId: `edit-${editCounts.get("src/main.rs") || 0}`,
      name: "apply_patch",
      target: "src/main.rs",
      content: "patch applied",
      isError: false,
    }],
    availableToolNames: new Set(["run_command", "browser_evaluate"]),
    recentToolActivity: [],
    successfulEditTargetsSinceVerification: editCounts,
    repeatedEditValidationRecoveryAttempts: recoveryAttempts,
    activateExecuteRecovery: (mode, reason, context) => activations.push({ mode, reason, context }),
    emitPlanExecutionProgress: () => {},
  });

  const first = handleRepeatedEditValidationRecovery(makeInput());
  recoveryAttempts = first.repeatedEditValidationRecoveryAttempts;
  assert.equal(first.status, "none");
  const second = handleRepeatedEditValidationRecovery(makeInput());
  recoveryAttempts = second.repeatedEditValidationRecoveryAttempts;
  assert.equal(second.status, "none");
  const third = handleRepeatedEditValidationRecovery(makeInput());

  assert.equal(third.status, "pending_prompt");
  assert.equal(activations.length, 1);
  assert.equal(activations[0].mode, "validation_only");
  assert.equal(activations[0].reason, "repeat_edit_target_without_validation");
  assert.equal(activations[0].context.editCount, 3);
  assert.deepEqual(statuses, ["running"]);
});

test("patch mismatch recovery opens one targeted read_file path", () => {
  const recent = [
    { name: "replace_in_file", status: "failed", target: "src/App.tsx", detail: "search_text not found" },
  ];

  assert.equal(isExecutePatchMismatchRecoveryActivity(recent[0]), true);
  assert.equal(
    isExecutePatchMismatchRecoveryActivity({
      name: "apply_patch",
      status: "failed",
      target: "src/App.tsx",
      detail: "Patch context was not found in src/App.tsx",
    }),
    true,
  );
  assert.equal(shouldAllowExecuteRecoveryFileRead(recent, "patch_recovery_read"), true);
  assert.equal(
    shouldAllowExecuteRecoveryFileRead([
      { name: "apply_patch", status: "failed", target: "src/App.tsx", detail: "Patch context was not found" },
    ], "patch_recovery_read"),
    true,
  );
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "patch_recovery_read",
    allowFileRead: true,
  }), true);
  assert.equal(isExecuteRecoveryToolName("list_directory", readOnlyTools, {
    mode: "patch_recovery_read",
    allowFileRead: true,
  }), false);

  assert.equal(
    shouldAllowExecuteRecoveryFileRead([
      ...recent,
      { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "READ_FILE_RESULT" },
    ], "patch_recovery_read"),
    true,
  );
  assert.equal(resolveExecutePatchRecoveryTarget(recent), "src/App.tsx");
  assert.equal(shouldBypassExecuteReadCacheForPatchRecovery({
    toolName: "read_file",
    allowFileRead: true,
    target: "./src/App.tsx",
    recentActivity: recent,
  }), true, "relative aliases should resolve to the patch target");
  assert.equal(shouldBypassExecuteReadCacheForPatchRecovery({
    toolName: "read_file",
    allowFileRead: true,
    target: "/tmp/workspace/src/App.tsx",
    recentActivity: recent,
  }), true, "absolute workspace aliases should resolve to the patch target");
  assert.equal(shouldBypassExecuteReadCacheForPatchRecovery({
    toolName: "read_file",
    allowFileRead: true,
    target: "src/index.html",
    recentActivity: recent,
  }), false, "a patch mismatch may bypass cache only for its own target");
  assert.equal(resolveExecutePatchRecoveryTarget([
    ...recent,
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "READ_FILE_RESULT" },
  ]), null, "the cache-bypass lease is consumed by one successful targeted read");
  assert.equal(resolveExecutePatchRecoveryTarget([
    ...recent,
    { name: "read_file", status: "failed", target: "src/App.tsx", detail: "temporary read error" },
  ]), "src/App.tsx", "a failed targeted read must not consume the patch recovery lease");
  assert.equal(resolveExecutePatchRecoveryTarget([
    ...recent,
    ...Array.from({ length: 8 }, (_, index) => ({
      name: "grep_search",
      status: "succeeded",
      target: `symbol-${index}`,
      detail: "one match",
    })),
  ]), "src/App.tsx", "unrelated activity must not expire an unresolved patch mismatch");
  assert.equal(shouldUseExecutePatchRecoveryReadLease({
    toolName: "read_file",
    allowFileRead: true,
    target: "src/App.tsx",
    recentActivity: recent,
    leaseClaimed: false,
  }), true);
  assert.equal(shouldUseExecutePatchRecoveryReadLease({
    toolName: "read_file",
    allowFileRead: true,
    target: "src/App.tsx",
    recentActivity: recent,
    leaseClaimed: true,
  }), false, "only one same-batch call may claim the targeted cache-bypass lease");

  const prompt = buildExecuteRecoveryPrompt({
    language: "zh",
    reason: "target_progress_patch_mismatch",
    mode: "patch_recovery_read",
    repeatedTargets: ["src/App.tsx"],
    recentActivity: recent,
  });
  assert.match(prompt, /上下文与当前文件不匹配/);
  assert.match(prompt, /不要继续重试基于旧上下文的 `apply_patch`/);
});

test("first mutation preflight mismatch immediately enters targeted patch recovery", () => {
  const replaceDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    executeRecoveryMode: "normal",
    executeRecoveryAttempts: 0,
    results: [{
      name: "replace_in_file",
      target: "src-tauri/src/main.rs",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED: search_text 在 src-tauri/src/main.rs 中不存在。",
      isError: true,
      lifecycleState: "blocked",
    }],
  });
  assert.deepEqual(replaceDecision, {
    mode: "patch_recovery_read",
    reason: "mutation_preflight_search_text_mismatch",
    target: "src-tauri/src/main.rs",
  });

  const patchDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    executeRecoveryMode: "normal",
    executeRecoveryAttempts: 0,
    results: [{
      name: "apply_patch",
      target: "src-tauri/src/main.rs",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED: apply_patch 无效或无法应用（Update File has no changes）。",
      isError: true,
      lifecycleState: "blocked",
    }],
  });
  assert.deepEqual(patchDecision, {
    mode: "patch_recovery_read",
    reason: "mutation_preflight_invalid_patch",
    target: "src-tauri/src/main.rs",
  });

  assert.equal(resolveDirectMutationPreflightRecovery({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    executeRecoveryMode: "patch_recovery_read",
    executeRecoveryAttempts: 1,
    results: [{
      name: "apply_patch",
      target: "src-tauri/src/main.rs",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED: invalid_patch",
      isError: true,
    }],
  }), null, "an active recovery lease must not be reinitialized by the same failure");
});

test("recovery batch selection serializes different model call shapes by phase", () => {
  const calls = [
    { id: "validate-first", name: "run_command", target: "npm test" },
    { id: "wrong-read", name: "read_file", target: "src/other.ts" },
    { id: "edit", name: "apply_patch", target: "src/App.tsx" },
    { id: "target-read", name: "read_file", target: "/tmp/workspace/src/App.tsx" },
  ];
  const recentActivity = [
    { name: "apply_patch", status: "failed", target: "./src/App.tsx", detail: "patch context mismatch" },
  ];

  const context = resolveExecuteRecoveryBatchDecision({
    mode: "patch_recovery_read",
    calls,
    recentActivity,
  });
  assert.equal(context.phase, "need_context");
  assert.equal(context.selectedCallId, "target-read", "path aliases must select the actual mismatch target");
  assert.deepEqual(context.deferredCallIds.sort(), ["edit", "validate-first", "wrong-read"]);

  const wrongTargetOnly = resolveExecuteRecoveryBatchDecision({
    mode: "patch_recovery_read",
    calls: [{ id: "wrong-read", name: "read_file", target: "src/other.ts" }],
    recentActivity,
  });
  assert.equal(
    wrongTargetOnly.selectedCallId,
    null,
    "a known patch target must not fall back to an unrelated read",
  );
  assert.deepEqual(wrongTargetOnly.deferredCallIds, ["wrong-read"]);

  const mutation = resolveExecuteRecoveryBatchDecision({ mode: "mutation_first", calls });
  assert.equal(mutation.phase, "need_mutation");
  assert.equal(mutation.selectedCallId, "edit", "validation order in model output cannot skip mutation");
  assert.equal(mutation.deferredCallIds.includes("validate-first"), true);

  const wrongMutationOnly = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [{ id: "wrong-edit", name: "replace_in_file", target: "src/other.ts" }],
    expectedTarget: "src/App.tsx",
  });
  assert.equal(
    wrongMutationOnly.selectedCallId,
    null,
    "an unrelated mutation must be deferred before it can write",
  );
  assert.deepEqual(wrongMutationOnly.deferredCallIds, ["wrong-edit"]);

  const unresolvedPatch = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [{ id: "unresolved-patch", name: "apply_patch", target: "workspace patch" }],
    expectedTarget: "src/App.tsx",
  });
  assert.equal(
    unresolvedPatch.selectedCallId,
    "unresolved-patch",
    "the patch parser should report an unresolved target instead of recovery silently deferring it",
  );

  const matchingMutation = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [
      { id: "wrong-edit", name: "write_file", target: "src/other.ts" },
      { id: "target-edit", name: "apply_patch", target: "/tmp/workspace/src/App.tsx" },
    ],
    expectedTarget: "./src/App.tsx",
  });
  assert.equal(matchingMutation.selectedCallId, "target-edit");
  assert.deepEqual(matchingMutation.deferredCallIds, ["wrong-edit"]);

  const actionOnlyWrongMutation = resolveExecuteRecoveryBatchDecision({
    mode: "action_only",
    calls: [{ id: "wrong-edit", name: "write_file", target: "src/other.ts" }],
    expectedTarget: "src/App.tsx",
  });
  assert.equal(actionOnlyWrongMutation.selectedCallId, null);
  assert.deepEqual(actionOnlyWrongMutation.deferredCallIds, ["wrong-edit"]);

  const validation = resolveExecuteRecoveryBatchDecision({
    mode: "validation_only",
    calls,
    expectedTarget: "src/App.tsx",
  });
  assert.equal(validation.phase, "need_validation");
  assert.equal(validation.selectedCallId, "validate-first");
  assert.equal(validation.deferredCallIds.includes("edit"), true);

  const toolCallPartitioningSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"),
    "utf8",
  );
  assert.match(toolCallPartitioningSource, /expectedTarget:\s*executeRecoveryState\.expectedTarget/);
  assert.match(toolCallPartitioningSource, /下一步必须读取该目标/);
  assert.match(toolCallPartitioningSource, /下一步必须修改该目标/);
  const toolCallExecutionPhaseSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallExecutionPhase.ts"),
    "utf8",
  );
  assert.match(toolCallExecutionPhaseSource, /partitionToolCallsForExecution\(\{[\s\S]*?executeRecoveryState,/);
});

test("read-only budget triggers execute recovery before max iterations", () => {
  const recent = Array.from({ length: 8 }, (_value, index) => ({
    name: "read_file",
    status: "succeeded",
    target: index < 4 ? "src/App.tsx" : "src/hooks/useCsvParser.ts",
    detail: index >= 4 ? "FILE_UNCHANGED_STUB: src/hooks/useCsvParser.ts" : "READ_FILE_RESULT",
  }));
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/hooks/useCsvParser.ts", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
  });

  assert.equal(decision.shouldRecover, true);
  assert.match(decision.reason, /read_only|cached/);
  assert.deepEqual(summarizeRepeatedExecuteTargets(recent), ["src/hooks/useCsvParser.ts", "src/App.tsx"]);

  const prompt = buildExecuteRecoveryPrompt({
    language: "zh",
    reason: decision.reason,
    mode: "patch_recovery_read",
    repeatedTargets: summarizeRepeatedExecuteTargets(recent),
    recentActivity: recent,
    allowFileRead: shouldAllowExecuteRecoveryFileRead(recent, "patch_recovery_read"),
  });
  assert.match(prompt, /可使用定向 `read_file`/);
  assert.match(prompt, /统一行动协议/);
  assert.match(prompt, /不要在同一批次发起多个猜测性读取/);
  assert.match(prompt, /apply_patch|write_file|replace_in_file/);
  assert.match(prompt, /小型 Codex-style patch 事务/);
  assert.match(prompt, /不要把源码或完整文件粘贴到聊天 Markdown/);
});

test("local cached-read loop recovers before no-progress pause boundary", () => {
  const recent = Array.from({ length: 8 }, (_value, index) => ({
    name: "read_file",
    status: "succeeded",
    target: "src-tauri/src/main.rs",
    detail: index === 0 ? "READ_FILE_RESULT" : "FILE_UNCHANGED_STUB: src-tauri/src/main.rs",
  }));
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src-tauri/src/main.rs", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 4,
    minReadOnlyActivities: 10,
    minCachedReadOnlyActivities: 8,
    maxNoProgressReadOnlyRepeats: 4,
  });

  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "read_only_no_progress");
  assert.deepEqual(summarizeRepeatedExecuteTargets(recent), ["src-tauri/src/main.rs"]);
});

test("chat read-only no-progress is eligible for final synthesis before max iterations", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "READ_FILE_RESULT" },
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "FILE_UNCHANGED_STUB: src/App.tsx" },
    { name: "grep_search", status: "succeeded", target: "onFileLoaded", detail: "5 matches" },
    { name: "read_file", status: "succeeded", target: "src/lib/router.ts", detail: "CACHED_FILE_REPLAY: src/lib/router.ts" },
    { name: "grep_search", status: "succeeded", target: "routeConfig", detail: "READ_ONLY_REPEAT_LIMIT: duplicate search" },
  ];
  const decision = resolveReadOnlyNoProgressTrigger({
    results: [{ name: "read_file", target: "src/App.tsx", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
    minReadOnlyActivities: 6,
    minCachedReadOnlyActivities: 3,
  });

  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "repeated_cached_read");
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "chat",
    runtimeIntent: "respond",
    toolCallCount: 0,
    recentReadOnlyActivityCount: 6,
    consecutiveNoToolCount: 1,
  }), true);

  const notice = buildExecuteNoProgressLoopPauseNotice({
    language: "zh",
    scope: "chat",
    repeats: 1,
    remainingTask: "只有只读探索，没有最终回答。",
    recentActivity: recent,
  });
  assert.match(notice, /对话已暂停/);
  assert.match(notice, /直接回答/);
});

test("chat read-only no-progress ignores batches after execution evidence", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/components/toolbar.js", detail: "READ_FILE_RESULT" },
    { name: "replace_in_file", status: "succeeded", target: "src/components/toolbar.js", detail: "updated successfully" },
    { name: "read_file", status: "succeeded", target: "src/components/toolbar.js", detail: "FILE_UNCHANGED_STUB: src/components/toolbar.js" },
  ];
  const decision = resolveReadOnlyNoProgressTrigger({
    results: [{ name: "read_file", target: "src/components/toolbar.js", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: true,
    noProgressBatchRepeatCount: 1,
    minCachedReadOnlyActivities: 1,
  });

  assert.equal(decision.shouldRecover, false);
});

test("chat final synthesis prompt disables tools only for recovery synthesis", () => {
  const prompt = buildChatFinalSynthesisPrompt({
    language: "zh",
    reason: "length_no_tool_chat",
    iteration: 7,
    repeatedTargets: ["src/lib/orchestrator.ts"],
    recentActivity: [
      { name: "read_file", status: "succeeded", target: "src/lib/orchestrator.ts", detail: "READ_FILE_RESULT" },
    ],
  });

  assert.match(prompt, /CHAT_FINAL_SYNTHESIS/);
  assert.match(prompt, /工具已关闭/);
  assert.match(prompt, /不要输出 `<tool_use>`/);
  assert.match(prompt, /src\/lib\/orchestrator\.ts/);
});

test("chat final synthesis trigger is scoped to respond recovery loops", () => {
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "chat",
    runtimeIntent: "respond",
    finishReason: "length",
    toolCallCount: 0,
  }), true);
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "chat",
    runtimeIntent: "respond",
    wasLanguageMismatchRecovery: true,
    languageMismatchAlreadyRetried: true,
    toolCallCount: 0,
  }), true);
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "chat",
    runtimeIntent: "respond",
    finishReason: "length",
    toolCallCount: 1,
  }), false);
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "edit",
    runtimeIntent: "execute",
    finishReason: "length",
    toolCallCount: 0,
  }), false);
});

test("agent loop iteration limits are mode-specific and configurable", () => {
  assert.equal(resolveAgentLoopMaxIterations({
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
  }), 25);

  assert.equal(resolveAgentLoopMaxIterations({
    workflowMode: "chat",
    runtimeIntent: "analyze",
    isPlanApproved: false,
    subagentDepth: 1,
    limits: { subagent: 6, default: 25 },
  }), 6);
  assert.equal(resolveAgentLoopMaxIterations({
    workflowMode: "chat",
    runtimeIntent: "analyze",
    isPlanApproved: false,
    subagentDepth: 1,
    limits: { subagent: 8, default: 25 },
  }), 8);
  assert.equal(resolveAgentLoopMaxIterations({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
  }), 50);
  assert.equal(resolveAgentLoopMaxIterations({
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
    limits: { chatRespond: 12 },
  }), 12);
});

test("same-loop plan approval receives a full execution phase budget", () => {
  const draft = resolveAgentLoopIterationBudget({
    workflowMode: "plan",
    runtimeIntent: "plan",
    isPlanApproved: false,
    currentIteration: 18,
    limits: { planDraft: 25, planExecution: 50 },
  });
  assert.deepEqual(draft, {
    phase: "plan_draft",
    phaseStartIteration: 0,
    phaseMaxIterations: 25,
    absoluteMaxIterations: 25,
  });

  const execution = resolveAgentLoopIterationBudget({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    currentIteration: 18,
    planExecutionStartIteration: null,
    limits: { planDraft: 25, planExecution: 50 },
  });
  assert.deepEqual(execution, {
    phase: "plan_execution",
    phaseStartIteration: 18,
    phaseMaxIterations: 50,
    absoluteMaxIterations: 68,
  });
});

test("max-steps final text prompt disables tools for chat final boundary", () => {
  assert.equal(shouldUseMaxStepsFinalTextOnly({
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
    iteration: 25,
    maxIterations: 25,
    alreadyPrompted: false,
  }), true);
  assert.equal(shouldUseMaxStepsFinalTextOnly({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    iteration: 50,
    maxIterations: 50,
    alreadyPrompted: false,
  }), false);

  const prompt = buildMaxStepsFinalTextPrompt({
    language: "en",
    iteration: 25,
    maxIterations: 25,
    repeatedTargets: ["src/App.tsx"],
  });
  assert.match(prompt, /MAX_STEPS_FINAL_TEXT/);
  assert.match(prompt, /Do not make any tool calls/);
  assert.match(prompt, /what remains unfinished/);
});

test("empty model response pause explains local-model empty completion instead of waiting for max iterations", () => {
  const notice = buildEmptyModelResponsePauseNotice({
    language: "zh",
    emptyResponses: 2,
    repeatedTargets: ["src/App.tsx"],
    localProfile: true,
  });
  assert.match(notice, /2 次空响应/);
  assert.match(notice, /本地模型/);
  assert.match(notice, /src\/App\.tsx/);
});

test("execute no-progress pause reports edit-mode recent tools instead of empty plan activity", () => {
  const recent = [
    { name: "grep_search", status: "succeeded", target: "rawOrders", detail: "8 matches" },
    { name: "read_file", status: "succeeded", target: "src/hooks/useCsvParser.ts", detail: "READ_FILE_RESULT" },
    { name: "read_file", status: "succeeded", target: "src/hooks/useCsvParser.ts", detail: "FILE_UNCHANGED_STUB: src/hooks/useCsvParser.ts" },
  ];
  const notice = buildExecuteNoProgressLoopPauseNotice({
    language: "zh",
    repeats: 3,
    remainingTask: "停止重复读取，转向写入或验证。",
    recentActivity: recent,
  });

  assert.match(notice, /src\/hooks\/useCsvParser\.ts/);
  assert.match(notice, /最近工具/);
  assert.doesNotMatch(notice, /最近工具：暂无/);
});

test("execute recovery context compaction keeps recent complete tool pairs without orphan tool messages", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "修复数据不显示和深色模式" },
  ];
  for (let index = 0; index < 70; index += 1) {
    const id = `call_${index}`;
    messages.push({
      role: "assistant",
      content: `读取第 ${index} 个文件`,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/file${index}.tsx` }) } }],
    });
    messages.push({
      role: "tool",
      tool_call_id: id,
      content: `[MAIN_TOOL_FEEDBACK_V1]{"status":"completed","tool":"read_file","target":"src/file${index}.tsx"}\nREAD_FILE_RESULT path: src/file${index}.tsx\n---CONTENT START---\n${"export const value = 1;\n".repeat(300)}---CONTENT END---`,
    });
  }
  messages.push({ role: "user", content: "EXECUTE_RECOVERY: 请复用上下文转向写入/验证。" });

  const compacted = compactContextForExecuteRecovery(messages, {
    maxMessages: 36,
    maxToolResultMessages: 12,
    maxToolChars: 12_000,
    maxToolCallGroups: 6,
    maxToolResultTokens: 320,
    now: 123,
  });

  const toolMessages = compacted.messages.filter((message) => message.role === "tool");
  const toolChars = toolMessages.reduce((sum, message) => sum + String(message.content || "").length, 0);
  assert.equal(compacted.messages.length <= 36, true);
  assert.equal(toolMessages.length <= 12, true);
  assert.equal(toolChars <= 12_000, true);
  assert.match(String(compacted.messages[1]?.content || ""), /ContextMemoryState/);
  assert.match(JSON.stringify(compacted.messages), /EXECUTE_RECOVERY/);

  for (const message of compacted.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    const ids = message.tool_calls.map((toolCall) => toolCall.id).filter(Boolean);
    for (const id of ids) {
      assert.equal(toolMessages.some((toolMessage) => toolMessage.tool_call_id === id), true);
    }
  }
});

test("orchestrator wires execute convergence and max-iteration recovery before idle completion", () => {
  const source = (
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/finalTextOnlyToolCallHandling.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/maxIterationBoundary.ts"), "utf8")
  );
  const streamInvocationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"), "utf8");
  const toolCallPlanningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"), "utf8");
  const contextManagementSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/contextManagement.ts"), "utf8");
  const executeRecoveryRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"), "utf8");
  const loopControlRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopControlRuntime.ts"), "utf8");
  const loopRuntimeActionsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRuntimeActions.ts"), "utf8");

  assert.match(source, /resolveIterationToolSurface\(\{/);
  assert.match(toolCallPlanningSource, /execute_recovery_tool_scope_applied/);
  assert.match(toolCallPlanningSource, /const effectiveExecuteRecoveryFileRead =[\s\S]*executeRecoveryMode === "patch_recovery_read" \|\| allowExecuteRecoveryFileRead/);
  assert.match(toolCallPlanningSource, /adaptiveFileReadAllowed: allowExecuteRecoveryFileRead/);
  assert.match(source, /prepareManagedMessagesForIteration\(\{/);
  assert.match(contextManagementSource, /execute_recovery_context_compacted/);
  assert.match(contextManagementSource, /isExecuteRecoveryEligible && contextForceForManagement\?\.shouldForce/);
  assert.match(contextManagementSource, /execute_recovery_context_skipped/);
  assert.match(source, /activateExecuteRecovery\("mutation_first", "execute_convergence_prompt"/);
  assert.match(streamInvocationSource, /const recoveryToolChoice =[\s\S]*toolChoice: recoveryToolChoice/);
  assert.match(executeRecoveryRuntimeSource, /attempts: state\.attempts \+ 1/);
  assert.match(executeRecoveryRuntimeSource, /MAX_EXECUTE_RECOVERY_ITERATIONS = 6/);
  assert.doesNotMatch(source, /executeRecoveryReason !== reason/);
  assert.match(loopControlRuntimeSource, /resolveAgentLoopIterationBudget/);
  assert.match(streamInvocationSource, /buildMaxStepsFinalTextPrompt/);
  assert.match(source, /recoveryReason: "max_iterations_boundary"/);
  assert.match(source, /normalizeNoProgressResultContent/);
  assert.match(source, /resolveReadOnlyNoProgressTrigger/);
  assert.match(streamInvocationSource, /buildChatFinalSynthesisPrompt/);
  assert.match(loopRuntimeActionsSource, /chat_final_synthesis_activated/);
  assert.match(source, /chat_readonly_no_progress_final_synthesis/);
  assert.match(source, /chat_final_synthesis_tool_calls_ignored/);
  assert.match(source, /looksLikeRepairExecutionRequest/);
  assert.match(source, /chat_repair_readonly_no_progress_paused/);
  assert.match(source, /unresolvedRepairRequest/);

  const callbackIndex = source.indexOf("const handling = await callbacks.onExecuteMaxIterationsCheckpoint?.(checkpoint);");
  const idleIndex = source.indexOf("callbacks.onStatusChange(\"idle\");", callbackIndex);
  assert.equal(callbackIndex > 0, true);
  assert.equal(idleIndex > callbackIndex, true);
});

test("orchestrator evidence reconcile logs failed tool summaries", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultPostProcessing.ts"), "utf8");

  assert.match(source, /failedEvidenceResults/);
  assert.match(source, /firstFailureReason/);
  assert.match(source, /firstFailureLifecycleState/);
  assert.match(source, /firstFailureTool/);
  assert.match(source, /firstFailureTarget/);
});

test("execute recovery does not trigger on a single cached read when minCachedReadOnlyActivities is set", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "FILE_UNCHANGED_STUB: src/App.tsx" }
  ];
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/App.tsx", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
    minCachedReadOnlyActivities: 3,
  });

  assert.equal(decision.shouldRecover, false);
});

test("execute recovery does not count fresh file windows toward the cached-read threshold", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/main.js", detail: "READ_FILE_RESULT lines 1-120" },
    { name: "read_file", status: "succeeded", target: "src/main.js", detail: "READ_FILE_RESULT lines 121-240" },
    { name: "read_file", status: "succeeded", target: "src/main.js", detail: "READ_FILE_RESULT lines 241-360" },
    { name: "read_file", status: "succeeded", target: "src/main.js", detail: "FILE_UNCHANGED_STUB: lines 241-360 already cached" },
  ];
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/main.js", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 0,
    minReadOnlyActivities: 99,
    minCachedReadOnlyActivities: 3,
    minRepeatedReadOnlyTargetScore: 99,
  });

  assert.equal(decision.readOnlyActivityCount, 4);
  assert.equal(decision.cachedReadOnlyActivityCount, 1);
  assert.equal(decision.shouldRecover, false);
});

test("execute recovery detects cached reads across changing batch signatures", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "FILE_UNCHANGED_STUB: src/App.tsx" },
    { name: "read_file", status: "succeeded", target: "src/lib/router.ts", detail: "READ_ONLY_REPEAT_LIMIT: duplicate read" },
    { name: "read_file", status: "succeeded", target: "src/store/useAppStore.ts", detail: "CACHED_FILE_REPLAY: unchanged file replay" },
  ];
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/store/useAppStore.ts", content: "CACHED_FILE_REPLAY: unchanged file replay", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
    minReadOnlyActivities: 99,
    minCachedReadOnlyActivities: 3,
    minRepeatedReadOnlyTargetScore: 99,
  });

  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "repeated_cached_read");
  assert.equal(decision.cachedReadOnlyActivityCount, 3);
});

test("execute recovery treats covered-window reads on the same target as no progress", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", detail: "READ_FILE_RESULT lines 1-120" },
    { name: "read_file", status: "succeeded", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", detail: "READ_FILE_WINDOW_NARROWED: overlapping unchanged lines already in context" },
    { name: "read_file", status: "succeeded", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", detail: "FILE_UNCHANGED_STUB: requested window is already covered by unchanged earlier read_file results" },
    { name: "read_file", status: "succeeded", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", detail: "READ_FILE_RESULT lines 300-340" },
  ];
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", content: "READ_FILE_RESULT lines 300-340", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
    minReadOnlyActivities: 99,
    minCachedReadOnlyActivities: 99,
    minRepeatedReadOnlyTargetScore: 6,
  });

  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "target_repeated_read_only");
  assert.equal(decision.repeatedReadOnlyTargetScore >= 6, true);
});

test("targeting search recovery opens read_file path to see context", () => {
  const recent = [
    { name: "grep_search", status: "succeeded", target: "Order", detail: "Order" },
  ];
  assert.equal(shouldAllowExecuteRecoveryFileRead(recent, "normal"), false);
  assert.equal(shouldAllowExecuteRecoveryFileRead(recent, "patch_recovery_read"), true);
});

test("segmented reads of one file never hide read_file from a new recovery target", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/main.js", detail: "READ_FILE_RESULT lines 1-120" },
    { name: "read_file", status: "succeeded", target: "src/main.js", detail: "READ_FILE_RESULT lines 121-240" },
    { name: "read_file", status: "succeeded", target: "src/main.js", detail: "READ_FILE_RESULT lines 241-360" },
    { name: "read_file", status: "succeeded", target: "src/main.js", detail: "FILE_UNCHANGED_STUB: requested range already cached" },
  ];

  assert.equal(shouldAllowExecuteRecoveryFileRead(recent, "normal"), false);
  assert.equal(shouldAllowExecuteRecoveryFileRead(recent, "patch_recovery_read"), true);

  const toolCallPartitioningSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"),
    "utf8",
  );
  assert.match(toolCallPartitioningSource, /shouldUseExecutePatchRecoveryReadLease/);
  assert.match(toolCallPartitioningSource, /executePatchRecoveryReadLeaseClaimed/);
  assert.doesNotMatch(
    toolCallPartitioningSource,
    /tc\.name === "read_file" &&\s*effectiveExecuteRecoveryFileRead\)/,
    "ordinary recovery reads must not bypass path + argument cache signatures",
  );
});
