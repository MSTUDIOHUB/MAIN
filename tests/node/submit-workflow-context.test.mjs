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

function baseInput(overrides = {}) {
  return {
    turnId: "turn-1",
    uiDisplayTurnId: "turn-ui",
    runWorkspace: "/repo",
    runSessionKey: "/repo:7",
    runSessionId: 7,
    runScopeKey: "/repo",
    phaseLanguage: "zh",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    effectiveCommandDirective: { kind: "file_modify", source: "natural_language" },
    options: { executionConsentGranted: true },
    attachedFilesSnapshot: ["README.md"],
    mentionSnapshot: ["src/App.tsx"],
    remoteFeishu: { chatId: "chat-1" },
    workspaceTree: "[F] src/App.tsx",
    gameStudioConfigForTurn: { engine: "unity", activeStudioAgent: "unity-specialist" },
    abortCtrl: { signal: { aborted: false } },
    timerInterval: "timer-1",
    sendStartedAt: 123,
    harnessRunId: "run-124",
    turnAgentMessagesStart: 4,
    getElapsedSeconds: () => 9,
    PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: 50,
    PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: 720000,
    PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: 2,
    ...overrides,
  };
}

test("submit workflow context carries immutable turn parameters and initializes mutable state", () => {
  const input = baseInput();
  const context = createSubmitWorkflowContext(input);

  assert.equal(context.turnId, "turn-1");
  assert.equal(context.uiDisplayTurnId, "turn-ui");
  assert.equal(context.runWorkspace, "/repo");
  assert.equal(context.runSessionKey, "/repo:7");
  assert.equal(context.phaseLanguage, "zh");
  assert.equal(context.effectiveRunIntent, "execute");
  assert.deepEqual(context.effectiveCommandDirective, input.effectiveCommandDirective);
  assert.deepEqual(context.options, input.options);
  assert.deepEqual(context.attachedFilesSnapshot, ["README.md"]);
  assert.deepEqual(context.mentionSnapshot, ["src/App.tsx"]);
  assert.equal(context.abortCtrl, input.abortCtrl);
  assert.equal(context.timerInterval, "timer-1");
  assert.equal(context.harnessRunId, "run-124");
  assert.equal(context.getElapsedSeconds(), 9);
  assert.equal(context.streamBuffer, null);
  assert.equal(context.thinkingInterceptor, null);
  assert.ok(context.agentBlockIdsCreatedThisRun instanceof Set);
  assert.equal(context.agentBlockIdsCreatedThisRun.size, 0);
  assert.equal(context.firstStreamTokenAt, null);
  assert.equal(context.streamTokenCount, 0);
  assert.equal(context.streamTextChars, 0);
  assert.equal(context.streamingAssistantDisplayBuffer, "");
  assert.equal("approvedPlanHandoff" in context, false);
  assert.equal(context.understandingProgressBlockId, null);
  assert.equal(context.understandingProgressClosed, false);
  assert.equal(context.PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS, 50);
  assert.equal(context.PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS, 720000);
  assert.equal(context.PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK, 2);
});

test("submit workflow context creates isolated mutable sets per context", () => {
  const first = createSubmitWorkflowContext(baseInput({ turnId: "turn-a" }));
  const second = createSubmitWorkflowContext(baseInput({ turnId: "turn-b" }));

  first.agentBlockIdsCreatedThisRun.add(1);
  assert.equal(first.agentBlockIdsCreatedThisRun.size, 1);
  assert.equal(second.agentBlockIdsCreatedThisRun.size, 0);
});
