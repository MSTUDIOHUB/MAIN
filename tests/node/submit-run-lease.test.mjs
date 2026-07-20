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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];
      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildSubmitAgentUserMessage,
  startSubmitRunLease,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitRunLease.ts"),
);
const {
  HARNESS_RUN_MARKER_STORAGE_KEY,
  acquireHarnessRunMarker,
  closeHarnessRunMarker,
  closeHarnessRunMarkerForSessionDeletion,
  isHarnessRunMarkerOwnedByRun,
  normalizeHarnessRunMarker,
  persistHarnessRunMarker,
  persistHarnessRunMarkerIfOwned,
  readHarnessRunMarker,
  settleHarnessRunMarkerIfOwned,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/harnessCrashTelemetry.ts"),
);

test("submit run lease builds text-only user messages", () => {
  assert.deepEqual(
    buildSubmitAgentUserMessage({
      userContent: "hello",
      currentImages: [],
    }),
    { role: "user", content: "hello" },
  );
});

test("submit run lease builds multimodal user messages with images before text", () => {
  assert.deepEqual(
    buildSubmitAgentUserMessage({
      userContent: "describe",
      currentImages: ["data:image/png;base64,a", "data:image/png;base64,b"],
    }),
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,a" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,b" } },
        { type: "text", text: "describe" },
      ],
    },
  );
});

test("submit run lease appends agent message, opens abort lease, and persists harness marker", () => {
  const agentMessages = [{ role: "assistant", content: "old" }];
  const abortController = { signal: { aborted: false } };
  const goals = [];
  const persistedMarkers = [];
  const harnessMarkers = [];
  const lease = startSubmitRunLease({
    userContent: "ship the goal",
    canonicalUserText: "ship the visible goal",
    goalSourceContext: "prior Plan conclusion",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-1",
    effectiveRunIntent: "goal",
    runtimeRunIntent: "goal",
    goalCreationAuthorization: {
      kind: "goal_creation_authorization",
      intent: "goal",
      source: "visible_goal_shortcut",
    },
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "executing",
      isPlanApproved: true,
    }),
    appendAgentMessage: (message) => {
      agentMessages.push(message);
    },
    createAbortController: () => abortController,
    setAbortController: (nextAbortController) => {
      assert.equal(nextAbortController, abortController);
    },
    startGoal: (objective, options) => {
      goals.push({ objective, options });
    },
    getCurrentHarnessInstanceId: () => "instance-a",
    expectedHarnessRunMarker: null,
    acquireHarnessRunMarker: (marker) => {
      persistedMarkers.push(marker);
      return { ...marker, persisted: true };
    },
    setHarnessRunMarker: (marker) => {
      harnessMarkers.push(marker);
    },
    nowMs: () => 456,
  });

  assert.equal(lease.turnAgentMessagesStart, 1);
  assert.deepEqual(lease.agentUserMessage, { role: "user", content: "ship the goal" });
  assert.equal(lease.abortController, abortController);
  assert.deepEqual(goals, [
    {
      objective: "ship the visible goal",
      options: { sessionKey: "workspace-a:7", sourceContext: "prior Plan conclusion", ownerTurnId: "turn-1" },
    },
  ]);
  assert.equal(persistedMarkers[0].instanceId, "instance-a");
  assert.match(persistedMarkers[0].runId, /^run-/);
  assert.equal(persistedMarkers[0].messagesLen, 2);
  assert.equal(persistedMarkers[0].planStage, "executing");
  assert.equal(persistedMarkers[0].isPlanApproved, true);
  assert.equal(persistedMarkers[0].startedAt, 456);
  assert.equal(persistedMarkers[0].parentRunId, null);
  assert.equal(persistedMarkers[0].turnStartMessageIndex, 1);
  assert.equal(harnessMarkers[0].persisted, true);
  assert.equal(lease.harnessRunMarker.persisted, true);
  assert.equal(lease.runId, persistedMarkers[0].runId);
  assert.equal(lease.parentRunId, null);
});

test("submit run lease refuses inferred or internally resolved Goal creation without explicit authority", () => {
  const agentMessages = [];
  let startGoalCalls = 0;
  startSubmitRunLease({
    userContent: "internal goal request",
    canonicalUserText: "internal goal request",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-internal-goal",
    effectiveRunIntent: "goal",
    runtimeRunIntent: "goal",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "idle",
      isPlanApproved: false,
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => { startGoalCalls += 1; },
    getCurrentHarnessInstanceId: () => "instance-a",
    expectedHarnessRunMarker: null,
    acquireHarnessRunMarker: (marker) => marker,
    setHarnessRunMarker: () => {},
    nowMs: () => 457,
  });

  assert.equal(startGoalCalls, 0);
});

test("submit run lease performs no local acquisition effects when Harness CAS loses", () => {
  const agentMessages = [];
  let abortControllerCreations = 0;
  let goalStarts = 0;
  let localMarkerWrites = 0;

  assert.throws(() => startSubmitRunLease({
    userContent: "stale bootstrap",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-stale",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "idle",
      isPlanApproved: false,
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => {
      abortControllerCreations += 1;
      return { signal: { aborted: false } };
    },
    setAbortController: () => assert.fail("lost CAS must not publish an AbortController"),
    startGoal: () => { goalStarts += 1; },
    getCurrentHarnessInstanceId: () => "instance-a",
    expectedHarnessRunMarker: null,
    acquireHarnessRunMarker: () => null,
    setHarnessRunMarker: () => { localMarkerWrites += 1; },
    nowMs: () => 458,
  }), /HARNESS_RUN_LEASE_OWNER_LOST/);

  assert.deepEqual(agentMessages, []);
  assert.equal(abortControllerCreations, 0);
  assert.equal(goalStarts, 0);
  assert.equal(localMarkerWrites, 0);
});

test("submit run lease links only exact same-turn resumes", () => {
  const agentMessages = [
    { role: "user", content: "initial" },
    { role: "assistant", content: "choose" },
  ];
  const previousMarker = {
    runId: "run-parent",
    sessionKey: "workspace-a:7",
    turnId: "turn-1",
    turnStartMessageIndex: 0,
  };
  let persisted;
  const lease = startSubmitRunLease({
    userContent: "[turn_intake]\n[user_request]\napprove\n[/user_request]\n[/turn_intake]",
    canonicalUserText: "approve",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-1",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "executing",
      isPlanApproved: true,
      harnessRunMarker: previousMarker,
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => assert.fail("goal must not start"),
    getCurrentHarnessInstanceId: () => "instance-a",
    expectedHarnessRunMarker: null,
    acquireHarnessRunMarker: (marker) => (persisted = marker),
    setHarnessRunMarker: () => {},
    nowMs: () => 789,
  });

  assert.equal(lease.parentRunId, "run-parent");
  assert.equal(persisted.parentRunId, "run-parent");
  assert.equal(persisted.turnStartMessageIndex, 0);
});

test("action continuations preserve their exact paused parent run even when another marker is current", () => {
  const agentMessages = [{ role: "user", content: "newer turn" }];
  let persisted;
  const lease = startSubmitRunLease({
    userContent: "Use B",
    canonicalUserText: "Use B",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-choice",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    parentRunIdOverride: "run-choice-paused",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "idle",
      isPlanApproved: false,
      harnessRunMarker: {
        runId: "run-other-current",
        sessionKey: "workspace-a:7",
        turnId: "turn-newer",
        turnStartMessageIndex: 0,
      },
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => assert.fail("goal must not start"),
    getCurrentHarnessInstanceId: () => "instance-a",
    expectedHarnessRunMarker: null,
    acquireHarnessRunMarker: (marker) => (persisted = marker),
    setHarnessRunMarker: () => {},
    nowMs: () => 790,
  });

  assert.equal(lease.parentRunId, "run-choice-paused");
  assert.equal(persisted.parentRunId, "run-choice-paused");
  assert.equal(persisted.turnId, "turn-choice");
});

test("approved handoffs preserve a preallocated child run id through the submission lease", () => {
  const agentMessages = [{ role: "user", content: "reviewed plan" }];
  let persisted;
  const lease = startSubmitRunLease({
    userContent: "execute approved plan",
    canonicalUserText: "execute approved plan",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-plan",
    effectiveRunIntent: "plan",
    runtimeRunIntent: "execute",
    parentRunIdOverride: "run-review",
    runIdOverride: "run-approved-child",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "executing",
      isPlanApproved: true,
      harnessRunMarker: {
        runId: "run-review",
        sessionKey: "workspace-a:7",
        turnId: "turn-plan",
        turnStartMessageIndex: 0,
      },
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => assert.fail("goal must not start"),
    getCurrentHarnessInstanceId: () => "instance-a",
    expectedHarnessRunMarker: null,
    acquireHarnessRunMarker: (marker) => (persisted = marker),
    setHarnessRunMarker: () => {},
    nowMs: () => 791,
  });

  assert.equal(lease.runId, "run-approved-child");
  assert.equal(lease.parentRunId, "run-review");
  assert.equal(persisted.runId, "run-approved-child");
  assert.equal(persisted.parentRunId, "run-review");
});

test("Goal choice continuations append guidance without creating a replacement Goal", () => {
  const agentMessages = [{ role: "assistant", content: "Choose startup behavior" }];
  let persisted;
  const lease = startSubmitRunLease({
    userContent: "显示欢迎页",
    canonicalUserText: "显示欢迎页",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-goal",
    effectiveRunIntent: "goal",
    runtimeRunIntent: "goal",
    continueExistingGoal: true,
    parentRunIdOverride: "run-goal:slice:1",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "idle",
      isPlanApproved: false,
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => assert.fail("a Goal continuation must retain the existing Goal"),
    getCurrentHarnessInstanceId: () => "instance-a",
    expectedHarnessRunMarker: null,
    acquireHarnessRunMarker: (marker) => (persisted = marker),
    setHarnessRunMarker: () => {},
    nowMs: () => 792,
  });

  assert.deepEqual(agentMessages.at(-1), { role: "user", content: "显示欢迎页" });
  assert.equal(lease.parentRunId, "run-goal:slice:1");
  assert.equal(persisted.workflowMode, "edit");
  assert.equal(persisted.runtimeIntent, "goal");
});

test("harness run ownership distinguishes sequential loops on the same conversation turn", () => {
  const marker = {
    status: "running",
    runId: "run-new",
    sessionKey: "workspace-a:7",
    turnId: "turn-plan",
  };
  assert.equal(isHarnessRunMarkerOwnedByRun(marker, {
    runId: "run-new",
    sessionKey: "workspace-a:7",
    turnId: "turn-plan",
  }), true);
  assert.equal(isHarnessRunMarkerOwnedByRun(marker, {
    runId: "run-old",
    sessionKey: "workspace-a:7",
    turnId: "turn-plan",
  }), false);
});

test("Harness marker preserves an exact admitted Plan Run provenance", () => {
  const provenance = {
    schemaVersion: 1,
    sessionKey: "workspace-a:7",
    sessionEpoch: "session-epoch-plan",
    planTurnId: "turn-plan-origin",
    approvalLeaseId: "approval-lease-plan",
    planRevision: 3,
    artifactHash: "artifact-hash-plan",
    executionLeaseId: "execution-lease-plan",
    executionTurnId: "turn-plan",
    executionRunId: "run-plan-child",
    parentRunId: "run-plan-parent",
    attempt: 2,
    instructionHash: "instruction-hash-plan",
  };
  const marker = normalizeHarnessRunMarker({
    schemaVersion: 1,
    runId: "run-plan-outer",
    activeRunId: provenance.executionRunId,
    activeParentRunId: provenance.parentRunId,
    activePlanExecutionProvenance: provenance,
    instanceId: "instance-plan",
    sessionKey: provenance.sessionKey,
    turnId: provenance.executionTurnId,
    status: "running",
    startedAt: 100,
    updatedAt: 110,
  });

  assert.ok(marker);
  assert.deepEqual(marker.activePlanExecutionProvenance, provenance);
  assert.equal(Object.isFrozen(marker.activePlanExecutionProvenance), true);
});

test("Harness marker rejects Plan provenance whose active owner, run, or parent differs", () => {
  const provenance = {
    schemaVersion: 1,
    sessionKey: "workspace-a:7",
    sessionEpoch: "session-epoch-plan",
    planTurnId: "turn-plan-origin",
    approvalLeaseId: "approval-lease-plan",
    planRevision: 3,
    artifactHash: "artifact-hash-plan",
    executionLeaseId: "execution-lease-plan",
    executionTurnId: "turn-plan",
    executionRunId: "run-plan-child",
    parentRunId: "run-plan-parent",
    attempt: 2,
    instructionHash: "instruction-hash-plan",
  };
  const marker = {
    schemaVersion: 1,
    runId: "run-plan-outer",
    activeRunId: provenance.executionRunId,
    activeParentRunId: provenance.parentRunId,
    activePlanExecutionProvenance: provenance,
    instanceId: "instance-plan",
    sessionKey: provenance.sessionKey,
    turnId: provenance.executionTurnId,
    status: "running",
    startedAt: 100,
    updatedAt: 110,
  };

  const mismatches = [
    { ...provenance, sessionKey: "workspace-foreign:8" },
    { ...provenance, executionTurnId: "turn-foreign" },
    { ...provenance, executionRunId: "run-plan-foreign" },
    { ...provenance, parentRunId: "run-plan-foreign-parent" },
  ];
  for (const activePlanExecutionProvenance of mismatches) {
    const normalized = normalizeHarnessRunMarker({
      ...marker,
      activePlanExecutionProvenance,
    });
    assert.ok(normalized);
    assert.equal(normalized.activePlanExecutionProvenance, null);
  }
});

test("Harness marker keeps legacy records compatible when Plan provenance is absent", () => {
  const marker = normalizeHarnessRunMarker({
    schemaVersion: 1,
    runId: "run-legacy",
    instanceId: "instance-legacy",
    sessionKey: "workspace-legacy:1",
    turnId: "turn-legacy",
    status: "running",
    startedAt: 100,
    updatedAt: 110,
  });

  assert.ok(marker);
  assert.equal(marker.activeRunId, "run-legacy");
  assert.equal(
    Object.prototype.hasOwnProperty.call(marker, "activePlanExecutionProvenance"),
    false,
  );
});

test("global harness persistence uses run ownership CAS across background sessions", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const markerB = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-b",
      instanceId: "instance-a",
      sessionKey: "workspace-b:2",
      turnId: "turn-b",
      status: "running",
      startedAt: 200,
      updatedAt: 200,
    });
    const ownerA = {
      runId: "run-a",
      sessionKey: "workspace-a:1",
      turnId: "turn-a",
    };
    const ownerB = {
      runId: "run-b",
      sessionKey: "workspace-b:2",
      turnId: "turn-b",
      instanceId: "instance-a",
      startedAt: 200,
    };

    assert.equal(persistHarnessRunMarkerIfOwned({
      ...markerB,
      runId: "run-a",
      sessionKey: "workspace-a:1",
      turnId: "turn-a",
      iteration: 3,
    }, ownerA), null);
    assert.equal(readHarnessRunMarker().runId, "run-b");
    assert.equal(persistHarnessRunMarkerIfOwned({
      ...markerB,
      iteration: 4,
    }, {
      ...ownerB,
      instanceId: "instance-stale",
    }), null);
    assert.equal(persistHarnessRunMarkerIfOwned({
      ...markerB,
      iteration: 5,
    }, {
      ...ownerB,
      startedAt: 199,
    }), null);
    assert.equal(readHarnessRunMarker().iteration, markerB.iteration);
    assert.equal(closeHarnessRunMarker({
      status: "completed",
      closeReason: "old_session_finished",
    }, ownerA), null);
    assert.equal(readHarnessRunMarker().status, "running");

    const closedB = closeHarnessRunMarker({
      status: "completed",
      closeReason: "owner_finished",
    }, ownerB);
    assert.equal(closedB.runId, "run-b");
    assert.equal(readHarnessRunMarker().status, "completed");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("owned Harness persistence fails closed when the storage write is swallowed", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  let rejectWrites = false;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (rejectWrites) throw new Error("simulated localStorage denial");
        values.set(key, String(value));
      },
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const current = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-outer",
      instanceId: "instance-a",
      sessionKey: "workspace-a:7",
      turnId: "turn-plan",
      status: "running",
      startedAt: 500,
      updatedAt: 500,
    });
    const provenance = {
      schemaVersion: 1,
      sessionKey: current.sessionKey,
      sessionEpoch: "session-epoch-a",
      planTurnId: "turn-plan-origin",
      approvalLeaseId: "approval-lease-a",
      planRevision: 1,
      artifactHash: "artifact-hash-a",
      executionLeaseId: "execution-lease-a",
      executionTurnId: current.turnId,
      executionRunId: "run-plan-child",
      parentRunId: "run-plan-parent",
      attempt: 1,
      instructionHash: "instruction-hash-a",
    };
    rejectWrites = true;
    const candidate = {
      ...current,
      activeRunId: provenance.executionRunId,
      activeParentRunId: provenance.parentRunId,
      activePlanExecutionProvenance: provenance,
    };

    assert.equal(persistHarnessRunMarker(candidate), null);

    const result = persistHarnessRunMarkerIfOwned(candidate, {
      runId: current.runId,
      sessionKey: current.sessionKey,
      turnId: current.turnId,
      instanceId: current.instanceId,
      startedAt: current.startedAt,
    });

    assert.equal(result, null);
    assert.equal(readHarnessRunMarker().activeRunId, current.runId);
    assert.equal(readHarnessRunMarker().activePlanExecutionProvenance, undefined);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("owned Harness persistence rejects every authority mismatch observed on read-back", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  let rewritePersistedMarker = null;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        const parsed = JSON.parse(String(value));
        const rewritten = rewritePersistedMarker
          ? rewritePersistedMarker(parsed)
          : parsed;
        values.set(key, JSON.stringify(rewritten));
      },
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const current = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-authority-outer",
      instanceId: "instance-authority",
      sessionKey: "workspace-authority:7",
      turnId: "turn-authority",
      status: "running",
      startedAt: 600,
      updatedAt: 600,
    });
    const provenance = {
      schemaVersion: 1,
      sessionKey: current.sessionKey,
      sessionEpoch: "session-epoch-authority",
      planTurnId: "turn-plan-origin",
      approvalLeaseId: "approval-lease-authority",
      planRevision: 4,
      artifactHash: "artifact-hash-authority",
      executionLeaseId: "execution-lease-authority",
      executionTurnId: current.turnId,
      executionRunId: "run-authority-child",
      parentRunId: "run-authority-parent",
      attempt: 3,
      instructionHash: "instruction-hash-authority",
    };
    const candidate = {
      ...current,
      activeRunId: provenance.executionRunId,
      activeParentRunId: provenance.parentRunId,
      activePlanExecutionProvenance: provenance,
    };
    const owner = {
      runId: current.runId,
      sessionKey: current.sessionKey,
      turnId: current.turnId,
      instanceId: current.instanceId,
      startedAt: current.startedAt,
    };
    const corruptions = [
      (marker) => ({ ...marker, instanceId: "instance-raced" }),
      (marker) => ({ ...marker, status: "paused" }),
      (marker) => ({ ...marker, activeRunId: "run-raced-child" }),
      (marker) => ({ ...marker, activeParentRunId: "run-raced-parent" }),
      (marker) => ({
        ...marker,
        activePlanExecutionProvenance: {
          ...marker.activePlanExecutionProvenance,
          artifactHash: "artifact-hash-raced",
        },
      }),
    ];

    for (const corruption of corruptions) {
      values.set(HARNESS_RUN_MARKER_STORAGE_KEY, JSON.stringify(current));
      rewritePersistedMarker = corruption;
      assert.equal(persistHarnessRunMarkerIfOwned(candidate, owner), null);
    }

    values.set(HARNESS_RUN_MARKER_STORAGE_KEY, JSON.stringify(current));
    rewritePersistedMarker = null;
    const accepted = persistHarnessRunMarkerIfOwned(candidate, owner);
    assert.ok(accepted);
    assert.equal(accepted.activeRunId, provenance.executionRunId);
    assert.equal(accepted.activeParentRunId, provenance.parentRunId);
    assert.deepEqual(accepted.activePlanExecutionProvenance, provenance);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("Harness settlement cannot close a reused logical id from another generation", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const predecessor = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-reused",
      instanceId: "instance-old",
      sessionKey: "workspace-a:7",
      turnId: "turn-reused",
      status: "running",
      startedAt: 100,
      updatedAt: 100,
    });
    const successor = persistHarnessRunMarker({
      ...predecessor,
      instanceId: "instance-new",
      status: "running",
      startedAt: 200,
      updatedAt: 200,
    });
    const staleTerminal = {
      ...predecessor,
      status: "completed",
      closeReason: "stale_generation_finished",
      closedAt: 300,
      updatedAt: 300,
    };

    assert.equal(settleHarnessRunMarkerIfOwned(staleTerminal, {
      runId: predecessor.runId,
      sessionKey: predecessor.sessionKey,
      turnId: predecessor.turnId,
      instanceId: predecessor.instanceId,
      startedAt: predecessor.startedAt,
    }), null);
    assert.equal(readHarnessRunMarker().instanceId, successor.instanceId);
    assert.equal(readHarnessRunMarker().startedAt, successor.startedAt);
    assert.equal(readHarnessRunMarker().status, "running");

    const exactTerminal = {
      ...successor,
      status: "completed",
      terminalResultKind: "partial",
      planStage: "completed",
      isPlanApproved: false,
      closeReason: "successor_finished",
      closedAt: 400,
      updatedAt: 400,
    };
    const exactOwner = {
      runId: successor.runId,
      sessionKey: successor.sessionKey,
      turnId: successor.turnId,
      instanceId: successor.instanceId,
      startedAt: successor.startedAt,
    };
    const settled = settleHarnessRunMarkerIfOwned(exactTerminal, exactOwner);
    assert.equal(settled.status, "completed");
    assert.equal(settled.terminalResultKind, "partial");
    assert.equal(settled.closeReason, "successor_finished");
    persistHarnessRunMarker({
      ...settled,
      terminalResultKind: undefined,
      planStage: "executing",
      isPlanApproved: true,
    });
    const repaired = settleHarnessRunMarkerIfOwned(exactTerminal, exactOwner);
    assert.equal(repaired.status, "completed");
    assert.equal(repaired.terminalResultKind, "partial");
    assert.equal(repaired.planStage, "completed");
    assert.equal(repaired.isPlanApproved, false);
    assert.equal(readHarnessRunMarker().planStage, "completed");
    assert.equal(readHarnessRunMarker().isPlanApproved, false);
    assert.equal(settleHarnessRunMarkerIfOwned(exactTerminal, exactOwner).status, "completed");
    assert.equal(settleHarnessRunMarkerIfOwned({
      ...exactTerminal,
      terminalResultKind: "success",
    }, exactOwner), null, "a retry cannot rewrite one terminal result into another");
    assert.equal(readHarnessRunMarker().terminalResultKind, "partial");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("Harness marker normalization preserves exact terminal kinds and never infers success", () => {
  const base = {
    schemaVersion: 1,
    runId: "run-terminal-kind",
    instanceId: "instance-terminal-kind",
    sessionKey: "workspace-a:terminal-kind",
    turnId: "turn-terminal-kind",
    workflowMode: "edit",
    runtimeIntent: "execute",
    planStage: "idle",
    isPlanApproved: false,
    startedAt: 100,
    updatedAt: 200,
  };
  for (const terminalResultKind of ["success", "partial", "blocked", "error", "canceled"]) {
    assert.equal(normalizeHarnessRunMarker({
      ...base,
      status: "completed",
      terminalResultKind,
    })?.terminalResultKind, terminalResultKind);
  }
  assert.equal(normalizeHarnessRunMarker({
    ...base,
    status: "completed",
  })?.terminalResultKind, undefined, "legacy completed markers remain unknown");
  assert.equal(normalizeHarnessRunMarker({
    ...base,
    status: "running",
    terminalResultKind: "success",
  })?.terminalResultKind, undefined, "a live marker cannot retain stale terminal truth");
  assert.equal(normalizeHarnessRunMarker({
    ...base,
    status: "error",
  })?.terminalResultKind, "error");
});

test("Harness settlement rejects a terminal write whose Plan metadata is torn before verification", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  let tamperNextTerminalWrite = false;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        const serialized = String(value);
        if (key === HARNESS_RUN_MARKER_STORAGE_KEY && tamperNextTerminalWrite) {
          tamperNextTerminalWrite = false;
          const parsed = JSON.parse(serialized);
          values.set(key, JSON.stringify({
            ...parsed,
            planStage: "executing",
            isPlanApproved: true,
          }));
          return;
        }
        values.set(key, serialized);
      },
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const running = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-torn-terminal",
      instanceId: "instance-torn-terminal",
      sessionKey: "workspace-a:8",
      turnId: "turn-torn-terminal",
      status: "running",
      planStage: "executing",
      isPlanApproved: true,
      startedAt: 500,
      updatedAt: 500,
    });
    const terminal = {
      ...running,
      status: "completed",
      planStage: "completed",
      isPlanApproved: false,
      closeReason: "agent_loop_completed",
      closedAt: 600,
      updatedAt: 600,
    };
    tamperNextTerminalWrite = true;
    const settled = settleHarnessRunMarkerIfOwned(terminal, {
      runId: running.runId,
      sessionKey: running.sessionKey,
      turnId: running.turnId,
      instanceId: running.instanceId,
      startedAt: running.startedAt,
    });

    assert.equal(settled, null);
    assert.equal(readHarnessRunMarker().status, "completed");
    assert.equal(readHarnessRunMarker().planStage, "executing");
    assert.equal(readHarnessRunMarker().isPlanApproved, true);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("Harness settlement rejects a terminal write whose active child owner is torn before verification", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  let tamperNextTerminalWrite = false;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        const serialized = String(value);
        if (key === HARNESS_RUN_MARKER_STORAGE_KEY && tamperNextTerminalWrite) {
          tamperNextTerminalWrite = false;
          const parsed = JSON.parse(serialized);
          values.set(key, JSON.stringify({
            ...parsed,
            activeRunId: "run-torn-successor-child",
            activeParentRunId: "run-torn-successor-parent",
          }));
          return;
        }
        values.set(key, serialized);
      },
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const running = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-torn-child-owner",
      instanceId: "instance-torn-child-owner",
      sessionKey: "workspace-a:9",
      turnId: "turn-torn-child-owner",
      status: "running",
      activeRunId: "run-child-original",
      activeParentRunId: "run-parent-original",
      planStage: "executing",
      isPlanApproved: true,
      startedAt: 700,
      updatedAt: 700,
    });
    const terminal = {
      ...running,
      status: "completed",
      planStage: "completed",
      isPlanApproved: false,
      closeReason: "agent_loop_completed",
      closedAt: 800,
      updatedAt: 800,
    };
    tamperNextTerminalWrite = true;
    const settled = settleHarnessRunMarkerIfOwned(terminal, {
      runId: running.runId,
      sessionKey: running.sessionKey,
      turnId: running.turnId,
      instanceId: running.instanceId,
      startedAt: running.startedAt,
    });

    assert.equal(settled, null);
    assert.equal(readHarnessRunMarker().status, "completed");
    assert.equal(readHarnessRunMarker().planStage, "completed");
    assert.equal(readHarnessRunMarker().isPlanApproved, false);
    assert.equal(readHarnessRunMarker().activeRunId, "run-torn-successor-child");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("Harness acquisition CAS cannot overwrite a newer Session owner", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const predecessor = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-predecessor",
      instanceId: "instance-a",
      sessionKey: "workspace-a:1",
      turnId: "turn-a",
      status: "running",
      startedAt: 100,
      updatedAt: 100,
    });
    const newer = persistHarnessRunMarker({
      ...predecessor,
      runId: "run-new-owner",
      instanceId: "instance-b",
      sessionKey: "workspace-b:2",
      turnId: "turn-b",
      startedAt: 200,
      updatedAt: 200,
    });
    const staleCandidate = {
      ...predecessor,
      runId: "run-stale-candidate",
      turnId: "turn-stale",
      startedAt: 300,
      updatedAt: 300,
    };

    assert.equal(acquireHarnessRunMarker(staleCandidate, predecessor), null);
    assert.equal(readHarnessRunMarker().runId, newer.runId);

    const accepted = acquireHarnessRunMarker(staleCandidate, newer);
    assert.equal(accepted.runId, staleCandidate.runId);
    assert.equal(readHarnessRunMarker().runId, staleCandidate.runId);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("Harness acquisition fails closed on write failure and read-back owner races", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  let writeMode = "normal";
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (writeMode === "throw") throw new Error("simulated acquisition write denial");
        const parsed = JSON.parse(String(value));
        const stored = writeMode === "race"
          ? {
              ...parsed,
              runId: "run-competing-owner",
              instanceId: "instance-competing-owner",
              sessionKey: "workspace-competing:9",
              turnId: "turn-competing-owner",
              startedAt: 999,
            }
          : writeMode === "authority-race"
            ? {
                ...parsed,
                activeRunId: "run-competing-child",
              }
          : parsed;
        values.set(key, JSON.stringify(stored));
      },
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const predecessor = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-acquire-predecessor",
      instanceId: "instance-acquire-predecessor",
      sessionKey: "workspace-acquire:1",
      turnId: "turn-acquire-predecessor",
      status: "running",
      startedAt: 700,
      updatedAt: 700,
    });
    const candidate = {
      ...predecessor,
      runId: "run-acquire-candidate",
      activeRunId: "run-acquire-child",
      activeParentRunId: "run-acquire-parent",
      instanceId: "instance-acquire-candidate",
      sessionKey: "workspace-acquire:2",
      turnId: "turn-acquire-candidate",
      startedAt: 800,
      updatedAt: 800,
    };

    writeMode = "throw";
    assert.equal(acquireHarnessRunMarker(candidate, predecessor), null);
    assert.equal(readHarnessRunMarker().runId, predecessor.runId);

    writeMode = "race";
    assert.equal(acquireHarnessRunMarker(candidate, predecessor), null);
    assert.equal(readHarnessRunMarker().runId, "run-competing-owner");

    values.set(HARNESS_RUN_MARKER_STORAGE_KEY, JSON.stringify(predecessor));
    writeMode = "authority-race";
    assert.equal(acquireHarnessRunMarker(candidate, predecessor), null);
    assert.equal(readHarnessRunMarker().runId, candidate.runId);
    assert.equal(readHarnessRunMarker().activeRunId, "run-competing-child");

    values.set(HARNESS_RUN_MARKER_STORAGE_KEY, JSON.stringify(predecessor));
    writeMode = "normal";
    const accepted = acquireHarnessRunMarker(candidate, predecessor);
    assert.ok(accepted);
    assert.equal(accepted.runId, candidate.runId);
    assert.equal(accepted.instanceId, candidate.instanceId);
    assert.equal(accepted.activeRunId, candidate.activeRunId);
    assert.equal(accepted.activeParentRunId, candidate.activeParentRunId);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("Session deletion closes an exact paused Harness owner without restoring its write lease", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const paused = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-paused",
      instanceId: "instance-a",
      sessionKey: "workspace-a:7",
      turnId: "turn-paused",
      status: "paused",
      startedAt: 300,
      updatedAt: 300,
    });
    const owner = {
      runId: paused.runId,
      sessionKey: paused.sessionKey,
      turnId: paused.turnId,
    };

    assert.equal(isHarnessRunMarkerOwnedByRun(paused, owner), false);
    assert.equal(persistHarnessRunMarkerIfOwned({
      ...paused,
      iteration: 9,
    }, owner), null);
    assert.equal(readHarnessRunMarker().iteration, paused.iteration);
    assert.equal(closeHarnessRunMarkerForSessionDeletion({
      ...owner,
      runId: "foreign-run",
    }), null);
    assert.equal(closeHarnessRunMarkerForSessionDeletion({
      ...owner,
      instanceId: "stale-instance",
      startedAt: paused.startedAt,
    }), null);
    assert.equal(closeHarnessRunMarkerForSessionDeletion({
      ...owner,
      instanceId: paused.instanceId,
      startedAt: paused.startedAt + 1,
    }), null);
    assert.equal(readHarnessRunMarker().status, "paused");

    const closed = closeHarnessRunMarkerForSessionDeletion({
      ...owner,
      instanceId: paused.instanceId,
      startedAt: paused.startedAt,
    });
    assert.equal(closed.runId, paused.runId);
    assert.equal(closed.status, "completed");
    assert.equal(closed.closeReason, "session_deleted");
    assert.equal(readHarnessRunMarker().status, "completed");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});
