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
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildAssistantStageCheckpoint,
  buildCapsuleLiveGuidance,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/assistantProgressPresentation.ts"),
);

test("ChatArea keeps concise complete findings while Capsule keeps only current intent", () => {
  const modelOutput = [
    "现在我已经读取了关键代码。让我分析两个问题的根本原因：",
    "",
    "## 问题 1：标签页重复显示",
    "根本原因：`DOMContentLoaded` 初始化会先创建一个未命名标签页，打开本地文件时 `openFiles()` 又创建第二个标签页，因此两者会同时存在。",
    "",
    "```javascript",
    "const initialFile = { path: '', title: '未命名' };",
    "activeFiles.push(initialFile);",
    "```",
    "",
    "## 问题 2：保存失败",
    "已确认保存失败来自打开对话框和保存对话框的返回值处理不一致，最终把空路径传给了后端。",
  ].join("\n");

  const checkpoint = buildAssistantStageCheckpoint(modelOutput, "zh");
  const guidance = buildCapsuleLiveGuidance(modelOutput, "zh");

  assert.match(checkpoint, /^阶段结论：/);
  assert.match(checkpoint, /根本原因：`DOMContentLoaded`/);
  assert.match(checkpoint, /已确认保存失败来自/);
  assert.doesNotMatch(checkpoint, /```|const initialFile|activeFiles\.push|让我分析/);
  assert.ok(checkpoint.length <= 680);
  assert.equal(guidance, "让我分析两个问题的根本原因：");
  assert.doesNotMatch(guidance, /DOMContentLoaded|保存失败|initialFile/);
});

test("English progress uses the same durable-versus-live boundary", () => {
  const modelOutput = [
    "I've read the relevant files. Next I'll trace why the save path disappears.",
    "Root cause: the dialog result is read through two incompatible response shapes, so the backend receives an empty path.",
    "Validation result: the focused regression test now passes.",
  ].join("\n\n");

  const checkpoint = buildAssistantStageCheckpoint(modelOutput, "en");
  const guidance = buildCapsuleLiveGuidance(modelOutput, "en");

  assert.match(checkpoint, /^Checkpoint:/);
  assert.match(checkpoint, /Root cause:/);
  assert.match(checkpoint, /Validation result:/);
  assert.equal(guidance, "Next I'll trace why the save path disappears.");
});

test("tool-only narration is not promoted to either durable content or live thought", () => {
  assert.equal(buildAssistantStageCheckpoint("让我 apply_patch 来修复：", "zh"), "");
  assert.equal(buildCapsuleLiveGuidance("让我 apply_patch 来修复：", "zh"), "");
});
