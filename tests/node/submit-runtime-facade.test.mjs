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

function applySet(stateRef, patchOrUpdater) {
  const patch = typeof patchOrUpdater === "function"
    ? patchOrUpdater(stateRef.current)
    : patchOrUpdater;
  stateRef.current = { ...stateRef.current, ...patch };
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
