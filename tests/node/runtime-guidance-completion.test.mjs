import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const sourcePath = path.join(workspaceRoot, "src/lib/runtimeGuidanceCompletion.ts");
const source = fs.readFileSync(sourcePath, "utf8");
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
const {
  MAX_LATE_GUIDANCE_COMPLETION_CONTINUATIONS,
  decideRuntimeGuidanceCompletionFence,
} = module.exports;

test("completion fence gives one exact pending Guide one bounded continuation", () => {
  assert.equal(MAX_LATE_GUIDANCE_COMPLETION_CONTINUATIONS, 1);
  assert.deepEqual(decideRuntimeGuidanceCompletionFence({
    completionCandidate: true,
    runStatus: "running",
    runPhase: "executing",
    exactPendingGuidanceId: "guidance-1",
    lateGuidanceContinuationsUsed: 0,
  }), {
    kind: "continue_with_guidance",
    guidanceId: "guidance-1",
  });
  assert.deepEqual(decideRuntimeGuidanceCompletionFence({
    completionCandidate: true,
    runStatus: "running",
    runPhase: "finalizing",
    exactPendingGuidanceId: "guidance-2",
    lateGuidanceContinuationsUsed: 1,
  }), {
    kind: "reject_completion",
    reason: "late_guidance_budget_exhausted",
  });
});

test("completion fence acquires finalization only for a live completion candidate", () => {
  assert.deepEqual(decideRuntimeGuidanceCompletionFence({
    completionCandidate: true,
    runStatus: "running",
    runPhase: "executing",
    exactPendingGuidanceId: null,
    lateGuidanceContinuationsUsed: 0,
  }), { kind: "acquire_completion", alreadyFinalizing: false });
  assert.deepEqual(decideRuntimeGuidanceCompletionFence({
    completionCandidate: true,
    runStatus: "running",
    runPhase: "finalizing",
    exactPendingGuidanceId: null,
    lateGuidanceContinuationsUsed: 0,
  }), { kind: "acquire_completion", alreadyFinalizing: true });
  assert.deepEqual(decideRuntimeGuidanceCompletionFence({
    completionCandidate: true,
    runStatus: "paused",
    runPhase: "reviewing",
    exactPendingGuidanceId: null,
    lateGuidanceContinuationsUsed: 0,
  }), { kind: "reject_completion", reason: "run_not_running" });
  assert.deepEqual(decideRuntimeGuidanceCompletionFence({
    completionCandidate: false,
    runStatus: "running",
    runPhase: "executing",
    exactPendingGuidanceId: "guidance-ignored",
    lateGuidanceContinuationsUsed: 0,
  }), { kind: "not_applicable" });
});

test("production loop reserves an iteration only when late Guide wins completion", () => {
  const orchestratorSource = fs.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"),
    "utf8",
  );
  assert.match(orchestratorSource, /lateGuidanceIterationAllowance \+= 1/);
  assert.match(orchestratorSource, /getEffectiveMaxIterations\(\) \+ lateGuidanceIterationAllowance/);
  assert.match(orchestratorSource, /turnEvents\.discardStagedTurnCompletion\(\)/);
  assert.match(orchestratorSource, /callbacks\.onLateGuidanceContinuation/);
});
