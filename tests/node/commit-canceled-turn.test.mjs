import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (fsSync.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { commitCanceledTurn } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/commitCanceledTurn.ts"),
);
const { captureCanceledTurnControlPlaneFence } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/canceledTurnProjection.ts"),
);
const { createSubmitSessionRuntimeController } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitSessionRuntimeController.ts"),
);
const runtimeV2 = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
);
const { createRuntimeV2CheckpointPort } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/runtimeV2/checkpointPort.ts"),
);
const { createProjectSessionMutationCoordinator } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/projectSessionMutationCoordinator.ts"),
);
const { withSubmitSessionPersistenceOwner } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/persistSubmitRuntimeProjection.ts"),
);
const { createSubmitSessionRuntimeFacade } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitRuntimeFacade.ts"),
);
const {
  awaitCanceledTurnTerminalProjection,
  beginSessionCancellation,
  deferUntilSessionCancellationSettled,
  getPendingSessionCancellation,
  hasCanceledTurnTerminalProjection,
  resolveDeferredSessionSubmissionDecision,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/sessionCancellationBarrier.ts"),
);

test("a stale runtime observes the cancellation owner instead of writing a second terminal", async () => {
  const sessionKey = "/tmp/project:runtime-cancel-owner";
  const turnId = "turn-runtime-cancel";
  let releaseCancellation;
  const gate = new Promise((resolve) => {
    releaseCancellation = resolve;
  });
  let projection = { runtimeEvents: [], taskFlow: [] };
  const { cancellation } = beginSessionCancellation(
    sessionKey,
    turnId,
    async () => {
      await gate;
      projection = {
        runtimeEvents: [
          { type: "run.aborted", threadId: sessionKey, turnId, runId: "run-1" },
          { type: "run.completed", threadId: sessionKey, turnId, runId: "run-1", resultKind: "canceled" },
          { type: "turn.completed", threadId: sessionKey, turnId, resultKind: "canceled" },
        ],
        taskFlow: [{ type: "agent", turnId, visibility: "assistant_final" }],
      };
      return {
        sessionKey,
        turnId,
        terminalSettled: true,
        disposition: "committed_durable",
      };
    },
  );

  const observed = awaitCanceledTurnTerminalProjection({
    sessionKey,
    turnId,
    getProjection: () => projection,
  });
  releaseCancellation();
  assert.equal(await observed, true);
  await cancellation.promise;
  assert.equal(getPendingSessionCancellation(sessionKey), null);
  assert.equal(await awaitCanceledTurnTerminalProjection({
    sessionKey,
    turnId,
    getProjection: () => projection,
  }), true, "the canonical projection remains sufficient after the fence is released");
});

function createState(overrides = {}) {
  return {
    currentTurnId: "turn-1",
    taskFlow: [{ id: 1, turnId: "turn-1", type: "user", content: "stop" }],
    conversationTurns: [{
      id: "turn-1",
      userPrompt: "stop",
      status: "executing",
      collapsed: false,
      elapsedTime: 0,
      blockIds: [1],
    }],
    runtimeEvents: [{
      schemaVersion: 2,
      type: "run.started",
      threadId: "session-1",
      turnId: "turn-1",
      timestampMs: 1,
      runId: "run-1",
      parentRunId: null,
    }],
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "instance-1",
      runId: "run-1",
      sessionKey: "session-1",
      turnId: "turn-1",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
      closedAt: null,
      closeReason: null,
    },
    activeActionRequest: null,
    agentStatus: "running",
    isGenerating: true,
    abortController: {},
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  let state = createState(overrides.state);
  let revisionToken = {};
  let nextTaskId = 2;
  const order = [];
  const persisted = [];
  const published = [];
  return {
    get state() { return state; },
    get order() { return order; },
    get persisted() { return persisted; },
    get published() { return published; },
    setState(next) { state = next; },
    replaceRevision() { revisionToken = {}; },
    input: {
      sessionKey: "session-1",
      scopeKey: "/tmp/project",
      sessionId: 1,
      turnId: "turn-1",
      runId: "run-1",
      reason: "user_cancelled",
      message: "Canceled and closed.",
      controlPlaneFence: captureCanceledTurnControlPlaneFence({
        state,
        sessionKey: "session-1",
        turnId: "turn-1",
        runId: "run-1",
      }),
      nextTaskId: () => nextTaskId++,
      sessionGet: () => state,
      getSessionRevisionToken: () => revisionToken,
      persistProjection: async (projected) => {
        order.push("persist");
        persisted.push(projected);
        return { ...projected, durable: true };
      },
      publishProjection: (publication) => {
        order.push("publish");
        published.push(publication);
        publication.beforePublish?.();
        state = publication.durableState || publication.projectedState;
        revisionToken = {};
        return { published: true, disposition: "published" };
      },
      nowMs: () => 10,
      ...overrides.input,
    },
  };
}

function runtimeCheckpoint(overrides = {}) {
  const owner = {
    workspaceKey: "/tmp/project", sessionKey: "session-1", sessionEpoch: "epoch-1",
    clientSubmissionId: "submission-1", turnId: "turn-1",
    ...overrides.owner,
  };
  const run = { sessionKey: owner.sessionKey, sessionEpoch: owner.sessionEpoch,
    turnId: owner.turnId, runId: "run-1", parentRunId: null, attemptId: "attempt-1" };
  let aggregate = runtimeV2.transition(null, {
    schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: 0, eventId: "admission-1", at: 1,
    type: "turn.admitted", turn: owner, strategy: "chat", objective: "Question",
    constraints: [], acceptanceCriteria: [],
  });
  aggregate = runtimeV2.transition(aggregate, {
    schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: 1, eventId: "run-1-start", at: 2,
    type: "run.started", run, phase: "observing",
  });
  return runtimeV2.createRuntimeV2Checkpoint({ revision: 2, aggregate, updatedAt: 2, ...overrides });
}

test("late Stop replays an existing successful v2 conclusion without cancellation events", async () => {
  let checkpoint = runtimeCheckpoint();
  const append = (type, fields) => {
    const event = { schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: checkpoint.aggregate.nextSequence, eventId: `terminal-${checkpoint.revision}`,
      at: checkpoint.updatedAt + 1, type, ...fields };
    checkpoint = runtimeV2.appendRuntimeV2Checkpoint({
      checkpoint, owner: checkpoint.owner, expectedRevision: checkpoint.revision, event,
    }).checkpoint;
  };
  const run = checkpoint.aggregate.run.identity;
  append("phase.changed", { run, phase: "finalizing", reason: "answer_ready" });
  const finalProjection = runtimeV2.buildRuntimeV2FinalProjection(checkpoint.aggregate, "successful-final", "success", "answer_ready", "Verified answer.");
  const outcome = { resultKind: "success", reason: "answer_ready", completedAt: 5, finalProjectionId: finalProjection.id };
  append("run.completed", { run, outcome, finalProjection });
  const harness = createHarness({ state: { runtimeV2Checkpoints: { "turn-1": checkpoint } } });
  const result = await commitCanceledTurn(harness.input);
  assert.equal(result.committed, true);
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.resultKind, "success");
  assert.equal(harness.state.harnessRunMarker.terminalResultKind, "success");
  const restored = runtimeV2.normalizeRuntimeV2Checkpoint(harness.state.runtimeV2Checkpoints["turn-1"]);
  assert.equal(restored.aggregate.events.some((event) => event.type === "run.aborted"), false);
  assert.equal(restored.aggregate.events.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(restored.aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
  assert.equal(harness.state.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
});

test("late Stop preserves the original successful final when its old terminal lacks a projection and the ledger is full", async () => {
  let aggregate = runtimeCheckpoint().aggregate;
  const run = aggregate.run.identity;
  const append = (type, fields) => {
    aggregate = runtimeV2.transition(aggregate, {
      schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: aggregate.nextSequence, eventId: `old-success-${aggregate.nextSequence}`,
      at: aggregate.updatedAt + 1, type, ...fields,
    });
  };
  append("phase.changed", { run, phase: "finalizing", reason: "answer_ready" });
  while (aggregate.events.length < 2047) {
    const projection = { id: `old-success-view-${aggregate.nextSequence}`, audience: "timeline", markdown: "Progress", kind: "timeline", dedupeKey: `old-success-view-${aggregate.nextSequence}` };
    append("projection.published", { run, audience: "timeline", projectionId: projection.id, projection });
  }
  append("run.completed", { run, outcome: { resultKind: "success", reason: "answer_ready", completedAt: aggregate.updatedAt + 1, finalProjectionId: "old-success-final" } });
  const checkpoint = runtimeV2.createRuntimeV2Checkpoint({ revision: 2048, aggregate, updatedAt: aggregate.updatedAt });
  const harness = createHarness({
    state: { runtimeV2Checkpoints: { "turn-1": checkpoint }, taskFlow: [
      { id: 1, turnId: "turn-1", type: "user", content: "Question" },
      { id: 2, turnId: "turn-1", type: "agent", visibility: "assistant_final", content: "Verified answer." },
    ], conversationTurns: [{ ...createState().conversationTurns[0], status: "done", summary: "Verified answer.", blockIds: [1, 2],
      runtimeOutcome: { status: "completed", resultKind: "success", reason: "answer_ready", runId: run.runId, parentRunId: null, updatedAt: aggregate.updatedAt },
    }] }, input: { nowMs: Date.now },
  });
  const result = await commitCanceledTurn(harness.input);
  assert.equal(result.disposition, "already_closed_durable");
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.resultKind, "success");
  assert.equal(harness.state.runtimeV2EmergencyTerminalEnvelopes?.["turn-1"], undefined);
  assert.deepEqual(harness.state.taskFlow.filter((block) => block.visibility === "assistant_final").map((block) => block.content), ["Verified answer."]);
  assert.equal(harness.state.runtimeV2Checkpoints["turn-1"].aggregate.events.length, 2048);
});

function scopedCancellationFixture() {
  const scopeKey = "/tmp/project";
  const sessionKey = `${scopeKey}:1`;
  const keys = ["currentTurnId", "taskFlow", "conversationTurns", "runtimeEvents", "runtimeV2Checkpoints",
    "harnessRunMarker", "activeActionRequest", "agentStatus", "isGenerating", "abortController",
    "elapsedTime", "pendingReviewResolve", "pendingReviewTaskId", "pendingToolCall"];
  const initial = createState();
  const source = { current: {
    ...initial, currentWorkspace: scopeKey, currentSessionId: 1, runtimeBySessionKey: {},
    runtimeEvents: initial.runtimeEvents.map((event) => ({ ...event, threadId: sessionKey })),
    harnessRunMarker: { ...initial.harnessRunMarker, sessionKey },
    runtimeV2Checkpoints: { "turn-1": runtimeCheckpoint({ owner: { sessionKey } }) },
    sessionsByWorkspace: { [scopeKey]: [{ id: 1, storageRevision: 57, planLifecycleEpoch: "epoch-1" }] },
  } };
  const pick = (state) => Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
  const facade = createSubmitSessionRuntimeFacade({
    get: () => source.current,
    set: (patch) => { source.current = { ...source.current, ...(typeof patch === "function" ? patch(source.current) : patch) }; },
    runSessionKey: sessionKey, createRuntimeFromState: pick, pickRuntimePatch: pick,
  });
  facade.seedSessionRuntime();
  let releasePersistence;
  let notifyPersistence;
  const gate = new Promise((resolve) => { releasePersistence = resolve; });
  const started = new Promise((resolve) => { notifyPersistence = resolve; });
  const persisted = [];
  const input = {
    sessionKey, scopeKey, sessionId: 1, turnId: "turn-1", runId: "run-1",
    reason: "user_cancelled", message: "Canceled.", nextTaskId: () => 99, nowMs: () => 10,
    sessionGet: facade.sessionGet, getSessionRevisionToken: facade.getSessionRevisionToken,
    isCurrent: facade.hasSessionRuntimeOwnership,
    publishProjection: facade.publishOwnerScopedRuntimeProjection,
    controlPlaneFence: captureCanceledTurnControlPlaneFence({ state: facade.sessionGet(), sessionKey, turnId: "turn-1", runId: "run-1" }),
    persistProjection: async (projected, options) => {
      notifyPersistence();
      await gate;
      if (!options.isCurrent()) {
        throw Object.assign(new Error("old owner"), { code: "project_session_stale_write_fenced" });
      }
      persisted.push(projected);
      return { ...projected, sessionsByWorkspace: { [scopeKey]: [{ ...projected.sessionsByWorkspace[scopeKey][0], storageRevision: 58 }] } };
    },
  };
  return { source, facade, input, persisted, started, releasePersistence, sessionKey, scopeKey };
}

test("a switched Session keeps the captured cancellation durable without touching the visible Session", async () => {
  const fixture = scopedCancellationFixture();
  const pending = commitCanceledTurn(fixture.input);
  await fixture.started;
  const visibleController = new AbortController();
  fixture.source.current = { ...fixture.source.current, currentSessionId: 2, currentTurnId: "turn-visible",
    taskFlow: [{ id: 200, type: "user", turnId: "turn-visible", content: "Visible" }],
    conversationTurns: [{ id: "turn-visible", status: "executing", blockIds: [200] }],
    runtimeEvents: [], harnessRunMarker: null, abortController: visibleController,
    sessionsByWorkspace: { [fixture.scopeKey]: [...fixture.source.current.sessionsByWorkspace[fixture.scopeKey], { id: 2 }] },
  };
  fixture.releasePersistence();
  const result = await pending;
  assert.equal(result.disposition, "committed_durable");
  assert.equal(fixture.source.current.currentTurnId, "turn-visible");
  assert.equal(fixture.source.current.abortController, visibleController);
  assert.equal(fixture.source.current.taskFlow.length, 1);
  const canceled = fixture.source.current.runtimeBySessionKey[fixture.sessionKey];
  assert.equal(canceled.conversationTurns[0].runtimeOutcome.resultKind, "canceled");
  assert.equal(canceled.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
  assert.equal(fixture.source.current.sessionsByWorkspace[fixture.scopeKey][0].storageRevision, 58);
});

for (const replacement of ["same_id", "deleted"]) {
  test(`a ${replacement} Session revokes cancellation before queued persistence and publication`, async () => {
    const fixture = scopedCancellationFixture();
    const pending = commitCanceledTurn(fixture.input);
    await fixture.started;
    fixture.source.current = { ...fixture.source.current,
      runtimeBySessionKey: replacement === "same_id"
        ? { [fixture.sessionKey]: { ...fixture.source.current.runtimeBySessionKey[fixture.sessionKey], currentTurnId: "replacement-turn" } }
        : {},
      sessionsByWorkspace: { [fixture.scopeKey]: replacement === "same_id" ? [{ id: 1, storageRevision: 1, planLifecycleEpoch: "epoch-replacement" }] : [] },
    };
    // Object spread carries symbol owner tokens; a replacement container must
    // not preserve the previous generation, as enforced by the production API.
    if (replacement === "same_id") fixture.source.current.runtimeBySessionKey[fixture.sessionKey] = JSON.parse(JSON.stringify(fixture.source.current.runtimeBySessionKey[fixture.sessionKey]));
    fixture.releasePersistence();
    const result = await pending;
    assert.equal(result.disposition, "ownership_lost");
    assert.equal(fixture.persisted.length, 0);
    assert.equal(fixture.source.current.taskFlow.filter((block) => block.visibility === "assistant_final").length, 0);
  });
}

test("Stop persists one controller-owned canceled ledger and final that survive cold replay", async () => {
  const checkpoint = runtimeCheckpoint();
  const harness = createHarness({ state: { runtimeV2Checkpoints: { "turn-1": checkpoint } } });
  const result = await commitCanceledTurn(harness.input);
  assert.equal(result.committed, true);
  const durable = JSON.parse(JSON.stringify(harness.persisted.at(-1)));
  const restored = runtimeV2.normalizeRuntimeV2Checkpoint(durable.runtimeV2Checkpoints["turn-1"]);
  assert.equal(restored.aggregate.terminalOutcome?.resultKind, "canceled");
  assert.equal(restored.aggregate.phase, "completed");
  assert.deepEqual(restored.aggregate.events.filter((event) =>
    ["run.aborted", "run.completed", "turn.completed"].includes(event.type)
  ).map((event) => event.type), ["run.aborted", "run.completed", "turn.completed"]);
  assert.equal(restored.aggregate.events.filter((event) =>
    event.type === "projection.published" && event.audience === "final"
  ).length, 1);
  assert.equal(durable.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
  assert.equal(durable.conversationTurns[0].runtimeOutcome.resultKind, "canceled");
  assert.equal(durable.agentStatus, "idle");
});

test("Stop between admission and Run start closes the admitted v2 ledger", async () => {
  const active = runtimeCheckpoint();
  const aggregate = runtimeV2.transition(null, active.aggregate.events[0]);
  const checkpoint = runtimeV2.createRuntimeV2Checkpoint({ revision: 1, aggregate, updatedAt: aggregate.updatedAt });
  const harness = createHarness({ state: { runtimeV2Checkpoints: { "turn-1": checkpoint } } });
  const result = await commitCanceledTurn(harness.input);
  assert.equal(result.committed, true);
  const restored = runtimeV2.normalizeRuntimeV2Checkpoint(harness.state.runtimeV2Checkpoints["turn-1"]);
  assert.equal(restored.aggregate.terminalOutcome?.resultKind, "canceled");
  assert.equal(restored.aggregate.events.filter((event) => event.type === "run.started").length, 1);
  assert.equal(restored.aggregate.run.identity.runId, "run-1");
  assert.equal(harness.state.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
});

test("Stop settles an in-flight model command before the canonical canceled conclusion", async () => {
  let checkpoint = runtimeCheckpoint();
  const command = {
    idempotencyKey: "run-1:request-chat", kind: "request_model", phase: "observing",
    run: checkpoint.aggregate.run.identity, payload: { mode: "chat" },
  };
  checkpoint = runtimeV2.appendRuntimeV2Checkpoint({
    checkpoint, owner: checkpoint.owner, expectedRevision: checkpoint.revision,
    event: { schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: checkpoint.aggregate.nextSequence, eventId: "in-flight-command", at: 3,
      type: "command.scheduled", run: command.run, command },
  }).checkpoint;
  const harness = createHarness({ state: { runtimeV2Checkpoints: { "turn-1": checkpoint } } });
  await commitCanceledTurn(harness.input);
  const restored = runtimeV2.normalizeRuntimeV2Checkpoint(harness.state.runtimeV2Checkpoints["turn-1"]);
  assert.deepEqual(restored.aggregate.events.filter((event) =>
    ["command.completed", "run.aborted", "run.completed", "turn.completed"].includes(event.type)
  ).map((event) => [event.type, event.type === "command.completed" ? event.status : event.outcome?.resultKind || null]), [
    ["command.completed", "canceled"], ["run.aborted", null], ["run.completed", "canceled"], ["turn.completed", "canceled"],
  ]);
  assert.equal(restored.aggregate.scheduledCommands.length, 0);
});

for (const eventCount of [2044, 2047, 2048]) {
  test(`Stop at ${eventCount} events uses one durable canceled envelope without growing the ledger`, async () => {
    let aggregate = runtimeCheckpoint().aggregate;
    while (aggregate.events.length < eventCount) {
      const projection = { id: `capacity-${aggregate.nextSequence}`, audience: "timeline",
        markdown: "Progress", kind: "timeline", dedupeKey: `capacity-${aggregate.nextSequence}` };
      aggregate = runtimeV2.transition(aggregate, {
        schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: aggregate.nextSequence,
        eventId: `capacity-event-${aggregate.nextSequence}`, at: aggregate.updatedAt + 1,
        type: "projection.published", run: aggregate.run.identity,
        audience: "timeline", projectionId: projection.id, projection,
      });
    }
    const checkpoint = runtimeV2.createRuntimeV2Checkpoint({ revision: eventCount, aggregate, updatedAt: aggregate.updatedAt });
    const harness = createHarness({
      state: { runtimeV2Checkpoints: { "turn-1": checkpoint } },
      input: { nowMs: Date.now },
    });
    const result = await commitCanceledTurn(harness.input);
    assert.equal(result.disposition, "committed_durable");
    assert.equal(harness.persisted.length, 1);
    const durable = JSON.parse(JSON.stringify(harness.persisted[0]));
    const restoredCheckpoint = runtimeV2.normalizeRuntimeV2Checkpoint(durable.runtimeV2Checkpoints["turn-1"]);
    const envelope = runtimeV2.normalizeRuntimeV2EmergencyTerminalEnvelope(durable.runtimeV2EmergencyTerminalEnvelopes?.["turn-1"], checkpoint.owner);
    assert.equal(envelope?.resultKind, "canceled");
    assert.equal(envelope.lastRevision, eventCount);
    assert.equal(envelope.reasonCode, "checkpoint_event_budget_exceeded");
    assert.equal(restoredCheckpoint.aggregate.events.length, eventCount, "isolated partial terminal appends must not enter the durable ledger");
    assert.equal(restoredCheckpoint.aggregate.terminalOutcome, null);
    assert.equal(durable.conversationTurns[0].runtimeOutcome.resultKind, "canceled");
    assert.equal(durable.conversationTurns[0].runtimeOutcome.reason, envelope.reason);
    assert.equal(durable.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
    assert.deepEqual(durable.runtimeEvents.filter((event) =>
      ["run.aborted", "run.completed", "turn.completed"].includes(event.type)
    ).map((event) => event.type), ["run.aborted", "run.completed", "turn.completed"]);
    const repeat = await commitCanceledTurn(harness.input);
    assert.equal(repeat.committed, true);
    assert.equal(harness.state.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
    assert.deepEqual(harness.state.runtimeV2EmergencyTerminalEnvelopes["turn-1"], envelope);
  });
}

test("Stop at the admitted/no-Run size boundary preserves one exact emergency Run on repeat", async () => {
  const active = runtimeCheckpoint();
  const admitted = { ...active.aggregate.events[0], objective: "x" };
  const firstAggregate = runtimeV2.transition(null, admitted);
  const small = runtimeV2.createRuntimeV2Checkpoint({ revision: 1, aggregate: firstAggregate, updatedAt: firstAggregate.updatedAt });
  const encodedLength = JSON.stringify(runtimeV2.serializeRuntimeV2CheckpointMap({ "turn-1": small })["turn-1"]).length;
  const objective = "x".repeat(runtimeV2.MAX_RUNTIME_V2_CHECKPOINT_CHARS - encodedLength + 1 - 32);
  const aggregate = runtimeV2.transition(null, { ...admitted, objective });
  const checkpoint = runtimeV2.createRuntimeV2Checkpoint({ revision: 1, aggregate, updatedAt: aggregate.updatedAt });
  const harness = createHarness({ state: { runtimeV2Checkpoints: { "turn-1": checkpoint } }, input: { nowMs: Date.now } });
  const first = await commitCanceledTurn(harness.input);
  assert.equal(first.disposition, "committed_durable");
  const envelope = runtimeV2.normalizeRuntimeV2EmergencyTerminalEnvelope(harness.state.runtimeV2EmergencyTerminalEnvelopes?.["turn-1"], checkpoint.owner);
  assert.equal(envelope.resultKind, "canceled");
  assert.equal(envelope.reasonCode, "checkpoint_size_budget_exceeded");
  assert.equal(envelope.lastRevision, 1);
  assert.equal(harness.state.runtimeV2Checkpoints["turn-1"].aggregate.run, null);
  const repeated = await commitCanceledTurn(harness.input);
  assert.equal(repeated.committed, true);
  assert.deepEqual(harness.state.runtimeV2EmergencyTerminalEnvelopes["turn-1"], envelope);
  assert.equal(harness.state.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
});

for (const [resultKind, reasonCode] of [["error", "checkpoint_size_budget_exceeded"], ["canceled", "checkpoint_event_budget_exceeded"]]) {
  test(`Stop rejects a synthetic-identity ${resultKind}/${reasonCode} envelope before the admitted Run starts`, async () => {
    const aggregate = runtimeV2.transition(null, runtimeCheckpoint().aggregate.events[0]);
    const checkpoint = runtimeV2.createRuntimeV2Checkpoint({ revision: 1, aggregate, updatedAt: aggregate.updatedAt });
    const run = { sessionKey: checkpoint.owner.sessionKey, sessionEpoch: checkpoint.owner.sessionEpoch,
      turnId: checkpoint.owner.turnId, runId: "run-1", parentRunId: null, attemptId: "attempt-cancel-run-1" };
    const envelope = runtimeV2.createRuntimeV2EmergencyTerminalEnvelope({ owner: checkpoint.owner, run,
      resultKind, reasonCode, language: "en", at: Date.now(), lastRevision: 1, hasMutation: false });
    const harness = createHarness({ state: { runtimeV2Checkpoints: { "turn-1": checkpoint },
      runtimeV2EmergencyTerminalEnvelopes: { "turn-1": envelope } }, input: { nowMs: Date.now } });
    const result = await commitCanceledTurn(harness.input);
    assert.equal(result.disposition, "committed_durable");
    const canceled = runtimeV2.normalizeRuntimeV2Checkpoint(harness.persisted[0].runtimeV2Checkpoints["turn-1"]);
    assert.equal(canceled.aggregate.terminalOutcome?.resultKind, "canceled");
    assert.equal(canceled.aggregate.events.filter((event) => event.type === "run.started").length, 1);
    assert.equal(canceled.aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(harness.state.conversationTurns[0].runtimeOutcome.resultKind, "canceled");
    assert.equal(harness.state.conversationTurns[0].runtimeOutcome.reason, "user_cancelled");
    assert.equal(harness.state.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
  });
}

test("a saved cancellation receipt advances CAS on retry after a presentation tick", async () => {
  const checkpoint = runtimeCheckpoint();
  const harness = createHarness({ state: {
    runtimeV2Checkpoints: { "turn-1": checkpoint },
    sessionsByWorkspace: { "/tmp/project": [{ id: 1, storageRevision: 57 }] },
  } });
  let durableRevision = 57;
  harness.input.persistProjection = async (projected) => {
    const record = projected.sessionsByWorkspace["/tmp/project"][0];
    assert.equal(record.storageRevision, durableRevision, "cancellation retry must carry the previous write's CAS receipt");
    durableRevision += 1;
    harness.persisted.push(projected);
    if (durableRevision === 58) {
      harness.setState({ ...harness.state, elapsedTime: 1 });
      harness.replaceRevision();
    }
    return { ...projected, sessionsByWorkspace: { "/tmp/project": [{ ...record, storageRevision: durableRevision }] } };
  };
  const result = await commitCanceledTurn(harness.input);
  assert.equal(result.committed, true);
  assert.equal(result.disposition, "committed_durable");
  assert.equal(result.attempts, 2);
  assert.equal(harness.state.sessionsByWorkspace["/tmp/project"][0].storageRevision, 59);
});

test("a queued checkpoint cannot overwrite a durable cancellation or advance its CAS revision", async () => {
  const checkpoint = runtimeCheckpoint();
  const harness = createHarness({ state: {
    config: { sessionRecordingEnabled: true, activeProfile: "local", local: { provider: "Ollama", model: "fixture" } },
    runtimeV2Checkpoints: { "turn-1": checkpoint },
    sessionsByWorkspace: { "/tmp/project": [{ id: 1, storageRevision: 57 }] },
  } });
  const queue = createProjectSessionMutationCoordinator();
  const ownerKey = "/tmp/project\u00001";
  let releaseBlocker;
  const gate = new Promise((resolve) => { releaseBlocker = resolve; });
  const blocker = queue.save(ownerKey, async () => gate);
  let storageRevision = 57;
  let durable = null;
  const writes = [];
  const save = (_scope, record, options) => queue.save(ownerKey, async () => {
    // Match saveProjectSession's queue-head revision selection: snapshots
    // captured at revision N may follow an earlier queued writer at N + 1.
    record = { ...record, storageRevision };
    assert.equal(record.storageRevision, storageRevision);
    storageRevision += 1;
    durable = { ...record, storageRevision };
    writes.push(durable);
    return durable;
  }, options);
  let queuedCancel;
  const cancelEnqueued = new Promise((resolve) => { queuedCancel = resolve; });
  harness.input.persistProjection = async (projected, options) => {
    const record = projected.sessionsByWorkspace["/tmp/project"][0];
    const saved = save("/tmp/project", { ...record, runtimeSnapshot: projected }, options);
    queuedCancel();
    const receipt = await saved;
    return { ...projected, sessionsByWorkspace: { "/tmp/project": [{ ...record, storageRevision: receipt.storageRevision }] } };
  };
  let oldRuntimeOwnsSession = true;
  const oldRuntimeSave = withSubmitSessionPersistenceOwner(save, () => oldRuntimeOwnsSession);
  // The live cancellation controller revokes the old generation synchronously.
  oldRuntimeOwnsSession = false;
  const cancellation = commitCanceledTurn(harness.input);
  await cancelEnqueued;
  const oldPort = createRuntimeV2CheckpointPort({
    get: () => harness.state,
    set: () => {}, scopeKey: "/tmp/project", sessionId: 1,
    getSessionRevisionToken: harness.input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    buildSessionRuntimeSnapshot: (candidate) => candidate,
    persistSessionRecord: oldRuntimeSave,
    publishOwnerScopedRuntimeProjection: harness.input.publishProjection,
    logStoreEvent: () => {},
  });
  const lateAppend = oldPort.append({
    owner: checkpoint.owner, expectedRevision: checkpoint.revision,
    event: {
      schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: checkpoint.aggregate.nextSequence, eventId: "late-checkpoint", at: 4,
      type: "soft_signal.observed", run: checkpoint.aggregate.run.identity,
      signal: "iteration_limit",
    },
  });
  releaseBlocker();
  await blocker;
  assert.equal((await cancellation).committed, true);
  await lateAppend.catch(() => null);
  assert.equal(writes.length, 1, "a superseded queued snapshot must be rejected before durable IPC");
  assert.equal(storageRevision, 58);
  const restored = runtimeV2.normalizeRuntimeV2Checkpoint(durable.runtimeSnapshot.runtimeV2Checkpoints["turn-1"]);
  assert.equal(restored.aggregate.terminalOutcome.resultKind, "canceled");
  assert.equal(durable.runtimeSnapshot.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1, JSON.stringify(durable.runtimeSnapshot.taskFlow));
});

test("cancellation persists before publishing the terminal Turn", async () => {
  const harness = createHarness();
  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, true);
  assert.equal(result.disposition, "committed_durable");
  assert.deepEqual(harness.order, ["persist", "publish"]);
  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.equal(harness.state.runtimeEvents.at(-1).type, "turn.completed");
  assert.equal(harness.published[0].durableState.durable, true);
});

test("persistence failure is an explicit memory fallback, not a missing conclusion", async () => {
  const harness = createHarness({
    input: {
      persistProjection: async () => {
        harness.order.push("persist");
        throw new Error("disk unavailable");
      },
    },
  });
  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, true);
  assert.equal(result.disposition, "committed_memory_fallback");
  assert.deepEqual(harness.order, ["persist", "publish"]);
  assert.equal(harness.published[0].durableState, undefined);
  assert.equal(harness.state.runtimeEvents.at(-1).type, "turn.completed");
});

test("an already closed current Turn repairs stale busy controls without duplicating its conclusion", async () => {
  const initial = createState({
    conversationTurns: [{
      ...createState().conversationTurns[0],
      status: "done",
    }],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Canceled and closed.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      createState().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        runId: "run-1",
        parentRunId: null,
        resultKind: "canceled",
        summary: "Canceled and closed.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "canceled",
      },
    ],
  });
  const harness = createHarness({ state: initial });
  harness.input.persistHarnessMarker = (projectedMarker) => {
    harness.order.push("settle_harness");
    return projectedMarker;
  };
  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, true);
  assert.equal(result.disposition, "already_closed_durable");
  assert.deepEqual(harness.order, ["persist", "publish", "settle_harness"]);
  assert.deepEqual(harness.state.runtimeEvents, initial.runtimeEvents);
  assert.deepEqual(harness.state.taskFlow, initial.taskFlow);
  assert.equal(harness.state.isGenerating, false);
  assert.equal(harness.state.agentStatus, "idle");
  assert.equal(harness.state.abortController, null);
  assert.equal(harness.state.harnessRunMarker.status, "completed");
});

test("an already-closed cleanup reports an explicit memory fallback when durability is unavailable", async () => {
  const initial = createState({
    conversationTurns: [{ ...createState().conversationTurns[0], status: "done" }],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Canceled and closed.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      createState().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        runId: "run-1",
        parentRunId: null,
        resultKind: "canceled",
        summary: "Canceled and closed.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "canceled",
      },
    ],
  });
  const harness = createHarness({ state: initial });
  harness.input.persistProjection = async () => {
    harness.order.push("persist");
    throw new Error("disk unavailable");
  };

  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, true);
  assert.equal(result.disposition, "already_closed_memory_fallback");
  assert.deepEqual(harness.order, ["persist", "publish"]);
  assert.equal(harness.published[0].durableState, undefined);
  assert.equal(harness.state.isGenerating, false);
  assert.equal(harness.state.agentStatus, "idle");
});

test("an already-closed cleanup retries fail closed after a successor controller wins the CAS", async () => {
  const oldController = { abort() {} };
  const successorController = { abort() {} };
  const terminalState = createState({
    abortController: oldController,
    conversationTurns: [{
      ...createState().conversationTurns[0],
      status: "done",
    }],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Already complete.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      createState().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        runId: "run-1",
        parentRunId: null,
        resultKind: "success",
        summary: "Already complete.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "success",
      },
    ],
  });
  const harness = createHarness({ state: terminalState });
  let publishAttempts = 0;
  harness.input.publishProjection = () => {
    publishAttempts += 1;
    harness.order.push("publish");
    harness.setState({
      ...harness.state,
      harnessRunMarker: null,
      activeActionRequest: null,
      abortController: successorController,
      isGenerating: true,
      agentStatus: "running",
    });
    harness.replaceRevision();
    return { published: false, disposition: "revision_conflict" };
  };

  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, true);
  assert.equal(result.disposition, "already_closed");
  assert.equal(result.attempts, 2);
  assert.equal(publishAttempts, 1);
  assert.deepEqual(harness.order, ["persist", "publish"]);
  assert.equal(harness.state.abortController, successorController);
  assert.equal(harness.state.isGenerating, true);
  assert.equal(harness.state.agentStatus, "running");
});

test("an already-closed cleanup cannot clear a replacement attempt that keeps the controller", async () => {
  const terminalState = createState({
    conversationTurns: [{
      ...createState().conversationTurns[0],
      status: "done",
    }],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Already complete.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      createState().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        runId: "run-1",
        parentRunId: null,
        resultKind: "success",
        summary: "Already complete.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "success",
      },
    ],
  });
  const harness = createHarness({ state: terminalState });
  let publishAttempts = 0;
  let successorMarker = null;
  harness.input.publishProjection = () => {
    publishAttempts += 1;
    harness.order.push("publish");
    successorMarker = {
      ...harness.state.harnessRunMarker,
      runId: "lease-attempt-2",
      activeRunId: "run-1",
      instanceId: "instance-attempt-2",
    };
    harness.setState({
      ...harness.state,
      harnessRunMarker: successorMarker,
      isGenerating: true,
      agentStatus: "running",
    });
    harness.replaceRevision();
    return { published: false, disposition: "revision_conflict" };
  };

  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, true);
  assert.equal(result.disposition, "already_closed");
  assert.equal(result.attempts, 2);
  assert.equal(publishAttempts, 1);
  assert.deepEqual(harness.order, ["persist", "publish"]);
  assert.equal(harness.state.harnessRunMarker, successorMarker);
  assert.equal(harness.state.abortController, terminalState.abortController);
  assert.equal(harness.state.isGenerating, true);
  assert.equal(harness.state.agentStatus, "running");
});

test("a concurrent owner update retries and reuses the exact paused run id", async () => {
  const pausedState = createState({
    runtimeEvents: [
      createState().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.paused",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 2,
        runId: "run-1",
        parentRunId: null,
        reason: "tool_permission",
      },
    ],
  });
  let first = true;
  const harness = createHarness({ state: pausedState });
  harness.input.persistProjection = async (projected) => {
    harness.order.push("persist");
    harness.persisted.push(projected);
    if (first) {
      first = false;
      harness.replaceRevision();
    }
    return projected;
  };

  const result = await commitCanceledTurn(harness.input);
  assert.equal(result.committed, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(harness.order, ["persist", "persist", "publish"]);
  const cancellationRunIds = harness.persisted.map((projected) =>
    projected.runtimeEvents.find((event) => event.type === "run.aborted")?.runId
  );
  assert.deepEqual(cancellationRunIds, ["run-1", "run-1"]);
});

test("a publication revision conflict does not settle Harness before the accepted retry", async () => {
  const harness = createHarness();
  let publishAttempts = 0;
  let settleCalls = 0;
  let settleCallsAfterConflict = -1;
  harness.input.persistHarnessMarker = (projectedMarker) => {
    settleCalls += 1;
    harness.order.push("settle_harness");
    assert.equal(harness.state.harnessRunMarker.status, "running");
    return projectedMarker;
  };
  harness.input.publishProjection = (publication) => {
    publishAttempts += 1;
    harness.order.push("publish");
    harness.published.push(publication);
    if (publishAttempts === 1) {
      settleCallsAfterConflict = settleCalls;
      return { published: false, disposition: "revision_conflict" };
    }
    publication.beforePublish?.();
    harness.setState(publication.durableState || publication.projectedState);
    harness.replaceRevision();
    return { published: true, disposition: "published" };
  };

  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, true);
  assert.equal(result.attempts, 2);
  assert.equal(settleCallsAfterConflict, 0);
  assert.equal(settleCalls, 1);
  assert.deepEqual(harness.order, [
    "persist",
    "publish",
    "persist",
    "publish",
    "settle_harness",
  ]);
  assert.equal(harness.state.harnessRunMarker.status, "completed");
});

test("a publication ownership loss performs no Harness settlement", async () => {
  const harness = createHarness();
  let settleCalls = 0;
  harness.input.persistHarnessMarker = (projectedMarker) => {
    settleCalls += 1;
    return projectedMarker;
  };
  harness.input.publishProjection = (publication) => {
    harness.order.push("publish");
    harness.published.push(publication);
    return { published: false, disposition: "ownership_lost" };
  };

  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, false);
  assert.equal(result.disposition, "ownership_lost");
  assert.equal(settleCalls, 0);
  assert.equal(harness.state.harnessRunMarker.status, "running");
  assert.deepEqual(harness.order, ["persist", "publish"]);
});

test("a running owner that pauses during persistence is canceled on that same run", async () => {
  let first = true;
  const harness = createHarness();
  harness.input.persistProjection = async (projected) => {
    harness.order.push("persist");
    harness.persisted.push(projected);
    if (first) {
      first = false;
      harness.setState(createState({
        runtimeEvents: [
          createState().runtimeEvents[0],
          {
            schemaVersion: 2,
            type: "run.paused",
            threadId: "session-1",
            turnId: "turn-1",
            timestampMs: 2,
            runId: "run-1",
            parentRunId: null,
            reason: "tool_permission",
          },
        ],
        harnessRunMarker: {
          ...createState().harnessRunMarker,
          status: "paused",
        },
      }));
      harness.replaceRevision();
    }
    return projected;
  };

  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.cancellationRunId, "run-1");
  const terminalEvents = harness.state.runtimeEvents.filter((event) =>
    event.type === "run.paused" || event.type === "run.aborted" || event.type === "run.completed"
  );
  assert.deepEqual(terminalEvents.map((event) => [event.type, event.runId]), [
    ["run.paused", "run-1"],
    ["run.aborted", "run-1"],
    ["run.completed", "run-1"],
  ]);
  assert.equal(
    harness.state.runtimeEvents.find((event) =>
      event.type === "run.started" && event.runId === result.cancellationRunId
    )?.parentRunId,
    null,
  );
  assert.equal(terminalEvents.at(-1).resultKind, "canceled");
  assert.equal(harness.state.runtimeEvents.at(-1).type, "turn.completed");
});

test("a stale cancellation owner performs no persistence or publication", async () => {
  const newerRequest = {
    schemaVersion: 1,
    requestId: "request-new",
    kind: "tool_permission",
    status: "pending",
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-new",
    parentRunId: null,
    taskId: 2,
    title: "new",
    toolName: "write_file",
    target: "new.txt",
    createdAt: 2,
  };
  const harness = createHarness({
    state: {
      activeActionRequest: newerRequest,
      harnessRunMarker: {
        ...createState().harnessRunMarker,
        activeRunId: "run-new",
      },
    },
  });
  const result = await commitCanceledTurn(harness.input);

  assert.equal(result.committed, false);
  assert.equal(result.disposition, "ownership_lost");
  assert.deepEqual(harness.order, []);
  assert.equal(harness.state.conversationTurns[0].status, "executing");
});

test("deferred cancellation publishes the old terminal before a same-key controller can seed a new Turn", async () => {
  const sessionKey = "/tmp/project:1";
  const runtimeKeys = [
    "currentTurnId",
    "agentStatus",
    "isGenerating",
    "abortController",
    "elapsedTime",
    "taskFlow",
    "conversationTurns",
    "runtimeEvents",
    "harnessRunMarker",
    "activeActionRequest",
    "pendingReviewResolve",
    "pendingReviewTaskId",
    "pendingToolCall",
    "planArtifacts",
    "planTasks",
    "planExecutionEvidenceLedger",
    "planStage",
    "isPlanApproved",
    "showPlanPanel",
    "showDiff",
    "showTerminal",
    "rightPanelTab",
    "normalizedStreamState",
    "currentTurnState",
  ];
  const createRuntime = (state) => Object.fromEntries(
    runtimeKeys.map((key) => [key, state[key]]),
  );
  const pickRuntimePatch = (source) => Object.fromEntries(
    runtimeKeys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/project",
      currentSessionId: 1,
      runtimeBySessionKey: {},
      sessionsByWorkspace: { "/tmp/project": [{ id: 1, messages: [] }] },
      ...createState({
        runtimeEvents: [{
          schemaVersion: 2,
          type: "run.started",
          threadId: sessionKey,
          turnId: "turn-1",
          timestampMs: 1,
          runId: "run-1",
          parentRunId: null,
        }],
        harnessRunMarker: null,
        activeActionRequest: {
          schemaVersion: 1,
          requestId: "request-review-1",
          kind: "tool_permission",
          status: "pending",
          sessionKey,
          turnId: "turn-1",
          runId: "run-1",
          parentRunId: null,
          taskId: 7,
          title: "Approve shell",
          toolName: "shell",
          target: "pwd",
          createdAt: 1,
        },
        agentStatus: "pending_review",
        pendingReviewTaskId: 7,
      }),
      elapsedTime: 1,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planStage: "idle",
      isPlanApproved: false,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      rightPanelTab: "terminal",
      normalizedStreamState: {},
      currentTurnState: {},
      config: { workflowMode: "edit" },
    },
  };
  const applySet = (patchOrUpdater) => {
    const patch = typeof patchOrUpdater === "function"
      ? patchOrUpdater(stateRef.current)
      : patchOrUpdater;
    stateRef.current = { ...stateRef.current, ...patch };
  };
  const createController = () => createSubmitSessionRuntimeController({
    get: () => stateRef.current,
    set: applySet,
    runSessionKey: sessionKey,
    createRuntimeFromState: createRuntime,
    pickRuntimePatch,
    derivePlanStageFromArtifacts: () => "idle",
    createDefaultCurrentTurnState: () => ({}),
    logStoreEvent: () => {},
  });

  const oldRunController = createController();
  const cancellationController = createController();
  assert.equal(oldRunController.hasSessionRuntimeOwnership(), false);
  assert.equal(cancellationController.hasSessionRuntimeOwnership(), true);

  let signalPersistenceStarted;
  const persistenceStarted = new Promise((resolve) => {
    signalPersistenceStarted = resolve;
  });
  let releasePersistence;
  const persistenceGate = new Promise((resolve) => {
    releasePersistence = resolve;
  });
  const order = [];
  const { cancellation } = beginSessionCancellation(sessionKey, "turn-1", async () => {
    const result = await commitCanceledTurn({
      sessionKey,
      scopeKey: "/tmp/project",
      sessionId: 1,
      turnId: "turn-1",
      runId: "run-1",
      reason: "superseded_by_new_user_turn",
      message: "The old Turn was canceled and closed.",
      controlPlaneFence: captureCanceledTurnControlPlaneFence({
        state: cancellationController.sessionGet(),
        sessionKey,
        turnId: "turn-1",
        runId: "run-1",
      }),
      nextTaskId: () => 2,
      sessionGet: cancellationController.sessionGet,
      getSessionRevisionToken: cancellationController.getSessionRevisionToken,
      persistProjection: async (projectedState) => {
        order.push("persist_started");
        signalPersistenceStarted();
        await persistenceGate;
        order.push("persist_finished");
        return projectedState;
      },
      publishProjection: (publication) => {
        order.push("old_terminal_published");
        return cancellationController.publishOwnerScopedRuntimeProjection(publication);
      },
      nowMs: () => 10,
    });
    const scoped = cancellationController.sessionGet();
    return {
      sessionKey,
      turnId: "turn-1",
      terminalSettled: result.committed && hasCanceledTurnTerminalProjection({
        sessionKey,
        turnId: "turn-1",
        runtimeEvents: scoped.runtimeEvents,
        taskFlow: scoped.taskFlow,
      }),
      disposition: result.disposition,
    };
  });

  let newController = null;
  const deferred = deferUntilSessionCancellationSettled({
    sessionKey,
    onSettled: (settlement) => {
      assert.equal(settlement.terminalSettled, true);
      assert.equal(hasCanceledTurnTerminalProjection({
        sessionKey,
        turnId: "turn-1",
        runtimeEvents: stateRef.current.runtimeEvents,
        taskFlow: stateRef.current.taskFlow,
      }), true);
      newController = createController();
      newController.sessionSet((state) => ({
        currentTurnId: "turn-2",
        agentStatus: "running",
        isGenerating: true,
        conversationTurns: [
          ...state.conversationTurns,
          {
            id: "turn-2",
            userPrompt: "new instruction",
            status: "executing",
            collapsed: false,
            elapsedTime: 0,
            blockIds: [],
          },
        ],
        runtimeEvents: [
          ...state.runtimeEvents,
          {
            schemaVersion: 2,
            type: "run.started",
            threadId: sessionKey,
            turnId: "turn-2",
            timestampMs: 20,
            runId: "run-2",
            parentRunId: null,
          },
        ],
      }));
      order.push("new_turn_started");
    },
  });
  assert.equal(deferred, true);

  await persistenceStarted;
  assert.equal(newController, null);
  assert.equal(cancellationController.hasSessionRuntimeOwnership(), true);
  assert.equal(stateRef.current.conversationTurns[0].status, "executing");
  assert.equal(stateRef.current.agentStatus, "pending_review");
  assert.equal(stateRef.current.isGenerating, true);
  assert.ok(stateRef.current.abortController);
  assert.equal(
    stateRef.current.runtimeEvents.some((event) =>
      event.type === "run.aborted" || event.type === "turn.completed"
    ),
    false,
    "a pending durable write must not be represented as an idle or terminal Turn",
  );

  releasePersistence();
  await cancellation.promise;
  await Promise.resolve();

  assert.deepEqual(order, [
    "persist_started",
    "persist_finished",
    "old_terminal_published",
    "new_turn_started",
  ]);
  assert.ok(newController);
  assert.equal(cancellationController.hasSessionRuntimeOwnership(), false);
  assert.equal(newController.hasSessionRuntimeOwnership(), true);
  assert.equal(stateRef.current.conversationTurns[0].status, "done");
  assert.equal(stateRef.current.conversationTurns[1].status, "executing");
  assert.deepEqual(stateRef.current.runtimeEvents.map((event) => [event.type, event.turnId]), [
    ["run.started", "turn-1"],
    ["run.aborted", "turn-1"],
    ["run.completed", "turn-1"],
    ["turn.completed", "turn-1"],
    ["run.started", "turn-2"],
  ]);
  assert.equal(stateRef.current.taskFlow.at(-1).visibility, "assistant_final");
});

test("ownership loss reconciles with the latest owner before the deferred send starts", async () => {
  const sessionKey = "/tmp/project:ownership-lost";
  const order = [];
  const { cancellation } = beginSessionCancellation(sessionKey, "turn-old", async () => ({
    sessionKey,
    turnId: "turn-old",
    terminalSettled: false,
    disposition: "ownership_lost",
  }), {
    reconcile: async ({ attempt, previousSettlement }) => {
      order.push(`reconcile_${attempt}_${previousSettlement?.disposition}`);
      return {
        sessionKey,
        turnId: "turn-old",
        terminalSettled: true,
        disposition: "reconciled_memory_terminal",
      };
    },
  });
  assert.equal(deferUntilSessionCancellationSettled({
    sessionKey,
    onSettled: (settlement) => {
      assert.equal(settlement.terminalSettled, true);
      order.push("deferred_send_started");
    },
  }), true);

  const result = await cancellation.promise;
  await Promise.resolve();
  assert.equal(result.disposition, "reconciled_memory_terminal");
  assert.deepEqual(order, [
    "reconcile_1_ownership_lost",
    "deferred_send_started",
  ]);
  assert.equal(getPendingSessionCancellation(sessionKey), null);
});

test("concurrent update exhaustion retries reconciliation only to its bounded success", async () => {
  const sessionKey = "/tmp/project:concurrent-limit";
  const attempts = [];
  let replayed = 0;
  const { cancellation } = beginSessionCancellation(sessionKey, "turn-old", async () => ({
    sessionKey,
    turnId: "turn-old",
    terminalSettled: false,
    disposition: "concurrent_update_limit",
  }), {
    maxReconciliationAttempts: 2,
    reconcile: async ({ attempt }) => {
      attempts.push(attempt);
      return {
        sessionKey,
        turnId: "turn-old",
        terminalSettled: attempt === 2,
        disposition: attempt === 2
          ? "reconciled_memory_terminal"
          : "memory_terminal_verification_failed",
      };
    },
  });
  assert.equal(deferUntilSessionCancellationSettled({
    sessionKey,
    onSettled: (settlement) => {
      if (settlement.terminalSettled) replayed += 1;
    },
  }), true);

  const result = await cancellation.promise;
  await Promise.resolve();
  assert.equal(result.terminalSettled, true);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(replayed, 1);
  assert.equal(getPendingSessionCancellation(sessionKey), null);
});

test("a rejected initial transaction reconciles and never leaves a settled fence", async () => {
  const sessionKey = "/tmp/project:rejected";
  const expectedError = new Error("persistence exploded");
  let reconciliationError = null;
  let replayed = false;
  const { cancellation } = beginSessionCancellation(sessionKey, "turn-old", async () => {
    throw expectedError;
  }, {
    reconcile: async ({ error }) => {
      reconciliationError = error;
      return {
        sessionKey,
        turnId: "turn-old",
        terminalSettled: true,
        disposition: "reconciled_memory_terminal",
      };
    },
  });
  assert.equal(deferUntilSessionCancellationSettled({
    sessionKey,
    onSettled: () => {
      replayed = true;
    },
    onError: () => assert.fail("bounded reconciliation should absorb the initial rejection"),
  }), true);

  await cancellation.promise;
  await Promise.resolve();
  assert.equal(reconciliationError, expectedError);
  assert.equal(replayed, true);
  assert.equal(getPendingSessionCancellation(sessionKey), null);
});

test("a deleted Session discards its queued submit and releases the fence", async () => {
  const sessionKey = "/tmp/project:deleted";
  let decision = null;
  const { cancellation } = beginSessionCancellation(sessionKey, "turn-old", async () => ({
    sessionKey,
    turnId: "turn-old",
    terminalSettled: false,
    disposition: "durable_session_missing",
  }), {
    reconcile: async () => ({
      sessionKey,
      turnId: "turn-old",
      terminalSettled: false,
      disposition: "session_deleted",
      queueDisposition: "discard",
    }),
  });
  assert.equal(deferUntilSessionCancellationSettled({
    sessionKey,
    onSettled: (settlement) => {
      decision = resolveDeferredSessionSubmissionDecision({
        expectedQueueId: "queue-deleted",
        currentQueueId: null,
        targetSessionKey: sessionKey,
        activeSessionKey: null,
        terminalSettled: settlement.terminalSettled,
        queueDisposition: settlement.queueDisposition,
      });
    },
  }), true);

  await cancellation.promise;
  await Promise.resolve();
  assert.equal(decision, "discard_session_deleted");
  assert.equal(getPendingSessionCancellation(sessionKey), null);
});

test("multiple deferred inputs use an exact latest-wins queue id and replay only once", async () => {
  const sessionKey = "/tmp/project:latest-wins";
  let releaseCancellation;
  const cancellationGate = new Promise((resolve) => {
    releaseCancellation = resolve;
  });
  const { cancellation } = beginSessionCancellation(sessionKey, "turn-old", async () => {
    await cancellationGate;
    return {
      sessionKey,
      turnId: "turn-old",
      terminalSettled: true,
      disposition: "committed_durable",
    };
  });
  let currentQueueId = null;
  const decisions = [];
  const stage = (queueId) => {
    currentQueueId = queueId;
    assert.equal(deferUntilSessionCancellationSettled({
      sessionKey,
      onSettled: (settlement) => {
        decisions.push([queueId, resolveDeferredSessionSubmissionDecision({
          expectedQueueId: queueId,
          currentQueueId,
          targetSessionKey: sessionKey,
          activeSessionKey: sessionKey,
          terminalSettled: settlement.terminalSettled,
        })]);
      },
    }), true);
  };

  stage("queue-first");
  stage("queue-latest");
  releaseCancellation();
  await cancellation.promise;
  await Promise.resolve();

  assert.deepEqual(decisions, [
    ["queue-first", "superseded_by_latest"],
    ["queue-latest", "replay"],
  ]);
  assert.equal(getPendingSessionCancellation(sessionKey), null);
  assert.equal(decisions.filter(([, decision]) => decision === "replay").length, 1);
  assert.equal(resolveDeferredSessionSubmissionDecision({
    expectedQueueId: "queue-latest",
    currentQueueId: "queue-latest",
    targetSessionKey: sessionKey,
    activeSessionKey: "/tmp/project:other",
    terminalSettled: true,
  }), "retain_for_target_session");
  assert.equal(resolveDeferredSessionSubmissionDecision({
    expectedQueueId: "queue-latest",
    currentQueueId: "queue-latest",
    targetSessionKey: sessionKey,
    activeSessionKey: sessionKey,
    terminalSettled: false,
  }), "retain_for_reconciliation");
});
