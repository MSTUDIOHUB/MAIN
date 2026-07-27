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

const { classifyAssistantCompletion, ensureVisibleConclusion, isAssistantTurnEmpty, isSyntheticVisibleConclusion, normalizeAssistantTurn } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/normalizedTurn.ts"),
);

test("completion classification keeps protocol-only and true-empty distinct from context errors", () => {
  assert.equal(classifyAssistantCompletion({ content: "", toolCalls: [], finishReason: "stop" }), "true_empty");
  assert.equal(classifyAssistantCompletion({ content: "<tool_use></tool_use>", toolCalls: [], finishReason: "stop" }), "protocol_only");
  assert.equal(classifyAssistantCompletion({ content: "", reasoningContent: "still reasoning", toolCalls: [], finishReason: "stop" }), "reasoning_only");
  assert.equal(classifyAssistantCompletion({ content: "done", toolCalls: [], finishReason: "stop" }), "content");
});

test("reserved visual metadata never normalizes into an executable workspace tool", () => {
  const normalized = normalizeAssistantTurn({
    content: "Continue with the inspected layout.",
    toolCalls: [
      {
        id: "call_visual",
        name: "MAIN_VISUAL_OBSERVATION",
        arguments: '{"turnId":"turn-1","imageCount":1,"summary":"A toolbar is visible."}',
      },
      {
        id: "call_read",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
    ],
    finishReason: "tool_calls",
  });

  assert.deepEqual(normalized.toolCalls.map((call) => call.name), ["read_file"]);
  assert.equal(normalized.visibleText, "Continue with the inspected layout.");
});

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

test("normalization keeps ordinary process narration visible", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "我需要先读取你 @ 的 CSV 文件，确认字段和订单指标。",
      "",
      "然后我会根据字段差异提出 2-3 个软件方案选项。",
    ].join("\n"),
    toolCalls: [],
    finishReason: "stop",
  });

  assert.match(normalized.visibleText, /我需要先读取/);
  assert.match(normalized.visibleText, /提出 2-3 个软件方案选项/);
  assert.equal(normalized.hiddenThought, "");
});

test("normalization hides Gemma-style bare thought prelude", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "thought 由于之前的 replace_in_file 失败（search_text 不匹配），我需要重新精确获取 filteredOrders 的源代码内容。",
      "",
      "我将通过 read_file 读取 src/store/dashboardStore.ts 的第 100 到 160 行，以获取准确的 get filteredOrders() 实现。",
    ].join("\n"),
    toolCalls: [],
    finishReason: "stop",
  });

  assert.doesNotMatch(normalized.visibleText, /^thought\b/i);
  assert.match(normalized.visibleText, /我将通过 read_file 读取/);
  assert.match(normalized.hiddenThought, /replace_in_file 失败/);
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

test("normalization keeps hidden thought out of visible text used for history", () => {
  const normalized = normalizeAssistantTurn({
    content: "<thinking>这里是不可回流给模型历史的内部推理。</thinking>\n\n可见结论：继续执行当前任务。",
    toolCalls: [],
    finishReason: "stop",
  });

  assert.match(normalized.hiddenThought, /内部推理/);
  assert.match(normalized.visibleText, /可见结论/);
  assert.doesNotMatch(normalized.visibleText, /内部推理/);
  assert.doesNotMatch(normalized.visibleText, /thinking/);
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
  assert.equal(normalized.hasExplicitUserChoiceRequest, true);
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
  assert.equal(normalized.hasExplicitUserChoiceRequest, true);
});

test("normalization rewrites native user_options model-self actions", () => {
  const normalized = normalizeAssistantTurn({
    content: "我需要你确认下一步排查方向。",
    toolCalls: [
      {
        index: 0,
        id: "call_user_options",
        name: "user_options",
        arguments: JSON.stringify({
          options: [
            "我来确认数据是否成功存入 Store",
            { label: "我来确认数据是否能从 Store 正确读取并完成计算", value: "我来确认数据是否能从 Store 正确读取并完成计算" },
          ],
        }),
      },
    ],
    finishReason: "tool_calls",
  });

  assert.deepEqual(
    normalized.replyOptions.map((option) => option.label),
    ["确认数据是否成功存入 Store", "确认数据是否能从 Store 正确读取并完成计算"],
  );
  assert.deepEqual(
    normalized.replyOptions.map((option) => option.value),
    ["请确认数据是否成功存入 Store", "请确认数据是否能从 Store 正确读取并完成计算"],
  );
});

test("normalization marks explicit <user_options> tags even when tool calls coexist", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "先确认下一步。",
      "<user_options>",
      "<option>保守推进</option>",
      "<option>立即执行</option>",
      "</user_options>",
      "<tool_use>",
      "<tool>read_file</tool>",
      "<parameter name=\"path\">README.md</parameter>",
      "</tool_use>",
    ].join("\n"),
    toolCalls: [],
    finishReason: "tool_calls",
  });

  assert.equal(normalized.hasExplicitUserChoiceRequest, true);
  assert.equal(normalized.replyOptions.length, 2);
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].name, "read_file");
});

test("normalization does not add proposal follow-up controls when explicit options exist", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "建议先修复 dashboardStore.ts 的过滤逻辑。",
      "",
      "是否开始执行这个修复方案？",
      "",
      "<user_options>",
      "<option action=\"approve_operation_once\">我来确认类型，然后执行修复</option>",
      "<option action=\"adjust_plan\">调整方案：直接尝试修复 dashboardStore.ts</option>",
      "</user_options>",
    ].join("\n"),
    toolCalls: [],
    finishReason: "stop",
  });

  assert.equal(normalized.replyOptions.length, 2);
  assert.deepEqual(
    normalized.replyOptions.map((option) => option.source),
    ["explicit_user_options", "explicit_user_options"],
  );
  assert.deepEqual(
    normalized.replyOptions.map((option) => option.action),
    ["approve_operation_once", "adjust_plan"],
  );
});

test("normalization recovers malformed tool_use without leaking XML or becoming empty", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "<tool_use>",
      "<parameter name=\"path\">/Users/michael/Desktop/DataFiles/cn_tutorial_orders_by_creator_20260512.csv</parameter>",
      "<parameter name=\"query\">SELECT DISTINCT \"课程名称\" FROM \"cn_tutorial_orders_by_creator_20260512.csv\" LIMIT 20</parameter>",
      "<parameter name=\"tool\">query_tabular_document</parameter>",
      "</tool_use>",
    ].join("\n"),
    toolCalls: [],
    finishReason: "tool_calls",
  });

  assert.equal(isAssistantTurnEmpty(normalized), false);
  assert.equal(normalized.visibleText, "");
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].name, "query_tabular_document");
  assert.deepEqual(JSON.parse(normalized.toolCalls[0].arguments), {
    path: "/Users/michael/Desktop/DataFiles/cn_tutorial_orders_by_creator_20260512.csv",
    query: "SELECT DISTINCT \"课程名称\" FROM \"cn_tutorial_orders_by_creator_20260512.csv\" LIMIT 20",
  });
  assert.doesNotMatch(normalized.visibleText, /tool_use|parameter|query_tabular_document/);
});

test("normalization keeps malformed tool protocol out of visible text", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "我先读取核心编排文件。",
      "read_file",
      "/Users/michael/Documents/GitHub/MAIN/src/lib/orchestrator.ts",
      "</parametermax_lines\">100",
    ].join("\n"),
    toolCalls: [],
    finishReason: "stop",
  });

  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].name, "read_file");
  assert.equal(normalized.visibleText, "我先读取核心编排文件。");
  assert.doesNotMatch(normalized.visibleText, /parameter|max_lines|read_file|orchestrator\.ts/);
});

test("normalization treats permission questions as text instead of pending tool review", () => {
  const normalized = normalizeAssistantTurn({
    content: [
      "我可以运行一次构建命令来确认现状吗？",
      "",
      "<tool_use>",
      "<tool>run_command</tool>",
      "<parameter name=\"command\">npm run build</parameter>",
      "<parameter name=\"cwd\">.</parameter>",
      "<parameter name=\"description\">验证当前构建状态</parameter>",
      "</tool_use>",
    ].join("\n"),
    toolCalls: [],
    finishReason: "stop",
  });

  assert.equal(normalized.toolCalls.length, 0);
  assert.equal(normalized.visibleText, "我可以运行一次构建命令来确认现状吗？");
});

test("normalization preserves native reasoningContent in hiddenThought", () => {
  const normalized = normalizeAssistantTurn({
    content: "我来做些工作。",
    toolCalls: [],
    finishReason: "stop",
    reasoningContent: "让我仔细想想接下来该干嘛...",
  });

  assert.equal(normalized.visibleText, "我来做些工作。");
  assert.equal(normalized.hiddenThought, "让我仔细想想接下来该干嘛...");
});

test("normalization does not promote a recovered reasoning mirror into visible text or tools", () => {
  const mirroredReasoning = [
    "需要继续分析。".repeat(200),
    "<tool_use>",
    "<tool>write_file</tool>",
    '<parameter name="path">src/App.tsx</parameter>',
    '<parameter name="content">hallucinated</parameter>',
    "</tool_use>",
  ].join("\n");
  const normalized = normalizeAssistantTurn({
    content: mirroredReasoning,
    semanticContent: "",
    toolCalls: [],
    finishReason: "length",
    reasoningContent: mirroredReasoning,
  });

  assert.equal(normalized.visibleText, "");
  assert.equal(normalized.toolCalls.length, 0);
  assert.match(normalized.hiddenThought, /需要继续分析/);
});

test("normalization preserves mirror-stripped XML tool protocol as actionable content", () => {
  const protocol = [
    "<tool_use>",
    "<tool>read_file</tool>",
    '<parameter name="path">src/App.tsx</parameter>',
    "</tool_use>",
  ].join("\n");
  const normalized = normalizeAssistantTurn({
    content: protocol,
    actionableContent: protocol,
    semanticContent: "",
    toolCalls: [],
    finishReason: "stop",
  });

  assert.equal(normalized.visibleText, "");
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0]?.name, "read_file");
});

test("normalization preserves quarantined protocol tool metadata for semantic recovery", () => {
  const normalized = normalizeAssistantTurn({
    content: "",
    toolCalls: [],
    finishReason: "tool_calls",
    protocolViolation: "required_tool_call_not_available",
    protocolExpectedTool: "run_command",
    protocolActualTools: ["replace_in_file"],
    protocolActualToolCalls: [{
      index: 0,
      id: "replace-main",
      name: "replace_in_file",
      arguments: JSON.stringify({ path: "src/main.js", search_text: "old", replace_text: "new" }),
    }],
    protocolAllowedTools: ["run_command"],
  });
  assert.equal(normalized.protocolViolation, "required_tool_call_not_available");
  assert.equal(normalized.protocolExpectedTool, "run_command");
  assert.deepEqual(normalized.protocolActualTools, ["replace_in_file"]);
  assert.deepEqual(normalized.protocolActualToolCalls, [{
    index: 0,
    id: "replace-main",
    name: "replace_in_file",
    arguments: JSON.stringify({ path: "src/main.js", search_text: "old", replace_text: "new" }),
  }]);
  assert.deepEqual(normalized.protocolAllowedTools, ["run_command"]);
});
