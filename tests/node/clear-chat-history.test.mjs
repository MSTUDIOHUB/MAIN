import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const moduleCache = new Map();
let tauriInvoke = async () => "";

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8").replace(
    /import\.meta\.glob\([\s\S]*?\)\s+as Record<string, string>/g,
    "({}) as Record<string, string>",
  );
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
        listen: async () => () => {},
        isTauri: () => false,
        open: async () => null,
        openUrl: async () => null,
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
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, label, timeoutMs = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs)),
  ]);
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function readSource(relativePath) {
  return fsSync.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("clearChatHistory revokes workspace owners before durable clear and only then clears local state", () => {
  const source = readSource("src/store/useAppStore.ts");
  const start = source.indexOf("clearChatHistory: () => {");
  const end = source.indexOf("\n\n  resetAllSettings:", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);

  const revokeIndex = body.indexOf("revokeWorkspaceSessionRuntimesBeforeClear({");
  const durableClearIndex = body.indexOf("await clearProjectSessions(workspaceKey, Array.from(sessionIds))");
  const localClearIndex = body.indexOf("set((s) => {");
  assert.ok(revokeIndex >= 0);
  assert.ok(durableClearIndex > revokeIndex);
  assert.ok(localClearIndex > durableClearIndex);
  assert.match(body, /pendingRunDecisionResolver: null/);
  assert.match(body, /pendingReviewResolve: null/);
  assert.match(body, /activeActionRequest: null/);
  assert.match(body, /activeGoal: null/);
  assert.match(body, /harnessRunMarker: null/);
  assert.match(body, /abortController: null/);
  const clearedOutcomeIndex = body.indexOf('workspaceClearBarrierOutcome = "cleared"');
  const successPublicationIndex = body.indexOf("set((s) => {", clearedOutcomeIndex);
  const replayReadyIndex = body.indexOf("workspaceClearReplayPublicationReady = true", successPublicationIndex);
  assert.ok(clearedOutcomeIndex >= 0);
  assert.ok(successPublicationIndex > clearedOutcomeIndex);
  assert.ok(replayReadyIndex > successPublicationIndex);
  assert.match(body, /workspaceClearReplayPublicationReady\s*&&[\s\S]*markWorkspaceClearSubmissionReplayReady/);
});

test("Settings delegates history clearing to the owner-aware store transaction", () => {
  const source = readSource("src/components/SettingsModal.tsx");
  assert.doesNotMatch(source, /import\s*\{[^}]*clearProjectSessions[^}]*\}\s*from\s*["']\.\.\/lib\/ipc["']/s);
  assert.match(source, /await clearChatHistory\(\)/);
  assert.match(source, /setClearHistoryError\(copy\.clearHistoryFailed\)/);
});

test("IPC bulk clear is routed through the workspace mutation coordinator", () => {
  const source = readSource("src/lib/ipc.ts");
  const start = source.indexOf("export function clearProjectSessions(");
  const end = source.indexOf("\n}\n\nexport function exportTextFile", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  assert.match(body, /projectSessionMutations\.clear\(workspace, ownerKeys/);
  assert.match(body, /invoke<void>\("clear_project_sessions"/);
});

test("workspace clear barrier is latest-wins, owner-aware, and monotonic across nested clears", () => {
  const barrier = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/workspaceClearSubmissionBarrier.ts"),
  );
  const workspace = "/workspace-clear-barrier-policy";
  const sessionKey = `${workspace}:801`;
  const discarded = [];
  const replayed = [];
  const first = barrier.beginWorkspaceClearSubmissionBarrier(workspace);
  const nested = barrier.beginWorkspaceClearSubmissionBarrier(workspace);
  assert.deepEqual(barrier.deferSubmissionForWorkspaceClear({
    currentWorkspaceKey: workspace,
    submissionOriginSessionKey: sessionKey,
    submission: {
      id: "submission-first",
      targetSessionKey: sessionKey,
      createdAt: 1,
      replay: (outcome) => { replayed.push(["first", outcome]); return true; },
      onDiscard: (reason) => discarded.push(["first", reason]),
    },
  }), {
    deferred: true,
    workspaceKey: workspace,
    disposition: "queued",
    replacedSubmissionId: null,
  });
  assert.deepEqual(barrier.deferSubmissionForWorkspaceClear({
    currentWorkspaceKey: "/another-workspace",
    submissionOriginSessionKey: sessionKey,
    submission: {
      id: "submission-latest",
      targetSessionKey: sessionKey,
      createdAt: 2,
      replay: (outcome) => { replayed.push(["latest", outcome]); return true; },
    },
  }), {
    deferred: true,
    workspaceKey: workspace,
    disposition: "replaced",
    replacedSubmissionId: "submission-first",
  });
  assert.deepEqual(discarded, [["first", "replaced"]]);
  assert.deepEqual(barrier.settleWorkspaceClearSubmissionBarrier({
    token: first,
    outcome: "cleared",
  }), { settled: false, pendingReplay: true });
  assert.deepEqual(barrier.settleWorkspaceClearSubmissionBarrier({
    token: nested,
    outcome: "preserved",
  }), { settled: true, pendingReplay: true });
  assert.equal(barrier.peekSettledWorkspaceClearSubmission(workspace).outcome, "cleared");
  const pending = barrier.takeSettledWorkspaceClearSubmission({
    workspaceKey: workspace,
    activeSessionKey: null,
  });
  assert.equal(pending.id, "submission-latest");
  assert.equal(pending.replay(pending.outcome), true);
  assert.deepEqual(replayed, [["latest", "cleared"]]);
  assert.equal(barrier.peekSettledWorkspaceClearSubmission(workspace), null);
});

test("preserved workspace submissions wait for their exact Session reactivation", () => {
  const barrier = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/workspaceClearSubmissionBarrier.ts"),
  );
  const workspace = "/workspace-clear-barrier-reactivation";
  const sessionKey = `${workspace}:802`;
  const token = barrier.beginWorkspaceClearSubmissionBarrier(workspace);
  barrier.deferSubmissionForWorkspaceClear({
    currentWorkspaceKey: workspace,
    submissionOriginSessionKey: sessionKey,
    submission: {
      id: "submission-reactivate",
      targetSessionKey: sessionKey,
      createdAt: 3,
      replay: () => true,
    },
  });
  barrier.settleWorkspaceClearSubmissionBarrier({ token, outcome: "preserved" });
  assert.equal(barrier.takeSettledWorkspaceClearSubmission({
    workspaceKey: workspace,
    activeSessionKey: `${workspace}:999`,
  }), null);
  assert.equal(barrier.peekSettledWorkspaceClearSubmission(workspace).id, "submission-reactivate");
  assert.equal(barrier.takeSettledWorkspaceClearSubmission({
    workspaceKey: workspace,
    activeSessionKey: sessionKey,
  }).id, "submission-reactivate");
});

test("workspace removal invalidates an active clear generation and its pending input", () => {
  const barrier = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/workspaceClearSubmissionBarrier.ts"),
  );
  const workspace = "/workspace-clear-barrier-active-remove";
  const discarded = [];
  const token = barrier.beginWorkspaceClearSubmissionBarrier(workspace);
  barrier.deferSubmissionForWorkspaceClear({
    currentWorkspaceKey: workspace,
    submission: {
      id: "submission-active-remove",
      targetSessionKey: null,
      createdAt: 4,
      replay: () => true,
      onDiscard: (reason) => discarded.push(reason),
    },
  });

  assert.equal(barrier.discardWorkspaceClearSubmissionState(workspace, "workspace_removed"), true);
  assert.equal(barrier.isWorkspaceClearSubmissionBarrierActive(workspace), false);
  assert.deepEqual(discarded, ["workspace_removed"]);
  assert.deepEqual(barrier.settleWorkspaceClearSubmissionBarrier({
    token,
    outcome: "cleared",
  }), { settled: false, pendingReplay: false });
  assert.deepEqual(barrier.deferSubmissionForWorkspaceClear({
    currentWorkspaceKey: workspace,
    submission: {
      id: "submission-after-remove",
      targetSessionKey: null,
      createdAt: 5,
      replay: () => true,
    },
  }), { deferred: false });
});

test("settings reset invalidates every active and settled workspace clear state", () => {
  const barrier = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/workspaceClearSubmissionBarrier.ts"),
  );
  const activeWorkspace = "/workspace-clear-reset-active";
  const settledWorkspace = "/workspace-clear-reset-settled";
  const emptyActiveWorkspace = "/workspace-clear-reset-empty-active";
  const discarded = [];
  const activeToken = barrier.beginWorkspaceClearSubmissionBarrier(activeWorkspace);
  const settledToken = barrier.beginWorkspaceClearSubmissionBarrier(settledWorkspace);
  const emptyToken = barrier.beginWorkspaceClearSubmissionBarrier(emptyActiveWorkspace);
  for (const [workspace, id] of [
    [activeWorkspace, "active-reset-submission"],
    [settledWorkspace, "settled-reset-submission"],
  ]) {
    barrier.deferSubmissionForWorkspaceClear({
      currentWorkspaceKey: workspace,
      submission: {
        id,
        targetSessionKey: null,
        createdAt: 6,
        replay: () => true,
        onDiscard: (reason) => discarded.push([id, reason]),
      },
    });
  }
  barrier.settleWorkspaceClearSubmissionBarrier({
    token: settledToken,
    outcome: "preserved",
  });

  assert.equal(barrier.discardAllWorkspaceClearSubmissionStateForSettingsReset(), 3);
  assert.deepEqual(discarded.sort(), [
    ["active-reset-submission", "settings_reset"],
    ["settled-reset-submission", "settings_reset"],
  ]);
  for (const token of [activeToken, emptyToken]) {
    assert.deepEqual(barrier.settleWorkspaceClearSubmissionBarrier({
      token,
      outcome: "cleared",
    }), { settled: false, pendingReplay: false });
  }
  assert.equal(barrier.isWorkspaceClearSubmissionBarrierActive(activeWorkspace), false);
  assert.equal(barrier.peekSettledWorkspaceClearSubmission(settledWorkspace), null);
});

test("Feishu enters the workspace clear fence before preparing a remote Session", () => {
  const source = readSource("src/App.tsx");
  const start = source.indexOf("const runFeishuRemoteMessage = useCallback");
  const end = source.indexOf("const handleFeishuCardAction", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  assert.ok(body.indexOf("deferSubmissionForWorkspaceClear({") >= 0);
  assert.ok(body.indexOf("deferSubmissionForWorkspaceClear({") < body.indexOf("ensureFeishuRemoteSession(message)"));
});

function executionTurn(id) {
  return {
    id,
    userPrompt: "执行工作区任务",
    title: "执行工作区任务",
    mode: "edit",
    intent: "execute",
    status: "executing",
    summary: "",
    blockIds: [],
    collapsed: false,
    createdAt: 1,
  };
}

function seedWorkspaceSession(useAppStore, workspace, sessionId, turnId) {
  useAppStore.setState({
    currentWorkspace: workspace,
    selectedWorkspace: workspace,
    currentSessionId: sessionId,
    sessionsByWorkspace: {
      [workspace]: [{
        id: sessionId,
        title: "Bootstrap Session",
        date: "Today",
        active: true,
        messages: [],
      }],
    },
    activeSessionByWorkspace: { [workspace]: sessionId },
    runtimeBySessionKey: {},
    conversationTurns: [executionTurn(turnId)],
    currentTurnId: turnId,
    taskFlow: [],
    runtimeEvents: [],
    harnessRunMarker: null,
    activeActionRequest: null,
    pendingRunDecision: null,
    pendingRunDecisionResolver: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    activeGoal: null,
    goalProgress: null,
    goalStatus: "paused",
    goalRuntime: null,
    agentStatus: "running",
    isGenerating: true,
    abortController: null,
  });
}

function createRealRuntimeOwnerController(useAppStore, runSessionKey) {
  const { createSubmitSessionRuntimeController } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/submitSessionRuntimeController.ts"),
  );
  return createSubmitSessionRuntimeController({
    get: useAppStore.getState,
    set: useAppStore.setState,
    runSessionKey,
    createRuntimeFromState: (state) => ({ ...state }),
    pickRuntimePatch: (source) => ({ ...source }),
    derivePlanStageFromArtifacts: (_artifacts, _tasks, _approved, stage) => stage,
    createDefaultCurrentTurnState: () => ({}),
    logStoreEvent: () => {},
  });
}

function startDeferredRealBootstrap(controller, input) {
  const { runSubmitAsyncWorkflowRun } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/submitAsyncWorkflowRun.ts"),
  );
  let now = 100;
  return runSubmitAsyncWorkflowRun({
    text: "执行工作区任务",
    turnId: input.turnId,
    uiDisplayTurnId: input.turnId,
    currentImages: [],
    mentionSnapshot: [],
    attachedFilesSnapshot: [],
    runSessionKey: input.sessionKey,
    runWorkspace: input.workspace,
    runSessionId: input.sessionId,
    runScopeKey: input.workspace,
    currentMainModeKey: "main_mode",
    parsedSetupEngineCommand: null,
    parsedStudioCommand: null,
    cachedWorkspaceTreeForGameDetection: "",
    preferredLanguage: "zh",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    goalCreationAuthorization: null,
    goalContinuationAuthorization: null,
    activateGoalContinuation: () => true,
    effectiveWorkflowMode: "edit",
    effectiveCommandDirective: { kind: "file_modify", source: "natural_language" },
    effectiveIntentSummary: "执行工作区任务",
    preservePlanState: false,
    shouldContinuePlanIntent: false,
    shouldContinuePreviousTurnIntent: false,
    shouldExecuteOnceFromReplyOption: false,
    currentTurn: null,
    previousTurnContinuationTarget: null,
    existingTurn: null,
    selectedChoiceText: "",
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
    },
    remoteFeishu: undefined,
    options: { executionConsentGranted: true },
    isHidden: false,
    createVisibleTurnForHiddenMessage: false,
    nextTaskId: (() => {
      let id = 20;
      return () => ++id;
    })(),
    sessionGet: controller.sessionGet,
    sessionSet: controller.sessionSet,
    getSessionRuntimeOwnerToken: controller.getSessionRuntimeOwnerToken,
    hasSessionRuntimeOwnership: controller.hasSessionRuntimeOwnership,
    getSessionRevisionToken: controller.getSessionRevisionToken,
    publishOwnerScopedRuntimeProjection: controller.publishOwnerScopedRuntimeProjection,
    elapsedTimer: {
      timerInterval: 1,
      getElapsedSeconds: () => 0,
      dispose: () => {},
    },
    markUserContextItemFailed: () => {},
    ingestAttachmentFile: async () => { throw new Error("unexpected attachment ingest"); },
    readFile: async () => "",
    readDocument: async () => ({ content: "" }),
    analyzeTabularDocument: async () => ({ content: "" }),
    runtimeService: {},
    logWarning: () => {},
    invalidateWorkspaceTreeCache: () => {},
    createAbortController: () => {
      input.capabilityStarts.abortController += 1;
      return new AbortController();
    },
    getCurrentHarnessInstanceId: () => "instance-clear-test",
    readHarnessRunMarker: () => null,
    acquireHarnessRunMarker: (marker) => {
      input.capabilityStarts.harness += 1;
      return marker;
    },
    persistHarnessRunMarkerIfOwned: () => null,
    getWorkspaceTree: async () => {
      input.workspaceTreeStarted.resolve();
      return input.workspaceTree.promise;
    },
    nowMs: () => ++now,
    sendStartedAt: 100,
    getLastTurnToolSummary: () => "",
    getLastVisibleTurnAgentSummary: () => "",
    persistBootstrapProjection: async (state) => state,
    PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: 12,
    PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: 1000,
    PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: 3,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    sanitizeAgentMessagesForPersist: (messages) => messages,
    normalizeSessionRuntimeSnapshot: (snapshot) => snapshot,
    normalizeProviderCompatibilityByRuntimeKey: (value) => value || {},
    compactCompletedTurnAgentMessages: ({ agentMessages }) => agentMessages,
    normalizeQueuedUserMessage: (value) => value || null,
    startApprovedPlanExecutionInCurrentTurn: () => false,
    logStoreEvent: () => {},
    phaseRunners: {
      buildAttachmentContext: async () => ({
        userContent: "执行工作区任务",
        attachmentRefs: [],
        failedAttachmentCount: 0,
      }),
      buildPromptContext: ({ userContent }) => ({ userContent }),
      runGameStudioPreparation: async ({ userContent }) => ({
        ok: true,
        userContent,
        activeStudioAgentKey: "studio_auto",
        gameStudioInitialized: false,
        gameStudioConfigForTurn: null,
      }),
      createWorkflowContext: (context) => context,
      startStreamingUi: () => {},
      runWorkflowEngine: async () => {
        input.capabilityStarts.engine += 1;
        input.capabilityStarts.tools += 1;
        return true;
      },
    },
  });
}

test("real clearChatHistory revokes a deferred bootstrap generation before durable clear resolves", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-pending";
  const sessionId = 701;
  const turnId = "turn-clear-pending";
  const sessionKey = `${workspace}:${sessionId}`;
  seedWorkspaceSession(useAppStore, workspace, sessionId, turnId);
  const controller = createRealRuntimeOwnerController(useAppStore, sessionKey);
  const ownerToken = controller.getSessionRuntimeOwnerToken();
  assert.equal(controller.hasSessionRuntimeOwnership(ownerToken), true);

  const durableClear = deferred();
  const workspaceTree = deferred();
  const workspaceTreeStarted = deferred();
  let clearInvocations = 0;
  tauriInvoke = (command) => {
    if (command === "clear_project_sessions") {
      clearInvocations += 1;
      return durableClear.promise;
    }
    return Promise.resolve("");
  };
  const capabilityStarts = {
    harness: 0,
    abortController: 0,
    engine: 0,
    tools: 0,
  };
  const bootstrap = startDeferredRealBootstrap(controller, {
    workspace,
    sessionId,
    sessionKey,
    turnId,
    workspaceTree,
    workspaceTreeStarted,
    capabilityStarts,
  });
  await workspaceTreeStarted.promise;

  const clear = useAppStore.getState().clearChatHistory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearInvocations, 1);
  assert.equal(
    useAppStore.getState().runtimeBySessionKey[sessionKey],
    undefined,
    `runtime keys: ${Object.keys(useAppStore.getState().runtimeBySessionKey).join(",")}`,
  );
  assert.equal(controller.hasSessionRuntimeOwnership(ownerToken), false);
  assert.equal(useAppStore.getState().sessionsByWorkspace[workspace].length, 1);

  workspaceTree.resolve("[D] src");
  await bootstrap;
  assert.deepEqual(capabilityStarts, {
    harness: 0,
    abortController: 0,
    engine: 0,
    tools: 0,
  });

  durableClear.resolve();
  await clear;
  assert.equal(useAppStore.getState().sessionsByWorkspace[workspace], undefined);
});

test("concurrent real workspace clears coalesce into one durable transaction", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-concurrent-coalesced";
  const sessionId = 709;
  seedWorkspaceSession(
    useAppStore,
    workspace,
    sessionId,
    "turn-clear-concurrent-coalesced",
  );
  const durableClear = deferred();
  let clearInvocations = 0;
  tauriInvoke = (command) => {
    if (command === "clear_project_sessions") {
      clearInvocations += 1;
      return durableClear.promise;
    }
    return Promise.resolve("");
  };

  const first = useAppStore.getState().clearChatHistory();
  const second = useAppStore.getState().clearChatHistory();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearInvocations, 1);

  durableClear.resolve();
  await Promise.all([first, second]);
  assert.equal(clearInvocations, 1);
  assert.equal(useAppStore.getState().sessionsByWorkspace[workspace], undefined);
  assert.equal(useAppStore.getState().currentSessionId, null);
  assert.equal(useAppStore.getState().conversationTurns.length, 0);
});

test("failed in-flight clear cannot republish Session state after settings reset", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-invalidated-reset";
  seedWorkspaceSession(
    useAppStore,
    workspace,
    710,
    "turn-clear-invalidated-reset",
  );
  const durableClear = deferred();
  let terminalSaveInvocations = 0;
  let clearInvocations = 0;
  tauriInvoke = (command) => {
    if (command === "clear_project_sessions") {
      clearInvocations += 1;
      return clearInvocations === 1 ? durableClear.promise : Promise.resolve();
    }
    if (command === "save_project_session") terminalSaveInvocations += 1;
    return Promise.resolve("");
  };

  const clear = useAppStore.getState().clearChatHistory();
  const rejected = assert.rejects(clear, /clear failed after reset/);
  await new Promise((resolve) => setImmediate(resolve));
  useAppStore.getState().resetAllSettings();
  const replacementClear = useAppStore.getState().clearChatHistory();
  assert.notEqual(replacementClear, clear);
  const replacementRejected = assert.rejects(
    replacementClear,
    /clear failed after reset/,
  );
  durableClear.reject(new Error("clear failed after reset"));
  await rejected;
  await replacementRejected;
  await new Promise((resolve) => setImmediate(resolve));
  const afterFailure = useAppStore.getState();
  assert.deepEqual(afterFailure.sessionsByWorkspace[workspace] || [], []);
  assert.equal(
    Object.keys(afterFailure.runtimeBySessionKey)
      .some((sessionKey) => sessionKey.startsWith(`${workspace}:`)),
    false,
  );
  assert.equal(afterFailure.currentSessionId, null);
  assert.deepEqual(afterFailure.taskFlow, []);
  assert.deepEqual(afterFailure.conversationTurns, []);
  assert.equal(terminalSaveInvocations, 0);
  assert.equal(clearInvocations, 1);
});

test("failed in-flight clear cannot restore an old runtime after workspace removal", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-invalidated-remove";
  seedWorkspaceSession(
    useAppStore,
    workspace,
    711,
    "turn-clear-invalidated-remove",
  );
  useAppStore.setState({
    workspaces: [{
      path: workspace,
      name: "Removed workspace",
      addedAt: 1,
      lastActiveAt: 1,
    }],
  });
  const durableClear = deferred();
  let terminalSaveInvocations = 0;
  tauriInvoke = (command) => {
    if (command === "clear_project_sessions") return durableClear.promise;
    if (command === "save_project_session") terminalSaveInvocations += 1;
    return Promise.resolve("");
  };

  const clear = useAppStore.getState().clearChatHistory();
  const rejected = assert.rejects(clear, /clear failed after removal/);
  await new Promise((resolve) => setImmediate(resolve));
  useAppStore.getState().removeWorkspaceEntry(workspace);
  const removedState = useAppStore.getState();
  const removedProjection = {
    sessionsByWorkspace: removedState.sessionsByWorkspace,
    activeSessionByWorkspace: removedState.activeSessionByWorkspace,
    runtimeBySessionKey: removedState.runtimeBySessionKey,
    currentSessionId: removedState.currentSessionId,
    taskFlow: removedState.taskFlow,
    conversationTurns: removedState.conversationTurns,
  };

  durableClear.reject(new Error("clear failed after removal"));
  await rejected;
  await new Promise((resolve) => setImmediate(resolve));
  const afterFailure = useAppStore.getState();
  assert.deepEqual({
    sessionsByWorkspace: afterFailure.sessionsByWorkspace,
    activeSessionByWorkspace: afterFailure.activeSessionByWorkspace,
    runtimeBySessionKey: afterFailure.runtimeBySessionKey,
    currentSessionId: afterFailure.currentSessionId,
    taskFlow: afterFailure.taskFlow,
    conversationTurns: afterFailure.conversationTurns,
  }, removedProjection);
  assert.equal(terminalSaveInvocations, 0);
});

test("successful deferred clear replays only the latest visible user input into one fresh Session", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-submit-success";
  const otherWorkspace = "/workspace-clear-submit-success-other";
  const sessionId = 706;
  const oldTurnId = "turn-clear-submit-success-old";
  seedWorkspaceSession(useAppStore, workspace, sessionId, oldTurnId);
  useAppStore.setState((state) => ({
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    config: {
      ...state.config,
      local: { ...state.config.local, model: "" },
    },
  }));

  const durableClear = deferred();
  const workspaceTree = deferred();
  const workspaceTreeStarted = deferred();
  const commands = [];
  let clearInvocations = 0;
  let workspaceTreeInvocations = 0;
  tauriInvoke = (command, payload) => {
    commands.push(command);
    if (command === "clear_project_sessions") {
      clearInvocations += 1;
      return clearInvocations === 1 ? durableClear.promise : Promise.resolve();
    }
    if (command === "get_project_skeleton") {
      workspaceTreeInvocations += 1;
      workspaceTreeStarted.resolve();
      return workspaceTree.promise;
    }
    if (command === "set_workspace_root") return Promise.resolve(payload.path);
    if (command === "save_project_session") return Promise.resolve(payload.session);
    return Promise.resolve("");
  };

  const clear = useAppStore.getState().clearChatHistory();
  await new Promise((resolve) => setImmediate(resolve));
  const realSendMessage = useAppStore.getState().sendMessage;
  const oldSessionKey = `${workspace}:${sessionId}`;
  assert.equal(realSendMessage("/分析 第一条应被替换的输入"), true);
  const latestText = "/分析 最新用户输入必须只重放一次";
  const staleVisibleGoalEnvelope = {
    kind: "visible_goal_submission_envelope",
    id: "old-visible-goal-envelope",
  };
  const staleGoalContinuationEnvelope = {
    kind: "goal_continuation_envelope",
    id: "old-goal-continuation-envelope",
  };
  assert.equal(realSendMessage(latestText, undefined, {
    resolvedIntent: "execute",
    runtimeIntentOverride: "goal",
    commandDirective: {
      kind: "file_modify",
      source: "natural_language",
      requiresWorkspace: true,
      requiresApproval: true,
      confidence: 1,
    },
    executionConsentGranted: true,
    skipIntentResolution: true,
    goalSourceContextSnapshot: "old goal context",
    visibleGoalSubmissionEnvelope: staleVisibleGoalEnvelope,
    goalContinuationEnvelope: staleGoalContinuationEnvelope,
    continueExistingGoal: true,
  }), true);
  assert.equal(realSendMessage("hidden stale continuation", undefined, {
    hidden: true,
    reuseCurrentTurn: true,
    turnIdOverride: oldTurnId,
    runIdOverride: "old-run",
    submissionOriginSessionKey: oldSessionKey,
  }), true);
  const pendingState = useAppStore.getState();
  assert.equal(pendingState.currentSessionId, null);
  assert.equal(pendingState.sessionsByWorkspace[workspace].length, 1);
  assert.equal(Object.keys(pendingState.runtimeBySessionKey).filter((key) => key.startsWith(`${workspace}:`)).length, 0);
  assert.equal(pendingState.abortController, null);
  assert.equal(pendingState.harnessRunMarker, null);
  assert.equal(workspaceTreeInvocations, 0);
  assert.deepEqual(commands.filter((command) => command === "get_project_skeleton"), []);

  const replayCalls = [];
  useAppStore.setState({
    sendMessage: (...args) => {
      replayCalls.push(args);
      return realSendMessage(...args);
    },
  });
  useAppStore.getState().setCurrentWorkspace(otherWorkspace);
  await new Promise((resolve) => setImmediate(resolve));
  durableClear.resolve();
  await clear;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replayCalls.length, 0);

  useAppStore.getState().setCurrentWorkspace(workspace);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replayCalls.length, 0);
  // App publishes readiness only after its empty-workspace restore has removed
  // the previously visible workspace transcript.
  useAppStore.setState({
    taskFlow: [],
    agentMessages: [],
    conversationTurns: [],
    currentTurnId: null,
    activeGoal: null,
    goalProgress: null,
    goalStatus: "paused",
    goalRuntime: null,
  });
  assert.equal(
    useAppStore.getState().markWorkspaceClearSubmissionReplayReady(workspace, null),
    true,
  );
  await withTimeout(workspaceTreeStarted.promise, "success clear replay workspace tree");
  assert.equal(replayCalls.length, 1);
  assert.equal(replayCalls[0][0], latestText);
  const replayOptions = replayCalls[0][2];
  for (const staleKey of [
    "resolvedIntent",
    "runtimeIntentOverride",
    "commandDirective",
    "executionConsentGranted",
    "skipIntentResolution",
    "goalSourceContextSnapshot",
    "visibleGoalSubmissionEnvelope",
    "goalContinuationEnvelope",
    "continueExistingGoal",
    "submissionOriginSessionKey",
  ]) {
    assert.equal(Object.hasOwn(replayOptions, staleKey), false, `stale replay key ${staleKey}`);
  }
  const replayedState = useAppStore.getState();
  assert.equal(replayedState.sessionsByWorkspace[workspace].length, 1);
  assert.notEqual(replayedState.currentSessionId, sessionId);
  assert.equal(replayedState.conversationTurns.length, 1);
  assert.match(replayedState.conversationTurns[0].userPrompt, /最新用户输入/);
  assert.equal(replayedState.taskFlow.filter((block) => block.type === "user").length, 1);
  assert.equal(replayedState.abortController, null);
  assert.equal(replayedState.harnessRunMarker, null);
  assert.equal(workspaceTreeInvocations, 1);

  useAppStore.setState({ sendMessage: realSendMessage });
  await useAppStore.getState().clearChatHistory();
  workspaceTree.resolve("");
  await new Promise((resolve) => setImmediate(resolve));
});

test("failed deferred clear replays a fresh Turn only after exact workspace and Session reactivation", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-submit-failure";
  const otherWorkspace = "/workspace-clear-submit-failure-other";
  const sessionId = 707;
  const oldTurnId = "turn-clear-submit-failure-old";
  const oldSessionKey = `${workspace}:${sessionId}`;
  seedWorkspaceSession(useAppStore, workspace, sessionId, oldTurnId);
  useAppStore.setState((state) => ({
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    config: {
      ...state.config,
      local: { ...state.config.local, model: "" },
    },
  }));

  const durableClear = deferred();
  const workspaceTree = deferred();
  const workspaceTreeStarted = deferred();
  let clearInvocations = 0;
  let workspaceTreeInvocations = 0;
  tauriInvoke = (command, payload) => {
    if (command === "clear_project_sessions") {
      clearInvocations += 1;
      return clearInvocations === 1 ? durableClear.promise : Promise.resolve();
    }
    if (command === "get_project_skeleton") {
      workspaceTreeInvocations += 1;
      workspaceTreeStarted.resolve();
      return workspaceTree.promise;
    }
    if (command === "set_workspace_root") return Promise.resolve(payload.path);
    if (command === "save_project_session") return Promise.resolve(payload.session);
    return Promise.resolve("");
  };

  const clear = useAppStore.getState().clearChatHistory();
  const clearRejected = assert.rejects(clear, /preserve workspace clear failed/);
  await new Promise((resolve) => setImmediate(resolve));
  const realSendMessage = useAppStore.getState().sendMessage;
  const latestText = "/分析 清理失败后作为全新回合重放";
  assert.equal(realSendMessage(latestText, undefined, {
    submissionOriginSessionKey: oldSessionKey,
  }), true);
  assert.equal(realSendMessage("stale queued replay", undefined, {
    hidden: true,
    reuseCurrentTurn: true,
    turnIdOverride: oldTurnId,
    queuedUserMessageId: "stale-queue-id",
    submissionOriginSessionKey: oldSessionKey,
  }), true);
  assert.equal(useAppStore.getState().currentSessionId, null);
  assert.equal(workspaceTreeInvocations, 0);

  const replayCalls = [];
  useAppStore.setState({
    sendMessage: (...args) => {
      replayCalls.push(args);
      return realSendMessage(...args);
    },
  });
  useAppStore.getState().setCurrentWorkspace(otherWorkspace);
  await new Promise((resolve) => setImmediate(resolve));
  durableClear.reject(new Error("preserve workspace clear failed"));
  await clearRejected;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replayCalls.length, 0);

  useAppStore.getState().setCurrentWorkspace(workspace);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replayCalls.length, 0);
  useAppStore.getState().setCurrentSessionId(sessionId);
  assert.equal(useAppStore.getState().restoreRuntimeForSession(oldSessionKey, {
    resetPanels: true,
  }), true);
  assert.equal(
    useAppStore.getState().markWorkspaceClearSubmissionReplayReady(workspace, sessionId),
    true,
  );
  await withTimeout(workspaceTreeStarted.promise, "failed clear replay workspace tree");
  assert.equal(replayCalls.length, 1);
  assert.equal(replayCalls[0][0], latestText);
  assert.equal(replayCalls[0][2].submissionOriginSessionKey, oldSessionKey);
  assert.equal(Object.hasOwn(replayCalls[0][2], "goalContinuationEnvelope"), false);
  for (const staleKey of [
    "hidden",
    "reuseCurrentTurn",
    "turnIdOverride",
    "runIdOverride",
    "parentRunIdOverride",
    "executionConsentGranted",
  ]) {
    assert.equal(Object.hasOwn(replayCalls[0][2], staleKey), false, `stale replay key ${staleKey}`);
  }
  const replayedState = useAppStore.getState();
  const oldTurn = replayedState.conversationTurns.find((turn) => turn.id === oldTurnId);
  assert.equal(oldTurn.status, "done");
  assert.equal(oldTurn.runtimeOutcome.status, "aborted");
  assert.equal(replayedState.conversationTurns.length, 2);
  assert.notEqual(replayedState.currentTurnId, oldTurnId);
  assert.match(
    replayedState.conversationTurns.find((turn) => turn.id !== oldTurnId).userPrompt,
    /清理失败后作为全新回合重放/,
  );
  assert.equal(workspaceTreeInvocations, 1);

  useAppStore.setState({ sendMessage: realSendMessage });
  await useAppStore.getState().clearChatHistory();
  workspaceTree.resolve("");
  await new Promise((resolve) => setImmediate(resolve));
});

test("failed clear revalidates a broker-issued exact Goal continuation for the fresh Turn", async (t) => {
  // Harness ownership fails closed when durable WebView storage is unavailable.
  // This integration test supplies the persistence surface present in desktop.
  t.after(installFakeLocalStorageWindow());
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-submit-goal-continuation";
  const sessionId = 708;
  const oldTurnId = "turn-clear-submit-goal-old";
  const oldSessionKey = `${workspace}:${sessionId}`;
  seedWorkspaceSession(useAppStore, workspace, sessionId, oldTurnId);
  useAppStore.setState((state) => ({
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    config: {
      ...state.config,
      local: { ...state.config.local, model: "" },
    },
  }));
  useAppStore.getState().startGoal("完成清理前的目标", {
    sessionKey: oldSessionKey,
    ownerTurnId: oldTurnId,
  });
  const goalBeforeClear = useAppStore.getState().activeGoal;
  assert.ok(goalBeforeClear);
  const text = "继续这个精确目标，但必须创建新回合";
  const exactEnvelope = useAppStore.getState().captureGoalContinuationEnvelope(text, {
    source: "goal_manual_resume",
  });
  assert.ok(exactEnvelope);

  const durableClear = deferred();
  const workspaceTree = deferred();
  const workspaceTreeStarted = deferred();
  let clearInvocations = 0;
  tauriInvoke = (command, payload) => {
    if (command === "clear_project_sessions") {
      clearInvocations += 1;
      return clearInvocations === 1 ? durableClear.promise : Promise.resolve();
    }
    if (command === "get_project_skeleton") {
      workspaceTreeStarted.resolve();
      return workspaceTree.promise;
    }
    if (command === "save_project_session") return Promise.resolve(payload.session);
    return Promise.resolve("");
  };

  const clear = useAppStore.getState().clearChatHistory();
  const clearRejected = assert.rejects(clear, /goal continuation clear failed/);
  await new Promise((resolve) => setImmediate(resolve));
  const realSendMessage = useAppStore.getState().sendMessage;
  assert.equal(realSendMessage(text, undefined, {
    submissionOriginSessionKey: oldSessionKey,
    goalContinuationEnvelope: exactEnvelope,
    goalContinuationGuidance: text,
  }), true);

  const replayCalls = [];
  useAppStore.setState({
    sendMessage: (...args) => {
      replayCalls.push(args);
      return realSendMessage(...args);
    },
  });
  durableClear.reject(new Error("goal continuation clear failed"));
  await clearRejected;
  await withTimeout(workspaceTreeStarted.promise, "Goal continuation replay workspace tree");
  assert.equal(replayCalls.length, 1);
  assert.deepEqual(replayCalls[0][2].goalContinuationEnvelope, exactEnvelope);
  assert.equal(replayCalls[0][2].submissionOriginSessionKey, oldSessionKey);
  assert.equal(useAppStore.getState().conversationTurns.length, 2);
  const freshTurnId = useAppStore.getState().currentTurnId;
  assert.notEqual(freshTurnId, oldTurnId);

  workspaceTree.resolve("");
  await waitFor(
    () => useAppStore.getState().activeGoal?.ownerTurnId === freshTurnId,
    "broker-issued Goal continuation acceptance",
  );
  const continuedGoal = useAppStore.getState().activeGoal;
  assert.equal(continuedGoal.id, goalBeforeClear.id);
  assert.equal(continuedGoal.revision, goalBeforeClear.revision);
  assert.equal(continuedGoal.ownerTurnId, freshTurnId);
  assert.equal(useAppStore.getState().harnessRunMarker?.runtimeIntent, "goal");

  useAppStore.setState({ sendMessage: realSendMessage });
  await useAppStore.getState().clearChatHistory();
  await new Promise((resolve) => setImmediate(resolve));
});

test("failed real clear preserves a usable Session with a fresh safe runtime generation", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-failure";
  const sessionId = 702;
  const turnId = "turn-clear-failure";
  const sessionKey = `${workspace}:${sessionId}`;
  seedWorkspaceSession(useAppStore, workspace, sessionId, turnId);
  const oldController = createRealRuntimeOwnerController(useAppStore, sessionKey);
  const oldOwnerToken = oldController.getSessionRuntimeOwnerToken();
  const durableClear = deferred();
  tauriInvoke = (command) => command === "clear_project_sessions"
    ? durableClear.promise
    : Promise.resolve("");

  const clear = useAppStore.getState().clearChatHistory();
  const clearRejected = assert.rejects(clear, /clear storage unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useAppStore.getState().runtimeBySessionKey[sessionKey], undefined);
  assert.equal(oldController.hasSessionRuntimeOwnership(oldOwnerToken), false);

  durableClear.reject(new Error("clear storage unavailable"));
  await clearRejected;
  const recovered = useAppStore.getState();
  assert.equal(recovered.sessionsByWorkspace[workspace].length, 1);
  assert.equal(recovered.currentSessionId, sessionId);
  assert.equal(recovered.agentStatus, "idle");
  assert.equal(recovered.isGenerating, false);
  assert.equal(recovered.abortController, null);
  assert.equal(recovered.pendingReviewResolve, null);
  assert.equal(recovered.activeActionRequest, null);
  assert.equal(recovered.conversationTurns[0].status, "done");
  assert.equal(recovered.conversationTurns[0].runtimeOutcome.status, "aborted");
  assert.equal(recovered.conversationTurns[0].runtimeOutcome.resultKind, "canceled");
  assert.match(recovered.conversationTurns[0].summary, /Session 已保留/);
  assert.equal(recovered.runtimeEvents.filter((event) =>
    event.type === "run.aborted" && event.turnId === turnId
  ).length, 1);
  assert.equal(recovered.runtimeEvents.filter((event) =>
    event.type === "turn.completed" && event.turnId === turnId && event.resultKind === "canceled"
  ).length, 1);
  assert.equal(recovered.taskFlow.filter((block) =>
    block.type === "agent" && block.turnId === turnId && block.visibility === "assistant_final"
  ).length, 1);
  assert.ok(recovered.runtimeBySessionKey[sessionKey]);
  assert.equal(oldController.hasSessionRuntimeOwnership(oldOwnerToken), false);

  const freshController = createRealRuntimeOwnerController(useAppStore, sessionKey);
  const freshOwnerToken = freshController.getSessionRuntimeOwnerToken();
  assert.equal(freshController.hasSessionRuntimeOwnership(freshOwnerToken), true);
  assert.equal(oldController.hasSessionRuntimeOwnership(oldOwnerToken), false);
});

test("failed clear terminalizes active and background owners before sequential recovery publication", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const workspace = "/workspace-clear-owner-recovery";
  const activeSessionId = 703;
  const backgroundSessionId = 704;
  const closedSessionId = 705;
  const activeTurnId = "turn-clear-active";
  const backgroundTurnId = "turn-clear-background";
  const closedTurnId = "turn-clear-already-closed";
  const activeSessionKey = `${workspace}:${activeSessionId}`;
  const backgroundSessionKey = `${workspace}:${backgroundSessionId}`;
  const closedSessionKey = `${workspace}:${closedSessionId}`;
  seedWorkspaceSession(useAppStore, workspace, activeSessionId, activeTurnId);
  useAppStore.setState((state) => ({
    sessionsByWorkspace: {
      ...state.sessionsByWorkspace,
      [workspace]: [
        state.sessionsByWorkspace[workspace][0],
        {
          id: backgroundSessionId,
          title: "Background Session",
          date: "Today",
          active: false,
          messages: [],
        },
        {
          id: closedSessionId,
          title: "Closed Session",
          date: "Today",
          active: false,
          messages: [],
        },
      ],
    },
  }));

  const duplicateFinals = (turnId, firstId) => [
    {
      id: firstId,
      turnId,
      type: "agent",
      content: "stale final one",
      streaming: false,
      visibility: "assistant_final",
    },
    {
      id: firstId + 1,
      turnId,
      type: "agent",
      content: "stale final two",
      streaming: false,
      visibility: "assistant_final",
    },
  ];
  const queuedBySessionKey = new Map([
    [activeSessionKey, {
      id: "queued-clear-active",
      sessionKey: activeSessionKey,
      text: "清空失败后继续主动任务",
      runtimeIntentOverride: "goal",
      goalSourceContextSnapshot: "active goal source",
      goalCreationAuthorization: {
        kind: "goal_creation_authorization",
        intent: "goal",
        source: "visible_goal_shortcut",
      },
      createdAt: 21,
      status: "queued",
    }],
    [backgroundSessionKey, {
      id: "queued-clear-background",
      sessionKey: backgroundSessionKey,
      text: "清空失败后继续后台 Goal",
      runtimeIntentOverride: "goal",
      goalContinuationAuthorization: {
        kind: "goal_continuation_authorization",
        source: "goal_manual_resume",
        workspaceKey: workspace,
        sessionKey: backgroundSessionKey,
        goalId: "goal-clear-background",
        goalRevision: 2,
        ownerTurnId: backgroundTurnId,
      },
      goalContinuationGuidance: "继续后台 Goal",
      createdAt: 22,
      status: "queued",
    }],
    [closedSessionKey, {
      id: "queued-clear-closed",
      sessionKey: closedSessionKey,
      text: "已终态 Session 的下一条指令",
      runtimeIntentOverride: "execute",
      goalCreationAuthorization: {
        kind: "goal_creation_authorization",
        intent: "goal",
        source: "visible_goal_composer_capsule",
      },
      createdAt: 23,
      status: "queued",
    }],
  ]);
  const activeController = createRealRuntimeOwnerController(useAppStore, activeSessionKey);
  activeController.sessionSet({
    taskFlow: duplicateFinals(activeTurnId, 1001),
    queuedUserMessage: queuedBySessionKey.get(activeSessionKey),
  });
  const backgroundController = createRealRuntimeOwnerController(useAppStore, backgroundSessionKey);
  backgroundController.sessionSet({
    conversationTurns: [executionTurn(backgroundTurnId)],
    currentTurnId: backgroundTurnId,
    taskFlow: duplicateFinals(backgroundTurnId, 1101),
    runtimeEvents: [],
    agentStatus: "running",
    isGenerating: true,
    queuedUserMessage: queuedBySessionKey.get(backgroundSessionKey),
  });
  const closedController = createRealRuntimeOwnerController(useAppStore, closedSessionKey);
  closedController.sessionSet({
    conversationTurns: [{
      ...executionTurn(closedTurnId),
      status: "done",
      summary: "already closed",
      runtimeOutcome: {
        status: "aborted",
        reason: "already_closed",
        resultKind: "canceled",
        runId: "run-already-closed",
        parentRunId: null,
        updatedAt: 8,
      },
    }],
    currentTurnId: closedTurnId,
    taskFlow: [{
      id: 1201,
      turnId: closedTurnId,
      type: "agent",
      content: "already closed",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      {
        schemaVersion: 2,
        type: "run.started",
        threadId: closedSessionKey,
        turnId: closedTurnId,
        timestampMs: 7,
        runId: "run-already-closed",
        parentRunId: null,
      },
      {
        schemaVersion: 2,
        type: "run.aborted",
        threadId: closedSessionKey,
        turnId: closedTurnId,
        timestampMs: 8,
        runId: "run-already-closed",
        parentRunId: null,
        reason: "already_closed",
        message: "already closed",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: closedSessionKey,
        turnId: closedTurnId,
        timestampMs: 8,
        resultKind: "canceled",
      },
    ],
    agentStatus: "idle",
    isGenerating: false,
    queuedUserMessage: queuedBySessionKey.get(closedSessionKey),
  });
  const oldOwners = [activeController, backgroundController, closedController].map((controller) => ({
    controller,
    token: controller.getSessionRuntimeOwnerToken(),
  }));

  const durableClear = deferred();
  const saveGates = [deferred(), deferred(), deferred()];
  const saveStarts = [deferred(), deferred(), deferred()];
  const savePayloads = [];
  tauriInvoke = (command, payload) => {
    if (command === "clear_project_sessions") return durableClear.promise;
    if (command === "save_project_session") {
      const index = savePayloads.length;
      savePayloads.push(payload);
      saveStarts[index].resolve();
      return saveGates[index].promise;
    }
    return Promise.resolve("");
  };

  const clear = useAppStore.getState().clearChatHistory();
  const clearRejected = assert.rejects(clear, /owner recovery clear failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useAppStore.getState().queuedUserMessage, null);
  for (const { controller, token } of oldOwners) {
    assert.equal(controller.hasSessionRuntimeOwnership(token), false);
  }
  durableClear.reject(new Error("owner recovery clear failed"));

  await saveStarts[0].promise;
  assert.deepEqual(savePayloads.map((payload) => payload.session.id), [activeSessionId]);
  assert.equal(useAppStore.getState().currentSessionId, null);
  assert.equal(savePayloads[0].session.runtimeSnapshot.conversationTurns[0].runtimeOutcome.status, "aborted");
  saveGates[0].resolve(savePayloads[0].session);

  await saveStarts[1].promise;
  assert.deepEqual(
    savePayloads.map((payload) => payload.session.id),
    [activeSessionId, backgroundSessionId],
  );
  assert.equal(useAppStore.getState().currentSessionId, null);
  saveGates[1].reject(new Error("background terminal snapshot unavailable"));

  await saveStarts[2].promise;
  assert.deepEqual(
    savePayloads.map((payload) => payload.session.id),
    [activeSessionId, backgroundSessionId, closedSessionId],
  );
  assert.equal(useAppStore.getState().currentSessionId, null);
  saveGates[2].resolve(savePayloads[2].session);
  await clearRejected;

  const recovered = useAppStore.getState();
  assert.equal(recovered.currentSessionId, activeSessionId);
  const recoveredOwners = [
    [activeSessionKey, activeTurnId],
    [backgroundSessionKey, backgroundTurnId],
    [closedSessionKey, closedTurnId],
  ];
  for (const [sessionKey, turnId] of recoveredOwners) {
    const runtime = recovered.runtimeBySessionKey[sessionKey];
    assert.ok(runtime, `missing recovered runtime ${sessionKey}`);
    const turn = runtime.conversationTurns.find((candidate) => candidate.id === turnId);
    assert.equal(turn.status, "done");
    assert.equal(turn.runtimeOutcome.status, "aborted");
    assert.equal(turn.runtimeOutcome.resultKind, "canceled");
    assert.equal(runtime.runtimeEvents.filter((event) =>
      event.type === "run.aborted" && event.turnId === turnId
    ).length, 1);
    assert.equal(runtime.runtimeEvents.filter((event) =>
      event.type === "turn.completed" && event.turnId === turnId && event.resultKind === "canceled"
    ).length, 1);
    assert.equal(runtime.taskFlow.filter((block) =>
      block.type === "agent" && block.turnId === turnId && block.visibility === "assistant_final"
    ).length, 1);
    assert.deepEqual(runtime.queuedUserMessage, queuedBySessionKey.get(sessionKey));
    const sessionId = Number(sessionKey.slice(sessionKey.lastIndexOf(":") + 1));
    assert.deepEqual(
      recovered.sessionsByWorkspace[workspace]
        .find((session) => session.id === sessionId)
        .runtimeSnapshot.queuedUserMessage,
      queuedBySessionKey.get(sessionKey),
    );
  }
  assert.equal(
    recovered.sessionsByWorkspace[workspace]
      .find((session) => session.id === backgroundSessionId)
      .runtimeSnapshot.conversationTurns[0].runtimeOutcome.status,
    "aborted",
  );
  for (const { controller, token } of oldOwners) {
    assert.equal(controller.hasSessionRuntimeOwnership(token), false);
  }
  const freshController = createRealRuntimeOwnerController(useAppStore, activeSessionKey);
  assert.equal(
    freshController.hasSessionRuntimeOwnership(freshController.getSessionRuntimeOwnerToken()),
    true,
  );
  assert.deepEqual(
    freshController.sessionGet().queuedUserMessage,
    queuedBySessionKey.get(activeSessionKey),
  );
  assert.equal(useAppStore.getState().clearQueuedUserMessage({
    expectedId: queuedBySessionKey.get(activeSessionKey).id,
    disposition: "consumed",
    reason: "clear_failure_recovery_test_consumed",
  }), true);
  assert.equal(freshController.sessionGet().queuedUserMessage, null);
  assert.equal(activeController.hasSessionRuntimeOwnership(oldOwners[0].token), false);
});

function buildValidPlanArtifactText(label) {
  return [
    "# Plan authorization boundary",
    "",
    "## User goal",
    `- ${label}: preserve exact Plan bytes and revoke stale execution authority.`,
    "",
    "## Key changes",
    "- Bind approval to the materialized Plan revision and hash.",
    "- Reject any tool continuation after the artifact changes.",
    "",
    "## Execution steps",
    "1. Materialize the reviewed Plan artifact.",
    "2. Admit an attempt-scoped execution lease.",
    "3. Revoke the lease when a historical Diff is restored.",
    "",
    "## Validation",
    "- Assert the resolver rejects once, the Run aborts once, and no old lease remains.",
    "",
  ].join("\n");
}

test("ordinary Execute Diff revert uses the Session generation without requiring a Plan owner", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  useAppStore.getState().resetAllSettings();
  const workspace = "/workspace-generic-diff-revert";
  const sessionId = 810;
  const turnId = "turn-generic-diff-revert";
  const filePath = "src/generic.ts";
  const oldText = "export const value = 1;\n";
  const newText = "export const value = 2;\n";
  seedWorkspaceSession(useAppStore, workspace, sessionId, turnId);
  useAppStore.setState({
    taskFlow: [{
      id: 900,
      turnId,
      type: "tool",
      toolName: "write_file",
      target: filePath,
      status: "success",
      toolStatus: "executed",
      diff: {
        old: oldText,
        new: newText,
        path: filePath,
        existed: true,
        fullFile: true,
      },
    }],
  });

  const writes = [];
  tauriInvoke = (command, payload) => {
    if (command === "read_file") return Promise.resolve(newText);
    if (command === "write_file") {
      writes.push(payload);
      return Promise.resolve();
    }
    return Promise.resolve("");
  };
  const result = await useAppStore.getState().revertDiffGroups([{
    path: filePath,
    taskIds: [900],
    oldText,
    newText,
    existed: true,
    fullFile: true,
  }]);

  assert.equal(result[0].ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].content, oldText);
  assert.ok(useAppStore.getState().sessionsByWorkspace[workspace][0].planLifecycleEpoch);
  assert.equal(useAppStore.getState().taskFlow[0].revertStatus, "reverted");
});

function buildPlanDiffRevertFixture(input) {
  const { buildPlanApprovalIdentity } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/lib/planApprovalIdentity.ts"),
  );
  const { buildToolPermissionActionRequest } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/lib/pendingToolReview.ts"),
  );
  const artifactPath = ".MAIN/plans/plan.md";
  const artifact = {
    kind: "plan",
    path: artifactPath,
    title: "Plan",
    content: input.currentContent,
    revision: 7,
    updatedAt: 70,
  };
  const identity = buildPlanApprovalIdentity([artifact]);
  assert.ok(identity);
  const sessionEpoch = "epoch-plan-diff-revert";
  const turnId = "turn-plan-diff-revert";
  const reviewRunId = "run-plan-review";
  const executionRunId = "run-plan-execution";
  const requestId = "request-plan-review";
  const approvalLeaseId = "approval-plan-diff";
  const executionLeaseId = "execution-plan-diff";
  const instructionHash = "plan-instruction-sha256-diff-revert";
  const reviewIdentity = {
    sessionKey: input.sessionKey,
    sessionEpoch,
    turnId,
    runId: reviewRunId,
    parentRunId: "run-plan-author",
    requestId,
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
  };
  const approvalLease = {
    schemaVersion: 2,
    leaseId: approvalLeaseId,
    sessionKey: input.sessionKey,
    sessionEpoch,
    planTurnId: turnId,
    reviewRunId,
    requestId,
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
    approvedAt: 80,
    approvalTurnId: turnId,
    approvalRunId: reviewRunId,
    approvalDecisionKind: "action_decision",
  };
  const executionLease = {
    schemaVersion: 2,
    executionLeaseId,
    approvalLeaseId,
    sessionKey: input.sessionKey,
    sessionEpoch,
    planTurnId: turnId,
    executionTurnId: turnId,
    executionRunId,
    parentRunId: reviewRunId,
    attempt: 1,
    issuedAt: 81,
    reason: "initial_approval",
    instructionHash,
    authorization: {
      kind: "action_decision",
      sessionKey: input.sessionKey,
      sessionEpoch,
      turnId,
      runId: reviewRunId,
      requestId,
    },
  };
  const execution = {
    turnId,
    runId: executionRunId,
    parentRunId: reviewRunId,
    attempt: 1,
    startedAt: 82,
  };
  const lifecycle = {
    schemaVersion: 2,
    version: 5,
    status: input.pendingReview ? "paused" : "executing",
    sessionKey: input.sessionKey,
    sessionEpoch,
    planTurnId: turnId,
    artifactIdentity: {
      revision: identity.revision,
      artifactHash: identity.artifactHash,
      artifactPaths: identity.artifactPaths,
    },
    reviewIdentity,
    approvalLease,
    executionLease,
    lastIssuedAttempt: 1,
    execution,
    pause: input.pendingReview
      ? {
          reason: "tool_permission",
          resultKind: "partial",
          resumeCondition: "resolve_action_request",
        }
      : null,
    updatedAt: 83,
  };
  const provenance = {
    schemaVersion: 1,
    sessionKey: input.sessionKey,
    sessionEpoch,
    planTurnId: turnId,
    approvalLeaseId,
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    executionLeaseId,
    executionTurnId: turnId,
    executionRunId,
    parentRunId: reviewRunId,
    attempt: 1,
    instructionHash,
  };
  const permissionRequest = input.pendingReview
    ? buildToolPermissionActionRequest({
        sessionKey: input.sessionKey,
        turnId,
        runId: executionRunId,
        parentRunId: reviewRunId,
        title: "Execute exact Plan",
        taskId: 902,
        toolCall: {
          name: "apply_patch",
          arguments: { patch: "*** Begin Patch\n*** End Patch" },
        },
        planExecution: provenance,
        now: 84,
      })
    : null;
  const harnessRunMarker = {
    schemaVersion: 1,
    runId: executionRunId,
    parentRunId: reviewRunId,
    activeRunId: executionRunId,
    activeParentRunId: reviewRunId,
    activePlanExecutionProvenance: provenance,
    sessionKey: input.sessionKey,
    sessionId: null,
    workspace: input.sessionKey.slice(0, input.sessionKey.lastIndexOf(":")),
    turnId,
    instanceId: "instance-plan-diff-revert",
    status: input.pendingReview ? "paused" : "running",
    startedAt: 82,
    updatedAt: 84,
    closedAt: null,
    closeReason: null,
  };
  return {
    artifactPath,
    artifact,
    lifecycle,
    permissionRequest,
    provenance,
    harnessRunMarker,
    turnId,
  };
}

for (const pendingReview of [false, true]) {
  test(`Plan Diff revert revokes ${pendingReview ? "a paused tool review" : "an executing Run"} atomically`, async () => {
    const { useAppStore } = loadTranspiledModuleSync(
      path.join(process.cwd(), "src/store/useAppStore.ts"),
    );
    useAppStore.getState().resetAllSettings();
    const workspace = `/workspace-plan-diff-revert-${pendingReview ? "review" : "running"}`;
    const sessionId = pendingReview ? 812 : 811;
    const sessionKey = `${workspace}:${sessionId}`;
    const currentContent = buildValidPlanArtifactText("current content");
    const restoredContent = buildValidPlanArtifactText("restored content");
    const fixture = buildPlanDiffRevertFixture({
      sessionKey,
      currentContent,
      pendingReview,
    });
    seedWorkspaceSession(useAppStore, workspace, sessionId, fixture.turnId);
    const decisions = [];
    const abortController = new AbortController();
    let aborts = 0;
    abortController.signal.addEventListener("abort", () => { aborts += 1; });
    useAppStore.setState({
      planArtifacts: [fixture.artifact],
      planTasks: [],
      planLifecycle: fixture.lifecycle,
      planStage: pendingReview ? "ready_to_execute" : "executing",
      isPlanApproved: !pendingReview,
      currentTurnExecutionConsent: { turnId: fixture.turnId, granted: true },
      activeActionRequest: fixture.permissionRequest,
      pendingReviewResolve: pendingReview
        ? (decision) => decisions.push(decision)
        : null,
      pendingReviewTaskId: fixture.permissionRequest?.taskId ?? null,
      pendingToolCall: fixture.permissionRequest
        ? { name: fixture.permissionRequest.toolName, arguments: {} }
        : null,
      harnessRunMarker: fixture.harnessRunMarker,
      abortController,
      taskFlow: [{
        id: 901,
        turnId: fixture.turnId,
        type: "tool",
        toolName: "write_file",
        target: fixture.artifactPath,
        status: "success",
        toolStatus: "executed",
        diff: {
          old: restoredContent,
          new: currentContent,
          path: fixture.artifactPath,
          existed: true,
          fullFile: true,
        },
      }],
      agentStatus: pendingReview ? "pending_review" : "running",
      isGenerating: true,
    });

    const writes = [];
    tauriInvoke = (command, payload) => {
      if (command === "read_file") return Promise.resolve(currentContent);
      if (command === "write_file") {
        writes.push(payload);
        return Promise.resolve();
      }
      return Promise.resolve("");
    };
    const result = await useAppStore.getState().revertDiffGroups([{
      path: fixture.artifactPath,
      taskIds: [901],
      oldText: restoredContent,
      newText: currentContent,
      existed: true,
      fullFile: true,
    }]);

    assert.equal(result[0].ok, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].content, restoredContent);
    const state = useAppStore.getState();
    assert.equal(state.planArtifacts[0].content, restoredContent.trim());
    assert.equal(state.planArtifacts[0].revision, 8);
    assert.equal(state.planLifecycle.status, "paused");
    assert.equal(state.planLifecycle.pause.reason, "artifact_identity_changed");
    assert.equal(state.planLifecycle.approvalLease, null);
    assert.equal(state.planLifecycle.executionLease, null);
    assert.equal(state.planLifecycle.execution, null);
    assert.equal(state.isPlanApproved, false);
    assert.deepEqual(state.currentTurnExecutionConsent, { turnId: null, granted: false });
    assert.equal(state.activeActionRequest, null);
    assert.equal(state.pendingReviewResolve, null);
    assert.equal(state.pendingReviewTaskId, null);
    assert.equal(state.pendingToolCall, null);
    assert.deepEqual(decisions, pendingReview ? [{ action: "reject" }] : []);
    assert.equal(aborts, 1);
  });
}

test("explicit Plan resume revokes a resumable owner whose logical Turn is already terminal", () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  useAppStore.getState().resetAllSettings();
  const workspace = "/workspace-terminal-plan-resume";
  const sessionId = 819;
  const sessionKey = `${workspace}:${sessionId}`;
  const currentContent = buildValidPlanArtifactText("terminal Plan owner");
  const fixture = buildPlanDiffRevertFixture({
    sessionKey,
    currentContent,
    pendingReview: true,
  });
  seedWorkspaceSession(useAppStore, workspace, sessionId, fixture.turnId);
  useAppStore.setState({
    planArtifacts: [fixture.artifact],
    planTasks: [],
    planLifecycle: fixture.lifecycle,
    planStage: "ready_to_execute",
    isPlanApproved: false,
    pendingPlanApprovalHandoff: {
      planTurnId: fixture.turnId,
      requestedAt: 85,
      approvalLeaseId: fixture.lifecycle.approvalLease.leaseId,
      executionLeaseId: fixture.lifecycle.executionLease.executionLeaseId,
      sessionEpoch: fixture.lifecycle.sessionEpoch,
      reviewRequestId: fixture.lifecycle.approvalLease.requestId,
      executionTurnId: fixture.lifecycle.execution.turnId,
      executionRunId: fixture.lifecycle.execution.runId,
      executionAttempt: fixture.lifecycle.execution.attempt,
      executionInstructionHash: fixture.lifecycle.executionLease.instructionHash,
      prompt: "continue terminal Plan",
      planRevision: fixture.lifecycle.artifactIdentity.revision,
      artifactHash: fixture.lifecycle.artifactIdentity.artifactHash,
      artifactPaths: fixture.lifecycle.artifactIdentity.artifactPaths,
      parentRunId: fixture.lifecycle.execution.parentRunId,
    },
    currentTurnExecutionConsent: { turnId: fixture.turnId, granted: true },
    runtimeEvents: [{
      schemaVersion: 2,
      type: "turn.completed",
      threadId: sessionKey,
      turnId: fixture.turnId,
      timestampMs: 90,
      resultKind: "error",
    }],
    activeActionRequest: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    harnessRunMarker: null,
    abortController: null,
    agentStatus: "idle",
    isGenerating: false,
  });

  assert.equal(useAppStore.getState().resumePlanExecution("continue safely"), false);
  const state = useAppStore.getState();
  assert.equal(state.planLifecycle.status, "drafting");
  assert.equal(state.planLifecycle.approvalLease, null);
  assert.equal(state.planLifecycle.executionLease, null);
  assert.equal(state.planLifecycle.execution, null);
  assert.equal(state.pendingPlanApprovalHandoff, null);
  assert.deepEqual(state.currentTurnExecutionConsent, { turnId: null, granted: false });
  assert.equal(state.showPlanPanel, true);
});

test("an in-flight Plan Diff revert publishes only to its exact source Session after a Session switch", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  const { createPlanLifecycleState } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/lib/planLifecycle.ts"),
  );
  useAppStore.getState().resetAllSettings();
  const workspace = "/workspace-plan-diff-source-fence";
  const sourceSessionId = 814;
  const targetSessionId = 815;
  const sourceSessionKey = `${workspace}:${sourceSessionId}`;
  const targetSessionKey = `${workspace}:${targetSessionId}`;
  const currentContent = buildValidPlanArtifactText("source current content");
  const restoredContent = buildValidPlanArtifactText("source restored content");
  const fixture = buildPlanDiffRevertFixture({
    sessionKey: sourceSessionKey,
    currentContent,
    pendingReview: false,
  });
  seedWorkspaceSession(useAppStore, workspace, sourceSessionId, fixture.turnId);
  const sourceAbortController = new AbortController();
  let sourceAborts = 0;
  sourceAbortController.signal.addEventListener("abort", () => { sourceAborts += 1; });
  useAppStore.setState({
    planArtifacts: [fixture.artifact],
    planTasks: [],
    planLifecycle: fixture.lifecycle,
    planStage: "executing",
    isPlanApproved: true,
    currentTurnExecutionConsent: { turnId: fixture.turnId, granted: true },
    harnessRunMarker: fixture.harnessRunMarker,
    abortController: sourceAbortController,
    taskFlow: [{
      id: 903,
      turnId: fixture.turnId,
      type: "tool",
      toolName: "write_file",
      target: fixture.artifactPath,
      status: "success",
      toolStatus: "executed",
      diff: {
        old: restoredContent,
        new: currentContent,
        path: fixture.artifactPath,
        existed: true,
        fullFile: true,
      },
    }],
    agentStatus: "running",
    isGenerating: true,
  });

  const readStarted = deferred();
  const readGate = deferred();
  const writes = [];
  tauriInvoke = (command, payload) => {
    if (command === "read_file") {
      readStarted.resolve();
      return readGate.promise;
    }
    if (command === "write_file") {
      writes.push(payload);
      return Promise.resolve();
    }
    return Promise.resolve("");
  };
  const revert = useAppStore.getState().revertDiffGroups([{
    path: fixture.artifactPath,
    taskIds: [903],
    oldText: restoredContent,
    newText: currentContent,
    existed: true,
    fullFile: true,
  }]);
  await readStarted.promise;
  assert.ok(useAppStore.getState().runtimeBySessionKey[sourceSessionKey]);

  const targetEpoch = "epoch-plan-diff-target";
  const targetLifecycle = createPlanLifecycleState({
    sessionKey: targetSessionKey,
    sessionEpoch: targetEpoch,
    updatedAt: 100,
  });
  const targetArtifact = {
    kind: "plan",
    path: ".MAIN/plans/target.md",
    title: "Target Plan",
    content: buildValidPlanArtifactText("target Session must remain visible"),
    revision: 1,
    updatedAt: 100,
  };
  const targetTaskFlow = [{
    id: 990,
    turnId: "turn-target-session",
    type: "system",
    content: "target-session-sentinel",
  }];
  const targetAbortController = new AbortController();
  let targetAborts = 0;
  targetAbortController.signal.addEventListener("abort", () => { targetAborts += 1; });
  useAppStore.setState((state) => ({
    sessionsByWorkspace: {
      ...state.sessionsByWorkspace,
      [workspace]: [
        ...(state.sessionsByWorkspace[workspace] || []).map((session) => ({
          ...session,
          active: false,
          planLifecycleEpoch: fixture.lifecycle.sessionEpoch,
        })),
        {
          id: targetSessionId,
          title: "Target Session",
          date: "Today",
          active: true,
          messages: [],
          planLifecycleEpoch: targetEpoch,
        },
      ],
    },
    currentSessionId: targetSessionId,
    activeSessionByWorkspace: { ...state.activeSessionByWorkspace, [workspace]: targetSessionId },
    planArtifacts: [targetArtifact],
    planTasks: [],
    planLifecycle: targetLifecycle,
    planStage: "plan",
    isPlanApproved: false,
    currentTurnExecutionConsent: { turnId: null, granted: false },
    harnessRunMarker: null,
    abortController: targetAbortController,
    taskFlow: targetTaskFlow,
    conversationTurns: [executionTurn("turn-target-session")],
    currentTurnId: "turn-target-session",
    agentStatus: "running",
    isGenerating: true,
  }));
  readGate.resolve(currentContent);

  const result = await revert;
  assert.equal(result[0].ok, true);
  assert.equal(writes.length, 1);
  assert.equal(sourceAborts, 1);
  assert.equal(targetAborts, 0);
  const state = useAppStore.getState();
  assert.equal(state.currentSessionId, targetSessionId);
  assert.equal(state.planLifecycle.sessionKey, targetSessionKey);
  assert.equal(state.planLifecycle.sessionEpoch, targetEpoch);
  assert.deepEqual(state.planArtifacts, [targetArtifact]);
  assert.deepEqual(state.taskFlow, targetTaskFlow);
  assert.equal(state.abortController, targetAbortController);
  const sourceRuntime = state.runtimeBySessionKey[sourceSessionKey];
  assert.ok(sourceRuntime);
  assert.equal(sourceRuntime.planArtifacts[0].content, restoredContent.trim());
  assert.equal(sourceRuntime.planLifecycle.status, "paused");
  assert.equal(sourceRuntime.planLifecycle.approvalLease, null);
  assert.equal(sourceRuntime.taskFlow[0].revertStatus, "reverted");
});

test("settings reset invalidates an in-flight Plan Diff revert without reinjecting its source runtime", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  useAppStore.getState().resetAllSettings();
  const workspace = "/workspace-plan-diff-reset-fence";
  const sessionId = 816;
  const sessionKey = `${workspace}:${sessionId}`;
  const currentContent = buildValidPlanArtifactText("reset current content");
  const restoredContent = buildValidPlanArtifactText("reset restored content");
  const fixture = buildPlanDiffRevertFixture({
    sessionKey,
    currentContent,
    pendingReview: false,
  });
  seedWorkspaceSession(useAppStore, workspace, sessionId, fixture.turnId);
  useAppStore.setState({
    planArtifacts: [fixture.artifact],
    planTasks: [],
    planLifecycle: fixture.lifecycle,
    planStage: "executing",
    isPlanApproved: true,
    currentTurnExecutionConsent: { turnId: fixture.turnId, granted: true },
    harnessRunMarker: fixture.harnessRunMarker,
    abortController: new AbortController(),
    taskFlow: [{
      id: 904,
      turnId: fixture.turnId,
      type: "tool",
      toolName: "write_file",
      target: fixture.artifactPath,
      status: "success",
      toolStatus: "executed",
      diff: {
        old: restoredContent,
        new: currentContent,
        path: fixture.artifactPath,
        existed: true,
        fullFile: true,
      },
    }],
    agentStatus: "running",
    isGenerating: true,
  });

  const writeStarted = deferred();
  const writeGate = deferred();
  tauriInvoke = (command) => {
    if (command === "read_file") return Promise.resolve(currentContent);
    if (command === "write_file") {
      writeStarted.resolve();
      return writeGate.promise;
    }
    return Promise.resolve("");
  };
  const revert = useAppStore.getState().revertDiffGroups([{
    path: fixture.artifactPath,
    taskIds: [904],
    oldText: restoredContent,
    newText: currentContent,
    existed: true,
    fullFile: true,
  }]);
  await writeStarted.promise;
  useAppStore.getState().resetAllSettings();
  writeGate.resolve();

  const result = await revert;
  assert.equal(result[0].ok, false);
  assert.match(result[0].message, /设置重置|Settings reset/);
  const state = useAppStore.getState();
  assert.deepEqual(state.runtimeBySessionKey, {});
  assert.deepEqual(state.planArtifacts, []);
  assert.deepEqual(state.taskFlow, []);
  assert.equal(state.planLifecycle.status, "empty");
  assert.equal(state.pendingPlanApprovalHandoff, null);
  assert.equal(state.activeActionRequest, null);
  assert.equal(state.abortController, null);
});

test("Plan Diff authority invalidation does not abort an unrelated generic Run", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  useAppStore.getState().resetAllSettings();
  const workspace = "/workspace-plan-diff-generic-run";
  const sessionId = 817;
  const sessionKey = `${workspace}:${sessionId}`;
  const currentContent = buildValidPlanArtifactText("generic current content");
  const restoredContent = buildValidPlanArtifactText("generic restored content");
  const fixture = buildPlanDiffRevertFixture({
    sessionKey,
    currentContent,
    pendingReview: false,
  });
  seedWorkspaceSession(useAppStore, workspace, sessionId, fixture.turnId);
  const genericAbortController = new AbortController();
  let genericAborts = 0;
  genericAbortController.signal.addEventListener("abort", () => { genericAborts += 1; });
  const genericMarker = {
    ...fixture.harnessRunMarker,
    runId: "run-generic-unrelated",
    activeRunId: "run-generic-unrelated",
    activeParentRunId: null,
    parentRunId: null,
    activePlanExecutionProvenance: null,
  };
  useAppStore.setState({
    planArtifacts: [fixture.artifact],
    planTasks: [],
    planLifecycle: fixture.lifecycle,
    planStage: "executing",
    isPlanApproved: true,
    harnessRunMarker: genericMarker,
    abortController: genericAbortController,
    taskFlow: [{
      id: 905,
      turnId: fixture.turnId,
      type: "tool",
      toolName: "write_file",
      target: fixture.artifactPath,
      status: "success",
      toolStatus: "executed",
      diff: {
        old: restoredContent,
        new: currentContent,
        path: fixture.artifactPath,
        existed: true,
        fullFile: true,
      },
    }],
  });
  tauriInvoke = (command) => {
    if (command === "read_file") return Promise.resolve(currentContent);
    if (command === "write_file") return Promise.resolve();
    return Promise.resolve("");
  };

  const result = await useAppStore.getState().revertDiffGroups([{
    path: fixture.artifactPath,
    taskIds: [905],
    oldText: restoredContent,
    newText: currentContent,
    existed: true,
    fullFile: true,
  }]);

  assert.equal(result[0].ok, true);
  assert.equal(genericAborts, 0);
  assert.equal(useAppStore.getState().harnessRunMarker.runId, "run-generic-unrelated");
  assert.equal(useAppStore.getState().planLifecycle.approvalLease, null);
});

test("a throwing Plan abort observer cannot turn a committed Diff revert into failure", async () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  useAppStore.getState().resetAllSettings();
  const workspace = "/workspace-plan-diff-abort-throws";
  const sessionId = 818;
  const sessionKey = `${workspace}:${sessionId}`;
  const currentContent = buildValidPlanArtifactText("throwing abort current content");
  const restoredContent = buildValidPlanArtifactText("throwing abort restored content");
  const fixture = buildPlanDiffRevertFixture({
    sessionKey,
    currentContent,
    pendingReview: false,
  });
  seedWorkspaceSession(useAppStore, workspace, sessionId, fixture.turnId);
  let abortCalls = 0;
  useAppStore.setState({
    planArtifacts: [fixture.artifact],
    planTasks: [],
    planLifecycle: fixture.lifecycle,
    planStage: "executing",
    isPlanApproved: true,
    harnessRunMarker: fixture.harnessRunMarker,
    abortController: {
      signal: { aborted: false },
      abort: () => {
        abortCalls += 1;
        throw new Error("observer abort failed");
      },
    },
    taskFlow: [{
      id: 906,
      turnId: fixture.turnId,
      type: "tool",
      toolName: "write_file",
      target: fixture.artifactPath,
      status: "success",
      toolStatus: "executed",
      diff: {
        old: restoredContent,
        new: currentContent,
        path: fixture.artifactPath,
        existed: true,
        fullFile: true,
      },
    }],
  });
  tauriInvoke = (command) => {
    if (command === "read_file") return Promise.resolve(currentContent);
    if (command === "write_file") return Promise.resolve();
    return Promise.resolve("");
  };

  const result = await useAppStore.getState().revertDiffGroups([{
    path: fixture.artifactPath,
    taskIds: [906],
    oldText: restoredContent,
    newText: currentContent,
    existed: true,
    fullFile: true,
  }]);

  assert.equal(abortCalls, 1);
  assert.equal(result[0].ok, true);
  assert.equal(useAppStore.getState().taskFlow[0].revertStatus, "reverted");
  assert.equal(useAppStore.getState().planArtifacts[0].content, restoredContent.trim());
  assert.equal(useAppStore.getState().planLifecycle.approvalLease, null);
});

test("a stale Plan permission click rejects instead of approving artifact representation drift", () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  useAppStore.getState().resetAllSettings();
  const workspace = "/workspace-plan-permission-drift";
  const sessionId = 813;
  const sessionKey = `${workspace}:${sessionId}`;
  const currentContent = buildValidPlanArtifactText("reviewed content");
  const fixture = buildPlanDiffRevertFixture({
    sessionKey,
    currentContent,
    pendingReview: true,
  });
  seedWorkspaceSession(useAppStore, workspace, sessionId, fixture.turnId);
  const decisions = [];
  const abortController = new AbortController();
  let aborts = 0;
  abortController.signal.addEventListener("abort", () => { aborts += 1; });
  const request = fixture.permissionRequest;
  assert.ok(request);
  useAppStore.setState({
    planArtifacts: [{
      ...fixture.artifact,
      content: buildValidPlanArtifactText("bytes changed outside lifecycle transition"),
      revision: 8,
      updatedAt: 90,
    }],
    planLifecycle: fixture.lifecycle,
    planStage: "ready_to_execute",
    isPlanApproved: false,
    activeActionRequest: request,
    pendingReviewResolve: (decision) => decisions.push(decision),
    pendingReviewTaskId: request.taskId,
    pendingToolCall: { name: request.toolName, arguments: {} },
    harnessRunMarker: fixture.harnessRunMarker,
    abortController,
    agentStatus: "pending_review",
    isGenerating: false,
    taskFlow: [{
      id: request.taskId,
      turnId: request.turnId,
      type: "tool",
      toolName: request.toolName,
      target: request.target,
      status: "pending_review",
      toolStatus: "pending",
    }],
  });

  useAppStore.getState().allowToolAction(request.taskId, {
    sessionKey: request.sessionKey,
    turnId: request.turnId,
    runId: request.runId,
    requestId: request.requestId,
    taskId: request.taskId,
  });

  const state = useAppStore.getState();
  assert.deepEqual(decisions, [{ action: "reject" }]);
  assert.equal(aborts, 1);
  assert.equal(state.activeActionRequest, null);
  assert.equal(state.pendingReviewResolve, null);
  assert.equal(state.pendingReviewTaskId, null);
  assert.equal(state.pendingToolCall, null);
  assert.notEqual(state.taskFlow[0].toolStatus, "running");
});

test("settings reset revokes active and cached runtimes before clearing transient controls", () => {
  const source = readSource("src/store/useAppStore.ts");
  const start = source.indexOf("resetAllSettings: () => {");
  const end = source.indexOf("\n\n  // ── Workflow Mode", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  const revertGenerationIndex = body.indexOf("planDiffRevertResetGeneration += 1");
  const revokeIndex = body.indexOf("revokeAllSessionRuntimesBeforeSettingsReset({");
  const clearIndex = body.indexOf("sessionsByWorkspace: {}");
  assert.ok(revertGenerationIndex >= 0);
  assert.ok(revertGenerationIndex < revokeIndex);
  assert.ok(revokeIndex >= 0);
  assert.ok(clearIndex > revokeIndex);
  for (const field of [
    "abortController: null",
    "pendingRunDecisionResolver: null",
    "pendingReviewResolve: null",
    "activeActionRequest: null",
    "pendingToolCall: null",
    "pendingSlashCommand: null",
    "harnessRunMarker: null",
    'agentStatus: "idle"',
    "isGenerating: false",
  ]) {
    assert.match(body, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("real settings reset settles every live in-memory capability before state deletion", () => {
  const { useAppStore } = loadTranspiledModuleSync(
    path.join(process.cwd(), "src/store/useAppStore.ts"),
  );
  useAppStore.getState().resetAllSettings();
  const workspace = "/workspace-settings-reset-runtime";
  const activeSessionId = 821;
  const activeSessionKey = `${workspace}:${activeSessionId}`;
  const backgroundSessionKey = `${workspace}:822`;
  seedWorkspaceSession(
    useAppStore,
    workspace,
    activeSessionId,
    "turn-settings-reset-active",
  );
  const calls = [];
  useAppStore.setState({
    runtimeBySessionKey: {
      [backgroundSessionKey]: {
        currentTurnId: "turn-settings-reset-background",
        agentStatus: "running",
        abortController: {
          abort: () => calls.push("background:abort"),
          signal: { aborted: false },
        },
      },
    },
  });
  useAppStore.setState({
    abortController: {
      abort: () => calls.push("active:abort"),
      signal: { aborted: false },
    },
    pendingRunDecisionResolver: (choice) => calls.push(`active:decision:${choice}`),
    pendingReviewResolve: (decision) => calls.push(`active:review:${decision.action}`),
    pendingReviewTaskId: 41,
    activeActionRequest: {
      schemaVersion: 1,
      requestId: "request-settings-reset",
      kind: "tool_permission",
      sessionKey: activeSessionKey,
      turnId: "turn-settings-reset-active",
      runId: "run-settings-reset-active",
      title: "Reset pending review",
      status: "pending",
      createdAt: 1,
      taskId: 41,
      toolName: "run_command",
      target: "npm test",
    },
    pendingToolCall: { name: "run_command", arguments: { command: "npm test" } },
    pendingSlashCommand: {
      command: "/test",
      raw: "/test",
      source: "composer",
    },
  });
  const beforeReset = useAppStore.getState();
  assert.deepEqual(
    Object.keys(beforeReset.runtimeBySessionKey).sort(),
    [activeSessionKey, backgroundSessionKey].sort(),
  );
  assert.equal(
    typeof beforeReset.runtimeBySessionKey[backgroundSessionKey].abortController.abort,
    "function",
  );

  useAppStore.getState().resetAllSettings();

  assert.deepEqual(calls, [
    "active:abort",
    "active:decision:cancel",
    "active:review:reject",
    "background:abort",
  ]);
  const state = useAppStore.getState();
  assert.deepEqual(state.sessionsByWorkspace, {});
  assert.deepEqual(state.runtimeBySessionKey, {});
  assert.equal(state.abortController, null);
  assert.equal(state.pendingRunDecisionResolver, null);
  assert.equal(state.pendingReviewResolve, null);
  assert.equal(state.activeActionRequest, null);
  assert.equal(state.pendingToolCall, null);
  assert.equal(state.pendingSlashCommand, null);
  assert.equal(state.harnessRunMarker, null);
  assert.equal(state.agentStatus, "idle");
  assert.equal(state.isGenerating, false);
});
