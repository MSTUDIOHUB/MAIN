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
  normalizePlanExecutionProgressSnapshot,
  resolveApprovedPlanSameTurnFallbackDecision,
  summarizeRepeatedPlanTargetsFromToolActivity,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionRecovery.ts"));

test("approved plan same-turn fallback retries busy once only while the exact transition remains pending", () => {
  const handoff = {
    planTurnId: "turn-plan",
    executionTurnId: "turn-plan",
    requestedAt: 100,
  };
  const base = {
    expectedSessionKey: "workspace:1",
    currentSessionKey: "workspace:1",
    expectedHandoff: handoff,
    currentHandoff: handoff,
    isPlanApproved: true,
    executionStartedForTurnId: null,
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
    executionStartedForTurnId: "turn-plan",
    busyRetryAttempt: 0,
  }), "transition_stale");
  assert.equal(resolveApprovedPlanSameTurnFallbackDecision({
    ...base,
    isPlanApproved: false,
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
  describeApprovedPlanRecoveryToolSurface,
  describeApprovedPlanSourceEditFirstToolSurface,
  isApprovedPlanCachedReadOnlyNoProgressBatch,
  isApprovedPlanRecoveryToolName,
  isApprovedPlanSourceEditFirstToolName,
  resolveApprovedPlanPatchRecoveryTarget,
  shouldAllowApprovedPlanRecoveryFileRead,
  shouldBypassApprovedPlanReadCacheForPatchRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/approvedPlanRecoveryTools.ts"));

const {
  handleApprovedPlanNoToolRecovery,
  resolveApprovedPlanNoToolCheckpointLimit,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRecovery.ts"));

const {
  handleApprovedPlanFinalization,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanFinalization.ts"));

const {
  handleStrictRepeatGuardRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"));

const {
  buildPlanClosureEvidenceRecoveryPrompt,
  handlePlanNoToolRecovery,
  resolvePlanNoToolRecoveryDecision,
  shouldAttemptPlanEvidenceMaterialization,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planNoToolRecovery.ts"));
const {
  handlePlanQualityRecoveryAfterVisibleMaterialization,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planQualityRecovery.ts"));
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
  const errors = [];
  return {
    ...harness,
    toolErrors,
    errors,
    callbacks: {
      ...harness.callbacks,
      getApprovedLocalFileReadPaths: () => [],
      onToolError: (tool, target, message, metadata) => toolErrors.push({ tool, target, message, metadata }),
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
  return {
    callbacks: harness.callbacks,
    workspace: workspaceRoot,
    workflowMode: "plan",
    runtimeIntent: "execute",
    iteration: 4,
    effectiveToolCalls: [],
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

function createApprovedPlanNoToolInput(overrides = {}) {
  const harness = overrides.harness || createApprovedPlanNoToolHarness("en");
  return {
    harness,
    input: {
      callbacks: harness.callbacks,
      activeProfile: "cloud",
      iteration: 3,
      workflowMode: "plan",
      runtimeIntent: "execute",
      planStage: "executing",
      isApprovedPlanExecutionTurn: true,
      effectiveToolCallCount: 0,
      shouldSuppressApprovedPlanNoToolText: true,
      approvedPlanAuditForNoTool: createApprovedPlanNoToolAudit(),
      rejectedCompletionClaim: false,
      availableToolNames: new Set(["read_file", "write_file", "replace_in_file", "run_command"]),
      wasTruncated: false,
      sawExecuteOperationEvidence: false,
      normalized: {
        finishReason: "stop",
        hiddenThought: "",
        visibleText: "I will continue.",
        toolCalls: [],
      },
      finalReplyOptionsCount: 0,
      streamText: "I will continue.",
      iterationRequestStartedAt: Date.now(),
      recentPlanToolActivity: [],
      consecutiveNoToolCount: 0,
      approvedPlanNoProgressRecoveryAttempts: 0,
      approvedPlanActionOnlyRecoveryActive: false,
      approvedPlanNoToolRecoveryFileReadActive: false,
      approvedPlanLongReasoningNoActionCount: 0,
      emitTaskOrchestratorPhase: (phase, extra) => harness.taskPhases.push({ phase, extra }),
      emitPlanExecutionProgress: (phase, overrides) => harness.progress.push({ phase, overrides }),
      ...(overrides.input || {}),
    },
  };
}

function createPlanNoToolHarness(language = "zh") {
  const appended = [];
  const statuses = [];
  const finalTexts = [];
  const stops = [];
  const phases = [];
  return {
    appended,
    statuses,
    finalTexts,
    stops,
    phases,
    callbacks: {
      getPreferredLanguage: () => language,
      getMessages: () => [],
      getIsPlanApproved: () => false,
      getPlanStage: () => "requirements",
      appendMessage: (message) => appended.push(message),
      onStatusChange: (status) => statuses.push(status),
      onAssistantFinalText: (text, replyOptions, meta) => finalTexts.push({ text, replyOptions, meta }),
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

test("Plan evidence materialization replaces unbounded retries for logged quality failures", () => {
  assert.equal(shouldAttemptPlanEvidenceMaterialization({
    recoveryAction: "rewrite",
    qualityRejectCount: 1,
    qualityGateReason: "excessive_plan_code_dump",
    finishReason: "stop",
  }), true);
  assert.equal(shouldAttemptPlanEvidenceMaterialization({
    recoveryAction: "rewrite",
    qualityRejectCount: 1,
    qualityGateReason: "missing_plan_required_sections:summary,key_changes",
    finishReason: "length",
  }), true);
  assert.equal(shouldAttemptPlanEvidenceMaterialization({
    recoveryAction: "auto_scaffold",
    qualityRejectCount: 2,
    qualityGateReason: "quality_gate",
    finishReason: "stop",
  }), true);
  assert.equal(shouldAttemptPlanEvidenceMaterialization({
    recoveryAction: "targeted_evidence",
    qualityRejectCount: 1,
    qualityGateReason: "ungrounded_plan_change_targets:index.html",
    finishReason: "stop",
  }), false);
  assert.equal(shouldAttemptPlanEvidenceMaterialization({
    recoveryAction: "ask_user",
    qualityRejectCount: 3,
    qualityGateReason: "blocking_decision",
    finishReason: "length",
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

  assert.equal(visibleCandidate.shouldMaterializeStructuredProposal, true);
  assert.equal(visibleCandidate.shouldEnterReview, false);
  assert.equal(acceptedArtifact.shouldMaterializeStructuredProposal, false);
  assert.equal(acceptedArtifact.shouldEnterReview, true);
  assert.equal(replacementCandidate.shouldMaterializeStructuredProposal, true);
  assert.equal(replacementCandidate.shouldEnterReview, false);
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
    "- 运行前端构建，并手动验证双击文件和工具栏按钮。",
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
      detail: "前端当前监听 open-file-event",
    }],
    waitForPlanApprovalIfNeeded: async () => {
      approvalWaitCalls += 1;
      return false;
    },
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.planQualityRejectCount, 1);
  assert.equal(result.planArtifactQualityRejected, false);
  assert.match(result.planLastQualityGateReason, /ungrounded_plan_change_targets:index\.html/);
  assert.equal(approvalWaitCalls, 0);
  assert.equal(harness.statuses.includes("pending_review"), false);
  assert.equal(harness.stops.length, 0);
  assert.ok(harness.phases.some((entry) => entry.phase === "needs_evidence"));
  assert.match(harness.appended.at(-1)?.content || "", /PLAN_CLOSURE_NEEDS_EVIDENCE/);

  const needsEvidencePhase = harness.phases.findLast((entry) => entry.phase === "needs_evidence");
  assert.equal(needsEvidencePhase.qualitySnapshot?.qualityRejectCount, 1);
  assert.deepEqual(needsEvidencePhase.qualitySnapshot?.missingSections, []);
  let foldedState = createPlanLoopRuntimeState({ workflowMode: "plan", isPlanApproved: false });
  foldedState = applyPlanRuntimePhase(foldedState, {
    phase: needsEvidencePhase.phase,
    reason: needsEvidencePhase.reason,
  }).state;
  foldedState = applyPlanNoToolRuntimeState(foldedState, result);
  assert.equal(foldedState.planRuntimePhase, "needs_evidence");
  assert.equal(foldedState.planQualityRejectCount, 1);
  assert.equal(foldedState.planArtifactQualityRejected, false);

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

test("accepted artifact pauses the review run even when the same response also looks structured", async () => {
  const harness = createPlanNoToolHarness("en");
  let currentStatus = "running";
  let approvalWaitCalls = 0;
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness, {
    callbacks: {
      ...harness.callbacks,
      getPlanStage: () => "plan",
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

  assert.equal(result.status, "stopped");
  assert.equal(approvalWaitCalls, 0);
  assert.equal(currentStatus, "pending_review");
  assert.equal(harness.statuses.filter((status) => status === "pending_review").length, 1);
  assert.ok(harness.phases.some((entry) => entry.phase === "review_ready"));
});

test("plan no-tool recovery prompts continuation when planning ends with no visible output", async () => {
  const harness = createPlanNoToolHarness("zh");
  const result = await handlePlanNoToolRecovery(createPlanNoToolInput(harness));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /当前规划还没有进入可执行阶段/);
  assert.match(harness.appended[0].content, /\.MAIN\/plans\/plan\.md/);
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
  assert.match(harness.appended.at(-1)?.content || "", /reviewable plan/i);
});

test("plan closure evidence recovery prompt keeps planning read-only and targeted", () => {
  const zh = buildPlanClosureEvidenceRecoveryPrompt("zh", "缺少源码证据");
  const en = buildPlanClosureEvidenceRecoveryPrompt("en", "missing source evidence");

  assert.match(zh, /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.match(zh, /只做一次定向读取\/搜索/);
  assert.match(zh, /批准前不要修改源码/);
  assert.match(en, /exactly one targeted read\/search/);
  assert.match(en, /Do not call broad directory scans/);
});

test("approved plan finalization continues when trusted evidence is still incomplete", () => {
  const harness = createApprovedPlanNoToolHarness("en");
  const result = handleApprovedPlanFinalization({
    callbacks: harness.callbacks,
    activeProfile: "cloud",
    iteration: 7,
    workflowMode: "plan",
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

test("approved plan finalization pauses when pending user validation cannot be automated", () => {
  const harness = createApprovedPlanNoToolHarness("zh");
  const pendingValidationTask = {
    ...tasks[1],
    status: "in_progress",
    evidenceStatus: "requires_user_confirmation",
    evidence: [{ kind: "manual_user_validation", value: "user confirms the Tauri window", inferred: true }],
  };
  const result = handleApprovedPlanFinalization({
    callbacks: harness.callbacks,
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

  assert.equal(result.status, "stopped");
  assert.deepEqual(harness.statuses, ["running", "idle"]);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "incomplete_plan");
  assert.equal(harness.progress[0].phase, "paused");
  assert.match(harness.stops[0].message, /待用户验证|用户/);
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
      getPlanExecutionEvidenceLedger: () => evidenceLedger,
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
  assert.deepEqual(harness.taskPhases, [{ phase: "DONE", extra: { reason: "plan_evidence_complete", iteration: 7 } }]);
  assert.deepEqual(harness.progress, [{ phase: "completed", overrides: undefined }]);
  assert.deepEqual(harness.stages, ["completed"]);
});

test("strict repeat guard recovers repeated read-only shell inspection and marks the signature failed", () => {
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
  assert.equal(harness.toolErrors.length, 1);
  assert.deepEqual([...failedToolCallCounts.values()], [3]);
});

test("strict repeat guard pauses repeated approved-plan browser validation after one recovery", () => {
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
  assert.equal(harness.toolErrors.length, 1);

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

test("max-iteration checkpoint keeps internal plan files out of project-source evidence", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/lib/orchestrator.ts", status: "succeeded" }],
    lastAssistantText: "Continuing with tests.",
  });

  assert.equal(checkpoint.reason, "max_iterations_checkpoint");
  assert.equal(checkpoint.currentTask.includes("Add resume guard tests"), true);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes("src/lib/orchestrator.ts")), true);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes(".MAIN/plans")), false);
});

test("pause notice is structured and points to manual resume after one auto-resume", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: PLAN_MAX_AUTO_RESUME_LIMIT,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "run_command", target: "npm test", status: "failed", detail: "exitCode 1" }],
    unresolvedBlockers: ["Agent loop reached maximum iterations (50)."],
  });
  const notice = buildPlanMaxIterationsPauseNotice(checkpoint, "en");

  assert.match(notice, /RecoveryDetails:/);
  assert.match(notice, /autoResumeCount: 1\/1/);
  assert.match(notice, /Resume Execution/);
  assert.match(notice, /Add resume guard tests/);
});

test("execute max-iteration notices describe a recoverable boundary instead of failure", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 25,
    maxIterations: 25,
    autoResumeCount: PLAN_MAX_AUTO_RESUME_LIMIT,
    tasks: [],
    evidenceLedger: [],
    recentToolActivity: [{ name: "run_command", target: "npm test", status: "succeeded", detail: "exitCode 0" }],
    lastAssistantText: "继续验证剩余步骤。",
    unresolvedBlockers: ["Agent loop reached maximum iterations (25)."],
  });

  const autoNotice = buildExecuteMaxIterationsAutoResumeNotice({ ...checkpoint, autoResumeCount: 1 }, "zh");
  const pauseNotice = buildExecuteMaxIterationsPauseNotice(checkpoint, "zh");
  const prompt = buildExecuteMaxIterationsResumePrompt({ language: "zh", checkpoint });

  assert.match(autoNotice, /恢复点/);
  assert.match(pauseNotice, /不是工具权限或模式切换失败/);
  assert.match(pauseNotice, /Resume Execution/);
  assert.match(pauseNotice, /复用已读上下文/);
  assert.match(pauseNotice, /重复只读/);
  assert.match(prompt, /如果任务已经完成，直接输出最终总结/);
});

test("resume prompt requires fresh workspace reads and treats .MAIN plans as internal state", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 1,
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

test("approved plan strategy switch continues the agent loop after recovery prompt", () => {
  const orchestratorSource = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRecovery.ts"), "utf8"));
  const approvedPlanNoToolRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRecovery.ts"), "utf8");
  const loopRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"), "utf8");
  const toolResultRecoveryPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultRecoveryPhase.ts"), "utf8");

  assert.match(
    approvedPlanNoToolRecoverySource,
    /if\s*\(\s*truncatedAfterCachedReadOnly\s*\)\s*{[\s\S]*?continueApprovedPlanWithStrategySwitch\(\{[\s\S]*?return finish\("continue"\);/,
  );
  assert.match(
    toolResultRecoveryPhaseSource,
    /if\s*\(\s*approvedPlanNoProgressDecision\s*\)\s*{[\s\S]*?approvedPlanNoProgressDecision\.action\s*===\s*"recover"[\s\S]*?approvedPlanRecoveryState\s*=\s*input\.continueApprovedPlanWithStrategySwitch\([\s\S]*?approvedPlanNoProgressDecision[\s\S]*?return finish\("continue"\);/,
  );
  assert.match(loopRecoverySource, /isApprovedPlanCachedReadOnlyNoProgressBatch/);
  assert.match(loopRecoverySource, /no_progress_cached_read_only_batch/);
  assert.doesNotMatch(orchestratorSource, /isApprovedPlanCachedReadOnlyNoProgressBatch/);
});

test("approved plan no-tool helper appends recovery prompt and opens action recovery surface", () => {
  const { harness, input } = createApprovedPlanNoToolInput();
  const result = handleApprovedPlanNoToolRecovery(input);

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.equal(result.approvedPlanActionOnlyRecoveryActive, true);
  assert.equal(result.approvedPlanNoToolRecoveryFileReadActive, true);
  assert.equal(result.approvedPlanNoProgressRecoveryAttempts, 0);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.equal(harness.appended.length, 1);
  assert.equal(harness.appended[0].role, "user");
  assert.match(harness.appended[0].content, /TOOL_ONLY_RECOVERY/);
  assert.equal(harness.stops.length, 0);
  assert.equal(resolveApprovedPlanNoToolCheckpointLimit("local"), 5);
});

test("approved plan no-tool helper pauses at the local checkpoint boundary", () => {
  const { harness, input } = createApprovedPlanNoToolInput({
    input: {
      activeProfile: "local",
      consecutiveNoToolCount: 4,
      rejectedCompletionClaim: true,
      normalized: {
        finishReason: "stop",
        hiddenThought: "",
        visibleText: "Done.",
        toolCalls: [],
      },
      streamText: "Done.",
    },
  });
  const result = handleApprovedPlanNoToolRecovery(input);

  assert.equal(result.status, "stopped");
  assert.equal(result.consecutiveNoToolCount, 5);
  assert.equal(result.approvedPlanActionOnlyRecoveryActive, true);
  assert.equal(result.approvedPlanNoToolRecoveryFileReadActive, true);
  assert.deepEqual(harness.statuses, ["running", "idle"]);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "no_action");
  assert.match(harness.stops[0].message, /Completion claim not accepted|执行已暂停|execution protocol|执行协议/);
  assert.deepEqual(harness.progress.map((entry) => entry.phase), ["paused"]);
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
    /replayApprovedExecutionRead[\s\S]*duplicateCount\s*>=\s*2[\s\S]*buildFileUnchangedReplayContent/,
  );
});

test("approved plan execution starts with the normal execute tool surface", () => {
  const orchestratorSource = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"));
  const approvedPlanRecoveryActionsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanRecoveryActions.ts"), "utf8");
  const approvedPlanRecoveryRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanRecoveryRuntime.ts"), "utf8");
  const planReviewRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planReviewRuntime.ts"), "utf8");
  const appStoreSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const loopControlRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopControlRuntime.ts"), "utf8");
  const loopMutableStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopMutableState.ts"), "utf8");

  assert.match(
    loopMutableStateSource,
    /approvedPlanRecoveryState:\s*createApprovedPlanRecoveryRuntimeState\(\),/,
  );
  assert.match(planReviewRuntimeSource, /Approval belongs to a fresh child run/);
  assert.match(
    appStoreSource,
    /planStage:\s*"executing"[\s\S]*plan_review_run_paused_for_child_execution/,
  );
  assert.match(appStoreSource, /startApprovedPlanExecutionInCurrentTurn/);
  assert.match(
    loopControlRuntimeSource,
    /const\s+result\s*=\s*continueApprovedPlanWithStrategySwitchAction\(\{[\s\S]*?const\s+nextState\s*=\s*applyApprovedPlanStrategySwitchRecoveryState\([\s\S]*?setApprovedPlanRecoveryState\(nextState\);[\s\S]*?return nextState;/,
  );
  assert.match(
    approvedPlanRecoveryActionsSource,
    /approvedPlanActionOnlyRecoveryActive:\s*true/,
  );
  assert.match(
    approvedPlanRecoveryRuntimeSource,
    /approvedPlanActionOnlyRecoveryActive:\s*false/,
  );
  assert.doesNotMatch(
    orchestratorSource,
    /let\s+approvedPlanActionOnlyRecoveryActive\s*=\s*workflowMode\s*===\s*"plan"\s*&&\s*callbacks\.getIsPlanApproved\(\)/,
  );
});

test("approved plan no-progress recovery keeps targeted reads without broad discovery", () => {
  const orchestratorSource = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"));
  const approvedPlanNoToolRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRecovery.ts"), "utf8");
  const toolCallPlanningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"), "utf8");
  const toolCallPartitioningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");
  const readOnlyTools = new Set([
    "get_project_skeleton",
    "list_directory",
    "glob_search",
    "grep_search",
    "read_file",
    "get_file_outline",
    "read_pty_buffer",
    "get_pty_status",
  ]);
  const fullToolNames = [
    "list_directory",
    "glob_search",
    "grep_search",
    "read_file",
    "apply_patch",
    "replace_in_file",
    "write_file",
    "run_command",
    "execute_command",
    "send_pty_input",
    "browser_evaluate",
    "get_file_outline",
    "get_pty_status",
  ];

  const cachedReadRecoveryTools = fullToolNames.filter((name) =>
    isApprovedPlanRecoveryToolName(name, readOnlyTools, { allowFileRead: false })
  );
  const patchRecoveryTools = fullToolNames.filter((name) =>
    isApprovedPlanRecoveryToolName(name, readOnlyTools, { allowFileRead: true })
  );

  assert.deepEqual(cachedReadRecoveryTools, [
    "apply_patch",
    "replace_in_file",
    "write_file",
    "run_command",
    "execute_command",
    "browser_evaluate",
  ]);
  assert.equal(cachedReadRecoveryTools.includes("send_pty_input"), false);
  assert.equal(patchRecoveryTools.includes("read_file"), true);
  assert.equal(patchRecoveryTools.includes("list_directory"), false);
  assert.equal(
    shouldAllowApprovedPlanRecoveryFileRead([
      { name: "read_file", target: "src/App.tsx", status: "succeeded", detail: "FILE_UNCHANGED_STUB" },
    ]),
    false,
  );
  assert.equal(
    shouldAllowApprovedPlanRecoveryFileRead([
      { name: "replace_in_file", target: "src/App.tsx", status: "failed", detail: "search_text 与文件内容不一致，未执行写入。" },
    ]),
    true,
  );
  assert.equal(
    shouldAllowApprovedPlanRecoveryFileRead([
      { name: "apply_patch", target: "src/hooks/useCsvParser.ts", status: "failed", detail: "Unsupported apply_patch line: --- a/src/hooks/useCsvParser.ts" },
    ]),
    true,
  );
  assert.equal(
    shouldAllowApprovedPlanRecoveryFileRead([
      { name: "replace_in_file", target: "src/App.tsx", status: "failed", detail: "search_text 与文件内容不一致，未执行写入。" },
      { name: "read_file", target: "src/App.tsx", status: "succeeded", detail: "READ_FILE_RESULT" },
    ]),
    false,
  );
  assert.equal(
    shouldAllowApprovedPlanRecoveryFileRead([
      { name: "replace_in_file", target: "src/App.tsx", status: "failed", detail: "search_text mismatch" },
      { name: "write_file", target: "src/App.tsx", status: "succeeded", detail: "written" },
    ]),
    false,
  );
  const unresolvedMismatch = [
    { name: "replace_in_file", target: "src/App.tsx", status: "failed", detail: "search_text mismatch" },
  ];
  assert.equal(resolveApprovedPlanPatchRecoveryTarget(unresolvedMismatch), "src/App.tsx");
  assert.equal(
    shouldBypassApprovedPlanReadCacheForPatchRecovery({
      toolName: "read_file",
      allowFileRead: true,
      target: "src/App.tsx",
      recentActivity: unresolvedMismatch,
    }),
    true,
  );
  assert.equal(
    shouldBypassApprovedPlanReadCacheForPatchRecovery({
      toolName: "read_file",
      allowFileRead: true,
      target: "src/main.js",
      recentActivity: unresolvedMismatch,
    }),
    false,
  );
  assert.equal(
    shouldBypassApprovedPlanReadCacheForPatchRecovery({
      toolName: "grep_search",
      allowFileRead: true,
      target: "src/App.tsx",
      recentActivity: unresolvedMismatch,
    }),
    false,
  );
  assert.equal(describeApprovedPlanRecoveryToolSurface(false), "action_only");
  assert.equal(describeApprovedPlanRecoveryToolSurface(true), "action_plus_patch_file_read");
  assert.equal(
    isApprovedPlanCachedReadOnlyNoProgressBatch({
      readOnlyTools,
      results: [
        { name: "read_file", isError: false, detail: "FILE_UNCHANGED_STUB: src/App.tsx" },
        { name: "read_file", isError: false, detail: "READ_FILE_RESULT path: src/index.css" },
      ],
    }),
    false,
  );
  assert.equal(
    isApprovedPlanCachedReadOnlyNoProgressBatch({
      readOnlyTools,
      results: [
        { name: "read_file", isError: false, detail: "FILE_UNCHANGED_STUB: src/App.tsx" },
        { name: "read_file", isError: false, content: "Repeated read-only tool call skipped: src/hooks/useCsvParser.ts" },
      ],
    }),
    true,
  );
  assert.match(
    toolCallPlanningSource,
    /recoveryIterationAllTools\.filter\(\(tool\)\s*=>\s*isApprovedPlanRecoveryTool\(tool,[\s\S]*allowFileRead: allowApprovedPlanRecoveryFileRead/,
  );
  assert.doesNotMatch(
    toolCallPlanningSource,
    /function\s+isApprovedPlanRecoveryTool[\s\S]*?if\s*\(\s*name\s*===\s*"read_file"\s*\)\s*return\s+true;/,
  );
  assert.doesNotMatch(
    toolCallPlanningSource,
    /function\s+isApprovedPlanSourceEditFirstTool[\s\S]*?if\s*\(\s*tool\.function\.name\s*===\s*"read_file"\s*\)\s*return\s+true;/,
  );
  assert.match(toolCallPlanningSource, /approvedPlanNoToolRecoveryFileReadActive/);
  assert.match(approvedPlanNoToolRecoverySource, /approved_plan_no_tool_recovery_tool_surface/);
  assert.doesNotMatch(
    orchestratorSource,
    /rawIterationAllTools\.filter\(isApprovedPlanActionTool\)/,
  );
  assert.match(orchestratorSource, /patch-recovery `read_file` only/);
  assert.match(orchestratorSource, /exact current content/);
  assert.match(toolCallPartitioningSource, /approved_plan_patch_recovery_read_cache_bypass/);
  assert.match(toolCallPartitioningSource, /bypassApprovedPlanPatchRecoveryReadCache/);
});

test("approved plan source edit first surface blocks validation before first write", () => {
  assert.equal(isApprovedPlanSourceEditFirstToolName("apply_patch"), true);
  assert.equal(isApprovedPlanSourceEditFirstToolName("replace_in_file"), true);
  assert.equal(isApprovedPlanSourceEditFirstToolName("write_file"), true);
  assert.equal(isApprovedPlanSourceEditFirstToolName("run_command"), false);
  assert.equal(isApprovedPlanSourceEditFirstToolName("browser_evaluate"), false);
  assert.equal(isApprovedPlanSourceEditFirstToolName("read_file"), false);
  assert.equal(isApprovedPlanSourceEditFirstToolName("read_file", { allowFileRead: true }), true);
  assert.equal(describeApprovedPlanSourceEditFirstToolSurface(false), "source_edit_only");
  assert.equal(describeApprovedPlanSourceEditFirstToolSurface(true), "source_edit_plus_patch_file_read");

  const orchestratorSource = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"));
  const iterationStreamPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"), "utf8");
  const toolCallPlanningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"), "utf8");
  assert.match(orchestratorSource, /prepareIterationStreamRequest\(\{/);
  assert.match(iterationStreamPreparationSource, /resolveIterationToolSurface\(\{/);
  assert.match(toolCallPlanningSource, /approvedPlanNeedsSourceEditBeforeValidation/);
  assert.match(toolCallPlanningSource, /approved_plan_source_edit_first_tool_scope_applied/);
  assert.match(toolCallPlanningSource, /approvedPlanInitialSourceReadAllowed/);
  assert.match(toolCallPlanningSource, /recentPlanToolActivity\.length === 0/);
  assert.match(toolCallPlanningSource, /initialSourceReadAllowed:\s*approvedPlanInitialSourceReadAllowed/);
  assert.match(toolCallPlanningSource, /approvedPlanSourceEditFileReadAllowed/);
  assert.match(toolCallPlanningSource, /!approvedPlanActionOnlyRecoveryActive/);
  assert.match(toolCallPlanningSource, /approvedPlanActionRecoveryActive[\s\S]*?isApprovedPlanRecoveryTool/);
  assert.match(toolCallPlanningSource, /readFileExposed:\s*scopedToolNameSet\.has\("read_file"\)/);
});

test("approved plan browser validation repeats are reused or paused without agent error", () => {
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

  assert.match(orchestratorSource, /approvedPlanBrowserValidationCache/);
  assert.match(toolCallPartitioningSource, /approved_plan_browser_validation_reused/);
  assert.match(orchestratorSource, /approved_plan_repeated_browser_validation/);
  assert.doesNotMatch(
    toolCallPartitioningSource,
    /tc\.name === "browser_evaluate"[\s\S]{0,600}callbacks\.onStatusChange\("error"\)/,
  );
});

test("approved plan repeat-read guard pauses before max-iteration error", () => {
  const orchestratorSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const toolIterationPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolIterationPhase.ts"), "utf8");
  const toolResultRecoveryPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultRecoveryPhase.ts"), "utf8");
  const toolCallPartitioningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");
  const loopRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"), "utf8");

  assert.match(orchestratorSource, /handleToolIterationPhase\(\{/);
  assert.match(toolIterationPhaseSource, /handleToolResultRecoveryPhase\(\{/);
  assert.match(toolResultRecoveryPhaseSource, /handleReadFileRepeatLimitRecovery\(\{/);
  assert.match(toolResultRecoveryPhaseSource, /handleStrictRepeatGuardRecovery\(\{/);
  assert.match(loopRecoverySource, /approvedPlanReadFileRepeatLimit/);
  assert.match(loopRecoverySource, /approved_plan_read_file_repeat_limit/);
  assert.match(toolCallPartitioningSource, /shouldPushApprovedPlanReadLimit/);
  assert.match(toolCallPartitioningSource, /READ_FILE_REPEAT_LIMIT: \$\{target \|\| fileReadState\.path\}/);
  assert.match(loopRecoverySource, /approved_plan_repeated_read_file/);
  assert.match(loopRecoverySource, /callbacks\.onNonActionableStop\([\s\S]*?recoveryReason:\s*"approved_plan_read_file_repeat_limit"/);
  assert.match(loopRecoverySource, /callbacks\.onNonActionableStop\([\s\S]*?recoveryReason:\s*"approved_plan_repeated_read_file"/);
  assert.match(
    loopRecoverySource,
    /const approvedPlanReadFileRepeatLimit =[\s\S]*workflowMode === "plan" &&[\s\S]*callbacks\.getIsPlanApproved\(\) &&[\s\S]*runtimeIntent === "execute" &&[\s\S]*results\.some\(isReadFileRepeatLimitResult\)/,
  );
  assert.match(loopRecoverySource, /reason: "approved_plan_read_file_repeat_limit"/);
  assert.match(loopRecoverySource, /const readFileRepeatLimitBatch = workflowMode === "edit"\s*\? summarizeReadFileRepeatLimitBatch\(results\)/);
  assert.match(loopRecoverySource, /activateExecuteRecovery\("mutation_first",\s*"read_file_repeat_limit_batch"/);
  assert.match(loopRecoverySource, /read_file_repeat_limit_recovery/);
  assert.match(loopRecoverySource, /prompt: buildExecuteRecoveryPrompt\({[\s\S]*?reason: "read_file_repeat_limit_batch"/);
});

test("approved plan recovery logs tool surfaces and pauses long reasoning without action", () => {
  const source = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRecovery.ts"), "utf8"));
  const iterationStreamPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"), "utf8");
  const streamInvocationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"), "utf8");
  const toolCallPlanningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"), "utf8");

  assert.match(source, /APPROVED_PLAN_RECOVERY_STREAM_MAX_ELAPSED_MS\s*=\s*90_000/);
  assert.match(source, /approvedPlanRecoveryStreamMaxElapsedMs:\s*APPROVED_PLAN_RECOVERY_STREAM_MAX_ELAPSED_MS/);
  assert.match(streamInvocationSource, /maxStreamElapsedMs:\s*recoveryStreamMaxElapsedMs/);
  assert.match(streamInvocationSource, /APPROVED_PLAN_ACTION_REQUIRED_STREAM_MAX_ELAPSED_MS\s*=\s*45_000/);
  assert.match(streamInvocationSource, /approvedPlanActionOnlyRecoveryActive[\s\S]*?resolveRecoveryToolChoice/);
  assert.match(streamInvocationSource, /maxStreamElapsedLabel:\s*"approved_plan_recovery"/);
  assert.match(source, /prepareIterationStreamRequest\(\{/);
  assert.match(iterationStreamPreparationSource, /resolveIterationToolSurface\(\{/);
  assert.match(toolCallPlanningSource, /logAgentEvent\("tool_surface_decision"/);
  assert.match(toolCallPlanningSource, /logAgentEvent\("recovery_loop_summary"/);
  assert.match(source, /logAgentEvent\("long_reasoning_no_action"/);
  assert.match(source, /approved_plan_reasoning_length_no_action/);
  assert.match(source, /approvedPlanLongReasoningNoActionCount === 1/);
  assert.match(source, /pauseApprovedPlanNoProgressLoop\(\{[\s\S]*repeats: Math\.max\(1, approvedPlanLongReasoningNoActionCount\)/);
});

test("approved plan repeated edits route to validation recovery before pausing", () => {
  const orchestratorSource = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"));
  const toolIterationPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolIterationPhase.ts"), "utf8");
  const toolResultRecoveryPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultRecoveryPhase.ts"), "utf8");
  const loopRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"), "utf8");

  assert.match(orchestratorSource, /handleToolIterationPhase\(\{/);
  assert.match(toolIterationPhaseSource, /handleToolResultRecoveryPhase\(\{/);
  assert.match(toolResultRecoveryPhaseSource, /repeatedEditValidationRecoveryAttempts/);
  assert.match(toolResultRecoveryPhaseSource, /handleRepeatedEditValidationRecovery\(\{/);
  assert.match(loopRecoverySource, /activateExecuteRecovery\("validation_only",\s*"repeat_edit_target_without_validation"/);
  assert.match(loopRecoverySource, /buildExecuteValidationRecoveryPrompt/);
  assert.match(loopRecoverySource, /repeat_edit_target_validation_recovery/);
  assert.match(
    loopRecoverySource,
    /validationRecoveryAttempts:\s*repeatedEditValidationRecoveryAttempts/,
  );
});

test("approved plan no-tool prose is preserved unless it is a rejected completion claim", () => {
  const assistantOutputPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantOutputPhase.ts"), "utf8");

  assert.match(assistantOutputPhaseSource, /shouldHideApprovedPlanNoToolText/);
  assert.match(assistantOutputPhaseSource, /preservedVisibleText:\s*!shouldHideApprovedPlanNoToolText/);
  assert.match(
    assistantOutputPhaseSource,
    /if\s*\(\s*!shouldHideApprovedPlanNoToolText\s*\)\s*{[\s\S]*?callbacks\.onTurnSummaryReady\(visibleAssistantText\)/,
  );
  assert.match(
    assistantOutputPhaseSource,
    /if\s*\([\s\S]*?!shouldHideApprovedPlanNoToolText[\s\S]*?\(visibleAssistantText \|\| finalReplyOptions\.length > 0\)[\s\S]*?\)\s*{/,
  );
});

test("approved plan no-tool checkpoint reports protocol failure and available tools", () => {
  const orchestratorSource = (
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRecovery.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanFinalization.ts"), "utf8")
  );

  assert.match(orchestratorSource, /formatApprovedPlanNoToolAvailableTools/);
  assert.match(orchestratorSource, /暂停原因不是工具缺失/);
  assert.match(orchestratorSource, /模型没有按执行协议调用工具/);
  assert.match(orchestratorSource, /Array\.from\(availableToolNames\)/);
  assert.match(orchestratorSource, /validationBoundary === "browser_prompt"[\s\S]*buildBrowserValidationContinuationPrompt/);
  assert.match(orchestratorSource, /validationBoundary === "pause_external_validation"[\s\S]*buildApprovedPlanValidationPendingMessage/);
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
  assert.match(chatAreaSource, /const\s+livePlanProgressBlock\s*=/);
  assert.match(chatAreaSource, /planExecutionProgress:\s*turnProgressSnapshot/);
  assert.match(chatAreaSource, /data-testid=\{block\.variant\}/);
});

test("approved-plan stream heartbeats update visible plan progress", () => {
  const storeSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/store/useAppStore.ts"),
    "utf8",
  );

  assert.match(storeSource, /const\s+emitPlanStreamHeartbeat\s*=/);
  assert.match(storeSource, /streamStatus\s*!==\s*"chunk_progress"/);
  assert.match(storeSource, /streamStatus\s*!==\s*"no_chunk_progress_warning"/);
  assert.match(storeSource, /emitLocalPlanExecutionProgress\("running"/);
  assert.match(storeSource, /ChatArea 会持续显示流式进度/);
  assert.match(storeSource, /emitPlanStreamHeartbeat\(markerPatch\)/);
});
