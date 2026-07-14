import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadModule(sourcePath) {
  const source = fsSync.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    createRequire(sourcePath),
  );
  return module.exports;
}

const { detectVisibleTextRepetition } = loadModule(
  path.join(workspaceRoot, "src/lib/visibleTextRepetition.ts"),
);

test("detects a repeated multi-sentence visible-stream cycle", () => {
  const cycle = [
    "让我开始。由于上下文摘要没有保留完整文件内容，我需要再次读取核心入口文件。",
    "首先读取 src-tauri/src/main.rs，然后读取 src/main.js，并确认当前配置文件。",
    "根据已有记忆，这些文件分别负责后端入口、前端入口和应用配置，因此需要重新检查。",
  ].join("\n");
  const result = detectVisibleTextRepetition(`${cycle}\n${cycle}\n${cycle}`);
  assert.equal(result?.repetitions, 3);
  assert.ok((result?.unitCount || 0) >= 3);
  assert.ok((result?.cycleChars || 0) >= 120);
});

test("does not classify a normal plan with distinct repeated headings as a loop", () => {
  const result = detectVisibleTextRepetition([
    "目标：修复任务执行阶段的状态转换并保留明确的恢复边界。",
    "实施：在计划阶段将缺失证据转换为受限读取，而不是关闭工具后继续提示调用工具。",
    "验证：运行针对性的状态机测试、构建检查和端到端的计划流程测试。",
    "风险：对模型的恢复次数设置通用上限，避免不断扩展读取范围。",
  ].join("\n"));
  assert.equal(result, null);
});

test("detects a long low-entropy punctuation stream before it can run indefinitely", () => {
  const result = detectVisibleTextRepetition(`Starting analysis.${"!".repeat(240)}`);
  assert.equal(result?.repetitions, 3);
  assert.equal(result?.unitCount, 1);
  assert.ok((result?.cycleChars || 0) >= 80);
});

test("does not classify punctuation-rich but meaningful output as low entropy", () => {
  const result = detectVisibleTextRepetition(Array.from(
    { length: 20 },
    (_, index) => `Step ${index + 1}: inspect file-${index}.ts, compare field_${index}, then verify result!`,
  ).join("\n"));
  assert.equal(result, null);
});
