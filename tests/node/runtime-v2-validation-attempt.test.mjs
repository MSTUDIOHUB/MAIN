import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();
function loadTs(file) {
  const source = path.resolve(file);
  if (cache.has(source)) return cache.get(source);
  const module = { exports: {} };
  cache.set(source, module.exports);
  const code = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: source,
  }).outputText;
  const localRequire = createRequire(source);
  new Function("exports", "module", "require", code)(module.exports, module, (name) => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(source), name);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return loadTs(candidate);
      }
    }
    return localRequire(name);
  });
  return module.exports;
}

const runtime = loadTs("src/lib/runtime-v2/index.ts");
const { deriveRuntimeV2ValidationCorrectionWindow } = loadTs("src/store/runtimeV2/executionValidationCorrection.ts");
const { deriveRuntimeV2ProviderEffectFacts } = loadTs("src/store/runtimeV2/executionProviderEffectFacts.ts");
const classifier = { isMutationToolName: (name) => name === "write_file" };

function fixture(failureKind = "not_executed", passed = false) {
  const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
  const event = (type, sequence, payload) => ({ type, sequence, schemaVersion: 1, eventId: `event-${sequence}`, at: sequence, run, ...payload });
  const validation = event("validation.completed", 4, {
    idempotencyKey: "validator", passed, failureKind,
    failureReasonCode: failureKind === "not_executed" ? "provider_batch_predecessor_failed" : undefined,
    evidence: [], presentation: { toolName: "run_command", target: "npm test", message: "Receipt presentation is not control state." },
  });
  return {
    strategy: "execute", phase: "validating", terminalOutcome: null,
    run: { identity: run, status: "running", phase: "validating" },
    turn: { turnId: "turn" }, objective: { acceptanceCriteria: [] },
    pendingToolCalls: [], scheduledCommands: [],
    events: [
      event("run.started", 0, { phase: "validating" }),
      event("command.scheduled", 1, { command: { kind: "execute_tool", run, idempotencyKey: "write", payload: { toolCallId: "write-call", toolName: "write_file", arguments: { path: "src/main.ts" } } } }),
      event("tool.completed", 2, { idempotencyKey: "write", status: "succeeded", evidence: [{ id: "mutation", kind: "mutation", target: "src/main.ts", version: "v1" }] }),
      event("command.scheduled", 3, { command: { kind: "execute_validation", run, idempotencyKey: "validator", payload: { toolCallId: "validator-call", toolName: "run_command", arguments: { command: "npm test" } } } }),
      validation,
    ],
  };
}

test("unexecuted validators create no failure/correction frontier and leave validation debt intact", () => {
  const state = fixture();
  const correction = deriveRuntimeV2ValidationCorrectionWindow(state);
  assert.equal(correction.active, false);
  assert.equal(correction.validationCommandUnavailable, false);
  const evidence = runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier);
  assert.equal(evidence.failedValidationCount, 0);
  assert.equal(evidence.stalledValidationCount, 0);
  assert.equal(evidence.failedOperationCount, 0);
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier), null,
    "skipping a validator cannot send validation back to source editing");
  const acting = { ...state, phase: "acting", run: { ...state.run, phase: "acting" } };
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(acting, classifier)?.to, "validating",
    "an unexecuted receipt cannot satisfy the mutation-to-validation boundary");
  const effects = deriveRuntimeV2ProviderEffectFacts(state);
  assert.ok(effects.unexecutedToolCallIds.has("validator-call"));
  assert.ok(!effects.failedValidationToolCallIds.has("validator-call"));
});

test("real execution and assertion failures retain their semantic correction and phase behavior", () => {
  for (const kind of ["execution_failed", "assertion_failed"]) {
    const state = fixture(kind);
    assert.equal(deriveRuntimeV2ValidationCorrectionWindow(state).active, true);
    assert.equal(runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier).failedValidationCount, 1);
    assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier)?.reason, "validation_failed");
    assert.ok(deriveRuntimeV2ProviderEffectFacts(state).failedValidationToolCallIds.has("validator-call"));
  }
});

test("unexecuted receipts cannot manufacture a pass even when passed is incorrectly true", () => {
  const state = fixture("not_executed", true);
  assert.equal(runtime.isRuntimeV2ValidationAttempt(state.events.at(-1)), false);
  assert.equal(runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier).passedValidationCount, 0);
  assert.ok(deriveRuntimeV2ProviderEffectFacts(state).unexecutedToolCallIds.has("validator-call"));
});

test("checkpoint replay preserves unexecuted validation semantics without a process-local batch map", () => {
  const state = fixture();
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(runtime.summarizeRuntimeV2ExecuteEvidence(restored, classifier), runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier));
  assert.equal(runtime.summarizeRuntimeV2ExecuteEvidence(restored, classifier).failedValidationCount, 0);
  assert.equal(deriveRuntimeV2ValidationCorrectionWindow(restored).active, false);
});

test("an unexecuted fake pass cannot erase an earlier real failed validation", () => {
  const state = fixture("execution_failed");
  state.events.push({ ...state.events.at(-1), sequence: 5, eventId: "skip-pass", passed: true, failureKind: "not_executed" });
  assert.equal(deriveRuntimeV2ValidationCorrectionWindow(state).active, true);
  const evidence = runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier);
  assert.equal(evidence.passedValidationCount, 0);
  assert.equal(evidence.failedValidationCount, 1);
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier)?.reason, "validation_failed");
});

test("canonical replay settles an unexecuted validator without ingesting fabricated evidence", () => {
  const f = fixture("not_executed", true);
  const run = f.run.identity;
  const event = (type, sequence, payload) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type, sequence, eventId: `replay-${sequence}`, at: sequence, ...payload });
  let state = runtime.transition(null, event("turn.admitted", 0, { turn: { ...run, workspaceKey: "/fixture", clientSubmissionId: "submission" }, strategy: "execute", objective: "Run checks", constraints: [], acceptanceCriteria: [] }));
  state = runtime.transition(state, event("run.started", 1, { run, phase: "validating" }));
  const scheduled = f.events.find((item) => item.type === "command.scheduled" && item.command.idempotencyKey === "validator").command;
  state = runtime.transition(state, event("command.scheduled", 2, { run, command: { ...scheduled, phase: "validating" } }));
  state = runtime.transition(state, event("validation.completed", 3, { run, idempotencyKey: "validator", passed: true, failureKind: "not_executed", evidence: [{ id: "fabricated", kind: "validation", target: "npm test" }] }));
  assert.deepEqual(state.evidence, []);
  assert.equal(state.scheduledCommands.length, 0, "transport settlement still closes the scheduled fence");
  assert.equal(state.events.at(-1).failureKind, "not_executed");
});
