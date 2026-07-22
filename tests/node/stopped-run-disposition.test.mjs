import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const sourcePath = path.join(
  workspaceRoot,
  "src/lib/orchestrator/loop/stoppedRunDisposition.ts",
);
const source = fsSync.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function("exports", "module", "require", transpiled)(
  module.exports,
  module,
  createRequire(sourcePath),
);
const { resolveStoppedRunDisposition } = module.exports;

test("review-ready Plan pause supersedes a previously staged generic completion", () => {
  assert.equal(resolveStoppedRunDisposition({
    workflowMode: "plan",
    isPlanApproved: false,
    status: "pending_review",
    hasStagedTurnCompletion: true,
  }), "plan_review");
});

test("ordinary stopped runs preserve staged completion and committed pause ordering", () => {
  assert.equal(resolveStoppedRunDisposition({
    workflowMode: "edit",
    isPlanApproved: false,
    status: "running",
    hasStagedTurnCompletion: true,
    committedPauseReason: "awaiting_user_choice",
  }), "staged_completion");
  assert.equal(resolveStoppedRunDisposition({
    workflowMode: "edit",
    isPlanApproved: false,
    status: "running",
    hasStagedTurnCompletion: false,
    committedPauseReason: "awaiting_user_choice",
  }), "committed_pause");
});
