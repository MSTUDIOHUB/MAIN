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

const { runSubmitAsyncWorkflowRun } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitAsyncWorkflowRun.ts"),
);

function createHarness(overrides = {}) {
  const calls = [];
  let now = 1000;
  const state = {
    activeStudioAgentKey: "coder",
    gameStudioInitialized: false,
    isPlanApproved: false,
    planStage: "idle",
    agentMessages: [],
    taskFlow: [],
    conversationTurns: [],
    config: { sessionRecordingEnabled: true, reasoningDisplay: "shown" },
    startGoal: (objective, options) => calls.push(["goal", objective, options]),
    bumpWorkspaceContentVersion: () => calls.push(["bump_workspace"]),
    ...overrides.state,
  };
  const sessionSet = (patchOrUpdater) => {
    const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(state) : patchOrUpdater;
    Object.assign(state, patch);
    if (patch && Object.hasOwn(patch, "contextMentions") && Object.hasOwn(patch, "attachedFiles")) {
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
    persistHarnessRunMarker: (marker) => ({ ...marker, persisted: true }),
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
    PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: 12,
    PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: 1000,
    PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: 3,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    sanitizeAgentMessagesForPersist: (messages) => messages,
    normalizeSessionRuntimeSnapshot: (snapshot) => snapshot,
    normalizeProviderCompatibilityByRuntimeKey: (value) => value || {},
    compactCompletedTurnAgentMessages: (params) => params.agentMessages,
    normalizeQueuedUserMessage: (value) => value || null,
    startApprovedPlanExecutionTurnFromHandoff: () => calls.push(["approved_plan_handoff"]),
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
      "lease",
      "workspace_tree",
      "log",
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
  assert.equal(harness.calls[6][1], "workspace_tree_ready");
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
});
