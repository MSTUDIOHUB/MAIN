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
      semanticFacts: 0,
      changeTargets: 0,
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
        { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
      ],
    }).status,
    "needs_targeted_read",
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasObservedUserContext: true,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
        { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded", detail: "normalizeCsvOrder currently maps creator but never assigns creatorName consumed by Dashboard" },
      ],
    }).status,
    "ready_for_plan",
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
    hasObservedUserContext: false,
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
    hasObservedUserContext: true,
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
    hasObservedUserContext: true,
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
    hasObservedUserContext: true,
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
  assert.match(harness.appended.at(-1)?.content || "", /不要仅为解决当前缺口而重读/);
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
  assert.equal(result.pendingPlanRuntimeRecoveryPrompt, null);
  assert.deepEqual(phases, [{
    phase: "needs_evidence",
    reason: "missing_plan_required_sections:read_evidence",
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

test("second short diagnostic draft requests evidence instead of forcing an invalid scaffold", () => {
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
  assert.equal(result.planClosureEvidenceRecoveryIssued, true);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.equal(phases.at(-1)?.phase, "needs_evidence");
  assert.equal(phases.at(-1)?.reason, "change_targets_lack_confirmed_rationale");
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
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /运行时权限、capability、manifest 或配置拥有者/);
  assert.match(result.pendingPlanRuntimeRecoveryPrompt || "", /src-tauri\/src\/lib\.rs/);
  assert.deepEqual(phases, [{
    phase: "needs_evidence",
    reason: "contract_counterpart_unverified",
    status: "running",
  }]);
});

test("visible candidate quality recovery is bounded after rewrite and scaffold", () => {
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
  const scaffold = handlePlanQualityRecoveryAfterVisibleMaterialization({
    ...common,
    iteration: 9,
    planQualityRejectCount: 1,
    planAutoScaffoldPromptIssued: false,
  });
  const exhausted = handlePlanQualityRecoveryAfterVisibleMaterialization({
    ...common,
    iteration: 10,
    planQualityRejectCount: scaffold.planQualityRejectCount,
    planAutoScaffoldPromptIssued: scaffold.planAutoScaffoldPromptIssued,
  });

  assert.match(scaffold.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_AUTO_SCAFFOLD/);
  assert.equal(scaffold.planAutoScaffoldPromptIssued, true);
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
  assert.match(result.pendingPlanRuntimeRecoveryPrompt, /PLAN_CLOSURE_NEEDS_EVIDENCE/);
  assert.deepEqual(phases, [{
    phase: "needs_evidence",
    reason: "change_targets_lack_confirmed_rationale",
    status: "running",
  }]);
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

test("cached evidence recovery retries a different owner once, then pauses without consuming evidence budget", () => {
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
    planEvidenceNoProgressPasses: 0,
    results: [repeatedRead],
  });

  assert.equal(retry.planEvidenceRecoveryPasses, 1);
  assert.equal(retry.planEvidenceNoProgressPasses, 1);
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
  assert.equal(blocked.planEvidenceNoProgressPasses, 2);
  assert.equal(blocked.planClosureEvidenceRecoveryIssued, false);
  assert.match(blocked.pendingPlanRuntimeRecoveryPrompt || "", /PLAN_EVIDENCE_RECOVERY_BLOCKED/);
  assert.match(blocked.pendingPlanRuntimeRecoveryPrompt || "", /do not draft a plan that assumes the unresolved evidence/i);
  assert.deepEqual(phases.at(-1), {
    phase: "blocked",
    reason: "evidence recovery repeated without progress",
    status: "failed",
  });
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

test("post-convergence helper reopens bounded targeted evidence when a drafting read is suppressed", () => {
  const { harness, phases, input } = createPostConvergenceInput({
    input: {
      visibleAssistantText: "I need one more file.",
      assistantHistoryText: "I need one more file.",
    },
  });
  const result = handlePlanPostConvergenceToolRedirect(input);

  assert.equal(result.status, "continue");
  assert.equal(result.planPostConvergenceToolRedirectCount, 1);
  assert.equal(result.planDraftingRecoveryReadCount, 0);
  assert.equal(result.planEvidenceRecoveryPasses, 1);
  assert.equal(result.planReasoningOnlyRecoveryPasses, 0);
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
      effectiveToolCalls: [{ id: "call_read", name: "read_file", arguments: "{}" }],
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
