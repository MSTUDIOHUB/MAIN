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
  extractPlanTasks,
  findDroppedPlanTasks,
  hasLivePlanWorkspace,
  hasBrowserValidationCapability,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  isEphemeralPlanArtifactPath,
  isPlanTaskTrustedComplete,
  looksLikeReasoningLeakTitle,
  mergePlanTasks,
  normalizeConversationDisplayTitle,
  normalizeResponseLanguagePolicy,
  reconcilePlanTaskCompletion,
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
} = loadPlanEvidenceModule();

const {
  buildPlanApprovalChoiceHint,
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

test("plan evidence records successful commands and deduplicates repeated records", () => {
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
  assert.equal(failedCommand, null);
  assert.equal(firstLedger.length, 1);
  assert.equal(secondLedger, firstLedger);
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

  const rustTask = tasks.find((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src-tauri/src/main.rs"));
  const jsTask = tasks.find((task) => task.evidence?.some((item) => item.kind === "file" && item.value === "src/main.js"));
  const commandTask = tasks.find((task) => task.evidence?.some((item) => item.kind === "cmd" && item.value === "npm run tauri dev"));

  assert.ok(rustTask);
  assert.ok(jsTask);
  assert.ok(commandTask);
  assert.match(rustTask.text, /移除.*cfg_attr.*新增命令/u);
  assert.match(jsTask.text, /替换旧的.*改用后端命令/u);
  assert.equal(tasks.some((task) => /依据|read-only\.rs/.test(task.text)), false);
  assert.deepEqual(
    tasks
      .flatMap((task) => task.evidence || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.value)
      .sort(),
    ["src-tauri/src/main.rs", "src/main.js"].sort(),
  );
  assert.equal(tasks.length, 3, JSON.stringify(tasks, null, 2));
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

  assert.equal(failedBrowserEvidence, null);
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

test("validateActionablePlanArtifact rejects startup UX forks even when plan recommends one option", () => {
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

  assert.equal(fork.classification, "blocking");
  assert.equal(fork.requiresUserOptions, true);
  assert.equal(fork.userVisibleDecision, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "user_visible_decision_fork_without_options");
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
});

test("approved plan execution no-tool recovery bypasses generic missing-tool stop", () => {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: extractPlanTasks("- [ ] 修复执行阶段状态边界 — 证据: file:src/store/useAppStore.ts"),
    evidenceLedger: [],
    highlightNext: true,
  });

  assert.equal(
    shouldHandleApprovedPlanExecutionNoTool({
      workflowMode: "plan",
      isPlanApproved: true,
      planStage: "executing",
      toolCallCount: 0,
      audit,
    }),
    true,
  );
  assert.equal(
    shouldHandleApprovedPlanExecutionNoTool({
      workflowMode: "plan",
      isPlanApproved: true,
      planStage: "design",
      toolCallCount: 0,
      audit,
    }),
    false,
  );

  const prompt = buildPlanExecutionNoToolRecoveryPrompt({
    language: "zh",
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
