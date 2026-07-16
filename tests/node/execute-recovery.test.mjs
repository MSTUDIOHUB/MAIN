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
  globalThis.mockIpcInvoke = globalThis.mockIpcInvoke || (async () => ({}));
  const runtimeRequire = (specifier) => {
    if (specifier === "@tauri-apps/api/core") {
      return {
        invoke: async (cmd, args) => globalThis.mockIpcInvoke(cmd, args),
      };
    }
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
  classifyFailedFiniteValidationOutcome,
  compactStructuredCommandResult,
  buildExecuteRecoveryPrompt,
  buildExecuteValidationRecoveryPrompt,
  buildExecutePatchMismatchFingerprint,
  buildPatchRecoveryReadNoProgressFingerprint,
  describeExecuteRecoveryToolSurface,
  failedFiniteValidationMatchesPendingPlanEvidence,
  hasPendingPlanCommandEvidence,
  isExecutePatchMismatchRecoveryActivity,
  isExecuteRecoveryToolName,
  isReadOnlyNoProgressDetail,
  patchRecoveryLeaseIdentityMatches,
  readEvidenceSatisfiesRecoveryLease,
  resolveExecuteRecoveryActionContract,
  resolveExecuteRecoveryBatchDecision,
  resolveExecuteReadOnlyRecoveryTrigger,
  resolveExecutePatchRecoveryTarget,
  resolveFailedFiniteValidationRecoveryPolicy,
  resolveReadOnlyNoProgressTrigger,
  shouldAllowExecuteRecoveryFileRead,
  shouldEnterFailedFiniteValidationRecovery,
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
  findDelegatedObservationRequiringParentReread,
  partitionToolCallsForExecution,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"));
const {
  shouldAdvanceWorkspaceObservationEpoch,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolExecutionRound.ts"));

const {
  buildFileReadObservationIdentity,
  buildFileReadSignature,
  extractStructuredChangedPaths,
  getReadFileCoverageForPath,
  invalidateWorkspaceReadCachesAfterMutation,
  resolveReadFileEligibilityDecision,
  selectFileReadStateForRecoveryContext,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/fileReadCache.ts"));

const {
  buildExecuteRecoverySourceContextMessage,
  resolveRecoverySourceContextFreshness,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/contextManagement.ts"));

const subagents = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/subagents.ts"));

const {
  approvedPlanNeedsSourceEditBeforeValidation,
  buildReadOnlyCacheSignature,
  getToolTarget,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"));

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

const partitionPermissionPolicy = {
  autoExecuteRiskLevels: ["read_only"],
  approvalRequiredRiskLevels: ["workspace_write", "shell", "local_file_read", "external_read", "external_write", "browser_control", "destructive"],
  disabledRiskLevels: [],
};

const partitionToolCapabilityRegistry = {
  tools: {
    read_file: {
      key: "read_file",
      name: "read_file",
      source: "built_in",
      category: "file",
      risk: "read_only",
      enabled: true,
      autoExecutable: true,
    },
  },
  policy: partitionPermissionPolicy,
};

function createPermissiveTargetingProfile() {
  return {
    facets: [],
    explicitPaths: ["src/App.tsx"],
    symbols: [],
    tabularPaths: [],
    mentionedFilePaths: [],
    attachedFilePaths: [],
    imageParts: 0,
    hasUserProvidedContext: false,
    hasOnlyVisualContext: false,
    rootDirectoryAlreadyListed: false,
    designProtocolPaths: [],
    requiresDesignProtocol: false,
    designProtocolSatisfied: true,
    userStyleConfirmed: true,
    tabularAnalysisSatisfied: true,
    rootSkeletonAlreadyRead: false,
    allowRootSkeleton: true,
    preferredReadTools: ["read_file"],
    reasons: [],
  };
}

function createReadFilePartitionInput(overrides = {}) {
  return {
    toolCalls: [{
      id: "read-window",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/App.tsx", start_line: 1, max_lines: 100 }),
    }],
    workspace: workspaceRoot,
    callbacks: {
      getApprovedLocalFileReadPaths: () => [],
      getAutoApproveToolScopes: () => [],
      getIsPlanApproved: () => false,
      getPlanExecutionEvidenceLedger: () => [],
      getPlanStage: () => "requirements",
      getPlanTasks: () => [],
      getPreferredLanguage: () => "en",
      getSessionKey: () => "read-cache-test",
      getSubagentScope: () => null,
      onDebugEvent: () => {},
      onHarnessRunUpdate: () => {},
      onToolDone: () => {},
      onToolError: () => {},
      onToolExecuting: () => {},
    },
    iteration: 2,
    workflowMode: "edit",
    runtimeIntent: "execute",
    planRuntimePhase: "idle",
    availableToolNames: new Set(["read_file"]),
    toolCapabilityRegistry: partitionToolCapabilityRegistry,
    toolPermissionPolicy: partitionPermissionPolicy,
    recentPlanToolActivity: [],
    recentToolActivity: [],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Inspect src/App.tsx",
    managedAgentMessages: [],
    failedToolCallCounts: new Map(),
    buildCurrentTaskTargetingProfile: createPermissiveTargetingProfile,
    approvedPlanActionOnlyRecoveryActive: false,
    allowApprovedPlanRecoveryFileRead: false,
    executeRecoveryState: {
      mode: "normal",
      reason: "",
      expectedTarget: null,
      attempts: 0,
      iterationCount: 0,
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
    ...overrides,
  };
}

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
    recentToolActivity: [{
      name: "apply_patch",
      target: "src/App.tsx",
      status: "succeeded",
      detail: "changed App component",
    }],
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

test("successful MCP source edits count as durable max-iteration progress", async () => {
  let checkpoint;
  const stops = [];
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => 0,
      getPlanExecutionEvidenceLedger: () => [],
      onExecuteMaxIterationsCheckpoint: (value) => {
        checkpoint = value;
        return {
          status: "auto_resume_scheduled",
          checkpoint: { ...value, autoResumeCount: 1 },
        };
      },
      onNonActionableStop: (...args) => stops.push(args),
      onStatusChange: () => {},
    },
    workflowMode: "edit",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: [],
    recentToolActivity: [{
      name: "script_apply_edits",
      target: "Assets/Scripts/PlayerController.cs",
      status: "succeeded",
      detail: "applied one source edit",
    }],
    lastAssistantTextForCheckpoint: "still working",
    sawExecuteOperationEvidence: true,
    executeRecoveryMode: "normal",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(checkpoint?.autoResumeEligible, true);
  assert.equal(stops.length, 0);
});

test("an unrelated successful shell inspection is not durable max-iteration progress", async () => {
  let checkpoint;
  const stops = [];
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => 0,
      getPlanExecutionEvidenceLedger: () => [],
      onExecuteMaxIterationsCheckpoint: (value) => {
        checkpoint = value;
        return {
          status: "auto_resume_scheduled",
          checkpoint: { ...value, autoResumeCount: 1 },
        };
      },
      onNonActionableStop: (...args) => stops.push(args),
      onStatusChange: () => {},
    },
    workflowMode: "edit",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: [],
    recentToolActivity: [{
      name: "run_command",
      target: "pwd",
      status: "succeeded",
      detail: "exitCode=0",
    }],
    lastAssistantTextForCheckpoint: "checking directory",
    sawExecuteOperationEvidence: true,
    executeRecoveryMode: "normal",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(checkpoint?.autoResumeEligible, false);
  assert.equal(stops.length, 1);
});

test("a content-level browser readiness failure is not durable max-iteration progress", async () => {
  let checkpoint;
  const stops = [];
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => 0,
      getPlanExecutionEvidenceLedger: () => [],
      onExecuteMaxIterationsCheckpoint: (value) => {
        checkpoint = value;
        return {
          status: "auto_resume_scheduled",
          checkpoint: { ...value, autoResumeCount: 1 },
        };
      },
      onNonActionableStop: (...args) => stops.push(args),
      onStatusChange: () => {},
    },
    workflowMode: "edit",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: [],
    recentToolActivity: [{
      name: "browser_evaluate",
      target: "http://localhost:1420",
      status: "succeeded",
      detail: "DEV_SERVER_NOT_READY: navigation timed out",
    }],
    lastAssistantTextForCheckpoint: "browser is not ready",
    sawExecuteOperationEvidence: true,
    executeRecoveryMode: "normal",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(checkpoint?.autoResumeEligible, false);
  assert.equal(stops.length, 1);
});

test("approved plan max-iteration boundary refuses auto-resume after read-only thrashing", async () => {
  const stops = [];
  const pausedRuns = [];
  let observedCheckpoint;
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => true,
      getPlanAutoResumeCount: () => 0,
      getPlanTasks: () => [{
        id: "edit-main",
        text: "Modify src/main.js initialization error handling",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "file", value: "src/main.js" }],
      }],
      getPlanExecutionEvidenceLedger: () => [],
      onPlanMaxIterationsCheckpoint: (checkpoint) => {
        observedCheckpoint = checkpoint;
        return {
          status: "auto_resume_scheduled",
          checkpoint: { ...checkpoint, autoResumeCount: 1 },
        };
      },
      onNonActionableStop: (...args) => stops.push(args),
      onStatusChange: () => {},
    },
    workflowMode: "plan",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: Array.from({ length: 8 }, () => ({
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "CACHED_FILE_REPLAY: src/main.js",
    })),
    recentToolActivity: [],
    lastAssistantTextForCheckpoint: "reading another window",
    sawExecuteOperationEvidence: false,
    executeRecoveryMode: "normal",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: (reason, message) => pausedRuns.push({ reason, message }),
  });

  assert.equal(observedCheckpoint?.autoResumeEligible, false);
  assert.equal(pausedRuns[0]?.reason, "max_iterations_boundary");
  assert.equal(stops.length, 1);
  assert.match(pausedRuns[0]?.message || "", /no trusted write, command, or validation progress/i);
});

test("pending PTY polling cannot make a max-iteration checkpoint auto-resumable", async () => {
  const stops = [];
  let checkpoint;
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => 0,
      onExecuteMaxIterationsCheckpoint: (value) => {
        checkpoint = value;
        return {
          status: "auto_resume_scheduled",
          checkpoint: { ...value, autoResumeCount: 1 },
        };
      },
      onNonActionableStop: (...args) => stops.push(args),
      onStatusChange: () => {},
    },
    workflowMode: "edit",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: [],
    recentToolActivity: [{
      name: "get_pty_status",
      target: "terminal status",
      status: "succeeded",
      detail: "status=pending output empty",
    }],
    lastAssistantTextForCheckpoint: "waiting for terminal",
    sawExecuteOperationEvidence: true,
    executeRecoveryMode: "normal",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(checkpoint?.autoResumeEligible, false);
  assert.equal(stops.length, 1);
});

test("a recent ready PTY observation is durable max-iteration progress", async () => {
  let checkpoint;
  const stops = [];
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => 0,
      getPlanExecutionEvidenceLedger: () => [{
        id: "ready-observation",
        kind: "dev_server_url",
        value: "http://127.0.0.1:1420",
        target: "terminal status",
        sourceTool: "get_pty_status",
        observationStatus: "ready",
        createdAt: 2,
      }],
      onExecuteMaxIterationsCheckpoint: (value) => {
        checkpoint = value;
        return {
          status: "auto_resume_scheduled",
          checkpoint: { ...value, autoResumeCount: 1 },
        };
      },
      onNonActionableStop: (...args) => stops.push(args),
      onStatusChange: () => {},
    },
    workflowMode: "edit",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: [],
    recentToolActivity: [{
      name: "get_pty_status",
      target: "terminal status",
      status: "succeeded",
      detail: "status=ready url=http://127.0.0.1:1420",
    }],
    lastAssistantTextForCheckpoint: "server is ready",
    sawExecuteOperationEvidence: true,
    executeRecoveryMode: "normal",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(checkpoint?.autoResumeEligible, true);
  assert.equal(stops.length, 0);
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

test("execute recovery mutation phase keeps a scoped read capability but removes broad exploration", () => {
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
    "delete_workspace_path",
    "script_apply_edits",
    "apply_text_edits",
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
    "read_file",
    "apply_patch",
    "replace_in_file",
    "write_file",
    "delete_workspace_path",
    "script_apply_edits",
    "apply_text_edits",
  ]);
  assert.equal(
    getToolTarget("script_apply_edits", { path: "Assets/Scripts", name: "Foo" }),
    "Assets/Scripts/Foo.cs",
  );
  const mcpDecision = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [{
      id: "mcp-edit",
      name: "script_apply_edits",
      target: getToolTarget("script_apply_edits", { path: "Assets/Scripts", name: "Foo" }),
    }],
    expectedTarget: "Assets/Scripts/Foo.cs",
  });
  assert.equal(mcpDecision.selectedCallId, "mcp-edit");
  assert.equal(describeExecuteRecoveryToolSurface("mutation_first"), "mutation_with_targeted_read");
  assert.equal(describeExecuteRecoveryToolSurface("mutation_first", true), "mutation_with_targeted_read");
  assert.equal(describeExecuteRecoveryToolSurface("action_plus_targeting", true), "mutation_with_targeting_and_targeted_read");
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "mutation_first",
    allowFileRead: true,
  }), true);
  assert.equal(isExecuteRecoveryToolName("grep_search", readOnlyTools, {
    mode: "mutation_first",
    allowFileRead: true,
  }), false);
});

test("one recovery contract atomically advances long-running validation from PTY observation to browser", () => {
  const postMutation = resolveExecuteRecoveryActionContract("validation_only", {
    readLease: {
      purpose: "post_mutation_verify",
      target: "src/App.tsx",
      state: "available",
    },
    devServerStatus: "ready",
    devServerNextCapability: "browser",
  });
  assert.equal(postMutation.phase, "post_mutation_check");
  assert.equal(postMutation.nextRequiredCapability, "targeted_read");
  assert.equal(postMutation.surfaceDescription, "post_mutation_target_read");
  assert.deepEqual([...postMutation.allowedToolNames], ["read_file"]);

  const pending = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    devServerStatus: "running",
    devServerNextCapability: "observe_pty",
    ptyGeneration: 4,
    ptyOutputSequence: 12,
  });
  assert.equal(pending.phase, "validation");
  assert.equal(pending.nextRequiredCapability, "observe_pty");
  assert.equal(pending.surfaceDescription, "pty_observation_only");
  assert.equal(pending.ptyGeneration, 4);
  assert.equal(pending.allowedToolNames.has("get_pty_status"), true);
  assert.equal(pending.allowedToolNames.has("read_pty_tail"), true);
  assert.equal(pending.allowedToolNames.has("send_pty_input"), true);
  assert.equal(pending.allowedToolNames.has("browser_evaluate"), false);
  assert.equal(pending.allowedToolNames.has("read_file"), false);
  const pendingBatch = resolveExecuteRecoveryBatchDecision({
    mode: "action_plus_targeting",
    contract: pending,
    calls: [
      { id: "browser-too-early", name: "browser_evaluate", target: "http://localhost:1420/" },
      { id: "observe", name: "get_pty_status", target: "terminal status" },
    ],
  });
  assert.equal(pendingBatch.selectedCallId, "observe");

  const interactiveBatch = resolveExecuteRecoveryBatchDecision({
    mode: "action_plus_targeting",
    contract: pending,
    calls: [
      { id: "answer-prompt", name: "send_pty_input", target: "y" },
      { id: "tail-after-input", name: "read_pty_tail", target: "terminal tail" },
    ],
  });
  assert.equal(interactiveBatch.selectedCallId, "answer-prompt");

  const ready = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    devServerStatus: "ready",
    devServerNextCapability: "browser",
    devServerUrl: "http://localhost:1420/",
    ptyGeneration: 4,
    ptyOutputSequence: 16,
  });
  assert.equal(ready.phase, "validation");
  assert.equal(ready.nextRequiredCapability, "browser_validation");
  assert.equal(ready.surfaceDescription, "browser_validation_only");
  assert.equal(ready.devServerUrl, "http://localhost:1420/");
  assert.equal(ready.allowedToolNames.has("browser_evaluate"), true);
  assert.equal(ready.allowedToolNames.has("get_pty_status"), false);
  const readyBatch = resolveExecuteRecoveryBatchDecision({
    mode: "action_plus_targeting",
    contract: ready,
    calls: [
      { id: "observe-again", name: "get_pty_status", target: "terminal status" },
      { id: "browser", name: "browser_evaluate", target: "http://localhost:1420/" },
    ],
  });
  assert.equal(readyBatch.selectedCallId, "browser");

  const failed = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    expectedTarget: "src/App.tsx",
    devServerStatus: "failed",
    devServerNextCapability: "launch",
  });
  assert.equal(failed.phase, "reconcile");
  assert.equal(failed.nextRequiredCapability, "recover_process");
  assert.equal(failed.surfaceDescription, "dev_server_failure_recovery");
  assert.equal(failed.allowTargetedFileRead, true);
  for (const name of [
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
    "read_file",
    "apply_patch",
    "run_command",
    "execute_command",
  ]) {
    assert.equal(failed.allowedToolNames.has(name), true, `${name} should remain available after failure`);
  }
  assert.equal(failed.allowedToolNames.has("send_pty_input"), false);
  const stopped = resolveExecuteRecoveryActionContract("validation_only", {
    expectedTarget: "src/App.tsx",
    devServerStatus: "stopped",
    devServerNextCapability: "launch",
  });
  assert.equal(stopped.nextRequiredCapability, "recover_process");
  assert.equal(stopped.allowedToolNames.has("read_pty_tail"), true);
  assert.equal(stopped.allowedToolNames.has("run_command"), true);
  assert.equal(stopped.allowedToolNames.has("execute_command"), true);
  const failedBatch = resolveExecuteRecoveryBatchDecision({
    mode: "action_plus_targeting",
    expectedTarget: "src/App.tsx",
    contract: failed,
    calls: [
      { id: "restart-too-soon", name: "execute_command", target: "npm run dev" },
      { id: "read-error", name: "read_pty_tail", target: "terminal tail" },
      { id: "repair", name: "apply_patch", target: "src/App.tsx" },
    ],
  });
  assert.equal(failedBatch.selectedCallId, "read-error");

  const portConflict = resolveExecuteRecoveryActionContract("validation_only", {
    devServerStatus: "failed",
    devServerNextCapability: "reconcile",
  });
  assert.equal(portConflict.nextRequiredCapability, "reconcile_server");
  assert.equal(portConflict.allowedToolNames.has("read_pty_tail"), true);
  assert.equal(portConflict.allowedToolNames.has("run_command"), true);
  assert.equal(portConflict.allowedToolNames.has("execute_command"), false);
});

test("approved Plan source-edit gate is task-targeted and accepts matching MCP evidence", () => {
  const tasks = [{
    id: "unity-edit",
    text: "Modify Assets/Scripts/Foo.cs, then run focused tests",
    status: "pending",
    executionKind: "mutation",
    evidence: [
      { kind: "file", value: "Assets/Scripts/Foo.cs" },
      { kind: "cmd", value: "focused validation command" },
    ],
  }];
  const unrelatedWrite = [{
    id: "other-write",
    kind: "file",
    value: "Assets/Scripts/Other.cs",
    target: "Assets/Scripts/Other.cs",
    sourceTool: "write_file",
    createdAt: 1,
  }];
  const matchingMcpWrite = [{
    id: "foo-write",
    kind: "file",
    value: "Assets/Scripts/Foo.cs",
    target: "Assets/Scripts/Foo.cs",
    sourceTool: "script_apply_edits",
    createdAt: 2,
  }];

  assert.equal(approvedPlanNeedsSourceEditBeforeValidation(tasks, []), true);
  assert.equal(approvedPlanNeedsSourceEditBeforeValidation(tasks, unrelatedWrite), true);
  assert.equal(approvedPlanNeedsSourceEditBeforeValidation(tasks, matchingMcpWrite), false);
});

test("a repeated read-only loop enters mutation-first instead of patch-context reread", () => {
  const activations = [];
  const result = handleNoProgressRecovery({
    callbacks: {
      getIsPlanApproved: () => false,
      getPlanExecutionEvidenceLedger: () => [],
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
  assert.match(result.pendingExecuteRecoveryPrompt, /mutation_with_targeted_read/);
  assert.match(result.pendingExecuteRecoveryPrompt, /targeted `read_file` is available/i);
});

test("different cached file windows do not trip the global read-only streak", () => {
  const activations = [];
  let tracking = {
    lastNoProgressBatchSignature: "",
    noProgressBatchRepeatCount: 0,
    consecutiveReadFileOnlyCacheHits: 0,
    lastReadFileOnlyObservationSignature: "",
  };

  for (const key of ["range-a", "range-b", "range-c"]) {
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
        toolCallId: key,
        name: "read_file",
        target: "src/App.tsx",
        content: `CACHED_FILE_REPLAY: ${key}`,
        isError: false,
        readFileObservation: {
          key,
          path: "src/App.tsx",
          requestSignature: `read_file::src/App.tsx::${key}`,
          versionToken: "v1",
          source: "replay",
        },
      }],
      recentToolActivity: [],
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
      tracking,
      activateExecuteRecovery: (mode, reason, context) => activations.push({ mode, reason, context }),
      activateChatFinalSynthesis: () => {},
      emitTaskOrchestratorPhase: () => {},
    });
    tracking = result.tracking;
  }

  assert.equal(activations.length, 0);
  assert.equal(tracking.consecutiveReadFileOnlyCacheHits, 1);
  assert.equal(tracking.lastReadFileOnlyObservationSignature, "range-c");
});

test("a recovery-surface mismatch is internal scope feedback and cannot poison failure counts", async () => {
  const toolErrors = [];
  const toolDone = [];
  const result = await partitionToolCallsForExecution({
    toolCalls: [{ id: "stale-read", name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx" }) }],
    workspace: workspaceRoot,
    callbacks: {
      getIsPlanApproved: () => false,
      getPlanExecutionEvidenceLedger: () => [],
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

  assert.equal(toolDone.length, 1);
  assert.equal(toolErrors.length, 0);
  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].isError, false);
  assert.equal(result.preExecutionResults[0].internalFeedback, true);
  assert.equal(result.preExecutionResults[0].lifecycleState, "completed");
  assert.equal(result.preExecutionResults[0].qualityGateReason, "execute_recovery_scope_deferred");
  assert.match(result.preExecutionResults[0].content, /READ_SCOPE_DEFERRED/);
  assert.equal(result.toolFailureSignatures.has("stale-read"), false);
});

test("read eligibility is decided from scope, exact version, window residency, and context epoch", () => {
  const base = {
    scopeMatches: true,
    bypassCacheForLease: false,
    hasCachedWindow: true,
    observedVersion: "120:2",
    currentVersion: "120:2",
    contentInContext: true,
    contextEpoch: 3,
    replayedContextEpoch: 2,
  };
  assert.equal(resolveReadFileEligibilityDecision(base).kind, "unchanged_stub");
  assert.equal(resolveReadFileEligibilityDecision({
    ...base,
    contentInContext: false,
  }).kind, "context_replay");
  assert.equal(resolveReadFileEligibilityDecision({
    ...base,
    contentInContext: false,
    replayedContextEpoch: 3,
  }).kind, "unchanged_stub");
  assert.equal(resolveReadFileEligibilityDecision({
    ...base,
    currentVersion: "121:4",
  }).kind, "fresh_read");
  assert.equal(resolveReadFileEligibilityDecision({
    ...base,
    hasCachedWindow: false,
  }).reason, "missing_window");
  assert.equal(resolveReadFileEligibilityDecision({
    ...base,
    bypassCacheForLease: true,
  }).reason, "recovery_read_lease");
  assert.equal(resolveReadFileEligibilityDecision({
    ...base,
    scopeMatches: false,
  }).kind, "scope_deferred");
});

test("read_file cache is range-and-version aware and never falls back to stale generic cache", async () => {
  const args = { path: "src/App.tsx", start_line: 1, max_lines: 100 };
  const modelContent = [
    "READ_FILE_RESULT",
    "path: src/App.tsx",
    "truncated: true",
    "totalLines: 300",
    "totalChars: 6000",
    "returnedLines: 1-100",
    "returnedChars: 1800",
    "nextStartLine: 101",
    "---CONTENT START---",
    "export function App() {}",
    "---CONTENT END---",
  ].join("\n");
  const fileSignature = buildFileReadSignature("src/App.tsx", args);
  const genericSignature = buildReadOnlyCacheSignature("read_file", args);
  const staleState = {
    signature: fileSignature,
    path: "src/App.tsx",
    argsKey: "stale",
    contentHash: "old-hash",
    contentLength: modelContent.length,
    sizeBytes: 100,
    modifiedMs: 1,
    modelContent,
    updatedAt: 1,
  };

  globalThis.mockIpcInvoke = async (cmd) => cmd === "get_file_metadata"
    ? { path: "src/App.tsx", sizeBytes: 120, modifiedMs: 2 }
    : {};
  const changed = await partitionToolCallsForExecution(createReadFilePartitionInput({
    managedAgentMessages: [{ role: "tool", content: modelContent }],
    fileReadStates: new Map([[fileSignature, staleState]]),
    readOnlyResultCache: new Map([[genericSignature, {
      name: "read_file",
      target: "src/App.tsx",
      content: "stale generic cache content",
    }]]),
  }));

  assert.equal(changed.preExecutionResults.length, 0);
  assert.equal(changed.readOnlyCalls.length, 1);

  const currentState = {
    ...staleState,
    sizeBytes: 120,
    modifiedMs: 2,
    contentHash: "current-hash",
  };
  const active = await partitionToolCallsForExecution(createReadFilePartitionInput({
    managedAgentMessages: [{ role: "tool", content: modelContent }],
    fileReadStates: new Map([[fileSignature, currentState]]),
  }));

  assert.equal(active.readOnlyCalls.length, 0);
  assert.equal(active.preExecutionResults.length, 1);
  assert.match(active.preExecutionResults[0].content, /FILE_UNCHANGED_STUB/);
  assert.equal(active.preExecutionResults[0].readFileObservation?.source, "stub");

  const compactedStates = new Map([[fileSignature, currentState]]);
  const compacted = await partitionToolCallsForExecution(createReadFilePartitionInput({
    managedAgentMessages: [],
    fileReadStates: compactedStates,
  }));

  assert.equal(compacted.preExecutionResults.length, 1);
  assert.equal(compacted.readOnlyCalls.length, 0);
  assert.match(compacted.preExecutionResults[0].content, /CACHED_FILE_REPLAY/);
  assert.match(compacted.preExecutionResults[0].content, /export function App/);
  assert.equal(compacted.preExecutionResults[0].readFileObservation?.source, "replay");
  assert.equal(
    compacted.preExecutionResults[0].readFileObservation?.key,
    active.preExecutionResults[0].readFileObservation?.key,
  );

  const afterSecondCompaction = await partitionToolCallsForExecution(createReadFilePartitionInput({
    managedAgentMessages: [],
    fileReadStates: compactedStates,
    readOnlyDuplicateSkipCounts: new Map([[fileSignature, 1]]),
  }));
  assert.equal(afterSecondCompaction.preExecutionResults.length, 1);
  assert.doesNotMatch(afterSecondCompaction.preExecutionResults[0].content, /CACHED_FILE_REPLAY/);
  assert.match(afterSecondCompaction.preExecutionResults[0].content, /FILE_UNCHANGED_STUB/);

  currentState.contextEvictionEpoch = (currentState.contextEvictionEpoch || 0) + 1;
  const afterNewEvictionEpoch = await partitionToolCallsForExecution(createReadFilePartitionInput({
    managedAgentMessages: [],
    fileReadStates: compactedStates,
    readOnlyDuplicateSkipCounts: new Map([[fileSignature, 1]]),
  }));
  assert.equal(afterNewEvictionEpoch.preExecutionResults.length, 1);
  assert.match(afterNewEvictionEpoch.preExecutionResults[0].content, /CACHED_FILE_REPLAY/);
  assert.match(afterNewEvictionEpoch.preExecutionResults[0].content, /export function App/);
});

test("active-context stubs do not consume the context-eviction replay budget", async () => {
  const args = { path: "src/App.tsx", start_line: 1, max_lines: 100 };
  const signature = buildFileReadSignature("src/App.tsx", args);
  const modelContent = [
    "READ_FILE_RESULT",
    "path: src/App.tsx",
    "---CONTENT START---",
    "export function App() { return null; }",
    "---CONTENT END---",
  ].join("\n");
  const state = {
    signature,
    path: "src/App.tsx",
    argsKey: "window",
    contentHash: "same-version",
    contentLength: modelContent.length,
    sizeBytes: 120,
    modifiedMs: 2,
    modelContent,
    contextEvictionEpoch: 0,
    updatedAt: 1,
  };
  const duplicateCounts = new Map([[signature, 1]]);
  globalThis.mockIpcInvoke = async (cmd) => cmd === "get_file_metadata"
    ? { path: "src/App.tsx", sizeBytes: 120, modifiedMs: 2 }
    : {};
  const callbacks = {
    ...createReadFilePartitionInput().callbacks,
    getIsPlanApproved: () => true,
    getPlanStage: () => "executing",
    getPlanTasks: () => [{
      id: "edit-app",
      text: "Modify src/App.tsx",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "file", value: "src/App.tsx" }],
    }],
  };

  const active = await partitionToolCallsForExecution(createReadFilePartitionInput({
    callbacks,
    workflowMode: "plan",
    managedAgentMessages: [{ role: "tool", content: modelContent }],
    fileReadStates: new Map([[signature, state]]),
    readOnlyDuplicateSkipCounts: duplicateCounts,
  }));
  assert.match(active.preExecutionResults[0].content, /FILE_UNCHANGED_STUB/);
  assert.equal(state.replayCountSinceVersion || 0, 0);

  state.contextEvictionEpoch = 1;
  const evicted = await partitionToolCallsForExecution(createReadFilePartitionInput({
    callbacks,
    workflowMode: "plan",
    managedAgentMessages: [],
    fileReadStates: new Map([[signature, state]]),
    readOnlyDuplicateSkipCounts: duplicateCounts,
  }));
  assert.match(evicted.preExecutionResults[0].content, /CACHED_FILE_REPLAY/);
  assert.equal(state.replayCountSinceVersion, 1);
});

test("stale windows are removed before coverage narrowing can reuse them", async () => {
  const windowContent = (start, end) => [
    "READ_FILE_RESULT",
    "path: src/App.tsx",
    "truncated: true",
    "totalLines: 300",
    "totalChars: 6000",
    `returnedLines: ${start}-${end}`,
    "returnedChars: 1800",
    `nextStartLine: ${end + 1}`,
    "---CONTENT START---",
    `window ${start}-${end}`,
    "---CONTENT END---",
  ].join("\n");
  const currentArgs = { path: "src/App.tsx", start_line: 1, max_lines: 100 };
  const staleNarrowedArgs = { path: "src/App.tsx", start_line: 101, end_line: 200 };
  const currentContent = windowContent(1, 100);
  const staleContent = windowContent(101, 200);
  const currentSignature = buildFileReadSignature("src/App.tsx", currentArgs);
  const staleSignature = buildFileReadSignature("src/App.tsx", staleNarrowedArgs);
  const fileReadStates = new Map([
    [currentSignature, {
      signature: currentSignature,
      path: "src/App.tsx",
      argsKey: "current",
      contentHash: "current",
      contentLength: currentContent.length,
      sizeBytes: 120,
      modifiedMs: 2,
      modelContent: currentContent,
      updatedAt: 2,
    }],
    [staleSignature, {
      signature: staleSignature,
      path: "src/App.tsx",
      argsKey: "stale",
      contentHash: "stale",
      contentLength: staleContent.length,
      sizeBytes: 100,
      modifiedMs: 1,
      modelContent: staleContent,
      updatedAt: 1,
    }],
  ]);
  globalThis.mockIpcInvoke = async (cmd) => cmd === "get_file_metadata"
    ? { path: "src/App.tsx", sizeBytes: 120, modifiedMs: 2 }
    : {};

  const result = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "read-overlap",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/App.tsx", start_line: 1, max_lines: 200 }),
    }],
    managedAgentMessages: [
      { role: "tool", content: currentContent },
      { role: "tool", content: staleContent },
    ],
    fileReadStates,
  }));

  assert.equal(fileReadStates.has(staleSignature), false);
  assert.equal(result.preExecutionResults.length, 0);
  assert.equal(result.readOnlyCalls.length, 1);
  assert.deepEqual(JSON.parse(result.readOnlyCalls[0].arguments), {
    path: "src/App.tsx",
    start_line: 101,
    max_lines: 100,
    end_line: 200,
  });
});

test("a large-file semantic summary never claims exact line coverage", () => {
  const args = { path: "src/huge.ts" };
  const signature = buildFileReadSignature("src/huge.ts", args);
  const states = new Map([[signature, {
    signature,
    path: "src/huge.ts",
    argsKey: "full",
    contentHash: "summary",
    contentLength: 80,
    sizeBytes: 100_000,
    modifiedMs: 7,
    modelContent: "[FILE MAP-REDUCE SUMMARY]\nArchitecture only; exact source lines omitted.",
    updatedAt: 1,
  }]]);

  const coverage = getReadFileCoverageForPath({
    states,
    path: "src/huge.ts",
    metadata: { path: "src/huge.ts", sizeBytes: 100_000, modifiedMs: 7 },
    currentSignature: buildFileReadSignature("src/huge.ts", {
      path: "src/huge.ts",
      start_line: 401,
      max_lines: 100,
    }),
  });

  assert.equal(coverage.fullFileState, null);
  assert.deepEqual(coverage.ranges, []);
});

test("full-file cache coverage preserves the identity of each requested window", async () => {
  const fullContent = "export function App() {\n  return null;\n}\n";
  const fullSignature = buildFileReadSignature("src/App.tsx", { path: "src/App.tsx" });
  const fullState = {
    signature: fullSignature,
    path: "src/App.tsx",
    argsKey: "full",
    contentHash: "full-hash",
    contentLength: fullContent.length,
    sizeBytes: 120,
    modifiedMs: 2,
    modelContent: fullContent,
    updatedAt: 1,
  };
  globalThis.mockIpcInvoke = async (cmd) => cmd === "get_file_metadata"
    ? { path: "src/App.tsx", sizeBytes: 120, modifiedMs: 2 }
    : {};

  const runWindow = async (id, startLine) => partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id,
      name: "read_file",
      arguments: JSON.stringify({ path: "src/App.tsx", start_line: startLine, max_lines: 20 }),
    }],
    managedAgentMessages: [{ role: "tool", content: fullContent }],
    fileReadStates: new Map([[fullSignature, fullState]]),
  }));

  const first = await runWindow("window-a", 1);
  const second = await runWindow("window-b", 21);
  const firstObservation = first.preExecutionResults[0]?.readFileObservation;
  const secondObservation = second.preExecutionResults[0]?.readFileObservation;

  assert.ok(firstObservation);
  assert.ok(secondObservation);
  assert.notEqual(firstObservation.key, secondObservation.key);
  assert.equal(firstObservation.versionToken, secondObservation.versionToken);
  assert.match(firstObservation.requestSignature, /start_line.*1/);
  assert.match(secondObservation.requestSignature, /start_line.*21/);
});

test("execute recovery pins the exact newest source window without truncating it to the file head", () => {
  const makeState = (signature, returnedLines, updatedAt, marker) => {
    const [startLine, endLine] = returnedLines;
    const modelContent = [
      "READ_FILE_RESULT",
      "path: src/toolbar.js",
      "truncated: true",
      "totalLines: 500",
      "totalChars: 10000",
      `returnedLines: ${startLine}-${endLine}`,
      "returnedChars: 6000",
      "---CONTENT START---",
      ...Array.from({ length: 180 }, (_, index) => `${marker}-line-${index + 1}`),
      "---CONTENT END---",
    ].join("\n");
    const observation = buildFileReadObservationIdentity({
      requestSignature: signature,
      path: "src/toolbar.js",
      sizeBytes: 10_000,
      modifiedMs: 7,
      contentHash: `${marker}-hash`,
      source: "fresh",
    });
    return {
      signature,
      path: "src/toolbar.js",
      argsKey: signature,
      contentHash: `${marker}-hash`,
      contentLength: modelContent.length,
      sizeBytes: 10_000,
      modifiedMs: 7,
      modelContent,
      observation,
      updatedAt,
    };
  };
  const fileHead = makeState("head-window", [1, 156], 1, "head");
  const editWindow = makeState("edit-window", [205, 384], 2, "edit");
  const states = new Map([
    [fileHead.signature, fileHead],
    [editWindow.signature, editWindow],
  ]);

  const newest = selectFileReadStateForRecoveryContext({
    states,
    targetPath: "src/toolbar.js",
  });
  assert.equal(newest, editWindow);
  const message = buildExecuteRecoverySourceContextMessage(newest, "en");
  assert.match(message, /observation=.*edit-window/);
  assert.match(message, /window=205-384\/500/);
  assert.match(message, /edit-line-180/);
  assert.doesNotMatch(message, /first 150 lines/i);

  const exactOlderObservation = selectFileReadStateForRecoveryContext({
    states,
    targetPath: "src/toolbar.js",
    observationKey: fileHead.observation.key,
  });
  assert.equal(exactOlderObservation, fileHead);
  assert.equal(selectFileReadStateForRecoveryContext({
    states,
    observationKey: fileHead.observation.key,
  }), fileHead);
  assert.equal(selectFileReadStateForRecoveryContext({
    states,
    targetPath: "src/not-toolbar.js",
  }), null);

  assert.deepEqual(resolveRecoverySourceContextFreshness({
    state: editWindow,
    currentMetadata: { path: "src/toolbar.js", sizeBytes: 10_000, modifiedMs: 7 },
  }), {
    current: true,
    observedVersion: "10000:7",
    currentVersion: "10000:7",
    reason: "metadata_match",
  });
  assert.deepEqual(resolveRecoverySourceContextFreshness({
    state: editWindow,
    currentMetadata: { path: "src/toolbar.js", sizeBytes: 10_040, modifiedMs: 8 },
  }), {
    current: false,
    observedVersion: "10000:7",
    currentVersion: "10040:8",
    reason: "metadata_changed",
  });
  assert.equal(resolveRecoverySourceContextFreshness({
    state: editWindow,
    currentMetadata: null,
  }).current, false);
});

test("execute recovery context uses the real model budget instead of a fixed 16k compaction trigger", () => {
  const contextManagementSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/contextManagement.ts"),
    "utf8",
  );
  assert.doesNotMatch(contextManagementSource, /Math\.min\(16000/);
  assert.doesNotMatch(contextManagementSource, /slice\(0, 150\)/);
  assert.match(
    contextManagementSource,
    /proactiveTriggerBudget: contextBudgetsForManagement\.proactiveTriggerBudget/,
  );
  assert.match(contextManagementSource, /tokenReduction: Math\.round\(recoveryManagedResult\.tokenReduction\)/);
  const recoveryPinIndex = contextManagementSource.lastIndexOf("const recoverySourceContract");
  const evictionIndex = contextManagementSource.indexOf("const fileReadContextEvictions");
  assert.match(contextManagementSource, /recoverySourceContract\.phase === "context"/);
  assert.match(contextManagementSource, /recoverySourceContract\.phase === "mutation"/);
  assert.equal(recoveryPinIndex > contextManagementSource.indexOf("const toolCharsBefore"), true);
  assert.equal(evictionIndex > recoveryPinIndex, true);
});

test("a successful mutation invalidates file windows and args-only observations", () => {
  const signature = buildFileReadSignature("src/App.tsx", {
    path: "src/App.tsx",
    start_line: 1,
    max_lines: 100,
  });
  const fileReadStates = new Map([[signature, {
    signature,
    path: `${workspaceRoot}/src/App.tsx`,
    argsKey: "window",
    contentHash: "old",
    contentLength: 20,
    sizeBytes: 100,
    modifiedMs: 1,
    modelContent: "READ_FILE_RESULT old",
    updatedAt: 1,
  }]]);
  const readOnlyResultCache = new Map([
    ["grep_search::App", { name: "grep_search", content: "old result" }],
    ["git_diff::App", { name: "git_diff", content: "old diff" }],
  ]);
  const duplicateCounts = new Map([[signature, 2]]);

  const invalidation = invalidateWorkspaceReadCachesAfterMutation({
    toolName: "apply_patch",
    args: { patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch" },
    fileReadStates,
    readOnlyResultCache,
    readOnlyDuplicateSkipCounts: duplicateCounts,
  });

  assert.deepEqual(invalidation.invalidatedFileReadSignatures, [signature]);
  assert.equal(invalidation.invalidatedReadOnlyEntries, 2);
  assert.equal(fileReadStates.size, 0);
  assert.equal(readOnlyResultCache.size, 0);
  assert.equal(duplicateCounts.size, 0);

  const commandState = (key, filePath) => ({
      signature: key,
      path: filePath,
      argsKey: "window",
      contentHash: "old",
      contentLength: 20,
      sizeBytes: 100,
      modifiedMs: 1,
      modelContent: "READ_FILE_RESULT old",
      updatedAt: 1,
  });
  const commandStates = new Map([
    ["a", commandState("a", "src/a.ts")],
    ["b", commandState("b", "src/b.ts")],
  ]);
  const commandCache = new Map([["grep", { content: "old" }]]);
  const commandInvalidation = invalidateWorkspaceReadCachesAfterMutation({
    toolName: "run_command",
    args: { command: "npm run format" },
    target: "npm run format",
    fileReadStates: commandStates,
    readOnlyResultCache: commandCache,
  });
  assert.equal(commandInvalidation.invalidatedFileReadSignatures.length, 0);
  assert.equal(commandStates.size, 2);
  assert.equal(commandCache.size, 0);

  const structuredCommandInvalidation = invalidateWorkspaceReadCachesAfterMutation({
    toolName: "run_command",
    args: { command: "npm run format" },
    target: "npm run format",
    changedPaths: ["src/a.ts"],
    fileReadStates: commandStates,
  });
  assert.deepEqual(structuredCommandInvalidation.invalidatedFileReadSignatures, ["a"]);
  assert.equal(commandStates.has("a"), false);
  assert.equal(commandStates.has("b"), true);

  assert.deepEqual(
    extractStructuredChangedPaths(JSON.stringify({
      changedPaths: ["src/a.ts"],
      stdout: JSON.stringify({ changedPaths: ["src/should-not-be-trusted.ts"] }),
    })),
    ["src/a.ts"],
  );
  assert.deepEqual(
    extractStructuredChangedPaths(JSON.stringify({
      stdout: JSON.stringify({ changedPaths: ["src/should-not-be-trusted.ts"] }),
    })),
    [],
  );

  const unityState = commandState("unity", "Assets/Scripts/Foo.cs");
  const unityStates = new Map([["unity", unityState]]);
  const unityInvalidation = invalidateWorkspaceReadCachesAfterMutation({
    toolName: "script_apply_edits",
    args: { path: "Assets/Scripts", name: "Foo" },
    target: "Assets/Scripts/Foo.cs",
    fileReadStates: unityStates,
  });
  assert.deepEqual(unityInvalidation.invalidatedFileReadSignatures, ["unity"]);

  const inspectStates = new Map([["unity", unityState]]);
  const inspectInvalidation = invalidateWorkspaceReadCachesAfterMutation({
    toolName: "manage_script",
    args: { action: "inspect", path: "Assets/Scripts", name: "Foo" },
    target: "manage_script",
    fileReadStates: inspectStates,
  });
  assert.equal(inspectInvalidation.invalidatedFileReadSignatures.length, 0);
  assert.equal(inspectStates.size, 1);

  const controlStates = new Map([["control-read", commandState("control-read", "src/App.tsx")]]);
  const controlCache = new Map([["read_file:{}", "cached source"]]);
  const controlInvalidation = invalidateWorkspaceReadCachesAfterMutation({
    toolName: "send_pty_input",
    args: { control: "interrupt" },
    target: "CTRL_C",
    fileReadStates: controlStates,
    readOnlyResultCache: controlCache,
  });
  assert.deepEqual(controlInvalidation, {
    invalidatedFileReadSignatures: [],
    invalidatedReadOnlyEntries: 1,
  });
  assert.equal(controlStates.size, 1);
  assert.equal(controlCache.size, 0);
});

test("only real mutations and opaque workspace actions refresh unversioned observations", () => {
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("write_file", {
    content: JSON.stringify({ success: true, noOp: true }),
    isError: false,
  }), false);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("replace_in_file", {
    content: "NO_EFFECT_MUTATION: content already matched",
    isError: false,
  }), false);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("apply_patch", {
    content: "patched",
    isError: false,
  }), true);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("delete_workspace_path", {
    content: JSON.stringify({ success: true }),
    isError: false,
  }), true);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("script_apply_edits", {
    content: "updated method",
    isError: false,
  }, { path: "Assets/Scripts", name: "Foo" }), true);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("manage_script", {
    content: "inspected script",
    isError: false,
  }, { action: "inspect", path: "Assets/Scripts", name: "Foo" }), false);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("manage_script", {
    content: "created script",
    isError: false,
  }, { action: "create", path: "Assets/Scripts", name: "Foo" }), true);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("run_command", {
    content: JSON.stringify({ exitCode: 0, stdout: "no-op appears in test output" }),
    isError: false,
  }), true);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("send_pty_input", {
    content: "input sent",
    isError: false,
  }, { input: "\\u0003" }), false);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("send_pty_input", {
    content: "interactive answer sent",
    isError: false,
  }, { input: "y" }), true);
});

test("same-batch reads suppress only the exact duplicate signature", async () => {
  globalThis.mockIpcInvoke = async (cmd) => cmd === "get_file_metadata"
    ? { path: "src/App.tsx", sizeBytes: 120, modifiedMs: 2 }
    : {};
  const result = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [
      { id: "same-1", name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx", start_line: 1, max_lines: 100 }) },
      { id: "same-2", name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx", start_line: 1, max_lines: 100 }) },
      { id: "next", name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx", start_line: 101, max_lines: 100 }) },
    ],
  }));

  assert.equal(result.readOnlyCalls.length, 2);
  assert.deepEqual(result.readOnlyCalls.map((call) => call.id), ["same-1", "next"]);
  assert.equal(result.preExecutionResults.length, 1);
  assert.match(result.preExecutionResults[0].content, /^FILE_UNCHANGED_STUB/);
});

test("a read after a same-batch mutation is deferred instead of executing against old source", async () => {
  const registry = {
    tools: {
      ...partitionToolCapabilityRegistry.tools,
      write_file: {
        key: "write_file",
        name: "write_file",
        source: "built_in",
        category: "file",
        risk: "workspace_write",
        enabled: true,
        autoExecutable: false,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const input = createReadFilePartitionInput({
    toolCalls: [
      { id: "write-first", name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "updated" }) },
      { id: "verify-after", name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx", start_line: 1, max_lines: 100 }) },
    ],
    availableToolNames: new Set(["write_file", "read_file"]),
    toolCapabilityRegistry: registry,
  });
  input.callbacks = {
    ...input.callbacks,
    getAutoApproveToolScopes: () => ["workspace_write"],
  };

  const result = await partitionToolCallsForExecution(input);
  assert.equal(result.writeCalls.length, 1);
  assert.equal(result.readOnlyCalls.length, 0);
  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].internalFeedback, true);
  assert.match(result.preExecutionResults[0].content, /ORDERED_BATCH_CALL_DEFERRED/);

  const orderedInput = createReadFilePartitionInput({
    toolCalls: [
      { id: "read-first", name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx", start_line: 1, max_lines: 100 }) },
      { id: "write-after", name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "updated" }) },
    ],
    availableToolNames: new Set(["write_file", "read_file"]),
    toolCapabilityRegistry: registry,
  });
  orderedInput.callbacks = {
    ...orderedInput.callbacks,
    getAutoApproveToolScopes: () => ["workspace_write"],
  };
  const ordered = await partitionToolCallsForExecution(orderedInput);
  assert.equal(ordered.readOnlyCalls.length, 1);
  assert.equal(ordered.writeCalls.length, 1);
  assert.equal(ordered.preExecutionResults.length, 0);
});

test("a read after a same-batch MCP script edit is also deferred", async () => {
  const registry = {
    tools: {
      ...partitionToolCapabilityRegistry.tools,
      script_apply_edits: {
        key: "script_apply_edits",
        name: "script_apply_edits",
        source: "mcp",
        category: "file",
        risk: "external_write",
        enabled: true,
        autoExecutable: false,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const input = createReadFilePartitionInput({
    toolCalls: [
      {
        id: "mcp-edit-first",
        name: "script_apply_edits",
        arguments: JSON.stringify({ path: "Assets/Scripts", name: "Foo", edits: [] }),
      },
      {
        id: "read-after-mcp-edit",
        name: "read_file",
        arguments: JSON.stringify({ path: "Assets/Scripts/Foo.cs", start_line: 1, max_lines: 100 }),
      },
    ],
    availableToolNames: new Set(["script_apply_edits", "read_file"]),
    toolCapabilityRegistry: registry,
  });
  input.callbacks = {
    ...input.callbacks,
    getAutoApproveToolScopes: () => ["external_write"],
  };

  const result = await partitionToolCallsForExecution(input);
  assert.equal(result.writeCalls.length, 1);
  assert.equal(result.readOnlyCalls.length, 0);
  assert.equal(result.preExecutionResults.length, 1);
  assert.match(result.preExecutionResults[0].content, /ORDERED_BATCH_CALL_DEFERRED/);
});

test("all workspace observations after a same-batch action are deferred", async () => {
  const registry = {
    tools: {
      ...partitionToolCapabilityRegistry.tools,
      execute_command: {
        key: "execute_command",
        name: "execute_command",
        source: "built_in",
        category: "shell",
        risk: "shell",
        enabled: true,
        autoExecutable: false,
      },
      grep_search: {
        key: "grep_search",
        name: "grep_search",
        source: "built_in",
        category: "workspace_read",
        risk: "read_only",
        enabled: true,
        autoExecutable: true,
      },
      get_pty_status: {
        key: "get_pty_status",
        name: "get_pty_status",
        source: "built_in",
        category: "workspace_read",
        risk: "read_only",
        enabled: true,
        autoExecutable: true,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const input = createReadFilePartitionInput({
    toolCalls: [
      { id: "start", name: "execute_command", arguments: JSON.stringify({ command: "npm run dev" }) },
      { id: "pty-after", name: "get_pty_status", arguments: JSON.stringify({ session_id: "pty-1" }) },
      { id: "grep-after", name: "grep_search", arguments: JSON.stringify({ query: "updated", path: "src" }) },
    ],
    availableToolNames: new Set(["execute_command", "get_pty_status", "grep_search"]),
    toolCapabilityRegistry: registry,
  });
  input.callbacks = {
    ...input.callbacks,
    getAutoApproveToolScopes: () => ["shell"],
  };

  const result = await partitionToolCallsForExecution(input);
  assert.deepEqual(result.writeCalls.map((call) => call.id), ["start"]);
  assert.equal(result.readOnlyCalls.length, 0);
  assert.deepEqual(result.preExecutionResults.map((entry) => entry.toolCallId), [
    "pty-after",
    "grep-after",
  ]);
  assert.ok(result.preExecutionResults.every((entry) =>
    entry.qualityGateReason === "ordered_batch_call_deferred"
  ));
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

test("adaptive delegation exposes spawn only during useful context or diagnosis phases", () => {
  const tools = ["read_file", "spawn_subagent", "wait_subagents", "apply_patch"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const makeInput = (overrides = {}) => ({
    callbacks: {
      getConfig: () => ({ workspace: "/workspace" }),
      getIsPlanApproved: () => false,
      getPlanTasks: () => [],
      getPlanExecutionEvidenceLedger: () => [],
      getMessages: () => [],
      getPlanStage: () => "idle",
      getPendingSubagentIds: () => [],
    },
    iteration: 1,
    workflowMode: "edit",
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
    recentPlanToolActivity: [],
    planRuntimePhase: "idle",
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
    },
    lastAssistantTextForCheckpoint: "",
    latestUserPromptText: "可以开启多个 subagent 协同检查",
    ...overrides,
  });

  const context = resolveIterationToolSurface(makeInput());
  assert.equal(context.delegationDecision.action, "admit");
  assert.equal(context.delegationDecision.phase, "context");
  assert.equal(context.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), true);

  const mutation = resolveIterationToolSurface(makeInput({
    recentToolActivity: [
      {
        name: "apply_patch",
        target: "src/main.js",
        status: "succeeded",
      },
      {
        name: "read_file",
        target: "src/main.js",
        status: "succeeded",
      },
    ],
  }));
  assert.equal(mutation.delegationDecision.action, "defer");
  assert.equal(mutation.delegationDecision.phase, "mutation");
  assert.equal(mutation.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), false);
  assert.equal(mutation.iterationAllTools.some((tool) => tool.function.name === "wait_subagents"), true);

  const validation = resolveIterationToolSurface(makeInput({
    recentToolActivity: [
      {
        name: "run_command",
        target: "npm test",
        status: "succeeded",
      },
      {
        name: "read_file",
        target: "src/main.js",
        status: "succeeded",
      },
    ],
  }));
  assert.equal(validation.delegationDecision.phase, "validation");
  assert.equal(validation.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), false);

  const simple = resolveIterationToolSurface(makeInput({
    latestUserPromptText: "读取 src/main.js",
  }));
  assert.equal(simple.delegationDecision.reason, "insufficient_independent_scope");
  assert.equal(simple.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), false);
});

test("parent mutation requires every delegated source window, not only the latest one", () => {
  const laterWindowContent = "parent observed lines 80 through 100";
  const delegated = (startLine, endLine, key) => ({
    name: "read_file",
    target: "src/main.js",
    status: "succeeded",
    delegatedObservation: {
      owner: { agentKind: "subagent", subagentId: "subagent-euler" },
      sourceObservationKey: key,
      sourceVersion: "v1",
      sourceRange: { startLine, endLine, totalLines: 120, truncated: true },
      parentContextState: "reference_only",
      requiresParentReread: true,
    },
  });
  const missing = findDelegatedObservationRequiringParentReread({
    mutationTargets: ["src/main.js"],
    recentToolActivity: [
      delegated(1, 20, "src/main.js:1-20:v1"),
      delegated(80, 100, "src/main.js:80-100:v1"),
    ],
    fileReadStates: new Map([[
      "read_file::src/main.js::80-100",
      {
        signature: "read_file::src/main.js::80-100",
        path: "src/main.js",
        argsKey: "80-100",
        contentHash: "later",
        contentLength: laterWindowContent.length,
        sizeBytes: 1200,
        modifiedMs: 1,
        modelContent: laterWindowContent,
        observation: {
          key: "src/main.js:80-100:v1",
          path: "src/main.js",
          requestSignature: "read_file::src/main.js::80-100",
          versionToken: "v1",
          source: "fresh",
        },
        window: { startLine: 80, endLine: 100, totalLines: 120, truncated: true },
        updatedAt: 1,
      },
    ]]),
    managedAgentMessages: [{ role: "tool", content: laterWindowContent }],
  });

  assert.equal(missing?.delegatedObservation?.sourceObservationKey, "src/main.js:1-20:v1");
});

test("plan checklist length is telemetry, not an independent-scope admission signal", () => {
  const tools = ["read_file", "spawn_subagent", "wait_subagents"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const decision = resolveIterationToolSurface({
    callbacks: {
      getConfig: () => ({ workspace: "/workspace" }),
      getIsPlanApproved: () => false,
      getPlanTasks: () => Array.from({ length: 5 }, (_, index) => ({
        id: `task-${index}`,
        text: `Inspect item ${index}`,
        status: "pending",
      })),
      getPlanExecutionEvidenceLedger: () => [],
      getMessages: () => [],
      getPlanStage: () => "requirements",
      getPendingSubagentIds: () => [],
    },
    iteration: 2,
    workflowMode: "plan",
    runtimeIntent: "plan",
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
    recentPlanToolActivity: [],
    planRuntimePhase: "grounding",
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
    latestUserPromptText: "Inspect the repository and prepare a plan",
  });

  assert.equal(decision.delegationDecision.plannedWorkItemCount, 5);
  assert.equal(decision.delegationDecision.independentScopeCount, 0);
  assert.equal(decision.delegationDecision.action, "defer");
  assert.equal(decision.availableToolNames.has("spawn_subagent"), false);
});

test("recovery hides new child creation but keeps join available and selects it before phase work", () => {
  const tools = ["read_file", "spawn_subagent", "wait_subagents", "apply_patch"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const decision = resolveIterationToolSurface({
    callbacks: {
      getConfig: () => ({ workspace: "/workspace" }),
      getIsPlanApproved: () => false,
      getPlanTasks: () => [],
      getPlanExecutionEvidenceLedger: () => [],
      getMessages: () => [],
      getPlanStage: () => "idle",
      getPendingSubagentIds: () => ["subagent-running"],
    },
    iteration: 3,
    workflowMode: "edit",
    runtimeIntent: "execute",
    rawIterationAllTools: tools,
    executeRecoveryMode: "mutation_first",
    executeRecoveryReason: "resume_mutation",
    executeRecoveryAttempts: 1,
    recoveryIterationCount: 1,
    maxRecoveryIterations: 6,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanLongReasoningNoActionCount: 0,
    recentToolActivity: [],
    recentPlanToolActivity: [],
    planRuntimePhase: "idle",
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
  });

  assert.equal(decision.availableToolNames.has("spawn_subagent"), false);
  assert.equal(decision.availableToolNames.has("wait_subagents"), true);
  assert.equal(isExecuteRecoveryToolName("wait_subagents", readOnlyTools, {
    mode: "mutation_first",
  }), true);
  const batch = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [
      { id: "join", name: "wait_subagents", target: "subagent-running" },
      { id: "edit", name: "apply_patch", target: "src/App.tsx" },
    ],
  });
  assert.equal(batch.selectedToolName, "wait_subagents");
  assert.deepEqual(batch.deferredCallIds, ["edit"]);
});

test("a spawn omitted by adaptive admission is a policy deferral, not a tool failure", async () => {
  const done = [];
  const errors = [];
  const input = createReadFilePartitionInput({
    toolCalls: [{
      id: "spawn-deferred",
      name: "spawn_subagent",
      arguments: JSON.stringify({
        objective: "Inspect one simple file",
        allowed_paths: "src/App.tsx",
      }),
    }],
    availableToolNames: new Set(["read_file"]),
  });
  input.callbacks = {
    ...input.callbacks,
    onToolDone: (...args) => done.push(args),
    onToolError: (...args) => errors.push(args),
  };

  const partitioned = await partitionToolCallsForExecution(input);
  assert.equal(partitioned.preExecutionResults.length, 1);
  assert.equal(partitioned.preExecutionResults[0].isError, false);
  assert.equal(partitioned.preExecutionResults[0].internalFeedback, true);
  assert.equal(partitioned.preExecutionResults[0].qualityGateReason, "subagent_delegation_deferred");
  assert.equal(errors.length, 0);
  assert.equal(done.length, 1);
  assert.equal(partitioned.toolFailureSignatures?.size || 0, 0);
});

test("parent access to an active child lease is deferred without incrementing failures", async () => {
  subagents.resetSubagentRuntimeForTests();
  subagents.acquireSubagentScopeLease({
    threadId: "read-cache-test",
    parentTurnId: "turn-parent-scope",
    subagentId: "subagent-owner",
    scopeKey: "app-owner",
    workspace: workspaceRoot,
    allowedPaths: ["src/App.tsx"],
    createdAt: Date.now(),
  });
  const done = [];
  const errors = [];
  const input = createReadFilePartitionInput();
  input.callbacks = {
    ...input.callbacks,
    onToolDone: (...args) => done.push(args),
    onToolError: (...args) => errors.push(args),
  };

  const partitioned = await partitionToolCallsForExecution(input);
  assert.equal(partitioned.preExecutionResults.length, 1);
  assert.equal(partitioned.preExecutionResults[0].isError, false);
  assert.equal(partitioned.preExecutionResults[0].internalFeedback, true);
  assert.equal(partitioned.preExecutionResults[0].qualityGateReason, "subagent_scope_policy_deferred");
  assert.match(partitioned.preExecutionResults[0].content, /policy deferral/i);
  assert.equal(errors.length, 0);
  assert.equal(done.length, 1);
  assert.equal(partitioned.toolFailureSignatures?.size || 0, 0);
  subagents.resetSubagentRuntimeForTests();
});

test("child-owned source references require a parent-visible targeted read before mutation", async () => {
  const registry = {
    tools: {
      ...partitionToolCapabilityRegistry.tools,
      write_file: {
        key: "write_file",
        name: "write_file",
        source: "built_in",
        category: "file",
        risk: "workspace_write",
        enabled: true,
        autoExecutable: false,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const delegatedActivity = {
    name: "read_file",
    target: "src/App.tsx",
    status: "succeeded",
    delegatedObservation: {
      owner: {
        agentKind: "subagent",
        subagentId: "subagent-source-owner",
        parentTurnId: "turn",
        runId: "run-child",
      },
      sourceToolCallId: "child-read",
      sourceObservationKey: "child-window",
      sourceVersion: "120:2",
      sourceRange: {
        startLine: 1,
        endLine: 10,
        totalLines: 40,
        truncated: true,
      },
      parentContextState: "reference_only",
      requiresParentReread: true,
    },
  };
  const done = [];
  const base = createReadFilePartitionInput({
    toolCalls: [{
      id: "write-from-child",
      name: "write_file",
      arguments: JSON.stringify({ path: "src/App.tsx", content: "updated" }),
    }],
    availableToolNames: new Set(["read_file", "write_file"]),
    toolCapabilityRegistry: registry,
    recentToolActivity: [delegatedActivity],
  });
  base.callbacks = {
    ...base.callbacks,
    getAutoApproveToolScopes: () => ["workspace_write"],
    onToolDone: (...args) => done.push(args),
  };

  const blocked = await partitionToolCallsForExecution(base);
  assert.equal(blocked.writeCalls.length, 0);
  assert.equal(blocked.preExecutionResults[0].qualityGateReason, "subagent_parent_reread_required");
  assert.equal(blocked.preExecutionResults[0].isError, false);
  assert.match(blocked.preExecutionResults[0].content, /targeted read_file/i);
  assert.equal(blocked.toolFailureSignatures.size, 0);

  const modelContent = [
    "READ_FILE_RESULT",
    "path: src/App.tsx",
    "returnedLines: 1-40",
    "---CONTENT START---",
    "export const App = () => null;",
    "---CONTENT END---",
  ].join("\n");
  const parentObserved = await partitionToolCallsForExecution({
    ...base,
    managedAgentMessages: [{ role: "user", content: modelContent }],
    fileReadStates: new Map([["parent-window", {
      signature: "parent-window",
      path: "src/App.tsx",
      argsKey: "start=1",
      contentHash: "parent-hash",
      contentLength: modelContent.length,
      sizeBytes: 120,
      modifiedMs: 2,
      modelContent,
      observation: {
        key: "parent-window",
        path: "src/App.tsx",
        requestSignature: "read_file::src/App.tsx::1-40",
        versionToken: "120:2",
        source: "fresh",
      },
      window: {
        startLine: 1,
        endLine: 40,
        totalLines: 40,
        truncated: false,
      },
      updatedAt: Date.now(),
    }]]),
  });
  assert.equal(parentObserved.preExecutionResults.length, 0);
  assert.equal(parentObserved.writeCalls.length, 1);
});

test("iteration tool planning derives action-plus PTY and browser surfaces from the lifecycle ledger", () => {
  const tools = [
    "read_file",
    "apply_patch",
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
  const baseInput = {
    callbacks: {
      getIsPlanApproved: () => false,
      getPlanTasks: () => [],
      getMessages: () => [],
      getPlanStage: () => "idle",
    },
    iteration: 9,
    workflowMode: "edit",
    runtimeIntent: "goal",
    rawIterationAllTools: tools,
    executeRecoveryMode: "action_plus_targeting",
    executeRecoveryReason: "goal_slice_recovery",
    executeRecoveryAttempts: 1,
    recoveryIterationCount: 2,
    maxRecoveryIterations: 6,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanLongReasoningNoActionCount: 0,
    recentToolActivity: [],
    recentPlanToolActivity: [],
    planRuntimePhase: "idle",
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
  };
  const pending = resolveIterationToolSurface({
    ...baseInput,
    callbacks: {
      ...baseInput.callbacks,
      getPlanExecutionEvidenceLedger: () => [{
        id: "launch",
        kind: "cmd",
        value: "npm run dev",
        sourceTool: "execute_command",
        observationStatus: "pending",
        foregroundGeneration: 3,
        createdAt: 1,
      }],
    },
  });
  assert.equal(pending.recoveryActionContract.nextRequiredCapability, "observe_pty");
  assert.deepEqual(pending.iterationAllTools.map((tool) => tool.function.name), [
    "send_pty_input",
    "read_pty_buffer",
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
  ]);

  const ready = resolveIterationToolSurface({
    ...baseInput,
    callbacks: {
      ...baseInput.callbacks,
      getPlanExecutionEvidenceLedger: () => [{
        id: "ready",
        kind: "dev_server_url",
        value: "http://localhost:1420/",
        sourceTool: "read_pty_since",
        observationStatus: "ready",
        foregroundGeneration: 3,
        outputSequence: 8,
        createdAt: 2,
      }],
    },
  });
  assert.equal(ready.recoveryActionContract.nextRequiredCapability, "browser_validation");
  assert.equal(ready.recoveryActionContract.devServerUrl, "http://localhost:1420/");
  assert.deepEqual(ready.iterationAllTools.map((tool) => tool.function.name), ["browser_evaluate"]);

  const postMutation = resolveIterationToolSurface({
    ...baseInput,
    executeRecoveryMode: "validation_only",
    executeRecoveryReadLease: {
      purpose: "post_mutation_verify",
      target: "src/App.tsx",
      state: "available",
    },
    callbacks: {
      ...baseInput.callbacks,
      getPlanExecutionEvidenceLedger: () => [{
        id: "ready",
        kind: "dev_server_url",
        value: "http://localhost:1420/",
        sourceTool: "read_pty_since",
        observationStatus: "ready",
        foregroundGeneration: 3,
        outputSequence: 8,
        createdAt: 2,
      }],
    },
  });
  assert.equal(postMutation.recoveryActionContract.phase, "post_mutation_check");
  assert.equal(postMutation.recoveryActionContract.nextRequiredCapability, "targeted_read");
  assert.deepEqual(postMutation.iterationAllTools.map((tool) => tool.function.name), ["read_file"]);

  const failed = resolveIterationToolSurface({
    ...baseInput,
    executeRecoveryExpectedTarget: "src/App.tsx",
    callbacks: {
      ...baseInput.callbacks,
      getPlanExecutionEvidenceLedger: () => [{
        id: "failed-launch",
        kind: "cmd",
        value: "npm run dev",
        sourceTool: "execute_command",
        observationStatus: "failed",
        createdAt: 3,
      }],
    },
  });
  assert.equal(failed.recoveryActionContract.nextRequiredCapability, "recover_process");
  assert.deepEqual(failed.iterationAllTools.map((tool) => tool.function.name), [
    "read_file",
    "apply_patch",
    "run_command",
    "execute_command",
    "read_pty_buffer",
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
  ]);
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

test("repeat-edit validation recovery keeps conditional target reads but forbids more edits", () => {
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
  }), true);
  assert.equal(describeExecuteRecoveryToolSurface("validation_only"), "validation_with_targeted_read");

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
  assert.match(prompt, /不能替代验证/);
});

test("failed finite validation recovery requires run_command while preserving conditional target reads", () => {
  assert.equal(isExecuteRecoveryToolName("run_command", readOnlyTools, {
    mode: "finite_validation_only",
  }), true);
  for (const blocked of [
    "execute_command",
    "read_pty_since",
    "replace_in_file",
    "browser_evaluate",
  ]) {
    assert.equal(isExecuteRecoveryToolName(blocked, readOnlyTools, {
      mode: "finite_validation_only",
    }), false, blocked);
  }
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "finite_validation_only",
  }), true);
  assert.equal(
    describeExecuteRecoveryToolSurface("finite_validation_only"),
    "finite_validation_with_targeted_read",
  );
  const prompt = buildFailedFiniteValidationRecoveryPrompt({
    command: "node -e require('./src/example.js')",
    result: '{"exitCode":1,"stderr":"module not found"}',
  });
  assert.match(prompt, /`run_command` is the required next capability/);
  assert.match(prompt, /conditional read_file remains available/);
  assert.match(prompt, /exitCode 0/);
});

test("failed finite validation recovery preserves explicit command evidence", () => {
  const explicitPolicy = resolveFailedFiniteValidationRecoveryPolicy({
    failedCommand: "npm test 2>&1",
    tasks: [{ evidence: [{ kind: "cmd", value: "npm test" }] }],
  });
  assert.deepEqual(explicitPolicy, {
    allowAlternativeCommand: false,
    requiredCommand: "npm test",
  });
  const explicitPrompt = buildFailedFiniteValidationRecoveryPrompt({
    command: "npm test 2>&1",
    result: '{"exitCode":1,"stderr":"test failed"}',
    ...explicitPolicy,
  });
  assert.match(explicitPrompt, /requires this exact command evidence: npm test/);
  assert.match(explicitPrompt, /retry that same command/);
  assert.match(explicitPrompt, /Do not substitute a different/);
  assert.match(explicitPrompt, /keep `npm test` as the acceptance boundary/);
  assert.doesNotMatch(explicitPrompt, /call one different finite validation command/);
  assert.doesNotMatch(explicitPrompt, /Do not repeat the failed command unchanged/);

  const placeholderPolicy = resolveFailedFiniteValidationRecoveryPolicy({
    failedCommand: "npm run build",
    tasks: [{ evidence: [{ kind: "cmd", value: "focused validation command" }] }],
  });
  assert.deepEqual(placeholderPolicy, {
    allowAlternativeCommand: true,
    requiredCommand: "",
  });
  const placeholderPrompt = buildFailedFiniteValidationRecoveryPrompt({
    command: "npm run build",
    result: '{"exitCode":1,"stderr":"missing script"}',
    ...placeholderPolicy,
  });
  assert.match(placeholderPrompt, /generic finite-validation placeholder/);
  assert.match(placeholderPrompt, /call one different finite validation command/);
});

test("failed finite validation recovery ignores runtime availability probes", () => {
  assert.equal(shouldEnterFailedFiniteValidationRecovery("npm run build"), true);
  assert.equal(shouldEnterFailedFiniteValidationRecovery("npx tsc --noEmit"), true);
  assert.equal(
    shouldEnterFailedFiniteValidationRecovery("lsof -i :5173 2>/dev/null | head -5"),
    false,
  );
  assert.equal(
    shouldEnterFailedFiniteValidationRecovery("curl -f http://localhost:5173"),
    false,
  );
  assert.equal(hasPendingPlanCommandEvidence([{
    evidence: [{ kind: "cmd", value: "focused validation command" }],
  }]), true);
  assert.equal(hasPendingPlanCommandEvidence([{
    evidence: [{ kind: "browser_dom", value: "http://localhost:5173" }],
  }]), false);
});

test("failed finite validation recovery distinguishes invocation errors from real validation failures", () => {
  assert.equal(classifyFailedFiniteValidationOutcome({
    result: JSON.stringify({ exitCode: 127, stderr: "tool: command not found" }),
  }), "invocation_error");
  assert.equal(classifyFailedFiniteValidationOutcome({
    result: JSON.stringify({ exitCode: 1, stderr: "npm error Missing script: build" }),
  }), "invocation_error");
  assert.equal(classifyFailedFiniteValidationOutcome({
    result: JSON.stringify({ exitCode: 1, stderr: "TS2322: Type 'string' is not assignable to type 'number'" }),
  }), "validation_failure");
  assert.equal(classifyFailedFiniteValidationOutcome({
    result: JSON.stringify({ exitCode: 1, stderr: "TS2322: compile failed" }),
    isToolError: true,
    lifecycleState: "failed",
  }), "validation_failure");
  assert.equal(classifyFailedFiniteValidationOutcome({
    result: JSON.stringify({ exitCode: 1, stdout: "1 test failed" }),
  }), "validation_failure");
  assert.equal(classifyFailedFiniteValidationOutcome({
    result: JSON.stringify({ exitCode: -1, timedOut: true, stderr: "" }),
  }), "validation_failure");

  const explicitTasks = [{ evidence: [{ kind: "cmd", value: "npm test" }] }];
  assert.equal(failedFiniteValidationMatchesPendingPlanEvidence({
    failedCommand: "npm test -- --runInBand",
    tasks: explicitTasks,
  }), true);
  assert.equal(failedFiniteValidationMatchesPendingPlanEvidence({
    failedCommand: "npm run build",
    tasks: explicitTasks,
  }), false);
  assert.equal(failedFiniteValidationMatchesPendingPlanEvidence({
    failedCommand: "npm run build",
    tasks: [{ evidence: [{ kind: "cmd", value: "focused validation command" }] }],
  }), true);

  const compacted = compactStructuredCommandResult(JSON.stringify({
    command: "npm run build",
    stdout: "x".repeat(20_000),
    stderr: "TS2322: compile failed\n" + "y".repeat(20_000),
    exitCode: 1,
    timedOut: false,
    durationMs: 10,
    success: false,
  }), 2_000);
  assert.ok(compacted.length <= 2_000);
  assert.equal(JSON.parse(compacted).exitCode, 1);
  assert.equal(classifyFailedFiniteValidationOutcome({ result: compacted }), "validation_failure");
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
    activeReadLease: {
      purpose: "patch_recovery",
      target: "src/App.tsx",
      state: "available",
    },
    leaseClaimed: false,
  }), true);
  assert.equal(shouldUseExecutePatchRecoveryReadLease({
    toolName: "read_file",
    allowFileRead: true,
    target: "src/App.tsx",
    activeReadLease: {
      purpose: "patch_recovery",
      target: "src/App.tsx",
      state: "available",
    },
    leaseClaimed: true,
  }), false, "only one same-batch call may claim the targeted cache-bypass lease");

  const mismatchFingerprint = buildExecutePatchMismatchFingerprint({
    reason: "mutation_preflight_invalid_patch",
    target: "./src/App.tsx",
  });
  assert.equal(
    buildPatchRecoveryReadNoProgressFingerprint("./src/App.tsx"),
    "patch_recovery_read::./src/app.tsx::read_file:./src/app.tsx:read_unchanged",
  );
  const exactLease = {
    purpose: "patch_recovery",
    target: "src/App.tsx",
    requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    observedVersion: "4096:1700000000000",
    mismatchFingerprint,
    state: "available",
  };
  assert.equal(readEvidenceSatisfiesRecoveryLease({
    lease: exactLease,
    target: "/tmp/workspace/src/App.tsx",
    requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    observedVersion: "4096:1700000000000",
  }), true, "the first exact target/range/version read remains eligible");
  assert.equal(shouldUseExecutePatchRecoveryReadLease({
    toolName: "read_file",
    allowFileRead: true,
    target: "src/App.tsx",
    requestedRange: { startLine: 1, endLine: 52, maxLines: 52 },
    observedVersion: "4096:1700000000000",
    activeReadLease: exactLease,
    leaseClaimed: false,
  }), false, "a different source window cannot claim an exact mismatch lease");
  assert.equal(shouldUseExecutePatchRecoveryReadLease({
    toolName: "read_file",
    allowFileRead: true,
    target: "src/App.tsx",
    requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    observedVersion: "4097:1700000000001",
    activeReadLease: exactLease,
    leaseClaimed: false,
  }), false, "a different observed file version cannot claim the old lease");
  assert.equal(patchRecoveryLeaseIdentityMatches(
    { ...exactLease, state: "consumed" },
    { ...exactLease, state: "available" },
  ), true, "the same mismatch identity must not mint a second lease");
  assert.equal(patchRecoveryLeaseIdentityMatches(
    { ...exactLease, state: "consumed" },
    { ...exactLease, observedVersion: "4097:1700000000001", state: "available" },
  ), false, "new version evidence may mint a distinct lease");

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

  const mutationFirstDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    isPlanApproved: false,
    executeRecoveryMode: "mutation_first",
    executeRecoveryAttempts: 1,
    results: [{
      name: "apply_patch",
      target: "src/main.js",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED: invalid_patch",
      isError: true,
    }],
  });
  assert.equal(mutationFirstDecision?.mode, "patch_recovery_read");
  assert.equal(mutationFirstDecision?.target, "src/main.js");

  const accumulatedAttemptDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    isPlanApproved: false,
    executeRecoveryMode: "mutation_first",
    executeRecoveryAttempts: 7,
    results: [{
      name: "replace_in_file",
      target: "src/main.js",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED: search_text mismatch",
      isError: true,
    }],
  });
  assert.equal(
    accumulatedAttemptDecision?.mode,
    "patch_recovery_read",
    "historical recovery activations must not suppress a new target/version mismatch contract",
  );

  const versionedDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    isPlanApproved: false,
    executeRecoveryMode: "normal",
    executeRecoveryAttempts: 0,
    results: [{
      name: "apply_patch",
      target: "src/main.js",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED: invalid_patch",
      isError: true,
      patchRecoveryMismatch: {
        mismatchFingerprint: "patch_mismatch::src/main.js::invalid_patch::mutation-a1",
        target: "./src/main.js",
        requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
        observedVersion: "8192:1700000000000",
      },
    }],
  });
  assert.deepEqual(versionedDecision, {
    mode: "patch_recovery_read",
    reason: "mutation_preflight_invalid_patch",
    target: "src/main.js",
    mismatchFingerprint: "patch_mismatch::src/main.js::invalid_patch::mutation-a1",
    requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    observedVersion: "8192:1700000000000",
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

  const finiteValidation = resolveExecuteRecoveryBatchDecision({
    mode: "finite_validation_only",
    calls: [
      { id: "probe", name: "run_command", target: "lsof -i :5173" },
      { id: "finite", name: "run_command", target: "npm test" },
    ],
  });
  assert.equal(
    finiteValidation.selectedCallId,
    "finite",
    "finite recovery must not spend its serialized transaction on an availability probe",
  );
  assert.deepEqual(finiteValidation.deferredCallIds, ["probe"]);

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

test("no-progress markers are recognized only as runtime-owned result prefixes", () => {
  assert.equal(isReadOnlyNoProgressDetail("FILE_UNCHANGED_STUB: src/App.tsx"), true);
  assert.equal(isReadOnlyNoProgressDetail("CACHED_FILE_REPLAY: src/App.tsx"), true);
  assert.equal(isReadOnlyNoProgressDetail("READ_FILE_REPEAT_LIMIT: duplicate"), true);
  assert.equal(isReadOnlyNoProgressDetail("READ_FILE_WINDOW_NARROWED: returned missing lines"), true);
  assert.equal(isReadOnlyNoProgressDetail([
    "READ_FILE_RESULT",
    "path: src/lib/orchestrator/fileReadCache.ts",
    "const marker = 'FILE_UNCHANGED_STUB';",
  ].join("\n")), false);

  const decision = resolveReadOnlyNoProgressTrigger({
    results: [{
      name: "read_file",
      target: "src/lib/orchestrator/fileReadCache.ts",
      content: "READ_FILE_RESULT\nconst marker = 'FILE_UNCHANGED_STUB';",
      isError: false,
    }],
    recentActivity: Array.from({ length: 8 }, () => ({
      name: "read_file",
      status: "succeeded",
      target: "src/lib/orchestrator/fileReadCache.ts",
      detail: "FILE_UNCHANGED_STUB: previous duplicate",
    })),
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    minCachedReadOnlyActivities: 1,
    minRepeatedReadOnlyTargetScore: 1,
  });
  assert.equal(decision.shouldRecover, false, "fresh source wins over earlier cached reads");
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
  assert.match(toolCallPlanningSource, /resolveExecuteRecoveryActionContract\(executeRecoveryMode/);
  assert.match(toolCallPlanningSource, /const effectiveExecuteRecoveryFileRead = recoveryActionContract\.allowTargetedFileRead/);
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

test("a narrowed overlap counts as semantic repetition without blocking a later distinct window", () => {
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

  assert.equal(decision.shouldRecover, false);
  assert.equal(decision.reason, "");
  assert.equal(decision.repeatedReadOnlyTargetScore, 2);
});

test("execute recovery allows many distinct windows even past count and character thresholds", () => {
  const recent = Array.from({ length: 8 }, (_value, index) => ({
    name: "read_file",
    status: "succeeded",
    target: "src/main.js",
    detail: `READ_FILE_RESULT lines ${index * 100 + 1}-${(index + 1) * 100}`,
  }));
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{
      name: "read_file",
      target: "src/main.js",
      content: `READ_FILE_RESULT lines 701-800\n${"source\n".repeat(6_000)}`,
      isError: false,
    }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 4,
    minReadOnlyActivities: 2,
    maxReadOnlyToolChars: 100,
    minRepeatedReadOnlyTargetScore: 1,
    minCachedReadOnlyActivities: 1,
  });

  assert.equal(decision.readOnlyActivityCount, 8);
  assert.equal(decision.batchToolChars > 100, true);
  assert.equal(decision.repeatedReadOnlyTargetScore, 0);
  assert.equal(decision.shouldRecover, false);
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
