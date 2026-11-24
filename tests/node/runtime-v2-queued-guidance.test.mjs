import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const runtime = load("src/lib/runtime-v2/index.ts");
const guidance = load("src/lib/runtime-v2/guidance.ts");
const ingress = load("src/lib/turnIngress.ts");
const { createRuntimeV2CheckpointPort } = load("src/store/runtimeV2/checkpointPort.ts");
const { createWorkspaceTurnQueueState, reduceWorkspaceTurnQueue, reconcileWorkspaceTurnQueueOnRestore } = load("src/store/workspaceTurnQueue.ts");
const { isQueuedWorkspaceGuidanceEligible } = load("src/store/workspaceGuidance.ts");

const turn = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch", clientSubmissionId: "original", turnId: "turn" };
const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: "run", parentRunId: null, attemptId: "attempt" };
const text = "Check the Editor Console.";

function event(checkpoint, draft) {
  const sequence = checkpoint?.aggregate.nextSequence ?? 0;
  return { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: `event-${sequence}-${draft.type}`,
    sequence, at: sequence + 1, ...draft };
}
function append(checkpoint, draft) {
  const result = runtime.appendRuntimeV2Checkpoint({
    checkpoint, owner: turn, expectedRevision: checkpoint?.revision ?? 0, event: event(checkpoint, draft),
  });
  assert.equal(result.disposition, "committed", result.reason);
  return result.checkpoint;
}
function started() {
  let checkpoint = append(null, { type: "turn.admitted", turn, strategy: "execute", objective: "Build the scene", constraints: [], acceptanceCriteria: [] });
  return append(checkpoint, { type: "run.started", run, phase: "observing" });
}
function request(checkpoint, key) {
  return append(checkpoint, { type: "command.scheduled", run, command: { kind: "request_model", phase: "observing", run, idempotencyKey: key, payload: { mode: "execute" } } });
}
function reply(key) {
  return { type: "provider.responded", run, idempotencyKey: key, result: { visibleText: "response", toolCalls: [], diagnostics: [] } };
}
function admitted() {
  return { type: "guidance.admitted", run, text, sourceReceiptId: "receipt" };
}
function queued() {
  const queue = createWorkspaceTurnQueueState({ sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch });
  const instruction = { schemaVersion: 1, kind: "workspace_instruction", clientSubmissionId: "queued", sessionKey: turn.sessionKey,
    sessionEpoch: turn.sessionEpoch, source: "composer", submittedAt: 1, payload: { text, dispatchHints: { subagentPreference: "preferred" } } };
  const receipt = { schemaVersion: 1, kind: "workspace_turn_receipt", receiptId: "receipt", clientSubmissionId: "queued",
    sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: "queued-turn", userBlockId: 2, acceptedAt: 1 };
  const added = reduceWorkspaceTurnQueue(queue, { type: "append", instruction, receipt, expectedVersion: queue.version, at: 1 }).state;
  return reduceWorkspaceTurnQueue(added, { type: "commit", ...queueOwner(), expectedVersion: added.version, at: 2 }).state;
}
function queueOwner() {
  return { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, receiptId: "receipt", clientSubmissionId: "queued" };
}
function promote(queue, owner = queueOwner()) {
  return reduceWorkspaceTurnQueue(queue, { type: "promote_to_guidance", ...owner, expectedVersion: queue.version, at: 3 });
}

test("only the exact unclaimed Composer receipt can leave FIFO as guidance", () => {
  const queue = queued();
  assert.ok(isQueuedWorkspaceGuidanceEligible(queue.entries[0]));
  const withExplicitIntent = { ...queue.entries[0], instruction: { ...queue.entries[0].instruction, payload: { text, dispatchHints: { explicitIntent: "plan" } } } };
  assert.equal(isQueuedWorkspaceGuidanceEligible(withExplicitIntent), false);
  const claimed = reduceWorkspaceTurnQueue(queue, { type: "claim", sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch,
    claimId: "dispatcher", expectedVersion: queue.version, at: 3 }).state;
  assert.equal(promote(claimed).disposition, "rejected");
  assert.equal(promote(queue, { ...queueOwner(), sessionEpoch: "replacement" }).disposition, "rejected");
  const promoted = promote(queue);
  assert.equal(promoted.disposition, "applied");
  assert.equal(promoted.state.entries.length, 0);
  const restored = reconcileWorkspaceTurnQueueOnRestore({ snapshot: JSON.parse(JSON.stringify(promoted.state)),
    sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, at: 4 });
  assert.equal(restored.entries.length, 0);
});

test("v2 Guide is exact, joins only the next model command and restores once across retries", () => {
  let checkpoint = request(started(), "in-flight");
  const selected = ingress.selectTurnIngressAvailability({
    checkpoint: null, runtimeV2Checkpoint: checkpoint, expectedOwner: turn, strategy: "execute", runtimeOwnerObserved: true,
  });
  assert.deepEqual(selected.guidanceTarget, run);
  checkpoint = append(checkpoint, admitted());
  const deliveryId = checkpoint.aggregate.events.at(-1).eventId;
  assert.equal(guidance.runtimeV2PendingGuidance(checkpoint.aggregate).eventId, deliveryId);
  assert.deepEqual(guidance.runtimeV2GuidanceForModelRequest(checkpoint.aggregate, run, "in-flight"), []);
  checkpoint = append(checkpoint, reply("in-flight"));
  assert.equal(runtime.decideNextCommands(checkpoint.aggregate, { resultKind: "success", resultReason: "old answer" })[0].kind, "request_model");
  checkpoint = request(checkpoint, "next");
  const raw = JSON.parse(JSON.stringify(runtime.serializeRuntimeV2CheckpointMap({ turn: checkpoint }).turn));
  const restored = runtime.normalizeRuntimeV2Checkpoint(raw, turn);
  assert.ok(restored);
  const messages = [{ role: "user", content: "Build the scene", runtimeTurnId: "turn" }];
  guidance.appendRuntimeV2GuidanceHistory(messages, restored.aggregate, run, "next");
  guidance.appendRuntimeV2GuidanceHistory(messages, restored.aggregate, run, "next");
  assert.deepEqual(messages.filter(message => message.runtimeGuidanceId), [{ role: "user", content: text, runtimeGuidanceId: deliveryId }]);
  assert.deepEqual(guidance.runtimeV2GuidanceForModelRequest(restored.aggregate, { ...run, attemptId: "replacement" }, "next"), []);
  assert.equal(guidance.runtimeV2GuidanceDelivery(restored.aggregate, deliveryId), "waiting");
  checkpoint = append(restored, reply("next"));
  assert.equal(guidance.runtimeV2GuidanceDelivery(checkpoint.aggregate, deliveryId), "applied");
});

test("durable guidance commits with FIFO removal and permits the in-flight result to rebase", async () => {
  const base = request(started(), "in-flight");
  let state = { runtimeV2Checkpoints: { turn: base }, workspaceTurnQueue: queued(),
    sessionsByWorkspace: { "/fixture": [{ id: 1 }] }, config: { sessionRecordingEnabled: true } };
  let shouldFail = true;
  const writes = [];
  const adapter = {
    get: () => state, set: patch => { state = { ...state, ...patch }; }, scopeKey: "/fixture", sessionId: 1,
    getSessionRevisionToken: () => 1, sanitizeTaskBlocksForPersist: blocks => blocks,
    buildSessionRuntimeSnapshot: candidate => ({ queue: candidate.workspaceTurnQueue,
      checkpoint: runtime.serializeRuntimeV2CheckpointMap(candidate.runtimeV2Checkpoints).turn }),
    persistSessionRecord: async (_scope, session, options) => {
      assert.equal(options.isCurrent(), true);
      if (shouldFail) throw new Error("offline");
      writes.push(session.runtimeSnapshot);
    },
    publishOwnerScopedRuntimeProjection: ({ projectedState, durableState }) => {
      state = durableState || projectedState;
      return { published: true };
    },
    logStoreEvent() {},
  };
  const port = createRuntimeV2CheckpointPort(adapter);
  const converter = createRuntimeV2CheckpointPort({ ...adapter, projectGuidance: candidate => {
    const promoted = promote(candidate.workspaceTurnQueue);
    return promoted.disposition === "applied" ? { workspaceTurnQueue: promoted.state } : null;
  } });
  const conversion = { owner: turn, expectedRevision: base.revision, event: event(base, admitted()) };
  await assert.rejects(() => converter.append(conversion), /checkpoint_persist_failed/);
  assert.equal(state.workspaceTurnQueue.entries.length, 1);
  assert.equal(state.runtimeV2Checkpoints.turn.revision, base.revision);
  shouldFail = false;
  const [guided, answered] = await Promise.all([converter.append(conversion), port.append({
    owner: turn, expectedRevision: base.revision, event: event(base, reply("in-flight")),
  })]);
  assert.equal(guided.disposition, "committed");
  assert.equal(answered.disposition, "committed");
  assert.deepEqual(writes.map(write => write.queue.entries.length), [0, 0]);
  assert.deepEqual(writes.map(write => write.checkpoint.events.at(-1).type), ["guidance.admitted", "provider.responded"]);
});

test("normal finalization yields when a Guide commits after the runner's last decision", async () => {
  const base = started();
  let state = { runtimeV2Checkpoints: { turn: base }, config: { sessionRecordingEnabled: false } };
  const port = createRuntimeV2CheckpointPort({
    get: () => state, set() {}, scopeKey: "/fixture", sessionId: null,
    getSessionRevisionToken: () => state, sanitizeTaskBlocksForPersist: blocks => blocks,
    buildSessionRuntimeSnapshot: () => null, persistSessionRecord: async () => {},
    publishOwnerScopedRuntimeProjection: ({ projectedState }) => {
      state = projectedState;
      return { published: true };
    },
    logStoreEvent() {},
  });
  let ids = 0;
  let outbound;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: port,
    provider: { async request({ command }) {
      outbound = guidance.runtimeV2GuidanceForModelRequest(state.runtimeV2Checkpoints.turn.aggregate, run, command.idempotencyKey);
      return { visibleText: "The Editor Console has been considered.", toolCalls: [], diagnostics: [] };
    } },
    tool: { async execute() { throw new Error("unexpected tool"); } },
    scheduler: { async execute() { throw new Error("unexpected child"); } },
    projection: { async publish() {} },
    clockId: { now: () => 20 + ids, nextId: scope => `${scope}-${++ids}`, nextIdempotencyKey: () => `command-${++ids}` },
  }, { aggregate: base.aggregate, revision: base.revision });
  assert.equal((await port.append({ owner: turn, expectedRevision: base.revision, event: event(base, admitted()) })).disposition, "committed");
  await controller.driveOnce({ resultKind: "success", resultReason: "Old decision" });
  assert.deepEqual(outbound.map(item => item.text), [text]);
  assert.equal(controller.snapshot().aggregate.terminalOutcome, null);
});
