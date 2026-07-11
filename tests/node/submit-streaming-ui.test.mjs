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

const { createSubmitWorkflowContext } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitWorkflowContext.ts"),
);
const { startSubmitStreamingUi } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitStreamingUi.ts"),
);

function baseContext(overrides = {}) {
  return createSubmitWorkflowContext({
    turnId: "turn-1",
    uiDisplayTurnId: "turn-ui",
    runWorkspace: "/repo",
    runSessionKey: "/repo:7",
    runSessionId: 7,
    runScopeKey: "/repo",
    phaseLanguage: "zh",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    effectiveCommandDirective: null,
    options: {},
    attachedFilesSnapshot: [],
    mentionSnapshot: [],
    remoteFeishu: undefined,
    workspaceTree: null,
    gameStudioConfigForTurn: null,
    abortCtrl: { signal: { aborted: false } },
    timerInterval: null,
    sendStartedAt: 123,
    turnAgentMessagesStart: 0,
    getElapsedSeconds: () => 1,
    PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: 50,
    PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: 720000,
    PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: 2,
    ...overrides,
  });
}

function createSessionHarness() {
  const state = {
    taskFlow: [],
    conversationTurns: [{ id: "turn-ui", blockIds: [] }],
    runtimeEvents: [],
    config: {
      reasoningDisplay: "shown",
      workflowMode: "edit",
    },
    currentTurnState: {
      interceptorHandled: false,
      interceptorThought: "",
    },
  };
  return {
    state,
    get: () => state,
    set: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next && typeof next === "object") Object.assign(state, next);
    },
  };
}

test("submit streaming ui initializes stream handles without projecting synthetic understanding progress", () => {
  const context = baseContext();
  const harness = createSessionHarness();
  let nextId = 100;

  const lease = startSubmitStreamingUi({
    context,
    sessionGet: harness.get,
    sessionSet: harness.set,
    nextTaskId: () => nextId++,
    currentImageCount: 1,
    contextSignals: {
      mentionedFilePaths: [],
      attachedFilePaths: [],
    },
    effectiveIntentSummary: "Fix the screenshot layout",
    isHidden: false,
    createVisibleTurnForHiddenMessage: false,
  });

  assert.equal(lease.thinkingInterceptor, context.thinkingInterceptor);
  assert.equal(lease.streamBuffer, context.streamBuffer);
  assert.equal(context.understandingProgressBlockId, null);
  assert.equal(harness.state.taskFlow.length, 0);
  assert.deepEqual(harness.state.conversationTurns[0].blockIds, []);
  assert.equal(harness.state.runtimeEvents.length, 0);
});

test("submit streaming ui keeps hidden resume invisible while initializing streams", () => {
  const context = baseContext({ turnId: "turn-hidden" });
  const harness = createSessionHarness();

  startSubmitStreamingUi({
    context,
    sessionGet: harness.get,
    sessionSet: harness.set,
    nextTaskId: () => 200,
    currentImageCount: 0,
    contextSignals: {
      mentionedFilePaths: ["src/App.tsx"],
      attachedFilePaths: [],
    },
    effectiveIntentSummary: "",
    isHidden: true,
    createVisibleTurnForHiddenMessage: false,
  });

  assert.ok(context.thinkingInterceptor);
  assert.ok(context.streamBuffer);
  assert.equal(context.understandingProgressBlockId, null);
  assert.equal(harness.state.taskFlow.length, 0);
  assert.equal(harness.state.runtimeEvents.length, 0);
});
