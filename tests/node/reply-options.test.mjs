import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

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
  transpiledModuleCache.set(normalizedPath, module.exports);

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
  buildReadOnlyPermissionContinuationPrompt,
  extractReplyOptions,
  serializeAssistantReplyForHistory,
  shouldAutoContinueReadOnlyPermission,
  shouldPauseForReplyOptions,
  stripReadOnlyPermissionPrompt,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/replyOptions.ts"));

test("shouldPauseForReplyOptions pauses when the model asks the user to choose", () => {
  const shouldPause = shouldPauseForReplyOptions({
    replyOptions: [
      { label: "先做数据分析", value: "先做数据分析" },
      { label: "直接开始开发", value: "直接开始开发" },
    ],
    toolCallCount: 0,
    workflowMode: "plan",
    hasStructuredProposal: false,
    hasReadyPlanArtifacts: false,
    isPlanApproved: false,
  });

  assert.equal(shouldPause, true);
});

test("shouldPauseForReplyOptions does not override plan approval or tool execution", () => {
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [{ label: "方案 A", value: "方案 A" }],
      toolCallCount: 1,
      workflowMode: "edit",
    }),
    false,
  );

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [{ label: "批准执行", value: "批准执行" }],
      toolCallCount: 0,
      workflowMode: "plan",
      hasStructuredProposal: true,
      hasReadyPlanArtifacts: true,
      isPlanApproved: false,
    }),
    false,
  );
});

test("serializeAssistantReplyForHistory keeps the visible question and options together", () => {
  const historyText = serializeAssistantReplyForHistory("请确认下一步方向。", [
    { label: "先做数据分析", value: "先做数据分析" },
    { label: "直接进入软件开发", value: "直接进入软件开发" },
  ]);

  assert.match(historyText, /请确认下一步方向/);
  assert.match(historyText, /User choices:/);
  assert.match(historyText, /1\. 先做数据分析/);
  assert.match(historyText, /2\. 直接进入软件开发/);
});

test("extractReplyOptions infers enumerated markdown choices after a decision cue", () => {
  const result = extractReplyOptions(`
请从下面几种继续方式里选一个：

1. 先做数据清洗
2. 先搭建聚类特征
3. 先只输出分析方案
  `);

  assert.equal(result.replyOptions.length, 3);
  assert.deepEqual(
    result.replyOptions.map((option) => option.value),
    ["先做数据清洗", "先搭建聚类特征", "先只输出分析方案"],
  );
});

test("extractReplyOptions infers binary choices from plain-language clarification prompts", () => {
  const result = extractReplyOptions(`
请您确认以下关键点，以便我能进入下一步的执行阶段：

1. 统一标识符：我们是否可以确定所有四份数据中存在一个可唯一映射的、跨文件的用户ID？
2. RFM 模型构建：我们是否需要基于购买数据来定义 T、F 和 M？

一旦这些基础映射和特征定义敲定，我就可以开始执行数据清洗和特征向量化。请告诉我您对数据ID映射和特征集定义的看法，或者您是否希望我根据我的经验，先假设一个映射关系并开始构建一个初步的特征集进行验证？
  `);

  assert.equal(result.replyOptions.length, 2);
  assert.equal(result.replyOptions[0].value, "我来确认数据ID映射和特征集定义");
  assert.match(result.replyOptions[1].value, /^请根据你的经验/);
});

test("extractReplyOptions avoids malformed buttons from numbered binary question lists", () => {
  const result = extractReplyOptions(`
需要用户拍板的选项：

1. 是否使用现有的事件系统架构，还是改用更简洁的委托方式？
2. 是否需要在UI层使用MVVM模式，还是直接使用事件驱动？
3. 是否需要支持多人联机战斗，还是仅本地单人战斗？
  `);

  assert.equal(result.replyOptions.length, 0);
  assert.match(result.cleanText, /是否使用现有的事件系统架构/);
});

test("extractReplyOptions normalizes single binary choices to user-clickable actions", () => {
  const result = extractReplyOptions(`
你想让我使用现有事件系统，还是改用更简洁的委托方式？
  `);

  assert.deepEqual(
    result.replyOptions.map((option) => option.value),
    ["使用现有事件系统", "改用更简洁的委托方式"],
  );
});

test("extractReplyOptions converts Gemma-style read-only permission prompts into action options", () => {
  const result = extractReplyOptions(`
下一步我建议读取 BaseCombatCommand.cs 来确认命令实现。

请问您是否同意我读取 \`BaseCombatCommand.cs\` 的内容？
  `);

  assert.equal(result.replyOptions.length, 2);
  assert.equal(result.replyOptions[0].action, "continue_readonly_once");
  assert.equal(result.replyOptions[1].action, "allow_readonly_session");
  assert.match(result.replyOptions[0].label, /继续读取 BaseCombatCommand\.cs/);
  assert.match(result.replyOptions[1].value, /本会话只读读取、搜索和分析步骤全部允许/);
});

test("read-only auto approval strips repeated permission prompts and builds continuation", () => {
  const result = extractReplyOptions("请问是否同意我下一步分析 `CombatUnit.cs` 的内容？");

  assert.equal(
    shouldAutoContinueReadOnlyPermission({
      replyOptions: result.replyOptions,
      readOnlyAutoApproveForSession: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoContinueReadOnlyPermission({
      replyOptions: result.replyOptions,
      readOnlyAutoApproveForSession: false,
    }),
    false,
  );
  assert.equal(
    stripReadOnlyPermissionPrompt("我已经完成上一段分析。\n\n请问是否同意我下一步分析 `CombatUnit.cs` 的内容？"),
    "我已经完成上一段分析。",
  );
  assert.match(buildReadOnlyPermissionContinuationPrompt("zh"), /不要再询问是否同意/);
  assert.match(buildReadOnlyPermissionContinuationPrompt("zh"), /read_file/);
});
