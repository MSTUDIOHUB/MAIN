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
  PLAN_MAX_AUTO_RESUME_LIMIT,
  buildExecuteMaxIterationsAutoResumeNotice,
  buildExecuteMaxIterationsPauseNotice,
  buildExecuteMaxIterationsResumePrompt,
  buildPlanNoProgressLoopPauseNotice,
  buildPlanProgressSignatureFromToolActivity,
  buildPlanExecutionProgressUpdate,
  buildPlanMaxIterationsCheckpoint,
  buildPlanMaxIterationsPauseNotice,
  buildPlanMaxIterationsResumePrompt,
  formatPlanExecutionProgressSnapshot,
  isCachedReadOnlyPlanActivity,
  isPlanReviewExecutionLeaseActive,
  normalizePlanExecutionProgressSnapshot,
  resolveApprovedPlanInitialExecutionRecovery,
  resolveApprovedPlanRecoveryReconciliation,
  resolveApprovedPlanSameTurnFallbackDecision,
  resolveRestoredPlanExecutionTaskIdentity,
  resolveExecuteMaxIterationsRecoveryDecision,
  resolveMaxIterationStrategyPivot,
  summarizeRepeatedPlanTargetsFromToolActivity,
  toPlanExecutionRuntimeProgressUpdate,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionRecovery.ts"));

test("approved Plan handoff derives the first executable recovery contract", () => {
  const sourceMutation = resolveApprovedPlanInitialExecutionRecovery([{
    id: "edit-main",
    text: "Modify the backend",
    requirementRef: "REQ-BACKEND",
    status: "pending",
    evidenceStatus: "missing",
    evidence: [{ kind: "file", value: "src/main.rs" }],
  }]);
  assert.equal(sourceMutation?.mode, "patch_recovery_read");
  assert.equal(sourceMutation?.expectedTarget, "src/main.rs");
  assert.deepEqual(sourceMutation?.readLease, {
    purpose: "plan_line_context",
    target: "src/main.rs",
    state: "available",
  });
  assert.equal(sourceMutation?.decisionCheckpoint?.nextRequiredCapability, "targeted_read");
  assert.equal(sourceMutation?.decisionCheckpoint?.planTaskId, "edit-main");
  assert.equal(sourceMutation?.decisionCheckpoint?.requirementRef, "REQ-BACKEND");

  const finiteCommand = resolveApprovedPlanInitialExecutionRecovery([{
    id: "test",
    text: "Run the approved validation",
    status: "pending",
    evidenceStatus: "missing",
    evidence: [{ kind: "cmd", value: "npm test" }],
  }]);
  assert.equal(finiteCommand?.mode, "finite_validation_only");
  assert.equal(finiteCommand?.decisionCheckpoint?.nextRequiredCapability, "validation");
  assert.equal(finiteCommand?.decisionCheckpoint?.planTaskId, "test");
  assert.equal(finiteCommand?.decisionCheckpoint?.requirementRef, "test");

  const longProcess = resolveApprovedPlanInitialExecutionRecovery([{
    id: "dev",
    text: "Start the reviewed development server",
    status: "pending",
    evidenceStatus: "missing",
    evidence: [{ kind: "cmd", value: "npm run dev" }],
  }]);
  assert.equal(longProcess?.mode, "validation_only");
  assert.equal(longProcess?.reason, "approved_plan_long_process_handoff");
  assert.equal(longProcess?.decisionCheckpoint?.nextRequiredCapability, "launch_long_process");
  assert.equal(longProcess?.decisionCheckpoint?.planTaskId, "dev");

  const manualOnly = resolveApprovedPlanInitialExecutionRecovery([{
    id: "manual-review",
    text: "Review the native dialog",
    status: "pending",
    evidenceStatus: "requires_user_confirmation",
    evidence: [{ kind: "manual_user_validation", value: "Review the native dialog" }],
  }]);
  assert.equal(manualOnly, null);
});

test("approved Plan recovery advances to the next unsatisfied task identity", () => {
  const tasks = [
    {
      id: "edit-toolbar",
      requirementRef: "REQ-EDIT",
      text: "Modify toolbar",
      status: "in_progress",
      evidenceStatus: "partial",
      evidence: [{ kind: "file", value: "src/toolbar.js" }],
    },
    {
      id: "build",
      requirementRef: "REQ-BUILD",
      text: "Build project",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "cmd", value: "npm run build" }],
    },
    {
      id: "dev",
      requirementRef: "REQ-DEV",
      text: "Start dev server",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "cmd", value: "npm run dev" }],
    },
  ];
  const mutation = {
    id: "mutation",
    planTaskId: "edit-toolbar",
    requirementRef: "REQ-EDIT",
    kind: "file",
    value: "src/toolbar.js",
    target: "src/toolbar.js",
    sourceTool: "apply_patch",
    createdAt: 1,
  };
  const buildRecovery = resolveApprovedPlanInitialExecutionRecovery(tasks, [mutation]);
  assert.equal(buildRecovery?.mode, "finite_validation_only");
  assert.equal(buildRecovery?.decisionCheckpoint?.planTaskId, "build");
  assert.equal(buildRecovery?.decisionCheckpoint?.requirementRef, "REQ-BUILD");

  const build = {
    id: "build-result",
    planTaskId: "build",
    requirementRef: "REQ-BUILD",
    kind: "cmd",
    value: "npm run build",
    target: "npm run build",
    sourceTool: "run_command",
    createdAt: 2,
  };
  const devRecovery = resolveApprovedPlanInitialExecutionRecovery(tasks, [mutation, build]);
  assert.equal(devRecovery?.mode, "validation_only");
  assert.equal(devRecovery?.decisionCheckpoint?.nextRequiredCapability, "launch_long_process");
  assert.equal(devRecovery?.decisionCheckpoint?.planTaskId, "dev");
  assert.equal(devRecovery?.decisionCheckpoint?.requirementRef, "REQ-DEV");
  const launchContract = resolveExecuteRecoveryActionContract(
    devRecovery.mode,
    devRecovery,
  );
  const batch = resolveExecuteRecoveryBatchDecision({
    mode: devRecovery.mode,
    contract: launchContract,
    calls: [{ id: "launch-dev", name: "execute_command", target: "npm run dev" }],
  });
  assert.equal(batch.selectedCallId, "launch-dev");
  assert.deepEqual(batch.deferredCallIds, []);
});

test("approved Plan recovery rebases same-file tasks by durable task identity", () => {
  const tasks = [
    {
      id: "main-open",
      requirementRef: "REQ-OPEN",
      text: "Fix open handling",
      status: "in_progress",
      evidenceStatus: "partial",
      evidence: [{ kind: "file", value: "src/main.js" }],
    },
    {
      id: "main-tab",
      requirementRef: "REQ-TAB",
      text: "Fix initial tab",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "file", value: "src/main.js" }],
    },
  ];
  const evidenceLedger = [{
    id: "open-mutation",
    planTaskId: "main-open",
    requirementRef: "REQ-OPEN",
    kind: "file",
    value: "src/main.js",
    target: "src/main.js",
    sourceTool: "replace_in_file",
    createdAt: 1,
  }];
  const decision = resolveApprovedPlanRecoveryReconciliation({
    tasks,
    evidenceLedger,
    current: {
      mode: "validation_only",
      reason: "recovery_mutation_observed",
      expectedTarget: "src/main.js",
      decisionCheckpoint: {
        planTaskId: "main-open",
        requirementRef: "REQ-OPEN",
        nextRequiredCapability: "validation",
      },
    },
  });

  assert.equal(decision.action, "advance");
  assert.equal(decision.next?.decisionCheckpoint?.planTaskId, "main-tab");
  assert.equal(decision.next?.expectedTarget, "src/main.js");
});

test("approved Plan durable rebase runs before the iteration tool surface is selected", () => {
  const source = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"),
    "utf8",
  );
  const rebaseIndex = source.indexOf("resolveApprovedPlanRecoveryReconciliation({");
  const surfaceIndex = source.indexOf("resolveIterationToolSurface({");
  const boundaryIndex = source.indexOf("shouldReleaseExecuteRecoveryPolicyBoundary({");

  assert.ok(rebaseIndex >= 0 && rebaseIndex < surfaceIndex);
  assert.ok(boundaryIndex > rebaseIndex && boundaryIndex < surfaceIndex);
  assert.match(source, /policy_no_progress_boundary_released/);
  assert.match(source, /normal_surface_continuation/);
});

test("approved Plan recovery preserves an in-flight subphase of the same obligation", () => {
  const task = {
    id: "edit-main",
    requirementRef: "REQ-MAIN",
    text: "Modify main",
    status: "pending",
    evidenceStatus: "missing",
    evidence: [{ kind: "file", value: "src/main.js" }],
  };
  const decision = resolveApprovedPlanRecoveryReconciliation({
    tasks: [task],
    current: {
      mode: "patch_recovery_read",
      reason: "recovery_context_required",
      expectedTarget: "src/main.js",
      decisionCheckpoint: {
        planTaskId: "edit-main",
        requirementRef: "REQ-MAIN",
        nextRequiredCapability: "targeted_read",
      },
    },
  });

  assert.equal(decision.action, "unchanged");
});

test("approved Plan reconciliation does not undo a source-attributed validation repair", () => {
  const task = {
    id: "browser-check",
    requirementRef: "REQ-BROWSER",
    text: "Verify the Open interaction",
    status: "in_progress",
    evidenceStatus: "requires_browser_validation",
    evidence: [{ kind: "browser_dom", value: "browser interaction: Open" }],
  };
  const decision = resolveApprovedPlanRecoveryReconciliation({
    tasks: [task],
    current: {
      mode: "mutation_first",
      reason: "browser_validation_source_attributed",
      expectedTarget: "src/components/toolbar.js",
      decisionCheckpoint: {
        planTaskId: "browser-check",
        requirementRef: "REQ-BROWSER",
        nextRequiredCapability: "mutation",
      },
    },
  });

  assert.equal(decision.action, "unchanged");
});

test("approved Plan exposes desktop validation only when computer control is actually available", () => {
  const task = {
    id: "desktop-check",
    text: "Validate the Tauri window",
    status: "in_progress",
    evidenceStatus: "requires_tauri_validation",
    evidence: [{ kind: "tauri_required", value: "tauri runtime validation" }],
  };
  assert.equal(resolveApprovedPlanInitialExecutionRecovery([task]), null);

  const recovery = resolveApprovedPlanInitialExecutionRecovery([task], [], {
    availableToolNames: new Set(["computer_use", "run_command"]),
  });
  assert.equal(recovery?.mode, "validation_only");
  assert.equal(recovery?.decisionCheckpoint?.nextRequiredCapability, "desktop_validation");
  assert.equal(recovery?.decisionCheckpoint?.planTaskId, "desktop-check");
});

test("approved Plan store handoff forwards the derived recovery state", () => {
  const appStoreSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  assert.match(
    appStoreSource,
    /const\s+initialExecuteRecoveryState\s*=\s*resolveApprovedPlanInitialExecutionRecovery\(\s*latest\.planTasks,?\s*\);/,
  );
  assert.match(
    appStoreSource,
    /forceExecuteRecoveryMode:\s*initialExecuteRecoveryState\.mode,[\s\S]*?forceExecuteRecoveryState:\s*initialExecuteRecoveryState/,
  );
});

test("plan review awaiting approval is not an active execution lease", () => {
  assert.equal(isPlanReviewExecutionLeaseActive({
    agentStatus: "pending_review",
    isGenerating: false,
    hasAbortController: true,
  }), false);
  assert.equal(isPlanReviewExecutionLeaseActive({
    agentStatus: "running",
    isGenerating: true,
    hasAbortController: true,
  }), true);
  assert.equal(isPlanReviewExecutionLeaseActive({
    agentStatus: "running",
    isGenerating: false,
    hasAbortController: true,
  }), false);
});

test("approved plan same-turn fallback retries busy once only while the exact transition remains pending", () => {
  const handoff = {
    planTurnId: "turn-plan",
    executionTurnId: "turn-plan",
    requestedAt: 100,
    approvalLeaseId: "lease-plan-1",
    executionLeaseId: "execution-lease-1",
    sessionEpoch: "epoch-1",
    reviewRequestId: "request-plan-1",
    executionRunId: "run-execution-1",
    executionAttempt: 1,
    executionInstructionHash: "instruction-hash-1",
    parentRunId: "run-review-1",
    planRevision: 1,
    artifactHash: "plan-hash-1",
  };
  const base = {
    expectedSessionKey: "workspace:1",
    currentSessionKey: "workspace:1",
    expectedHandoff: handoff,
    currentHandoff: handoff,
    hasExactPlanApprovalHandoff: true,
    isAgentBusy: true,
  };

  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    busyRetryAttempt: 0,
  }), "retry_busy");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    busyRetryAttempt: 1,
  }), "busy_retry_exhausted");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    currentHandoff: { ...handoff, requestedAt: 101 },
    busyRetryAttempt: 0,
  }), "transition_stale");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    currentHandoff: { ...handoff, approvalLeaseId: "lease-plan-stale" },
    busyRetryAttempt: 0,
  }), "transition_stale");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    hasExactPlanApprovalHandoff: false,
    busyRetryAttempt: 0,
  }), "transition_stale");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    currentHandoff: null,
    busyRetryAttempt: 0,
  }), "transition_stale");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    expectedHandoff: { ...handoff, planRevision: 2, artifactHash: "plan-new" },
    currentHandoff: { ...handoff, planRevision: 1, artifactHash: "plan-old" },
    busyRetryAttempt: 0,
  }), "transition_stale");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    expectedHandoff: { ...handoff, planRevision: 2, artifactHash: "plan-new" },
    currentHandoff: { ...handoff, planRevision: 2, artifactHash: "plan-new" },
    isAgentBusy: false,
    busyRetryAttempt: 0,
  }), "start");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    isAgentBusy: false,
    busyRetryAttempt: 0,
  }), "start");
});

const {
  isApprovedPlanCachedReadOnlyNoProgressBatch,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/approvedPlanRecoveryTools.ts"));

const {
  isExecuteRecoveryToolName,
  resolveExecuteRecoveryActionContract,
  resolveExecuteRecoveryBatchDecision,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/executeRecoveryTools.ts"));

const {
  createExecuteRecoveryRuntimeState,
  transitionExecuteRecoveryRuntimeState,
} = loadTranspiledModuleSync(path.join(
  workspaceRoot,
  "src/lib/orchestrator/loop/executeRecoveryRuntime.ts",
));

const {
  appendApprovedPlanUserValidationConclusion,
  buildApprovedPlanEvidenceCompletionMessage,
  handleApprovedPlanFinalization,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanFinalization.ts"));

const { evaluateApprovedPlanExecution } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planExecutionEvaluation.ts"),
);

const {
  handleExecuteConvergencePrompt,
  handleStrictRepeatGuardRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"));

const {
  buildPlanClosureEvidenceRecoveryPrompt,
  handlePlanNoToolRecovery,
  resolvePlanNoToolRecoveryDecision,
  selectPlanMaterializationSourceText,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planNoToolRecovery.ts"));

test("structured Plan materialization keeps the raw proposal instead of the display-trimmed prefix", () => {
  const streamText = [
    "简短说明。",
    "<proposed_plan>",
    "# 完整修复计划",
    "- 修改 src/main.js 的文件打开事件。",
    "- 修复新建文档标题状态。",
    "</proposed_plan>",
  ].join("\n");
  assert.equal(selectPlanMaterializationSourceText({
    hasStructuredProposal: true,
    streamText,
    sourceVisibleText: "简短说明。",
  }), streamText);
  assert.equal(selectPlanMaterializationSourceText({
    hasStructuredProposal: false,
    streamText,
    sourceVisibleText: "可见的非结构化计划。",
  }), "可见的非结构化计划。");
});
const {
  handlePlanQualityRecoveryAfterVisibleMaterialization,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planQualityRecovery.ts"));
const {
  canDeterministicallyMaterializePlan,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));
const {
  hasGroundedPlanClosureEvidence,
  resolvePlanClosureArtifactKind,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/planOrchestration.ts"));
const {
  applyPlanNoToolRuntimeState,
  applyPlanRuntimePhase,
  createPlanLoopRuntimeState,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planRuntimeState.ts"));

const {
  buildFileUnchangedReplayContent,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/fileReadCache.ts"));

const tasks = [
  {
    id: "1",
    text: "Update orchestrator recovery handling",
    status: "completed",
    evidenceStatus: "satisfied",
    evidence: [{ kind: "file", value: "src/lib/orchestrator.ts" }],
  },
  {
    id: "2",
    text: "Add resume guard tests",
    status: "in_progress",
    evidenceStatus: "partial",
    evidence: [{ kind: "file", value: "tests/node/plan-execution-recovery.test.mjs" }],
  },
];

const evidenceLedger = [
  {
    id: "plan",
    kind: "file",
    value: ".MAIN/plans/tasks.md",
    target: ".MAIN/plans/tasks.md",
    sourceTool: "write_file",
    createdAt: 1,
  },
  {
    id: "source",
    kind: "file",
    value: "src/lib/orchestrator.ts",
    target: "src/lib/orchestrator.ts",
    sourceTool: "replace_in_file",
    createdAt: 2,
  },
];

function createApprovedPlanNoToolHarness(language = "en") {
  const appended = [];
  const statuses = [];
  const stops = [];
  const progress = [];
  const taskPhases = [];
  const stages = [];
  return {
    appended,
    statuses,
    stops,
    progress,
    taskPhases,
    stages,
    callbacks: {
      getPreferredLanguage: () => language,
      getPlanTasks: () => tasks,
      getPlanExecutionEvidenceLedger: () => evidenceLedger,
      getIsPlanApproved: () => true,
      appendMessage: (message) => appended.push(message),
      onStatusChange: (status) => statuses.push(status),
      onNonActionableStop: (message, reason, metadata) => stops.push({ message, reason, metadata }),
      onPlanStageChanged: (stage) => stages.push(stage),
    },
  };
}

function createStrictRepeatGuardHarness(language = "en") {
  const harness = createApprovedPlanNoToolHarness(language);
  const toolErrors = [];
  const toolDone = [];
  const errors = [];
  return {
    ...harness,
    toolErrors,
    toolDone,
    errors,
    callbacks: {
      ...harness.callbacks,
      getApprovedLocalFileReadPaths: () => [],
      onToolError: (tool, target, message, metadata) => toolErrors.push({ tool, target, message, metadata }),
      onToolDone: (tool, target, message, metadata) => toolDone.push({ tool, target, message, metadata }),
      onError: (message) => errors.push(message),
    },
  };
}

const repeatGuardPermissionPolicy = {
  autoExecuteRiskLevels: ["read_only"],
  approvalRequiredRiskLevels: ["workspace_write", "shell", "local_file_read", "external_read", "external_write", "browser_control", "destructive"],
  disabledRiskLevels: [],
};

const repeatGuardToolCapabilityRegistry = {
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
    run_command: {
      key: "run_command",
      name: "run_command",
      source: "built_in",
      category: "shell",
      risk: "shell",
      enabled: true,
      autoExecutable: false,
    },
    execute_command: {
      key: "execute_command",
      name: "execute_command",
      source: "built_in",
      category: "shell",
      risk: "shell",
      enabled: true,
      autoExecutable: false,
    },
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
  policy: repeatGuardPermissionPolicy,
};

function createRepeatGuardInput(harness, overrides = {}) {
  const effectiveToolCalls = overrides.effectiveToolCalls || [];
  return {
    callbacks: harness.callbacks,
    workspace: workspaceRoot,
    workflowMode: "plan",
    runtimeIntent: "execute",
    iteration: 4,
    effectiveToolCalls,
    results: effectiveToolCalls.map((call) => ({
      toolCallId: call.id,
      name: call.name,
      target: "",
      content: "completed",
      isError: false,
      lifecycleState: "completed",
    })),
    recentToolCalls: [],
    repeatGuardRecoveredSignatures: new Set(),
    failedToolCallCounts: new Map(),
    recentPlanToolActivity: [],
    availableToolNames: new Set(["read_file", "run_command", "browser_evaluate"]),
    toolCapabilityRegistry: repeatGuardToolCapabilityRegistry,
    toolPermissionPolicy: repeatGuardPermissionPolicy,
    emitTurnFailedEvent: (message) => harness.errors.push(message),
    ...overrides,
  };
}

function createApprovedPlanNoToolAudit(overrides = {}) {
  return {
    tasks,
    completedCount: 1,
    totalCount: 2,
    remainingTasks: [tasks[1]],
    pendingUserValidationTasks: [],
    automationComplete: false,
    allTrustedComplete: false,
    pendingExternalValidation: false,
    blockedReasons: [],
    pendingUserValidationReasons: [],
    acceptedCompletion: false,
    ...overrides,
  };
}

function createPlanNoToolHarness(language = "zh") {
  const appended = [];
  const statuses = [];
  const finalTexts = [];
  const stops = [];
  const phases = [];
  const streamTokens = [];
  return {
    appended,
    statuses,
    finalTexts,
    stops,
    phases,
    streamTokens,
    callbacks: {
      getPreferredLanguage: () => language,
      getMessages: () => [],
      getIsPlanApproved: () => false,
      getPlanStage: () => "requirements",
      appendMessage: (message) => appended.push(message),
      onStatusChange: (status) => statuses.push(status),
      onAssistantFinalText: (text, replyOptions, meta) => finalTexts.push({ text, replyOptions, meta }),
      onStreamToken: (token, messageId) => streamTokens.push({ token, messageId }),
      onNonActionableStop: (message, reason) => stops.push({ message, reason }),
      onPlanStageChanged: (stage) => phases.push({ type: "stage", stage }),
    },
  };
}

function createPlanNoToolInput(harness, overrides = {}) {
  return {
    callbacks: harness.callbacks,
    activeProfile: "local",
    iteration: 4,
    workflowMode: "plan",
    turnIntent: "plan",
    commandDirectiveAction: null,
    workspace: workspaceRoot,
    latestUserPromptText: "制定重构计划",
    streamText: "",
    sourceVisibleText: "",
    assistantHistoryText: "assistant history",
    providerReasoningForHistory: null,
    hasStructuredProposal: false,
    hasReviewablePlanArtifacts: false,
    sawPlanModeToolActivity: false,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    effectiveToolCallCount: 0,
    hasMeaningfulVisibleText: false,
    normalizedVisibleText: "",
    normalizedFinishReason: "stop",
    protocolViolation: undefined,
    protocolAllowedTools: [],
    protocolActualTools: [],
    assistantMsgId: "assistant-plan-recovery",
    recentPlanToolActivity: [],
    attemptedPlanWriteTargets: [],
    turnInputContextSignals: {},
    consecutiveNoToolCount: 0,
    usedPlanRecoveryPrompt: false,
    planClosureEvidenceRecoveryIssued: false,
    planRuntimePhase: "drafting",
    planEvidenceRecoveryPasses: 0,
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planFacetMappingSource: "",
    planArtifactQualityRejected: false,
    planAutoScaffoldPromptIssued: false,
    setPlanRuntimePhase: (phase, reason, status, qualitySnapshot) => harness.phases.push({
      type: "runtime",
      phase,
      reason,
      status,
      qualitySnapshot,
    }),
    waitForPlanApprovalIfNeeded: async () => false,
    tryClosePlanWithEvidence: async () => "failed",
    ...overrides,
  };
}

test("plan no-tool decision separates materialization refine and continuation paths", () => {
  const materialization = resolvePlanNoToolRecoveryDecision({
    workflowMode: "plan",
    isPlanApproved: false,
    hasStructuredProposal: false,
    hasReviewablePlanArtifacts: false,
    currentPlanStage: "requirements",
    sourceVisibleText: "## Proposal\n- Refactor in phases",
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    turnIntent: "plan",
    commandDirectiveAction: null,
  });
  const refine = resolvePlanNoToolRecoveryDecision({
    workflowMode: "plan",
    isPlanApproved: false,
    hasStructuredProposal: false,
    hasReviewablePlanArtifacts: false,
    currentPlanStage: "requirements",
    sourceVisibleText: "",
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: false,
    wasTruncated: true,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    turnIntent: "plan",
    commandDirectiveAction: null,
  });
  const continuation = resolvePlanNoToolRecoveryDecision({
    workflowMode: "plan",
    isPlanApproved: false,
    hasStructuredProposal: false,
    hasReviewablePlanArtifacts: false,
    currentPlanStage: "requirements",
    sourceVisibleText: "",
    hasMeaningfulVisibleText: false,
    sawPlanModeToolActivity: false,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    turnIntent: "plan",
    commandDirectiveAction: null,
  });

  assert.equal(materialization.shouldTryPlanTextMaterialization, true);
  assert.equal(materialization.shouldMaterializeFallbackPlan, true);
  assert.equal(refine.shouldRefineLongPlanIntoChoice, true);
  assert.equal(refine.shouldMaterializeFallbackPlan, false);
  assert.equal(continuation.shouldForcePlanContinuation, true);
});

test("blocked Plan evidence recovery cannot materialize a later contradictory proposal", async () => {
  const harness = createPlanNoToolHarness("zh");
  const blockedDecision = resolvePlanNoToolRecoveryDecision({
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "blocked",
    hasStructuredProposal: true,
    hasReviewablePlanArtifacts: false,
    currentPlanStage: "requirements",
    sourceVisibleText: "# Proposed Plan\n## 关键改动\n- 修改 `src/main.js`。",
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    turnIntent: "plan",
    commandDirectiveAction: null,
  });
  assert.equal(blockedDecision.shouldMaterializeStructuredProposal, false);
  assert.equal(blockedDecision.shouldTryPlanTextMaterialization, false);

  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    planRuntimePhase: "blocked",
    planEvidenceRecoveryPasses: 3,
    planLastQualityGateReason: "change_targets_lack_confirmed_rationale",
    planArtifactQualityRejected: true,
    hasStructuredProposal: true,
    sourceVisibleText: "# Proposed Plan\n## 关键改动\n- 修改 `src/main.js`。",
    hasMeaningfulVisibleText: true,
  }));
  assert.equal(result.status, "stopped");
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "incomplete_plan");
  assert.match(harness.stops[0].message, /change_targets_lack_confirmed_rationale/);
});

test("complete typed candidates reach typed ingress before blocked and required-tool legacy gates", () => {
  const common = {
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "blocked",
    hasStructuredProposal: true,
    hasReviewablePlanArtifacts: false,
    currentPlanStage: "requirements",
    sourceVisibleText: '<plan_candidate>{"schemaVersion":1}</plan_candidate>',
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: false,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    turnIntent: "plan",
    commandDirectiveAction: null,
    effectiveToolCallCount: 0,
    protocolViolation: "required_tool_call_missing",
  };
  const typed = resolvePlanNoToolRecoveryDecision({
    ...common,
    hasTypedPlanCandidate: true,
  });
  assert.equal(typed.shouldRecoverRequiredToolProtocol, false);
  assert.equal(typed.shouldMaterializeStructuredProposal, true);

  const legacy = resolvePlanNoToolRecoveryDecision({
    ...common,
    hasTypedPlanCandidate: false,
  });
  assert.equal(legacy.shouldRecoverRequiredToolProtocol, false);
  assert.equal(legacy.shouldMaterializeStructuredProposal, false);

  const legacyGrounding = resolvePlanNoToolRecoveryDecision({
    ...common,
    planRuntimePhase: "grounding",
    hasTypedPlanCandidate: false,
  });
  assert.equal(legacyGrounding.shouldRecoverRequiredToolProtocol, true);
  assert.equal(legacyGrounding.shouldMaterializeStructuredProposal, false);
});

test("Plan evidence materialization is derived only from typed recovery and closure", () => {
  assert.equal(canDeterministicallyMaterializePlan({
    recoveryAction: "rewrite",
    closureReady: true,
  }), true);
  assert.equal(canDeterministicallyMaterializePlan({
    recoveryAction: "auto_scaffold",
    closureReady: true,
  }), true);
  assert.equal(canDeterministicallyMaterializePlan({
    recoveryAction: "rewrite",
    closureReady: false,
  }), false);
  assert.equal(canDeterministicallyMaterializePlan({
    recoveryAction: "targeted_evidence",
    closureReady: true,
  }), false);
  assert.equal(canDeterministicallyMaterializePlan({
    recoveryAction: "ask_user",
    closureReady: true,
  }), false);
});

test("deterministic Plan closure rejects concrete but goal-irrelevant documentation evidence", () => {
  const unrelated = {
    userGoal: "修复 CSV 导入后图表不显示。",
    evidence: ["read_file README.md; excerpt=fallback-ok"],
    evidenceRecords: [{
      tool: "read_file",
      target: "README.md",
      status: "succeeded",
      summary: "fallback-ok",
    }],
    files: ["README.md"],
    constraints: [],
    sanitizer: {},
    sanitizerDropped: [],
  };
  assert.equal(hasGroundedPlanClosureEvidence(unrelated, [{
    name: "read_file",
    target: "README.md",
    status: "succeeded",
    detail: "fallback-ok",
  }]), false);

  const relevant = {
    ...unrelated,
    evidence: [
      "read_file src/hooks/useCsvParser.ts; excerpt=解析 CSV 行并返回图表记录",
      "read_file src/hooks/useChartData.ts; excerpt=把导入记录映射到图表序列",
    ],
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/hooks/useCsvParser.ts",
        status: "succeeded",
        summary: "解析 CSV 行并返回图表记录",
      },
      {
        tool: "read_file",
        target: "src/hooks/useChartData.ts",
        status: "succeeded",
        summary: "把导入记录映射到图表序列",
      },
    ],
    files: ["src/hooks/useCsvParser.ts", "src/hooks/useChartData.ts"],
  };
  assert.equal(hasGroundedPlanClosureEvidence(relevant, [{
    name: "read_file",
    target: "src/hooks/useCsvParser.ts",
    status: "succeeded",
    detail: "解析 CSV 行并返回图表记录",
  }]), true);
  assert.equal(resolvePlanClosureArtifactKind(relevant, "idle", [{
    name: "analyze_tabular_document",
    target: "orders.csv",
    status: "succeeded",
    detail: "creator,amount",
  }]), "plan");
  assert.equal(resolvePlanClosureArtifactKind({
    ...relevant,
    userGoal: "为 CSV 分析流程制定架构设计文档。",
  }, "idle", [{
    name: "analyze_tabular_document",
    target: "orders.csv",
    status: "succeeded",
    detail: "creator,amount",
  }]), "design");
  assert.equal(resolvePlanClosureArtifactKind({
    ...relevant,
    userGoal: "修复设置页按钮的对齐问题。",
    evidence: ["read_file src/components/SettingsPanel.tsx; excerpt=按钮布局"],
    evidenceRecords: [{
      tool: "read_file",
      target: "src/components/SettingsPanel.tsx",
      status: "succeeded",
      summary: "按钮布局",
    }],
    files: ["src/components/SettingsPanel.tsx"],
  }, "idle", [{
    name: "analyze_tabular_document",
    target: "orders.csv",
    status: "succeeded",
    detail: "creator,amount",
  }]), "plan");
});

test("Plan phase transition carries the same quality snapshot decided by recovery", () => {
  const harness = createPlanNoToolHarness("zh");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterVisibleMaterialization({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 5,
    planRuntimePhase: "needs_rewrite",
    recentPlanToolActivity: [],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "修复文件打开链路",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "insufficient_actionable_plan_signals",
    planLastMissingSections: [],
    planArtifactQualityRejected: false,
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status, qualitySnapshot) => {
      phases.push({ phase, reason, status, qualitySnapshot });
    },
    quality: {
      ok: false,
      reason: "missing_plan_required_sections:user_goal,test_plan",
      recoveryAction: "rewrite",
      missingSections: ["user_goal", "test_plan"],
    },
  });

  assert.equal(result.planQualityRejectCount, 2);
  const transition = phases.at(-1);
  assert.equal(transition.phase, "needs_rewrite");
  assert.equal(transition.qualitySnapshot?.qualityRejectCount, 2);
  assert.deepEqual(
    transition.qualitySnapshot?.missingSections,
    ["user_goal", "test_plan"],
  );
});

test("plan no-tool decision separates visible candidates from accepted artifacts", () => {
  const common = {
    workflowMode: "plan",
    isPlanApproved: false,
    currentPlanStage: "requirements",
    sourceVisibleText: "# Plan\n\n## Summary\nA structured candidate",
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    turnIntent: "plan",
    commandDirectiveAction: null,
  };

  const visibleCandidate = resolvePlanNoToolRecoveryDecision({
    ...common,
    hasStructuredProposal: true,
    hasReviewablePlanArtifacts: false,
    planArtifactQualityRejected: false,
  });
  const acceptedArtifact = resolvePlanNoToolRecoveryDecision({
    ...common,
    hasStructuredProposal: false,
    hasReviewablePlanArtifacts: true,
    planArtifactQualityRejected: false,
  });
  const replacementCandidate = resolvePlanNoToolRecoveryDecision({
    ...common,
    hasStructuredProposal: true,
    hasReviewablePlanArtifacts: true,
    planArtifactQualityRejected: true,
  });
  const markdownReplacementCandidate = resolvePlanNoToolRecoveryDecision({
    ...common,
    hasStructuredProposal: false,
    hasReviewablePlanArtifacts: true,
    planArtifactQualityRejected: true,
  });

  assert.equal(visibleCandidate.shouldMaterializeStructuredProposal, true);
  assert.equal(visibleCandidate.shouldEnterReview, false);
  assert.equal(acceptedArtifact.shouldMaterializeStructuredProposal, false);
  assert.equal(acceptedArtifact.shouldEnterReview, true);
  assert.equal(replacementCandidate.shouldMaterializeStructuredProposal, true);
  assert.equal(replacementCandidate.shouldEnterReview, false);
  assert.equal(markdownReplacementCandidate.shouldTryPlanTextMaterialization, true);
  assert.equal(markdownReplacementCandidate.shouldMaterializeFallbackPlan, true);
});

test("Plan required-tool violations are quarantined before materialization without spending quality budget", async () => {
  const harness = createPlanNoToolHarness("zh");
  const transitionText = "现在让我继续读取 main.js 的剩余部分和 toolbar.js：";
  const decision = resolvePlanNoToolRecoveryDecision({
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "grounding",
    hasStructuredProposal: false,
    hasReviewablePlanArtifacts: false,
    currentPlanStage: "requirements",
    sourceVisibleText: transitionText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    turnIntent: "plan",
    commandDirectiveAction: null,
    effectiveToolCallCount: 0,
    protocolViolation: "required_tool_call_not_available",
  });
  assert.equal(decision.shouldRecoverRequiredToolProtocol, true);
  assert.equal(decision.shouldTryPlanTextMaterialization, false);
  assert.equal(decision.shouldMaterializeFallbackPlan, false);

  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    iteration: 2,
    planRuntimePhase: "grounding",
    sourceVisibleText: transitionText,
    streamText: transitionText,
    normalizedVisibleText: transitionText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    protocolViolation: "required_tool_call_not_available",
    protocolAllowedTools: ["spawn_subagent"],
    protocolActualTools: ["read_file"],
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.planQualityRejectCount, 0);
  assert.equal(result.planLastQualityGateReason, "");
  assert.equal(harness.finalTexts.length, 0);
  assert.equal(harness.stops.length, 0);
  assert.deepEqual(harness.streamTokens, [{
    token: "__ESCALATION_RESET__:plan_tool_protocol",
    messageId: "assistant-plan-recovery",
  }]);
  assert.match(harness.appended.at(-1)?.content || "", /spawn_subagent/);
});

test("Plan required-tool exhaustion emits a recoverable Plan checkpoint instead of review", async () => {
  const harness = createPlanNoToolHarness("en");
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    callbacks: {
      ...harness.callbacks,
      onNonActionableStop: (message, reason, progress) => {
        harness.stops.push({ message, reason, progress });
      },
    },
    planRuntimePhase: "grounding",
    consecutiveNoToolCount: 99,
    sourceVisibleText: "I will keep inspecting the requested source.",
    streamText: "I will keep inspecting the requested source.",
    normalizedVisibleText: "I will keep inspecting the requested source.",
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    protocolViolation: "required_tool_call_missing",
    protocolAllowedTools: ["read_file"],
  }));

  assert.equal(result.status, "stopped");
  assert.equal(harness.statuses.includes("pending_review"), false);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "missing_tool_loop");
  assert.equal(
    harness.stops[0].progress?.recoveryReason,
    "plan_required_tool_protocol_violation",
  );
});

test("visible plan materialization rejection enters typed recovery instead of falling through", async () => {
  const harness = createPlanNoToolHarness("zh");
  let approvalWaitCalls = 0;
  const visiblePlan = [
    "# Proposed Plan: 修复 Markdown 文件打开链路",
    "",
    "## 摘要",
    "- 用户目标：修复双击 Markdown 文件无法打开的问题。",
    "",
    "## 已确认证据",
    "- 已读取 `src/main.js`，确认当前前端文件打开入口。",
    "",
    "## 关键改动",
    "1. 修改 `src/main.js`，统一前端文件打开入口。",
    "2. 修改 `index.html`，调整脚本加载与启动参数传递。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 不新增公共 API，只调整内部启动流程。",
    "",
    "## 测试方案",
    "- 运行 `npm run build`，断言构建以退出码 0 完成；桌面入口保留为后续交互复核。",
    "",
    "## 假设与默认值",
    "- 保持编辑器、保存和预览行为不变。",
  ].join("\n");
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    hasStructuredProposal: true,
    sourceVisibleText: visiblePlan,
    streamText: visiblePlan,
    hasMeaningfulVisibleText: true,
    normalizedVisibleText: visiblePlan,
    sawPlanModeToolActivity: true,
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "src/main.js 的 open-file-event 处理器缺失 Markdown 路径转发，必须修复该入口。",
    }],
    waitForPlanApprovalIfNeeded: async () => {
      approvalWaitCalls += 1;
      return false;
    },
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.planQualityRejectCount, 1);
  assert.equal(result.planArtifactQualityRejected, false);
  assert.equal(result.planLastQualityGateReason, "typed_plan_draft_missing");
  assert.equal(result.planFacetMappingSource, "");
  assert.equal(approvalWaitCalls, 0);
  assert.equal(harness.statuses.includes("pending_review"), false);
  assert.equal(harness.stops.length, 0);
  assert.ok(harness.phases.some((entry) => entry.phase === "needs_rewrite"));
  assert.equal(harness.appended.at(-2)?.role, "assistant");
  assert.equal(harness.appended.at(-2)?.content, visiblePlan);
  assert.match(harness.appended.at(-1)?.content || "", /PLAN_NEEDS_REWRITE/);
  assert.match(harness.appended.at(-1)?.content || "", /\[PLAN AUTHORING CONTRACT\]/);

  const rewritePhase = harness.phases.findLast((entry) => entry.phase === "needs_rewrite");
  assert.equal(rewritePhase.qualitySnapshot?.qualityRejectCount, 1);
  assert.deepEqual(rewritePhase.qualitySnapshot?.missingSections, []);
  let foldedState = createPlanLoopRuntimeState({ workflowMode: "plan", isPlanApproved: false });
  foldedState = applyPlanRuntimePhase(foldedState, {
    phase: rewritePhase.phase,
    reason: rewritePhase.reason,
  }).state;
  foldedState = applyPlanNoToolRuntimeState(foldedState, result);
  assert.equal(foldedState.planRuntimePhase, "needs_rewrite");
  assert.equal(foldedState.planQualityRejectCount, 1);
  assert.equal(foldedState.planArtifactQualityRejected, false);
  assert.equal(foldedState.planFacetMappingSource, "");

  const nextCandidate = resolvePlanNoToolRecoveryDecision({
    workflowMode: "plan",
    isPlanApproved: false,
    planArtifactQualityRejected: foldedState.planArtifactQualityRejected,
    hasStructuredProposal: true,
    hasReviewablePlanArtifacts: false,
    currentPlanStage: "requirements",
    sourceVisibleText: visiblePlan.replace("index.html", "src/main.js"),
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    turnIntent: "plan",
    commandDirectiveAction: null,
  });
  assert.equal(nextCandidate.shouldMaterializeStructuredProposal, true);
});

test("a closure-ready rejected draft is revised before deterministic fallback", async () => {
  const harness = createPlanNoToolHarness("zh");
  const objective = [
    "问题：",
    "1、编辑界面同时显示文件名和未保存文档名。",
    "2、打开本地 Markdown 后意外进入保存流程。",
  ].join("\n");
  const rejectedDraft = [
    "<proposed_plan>",
    "# 修复文件打开与编辑状态",
    "## 已确认证据",
    "- `src/main.js` 调用保存命令。",
    "## 关键改动",
    "- 修改 `src/main.js` 的保存参数。",
    "## 测试方案",
    "- 分别验证两个问题。",
    "</proposed_plan>",
    "<tool_call>read_file</tool_call>",
  ].join("\n");

  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    iteration: 3,
    latestUserPromptText: objective,
    sourceVisibleText: rejectedDraft,
    streamText: rejectedDraft,
    normalizedVisibleText: rejectedDraft,
    hasStructuredProposal: true,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/main.js",
        status: "succeeded",
        detail: "src/main.js 的程序化 setValue 不正确地触发 input、标记 isDirty 并进入 scheduleAutoSave。",
      },
      {
        name: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        detail: "src-tauri/src/main.rs 的 save_file_content 参数映射不正确，与前端调用键不一致。",
      },
      {
        name: "read_file",
        target: "src/components/editor.js",
        status: "succeeded",
        detail: "src/components/editor.js 的 setValue 分派 input 不正确，无法区分加载和用户编辑。",
      },
      {
        name: "read_file",
        target: "src/components/toolbar.js",
        status: "succeeded",
        detail: "src/components/toolbar.js 的文件名映射不正确，重复呈现文件名与未保存文档标题。",
      },
    ],
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.planQualityRejectCount, 1);
  assert.equal(result.planLastQualityGateReason, "typed_plan_draft_missing");
  assert.equal(result.planFacetMappingSource, "");
  assert.equal(harness.stops.length, 0);
  assert.equal(harness.statuses.includes("pending_review"), false);
  assert.equal(harness.appended.at(-2)?.role, "assistant");
  assert.equal(harness.appended.at(-2)?.content, rejectedDraft);
  assert.equal(harness.appended.at(-1)?.role, "user");
  assert.match(harness.appended.at(-1)?.content || "", /PLAN_NEEDS_REWRITE/);
});

test("closure-incomplete draft opens one typed evidence transaction and then holds it", async () => {
  const sourceVisibleText = "我会继续分析白屏问题并稍后给出方案。";
  const activity = [{
    name: "read_file",
    target: "src/main.js",
    status: "succeeded",
    detail: "function initEditor reads the editor element and registers its input listener",
  }];
  const harness = createPlanNoToolHarness("zh");
  const recovered = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    iteration: 8,
    latestUserPromptText: "启动软件测试白屏，无任何 UI 显示，找到原因并修复。",
    sourceVisibleText,
    streamText: sourceVisibleText,
    normalizedVisibleText: sourceVisibleText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    planRuntimePhase: "needs_evidence",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "unsupported_hypothesis_as_plan",
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryPasses: 3,
    recentPlanToolActivity: activity,
  }));

  assert.equal(recovered.status, "continue");
  assert.equal(recovered.planQualityRejectCount, 2);
  assert.equal(recovered.planAutoScaffoldPromptIssued, false);
  assert.equal(harness.stops.length, 0);
  assert.equal(harness.appended.at(-2)?.role, "assistant");
  assert.equal(harness.appended.at(-2)?.content, sourceVisibleText);
  assert.equal(harness.appended.at(-1)?.role, "user");
  assert.match(harness.appended.at(-1)?.content || "", /PLAN_CLOSURE_NEEDS_EVIDENCE/);

  const secondRevisionHarness = createPlanNoToolHarness("zh");
  const secondRevision = await handlePlanNoToolRecovery(createPlanNoToolInput(secondRevisionHarness, {
    iteration: 9,
    latestUserPromptText: "启动软件测试白屏，无任何 UI 显示，找到原因并修复。",
    sourceVisibleText,
    streamText: sourceVisibleText,
    normalizedVisibleText: sourceVisibleText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    planRuntimePhase: "needs_evidence",
    planQualityRejectCount: recovered.planQualityRejectCount,
    planLastQualityGateReason: recovered.planLastQualityGateReason,
    planClosureEvidenceRecoveryIssued: recovered.planClosureEvidenceRecoveryIssued,
    planEvidenceRecoveryObjective: recovered.planEvidenceRecoveryObjective,
    planEvidenceRecoveryPasses: recovered.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: recovered.planEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint: recovered.planEvidenceProgressFingerprint,
    planAutoScaffoldPromptIssued: recovered.planAutoScaffoldPromptIssued,
    planVisibleQualityPromptBudget: recovered.planVisibleQualityPromptBudget,
    recentPlanToolActivity: activity,
  }));

  assert.equal(secondRevision.status, "continue");
  assert.equal(secondRevisionHarness.stops.length, 0);
  assert.equal(secondRevisionHarness.appended.length, 0);
  assert.equal(secondRevisionHarness.phases.at(-1)?.phase, "needs_evidence");
});

test("grounded rewrite recovery supersedes stale deterministic evidence without reopening reads", async () => {
  const harness = createPlanNoToolHarness("zh");
  const sourceVisibleText = "我还需要继续分析当前状态同步实现。";
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    iteration: 5,
    latestUserPromptText: "找到保存后详情未刷新和删除后列表计数未更新的原因并制定整改方案。",
    sourceVisibleText,
    streamText: sourceVisibleText,
    normalizedVisibleText: sourceVisibleText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    planQualityRejectCount: 1,
    planLastQualityGateReason: "too_short",
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryObjective: "deterministic_closure",
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/store/detailStore.ts",
        status: "succeeded",
        detail: "saveDetail does not set the visible detail cache after writing the record.",
      },
      {
        name: "read_file",
        target: "src/store/listStore.ts",
        status: "succeeded",
        detail: "deleteRecord does not set the derived list count after removing an item.",
      },
    ],
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.planQualityRejectCount, 2);
  assert.equal(result.planClosureEvidenceRecoveryIssued, false);
  assert.equal(result.planAutoScaffoldPromptIssued, false);
  assert.equal(harness.stops.length, 0);
  assert.match(harness.appended.at(-1)?.content || "", /PLAN_NEEDS_REWRITE/);
  assert.equal(harness.phases.at(-1)?.phase, "needs_rewrite");

  const repeatedHarness = createPlanNoToolHarness("zh");
  const repeated = await handlePlanNoToolRecovery(createPlanNoToolInput(repeatedHarness, {
    iteration: 6,
    latestUserPromptText: "找到保存后详情未刷新和删除后列表计数未更新的原因并制定整改方案。",
    sourceVisibleText,
    streamText: sourceVisibleText,
    normalizedVisibleText: sourceVisibleText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    planQualityRejectCount: result.planQualityRejectCount,
    planLastQualityGateReason: result.planLastQualityGateReason,
    planClosureEvidenceRecoveryIssued: result.planClosureEvidenceRecoveryIssued,
    planEvidenceRecoveryObjective: result.planEvidenceRecoveryObjective,
    planEvidenceRecoveryPasses: result.planEvidenceRecoveryPasses,
    planAutoScaffoldPromptIssued: result.planAutoScaffoldPromptIssued,
    planVisibleQualityPromptBudget: result.planVisibleQualityPromptBudget,
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/store/detailStore.ts",
        status: "succeeded",
        detail: "saveDetail does not set the visible detail cache after writing the record.",
      },
      {
        name: "read_file",
        target: "src/store/listStore.ts",
        status: "succeeded",
        detail: "deleteRecord does not set the derived list count after removing an item.",
      },
    ],
  }));

  assert.equal(repeated.status, "continue");
  assert.equal(repeatedHarness.stops.length, 0);
  assert.match(repeatedHarness.appended.at(-1)?.content || "", /PLAN_NEEDS_REWRITE/);
  assert.equal(
    repeatedHarness.appended.some((message) => /PLAN_CLOSURE_NEEDS_EVIDENCE/.test(message.content || "")),
    false,
  );

  const exhaustedHarness = createPlanNoToolHarness("zh");
  const exhausted = await handlePlanNoToolRecovery(createPlanNoToolInput(exhaustedHarness, {
    iteration: 7,
    latestUserPromptText: "找到保存后详情未刷新和删除后列表计数未更新的原因并制定整改方案。",
    sourceVisibleText,
    streamText: sourceVisibleText,
    normalizedVisibleText: sourceVisibleText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    planQualityRejectCount: repeated.planQualityRejectCount,
    planLastQualityGateReason: repeated.planLastQualityGateReason,
    planClosureEvidenceRecoveryIssued: repeated.planClosureEvidenceRecoveryIssued,
    planEvidenceRecoveryObjective: repeated.planEvidenceRecoveryObjective,
    planEvidenceRecoveryPasses: repeated.planEvidenceRecoveryPasses,
    planAutoScaffoldPromptIssued: repeated.planAutoScaffoldPromptIssued,
    planVisibleQualityPromptBudget: repeated.planVisibleQualityPromptBudget,
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/store/detailStore.ts",
        status: "succeeded",
        detail: "saveDetail does not set the visible detail cache after writing the record.",
      },
      {
        name: "read_file",
        target: "src/store/listStore.ts",
        status: "succeeded",
        detail: "deleteRecord does not set the derived list count after removing an item.",
      },
    ],
  }));

  assert.equal(exhausted.status, "stopped");
  assert.equal(exhaustedHarness.stops.length, 1);
  assert.match(exhaustedHarness.stops[0].message, /有界的计划物化恢复/);
});

test("typed rewrite supersedes a stale model-draft evidence objective", async () => {
  const harness = createPlanNoToolHarness("zh");
  const sourceVisibleText = "我会继续分析当前调用链。";
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    iteration: 7,
    sourceVisibleText,
    streamText: sourceVisibleText,
    normalizedVisibleText: sourceVisibleText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    planQualityRejectCount: 1,
    planLastQualityGateReason: "missing_plan_required_sections:public_interfaces",
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryObjective: "model_draft",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "switchToTab incorrectly calls setEditorValue and reaches the input listener that schedules auto save.",
    }],
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.planQualityRejectCount, 2);
  assert.equal(result.planClosureEvidenceRecoveryIssued, false);
  assert.equal(result.planEvidenceRecoveryObjective, "none");
  assert.equal(harness.phases.at(-1)?.phase, "needs_rewrite");
  assert.match(harness.appended.at(-1)?.content || "", /PLAN_NEEDS_REWRITE/);
});

test("a visible candidate quietly holds an active evidence transaction instead of stopping", async () => {
  const harness = createPlanNoToolHarness("zh");
  const sourceVisibleText = "我会在确认文件打开链路后再给出计划。";
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    iteration: 8,
    latestUserPromptText: "找到打开本地 Markdown 后弹出保存窗口的原因并制定修复计划。",
    sourceVisibleText,
    streamText: sourceVisibleText,
    normalizedVisibleText: sourceVisibleText,
    hasMeaningfulVisibleText: true,
    sawPlanModeToolActivity: true,
    planRuntimePhase: "needs_evidence",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "unverified_diagnostic_claim_as_confirmed",
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryObjective: "model_draft",
    planEvidenceRecoveryPasses: 0,
    recentPlanToolActivity: [],
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.planClosureEvidenceRecoveryIssued, false);
  assert.equal(result.planEvidenceRecoveryObjective, "model_draft");
  assert.equal(harness.stops.length, 0);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.statuses.at(-1), "running");
  assert.equal(harness.phases.at(-1)?.phase, "needs_evidence");
});

test("legacy artifact cannot pause a new review run even when the response looks structured", async () => {
  const harness = createPlanNoToolHarness("en");
  let currentStatus = "running";
  let approvalWaitCalls = 0;
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    callbacks: {
      ...harness.callbacks,
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [{
        kind: "plan",
        path: ".MAIN/plans/plan.md",
        title: "Plan",
        content: "# Plan\n\n## Summary\nThe accepted artifact remains the review source.",
        revision: 3,
        updatedAt: 1,
      }],
      getStatus: () => currentStatus,
      onStatusChange: (status) => {
        currentStatus = status;
        harness.statuses.push(status);
      },
    },
    hasStructuredProposal: true,
    hasReviewablePlanArtifacts: true,
    sourceVisibleText: "# Plan\n\n## Summary\nThe accepted artifact remains the review source.",
    hasMeaningfulVisibleText: true,
    waitForPlanApprovalIfNeeded: async () => {
      approvalWaitCalls += 1;
      return false;
    },
  }));

  assert.equal(result.status, "continue");
  assert.equal(approvalWaitCalls, 0);
  assert.equal(currentStatus, "running");
  assert.equal(harness.statuses.includes("pending_review"), false);
  assert.equal(harness.stops.length, 0);
  assert.ok(harness.phases.some((entry) =>
    entry.phase === "needs_rewrite" &&
    entry.reason === "typed_plan_review_authority:primary_plan_not_typed"
  ));
  assert.match(harness.appended.at(-1)?.content || "", /\[PLAN AUTHORING CONTRACT\]/);
});

test("review handoff without a typed primary artifact continues typed recovery", async () => {
  const harness = createPlanNoToolHarness("en");
  let currentStatus = "running";
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    callbacks: {
      ...harness.callbacks,
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [],
      getStatus: () => currentStatus,
      onStatusChange: (status) => {
        currentStatus = status;
        harness.statuses.push(status);
      },
      onNonActionableStop: (message, reason, progress) => {
        harness.stops.push({ message, reason, progress });
      },
    },
    hasReviewablePlanArtifacts: true,
  }));

  assert.equal(result.status, "continue");
  assert.equal(currentStatus, "running");
  assert.equal(harness.statuses.includes("pending_review"), false);
  assert.equal(harness.stops.length, 0);
  assert.ok(harness.phases.some((entry) =>
    entry.phase === "needs_rewrite" &&
    entry.reason === "typed_plan_review_authority:primary_plan_missing"
  ));
  assert.match(harness.appended.at(-1)?.content || "", /\[PLAN AUTHORING CONTRACT\]/);
});

test("legacy artifact cannot manufacture review state from a stale runtime stage", async () => {
  const harness = createPlanNoToolHarness("en");
  let currentStatus = "running";
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    callbacks: {
      ...harness.callbacks,
      getPlanStage: () => "requirements",
      getPlanArtifacts: () => [{
        kind: "plan",
        path: ".MAIN/plans/plan.md",
        title: "Plan",
        content: "# Plan\n\n## Summary\nA stale artifact must not manufacture review state.",
        revision: 1,
        updatedAt: 1,
      }],
      getStatus: () => currentStatus,
      onStatusChange: (status) => {
        currentStatus = status;
        harness.statuses.push(status);
      },
      onNonActionableStop: (message, reason, progress) => {
        harness.stops.push({ message, reason, progress });
      },
    },
    hasReviewablePlanArtifacts: true,
  }));

  assert.equal(result.status, "continue");
  assert.equal(currentStatus, "running");
  assert.equal(harness.statuses.includes("pending_review"), false);
  assert.equal(harness.stops.length, 0);
  assert.ok(harness.phases.some((entry) =>
    entry.phase === "needs_rewrite" &&
    entry.reason === "typed_plan_review_authority:primary_plan_not_typed"
  ));
  assert.match(harness.appended.at(-1)?.content || "", /\[PLAN AUTHORING CONTRACT\]/);
});

test("plan no-tool recovery prompts continuation when planning ends with no visible output", async () => {
  const harness = createPlanNoToolHarness("zh");
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /current plan has not reached an executable stage/i);
  assert.match(harness.appended[0].content, /\[PLAN AUTHORING CONTRACT\]/);
  assert.match(harness.appended[0].content, /runtime.*validates and renders/i);
  assert.equal(harness.statuses.length, 0);
});

test("rejected plan artifact cannot enter review on the next no-tool iteration", async () => {
  const harness = createPlanNoToolHarness("en");
  let approvalWaitCalls = 0;
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    callbacks: {
      ...harness.callbacks,
      getPlanStage: () => "plan",
    },
    hasReviewablePlanArtifacts: true,
    planArtifactQualityRejected: true,
    waitForPlanApprovalIfNeeded: async () => {
      approvalWaitCalls += 1;
      return false;
    },
  }));

  assert.equal(result.status, "continue");
  assert.equal(approvalWaitCalls, 0);
  assert.equal(harness.statuses.includes("pending_review"), false);
  assert.match(harness.appended.at(-1)?.content || "", /complete typed graph/i);
  assert.match(harness.appended.at(-1)?.content || "", /\[PLAN AUTHORING CONTRACT\]/);
  assert.match(harness.appended.at(-1)?.content || "", /runtime validates and renders/i);
});

test("plan closure evidence recovery prompt keeps planning read-only and targeted", () => {
  const goal = [
    "1、保存后详情页仍显示旧标题。",
    "2、删除后列表计数没有更新。",
  ].join("\n");
  const zh = buildPlanClosureEvidenceRecoveryPrompt("zh", "uncovered_user_goal_facets:2", goal);
  const en = buildPlanClosureEvidenceRecoveryPrompt("en", "uncovered_user_goal_facets:2", goal);

  assert.match(zh, /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.match(zh, /2\. 删除后列表计数没有更新/);
  assert.doesNotMatch(zh, /保存后详情页仍显示旧标题/);
  assert.match(zh, /只做一次能够把它绑定到具体源码/);
  assert.match(zh, /每个用户编号分面都必须映射到已确认证据、具体改动\/决策和可执行验证/);
  assert.match(zh, /批准前不要修改源码/);
  assert.match(en, /2\. 删除后列表计数没有更新/);
  assert.match(en, /exactly one targeted read\/search/);
  assert.match(en, /Do not call broad directory scans/);
});

test("approved plan finalization continues from provenance in execute workflow", () => {
  const harness = createApprovedPlanNoToolHarness("en");
  const result = handleApprovedPlanFinalization({
    callbacks: harness.callbacks,
    activeProfile: "cloud",
    iteration: 7,
    approvedPlanAuditForNoTool: createApprovedPlanNoToolAudit(),
    rejectedCompletionClaim: true,
    availableToolNames: new Set(["read_file", "replace_in_file", "run_command"]),
    consecutiveNoToolCount: 0,
    emitTaskOrchestratorPhase: (phase, extra) => harness.taskPhases.push({ phase, extra }),
    emitPlanExecutionProgress: (phase, overrides) => harness.progress.push({ phase, overrides }),
  });

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /completion claim did not pass/i);
  assert.match(harness.appended[0].content, /Next priority tasks/i);
});

test("approved Plan no-tool execution exhausts strategy pivots before pausing", () => {
  const pivotHarness = createApprovedPlanNoToolHarness("en");
  const pivot = handleApprovedPlanFinalization({
    callbacks: pivotHarness.callbacks,
    activeProfile: "local",
    iteration: 8,
    approvedPlanAuditForNoTool: createApprovedPlanNoToolAudit(),
    rejectedCompletionClaim: false,
    availableToolNames: new Set(["replace_in_file", "run_command"]),
    consecutiveNoToolCount: 1,
    emitTaskOrchestratorPhase: (phase, extra) => pivotHarness.taskPhases.push({ phase, extra }),
    emitPlanExecutionProgress: (phase, overrides) => pivotHarness.progress.push({ phase, overrides }),
  });
  assert.equal(pivot.status, "continue");
  assert.match(pivotHarness.appended.at(-1)?.content || "", /current_task_action_lock/);
  assert.equal(pivotHarness.stops.length, 0);

  const exhaustedHarness = createApprovedPlanNoToolHarness("en");
  const exhausted = handleApprovedPlanFinalization({
    callbacks: exhaustedHarness.callbacks,
    activeProfile: "cloud",
    iteration: 10,
    approvedPlanAuditForNoTool: createApprovedPlanNoToolAudit(),
    rejectedCompletionClaim: false,
    availableToolNames: new Set(["replace_in_file", "run_command"]),
    consecutiveNoToolCount: 3,
    emitTaskOrchestratorPhase: (phase, extra) => exhaustedHarness.taskPhases.push({ phase, extra }),
    emitPlanExecutionProgress: (phase, overrides) => exhaustedHarness.progress.push({ phase, overrides }),
  });
  assert.equal(exhausted.status, "stopped");
  assert.equal(exhaustedHarness.stops.length, 1);
  assert.equal(exhaustedHarness.progress.at(-1)?.phase, "paused");
});

test("approved plan finalization completes automated work and leaves user validation in the conclusion", () => {
  const harness = createApprovedPlanNoToolHarness("zh");
  const pendingValidationTask = {
    ...tasks[1],
    status: "in_progress",
    evidenceStatus: "requires_user_confirmation",
    evidence: [{ kind: "manual_user_validation", value: "user confirms the Tauri window", inferred: true }],
  };
  const result = handleApprovedPlanFinalization({
    callbacks: {
      ...harness.callbacks,
      getPlanTasks: () => [tasks[0], pendingValidationTask],
      getPlanExecutionEvidenceLedger: () => [
        ...evidenceLedger,
        {
          id: "automatic-validation",
          kind: "cmd",
          value: "npm test",
          target: "npm test",
          sourceTool: "run_command",
          createdAt: 3,
        },
      ],
    },
    activeProfile: "cloud",
    iteration: 7,
    workflowMode: "plan",
    approvedPlanAuditForNoTool: createApprovedPlanNoToolAudit({
      tasks: [tasks[0], pendingValidationTask],
      remainingTasks: [],
      pendingUserValidationTasks: [pendingValidationTask],
      completedCount: 1,
      totalCount: 2,
      automationComplete: true,
      pendingExternalValidation: true,
      pendingUserValidationReasons: ["需要用户确认 Tauri 窗口"],
    }),
    rejectedCompletionClaim: false,
    availableToolNames: new Set(["read_file", "run_command"]),
    consecutiveNoToolCount: 0,
    emitTaskOrchestratorPhase: (phase, extra) => harness.taskPhases.push({ phase, extra }),
    emitPlanExecutionProgress: (phase, overrides) => harness.progress.push({ phase, overrides }),
  });

  assert.equal(result.status, "none");
  assert.deepEqual(harness.statuses, []);
  assert.equal(harness.stops.length, 0);
  assert.equal(harness.progress[0].phase, "completed");
  assert.deepEqual(harness.stages, ["completed"]);
  assert.equal(harness.taskPhases[0].extra.reason, "plan_automation_evidence_complete_external_review_advisory");

  const conclusion = buildApprovedPlanEvidenceCompletionMessage({
    language: "zh",
    completedCount: 1,
    totalCount: 2,
    pendingUserValidationTasks: [pendingValidationTask],
  });
  assert.match(conclusion, /所有可自动执行和验收的工作/);
  assert.match(conclusion, /建议用户复核（不影响本次任务完成状态）/);
  assert.match(conclusion, /Add resume guard tests/);

  const appended = appendApprovedPlanUserValidationConclusion({
    text: "自动验证已通过。",
    audit: {
      acceptedCompletion: true,
      pendingUserValidationTasks: [pendingValidationTask],
    },
    language: "zh",
  });
  assert.match(appended, /^自动验证已通过。/);
  assert.match(appended, /不影响本次任务完成状态/);
});

test("approved plan finalization marks the plan completed when all evidence is trusted", () => {
  const harness = createApprovedPlanNoToolHarness("en");
  const completeAudit = createApprovedPlanNoToolAudit({
    tasks: [{ ...tasks[0], status: "completed", evidenceStatus: "satisfied" }],
    completedCount: 1,
    totalCount: 1,
    remainingTasks: [],
    automationComplete: true,
    allTrustedComplete: true,
    acceptedCompletion: true,
  });
  const result = handleApprovedPlanFinalization({
    callbacks: {
      ...harness.callbacks,
      getPlanTasks: () => completeAudit.tasks,
      getPlanExecutionEvidenceLedger: () => [...evidenceLedger, {
        id: "validation",
        kind: "cmd",
        value: "npm test",
        target: "npm test",
        sourceTool: "run_command",
        createdAt: 3,
      }],
    },
    activeProfile: "cloud",
    iteration: 7,
    workflowMode: "plan",
    approvedPlanAuditForNoTool: completeAudit,
    rejectedCompletionClaim: false,
    availableToolNames: new Set(["read_file", "run_command"]),
    consecutiveNoToolCount: 0,
    emitTaskOrchestratorPhase: (phase, extra) => harness.taskPhases.push({ phase, extra }),
    emitPlanExecutionProgress: (phase, overrides) => harness.progress.push({ phase, overrides }),
  });

  assert.equal(result.status, "none");
  assert.equal(result.consecutiveNoToolCount, 0);
  assert.deepEqual(harness.taskPhases, [{ phase: "DONE", extra: { reason: "plan_evidence_complete", iteration: 7, pendingUserValidation: 0 } }]);
  assert.deepEqual(harness.progress, [{ phase: "completed", overrides: undefined }]);
  assert.deepEqual(harness.stages, ["completed"]);
  assert.equal(evaluateApprovedPlanExecution({
    tasks: completeAudit.tasks,
    evidenceLedger: [...evidenceLedger, {
      id: "validation",
      kind: "cmd",
      value: "npm test",
      target: "npm test",
      sourceTool: "run_command",
      createdAt: 3,
    }],
    availableToolNames: new Set(["read_file", "run_command"]),
  }).completionAllowed, true);
});

test("approved plan finalization ignores a stale completed snapshot when current task evidence is incomplete", () => {
  const harness = createApprovedPlanNoToolHarness("en");
  const requiredTask = {
    id: "required-source",
    text: "Update the required source",
    status: "completed",
    evidenceStatus: "satisfied",
    evidence: [{ kind: "file", value: "src/required.ts" }],
  };
  const staleAudit = createApprovedPlanNoToolAudit({
    tasks: [requiredTask],
    completedCount: 1,
    totalCount: 1,
    remainingTasks: [],
    automationComplete: true,
    allTrustedComplete: true,
    acceptedCompletion: true,
  });
  const result = handleApprovedPlanFinalization({
    callbacks: {
      ...harness.callbacks,
      getPlanTasks: () => [requiredTask],
      getPlanExecutionEvidenceLedger: () => [{
        id: "unrelated-mutation",
        kind: "file",
        value: "src/unrelated.ts",
        target: "src/unrelated.ts",
        sourceTool: "apply_patch",
        createdAt: 1,
      }, {
        id: "validation",
        kind: "cmd",
        value: "npm test",
        target: "npm test",
        sourceTool: "run_command",
        createdAt: 2,
      }],
    },
    activeProfile: "cloud",
    iteration: 8,
    approvedPlanAuditForNoTool: staleAudit,
    rejectedCompletionClaim: false,
    availableToolNames: new Set(["read_file", "run_command"]),
    consecutiveNoToolCount: 0,
    emitTaskOrchestratorPhase: (phase, extra) => harness.taskPhases.push({ phase, extra }),
    emitPlanExecutionProgress: (phase, overrides) => harness.progress.push({ phase, overrides }),
  });

  assert.equal(result.status, "continue");
  assert.deepEqual(harness.stages, []);
  assert.deepEqual(harness.taskPhases, []);
  assert.match(harness.appended.at(-1)?.content || "", /Next priority tasks/);
});

test("approved plan finalization does not publish completed before post-mutation validation", () => {
  const harness = createApprovedPlanNoToolHarness("en");
  const completeAudit = createApprovedPlanNoToolAudit({
    tasks: [{ ...tasks[0], status: "completed", evidenceStatus: "satisfied" }],
    completedCount: 1,
    totalCount: 1,
    remainingTasks: [],
    automationComplete: true,
    allTrustedComplete: true,
    acceptedCompletion: true,
  });
  const result = handleApprovedPlanFinalization({
    callbacks: {
      ...harness.callbacks,
      getPlanTasks: () => completeAudit.tasks,
      getPlanExecutionEvidenceLedger: () => evidenceLedger,
    },
    activeProfile: "cloud",
    iteration: 8,
    workflowMode: "plan",
    approvedPlanAuditForNoTool: completeAudit,
    rejectedCompletionClaim: false,
    availableToolNames: new Set(["read_file", "run_command"]),
    consecutiveNoToolCount: 0,
    emitTaskOrchestratorPhase: (phase, extra) => harness.taskPhases.push({ phase, extra }),
    emitPlanExecutionProgress: (phase, overrides) => harness.progress.push({ phase, overrides }),
  });

  assert.equal(result.status, "none");
  assert.deepEqual(harness.taskPhases, []);
  assert.deepEqual(harness.stages, []);
  assert.equal(harness.progress.some((entry) => entry.phase === "completed"), false);
  assert.deepEqual(harness.appended, []);
});

test("approved plan finalization does not publish completed while recovery is active", () => {
  const harness = createApprovedPlanNoToolHarness("en");
  const completeAudit = createApprovedPlanNoToolAudit({
    tasks: [{ ...tasks[0], status: "completed", evidenceStatus: "satisfied" }],
    completedCount: 1,
    totalCount: 1,
    remainingTasks: [],
    automationComplete: true,
    allTrustedComplete: true,
    acceptedCompletion: true,
  });
  const result = handleApprovedPlanFinalization({
    callbacks: {
      ...harness.callbacks,
      getPlanTasks: () => completeAudit.tasks,
      getPlanExecutionEvidenceLedger: () => [...evidenceLedger, {
        id: "validation",
        kind: "cmd",
        value: "npm test",
        target: "npm test",
        sourceTool: "run_command",
        createdAt: 3,
      }],
    },
    activeProfile: "cloud",
    iteration: 9,
    workflowMode: "plan",
    approvedPlanAuditForNoTool: completeAudit,
    rejectedCompletionClaim: false,
    availableToolNames: new Set(["read_file", "run_command"]),
    consecutiveNoToolCount: 0,
    executeRecoveryState: { mode: "validation_only" },
    emitTaskOrchestratorPhase: (phase, extra) => harness.taskPhases.push({ phase, extra }),
    emitPlanExecutionProgress: (phase, overrides) => harness.progress.push({ phase, overrides }),
  });

  assert.equal(result.status, "continue");
  assert.deepEqual(harness.taskPhases, []);
  assert.deepEqual(harness.stages, []);
  assert.equal(harness.progress.some((entry) => entry.phase === "completed"), false);
  assert.match(harness.appended.at(-1)?.content || "", /active_recovery:validation_only/);
});

test("strict repeat guard redirects repeated successful shell inspection without rewriting it as failed", () => {
  const harness = createStrictRepeatGuardHarness("en");
  const recentToolCalls = [];
  const failedToolCallCounts = new Map();
  let result = null;

  for (let i = 0; i < 3; i += 1) {
    result = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
      effectiveToolCalls: [{
        id: `call_shell_${i}`,
        name: "run_command",
        arguments: JSON.stringify({ command: "sed -n '1,20p' src/App.tsx" }),
      }],
      recentToolCalls,
      failedToolCallCounts,
    }));
  }

  assert.equal(result.status, "continue");
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /System:/);
  assert.equal(harness.toolErrors.length, 0);
  assert.deepEqual([...failedToolCallCounts.values()], []);
});

test("strict repeat guard uses two pivots before pausing repeated approved-plan browser validation", () => {
  const harness = createStrictRepeatGuardHarness("zh");
  const recentToolCalls = [];
  const repeatGuardRecoveredSignatures = new Set();
  let result = null;

  for (let i = 0; i < 3; i += 1) {
    result = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
      effectiveToolCalls: [{
        id: `call_browser_recover_${i}`,
        name: "browser_evaluate",
        arguments: JSON.stringify({ url: "http://localhost:5173", script: "document.body.innerText" }),
      }],
      recentToolCalls,
      repeatGuardRecoveredSignatures,
    }));
  }

  assert.equal(result.status, "continue");
  assert.equal(harness.toolErrors.length, 0);
  assert.match(harness.appended.at(-1)?.content || "", /current_task_action_lock/);

  for (let i = 0; i < 3; i += 1) {
    result = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
      effectiveToolCalls: [{
        id: `call_browser_pause_${i}`,
        name: "browser_evaluate",
        arguments: JSON.stringify({ url: "http://localhost:5173", script: "document.body.innerText" }),
      }],
      recentToolCalls,
      repeatGuardRecoveredSignatures,
    }));
  }

  assert.equal(result.status, "continue");
  assert.match(harness.appended.at(-1)?.content || "", /alternate_capability_reframe/);
  assert.equal(harness.stops.length, 0);

  for (let i = 0; i < 3; i += 1) {
    result = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
      effectiveToolCalls: [{
        id: `call_browser_pause_${i}`,
        name: "browser_evaluate",
        arguments: JSON.stringify({ url: "http://localhost:5173", script: "document.body.innerText" }),
      }],
      recentToolCalls,
      repeatGuardRecoveredSignatures,
    }));
  }

  assert.equal(result.status, "stopped");
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "no_action");
  assert.match(harness.stops[0].message, /浏览器验证重复调用/);
  assert.equal(harness.stops[0].metadata.recoveryReason, "approved_plan_repeated_browser_validation");
  assert.deepEqual(harness.statuses.slice(-1), ["idle"]);
});

test("strict repeat guard redirects repeated PTY controls to observation without failing the task", () => {
  const harness = createStrictRepeatGuardHarness("zh");
  const recentToolCalls = [];
  let result = null;

  for (let i = 0; i < 3; i += 1) {
    result = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
      effectiveToolCalls: [{
        id: `call_interrupt_${i}`,
        name: "send_pty_input",
        arguments: JSON.stringify({ control: "interrupt" }),
      }],
      recentToolCalls,
      availableToolNames: new Set(["send_pty_input", "get_pty_status", "read_pty_since"]),
    }));
  }

  assert.equal(result.status, "continue");
  assert.equal(harness.toolErrors.length, 0);
  assert.equal(harness.stops.length, 0);
  assert.equal(harness.toolDone.length, 1);
  assert.match(harness.toolDone[0].message, /PTY_CONTROL_ALREADY_SENT/);
  assert.match(harness.appended.at(-1)?.content || "", /get_pty_status\/read_pty_since/);
});

test("strict repeat guard leaves policy deferrals to protocol no-progress while retaining real command protection", () => {
  const harness = createStrictRepeatGuardHarness("en");
  const recentToolCalls = [];
  const repeatGuardRecoveredSignatures = new Set();
  let result = null;

  for (let i = 0; i < 3; i += 1) {
    const call = {
      id: `call_deferred_dev_${i}`,
      name: "execute_command",
      arguments: JSON.stringify({ command: "npm run dev" }),
    };
    result = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
      effectiveToolCalls: [call],
      results: [{
        toolCallId: call.id,
        name: call.name,
        target: "npm run dev",
        content: "EXECUTE_RECOVERY_BATCH_DEFERRED",
        displayContent: "",
        isError: false,
        lifecycleState: "completed",
        internalFeedback: true,
        qualityGateReason: "execute_recovery_batch_deferred",
      }],
      recentToolCalls,
      availableToolNames: new Set(["execute_command"]),
    }));
  }

  assert.equal(result.status, "none");
  assert.equal(recentToolCalls.length, 0);
  assert.equal(harness.errors.length, 0);

  for (let i = 0; i < 3; i += 1) {
    const call = {
      id: `call_executed_dev_${i}`,
      name: "execute_command",
      arguments: JSON.stringify({ command: "npm run dev" }),
    };
    result = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
      effectiveToolCalls: [call],
      results: [{
        toolCallId: call.id,
        name: call.name,
        target: "npm run dev",
        content: "command completed",
        isError: false,
        lifecycleState: "completed",
      }],
      recentToolCalls,
      repeatGuardRecoveredSignatures,
      availableToolNames: new Set(["execute_command"]),
    }));
  }

  assert.equal(result.status, "continue");
  assert.match(harness.appended.at(-1)?.content || "", /current_task_action_lock/);

  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (let i = 0; i < 3; i += 1) {
      const call = {
        id: `call_executed_dev_${cycle}_${i}`,
        name: "execute_command",
        arguments: JSON.stringify({ command: "npm run dev" }),
      };
      result = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
        effectiveToolCalls: [call],
        results: [{
          toolCallId: call.id,
          name: call.name,
          target: "npm run dev",
          content: "command completed",
          isError: false,
          lifecycleState: "completed",
        }],
        recentToolCalls,
        repeatGuardRecoveredSignatures,
        availableToolNames: new Set(["execute_command"]),
      }));
    }
    if (cycle === 0) {
      assert.equal(result.status, "continue");
      assert.match(harness.appended.at(-1)?.content || "", /alternate_capability_reframe/);
    }
  }

  assert.equal(result.status, "stopped");
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].metadata.recoveryReason, "strict_repeat_strategy_exhausted");
  assert.deepEqual(harness.statuses.slice(-1), ["idle"]);
});

test("repeated-failure policy feedback uses two pivots before a recoverable pause", () => {
  const harness = createStrictRepeatGuardHarness("en");
  harness.callbacks.getIsPlanApproved = () => false;
  const repeatGuardRecoveredSignatures = new Set();
  const createCall = (id) => ({
    id,
    name: "list_directory",
    arguments: JSON.stringify({ path: ".missing" }),
  });
  const createPolicyResult = (call, qualityGateReason = "repeated_failure_blocked") => ({
    toolCallId: call.id,
    name: call.name,
    target: ".missing",
    content: "REPEATED_FAILURE_BLOCKED",
    displayContent: "REPEATED_FAILURE_BLOCKED",
    isError: false,
    lifecycleState: "blocked",
    internalFeedback: true,
    qualityGateReason,
  });

  const firstCall = createCall("policy-1");
  const first = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
    effectiveToolCalls: [firstCall],
    results: [createPolicyResult(firstCall)],
    repeatGuardRecoveredSignatures,
  }));
  assert.equal(first.status, "continue");
  assert.equal(harness.appended.length, 1);
  assert.equal(harness.errors.length, 0);

  const secondCall = createCall("policy-2");
  const second = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
    effectiveToolCalls: [secondCall],
    results: [createPolicyResult(secondCall, "repeated_failure_exhausted")],
    repeatGuardRecoveredSignatures,
  }));
  assert.equal(second.status, "continue");
  assert.match(harness.appended.at(-1)?.content || "", /alternate_capability_reframe/);
  assert.equal(harness.stops.length, 0);

  const thirdCall = createCall("policy-3");
  const third = handleStrictRepeatGuardRecovery(createRepeatGuardInput(harness, {
    effectiveToolCalls: [thirdCall],
    results: [createPolicyResult(thirdCall, "repeated_failure_exhausted")],
    repeatGuardRecoveredSignatures,
  }));
  assert.equal(third.status, "stopped");
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "no_action");
  assert.equal(harness.stops[0].metadata.recoveryReason, "repeated_failure_policy_no_progress");
  assert.equal(harness.errors.length, 0);
  assert.deepEqual(harness.statuses.slice(-1), ["idle"]);
});

test("max-iteration checkpoint keeps internal plan files out of project-source evidence", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 0,
    autoResumeEligible: true,
    tasks,
    evidenceLedger: [...evidenceLedger, {
      id: "document-observation",
      kind: "tool",
      value: "docs/runtime-notes.md",
      target: "docs/runtime-notes.md",
      sourceTool: "read_document",
      createdAt: 3,
    }],
    recentToolActivity: [{ name: "replace_in_file", target: "src/lib/orchestrator.ts", status: "succeeded" }],
    lastAssistantText: "Continuing with tests.",
  });

  assert.equal(checkpoint.reason, "max_iterations_checkpoint");
  assert.equal(checkpoint.currentTask.includes("Add resume guard tests"), true);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes("src/lib/orchestrator.ts")), true);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes(".MAIN/plans")), false);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes("runtime-notes")), false);
});

test("pause notice is structured after the differentiated strategy fuse is exhausted", () => {
  const exhausted = resolveMaxIterationStrategyPivot({
    autoResumeCount: PLAN_MAX_AUTO_RESUME_LIMIT,
    objectiveComplete: false,
    nextRequiredCapability: "mutation",
  });
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: PLAN_MAX_AUTO_RESUME_LIMIT,
    autoResumeEligible: false,
    strategyPivot: exhausted.selected,
    attemptedStrategyPivots: exhausted.attempted,
    remainingStrategyPivots: exhausted.remaining,
    strategyPivotBudget: exhausted.hardLimit,
    strategyCapability: "mutation",
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "run_command", target: "npm test", status: "failed", detail: "exitCode 1" }],
    unresolvedBlockers: ["Agent loop reached maximum iterations (50)."],
  });
  const notice = buildPlanMaxIterationsPauseNotice(checkpoint, "en");

  assert.match(notice, /RecoveryDetails:/);
  assert.match(notice, /autoResumeCount: 3\/3/);
  assert.match(notice, /continue_contract, reconcile_evidence, bounded_alternative/);
  assert.match(notice, /Resume Execution/);
  assert.match(notice, /Add resume guard tests/);
});

test("max-iteration strategy pivots are provider-neutral, differentiated, and finite", () => {
  const first = resolveMaxIterationStrategyPivot({
    autoResumeCount: 0,
    objectiveComplete: false,
    nextRequiredCapability: "mutation",
  });
  const second = resolveMaxIterationStrategyPivot({
    autoResumeCount: 1,
    objectiveComplete: false,
    nextRequiredCapability: "mutation",
  });
  const third = resolveMaxIterationStrategyPivot({
    autoResumeCount: 2,
    objectiveComplete: false,
    nextRequiredCapability: "validation",
  });
  const exhausted = resolveMaxIterationStrategyPivot({
    autoResumeCount: 3,
    objectiveComplete: false,
    nextRequiredCapability: "validation",
  });
  const blocked = resolveMaxIterationStrategyPivot({
    autoResumeCount: 0,
    objectiveComplete: false,
    nextRequiredCapability: "mutation",
    hardBlocked: true,
  });
  const completed = resolveMaxIterationStrategyPivot({
    autoResumeCount: 0,
    objectiveComplete: true,
    nextRequiredCapability: "any",
  });

  assert.deepEqual(
    [first.selected, second.selected, third.selected, exhausted.selected],
    ["continue_contract", "reconcile_evidence", "bounded_alternative", null],
  );
  assert.equal(first.hardLimit, PLAN_MAX_AUTO_RESUME_LIMIT);
  assert.deepEqual(third.attempted, ["continue_contract", "reconcile_evidence"]);
  assert.equal(blocked.selected, null);
  assert.deepEqual(blocked.remaining, []);
  assert.equal(completed.selected, "synthesize_completion");
  assert.equal(completed.hardLimit, 1);
});

test("execute max-iteration notices describe a recoverable boundary instead of failure", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: PLAN_MAX_AUTO_RESUME_LIMIT,
    autoResumeEligible: false,
    tasks: [],
    evidenceLedger: [],
    recentToolActivity: [{ name: "run_command", target: "npm test", status: "succeeded", detail: "exitCode 0" }],
    lastAssistantText: "继续验证剩余步骤。",
    unresolvedBlockers: ["Agent loop reached maximum iterations (50)."],
  });

  const autoNotice = buildExecuteMaxIterationsAutoResumeNotice({
    ...checkpoint,
    autoResumeCount: 1,
    strategyPivot: "continue_contract",
    strategyCapability: "validation",
    strategyPivotBudget: PLAN_MAX_AUTO_RESUME_LIMIT,
  }, "zh");
  const pauseNotice = buildExecuteMaxIterationsPauseNotice(checkpoint, "zh");
  const prompt = buildExecuteMaxIterationsResumePrompt({ language: "zh", checkpoint });

  assert.match(autoNotice, /恢复点/);
  assert.match(autoNotice, /差异化策略 1\/3/);
  assert.match(autoNotice, /validation/);
  assert.match(pauseNotice, /不是工具权限或模式切换失败/);
  assert.match(pauseNotice, /Resume Execution/);
  assert.match(pauseNotice, /复用已读上下文/);
  assert.match(pauseNotice, /重复只读/);
  assert.match(prompt, /如果任务已经完成，直接输出最终总结/);
  assert.match(prompt, /普通 Execute 50 轮安全边界/);
  assert.match(prompt, /selectedStrategyPivot/);
});

test("execute max-iteration recovery resumes validation after a completed mutation", () => {
  const mutation = {
    id: "mutation-before-boundary",
    kind: "file",
    value: "src/App.tsx",
    target: "src/App.tsx",
    sourceTool: "apply_patch",
    createdAt: 1,
  };

  const decision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [mutation],
  });

  assert.deepEqual(decision, {
    mode: "finite_validation_only",
    gap: "validation_after_mutation_required",
    reason: "max_iterations_validation_after_mutation",
  });
});

test("execute max-iteration recovery ignores evidence from older transactions", () => {
  const decision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [{
      id: "old-mutation",
      transactionId: "turn-old",
      kind: "file",
      value: "src/old.ts",
      target: "src/old.ts",
      sourceTool: "apply_patch",
      createdAt: 1,
    }],
    transactionId: "turn-current",
  });

  assert.deepEqual(decision, {
    mode: "finite_validation_only",
    gap: "validation_required",
    reason: "max_iterations_validation_required",
  });
});

test("execute max-iteration recovery migrates a legacy post-mutation read lease to validation", () => {
  const decision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [{
      id: "mutation-before-post-check",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 1,
    }],
    recoveryState: {
      mode: "validation_only",
      expectedTarget: "src/App.tsx",
      readLease: {
        purpose: "post_mutation_verify",
        target: "src/App.tsx",
        state: "available",
      },
      sourceObservationKey: "src/App.tsx@after-mutation",
    },
  });

  assert.deepEqual(decision, {
    mode: "finite_validation_only",
    gap: "validation_after_mutation_required",
    reason: "max_iterations_validation_after_mutation",
  });
});

test("execute max-iteration recovery permits final synthesis when evidence is already closed", () => {
  const decision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [{
      id: "mutation-before-validation",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 1,
    }, {
      id: "validation-before-boundary",
      kind: "cmd",
      value: "npm test",
      target: "npm test",
      sourceTool: "run_command",
      createdAt: 2,
    }],
  });

  assert.deepEqual(decision, {
    mode: "normal",
    gap: "none",
    reason: "max_iterations_evidence_complete",
  });
});

test("execute max-iteration recovery preserves a pending root objective audit", () => {
  const decision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [{
      id: "mutation-before-audit",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 1,
    }, {
      id: "validation-before-audit",
      kind: "cmd",
      value: "npm test",
      target: "npm test",
      sourceTool: "run_command",
      createdAt: 2,
    }],
    recoveryState: {
      mode: "objective_audit",
      reason: "objective_closure_audit_required",
      expectedTarget: "src/App.tsx",
      decisionCheckpoint: {
        expectedTarget: "src/App.tsx",
        sourceObservationKey: "app-v2",
        nextRequiredCapability: "any",
        objectiveObligationId: "root:direct-edit",
        objectiveRevision: 2,
        objectiveKind: "root",
        objectiveExpectedTargets: ["src/App.tsx"],
        objectiveMutationEvidence: [{ target: "src/App.tsx" }],
        objectiveValidationEvidence: {
          tool: "run_command",
          target: "npm test",
          revision: 2,
        },
        objectiveClosurePending: true,
      },
    },
  });

  assert.deepEqual(decision, {
    mode: "objective_audit",
    gap: "none",
    reason: "max_iterations_objective_audit_pending",
  });
});

test("execute max-iteration recovery observes every long process but requests browser only for interaction obligations", () => {
  const mutation = {
    id: "mutation-before-server",
    kind: "file",
    value: "src/App.tsx",
    target: "src/App.tsx",
    sourceTool: "apply_patch",
    createdAt: 1,
  };
  const launch = {
    id: "dev-server-launch",
    kind: "cmd",
    value: "npm run dev",
    target: "npm run dev",
    sourceTool: "execute_command",
    observationStatus: "pending",
    foregroundGeneration: 7,
    createdAt: 2,
  };

  const observeDecision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [mutation, launch],
  });
  assert.equal(observeDecision.mode, "validation_only");
  assert.equal(observeDecision.gap, "pty_observation_required");

  const ready = {
    id: "dev-server-ready",
    kind: "dev_server_url",
    value: "http://localhost:1420/",
    target: "terminal",
    sourceTool: "read_pty_since",
    observationStatus: "ready",
    foregroundGeneration: 7,
    createdAt: 3,
  };
  const readyProcessDecision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [mutation, launch, ready],
  });
  assert.equal(readyProcessDecision.mode, "normal");
  assert.equal(readyProcessDecision.gap, "none");

  const interactionMutation = {
    ...mutation,
    id: "interaction-mutation-before-server",
    interactionMutation: true,
    interactionBehaviorTargets: ["#new-btn"],
  };
  const browserDecision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [interactionMutation, launch, ready],
  });
  assert.equal(browserDecision.mode, "validation_only");
  assert.equal(browserDecision.gap, "browser_validation_required");
});

test("execute max-iteration recovery repairs browser-observed source failures instead of retrying server validation", () => {
  const decision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [{
      id: "browser-source-mutation",
      kind: "file",
      value: "src/main.js",
      target: "src/main.js",
      sourceTool: "replace_in_file",
      createdAt: 1,
    }, {
      id: "browser-source-failure",
      kind: "tool",
      value: "http://localhost:1420/",
      target: "http://localhost:1420/",
      sourceTool: "browser_evaluate",
      observationStatus: "failed",
      references: ["src/main.js"],
      browserInteraction: {
        actions: [{ kind: "click", target: "#new-btn", succeeded: true }],
        assertions: [],
        pageErrors: ["ReferenceError: handleFileOpen is not defined at src/main.js:92:42"],
        consoleErrors: [],
      },
      createdAt: 2,
    }],
  });

  assert.deepEqual(decision, {
    mode: "mutation_first",
    gap: "unreconciled_failure",
    reason: "max_iterations_browser_source_repair",
  });
});

test("resume prompt requires fresh workspace reads and treats .MAIN plans as internal state", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 1,
    autoResumeEligible: true,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/store/useAppStore.ts", status: "succeeded" }],
  });
  const prompt = buildPlanMaxIterationsResumePrompt({
    language: "en",
    checkpoint,
    hasTasksArtifact: true,
    tasks,
    artifacts: [{ kind: "tasks", path: ".MAIN/plans/tasks.md", title: "Tasks", content: "- [ ] Add resume guard tests", updatedAt: 1 }],
    evidenceLedger,
  });

  assert.match(prompt, /fresh recovery context/);
  assert.match(prompt, /Do not treat `\.MAIN\/plans` as project-source evidence/);
  assert.match(prompt, /First reread current workspace state/);
  assert.match(prompt, /Add resume guard tests/);
});

test("resume prompt does not tell the model to read missing optional tasks.md", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 1,
    autoResumeEligible: false,
    tasks,
    evidenceLedger: [],
    recentToolActivity: [{ name: "read_file", target: "src/App.tsx", status: "succeeded" }],
  });
  const prompt = buildPlanMaxIterationsResumePrompt({
    language: "zh",
    checkpoint,
    hasTasksArtifact: false,
    tasks,
    artifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Design", content: "# Design\n\n方案", updatedAt: 1 }],
    evidenceLedger: [],
  });

  assert.match(prompt, /runtime 任务清单/);
  assert.match(prompt, /不要为了确认它是否存在而读取它/);
  assert.doesNotMatch(prompt, /先重新读取当前 workspace 状态和 `\.MAIN\/plans\/tasks\.md`/);
});

test("empty checkpoint fallback treats tasks.md as optional", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 1,
    autoResumeEligible: false,
    tasks: [],
    evidenceLedger: [],
    recentToolActivity: [{ name: "read_file", target: "src/App.tsx", status: "succeeded" }],
  });
  const notice = buildPlanMaxIterationsPauseNotice(checkpoint, "zh");

  assert.match(checkpoint.currentTask, /runtime task list/);
  assert.match(checkpoint.remainingTasks.join("\n"), /Read tasks\.md only if it is already known to exist/);
  assert.match(notice, /runtime 任务清单/);
  assert.match(notice, /只有已知存在时才读取 tasks\.md/);
  assert.doesNotMatch(notice, /重新读取 tasks\.md/);
});

test("plan execution progress snapshot is structured and ignores internal plan evidence", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "en",
    phase: "tool_done",
    iterationCount: 7,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/lib/orchestrator.ts", status: "succeeded" }],
  });
  const snapshot = normalizePlanExecutionProgressSnapshot({
    turnId: "turn-1",
    update,
    now: 123,
  });
  const text = formatPlanExecutionProgressSnapshot(snapshot, "en");

  assert.equal(snapshot.turnId, "turn-1");
  assert.equal(snapshot.phase, "tool_done");
  assert.equal(snapshot.iteration, 7);
  assert.match(snapshot.currentTask, /Update orchestrator recovery handling/);
  assert.match(snapshot.latestEvidence, /src\/lib\/orchestrator\.ts/);
  assert.match(snapshot.nextStep, /Add resume guard tests/);
  assert.doesNotMatch(snapshot.latestEvidence, /\.MAIN\/plans/);
  assert.match(text, /Tool done/);
  assert.match(text, /Tool result recorded/);
  assert.doesNotMatch(text, /Current task:/);
  assert.doesNotMatch(text, /Latest evidence:/);
  assert.doesNotMatch(text, /Current tool:/);
  assert.doesNotMatch(text, /Next:/);
});

test("plan execution progress keeps missing audit state out of the user-facing task headline", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "running",
    iterationCount: 1,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks: [{
      id: "startup",
      text: "启动桌面应用并检查启动输出",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "cmd", value: "npm run tauri dev" }],
    }],
    evidenceLedger: [],
    recentToolActivity: [],
  });

  assert.match(update.currentTask, /启动桌面应用/);
  assert.doesNotMatch(update.currentTask, /\[missing\]/);
});

test("plan execution checkpoints map to canonical runtime progress states", () => {
  const baseSnapshot = {
    turnId: "turn-1",
    currentTask: "修复保存命令",
    currentTool: "replace_in_file · src-tauri/src/main.rs",
    latestEvidence: "已确认前端引用 save_file_content",
    nextStep: "运行定向检查",
    iteration: 2,
    maxIterations: 50,
    autoResumeCount: 0,
    updatedAt: 123,
  };
  const running = toPlanExecutionRuntimeProgressUpdate({
    snapshot: { ...baseSnapshot, phase: "tool_start" },
    language: "zh",
    dedupeKey: "plan-execution-progress:run-child",
  });
  const paused = toPlanExecutionRuntimeProgressUpdate({
    snapshot: { ...baseSnapshot, phase: "paused" },
    language: "zh",
  });
  const failed = toPlanExecutionRuntimeProgressUpdate({
    snapshot: { ...baseSnapshot, phase: "tool_error" },
    language: "zh",
  });

  assert.deepEqual(
    { phase: running.phase, title: running.title, status: running.status, dedupeKey: running.dedupeKey },
    {
      phase: "plan_execution:tool_start",
      title: "正在执行已批准计划",
      status: "running",
      dedupeKey: "plan-execution-progress:run-child",
    },
  );
  assert.match(running.summary, /修复保存命令/);
  assert.equal(running.tool, "replace_in_file");
  assert.equal(running.canonicalTarget, "src-tauri/src/main.rs");
  assert.equal(paused.status, "paused");
  assert.equal(paused.title, "计划执行已暂停");
  assert.equal(failed.status, "failed");
  assert.equal(failed.title, "计划执行工具失败");
});

test("plan execution progress preserves an explicit runtime task from the orchestrator", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "tool_start",
    iterationCount: 8,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [],
    currentTask: "按顺序修复 src/components/toolbar.js 的文件选择对话框",
    currentTool: "replace_in_file · src/components/toolbar.js",
  });

  assert.equal(update.currentTask, "按顺序修复 src/components/toolbar.js 的文件选择对话框");
  assert.match(update.currentTool, /toolbar\.js/);
});

test("no-progress loop notice names repeated target evidence gap and recovery action", () => {
  const recentToolActivity = [
    { name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts" },
    { name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts" },
    { name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts" },
  ];
  const notice = buildPlanNoProgressLoopPauseNotice({
    language: "zh",
    repeats: 3,
    remainingTask: "测试所有页面和组件 [需要浏览器验证]",
    evidenceLedger,
    recentToolActivity,
  });
  const signature = buildPlanProgressSignatureFromToolActivity(recentToolActivity);

  assert.match(notice, /连续重复探索/);
  assert.match(notice, /src\/store\/dashboardstore\.ts/i);
  assert.match(notice, /缺失证据：测试所有页面和组件/);
  assert.match(notice, /Browser\/Playwright/);
  assert.match(signature, /cached/);
});

test("cached read-only helpers identify repeated plan targets", () => {
  const recentToolActivity = [
    { name: "grep_search", target: "loadOrders", status: "succeeded", detail: "src/store/dashboardStore.ts:307" },
    { name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts" },
    { name: "read_file", target: "src/hooks/useChartData.ts", status: "succeeded", detail: "READ_FILE_RESULT path: src/hooks/useChartData.ts" },
  ];

  assert.equal(isCachedReadOnlyPlanActivity(recentToolActivity[1]), true);
  assert.equal(isCachedReadOnlyPlanActivity(recentToolActivity[2]), false);
  assert.deepEqual(
    summarizeRepeatedPlanTargetsFromToolActivity(recentToolActivity),
    ["src/store/dashboardstore.ts"],
  );
});

test("approved cached reads enter the unified execute recovery contract", () => {
  const loopRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"), "utf8");

  assert.match(
    loopRecoverySource,
    /approvedPlanCachedReadOnlyBatch[\s\S]*?activateTrackedExecuteRecovery\(\s*"mutation_first",\s*"no_progress_cached_read_only_batch"/,
  );
  assert.match(loopRecoverySource, /isApprovedPlanCachedReadOnlyNoProgressBatch/);
});

test("approved execution repeated cached reads replay prior content after the first stub", () => {
  const replay = buildFileUnchangedReplayContent({
    signature: "read_file::src/App.tsx::[]",
    path: "src/App.tsx",
    argsKey: "[]",
    contentHash: "abc123",
    contentLength: 42,
    sizeBytes: 42,
    modifiedMs: 123,
    modelContent: "L1: import React from 'react';",
    updatedAt: 1,
  }, 2);
  const toolCallPartitioningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");

  assert.match(replay, /CACHED_FILE_REPLAY/);
  assert.match(replay, /L1: import React/);
  assert.match(
    toolCallPartitioningSource,
    /contextStillActive|contentStillActive/,
  );
  assert.match(toolCallPartitioningSource, /context_evicted_replay/);
  assert.match(toolCallPartitioningSource, /buildFileUnchangedReplayContent/);
});

test("approved plan convergence activates mutation recovery for an unfinished source task", () => {
  const appended = [];
  const activations = [];
  const callbacks = {
    appendMessage: (message) => appended.push(message),
    getIsPlanApproved: () => true,
    getPlanTasks: () => [{
      id: "edit-main",
      text: "修改 src/main.js 添加初始化错误处理",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "file", value: "src/main.js" }],
    }],
    getPlanExecutionEvidenceLedger: () => [],
  };

  const result = handleExecuteConvergencePrompt({
    callbacks,
    workflowMode: "edit",
    runtimeIntent: "execute",
    iteration: 12,
    effectiveMaxIterations: 50,
    usedExecuteConvergencePrompt: false,
    recentToolActivity: Array.from({ length: 12 }, () => ({
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
    })),
    executeRecoveryMode: "normal",
    activateExecuteRecovery: (...args) => activations.push(args),
  });

  assert.equal(result.usedExecuteConvergencePrompt, true);
  assert.equal(activations.length, 1);
  assert.equal(activations[0][0], "mutation_first");
  assert.equal(activations[0][1], "execute_convergence_prompt");
  assert.equal(activations[0][2].resetExpectedTarget, true);
  assert.equal(appended.length, 1);
});

test("direct Execute converges at the same bounded checkpoint and validates existing mutations", () => {
  const appended = [];
  const activations = [];
  const callbacks = {
    appendMessage: (message) => appended.push(message),
    getIsPlanApproved: () => false,
    getCurrentTurnId: () => "turn-direct",
    getPlanTasks: () => [],
    getPlanExecutionEvidenceLedger: () => [{
      id: "direct-write",
      kind: "file",
      value: "src/main.js",
      target: "src/main.js",
      sourceTool: "apply_patch",
      transactionId: "turn-direct",
      createdAt: 1,
    }],
  };

  const beforeBoundary = handleExecuteConvergencePrompt({
    callbacks,
    workflowMode: "edit",
    runtimeIntent: "execute",
    iteration: 11,
    effectiveMaxIterations: 50,
    usedExecuteConvergencePrompt: false,
    recentToolActivity: [],
    executeRecoveryMode: "normal",
    activateExecuteRecovery: (...args) => activations.push(args),
  });
  assert.equal(beforeBoundary.usedExecuteConvergencePrompt, false);

  const atBoundary = handleExecuteConvergencePrompt({
    callbacks,
    workflowMode: "edit",
    runtimeIntent: "execute",
    iteration: 12,
    effectiveMaxIterations: 50,
    usedExecuteConvergencePrompt: false,
    recentToolActivity: [],
    executeRecoveryMode: "normal",
    activateExecuteRecovery: (...args) => activations.push(args),
  });
  assert.equal(atBoundary.usedExecuteConvergencePrompt, true);
  assert.equal(activations.length, 1);
  assert.equal(activations[0][0], "validation_only");
  assert.equal(activations[0][2].resetExpectedTarget, true);
  assert.equal(appended.length, 1);
});

test("direct Execute convergence preserves an unfinished mutation transaction", () => {
  const appended = [];
  const activations = [];
  const callbacks = {
    appendMessage: (message) => appended.push(message),
    getIsPlanApproved: () => false,
    getCurrentTurnId: () => "turn-direct",
    getPlanTasks: () => [],
    getPlanExecutionEvidenceLedger: () => [{
      id: "earlier-write",
      kind: "file",
      value: "src/main.js",
      target: "src/main.js",
      sourceTool: "replace_in_file",
      transactionId: "turn-direct",
      createdAt: 1,
    }],
  };

  const result = handleExecuteConvergencePrompt({
    callbacks,
    workflowMode: "edit",
    runtimeIntent: "execute",
    iteration: 12,
    effectiveMaxIterations: 50,
    usedExecuteConvergencePrompt: false,
    recentToolActivity: [],
    executeRecoveryMode: "mutation_first",
    activateExecuteRecovery: (...args) => activations.push(args),
  });

  assert.equal(result.usedExecuteConvergencePrompt, true);
  assert.deepEqual(activations, []);
  assert.deepEqual(appended, []);
});

test("approved plan convergence moves to validation after composite task source evidence is satisfied", () => {
  const appended = [];
  const activations = [];
  const callbacks = {
    appendMessage: (message) => appended.push(message),
    getIsPlanApproved: () => true,
    getPlanTasks: () => [{
      id: "edit-and-test",
      text: "Modify src/main.js, then run npm test",
      status: "in_progress",
      executionKind: "mutation",
      commands: ["npm test"],
      evidenceStatus: "partial",
      evidence: [
        { kind: "file", value: "src/main.js" },
        { kind: "cmd", value: "npm test" },
      ],
    }],
    getPlanExecutionEvidenceLedger: () => [{
      id: "main-write",
      kind: "file",
      value: "src/main.js",
      target: "src/main.js",
      sourceTool: "apply_patch",
      createdAt: 1,
    }],
  };

  const result = handleExecuteConvergencePrompt({
    callbacks,
    workflowMode: "edit",
    runtimeIntent: "execute",
    iteration: 12,
    effectiveMaxIterations: 50,
    usedExecuteConvergencePrompt: false,
    recentToolActivity: Array.from({ length: 12 }, () => ({
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
    })),
    executeRecoveryMode: "normal",
    activateExecuteRecovery: (...args) => activations.push(args),
  });

  assert.equal(result.usedExecuteConvergencePrompt, true);
  assert.equal(activations.length, 0);
  assert.equal(appended.length, 1);
});

test("approved plan execution starts with the normal execute tool surface", () => {
  const orchestratorSource = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"));
  const planReviewRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planReviewRuntime.ts"), "utf8");
  const appStoreSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const asyncRunSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitAsyncWorkflowRun.ts"), "utf8");
  const loopMutableStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopMutableState.ts"), "utf8");

  assert.match(
    loopMutableStateSource,
    /executeRecoveryState:\s*createExecuteRecoveryRuntimeState\(\{/,
  );
  assert.match(planReviewRuntimeSource, /Approval belongs to a fresh child run/);
  assert.match(appStoreSource, /plan_review_run_paused_for_child_execution/);
  assert.match(appStoreSource, /planLifecycle:\s*approvedPlanLifecycle[\s\S]*isPlanApproved:\s*false/);
  assert.match(asyncRunSource, /phaseRunners\.startRunLease \|\| startSubmitRunLease\)[\s\S]*commitPlanExecutionRunAdmission/);
  assert.match(asyncRunSource, /type:\s*"execution_started"/);
  assert.match(appStoreSource, /startApprovedPlanExecutionInCurrentTurn/);
});

test("approved plan no-progress recovery uses the unified execution contract", () => {
  const readOnlyTools = new Set(["read_file"]);
  const mutationContract = resolveExecuteRecoveryActionContract("mutation_first", {
    expectedTarget: "src/App.tsx",
  });

  assert.equal(mutationContract.phase, "mutation");
  assert.equal(mutationContract.surfaceDescription, "capability:mutation");
  assert.equal(mutationContract.allowTargetedFileRead, false);
  assert.equal(
    isExecuteRecoveryToolName("read_file", readOnlyTools, { contract: mutationContract }),
    false,
  );
  assert.equal(
    isExecuteRecoveryToolName("apply_patch", readOnlyTools, { contract: mutationContract }),
    true,
  );
  assert.equal(
    isExecuteRecoveryToolName("run_command", readOnlyTools, { contract: mutationContract }),
    false,
  );
  assert.equal(
    isExecuteRecoveryToolName("list_directory", readOnlyTools, { contract: mutationContract }),
    false,
  );

  const patchReadContract = resolveExecuteRecoveryActionContract("patch_recovery_read", {
    expectedTarget: "src/App.tsx",
    readLease: {
      purpose: "patch_recovery",
      target: "src/App.tsx",
      state: "available",
    },
  });
  assert.equal(patchReadContract.phase, "context");
  assert.equal(patchReadContract.nextRequiredCapability, "targeted_read");

  const toolCallPlanningSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"),
    "utf8",
  );
  const toolCallPartitioningSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"),
    "utf8",
  );
  assert.match(
    toolCallPlanningSource,
    /const initialBaseIterationAllTools =[\s\S]*?workflowMode === "plan"[\s\S]*?recoveryIterationAllTools/,
  );
  assert.match(toolCallPlanningSource, /recoveryToolSurface: recoveryActionContract\.surfaceDescription/);
  assert.doesNotMatch(toolCallPartitioningSource, /patch_recovery_read_cache_bypass/);
});

test("approved source task consumes one initial read lease then opens mutation only", () => {
  const initial = resolveApprovedPlanInitialExecutionRecovery([{
    id: "edit-main",
    text: "Modify the backend",
    status: "in_progress",
    evidenceStatus: "missing",
    evidence: [{ kind: "file", value: "src/main.rs" }],
  }]);
  assert.ok(initial);
  const state = createExecuteRecoveryRuntimeState({
    workflowMode: "edit",
    forcedState: initial,
  });
  const initialContract = resolveExecuteRecoveryActionContract(state.mode, state);
  assert.equal(initialContract.allowedToolNames.has("read_file"), true);
  assert.equal(initialContract.allowedToolNames.has("apply_patch"), false);
  assert.equal(initialContract.allowedToolNames.has("run_command"), false);

  const observed = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.rs",
    sourceObservationKey: "src/main.rs::v1::1-200",
    sourceObservedVersion: "4096:1",
  });
  assert.equal(observed.transition, "context_to_mutation");
  assert.equal(observed.state.readLease?.state, "consumed");
  const mutationContract = resolveExecuteRecoveryActionContract(
    observed.state.mode,
    observed.state,
  );
  assert.equal(mutationContract.allowTargetedFileRead, false);
  assert.equal(mutationContract.allowedToolNames.has("read_file"), false);
  assert.equal(mutationContract.allowedToolNames.has("apply_patch"), true);
});
test("approved plan execution has no source-edit-first tool surface or shell veto", () => {
  const orchestratorSource = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"));
  const iterationStreamPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"), "utf8");
  const toolCallPlanningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"), "utf8");
  const toolCallPartitioningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");
  assert.match(orchestratorSource, /prepareIterationStreamRequest\(\{/);
  assert.match(iterationStreamPreparationSource, /resolveIterationToolSurface\(\{/);
  assert.doesNotMatch(orchestratorSource, /buildApprovedPlanSourceEditFirstPrompt/);
  assert.doesNotMatch(toolCallPlanningSource, /approvedPlanSourceEditFirst|source_edit_first/);
  assert.doesNotMatch(toolCallPartitioningSource, /APPROVED_PLAN_SHELL_READ_BLOCKED/);
  assert.doesNotMatch(toolCallPartitioningSource, /approved_plan_shell_read_blocked/);
  assert.match(toolCallPlanningSource, /readFileExposed:\s*scopedToolNameSet\.has\("read_file"\)/);

  const unavailableCheckIndex = toolCallPartitioningSource.indexOf("!availableToolNames.has(tc.name)");
  const browserPreflightIndex = toolCallPartitioningSource.indexOf("resolveBrowserValidationPreflight({");
  assert.ok(unavailableCheckIndex >= 0 && browserPreflightIndex > unavailableCheckIndex);
});

test("browser readiness preflight stays visible without counting as a browser execution failure", () => {
  const toolCallPartitioningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");
  const browserPreflightIndex = toolCallPartitioningSource.indexOf("resolveBrowserValidationPreflight({");
  const browserPreflightBlockEnd = toolCallPartitioningSource.indexOf(
    'if (browserPreflight.action === "correct")',
    browserPreflightIndex,
  );
  assert.ok(browserPreflightIndex >= 0 && browserPreflightBlockEnd > browserPreflightIndex);
  const browserPreflightBlock = toolCallPartitioningSource.slice(
    browserPreflightIndex,
    browserPreflightBlockEnd,
  );
  assert.match(browserPreflightBlock, /toolFailureSignatures\.delete\(tc\.id\)/);
  assert.match(browserPreflightBlock, /callbacks\.onToolDone\(tc\.name, requestedUrl, message/);
  assert.match(browserPreflightBlock, /internalFeedback:\s*true/);
  assert.match(browserPreflightBlock, /isError:\s*!policyDeferral/);
  assert.doesNotMatch(browserPreflightBlock, /callbacks\.onToolError/);
});

test("browser validation repeats are reused or paused without agent error", () => {
  const orchestratorSource = (
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolExecutionRuntimeState.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"), "utf8")
  );
  const toolCallPartitioningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");

  assert.match(orchestratorSource, /browserValidationCache/);
  assert.match(toolCallPartitioningSource, /browser_validation_reused_without_state_change/);
  assert.match(orchestratorSource, /approved_plan_repeated_browser_validation/);
  assert.doesNotMatch(
    toolCallPartitioningSource,
    /tc\.name === "browser_evaluate"[\s\S]{0,600}callbacks\.onStatusChange\("error"\)/,
  );
});

test("execution recovery has one no-progress handler and no legacy read/edit budgets", () => {
  const loopRecoverySource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"),
    "utf8",
  );
  const toolResultRecoverySource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultRecoveryPhase.ts"),
    "utf8",
  );
  const executeRecoveryRuntimeSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"),
    "utf8",
  );
  const combined = [loopRecoverySource, toolResultRecoverySource, executeRecoveryRuntimeSource].join("\n");

  assert.match(loopRecoverySource, /export function handleNoProgressRecovery/);
  assert.match(toolResultRecoverySource, /handleNoProgressRecovery\(\{/);
  assert.match(executeRecoveryRuntimeSource, /registerExecuteRecoveryProtocolNoProgress/);
  assert.doesNotMatch(
    combined,
    /handleReadFileRepeatLimitRecovery|handleCrossIterationReadFileLoopRecovery|handleRepeatedEditValidationRecovery/,
  );
  assert.doesNotMatch(
    combined,
    /consecutiveBlockedReadFileCount|repeatedEditValidationAttempts/,
  );
});

test("approved plan recovery keeps watchdogs and derives tool scope from the active contract", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const iterationStreamPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"), "utf8");
  const streamInvocationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"), "utf8");
  const toolCallPlanningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"), "utf8");

  assert.match(source, /EXECUTE_RECOVERY_STREAM_MAX_ELAPSED_MS\s*=\s*120_000/);
  assert.match(
    source,
    /executeRecoveryStreamMaxElapsedMs:\s*EXECUTE_RECOVERY_STREAM_MAX_ELAPSED_MS/,
  );
  assert.match(streamInvocationSource, /maxStreamElapsedMs:\s*minPositive\([\s\S]*?recoveryStreamMaxElapsedMs/);
  assert.match(
    streamInvocationSource,
    /boundedMaxElapsedMs[\s\S]*?EXECUTE_STREAM_MAX_ELAPSED_MS/,
  );
  assert.match(streamInvocationSource, /EXECUTE_ACTION_RETRY_MAX_ELAPSED_MS\s*=\s*90_000/);
  assert.match(streamInvocationSource, /EXECUTE_STREAM_MAX_ELAPSED_MS\s*=\s*120_000/);
  assert.match(streamInvocationSource, /recoveryActionContract[\s\S]*?resolveRecoveryToolChoice/);
  assert.match(streamInvocationSource, /maxStreamElapsedLabel:\s*"execute_recovery"/);
  assert.match(source, /prepareIterationStreamRequest\(\{/);
  assert.match(iterationStreamPreparationSource, /resolveIterationToolSurface\(\{/);
  assert.match(toolCallPlanningSource, /logAgentEvent\("tool_surface_decision"/);
  assert.match(toolCallPlanningSource, /logAgentEvent\("recovery_loop_summary"/);
});

test("approved plan summaries publish only on no-tool or substantive plan turns", () => {
  const assistantOutputPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantOutputPhase.ts"), "utf8");

  assert.match(assistantOutputPhaseSource, /shouldHideApprovedPlanNoToolText/);
  assert.match(assistantOutputPhaseSource, /preservedVisibleText:\s*!shouldHideApprovedPlanNoToolText/);
  assert.match(
    assistantOutputPhaseSource,
    /if\s*\(\s*!shouldHideApprovedPlanNoToolText\s*&&\s*\(\s*effectiveToolCalls\.length\s*===\s*0\s*\|\|\s*hasSubstantivePlanAssistantText\s*\)\s*\)\s*{[\s\S]*?callbacks\.onTurnSummaryReady\(visibleAssistantText\)/,
  );
  assert.match(
    assistantOutputPhaseSource,
    /if\s*\([\s\S]*?!shouldHideApprovedPlanNoToolText[\s\S]*?\(visibleAssistantText \|\| finalReplyOptions\.length > 0\)[\s\S]*?\)\s*{/,
  );
});

test("plan progress snapshot carries no-progress recovery metadata", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "paused",
    iterationCount: 8,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB" }],
    progressSignature: "read_file:src/store/dashboardStore.ts:succeeded:cached",
    repeatedTargets: ["src/store/dashboardStore.ts"],
    recoveryReason: "no_progress_batch_loop",
  });
  const snapshot = normalizePlanExecutionProgressSnapshot({
    turnId: "turn-repeat",
    update,
    now: 456,
  });

  assert.equal(snapshot.recoveryReason, "no_progress_batch_loop");
  assert.deepEqual(snapshot.repeatedTargets, ["src/store/dashboardStore.ts"]);
  assert.match(snapshot.progressSignature, /cached/);
});

test("plan execution progress prefers active tool-matched task over broad first pending task", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "tool_start",
    iterationCount: 3,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks: [
      {
        id: "broad",
        text: "目标：修复 4 个核心问题，同时按 Linear.app 设计规范重构 UI 配色",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "text", value: "overall dashboard polish" }],
      },
      {
        id: "upload",
        text: "修复 DragUpload 导入状态和 CSV 数据流",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "file", value: "src/components/FileUploader/DragUpload.tsx" }],
      },
    ],
    evidenceLedger: [],
    recentToolActivity: [{ name: "replace_in_file", target: "src/components/FileUploader/DragUpload.tsx", status: "succeeded" }],
  });

  assert.match(update.currentTask, /DragUpload/);
  assert.doesNotMatch(update.currentTask, /^目标：/);
});

test("plan execution progress keeps explicit task identity when two tasks own the same file", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "tool_start",
    iterationCount: 2,
    maxIterations: 50,
    autoResumeCount: 0,
    currentTaskId: "open-file",
    tasks: [
      {
        id: "open-file",
        text: "修改 src/main.js 的 handleOpenFile()，统一文件打开入口",
        status: "in_progress",
        evidenceStatus: "missing",
        evidence: [{ kind: "file", value: "src/main.js" }],
      },
      {
        id: "close-tab",
        text: "修改 src/main.js 的 closeTab()，修复关闭状态",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "file", value: "src/main.js" }],
      },
    ],
    evidenceLedger: [],
    recentToolActivity: [{ name: "read_file", target: "src/main.js", status: "succeeded" }],
  });

  assert.equal(update.currentTaskId, "open-file");
  assert.match(update.currentTask, /handleOpenFile/);
  assert.doesNotMatch(update.currentTask, /closeTab/);
});

test("same-file fallback prefers the unique in-progress task and never the last index", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "tool_start",
    iterationCount: 2,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks: [
      {
        id: "open-file",
        text: "修改 src/main.js 的 handleOpenFile()，统一文件打开入口",
        status: "in_progress",
        evidenceStatus: "missing",
        evidence: [{ kind: "file", value: "src/main.js" }],
      },
      {
        id: "close-tab",
        text: "修改 src/main.js 的 closeTab()，修复关闭状态",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "file", value: "src/main.js" }],
      },
    ],
    evidenceLedger: [],
    recentToolActivity: [{ name: "read_file", target: "src/main.js", status: "succeeded" }],
  });

  assert.equal(update.currentTaskId, "open-file");
  assert.match(update.currentTask, /handleOpenFile/);
});

test("legacy progress identity migrates only from a unique task graph", () => {
  const tasks = [
    {
      id: "open-file",
      text: "修改 src/main.js 的 handleOpenFile()，统一文件打开入口",
      status: "in_progress",
      evidenceStatus: "missing",
      evidence: [{ kind: "file", value: "src/main.js" }],
    },
    {
      id: "close-tab",
      text: "修改 src/main.js 的 closeTab()，修复关闭状态",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "file", value: "src/main.js" }],
    },
  ];
  assert.deepEqual(resolveRestoredPlanExecutionTaskIdentity({
    snapshot: { currentTask: "修改 src/main.js 的 handleOpenFile()，统一文件打开入口" },
    tasks,
  }), { currentTaskId: "open-file", ambiguous: false });
  assert.deepEqual(resolveRestoredPlanExecutionTaskIdentity({
    snapshot: { currentTask: "读取 src/main.js" },
    tasks: tasks.map((task) => ({ ...task, status: "pending" })),
  }), { ambiguous: true });
  assert.deepEqual(resolveRestoredPlanExecutionTaskIdentity({
    snapshot: { currentTaskId: "missing", currentTask: tasks[0].text },
    tasks,
  }), { ambiguous: true });
});

test("plan execution progress does not keep a completed command as the current task", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "running",
    iterationCount: 8,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks: [
      {
        id: "build",
        text: "运行 npm run build",
        status: "completed",
        evidenceStatus: "satisfied",
        evidence: [{ kind: "cmd", value: "npm run build" }],
      },
      {
        id: "dev",
        text: "运行 npm run dev 并观察 readiness",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "cmd", value: "npm run dev" }],
      },
    ],
    evidenceLedger: [{
      id: "build-result",
      planTaskId: "build",
      requirementRef: "build",
      kind: "cmd",
      value: "npm run build",
      target: "npm run build",
      sourceTool: "run_command",
      createdAt: 1,
    }],
    recentToolActivity: [{
      name: "run_command",
      target: "npm run build",
      status: "succeeded",
    }],
  });

  assert.match(update.currentTask, /npm run dev/);
  assert.doesNotMatch(update.currentTask, /npm run build/);
});

test("plan execution progress shows current action when first pending task is too broad", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "tool_start",
    iterationCount: 4,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks: [
      {
        id: "broad",
        text: "目标：修复 4 个核心问题，同时按 Linear.app 设计规范重构 UI 配色",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "text", value: "overall dashboard polish" }],
      },
    ],
    evidenceLedger: [],
    recentToolActivity: [{ name: "read_file", target: "src/App.tsx", status: "succeeded" }],
  });

  assert.match(update.currentTask, /当前动作：/);
  assert.match(update.currentTask, /src\/App\.tsx/);
});

test("ChatArea renders live approved-plan progress snapshots in expanded turns", () => {
  const chatAreaSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/components/ChatArea.tsx"),
    "utf8",
  );

  assert.match(chatAreaSource, /formatPlanExecutionProgressSnapshot/);
  assert.match(
    chatAreaSource,
    /block\.variant\s*===\s*"plan_execution_progress"[\s\S]*?<PlanExecutionSystemNotice/,
  );
  assert.match(
    chatAreaSource,
    /block\.variant\s*===\s*"execution_checkpoint"[\s\S]*?<PlanExecutionSystemNotice/,
  );
  assert.match(chatAreaSource, /const\s+livePlanProgressBlock\s*=/);
  assert.match(chatAreaSource, /planExecutionProgress:\s*turnProgressSnapshot/);
  assert.match(chatAreaSource, /data-testid=\{block\.variant\}/);
});

test("approved-plan stream heartbeats remain harness telemetry", () => {
  const workflowEngineSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );

  assert.doesNotMatch(workflowEngineSource, /const\s+emitPlanStreamHeartbeat\s*=/);
  assert.doesNotMatch(workflowEngineSource, /emitPlanStreamHeartbeat\(markerPatch\)/);
  assert.match(workflowEngineSource, /onHarnessRunUpdate:[\s\S]*updateHarnessRunMarker\(markerPatch\)/);
  assert.doesNotMatch(workflowEngineSource, /ChatArea will keep showing stream progress|ChatArea 会持续显示流式进度/);
});

test("workflow engine forwards the complete approved-plan progress snapshot", () => {
  const workflowEngineSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );

  assert.match(workflowEngineSource, /currentTask:\s*progress\.currentTask/);
  assert.match(workflowEngineSource, /latestEvidence:\s*progress\.latestEvidence/);
  assert.match(workflowEngineSource, /progressSignature:\s*progress\.progressSignature/);
  assert.match(workflowEngineSource, /lastEffectiveEvidenceAt:\s*progress\.lastEffectiveEvidenceAt/);
  assert.doesNotMatch(workflowEngineSource, /recentToolActivity:\s*update\.currentTool\s*\?\s*\[update\.currentTool\]/);
});
