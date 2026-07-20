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
const { createSubmitSessionRuntimeController } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitSessionRuntimeController.ts"),
);
const {
  beginSessionCancellation,
  deferUntilSessionCancellationSettled,
  getPendingSessionCancellation,
  hasCanceledTurnTerminalProjection,
  resolveDeferredSessionSubmissionDecision,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/sessionCancellationBarrier.ts"),
);

function createState(overrides = {}) {
  return {
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
