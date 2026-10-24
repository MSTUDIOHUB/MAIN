import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const runtime = load("src/lib/runtime-v2/index.ts");
const { resolveRuntimeV2ExecutionBlocker: resolve, deriveRuntimeV2ExecutionBlocker: derive,
  projectRuntimeV2ExecutionBlocker: project } = load("src/store/runtimeV2/executionBlocker.ts");
const { installRuntimeV2ExecutionDecisionReplay: installReplay } = load("src/store/runtimeV2/executionDecisionReplay.ts");
const { toUserChoiceResolutionIdentity } = load("src/lib/actionRequest.ts");
const turn = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch", clientSubmissionId: "submit", turnId: "turn" };
const run = { ...turn, runId: "run", parentRunId: null, attemptId: "attempt" };
function fixture(decision, clarification) {
  const event = (state, type, fields) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type,
    eventId: `${type}:${state?.nextSequence || 0}`, sequence: state?.nextSequence || 0, at: (state?.updatedAt || 0) + 1, ...fields });
  let aggregate = runtime.transition(null, event(null, "turn.admitted", { turn, strategy: "execute", objective: "Fix fixture", constraints: [], acceptanceCriteria: ["Works"] }));
  aggregate = runtime.transition(aggregate, event(aggregate, "run.started", { run, phase: "observing" }));
  aggregate = runtime.transition(aggregate, event(aggregate, "run.paused", { run, blocker: { requestId: "choice", reasonCode: "recovery_stalled", evidenceSequence: 1,
    message: "Check prerequisite", options: ["recheck", "stop"], ...(clarification ? { reasonCode: "intent_clarification", clarification } : {}) } }));
  if (decision) aggregate = runtime.transition(aggregate, event(aggregate, "run.decision_recorded", { run, requestId: "choice", choice: decision }));
  const checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
  let state = { currentTurnId: "turn", currentSessionId: 1, isGenerating: false, taskFlow: [],
    conversationTurns: [{ id: "turn", userPrompt: "Fix fixture" }], _nextTaskId: () => 1,
    harnessRunMarker: { ...run, status: "paused", startedAt: 1, instanceId: "instance" },
    runtimeV2Checkpoints: { turn: checkpoint }, sessionsByWorkspace: { "/fixture": [{ id: 1, storageRevision: 1 }] } };
  const get = () => state;
  const listeners = new Set();
  const set = patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; listeners.forEach(fn => fn()); };
  project({ aggregate, get, set, language: "zh" });
  let dispatched = 0, stopped = 0;
  const input = { get, set, identity: toUserChoiceResolutionIdentity(state.activeActionRequest), choice: decision || "recheck", sessionEpoch: "epoch",
    persist: async projected => projected,
    dispatch: () => { dispatched++; set({ activeActionRequest: null, isGenerating: true }); }, stop: () => { stopped++; } };
  return { get, set, input, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, counts: () => ({ dispatched, stopped }) };
}

test("a blocker decision is persisted before scheduling and concurrent clicks dispatch once", async () => {
  const f = fixture(); let finish; let writes = 0;
  f.input.persist = async projected => { writes++; await new Promise(done => { finish = done; });
    return { ...projected, sessionsByWorkspace: { "/fixture": [{ id: 1, storageRevision: 2 }] } }; };
  const first = resolve(f.input);
  assert.deepEqual(f.counts(), { dispatched: 0, stopped: 0 });
  assert.equal(await resolve(f.input), false);
  finish(); assert.equal(await first, true);
  assert.equal(writes, 1);
  assert.equal(f.get().sessionsByWorkspace["/fixture"][0].storageRevision, 2);
  assert.equal(f.get().runtimeV2Checkpoints.turn.aggregate.run.blocker.decision, "recheck");
  assert.equal(f.counts().dispatched, 1);
});

test("clarification answer persists as user history before same-Run dispatch and restores cold", async () => {
  const clarification = { kind: "target_ambiguity", field: "target", evidence: "staging or production", question: "Which target?", choices: ["staging", "production"] };
  const f = fixture(undefined, clarification);
  assert.equal(f.get().activeActionRequest.allowCustomReply, true);
  assert.deepEqual(f.get().activeActionRequest.optionValues, ["staging", "production", "stop"]);
  f.input.choice = "staging";
  f.input.persist = async projected => {
    const canonical = runtime.serializeRuntimeV2CheckpointMap(projected.runtimeV2Checkpoints);
    assert.equal(canonical.turn.aggregate, undefined);
    assert.equal(canonical.turn.events.at(-1).reply, "staging");
    assert.equal(f.counts().dispatched, 0);
    return projected;
  };
  assert.equal(await resolve(f.input), true);
  const restored = runtime.normalizeRuntimeV2CheckpointMap(runtime.serializeRuntimeV2CheckpointMap(f.get().runtimeV2Checkpoints)).turn.aggregate;
  assert.equal(restored.run.blocker.decisionReply, "staging");
  const live = load("src/store/runtimeV2/executionTypes.ts").createRuntimeV2LiveExecutionState();
  load("src/store/runtimeV2/executionProviderHistory.ts").restoreRuntimeV2ExecutionHistory(live, restored);
  assert.deepEqual(live.messages, [{ role: "user", content: "staging" }]);
  assert.equal(restored.events.filter(event => event.type === "turn.completed").length, 0);
  assert.equal(f.counts().dispatched, 1);
});

for (const drift of ["epoch", "request", "switch", "replacement", "revision"]) {
  test(`late blocker persistence cannot schedule after ${drift} drift`, async () => {
    const f = fixture(); let finish;
    f.input.persist = async projected => { await new Promise(done => { finish = done; }); return projected; };
    const pending = resolve(f.input);
    if (drift === "epoch") f.set({ runtimeV2Checkpoints: { turn: { ...f.get().runtimeV2Checkpoints.turn, owner: { ...turn, sessionEpoch: "new" } } } });
    if (drift === "request") f.set({ activeActionRequest: { ...f.get().activeActionRequest, requestId: "different" } });
    if (drift === "switch") f.set({ currentTurnId: "another" });
    if (drift === "replacement") f.set({ harnessRunMarker: { ...f.get().harnessRunMarker, instanceId: "replacement" } });
    if (drift === "revision") f.set({ runtimeV2Checkpoints: { turn: { ...f.get().runtimeV2Checkpoints.turn, revision: 100 } } });
    finish(); assert.equal(await pending, false);
    assert.equal(f.counts().dispatched, 0);
  });
}

test("failed persistence never authorizes resume and stop has a durable decision", async () => {
  const f = fixture(); f.input.persist = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(resolve(f.input), /disk unavailable/);
  assert.equal(f.get().runtimeV2Checkpoints.turn.aggregate.run.blocker.decision, undefined);
  f.input.persist = async projected => projected; f.input.choice = "stop";
  assert.equal(await resolve(f.input), true);
  assert.equal(f.get().runtimeV2Checkpoints.turn.aggregate.run.blocker.decision, "stop");
  assert.deepEqual(f.counts(), { dispatched: 0, stopped: 1 });
});

test("cold ledger restore replays an already committed decision exactly once", async () => {
  const f = fixture("recheck");
  f.set({ runtimeV2Checkpoints: runtime.normalizeRuntimeV2CheckpointMap(runtime.serializeRuntimeV2CheckpointMap(f.get().runtimeV2Checkpoints)) });
  const tasks = [];
  f.set({ sendMessage: (_text, _files, options) => { f.input.identity = options.replyOptionRequestIdentity; tasks.push(resolve(f.input)); return true; } });
  const unsubscribe = installReplay({ getState: f.get, subscribe: f.subscribe });
  f.set({ elapsedTime: 1 });
  await new Promise(done => setImmediate(done)); await Promise.all(tasks);
  assert.equal(tasks.length, 1); assert.equal(f.counts().dispatched, 1);
  assert.equal(f.get().runtimeV2Checkpoints.turn.aggregate.events.filter(event => event.type === "run.decision_recorded").length, 1);
  unsubscribe();
});

test("a cycle pauses only when the exact rejection was visible to the model", () => {
  const f = fixture();
  const aggregate = f.get().runtimeV2Checkpoints.turn.aggregate;
  const receipt = { call: { id: "call", name: "read_skill", arguments: {} }, actionIdentity: "hash", status: "rejected", reasonCode: "tool_surface_rejected", feedback: "INTERNAL_CODE", priorFeedbackObserved: false };
  const response = { type: "provider.responded", sequence: 9, result: { actionReceipts: [receipt] } };
  const state = { ...aggregate, events: [...aggregate.events, response] };
  assert.equal(derive(state, "choice-2", "zh"), null);
  receipt.priorFeedbackObserved = true;
  const blocker = derive(state, "choice-2", "zh");
  assert.equal(blocker.reasonCode, "rejected_action_cycle");
  assert.deepEqual(blocker.options, ["recheck", "stop"]);
  assert.doesNotMatch(blocker.message, /INTERNAL_CODE/);
});

test("recheck can reopen a pre-execution denial but cannot replay a command that already ran and failed", () => {
  const { deriveRuntimeV2ProviderEffectFacts: facts } = load("src/store/runtimeV2/executionProviderEffectFacts.ts");
  const { runtimeV2ProviderToolCallIdentity } = load("src/store/runtimeV2/providerToolSurface.ts");
  const call = { name: "run_command", arguments: { command: "create-and-fail" } };
  const identity = runtimeV2ProviderToolCallIdentity(call);
  for (const [status, failureKind, shouldStayClosed] of [["failed", "execution_failed", true], ["blocked", "not_authorized", false]]) {
    const aggregate = { events: [
      { type: "command.scheduled", sequence: 1, command: { idempotencyKey: "cmd", kind: "execute_tool", payload: { toolName: call.name, arguments: call.arguments, toolCallId: "call" } } },
      { type: "tool.completed", sequence: 2, idempotencyKey: "cmd", status, failureKind, evidence: [] },
      { type: "run.paused", sequence: 3, blocker: { requestId: "choice", actionIdentity: identity } },
      { type: "run.resumed", sequence: 5, requestId: "choice" },
    ] };
    assert.equal(facts(aggregate).rejectedActionIdentities.has(identity), shouldStayClosed);
  }
});
