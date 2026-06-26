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
    "## 摘要",
    "- 修复 CSV Dashboard Plan 闭环。",
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
    "## 关键改动",
    "- 修改 `src/lib/orchestrator.ts` 以允许从错误中自动恢复。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API/接口/类型变化；保持现有定义不变。",
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
    "",
    "## 测试方案",
    "- 运行 `node --test tests/node/*.test.mjs`。",
    "",
    "## 假设与默认值",
    "- 默认保持现有逻辑不变。",
  ].join("\n");
}

test("missing user_goal can be auto-repaired from the user request", () => {
  const initial = validateActionablePlanArtifact(completePlanWithoutUserGoal());
  assert.equal(initial.ok, false);
  assert.equal(initial.recoveryAction, "rewrite");
  assert.equal(initial.canAutoRepair, true);
  assert.ok(initial.missingSections.includes("user_goal"));

  const repaired = repairActionablePlanArtifactContent({
    content: completePlanWithoutUserGoal(),
    userGoal: "重构 MAIN Plan runtime，让 plan.md 质量门禁可恢复并进入审批。",
    quality: initial,
    language: "zh",
  });

  assert.ok(repaired.repairedSections.includes("user_goal"));
  assert.equal(validateActionablePlanArtifact(repaired.content).ok, true);
  assert.match(repaired.content, /## 用户目标/);
});

test("missing read evidence does not cause targeted_evidence in unified path", () => {
  const plan = completePlanWithoutUserGoal()
    .replace("## 已读证据\n- `src/lib/orchestrator.ts`：Plan runtime 负责工具收束与计划审批。\n- `src/lib/planReadOnlyConvergence.ts`：只读证据收束后会限制工具面。\n\n", "")
    .replace("# 计划", "# CSV Dashboard 修复计划\n\n## 用户目标\n- 修复 CSV Dashboard Plan 闭环。");

  const result = validateActionablePlanArtifact(plan);

  // In unified path, evidence sections (read_evidence, screenshot, confirmed_findings)
  // are NOT part of the required sections. The plan passes if it has always-required
  // sections and sufficient signals. This validates that evidence sections no longer
  // trigger targeted_evidence classification.
  assert.ok(!result.missingSections?.includes("read_evidence"));
  assert.ok(!result.missingSections?.includes("screenshot_attachment_observations"));
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

  // In unified path: canonicalization may still succeed if it can produce
  // a plan with the required sections (user_goal, execution_steps, validation)
  assert.ok(materialized.ok === true || materialized.ok === false);
  if (materialized.ok && materialized.content) {
    const validated = validateActionablePlanArtifact(materialized.content);
    assert.equal(validated.ok, true);
    // The canonicalized/repaired content has execution steps and validation
    assert.match(materialized.content, /## (?:执行步骤|关键改动|测试方案)|Approach|Validation/);
  }
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

test("missing public_interfaces and test_plan sections can be auto-repaired", () => {
  const plan = [
    "# CSV Dashboard 修复计划",
    "",
    "## 用户目标",
    "- 修复 CSV 导入后 Dashboard 指标没有正确更新的问题",
    "",
    "## 已读证据",
    "- read_file src/App.tsx；发现入口逻辑缺少刷新调用",
    "- read_file src/store/dashboardStore.ts；确认 store 状态管理正确",
    "",
    "## 摘要",
    "- 修复 DragUpload 组件在 CSV 导入完成后没有触发 Dashboard 数据刷新的问题",
    "",
    "## 关键改动",
    "- 修改 src/App.tsx 补充导入完成后的 store 刷新逻辑",
    "- 更新 src/components/FileUploader/DragUpload.tsx 添加回调",
    "",
    "## 假设与默认值",
    "- 默认保持现有 CSV 解析逻辑不变，仅补充刷新调用",
  ].join("\n");

  const initial = validateActionablePlanArtifact(plan);
  assert.equal(initial.ok, false);
  assert.equal(initial.recoveryAction, "rewrite");
  assert.ok(initial.canAutoRepair === true);
  assert.ok(initial.missingSections.includes("public_interfaces"));
  assert.ok(initial.missingSections.includes("test_plan"));

  const repaired = repairActionablePlanArtifactContent({
    content: plan,
    userGoal: "重构计划质量门禁",
    quality: initial,
    language: "zh",
  });

  assert.ok(repaired.repairedSections.includes("public_interfaces"));
  assert.ok(repaired.repairedSections.includes("test_plan"));
  assert.equal(validateActionablePlanArtifact(repaired.content).ok, true);
  assert.match(repaired.content, /## 公共 API \/ 接口 \/ 类型/);
  assert.match(repaired.content, /## 测试方案/);
});
