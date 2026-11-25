import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();

test("Capsule model activity builds prompt-digest context and preserves it through waiting -> receiving", () => {
  const { buildCapsuleModelActivityContext } = load("src/lib/capsuleModelContext.ts");
  const { beginCapsuleModelActivity, getCapsuleLiveActivitySnapshot } = load("src/lib/capsuleLiveActivity.ts");

  const turn = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "e1", clientSubmissionId: "s1", turnId: "t1" };
  const run = { sessionKey: "/fixture:1", sessionEpoch: "e1", turnId: "t1", runId: "r1", parentRunId: null, attemptId: "a1" };

  const initialCtx = buildCapsuleModelActivityContext({
    aggregate: { turn, events: [], subagents: [], evidence: [], objective: { text: "/计划 完善架构设计" } },
    estimatedInputTokens: 21_100,
    objectiveText: "/计划 完善架构设计",
  });
  assert.match(initialCtx.detailZh, /正在结合上下文分析「完善架构设计」（约 21\.1k tok）/);

  const readCtx = buildCapsuleModelActivityContext({
    aggregate: {
      turn,
      subagents: [],
      evidence: [],
      objective: { text: "Review MFramework" },
      events: [
        { type: "provider.responded", sequence: 1 },
        { type: "command.scheduled", sequence: 2, command: { idempotencyKey: "cmd-1", kind: "execute_tool", payload: { toolName: "read_file", arguments: { path: "Assets/EventBus.cs" } } } },
        { type: "tool.completed", sequence: 3, idempotencyKey: "cmd-1", status: "succeeded", evidence: [{ target: "Assets/EventBus.cs" }], presentation: { toolName: "read_file", target: "Assets/EventBus.cs" } },
        { type: "tool.completed", sequence: 4, idempotencyKey: "cmd-2", status: "succeeded", evidence: [{ target: "Assets/SaveManager.cs" }], presentation: { toolName: "read_file", target: "Assets/SaveManager.cs" } },
        { type: "tool.completed", sequence: 5, idempotencyKey: "cmd-3", status: "succeeded", evidence: [{ target: "Assets/AudioManager.cs" }], presentation: { toolName: "read_file", target: "Assets/AudioManager.cs" } },
      ],
    },
    estimatedInputTokens: 66_800,
  });
  assert.match(readCtx.detailZh, /正在分析 EventBus\.cs、SaveManager\.cs 等 3 项代码证据（约 66\.8k tok）/);

  const subagentCtx = buildCapsuleModelActivityContext({
    aggregate: {
      turn,
      subagents: [{ id: "j1", scopeKey: "core-arch-review" }, { id: "j2", scopeKey: "module-review-a" }, { id: "j3", scopeKey: "module-review-b" }],
      evidence: [],
      objective: { text: "Review MFramework" },
      events: [
        { type: "provider.responded", sequence: 1 },
        { type: "subagent.completed", sequence: 2, jobId: "j1", status: "completed" },
        { type: "subagent.completed", sequence: 3, jobId: "j2", status: "completed" },
        { type: "subagent.completed", sequence: 4, jobId: "j3", status: "completed" },
      ],
    },
    estimatedInputTokens: 68_400,
  });
  assert.match(subagentCtx.detailZh, /正在综合 core-arch-review、module-review-a 等 3 份子任务报告（约 68\.4k tok）/);

  const controller = new AbortController();
  const act = beginCapsuleModelActivity(run, "cmd-live", controller.signal);
  act.setContext(readCtx);
  const firstToken = act.requestDispatched();
  assert.equal(getCapsuleLiveActivitySnapshot()[0]?.context?.detailZh, readCtx.detailZh);
  firstToken();
  assert.equal(getCapsuleLiveActivitySnapshot()[0]?.stage, "receiving");
  assert.equal(getCapsuleLiveActivitySnapshot()[0]?.context?.detailZh, readCtx.detailZh);
  act.finish();
  assert.equal(getCapsuleLiveActivitySnapshot().length, 0);
});

test("Failed card presentation avoids duplicate 执行失败 badge, explains missing targets & subagent limits, and advertises 6-path limit", () => {
  const { buildLiveTurnProcessTimelineModel } = load("src/lib/turnProcessArchive.ts");
  const { reconcileRuntimeV2TimelineBlocks } = load("src/store/runtimeV2/projectionTimeline.ts");
  const { TOOL_DEFINITIONS } = load("src/lib/toolSchemas.ts");

  const run = { turnId: "turn-1", runId: "run-1" };
  const aggregate = {
    run: { identity: run },
    completedCommands: [
      { idempotencyKey: "cmd-read", status: "failed" },
      { idempotencyKey: "cmd-sub", status: "failed" },
    ],
    events: [
      {
        type: "tool.completed",
        idempotencyKey: "cmd-read",
        run,
        status: "failed",
        failureKind: "execution_failed",
        failureReasonCode: "target_not_found",
        modelContent: "PLAN_READ_FAILED: ENOENT",
        presentation: { toolName: "read_file", target: "DataManager.cs", message: "目标路径不存在，需先通过目录列表确认真实文件名。" },
      },
      {
        type: "command.scheduled",
        run,
        command: {
          idempotencyKey: "cmd-sub",
          kind: "execute_tool",
          run,
          payload: {
            toolName: "spawn_subagent",
            arguments: { allowed_paths: "a,b,c,d,e,f,g" },
          },
        },
      },
      {
        type: "tool.completed",
        idempotencyKey: "cmd-sub",
        run,
        status: "failed",
        failureKind: "execution_failed",
        modelContent: "allowed_paths must contain at most 6 paths",
      },
    ],
  };

  const blocks = [
    { id: 1, type: "tool", ...run, toolCallId: "cmd-read", toolName: "read_file", target: "DataManager.cs", status: "running", toolStatus: "running" },
    { id: 2, type: "tool", ...run, toolCallId: "cmd-sub", toolName: "spawn_subagent", target: "module-review", status: "running", toolStatus: "running" },
  ];
  const projected = reconcileRuntimeV2TimelineBlocks(blocks, aggregate, 10, "zh");
  assert.match(projected[0].message, /目标路径不存在/);
  assert.match(projected[1].message, /超出 6 个上限/);

  const timeline = buildLiveTurnProcessTimelineModel({ blocks: projected, language: "zh", includeThoughts: false });
  assert.match(timeline.steps[0].activity.title, /^探索受阻/);
  assert.doesNotMatch(timeline.steps[0].activity.title, /^执行失败/);
  assert.match(timeline.steps[1].activity.title, /^动作受阻/);

  const spawnTool = TOOL_DEFINITIONS.find((def) => def.function.name === "spawn_subagent");
  assert.match(spawnTool.function.parameters.properties.required_paths.description, /最多 6 个/);
  assert.match(spawnTool.function.parameters.properties.allowed_paths.description, /最多 6 个/);
});

test("/grill-me and explicit questions enforce interview while ordinary workspace /plan bypasses mandatory interview and allows voluntary questions", async () => {
  const { parseGrillMeCommand, requestsExplicitPlanInterview } = load("src/lib/grillMe.ts");
  const { planModelTools } = load("src/store/runtimeV2/planModelProtocol.ts");
  const { buildWorkspaceComposerIntentDispatchHints } = load("src/store/workspaceComposerIntentAdmission.ts");
  const { runRuntimeV2PlanInterview } = load("src/store/runtimeV2/planInterview.ts");

  assert.deepEqual(parseGrillMeCommand("/grill-me 设计缓存方案"), { kind: "grill_me", command: "/grill-me", request: "设计缓存方案" });
  assert.deepEqual(parseGrillMeCommand("/追问 架构选型"), { kind: "grill_me", command: "/追问", request: "架构选型" });
  assert.equal(parseGrillMeCommand("/grill-more foo"), null);

  assert.equal(requestsExplicitPlanInterview("先向我提问不清楚的地方再出方案"), true);
  assert.equal(requestsExplicitPlanInterview("不要问我，直接给方案"), false);

  const hints = buildWorkspaceComposerIntentDispatchHints({
    text: "/grill-me 设计缓存方案",
    language: "zh",
    snapshot: { mainModeKey: "main_mode", lockedComposerIntent: null, subagentPreference: "unspecified" },
  });
  assert.equal(hints.explicitIntent, "plan");
  assert.equal(hints.planPurpose, "plan");
  assert.equal(hints.planInterviewMode, "grill");

  const toolsForLegacyWorkspacePlan = planModelTools({
    runWorkspace: "/fixture",
    runSessionKey: "/fixture:1",
    planPurpose: undefined,
    turnInputContextSignals: { subagentPreference: "unspecified", subagentRequirement: "optional", attachedFilePaths: [] },
  });
  assert.equal(toolsForLegacyWorkspacePlan.some((t) => t.function.name === "ask_plan_questions"), false);

  const toolsForOrdinaryWorkspacePlan = planModelTools({
    runWorkspace: "/fixture",
    runSessionKey: "/fixture:1",
    planPurpose: undefined,
    allowVoluntaryPlanQuestions: true,
    turnInputContextSignals: { subagentPreference: "unspecified", subagentRequirement: "optional", attachedFilePaths: [] },
  });
  assert.equal(toolsForOrdinaryWorkspacePlan.some((t) => t.function.name === "ask_plan_questions"), true);

  const interviewBypassed = await runRuntimeV2PlanInterview({
    get: () => ({
      currentTurnId: "t1",
      conversationTurns: [{ id: "t1", userPrompt: "/计划 分析项目" }],
      runtimeV2Checkpoints: {},
    }),
    set: () => {},
    context: {
      turnId: "t1",
      runWorkspace: "/fixture",
      runScopeKey: "/fixture",
      runSessionKey: "/fixture:1",
      runSessionEpoch: "e1",
      runSessionId: 1,
      harnessRunId: "r1",
      phaseLanguage: "zh",
      planPurpose: undefined,
      abortCtrl: new AbortController(),
      turnInputContextSignals: { subagentPreference: "unspecified", subagentRequirement: "optional", attachedFilePaths: [] },
    },
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (x) => x,
    buildSessionRuntimeSnapshot: (x) => x,
    publishOwnerScopedRuntimeProjection: () => ({ published: true }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: () => {},
  });
  assert.equal(interviewBypassed, null);

  const runtimeLib = load("src/lib/runtime-v2/index.ts");
  const turnId = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "e1", clientSubmissionId: "s1", turnId: "t-vol" };
  const runId = { sessionKey: "/fixture:1", sessionEpoch: "e1", turnId: "t-vol", runId: "r-vol", parentRunId: null, attemptId: "a1" };
  let resumedAgg = runtimeLib.transition(null, { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "e1", sequence: 0, at: 1, type: "turn.admitted", turn: turnId, strategy: "plan", objective: "/计划 分析项目", constraints: [], acceptanceCriteria: [] });
  resumedAgg = runtimeLib.transition(resumedAgg, { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "e2", sequence: 1, at: 2, type: "run.started", run: runId, phase: "planning" });
  resumedAgg = runtimeLib.transition(resumedAgg, { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "e3", sequence: 2, at: 3, type: "run.paused", run: runId, blocker: { requestId: "req-1", reasonCode: "user_questionnaire", evidenceSequence: 1, message: "确认分工", options: ["recheck", "stop"], questionnaire: { revision: 1, purpose: "plan_interview", title: "确认分工", questions: [{ id: "q1", prompt: "优先哪部分？", selectionMode: "single", required: true, options: [{ id: "core", label: "Core" }] }] } } });
  const resumedCheckpoint = runtimeLib.createRuntimeV2Checkpoint({ aggregate: resumedAgg, revision: resumedAgg.nextSequence, updatedAt: resumedAgg.updatedAt });
  const voluntaryResumeBypass = await runRuntimeV2PlanInterview({
    get: () => ({
      currentTurnId: "t-vol",
      conversationTurns: [{ id: "t-vol", userPrompt: "/计划 分析项目" }],
      planLifecycle: { sessionKey: "/fixture:1", sessionEpoch: "e1" },
      runtimeV2Checkpoints: { "t-vol": resumedCheckpoint },
    }),
    set: () => {},
    context: {
      turnId: "t-vol",
      runWorkspace: "/fixture",
      runScopeKey: "/fixture",
      runSessionKey: "/fixture:1",
      runSessionEpoch: "e1",
      runSessionId: 1,
      harnessRunId: "r-vol",
      phaseLanguage: "zh",
      planPurpose: undefined,
      abortCtrl: new AbortController(),
      turnInputContextSignals: { subagentPreference: "unspecified", subagentRequirement: "optional", attachedFilePaths: [] },
    },
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (x) => x,
    buildSessionRuntimeSnapshot: (x) => x,
    publishOwnerScopedRuntimeProjection: () => ({ published: true }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: () => {},
  });
  assert.equal(voluntaryResumeBypass, null);
});

test("explicit /计划 and /grill-me skip redundant semantic preflight when no continuation ambiguity exists", () => {
  const { resolveAndApplySubmitIntentRouting } = load("src/store/submitIntentRouting.ts");
  const preflights = [];
  const logs = [];
  const base = {
    images: undefined,
    preferredLanguage: "zh",
    currentMainModeKey: "main_mode",
    hasWorkspace: true,
    isHidden: false,
    autoApproveTools: false,
    fallbackRunIntent: "respond",
    mainDebugShortcut: null,
    mainIntentShortcut: null,
    lockedComposerIntent: null,
    currentTurn: null,
    currentTurnIntent: "respond",
    hasPlanArtifacts: false,
    planContinuationCandidates: [],
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
    currentConfig: {},
    sendOriginSessionKey: "/fixture:1",
    setState: () => {},
    applyPreRunSessionPatch: () => {},
    approvePlan: () => {},
    startPlanExecutionResume: () => {},
    startBlockingPreflight: (effect) => preflights.push(effect),
    logStoreEvent: (event, data) => logs.push({ event, data }),
  };

  const planRes = resolveAndApplySubmitIntentRouting({
    ...base,
    text: "/计划 分析 MFramework",
    mainIntentShortcut: { intent: "plan", command: "/计划", rest: "分析 MFramework" },
    options: { explicitIntent: "plan" },
  });
  assert.equal(planRes.handled, false);
  assert.equal(planRes.effectiveRunIntent, "plan");
  assert.equal(preflights.length, 0);

  const grillRes = resolveAndApplySubmitIntentRouting({
    ...base,
    text: "/grill-me 梳理需求",
    options: { explicitIntent: "plan", planPurpose: "plan", planInterviewMode: "grill" },
  });
  assert.equal(grillRes.handled, false);
  assert.equal(preflights.length, 0);

  const withCandidate = resolveAndApplySubmitIntentRouting({
    ...base,
    text: "/计划 继续那个方案",
    mainIntentShortcut: { intent: "plan", command: "/计划", rest: "继续那个方案" },
    options: { explicitIntent: "plan" },
    planContinuationCandidates: [{ turnId: "prev-1", title: "Old Plan", summary: "...", status: "approved" }],
  });
  assert.equal(withCandidate.handled, true);
  assert.equal(preflights.length, 1);
  assert.equal(logs.at(-1).event, "turn_intent_semantic_requested");
});

test("Sidebar chat height clamps cleanly to container and min bounds", () => {
  const { clampSidebarChatSectionHeight, DEFAULT_SIDEBAR_CHAT_HEIGHT, MIN_SIDEBAR_CHAT_HEIGHT } = load("src/lib/sidebarLayout.ts");
  assert.equal(clampSidebarChatSectionHeight(50, 500), MIN_SIDEBAR_CHAT_HEIGHT);
  assert.equal(clampSidebarChatSectionHeight(450, 500), 336);
  assert.equal(clampSidebarChatSectionHeight(Number.NaN, 500), DEFAULT_SIDEBAR_CHAT_HEIGHT);
});

test("planDocumentRunner does not inject duplicate prose on rejectedAdmission wait_subagents and breaks infinite loops", async () => {
  const calls = [];
  let state = {
    currentTurnId: "t-loop",
    currentSessionId: 1,
    conversationTurns: [{ id: "t-loop", clientSubmissionId: "s-loop", userPrompt: "Plan something" }],
    config: {},
    planLifecycle: { sessionKey: "/fixture:1", sessionEpoch: "e1" },
    runtimeV2Checkpoints: {},
    taskFlow: [],
    harnessRunMarker: { sessionKey: "/fixture:1", turnId: "t-loop", runId: "r-loop", status: "running", startedAt: 1, instanceId: "i1" },
    _nextTaskId: () => 1,
  };
  let runtimeLib;
  const customLoad = createTsModuleLoader({
    "../../lib/streaming": {
      isStreamOutputLimited: () => false,
      streamChatCompletion: async (messages) => {
        calls.push(messages.map((m) => ({ role: m.role, content: String(m.content || "") })));
        return {
          content: "",
          toolCalls: [{ id: `wait-${calls.length}`, name: "wait_subagents", arguments: "{}" }],
          protocolViolation: null,
        };
      },
    },
    "../../lib/modelLaneCoordinator": {
      acquireModelLane: async () => ({ release() {}, markFirstToken() {}, reportFailure() {}, setPressureHandler() {} }),
    },
    "../../lib/providerLaneSettings": {
      deriveBudgetedStreamSettings: () => ({ provider: "fixture", toolProtocol: "auto" }),
      deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
    },
    "./checkpointPort": {
      getRuntimeV2Checkpoint: (_s, owner) => state.runtimeV2Checkpoints[owner.turnId] || null,
      createRuntimeV2CheckpointPort: () => ({
        append: async (input) => {
          const result = runtimeLib.appendRuntimeV2Checkpoint({
            checkpoint: state.runtimeV2Checkpoints[input.owner.turnId] || null,
            owner: input.owner,
            expectedRevision: input.expectedRevision,
            event: input.event,
          });
          state = { ...state, runtimeV2Checkpoints: { ...state.runtimeV2Checkpoints, [input.owner.turnId]: result.checkpoint } };
          return result;
        },
      }),
    },
    "./projectionPort": {
      createRuntimeV2ProjectionPort: () => ({ publish: async () => undefined }),
    },
  });
  runtimeLib = customLoad("src/lib/runtime-v2/index.ts");
  const { runRuntimeV2PlanInterview } = customLoad("src/store/runtimeV2/planInterview.ts");

  const settlement = await runRuntimeV2PlanInterview({
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    context: {
      turnId: "t-loop",
      uiDisplayTurnId: "t-loop",
      runWorkspace: "/fixture",
      runScopeKey: "/fixture",
      runSessionKey: "/fixture:1",
      runSessionEpoch: "e1",
      runSessionId: 1,
      harnessRunId: "r-loop",
      phaseLanguage: "zh",
      planPurpose: "plan",
      planInterviewMode: "grill",
      abortCtrl: new AbortController(),
      turnInputContextSignals: { subagentPreference: "unspecified", subagentRequirement: "optional", attachedFilePaths: [] },
      runtimeContextBudget: { contextLimit: 32768, outputBudget: 4096, inputBudget: 28672, readWindowChars: 16000 },
    },
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (x) => x,
    buildSessionRuntimeSnapshot: (x) => x,
    publishOwnerScopedRuntimeProjection: () => ({ published: true }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: () => {},
  });

  assert.equal(calls.length, 4);
  assert.equal(settlement.outcome.resultKind, "error");
  const secondCallToolMsg = calls[1].find((m) => m.role === "tool")?.content || "";
  assert.match(secondCallToolMsg, /All spawned planning subagents have ALREADY completed/);
  assert.equal(
    calls[1].some((m) => m.role === "system" && m.content.includes("No document has been saved")),
    false,
  );
});
