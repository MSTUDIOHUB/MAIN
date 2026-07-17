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
  handlePlanQualityRecoveryAfterVisibleMaterialization,
  shouldPauseForReviewablePlanArtifactAfterToolResults,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planQualityRecovery.ts"));

function createPlanConvergenceCallbacks(language = "en") {
  const appended = [];
  const assistantFinal = [];
  const statuses = [];
  const streamTokens = [];
  const stops = [];
  return {
    appended,
    assistantFinal,
    statuses,
    streamTokens,
    stops,
    callbacks: {
      getPreferredLanguage: () => language,
      getMessages: () => [],
      getIsPlanApproved: () => false,
      appendMessage: (message) => appended.push(message),
      onAssistantFinalText: (text, options, meta) => assistantFinal.push({ text, options, meta }),
      onStatusChange: (status) => statuses.push(status),
      onStreamToken: (token, id) => streamTokens.push({ token, id }),
      onNonActionableStop: (message, reason, progress) => stops.push({ message, reason, progress }),
    },
  };
}

test("plan evidence readiness requires model-visible visual context and targeted reads", () => {
  assert.deepEqual(
    assessPlanEvidenceReadiness({
      userContext: { imageParts: 1 },
      hasGroundedVisualContext: false,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
      ],
    }),
    {
      status: "needs_observation",
      reason: "visual_context_not_model_visible",
      successfulTargetedReads: 0,
      successfulSearches: 1,
      semanticFacts: 0,
      changeTargets: 0,
    },
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasGroundedVisualContext: true,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
      ],
    }).status,
    "needs_targeted_read",
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasGroundedVisualContext: true,
      recentToolActivity: [
        { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
      ],
    }).status,
    "needs_targeted_read",
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasGroundedVisualContext: true,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
        { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
      ],
    }).status,
    "ready_for_plan",
  );
});

test("provided files are grounded by exact successful reads, not assistant claims", () => {
  assert.equal(
    assessPlanEvidenceReadiness({
      userContext: { attachedFilePaths: ["logs/main-debug.log"] },
      hasGroundedVisualContext: false,
      recentToolActivity: [
        { name: "grep_search", target: "main-debug", status: "succeeded" },
      ],
    }).reason,
    "provided_file_not_read",
  );

  assert.notEqual(
    assessPlanEvidenceReadiness({
      userContext: { attachedFilePaths: ["logs/main-debug.log"] },
      hasGroundedVisualContext: false,
      recentToolActivity: [
        {
          name: "read_file",
          target: "logs/main-debug.log",
          status: "succeeded",
          detail: "The log records a deterministic execution stop at the completion gate",
        },
      ],
    }).reason,
    "provided_file_not_read",
  );
});

test("MD Viewer structural reads do not close diagnostic Plan before a root-cause fact", () => {
  const userGoal = [
    "在 macOS 双击 Markdown 文件时只打开空白界面。",
    "软件内的打开功能无法开启文件选择窗口。",
    "找到原因并制定严谨整改方案。",
  ].join(" ");
  const structuralReads = [
    {
      name: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      detail: "fn main registers Tauri plugins, commands, and emits file-open events to the frontend",
    },
    {
      name: "read_file",
      target: "src-tauri/tauri.conf.json",
      status: "succeeded",
      detail: "Tauri application configuration defines the window and Markdown file associations",
    },
    {
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "window.addEventListener handles file-open and openFile invokes the dialog and backend command",
    },
  ];

  const structural = assessPlanEvidenceReadiness({
    userGoal,
    hasObservedUserContext: true,
    recentToolActivity: structuralReads,
  });
  assert.equal(structural.status, "needs_targeted_read");
  assert.equal(structural.reason, "change_targets_lack_confirmed_rationale");
  assert.equal(structural.semanticFacts, 3);
  assert.equal(structural.changeTargets, 2);

  const diagnosed = assessPlanEvidenceReadiness({
    userGoal,
    hasObservedUserContext: true,
    recentToolActivity: [
      ...structuralReads,
      {
        name: "grep_search",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        detail: "src/main.js invokes read_file_content but src-tauri/src/main.rs never registers that command",
      },
    ],
  });
  assert.equal(diagnosed.status, "ready_for_plan");
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
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 3,
    toolCount: 6,
    userGoal: "制定桌面应用文档打开流程的修改计划。",
    recentToolActivity: [
      {
        name: "read_file",
        target: "src/main.ts",
        status: "succeeded",
        detail: "command_invoke_contract(load_document) import open from '@tauri-apps/plugin-dialog'",
      },
      {
        name: "read_file",
        target: "src-tauri/src/lib.rs",
        status: "succeeded",
        detail: "handler_contract(save_document) .plugin(tauri_plugin_dialog::init())",
      },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 3,
    toolCount: 3,
    recentToolActivity: [
      { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 12,
    recentToolActivity: [
      { name: "get_file_outline", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "dashboardStore consumes creatorName for grouping" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
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
    hasGroundedVisualContext: false,
    recentToolActivity: [
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 2,
    userContext: { imageParts: 2 },
    hasGroundedVisualContext: true,
    recentToolActivity: [
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 2,
    userContext: { imageParts: 2 },
    hasGroundedVisualContext: true,
    recentToolActivity: [
      { name: "grep_search", target: "csv|dashboard", status: "succeeded" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 6,
    userContext: { attachedFilePaths: ["logs/main-debug.log"] },
    hasGroundedVisualContext: true,
    recentToolActivity: [
      { name: "read_file", target: "logs/main-debug.log", status: "succeeded", detail: "log records the exact plan_generation_failed stop after evidence materialization rejection" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 5,
    userContext: { mentionedFilePaths: ["src/App.tsx"] },
    hasGroundedVisualContext: true,
    recentToolActivity: [
      { name: "grep_search", target: "App", status: "succeeded" },
    ],
  }), false);
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
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
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

test("plan convergence names an unresolved contract instead of allowing more broad reads", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const result = handlePlanReadOnlyConvergence({
    callbacks: {
      ...harness.callbacks,
      getMessages: () => [{
        role: "user",
        content: "制定桌面应用文档打开流程的修改计划。",
      }],
    },
    iteration: 3,
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    successfulReadOnlyExplorationResultCount: 2,
    planReadOnlyConvergenceBatches: 2,
    planReadOnlyConvergenceTools: 4,
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], externalAttachments: [] },
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/main.ts",
        status: "succeeded",
        detail: "command_invoke_contract(load_document) import open from '@tauri-apps/plugin-dialog'",
      },
      {
        name: "read_file",
        target: "src-tauri/src/lib.rs",
        status: "succeeded",
        detail: "handler_contract(save_document) .plugin(tauri_plugin_dialog::init())",
      },
    ],
    lastAssistantTextForCheckpoint: "",
    setPlanRuntimePhase: (phase, reason) => phases.push({ phase, reason }),
  });

  assert.equal(result.status, "continue");
  assert.match(harness.appended.at(-1)?.content || "", /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.match(harness.appended.at(-1)?.content || "", /permission_contract:dialog/);
  assert.match(harness.appended.at(-1)?.content || "", /do not reread them merely to resolve this gap/i);
  assert.equal(phases.at(-1)?.phase, "needs_evidence");
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

test("read-only convergence cannot reopen evidence after the same batch reached drafting", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const phases = [];
  const result = handlePlanReadOnlyConvergence({
    callbacks: harness.callbacks,
    iteration: 6,
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    successfulReadOnlyExplorationResultCount: 1,
    planReadOnlyConvergenceBatches: 2,
    planReadOnlyConvergenceTools: 3,
    usedPlanReadOnlyConvergencePrompt: true,
    planEvidenceRecoveryObjective: "none",
    planRuntimePhase: "drafting",
    turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], externalAttachments: [] },
    recentPlanToolActivity: [
      { name: "read_file", target: "src/main.js", status: "succeeded", detail: "application initialization and UI wiring" },
    ],
    lastAssistantTextForCheckpoint: "",
    setPlanRuntimePhase: (phase, reason) => phases.push({ phase, reason }),
  });

  assert.equal(result.status, "none");
  assert.equal(result.planReadOnlyConvergenceBatches, 2);
  assert.equal(result.planReadOnlyConvergenceTools, 3);
  assert.equal(result.planEvidenceRecoveryObjective, "none");
  assert.deepEqual(harness.appended, []);
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
  assert.equal(result.planArtifactQualityRejected, true);
  assert.equal(result.planClosureEvidenceRecoveryIssued, true);
  assert.equal(result.planEvidenceRecoveryObjective, "deterministic_closure");
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.deepEqual(phases, [{
    phase: "needs_evidence",
    reason: "bundle_not_ready",
    status: "running",
  }]);
});

test("plan quality recovery keeps structural rewrites out of evidence recovery", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 7,
    results: [{
      toolCallId: "quality-rewrite-1",
      name: "write_file",
      target: ".MAIN/plans/plan.md",
      content: "plan saved but structurally incomplete",
      isError: false,
      internalFeedback: true,
      planRecoveryAction: "rewrite",
      qualityGateReason: "missing_plan_required_sections:key_changes",
      missingPlanSections: ["key_changes"],
    }],
    planRuntimePhase: "drafting",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      detail: "observed implementation evidence",
    }],
    attemptedPlanWriteTargets: [".MAIN/plans/plan.md"],
    latestUserPromptText: "修复计划执行流程",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planArtifactQualityRejected, true);
  assert.equal(result.planClosureEvidenceRecoveryIssued, false);
  assert.equal(result.pendingPlanRuntimeRecoveryPrompt, null);
  assert.deepEqual(phases, [{
    phase: "needs_rewrite",
    reason: "missing_plan_required_sections:key_changes",
    status: "running",
  }]);
});

test("grounded source evidence preserves an auto-scaffold recovery without reopening reads", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterVisibleMaterialization({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 8,
    quality: {
      ok: false,
      reason: "insufficient_actionable_plan_signals",
      missingSections: [],
      recoveryAction: "auto_scaffold",
      canAutoRepair: false,
    },
    planRuntimePhase: "drafting",
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/main.js",
        status: "succeeded",
        detail: "initToolbar registers the New Open and Save button handlers during application initialization",
      },
      {
        name: "read_file",
        target: "src/components/toolbar.js",
        status: "succeeded",
        detail: "renderToolbar creates the New Open and Save controls and exposes their callback contract",
      },
    ],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "按钮没有真实功能，基于已读源码形成可执行修复计划。",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planArtifactQualityRejected: false,
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryObjective: "none",
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planClosureEvidenceRecoveryIssued, false);
  assert.equal(result.planEvidenceRecoveryObjective, "none");
  assert.equal(result.planAutoScaffoldPromptIssued, true);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_AUTO_SCAFFOLD/);
  assert.deepEqual(phases, [{
    phase: "needs_rewrite",
    reason: "auto scaffold after quality gate",
    status: "running",
  }]);
});

test("visible candidate rejection recovers without poisoning persisted artifact state", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterVisibleMaterialization({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 8,
    quality: {
      ok: false,
      reason: "missing_plan_required_sections:key_changes",
      missingSections: ["key_changes"],
      recoveryAction: "rewrite",
      canAutoRepair: true,
    },
    planRuntimePhase: "drafting",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      detail: "observed implementation evidence",
    }],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "修复计划执行流程",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planArtifactQualityRejected: false,
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planQualityRejectCount, 1);
  assert.equal(result.planArtifactQualityRejected, false);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_NEEDS_REWRITE/);
  assert.deepEqual(phases, [{
    phase: "needs_rewrite",
    reason: "missing_plan_required_sections:key_changes",
    status: "running",
  }]);
});

test("second short diagnostic draft keeps its typed rewrite instead of reopening discovery", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterVisibleMaterialization({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 5,
    quality: {
      ok: false,
      reason: "too_short",
      missingSections: [],
      recoveryAction: "rewrite",
      canAutoRepair: false,
    },
    planRuntimePhase: "drafting",
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        detail: "fn main registers Tauri commands and emits file-open events",
      },
      {
        name: "read_file",
        target: "src/main.js",
        status: "succeeded",
        detail: "window.addEventListener handles file-open and openFile invokes the backend",
      },
    ],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "找到双击 Markdown 文件只显示空白以及打开按钮失效的原因并制定整改方案。",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "too_short",
    planLastMissingSections: [],
    planArtifactQualityRejected: false,
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planQualityRejectCount, 2);
  assert.equal(result.planClosureEvidenceRecoveryIssued, false);
  assert.equal(result.planAutoScaffoldPromptIssued, false);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_NEEDS_REWRITE/);
  assert.equal(phases.at(-1)?.phase, "needs_rewrite");
  assert.equal(phases.at(-1)?.reason, "too_short");
});

test("a first rejected draft prioritizes an unresolved contract counterpart over text rewrite", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterVisibleMaterialization({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 6,
    quality: {
      ok: false,
      reason: "unsupported_hypothesis_as_plan",
      missingSections: [],
      recoveryAction: "rewrite",
      canAutoRepair: false,
    },
    planRuntimePhase: "drafting",
    recentPlanToolActivity: [
      {
        name: "read_file",
        target: "src/main.ts",
        status: "succeeded",
        detail: "command_invoke_contract(load_document) import open from '@tauri-apps/plugin-dialog'",
      },
      {
        name: "read_file",
        target: "src-tauri/src/lib.rs",
        status: "succeeded",
        detail: "handler_contract(save_document) .plugin(tauri_plugin_dialog::init())",
      },
    ],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "修复桌面应用的文档打开流程并制定计划。",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planArtifactQualityRejected: false,
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planQualityRejectCount, 1);
  assert.equal(result.planClosureEvidenceRecoveryIssued, true);
  assert.equal(result.planAutoScaffoldPromptIssued, false);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /permission_contract:dialog/);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /runtime permission\/capability\/manifest\/configuration owner/i);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /src-tauri\/src\/lib\.rs/);
  assert.deepEqual(phases, [{
    phase: "needs_evidence",
    reason: "contract_counterpart_unverified",
    status: "running",
  }]);
});

test("visible candidate quality recovery is bounded without changing the typed action", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const common = {
    callbacks: harness.callbacks,
    workflowMode: "plan",
    quality: {
      ok: false,
      reason: "not_structured",
      missingSections: [],
      recoveryAction: "rewrite",
      canAutoRepair: false,
    },
    planRuntimePhase: "needs_rewrite",
    recentPlanToolActivity: [],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Create a reviewable plan",
    planLastQualityGateReason: "not_structured",
    planLastMissingSections: [],
    planArtifactQualityRejected: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: () => {},
  };
  const secondRewrite = handlePlanQualityRecoveryAfterVisibleMaterialization({
    ...common,
    iteration: 9,
    planQualityRejectCount: 1,
    planAutoScaffoldPromptIssued: false,
  });
  const exhausted = handlePlanQualityRecoveryAfterVisibleMaterialization({
    ...common,
    iteration: 10,
    planQualityRejectCount: secondRewrite.planQualityRejectCount,
    planAutoScaffoldPromptIssued: secondRewrite.planAutoScaffoldPromptIssued,
  });

  assert.match(secondRewrite.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_NEEDS_REWRITE/);
  assert.equal(secondRewrite.planAutoScaffoldPromptIssued, false);
  assert.equal(exhausted.planQualityRejectCount, 3);
  assert.equal(exhausted.pendingPlanRuntimeRecoveryPrompt, null);
  assert.equal(exhausted.planArtifactQualityRejected, false);
});

test("quality-rejected plan writes are not eligible for post-tool review", () => {
  const rejectedWrite = {
    toolCallId: "quality-rewrite-review-1",
    name: "write_file",
    target: ".MAIN/plans/plan.md",
    content: "saved but rejected",
    isError: false,
    internalFeedback: true,
    planRecoveryAction: "rewrite",
    qualityGateReason: "missing_plan_required_sections:key_changes",
  };

  assert.equal(shouldPauseForReviewablePlanArtifactAfterToolResults({
    workflowMode: "plan",
    isPlanApproved: false,
    results: [rejectedWrite],
  }), false);

  assert.equal(shouldPauseForReviewablePlanArtifactAfterToolResults({
    workflowMode: "plan",
    isPlanApproved: false,
    results: [{
      ...rejectedWrite,
      internalFeedback: false,
      planRecoveryAction: undefined,
      qualityGateReason: undefined,
    }],
  }), true);
});

test("plan artifact quality rejection persists until a later accepted write", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const common = {
    callbacks: harness.callbacks,
    workflowMode: "plan",
    planRuntimePhase: "needs_rewrite",
    recentPlanToolActivity: [],
    attemptedPlanWriteTargets: [".MAIN/plans/plan.md"],
    latestUserPromptText: "Create a reviewable plan",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: () => {},
  };
  const rejectedWrite = {
    toolCallId: "quality-persist-1",
    name: "write_file",
    target: ".MAIN/plans/plan.md",
    content: "saved but rejected",
    isError: false,
    internalFeedback: true,
    planRecoveryAction: "rewrite",
    qualityGateReason: "missing_plan_required_sections:key_changes",
  };

  const rejected = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 8,
    results: [rejectedWrite],
    planArtifactQualityRejected: false,
  });
  const nextNoToolIteration = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 9,
    results: [],
    planQualityRejectCount: rejected.planQualityRejectCount,
    planLastQualityGateReason: rejected.planLastQualityGateReason,
    planLastMissingSections: rejected.planLastMissingSections,
    planArtifactQualityRejected: rejected.planArtifactQualityRejected,
  });
  const acceptedRewrite = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 10,
    results: [{
      ...rejectedWrite,
      toolCallId: "quality-persist-2",
      content: "accepted reviewable plan",
      internalFeedback: false,
      planRecoveryAction: undefined,
      qualityGateReason: undefined,
    }],
    planArtifactQualityRejected: nextNoToolIteration.planArtifactQualityRejected,
  });

  assert.equal(rejected.planArtifactQualityRejected, true);
  assert.equal(nextNoToolIteration.planArtifactQualityRejected, true);
  assert.equal(acceptedRewrite.planArtifactQualityRejected, false);
});

test("plan quality recovery keeps tools open when a successful read still lacks closure evidence", () => {
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
    planEvidenceRecoveryObjective: "deterministic_closure",
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
  assert.equal(result.planClosureEvidenceRecoveryIssued, true);
  assert.equal(result.planEvidenceRecoveryObjective, "deterministic_closure");
  assert.match(result.pendingPlanRuntimeRecoveryPrompt, /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.deepEqual(phases, [{
    phase: "needs_evidence",
    reason: "change_targets_lack_confirmed_rationale",
    status: "running",
  }]);
});

test("missing-visible-plan recovery retries an unchanged window, then accepts a fresh window without a read-count charge", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const recentActivity = [
    {
      name: "read_file",
      target: "index.html",
      status: "succeeded",
      detail: "app shell contains toolbar, editor, preview, and loads src/main.js",
    },
    {
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "imports editor and preview components and wires application initialization",
    },
    {
      name: "read_file",
      target: "package.json",
      status: "succeeded",
      detail: "defines Vite development and build scripts with UI dependencies",
    },
    {
      name: "read_file",
      target: "vite.config.js",
      status: "succeeded",
      detail: "defines the Vite development and build configuration",
    },
  ];
  const retry = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 4,
    results: [{
      toolCallId: "read-main-cached-window",
      name: "read_file",
      target: "src/main.js",
      content: "FILE_UNCHANGED_STUB: lines 1-100 are already available in context",
      isError: false,
    }],
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "model_draft",
    recentPlanToolActivity: recentActivity,
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "启动软件测试白屏，无任何 UI 显示，找到问题原因并制定修复方案。",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(retry.planEvidenceRecoveryPasses, 0);
  assert.equal(retry.planEvidenceNoProgressPasses, 1);
  assert.equal(retry.planClosureEvidenceRecoveryIssued, true);
  assert.equal(retry.planEvidenceRecoveryObjective, "model_draft");
  assert.match(retry.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_TARGETED_EVIDENCE_RECOVERY/);
  assert.match(retry.pendingPlanRuntimeRecoveryPrompt || "", /missing range|different evidence owner/i);
  assert.deepEqual(phases.at(-1), {
    phase: "needs_evidence",
      reason: "change_targets_lack_confirmed_rationale",
    status: "running",
  });

  const completed = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 5,
    results: [{
      toolCallId: "read-main-next-window",
      name: "read_file",
      target: "src/main.js",
      content: "READ_FILE_RESULT lines 101-200 with renderer initialization",
      isError: false,
      readFileObservation: {
        key: "src/main.js::v1::101-200",
        path: "src/main.js",
        requestSignature: "101-200",
        versionToken: "v1",
        source: "fresh",
      },
    }],
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: retry.planEvidenceRecoveryObjective,
    recentPlanToolActivity: recentActivity,
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "启动软件测试白屏，无任何 UI 显示，找到问题原因并制定修复方案。",
    planQualityRejectCount: retry.planQualityRejectCount,
    planLastQualityGateReason: retry.planLastQualityGateReason,
    planLastMissingSections: retry.planLastMissingSections,
    planAutoScaffoldPromptIssued: retry.planAutoScaffoldPromptIssued,
    planClosureEvidenceRecoveryIssued: retry.planClosureEvidenceRecoveryIssued,
    planEvidenceRecoveryPasses: retry.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: retry.planEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint: retry.planEvidenceProgressFingerprint,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(completed.planEvidenceRecoveryPasses, 0);
  assert.equal(completed.planEvidenceNoProgressPasses, 0);
  assert.equal(completed.planClosureEvidenceRecoveryIssued, false);
  assert.equal(completed.planEvidenceRecoveryObjective, "none");
  assert.match(completed.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_EVIDENCE_RECOVERY_COMPLETE/);
  assert.deepEqual(phases.at(-1), {
    phase: "drafting",
    reason: "model-authored evidence recovery complete",
    status: "running",
  });
});

test("model-draft recovery blocks repeated errors at the bounded no-progress limit", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 6,
    results: [{
      toolCallId: "read-failed",
      name: "read_file",
      target: "src/main.js",
      content: "Error: file unavailable",
      isError: true,
    }],
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "model_draft",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "application initialization and renderer wiring",
    }],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Find the blank-render cause and prepare a repair plan.",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 4,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planEvidenceRecoveryObjective, "model_draft");
  assert.equal(result.planEvidenceNoProgressPasses, 5);
  assert.doesNotMatch(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_EVIDENCE_RECOVERY_COMPLETE/);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_TARGETED_EVIDENCE_RECOVERY/);
  assert.deepEqual(phases.at(-1), {
    phase: "needs_evidence",
    reason: "evidence read failed; choose another target",
    status: "running",
  });

  const repeated = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 7,
    results: [{
      toolCallId: "read-failed-again",
      name: "read_file",
      target: "src/other-main.js",
      content: "Error: file unavailable",
      isError: true,
    }],
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: result.planEvidenceRecoveryObjective,
    recentPlanToolActivity: [],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Find the blank-render cause and prepare a repair plan.",
    planQualityRejectCount: result.planQualityRejectCount,
    planLastQualityGateReason: result.planLastQualityGateReason,
    planLastMissingSections: result.planLastMissingSections,
    planAutoScaffoldPromptIssued: result.planAutoScaffoldPromptIssued,
    planClosureEvidenceRecoveryIssued: result.planClosureEvidenceRecoveryIssued,
    planEvidenceRecoveryPasses: result.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: result.planEvidenceNoProgressPasses,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(repeated.planEvidenceNoProgressPasses, 6);
  assert.equal(repeated.planEvidenceRecoveryObjective, "none");
  assert.match(repeated.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_EVIDENCE_RECOVERY_BLOCKED/);
  assert.deepEqual(phases.at(-1), {
    phase: "blocked",
    reason: "evidence recovery repeatedly failed",
    status: "failed",
  });
});

test("an initial read error persists the Plan baseline before a raw success", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const common = {
    callbacks: harness.callbacks,
    workflowMode: "plan",
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "model_draft",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "application initialization and renderer wiring",
    }],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Find the blank-render cause and prepare a repair plan.",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    setPlanRuntimePhase: () => {},
  };
  const failed = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 42,
    results: [{
      toolCallId: "read-baseline-error",
      name: "read_file",
      target: "src/main.js",
      content: "Error: file unavailable",
      isError: true,
    }],
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 0,
    planEvidenceProgressFingerprint: "",
  });

  assert.equal(failed.planEvidenceNoProgressPasses, 1);
  assert.ok(failed.planEvidenceProgressFingerprint);

  const rawRead = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 43,
    results: [{
      toolCallId: "read-unproven-after-error",
      name: "read_file",
      target: "src/main.js",
      content: "READ_FILE_RESULT with no structured observation identity",
      isError: false,
    }],
    planEvidenceRecoveryPasses: failed.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: failed.planEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint: failed.planEvidenceProgressFingerprint,
  });

  assert.equal(rawRead.planEvidenceRecoveryPasses, 0);
  assert.equal(rawRead.planEvidenceNoProgressPasses, 2);
});

test("fresh but insufficient model-draft evidence preserves the model-draft objective", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 6,
    results: [{
      toolCallId: "read-structural-only",
      name: "read_file",
      target: "src/unknown.ts",
      content: "READ_FILE_RESULT\nexport const value = 1;",
      isError: false,
    }],
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "model_draft",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/unknown.ts",
      status: "succeeded",
    }],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Find the renderer failure and prepare a repair plan.",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planEvidenceRecoveryObjective, "model_draft");
  assert.equal(result.planEvidenceRecoveryPasses, 0);
  assert.equal(result.planEvidenceNoProgressPasses, 0);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_TARGETED_EVIDENCE_RECOVERY/);
  assert.deepEqual(phases.at(-1), {
    phase: "needs_evidence",
    reason: "model draft evidence incomplete",
    status: "running",
  });
});

test("a fourth distinct deterministic evidence window is progress, not budget exhaustion", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const phases = [];
  const result = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 9,
    results: [{
      toolCallId: "read-fourth-window",
      name: "read_file",
      target: "src/App.tsx",
      content: "READ_FILE_RESULT lines 301-400 with another structural owner",
      isError: false,
    }],
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "deterministic_closure",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/App.tsx",
      status: "succeeded",
      detail: "App exports the renderer shell and delegates file-open handling",
    }],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Draft a grounded repair plan for the file-open failure.",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "unsupported_hypothesis_as_plan",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryPasses: 3,
    planEvidenceNoProgressPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planEvidenceRecoveryPasses, 4);
  assert.equal(result.planEvidenceRecoveryObjective, "deterministic_closure");
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.deepEqual(phases.at(-1), {
    phase: "needs_evidence",
      reason: "bundle_not_ready",
    status: "running",
  });
});

test("plan quality recovery closes once a successful read exposes a target defect", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const recentActivity = [{
    name: "read_file",
    target: "src/App.tsx",
    status: "succeeded",
    detail: "App is missing the file-open listener required by the user workflow",
  }];
  const result = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 8,
    results: [{
      toolCallId: "read-defect-1",
      name: "read_file",
      target: "src/App.tsx",
      content: "export function App() {}",
      isError: false,
    }],
    planRuntimePhase: "needs_evidence",
    recentPlanToolActivity: recentActivity,
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Fix the broken file-open workflow",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "missing_plan_required_sections:read_evidence",
    planLastMissingSections: ["Read Evidence"],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryPasses: 1,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planEvidenceRecoveryPasses, 2);
  assert.equal(result.planClosureEvidenceRecoveryIssued, false);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt, /PLAN_EVIDENCE_RECOVERY_COMPLETE/);
  assert.deepEqual(phases, [{
    phase: "drafting",
    reason: "evidence recovery complete",
    status: "running",
  }]);
});

test("an outstanding evidence request is consumed after reconciliation advances to drafting", () => {
  const harness = createPlanConvergenceCallbacks("zh");
  const phases = [];
  const recentActivity = [{
    name: "read_file",
    target: "src/App.tsx",
    status: "succeeded",
    detail: "App is missing the file-open listener required by the user workflow",
  }];
  const result = handlePlanQualityRecoveryAfterToolResults({
    callbacks: harness.callbacks,
    workflowMode: "plan",
    iteration: 9,
    results: [{
      toolCallId: "read-reconciled-1",
      name: "read_file",
      target: "src/App.tsx",
      content: "export function App() {}",
      isError: false,
    }],
    planRuntimePhase: "drafting",
    recentPlanToolActivity: recentActivity,
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Fix the broken file-open workflow",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "uncovered_user_goal_facets:1",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryPasses: 0,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  });

  assert.equal(result.planEvidenceRecoveryPasses, 1);
  assert.equal(result.planClosureEvidenceRecoveryIssued, false);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt, /PLAN_EVIDENCE_RECOVERY_COMPLETE/);
  assert.deepEqual(phases, [{
    phase: "drafting",
    reason: "evidence recovery complete",
    status: "running",
  }]);
});

test("cached evidence recovery pauses at the bounded no-progress limit without consuming evidence budget", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const recentActivity = [
    {
      name: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      detail: "command_invoke_contract(load_document) imports open from '@tauri-apps/plugin-dialog'",
    },
    {
      name: "read_file",
      target: "src-tauri/src/lib.rs",
      status: "succeeded",
      detail: "handler_contract(load_document) initializes tauri_plugin_dialog",
    },
  ];
  const phases = [];
  const common = {
    callbacks: harness.callbacks,
    workflowMode: "plan",
    recentPlanToolActivity: recentActivity,
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Plan a reliable document-open workflow.",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "contract_counterpart_unverified",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planArtifactQualityRejected: false,
    planRuntimePhase: "needs_evidence",
    planClosureEvidenceRecoveryIssued: true,
    planEvidenceRecoveryPasses: 1,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  };
  const repeatedRead = {
    toolCallId: "read-cached-owner",
    name: "read_file",
    target: "src/main.ts",
    content: "Repeated read-only tool call skipped because the file is unchanged.",
    isError: false,
  };

  const retry = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 10,
    planEvidenceNoProgressPasses: 4,
    results: [repeatedRead],
  });

  assert.equal(retry.planEvidenceRecoveryPasses, 1);
  assert.equal(retry.planEvidenceNoProgressPasses, 5);
  assert.equal(retry.planClosureEvidenceRecoveryIssued, true);
  assert.match(retry.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.match(retry.pendingPlanRuntimeRecoveryPrompt || "", /src\/main\.ts/);
  assert.match(retry.pendingPlanRuntimeRecoveryPrompt || "", /choose a different owner/);
  assert.deepEqual(phases.at(-1), {
    phase: "needs_evidence",
    reason: "contract_counterpart_unverified",
    status: "running",
  });

  const blocked = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 11,
    planEvidenceNoProgressPasses: retry.planEvidenceNoProgressPasses,
    results: [repeatedRead],
  });

  assert.equal(blocked.planEvidenceRecoveryPasses, 1);
  assert.equal(blocked.planEvidenceNoProgressPasses, 6);
  assert.equal(blocked.planClosureEvidenceRecoveryIssued, false);
  assert.match(blocked.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_EVIDENCE_RECOVERY_BLOCKED/);
  assert.match(blocked.pendingPlanRuntimeRecoveryPrompt || "", /do not draft a plan that assumes the unresolved evidence/i);
  assert.deepEqual(phases.at(-1), {
    phase: "blocked",
    reason: "evidence recovery repeated without progress",
    status: "failed",
  });
});

test("unproven read payloads cannot extend Plan recovery when the semantic evidence bundle is unchanged", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const phases = [];
  const recentActivity = [{
    name: "read_file",
    target: "src/main.ts",
    status: "succeeded",
    detail: "main imports the toolbar component and initializes the application shell",
  }];
  const common = {
    callbacks: harness.callbacks,
    workflowMode: "plan",
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "deterministic_closure",
    recentPlanToolActivity: recentActivity,
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Plan a grounded repair for the toolbar interaction failure.",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "change_targets_lack_confirmed_rationale",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  };
  const first = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 20,
    results: [{
      toolCallId: "read-semantic-baseline",
      name: "read_file",
      target: "src/main.ts",
      content: "READ_FILE_RESULT lines 1-120",
      isError: false,
    }],
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 0,
    planEvidenceProgressFingerprint: "",
  });

  assert.equal(first.planEvidenceRecoveryPasses, 1);
  assert.equal(first.planEvidenceNoProgressPasses, 0);
  assert.ok(first.planEvidenceProgressFingerprint);

  let blocked = first;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    blocked = handlePlanQualityRecoveryAfterToolResults({
      ...common,
      iteration: 20 + attempt,
      results: [{
        toolCallId: `read-unproven-window-${attempt}`,
        name: "read_file",
        target: attempt % 2 === 0 ? "src/toolbar.ts" : "src/main.ts",
        // Text cannot self-assert a new window. Production reads carry a
        // structured readFileObservation identity when coverage is fresh.
        content: `READ_FILE_RESULT claimed window ${attempt}`,
        isError: false,
      }],
      planEvidenceRecoveryPasses: blocked.planEvidenceRecoveryPasses,
      planEvidenceNoProgressPasses: blocked.planEvidenceNoProgressPasses,
      planEvidenceProgressFingerprint: blocked.planEvidenceProgressFingerprint,
    });
  }

  assert.equal(blocked.planEvidenceRecoveryPasses, 1);
  assert.equal(blocked.planEvidenceNoProgressPasses, 6);
  assert.equal(blocked.planEvidenceRecoveryObjective, "none");
  assert.match(blocked.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_EVIDENCE_RECOVERY_BLOCKED/);
  assert.deepEqual(phases.at(-1), {
    phase: "blocked",
    reason: "evidence recovery repeated without progress",
    status: "failed",
  });
});

test("an initial cache stub persists the Plan evidence baseline before a later raw read", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const common = {
    callbacks: harness.callbacks,
    workflowMode: "plan",
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "model_draft",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      detail: "main initializes the application shell",
    }],
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Plan a grounded repair for the toolbar interaction failure.",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "change_targets_lack_confirmed_rationale",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    setPlanRuntimePhase: () => {},
  };
  const stub = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 40,
    results: [{
      toolCallId: "read-initial-stub",
      name: "read_file",
      target: "src/main.ts",
      content: "FILE_UNCHANGED_STUB: reuse the existing observation",
      isError: false,
    }],
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 0,
    planEvidenceProgressFingerprint: "",
  });

  assert.equal(stub.planEvidenceNoProgressPasses, 1);
  assert.ok(stub.planEvidenceProgressFingerprint);

  const rawRead = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 41,
    results: [{
      toolCallId: "read-unproven-after-stub",
      name: "read_file",
      target: "src/main.ts",
      content: "READ_FILE_RESULT with no structured observation identity",
      isError: false,
    }],
    planEvidenceRecoveryPasses: stub.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: stub.planEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint: stub.planEvidenceProgressFingerprint,
  });

  assert.equal(rawRead.planEvidenceRecoveryPasses, 0);
  assert.equal(rawRead.planEvidenceNoProgressPasses, 2);
});

test("structured non-overlapping fresh coverage resets Plan no-progress without inventing semantic facts", () => {
  const harness = createPlanConvergenceCallbacks("en");
  const phases = [];
  const recentActivity = [{
    name: "read_file",
    target: "src/main.ts",
    status: "succeeded",
    detail: "main imports the toolbar component and initializes the application shell",
  }];
  const common = {
    callbacks: harness.callbacks,
    workflowMode: "plan",
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "deterministic_closure",
    recentPlanToolActivity: recentActivity,
    attemptedPlanWriteTargets: [],
    latestUserPromptText: "Plan a grounded repair for the toolbar interaction failure.",
    planQualityRejectCount: 1,
    planLastQualityGateReason: "change_targets_lack_confirmed_rationale",
    planLastMissingSections: [],
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: true,
    setPlanRuntimePhase: (phase, reason, status = "running") => phases.push({ phase, reason, status }),
  };
  const observation = (key, requestSignature, source = "fresh") => ({
    key,
    path: "src/main.ts",
    requestSignature,
    versionToken: "v1",
    source,
  });
  const baseline = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 30,
    results: [{
      toolCallId: "read-window-1-120",
      name: "read_file",
      target: "src/main.ts",
      content: "READ_FILE_RESULT lines 1-120",
      isError: false,
      readFileObservation: observation("src/main.ts::v1::1-120", "1-120"),
    }],
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 0,
    planEvidenceProgressFingerprint: "",
  });
  const narrowed = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 31,
    results: [{
      toolCallId: "read-overlap-1-121",
      name: "read_file",
      target: "src/main.ts",
      content: "READ_FILE_WINDOW_NARROWED: requested 1-121; returned only line 121",
      isError: false,
      readFileObservation: observation("src/main.ts::v1::1-121", "1-121"),
    }],
    planEvidenceRecoveryPasses: baseline.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: baseline.planEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint: baseline.planEvidenceProgressFingerprint,
  });

  assert.equal(narrowed.planEvidenceRecoveryPasses, 1);
  assert.equal(narrowed.planEvidenceNoProgressPasses, 1);

  const nextWindow = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 32,
    results: [{
      toolCallId: "read-window-121-240",
      name: "read_file",
      target: "src/main.ts",
      content: "READ_FILE_RESULT lines 121-240",
      isError: false,
      readFileObservation: observation("src/main.ts::v1::121-240", "121-240"),
    }],
    planEvidenceRecoveryPasses: narrowed.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: narrowed.planEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint: narrowed.planEvidenceProgressFingerprint,
  });

  assert.equal(nextWindow.planEvidenceRecoveryPasses, 2);
  assert.equal(nextWindow.planEvidenceNoProgressPasses, 0);
  assert.equal(nextWindow.planEvidenceRecoveryObjective, "deterministic_closure");

  const replay = handlePlanQualityRecoveryAfterToolResults({
    ...common,
    iteration: 33,
    results: [{
      toolCallId: "replay-window-121-240",
      name: "read_file",
      target: "src/main.ts",
      content: "CACHED_FILE_REPLAY: lines 121-240",
      isError: false,
      readFileObservation: observation("src/main.ts::v1::121-240", "121-240", "replay"),
    }],
    planEvidenceRecoveryPasses: nextWindow.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: nextWindow.planEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint: nextWindow.planEvidenceProgressFingerprint,
  });

  assert.equal(replay.planEvidenceRecoveryPasses, 2);
  assert.equal(replay.planEvidenceNoProgressPasses, 1);
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
      planEvidenceRecoveryObjective: "none",
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

test("post-convergence helper reopens bounded targeted evidence when a drafting read is suppressed", () => {
  const { harness, phases, input } = createPostConvergenceInput({
    input: {
      visibleAssistantText: "I need one more file.",
      assistantHistoryText: "I need one more file.",
    },
  });
  const result = handlePlanPostConvergenceToolRedirect(input);

  assert.equal(result.status, "continue");
  assert.equal(result.planPostConvergenceToolRedirectCount, 0);
  assert.equal(result.planDraftingRecoveryReadCount, 0);
  assert.equal(result.planEvidenceRecoveryPasses, 0);
  assert.equal(result.planReasoningOnlyRecoveryPasses, 0);
  assert.equal(result.planEvidenceRecoveryObjective, "model_draft");
  assert.equal(result.planAutoScaffoldPromptIssued, false);
  assert.equal(harness.appended.length, 2);
  assert.equal(harness.appended[0].role, "assistant");
  assert.equal(harness.appended[1].role, "user");
  assert.match(harness.appended[1].content, /PLAN_TARGETED_EVIDENCE_RECOVERY/);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.deepEqual(harness.streamTokens, []);
  assert.deepEqual(phases, [{ phase: "needs_evidence", reason: "targeted_reads_without_semantic_facts" }]);
});

test("post-convergence helper forces visible plan convergence after recovery is exhausted", () => {
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
  assert.equal(result.planEvidenceRecoveryObjective, "none");
  assert.equal(result.planAutoScaffoldPromptIssued, false);
  assert.equal(harness.appended.length, 1);
  assert.equal(harness.appended[0].role, "user");
  assert.match(harness.appended[0].content, /FORCED CONVERGENCE/);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.deepEqual(harness.streamTokens, [{ token: "__ESCALATION_RESET__:", id: "assistant-1" }]);
  assert.deepEqual(phases, [{ phase: "drafting", reason: "recovery exhausted, draft with frozen evidence" }]);
});

test("post-convergence tool redirects stop after a bounded recovery budget", () => {
  const { harness, phases, input } = createPostConvergenceInput({
    input: {
      effectiveToolCalls: [{ id: "call_list", name: "list_directory", arguments: "{}" }],
      planRuntimePhase: "drafting",
      planPostConvergenceToolRedirectCount: 3,
      planEvidenceRecoveryPasses: 3,
      planQualityRejectCount: 2,
      planLastQualityGateReason: "missing_plan_required_sections:test_plan",
    },
  });
  const result = handlePlanPostConvergenceToolRedirect(input);

  assert.equal(result.status, "stopped");
  assert.equal(result.planPostConvergenceToolRedirectCount, 3);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "incomplete_plan");
  assert.equal(
    harness.stops[0].progress?.nextStep,
    "post_convergence_tool_redirect_budget_exhausted",
  );
  assert.deepEqual(harness.statuses, ["idle"]);
  assert.deepEqual(phases, [{
    phase: "blocked",
    reason: "post_convergence_tool_redirect_budget_exhausted",
  }]);
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
  }), ["grep_search", "read_file", "repo_map_context"]);

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
