import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import ts from "typescript";

function loader(mocks = new Map()) {
  const cache = new Map();
  return function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const native = createRequire(file);
    const requireModule = name => {
      if (mocks.has(name)) return mocks.get(name);
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(file), name);
        for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
          if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return load(candidate);
        }
      }
      return native(name);
    };
    new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: file,
    }).outputText)(module.exports, module, requireModule);
    return module.exports;
  };
}

const runtime = loader()("src/lib/runtime-v2/index.ts");
const sha = value => createHash("sha256").update(value).digest("hex");

function createPlanHarness({ responses = [] } = {}) {
  const workspace = "/empty-unity-framework";
  const sessionKey = `${workspace}:1`;
  const context = {
    turnId: "turn-mframework",
    uiDisplayTurnId: "turn-mframework",
    runWorkspace: workspace,
    runScopeKey: workspace,
    runSessionKey: sessionKey,
    runSessionId: 1,
    runSessionEpoch: "epoch-1",
    harnessRunId: "run-mframework",
    phaseLanguage: "zh",
    planPurpose: "plan",
    abortCtrl: new AbortController(),
    timerInterval: undefined,
    turnInputContextSignals: { subagentPreference: "forbidden", subagentRequirement: "optional", attachedFilePaths: [] },
    runtimeContextBudget: { contextLimit: 32768, outputBudget: 4096, inputBudget: 28672, readWindowChars: 16000 },
  };
  let state = {
    currentTurnId: context.turnId,
    currentSessionId: 1,
    conversationTurns: [{ id: context.turnId, clientSubmissionId: "sub-1", userPrompt: "制作轻量级 Unity 框架 MFramework，暂不搭建测试，仅在 Unity 编译检查。" }],
    config: {},
    planLifecycle: { sessionKey, sessionEpoch: "epoch-1" },
    runtimeV2Checkpoints: {},
    taskFlow: [],
    harnessRunMarker: { sessionKey, turnId: context.turnId, runId: context.harnessRunId, status: "running", startedAt: 1, instanceId: "instance-1" },
    _nextTaskId: () => state.taskFlow.length + 1,
  };
  const calls = [];
  const saves = [];
  const stored = new Map();
  const logs = [];
  const get = () => state;
  const set = patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; };
  const mocks = new Map([
    ["../../lib/providerLaneSettings", {
      deriveBudgetedStreamSettings: () => ({ provider: "fixture", toolProtocol: "auto" }),
      deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
    }],
    ["../../lib/modelLaneCoordinator", {
      acquireModelLane: async () => ({ release() {}, markFirstToken() {}, reportFailure() {}, setPressureHandler() {} }),
    }],
    ["../../lib/streaming", {
      isStreamOutputLimited: () => false,
        streamChatCompletion: async (...args) => {
          calls.push(args);
          if (!responses.length) assert.fail("unexpected extra model call in verification policy harness");
          const next = responses.shift();
          if (typeof next === "function") return await next(...args);
          if (next instanceof Error) throw next;
          return next;
        },
    }],
    ["../../lib/subagents", { resolveSubagentCapacityPolicy: () => ({ maxActiveRequests: 0, modelRequestMode: "serialized" }) }],
    ["../../lib/ipc", {
      savePlanDocument: async input => {
        saves.push(input);
        const key = `${input.owner.sessionKey}:${input.documentId}`;
        if (stored.has(key)) return stored.get(key).reference;
        const reference = {
          owner: input.owner,
          documentId: input.documentId,
          revision: 1,
          contentHash: sha(input.markdown),
          path: `stored/${input.documentId}/rev-1.md`,
          title: input.title,
          kind: input.kind,
        };
        stored.set(key, { input, reference });
        return reference;
      },
    }],
    ["../../lib/toolExecutor", { executeTool: async () => "[]" }],
    ["./checkpointPort", {
      getRuntimeV2Checkpoint: (_state, owner) => state.runtimeV2Checkpoints[owner.turnId] || null,
      createRuntimeV2CheckpointPort: () => ({
        append: async input => {
          const result = runtime.appendRuntimeV2Checkpoint({
            checkpoint: state.runtimeV2Checkpoints[input.owner.turnId] || null,
            owner: input.owner,
            expectedRevision: input.expectedRevision,
            event: input.event,
          });
          assert.equal(result.disposition, "committed", result.reason);
          state = { ...state, runtimeV2Checkpoints: { ...state.runtimeV2Checkpoints, [input.owner.turnId]: result.checkpoint } };
          return result;
        },
      }),
    }],
    ["./projectionPort", { createRuntimeV2ProjectionPort: () => ({ publish: async () => {} }) }],
  ]);
  const load = loader(mocks);
  const runner = load("src/store/runtimeV2/planRunner.ts");
  const controls = load("src/store/runtimeV2/executionBlocker.ts");
  const input = {
    get, set, context,
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: x => x,
    buildSessionRuntimeSnapshot: x => x,
    publishOwnerScopedRuntimeProjection: () => ({ published: true }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: (event, data) => logs.push({ event, data }),
  };

  return {
    get, set, context, calls, saves, logs, load,
    run: () => runner.runSubmitRuntimeV2Plan(input),
    async answerPolicy(policyId) {
      const request = state.activeActionRequest;
      assert.equal(request.kind, "user_choice");
      state = { ...state, harnessRunMarker: { ...state.harnessRunMarker, status: "paused" } };
      const identity = load("src/lib/actionRequest.ts").toUserChoiceResolutionIdentity(request);
      const answer = {
        requestId: request.requestId,
        revision: request.questionnaire.revision,
        answers: request.questionnaire.questions.map(question => ({
          questionId: question.id,
          selectedValues: question.id === "result_kind"
            ? ["executable"]
            : question.id === "verification_policy"
              ? [policyId]
              : [question.options[0].id],
        })),
      };
      const ok = await controls.resolveRuntimeV2StructuredUserChoice({
        get, set, identity, answer, sessionEpoch: "epoch-1",
        persist: async () => ({}),
        dispatch: () => {},
        stop: () => {},
      });
      if (ok) state = { ...state, activeActionRequest: null, harnessRunMarker: { ...state.harnessRunMarker, status: "running" } };
      return ok;
    },
  };
}

const initialAsk = {
  content: "",
  toolCalls: [{
    id: "ask-1",
    name: "ask_plan_questions",
    arguments: JSON.stringify({
      title: "MFramework 框架设计决策",
      questions: [{
        id: "test_mode",
        prompt: "测试方式？",
        selectionMode: "single",
        required: true,
        options: [{ id: "no_test", label: "暂不搭建测试" }],
      }],
    }),
  }],
  protocolViolation: null,
};

const manualPlanSubmission = (id, command) => ({
  content: "",
  toolCalls: [{
    id,
    name: "submit_runtime_v2_work_plan",
    arguments: JSON.stringify({
      planMarkdown: "# MFramework 方案\n\n创建 Core 与 ObjectPool 脚手架。",
      changes: [{ operation: "create", targets: ["Assets/MFramework/Core/ServiceContainer.cs"], change: "创建 DI 容器骨架。" }],
      validations: command
        ? [{ kind: "finite_command", command, expectedOutcome: "在 Unity Editor 中编译 Assets/MFramework 无编译错误。" }]
        : [{ kind: "advisory", required: true, expectedOutcome: "在 Unity Editor 中手动编译确认无报错。" }],
    }),
  }],
  protocolViolation: null,
});

test("withDefaultCustomOtherOption defaults choice required=true when omitted, enables allowText, and relaxes minSelections", () => {
  const { withDefaultCustomOtherOption } = loader()("src/store/runtimeV2/planQuestionControl.ts");
  const questions = [
    { id: "q1", prompt: "A?", selectionMode: "single", options: [{ id: "a", label: "A" }], required: true, allowText: false, minSelections: 1, maxSelections: 1 },
    { id: "q2", prompt: "B?", selectionMode: "single", options: [{ id: "b", label: "B" }], required: true, allowText: false, minSelections: 1, maxSelections: 1 },
    { id: "q3", prompt: "C?", selectionMode: "multiple", options: [{ id: "c1", label: "C1" }, { id: "c2", label: "C2" }], required: true, allowText: false, minSelections: 2, maxSelections: 2 },
    { id: "q4", prompt: "D?", selectionMode: "text", options: [], required: true, allowText: true, minSelections: 0, maxSelections: 0 },
    { id: "q5", prompt: "E?", selectionMode: "single", options: [{ id: "e", label: "E" }], required: false, allowText: false, minSelections: 0, maxSelections: 1 },
    { id: "q6", prompt: "F?", selectionMode: "single", options: [{ id: "f", label: "F" }], required: false, allowText: false, minSelections: 0, maxSelections: 1 },
  ];
  const rawQuestions = [
    { id: "q1", selectionMode: "single", required: true },
    { id: "q2", selectionMode: "single", required: true, allowText: false },
    { id: "q3", selectionMode: "multiple", required: true, minSelections: 2, maxSelections: 2 },
    { id: "q4", selectionMode: "text", required: true },
    { id: "q5", selectionMode: "single" },
    { id: "q6", selectionMode: "single", required: false },
  ];
  const result = withDefaultCustomOtherOption(questions, rawQuestions);
  assert.deepEqual([result[0].required, result[0].allowText, result[0].minSelections], [true, true, 0]);
  assert.deepEqual([result[1].required, result[1].allowText, result[1].minSelections], [true, false, 1]);
  assert.deepEqual([result[2].required, result[2].allowText, result[2].minSelections], [true, true, 2]);
  assert.equal(result[3].selectionMode, "text");
  assert.deepEqual([result[4].required, result[4].allowText, result[4].minSelections], [true, true, 0]);
  assert.deepEqual([result[5].required, result[5].allowText, result[5].minSelections], [false, true, 0]);
});

test("3 distinct validation-only rejections trigger plan_verification_confirmation and manual_advisory seals immediately without another model call", async () => {
  const h = createPlanHarness({
    responses: [
      initialAsk,
      manualPlanSubmission("sub-1", "ls -R Assets/MFramework"),
      manualPlanSubmission("sub-2", "test -f Assets/MFramework/Core/ServiceContainer.cs"),
      manualPlanSubmission("sub-3", "find Assets/MFramework -name '*.cs' | wc -l"),
    ],
  });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(await h.answerPolicy("no_test"), true);

  const secondPause = await h.run();
  assert.equal(secondPause.outcome.status, "paused");
  const request = h.get().activeActionRequest;
  assert.equal(request.kind, "user_choice");
  assert.equal(request.questionnaire.purpose, "plan_verification_confirmation");
  assert.equal(request.questionnaire.questions[0].id, "verification_policy");
  assert.equal(h.calls.length, 4);

  assert.equal(await h.answerPolicy("manual_advisory"), true);
  h.context.planPurpose = undefined;
  const reviewPause = await h.run();
  assert.equal(reviewPause.outcome.status, "paused");
  assert.equal(h.calls.length, 4, "manual_advisory re-assesses prior candidate immediately with zero extra LLM round-trip");
  assert.equal(h.get().activeActionRequest.kind, "plan_review");
  assert.equal(h.saves.length, 1);
  assert.match(h.saves[0].markdown, /人工 \/ 外部验证模式/);
  assert.match(h.saves[0].markdown, /人工 \/ 外部确认（非自动测试）/);

  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.ok(aggregate.sealedWorkPlan);
  assert.equal(aggregate.phase, "reviewing");
});

test("save_draft choice in plan_verification_confirmation preserves the candidate as a reviewable Plan Draft", async () => {
  const h = createPlanHarness({
    responses: [
      initialAsk,
      manualPlanSubmission("sub-1", "ls Assets/MFramework"),
      manualPlanSubmission("sub-2", "test -f Assets/MFramework/Core/ServiceContainer.cs"),
      manualPlanSubmission("sub-3", null),
    ],
  });
  await h.run();
  await h.answerPolicy("no_test");
  await h.run();
  assert.equal(h.get().activeActionRequest.questionnaire.purpose, "plan_verification_confirmation");

  assert.equal(await h.answerPolicy("save_draft"), true);
  const settlement = await h.run();
  assert.equal(settlement.outcome.resultKind, "partial");
  assert.equal(h.calls.length, 4);
  assert.equal(h.saves.length, 1);
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.ok(h.load("src/lib/planDocumentRecords.ts").resolvePlanDraftFromAggregate(aggregate));
});

test("repetition exhaustion without any submitted plan candidate still terminates with error", async () => {
  const repeated = () => Object.assign(new Error("STREAM_VISIBLE_TEXT_REPETITION: repeated output"), {
    code: "STREAM_VISIBLE_TEXT_REPETITION",
  });
  const h = createPlanHarness({
    responses: [
      initialAsk,
      () => { throw repeated(); },
      () => { throw repeated(); },
    ],
  });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(await h.answerPolicy("no_test"), true);

  const settlement = await h.run();
  assert.equal(settlement.outcome.resultKind, "error");
  assert.equal(h.calls.length, 3);
  assert.equal(h.saves.length, 0);
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.equal(h.load("src/lib/planDocumentRecords.ts").resolvePlanDraftFromAggregate(aggregate), null);
});

test("manual/external approved WorkPlan closes as success and renders explicit manual checklist in completion & fallback projection", () => {
  const { sealWorkPlanV1, projectWorkPlanMarkdown } = runtime;
  const sealed = sealWorkPlanV1({
    draft: {
      schemaVersion: "work-plan.v1",
      objective: "创建 MFramework 脚手架",
      summary: "搭建 Core 与 ObjectPool 骨架。",
      findings: [],
      steps: [{
        title: "创建 ServiceContainer",
        operation: "create",
        targets: ["Assets/MFramework/Core/ServiceContainer.cs"],
        basis: [],
        change: "新增 DI 容器脚本。",
        expectedOutcome: "脚本创建完成。",
        dependsOn: [],
        criterionIds: ["criterion-1"],
      }],
      validations: [{
        stepIndexes: [0],
        kind: "advisory",
        expectedOutcome: "在 Unity Editor 中编译确认无报错。",
        required: false,
        criterionIds: ["criterion-1"],
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [],
    createdAt: 100,
  });
  assert.match(projectWorkPlanMarkdown(sealed), /人工 \/ 外部验证模式/);
  assert.match(projectWorkPlanMarkdown(sealed), /人工 \/ 外部确认（非自动测试）/);

  const turn = { workspaceKey: "/unity", sessionKey: "/unity:1", sessionEpoch: "epoch-1", clientSubmissionId: "sub-1", turnId: "turn-1" };
  const run = { ...turn, runId: "run-1", parentRunId: null, attemptId: "attempt-1" };
  let agg = runtime.transition(null, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "turn.admitted", eventId: "e0", sequence: 0, at: 1, turn, strategy: "plan", objective: "创建 MFramework", constraints: [], acceptanceCriteria: ["Works"], acceptanceCriterionIds: ["criterion-1"] });
  agg = runtime.transition(agg, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "run.started", eventId: "e1", sequence: 1, at: 2, run, phase: "planning" });
  const reviewCommit = {
    schemaVersion: "runtime-v2-plan-review-commit.v1",
    authority: { id: sealed.id, revision: sealed.revision, digest: sealed.digest, projectionHash: sealed.projectionHash },
    artifact: { path: ".MAIN/plans/plan.md", content: sealed.markdown, projectionHash: sealed.projectionHash, ownership: "runtime_managed" },
    panel: { tab: "plan", markdown: sealed.markdown },
    review: { requestId: "rev-1", sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: run.runId, parentRunId: null, createdAt: 3, title: "Review" },
  };
  agg = runtime.transition(agg, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "work_plan.sealed", eventId: "e2", sequence: 2, at: 3, run, workPlan: { id: sealed.id, revision: sealed.revision, digest: sealed.digest, projectionHash: sealed.projectionHash }, sealedPlan: sealed, reviewCommit });
  agg = runtime.transition(agg, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "work_plan.approved", eventId: "e3", sequence: 3, at: 4, run, workPlan: { id: sealed.id, revision: sealed.revision, digest: sealed.digest, projectionHash: sealed.projectionHash }, requestId: "rev-1" });
  agg = runtime.transition(agg, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "phase.changed", eventId: "e4", sequence: 4, at: 5, run, phase: "acting", reason: "approved" });
  agg = runtime.transition(agg, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "command.scheduled", eventId: "e5", sequence: 5, at: 6, run, command: { kind: "execute_tool", idempotencyKey: "mut-1", run, phase: "acting", payload: { toolName: "write_file", arguments: { path: "Assets/MFramework/Core/ServiceContainer.cs" } } } });
  agg = runtime.transition(agg, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "tool.completed", eventId: "e6", sequence: 6, at: 7, run, idempotencyKey: "mut-1", status: "succeeded", evidence: [{ id: "M1", kind: "mutation", target: "Assets/MFramework/Core/ServiceContainer.cs", version: "sha256-abc" }] });

  const outcome = runtime.decideRuntimeV2TerminalOutcome(agg, {
    canceled: false,
    mutationCount: 1,
    passedValidationCount: 0,
    hasAcceptanceValidation: false,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  });
  assert.equal(outcome.resultKind, "success");
  assert.match(outcome.resultReason, /人工\/外部验收清单.*未运行自动测试/);

  const finalProjection = runtime.buildRuntimeV2FinalProjection(agg, "final-1", "success", outcome.resultReason, undefined, "zh");
  assert.match(finalProjection.markdown, /自动测试：未运行/);
  assert.match(finalProjection.markdown, /在 Unity Editor 中编译确认无报错/);
});

test("empty workspace triggers plan_verification_confirmation on 1st validation-only rejection and manual_advisory seals", async () => {
  const h = createPlanHarness({
    responses: [
      { content: "", toolCalls: [{ id: "dir-1", name: "list_directory", arguments: JSON.stringify({ path: "." }) }], protocolViolation: null },
      initialAsk,
      manualPlanSubmission("sub-empty-1", null),
    ],
  });
  const pause1 = await h.run();
  assert.equal(pause1.outcome.status, "paused");
  assert.equal(await h.answerPolicy("no_test"), true);

  const pause2 = await h.run();
  assert.equal(pause2.outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.questionnaire.purpose, "plan_verification_confirmation");
  assert.equal(h.calls.length, 3);

  assert.equal(await h.answerPolicy("manual_advisory"), true);
  h.context.planPurpose = undefined;
  const reviewPause = await h.run();
  assert.equal(reviewPause.outcome.status, "paused");
  assert.equal(h.calls.length, 3);
  assert.equal(h.get().activeActionRequest.kind, "plan_review");
});

test("2 advisory rejections trigger confirmation in non-empty workspace and rejection includes anti-fabrication guidance", async () => {
  const h = createPlanHarness({
    responses: [
      initialAsk,
      manualPlanSubmission("sub-1", null),
      {
        content: "",
        toolCalls: [{
          id: "sub-2",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: "# MFramework 方案\n\n第2次提交仅有编译与断言检查。",
            changes: [{ operation: "create", targets: ["Assets/MFramework/Core/ServiceContainer.cs"], change: "创建 DI 容器骨架。" }],
            validations: [{ kind: "assertion", required: true, expectedOutcome: "手动确认编译无误。" }],
          }),
        }],
        protocolViolation: null,
      },
    ],
  });
  await h.run();
  await h.answerPolicy("no_test");
  const pause2 = await h.run();
  assert.equal(pause2.outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.questionnaire.purpose, "plan_verification_confirmation");
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  const rejected = aggregate.events.filter(event => event.type === "tool.completed" && event.status === "failed");
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].modelContent, /Do NOT fabricate test commands/);
});

test("buildPlanChatProjection preserves GFM tables without collapsing newlines and uses generalized heading", () => {
  const { sealWorkPlanV1 } = runtime;
  const adapter = loader()("src/store/runtimeV2/workPlanAdapter.ts");
  const tableSummary = [
    "## 已确认的决策",
    "",
    "| 决策项 | 用户确认 |",
    "|--------|----------|",
    "| Unity 版本 | **Unity 2022 LTS** |",
    "| 对象池 | 官方 `ObjectPool<T>` |",
    "| 事件总线 | 类型安全 `Action<T>` |",
  ].join("\n");
  const sealed = sealWorkPlanV1({
    draft: {
      schemaVersion: "work-plan.v1",
      objective: "创建 MFramework 框架",
      summary: tableSummary,
      findings: [],
      steps: [{
        title: "创建 Core 目录",
        operation: "create",
        targets: ["Assets/MFramework/Core/MFramework.cs"],
        basis: [],
        change: "新增入口脚本。",
        expectedOutcome: "目录与脚本创建成功。",
        dependsOn: [],
        criterionIds: ["criterion-1"],
      }],
      validations: [{
        stepIndexes: [0],
        kind: "advisory",
        expectedOutcome: "手动编译确认。",
        required: false,
        criterionIds: ["criterion-1"],
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [],
    createdAt: 200,
  });
  const turn = { workspaceKey: "/unity", sessionKey: "/unity:1", sessionEpoch: "epoch-1", clientSubmissionId: "sub-1", turnId: "turn-1" };
  const run = { ...turn, runId: "run-1", parentRunId: null, attemptId: "attempt-1" };
  const commit = adapter.createRuntimeV2PlanReviewCommit({ plan: sealed, turn, run, requestId: "rev-1", createdAt: 200 });
  assert.match(commit.chat.markdown, /^### 实施计划已准备好/m);
  assert.match(commit.chat.markdown, /\| 决策项 \| 用户确认 \|\n\|--------\|----------\|\n\| Unity 版本 \| \*\*Unity 2022 LTS\*\* \|/);
});

test("formatRuntimeV2ToolSchemaHint includes required top-level and item properties for ask_plan_questions", () => {
  const { PLAN_QUESTION_TOOL } = loader()("src/store/runtimeV2/planQuestionTool.ts");
  const { formatRuntimeV2ToolSchemaHint } = loader()("src/store/runtimeV2/executionProviderToolSchema.ts");
  const hint = formatRuntimeV2ToolSchemaHint("ask_plan_questions", [PLAN_QUESTION_TOOL]);
  assert.match(hint, /Required fields for ask_plan_questions: \["title","questions"\]/);
  assert.match(hint, /questions\[\] items require \["id","prompt","selectionMode","options"\]/);
});
