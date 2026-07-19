import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

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
  new Function("exports", "module", "require", transpiled)(module.exports, module, localRequire);
  return module.exports;
}

const {
  completedAgentLoopOutcome,
  normalizeAgentLoopOutcome,
  pausedAgentLoopOutcome,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/runOutcome.ts"));

test("canonical outcomes separate terminal closure from result quality", () => {
  assert.deepEqual(completedAgentLoopOutcome("done"), {
    status: "completed",
    reason: "done",
    resultKind: "success",
  });
  assert.deepEqual(completedAgentLoopOutcome("provider request failed", "error"), {
    status: "completed",
    reason: "provider request failed",
    resultKind: "error",
  });
  assert.deepEqual(pausedAgentLoopOutcome("awaiting_user_choice", "action_required"), {
    status: "paused",
    reason: "awaiting_user_choice",
    pauseKind: "action_required",
  });
});

test("legacy no-action and no-output stops close the application turn", () => {
  assert.deepEqual(normalizeAgentLoopOutcome({
    status: "stopped_no_action",
    reason: "execution_evidence_required",
  }), {
    status: "completed",
    reason: "execution_evidence_required",
    resultKind: "blocked",
  });
  assert.deepEqual(normalizeAgentLoopOutcome({
    status: "stopped_no_output",
    reason: "no_output",
  }), {
    status: "completed",
    reason: "no_output",
    resultKind: "error",
  });
});

test("legacy paused no-action and no-output values cannot reopen a closed turn", () => {
  assert.deepEqual(normalizeAgentLoopOutcome({
    status: "paused",
    reason: "execution_evidence_required",
    pauseKind: "no_action",
  }), {
    status: "completed",
    reason: "execution_evidence_required",
    resultKind: "blocked",
  });
  assert.deepEqual(normalizeAgentLoopOutcome({
    status: "paused",
    reason: "no_output",
    pauseKind: "no_output",
  }), {
    status: "completed",
    reason: "no_output",
    resultKind: "error",
  });
});

test("legacy errors and failures close as explicit error conclusions", () => {
  for (const status of ["error", "failed"]) {
    assert.deepEqual(normalizeAgentLoopOutcome({ status, reason: "transport_error" }), {
      status: "completed",
      reason: "transport_error",
      resultKind: "error",
    });
  }
  assert.deepEqual(normalizeAgentLoopOutcome({ status: "unexpected_terminal" }), {
    status: "completed",
    reason: "agent_loop_unknown_outcome:unexpected_terminal",
    resultKind: "error",
  });
});

test("canonical completed values and genuine pause leases survive normalization", () => {
  assert.deepEqual(normalizeAgentLoopOutcome({
    status: "completed",
    reason: "scope is externally blocked",
    resultKind: "blocked",
  }), {
    status: "completed",
    reason: "scope is externally blocked",
    resultKind: "blocked",
  });
  assert.deepEqual(normalizeAgentLoopOutcome({
    status: "paused",
    reason: "approved_plan_same_turn_execution_pending",
    pauseKind: "recoverable",
  }), {
    status: "paused",
    reason: "approved_plan_same_turn_execution_pending",
    pauseKind: "recoverable",
  });
  assert.deepEqual(normalizeAgentLoopOutcome({
    status: "paused",
    reason: "tool_permission_required",
    pauseKind: "action_required",
  }), {
    status: "paused",
    reason: "tool_permission_required",
    pauseKind: "action_required",
  });
});
