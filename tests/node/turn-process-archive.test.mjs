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
  deriveToolPhase,
  deriveToolIntentSummary,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolPresentation.ts"));
const {
  buildTurnProcessArchiveModel,
  buildLiveTurnProcessTimelineModel,
  buildCodexActivityGroups,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnProcessArchive.ts"));

test("tool intent helpers derive stable phases without model metadata", () => {
  assert.equal(deriveToolPhase({ toolName: "grep_search", target: "TurnProcessArchive" }), "discover");
  assert.equal(deriveToolPhase({ toolName: "read_file", target: "src/components/ChatArea.tsx" }), "inspect");
  assert.equal(deriveToolPhase({ toolName: "write_file", target: "src/lib/example.ts" }), "edit");
  assert.equal(deriveToolPhase({ toolName: "execute_command", target: "npm run build" }), "verify");
  assert.equal(deriveToolPhase({ toolName: "execute_command", target: "node scripts/inspect.js" }), "command");
  assert.equal(deriveToolPhase({ toolName: "read_file", target: "missing.ts", toolStatus: "failed" }), "blocked");

  assert.equal(
    deriveToolIntentSummary({
      toolName: "grep_search",
      target: "ChatArea",
      language: "zh",
      currentHypothesis: "确认是否是 hiddenProcess 导致说明不可见",
    }),
    "读取 ChatArea 渲染逻辑，确认当前判断是否成立：确认是否是 hiddenProcess 导致说明不可见",
  );
});

test("turn archive model groups latest thought, context, edits, verification, and blocked steps", () => {
  const blocks = [
    { id: 1, type: "user", content: "实现归档时间线" },
    { id: 2, type: "thought", content: "旧摘要不应该继续显示。" },
    { id: 3, type: "thought", content: "现在准备验证结果，并保留最新步骤摘要。" },
    { id: 4, type: "tool", toolName: "grep_search", target: "TurnProcessArchive", status: "done", toolStatus: "executed" },
    { id: 5, type: "tool", toolName: "read_file", target: "src/components/ChatArea.tsx", status: "done", toolStatus: "executed" },
    {
      id: 6,
      type: "tool",
      toolName: "write_file",
      target: "src/lib/turnProcessArchive.ts",
      status: "done",
      toolStatus: "executed",
      diff: { old: "", new: "export const ok = true;\n", path: "src/lib/turnProcessArchive.ts" },
    },
    { id: 7, type: "tool", toolName: "execute_command", target: "npm run build", status: "done", toolStatus: "executed" },
    { id: 8, type: "tool", toolName: "read_file", target: "missing.ts", status: "error", toolStatus: "failed", message: "ENOENT" },
    { id: 9, type: "agent", content: "完成。", streaming: false },
  ];

  const archive = buildTurnProcessArchiveModel({
    blocks,
    finalVisibleAgentIndex: 8,
    language: "zh",
  });

  assert.equal(archive.totalCount, 6);
  assert.equal(archive.stepCount, 5);
  assert.deepEqual(
    archive.steps.map((step) => step.kind),
    ["thinking", "discover", "edit", "verify", "blocked"],
  );
  assert.equal(archive.steps[0].items[0].id, 3);
  assert.equal(archive.steps[1].items.length, 2);
  assert.match(archive.steps[1].intent, /同一上下文策略|收敛相关范围/);
  assert.doesNotMatch(archive.steps[1].intent, /结果|下一步/);
  assert.match(archive.steps[1].why, /定位/);
  assert.match(archive.steps[1].action, /搜索|扫描/);
  assert.match(archive.steps[1].result, /ChatArea\.tsx|TurnProcessArchive|范围/);
  assert.match(archive.steps[2].intent, /实施聚焦修改/);
  assert.match(archive.steps[2].next, /验证/);
  assert.equal(archive.steps[3].summary, "npm run build");
  assert.match(archive.steps[3].intent, /验证受影响行为/);
  assert.equal(archive.steps[4].expandedByDefault, true);
  assert.match(archive.steps[4].next, /调整目标|权限|方案/);
  assert.match(archive.summaryText, /5 步/);
  assert.match(archive.summaryText, /编辑 1/);
});

test("persisted tool intent summaries win over deterministic fallback", () => {
  const archive = buildTurnProcessArchiveModel({
    blocks: [
      { id: 1, type: "user", content: "run" },
      {
        id: 2,
        type: "tool",
        toolName: "execute_command",
        target: "node scripts/check.js",
        status: "done",
        toolStatus: "executed",
        intentSummary: "用已有脚本检查归档 UI 状态。",
      },
      { id: 3, type: "agent", content: "done" },
    ],
    finalVisibleAgentIndex: 2,
    language: "zh",
  });

  assert.equal(archive.steps.length, 1);
  assert.equal(archive.steps[0].intent, "用已有脚本检查归档 UI 状态。");
});

test("model notes become the strategy text for the following tool step", () => {
  const note = "已经定位到 ChatArea 的归档入口；下一步读取组件实现，确认本轮步骤如何渲染。";
  const archive = buildTurnProcessArchiveModel({
    blocks: [
      { id: 1, type: "user", content: "修复本轮步骤" },
      { id: 2, type: "agent", content: note, hiddenProcess: true, streaming: false },
      { id: 3, type: "tool", toolName: "read_file", target: "src/components/ChatArea.tsx", status: "done", toolStatus: "executed" },
      { id: 4, type: "agent", content: "完成。", streaming: false },
    ],
    finalVisibleAgentIndex: 3,
    language: "zh",
  });

  assert.equal(archive.steps.length, 1);
  assert.equal(archive.steps[0].kind, "inspect");
  assert.equal(archive.steps[0].intent, note);
  assert.equal(archive.steps[0].items.length, 2);
  assert.match(archive.steps[0].summary, /src\/components\/ChatArea\.tsx/);
});

test("user-visible progress blocks are not treated as hidden process text", () => {
  const progress = {
    id: 2,
    type: "progress",
    phase: "investigating",
    title: "读取 ChatArea 渲染逻辑",
    why: "确认 hiddenProcess 是否导致公开说明不可见。",
    action: "正在读取 ChatArea 渲染逻辑。",
    evidence: "等待文件内容作为证据。",
    next: "根据结果决定 store 与组件修改范围。",
    targets: ["src/components/ChatArea.tsx"],
    status: "running",
    source: "runtime",
  };
  const model = buildLiveTurnProcessTimelineModel({
    language: "zh",
    blocks: [
      progress,
      { id: 3, type: "tool", toolName: "read_file", target: "src/components/ChatArea.tsx", status: "running", toolStatus: "running" },
    ],
  });

  assert.equal(model.totalCount, 2);
  assert.equal(model.steps.length, 1);
  assert.equal(model.steps[0].kind, "inspect");
  assert.match(model.steps[0].intent, /正在读取 ChatArea 渲染逻辑/);
  assert.match(model.steps[0].intent, /hiddenProcess/);
  assert.equal(model.steps[0].items[0].type, "progress");
});

test("live timeline groups repeated edits under one strategy until the next explicit note", () => {
  const firstNote = "先按同一视觉方案更新设计文档、样式和入口文件。";
  const secondNote = "修改完成后运行构建验证结果。";
  const model = buildLiveTurnProcessTimelineModel({
    language: "zh",
    blocks: [
      { id: 1, type: "agent", content: firstNote, hiddenProcess: true, streaming: false },
      {
        id: 2,
        type: "tool",
        toolName: "replace_in_file",
        target: ".MAIN/plans/plan.md",
        status: "done",
        toolStatus: "executed",
        diff: { old: "a", new: "b", path: ".MAIN/plans/plan.md" },
      },
      { id: 3, type: "agent", content: firstNote, hiddenProcess: true, streaming: false },
      {
        id: 4,
        type: "tool",
        toolName: "replace_in_file",
        target: "src/styles/main.css",
        status: "done",
        toolStatus: "executed",
        diff: { old: "a", new: "b", path: "src/styles/main.css" },
      },
      {
        id: 5,
        type: "tool",
        toolName: "replace_in_file",
        target: "index.html",
        status: "done",
        toolStatus: "executed",
        diff: { old: "a", new: "b", path: "index.html" },
      },
      { id: 6, type: "agent", content: secondNote, hiddenProcess: true, streaming: false },
      { id: 7, type: "tool", toolName: "execute_command", target: "npm run build", status: "done", toolStatus: "executed" },
    ],
  });

  assert.equal(model.steps.length, 2);
  assert.equal(model.steps[0].kind, "edit");
  assert.equal(model.steps[0].intent, firstNote);
  assert.match(model.steps[0].summary, /3 次文件修改/);
  assert.deepEqual(model.steps[0].targets, [".MAIN/plans/plan.md", "src/styles/main.css", "index.html"]);
  assert.equal(model.steps[1].kind, "verify");
  assert.equal(model.steps[1].intent, secondNote);
});

test("thin repeated edit narrations collapse into one synthesized strategy row", () => {
  const model = buildLiveTurnProcessTimelineModel({
    language: "zh",
    blocks: [
      { id: 1, type: "agent", content: "按方案修改目标文件。", hiddenProcess: true, streaming: false },
      {
        id: 2,
        type: "tool",
        toolName: "replace_in_file",
        target: ".MAIN/plans/plan.md",
        status: "done",
        toolStatus: "executed",
        diff: { old: "a", new: "b", path: ".MAIN/plans/plan.md" },
      },
      { id: 3, type: "agent", content: "按方案修改目标文件。", hiddenProcess: true, streaming: false },
      {
        id: 4,
        type: "tool",
        toolName: "replace_in_file",
        target: "src/styles/main.css",
        status: "done",
        toolStatus: "executed",
        diff: { old: "a", new: "b", path: "src/styles/main.css" },
      },
      { id: 5, type: "agent", content: "按方案修改目标文件。", hiddenProcess: true, streaming: false },
      {
        id: 6,
        type: "tool",
        toolName: "replace_in_file",
        target: "index.html",
        status: "done",
        toolStatus: "executed",
        diff: { old: "a", new: "b", path: "index.html" },
      },
    ],
  });

  assert.equal(model.steps.length, 1);
  assert.equal(model.steps[0].kind, "edit");
  assert.match(model.steps[0].intent, /按同一修改策略完成 3 次文件修改/);
  assert.doesNotMatch(model.steps[0].intent, /按方案修改目标文件/);
  assert.deepEqual(model.steps[0].targets, [".MAIN/plans/plan.md", "src/styles/main.css", "index.html"]);
});

test("path-specific notes compare by strategy so same-purpose edits stay grouped", () => {
  const model = buildLiveTurnProcessTimelineModel({
    language: "zh",
    blocks: [
      { id: 1, type: "agent", content: "我会修改 `src/main.js` 的排版入口。", hiddenProcess: true, streaming: false },
      {
        id: 2,
        type: "tool",
        toolName: "replace_in_file",
        target: "src/main.js",
        status: "done",
        toolStatus: "executed",
        diff: { old: "a", new: "b", path: "src/main.js" },
      },
      { id: 3, type: "agent", content: "我会修改 `src/styles/main.css` 的排版入口。", hiddenProcess: true, streaming: false },
      {
        id: 4,
        type: "tool",
        toolName: "replace_in_file",
        target: "src/styles/main.css",
        status: "done",
        toolStatus: "executed",
        diff: { old: "a", new: "b", path: "src/styles/main.css" },
      },
    ],
  });

  assert.equal(model.steps.length, 1);
  assert.equal(model.steps[0].kind, "edit");
  assert.match(model.steps[0].summary, /2 次文件修改/);
  assert.deepEqual(model.steps[0].targets, ["src/main.js", "src/styles/main.css"]);
});

test("runtime phase metadata keeps stable titles and ignores changing process notes", () => {
  const contextPhase = {
    id: "context",
    kind: "context",
    title: "关键上下文",
    summary: "读取主题、数据链路和布局相关实现，证据说明可以换行保留。",
    domain: "theme_ui",
    status: "running",
  };
  const model = buildLiveTurnProcessTimelineModel({
    language: "zh",
    blocks: [
      { id: 1, type: "agent", turnPhase: contextPhase, content: "现在读取 ThemeStyles，确认主题变量。", hiddenProcess: true, streaming: false },
      { id: 2, type: "tool", turnPhase: contextPhase, toolName: "read_file", target: "src/components/ThemeStyles.tsx", status: "done", toolStatus: "executed" },
      { id: 3, type: "agent", turnPhase: contextPhase, content: "现在读取 App.css，确认 sidebar 硬编码。", hiddenProcess: true, streaming: false },
      { id: 4, type: "tool", turnPhase: contextPhase, toolName: "read_file", target: "src/App.css", status: "done", toolStatus: "executed" },
    ],
  });

  assert.equal(model.steps.length, 1);
  assert.equal(model.steps[0].phase.title, "关键上下文");
  assert.equal(model.steps[0].intent, "关键上下文");
  assert.match(model.steps[0].summary, /证据说明可以换行保留/);
  assert.doesNotMatch(model.steps[0].intent, /ThemeStyles|App\.css/);
});

test("runtime phase grouping keeps large read-only batches in one codex-style exploring cell", () => {
  const phase = {
    id: "context",
    kind: "context",
    title: "关键上下文",
    summary: "读取必要上下文。",
    domain: "data_pipeline",
    status: "running",
  };
  const blocks = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    type: "tool",
    turnPhase: phase,
    toolName: "read_file",
    target: `src/data/file-${index + 1}.ts`,
    status: "done",
    toolStatus: "executed",
  }));
  const model = buildLiveTurnProcessTimelineModel({ language: "zh", blocks });

  assert.equal(model.steps.length, 1);
  assert.equal(model.steps[0].phase.title, "关键上下文");
  assert.equal(model.steps[0].items.filter((item) => item.type === "tool").length, 10);
  assert.equal(model.steps[0].activity.kind, "exploring");
  assert.match(model.steps[0].activity.title, /已探索/);
});

test("runtime phase grouping keeps same-purpose exploration together across target domains", () => {
  const basePhase = {
    id: "context",
    kind: "context",
    title: "关键上下文",
    summary: "读取必要上下文。",
    status: "running",
  };
  const model = buildLiveTurnProcessTimelineModel({
    language: "zh",
    blocks: [
      {
        id: 1,
        type: "tool",
        turnPhase: { ...basePhase, domain: "theme_ui" },
        toolName: "read_file",
        target: "src/components/ThemeStyles.tsx",
        status: "done",
        toolStatus: "executed",
      },
      {
        id: 2,
        type: "tool",
        turnPhase: { ...basePhase, domain: "data_pipeline" },
        toolName: "read_file",
        target: "src/hooks/useCsvParser.ts",
        status: "done",
        toolStatus: "executed",
      },
    ],
  });

  assert.equal(model.steps.length, 1);
  assert.equal(model.steps[0].activity.kind, "exploring");
  assert.match(model.steps[0].activity.title, /读取 ThemeStyles\.tsx/);
  assert.match(model.steps[0].activity.summary, /2 个文件/);
  assert.deepEqual(model.steps[0].targets, ["src/components/ThemeStyles.tsx", "src/hooks/useCsvParser.ts"]);
  assert.equal(model.steps[0].intent, "关键上下文");
});

test("codex activity groups merge read list and search into one exploring cell", () => {
  const groups = buildCodexActivityGroups([
    { id: 1, type: "tool", toolName: "read_file", target: "src/App.tsx", status: "done", toolStatus: "executed" },
    { id: 2, type: "tool", toolName: "list_directory", target: "src/components", status: "done", toolStatus: "executed" },
    { id: 3, type: "tool", toolName: "grep_search", target: "hiddenProcess", status: "done", toolStatus: "executed" },
  ], "zh");

  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "exploring");
  assert.match(groups[0].title, /已探索/);
  assert.match(groups[0].title, /读取 App\.tsx/);
  assert.match(groups[0].title, /搜索 hiddenProcess/);
  assert.match(groups[0].summary, /1 个文件/);
  assert.match(groups[0].summary, /1 个目录/);
  assert.match(groups[0].summary, /1 次搜索/);
});

test("codex activity groups include concrete result excerpts instead of generic exploration only", () => {
  const groups = buildCodexActivityGroups([
    {
      id: 1,
      type: "tool",
      toolName: "grep_search",
      target: "csv/import/loadData",
      status: "done",
      toolStatus: "executed",
      observationSummary: "命中 useCsvParser 与 dashboardStore 的导入链路。",
    },
    {
      id: 2,
      type: "tool",
      toolName: "read_file",
      target: "src/hooks/useCsvParser.ts",
      status: "done",
      toolStatus: "executed",
      resultPreview: "parseCsvRows maps uploaded rows into dashboard records.",
    },
  ], "zh");

  assert.equal(groups.length, 1);
  assert.match(groups[0].title, /搜索 csv\/import\/loadData/);
  assert.match(groups[0].title, /读取 useCsvParser\.ts/);
  assert.match(groups[0].summary, /useCsvParser 与 dashboardStore/);
  assert.match(groups[0].evidenceExcerpt, /dashboardStore/);
});

test("codex activity groups report repeated unchanged reads as one effective target", () => {
  const groups = buildCodexActivityGroups([
    {
      id: 1,
      type: "tool",
      toolName: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "done",
      toolStatus: "executed",
      observationSummary: "找到 CSV 导入后的 store 写入入口。",
    },
    {
      id: 2,
      type: "tool",
      toolName: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "done",
      toolStatus: "executed",
      message: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts",
    },
    {
      id: 3,
      type: "tool",
      toolName: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "done",
      toolStatus: "executed",
      message: "Repeated read-only tool call skipped: read_file target dashboardStore.ts",
    },
  ], "zh");

  assert.equal(groups.length, 1);
  assert.match(groups[0].title, /dashboardStore\.ts x3/);
  assert.match(groups[0].summary, /1 个文件/);
  assert.match(groups[0].summary, /重复：src\/store\/dashboardStore\.ts ×3/);
  assert.match(groups[0].summary, /2 次缓存复用/);
});

test("codex activity groups keep edits commands browser and failures separate", () => {
  const groups = buildCodexActivityGroups([
    {
      id: 1,
      type: "tool",
      toolName: "replace_in_file",
      target: "src/App.tsx",
      status: "done",
      toolStatus: "executed",
      diff: { old: "a", new: "b", path: "src/App.tsx", existed: true },
    },
    { id: 2, type: "tool", toolName: "run_command", target: "npm test", status: "done", toolStatus: "executed" },
    { id: 3, type: "tool", toolName: "browser_evaluate", target: "http://localhost:3000", status: "done", toolStatus: "executed" },
    { id: 4, type: "tool", toolName: "read_file", target: "missing.ts", status: "error", toolStatus: "failed", message: "ENOENT" },
  ], "zh");

  assert.deepEqual(groups.map((group) => group.kind), ["edit", "command", "browser", "exploring"]);
  assert.match(groups[0].title, /已编辑/);
  assert.match(groups[1].title, /已运行/);
  assert.match(groups[2].title, /浏览器验证/);
  assert.equal(groups[3].status, "failed");
});

test("internal Plan runtime phases stay out of activity groups and archives while real tools remain", () => {
  const blocks = [
    {
      id: 1,
      turnId: "turn-plan",
      type: "progress",
      phase: "investigating",
      title: "Needs evidence",
      why: "草稿缺少真实证据，临时开放一次定向只读补证（missing_plan_required_sections:read_evidence）。",
      action: "",
      evidence: "",
      next: "",
      targets: [],
      status: "running",
      source: "runtime",
      turnPhase: {
        id: "plan_needs_evidence",
        kind: "context",
        title: "Needs evidence",
        summary: "草稿缺少真实证据，临时开放一次定向只读补证。",
        domain: "plan_runtime",
        status: "running",
      },
    },
    {
      id: 2,
      turnId: "turn-plan",
      type: "tool",
      toolName: "read_file",
      target: "src/lib/orchestrator.ts",
      status: "done",
      toolStatus: "executed",
      observationSummary: "找到 PLAN_NOT_READY recoveryAction 分支。",
      qualityGateReason: "missing_plan_required_sections:read_evidence",
      turnPhase: {
        id: "plan_needs_evidence",
        kind: "context",
        title: "Needs evidence",
        summary: "草稿缺少真实证据，临时开放一次定向只读补证。",
        domain: "plan_runtime",
        status: "running",
      },
    },
    {
      id: 3,
      turnId: "turn-plan",
      type: "progress",
      phase: "summarizing",
      title: "Drafting",
      why: "把证据收束为可审批 plan.md。",
      action: "",
      evidence: "",
      next: "",
      targets: [],
      status: "running",
      source: "runtime",
      turnPhase: {
        id: "plan_drafting",
        kind: "diagnosis",
        title: "Drafting",
        summary: "把证据收束为可审批 plan.md。",
        domain: "plan_runtime",
        status: "running",
      },
    },
  ];
  const groups = buildCodexActivityGroups(blocks, "zh");
  const live = buildLiveTurnProcessTimelineModel({ blocks, language: "zh" });
  const archive = buildTurnProcessArchiveModel({
    blocks: [
      { id: 0, turnId: "turn-plan", type: "user", content: "生成计划" },
      ...blocks,
      { id: 4, turnId: "turn-plan", type: "agent", content: "计划已生成。" },
    ],
    finalVisibleAgentIndex: 4,
    language: "zh",
  });
  const projectVisibleActivity = (activity) => {
    const { items: _items, ...visibleActivity } = activity;
    return visibleActivity;
  };
  const projectVisibleTimeline = (model) => model.steps.map((step) => {
    const { items: _items, activity, ...visibleStep } = step;
    return {
      ...visibleStep,
      activity: activity ? projectVisibleActivity(activity) : undefined,
    };
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].type, "tool");
  assert.match(groups[0].title, /读取 orchestrator\.ts/);
  assert.doesNotMatch(
    JSON.stringify(groups.map(projectVisibleActivity)),
    /Needs evidence|Drafting|草稿缺少真实证据|read_evidence/,
  );

  assert.equal(live.totalCount, 1);
  assert.equal(live.blocks[0].type, "tool");
  assert.doesNotMatch(
    JSON.stringify(projectVisibleTimeline(live)),
    /Needs evidence|Drafting|草稿缺少真实证据|read_evidence/,
  );

  assert.equal(archive.totalCount, 1);
  assert.equal(archive.blocks[0].type, "tool");
  assert.doesNotMatch(
    JSON.stringify(projectVisibleTimeline(archive)),
    /Needs evidence|Drafting|草稿缺少真实证据|read_evidence/,
  );
});

test("execution checkpoints remain visible terminal notices instead of process steps", () => {
  const checkpoint = {
    id: 3,
    turnId: "turn-paused",
    type: "system",
    variant: "execution_checkpoint",
    content: "执行尚未完成，但已修改 src/main.js；浏览器发现运行时错误。",
  };
  const blocks = [
    {
      id: 1,
      turnId: "turn-paused",
      type: "tool",
      toolName: "replace_in_file",
      target: "src/main.js",
      toolStatus: "executed",
    },
    checkpoint,
  ];
  const live = buildLiveTurnProcessTimelineModel({ blocks, language: "zh" });
  assert.ok(live);
  assert.equal(live.blocks.some((block) => block.id === checkpoint.id), false);

  const archivedBlocks = [
    { id: 0, turnId: "turn-paused", type: "user", content: "修复按钮" },
    ...blocks,
    { id: 4, turnId: "turn-paused", type: "agent", content: "最终结论" },
  ];
  const archive = buildTurnProcessArchiveModel({
    blocks: archivedBlocks,
    finalVisibleAgentIndex: 3,
    language: "zh",
  });
  assert.equal(archive.blocks.some((block) => block.id === checkpoint.id), false);
});
