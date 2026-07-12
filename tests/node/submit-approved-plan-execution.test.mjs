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
  assert.equal(readiness.concreteMutationTaskCount, 1);
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
