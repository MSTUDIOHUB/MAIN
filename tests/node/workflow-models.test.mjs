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
  collectChangeEntries,
  detectExplicitLanguageOverride,
  detectResponseLanguageMismatch,
  deriveRuntimePlanTasksFromArtifacts,
  deriveVisibleConversationTurnStatus,
  extractPlanTasks,
  findDroppedPlanTasks,
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
  validateActionableDesignArtifact,
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
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/design.md", title: "Design", content: "# Design", updatedAt: 1 }],
    }),
    true,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "先运行诊断脚本，再根据结果修复字体加载",
      sourceIntent: "plan",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/design.md", title: "Design", content: "# Design", updatedAt: 1 }],
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
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/design.md", title: "Design", content: "# Design", updatedAt: 1 }],
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
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/design.md", title: "Design", content: "# Design", updatedAt: 1 }],
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
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/design.md", title: "Design", content: "# Design", updatedAt: 1 }],
    }),
    false,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
      sourceIntent: "execute",
      isPlanApproved: false,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/design.md", title: "Design", content: "# Design", updatedAt: 1 }],
    }),
    false,
  );

  assert.equal(
    shouldRouteQuickReplyToPlanApproval({
      text: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
      sourceIntent: "plan",
      isPlanApproved: true,
      planStage: "design",
      planArtifacts: [{ kind: "design", path: ".MAIN/plans/design.md", title: "Design", content: "# Design", updatedAt: 1 }],
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
      path: ".MAIN/plans/design.md",
      title: "Design",
      updatedAt: 1,
      content: [
        "# Design",
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
      path: ".MAIN/plans/design.md",
      title: "Design",
      updatedAt: 1,
      content: [
        "# Design",
        "",
        "## 当前状态发现",
        "- 项目基于 Tauri + React + TypeScript + Ant Design + ECharts。",
        "- TopIsland 当前显示任务 7/8，但实际还在修复 1.1。",
        "",
        "## 执行顺序",
        "- 修改 src/components/TopIsland.tsx 的任务进度来源。",
      ].join("\n"),
    },
  ], { language: "zh" });

  assert.equal(tasks.some((task) => /项目基于/.test(task.text)), false);
  assert.equal(tasks.some((task) => /TopIsland 当前显示任务/.test(task.text)), false);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].evidence?.[0]?.value, "src/components/TopIsland.tsx");
});

test("runtime plan task derivation requires concrete evidence instead of synthetic tool fallback", () => {
  const tasks = deriveRuntimePlanTasksFromArtifacts([
    {
      kind: "design",
      path: ".MAIN/plans/design.md",
      title: "Design",
      updatedAt: 1,
      content: "# Design\n\n## 执行顺序\n- 完成核心功能实现。\n- 验证实现结果是否可用。",
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

test("validateActionableDesignArtifact rejects generic fallback design", () => {
  const generic = [
    "# Design",
    "## 用户目标与约束",
    "- 用户目标：请生成一个方案。",
    "## 当前发现",
    "- 已经获得只读上下文，足以先形成可审批的设计方案。",
    "## 拟定方案",
    "- 围绕用户目标设计最小可用闭环：输入读取、数据校验、核心处理、结果展示或导出。",
    "## 影响文件与接口",
    "- 审批产物：`.MAIN/plans/design.md`。",
    "## 执行顺序",
    "1. 确认输入结构。",
    "## 验证方式",
    "- 运行检查。",
  ].join("\n");

  assert.equal(validateActionableDesignArtifact(generic).ok, false);
});

test("validatePlanArtifactContent accepts real requirements and design artifacts", () => {
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
    "# 设计方案",
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

  assert.equal(validatePlanArtifactContent(requirements, "requirements").ok, true);
  assert.equal(validatePlanArtifactContent(design, "design").ok, true);
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
  assert.match(prompt, /已批准计划正在执行/);
  assert.match(prompt, /直接调用工具/);
  assert.match(prompt, /Browser\/Playwright/);
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
  assert.equal(isEphemeralPlanArtifactPath(".MAIN/plans/design.md"), true);
  assert.equal(isEphemeralPlanArtifactPath(".MAIN/plans/tasks.md"), true);
  assert.equal(isEphemeralPlanArtifactPath(".MAIN/plans/bugfix.md"), false);
  assert.equal(result.entries[0].target, "Scripts/Battle/Core/BattleUnit.cs");
  assert.equal(result.entries[0].isPlanFile, false);
  assert.equal(result.entries[1].target, ".MAIN/plans/bugfix.md");
  assert.equal(result.entries[1].isPlanFile, true);
});
