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

test("failed clear revalidates a broker-issued exact Goal continuation for the fresh Turn", async () => {
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
