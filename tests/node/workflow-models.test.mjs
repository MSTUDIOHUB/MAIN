import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadWorkflowModelsModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));
}

function loadPlanEvidenceModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planEvidence.ts"));
}

function loadApprovedPlanExecutionScopeModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/approvedPlanExecutionScope.ts"));
}

function loadPlanControlModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planControl.ts"));
}

function loadPlanExecutionNoToolModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionNoTool.ts"));
}

function loadPlanLifecycleModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planLifecycle.ts"));
}

function loadTurnProgressModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnProgress.ts"));
}

function loadDiffModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/diff.ts"));
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
  buildPlanTaskEvidenceAudit,
  analyzePlanDecisionFork,
  collectChangeEntries,
  detectExplicitLanguageOverride,
  detectResponseLanguageMismatch,
  deriveRuntimePlanTasksFromArtifacts,
  deriveVisibleConversationTurnStatus,
  extractShellCommandsFromText,
  extractPlanTasks,
  findDroppedPlanTasks,
  hasLivePlanWorkspace,
  hasBrowserValidationCapability,
  inferPlanTaskEvidence,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  isEphemeralPlanArtifactPath,
  isFinitePlanValidationCommand,
  isPlanTaskSourceMutationObligation,
  isPlanTaskTrustedComplete,
  isRuntimeTaskActionableText,
  looksLikeReasoningLeakTitle,
  mergePlanTasks,
  mergeRuntimeValidationTaskRequirements,
  deriveRuntimeValidationTasksFromUserRequest,
  normalizeConversationDisplayTitle,
  normalizeResponseLanguagePolicy,
  planTaskHasUnsatisfiedSourceMutationEvidence,
  reconcilePlanTaskCompletion,
  resolvePlanExecutionEvidenceIdentity,
  resolveTurnResponseLanguage,
  resolveActiveConversationTurn,
  resolvePinnedConversationTurn,
  shouldPlanShortcutReplaceTurn,
  summarizeUserPrompt,
  syncPlanTaskCheckboxesFromTrustedTasks,
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
} = loadWorkflowModelsModule();

const {
  appendPlanEvidenceEntry,
  createPlanExecutionEvidenceEntry,
  isPlanEvidenceLedgerTool,
  isPlanExecutionEvidenceTool,
  shouldRecordPlanExecutionFailure,
} = loadPlanEvidenceModule();

const {
  buildApprovedPlanScopeConflictFingerprint,
  resolveApprovedPlanCommandScope,
  resolveApprovedPlanMutationScope,
} = loadApprovedPlanExecutionScopeModule();

const {
  buildPlanApprovalChoiceHint,
  hasReviewablePlanArtifact,
  hasReviewablePlanContext,
  resolvePlanApprovalQuickReplyAction,
  shouldRouteQuickReplyToPlanApproval,
} = loadPlanControlModule();

const {
  buildPlanExecutionNoToolRecoveryPrompt,
  shouldHandleApprovedPlanExecutionNoTool,
} = loadPlanExecutionNoToolModule();

const {
  buildClosedActivePlanRuntimePatch,
} = loadPlanLifecycleModule();

const {
  deriveTurnProgressItems,
} = loadTurnProgressModule();

const {
  buildLineDiff,
} = loadDiffModule();

test("response language policy normalizes unknown values to follow-input mode", () => {
  assert.equal(normalizeResponseLanguagePolicy("prefer_system_language_with_explicit_switch"), "prefer_system_language_with_explicit_switch");
  assert.equal(normalizeResponseLanguagePolicy("follow_input_language"), "follow_input_language");
  assert.equal(normalizeResponseLanguagePolicy("unknown"), "follow_input_language");
  assert.equal(normalizeResponseLanguagePolicy(null), "follow_input_language");
});

test("hasLivePlanWorkspace ignores historical turn content and tracks live artifacts, tasks, stage, or preview", () => {
  assert.equal(hasLivePlanWorkspace({ planArtifacts: [], planTasks: [], planStage: "idle" }), false);
  assert.equal(hasLivePlanWorkspace({ planArtifacts: [{ path: ".MAIN/plans/plan.md" }], planTasks: [], planStage: "idle" }), true);
  assert.equal(hasLivePlanWorkspace({ planArtifacts: [], planTasks: [{ id: "1" }], planStage: "idle" }), true);
  assert.equal(hasLivePlanWorkspace({ planArtifacts: [], planTasks: [], planStage: "ready_to_execute" }), true);
  assert.equal(hasLivePlanWorkspace({ planArtifacts: [], planTasks: [], planStage: "idle", fallbackPlanPreview: "# Plan" }), true);
});

test("explicit language override detects English and Chinese directives", () => {
  assert.equal(detectExplicitLanguageOverride("请用英文回复我后续的结果"), "en");
  assert.equal(detectExplicitLanguageOverride("reply in chinese please"), "zh");
  assert.equal(detectExplicitLanguageOverride("我在做本地化，不需要切换回复语言"), null);
});

test("turn response language resolver respects explicit override and policy", () => {
  const explicitOverride = resolveTurnResponseLanguage({
    text: "请用英文回复，然后继续",
    policy: "prefer_system_language_with_explicit_switch",
    systemLanguage: "zh",
    fallbackLanguage: "zh",
  });
  assert.equal(explicitOverride, "en");

  const systemPreferred = resolveTurnResponseLanguage({
    text: "这是中文请求，需要你分析并给出方案。This is only a short note.",
    policy: "prefer_system_language_with_explicit_switch",
    systemLanguage: "en",
    fallbackLanguage: "en",
  });
  assert.equal(systemPreferred, "en");

  const followInput = resolveTurnResponseLanguage({
    text: "这是中文请求，需要你分析并给出方案。This is only a short note.",
    policy: "follow_input_language",
    systemLanguage: "en",
    fallbackLanguage: "en",
  });
  assert.equal(followInput, "zh");

  const chineseWithPath = resolveTurnResponseLanguage({
    text: "请读取外部日志 /tmp/e2e-outside-main-debug.log。",
    policy: "follow_input_language",
    systemLanguage: "en",
    fallbackLanguage: "en",
  });
  assert.equal(chineseWithPath, "zh");
});

test("response language mismatch detection ignores code-heavy text and catches real mismatch", () => {
  const codeLike = detectResponseLanguageMismatch({
    text: "```ts\\nconst value = 1;\\nfunction run() { return value; }\\n```",
    targetLanguage: "zh",
  });
  assert.equal(codeLike.mismatch, false);
  assert.equal(codeLike.hasEnoughSignal, false);

  const mismatch = detectResponseLanguageMismatch({
    text: "Let me summarize the current findings. The root cause is a null pointer in setup.",
    targetLanguage: "zh",
  });
  assert.equal(mismatch.hasEnoughSignal, true);
  assert.equal(mismatch.mismatch, true);

  const aligned = detectResponseLanguageMismatch({
    text: "当前结论：已经定位到根因，下一步修复初始化空引用。",
    targetLanguage: "zh",
  });
  assert.equal(aligned.mismatch, false);

  const mixedCodeTerms = detectResponseLanguageMismatch({
    text: "我读取 `src/components/Dashboard/CourseBarChart.tsx` 确认图表数据。",
    targetLanguage: "zh",
  });
  assert.equal(mixedCodeTerms.mismatch, false);
});

test("normalizeConversationDisplayTitle strips speaker timestamps from transcript-style prompts", () => {
  const title = normalizeConversationDisplayTitle("Michael@: 04-23 17:57:52 这个它要建模 是啥意思", 40, "新的任务");
  assert.equal(title, "这个它要建模 是啥意思");
});

test("summarizeUserPrompt turns slash plan CTB request into a stable intent title", () => {
  const title = summarizeUserPrompt(
    "/计划 你是Unity游戏开发工程师，生成一套游戏框架代码包括文件夹，实现《歧路旅人》 CTB回合制战斗逻辑。",
    40,
  );
  assert.equal(title, "实现 CTB 战斗框架");
});

test("plan approval quick reply routes through approvePlan control path", () => {
  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 }],
    }),
    true,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "先运行诊断脚本，再根据结果修复字体加载",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 }],
    }),
    false,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
      optionAction: "execute_once",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 }],
    }),
    true,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "直接执行部署脚本 deploy.sh",
      optionAction: "execute_once",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 }],
    }),
    true,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
      optionAction: "allow_readonly_session",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 }],
    }),
    false,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
      sourceIntent: "execute",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 }],
    }),
    false,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
      sourceIntent: "plan",
      isPlanApproved: true,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 }],
    }),
    false,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "idle",
      planArtifacts: [],
    }),
    false,
  );
});

test("plan approval quick reply resolves materialization and blocking branches", () => {
  const designArtifact = { kind: "design", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 };

  assert.equal(
    resolvePlanApprovalQuickReplyAction({
      text: "我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证",
      optionAction: "approve_operation_once",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [designArtifact],
      sourceHasMaterializablePlan: false,
    }),
    "approve_existing_plan",
  );

  assert.equal(
    resolvePlanApprovalQuickReplyAction({
      text: "我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证",
      optionAction: "approve_operation_once",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "idle",
      planArtifacts: [],
      sourceHasMaterializablePlan: true,
    }),
    "materialize_then_approve",
  );

  assert.equal(
    resolvePlanApprovalQuickReplyAction({
      text: "我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证",
      optionAction: "approve_operation_once",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "idle",
      planArtifacts: [],
      sourceHasMaterializablePlan: false,
    }),
    "block_missing_plan_artifact",
  );

  assert.equal(
    resolvePlanApprovalQuickReplyAction({
      text: "我批准执行",
      optionAction: "approve_operation_once",
      sourceIntent: "execute",
      isPlanApproved: false,
      planStage: "idle",
      planArtifacts: [],
      sourceHasMaterializablePlan: true,
    }),
    "not_plan_approval",
  );
});

test("reviewable plan approval requires a materialized non-empty artifact", () => {
  assert.equal(hasReviewablePlanArtifact([]), false);
  assert.equal(hasReviewablePlanArtifact([
    { kind: "plan", path: ".MAIN/plans/plan.md", title: "Plan", content: "   ", updatedAt: 1 },
  ]), false);
  assert.equal(hasReviewablePlanArtifact([
    { kind: "plan", path: ".MAIN/plans/plan.md", title: "Plan", content: "# Plan", updatedAt: 1 },
  ]), true);
  assert.equal(hasReviewablePlanContext({ planStage: "design", planArtifacts: [] }), false);
});

test("plan approval choice hint preserves the selected execution branch", () => {
  assert.equal(
    buildPlanApprovalChoiceHint("批准执行：先运行诊断脚本，再根据结果修复字体加载", "zh"),
    "用户批准并选择：批准执行：先运行诊断脚本，再根据结果修复字体加载\n",
  );
});

test("completed plan lifecycle patch clears active runtime without deleting history inputs", () => {
  assert.deepEqual(buildClosedActivePlanRuntimePatch(), {
    isPlanApproved: false,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: null,
    planStage: "idle",
    showPlanPanel: false,
  });
});

test("plan shortcut does not replace visible execution progress", () => {
  assert.equal(
    shouldPlanShortcutReplaceTurn({
      isPlanTurn: true,
      hasCompletePlan: true,
      isPlanExecutionVisible: true,
    }),
    false,
  );

  assert.equal(
    shouldPlanShortcutReplaceTurn({
      isPlanTurn: true,
      hasCompletePlan: true,
      isPlanExecutionVisible: false,
    }),
    true,
  );
});

test("deriveTurnProgressItems prefers explicit jobs and ignores plain numbered prose", () => {
  const explicit = deriveTurnProgressItems([
    {
      id: 1,
      type: "agent",
      content: "<plan>[{\"id\":\"1\",\"subject\":\"准备文件\",\"status\":\"completed\"},{\"id\":\"2\",\"subject\":\"运行验证\",\"status\":\"in_progress\"}]</plan>",
    },
    {
      id: 2,
      type: "tool",
      toolName: "read_file",
      target: "src/App.tsx",
      toolStatus: "executed",
    },
  ], "zh");

  assert.deepEqual(explicit, [
    { id: "1", text: "准备文件", status: "completed" },
    { id: "2", text: "运行验证", status: "in_progress" },
  ]);

  assert.deepEqual(
    deriveTurnProgressItems([
      { id: 3, type: "agent", content: "1. 先分析\n2. 再修改\n3. 最后验证" },
    ], "zh"),
    [],
  );
});

test("deriveTurnProgressItems ignores plain tool activity without explicit ordered progress", () => {
  const steps = deriveTurnProgressItems([
    { id: 1, type: "tool", toolName: "read_file", target: "src/App.tsx", toolStatus: "executed" },
    { id: 2, type: "tool", toolName: "replace_in_file", target: "src/App.tsx", toolStatus: "running" },
    { id: 3, type: "tool", toolName: "run_command", target: "npm test", toolStatus: "failed" },
  ], "zh");

  assert.deepEqual(steps, []);
});

test("buildLineDiff keeps unchanged middle context for small localized edits", () => {
  const diff = buildLineDiff(
    ["alpha", "keep-one", "old", "keep-two", "omega"].join("\n"),
    ["alpha", "keep-one", "new", "keep-two", "omega"].join("\n"),
  );

  assert.deepEqual(diff.map((line) => `${line.type}:${line.text}`), [
    "unchanged:alpha",
    "unchanged:keep-one",
    "removed:old",
    "added:new",
    "unchanged:keep-two",
    "unchanged:omega",
  ]);
});

test("looksLikeReasoningLeakTitle detects leaked chain-of-thought style titles", () => {
  assert.equal(
    looksLikeReasoningLeakTitle("Here's a thinking process: 1. Analyze User Input: inspect the request"),
    true,
  );
});

test("resolveActiveConversationTurn prefers the latest turn while auto-following the bottom", () => {
  const turns = [
    {
      id: "turn-1",
      userPrompt: "第一轮",
      title: "第一轮",
      mode: "chat",
      status: "done",
      summary: "第一轮已完成",
      blockIds: [],
      collapsed: true,
      createdAt: 1,
    },
    {
      id: "turn-2",
      userPrompt: "第二轮",
      title: "第二轮",
      mode: "chat",
      status: "executing",
      summary: "",
      blockIds: [],
      collapsed: false,
      createdAt: 2,
    },
  ];

  const activeTurn = resolveActiveConversationTurn(turns, "turn-1", true);
  assert.equal(activeTurn?.id, "turn-2");
});

test("resolveActiveConversationTurn keeps following the visible turn when auto-follow is off", () => {
  const turns = [
    {
      id: "turn-1",
      userPrompt: "第一轮",
      title: "第一轮",
      mode: "chat",
      status: "done",
      summary: "第一轮已完成",
      blockIds: [],
      collapsed: true,
      createdAt: 1,
    },
    {
      id: "turn-2",
      userPrompt: "第二轮",
      title: "第二轮",
      mode: "chat",
      status: "executing",
      summary: "",
      blockIds: [],
      collapsed: false,
      createdAt: 2,
    },
  ];

  const activeTurn = resolveActiveConversationTurn(turns, "turn-1", false);
  assert.equal(activeTurn?.id, "turn-1");
});

test("resolvePinnedConversationTurn stays on the current executing turn while browsing older content", () => {
  const turns = [
    {
      id: "turn-1",
      userPrompt: "第一轮",
      title: "第一轮",
      mode: "chat",
      status: "done",
      summary: "第一轮已完成",
      blockIds: [],
      collapsed: true,
      createdAt: 1,
    },
    {
      id: "turn-2",
      userPrompt: "执行计划",
      title: "执行计划",
      mode: "plan",
      status: "executing",
      summary: "",
      blockIds: [],
      collapsed: false,
      createdAt: 2,
    },
  ];

  const pinnedTurn = resolvePinnedConversationTurn(turns, "turn-2");
  assert.equal(pinnedTurn?.id, "turn-2");
  assert.equal(pinnedTurn?.mode, "plan");
});

test("deriveVisibleConversationTurnStatus shows paused when approved plan execution is no longer actively running", () => {
  const visibleStatus = deriveVisibleConversationTurnStatus({
    baseStatus: "executing",
    workflowMode: "plan",
    isPinnedPlanTurnVisible: true,
    isPlanApproved: true,
    planStage: "executing",
    agentStatus: "idle",
    hasIncompletePlanTasks: true,
    hasTasksArtifact: true,
  });

  assert.equal(visibleStatus, "paused");
});

test("deriveVisibleConversationTurnStatus never lets Plan globals reopen a terminal runtime outcome", () => {
  const base = {
    baseStatus: "executing",
    workflowMode: "plan",
    isPinnedPlanTurnVisible: true,
    isPlanApproved: true,
    planStage: "executing",
    agentStatus: "idle",
    hasIncompletePlanTasks: true,
    hasTasksArtifact: true,
  };

  for (const resultKind of ["success", "partial", "blocked", "error"]) {
    const visibleStatus = deriveVisibleConversationTurnStatus({
      ...base,
      runtimeOutcome: {
        status: "completed",
        reason: `terminal_${resultKind}`,
        resultKind,
        runId: `run-${resultKind}`,
        parentRunId: null,
        updatedAt: 10,
      },
    });
    assert.equal(visibleStatus, resultKind);
  }

  assert.equal(deriveVisibleConversationTurnStatus({
    ...base,
    runtimeOutcome: {
      status: "aborted",
      reason: "user_cancelled",
      resultKind: "canceled",
      runId: "run-canceled",
      parentRunId: null,
      updatedAt: 11,
    },
  }), "canceled");
});

test("deriveVisibleConversationTurnStatus keeps awaiting approval visible before plan execution starts", () => {
  const visibleStatus = deriveVisibleConversationTurnStatus({
    baseStatus: "planning",
    workflowMode: "plan",
    isPinnedPlanTurnVisible: true,
    isPlanApproved: false,
    planStage: "ready_to_execute",
    agentStatus: "pending_review",
    hasIncompletePlanTasks: false,
    hasTasksArtifact: false,
  });

  assert.equal(visibleStatus, "awaiting_approval");
});

test("deriveVisibleConversationTurnStatus leaves non-pinned historical turns unchanged", () => {
  const visibleStatus = deriveVisibleConversationTurnStatus({
    baseStatus: "done",
    workflowMode: "plan",
    isPinnedPlanTurnVisible: false,
    isPlanApproved: true,
    planStage: "executing",
    agentStatus: "idle",
    hasIncompletePlanTasks: true,
    hasTasksArtifact: true,
  });

  assert.equal(visibleStatus, "done");
});

test("extractPlanTasks uses stable ids across task reordering", () => {
  const first = extractPlanTasks("- [ ] 任务1：完善 BattleUnit.cs\n- [ ] 任务2：更新 BattleManager.cs");
  const reordered = extractPlanTasks("- [ ] 任务2：更新 BattleManager.cs\n- [ ] 任务1：完善 BattleUnit.cs");

  assert.equal(first.find((task) => task.text.includes("BattleUnit"))?.id, reordered.find((task) => task.text.includes("BattleUnit"))?.id);
  assert.equal(first.find((task) => task.text.includes("BattleManager"))?.id, reordered.find((task) => task.text.includes("BattleManager"))?.id);
});

test("extractPlanTasks parses checkbox completion as a claim and extracts evidence tags", () => {
  const [task] = extractPlanTasks("- [x] 实现 snake.py — 食物生成与碰撞检测 — 证据: file:snake.py, cmd:python3 -m py_compile snake.py");

  assert.equal(task.status, "pending");
  assert.equal(task.claimedStatus, "completed");
  assert.deepEqual(task.evidence.map((item) => `${item.kind}:${item.value}`), [
    "file:snake.py",
    "cmd:python3 -m py_compile snake.py",
  ]);
});

test("mergePlanTasks preserves claimed task history without trusting unchecked evidence", () => {
  const previous = extractPlanTasks("- [x] 任务1：完善 BattleUnit.cs\n- [ ] 任务2：更新 BattleManager.cs");
  const latest = extractPlanTasks("- [ ] 任务2：更新 BattleManager.cs");
  const merged = mergePlanTasks(previous, latest, true);

  assert.equal(merged.length, 2);
  assert.equal(merged.find((task) => task.text.includes("BattleUnit"))?.status, "pending");
  assert.equal(merged.find((task) => task.text.includes("BattleUnit"))?.claimedStatus, "completed");
  assert.equal(merged.find((task) => task.text.includes("BattleUnit"))?.retained, true);
  assert.equal(merged.find((task) => task.text.includes("BattleManager"))?.retained, false);
});

test("mergePlanTasks treats completion suffixes as the same claimed task identity", () => {
  const previous = extractPlanTasks("- [ ] 保存方案供用户留档\n- [ ] 批准执行并完成最终收尾");
  const latest = extractPlanTasks("- [x] 保存方案供用户留档（已完成）\n- [ ] 批准执行并完成最终收尾");
  const merged = mergePlanTasks(previous, latest, true);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "保存方案供用户留档（已完成）");
  assert.equal(merged[0].status, "pending");
  assert.equal(merged[0].claimedStatus, "completed");
  assert.equal(merged[0].retained, false);
});

test("reconcilePlanTaskCompletion only completes tasks with matching execution evidence", () => {
  const parsed = extractPlanTasks("- [x] 实现 snake.py — 食物生成与碰撞检测 — 证据: file:snake.py\n- [x] 创建 README.md — 证据: file:README.md");
  const reconciled = reconcilePlanTaskCompletion([], parsed, [{
    id: "evidence-1",
    kind: "file",
    value: "snake.py",
    target: "snake.py",
    sourceTool: "write_file",
    createdAt: 1,
  }]);

  const snakeTask = reconciled.find((task) => task.text.includes("snake.py"));
  const readmeTask = reconciled.find((task) => task.text.includes("README"));
  assert.ok(snakeTask);
  assert.ok(readmeTask);
  assert.equal(isPlanTaskTrustedComplete(snakeTask), true);
  assert.equal(snakeTask.status, "completed");
  assert.equal(readmeTask.status, "in_progress");
  assert.equal(readmeTask.evidenceStatus, "missing");
});

test("syncPlanTaskCheckboxesFromTrustedTasks mirrors trusted evidence without trusting claims", () => {
  const markdown = [
    "# Tasks",
    "- [ ] 实现 snake.py — 证据: file:snake.py",
    "- [x] 创建 README.md — 证据: file:README.md",
  ].join("\n");
  const parsed = extractPlanTasks(markdown);
  const trustedTasks = reconcilePlanTaskCompletion([], parsed, [{
    id: "evidence-1",
    kind: "file",
    value: "snake.py",
    target: "snake.py",
    sourceTool: "write_file",
    createdAt: 1,
  }]);

  const synced = syncPlanTaskCheckboxesFromTrustedTasks(markdown, trustedTasks);

  assert.match(synced, /- \[x\] 实现 snake\.py/);
  assert.match(synced, /- \[ \] 创建 README\.md/);
});

test("plan evidence ignores plan-file writes and identical write_file no-ops", () => {
  const parsed = extractPlanTasks("- [x] 创建 README.md — 证据: file:README.md");
  const planWrite = createPlanExecutionEvidenceEntry({
    toolName: "write_file",
    target: ".MAIN/plans/tasks.md",
    result: JSON.stringify({ success: true }),
  });
  const noOpWrite = createPlanExecutionEvidenceEntry({
    toolName: "write_file",
    target: "README.md",
    result: JSON.stringify({ success: true, noOp: true }),
    noOp: true,
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, [planWrite, noOpWrite].filter(Boolean));

  assert.equal(planWrite, null);
  assert.equal(noOpWrite, null);
  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), false);
  assert.equal(reconciled[0].evidenceStatus, "missing");
});

test("plan evidence trusts verified MCP edits but not non-mutating manage_script calls", () => {
  const task = extractPlanTasks(
    "- [ ] 修改 `Assets/Scripts/Foo.cs` 添加启动保护。",
  )[0];
  const mcpEdit = createPlanExecutionEvidenceEntry({
    toolName: "script_apply_edits",
    target: "Assets/Scripts/Foo.cs",
    result: JSON.stringify({ success: true }),
    diff: {
      old: "void Start() {}",
      new: "void Start() { GuardStartup(); }",
      path: "Assets/Scripts/Foo.cs",
    },
  });
  const inspectOnly = createPlanExecutionEvidenceEntry({
    toolName: "manage_script",
    target: "manage_script",
    result: JSON.stringify({ success: true, action: "inspect" }),
  });
  const reconciled = reconcilePlanTaskCompletion([], [task], mcpEdit ? [mcpEdit] : []);

  assert.equal(mcpEdit?.kind, "file");
  assert.equal(mcpEdit?.target, "Assets/Scripts/Foo.cs");
  assert.equal(inspectOnly, null);
  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), true);
});

test("plan evidence records ordered finite command outcomes", () => {
  const failedCommand = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "python3 -m py_compile snake.py",
    result: JSON.stringify({ exitCode: 1, stderr: "SyntaxError" }),
  });
  const successfulCommand = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "python3 -m py_compile snake.py",
    result: JSON.stringify({ exitCode: 0, stdout: "" }),
  });
  const firstLedger = appendPlanEvidenceEntry([], successfulCommand);
  const secondLedger = appendPlanEvidenceEntry(firstLedger, successfulCommand);

  assert.equal(isPlanExecutionEvidenceTool("read_file", "snake.py"), false);
  assert.equal(isPlanExecutionEvidenceTool("write_file", ".MAIN/plans/tasks.md"), false);
  assert.equal(failedCommand?.observationStatus, "failed");
  assert.equal(firstLedger.length, 1);
  assert.equal(secondLedger.length, 2);
});

test("only explicit executor failures qualify for the durable evidence ledger", () => {
  assert.equal(shouldRecordPlanExecutionFailure(), false);
  assert.equal(shouldRecordPlanExecutionFailure({ failureKind: "policy" }), false);
  assert.equal(shouldRecordPlanExecutionFailure({
    failureKind: "actual",
    internalFeedback: true,
  }), false);
  assert.equal(shouldRecordPlanExecutionFailure({ failureKind: "actual" }), true);
});

test("exact command evidence cannot hide an unresolved failure behind an unrelated pass", () => {
  const failedBuild = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm run build",
    result: JSON.stringify({ exitCode: 1, stderr: "TS2322: invalid assignment" }),
  });
  const passedLint = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm run lint",
    result: JSON.stringify({ exitCode: 0, stdout: "ok" }),
  });
  const passedBuild = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm run build",
    result: JSON.stringify({ exitCode: 0, stdout: "built" }),
  });
  const task = {
    id: "build-validation",
    text: "Run npm build",
    status: "pending",
    evidence: [{ kind: "cmd", value: "npm run build" }],
  };
  const unresolvedLedger = appendPlanEvidenceEntry(
    appendPlanEvidenceEntry([], failedBuild),
    passedLint,
  );
  const unresolved = reconcilePlanTaskCompletion([], [task], unresolvedLedger);
  assert.equal(unresolved[0].evidenceStatus, "blocked");
  assert.match(unresolved[0].blockedReason || "", /同一命令成功/);

  const repairedLedger = appendPlanEvidenceEntry(unresolvedLedger, passedBuild);
  const repaired = reconcilePlanTaskCompletion([], [task], repairedLedger);
  assert.equal(repaired[0].evidenceStatus, "satisfied");
  assert.equal(repaired[0].status, "completed");
});

test("plan verification reads only satisfy explicit tool evidence", () => {
  const verification = createPlanExecutionEvidenceEntry({
    toolName: "read_file",
    target: "README.md",
    result: "# README",
  });
  const fileTask = reconcilePlanTaskCompletion(
    [],
    extractPlanTasks("- [x] 创建 README.md — 证据: file:README.md"),
    verification ? [verification] : [],
  );
  const toolTask = reconcilePlanTaskCompletion(
    [],
    extractPlanTasks("- [x] 验证 README.md 已可读取 — 证据: tool:read_file"),
    verification ? [verification] : [],
  );

  assert.equal(isPlanExecutionEvidenceTool("read_file", "README.md"), false);
  assert.equal(isPlanEvidenceLedgerTool("read_file", "README.md"), true);
  assert.equal(verification?.kind, "tool");
  assert.equal(isPlanTaskTrustedComplete(fileTask[0]), false);
  assert.equal(isPlanTaskTrustedComplete(toolTask[0]), true);
});

test("runtime plan task derivation creates executable tasks without tasks.md", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "design",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# Plan",
        "",
        "## 执行顺序",
        "- 更新 src/lib/runtimeTools.ts，让批准后的 runtime 任务清单可以解锁执行。",
        "- 调整 src/store/useAppStore.ts，在批准时派生 runtime 任务。",
        "- 运行 `node --test tests/node/runtime-tools-events-envelope.test.mjs` 验证闸门。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.ok(tasks.length >= 3);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/lib/runtimeTools.ts")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value.includes("runtime-tools-events-envelope"))), true);
});

test("runtime plan task derivation binds prose change sections with a labeled file", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan: 修复 CSV creator 字段映射",
      "",
      "## 改动",
      "**文件**: `src/hooks/useCsvParser.ts`",
      "",
      "修改 `normalizeCsvOrder` 函数，将 CSV 的 creator 字段映射到 creatorName。",
      "",
      "```typescript",
      "return { creatorName: row.creator || '' };",
      "```",
      "",
      "## 验证",
      "1. 运行聚焦测试，确认 creatorName 已赋值。",
    ].join("\n"),
  }], { language: "zh" });

  const sourceTask = tasks.find((task) =>
    task.evidence?.some((evidence) =>
      evidence.kind === "file" && evidence.value === "src/hooks/useCsvParser.ts"
    )
  );
  assert.ok(sourceTask, JSON.stringify(tasks));
  assert.match(sourceTask.text, /修改.*useCsvParser\.ts.*normalizeCsvOrder/);
});

test("a bulleted target-file owner binds nested mutation details", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# creatorName 修复计划",
      "",
      "## 关键实现改动",
      "### 1. 修复 CSV 归一化逻辑",
      "- **目标文件**：`src/hooks/useCsvParser.ts`",
      "- **改动内容**：",
      "  - 在 `normalizeCsvOrder` 中增加 `creatorName` 映射。",
      "",
      "## 验证方案",
      "- 运行 `npm test`。",
    ].join("\n"),
  }], { language: "zh" });

  const mutation = tasks.find((task) => task.executionKind === "mutation");
  assert.ok(mutation, JSON.stringify(tasks, null, 2));
  assert.equal(mutation.evidence?.[0]?.kind, "file");
  assert.equal(mutation.evidence?.[0]?.value, "src/hooks/useCsvParser.ts");
  assert.match(mutation.text, /normalizeCsvOrder.*creatorName/);
});

test("file heading owns mutation prose while referenced contract files remain evidence only", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan: 修复 MD Viewer 按钮绑定",
      "",
      "## 关键实现改动",
      "### 文件：`src/main.js`",
      "将 `initToolbar` 函数中 `actions` 对象的键从 `new-btn`、`open-btn`、`save-btn` 改为 `btn-new`、`btn-open`、`btn-save`，与 `toolbar.js` 渲染的 ID 保持一致。",
      "",
      "## 验证方案",
      "1. 运行 `npm run build` 确认构建成功。",
      "2. 运行 `npm run dev` 启动开发服务器，确认 `http://localhost:1420/` 就绪。",
      "3. 用浏览器打开页面，点击 New、Open、Save 按钮。",
    ].join("\n"),
  }], { language: "zh" });

  const mutationTasks = tasks.filter((task) => task.executionKind === "mutation");
  assert.equal(mutationTasks.length, 1, JSON.stringify(tasks));
  assert.equal(mutationTasks[0].evidence?.[0]?.value, "src/main.js");
  assert.match(mutationTasks[0].text, /btn-new/);
  assert.equal(
    tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "toolbar.js")),
    false,
    JSON.stringify(tasks),
  );
});

test("nested browser acceptance rows inherit their explicit parent interaction", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 改动范围",
      "- 修改 `src/main.js`，接入工具栏事件。",
      "",
      "## 验证方案",
      "1. 运行 `npm run build`。",
      "2. 依次点击 New、Open、Save 按钮，验证：",
      "   - New：编辑器清空，状态栏显示 new。",
      "   - Open：对话框出现，状态栏显示 open。",
      "   - Save：页面显示保存完成。",
    ].join("\n"),
  }], { language: "zh", maxTasks: 12 });

  const interactions = tasks.filter((task) =>
    task.evidence?.some((evidence) =>
      evidence.kind === "browser_dom" && evidence.requiresInteraction === true
    )
  );
  assert.equal(interactions.length, 3, JSON.stringify(tasks, null, 2));
  assert.deepEqual(
    interactions.map((task) => task.text),
    [
      "点击 New → 编辑器清空，状态栏显示 new。",
      "点击 Open → 对话框出现，状态栏显示 open。",
      "点击 Save → 页面显示保存完成。",
    ],
  );

  const required = deriveRuntimeValidationTasksFromUserRequest(
    "再通过浏览器实际点击 New 验证状态变化。",
    { language: "zh" },
  );
  const merged = mergeRuntimeValidationTaskRequirements(tasks, required);
  assert.equal(
    merged.filter((task) =>
      task.evidence?.some((evidence) => evidence.requiresInteraction === true && /New/i.test(evidence.value))
    ).length,
    1,
    JSON.stringify(merged, null, 2),
  );
  assert.equal(merged.some((task) => /^USER-VALIDATION-/.test(task.requirementRef || "")), false);
});

test("an isolated validation row cannot invent a browser click without a matching parent", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 改动范围",
      "- 修改 `src/main.js`，接入工具栏事件。",
      "",
      "## 验证方案",
      "- New：状态栏显示 new。",
      "- 点击 Open 按钮，验证：",
      "  - Save：状态栏显示 save。",
    ].join("\n"),
  }], { language: "zh", maxTasks: 12 });

  assert.equal(
    tasks.some((task) =>
      task.evidence?.some((evidence) => evidence.requiresInteraction === true) &&
      /New|Save/.test(task.text)
    ),
    false,
    JSON.stringify(tasks, null, 2),
  );
});

test("mutation heading keeps comparison files as references instead of write owners", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# 修复 MD Viewer 按钮绑定",
      "",
      "## 关键实现改动",
      "### 修改 `src/main.js` 以匹配 `src/components/toolbar.js`",
      "将 initToolbar 的按钮 ID 调整为 toolbar 渲染的 btn-new、btn-open、btn-save。",
      "",
      "## 验证方案",
      "- 运行 `npm run build`。",
    ].join("\n"),
  }], { language: "zh" });

  const mutationTasks = tasks.filter((task) => task.executionKind === "mutation");
  assert.equal(mutationTasks.length, 1, JSON.stringify(tasks));
  assert.equal(mutationTasks[0].evidence?.[0]?.value, "src/main.js");
  assert.equal(
    mutationTasks.some((task) => task.evidence?.some((item) =>
      item.kind === "file" && item.value === "src/components/toolbar.js"
    )),
    false,
    JSON.stringify(tasks),
  );
});

test("runtime plan task derivation carries an affected-file bullet into a nested concrete-change section", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 关键实现改动",
      "### 受影响文件",
      "- `src/hooks/useCsvParser.ts`",
      "",
      "### 具体改动",
      "1. **修改 `normalizeCsvOrder` 函数的返回值**：",
      "   - 将 `creator` 改为 `creatorName`。",
      "",
      "## 测试方案",
      "- 验证返回对象包含 `creatorName`。",
    ].join("\n"),
  }], { language: "zh" });

  const sourceTask = tasks.find((task) =>
    task.executionKind === "mutation" &&
    task.evidence?.some((evidence) =>
      evidence.kind === "file" && evidence.value === "src/hooks/useCsvParser.ts"
    )
  );
  assert.ok(sourceTask, JSON.stringify(tasks));
  assert.match(sourceTask.text, /normalizeCsvOrder/);
});

test("runtime plan task derivation inherits implementation context for nested file headings", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 实现改动",
      "### 文件: `src/hooks/useCsvParser.ts`",
      "**当前代码:** 返回对象只有 `creator`。",
      "**修改后:** 添加 `creatorName` 并保留现有 CSV 取值逻辑。",
      "",
      "## 验证方式",
      "1. 修改后返回对象包含 `creatorName`。",
    ].join("\n"),
  }], { language: "zh" });

  assert.equal(
    tasks.some((task) => task.evidence?.some((evidence) =>
      evidence.kind === "file" && evidence.value === "src/hooks/useCsvParser.ts"
    )),
    true,
    JSON.stringify(tasks),
  );
  assert.equal(
    tasks.some((task) => task.evidence?.some((evidence) => evidence.kind === "cmd")),
    false,
    JSON.stringify(tasks),
  );
});

test("runtime plan task derivation does not promote integration validation references to source mutations", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 实现方案",
      "修改 `src/hooks/useCsvParser.ts`：",
      "1. 更新 `CsvOrder` 接口，将 `creator` 字段重命名为 `creatorName`。",
      "2. 更新 `normalizeCsvOrder`，将返回值中的 `creator` 改为 `creatorName`。",
      "",
      "## 验证方案",
      "1. **静态检查**：确认返回对象包含 `creatorName` 字段。",
      "2. **逻辑验证**：确认 `creatorName` 来源于 CSV 的 `creator` 列。",
      "3. **集成验证**：确保 `src/store/dashboardStore.ts` 通过 `creatorField` 访问时能获取 creator 名称。",
    ].join("\n"),
  }], { language: "zh" });

  assert.equal(
    tasks.some((task) => task.evidence?.some((evidence) =>
      evidence.kind === "file" && evidence.value === "src/store/dashboardStore.ts"
    )),
    false,
    JSON.stringify(tasks),
  );
  assert.equal(
    tasks.some((task) => task.evidence?.some((evidence) =>
      evidence.kind === "file" && evidence.value === "src/hooks/useCsvParser.ts"
    )),
    true,
    JSON.stringify(tasks),
  );
  assert.equal(
    tasks.some((task) => /集成验证/.test(task.text) && task.evidence?.some((evidence) => evidence.kind === "cmd")),
    false,
  );
});

test("runtime plan task derivation turns outcome bullets under validation headings into executable checks", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 具体实现",
      "- 修改 `src/hooks/useCsvParser.ts`，增加 `creatorName` 映射。",
      "",
      "## 验证方式",
      "1. 修改后 `normalizeCsvOrder` 返回的对象同时包含 `creator` 和 `creatorName`。",
      "2. `creatorName` 的值与 CSV `creator` 列保持一致。",
    ].join("\n"),
  }], { language: "zh" });

  assert.equal(
    tasks.some((task) => task.evidence?.some((evidence) =>
      evidence.kind === "file" && evidence.value === "src/hooks/useCsvParser.ts"
    )),
    true,
    JSON.stringify(tasks),
  );
  assert.equal(
    tasks.some((task) => /验证：修改后/.test(task.text) && task.evidence?.some((evidence) => evidence.kind === "cmd")),
    false,
    JSON.stringify(tasks),
  );
});

test("runtime plan task derivation excludes files explicitly marked as unchanged", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 关键实现改动",
      "- 修改 `src/hooks/useCsvParser.ts`，添加 `creatorName` 映射。",
      "- `src/types/order.ts`：无需修改，接口已包含 `creatorName`。",
      "- `src/store/dashboardStore.ts`: no changes are required.",
      "- Do not modify `src/components/Dashboard/CourseBarChart.tsx`; leave it unchanged.",
      "",
      "## 验证方式",
      "- 验证返回对象包含 `creatorName`。",
    ].join("\n"),
  }], { language: "zh" });

  const mutationFiles = tasks.flatMap((task) => task.evidence || [])
    .filter((evidence) => evidence.kind === "file")
    .map((evidence) => evidence.value);
  assert.deepEqual(mutationFiles, ["src/hooks/useCsvParser.ts"], JSON.stringify(tasks));
});

test("runtime plan projection does not promote unchanged headings or output filenames to write targets", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 改动范围",
      "### 1. `src/components/toolbar.js` — 无改动",
      "按钮 ID 保持不变。",
      "",
      "### 2. `src/main.js` — 核心修改",
      "- 修复按钮 ID 并实现保存功能。",
      "- 创建临时 `<a>` 元素触发下载，文件名默认为 `document.md`。",
      "",
      "## 验证方案",
      "- 运行 `npm run build`。",
    ].join("\n"),
  }], { language: "zh" });

  const mutationFiles = tasks
    .filter((task) => task.executionKind === "mutation")
    .flatMap((task) => task.evidence || [])
    .filter((evidence) => evidence.kind === "file")
    .map((evidence) => evidence.value);
  assert.deepEqual(mutationFiles, ["src/main.js", "src/main.js"], JSON.stringify(tasks));
  assert.equal(
    new Set(tasks.filter((task) => task.executionKind === "mutation").map((task) => task.id)).size,
    2,
  );
  assert.equal(mutationFiles.includes("src/components/toolbar.js"), false);
  assert.equal(mutationFiles.includes("document.md"), false);
});

test("mutation evidence requires a direct file owner in equivalent English prose", () => {
  const directOwner = inferPlanTaskEvidence("Modify the source file `src/main.js` to bind the toolbar actions.");
  const outputLiteral = inferPlanTaskEvidence(
    "Create a temporary anchor to trigger a download, using `document.md` as the default output filename.",
  );

  assert.equal(
    directOwner.some((evidence) => evidence.kind === "file" && evidence.value === "src/main.js"),
    true,
  );
  assert.equal(outputLiteral.some((evidence) => evidence.kind === "file"), false);
});

test("runtime plan task derivation ignores status findings and tech-stack bullets", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "design",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# Plan",
        "",
        "## 当前状态发现",
        "- 项目基于 Tauri + React + TypeScript + Ant Plan + ECharts。",
        "- ExecutionCapsule 当前显示任务 7/8，但实际还在修复 1.1。",
        "",
        "## 执行顺序",
        "- 修改 src/components/ExecutionCapsule.tsx 的任务进度来源。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.equal(tasks.some((task) => /项目基于/.test(task.text)), false);
  assert.equal(tasks.some((task) => /ExecutionCapsule 当前显示任务/.test(task.text)), false);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].evidence?.[0]?.value, "src/components/ExecutionCapsule.tsx");
});

test("runtime plan task derivation skips approved-plan diagnostic read loops", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "design",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# Plan",
        "",
        "## 执行顺序",
        "- 数据解析/映射错误：`src/hooks/useCsvParser.ts` 解析出的字段名与 Store/组件预期的字段名不匹配。",
        "- 深度检查解析逻辑：读取 `src/hooks/useCsvParser.ts` 和 `src/store/dashboardStore.ts` 相关文件，确认字段映射关系。",
        "- 修复 `src/hooks/useCsvParser.ts` 的字段映射，并同步更新 `src/types/order.ts`。",
        "- 运行 `npm run build` 验证修复。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.equal(tasks.some((task) => /深度检查|读取/.test(task.text)), false);
  assert.equal(tasks.some((task) => /负责|字段名与 Store/.test(task.text)), false);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/hooks/useCsvParser.ts")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value.includes("npm run build"))), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.value === "src/store/dashboardStore.ts")), false);
});

test("runtime plan task derivation does not treat '完整实现' in a read sentence as a mutation task", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# 计划",
        "",
        "## 关键改动",
        "- 修改 `src-tauri/src/main.rs`，接入文件打开事件。",
        "",
        "## 测试方案",
        "- 需要读取 `src/main.js` 中 `openFile` 函数的完整实现以确认 dialog 调用细节。",
        "- 运行 `cargo check` 验证 Rust 编译。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.equal(tasks.some((task) => /需要读取|完整实现/.test(task.text)), false);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.value === "src-tauri/src/main.rs")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value === "cargo check")), true);
});

test("runtime plan task derivation does not turn code identifiers into shell command tasks", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# Plan",
        "",
        "## Public APIs / Interfaces / Types",
        "- `tauri::command]`",
        "- `tauri::Window, path: String`",
        "- `tauri::Builder::default(`",
        "- `tauri::generate_handler![`",
        "- `tauri::webview::WebviewWindowBuilder::new(`",
        "- `tauri::WebviewUrl::App(`",
        "",
        "## 执行步骤",
        "- 修改 src-tauri/src/main.rs，修复 Tauri window path 处理。",
        "- 运行 `cargo check` 验证 Rust 编译。",
      ].join("\n"),
    },
  ], { language: "zh" });

  const commandTasks = tasks.filter((task) => task.evidence?.some((item) => item.kind === "cmd"));
  assert.deepEqual(commandTasks.map((task) => task.commands?.[0]), ["cargo check"]);
  assert.equal(tasks.some((task) => /tauri::/.test(task.text)), false);
});

test("runtime task inference treats source mutations with render wording as file evidence", () => {
  const parsed = extractPlanTasks(
    "- [ ] Store 安全更新：在 `dashboardStore` 中增加数据写入前的校验逻辑，防止非法数据进入状态池导致后续渲染崩溃。",
  );

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].evidence?.[0]?.kind, "file");
  assert.equal(parsed[0].evidence?.[0]?.value, "src/store/dashboardStore.ts");
  assert.notEqual(parsed[0].evidenceStatus, "requires_browser_validation");

  const reconciled = reconcilePlanTaskCompletion([], parsed, []);
  assert.equal(reconciled[0].evidenceStatus, "missing");
  assert.equal(isPlanTaskAwaitingBrowserValidation(reconciled[0]), false);
});

test("runtime task derivation keeps browser evidence for real UI validation tasks", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# Proposed Plan",
        "",
        "## 关键实现改动",
        "- **Store 安全更新**：在 `dashboardStore` 中增加数据写入前的校验逻辑，防止非法数据进入状态池导致后续渲染崩溃。",
        "",
        "## 测试方案",
        "- **数据同步闭环验证**：验证导入 → Store 更新 → 面板 UI 刷新 → 数据内容正确性的全链路。",
        "- **视觉回归测试**：在深色/浅色模式下分别对比所有面板组件的背景色、文字颜色是否符合预期。",
      ].join("\n"),
    },
  ], { language: "zh" });
  const storeTask = tasks.find((task) => /Store 安全更新/.test(task.text));
  const syncTask = tasks.find((task) => /数据同步闭环验证/.test(task.text));
  const visualTask = tasks.find((task) => /视觉回归测试/.test(task.text));

  assert.equal(storeTask?.evidence?.[0]?.kind, "file");
  assert.equal(storeTask?.evidence?.[0]?.value, "src/store/dashboardStore.ts");
  assert.equal(syncTask?.evidence?.[0]?.kind, "browser_dom");
  assert.equal(visualTask?.evidence?.[0]?.kind, "browser_dom");
});

test("interactive control outcomes use browser evidence instead of a synthetic command", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 测试方案",
      "- 验证：点击 \"New\" 按钮，底部状态区域应显示 \"new\"。",
      "- Verify: click the Open button and the status should display open.",
    ].join("\n"),
  }], { language: "zh" });

  assert.equal(tasks.length, 2, JSON.stringify(tasks));
  for (const task of tasks) {
    assert.equal(task.evidence?.some((item) => item.kind === "browser_dom"), true, JSON.stringify(task));
    assert.equal(task.evidence?.some((item) => item.requiresInteraction === true), true, JSON.stringify(task));
    assert.equal(task.evidence?.some((item) => item.kind === "cmd"), false, JSON.stringify(task));
  }
});

test("named UI actions with observable post-state infer browser interaction without selectors or control nouns", () => {
  const assertions = [
    inferPlanTaskEvidence("实际点击 New 并检查编辑器内容清空、状态栏变为 new。"),
    inferPlanTaskEvidence("Click New, then assert the editor content is empty and status changes to new."),
    inferPlanTaskEvidence("切换 Theme → 页面主题更新为 dark。"),
  ];

  for (const [index, evidence] of assertions.entries()) {
    const browser = evidence.find((item) => item.kind === "browser_dom");
    assert.ok(browser, `${index}:${JSON.stringify(evidence)}`);
    assert.equal(browser.requiresInteraction, true, `${index}:${JSON.stringify(evidence)}`);
    assert.equal(evidence.some((item) => item.kind === "cmd"), false, `${index}:${JSON.stringify(evidence)}`);
  }
});

test("runtime Plan projection preserves a selector-free click and state assertion as browser validation", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 关键实现改动",
      "- 修改 `src/main.js`，修复工具栏事件绑定。",
      "",
      "## 验证方案",
      "1. 运行 `npm run build`。",
      "2. 运行 `npm run dev`。",
      "3. 实际点击 New 并检查编辑器内容清空、状态栏变为 new。",
    ].join("\n"),
  }], { language: "zh" });

  const clickTask = tasks.find((task) => /点击 New/.test(task.text));
  assert.ok(clickTask, JSON.stringify(tasks));
  assert.equal(clickTask.validationCapability, "browser_dom", JSON.stringify(clickTask));
  assert.equal(clickTask.evidence?.some((item) =>
    item.kind === "browser_dom" && item.requiresInteraction === true
  ), true, JSON.stringify(clickTask));
  assert.equal(clickTask.evidence?.some((item) => item.kind === "cmd"), false, JSON.stringify(clickTask));
});

test("explicit user-owned and native-dialog interactions remain external review", () => {
  const manual = inferPlanTaskEvidence(
    "请用户手动点击 Save 并确认状态变化。",
  );
  const nativeDialog = inferPlanTaskEvidence(
    "请用户手动点击 Open 并确认系统文件对话框出现。",
  );

  assert.deepEqual(manual.map((item) => item.kind), ["manual_user_validation"]);
  assert.equal(nativeDialog.some((item) => item.kind === "manual_user_validation"), true);
  assert.equal(nativeDialog.some((item) => item.kind === "tauri_required"), true);
  assert.equal(nativeDialog.some((item) => item.kind === "browser_dom"), false);
});

test("terminal keypress assertions do not become browser interactions", () => {
  const evidence = inferPlanTaskEvidence(
    "在终端按下 Enter 并检查命令退出码是否为 0。",
  );

  assert.equal(evidence.some((item) => item.kind === "browser_dom"), false);
  assert.equal(evidence.some((item) => item.kind === "cmd"), false);
});

test("explicit DOM selectors infer browser evidence in both languages", () => {
  const assertions = [
    inferPlanTaskEvidence("验证 `#status` 区域分别显示 `new`、`open`、`save`。"),
    inferPlanTaskEvidence("Verify that `#status` displays `new`, `open`, and `save` respectively."),
    inferPlanTaskEvidence("检查 `document.getElementById('status')` 显示当前操作结果。"),
    inferPlanTaskEvidence("Check that `document.querySelector('[data-status]')` displays the current result."),
  ];

  for (const [index, evidence] of assertions.entries()) {
    assert.equal(evidence.some((item) => item.kind === "browser_dom"), true, `${index}:${JSON.stringify(evidence)}`);
    assert.equal(evidence.some((item) => item.kind === "cmd"), false, `${index}:${JSON.stringify(evidence)}`);
  }
  assert.match(assertions[0][0]?.value || "", /#status/);
  assert.match(assertions[1][0]?.value || "", /#status/);
});

test("selector assertions retain existing interaction requirements", () => {
  const zh = inferPlanTaskEvidence(
    "点击各工具栏按钮后，验证 `#status` 的 `textContent` 显示对应状态。",
  );
  const en = inferPlanTaskEvidence(
    "Click each toolbar button, then verify that `#status` textContent displays the corresponding state.",
  );

  for (const evidence of [zh, en]) {
    const browser = evidence.find((item) => item.kind === "browser_dom");
    assert.ok(browser, JSON.stringify(evidence));
    assert.equal(browser.requiresInteraction, true, JSON.stringify(evidence));
  }
});

test("explicit build and test commands remain command evidence when DOM inference is available", () => {
  const build = inferPlanTaskEvidence("运行 `npm run build` 并检查构建结果。", ["npm run build"]);
  const testCommand = inferPlanTaskEvidence(
    "Run `node --test tests/node/workflow-models.test.mjs` and check the exit code.",
    ["node --test tests/node/workflow-models.test.mjs"],
  );

  assert.deepEqual(build, [{ kind: "cmd", value: "npm run build", inferred: true }]);
  assert.deepEqual(testCommand, [{
    kind: "cmd",
    value: "node --test tests/node/workflow-models.test.mjs",
    inferred: true,
  }]);
});

test("runtime task derivation keeps diagnosis and impact facts out of the approved mutation scope", () => {
  const plan = [
    "# Proposed Plan",
    "",
    "## 目标",
    "修复 `src/hooks/useCsvParser.ts` 中的 `normalizeCsvOrder`，使 CSV `creator` 正确映射到 Dashboard 使用的 `creatorName`。",
    "",
    "## 问题诊断",
    "1. **CSV 文件结构**：表头为 `creator,amount`。",
    "- **目标类型定义**：`src/types/order.ts` 定义 `Order` 包含 `creatorName: string`。",
    "- **当前实现缺陷**：`normalizeCsvOrder` 只设置 `creator`，缺少 `creatorName`。",
    "- **Store 配置**：`src/store/dashboardStore.ts` 导出 `creatorField = 'creatorName'`，确认 Dashboard 使用 `creatorName` 作为字段名。",
    "",
    "## 实现改动",
    "**修改文件**：`src/hooks/useCsvParser.ts`",
    "",
    "**改动内容**：在 `normalizeCsvOrder` 返回对象中添加 `creatorName`，值来自 `row.creator` 或 `row['创建者']`。",
    "",
    "## 影响范围",
    "- **仅修改 1 个文件**：`src/hooks/useCsvParser.ts`。",
    "- **接口兼容性**：`CsvOrder` 已声明 `creatorName?: string`，无需修改接口。",
    "- **下游消费**：Dashboard 通过 `creatorName` 读取数据，修改后将正确获取值。",
    "",
    "## 验证方案",
    "1. **静态检查**：修改后运行 TypeScript 编译检查，确保无类型错误。",
    "- **功能验证**：",
    "  - 解析 CSV 文件 `cn_tutorial_orders_by_creator_20260512.csv`。",
    "  - 检查解析后的 `Order` 对象是否包含 `creatorName: 'alice'`。",
    "  - 确认 Dashboard 组件能正确渲染 creator 数据。",
    "",
    "## 假设与默认值",
    "- CSV 中 `creator` 始终存在。",
    "- 不修改其他文件（`src/types/order.ts`、`src/store/dashboardStore.ts`）。",
    "",
    "## 验收标准",
    "- `normalizeCsvOrder` 返回的对象同时包含 `creator` 和 `creatorName`。",
    "- `creatorName` 的值与 `creator` 一致。",
    "- TypeScript 编译通过。",
    "- Dashboard 能正确显示 creator 名称。",
  ].join("\n");
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: plan,
  }], { language: "zh" });

  const fileTargets = Array.from(new Set(tasks.flatMap((task) =>
    (task.evidence || []).filter((item) => item.kind === "file").map((item) => item.value)
  )));
  assert.deepEqual(fileTargets, ["src/hooks/useCsvParser.ts"]);
  assert.equal(tasks.some((task) => /Store 配置/.test(task.text)), false);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "cmd")), false);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "browser_dom")), true);

  const mutation = createPlanExecutionEvidenceEntry({
    toolName: "apply_patch",
    target: "src/hooks/useCsvParser.ts",
    result: JSON.stringify({ success: true }),
    diff: {
      old: "return { creator: row.creator };",
      new: "return { creator: row.creator, creatorName: row.creator };",
      path: "src/hooks/useCsvParser.ts",
    },
  });
  const finiteCommand = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npx tsc --noEmit",
    result: JSON.stringify({ exitCode: 0, stdout: "" }),
  });
  const browser = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:5173/dashboard creator render",
    result: JSON.stringify({ ok: true, assertions: [{ passed: true }] }),
  });
  const audit = buildPlanTaskEvidenceAudit({
    tasks,
    evidenceLedger: [mutation, finiteCommand, browser].filter(Boolean),
  });

  assert.equal(audit.allTrustedComplete, true, JSON.stringify(audit));
});

test("runtime task derivation inherits nested mutation headings and excludes themed diagnosis descendants", () => {
  const plan = [
    "# 修复白屏问题计划",
    "",
    "## 白屏问题诊断",
    "",
    "### 观察到的现象",
    "1. `src/main.js` 第 24 行：`document.addEventListener('DOMContentLoaded', () => {` — 这是唯一入口点",
    "2. `src/main.js` 的 `init()` 内部没有 try-catch。",
    "",
    "### 根因分析",
    "- 任意初始化错误都会导致白屏。",
    "",
    "## 改动方案",
    "",
    "### 1. 修改 `src/main.js` — 添加错误处理",
    "- 在 DOMContentLoaded 回调内部包裹 try-catch。",
    "- 在初始化失败时显示清晰错误信息。",
    "",
    "### 2. 验证步骤",
    "1. 运行 `npm run dev` 启动开发服务器。",
    "2. 访问 `http://localhost:1420` 检查页面是否正常渲染。",
  ].join("\n");

  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: plan,
  }], { language: "zh" });

  const mutationTasks = tasks.filter(isPlanTaskSourceMutationObligation);
  assert.equal(mutationTasks.length, 1, JSON.stringify(tasks));
  assert.equal(mutationTasks[0].evidence?.[0]?.value, "src/main.js");
  assert.match(mutationTasks[0].text, /修改 src\/main\.js/);
  assert.equal(tasks.some((task) => /唯一入口点|观察到的现象/.test(task.text)), false);
  assert.equal(
    isRuntimeTaskActionableText("`document.addEventListener('DOMContentLoaded', handler)` 是唯一入口点"),
    false,
  );
  assert.equal(
    isRuntimeTaskActionableText("`updateState` is the current state handler"),
    false,
  );
});

test("combined diagnosis and fix headings retain mutation descendants without leaking diagnostic tables", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# 修复计划",
      "",
      "## 问题诊断与修复方案",
      "### 诊断证据",
      "| 文件 | 操作 | 说明 |",
      "| --- | --- | --- |",
      "| `src/diagnostic.js` | 修改 | 添加 listener 是当前行为，不是待执行任务 |",
      "",
      "### 修改 `src/main.js`",
      "- 添加初始化错误处理。",
      "",
      "## 测试方案",
      "- 运行 `npm test`。",
    ].join("\n"),
  }], { language: "zh" });

  assert.equal(tasks.some((task) =>
    task.executionKind === "mutation" &&
    task.evidence?.some((entry) => entry.kind === "file" && entry.value === "src/main.js")
  ), true, JSON.stringify(tasks));
  assert.equal(tasks.some((task) =>
    task.evidence?.some((entry) => entry.value === "src/diagnostic.js")
  ), false, JSON.stringify(tasks));
  assert.equal(tasks.some((task) =>
    task.executionKind === "validation" &&
    task.evidence?.some((entry) => entry.kind === "cmd" && entry.value === "npm test")
  ), true, JSON.stringify(tasks));
});

test("validation provenance cannot activate source-edit-first from mutation words in check text", () => {
  assert.equal(isPlanTaskSourceMutationObligation({
    id: "validate-fix",
    text: "运行 npm test 验证 src/main.js 修复",
    status: "pending",
    commands: ["npm test"],
    evidence: [
      { kind: "cmd", value: "npm test" },
      { kind: "file", value: "src/main.js" },
    ],
  }), false);
  assert.equal(isPlanTaskSourceMutationObligation({
    id: "typed-validation",
    text: "检查 src/main.js 修复结果",
    status: "pending",
    executionKind: "validation",
    evidence: [{ kind: "file", value: "src/main.js" }],
  }), false);
});

test("a composite source edit and validation step keeps its mutation obligation", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Fix plan",
      "",
      "## Key Changes",
      "- Modify `src/main.js` to catch initialization failures, then run `npm test`.",
    ].join("\n"),
  }], { language: "en" });

  const mutationTask = tasks.find(isPlanTaskSourceMutationObligation);
  const validationTask = tasks.find((task) => task.executionKind === "validation");
  assert.ok(mutationTask, JSON.stringify(tasks));
  assert.ok(validationTask, JSON.stringify(tasks));
  assert.ok(mutationTask.evidence?.some((entry) =>
    entry.kind === "file" && entry.value === "src/main.js"
  ), JSON.stringify(tasks));
  assert.ok(validationTask.evidence?.some((entry) =>
    entry.kind === "cmd" && entry.value === "npm test"
  ), JSON.stringify(tasks));

  assert.equal(isPlanTaskSourceMutationObligation({
    id: "legacy-composite",
    text: "Modify src/main.js, then run npm test",
    status: "pending",
    commands: ["npm test"],
    evidence: [
      { kind: "file", value: "src/main.js" },
      { kind: "cmd", value: "npm test" },
    ],
  }), true);

  const compositeTask = {
    id: "composite-progress",
    text: "Modify src/main.js, then run npm test",
    status: "in_progress",
    executionKind: "mutation",
    commands: ["npm test"],
    evidence: [
      { kind: "file", value: "src/main.js" },
      { kind: "cmd", value: "npm test" },
    ],
  };
  assert.equal(planTaskHasUnsatisfiedSourceMutationEvidence(compositeTask, []), true);
  assert.equal(planTaskHasUnsatisfiedSourceMutationEvidence(compositeTask, [{
    id: "source-write",
    kind: "file",
    value: "src/main.js",
    target: "src/main.js",
    sourceTool: "apply_patch",
    createdAt: 1,
  }]), false);
});

test("descriptive data-flow sections do not become phantom mutation tasks", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# State review",
      "",
      "## Data Flow",
      "- `src/store/dashboardStore.ts` updates state after import and the component reads the new snapshot.",
      "",
      "## Validation",
      "- Run `npm test`.",
    ].join("\n"),
  }], { language: "en" });

  assert.equal(tasks.some((task) =>
    task.evidence?.some((entry) => entry.value === "src/store/dashboardStore.ts")
  ), false, JSON.stringify(tasks));
  assert.equal(tasks.some(isPlanTaskSourceMutationObligation), false, JSON.stringify(tasks));
});

test("runtime plan task derivation recognizes actionable architecture-change sections", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Offline draft sync",
      "",
      "## Architecture Changes",
      "- Update `src/store/drafts.ts` to queue offline drafts for ordered replay.",
      "",
      "## Acceptance",
      "- Verify two offline drafts sync once after reconnecting.",
    ].join("\n"),
  }], { language: "en" });

  assert.equal(tasks.some((task) =>
    task.executionKind === "mutation" &&
    task.evidence?.some((evidence) => evidence.kind === "file" && evidence.value === "src/store/drafts.ts")
  ), true);
});

test("English Diagnosis sections remain evidence context instead of mutation tasks", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## Problem Diagnosis",
      "- `src/store/dashboardStore.ts` exports `creatorField`; confirm Dashboard reads `creatorName`.",
      "",
      "## Implementation Changes",
      "**File to change:** `src/hooks/useCsvParser.ts`",
      "",
      "Add `creatorName` to the normalized order object.",
      "",
      "## Validation",
      "- Verify that Dashboard displays `creatorName`.",
    ].join("\n"),
  }], { language: "en" });

  assert.deepEqual(
    Array.from(new Set(tasks.flatMap((task) =>
      (task.evidence || []).filter((item) => item.kind === "file").map((item) => item.value)
    ))),
    ["src/hooks/useCsvParser.ts"],
  );
});

test("runtime plan task derivation accepts Qwen-style file change tables", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# 修复计划：CSV 导入数据不显示、深色模式、导入界面消失",
        "",
        "## 关键实现改动",
        "### 改动 1：修复所有 ECharts 图表组件的 CSS 变量解析",
        "**涉及文件（5 个）：**",
        "- `src/components/Dashboard/TrendLineChart.tsx`",
        "- `src/components/Dashboard/CourseBarChart.tsx`",
        "- `src/components/Dashboard/MonthlyCompareChart.tsx`",
        "- `src/components/Dashboard/StatusPieChart.tsx`",
        "- `src/components/Dashboard/TimeHeatmap.tsx`",
        "",
        "**改动内容：**",
        "1. 在每个图表组件的 `useEffect` 中调用 `resolveEChartsTheme(option)`。",
        "2. 在主题切换时重新解析并更新图表。",
        "",
        "## 测试方案",
        "- 浏览器验证 CSV 导入后数据正常显示。",
        "- 浏览器验证主题切换正常。",
        "",
        "## 文件变更清单",
        "| 文件 | 改动类型 | 说明 |",
        "|------|----------|------|",
        "| `src/components/Dashboard/TrendLineChart.tsx` | 修改 | 集成 `resolveEChartsTheme`，添加主题监听 |",
        "| `src/components/Dashboard/CourseBarChart.tsx` | 修改 | 集成 `resolveEChartsTheme`，添加主题监听 |",
        "| `src/components/Dashboard/MonthlyCompareChart.tsx` | 修改 | 集成 `resolveEChartsTheme`，添加主题监听 |",
        "| `src/components/Dashboard/StatusPieChart.tsx` | 修改 | 集成 `resolveEChartsTheme`，修复饼图边框深色适配，添加主题监听 |",
        "| `src/components/Dashboard/TimeHeatmap.tsx` | 修改 | 集成 `resolveEChartsTheme`，修复热力图颜色深色适配，添加主题监听 |",
        "| `src/utils/colorUtils.ts` | 可选增强 | 如果现有 `resolveEChartsTheme()` 覆盖不足，补充更多属性匹配规则 |",
      ].join("\n"),
    },
  ], { language: "zh", maxTasks: 10 });

  for (const expectedPath of [
    "src/components/Dashboard/TrendLineChart.tsx",
    "src/components/Dashboard/CourseBarChart.tsx",
    "src/components/Dashboard/MonthlyCompareChart.tsx",
    "src/components/Dashboard/StatusPieChart.tsx",
    "src/components/Dashboard/TimeHeatmap.tsx",
  ]) {
    assert.equal(
      tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === expectedPath)),
      true,
      expectedPath,
    );
  }
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.value === "src/utils/colorUtils.ts")), false);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "browser_dom")), true);
});

test("tasks artifact parsing inherits file evidence from file section headings", () => {
  const markdown = [
    "# 任务清单",
    "",
    "## 1. 修改 TrendLineChart.tsx",
    "- [ ] 集成 `resolveEChartsTheme` 解析 CSS 变量",
    "- [ ] 添加主题切换监听",
    "",
    "## 2. 启动开发服务器并浏览器验证",
    "- [ ] 启动开发服务器",
    "- [ ] 浏览器验证 CSV 导入后数据正常显示",
  ].join("\n");
  const parsed = extractPlanTasks(markdown);

  assert.equal(validatePlanArtifactContent(markdown, "tasks").ok, true);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].evidence?.[0]?.kind, "file");
  assert.equal(parsed[0].evidence?.[0]?.value, "TrendLineChart.tsx");
  assert.equal(parsed[1].evidence?.[0]?.kind, "file");
  assert.equal(parsed[2].evidence?.[0]?.kind, "dev_server_url");
  assert.equal(parsed[3].evidence?.[0]?.kind, "browser_dom");
});

test("runtime plan task derivation parses change headings and keeps validation commands", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# Markdown Viewer 修复计划",
        "",
        "## 已确认发现",
        "- `src/diagnostics/read-only.rs` 只是本轮读取到的诊断证据，不需要修改。",
        "",
        "## 关键实现改动",
        "### 改动 1：`src-tauri/src/main.rs` — 移除 debug 条件编译",
        "**依据**：当前 release 构建会隐藏控制台，调试反馈不足。",
        "**改动**：移除 `cfg_attr` 条件编译并保留现有 Tauri 初始化。",
        "",
        "### 改动 2：`src/main.js` — 修复 `openFile()` 使用正确 dialog API",
        "**依据**：已读取到前端打开文件链路。",
        "**改动**：替换旧的 `openFile` 调用并传递用户选择的路径。",
        "",
        "### 改动 3：`src/main.js` — 替换 `fs.readFile` 为 Tauri 命令",
        "**改动**：改用后端命令读取文件内容。",
        "",
        "### 改动 4：`src-tauri/src/main.rs` — 添加 `read_file_content` 命令",
        "**改动**：新增命令并注册到 invoke handler。",
        "",
        "## 影响文件清单",
        "| 文件 | 操作 | 修改内容 |",
        "|------|------|----------|",
        "| `src-tauri/src/main.rs` | 修改 | 注册文件读取命令 |",
        "| `src/main.js` | 修改 | 调用新的后端命令 |",
        "",
        "## 测试方案",
        "| 场景 | 验证步骤 | 预期结果 |",
        "|------|----------|----------|",
        "| Debug 模式 | `npm run tauri dev` | 功能与 release 一致 |",
      ].join("\n"),
    },
  ], { language: "zh", maxTasks: 8 });

  const rustTasks = tasks.filter((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src-tauri/src/main.rs"));
  const jsTasks = tasks.filter((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/main.js"));
  const commandTask = tasks.find((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value === "npm run tauri dev"));

  assert.equal(rustTasks.length, 2, JSON.stringify(tasks, null, 2));
  assert.equal(jsTasks.length, 2, JSON.stringify(tasks, null, 2));
  assert.equal(new Set(rustTasks.map((task) => task.id)).size, 2);
  assert.equal(new Set(jsTasks.map((task) => task.id)).size, 2);
  assert.ok(commandTask);
  assert.equal(rustTasks.some((task) => /移除.*cfg_attr/u.test(task.text)), true);
  assert.equal(rustTasks.some((task) => /新增命令/u.test(task.text)), true);
  assert.equal(jsTasks.some((task) => /替换旧的/u.test(task.text)), true);
  assert.equal(jsTasks.some((task) => /改用后端命令/u.test(task.text)), true);
  assert.equal(tasks.some((task) => /依据|read-only\.rs/.test(task.text)), false);
  assert.deepEqual(
    tasks
      .flatMap((task) => task.evidence || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.value)
      .sort(),
    [
      "src-tauri/src/main.rs",
      "src-tauri/src/main.rs",
      "src/main.js",
      "src/main.js",
    ].sort(),
  );
  assert.equal(tasks.length, 5, JSON.stringify(tasks, null, 2));
});

test("runtime prose projection keeps distinct same-file mutation obligations", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 关键实现改动",
      "### 文件：`src/main.js`",
      "- 修改 `initToolbar`，绑定新的按钮 ID。",
      "- 修改 `openFile`，保留选择后的文件路径。",
      "",
      "## 验证方案",
      "- 运行 `npm run build`。",
    ].join("\n"),
  }], { language: "zh" });

  const mutations = tasks.filter((task) =>
    task.executionKind === "mutation" &&
    task.evidence?.some((item) => item.kind === "file" && item.value === "src/main.js")
  );
  assert.equal(mutations.length, 2, JSON.stringify(tasks, null, 2));
  assert.equal(new Set(mutations.map((task) => task.id)).size, 2);
  assert.equal(mutations.some((task) => /initToolbar/.test(task.text)), true);
  assert.equal(mutations.some((task) => /openFile/.test(task.text)), true);

  const mutationEvidence = createPlanExecutionEvidenceEntry({
    toolName: "apply_patch",
    target: "src/main.js",
    result: "patched initToolbar",
    diff: { old: "old", new: "new", path: "src/main.js" },
    planTaskId: mutations[0].id,
    requirementRef: mutations[0].id,
  });
  const reconciled = reconcilePlanTaskCompletion([], mutations, [mutationEvidence]);
  assert.equal(reconciled.filter((task) => task.status === "completed").length, 1);
  assert.equal(reconciled.filter((task) => task.status !== "completed").length, 1);
});

test("MD Viewer change blocks derive three mutations without promoting rationale or an empty container", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# 修复计划：打开文件功能 + 初始标签页",
      "",
      "## 关键实现改动",
      "",
      "### 改动1：修复 `handleOpenFile()` — `src/main.js`（第232-252行）",
      "**根因**：当前实现混用了后端命令与前端 dialog 插件。",
      "**修改为**：使用已导入的 `openDialog`，并沿用已有文件加载入口。",
      "",
      "### 改动2：修复初始标签页 — `src/main.js`（第126-131行）",
      "**根因**：初始化时创建 `title: '新文档'` 的标签页，编辑后会附加脏标记。",
      "**修改为**：",
      "",
      "### 改动3：清理 Rust 后端冗余代码 — `src-tauri/src/main.rs`",
      "- 移除不再使用的文件对话框命令注册。",
      "- 保留文件读取与保存命令。",
      "",
      "## 测试方案",
      "- 运行 `npm run tauri dev` 并验证桌面窗口启动成功。",
    ].join("\n"),
  }], { language: "zh" });

  const mutations = tasks.filter((task) => task.executionKind === "mutation");
  const mutationPaths = mutations.map((task) =>
    task.evidence?.find((item) => item.kind === "file")?.value
  );
  assert.deepEqual(mutationPaths, [
    "src/main.js",
    "src/main.js",
    "src-tauri/src/main.rs",
  ], JSON.stringify(tasks, null, 2));
  assert.equal(new Set(mutations.map((task) => task.id)).size, 3);
  assert.equal(mutations.filter((task) => /handleOpenFile/.test(task.text)).length, 1);
  assert.equal(mutations.filter((task) => /初始标签页/.test(task.text)).length, 1);
  assert.match(
    mutations.find((task) => task.evidence?.some((item) =>
      item.kind === "file" && item.value === "src-tauri/src/main.rs"
    ))?.text || "",
    /移除不再使用的文件对话框命令注册/,
  );
  assert.equal(mutations.some((task) => /修改为\s*[:：]\s*$/.test(task.text)), false);
});

test("plan quality rejects an implementation label that owns no concrete body", () => {
  const result = validateActionablePlanArtifact([
    "# 修复启动状态",
    "## 摘要",
    "- 目标：修复 `src/main.ts` 的初始标题。",
    "## 已确认证据",
    "- `src/main.ts` 当前创建了错误的初始状态。",
    "## 关键改动",
    "### 改动1：修复初始状态 — `src/main.ts`",
    "**根因**：初始化分支使用了错误的默认值。",
    "**修改为**：",
    "## 测试方案",
    "- 运行 `npm test` 并检查退出码。",
    "## 验收标准",
    "- 启动后标题为“欢迎”。",
  ].join("\n"));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_plan_implementation_detail");
});

test("plan quality rejects only explicit conflicting values for the same acceptance subject", () => {
  const fixtures = [[
    "# 修复启动状态",
    "## 摘要",
    "- 目标：修复 `src/main.ts` 的初始标题。",
    "## 已确认证据",
    "- `src/main.ts` 当前创建了错误的初始状态。",
    "## 关键改动",
    "- 修改 `src/main.ts`，统一初始化标题。",
    "## 测试方案",
    "- 运行 `npm test` 并检查退出码。",
    "## 验收标准",
    "- 启动后标签页标题为“欢迎”。",
    "- 启动后标签页标题为“未命名文档”。",
  ], [
    "# Repair startup state",
    "## Summary",
    "- Goal: repair the initial title in `src/main.ts`.",
    "## Confirmed Evidence",
    "- `src/main.ts` currently creates the wrong initial state.",
    "## Key Changes",
    "- Modify `src/main.ts` to use one startup title.",
    "## Test Plan",
    "- Run `npm test` and check the exit status.",
    "## Acceptance Criteria",
    "- On startup, the tab title is \"Welcome\".",
    "- On startup, the tab title is \"Untitled\".",
  ]];

  for (const lines of fixtures) {
    const result = validateActionablePlanArtifact(lines.join("\n"));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "conflicting_plan_acceptance_assertions");
  }

  const distinctScenarios = validateActionablePlanArtifact([
    "# 修复标签页状态",
    "## 摘要",
    "- 目标：修复 `src/main.ts` 的标签页标题。",
    "## 已确认证据",
    "- `src/main.ts` 同时管理启动页和新建页。",
    "## 关键改动",
    "- 修改 `src/main.ts`，分别设置两个场景的标题。",
    "## 测试方案",
    "- 运行 `npm test` 并检查退出码。",
    "## 验收标准",
    "- 启动后的标签页标题为“欢迎”。",
    "- 点击新建后的标签页标题为“未命名文档”。",
  ].join("\n"));
  assert.notEqual(distinctScenarios.reason, "conflicting_plan_acceptance_assertions");
});

test("only explicit build commands become command evidence", () => {
  const explicit = inferPlanTaskEvidence(
    "运行 `npm run build` 并检查退出码与输出。",
    ["npm run build"],
  );
  const inferred = inferPlanTaskEvidence("检查 build 输出是否成功。", []);

  assert.deepEqual(explicit, [{ kind: "cmd", value: "npm run build", inferred: true }]);
  assert.equal(inferred.some((evidence) => evidence.kind === "browser_dom"), false);
  assert.equal(inferred.some((evidence) => evidence.kind === "cmd"), false);
});

test("runtime plan projection does not duplicate an explicit build validation as browser work", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# CSV creator mapping",
      "",
      "## 目标",
      "- 修复 `src/hooks/useCsvParser.ts`，让 creator 正确映射为 creatorName。",
      "",
      "## 关键改动",
      "- 修改 `src/hooks/useCsvParser.ts`，补齐 creatorName 映射。",
      "",
      "## 测试方案",
      "- 运行 `npm run build` 并检查退出码与输出。",
    ].join("\n"),
  }], { language: "zh" });

  assert.equal(tasks.length, 2);
  assert.equal(tasks.filter((task) => task.executionKind === "mutation").length, 1);
  assert.equal(tasks.filter((task) => task.executionKind === "validation").length, 1);
  assert.equal(tasks.some((task) => task.evidence?.some((evidence) => evidence.kind === "browser_dom")), false);
  assert.equal(tasks.some((task) => task.evidence?.some((evidence) =>
    evidence.kind === "cmd" && evidence.value === "npm run build"
  )), true);
});

test("build-output follow-up bullets reuse finite command evidence instead of requiring a browser", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# CSV creator mapping",
      "",
      "## 关键改动",
      "- 修改 `src/hooks/useCsvParser.ts`，补齐 creatorName 映射。",
      "",
      "## 测试方案",
      "- 运行 `npm run build`。",
      "- 确认构建输出显示成功。",
    ].join("\n"),
  }], { language: "zh" });
  const ledger = [
    {
      id: "source-edit",
      kind: "file",
      value: "src/hooks/useCsvParser.ts",
      target: "src/hooks/useCsvParser.ts",
      sourceTool: "replace_in_file",
      createdAt: 1,
      diff: "@@ -1 +1 @@\n-old\n+creatorName: creator",
      changedIdentifiers: ["creatorName"],
    },
    {
      id: "build-success",
      kind: "cmd",
      value: "npm run build",
      target: "npm run build",
      sourceTool: "run_command",
      createdAt: 2,
      outcome: "succeeded",
    },
  ];
  const audit = buildPlanTaskEvidenceAudit({ tasks, evidenceLedger: ledger });

  assert.equal(tasks.some((task) => task.evidence?.some((evidence) => evidence.kind === "browser_dom")), false);
  assert.equal(audit.allTrustedComplete, true);
});

test("shell command extraction covers common validation runners", () => {
  assert.deepEqual(
    extractShellCommandsFromText("运行 `pytest -q`、`mvn test`、`swift test`、`./gradlew test` 和 `corepack pnpm test`。"),
    ["pytest -q", "mvn test", "swift test", "./gradlew test", "corepack pnpm test"],
  );
});

test("runtime plan task derivation accepts affected-file tables without promoting read-only rows", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# 修复计划",
        "",
        "## 影响文件清单",
        "| 文件 | 操作 | 修改内容 |",
        "|------|------|----------|",
        "| `src-tauri/src/main.rs` | 修改 | 添加 `read_file_content` 命令 |",
        "| `src/main.js` | 修改 | 替换文件读取调用 |",
        "| `src/diagnostics/read-only.rs` | 读取 | 修复前的诊断证据，不执行修改 |",
        "",
        "## 验证标准",
        "- 运行 `npm run tauri dev`。",
      ].join("\n"),
    },
  ], { language: "zh", maxTasks: 4 });

  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src-tauri/src/main.rs")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/main.js")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.value === "src/diagnostics/read-only.rs")), false);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value === "npm run tauri dev")), true);
});

test("runtime plan task derivation accepts Codex-style key changes", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# 计划",
        "",
        "## 摘要",
        "- 用户目标：修复批准后执行回合过早完成的问题。",
        "",
        "## 关键改动",
        "- 更新 `src/lib/orchestrator.ts`，让 read-only strategy switch 追加恢复提示后继续下一轮执行。",
        "- 更新 `src/lib/workflowModels.ts`，让 Plan.md 质量门接受 Codex-style 章节。",
        "",
        "## 公共 API / 接口 / 类型",
        "- 无公共 API、接口或类型变化。",
        "",
        "## 测试方案",
        "- 运行 `node --test tests/node/workflow-models.test.mjs`。",
        "",
        "## 假设与默认值",
        "- 默认不修改 ChatArea 新样式。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/lib/orchestrator.ts")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/lib/workflowModels.ts")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value.includes("workflow-models"))), true);
});

test("runtime plan task derivation skips goals and diagnosis from OMLX plan prose", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# Proposed Plan",
        "",
        "## 用户目标",
        "- 请修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。先生成可审批计划，批准后真实修改并验证。",
        "",
        "## 问题分析",
        "- 数据源差异：`src/hooks/useCsvParser.ts` 中的 `normalizeCsvOrder` 函数目前仅将 CSV 中的 `creator` 字段映射到了 `creator` 属性上。",
        "",
        "## 关键实现改动",
        "- 修改 `src/hooks/useCsvParser.ts`:",
        "  - 更新 `normalizeCsvOrder` 函数。",
        "  - 在返回的 `CsvOrder` 对象中，将 `creator` 的值同步赋值给 `creatorName`。",
        "",
        "## 测试方案",
        "- 运行 `node --test tests/node/workflow-models.test.mjs`。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.equal(tasks.some((task) => /请修复|用户目标|数据源差异|目前仅将/.test(task.text)), false);
  assert.equal(tasks.some((task) => /修改.*useCsvParser\.ts/.test(task.text)), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/hooks/useCsvParser.ts")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value.includes("workflow-models"))), true);
});

test("runtime plan task derivation does not promote an evidence preamble into a second mutation", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "根据证据，问题根因是 normalizeCsvOrder 返回了 creator 字段。",
      "",
      "**证据归因：**",
      "- `src/types/order.ts` 定义 `Order` 接口使用 `creatorName: string`",
      "- `src/store/dashboardStore.ts` 导出 `creatorField = 'creatorName'`，Dashboard 按此字段聚合",
      "- `src/hooks/useCsvParser.ts` 的 `normalizeCsvOrder` 返回 `{ creator: ... }`，字段名不匹配",
      "",
      "# Proposed Plan",
      "",
      "## 改动范围",
      "**唯一修改文件：** `src/hooks/useCsvParser.ts`",
      "",
      "### 具体改动",
      "- 修改 `normalizeCsvOrder`，让返回对象写入 `creatorName`。",
      "",
      "## 验证方式",
      "1. 修改后 TypeScript 编译通过（无类型错误）",
      "2. 确认 Dashboard 聚合逻辑能正确读取该字段",
    ].join("\n"),
  }], { language: "zh" });

  const mutationTasks = tasks.filter((task) => task.executionKind === "mutation");
  assert.equal(mutationTasks.length, 1, JSON.stringify(tasks));
  assert.equal(mutationTasks[0].evidence?.some((item) =>
    item.kind === "file" && item.value === "src/hooks/useCsvParser.ts"
  ), true);
  assert.equal(tasks.some((task) => task.executionKind === "mutation" && task.evidence?.some((item) =>
    item.kind === "file" && item.value === "src/store/dashboardStore.ts"
  )), false);
});

test("runtime plan projection ignores rejected alternatives before the canonical plan", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "## 修复方案",
      "1. 修改 `src/components/toolbar.js` 与现有监听器对齐。",
      "2. 修改 `src/main.js` 与现有按钮对齐。",
      "推荐方案 1。",
      "",
      "# Proposed Plan",
      "",
      "## 关键实现改动",
      "### 1. 修改 `src/components/toolbar.js`",
      "统一 New、Open、Save 的按钮 ID。",
      "",
      "### 2. 无需修改 `src/main.js`",
      "现有事件绑定保持不变。",
      "",
      "## 测试方案",
      "- 运行 `npm run build`。",
    ].join("\n"),
  }], { language: "zh" });

  const mutationFiles = tasks
    .filter((task) => task.executionKind === "mutation")
    .flatMap((task) => task.evidence || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.value);
  assert.deepEqual(mutationFiles, ["src/components/toolbar.js"], JSON.stringify(tasks));
});

test("runtime plan task derivation resolves a unique short path to the reviewed mutation", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## 关键实现改动",
      "",
      "### 1. 修改 `src/components/toolbar.js`",
      "将按钮 ID 与事件监听器保持一致。",
      "",
      "### 2. 无需修改 `src/main.js`",
      "`main.js` 中的事件已正确定义，只需修正 `toolbar.js` 的 ID 即可。",
      "",
      "## 测试方案",
      "- 运行 `npm run build`。",
    ].join("\n"),
  }], { language: "zh" });

  const mutationTasks = tasks.filter((task) => task.executionKind === "mutation");
  assert.equal(mutationTasks.length, 1, JSON.stringify(tasks));
  assert.equal(mutationTasks[0].evidence?.some((item) =>
    item.kind === "file" && item.value === "src/components/toolbar.js"
  ), true);
});

test("runtime plan projection canonicalizes short execution targets from qualified affected files", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## Execution Steps",
      "1. 修改 `toolbar.js`：统一按钮 ID。",
      "2. 修改 `main.js`：完善事件处理。",
      "3. 运行 `npm run build`。",
      "",
      "## Affected Files",
      "- `src/components/toolbar.js`：修改按钮 ID",
      "- `src/main.js`：完善按钮事件处理逻辑",
    ].join("\n"),
  }], { language: "zh" });

  const mutationPaths = tasks
    .filter((task) => task.executionKind === "mutation")
    .flatMap((task) => task.evidence || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.value);
  assert.deepEqual(new Set(mutationPaths), new Set([
    "src/components/toolbar.js",
    "src/main.js",
  ]), JSON.stringify(tasks));
  assert.equal(mutationPaths.includes("toolbar.js"), false);
  assert.equal(mutationPaths.includes("main.js"), false);

  const toolbarScope = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "replace_in_file",
    args: { path: "src/components/toolbar.js" },
    target: "src/components/toolbar.js",
    tasks,
  });
  assert.equal(toolbarScope.allowed, true, JSON.stringify(toolbarScope));
});

test("runtime plan task derivation does not collapse an ambiguous basename", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# Proposed Plan",
      "",
      "## Key Changes",
      "",
      "### Modify `src/client/config.ts`",
      "Update the browser defaults.",
      "",
      "### Modify `src/server/config.ts`",
      "Update the server defaults.",
      "",
      "- Modify `config.ts` after confirming which runtime owns the fallback.",
    ].join("\n"),
  }], { language: "en" });

  const mutationFiles = tasks
    .filter((task) => task.executionKind === "mutation")
    .flatMap((task) => task.evidence || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.value);
  assert.equal(mutationFiles.includes("src/client/config.ts"), true, JSON.stringify(tasks));
  assert.equal(mutationFiles.includes("src/server/config.ts"), true, JSON.stringify(tasks));
  assert.equal(mutationFiles.includes("config.ts"), true, JSON.stringify(tasks));
});

test("runtime plan task derivation skips malformed markdown table rows", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# 计划",
        "",
        "## 关键改动",
        "- | 取舍点 | 选择 | 理由 |",
        "- |--------|------|------|",
        "- | 深色模式方案 | 使用 CSS 变量 + 主题切换 | 可维护性好，支持动态切换 |",
        "- | 数据修复范围 | 先修复数据绑定，再优化 UI | 核心问题是数据不显示 |",
        "- 更新 `src/store/dashboardStore.ts`，修复导入数据后的统计来源。",
        "- 更新 `src/App.tsx`，补齐深色模式 token。",
        "",
        "## 测试方案",
        "- 运行 `npm run build`。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.equal(tasks.some((task) => /数据修复范围|深色模式方案|取舍点/.test(task.text)), false);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/store/dashboardStore.ts")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/App.tsx")), true);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value.includes("npm run build"))), true);
});

test("runtime plan task derivation requires concrete evidence instead of synthetic tool fallback", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "design",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: "# Plan\n\n## 执行顺序\n- 完成核心功能实现。\n- 验证实现结果是否可用。",
    },
  ], { language: "zh" });

  assert.deepEqual(tasks, []);
});

test("runtime plan task derivation does not create generic tasks from file references only", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# 计划",
        "",
        "## 摘要",
        "- 用户目标：修复 CSV 导入。",
        "- 定向证据已覆盖：`src/hooks/useCsvParser.ts`、`cn_tutorial_orders_by_creator_20260512.csv`。",
        "",
        "## 已读证据",
        "- `src/hooks/useCsvParser.ts` 负责解析。",
        "- `cn_tutorial_orders_by_creator_20260512.csv` 是样例数据。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.deepEqual(tasks, []);
});

test("generic workspace_write and project_change evidence do not complete unrelated tasks", () => {
  const parsed = [
    {
      id: "runtime-generic-write",
      text: "完成核心功能实现",
      status: "pending",
      claimedStatus: "pending",
      evidence: [{ kind: "tool", value: "workspace_write", inferred: true }],
      evidenceStatus: "missing",
    },
    {
      id: "runtime-generic-project",
      text: "落实项目改动",
      status: "pending",
      claimedStatus: "pending",
      evidence: [{ kind: "tool", value: "project_change", inferred: true }],
      evidenceStatus: "missing",
    },
  ];
  const writeEvidence = createPlanExecutionEvidenceEntry({
    toolName: "replace_in_file",
    target: "src/App.tsx",
    result: JSON.stringify({ success: true }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, writeEvidence ? [writeEvidence] : []);

  assert.equal(reconciled.every((task) => !isPlanTaskTrustedComplete(task)), true);
  assert.equal(buildPlanTaskEvidenceAudit({ tasks: reconciled }).acceptedCompletion, false);
});

test("approved mutation task requires the planned identifier in the fresh diff", () => {
  const parsed = extractPlanTasks(
    "- [ ] 修改 `src/hooks/useCsvParser.ts`，将 `creator` 映射为 `creatorName`，同时保留 legacy `creator` fallback。",
  );
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].evidence?.[0]?.requiredTerms, ["creatorName"]);

  const unrelatedWrite = createPlanExecutionEvidenceEntry({
    toolName: "write_file",
    target: "src/hooks/useCsvParser.ts",
    result: JSON.stringify({ success: true }),
    diff: {
      old: "return { creator: row.creator };",
      new: "return { creator: row.creator, status: row.status };",
      path: "src/hooks/useCsvParser.ts",
      fullFile: true,
    },
  });
  const plannedWrite = createPlanExecutionEvidenceEntry({
    toolName: "write_file",
    target: "src/hooks/useCsvParser.ts",
    result: JSON.stringify({ success: true }),
    diff: {
      old: "return { creator: row.creator };",
      new: "return { creatorName: row.creatorName ?? row.creator, creator: row.creator };",
      path: "src/hooks/useCsvParser.ts",
      fullFile: true,
    },
  });

  const unrelatedAudit = buildPlanTaskEvidenceAudit({
    tasks: parsed,
    evidenceLedger: unrelatedWrite ? [unrelatedWrite] : [],
  });
  const plannedAudit = buildPlanTaskEvidenceAudit({
    tasks: parsed,
    evidenceLedger: plannedWrite ? [plannedWrite] : [],
  });

  assert.equal(unrelatedAudit.allTrustedComplete, false);
  assert.equal(plannedAudit.allTrustedComplete, true);
  assert.equal(plannedWrite?.changedIdentifiers?.includes("creatorName"), true);
});

test("same-path mutation does not complete when a declared call target is absent from the fresh diff", () => {
  const parsed = extractPlanTasks(
    "- [ ] 修改 `src/main.js` 中的 `handleOpenFile`，确保调用 `renderMarkdown` 更新编辑区。",
  );
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].evidence?.[0]?.requiredTerms, ["renderMarkdown"]);

  const unrelatedWrite = createPlanExecutionEvidenceEntry({
    toolName: "replace_in_file",
    target: "src/main.js",
    result: JSON.stringify({ success: true }),
    diff: {
      old: "document.title = 'Old';",
      new: "document.title = 'New';",
      path: "src/main.js",
    },
  });
  const expectedWrite = createPlanExecutionEvidenceEntry({
    toolName: "replace_in_file",
    target: "src/main.js",
    result: JSON.stringify({ success: true }),
    diff: {
      old: "editor.value = content;",
      new: "editor.value = content;\nrenderMarkdown(content);",
      path: "src/main.js",
    },
  });

  assert.equal(buildPlanTaskEvidenceAudit({
    tasks: parsed,
    evidenceLedger: unrelatedWrite ? [unrelatedWrite] : [],
  }).allTrustedComplete, false);
  assert.equal(buildPlanTaskEvidenceAudit({
    tasks: parsed,
    evidenceLedger: expectedWrite ? [expectedWrite] : [],
  }).allTrustedComplete, true);
});

test("mutation location identifiers are not required in fresh changed lines", () => {
  const parsed = extractPlanTasks(
    "- [ ] 仅修改 `src/hooks/useCsvParser.ts` 中的 `normalizeCsvOrder` 函数。",
  );
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].evidence?.[0]?.requiredTerms || [], []);

  const writeEvidence = createPlanExecutionEvidenceEntry({
    toolName: "replace_in_file",
    target: "src/hooks/useCsvParser.ts",
    result: JSON.stringify({ success: true }),
    diff: {
      old: "    creator: row.creator || '',",
      new: "    creator: row.creator || '',\n    creatorName: row.creator || '',",
      path: "src/hooks/useCsvParser.ts",
    },
  });
  const audit = buildPlanTaskEvidenceAudit({
    tasks: parsed,
    evidenceLedger: writeEvidence ? [writeEvidence] : [],
  });

  assert.equal(audit.allTrustedComplete, true);
});

test("approved Plan blocks workspace mutations outside the reviewed task targets", () => {
  const tasks = extractPlanTasks(
    "- [ ] 修改 `src/hooks/useCsvParser.ts`，将 `creator` 映射为 `creatorName`。",
  );
  const allowed = resolveApprovedPlanMutationScope({
    workflowMode: "edit",
    isPlanApproved: true,
    toolName: "write_file",
    args: { path: "src/hooks/useCsvParser.ts" },
    target: "src/hooks/useCsvParser.ts",
    tasks,
  });
  const blocked = resolveApprovedPlanMutationScope({
    workflowMode: "edit",
    isPlanApproved: true,
    toolName: "apply_patch",
    args: { patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch" },
    target: "src/App.tsx",
    tasks,
  });

  assert.equal(allowed.allowed, true);
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.unexpectedTargets, ["src/app.tsx"]);

  const moveOutsideScope = resolveApprovedPlanMutationScope({
    workflowMode: "edit",
    isPlanApproved: true,
    toolName: "apply_patch",
    args: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/hooks/useCsvParser.ts",
        "*** Move to: src/unreviewed/useCsvParser.ts",
        "*** End Patch",
      ].join("\n"),
    },
    target: "src/hooks/useCsvParser.ts",
    tasks,
  });
  assert.equal(moveOutsideScope.allowed, false);
  assert.deepEqual(moveOutsideScope.requestedTargets, [
    "src/hooks/usecsvparser.ts",
    "src/unreviewed/usecsvparser.ts",
  ]);
  assert.deepEqual(moveOutsideScope.unexpectedTargets, ["src/unreviewed/usecsvparser.ts"]);
});

test("approved Plan executes only exactly reviewed shell commands", () => {
  const tasks = extractPlanTasks([
    "- [ ] 修改 `src/main.js` 修复初始化顺序。",
    "- [ ] 运行 `npm test` 验证。",
  ].join("\n"));
  const allowed = resolveApprovedPlanCommandScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "run_command",
    args: { command: "npm test" },
    tasks,
  });
  const readOnly = resolveApprovedPlanCommandScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "run_command",
    args: { command: "git status" },
    tasks,
  });
  const blocked = resolveApprovedPlanCommandScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "execute_command",
    args: { command: "npm test; touch src/unplanned.ts" },
    tasks,
  });

  assert.equal(allowed.allowed, true);
  assert.equal(readOnly.allowed, false);
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.plannedCommands, ["npm test"]);
  for (const command of [
    "find src -delete",
    "git diff --output=src/unplanned.patch",
    "sort input.txt -o src/unplanned.ts",
  ]) {
    assert.equal(resolveApprovedPlanCommandScope({
      workflowMode: "plan",
      isPlanApproved: true,
      toolName: "run_command",
      args: { command },
      tasks,
    }).allowed, false, command);
  }
});

test("approved Plan scope conflict identity is based on revision and targets, not mutation tool", () => {
  const tasks = extractPlanTasks("- [ ] 修改 `src/main.js` 修复初始化顺序。");
  const writeConflict = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "write_file",
    args: { path: "src/components/toolbar.js" },
    target: "src/components/toolbar.js",
    tasks,
  });
  const patchConflict = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "apply_patch",
    args: {
      patch: "*** Begin Patch\n*** Update File: src/components/toolbar.js\n@@\n-old\n+new\n*** End Patch",
    },
    target: "src/components/toolbar.js",
    tasks,
  });

  assert.equal(writeConflict.allowed, false);
  assert.equal(patchConflict.allowed, false);
  assert.equal(
    buildApprovedPlanScopeConflictFingerprint({
      planRevision: 2,
      unexpectedTargets: writeConflict.unexpectedTargets,
      plannedTargets: writeConflict.plannedTargets,
    }),
    buildApprovedPlanScopeConflictFingerprint({
      planRevision: 2,
      unexpectedTargets: patchConflict.unexpectedTargets,
      plannedTargets: patchConflict.plannedTargets,
    }),
  );
});

test("approved Plan applies the same target scope to MCP edits and deletes", () => {
  const tasks = extractPlanTasks(
    "- [ ] 修改 `Assets/Scripts/Foo.cs` 添加启动保护。",
  );
  const allowedMcp = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "script_apply_edits",
    args: { path: "Assets/Scripts", name: "Foo" },
    target: "Assets/Scripts/Foo.cs",
    tasks,
  });
  const blockedMcp = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "script_apply_edits",
    args: { path: "Assets/Scripts", name: "Other" },
    target: "Assets/Scripts/Other.cs",
    tasks,
  });
  const blockedDelete = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "delete_workspace_path",
    args: { path: "Assets/Scripts/Other.cs" },
    target: "Assets/Scripts/Other.cs",
    tasks,
  });
  const inspectOnly = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "manage_script",
    args: { action: "inspect", path: "Assets/Scripts", name: "Foo" },
    target: "manage_script",
    tasks,
  });

  assert.equal(allowedMcp.allowed, true);
  assert.equal(blockedMcp.allowed, false);
  assert.equal(blockedDelete.allowed, false);
  assert.equal(inspectOnly.applies, false);
});

test("approved Plan scope never treats a nested source path as its shorter relative suffix", () => {
  const tasks = extractPlanTasks(
    "- [ ] 修改 src-tauri/src/main.rs 的 macOS 文件打开事件。",
  );
  const truncated = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "replace_in_file",
    args: { path: "src/main.rs" },
    target: "src/main.rs",
    tasks,
  });
  const absoluteExact = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "replace_in_file",
    args: { path: "/Users/example/MD Viewer/src-tauri/src/main.rs" },
    target: "/Users/example/MD Viewer/src-tauri/src/main.rs",
    tasks,
  });
  const exploratoryRead = resolveApprovedPlanMutationScope({
    workflowMode: "plan",
    isPlanApproved: true,
    toolName: "read_file",
    args: { path: "src/main.js" },
    target: "src/main.js",
    tasks,
  });

  assert.equal(truncated.allowed, false);
  assert.deepEqual(truncated.unexpectedTargets, ["src/main.rs"]);
  assert.equal(absoluteExact.allowed, true);
  assert.equal(exploratoryRead.applies, false);
  assert.equal(exploratoryRead.allowed, true);
});

test("read-only shell commands do not satisfy file evidence", () => {
  const parsed = extractPlanTasks("- [x] 在 Rust 后端新增 GitFileEntry 结构体 — 证据: file:src-tauri/src/lib.rs");
  const readOnlyCommand = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "sed -n '1690,1700p' /Users/michael/Documents/GitHub/MAIN/src-tauri/src/lib.rs",
    result: JSON.stringify({ exitCode: 0, stdout: "fn git_push_current_branch() {}" }),
  });
  const writeEvidence = createPlanExecutionEvidenceEntry({
    toolName: "replace_in_file",
    target: "src-tauri/src/lib.rs",
    result: JSON.stringify({ success: true }),
  });
  const afterReadOnly = reconcilePlanTaskCompletion([], parsed, readOnlyCommand ? [readOnlyCommand] : []);
  const afterWrite = reconcilePlanTaskCompletion([], parsed, writeEvidence ? [writeEvidence] : []);

  assert.equal(readOnlyCommand?.kind, "cmd");
  assert.equal(isPlanTaskTrustedComplete(afterReadOnly[0]), false);
  assert.equal(isPlanTaskTrustedComplete(afterWrite[0]), true);
});

test("plan audit rejects completion claims when trusted evidence is incomplete", () => {
  const parsed = extractPlanTasks([
    "- [x] 修改 src/App.tsx 空状态 — 证据: file:src/App.tsx",
    "- [x] 新增 src/lib/e2e.ts 场景 — 证据: file:src/lib/e2e.ts",
    "- [x] 运行 `npx tsc --noEmit` — 证据: cmd:npx tsc --noEmit",
  ].join("\n"));
  const audit = buildPlanTaskEvidenceAudit({
    tasks: parsed,
    evidenceLedger: [{
      id: "evidence-app",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "replace_in_file",
      createdAt: 1,
    }],
    highlightNext: true,
  });

  assert.equal(audit.completedCount, 1);
  assert.equal(audit.totalCount, 3);
  assert.equal(audit.acceptedCompletion, false);
  assert.equal(audit.remainingTasks.length, 2);
  assert.match(audit.blockedReasons.join("\n"), /src\/lib\/e2e\.ts/);
});

test("command evidence matches successful commands with cd wrappers and redirection", () => {
  const parsed = extractPlanTasks("- [x] 运行 TypeScript 检查 `npx tsc --noEmit` — 证据: cmd:npx tsc --noEmit");
  const command = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "cd /Users/michael/Documents/GitHub/MAIN && npx tsc --noEmit 2>&1",
    result: JSON.stringify({ exitCode: 0, stdout: "" }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, command ? [command] : []);

  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), true);
});

test("command evidence still satisfies explicit cmd tasks", () => {
  const parsed = extractPlanTasks("- [x] 验证当前 git 状态 `git status` — 证据: cmd:git status");
  const command = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "git status",
    result: JSON.stringify({ exitCode: 0, stdout: "On branch main" }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, command ? [command] : []);

  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), true);
});

test("manual markdown render validation requires browser evidence, not curl reachability", () => {
  const parsed = extractPlanTasks("- [x] 手动测试：打开 test-sample.md，验证所有 Markdown 元素渲染正确");
  const curlEvidence = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "curl -s http://localhost:1421 | head -30",
    result: JSON.stringify({ exitCode: 0, stdout: "<!DOCTYPE html>" }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, curlEvidence ? [curlEvidence] : []);
  const audit = buildPlanTaskEvidenceAudit({ tasks: reconciled });

  assert.equal(parsed[0].evidence?.[0]?.kind, "browser_dom");
  assert.equal(reconciled[0].evidenceStatus, "requires_browser_validation");
  assert.equal(isPlanTaskAwaitingBrowserValidation(reconciled[0]), true);
  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), false);
  assert.equal(audit.acceptedCompletion, false);
  assert.equal(audit.automationComplete, false);
  assert.equal(audit.allTrustedComplete, false);
  assert.equal(audit.pendingExternalValidation, true);
  assert.equal(audit.remainingTasks.length, 1);
});

test("browser or Playwright evidence satisfies browser render validation", () => {
  const parsed = extractPlanTasks("- [x] 手动测试：打开 test-sample.md，验证所有 Markdown 元素渲染正确");
  const browserEvidence = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1421 markdown render smoke",
    result: JSON.stringify({ ok: true, assertions: ["h1", "table", "mermaid"] }),
  });
  const playwrightCommand = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npx playwright test tests/e2e/markdown-render.spec.ts",
    result: JSON.stringify({ exitCode: 0, stdout: "1 passed" }),
  });
  const browserReconciled = reconcilePlanTaskCompletion([], parsed, browserEvidence ? [browserEvidence] : []);
  const commandReconciled = reconcilePlanTaskCompletion([], parsed, playwrightCommand ? [playwrightCommand] : []);

  assert.equal(browserEvidence?.kind, "browser_dom");
  assert.equal(isPlanTaskTrustedComplete(browserReconciled[0]), true);
  assert.equal(isPlanTaskTrustedComplete(commandReconciled[0]), true);
});

function browserInteractionTask(name) {
  return {
    id: `browser-${name.toLowerCase()}`,
    text: `Control ${name} expects state ${name.toLowerCase()}`,
    status: "pending",
    executionKind: "validation",
    evidence: [{
      kind: "browser_dom",
      value: "browser DOM validation",
      requiresInteraction: true,
    }],
  };
}

function browserInteractionResult(names) {
  return JSON.stringify({
    ok: true,
    actions: names.map((name, index) => ({
      id: `action-${index + 1}`,
      kind: "click",
      value: `#${name.toLowerCase()}-trigger`,
      ok: true,
      stateChanged: true,
      effectStateChanged: true,
      effectChangedFields: ["bodyText", "externalDomFingerprint"],
    })),
    assertions: names.map((name, index) => ({
      kind: "text",
      value: `[data-state="${name.toLowerCase()}"]`,
      passed: true,
      beforePassed: false,
      changedAfterAction: true,
      causallyLinked: true,
      afterActionId: `action-${index + 1}`,
    })),
    pageErrors: [],
    consoleErrors: [],
  });
}

test("a reviewed browser interaction subsumes the same durable user-request obligation", () => {
  const reviewed = extractPlanTasks(
    "- [ ] 使用浏览器工具实际点击 `#new-btn`，随后检查状态栏变为 new。",
  );
  const durable = deriveRuntimeValidationTasksFromUserRequest(
    "通过浏览器实际点击 New，并检查状态栏变为 new。",
    { language: "zh" },
  );
  const merged = mergeRuntimeValidationTaskRequirements(reviewed, durable);

  assert.equal(reviewed.length, 1);
  assert.equal(durable.length, 1);
  assert.equal(merged.length, 1, JSON.stringify(merged, null, 2));
  assert.equal(/^USER-VALIDATION-/.test(merged[0].requirementRef || ""), false);
});

test("punctuation-separated action and post-state form a structured browser contract", () => {
  const [task] = extractPlanTasks(
    '- [ ] 验证：点击 New 按钮，状态栏显示 "new"。',
  );

  assert.equal(task.evidence?.[0]?.requiresInteraction, true);
  assert.match(task.evidence?.[0]?.value || "", /^browser interaction:\s*New 按钮$/i);
});

test("browser requirement coalescing keeps different controls and literal outcomes distinct", () => {
  const reviewedOpen = extractPlanTasks(
    '- [ ] 点击 Open 按钮，状态栏显示 "open"。',
  );
  const requiredNew = deriveRuntimeValidationTasksFromUserRequest(
    '实际点击 New，并检查状态栏变为 "new"。',
    { language: "zh" },
  );
  const mergedControls = mergeRuntimeValidationTaskRequirements(reviewedOpen, requiredNew);
  assert.equal(mergedControls.length, 2);

  const reviewedWrongOutcome = extractPlanTasks(
    '- [ ] 点击 New 按钮，状态栏显示 "draft"。',
  );
  const mergedOutcomes = mergeRuntimeValidationTaskRequirements(reviewedWrongOutcome, requiredNew);
  assert.equal(mergedOutcomes.length, 2);

  const reviewedDifferentSubject = extractPlanTasks(
    '- [ ] 点击 New 按钮，状态栏显示 "new"。',
  );
  const requiredEditorClear = deriveRuntimeValidationTasksFromUserRequest(
    "实际点击 New，并检查编辑器内容清空。",
    { language: "zh" },
  );
  assert.equal(
    mergeRuntimeValidationTaskRequirements(reviewedDifferentSubject, requiredEditorClear).length,
    2,
  );
});

test("English coordinated action and post-state coalesce into one browser obligation", () => {
  const reviewed = extractPlanTasks(
    "- [ ] Verify: click the Open button and the status should display open.",
  );
  const required = deriveRuntimeValidationTasksFromUserRequest(
    "Actually click Open and verify the status displays open.",
    { language: "en" },
  );

  assert.match(reviewed[0].evidence?.[0]?.value || "", /^browser interaction:\s*the Open button$/i);
  assert.equal(mergeRuntimeValidationTaskRequirements(reviewed, required).length, 1);
});

test("browser proof matches action and assertion roles independently", () => {
  const tasks = extractPlanTasks([
    "- [ ] Click Toggle, then verify status displays new.",
    "- [ ] Click New, then verify status displays toggled.",
  ].join("\n"));
  const evidence = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: browserInteractionResult(["New"]),
  });
  const reconciled = reconcilePlanTaskCompletion([], tasks, evidence ? [evidence] : []);

  assert.deepEqual(reconciled.map((task) => task.evidenceStatus), [
    "requires_browser_validation",
    "satisfied",
  ]);
});

test("one structured browser result distributes distinct proof units across matching Plan tasks", () => {
  const tasks = ["New", "Open", "Save"].map(browserInteractionTask);
  const evidence = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: browserInteractionResult(["New", "Open", "Save"]),
    // A stale recovery owner must not hide the other independently proven
    // interactions in the same browser envelope.
    planTaskId: "mutation-task",
    requirementRef: "mutation-task",
  });
  const reconciled = reconcilePlanTaskCompletion([], tasks, evidence ? [evidence] : []);

  assert.deepEqual(reconciled.map((task) => task.evidenceStatus), [
    "satisfied",
    "satisfied",
    "satisfied",
  ]);
  assert.equal(reconciled.every(isPlanTaskTrustedComplete), true);
});

test("three independent browser calls satisfy their matching Plan tasks despite stale evidence owners", () => {
  const tasks = ["New", "Open", "Save"].map(browserInteractionTask);
  const evidence = ["New", "Open", "Save"].map((name) => createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: browserInteractionResult([name]),
    // Runtime recovery may still carry the previous mutation owner. Exact
    // structured interaction proof must win over that stale advisory owner.
    planTaskId: "stale-mutation-task",
    requirementRef: "stale-mutation-task",
  })).filter(Boolean);
  const reconciled = reconcilePlanTaskCompletion([], tasks, evidence);

  assert.deepEqual(reconciled.map((task) => task.evidenceStatus), [
    "satisfied",
    "satisfied",
    "satisfied",
  ]);
  assert.equal(reconciled.every(isPlanTaskTrustedComplete), true);
});

test("browser interaction proof is parsed from the exact result rather than a truncated display payload", () => {
  const task = browserInteractionTask("New");
  const rawResult = JSON.stringify({
    ...JSON.parse(browserInteractionResult(["New"])),
    textPreview: "rendered content ".repeat(1_000),
  });
  const displayResult = `${rawResult.slice(0, 10_000)}\n...[truncated]`;
  const displayEvidence = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: displayResult,
  });
  const exactEvidence = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: rawResult,
  });

  const displayReconciled = reconcilePlanTaskCompletion(
    [],
    [task],
    displayEvidence ? [displayEvidence] : [],
  );
  const exactReconciled = reconcilePlanTaskCompletion(
    [],
    [task],
    exactEvidence ? [exactEvidence] : [],
  );

  assert.equal(displayEvidence?.browserInteraction, undefined);
  assert.equal(displayReconciled[0].evidenceStatus, "requires_browser_validation");
  assert.ok(exactEvidence?.browserInteraction);
  assert.equal(exactReconciled[0].evidenceStatus, "satisfied");
});

test("a browser proof unit is not reused for a different interaction task", () => {
  const tasks = ["New", "Open", "Save"].map(browserInteractionTask);
  const evidence = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: browserInteractionResult(["New"]),
    planTaskId: "mutation-task",
  });
  const reconciled = reconcilePlanTaskCompletion([], tasks, evidence ? [evidence] : []);

  assert.deepEqual(reconciled.map((task) => task.evidenceStatus), [
    "satisfied",
    "requires_browser_validation",
    "requires_browser_validation",
  ]);
});

test("page load and unrelated browser actions cannot satisfy an interaction Plan task", () => {
  const task = browserInteractionTask("New");
  const pageLoad = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: JSON.stringify({ ok: true, actions: [], assertions: [] }),
    planTaskId: task.id,
  });
  const unrelated = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: browserInteractionResult(["Archive"]),
    planTaskId: task.id,
  });

  const afterPageLoad = reconcilePlanTaskCompletion([], [task], pageLoad ? [pageLoad] : []);
  const afterUnrelatedAction = reconcilePlanTaskCompletion([], [task], unrelated ? [unrelated] : []);
  assert.equal(afterPageLoad[0].evidenceStatus, "requires_browser_validation");
  assert.equal(afterUnrelatedAction[0].evidenceStatus, "requires_browser_validation");
});

test("failed browser validation does not satisfy browser render evidence", () => {
  const parsed = extractPlanTasks("- [x] 手动测试：打开 test-sample.md，验证所有 Markdown 元素渲染正确");
  const failedBrowserEvidence = createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1421 markdown render smoke",
    result: JSON.stringify({
      ok: false,
      assertions: [{ kind: "selector", value: ".preview h1", passed: false }],
    }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, failedBrowserEvidence ? [failedBrowserEvidence] : []);

  assert.equal(failedBrowserEvidence?.observationStatus, "failed");
  assert.equal(failedBrowserEvidence?.browserInteraction?.assertions?.[0]?.passed, false);
  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), false);
  assert.equal(isPlanTaskAwaitingBrowserValidation(reconciled[0]), true);
});

test("Tauri runtime validation pauses as user/external validation instead of curl substitute", () => {
  const parsed = extractPlanTasks("- [x] 验证 Tauri open_file 文件选择器可以打开 test-sample.md");
  const viteEvidence = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "curl -s http://localhost:1421",
    result: JSON.stringify({ exitCode: 0, stdout: "<!DOCTYPE html>" }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, viteEvidence ? [viteEvidence] : []);
  const audit = buildPlanTaskEvidenceAudit({ tasks: reconciled });

  assert.equal(parsed[0].evidence?.[0]?.kind, "tauri_required");
  assert.equal(reconciled[0].evidenceStatus, "requires_tauri_validation");
  assert.equal(isPlanTaskAwaitingExternalValidation(reconciled[0]), true);
  assert.equal(audit.acceptedCompletion, true);
  assert.equal(audit.automationComplete, true);
  assert.equal(audit.allTrustedComplete, false);
  assert.equal(audit.pendingExternalValidation, true);
  assert.equal(audit.remainingTasks.length, 0);
  assert.equal(audit.pendingUserValidationTasks.length, 1);
});

test("unstructured desktop output cannot satisfy tauri automation evidence", () => {
  const parsed = extractPlanTasks(
    "- [ ] 在实际 Tauri 桌面窗口中验证打开文件行为。 （证据：tauri_required:desktop runtime interaction）",
  );
  const screenshotOnly = createPlanExecutionEvidenceEntry({
    toolName: "computer_use",
    target: "desktop runtime interaction",
    result: "opened screenshot without a verified interaction",
  });
  const structuredDesktop = createPlanExecutionEvidenceEntry({
    toolName: "tauri_driver",
    target: "desktop runtime interaction",
    result: JSON.stringify({
      ok: true,
      actions: [{ kind: "click", target: "open", ok: true }],
      assertions: [{ kind: "dialog", target: "file picker", passed: true }],
    }),
  });
  const unverified = reconcilePlanTaskCompletion(
    [],
    parsed,
    screenshotOnly ? [screenshotOnly] : [],
  );
  const verified = reconcilePlanTaskCompletion(
    [],
    parsed,
    structuredDesktop ? [structuredDesktop] : [],
  );
  const unverifiedAudit = buildPlanTaskEvidenceAudit({ tasks: unverified });

  assert.equal(screenshotOnly?.automaticValidation, undefined);
  assert.equal(isPlanTaskTrustedComplete(unverified[0]), false);
  assert.equal(unverified[0].evidenceStatus, "requires_tauri_validation");
  assert.equal(unverifiedAudit.pendingUserValidationTasks.length, 1);
  assert.equal(structuredDesktop?.automaticValidation, true);
  assert.equal(isPlanTaskTrustedComplete(verified[0]), true);
});

test("computer_use requires a real interaction and causal post-state before satisfying desktop evidence", () => {
  const parsed = extractPlanTasks(
    "- [ ] 在实际 Tauri 桌面窗口中验证打开文件行为。 （证据：tauri_required:desktop runtime interaction）",
  );
  const preExistingAssertion = createPlanExecutionEvidenceEntry({
    toolName: "computer_use",
    target: "MAIN",
    result: JSON.stringify({
      ok: true,
      actions: [{ kind: "click", target: "Open", ok: true, interaction: true }],
      assertions: [{ kind: "text", target: "Open", passed: true, beforePassed: true, causallyLinked: false }],
    }),
  });
  const causalInteraction = createPlanExecutionEvidenceEntry({
    toolName: "computer_use",
    target: "MAIN",
    result: JSON.stringify({
      ok: true,
      actions: [{ kind: "click", target: "Open", ok: true, interaction: true }],
      assertions: [{ kind: "dialog", target: "visible", passed: true, beforePassed: false, causallyLinked: true }],
    }),
  });

  assert.equal(preExistingAssertion?.automaticValidation, undefined);
  assert.equal(causalInteraction?.automaticValidation, true);
  assert.equal(isPlanTaskTrustedComplete(reconcilePlanTaskCompletion([], parsed, [preExistingAssertion])[0]), false);
  assert.equal(isPlanTaskTrustedComplete(reconcilePlanTaskCompletion([], parsed, [causalInteraction])[0]), true);
});

test("long-running desktop startup requires execute_command plus a later PTY observation before completion", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: [
        "# 计划",
        "",
        "## 关键改动",
        "- 修改 `src-tauri/src/main.rs` 的启动初始化。",
        "",
        "## 测试方案",
        "- 使用 `execute_command` 启动 `npm run tauri dev`，随后读取 PTY 启动输出。 （证据：cmd:npm run tauri dev）",
        "- 在实际 Tauri 桌面窗口中验证打开文件行为。 （证据：tauri_required:desktop runtime interaction）",
      ].join("\n"),
    },
  ], { language: "zh", maxTasks: 8 });
  const startupTask = tasks.find((task) => task.evidence?.some((item) =>
    item.kind === "cmd" && item.value === "npm run tauri dev"
  ));
  const externalTask = tasks.find((task) => task.evidence?.some((item) =>
    item.kind === "tauri_required"
  ));

  assert.ok(startupTask, JSON.stringify(tasks, null, 2));
  assert.ok(externalTask, JSON.stringify(tasks, null, 2));

  const bareViteDispatch = createPlanExecutionEvidenceEntry({
    toolName: "execute_command",
    target: "vite --host 127.0.0.1 --port 1420",
    result: JSON.stringify({
      command: "vite --host 127.0.0.1 --port 1420",
      output: "command accepted",
      foregroundGeneration: 3,
    }),
  });
  assert.equal(bareViteDispatch?.observationStatus, "pending");
  assert.equal(bareViteDispatch?.foregroundGeneration, 3);
  assert.equal(bareViteDispatch?.devServerPort, 1420);

  const dispatched = createPlanExecutionEvidenceEntry({
    toolName: "execute_command",
    target: "npm run tauri dev",
    result: JSON.stringify({
      command: "npm run tauri dev",
      output: "Compiling md-viewer...",
      startOffset: 12,
      endOffset: 48,
    }),
  });
  const beforeObservation = reconcilePlanTaskCompletion([], tasks, dispatched ? [dispatched] : []);
  const pendingStartup = beforeObservation.find((task) => task.id === startupTask.id);
  assert.equal(isPlanTaskTrustedComplete(pendingStartup), false);
  assert.match(pendingStartup?.blockedReason || "", /PTY/);

  const stillStarting = createPlanExecutionEvidenceEntry({
    toolName: "read_pty_since",
    target: "terminal @ 48",
    result: JSON.stringify({
      text: "Waiting for your frontend dev server to start on http://localhost:1420/",
      startOffset: 48,
      endOffset: 72,
      running: true,
    }),
  });
  const whileStarting = reconcilePlanTaskCompletion(
    [],
    tasks,
    [dispatched, stillStarting].filter(Boolean),
  );
  assert.equal(
    isPlanTaskTrustedComplete(whileStarting.find((task) => task.id === startupTask.id)),
    false,
  );

  const observed = createPlanExecutionEvidenceEntry({
    toolName: "read_pty_since",
    target: "terminal @ 72",
    result: JSON.stringify({
      text: "VITE v7.0.4 ready in 812 ms\nLocal: http://localhost:1420/",
      startOffset: 72,
      endOffset: 108,
      running: true,
    }),
  });
  const wrongDispatch = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm run tauri dev",
    result: JSON.stringify({ exitCode: 0, stdout: "unexpected one-shot result" }),
  });
  const afterWrongTool = reconcilePlanTaskCompletion(
    [],
    tasks,
    [wrongDispatch, observed].filter(Boolean),
  );
  assert.equal(
    isPlanTaskTrustedComplete(afterWrongTool.find((task) => task.id === startupTask.id)),
    false,
  );
  const afterObservation = reconcilePlanTaskCompletion(
    [],
    tasks,
    [dispatched, observed].filter(Boolean),
  );
  const completedStartup = afterObservation.find((task) => task.id === startupTask.id);
  const pendingDesktopValidation = afterObservation.find((task) => task.id === externalTask.id);
  const audit = buildPlanTaskEvidenceAudit({ tasks: afterObservation });

  assert.equal(isPlanTaskTrustedComplete(completedStartup), true);
  assert.equal(pendingDesktopValidation?.evidenceStatus, "requires_tauri_validation");
  assert.equal(audit.pendingExternalValidation, true);
  assert.equal(audit.allTrustedComplete, false);

  const restarted = {
    ...dispatched,
    id: "restart",
    createdAt: Number(observed?.createdAt || 0) + 1,
    observationStatus: "pending",
  };
  const afterRestart = reconcilePlanTaskCompletion(
    [],
    tasks,
    [dispatched, observed, restarted].filter(Boolean),
  );
  assert.equal(
    isPlanTaskTrustedComplete(afterRestart.find((task) => task.id === startupTask.id)),
    false,
    "a later restart must invalidate readiness from an older process",
  );

  const failed = {
    ...stillStarting,
    id: "failed-observation",
    createdAt: restarted.createdAt + 1,
    observationStatus: "failed",
  };
  const afterFailure = reconcilePlanTaskCompletion(
    [],
    tasks,
    [dispatched, observed, restarted, failed].filter(Boolean),
  );
  const failedStartup = afterFailure.find((task) => task.id === startupTask.id);
  assert.equal(failedStartup?.evidenceStatus, "blocked");
  assert.match(failedStartup?.blockedReason || "", /启动失败/);
});

test("negated validation alternatives are not materialized as shell commands", () => {
  const text = "此项保留待 Tauri 运行时确认，不能用 cargo check、构建或 curl 代替。";
  assert.deepEqual(extractShellCommandsFromText(text), []);

  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    updatedAt: 1,
    content: [
      "# 计划",
      "## 验证",
      `- ${text} （证据：tauri_required:desktop runtime interaction）`,
    ].join("\n"),
  }], { language: "zh" });
  assert.equal(tasks.some((task) => task.commands?.some((command) => /cargo check/.test(command))), false);
  assert.equal(tasks.some((task) => task.evidence?.some((item) => item.kind === "tauri_required")), true);
});

test("test or build alternatives without a concrete command do not create command evidence", () => {
  const parsed = extractPlanTasks("- [x] 运行受影响子系统的聚焦测试、构建检查或浏览器/桌面验证，并记录结果。");
  const commandEvidence = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm test -- --passWithNoTests",
    result: JSON.stringify({ exitCode: 0, stdout: "tests passed" }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, commandEvidence ? [commandEvidence] : []);

  assert.equal(parsed[0].evidence?.some((item) => item.kind === "cmd"), false);
  assert.equal(parsed[0].evidence?.some((item) => item.kind === "tauri_required"), true);
  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), false);
  assert.equal(isPlanTaskAwaitingExternalValidation(reconciled[0]), true);
});

test("bounded inline runtime assertions count as finite Plan validation", () => {
  assert.equal(isFinitePlanValidationCommand(
    "node -e \"const value = 1; if (value !== 1) process.exit(1)\"",
  ), true);
  assert.equal(isFinitePlanValidationCommand(
    "python3 -c \"assert 1 == 1\"",
  ), true);
  assert.equal(isFinitePlanValidationCommand(
    "npx ts-node --eval \"console.log('ok')\"",
  ), true);
  assert.equal(isFinitePlanValidationCommand("npm run dev"), false);
  assert.equal(isFinitePlanValidationCommand("node src/server.js"), false);

  const command = "node -e \"if (!'creatorName') process.exit(1)\"";
  const parsed = extractPlanTasks(
    `- [ ] 逻辑验证：运行 \`${command}\`。`,
  );
  const plannedCommand = parsed[0].evidence?.[0]?.value || "";
  const commandEvidence = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: plannedCommand,
    result: JSON.stringify({ exitCode: 0, stdout: "inline assertion passed" }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, commandEvidence ? [commandEvidence] : []);

  assert.equal(parsed[0].evidence?.[0]?.kind, "cmd");
  assert.match(plannedCommand, /^node -e /);
  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), true);
});

test("test build or manual alternatives do not accept an unplanned command", () => {
  const parsed = extractPlanTasks("- [x] 运行与受影响范围匹配的测试、构建或人工检查，并记录结果后才视为执行完成。");
  const commandEvidence = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npx tsc --noEmit",
    result: JSON.stringify({ exitCode: 0, stdout: "typecheck passed" }),
  });
  const reconciled = reconcilePlanTaskCompletion([], parsed, commandEvidence ? [commandEvidence] : []);

  assert.equal(parsed.some((task) => task.evidence?.some((item) => item.kind === "cmd")), false);
  assert.equal(reconciled.some(isPlanTaskTrustedComplete), false);
});

test("semantic confirmation prose is not executable and explicit manual review stays advisory", () => {
  const parsed = extractPlanTasks(
    "- [ ] 代码审查：确认 normalizeCsvOrder 返回对象包含正确的 creatorName。",
  );

  assert.equal(parsed.some((task) => task.evidence?.some((item) => item.kind === "cmd")), false);

  const technicallyAutomatableManualLabel = extractPlanTasks(
    "- [ ] 手动验证：`normalizeCsvOrder({ creator: 'alice' })` 返回 `{ creatorName: 'alice' }`。",
  );
  assert.equal(technicallyAutomatableManualLabel[0].evidence?.[0]?.kind, "manual_user_validation");
  assert.equal(isPlanTaskAwaitingExternalValidation(technicallyAutomatableManualLabel[0]), true);

  const manual = extractPlanTasks(
    "- [ ] 用户手动确认结果正确。",
  );
  assert.equal(manual[0].evidence?.[0]?.kind, "manual_user_validation");
  assert.equal(isPlanTaskAwaitingExternalValidation(manual[0]), true);
});

test("user review cannot hide missing automatic evidence in a composite task", () => {
  const parsed = extractPlanTasks(
    "- [ ] 修改 `src/App.tsx` 后由用户手动确认界面 — 证据: file:src/App.tsx, manual_user_validation:user reviews the UI",
  );
  const beforeMutation = reconcilePlanTaskCompletion([], parsed, []);
  const beforeAudit = buildPlanTaskEvidenceAudit({ tasks: beforeMutation });

  assert.equal(beforeMutation[0].evidenceStatus, "missing");
  assert.equal(isPlanTaskAwaitingExternalValidation(beforeMutation[0]), false);
  assert.equal(beforeAudit.acceptedCompletion, false);
  assert.equal(beforeAudit.remainingTasks.length, 1);

  const mutation = createPlanExecutionEvidenceEntry({
    toolName: "replace_in_file",
    target: "src/App.tsx",
    result: JSON.stringify({ success: true, changed: true }),
  });
  const afterMutation = reconcilePlanTaskCompletion([], parsed, mutation ? [mutation] : []);
  const afterAudit = buildPlanTaskEvidenceAudit({ tasks: afterMutation });

  assert.equal(afterMutation[0].evidenceStatus, "requires_user_confirmation");
  assert.equal(isPlanTaskAwaitingExternalValidation(afterMutation[0]), true);
  assert.equal(afterAudit.acceptedCompletion, true);
  assert.equal(afterAudit.remainingTasks.length, 0);
  assert.equal(afterAudit.pendingUserValidationTasks.length, 1);
});

test("unlabelled mutation plus user review preserves file evidence and advisory review", () => {
  const parsed = extractPlanTasks(
    "- [ ] 修改 `src/App.tsx` 后由用户手动确认界面。",
  );

  assert.deepEqual(parsed[0].evidence?.map((item) => item.kind), [
    "file",
    "manual_user_validation",
  ]);
  const beforeMutation = reconcilePlanTaskCompletion([], parsed, []);
  assert.equal(beforeMutation[0].evidenceStatus, "missing");

  const mutation = createPlanExecutionEvidenceEntry({
    toolName: "replace_in_file",
    target: "src/App.tsx",
    result: JSON.stringify({ success: true, changed: true }),
  });
  const afterMutation = reconcilePlanTaskCompletion([], parsed, mutation ? [mutation] : []);
  const audit = buildPlanTaskEvidenceAudit({ tasks: afterMutation });
  assert.equal(audit.acceptedCompletion, true);
  assert.equal(audit.pendingUserValidationTasks.length, 1);
});

test("browser location in an explicit user review remains advisory, not browser acceptance", () => {
  const manualOnly = extractPlanTasks(
    "- [ ] 请用户在浏览器中手动验证页面按钮和主题切换是否正常。",
  );
  assert.deepEqual(manualOnly[0].evidence?.map((item) => item.kind), [
    "manual_user_validation",
  ]);

  const automaticThenManual = extractPlanTasks(
    "- [ ] 使用浏览器工具自动验证页面按钮，再请用户手动确认视觉效果。",
  );
  assert.deepEqual(automaticThenManual[0].evidence?.map((item) => item.kind), [
    "browser_dom",
    "manual_user_validation",
  ]);
});

test("runtime task evidence does not classify dotted code properties as files", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content: [
      "# Plan",
      "## Key Changes",
      "- Fix `src/hooks/useCsvParser.ts` so `row.creator` is assigned to creatorName.",
      "## Test Plan",
      "- Run `npm test`.",
    ].join("\n"),
    updatedAt: Date.now(),
  }], { language: "en" });

  const fileEvidence = tasks.flatMap((task) => task.evidence || []).filter((entry) => entry.kind === "file");
  assert.deepEqual(fileEvidence.map((entry) => entry.value), ["src/hooks/useCsvParser.ts"]);
});

test("browser validation capability detection is tool-name based and provider neutral", () => {
  assert.equal(hasBrowserValidationCapability(["run_command", "read_file"]), false);
  assert.equal(hasBrowserValidationCapability(["browser_navigate", "browser_screenshot"]), true);
  assert.equal(hasBrowserValidationCapability(["playwright_evaluate"]), true);
});

test("package install commands satisfy package manifest evidence only", () => {
  const installCommand = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm install",
    result: JSON.stringify({ exitCode: 0, stdout: "added 230 packages" }),
  });
  const verifyCommand = createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm ls echarts antd zustand",
    result: JSON.stringify({ exitCode: 0, stdout: "echarts antd zustand" }),
  });
  const ledger = [installCommand, verifyCommand].filter(Boolean);

  const dependencyTask = reconcilePlanTaskCompletion(
    [],
    extractPlanTasks("- [ ] 安装前端依赖 — 证据: file:package.json (dependencies 区块), cmd:npm ls echarts antd zustand"),
    ledger,
  );
  const sourceTask = reconcilePlanTaskCompletion(
    [],
    extractPlanTasks("- [ ] 修改入口文件 — 证据: file:src/App.tsx"),
    installCommand ? [installCommand] : [],
  );

  assert.equal(isPlanTaskTrustedComplete(dependencyTask[0]), true);
  assert.equal(isPlanTaskTrustedComplete(sourceTask[0]), false);
});

test("verification evidence never treats .MAIN plans as project source", () => {
  const planVerification = createPlanExecutionEvidenceEntry({
    toolName: "read_file",
    target: ".MAIN/plans/tasks.md",
    result: "- [x] 修改 src/App.tsx",
  });
  const manualPlanVerification = {
    id: "manual-plan",
    kind: "tool",
    value: ".MAIN/plans/tasks.md",
    target: ".MAIN/plans/tasks.md",
    references: [".MAIN/plans/tasks.md"],
    sourceTool: "read_file",
    createdAt: 1,
  };
  const reconciled = reconcilePlanTaskCompletion(
    [],
    extractPlanTasks("- [x] 更新计划任务文件 — 证据: file:.MAIN/plans/tasks.md"),
    [manualPlanVerification],
  );

  assert.equal(planVerification, null);
  assert.equal(isPlanTaskTrustedComplete(reconciled[0]), false);
});

test("findDroppedPlanTasks detects task deletion from rewritten tasks.md", () => {
  const previous = extractPlanTasks("- [x] 任务1：完善 BattleUnit.cs\n- [ ] 任务2：更新 BattleManager.cs");
  const latest = extractPlanTasks("- [ ] 任务2：更新 BattleManager.cs");
  const dropped = findDroppedPlanTasks(previous, latest);

  assert.equal(dropped.length, 1);
  assert.match(dropped[0].text, /BattleUnit/);
});

test("validatePlanArtifactContent rejects fallback/log/thought/code fragments", () => {
  assert.equal(validatePlanArtifactContent("自动生成的兜底草稿：模型已经读取上下文。", "requirements").ok, false);
  assert.equal(validatePlanArtifactContent("Repeated read-only tool call skipped: get project skeleton", "design").ok, false);
  assert.equal(validatePlanArtifactContent("ContextMemoryState v1\nLatest user request: foo", "design").ok, false);
  assert.equal(validatePlanArtifactContent("[MAIN TOOL FEEDBACK V1]{\"tool\":\"read_file\"}", "design").ok, false);
  assert.equal(validatePlanArtifactContent("后台思考已折叠\n让我先分析用户需求。", "design").ok, false);
  assert.equal(validatePlanArtifactContent("using System;\nnamespace Battle.Core { public class BattleUnit {} }", "requirements").ok, false);
});

test("validateActionablePlanArtifact rejects generic fallback design", () => {
  const generic = [
    "# Plan",
    "## 用户目标与约束",
    "- 用户目标：请生成一个方案。",
    "## 当前发现",
    "- 已经获得只读上下文，足以先形成可审批的执行计划。",
    "## 拟定方案",
    "- 围绕用户目标设计最小可用闭环：输入读取、数据校验、核心处理、结果展示或导出。",
    "## 影响文件与接口",
    "- 审批产物：`.MAIN/plans/plan.md`。",
    "## 执行顺序",
    "1. 确认输入结构。",
    "## 验证方式",
    "- 运行检查。",
  ].join("\n");

  assert.equal(validateActionablePlanArtifact(generic).ok, false);
});

test("validateActionablePlanArtifact rejects directory-search grounded generic implementation plan", () => {
  const generic = [
    "# 计划",
    "## 摘要",
    "- 用户目标：修复 CSV 导入后 Dashboard 数据不显示。",
    "- 定向证据已覆盖：`src/hooks/useCsvParser.ts`、`src/store/dashboardStore.ts`。",
    "- 最相关证据：已搜索文件：/ .{ts,tsx,vue}。",
    "## 关键改动",
    "- 在 `src/hooks/useCsvParser.ts` 中实施与“修复 CSV 导入后 Dashboard 数据不显示”直接相关的最小改动；写入前先用证据确认具体字段、状态或接口。依据证据：已搜索文件：/ .{ts,tsx,vue}。",
    "- 在 `src/store/dashboardStore.ts` 中实施与“修复 CSV 导入后 Dashboard 数据不显示”直接相关的最小改动；写入前先用证据确认具体字段、状态或接口。依据证据：已查看目录：src/hooks。",
    "## 公共 API / 接口 / 类型",
    "- 默认不新增公共 API。",
    "## 测试方案",
    "- 运行受影响子系统验证。",
    "## 假设与默认值",
    "- 默认最小变更。",
  ].join("\n");
  const result = validateActionablePlanArtifact(generic);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "generic_fallback_plan");
});

test("validateActionablePlanArtifact rejects file-only smallest-change filler", () => {
  const generic = [
    "# 计划",
    "## 摘要",
    "- 用户目标：修复 CSV 导入后 Dashboard 数据不显示。",
    "- 最相关证据：已读取文件：src/hooks/useCsvParser.ts。",
    "## 关键改动",
    "- 围绕 `src/hooks/useCsvParser.ts` 执行与用户目标直接相关的最小改动。",
    "## 公共 API / 接口 / 类型",
    "- 默认不新增公共 API。",
    "## 测试方案",
    "- 运行受影响子系统验证。",
    "## 假设与默认值",
    "- 默认最小变更。",
  ].join("\n");
  const result = validateActionablePlanArtifact(generic);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "generic_fallback_plan");
});

test("validateActionablePlanArtifact rejects prompt-leaked noisy fallback plan from debug log", () => {
  const bad = [
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    "- 定向证据已覆盖：`src/App.tsx`、`src/store/dashboardStore.ts`、`src/components/FileUploader/DragUpload.tsx`。",
    "- 最相关证据：已搜索文本：.；发现：index.html:6: <title 课程销售 Dashboard</title package-lock.json:2: name : sales-dashboard。",
    "",
    "## 关键改动",
    "- 更新 `src/App.tsx` 的深色模式表面、主题 token、图表/容器对比度。依据证据：已读取文件：src/App.tsx；发现：src/App.tsx。",
    "- 修复 `src/store/dashboardStore.ts` 中导入数据进入 Dashboard 状态与统计源的链路。依据证据：已读取文件：src/store/dashboardStore.ts；发现：src/store/dashboardStore.ts。",
    "- 更新 `src/components/FileUploader/DragUpload.tsx` 的深色模式表面、主题 token、图表/容器对比度。依据证据：已读取文件：src/components/FileUploader/DragUpload.tsx；发现：src/components/FileUploader/DragUpload.tsx。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 默认不新增或修改公共 API、接口或类型。",
    "",
    "## 测试方案",
    "- 运行受影响子系统的聚焦测试、构建检查或浏览器/桌面验证，并记录结果。",
    "",
    "## 假设与默认值",
    "- 如果确实缺少关键业务选择，用 提问，不要写泛化模板计划。",
    "- tsx 约束：可见计划必须对齐 Codex app 的交接计划结构。",
    "- 如果 imageParts 0，必须先说明从截图观察到的现象。",
  ].join("\n");

  const result = validateActionablePlanArtifact(bad);
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /prompt_leakage_in_plan|noisy_search_evidence|weak_path_echo_evidence/);
});

test("validateActionablePlanArtifact rejects import-only weak plan from debug log", () => {
  const bad = [
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：修复手动导入 CSV 后 Dashboard 数据不显示，并彻底改善深色模式。",
    "- 定向证据已覆盖：`src/App.tsx`、`src/components/FileUploader/DragUpload.tsx`。",
    "- 最相关证据：已读取文件：src/App.tsx；发现：L1: import React, { useState, useEffect } from 'react';。",
    "",
    "## 关键改动",
    "- 更新 `src/App.tsx` 的深色模式表面、主题 token、图表/容器对比度。依据证据：已读取文件：src/App.tsx；发现：L1: import React, { useState, useEffect } from 'react';。",
    "- 更新 `src/components/FileUploader/DragUpload.tsx` 的深色模式表面、主题 token、图表/容器对比度。依据证据：已读取文件：src/components/FileUploader/DragUpload.tsx；发现：L1: import { InboxOutlined } from '@ant-design/icons';。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 默认不新增或修改公共 API、接口或类型。",
    "",
    "## 测试方案",
    "- 运行受影响子系统的聚焦测试、构建检查或浏览器/桌面验证，并记录结果。",
    "",
    "## 假设与默认值",
    "- 默认保持现有数据结构不变。",
  ].join("\n");

  const result = validateActionablePlanArtifact(bad);
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /import_only_evidence|generic_theme_token_plan|placeholder_validation_plan/);
});

test("validateActionablePlanArtifact rejects blocking plan forks without user options", () => {
  const plan = [
    "# CSV Dashboard 修复计划",
    "",
    "## 用户目标",
    "- 修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    "",
    "## 摘要",
    "- 已读取 `src/App.tsx` 和 `src/store/dashboardStore.ts`，确认导入完成后缺少状态刷新闭环。",
    "",
    "## 已读证据",
    "- `src/App.tsx`：CSV 上传入口负责触发导入流程。",
    "- `src/store/dashboardStore.ts`：Dashboard 指标来自 store 聚合状态。",
    "",
    "## 关键改动",
    "- 方案 A：只修复 `src/App.tsx` 的导入后刷新调用。",
    "- 方案 B：同时重构 `src/store/dashboardStore.ts` 的状态入口。",
    "- 需要用户选择方案 A 或方案 B 后再执行。",
    "",
    "## 影响文件",
    "- `src/App.tsx`",
    "- `src/store/dashboardStore.ts`",
    "",
    "## 执行步骤",
    "1. 根据用户选择的方案更新导入链路。",
    "2. 补充针对 Dashboard 指标刷新的回归测试。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化。",
    "",
    "## 测试方案",
    "- 运行 `npm run build` 并手动导入 CSV 验证指标更新。",
    "",
    "## 验证标准",
    "- CSV 导入后 Dashboard 指标立即显示最新数据。",
    "",
    "## 假设与默认值",
    "- 保持现有 CSV 文件格式不变。",
  ].join("\n");

  const fork = analyzePlanDecisionFork(plan);
  const result = validateActionablePlanArtifact(plan);

  assert.equal(fork.classification, "blocking");
  assert.equal(fork.requiresUserOptions, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "blocking_plan_decision_without_user_options");
});

test("validateActionablePlanArtifact rejects user-visible decision forks even with a recommendation", () => {
  const plan = [
    "# CSV Dashboard 修复计划",
    "",
    "## 用户目标",
    "- 修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    "",
    "## 摘要",
    "- 已读取 `src/App.tsx` 和 `src/store/dashboardStore.ts`，确认导入完成后缺少状态刷新闭环。",
    "",
    "## 已读证据",
    "- `src/App.tsx`：CSV 上传入口负责触发导入流程。",
    "- `src/store/dashboardStore.ts`：Dashboard 指标来自 store 聚合状态。",
    "",
    "## 关键改动",
    "- 方案 A：只修复 `src/App.tsx` 的导入后刷新调用。",
    "- 方案 B：同时重构 `src/store/dashboardStore.ts` 的状态入口。",
    "- 推荐方案 A：先做最小修复，避免扩大状态管理改动范围。",
    "- 但这个取舍会影响最终行为与 UI 体验，需要用户确认。",
    "",
    "## 影响文件",
    "- `src/App.tsx`",
    "- `src/store/dashboardStore.ts`",
    "",
    "## 执行步骤",
    "1. 采用方案 A 更新导入链路。",
    "2. 补充针对 Dashboard 指标刷新的回归测试。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化。",
    "",
    "## 测试方案",
    "- 运行 `npm run build` 并手动导入 CSV 验证指标更新。",
    "",
    "## 验证标准",
    "- CSV 导入后 Dashboard 指标立即显示最新数据。",
    "",
    "## 假设与默认值",
    "- 保持现有 CSV 文件格式不变。",
  ].join("\n");

  const fork = analyzePlanDecisionFork(plan);
  const result = validateActionablePlanArtifact(plan);

  assert.equal(fork.classification, "blocking");
  assert.equal(fork.requiresUserOptions, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "user_visible_decision_fork_without_options");
});

test("validateActionablePlanArtifact accepts a startup UX default when no user decision is explicitly required", () => {
  const plan = [
    "# 计划：修复双击 .md 文件打开时出现空白窗口的问题",
    "",
    "## 用户目标",
    "检查用户通过系统打开 .md 文件时出现空白窗口和文件窗口的问题，并修复启动逻辑。",
    "",
    "## 摘要",
    "- 已确认 Tauri setup 先创建默认窗口，再处理文件打开参数，导致用户看到额外空白窗口。",
    "",
    "## 已读证据",
    "- `src-tauri/src/main.rs`：setup 中默认创建窗口。",
    "- `src/main.js`：前端监听 file-open 事件加载文件。",
    "",
    "## 关键改动",
    "- 方案 A：延迟窗口创建（推荐），有文件参数时只创建文件窗口。",
    "- 方案 B：启动时显示\"开始\"面板，引导用户创建或打开文档。",
    "- 推荐方案 A：先避免右键打开文件时出现额外窗口。",
    "",
    "## 影响文件",
    "- `src-tauri/src/main.rs`",
    "- `src/main.js`",
    "",
    "## 执行步骤",
    "1. 根据确认的启动 UX 方案调整窗口创建时序。",
    "2. 验证右键打开 .md 文件只显示目标文件窗口。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 不新增公共 API；仅调整内部启动路径。",
    "",
    "## 测试方案",
    "- 运行 `npm run build` 并手动通过系统打开 .md 文件验证。",
    "",
    "## 验证标准",
    "- 通过右键菜单打开 .md 文件时，直接显示文件内容，无空白窗口。",
    "- 直接启动应用时，显示空白编辑器或\"开始\"面板。",
    "",
    "## 假设与默认值",
    "- 保持现有文件读取和保存格式不变。",
  ].join("\n");

  const fork = analyzePlanDecisionFork(plan);
  const result = validateActionablePlanArtifact(plan);

  assert.equal(fork.classification, "defaultable");
  assert.equal(fork.requiresUserOptions, false);
  assert.equal(fork.userVisibleDecision, false);
  assert.equal(result.ok, true);
});

test("validateActionablePlanArtifact allows defaulted internal implementation forks", () => {
  const plan = [
    "# CSV Dashboard 修复计划",
    "",
    "## 用户目标",
    "- 修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    "",
    "## 摘要",
    "- 已读取 `src/App.tsx` 和 `src/store/dashboardStore.ts`，确认导入完成后缺少状态刷新闭环。",
    "",
    "## 已读证据",
    "- `src/App.tsx`：CSV 上传入口负责触发导入流程。",
    "- `src/store/dashboardStore.ts`：Dashboard 指标来自 store 聚合状态。",
    "",
    "## 关键改动",
    "- 方案 A：把刷新调用抽成一个本地 helper。",
    "- 方案 B：直接在当前回调里补一行刷新。",
    "- 推荐方案 A：便于后续复用，但两者对用户行为没有差异。",
    "",
    "## 影响文件",
    "- `src/App.tsx`",
    "",
    "## 执行步骤",
    "1. 采用方案 A 进行内部重构。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 默认不新增或修改公共 API、接口或类型。",
    "",
    "## 测试方案",
    "- 运行 `npm run build`。",
    "",
    "## 验证标准",
    "- CSV 导入后 Dashboard 指标立即显示最新数据。",
    "",
    "## 假设与默认值",
    "- 保持现有 CSV 文件格式不变。",
  ].join("\n");

  const fork = analyzePlanDecisionFork(plan);
  const result = validateActionablePlanArtifact(plan);

  assert.equal(fork.classification, "defaultable");
  assert.equal(fork.requiresUserOptions, false);
  assert.equal(result.ok, true);
});

test("validateActionablePlanArtifact does not treat a mutation-looking H1 as an execution section", () => {
  const plan = [
    "# Fix initialization error handling",
    "",
    "## Summary",
    "- User goal: Add startup error handling in `src/main.js`.",
    "",
    "## Evidence",
    "- Confirmed `src/main.js` registers the startup listener without an error boundary.",
    "",
    "## Test Plan",
    "- Run `npm test` and verify startup errors are reported.",
    "",
    "## Validation",
    "- Startup failures produce a visible error instead of a blank screen.",
  ].join("\n");

  const result = validateActionablePlanArtifact(plan);
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /missing_plan_required_sections:.*execution_steps/);
});

test("validateActionablePlanArtifact does not treat Data Flow as a mutation section", () => {
  const plan = [
    "# Startup reliability plan",
    "",
    "## Summary",
    "- User goal: Add an initialization error listener in `src/main.js`.",
    "",
    "## Evidence",
    "- Confirmed `src/main.js` owns startup event registration.",
    "",
    "## Data Flow",
    "1. The startup event reaches the existing application bootstrap.",
    "",
    "## Test Plan",
    "- Run `npm test` and verify initialization failures are surfaced.",
    "",
    "## Validation",
    "- The application reports an initialization error without hanging.",
  ].join("\n");

  const result = validateActionablePlanArtifact(plan);
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /missing_plan_required_sections:.*execution_steps/);
});

test("validateActionablePlanArtifact rejects empty goals and approved-goal filler", () => {
  const bad = [
    "# 计划",
    "## 摘要",
    "- 用户目标：",
    "- 定向证据已覆盖：`src/hooks/useCsvParser.ts`。",
    "## 关键改动",
    "- 更新 `src/hooks/useCsvParser.ts` 以落实已批准目标；依据证据：read_file src/hooks/useCsvParser.ts。",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化。",
    "## 测试方案",
    "- 运行 `npm run build`。",
    "## 假设与默认值",
    "- 默认保持未点名接口不变。",
  ].join("\n");

  const result = validateActionablePlanArtifact(bad);
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /empty_user_goal|generic_approved_goal_plan/);
});

test("validatePlanArtifactContent accepts real requirements and plan artifacts", () => {
  const requirements = [
    "# 需求规格",
    "## 用户目标",
    "实现 Unity CTB 回合制战斗框架，并保持代码适合教程录制。",
    "## 范围",
    "- 统一战斗单位、行动队列、技能与事件数据。",
    "## 交付物",
    "- 源码文件更新。",
    "- 根目录 Readme.md 总结架构。",
    "## 验收标准",
    "- 生成的代码必须写入真实工作区文件。",
    "- 每个完成步骤都有可见工具调用或文件写入证据。",
  ].join("\n");
  const design = [
    "# 执行计划",
    "## 影响文件",
    "- Scripts/Battle/Core/BattleUnit.cs",
    "- Scripts/Battle/Systems/BattleActionQueue.cs",
    "## 执行顺序",
    "1. 先补齐核心数据结构。",
    "2. 再实现 CT 累积、排序和回合推进。",
    "## 关键数据流",
    "BattleUnit 产生行动状态，BattleActionQueue 负责推进，BattleManager 驱动回合。",
    "## 验证方式",
    "- 编译 Unity 脚本。",
    "- 检查示例场景是否可以进入战斗流程。",
  ].join("\n");

  const planWithCodeBlock = [
    "# 执行计划",
    "## 摘要",
    "重构 C# 战斗系统架构。",
    "## 关键改动",
    "```csharp",
    "using System;",
    "namespace Battle.Core {",
    "    public class BattleUnit {}",
    "}",
    "```",
    "## 公共 API / 接口 / 类型",
    "提供 BattleUnit 公共数据结构。",
    "## 测试方案",
    "- 运行单元测试。",
    "## 假设与默认值",
    "- 遵循 Unity 命名规范。",
  ].join("\n");

  assert.equal(validatePlanArtifactContent(requirements, "requirements").ok, true);
  assert.equal(validatePlanArtifactContent(design, "design").ok, true);
  assert.equal(validatePlanArtifactContent(planWithCodeBlock, "plan").ok, true);
});

test("validatePlanArtifactContent requires inferable task evidence", () => {
  assert.equal(validatePlanArtifactContent("先实现核心逻辑，再运行测试。", "tasks").ok, false);
  assert.equal(validatePlanArtifactContent("- [ ] 调整空状态", "tasks").ok, false);
  assert.equal(validatePlanArtifactContent("- [ ] 调整 src/App.tsx 空状态", "tasks").ok, true);
  assert.equal(validatePlanArtifactContent("- [ ] 运行检查 — 证据: cmd:npx tsc --noEmit", "tasks").ok, true);
  assert.equal(validatePlanArtifactContent("- [ ] 修复组件状态 — 证据: file:src/App.tsx", "tasks").ok, true);
  assert.equal(
    validatePlanArtifactContent([
      "- [ ] 修复组件状态 — 证据: file:src/App.tsx",
      "- [ ] 更新其余未指定目标的逻辑",
    ].join("\n"), "tasks").ok,
    false,
  );

  const bugfixWithoutEvidence = [
    "# Bugfix plan",
    "",
    "## Root cause",
    "The runtime can publish a task checklist before its evidence contract is validated, which can split artifact and execution state.",
    "",
    "## Tasks",
    "- [ ] Repair the runtime state transition",
    "",
    "## Validation",
    "Run the focused state-machine regression tests after the mutation is accepted.",
  ].join("\n");
  const bugfixWithEvidence = bugfixWithoutEvidence.replace(
    "- [ ] Repair the runtime state transition",
    "- [ ] Repair the runtime state transition — Evidence: file:src/store/useAppStore.ts",
  );
  assert.equal(validatePlanArtifactContent(bugfixWithoutEvidence, "bugfix").ok, false);
  assert.equal(validatePlanArtifactContent(bugfixWithEvidence, "bugfix").ok, true);
});

test("approved plan execution no-tool recovery bypasses generic missing-tool stop", () => {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: extractPlanTasks("- [ ] 修复执行阶段状态边界 — 证据: file:src/store/useAppStore.ts"),
    evidenceLedger: [],
    highlightNext: true,
  });

  assert.equal(
    shouldHandleApprovedPlanExecutionNoTool({
      isPlanApproved: true,
      planStage: "executing",
      toolCallCount: 0,
      audit,
    }),
    true,
  );
  assert.equal(
    shouldHandleApprovedPlanExecutionNoTool({
      isPlanApproved: true,
      planStage: "design",
      toolCallCount: 0,
      audit,
    }),
    false,
  );

  const advisoryAudit = buildPlanTaskEvidenceAudit({
    tasks: extractPlanTasks("- [ ] 用户手动确认最终交互 — 证据: manual_user_validation:user confirmation"),
    evidenceLedger: [],
  });
  assert.equal(advisoryAudit.acceptedCompletion, true);
  assert.equal(
    shouldHandleApprovedPlanExecutionNoTool({
      isPlanApproved: true,
      planStage: "executing",
      toolCallCount: 0,
      audit: advisoryAudit,
    }),
    false,
  );

  const prompt = buildPlanExecutionNoToolRecoveryPrompt({
    language: "zh",
    forceXmlTools: true,
    missingTasksArtifact: false,
    remainingText: audit.blockedReasons.join("\n"),
    commandHint: "命令提示",
  });
  assert.match(prompt, /TOOL_ONLY_RECOVERY/);
  assert.match(prompt, /已批准计划正在执行/);
  assert.match(prompt, /真实 `<tool_use>`/);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /apply_patch/);
  assert.match(prompt, /browser_evaluate/);
  assert.match(prompt, /完成任务前必须先产生真实工具证据/);
  assert.match(prompt, /src\/store\/useAppStore\.ts/);
  assert.doesNotMatch(prompt, /missing_tool_reprompt_limit|聊天失败/);

  const nativePrompt = buildPlanExecutionNoToolRecoveryPrompt({
    language: "en",
    missingTasksArtifact: false,
    remainingText: "file evidence for src/store/useAppStore.ts",
  });
  assert.match(nativePrompt, /formal tool call from the active schemas/);
  assert.doesNotMatch(nativePrompt, /XML|<tool_use>|<tool>|<parameter/i);
});

test("collectChangeEntries ignores ephemeral plan files but keeps source and bugfix diffs", () => {
  const stats = (oldText, newText) => ({
    added: newText.split("\n").length,
    removed: oldText.split("\n").length,
  });
  const result = collectChangeEntries([
    {
      id: 1,
      type: "tool",
      toolName: "write_file",
      toolStatus: "executed",
      target: ".MAIN/plans/tasks.md",
      diff: { old: "", new: "- [ ] Task", path: ".MAIN/plans/tasks.md" },
    },
    {
      id: 3,
      type: "tool",
      toolName: "write_file",
      toolStatus: "executed",
      target: ".MAIN/plans/bugfix.md",
      diff: { old: "", new: "# Bugfix", path: ".MAIN/plans/bugfix.md" },
    },
    {
      id: 2,
      type: "tool",
      toolName: "replace_in_file",
      toolStatus: "executed",
      target: "Scripts/Battle/Core/BattleUnit.cs",
      diff: { old: "old", new: "new\nline", path: "Scripts/Battle/Core/BattleUnit.cs" },
    },
  ], stats);

  assert.equal(result.totalExecutedEdits, 2);
  assert.equal(isEphemeralPlanArtifactPath(".MAIN/plans/requirements.md"), true);
  assert.equal(isEphemeralPlanArtifactPath(".MAIN/plans/plan.md"), true);
  assert.equal(isEphemeralPlanArtifactPath(".MAIN/plans/tasks.md"), true);
  assert.equal(isEphemeralPlanArtifactPath(".MAIN/plans/bugfix.md"), false);
  assert.equal(result.entries[0].target, "Scripts/Battle/Core/BattleUnit.cs");
  assert.equal(result.entries[0].isPlanFile, false);
  assert.equal(result.entries[1].target, ".MAIN/plans/bugfix.md");
  assert.equal(result.entries[1].isPlanFile, true);
});

test("collectChangeEntries includes MCP Unity edit diffs", () => {
  const stats = (oldText, newText) => ({
    added: Math.max(0, newText.split("\n").length - oldText.split("\n").length),
    removed: Math.max(0, oldText.split("\n").length - newText.split("\n").length),
  });
  const result = collectChangeEntries([
    {
      id: 41,
      type: "tool",
      toolName: "script_apply_edits",
      toolStatus: "executed",
      target: "Assets/Scripts/Managers/GameManager.cs",
      diff: {
        old: "void Update() {}\n",
        new: "void Update() {}\nvoid StartNewGame() {}\n",
        path: "Assets/Scripts/Managers/GameManager.cs",
        existed: true,
        fullFile: true,
      },
    },
  ], stats);

  assert.equal(result.totalExecutedEdits, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].target, "Assets/Scripts/Managers/GameManager.cs");
  assert.equal(result.entries[0].displayTarget, "GameManager.cs");
  assert.equal(result.entries[0].taskId, 41);
});

test("Plan evidence identity isolates same-file tasks and legacy records are consumed one-to-one", () => {
  const tasks = ["task-a", "task-b"].map((id) => ({
    id,
    text: `Modify shared source for ${id}`,
    status: "pending",
    evidenceStatus: "missing",
    executionKind: "mutation",
    evidence: [{ kind: "file", value: "src/shared.ts" }],
  }));
  const mutation = (planTaskId) => createPlanExecutionEvidenceEntry({
    toolName: "apply_patch",
    target: "src/shared.ts",
    result: "patched",
    diff: { old: "before", new: `after ${planTaskId || "legacy"}`, path: "src/shared.ts" },
    ...(planTaskId ? { planTaskId, requirementRef: planTaskId } : {}),
  });

  const scopedAudit = buildPlanTaskEvidenceAudit({
    tasks,
    evidenceLedger: [mutation("task-b")],
  });
  assert.equal(scopedAudit.tasks[0].evidenceStatus, "missing");
  assert.equal(scopedAudit.tasks[1].evidenceStatus, "satisfied");

  const oneLegacyAudit = buildPlanTaskEvidenceAudit({
    tasks,
    evidenceLedger: [mutation(null)],
  });
  assert.equal(oneLegacyAudit.tasks[0].evidenceStatus, "satisfied");
  assert.equal(oneLegacyAudit.tasks[1].evidenceStatus, "missing");

  const twoLegacyAudit = buildPlanTaskEvidenceAudit({
    tasks,
    evidenceLedger: [mutation(null), mutation(null)],
  });
  assert.equal(twoLegacyAudit.tasks[0].evidenceStatus, "satisfied");
  assert.equal(twoLegacyAudit.tasks[1].evidenceStatus, "satisfied");
});

test("Plan evidence ownership advances when the checkpoint obligation does not match the tool result", () => {
  const tasks = [
    {
      id: "mutation",
      requirementRef: "REQ-MUTATION",
      text: "Modify toolbar",
      status: "in_progress",
      evidenceStatus: "missing",
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
      text: "Start development server",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "cmd", value: "npm run dev" }],
    },
    {
      id: "browser",
      requirementRef: "REQ-BROWSER",
      text: "Inspect rendered page",
      status: "pending",
      evidenceStatus: "missing",
      evidence: [{ kind: "browser_dom", value: "rendered page" }],
    },
  ];
  const preferred = {
    preferredPlanTaskId: "mutation",
    preferredRequirementRef: "REQ-MUTATION",
  };
  const buildRecord = {
    id: "build-result",
    kind: "cmd",
    value: "npm run build",
    target: "npm run build",
    sourceTool: "run_command",
    createdAt: 1,
  };
  assert.deepEqual(resolvePlanExecutionEvidenceIdentity({
    tasks,
    evidenceLedger: [],
    record: buildRecord,
    ...preferred,
  }), {
    planTaskId: "build",
    requirementRef: "REQ-BUILD",
  });

  const devLaunch = {
    id: "dev-launch",
    planTaskId: "dev",
    requirementRef: "REQ-DEV",
    kind: "cmd",
    value: "npm run dev",
    target: "npm run dev",
    sourceTool: "execute_command",
    observationStatus: "pending",
    foregroundGeneration: 4,
    createdAt: 2,
  };
  const readyObservation = {
    id: "dev-ready",
    kind: "dev_server_url",
    value: "http://localhost:1420/",
    target: "terminal",
    sourceTool: "read_pty_since",
    observationStatus: "ready",
    foregroundGeneration: 4,
    createdAt: 3,
  };
  assert.equal(resolvePlanExecutionEvidenceIdentity({
    tasks,
    evidenceLedger: [devLaunch],
    record: readyObservation,
    preferredPlanTaskId: "dev",
  })?.planTaskId, "dev");

  const browserRecord = {
    id: "browser-result",
    kind: "browser_dom",
    value: "http://localhost:1420/",
    target: "http://localhost:1420/",
    sourceTool: "browser_evaluate",
    createdAt: 4,
  };
  assert.equal(resolvePlanExecutionEvidenceIdentity({
    tasks,
    evidenceLedger: [devLaunch, { ...readyObservation, planTaskId: "dev", requirementRef: "REQ-DEV" }],
    record: browserRecord,
    preferredPlanTaskId: "dev",
  })?.planTaskId, "browser");
});

test("composite Plan task keeps ownership only for its matching obligations", () => {
  const task = {
    id: "composite",
    requirementRef: "REQ-COMPOSITE",
    text: "Modify and build",
    status: "in_progress",
    evidenceStatus: "missing",
    evidence: [
      { kind: "file", value: "src/main.ts" },
      { kind: "cmd", value: "npm run build" },
    ],
  };
  const buildFailure = {
    id: "build-failure",
    kind: "cmd",
    value: "npm run build",
    target: "npm run build",
    sourceTool: "run_command",
    observationStatus: "failed",
    createdAt: 1,
  };
  assert.equal(resolvePlanExecutionEvidenceIdentity({
    tasks: [task],
    record: buildFailure,
    preferredPlanTaskId: "composite",
  })?.planTaskId, "composite");
  assert.equal(resolvePlanExecutionEvidenceIdentity({
    tasks: [task],
    record: { ...buildFailure, id: "unrelated", value: "npm run dev", target: "npm run dev" },
    preferredPlanTaskId: "composite",
  }), null);
});
