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

const { createGameStudioLocalSlashBridge } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/gameStudioLocalSlashBridge.ts"),
);

function createState(overrides = {}) {
  const updates = [];
  const state = {
    taskFlow: [],
    conversationTurns: [],
    runtimeEvents: [],
    agentMessages: [{ role: "user", content: "hello" }],
    contextMemoryState: { buckets: {} },
    contextMemoryStateByRuntimeKey: {},
    providerCompatibilityByRuntimeKey: {},
    currentTurnId: null,
    selectedMainModeKey: "game_studio",
    selectedNexusModeKey: "game_studio",
    imageStudio: { runtime: {} },
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: true,
    pendingSlashCommand: null,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: null,
    planStage: "idle",
    isPlanApproved: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    selectedDiffTaskId: null,
    autoApproveTools: false,
    autoApproveToolScopes: [],
    webSearchEnabled: false,
    webSearchProvider: "off",
    queuedUserMessage: null,
    activeGuidance: null,
    input: "/help",
    contextMentions: ["README.md"],
    attachedFiles: ["notes.md"],
    lockedComposerIntent: "plan",
    pendingRunDecision: { kind: "intent_confirmation" },
    preferredResponseLanguage: "en",
    isGenerating: true,
    agentStatus: "running",
    elapsedTime: 12,
    harnessRunMarker: null,
    config: {
      sessionRecordingEnabled: true,
      eventStreamMode: "dual",
    },
    updateSession(scopeKey, sessionId, patch) {
      updates.push({ scopeKey, sessionId, patch });
    },
    ...overrides,
  };
  return { state, updates };
}

function createHarness(state) {
  return {
    get: () => state,
    set: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next && typeof next === "object") Object.assign(state, next);
    },
  };
}

function createBridgeInput(state, harness, overrides = {}) {
  let nextId = 10;
  return {
    sessionGet: harness.get,
    sessionSet: harness.set,
    nextTaskId: () => nextId++,
    text: "/help",
    turnId: "turn-1",
    userContextItems: [{ type: "file", path: "README.md", label: "README.md", status: "ready" }],
    isHidden: false,
    reuseCurrentTurn: false,
    parentPlanTurnId: null,
    preferredLanguage: "zh",
    effectiveRunIntent: "studio_workflow",
    effectiveDisplayIntent: "studio_workflow",
    effectiveIntentSummary: "Game Studio help",
    effectiveCommandDirective: { kind: "studio_workflow", source: "studio_slash" },
    effectiveWorkflowMode: "edit",
    turnTitle: "Game Studio help",
    shouldSeedSessionTitleForTurn: true,
    ensuredSessionId: 7,
    sessionScopeKey: "/repo",
    titleIntentSignature: "sig-help",
    sanitizeTaskBlocksForPersist: (blocks) => blocks.map((block) => ({ ...block, persisted: true })),
    normalizeSessionRuntimeSnapshot: (snapshot) => ({ normalized: true, snapshot }),
    ...overrides,
  };
}

test("game studio local slash bridge appends visible local turn and persists session snapshot", async () => {
  const { state, updates } = createState();
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness));

  const result = await bridge.appendLocalStudioTurn("# Help", {
    systemVariant: "game_studio_local_markdown",
  });

  assert.equal(result.disposition, "appended");
  assert.equal(result.adoptionDecision.kind, "not_requested");
  assert.equal(result.userBlockId, 10);
  assert.equal(result.conclusionBlockId, 11);
  assert.equal(state.taskFlow.length, 2);
  assert.equal(state.taskFlow[0].type, "user");
  assert.equal(state.taskFlow[0].id, 10);
  assert.equal(state.taskFlow[0].contextItems[0].path, "README.md");
  assert.equal(state.taskFlow[1].type, "system");
  assert.equal(state.taskFlow[1].id, 11);
  assert.equal(state.taskFlow[1].variant, "game_studio_local_markdown");
  assert.equal(state.conversationTurns.length, 1);
  assert.equal(state.conversationTurns[0].status, "done");
  assert.deepEqual(state.conversationTurns[0].blockIds, [10, 11]);
  assert.equal(state.currentTurnId, "turn-1");
  assert.equal(state.input, "");
  assert.deepEqual(state.contextMentions, []);
  assert.deepEqual(state.attachedFiles, []);
  assert.equal(state.agentStatus, "idle");
  assert.equal(state.isGenerating, false);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].scopeKey, "/repo");
  assert.equal(updates[0].sessionId, 7);
  assert.equal(updates[0].patch.title, "Game Studio help");
  assert.equal(updates[0].patch.titleSource, "local_seed");
  assert.equal(updates[0].patch.messages[0].persisted, true);
  assert.equal(updates[0].patch.runtimeSnapshot.normalized, true);
  assert.equal(updates[0].patch.runtimeSnapshot.snapshot.currentTurnId, "turn-1");
});

test("game studio local slash bridge adopts the exact admitted Turn without duplicating its user block", async () => {
  const admittedUserBlock = {
    id: 41,
    turnId: "turn-1",
    type: "user",
    content: "/help",
    contextItems: [{ type: "file", path: "README.md", label: "README.md", status: "ready" }],
  };
  const admittedTurn = {
    id: "turn-1",
    clientSubmissionId: "submission-1",
    workspaceInstructionReceiptId: "receipt-1",
    workspaceInstructionSource: "slash_command",
    userPrompt: "/help",
    title: "Pending workspace instruction",
    mode: "edit",
    intent: "analyze",
    displayIntent: "analyze",
    status: "planning",
    summary: "",
    blockIds: [41],
    processCollapsed: false,
    collapsed: false,
    createdAt: 100,
  };
  const { state } = createState({
    taskFlow: [admittedUserBlock],
    conversationTurns: [admittedTurn],
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
  }));

  const result = await bridge.appendLocalStudioTurn("# Help", {
    systemVariant: "game_studio_local_markdown",
    terminal: {
      runId: "run-local-slash-turn-1",
      parentRunId: null,
      resultKind: "success",
      reason: "local_slash_completed",
      timestampMs: 222,
    },
  });

  assert.equal(result.disposition, "appended");
  assert.deepEqual(result.adoptionDecision, {
    kind: "adopted",
    turnId: "turn-1",
    userBlockId: 41,
  });
  assert.equal(result.userBlockId, 41);
  assert.equal(result.conclusionBlockId, 10);
  assert.equal(state.taskFlow.filter((block) => block.type === "user").length, 1);
  assert.equal(state.taskFlow[0], admittedUserBlock);
  assert.equal(state.taskFlow[1].type, "system");
  assert.equal(state.taskFlow[1].variant, "game_studio_local_markdown");
  assert.equal(state.conversationTurns.length, 1);
  assert.deepEqual(state.conversationTurns[0].blockIds, [41, 10]);
  assert.equal(state.conversationTurns[0].clientSubmissionId, "submission-1");
  assert.equal(state.conversationTurns[0].status, "done");
  assert.deepEqual(state.conversationTurns[0].runtimeOutcome, {
    status: "completed",
    reason: "local_slash_completed",
    resultKind: "success",
    runId: "run-local-slash-turn-1",
    parentRunId: null,
    updatedAt: 222,
  });
});

test("game studio local slash bridge rejects a non-exact admitted user-block identity without mutation", async () => {
  const { state, updates } = createState({
    taskFlow: [{ id: 41, turnId: "turn-1", type: "user", content: "/help" }],
    conversationTurns: [{
      id: "turn-1",
      userPrompt: "/help",
      title: "Pending workspace instruction",
      mode: "edit",
      status: "planning",
      summary: "",
      blockIds: [41],
      collapsed: false,
      createdAt: 100,
    }],
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    adoptExistingTurn: true,
    admittedUserBlockId: 999,
  }));
  const beforeTaskFlow = state.taskFlow;
  const beforeTurns = state.conversationTurns;

  const result = await bridge.appendLocalStudioTurn("# Help");

  assert.equal(result.disposition, "rejected");
  assert.equal(result.adoptionDecision.reason, "user_block_not_linked");
  assert.equal(state.taskFlow, beforeTaskFlow);
  assert.equal(state.conversationTurns, beforeTurns);
  assert.equal(updates.length, 0);
});

test("game studio local slash bridge writes caught-error conclusions as assistant_final", async () => {
  const { state } = createState({
    taskFlow: [{ id: 41, turnId: "turn-1", type: "user", content: "/auto" }],
    conversationTurns: [{
      id: "turn-1",
      userPrompt: "/auto",
      title: "Pending workspace instruction",
      mode: "edit",
      status: "planning",
      summary: "",
      blockIds: [41],
      collapsed: false,
      createdAt: 100,
    }],
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    text: "/auto",
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
  }));

  const result = await bridge.appendLocalStudioTurn("斜杠命令执行失败：disk unavailable", {
    presentation: "assistant_final",
    terminal: {
      runId: "run-local-slash-turn-1",
      parentRunId: null,
      resultKind: "error",
      reason: "local_slash_error",
    },
  });

  assert.equal(result.disposition, "appended");
  assert.equal(result.presentation, "assistant_final");
  assert.equal(state.taskFlow.at(-1).type, "agent");
  assert.equal(state.taskFlow.at(-1).visibility, "assistant_final");
  assert.equal(state.conversationTurns[0].status, "error");
  assert.equal(state.conversationTurns[0].runtimeOutcome.resultKind, "error");
});

test("game studio local slash bridge skips transcript events in legacy mode", () => {
  const { state } = createState({
    config: {
      sessionRecordingEnabled: true,
      eventStreamMode: "legacy",
    },
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness));

  bridge.emitLocalSlashRuntimeEvent({
    type: "slash.command.started",
    threadId: "/repo:7",
    turnId: "turn-1",
    timestampMs: 123,
    command: "/help",
    executionMode: "local_fast",
  });

  assert.equal(state.runtimeEvents.length, 0);

  bridge.emitLocalSlashRuntimeEvent({
    type: "run.started",
    threadId: "/repo:7",
    turnId: "turn-1",
    timestampMs: 124,
    runId: "run-local-slash-turn-1",
    parentRunId: null,
  });

  assert.equal(state.runtimeEvents.length, 1);
  assert.equal(state.runtimeEvents[0].type, "run.started");
});
