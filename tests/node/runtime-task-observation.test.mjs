import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
const { observeRuntimeTask } = createTsModuleLoader()("tests/e2e/runtimeTaskObservation.ts");
const outcome = { status: "completed", runId: "admission-run", parentRunId: null, resultKind: "blocked", reason: "admission", updatedAt: 1 };
const fixture = () => ({ currentTurnId: "turn", currentSessionId: 1, isGenerating: false, checkpoint: null,
  conversationTurns: [{ id: "turn", runtimeOutcome: outcome }], taskFlow: [{ turnId: "turn", type: "agent", visibility: "assistant_final", content: "Blocked" }],
  runtimeEvents: [{ type: "run.completed", turnId: "turn", runId: "admission-run", parentRunId: null, resultKind: "blocked" }, { type: "turn.completed", turnId: "turn", resultKind: "blocked" }] });
test("admission terminal is observable without a v2 checkpoint and must not be canceled by cleanup", () => {
  const result = observeRuntimeTask(fixture());
  assert.equal(result.state, "terminal");
  assert.equal(result.outcome.resultKind, "blocked");
  assert.equal(result.shouldCancel, false);
  assert.deepEqual(result.consistencyErrors, []);
});
test("the exact submitted owner survives a cleared or changed active Turn pointer", () => {
  for (const currentTurnId of [null, "different-active-turn"]) {
    const result = observeRuntimeTask({ ...fixture(), currentTurnId, targetTurnId: "turn" });
    assert.equal(result.state, "terminal");
    assert.equal(result.shouldCancel, false);
    assert.deepEqual(result.consistencyErrors, []);
  }
  assert.equal(observeRuntimeTask({ ...fixture(), targetTurnId: "unrelated" }).state, "running");
});
test("idle, a child terminal or a stale Turn cannot conclude the current task", () => {
  const snapshot = fixture();
  snapshot.conversationTurns[0].runtimeOutcome = undefined;
  assert.equal(observeRuntimeTask({ ...snapshot, runtimeEvents: [] }).state, "running");
  snapshot.runtimeEvents[0].parentRunId = "parent";
  assert.equal(observeRuntimeTask(snapshot).state, "running");
  assert.equal(observeRuntimeTask({ ...fixture(), currentTurnId: "different" }).state, "running");
});
test("an inconsistent canonical conclusion remains evidence and cannot be overwritten by cleanup", () => {
  const snapshot = fixture();
  snapshot.runtimeEvents[1].resultKind = "error";
  const result = observeRuntimeTask(snapshot);
  assert.equal(result.shouldCancel, false);
  assert.ok(result.consistencyErrors.length > 0);
});
test("an already committed conclusion waits for presentation without authorizing cancellation", () => {
  const snapshot = { ...fixture(), taskFlow: [] };
  const result = observeRuntimeTask(snapshot);
  assert.equal(result.state, "running");
  assert.equal(result.shouldCancel, false);
  assert.equal(result.outcome.resultKind, "blocked");
});
test("the previous round-2 evidence is classified as admission blocked rather than a cleanup timeout", () => {
  const file = "test-results/ornith-system-repair-20261022-v2/round-2/runtime.json";
  if (!fs.existsSync(file)) return;
  const previous = JSON.parse(fs.readFileSync(file, "utf8"));
  const turnId = previous.runtimeEvents.find(event => event.type === "turn.completed").turnId;
  const result = observeRuntimeTask({ ...previous, currentTurnId: turnId, conversationTurns: [{ id: turnId, runtimeOutcome: { ...outcome, runId: previous.runtimeEvents.find(event => event.type === "run.completed").runId } }] });
  assert.equal(result.state, "terminal");
  assert.equal(result.outcome.resultKind, "blocked");
  assert.equal(result.shouldCancel, false);
});
