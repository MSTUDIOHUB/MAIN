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

const { ensureVisibleConclusion, isAssistantTurnEmpty, isSyntheticVisibleConclusion, normalizeAssistantTurn } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/normalizedTurn.ts"),
);

test("assistant turn empty guard matches truly empty responses", () => {
  assert.equal(
    isAssistantTurnEmpty({
      visibleText: "",
      hiddenThought: "",
      replyOptions: [],
      toolCalls: [],
    }),
    true,
  );
});

test("assistant turn empty guard ignores tool-only and text responses", () => {
  assert.equal(
    isAssistantTurnEmpty({
      visibleText: "",
      hiddenThought: "",
      replyOptions: [],
      toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}", source: "text" }],
    }),
    false,
  );

  assert.equal(
    isAssistantTurnEmpty({
      visibleText: "这里是可见正文",
      hiddenThought: "",
      replyOptions: [],
      toolCalls: [],
    }),
    false,
  );
});

test("hidden-thought placeholder is marked as synthetic", () => {
  const normalized = ensureVisibleConclusion({
    visibleText: "",
    hiddenThought: "我已经检查了上下文，需要给出结论。",
    replyOptions: [],
    toolCalls: [],
    finishReason: "stop",
  });

  assert.equal(isSyntheticVisibleConclusion(normalized.visibleText), true);
  assert.equal(isAssistantTurnEmpty(normalized), false);
});

test("normalization collapses repeated local-model preamble loops", () => {
  const repeated = [
    "让我开始实现。",
    "首先，我需要创建BattleUnit.cs - 战斗单位类",
    "然后，我需要修复现有代码中的问题。",
    "让我开始实现。",
    "首先，我需要创建BattleUnit.cs - 战斗单位类",
    "然后，我需要修复现有代码中的问题。",
    "让我开始实现。",
    "首先，我需要创建BattleUnit.cs - 战斗单位类",
    "然后，我需要修复现有代码中的问题。",
    "<tool_use>",
    "<tool>get_project_skeleton</tool>",
    "<parameter name=\"depth\">3</parameter>",
    "</tool_use>",
  ].join("\n\n");

  const normalized = normalizeAssistantTurn({
    content: repeated,
    toolCalls: [],
    finishReason: "tool_calls",
  });

  assert.equal(
    normalized.visibleText,
    [
      "让我开始实现。",
      "首先，我需要创建BattleUnit.cs - 战斗单位类",
      "然后，我需要修复现有代码中的问题。",
    ].join("\n\n"),
  );
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].name, "get_project_skeleton");
});

test("normalization hides leaked reasoning after a user-choice section", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "已有 BattleSceneConfigSO.cs 场景配置。",
      "",
      "需要用户拍板的选项：",
      "",
      "1. 是否使用现有的事件系统架构，还是改用更简洁的委托方式？",
      "2. 是否需要在UI层使用MVVM模式，还是直接使用事件驱动？",
      "3. 是否需要支持多人联机战斗，还是仅本地单人战斗？",
      "",
      "让我输出这些要点和选项，然后停止。",
      "",
      "但是等等，用户说“不要询问用户指示，你自己做决定并执行”。",
      "",
      "我认为最合理的解释是：用户希望我继续执行计划，但是对于架构层面的分叉，需要先问用户。",
    ].join("\n"),
    toolCalls: [],
    finishReason: "stop",
  });

  assert.match(normalized.visibleText, /需要用户拍板的选项/);
  assert.match(normalized.visibleText, /是否使用现有的事件系统架构/);
  assert.doesNotMatch(normalized.visibleText, /但是等等/);
  assert.doesNotMatch(normalized.visibleText, /不要询问用户指示/);
  assert.match(normalized.hiddenThought, /不要询问用户指示/);
  assert.equal(normalized.replyOptions.length, 0);
});

test("normalization collapses repeated hidden reasoning loops", () => {
  const repeatedThought = [
    "让我重新理解：用户可能是在说，对于技术实现细节，我应该自己决定。",
    "但是对于架构层面的分叉，还是需要问用户。",
    "让我重新理解：用户可能是在说，对于技术实现细节，我应该自己决定。",
    "但是对于架构层面的分叉，还是需要问用户。",
    "让我重新理解：用户可能是在说，对于技术实现细节，我应该自己决定。",
    "但是对于架构层面的分叉，还是需要问用户。",
  ].join("\n\n");

  const normalized = normalizeAssistantTurn({
    content: `<thinking>${repeatedThought}</thinking>\n\n最终结论：先生成计划草稿。`,
    toolCalls: [],
    finishReason: "stop",
  });

  assert.equal(
    normalized.hiddenThought,
    [
      "让我重新理解：用户可能是在说，对于技术实现细节，我应该自己决定。",
      "但是对于架构层面的分叉，还是需要问用户。",
    ].join("\n\n"),
  );
  assert.match(normalized.visibleText, /最终结论/);
});

test("normalization treats native user_options calls as UI choices, not executable tools", () => {
  const normalized = normalizeAssistantTurn({
    content: "我需要你确认下一步范围。",
    toolCalls: [
      {
        index: 0,
        id: "call_user_options",
        name: "user_options",
        arguments: JSON.stringify({
          options: [
            "仅创建核心模块",
            { label: "完整生成战斗系统", value: "完整生成战斗系统" },
          ],
        }),
      },
    ],
    finishReason: "tool_calls",
  });

  assert.equal(normalized.toolCalls.length, 0);
  assert.deepEqual(
    normalized.replyOptions.map((option) => option.value),
    ["仅创建核心模块", "完整生成战斗系统"],
  );
});

test("normalization ignores text tool_call user_options instead of executing it", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "我需要你确认下一步范围。",
      "<tool_call>",
      JSON.stringify({
        name: "user_options",
        arguments: { choices: ["只做 BattleUnit.cs", "继续补齐完整 CTB"] },
      }),
      "</tool_call>",
    ].join("\n"),
    toolCalls: [],
    finishReason: "tool_calls",
  });

  assert.equal(normalized.toolCalls.length, 0);
  assert.deepEqual(
    normalized.replyOptions.map((option) => option.value),
    ["只做 BattleUnit.cs", "继续补齐完整 CTB"],
  );
  assert.doesNotMatch(normalized.visibleText, /tool_call/);
});
