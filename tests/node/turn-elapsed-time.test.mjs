import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const sourcePath = path.join(
  process.cwd(),
  "src/lib/turnElapsedTime.ts",
);
const source = fs.readFileSync(sourcePath, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function("exports", "module", "require", output)(
  module.exports,
  module,
  createRequire(sourcePath),
);
const elapsed = module.exports;

test("active Turn elapsed time derives from its epoch run boundary", () => {
  const startedAt = 1_785_240_284_729;
  const window = elapsed.resolveTurnRunTimeWindow({
    turnId: "turn-a",
    events: [{
      type: "run.started",
      turnId: "turn-a",
      runId: "run-a",
      timestampMs: startedAt,
    }],
  });
  assert.equal(elapsed.deriveTurnElapsedSeconds({
    window,
    nowMs: startedAt + 469_000,
    isActive: true,
    sessionElapsedSeconds: 0,
  }), 469);
});

test("terminal Turn elapsed time uses the matching latest run identity", () => {
  const window = elapsed.resolveTurnRunTimeWindow({
    turnId: "turn-a",
    events: [
      {
        type: "run.started",
        turnId: "turn-a",
        runId: "run-old",
        timestampMs: 1_700_000_000_000,
      },
      {
        type: "run.completed",
        turnId: "turn-a",
        runId: "run-old",
        timestampMs: 1_700_000_010_000,
      },
      {
        type: "run.started",
        turnId: "turn-a",
        runId: "run-new",
        timestampMs: 1_800_000_000_000,
      },
      {
        type: "turn.completed",
        turnId: "turn-a",
        runId: "run-new",
        timestampMs: 1_800_000_125_000,
      },
    ],
  });
  assert.equal(window.runId, "run-new");
  assert.equal(elapsed.deriveTurnElapsedSeconds({
    window,
    nowMs: 1_900_000_000_000,
    isActive: false,
  }), 125);
});

test("an inactive Turn never inherits another Turn's session timer", () => {
  assert.equal(elapsed.deriveTurnElapsedSeconds({
    window: {
      runId: "run-old",
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_003_000,
    },
    nowMs: 1_900_000_000_000,
    isActive: false,
    savedElapsedSeconds: 3,
    sessionElapsedSeconds: 469,
  }), 3);
});
