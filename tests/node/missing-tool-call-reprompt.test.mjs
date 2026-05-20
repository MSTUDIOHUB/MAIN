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
  resolveMissingToolCallRepromptKind,
  buildMissingToolCallContinuationPrompt,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/missingToolCallReprompt.ts"));

test("research chat reprompts when the assistant only promises tabular analysis", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "chat",
    nexusModeKey: "nexus_research",
    visibleText: `
下一步行动计划：我将依次对四份文件执行 analyze_tabular_document 操作，以获取它们各自的元数据（列名、数据类型、缺失值、分布情况），这是后续所有建模的基础。

我将从第一份文件开始：u3d_most_comment_users_20260423脱敏版.xlsx。

请稍候，我将开始对该文件进行结构化分析。
    `,
  });

  assert.equal(kind, "read_only");
});

test("chat summaries without promised action do not reprompt", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "chat",
    nexusModeKey: "nexus_research",
    visibleText: "我已经完成初步分析。四份文件的关键差异主要集中在活跃度字段和时间粒度上，下面是结论摘要。",
  });

  assert.equal(kind, "none");
});

test("execute mode still reprompts generic text-only intent stubs", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "edit",
    nexusModeKey: "nexus_build",
    visibleText: "我现在开始修改这个组件并修复相关 bug。",
  });

  assert.equal(kind, "generic");
});

test("execute mode reprompts Gemma-style prose that promises a tool call", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "edit",
    mainModeKey: "main_mode",
    visibleText: [
      "由于之前的 replace_in_file 失败（search_text 不匹配），我需要重新精确获取 filteredOrders 的源代码内容。",
      "",
      "我将通过 read_file 读取 src/store/dashboardStore.ts 的第 100 到 160 行，以获取准确的 get filteredOrders() 实现。",
      "",
      "正在重新获取 src/store/dashboardStore.ts 的关键代码段。",
    ].join("\n"),
  });

  assert.equal(kind, "generic");
});

test("execute mode reprompts when model dumps code in chat instead of tools", () => {
  const codeBlock = `
文件：Assets/Scripts/Battle/BattleUnit.cs
\`\`\`csharp
using UnityEngine;
namespace Battle {
public class BattleUnit : MonoBehaviour {
${Array.from({ length: 120 }, (_, index) => `  public int Field${index};`).join("\n")}
}
}
\`\`\`

文件：Assets/Scripts/Battle/Commands/BattleCommand.cs
\`\`\`csharp
namespace Battle.Commands {
public class BattleCommand {
${Array.from({ length: 120 }, (_, index) => `  public void Execute${index}() { }`).join("\n")}
}
}
\`\`\`
`;
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "edit",
    nexusModeKey: "nexus_build",
    visibleText: codeBlock,
  });

  assert.equal(kind, "generic");
});

test("read-only continuation prompt tells the model to start tools immediately", () => {
  const prompt = buildMissingToolCallContinuationPrompt("read_only", "zh");

  assert.match(prompt, /立即开始真实分析/);
  assert.match(prompt, /analyze_tabular_document/);
  assert.match(prompt, /不要再输出“请稍候”/);
});

test("second missing-tool retry uses strict single-tool-call wording", () => {
  const prompt = buildMissingToolCallContinuationPrompt("generic", "zh", 2);

  assert.match(prompt, /只输出一个 `<tool_use>` 工具调用块/);
  assert.match(prompt, /不要输出任何普通正文/);
  assert.match(prompt, /write_file/);
});

test("edit mode uses post-write verification reprompt after a recent project write", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "edit",
    mainModeKey: "main_mode",
    visibleText: "我将运行 python snake.py 来验证这个游戏是否正常启动。",
    recentWrite: {
      lastSuccessfulToolName: "write_file",
      lastSuccessfulTargetPath: "snake.py",
      lastSuccessfulTargetOutsidePlan: true,
      recoveringFromEmptyAssistantReply: true,
    },
  });

  assert.equal(kind, "post_write_verify");
});

test("plan artifact writes do not trigger post-write verification reprompts", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "edit",
    mainModeKey: "main_mode",
    visibleText: "我将运行 python snake.py 来验证这个游戏是否正常启动。",
    recentWrite: {
      lastSuccessfulToolName: "write_file",
      lastSuccessfulTargetPath: ".MAIN/plans/requirements.md",
      lastSuccessfulTargetOutsidePlan: false,
      recoveringFromEmptyAssistantReply: true,
    },
  });

  assert.notEqual(kind, "post_write_verify");
});

test("post-write verification prompt prefers immediate run_command validation", () => {
  const prompt = buildMissingToolCallContinuationPrompt("post_write_verify", "zh");

  assert.match(prompt, /立即执行真实验证/);
  assert.match(prompt, /run_command/);
  assert.match(prompt, /execute_command/);
  assert.match(prompt, /不要再输出“我将运行\/测试\/验证”/);
});

test("second post-write verification retry requires a single tool call with no prose", () => {
  const prompt = buildMissingToolCallContinuationPrompt("post_write_verify", "zh", 2);

  assert.match(prompt, /只输出一个 `<tool_use>` 工具调用块/);
  assert.match(prompt, /不要输出任何普通正文/);
  assert.match(prompt, /run_command/);
});
