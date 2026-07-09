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

  await bridge.appendLocalStudioTurn("# Help", {
    systemVariant: "game_studio_local_markdown",
  });

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
});
