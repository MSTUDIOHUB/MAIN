import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function loader(mocks) {
  const cache = new Map();
  return function load(file) {
    const resolved = path.resolve(file);
    if (cache.has(resolved)) return cache.get(resolved);
    const module = { exports: {} };
    cache.set(resolved, module.exports);
    const localRequire = createRequire(resolved);
    const requireModule = (name) => {
      if (mocks.has(name)) return mocks.get(name);
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(resolved), name);
        for (const source of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
          if (fs.existsSync(source) && /\.tsx?$/.test(source)) return load(source);
        }
      }
      return localRequire(name);
    };
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: resolved,
    }).outputText;
    new Function("exports", "module", "require", output)(module.exports, module, requireModule);
    return module.exports;
  };
}

test("legal capability-free Plan semantics reach the production read-only runner and one discussion final", async () => {
  const prompt = "请帮我完善项目设计，跟我讨论并记录我的选择，以后再生成 README.md。";
  const semantic = { objective: "协助完善项目设计，记录用户决策，为后续生成 README.md 做准备", workType: "plan", answerFormat: "plan", requiredCapabilities: [], forbiddenCapabilities: [], approvalRequiredCapabilities: [] };
  const answer = "可以。先讨论目标用户和核心体验；你目前更倾向哪一种？我会记录你的选择，之后再整理 README。";
  const events = [], projections = [], providerModes = [];
  let revision = 0, planDispatches = 0, effectCalls = 0;
  const mocks = new Map([
    ["./streaming", { resolveJsonObjectOutputOptions: () => ({}), streamChatCompletion: async () => ({ content: JSON.stringify({ semantic }), finishReason: "stop", toolCalls: [] }) }],
    ["../lib/runtimeContextBudget", { resolveRuntimeContextBudget: async () => null }],
    ["./runtimeV2/planRunner", { runSubmitRuntimeV2Plan: async () => { planDispatches += 1; return { retainedPlan: true }; } }],
    ["./runtimeV2/executeRunner", { runSubmitRuntimeV2Execute: async () => { throw new Error("discussion must not dispatch Execute"); } }],
    ["./runtimeV2/goalProductionRunner", { runSubmitRuntimeV2Goal: async () => { throw new Error("discussion must not dispatch Goal"); } }],
    ["./checkpointPort", {
      getRuntimeV2Checkpoint: () => null,
      createRuntimeV2CheckpointPort: () => ({ load: async () => null, append: async ({ event }) => {
        events.push(event);
        return { disposition: "committed", checkpoint: { revision: ++revision } };
      } }),
    }],
    ["./executionPorts", {
      createRuntimeV2LiveExecutionState: () => ({ messages: [], childRuns: new Map(), childAbortControllers: new Map(), childTelemetry: new Map(), subagentCandidates: [], evidenceCounter: 0, latestProviderResult: null, latestVisibleText: "", providerLaneProfile: null, authorization: null }),
      createRuntimeV2ProviderPort: () => ({ request: async ({ command }) => {
        providerModes.push(command.payload.mode);
        return { visibleText: answer, toolCalls: [], diagnostics: [] };
      } }),
      createRuntimeV2ToolPort: () => ({ execute: async () => { effectCalls += 1; throw new Error("discussion needs no tool"); } }),
      createRuntimeV2SchedulerPort: () => ({ execute: async () => { effectCalls += 1; throw new Error("discussion needs no child"); } }),
    }],
    ["./projectionPort", { createRuntimeV2ProjectionPort: () => ({ publish: async (value) => { projections.push(value); } }) }],
  ]);
  const load = loader(mocks);
  const { runIntentPreflight } = load("src/lib/intentPreflight.ts");
  const submission = load("src/lib/submit/turnSubmission.ts");
  const { createSubmitRuntimeContext } = load("src/store/submitRuntimeContext.ts");
  const { runSubmitRuntime } = load("src/store/submitRuntimeRunner.ts");
  const preflight = await runIntentPreflight({ input: prompt, language: "zh", mainModeKey: "main_mode", hasWorkspace: true,
    config: { activeProfile: "local", local: { endpoint: "http://fixture.invalid/v1", model: "fixture" } } });
  assert.equal(preflight.intent, "respond");
  assert.deepEqual(preflight.semantic, semantic);
  const decision = submission.resolveSubmitPreflightResultDecision({ text: prompt, preferredLanguage: "zh", resolution: { intent: "plan" }, preflight });
  const resumed = submission.buildSubmitPreflightResumeOptions({ decision });
  assert.equal(resumed.resolvedIntent, "respond");
  assert.equal(resumed.semanticIntent.workType, "plan");
  assert.equal(resumed.semanticIntent.answerFormat, "plan");
  const runtimeDecision = submission.resolveSubmitRuntimeDecision({ effectiveRunIntent: resumed.resolvedIntent, currentMainModeKey: "main_mode", isPlanApproved: false, autoApproveTools: true, shouldExecuteOnceFromReplyOption: false, preservePlanState: false });
  assert.equal(runtimeDecision.runtimeRunIntent, "respond");
  const context = createSubmitRuntimeContext({ turnId: "turn-discuss", uiDisplayTurnId: "turn-discuss", runWorkspace: "/fixture", runSessionKey: "/fixture:1", runSessionEpoch: "epoch-discuss", runSessionId: 1, runScopeKey: "/fixture", phaseLanguage: "zh",
    effectiveRunIntent: resumed.resolvedIntent, runtimeRunIntent: runtimeDecision.runtimeRunIntent,
    requiredCapabilities: resumed.semanticIntent.requiredCapabilities, capabilityRestrictions: resumed.semanticIntent.forbiddenCapabilities, approvalRequiredCapabilities: resumed.semanticIntent.approvalRequiredCapabilities,
    options: resumed, attachedFilesSnapshot: [], mentionSnapshot: [], projectBaselineContext: { kind: "project_baseline_context", workspace: { canonicalPath: "/fixture" } }, abortCtrl: new AbortController(), timerInterval: null, harnessRunId: "run-discuss",
    turnInputContextSignals: { attachedFilePaths: [], subagentPreference: "forbidden" }, getElapsedSeconds: () => 0,
  });
  assert.equal(context.options.semanticIntent.workType, "plan", "retained semantics are present through production admission");
  const state = { conversationTurns: [{ id: context.turnId, clientSubmissionId: "submit-discuss", userPrompt: prompt, runtimeEngineVersion: "v2" }], planLifecycle: { sessionKey: context.runSessionKey, sessionEpoch: context.runSessionEpoch }, _nextTaskId: () => 1 };
  const input = { get: () => state, set: () => undefined, context, getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (blocks) => blocks, buildSessionRuntimeSnapshot: (value) => value,
    publishOwnerScopedRuntimeProjection: () => ({ published: true, disposition: "published" }), persistSessionRecord: async () => undefined, logStoreEvent: () => undefined };
  const result = await runSubmitRuntime(input);
  assert.equal(result.outcome.resultKind, "success");
  assert.deepEqual(providerModes, ["analyze"]);
  assert.equal(planDispatches, 0);
  assert.equal(effectCalls, 0);
  assert.equal(events.find((event) => event.type === "turn.admitted").strategy, "analyze");
  assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
  assert.equal(events.some((event) => event.type === "command.scheduled" && ["execute_mutation", "execute_validation", "commit_work_plan"].includes(event.command.kind)), false);
  const finals = projections.filter((entry) => entry.audience === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].projection.markdown, answer);

  const retained = submission.resolveSubmitRuntimeDecision({ effectiveRunIntent: "plan", runtimeIntentOverride: "plan", currentMainModeKey: "main_mode", isPlanApproved: false, autoApproveTools: false, shouldExecuteOnceFromReplyOption: false, preservePlanState: true });
  assert.equal(retained.runtimeRunIntent, "plan");
  const restoredContext = { ...context, effectiveRunIntent: "plan", runtimeRunIntent: retained.runtimeRunIntent };
  assert.deepEqual(await runSubmitRuntime({ ...input, context: restoredContext }), { retainedPlan: true });
  assert.equal(planDispatches, 1, "an admitted Plan restoration is not reclassified from retained empty-cap semantics");
});
