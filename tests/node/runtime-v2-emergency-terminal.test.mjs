import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        path.join(base, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalized, module.exports);
  return module.exports;
}

const runtime = loadTs(
  path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
);
const { createRuntimeV2CheckpointPort } = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/checkpointPort.ts"),
);
const { createRuntimeV2ProjectionPort } = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/projectionPort.ts"),
);
const { PlanCheckpointTerminalReserveError, PlanLedger } = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/planLedger.ts"),
);
const { recoverRuntimeV2PlanCheckpointBoundary, restoreRuntimeV2PlanEmergencyTerminal } = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/planCheckpointRecovery.ts"),
);
const { beginSessionCancellation } = loadTs(path.join(workspaceRoot, "src/store/sessionCancellationBarrier.ts"));

const owner = {
  workspaceKey: "/fixture",
  sessionKey: "session-emergency",
  sessionEpoch: "epoch-emergency",
  clientSubmissionId: "submission-emergency",
  turnId: "turn-emergency",
};
const run = {
  sessionKey: owner.sessionKey,
  sessionEpoch: owner.sessionEpoch,
  turnId: owner.turnId,
  runId: "run-emergency",
  parentRunId: null,
  attemptId: "attempt-emergency",
};
let eventOrdinal = 0;

function nextEvent(state, type, fields = {}) {
  return {
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state ? state.nextSequence : 0,
    eventId: `emergency-event-${++eventOrdinal}`,
    at: state ? state.updatedAt + 1 : 1,
    type,
    ...fields,
  };
}

function activeAggregate(strategy = "execute") {
  let aggregate = runtime.transition(
    null,
    nextEvent(null, "turn.admitted", {
      turn: owner,
      strategy,
      objective: "Repair the fixture",
      constraints: [],
      acceptanceCriteria: ["The fixture works"],
      acceptanceCriterionIds: ["criterion-user-objective"],
      acceptanceEvidenceRequirements: ["behavioral"],
    }),
  );
  aggregate = runtime.transition(
    aggregate,
    nextEvent(aggregate, "run.started", {
      run,
      phase: strategy === "plan" ? "planning" : "observing",
    }),
  );
  return aggregate;
}

function checkpointFor(aggregate) {
  return runtime.createRuntimeV2Checkpoint({
    revision: aggregate.events.length,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
}

function adapterHarness(input = {}) {
  const scopeKey = owner.workspaceKey;
  const sessionId = 41;
  let state = input.state;
  const persisted = [];
  const logs = [];
  let persistFailure = input.persistFailure || null;
  const port = createRuntimeV2CheckpointPort({
    get: () => state,
    set: () => {},
    scopeKey,
    sessionId,
    getSessionRevisionToken: () => state.sessionRevisionToken,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    buildSessionRuntimeSnapshot: (candidate) => ({
      runtimeV2Checkpoints: candidate.runtimeV2Checkpoints,
    }),
    persistSessionRecord: async (_scope, patch) => {
      persisted.push(patch);
      const failure = typeof persistFailure === "function" ? persistFailure(patch) : persistFailure;
      if (failure) throw failure;
      return { ...patch, storageRevision: 2 };
    },
    publishOwnerScopedRuntimeProjection: ({
      projectedState,
      durableState,
    }) => {
      state = durableState || projectedState;
      return { published: true, disposition: "published" };
    },
    logStoreEvent: (event, data) => logs.push({ event, data }),
  });
  return {
    port,
    persisted,
    logs,
    getState: () => state,
    setState: update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    allowPersistence: () => {
      persistFailure = null;
    },
  };
}

function planBoundaryHarness({ checkpoint = checkpointFor(activeAggregate("plan")), persistFailure, language = "zh", markerRun = run, abortCtrl = new AbortController(), envelope } = {}) {
  const initial = recordedState(checkpoint);
  initial.config = { ...initial.config, activeProfile: "local", local: { provider: "fixture", model: "fixture" } };
  initial.harnessRunMarker = { ...markerRun, status: "running" };
  initial.runtimeEvents = [];
  initial.conversationTurns = [];
  initial.isGenerating = true;
  initial.agentStatus = "running";
  if (envelope) initial.runtimeV2EmergencyTerminalEnvelopes[owner.turnId] = envelope;
  const harness = adapterHarness({ state: initial, persistFailure });
  let taskId = 0;
  const runner = {
    get: harness.getState,
    context: { phaseLanguage: language, abortCtrl, runSessionKey: owner.sessionKey, turnId: owner.turnId, harnessRunId: run.runId },
    logStoreEvent: (event, data) => harness.logs.push({ event, data }),
  };
  const projection = createRuntimeV2ProjectionPort({
    get: harness.getState, set: harness.setState,
    language, nextTaskId: () => ++taskId, logStoreEvent: runner.logStoreEvent,
  });
  const ledger = new PlanLedger(owner, harness.port, projection, checkpoint, runner.logStoreEvent);
  return { ...harness, runner, ledger, run };
}

function assertOnePlanFinal(harness, resultKind, reason) {
  const state = harness.getState();
  const finals = state.taskFlow.filter(block => block.visibility === "assistant_final" && block.turnId === owner.turnId);
  assert.equal(finals.length, 1, JSON.stringify(harness.logs));
  assert.match(finals[0].content, reason);
  assert.equal(state.isGenerating, false);
  assert.equal(state.harnessRunMarker.terminalResultKind, resultKind);
  assert.equal(state.runtimeEvents.filter(event => event.type === "run.completed" && event.runId === run.runId).length, 1);
  assert.equal(state.runtimeEvents.filter(event => event.type === "turn.completed" && event.turnId === owner.turnId).length, 1);
}

test("Plan event saturation closes through the exact envelope once and resumes without ledger writes", async () => {
  let aggregate = activeAggregate("plan");
  while (aggregate.events.length < runtime.MAX_RUNTIME_V2_CHECKPOINT_EVENTS) {
    const id = `plan-fill-${aggregate.nextSequence}`;
    aggregate = runtime.transition(aggregate, nextEvent(aggregate, "projection.published", { run, audience: "timeline", projectionId: id,
      projection: { id, audience: "timeline", markdown: id, kind: "timeline", dedupeKey: id } }));
  }
  const checkpoint = checkpointFor(aggregate);
  const harness = planBoundaryHarness({ checkpoint });
  const error = await harness.ledger.append({ type: "soft_signal.observed", run, signal: "protocol_drift" }).then(
    () => assert.fail("A saturated checkpoint must reject an append"), error => error,
  );
  assert.equal(error.reasonCode, "checkpoint_event_budget_exceeded");
  const settlement = await recoverRuntimeV2PlanCheckpointBoundary({ ...harness, error });
  assert.equal(settlement.disposition, "projected", JSON.stringify(harness.logs));
  assert.equal(settlement.outcome.resultKind, "error");
  assert.equal(harness.persisted.length, 1);
  assert.deepEqual(Object.keys(harness.persisted[0].runtimeSnapshot), ["runtimeV2EmergencyTerminalEnvelopes"]);
  const envelope = harness.getState().runtimeV2EmergencyTerminalEnvelopes[owner.turnId];
  assert.equal(envelope.lastRevision, checkpoint.revision);
  assert.equal(envelope.hasMutation, false);
  assert.deepEqual(runtime.normalizeRuntimeV2EmergencyTerminalEnvelope(JSON.parse(JSON.stringify(envelope)), owner), envelope);
  assertOnePlanFinal(harness, "error", /已达到安全容量边界.*未生成可交付的计划/u);
  await restoreRuntimeV2PlanEmergencyTerminal(harness);
  assert.equal(harness.persisted.length, 1);
  assertOnePlanFinal(harness, "error", /未生成可交付的计划/u);
  const restored = planBoundaryHarness({ checkpoint, envelope: JSON.parse(JSON.stringify(envelope)) });
  await restoreRuntimeV2PlanEmergencyTerminal(restored);
  assert.equal(restored.persisted.length, 0);
  assertOnePlanFinal(restored, "error", /未生成可交付的计划/u);
});

test("Plan persistence failure uses bounded text and preserves a user abort as canceled", async () => {
  const abortCtrl = new AbortController();
  abortCtrl.abort();
  const harness = planBoundaryHarness({ language: "en", abortCtrl, persistFailure: patch =>
    Object.hasOwn(patch.runtimeSnapshot || {}, "runtimeV2EmergencyTerminalEnvelopes") ? null : new Error("PRIVATE_SOURCE_TEXT") });
  const error = await harness.ledger.append({ type: "soft_signal.observed", run, signal: "protocol_drift" }).then(
    () => assert.fail("The ordinary write must fail"), error => error,
  );
  assert.equal(error.reasonCode, "checkpoint_persist_failed");
  const settlement = await recoverRuntimeV2PlanCheckpointBoundary({ ...harness, error });
  assert.equal(settlement.outcome.status, "aborted");
  assertOnePlanFinal(harness, "canceled", /could not be persisted.*user stopped plan generation/u);
  const terminalEvent = harness.logs.find(entry => entry.event === "runtime_v2_plan_checkpoint_terminal");
  assert.doesNotMatch(JSON.stringify(terminalEvent), /PRIVATE_SOURCE_TEXT/u);
  assert.equal(terminalEvent.data.checkpointEventCount, 2);
  const runtimeTypes = harness.getState().runtimeEvents.map(event => event.type);
  assert.ok(runtimeTypes.indexOf("run.aborted") < runtimeTypes.indexOf("run.completed"));
});

test("Plan checkpoint recovery defers to an in-flight Stop terminal transaction", async () => {
  const abortCtrl = new AbortController();
  const harness = planBoundaryHarness({ abortCtrl });
  abortCtrl.abort();
  const message = "Stop committed the original cancellation.";
  const { cancellation } = beginSessionCancellation(owner.sessionKey, owner.turnId, async () => {
    await harness.ledger.finishTerminal({ run, resultKind: "canceled", reason: message, finalMarkdown: message });
    return { terminalSettled: true, queueDisposition: "dispatch", disposition: "committed" };
  });
  const settlement = await recoverRuntimeV2PlanCheckpointBoundary({
    ...harness, error: new runtime.RuntimeV2CheckpointWriteBoundaryError("checkpoint_persist_failed"),
  });
  await cancellation.promise;
  assert.equal(settlement.reason, message);
  assert.equal(settlement.outcome.status, "aborted");
  assertOnePlanFinal(harness, "canceled", /Stop committed/u);
  assert.deepEqual(harness.getState().runtimeV2EmergencyTerminalEnvelopes, {});
});

test("Plan emergency recovery presents an already committed canonical result after a later write fails", async () => {
  const harness = planBoundaryHarness({ persistFailure: patch => {
    const checkpoint = patch.runtimeSnapshot?.runtimeV2Checkpoints?.[owner.turnId];
    return checkpoint?.events.some(event => event.type === "projection.published" && event.audience === "final")
      ? new Error("later checkpoint write failure")
      : null;
  } });
  const originalFinal = "The saved plan document is ready.";
  const error = await harness.ledger.finishTerminal({ run, resultKind: "success", reason: originalFinal, finalMarkdown: originalFinal }).then(
    () => assert.fail("The final acknowledgment write must fail"), error => error,
  );
  assert.equal(error.reasonCode, "checkpoint_persist_failed");
  assert.equal(harness.getState().runtimeV2Checkpoints[owner.turnId].aggregate.terminalOutcome.resultKind, "success");
  const settlement = await recoverRuntimeV2PlanCheckpointBoundary({ ...harness, error });
  assert.equal(settlement.outcome.resultKind, "success");
  assertOnePlanFinal(harness, "success", /saved plan document is ready/u);
  assert.deepEqual(harness.getState().runtimeV2EmergencyTerminalEnvelopes, {});
});

test("a Plan checkpoint fence never closes a newer harness owner", async () => {
  const harness = planBoundaryHarness({ markerRun: { ...run, runId: "newer-run" } });
  const settlement = await recoverRuntimeV2PlanCheckpointBoundary({
    ...harness, error: new runtime.RuntimeV2CheckpointWriteBoundaryError("checkpoint_persist_failed"),
  });
  assert.equal(settlement.disposition, "superseded");
  assert.equal(settlement.currentOwner.harnessRunId, "newer-run");
  assert.equal(harness.getState().isGenerating, true);
  assert.equal(harness.getState().taskFlow.length, 0);
  assert.equal(harness.persisted.length, 0);
});

test("Plan reports projection failure if both ordinary and emergency storage remain unavailable", async () => {
  const harness = planBoundaryHarness({ persistFailure: new Error("DISK_ERROR_DETAILS") });
  const settlement = await recoverRuntimeV2PlanCheckpointBoundary({
    ...harness, error: new runtime.RuntimeV2CheckpointWriteBoundaryError("checkpoint_persist_failed"),
  });
  assert.equal(settlement.disposition, "projection_failed");
  assert.equal(harness.getState().taskFlow.length, 0);
  assert.deepEqual(harness.getState().runtimeV2EmergencyTerminalEnvelopes, {});
  assert.equal(harness.persisted.length, 2);
  const diagnostic = harness.logs.find(entry => entry.event === "runtime_v2_plan_checkpoint_terminal_failed");
  assert.equal(diagnostic.data.checkpointEventCount, 2);
  assert.doesNotMatch(JSON.stringify(diagnostic), /DISK_ERROR_DETAILS/u);
});

test("Plan checkpoint reservation closes canonically and keeps the emergency slot unused", async () => {
  const harness = planBoundaryHarness();
  const settlement = await recoverRuntimeV2PlanCheckpointBoundary({
    ...harness, canUseReservedTerminal: true, error: new PlanCheckpointTerminalReserveError(),
  });
  assert.equal(settlement.disposition, "projected");
  assertOnePlanFinal(harness, "error", /接近容量上限/u);
  assert.equal(runtime.isRuntimeV2TurnTerminallyClosed(harness.getState().runtimeV2Checkpoints[owner.turnId].aggregate), true);
  assert.deepEqual(harness.getState().runtimeV2EmergencyTerminalEnvelopes, {});
});

function recordedState(checkpoint) {
  const state = {
    runtimeV2Checkpoints: {
      [owner.turnId]: checkpoint,
    },
    runtimeV2EmergencyTerminalEnvelopes: {},
    sessionsByWorkspace: {
      [owner.workspaceKey]: [{
        id: 41,
        title: "Emergency fixture",
        storageRevision: 1,
        messages: [],
      }],
    },
    config: { sessionRecordingEnabled: true },
    taskFlow: [],
    sessionRevisionToken: 1,
    providerModelText: "must-not-persist",
  };
  state.recursiveStore = state;
  return state;
}

test("a normal persist failure can close as partial through one minimal independent envelope", async () => {
  const aggregate = {
    ...activeAggregate(),
    evidence: [{
      id: "mutation-effect",
      kind: "mutation",
      target: "src/main.js",
      version: "sha-after",
    }],
  };
  const checkpoint = checkpointFor(aggregate);
  const harness = adapterHarness({
    state: recordedState(checkpoint),
    persistFailure: new Error(
      "{\"backend\":\"recursive snapshot exceeded 64 MiB\"}",
    ),
  });
  const projection = {
    id: "progress-after-mutation",
    audience: "timeline",
    markdown: "Progress",
    kind: "timeline",
    dedupeKey: "progress-after-mutation",
  };
  await assert.rejects(
    harness.port.append({
      owner,
      expectedRevision: checkpoint.revision,
      event: nextEvent(aggregate, "projection.published", {
        run,
        audience: projection.audience,
        projectionId: projection.id,
        projection,
      }),
    }),
    (error) => error?.reasonCode === "checkpoint_persist_failed",
  );

  harness.allowPersistence();
  const envelope = runtime.createRuntimeV2EmergencyTerminalEnvelope({
    owner,
    run,
    resultKind: "partial",
    reasonCode: "checkpoint_persist_failed",
    language: "zh",
    at: 1_800_000_000_000,
    lastRevision: checkpoint.revision,
    hasMutation: true,
  });
  const committed = await harness.port.commitEmergencyTerminal({
    owner,
    run,
    expectedRevision: checkpoint.revision,
    envelope,
  });
  assert.equal(committed.disposition, "committed");

  const emergencyPatch = harness.persisted.at(-1);
  assert.deepEqual(Object.keys(emergencyPatch.runtimeSnapshot), [
    "runtimeV2EmergencyTerminalEnvelopes",
  ]);
  assert.equal(Object.hasOwn(emergencyPatch, "providerModelText"), false);
  assert.equal(Object.hasOwn(emergencyPatch.runtimeSnapshot, "events"), false);
  assert.equal(
    JSON.stringify(emergencyPatch).includes("recursive snapshot"),
    false,
  );
  assert.equal(
    harness.getState().runtimeV2EmergencyTerminalEnvelopes[
      owner.turnId
    ].resultKind,
    "partial",
  );
  await assert.rejects(
    harness.port.load({ owner }),
    /RUNTIME_V2_EMERGENCY_TERMINAL_ENVELOPE_PRESENT/,
  );
  assert.equal(
    (
      await harness.port.append({
        owner,
        expectedRevision: checkpoint.revision,
        event: aggregate.events[0],
      })
    ).disposition,
    "conflict",
    "the old running checkpoint must not resume after the envelope commits",
  );
});

test("a full 2048-event ledger closes as error without raising the boundary", async () => {
  let aggregate = activeAggregate();
  while (
    aggregate.events.length <
      runtime.MAX_RUNTIME_V2_CHECKPOINT_EVENTS
  ) {
    const index = aggregate.events.length;
    const projection = {
      id: `full-ledger-${index}`,
      audience: "timeline",
      markdown: `Progress ${index}`,
      kind: "timeline",
      dedupeKey: `full-ledger-${index}`,
    };
    aggregate = runtime.transition(
      aggregate,
      nextEvent(aggregate, "projection.published", {
        run,
        audience: projection.audience,
        projectionId: projection.id,
        projection,
      }),
    );
  }
  const checkpoint = checkpointFor(aggregate);
  const harness = adapterHarness({
    state: recordedState(checkpoint),
  });
  const overflowProjection = {
    id: "full-ledger-overflow",
    audience: "timeline",
    markdown: "Overflow",
    kind: "timeline",
    dedupeKey: "full-ledger-overflow",
  };
  await assert.rejects(
    harness.port.append({
      owner,
      expectedRevision: checkpoint.revision,
      event: nextEvent(aggregate, "projection.published", {
        run,
        audience: overflowProjection.audience,
        projectionId: overflowProjection.id,
        projection: overflowProjection,
      }),
    }),
    (error) =>
      error?.reasonCode === "checkpoint_event_budget_exceeded",
  );

  const envelope = runtime.createRuntimeV2EmergencyTerminalEnvelope({
    owner,
    run,
    resultKind: "error",
    reasonCode: "checkpoint_event_budget_exceeded",
    language: "en",
    at: 1_800_000_000_001,
    lastRevision: checkpoint.revision,
    hasMutation: false,
  });
  const committed = await harness.port.commitEmergencyTerminal({
    owner,
    run,
    expectedRevision: checkpoint.revision,
    envelope,
  });
  assert.equal(committed.disposition, "committed");
  assert.equal(
    harness.persisted.at(-1).runtimeSnapshot
      .runtimeV2EmergencyTerminalEnvelopes[owner.turnId].resultKind,
    "error",
  );
  assert.equal(
    (
      await harness.port.commitEmergencyTerminal({
        owner,
        run,
        expectedRevision: checkpoint.revision + 1,
        envelope,
      })
    ).disposition,
    "conflict",
  );
});
