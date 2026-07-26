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
  buildPlanReadOnlyProgressNarration,
  buildToolProgressNarration,
  progressNarrationToText,
  summarizeToolObservation,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/progressNarration.ts"));
const {
  deriveToolIntentSummary,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolPresentation.ts"));

test("read_file narration keeps the action and specific hypothesis without template filler", () => {
  const progress = buildToolProgressNarration({
    toolName: "read_file",
    target: "src/components/ChatArea.tsx",
    language: "zh",
    userGoal: "优化 ChatArea 的 agent 操作过程展示",
    currentHypothesis: "可能是 hiddenProcess 导致公开说明不可见。",
    sourceToolCallIds: ["call-read-chat-area", "call-read-chat-area"],
  });

  assert.equal(progress.phase, "investigating");
  assert.match(progress.title, /读取 ChatArea 渲染逻辑/);
  assert.match(progress.why, /hiddenProcess/);
  assert.doesNotMatch(progress.why, /代码证据|确认后再继续|等待/);
  assert.equal(progress.evidence, "");
  assert.equal(progress.next, "");
  assert.equal(progress.tool, "read_file");
  assert.equal(progress.target, "src/components/ChatArea.tsx");
  assert.equal(progress.canonicalTarget, "src/components/ChatArea.tsx");
  assert.deepEqual(progress.sourceToolCallIds, ["call-read-chat-area"]);
});

test("replace_in_file narration uses observed facts instead of generic why/evidence text", () => {
  const progress = buildToolProgressNarration({
    toolName: "replace_in_file",
    target: "src/store/useAppStore.ts",
    language: "zh",
    userGoal: "公开进度说明不能被 hiddenProcess 吞掉",
    previousObservation: "onAssistantFinalText 会把 hasToolCalls 文本隐藏。",
  });

  assert.equal(progress.phase, "editing");
  assert.match(progress.title, /修改消息状态与可见性逻辑/);
  assert.match(progress.why, /onAssistantFinalText/);
  assert.doesNotMatch(progress.why, /具体改动|负责/);
  assert.equal(progress.evidence, "");
});

test("run_command npm build narration keeps verification criteria without waiting/next templates", () => {
  const progress = buildToolProgressNarration({
    toolName: "run_command",
    target: "npm run build",
    language: "zh",
    userGoal: "确认进度展示改动没有破坏构建",
  });

  assert.equal(progress.phase, "verifying");
  assert.match(progress.title, /验证命令/);
  assert.match(progress.why, /退出码为 0/);
  assert.equal(progress.evidence, "");
  assert.equal(progress.next, "");
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
  assert.match(text, /正在读取/);
  assert.doesNotMatch(text, /等待返回内容|下一步/);
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

test("run_command observation trusts a structured zero exit over warning prose", () => {
  const summary = summarizeToolObservation({
    toolName: "run_command",
    target: "npm run build",
    result: JSON.stringify({
      exitCode: 0,
      success: true,
      stdout: "built successfully",
      stderr: "warning: an error boundary was not tree-shaken",
    }),
    language: "zh",
  });

  assert.match(summary, /已成功退出/);
  assert.doesNotMatch(summary, /失败信号/);
});

test("plan read-only narration names concrete evidence phase instead of image-count filler", () => {
  const progress = buildPlanReadOnlyProgressNarration({
    calls: [
      { name: "read_file", target: "src/store/dashboardStore.ts" },
      { name: "read_file", target: "src/hooks/useCsvParser.ts" },
      { name: "read_file", target: "src/hooks/useChartData.ts" },
    ],
    language: "zh",
    userContext: { imageParts: 2 },
  });

  assert.equal(progress.phase, "investigating");
  assert.match(progress.title, /CSV 到面板的数据链路/);
  assert.match(progress.why, /CSV 解析、Store 写入和聚合计算/);
  assert.doesNotMatch(progress.why, /用户已提供 2 张图片/);
  assert.match(progress.action, /dashboardStore\.ts/);
});

test("plan read-only narration separates dark theme grounding", () => {
  const progress = buildPlanReadOnlyProgressNarration({
    calls: [
      { name: "grep_search", target: "dark|theme|深色" },
      { name: "read_file", target: "src/index.css" },
    ],
    language: "zh",
    userContext: { imageParts: 1 },
  });

  assert.match(progress.title, /深色主题|数据与界面入口/);
  assert.doesNotMatch(progress.action, /只读探索/);
  assert.match(progress.why, /plan\.md/);
});
