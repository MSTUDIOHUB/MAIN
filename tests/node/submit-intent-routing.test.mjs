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
  resolveAndApplySubmitIntentRouting,
  resolveWorkspaceTurnRuntimeIntent,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitIntentRouting.ts"),
);

function createHarness(overrides = {}) {
  const calls = {
    patches: [],
    preRunPatches: [],
    approvedPlans: 0,
    planResumes: [],
    preflights: [],
    logs: [],
  };
  const input = {
    text: "解释一下这个问题",
    images: undefined,
    preferredLanguage: "zh",
    options: {},
    currentMainModeKey: "main_mode",
    hasWorkspace: false,
    isHidden: false,
    autoApproveTools: false,
    fallbackRunIntent: "respond",
    mainDebugShortcut: null,
    mainIntentShortcut: null,
    lockedComposerIntent: null,
    goalCreationAuthorization: null,
    currentTurn: null,
    currentTurnIntent: "respond",
    hasPlanArtifacts: false,
    shouldContinuePlanIntent: false,
    shouldContinuePreviousTurnIntent: false,
    previousTurnContinuationTarget: null,
    previousTurnContinuationIntent: null,
    shouldReuseExistingTurnIntent: false,
    shouldExecuteOnceFromReplyOption: false,
    shouldRouteContinuationToPlanResume: false,
    planExecutionResumeContinuationTarget: null,
    planStage: "idle",
    isPlanApproved: false,
    currentTurnId: null,
    isLocalFastStudioCommand: false,
    unitySetupEngineSelected: false,
    dismissedPendingDecisionInputKey: null,
    currentConfig: { workflowMode: "chat" },
    sendOriginSessionKey: "workspace::7",
    setState: (patch) => {
      calls.patches.push(patch);
    },
    applyPreRunSessionPatch: (patch) => {
      calls.preRunPatches.push(patch);
    },
    approvePlan: () => {
      calls.approvedPlans += 1;
    },
    startPlanExecutionResume: (request) => {
      calls.planResumes.push(request);
    },
    startBlockingPreflight: (effect) => {
      calls.preflights.push(effect);
    },
    logStoreEvent: (event, data) => {
      calls.logs.push({ event, data });
    },
    ...overrides,
  };

  return {
    calls,
    input,
    resolve(extra = {}) {
      return resolveAndApplySubmitIntentRouting({
        ...input,
        ...extra,
      });
    },
  };
}

// These assertions replace the old lexical fast-path contract: no natural
// phrase can approve a plan, start its resume, or choose a capability surface.
for (const text of [
  "分别生成两个文件", "Generate two files separately.",
  "先分析再修复并验证", "Analyze, fix the cause, and validate.",
  "解释这个删除命令 rm -rf example", "Explain this deletion command: rm -rf example",
  "Hello!", "npm test", "继续执行计划",
  "总结并修复这个登录模块的问题",
]) {
  test(`natural input uses semantic admission once: ${text}`, () => {
    const harness = createHarness({ text, hasWorkspace: true,
      hasPlanArtifacts: true, isPlanApproved: true, planStage: "executing",
      dismissedPendingDecisionInputKey: text });
    assert.deepEqual(harness.resolve(), { handled: true, returnValue: true });
    assert.equal(harness.calls.preflights.length, 1);
    assert.equal(harness.calls.preflights[0].request.input, text);
    assert.equal(harness.calls.approvedPlans, 0);
    assert.equal(harness.calls.planResumes.length, 0);
    assert.deepEqual(harness.calls.preRunPatches, []);
  });
}

test("a continuation supplies its exact prior objective as context without inheriting a route", () => {
  const prior = { userPrompt: "Inspect first; do not modify this baseline." };
  const harness = createHarness({ text: "现在修复并验证。", hasWorkspace: true,
    shouldContinuePreviousTurnIntent: true, previousTurnContinuationTarget: prior,
    previousTurnContinuationIntent: "analyze", currentTurnIntent: "analyze" });
  assert.equal(harness.resolve().handled, true);
  const request = harness.calls.preflights[0].request;
  assert.equal(request.input, "现在修复并验证。");
  assert.equal(request.previousRequest, prior.userPrompt);
  assert.equal(harness.calls.planResumes.length, 0);
});

test("an explicit capsule is passed as a mode boundary while its natural restrictions are interpreted", () => {
  const harness = createHarness({ text: "Only inspect; do not write or run commands.", hasWorkspace: true,
    lockedComposerIntent: "execute" });
  assert.equal(harness.resolve().handled, true);
  assert.equal(harness.calls.preflights[0].request.explicitIntent, "execute");
});

test("operation metadata cannot override semantic intent without an explicit execution choice", () => {
  const resolution = {
    intent: "respond",
    reason: "router classified this as ordinary conversation",
    confidence: 0.4,
    riskLevel: "low",
    commandDirective: {
      kind: "file_modify",
      action: "update",
      target: "src/App.tsx",
      source: "natural_language",
      requiresWorkspace: true,
      requiresApproval: true,
      confidence: 0.9,
      reason: "normalized mutation directive",
    },
  };

  for (const intent of ["respond", "discuss", "analyze", "summarize", "report"]) {
    for (const kind of ["file_modify", "shell", "git", "unity"]) {
      assert.equal(resolveWorkspaceTurnRuntimeIntent({
        hasWorkspace: true,
        currentMainModeKey: "main_mode",
        shouldExecuteOnceFromReplyOption: false,
        resolution: { ...resolution, intent, commandDirective: { ...resolution.commandDirective, kind } },
      }), intent, `${intent}: ${kind}`);
    }
  }
  assert.equal(resolveWorkspaceTurnRuntimeIntent({
    hasWorkspace: true,
    currentMainModeKey: "main_mode",
    shouldExecuteOnceFromReplyOption: true,
    resolution,
  }), "execute");
  assert.equal(resolveWorkspaceTurnRuntimeIntent({
    hasWorkspace: false,
    currentMainModeKey: "main_mode",
    shouldExecuteOnceFromReplyOption: false,
    resolution,
  }), "respond");
});

test("hidden skip-intent control prompts do not infer shell directives from embedded commands", () => {
  const harness = createHarness({
    text: "计划已批准。请执行源码修改，然后运行 `npm test`。",
    isHidden: true,
    options: {
      resolvedIntent: "execute",
      skipIntentResolution: true,
      preservePlanState: true,
    },
    currentTurnIntent: "plan",
    hasPlanArtifacts: true,
    isPlanApproved: true,
    planStage: "executing",
  });
  const result = harness.resolve();

  assert.equal(result.handled, false);
  assert.equal(result.effectiveRunIntent, "execute");
  assert.equal(result.effectiveCommandDirective, null);
  assert.deepEqual(harness.calls.preflights, []);
});

test("intent routing does not promote internal resolved Goal intent into creation authority", () => {
  const harness = createHarness({
    text: "continue internally",
    isHidden: true,
    options: {
      resolvedIntent: "goal",
      skipIntentResolution: true,
    },
  });
  const result = harness.resolve();

  assert.equal(result.handled, false);
  assert.equal(result.effectiveRunIntent, "execute");
  assert.equal(result.goalCreationAuthorization, null);
});
