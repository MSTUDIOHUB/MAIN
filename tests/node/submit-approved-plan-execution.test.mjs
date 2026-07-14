import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildApprovedPlanExecutionPrompt,
  buildPlanCommandExecutionHint,
  detectRequestedRootMarkdownDeliverables,
  ensureApprovedPlanRuntimeTasksForState,
  evaluateApprovedPlanExecutionReadiness,
  formatPlanTaskListForPrompt,
  normalizeApprovedPlanTaskStatuses,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitApprovedPlanExecution.ts"),
);
const {
  collectRuntimeTaskCandidateLines,
  inferPlanTaskEvidence,
  isRuntimeTaskActionableText,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

function task(overrides = {}) {
  return {
    id: "task-1",
    text: "运行 `npm test`",
    completed: false,
    source: "runtime",
    evidence: [{ kind: "cmd", value: "npm test" }],
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return {
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    isPlanApproved: true,
    currentTurnId: "turn-1",
    conversationTurns: [
      {
        id: "turn-1",
        userPrompt: "请在项目根目录生成 Report.md 和 plan.md",
      },
    ],
    ...overrides,
  };
}

function reviewablePlanArtifact(content, overrides = {}) {
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    revision: 1,
    updatedAt: 1,
    content,
    ...overrides,
  };
}

function executableMutationPlan() {
  return [
    "# 文件打开链路修复计划",
    "",
    "## 摘要",
    "- 用户目标：修复 Markdown 文件打开事件与前端入口不一致的问题。",
    "",
    "## 已确认证据",
    "- 已读取 `src/main.js` 并确认 `openFile` 是前端入口。",
    "- 已读取 `src-tauri/src/main.rs` 并确认后端事件名称不一致。",
    "",
    "## 关键改动",
    "- 修改 `src/main.js`，统一 `openFile` 接收的文件路径 payload。",
    "- 修改 `src-tauri/src/main.rs`，统一单实例与系统文件打开事件名称。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 不新增公共 API；内部文件打开事件 payload 保持字符串路径。",
    "",
    "## 测试方案",
    "- 运行 `npm test` 验证前端文件打开事件回归测试。",
    "- 运行 `cargo check` 验证 Tauri 后端编译。",
    "",
    "## 假设与默认值",
    "- 默认保持编辑器和预览渲染行为不变。",
  ].join("\n");
}

function loggedNonExecutableMdViewerPlan() {
  return [
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：修复双击 Markdown 文件后无法打开的问题。",
    "",
    "## 已确认证据",
    "- 已读取文件：src-tauri/src/main.rs。",
    "- 已读取文件：src/main.js。",
    "",
    "## 关键改动",
    "- 将 `app.on(\"open\", ...)` 改为 `app_handle.on_open_url(...)`。",
    "- 确保 `SingleInstance` 的回调正确处理文件路径。",
    "- 确保 `open_files` 命令正确触发前端事件。",
    "- 确认 `dialog.open()` 的 Tauri v2 正确调用方式。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化。",
    "",
    "## 测试方案",
    "- `main.rs` 中 `on_open_files` 事件监听器使用了错误的 API 名称。",
    "- `src/main.js` 中 `dialog.open()` 的调用方式与 Tauri v2 不兼容。",
    "- 需要读取 `src/main.js` 中 `openFile` 函数的完整实现以确认 dialog 调用细节。",
    "- 确保 `SingleInstance` 正确传递文件路径给已运行的实例。",
    "- 确保前端能接收并处理 `file-open` 事件。",
    "",
    "## 假设与默认值",
    "- 默认保持编辑器其他行为不变。",
  ].join("\n");
}

function themedDiagnosisNestedMutationPlan() {
  return [
    "# 白屏修复计划",
    "",
    "## 摘要",
    "- 用户目标：修复 MD Viewer 启动白屏，并在初始化失败时显示错误。",
    "",
    "## 已确认证据",
    "- 已读取 `src/main.js`，确认 DOMContentLoaded 调用 init。",
    "",
    "## 白屏问题诊断",
    "### 观察到的现象",
    "1. `src/main.js` 第 24 行：`document.addEventListener('DOMContentLoaded', handler)` 是唯一入口点。",
    "2. `init()` 中没有错误处理。",
    "",
    "## 改动方案",
    "### 1. 修改 `src/main.js` — 添加错误处理",
    "- 在 DOMContentLoaded 回调中捕获 init 异常并显示错误层。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 不改变公共 API。",
    "",
    "## 测试方案",
    "- 运行 `npm run dev` 启动开发服务器。",
    "- 使用浏览器验证页面能正常渲染。",
    "",
    "## 假设与默认值",
    "- 保持现有编辑与预览行为不变。",
  ].join("\n");
}

function realQwenCsvRecoveryPlan() {
  return [
    "# Proposed Plan",
    "",
    "## 1. 目标与验收标准",
    "- **目标**：修复 `src/hooks/useCsvParser.ts` 中的 `normalizeCsvOrder`，将 CSV creator 映射为 `creatorName`。",
    "- **验收标准**：",
    "  1. 返回对象必须包含 `creatorName`。",
    "  2. Dashboard 能正确显示 creator 信息。",
    "",
    "## 2. 现状分析（基于只读证据）",
    "- `normalizeCsvOrder` 当前只返回 `creator`，下游读取 `creatorName`。",
    "",
    "## 3. 实施步骤",
    "1. **修改 `src/hooks/useCsvParser.ts`**：",
    "   - 更新 `normalizeCsvOrder` 返回对象，添加 `creatorName: row.creator || row['创建者'] || ''`。",
    "",
    "## 4. 影响范围",
    "- `src/types/order.ts` 无需修改。",
    "",
    "## 5. 风险与回滚",
    "- 若验证失败，恢复原始字段映射。",
    "",
    "## 6. 测试方案",
    "- **手动验证**：",
    "  - 使用 `cn_tutorial_orders_by_creator_20260512.csv` 进行测试。",
    "  - 观察 Dashboard 是否正确显示 creator 信息。",
    "- **代码审查**：",
    "  - 确认 `normalizeCsvOrder` 的返回值与 `Order` 接口兼容。",
    "",
    "## 7. 假设与默认值",
    "- 保留现有 `creator` 字段以兼容既有调用。",
  ].join("\n");
}

test("approved plan execution detects requested root markdown deliverables", () => {
  assert.deepEqual(
    detectRequestedRootMarkdownDeliverables("Write project root CHANGELOG.md and README.md, ignore plan.md"),
    ["CHANGELOG.md", "Readme.md"],
  );
  assert.deepEqual(
    detectRequestedRootMarkdownDeliverables("请在项目根目录生成总结 md 文档"),
    ["Readme.md"],
  );
});

test("approved plan execution formats task list and command hints", () => {
  const tasks = [task(), task({ id: "task-2", text: "修复 src/App.tsx", evidence: [{ kind: "file", value: "src/App.tsx" }] })];

  const list = formatPlanTaskListForPrompt(tasks, "zh");
  const hint = buildPlanCommandExecutionHint(tasks, "zh");

  assert.match(list, /1\. 运行 `npm test` \[cmd:npm test\]/);
  assert.match(list, /2\. 修复 src\/App\.tsx \[file:src\/App\.tsx\]/);
  assert.match(hint, /运行 `npm test`/);
  assert.match(hint, /run_command/);
});

test("approved plan execution prompt preserves runtime task and requested deliverable hints", () => {
  const prompt = buildApprovedPlanExecutionPrompt({
    state: baseState({
      planArtifacts: [
        {
          kind: "design",
          path: ".MAIN/plans/design.md",
          title: "Design",
          content: "# Design",
          updatedAt: 1,
        },
      ],
    }),
    language: "zh",
    executionPlanTasks: [task({ text: "实现 Report.md 输出 — 证据: file:Report.md" })],
    normalizedApprovalChoice: "execute",
  });

  assert.match(prompt, /计划已批准/);
  assert.match(prompt, /按当前任务清单顺序执行/);
  assert.match(prompt, /项目根目录 `Report\.md`/);
  assert.match(prompt, /MAIN 已经从批准后的 design 派生出 runtime 任务清单/);
  assert.match(prompt, /实现 Report\.md 输出/);
});

test("approved plan execution normalizes existing runtime tasks without requiring plan artifacts", () => {
  const state = baseState({
    planTasks: [task({ id: "task-1", completed: true })],
  });

  const normalized = ensureApprovedPlanRuntimeTasksForState(state, "en");
  const statuses = normalizeApprovedPlanTaskStatuses(state.planTasks, [], true);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].text, "运行 `npm test`");
  assert.equal(statuses.length, 1);
});

test("approval readiness rejects the logged MD Viewer plan before deriving a child execution run", () => {
  const artifact = reviewablePlanArtifact(loggedNonExecutableMdViewerPlan());
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    isPlanApproved: false,
  }), "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, false);
  assert.equal(readiness.stopClass, "plan_execution_materialization_failed");
  assert.equal(readiness.reason, "plan_artifact_quality_rejected");
  assert.equal(readiness.qualityReason, "non_executable_test_plan");
});

test("approval readiness rejects a mutation title with evidence and tests but no mutation section", () => {
  const artifact = reviewablePlanArtifact([
    "# Fix initialization error handling",
    "",
    "## Summary",
    "- User goal: Add startup error handling in `src/main.js`.",
    "",
    "## Evidence",
    "- Confirmed `src/main.js` owns startup listener registration.",
    "",
    "## Test Plan",
    "- Run `npm test` and verify startup errors are surfaced.",
    "",
    "## Validation",
    "- Startup failures report an error without a blank screen.",
  ].join("\n"));
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    planTasks: [],
    isPlanApproved: false,
  }), "en");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, "plan_artifact_quality_rejected");
  assert.match(readiness.qualityReason || "", /execution_steps/);
  assert.equal(readiness.concreteMutationTaskCount, 0);
});

test("approval readiness rejects a bogus read-only runtime task for a mutation plan", () => {
  const artifact = reviewablePlanArtifact(executableMutationPlan());
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks: [{
      id: "task-read-open-file",
      text: "需要读取 `src/main.js` 中 `openFile` 函数的完整实现以确认 dialog 调用细节",
      status: "pending",
      evidence: [{ kind: "file", value: "src/main.js" }],
    }],
  });

  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, "runtime_task_set_not_executable");
  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.concreteMutationTaskCount, 0);
  assert.equal(readiness.executableValidationTaskCount, 0);
});

test("approval readiness preserves a nested mutation under a themed diagnosis plan", () => {
  const artifact = reviewablePlanArtifact(themedDiagnosisNestedMutationPlan());
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    planTasks: [],
    isPlanApproved: false,
  }), "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.concreteMutationTaskCount, 1);
  assert.equal(
    executionPlanTasks.some((task) => /唯一入口点/.test(task.text)),
    false,
  );
  assert.equal(
    executionPlanTasks.filter((task) =>
      task.evidence?.some((entry) => entry.kind === "file" && entry.value === "src/main.js")
    ).length,
    1,
  );
});

test("approval readiness projects the recovered Qwen plan into mutation and executable validation roles", () => {
  const artifact = reviewablePlanArtifact(realQwenCsvRecoveryPlan());
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    planTasks: [],
    isPlanApproved: false,
  }), "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.equal(readiness.concreteMutationTaskCount, 1);
  assert.ok(readiness.executableValidationTaskCount >= 1);
  assert.ok(executionPlanTasks.some((task) =>
    task.executionKind === "mutation" &&
    task.evidence?.some((entry) => entry.kind === "file" && entry.value === "src/hooks/useCsvParser.ts")
  ), JSON.stringify(executionPlanTasks));
  assert.ok(executionPlanTasks.some((task) =>
    task.executionKind === "validation" &&
    task.evidence?.some((entry) => entry.kind === "browser_dom" || entry.kind === "cmd")
  ), JSON.stringify(executionPlanTasks));
  assert.equal(executionPlanTasks.some((task) =>
    task.executionKind === "observation" &&
    task.evidence?.some((entry) => entry.value === "cn_tutorial_orders_by_creator_20260512.csv")
  ), false, JSON.stringify(executionPlanTasks));
});

test("approval readiness keeps mutation intent from a combined diagnosis and fix heading", () => {
  const artifact = reviewablePlanArtifact([
    "# 白屏修复计划",
    "",
    "## 摘要",
    "- 用户目标：修复初始化白屏，并在启动失败时显示明确错误。",
    "",
    "## 已确认证据",
    "- 已读取 `src/main.js`，确认初始化入口与错误处理缺口。",
    "",
    "## 问题诊断与修复方案",
    "### 诊断证据",
    "- `src/main.js` 当前只有一个初始化入口。",
    "### 修改 `src/main.js`",
    "- 在入口回调中添加初始化错误处理，并保留现有成功路径。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 不改变公共 API、接口或类型。",
    "",
    "## 测试方案",
    "- 运行 `npm test`。",
    "",
    "## 假设与默认值",
    "- 保持现有 UI 行为不变。",
  ].join("\n"));
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    planTasks: [],
    isPlanApproved: false,
  }), "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.concreteMutationTaskCount, 1);
  assert.equal(executionPlanTasks.some((task) => /当前只有一个初始化入口/.test(task.text)), false);
});

test("approval readiness recognizes an English diagnosis and fix plan with a file-only child heading", () => {
  const artifact = reviewablePlanArtifact([
    "# Startup error handling plan",
    "",
    "## Summary",
    "- User goal: add visible initialization error handling without changing the success path.",
    "",
    "## Confirmed Evidence",
    "- Read `src/main.js` and confirmed it owns the initialization entry point.",
    "",
    "## Diagnosis and Fix Plan",
    "### `src/main.js`",
    "- Add initialization error handling while preserving the existing success path.",
    "",
    "## Public APIs / Interfaces / Types",
    "- No public API, interface, or type changes.",
    "",
    "## Test Plan",
    "- Run `npm test` and verify the focused regression passes.",
    "",
    "## Assumptions",
    "- Preserve the current UI behavior on successful startup.",
  ].join("\n"));
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    planTasks: [],
    isPlanApproved: false,
  }), "en");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.concreteMutationTaskCount, 1);
  assert.ok(readiness.executableValidationTaskCount >= 1);
});

test("approval readiness projects local-model plans with bare section and file labels", () => {
  const artifact = reviewablePlanArtifact([
    "# Startup error handling plan",
    "",
    "Summary",
    "- User goal: add visible initialization error handling without changing the success path.",
    "",
    "Confirmed Evidence",
    "- Read `src/main.js` and confirmed it owns initialization.",
    "",
    "Fix Plan",
    "src/main.js",
    "- Add initialization error handling while preserving successful startup.",
    "",
    "Test Plan",
    "- Run `npm test` and verify the focused regression passes.",
  ].join("\n"));
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    planTasks: [],
    isPlanApproved: false,
  }), "en");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.concreteMutationTaskCount, 1);
  assert.ok(readiness.executableValidationTaskCount >= 1);
});

test("one composite plan step preserves both source mutation and validation obligations", () => {
  const artifact = reviewablePlanArtifact([
    "# Initialization fix plan",
    "",
    "## Summary",
    "- User goal: add initialization error handling and verify it with the focused test.",
    "",
    "## Confirmed Evidence",
    "- Read `src/main.js` and confirmed it owns initialization.",
    "",
    "## Key Changes",
    "- Modify `src/main.js` to catch initialization failures, then run `npm test` to verify the regression.",
    "",
    "## Public APIs / Interfaces / Types",
    "- No public API, interface, or type changes.",
  ].join("\n"));
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    planTasks: [],
    isPlanApproved: false,
  }), "en");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.equal(readiness.concreteMutationTaskCount, 1);
  assert.equal(readiness.executableValidationTaskCount, 1);
});

test("approval readiness accepts a semantically valid mutation plan with concrete mutation and validation tasks", () => {
  const artifact = reviewablePlanArtifact(executableMutationPlan());
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    isPlanApproved: false,
  }), "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify(readiness));
  assert.equal(readiness.stopClass, null);
  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.requiresExecutableValidation, true);
  assert.ok(readiness.concreteMutationTaskCount >= 1);
  assert.ok(readiness.executableValidationTaskCount >= 1);
});

test("approval readiness materializes semantic validation outcomes without requiring a model-authored command", () => {
  const artifact = reviewablePlanArtifact([
    "# 修复 CSV 字段映射",
    "",
    "## 已确认证据",
    "- `src/hooks/useCsvParser.ts` 当前只填充 creator。",
    "",
    "## 关键实现改动",
    "- 修改 `src/hooks/useCsvParser.ts`，将 creator 同步映射到 creatorName。",
    "",
    "## 验证方式",
    "1. 检查 normalizeCsvOrder 的返回对象是否同时包含正确的 creator 和 creatorName。",
    "2. 上传包含 creator 列的 CSV，确认 Dashboard 界面显示正常。",
  ].join("\n"));
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    isPlanApproved: false,
  }), "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.ok(executionPlanTasks.some((entry) =>
    entry.evidence?.some((evidence) =>
      evidence.kind === "cmd" && evidence.value === "focused validation command"
    )
  ));
  assert.ok(readiness.executableValidationTaskCount >= 1);
});

test("approval readiness preserves semantic validation flattened into a canonical key-changes section", () => {
  const artifact = reviewablePlanArtifact([
    "# 计划",
    "",
    "## 摘要",
    "- 修复 CSV creator 到 creatorName 的字段映射。",
    "",
    "## 已确认证据",
    "- 已读取文件：src/hooks/useCsvParser.ts；当前 normalizeCsvOrder 只填充 creator。",
    "",
    "## 关键改动",
    "- 关键实现改动",
    "- **修改 `normalizeCsvOrder` 函数**：在返回对象中增加 `creatorName` 的映射逻辑。",
    "- **映射规则**：从 CSV 行读取 `creator` 或 `创建者` 并赋给 `creatorName`。",
    "- 验证方案",
    "- **静态检查**：确保 `CsvOrder` 接口的类型定义与映射逻辑一致。",
    "- **逻辑验证**（待执行阶段）：通过模拟包含 `creator` 或 `创建者` 列的 CSV 行数据，验证生成的 `CsvOrder` 对象是否同时包含正确的 `creatorName`。",
    "- 在 `src/hooks/useCsvParser.ts` 的证据已确认实现边界实施必要改动，保持无关行为不变，并验证对应用户目标链路。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化；如果执行中证明必须改变，先暂停确认。",
    "",
    "## 测试方案",
    "- 验证方案",
    "- **静态检查**：确保 `CsvOrder` 接口的类型定义与映射逻辑一致。",
    "- **逻辑验证**（待执行阶段）：通过模拟包含 `creator` 或 `创建者` 列的 CSV 行数据，验证生成的 `CsvOrder` 对象是否同时包含正确的 `creatorName`。",
    "",
    "## 假设与默认值",
    "- 默认保持未点名的公共 API、接口和类型不变。",
  ].join("\n"));
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    isPlanApproved: false,
  }), "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.ok(executionPlanTasks.some((entry) =>
    entry.evidence?.some((evidence) =>
      evidence.kind === "cmd" && evidence.value === "focused validation command"
    )
  ), JSON.stringify(executionPlanTasks));
});

test("approval readiness recognizes a mutation verb after a concrete file target", () => {
  const artifact = reviewablePlanArtifact(executableMutationPlan());
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks: [
      {
        id: "task-file-mutation",
        text: "在 `src/main.js` 中修改 `openFile` 的 payload 处理",
        status: "pending",
        evidence: [{ kind: "file", value: "src/main.js" }],
      },
      {
        id: "task-validation",
        text: "运行 `npm test` 验证文件打开回归",
        status: "pending",
        commands: ["npm test"],
        evidence: [{ kind: "cmd", value: "npm test" }],
      },
    ],
  });

  assert.equal(readiness.ok, true, readiness.reason);
  assert.equal(readiness.concreteMutationTaskCount, 1);
});

test("approval task projection preserves long grounded PlanCandidate changes", () => {
  const longChange = [
    "修复 `src/hooks/useCsvParser.ts`，在 normalizeCsvOrder 中保留现有 creator 映射并同步赋值 creatorName，",
    "使 Dashboard、图表聚合和 Order 接口读取同一规范字段；继续兼容中文创建者列，避免旧 CSV 导入行为回退，",
    "并以已经读取的 useCsvParser、Order 类型与 dashboardStore 证据作为实现边界。",
    "同时不改动图表组件、状态仓库或公开数据模型，只在解析边界完成字段规范化，并确保空值与旧字段 fallback 顺序保持稳定。",
  ].join("");
  assert.ok(longChange.length > 220);
  const artifact = reviewablePlanArtifact([
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：修复 CSV creator 到 creatorName 的映射。",
    "",
    "## 已确认证据",
    "- `src/hooks/useCsvParser.ts` 当前只赋值 creator。",
    "",
    "## 关键改动",
    `- ${longChange}`,
    "",
    "## 公共 API 与类型",
    "- 不改变公共接口。",
    "",
    "## 测试方案",
    "- 运行 `npm test` 验证映射。",
    "",
    "## 假设与默认值",
    "- 保持 creator 向后兼容。",
  ].join("\n"));
  const state = baseState({ planArtifacts: [artifact], isPlanApproved: false });
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(state, "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.ok(executionPlanTasks.some((entry) =>
    entry.evidence?.some((evidence) => evidence.kind === "file" && evidence.value === "src/hooks/useCsvParser.ts")
  ));
  assert.equal(readiness.ok, true, JSON.stringify(readiness));
  assert.equal(readiness.concreteMutationTaskCount, 1, JSON.stringify(executionPlanTasks));
});

test("approval task projection keeps the real OMLX deterministic evidence change", () => {
  const artifact = reviewablePlanArtifact([
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：请修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。先生成可审批计划，批准后真实修改并验证。",
    "- 定向证据已覆盖：`src/hooks/useCsvParser.ts`。",
    "",
    "## 已确认证据",
    "- read file src/hooks/useCsvParser.ts: L1: export interface CsvOrder L2: creator?: string; L6: export function normalizeCsvOrder(row: Record<string, string ): CsvOrder L7: return L8: creator: row.creator || row '创建者' || ''...",
    "- read file src/types/order.ts: L1: export interface Order creatorName: string; amount: number; status?: string;",
    "- read file src/store/dashboardStore.ts: L1: export const creatorField = 'creatorName';",
    "",
    "## 关键改动",
    "- 修复 `src/hooks/useCsvParser.ts` 的 CSV 列名到订单字段映射，确保 creator、course、date、status、amount 等 Dashboard 所需字段不会在导入时丢失。依据证据：read file src/hooks/useCsvParser.ts: L1: export interface CsvOrder L2: creator?: string; L6: export function normalizeCsvOrder(row: Record<string, string ): CsvOrder L7: return L8: creator: row.creator || row '创建者' || ''...。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 默认不新增或修改公共 API、接口或类型；如果执行中证明必须扩大接口范围，先暂停确认。",
    "",
    "## 测试方案",
    "- 运行受影响子系统的聚焦测试、构建检查或浏览器/桌面验证，并记录结果。",
    "",
    "## 假设与默认值",
    "- 默认实施满足已批准目标的最小变更。",
  ].join("\n"));
  const state = baseState({ planArtifacts: [artifact], isPlanApproved: false });
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(state, "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({
    readiness,
    executionPlanTasks,
    candidates: collectRuntimeTaskCandidateLines(artifact.content),
    directEvidence: inferPlanTaskEvidence("修复 `src/hooks/useCsvParser.ts` 的 CSV 列名到订单字段映射，确保 creatorName 正确赋值。"),
    actionable: isRuntimeTaskActionableText("修复 `src/hooks/useCsvParser.ts` 的 CSV 列名到订单字段映射，确保 creator、course、date、status、amount 等 Dashboard 所需字段不会在导入时丢失。依据证据：read file src/hooks/useCsvParser.ts: L1: export interface CsvOrder L2: creator?: string; L6: export function normalizeCsvOrder(row: Record<string, string ): CsvOrder L7: return L8: creator: row.creator || row '创建者' || ''...。"),
  }));
  assert.ok(executionPlanTasks.some((entry) =>
    entry.evidence?.some((evidence) => evidence.kind === "file" && evidence.value === "src/hooks/useCsvParser.ts")
  ));
});

test("approval readiness treats a plain prose change section as mutation-oriented", () => {
  const artifact = reviewablePlanArtifact([
    "# Proposed Plan: 修复 CSV creator 字段映射",
    "",
    "## 问题",
    "`src/hooks/useCsvParser.ts` 缺少 creatorName 映射。",
    "",
    "## 改动",
    "**文件**: `src/hooks/useCsvParser.ts`",
    "",
    "修改 `normalizeCsvOrder` 函数，将 CSV 的 creator 字段映射到 creatorName。",
    "",
    "## 验证",
    "1. 运行与受影响范围匹配的聚焦测试。",
  ].join("\n"));
  const state = baseState({ planArtifacts: [artifact], isPlanApproved: false });
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(state, "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.concreteMutationTaskCount, 1, JSON.stringify(executionPlanTasks));
  assert.equal(readiness.ok, true, JSON.stringify(readiness));
});

test("approval task projection keeps an explicit modification file when its detail uses a domain verb", () => {
  const artifact = reviewablePlanArtifact([
    "# Proposed Plan",
    "",
    "## 1. 目标",
    "修复 `src/hooks/useCsvParser.ts`，使 CSV creator 正确映射到 creatorName。",
    "",
    "## 2. 根因分析",
    "- 当前解析结果缺少 creatorName。",
    "",
    "## 3. 实现改动",
    "**修改文件**：`src/hooks/useCsvParser.ts`",
    "",
    "**具体逻辑**：",
    "在 `normalizeCsvOrder` 函数中，将 `creator` 字段的值同时赋值给 `creatorName`。",
    "",
    "## 4. 测试方案",
    "1. 类型检查：确保 `CsvOrder` 接口包含 `creatorName` 字段。",
    "2. 逻辑验证：确认 Dashboard 优先读取 `creatorName`。",
  ].join("\n"));
  const state = baseState({ planArtifacts: [artifact], isPlanApproved: false });
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(state, "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.equal(readiness.concreteMutationTaskCount, 1, JSON.stringify(executionPlanTasks));
  assert.ok(executionPlanTasks.some((entry) =>
    entry.evidence?.some((evidence) =>
      evidence.kind === "file" && evidence.value === "src/hooks/useCsvParser.ts"
    )
  ));
});

test("approval readiness preserves the native contract for a design-only review artifact", () => {
  const artifact = reviewablePlanArtifact([
    "# 文件打开链路设计",
    "",
    "## 影响文件",
    "- `src/main.js`：前端文件打开入口。",
    "- `src-tauri/src/main.rs`：系统文件打开事件入口。",
    "",
    "## 关键改动",
    "- 修改 `src/main.js`，统一前端事件 payload 解析。",
    "- 修改 `src-tauri/src/main.rs`，统一单实例文件路径转发。",
    "",
    "## 数据流",
    "- 系统文件路径由 Tauri 转为字符串 payload，再由前端入口读取并渲染 Markdown。",
    "",
    "## 验证方式",
    "- 运行 `npm test` 验证前端事件处理。",
    "- 运行 `cargo check` 验证后端编译。",
  ].join("\n"), {
    kind: "design",
    path: ".MAIN/plans/design.md",
    title: "Design",
  });
  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(baseState({
    planArtifacts: [artifact],
    isPlanApproved: false,
  }), "zh");
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });

  assert.equal(readiness.ok, true);
  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.requiresExecutableValidation, true);
  assert.ok(readiness.concreteMutationTaskCount >= 1);
  assert.ok(readiness.executableValidationTaskCount >= 1);
});

test("approvePlan applies readiness failure before queuing a same-turn child run", () => {
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const approveStart = storeSource.indexOf("approvePlan: (approvalChoice, expectedIdentity) =>");
  const approveEnd = storeSource.indexOf("rejectPlan: (expectedIdentity) =>", approveStart);
  const approvePlanMethod = storeSource.slice(approveStart, approveEnd);
  const readinessIndex = approvePlanMethod.indexOf("evaluateApprovedPlanExecutionReadiness");
  const handoffIndex = approvePlanMethod.indexOf("pendingHandoffPatch");

  assert.ok(readinessIndex >= 0);
  assert.ok(handoffIndex > readinessIndex);
  assert.match(approvePlanMethod, /if \(!executionReadiness\.ok\) \{[\s\S]*activeActionRequest: null/);
  assert.match(approvePlanMethod, /isPlanApproved: false/);
  assert.match(approvePlanMethod, /status: "paused" as const/);
  assert.match(approvePlanMethod, /plan_execution_materialization_failed/);
  assert.match(approvePlanMethod, /plan_approval_blocked_execution_materialization/);
});

test("approvePlan reserves a child run before publishing the initial execution progress", () => {
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const approveStart = storeSource.indexOf("approvePlan: (approvalChoice, expectedIdentity) =>");
  const approveEnd = storeSource.indexOf("rejectPlan: (expectedIdentity) =>", approveStart);
  const approvePlanMethod = storeSource.slice(approveStart, approveEnd);

  assert.match(approvePlanMethod, /const executionRunId = approvedTurnId/);
  assert.match(approvePlanMethod, /executionRunId: executionRunId \|\| undefined/);
  assert.match(approvePlanMethod, /runId: executionRunId/);
  assert.match(approvePlanMethod, /toPlanExecutionRuntimeProgressUpdate\(/);
  assert.match(approvePlanMethod, /plan-execution-progress:\$\{executionRunId\}/);
});
