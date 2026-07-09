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

const { applySubmitVisibleTurn } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitVisibleTurn.ts"),
);

function createState(overrides = {}) {
  return {
    taskFlow: [],
    conversationTurns: [],
    input: "draft text",
    normalizedStreamState: {
      replyOptions: ["Fix it"],
      finishReason: "stop",
    },
    config: {
      workflowMode: "chat",
    },
    pendingSlashCommand: { type: "workflow", slug: "help" },
    lockedComposerIntent: "plan",
    pendingRunDecision: { kind: "intent_confirmation" },
    isGenerating: false,
    currentTurnId: null,
    preferredResponseLanguage: "en",
    elapsedTime: 7,
    ...overrides,
  };
}

function createHarness(state) {
  return {
    logs: [],
    get: () => state,
    set: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next && typeof next === "object") Object.assign(state, next);
    },
  };
}

function baseInput(state, harness, overrides = {}) {
  let nextId = 100;
  return {
    sessionGet: harness.get,
    sessionSet: harness.set,
    nextTaskId: () => nextId++,
    nowMs: () => 150,
    logStoreEvent: (event, data) => {
      harness.logs.push({ event, data });
    },
    sendStartedAt: 100,
    runSessionKey: "/repo:7",
    runWorkspace: "/repo",
    text: "Please fix the bug",
    turnId: "turn-1",
    userContextItems: [{ type: "file", path: "src/App.tsx", label: "src/App.tsx", status: "ready" }],
    currentImages: [],
    isHidden: false,
    reuseCurrentTurn: false,
    uiParentTurnId: null,
    parentPlanTurnId: null,
    isInternalTurn: false,
    shouldExplicitlyReuseCurrentTurn: false,
    shouldAutoResumeChoiceTurn: false,
    currentTurnHasReplyOptions: false,
    effectiveRunIntent: "execute",
    effectiveDisplayIntent: "execute",
    effectiveIntentSummary: "Fix the bug",
    effectiveCommandDirective: { kind: "file_modify", source: "natural_language" },
    effectiveWorkflowMode: "edit",
    initialTurnStatus: "executing",
    operationProposalChoiceAction: undefined,
    turnTitle: "Fix the bug",
    parsedStudioCommand: null,
    preferredLanguage: "zh",
    preservePlanState: false,
    shouldGrantExecutionConsentForTurn: true,
    ...overrides,
  };
}

test("submit visible turn appends a user turn and applies run state", () => {
  const state = createState();
  const harness = createHarness(state);

  const result = applySubmitVisibleTurn(baseInput(state, harness));

  assert.equal(result.selectedChoiceText, "");
  assert.equal(state.taskFlow.length, 1);
  assert.equal(state.taskFlow[0].type, "user");
  assert.equal(state.taskFlow[0].id, 100);
  assert.equal(state.taskFlow[0].contextItems[0].path, "src/App.tsx");
  assert.equal(state.conversationTurns.length, 1);
  assert.equal(state.conversationTurns[0].id, "turn-1");
  assert.equal(state.conversationTurns[0].status, "executing");
  assert.equal(state.conversationTurns[0].mode, "edit");
  assert.equal(state.currentTurnId, "turn-1");
  assert.equal(state.input, "");
  assert.equal(state.pendingSlashCommand, null);
  assert.equal(state.lockedComposerIntent, null);
  assert.equal(state.pendingRunDecision, null);
  assert.equal(state.isGenerating, true);
  assert.deepEqual(state.currentTurnExecutionConsent, { turnId: "turn-1", granted: true });
  assert.equal(state.config.workflowMode, "edit");
  assert.equal(harness.logs.length, 1);
  assert.equal(harness.logs[0].event, "visible_turn_appended");
  assert.equal(harness.logs[0].data.userBlockId, 100);
  assert.equal(harness.logs[0].data.elapsedMs, 50);
});

test("submit visible turn can mark context items failed after attachment read errors", () => {
  const state = createState();
  const harness = createHarness(state);
  const result = applySubmitVisibleTurn(baseInput(state, harness));

  result.markUserContextItemFailed("src/App.tsx");

  assert.equal(state.taskFlow[0].contextItems[0].status, "failed");
});
