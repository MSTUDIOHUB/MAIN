import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

function loadModule(sourcePath) {
  const source = fsSync.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  const factory = new Function("exports", "module", "require", compiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

const { findLatestRunOwnedAgentBlock, isDurableAssistantPresentationBlock } = loadModule(
  path.join(process.cwd(), "src/lib/orchestrator/runOwnedAgentBlocks.ts"),
);

test("continuation cleanup never selects prior-run or archived assistant checkpoints", () => {
  const taskFlow = [
    { id: 1, turnId: "turn-1", type: "agent", content: "old final" },
    {
      id: 2,
      turnId: "turn-1",
      type: "agent",
      content: "choose",
      archivedAfterChoice: true,
      selectedOption: "execute",
    },
    { id: 3, turnId: "turn-1", type: "agent", content: "current retry", streaming: false },
  ];

  assert.equal(findLatestRunOwnedAgentBlock(taskFlow, "turn-1", new Set()), null);
  assert.equal(findLatestRunOwnedAgentBlock(taskFlow, "turn-1", new Set([2])), null);
  assert.equal(findLatestRunOwnedAgentBlock(taskFlow, "turn-1", new Set([3]))?.id, 3);
});

test("stream dedup only reuses settled assistant output from the current run", () => {
  const taskFlow = [
    { id: 4, turnId: "turn-1", type: "agent", content: "settled", streaming: false },
    { id: 5, turnId: "turn-1", type: "agent", content: "live", streaming: true },
  ];

  assert.equal(
    findLatestRunOwnedAgentBlock(taskFlow, "turn-1", new Set([4, 5]), { requireSettled: true })?.id,
    4,
  );
});

test("stream cleanup never selects durable user-facing assistant presentations", () => {
  const transient = {
    id: 6,
    turnId: "turn-1",
    type: "agent",
    content: "temporary stream preamble",
    streaming: false,
  };
  const durableBlocks = [
    { id: 7, visibility: "assistant_update", content: "阶段性总结" },
    { id: 8, visibility: "assistant_final", content: "最终结果" },
    { id: 9, visibility: "stage_summary", content: "旧版阶段总结" },
    { id: 10, visibility: "substantive_plan_text", content: "实施计划" },
    { id: 11, content: "请选择", options: [{ id: "yes", label: "继续" }] },
    { id: 12, content: "请选择", choiceRequest: { requestId: "choice-1" } },
  ].map((block) => ({ turnId: "turn-1", type: "agent", ...block }));
  const taskFlow = [transient, ...durableBlocks];
  const ownedIds = new Set(taskFlow.map((block) => block.id));

  for (const block of durableBlocks) {
    assert.equal(isDurableAssistantPresentationBlock(block), true);
  }
  assert.equal(isDurableAssistantPresentationBlock(transient), false);
  assert.equal(findLatestRunOwnedAgentBlock(taskFlow, "turn-1", ownedIds)?.id, transient.id);
  assert.equal(
    findLatestRunOwnedAgentBlock(durableBlocks, "turn-1", new Set(durableBlocks.map((block) => block.id))),
    null,
  );
});

test("empty reply options remain transient while real choices stay durable", () => {
  const transient = {
    id: 13,
    turnId: "turn-1",
    type: "agent",
    content: "temporary settled output",
    streaming: false,
    options: [],
  };
  const choice = {
    ...transient,
    id: 14,
    content: "choose one",
    options: [{ label: "Continue", value: "continue" }],
  };

  assert.equal(isDurableAssistantPresentationBlock(transient), false);
  assert.equal(isDurableAssistantPresentationBlock(choice), true);
  assert.equal(
    findLatestRunOwnedAgentBlock([transient, choice], "turn-1", new Set([13, 14]))?.id,
    13,
  );
});
