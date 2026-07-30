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

function activeAggregate() {
  let aggregate = runtime.transition(
    null,
    nextEvent(null, "turn.admitted", {
      turn: owner,
      strategy: "execute",
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
      phase: "observing",
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
      if (persistFailure) throw persistFailure;
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
    allowPersistence: () => {
      persistFailure = null;
    },
  };
}

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
