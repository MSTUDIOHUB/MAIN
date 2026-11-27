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

test("explicit /计划 and /grill-me trigger semantic preflight to extract read restrictions before bootstrap", () => {
  const { resolveAndApplySubmitIntentRouting } = load("src/store/submitIntentRouting.ts");
  const { inferExplicitWorkspaceReadGuardsFromText } = load("src/lib/turnCapabilities.ts");
  assert.deepEqual(inferExplicitWorkspaceReadGuardsFromText("/计划 不要读取任何工作区文件"), {
    forbiddenWorkspaceRead: true,
    approvalRequiredWorkspaceRead: false,
  });
  assert.deepEqual(inferExplicitWorkspaceReadGuardsFromText("/计划 每次读取项目文件前先问我"), {
    forbiddenWorkspaceRead: false,
    approvalRequiredWorkspaceRead: true,
  });

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

  const forbiddenReadPlan = resolveAndApplySubmitIntentRouting({
    ...base,
    text: "/计划 不要读取任何工作区文件",
    mainIntentShortcut: { intent: "plan", command: "/计划", rest: "不要读取任何工作区文件" },
    options: { explicitIntent: "plan" },
  });
  assert.equal(forbiddenReadPlan.handled, true);
  assert.equal(preflights.length, 1);
  assert.equal(preflights[0].request.explicitIntent, "plan");
  assert.equal(logs.at(-1).event, "turn_intent_semantic_requested");

  const approvalReadPlan = resolveAndApplySubmitIntentRouting({
    ...base,
    text: "/计划 每次读取项目文件前先问我",
    mainIntentShortcut: { intent: "plan", command: "/计划", rest: "每次读取项目文件前先问我" },
    options: { explicitIntent: "plan" },
  });
  assert.equal(approvalReadPlan.handled, true);
  assert.equal(preflights.length, 2);
  assert.equal(preflights[1].request.explicitIntent, "plan");

  const grillRes = resolveAndApplySubmitIntentRouting({
    ...base,
    text: "/grill-me 梳理需求",
    options: { explicitIntent: "plan", planPurpose: "plan", planInterviewMode: "grill" },
  });
  assert.equal(grillRes.handled, true);
  assert.equal(preflights.length, 3);
  assert.equal(preflights[2].request.explicitIntent, "plan");

  const resolvedPlan = resolveAndApplySubmitIntentRouting({
    ...base,
    text: "/计划 不要读取任何工作区文件",
    mainIntentShortcut: { intent: "plan", command: "/计划", rest: "不要读取任何工作区文件" },
    options: {
      explicitIntent: "plan",
      resolvedIntent: "plan",
      skipIntentResolution: true,
      semanticIntent: {
        intent: "plan",
        confidence: 1,
        source: "model_semantic_preflight",
        forbiddenCapabilities: ["workspace_read"],
        approvalRequiredCapabilities: [],
      },
    },
  });
  assert.equal(resolvedPlan.handled, false);
  assert.equal(resolvedPlan.effectiveRunIntent, "plan");
  assert.equal(preflights.length, 3);
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
    config: { activeProfile: "local", local: { provider: "OMLX", endpoint: "http://fixture.invalid/v1", model: "fixture-model" }, cloud: {}, cloudServers: [] },
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
      getRuntimeV2EmergencyTerminalEnvelope: (_s, owner) => state.runtimeV2EmergencyTerminalEnvelopes?.[owner.turnId] || null,
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

test("Capsule filters evicted evidence by retained outbound messages and formats live OMLX prompt progress", () => {
  const {
    buildCapsuleModelActivityContext,
    formatCapsuleModelDetailWithProgress,
  } = load("src/lib/capsuleModelContext.ts");
  const { extractStreamPromptProgress } = load("src/lib/streaming.ts");

  const turn = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "e1", clientSubmissionId: "s1", turnId: "t-evict" };
  const baseEvents = [
    { type: "provider.responded", sequence: 1 },
    { type: "command.scheduled", sequence: 2, command: { idempotencyKey: "cmd-evict", kind: "execute_tool", payload: { toolName: "read_file", arguments: { path: "Assets/OldEvicted.cs" } } } },
    { type: "tool.completed", sequence: 3, idempotencyKey: "cmd-evict", status: "succeeded", evidence: [{ target: "Assets/OldEvicted.cs" }], presentation: { toolName: "read_file", target: "Assets/OldEvicted.cs" } },
    { type: "command.scheduled", sequence: 4, command: { idempotencyKey: "cmd-kept", kind: "execute_tool", payload: { toolName: "read_file", arguments: { path: "Assets/SaveManager.cs" } } } },
    { type: "tool.completed", sequence: 5, idempotencyKey: "cmd-kept", status: "succeeded", evidence: [{ target: "Assets/SaveManager.cs" }], presentation: { toolName: "read_file", target: "Assets/SaveManager.cs" } },
  ];
  const messages = [
    { role: "user", content: "Review MFramework" },
    { role: "tool", tool_call_id: "cmd-kept", content: "SaveManager.cs contents" },
    { role: "system", content: "[runtime-v2 context: child:j-kept]\ncore-arch-review summary" },
  ];

  const subagentAggregate = {
    turn,
    subagents: [
      { id: "j-evicted", scopeKey: "old-worker" },
      { id: "j-kept", scopeKey: "core-arch-review" },
    ],
    evidence: [],
    objective: { text: "Review MFramework" },
    events: [
      ...baseEvents,
      { type: "subagent.completed", sequence: 6, jobId: "j-evicted", status: "completed" },
      { type: "subagent.completed", sequence: 7, jobId: "j-kept", status: "completed" },
    ],
  };

  const subagentCtx = buildCapsuleModelActivityContext({
    aggregate: subagentAggregate,
    messages,
    estimatedInputTokens: 45_200,
  });
  assert.doesNotMatch(subagentCtx.detailZh, /OldEvicted\.cs|old-worker/);
  assert.match(subagentCtx.detailZh, /core-arch-review/);

  const readCtx = buildCapsuleModelActivityContext({
    aggregate: {
      turn,
      subagents: [],
      evidence: [],
      objective: { text: "Review MFramework" },
      events: baseEvents,
    },
    messages,
    estimatedInputTokens: 45_200,
  });
  assert.doesNotMatch(readCtx.detailZh, /OldEvicted\.cs/);
  assert.match(readCtx.detailZh, /SaveManager\.cs/);

  const progress = extractStreamPromptProgress({
    prompt_progress: { processed_tokens: 18400, total_tokens: 64000 },
  });
  assert.deepEqual(progress, { processedTokens: 18400, totalTokens: 64000 });
  const detail = formatCapsuleModelDetailWithProgress(subagentCtx, progress, "zh");
  assert.match(detail, /已处理 18\.4k \/ 64k tok · 29%/);
});

test("Workspace read error classifier separates escape/missing/permission and stopped archive card preserves reason", () => {
  const {
    classifyWorkspaceReadFailure,
    describeWorkspaceToolFailure,
  } = load("src/lib/workspaceToolFailure.ts");
  const { buildTurnProcessArchiveModel } = load("src/lib/turnProcessArchive.ts");

  assert.equal(
    classifyWorkspaceReadFailure("READ_PATH_OUT_OF_WORKSPACE: path escapes canonical workspace root")?.code,
    "path_out_of_workspace",
  );
  assert.equal(
    classifyWorkspaceReadFailure("READ_TARGET_INACCESSIBLE: Permission denied")?.code,
    "target_inaccessible",
  );
  assert.equal(
    classifyWorkspaceReadFailure("路径越界、不存在或无法访问: Permission denied")?.code,
    "target_inaccessible",
  );
  assert.equal(
    classifyWorkspaceReadFailure("READ_TARGET_NOT_FOUND: workspace path is missing")?.code,
    "target_not_found",
  );
  assert.match(
    describeWorkspaceToolFailure("subagent_path_limit_exceeded", "zh")?.cardMessage || "",
    /超出 6 个上限/,
  );

  const archive = buildTurnProcessArchiveModel({
    blocks: [
      {
        id: "cmd-subagent",
        type: "tool",
        toolCallId: "cmd-subagent",
        toolName: "spawn_subagent",
        status: "error",
        toolStatus: "failed",
        target: "core-arch-review",
        summary: "子智能体单次路径超出 6 个上限，需按模块拆分后派发。",
        message: "子智能体单次路径超出 6 个上限，需按模块拆分后派发。",
      },
    ],
    finalVisibleAgentIndex: -1,
    language: "zh",
    includeThoughts: false,
  });
  assert.equal(archive.steps.length, 1);
  assert.match(archive.steps[0].activity?.title || "", /动作受阻：派发子智能体/);
  const detailText = [
    archive.steps[0].summary,
    archive.steps[0].result,
    archive.steps[0].note,
    archive.steps[0].activity?.summary,
  ].filter(Boolean).join("\n");
  assert.match(detailText, /core-arch-review/);
  assert.match(detailText, /超出 6 个上限/);
});

test("requestsExplicitPlanInterview matches 先询问我几个关键问题 and Global Plan cold-restore finishes save without re-calling model", async () => {
  const { requestsExplicitPlanInterview } = load("src/lib/grillMe.ts");
  assert.equal(requestsExplicitPlanInterview("/计划 先询问我几个关键问题再写方案"), true);

  let runtimeLib;
  let state = {
    currentTurnId: "t-global-restore",
    currentSessionId: 1,
    conversationTurns: [{ id: "t-global-restore", clientSubmissionId: "s-gr", userPrompt: "/计划 整理架构目标" }],
    config: { activeProfile: "local", local: { provider: "OMLX", endpoint: "http://fixture.invalid/v1", model: "fixture-model" }, cloud: {}, cloudServers: [] },
    planLifecycle: { sessionKey: "__MAIN_GLOBAL_CHAT__:1", sessionEpoch: "e1" },
    runtimeV2Checkpoints: {},
    taskFlow: [],
    harnessRunMarker: { sessionKey: "__MAIN_GLOBAL_CHAT__:1", turnId: "t-global-restore", runId: "r-gr", status: "running", startedAt: 1, instanceId: "i1" },
    _nextTaskId: () => 1,
  };
  let streamCallCount = 0;
  let forbidModelCalls = false;
  let savedDocs = 0;
  const stored = new Map();
  const customLoad = createTsModuleLoader({
    "../../lib/streaming": {
      isStreamOutputLimited: () => false,
      streamChatCompletion: async () => {
        if (forbidModelCalls) {
          throw new Error("Global Plan cold restore after submit_plan_document must not re-call model");
        }
        streamCallCount += 1;
        return {
          content: "",
          toolCalls: [{
            id: "sub-1",
            name: "submit_plan_document",
            arguments: JSON.stringify({ title: "Global Plan", markdown: "# Global Plan\n\nConfirmed goal.\n" }),
          }],
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
    "../../lib/ipc": {
      savePlanDocument: async (input) => {
        savedDocs += 1;
        const { sha256Hex } = load("src/lib/sha256.ts");
        const reference = {
          owner: input.owner,
          documentId: input.documentId,
          revision: 1,
          contentHash: sha256Hex(input.markdown),
          path: "stored/global-plan/rev-1.md",
          title: input.title,
          kind: input.kind,
        };
        stored.set(`${input.owner.sessionKey}:${input.documentId}`, { ...reference, markdown: input.markdown });
        return reference;
      },
      readPlanDocument: async (reference) => stored.get(`${reference.owner.sessionKey}:${reference.documentId}`) || {
        ...reference,
        markdown: "# Global Plan\n\nConfirmed goal.\n",
      },
    },
    "./checkpointPort": {
      getRuntimeV2Checkpoint: (_s, owner) => state.runtimeV2Checkpoints[owner.turnId] || null,
      getRuntimeV2EmergencyTerminalEnvelope: (_s, owner) => state.runtimeV2EmergencyTerminalEnvelopes?.[owner.turnId] || null,
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

  const ctx = {
    turnId: "t-global-restore",
    uiDisplayTurnId: "t-global-restore",
    runWorkspace: "",
    runScopeKey: "__MAIN_GLOBAL_CHAT__",
    runSessionKey: "__MAIN_GLOBAL_CHAT__:1",
    runSessionEpoch: "e1",
    runSessionId: 1,
    harnessRunId: "r-gr",
    phaseLanguage: "zh",
    planPurpose: undefined,
    abortCtrl: new AbortController(),
    turnInputContextSignals: { subagentPreference: "unspecified", subagentRequirement: "optional", attachedFilePaths: [] },
    runtimeContextBudget: { contextLimit: 32768, outputBudget: 4096, inputBudget: 28672, readWindowChars: 16000 },
  };
  const baseDeps = {
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    context: ctx,
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (x) => x,
    buildSessionRuntimeSnapshot: (x) => x,
    publishOwnerScopedRuntimeProjection: () => ({ published: true }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: () => {},
  };

  await runRuntimeV2PlanInterview(baseDeps);
  const fullEvents = state.runtimeV2Checkpoints["t-global-restore"]?.aggregate?.events || [];
  const providerIdx = fullEvents.findIndex(
    (event) => event.type === "provider.responded" && event.result.toolCalls.some((call) => call.name === "submit_plan_document"),
  );
  assert.ok(providerIdx >= 0);

  let rewound = null;
  const turn = { workspaceKey: "__MAIN_GLOBAL_CHAT__", sessionKey: "__MAIN_GLOBAL_CHAT__:1", sessionEpoch: "e1", clientSubmissionId: "s-gr", turnId: "t-global-restore" };
  for (const event of fullEvents.slice(0, providerIdx + 1)) {
    const res = runtimeLib.appendRuntimeV2Checkpoint({
      checkpoint: rewound,
      owner: turn,
      expectedRevision: rewound?.revision || 0,
      event,
    });
    assert.equal(res.disposition, "committed");
    rewound = res.checkpoint;
  }
  state = {
    ...state,
    conversationTurns: [{ id: "t-global-restore", clientSubmissionId: "s-gr", userPrompt: "/计划 整理架构目标" }],
    runtimeV2Checkpoints: { "t-global-restore": rewound },
  };
  forbidModelCalls = true;
  savedDocs = 0;

  const settlement = await runRuntimeV2PlanInterview(baseDeps);
  assert.equal(streamCallCount, 1);
  assert.equal(savedDocs, 1);
  assert.equal(settlement.outcome.status, "completed");
  assert.equal(
    state.runtimeV2Checkpoints["t-global-restore"]?.aggregate?.terminalOutcome?.resultKind,
    "success",
  );
});

test("WorkPlan planRunner switches to narrowed synthesis after repeated wait_subagents rejections and stops after 4 surface rejections without duplicating receipts", async () => {
  const calls = [];
  let runtimeLib;
  let state = {
    currentTurnId: "t-wp-loop",
    currentSessionId: 1,
    conversationTurns: [{ id: "t-wp-loop", clientSubmissionId: "s-wp", userPrompt: "/计划 设计重构方案" }],
    config: { activeProfile: "local", local: { provider: "OMLX", endpoint: "http://fixture.invalid/v1", model: "fixture-model" }, cloud: {}, cloudServers: [] },
    planLifecycle: { sessionKey: "/fixture:1", sessionEpoch: "e1" },
    runtimeV2Checkpoints: {},
    taskFlow: [],
    harnessRunMarker: { sessionKey: "/fixture:1", turnId: "t-wp-loop", runId: "r-wp", status: "running", startedAt: 1, instanceId: "i1" },
    _nextTaskId: () => 1,
  };
  const customLoad = createTsModuleLoader({
    "../../lib/streaming": {
      isStreamOutputLimited: () => false,
      streamChatCompletion: async (messages, _settings, _callbacks, _signal, tools, _maxOutputTokens, requestOptions) => {
        calls.push({
          messages: messages.map((m) => ({ role: m.role, content: String(m.content || "") })),
          tools: Array.isArray(tools) ? tools.map((t) => t?.function?.name || t?.name) : [],
          requestOptions: requestOptions ?? null,
        });
        return {
          content: "",
          toolCalls: [{ id: `wp-wait-${calls.length}`, name: "wait_subagents", arguments: "{}" }],
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
    "../../lib/toolExecutor": {
      executeTool: async (name) => (name === "get_project_skeleton" ? "Assets/SaveManager.cs" : "SaveManager source body"),
    },
    "../../lib/ipc": {
      inspectProjectInitTarget: async () => ({ canonicalWorkspace: "/fixture", targetPath: "/fixture/AGENTS.md", exists: false }),
    },
    "./checkpointPort": {
      getRuntimeV2Checkpoint: (_s, owner) => state.runtimeV2Checkpoints[owner.turnId] || null,
      getRuntimeV2EmergencyTerminalEnvelope: (_s, owner) => state.runtimeV2EmergencyTerminalEnvelopes?.[owner.turnId] || null,
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
  const { runSubmitRuntimeV2Plan } = customLoad("src/store/runtimeV2/planRunner.ts");

  const turn = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "e1", clientSubmissionId: "s-wp", turnId: "t-wp-loop" };
  const run = { sessionKey: "/fixture:1", sessionEpoch: "e1", turnId: "t-wp-loop", runId: "r-wp", parentRunId: null, attemptId: "r-wp" };
  let seededCheckpoint = null;
  for (const event of [
    { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "w1", sequence: 0, at: 1, type: "turn.admitted", turn, strategy: "plan", objective: "/计划 设计重构方案", constraints: [], acceptanceCriteria: [] },
    { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "w2", sequence: 1, at: 2, type: "run.started", run, phase: "planning" },
    { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "w3", sequence: 2, at: 3, type: "observation.recorded", run, evidence: { id: "E1", kind: "source", target: "Assets/SaveManager.cs", version: "sha256-1" } },
  ]) {
    const res = runtimeLib.appendRuntimeV2Checkpoint({
      checkpoint: seededCheckpoint,
      owner: turn,
      expectedRevision: seededCheckpoint?.revision || 0,
      event,
    });
    assert.equal(res.disposition, "committed");
    seededCheckpoint = res.checkpoint;
  }
  state.runtimeV2Checkpoints["t-wp-loop"] = seededCheckpoint;

  const settlement = await runSubmitRuntimeV2Plan({
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    context: {
      turnId: "t-wp-loop",
      uiDisplayTurnId: "t-wp-loop",
      runWorkspace: "/fixture",
      runScopeKey: "/fixture",
      runSessionKey: "/fixture:1",
      runSessionEpoch: "e1",
      runSessionId: 1,
      harnessRunId: "r-wp",
      phaseLanguage: "zh",
      planPurpose: undefined,
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

  assert.equal(calls.length, 5);
  assert.equal(settlement.outcome.resultKind, "error");
  const rejectionCounts = calls.map((c) => c.messages.filter((m) => m.role === "tool" && m.content.includes("PLAN_TOOL_NOT_ADVERTISED:")).length);
  assert.deepEqual(rejectionCounts, [0, 1, 1, 1, 1]);
  assert.equal(calls[2].requestOptions?.responseFormat?.type, "json_schema");
  assert.equal(calls[2].tools.length, 0);
  assert.ok(!calls[3].tools.includes("wait_subagents"));
  assert.ok(!calls[3].tools.includes("read_file"));
});

test("normalizeRuntimeV2ProviderToolCalls recovers spilled parameter JSON and strips pseudo closing tags", () => {
  const { normalizeRuntimeV2ProviderToolCalls } = load("src/store/runtimeV2/executionProviderToolSchema.ts");
  const { SUBMIT_WORK_PLAN_TOOL } = load("src/store/runtimeV2/planModelProtocol.ts");
  const spilledChanges = [{
    title: "修复对象池核心实现",
    operation: "modify",
    targets: ["Assets/MFramework/Pool/ObjectPoolManager.cs"],
    change: "重写 ObjectPoolBase",
  }];

  const fromXmlSpill = normalizeRuntimeV2ProviderToolCalls([{
    id: "call-xml-spill",
    name: SUBMIT_WORK_PLAN_TOOL.function.name,
    arguments: {
      planMarkdown: "2. 对象池测试正常工作\n3. 计时器无泄漏*/planMarkdown*\n<parameter=changes>\n" + JSON.stringify(spilledChanges) + "\n</parameter>",
      validations: [{ kind: "assertion", expectedOutcome: "手动核对编译" }],
    },
  }], [SUBMIT_WORK_PLAN_TOOL]);
  assert.deepEqual(fromXmlSpill[0].arguments.changes, spilledChanges);
  assert.equal(fromXmlSpill[0].arguments.planMarkdown, "2. 对象池测试正常工作\n3. 计时器无泄漏");

  const fromStrippedSpill = normalizeRuntimeV2ProviderToolCalls([{
    id: "call-stripped-spill",
    name: SUBMIT_WORK_PLAN_TOOL.function.name,
    arguments: {
      planMarkdown: "4. 代码审查已完成*/planMarkdown*\n\n" + JSON.stringify(spilledChanges),
      validations: [{ kind: "assertion", expectedOutcome: "手动核对编译" }],
    },
  }], [SUBMIT_WORK_PLAN_TOOL]);
  assert.deepEqual(fromStrippedSpill[0].arguments.changes, spilledChanges);
  assert.equal(fromStrippedSpill[0].arguments.planMarkdown, "4. 代码审查已完成");
});

test("ordinary workspace Plan with advisory validations seals directly, repairs missing changes once, and suppresses English commentary", async () => {
  let state = {
    currentTurnId: "t-adapt",
    currentSessionId: 1,
    conversationTurns: [{ id: "t-adapt", clientSubmissionId: "s-adapt", userPrompt: "/计划 评估 Unity 框架代码", blockIds: [] }],
    config: { activeProfile: "local", local: { provider: "OMLX", endpoint: "http://fixture.invalid/v1", model: "fixture-model" }, cloud: {}, cloudServers: [] },
    planLifecycle: { sessionKey: "/fixture:1", sessionEpoch: "e1" },
    taskFlow: [],
    runtimeEvents: [],
    runtimeV2Checkpoints: {},
    harnessRunMarker: { sessionKey: "/fixture:1", turnId: "t-adapt", runId: "r-adapt", status: "running", startedAt: 1, instanceId: "i1" },
    _nextTaskId: () => state.taskFlow.length + 1,
  };
  const calls = [];
  const logEvents = [];
  let runtimeLib;
  let customLoad;
  customLoad = createTsModuleLoader({
    "@tauri-apps/api/core": { invoke: async () => null },
    "@tauri-apps/api/event": { listen: async () => () => {} },
    "@tauri-apps/plugin-dialog": { open: async () => null },
    "@tauri-apps/plugin-opener": { open: async () => null },
    "@tauri-apps/plugin-process": { relaunch: async () => {}, exit: async () => {} },
    "@tauri-apps/plugin-updater": { check: async () => null },
    "../../lib/streaming": {
      isStreamOutputLimited: () => false,
      streamChatCompletion: async (messages, _settings, callbacks, _signal, tools) => {
        const turnCount = calls.length + 1;
        calls.push({ messages: structuredClone(messages), tools: tools.map((t) => t.function.name) });
        const englishCommentary = "I'll start by reviewing the framework structure before submitting.";
        callbacks.onPublicText?.(englishCommentary);
        if (turnCount === 1) {
          return {
            content: englishCommentary,
            semanticContent: englishCommentary,
            toolCalls: [{
              id: "wp-missing-changes",
              name: "submit_runtime_v2_work_plan",
              arguments: JSON.stringify({
                planMarkdown: "## 整改方案\n\n1. 修复对象池。",
                validations: [{ kind: "assertion", expectedOutcome: "Unity 编辑器编译通过。" }],
              }),
            }],
            protocolViolation: null,
          };
        }
        return {
          content: "",
          semanticContent: "",
          toolCalls: [{
            id: "wp-repaired",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "## 整改方案\n\n1. 修复对象池。",
              changes: [{
                title: "修复对象池",
                operation: "modify",
                targets: ["Assets/MFramework/Pool/ObjectPoolManager.cs"],
                change: "重写基类实现",
                basis: ["E1"],
              }],
              validations: [{
                kind: "assertion",
                expectedOutcome: "在 Unity Editor 中编译无报错并完成手测。",
                stepIndexes: [0],
              }],
            }),
          }],
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
    "../../lib/toolExecutor": {
      executeTool: async () => "Assets/MFramework/Pool/ObjectPoolManager.cs",
    },
    "../../lib/ipc": {
      inspectProjectInitTarget: async () => ({ canonicalWorkspace: "/fixture", targetPath: "/fixture/AGENTS.md", exists: false }),
      savePlanDocument: async (input) => {
        const { sha256Hex } = load("src/lib/sha256.ts");
        return { owner: input.owner, documentId: input.documentId, revision: 1, contentHash: sha256Hex(input.markdown), path: `/fixture/.MAIN/plans/${input.documentId}/rev-1.md`, title: input.title, kind: input.kind };
      },
    },
    "./checkpointPort": {
      getRuntimeV2Checkpoint: (_s, owner) => state.runtimeV2Checkpoints[owner.turnId] || null,
      getRuntimeV2EmergencyTerminalEnvelope: (_s, owner) => state.runtimeV2EmergencyTerminalEnvelopes?.[owner.turnId] || null,
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
  });
  runtimeLib = customLoad("src/lib/runtime-v2/index.ts");
  const { runSubmitRuntimeV2Plan } = customLoad("src/store/runtimeV2/planRunner.ts");
  const { createRuntimeV2ProjectionPort } = customLoad("src/store/runtimeV2/projectionPort.ts");
  const { prepareAdaptiveWorkPlanCandidate } = load("src/store/runtimeV2/planVerificationControl.ts");
  const explicitHard = prepareAdaptiveWorkPlanCandidate({
    candidate: {
      planMarkdown: "## Plan",
      changes: [{ targets: ["a.ts"], change: "update" }],
      validations: [{ kind: "advisory", expectedOutcome: "Manual check" }],
    },
    aggregate: null,
    executablePlanSelected: false,
    explicitAdmissionRequirements: ["behavioral"],
    verificationPolicy: null,
    phaseLanguage: "zh",
  });
  assert.equal(explicitHard.allowManualAdvisoryValidation, false);
  assert.equal(explicitHard.requireBehavioralValidation, true);

  const realProjection = createRuntimeV2ProjectionPort({
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    nextTaskId: () => state.taskFlow.length + 1,
    language: "zh",
    logStoreEvent: (event, data) => logEvents.push({ event, data }),
  });
  await realProjection.publish({
    aggregate: {
      turn: { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "e1", clientSubmissionId: "s-adapt", turnId: "t-adapt" },
      run: { identity: { sessionKey: "/fixture:1", sessionEpoch: "e1", turnId: "t-adapt", runId: "r-adapt", parentRunId: null, attemptId: "r-adapt" } },
      strategy: "plan",
      phase: "planning",
      events: [],
      evidence: [],
      subagents: [],
      scheduledCommands: [],
      completedCommands: [],
    },
    audience: "chat_milestone",
    projection: { id: "m1", kind: "progress", markdown: "I'll start by exploring the framework structure to understand what we're working with.", dedupeKey: "k-en" },
  });
  assert.equal(state.taskFlow.some((b) => b.visibility === "assistant_update"), false);
  assert.ok(logEvents.some((e) => e.event === "runtime_v2_commentary_language_suppressed"));

  const turn = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "e1", clientSubmissionId: "s-adapt", turnId: "t-adapt" };
  const run = { sessionKey: "/fixture:1", sessionEpoch: "e1", turnId: "t-adapt", runId: "r-adapt", parentRunId: null, attemptId: "r-adapt" };
  let seededCheckpoint = null;
  for (const event of [
    { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "a1", sequence: 0, at: 1, type: "turn.admitted", turn, strategy: "plan", objective: "/计划 评估 Unity 框架代码", constraints: [], acceptanceCriteria: ["评估完成"] },
    { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "a2", sequence: 1, at: 2, type: "run.started", run, phase: "planning" },
    { schemaVersion: runtimeLib.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "a3", sequence: 2, at: 3, type: "observation.recorded", run, evidence: { id: "E1", kind: "source", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: "sha256-1" } },
  ]) {
    const res = runtimeLib.appendRuntimeV2Checkpoint({ checkpoint: seededCheckpoint, owner: turn, expectedRevision: seededCheckpoint?.revision || 0, event });
    seededCheckpoint = res.checkpoint;
  }
  state.runtimeV2Checkpoints["t-adapt"] = seededCheckpoint;

  const settlement = await runSubmitRuntimeV2Plan({
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    context: {
      turnId: "t-adapt",
      uiDisplayTurnId: "t-adapt",
      runWorkspace: "/fixture",
      runScopeKey: "/fixture",
      runSessionKey: "/fixture:1",
      runSessionEpoch: "e1",
      runSessionId: 1,
      harnessRunId: "r-adapt",
      phaseLanguage: "zh",
      planPurpose: undefined,
      abortCtrl: new AbortController(),
      turnInputContextSignals: { subagentPreference: "preferred", subagentRequirement: "optional", attachedFilePaths: [] },
      runtimeContextBudget: { contextLimit: 32768, outputBudget: 4096, inputBudget: 28672, readWindowChars: 16000 },
    },
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (x) => x,
    buildSessionRuntimeSnapshot: (x) => x,
    publishOwnerScopedRuntimeProjection: () => ({ published: true }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: (event, data) => logEvents.push({ event, data }),
  });

  assert.equal(calls.length, 2, "missing changes must trigger one repair round instead of immediate partial draft");
  assert.ok(logEvents.some((e) => e.event === "runtime_v2_commentary_language_suppressed"));
  assert.ok(calls[1].messages.some((m) => String(m.content || "").includes("[runtime-v2 context: language-contract]")));
  assert.equal(settlement.outcome.status, "paused");
  assert.equal(state.runtimeV2Checkpoints["t-adapt"].aggregate.phase, "reviewing");
  assert.equal(state.activeActionRequest?.kind, "plan_review");
});
