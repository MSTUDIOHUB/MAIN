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
  repairActionablePlanArtifactContent,
  validateActionablePlanArtifact,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

const {
  materializePlanArtifactFromVisibleText,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planMaterialization.ts"));

function completePlanWithoutUserGoal() {
  return [
    "# 计划",
    "",
    "## 截图/附件观察",
    "- 未提供截图/附件；本计划基于用户请求和已读代码证据。",
    "",
    "## 已读证据",
    "- `src/lib/orchestrator.ts`：Plan runtime 负责工具收束与计划审批。",
    "- `src/lib/planReadOnlyConvergence.ts`：只读证据收束后会限制工具面。",
    "",
    "## 已确认事实",
    "- Plan 模式必须先生成 `.MAIN/plans/plan.md`，批准前不能修改源码。",
    "",
    "## 未验证假设",
    "- 未验证：具体失败日志可能还包含其它本地模型格式。",
    "",
    "## 影响文件",
    "- `src/lib/orchestrator.ts`",
    "- `src/lib/workflowModels.ts`",
    "",
    "## 执行步骤",
    "1. 增加结构化 Plan runtime phase。",
    "2. 根据质量门禁 recovery action 进入补证据或重写。",
    "",
    "## 验证标准",
    "- 运行 `node --test tests/node/*.test.mjs` 和 `npm run build`。",
  ].join("\n");
}

test("missing user_goal can be auto-repaired from the user request", () => {
  const initial = validateActionablePlanArtifact(completePlanWithoutUserGoal());
  assert.equal(initial.ok, false);
  assert.equal(initial.recoveryAction, "rewrite");
  assert.equal(initial.canAutoRepair, true);
  assert.deepEqual(initial.missingSections, ["user_goal"]);

  const repaired = repairActionablePlanArtifactContent({
    content: completePlanWithoutUserGoal(),
    userGoal: "重构 MAIN Plan runtime，让 plan.md 质量门禁可恢复并进入审批。",
    quality: initial,
    language: "zh",
  });

  assert.deepEqual(repaired.repairedSections, ["user_goal"]);
  assert.equal(validateActionablePlanArtifact(repaired.content).ok, true);
  assert.match(repaired.content, /## 用户目标/);
});

test("missing read evidence requests targeted evidence instead of rewrite", () => {
  const plan = completePlanWithoutUserGoal()
    .replace("## 已读证据\n- `src/lib/orchestrator.ts`：Plan runtime 负责工具收束与计划审批。\n- `src/lib/planReadOnlyConvergence.ts`：只读证据收束后会限制工具面。\n\n", "")
    .replace("# 计划", "# CSV Dashboard 修复计划\n\n## 用户目标\n- 修复 CSV Dashboard Plan 闭环。");

  const result = validateActionablePlanArtifact(plan);

  assert.equal(result.ok, false);
  assert.equal(result.recoveryAction, "targeted_evidence");
  assert.equal(result.canAutoRepair, false);
  assert.ok(result.missingSections.includes("read_evidence"));
});

test("nonstandard proposed plan canonicalizes before quality recovery loops", () => {
  const draft = [
    "# Proposed Plan",
    "",
    "## Investigation Summary",
    "- 已经定位到上传组件和 Dashboard store 之间的数据刷新链路。",
    "- 需要避免把未读到的实现细节直接写成已确认事实。",
    "- 当前 Proposed Plan 有目标、分析、文件和验证信号，但没有使用 MAIN 标准章节标题。",
    "",
    "## Approach",
    "- 用现有上传入口和 store 证据重组计划。",
    "- 修改 CSV 导入后指标刷新路径。",
    "- 补充能证明导入后概览指标更新的回归验证。",
    "- 将可见 Proposed Plan 写成标准 plan.md 后进入审批。",
    "",
    "## Files",
    "- `src/components/FileUploader/DragUpload.tsx`",
    "- `src/store/dashboardStore.ts`",
    "- `src/components/Dashboard/OverviewCards.tsx`",
    "",
    "## Validation",
    "- 运行相关 Node/Vitest 测试。",
    "- 手动导入 CSV 并确认 Dashboard 指标刷新。",
  ].join("\n");

  const initial = validateActionablePlanArtifact(draft);
  assert.equal(initial.ok, false);
  assert.match(initial.reason || "", /missing_plan_required_sections|insufficient_actionable_plan_signals|too_short|generic_fallback_plan/);

  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: draft,
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    evidence: [
      "read_file src/components/FileUploader/DragUpload.tsx; excerpt=上传组件负责读取 CSV 文件并触发解析入口",
      "read_file src/store/dashboardStore.ts; excerpt=store 保存 dashboard 指标和导入状态",
    ],
    files: [
      "src/components/FileUploader/DragUpload.tsx",
      "src/store/dashboardStore.ts",
      "src/components/Dashboard/OverviewCards.tsx",
    ],
    turnContext: { imageParts: 2 },
    language: "zh",
  });

  assert.equal(materialized.ok, true);
  assert.equal(validateActionablePlanArtifact(materialized.content || "").ok, true);
  assert.match(materialized.content || "", /## 摘要/);
  assert.match(materialized.content || "", /## 关键改动/);
  assert.match(materialized.content || "", /## 公共 API \/ 接口 \/ 类型/);
  assert.match(materialized.content || "", /用户提供了 2 张图片/);
  assert.doesNotMatch(materialized.content || "", /excerpt=/);
});

test("generic fallback plan escalates to auto scaffold", () => {
  const result = validateActionablePlanArtifact([
    "# Plan",
    "",
    "## 用户目标",
    "- 基于当前可用的只读证据生成最小可用闭环。",
    "",
    "## 截图/附件观察",
    "- 未提供截图/附件。",
    "",
    "## 已读证据",
    "- available read-only evidence.",
    "",
    "## 已确认事实",
    "- available read-only evidence.",
    "",
    "## 未验证假设",
    "- 未验证：默认 first version。",
    "",
    "## 影响文件",
    "- TBD",
    "",
    "## 执行步骤",
    "1. Use the inspected context as the source of truth.",
    "",
    "## 验证标准",
    "- Run tests.",
  ].join("\n"));

  assert.equal(result.ok, false);
  assert.equal(result.recoveryAction, "auto_scaffold");
});
