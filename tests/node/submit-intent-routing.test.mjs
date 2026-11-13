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
const { resolveSubmitPreflightEffectAction } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/submit/turnSubmission.ts"),
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
  assert.equal(harness.calls.preflights.length, 1);
  const request = harness.calls.preflights[0].request;
  assert.equal(request.input, "现在修复并验证。");
  assert.equal(request.previousRequest, prior.userPrompt);
  assert.equal(harness.calls.planResumes.length, 0);
});

test("Plan selection survives the semantic handoff and ambiguous results conclude before dispatch", () => {
  const planContinuationCandidates = [
    { id: "bricks:v2", title: "Brick breaker", objective: "Make a playable Unity brick breaker", status: "canceled" },
    { id: "collector:v1", title: "Collector", objective: "Prototype a collection game", status: "review" },
  ];
  const text = "Continue the plan.";
  const harness = createHarness({ text, preferredLanguage: "en", hasWorkspace: true, hasPlanArtifacts: true,
    planContinuationCandidates, currentTurn: { userPrompt: "What does the Editor do?" } });
  assert.deepEqual(harness.resolve(), { handled: true, returnValue: true });
  assert.equal(harness.calls.preflights.length, 1);
  assert.deepEqual(harness.calls.preflights[0].request.planContinuationCandidates, planContinuationCandidates);
  const preflight = { intent: "respond", confidence: 0.9, semantic: {
    objective: text, workType: "answer", answerFormat: "answer", requiredCapabilities: [], forbiddenCapabilities: ["command"],
    approvalRequiredCapabilities: ["workspace_write"],
  } };
  const decide = (planContinuation, isOriginOwnerCurrent = true) => resolveSubmitPreflightEffectAction({
    effect: harness.calls.preflights[0], preflight: { ...preflight, planContinuation }, latestInput: text,
    latestMainModeKey: "main_mode", isOriginSessionActive: true, isOriginOwnerCurrent,
  });
  const selected = { kind: "continue", candidateId: "bricks:v2" };
  const handoff = decide(selected);
  assert.equal(handoff.kind, "resume");
  assert.deepEqual(handoff.options.planContinuation, selected);
  assert.deepEqual(handoff.options.semanticIntent, preflight.semantic);
  assert.equal(handoff.options.executionConsentGranted, undefined);
  assert.equal(decide(selected, false).kind, "skip_inactive_session");
  const ambiguous = decide({ kind: "ambiguous", candidateIds: ["bricks:v2", "collector:v1"] });
  assert.equal(ambiguous.kind, "conclude_without_execution");
  assert.equal(ambiguous.resultKind, "blocked");
  assert.match(ambiguous.summary, /Which plan do you mean\?/);
  assert.match(ambiguous.summary, /- Brick breaker\n- Collector/);
  assert.equal(harness.calls.planResumes.length, 0);
  assert.equal(harness.calls.approvedPlans, 0);
});

test("unavailable continuation states give specific guidance before dispatch", () => {
  const text = "Continue the selected plan.";
  const planContinuationCandidates = ["review", "paused", "draft", "completed"].map(status => ({
    id: status, status, objective: `Selected ${status} plan`,
  }));
  const outcome = (kind, candidateId, explicitIntent, preferredLanguage = "en") => {
    const harness = createHarness({ text, preferredLanguage, hasWorkspace: true, hasPlanArtifacts: true,
      planContinuationCandidates, options: { explicitIntent } });
    assert.equal(harness.resolve().handled, true);
    return resolveSubmitPreflightEffectAction({
      effect: harness.calls.preflights[0], preflight: {
        intent: kind === "revise" || explicitIntent === "plan" ? "plan" : "execute", confidence: 0.9,
        semantic: { objective: text, workType: "plan", answerFormat: "plan", requiredCapabilities: [],
          forbiddenCapabilities: [], approvalRequiredCapabilities: [] },
        planContinuation: { kind, candidateId },
      }, latestInput: text, latestMainModeKey: "main_mode", isOriginSessionActive: true, isOriginOwnerCurrent: true,
    });
  };
  for (const [status, guidance] of [
    ["review", /waiting for approval.*Plan panel/],
    ["paused", /paused.*pending choice or prerequisite/],
    ["draft", /still a draft.*continue planning/],
    ["completed", /no remaining work.*new work/],
  ]) {
    const action = outcome("continue", status);
    assert.equal(action.kind, "conclude_without_execution");
    assert.equal(action.resultKind, "blocked");
    assert.match(action.summary, guidance);
    assert.equal(outcome("continue", status, "plan").kind, "conclude_without_execution");
    assert.match(outcome("revise", status).summary, /select Plan mode/);
    const revision = outcome("revise", status, "plan");
    assert.equal(revision.kind, "resume");
    assert.equal(revision.options.resolvedIntent, "plan");
    assert.equal(revision.options.planContinuation, undefined);
  }
  assert.match(outcome("continue", "review", undefined, "zh").summary, /等待审批.*计划面板/);
  assert.match(outcome("continue", "other-session").summary, /no longer available/);
  assert.equal(outcome("discuss", "completed").kind, "resume");
});

for (const text of ["继续", "Continue", "What about its latest announcement?"]) {
  test(`semantic admission sees the preceding read-only question without lexical continuation authority: ${text}`, () => {
    const prior = { id: "prior-chat", userPrompt: "查询该基金今天上午的行情", intent: "analyze", status: "done" };
    const harness = createHarness({ text, currentTurn: prior, currentTurnIntent: "analyze" });
    assert.equal(harness.resolve().handled, true);
    const request = harness.calls.preflights[0].request;
    assert.equal(request.input, text);
    assert.equal(request.previousRequest, prior.userPrompt);
    assert.equal(request.explicitIntent, undefined);
    assert.equal(harness.calls.planResumes.length, 0);
    assert.equal(harness.calls.approvedPlans, 0);
  });
}

test("an explicit capsule is passed as a mode boundary while its natural restrictions are interpreted", () => {
  const harness = createHarness({ text: "Only inspect; do not write or run commands.", hasWorkspace: true,
    lockedComposerIntent: "execute" });
  assert.equal(harness.resolve().handled, true);
  assert.equal(harness.calls.preflights.length, 1);
  assert.equal(harness.calls.preflights[0].request.input, harness.input.text);
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
