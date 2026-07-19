import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  const source = fs.readFileSync(normalizedPath, "utf8");
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
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  sanitizeRestoredPlanArtifacts,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planArtifactRestore.ts"));
const {
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

function buildActionablePlan() {
  return [
    "# Plan 恢复边界整改",
    "",
    "## 用户目标",
    "- 恢复会话时只保留通过当前质量门禁的未批准计划。",
    "",
    "## 摘要",
    "- 将持久化 Plan 恢复约束到可执行、可审查的内容。",
    "- 已读取 `src/lib/planArtifactRestore.ts`，确认未批准计划会重新经过 actionable gate。",
    "",
    "## 已读证据",
    "- `src/lib/planArtifactRestore.ts`：未批准 plan.md 使用 `validateActionablePlanArtifact` 校验。",
    "",
    "## 关键改动",
    "- 修改 `src/lib/planArtifactRestore.ts`：拒绝缺少已读依据或把假设写成事实的未批准计划。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持现有 PlanArtifact 持久化结构不变。",
    "",
    "## 执行步骤",
    "1. 规范化持久化 artifact 的路径、内容和 revision。",
    "2. 对未批准 plan.md 应用当前 actionable quality gate。",
    "3. 仅把通过校验的 artifact 投影回运行时。",
    "",
    "## 验证标准",
    "- 未批准的可靠计划可恢复，未经证实的草稿不可恢复。",
    "",
    "## 测试方案",
    "- 运行 `node --test tests/node/plan-artifact-restore.test.mjs`。",
    "",
    "## 假设与默认值",
    "- 已批准的旧计划只要求保持结构有效，以便跨版本继续执行。",
    "",
  ].join("\n");
}

function buildUnsupportedHypothesisPlan() {
  return [
    "# MD Viewer 文件打开修复计划",
    "",
    "## 用户目标",
    "- 修复双击 Markdown 文件后窗口空白和工具栏打开按钮无效的问题。",
    "",
    "## 摘要",
    "- 已读取 `src-tauri/src/main.rs`、`src/main.js` 和 `src/components/toolbar.js`，准备连接文件打开链路。",
    "",
    "## 关键改动",
    "- 在 `src-tauri/src/main.rs` 中将解析后的文件路径发送给前端。",
    "- `src/main.js` 可能需要新增 `open-file` 事件监听器后再调用现有加载入口。",
    "- 在 `src/components/toolbar.js` 中等待 dialog Promise 完成后传入文件路径。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持现有 `open-file` 事件名称和文件路径载荷类型不变。",
    "",
    "## 执行步骤",
    "1. 先补齐 Rust 文件打开事件发送。",
    "2. 再连接前端事件监听与 dialog 异步返回值。",
    "",
    "## 验证标准",
    "- 双击 Markdown 文件和点击打开按钮都能加载同一文件内容。",
    "",
    "## 测试方案",
    "- 运行 `cargo check`，再分别验证双击文件与文件选择器。",
    "",
    "## 假设与默认值",
    "- 默认保持当前 Tauri 事件名称和 Markdown 扩展名过滤规则。",
    "",
  ].join("\n");
}

function artifact(content, overrides = {}) {
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    revision: 3,
    updatedAt: 100,
    ...overrides,
  };
}

test("restore retains an unapproved actionable Plan artifact", () => {
  const content = buildActionablePlan();
  assert.equal(validateActionablePlanArtifact(content).ok, true);

  const restored = sanitizeRestoredPlanArtifacts({
    artifacts: [artifact(content)],
    isPlanApproved: false,
  });

  assert.equal(restored.artifacts.length, 1);
  assert.equal(restored.artifacts[0].content, content.trim());
  assert.equal(restored.artifacts[0].revision, 3);
  assert.deepEqual(restored.rejected, []);
});

test("restore rejects an unapproved Plan built on an unsupported hypothesis", () => {
  const content = buildUnsupportedHypothesisPlan();
  const structural = validatePlanArtifactContent(content, "plan");
  const actionable = validateActionablePlanArtifact(content);
  assert.equal(structural.ok, true, "fixture must be a structurally valid legacy Plan");
  assert.equal(actionable.ok, false);
  assert.equal(actionable.reason, "unsupported_hypothesis_as_plan");

  const restored = sanitizeRestoredPlanArtifacts({
    artifacts: [artifact(content)],
    isPlanApproved: false,
  });

  assert.deepEqual(restored.artifacts, []);
  assert.deepEqual(restored.rejected, [{
    path: ".MAIN/plans/plan.md",
    kind: "plan",
    reason: "unsupported_hypothesis_as_plan",
  }]);
});

test("current-state evidence may describe a possible risk without becoming a speculative change", () => {
  const content = buildActionablePlan().replace(
    "## 关键改动",
    [
      "## 现状分析 (Evidence Bundle)",
      "- `src/lib/planArtifactRestore.ts` 的旧恢复路径可能导致未经校验的草稿进入候选区；此项是风险描述，不是未经证实的实现承诺。",
      "",
      "## 关键改动",
    ].join("\n"),
  );
  const quality = validateActionablePlanArtifact(content);
  assert.equal(quality.ok, true, quality.reason || "evidence risk should remain reviewable");
});

test("restore retains an invalid approved Plan only as an audit record and revokes approval", () => {
  const content = buildUnsupportedHypothesisPlan();
  assert.equal(validatePlanArtifactContent(content, "plan").ok, true);
  assert.equal(validateActionablePlanArtifact(content).ok, false);

  const restored = sanitizeRestoredPlanArtifacts({
    artifacts: [artifact(content, { revision: 2 })],
    isPlanApproved: true,
  });

  assert.equal(restored.artifacts.length, 1);
  assert.equal(restored.artifacts[0].content, content.trim());
  assert.equal(restored.artifacts[0].revision, 2);
  assert.deepEqual(restored.rejected, [{
    path: ".MAIN/plans/plan.md",
    kind: "plan",
    reason: "unsupported_hypothesis_as_plan",
  }]);
});

test("restore rejects a Plan artifact outside the canonical .MAIN/plans paths", () => {
  const content = buildActionablePlan();
  assert.equal(validateActionablePlanArtifact(content).ok, true);

  const restored = sanitizeRestoredPlanArtifacts({
    artifacts: [artifact(content, { path: "notes/plan.md" })],
    isPlanApproved: false,
  });

  assert.deepEqual(restored.artifacts, []);
  assert.deepEqual(restored.rejected, [{
    path: "notes/plan.md",
    kind: "plan",
    reason: "invalid_artifact_identity",
  }]);
});

test("restore does not revive an older valid artifact behind a newer invalid duplicate", () => {
  const validContent = buildActionablePlan();
  const invalidContent = buildUnsupportedHypothesisPlan();
  assert.equal(validateActionablePlanArtifact(validContent).ok, true);
  assert.equal(validateActionablePlanArtifact(invalidContent).ok, false);

  const restored = sanitizeRestoredPlanArtifacts({
    artifacts: [
      artifact(validContent, { revision: 1, updatedAt: 100 }),
      artifact(invalidContent, { revision: 2, updatedAt: 200 }),
    ],
    isPlanApproved: false,
  });

  assert.deepEqual(restored.artifacts, []);
  assert.deepEqual(restored.rejected, [
    {
      path: ".MAIN/plans/plan.md",
      kind: "plan",
      reason: "unsupported_hypothesis_as_plan",
    },
    {
      path: ".MAIN/plans/plan.md",
      kind: "plan",
      reason: "duplicate_artifact_path",
    },
  ]);
});
