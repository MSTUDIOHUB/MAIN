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
  applySubmitGameStudioPreparationResult,
  runSubmitGameStudioPreparation,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitGameStudioPreparation.ts"),
);

function createState(overrides = {}) {
  return {
    taskFlow: [],
    conversationTurns: [
      {
        id: "turn-1",
        status: "executing",
        blockIds: [],
      },
    ],
    gameStudioInitialized: false,
    activeStudioAgentKey: "studio_auto",
    pendingSlashCommand: { type: "workflow", slug: "implement" },
    agentStatus: "running",
    isGenerating: true,
    abortController: {},
    bumpCount: 0,
    bumpWorkspaceContentVersion() {
      this.bumpCount += 1;
    },
    ...overrides,
  };
}

function createHarness(state) {
  return {
    disposed: false,
    invalidated: false,
    nextId: 10,
    sessionGet: () => state,
    sessionSet: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      Object.assign(state, next);
    },
    nextTaskId() {
      return this.nextId++;
    },
    disposeElapsedTimer() {
      this.disposed = true;
    },
    invalidateWorkspaceTreeCache() {
      this.invalidated = true;
    },
  };
}

function studioConfig(overrides = {}) {
  return {
    activeStudioAgent: "unity-specialist",
    engine: "unity",
    engineVersion: null,
    initializedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("submit game studio preparation applies success runtime patch and cache effects", () => {
  const state = createState();
  const harness = createHarness(state);

  const result = applySubmitGameStudioPreparationResult({
    preparation: {
      ok: true,
      userContent: "ENVELOPE",
      activeStudioAgentKey: "unity-specialist",
      gameStudioInitialized: true,
      gameStudioConfigForTurn: studioConfig(),
      shouldInvalidateWorkspaceTree: true,
      shouldBumpWorkspaceContentVersion: true,
      runtimePatch: {
        gameStudioInitialized: true,
        activeStudioAgentKey: "unity-specialist",
      },
    },
    turnId: "turn-1",
    nextTaskId: harness.nextTaskId.bind(harness),
    sessionGet: harness.sessionGet,
    sessionSet: harness.sessionSet,
    disposeElapsedTimer: harness.disposeElapsedTimer.bind(harness),
    invalidateWorkspaceTreeCache: harness.invalidateWorkspaceTreeCache.bind(harness),
  });

  assert.equal(result.ok, true);
  assert.equal(result.userContent, "ENVELOPE");
  assert.equal(state.gameStudioInitialized, true);
  assert.equal(state.activeStudioAgentKey, "unity-specialist");
  assert.equal(harness.invalidated, true);
  assert.equal(state.bumpCount, 1);
  assert.equal(harness.disposed, false);
});

test("submit game studio preparation records failure and stops the run", () => {
  const state = createState();
  const harness = createHarness(state);

  const result = applySubmitGameStudioPreparationResult({
    preparation: {
      ok: false,
      userContent: "fix camera",
      activeStudioAgentKey: "unity-specialist",
      gameStudioInitialized: false,
      gameStudioConfigForTurn: null,
      errorMessage: "Game Studio 初始化失败：offline",
    },
    turnId: "turn-1",
    nextTaskId: harness.nextTaskId.bind(harness),
    sessionGet: harness.sessionGet,
    sessionSet: harness.sessionSet,
    disposeElapsedTimer: harness.disposeElapsedTimer.bind(harness),
    invalidateWorkspaceTreeCache: harness.invalidateWorkspaceTreeCache.bind(harness),
  });

  assert.equal(result.ok, false);
  assert.equal(harness.disposed, true);
  assert.equal(state.taskFlow.length, 1);
  assert.equal(state.taskFlow[0].content, "Game Studio 初始化失败：offline");
  assert.equal(state.conversationTurns[0].status, "error");
  assert.deepEqual(state.conversationTurns[0].blockIds, [10]);
  assert.equal(state.agentStatus, "error");
  assert.equal(state.isGenerating, false);
  assert.equal(state.abortController, null);
  assert.equal(state.pendingSlashCommand, null);
});

test("submit game studio preparation runs preparation and applies envelope result", async () => {
  const state = createState();
  const harness = createHarness(state);
  const runtimeService = {
    async ensureInitialized(activeStudioAgent) {
      return studioConfig({ activeStudioAgent: activeStudioAgent || "studio_auto" });
    },
    async configureEngine() {
      throw new Error("unused");
    },
    async loadConfig() {
      return null;
    },
    buildTurnEnvelope(params) {
      return `ENVELOPE:${params.activeStudioAgent}:${params.originalText}`;
    },
  };

  const result = await runSubmitGameStudioPreparation({
    currentMainModeKey: "game_studio",
    text: "/implement camera",
    userContent: "implement camera",
    parsedSetupEngineCommand: null,
    parsedStudioCommand: { type: "workflow", slug: "implement", args: "camera" },
    activeStudioAgentKey: "unity-specialist",
    gameStudioInitialized: false,
    cachedWorkspaceTreeForGameDetection: "",
    preferredLanguage: "zh",
    runtimeService,
    logWarning() {},
    turnId: "turn-1",
    nextTaskId: harness.nextTaskId.bind(harness),
    sessionGet: harness.sessionGet,
    sessionSet: harness.sessionSet,
    disposeElapsedTimer: harness.disposeElapsedTimer.bind(harness),
    invalidateWorkspaceTreeCache: harness.invalidateWorkspaceTreeCache.bind(harness),
  });

  assert.equal(result.ok, true);
  assert.match(result.userContent, /^ENVELOPE:unity-specialist:implement camera/);
  assert.equal(result.gameStudioInitialized, true);
  assert.equal(harness.invalidated, true);
  assert.equal(state.bumpCount, 1);
});
