import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadContextTrimModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/contextTrim.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, require);
  return module.exports;
}

const {
  computeContextBudgets,
  computeContextTokenBreakdown,
  manageContext,
} = await loadContextTrimModule();

test("computeContextBudgets reserves a smaller, capped output budget for long contexts", () => {
  const budgets16k = computeContextBudgets(16384);
  const budgets128k = computeContextBudgets(131072);

  assert.equal(budgets16k.outputBudget, 3276);
  assert.equal(budgets16k.inputBudget, 13108);
  assert.equal(budgets128k.outputBudget, 4096);
  assert.equal(budgets128k.inputBudget, 126976);
});

test("manageContext leaves long tool output untouched while under the proactive trigger", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "tool", content: "A".repeat(12000) },
  ];

  const result = manageContext(messages, 32768, undefined, 100, 2000);

  assert.equal(result.droppedCount, 0);
  assert.equal(result.changed, false);
  assert.equal(result.tokenReduction, 0);
  assert.equal(result.messages.length, messages.length);
  assert.equal(result.messages[1].content, messages[1].content);
});

test("manageContext can persist token savings once the proactive trigger is crossed", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "tool", content: "A".repeat(80000) },
  ];

  const result = manageContext(messages, 32768, undefined, 100, 2000);

  assert.equal(result.droppedCount, 0);
  assert.equal(result.changed, true);
  assert.ok(result.tokenReduction > 0);
  assert.equal(result.messages.length, messages.length);
  assert.notEqual(result.messages[1].content, messages[1].content);
});

test("manageContext trims down to a lower hysteresis target once the trigger is crossed", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-` + "B".repeat(900),
    })),
  ];

  const result = manageContext(messages, 4096, undefined, 4000, 4000);

  assert.equal(result.changed, true);
  assert.ok(result.droppedCount > 0);
  assert.ok(result.tokenReduction > 0);
  assert.ok(result.tokenCountAfter <= result.budgets.proactiveTargetBudget);
});

test("manageContext force mode trims even after microcompaction leaves context over provider window", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    ...Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-` + "C".repeat(3200),
    })),
  ];

  const result = manageContext(messages, 32768, 2048, 4000, 4000, true);

  assert.equal(result.changed, true);
  assert.ok(result.droppedCount > 0);
  assert.ok(result.tokenCountAfter <= result.budgets.proactiveTargetBudget);
});

test("manageContext builds state-first compressed memory instead of tool transcript noise", () => {
  const readToolCall = {
    id: "call_read",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "snake.py" }),
    },
  };
  const replaceToolCall = {
    id: "call_replace",
    function: {
      name: "replace_in_file",
      arguments: JSON.stringify({ path: "snake.py" }),
    },
  };
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "请修复 snake.py 的重复替换问题，必须保留审计历史，不要删除 .MAIN/plans 文件。" },
    { role: "assistant", content: "", tool_calls: [readToolCall] },
    { role: "tool", tool_call_id: "call_read", content: "snake.py contents\n" + "def move(): pass\n".repeat(900) },
    { role: "assistant", content: "", tool_calls: [replaceToolCall] },
    {
      role: "tool",
      tool_call_id: "call_replace",
      content: [
        'Detected a repetition loop: tool "replace_in_file" called with identical arguments 3+ times (target: "snake.py").',
        "RecoveryDetails:",
        "- duplicateTool: replace_in_file",
        "- target: snake.py",
        "- duplicateCount: 3+",
        "- suggestedNextTask: 重新读取 tasks.md 与证据摘要后继续",
      ].join("\n"),
    },
    ...Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `recent-${index} ` + "R".repeat(900),
    })),
  ];

  const result = manageContext(messages, 4096, 1024, 4000, 4000, true);
  const compressed = String(result.compressedContext || "");
  const marker = result.messages.find((message) =>
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.includes("ContextState")
  );

  assert.ok(marker, "expected a ContextState marker in the managed messages");
  assert.match(compressed, /ContextState/);
  assert.match(compressed, /snake\.py/);
  assert.match(compressed, /duplicateTool=replace_in_file|repeat loop/);
  assert.match(compressed, /重新读取 tasks\.md/);
  assert.doesNotMatch(compressed, /助手调用工具|工具结果：/);
});

test("manageContext carries compressed state without nesting earlier transcript summaries", () => {
  const first = manageContext([
    { role: "system", content: "system prompt" },
    { role: "user", content: "目标：实现 TopIsland 步骤进度，必须只展示当前回合。" },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `old-${index} ` + "A".repeat(1000),
    })),
  ], 4096, 1024, 4000, 4000, true);

  const second = manageContext([
    ...first.messages,
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `new-${index} ` + "B".repeat(1000),
    })),
  ], 4096, 1024, 4000, 4000, true);

  const compressed = String(second.compressedContext || "");
  assert.doesNotMatch(compressed, /更早历史摘要/);
  assert.doesNotMatch(compressed, /助手调用工具|工具结果：/);
  assert.ok((compressed.match(/ContextState:/g) || []).length <= 1);
});

test("computeContextTokenBreakdown reports tool results as the largest source", () => {
  const result = computeContextTokenBreakdown([
    { role: "system", content: "system prompt" },
    { role: "user", content: "short request" },
    { role: "tool", content: "T".repeat(12000) },
  ]);

  assert.equal(result.topSource, "toolResult");
  assert.match(result.topSourceLabel, /tool results/);
  assert.ok(result.topSourceTokens > result.user);
});
