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

const { createSubmitRuntimeContext } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitRuntimeContext.ts"),
);
const { startSubmitStreamingUi } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitStreamingUi.ts"),
);

function baseContext(overrides = {}) {
  return createSubmitRuntimeContext({
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
    harnessRunId: "run-outer",
    planExecution: null,
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
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
    harnessRunMarker: {
      runId: "run-outer",
      activeRunId: "run-child",
      activeParentRunId: "run-outer",
      sessionKey: "/repo:7",
      turnId: "turn-1",
    },
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

test("execution stream projects provisional model activity to the exact-run Capsule channel", () => {
  const context = baseContext();
  const harness = createSessionHarness();
  let nextId = 300;
  const lease = startSubmitStreamingUi({
    context,
    sessionGet: harness.get,
    sessionSet: harness.set,
    nextTaskId: () => nextId++,
    currentImageCount: 0,
    contextSignals: { mentionedFilePaths: [], attachedFilePaths: [] },
    effectiveIntentSummary: "",
    isHidden: false,
    createVisibleTurnForHiddenMessage: false,
  });

  lease.streamBuffer.append("让我先查看 src/main.js，确认文件打开事件的真实入口。");
  lease.streamBuffer.flush();

  assert.equal(harness.state.taskFlow.length, 1);
  const block = harness.state.taskFlow[0];
  assert.equal(block.type, "agent");
  assert.equal(block.streaming, true);
  assert.equal(block.visibility, "user_progress");
  assert.equal(block.publicProgress?.kind, "capsule_activity");
  assert.equal(block.publicProgress?.sessionKey, "/repo:7");
  assert.equal(block.publicProgress?.turnId, "turn-1");
  assert.equal(block.publicProgress?.displayTurnId, "turn-ui");
  assert.equal(block.publicProgress?.runId, "run-child");
  assert.equal(block.publicProgress?.parentRunId, "run-outer");
  assert.deepEqual(harness.state.conversationTurns[0].blockIds, [block.id]);
});

test("preapproval Plan stream stays buffered outside ChatArea and Capsule", () => {
  const context = baseContext({
    effectiveRunIntent: "plan",
    runtimeRunIntent: "plan",
  });
  const harness = createSessionHarness();
  harness.state.config.workflowMode = "plan";
  const lease = startSubmitStreamingUi({
    context,
    sessionGet: harness.get,
    sessionSet: harness.set,
    nextTaskId: () => 350,
    currentImageCount: 0,
    contextSignals: { mentionedFilePaths: [], attachedFilePaths: [] },
    effectiveIntentSummary: "",
    isHidden: false,
    createVisibleTurnForHiddenMessage: false,
  });

  lease.streamBuffer.append("# 修复计划\n\n- 修改 src/main.js 并完成验证。");
  lease.streamBuffer.flush();

  assert.equal(harness.state.taskFlow.length, 0);
  assert.deepEqual(harness.state.conversationTurns[0].blockIds, []);
  assert.match(context.streamingAssistantDisplayBuffer, /# 修复计划/);
});

test("ordinary chat stream remains a visible ChatArea assistant block", () => {
  const context = baseContext({
    effectiveRunIntent: "respond",
    runtimeRunIntent: "respond",
  });
  const harness = createSessionHarness();
  harness.state.config.workflowMode = "chat";
  const lease = startSubmitStreamingUi({
    context,
    sessionGet: harness.get,
    sessionSet: harness.set,
    nextTaskId: () => 400,
    currentImageCount: 0,
    contextSignals: { mentionedFilePaths: [], attachedFilePaths: [] },
    effectiveIntentSummary: "",
    isHidden: false,
    createVisibleTurnForHiddenMessage: false,
  });

  lease.streamBuffer.append("这是直接回复用户的普通聊天内容。");
  lease.streamBuffer.flush();

  const block = harness.state.taskFlow[0];
  assert.equal(block.type, "agent");
  assert.equal(block.visibility, undefined);
  assert.equal(block.publicProgress, undefined);
});
