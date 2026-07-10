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
  assessPlanEvidenceReadiness,
  filterPlanToolNamesAfterReadOnlyConvergence,
  shouldNarrowPlanToolsAfterReadOnlyConvergence,
  shouldRedirectPlanToolsAfterReadOnlyConvergence,
  shouldTriggerPlanReadOnlyConvergence,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planReadOnlyConvergence.ts"));
const {
  handlePlanPostConvergenceToolRedirect,
  handlePlanReadOnlyConvergence,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planConvergence.ts"));
const {
  handlePlanQualityRecoveryAfterToolResults,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planQualityRecovery.ts"));

function createPlanConvergenceCallbacks(language = "en") {
  const appended = [];
  const assistantFinal = [];
  const statuses = [];
  const streamTokens = [];
  return {
    appended,
    assistantFinal,
    statuses,
    streamTokens,
    callbacks: {
      getPreferredLanguage: () => language,
      getMessages: () => [],
      getIsPlanApproved: () => false,
      appendMessage: (message) => appended.push(message),
      onAssistantFinalText: (text, options, meta) => assistantFinal.push({ text, options, meta }),
      onStatusChange: (status) => statuses.push(status),
      onStreamToken: (token, id) => streamTokens.push({ token, id }),
    },
  };
}

test("plan evidence readiness requires observed user context and targeted reads", () => {
  assert.deepEqual(
    assessPlanEvidenceReadiness({
      userContext: { imageParts: 1 },
      hasObservedUserContext: false,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
      ],
    }),
    {
      status: "needs_observation",
      reason: "provided_context_not_observed",
      successfulTargetedReads: 0,
      successfulSearches: 1,
    },
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasObservedUserContext: true,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
      ],
    }).status,
    "needs_targeted_read",
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasObservedUserContext: true,
      recentToolActivity: [
        { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
      ],
    }).status,
    "needs_targeted_read",
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasObservedUserContext: true,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
        { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
      ],
    }).status,
    "ready_for_plan",
  );
});

test("plan read-only convergence stops broad discovery before targeted evidence loops", () => {
  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 1,
    recentToolActivity: [
      { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 3,
    toolCount: 3,
    recentToolActivity: [
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 3,
    toolCount: 3,
    recentToolActivity: [
      { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 12,
    recentToolActivity: [
      { name: "get_file_outline", target: "src/store/dashboardStore.ts", status: "succeeded" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), true);
});

test("plan read-only convergence does not trigger once decision output exists", () => {
  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: true,
    batchCount: 8,
    toolCount: 40,
  }), false);
});

test("plan read-only convergence tightens when user supplied screenshots or files", () => {
  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 2,
    userContext: { imageParts: 2 },
    hasObservedUserContext: false,
    recentToolActivity: [
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 2,
    userContext: { imageParts: 2 },
    hasObservedUserContext: true,
    recentToolActivity: [
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 2,
    userContext: { imageParts: 2 },
    hasObservedUserContext: true,
    recentToolActivity: [
      { name: "grep_search", target: "csv|dashboard", status: "succeeded" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 6,
    userContext: { attachedFilePaths: ["logs/main-debug.log"] },
    hasObservedUserContext: true,
    recentToolActivity: [
      { name: "read_file", target: "logs/main-debug.log", status: "succeeded" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 5,
    userContext: { mentionedFilePaths: ["src/App.tsx"] },
    hasObservedUserContext: true,
    recentToolActivity: [
      { name: "grep_search", target: "App", status: "succeeded" },
    ],
  }), true);
});

test("plan convergence helper emits the first convergence prompt and updates counters", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const phases = [];
  const result = handlePlanReadOnlyConvergence({
    callbacks: harness.callbacks,
    iteration: 4,
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    successfulReadOnlyExplorationResultCount: 1,
    planReadOnlyConvergenceBatches: 2,
    planReadOnlyConvergenceTools: 2,
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], externalAttachments: [] },
    recentPlanToolActivity: [
      { name: "grep_search", target: "csv|dashboard", status: "succeeded" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
    lastAssistantTextForCheckpoint: "",
    setPlanRuntimePhase: (phase, reason) => phases.push({ phase, reason }),
  });

  assert.equal(result.status, "continue");
  assert.equal(result.planReadOnlyConvergenceBatches, 3);
  assert.equal(result.planReadOnlyConvergenceTools, 3);
  assert.equal(result.usedPlanReadOnlyConvergencePrompt, true);
  assert.equal(harness.appended.length, 1);
  assert.equal(harness.appended[0].role, "user");
  assert.match(harness.appended[0].content, /PLAN_READONLY_CONVERGENCE/);
  assert.deepEqual(phases.map((item) => item.phase), ["synthesis", "drafting"]);
});

test("plan convergence helper does not re-trigger once the convergence prompt has been used", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const result = handlePlanReadOnlyConvergence({
    callbacks: harness.callbacks,
    iteration: 5,
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    successfulReadOnlyExplorationResultCount: 1,
    planReadOnlyConvergenceBatches: 3,
    planReadOnlyConvergenceTools: 12,
    usedPlanReadOnlyConvergencePrompt: true,
    turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], externalAttachments: [] },
    recentPlanToolActivity: [
      { name: "grep_search", target: "csv|dashboard", status: "succeeded" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
    lastAssistantTextForCheckpoint: "",
    setPlanRuntimePhase: (phase, reason) => phases.push({ phase, reason }),
  });

  assert.equal(result.status, "none");
  assert.equal(result.planReadOnlyConvergenceBatches, 4);
  assert.equal(result.planReadOnlyConvergenceTools, 13);
  assert.equal(result.usedPlanReadOnlyConvergencePrompt, true);
  assert.equal(harness.assistantFinal.length, 0);
  assert.equal(harness.appended.length, 0);
  assert.deepEqual(harness.statuses, []);
  assert.deepEqual(phases, []);
});

test("plan quality recovery routes rejected plan drafts to targeted evidence", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 6,
    results: [{
      toolCallId: "quality-1",
      name: "write_file",
      target: ".MAIN/plans/plan.md",
      content: "quality gate rejected",
      isError: true,
      internalFeedback: true,
      planRecoveryAction: "targeted_evidence",
      qualityGateReason: "missing_plan_required_sections:read_evidence",
      missingPlanSections: ["Read Evidence"],
    }],
    planRuntimePhase: "drafting",
    recentPlanToolActivity: [],
    attemptedPlanWriteTargets: [".MAIN/plans/plan.md"],
    latestUserPromptText: "Draft a grounded plan",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planQualityRejectCount, 1);
  assert.equal(result.planLastQualityGateReason, "missing_plan_required_sections:read_evidence");
  assert.deepEqual(result.planLastMissingSections, ["Read Evidence"]);
  assert.equal(result.pendingPlanRuntimeRecoveryPrompt, null);
  assert.deepEqual(phases, [{
    phase: "needs_evidence",
    reason: "missing_plan_required_sections:read_evidence",
    status: "running",
  }]);
});

test("plan quality recovery closes a successful evidence recovery pass", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const recentActivity = [
    { name: "read_file", target: "src/App.tsx", status: "succeeded", detail: "export function App" },
  ];
  const result = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 7,
    results: [{
      toolCallId: "read-1",
      name: "read_file",
      target: "src/App.tsx",
      content: "export function App() {}",
      isError: false,
    }],
    planRuntimePhase: "needs_evidence",
    recentPlanToolActivity: recentActivity,
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Draft a grounded plan",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "missing_plan_required_sections:read_evidence",
    planLastMissingSections: ["Read Evidence"],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planEvidenceRecoveryPasses, 1);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt, /PLAN_EVIDENCE_RECOVERY_COMPLETE/);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt, /定向补证已经完成/);
  assert.deepEqual(phases, [{
    phase: "drafting",
    reason: "evidence recovery complete",
    status: "running",
  }]);
});

function createPostConvergenceInput(overrides = {}) {
  const harness = overrides.harness || createPlanConvergenceCallbacks("en");
  const phases = [];
  return {
    harness,
    phases,
    input: {
      callbacks: harness.callbacks,
      iteration: 7,
      workflowMode: "plan",
      availableToolNames: new Set(["read_file", "write_file", "replace_in_file"]),
      effectiveToolCalls: [{ id: "call_read", name: "read_file", arguments: "{}" }],
      isAllowedUnapprovedPlanDraftMutationCall: () => false,
      hasPlanDecisionOutput: false,
      usedPlanReadOnlyConvergencePrompt: true,
      turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], externalAttachments: [] },
      recentPlanToolActivity: [
        { name: "grep_search", target: "dashboard", status: "succeeded" },
        { name: "read_file", target: "src/App.tsx", status: "succeeded" },
      ],
      lastAssistantTextForCheckpoint: "",
      visibleAssistantText: "",
      assistantHistoryText: "",
      providerReasoningForHistory: null,
      assistantMsgId: "assistant-1",
      planRuntimePhase: "drafting",
      planPostConvergenceToolRedirectCount: 0,
      planDraftingRecoveryReadCount: 0,
      planReasoningOnlyRecoveryPasses: 0,
      planEvidenceRecoveryPasses: 0,
      planQualityRejectCount: 0,
      planAutoScaffoldPromptIssued: false,
      planLastQualityGateReason: "",
      planLastMissingSections: [],
      latestUserPromptText: "Fix the dashboard",
      setPlanRuntimePhase: (phase, reason) => phases.push({ phase, reason }),
      ...overrides.input,
    },
  };
}

test("post-convergence helper injects the single drafting recovery read", () => {
  const { harness, phases, input } = createPostConvergenceInput({
    input: {
      visibleAssistantText: "I need one more file.",
      assistantHistoryText: "I need one more file.",
    },
  });
  const result = handlePlanPostConvergenceToolRedirect(input);

  assert.equal(result.status, "continue");
  assert.equal(result.planPostConvergenceToolRedirectCount, 0);
  assert.equal(result.planDraftingRecoveryReadCount, 1);
  assert.equal(result.planReasoningOnlyRecoveryPasses, 1);
  assert.equal(result.planAutoScaffoldPromptIssued, false);
  assert.equal(harness.appended.length, 2);
  assert.equal(harness.appended[0].role, "assistant");
  assert.equal(harness.appended[1].role, "user");
  assert.match(harness.appended[1].content, /PLAN_DRAFTING_RECOVERY_READ/);
  assert.deepEqual(harness.statuses, []);
  assert.deepEqual(harness.streamTokens, []);
  assert.deepEqual(phases, []);
});

test("post-convergence helper forces a plan write after recovery is exhausted", () => {
  const { harness, phases, input } = createPostConvergenceInput({
    input: {
      effectiveToolCalls: [{ id: "call_list", name: "list_directory", arguments: "{}" }],
      planRuntimePhase: "synthesis",
      planPostConvergenceToolRedirectCount: 1,
      planDraftingRecoveryReadCount: 1,
      planReasoningOnlyRecoveryPasses: 0,
      planEvidenceRecoveryPasses: 3,
    },
  });
  const result = handlePlanPostConvergenceToolRedirect(input);

  assert.equal(result.status, "continue");
  assert.equal(result.planPostConvergenceToolRedirectCount, 2);
  assert.equal(result.planDraftingRecoveryReadCount, 1);
  assert.equal(result.planReasoningOnlyRecoveryPasses, 0);
  assert.equal(result.planAutoScaffoldPromptIssued, false);
  assert.equal(harness.appended.length, 1);
  assert.equal(harness.appended[0].role, "user");
  assert.match(harness.appended[0].content, /FORCED WRITE/);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.deepEqual(harness.streamTokens, [{ token: "__ESCALATION_RESET__:", id: "assistant-1" }]);
  assert.deepEqual(phases, [{ phase: "drafting", reason: "recovery exhausted, write with existing evidence" }]);
});

test("post-convergence plan turns redirect more read-only tools before execution", () => {
  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["list_directory"],
    evidenceReadiness: "ready_for_plan",
  }), true);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: true,
    toolNames: ["list_directory"],
    evidenceReadiness: "ready_for_plan",
  }), false);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: true,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["read_file"],
    evidenceReadiness: "ready_for_plan",
  }), false);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["write_file"],
    evidenceReadiness: "ready_for_plan",
  }), false);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["read_file"],
    evidenceReadiness: "ready_for_plan",
  }), true);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["list_directory"],
    evidenceReadiness: "needs_targeted_read",
  }), true);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["read_file"],
    evidenceReadiness: "needs_targeted_read",
  }), false);
});

test("post-convergence plan tool surface narrows to targeted evidence or final drafting", () => {
  assert.equal(shouldNarrowPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    evidenceReadiness: "ready_for_plan",
  }), true);

  assert.equal(shouldNarrowPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    evidenceReadiness: "needs_targeted_read",
  }), true);

  assert.deepEqual(filterPlanToolNamesAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    evidenceReadiness: "ready_for_plan",
    toolNames: [
      "list_directory",
      "glob_search",
      "read_file",
      "replace_in_file",
      "write_file",
      "get_project_skeleton",
      "read_pty_tail",
    ],
  }), ["replace_in_file", "write_file"]);

  assert.deepEqual(filterPlanToolNamesAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    evidenceReadiness: "needs_targeted_read",
    toolNames: [
      "list_directory",
      "grep_search",
      "read_file",
      "repo_map_context",
      "replace_in_file",
      "write_file",
      "get_project_skeleton",
    ],
  }), ["read_file", "repo_map_context"]);

  assert.deepEqual(filterPlanToolNamesAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: true,
    convergencePromptAlreadyUsed: true,
    toolNames: ["read_file", "write_file"],
  }), ["read_file", "write_file"]);

  assert.deepEqual(filterPlanToolNamesAfterReadOnlyConvergence({
    workflowMode: "edit",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    toolNames: ["read_file", "write_file"],
  }), ["read_file", "write_file"]);
});
