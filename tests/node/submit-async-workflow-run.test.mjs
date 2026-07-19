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
  finalizeSubmitBootstrapFailure,
  runSubmitAsyncWorkflowRun,
  startSubmitAsyncWorkflowRun,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitAsyncWorkflowRun.ts"),
);

function executionTurn(overrides = {}) {
  return {
    id: "turn-1",
    userPrompt: "继续",
    title: "继续",
    mode: "edit",
    intent: "execute",
    status: "executing",
    summary: "",
    blockIds: [],
    collapsed: false,
    createdAt: 1,
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const calls = [];
  const runtimeOwnerToken = {};
  let now = 1000;
  const state = {
    activeStudioAgentKey: "coder",
    gameStudioInitialized: false,
    isPlanApproved: false,
    planStage: "idle",
    planArtifacts: [],
    agentMessages: [],
    taskFlow: [],
    conversationTurns: [executionTurn()],
    runtimeEvents: [],
    harnessRunMarker: null,
    agentStatus: "running",
    isGenerating: true,
    config: { sessionRecordingEnabled: true, reasoningDisplay: "shown" },
    startGoal: (objective, options) => calls.push(["goal", objective, options]),
    bumpWorkspaceContentVersion: () => calls.push(["bump_workspace"]),
    ...overrides.state,
  };
  const sessionSet = (patchOrUpdater) => {
    const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(state) : patchOrUpdater;
    Object.assign(state, patch);
    if (
      patch &&
      Object.keys(patch).length === 2 &&
      Object.hasOwn(patch, "contextMentions") &&
      Object.hasOwn(patch, "attachedFiles")
    ) {
      calls.push(["clear_context", patch]);
    } else {
      calls.push(["session_set", patch]);
    }
  };
  const runtimeService = {
    ensureInitialized: async () => ({ activeStudioAgent: "coder" }),
    configureEngine: async () => ({ activeStudioAgent: "coder" }),
    loadConfig: async () => null,
    buildTurnEnvelope: () => "[studio envelope]",
  };
  const abortController = new AbortController();
  const baseInput = {
    text: "继续",
    turnId: "turn-1",
    uiDisplayTurnId: "turn-1",
    currentImages: [],
    mentionSnapshot: ["src/App.tsx"],
    attachedFilesSnapshot: ["/tmp/a.txt"],
    runSessionKey: "workspace::7",
    runWorkspace: "/tmp/workspace",
    runSessionId: 7,
    runScopeKey: "/tmp/workspace",
    currentMainModeKey: "main_mode",
    parsedSetupEngineCommand: null,
    parsedStudioCommand: null,
    cachedWorkspaceTreeForGameDetection: "",
    preferredLanguage: "zh",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    goalCreationAuthorization: null,
    goalContinuationAuthorization: null,
    activateGoalContinuation: (input) => {
      calls.push(["activate_goal_continuation", input]);
      return true;
    },
    effectiveWorkflowMode: "edit",
    effectiveCommandDirective: { kind: "file_modify", source: "natural_language" },
    effectiveIntentSummary: "执行：继续",
    preservePlanState: false,
    shouldContinuePlanIntent: false,
    shouldContinuePreviousTurnIntent: true,
    shouldExecuteOnceFromReplyOption: true,
    currentTurn: {
      id: "current-turn",
      userPrompt: "原始请求",
      pendingOperationProposal: { proposalSummary: "current proposal" },
    },
    previousTurnContinuationTarget: {
      id: "previous-turn",
      userPrompt: "上一轮请求",
      status: "stopped_no_action",
      pendingOperationProposal: { proposalSummary: "previous proposal" },
    },
    existingTurn: {
      id: "turn-1",
      pendingOperationProposal: { proposalSummary: "existing proposal" },
    },
    selectedChoiceText: "执行一次",
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: ["src/App.tsx"],
      attachedFilePaths: ["/tmp/a.txt"],
    },
    remoteFeishu: undefined,
    options: { executionConsentGranted: true },
    isHidden: false,
    createVisibleTurnForHiddenMessage: false,
    nextTaskId: (() => {
      let id = 10;
      return () => ++id;
    })(),
    sessionGet: () => state,
    sessionSet,
    getSessionRuntimeOwnerToken: () => runtimeOwnerToken,
    hasSessionRuntimeOwnership: (expectedOwnerToken = runtimeOwnerToken) =>
      expectedOwnerToken === runtimeOwnerToken,
    getSessionRevisionToken: () => state,
    elapsedTimer: {
      timerInterval: 123,
      getElapsedSeconds: () => 4,
      dispose: () => calls.push(["dispose_timer"]),
    },
    markUserContextItemFailed: (target) => calls.push(["context_failed", target]),
    ingestAttachmentFile: async () => {
      throw new Error("unexpected ingest");
    },
    readFile: async () => {
      throw new Error("unexpected readFile");
    },
    readDocument: async () => {
      throw new Error("unexpected readDocument");
    },
    analyzeTabularDocument: async () => {
      throw new Error("unexpected analyzeTabularDocument");
    },
    runtimeService,
    logWarning: (event, data) => calls.push(["warning", event, data]),
    invalidateWorkspaceTreeCache: () => calls.push(["invalidate_tree"]),
    createAbortController: () => abortController,
    getCurrentHarnessInstanceId: () => "instance-1",
    readHarnessRunMarker: () => null,
    acquireHarnessRunMarker: (marker) => ({ ...marker, persisted: true }),
    persistHarnessRunMarkerIfOwned: (marker) => ({ ...marker, persisted: true }),
    getWorkspaceTree: async (workspace) => {
      calls.push(["workspace_tree", workspace]);
      return "[D] src";
    },
    nowMs: () => {
      now += 25;
      return now;
    },
    sendStartedAt: 900,
    getLastTurnToolSummary: (turnId) => `tool:${turnId}`,
    getLastVisibleTurnAgentSummary: (turnId) => `assistant:${turnId}`,
    persistBootstrapProjection: async (projectedState) => {
      calls.push(["persist_bootstrap"]);
      return projectedState;
    },
    publishOwnerScopedRuntimeProjection: ({ durableState, projectedState }) => {
      const publishable = durableState || projectedState;
      Object.assign(state, publishable);
      calls.push(["session_set", publishable]);
      return { published: true, disposition: "published" };
    },
    PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: 12,
    PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: 1000,
    PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: 3,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    sanitizeAgentMessagesForPersist: (messages) => messages,
    normalizeSessionRuntimeSnapshot: (snapshot) => snapshot,
    normalizeProviderCompatibilityByRuntimeKey: (value) => value || {},
    compactCompletedTurnAgentMessages: (params) => params.agentMessages,
    normalizeQueuedUserMessage: (value) => value || null,
    startApprovedPlanExecutionInCurrentTurn: () => calls.push(["approved_plan_same_turn"]),
    logStoreEvent: (event, data) => calls.push(["log", event, data]),
    ...overrides.input,
  };

  return {
    calls,
    state,
    input: baseInput,
  };
}

test("submit async workflow run keeps stage order from context build to engine launch", async () => {
  const harness = createHarness({
    input: {
      phaseRunners: {
        buildAttachmentContext: async (input) => {
          harness.calls.push(["attachment", input.text, input.mentions, input.files]);
          return { userContent: "attachment content", attachmentRefs: [], failedAttachmentCount: 0 };
        },
        buildPromptContext: (input) => {
          harness.calls.push([
            "prompt",
            input.userContent,
            input.previousTurnLastToolSummary,
            input.previousTurnLastAssistantSummary,
            input.approvedProposal?.proposalSummary,
            input.latestAssistantSummary,
          ]);
          return { userContent: "prompt content" };
        },
        runGameStudioPreparation: async (input) => {
          harness.calls.push(["studio", input.userContent, input.activeStudioAgentKey, input.gameStudioInitialized]);
          return {
            ok: true,
            userContent: "studio content",
            activeStudioAgentKey: "coder",
            gameStudioInitialized: true,
            gameStudioConfigForTurn: { activeStudioAgent: "coder", engine: "unity" },
          };
        },
        startRunLease: (input) => {
          harness.calls.push(["lease", input.userContent, input.runSessionKey]);
          return {
            turnAgentMessagesStart: 2,
            agentUserMessage: { role: "user", content: input.userContent },
            abortController: new AbortController(),
            harnessRunMarker: { id: "marker-1" },
          };
        },
        createWorkflowContext: (input) => {
          harness.calls.push([
            "context",
            input.workspaceTree,
            input.gameStudioConfigForTurn?.engine,
            input.turnAgentMessagesStart,
          ]);
          return {
            ...input,
            streamBuffer: null,
            thinkingInterceptor: null,
            agentBlockIdsCreatedThisRun: new Set(),
          };
        },
        startStreamingUi: (input) => {
          harness.calls.push(["streaming", input.context.turnId, input.effectiveIntentSummary]);
        },
        runWorkflowEngine: (input) => {
          harness.calls.push(["engine", input.context.turnId]);
          return Promise.resolve(true);
        },
      },
    },
  });

  await runSubmitAsyncWorkflowRun(harness.input);

  assert.deepEqual(
    harness.calls.map((entry) => entry[0]),
    [
      "attachment",
      "prompt",
      "studio",
      "clear_context",
      "workspace_tree",
      "log",
      "lease",
      "context",
      "streaming",
      "engine",
    ],
  );
  assert.deepEqual(harness.calls[1], [
    "prompt",
    "attachment content",
    "tool:previous-turn",
    "assistant:previous-turn",
    "existing proposal",
    "assistant:turn-1",
  ]);
  assert.equal(harness.calls[5][1], "workspace_tree_ready");
  assert.equal(harness.calls[7][1], "[D] src");
});

test("submit async workflow run stops before launch when Game Studio preparation fails", async () => {
  const harness = createHarness({
    input: {
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "attachment content",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "prompt content" }),
        runGameStudioPreparation: async () => ({
          ok: false,
          userContent: "prompt content",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: false,
          gameStudioConfigForTurn: null,
          errorMessage: "failed",
        }),
        startRunLease: () => {
          throw new Error("should not start lease");
        },
        runWorkflowEngine: () => {
          throw new Error("should not start engine");
        },
      },
    },
  });

  await runSubmitAsyncWorkflowRun(harness.input);

  assert.equal(harness.calls.some((entry) => entry[0] === "clear_context"), false);
  assert.equal(harness.calls.some((entry) => entry[0] === "workspace_tree"), false);
  assert.equal(harness.calls.some((entry) => entry[0] === "engine"), false);
  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.status, "completed");
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.resultKind, "error");
  assert.match(harness.state.conversationTurns[0].summary, /failed/);
  assert.deepEqual(harness.state.runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(harness.state.runtimeEvents.at(-2).resultKind, "error");
  assert.equal(harness.state.runtimeEvents.at(-1).resultKind, "error");
  assert.equal(
    harness.state.taskFlow.filter((block) => block.visibility === "assistant_final").length,
    1,
  );
});

test("Goal continuation becomes active only after its exact Run lease is acquired", async () => {
  const authorization = {
    kind: "goal_continuation_authorization",
    source: "goal_manual_resume",
    workspaceKey: "/tmp/workspace",
    sessionKey: "workspace::7",
    goalId: "goal-1",
    goalRevision: 2,
    ownerTurnId: "turn-old",
  };
  const harness = createHarness({
    input: {
      effectiveRunIntent: "goal",
      runtimeRunIntent: "goal",
      goalContinuationAuthorization: authorization,
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "resume",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "resume" }),
        runGameStudioPreparation: async () => ({
          ok: true,
          userContent: "resume",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: false,
          gameStudioConfigForTurn: null,
        }),
        startRunLease: () => {
          harness.calls.push(["exact_resume_lease"]);
          return {
            turnAgentMessagesStart: 0,
            agentUserMessage: { role: "user", content: "resume" },
            abortController: new AbortController(),
            harnessRunMarker: {
              runId: "run-resume",
              parentRunId: "run-old",
              instanceId: "instance-1",
              startedAt: 100,
            },
            runId: "run-resume",
            parentRunId: "run-old",
          };
        },
        createWorkflowContext: (input) => {
          harness.calls.push(["resume_context"]);
          return {
            ...input,
            streamBuffer: null,
            thinkingInterceptor: null,
            agentBlockIdsCreatedThisRun: new Set(),
          };
        },
        startStreamingUi: () => {},
        runWorkflowEngine: () => Promise.resolve(true),
      },
    },
  });

  await runSubmitAsyncWorkflowRun(harness.input);

  const ordered = harness.calls.map((entry) => entry[0]);
  assert.ok(ordered.indexOf("exact_resume_lease") < ordered.indexOf("activate_goal_continuation"));
  assert.ok(ordered.indexOf("activate_goal_continuation") < ordered.indexOf("resume_context"));
  const activation = harness.calls.find(
    (entry) => entry[0] === "activate_goal_continuation",
  )?.[1];
  assert.equal(activation.authorization, authorization);
  assert.equal(activation.ownerTurnId, "turn-1");
  assert.equal(Number.isFinite(activation.timestampMs), true);
});

test("submit async workflow run awaits the workflow engine terminal transaction", async () => {
  let releaseEngine;
  let settled = false;
  const harness = createHarness({
    input: {
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "attachment content",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "prompt content" }),
        runGameStudioPreparation: async () => ({
          ok: true,
          userContent: "studio content",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: true,
          gameStudioConfigForTurn: null,
        }),
        startRunLease: () => ({
          turnAgentMessagesStart: 0,
          agentUserMessage: { role: "user", content: "studio content" },
          abortController: new AbortController(),
          harnessRunMarker: { runId: "run-1" },
        }),
        createWorkflowContext: (input) => ({
          ...input,
          streamBuffer: null,
          thinkingInterceptor: null,
          agentBlockIdsCreatedThisRun: new Set(),
        }),
        startStreamingUi: () => {},
        runWorkflowEngine: () => new Promise((resolve) => {
          releaseEngine = resolve;
        }),
      },
    },
  });

  const run = runSubmitAsyncWorkflowRun(harness.input).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseEngine(true);
  await run;
  assert.equal(settled, true);
});

test("a Turn canceled during bootstrap cannot acquire a run lease or start tools", async () => {
  let releaseWorkspaceTree;
  let workspaceTreeStarted;
  const workspaceTreeStartedGate = new Promise((resolve) => {
    workspaceTreeStarted = resolve;
  });
  const workspaceTreeGate = new Promise((resolve) => {
    releaseWorkspaceTree = resolve;
  });
  let abortControllerCreations = 0;
  let leaseStarts = 0;
  let engineStarts = 0;
  const harness = createHarness({
    input: {
      runIdOverride: "run-bootstrap-canceled",
      createAbortController: () => {
        abortControllerCreations += 1;
        return new AbortController();
      },
      getWorkspaceTree: async () => {
        workspaceTreeStarted();
        await workspaceTreeGate;
        return "[D] src";
      },
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "attachment content",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "prompt content" }),
        runGameStudioPreparation: async () => ({
          ok: true,
          userContent: "studio content",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: true,
          gameStudioConfigForTurn: null,
        }),
        startRunLease: (input) => {
          leaseStarts += 1;
          input.createAbortController();
          throw new Error("terminal Turn must not acquire a run lease");
        },
        createWorkflowContext: () => {
          throw new Error("terminal Turn must not create workflow context");
        },
        startStreamingUi: () => {
          throw new Error("terminal Turn must not start streaming UI");
        },
        runWorkflowEngine: () => {
          engineStarts += 1;
          throw new Error("terminal Turn must not start tools");
        },
      },
    },
  });

  const run = runSubmitAsyncWorkflowRun(harness.input);
  await workspaceTreeStartedGate;
  harness.state.runtimeEvents.push({
    schemaVersion: 2,
    type: "turn.completed",
    threadId: "workspace::7",
    turnId: "turn-1",
    timestampMs: 1_050,
    resultKind: "canceled",
  });
  harness.state.conversationTurns[0] = executionTurn({
    status: "done",
    runtimeOutcome: {
      status: "aborted",
      reason: "user_canceled",
      resultKind: "canceled",
      runId: "run-cancel",
      parentRunId: null,
      updatedAt: 1_050,
    },
  });
  harness.state.agentStatus = "idle";
  harness.state.isGenerating = false;
  releaseWorkspaceTree();

  await run;

  assert.equal(abortControllerCreations, 0);
  assert.equal(leaseStarts, 0);
  assert.equal(engineStarts, 0);
  assert.equal(harness.state.harnessRunMarker, null);
  assert.deepEqual(harness.state.runtimeEvents.map((event) => event.type), ["turn.completed"]);
  assert.equal(
    harness.calls.filter((entry) => entry[0] === "dispose_timer").length,
    1,
  );
  const skipLog = harness.calls.find((entry) =>
    entry[0] === "log" && entry[1] === "submit_bootstrap_skipped_terminal_turn"
  );
  assert.equal(skipLog?.[2]?.terminalResultKind, "canceled");
});

test("bulk clear invalidates a deferred bootstrap before lease, marker, engine, or tools", async () => {
  const oldRuntimeOwner = {};
  const newRuntimeOwner = {};
  const runtimeOwners = new Map([["workspace::7", oldRuntimeOwner]]);
  const oldMarker = {
    runId: "run-before-clear",
    sessionKey: "workspace::7",
    turnId: "turn-before-clear",
    instanceId: "instance-old",
    startedAt: 100,
    status: "running",
  };
  const newSessionMarker = {
    runId: "run-after-clear",
    sessionKey: "workspace::8",
    turnId: "turn-after-clear",
    instanceId: "instance-new",
    startedAt: 200,
    status: "running",
  };
  let globalMarker = oldMarker;
  let releaseWorkspaceTree;
  let workspaceTreeStarted;
  const workspaceTreeStartedGate = new Promise((resolve) => {
    workspaceTreeStarted = resolve;
  });
  const workspaceTreeGate = new Promise((resolve) => {
    releaseWorkspaceTree = resolve;
  });
  let markerAcquisitionAttempts = 0;
  let abortControllerCreations = 0;
  let engineStarts = 0;
  let toolStarts = 0;
  const harness = createHarness({
    input: {
      runIdOverride: "run-stale-bootstrap",
      getSessionRuntimeOwnerToken: () => oldRuntimeOwner,
      hasSessionRuntimeOwnership: (expectedOwner) =>
        expectedOwner === oldRuntimeOwner &&
        runtimeOwners.get("workspace::7") === oldRuntimeOwner,
      readHarnessRunMarker: () => globalMarker,
      acquireHarnessRunMarker: (marker, expectedCurrent) => {
        markerAcquisitionAttempts += 1;
        if (globalMarker !== expectedCurrent) return null;
        globalMarker = marker;
        return marker;
      },
      createAbortController: () => {
        abortControllerCreations += 1;
        return new AbortController();
      },
      getWorkspaceTree: async () => {
        workspaceTreeStarted();
        await workspaceTreeGate;
        return "[D] src";
      },
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "attachment content",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "prompt content" }),
        runGameStudioPreparation: async () => ({
          ok: true,
          userContent: "studio content",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: true,
          gameStudioConfigForTurn: null,
        }),
        runWorkflowEngine: () => {
          engineStarts += 1;
          toolStarts += 1;
          return Promise.resolve(true);
        },
      },
    },
  });

  const run = runSubmitAsyncWorkflowRun(harness.input);
  await workspaceTreeStartedGate;

  // Workspace bulk clear removes the old key. A newly created Session then
  // acquires the global marker before the old discovery promise resolves.
  runtimeOwners.delete("workspace::7");
  runtimeOwners.set("workspace::8", newRuntimeOwner);
  globalMarker = newSessionMarker;
  releaseWorkspaceTree();
  await run;

  assert.equal(markerAcquisitionAttempts, 0);
  assert.equal(abortControllerCreations, 0);
  assert.equal(engineStarts, 0);
  assert.equal(toolStarts, 0);
  assert.equal(globalMarker, newSessionMarker);
  assert.equal(harness.state.harnessRunMarker, null);
  assert.equal(harness.state.taskFlow.length, 0);
  assert.equal(harness.calls.some((entry) =>
    entry[0] === "log" && entry[1] === "submit_bootstrap_skipped_stale_session_owner"
  ), true);
});

test("bootstrap failures produce one visible error conclusion and close the turn", async () => {
  const harness = createHarness({
    input: {
      getWorkspaceTree: async () => {
        throw new Error("workspace unavailable");
      },
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "attachment content",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "prompt content" }),
        runGameStudioPreparation: async () => ({
          ok: true,
          userContent: "studio content",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: true,
          gameStudioConfigForTurn: null,
        }),
        startRunLease: () => {
          throw new Error("lease must not start before workspace discovery");
        },
      },
    },
  });

  await startSubmitAsyncWorkflowRun(harness.input);

  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.match(harness.state.conversationTurns[0].summary, /workspace unavailable/);
  assert.equal(
    harness.state.taskFlow.filter((block) => block.visibility === "assistant_final").length,
    1,
  );
  assert.equal(harness.state.runtimeEvents.at(-1).type, "turn.completed");
  assert.equal(harness.state.runtimeEvents.at(-1).resultKind, "error");
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.status, "completed");
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.resultKind, "error");
  assert.equal(harness.state.agentStatus, "idle");
  assert.equal(harness.state.isGenerating, false);
});

test("a post-lease bootstrap exception durably closes only the acquired owner", async () => {
  const harness = createHarness({
    input: {
      runIdOverride: "run-submit-1",
      persistHarnessRunMarkerIfOwned: (marker) => {
        harness.calls.push(["persist_marker", marker.status, marker.runId]);
        return { ...marker, persisted: true };
      },
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "attachment content",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "prompt content" }),
        runGameStudioPreparation: async () => ({
          ok: true,
          userContent: "studio content",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: true,
          gameStudioConfigForTurn: null,
        }),
        startRunLease: (input) => {
          const marker = {
            schemaVersion: 1,
            runId: "run-submit-1",
            activeRunId: "run-submit-1",
            activeParentRunId: "run-parent",
            parentRunId: "run-parent",
            instanceId: "instance-1",
            sessionKey: "workspace::7",
            workspace: "/tmp/workspace",
            sessionId: 7,
            turnId: "turn-1",
            status: "running",
            startedAt: 1_100,
            updatedAt: 1_100,
            closedAt: null,
            closeReason: null,
          };
          input.setHarnessRunMarker(marker);
          return {
            runId: "run-submit-1",
            parentRunId: "run-parent",
            turnAgentMessagesStart: 0,
            agentUserMessage: { role: "user", content: "studio content" },
            abortController: new AbortController(),
            harnessRunMarker: marker,
          };
        },
        createWorkflowContext: () => {
          throw new Error("context construction failed");
        },
        runWorkflowEngine: () => {
          throw new Error("engine must not start");
        },
      },
    },
  });

  await runSubmitAsyncWorkflowRun(harness.input);

  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.deepEqual(harness.state.conversationTurns[0].runtimeOutcome, {
    status: "completed",
    reason: "context construction failed",
    resultKind: "error",
    runId: "run-submit-1",
    parentRunId: "run-parent",
    updatedAt: 1075,
  });
  assert.equal(harness.state.harnessRunMarker.runId, "run-submit-1");
  assert.equal(harness.state.harnessRunMarker.status, "completed");
  assert.equal(harness.state.harnessRunMarker.closeReason, "submit_bootstrap_error");
  assert.equal(harness.state.harnessRunMarker.persisted, true);
  assert.equal(harness.state.runtimeEvents.at(-2).runId, "run-submit-1");
  assert.equal(harness.state.runtimeEvents.at(-2).parentRunId, "run-parent");

  const durableIndex = harness.calls.findIndex((entry) => entry[0] === "persist_bootstrap");
  const markerIndex = harness.calls.findIndex((entry) => entry[0] === "persist_marker" && entry[1] === "completed");
  const publishIndex = harness.calls.findIndex((entry, index) =>
    index > markerIndex &&
    entry[0] === "session_set" &&
    entry[1]?.conversationTurns?.[0]?.status === "done"
  );
  assert.ok(durableIndex >= 0);
  assert.ok(markerIndex > durableIndex);
  assert.ok(publishIndex > markerIndex);
});

test("a deferred bootstrap finalizer cannot overwrite a newer global Harness owner from another Session", async () => {
  const oldMarker = {
    schemaVersion: 1,
    runId: "run-old-session",
    activeRunId: "run-old-session",
    activeParentRunId: null,
    parentRunId: null,
    instanceId: "instance-old",
    sessionKey: "workspace::7",
    workspace: "/tmp/workspace",
    sessionId: 7,
    turnId: "turn-1",
    status: "running",
    startedAt: 1_100,
    updatedAt: 1_100,
    closedAt: null,
    closeReason: null,
  };
  const newerMarker = {
    ...oldMarker,
    runId: "run-new-session",
    activeRunId: "run-new-session",
    instanceId: "instance-new",
    sessionKey: "workspace::8",
    sessionId: 8,
    turnId: "turn-new",
    startedAt: 2_200,
    updatedAt: 2_200,
  };
  let globalMarker = oldMarker;
  let signalPersistenceStarted;
  const persistenceStarted = new Promise((resolve) => {
    signalPersistenceStarted = resolve;
  });
  let releasePersistence;
  const persistenceGate = new Promise((resolve) => {
    releasePersistence = resolve;
  });
  const harness = createHarness({
    state: { harnessRunMarker: oldMarker },
    input: {
      persistHarnessRunMarker: () => {
        assert.fail("bootstrap finalization must not use unconditional global marker persistence");
      },
      persistHarnessRunMarkerIfOwned: (marker, expectedOwner) => {
        harness.calls.push(["marker_cas", expectedOwner]);
        const ownsCurrent = globalMarker.status === "running" &&
          globalMarker.runId === expectedOwner.runId &&
          globalMarker.sessionKey === expectedOwner.sessionKey &&
          globalMarker.turnId === expectedOwner.turnId &&
          globalMarker.instanceId === expectedOwner.instanceId &&
          globalMarker.startedAt === expectedOwner.startedAt;
        if (!ownsCurrent) return null;
        globalMarker = { ...marker, persisted: true };
        return globalMarker;
      },
      persistBootstrapProjection: async (projectedState) => {
        harness.calls.push(["persist_bootstrap"]);
        signalPersistenceStarted();
        await persistenceGate;
        return projectedState;
      },
    },
  });

  const finalization = finalizeSubmitBootstrapFailure(
    harness.input,
    new Error("old Session bootstrap failed"),
    {
      submissionRunId: "run-old-session",
      parentRunId: null,
      acquired: {
        harnessRunId: "run-old-session",
        runId: "run-old-session",
        parentRunId: null,
        instanceId: "instance-old",
        startedAt: 1_100,
      },
    },
  );
  await persistenceStarted;
  globalMarker = newerMarker;
  releasePersistence();
  await finalization;

  assert.equal(globalMarker, newerMarker);
  assert.equal(harness.state.harnessRunMarker.status, "completed");
  assert.equal(harness.state.harnessRunMarker.runId, "run-old-session");
  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.resultKind, "error");
  assert.equal(harness.state.runtimeEvents.at(-1).type, "turn.completed");
  assert.deepEqual(
    harness.calls.find((entry) => entry[0] === "marker_cas")?.[1],
    {
      runId: "run-old-session",
      sessionKey: "workspace::7",
      turnId: "turn-1",
      instanceId: "instance-old",
      startedAt: 1_100,
    },
  );
  assert.equal(harness.calls.some((entry) =>
    entry[0] === "log" && entry[1] === "submit_bootstrap_harness_close_owner_lost"
  ), true);
});

test("a stale bootstrap owner cannot close a newer run on the same turn", async () => {
  const newerMarker = {
    schemaVersion: 1,
    runId: "run-new",
    activeRunId: "run-new",
    activeParentRunId: null,
    parentRunId: null,
    instanceId: "instance-new",
    sessionKey: "workspace::7",
    workspace: "/tmp/workspace",
    sessionId: 7,
    turnId: "turn-1",
    status: "running",
    startedAt: 2_000,
    updatedAt: 2_000,
    closedAt: null,
    closeReason: null,
  };
  const harness = createHarness({ state: { harnessRunMarker: newerMarker } });
  const beforeTurn = { ...harness.state.conversationTurns[0] };

  await finalizeSubmitBootstrapFailure(
    harness.input,
    new Error("late old-run failure"),
    {
      submissionRunId: "run-old",
      parentRunId: null,
      acquired: {
        harnessRunId: "run-old",
        runId: "run-old",
        parentRunId: null,
        instanceId: "instance-old",
        startedAt: 1_000,
      },
    },
  );

  assert.equal(harness.state.harnessRunMarker, newerMarker);
  assert.deepEqual(harness.state.conversationTurns[0], beforeTurn);
  assert.deepEqual(harness.state.runtimeEvents, []);
  assert.equal(harness.calls.some((entry) => entry[0] === "persist_bootstrap"), false);
  assert.equal(harness.calls.some((entry) => entry[0] === "persist_marker"), false);
  assert.equal(
    harness.calls.some((entry) => entry[0] === "log" && entry[1] === "submit_bootstrap_stale_owner_skipped"),
    true,
  );
});

test("closing an old bootstrap turn preserves a newer turn's control plane", async () => {
  const newerAbortController = new AbortController();
  const newerPendingResolve = () => {};
  const newerRequest = {
    sessionKey: "workspace::7",
    turnId: "turn-2",
    runId: "run-new",
  };
  const newerMarker = {
    schemaVersion: 1,
    runId: "run-new",
    activeRunId: "run-new",
    activeParentRunId: null,
    parentRunId: null,
    instanceId: "instance-new",
    sessionKey: "workspace::7",
    workspace: "/tmp/workspace",
    sessionId: 7,
    turnId: "turn-2",
    status: "running",
    startedAt: 2_000,
    updatedAt: 2_000,
    closedAt: null,
    closeReason: null,
  };
  const harness = createHarness({
    state: {
      conversationTurns: [
        executionTurn(),
        executionTurn({ id: "turn-2", title: "New turn" }),
      ],
      harnessRunMarker: newerMarker,
      activeActionRequest: newerRequest,
      abortController: newerAbortController,
      pendingReviewResolve: newerPendingResolve,
      pendingReviewTaskId: 22,
      pendingToolCall: { id: "tool-new" },
    },
  });

  await finalizeSubmitBootstrapFailure(
    harness.input,
    new Error("old bootstrap failed"),
    {
      submissionRunId: "run-old",
      parentRunId: null,
      acquired: null,
    },
  );

  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.equal(harness.state.conversationTurns[1].status, "executing");
  assert.equal(harness.state.harnessRunMarker, newerMarker);
  assert.equal(harness.state.activeActionRequest, newerRequest);
  assert.equal(harness.state.agentStatus, "running");
  assert.equal(harness.state.isGenerating, true);
  assert.equal(harness.state.abortController, newerAbortController);
  assert.equal(harness.state.pendingReviewResolve, newerPendingResolve);
  assert.equal(harness.state.pendingReviewTaskId, 22);
  assert.deepEqual(harness.state.pendingToolCall, { id: "tool-new" });
  assert.equal(harness.state.runtimeEvents.at(-2).runId, "run-old");
  assert.equal(harness.state.runtimeEvents.at(-1).resultKind, "error");
});

test("bootstrap conclusion is not published before durable persistence resolves", async () => {
  let releasePersistence;
  const persistenceGate = new Promise((resolve) => {
    releasePersistence = resolve;
  });
  const harness = createHarness({
    input: {
      getWorkspaceTree: async () => {
        throw new Error("workspace unavailable");
      },
      persistBootstrapProjection: async (projectedState) => {
        harness.calls.push(["persist_bootstrap"]);
        await persistenceGate;
        return projectedState;
      },
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "attachment content",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "prompt content" }),
        runGameStudioPreparation: async () => ({
          ok: true,
          userContent: "studio content",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: true,
          gameStudioConfigForTurn: null,
        }),
      },
    },
  });

  const run = runSubmitAsyncWorkflowRun(harness.input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.state.conversationTurns[0].status, "executing");
  assert.equal(harness.state.taskFlow.length, 0);
  assert.deepEqual(harness.state.runtimeEvents, []);

  releasePersistence();
  await run;
  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.equal(harness.state.taskFlow.at(-1).visibility, "assistant_final");
  assert.equal(harness.state.runtimeEvents.at(-1).type, "turn.completed");
});

test("retry exhaustion falls back to an atomic in-memory conclusion instead of abandoning the Turn", async () => {
  let revision = 0;
  const harness = createHarness({
    input: {
      getSessionRevisionToken: () => revision,
      getWorkspaceTree: async () => {
        throw new Error("continuously changing bootstrap state");
      },
      persistBootstrapProjection: async (projectedState) => {
        harness.calls.push(["persist_bootstrap"]);
        revision += 1;
        return projectedState;
      },
      phaseRunners: {
        buildAttachmentContext: async () => ({
          userContent: "attachment content",
          attachmentRefs: [],
          failedAttachmentCount: 0,
        }),
        buildPromptContext: () => ({ userContent: "prompt content" }),
        runGameStudioPreparation: async () => ({
          ok: true,
          userContent: "studio content",
          activeStudioAgentKey: "coder",
          gameStudioInitialized: true,
          gameStudioConfigForTurn: null,
        }),
      },
    },
  });

  await runSubmitAsyncWorkflowRun(harness.input);

  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.resultKind, "error");
  assert.equal(harness.state.runtimeEvents.at(-1).type, "turn.completed");
  assert.equal(harness.state.taskFlow.filter((block) =>
    block.turnId === "turn-1" && block.visibility === "assistant_final"
  ).length, 1);
  assert.equal(harness.calls.filter((entry) => entry[0] === "persist_bootstrap").length, 4);
  assert.equal(harness.calls.filter((entry) =>
    entry[0] === "log" && entry[1] === "submit_bootstrap_projection_retry"
  ).length, 3);
  assert.equal(harness.calls.some((entry) =>
    entry[0] === "log" && entry[1] === "submit_bootstrap_projection_abandoned_after_concurrent_updates"
  ), false);
  const completionLog = harness.calls.find((entry) =>
    entry[0] === "log" && entry[1] === "submit_bootstrap_completed_with_error"
  );
  assert.equal(completionLog[2].durability, "memory_first_after_retry_exhaustion");
});

test("bootstrap finalization repairs a missing Turn terminal after an error Run terminal", async () => {
  const harness = createHarness({
    state: {
      runtimeEvents: [
        {
          schemaVersion: 2,
          type: "run.started",
          threadId: "workspace::7",
          turnId: "turn-1",
          timestampMs: 10,
          runId: "run-error",
          parentRunId: null,
        },
        {
          schemaVersion: 2,
          type: "run.completed",
          threadId: "workspace::7",
          turnId: "turn-1",
          timestampMs: 11,
          runId: "run-error",
          parentRunId: null,
          resultKind: "error",
          summary: "Bootstrap failed",
        },
      ],
    },
  });

  await finalizeSubmitBootstrapFailure(
    harness.input,
    new Error("repair missing Turn terminal"),
    {
      submissionRunId: "run-error",
      parentRunId: null,
      acquired: null,
    },
  );

  assert.equal(harness.state.runtimeEvents.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(harness.state.runtimeEvents.filter((event) => event.type === "turn.completed").length, 1);
  assert.equal(harness.state.conversationTurns[0].status, "done");
  assert.equal(harness.state.conversationTurns[0].runtimeOutcome.resultKind, "error");
  assert.equal(harness.calls.some((entry) =>
    entry[0] === "log" && entry[1] === "submit_bootstrap_partial_terminal_repair"
  ), true);
});
