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

const { resolveAndApplySubmitIntentRouting } = loadTranspiledModuleSync(
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
    parsedStudioCommand: null,
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

test("submit intent routing suppresses the same ignored decision and falls back to respond", () => {
  const text = "总结并修复这个登录模块的问题";
  const harness = createHarness({
    text,
    dismissedPendingDecisionInputKey: text,
  });
  const result = harness.resolve();

  assert.equal(result.handled, false);
  assert.equal(result.effectiveRunIntent, "respond");
  assert.deepEqual(harness.calls.patches, [
    { dismissedPendingDecisionInputKey: null },
  ]);
  assert.deepEqual(harness.calls.preRunPatches, []);
  assert.equal(harness.calls.logs[0].event, "intent_decision_suppressed_for_same_input");
  assert.equal(harness.calls.logs[0].data.source, "resolution");
});

test("submit intent routing applies pending decision for reused execution-looking turns", () => {
  const harness = createHarness({
    text: "总结并修复这个登录模块的问题",
    currentTurn: { userPrompt: "前一轮" },
    currentTurnIntent: "respond",
    shouldReuseExistingTurnIntent: true,
  });
  const result = harness.resolve();

  assert.deepEqual(result, { handled: true, returnValue: true });
  assert.equal(harness.calls.preRunPatches.length, 1);
  const pending = harness.calls.preRunPatches[0].pendingRunDecision;
  assert.equal(pending.kind, "intent_confirmation");
  assert.equal(pending.suggestedIntent, "plan");
  assert.deepEqual(
    pending.options.map((option) => option.id),
    ["plan", "respond", "execute"],
  );
  assert.deepEqual(harness.calls.planResumes, []);
  assert.deepEqual(harness.calls.preflights, []);
});

test("submit intent routing starts approved plan resume as an early handled effect", () => {
  const harness = createHarness({
    text: "继续执行计划",
    hasPlanArtifacts: true,
    isPlanApproved: true,
    planStage: "executing",
    currentTurnId: "turn-current",
    planExecutionResumeContinuationTarget: { id: "turn-plan" },
  });
  const result = harness.resolve();

  assert.deepEqual(result, { handled: true, returnValue: true });
  assert.equal(harness.calls.planResumes.length, 1);
  assert.equal(harness.calls.planResumes[0].text, "继续执行计划");
  assert.equal(harness.calls.planResumes[0].uiParentTurnId, "turn-plan");
  assert.equal(harness.calls.planResumes[0].commandDirective.kind, "plan_resume");
  assert.deepEqual(harness.calls.preRunPatches, []);
});

test("submit intent routing starts blocking preflight for ambiguous chat execution input", () => {
  const harness = createHarness({
    text: "我希望加一个设置按钮",
  });
  const result = harness.resolve();

  assert.deepEqual(result, { handled: true, returnValue: true });
  assert.equal(harness.calls.preflights.length, 1);
  assert.equal(harness.calls.preflights[0].request.input, "我希望加一个设置按钮");
  assert.equal(harness.calls.preflights[0].request.mainModeKey, "main_mode");
  assert.equal(harness.calls.preflights[0].sendOriginSessionKey, "workspace::7");
  assert.deepEqual(harness.calls.preRunPatches, []);
});

test("workspace submissions continue into Turn creation without pre-turn intent gates", () => {
  const harness = createHarness({
    text: "我希望加一个设置按钮",
    hasWorkspace: true,
  });
  const result = harness.resolve();

  assert.equal(result.handled, false);
  assert.equal(result.effectiveRunIntent, "execute");
  assert.equal(result.effectiveCommandDirective.kind, "file_modify");
  assert.deepEqual(harness.calls.preRunPatches, []);
  assert.deepEqual(harness.calls.preflights, []);
  assert.equal(harness.calls.logs[0].event, "workspace_turn_intent_resolved");
});

test("complex workspace submissions enter Plan without a pre-turn decision", () => {
  const harness = createHarness({
    text: "生成一套游戏框架代码包括文件夹，实现完整的回合制战斗系统。",
    hasWorkspace: true,
  });
  const result = harness.resolve();

  assert.equal(result.handled, false);
  assert.equal(result.effectiveRunIntent, "plan");
  assert.deepEqual(harness.calls.preRunPatches, []);
  assert.deepEqual(harness.calls.preflights, []);
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
