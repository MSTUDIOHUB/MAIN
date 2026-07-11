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

const { findLatestRunOwnedAgentBlock } = loadModule(
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
