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
  buildOwnerScopedDurableSessionPatch,
  createSubmitPreRunSessionPatcher,
  createSubmitSessionRuntimeFacade,
  startSubmitElapsedTimer,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitRuntimeFacade.ts"),
);
const {
  createSubmitSessionRuntimeController,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitSessionRuntimeController.ts"),
);
const {
  buildPlanApprovalIdentity,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planApprovalIdentity.ts"),
);
const {
  persistHarnessRunMarker,
  readHarnessRunMarker,
  settleHarnessRunMarkerIfOwned,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/harnessCrashTelemetry.ts"),
);

const runtimeKeys = ["currentTurnId", "agentStatus", "elapsedTime", "taskFlow"];
const controllerRuntimeKeys = [
  ...runtimeKeys,
  "conversationTurns",
  "planArtifacts",
  "planTasks",
  "planStage",
  "showPlanPanel",
  "showDiff",
  "showTerminal",
  "rightPanelTab",
  "normalizedStreamState",
  "currentTurnState",
];

function createRuntimeFromState(state) {
  return {
    currentTurnId: state.currentTurnId ?? null,
    agentStatus: state.agentStatus || "idle",
    elapsedTime: state.elapsedTime ?? 0,
    taskFlow: Array.isArray(state.taskFlow) ? state.taskFlow : [],
  };
}

function pickRuntimePatch(source) {
  const patch = {};
  for (const key of runtimeKeys) {
    if (Object.hasOwn(source, key)) patch[key] = source[key];
  }
  return patch;
}

function createControllerRuntimeFromState(state) {
  return {
    ...createRuntimeFromState(state),
    conversationTurns: Array.isArray(state.conversationTurns) ? state.conversationTurns : [],
    planArtifacts: Array.isArray(state.planArtifacts) ? state.planArtifacts : [],
    planTasks: Array.isArray(state.planTasks) ? state.planTasks : [],
    planStage: state.planStage || "idle",
    showPlanPanel: state.showPlanPanel === true,
    showDiff: state.showDiff === true,
    showTerminal: state.showTerminal === true,
    rightPanelTab: state.rightPanelTab || "terminal",
    normalizedStreamState: state.normalizedStreamState || {},
    currentTurnState: state.currentTurnState || {},
  };
}

function pickControllerRuntimePatch(source) {
  const patch = {};
  for (const key of controllerRuntimeKeys) {
    if (Object.hasOwn(source, key)) patch[key] = source[key];
  }
  return patch;
}

function createControllerState(overrides = {}) {
  return {
    currentWorkspace: "/tmp/app",
    currentSessionId: 42,
    runtimeBySessionKey: {},
    currentTurnId: "turn-1",
    agentStatus: "idle",
    elapsedTime: 8,
    taskFlow: [],
    conversationTurns: [
      {
        id: "turn-1",
        userPrompt: "Fix the thing",
        status: "executing",
        collapsed: true,
        elapsedTime: 0,
        blockIds: [],
      },
    ],
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planStage: "idle",
    isPlanApproved: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: true,
    rightPanelTab: "terminal",
    normalizedStreamState: {},
    currentTurnState: { turnId: "" },
    config: { workflowMode: "chat" },
    ...overrides,
  };
}

function buildAcceptedControllerPlan(label) {
  return [
    "# Plan runtime identity refresh",
    "",
    "## User goal",
    `- ${label}: keep the reviewed Plan bound to the exact materialized bytes.`,
    "",
    "## Key changes",
    "- Update the same plan artifact path while preserving a monotonic revision.",
    "- Refresh the pending review request so a control rendered for older bytes is stale.",
    "",
    "## Execution steps",
    "1. Materialize the accepted Plan artifact.",
    "2. Recompute the review identity from the stored artifact set.",
    "3. Require the refreshed identity before execution can be approved.",
    "",
    "## Validation",
    "- Assert the revision, artifact hash, artifact paths, and request id all describe the latest write.",
    "",
  ].join("\n");
}

function buildPlanToolControllerFixture() {
  const sessionKey = "/tmp/app:42";
  const sessionEpoch = "session-epoch-plan-tool";
  const artifactPath = ".MAIN/plans/plan.md";
  const initialArtifact = {
    kind: "plan",
    path: artifactPath,
    title: "Plan",
    content: buildAcceptedControllerPlan("Approved revision"),
    revision: 1,
    updatedAt: 100,
  };
  const identity = buildPlanApprovalIdentity([initialArtifact]);
  assert.ok(identity);
  const planExecution = {
    schemaVersion: 1,
    sessionKey,
    sessionEpoch,
    planTurnId: "turn-1",
    approvalLeaseId: "approval-lease-plan-tool",
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    executionLeaseId: "execution-lease-plan-tool",
    executionTurnId: "turn-1",
    executionRunId: "run-plan-tool",
    parentRunId: "run-review-plan-tool",
    attempt: 1,
    instructionHash: "instruction-plan-tool",
  };
  const pendingRequest = {
    schemaVersion: 1,
    requestId: "action-tool-plan-tool",
    kind: "tool_permission",
    sessionKey,
    turnId: planExecution.executionTurnId,
    runId: planExecution.executionRunId,
    parentRunId: planExecution.parentRunId,
    title: "Execute approved Plan",
    status: "pending",
    createdAt: 120,
    resolvedAt: null,
    taskId: 77,
    toolName: "apply_patch",
    target: "src/main.ts",
    risk: "write",
    planExecution,
  };
  const reviewIdentity = {
    sessionKey,
    sessionEpoch,
    turnId: "turn-1",
    runId: "run-review-plan-tool",
    parentRunId: null,
    requestId: "review-plan-tool",
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
  };
  const approvalLease = {
    schemaVersion: 2,
    leaseId: planExecution.approvalLeaseId,
    sessionKey,
    sessionEpoch,
    planTurnId: "turn-1",
    reviewRunId: reviewIdentity.runId,
    requestId: reviewIdentity.requestId,
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
    approvedAt: 110,
    approvalTurnId: "turn-1",
    approvalRunId: reviewIdentity.runId,
    approvalDecisionKind: "action_decision",
  };
  const executionLease = {
    schemaVersion: 2,
    executionLeaseId: planExecution.executionLeaseId,
    approvalLeaseId: approvalLease.leaseId,
    sessionKey,
    sessionEpoch,
    planTurnId: "turn-1",
    executionTurnId: pendingRequest.turnId,
    executionRunId: pendingRequest.runId,
    parentRunId: pendingRequest.parentRunId,
    attempt: 1,
    issuedAt: 111,
    reason: "initial_approval",
    instructionHash: planExecution.instructionHash,
    authorization: {
      kind: "action_decision",
      sessionKey,
      sessionEpoch,
      turnId: "turn-1",
      runId: reviewIdentity.runId,
      requestId: reviewIdentity.requestId,
    },
  };
  const planLifecycle = {
    schemaVersion: 2,
    version: 5,
    status: "paused",
    sessionKey,
    sessionEpoch,
    planTurnId: "turn-1",
    artifactIdentity: identity,
    reviewIdentity,
    approvalLease,
    executionLease,
    lastIssuedAttempt: 1,
    execution: {
      turnId: pendingRequest.turnId,
      runId: pendingRequest.runId,
      parentRunId: pendingRequest.parentRunId,
      attempt: 1,
      startedAt: 112,
    },
    pause: {
      reason: "tool_permission",
      resultKind: "partial",
      resumeCondition: "resolve_action_request",
    },
    updatedAt: 120,
  };
  const exactHarnessRunMarker = {
    schemaVersion: 1,
    runId: "run-plan-outer",
    activeRunId: pendingRequest.runId,
    activeParentRunId: pendingRequest.parentRunId,
    activePlanExecutionProvenance: planExecution,
    instanceId: "instance-plan-tool",
    sessionKey,
    turnId: pendingRequest.turnId,
    status: "paused",
    startedAt: 109,
    updatedAt: 120,
  };
  return {
    sessionKey,
    initialArtifact,
    pendingRequest,
    planLifecycle,
    exactHarnessRunMarker,
  };
}

function applySet(stateRef, patchOrUpdater) {
  const patch = typeof patchOrUpdater === "function"
    ? patchOrUpdater(stateRef.current)
    : patchOrUpdater;
  stateRef.current = { ...stateRef.current, ...patch };
}

function installFakeLocalStorageWindow() {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };
  return () => {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  };
}

test("submit pre-run session patcher writes directly when origin session is active", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/app",
      currentSessionId: 42,
      runtimeBySessionKey: {},
      currentTurnId: "turn-ui",
      agentStatus: "idle",
      elapsedTime: 0,
      taskFlow: [],
      pendingRunDecision: null,
    },
  };

  const applyPreRunPatch = createSubmitPreRunSessionPatcher({
    originSessionKey: "/tmp/app:42",
    originSnapshot: stateRef.current,
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    createRuntimeFromState,
    pickRuntimePatch,
  });

  applyPreRunPatch({
    agentStatus: "running",
    pendingRunDecision: { kind: "intent_confirmation" },
  });

  assert.equal(stateRef.current.agentStatus, "running");
  assert.deepEqual(stateRef.current.pendingRunDecision, {
    kind: "intent_confirmation",
  });
  assert.deepEqual(stateRef.current.runtimeBySessionKey, {});
});

test("submit pre-run session patcher writes only runtime fields for background origin sessions", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/ui",
      currentSessionId: 7,
      runtimeBySessionKey: {},
      currentTurnId: "turn-ui",
      agentStatus: "idle",
      elapsedTime: 0,
      taskFlow: [],
      pendingRunDecision: null,
    },
  };
  const originSnapshot = {
    currentWorkspace: "/tmp/run",
    currentSessionId: 42,
    runtimeBySessionKey: {},
    currentTurnId: "turn-origin",
    agentStatus: "idle",
    elapsedTime: 2,
    taskFlow: [{ id: 1 }],
    pendingRunDecision: null,
  };

  const applyPreRunPatch = createSubmitPreRunSessionPatcher({
    originSessionKey: "/tmp/run:42",
    originSnapshot,
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    createRuntimeFromState,
    pickRuntimePatch,
  });

  applyPreRunPatch({
    agentStatus: "pending_review",
    elapsedTime: 9,
    pendingRunDecision: { kind: "intent_confirmation" },
  });

  assert.equal(stateRef.current.agentStatus, "idle");
  assert.equal(stateRef.current.elapsedTime, 0);
  assert.equal(stateRef.current.pendingRunDecision, null);
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].currentTurnId, "turn-origin");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].agentStatus, "pending_review");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].elapsedTime, 9);
  assert.equal(
    Object.hasOwn(stateRef.current.runtimeBySessionKey["/tmp/run:42"], "pendingRunDecision"),
    false,
  );
});

test("submit session runtime facade writes active runs to top-level state and runtime snapshot", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/app",
      currentSessionId: 42,
      runtimeBySessionKey: {},
      currentTurnId: "turn-ui",
      agentStatus: "idle",
      elapsedTime: 0,
      taskFlow: [],
      globalOnly: "before",
    },
  };

  const facade = createSubmitSessionRuntimeFacade({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/app:42",
    createRuntimeFromState,
    pickRuntimePatch,
  });

  facade.seedSessionRuntime();
  facade.sessionSet({
    agentStatus: "running",
    elapsedTime: 3,
    globalOnly: "after",
  });

  assert.equal(stateRef.current.agentStatus, "running");
  assert.equal(stateRef.current.elapsedTime, 3);
  assert.equal(stateRef.current.globalOnly, "after");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/app:42"].agentStatus, "running");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/app:42"].elapsedTime, 3);
  assert.equal(Object.hasOwn(stateRef.current.runtimeBySessionKey["/tmp/app:42"], "globalOnly"), false);
});

test("submit session runtime facade writes background runs only to their runtime snapshot", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/ui",
      currentSessionId: 7,
      runtimeBySessionKey: {
        "/tmp/run:42": {
          currentTurnId: "turn-run",
          agentStatus: "running",
          elapsedTime: 5,
          taskFlow: [{ id: 1 }],
        },
      },
      currentTurnId: "turn-ui",
      agentStatus: "idle",
      elapsedTime: 0,
      taskFlow: [],
      globalOnly: "ui",
    },
  };

  const facade = createSubmitSessionRuntimeFacade({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/run:42",
    createRuntimeFromState,
    pickRuntimePatch,
    decorateScopedState: (state) => ({ ...state, decorated: true }),
  });

  facade.sessionSet((scoped) => {
    assert.equal(scoped.currentTurnId, "turn-run");
    assert.equal(scoped.elapsedTime, 5);
    return {
      agentStatus: "pending_review",
      elapsedTime: scoped.elapsedTime + 1,
      globalOnly: "should-not-touch-ui",
    };
  });

  assert.equal(stateRef.current.currentTurnId, "turn-ui");
  assert.equal(stateRef.current.agentStatus, "idle");
  assert.equal(stateRef.current.elapsedTime, 0);
  assert.equal(stateRef.current.globalOnly, "ui");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].agentStatus, "pending_review");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].elapsedTime, 6);

  const scoped = facade.sessionGet();
  assert.equal(scoped.currentTurnId, "turn-run");
  assert.equal(scoped.decorated, true);
});

test("owner-scoped publication preserves concurrent config and Session index updates", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/app",
      currentSessionId: 42,
      runtimeBySessionKey: {},
      sessionsByWorkspace: {
        "/tmp/app": [
          { id: 42, title: "Original title", messages: [], storageStatus: "temporary" },
          { id: 99, title: "Neighbor", messages: [] },
        ],
        "/tmp/other": [{ id: 1, title: "Other workspace" }],
      },
      currentTurnId: "turn-run",
      agentStatus: "running",
      elapsedTime: 2,
      taskFlow: [{ id: 1, content: "working" }],
      config: { theme: "old", sessionRecordingEnabled: true },
    },
  };
  const facade = createSubmitSessionRuntimeFacade({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/app:42",
    createRuntimeFromState,
    pickRuntimePatch,
  });
  facade.seedSessionRuntime();
  const revisionToken = facade.getSessionRevisionToken();
  const projectedState = {
    ...facade.sessionGet(),
    agentStatus: "idle",
    elapsedTime: 8,
    taskFlow: [{ id: 2, content: "done" }],
  };
  const durableState = {
    ...projectedState,
    sessionsByWorkspace: {
      ...projectedState.sessionsByWorkspace,
      "/tmp/app": projectedState.sessionsByWorkspace["/tmp/app"].map((session) =>
        session.id === 42
          ? {
              ...session,
              title: "Original title",
              messages: [{ id: 2, content: "done" }],
              runtimeSnapshot: { terminal: true },
              updatedAtMs: 500,
              storageStatus: "ok",
            }
          : session
      ),
    },
  };

  stateRef.current = {
    ...stateRef.current,
    config: { theme: "latest", sessionRecordingEnabled: false },
    sessionsByWorkspace: {
      "/tmp/app": [
        {
          id: 42,
          title: "Concurrent semantic title",
          titleSource: "semantic",
          messages: [],
          storageStatus: "temporary",
        },
        { id: 99, title: "Neighbor updated concurrently", messages: [{ id: 99 }] },
        { id: 100, title: "New concurrent Session" },
      ],
      "/tmp/other": [{ id: 1, title: "Other workspace updated" }],
      "/tmp/new": [{ id: 5, title: "New workspace Session" }],
    },
  };

  const publication = facade.publishOwnerScopedRuntimeProjection({
    projectedState,
    durableState,
    scopeKey: "/tmp/app",
    sessionId: 42,
    expectedRevisionToken: revisionToken,
  });

  assert.deepEqual(publication, { published: true, disposition: "published" });
  assert.deepEqual(stateRef.current.config, {
    theme: "latest",
    sessionRecordingEnabled: false,
  });
  assert.equal(stateRef.current.agentStatus, "idle");
  assert.equal(stateRef.current.elapsedTime, 8);
  assert.deepEqual(stateRef.current.taskFlow, [{ id: 2, content: "done" }]);
  const targetSession = stateRef.current.sessionsByWorkspace["/tmp/app"][0];
  assert.equal(targetSession.title, "Concurrent semantic title");
  assert.equal(targetSession.titleSource, "semantic");
  assert.deepEqual(targetSession.messages, [{ id: 2, content: "done" }]);
  assert.deepEqual(targetSession.runtimeSnapshot, { terminal: true });
  assert.equal(targetSession.updatedAtMs, 500);
  assert.equal(targetSession.storageStatus, "ok");
  assert.equal(
    stateRef.current.sessionsByWorkspace["/tmp/app"][1].title,
    "Neighbor updated concurrently",
  );
  assert.equal(stateRef.current.sessionsByWorkspace["/tmp/app"].length, 3);
  assert.equal(stateRef.current.sessionsByWorkspace["/tmp/new"][0].id, 5);
  assert.equal(stateRef.current.sessionsByWorkspace["/tmp/other"][0].title, "Other workspace updated");
});

test("owner-scoped terminal publication settles Harness only after revision CAS succeeds", () => {
  const restoreWindow = installFakeLocalStorageWindow();
  try {
    const runningMarker = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-terminal",
      instanceId: "instance-terminal",
      sessionKey: "/tmp/app:42",
      workspace: "/tmp/app",
      sessionId: 42,
      turnId: "turn-run",
      status: "running",
      startedAt: 100,
      updatedAt: 100,
    });
    const exactOwner = {
      runId: runningMarker.runId,
      sessionKey: runningMarker.sessionKey,
      turnId: runningMarker.turnId,
      instanceId: runningMarker.instanceId,
      startedAt: runningMarker.startedAt,
    };
    const terminalMarker = {
      ...runningMarker,
      status: "completed",
      closeReason: "turn_completed",
      closedAt: 500,
      updatedAt: 500,
    };
    const stateRef = {
      current: {
        currentWorkspace: "/tmp/app",
        currentSessionId: 42,
        runtimeBySessionKey: {},
        sessionsByWorkspace: {
          "/tmp/app": [{ id: 42, title: "Terminal", messages: [] }],
        },
        currentTurnId: "turn-run",
        agentStatus: "running",
        elapsedTime: 1,
        taskFlow: [{ id: 1, content: "working" }],
      },
    };
    const facade = createSubmitSessionRuntimeFacade({
      get: () => stateRef.current,
      set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
      runSessionKey: "/tmp/app:42",
      createRuntimeFromState,
      pickRuntimePatch,
    });
    facade.seedSessionRuntime();

    const buildTerminalProjection = () => {
      const projectedState = {
        ...facade.sessionGet(),
        agentStatus: "idle",
        elapsedTime: 9,
        taskFlow: [{ id: 2, content: "done" }],
      };
      return {
        projectedState,
        durableState: {
          ...projectedState,
          sessionsByWorkspace: {
            ...projectedState.sessionsByWorkspace,
            "/tmp/app": [{
              ...projectedState.sessionsByWorkspace["/tmp/app"][0],
              messages: [{ id: 2, content: "done" }],
            }],
          },
        },
      };
    };

    const staleRevisionToken = facade.getSessionRevisionToken();
    const staleProjection = buildTerminalProjection();
    facade.sessionSet({ elapsedTime: 2 });
    let settleCalls = 0;
    const settleBeforePublish = () => {
      settleCalls += 1;
      assert.equal(stateRef.current.agentStatus, "running");
      assert.deepEqual(stateRef.current.taskFlow, [{ id: 1, content: "working" }]);
      assert.ok(settleHarnessRunMarkerIfOwned(terminalMarker, exactOwner));
    };

    const conflictedPublication = facade.publishOwnerScopedRuntimeProjection({
      ...staleProjection,
      scopeKey: "/tmp/app",
      sessionId: 42,
      expectedRevisionToken: staleRevisionToken,
      beforePublish: settleBeforePublish,
    });
    assert.deepEqual(conflictedPublication, {
      published: false,
      disposition: "revision_conflict",
    });
    assert.equal(settleCalls, 0);
    assert.equal(readHarnessRunMarker().status, "running");
    assert.equal(stateRef.current.agentStatus, "running");

    const retryRevisionToken = facade.getSessionRevisionToken();
    const retryProjection = buildTerminalProjection();
    const acceptedPublication = facade.publishOwnerScopedRuntimeProjection({
      ...retryProjection,
      scopeKey: "/tmp/app",
      sessionId: 42,
      expectedRevisionToken: retryRevisionToken,
      beforePublish: settleBeforePublish,
    });
    assert.deepEqual(acceptedPublication, { published: true, disposition: "published" });
    assert.equal(settleCalls, 1);
    assert.equal(readHarnessRunMarker().status, "completed");
    assert.equal(readHarnessRunMarker().closeReason, "turn_completed");
    assert.equal(stateRef.current.agentStatus, "idle");
    assert.deepEqual(stateRef.current.taskFlow, [{ id: 2, content: "done" }]);
  } finally {
    restoreWindow();
  }
});

test("a foreign global Harness owner cannot prevent an old Session from publishing its conclusion", () => {
  const restoreWindow = installFakeLocalStorageWindow();
  try {
    const foreignMarker = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-foreign",
      instanceId: "instance-foreign",
      sessionKey: "/tmp/foreign:7",
      workspace: "/tmp/foreign",
      sessionId: 7,
      turnId: "turn-foreign",
      status: "running",
      startedAt: 700,
      updatedAt: 700,
    });
    const oldMarker = {
      ...foreignMarker,
      runId: "run-old",
      instanceId: "instance-old",
      sessionKey: "/tmp/app:42",
      workspace: "/tmp/app",
      sessionId: 42,
      turnId: "turn-old",
      status: "completed",
      closeReason: "old_turn_completed",
      startedAt: 100,
      closedAt: 800,
      updatedAt: 800,
    };
    const stateRef = {
      current: {
        currentWorkspace: "/tmp/app",
        currentSessionId: 42,
        runtimeBySessionKey: {},
        sessionsByWorkspace: {
          "/tmp/app": [{ id: 42, title: "Old Session", messages: [] }],
        },
        currentTurnId: "turn-old",
        agentStatus: "running",
        elapsedTime: 3,
        taskFlow: [{ id: 1, content: "working" }],
      },
    };
    const facade = createSubmitSessionRuntimeFacade({
      get: () => stateRef.current,
      set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
      runSessionKey: "/tmp/app:42",
      createRuntimeFromState,
      pickRuntimePatch,
    });
    facade.seedSessionRuntime();
    const revisionToken = facade.getSessionRevisionToken();
    const projectedState = {
      ...facade.sessionGet(),
      agentStatus: "idle",
      elapsedTime: 6,
      taskFlow: [{ id: 2, content: "old turn done" }],
    };
    let ownerLost = false;

    const publication = facade.publishOwnerScopedRuntimeProjection({
      projectedState,
      scopeKey: "/tmp/app",
      sessionId: 42,
      expectedRevisionToken: revisionToken,
      beforePublish: () => {
        assert.equal(stateRef.current.agentStatus, "running");
        ownerLost = settleHarnessRunMarkerIfOwned(oldMarker, {
          runId: oldMarker.runId,
          sessionKey: oldMarker.sessionKey,
          turnId: oldMarker.turnId,
          instanceId: oldMarker.instanceId,
          startedAt: oldMarker.startedAt,
        }) === null;
      },
    });

    assert.deepEqual(publication, { published: true, disposition: "published" });
    assert.equal(ownerLost, true);
    assert.equal(stateRef.current.agentStatus, "idle");
    assert.deepEqual(stateRef.current.taskFlow, [{ id: 2, content: "old turn done" }]);
    assert.equal(readHarnessRunMarker().runId, foreignMarker.runId);
    assert.equal(readHarnessRunMarker().sessionKey, foreignMarker.sessionKey);
    assert.equal(readHarnessRunMarker().status, "running");
  } finally {
    restoreWindow();
  }
});

test("owner-scoped publication updates a background runtime without touching the visible Session", () => {
  const runRuntime = {
    currentTurnId: "turn-run",
    agentStatus: "running",
    elapsedTime: 3,
    taskFlow: [{ id: 1 }],
  };
  const visibleRuntime = {
    currentTurnId: "turn-visible",
    agentStatus: "pending_review",
    elapsedTime: 11,
    taskFlow: [{ id: 50 }],
  };
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/visible",
      currentSessionId: 7,
      runtimeBySessionKey: {
        "/tmp/run:42": runRuntime,
        "/tmp/visible:7": visibleRuntime,
      },
      sessionsByWorkspace: {
        "/tmp/run": [{ id: 42, title: "Run", messages: [] }],
        "/tmp/visible": [{ id: 7, title: "Visible", messages: [{ id: 50 }] }],
      },
      ...visibleRuntime,
      config: { theme: "latest" },
    },
  };
  const facade = createSubmitSessionRuntimeFacade({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/run:42",
    createRuntimeFromState,
    pickRuntimePatch,
  });
  const revisionToken = facade.getSessionRevisionToken();
  const projectedState = {
    ...facade.sessionGet(),
    agentStatus: "idle",
    elapsedTime: 9,
    taskFlow: [{ id: 2 }],
  };
  const durableState = {
    ...projectedState,
    sessionsByWorkspace: {
      ...projectedState.sessionsByWorkspace,
      "/tmp/run": [{
        ...projectedState.sessionsByWorkspace["/tmp/run"][0],
        messages: [{ id: 2 }],
        runtimeSnapshot: { terminal: true },
        storageStatus: "ok",
      }],
    },
  };

  const publication = facade.publishOwnerScopedRuntimeProjection({
    projectedState,
    durableState,
    scopeKey: "/tmp/run",
    sessionId: 42,
    expectedRevisionToken: revisionToken,
  });

  assert.equal(publication.published, true);
  assert.equal(stateRef.current.currentTurnId, "turn-visible");
  assert.equal(stateRef.current.agentStatus, "pending_review");
  assert.equal(stateRef.current.elapsedTime, 11);
  assert.deepEqual(stateRef.current.taskFlow, [{ id: 50 }]);
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].agentStatus, "idle");
  assert.deepEqual(stateRef.current.runtimeBySessionKey["/tmp/run:42"].taskFlow, [{ id: 2 }]);
  assert.deepEqual(stateRef.current.sessionsByWorkspace["/tmp/run"][0].messages, [{ id: 2 }]);
  assert.deepEqual(
    stateRef.current.sessionsByWorkspace["/tmp/visible"][0].messages,
    [{ id: 50 }],
  );
  assert.equal(stateRef.current.config.theme, "latest");
});

test("a seeded facade treats a deleted runtime key as ownership lost", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/run",
      currentSessionId: 42,
      runtimeBySessionKey: {},
      currentTurnId: "turn-owner",
      agentStatus: "running",
      elapsedTime: 4,
      taskFlow: [{ id: 1 }],
      config: { theme: "old" },
    },
  };
  const facade = createSubmitSessionRuntimeFacade({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/run:42",
    createRuntimeFromState,
    pickRuntimePatch,
  });
  facade.seedSessionRuntime();
  const projectedState = {
    ...facade.sessionGet(),
    agentStatus: "idle",
    taskFlow: [{ id: 2 }],
  };

  stateRef.current = {
    ...stateRef.current,
    currentTurnId: "turn-reset-global",
    agentStatus: "pending_review",
    elapsedTime: 20,
    taskFlow: [{ id: 70 }],
    config: { theme: "latest" },
    runtimeBySessionKey: {},
  };
  assert.equal(facade.sessionGet().currentTurnId, "turn-owner");

  stateRef.current = {
    ...stateRef.current,
    currentWorkspace: "/tmp/visible",
    currentSessionId: 7,
    currentTurnId: "turn-visible",
  };
  const missingToken = facade.getSessionRevisionToken();
  stateRef.current = { ...stateRef.current, config: { theme: "newer" } };
  assert.equal(facade.getSessionRevisionToken(), missingToken);
  assert.equal(facade.hasSessionRuntimeOwnership(), false);
  assert.equal(facade.sessionGet().currentTurnId, "turn-owner");

  facade.sessionSet({ agentStatus: "idle", elapsedTime: 99 });
  assert.deepEqual(stateRef.current.runtimeBySessionKey, {});
  assert.equal(stateRef.current.agentStatus, "pending_review");
  assert.equal(stateRef.current.elapsedTime, 20);

  const beforePublication = stateRef.current;
  let beforePublishCalls = 0;
  const publication = facade.publishOwnerScopedRuntimeProjection({
    projectedState,
    durableState: projectedState,
    scopeKey: "/tmp/run",
    sessionId: 42,
    expectedRevisionToken: missingToken,
    beforePublish: () => {
      beforePublishCalls += 1;
    },
  });
  assert.deepEqual(publication, { published: false, disposition: "ownership_lost" });
  assert.equal(beforePublishCalls, 0);
  assert.deepEqual(stateRef.current, beforePublication);
  assert.deepEqual(stateRef.current.runtimeBySessionKey, {});
});

test("a recreated Session with the same runtime key cannot inherit an old facade generation", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/run",
      currentSessionId: 42,
      runtimeBySessionKey: {},
      currentTurnId: "turn-old",
      agentStatus: "running",
      elapsedTime: 1,
      taskFlow: [],
      config: { theme: "old" },
    },
  };
  const createFacade = () => createSubmitSessionRuntimeFacade({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/run:42",
    createRuntimeFromState,
    pickRuntimePatch,
  });
  const oldFacade = createFacade();
  oldFacade.seedSessionRuntime();
  const oldOwnerToken = oldFacade.getSessionRuntimeOwnerToken();
  assert.equal(oldFacade.hasSessionRuntimeOwnership(oldOwnerToken), true);

  delete stateRef.current.runtimeBySessionKey["/tmp/run:42"];
  stateRef.current = {
    ...stateRef.current,
    currentTurnId: "turn-new",
    agentStatus: "idle",
  };
  const newFacade = createFacade();
  newFacade.seedSessionRuntime();

  assert.equal(oldFacade.hasSessionRuntimeOwnership(oldOwnerToken), false);
  assert.equal(newFacade.hasSessionRuntimeOwnership(newFacade.getSessionRuntimeOwnerToken()), true);
  oldFacade.sessionSet({ agentStatus: "running", elapsedTime: 99 });
  assert.equal(stateRef.current.agentStatus, "idle");
  assert.equal(stateRef.current.elapsedTime, 1);
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].agentStatus, "idle");
});

test("durable Session patch excludes mutable metadata returned by a save adapter", () => {
  const projectedState = {
    sessionsByWorkspace: {
      workspace: [{
        id: 7,
        title: "Old title",
        modelConfig: { model: "old" },
        messages: [],
        storageStatus: "temporary",
      }],
    },
  };
  const durableState = {
    sessionsByWorkspace: {
      workspace: [{
        id: 7,
        title: "Adapter title must not publish",
        modelConfig: { model: "adapter" },
        messages: [{ id: 1 }],
        runtimeSnapshot: { terminal: true },
        storageStatus: "ok",
        updatedAtMs: 10,
      }],
    },
  };

  assert.deepEqual(buildOwnerScopedDurableSessionPatch({
    projectedState,
    durableState,
    scopeKey: "workspace",
    sessionId: 7,
  }), {
    messages: [{ id: 1 }],
    runtimeSnapshot: { terminal: true },
    storageStatus: "ok",
    updatedAtMs: 10,
  });
});

test("submit session runtime controller decorates active scoped callbacks", async () => {
  const events = [];
  const stateRef = {
    current: createControllerState(),
  };

  const controller = createSubmitSessionRuntimeController({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/app:42",
    createRuntimeFromState: createControllerRuntimeFromState,
    pickRuntimePatch: pickControllerRuntimePatch,
    derivePlanStageFromArtifacts: () => "planning",
    createDefaultCurrentTurnState: () => ({ interceptorHandled: false }),
    logStoreEvent: (event, data) => events.push({ event, data }),
    nowMs: () => 4242,
  });

  const scoped = controller.sessionGet();
  scoped.setConversationTurnStatus("turn-1", "awaiting_input");
  scoped.setRightPanelTab("diff");
  scoped.startNewTurn({ chatId: "remote-1" });

  assert.equal(stateRef.current.conversationTurns[0].status, "awaiting_input");
  assert.equal(stateRef.current.conversationTurns[0].collapsed, false);
  assert.equal(stateRef.current.conversationTurns[0].elapsedTime, 8);
  assert.equal(stateRef.current.rightPanelTab, "diff");
  assert.equal(stateRef.current.showDiff, true);
  assert.equal(stateRef.current.showPlanPanel, false);
  assert.deepEqual(stateRef.current.currentTurnState, {
    interceptorHandled: false,
    turnId: "4242",
    remoteFeishu: { chatId: "remote-1" },
  });
  assert.equal(await controller.sessionGet().openPlanWorkspacePanel(), false);
  assert.equal(stateRef.current.rightPanelTab, "plan");
  assert.deepEqual(events, []);
});

test("decorated session reads keep a stable raw revision token until the Store changes", () => {
  const stateRef = {
    current: createControllerState(),
  };
  const controller = createSubmitSessionRuntimeController({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/app:42",
    createRuntimeFromState: createControllerRuntimeFromState,
    pickRuntimePatch: pickControllerRuntimePatch,
    derivePlanStageFromArtifacts: () => "planning",
    createDefaultCurrentTurnState: () => ({ interceptorHandled: false }),
    logStoreEvent: () => {},
  });

  const firstRead = controller.sessionGet();
  const firstToken = controller.getSessionRevisionToken();
  const secondRead = controller.sessionGet();
  const secondToken = controller.getSessionRevisionToken();
  assert.notEqual(firstRead, secondRead);
  assert.equal(firstToken, secondToken);

  stateRef.current = { ...stateRef.current, unrelatedGlobalUiValue: true };
  assert.equal(controller.getSessionRevisionToken(), firstToken);

  controller.sessionSet({ elapsedTime: 9 });
  assert.notEqual(controller.getSessionRevisionToken(), firstToken);
  assert.equal(controller.sessionGet().elapsedTime, 9);
});

test("submit session runtime controller writes decorated callbacks to background runtime", () => {
  const stateRef = {
    current: createControllerState({
      currentWorkspace: "/tmp/run",
      currentSessionId: 42,
      currentTurnId: "turn-run",
      elapsedTime: 5,
      conversationTurns: [
        {
          id: "turn-run",
          userPrompt: "Implement feature",
          status: "executing",
          collapsed: true,
          elapsedTime: 0,
          blockIds: [],
        },
      ],
    }),
  };

  const controller = createSubmitSessionRuntimeController({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/run:42",
    createRuntimeFromState: createControllerRuntimeFromState,
    pickRuntimePatch: pickControllerRuntimePatch,
    derivePlanStageFromArtifacts: () => "planning",
    createDefaultCurrentTurnState: () => ({ interceptorHandled: false }),
    logStoreEvent: () => {},
  });

  stateRef.current = {
    ...stateRef.current,
    currentWorkspace: "/tmp/ui",
    currentSessionId: 7,
    currentTurnId: "turn-ui",
    elapsedTime: 0,
    conversationTurns: [
      {
        id: "turn-ui",
        userPrompt: "Visible chat",
        status: "executing",
        collapsed: true,
        elapsedTime: 0,
        blockIds: [],
      },
    ],
  };

  controller.sessionGet().setConversationTurnStatus("turn-run", "awaiting_approval");

  assert.equal(stateRef.current.conversationTurns[0].id, "turn-ui");
  assert.equal(stateRef.current.conversationTurns[0].status, "executing");
  const runRuntime = stateRef.current.runtimeBySessionKey["/tmp/run:42"];
  assert.equal(runRuntime.conversationTurns[0].id, "turn-run");
  assert.equal(runRuntime.conversationTurns[0].status, "awaiting_approval");
  assert.equal(runRuntime.conversationTurns[0].collapsed, false);
  assert.equal(runRuntime.conversationTurns[0].elapsedTime, 5);
});

test("submit session runtime controller advances Plan revision and refreshes pending review identity", () => {
  const staleReviewRequest = {
    schemaVersion: 1,
    requestId: "action-plan-review-run-plan-0-stale",
    kind: "plan_review",
    sessionKey: "/tmp/app:42",
    turnId: "turn-1",
    runId: "run-plan",
    parentRunId: null,
    title: "Review Plan",
    status: "pending",
    createdAt: 0,
    planRevision: 99,
    artifactHash: "plan-stale",
    artifactPaths: [".MAIN/plans/plan.md"],
  };
  const stateRef = {
    current: createControllerState({ activeActionRequest: staleReviewRequest }),
  };

  const controller = createSubmitSessionRuntimeController({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/app:42",
    createRuntimeFromState: createControllerRuntimeFromState,
    pickRuntimePatch: pickControllerRuntimePatch,
    derivePlanStageFromArtifacts: () => "review",
    createDefaultCurrentTurnState: () => ({ interceptorHandled: false }),
    logStoreEvent: () => {},
  });

  const artifactPath = ".MAIN/plans/plan.md";
  controller.sessionGet().upsertPlanArtifact({
    kind: "plan",
    path: artifactPath,
    title: "Plan",
    content: buildAcceptedControllerPlan("First revision"),
    revision: 41,
    updatedAt: 100,
  });

  const firstArtifact = stateRef.current.planArtifacts[0];
  const firstReviewRequest = stateRef.current.activeActionRequest;
  assert.equal(firstArtifact.revision, 1);
  assert.equal(firstReviewRequest.kind, "plan_review");
  assert.equal(firstReviewRequest.planRevision, 1);
  assert.deepEqual(firstReviewRequest.artifactPaths, [artifactPath]);
  assert.notEqual(firstReviewRequest.artifactHash, staleReviewRequest.artifactHash);
  assert.notEqual(firstReviewRequest.requestId, staleReviewRequest.requestId);

  controller.sessionGet().upsertPlanArtifact({
    kind: "plan",
    path: artifactPath,
    title: "Plan",
    content: buildAcceptedControllerPlan("Second revision"),
    revision: 41,
    updatedAt: 200,
  });

  const secondArtifact = stateRef.current.planArtifacts[0];
  const secondReviewRequest = stateRef.current.activeActionRequest;
  assert.equal(stateRef.current.planArtifacts.length, 1);
  assert.equal(secondArtifact.path, artifactPath);
  assert.equal(secondArtifact.revision, 2);
  assert.equal(secondReviewRequest.kind, "plan_review");
  assert.equal(secondReviewRequest.planRevision, 2);
  assert.deepEqual(secondReviewRequest.artifactPaths, [artifactPath]);
  assert.notEqual(secondReviewRequest.artifactHash, firstReviewRequest.artifactHash);
  assert.notEqual(secondReviewRequest.requestId, firstReviewRequest.requestId);

  // A Plan approval control is an exact identity lease. Once the artifact is
  // rewritten, every identity field captured by the old control is stale.
  assert.notDeepEqual(
    {
      requestId: secondReviewRequest.requestId,
      planRevision: secondReviewRequest.planRevision,
      artifactHash: secondReviewRequest.artifactHash,
    },
    {
      requestId: firstReviewRequest.requestId,
      planRevision: firstReviewRequest.planRevision,
      artifactHash: firstReviewRequest.artifactHash,
    },
  );
  assert.equal(stateRef.current.isPlanApproved, false);
});

test("Plan artifact changes reject and clear the exact pending Plan tool permission", () => {
  const {
    sessionKey,
    initialArtifact,
    pendingRequest,
    planLifecycle,
    exactHarnessRunMarker,
  } = buildPlanToolControllerFixture();
  const decisions = [];
  const events = [];
  let aborts = 0;
  const abortController = {
    signal: { aborted: false },
    abort() {
      aborts += 1;
      this.signal.aborted = true;
    },
  };
  const stateRef = {
    current: createControllerState({
      planArtifacts: [initialArtifact],
      planLifecycle,
      harnessRunMarker: exactHarnessRunMarker,
      activeActionRequest: pendingRequest,
      pendingReviewResolve: (decision) => decisions.push(decision),
      pendingReviewTaskId: pendingRequest.taskId,
      pendingToolCall: { name: pendingRequest.toolName },
      abortController,
      planStage: "ready_to_execute",
    }),
  };

  const controller = createSubmitSessionRuntimeController({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: sessionKey,
    createRuntimeFromState: createControllerRuntimeFromState,
    pickRuntimePatch: pickControllerRuntimePatch,
    derivePlanStageFromArtifacts: () => "plan",
    createDefaultCurrentTurnState: () => ({ interceptorHandled: false }),
    logStoreEvent: (event, data) => events.push({ event, data }),
    nowMs: () => 200,
  });

  controller.sessionGet().upsertPlanArtifact({
    ...initialArtifact,
    content: buildAcceptedControllerPlan("Changed after tool pause"),
    updatedAt: 200,
  });

  assert.deepEqual(decisions, [{ action: "reject" }]);
  assert.equal(aborts, 1);
  assert.equal(stateRef.current.activeActionRequest, null);
  assert.equal(stateRef.current.pendingReviewResolve, null);
  assert.equal(stateRef.current.pendingReviewTaskId, null);
  assert.equal(stateRef.current.pendingToolCall, null);
  assert.equal(stateRef.current.planLifecycle.approvalLease, null);
  assert.equal(stateRef.current.planLifecycle.executionLease, null);
  assert.equal(stateRef.current.planLifecycle.execution, null);
  assert.equal(stateRef.current.planLifecycle.pause.reason, "artifact_identity_changed");
  assert.equal(stateRef.current.isPlanApproved, false);
  assert.equal(
    events.some((entry) => entry.event === "plan_tool_permission_invalidated_by_artifact_change"),
    true,
  );
});

test("Plan artifact invalidation rejects stale review state without aborting an unrelated active Run", () => {
  const {
    sessionKey,
    initialArtifact,
    pendingRequest,
    planLifecycle,
    exactHarnessRunMarker,
  } = buildPlanToolControllerFixture();
  const unrelatedHarnessRunMarker = {
    ...exactHarnessRunMarker,
    runId: "run-generic-outer",
    activeRunId: "run-generic-active",
    activeParentRunId: null,
    activePlanExecutionProvenance: null,
    turnId: "turn-generic-active",
    status: "running",
  };
  const decisions = [];
  const events = [];
  let aborts = 0;
  const abortController = {
    signal: { aborted: false },
    abort() {
      aborts += 1;
      this.signal.aborted = true;
    },
  };
  const stateRef = {
    current: createControllerState({
      planArtifacts: [initialArtifact],
      planLifecycle,
      harnessRunMarker: unrelatedHarnessRunMarker,
      activeActionRequest: pendingRequest,
      pendingReviewResolve: (decision) => decisions.push(decision),
      pendingReviewTaskId: pendingRequest.taskId,
      pendingToolCall: { name: pendingRequest.toolName },
      abortController,
      agentStatus: "running",
      planStage: "ready_to_execute",
    }),
  };
  const controller = createSubmitSessionRuntimeController({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: sessionKey,
    createRuntimeFromState: createControllerRuntimeFromState,
    pickRuntimePatch: pickControllerRuntimePatch,
    derivePlanStageFromArtifacts: () => "plan",
    createDefaultCurrentTurnState: () => ({ interceptorHandled: false }),
    logStoreEvent: (event, data) => events.push({ event, data }),
    nowMs: () => 201,
  });

  controller.sessionGet().upsertPlanArtifact({
    ...initialArtifact,
    content: buildAcceptedControllerPlan("Changed while a generic Run owns the Session"),
    updatedAt: 201,
  });

  assert.deepEqual(decisions, [{ action: "reject" }]);
  assert.equal(aborts, 0);
  assert.equal(abortController.signal.aborted, false);
  assert.equal(stateRef.current.activeActionRequest, null);
  assert.equal(stateRef.current.pendingReviewResolve, null);
  assert.equal(stateRef.current.pendingReviewTaskId, null);
  assert.equal(stateRef.current.pendingToolCall, null);
  assert.equal(stateRef.current.harnessRunMarker, unrelatedHarnessRunMarker);
  assert.equal(stateRef.current.planLifecycle.approvalLease, null);
  assert.equal(stateRef.current.planLifecycle.executionLease, null);
  assert.equal(stateRef.current.planLifecycle.execution, null);
  assert.equal(
    events.some((entry) => entry.event === "plan_tool_permission_invalidated_by_artifact_change"),
    true,
  );
  assert.equal(
    events.some((entry) => entry.event === "plan_execution_aborted_by_artifact_change"),
    false,
  );
});

test("submit elapsed timer updates active elapsed time and clears itself when run ends", () => {
  let now = 1000;
  let agentStatus = "running";
  const patches = [];
  const callbacks = [];
  const cleared = [];

  const timer = startSubmitElapsedTimer({
    sessionGet: () => ({ agentStatus }),
    sessionSet: (patch) => patches.push(patch),
    nowMs: () => now,
    setTimer: (callback, ms) => {
      assert.equal(ms, 1000);
      callbacks.push(callback);
      return "timer-1";
    },
    clearTimer: (handle) => cleared.push(handle),
  });

  assert.equal(timer.timerInterval, "timer-1");
  now = 2600;
  callbacks[0]();
  assert.deepEqual(patches, [{ elapsedTime: 2 }]);

  agentStatus = "idle";
  callbacks[0]();
  assert.deepEqual(cleared, ["timer-1"]);
  assert.equal(timer.getElapsedSeconds(), 2);
});

test("submit elapsed timer resumes from a persisted turn total", () => {
  let now = 10_000;
  const patches = [];
  const callbacks = [];

  const timer = startSubmitElapsedTimer({
    sessionGet: () => ({ agentStatus: "running" }),
    sessionSet: (patch) => patches.push(patch),
    initialElapsedSeconds: 8,
    nowMs: () => now,
    setTimer: (callback) => {
      callbacks.push(callback);
      return "timer-resumed";
    },
    clearTimer: () => {},
  });

  now = 12_600;
  callbacks[0]();
  assert.deepEqual(patches, [{ elapsedTime: 11 }]);
  assert.equal(timer.getElapsedSeconds(), 11);
});
