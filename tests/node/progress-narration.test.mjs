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
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);

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
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return loadTranspiledModuleSync(candidate);
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
  buildToolProgressNarration,
  progressNarrationToText,
  summarizeToolObservation,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/progressNarration.ts"));
const {
  deriveToolIntentSummary,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolPresentation.ts"));

test("read_file narration explains why the file is read", () => {
  const progress = buildToolProgressNarration({
    toolName: "read_file",
    target: "src/components/ChatArea.tsx",
    language: "zh",
    userGoal: "优化 ChatArea 的 agent 操作过程展示",
    currentHypothesis: "可能是 hiddenProcess 导致公开说明不可见。",
  });

  assert.equal(progress.phase, "investigating");
  assert.match(progress.title, /读取 ChatArea 渲染逻辑/);
  assert.match(progress.why, /hiddenProcess/);
  assert.match(progress.why, /代码证据|确认/);
  assert.match(progress.evidence, /等待返回内容|搜索命中|元数据/);
});

test("replace_in_file narration explains why and what is being changed", () => {
  const progress = buildToolProgressNarration({
    toolName: "replace_in_file",
    target: "src/store/useAppStore.ts",
    language: "zh",
    userGoal: "公开进度说明不能被 hiddenProcess 吞掉",
    previousObservation: "onAssistantFinalText 会把 hasToolCalls 文本隐藏。",
  });

  assert.equal(progress.phase, "editing");
  assert.match(progress.title, /修改消息状态与可见性逻辑/);
  assert.match(progress.why, /用户目标|具体改动/);
  assert.match(progress.evidence, /diff|写入结果/);
});

test("run_command npm build narration explains verification criteria", () => {
  const progress = buildToolProgressNarration({
    toolName: "run_command",
    target: "npm run build",
    language: "zh",
    userGoal: "确认进度展示改动没有破坏构建",
  });

  assert.equal(progress.phase, "verifying");
  assert.match(progress.title, /验证命令/);
  assert.match(progress.why, /退出码为 0/);
  assert.match(progress.evidence, /stdout\/stderr|退出码/);
  assert.match(progress.next, /验证结果/);
});

test("runtime progress narration does not echo prior progress or control tokens", () => {
  const progress = buildToolProgressNarration({
    toolName: "read_file",
    target: "src/store/dashboardStore.ts",
    language: "zh",
    currentHypothesis: "正在读取 src/store/dashboardStore.ts。 thought 因此先检查 src/store/dashboardStore.ts，确认是否有代码证据。",
  });
  const text = progressNarrationToText(progress, "zh");

  assert.doesNotMatch(progress.why, /thought|因为：|因此先检查/);
  assert.doesNotMatch(text, /thought|因为：/);
  assert.match(text, /正在读取|等待返回内容/);
});

test("contextual tool intent names the target role and hypothesis", () => {
  const summary = deriveToolIntentSummary({
    toolName: "read_file",
    target: "src/components/ChatArea.tsx",
    language: "zh",
    currentHypothesis: "hiddenProcess 让公开进度说明不可见",
  });

  assert.match(summary, /读取 ChatArea 渲染逻辑/);
  assert.match(summary, /hiddenProcess/);
  assert.notEqual(summary, "读取目标内容，确认实现细节。");
});

test("tool observation summarizes hiddenProcess evidence", () => {
  const summary = summarizeToolObservation({
    toolName: "read_file",
    target: "src/components/ChatArea.tsx",
    result: "if (block.hiddenProcess && !block.streaming) return null;",
    language: "zh",
  });

  assert.match(summary, /ChatArea 渲染逻辑/);
  assert.match(summary, /hiddenProcess/);
});
