import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
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
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

const {
  isConversationalFirstPersonNarration,
  isIdleCapsuleNarration,
  deriveDynamicFirstPersonText,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/capsuleStagingHelper.ts"));

test("isConversationalFirstPersonNarration validations", () => {
  // Should accept correct first-person narrations
  assert.equal(isConversationalFirstPersonNarration("我正在读取 useCsvParser.ts 文件以验证创作者字段名"), true);
  assert.equal(isConversationalFirstPersonNarration("接下来我将尝试运行测试验证改动是否通过"), true);
  assert.equal(isConversationalFirstPersonNarration("I'm analyzing the csv data parsing logic"), true);
  assert.equal(isConversationalFirstPersonNarration("# 我正在分析 CSV creator 映射"), true);

  // Should accept rich or structured contents if they contain first-person narration
  assert.equal(isConversationalFirstPersonNarration("我准备进行以下修改：\n1. 修改文件\n2. 编译测试"), true);
  assert.equal(isConversationalFirstPersonNarration("I am thinking about adding these properties:\n```typescript\nconst a = 1;\n```"), true);

  // Should reject contents that do not have first-person indicators
  assert.equal(isConversationalFirstPersonNarration("### 实施步骤与长计划列表\n1. 修改文件\n2. 编译测试\n3. 提交审核"), true);
  assert.equal(isConversationalFirstPersonNarration("```typescript\nconst a = 1;\n```"), false);
  assert.equal(isConversationalFirstPersonNarration("| 字段 | 类型 |\n| --- | --- |\n| creator | string |"), false);
  assert.equal(isConversationalFirstPersonNarration("a".repeat(400)), false);
  assert.equal(isConversationalFirstPersonNarration("我正在等待您的下一步指令，随时准备开始新的探索或修改..."), false);
  assert.equal(isConversationalFirstPersonNarration("I am awaiting your next instructions, ready to begin new exploration or modifications..."), false);
});

test("idle capsule narration is rejected explicitly", () => {
  assert.equal(isIdleCapsuleNarration("我正在等待您的下一步指令，随时准备开始新的探索或修改..."), true);
  assert.equal(isIdleCapsuleNarration("I am awaiting your next instructions, ready to begin new exploration or modifications..."), true);
  assert.equal(isIdleCapsuleNarration("我为您提供了几种解决方案，正在等待您的选择。"), false);
});

test("deriveDynamicFirstPersonText - Tool execution phase (Dynamic Intent summaries)", () => {
  const blocks = [
    {
      type: "tool",
      toolName: "read_file",
      target: "src/hooks/useCsvParser.ts",
      toolStatus: "running",
      intentSummary: "读取 useCsvParser.ts 以确认 creator 字段名"
    }
  ];
  const turn = { id: "turn-1", status: "executing" };

  const resultZh = deriveDynamicFirstPersonText(turn, blocks, "running", "zh");
  assert.equal(resultZh, "我正在读取并探索 `useCsvParser.ts`，目的是：确认 creator 字段名...");

  const blocksEn = [
    {
      type: "tool",
      toolName: "replace_in_file",
      target: "src/types/order.ts",
      toolStatus: "running",
      why: "add creatorName property to interface"
    }
  ];
  const resultEn = deriveDynamicFirstPersonText(turn, blocksEn, "running", "en");
  assert.equal(resultEn, "I am modifying `order.ts` to: add creatorName property to interface...");
});

test("deriveDynamicFirstPersonText - Tool execution fallback (No intent/why)", () => {
  const blocks = [
    {
      type: "tool",
      toolName: "run_command",
      target: "npm test",
      toolStatus: "running"
    }
  ];
  const turn = { id: "turn-1", status: "executing" };

  const resultZh = deriveDynamicFirstPersonText(turn, blocks, "running", "zh");
  assert.equal(resultZh, "我正在运行 `npm test` 验证命令，确保修改后的代码能通过所有质量与测试标准...");

  const resultEn = deriveDynamicFirstPersonText(turn, blocks, "running", "en");
  assert.equal(resultEn, "I am running the verification command `npm test` to ensure all quality and test standards are met...");
});

test("deriveDynamicFirstPersonText - Awaiting Plan Approval", () => {
  const blocks = [];
  const turn = { id: "turn-1", status: "awaiting_approval", title: "修复 CSV 字段映射" };

  const resultZh = deriveDynamicFirstPersonText(turn, blocks, "pending_review", "zh");
  assert.equal(resultZh, "我已为您生成了关于【修复 CSV 字段映射】的完整修改计划，正在等待您的审批。批准后我将开始安全的自动代码修改流程...");

  const resultEn = deriveDynamicFirstPersonText(turn, blocks, "pending_review", "en");
  assert.equal(resultEn, "I have generated the implementation plan for [修复 CSV 字段映射] and am awaiting your approval to safely proceed with the code changes...");
});

test("deriveDynamicFirstPersonText - Awaiting Input Options", () => {
  const blocks = [
    {
      type: "agent",
      content: "请选择一个方案",
      options: [{ label: "方案 A", value: "a" }]
    }
  ];
  const turn = { id: "turn-1", status: "awaiting_input" };

  const resultZh = deriveDynamicFirstPersonText(turn, blocks, "running", "zh");
  assert.equal(resultZh, "我为您提供了几种解决方案，正在等待您的选择，这将决定我接下来的修改与优化方向...");
});

test("deriveDynamicFirstPersonText - silent when no active signal exists", () => {
  const resultZh = deriveDynamicFirstPersonText({ id: "turn-1", status: "executing" }, [], "running", "zh");
  assert.equal(resultZh, "");

  const resultEn = deriveDynamicFirstPersonText({ id: "turn-1", status: "executing" }, [], "running", "en");
  assert.equal(resultEn, "");
});

test("deriveDynamicFirstPersonText - Streaming Thoughts", () => {
  const blocks = [
    {
      type: "thought",
      content: "我分析了当前的类型定义。接下来我准备先检查一下 types 接口",
      isStreaming: true
    }
  ];
  const turn = { id: "turn-1", status: "executing" };

  const resultZh = deriveDynamicFirstPersonText(turn, blocks, "running", "zh");
  assert.equal(resultZh, "接下来我准备先检查一下 types 接口");
});
