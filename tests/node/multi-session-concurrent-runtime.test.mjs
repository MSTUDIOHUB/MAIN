import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();
let tauriInvoke = async () => "";

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  const source = fs.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith("@tauri-apps/")) {
      return {
        invoke: (...args) => tauriInvoke(...args),
        isTauri: () => false,
        listen: async () => () => {},
        open: async () => null,
        relaunch: async () => {},
        exit: async () => {},
        check: async () => null,
      };
    }
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
        path.join(basePath, "index.tsx"),
      ]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildRestoredSessionRuntimePatch,
  buildSessionRuntimeSnapshotFromStoreState,
  GLOBAL_CHAT_KEY,
  sanitizeTaskBlocksForPersist,
  useAppStore,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/store/useAppStore.ts"));
const {
  createSubmitSessionRuntimeController,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitSessionRuntimeController.ts"),
);
const {
  createRuntimeV2CheckpointPort,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/runtimeV2/checkpointPort.ts"),
);
const {
  createRuntimeV2ProjectionPort,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/runtimeV2/projectionPort.ts"),
);
const {
  persistSubmitRuntimeProjection,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/persistSubmitRuntimeProjection.ts"),
);
const {
  runSubmitAsyncWorkflowRun,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitAsyncWorkflowRun.ts"),
);
const {
  selectTurnIngressAvailability,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnIngress.ts"));
const {
  parseSessionRuntimeKey,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/sessionTypes.ts"));
const runtimeV2 = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
);

const RUNTIME_KEYS = [
  "runtimeEventSchemaVersion",
  "runtimeEvents",
  "harnessRunMarker",
  "activeActionRequest",
  "rulesDraftReview",
  "turnRuntimeCheckpoints",
  "runtimeV2Checkpoints",
  "runtimeV2EmergencyTerminalEnvelopes",
  "planLifecycle",
  "taskFlow",
  "conversationTurns",
  "currentTurnId",
  "agentMessages",
  "agentStatus",
  "isGenerating",
  "abortController",
  "elapsedTime",
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

function pickRuntimePatch(source) {
  const patch = {};
  for (const key of RUNTIME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      patch[key] = source[key];
    }
  }
  return patch;
}

function createRuntimeFromSnapshotState(state) {
  const snapshot = buildSessionRuntimeSnapshotFromStoreState(state);
  return {
    ...snapshot,
    planLifecycle: state.planLifecycle,
    taskFlow: state.taskFlow || [],
    conversationTurns: state.conversationTurns || [],
    currentTurnId: state.currentTurnId ?? null,
    agentMessages: state.agentMessages || [],
    agentStatus: state.agentStatus || "idle",
    isGenerating: state.isGenerating === true,
    abortController: state.abortController || null,
    elapsedTime: state.elapsedTime ?? 0,
    planArtifacts: state.planArtifacts || [],
    planTasks: state.planTasks || [],
    planStage: state.planStage || "idle",
    showPlanPanel: state.showPlanPanel === true,
    showDiff: state.showDiff === true,
    showTerminal: state.showTerminal === true,
    rightPanelTab: state.rightPanelTab || "plan",
    normalizedStreamState: state.normalizedStreamState || { phase: "idle" },
    currentTurnState: state.currentTurnState || { turnId: "" },
  };
}

function makeStartedCheckpoint({
  workspaceKey,
  sessionKey,
  sessionEpoch,
  turnId,
  runId,
  strategy,
  objectiveText,
  at,
}) {
  const turn = {
    workspaceKey,
    sessionKey,
    sessionEpoch,
    turnId,
    clientSubmissionId: `sub-${turnId}`,
  };
  const run = {
    sessionKey,
    sessionEpoch,
    turnId,
    parentRunId: null,
    runId,
    attemptId: `attempt-${runId}`,
  };
  const admitted = runtimeV2.appendRuntimeV2Checkpoint({
    checkpoint: null,
    owner: turn,
    expectedRevision: 0,
    event: {
      schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      eventId: `${runId}-admit`,
      type: "turn.admitted",
      sequence: 0,
      at,
      turn,
      strategy,
      objective: objectiveText,
      constraints: [],
      acceptanceCriteria: [],
    },
  });
  assert.equal(admitted.disposition, "committed", admitted.reason);
  const started = runtimeV2.appendRuntimeV2Checkpoint({
    checkpoint: admitted.checkpoint,
    owner: turn,
    expectedRevision: admitted.checkpoint.revision,
    event: {
      schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      eventId: `${runId}-start`,
      type: "run.started",
      sequence: 1,
      at: at + 1,
      run,
      phase: strategy === "execute" ? "observing" : "planning",
    },
  });
  assert.equal(started.disposition, "committed", started.reason);
  return {
    turn,
    run,
    checkpoint: started.checkpoint,
  };
}

function eventFor(seq, at, fields) {
  return {
    schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    eventId: `evt-${fields.run?.runId || "x"}-${seq}`,
    sequence: seq,
    at,
    ...fields,
  };
}

test("parseSessionRuntimeKey resolves workspace and Global Chat owner identities", () => {
  assert.deepEqual(parseSessionRuntimeKey("/Users/dev/Repo:42"), {
    workspaceKey: "/Users/dev/Repo",
    currentWorkspace: "/Users/dev/Repo",
    sessionId: 42,
  });
  assert.deepEqual(parseSessionRuntimeKey(`${GLOBAL_CHAT_KEY}:99`), {
    workspaceKey: GLOBAL_CHAT_KEY,
    currentWorkspace: "",
    sessionId: 99,
  });
  assert.equal(parseSessionRuntimeKey("invalid"), null);
  assert.equal(parseSessionRuntimeKey("repo:0"), null);
});

test("concurrent workspace execute and Global Chat sessions preserve checkpoints and config across foreground switches", async () => {
  const workspace = "/tmp/unity-framework";
  const wsSessionId = 101;
  const wsSessionKey = `${workspace}:${wsSessionId}`;
  const wsEpoch = "epoch-ws-101";

  const chatSessionId = 202;
  const chatSessionKey = `${GLOBAL_CHAT_KEY}:${chatSessionId}`;
  const chatEpoch = "epoch-chat-202";

  const wsBoot = makeStartedCheckpoint({
    workspaceKey: workspace,
    sessionKey: wsSessionKey,
    sessionEpoch: wsEpoch,
    turnId: "turn-ws",
    runId: "run-ws",
    strategy: "execute",
    objectiveText: "Implement module",
    at: 100,
  });
  const chatBoot = makeStartedCheckpoint({
    workspaceKey: GLOBAL_CHAT_KEY,
    sessionKey: chatSessionKey,
    sessionEpoch: chatEpoch,
    turnId: "turn-chat",
    runId: "run-chat",
    strategy: "chat",
    objectiveText: "Explain architecture",
    at: 200,
  });

  const makeSeededRuntime = ({
    boot,
    scopeKey,
    sessionKey,
    sessionEpoch,
    workspaceValue,
  }) =>
    createRuntimeFromSnapshotState({
      currentWorkspace: workspaceValue,
      currentSessionId:
        sessionKey === wsSessionKey ? wsSessionId : chatSessionId,
      planLifecycle: {
        schemaVersion: 1,
        sessionKey,
        sessionEpoch,
        status: "idle",
        updatedAt: 10,
      },
      harnessRunMarker: {
        schemaVersion: 1,
        runId: boot.run.runId,
        instanceId: "instance-1",
        sessionKey,
        turnId: boot.turn.turnId,
        status: "running",
        startedAt: 10,
        updatedAt: 10,
      },
      runtimeEvents: [],
      turnRuntimeCheckpoints: {},
      runtimeV2Checkpoints: { [boot.turn.turnId]: boot.checkpoint },
      runtimeV2EmergencyTerminalEnvelopes: {},
      taskFlow: [],
      conversationTurns: [
        {
          id: boot.turn.turnId,
          userPrompt: boot.checkpoint.aggregate.objective.text,
          title: boot.checkpoint.aggregate.objective.text,
          mode: scopeKey === GLOBAL_CHAT_KEY ? "chat" : "edit",
          intent: boot.checkpoint.aggregate.strategy,
          status:
            boot.checkpoint.aggregate.strategy === "execute"
              ? "executing"
              : "running",
          blockIds: [],
          createdAt: 10,
        },
      ],
      currentTurnId: boot.turn.turnId,
      agentMessages: [],
      agentStatus: "running",
      isGenerating: true,
    });

  let state = {
    currentWorkspace: workspace,
    currentSessionId: wsSessionId,
    config: {
      ...useAppStore.getState().config,
      workspace,
      language: "zh",
      sessionRecordingEnabled: true,
    },
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: wsSessionId,
          title: "Unity Execute",
          messages: [],
          planLifecycleEpoch: wsEpoch,
        },
      ],
      [GLOBAL_CHAT_KEY]: [
        {
          id: chatSessionId,
          title: "Global Chat",
          messages: [],
          planLifecycleEpoch: chatEpoch,
        },
      ],
    },
    runtimeBySessionKey: {},
    planLifecycle: null,
    harnessRunMarker: null,
    runtimeEvents: [],
    turnRuntimeCheckpoints: {},
    runtimeV2Checkpoints: {},
    runtimeV2EmergencyTerminalEnvelopes: {},
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    agentMessages: [],
    agentStatus: "idle",
    isGenerating: false,
  };

  state.runtimeBySessionKey[wsSessionKey] = makeSeededRuntime({
    boot: wsBoot,
    scopeKey: workspace,
    sessionKey: wsSessionKey,
    sessionEpoch: wsEpoch,
    workspaceValue: workspace,
  });
  state.runtimeBySessionKey[chatSessionKey] = makeSeededRuntime({
    boot: chatBoot,
    scopeKey: GLOBAL_CHAT_KEY,
    sessionKey: chatSessionKey,
    sessionEpoch: chatEpoch,
    workspaceValue: "",
  });
  Object.assign(state, state.runtimeBySessionKey[wsSessionKey]);

  const switchForeground = (targetScopeKey, targetSessionId) => {
    const targetKey = `${targetScopeKey}:${targetSessionId}`;
    const targetRuntime = state.runtimeBySessionKey[targetKey];
    const nextWorkspace = targetScopeKey === GLOBAL_CHAT_KEY ? "" : targetScopeKey;
    state = {
      ...state,
      ...targetRuntime,
      currentWorkspace: nextWorkspace,
      currentSessionId: targetSessionId,
      config: { ...state.config, workspace: nextWorkspace },
    };
  };

  const get = () => state;
  const set = (patchOrUpdater) => {
    const patch =
      typeof patchOrUpdater === "function" ? patchOrUpdater(state) : patchOrUpdater;
    if (patch && typeof patch === "object") {
      state = { ...state, ...patch };
    }
  };

  const makePortsFor = (sessionKey, scopeKey, sessionId) => {
    const controller = createSubmitSessionRuntimeController({
      get,
      set,
      runSessionKey: sessionKey,
      borrowExistingRuntimeOwnership: true,
      createRuntimeFromState: createRuntimeFromSnapshotState,
      pickRuntimePatch,
      derivePlanStageFromArtifacts: () => "idle",
      createDefaultCurrentTurnState: () => ({ turnId: "" }),
      logStoreEvent: () => {},
    });
    const checkpoint = createRuntimeV2CheckpointPort({
      get: controller.sessionGet,
      set: controller.sessionSet,
      scopeKey,
      sessionId,
      getSessionRevisionToken: controller.getSessionRevisionToken,
      sanitizeTaskBlocksForPersist,
      buildSessionRuntimeSnapshot: buildSessionRuntimeSnapshotFromStoreState,
      persistSessionRecord: async (_scope, session) => {
        // Yield across microtasks so foreground switches interleave with durable persistence.
        await Promise.resolve();
        return session;
      },
      publishOwnerScopedRuntimeProjection:
        controller.publishOwnerScopedRuntimeProjection,
      logStoreEvent: () => {},
    });
    let nextTaskSeq = 1;
    const projection = createRuntimeV2ProjectionPort({
      get: controller.sessionGet,
      set: controller.sessionSet,
      nextTaskId: () => nextTaskSeq++,
      language: "zh",
      logStoreEvent: () => {},
    });
    return { controller, checkpoint, projection };
  };

  const wsPorts = makePortsFor(wsSessionKey, workspace, wsSessionId);
  const chatPorts = makePortsFor(chatSessionKey, GLOBAL_CHAT_KEY, chatSessionId);

  const originalWarn = console.warn;
  const filteredWarnings = [];
  console.warn = (...args) => {
    if (String(args[0] || "").includes("runtime_v2_checkpoint_filtered")) {
      filteredWarnings.push(args.map((arg) => String(arg)).join(" "));
    }
  };

  const appendViaPort = async (port, payload) => {
    const res = await port.append(payload);
    assert.equal(res?.disposition, "committed", String(res?.reason || res?.disposition || ""));
    return res.checkpoint;
  };

  try {
    // 1. User switches foreground to Global Chat while Workspace Execute writes in background.
    switchForeground(GLOBAL_CHAT_KEY, chatSessionId);
    assert.equal(wsPorts.controller.sessionGet().currentWorkspace, workspace);
    assert.equal(wsPorts.controller.sessionGet().config.workspace, workspace);

    let wsCurrent = wsBoot.checkpoint;
    for (let step = 2; step <= 4; step += 1) {
      wsCurrent = await appendViaPort(wsPorts.checkpoint, {
        owner: wsBoot.turn,
        expectedRevision: wsCurrent.revision,
        event: eventFor(step, 100 + step, {
          type: "command.scheduled",
          run: wsBoot.run,
          command: {
            kind: "request_model",
            phase: "observing",
            run: wsBoot.run,
            idempotencyKey: `req-ws-${step}`,
            payload: { mode: "execute" },
          },
        }),
      });
      await wsPorts.projection.publish({
        aggregate: wsCurrent.aggregate,
        audience: "capsule_live",
        projection: {
          id: `proj-ws-${step}`,
          audience: "capsule_live",
          kind: "live_action",
          dedupeKey: `ws-live-${step}`,
          markdown: `Working step ${step}`,
        },
      });
    }

    // 2. Simultaneously, switch foreground back to Workspace while Global Chat writes & finishes in background.
    switchForeground(workspace, wsSessionId);
    assert.equal(chatPorts.controller.sessionGet().currentWorkspace, "");
    assert.equal(chatPorts.controller.sessionGet().config.workspace, "");

    let chatCurrent = chatBoot.checkpoint;
    chatCurrent = await appendViaPort(chatPorts.checkpoint, {
      owner: chatBoot.turn,
      expectedRevision: chatCurrent.revision,
      event: eventFor(2, 210, {
        type: "command.scheduled",
        run: chatBoot.run,
        command: {
          kind: "request_model",
          phase: "planning",
          run: chatBoot.run,
          idempotencyKey: "req-chat-1",
          payload: { mode: "chat" },
        },
      }),
    });
    chatCurrent = await appendViaPort(chatPorts.checkpoint, {
      owner: chatBoot.turn,
      expectedRevision: chatCurrent.revision,
      event: eventFor(3, 212, {
        type: "phase.changed",
        run: chatBoot.run,
        phase: "finalizing",
      }),
    });
    const chatFinalProjection = {
      id: "proj-chat-final",
      audience: "final",
      kind: "final",
      dedupeKey: "chat-final",
      markdown: "Global Chat answer delivered.",
    };
    chatCurrent = await appendViaPort(chatPorts.checkpoint, {
      owner: chatBoot.turn,
      expectedRevision: chatCurrent.revision,
      event: eventFor(4, 215, {
        type: "run.completed",
        run: chatBoot.run,
        outcome: {
          resultKind: "success",
          reason: "completed",
          completedAt: 215,
          finalProjectionId: "proj-chat-final",
        },
        finalProjection: chatFinalProjection,
      }),
    });
    await chatPorts.projection.publish({
      aggregate: chatCurrent.aggregate,
      audience: "final",
      projection: chatFinalProjection,
    });

    // 3. Complete background Workspace Execute while Global Chat is foreground again.
    switchForeground(GLOBAL_CHAT_KEY, chatSessionId);
    wsCurrent = await appendViaPort(wsPorts.checkpoint, {
      owner: wsBoot.turn,
      expectedRevision: wsCurrent.revision,
      event: eventFor(5, 298, {
        type: "phase.changed",
        run: wsBoot.run,
        phase: "finalizing",
      }),
    });
    const wsFinalProjection = {
      id: "proj-ws-final",
      audience: "final",
      kind: "final",
      dedupeKey: "ws-final",
      markdown: "Workspace Execute completed cleanly.",
    };
    wsCurrent = await appendViaPort(wsPorts.checkpoint, {
      owner: wsBoot.turn,
      expectedRevision: wsCurrent.revision,
      event: eventFor(6, 300, {
        type: "run.completed",
        run: wsBoot.run,
        outcome: {
          resultKind: "success",
          reason: "completed",
          completedAt: 300,
          finalProjectionId: "proj-ws-final",
        },
        finalProjection: wsFinalProjection,
      }),
    });
    await wsPorts.projection.publish({
      aggregate: wsCurrent.aggregate,
      audience: "final",
      projection: wsFinalProjection,
    });

    assert.deepEqual(filteredWarnings, []);
    const wsSavedRuntime = state.runtimeBySessionKey[wsSessionKey];
    const chatSavedRuntime = state.runtimeBySessionKey[chatSessionKey];
    assert.equal(
      wsSavedRuntime.runtimeV2Checkpoints["turn-ws"].aggregate.terminalOutcome?.resultKind,
      "success",
    );
    assert.equal(wsSavedRuntime.isGenerating, false);
    assert.equal(wsSavedRuntime.agentStatus, "idle");
    assert.equal(
      chatSavedRuntime.runtimeV2Checkpoints["turn-chat"].aggregate.terminalOutcome?.resultKind,
      "success",
    );
    assert.equal(chatSavedRuntime.isGenerating, false);
    assert.equal(chatSavedRuntime.agentStatus, "idle");
  } finally {
    console.warn = originalWarn;
  }
});

test("concurrent multi-session bootstrap preserves lease when another same-instance session acquires the global marker first", async () => {
  let globalMarker = null;
  let releaseWorkspaceTree;
  let workspaceTreeStarted;
  const workspaceTreeStartedGate = new Promise((resolve) => {
    workspaceTreeStarted = resolve;
  });
  const workspaceTreeGate = new Promise((resolve) => {
    releaseWorkspaceTree = resolve;
  });

  const ownerA = {};
  const sessionKeyA = "/tmp/unity-framework:101";
  let stateA = {
    currentWorkspace: "/tmp/unity-framework",
    currentSessionId: 101,
    agentMessages: [],
    planStage: "idle",
    isPlanApproved: false,
    harnessRunMarker: null,
    planLifecycle: {
      schemaVersion: 1,
      sessionKey: sessionKeyA,
      sessionEpoch: "epoch-a",
      status: "idle",
      updatedAt: 1,
    },
    conversationTurns: [
      {
        id: "turn-a",
        userPrompt: "Build module",
        title: "Build module",
        mode: "edit",
        intent: "execute",
        status: "executing",
        blockIds: [],
        createdAt: 1,
      },
    ],
    taskFlow: [],
    runtimeEvents: [],
    runtimeV2Checkpoints: {},
    sessionsByWorkspace: {
      "/tmp/unity-framework": [{ id: 101, planLifecycleEpoch: "epoch-a" }],
    },
    config: {
      ...useAppStore.getState().config,
      workspace: "/tmp/unity-framework",
      language: "zh",
    },
  };
  let revisionA = 1;
  let startedRunCount = 0;

  const runA = runSubmitAsyncWorkflowRun({
    runIdOverride: "run-session-a",
    runWorkspace: "/tmp/unity-framework",
    runScopeKey: "/tmp/unity-framework",
    runSessionId: 101,
    runSessionKey: sessionKeyA,
    turnId: "turn-a",
    uiDisplayTurnId: "turn-a",
    text: "Build module",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    effectiveIntentSummary: "Execute",
    preferredLanguage: "zh",
    currentImages: [],
    attachedFilesSnapshot: [],
    mentionSnapshot: [],
    isHidden: false,
    turnInputContextSignals: {},
    elapsedTimer: { getElapsedSeconds: () => 1, dispose: () => {} },
    sessionGet: () => stateA,
    sessionSet: (patchOrFn) => {
      revisionA += 1;
      const patch =
        typeof patchOrFn === "function" ? patchOrFn(stateA) : patchOrFn;
      stateA = { ...stateA, ...patch };
    },
    getSessionRuntimeOwnerToken: () => ownerA,
    hasSessionRuntimeOwnership: (token) => token === ownerA,
    getSessionRevisionToken: () => revisionA,
    sanitizeTaskBlocksForPersist,
    buildSessionRuntimeSnapshot: buildSessionRuntimeSnapshotFromStoreState,
    publishOwnerScopedRuntimeProjection: ({ durableState, projectedState }) => {
      stateA = { ...stateA, ...(durableState || projectedState) };
      return {
        published: true,
        disposition: "published",
      };
    },
    persistBootstrapProjection: async (projected) => projected,
    logStoreEvent: () => {},
    createAbortController: () => new AbortController(),
    getCurrentHarnessInstanceId: () => "instance-shared",
    readHarnessRunMarker: () => globalMarker,
    acquireHarnessRunMarker: (marker, expectedCurrent) => {
      if (globalMarker !== expectedCurrent) return null;
      globalMarker = marker;
      return marker;
    },
    persistHarnessRunMarkerIfOwned: (marker) => marker,
    getWorkspaceTree: async () => {
      workspaceTreeStarted();
      await workspaceTreeGate;
      return "[D] Assets";
    },
    nowMs: () => 500,
    sendStartedAt: 500,
    getLastTurnToolSummary: () => "",
    getLastVisibleTurnAgentSummary: () => "",
    markUserContextItemFailed: () => {},
    ingestAttachmentFile: async () => {
      throw new Error("unexpected");
    },
    readFile: async () => {
      throw new Error("unexpected");
    },
    readDocument: async () => {
      throw new Error("unexpected");
    },
    analyzeTabularDocument: async () => {
      throw new Error("unexpected");
    },
    nextTaskId: () => 1,
    createVisibleTurnForHiddenMessage: () => {},
    phaseRunners: {
      buildAttachmentContext: async () => ({
        userContent: "Build module",
        attachmentRefs: [],
        failedAttachmentCount: 0,
      }),
      buildPromptContext: () => ({ userContent: "Build module" }),
      runRuntime: async () => {
        startedRunCount += 1;
        return {
          disposition: "projected",
          identity: { runId: "run-session-a", sessionKey: sessionKeyA, turnId: "turn-a" },
          outcome: { status: "completed", resultKind: "success" },
        };
      },
    },
  });

  await workspaceTreeStartedGate;

  // Session B (Global Chat) in the same MAIN window acquires globalMarker while Session A is awaiting getWorkspaceTree.
  globalMarker = {
    schemaVersion: 1,
    runId: "run-session-b",
    instanceId: "instance-shared",
    sessionKey: `${GLOBAL_CHAT_KEY}:202`,
    turnId: "turn-b",
    status: "running",
    startedAt: 400,
    updatedAt: 400,
  };

  releaseWorkspaceTree();
  await runA;

  assert.equal(startedRunCount, 1);
  assert.equal(globalMarker.runId, "run-session-a");
  assert.equal(stateA.harnessRunMarker?.runId, "run-session-a");
});

test("cross-instance global marker acquisition during bootstrap still fails closed", async () => {
  let globalMarker = null;
  let releaseWorkspaceTree;
  let workspaceTreeStarted;
  const workspaceTreeStartedGate = new Promise((resolve) => {
    workspaceTreeStarted = resolve;
  });
  const workspaceTreeGate = new Promise((resolve) => {
    releaseWorkspaceTree = resolve;
  });

  const ownerA = {};
  const sessionKeyA = "/tmp/unity-framework:102";
  let stateA = {
    currentWorkspace: "/tmp/unity-framework",
    currentSessionId: 102,
    agentMessages: [],
    planStage: "idle",
    isPlanApproved: false,
    harnessRunMarker: null,
    planLifecycle: {
      schemaVersion: 1,
      sessionKey: sessionKeyA,
      sessionEpoch: "epoch-a-2",
      status: "idle",
      updatedAt: 1,
    },
    conversationTurns: [
      {
        id: "turn-a-2",
        userPrompt: "Build module",
        title: "Build module",
        mode: "edit",
        intent: "execute",
        status: "executing",
        blockIds: [],
        createdAt: 1,
      },
    ],
    taskFlow: [],
    runtimeEvents: [],
    runtimeV2Checkpoints: {},
    sessionsByWorkspace: {
      "/tmp/unity-framework": [{ id: 102, planLifecycleEpoch: "epoch-a-2" }],
    },
    config: {
      ...useAppStore.getState().config,
      workspace: "/tmp/unity-framework",
      language: "zh",
    },
  };
  let revisionA = 1;
  let startedRunCount = 0;

  const runA = runSubmitAsyncWorkflowRun({
    runIdOverride: "run-session-a-2",
    runWorkspace: "/tmp/unity-framework",
    runScopeKey: "/tmp/unity-framework",
    runSessionId: 102,
    runSessionKey: sessionKeyA,
    turnId: "turn-a-2",
    uiDisplayTurnId: "turn-a-2",
    text: "Build module",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    effectiveIntentSummary: "Execute",
    preferredLanguage: "zh",
    currentImages: [],
    attachedFilesSnapshot: [],
    mentionSnapshot: [],
    isHidden: false,
    turnInputContextSignals: {},
    elapsedTimer: { getElapsedSeconds: () => 1, dispose: () => {} },
    sessionGet: () => stateA,
    sessionSet: (patchOrFn) => {
      revisionA += 1;
      const patch =
        typeof patchOrFn === "function" ? patchOrFn(stateA) : patchOrFn;
      stateA = { ...stateA, ...patch };
    },
    getSessionRuntimeOwnerToken: () => ownerA,
    hasSessionRuntimeOwnership: (token) => token === ownerA,
    getSessionRevisionToken: () => revisionA,
    sanitizeTaskBlocksForPersist,
    buildSessionRuntimeSnapshot: buildSessionRuntimeSnapshotFromStoreState,
    publishOwnerScopedRuntimeProjection: ({ durableState, projectedState }) => {
      stateA = { ...stateA, ...(durableState || projectedState) };
      return {
        published: true,
        disposition: "published",
      };
    },
    persistBootstrapProjection: async (projected) => projected,
    logStoreEvent: () => {},
    createAbortController: () => new AbortController(),
    getCurrentHarnessInstanceId: () => "instance-shared",
    readHarnessRunMarker: () => globalMarker,
    acquireHarnessRunMarker: (marker, expectedCurrent) => {
      if (globalMarker !== expectedCurrent) return null;
      globalMarker = marker;
      return marker;
    },
    persistHarnessRunMarkerIfOwned: (marker) => marker,
    getWorkspaceTree: async () => {
      workspaceTreeStarted();
      await workspaceTreeGate;
      return "[D] Assets";
    },
    nowMs: () => 500,
    sendStartedAt: 500,
    getLastTurnToolSummary: () => "",
    getLastVisibleTurnAgentSummary: () => "",
    markUserContextItemFailed: () => {},
    ingestAttachmentFile: async () => {
      throw new Error("unexpected");
    },
    readFile: async () => {
      throw new Error("unexpected");
    },
    readDocument: async () => {
      throw new Error("unexpected");
    },
    analyzeTabularDocument: async () => {
      throw new Error("unexpected");
    },
    nextTaskId: () => 1,
    createVisibleTurnForHiddenMessage: () => {},
    phaseRunners: {
      buildAttachmentContext: async () => ({
        userContent: "Build module",
        attachmentRefs: [],
        failedAttachmentCount: 0,
      }),
      buildPromptContext: () => ({ userContent: "Build module" }),
      runRuntime: async () => {
        startedRunCount += 1;
        return {
          disposition: "projected",
          identity: { runId: "run-session-a-2", sessionKey: sessionKeyA, turnId: "turn-a-2" },
          outcome: { status: "completed", resultKind: "success" },
        };
      },
    },
  });

  await workspaceTreeStartedGate;

  // Different window/renderer instance acquires globalMarker -> must still fail closed.
  globalMarker = {
    schemaVersion: 1,
    runId: "run-foreign-instance",
    instanceId: "instance-foreign",
    sessionKey: `${GLOBAL_CHAT_KEY}:203`,
    turnId: "turn-foreign",
    status: "running",
    startedAt: 400,
    updatedAt: 400,
  };

  releaseWorkspaceTree();
  await runA;

  assert.equal(startedRunCount, 0);
  assert.equal(globalMarker.runId, "run-foreign-instance");
  assert.ok(
    stateA.runtimeEvents.some(
      (event) =>
        event.type === "turn.completed" &&
        event.turnId === "turn-a-2" &&
        event.resultKind === "error",
    ),
  );
});

test("closeTurnAsCanceled and buildRestoredSessionRuntimePatch isolate owner workspace from foreground switches", async () => {
  const workspace = "/tmp/unity-framework";
  const wsSessionId = 101;
  const wsSessionKey = `${workspace}:${wsSessionId}`;
  const wsEpoch = "epoch-ws-restore";

  const boot = makeStartedCheckpoint({
    workspaceKey: workspace,
    sessionKey: wsSessionKey,
    sessionEpoch: wsEpoch,
    turnId: "turn-bg",
    runId: "run-bg",
    strategy: "execute",
    objectiveText: "Background task",
    at: 50,
  });

  const savedSnapshot = buildSessionRuntimeSnapshotFromStoreState({
    currentWorkspace: workspace,
    currentSessionId: wsSessionId,
    planLifecycle: {
      schemaVersion: 1,
      sessionKey: wsSessionKey,
      sessionEpoch: wsEpoch,
      status: "idle",
      updatedAt: 50,
    },
    runtimeV2Checkpoints: { "turn-bg": boot.checkpoint },
    taskFlow: [],
    conversationTurns: [
      {
        id: "turn-bg",
        userPrompt: "Background task",
        title: "Background task",
        mode: "edit",
        intent: "execute",
        status: "executing",
        blockIds: [],
        createdAt: 50,
      },
    ],
    currentTurnId: "turn-bg",
    agentMessages: [],
  });

  // Restore workspace snapshot while Global Chat ("") is currently active in fallbackState.
  const restoredPatch = buildRestoredSessionRuntimePatch({
    snapshot: savedSnapshot,
    fallbackState: {
      currentWorkspace: "",
      currentSessionId: 999,
      config: { language: "zh", workspace: "" },
    },
    workspacePath: workspace,
    expectedSessionKey: wsSessionKey,
    expectedSessionEpoch: wsEpoch,
  });
  assert.ok(restoredPatch.runtimeV2Checkpoints?.["turn-bg"]);

  // Background cancellation initiated while active, then switched to Global Chat before durable persist resolves.
  const prevTauriInvoke = tauriInvoke;
  const prevState = useAppStore.getState();
  let releaseSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  tauriInvoke = async (cmd) => {
    if (cmd === "save_project_session") {
      await saveGate;
      return { id: wsSessionId, storageRevision: 2 };
    }
    return null;
  };

  try {
    useAppStore.setState({
      currentWorkspace: workspace,
      currentSessionId: wsSessionId,
      config: { ...prevState.config, workspace, sessionRecordingEnabled: false },
      sessionsByWorkspace: {
        [workspace]: [
          {
            id: wsSessionId,
            title: "BG",
            messages: [],
            planLifecycleEpoch: wsEpoch,
          },
        ],
        [GLOBAL_CHAT_KEY]: [
          {
            id: 202,
            title: "Chat",
            messages: [],
            planLifecycleEpoch: "epoch-chat",
          },
        ],
      },
      planLifecycle: {
        schemaVersion: 1,
        sessionKey: wsSessionKey,
        sessionEpoch: wsEpoch,
        status: "idle",
        updatedAt: 50,
      },
      runtimeV2Checkpoints: { "turn-bg": boot.checkpoint },
      conversationTurns: [
        {
          id: "turn-bg",
          userPrompt: "Background task",
          title: "Background task",
          mode: "edit",
          intent: "execute",
          status: "executing",
          blockIds: [],
          createdAt: 50,
        },
      ],
      taskFlow: [],
      runtimeEvents: [],
      currentTurnId: "turn-bg",
      agentStatus: "running",
      isGenerating: true,
      harnessRunMarker: {
        schemaVersion: 1,
        runId: "run-bg",
        instanceId: "instance-1",
        sessionKey: wsSessionKey,
        turnId: "turn-bg",
        status: "running",
        startedAt: 50,
        updatedAt: 50,
      },
    });

    const canceled = useAppStore.getState().closeTurnAsCanceled("turn-bg", {
      reason: "user_cancelled",
    });
    assert.equal(canceled, true);

    // Switch foreground to Global Chat immediately while cancellation closes in background.
    useAppStore.setState({
      currentWorkspace: "",
      currentSessionId: 202,
    });
    releaseSave();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const bgRuntime = useAppStore.getState().runtimeBySessionKey[wsSessionKey];
    assert.ok(bgRuntime);
    assert.equal(bgRuntime.agentStatus, "idle");
    assert.equal(bgRuntime.isGenerating, false);
    assert.ok(
      bgRuntime.runtimeEvents.some(
        (event) =>
          event.type === "turn.completed" &&
          event.threadId === wsSessionKey &&
          event.turnId === "turn-bg",
      ),
    );
  } finally {
    tauriInvoke = prevTauriInvoke;
    useAppStore.setState(prevState, true);
  }
});

test("selectTurnIngressAvailability releases unobserved non-paused checkpoints to submit while preserving paused and live runs", () => {
  const workspace = "/tmp/ingress";
  const sessionKey = `${workspace}:55`;
  const sessionEpoch = "epoch-55";
  const boot = makeStartedCheckpoint({
    workspaceKey: workspace,
    sessionKey,
    sessionEpoch,
    turnId: "turn-55",
    runId: "run-55",
    strategy: "execute",
    objectiveText: "Run step",
    at: 100,
  });

  const expectedOwner = {
    workspaceKey: workspace,
    sessionKey,
    sessionEpoch,
    turnId: "turn-55",
  };

  assert.equal(
    selectTurnIngressAvailability({
      checkpoint: null,
      runtimeV2Checkpoint: boot.checkpoint,
      expectedOwner,
      strategy: "execute",
      runtimeOwnerObserved: true,
    }).mode,
    "guidance_or_queue",
  );

  // Unobserved non-paused checkpoint must never strand the Composer in queue_only without Stop.
  assert.equal(
    selectTurnIngressAvailability({
      checkpoint: null,
      runtimeV2Checkpoint: boot.checkpoint,
      expectedOwner,
      strategy: "execute",
      runtimeOwnerObserved: false,
    }).mode,
    "submit",
  );

  const paused = runtimeV2.appendRuntimeV2Checkpoint({
    checkpoint: boot.checkpoint,
    owner: boot.turn,
    expectedRevision: boot.checkpoint.revision,
    event: {
      schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      eventId: "pause-55",
      type: "run.paused",
      sequence: 2,
      at: 110,
      run: boot.run,
      blocker: {
        requestId: "req-blocker-55",
        reasonCode: "external_state_required",
        evidenceSequence: 1,
        message: "Waiting for user action",
        options: ["recheck", "stop"],
      },
    },
  });
  assert.equal(paused.disposition, "committed", String(paused.disposition));

  assert.equal(
    selectTurnIngressAvailability({
      checkpoint: null,
      runtimeV2Checkpoint: paused.checkpoint,
      expectedOwner,
      strategy: "execute",
      runtimeOwnerObserved: false,
    }).mode,
    "queue_only",
  );
});
