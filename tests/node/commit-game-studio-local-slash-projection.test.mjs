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
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
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

const { commitGameStudioLocalSlashProjection } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/commitGameStudioLocalSlashProjection.ts"),
);
const { buildTemporarySubmitRuntimeProjection } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/persistSubmitRuntimeProjection.ts"),
);

const SESSION_KEY = "/workspace:7";
const SESSION_EPOCH = "session-epoch-1";
const SCOPE_KEY = "/workspace";
const SESSION_ID = 7;
const TURN_ID = "turn-local-slash-1";
const RUN_ID = "run-local-slash-1";
const SUMMARY = "Game Studio command completed.";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createClaim(overrides = {}) {
  return {
    claimId: "claim-1",
    receiptId: "receipt-1",
    clientSubmissionId: "submission-1",
    sessionKey: SESSION_KEY,
    sessionEpoch: SESSION_EPOCH,
    turnId: TURN_ID,
    admittedUserBlockId: 41,
    ...overrides,
  };
}

function createQueue(claim = createClaim()) {
  return {
    schemaVersion: 1,
    version: 3,
    sessionKey: claim.sessionKey,
    sessionEpoch: claim.sessionEpoch,
    entries: [{
      instruction: {
        schemaVersion: 1,
        kind: "workspace_instruction",
        clientSubmissionId: claim.clientSubmissionId,
        sessionKey: claim.sessionKey,
        sessionEpoch: claim.sessionEpoch,
        source: "slash_command",
        submittedAt: 1,
        payload: { text: "/agent writer" },
      },
      receipt: {
        schemaVersion: 1,
        kind: "workspace_turn_receipt",
        receiptId: claim.receiptId,
        clientSubmissionId: claim.clientSubmissionId,
        sessionKey: claim.sessionKey,
        sessionEpoch: claim.sessionEpoch,
        turnId: claim.turnId,
        userBlockId: claim.admittedUserBlockId,
        acceptedAt: 2,
      },
      status: "dispatching",
      claim: {
        claimId: claim.claimId,
        sessionKey: claim.sessionKey,
        sessionEpoch: claim.sessionEpoch,
        claimedAt: 3,
      },
      enqueuedAt: 2,
      persistedAt: 2,
      updatedAt: 3,
    }],
    updatedAt: 3,
  };
}

function createContext(overrides = {}) {
  return {
    includeTitle: true,
    sessionKey: SESSION_KEY,
    sourceTurnId: TURN_ID,
    sourceRunId: RUN_ID,
    conclusionOwner: {
      disposition: "original_appended",
      turnId: TURN_ID,
      runId: RUN_ID,
      parentRunId: null,
      resultKind: "success",
      summary: SUMMARY,
    },
    ...overrides,
  };
}

function createCanonicalState({
  claim = createClaim(),
  turnId = TURN_ID,
  runId = RUN_ID,
  parentRunId = null,
  resultKind = "success",
  summary = SUMMARY,
  extra = {},
} = {}) {
  return {
    taskFlow: [
      {
        id: claim.admittedUserBlockId,
        turnId: claim.turnId,
        type: "user",
        content: "/agent writer",
      },
      {
        id: 42,
        turnId,
        type: "agent",
        content: summary,
        streaming: false,
        visibility: "assistant_final",
      },
    ],
    conversationTurns: [{
      id: turnId,
      clientSubmissionId: claim.clientSubmissionId,
      workspaceInstructionReceiptId: claim.receiptId,
      userPrompt: "/agent writer",
      title: "Switch specialist",
      mode: "edit",
      status: "done",
      summary,
      blockIds: [claim.admittedUserBlockId, 42],
      collapsed: false,
      createdAt: 1,
      runtimeOutcome: {
        status: "completed",
        reason: "local_slash_completed",
        resultKind,
        runId,
        parentRunId,
        updatedAt: 10,
      },
    }],
    runtimeEvents: [
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: SESSION_KEY,
        turnId,
        timestampMs: 10,
        runId,
        parentRunId,
        resultKind,
        summary,
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: SESSION_KEY,
        turnId,
        timestampMs: 10,
        resultKind,
      },
    ],
    workspaceTurnQueue: createQueue(claim),
    ...extra,
  };
}

function createHarness(options = {}) {
  const controller = {
    state: options.state || createCanonicalState(),
    revisionToken: options.revisionToken || { revision: 1 },
    owned: options.owned ?? true,
    order: [],
    persistCalls: [],
    publishCalls: [],
    rememberedStates: [],
    retryDelays: [],
    logs: [],
  };

  const input = {
    context: options.context || createContext(),
    claim: options.claim === undefined ? createClaim() : options.claim,
    sessionGet: () => controller.state,
    getSessionRevisionToken: () => controller.revisionToken,
    hasSessionRuntimeOwnership: () => controller.owned,
    persistProjection: async (projectedState, expectedRevisionToken) => {
      controller.order.push("persist");
      controller.persistCalls.push({ projectedState, expectedRevisionToken });
      if (options.persistProjection) {
        return options.persistProjection(projectedState, expectedRevisionToken, controller);
      }
      return { ...clone(projectedState), durability: "session" };
    },
    publishProjection: (publication) => {
      controller.order.push("publish");
      controller.publishCalls.push(publication);
      if (options.publishProjection) {
        return options.publishProjection(publication, controller);
      }
      return { published: true, disposition: "published" };
    },
    scopeKey: SCOPE_KEY,
    sessionId: SESSION_ID,
    rememberDurableState: (durableState) => {
      controller.order.push("remember");
      controller.rememberedStates.push(durableState);
      options.rememberDurableState?.(durableState, controller);
    },
    waitForRetry: async (delayMs, abortSignal) => {
      controller.retryDelays.push(delayMs);
      await options.waitForRetry?.(delayMs, controller, abortSignal);
    },
    log: (event, data) => {
      controller.logs.push({ event, data });
    },
  };

  if (options.decorateProjection) {
    input.decorateProjection = (projectedState, context) =>
      options.decorateProjection(projectedState, context, controller);
  }
  if (options.buildMemoryFallbackProjection) {
    input.buildMemoryFallbackProjection = (projectedState, context) =>
      options.buildMemoryFallbackProjection(projectedState, context, controller);
  }
  if (options.abortSignal) input.abortSignal = options.abortSignal;
  if (options.maxAttempts != null) input.maxAttempts = options.maxAttempts;
  if (options.persistenceAttemptTimeoutMs != null) {
    input.persistenceAttemptTimeoutMs = options.persistenceAttemptTimeoutMs;
  }

  return { controller, input };
}

test("a deferred save keeps publication and completion pending while retaining the dispatching terminal head", async () => {
  const save = deferred();
  const { controller, input } = createHarness({
    decorateProjection: (state) => ({ ...state, projectionMarker: "terminal" }),
    persistProjection: () => save.promise,
  });
  let settled = false;

  const completion = commitGameStudioLocalSlashProjection(input).then(() => {
    settled = true;
  });

  assert.equal(controller.persistCalls.length, 1);
  assert.equal(controller.publishCalls.length, 0);
  assert.equal(settled, false);
  const pendingProjection = controller.persistCalls[0].projectedState;
  assert.equal(pendingProjection.workspaceTurnQueue.entries[0].status, "dispatching");
  assert.equal(pendingProjection.workspaceTurnQueue.entries[0].claim.claimId, "claim-1");
  assert.equal(
    pendingProjection.runtimeEvents.some((event) =>
      event.type === "run.completed" && event.runId === RUN_ID
    ),
    true,
  );
  assert.equal(
    pendingProjection.runtimeEvents.some((event) =>
      event.type === "turn.completed" && event.turnId === TURN_ID
    ),
    true,
  );
  assert.equal(
    pendingProjection.taskFlow.filter((block) =>
      block.type === "agent" && block.visibility === "assistant_final"
    ).length,
    1,
  );

  save.resolve({ ...clone(pendingProjection), durability: "session" });
  await completion;

  assert.equal(settled, true);
  assert.equal(controller.publishCalls.length, 1);
});

test("a successful save is remembered and then published with the captured revision", async () => {
  const token = { revision: 9 };
  const { controller, input } = createHarness({ revisionToken: token });

  await commitGameStudioLocalSlashProjection(input);

  assert.deepEqual(controller.order, ["persist", "remember", "publish"]);
  assert.equal(controller.persistCalls.length, 1);
  assert.equal(controller.rememberedStates.length, 1);
  assert.equal(controller.publishCalls.length, 1);
  assert.equal(controller.publishCalls[0].projectedState, controller.persistCalls[0].projectedState);
  assert.equal(controller.publishCalls[0].durableState, controller.rememberedStates[0]);
  assert.equal(controller.publishCalls[0].expectedRevisionToken, token);
  assert.equal(controller.publishCalls[0].scopeKey, SCOPE_KEY);
  assert.equal(controller.publishCalls[0].sessionId, SESSION_ID);
});

test("database_busy retries only persistence and publishes once without a handler callback", async () => {
  const { controller, input } = createHarness({
    persistProjection: async (projectedState, _token, current) => {
      if (current.persistCalls.length === 1) {
        const error = new Error("database_busy");
        error.code = "database_busy";
        throw error;
      }
      return { ...clone(projectedState), durability: "session" };
    },
  });

  assert.equal(Object.hasOwn(input, "executeHandler"), false);
  await commitGameStudioLocalSlashProjection(input);

  assert.equal(controller.persistCalls.length, 2);
  assert.equal(controller.publishCalls.length, 1);
  assert.deepEqual(controller.retryDelays, [100]);
  assert.equal(
    controller.logs.filter(({ event }) =>
      event === "game_studio_local_slash_persist_unavailable"
    ).length,
    1,
  );
});

test("a publication revision conflict rebuilds from the new Session state and re-persists", async () => {
  const firstToken = { revision: 1 };
  const secondToken = { revision: 2 };
  const { controller, input } = createHarness({
    revisionToken: firstToken,
    state: createCanonicalState({ extra: { projectionRevision: 1 } }),
    publishProjection: (_publication, current) => {
      if (current.publishCalls.length === 1) {
        current.state = createCanonicalState({ extra: { projectionRevision: 2 } });
        current.revisionToken = secondToken;
        return { published: false, disposition: "revision_conflict" };
      }
      return { published: true, disposition: "published" };
    },
  });

  await commitGameStudioLocalSlashProjection(input);

  assert.equal(controller.persistCalls.length, 2);
  assert.equal(controller.publishCalls.length, 2);
  assert.equal(controller.persistCalls[0].projectedState.projectionRevision, 1);
  assert.equal(controller.persistCalls[1].projectedState.projectionRevision, 2);
  assert.equal(controller.persistCalls[0].expectedRevisionToken, firstToken);
  assert.equal(controller.persistCalls[1].expectedRevisionToken, secondToken);
  assert.equal(
    controller.logs.some(({ event, data }) =>
      event === "game_studio_local_slash_durable_retry" &&
      data.reason === "revision_conflict"
    ),
    true,
  );
});

test("a recovery conclusion preserves canonical source and recovery Run identities", async () => {
  const sourceTurnId = "turn-original";
  const sourceRunId = "run-original";
  const recoveryTurnId = "local-slash-recovery-run-original";
  const recoveryRunId = "run-original-presentation-recovery";
  const recoverySummary = "Recovered the local slash conclusion.";
  const claim = createClaim({ turnId: sourceTurnId });
  const recoveryState = createCanonicalState({
    claim,
    turnId: recoveryTurnId,
    runId: recoveryRunId,
    parentRunId: sourceRunId,
    resultKind: "error",
    summary: recoverySummary,
  });
  recoveryState.runtimeEvents.unshift({
    schemaVersion: 2,
    type: "run.completed",
    threadId: SESSION_KEY,
    turnId: sourceTurnId,
    timestampMs: 9,
    runId: sourceRunId,
    parentRunId: null,
    resultKind: "error",
    summary: "Original local handler ended before presentation.",
  });
  const context = createContext({
    sourceTurnId,
    sourceRunId,
    conclusionOwner: {
      disposition: "recovery_completed",
      turnId: recoveryTurnId,
      runId: recoveryRunId,
      parentRunId: sourceRunId,
      resultKind: "error",
      summary: recoverySummary,
    },
  });
  const { controller, input } = createHarness({ state: recoveryState, claim, context });

  await commitGameStudioLocalSlashProjection(input);

  assert.equal(controller.persistCalls.length, 1);
  assert.equal(controller.publishCalls.length, 1);
  const projection = controller.persistCalls[0].projectedState;
  assert.equal(
    projection.runtimeEvents.some((event) =>
      event.type === "run.completed" &&
      event.turnId === sourceTurnId &&
      event.runId === sourceRunId
    ),
    true,
  );
  assert.equal(
    projection.runtimeEvents.some((event) =>
      event.type === "run.completed" &&
      event.turnId === recoveryTurnId &&
      event.runId === recoveryRunId &&
      event.parentRunId === sourceRunId
    ),
    true,
  );
  assert.equal(
    projection.runtimeEvents.some((event) =>
      event.type === "turn.completed" && event.turnId === sourceTurnId
    ),
    false,
  );
  assert.equal(projection.workspaceTurnQueue.entries[0].receipt.turnId, sourceTurnId);
  assert.equal(projection.workspaceTurnQueue.entries[0].status, "dispatching");
});

test("losing the Session owner during persistence rejects before publication", async () => {
  const storageError = new Error("storage lease was deleted");
  const { controller, input } = createHarness({
    persistProjection: async (_projectedState, _token, current) => {
      current.owned = false;
      throw storageError;
    },
  });

  await assert.rejects(
    commitGameStudioLocalSlashProjection(input),
    (error) => {
      assert.equal(error.message, "LOCAL_SLASH_DURABLE_OWNER_LOST");
      assert.equal(error.cause, storageError);
      return true;
    },
  );
  assert.equal(controller.persistCalls.length, 1);
  assert.equal(controller.publishCalls.length, 0);
  assert.deepEqual(controller.retryDelays, []);
});

test("a recording-disabled memory adapter can acknowledge persistence and publish immediately", async () => {
  const state = createCanonicalState({
    extra: { sessionRecordingEnabled: false, storageMode: "memory" },
  });
  const { controller, input } = createHarness({
    state,
    persistProjection: async (projectedState) => ({
      ...clone(projectedState),
      durability: "memory_acknowledged",
    }),
  });

  await commitGameStudioLocalSlashProjection(input);

  assert.deepEqual(controller.order, ["persist", "remember", "publish"]);
  assert.equal(controller.persistCalls.length, 1);
  assert.equal(controller.publishCalls.length, 1);
  assert.deepEqual(controller.retryDelays, []);
  assert.equal(controller.publishCalls[0].durableState.durability, "memory_acknowledged");
  assert.equal(controller.publishCalls[0].durableState.sessionRecordingEnabled, false);
});

test("temporary fallback preserves recording policy and becomes runtime-only after Session removal", () => {
  const session = {
    id: SESSION_ID,
    title: "Local slash",
    storageStatus: "ok",
    recordingDisabled: false,
  };
  const state = {
    taskFlow: [{ id: 1, type: "user", content: "/agent writer" }],
    sessionsByWorkspace: { [SCOPE_KEY]: [session] },
  };
  const projectionInput = {
    state,
    scopeKey: SCOPE_KEY,
    sessionId: SESSION_ID,
    sanitizeTaskBlocksForPersist: (blocks) => clone(blocks),
    buildRuntimeSnapshot: (projectedState) => ({
      taskCount: projectedState.taskFlow.length,
    }),
    nowMs: () => 123,
  };

  const temporary = buildTemporarySubmitRuntimeProjection(projectionInput);
  const temporarySession = temporary.sessionsByWorkspace[SCOPE_KEY][0];
  assert.notEqual(temporary, state);
  assert.equal(temporarySession.storageStatus, "temporary");
  assert.equal(
    temporarySession.recordingDisabled,
    false,
    "a transient storage failure must not become a permanent recording opt-out",
  );
  assert.deepEqual(temporarySession.runtimeSnapshot, { taskCount: 1 });
  assert.equal(session.storageStatus, "ok", "the source Session must remain immutable");

  const removedState = {
    ...state,
    sessionsByWorkspace: { [SCOPE_KEY]: [] },
  };
  const runtimeOnly = buildTemporarySubmitRuntimeProjection({
    ...projectionInput,
    state: removedState,
  });
  assert.equal(
    runtimeOnly,
    removedState,
    "a removed Session publishes only the captured runtime projection",
  );
});

test("permanent persistence failure exhausts three attempts and commits an explicit temporary memory projection", async () => {
  const state = createCanonicalState({
    extra: {
      config: { sessionRecordingEnabled: true },
      sessionsByWorkspace: {
        [SCOPE_KEY]: [{
          id: SESSION_ID,
          storageStatus: "ok",
          recordingDisabled: false,
        }],
      },
    },
  });
  const { controller, input } = createHarness({
    state,
    persistProjection: async () => {
      throw new Error("disk permanently unavailable");
    },
    buildMemoryFallbackProjection: (projectedState) => ({
      ...clone(projectedState),
      sessionsByWorkspace: {
        ...projectedState.sessionsByWorkspace,
        [SCOPE_KEY]: projectedState.sessionsByWorkspace[SCOPE_KEY].map((session) => ({
          ...session,
          storageStatus: "temporary",
        })),
      },
    }),
  });

  await commitGameStudioLocalSlashProjection(input);

  assert.equal(controller.persistCalls.length, 3);
  assert.deepEqual(controller.retryDelays, [100, 200]);
  assert.equal(controller.publishCalls.length, 1);
  const fallback = controller.publishCalls[0].durableState;
  assert.equal(fallback.sessionsByWorkspace[SCOPE_KEY][0].storageStatus, "temporary");
  assert.equal(fallback.sessionsByWorkspace[SCOPE_KEY][0].recordingDisabled, false);
  assert.equal(fallback.workspaceTurnQueue.entries[0].status, "dispatching");
  assert.equal(
    fallback.runtimeEvents.some((event) =>
      event.type === "run.completed" && event.runId === RUN_ID && event.resultKind === "success"
    ),
    true,
  );
  assert.equal(
    controller.logs.some(({ event, data }) =>
      event === "game_studio_local_slash_memory_fallback_committed" &&
      data.reason === "persistence_retry_exhausted" &&
      data.durability === "memory_only_after_retry_exhaustion" &&
      data.storageStatus === "temporary"
    ),
    true,
  );
});

test("a late abort interrupts retry backoff and memory-closes the existing success without another persistence attempt", async () => {
  const abortController = new AbortController();
  const waitStarted = deferred();
  const { controller, input } = createHarness({
    abortSignal: abortController.signal,
    persistProjection: async () => {
      throw new Error("database_busy");
    },
    waitForRetry: (_delayMs, _current, signal) => {
      waitStarted.resolve();
      return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
    buildMemoryFallbackProjection: (projectedState) => ({
      ...clone(projectedState),
      durability: "temporary_memory",
    }),
  });

  const completion = commitGameStudioLocalSlashProjection(input);
  await waitStarted.promise;
  abortController.abort();
  await completion;

  assert.equal(controller.persistCalls.length, 1);
  assert.deepEqual(controller.retryDelays, [100]);
  assert.equal(controller.publishCalls.length, 1);
  assert.equal(controller.publishCalls[0].durableState.durability, "temporary_memory");
  assert.equal(
    controller.publishCalls[0].projectedState.conversationTurns[0].runtimeOutcome.resultKind,
    "success",
  );
  assert.equal(
    controller.publishCalls[0].projectedState.runtimeEvents.some((event) =>
      event.type === "run.completed" && event.resultKind === "canceled"
    ),
    false,
  );
  assert.equal(
    controller.logs.some(({ event, data }) =>
      event === "game_studio_local_slash_memory_fallback_committed" &&
      data.reason === "abort_interrupted_durable_retry"
    ),
    true,
  );
});

test("a never-resolving persistence adapter times out within the bounded budget and cannot hold completion forever", async () => {
  const { controller, input } = createHarness({
    persistenceAttemptTimeoutMs: 5,
    persistProjection: () => new Promise(() => {}),
    buildMemoryFallbackProjection: (projectedState) => ({
      ...clone(projectedState),
      durability: "temporary_memory_after_timeout",
    }),
  });

  await commitGameStudioLocalSlashProjection(input);

  assert.equal(controller.persistCalls.length, 3);
  assert.deepEqual(controller.retryDelays, [100, 200]);
  assert.equal(controller.publishCalls.length, 1);
  assert.equal(
    controller.publishCalls[0].durableState.durability,
    "temporary_memory_after_timeout",
  );
  assert.equal(
    controller.logs.filter(({ event }) =>
      event === "game_studio_local_slash_persist_unavailable"
    ).length,
    3,
  );
});

test("an abort also interrupts a never-resolving persistence attempt before its timeout", async () => {
  const abortController = new AbortController();
  const persistStarted = deferred();
  const { controller, input } = createHarness({
    abortSignal: abortController.signal,
    persistenceAttemptTimeoutMs: 30_000,
    persistProjection: () => {
      persistStarted.resolve();
      return new Promise(() => {});
    },
    buildMemoryFallbackProjection: (projectedState) => ({
      ...clone(projectedState),
      durability: "temporary_memory_after_abort",
    }),
  });

  const completion = commitGameStudioLocalSlashProjection(input);
  await persistStarted.promise;
  abortController.abort();
  await completion;

  assert.equal(controller.persistCalls.length, 1);
  assert.deepEqual(controller.retryDelays, []);
  assert.equal(controller.publishCalls.length, 1);
  assert.equal(
    controller.publishCalls[0].durableState.durability,
    "temporary_memory_after_abort",
  );
  assert.equal(
    controller.logs.some(({ event, data }) =>
      event === "game_studio_local_slash_memory_fallback_committed" &&
      data.reason === "abort_interrupted_persistence"
    ),
    true,
  );
});
