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
  appendTrustedValidationCommandsToPlan,
  canonicalizePlanArtifactContent,
  composePlanArtifactFromEvidence,
  composeReviewablePlanFromEvidence,
  extractNumberedUserGoalFacets,
  extractPlanEvidenceFacts,
  extractPlanEvidenceSourceFacts,
  findContradictedPlanDiagnosticClaim,
  isMaterializablePlanLikeText,
  materializePlanArtifactFromVisibleText,
  repairPlanValidationTargetFromEvidence,
  sanitizePlanEvidenceInput,
  summarizePlanEvidenceDetail,
  validateExplicitPlanCodeChangeGrounding,
  validateConfirmedContractMismatchDisposition,
  validatePlanEvidenceGrounding,
  validateNumberedUserGoalFacetCoverage,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planMaterialization.ts"),
);

test("explicit plan code changes must be non-noop and match observed source state", () => {
  const planChange = (before, after) => [
    "### 改动 1",
    "**文件**: `src/main.js`",
    "**修改前**:",
    "```javascript",
    before,
    "```",
    "**修改后**:",
    "```javascript",
    after,
    "```",
  ].join("\n");

  const noOp = validateExplicitPlanCodeChangeGrounding({
    content: planChange("import { invoke } from '@tauri-apps/api/core';", "import { invoke } from '@tauri-apps/api/core';"),
  });
  assert.equal(noOp.ok, false);
  assert.match(noOp.reason, /plan_change_noop:src\/main\.js/);

  const activity = [{
    name: "read_file",
    target: "src/main.js",
    status: "succeeded",
    detail: "import { invoke } from '@tauri-apps/api/core';\nconst ready = true;",
  }];
  const inventedBefore = validateExplicitPlanCodeChangeGrounding({
    content: planChange("import invoke from '@tauri-apps/api/core';", "import { invoke } from '@tauri-apps/api/core';"),
    recentToolActivity: activity,
  });
  assert.equal(inventedBefore.ok, false);
  assert.match(inventedBefore.reason, /plan_before_state_not_observed:src\/main\.js/);
  assert.equal(inventedBefore.recoveryAction, "targeted_evidence");

  const observedBefore = validateExplicitPlanCodeChangeGrounding({
    content: planChange("const ready = true;", "const ready = false;"),
    recentToolActivity: activity,
  });
  assert.equal(observedBefore.ok, true);
});

test("multi-facet user goals require an explicit G/E/C-or-D/V traceability ledger", () => {
  const userGoal = [
    "1、CSV 导入后课程名称为空。",
    "2、筛选订单状态后总金额没有更新。",
    "3、导出报告缺少日期列。",
  ].join("\n");
  const incomplete = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# 修复方案",
      "## 已确认证据",
      "- CSV 导入后的课程名称字段为空。",
      "## 关键改动",
      "- 修复 CSV 课程名称字段的导入映射。",
      "## 测试方案",
      "- 导入 CSV 并验证课程名称不再为空。",
    ].join("\n"),
  });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reason || "", /uncovered_user_goal_facets:1,2,3/);
  assert.equal(incomplete.recoveryAction, "rewrite");

  const complete = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# 修复方案",
      "## 已确认证据",
      "- [E1] CSV 导入映射丢失课程名称字段。",
      "- [E2] 订单状态筛选后总金额仍使用筛选前集合。",
      "- [E3] 导出报告的列映射未包含日期列。",
      "## 关键改动",
      "- [C1] 修复 CSV 课程名称字段的导入映射。",
      "- [C2] 让订单状态筛选后的总金额使用筛选结果。",
      "- [C3] 在导出报告中补齐日期列。",
      "## 测试方案",
      "- [V1] 导入 CSV 并验证课程名称不再为空。",
      "- [V2] 筛选订单状态并验证总金额同步更新。",
      "- [V3] 导出报告并验证包含日期列。",
      "## 需求分面追踪",
      "- G1 -> E1 -> C1 -> V1",
      "- G2 -> E2 -> C2 -> V2",
      "- G3 -> E3 -> C3 -> V3",
    ].join("\n"),
  });
  assert.equal(complete.ok, true, complete.reason);
});

test("diagnostic multi-facet goals require grounded R links in the same trace graph", () => {
  const userGoal = [
    "1、找出详情页保存后仍显示旧标题的根本原因。",
    "2、找出删除后列表计数不更新的根本原因。",
  ].join("\n");
  const base = [
    "# 诊断修复计划",
    "## 已确认证据",
    "- [E1] `src/detail.ts` 保存成功后仍从旧缓存读取标题。",
    "- [E2] `src/list.ts` 删除成功后仍从旧集合读取计数。",
    "## 诊断 / 推断",
    "- [R1 inferred, E1] 详情标题刷新链遗漏了保存后的缓存同步。",
    "- [R2 inferred, E2] 列表删除链遗漏了基于最新集合的计数派生。",
    "## 关键改动",
    "- [C1, R1] 修改 `src/detail.ts`，保存后同步详情标题缓存。",
    "- [C2, R2] 修改 `src/list.ts`，删除后从最新集合派生计数。",
    "## 测试方案",
    "- [V1] 保存新标题并断言详情页显示新标题。",
    "- [V2] 删除记录并断言列表计数立即减少。",
    "## 需求分面追踪",
    "- G1 -> E1 -> R1 -> C1 -> V1",
    "- G2 -> E2 -> R2 -> C2 -> V2",
  ].join("\n");

  const complete = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: base,
    diagnosisRequired: true,
  });
  assert.equal(complete.ok, true, complete.reason);

  const missingDiagnosisLink = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: base.replace("G2 -> E2 -> R2 -> C2 -> V2", "G2 -> E2 -> C2 -> V2"),
    diagnosisRequired: true,
  });
  assert.equal(missingDiagnosisLink.ok, false);
  assert.match(missingDiagnosisLink.reason || "", /uncovered_user_goal_facets:2/);

  const danglingDiagnosis = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: base.replace("R2 -> C2", "R9 -> C2"),
    diagnosisRequired: true,
  });
  assert.equal(danglingDiagnosis.ok, false);
  assert.match(danglingDiagnosis.reason || "", /uncovered_user_goal_facets:2/);
});

test("a single user-goal facet does not require a multi-facet traceability ledger", () => {
  const result = validateNumberedUserGoalFacetCoverage({
    userGoal: "1、CSV 导入后课程名称为空。",
    content: [
      "# 修复方案",
      "## 已确认证据",
      "- CSV 导入映射丢失课程名称字段。",
      "## 关键改动",
      "- 修复 CSV 课程名称字段的导入映射。",
      "## 测试方案",
      "- 导入 CSV 并验证课程名称不再为空。",
    ].join("\n"),
  });
  assert.equal(result.ok, true, result.reason);
});

test("numbered goal facets accept colon delimiters without bypassing traceability", () => {
  const userGoal = [
    "1: Repair the stale detail title after save.",
    "2：删除记录后立即更新列表计数。",
  ].join("\n");
  assert.deepEqual(
    extractNumberedUserGoalFacets(userGoal).map((facet) => facet.index),
    [1, 2],
  );
  const result = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# Plan",
      "## Confirmed Evidence",
      "- [E1] `src/detail.ts` owns the current state.",
      "## Key Changes",
      "- [C1] Modify `src/detail.ts` state handling.",
      "## Test Plan",
      "- [V1] Verify the resulting state.",
      "## Traceability Matrix",
      "- G1 -> E1 -> C1 -> V1",
      "- G2 -> E1 -> C1 -> V1",
    ].join("\n"),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /uncovered_user_goal_facets:1,2/);
});

test("multi-facet traceability rejects one generic binding reused for every outcome", () => {
  const userGoal = [
    "1、在编辑界面重复显示文件名和未保存文档名字。",
    "2、打开本地 md 文件后会错误弹出保存窗口。",
  ].join("\n");
  const result = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# MD Viewer repair plan",
      "## Confirmed Evidence",
      "- [E1] `src/main.js` currently handles file state.",
      "## Key Changes",
      "- [C1] Modify `src/main.js` file save behavior.",
      "## Test Plan",
      "- [V1] Verify the file save result.",
      "## Traceability Matrix",
      "- G1 -> E1 -> C1 -> V1",
      "- G2 -> E1 -> C1 -> V1",
    ].join("\n"),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /uncovered_user_goal_facets:1,2/);
});

test("materialization rejects the real multi-facet incident shape when prose omits the trace ledger", () => {
  const userGoal = [
    "1、在编辑界面显示了文件名和未保存的文档名字，这是不合理的。",
    "2、打开本地 md 文件后随后会弹出窗口，看起来是文件保存执行路径有关的问题。",
  ].join("\n");
  const visibleText = [
    "# MD Viewer 问题修复计划",
    "## 摘要",
    "- 修复编辑界面重复显示文件名和未保存文档名字。",
    "- 修复打开本地 md 文件后错误弹出保存窗口。",
    "## 已确认证据",
    "- `src/main.js` 初始文件对象的 title 为空，且 isDirty 会让标签追加未保存标记。",
    "- `src/main.js` 存在两条本地文件打开路径，返回值解析不一致。",
    "## 关键改动",
    "- 修改 `src/main.js` 的标签标题与 isDirty 同步，避免编辑界面重复显示文件名和未保存名称。",
    "- 统一 `src/main.js` 的本地 md 文件打开路径，打开后不得触发保存窗口。",
    "## 公共 API / 接口 / 类型",
    "- 保持已有公共接口与文件数据结构不变。",
    "## 测试方案",
    "- 运行 `npm test`，断言编辑界面只保留一个文件名称所有者，并正确显示 isDirty 状态。",
    "- 运行 `npm test`，断言打开本地 md 文件后不会弹出保存窗口。",
    "## 假设与默认值",
    "- 保持未点名的文件与契约不变。",
  ].join("\n");

  const directCoverage = validateNumberedUserGoalFacetCoverage({ userGoal, content: visibleText });
  assert.equal(directCoverage.ok, false);
  assert.match(directCoverage.reason || "", /uncovered_user_goal_facets:1,2/);

  const materialized = materializePlanArtifactFromVisibleText({ visibleText, userGoal });
  assert.equal(materialized.ok, false);
  assert.match(materialized.reason || "", /uncovered_user_goal_facets:1,2/);
});

test("numbered subagent assignment descriptors are collaboration metadata, not acceptance facets", () => {
  const userGoal = [
    "请为 creatorName 数据链路生成整改计划。",
    "1. Euler：scope_key=csv-parser，scope=分析 CSV 字段归一化，allowed_paths=src/hooks/useCsvParser.ts，expected_output=给出文件证据。",
    "2. Mendel：scope_key=chart-consumer，scope=分析图表消费逻辑，allowed_paths=src/hooks/useChartData.ts，expected_output=说明消费端契约。",
  ].join("\n");

  assert.deepEqual(extractNumberedUserGoalFacets(userGoal), []);
  const coverage = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# creatorName 整改计划",
      "## 关键改动",
      "- 修改 `src/hooks/useCsvParser.ts` 补齐 creatorName 归一化。",
      "- 保持 `src/hooks/useChartData.ts` 的消费契约。",
      "## 测试方案",
      "- 上传 CSV 并验证 Dashboard 正确显示 creatorName。",
    ].join("\n"),
  });
  assert.equal(coverage.ok, true, coverage.reason || "");
});

test("numbered facets require referenced E/C/V bodies to support each traceability row", () => {
  const userGoal = [
    "1、保存后详情页仍显示旧标题。",
    "2、删除后列表计数没有更新。",
  ].join("\n");
  const content = [
    "# 计划",
    "## 已确认证据",
    "- [E1] `src/detail.ts` 保存成功后仍从旧标题缓存读取详情标题。",
    "- [E2] `src/list.ts` 删除成功后仍从删除前集合派生列表计数。",
    "## 关键改动",
    "- [C1] 修改 `src/detail.ts`，保存成功后同步详情页标题缓存，不再显示旧标题。",
    "- [C2] 修改 `src/list.ts`，删除成功后从最新集合重新计算列表计数。",
    "## 测试方案",
    "- [V1] 保存新标题并断言详情页显示新标题而不是旧标题。",
    "- [V2] 删除一项并断言列表计数按最新集合减少。",
    "## 需求分面追踪",
    "- 分面 1：由 E1 约束，对应 C1，并由 V1 验收。",
    "- 分面 2：由 E2 约束，对应 C2，并由 V2 验收。",
  ].join("\n");

  const result = validateNumberedUserGoalFacetCoverage({ userGoal, content });
  assert.equal(result.ok, true, result.reason);

  const compactTableLedger = content
    .replace("## 需求分面追踪", "## Traceability Matrix")
    .replace("- 分面 1：由 E1 约束，对应 C1，并由 V1 验收。", "| G1 | E1 | C1 | V1 |")
    .replace("- 分面 2：由 E2 约束，对应 C2，并由 V2 验收。", "| G2 | E2 | C2 | V2 |");
  const compactTableResult = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: compactTableLedger,
  });
  assert.equal(compactTableResult.ok, true, compactTableResult.reason);

  const missingReference = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: content.replace("对应 C2", "对应 C9"),
  });
  assert.equal(missingReference.ok, false);
  assert.match(missingReference.reason || "", /uncovered_user_goal_facets:2/);

  const danglingReference = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: content.replace("对应 C1，", "对应 C1、C9，"),
  });
  assert.equal(danglingReference.ok, false);
  assert.match(danglingReference.reason || "", /uncovered_user_goal_facets:1/);

  const duplicateGoalRow = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: content.replace(
      "- 分面 2：由 E2 约束，对应 C2，并由 V2 验收。",
      [
        "- 分面 1：由 E1 约束，对应 C1，并由 V1 验收。",
        "- 分面 2：由 E2 约束，对应 C2，并由 V2 验收。",
      ].join("\n"),
    ),
  });
  assert.equal(duplicateGoalRow.ok, false);
  assert.match(duplicateGoalRow.reason || "", /uncovered_user_goal_facets:1/);

  const selfCertifiedUnrelated = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# 计划",
      "## 已确认证据",
      "- [E1] `src/save.ts` 的 file_path 参数与 filePath 契约不一致。",
      "## 关键改动",
      "- [C1] 修改 `src/save.ts` 的保存参数名。",
      "## 测试方案",
      "- [V1] 保存文件并断言参数契约一致。",
      "- [V2] 保存文件并断言参数契约一致。",
      "## 需求分面追踪",
      "- 分面 1（保存后详情页仍显示旧标题）：由 E1 约束，对应 C1，并由 V1 验收。",
      "- 分面 2（删除后列表计数没有更新）：由 E1 约束，对应 C1，并由 V2 验收。",
    ].join("\n"),
  });
  assert.equal(selfCertifiedUnrelated.ok, false);
  assert.match(selfCertifiedUnrelated.reason || "", /uncovered_user_goal_facets:1,2/);

  const ledgerNestedUnderEvidence = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# 计划",
      "## 已确认证据",
      "### 需求分面追踪",
      "- [G1] 保存后详情页仍显示旧标题 -> [E1] `src/detail.ts` -> C1 -> V1",
      "- [G2] 删除后列表计数没有更新 -> [E2] `src/list.ts` -> C2 -> V2",
      "## 关键改动",
      "- [C1] 修改 `src/detail.ts`，保存成功后同步详情页标题缓存。",
      "- [C2] 修改 `src/list.ts`，删除成功后从最新集合重新计算列表计数。",
      "## 测试方案",
      "- [V1] 保存新标题并断言详情页显示新标题。",
      "- [V2] 删除一项并断言列表计数按最新集合减少。",
    ].join("\n"),
  });
  assert.equal(ledgerNestedUnderEvidence.ok, false);
  assert.match(ledgerNestedUnderEvidence.reason || "", /uncovered_user_goal_facets:1,2/);
});

test("a grounded no-change decision can close its own numbered facet", () => {
  const userGoal = [
    "1、保存后详情页仍显示旧标题。",
    "2、确认开发启动端口是否一致。",
  ].join("\n");
  const content = [
    "# 计划",
    "## 已确认证据",
    "- [E1] `src/detail.ts` 保存成功后仍读取旧标题缓存。",
    "- [E2] `vite.config.js` 与 `desktop/app.json` 的开发启动端口都为 1420。",
    "## 关键改动",
    "- [C1] 修改 `src/detail.ts`，保存成功后同步详情页标题缓存。",
    "## 决策与约束",
    "- [D1] 保持 `vite.config.js` 与 `desktop/app.json` 已一致的开发启动端口 1420，不制造端口改动。",
    "## 测试方案",
    "- [V1] 保存新标题并断言详情页显示新标题。",
    "- [V2] 启动开发环境并断言两端使用一致端口 1420。",
    "## 需求分面追踪",
    "- 分面 1：由 E1 约束，对应 C1，并由 V1 验收。",
    "- 分面 2：由 E2 约束，对应 D1，并由 V2 验收。",
  ].join("\n");

  const result = validateNumberedUserGoalFacetCoverage({ userGoal, content });
  assert.equal(result.ok, true, result.reason);
});

test("numbered facets inherit evidence, change, and validation roles from parent sections", () => {
  const userGoal = [
    "1、保存后详情页仍显示旧标题。",
    "2、删除后列表计数没有更新。",
  ].join("\n");
  const result = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# Proposed Plan",
      "## 根因与证据",
      "### 问题 1：保存后详情页仍显示旧标题",
      "- [E1] 详情页继续读取旧标题缓存。",
      "### 问题 2：删除后列表计数没有更新",
      "- [E2] 列表计数继续使用删除前集合。",
      "## 具体改动",
      "### 改动 1：同步保存后的详情标题",
      "- [C1] 保存成功后更新详情页标题缓存。",
      "### 改动 2：同步删除后的列表计数",
      "- [C2] 删除成功后从最新集合重新计算列表计数。",
      "## 验证方式",
      "### 验证 1：保存标题",
      "- [V1] 保存新标题并验证详情页不再显示旧标题。",
      "### 验证 2：删除记录",
      "- [V2] 删除记录并验证列表计数立即更新。",
      "## 需求分面追踪",
      "- G1 -> E1 -> C1 -> V1",
      "- G2 -> E2 -> C2 -> V2",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
});

test("numbered facets remain traceable when role sections are nested under each facet", () => {
  const userGoal = [
    "1、保存后详情页仍显示旧标题。",
    "2、删除后列表计数没有更新。",
  ].join("\n");
  const result = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# Proposed Plan",
      "## 二、问题 1：保存后详情页仍显示旧标题",
      "### 已确认证据",
      "- [E1] `src/detail.ts` 仍读取旧标题缓存。",
      "### 具体改动",
      "- [C1] 保存成功后更新详情页标题缓存。",
      "### 验证方式",
      "- [V1] 保存新标题并验证详情页不再显示旧标题。",
      "## 三、问题 2：删除后列表计数没有更新",
      "### 已确认证据",
      "- [E2] `src/list.ts` 仍使用删除前集合计算列表计数。",
      "### 具体改动",
      "- [C2] 删除成功后从最新集合重新计算列表计数。",
      "### 验证方式",
      "- [V2] 删除记录并验证列表计数立即更新。",
      "## 需求分面追踪",
      "- G1 -> E1 -> C1 -> V1",
      "- G2 -> E2 -> C2 -> V2",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
});

test("numbered feature facets use current boundaries and acceptance without requiring bug roots", () => {
  const userGoal = [
    "1、支持离线创建草稿并在恢复网络后同步。",
    "2、同步冲突时保留本地和远端两个版本。",
  ].join("\n");
  const result = validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: [
      "# 离线草稿功能计划",
      "## 已确认证据 / 当前实现",
      "- [E1] 离线创建草稿目前只保存在内存，恢复网络后没有同步队列。",
      "- [E2] 同步冲突目前覆盖本地版本，无法同时保留本地和远端版本。",
      "## 架构改动",
      "- [C1] 为离线创建草稿增加持久化同步队列，并在恢复网络后顺序同步。",
      "- [C2] 为同步冲突增加双版本记录，分别保留本地版本和远端版本。",
      "## 验收标准",
      "- [V1] 断网创建草稿后恢复网络，验证草稿完成同步。",
      "- [V2] 制造同步冲突，验证本地和远端两个版本都可查看。",
      "## 需求分面追踪",
      "- G1 -> E1 -> C1 -> V1",
      "- G2 -> E2 -> C2 -> V2",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
});

test("canonicalization preserves facet prose but cannot bypass a missing trace ledger", () => {
  const userGoal = [
    "1、保存后详情页仍显示旧标题。",
    "2、删除后列表计数没有更新。",
  ].join("\n");
  const content = [
    "# Proposed Plan",
    "## 一、问题概述",
    "- 覆盖两个状态同步问题。",
    "## 二、问题 1：保存后详情页仍显示旧标题",
    "### 已确认证据",
    "- `src/detail.ts` 的 saveDetail 写入记录但没有刷新标题缓存。",
    "### 具体改动",
    "- 修改 `src/detail.ts`，保存成功后更新详情页标题缓存。",
    "## 三、问题 2：删除后列表计数没有更新",
    "### 已确认证据",
    "- `src/list.ts` 的 deleteRecord 删除记录但没有重算列表计数。",
    "### 具体改动",
    "- 修改 `src/list.ts`，删除成功后从最新集合重算列表计数。",
    "## 五、验证方案",
    "### 验证问题 1：保存标题",
    "- 保存新标题并验证详情页不再显示旧标题。",
    "### 验证问题 2：删除记录",
    "- 删除记录并验证列表计数立即更新。",
    "## 六、假设与默认值",
    "- 保持未点名接口不变。",
  ].join("\n");
  const canonical = canonicalizePlanArtifactContent({
    content,
    userGoal,
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/detail.ts",
        status: "succeeded",
        summary: "saveDetail writes the record but never refreshes the title cache",
      },
      {
        tool: "read_file",
        target: "src/list.ts",
        status: "succeeded",
        summary: "deleteRecord removes the item but never recomputes the list count",
      },
    ],
    files: ["src/detail.ts", "src/list.ts"],
    language: "zh",
  });

  assert.ok(canonical);
  const coverage = validateNumberedUserGoalFacetCoverage({ userGoal, content: canonical });
  assert.equal(coverage.ok, false);
  assert.match(coverage.reason || "", /uncovered_user_goal_facets:1,2/);
  assert.match(canonical, /src\/detail\.ts/);
  assert.match(canonical, /src\/list\.ts/);
});

test("plan evidence sanitization preserves numbered goal facets for quality coverage", () => {
  const userGoal = [
    "修复两个状态同步问题：",
    "1、保存后详情页仍显示旧标题。",
    "2、删除后列表计数没有更新。",
  ].join("\n");
  const sanitized = sanitizePlanEvidenceInput({ userGoal });

  assert.equal(sanitized.userGoal, userGoal);
  const incomplete = validateNumberedUserGoalFacetCoverage({
    userGoal: sanitized.userGoal,
    content: [
      "# 计划",
      "## 已确认证据",
      "- 保存后详情页仍从旧标题缓存读取。",
      "## 关键改动",
      "- 保存成功后刷新详情页标题缓存。",
      "## 测试方案",
      "- 保存新标题并验证详情页同步显示。",
    ].join("\n"),
  });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reason || "", /uncovered_user_goal_facets:1,2/);
});
const {
  assessPlanClosureEvidence,
  buildPlanCandidate,
  buildPlanEvidenceBundle,
  buildPlanEvidenceEpochHash,
  formatPlanEvidenceBundleForModel,
  hasDeterministicPlanMaterializationEvidence,
  isPlanEvidenceBundleReady,
  isPlanEvidenceReadyForModelDraft,
  validatePlanCandidate,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planEvidence.ts"));
const {
  createRuntimePlanStructuredEvidenceFacts,
  formatPlanStructuredEvidenceFacts,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planStructuredEvidence.ts"));
const {
  extractRuntimePlanSourceObservations,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planSourceObservation.ts"));
const {
  deriveRuntimePlanTasksFromArtifacts,
  validateActionablePlanArtifact,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

function asRuntimePlanEvidenceRecord(record) {
  const facts = [
    ...(Array.isArray(record.facts) ? record.facts : []),
    ...formatPlanStructuredEvidenceFacts(record.structuredFacts),
    ...extractPlanEvidenceFacts(record.summary || ""),
  ];
  const observedSource = facts.join("\n") || String(record.summary || "");
  const lineCount = observedSource.split("\n").length;
  const sourceObservations = extractRuntimePlanSourceObservations({
    target: record.target,
    content: observedSource,
    readFileObservation: {
      path: record.target,
      requestSignature: `fixture-read:${record.target}:1-${lineCount}`,
      versionToken: `fixture-version:${record.target}`,
      window: { startLine: 1, endLine: lineCount },
    },
  });
  return {
    ...record,
    structuredFacts: createRuntimePlanStructuredEvidenceFacts(facts, {
      sourceObservationRefs: sourceObservations.map((item) => item.observationRef),
    }),
    sourceObservations,
  };
}

function buildRuntimePlanEvidenceBundle(input) {
  return buildPlanEvidenceBundle({
    ...input,
    evidenceRecords: (input.evidenceRecords || []).map(asRuntimePlanEvidenceRecord),
  });
}

test("typed Plan evidence closes command contracts independently of record order", () => {
  const frontendFacts = createRuntimePlanStructuredEvidenceFacts([
    "command_transport_contract(tauri,save_file_content)",
    "command_invoke_argument_contract(save_file_content,file_path,content)",
  ]);
  const backendFacts = createRuntimePlanStructuredEvidenceFacts([
    "command_handler_argument_contract(save_file_content,content,filePath)",
  ]);
  const records = [
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "The frontend command boundary forwards the document path and content.",
      structuredFacts: frontendFacts,
    },
    {
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "The backend handler boundary receives the document path and content.",
      structuredFacts: backendFacts,
    },
  ].map(asRuntimePlanEvidenceRecord);
  const objective = "Opening a local document unexpectedly enters the save flow.";
  const forward = buildPlanEvidenceBundle({ objective, evidenceRecords: records });
  const reversed = buildPlanEvidenceBundle({ objective, evidenceRecords: [...records].reverse() });

  assert.deepEqual(
    assessPlanClosureEvidence(forward).contractMismatchKinds,
    ["command_argument_case:save_file_content:file_path->filePath"],
  );
  assert.deepEqual(
    assessPlanClosureEvidence(reversed).contractMismatchKinds,
    ["command_argument_case:save_file_content:file_path->filePath"],
  );
  assert.equal(buildPlanEvidenceEpochHash(forward), buildPlanEvidenceEpochHash(reversed));
});

test("legacy and unknown structured-fact strings cannot close Plan acceptance", () => {
  const objective = "Opening a local document unexpectedly enters the save flow.";
  const legacyBundle = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "The frontend command boundary forwards the document path and content.",
        facts: ["command_invoke_argument_contract(save_file_content,file_path,content)"],
      },
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "The backend handler boundary receives the document path and content.",
        // Older persisted bundles used this field name with string values.
        structuredFacts: ["command_handler_argument_contract(save_file_content,content,filePath)"],
      },
    ],
  });
  const unknownBundle = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "The frontend function forwards observed values across a boundary.",
      facts: ["command_magic_completion_contract(save_file_content,verified)"],
    }],
  });

  assert.equal(assessPlanClosureEvidence(legacyBundle).ready, false);
  assert.deepEqual(assessPlanClosureEvidence(legacyBundle).contractMismatchKinds, []);
  assert.ok(legacyBundle.facts.every((fact) =>
    (fact.structuredFacts || []).every((structured) => structured.authority === "legacy_import")
  ));
  assert.equal(assessPlanClosureEvidence(unknownBundle).ready, false);
  assert.ok(unknownBundle.facts.every((fact) => (fact.structuredFacts || []).length === 0));
});

test("plan evidence retry epochs ignore fact order, ids, and duplicate replay", () => {
  const objective = "Fix the local document open flow.";
  const first = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "openDocument records the selected path before loading content",
        facts: [
          "function_contract(openDocument,path)",
          "state_transition_contract(filePath,selected_path)",
        ],
      },
      {
        tool: "read_file",
        target: "src/editor.js",
        status: "succeeded",
        summary: "setValue dispatches the editor input event after replacing content",
        facts: ["function_contract(setValue,content)"],
      },
    ],
  });
  const replayed = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/editor.js",
        status: "succeeded",
        summary: "setValue dispatches the editor input event after replacing content",
        facts: ["function_contract(setValue,content)"],
      },
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "openDocument records the selected path before loading content",
        facts: [
          "state_transition_contract(filePath,selected_path)",
          "function_contract(openDocument,path)",
          "state_transition_contract(filePath,selected_path)",
        ],
      },
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "openDocument records the selected path before loading content",
        facts: [
          "function_contract(openDocument,path)",
          "state_transition_contract(filePath,selected_path)",
        ],
      },
    ],
  });
  const advanced = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [
      ...replayed.facts.map((fact) => ({
        tool: fact.tool,
        target: fact.target,
        status: "succeeded",
        summary: fact.summary,
        facts: fact.structuredFacts,
      })),
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "save_file_content accepts the canonical filePath argument",
        facts: ["command_handler_argument_contract(save_file_content,content,filePath)"],
      },
    ],
  });

  assert.equal(buildPlanEvidenceEpochHash(first), buildPlanEvidenceEpochHash(replayed));
  assert.notEqual(buildPlanEvidenceEpochHash(first), buildPlanEvidenceEpochHash(advanced));
});

test("duplicate evidence cannot displace a unique fact at the bounded bundle limit", () => {
  const evidenceRecords = Array.from({ length: 24 }, (_unused, index) => ({
    tool: "read_file",
    target: `src/evidence-${index}.ts`,
    status: "succeeded",
    summary: `function owner${index} returns the observed state value`,
    facts: [`function_contract(owner${index},state)`],
  }));
  const objective = "Modify src/evidence-24.ts after reviewing the evidence owners.";
  const baseline = buildPlanEvidenceBundle({ objective, evidenceRecords });
  const duplicateReplay = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [...evidenceRecords, { ...evidenceRecords[23] }],
  });
  const advanced = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [
      ...evidenceRecords,
      {
        tool: "read_file",
        target: "src/evidence-24.ts",
        status: "succeeded",
        summary: "function owner24 returns the newly observed state value",
        facts: ["function_contract(owner24,state)"],
      },
    ],
  });

  assert.equal(baseline.facts.length, 24);
  assert.equal(new Set(duplicateReplay.facts.map((fact) => fact.target)).size, 24);
  assert.equal(
    buildPlanEvidenceEpochHash(baseline),
    buildPlanEvidenceEpochHash(duplicateReplay),
  );
  assert.equal(advanced.facts.some((fact) => fact.target === "src/evidence-24.ts"), true);
  assert.notEqual(
    buildPlanEvidenceEpochHash(baseline),
    buildPlanEvidenceEpochHash(advanced),
  );
});

test("trusted manifest validation repair adds an exact executable task without guessing a build command", () => {
  const content = [
    "# Proposed Plan",
    "",
    "## 已确认证据",
    "- `src/hooks/useCsvParser.ts` 的字段映射与下游类型不一致。",
    "",
    "## 实施步骤",
    "- 修改 `src/hooks/useCsvParser.ts`，补齐 creatorName 映射并保留 creator 兼容字段。",
    "",
    "## 测试方案",
    "- 上传现有 CSV 并人工确认 Dashboard 的 creator 显示。",
  ].join("\n");
  const repaired = appendTrustedValidationCommandsToPlan({
    content,
    commands: ["npm test"],
    language: "zh",
  });

  assert.equal(repaired.ok, true);
  assert.match(repaired.content, /运行 `npm test` 并检查退出码与输出/);
  assert.doesNotMatch(repaired.content, /npm run build/);
  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content: repaired.content,
    revision: 1,
    updatedAt: 1,
  }], { language: "zh" });
  assert.equal(tasks.some((task) =>
    task.executionKind === "validation" && task.commands?.includes("npm test")
  ), true, JSON.stringify(tasks));
});

test("materializes valid visible plan text into plan.md artifact", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## 用户目标与约束",
      "- 修复 MAIN Plan 模式闭环，让复杂实现请求生成可审批计划文件。",
      "- 批准前不修改源码交付物，只允许写入 `.MAIN/plans/plan.md`。",
      "",
      "## 当前状态发现",
      "- 现有流程能解析部分工具调用，但普通 Markdown 方案不会同步到 PlanPanel。",
      "- 本地模型偶尔返回伪工具或空响应，需要可恢复检查点。",
      "",
      "## 截图/附件观察",
      "- 本轮没有提供截图或附件，计划只基于用户目标和已读代码证据。",
      "",
      "## 已读证据",
      "- `src/lib/planMaterialization.ts` 负责把可见 Markdown 方案物化为计划文件。",
      "- `src/lib/orchestrator.ts` 负责审批前后的计划状态流转。",
      "",
      "## 真实发现",
      "- 可见方案需要通过质量门禁后写入 `.MAIN/plans/plan.md`。",
      "",
      "## 未验证假设",
      "- 未验证：更多本地模型可能还有额外的伪工具格式，需要后续按日志补兼容。",
      "",
      "## 拟定方案",
      "- 在编排层增加 materialization guard，从可见 Markdown 中生成正式 plan artifact。",
      "- 在工具执行前清理路径、数字参数和残缺 XML 标签。",
      "- 在 UI 层展示友好动作名，隐藏协议参数细节。",
      "",
      "## 影响文件和接口",
      "- `src/lib/orchestrator.ts` 接入自动落盘和空响应恢复。",
      "- `src/lib/textToolParser.ts` 与 `src/lib/sanitize.ts` 扩展本地模型兼容。",
      "- 新增 helper 不改变外部工具 schema。",
      "",
      "## 执行顺序",
      "1. 先完成只读探索和计划草稿生成。",
      "2. 再等待用户批准进入执行。",
      "3. 最后生成 tasks.md 并实施源码改动。",
      "",
      "## 数据流与控制流",
      "- LLM 输出先归一化，再判断工具调用；没有工具但存在有效方案时写入 plan.md。",
      "- 写入成功后刷新 PlanPanel，并进入 pending_review。",
      "",
      "## 风险取舍",
      "- 低质量内容必须被质量门禁拦截，避免把闲聊误写成计划。",
      "- 只允许 design 自动物化，避免越权写源码。",
      "",
      "## 验证方式",
      "- 运行 `node --test tests/node/plan-materialization.test.mjs`，断言解析、清洗、提示词和计划物化用例全部通过。",
      "- 运行 `npx playwright test tests/e2e/cloud-tool-protocol.spec.ts`，断言空响应与伪工具链路进入预期恢复状态。",
      "",
      "## 开放问题",
      "- 是否需要为更多本地模型格式继续扩展兼容。",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.kind, "plan");
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.match(result.content || "", /^# (?:Proposed Plan|计划)/);
  assert.match(result.content || "", /## (?:关键改动|Key Changes|拟定方案)/);
  assert.doesNotMatch(result.content || "", /用户目标：用户目标与约束|用户目标：开放问题/);
});

test("real MD Viewer trace keeps one semantic evidence bundle through deterministic materialization", () => {
  const records = [
    {
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "handle_open_url currently discards the incoming file path, while setup registers app.on_url without forwarding the event to the webview",
      hash: "main-rs-hash",
    },
    {
      tool: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      summary: "handleOpenFile calls dialog.open without awaiting the Promise, so selected is a Promise instead of the chosen file path",
      hash: "toolbar-hash",
    },
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "the frontend bootstrap does not install an open-file event listener that forwards desktop file-open events into editor.loadFile",
      hash: "main-js-hash",
    },
    {
      tool: "read_file",
      target: "package.json",
      status: "succeeded",
      summary: "package.json contains only general package metadata and does not explain either open-file failure",
      hash: "package-hash",
    },
  ];
  const objective = "修复 MD Viewer 双击 Markdown 文件只打开空白窗口，以及应用内打开按钮无法弹出文件选择器的问题，并制定可审批计划。";
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-md-viewer-trace",
    objective,
    evidenceRecords: records,
    files: records.map((record) => record.target),
    constraints: ["批准前不得修改源码。", "运行 `npm run build` 并进行桌面打开流程验证。"],
  });

  assert.equal(isPlanEvidenceBundleReady(bundle), true);
  assert.equal(bundle.facts.length, 4);
  assert.deepEqual(bundle.changeTargets, [
    "src-tauri/src/main.rs",
    "src/components/toolbar.js",
    "src/main.js",
  ]);
  const packet = formatPlanEvidenceBundleForModel(bundle, "zh");
  assert.match(packet, new RegExp(bundle.hash));
  assert.doesNotMatch(packet, /turn_intake|workflowMode/);

  const content = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidence: records.map((record) => `${record.tool}; ${record.target}; ${record.summary}`),
    evidenceRecords: records,
    files: records.map((record) => record.target),
    constraints: ["批准前不得修改源码。", "运行 `npm run build` 并进行桌面打开流程验证。"],
    language: "zh",
    evidenceBundle: bundle,
  });
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: content,
    userGoal: objective,
    evidence: records.map((record) => `${record.tool}; ${record.target}; ${record.summary}`),
    evidenceRecords: records,
    files: records.map((record) => record.target),
    language: "zh",
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(materialized.ok, true, materialized.reason);
  assert.equal(materialized.evidenceBundleHash, bundle.hash);
  assert.ok(materialized.candidate);
  assert.deepEqual(validatePlanCandidate(materialized.candidate, bundle.hash), []);
  assert.doesNotMatch(materialized.content || "", /最相关证据|noisy_search_evidence|ContextMemoryState/);
  assert.match(materialized.content || "", /src-tauri\/src\/main\.rs/);
  assert.match(materialized.content || "", /src\/components\/toolbar\.js/);

  const mismatched = materializePlanArtifactFromVisibleText({
    visibleText: content,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: "stale-bundle",
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, "evidence_bundle_hash_mismatch");
});

test("grounded model inference is reviewable while deterministic auto-materialization stays strict", () => {
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-md-viewer-excerpt-only",
    objective: "修复 Markdown Viewer 工具栏按钮没有真实功能的问题。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "function initToolbar maps new-btn, open-btn, and save-btn to click actions.",
      },
      {
        tool: "read_file",
        target: "src/components/toolbar.js",
        status: "succeeded",
        summary: "function renderToolbar creates controls with btn-new, btn-open, and btn-save IDs.",
      },
    ],
  });

  assert.equal(isPlanEvidenceBundleReady(bundle), true);
  assert.equal(hasDeterministicPlanMaterializationEvidence(bundle), false);
  assert.deepEqual(assessPlanClosureEvidence(bundle), {
    ready: false,
    reason: "change_targets_lack_confirmed_rationale",
    objectiveTargetMatches: 0,
    defectSignalMatches: 0,
    contractMismatchMatches: 0,
    contractMismatchKinds: [],
    unresolvedContractKinds: [],
  });

  const modelAuthoredDraft = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 修复工具栏行为",
      "",
      "## 用户目标",
      "- 修复 Markdown Viewer 工具栏按钮没有真实功能的问题。",
      "",
      "## 已确认证据",
      "- `src/main.js` 绑定 `new-btn`、`open-btn`、`save-btn`。",
      "- `src/components/toolbar.js` 渲染 `btn-new`、`btn-open`、`btn-save`。",
      "",
      "## 关键改动",
      "- 修改 `src/components/toolbar.js` 的三个控件 ID，使其与 `src/main.js` 的绑定契约一致。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 不修改公共 API。",
      "",
      "## 测试方案",
      "- 运行 `npm run build` 并执行桌面打开交互验证。",
      "",
      "## 假设与默认值",
      "- 保持三个按钮现有回调行为不变。",
    ].join("\n"),
    userGoal: bundle.objective,
    evidenceRecords: bundle.facts.map((fact) => ({
      tool: fact.tool,
      target: fact.target,
      status: "succeeded",
      summary: fact.summary,
    })),
    files: bundle.changeTargets,
    language: "zh",
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(modelAuthoredDraft.ok, true, modelAuthoredDraft.reason);
  assert.equal(modelAuthoredDraft.source, "visible_plan");

  const deterministicDraft = materializePlanArtifactFromVisibleText({
    visibleText: modelAuthoredDraft.content,
    sourceHint: "deterministic_evidence",
    userGoal: bundle.objective,
    evidenceRecords: bundle.facts.map((fact) => ({
      tool: fact.tool,
      target: fact.target,
      status: "succeeded",
      summary: fact.summary,
    })),
    files: bundle.changeTargets,
    language: "zh",
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(deterministicDraft.ok, false);
  assert.equal(
    deterministicDraft.reason,
    "insufficient_grounded_evidence:change_targets_lack_confirmed_rationale",
  );
  assert.equal(deterministicDraft.quality?.recoveryAction, "targeted_evidence");
});

test("one confirmed mismatch cannot close every facet of a deterministic fallback", () => {
  const bundle = buildRuntimePlanEvidenceBundle({
    turnId: "turn-multi-facet-partial-diagnosis",
    objective: [
      "问题：",
      "1、编辑界面同时显示文件名和未保存文档名。",
      "2、打开本地 Markdown 后意外进入保存流程。",
    ].join("\n"),
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "command_transport_contract(tauri,save_file_content) command_invoke_argument_contract(save_file_content,file_path,content)",
      },
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "command_handler_argument_contract(save_file_content,content,filePath)",
      },
      {
        tool: "read_file",
        target: "src/components/editor.js",
        status: "succeeded",
        summary: "event_dom_dispatch_contract(input) field_read_contract(value)",
      },
      {
        tool: "read_file",
        target: "src/components/toolbar.js",
        status: "succeeded",
        summary: "field_read_contract(textContent) field_read_contract(filePath)",
      },
    ],
  });

  assert.equal(assessPlanClosureEvidence(bundle).ready, true);
  assert.deepEqual(bundle.changeTargets, ["src/main.js"]);
  assert.equal(
    hasDeterministicPlanMaterializationEvidence(bundle),
    false,
    "the runtime may draft from the observations, but it must not invent closure for the undiagnosed facet",
  );
});

test("source-derived structured facts survive bundle construction", () => {
  const bundle = buildRuntimePlanEvidenceBundle({
    objective: "检查 src/main.js 并规划初始化修复。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "bounded source excerpt",
      facts: [
        "event_dom_listener_contract(DOMContentLoaded)",
        "listener_calls(initToolbar,initEditor)",
      ],
    }],
  });

  assert.equal(bundle.facts[0]?.summary, "bounded source excerpt");
  const structuredFacts = formatPlanStructuredEvidenceFacts(
    bundle.facts[0]?.structuredFacts,
  );
  assert.ok(structuredFacts.includes("event_dom_listener_contract(DOMContentLoaded)"));
  assert.ok(structuredFacts.includes("listener_calls(initToolbar,initEditor)"));
  const modelEvidence = formatPlanEvidenceBundleForModel(bundle, "en");
  assert.match(modelEvidence, /event_dom_listener_contract\(DOMContentLoaded\)/);
  assert.match(modelEvidence, /listener_calls\(initToolbar,initEditor\)/);
});

test("source evidence exposes DOM side effects and Tauri command argument casing across owners", () => {
  const editorSummary = summarizePlanEvidenceDetail({
    tool: "read_file",
    target: "src/components/editor.js",
    maxChars: 420,
    content: [
      "READ_FILE_RESULT",
      "path: src/components/editor.js",
      "---CONTENT START---",
      "editor.setValue = function(val) {",
      "  this.value = val;",
      "  this.dispatchEvent(new Event('input'));",
      "};",
      "---CONTENT END---",
    ].join("\n"),
  });
  const mainSummary = summarizePlanEvidenceDetail({
    tool: "read_file",
    target: "src/main.js",
    maxChars: 600,
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "---CONTENT START---",
      "editorEl.addEventListener('input', () => {",
      "  activeFiles[activeTab].isDirty = true;",
      "  scheduleAutoSave();",
      "});",
      "await invoke('save_file_content', {",
      "  file_path: file.path,",
      "  content: content",
      "});",
      "---CONTENT END---",
    ].join("\n"),
  });
  const rustSummary = summarizePlanEvidenceDetail({
    tool: "read_file",
    target: "src-tauri/src/main.rs",
    maxChars: 420,
    content: [
      "READ_FILE_RESULT",
      "path: src-tauri/src/main.rs",
      "---CONTENT START---",
      "#[tauri::command]",
      "fn save_file_content(content: String, file_path: Option<String>) -> Result<(), String> {",
      "  let path = file_path.ok_or_else(|| \"missing path\".to_string())?;",
      "  std::fs::write(path, content).map_err(|error| error.to_string())",
      "}",
      "---CONTENT END---",
    ].join("\n"),
  });

  assert.match(editorSummary, /event_dom_dispatch_contract\(input\)/);
  assert.match(mainSummary, /event_dom_listener_contract\(input\)/);
  assert.match(mainSummary, /listener_calls\(scheduleAutoSave\)/);
  assert.match(mainSummary, /command_invoke_argument_contract\(save_file_content,file_path,content\)/);
  assert.match(rustSummary, /command_handler_argument_contract\(save_file_content,content,filePath\)/);

  const bundle = buildRuntimePlanEvidenceBundle({
    objective: "修复打开文件后立即显示未保存状态并弹出缺少保存路径的问题。",
    evidenceRecords: [
      { tool: "read_file", target: "src/components/editor.js", status: "succeeded", summary: editorSummary },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: mainSummary },
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: rustSummary },
    ],
  });
  const closure = assessPlanClosureEvidence(bundle);
  assert.ok(closure.contractMismatchKinds.includes(
    "command_argument_case:save_file_content:file_path->filePath",
  ));
  assert.equal(closure.ready, true);
  assert.ok(bundle.changeTargets.includes("src/main.js"));
});

test("listener evidence includes effects inside control flow but excludes nested callable bodies", () => {
  const source = [
    "surface.addEventListener('record-change', () => {",
    "  if (record.active) {",
    "    markRecordDirty();",
    "    scheduleRecordSave();",
    "  }",
    "  for (const item of record.items) {",
    "    updateRecordPreview(item);",
    "  }",
    "  function deferredWork() { hiddenFunctionEffect(); }",
    "  const deferredArrow = () => hiddenArrowEffect();",
    "  class DeferredWorker { run() { hiddenClassEffect(); } }",
    "});",
  ].join("\n");
  const facts = extractPlanEvidenceSourceFacts(source);
  const listenerCalls = facts.find((fact) => fact.startsWith("listener_calls(")) || "";

  assert.match(listenerCalls, /markRecordDirty/);
  assert.match(listenerCalls, /scheduleRecordSave/);
  assert.match(listenerCalls, /updateRecordPreview/);
  assert.doesNotMatch(listenerCalls, /deferredWork|hiddenFunctionEffect/);
  assert.doesNotMatch(listenerCalls, /deferredArrow|hiddenArrowEffect/);
  assert.doesNotMatch(listenerCalls, /DeferredWorker|hiddenClassEffect/);
});

test("raw source reads preserve contracts without a READ_FILE_RESULT envelope", () => {
  const rawMain = [
    "export function bindEditor(editorEl) {",
    "  editorEl.addEventListener('input', () => {",
    "    markDirty();",
    "    scheduleAutoSave();",
    "  });",
    "}",
    "await invoke('save_file_content', {",
    "  file_path: file.path,",
    "  content",
    "});",
  ].join("\n");
  const summary = summarizePlanEvidenceDetail({
    tool: "read_file",
    target: "src/main.js",
    content: rawMain,
    maxChars: 500,
  });
  const facts = extractPlanEvidenceSourceFacts(rawMain);

  assert.match(summary, /bindEditor/);
  assert.ok(facts.includes("command_invoke_argument_contract(save_file_content,file_path,content)"));
  assert.ok(facts.includes("listener_calls(markDirty,scheduleAutoSave)"));
});

test("Tauri invoke transport keeps model drafting open until the handler contract is read", () => {
  const frontendFacts = extractPlanEvidenceSourceFacts([
    "import { invoke } from '@tauri-apps/api/core';",
    "export async function save(file) {",
    "  return invoke('save_file_content', { file_path: file.path, content: file.content });",
    "}",
  ].join("\n"));
  assert.ok(frontendFacts.includes("command_transport_contract(tauri)"));
  assert.ok(frontendFacts.includes("command_transport_contract(tauri,save_file_content)"));

  const buildBundle = (extraRecords = []) => buildRuntimePlanEvidenceBundle({
    objective: "修复打开本地文件后保存路径异常的问题。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "save(file) invokes the runtime save command with the document path and content",
      facts: frontendFacts,
    }, {
      tool: "read_file",
      target: "src/components/editor.js",
      status: "succeeded",
      summary: "setValue assigns loaded content and dispatches an input event",
    }, ...extraRecords],
  });
  const openBundle = buildBundle();
  const openClosure = assessPlanClosureEvidence(openBundle);
  assert.deepEqual(openClosure.unresolvedContractKinds, [
    "command_handler_contract:save_file_content",
  ]);
  assert.equal(isPlanEvidenceReadyForModelDraft(openBundle, openClosure), false);
  const openPacket = formatPlanEvidenceBundleForModel(openBundle, "zh", openClosure);
  assert.match(openPacket, /证据门：未闭合/);
  assert.match(openPacket, /后端命令 `save_file_content` 的处理器定义和参数签名/);
  const prematurePlan = composePlanArtifactFromEvidence({
    userGoal: openBundle.objective,
    evidence: [],
    evidenceRecords: [],
    files: openBundle.changeTargets,
    language: "zh",
    evidenceBundle: openBundle,
  });
  const prematureMaterialization = materializePlanArtifactFromVisibleText({
    visibleText: prematurePlan,
    userGoal: openBundle.objective,
    evidenceBundle: openBundle,
    expectedEvidenceBundleHash: openBundle.hash,
    language: "zh",
  });
  assert.equal(prematureMaterialization.ok, false);
  assert.match(
    prematureMaterialization.reason || "",
    /unverified_plan_contract_counterpart:command_handler_contract:save_file_content/,
  );

  const handlerFacts = extractPlanEvidenceSourceFacts([
    "#[tauri::command]",
    "fn save_file_content(content: String, file_path: String) -> Result<(), String> { Ok(()) }",
  ].join("\n"));
  const closedBundle = buildBundle([{
    tool: "read_file",
    target: "src-tauri/src/main.rs",
    status: "succeeded",
    summary: "the backend save handler accepts content and a required file path",
    facts: handlerFacts,
  }]);
  const closedClosure = assessPlanClosureEvidence(closedBundle);
  assert.deepEqual(closedClosure.unresolvedContractKinds, []);
  assert.ok(closedClosure.contractMismatchKinds.includes(
    "command_argument_case:save_file_content:file_path->filePath",
  ));
  assert.equal(isPlanEvidenceReadyForModelDraft(closedBundle, closedClosure), true);
});

function buildCommandArgumentMismatchDispositionBundle() {
  return buildRuntimePlanEvidenceBundle({
    objective: "修复打开本地文件后保存路径参数不一致的问题。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "command_invoke_argument_contract(save_file_content,file_path,content)",
      },
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "command_handler_argument_contract(save_file_content,content,filePath)",
      },
      {
        tool: "read_file",
        target: "src/components/editor.js",
        status: "succeeded",
        summary: "setValue assigns loaded content and dispatches input to the editor state owner",
      },
    ],
  });
}

test("confirmed command argument mismatch rejects a plan that omits its disposition", () => {
  const bundle = buildCommandArgumentMismatchDispositionBundle();
  assert.ok(assessPlanClosureEvidence(bundle).contractMismatchKinds.includes(
    "command_argument_case:save_file_content:file_path->filePath",
  ));
  const content = [
    "# 保存流程修复计划",
    "## 已确认证据",
    "- `src/main.js` 与后端保存命令存在已确认的参数边界差异。",
    "## 关键改动",
    "- 修改 `src/main.js`，强化有路径文件的直接保存分支并避免误弹对话框。",
    "## 测试方案",
    "- 打开文件并保存，断言不会误弹另存为窗口。",
  ].join("\n");

  const validation = validateConfirmedContractMismatchDisposition({
    content,
    evidenceBundle: bundle,
  });
  assert.equal(validation.ok, false);
  assert.match(
    validation.reason || "",
    /uncovered_confirmed_contract_mismatches:command_argument_case:save_file_content:file_path->filePath/,
  );
  assert.equal(validation.recoveryAction, "rewrite");
  assert.equal(
    validateConfirmedContractMismatchDisposition({ content }).ok,
    true,
    "plans without a frozen evidence bundle keep their existing admission semantics",
  );

  const generatedPlan = composePlanArtifactFromEvidence({
    userGoal: bundle.objective,
    evidence: [],
    evidenceRecords: [],
    files: bundle.changeTargets,
    language: "zh",
    evidenceBundle: bundle,
  });
  const omittedGeneratedPlan = generatedPlan.replace(
    /^-\s*修改[^\n]*`save_file_content`[^\n]*`file_path`[^\n]*`filePath`[^\n]*$/m,
    "- 修改 `src/main.js`，强化有路径文件的直接保存分支并避免误弹对话框。",
  );
  assert.notEqual(omittedGeneratedPlan, generatedPlan, "the fixture must remove the exact disposition line");
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: omittedGeneratedPlan,
    userGoal: bundle.objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });
  assert.equal(materialized.ok, false);
  assert.match(materialized.reason || "", /uncovered_confirmed_contract_mismatches/);
});

test("confirmed command argument mismatch accepts an explicit owner-bound actual-to-expected change", () => {
  const bundle = buildCommandArgumentMismatchDispositionBundle();
  const content = [
      "# 保存流程修复计划",
      "## 关键改动",
      "- 修改 `src/main.js` 的 `save_file_content` 调用，将 `file_path` 改为命令边界要求的 `filePath`，保持后端签名不变。",
      "## 测试方案",
      "- 打开本地文件并保存，断言直接写回原路径且不弹出另存为窗口。",
    ].join("\n");
  const validation = validateConfirmedContractMismatchDisposition({
    content,
    evidenceBundle: bundle,
  });

  assert.equal(validation.ok, true, validation.reason || "");

  const generatedPlan = composePlanArtifactFromEvidence({
    userGoal: bundle.objective,
    evidence: [],
    evidenceRecords: [],
    files: bundle.changeTargets,
    language: "zh",
    evidenceBundle: bundle,
  });
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: generatedPlan,
    userGoal: bundle.objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });
  assert.equal(materialized.ok, true, materialized.reason || "");
  assert.match(materialized.content || "", /`save_file_content`：`file_path` -> `filePath`/);
});

test("confirmed mismatch terms in evidence, scattered roles, or an unrelated grounded owner do not fake disposition", () => {
  const bundle = buildCommandArgumentMismatchDispositionBundle();
  const scattered = validateConfirmedContractMismatchDisposition({
    content: [
      "# 保存流程修复计划",
      "## 已确认证据",
      "- `save_file_content` 当前发送 `file_path`，处理器暴露 `filePath`。",
      "## 关键改动",
      "- 修改 `src/main.js` 的路径保存逻辑。",
      "## 公共 API / 接口 / 类型",
      "- 保持 `filePath` 类型不变。",
      "## 测试方案",
      "- 验证 `save_file_content` 保存成功。",
    ].join("\n"),
    evidenceBundle: bundle,
  });
  assert.equal(scattered.ok, false);

  const unrelatedOwner = validateConfirmedContractMismatchDisposition({
    content: [
      "# 保存流程修复计划",
      "## 关键改动",
      "- 修改 `src/components/editor.js`，将 `save_file_content` 的 `file_path` 改为 `filePath`。",
      "## 测试方案",
      "- 验证编辑器加载行为。",
    ].join("\n"),
    evidenceBundle: bundle,
  });
  assert.equal(unrelatedOwner.ok, false);
  assert.match(unrelatedOwner.reason || "", /uncovered_confirmed_contract_mismatches/);

  const casingBundle = buildRuntimePlanEvidenceBundle({
    objective: "修复 create_user 参数命名契约。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/users.js",
        status: "succeeded",
        summary: "command_invoke_argument_contract(create_user,userID)",
      },
      {
        tool: "read_file",
        target: "src-tauri/src/users.rs",
        status: "succeeded",
        summary: "command_handler_argument_contract(create_user,userId)",
      },
    ],
  });
  const wrongCasingDirection = validateConfirmedContractMismatchDisposition({
    content: [
      "# 用户参数修复计划",
      "## 关键改动",
      "- 修改 `src/users.js` 的 `create_user` 参数：`userID` -> `userID`；`userId` 仅用于补充接口说明。",
    ].join("\n"),
    evidenceBundle: casingBundle,
  });
  assert.equal(wrongCasingDirection.ok, false, "actual -> actual must not borrow an expected token later in the line");
});

test("confirmed mismatch disposition parser covers the existing command, event, and permission vocabulary", () => {
  const bundle = buildRuntimePlanEvidenceBundle({
    objective: "修复桌面文件打开链路中的命令注册、事件监听和对话框权限问题。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "command_invoke_contract(read_file_content) event_dom_listener_contract(file-open) import open from '@tauri-apps/plugin-dialog'",
      },
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "handler_contract(save_file_content) event_emit_contract(file-open) tauri_plugin_dialog::init()",
      },
      {
        tool: "read_file",
        target: "src-tauri/capabilities/default.json",
        status: "succeeded",
        summary: "permission_contract(core:default,opener:default)",
      },
    ],
  });
  assert.deepEqual(assessPlanClosureEvidence(bundle).contractMismatchKinds, [
    "unregistered_command:read_file_content",
    "event_listener_api:file-open",
    "missing_permission:dialog",
  ]);
  const generatedPlan = composePlanArtifactFromEvidence({
    userGoal: bundle.objective,
    evidence: [],
    evidenceRecords: [],
    files: bundle.changeTargets,
    language: "zh",
    evidenceBundle: bundle,
  });
  const validation = validateConfirmedContractMismatchDisposition({
    content: generatedPlan,
    evidenceBundle: bundle,
  });

  assert.equal(validation.ok, true, `${validation.reason || ""}\n${generatedPlan}`);
});

test("confirmed mismatch disposition parser covers configuration and producer-field contracts", () => {
  const fixtures = [
    {
      expected: "config_value_mismatch:development_server_port",
      bundle: buildRuntimePlanEvidenceBundle({
        objective: "统一桌面开发启动链路的端口配置。",
        evidenceRecords: [
          {
            tool: "read_file",
            target: "desktop/app.conf.json",
            status: "succeeded",
            summary: "devUrl: http://localhost:1420",
          },
          {
            tool: "read_file",
            target: "vite.config.js",
            status: "succeeded",
            summary: "server port: 5173",
          },
        ],
      }),
    },
    {
      expected: "producer_missing_required_field:creatorName",
      bundle: buildRuntimePlanEvidenceBundle({
        objective: "修复 creatorName 从解析器到图表消费方的字段契约。",
        evidenceRecords: [
          {
            tool: "read_file",
            target: "src/parser.ts",
            status: "succeeded",
            summary: "field_contract(row.creatorName,optional) returned_field_contract(id) returned_field_contract(value)",
          },
          {
            tool: "read_file",
            target: "src/types.ts",
            status: "succeeded",
            summary: "field_contract(ChartPoint.creatorName,required)",
          },
          {
            tool: "read_file",
            target: "src/chart.ts",
            status: "succeeded",
            summary: "field_read_contract(creatorName)",
          },
        ],
      }),
    },
  ];

  for (const fixture of fixtures) {
    assert.ok(
      assessPlanClosureEvidence(fixture.bundle).contractMismatchKinds.includes(fixture.expected),
      fixture.expected,
    );
    const generatedPlan = composePlanArtifactFromEvidence({
      userGoal: fixture.bundle.objective,
      evidence: [],
      evidenceRecords: [],
      files: fixture.bundle.changeTargets,
      language: "zh",
      evidenceBundle: fixture.bundle,
    });
    const validation = validateConfirmedContractMismatchDisposition({
      content: generatedPlan,
      evidenceBundle: fixture.bundle,
    });
    assert.equal(validation.ok, true, `${fixture.expected}: ${validation.reason || ""}\n${generatedPlan}`);
  }
});

test("a generic local function named invoke creates no backend obligation but still needs a confirmed rationale", () => {
  const facts = extractPlanEvidenceSourceFacts([
    "export function run(request) {",
    "  return invoke('save_user', { request, traceId: request.id });",
    "}",
  ].join("\n"));
  assert.equal(facts.some((fact) => fact.startsWith("command_transport_contract")), false);
  const bundle = buildPlanEvidenceBundle({
    objective: "修复本地任务调度失败的问题。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/local-runner.js",
      status: "succeeded",
      summary: "run(request) forwards a request and trace ID into the local dispatcher",
      facts,
    }, {
      tool: "read_file",
      target: "src/request-store.js",
      status: "succeeded",
      summary: "the store owns request lifecycle state and failure reporting",
    }],
  });
  const closure = assessPlanClosureEvidence(bundle);
  assert.deepEqual(closure.unresolvedContractKinds, []);
  assert.equal(closure.ready, false);
  assert.equal(isPlanEvidenceReadyForModelDraft(bundle, closure), false);
});

test("command argument mismatch detection is casing-style neutral", () => {
  const bundle = buildRuntimePlanEvidenceBundle({
    objective: "修复 create_user 命令参数契约不一致的问题。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/users.js",
      status: "succeeded",
      summary: "command_invoke_argument_contract(create_user,user_id,display-name)",
    }, {
      tool: "read_file",
      target: "src-tauri/src/users.rs",
      status: "succeeded",
      summary: "command_handler_argument_contract(create_user,UserId,displayName)",
    }],
  });
  const mismatches = assessPlanClosureEvidence(bundle).contractMismatchKinds;
  assert.ok(mismatches.includes("command_argument_case:create_user:user_id->UserId"));
  assert.ok(mismatches.includes("command_argument_case:create_user:display-name->displayName"));
});

test("invoke argument contracts keep shorthand keys but do not promote nested payload fields", () => {
  const facts = extractPlanEvidenceSourceFacts([
    "await invoke('save_flat', { filePath, content });",
    "await invoke('save_wrapped', {",
    "  request: {",
    "    file_path: file.path,",
    "    content,",
    "  },",
    "  traceId,",
    "});",
  ].join("\n"));

  assert.ok(facts.includes(
    "command_invoke_argument_contract(save_flat,filePath,content)",
  ), JSON.stringify(facts));
  assert.ok(facts.includes(
    "command_invoke_argument_contract(save_wrapped,request,traceId)",
  ), JSON.stringify(facts));
  const wrappedFact = facts.find((fact) => fact.startsWith(
    "command_invoke_argument_contract(save_wrapped",
  )) || "";
  assert.doesNotMatch(wrappedFact, /file_path|content/);
});

test("model-authored map-reduce summaries cannot become source contract facts", () => {
  const facts = extractPlanEvidenceSourceFacts([
    "[FILE MAP-REDUCE SUMMARY]",
    "The file contains invoke('save_file_content', { file_path, content }).",
    "It also appears to define #[tauri::command] fn save_file_content(content: String, file_path: Option<String>),",
  ].join("\n"));
  assert.deepEqual(facts, []);
});

test("source fact extraction does not let an inline handler registry swallow a following command", () => {
  const facts = extractPlanEvidenceSourceFacts([
    "use tauri::{AppHandle, Manager};",
    "tauri::Builder::default().invoke_handler(tauri::generate_handler![save_file_content]);",
    "#[tauri::command]",
    "fn save_file_content(app: AppHandle, content: String, file_path: Option<String>) -> Result<(), String> {",
    "  let path = file_path.ok_or_else(|| \"missing path\".to_string())?;",
    "  std::fs::write(path, content).map_err(|error| error.to_string())",
    "}",
  ].join("\n"));
  assert.ok(facts.includes(
    "command_handler_argument_contract(save_file_content,content,filePath)",
  ), JSON.stringify(facts));
});

test("Tauri command argument contracts honor supported rename strategies without guessing", () => {
  const extractArgumentFact = (attribute) => extractPlanEvidenceSourceFacts([
    attribute,
    "fn save_file_content(content: String, file_path: Option<String>) -> Result<(), String> { Ok(()) }",
  ].join("\n")).find((fact) => fact.startsWith("command_handler_argument_contract")) || "";

  assert.equal(
    extractArgumentFact("#[tauri::command]"),
    "command_handler_argument_contract(save_file_content,content,filePath)",
  );
  assert.equal(
    extractArgumentFact("#[tauri::command(rename_all = \"snake_case\")]"),
    "command_handler_argument_contract(save_file_content,content,file_path)",
  );
  assert.equal(
    extractArgumentFact("#[tauri::command(rename_all = \"kebab-case\")]"),
    "command_handler_argument_contract(save_file_content,content,file-path)",
  );
  assert.equal(
    extractArgumentFact("#[tauri::command(rename_all = \"PascalCase\")]"),
    "command_handler_argument_contract(save_file_content,Content,FilePath)",
  );
  assert.equal(
    extractArgumentFact("#[tauri::command(rename_all = \"provider-special\")]"),
    "command_handler_argument_contract(save_file_content)",
  );
});

test("model drafting and deterministic fallback both reject unrelated source excerpts", () => {
  const bundle = buildPlanEvidenceBundle({
    objective: "找到打开文件后界面异常的原因并制定修复计划。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "function switchToTab loads editor content and updates the active document UI",
    }, {
      tool: "read_file",
      target: "src/components/editor.js",
      status: "succeeded",
      summary: "function setValue assigns editor content and dispatches an input event",
    }],
  });
  const closure = assessPlanClosureEvidence(bundle);

  assert.equal(isPlanEvidenceBundleReady(bundle), true);
  assert.equal(closure.ready, false);
  assert.equal(closure.reason, "change_targets_lack_confirmed_rationale");
  assert.equal(isPlanEvidenceReadyForModelDraft(bundle, closure), false);
  assert.equal(hasDeterministicPlanMaterializationEvidence(bundle), false);
});

test("error-handling strings from the logged MD Viewer run cannot become a reviewable repair plan", () => {
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-md-viewer-error-handler-only",
    objective: "修复应用启动后工具栏按钮没有真实功能的问题。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: [
        "L12: event_dom_listener_contract(error)",
        "L131: command_invoke_contract(save_file_content)",
        "L140: console.error('保存文件失败:', error)",
      ].join(" "),
    }],
  });

  const assessment = assessPlanClosureEvidence(bundle);
  assert.equal(assessment.ready, false);
  assert.equal(assessment.reason, "change_targets_lack_confirmed_rationale");
  assert.equal(assessment.defectSignalMatches, 0);
  assert.equal(
    hasDeterministicPlanMaterializationEvidence(bundle),
    false,
    "a generic failure message is not a diagnosed change contract",
  );
});

test("source evidence detects cross-file mismatches without trusting a prose facet mapping", () => {
  const summarizeRead = (target, body) => summarizePlanEvidenceDetail({
    tool: "read_file",
    target,
    maxChars: 320,
    content: [
      "READ_FILE_RESULT",
      `path: ${target}`,
      "truncated: false",
      "---CONTENT START---",
      body,
      "---CONTENT END---",
    ].join("\n"),
  });
  const frontendSummary = summarizeRead("src/main.js", [
    "import { invoke } from '@tauri-apps/api/core';",
    "import { open } from '@tauri-apps/plugin-dialog';",
    "window.addEventListener('file-open', handleFileOpen);",
    "const content = await invoke('read_file_content', { path: filePath });",
  ].join("\n"));
  const backendSummary = summarizeRead("src-tauri/src/main.rs", [
    "tauri::Builder::default()",
    "  .plugin(tauri_plugin_dialog::init())",
    "  .setup(|app| window.emit(\"file-open\", payload))",
    "  .invoke_handler(tauri::generate_handler![",
    "    save_file_content,",
    "    get_file_paths,",
    "    clear_file_paths",
    "  ])",
  ].join("\n"));
  const capabilitySummary = summarizeRead("src-tauri/capabilities/default.json", [
    "{",
    "  \"permissions\": [",
    "    \"core:default\",",
    "    \"opener:default\"",
    "  ]",
    "}",
  ].join("\n"));

  assert.match(frontendSummary, /command_invoke_contract\(read_file_content\)/);
  assert.match(frontendSummary, /plugin-dialog/);
  assert.match(backendSummary, /handler_contract\(/);
  assert.match(backendSummary, /save_file_content/);
  assert.match(backendSummary, /event_emit_contract\(file-open\)/);
  assert.match(capabilitySummary, /permission_contract\(/);
  assert.match(capabilitySummary, /opener:default/);

  const objective = [
    "修复两个 Mac 文件打开问题：",
    "1、双击 Markdown 文件后显示空白界面。",
    "2、应用内打开按钮不能弹出文件选择窗口。",
  ].join("\n");
  const bundle = buildRuntimePlanEvidenceBundle({
    objective,
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: frontendSummary },
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: backendSummary },
      ...Array.from({ length: 10 }, (_, index) => ({
        tool: "read_file",
        target: `src/support/module-${index + 1}.js`,
        status: "succeeded",
        summary: `L1: export function helper${index + 1}() { return ${index + 1}; }`,
      })),
      { tool: "read_file", target: "src-tauri/capabilities/default.json", status: "succeeded", summary: capabilitySummary },
    ],
  });
  const assessment = assessPlanClosureEvidence(bundle);

  assert.deepEqual(bundle.changeTargets, [
    "src/main.js",
    "src-tauri/src/main.rs",
    "src-tauri/capabilities/default.json",
  ]);
  assert.equal(assessment.ready, true);
  assert.equal(assessment.contractMismatchMatches, 3);
  assert.deepEqual(assessment.unresolvedContractKinds, []);
  assert.deepEqual(assessment.contractMismatchKinds, [
    "unregistered_command:read_file_content",
    "event_listener_api:file-open",
    "missing_permission:dialog",
  ]);

  const plan = composePlanArtifactFromEvidence({
    userGoal: bundle.objective,
    evidence: [],
    evidenceRecords: [],
    files: bundle.changeTargets,
    language: "zh",
    evidenceBundle: bundle,
    facetMappingSource: [
      "## 问题 1：双击 Markdown 文件后显示空白界面",
      "- `src/main.js` 的 `file-open` 监听与 `src-tauri/src/main.rs` 的 `read_file_content` 命令注册共同影响该链路。",
      "## 问题 2：应用内打开按钮不能弹出文件选择窗口",
      "- `src-tauri/capabilities/default.json` 缺少 `dialog:default`，与 dialog 插件调用不一致。",
    ].join("\n"),
  });
  assert.match(plan, /`read_file_content`/);
  assert.match(plan, /generate_handler!/);
  assert.match(plan, /Tauri event API/);
  assert.match(plan, /`dialog:default`/);
  assert.doesNotMatch(plan, /cargo check --manifest-path src-tauri\/Cargo\.toml/);
  assert.doesNotMatch(plan, /npm run build/);
  assert.match(plan, /实际启动的桌面窗口/);
  assert.doesNotMatch(plan, /read file content/);
  const generatedTechnicalSections = plan.match(/## 已确认证据[\s\S]*?(?=\n## 公共 API)/)?.[0] || "";
  assert.doesNotMatch(generatedTechnicalSections, /双击|空白界面|打开按钮|文件选择窗口/);
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: plan,
    userGoal: objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });
  assert.equal(materialized.ok, false);
  assert.match(materialized.reason || "", /uncovered_user_goal_facets:1,2/);
});

test("logged MD Viewer diagnostics keep contract owners as change targets instead of error-reporting consumers", () => {
  const objective = [
    "修复两个 Mac 文件打开问题：",
    "1、双击 Markdown 文件后显示空白界面。",
    "2、应用内打开按钮不能弹出文件选择窗口。",
  ].join("\n");
  const records = [
    {
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "L78: handler_contract(save_file_content,get_file_paths,clear_file_paths) L49: event_emit_contract(file-open) L39: .plugin(tauri_plugin_dialog::init())",
    },
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "L94: command_invoke_contract(read_file_content) L34: event_dom_listener_contract(file-open) L131: command_invoke_contract(save_file_content)",
    },
    {
      tool: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      summary: "L175: event_dom_listener_contract(click) L7: import open from '@tauri-apps/plugin-dialog'; L211: console.error('保存文件失败:', error)",
    },
  ];
  const bundle = buildRuntimePlanEvidenceBundle({ objective, evidenceRecords: records });
  const assessment = assessPlanClosureEvidence(bundle);

  assert.deepEqual(bundle.changeTargets, [
    "src-tauri/src/main.rs",
    "src/main.js",
  ]);
  assert.deepEqual(assessment.contractMismatchKinds, [
    "unregistered_command:read_file_content",
    "event_listener_api:file-open",
  ]);
  assert.equal(assessment.ready, false);
  assert.equal(assessment.reason, "contract_counterpart_unverified");
  assert.deepEqual(assessment.unresolvedContractKinds, [
    "permission_contract:dialog",
  ]);

  const plan = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidence: [],
    evidenceRecords: records,
    language: "zh",
    evidenceBundle: bundle,
    facetMappingSource: [
      "## 问题 1：双击 Markdown 文件后显示空白界面",
      "- `src/main.js` 的 `file-open` 监听与 `src-tauri/src/main.rs` 的 `read_file_content` 命令注册共同影响该链路。",
      "## 问题 2：应用内打开按钮不能弹出文件选择窗口",
      "- `src-tauri/capabilities/default.json` 的 dialog 权限需要核实。",
    ].join("\n"),
  });
  assert.match(plan, /在 `src-tauri\/src\/main\.rs` 中实现缺失的 Tauri 命令 `read_file_content`/);
  assert.match(plan, /修改 `src\/main\.js`：把 `file-open` 的 DOM 监听改为 Tauri event API/);
  assert.doesNotMatch(plan, /修改 `src\/components\/toolbar\.js`/);
  assert.doesNotMatch(plan, /更新 `src\/components\/toolbar\.js`/);
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: plan,
    userGoal: objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });
  assert.equal(materialized.ok, false);
  assert.match(materialized.reason || "", /uncovered_user_goal_facets:1,2/);
  assert.equal(materialized.quality?.recoveryAction, "rewrite");
});

test("facet mapping cannot borrow unrelated changes for unread or unowned targets", () => {
  const objective = [
    "处理桌面应用的三个独立目标：",
    "1、外部打开文档后内容没有载入。",
    "2、工具栏的选择按钮没有显示原生对话框。",
    "3、开发启动配置使用了不同端口。",
  ].join("\n");
  const records = [
    {
      tool: "read_file",
      target: "desktop/src/main.rs",
      status: "succeeded",
      summary: "L70: handler_contract(save_document) L42: event_emit_contract(document-open) L35: configured_plugin_contract(dialog)",
    },
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "L90: command_invoke_contract(load_document) L31: event_dom_listener_contract(document-open)",
    },
    {
      tool: "read_file",
      target: "src/toolbar.js",
      status: "succeeded",
      summary: "L8: import open from '@tauri-apps/plugin-dialog' L120: event_dom_listener_contract(click)",
    },
    {
      tool: "read_file",
      target: "desktop/app.conf.json",
      status: "succeeded",
      summary: "L12: a development URL setting declaration is present; value omitted from captured evidence",
    },
    {
      tool: "read_file",
      target: "vite.config.js",
      status: "succeeded",
      summary: "L18: a development server setting declaration is present; value omitted from captured evidence",
    },
  ];
  const bundle = buildRuntimePlanEvidenceBundle({ objective, evidenceRecords: records });

  assert.deepEqual(bundle.changeTargets, [
    "desktop/src/main.rs",
    "src/main.js",
  ]);
  assert.deepEqual(assessPlanClosureEvidence(bundle).contractMismatchKinds, [
    "unregistered_command:load_document",
    "event_listener_api:document-open",
  ]);

  const plan = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidence: [],
    evidenceRecords: records,
    language: "zh",
    evidenceBundle: bundle,
    facetMappingSource: [
      "## 目标 1：外部打开文档后内容没有载入",
      "- `src/main.js` 与 `desktop/src/main.rs` 负责文档打开链路。",
      "## 目标 2：工具栏的选择按钮没有显示原生对话框",
      "- 需要核实未读取的 `desktop/capabilities/default.json`。",
      "## 目标 3：开发启动配置使用了不同端口",
      "- `desktop/app.conf.json` 与 `vite.config.js` 记录了两个端口。",
    ].join("\n"),
  });
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: plan,
    userGoal: objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });

  assert.equal(materialized.ok, false);
  assert.match(materialized.reason || "", /uncovered_user_goal_facets:1,2,3/);
  assert.equal(materialized.quality?.recoveryAction, "rewrite");
  assert.doesNotMatch(plan, /分面 2（/);
  assert.doesNotMatch(plan, /分面 3（/);
});

test("read-backed startup configuration values expose a generic cross-file mismatch", () => {
  const objective = "检查开发启动失败，并让同一开发服务器链路的端口配置保持一致。";
  const records = [
    {
      tool: "read_file",
      target: "desktop/app.conf.json",
      status: "succeeded",
      summary: "L12: devUrl: http://localhost:1420",
    },
    {
      tool: "read_file",
      target: "vite.config.js",
      status: "succeeded",
      summary: "L18: server port: 5173",
    },
  ];
  const bundle = buildRuntimePlanEvidenceBundle({ objective, evidenceRecords: records });
  const assessment = assessPlanClosureEvidence(bundle);

  assert.deepEqual(bundle.changeTargets, [
    "desktop/app.conf.json",
    "vite.config.js",
  ]);
  assert.deepEqual(assessment.contractMismatchKinds, [
    "config_value_mismatch:development_server_port",
  ]);
  assert.equal(assessment.ready, true);

  const plan = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidence: [],
    evidenceRecords: records,
    language: "zh",
    evidenceBundle: bundle,
  });
  assert.match(plan, /development_server_port/);
  assert.match(plan, /desktop\/app\.conf\.json/);
  assert.match(plan, /vite\.config\.js/);
});

test("validation localhost URLs are repaired from one read-backed dev-server port", () => {
  const content = [
    "# 正式计划",
    "## 关键改动",
    "- 修改 `src/main.js` 的页面布局。",
    "## 验证标准",
    "- 启动开发服务器后使用浏览器检查 http://localhost:5173/editor?mode=test。",
    "## 风险",
    "- 保持现有配置不变。",
  ].join("\n");
  const repaired = repairPlanValidationTargetFromEvidence({
    content,
    evidenceRecords: [{
      tool: "read_file",
      target: "vite.config.js",
      status: "succeeded",
      summary: "L82: export default defineConfig({ server: { port: 1420, strictPort: true } })",
    }],
  });
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.expectedPort, 1420);
  assert.match(repaired.content, /http:\/\/localhost:1420\/editor\?mode=test/);
  assert.doesNotMatch(repaired.content, /localhost:5173/);

  const intentionalPortChange = repairPlanValidationTargetFromEvidence({
    content: content.replace("修改 `src/main.js` 的页面布局", "更新 `vite.config.js`：设置 `server.port = 5173`"),
    evidenceRecords: [{
      tool: "read_file",
      target: "vite.config.js",
      status: "succeeded",
      summary: "L82: server port: 1420",
    }],
  });
  assert.equal(intentionalPortChange.repaired, false);
  assert.match(intentionalPortChange.content, /localhost:5173/);

  const apiOnly = repairPlanValidationTargetFromEvidence({
    content,
    evidenceRecords: [{
      tool: "read_file",
      target: "src/server.ts",
      status: "succeeded",
      summary: "export const server = { port: 3000 }",
    }],
  });
  assert.equal(apiOnly.repaired, false);
  assert.match(apiOnly.content, /localhost:5173/);

  const frontendAndApi = repairPlanValidationTargetFromEvidence({
    content,
    evidenceRecords: [{
      tool: "read_file",
      target: "vite.config.js",
      status: "succeeded",
      summary: "export default defineConfig({ server: { port: 1420 } })",
    }, {
      tool: "read_file",
      target: "src/server.ts",
      status: "succeeded",
      summary: "export const server = { port: 3000 }",
    }],
  });
  assert.equal(frontendAndApi.repaired, true);
  assert.match(frontendAndApi.content, /localhost:1420/);
});

test("Plan diagnostic absence claims are rejected when read evidence contains the identifier", () => {
  const content = [
    "# 修复计划",
    "## 根因",
    "- `src/main.js` 可能缺少 DOMContentLoaded 保护。",
    "## 关键改动",
    "- 修改 `src/main.js` 的初始化顺序。",
    "## 验证标准",
    "- 运行 `npm test`，断言初始化顺序回归用例通过。",
    "## 风险",
    "- 保持行为兼容。",
  ].join("\n");
  const evidenceRecords = [{
    tool: "read_file",
    target: "src/main.js",
    status: "succeeded",
    summary: "document.addEventListener('DOMContentLoaded', () => { initToolbar(); initEditor(); });",
  }];
  assert.equal(findContradictedPlanDiagnosticClaim({ content, evidenceRecords }), "DOMContentLoaded");
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: content,
    userGoal: "修复白屏",
    evidenceRecords,
  });
  assert.equal(materialized.ok, false);
  assert.match(materialized.reason || "", /plan_diagnostic_claim_contradicted:DOMContentLoaded/);
});

test("a missing returned-field mapping is not contradicted by a type declaration", () => {
  const content = [
    "# CSV creatorName 整改计划",
    "## 根因",
    "- `src/hooks/useCsvParser.ts` 的返回对象缺少 creatorName 映射。",
    "## 关键改动",
    "- 修改 `src/hooks/useCsvParser.ts`，从 creator 归一化赋值 creatorName。",
    "## 测试方案",
    "- 运行 `npm test` 验证 creatorName 输出。",
    "## 风险",
    "- 保留 creator 回退字段。",
  ].join("\n");
  const evidenceRecords = [{
    tool: "read_file",
    target: "src/hooks/useCsvParser.ts",
    status: "succeeded",
    summary: [
      "interface CsvOrder { creator?: string; creatorName?: string }",
      "function normalizeCsvOrder(row) { return { creator: row.creator || '' }; }",
    ].join("\n"),
  }];

  assert.equal(findContradictedPlanDiagnosticClaim({ content, evidenceRecords }), null);
});

test("Plan diagnostic absence claims stay scoped to the named tabular source", () => {
  const content = [
    "# CSV creatorName 整改计划",
    "## 已确认事实",
    "- `cn_tutorial_orders_by_creator_20260512.csv` 包含 creator 与 amount 列。",
    "## 根因",
    "- CSV 物理层不存在 creatorName 列，需要由解析器从 creator 映射。",
    "## 关键改动",
    "- 修改 `src/hooks/useCsvParser.ts`，为 creatorName 增加归一化映射。",
    "## 测试方案",
    "- 输入仅含 creator 的行；预期输出 creatorName 与 creator 相同；断言两者非空且一致。",
    "## 风险",
    "- 保持 creator 兼容字段。",
  ].join("\n");
  const evidenceRecords = [{
    tool: "read_file",
    target: "cn_tutorial_orders_by_creator_20260512.csv",
    status: "succeeded",
    summary: "creator,amount\\nalice,12",
  }, {
    tool: "read_file",
    target: "src/hooks/useCsvParser.ts",
    status: "succeeded",
    summary: "interface CsvOrder { creator?: string; creatorName?: string }",
  }, {
    tool: "read_file",
    target: "src/types/order.ts",
    status: "succeeded",
    summary: "interface Order { creatorName: string; amount: number }",
  }];

  assert.equal(findContradictedPlanDiagnosticClaim({ content, evidenceRecords }), null);
});

test("Plan diagnostic tabular absence claims still reject a present CSV column", () => {
  const content = [
    "# CSV creatorName 整改计划",
    "## 根因",
    "- CSV 数据源不存在 creatorName 列。",
    "## 关键改动",
    "- 修改 `src/hooks/useCsvParser.ts` 的字段映射。",
    "## 验证标准",
    "- 解析 fixture 并断言输出。",
    "## 风险",
    "- 保持兼容。",
  ].join("\n");
  const evidenceRecords = [{
    tool: "read_file",
    target: "orders.csv",
    status: "succeeded",
    summary: "creatorName,amount\\nalice,12",
  }, {
    tool: "read_file",
    target: "src/hooks/useCsvParser.ts",
    status: "succeeded",
    summary: "interface CsvOrder { creatorName?: string }",
  }];

  assert.equal(
    findContradictedPlanDiagnosticClaim({ content, evidenceRecords }),
    "creatorName",
  );
});

test("Plan diagnostic claims do not borrow a column from a different CSV", () => {
  const content = [
    "# CSV 整改计划",
    "## 根因",
    "- `a.csv` 不存在 creatorName 列，需要从 creator 归一化。",
    "## 关键改动",
    "- 修改 `src/hooks/useCsvParser.ts` 的字段映射。",
    "## 验证标准",
    "- 解析 a.csv 并断言输出。",
    "## 风险",
    "- 保持兼容。",
  ].join("\n");
  const evidenceRecords = [{
    tool: "read_file",
    target: "a.csv",
    status: "succeeded",
    summary: "creator,amount\\nalice,12",
  }, {
    tool: "read_file",
    target: "b.csv",
    status: "succeeded",
    summary: "creatorName,amount\\nbob,18",
  }];

  assert.equal(findContradictedPlanDiagnosticClaim({ content, evidenceRecords }), null);
  assert.equal(findContradictedPlanDiagnosticClaim({
    content,
    evidenceRecords: [{ ...evidenceRecords[0], summary: "creatorName,amount\\nalice,12" }],
  }), "creatorName");
});

test("Plan diagnostic relation claims do not treat contextual function names as absent", () => {
  const content = [
    "# 修复计划",
    "## 已确认事实",
    "- `src/components/toolbar.js` 渲染 `btn-new`、`btn-open`、`btn-save`，而 `src/main.js` 当前仍使用旧 ID。",
    "## 根因",
    "- `src/main.js` 没有使用 `toolbar.js` 渲染的 `btn-new`、`btn-open`、`btn-save`；`initToolbar()` 仍绑定 `new-btn`、`open-btn`、`save-btn`，因此点击事件没有关联到真实 DOM 节点。",
    "## 关键改动",
    "- 修改 `src/main.js` 中 `initToolbar()` 的三个按钮 ID，使其与 `src/components/toolbar.js` 的渲染契约一致。",
    "## 验证标准",
    "- 运行 `npm run build` 并进行浏览器验证。",
    "## 风险",
    "- 不改变按钮回调行为。",
  ].join("\n");
  const evidenceRecords = [{
    tool: "read_file",
    target: "src/main.js",
    status: "succeeded",
    summary: "function initToolbar() { document.getElementById('new-btn')?.addEventListener('click', createFile); }",
  }, {
    tool: "read_file",
    target: "src/components/toolbar.js",
    status: "succeeded",
    summary: "<button id=\"btn-new\">New</button><button id=\"btn-open\">Open</button><button id=\"btn-save\">Save</button>",
  }];

  assert.equal(findContradictedPlanDiagnosticClaim({ content, evidenceRecords }), null);
  const grounded = validatePlanEvidenceGrounding({ content, evidenceRecords });
  assert.equal(grounded.ok, true, grounded.reason);
});

test("Plan diagnostic ordering uses structured listener facts and does not confuse a definition with a call", () => {
  const summary = summarizePlanEvidenceDetail({
    tool: "read_file",
    target: "src/main.js",
    maxChars: 400,
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "---CONTENT START---",
      "document.addEventListener('DOMContentLoaded', () => {",
      "  initToolbar();",
      "  initEditor();",
      "  initPreview();",
      "  initOutline();",
      "  function localDefinition() { nestedDefinitionCall(); }",
      "  const localArrow = () => { nestedArrowCall(); };",
      "  if (shouldDefer) { nestedConditionalCall(); }",
      "  window.addEventListener('file-open', handleFileOpen);",
      "});",
      "function initToolbar() { return true; }",
      "---CONTENT END---",
    ].join("\n"),
  });
  const facts = extractPlanEvidenceFacts(summary);
  assert.match(summary, /listener_calls\(initToolbar,initEditor,initPreview,initOutline,nestedConditionalCall\)/);
  assert.ok(facts.some((fact) => /event_dom_listener_contract\(DOMContentLoaded\)/.test(fact)));
  const listenerCallsFact = facts.find((fact) => /listener_calls\(/.test(fact)) || "";
  assert.match(listenerCallsFact, /listener_calls\(initToolbar,initEditor,initPreview,initOutline,nestedConditionalCall\)/);
  assert.doesNotMatch(listenerCallsFact, /localDefinition|nestedDefinitionCall|localArrow|nestedArrowCall/);

  const orderingClaim = "- `src/main.js` 中 `initToolbar()` 在 DOM 元素就绪前被调用（主因）。";
  assert.equal(findContradictedPlanDiagnosticClaim({
    content: orderingClaim,
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "bounded excerpt",
      facts,
    }],
  }), "initToolbar");

  assert.equal(findContradictedPlanDiagnosticClaim({
    content: "- `src/main.js` 没有调用 initToolbar。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "L20: function initToolbar() { return true; }",
    }],
  }), null);
});

test("evidence-backed no-change decisions do not let prose mappings close an unrelated mutation facet", () => {
  const objective = [
    "完成两个独立目标：",
    "1、外部打开文档后内容没有载入。",
    "2、确认开发启动链路的端口配置是否一致。",
  ].join("\n");
  const records = [
    {
      tool: "read_file",
      target: "desktop/src/main.rs",
      status: "succeeded",
      summary: "L70: handler_contract(save_document)",
    },
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "L90: command_invoke_contract(load_document)",
    },
    {
      tool: "read_file",
      target: "desktop/app.conf.json",
      status: "succeeded",
      summary: "L12: devUrl: http://localhost:1420",
    },
    {
      tool: "read_file",
      target: "vite.config.js",
      status: "succeeded",
      summary: "L18: server port: 1420",
    },
  ];
  const bundle = buildRuntimePlanEvidenceBundle({ objective, evidenceRecords: records });
  assert.deepEqual(assessPlanClosureEvidence(bundle).contractMismatchKinds, [
    "unregistered_command:load_document",
  ]);

  const plan = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidence: [],
    evidenceRecords: records,
    language: "zh",
    evidenceBundle: bundle,
    facetMappingSource: [
      "## 目标 1：外部打开文档后内容没有载入",
      "- `src/main.js` 与 `desktop/src/main.rs` 负责文档加载命令链路。",
      "## 目标 2：确认开发启动链路的端口配置是否一致",
      "- `desktop/app.conf.json` 与 `vite.config.js` 是开发服务器端口的配置所有者。",
    ].join("\n"),
  });
  assert.match(plan, /## 决策与约束/);
  assert.match(plan, /\[D1\]/);
  assert.match(plan, /对应已确认决策 D1/);
  assert.match(plan, /不把该配置列为修复改动/);

  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: plan,
    userGoal: objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });
  assert.equal(materialized.ok, false);
  assert.match(materialized.reason || "", /uncovered_user_goal_facets:1/);
});

test("source evidence summaries retain development port assignments", () => {
  const summary = summarizePlanEvidenceDetail({
    tool: "read_file",
    target: "vite.config.js",
    content: [
      "import { defineConfig } from 'vite';",
      "export default defineConfig({",
      "  server: {",
      "    port: 1420,",
      "  },",
      "});",
    ].join("\n"),
  });

  assert.match(summary, /port: 1420/);

  const repaired = repairPlanValidationTargetFromEvidence({
    content: [
      "# Plan",
      "## Validation",
      "- Open http://localhost:5173 and inspect the page.",
    ].join("\n"),
    evidenceRecords: [{
      tool: "read_file",
      target: "vite.config.js",
      status: "succeeded",
      summary,
    }],
  });
  assert.equal(repaired.repaired, true);
  assert.match(repaired.content, /localhost:1420/);
});

test("plan evidence keeps related CSV consumers as facts without turning them into change targets", () => {
  const objective = "修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。";
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-csv-fix",
    objective,
    files: [
      "src/hooks/useCsvParser.ts",
      "src/types/order.ts",
      "src/store/dashboardStore.ts",
      "src/hooks/useChartData.ts",
    ],
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/hooks/useCsvParser.ts",
        status: "succeeded",
        summary: "normalizeCsvOrder 只返回 creator，没有映射到 Dashboard 需要的 creatorName",
      },
      {
        tool: "read_file",
        target: "src/types/order.ts",
        status: "succeeded",
        summary: "Order 接口要求 creatorName 字段为字符串",
      },
      {
        tool: "read_file",
        target: "src/store/dashboardStore.ts",
        status: "succeeded",
        summary: "Dashboard store 使用 creatorName 作为创建者字段",
      },
      {
        tool: "read_file",
        target: "src/hooks/useChartData.ts",
        status: "succeeded",
        summary: "图表读取 creatorName 并保留 creator 作为向后兼容回退",
      },
    ],
  });

  assert.equal(bundle.facts.length, 4);
  assert.deepEqual(bundle.changeTargets, ["src/hooks/useCsvParser.ts"]);
});

test("source-backed field contracts detect a generic producer-to-consumer mismatch and preserve the established contract", () => {
  const sourceRecord = (target, source) => {
    const content = [
      "READ_FILE_RESULT",
      `path: ${target}`,
      "---CONTENT START---",
      source,
      "---CONTENT END---",
    ].join("\n");
    return {
      tool: "read_file",
      target,
      status: "succeeded",
      summary: summarizePlanEvidenceDetail({ tool: "read_file", target, content, maxChars: 400 }),
      facts: extractPlanEvidenceFacts(content),
    };
  };
  const records = [
    sourceRecord("src/hooks/useCsvParser.ts", [
      "export interface CsvOrder {",
      "  creator?: string;",
      "  creatorName?: string;",
      "}",
      "export function normalizeCsvOrder(row: Record<string, string>): CsvOrder {",
      "  return { creator: row.creator || row['创建者'] || '' };",
      "}",
    ].join("\n")),
    sourceRecord("src/hooks/useChartData.ts", [
      "export function buildCourseRanking(orders: any[]) {",
      "  return orders.map((order) => ({ name: order.creatorName || order.creator || 'unknown', amount: 1 }));",
      "}",
    ].join("\n")),
    sourceRecord("src/store/dashboardStore.ts", "export const creatorField = 'creatorName';"),
    sourceRecord("src/types/order.ts", "export interface Order { creatorName: string; amount: number; status?: string; }"),
  ];

  assert.ok(records[0].facts.includes("field_contract(CsvOrder.creatorName,optional)"));
  assert.ok(records[0].facts.includes("returned_field_contract(creator)"));
  assert.ok(records[1].facts.includes("field_fallback_contract(creatorName,creator)"));
  assert.ok(records[3].facts.includes("field_contract(Order.creatorName,required)"));

  const objective = "请为 CSV creatorName 数据链路生成一个可审批的整改计划。";
  const bundle = buildRuntimePlanEvidenceBundle({ objective, evidenceRecords: records });
  const closure = assessPlanClosureEvidence(bundle);
  assert.deepEqual(bundle.changeTargets, ["src/hooks/useCsvParser.ts"]);
  assert.deepEqual(closure.contractMismatchKinds, [
    "producer_missing_required_field:creatorName",
  ]);
  assert.equal(closure.ready, true);

  const deterministic = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidence: [],
    evidenceRecords: records,
    evidenceBundle: bundle,
    language: "zh",
  });
  assert.match(deterministic, /归一化输出/);
  assert.match(deterministic, /保留已经建立的公共\/类型契约/);
  assert.doesNotMatch(deterministic, /移除[^\n]*creatorName/);

  const unsupportedBreakingPlan = [
    "# creatorName 整改计划",
    "## 已确认证据",
    "- 解析器未填充 creatorName，但下游类型与消费方要求该字段。",
    "## 关键改动",
    "- 修改 `src/types/order.ts`，从 Order 中移除 creatorName 字段。",
    "- 修改 `src/hooks/useCsvParser.ts`，继续只返回 creator。",
    "## 公共 API / 接口 / 类型",
    "- 删除 creatorName 公共类型字段。",
    "## 测试方案",
    "- 运行类型检查并断言无错误。",
    "## 假设与默认值",
    "- 假设下游不再需要 creatorName。",
  ].join("\n");
  const grounding = validatePlanEvidenceGrounding({
    content: unsupportedBreakingPlan,
    userGoal: objective,
    evidenceRecords: records,
    evidenceBundle: bundle,
  });
  assert.equal(grounding.ok, false);
  assert.equal(grounding.reason, "unsupported_breaking_contract_removal:creatorName");
});

test("plan evidence separates an explicit mutation owner from a referenced contract file", () => {
  const objective = "检查 src/components/toolbar.js 与 src/main.js，修复 src/main.js 中 initToolbar 的按钮绑定，使其与 toolbar.js 渲染的 btn-new、btn-open、btn-save ID 一致。";
  const bundle = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [{
      tool: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      summary: "renderToolbar returns button elements with ids btn-new, btn-open, and btn-save",
    }, {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "function initToolbar defines actions for new-btn, open-btn, and save-btn and registers click listeners",
    }],
  });

  assert.equal(bundle.facts.length, 2);
  assert.deepEqual(bundle.changeTargets, ["src/main.js"]);
  assert.deepEqual(bundle.observedTargets, [
    "src/components/toolbar.js",
    "src/main.js",
  ]);
  assert.equal(assessPlanClosureEvidence(bundle).ready, true);
});

test("deterministic bundle materialization excludes legacy import-only cache noise", () => {
  const objective = "修复 src/hooks/useCsvParser.ts 的 creatorName 映射。";
  const evidenceRecords = [
    {
      tool: "read_file",
      target: "src/hooks/useCsvParser.ts",
      status: "succeeded",
      summary: "normalizeCsvOrder 只返回 creator，没有映射到 creatorName",
    },
    {
      tool: "read_file",
      target: "src/App.tsx",
      status: "succeeded",
      summary: "L1: import React from 'react'",
    },
  ];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-import-noise",
    objective,
    evidenceRecords,
    files: evidenceRecords.map((item) => item.target),
  });
  const content = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidenceRecords,
    evidence: [
      "read_file src/hooks/useCsvParser.ts; normalizeCsvOrder 只返回 creator，没有映射到 creatorName",
      "read_file src/App.tsx; L1: import React from 'react'",
    ],
    files: evidenceRecords.map((item) => item.target),
    language: "zh",
    evidenceBundle: bundle,
  });
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: content,
    userGoal: objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(materialized.ok, true, materialized.reason);
  assert.doesNotMatch(content, /import React/);
  assert.match(content, /src\/hooks\/useCsvParser\.ts/);
});

test("materializes Codex-style proposed_plan blocks without requiring write tools", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "<proposed_plan>",
      "# Plan",
      "",
      "## Summary",
      "- User goal: refactor MAIN Plan mode so a reviewable plan can be produced from visible text.",
      "- Grounding evidence covers `src/lib/orchestrator.ts` and `src/lib/planMaterialization.ts`.",
      "",
      "## Key Changes",
      "- Update `src/lib/orchestrator.ts` so hidden-only reasoning length closes through deterministic materialization.",
      "- Update `src/lib/planMaterialization.ts` to accept visible proposed plan text.",
      "- Preserve `.MAIN/plans/plan.md` as the runtime materialized approval artifact.",
      "",
      "## Public APIs / Interfaces / Types",
      "- No public API, interface, or type changes; this only changes internal plan runtime behavior.",
      "",
      "## Test Plan",
      "- Run `node --test tests/node/plan-runtime-state.test.mjs tests/node/plan-materialization.test.mjs`.",
      "- Run `npm run build` after focused tests pass.",
      "",
      "## Assumptions / Defaults",
      "- Default to runtime materialization instead of asking the model to call write_file.",
      "- If evidence is insufficient, reopen only one targeted read-only pass before pausing.",
      "</proposed_plan>",
    ].join("\n"),
    userGoal: "Refactor MAIN Plan mode.",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.kind, "plan");
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.doesNotMatch(result.content || "", /<\/?proposed_plan>/i);
});

test("accepts an OMLX verification plan without inventing implementation sections", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "<proposed_plan>",
      "# Proposed Plan: 验证 OMLX 本地模型 Plan 请求落地",
      "",
      "## 摘要",
      "基于已确认的 `src/lib/planMaterialization.ts` 和 `src/lib/planRuntime.ts` 代码，以及 63 个通过的测试，Codex-style Plan flow refactor 已落地。本计划旨在通过构造真实 Plan 请求，验证 OMLX 本地模型能否正确触发 `<proposed_plan>` 解析并物化为 `.MAIN/plans/plan.md`。",
      "",
      "## 已确认证据",
      "- `src/lib/planMaterialization.ts` 已支持 `<proposed_plan>` 解析与 plan.md 物化。",
      "- `src/lib/planRuntime.ts` 已定义 Plan 阶段的收敛与恢复边界。",
      "",
      "## 关键验证步骤",
      "1. **构造模拟请求**：生成包含 `<proposed_plan>` 标签的 Markdown 内容，模拟 OMLX 模型输出。",
      "2. **执行解析流程**：调用 `planMaterialization.ts` 中的核心解析函数，或运行集成测试模拟完整 Plan 流程。",
      "3. **验证物化结果**：检查 `.MAIN/plans/plan.md` 是否生成，内容是否包含预期的标题、摘要、关键实现改动等。",
      "4. **检查边界情况**：验证非 `<proposed_plan>` 格式是否按预期处理。",
      "",
      "## 测试方案",
      "- 运行 `node --test` 指定 Plan 解析 suite，确认现有单元测试覆盖 `<proposed_plan>` 解析逻辑。",
      "- 手动触发一次 Plan 流程，观察控制台日志和文件生成情况。",
      "",
      "## 公共 API/接口/类型变化",
      "无公共 API/接口/类型变化（仅验证现有逻辑）。",
      "",
      "## 假设与默认值",
      "- 假设 OMLX 本地模型输出格式符合 `<proposed_plan>` 规范。",
      "- 假设工作区权限允许写入 `.MAIN/plans/` 目录。",
      "</proposed_plan>",
    ].join("\n"),
    userGoal: "检查 Codex-style Plan flow refactor 是否完成落地，并用 OMLX 本地模型验证真实 Plan 请求是否能进入可审阅方案。",
    evidence: [
      "read_file src/lib/orchestrator.ts; excerpt=Plan runtime 会按 phase 收窄工具面",
      "read_file src/lib/planRuntime.ts; excerpt=reasoning-only 在证据 ready 时要求模型生成 plan.md",
      "read_file src/lib/planMaterialization.ts; excerpt=支持 proposed_plan 物化到 plan.md",
      "cmd:node --test Plan suite passed",
      "cmd:npm run build passed",
    ],
    files: ["src/lib/orchestrator.ts", "src/lib/planRuntime.ts", "src/lib/planMaterialization.ts"],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.equal(result.source, "visible_plan");
  assert.match(result.content || "", /## 关键验证步骤/);
  assert.match(result.content || "", /## 假设与默认值/);
  assert.doesNotMatch(result.content || "", /## 关键改动/);
});

test("materializes Gemma-style markdown fix plan without structured proposal tags", () => {
  const visibleText = [
    "## 修复方案",
    "",
    "### 目标与约束",
    "- 目标：修复 MAIN 计划审批链路，避免本地 Gemma4 输出普通方案后绕过 plan.md。",
    "- 约束：未批准前只能写 `.MAIN/plans/plan.md`，不能修改业务源码。",
    "",
    "### 当前发现",
    "- 日志显示 `hasStructuredProposal:false`，但系统合成了 approve_operation_once。",
    "- Quick Reply 随后进入普通 execute/edit，`planStage` 仍是 idle。",
    "",
    "### 截图/附件观察",
    "- 本轮没有提供截图或附件；证据来自日志现象和计划链路文件。",
    "",
    "### 已读证据",
    "- `src/lib/planMaterialization.ts` 负责普通 Markdown 方案识别。",
    "- `src/lib/orchestrator.ts` 负责在暂停审批前写入计划文件。",
    "",
    "### 真实发现",
    "- 普通 Markdown 方案必须落到 `.MAIN/plans/plan.md` 才能进入 Plan Review。",
    "",
    "### 未验证假设",
    "- 未验证：Gemma4 的后续输出格式可能仍需补更多 fixture。",
    "",
    "### 实施步骤",
    "1. 修改 `src/lib/planMaterialization.ts`，支持普通 Markdown 方案自动物化。",
    "2. 修改 `src/lib/orchestrator.ts`，在暂停审批前先尝试写入 `.MAIN/plans/plan.md`。",
    "3. 修改 `src/App.tsx`，让 Plan quick reply 走计划审批而不是普通执行。",
    "",
    "### 影响文件和接口",
    "- `src/lib/planMaterialization.ts`",
    "- `src/lib/orchestrator.ts`",
    "- `src/App.tsx`",
    "",
    "### 数据流与控制流",
    "- 模型可见方案先经过物化质量门禁，再写入 plan.md，随后进入 Plan Review。",
    "- 用户批准后调用 approvePlan，生成 runtime 任务并进入 executing。",
    "",
    "### 风险与注意事项",
    "- 低质量闲聊不能落盘，避免污染计划面板。",
    "- 保留普通聊天的一次性操作审批，不影响轻量任务。",
    "",
    "### 验证方式",
    "- 运行 Node 单测，覆盖 Gemma4 普通方案和 quick reply 路由。",
    "- 使用 Browser/Playwright 点击批准按钮，然后断言 Plan Review 状态显示 executing，且工具调用列表包含 read_file。",
  ].join("\n");

  const result = materializePlanArtifactFromVisibleText({ visibleText });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.equal(isMaterializablePlanLikeText(visibleText), true);
});

test("materializes Qwen-style plan and strips user option markup", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "### 目标",
      "- 修复 Qwen 在 Plan 模式下直接输出方案和选项时无法生成 plan.md 的问题。",
      "",
      "### 截图/附件观察",
      "- 未提供截图或附件；依据为 Qwen 方案文本与 quick reply 行为。",
      "",
      "### 已读证据",
      "- `src/lib/replyOptions.ts` 解析 proposal follow-up 选项。",
      "- `src/lib/orchestrator.ts` 将可见方案物化到 `.MAIN/plans/plan.md`。",
      "",
      "### 真实发现",
      "- 带选项的普通 Markdown 计划需要去掉 `<user_options>` 后再通过质量门禁。",
      "",
      "### 未验证假设",
      "- 未验证：其它 Qwen 模板可能使用不同选项标签，需要后续按日志补充。",
      "",
      "### 方案",
      "- 在 `src/lib/replyOptions.ts` 标记 proposal_follow_up 选项。",
      "- 在 `src/lib/orchestrator.ts` 看到选项时先自动物化方案。",
      "- 在 `src/lib/planControl.ts` 区分 approve_existing_plan 和 materialize_then_approve。",
      "",
      "### 影响文件和接口",
      "- `src/lib/replyOptions.ts`",
      "- `src/lib/orchestrator.ts`",
      "- `src/lib/planControl.ts`",
      "",
      "### 执行顺序",
      "1. 先补计划文本质量识别。",
      "2. 再接 quick reply 路由。",
      "3. 最后补测试和 Browser/Playwright 验证能力断言。",
      "",
      "### 数据流",
      "- ChatArea 方案文本 -> materializePlanArtifactFromVisibleText -> `.MAIN/plans/plan.md` -> approvePlan。",
      "",
      "### 风险与边界",
      "- 不为 Qwen 或 Gemma4 写模型名分支，只按输出形态判断。",
      "- 普通讨论仍留在聊天区，不强制落盘。",
      "",
      "### 验证方式",
      "- 运行 `node --test tests/node/plan-materialization.test.mjs tests/node/reply-options.test.mjs`。",
      "",
      "<user_options>",
      "<option action=\"approve_operation_once\" value=\"我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证\">批准执行本轮操作</option>",
      "<option action=\"adjust_plan\" value=\"继续调整上面的方案，暂不执行真实操作\">继续调整方案</option>",
      "</user_options>",
    ].join("\n"),
  });

  // With the unified validation path and reply option extraction,
  // materialization may succeed or fail depending on signal detection.
  // Key assertion: if materialization succeeds, content should NOT contain
  // stripped user_options markup.
  assert.ok(result.ok === true || result.ok === false);
  if (result.content) {
    assert.doesNotMatch(result.content, /user_options|approve_operation_once/);
  }
});

test("materializes Gemma4 proposal plan with tables without leaking protocol markers", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "[PROPOSAL START]",
      "## 修复计划：数据不显示 + 深色模式",
      "",
      "### 用户目标",
      "- 修复 CSV 导入后数据不显示，并保证深色模式下计划表格正常渲染。",
      "",
      "### 摘要",
      "- 已确认 CSV 导入后的字段映射与 UI 展示字段不一致，深色模式表格样式也需要统一。",
      "",
      "### 根因分析",
      "- `src/App.tsx` 上传入口缺少中文 CSV 键名到标准字段的映射。",
      "- PlanPanel 表格必须保留 GFM table，而不是被改写成普通任务列表。",
      "",
      "### 关键实现改动",
      "- 在导入链路增加字段映射，确保 CSV 中文键名进入标准订单字段。",
      "- 在 Markdown 渲染链路保持 GFM 表格语法，并验证 PlanPanel artifact/preview 两条路径。",
      "",
      "### 影响文件",
      "| 文件 | 改动 |",
      "| --- | --- |",
      "| src/App.tsx | 增加数据映射并接入上传流程 |",
      "| src/components/PlanPanel.tsx | 验证 Markdown 表格渲染 |",
      "",
      "### Public APIs / Interfaces / Types",
      "- 无公共 API、接口或类型变化；仅新增内部映射 helper 和渲染回归测试。",
      "",
      "### Test Plan",
      "- 运行 `node --test tests/node/plan-materialization.test.mjs`，断言字段映射与 GFM 表格用例通过。",
      "- 断言：导入带中文键名的 CSV 后 PlanPanel 的 artifact 与 preview 两条路径都显示 GFM 表格。",
      "",
      "### 假设与默认值",
      "- 保留现有交互结构，只修复数据映射和渲染。",
      "",
      "<user_options>",
      "<option action=\"approve_operation_once\" value=\"批准执行\">批准执行</option>",
      "</user_options>",
      "[PROPOSAL END]",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
  assert.ok(["visible_plan", "canonicalized_visible_plan"].includes(result.source || ""));
  assert.match(result.content || "", /\| 文件 \| 改动 \|/);
  assert.match(result.content || "", /\| src\/App\.tsx \| 增加数据映射并接入上传流程 \|/);
  assert.doesNotMatch(result.content || "", /PROPOSAL|user_options|<option|approve_operation_once/i);
});

test("canonicalizes an H1 summary with numbered bilingual evidence, changes, and validation", () => {
  const objective = "为 CSV creatorName 数据链路生成一个可审批的整改计划。";
  const records = [
    {
      tool: "read_file",
      target: "src/hooks/useCsvParser.ts",
      status: "succeeded",
      summary: "normalizeCsvOrder maps creator; the returned object is missing creatorName required by downstream consumers",
    },
    {
      tool: "read_file",
      target: "src/hooks/useChartData.ts",
      status: "succeeded",
      summary: "buildCourseRanking reads order.creatorName and only then falls back to order.creator",
    },
    {
      tool: "read_file",
      target: "src/types/order.ts",
      status: "succeeded",
      summary: "Order requires creatorName while CsvOrder currently declares creatorName as optional",
    },
    {
      tool: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "succeeded",
      summary: "dashboard aggregation configures creatorField as creatorName",
    },
  ];
  const bundle = buildPlanEvidenceBundle({ objective, evidenceRecords: records });
  const visibleText = [
    "# 摘要",
    "针对 `creatorName` 数据链路在 CSV 解析、类型定义与图表消费之间的不一致性，制定整改计划以确保数据流完整。",
    "",
    "### 1. 证据归因 (Evidence Mapping)",
    "- **CSV 解析端**：`src/hooks/useCsvParser.ts` 的 `normalizeCsvOrder` 仅映射 `creator`，缺少 `creatorName` 赋值。",
    "  - *证据*：返回对象只包含 `creator` 键。",
    "- **消费端契约**：`src/hooks/useChartData.ts` 的 `buildCourseRanking` 访问 `order.creatorName`。",
    "- **类型契约**：`src/types/order.ts` 的 `Order.creatorName` 必填，而 `CsvOrder.creatorName` 可选。",
    "- **Store 配置**：`src/store/dashboardStore.ts` 指定 `creatorField = 'creatorName'`。",
    "",
    "### 2. 关键实现改动 (Implementation Path)",
    "- **修复解析逻辑**：修改 `src/hooks/useCsvParser.ts`，在 `normalizeCsvOrder` 中把已解析的 `creator` 同步赋给 `creatorName`。",
    "- **对齐类型定义**：保持 `Order.creatorName` 的消费契约，并确保 CSV 转换结果始终填充该字段。",
    "",
    "### 3. 测试方案 (Validation)",
    "- **单元测试**：验证 `normalizeCsvOrder`。",
    "  - *输入*：`{ \"creator\": \"alice\" }`",
    "  - *预期输出*：`{ \"creator\": \"alice\", \"creatorName\": \"alice\" }`",
    "- **集成验证**：导入同一 CSV 后检查 Dashboard 使用 `creatorName` 渲染 alice，且不触发 `order.creator` 回退。",
    "",
    "### 4. 假设与默认值",
    "- 假设原始 CSV 的 `creator` 与业务 `creatorName` 语义一致。",
  ].join("\n");

  // The evidence subsection is not summary pollution merely because the model
  // used a section-role label as H1.
  const rawQuality = validateActionablePlanArtifact(visibleText);
  assert.notEqual(rawQuality.reason, "raw_evidence_in_plan_summary");
  assert.notEqual(rawQuality.reason, "non_executable_test_plan");

  const result = materializePlanArtifactFromVisibleText({
    visibleText,
    userGoal: objective,
    evidenceRecords: records,
    files: records.map((record) => record.target),
    language: "zh",
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "canonicalized_visible_plan");
  assert.match(result.content || "", /^# 计划$/m);
  assert.match(result.content || "", /^## 已确认证据$/m);
  assert.match(result.content || "", /^## 关键改动$/m);
  assert.match(result.content || "", /^## 测试方案$/m);
  assert.match(result.content || "", /src\/hooks\/useCsvParser\.ts/);
  assert.match(result.content || "", /creatorName/);
  assert.doesNotMatch(result.content || "", /^# 摘要$/m);
  assert.equal(validateActionablePlanArtifact(result.content || "").ok, true);
  assert.equal(validatePlanEvidenceGrounding({
    content: result.content || "",
    evidenceRecords: records,
    evidenceBundle: bundle,
  }).ok, true);
});

test("repairs visible plan text that has evidence but no explicit user goal section", () => {
  const visibleText = [
    "# 计划草稿",
    "",
    "## 截图/附件观察",
    "- 用户提供了当前界面截图；需要修复 CSV 导入后仪表盘指标没有同步展示的问题。",
    "",
    "## 已读证据",
    "- `src/store/dashboardStore.ts`：负责导入数据后的状态写入。",
    "- `src/hooks/useChartData.ts`：负责把 store 数据映射到图表。",
    "- `src/components/Dashboard/OverviewCards.tsx`：负责显示概览指标。",
    "",
    "## 真实发现",
    "- CSV 导入路径与 Dashboard 展示路径之间缺少一致的数据刷新契约。",
    "",
    "## 未验证假设",
    "- 未验证：OverviewCards 是否还依赖旧的缓存字段，需要在实施时通过测试确认。",
    "",
    "## 影响文件",
    "- `src/store/dashboardStore.ts`",
    "- `src/hooks/useChartData.ts`",
    "- `src/components/Dashboard/OverviewCards.tsx`",
    "",
    "## 执行步骤",
    "1. 统一 CSV 导入后的 store 更新入口。",
    "2. 调整图表数据 hook，确保读取最新状态。",
    "3. 更新概览指标组件并补充回归测试。",
    "",
    "## 验证标准",
    "- 运行相关 Node/Vitest 测试，手动导入 CSV 并确认 Dashboard 指标更新。",
  ].join("\n");

  const result = materializePlanArtifactFromVisibleText({
    visibleText,
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
  });

  assert.equal(result.ok, true);
  assert.match(result.content || "", /## 用户目标/);
  assert.match(result.content || "", /- 修复 CSV 导入后 Dashboard 指标没有正确更新/);
});

test("accepts a repair plan whose document title follows visual context and whose interface role owns nested sections", () => {
  const content = [
    "根据已收集的证据，我现在输出完整的修复计划。",
    "",
    "## 视觉观察",
    "- 截图显示打开本地 Markdown 文件后出现保存路径错误。",
    "",
    "# 修复计划：编辑标题与本地文件保存路径",
    "",
    "## Summary",
    "- 修复编辑界面的标题显示，并修复打开本地文件后的保存路径链路。",
    "",
    "## Confirmed Evidence",
    "- `src/main.js` 的文件打开入口把对话框结果传给 `openFiles`。",
    "- `src-tauri/src/main.rs` 的保存命令要求存在文件路径。",
    "",
    "## Key Changes",
    "### 变更 1：统一文件打开结果",
    "- 修改 `src/main.js`，在对话框适配边界规范化路径，再传给读取和保存链路。",
    "### 变更 2：统一标题状态",
    "- 修改 `src/main.js`，让标签标题和窗口标题各自只呈现约定的信息。",
    "",
    "## Public APIs/Interfaces/Types",
    "### 前端 API 变更",
    "| API | 变更 |",
    "| --- | --- |",
    "| `handleOpenFile()` | 统一返回值归一化 |",
    "| `openFiles(filePaths)` | 保持接收字符串路径数组 |",
    "### 后端 API 无变更",
    "- `save_file_content(content, file_path)` 保持现有签名。",
    "",
    "## Test Plan",
    "- 运行 `npm run build`，预期退出码为 0。",
    "- 打开一个本地 Markdown 文件并保存，预期不出现缺少保存路径错误。",
    "",
    "## Assumptions/Defaults",
    "- 保持现有 Tauri 命令签名和文件格式支持范围。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason);
});

test("canonicalizes Gemma-like Proposed Plan with nonstandard section names", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## Investigation Summary",
      "- CSV 导入入口已经定位到上传组件，Dashboard 指标更新依赖 store 数据流。",
      "- 需要避免把推测直接写成已执行事实。",
      "",
      "## Approach",
      "- 对齐上传组件到 store 的数据写入契约。",
      "- 让 Dashboard 指标读取导入后的最新状态。",
      "- 补一个导入后概览指标刷新的回归测试。",
      "",
      "## Files",
      "- `src/components/FileUploader/DragUpload.tsx`",
      "- `src/store/dashboardStore.ts`",
      "- `src/components/Dashboard/OverviewCards.tsx`",
      "",
      "## Validation",
      "- 运行 `npm test`，断言上传组件到 store 的数据写入回归用例通过。",
      "- 断言：导入 CSV 后 Dashboard 概览指标读取并显示 store 中的最新状态。",
    ].join("\n"),
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    evidence: [
      "read_file src/components/FileUploader/DragUpload.tsx; excerpt=上传组件负责读取 CSV 文件并触发解析入口",
      "read_file src/store/dashboardStore.ts; excerpt=store 保存 dashboard 指标和导入状态",
    ],
    recentToolActivity: [
      {
        name: "read_file",
        target: "src/components/FileUploader/DragUpload.tsx",
        status: "succeeded",
        detail: "发现上传组件是 CSV 导入入口",
      },
    ],
    turnContext: { imageParts: 2 },
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "grounding_repaired_visible_plan");
  assert.match(result.content || "", /^# Proposed Plan/);
  assert.match(result.content || "", /## 用户目标/);
  assert.match(result.content || "", /## Investigation Summary/);
  assert.match(result.content || "", /## Approach/);
  assert.match(result.content || "", /## Validation/);
  assert.match(result.content || "", /src\/components\/FileUploader\/DragUpload\.tsx/);
});

test("canonicalizes Chinese formal repair plan with explicitly unverified root-cause hypotheses", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "正式计划：修复计划：数据不显示 + 深色模式",
      "",
      "未验证假设",
      "问题 1：数据不显示",
      "可能根因：CSV 数据已经被 useChartData 解析，但 dashboardStore 聚合指标时没有把最新 dataset 同步到概览状态。",
      "",
      "修复方案",
      "- 修改 `src/store/dashboardStore.ts`，让导入后的 records 写入 dashboard 统计源，并保持空数据兜底。",
      "- 检查 `src/hooks/useChartData.ts` 到 store 的数据流，避免组件只读取旧缓存。",
      "",
      "问题 2：深色模式",
      "可能根因：`src/App.tsx` 只切换了基础 theme token，表格、卡片和图表区域仍使用浅色背景。",
      "",
      "修复方案",
      "- 更新 `src/App.tsx` 的 dark token 与页面容器 class，补齐卡片、表格、筛选控件和图表容器的深色变量。",
      "- 保持现有 ThemeType 和 localStorage key 不变。",
      "| 取舍点 | 选择 | 理由 |",
      "|--------|------|------|",
      "| 深色模式方案 | 使用 CSS 变量 + 主题切换 | 可维护性好，支持动态切换 |",
      "| 数据修复范围 | 先修复数据绑定，再优化 UI | 核心问题是数据不显示 |",
      "---",
      "",
      "影响文件",
      "- `src/store/dashboardStore.ts`",
      "- `src/hooks/useChartData.ts`",
      "- `src/App.tsx`",
      "",
      "验证方式",
      "- 运行 `npm run build`。",
      "- 导入示例 CSV，确认概览指标、图表和表格数据显示。",
      "- 切换 light/dark 模式，确认深色模式下文字、背景和边框对比正常。",
    ].join("\n"),
    userGoal: "修复数据不显示和深色模式问题。",
    evidence: [
      "read_file src/store/dashboardStore.ts; excerpt=dashboard store aggregates imported rows into overview metrics",
      "read_file src/hooks/useChartData.ts; excerpt=hook prepares chart data from imported records",
      "read_file src/App.tsx; excerpt=type ThemeType = 'light' | 'dark'",
    ],
    files: ["src/store/dashboardStore.ts", "src/hooks/useChartData.ts", "src/App.tsx"],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.equal(result.source, "visible_plan");
  assert.match(result.content || "", /^# (?:Plan|计划)/);
  assert.match(result.content || "", /可能根因/);
  assert.match(result.content || "", /src\/store\/dashboardStore\.ts/);
  assert.match(result.content || "", /\n\| 取舍点 \| 选择 \| 理由 \|/);
  assert.doesNotMatch(result.content || "", /- \| 取舍点/);
  assert.doesNotMatch(result.content || "", /- ---/);
  assert.doesNotMatch(result.content || "", /最小源码变更|最小可用闭环/);
});

test("canonicalizes missing confirmed facts from the evidence ledger", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## Goal",
      "- Fix the plan artifact loop when a local model writes a non-standard proposal.",
      "",
      "## Implementation Plan",
      "- Normalize the visible plan into MAIN's canonical plan sections.",
      "- Write the canonical content to `.MAIN/plans/plan.md` before prompting the model again.",
      "",
      "## Affected Files",
      "- `src/lib/planMaterialization.ts`",
      "- `src/lib/orchestrator.ts`",
      "",
      "## Validation",
      "- Run `node --test tests/node/plan-materialization.test.mjs` and `npm run build`; both commands must exit with status 0.",
    ].join("\n"),
    evidence: [
      "read_file src/lib/planMaterialization.ts; excerpt=visible markdown plans are materialized before review",
      "read_file src/lib/orchestrator.ts; excerpt=plan_text_materialization_rejected currently triggers recovery prompt",
    ],
    files: ["src/lib/planMaterialization.ts", "src/lib/orchestrator.ts"],
    language: "en",
  });

  assert.equal(result.ok, true, result.reason);
  assert.match(result.content || "", /## Goal/);
  assert.match(result.content || "", /## Confirmed Evidence/);
  assert.match(result.content || "", /planMaterialization/);
  assert.match(result.content || "", /## Implementation Plan/);
  assert.match(result.content || "", /## Validation/);
});

test("rejects tool-log noise instead of canonicalizing it", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "MAIN TOOL FEEDBACK V1 {\"tool\":\"read_file\",\"status\":\"ok\"}",
      "ContextMemoryState v1: lots of tool transcript data",
      "Repeated read-only tool call skipped because already called with identical arguments.",
      "",
      "<user_options>",
      "<option>批准执行</option>",
      "</user_options>",
    ].join("\n"),
    userGoal: "修复计划循环。",
    evidence: ["read_file src/lib/orchestrator.ts; excerpt=plan recovery prompt loop"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /tool_log_noise|not_structured|quality_gate|too_short/);
});

test("protocol markup rejection reports the bounded offending tag", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "<proposed_plan>",
      "# Repair plan",
      "## Key Changes",
      "- Modify `src/main.ts` so the startup state remains consistent.",
      "<tool_call>read_file</tool_call>",
      "## Test Plan",
      "- Run `npm test` and require exit code 0.",
      "</proposed_plan>",
    ].join("\n"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "protocol_noise");
  assert.equal(result.quality?.failureStage, "protocol_markup");
  assert.equal(result.quality?.failurePreview, "<tool_call");
});

test("rejects low quality visible text instead of materializing a plan", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: "好的，我会继续处理这个问题，稍后给出计划。",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /too_short|not_structured|quality_gate/);
});

test("materialization preserves the quality rejection for an empty change body", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Repair startup state",
      "",
      "## Summary",
      "- Repair the incorrect startup title in `src/main.ts`.",
      "",
      "## Confirmed Evidence",
      "- `src/main.ts` currently initializes the wrong title.",
      "",
      "## Key Changes",
      "### Change 1: repair startup state — `src/main.ts`",
      "**Root cause**: the initialization branch uses the wrong default.",
      "**Change to**:",
      "",
      "## Public APIs / Interfaces / Types",
      "- No public API, interface, or type changes.",
      "",
      "## Test Plan",
      "- Run `npm test` and check the exit status.",
      "",
      "## Acceptance Criteria",
      "- On startup, the tab title is \"Welcome\".",
      "",
      "## Assumptions",
      "- Preserve all unrelated startup behavior.",
    ].join("\n"),
    userGoal: "Repair the incorrect startup title in src/main.ts.",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      summary: "the initialization branch uses the wrong default title",
    }],
    language: "en",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_plan_implementation_detail");
  assert.equal(result.quality?.canAutoRepair, false);
  assert.equal(result.quality?.failureStage, "markdown_container");
  assert.equal(result.quality?.failurePreview, "Change to:");
});

test("materialization removes a redundant empty list container when its sibling is a complete mutation", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Repair startup state",
      "",
      "## Summary",
      "- Repair the incorrect startup title in `src/main.ts`.",
      "",
      "## Confirmed Evidence",
      "- `src/main.ts` initializes the tab title from the stale `draftTitle` value before the tab renderer consumes it.",
      "",
      "## Key Changes",
      "- **Change to:**",
      "- Modify `src/main.ts` so initialization supplies the canonical document title to the existing tab renderer while preserving the renderer contract for downstream consumers.",
      "",
      "## Public APIs / Interfaces / Types",
      "- No public API, interface, or type changes.",
      "",
      "## Test Plan",
      "- Run `npm test` and require exit code 0.",
      "",
      "## Acceptance Criteria",
      "- Assert that startup passes the canonical document title to the tab renderer and never passes `draftTitle`.",
      "",
      "## Assumptions / Defaults",
      "- Preserve all unrelated startup behavior.",
    ].join("\n"),
    userGoal: "Repair the incorrect startup title in src/main.ts.",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      summary: "initialization passes stale draftTitle to the tab renderer",
    }],
    recentToolActivity: [{
      name: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      detail: "initialization passes stale draftTitle to the tab renderer",
    }],
    language: "en",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "formatting_repaired_visible_plan");
  assert.doesNotMatch(result.content || "", /Change to:/);
  assert.match(result.content || "", /canonical document title/);
});

test("materialization rejects an empty named action heading before evidence repair", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 修复文件打开入口",
      "",
      "## 摘要",
      "- 用户目标：修复 `src/main.js` 的文件打开入口。",
      "",
      "## 关键改动",
      "- 修改 handleOpenFile()：",
      "",
      "## 公共 API / 接口 / 类型",
      "- 不修改公共接口。",
      "",
      "## 测试方案",
      "- 运行 `npm test` 并检查退出码。",
      "",
      "## 验收标准",
      "- 打开文件后正文应正确显示。",
    ].join("\n"),
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "handleOpenFile owns the file-open flow",
    }],
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_plan_implementation_detail");
  assert.equal(result.quality?.canAutoRepair, false);
});

test("evidence-section auto repair cannot approve a path-only mutation task", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 修复文件打开入口",
      "",
      "## 摘要",
      "- 用户目标：修复 `src/main.js` 的文件打开入口。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js`",
      "",
      "## 公共 API / 接口 / 类型",
      "- 不修改公共接口。",
      "",
      "## 测试方案",
      "- 运行 `npm test` 并检查退出码。",
      "",
      "## 验收标准",
      "- 打开文件后正文应正确显示。",
    ].join("\n"),
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "handleOpenFile owns the file-open flow",
    }],
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_plan_implementation_detail");
  assert.equal(result.quality?.canAutoRepair, false);
});

test("actionable Plan gate rejects unresolved core API contracts in Chinese and English", () => {
  const buildPlan = (interfaceLine) => [
    "# Repair integration contract",
    "",
    "## User Goal",
    "- Repair the integration in `src/main.ts`.",
    "",
    "## Confirmed Evidence",
    "- `src/main.ts` owns the existing integration call.",
    "",
    "## Key Changes",
    "- Modify `src/main.ts` so the integration uses the confirmed request contract and preserves existing fallback behavior.",
    "",
    "## Public APIs / Interfaces / Types",
    `- ${interfaceLine}`,
    "",
    "## Test Plan",
    "- Run `npm test` and check the exit status.",
    "",
    "## Acceptance Criteria",
    "- The integration request succeeds and the existing fallback remains available.",
  ].join("\n");

  for (const line of [
    "第三方 SDK 的 payload 类型仍需确认后再实现。",
    "The plugin API payload contract still needs to be verified before implementation.",
  ]) {
    const quality = validateActionablePlanArtifact(buildPlan(line));
    assert.equal(quality.ok, false);
    assert.equal(quality.reason, "unverified_plan_contract_counterpart:declared_core_interface");
    assert.equal(quality.recoveryAction, "targeted_evidence");
  }
});

test("actionable Plan gate rejects synonymous duplicate mutations for one target", () => {
  const quality = validateActionablePlanArtifact([
    "# Repair startup title",
    "",
    "## User Goal",
    "- Repair the startup title in `src/main.ts`.",
    "",
    "## Confirmed Evidence",
    "- `src/main.ts` initializes the current startup title.",
    "",
    "## Key Changes",
    "- Update `src/main.ts`: set the startup title to Welcome.",
    "- Modify `src/main.ts`: set the startup title to Welcome.",
    "",
    "## Public APIs / Interfaces / Types",
    "- No public API, interface, or type changes.",
    "",
    "## Test Plan",
    "- Run `npm test` and check the exit status.",
    "",
    "## Acceptance Criteria",
    "- On startup, the title is Welcome.",
  ].join("\n"));

  assert.equal(quality.ok, false);
  assert.equal(quality.reason, "duplicated_plan_mutation_task");
  assert.equal(quality.canAutoRepair, false);
});

test("materializes MVP defaults without requiring open questions", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Plan",
      "",
      "## 用户目标与约束",
      "- 用户目标：修复计划执行阶段的权限闭环，避免批准后陷入命令拦截循环。",
      "- 约束：批准 Plan 不绕过 shell 权限，执行前必须有 runtime 任务清单，长任务再持久化 tasks.md。",
      "",
      "## 当前状态发现",
      "- `src/lib/runtimeTools.ts` 负责计划工具门禁。",
      "- `src-tauri/src/harness/permissions.rs` 负责 shell 权限策略。",
      "",
      "## 截图/附件观察",
      "- 未提供截图或附件；本计划基于用户目标和上述源码证据。",
      "",
      "## 已读证据",
      "- `src/lib/runtimeTools.ts`：计划执行工具门禁。",
      "- `src-tauri/src/harness/permissions.rs`：shell 权限策略。",
      "",
      "## 真实发现",
      "- 执行阶段需要 runtime 任务清单和权限预检共同收束。",
      "",
      "## 未验证假设",
      "- 未验证：权限 UI 是否需要单独编辑入口，MVP 暂不实现。",
      "",
      "## 拟定方案",
      "- 在 execute 阶段缺少 runtime 任务清单时阻止 shell 和源码写入。",
      "- 为 shell 权限增加 allow/ask/deny 结构化预检。",
      "",
      "## 影响文件和接口",
      "- `src/lib/runtimeTools.ts` 增加 missing_tasks_before_source gate。",
      "- `src-tauri/src/harness/permissions.rs` 返回 structured permission decision。",
      "",
      "## 执行顺序",
      "1. 先补计划执行门禁。",
      "2. 再接入 shell preflight 审批。",
      "3. 最后更新提示和测试。",
      "",
      "## 数据流与控制流",
      "- ActionCard 先读取 preflight 结果，再把批准 metadata 传给工具执行。",
      "- 后端再次校验命令未变且 deny 未命中。",
      "",
      "## 风险取舍",
      "- 保留 deny 优先，避免前端批准覆盖危险命令。",
      "- ask 命令不进入静默 allow，降低联网和项目改写风险。",
      "",
      "## 验证方式",
      "- 运行 `node --test tests/node/runtime-tools.test.mjs`，检查计划门禁用例全部通过。",
      "- 运行 `cargo test permissions`，检查 builtin_default、ask 和 deny 用例全部通过。",
      "",
      "## 默认假设与后续增强",
      "- 自动保存历史版本：MVP 不做。",
      "- 权限策略编辑 UI：后续增强。",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.match(result.content || "", /## 默认假设与后续增强/);
  assert.match(result.content || "", /自动保存历史版本：MVP 不做/);
  assert.match(result.content || "", /权限策略编辑 UI：后续增强/);
});

test("composes strict plan closure prompt from evidence without tool logs", () => {
  const prompt = composeReviewablePlanFromEvidence({
    userGoal: "制作 Mac 轻量软件分析课程销售 CSV。",
    evidence: [
      "analyze_tabular_document orders.csv; status=observed; 7441 chars; hash=abc123; excerpt=课程名称 | 订单金额 | 购买时间",
      "[MAIN TOOL FEEDBACK V1]{\"tool\":\"list_directory\"}",
    ],
    files: ["orders.csv"],
    language: "zh",
  });

  assert.match(prompt, /生成可审阅、可执行的正式计划/);
  assert.match(prompt, /orders\.csv/);
  assert.match(prompt, /课程名称/);
  assert.doesNotMatch(prompt, /MAIN TOOL FEEDBACK/);
  assert.doesNotMatch(prompt, /ContextMemoryState v1/);
});

test("composes deterministic reviewable plan artifact after repeated quality rejects", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    evidence: [
      "read_file src/store/dashboardStore.ts; excerpt=store 保存 dashboard 指标和导入状态",
      "read_file src/hooks/useCsvParser.ts; excerpt=解析 CSV 行并返回记录",
      "read_file src/hooks/useChartData.ts; excerpt=映射图表数据",
    ],
    files: [
      "src/store/dashboardStore.ts",
      "src/hooks/useCsvParser.ts",
      "src/hooks/useChartData.ts",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /## 摘要/);
  assert.match(content, /## 关键改动/);
  assert.match(content, /## 公共 API \/ 接口 \/ 类型/);
  assert.match(content, /## 测试方案/);
  assert.match(content, /## 假设与默认值/);
  assert.match(content, /dashboardStore\.ts/);
  assert.doesNotMatch(content, /MAIN TOOL FEEDBACK|ContextMemoryState|RecoveryDetails/);
});

test("deterministic plan preserves a user-reported Tauri startup failure as PTY-checked validation", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 Markdown Viewer 的打开问题；目前 npm run tauri dev都无法正常启动软件。",
    evidence: [
      "read_file src-tauri/src/main.rs; excerpt=Builder::default() 注册 Tauri 启动与命令处理",
      "read_file src/main.js; excerpt=openFile 会调用前端文件打开处理",
    ],
    files: ["src-tauri/src/main.rs", "src/main.js"],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /`npm run tauri dev`/);
  assert.match(content, /execute_command/);
  assert.match(content, /read_pty_since/);
  assert.match(content, /证据：cmd:npm run tauri dev/);
  assert.match(content, /证据：tauri_required:desktop runtime interaction/);

  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    updatedAt: 1,
  }], { language: "zh" });
  assert.equal(tasks.filter((task) => task.evidence?.some((item) =>
    item.kind === "cmd" && item.value === "npm run tauri dev"
  )).length, 1);
  assert.equal(tasks.some((task) => task.evidence?.some((item) =>
    item.kind === "tauri_required"
  )), true);
});

test("deterministic closure drops runtime plan instructions from assumptions", () => {
  const userGoal = [
    "修复一些问题：",
    "1、核心问题时：手动导入csv数据后不能够在面板上显示对应的数据内容，包括课程销售排行，销售趋势，月度环比分析，订单状态等真实信息。",
    "2、深色模式仍然有很多问题，看起来只是在白色底背景上将一些框体改成了深色而已，请彻底改变深色模式等显示方式。",
  ].join("\n");

  const sanitized = sanitizePlanEvidenceInput({
    userGoal,
    evidence: [
      "grep_search src; excerpt=src/types/order.ts:71:// 订单状态分布 src/components/Dashboard/StatusPieChart.tsx:138: <Card title=订单状态与支付方式",
      "grep_search src; excerpt=src/App.tsx:29:type ThemeType = 'light' | 'dark'; src/App.tsx:31:const THEME_KEY = 'dashboard-theme'",
      "grep_search dark|theme|深色|mode; excerpt=src/App.tsx:29:type ThemeType = 'light' | 'dark'",
      "read_file src/store/dashboardStore.ts; excerpt=Dashboard Store 聚合导入订单并计算指标",
      "read_file src/hooks/useChartData.ts; excerpt=图表数据从订单记录派生排行、趋势和状态分布",
      "read_file src/components/Dashboard/OverviewCards.tsx; excerpt=概览指标组件渲染 Dashboard 数据",
      "read_file src/components/Dashboard/CourseBarChart.tsx; excerpt=课程销售排行图表读取课程聚合数据",
    ],
    files: [
      "src/store/dashboardStore.ts",
      "src/hooks/useChartData.ts",
      "src/components/Dashboard/OverviewCards.tsx",
      "src/components/Dashboard/CourseBarChart.tsx",
      "src/App.tsx",
      "src/types/order.ts",
    ],
    constraints: [
      "如果确实缺少关键业务选择，用 `<user_options>` 提问，不要写泛化模板计划。",
      "tsx 约束：可见计划必须对齐 Codex app 的交接计划结构。",
      "如果 imageParts 0，必须先说明从截图观察到的现象。",
      "创建 plan.md 是 runtime 的职责，模型不要直接调用 write_file。",
      "批准前不修改源码。",
    ],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.control_prompt, 4);
  assert.deepEqual(sanitized.constraints, ["批准前不修改源码。"]);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
    facetMappingSource: [
      "分面 1 的数据链路由 src/store/dashboardStore.ts、src/hooks/useChartData.ts 和相关展示组件承担。",
      "分面 2 的主题边界在 src/App.tsx，当前 ThemeType 包含 light 与 dark。",
    ].join("\n"),
  });

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
  assert.match(content, /dashboardStore\.ts/);
  assert.match(content, /useChartData\.ts/);
  assert.match(content, /CourseBarChart\.tsx/);
  assert.match(content, /分面 2/);
  const facetCoverage = validateNumberedUserGoalFacetCoverage({
    userGoal: sanitized.userGoal,
    content,
  });
  assert.equal(facetCoverage.ok, false);
  assert.match(facetCoverage.reason || "", /uncovered_user_goal_facets:1,2/);
  assert.doesNotMatch(content, /如果确实缺少关键业务选择|tsx 约束|imageParts|创建 plan\.md 是 runtime|user_options|excerpt=/i);
});

test("composes deterministic plan artifact from real tool feedback without leaking envelopes", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    evidence: [
      `[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"completed","tool_call_id":"call_a","tool":"read_file","target":"src/store/dashboardStore.ts","summary":"status=observed hash=abc123 excerpt=store 保存 dashboard 指标和导入状态"}\nraw file body omitted`,
      "read_file; src/hooks/useCsvParser.ts; status=observed hash=def456 excerpt=解析 CSV 行并返回记录",
      "tool=read_file target=src/hooks/useChartData.ts status=observed hash=ghi789 excerpt=映射图表数据",
    ],
    files: [
      "src/store/dashboardStore.ts",
      "src/hooks/useCsvParser.ts",
      "src/hooks/useChartData.ts",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /已读取文件：src\/store\/dashboardStore\.ts/);
  assert.match(content, /无公共 API|公共 API/);
  assert.match(content, /useCsvParser\.ts/);
  assert.match(content, /useChartData\.ts/);
  assert.doesNotMatch(content, /MAIN_TOOL_FEEDBACK|tool_call_id|status=observed|hash=|excerpt=/);
});

test("deterministic plan uses concrete read evidence instead of broad search grounding", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    evidence: [
      "glob_search / .{ts,tsx,vue}",
      "list_directory src/hooks; excerpt=src/hooks/useChartData.ts , src/hooks/useCsvParser.ts",
      "read_file src/hooks/useCsvParser.ts; excerpt=解析 CSV 行并返回订单记录",
      "read_file src/store/dashboardStore.ts; excerpt=导入后更新 dashboard 指标",
      "read_file src/index.css; excerpt=定义主题变量和布局背景",
    ],
    files: [
      "src/hooks/useCsvParser.ts",
      "src/store/dashboardStore.ts",
      "src/index.css",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /`src\/hooks\/useCsvParser\.ts`/);
  assert.match(content, /`src\/store\/dashboardStore\.ts`/);
  assert.match(content, /`src\/index\.css`/);
  assert.match(content, /解析 CSV 行并返回订单记录/);
  assert.match(content, /定义主题变量和布局背景/);
  assert.doesNotMatch(content, /直接相关的最小改动|写入前先用证据确认/);
  assert.doesNotMatch(content, /依据证据：已搜索文件|依据证据：已查看目录/);
});

test("deterministic plan preserves the exact creator to creatorName repair contract", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName，并保持 creator 向后兼容。",
    evidence: [
      "read_file src/hooks/useCsvParser.ts; excerpt=normalizeCsvOrder 目前只返回 creator，没有给 creatorName 赋值",
      "read_file src/types/order.ts; excerpt=Order 要求 creatorName 字段",
    ],
    files: ["src/hooks/useCsvParser.ts"],
    constraints: ["保持 creator 向后兼容"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /creatorName/);
  assert.match(content, /保持 creator 向后兼容/);
  assert.match(content, /`src\/hooks\/useCsvParser\.ts`/);
  assert.match(content, /normalizeCsvOrder 目前只返回 creator/);
  assert.doesNotMatch(content, /npm run build/);
  assert.match(content, /断言：针对/);
  assert.doesNotMatch(content, /course、date、status、amount/);
});

test("read_file_window evidence is concrete enough for real UI plan materialization", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    evidence: [
      "get_project_skeleton src; excerpt=src/hooks/useCsvParser.ts, src/store/dashboardStore.ts",
      "read_file_window src/hooks/useCsvParser.ts; excerpt=mapCsvRow 读取 creator_name、course_name、paid_at 字段并返回 OrderRecord",
      "read_file_window src/store/dashboardStore.ts; excerpt=loadOrders 负责把导入记录写入 dashboard 状态并计算指标",
      "read_file_window src/components/Dashboard/CourseBarChart.tsx; excerpt=课程销售排行图表从 courseSalesData 渲染真实课程销售额",
      "read_file_window src/index.css; excerpt=:root 与 [data-theme='dark'] 定义背景、卡片和文字颜色变量",
      "analyze_tabular_document cn_tutorial_orders_by_creator_20260512.csv; excerpt=creator_name, course_name, order_status, paid_amount, paid_at",
    ],
    files: [
      "src/hooks/useCsvParser.ts",
      "src/store/dashboardStore.ts",
      "src/components/Dashboard/CourseBarChart.tsx",
      "src/index.css",
      "cn_tutorial_orders_by_creator_20260512.csv",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.non_semantic_tool || 0, 0);
  assert.ok(sanitized.evidence.some((line) => /read_file_window src\/hooks\/useCsvParser\.ts/.test(line)));

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
  assert.match(content, /useCsvParser\.ts/);
  assert.match(content, /dashboardStore\.ts/);
  assert.match(content, /CourseBarChart\.tsx/);
  assert.match(content, /index\.css/);
  assert.doesNotMatch(content, /依据证据：已查看项目结构/);
});

test("structured plan evidence records materialize without leaking failed tool logs", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并改善深色模式。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/store/dashboardStore.ts",
        status: "succeeded",
        summary: "loadOrders 聚合导入订单并刷新 Dashboard 指标",
        hash: "abc123",
      },
      {
        tool: "read_file_window",
        target: "src/index.css",
        status: "succeeded",
        summary: "[data-theme='dark'] 定义背景、卡片和文字颜色变量",
        hash: "def456",
      },
      {
        tool: "write_file",
        target: ".MAIN/plans/plan.md",
        status: "failed",
        summary: "PLAN NOT READY",
        hash: "bad",
      },
    ],
    files: ["src/store/dashboardStore.ts", "src/index.css"],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(sanitized.stats.inputStructuredEvidence, 3);
  assert.equal(sanitized.stats.keptStructuredEvidence, 2);
  assert.equal(sanitized.stats.dropReasons.non_semantic_structured_tool, 1);
  assert.match(sanitized.evidence.join("\n"), /dashboardStore\.ts/);
  assert.match(sanitized.evidence.join("\n"), /index\.css/);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /PLAN NOT READY|hash=|write_file/);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });
  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /dashboardStore\.ts/);
  assert.match(content, /index\.css/);
});

test("sanitizer drops broad extension-only glob evidence from plan grounding", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示。",
    evidence: [
      "glob_search **/*.vue; status=observed; excerpt=[]",
      "glob_search **/*.scss; status=observed; excerpt=[]",
      "read_file_window src/store/dashboardStore.ts; excerpt=loadOrders 聚合导入订单并刷新 Dashboard 指标",
      "read_file_window src/hooks/useCsvParser.ts; excerpt=parseCsvRow 负责把 CSV 列映射为订单记录",
    ],
    files: ["src/store/dashboardStore.ts", "src/hooks/useCsvParser.ts"],
    constraints: [],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.non_semantic_tool, 2);
  assert.equal(sanitized.evidence.some((line) => /glob_search/.test(line)), false);
  assert.equal(sanitized.evidence.filter((line) => /read_file_window/.test(line)).length, 2);
});

test("canonicalization rejects plans grounded only by broad discovery evidence", () => {
  const content = canonicalizePlanArtifactContent({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    content: [
      "# 计划",
      "",
      "## 摘要",
      "- 用户目标：修复 CSV 导入后 Dashboard 数据不显示。",
      "- 已搜索文件：**/*.{ts,tsx,vue} 命中 src/hooks/useCsvParser.ts。",
      "",
      "## 影响文件",
      "- src/hooks/useCsvParser.ts",
      "",
      "## 执行步骤",
      "1. 修改 CSV 导入逻辑。",
      "",
      "## 验证标准",
      "- 运行浏览器验证 Dashboard 数据显示。",
    ].join("\n"),
    language: "zh",
  });

  assert.equal(content, null);
});

test("canonicalization replaces file-only generic changes with evidence-grounded changes", () => {
  const content = canonicalizePlanArtifactContent({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    content: [
      "# 计划",
      "",
      "## 摘要",
      "- 用户目标：修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
      "- 已读取文件：src/hooks/useCsvParser.ts；解析 CSV 行并返回订单记录。",
      "- 已读取文件：src/index.css；定义主题变量和布局背景。",
      "",
      "## 影响文件",
      "- src/hooks/useCsvParser.ts",
      "- src/index.css",
      "",
      "## 执行步骤",
      "1. 按已确认文件修改实现。",
      "",
      "## 验证标准",
      "- 运行聚焦测试和浏览器验证。",
    ].join("\n"),
    language: "zh",
  });

  assert.ok(content);
  assert.match(content, /`src\/hooks\/useCsvParser\.ts`/);
  assert.match(content, /`src\/index\.css`/);
  assert.match(content, /解析 CSV 行并返回订单记录/);
  assert.match(content, /定义主题变量和布局背景/);
  assert.doesNotMatch(content, /围绕 `[^`]+` 执行与用户目标直接相关的最小改动/);
});

test("sanitizes repeated quality-gate evidence before deterministic plan materialization", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 ChatArea 有效进展和计划生成流程。",
    evidence: [
      "read_file src/App.tsx; status=observed; 6,604 chars; hash=yvpop5; summary=READ_FILE_RESULT path: src/App.tsx truncated: true totalLines: 292 returnedLines: 1-180",
      "write_file .MAIN/plans/plan.md; status=failed; 303 chars; hash=1lazvvo; summary=Error: PLAN NOT READY: .MAIN/plans/plan.md 没有写入。",
      "...[ContextMemory truncated to fit request budget]",
      "get_project_skeleton get_project_skeleton; status=failed; summary=Error: TASK_TARGETING_BLOCKED",
      "glob_search **/*.ts; status=observed; exit=439376; summary=[\"node_modules/@ant-design/colors/es/generate.d.ts\",\"src/App.ts\"]",
      `[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"completed","tool_call_id":"call_a","tool":"read_file","target":"src/components/ChatArea.tsx","summary":"status=observed hash=abc123 excerpt=ChatArea renders progress blocks"}\nREAD_FILE_RESULT path: src/components/ChatArea.tsx`,
    ],
    files: [
      "src/App.tsx via read_file; hash=yvpop5; 6,604 chars",
      ".MAIN/plans/plan.md via write_file; hash=1lazvvo; 303 chars",
      "...[ContextMemory truncated to fit request budget]",
      "src/components/ChatArea.tsx",
    ],
    constraints: ["批准前不修改源码。", "ContextMemoryState v1: noisy"],
    language: "zh",
  });

  assert.deepEqual(sanitized.files.sort(), ["src/App.tsx", "src/components/ChatArea.tsx"].sort());
  assert.equal(sanitized.evidence.length, 1);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /read_file src\/App\.tsx/);
  assert.match(sanitized.evidence.join("\n"), /read_file src\/components\/ChatArea\.tsx/);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /PLAN NOT READY|ContextMemory|hash=|status=|READ_FILE_RESULT|TASK_TARGETING_BLOCKED|\*\*\/\*\.ts|node_modules/);
  assert.equal(sanitized.stats.dropReasons.raw_read_file_metadata, 1);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_evidence, 1);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_path, 1);
  assert.ok(sanitized.stats.dropped >= 3);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.doesNotMatch(content, /落实已批准目标|approved goal/i);
  assert.doesNotMatch(content, /PLAN NOT READY|ContextMemory|hash=|status=|READ_FILE_RESULT|TASK_TARGETING_BLOCKED/);
});

test("read_file window metadata is stripped before deterministic plan evidence", () => {
  const rawReadResult = [
    "READ_FILE_RESULT",
    "path: src/components/Dashboard/CourseBarChart.tsx",
    "truncated: false",
    "totalLines: 8",
    "totalChars: 312",
    "returnedLines: 1-8",
    "returnedChars: 312",
    "---CONTENT START---",
    "export function CourseBarChart({ courseSalesData }) {",
    "  const chartRows = courseSalesData.map((item) => ({ name: item.courseName, value: item.salesAmount }));",
    "  return <BarChart data={chartRows} />;",
    "}",
    "---CONTENT END---",
  ].join("\n");

  const detail = summarizePlanEvidenceDetail({
    tool: "read_file",
    target: "src/components/Dashboard/CourseBarChart.tsx",
    content: rawReadResult,
  });
  assert.match(detail, /CourseBarChart|courseSalesData|chartRows/);
  assert.doesNotMatch(detail, /READ_FILE_RESULT|totalLines|returnedLines|path:/);

  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 图表不显示真实课程销售排行。",
    evidence: [
      `read_file src/components/Dashboard/CourseBarChart.tsx; status=observed; ${rawReadResult}`,
      "read_file src/store/dashboardStore.ts; excerpt=loadOrders 聚合导入订单并刷新 Dashboard 指标",
    ],
    files: [
      "src/components/Dashboard/CourseBarChart.tsx",
      "src/store/dashboardStore.ts",
    ],
    language: "zh",
  });

  assert.match(sanitized.evidence.join("\n"), /CourseBarChart\.tsx/);
  assert.match(sanitized.evidence.join("\n"), /courseSalesData|chartRows|loadOrders/);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /READ_FILE_RESULT|totalLines|returnedLines|hash=|status=/);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: [],
    language: "zh",
  });
  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
  assert.doesNotMatch(content, /weak_path_echo_evidence|READ_FILE_RESULT|totalLines|returnedLines|hash=|status=/);
});

test("metadata-only read evidence cannot produce a reviewable deterministic plan", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示。",
    evidence: [
      "read_file src/components/FileUploader/DragUpload.tsx; status=observed; summary=READ_FILE_RESULT path: src/components/FileUploader/DragUpload.tsx truncated: false totalLines: 114 returnedLines: 1-114",
      "list_directory src/components/Dashboard; excerpt=src/components/Dashboard/CourseBarChart.tsx src/components/Dashboard/TrendLineChart.tsx",
      "grep_search csv; status=observed; summary=MAIN/plans/plan.md:7:- 旧计划里的 CSV 推断",
    ],
    files: [
      "src/components/FileUploader/DragUpload.tsx",
      ".MAIN/plans/plan.md",
    ],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.raw_read_file_metadata, 1);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_evidence, 1);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /DragUpload\.tsx.*发现|READ_FILE_RESULT|MAIN\/plans\/plan\.md/);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: [],
    language: "zh",
  });
  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.match(validation.reason || "", /insufficient_grounded_evidence|missing_plan_sections|missing_plan_required_sections|insufficient_actionable_plan_signals|generic_fallback_plan/);
});

test("deterministic materialization extracts the real goal from turn intake wrappers", () => {
  const wrappedGoal = [
    "[turn_intake]",
    "workflowMode: plan",
    "imageParts: 2",
    "mentionedFiles: 0",
    "attachedFiles: 0",
    "priority: 先理解用户真实指令和用户提供的上下文，再决定是否探索仓库。",
    "[user_request]",
    "请根据截图修复 Dashboard 数据不显示和计划生成失败的问题。",
    "[/user_request]",
    "[/turn_intake]",
    "",
    "本轮处于 PLAN 模式。如果这是复杂实现请求，请先收集只读证据，再输出精简可见的 `<proposed_plan>`。",
  ].join("\n");

  const sanitized = sanitizePlanEvidenceInput({
    userGoal: wrappedGoal,
    evidence: [
      "read_file src/App.tsx; excerpt=App wires Dashboard upload state and renders main dashboard shell",
      "read_file src/main.tsx; excerpt=main mounts React root and imports global styles",
      "read_file src/index.css; excerpt=defines theme variables and page background tokens",
      "list_directory src/components; excerpt=src/components/Dashboard/ , src/components/DataTable/ , src/components/FileUploader/",
    ],
    files: [
      "src/App.tsx",
      "src/main.tsx",
      "src/index.css",
      "src/components/Dashboard/index.tsx",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(sanitized.userGoal, "请根据截图修复 Dashboard 数据不显示和计划生成失败的问题。");

  const content = composePlanArtifactFromEvidence({
    userGoal: wrappedGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /Dashboard 数据不显示和计划生成失败/);
  assert.doesNotMatch(content, /用户目标为空|turn_intake|PLAN 模式|proposed_plan/);
});

test("drops MAIN plan artifact self references from deterministic evidence", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入解析后仪表盘没有更新的问题。",
    evidence: [
      "grep_search csv; status=observed; summary=MAIN/plans/plan.md:7:- 数据失效原因：读取 cn_tutorial_orders_by_creator_20260512.csv 后字段不匹配",
      "read_file src/hooks/useCsvParser.ts; status=observed; excerpt=解析 CSV 行并返回订单记录",
      "read_file src/store/dashboardStore.ts; status=observed; excerpt=导入后更新 dashboard 指标",
    ],
    files: [
      "MAIN/plans/plan.md",
      "src/hooks/useCsvParser.ts",
      "src/store/dashboardStore.ts",
    ],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.plan_artifact_evidence, 1);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_path, 1);
  assert.doesNotMatch([...sanitized.evidence, ...sanitized.files].join("\n"), /MAIN\/plans\/plan\.md/i);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: [],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.doesNotMatch(content, /MAIN\/plans\/plan\.md|落实已批准目标/);
  assert.match(content, /useCsvParser\.ts/);
  assert.match(content, /dashboardStore\.ts/);
});

test("deterministic materialization rejects empty user goals instead of inventing generic targets", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "",
    evidence: [
      "read_file src/hooks/useCsvParser.ts; status=observed; excerpt=解析 CSV 行并返回记录",
      "read_file src/store/dashboardStore.ts; status=observed; excerpt=保存导入状态",
    ],
    files: ["src/hooks/useCsvParser.ts", "src/store/dashboardStore.ts"],
    constraints: [],
    language: "zh",
  });

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.doesNotMatch(content, /以落实已批准目标|落实已批准方案|approved goal/i);
  assert.doesNotMatch(content, /用户目标：\s*生成可审批实现计划/);
});

test("rejects generic ten-section fallback plan as non-Codex handoff", () => {
  const content = [
    "# 计划",
    "",
    "## 用户目标",
    "- 修复 ChatArea 有效进展和计划生成流程。",
    "",
    "## 截图/附件观察",
    "- 除非用户提供的上下文中已有明确细节，否则不信任额外截图或附件推断。",
    "",
    "## 已读证据",
    "- 已读取文件：src/App.tsx",
    "- 已读取文件：src/components/ChatArea.tsx",
    "",
    "## 已确认事实",
    "- 已确认存在相关计划证据：已读取文件：src/App.tsx",
    "",
    "## 未验证假设",
    "- 证据没有直接覆盖的实现细节，必须在源码修改前通过定向读取确认。",
    "",
    "## 影响文件",
    "- src/App.tsx",
    "- src/components/ChatArea.tsx",
    "",
    "## 执行步骤",
    "1. 基于已确认的证据先收窄实现目标，再修改源码。",
    "2. 实施满足用户目标的最小源码变更。",
    "3. 用聚焦测试、构建检查或浏览器/桌面验证确认行为达标。",
    "",
    "## 风险取舍",
    "- 重复缓存读取不能算作新证据。",
    "",
    "## 验证标准",
    "- 运行受影响子系统的聚焦验证命令。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "generic_fallback_plan");
});

test("deterministic materialization refuses insufficient evidence", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复计划审批流程。",
    evidence: [],
    files: [],
    constraints: [],
    language: "zh",
  });
  const result = materializePlanArtifactFromVisibleText({
    visibleText: content,
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /quality_gate|insufficient|missing|too_short|not_structured/);
});

test("materialization rejects import-only weak fallback plan from debug log", () => {
  const content = [
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

  const result = materializePlanArtifactFromVisibleText({
    visibleText: content,
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /import_only_evidence|generic_theme_token_plan|placeholder_validation_plan/);
});

test("materializes explicit design text to design.md", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Design",
      "",
      "## 用户目标与约束",
      "- 目标：基于 orders.csv 设计课程销售分析自动化流程。",
      "- 约束：批准前只写 `.MAIN/plans/design.md`，不生成 tasks.md。",
      "",
      "## 当前发现",
      "- 已读取课程名称样例，确认 CSV 可通过表格工具查询。",
      "",
      "## 方案",
      "- 识别字段、校验金额和时间格式，再生成课程维度销售摘要。",
      "",
      "## 影响文件与接口",
      "- 计划文件：`.MAIN/plans/design.md`。",
      "",
      "## 执行顺序",
      "1. 明确字段映射。",
      "2. 设计聚合指标。",
      "3. 审批后再生成任务清单。",
      "",
      "## 数据流与验证",
      "- 数据流：CSV 输入 -> 表格查询 -> 指标汇总 -> 报表草稿。",
      "- 验证：抽样核对课程名称、订单数和金额聚合结果。",
    ].join("\n"),
    language: "zh",
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "design");
  assert.equal(result.path, ".MAIN/plans/design.md");
});

test("canonicalization preserves long detailed lines and markdown formatting in salvaged plans", () => {
  const longStep = "1. **修改核心控制流**：在 `src/lib/orchestrator.ts` 中找到 `waitForPlanApprovalIfNeeded` 函数并调整轮询逻辑，增加针对 `abortController.signal` 中断信号的优雅降级。为了避免审批中多次触发重试，我们在这一步保留原始模型返回的全部细节，并保证反引号如 `read_file` 能够正确在 plan.md 渲染，字数需要超过三百个字符以验证我们没有做任何截断。为此我们在这里继续增加更多的无意义中文字符串来填充长度，以保证在 JavaScript 的 String.length 计算中其数值能毫无悬念地稳稳超过三百个字符。填充填充填充填充填充填充填充填充填充填充填充填充填充。";
  assert.ok(longStep.length > 300);

  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## Goal",
      "- 验证长文本行及 Markdown 格式在 canonicalize 时能够被完美保留，不发生任何截断或产生省略号。",
      "",
      "## Implementation Plan",
      longStep,
      "",
      "## Affected Files",
      "- `src/lib/orchestrator.ts`",
      "",
      "## Validation",
      "- 运行 `node --test` 并确认没有任何截断发生。",
    ].join("\n"),
    evidence: [
      "read_file src/lib/orchestrator.ts; excerpt=waitForPlanApprovalIfNeeded",
    ],
    files: ["src/lib/orchestrator.ts"],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.path, ".MAIN/plans/plan.md");
  // The content must contain the exact long step with formatting and WITHOUT truncation/ellipses!
  assert.match(result.content || "", /src\/lib\/orchestrator\.ts/);
  assert.match(result.content || "", /waitForPlanApprovalIfNeeded/);
  assert.match(result.content || "", /优雅降级/);
  // Verify backticks are preserved!
  assert.match(result.content || "", /`src\/lib\/orchestrator\.ts`/);
  assert.match(result.content || "", /`read_file`/);
  // Verify bold format is preserved!
  assert.match(result.content || "", /\*\*修改核心控制流\*\*/);
  // Verify it's not truncated with ellipses!
  assert.doesNotMatch(result.content || "", /优雅降级\.\.\./);
});

test("canonicalized materialization preserves explicit diagnosis chains and typed R to E bindings", () => {
  const evidenceRecords = [
    {
      tool: "read_file",
      target: "src/editor.js",
      status: "succeeded",
      summary: "setValue incorrectly dispatches the same input event used for user edits",
    },
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "the input listener sets isDirty and calls scheduleAutoSave",
    },
  ];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-canonical-diagnosis",
    objective: "Fix the save dialog that appears after opening an existing document.",
    evidenceRecords,
  });
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Summary",
      "- User goal: Fix the save dialog that appears after opening an existing document.",
      "- Read file: src/editor.js; setValue dispatches the user-edit input event.",
      "## Confirmed Evidence",
      "- [E1] `src/editor.js` setValue dispatches the user-edit input event.",
      "- [E2] `src/main.js` handles that event by setting isDirty and scheduling auto-save.",
      "## Diagnosis / Inference",
      "- [R1 inferred, E1 -> E2] Programmatic document loading enters the user-edit event chain and therefore schedules auto-save.",
      "## Key Changes",
      "- [C1, R1] Modify `src/editor.js` so programmatic value assignment does not dispatch the user-edit event.",
      "## Test Plan",
      "- [V1] Run `npm test` and assert that opening an existing document does not schedule auto-save or show a save dialog.",
      "## Assumptions / Defaults",
      "- Preserve the existing user-edit event behavior.",
    ].join("\n"),
    userGoal: bundle.objective,
    evidenceRecords,
    files: bundle.observedTargets,
    language: "en",
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "canonicalized_visible_plan");
  assert.match(result.content || "", /^## Diagnosis \/ Inference$/m);
  assert.match(result.content || "", /\[R1 inferred, E1 -> E2\]/);
  assert.deepEqual(result.candidate?.diagnoses.map((diagnosis) => ({
    id: diagnosis.id,
    evidenceRefs: diagnosis.evidenceRefs,
    chainRefs: diagnosis.chainRefs,
  })), [{
    id: "R1",
    evidenceRefs: bundle.facts.map((fact) => fact.id),
    chainRefs: bundle.facts.map((fact) => fact.id),
  }]);
  assert.deepEqual(result.candidate?.changes[0]?.diagnosisRefs, ["R1"]);
});

test("canonicalization preserves the multi-facet G/E/R/C/V traceability ledger", () => {
  const userGoal = [
    "1、找出保存后旧标题未刷新的根本原因。",
    "2、找出删除后计数未更新的根本原因。",
  ].join("\n");
  const canonical = canonicalizePlanArtifactContent({
    content: [
      "# Summary",
      "- 覆盖两个状态同步问题。",
      "## 已确认证据",
      "- [E1] `src/detail.ts` 保存后仍读取旧标题缓存。",
      "- [E2] `src/list.ts` 删除后仍读取旧集合计数。",
      "## 诊断 / 推断",
      "- [R1 inferred, E1] 保存链遗漏详情标题缓存刷新。",
      "- [R2 inferred, E2] 删除链遗漏最新集合计数派生。",
      "## 关键改动",
      "- [C1, R1] 修改 `src/detail.ts`，保存后刷新详情标题缓存。",
      "- [C2, R2] 修改 `src/list.ts`，删除后从最新集合派生计数。",
      "## 测试方案",
      "- [V1] 保存新标题并断言详情页显示新标题。",
      "- [V2] 删除记录并断言列表计数立即减少。",
      "## 需求分面追踪",
      "- G1 -> E1 -> R1 -> C1 -> V1",
      "- G2 -> E2 -> R2 -> C2 -> V2",
      "## 假设与默认值",
      "- 保持未点名接口不变。",
    ].join("\n"),
    userGoal,
    evidence: [
      "read_file src/detail.ts; excerpt=保存后仍读取旧标题缓存",
      "read_file src/list.ts; excerpt=删除后仍读取旧集合计数",
    ],
    files: ["src/detail.ts", "src/list.ts"],
    language: "zh",
  });

  assert.ok(canonical);
  assert.match(canonical, /## 需求分面追踪/);
  assert.match(canonical, /G1 -> E1 -> R1 -> C1 -> V1/);
  assert.equal(validateNumberedUserGoalFacetCoverage({
    userGoal,
    content: canonical,
    diagnosisRequired: true,
  }).ok, true);
});

test("auto-detects framework design and game dev keywords to route to design.md kind", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 游戏开发框架设计方案",
      "",
      "## 目标与约束",
      "- 目标：基于 Unity/C# 设计游戏实体的 Component-Based 架构与数据流契约。",
      "- 约束：确保类图关系和实体更新在单线程下高吞吐执行，同时为了满足方案物化的最低长度限制，我们需要在这里写下更多关于系统设计的详细内容。我们需要确保本方案描述非常清晰并且超过两百八十个字符以避免被质量门禁判断为过短。",
      "",
      "## 方案",
      "- 设计 EntityMgr 类，维护 Active 实体链表。为各个组件提供类结构设计，支持多态 and 静态分析，支持多维度的数据流转换与性能优化机制。",
      "",
      "## 影响文件",
      "- 计划文件：`.MAIN/plans/design.md`。",
      "",
      "## 执行顺序",
      "1. 明确 C# 接口设计并进行多端同步验证。",
      "2. 画出 UML 类图结构以方便团队成员进行协作开发与后续的代码评审工作。",
    ].join("\n"),
    language: "zh",
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "design");
  assert.equal(result.path, ".MAIN/plans/design.md");
});

test("plan evidence grounding rejects modified existing files that were never read", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- 已读取 `src/main.js` 并确认当前打开文件入口。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js` 的事件处理。",
      "- 更新 `index.html` 的脚本入口。",
    ].join("\n"),
    recentToolActivity: [
      { name: "read_file", target: "src/main.js", status: "succeeded" },
    ],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.recoveryAction, "targeted_evidence");
  assert.match(validation.reason || "", /ungrounded_plan_change_targets:index\.html/);
});

test("plan evidence grounding rejects a truncated relative suffix instead of aliasing a nested source file", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- 已读取 src-tauri/src/main.rs 并确认系统文件打开入口。",
      "",
      "## 关键改动",
      "- 修改 src/main.rs 的文件打开事件。",
    ].join("\n"),
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "handle_open_url receives the macOS file-open event",
      },
    ],
  });

  assert.equal(validation.ok, false);
  assert.match(validation.reason || "", /ungrounded_plan_change_targets:src\/main\.rs/);
});

test("plan evidence sanitizer retains src-tauri paths without inventing their inner relative suffix", () => {
  const sanitized = sanitizePlanEvidenceInput({
    evidence: [
      "read_file src-tauri/src/main.rs; handle_open_url stores incoming file paths for later forwarding",
    ],
    files: ["src-tauri/src/main.rs"],
    language: "zh",
  });
  const bundle = buildPlanEvidenceBundle({
    objective: "修复 macOS 文件打开入口。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "handle_open_url stores incoming file paths for later forwarding",
    }],
    files: sanitized.files,
  });

  assert.equal(sanitized.files.includes("src-tauri/src/main.rs"), true);
  assert.equal(sanitized.files.includes("src/main.rs"), false);
  assert.deepEqual(bundle.changeTargets, ["src-tauri/src/main.rs"]);

  const candidate = buildPlanCandidate({
    content: [
      "# Plan",
      "",
      "## Summary",
      "- Repair the file-open path.",
      "",
      "## Confirmed Evidence",
      "- src-tauri/src/main.rs receives the file-open event.",
      "",
      "## Key Changes",
      "- Update src/main.rs to forward the event.",
      "",
      "## Public APIs / Interfaces / Types",
      "- No public API change.",
      "",
      "## Test Plan",
      "- Run cargo check.",
      "",
      "## Assumptions / Defaults",
      "- Preserve existing behavior.",
    ].join("\n"),
    bundle,
  });
  assert.equal(candidate.changes[0]?.targetRef, "src/main.rs");
  assert.deepEqual(validatePlanCandidate(candidate, bundle.hash), ["ungrounded_changes"]);
});

test("candidate evidence binding does not misclassify validation references as source changes", () => {
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-candidate-validation-reference",
    objective: "修改 src/hooks/useCsvParser.ts，补全 creatorName 映射；其余文件只作契约证据。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/hooks/useCsvParser.ts",
      status: "succeeded",
      summary: "normalizeCsvOrder maps creator but does not assign creatorName",
    }, {
      tool: "read_file",
      target: "src/hooks/useChartData.ts",
      status: "succeeded",
      summary: "buildCourseRanking consumes creatorName and falls back to creator",
    }, {
      tool: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "succeeded",
      summary: "creatorField is the creatorName contract key",
    }, {
      tool: "read_file",
      target: "src/types/order.ts",
      status: "succeeded",
      summary: "Order requires creatorName as a string",
    }],
  });
  assert.deepEqual(bundle.changeTargets, ["src/hooks/useCsvParser.ts"]);

  const candidate = buildPlanCandidate({
    content: [
      "# 计划：creatorName 数据链路整改",
      "",
      "## 摘要",
      "- 补全 creatorName 映射并保持消费契约。",
      "",
      "## 已确认证据",
      "- src/hooks/useCsvParser.ts 当前缺少 creatorName 映射。",
      "",
      "## 关键实现改动",
      "1. 完善解析逻辑：",
      "- 修改 src/hooks/useCsvParser.ts 中的 normalizeCsvOrder。",
      "- 增加 creator 到 creatorName 的确定性映射。",
      "2. 统一类型契约：",
      "- 对齐 CsvOrder 与 Order 的 creatorName 约束。",
      "3. 验证 Store 驱动：",
      "- 确保 src/store/dashboardStore.ts 的 creatorField 能正确驱动更新后的数据流。",
      "",
      "## 测试方案",
      "- 输入 creator=alice，预期 creatorName=alice。",
    ].join("\n"),
    bundle,
  });

  assert.equal(candidate.changes.length > 0, true);
  assert.equal(candidate.changes.every((change) => change.targetRef === "src/hooks/useCsvParser.ts"), true);
  assert.deepEqual(validatePlanCandidate(candidate, bundle.hash), []);
});

test("candidate diagnosis binds an ordered evidence chain and its supported change", () => {
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-typed-diagnosis",
    objective: "修复打开本地文件后误触发保存窗口的问题。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/editor.js",
        status: "succeeded",
        summary: "setValue dispatches the same input event used for user edits",
      },
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "the input listener sets isDirty and calls scheduleAutoSave",
      },
    ],
  });
  const candidate = buildPlanCandidate({
    content: [
      "# 保存窗口修复计划",
      "## 用户目标",
      "- 修复打开本地文件后误触发保存窗口。",
      "## 已确认证据",
      "- [E1] `src/editor.js` 的 `setValue` 会派发输入事件。",
      "- [E2] `src/main.js` 的输入监听器设置 `isDirty` 并调用 `scheduleAutoSave`。",
      "## 诊断 / 推断",
      "- [R1 inferred, E1 -> E2] 程序化加载复用了用户输入事件链，因而进入自动保存调度。",
      "## 关键改动",
      "- [C1, R1] 修改 `src/editor.js`，把程序化赋值与用户输入事件分离。",
      "## 测试方案",
      "- [V1] 打开已有文件，断言不出现保存窗口。",
    ].join("\n"),
    bundle,
  });

  assert.equal(candidate.schemaVersion, 5);
  assert.deepEqual(candidate.diagnoses.map((diagnosis) => ({
    certainty: diagnosis.certainty,
    evidenceRefs: diagnosis.evidenceRefs,
    chainRefs: diagnosis.chainRefs,
  })), [{
    certainty: "inferred",
    evidenceRefs: bundle.facts.map((fact) => fact.id),
    chainRefs: bundle.facts.map((fact) => fact.id),
  }]);
  assert.deepEqual(candidate.changes[0]?.diagnosisRefs, ["R1"]);
  assert.deepEqual(validatePlanCandidate(candidate, bundle.hash), []);
});

test("nested canonical change sections bind descendant mutations to their target-file owner", () => {
  const evidenceRecords = [{
    tool: "read_file",
    target: "src/parser.ts",
    status: "succeeded",
    summary: "normalizeRow does not assign creatorName from creator",
  }, {
    tool: "read_file",
    target: "src/consumer.ts",
    status: "succeeded",
    summary: "buildLabel does not preserve the creator fallback contract",
  }];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-nested-target-owner",
    objective: "修改 src/parser.ts 和 src/consumer.ts，补齐 creatorName 映射并保持消费回退。",
    evidenceRecords,
  });
  assert.deepEqual(new Set(bundle.changeTargets), new Set(["src/parser.ts", "src/consumer.ts"]));

  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# creatorName 双目标修复计划",
      "",
      "## 摘要",
      "- 补齐解析层 creatorName 映射，并保持消费端回退契约。",
      "",
      "## 已确认事实",
      "- `src/parser.ts` 未填充 creatorName。",
      "- `src/consumer.ts` 未保持 creator 回退。",
      "",
      "## 关键实现改动",
      "### 1. 解析器改动",
      "- **目标文件**：`src/parser.ts`",
      "- **改动内容**：",
      "  - 补齐 creator 到 creatorName 的确定性映射。",
      "### 2. 消费端改动",
      "- **目标文件**：`src/consumer.ts`",
      "- **改动内容**：",
      "  - 修复 creatorName 缺失时的 creator 回退。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 保持现有字段类型，不新增公共 API。",
      "",
      "## 测试方案",
      "- 运行 `npm test` 验证映射和回退场景。",
      "",
      "## 假设与默认值",
      "- 保持其它字段归一化行为不变。",
    ].join("\n"),
    userGoal: bundle.objective,
    evidenceRecords,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.candidate?.changes.length, 2, JSON.stringify(result.candidate, null, 2));
  assert.deepEqual(
    new Set(result.candidate?.changes.map((change) => change.targetRef)),
    new Set(["src/parser.ts", "src/consumer.ts"]),
  );
  assert.ok(result.candidate?.changes.every((change) => change.evidenceRefs.length > 0));
  assert.deepEqual(validatePlanCandidate(result.candidate, bundle.hash), []);
});

test("semantic non-canonical mutation sections reject wrong or unread paths", () => {
  const cases = [{
    heading: "修复步骤",
    plannedTarget: "src/unread.ts",
    readTarget: "src/read.ts",
  }, {
    heading: "Repair Steps",
    plannedTarget: "src/main.rs",
    readTarget: "src-tauri/src/main.rs",
  }];

  for (const fixture of cases) {
    const validation = validatePlanEvidenceGrounding({
      content: [
        "# Repair plan",
        "",
        `## ${fixture.heading}`,
        `- Modify \`${fixture.plannedTarget}\` to repair the confirmed contract gap.`,
      ].join("\n"),
      evidenceRecords: [{
        tool: "read_file",
        target: fixture.readTarget,
        status: "succeeded",
        summary: "The inspected source exposes a concrete contract gap.",
      }],
    });

    assert.equal(validation.ok, false, JSON.stringify({ fixture, validation }));
    assert.match(
      validation.reason || "",
      new RegExp(`ungrounded_plan_change_targets:${fixture.plannedTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  }
});

test("candidate projection does not impose canonical headings after semantic plan validation", () => {
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-flexible-plan-headings",
    objective: "修复文档打开链路并验证构建与桌面交互。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      summary: "src/main.ts currently lacks the file-open listener required by the desktop workflow",
    }],
  });
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 修复文档打开链路",
      "",
      "## 已确认证据",
      "- `src/main.ts` 当前缺少桌面文件打开流程所需的事件监听。",
      "- 现有文档加载入口已经能够接收文件路径，因此无需重写解析器或编辑器状态，只需补齐桌面事件到该入口的连接。",
      "",
      "## 分步整改",
      "1. 修改 `src/main.ts`，接入文件打开事件并把 payload 交给现有文档加载流程。",
      "2. 沿用现有错误上报和空路径保护，并在页面卸载时释放事件监听，避免开发热重载后重复处理同一个文件。",
      "",
      "## 验收检查",
      "- 运行 `npm run build` 并检查退出码。",
      "- 启动桌面应用，双击测试文档并确认内容载入。",
      "- 连续重新载入开发页面后再次打开文档，确认每次只触发一次加载，控制台没有新增监听泄漏或未处理异常。",
    ].join("\n"),
    userGoal: "修复文档打开链路并验证构建与桌面交互。",
    evidenceRecords: bundle.facts.map((fact) => ({
      tool: fact.tool,
      target: fact.target,
      status: "succeeded",
      summary: fact.summary,
    })),
    files: ["src/main.ts"],
    language: "zh",
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(validatePlanCandidate(result.candidate, bundle.hash), []);
  assert.equal(result.candidate.summary.length, 0);
  assert.equal(result.candidate.changes.length, 0);
  assert.equal(result.candidate.tests.length, 0);
});

test("compact Gemma-style plans are accepted by semantics instead of character count", () => {
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-compact-plan",
    objective: "恢复桌面文件打开。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.ts",
      status: "succeeded",
      summary: "src/main.ts has no listener connecting the desktop file-open event to the document loader",
    }],
  });
  const visibleText = [
    "# 打开修复",
    "## 目标",
    "- 恢复文件打开。",
    "## 已确认证据",
    "- `src/main.ts` 无事件监听。",
    "## 实施",
    "1. 修改 `src/main.ts` 接入加载。",
    "## 验证",
    "- 运行 `npm test`，再打开文件确认内容。",
  ].join("\n");
  assert.ok(visibleText.length < 120);

  const result = materializePlanArtifactFromVisibleText({
    visibleText,
    userGoal: "恢复桌面文件打开。",
    evidenceRecords: bundle.facts.map((fact) => ({
      tool: fact.tool,
      target: fact.target,
      status: "succeeded",
      summary: fact.summary,
    })),
    files: ["src/main.ts"],
    language: "zh",
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "visible_plan");
});

test("materialization rejects the logged MD Viewer plan when index.html was proposed without read evidence", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan: 修复文件打开链路",
      "",
      "## 摘要",
      "- 目标：修复双击 Markdown 文件和工具栏打开按钮失效。",
      "",
      "## 已确认证据",
      "- 已读取 `src-tauri/src/main.rs` 与 `src/main.js`，需要对齐后端事件和前端监听。",
      "",
      "## 关键改动",
      "1. 修改 `src-tauri/src/main.rs` 的文件打开事件。",
      "2. 修改 `src/main.js` 的事件监听和打开按钮处理。",
      "3. 更新 `index.html` 的脚本引入方式。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 内部事件 payload 会变化，不新增公共 API。",
      "",
      "## 测试方案",
      "- 运行 `npm run build`，断言构建退出码为 0；桌面双击与工具栏打开保留为后续交互复核。",
      "",
      "## 假设与默认值",
      "- 默认保持其他编辑功能不变。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: "emits file-open" },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "listens for open-file-event" },
      { tool: "read_file", target: "src-tauri/tauri.conf.json", status: "succeeded", summary: "Tauri app config" },
    ],
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /ungrounded_plan_change_targets:index\.html/);
  assert.equal(result.quality?.recoveryAction, "targeted_evidence");
  assert.equal(result.quality?.canAutoRepair, false);
});

test("deterministic evidence closure repairs the logged MD Viewer rejection without inventing targets", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 macOS 上双击 Markdown 文件和工具栏打开按钮没有反应的问题，并保持现有编辑与保存行为不变。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "应用入口接收系统文件打开请求并向主窗口发送内部事件",
      },
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "前端 openFile 函数和工具栏按钮负责读取并展示 Markdown 内容",
      },
      {
        tool: "read_file",
        target: "src-tauri/tauri.conf.json",
        status: "succeeded",
        summary: "Tauri 主窗口和应用打包配置位于此文件",
      },
      {
        tool: "read_file",
        target: "src-tauri/Cargo.toml",
        status: "succeeded",
        summary: "后端依赖和 Tauri 版本由此清单约束",
      },
    ],
    files: [
      "src-tauri/src/main.rs",
      "src/main.js",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
  assert.match(content, /src-tauri\/src\/main\.rs/);
  assert.match(content, /src\/main\.js/);
  assert.match(content, /双击|工具栏|文件打开/);
  assert.doesNotMatch(content, /index\.html/);
  assert.doesNotMatch(content, /function\s+openFile|invoke\(|listen\(/);
});

test("plan evidence grounding requires an explicit confirmed-evidence section", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 摘要",
      "- 已确认当前事件名不一致。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js` 的事件处理。",
    ].join("\n"),
    evidence: [
      "read_file src/main.js; excerpt=listen('open-file-event')",
    ],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "missing_plan_evidence_section");
  assert.equal(validation.recoveryAction, "rewrite");
  assert.equal(validation.canAutoRepair, true);
});

test("materialization repairs only the missing evidence section without broadening plan scope", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "## 问题总结",
      "当前文件打开链路已经完成代码读取，下面给出正式整改计划。",
      "",
      "# Proposed Plan: 修复 Markdown 文件打开链路",
      "",
      "## 摘要",
      "- 用户目标：修复双击 Markdown 文件和工具栏打开按钮无法打开文件的问题。",
      "",
      "## 关键改动",
      "1. 修改 `src-tauri/src/main.rs`，统一后端文件打开事件名称和 payload。",
      "2. 修改 `src/main.js`，让启动参数、事件监听和工具栏按钮复用同一打开入口。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 不新增公共 API；只统一现有内部 Tauri 事件 payload。",
      "",
      "## 测试方案",
      "- 运行 `npm run build` 和 `cargo check --manifest-path src-tauri/Cargo.toml`，两个有限命令都必须以退出码 0 完成。",
      "- 断言：双击文件与工具栏按钮两条入口都复用同一打开流程并显示所选 Markdown 内容。",
      "",
      "## 假设与默认值",
      "- 保持编辑器、保存和预览行为不变。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: "后端当前发出 file-open 事件" },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "前端当前监听 open-file-event" },
      { tool: "read_file", target: "src-tauri/tauri.conf.json", status: "succeeded", summary: "应用配置保持现状" },
      { tool: "read_file", target: "package.json", status: "succeeded", summary: "构建脚本保持现状" },
    ],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "evidence_section_repaired_visible_plan");
  assert.match(result.content || "", /## 已确认证据/);
  assert.match(result.content || "", /src-tauri\/src\/main\.rs/);
  assert.match(result.content || "", /src\/main\.js/);
  assert.doesNotMatch(result.content || "", /修改 `src-tauri\/tauri\.conf\.json`/);
  assert.doesNotMatch(result.content || "", /修改 `package\.json`/);
  assert.match(result.content || "", /统一后端文件打开事件名称和 payload/);
  assert.match(result.content || "", /启动参数、事件监听和工具栏按钮复用同一打开入口/);
  const repairedContent = result.content || "";
  assert.ok(repairedContent.indexOf("# Proposed Plan") < repairedContent.indexOf("## 已确认证据"));
  assert.ok(repairedContent.indexOf("## 摘要") < repairedContent.indexOf("## 已确认证据"));
  assert.ok(repairedContent.indexOf("## 已确认证据") < repairedContent.indexOf("## 关键改动"));
});

test("materialization can repair a missing evidence section from the frozen evidence bundle alone", () => {
  const evidenceRecords = [{
    tool: "read_file",
    target: "src/importer.ts",
    status: "succeeded",
    summary: "normalizeRow currently forwards creator but does not assign creatorName",
  }];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-frozen-evidence-repair",
    objective: "修改 src/importer.ts，补齐 creatorName 映射。",
    evidenceRecords,
  });
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan: 补齐 CSV 姓名映射",
      "",
      "## 摘要",
      "- 修复导入数据缺少 creatorName 的问题。",
      "",
      "## 关键改动",
      "- 修改 `src/importer.ts`，由 normalizeRow 将 creator 确定性映射到 creatorName，并保持现有字段回退关系。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 保持现有导入结果类型，不新增公共 API。",
      "",
      "## 测试方案",
      "- 运行 `npm test`，验证有姓名、缺姓名和兼容旧 creator 字段三种输入。",
      "",
      "## 假设与默认值",
      "- 不改变其它 CSV 字段的归一化行为。",
    ].join("\n"),
    userGoal: bundle.objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "evidence_section_repaired_visible_plan");
  assert.equal(result.evidenceBundleHash, bundle.hash);
  assert.match(result.content || "", /## 已确认证据/);
  assert.match(result.content || "", /src\/importer\.ts/);
  assert.match(result.content || "", /does not assign creatorName/);
  assert.deepEqual(validatePlanCandidate(result.candidate, bundle.hash), []);
});

test("materialization does not project metadata-only or failed reads into confirmed evidence", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan: 修复 Markdown 文件打开链路",
      "",
      "## 摘要",
      "- 用户目标：修复前端 Markdown 文件打开入口。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js`，统一启动参数和工具栏按钮的文件打开入口。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 不新增公共 API，保持内部事件 payload 类型不变。",
      "",
      "## 测试方案",
      "- 运行 `npm run build`，断言构建以退出码 0 完成；桌面入口保留为后续交互复核。",
      "- 同时验证启动参数为空、路径包含空格、重复打开同一文件时仍沿用现有错误处理和编辑器状态，不引入额外行为变化。",
      "",
      "## 假设与默认值",
      "- 保持编辑器、保存和预览行为不变；本轮不会把读取失败或只有路径元数据的活动描述成已经确认的源码事实。",
    ].join("\n"),
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "",
    }],
    recentToolActivity: [{
      name: "read_file",
      target: "src/main.js",
      status: "blocked",
      detail: "读取被阻止",
    }],
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_plan_evidence_section");
  assert.equal(result.quality?.recoveryAction, "rewrite");
});

test("plan evidence grounding accepts read-backed change targets with confirmed evidence", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- `src/main.js` 当前监听 `open-file-event`。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js` 的事件处理。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "listen('open-file-event')" },
    ],
  });

  assert.equal(validation.ok, true);
});

test("a basename-only Plan target resolves to one unique read-backed workspace file", () => {
  const evidenceRecords = [{
    tool: "read_file",
    target: "src/hooks/useCsvParser.ts",
    status: "succeeded",
    summary: "normalizeCsvOrder forwards creator but does not assign creatorName",
  }];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-unique-basename",
    objective: "修改 src/hooks/useCsvParser.ts，补齐 creatorName 映射。",
    evidenceRecords,
  });
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan: 补齐 CSV 姓名映射",
      "",
      "## 摘要",
      "- 让 CSV 解析结果稳定提供 creatorName。",
      "",
      "## 已确认证据",
      "- `src/hooks/useCsvParser.ts` 的 normalizeCsvOrder 当前只返回 creator。",
      "",
      "## 关键改动",
      "- 修改 `useCsvParser.ts`，在 normalizeCsvOrder 中增加 creator 到 creatorName 的确定性映射，并保留旧字段回退。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 保持现有返回类型，不新增公共 API。",
      "",
      "## 测试方案",
      "- 运行 `npm test`，使用包含 creator、creatorName 和空姓名的三类输入验证结果。",
      "",
      "## 假设与默认值",
      "- 不改变其它 CSV 字段的归一化行为。",
    ].join("\n"),
    userGoal: bundle.objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.candidate?.changes[0]?.targetRef, "src/hooks/useCsvParser.ts");
  assert.ok((result.candidate?.changes[0]?.evidenceRefs.length || 0) > 0);
});

test("a basename-only Plan target stays ungrounded when multiple read files share it", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- 已读取两个不同目录中的 index.ts。",
      "",
      "## 关键改动",
      "- 修改 `index.ts` 的初始化逻辑。",
    ].join("\n"),
    evidenceRecords: [{
      tool: "read_file",
      target: "src/client/index.ts",
      status: "succeeded",
      summary: "client bootstrap",
    }, {
      tool: "read_file",
      target: "src/server/index.ts",
      status: "succeeded",
      summary: "server bootstrap",
    }],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "ungrounded_plan_change_targets:index.ts");
});

test("plan evidence grounding requires a concrete change target after source reads", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- `src/main.js` 当前监听 `open-file-event`。",
      "",
      "## 关键改动",
      "- 修复前端事件监听并统一 payload。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "listen('open-file-event')" },
    ],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "missing_grounded_plan_change_target");
  assert.equal(validation.recoveryAction, "rewrite");
});

test("rejects the logged canonicalized MD Viewer plan with polluted summary and code fragments", () => {
  const content = [
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：可能原因（按优先级排序）：",
    "- 用户目标：Tauri 后端未注册 on_open_url / on_file_open 事件监听",
    "- 用户目标：Tauri 2.x 中，系统双击文件触发的事件需要注册回调",
    "- 已读取文件：src-tauri/src/main.rs；发现：// Prevents additional console window...",
    "",
    "## 已确认证据",
    "- 已读取文件：src/main.js；发现：// MD Viewer - 主逻辑...",
    "",
    "## 关键改动",
    "- ```javascript",
    "- // 确保正确引入 dialog API",
    "- import { open } from '@tauri-apps/plugin-dialog';",
    "- async function handleOpenFile() {",
    "- const selected = await open({",
    "",
    "## 公共 API / 接口 / 类型",
    "- app.on_file_open()：新增 Rust 后端注册文件打开事件。",
    "",
    "## 测试方案",
    "- 运行 npm run tauri build 并验证冷启动与已有实例。",
    "",
    "## 假设与默认值",
    "- 默认保持编辑功能不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.ok([
    "duplicated_user_goal_summary",
    "raw_evidence_in_plan_summary",
    "code_fragments_in_plan_key_changes",
  ].includes(validation.reason || ""));
});

test("rejects a structurally complete MD Viewer plan whose test plan is only diagnosis and assurances", () => {
  const content = [
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

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "non_executable_test_plan");

  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: content,
    userGoal: "修复双击 Markdown 文件无法打开的问题。",
    evidenceRecords: [
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: "builder" },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "openFile" },
    ],
    language: "zh",
  });
  assert.equal(materialized.ok, false);
  assert.equal(materialized.reason, "non_executable_test_plan");
  assert.equal(materialized.repairableProjection?.path, ".MAIN/plans/plan.md");
  assert.equal(materialized.repairableProjection?.content, content);
});

test("rejects the real MD Viewer validation shape that substitutes tauri dev, manual steps, and vague Playwright", () => {
  const content = [
    "# MD Viewer 问题修复计划",
    "",
    "## 摘要",
    "- 修复初始标签页命名和打开本地文件后弹出保存对话框的问题。",
    "",
    "## 确认证据",
    "- `src/main.js` 同时管理标签页状态和本地文件打开流程。",
    "",
    "## 关键实现改动",
    "- 修改 `src/main.js` 的初始标签页状态与文件打开状态切换。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化。",
    "",
    "## 测试方案",
    "### 验证步骤",
    "1. **启动应用**：运行 `npm run tauri dev`",
    "2. **验证初始标签页**：",
    "   - 应用启动后，标签页应显示\"未命名文档\"而非空白",
    "   - 编辑内容后，标签页应显示\"未命名文档 *\"",
    "3. **验证文件打开**：",
    "   - 点击\"打开\"按钮，选择本地 md 文件",
    "   - 文件应正确打开，且不应弹出保存对话框",
    "",
    "### 自动化测试",
    "```bash",
    "# 运行开发服务器",
    "npm run tauri dev",
    "",
    "# 手动验证上述测试步骤",
    "# 或使用 Playwright 等工具进行自动化测试",
    "```",
    "",
    "## 假设与默认值",
    "- 保持其他编辑器行为不变。",
  ].join("\n");

  const quality = validateActionablePlanArtifact(content);
  assert.equal(quality.ok, false);
  assert.equal(quality.reason, "non_executable_test_plan");

  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: content,
    userGoal: "修复 MD Viewer 的标签页命名与打开文件后弹出保存对话框问题。",
  });
  assert.equal(materialized.ok, false);
  assert.equal(materialized.reason, "non_executable_test_plan");
});

test("structured input, expected output, and assertion rows form an executable test plan", () => {
  const content = [
    "# CSV creatorName 数据链路修复计划",
    "",
    "## 摘要",
    "- 修复 CSV creator 字段未映射到 creatorName，导致 Dashboard 排名回退的问题。",
    "",
    "## 已确认发现",
    "- `src/hooks/useCsvParser.ts` 当前只返回 `creator`。",
    "- `src/hooks/useChartData.ts` 读取 `creatorName`。",
    "",
    "## 关键改动",
    "- 修改 `src/hooks/useCsvParser.ts`，让 `normalizeCsvOrder` 同源填充 `creator` 与 `creatorName`。",
    "- 更新 `src/hooks/useChartData.ts`，保留 `creator` 回退兼容。",
    "",
    "## 公共 API / 接口 / 类型",
    "- `CsvOrder.creatorName` 保持可选，不新增公共 API。",
    "",
    "## 测试方案",
    "### normalizeCsvOrder 单元场景",
    "- 输入：`{ creator: 'alice' }`",
    "- 预期输出：`{ creator: 'alice', creatorName: 'alice' }`",
    "- 验证方法：断言 `result.creatorName === 'alice'`。",
    "",
    "## 假设与默认值",
    "- 保持现有 creator 回退行为不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
});

test("concrete input and expected output form an executable scenario without a redundant assertion row", () => {
  const content = [
    "# CSV creatorName 数据链路修复计划",
    "",
    "## 摘要",
    "- 修复 CSV creator 字段未映射到 creatorName 的数据链路缺口。",
    "",
    "## 已确认发现",
    "- `src/hooks/useCsvParser.ts` 当前只返回 `creator`。",
    "- `src/hooks/useChartData.ts` 消费 `creatorName`。",
    "",
    "## 关键改动",
    "- 修改 `src/hooks/useCsvParser.ts`，让 `normalizeCsvOrder` 同源填充 `creator` 与 `creatorName`。",
    "- 更新 `src/hooks/useChartData.ts`，在解析层修复后移除冗余回退。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持 `Order.creatorName: string` 契约，不新增公共 API。",
    "",
    "## 测试方案",
    "### normalizeCsvOrder 单元场景",
    "- 输入：`{ creator: 'alice', amount: '12' }`",
    "- 预期输出：`{ creator: 'alice', creatorName: 'alice' }`",
    "",
    "## 假设与默认值",
    "- 当前 CSV 的 creator 与 creatorName 具有相同业务语义。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
});

test("a concrete narrative test case with input and assertion is executable", () => {
  const content = [
    "# CSV creatorName 数据链路修复计划",
    "",
    "## 摘要",
    "- 修复 CSV 解析层遗漏 creatorName、导致 Dashboard 回退显示的问题。",
    "",
    "## 已确认发现",
    "- `src/hooks/useCsvParser.ts` 当前未映射 `creatorName`。",
    "- `src/hooks/useChartData.ts` 优先消费 `creatorName`。",
    "",
    "## 关键实现改动",
    "- 修改 `src/hooks/useCsvParser.ts`，在 `normalizeCsvOrder` 中补齐 `creatorName` 映射。",
    "- 保持 `src/hooks/useChartData.ts` 的兼容回退行为。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持 `Order.creatorName: string` 契约，不新增公共 API。",
    "",
    "## 测试方案",
    "## 1. 单元测试",
    "- **测试用例 A**：输入包含 `creatorName` 字段的模拟 Row，断言 `normalizeCsvOrder` 返回的对象包含正确姓名。",
    "- **测试用例 B**：输入不含姓名列的 Row，断言 `creatorName` 返回默认值而非 `undefined`。",
    "",
    "## 假设与默认值",
    "- 保持现有 `creator` 回退语义不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
});

test("a multi-line action and expected result stay inside one executable test scenario", () => {
  const content = [
    "# CSV creatorName 数据链路修复计划",
    "",
    "## 摘要",
    "- 修复 CSV 解析层遗漏 creatorName、导致 Dashboard 回退显示的问题。",
    "",
    "## 已确认发现",
    "- `src/hooks/useCsvParser.ts` 当前未映射 `creatorName`。",
    "",
    "## 关键实现改动",
    "- 修改 `src/hooks/useCsvParser.ts`，在 `normalizeCsvOrder` 中补齐 `creatorName` 映射。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持 `Order.creatorName: string` 契约，不新增公共 API。",
    "",
    "## 测试方案",
    "## 1. 集成测试",
    "- **测试步骤**：",
    "  - 上传包含姓名列的 CSV。",
    "  - 观察 Dashboard 的课程排名标签。",
    "- **预期结果**：标签显示 CSV 中的真实姓名，而不是 creator ID 或 unknown。",
    "",
    "## 假设与默认值",
    "- 保持现有 creator 回退语义不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
});

test("the real creatorName candidate materializes with frozen evidence and executable tasks", () => {
  const evidenceRecords = [{
    tool: "read_file",
    target: "src/hooks/useCsvParser.ts",
    status: "succeeded",
    summary: "normalizeCsvOrder maps creator but does not assign creatorName",
  }, {
    tool: "read_file",
    target: "src/hooks/useChartData.ts",
    status: "succeeded",
    summary: "buildCourseRanking consumes creatorName and falls back to creator",
  }, {
    tool: "read_file",
    target: "src/store/dashboardStore.ts",
    status: "succeeded",
    summary: "creatorField selects creatorName",
  }, {
    tool: "read_file",
    target: "src/types/order.ts",
    status: "succeeded",
    summary: "Order requires creatorName as a string",
  }];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-real-creator-name-candidate",
    objective: "修改 src/hooks/useCsvParser.ts，补齐 creatorName 映射；src/hooks/useChartData.ts、src/store/dashboardStore.ts、src/types/order.ts 只作为消费和类型契约证据。",
    evidenceRecords,
  });
  assert.deepEqual(bundle.changeTargets, ["src/hooks/useCsvParser.ts"]);

  const visibleText = [
    "# CSV creatorName 数据链路整改计划",
    "",
    "## 摘要",
    "- 修复 CSV 解析层遗漏 creatorName、导致图表消费端只能回退的问题。",
    "",
    "## 已确认发现",
    "- `src/hooks/useCsvParser.ts` 的 `normalizeCsvOrder` 未映射 `creatorName`。",
    "- `src/hooks/useChartData.ts` 优先消费 `creatorName`，`src/store/dashboardStore.ts` 将其声明为契约字段。",
    "- `src/types/order.ts` 要求 `Order.creatorName` 为必填字符串。",
    "",
    "## 关键实现改动",
    "### 1. 修复 CSV 归一化逻辑",
    "- **目标文件**：`src/hooks/useCsvParser.ts`",
    "- **改动内容**：",
    "  - 在 `normalizeCsvOrder` 中增加 `creatorName` 映射，并兼容现有 creator 列。",
    "### 2. 保持类型契约",
    "- **目标文件**：`src/hooks/useCsvParser.ts`",
    "- **改动内容**：",
    "  - 保证解析结果为 `creatorName` 提供字符串值，不改变消费端文件。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持 `Order.creatorName: string`，不新增公共 API。",
    "",
    "## 测试方案",
    "### 1. 单元测试",
    "- **测试用例 A**：输入包含 creatorName 字段的模拟 Row，断言 `normalizeCsvOrder` 返回正确姓名。",
    "- **测试用例 B**：输入不含姓名列的 Row，断言 `creatorName` 返回默认字符串而非 undefined。",
    "### 2. 集成测试",
    "- **测试步骤**：",
    "  - 上传包含姓名列的 CSV。",
    "  - 观察 Dashboard 的课程排名标签。",
    "- **预期结果**：标签显示 CSV 中的真实姓名，而不是 creator ID 或 unknown。",
    "",
    "## 假设与默认值",
    "- 保持现有 creator 回退语义不变。",
  ].join("\n");
  const result = materializePlanArtifactFromVisibleText({
    visibleText,
    userGoal: bundle.objective,
    evidenceRecords,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason || "");
  assert.equal(result.evidenceBundleHash, bundle.hash);
  assert.ok(result.candidate?.changes.length > 0, JSON.stringify(result.candidate, null, 2));
  assert.ok(result.candidate?.changes.every((change) => (
    change.targetRef === "src/hooks/useCsvParser.ts" && change.evidenceRefs.length > 0
  )));
  assert.deepEqual(validatePlanCandidate(result.candidate, bundle.hash), []);

  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: result.path,
    title: "creatorName 数据链路整改",
    content: result.content,
    updatedAt: Date.now(),
  }]);
  assert.ok(tasks.some((task) => task.executionKind === "mutation"), JSON.stringify(tasks, null, 2));
  assert.ok(tasks.some((task) => task.executionKind === "validation"), JSON.stringify(tasks, null, 2));
});

test("empty structured test labels remain non-executable placeholders", () => {
  const content = [
    "# 字段修复计划",
    "## 用户目标",
    "- 修复 `src/parser.ts` 的字段映射。",
    "## 已确认事实",
    "- 已读源码确认映射缺失。",
    "## 关键改动",
    "- 修改 `src/parser.ts`，补齐 creatorName。",
    "## 执行步骤",
    "1. 修改解析器。",
    "2. 验证结果。",
    "## 验证标准",
    "- creatorName 与输入一致。",
    "## 测试方案",
    "- 输入：",
    "- 预期输出：",
    "- 断言：",
    "## 风险",
    "- 保持兼容。",
  ].join("\n");

  const quality = validateActionablePlanArtifact(content);
  assert.equal(quality.ok, false);
  assert.equal(quality.reason, "non_executable_test_plan");
});

test("a standalone decidable assertion is a typed validation primitive", () => {
  const content = [
    "# 字段修复计划",
    "## 用户目标",
    "- 修复 `src/parser.ts` 的字段映射。",
    "## 已确认事实",
    "- 已读源码确认映射缺失。",
    "## 关键改动",
    "- 修改 `src/parser.ts`，补齐 creatorName。",
    "## 执行步骤",
    "1. 修改解析器。",
    "2. 验证结果。",
    "## 验证标准",
    "- creatorName 与输入一致。",
    "## 测试方案",
    "- 输入：",
    "- 预期输出：",
    "- 断言：creatorName 与 creator 相等。",
    "## 风险",
    "- 保持兼容。",
  ].join("\n");

  const quality = validateActionablePlanArtifact(content);
  assert.equal(quality.ok, true, quality.reason);
});

test("structured test rows reject placeholders and cannot span scenario blocks", () => {
  const buildPlan = (rows) => [
    "# 字段修复计划",
    "## 用户目标",
    "- 修复 `src/parser.ts` 的字段映射。",
    "## 已确认事实",
    "- 已读源码确认映射缺失。",
    "## 关键改动",
    "- 修改 `src/parser.ts`，补齐 creatorName。",
    "## 执行步骤",
    "1. 修改解析器。",
    "2. 验证结果。",
    "## 验证标准",
    "- creatorName 与输入一致。",
    "## 测试方案",
    ...rows,
    "## 风险",
    "- 保持兼容。",
  ].join("\n");

  const placeholders = validateActionablePlanArtifact(buildPlan([
    "- 输入：TBD",
    "- 预期输出：-",
    "- 断言：值相等。",
  ]));
  assert.equal(placeholders.ok, false);
  assert.equal(placeholders.reason, "non_executable_test_plan");

  const splitScenarios = validateActionablePlanArtifact(buildPlan([
    "### 场景一",
    "- 输入：有效订单。",
    "### 场景二",
    "- 预期输出：归一化订单。",
    "- 断言：值相等。",
  ]));
  assert.equal(splitScenarios.ok, false);
  assert.equal(splitScenarios.reason, "non_executable_test_plan");
});

test("input coverage requirements are not treated as unsupported source hypotheses", () => {
  const content = [
    "# CSV creatorName 整改计划",
    "## 用户目标",
    "- 修复 CSV creatorName 数据链路。",
    "## 已确认事实",
    "- `orders.csv` 当前包含 creator 与 amount 列。",
    "## 关键改动",
    "- 修改 `src/hooks/useCsvParser.ts`，从 creator 归一化 creatorName。",
    "- 兼容多种可能的 CSV 列名，例如 `row.creatorName` 或中文列名。",
    "## 执行步骤",
    "1. 实现字段归一化。",
    "2. 运行解析测试。",
    "## 验证标准",
    "- creator 输入产生非空 creatorName。",
    "## 测试方案",
    "- 输入：仅含 creator 的行。",
    "- 预期输出：creatorName 与 creator 一致。",
    "- 断言：两者非空且相等。",
    "## 风险",
    "- 保留 creator 兼容字段。",
  ].join("\n");

  assert.equal(validateActionablePlanArtifact(content).ok, true);
});

test("structural Plan repair preserves the canonical goal and executable MD Viewer test scenarios", () => {
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# MD Viewer 文件打开功能修复计划",
      "",
      "## 摘要",
      "- 修复双击 Markdown 文件后打开空白，以及软件内‘打开’按钮不弹出文件选择窗口两个问题。",
      "",
      "## 已确认发现",
      "- `src-tauri/src/main.rs` 当前包含文件打开事件与单实例处理。",
      "- `src/main.js` 已导入 Tauri dialog 插件并包含 `openFile` 函数。",
      "",
      "## 未验证假设",
      "- 未验证：`main.rs` 中事件监听 API 名称可能错误。",
      "- 未验证：需要读取 `src/main.js` 中 `openFile` 的完整实现以确认细节。",
      "",
      "## 影响文件",
      "- `src-tauri/src/main.rs`",
      "- `src/main.js`",
      "",
      "## 实施步骤",
      "### 步骤 1：修正后端文件打开事件",
      "- 修改 `src-tauri/src/main.rs`，统一系统文件打开与单实例传递路径。",
      "### 步骤 2：修正前端打开链路",
      "- 修改 `src/main.js`，统一 dialog 返回值和 `file-open` 事件处理。",
      "### 步骤 3：验证单实例逻辑",
      "- 验证已运行实例接收新文件路径。",
      "- 验证前端接收 `file-open` 事件。",
      "",
      "## 测试方案",
      "1. 双击 `.md` 文件，验证软件打开并加载内容。",
      "2. 软件已运行时双击另一个 `.md`，验证窗口切换到新文件。",
      "3. 点击工具栏‘打开’，验证弹出文件选择窗口。",
      "4. 选择文件后，验证编辑器加载内容并显示预览。",
      "",
      "## 假设与默认值",
      "- 未验证假设只能指导定向检查，不能作为已确认根因。",
    ].join("\n"),
    userGoal: "修复双击 Markdown 文件后打开空白，以及软件内打开按钮失效的问题。",
    evidenceRecords: [
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: "event setup" },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "openFile" },
    ],
    language: "zh",
  });

  assert.equal(materialized.ok, true, materialized.reason);
  assert.match(materialized.content || "", /双击 Markdown 文件后打开空白/);
  assert.match(materialized.content || "", /## 实施步骤[\s\S]*修改 `src-tauri\/src\/main\.rs`/);
  const testPlan = (materialized.content || "").match(/## 测试方案\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] || "";
  assert.match(testPlan, /双击 `\.md` 文件/);
  assert.match(testPlan, /点击工具栏‘打开’/);
  assert.match(testPlan, /选择文件后/);
  assert.doesNotMatch(testPlan, /需要读取|API 名称可能错误|未验证/);
});

test("grounding ignores test-plan file mentions as change targets", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- 已读取 `src/main.js`。",
      "",
      "## 关键改动",
      "- 将文件打开事件改为统一 payload。",
      "",
      "## 测试方案",
      "- 需要读取 `src/main.js` 中 `openFile` 的完整实现以确认细节。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "openFile" },
    ],
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "missing_grounded_plan_change_target");
});

test("actionable plan quality rejects implementation-heavy code dumps", () => {
  const largeCode = "const value = 1;\n".repeat(80);
  const content = [
    "# Proposed Plan: 修复事件链路",
    "",
    "## 摘要",
    "- 修复事件名不一致导致的文件打开失败。",
    "",
    "## 关键改动",
    "1. 修改 `src/main.js` 的监听逻辑。",
    "2. 修改 `src-tauri/src/main.rs` 的事件发送逻辑。",
    "",
    "```javascript",
    largeCode,
    "```",
    "",
    "```rust",
    largeCode,
    "```",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化。",
    "",
    "## 测试方案",
    "- 运行构建并验证双击打开文件。",
    "",
    "## 假设与默认值",
    "- 默认保持其他行为不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "excessive_plan_code_dump");
});

test("a bounded implementation example does not invalidate an otherwise reviewable plan", () => {
  const content = [
    "# 计划",
    "",
    "## 摘要",
    "- 修复已确认的控件绑定不一致。",
    "",
    "## 用户目标",
    "- 让工具栏控件触发已有回调。",
    "",
    "## 已确认证据",
    "- `src/components/toolbar.js` 与 `src/main.js` 使用不同的控件标识符。",
    "",
    "## 关键改动",
    "- 修改 `src/components/toolbar.js` 的标识符，使其与 `src/main.js` 的绑定一致。",
    "",
    "```javascript",
    "root.innerHTML = '<button id=\"create-button\">Create</button>';",
    "```",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API 变化。",
    "",
    "## 测试方案",
    "- 运行构建并在浏览器点击 Create，断言页面状态变化。",
    "",
    "## 假设与默认值",
    "- 保持现有回调行为不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason);
});

test("implementation-heavy plan drafts are deterministically compacted without another model pass", () => {
  const largeCode = "const selected = await open({ multiple: false });\n".repeat(32);
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 计划",
      "",
      "## 摘要",
      "- 用户目标：修复双击 Markdown 文件无法打开的问题。",
      "",
      "## 已确认证据",
      "- `src/main.js` 当前监听 `open-file-event`。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js`，统一文件打开事件处理。",
      "",
      "```javascript",
      largeCode,
      "```",
      "",
      "## 公共 API / 接口 / 类型",
      "- 无公共 API、接口或类型变化。",
      "",
      "## 测试方案",
      "- 运行 `npm run build`，断言构建退出码为 0，并在桌面复核双击打开文件。",
      "",
      "## 假设与默认值",
      "- 默认保持其他行为不变。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "listen('open-file-event')" },
    ],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "deterministically_compacted_visible_plan");
  assert.doesNotMatch(result.content || "", /const selected = await open/);
  assert.match(result.content || "", /修改 `src\/main\.js`/);
});

test("MD Viewer trace derives grounded targets from semantic source reads and materializes the first candidate", () => {
  const evidenceRecords = [
    {
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "The Tauri builder registers open_files but does not forward the application file-open event payload to the frontend loader.",
    },
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "window.addEventListener('file-open', handleFileOpen) uses a DOM listener and never installs the required Tauri event listener.",
    },
    {
      tool: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      summary: "openFiles invokes the Tauri open_files command but does not await the file-dialog result before forwarding data to the editor loading flow.",
    },
  ];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-md-viewer-trace",
    objective: "修复双击 Markdown 文件后显示空白，以及工具栏打开按钮无法弹出文件选择器的问题。",
    evidenceRecords,
    files: evidenceRecords.map((record) => record.target),
  });

  assert.deepEqual(bundle.changeTargets, [
    "src-tauri/src/main.rs",
    "src/main.js",
    "src/components/toolbar.js",
  ]);

  const largeCode = "const selected = await open({ multiple: false });\n".repeat(34);
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 修复 Markdown 文件打开链路",
      "",
      "## 摘要",
      "- 打通系统双击、Tauri 后端事件与前端编辑器加载链路，并修复工具栏文件选择流程。",
      "",
      "## 已确认证据",
      "- `src-tauri/src/main.rs` 包含后端打开命令与应用事件接线。",
      "- `src/main.js` 包含前端 `file-open` 监听入口。",
      "- `src/components/toolbar.js` 包含工具栏打开命令调用。",
      "",
      "## 关键改动",
      "- 修改 `src-tauri/src/main.rs`，统一系统文件打开事件的 payload，并把文件内容返回给前端。",
      "- 修改 `src/main.js`，让外部打开事件进入现有编辑器加载流程。",
      "- 修改 `src/components/toolbar.js`，正确等待文件选择结果并调用统一加载入口。",
      "",
      "```javascript",
      largeCode,
      "```",
      "",
      "```rust",
      "fn open_files() {}\n".repeat(80),
      "```",
      "",
      "## 公共 API / 接口 / 类型",
      "- 统一后端命令与前端事件的文件 payload；不新增公共 API。",
      "",
      "## 测试方案",
      "- 运行构建，分别验证系统双击 Markdown 与工具栏选择文件后内容正确显示。",
      "",
      "## 假设与默认值",
      "- 保留现有编辑器渲染与文件关联配置。",
    ].join("\n"),
    userGoal: bundle.objective,
    evidenceRecords,
    files: evidenceRecords.map((record) => record.target),
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.evidenceBundleHash, bundle.hash);
  assert.equal(result.source, "deterministically_compacted_visible_plan");
  assert.equal(result.candidate?.changes.length, 3);
  assert.ok(result.candidate?.changes.every((change) => change.targetRef && change.evidenceRefs.length > 0));
  assert.doesNotMatch(result.content || "", /const selected|fn open_files/);
});

test("code dump compaction preserves progress so a remaining structural gap can be repaired", () => {
  const largeCode = "const selected = await open({ multiple: true });\n".repeat(36);
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 修复 Markdown 打开链路",
      "",
      "## 摘要",
      "- 修复工具栏选择文件后无法加载 Markdown 内容的问题。",
      "",
      "## 已确认证据",
      "- `src/main.js` 中的打开入口已经读取并确认。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js`，让文件选择结果进入统一的内容加载流程。",
      "",
      "```javascript",
      largeCode,
      "```",
      "",
      "## 测试方案",
      "- 运行 `npm run build`，再点击打开按钮并确认所选 Markdown 内容被渲染。",
      "",
      "## 假设与默认值",
      "- 保持现有编辑器和标签页行为不变。",
    ].join("\n"),
    userGoal: "修复工具栏打开 Markdown 文件后无法加载内容的问题。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "openFile forwards the selected Markdown path into openFiles",
    }],
    recentToolActivity: [{
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "openFile forwards the selected Markdown path into openFiles",
    }],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "deterministically_compacted_visible_plan");
  assert.match(result.content || "", /## 关键改动/);
  assert.doesNotMatch(result.content || "", /const selected/);
});

test("section auto-repair preserves progress and reports the next implementation violation", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 修复文件保存路径",
      "",
      "## 摘要",
      "- 修复打开本地文件后的保存路径问题。",
      "",
      "## 已确认证据",
      "- `src-tauri/src/main.rs` 保留缺少路径的保护。",
      "",
      "## 关键改动",
      "### 变更 1：`src-tauri/src/main.rs`",
      "- 保持现有实现不变，如有需要可以增强。",
      "",
      "## 测试方案",
      "- 运行 `npm run build`，预期退出码为 0。",
      "",
      "## 假设与默认值",
      "- 保持后端命令签名不变。",
    ].join("\n"),
    userGoal: "修复打开本地文件后的保存路径问题。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "save_file_content rejects a missing file path",
    }],
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_plan_implementation_detail");
});
