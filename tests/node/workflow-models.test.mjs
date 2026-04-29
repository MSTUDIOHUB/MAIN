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
  collectChangeEntries,
  deriveVisibleConversationTurnStatus,
  extractPlanTasks,
  findDroppedPlanTasks,
  looksLikeReasoningLeakTitle,
  mergePlanTasks,
  normalizeConversationDisplayTitle,
  resolveActiveConversationTurn,
  resolvePinnedConversationTurn,
  summarizeUserPrompt,
  validatePlanArtifactContent,
} = loadWorkflowModelsModule();

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

test("mergePlanTasks preserves completed task history when the latest tasks.md only lists remaining work", () => {
  const previous = extractPlanTasks("- [x] 任务1：完善 BattleUnit.cs\n- [ ] 任务2：更新 BattleManager.cs");
  const latest = extractPlanTasks("- [ ] 任务2：更新 BattleManager.cs");
  const merged = mergePlanTasks(previous, latest, true);

  assert.equal(merged.length, 2);
  assert.equal(merged.find((task) => task.text.includes("BattleUnit"))?.status, "completed");
  assert.equal(merged.find((task) => task.text.includes("BattleUnit"))?.retained, true);
  assert.equal(merged.find((task) => task.text.includes("BattleManager"))?.retained, false);
});

test("mergePlanTasks treats completion suffixes as the same task identity", () => {
  const previous = extractPlanTasks("- [ ] 保存方案供用户留档\n- [ ] 批准执行并完成最终收尾");
  const latest = extractPlanTasks("- [x] 保存方案供用户留档（已完成）\n- [ ] 批准执行并完成最终收尾");
  const merged = mergePlanTasks(previous, latest, true);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "保存方案供用户留档（已完成）");
  assert.equal(merged[0].status, "completed");
  assert.equal(merged[0].retained, false);
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
  assert.equal(validatePlanArtifactContent("后台思考已折叠\n让我先分析用户需求。", "design").ok, false);
  assert.equal(validatePlanArtifactContent("using System;\nnamespace Battle.Core { public class BattleUnit {} }", "requirements").ok, false);
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

test("collectChangeEntries collects source and plan diffs with source files first", () => {
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
      id: 2,
      type: "tool",
      toolName: "replace_in_file",
      toolStatus: "executed",
      target: "Scripts/Battle/Core/BattleUnit.cs",
      diff: { old: "old", new: "new\nline", path: "Scripts/Battle/Core/BattleUnit.cs" },
    },
  ], stats);

  assert.equal(result.totalExecutedEdits, 2);
  assert.equal(result.entries[0].target, "Scripts/Battle/Core/BattleUnit.cs");
  assert.equal(result.entries[0].isPlanFile, false);
  assert.equal(result.entries[1].isPlanFile, true);
});
