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

const { materializePlanArtifactFromVisibleText } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planMaterialization.ts"),
);

test("materializes valid visible design text into design.md artifact", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## 用户目标与约束",
      "- 修复 MAIN Plan 模式闭环，让复杂实现请求生成可审批计划文件。",
      "- 批准前不修改源码交付物，只允许写入 `.MAIN/plans/design.md`。",
      "",
      "## 当前状态发现",
      "- 现有流程能解析部分工具调用，但普通 Markdown 方案不会同步到 PlanPanel。",
      "- 本地模型偶尔返回伪工具或空响应，需要可恢复检查点。",
      "",
      "## 拟定方案",
      "- 在编排层增加 materialization guard，从可见 Markdown 中生成正式 design artifact。",
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
      "- LLM 输出先归一化，再判断工具调用；没有工具但存在有效方案时写入设计文件。",
      "- 写入成功后刷新 PlanPanel，并进入 pending_review。",
      "",
      "## 风险取舍",
      "- 低质量内容必须被质量门禁拦截，避免把闲聊误写成计划。",
      "- 只允许 design 自动物化，避免越权写源码。",
      "",
      "## 验证方式",
      "- 增加 Node 单测覆盖解析、清洗、提示词和计划物化。",
      "- 通过 E2E 复现空响应与伪工具链路。",
      "",
      "## 开放问题",
      "- 是否需要为更多本地模型格式继续扩展兼容。",
    ].join("\n"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "design");
  assert.equal(result.path, ".MAIN/plans/design.md");
  assert.match(result.content || "", /^# Proposed Plan/);
});

test("rejects low quality visible text instead of materializing a plan", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: "好的，我会继续处理这个问题，稍后给出计划。",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /too_short|not_structured|quality_gate/);
});
