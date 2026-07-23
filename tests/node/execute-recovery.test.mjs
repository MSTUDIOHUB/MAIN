import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function createLocalRuntimeConfig(workspace = "/workspace") {
  return {
    activeProfile: "local",
    local: { provider: "test", model: "test" },
    workspace,
  };
}

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
  buildFailedValidationRepairReadLease,
  buildFailedFiniteValidationRecoveryPrompt,
  classifyFailedFiniteValidationOutcome,
  compactStructuredCommandResult,
  buildExecuteRecoveryPrompt,
  buildExecuteValidationRecoveryPrompt,
  buildExecutePatchMismatchFingerprint,
  buildExecutionActionContractCard,
  buildPatchRecoveryReadNoProgressFingerprint,
  failedFiniteValidationMatchesPendingPlanEvidence,
  hasPendingPlanCommandEvidence,
  isExecutePatchMismatchRecoveryActivity,
  isExecuteRecoveryToolName,
  isReadOnlyNoProgressDetail,
  normalizeExecutionDecisionCheckpointSnapshot,
  patchRecoveryLeaseIdentityMatches,
  readEvidenceSatisfiesRecoveryLease,
  resolveExecuteRecoveryActionContract,
  resolveExecuteRecoveryBatchDecision,
  resolveExecuteReadOnlyRecoveryTrigger,
  resolveFailedFiniteValidationRecoveryPolicy,
  resolveReadOnlyNoProgressTrigger,
  shouldEnterFailedFiniteValidationRecovery,
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
  buildExecuteConvergencePrompt,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/prompts/executePrompts.ts"));

const {
  compactContextForExecuteRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/contextTrim.ts"));

const {
  handleExecuteNoToolRecovery,
  isExecuteRuntimeRequiringEvidence,
  resolveExecuteNoToolCheckpointLimit,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeNoToolRecovery.ts"));
const {
  MAX_VALIDATION_MUTATION_REOPENS,
  objectiveAuditHasCurrentClosureEvidence,
  resolveValidationMutationReopenTargetBinding,
  resolveValidationMutationReopen,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantCompletionPhase.ts"));

const {
  handleMaxIterationBoundary,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/maxIterationBoundary.ts"));
const {
  CHAT_MAX_AUTO_RESUME_LIMIT,
  PLAN_MAX_AUTO_RESUME_LIMIT,
  buildChatMaxIterationsResumePrompt,
  resolveChatMaxIterationStrategyPivot,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionRecovery.ts"));
const {
  hasDurableExecutionProgress,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/verificationEvidence.ts"));

const {
  resolveIterationToolSurface,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"));

const {
  handleNoProgressRecovery,
  resolveDirectMutationPreflightRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"));
const {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/repetitionGuard.ts"));
const {
  buildBrowserValidationCacheSignature,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/browserValidation.ts"));

const {
  findDelegatedObservationRequiringParentReread,
  normalizeFiniteValidationCheckpointCommand,
  objectiveAuditTargetsMissingReadObservation,
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
  resolveWorkspaceMutationCreateOnlyTargets,
  resolveWorkspaceMutationCreationTargets,
  resolveWorkspaceMutationTargets,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workspaceMutationTools.ts"));

const {
  buildExecuteRecoverySourceContextMessage,
  resolveRecoverySourceContextFreshness,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/contextManagement.ts"));

const {
  activateExecuteRecoveryRuntimeState,
  advanceExecuteRecoveryRuntimeIteration,
  createExecuteRecoveryRuntimeState,
  pinExecuteRecoveryFiniteValidationCheckpoint,
  shouldPinExecuteRecoveryFiniteValidationCheckpoint,
  transitionExecuteRecoveryRuntimeState,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"));

const {
  createAgentLoopRuntimeActions,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRuntimeActions.ts"));

const {
  isFiniteValidationRecoveryExecution,
  resolveApprovedPlanMutationContextDecision,
  resolveFiniteValidationRepairTarget,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultRecoveryPhase.ts"));

const subagents = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/subagents.ts"));
const preferredScopes = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/preferredDelegationScopes.ts"));

const {
  buildReadOnlyCacheSignature,
  getToolTarget,
  probeFileMetadataAvailability,
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
  const input = {
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
    executeRecoveryState: {
      mode: "normal",
      reason: "",
      expectedTarget: null,
      attempts: 0,
      iterationCount: 0,
    },
    readOnlyResultCache: new Map(),
    readOnlyDuplicateSkipCounts: new Map(),
    fileReadStates: new Map(),
    browserValidationCache: new Map(),
    iterationContext: { eventThreadId: "thread", eventTurnId: "turn" },
    emitTurnEvent: () => {},
    ...overrides,
  };
  return {
    ...input,
    recoveryActionContract: overrides.recoveryActionContract ||
      resolveExecuteRecoveryActionContract(input.executeRecoveryState.mode, input.executeRecoveryState),
  };
}

function createExecuteNoToolHarness(language = "en") {
  const appended = [];
  const statuses = [];
  const streamTokens = [];
  const stops = [];
  const protocolFallbacks = [];
  return {
    appended,
    statuses,
    streamTokens,
    stops,
    protocolFallbacks,
    callbacks: {
      getPreferredLanguage: () => language,
      appendMessage: (message) => appended.push(message),
      onStatusChange: (status) => statuses.push(status),
      onStreamToken: (token, id) => streamTokens.push({ token, id }),
      onNonActionableStop: (message, reason, progress) => stops.push({ message, reason, progress }),
      onProviderCompatibilityFallback: (reason) => protocolFallbacks.push(reason),
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

test("execute no-tool recovery does not classify assistant prose or synthesize a user turn", () => {
  const proseSamples = [
    "I have completed the requested changes and verified them.",
    "已经修复完成并验证通过。",
    "Implementation Plan\n1. Modify src/App.tsx.\n2. Run the tests. ".repeat(12),
    "修复方案：修改 src/App.tsx，然后运行测试。".repeat(20),
  ];

  for (const visibleText of proseSamples) {
    const harness = createExecuteNoToolHarness("en");
    const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness, {
      visibleText,
      consecutiveNoToolCount: 4,
    }));

    assert.equal(result.status, "none");
    assert.equal(result.consecutiveNoToolCount, 4);
    assert.deepEqual(harness.statuses, []);
    assert.deepEqual(harness.streamTokens, []);
    assert.deepEqual(harness.appended, []);
    assert.deepEqual(harness.stops, []);
  }
});

test("ordinary chat max-iteration boundary synthesizes, then uses one bounded alternative", async () => {
  const order = [];
  const checkpoints = [];
  let autoResumeCount = 0;
  const runBoundary = async () => handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => autoResumeCount,
      onChatMaxIterationsCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
        if (!checkpoint.autoResumeEligible) return false;
        autoResumeCount += 1;
        return {
          status: "auto_resume_scheduled",
          checkpoint: { ...checkpoint, autoResumeCount },
        };
      },
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
    lastAssistantTextForCheckpoint: "retained partial answer",
    sawExecuteOperationEvidence: false,
    executeRecoveryMode: "off",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: (reason) => order.push(`run:paused:${reason}`),
  });

  await runBoundary();
  await runBoundary();
  await runBoundary();

  assert.equal(CHAT_MAX_AUTO_RESUME_LIMIT, 2);
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.strategyPivot), [
    "synthesize_completion",
    "bounded_alternative",
    null,
  ]);
  assert.deepEqual(order, [
    "run:paused:max_iterations_auto_resume",
    "status:idle",
    "run:paused:max_iterations_auto_resume",
    "status:idle",
    "run:paused:max_iterations_boundary",
    "stop:no_action:max_iterations_boundary",
    "status:idle",
  ]);

  const synthesisPrompt = buildChatMaxIterationsResumePrompt({
    language: "en",
    runtimeIntent: "respond",
    checkpoint: { ...checkpoints[0], autoResumeCount: 1 },
  });
  assert.match(synthesisPrompt, /Make no tool calls/);
  assert.match(synthesisPrompt, /originalRuntimeIntent: respond/);
  assert.doesNotMatch(synthesisPrompt, /produces mutation or validation evidence/i);
  const alternative = resolveChatMaxIterationStrategyPivot({ autoResumeCount: 1 });
  assert.equal(alternative.selected, "bounded_alternative");
});

test("subagent max-iteration boundary returns a partial handoff instead of scheduling continuation", async () => {
  const summaries = [];
  const finals = [];
  const stops = [];
  const paused = [];
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getSubagentDepth: () => 1,
      onTurnSummaryReady: (summary) => summaries.push(summary),
      onAssistantFinalText: (text) => finals.push(text),
      onNonActionableStop: (_message, _reason, progress) => stops.push(progress),
      onStatusChange: () => {},
    },
    workflowMode: "chat",
    runtimeIntent: "analyze",
    effectiveMaxIterations: 6,
    recentPlanToolActivity: [],
    recentToolActivity: [{
      name: "read_file",
      target: "src/App.tsx",
      status: "succeeded",
    }],
    lastAssistantTextForCheckpoint: "The handler delegates to the editor store.",
    sawExecuteOperationEvidence: false,
    executeRecoveryMode: "off",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: (reason) => paused.push(reason),
  });

  assert.equal(summaries.length, 1);
  assert.equal(finals.length, 1);
  assert.match(summaries[0], /partial handoff/i);
  assert.match(summaries[0], /src\/App\.tsx/);
  assert.equal(stops[0]?.recoveryReason, "subagent_max_iterations_partial_handoff");
  assert.deepEqual(paused, ["subagent_max_iterations_partial_handoff"]);
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
      getPlanExecutionEvidenceLedger: () => [{
        id: "mutation-1",
        transactionId: "turn-1",
        kind: "file",
        value: "src/App.tsx",
        target: "src/App.tsx",
        sourceTool: "apply_patch",
        createdAt: 1,
      }],
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
    transactionId: "turn-1",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: (reason, message) => pausedRuns.push({ reason, message }),
  });

  assert.equal(autoResumeCount, 0);
  assert.deepEqual(stops, []);
  assert.deepEqual(statuses, ["idle"]);
  assert.equal(pausedRuns[0].reason, "max_iterations_auto_resume");
  assert.match(pausedRuns[0].message, /switched to differentiated strategy 1\/3/);
  assert.match(pausedRuns[0].message, /validation capability/);
});

test("successful MCP source edits count as durable max-iteration progress", async () => {
  let checkpoint;
  const stops = [];
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => 0,
      getPlanExecutionEvidenceLedger: () => [{
        id: "mutation-1",
        transactionId: "turn-1",
        kind: "file",
        value: "Assets/Scripts/PlayerController.cs",
        target: "Assets/Scripts/PlayerController.cs",
        sourceTool: "script_apply_edits",
        createdAt: 1,
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
      name: "script_apply_edits",
      target: "Assets/Scripts/PlayerController.cs",
      status: "succeeded",
      detail: "applied one source edit",
    }],
    lastAssistantTextForCheckpoint: "still working",
    sawExecuteOperationEvidence: true,
    executeRecoveryMode: "normal",
    transactionId: "turn-1",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(checkpoint?.autoResumeEligible, true);
  assert.equal(stops.length, 0);
});

test("max-iteration boundary offers a structured pivot despite non-durable observations", async () => {
  let checkpoint;
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => 0,
      getPlanExecutionEvidenceLedger: () => [
        { id: "old", transactionId: "old-turn", kind: "file", value: "src/App.tsx", sourceTool: "apply_patch", createdAt: 1 },
        { id: "failed", transactionId: "turn-1", kind: "file", value: "src/App.tsx", sourceTool: "apply_patch", observationStatus: "failed", createdAt: 2 },
        { id: "stub", transactionId: "turn-1", kind: "tool", value: "src/App.tsx", sourceTool: "read_file", createdAt: 3 },
      ],
      onExecuteMaxIterationsCheckpoint: (value) => {
        checkpoint = value;
        return false;
      },
      onNonActionableStop: () => {},
      onStatusChange: () => {},
    },
    workflowMode: "edit",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: [],
    recentToolActivity: [{ name: "apply_patch", target: "src/App.tsx", status: "succeeded", detail: "changed" }],
    lastAssistantTextForCheckpoint: "still working",
    sawExecuteOperationEvidence: true,
    executeRecoveryMode: "normal",
    transactionId: "turn-1",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(checkpoint?.autoResumeEligible, true);
  assert.equal(checkpoint?.strategyPivot, "continue_contract");
});

test("durable progress accepts structured finite-command and browser evidence", () => {
  const entries = [
    { id: "cmd", kind: "cmd", value: "npm test", sourceTool: "run_command" },
    { id: "browser", kind: "browser_dom", value: "http://localhost:1420", sourceTool: "browser_evaluate" },
  ];
  for (const entry of entries) {
    assert.equal(hasDurableExecutionProgress({
      ledger: [{ ...entry, transactionId: "turn-1", createdAt: 1 }],
      transactionId: "turn-1",
      recoveryActionContract: { ptyGeneration: null },
    }), true);
  }
});

test("an unrelated shell inspection cannot block the first differentiated pivot", async () => {
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

  assert.equal(checkpoint?.autoResumeEligible, true);
  assert.equal(checkpoint?.strategyPivot, "continue_contract");
  assert.equal(stops.length, 0);
});

test("a browser readiness failure pivots to the structured contract before pausing", async () => {
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

  assert.equal(checkpoint?.autoResumeEligible, true);
  assert.equal(checkpoint?.strategyPivot, "continue_contract");
  assert.equal(stops.length, 0);
});

test("approved Plan provenance selects its checkpoint in the canonical execute workflow", async () => {
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
    workflowMode: "edit",
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

  assert.equal(observedCheckpoint?.autoResumeEligible, true);
  assert.equal(observedCheckpoint?.strategyPivot, "continue_contract");
  assert.equal(pausedRuns[0]?.reason, "max_iterations_auto_resume");
  assert.equal(stops.length, 0);
  assert.match(pausedRuns[0]?.message || "", /differentiated strategy/i);
});

test("pending PTY polling pivots once instead of forcing an arbitrary pause", async () => {
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

  assert.equal(checkpoint?.autoResumeEligible, true);
  assert.equal(checkpoint?.strategyPivot, "continue_contract");
  assert.equal(stops.length, 0);
});

test("max-iteration differentiated pivots retain a hard no-progress fuse", async () => {
  let checkpoint;
  const stops = [];
  let callbackCalls = 0;
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      getPlanAutoResumeCount: () => PLAN_MAX_AUTO_RESUME_LIMIT,
      getPlanExecutionEvidenceLedger: () => [],
      onExecuteMaxIterationsCheckpoint: (value) => {
        callbackCalls += 1;
        checkpoint = value;
        return false;
      },
      onNonActionableStop: (...args) => stops.push(args),
      onStatusChange: () => {},
    },
    workflowMode: "edit",
    runtimeIntent: "execute",
    effectiveMaxIterations: 50,
    recentPlanToolActivity: [],
    recentToolActivity: [],
    lastAssistantTextForCheckpoint: "still unfinished",
    sawExecuteOperationEvidence: false,
    executeRecoveryMode: "normal",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(callbackCalls, 1);
  assert.equal(checkpoint?.autoResumeEligible, false);
  assert.equal(checkpoint?.strategyPivot, null);
  assert.deepEqual(checkpoint?.attemptedStrategyPivots, [
    "continue_contract",
    "reconcile_evidence",
    "bounded_alternative",
  ]);
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
      getPlanExecutionEvidenceLedger: () => [
        {
          id: "launch",
          transactionId: "turn-1",
          kind: "cmd",
          value: "npm run dev",
          target: "npm run dev",
          sourceTool: "execute_command",
          observationStatus: "running",
          foregroundGeneration: 7,
          createdAt: 1,
        },
        {
          id: "ready-observation",
          transactionId: "turn-1",
          kind: "dev_server_url",
          value: "http://127.0.0.1:1420",
          target: "terminal status",
          sourceTool: "get_pty_status",
          observationStatus: "ready",
          foregroundGeneration: 7,
          createdAt: 2,
        },
      ],
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
    transactionId: "turn-1",
    emitPlanExecutionProgress: () => {},
    emitRunPausedEvent: () => {},
  });

  assert.equal(checkpoint?.autoResumeEligible, true);
  assert.equal(stops.length, 0);
});

test("assistant wording cannot consume the required-tool protocol retry budget", () => {
  const harness = createExecuteNoToolHarness("zh");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness, {
    activeProfile: "local",
    consecutiveNoToolCount: 4,
    visibleText: "已经修复完成并验证通过。",
  }));

  assert.equal(resolveExecuteNoToolCheckpointLimit("local"), 2);
  assert.equal(resolveExecuteNoToolCheckpointLimit("cloud"), 2);
  assert.equal(result.status, "none");
  assert.equal(result.consecutiveNoToolCount, 4);
  assert.deepEqual(harness.statuses, []);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.stops.length, 0);
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
    workflowMode: "edit",
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

test("named-tool mismatches are quarantined and reprompt the exact runtime contract", () => {
  const harness = createExecuteNoToolHarness("en");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness, {
    protocolViolation: "required_function_call_mismatch",
    visibleText: "I will read the file again before editing.",
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /specific function/);
  assert.match(harness.appended[0].content, /mismatched call was not executed/);
  assert.match(harness.appended[0].content, /exactly the named tool/);
});

test("execute protocol no-action exhausts provider-neutral strategy pivots before pausing", () => {
  const firstHarness = createExecuteNoToolHarness("en");
  const first = handleExecuteNoToolRecovery(createExecuteNoToolInput(firstHarness, {
    activeProfile: "local",
    consecutiveNoToolCount: 1,
    protocolViolation: "required_tool_call_missing",
  }));
  assert.equal(first.status, "continue");
  assert.equal(first.consecutiveNoToolCount, 2);
  assert.match(firstHarness.appended.at(-1)?.content || "", /current_task_action_lock/);
  assert.equal(firstHarness.stops.length, 0);

  const secondHarness = createExecuteNoToolHarness("en");
  const second = handleExecuteNoToolRecovery(createExecuteNoToolInput(secondHarness, {
    activeProfile: "cloud",
    consecutiveNoToolCount: 2,
    protocolViolation: "required_tool_call_missing",
  }));
  assert.equal(second.status, "continue");
  assert.match(secondHarness.appended.at(-1)?.content || "", /alternate_capability_reframe/);
  assert.deepEqual(
    secondHarness.protocolFallbacks,
    [],
    "a no-progress strategy may reframe the action but must not replace a working native tool transport",
  );

  const exhaustedHarness = createExecuteNoToolHarness("en");
  const exhausted = handleExecuteNoToolRecovery(createExecuteNoToolInput(exhaustedHarness, {
    consecutiveNoToolCount: 3,
    protocolViolation: "required_tool_call_missing",
  }));
  assert.equal(exhausted.status, "stopped");
  assert.equal(exhaustedHarness.stops.length, 1);
});

test("out-of-surface tool calls are quarantined as protocol recovery", () => {
  const harness = createExecuteNoToolHarness("en");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness, {
    protocolViolation: "required_tool_call_not_available",
    visibleText: "I will read the file again before editing.",
  }));

  assert.equal(result.status, "continue");
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /outside the active recovery surface/);
  assert.match(harness.appended[0].content, /was not executed/);
  assert.match(harness.appended[0].content, /actually exposed/);
});

test("active evidence recovery handles protocol violations without opening generic prose recovery", () => {
  const quietHarness = createExecuteNoToolHarness("en");
  const quiet = handleExecuteNoToolRecovery(createExecuteNoToolInput(quietHarness, {
    activeProfile: "local",
    forceXmlTools: true,
    protocolViolationOnly: true,
    visibleText: "I will inspect the source again.",
  }));
  assert.equal(quiet.status, "none");
  assert.deepEqual(quietHarness.appended, []);

  const violationHarness = createExecuteNoToolHarness("en");
  const violation = handleExecuteNoToolRecovery(createExecuteNoToolInput(violationHarness, {
    activeProfile: "local",
    forceXmlTools: true,
    protocolViolationOnly: true,
    protocolViolation: "required_tool_call_not_available",
    visibleText: "I will inspect the source again.",
  }));
  assert.equal(violation.status, "continue");
  assert.equal(violationHarness.appended.length, 1);
  assert.match(violationHarness.appended[0].content, /active recovery surface/);
});

test("execute recovery exposes only the capability owned by the current phase", () => {
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
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "mutation_first",
    allowFileRead: true,
  }), false, "legacy read hints cannot widen the mutation contract");
  assert.equal(isExecuteRecoveryToolName("grep_search", readOnlyTools, {
    mode: "mutation_first",
    allowFileRead: true,
  }), false);

  const convergencePrompt = buildExecuteConvergencePrompt("en", 12, 16);
  assert.match(convergencePrompt, /retaining targeted read_file/);
  assert.match(convergencePrompt, /same active version\/window returns a stub, move to the next real action/);
  assert.doesNotMatch(convergencePrompt, /read_file (?:is )?(?:unavailable|not available|disabled)/i);
});

test("execute recovery admits apply_patch path= headers as the expected canonical target", () => {
  const target = getToolTarget("apply_patch", {
    patch: [
      "*** Begin Patch",
      "*** Update File: path=src/main.js",
      "@@",
      "-const ready = false;",
      "+const ready = true;",
      "*** End Patch",
    ].join("\n"),
  });
  assert.equal(target, "src/main.js");

  const decision = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [{ id: "patch-main", name: "apply_patch", target }],
    expectedTarget: "src/main.js",
  });
  assert.equal(decision.selectedCallId, "patch-main");
  assert.deepEqual(decision.deferredCallIds, []);
});

test("one recovery contract atomically advances long-running validation from PTY observation to browser", () => {
  const targeting = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    expectedTarget: "src/main.js",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "head-v1",
      nextRequiredCapability: "targeting",
      evidenceVersion: "9000:100",
    },
  });
  assert.equal(targeting.phase, "context");
  assert.equal(targeting.nextRequiredCapability, "targeting");
  assert.equal(targeting.surfaceDescription, "capability:targeting");
  assert.equal(targeting.allowedToolNames.has("code_ast_query"), true);
  assert.equal(targeting.allowedToolNames.has("find_symbol_references"), true);
  assert.equal(targeting.allowedToolNames.has("read_file"), true);
  assert.equal(targeting.allowedToolNames.has("apply_patch"), false);
  const targetingBatch = resolveExecuteRecoveryBatchDecision({
    mode: "action_plus_targeting",
    expectedTarget: "src/main.js",
    contract: targeting,
    calls: [
      { id: "reread", name: "read_file", target: "src/main.js" },
      { id: "ast", name: "code_ast_query", target: "src/main.js" },
      { id: "premature-edit", name: "apply_patch", target: "src/main.js" },
    ],
  });
  assert.equal(targetingBatch.selectedCallId, "ast");
  assert.deepEqual(targetingBatch.deferredCallIds, ["reread", "premature-edit"]);

  const migratedLegacyPostMutation = resolveExecuteRecoveryActionContract("validation_only", {
    readLease: {
      purpose: "post_mutation_verify",
      target: "src/App.tsx",
      state: "available",
    },
    devServerStatus: "ready",
    devServerNextCapability: "browser",
  });
  assert.equal(migratedLegacyPostMutation.phase, "validation");
  assert.equal(migratedLegacyPostMutation.nextRequiredCapability, "browser_validation");
  assert.equal(migratedLegacyPostMutation.readLease, null);

  const pending = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    devServerStatus: "running",
    devServerNextCapability: "observe_pty",
    ptyGeneration: 4,
    ptyOutputSequence: 12,
  });
  assert.equal(pending.phase, "validation");
  assert.equal(pending.nextRequiredCapability, "observe_pty");
  assert.equal(pending.surfaceDescription, "capability:observe_pty");
  assert.equal(pending.ptyGeneration, 4);
  assert.equal(pending.allowedToolNames.has("get_pty_status"), true);
  assert.equal(pending.allowedToolNames.has("read_pty_tail"), true);
  assert.equal(pending.allowedToolNames.has("send_pty_input"), false);
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
  const pendingWrongOnly = resolveExecuteRecoveryBatchDecision({
    mode: "action_plus_targeting",
    contract: pending,
    calls: [{ id: "restart-while-running", name: "execute_command", target: "npm run dev" }],
  });
  assert.equal(pendingWrongOnly.selectedCallId, null);
  assert.deepEqual(pendingWrongOnly.deferredCallIds, ["restart-while-running"]);

  const observationBatch = resolveExecuteRecoveryBatchDecision({
    mode: "action_plus_targeting",
    contract: pending,
    calls: [
      { id: "answer-prompt", name: "send_pty_input", target: "y" },
      { id: "tail-after-input", name: "read_pty_tail", target: "terminal tail" },
    ],
  });
  assert.equal(observationBatch.selectedCallId, "tail-after-input");

  const ready = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    devServerStatus: "ready",
    devServerNextCapability: "browser",
    devServerUrl: "http://localhost:1420/",
    ptyGeneration: 4,
    ptyOutputSequence: 16,
  });
  assert.equal(ready.phase, "validation");
  assert.equal(ready.nextRequiredCapability, "browser_validation");
  assert.equal(ready.surfaceDescription, "capability:browser_validation");
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
  const readyWrongOnly = resolveExecuteRecoveryBatchDecision({
    mode: "action_plus_targeting",
    contract: ready,
    calls: [{ id: "observe-after-ready", name: "get_pty_status", target: "terminal status" }],
  });
  assert.equal(readyWrongOnly.selectedCallId, null);
  assert.deepEqual(readyWrongOnly.deferredCallIds, ["observe-after-ready"]);

  const launch = resolveExecuteRecoveryActionContract("validation_only", {
    decisionCheckpoint: {
      expectedTarget: "src/App.tsx",
      sourceObservationKey: "src/App.tsx::v2",
      nextRequiredCapability: "launch_long_process",
    },
    devServerStatus: "none",
  });
  const launchWrongOnly = resolveExecuteRecoveryBatchDecision({
    mode: "validation_only",
    contract: launch,
    calls: [{ id: "finite-instead-of-launch", name: "run_command", target: "npm test" }],
  });
  assert.equal(launchWrongOnly.selectedCallId, null);

  const browserWithoutServer = resolveExecuteRecoveryActionContract("validation_only", {
    decisionCheckpoint: {
      expectedTarget: null,
      sourceObservationKey: null,
      nextRequiredCapability: "browser_validation",
    },
    devServerStatus: "none",
    devServerNextCapability: "launch",
  });
  assert.equal(browserWithoutServer.nextRequiredCapability, "launch_long_process");
  assert.equal(browserWithoutServer.allowedToolNames.has("execute_command"), true);
  assert.equal(browserWithoutServer.allowedToolNames.has("browser_evaluate"), false);

  const finiteValidationWithAmbientServer = resolveExecuteRecoveryActionContract("validation_only", {
    decisionCheckpoint: {
      expectedTarget: null,
      sourceObservationKey: null,
      nextRequiredCapability: "validation",
    },
    devServerStatus: "ready",
    devServerNextCapability: "browser",
  });
  assert.equal(finiteValidationWithAmbientServer.nextRequiredCapability, "validation");
  assert.equal(finiteValidationWithAmbientServer.allowedToolNames.has("run_command"), true);
  assert.equal(finiteValidationWithAmbientServer.allowedToolNames.has("browser_evaluate"), false);

  const failed = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    expectedTarget: "src/App.tsx",
    devServerStatus: "failed",
    devServerNextCapability: "launch",
  });
  assert.equal(failed.phase, "reconcile");
  assert.equal(failed.nextRequiredCapability, "recover_process");
  assert.equal(failed.surfaceDescription, "capability:recover_process");
  assert.equal(failed.allowTargetedFileRead, false);
  for (const name of [
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
    "execute_command",
  ]) {
    assert.equal(failed.allowedToolNames.has(name), true, `${name} should remain available after failure`);
  }
  for (const name of ["read_file", "apply_patch", "run_command", "send_pty_input", "browser_evaluate"]) {
    assert.equal(failed.allowedToolNames.has(name), false, `${name} must stay outside process recovery`);
  }
  const stopped = resolveExecuteRecoveryActionContract("validation_only", {
    expectedTarget: "src/App.tsx",
    devServerStatus: "stopped",
    devServerNextCapability: "launch",
  });
  assert.equal(stopped.nextRequiredCapability, "recover_process");
  assert.equal(stopped.allowedToolNames.has("read_pty_tail"), true);
  assert.equal(stopped.allowedToolNames.has("run_command"), false);
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
  const unrelatedReconcileCommand = resolveExecuteRecoveryBatchDecision({
    mode: "validation_only",
    contract: portConflict,
    calls: [{ id: "unrelated-test", name: "run_command", target: "npm test" }],
  });
  assert.equal(unrelatedReconcileCommand.selectedCallId, null);
  assert.deepEqual(unrelatedReconcileCommand.deferredCallIds, ["unrelated-test"]);
  const healthProbe = resolveExecuteRecoveryBatchDecision({
    mode: "validation_only",
    contract: portConflict,
    calls: [{
      id: "health-probe",
      name: "run_command",
      target: "curl -sS http://localhost:1420/",
    }],
  });
  assert.equal(healthProbe.selectedCallId, "health-probe");

  const card = buildExecutionActionContractCard({ contract: targeting, language: "en" });
  assert.match(card, /availableTools=/);
  assert.match(card, /same file version and covered window returns a cache stub/i);
  assert.match(card, /next=targeting/);

  const filteredCard = buildExecutionActionContractCard({
    contract: targeting,
    language: "en",
    availableToolNames: ["apply_patch"],
  });
  assert.match(filteredCard, /availableTools=apply_patch/);
  assert.match(filteredCard, /read_file is unavailable now/);

  const browserCard = buildExecutionActionContractCard({
    contract: ready,
    language: "en",
  });
  assert.match(browserCard, /next=browser_validation/);
  assert.doesNotMatch(browserCard, /sourceObservation|read_file|source reread/i);
});

test("a short cached-read streak does not create a second special recovery path", () => {
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
    tracking: {
      lastNoProgressBatchSignature: "",
      noProgressBatchRepeatCount: 0,
      consecutiveReadFileOnlyCacheHits: 2,
    },
    activateExecuteRecovery: (mode, reason, context) => {
      activations.push({ mode, reason, context });
      return activateExecuteRecoveryRuntimeState(
        createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
        {
          mode,
          reason,
          expectedTarget: context?.target || context?.repeatedTargets?.[0] || null,
        },
      );
    },
    activateChatFinalSynthesis: () => {},
    emitTaskOrchestratorPhase: () => {},
  });

  assert.equal(result.status, "none");
  assert.deepEqual(activations, []);
  assert.equal(result.pendingExecuteRecoveryPrompt, null);
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
    executeRecoveryState: {
      mode: "mutation_first",
      reason: "read_file_only_loop",
      expectedTarget: "src/App.tsx",
      attempts: 1,
      iterationCount: 1,
    },
    recoveryActionContract: resolveExecuteRecoveryActionContract("mutation_first", {
      expectedTarget: "src/App.tsx",
    }),
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

test("repeated real failures become internal policy feedback instead of another tool failure", async () => {
  const toolErrors = [];
  const toolDone = [];
  const args = { path: ".missing" };
  const failureSignature = buildRepeatLoopSignature(
    "list_directory",
    buildRepeatLoopArgsKey(args),
  );
  const input = createReadFilePartitionInput({
    toolCalls: [{
      id: "repeated-missing-directory",
      name: "list_directory",
      arguments: JSON.stringify(args),
    }],
    availableToolNames: new Set(["list_directory"]),
    failedToolCallCounts: new Map([[failureSignature, 2]]),
  });
  input.callbacks = {
    ...input.callbacks,
    onToolError: (...values) => toolErrors.push(values),
    onToolDone: (...values) => toolDone.push(values),
  };

  const result = await partitionToolCallsForExecution(input);
  assert.equal(result.readOnlyCalls.length, 0);
  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].isError, false);
  assert.equal(result.preExecutionResults[0].internalFeedback, true);
  assert.equal(result.preExecutionResults[0].qualityGateReason, "repeated_failure_blocked");
  assert.equal(input.failedToolCallCounts.get(failureSignature), 3);
  assert.equal(result.toolFailureSignatures.has("repeated-missing-directory"), false);
  assert.equal(toolErrors.length, 0);
  assert.equal(toolDone.length, 1);
  assert.equal(toolDone[0][3].internalFeedback, true);

  const exhausted = await partitionToolCallsForExecution({
    ...input,
    toolCalls: [{
      id: "repeated-missing-directory-again",
      name: "list_directory",
      arguments: JSON.stringify(args),
    }],
  });
  assert.equal(exhausted.preExecutionResults[0].qualityGateReason, "repeated_failure_exhausted");
});

test("approved Plan execution rejects an unreviewed compound shell mutation before dispatch", async () => {
  const registry = {
    tools: {
      run_command: {
        key: "run_command",
        name: "run_command",
        source: "built_in",
        category: "shell",
        risk: "shell",
        enabled: true,
        autoExecutable: false,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const input = createReadFilePartitionInput({
    toolCalls: [{
      id: "compound-write",
      name: "run_command",
      arguments: JSON.stringify({ command: "npm test; touch src/unplanned.ts" }),
    }],
    workflowMode: "plan",
    planRuntimePhase: "executing",
    availableToolNames: new Set(["run_command"]),
    toolCapabilityRegistry: registry,
  });
  input.callbacks = {
    ...input.callbacks,
    getAutoApproveToolScopes: () => ["shell"],
    getIsPlanApproved: () => true,
    getPlanStage: () => "executing",
    getPlanTasks: () => [{
      id: "edit-app",
      text: "Edit src/App.tsx and run the reviewed test",
      status: "pending",
      executionKind: "mutation",
      evidence: [
        { kind: "file", value: "src/App.tsx" },
        { kind: "cmd", value: "npm test" },
      ],
    }],
  };

  const result = await partitionToolCallsForExecution(input);
  assert.equal(result.writeCalls.length, 0);
  assert.equal(result.readOnlyCalls.length, 0);
  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].isError, false);
  assert.equal(result.preExecutionResults[0].internalFeedback, true);
  assert.equal(
    result.preExecutionResults[0].qualityGateReason,
    "approved_plan_command_scope_deferred",
  );
  assert.equal(result.toolFailureSignatures.size, 0);
});

test("recovery contract can lease one bounded validation command absent from Plan evidence", async () => {
  const registry = {
    tools: {
      run_command: {
        key: "run_command",
        name: "run_command",
        source: "built_in",
        category: "shell",
        risk: "shell",
        enabled: true,
        autoExecutable: false,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const executeRecoveryState = {
    mode: "finite_validation_only",
    reason: "validation_after_mutation_required",
    expectedTarget: "src/App.tsx",
    attempts: 1,
    iterationCount: 1,
  };
  const input = createReadFilePartitionInput({
    toolCalls: [{
      id: "runtime-validation",
      name: "run_command",
      arguments: JSON.stringify({ command: "npm test", cwd: ".", description: "Run tests" }),
    }],
    workflowMode: "plan",
    planRuntimePhase: "executing",
    availableToolNames: new Set(["run_command"]),
    toolCapabilityRegistry: registry,
    executeRecoveryState,
    recoveryActionContract: resolveExecuteRecoveryActionContract(
      "finite_validation_only",
      executeRecoveryState,
    ),
  });
  input.callbacks = {
    ...input.callbacks,
    getAutoApproveToolScopes: () => ["shell"],
    getIsPlanApproved: () => true,
    getPlanStage: () => "executing",
    getPlanTasks: () => [{
      id: "edit-app",
      text: "Edit src/App.tsx",
      status: "pending",
      executionKind: "mutation",
      evidence: [{ kind: "file", value: "src/App.tsx" }],
    }],
  };

  const result = await partitionToolCallsForExecution(input);
  assert.equal(result.preExecutionResults.length, 0);
  assert.equal(result.writeCalls.length, 1);
});

test("browser lifecycle leases one safe dev-server launch without opening approved Plan shell scope", async () => {
  const registry = {
    tools: {
      execute_command: {
        key: "execute_command",
        name: "execute_command",
        source: "built_in",
        category: "shell",
        risk: "shell",
        enabled: true,
        autoExecutable: false,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const checkpoint = {
    expectedTarget: null,
    sourceObservationKey: null,
    nextRequiredCapability: "browser_validation",
  };
  const contract = resolveExecuteRecoveryActionContract("validation_only", {
    decisionCheckpoint: checkpoint,
    devServerStatus: "none",
    devServerNextCapability: "launch",
  });
  const run = async (command, evidence = [{ kind: "browser_dom", value: "browser interaction: click New", requiresInteraction: true }]) => {
    const executeRecoveryState = {
      mode: "validation_only",
      reason: "approved_plan_browser_handoff",
      expectedTarget: null,
      attempts: 1,
      iterationCount: 1,
      decisionCheckpoint: checkpoint,
    };
    const input = createReadFilePartitionInput({
      toolCalls: [{
        id: `launch-${command}`,
        name: "execute_command",
        arguments: JSON.stringify({ command, cwd: ".", description: "Start the local development server" }),
      }],
      workflowMode: "plan",
      planRuntimePhase: "executing",
      availableToolNames: new Set(["execute_command"]),
      toolCapabilityRegistry: registry,
      executeRecoveryState,
      recoveryActionContract: contract,
    });
    input.callbacks = {
      ...input.callbacks,
      getAutoApproveToolScopes: () => ["shell"],
      getIsPlanApproved: () => true,
      getPlanStage: () => "executing",
      getPlanTasks: () => [{
        id: "browser-check",
        text: "Click New and assert that the empty editor is visible",
        status: "pending",
        executionKind: "validation",
        evidence,
      }],
    };
    return partitionToolCallsForExecution(input);
  };

  const launch = await run("npm run dev");
  assert.equal(launch.preExecutionResults.length, 0);
  assert.equal(launch.writeCalls.length, 1);

  const compound = await run("npm run dev; touch src/unplanned.ts");
  assert.equal(compound.writeCalls.length, 0);
  assert.equal(compound.preExecutionResults[0]?.qualityGateReason, "approved_plan_command_scope_deferred");

  const reviewedAlternative = await run("npm run dev", [{ kind: "cmd", value: "npm run preview" }]);
  assert.equal(reviewedAlternative.writeCalls.length, 0);
  assert.equal(reviewedAlternative.preExecutionResults[0]?.qualityGateReason, "approved_plan_command_scope_deferred");
});

test("reconcile-server lease accepts only a health probe for the observed port", async () => {
  const registry = {
    tools: {
      run_command: {
        key: "run_command",
        name: "run_command",
        source: "built_in",
        category: "shell",
        risk: "shell",
        enabled: true,
        autoExecutable: false,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const contract = resolveExecuteRecoveryActionContract("validation_only", {
    devServerStatus: "failed",
    devServerNextCapability: "reconcile",
    devServerUrl: "http://localhost:1420/",
  });
  const buildInput = (command) => {
    const input = createReadFilePartitionInput({
      toolCalls: [{
        id: `probe-${command.includes("1420") ? "right" : "wrong"}`,
        name: "run_command",
        arguments: JSON.stringify({ command, cwd: ".", description: "Probe dev server" }),
      }],
      workflowMode: "plan",
      planRuntimePhase: "executing",
      availableToolNames: new Set(["run_command"]),
      toolCapabilityRegistry: registry,
      executeRecoveryState: {
        mode: "validation_only",
        reason: "dev_server_port_conflict",
        expectedTarget: null,
        attempts: 1,
        iterationCount: 1,
      },
      recoveryActionContract: contract,
    });
    input.callbacks = {
      ...input.callbacks,
      getAutoApproveToolScopes: () => ["shell"],
      getIsPlanApproved: () => true,
      getPlanStage: () => "executing",
      getPlanTasks: () => [{
        id: "start-server",
        text: "Start and validate the local server",
        status: "pending",
        evidence: [{ kind: "dev_server_url", value: "http://localhost:1420/" }],
      }],
    };
    return input;
  };

  const matching = await partitionToolCallsForExecution(buildInput("curl -sS http://localhost:1420/"));
  assert.equal(matching.preExecutionResults.length, 0);
  assert.equal(matching.writeCalls.length, 1);

  const wrongPort = await partitionToolCallsForExecution(buildInput("curl -sS http://localhost:9999/"));
  assert.equal(wrongPort.writeCalls.length, 0);
  assert.equal(wrongPort.preExecutionResults.length, 1);
});

test("read eligibility is decided from scope, exact version, window residency, and context epoch", () => {
  const base = {
    scopeMatches: true,
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

test("approved execution keeps returning an unchanged stub after the old third-read boundary", async () => {
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
  const duplicateCounts = new Map([[signature, 2]]);
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
  assert.doesNotMatch(active.preExecutionResults[0].content, /READ_FILE_REPEAT_LIMIT/);
  assert.match(active.preExecutionResults[0].content, /implementation|mutation|validation/i);
  assert.match(active.preExecutionResults[0].displayContent, /^FILE_UNCHANGED_STUB/);
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
    name: "apply_patch",
    target: "src/App.tsx",
    toolCallId: "built-in-apply-patch",
    catalogIdentity: { source: "built_in", canonicalName: "apply_patch" },
    content: "patched",
    isError: false,
  }, { patch: "*** Begin Patch\n*** Update File: src/App.tsx\n*** End Patch" }), true);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("delete_workspace_path", {
    name: "delete_workspace_path",
    target: "src/old.ts",
    toolCallId: "built-in-delete-path",
    catalogIdentity: { source: "built_in", canonicalName: "delete_workspace_path" },
    content: JSON.stringify({ success: true }),
    isError: false,
  }, { path: "src/old.ts" }), true);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("script_apply_edits", {
    content: "updated method",
    isError: false,
  }, { path: "Assets/Scripts", name: "Foo" }), false);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("script_apply_edits", {
    name: "script_apply_edits",
    target: "Assets/Scripts/Foo.cs",
    toolCallId: "verified-external-edit",
    content: "updated method",
    isError: false,
    executionAttempted: true,
    workspaceEffect: "verified",
    workspaceMutationEvidence: { changedPaths: ["Assets/Scripts/Foo.cs"] },
  }, { path: "Assets/Scripts", name: "Foo" }), true);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("manage_script", {
    content: "inspected script",
    isError: false,
  }, { action: "inspect", path: "Assets/Scripts", name: "Foo" }), false);
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("manage_script", {
    content: "created script",
    isError: false,
  }, { action: "create", path: "Assets/Scripts", name: "Foo" }), false);
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
  assert.equal(shouldAdvanceWorkspaceObservationEpoch("run_command", {
    name: "run_command",
    target: "build",
    toolCallId: "failed-after-invocation",
    content: JSON.stringify({ exitCode: 1 }),
    isError: true,
    lifecycleState: "failed",
    executionAttempted: true,
  }), true, "a failed shell may have changed files before exiting");
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

test("a persisted deterministic browser failure blocks only the exact cross-slice invocation", async () => {
  const originalArgs = {
    url: "https://example.com/",
    actions: [{ kind: "click", selector: "#open" }],
    checks: [{ kind: "text", value: "Opened" }],
  };
  const browserFailureCallSignature = buildBrowserValidationCacheSignature(originalArgs);
  const browserRegistry = {
    tools: {
      browser_evaluate: {
        key: "browser_evaluate",
        name: "browser_evaluate",
        source: "built_in",
        category: "browser",
        risk: "browser_control",
        enabled: true,
        autoExecutable: false,
      },
    },
    policy: partitionPermissionPolicy,
  };
  const executeRecoveryState = {
    mode: "action_plus_targeting",
    reason: "browser_validation_requires_diagnostic",
    expectedTarget: null,
    attempts: 1,
    iterationCount: 1,
    phaseNoProgressCount: 1,
    protocolNoProgressCount: 1,
    protocolNoProgressFingerprint: "browser-failure",
    readLease: null,
    sourceObservationKey: null,
    decisionCheckpoint: {
      expectedTarget: null,
      sourceObservationKey: null,
      nextRequiredCapability: "browser_diagnostic",
      browserFailureFingerprint: "browser-failure",
      browserFailureCallSignature,
      browserFailureDetail: "selector #open was not found",
      browserLocatorCandidates: ["#open-document"],
      browserRequestedUrl: originalArgs.url,
    },
  };
  const buildInput = (args) => createReadFilePartitionInput({
    toolCalls: [{
      id: `browser-${args.actions[0].selector}-${args.checks[0].value}`,
      name: "browser_evaluate",
      arguments: JSON.stringify(args),
    }],
    availableToolNames: new Set(["browser_evaluate"]),
    toolCapabilityRegistry: browserRegistry,
    toolPermissionPolicy: browserRegistry.policy,
    executeRecoveryState,
  });

  const exact = await partitionToolCallsForExecution(buildInput(originalArgs));
  assert.equal(exact.writeCalls.length, 0);
  assert.equal(exact.preExecutionResults.length, 1);
  assert.equal(exact.preExecutionResults[0].internalFeedback, true);
  assert.equal(
    exact.preExecutionResults[0].qualityGateReason,
    "browser_validation_persisted_failure_reused",
  );

  for (const nextRequiredCapability of ["targeted_read", "targeting", "mutation"]) {
    const stillUnchanged = await partitionToolCallsForExecution(createReadFilePartitionInput({
      ...buildInput(originalArgs),
      executeRecoveryState: {
        ...executeRecoveryState,
        decisionCheckpoint: {
          ...executeRecoveryState.decisionCheckpoint,
          nextRequiredCapability,
        },
      },
    }));
    assert.equal(stillUnchanged.writeCalls.length, 0, nextRequiredCapability);
    assert.equal(
      stillUnchanged.preExecutionResults[0]?.qualityGateReason,
      "browser_validation_persisted_failure_reused",
      `${nextRequiredCapability} alone must not release the unchanged browser invocation`,
    );
  }

  for (const correctedArgs of [
    {
      ...originalArgs,
      actions: [{ kind: "click", selector: "#open-document" }],
    },
    {
      ...originalArgs,
      actions: [{ kind: "fill", selector: "#open", value: "document.md" }],
    },
    {
      ...originalArgs,
      checks: [{ kind: "text", value: "Document opened" }],
    },
  ]) {
    const corrected = await partitionToolCallsForExecution(buildInput(correctedArgs));
    assert.equal(corrected.preExecutionResults.length, 0);
    assert.equal(corrected.writeCalls.length, 1);
  }
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

test("patch recovery without an active read lease returns to the mutation surface", () => {
  const tools = ["read_file", "grep_search", "apply_patch", "run_command"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const decision = resolveIterationToolSurface({
    callbacks: {
      getConfig: () => createLocalRuntimeConfig(),
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
    executeRecoveryReason: "target_progress_mutation_failure",
    executeRecoveryAttempts: 1,
    recoveryIterationCount: 1,
    maxRecoveryIterations: 6,
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
  assert.deepEqual(decision.iterationAllTools.map((tool) => tool.function.name), [
    "apply_patch",
  ]);
});

test("chat recovery cannot expand a respond turn into a mutation surface", () => {
  const tools = ["read_file", "apply_patch"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const makeInput = (turnIntent) => ({
    callbacks: {
      getConfig: () => createLocalRuntimeConfig(),
      getIsPlanApproved: () => false,
      getPlanTasks: () => [],
      getPlanExecutionEvidenceLedger: () => [],
      getMessages: () => [],
      getPlanStage: () => "idle",
    },
    iteration: 4,
    workflowMode: "chat",
    runtimeIntent: "respond",
    turnIntent,
    rawIterationAllTools: tools,
    executeRecoveryMode: "mutation_first",
    executeRecoveryReason: "chat_repair_strategy_pivot:current_task_action_lock",
    executeRecoveryAttempts: 1,
    recoveryIterationCount: 1,
    maxRecoveryIterations: 6,
    recentToolActivity: [],
    recentPlanToolActivity: [],
    planRuntimePhase: "idle",
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
  });

  const denied = resolveIterationToolSurface(makeInput("respond"));
  const authorized = resolveIterationToolSurface(makeInput("execute"));

  assert.equal(denied.isExecuteRecoveryEligible, false);
  assert.deepEqual(denied.iterationAllTools.map((tool) => tool.function.name), [
    "read_file",
    "apply_patch",
  ]);
  assert.equal(authorized.isExecuteRecoveryEligible, true);
  assert.deepEqual(authorized.iterationAllTools.map((tool) => tool.function.name), [
    "apply_patch",
  ]);
});

test("direct file modification retains structured repair tools until final validation", () => {
  const tools = [
    "spawn_subagent",
    "read_file",
    "replace_in_file",
    "write_file",
    "apply_patch",
    "run_command",
    "execute_command",
    "send_pty_input",
    "get_pty_status",
    "browser_evaluate",
    "web_search",
  ].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const makeInput = (recentToolActivity = [], evidenceLedger = []) => ({
    callbacks: {
      getCommandDirective: () => ({ kind: "file_modify", action: "workspace_file_change" }),
      getConfig: () => createLocalRuntimeConfig(),
      getCurrentTurnId: () => "turn-file-modify",
      getIsPlanApproved: () => false,
      getPlanTasks: () => [],
      getPlanExecutionEvidenceLedger: () => evidenceLedger,
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
    recentToolActivity,
    recentPlanToolActivity: [],
    planRuntimePhase: "idle",
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
  });

  const sourceChange = resolveIterationToolSurface(makeInput());
  assert.equal(sourceChange.directFileModifyPhase, "source_change");
  assert.equal(sourceChange.availableToolNames.has("read_file"), true);
  assert.equal(sourceChange.availableToolNames.has("replace_in_file"), true);
  assert.equal(sourceChange.availableToolNames.has("write_file"), true);
  assert.equal(sourceChange.availableToolNames.has("apply_patch"), true);
  assert.equal(sourceChange.availableToolNames.has("run_command"), true);
  assert.equal(sourceChange.availableToolNames.has("execute_command"), false);
  assert.equal(sourceChange.availableToolNames.has("send_pty_input"), false);
  assert.equal(sourceChange.availableToolNames.has("browser_evaluate"), false);
  assert.equal(sourceChange.availableToolNames.has("web_search"), false);

  const validation = resolveIterationToolSurface(makeInput([], [{
    id: "evidence-source-change",
    transactionId: "turn-file-modify",
    kind: "file",
    value: "src/main.js",
    target: "src/main.js",
    sourceTool: "apply_patch",
    createdAt: 1,
  }]));
  assert.equal(validation.directFileModifyPhase, "validation");
  assert.deepEqual(
    validation.iterationAllTools.map((tool) => tool.function.name),
    ["read_file", "replace_in_file", "write_file", "apply_patch", "run_command"],
  );
  assert.equal(validation.availableToolNames.has("read_file"), true);
  assert.equal(validation.availableToolNames.has("replace_in_file"), true);
  assert.equal(validation.availableToolNames.has("write_file"), true);
  assert.equal(validation.availableToolNames.has("apply_patch"), true);
  assert.equal(validation.availableToolNames.has("execute_command"), false);
  assert.equal(validation.availableToolNames.has("get_pty_status"), false);
  assert.equal(validation.availableToolNames.has("browser_evaluate"), false);
  assert.equal(validation.availableToolNames.has("web_search"), false);

  const blockedMutation = resolveIterationToolSurface(makeInput([{
    name: "replace_in_file",
    target: "src/main.js",
    status: "failed",
    detail: "tool_unavailable_for_turn_phase",
  }]));
  assert.equal(
    blockedMutation.directFileModifyPhase,
    "source_change",
    "policy/internal feedback without a successful write cannot advance the mutation phase",
  );

  const noEffectMutation = resolveIterationToolSurface(makeInput([{
    name: "replace_in_file",
    target: "src/main.js",
    status: "called",
    detail: "NO_EFFECT_MUTATION",
  }]));
  assert.equal(noEffectMutation.directFileModifyPhase, "source_change");

  const planArtifactActivity = resolveIterationToolSurface(makeInput([{
    name: "write_file",
    target: ".MAIN/plans/plan.md",
    status: "succeeded",
  }]));
  assert.equal(planArtifactActivity.directFileModifyPhase, "source_change");

  const failedDurableMutation = resolveIterationToolSurface(makeInput([], [{
    id: "failed-source-change",
    transactionId: "turn-file-modify",
    kind: "file",
    value: "src/main.js",
    target: "src/main.js",
    sourceTool: "apply_patch",
    observationStatus: "failed",
    createdAt: 2,
  }]));
  assert.equal(
    failedDurableMutation.directFileModifyPhase,
    "source_change",
    "failed durable evidence cannot claim that a workspace mutation occurred",
  );
});

test("file modification defers Python source writes as invisible internal feedback", async () => {
  const toolDone = [];
  const toolErrors = [];
  const result = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "python-source-write",
      name: "run_command",
      arguments: JSON.stringify({
        command: "python3 <<'PY'\nwith open('src/main.js', 'w') as f:\n  f.write('changed')\nPY",
        description: "rewrite source",
        cwd: ".",
      }),
    }],
    callbacks: {
      ...createReadFilePartitionInput().callbacks,
      getCommandDirective: () => ({ kind: "file_modify", action: "workspace_file_change" }),
      onToolDone: (...args) => toolDone.push(args),
      onToolError: (...args) => toolErrors.push(args),
    },
    availableToolNames: new Set(["run_command", "apply_patch", "replace_in_file", "write_file"]),
  }));

  assert.equal(result.writeCalls.length, 0);
  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].internalFeedback, true);
  assert.equal(result.preExecutionResults[0].displayContent, "");
  assert.equal(result.preExecutionResults[0].qualityGateReason, "shell_source_mutation_deferred");
  assert.equal(toolDone.length, 1);
  assert.equal(toolErrors.length, 0);
});

test("file modification defers a dev server until structured mutation exists", async () => {
  const result = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "premature-dev-server",
      name: "run_command",
      arguments: JSON.stringify({
        command: "npm run dev",
        description: "start dev server",
        cwd: ".",
      }),
    }],
    callbacks: {
      ...createReadFilePartitionInput().callbacks,
      getCommandDirective: () => ({ kind: "file_modify", action: "workspace_file_change" }),
    },
    availableToolNames: new Set(["run_command", "apply_patch", "replace_in_file", "write_file"]),
  }));

  assert.equal(result.writeCalls.length, 0);
  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].internalFeedback, true);
  assert.equal(result.preExecutionResults[0].displayContent, "");
  assert.equal(
    result.preExecutionResults[0].qualityGateReason,
    "long_process_before_file_mutation_deferred",
  );
});

test("a tool outside the current request schema is internal correction, not a visible tool error", async () => {
  const toolDone = [];
  const toolErrors = [];
  const result = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "unavailable-execute-command",
      name: "execute_command",
      arguments: JSON.stringify({ command: "npm run dev", description: "start", cwd: "." }),
    }],
    callbacks: {
      ...createReadFilePartitionInput().callbacks,
      onToolDone: (...args) => toolDone.push(args),
      onToolError: (...args) => toolErrors.push(args),
    },
    availableToolNames: new Set(["read_file", "apply_patch", "run_command"]),
  }));

  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].internalFeedback, true);
  assert.equal(result.preExecutionResults[0].displayContent, "");
  assert.equal(result.preExecutionResults[0].qualityGateReason, "tool_unavailable_for_turn_phase");
  assert.equal(toolDone.length, 1);
  assert.equal(toolErrors.length, 0);
});

test("finite commands requested through PTY are redirected to run_command without execution failure", async () => {
  const result = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "finite-through-pty",
      name: "execute_command",
      arguments: JSON.stringify({
        command: "cargo check",
        description: "check Rust",
        cwd: "src-tauri",
      }),
    }],
    availableToolNames: new Set(["execute_command", "run_command"]),
  }));

  assert.equal(result.writeCalls.length, 0);
  assert.equal(result.preExecutionResults.length, 1);
  assert.equal(result.preExecutionResults[0].lifecycleState, "blocked");
  assert.equal(result.preExecutionResults[0].isError, false);
  assert.equal(result.preExecutionResults[0].qualityGateReason, "finite_command_requires_run_command");
  assert.match(result.preExecutionResults[0].content, /FINITE_COMMAND_REQUIRES_RUN_COMMAND/);
});

test("grep_search blocks external paths as policy feedback and points to read_file", async () => {
  const result = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "external-grep",
      name: "grep_search",
      arguments: JSON.stringify({
        query: "blocking_pick_files",
        path: "/Users/example/.cargo/registry/src/dialog/src/lib.rs",
      }),
    }],
    availableToolNames: new Set(["grep_search", "read_file"]),
  }));

  assert.equal(result.readOnlyCalls.length, 0);
  assert.equal(result.preExecutionResults[0].lifecycleState, "blocked");
  assert.equal(result.preExecutionResults[0].isError, false);
  assert.equal(result.preExecutionResults[0].qualityGateReason, "workspace_search_scope_blocked");
  assert.match(result.preExecutionResults[0].content, /read_file/);
});

test("post-repair validation rejects a different command while keeping the exact checkpoint", async () => {
  const executeRecoveryState = {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: "src-tauri/src/main.rs",
    attempts: 1,
    iterationCount: 0,
    decisionCheckpoint: {
      expectedTarget: "src-tauri/src/main.rs",
      sourceObservationKey: null,
      nextRequiredCapability: "validation",
      pendingFiniteValidation: {
        command: "cargo check",
        cwd: "src-tauri",
      },
    },
  };
  const result = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "wrong-validation",
      name: "run_command",
      arguments: JSON.stringify({
        command: "cargo test",
        description: "run a different check",
        cwd: "src-tauri",
      }),
    }],
    executeRecoveryState,
    recoveryActionContract: resolveExecuteRecoveryActionContract(
      executeRecoveryState.mode,
      executeRecoveryState,
    ),
    availableToolNames: new Set(["run_command"]),
  }));

  assert.equal(result.writeCalls.length, 0);
  assert.equal(result.preExecutionResults[0].lifecycleState, "blocked");
  assert.equal(result.preExecutionResults[0].qualityGateReason, "finite_validation_checkpoint_mismatch");
  assert.match(result.preExecutionResults[0].content, /cargo check/);
});

test("finite validation checkpoint accepts output merging but not compound shell work", async () => {
  const executeRecoveryState = {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: null,
    attempts: 1,
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    iterationCount: 0,
    readLease: null,
    sourceObservationKey: null,
    decisionCheckpoint: {
      expectedTarget: null,
      sourceObservationKey: null,
      nextRequiredCapability: "validation",
      pendingFiniteValidation: {
        command: "npm run build",
        cwd: ".",
      },
    },
  };
  const recoveryActionContract = resolveExecuteRecoveryActionContract(
    executeRecoveryState.mode,
    executeRecoveryState,
  );
  const accepted = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "equivalent-validation",
      name: "run_command",
      arguments: JSON.stringify({
        command: "npm run build 2>&1",
        description: "build with merged output",
        cwd: ".",
      }),
    }],
    executeRecoveryState,
    recoveryActionContract,
    availableToolNames: new Set(["run_command"]),
  }));

  assert.equal(
    normalizeFiniteValidationCheckpointCommand("npm   run build 2> &1"),
    "npm run build",
  );
  assert.equal(accepted.preExecutionResults.length, 0);
  assert.equal(accepted.writeCalls.length, 1);

  const rejected = await partitionToolCallsForExecution(createReadFilePartitionInput({
    toolCalls: [{
      id: "compound-validation",
      name: "run_command",
      arguments: JSON.stringify({
        command: "npm run build && touch escaped",
        description: "compound command",
        cwd: ".",
      }),
    }],
    executeRecoveryState,
    recoveryActionContract,
    availableToolNames: new Set(["run_command"]),
  }));
  assert.equal(rejected.writeCalls.length, 0);
  assert.equal(
    rejected.preExecutionResults[0].qualityGateReason,
    "finite_validation_checkpoint_mismatch",
  );
});

test("delegation uses initial fan-out plus runtime-owned lifecycle review waves", () => {
  const tools = ["read_file", "spawn_subagent", "wait_subagents", "apply_patch"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const makeInput = (overrides = {}) => ({
    callbacks: {
      getConfig: () => createLocalRuntimeConfig(),
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
    recentToolActivity: [],
    recentPlanToolActivity: [],
    planRuntimePhase: "idle",
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
    lastAssistantTextForCheckpoint: "",
    latestUserPromptText: "可以开启多个 subagent 协同检查",
    ...overrides,
  });

  const context = resolveIterationToolSurface(makeInput());
  assert.equal(context.delegationDecision.action, "defer");
  assert.equal(context.delegationDecision.reason, "insufficient_independent_scope");
  assert.equal(context.delegationDecision.phase, "context");
  assert.equal(context.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), false);

  const explicitlyScopedPrompt = resolveIterationToolSurface(makeInput({
    latestUserPromptText: [
      "必须先连续调用 spawn_subagent 三次并行分析。",
      "allowed_paths=src/hooks/useCsvParser.ts,src/hooks/useChartData.ts,src/types/order.ts。",
      "主体不要重读子智能体租约路径。",
    ].join("\n"),
  }));
  assert.equal(explicitlyScopedPrompt.delegationDecision.preference, "preferred");
  assert.equal(explicitlyScopedPrompt.delegationDecision.action, "admit");
  assert.equal(explicitlyScopedPrompt.delegationDecision.independentScopeCount, 3);
  assert.equal(explicitlyScopedPrompt.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), true);

  const sessionPreferred = resolveIterationToolSurface(makeInput({
    latestUserPromptText: "检查启动和菜单模块",
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: ["src/main.js"],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(sessionPreferred.delegationDecision.preference, "preferred");
  assert.equal(sessionPreferred.delegationDecision.action, "admit");
  assert.equal(sessionPreferred.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), true);

  const evidenceTools = [
    ...tools,
    {
      type: "function",
      function: {
        name: "find_symbol_references",
        description: "find_symbol_references",
        parameters: {
          type: "object",
          properties: { symbol: { type: "string" } },
          required: ["symbol"],
        },
      },
    },
  ];
  const openEvidenceTopology = resolveIterationToolSurface(makeInput({
    workflowMode: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "needs_evidence",
    rawIterationAllTools: evidenceTools,
    latestUserPromptText: "Diagnose the editor and save-path symptoms before preparing a Plan",
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/components/editor.js",
        status: "succeeded",
        structuredFacts: [{
          kind: "event_contract",
          authority: "runtime_observation",
          relation: "dom_dispatch",
          event: "input",
        }],
      },
      {
        name: "read_file",
        target: "src/components/toolbar.js",
        status: "succeeded",
      },
    ],
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(openEvidenceTopology.delegationDecision.action, "admit");
  assert.equal(
    openEvidenceTopology.preferredDelegationRequirement.reason,
    "evidence_topology_open",
  );
  assert.equal(openEvidenceTopology.preferredDelegationRequirement.required, false);
  assert.equal(
    openEvidenceTopology.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"),
    false,
  );
  assert.equal(openEvidenceTopology.planEvidenceObligation?.kind, "find_symbol_references");
  assert.equal(openEvidenceTopology.planEvidenceObligation?.symbol, "input");
  assert.deepEqual(
    openEvidenceTopology.iterationAllTools.map((tool) => tool.function.name),
    ["find_symbol_references"],
  );

  const earlyDisjointPlanTopology = resolveIterationToolSurface(makeInput({
    workflowMode: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "grounding",
    rawIterationAllTools: evidenceTools,
    latestUserPromptText: "Trace the frontend event and backend command owners before drafting",
    recentPlanToolActivity: [{
      name: "get_project_skeleton",
      target: "get_project_skeleton",
      status: "succeeded",
      discoveryObservation: {
        kind: "project_structure",
        targetRefs: [
          "package.json",
          "README.md",
          "src/main.js",
          "src/components/editor.js",
          "src-tauri/src/main.rs",
        ],
      },
    }],
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(earlyDisjointPlanTopology.delegationDecision.phase, "diagnostic");
  assert.equal(earlyDisjointPlanTopology.delegationDecision.action, "admit");
  assert.equal(earlyDisjointPlanTopology.preferredDelegationRequirement.required, true);
  assert.deepEqual(
    earlyDisjointPlanTopology.preferredDelegationRequirement.requiredScopes.map((scope) =>
      scope.scopeKey
    ),
    ["src", "src-tauri"],
  );
  assert.deepEqual(
    earlyDisjointPlanTopology.iterationAllTools.map((tool) => tool.function.name),
    ["spawn_subagent"],
    "typed project topology activates preferred delegation before parent source reads or Plan finalization",
  );

  const earlyScopeContract = preferredScopes.createPreferredDelegationScopeContract({
    requiredScopes: earlyDisjointPlanTopology.preferredDelegationRequirement.requiredScopes,
    maxCreatedPerTurn: 3,
  });
  const releasedAfterEarlyCapacityFailure = resolveIterationToolSurface(makeInput({
    workflowMode: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "grounding",
    rawIterationAllTools: evidenceTools,
    latestUserPromptText: "Trace the frontend event and backend command owners before drafting",
    recentPlanToolActivity: [{
      name: "get_project_skeleton",
      target: "get_project_skeleton",
      status: "succeeded",
      discoveryObservation: {
        kind: "project_structure",
        targetRefs: ["src/main.js", "src-tauri/src/main.rs"],
      },
    }],
    preferredDelegationScopeContract: earlyScopeContract,
    preferredDelegationMaterializationBlockedScopeKeys: ["src", "src-tauri"],
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(
    releasedAfterEarlyCapacityFailure.preferredDelegationRequirement.reason,
    "runtime_materialization_failed",
  );
  assert.equal(
    releasedAfterEarlyCapacityFailure.preferredDelegationRequirement.contractOpen,
    false,
  );
  assert.equal(
    releasedAfterEarlyCapacityFailure.iterationAllTools.some((tool) =>
      tool.function.name === "spawn_subagent"
    ),
    false,
  );
  assert.equal(
    releasedAfterEarlyCapacityFailure.iterationAllTools.some((tool) =>
      tool.function.name === "read_file"
    ),
    true,
    "a rejected preferred materialization releases evidence work back to the parent",
  );
  const orchestratorSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    orchestratorSource,
    /turnIterationContext\.turn\.status\s*=\s*["']completed["']/,
    "a control-plane-only delegation iteration cannot publish a false completion",
  );

  const closedMdViewerTopology = resolveIterationToolSurface(makeInput({
    workflowMode: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "drafting",
    usedPlanReadOnlyConvergencePrompt: true,
    rawIterationAllTools: evidenceTools,
    latestUserPromptText: "Prepare the grounded Plan for the editor and save-path symptoms",
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/components/editor.js",
        status: "succeeded",
        structuredFacts: [{
          kind: "event_contract",
          authority: "runtime_observation",
          relation: "dom_dispatch",
          event: "input",
        }],
      },
      { name: "read_file", target: "src/components/toolbar.js", status: "succeeded" },
      { name: "read_file", target: "src/components/preview.js", status: "succeeded" },
      {
        name: "read_file",
        target: "src/main.js",
        status: "succeeded",
        structuredFacts: [{
          kind: "event_contract",
          authority: "runtime_observation",
          relation: "dom_listener",
          event: "input",
        }, {
          kind: "command_contract",
          authority: "runtime_observation",
          relation: "invoke",
          command: "save_file_content",
          arguments: ["filePath"],
        }],
      },
      {
        name: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        structuredFacts: [{
          kind: "command_contract",
          authority: "runtime_observation",
          relation: "handler",
          command: "save_file_content",
          arguments: ["file_path"],
        }],
      },
    ],
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(closedMdViewerTopology.preferredDelegationRequirement.required, true);
  assert.deepEqual(
    closedMdViewerTopology.preferredDelegationRequirement.requiredScopes.map((scope) => scope.scopeKey),
    ["src", "src-tauri"],
  );
  assert.deepEqual(
    closedMdViewerTopology.iterationAllTools.map((tool) => tool.function.name),
    ["spawn_subagent"],
  );

  const planDraftCheckpoint = resolveIterationToolSurface(makeInput({
    workflowMode: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "drafting",
    usedPlanReadOnlyConvergencePrompt: true,
    latestUserPromptText: "Inspect the confirmed evidence and prepare the plan",
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/main.js",
        status: "succeeded",
      },
      {
        name: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
      },
    ],
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(planDraftCheckpoint.delegationDecision.phase, "diagnostic");
  assert.equal(planDraftCheckpoint.delegationDecision.action, "admit");
  assert.equal(planDraftCheckpoint.preferredDelegationRequirement.required, true);
  assert.deepEqual(
    planDraftCheckpoint.iterationAllTools.map((tool) => tool.function.name),
    ["spawn_subagent"],
  );

  let settledDelegation = preferredScopes.createPreferredDelegationScopeContract({
    requiredScopes: planDraftCheckpoint.preferredDelegationRequirement.requiredScopes,
    maxCreatedPerTurn: 3,
  });
  for (const [index, scope] of settledDelegation.requiredScopes.entries()) {
    const subagentId = `settled-${index}`;
    settledDelegation = preferredScopes.recordPreferredDelegationScopeSpawn({
      contract: settledDelegation,
      outcome: {
        subagentId,
        name: subagentId,
        status: "queued",
        scopeKey: scope.scopeKey,
        allowedPaths: scope.allowedPaths,
      },
    });
    settledDelegation = preferredScopes.applyPreferredDelegationScopeJoinOutcomes({
      contract: settledDelegation,
      outcomes: [{
        subagentId,
        scopeKey: scope.scopeKey,
        status: "completed",
        closureState: "satisfied",
        adoptedEvidenceCount: 1,
        adoptedEvidenceTargets: [scope.allowedPaths[0]],
        consumed: true,
      }],
    });
  }
  const satisfiedPlanDraft = resolveIterationToolSurface(makeInput({
    workflowMode: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "drafting",
    usedPlanReadOnlyConvergencePrompt: true,
    latestUserPromptText: "Inspect the confirmed evidence and prepare the plan",
    recentPlanToolActivity: planDraftCheckpoint.preferredDelegationRequirement.candidateScopeKeys
      .map((target) => ({ name: "read_file", target, status: "succeeded" })),
    preferredDelegationScopeContract: settledDelegation,
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(satisfiedPlanDraft.delegationDecision.phase, "finalization");
  assert.equal(satisfiedPlanDraft.preferredDelegationRequirement.reason, "all_required_scopes_consumed");
  assert.deepEqual(satisfiedPlanDraft.iterationAllTools, []);

  let exhaustedDelegation = preferredScopes.createPreferredDelegationScopeContract({
    requiredScopes: planDraftCheckpoint.preferredDelegationRequirement.requiredScopes,
    maxCreatedPerTurn: planDraftCheckpoint.preferredDelegationRequirement.requiredScopes.length,
  });
  for (const [index, scope] of exhaustedDelegation.requiredScopes.entries()) {
    const subagentId = `exhausted-${index}`;
    exhaustedDelegation = preferredScopes.recordPreferredDelegationScopeSpawn({
      contract: exhaustedDelegation,
      outcome: {
        subagentId,
        name: subagentId,
        status: "queued",
        scopeKey: scope.scopeKey,
        allowedPaths: scope.allowedPaths,
      },
    });
    exhaustedDelegation = preferredScopes.applyPreferredDelegationScopeJoinOutcomes({
      contract: exhaustedDelegation,
      outcomes: [{
        subagentId,
        scopeKey: scope.scopeKey,
        status: "degraded",
        closureState: "partial",
        adoptedEvidenceCount: 1,
        adoptedEvidenceTargets: [scope.allowedPaths[0]],
        consumed: false,
      }],
    });
  }
  const exhaustedPlanGrounding = resolveIterationToolSurface(makeInput({
    workflowMode: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "grounding",
    latestUserPromptText: "Inspect src/main.js and src-tauri/src/main.rs before planning",
    recentPlanToolActivity: [
      { name: "read_file", target: "src/main.js", status: "succeeded" },
      { name: "read_file", target: "src-tauri/src/main.rs", status: "succeeded" },
    ],
    preferredDelegationScopeContract: exhaustedDelegation,
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(exhaustedPlanGrounding.preferredDelegationRequirement.contractOpen, false);
  assert.equal(exhaustedPlanGrounding.preferredDelegationRequirement.reason, "scope_creation_capacity_reached");
  assert.ok(exhaustedPlanGrounding.iterationAllTools.length > 0);
  assert.equal(
    exhaustedPlanGrounding.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"),
    false,
  );

  const singleScopePlanDraft = resolveIterationToolSurface(makeInput({
    workflowMode: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "drafting",
    usedPlanReadOnlyConvergencePrompt: true,
    latestUserPromptText: "Inspect the confirmed evidence and prepare the plan",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
    }],
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
  }));
  assert.equal(singleScopePlanDraft.delegationDecision.phase, "finalization");
  assert.equal(singleScopePlanDraft.preferredDelegationRequirement.required, false);
  assert.deepEqual(singleScopePlanDraft.iterationAllTools, []);

  const sessionForbidden = resolveIterationToolSurface(makeInput({
    latestUserPromptText: "检查启动和菜单模块",
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "forbidden",
    },
  }));
  assert.equal(sessionForbidden.delegationDecision.reason, "user_forbidden");
  assert.equal(sessionForbidden.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), false);

  const mutation = resolveIterationToolSurface(makeInput({
    recentToolActivity: [
      {
        name: "apply_patch",
        target: "src/main.js",
        status: "succeeded",
        mutationObserved: true,
      },
      {
        name: "read_file",
        target: "src/main.js",
        status: "succeeded",
      },
      {
        name: "read_file",
        target: "src/components/toolbar.js",
        status: "succeeded",
      },
    ],
  }));
  assert.equal(mutation.delegationDecision.action, "admit");
  assert.equal(mutation.delegationDecision.phase, "mutation");
  assert.equal(mutation.preferredDelegationRequirement.required, true);
  assert.equal(mutation.preferredDelegationRequirement.lifecyclePhase, "mutation");
  assert.equal(mutation.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), true);
  assert.equal(mutation.iterationAllTools.some((tool) => tool.function.name === "wait_subagents"), false);

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
      {
        name: "read_file",
        target: "src/components/toolbar.js",
        status: "succeeded",
      },
    ],
  }));
  assert.equal(validation.delegationDecision.action, "admit");
  assert.equal(validation.delegationDecision.phase, "validation");
  assert.equal(validation.preferredDelegationRequirement.required, true);
  assert.equal(validation.preferredDelegationRequirement.lifecyclePhase, "validation");
  assert.equal(validation.iterationAllTools.some((tool) => tool.function.name === "spawn_subagent"), true);

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
      getConfig: () => createLocalRuntimeConfig(),
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

test("recovery hides new child creation and current phase work wins before join", () => {
  const tools = ["read_file", "spawn_subagent", "wait_subagents", "apply_patch"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const decision = resolveIterationToolSurface({
    callbacks: {
      getConfig: () => createLocalRuntimeConfig(),
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
  }), false);
  const batch = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [
      { id: "join", name: "wait_subagents", target: "subagent-running" },
      { id: "edit", name: "apply_patch", target: "src/App.tsx" },
    ],
  });
  assert.equal(batch.selectedToolName, "apply_patch");
  assert.deepEqual(batch.deferredCallIds, ["join"]);
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

test("child broad grep target is safely narrowed before scope validation", async () => {
  const debugEvents = [];
  const scope = {
    subagentId: "subagent-chart",
    parentSessionKey: "thread",
    scopeKey: "chart-consumer",
    workspace: workspaceRoot,
    allowedPaths: ["src/App.tsx", "src/main.tsx"],
    allowedFilePaths: ["src/App.tsx", "src/main.tsx"],
    allowedDirectoryPaths: [],
    scopeKind: "exact_files",
    blockedToolNames: [],
  };
  const input = createReadFilePartitionInput({
    toolCalls: [{
      id: "child-broad-grep",
      name: "grep_search",
      arguments: JSON.stringify({ query: "creatorName", path: "." }),
    }],
    availableToolNames: new Set(["grep_search"]),
    toolCapabilityRegistry: {
      ...partitionToolCapabilityRegistry,
      tools: {
        ...partitionToolCapabilityRegistry.tools,
        grep_search: {
          key: "grep_search",
          name: "grep_search",
          source: "built_in",
          category: "file",
          risk: "read_only",
          enabled: true,
          autoExecutable: true,
        },
      },
    },
  });
  input.callbacks = {
    ...input.callbacks,
    getSubagentScope: () => scope,
    onDebugEvent: (event, data) => debugEvents.push({ event, data }),
  };

  const partitioned = await partitionToolCallsForExecution(input);
  assert.equal(partitioned.preExecutionResults.length, 0);
  assert.equal(partitioned.readOnlyCalls.length, 1);
  assert.equal(partitioned.toolArgsByCallId.get("child-broad-grep").path, "src/App.tsx");
  assert.deepEqual(partitioned.readOnlyCalls[0].scopedReadPaths, ["src/App.tsx", "src/main.tsx"]);
  assert.ok(debugEvents.some((entry) =>
    entry.event === "subagent_scope_tool_args_narrowed" &&
    entry.data.requestedPath === "." &&
    entry.data.resolvedPath === "src/App.tsx" &&
    JSON.stringify(entry.data.resolvedPaths) === JSON.stringify(["src/App.tsx", "src/main.tsx"])
  ));
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
    "wait_subagents",
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
      getConfig: () => createLocalRuntimeConfig(),
      getIsPlanApproved: () => false,
      getPlanTasks: () => [],
      getMessages: () => [],
      getPlanStage: () => "idle",
      getPendingSubagentIds: () => [],
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
    recentToolActivity: [],
    recentPlanToolActivity: [],
    planRuntimePhase: "idle",
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
  };
  const browserNeedsLaunch = resolveIterationToolSurface({
    ...baseInput,
    executeRecoveryMode: "validation_only",
    executeRecoveryDecisionCheckpoint: {
      expectedTarget: null,
      sourceObservationKey: null,
      nextRequiredCapability: "browser_validation",
    },
    callbacks: {
      ...baseInput.callbacks,
      getPlanExecutionEvidenceLedger: () => [],
    },
  });
  assert.equal(browserNeedsLaunch.recoveryActionContract.devServerStatus, "none");
  assert.equal(browserNeedsLaunch.recoveryActionContract.nextRequiredCapability, "launch_long_process");
  assert.deepEqual(
    browserNeedsLaunch.iterationAllTools.map((tool) => tool.function.name),
    ["execute_command"],
  );

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
  assert.deepEqual(
    pending.iterationAllTools.map((tool) => tool.function.name),
    ["read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status"],
  );

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
  assert.deepEqual(
    ready.iterationAllTools.map((tool) => tool.function.name),
    ["browser_evaluate"],
  );
  assert.equal(ready.availableToolNames.has("wait_subagents"), false);

  const migratedLegacyPostMutation = resolveIterationToolSurface({
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
  assert.equal(migratedLegacyPostMutation.recoveryActionContract.phase, "validation");
  assert.equal(migratedLegacyPostMutation.recoveryActionContract.nextRequiredCapability, "browser_validation");
  assert.equal(migratedLegacyPostMutation.recoveryActionContract.readLease, null);
  assert.deepEqual(
    migratedLegacyPostMutation.iterationAllTools.map((tool) => tool.function.name),
    ["browser_evaluate"],
  );

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
  assert.deepEqual(
    failed.iterationAllTools.map((tool) => tool.function.name),
    [
      "execute_command",
      "read_pty_buffer",
      "read_pty_tail",
      "read_pty_since",
      "get_pty_status",
    ],
  );
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
      getConfig: () => createLocalRuntimeConfig(workspaceRoot),
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
    workflowMode: "edit",
    runtimeIntent: "execute",
    rawIterationAllTools: tools,
    executeRecoveryMode: "normal",
    executeRecoveryReason: "",
    executeRecoveryAttempts: 0,
    recoveryIterationCount: 0,
    maxRecoveryIterations: 6,
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

test("normal approved Plan execute workflow is not narrowed by tool history alone", () => {
  const baseInput = createApprovedPlanToolSurfaceInput();
  const expectedNames = baseInput.rawIterationAllTools.map((tool) => tool.function.name);
  const normal = resolveIterationToolSurface(baseInput);
  const mismatchHistory = resolveIterationToolSurface(createApprovedPlanToolSurfaceInput({
    recentPlanToolActivity: [{
      name: "replace_in_file",
      status: "failed",
      target: "src/main.rs",
      detail: "search_text mismatch",
    }],
  }));

  assert.deepEqual(normal.iterationAllTools.map((tool) => tool.function.name), expectedNames);
  assert.deepEqual(mismatchHistory.iterationAllTools.map((tool) => tool.function.name), expectedNames);
  assert.equal(normal.availableToolNames.has("read_file"), true);
  assert.equal(normal.availableToolNames.has("grep_search"), true);
  assert.equal(normal.availableToolNames.has("browser_evaluate"), true);

  const recovery = resolveIterationToolSurface(createApprovedPlanToolSurfaceInput({
    executeRecoveryMode: "mutation_first",
    executeRecoveryReason: "reasoning_dominated_recovery",
    executeRecoveryAttempts: 1,
    recoveryIterationCount: 1,
  }));
  assert.equal(recovery.isExecuteRecoveryEligible, true);
  assert.equal(recovery.availableToolNames.has("read_file"), false);
  assert.equal(recovery.availableToolNames.has("apply_patch"), true);
  assert.equal(recovery.recoveryActionContract.allowTargetedFileRead, false);
});

test("validation recovery closes adjacent workspace actions until structured failure", () => {
  assert.equal(isExecuteRecoveryToolName("run_command", readOnlyTools, {
    mode: "validation_only",
  }), true);
  assert.equal(isExecuteRecoveryToolName("browser_evaluate", readOnlyTools, {
    mode: "validation_only",
  }), false);
  assert.equal(isExecuteRecoveryToolName("replace_in_file", readOnlyTools, {
    mode: "validation_only",
  }), false);
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "validation_only",
  }), false);

  const prompt = buildExecuteValidationRecoveryPrompt({
    language: "zh",
    reason: "repeat_edit_target_without_validation",
    target: "src/components/Dashboard/CourseBarChart.tsx",
    editCount: 3,
    availableValidationTools: ["run_command", "browser_evaluate"],
  });
  assert.match(prompt, /连续修改同一目标/);
  assert.match(prompt, /下一证据优先级是一条成功验证结果/);
  assert.match(prompt, /验证是当前阶段唯一开放能力/);
  assert.match(prompt, /结构化验证失败/);
  assert.match(prompt, /不能声称任务完成/);
});

test("failed finite validation keeps a command-only checkpoint until structured repair", () => {
  const contract = resolveExecuteRecoveryActionContract("finite_validation_only", {
    decisionCheckpoint: {
      expectedTarget: "src/example.js",
      sourceObservationKey: "src/example.js::v1",
      nextRequiredCapability: "validation",
      pendingFiniteValidation: {
        command: "node -e require('./src/example.js')",
        cwd: ".",
      },
    },
  });
  assert.equal(isExecuteRecoveryToolName("run_command", readOnlyTools, {
    contract,
  }), true);
  for (const available of [
    "execute_command",
    "read_pty_since",
    "browser_evaluate",
  ]) {
    assert.equal(isExecuteRecoveryToolName(available, readOnlyTools, {
      contract,
    }), false, available);
  }
  assert.equal(isExecuteRecoveryToolName("replace_in_file", readOnlyTools, {
    contract,
  }), false);
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    contract,
  }), false);
  const prompt = buildFailedFiniteValidationRecoveryPrompt({
    command: "node -e require('./src/example.js')",
    result: '{"exitCode":1,"stderr":"module not found"}',
  });
  assert.match(prompt, /next required evidence is one compatible finite command/);
  assert.match(prompt, /exposes only the finite command boundary/);
  assert.match(prompt, /reads and edits are not adjacent validation actions/);
  assert.match(prompt, /exitCode 0/);
});

test("finite validation checkpoints persist command, cwd, and timeout in the action contract", () => {
  const checkpoint = normalizeExecutionDecisionCheckpointSnapshot({
    expectedTarget: "src-tauri/src/main.rs",
    sourceObservationKey: null,
    nextRequiredCapability: "validation",
    pendingFiniteValidation: {
      command: "cargo check",
      cwd: "src-tauri/",
      timeoutMs: 120000,
    },
    validationMutationReopenCount: 2.9,
    validationMutationReopenFingerprints: [" Edit:A ", "edit:a", "EDIT:B"],
    objectiveMutationEvidence: [
      { target: "src-tauri/src/main.rs", requirementRef: "REQ-RUST" },
      { target: "src-tauri/src/main.rs", requirementRef: "REQ-RUST" },
      { target: "" },
    ],
    objectiveObligationId: " requirement:REQ-RUST ",
    objectiveRevision: 3.8,
    objectiveKind: "requirement",
    objectiveExpectedTargets: ["src-tauri/src/main.rs", "src-tauri/src/main.rs", ""],
    objectiveValidationEvidence: {
      tool: "run_command",
      target: "cargo check",
      revision: 3.9,
    },
    objectiveClosurePending: true,
  });
  assert.deepEqual(checkpoint?.pendingFiniteValidation, {
    command: "cargo check",
    cwd: "src-tauri",
    timeoutMs: 120000,
  });
  assert.equal(checkpoint?.validationMutationReopenCount, 2);
  assert.deepEqual(checkpoint?.validationMutationReopenFingerprints, ["edit:a", "edit:b"]);
  assert.deepEqual(checkpoint?.objectiveMutationEvidence, [{
    target: "src-tauri/src/main.rs",
    requirementRef: "REQ-RUST",
  }]);
  assert.equal(checkpoint?.objectiveObligationId, "requirement:REQ-RUST");
  assert.equal(checkpoint?.objectiveRevision, 3);
  assert.equal(checkpoint?.objectiveKind, "requirement");
  assert.deepEqual(checkpoint?.objectiveExpectedTargets, ["src-tauri/src/main.rs"]);
  assert.deepEqual(checkpoint?.objectiveValidationEvidence, {
    tool: "run_command",
    target: "cargo check",
    revision: 3,
  });
  assert.equal(checkpoint?.objectiveClosurePending, true);
  const contract = resolveExecuteRecoveryActionContract("validation_only", {
    expectedTarget: checkpoint?.expectedTarget,
    decisionCheckpoint: checkpoint,
  });
  const card = buildExecutionActionContractCard({ contract, language: "en" });
  assert.match(card, /validationCommand=cargo check/);
  assert.match(card, /validationCwd=src-tauri/);
  assert.match(card, /only acceptance boundary/);
  assert.equal(contract.allowedToolNames.has("run_command"), true);
  assert.equal(contract.allowedToolNames.has("read_file"), false);
  assert.equal(contract.allowedToolNames.has("replace_in_file"), false);
  assert.deepEqual(contract.toolCallRequirement, {
    kind: "required_named",
    toolName: "run_command",
  });
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
  assert.match(explicitPrompt, /retry that command/);
  assert.match(explicitPrompt, /different command cannot replace/);
  assert.match(explicitPrompt, /keep `npm test` as the acceptance boundary/);
  assert.doesNotMatch(explicitPrompt, /call one different finite validation command/);
  assert.doesNotMatch(explicitPrompt, /Do not repeat the failed command unchanged/);

  const runtimeOwnedPolicy = resolveFailedFiniteValidationRecoveryPolicy({
    failedCommand: "npm run build",
    tasks: [],
  });
  assert.deepEqual(runtimeOwnedPolicy, {
    allowAlternativeCommand: true,
    requiredCommand: "",
  });
  const runtimeOwnedPrompt = buildFailedFiniteValidationRecoveryPrompt({
    command: "npm run build",
    result: '{"exitCode":1,"stderr":"missing script"}',
    ...runtimeOwnedPolicy,
  });
  assert.match(runtimeOwnedPrompt, /No exact command was reviewed/);
  assert.match(runtimeOwnedPrompt, /one compatible finite command/);
});

test("finite validation repair binds only a uniquely attributed diagnostic path", () => {
  const attributed = resolveFiniteValidationRepairTarget({
    result: {
      name: "run_command",
      target: "npm run build",
      content: JSON.stringify({
        exitCode: 1,
        stderr: "src/components/editor.js:180:7: error synthetic input is forbidden",
      }),
      isError: true,
    },
    args: { command: "npm run build", cwd: "." },
    workspace: "/workspace",
  });
  assert.equal(attributed, "src/components/editor.js");

  const inlineAttributed = resolveFiniteValidationRepairTarget({
    result: {
      name: "run_command",
      target: "npm run build",
      content: JSON.stringify({
        exitCode: 1,
        stdout: "Fresh acceptance failed: src/main.js existing-file save still uses the wrong payload.",
      }),
      isError: true,
    },
    args: { command: "npm run build", cwd: "." },
    workspace: "/workspace",
  });
  assert.equal(inlineAttributed, "src/main.js");

  const multiOwner = resolveFiniteValidationRepairTarget({
    result: {
      name: "run_command",
      target: "npm run build",
      content: JSON.stringify({
        exitCode: 1,
        stdout: "Repair src/main.js and src/components/editor.js before rerunning.",
      }),
      isError: true,
    },
    args: { command: "npm run build", cwd: "." },
    workspace: "/workspace",
  });
  assert.equal(
    multiOwner,
    null,
    "multiple diagnostic owners must retain a workspace-scoped repair",
  );

  const objectiveLevel = resolveFiniteValidationRepairTarget({
    result: {
      name: "run_command",
      target: "npm run build",
      content: JSON.stringify({
        exitCode: 1,
        stdout: "Three acceptance obligations remain across the workspace.",
      }),
      isError: true,
    },
    args: { command: "npm run build", cwd: "." },
    workspace: "/workspace",
  });
  assert.equal(
    objectiveLevel,
    null,
    "the latest mutation target must not be invented as the cause of an unattributed validation failure",
  );
});

test("finite validation recovery follows Execute semantics instead of a transient command directive", () => {
  assert.equal(isFiniteValidationRecoveryExecution({
    workflowMode: "edit",
    runtimeIntent: "execute",
    isPlanApproved: false,
  }), true);
  assert.equal(isFiniteValidationRecoveryExecution({
    workflowMode: "edit",
    runtimeIntent: "goal",
    isPlanApproved: false,
  }), true);
  assert.equal(isFiniteValidationRecoveryExecution({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
  }), true);
  assert.equal(isFiniteValidationRecoveryExecution({
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
  }), false);
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
    evidence: [{ kind: "cmd", value: "npm run build" }],
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
    tasks: [],
  }), false);

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

test("real validation failure grants one current-version repair read before mutation", () => {
  const lease = buildFailedValidationRepairReadLease({
    target: "src/main.js",
    sourceObservationKey:
      "read_file::/workspace/src/main.js::[[\"end_line\",521],[\"max_lines\",6],[\"start_line\",516]]::version=100:10::content=old",
  });
  assert.deepEqual(lease, {
    purpose: "context_restore",
    target: "src/main.js",
    requestedRange: { startLine: 516, endLine: 521, maxLines: 6 },
    state: "available",
  });
  assert.equal("observedVersion" in lease, false, "the pre-mutation version must not reject the current read");

  const contract = resolveExecuteRecoveryActionContract("patch_recovery_read", {
    expectedTarget: "src/main.js",
    readLease: lease,
    sourceObservationKey: null,
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: null,
      nextRequiredCapability: "targeted_read",
    },
  });
  assert.equal(contract.phase, "context");
  assert.equal(contract.nextRequiredCapability, "targeted_read");
  assert.equal(contract.allowedToolNames.has("read_file"), true);
  assert.equal(contract.allowedToolNames.has("replace_in_file"), false);
  assert.equal(contract.allowedToolNames.has("run_command"), false);
});

test("latest Execute incident keeps an unbounded parent reread satisfiable and the workspace surface stable", () => {
  let recoveryState = createExecuteRecoveryRuntimeState({ workflowMode: "edit" });
  const runtimeActions = createAgentLoopRuntimeActions({
    callbacks: {
      getIsPlanApproved: () => false,
      getPreferredLanguage: () => "en",
    },
    runtimeState: { workflowMode: "edit" },
    recentToolActivity: [],
    getIteration: () => 9,
    getExecuteRecoveryState: () => recoveryState,
    setExecuteRecoveryState: (next) => {
      recoveryState = next;
    },
    getStreamRuntimeState: () => ({}),
    setStreamRuntimeState: () => {},
    getPlanRuntimeState: () => ({ planRuntimePhase: "idle" }),
    setPlanRuntimeState: () => {},
  });

  recoveryState = runtimeActions.activateExecuteRecovery(
    "patch_recovery_read",
    "subagent_parent_source_reread_required",
    {
      target: "src/main.js",
      readLease: {
        purpose: "context_restore",
        target: "src/main.js",
        observationKey: "child-observation-diagnostic-only",
        observedVersion: null,
        state: "available",
      },
      sourceObservationKey: "child-observation-diagnostic-only",
    },
  );

  assert.equal(recoveryState.readLease?.purpose, "context_restore");
  assert.equal(recoveryState.readLease?.requestedRange, undefined);
  assert.equal(recoveryState.sourceObservationKey, null);
  const contextContract = resolveExecuteRecoveryActionContract(
    recoveryState.mode,
    recoveryState,
  );
  assert.equal(contextContract.nextRequiredCapability, "targeted_read");
  assert.equal(contextContract.allowedToolNames.has("read_file"), true);
  assert.equal(contextContract.allowedToolNames.has("replace_in_file"), false);
  assert.equal(contextContract.allowedToolNames.has("run_command"), false);
  assert.deepEqual(contextContract.toolCallRequirement, {
    kind: "required_named",
    toolName: "read_file",
  });

  const refreshed = transitionExecuteRecoveryRuntimeState(recoveryState, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "src/main.js::33890:1784775202670::500-529",
    sourceRequestedRange: { startLine: 500, endLine: 529, maxLines: 30 },
    sourceObservedVersion: "33890:1784775202670",
  });
  assert.equal(refreshed.transition, "context_to_mutation");
  assert.equal(refreshed.state.mode, "mutation_first");
  assert.equal(refreshed.state.readLease?.state, "consumed");

  const mutationContract = resolveExecuteRecoveryActionContract(
    refreshed.state.mode,
    refreshed.state,
  );
  const pendingEdit = resolveExecuteRecoveryBatchDecision({
    mode: refreshed.state.mode,
    contract: mutationContract,
    expectedTarget: "src/main.js",
    calls: [{
      id: "replace-after-parent-reread",
      name: "replace_in_file",
      target: "src/main.js",
    }],
  });
  assert.equal(pendingEdit.selectedCallId, "replace-after-parent-reread");
  assert.deepEqual(pendingEdit.deferredCallIds, []);

  const adjacentValidation = resolveExecuteRecoveryBatchDecision({
    mode: refreshed.state.mode,
    contract: mutationContract,
    expectedTarget: "src/main.js",
    calls: [{
      id: "finite-check-before-next-edit",
      name: "run_command",
      target: "npm test",
    }],
  });
  assert.equal(adjacentValidation.selectedCallId, null);
  assert.deepEqual(adjacentValidation.deferredCallIds, ["finite-check-before-next-edit"]);
});

test("patch mismatch recovery reuses versioned observations without cache bypass", () => {
  const recent = [
    { name: "replace_in_file", status: "failed", target: "src/App.tsx", detail: "MUTATION_PREFLIGHT_BLOCKED: search_text_mismatch" },
  ];

  assert.equal(isExecutePatchMismatchRecoveryActivity(recent[0]), true);
  assert.equal(
    isExecutePatchMismatchRecoveryActivity({
      name: "apply_patch",
      status: "failed",
      target: "src/App.tsx",
      detail: "Patch context was not found in src/App.tsx",
    }),
    false,
    "localized executor prose must not drive recovery state",
  );
  const exactReadContract = resolveExecuteRecoveryActionContract("patch_recovery_read", {
    expectedTarget: "src/App.tsx",
    readLease: {
      purpose: "patch_recovery",
      target: "src/App.tsx",
      requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
      state: "available",
    },
  });
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "patch_recovery_read",
    contract: exactReadContract,
  }), true);
  assert.equal(isExecuteRecoveryToolName("list_directory", readOnlyTools, {
    mode: "patch_recovery_read",
    allowFileRead: true,
  }), false);

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
  assert.equal(patchRecoveryLeaseIdentityMatches(
    { ...exactLease, state: "consumed" },
    { ...exactLease, state: "available" },
  ), true, "the same mismatch identity must not mint a second lease");
  assert.equal(patchRecoveryLeaseIdentityMatches(
    { ...exactLease, state: "consumed" },
    { ...exactLease, observedVersion: "4097:1700000000001", state: "available" },
  ), false, "new version evidence may mint a distinct lease");
  assert.equal(patchRecoveryLeaseIdentityMatches(
    { ...exactLease, state: "consumed" },
    {
      ...exactLease,
      requestedRange: { startLine: 206, endLine: 260, maxLines: 55 },
      mismatchFingerprint: `${mismatchFingerprint}::different-patch-text`,
      state: "available",
    },
  ), true, "overlapping hunk churn on the same version and failure class must not mint a lease");
  assert.equal(patchRecoveryLeaseIdentityMatches(
    { ...exactLease, state: "consumed" },
    {
      ...exactLease,
      requestedRange: { startLine: 600, endLine: 660, maxLines: 61 },
      state: "available",
    },
  ), false, "a disjoint window may add genuinely new source evidence");

  const prompt = buildExecuteRecoveryPrompt({
    language: "zh",
    reason: "target_progress_mutation_failure",
    contract: resolveExecuteRecoveryActionContract("mutation_first", {
      expectedTarget: "src/App.tsx",
      readLease: exactLease,
    }),
    repeatedTargets: ["src/App.tsx"],
    recentActivity: recent,
  });
  assert.match(prompt, /补丁失败可能是格式错误、无变化或上下文不匹配/);
  assert.match(prompt, /next=targeted_read/);
  assert.match(prompt, /不能默认再读一次文件/);
});

test("mutation mismatch grants only a precise one-shot read and otherwise reuses retained source", () => {
  const replaceDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    executeRecoveryMode: "normal",
    results: [{
      name: "replace_in_file",
      target: "src-tauri/src/main.rs",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED",
      isError: true,
      lifecycleState: "blocked",
      mutationPreflightReason: "search_text_mismatch",
    }],
  });
  assert.equal(replaceDecision?.mode, "mutation_first");
  assert.equal(replaceDecision?.reason, "mutation_preflight_search_text_mismatch");
  assert.equal(replaceDecision?.readLease, null);
  assert.equal(replaceDecision?.decisionCheckpoint.nextRequiredCapability, "mutation");

  const patchDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    executeRecoveryMode: "normal",
    results: [{
      name: "apply_patch",
      target: "src-tauri/src/main.rs",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED",
      isError: true,
      lifecycleState: "blocked",
      mutationPreflightReason: "invalid_patch",
    }],
  });
  assert.equal(patchDecision?.mode, "mutation_first");
  assert.equal(patchDecision?.reason, "mutation_preflight_invalid_patch");
  assert.equal(patchDecision?.readLease, null);

  const retainedObservationDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    executeRecoveryMode: "mutation_first",
    retainedSourceObservation: {
      key: "src/main.js::26895:1784042986186::361-540",
      path: "src/main.js",
      requestSignature: 'read_file::src/main.js::[["max_lines",180],["start_line",361]]',
      versionToken: "26895:1784042986186",
      source: "fresh",
    },
    results: [{
      name: "apply_patch",
      target: "src/main.js",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED",
      isError: true,
      mutationPreflightReason: "invalid_patch",
    }],
  });
  assert.equal(retainedObservationDecision?.mode, "mutation_first");
  assert.equal(retainedObservationDecision?.readLease, null);
  assert.equal(
    retainedObservationDecision?.sourceObservationKey,
    "src/main.js::26895:1784042986186::361-540",
  );
  assert.equal(
    retainedObservationDecision?.decisionCheckpoint.evidenceVersion,
    "26895:1784042986186",
  );
  const activated = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    retainedObservationDecision,
  );
  const activatedContract = resolveExecuteRecoveryActionContract(activated.mode, activated);
  assert.equal(activated.mode, "mutation_first");
  assert.equal(activatedContract.nextRequiredCapability, "mutation");
  assert.equal(activatedContract.allowedToolNames.has("read_file"), false);

  const versionedDecision = resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    executeRecoveryMode: "normal",
    results: [{
      name: "apply_patch",
      target: "src/main.js",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED",
      isError: true,
      mutationPreflightReason: "invalid_patch",
      patchRecoveryMismatch: {
        mismatchFingerprint: "patch_mismatch::src/main.js::invalid_patch::mutation-a1",
        target: "./src/main.js",
        requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
        observedVersion: "8192:1700000000000",
      },
    }],
  });
  assert.equal(versionedDecision?.mode, "patch_recovery_read");
  assert.equal(
    versionedDecision?.decisionCheckpoint.evidenceVersion,
    "8192:1700000000000",
  );
  assert.deepEqual(versionedDecision?.readLease, {
    purpose: "patch_recovery",
    target: "src/main.js",
    requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    observedVersion: "8192:1700000000000",
    mismatchFingerprint: "patch_mismatch::src/main.js::invalid_patch::mutation-a1",
    state: "available",
  });
  assert.equal(
    versionedDecision?.decisionCheckpoint.nextRequiredCapability,
    "targeted_read",
  );

  for (const activeMode of [
    "validation_only",
    "finite_validation_only",
    "objective_audit",
  ]) {
    const phaseReplacementDecision = resolveDirectMutationPreflightRecovery({
      workflowMode: "edit",
      runtimeIntent: "execute",
      executeRecoveryMode: activeMode,
      results: [{
        name: "replace_in_file",
        target: "src/main.js",
        content: "Error: MUTATION_PREFLIGHT_BLOCKED",
        isError: true,
        lifecycleState: "blocked",
        mutationPreflightReason: "search_text_mismatch",
        patchRecoveryMismatch: {
          mismatchFingerprint:
            `patch_mismatch::src/main.js::search_text_mismatch::${activeMode}`,
          target: "src/main.js",
          requestedRange: { startLine: 900, endLine: 980, maxLines: 81 },
          observedVersion: "16384:1700000000000",
        },
      }],
    });
    assert.equal(
      phaseReplacementDecision?.mode,
      "patch_recovery_read",
      `${activeMode} must yield to a concrete mutation mismatch`,
    );
    assert.equal(
      phaseReplacementDecision?.decisionCheckpoint.nextRequiredCapability,
      "targeted_read",
    );
  }

  assert.equal(resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    executeRecoveryMode: "patch_recovery_read",
    results: [{
      name: "apply_patch",
      target: "src-tauri/src/main.rs",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED",
      isError: true,
      mutationPreflightReason: "invalid_patch",
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
    expectedTarget: "src/App.tsx",
    contract: resolveExecuteRecoveryActionContract("patch_recovery_read", {
      expectedTarget: "src/App.tsx",
      readLease: {
        purpose: "missing_window",
        target: "src/App.tsx",
        state: "available",
      },
    }),
  });
  assert.equal(context.phase, "need_context");
  assert.equal(context.selectedCallId, "target-read", "an active source lease remains the preferred action");
  assert.deepEqual(context.deferredCallIds.sort(), ["edit", "validate-first", "wrong-read"]);

  const mutationBeatsLease = resolveExecuteRecoveryBatchDecision({
    mode: "patch_recovery_read",
    calls: [
      { id: "cached-read", name: "read_file", target: "src/App.tsx" },
      { id: "current-edit", name: "apply_patch", target: "src/App.tsx" },
      { id: "new-window", name: "read_file", target: "src/App.tsx" },
    ],
    expectedTarget: "src/App.tsx",
    contract: resolveExecuteRecoveryActionContract("patch_recovery_read", {
      expectedTarget: "src/App.tsx",
      readLease: {
        purpose: "patch_recovery",
        target: "src/App.tsx",
        requestedRange: { startLine: 100, endLine: 150 },
        state: "available",
      },
    }),
  });
  assert.equal(mutationBeatsLease.selectedCallId, "cached-read");
  assert.deepEqual(mutationBeatsLease.deferredCallIds, ["current-edit", "new-window"]);

  const wrongTargetOnly = resolveExecuteRecoveryBatchDecision({
    mode: "patch_recovery_read",
    calls: [{ id: "wrong-read", name: "read_file", target: "src/other.ts" }],
    expectedTarget: "src/App.tsx",
    contract: resolveExecuteRecoveryActionContract("patch_recovery_read", {
      expectedTarget: "src/App.tsx",
      readLease: {
        purpose: "missing_window",
        target: "src/App.tsx",
        state: "available",
      },
    }),
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

  const mutationReadOnly = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [{ id: "read-again", name: "read_file", target: "src/App.tsx" }],
    expectedTarget: "src/App.tsx",
  });
  assert.equal(mutationReadOnly.phase, "need_mutation");
  assert.equal(mutationReadOnly.selectedCallId, null);
  assert.deepEqual(mutationReadOnly.deferredCallIds, ["read-again"]);
  const mutationContract = resolveExecuteRecoveryActionContract("mutation_first", {
    expectedTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::v1::1-100",
  });
  assert.equal(mutationContract.allowTargetedFileRead, false);
  assert.equal(mutationContract.allowedToolNames.has("read_file"), false);
  assert.equal(mutationContract.surfaceDescription, "capability:mutation");

  const mutationAfterReadNoProgress = resolveExecuteRecoveryActionContract("mutation_first", {
    expectedTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::v1::1-100",
    protocolNoProgressCount: 1,
    protocolNoProgressFingerprint:
      "mutation_first::::read_file:src/App.tsx:read_unchanged::mutation::src/App.tsx::v1::unleased::same_window::::mutation::::::",
  });
  assert.equal(mutationAfterReadNoProgress.allowTargetedFileRead, false);
  assert.equal(mutationAfterReadNoProgress.allowedToolNames.has("read_file"), false);
  assert.equal(mutationAfterReadNoProgress.allowedToolNames.has("grep_search"), false);
  assert.equal(mutationAfterReadNoProgress.allowedToolNames.has("apply_patch"), true);
  assert.equal(mutationAfterReadNoProgress.allowedToolNames.has("run_command"), false);
  assert.equal(
    mutationAfterReadNoProgress.surfaceDescription,
    "capability:mutation",
  );
  const stableReadBatch = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    contract: mutationAfterReadNoProgress,
    expectedTarget: "src/App.tsx",
    calls: [{ id: "read-again", name: "read_file", target: "src/App.tsx" }],
  });
  assert.equal(stableReadBatch.selectedCallId, null);
  assert.deepEqual(stableReadBatch.deferredCallIds, ["read-again"]);

  const mutationAfterNoToolProgress = resolveExecuteRecoveryActionContract("mutation_first", {
    expectedTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::v1::1-100",
    phaseNoProgressCount: 2,
  });
  assert.equal(mutationAfterNoToolProgress.allowTargetedFileRead, false);
  assert.equal(mutationAfterNoToolProgress.allowedToolNames.has("read_file"), false);
  assert.equal(mutationAfterNoToolProgress.allowedToolNames.has("grep_search"), false);
  assert.equal(mutationAfterNoToolProgress.allowedToolNames.has("apply_patch"), true);
  assert.equal(mutationAfterNoToolProgress.allowedToolNames.has("run_command"), false);
  assert.equal(
    mutationAfterNoToolProgress.surfaceDescription,
    "capability:mutation",
  );

  const validationAfterNoToolProgress = resolveExecuteRecoveryActionContract("validation_only", {
    expectedTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::v1::1-100",
    phaseNoProgressCount: 2,
  });
  assert.equal(validationAfterNoToolProgress.allowTargetedFileRead, false);
  assert.equal(validationAfterNoToolProgress.allowedToolNames.has("read_file"), false);
  assert.equal(validationAfterNoToolProgress.allowedToolNames.has("grep_search"), false);
  assert.equal(validationAfterNoToolProgress.allowedToolNames.has("apply_patch"), false);
  assert.equal(validationAfterNoToolProgress.allowedToolNames.has("run_command"), true);
  assert.equal(
    validationAfterNoToolProgress.surfaceDescription,
    "capability:validation",
  );

  const mutationValidationOnly = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    calls: [{ id: "browser-too-soon", name: "browser_evaluate", target: "http://localhost:1420/" }],
    expectedTarget: "src/App.tsx",
  });
  assert.equal(
    mutationValidationOnly.selectedCallId,
    null,
    "a visible validation tool must not jump over the current Plan mutation obligation",
  );
  assert.deepEqual(mutationValidationOnly.deferredCallIds, ["browser-too-soon"]);

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

  const legacyActionOnlyWrongMutation = resolveExecuteRecoveryBatchDecision({
    mode: "action_only",
    calls: [{ id: "wrong-edit", name: "write_file", target: "src/other.ts" }],
    expectedTarget: "src/App.tsx",
  });
  assert.equal(legacyActionOnlyWrongMutation.selectedCallId, null);
  assert.deepEqual(legacyActionOnlyWrongMutation.deferredCallIds, ["wrong-edit"]);

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

  const finiteBrowserContract = resolveExecuteRecoveryActionContract("finite_validation_only", {
    decisionCheckpoint: {
      expectedTarget: null,
      sourceObservationKey: null,
      nextRequiredCapability: "browser_validation",
    },
  });
  assert.equal(finiteBrowserContract.nextRequiredCapability, "launch_long_process");
  assert.deepEqual(finiteBrowserContract.toolCallRequirement, {
    kind: "required_named",
    toolName: "execute_command",
  });
  const finiteBrowserValidation = resolveExecuteRecoveryBatchDecision({
    mode: "finite_validation_only",
    contract: finiteBrowserContract,
    calls: [
      { id: "stale-command", name: "run_command", target: "npm test" },
      { id: "browser", name: "browser_evaluate", target: "http://localhost:1420/" },
      { id: "launch", name: "execute_command", target: "npm run dev" },
    ],
  });
  assert.equal(
    finiteBrowserValidation.selectedCallId,
    "launch",
    "a browser obligation must satisfy its process prerequisite before browser validation",
  );
  assert.deepEqual(finiteBrowserValidation.deferredCallIds, ["stale-command", "browser"]);

  const readyBrowserContract = resolveExecuteRecoveryActionContract("validation_only", {
    expectedTarget: "src/main.js",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: null,
      nextRequiredCapability: "browser_validation",
      objectiveClosurePending: true,
    },
    devServerStatus: "ready",
    devServerNextCapability: "browser",
    devServerUrl: "http://localhost:1420/",
  });
  const soleReadyBrowserValidation = resolveExecuteRecoveryBatchDecision({
    mode: "validation_only",
    contract: readyBrowserContract,
    expectedTarget: "src/main.js",
    calls: [{ id: "browser-only", name: "browser_evaluate", target: "http://localhost:1420/" }],
  });
  assert.equal(readyBrowserContract.nextRequiredCapability, "browser_validation");
  assert.equal(
    soleReadyBrowserValidation.selectedCallId,
    "browser-only",
    "the sole tool advertised for the active recovery capability must execute rather than self-defer",
  );
  assert.deepEqual(soleReadyBrowserValidation.deferredCallIds, []);

  const commandValidationContract = resolveExecuteRecoveryActionContract("validation_only", {
    decisionCheckpoint: {
      expectedTarget: null,
      sourceObservationKey: null,
      nextRequiredCapability: "validation",
      pendingFiniteValidation: { command: "npm test", cwd: "." },
    },
  });
  assert.deepEqual(commandValidationContract.toolCallRequirement, {
    kind: "required_named",
    toolName: "run_command",
  });
  const commandValidation = resolveExecuteRecoveryBatchDecision({
    mode: "validation_only",
    contract: commandValidationContract,
    calls: [
      { id: "browser-too-soon", name: "browser_evaluate", target: "http://localhost:1420/" },
      { id: "probe-first", name: "run_command", target: "lsof -i :1420" },
      { id: "focused-command", name: "run_command", target: "npm test" },
    ],
  });
  assert.equal(commandValidation.selectedCallId, "focused-command");
  assert.deepEqual(commandValidation.deferredCallIds, ["browser-too-soon", "probe-first"]);

  const unpinnedValidationContract = resolveExecuteRecoveryActionContract("validation_only", {
    expectedTarget: "src/main.js",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "src-main-v1",
      nextRequiredCapability: "validation",
      objectiveClosurePending: true,
    },
  });
  assert.equal(unpinnedValidationContract.surfaceDescription, "capability:validation");
  assert.deepEqual(unpinnedValidationContract.toolCallRequirement, {
    kind: "required_named",
    toolName: "run_command",
  });
  assert.equal(unpinnedValidationContract.allowedToolNames.has("run_command"), true);
  assert.equal(unpinnedValidationContract.allowedToolNames.has("read_file"), false);

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
  assert.doesNotMatch(
    toolCallExecutionPhaseSource,
    /refundExecuteRecoveryRuntimeIteration/,
    "policy deferrals and cache stubs must not refresh the recovery budget",
  );
});

test("a fresh unleased target window cannot refresh the mutation checkpoint", () => {
  const state = activateExecuteRecoveryRuntimeState(createExecuteRecoveryRuntimeState({ workflowMode: "edit" }), {
    mode: "mutation_first",
    reason: "approved_plan_target_context_observed",
    expectedTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::v1::1-100",
    decisionCheckpoint: {
      expectedTarget: "src/App.tsx",
      sourceObservationKey: "src/App.tsx::v1::1-100",
      nextRequiredCapability: "mutation",
      evidenceVersion: "v1",
    },
  });
  const advanced = advanceExecuteRecoveryRuntimeIteration(state).state;
  const transition = transitionExecuteRecoveryRuntimeState(advanced, {
    expectedTarget: "src/App.tsx",
    freshReadTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::v1::101-200",
    sourceRequestedRange: { startLine: 101, endLine: 200, maxLines: 100 },
    sourceObservedVersion: "v1",
  });

  assert.equal(transition.transition, "none");
  assert.equal(transition.state.phaseNoProgressCount, 1);
  assert.equal(transition.state.sourceObservationKey, "src/App.tsx::v1::1-100");
  assert.equal(transition.state.expectedTarget, "src/App.tsx");
  assert.equal(transition.state.decisionCheckpoint?.nextRequiredCapability, "mutation");
});

test("approved Plan source context requires a parser-backed declaration, not a call-site mention", () => {
  const task = {
    id: "task-toolbar",
    text: "Modify `initToolbar()` in `src/main.js` to install the reviewed toolbar behavior.",
    status: "pending",
    evidence: [{ kind: "file", value: "src/main.js" }],
  };
  const readResult = (startLine, endLine, content, versionToken = "9000:100") => ({
    toolCallId: `read-${startLine}`,
    name: "read_file",
    target: "src/main.js",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "truncated: true",
      "totalLines: 700",
      "totalChars: 30000",
      `returnedLines: ${startLine}-${endLine}`,
      `returnedChars: ${content.length}`,
      "---CONTENT START---",
      content,
      "---CONTENT END---",
    ].join("\n"),
    isError: false,
    readFileObservation: {
      key: `read_file::src/main.js::[[\"start_line\",${startLine}],[\"end_line\",${endLine}]]::version=${versionToken}`,
      path: "src/main.js",
      requestSignature: `read_file::src/main.js::[[\"end_line\",${endLine}],[\"start_line\",${startLine}]]`,
      versionToken,
      source: "fresh",
    },
  });
  const headRead = readResult(1, 50, "bootstrap();\ninitToolbar();");
  const baseInput = {
    tasks: [task],
    evidenceLedger: [],
    results: [headRead],
  };

  const withoutAst = resolveApprovedPlanMutationContextDecision(baseInput);
  assert.equal(withoutAst.status, "needs_targeting");
  assert.equal(withoutAst.target, "src/main.js");

  const astObservation = {
    name: "code_ast_query",
    target: "src/main.js",
    status: "succeeded",
    astObservation: {
      path: "src/main.js",
      language: "javascript",
      versionToken: "9000:100",
      query: "",
      exactMatchCount: 0,
      hasErrors: false,
      truncated: false,
      symbols: [{
        name: "initToolbar",
        kind: "function",
        syntaxKind: "function_declaration",
        startLine: 600,
        endLine: 650,
      }],
    },
  };
  const callSiteOnly = resolveApprovedPlanMutationContextDecision({
    ...baseInput,
    recentToolActivity: [astObservation],
  });
  assert.deepEqual(callSiteOnly, {
    status: "needs_range_read",
    target: "src/main.js",
    requestedRange: { startLine: 600, endLine: 650, maxLines: 51 },
    observedVersion: "9000:100",
    symbolName: "initToolbar",
    rangeSource: "ast_declaration",
  });

  const definitionRead = readResult(600, 650, "function initToolbar() {\n  bindToolbar();\n}");
  const covered = resolveApprovedPlanMutationContextDecision({
    ...baseInput,
    results: [definitionRead],
    recentToolActivity: [astObservation],
  });
  assert.equal(covered.status, "covered");
  assert.equal(covered.result.toolCallId, "read-600");
  assert.equal(covered.symbolName, "initToolbar");
});

test("reviewed Plan line anchors retain an exact read contract", () => {
  const decision = resolveApprovedPlanMutationContextDecision({
    tasks: [{
      id: "task-lines",
      text: "Modify `src/main.js` at L205-L256.",
      status: "pending",
      evidence: [{ kind: "file", value: "src/main.js" }],
    }],
    evidenceLedger: [],
    results: [{
      toolCallId: "read-lines-head",
      name: "read_file",
      target: "src/main.js",
      content: "READ_FILE_RESULT\npath: src/main.js\ntruncated: true\ntotalLines: 700\ntotalChars: 30000\nreturnedLines: 1-20\nreturnedChars: 200\n---CONTENT START---\nbootstrap();\n---CONTENT END---",
      isError: false,
      readFileObservation: {
        key: "lines-head-v1",
        path: "src/main.js",
        requestSignature: "read_file::src/main.js::[[\"end_line\",20],[\"start_line\",1]]",
        versionToken: "30000:100",
        source: "fresh",
      },
    }],
  });
  assert.deepEqual(decision, {
    status: "needs_range_read",
    target: "src/main.js",
    requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    observedVersion: "30000:100",
    symbolName: null,
    rangeSource: "plan_line",
  });
});

test("approved Plan declaration targeting rejects stale, substring, and ambiguous AST evidence", () => {
  const task = {
    id: "task-toolbar",
    text: "Modify `initToolbar()` in `src/main.js`.",
    status: "pending",
    evidence: [{ kind: "file", value: "src/main.js" }],
  };
  const read = {
    toolCallId: "read-head",
    name: "read_file",
    target: "src/main.js",
    content: "READ_FILE_RESULT\npath: src/main.js\ntruncated: true\ntotalLines: 700\ntotalChars: 30000\nreturnedLines: 1-50\nreturnedChars: 20\n---CONTENT START---\ninitToolbar();\n---CONTENT END---",
    isError: false,
    readFileObservation: {
      key: "head-v2",
      path: "src/main.js",
      requestSignature: "read_file::src/main.js::[[\"end_line\",50],[\"start_line\",1]]",
      versionToken: "9001:200",
      source: "fresh",
    },
  };
  const decide = (astObservation) => resolveApprovedPlanMutationContextDecision({
    tasks: [task],
    evidenceLedger: [],
    results: [read],
    recentToolActivity: [{
      name: "code_ast_query",
      target: "src/main.js",
      status: "succeeded",
      astObservation,
    }],
  });
  const baseAst = {
    path: "src/main.js",
    language: "javascript",
    versionToken: "9001:200",
    query: "",
    exactMatchCount: 0,
    hasErrors: false,
    truncated: false,
  };

  assert.equal(decide({
    ...baseAst,
    versionToken: "9000:100",
    symbols: [{ name: "initToolbar", kind: "function", syntaxKind: "function_declaration", startLine: 600, endLine: 650 }],
  }).status, "needs_targeting", "an AST snapshot from an older file version cannot own the edit");
  assert.equal(decide({
    ...baseAst,
    symbols: [{ name: "initToolbarLegacy", kind: "function", syntaxKind: "function_declaration", startLine: 600, endLine: 650 }],
  }).status, "none", "substring matches are not declaration identity");
  assert.equal(decide({
    ...baseAst,
    symbols: [
      { name: "initToolbar", kind: "function", syntaxKind: "function_declaration", startLine: 100, endLine: 120 },
      { name: "initToolbar", kind: "function", syntaxKind: "function_declaration", startLine: 600, endLine: 650 },
    ],
  }).status, "none", "two disjoint declarations require an explicit reviewed range");
});

test("truncated AST targeting requires an exact identifier query and then converges", () => {
  const task = {
    id: "task-toolbar-truncated",
    text: "Modify `initToolbar()` in `src/main.js`.",
    status: "pending",
    evidence: [{ kind: "file", value: "src/main.js" }],
  };
  const headRead = {
    toolCallId: "read-head-truncated",
    name: "read_file",
    target: "src/main.js",
    content: "READ_FILE_RESULT\npath: src/main.js\ntruncated: true\ntotalLines: 900\ntotalChars: 50000\nreturnedLines: 1-40\nreturnedChars: 1200\n---CONTENT START---\ninitToolbar();\n---CONTENT END---",
    isError: false,
    readFileObservation: {
      key: "head-v3",
      path: "src/main.js",
      requestSignature: "read_file::src/main.js::[[\"end_line\",40],[\"start_line\",1]]",
      versionToken: "50000:300",
      source: "fresh",
    },
  };
  const decide = (astObservation) => resolveApprovedPlanMutationContextDecision({
    tasks: [task],
    evidenceLedger: [],
    results: [headRead],
    recentToolActivity: [{
      name: "code_ast_query",
      target: "src/main.js",
      status: "succeeded",
      astObservation,
    }],
  });
  const generic = decide({
    path: "src/main.js",
    language: "javascript",
    versionToken: "50000:300",
    query: "",
    exactMatchCount: 0,
    hasErrors: false,
    truncated: true,
    symbols: [{
      name: "initToolbar",
      kind: "function",
      syntaxKind: "function_declaration",
      startLine: 600,
      endLine: 850,
    }],
  });
  assert.equal(generic.status, "needs_targeting");
  assert.equal(generic.targetingReason, "precise_query_required");

  const precise = decide({
    path: "src/main.js",
    language: "javascript",
    versionToken: "50000:300",
    query: "inittoolbar",
    exactMatchCount: 1,
    hasErrors: false,
    truncated: true,
    symbols: [{
      name: "initToolbar",
      kind: "function",
      syntaxKind: "function_declaration",
      startLine: 600,
      endLine: 850,
    }],
  });
  assert.equal(precise.status, "needs_range_read");
  assert.deepEqual(precise.requestedRange, {
    startLine: 600,
    endLine: 850,
    maxLines: 251,
  });
});

test("recovery allows six phase requests and pauses before the seventh", () => {
  let state = activateExecuteRecoveryRuntimeState(createExecuteRecoveryRuntimeState({ workflowMode: "edit" }), {
    mode: "mutation_first",
    reason: "bounded_mutation_retry",
    expectedTarget: "src/App.tsx",
  });
  let reached = false;
  for (let index = 1; index <= 7; index += 1) {
    const advanced = advanceExecuteRecoveryRuntimeIteration(state);
    state = advanced.state;
    reached = advanced.reachedMaxIterations;
    assert.equal(reached, index === 7);
  }
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
    contract: resolveExecuteRecoveryActionContract("patch_recovery_read", {
      expectedTarget: "src/App.tsx",
      readLease: {
        purpose: "patch_recovery",
        target: "src/App.tsx",
        requestedRange: { startLine: 1, maxLines: 1000 },
        state: "available",
      },
    }),
    repeatedTargets: summarizeRepeatedExecuteTargets(recent),
    recentActivity: recent,
  });
  assert.match(prompt, /确实缺少精确源码且本轮实际提供 read_file/);
  assert.match(prompt, /依据结构化工具错误处理/);
  assert.match(prompt, /只调用一个有用工具/);
  assert.doesNotMatch(prompt, /patch 控制在 1-3 个/);
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
    workflowMode: "edit",
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

test("approved Plan provenance receives a full execution budget in execute workflow", () => {
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
    workflowMode: "edit",
    runtimeIntent: "execute",
    isPlanApproved: true,
    currentIteration: 0,
    planExecutionStartIteration: 0,
    limits: { planDraft: 25, planExecution: 50 },
  });
  assert.deepEqual(execution, {
    phase: "plan_execution",
    phaseStartIteration: 0,
    phaseMaxIterations: 50,
    absoluteMaxIterations: 50,
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
    workflowMode: "edit",
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

test("empty model response pause is provider-neutral and preserves recovery context", () => {
  const notice = buildEmptyModelResponsePauseNotice({
    language: "zh",
    emptyResponses: 2,
    repeatedTargets: ["src/App.tsx"],
    localProfile: true,
  });
  assert.match(notice, /2 次空响应/);
  assert.match(notice, /已有上下文和工具协议/);
  assert.doesNotMatch(notice, /本地模型|网关|上游模型/);
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
  assert.match(toolCallPlanningSource, /const allowExecuteRecoveryFileRead = recoveryActionContract\.allowTargetedFileRead/);
  assert.match(toolCallPlanningSource, /adaptiveFileReadAllowed: allowExecuteRecoveryFileRead/);
  assert.match(source, /prepareManagedMessagesForIteration\(\{/);
  assert.match(contextManagementSource, /execute_recovery_context_compacted/);
  assert.match(contextManagementSource, /isExecuteRecoveryEligible && contextForceForManagement\?\.shouldForce/);
  assert.match(contextManagementSource, /execute_recovery_context_skipped/);
  assert.match(
    contextManagementSource,
    /contextForceForManagement\.shouldForce \|\| cloudResponsesCompact/,
    "low-pressure local turns must not prune source observations every iteration",
  );
  assert.match(source, /activateExecuteRecovery\(recoveryMode, "execute_convergence_prompt"/);
  assert.match(streamInvocationSource, /const recoveryToolChoice =[\s\S]*toolChoice: recoveryToolChoice/);
  assert.match(executeRecoveryRuntimeSource, /attempts: state\.attempts \+ 1/);
  assert.match(executeRecoveryRuntimeSource, /MAX_EXECUTE_RECOVERY_ITERATIONS = 6/);
  assert.match(executeRecoveryRuntimeSource, /phaseNoProgressCount > MAX_EXECUTE_RECOVERY_ITERATIONS/);
  assert.doesNotMatch(source, /executeRecoveryReason !== reason/);
  assert.match(loopControlRuntimeSource, /resolveAgentLoopIterationBudget/);
  assert.match(streamInvocationSource, /buildMaxStepsFinalTextPrompt/);
  assert.match(source, /emitRunPausedEvent\([\s\S]*"max_iterations_boundary"/);
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

  const callbackIndex = source.indexOf("const handling = await handler?.(checkpoint);");
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

test("distinct read windows still converge at the bounded evidence budget", () => {
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
  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "read_only_evidence_budget");
});

test("segmented recovery reads use ordinary versioned cache eligibility without a bypass", () => {
  const toolCallPartitioningSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"),
    "utf8",
  );
  assert.doesNotMatch(toolCallPartitioningSource, /shouldUseExecutePatchRecoveryReadLease/);
  assert.doesNotMatch(toolCallPartitioningSource, /executePatchRecoveryReadLeaseClaimed/);
  assert.doesNotMatch(toolCallPartitioningSource, /execute_patch_recovery_read_cache_bypass/);
  assert.doesNotMatch(
    toolCallPartitioningSource,
    /tc\.name === "read_file" &&\s*effectiveExecuteRecoveryFileRead\)/,
    "ordinary recovery reads must not bypass path + argument cache signatures",
  );
});

test("validation reopens distinct edit obligations independently from generic recovery attempts", () => {
  const recoveryState = {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: "src/main.js",
    attempts: 2,
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    iterationCount: 0,
    readLease: null,
    sourceObservationKey: "src-main-v1",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "src-main-v1",
      nextRequiredCapability: "validation",
      pendingFiniteValidation: { command: "npm test", cwd: "." },
      objectiveMutationEvidence: [{ target: "src/main.js", requirementRef: "REQ-OPEN" }],
      objectiveClosurePending: true,
    },
  };
  const first = resolveValidationMutationReopen({
    recoveryState,
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "replace-preview",
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/main.js",
        search_text: "renderEditor(oldValue)",
        replace_text: "renderEditor(newValue)",
      }),
    }],
  });
  assert.deepEqual(first?.requestedTools, ["replace_in_file"]);
  assert.deepEqual(first?.requestedTargets, ["src/main.js"]);
  assert.match(first?.semanticFingerprints[0] || "", /tool:replace_in_file\|target:src\/main\.js\|locus:[0-9a-f]{8}/);

  const spentState = {
    ...recoveryState,
    decisionCheckpoint: {
      ...recoveryState.decisionCheckpoint,
      validationMutationReopenCount: 1,
      validationMutationReopenFingerprints: first.semanticFingerprints,
    },
  };
  assert.equal(resolveValidationMutationReopen({
    recoveryState: spentState,
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "replace-preview-again",
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/main.js",
        search_text: "renderEditor(oldValue)",
        replace_text: "renderEditor(newValue)",
      }),
    }],
  }), null, "the same target and edit locus is a bounded semantic retry");

  const sameFileDifferentLocus = resolveValidationMutationReopen({
    recoveryState: spentState,
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "replace-label",
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/main.js",
        search_text: "createInitialDocument()",
        replace_text: "restoreInitialDocumentIfNeeded()",
      }),
    }],
  });
  assert.deepEqual(sameFileDifferentLocus?.requestedTargets, ["src/main.js"]);
  assert.notEqual(
    sameFileDifferentLocus?.semanticFingerprints[0],
    first.semanticFingerprints[0],
    "a distinct locus in the same file remains executable",
  );

  const distinctTarget = resolveValidationMutationReopen({
    recoveryState: {
      ...spentState,
      decisionCheckpoint: {
        ...spentState.decisionCheckpoint,
        validationMutationReopenCount: 2,
        validationMutationReopenFingerprints: [
          ...first.semanticFingerprints,
          ...sameFileDifferentLocus.semanticFingerprints,
        ],
      },
    },
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "replace-toolbar",
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/components/toolbar.js",
        search_text: "openDialog()",
        replace_text: "openMarkdownDialog()",
      }),
    }],
  });
  assert.deepEqual(distinctTarget?.requestedTargets, ["src/components/toolbar.js"]);
  assert.equal(distinctTarget?.budgetExhausted, false, "a third distinct edit remains executable");
  assert.equal(MAX_VALIDATION_MUTATION_REOPENS, 8, "the hard safety fuse permits multi-part objectives");
  const exhausted = resolveValidationMutationReopen({
    recoveryState: {
      ...spentState,
      decisionCheckpoint: {
        ...spentState.decisionCheckpoint,
        validationMutationReopenCount: MAX_VALIDATION_MUTATION_REOPENS,
        validationMutationReopenFingerprints: [
          ...first.semanticFingerprints,
          ...sameFileDifferentLocus.semanticFingerprints,
          ...distinctTarget.semanticFingerprints,
        ],
      },
    },
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "third-distinct-reopen",
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/components/toolbar.js",
        search_text: "openAnotherDialog()",
        replace_text: "openFinalDialog()",
      }),
    }],
  });
  assert.equal(exhausted?.budgetExhausted, true, "the ninth distinct reopen is stopped by the hard safety fuse");
  assert.equal(resolveValidationMutationReopen({
    recoveryState,
    protocolViolation: "required_tool_call_missing",
    protocolActualTools: [],
  }), null);
  assert.equal(resolveValidationMutationReopen({
    recoveryState,
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["read_file"],
  }), null);
  assert.equal(resolveValidationMutationReopen({
    recoveryState,
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["manage_script"],
    protocolActualToolCalls: [{
      index: 0,
      id: "inspect-only",
      name: "manage_script",
      arguments: JSON.stringify({ action: "inspect", path: "Assets/Scripts", name: "Player" }),
    }],
  }), null, "a dynamic read action cannot reopen the validation mutation budget");
});

test("validation mutation reopen resolves provider-facing tool names through the current catalog", () => {
  const recoveryState = {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: "src/main.js",
    attempts: 1,
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    iterationCount: 0,
    readLease: null,
    sourceObservationKey: "src-main-v1",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "src-main-v1",
      nextRequiredCapability: "validation",
      pendingFiniteValidation: { command: "npm test", cwd: "." },
    },
  };
  const exposedMutationName = "mcp__editor__replace__7acbd820";
  const exposedReadName = "mcp__reader__replace_in_file__98ba01e1";
  const toolCatalog = {
    lookup(name) {
      if (name === exposedMutationName) {
        return {
          status: "resolved",
          requestedName: name,
          via: "exposed",
          entry: { executionName: "replace_in_file" },
        };
      }
      if (name === exposedReadName) {
        return {
          status: "resolved",
          requestedName: name,
          via: "exposed",
          entry: { executionName: "read_file" },
        };
      }
      return { status: "unknown", requestedName: name };
    },
  };
  const providerCall = {
    index: 0,
    id: "canonical-edit",
    name: exposedMutationName,
    arguments: JSON.stringify({
      path: "src/main.js",
      search_text: "oldValue",
      replace_text: "newValue",
    }),
  };
  const reopen = resolveValidationMutationReopen({
    recoveryState,
    toolCatalog,
    protocolViolation: "required_function_call_mismatch",
    protocolActualTools: [exposedMutationName],
    protocolActualToolCalls: [providerCall],
  });

  assert.deepEqual(reopen?.requestedTools, [exposedMutationName]);
  assert.deepEqual(reopen?.requestedTargets, ["src/main.js"]);
  assert.match(reopen?.semanticFingerprints[0] || "", /^tool:replace_in_file\|/);
  assert.doesNotMatch(reopen?.semanticFingerprints[0] || "", /mcp__editor/);
  assert.equal(providerCall.name, exposedMutationName, "semantic resolution must not rewrite the provider protocol call");

  assert.equal(resolveValidationMutationReopen({
    recoveryState,
    toolCatalog,
    protocolViolation: "required_function_call_mismatch",
    protocolActualTools: [exposedReadName],
    protocolActualToolCalls: [{
      ...providerCall,
      id: "canonical-read",
      name: exposedReadName,
    }],
  }), null, "an exposed name that looks mutating cannot reopen when its execution tool is read-only");
});

test("direct-edit validation reopens only after a finite command is pinned", () => {
  const recoveryState = {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: "src/main.js",
    attempts: 1,
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    iterationCount: 0,
    readLease: null,
    sourceObservationKey: "src-main-v1",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "src-main-v1",
      nextRequiredCapability: "validation",
      objectiveMutationEvidence: [{ target: "src/main.js" }],
      objectiveClosurePending: true,
    },
  };
  assert.equal(resolveValidationMutationReopen({
    recoveryState,
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "second-edit",
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/main.js",
        search_text: "old open handler",
        replace_text: "new open handler",
      }),
    }],
  }), null);
  const reopen = resolveValidationMutationReopen({
    recoveryState: {
      ...recoveryState,
      decisionCheckpoint: {
        ...recoveryState.decisionCheckpoint,
        pendingFiniteValidation: { command: "npm run build", cwd: "." },
      },
    },
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "second-edit-after-pin",
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/main.js",
        search_text: "old open handler",
        replace_text: "new open handler",
      }),
    }],
  });
  assert.deepEqual(reopen?.requestedTools, ["replace_in_file"]);
  assert.equal(reopen?.budgetExhausted, false);

});

test("pinning a trusted validation command is attempt-neutral on the command-only surface", () => {
  const mutationTransition = transitionExecuteRecoveryRuntimeState(
    {
      mode: "mutation_first",
      reason: "read_only_evidence_budget",
      expectedTarget: "src/main.js",
      attempts: 2,
      phaseNoProgressCount: 1,
      protocolNoProgressCount: 1,
      protocolNoProgressFingerprint: "same-edit",
      iterationCount: 1,
      readLease: null,
      sourceObservationKey: "src-main-v1",
      decisionCheckpoint: {
        expectedTarget: "src/main.js",
        sourceObservationKey: "src-main-v1",
        nextRequiredCapability: "mutation",
      },
    },
    { mutationTarget: "src/main.js", mutationTargets: ["src/main.js"] },
  );
  assert.equal(mutationTransition.state.mode, "validation_only");
  assert.equal(mutationTransition.state.decisionCheckpoint?.pendingFiniteValidation, undefined);

  const pinned = pinExecuteRecoveryFiniteValidationCheckpoint(
    mutationTransition.state,
    { command: "npm run build", cwd: "." },
  );
  assert.equal(pinned.attempts, mutationTransition.state.attempts);
  assert.equal(pinned.phaseNoProgressCount, mutationTransition.state.phaseNoProgressCount);
  assert.deepEqual(pinned.decisionCheckpoint?.pendingFiniteValidation, {
    command: "npm run build",
    cwd: ".",
  });
  const contract = resolveExecuteRecoveryActionContract(pinned.mode, pinned);
  assert.equal(contract.allowedToolNames.has("run_command"), true);
  assert.equal(contract.allowedToolNames.has("read_file"), false);
  assert.equal(contract.allowedToolNames.has("replace_in_file"), false);
  assert.deepEqual(contract.toolCallRequirement, {
    kind: "required_named",
    toolName: "run_command",
  });
});

test("finite validation pinning preserves an approved Plan browser handoff", () => {
  const browserHandoff = createExecuteRecoveryRuntimeState({
    workflowMode: "edit",
    forcedState: {
      mode: "validation_only",
      reason: "approved_plan_browser_handoff",
      expectedTarget: null,
      decisionCheckpoint: {
        expectedTarget: null,
        sourceObservationKey: null,
        nextRequiredCapability: "browser_validation",
        planTaskId: "browser-check",
      },
    },
  });

  assert.equal(
    shouldPinExecuteRecoveryFiniteValidationCheckpoint(browserHandoff),
    false,
  );
  const unchanged = pinExecuteRecoveryFiniteValidationCheckpoint(
    browserHandoff,
    { command: "npm run build", cwd: "." },
  );
  assert.strictEqual(unchanged, browserHandoff);
  assert.equal(
    unchanged.decisionCheckpoint?.nextRequiredCapability,
    "browser_validation",
  );
  assert.equal(
    unchanged.decisionCheckpoint?.pendingFiniteValidation,
    undefined,
  );

  const contract = resolveExecuteRecoveryActionContract(unchanged.mode, {
    ...unchanged,
    devServerStatus: "none",
    devServerNextCapability: "launch",
  });
  assert.equal(contract.nextRequiredCapability, "launch_long_process");
  assert.deepEqual([...contract.allowedToolNames], ["execute_command"]);
});

test("validation cannot escape into mutation without a retained finite validation", () => {
  const recoveryState = {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: "src/main.js",
    attempts: 0,
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    iterationCount: 0,
    readLease: null,
    sourceObservationKey: "src-main-v1",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "src-main-v1",
      nextRequiredCapability: "validation",
      pendingFiniteValidation: null,
      objectiveMutationEvidence: [{ target: "src/main.js", requirementRef: "REQ-OPEN" }],
      objectiveClosurePending: true,
    },
  };

  assert.equal(resolveValidationMutationReopen({
    recoveryState,
    protocolViolation: "required_tool_call_not_available",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "replace-instead-of-validating",
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/main.js",
        search_text: "oldValue",
        replace_text: "newValue",
      }),
    }],
  }), null, "an off-surface edit must be rejected until an exact failed validation is retained");
});

test("validation target switches bind a fresh observation or require a missing-window read", () => {
  const recoveryState = {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: "src/main.js",
    attempts: 2,
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    iterationCount: 0,
    readLease: null,
    sourceObservationKey: "main-v1",
    decisionCheckpoint: null,
  };
  const missing = resolveValidationMutationReopenTargetBinding({
    recoveryState,
    requestedTarget: "src/components/toolbar.js",
    reusableObservation: null,
  });
  assert.equal(missing.mode, "patch_recovery_read");
  assert.equal(missing.sourceObservationKey, null);
  assert.deepEqual(missing.readLease, {
    purpose: "missing_window",
    target: "src/components/toolbar.js",
    state: "available",
  });

  const observed = resolveValidationMutationReopenTargetBinding({
    recoveryState,
    requestedTarget: "src/components/toolbar.js",
    reusableObservation: {
      key: "toolbar-v2:1-80",
      path: "src/components/toolbar.js",
      requestSignature: "toolbar:1-80",
      versionToken: "200:4",
      requestedRange: { startLine: 1, endLine: 80, maxLines: 80 },
    },
  });
  assert.equal(observed.mode, "mutation_first");
  assert.equal(observed.sourceObservationKey, "toolbar-v2:1-80");
  assert.equal(observed.readLease.state, "consumed");
  assert.equal(observed.readLease.purpose, "context_restore");
});

test("objective audit defers a new-target mutation until a current source observation is active", async () => {
  const missing = await objectiveAuditTargetsMissingReadObservation({
    mutationTargets: ["src/components/toolbar.js"],
    knownTargets: ["src/main.js"],
    fileReadStates: new Map(),
    managedAgentMessages: [],
    workspace: "/workspace",
    readMetadata: async () => null,
  });
  assert.deepEqual(missing, ["src/components/toolbar.js"]);

  const newFileCreation = await objectiveAuditTargetsMissingReadObservation({
    mutationTargets: ["src/components/new-panel.js"],
    knownTargets: ["src/main.js"],
    creationTargets: ["src/components/new-panel.js"],
    fileReadStates: new Map(),
    managedAgentMessages: [],
    workspace: "/workspace",
    probeMetadata: async () => ({ status: "absent", metadata: null }),
  });
  assert.deepEqual(
    newFileCreation,
    [],
    "an explicitly requested, verified-absent file cannot require an impossible source read",
  );

  const existingWriteTarget = await objectiveAuditTargetsMissingReadObservation({
    mutationTargets: ["src/components/new-panel.js"],
    knownTargets: ["src/main.js"],
    creationTargets: ["src/components/new-panel.js"],
    fileReadStates: new Map(),
    managedAgentMessages: [],
    workspace: "/workspace",
    probeMetadata: async (target) => ({
      status: "exists",
      metadata: { path: target, sizeBytes: 40, modifiedMs: 3 },
    }),
  });
  assert.deepEqual(
    existingWriteTarget,
    ["src/components/new-panel.js"],
    "write_file still requires a current source observation when its target already exists",
  );

  const unknownWriteTarget = await objectiveAuditTargetsMissingReadObservation({
    mutationTargets: ["src/components/new-panel.js"],
    knownTargets: ["src/main.js"],
    creationTargets: ["src/components/new-panel.js"],
    fileReadStates: new Map(),
    managedAgentMessages: [],
    workspace: "/workspace",
    probeMetadata: async () => ({ status: "unknown", metadata: null }),
  });
  assert.deepEqual(
    unknownWriteTarget,
    ["src/components/new-panel.js"],
    "an IPC or permission error is not proof that write_file has a new target",
  );

  const createOnlyPatchTarget = await objectiveAuditTargetsMissingReadObservation({
    mutationTargets: ["src/components/new-panel.js"],
    knownTargets: ["src/main.js"],
    createOnlyTargets: ["src/components/new-panel.js"],
    fileReadStates: new Map(),
    managedAgentMessages: [],
    workspace: "/workspace",
    probeMetadata: async () => {
      throw new Error("create-only targets do not use overwrite-capable metadata inference");
    },
  });
  assert.deepEqual(createOnlyPatchTarget, []);

  const movePatch = [
    "*** Begin Patch",
    "*** Update File: src/main.js",
    "*** Move to: src/moved-main.js",
    "*** End Patch",
  ].join("\n");
  const moveTargets = resolveWorkspaceMutationTargets("apply_patch", { patch: movePatch });
  const moveCreationTargets = resolveWorkspaceMutationCreationTargets(
    "apply_patch",
    { patch: movePatch },
  );
  assert.deepEqual(moveTargets, ["src/main.js", "src/moved-main.js"]);
  assert.deepEqual(moveCreationTargets, ["src/moved-main.js"]);
  assert.deepEqual(
    resolveWorkspaceMutationCreateOnlyTargets("apply_patch", { patch: movePatch }),
    [],
    "Move destinations require explicit absence proof and are not Add File create-only targets",
  );
  assert.deepEqual(await objectiveAuditTargetsMissingReadObservation({
    mutationTargets: moveTargets,
    knownTargets: ["src/main.js"],
    creationTargets: moveCreationTargets,
    fileReadStates: new Map(),
    managedAgentMessages: [],
    workspace: "/workspace",
    probeMetadata: async () => ({ status: "absent", metadata: null }),
  }), []);
  assert.deepEqual(await objectiveAuditTargetsMissingReadObservation({
    mutationTargets: moveTargets,
    knownTargets: ["src/main.js"],
    creationTargets: moveCreationTargets,
    fileReadStates: new Map(),
    managedAgentMessages: [],
    workspace: "/workspace",
    probeMetadata: async (target) => ({
      status: "exists",
      metadata: { path: target, sizeBytes: 20, modifiedMs: 1 },
    }),
  }), ["src/moved-main.js"]);

  const source = "function openMarkdownDialog() {}";
  const fileReadStates = new Map([["toolbar-window", {
    signature: "toolbar-window",
    path: "src/components/toolbar.js",
    argsKey: "{}",
    contentHash: "toolbar-hash",
    contentLength: source.length,
    sizeBytes: 120,
    modifiedMs: 7,
    modelContent: source,
    updatedAt: 10,
  }]]);
  const reusable = await objectiveAuditTargetsMissingReadObservation({
    mutationTargets: ["src/components/toolbar.js"],
    knownTargets: ["src/main.js"],
    fileReadStates,
    managedAgentMessages: [{ role: "tool", content: source }],
    workspace: "/workspace",
    readMetadata: async (target) => ({
      path: target,
      sizeBytes: 120,
      modifiedMs: 7,
    }),
  });
  assert.deepEqual(reusable, []);
});

test("file metadata availability treats only an explicit not-found code as absence", async () => {
  const previousInvoke = globalThis.mockIpcInvoke;
  try {
    globalThis.mockIpcInvoke = async () => {
      throw new Error("FILE_METADATA_NOT_FOUND: No such file or directory");
    };
    assert.deepEqual(
      await probeFileMetadataAvailability("src/new-file.ts", "/workspace"),
      { status: "absent", metadata: null },
    );

    globalThis.mockIpcInvoke = async () => {
      throw new Error("FILE_METADATA_UNAVAILABLE: Permission denied");
    };
    assert.deepEqual(
      await probeFileMetadataAvailability("src/private.ts", "/workspace"),
      { status: "unknown", metadata: null },
    );
  } finally {
    globalThis.mockIpcInvoke = previousInvoke;
  }
});

test("local stream invocation uses required-any instead of named function choice", () => {
  const source = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /preferExplicitFunction/);
  assert.doesNotMatch(source, /\{\s*type:\s*["']function["']\s*,\s*function:\s*\{\s*name:/);
  assert.match(source, /return "required";/);
});

test("recovery action cards retain the original turn objective and finite validation", () => {
  const contract = resolveExecuteRecoveryActionContract("validation_only", {
    expectedTarget: "src/main.js",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "source-v1",
      nextRequiredCapability: "validation",
      pendingFiniteValidation: { command: "npm test", cwd: "." },
      objectiveMutationEvidence: [{ target: "src/main.js", requirementRef: "REQ-OPEN" }],
      objectiveClosurePending: true,
    },
  });
  const card = buildExecutionActionContractCard({
    contract,
    language: "en",
    availableToolNames: ["run_command"],
    turnObjective: "Open the selected Markdown file and remove the inappropriate initial label.",
  });
  assert.match(card, /turnObjective=Open the selected Markdown file/);
  assert.match(card, /validationCommand=npm test/);
  assert.match(card, /validationCwd=\./);
  assert.match(card, /objectiveClosure=pending/);
  assert.match(card, /mutationEvidence=src\/main\.js@REQ-OPEN/);
});

test("objective audit action cards keep a bounded workspace surface and allow no-tool closure", () => {
  const contract = resolveExecuteRecoveryActionContract("objective_audit", {
    expectedTarget: "src/main.js",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "main-v2",
      nextRequiredCapability: "any",
      objectiveObligationId: "root:direct-edit",
      objectiveRevision: 2,
      objectiveKind: "root",
      objectiveExpectedTargets: ["src/main.js"],
      objectiveMutationEvidence: [{ target: "src/main.js" }],
      objectiveValidationEvidence: {
        tool: "run_command",
        target: "npm test",
        revision: 2,
      },
      objectiveClosurePending: true,
    },
  });
  assert.equal(contract.allowsAllTools, false);
  assert.equal(contract.allowedToolNames.has("read_file"), true);
  assert.equal(contract.allowedToolNames.has("replace_in_file"), true);
  assert.equal(contract.allowedToolNames.has("run_command"), true);
  assert.equal(contract.allowedToolNames.has("execute_command"), false);
  assert.equal(contract.allowedToolNames.has("send_pty_input"), false);
  assert.equal(contract.allowedToolNames.has("get_pty_status"), false);
  assert.equal(contract.allowedToolNames.has("browser_evaluate"), false);
  assert.equal(contract.allowedToolNames.has("computer_use"), false);
  assert.deepEqual(contract.toolCallRequirement, { kind: "optional" });
  const card = buildExecutionActionContractCard({
    contract,
    language: "en",
    availableToolNames: ["read_file", "replace_in_file", "run_command"],
    turnObjective: "Finish every requested Open File behavior.",
  });
  assert.match(card, /phase=objective_audit/);
  assert.match(card, /stable workspace surface restored/i);
  assert.match(card, /do not repeat an already-successful finite validation through an interactive terminal/i);
  assert.match(card, /make no tool call and output the final user-facing conclusion summary/i);
  assert.doesNotMatch(card, /Call one tool from availableTools/);

  const validAuditState = {
    mode: "objective_audit",
    reason: "objective_closure_audit_required",
    expectedTarget: "src/main.js",
    attempts: 1,
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    iterationCount: 0,
    readLease: null,
    sourceObservationKey: null,
    decisionCheckpoint: contract.decisionCheckpoint,
  };
  assert.equal(objectiveAuditHasCurrentClosureEvidence(validAuditState), true);
  assert.equal(objectiveAuditHasCurrentClosureEvidence({
    ...validAuditState,
    decisionCheckpoint: {
      ...validAuditState.decisionCheckpoint,
      objectiveMutationEvidence: [],
    },
  }), false, "closurePending alone cannot synthesize missing mutation evidence");
  assert.equal(objectiveAuditHasCurrentClosureEvidence({
    ...validAuditState,
    decisionCheckpoint: {
      ...validAuditState.decisionCheckpoint,
      objectiveExpectedTargets: ["src/main.js", "src/components/toolbar.js"],
    },
  }), false, "every expected target must have durable mutation evidence");
  assert.equal(objectiveAuditHasCurrentClosureEvidence({
    ...validAuditState,
    decisionCheckpoint: {
      ...validAuditState.decisionCheckpoint,
      objectiveValidationEvidence: {
        ...validAuditState.decisionCheckpoint.objectiveValidationEvidence,
        revision: 1,
      },
    },
  }), false, "validation from an older objective revision cannot close the audit");
});
