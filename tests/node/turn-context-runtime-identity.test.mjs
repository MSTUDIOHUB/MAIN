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
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
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

const runIdentity = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/runIdentity.ts"));
const turnContext = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnContext.ts"));
const durableTurnContext = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/durableTurnContext.ts"));

test("successful and failed terminal runs both canonicalize persisted context", () => {
  assert.equal(durableTurnContext.shouldCanonicalizeTerminalTurnContext("completed"), true);
  assert.equal(durableTurnContext.shouldCanonicalizeTerminalTurnContext("error"), true);
  assert.equal(durableTurnContext.shouldCanonicalizeTerminalTurnContext("paused"), false);
  assert.equal(durableTurnContext.shouldCanonicalizeTerminalTurnContext("stopped_no_action"), false);
});

test("run lineage reuses only the exact logical turn and preserves its earliest message index", () => {
  const previousMarker = {
    runId: "run-parent",
    sessionKey: "session-a",
    turnId: "turn-a",
    turnStartMessageIndex: 4,
  };
  assert.deepEqual(runIdentity.resolveSubmitRunLineage({
    previousMarker,
    sessionKey: "session-a",
    turnId: "turn-a",
    runId: "run-child",
    currentMessageStartIndex: 11,
  }), {
    runId: "run-child",
    parentRunId: "run-parent",
    turnStartMessageIndex: 4,
  });

  assert.deepEqual(runIdentity.resolveSubmitRunLineage({
    previousMarker,
    sessionKey: "session-a",
    turnId: "turn-b",
    runId: "run-new-turn",
    currentMessageStartIndex: 12,
  }), {
    runId: "run-new-turn",
    parentRunId: null,
    turnStartMessageIndex: 12,
  });
});

test("ordinary continuation wording does not reuse a logical turn without an exact checkpoint", () => {
  assert.equal(runIdentity.shouldReuseLogicalTurnForSubmission({
    explicitReuse: false,
    exactChoiceMatch: false,
  }), false);
  assert.equal(runIdentity.shouldReuseLogicalTurnForSubmission({
    explicitReuse: false,
    exactChoiceMatch: true,
  }), true);
  assert.equal(runIdentity.shouldReuseLogicalTurnForSubmission({
    explicitReuse: true,
    exactChoiceMatch: false,
  }), true);
});

test("goal slice identities derive from the outer run and chain to the previous slice", () => {
  const first = runIdentity.resolveRuntimeRunIdentity({
    marker: { runId: "outer", sessionKey: "s", turnId: "t" },
    sessionKey: "s",
    turnId: "t",
    fallbackRunId: "fallback",
    goalSliceId: "slice-1",
  });
  assert.equal(first.runId, "outer:slice-1");
  assert.equal(first.parentRunId, "outer");

  const second = runIdentity.resolveRuntimeRunIdentity({
    marker: {
      runId: "outer",
      sessionKey: "s",
      turnId: "t",
      lastGoalSliceRunId: "outer:slice-1",
    },
    sessionKey: "s",
    turnId: "t",
    fallbackRunId: "fallback",
    goalSliceId: "slice-2",
  });
  assert.equal(second.runId, "outer:slice-2");
  assert.equal(second.parentRunId, "outer:slice-1");
  assert.equal(runIdentity.markerContinuesLogicalTurn({
    marker: {
      runId: "outer",
      sessionKey: "s",
      turnId: "t",
      lastGoalSliceRunId: "outer:slice-1",
    },
    sessionKey: "s",
    turnId: "t",
    goalSliceId: "slice-2",
  }), true);
});

test("canonical turn context keeps visible requests and choices but filters hidden plan and goal control prompts", () => {
  const messages = [
    { role: "user", content: "prior durable session request" },
    { role: "assistant", content: "prior answer" },
    {
      role: "user",
      content: "[turn_intake]\n[user_request]\n修复批准弹窗\n[/user_request]\n[/turn_intake]",
    },
    {
      role: "user",
      content: "用户批准并选择：批准并执行\n计划已批准。请直接基于当前任务清单继续执行剩余任务，不要重复计划内容。",
    },
    {
      role: "user",
      content: '[goal_continuation goal_id="goal-1" index="2"]\nContinue the same persistent goal.\n[/goal_continuation]',
    },
  ];
  const result = turnContext.collectCanonicalTurnUserContext({
    messages,
    turnStartMessageIndex: 2,
  });

  assert.deepEqual(result.texts, ["修复批准弹窗", "批准并执行"]);
  assert.equal(result.filteredSyntheticMessages, 1);
  assert.equal(messages.length, 5, "canonical extraction must not truncate durable context");
});

test("canonical turn context never promotes ContextState or wrapped hidden approval prompts", () => {
  const contextState = [
    "[System: ContextState",
    "ContextMemoryState v1 id=ctx-control updatedAt=1",
    "Latest user request: 修复双击 Markdown 文件无法打开的问题。",
    "Hard constraints:",
    "- 如果用户消息包含 [turn_intake]，优先读取其中的 user_request。",
    "Use this as compact historical state only; prioritize the latest messages and current workspace evidence.]",
  ].join("\n");
  const hiddenApproval = [
    "[turn_intake]",
    "[user_request]",
    "计划已批准。请直接执行剩余任务，并运行 `npm test`。",
    "[/user_request]",
    "[/turn_intake]",
  ].join("\n");
  const result = turnContext.collectCanonicalTurnUserContext({
    messages: [
      { role: "user", content: "[turn_intake]\n[user_request]\n修复双击 Markdown 文件无法打开的问题。\n[/user_request]\n[/turn_intake]" },
      { role: "user", content: contextState },
      { role: "user", content: "PLAN_READONLY_CONVERGENCE: stop broad exploration and write plan.md." },
      { role: "user", content: hiddenApproval },
    ],
    turnStartMessageIndex: 0,
  });

  assert.deepEqual(result.texts, ["修复双击 Markdown 文件无法打开的问题。"]);
  assert.equal(result.inspectedUserMessages, 4);
  assert.equal(result.filteredSyntheticMessages, 3);
});

test("approved Plan child context keeps prior turns, canonical input, and the exact reviewed artifact only", () => {
  const reviewedPlan = "# 计划\n\n## 摘要\n- 修复文件打开链路。\n\n## 测试方案\n- 双击文件并验证内容加载。";
  const compacted = turnContext.compactPlanReviewTurnMessages({
    messages: [
      { role: "user", content: "上一轮问题" },
      { role: "assistant", content: "上一轮精确回答" },
      { role: "user", content: "[turn_intake]\n[user_request]\n修复双击文件空白和打开按钮失效。\n[/user_request]\n[/turn_intake]" },
      { role: "user", content: "[System: ContextState]\nContextMemoryState v1\nconstraints mention [turn_intake]" },
      { role: "assistant", content: "隐藏探索过程" },
      { role: "tool", content: "大段 read_file 原始输出" },
      { role: "user", content: "[turn_intake]\n[user_request]\n计划已批准。请执行 npm test。\n[/user_request]\n[/turn_intake]" },
    ],
    turnStartMessageIndex: 2,
    turnBlocks: [
      { type: "user", content: "修复双击文件空白和打开按钮失效。" },
      { type: "thought", content: "隐藏推理", hiddenProcess: true },
      { type: "agent", content: "计划已生成，请审核。" },
    ],
    reviewedPlanContent: reviewedPlan,
  });

  assert.deepEqual(compacted, [
    { role: "user", content: "上一轮问题" },
    { role: "assistant", content: "上一轮精确回答" },
    { role: "user", content: "修复双击文件空白和打开按钮失效。" },
    { role: "assistant", content: reviewedPlan },
  ]);
  assert.doesNotMatch(JSON.stringify(compacted), /ContextState|大段 read_file|计划已批准|隐藏探索/);
});

test("completed turn compaction preserves every visible clarification and the exact final answer", () => {
  const compacted = turnContext.buildCanonicalCompletedTurnMessages({
    turnBlocks: [
      { type: "user", content: "先分析日志" },
      { type: "agent", content: "内部推理", hiddenProcess: true },
      { type: "user", content: "再严谨修复底层逻辑" },
      { type: "agent", content: "中间进展" },
      { type: "agent", content: "精确最终答复\n\n- 验证通过" },
    ],
    fallbackAssistantText: "摘要不应覆盖最终答复",
  });

  assert.deepEqual(compacted, [
    { role: "user", content: "先分析日志" },
    { role: "user", content: "再严谨修复底层逻辑" },
    { role: "assistant", content: "精确最终答复\n\n- 验证通过" },
  ]);

  const messages = [
    { role: "user", content: "prior turn" },
    { role: "assistant", content: "prior answer" },
    { role: "user", content: "[turn_intake]\n[user_request]\n先分析日志\n[/user_request]\n[/turn_intake]" },
    { role: "assistant", content: "请选择" },
    { role: "user", content: "用户批准并选择：再严谨修复底层逻辑\n计划已批准。继续执行。" },
  ];
  assert.equal(turnContext.findCanonicalTurnStartMessageIndex({
    messages,
    canonicalUserTexts: ["先分析日志", "再严谨修复底层逻辑"],
    fallbackStartIndex: 4,
  }), 2);
});

test("durable turn context keeps canonical messages and structured evidence without hidden process or raw tool output", () => {
  const durable = durableTurnContext.buildDurableTurnContext({
    turnId: "turn-durable",
    turnBlocks: [
      { id: 1, turnId: "turn-durable", type: "user", content: "修复底层逻辑" },
      { id: 2, turnId: "turn-durable", type: "thought", content: "不可持久化的隐藏推理" },
      { id: 3, turnId: "turn-durable", type: "agent", content: "中间选择", selectedOption: "采用统一状态机" },
      { id: 4, turnId: "turn-durable", type: "tool", toolName: "apply_patch", target: "src/runtime.ts", status: "done", toolStatus: "executed", message: "raw patch output" },
      { id: 5, turnId: "turn-durable", type: "tool", toolName: "write_file", target: ".MAIN/plans/plan.md", status: "done", toolStatus: "executed" },
      { id: 6, turnId: "turn-durable", type: "tool", toolName: "run_command", target: "npm test", status: "done", toolStatus: "executed", message: "large test output" },
      { id: 7, turnId: "turn-durable", type: "agent", content: "修复完成，测试通过。" },
    ],
    artifactPaths: [".MAIN/plans/plan.md"],
  });

  assert.ok(durable);
  assert.deepEqual(durable.visibleUserMessages, ["修复底层逻辑"]);
  assert.equal(durable.finalAssistantAnswer, "修复完成，测试通过。");
  assert.deepEqual(durable.execution.decisions, ["采用统一状态机"]);
  assert.deepEqual(durable.execution.modifiedFiles, ["src/runtime.ts"]);
  assert.deepEqual(durable.execution.validations, ["run_command: npm test"]);
  assert.deepEqual(durable.execution.artifacts, [".MAIN/plans/plan.md"]);
  const serialized = durableTurnContext.serializeDurableTurnContextForModel(durable);
  assert.match(serialized, /\[durable_turn_context\]/);
  assert.doesNotMatch(serialized, /隐藏推理|raw patch output|large test output/);
});
