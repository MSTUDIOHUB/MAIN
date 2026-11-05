import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
const load = createTsModuleLoader();
const { deriveRuntimeV2ProviderEffectFacts: facts } = load("src/store/runtimeV2/executionProviderEffectFacts.ts");
const { runtimeV2ProviderToolCallIdentity: identity, completedRuntimeV2ProviderToolCallIdentities: completed } = load("src/store/runtimeV2/providerReadReceipts.ts");
const { boundRuntimeV2ProviderToolCalls: bound } = load("src/store/runtimeV2/providerToolSurface.ts");
const { decideRuntimeV2SemanticFailureRecovery: recovery } = load("src/lib/runtime-v2/controllerRecovery.ts");
const runtime = load("src/lib/runtime-v2/index.ts");
const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submit", turnId: "turn" };
const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
const calls = [{ id: "shell", name: "run_command", arguments: { command: "find / -name SKILL.md", description: "Inspect" } },
  { id: "skill-1", name: "load_skill", arguments: { skill_id: "s:cli" } }, { id: "skill-2", name: "load_skill", arguments: { skill_id: "s:pipeline" } }];
function fixture(reason = "provider_batch_predecessor_failed", reflected = false) {
  let state = null;
  const append = (type, fields) => { state = runtime.transition(state, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type, sequence: state?.nextSequence || 0,
    eventId: `event-${state?.nextSequence || 0}`, at: state?.nextSequence || 0, ...fields }); };
  append("turn.admitted", { turn, strategy: "execute", objective: "Inspect environment and read Skill guidance", acceptanceCriteria: [], constraints: [] });
  append("run.started", { run, phase: "observing" });
  const commands = calls.map(call => ({ kind: "execute_tool", idempotencyKey: call.id, phase: "observing", run, payload: { toolName: call.name, arguments: call.arguments, toolCallId: call.id } }));
  for (const [index, command] of commands.entries()) {
    append("command.scheduled", { run, command });
    append("tool.completed", { run, idempotencyKey: command.idempotencyKey, status: "blocked", evidence: [], failureKind: index === 0 ? "not_authorized" : "execution_failed",
      ...(index ? { failureReasonCode: reason } : {}), modelContent: index ? "TOOL_NOT_EXECUTED: predecessor failed" : "TOOL_BLOCKED: outside workspace" });
  }
  if (reflected) {
    const command = { kind: "request_model", idempotencyKey: "request", phase: "observing", run, payload: {} };
    append("command.scheduled", { run, command });
    append("provider.responded", { run, idempotencyKey: command.idempotencyKey, result: { toolCalls: [], diagnostics: [], visibleText: "", actionReceipts: [{ call: { ...calls[1], id: "reflected" },
      actionIdentity: identity(calls[1]), status: "rejected", reasonCode: "already_rejected", feedback: "Prior rejection", priorFeedbackObserved: true }] } });
  }
  return { state, commands };
}

for (const reason of ["provider_batch_predecessor_failed", "provider_batch_predecessor_unsettled"]) {
  test(`unexecuted Skill siblings remain eligible independently after ${reason}`, () => {
    const { state } = fixture(reason); const effects = facts(state);
    for (const call of calls.slice(1)) {
      assert.equal(effects.unexecutedToolCallIds.has(call.id), true);
      assert.equal(effects.failedToolCallIds.has(call.id), false);
      assert.equal(effects.rejectedActionIdentities.has(identity(call)), false);
      assert.deepEqual(bound([call], new Set(), effects.rejectedActionIdentities).accepted, [call]);
    }
    assert.equal(effects.rejectedActionIdentities.has(identity(calls[0])), true, "the actual shell policy denial stays closed");
    const messages = [{ role: "assistant", content: "", tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) },
      ...calls.map(call => ({ role: "tool", tool_call_id: call.id, content: "Transport settled" }))];
    assert.equal(completed(messages, effects).size, 0, "neither rejected nor unexecuted calls become completed effects");
  });
}

test("cold restore cannot promote an old already_rejected reflection into a new intrinsic denial", () => {
  const { state } = fixture(undefined, true);
  const checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt });
  const cold = runtime.normalizeRuntimeV2Checkpoint(runtime.serializeRuntimeV2CheckpointMap({ turn: checkpoint }).turn).aggregate;
  for (const aggregate of [state, cold]) {
    assert.equal(facts(aggregate).rejectedActionIdentities.has(identity(calls[1])), false);
    assert.equal(facts(aggregate).rejectedActionIdentities.has(identity(calls[0])), true);
  }
});

test("a skipped receipt does not create an action-failure recovery fact", () => {
  const { state, commands } = fixture();
  const event = state.events.find(event => event.type === "tool.completed" && event.idempotencyKey === "skill-1");
  assert.equal(recovery({ aggregate: state, command: commands[1], event }), null);
  const actual = state.events.find(event => event.type === "tool.completed" && event.idempotencyKey === "shell");
  assert.equal(recovery({ aggregate: state, command: commands[0], event: actual }).kind, "record");
});

test("actual failed execution and explicit admission denial remain rejected", () => {
  for (const [status, failureKind] of [["failed", "execution_failed"], ["blocked", "not_authorized"]]) {
    const { state } = fixture();
    const modified = { ...state, events: state.events.map(event => event.type === "tool.completed" && event.idempotencyKey === "skill-1"
      ? { ...event, status, failureKind, failureReasonCode: undefined } : event) };
    assert.equal(facts(modified).rejectedActionIdentities.has(identity(calls[1])), true);
  }
});
