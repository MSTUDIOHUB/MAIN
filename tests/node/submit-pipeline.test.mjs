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
  buildSubmitBlockingPreflightEffect,
  buildSubmitHarnessRunMarkerDraft,
  buildSubmitInputEnvelope,
  buildSubmitIntentConfirmationPendingDecision,
  buildSubmitPipelineDecision,
  buildSubmitPreflightResumeOptions,
  buildSubmitSessionBootstrapDecision,
  buildSubmitSessionBootstrapPatch,
  buildSubmitLocalStudioTurnPatch,
  buildSubmitRunStatePatch,
  buildSubmitVisibleTurnPatch,
  createGoalCreationAuthorization,
  createGoalContinuationAuthorization,
  createGoalContinuationAuthorizationBroker,
  createVisibleGoalSubmissionAuthorizationBroker,
  resolvePendingReviewSubmissionDecision,
  resolveSubmitEffectiveIntentDecision,
  resolveSubmitExecutionApprovalDecision,
  resolveSubmitPreflightEffectAction,
  resolveSubmitPreflightResultDecision,
  resolveSubmitPreflightStalenessDecision,
  resolveSubmitRuntimeDecision,
  resolveQueuedGoalCreationAuthorization,
  resolveQueuedGoalContinuationAuthorization,
  resolveVisibleGoalCreationAuthorization,
  resolveVisibleGoalSubmissionSessionKey,
  validateGoalContinuationAuthorization,
  resolveSubmitSemanticMetadataDecision,
  resolveSubmitSendGateDecision,
  resolveSubmitTurnTitleDecision,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/submit/turnSubmission.ts"),
);

function baseSnapshot(overrides = {}) {
  return {
    agentStatus: "idle",
    currentTurnId: null,
    currentSessionKey: "session-1",
    conversationTurns: [],
    taskFlow: [],
    selectedMainModeKey: "main_mode",
    currentWorkspace: "/tmp/main-project",
    contextMentions: [],
    attachedFilesCount: 0,
    planArtifactsCount: 0,
    planTasksCount: 0,
    planStage: "idle",
    isPlanApproved: false,
    pendingRunDecision: null,
    lockedComposerIntent: null,
    ...overrides,
  };
}

function turn(overrides = {}) {
  return {
    id: "turn-1",
    userPrompt: "继续排查问题",
    title: "排查",
    mode: "edit",
    intent: "execute",
    status: "awaiting_input",
    summary: "",
    blockIds: [1],
    collapsed: false,
    createdAt: 1,
    ...overrides,
  };
}

function baseEffectiveIntentInput(overrides = {}) {
  return {
    text: "修复这个问题",
    preferredLanguage: "zh",
    options: {},
    currentMainModeKey: "main_mode",
    parsedStudioCommand: null,
    isHidden: false,
    autoApproveTools: false,
    fallbackRunIntent: "respond",
    mainDebugShortcut: null,
    mainIntentShortcut: null,
    lockedComposerIntent: null,
    goalCreationAuthorization: null,
    goalContinuationAuthorization: null,
    currentTurn: null,
    currentTurnIntent: "respond",
    shouldContinuePlanIntent: false,
    shouldContinuePreviousTurnIntent: false,
    previousTurnContinuationTarget: null,
    previousTurnContinuationIntent: null,
    shouldReuseExistingTurnIntent: false,
    shouldExecuteOnceFromReplyOption: false,
    ...overrides,
  };
}

function goalContinuationAuthorization(overrides = {}) {
  return createGoalContinuationAuthorization({
    source: "goal_manual_resume",
    workspaceKey: "/repo",
    sessionKey: "/repo:7",
    goalId: "goal-1",
    goalRevision: 2,
    ownerTurnId: "turn-goal",
    ...overrides,
  });
}

function baseEnvelopeState(overrides = {}) {
  return {
    selectedMainModeKey: "main_mode",
    conversationTurns: [{ id: "turn-parent" }],
    contextMentions: ["src/App.tsx"],
    attachedFiles: ["/tmp/notes.md"],
    currentWorkspace: "/tmp/main-project",
    currentSessionId: 7,
    feishuLinkedSessionId: null,
    feishuLinkedContext: null,
    preferredResponseLanguage: "zh",
    workspaceContentVersion: 3,
    config: {
      language: "zh",
      responseLanguagePolicy: "follow_input_language",
    },
    ...overrides,
  };
}

function baseEnvelopeCache(overrides = {}) {
  return {
    workspaceTreeCacheKey: "/tmp/main-project",
    workspaceTreeCacheVersion: 3,
    workspaceTreeCache: "[D] src",
    ...overrides,
  };
}

function baseResolution(overrides = {}) {
  return {
    intent: "respond",
    reason: "local low-risk response",
    confidence: 0.8,
    bypassMainRouter: false,
    riskLevel: "low",
    commandDirective: {
      kind: "none",
      source: "natural_language",
      requiresApproval: false,
    },
    ...overrides,
  };
}

test("submit input envelope resolves snapshots parents and cached workspace tree", () => {
  const envelope = buildSubmitInputEnvelope({
    text: "继续",
    options: {
      parentPlanTurnId: "turn-parent",
      uiParentTurnId: "missing-turn",
      contextMentionsSnapshot: ["src/store/useAppStore.ts"],
      attachedFilesSnapshot: ["/tmp/custom.md"],
    },
    state: baseEnvelopeState(),
    cache: baseEnvelopeCache(),
  });

  assert.equal(envelope.isHidden, false);
  assert.equal(envelope.parentPlanTurnId, "turn-parent");
  assert.equal(envelope.uiParentTurnId, null);
  assert.deepEqual(envelope.mentionSnapshot, ["src/store/useAppStore.ts"]);
  assert.deepEqual(envelope.attachedFilesSnapshot, ["/tmp/custom.md"]);
  assert.equal(envelope.hasSupplementalInput, true);
  assert.equal(envelope.cachedWorkspaceTreeForGameDetection, "[D] src");
  assert.equal(envelope.shouldWarmWorkspaceTreeCache, false);
});

test("submit input envelope uses workflow slash args for language detection", () => {
  const envelope = buildSubmitInputEnvelope({
    text: "/start fix camera shake",
    state: baseEnvelopeState({
      selectedMainModeKey: "game_studio",
      config: {
        language: "zh",
        responseLanguagePolicy: "follow_input_language",
      },
    }),
    cache: baseEnvelopeCache({
      workspaceTreeCacheVersion: 2,
      workspaceTreeCache: "[D] stale",
    }),
  });

  assert.equal(envelope.preParsedStudioCommand.type, "workflow");
  assert.equal(envelope.preParsedStudioWorkflowArgs, "fix camera shake");
  assert.equal(envelope.languageResolutionInput, "fix camera shake");
  assert.equal(envelope.preferredLanguage, "en");
  assert.equal(envelope.cachedWorkspaceTreeForGameDetection, "");
  assert.equal(envelope.shouldWarmWorkspaceTreeCache, true);
});

test("submit input envelope preserves hidden language and linked Feishu context", () => {
  const linkedContext = {
    adapter: "feishu",
    chatId: "chat-1",
    userId: "user-1",
    userName: "Ada",
  };
  const envelope = buildSubmitInputEnvelope({
    text: "please answer in English",
    options: {
      hidden: true,
      createVisibleTurnForHiddenMessage: true,
    },
    state: baseEnvelopeState({
      preferredResponseLanguage: "zh",
      feishuLinkedSessionId: 7,
      feishuLinkedContext: linkedContext,
    }),
    cache: baseEnvelopeCache(),
  });

  assert.equal(envelope.isHidden, true);
  assert.equal(envelope.createVisibleTurnForHiddenMessage, true);
  assert.equal(envelope.preferredLanguage, "zh");
  assert.deepEqual(envelope.remoteFeishu, linkedContext);
});

test("submit pipeline reuses awaiting-choice turns only with exact request identity and option", () => {
  const currentTurn = turn();
  const taskFlow = [
    {
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "请选择下一步",
      options: [
        { label: "继续分析 Main Camera", value: "继续分析 Main Camera", action: "continue_readonly_once" },
      ],
      choiceRequest: {
        sessionKey: "session-1",
        turnId: "turn-1",
        runId: "run-choice-1",
        requestId: "request-choice-1",
        parentRunId: null,
        optionValues: ["继续分析 Main Camera"],
        status: "pending",
      },
    },
  ];

  const exact = buildSubmitPipelineDecision({
    text: "继续分析 Main Camera",
    options: {
      reuseCurrentTurn: true,
      replyOptionSourceTurnId: "turn-1",
      selectedReplyOptionText: "继续分析 Main Camera",
      replyOptionRequestIdentity: taskFlow[0].choiceRequest,
    },
    snapshot: baseSnapshot({
      currentTurnId: "turn-1",
      conversationTurns: [currentTurn],
      taskFlow,
    }),
  });
  assert.equal(exact.turnReuse.shouldExplicitlyReuseCurrentTurn, true);
  assert.equal(exact.turnReuse.reuseCurrentTurn, true);
  assert.equal(exact.routeKind, "agent_loop");
  assert.equal(exact.effects.launchAgentLoop, true);

  const ordinary = buildSubmitPipelineDecision({
    text: "顺便解释一下这个系统",
    snapshot: baseSnapshot({
      currentTurnId: "turn-1",
      conversationTurns: [currentTurn],
      taskFlow,
    }),
  });
  assert.equal(ordinary.turnReuse.shouldAutoResumeChoiceTurn, false);
  assert.equal(ordinary.turnReuse.reuseCurrentTurn, false);

  const sameTextWithoutIdentity = buildSubmitPipelineDecision({
    text: "继续分析 Main Camera",
    snapshot: baseSnapshot({
      currentTurnId: "turn-1",
      conversationTurns: [currentTurn],
      taskFlow,
    }),
  });
  assert.equal(sameTextWithoutIdentity.turnReuse.shouldAutoResumeChoiceTurn, false);
  assert.equal(sameTextWithoutIdentity.turnReuse.reuseCurrentTurn, false);

  const staleIdentity = buildSubmitPipelineDecision({
    text: "继续分析 Main Camera",
    options: {
      reuseCurrentTurn: true,
      replyOptionSourceTurnId: "turn-1",
      selectedReplyOptionText: "继续分析 Main Camera",
      replyOptionRequestIdentity: { ...taskFlow[0].choiceRequest, requestId: "stale-request" },
    },
    snapshot: baseSnapshot({
      currentTurnId: "turn-1",
      conversationTurns: [currentTurn],
      taskFlow,
    }),
  });
  assert.equal(staleIdentity.turnReuse.reuseCurrentTurn, false);
});

test("hidden approved-plan execution can reuse its logical turn with execute intent", () => {
  const planTurn = turn({ id: "turn-plan", mode: "plan", intent: "plan", status: "paused" });
  const newerTurn = turn({ id: "turn-newer", status: "done" });
  const decision = buildSubmitPipelineDecision({
    text: "Continue approved plan execution",
    options: {
      hidden: true,
      reuseCurrentTurn: true,
      turnIdOverride: "turn-plan",
      preservePlanState: true,
      resolvedIntent: "execute",
      executionConsentGranted: true,
    },
    snapshot: baseSnapshot({
      currentTurnId: "turn-newer",
      conversationTurns: [planTurn, newerTurn],
      planArtifactsCount: 1,
      planStage: "executing",
      isPlanApproved: true,
    }),
  });

  assert.equal(decision.turnReuse.reuseCurrentTurn, true);
  assert.equal(decision.turnReuse.reusableTurnId, "turn-plan");
  assert.equal(decision.turnReuse.isInternalTurn, false);
});

test("pending review abort is skipped for execution approval reply options", () => {
  const currentTurn = turn({ status: "awaiting_approval" });
  const taskFlow = [
    {
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "是否执行？",
      options: [
        { label: "执行一次", value: "执行一次", action: "execute_once" },
      ],
    },
  ];

  assert.equal(
    resolvePendingReviewSubmissionDecision({
      text: "新的需求",
      agentStatus: "pending_review",
      currentTurn,
      taskFlow,
    }).shouldAbortAndStartNewTurn,
    true,
  );

  const approval = resolvePendingReviewSubmissionDecision({
    text: "执行一次",
    agentStatus: "pending_review",
    currentTurn,
    taskFlow,
  });
  assert.equal(approval.isApprovalBypass, true);
  assert.equal(approval.shouldAbortAndStartNewTurn, false);
});

test("submit pipeline exposes plan hydration as an explicit effect", () => {
  const decision = buildSubmitPipelineDecision({
    text: "请按照 .MAIN/plans/tasks.md 继续执行",
    snapshot: baseSnapshot({
      currentWorkspace: "/tmp/main-project",
    }),
  });

  assert.equal(decision.routeKind, "plan_hydration");
  assert.equal(decision.effects.startAutoPlanHydration, "existing_plan_execution");
  assert.equal(decision.effects.launchAgentLoop, undefined);
});

test("submit pipeline parses shortcuts before Game Studio suggestion", () => {
  const decision = buildSubmitPipelineDecision({
    text: "/计划 先出方案",
    snapshot: baseSnapshot({
      selectedMainModeKey: "game_studio",
    }),
  });

  assert.equal(decision.shortcuts.mainIntentShortcut.intent, "plan");
  assert.equal(decision.shortcuts.textAfterIntentShortcut, "先出方案");
  assert.equal(decision.shortcuts.lockedComposerIntent, "plan");
  assert.equal(decision.gameStudioModeSwitch.pendingRunDecision, null);
});

test("submit pipeline mints Goal creation authority only for visible shortcut text or a captured capsule", () => {
  const slash = buildSubmitPipelineDecision({
    text: "/goal fix the runtime",
    snapshot: baseSnapshot(),
  });
  assert.deepEqual(slash.shortcuts.goalCreationAuthorization, {
    kind: "goal_creation_authorization",
    intent: "goal",
    source: "visible_goal_shortcut",
  });

  const uncapturedCapsule = buildSubmitPipelineDecision({
    text: "fix the runtime",
    snapshot: baseSnapshot({ lockedComposerIntent: "goal" }),
  });
  assert.equal(uncapturedCapsule.shortcuts.goalCreationAuthorization, null);

  const capsule = buildSubmitPipelineDecision({
    text: "fix the runtime",
    validatedVisibleGoalCreationAuthorization:
      createGoalCreationAuthorization("visible_goal_composer_capsule"),
    snapshot: baseSnapshot({ lockedComposerIntent: null }),
  });
  assert.equal(capsule.shortcuts.goalCreationAuthorization.source, "visible_goal_composer_capsule");

  const internal = buildSubmitPipelineDecision({
    text: "fix the runtime",
    options: { hidden: true, resolvedIntent: "goal", skipIntentResolution: true },
    snapshot: baseSnapshot({ lockedComposerIntent: "goal" }),
  });
  assert.equal(internal.shortcuts.goalCreationAuthorization, null);
});

test("submit pipeline refuses Goal creation authority without a workspace", () => {
  const globalSlash = buildSubmitPipelineDecision({
    text: "/goal fix the runtime",
    snapshot: baseSnapshot({ currentWorkspace: "" }),
  });
  assert.equal(globalSlash.shortcuts.goalCreationAuthorization, null);

  const globalCapsule = buildSubmitPipelineDecision({
    text: "fix the runtime",
    validatedVisibleGoalCreationAuthorization:
      createGoalCreationAuthorization("visible_goal_composer_capsule"),
    snapshot: baseSnapshot({ currentWorkspace: "", lockedComposerIntent: "goal" }),
  });
  assert.equal(globalCapsule.shortcuts.goalCreationAuthorization, null);
});

test("visible Goal authority resolver follows visible shortcut precedence without trusting hidden intent", () => {
  assert.deepEqual(resolveVisibleGoalCreationAuthorization({
    text: "keep fixing until verified",
    currentMainModeKey: "main_mode",
    lockedComposerIntent: "goal",
  }), createGoalCreationAuthorization("visible_goal_composer_capsule"));
  assert.deepEqual(resolveVisibleGoalCreationAuthorization({
    text: "/goal keep fixing until verified",
    currentMainModeKey: "main_mode",
    lockedComposerIntent: null,
  }), createGoalCreationAuthorization("visible_goal_shortcut"));
  assert.equal(resolveVisibleGoalCreationAuthorization({
    text: "/goal keep fixing until verified",
    currentMainModeKey: "main_mode",
    lockedComposerIntent: "plan",
  }), null);
  assert.equal(resolveVisibleGoalCreationAuthorization({
    text: "/goal keep fixing until verified",
    currentMainModeKey: "main_mode",
    lockedComposerIntent: "goal",
    isHidden: true,
  }), null);
});

test("visible Goal submission envelope is exact, session-bound, expiring, and one-shot", () => {
  let now = 100;
  let nextId = 0;
  const broker = createVisibleGoalSubmissionAuthorizationBroker({
    now: () => now,
    createId: () => `visible-${++nextId}`,
    ttlMs: 20,
  });
  const envelope = broker.capture({
    text: "keep fixing until verified",
    sessionKey: "workspace::1",
    currentMainModeKey: "main_mode",
    lockedComposerIntent: "goal",
  });
  assert.deepEqual(envelope, {
    kind: "visible_goal_submission_envelope",
    id: "visible-1",
  });
  assert.deepEqual(broker.consume({
    envelope,
    text: "keep fixing until verified",
    sessionKey: "workspace::1",
  }), createGoalCreationAuthorization("visible_goal_composer_capsule"));
  assert.equal(broker.consume({
    envelope,
    text: "keep fixing until verified",
    sessionKey: "workspace::1",
  }), null);

  const mismatched = broker.capture({
    text: "/goal exact request",
    sessionKey: "workspace::1",
    currentMainModeKey: "main_mode",
  });
  assert.equal(broker.consume({
    envelope: mismatched,
    text: "/goal changed request",
    sessionKey: "workspace::1",
  }), null);
  assert.equal(broker.consume({
    envelope: mismatched,
    text: "/goal exact request",
    sessionKey: "workspace::1",
  }), null);

  const carried = broker.carryValidated({
    text: "resume after plan hydration",
    sessionKey: "workspace::1",
    authorization: createGoalCreationAuthorization("visible_goal_composer_capsule"),
  });
  assert.deepEqual(broker.consume({
    envelope: carried,
    text: "resume after plan hydration",
    sessionKey: "workspace::1",
  }), createGoalCreationAuthorization("visible_goal_composer_capsule"));

  const expired = broker.capture({
    text: "/goal expires",
    sessionKey: "workspace::1",
    currentMainModeKey: "main_mode",
  });
  now += 21;
  assert.equal(broker.consume({
    envelope: expired,
    text: "/goal expires",
    sessionKey: "workspace::1",
  }), null);
});

test("visible Goal session binding remains workspace-scoped without a session id", () => {
  const workspaceA = resolveVisibleGoalSubmissionSessionKey({
    currentWorkspace: "/tmp/workspace-a",
    currentSessionId: null,
  });
  const workspaceB = resolveVisibleGoalSubmissionSessionKey({
    currentWorkspace: "/tmp/workspace-b",
    currentSessionId: null,
  });
  const global = resolveVisibleGoalSubmissionSessionKey({
    currentWorkspace: null,
    currentSessionId: null,
  });
  assert.notEqual(workspaceA, workspaceB);
  assert.notEqual(workspaceA, global);
  assert.match(workspaceA, /workspace-a/);

  const broker = createVisibleGoalSubmissionAuthorizationBroker({
    createId: () => "cross-workspace",
  });
  const envelope = broker.capture({
    text: "finish this goal",
    sessionKey: workspaceA,
    currentMainModeKey: "main_mode",
    lockedComposerIntent: "goal",
  });
  assert.equal(broker.consume({
    envelope,
    text: "finish this goal",
    sessionKey: workspaceB,
  }), null);
});

test("Goal continuation envelope is one-shot and exact-text bound", () => {
  const broker = createGoalContinuationAuthorizationBroker({
    createId: () => "continuation-1",
  });
  const authorization = goalContinuationAuthorization();
  const envelope = broker.issueValidated({
    text: "resume exact goal",
    authorization,
  });
  assert.deepEqual(envelope, {
    kind: "goal_continuation_envelope",
    id: "continuation-1",
  });
  assert.equal(broker.consume({
    envelope,
    text: "different text",
  }), null);
  assert.equal(broker.consume({
    envelope,
    text: "resume exact goal",
  }), null);
});

test("Goal continuation authorization rejects Goal replacement deletion and session races", () => {
  const authorization = goalContinuationAuthorization();
  const activeGoal = {
    id: "goal-1",
    revision: 2,
    sessionKey: "/repo:7",
    ownerTurnId: "turn-goal",
    status: "active",
  };
  assert.deepEqual(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal,
  }), authorization);
  assert.equal(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal: { ...activeGoal, status: "paused" },
  }), null);
  assert.equal(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal: { ...activeGoal, status: "pausing" },
  }), null);
  assert.equal(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal: { ...activeGoal, revision: 3 },
  }), null);
  assert.equal(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 8,
    activeGoal,
  }), null);
  assert.equal(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/other-repo",
    currentSessionId: 7,
    activeGoal,
  }), null);
  assert.equal(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal: null,
  }), null);
});

test("Goal choice continuation additionally requires the exact pending request", () => {
  const authorization = goalContinuationAuthorization({
    source: "goal_user_choice",
    requestId: "request-1",
  });
  const activeGoal = {
    id: "goal-1",
    revision: 2,
    sessionKey: "/repo:7",
    ownerTurnId: "turn-goal",
    status: "awaiting_input",
  };
  const request = {
    schemaVersion: 1,
    requestId: "request-1",
    kind: "user_choice",
    sessionKey: "/repo:7",
    turnId: "turn-goal",
    runId: "run-goal",
    title: "Choose",
    status: "pending",
    createdAt: 1,
    optionValues: ["A"],
    allowCustomReply: false,
  };
  assert.deepEqual(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal,
    activeActionRequest: request,
  }), authorization);
  assert.deepEqual(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal: { ...activeGoal, status: "paused" },
    activeActionRequest: request,
  }), authorization);
  assert.equal(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal: { ...activeGoal, status: "pausing" },
    activeActionRequest: request,
  }), null);
  assert.equal(validateGoalContinuationAuthorization({
    authorization,
    currentWorkspace: "/repo",
    currentSessionId: 7,
    activeGoal,
    activeActionRequest: { ...request, requestId: "request-new" },
  }), null);
});

test("queued Goal continuation requires exact queue id text and session", () => {
  const authorization = goalContinuationAuthorization();
  assert.deepEqual(resolveQueuedGoalContinuationAuthorization({
    queuedMessageId: "queued-1",
    replayMessageId: "queued-1",
    queuedText: "resume",
    replayText: "resume",
    queuedSessionKey: "/repo:7",
    replaySessionKey: "/repo:7",
    authorization,
  }), authorization);
  assert.equal(resolveQueuedGoalContinuationAuthorization({
    queuedMessageId: "queued-1",
    replayMessageId: "queued-1",
    queuedText: "resume",
    replayText: "resume changed",
    queuedSessionKey: "/repo:7",
    replaySessionKey: "/repo:7",
    authorization,
  }), null);
});

test("captured visible Goal authority survives capsule cleanup but hidden reuse is rejected", () => {
  const authorization = createGoalCreationAuthorization("visible_goal_composer_capsule");
  const visible = buildSubmitPipelineDecision({
    text: "keep fixing until verified",
    validatedVisibleGoalCreationAuthorization: authorization,
    snapshot: baseSnapshot({ lockedComposerIntent: null }),
  });
  assert.equal(visible.shortcuts.lockedComposerIntent, "goal");
  assert.deepEqual(visible.shortcuts.goalCreationAuthorization, authorization);

  const hidden = buildSubmitPipelineDecision({
    text: "keep fixing until verified",
    options: { hidden: true, resolvedIntent: "goal", skipIntentResolution: true },
    validatedVisibleGoalCreationAuthorization: authorization,
    snapshot: baseSnapshot({ lockedComposerIntent: null }),
  });
  assert.equal(hidden.shortcuts.lockedComposerIntent, null);
  assert.equal(hidden.shortcuts.goalCreationAuthorization, null);
});

test("queued Goal capsule authority is restored only for the exact queued message", () => {
  const authorization = createGoalCreationAuthorization("visible_goal_composer_capsule");
  const matched = resolveQueuedGoalCreationAuthorization({
    queuedMessageId: "queued-1",
    replayMessageId: "queued-1",
    queuedText: "fix the runtime",
    replayText: "fix the runtime",
    queuedSessionKey: "workspace::1",
    replaySessionKey: "workspace::1",
    authorization,
  });
  assert.deepEqual(matched, authorization);
  assert.equal(resolveQueuedGoalCreationAuthorization({
    queuedMessageId: "queued-1",
    replayMessageId: "queued-stale",
    queuedText: "fix the runtime",
    replayText: "fix the runtime",
    queuedSessionKey: "workspace::1",
    replaySessionKey: "workspace::1",
    authorization,
  }), null);

  const replay = buildSubmitPipelineDecision({
    text: "fix the runtime",
    validatedQueuedGoalCreationAuthorization: matched,
    snapshot: baseSnapshot({ lockedComposerIntent: null }),
  });
  assert.equal(replay.shortcuts.lockedComposerIntent, "goal");
  assert.deepEqual(replay.shortcuts.goalCreationAuthorization, authorization);

  const effective = resolveSubmitEffectiveIntentDecision(baseEffectiveIntentInput({
    lockedComposerIntent: replay.shortcuts.lockedComposerIntent,
    goalCreationAuthorization: replay.shortcuts.goalCreationAuthorization,
  }));
  assert.equal(effective.effectiveRunIntent, "goal");

  const staleLegacySlashReplay = buildSubmitPipelineDecision({
    text: "/goal fix the runtime",
    options: { queuedUserMessageId: "queued-legacy" },
    snapshot: baseSnapshot({ lockedComposerIntent: null }),
  });
  assert.equal(staleLegacySlashReplay.shortcuts.goalCreationAuthorization, null);
});

test("submit pipeline returns Game Studio mode-switch decision as a store effect", () => {
  const decision = buildSubmitPipelineDecision({
    text: "帮我修复 Unity MonoBehaviour 的相机抖动问题",
    preferredLanguage: "zh",
    workspaceTreeForGameDetection: "[D] Assets\n[D] ProjectSettings\n[D] Packages",
    createGameStudioModeSwitchDecision: ({ signal }) => ({
      kind: "mode_switch",
      source: "pre_submit",
      originalInput: "game",
      suggestedIntent: "studio_workflow",
      reason: `engine:${signal.engine}`,
      title: "切换到游戏工作室？",
      target: signal.engine,
      options: [],
    }),
    snapshot: baseSnapshot(),
  });

  assert.equal(decision.routeKind, "mode_switch_decision");
  assert.equal(decision.gameStudioModeSwitch.signal.engine, "unity");
  assert.equal(decision.effects.setPendingDecision.title, "切换到游戏工作室？");
  assert.equal(decision.effects.launchAgentLoop, undefined);
});

test("effective intent decision upgrades auto-approve Game Studio turns to studio workflow", () => {
  const decision = resolveSubmitEffectiveIntentDecision(baseEffectiveIntentInput({
    text: "修复 Unity 摄像机抖动",
    currentMainModeKey: "game_studio",
    autoApproveTools: true,
    parsedStudioCommand: { type: "workflow", slug: "implement", args: "camera shake" },
  }));

  assert.equal(decision.shouldForceExecuteForAutoApprove, true);
  assert.equal(decision.effectiveRunIntent, "studio_workflow");
  assert.equal(decision.effectiveCommandDirective.kind, "studio");
  assert.match(decision.effectiveIntentSummary, /Game Studio 工作流|自动审批/);
});

test("effective intent decision keeps an identity-validated choice inside Goal runtime", () => {
  const decision = resolveSubmitEffectiveIntentDecision(baseEffectiveIntentInput({
    text: "显示欢迎页",
    options: {
      resolvedIntent: "goal",
      executionConsentGranted: true,
    },
    goalContinuationAuthorization: goalContinuationAuthorization({
      source: "goal_user_choice",
      requestId: "request-1",
    }),
    currentTurnIntent: "goal",
    shouldReuseExistingTurnIntent: true,
    shouldExecuteOnceFromReplyOption: true,
  }));

  assert.equal(decision.effectiveRunIntent, "goal");
  assert.equal(decision.shouldForceExecuteForAutoApprove, false);
});

test("effective intent decision downgrades untrusted Goal intents but preserves explicit creation", () => {
  const internal = resolveSubmitEffectiveIntentDecision(baseEffectiveIntentInput({
    options: { resolvedIntent: "goal", skipIntentResolution: true },
  }));
  assert.equal(internal.effectiveRunIntent, "execute");

  const legacyBareContinuation = resolveSubmitEffectiveIntentDecision(baseEffectiveIntentInput({
    options: {
      resolvedIntent: "goal",
      continueExistingGoal: true,
      skipIntentResolution: true,
    },
  }));
  assert.equal(legacyBareContinuation.effectiveRunIntent, "execute");

  const explicit = resolveSubmitEffectiveIntentDecision(baseEffectiveIntentInput({
    mainIntentShortcut: { intent: "goal", command: "/goal", rest: "fix it" },
    lockedComposerIntent: "goal",
    goalCreationAuthorization: {
      kind: "goal_creation_authorization",
      intent: "goal",
      source: "visible_goal_shortcut",
    },
  }));
  assert.equal(explicit.effectiveRunIntent, "goal");
});

test("effective intent decision preserves explicit Unity setup-engine directive", () => {
  const decision = resolveSubmitEffectiveIntentDecision(baseEffectiveIntentInput({
    text: "/setup-engine unity",
    currentMainModeKey: "game_studio",
    fallbackRunIntent: "studio_workflow",
    parsedStudioCommand: { type: "workflow", slug: "setup-engine", args: "unity" },
    unitySetupEngineSelected: true,
  }));

  assert.equal(decision.effectiveRunIntent, "studio_workflow");
  assert.equal(decision.effectiveCommandDirective.kind, "unity");
  assert.equal(decision.effectiveCommandDirective.action, "setup-engine");
  assert.equal(decision.effectiveCommandDirective.requiresApproval, false);
});

test("approved-plan child run uses canonical execute intent and default execute workflow", () => {
  const decision = resolveSubmitRuntimeDecision({
    effectiveRunIntent: "execute",
    currentMainModeKey: "main_mode",
    isPlanApproved: true,
    autoApproveTools: false,
    executionConsentGranted: true,
    shouldExecuteOnceFromReplyOption: false,
    preservePlanState: true,
    isLocalStudioCommand: false,
  });

  assert.equal(decision.effectiveWorkflowMode, "edit");
  assert.equal(decision.runtimeRunIntent, "execute");
  assert.equal(decision.effectiveDisplayIntent, "execute");
  assert.equal(decision.initialTurnStatus, "executing");
  assert.equal(decision.shouldGrantExecutionConsentForTurn, true);
  assert.equal(decision.shouldResetPlanState, false);
});

test("runtime decision resumes Game Studio reply options as studio workflow with execution consent", () => {
  const decision = resolveSubmitRuntimeDecision({
    effectiveRunIntent: "respond",
    currentMainModeKey: "game_studio",
    isPlanApproved: false,
    autoApproveTools: false,
    executionConsentGranted: false,
    shouldExecuteOnceFromReplyOption: true,
    preservePlanState: true,
    isLocalStudioCommand: false,
  });

  assert.equal(decision.effectiveWorkflowMode, "chat");
  assert.equal(decision.runtimeRunIntent, "studio_workflow");
  assert.equal(decision.effectiveDisplayIntent, "respond");
  assert.equal(decision.initialTurnStatus, "executing");
  assert.equal(decision.shouldGrantExecutionConsentForTurn, true);
  assert.equal(decision.shouldResetPlanState, false);
});

test("runtime decision keeps plan state for local Game Studio commands", () => {
  const decision = resolveSubmitRuntimeDecision({
    effectiveRunIntent: "studio_workflow",
    currentMainModeKey: "game_studio",
    isPlanApproved: false,
    autoApproveTools: true,
    executionConsentGranted: false,
    shouldExecuteOnceFromReplyOption: false,
    preservePlanState: false,
    isLocalStudioCommand: true,
  });

  assert.equal(decision.effectiveWorkflowMode, "edit");
  assert.equal(decision.runtimeRunIntent, "studio_workflow");
  assert.equal(decision.shouldGrantExecutionConsentForTurn, true);
  assert.equal(decision.shouldResetPlanState, false);
});

test("runtime decision cannot enter Goal without creation authority or an existing continuation", () => {
  const rejected = resolveSubmitRuntimeDecision({
    effectiveRunIntent: "execute",
    runtimeIntentOverride: "goal",
    currentMainModeKey: "main_mode",
    isPlanApproved: false,
    autoApproveTools: false,
    shouldExecuteOnceFromReplyOption: false,
    preservePlanState: false,
    isLocalStudioCommand: false,
    hasActiveGoal: true,
  });
  assert.equal(rejected.runtimeRunIntent, "execute");

  const resumed = resolveSubmitRuntimeDecision({
    effectiveRunIntent: "execute",
    runtimeIntentOverride: "goal",
    currentMainModeKey: "main_mode",
    isPlanApproved: false,
    autoApproveTools: false,
    shouldExecuteOnceFromReplyOption: false,
    preservePlanState: true,
    isLocalStudioCommand: false,
    goalContinuationAuthorization: goalContinuationAuthorization(),
  });
  assert.equal(resumed.runtimeRunIntent, "goal");
});

test("intent confirmation builder creates pre-submit plan confirmation choices", () => {
  const decision = buildSubmitIntentConfirmationPendingDecision({
    text: "继续重构",
    images: ["image-a"],
    preferredLanguage: "zh",
    decision: {
      suggestedIntent: "plan",
      decisionOptions: ["plan", "respond", "execute"],
      riskLevel: "high",
      reason: "needs planning",
    },
  });

  assert.equal(decision.kind, "intent_confirmation");
  assert.equal(decision.source, "pre_submit");
  assert.equal(decision.originalInput, "继续重构");
  assert.deepEqual(decision.originalImages, ["image-a"]);
  assert.equal(decision.suggestedIntent, "plan");
  assert.equal(decision.reason, "needs planning");
  assert.deepEqual(decision.options.map((option) => option.id), [
    "plan",
    "respond",
    "execute",
  ]);
});

test("intent confirmation builder falls back to plan when resolution has no suggested intent", () => {
  const decision = buildSubmitIntentConfirmationPendingDecision({
    text: "这个需求范围有点大",
    preferredLanguage: "en",
    decision: {
      riskLevel: "medium",
      reason: "ambiguous scope",
    },
    suggestedIntentFallback: "plan",
  });

  assert.equal(decision.suggestedIntent, "plan");
  assert.equal(decision.reason, "ambiguous scope");
  assert.deepEqual(decision.options.map((option) => option.id), [
    "execute",
    "respond",
    "plan",
  ]);
});

test("send gate blocks empty input before busy state checks", () => {
  const decision = resolveSubmitSendGateDecision({
    text: "   ",
    imagesLength: 0,
    hasSupplementalInput: false,
    isHidden: false,
    executionConsentGranted: false,
    shouldExecuteOnceFromReplyOption: false,
    isGenerating: true,
    agentStatus: "running",
    hasAbortController: true,
    hasCurrentTurn: true,
  });

  assert.equal(decision.action.kind, "block_empty");
  assert.equal(decision.action.reason, "empty_text_no_images_no_context");
  assert.deepEqual(decision.allowedBusyReasons, []);
});

test("send gate queues visible submissions while generation is active", () => {
  const decision = resolveSubmitSendGateDecision({
    text: "继续修复",
    imagesLength: 0,
    hasSupplementalInput: false,
    isHidden: false,
    executionConsentGranted: false,
    shouldExecuteOnceFromReplyOption: false,
    isGenerating: true,
    agentStatus: "running",
    hasAbortController: true,
    hasCurrentTurn: true,
  });

  assert.equal(decision.action.kind, "queue");
  assert.equal(decision.action.reason, "generation_in_progress");
  assert.equal(decision.allowHiddenExecutionWhileBusy, false);
});

test("send gate never lets a hidden execution resume create a second running owner", () => {
  const decision = resolveSubmitSendGateDecision({
    text: "hidden resume",
    imagesLength: 0,
    hasSupplementalInput: false,
    isHidden: true,
    executionConsentGranted: true,
    shouldExecuteOnceFromReplyOption: false,
    isGenerating: true,
    agentStatus: "running",
    hasAbortController: true,
    hasCurrentTurn: true,
  });

  assert.equal(decision.action.kind, "queue");
  assert.equal(decision.action.reason, "generation_in_progress");
  assert.equal(decision.allowHiddenExecutionWhileBusy, false);
  assert.deepEqual(decision.allowedBusyReasons, []);
});

test("send gate approves pending review reply options before queueing agent busy state", () => {
  const decision = resolveSubmitSendGateDecision({
    text: "执行一次",
    imagesLength: 0,
    hasSupplementalInput: false,
    isHidden: false,
    executionConsentGranted: false,
    shouldExecuteOnceFromReplyOption: true,
    isGenerating: false,
    agentStatus: "pending_review",
    hasAbortController: true,
    hasCurrentTurn: true,
  });

  assert.equal(decision.action.kind, "approve_pending_review");
});

test("send gate resets stuck running and pending-review states without an abort controller", () => {
  const running = resolveSubmitSendGateDecision({
    text: "继续",
    imagesLength: 0,
    hasSupplementalInput: false,
    isHidden: false,
    executionConsentGranted: false,
    shouldExecuteOnceFromReplyOption: false,
    isGenerating: false,
    agentStatus: "running",
    hasAbortController: false,
    hasCurrentTurn: true,
  });
  assert.equal(running.action.kind, "reset_stuck_state");
  assert.equal(running.action.previousStatus, "running");
  assert.equal(running.action.turnStatus, "stopped_no_action");

  const pendingReview = resolveSubmitSendGateDecision({
    text: "继续",
    imagesLength: 0,
    hasSupplementalInput: false,
    isHidden: false,
    executionConsentGranted: false,
    shouldExecuteOnceFromReplyOption: false,
    isGenerating: false,
    agentStatus: "pending_review",
    hasAbortController: false,
    hasCurrentTurn: true,
  });
  assert.equal(pendingReview.action.kind, "reset_stuck_state");
  assert.equal(pendingReview.action.previousStatus, "pending_review");
  assert.equal(pendingReview.action.turnStatus, "awaiting_approval");
});

test("send gate queues ordinary input while an agent run is active", () => {
  const decision = resolveSubmitSendGateDecision({
    text: "新需求",
    imagesLength: 0,
    hasSupplementalInput: false,
    isHidden: false,
    executionConsentGranted: false,
    shouldExecuteOnceFromReplyOption: false,
    isGenerating: false,
    agentStatus: "running",
    hasAbortController: true,
    hasCurrentTurn: true,
  });

  assert.equal(decision.action.kind, "queue");
  assert.equal(decision.action.reason, "agent_running_or_pending_review");
  assert.equal(decision.action.agentStatus, "running");
});

test("session bootstrap keeps an existing workspace session and run timestamp", () => {
  const decision = buildSubmitSessionBootstrapDecision({
    currentWorkspace: "/tmp/main-project",
    currentSessionId: 42,
    sessionsByWorkspace: {
      "/tmp/main-project": [{ id: 42 }],
    },
    language: "en",
    sessionRecordingEnabled: true,
    autoSessionNowMs: 1000,
    commandIssuedAtMs: 2000,
  });

  assert.equal(decision.sessionScopeKey, "/tmp/main-project");
  assert.equal(decision.hasValidCurrentSession, true);
  assert.equal(decision.ensuredSessionId, 42);
  assert.equal(decision.autoSession, null);
  assert.equal(decision.runWorkspace, "/tmp/main-project");
  assert.equal(decision.runScopeKey, "/tmp/main-project");
  assert.equal(decision.runSessionId, 42);
  assert.equal(decision.runSessionKey, "/tmp/main-project:42");
  assert.equal(decision.commandIssuedAtMs, 2000);
  assert.equal(decision.commandIssuedAtIso, new Date(2000).toISOString());
});

test("session bootstrap creates a temporary workspace conversation when the current id is missing", () => {
  const decision = buildSubmitSessionBootstrapDecision({
    currentWorkspace: "/tmp/main-project",
    currentSessionId: 7,
    sessionsByWorkspace: {
      "/tmp/main-project": [{ id: 41 }],
    },
    language: "en",
    sessionRecordingEnabled: true,
    autoSessionNowMs: 123456,
    commandIssuedAtMs: 123999,
  });

  assert.equal(decision.hasValidCurrentSession, false);
  assert.equal(decision.ensuredSessionId, 123456);
  assert.equal(decision.runSessionKey, "/tmp/main-project:123456");
  assert.equal(decision.autoSession.id, 123456);
  assert.equal(decision.autoSession.title, "New Conversation");
  assert.equal(decision.autoSession.titleSource, "default");
  assert.equal(decision.autoSession.storageStatus, "temporary");
  assert.equal(decision.autoSession.recordingDisabled, false);
  assert.deepEqual(decision.autoSession.messages, []);
});

test("session bootstrap creates a global Chinese chat when no workspace is active", () => {
  const decision = buildSubmitSessionBootstrapDecision({
    currentWorkspace: "",
    currentSessionId: null,
    sessionsByWorkspace: {},
    language: "zh",
    sessionRecordingEnabled: false,
    autoSessionNowMs: 987654,
    commandIssuedAtMs: 987999,
  });

  assert.equal(decision.sessionScopeKey, "__MAIN_GLOBAL_CHAT__");
  assert.equal(decision.runWorkspace, "");
  assert.equal(decision.runSessionKey, "__MAIN_GLOBAL_CHAT__:987654");
  assert.equal(decision.autoSession.title, "新聊天");
  assert.equal(decision.autoSession.recordingDisabled, true);
  assert.equal(decision.autoSession.updatedAt, new Date(987654).toISOString());
});

test("session bootstrap patch is null when no temporary session is needed", () => {
  const decision = buildSubmitSessionBootstrapDecision({
    currentWorkspace: "/tmp/main-project",
    currentSessionId: 42,
    sessionsByWorkspace: {
      "/tmp/main-project": [{ id: 42, active: true }],
    },
    language: "en",
    sessionRecordingEnabled: true,
    autoSessionNowMs: 1000,
    commandIssuedAtMs: 2000,
  });

  const patch = buildSubmitSessionBootstrapPatch({
    decision,
    sessionsByWorkspace: {
      "/tmp/main-project": [{ id: 42, active: true }],
    },
    activeSessionByWorkspace: {
      "/tmp/main-project": 42,
    },
    autoApproveTools: true,
    autoApproveToolScopes: ["read"],
    webSearchEnabled: true,
    webSearchProvider: "tavily",
  });

  assert.equal(patch, null);
});

test("session bootstrap patch creates an active temporary session and clears session-scoped approvals", () => {
  const decision = buildSubmitSessionBootstrapDecision({
    currentWorkspace: "/tmp/main-project",
    currentSessionId: 7,
    sessionsByWorkspace: {
      "/tmp/main-project": [{ id: 41, active: true }],
    },
    language: "en",
    sessionRecordingEnabled: true,
    autoSessionNowMs: 123456,
    commandIssuedAtMs: 123999,
  });

  const patch = buildSubmitSessionBootstrapPatch({
    decision,
    sessionsByWorkspace: {
      "/tmp/main-project": [
        { id: 41, active: true, title: "Existing" },
        { id: 40, active: false, title: "Older" },
      ],
      "/tmp/other": [{ id: 9, active: true, title: "Other" }],
    },
    activeSessionByWorkspace: {
      "/tmp/main-project": 41,
      "/tmp/other": 9,
    },
    autoApproveTools: true,
    autoApproveToolScopes: ["read", "mcp_action"],
    webSearchEnabled: true,
    webSearchProvider: "brave",
  });

  assert.ok(patch);
  assert.equal(patch.currentSessionId, 123456);
  assert.equal(patch.activeSessionByWorkspace["/tmp/main-project"], 123456);
  assert.equal(patch.activeSessionByWorkspace["/tmp/other"], 9);
  assert.equal(patch.sessionsByWorkspace["/tmp/main-project"][0].id, 123456);
  assert.equal(patch.sessionsByWorkspace["/tmp/main-project"][0].active, true);
  assert.equal(patch.sessionsByWorkspace["/tmp/main-project"][1].id, 41);
  assert.equal(patch.sessionsByWorkspace["/tmp/main-project"][1].active, false);
  assert.deepEqual(patch.sessionsByWorkspace["/tmp/other"], [{ id: 9, active: true, title: "Other" }]);
  assert.equal(patch.autoApproveTools, true);
  assert.deepEqual(patch.autoApproveToolScopes, ["read", "mcp_action"]);
  assert.equal(patch.webSearchEnabled, true);
  assert.equal(patch.webSearchProvider, "brave");
  assert.deepEqual(patch.approvedLocalFileReadPaths, []);
  assert.deepEqual(patch.approvedShellPermissionRules, []);
  assert.equal(patch.readOnlyAutoApproveForSession, false);
});

test("turn title decision keeps an existing non-generic reused turn title", () => {
  const decision = resolveSubmitTurnTitleDecision({
    text: "继续执行",
    effectiveRunIntent: "execute",
    preferredLanguage: "zh",
    existingTurnTitle: "修复设置面板",
    optionTurnTitle: "执行：继续",
    activeSession: {
      title: "已有语义标题",
      titleSource: "semantic",
      messages: [{ type: "user" }],
    },
  });

  assert.equal(decision.existingTitle, "修复设置面板");
  assert.equal(decision.turnTitle, "修复设置面板");
  assert.equal(decision.shouldSeedSessionTitleForTurn, false);
  assert.equal(decision.seededSessionTitleCandidate, "");
  assert.match(decision.titleIntentSignature, /^execute\|继续执行\|images:0\|mentions:\|attachments:/);
});

test("turn title decision prefers explicit option titles and seeds default sessions", () => {
  const decision = resolveSubmitTurnTitleDecision({
    text: "帮我分析这个 CSV",
    effectiveRunIntent: "analyze",
    preferredLanguage: "en",
    existingTurnTitle: "New task",
    optionTurnTitle: "Analyze import data",
    contextSignals: {
      imageParts: 0,
      mentionedFilePaths: ["src/data/orders.csv"],
      attachedFilePaths: ["Uploads/orders.csv"],
    },
    activeSession: {
      title: "New Conversation",
      titleSource: "default",
      messages: [],
    },
  });

  assert.equal(decision.existingTitle, "");
  assert.equal(decision.optionTitle, "Analyze import data");
  assert.equal(decision.turnTitle, "Analyze import data");
  assert.equal(decision.shouldSeedSessionTitleForTurn, true);
  assert.equal(decision.seededSessionTitleCandidate, "Analyze import data");
  assert.equal(
    decision.titleIntentSignature,
    "analyze|帮我分析这个 CSV|images:0|mentions:src/data/orders.csv|attachments:Uploads/orders.csv",
  );
});

test("turn title decision builds localized fallback titles from provided context", () => {
  const screenshotPlan = resolveSubmitTurnTitleDecision({
    text: "看截图先给修复方案",
    effectiveRunIntent: "plan",
    preferredLanguage: "zh",
    isMainDebugShortcut: false,
    contextSignals: {
      imageParts: 1,
      mentionedFilePaths: [],
      attachedFilePaths: [],
    },
    activeSession: {
      title: "新聊天",
      titleSource: "default",
      messages: [],
    },
  });

  assert.equal(screenshotPlan.localTurnTitle, "基于截图制定修复方案");
  assert.equal(screenshotPlan.turnTitle, "基于截图制定修复方案");
  assert.equal(screenshotPlan.seededSessionTitleCandidate, "基于截图制定修复方案");

  const debug = resolveSubmitTurnTitleDecision({
    text: "用户反馈：启动失败",
    effectiveRunIntent: "plan",
    preferredLanguage: "zh",
    isMainDebugShortcut: true,
  });
  assert.equal(debug.localTurnTitle, "MDEBUG：用户反馈自修复");
  assert.equal(debug.turnTitle, "MDEBUG：用户反馈自修复");
});

test("semantic metadata decision is skipped for hidden, reused, or explicitly titled turns", () => {
  const base = {
    text: "Please inspect this issue",
    isHidden: false,
    reuseCurrentTurn: false,
    optionTurnTitle: null,
    currentMainModeKey: "chat",
    turnId: "turn-1",
    ensuredSessionId: 42,
    sessionScopeKey: "/tmp/main-project",
    effectiveRunIntent: "respond",
    preferredLanguage: "en",
    currentConfig: { language: "en" },
    contextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [] },
    titleIntentSignature: "respond|Please inspect this issue|images:0|mentions:|attachments:",
    seededSessionTitleCandidate: "Please inspect this issue",
  };

  assert.equal(resolveSubmitSemanticMetadataDecision({ ...base, isHidden: true }), null);
  assert.equal(resolveSubmitSemanticMetadataDecision({ ...base, reuseCurrentTurn: true }), null);
  assert.equal(resolveSubmitSemanticMetadataDecision({ ...base, optionTurnTitle: "Explicit title" }), null);
});

test("semantic metadata decision builds a stable request and callback guard context", () => {
  const config = { language: "zh", provider: "local" };
  const decision = resolveSubmitSemanticMetadataDecision({
    text: "分析这个截图里的布局问题",
    isHidden: false,
    reuseCurrentTurn: false,
    optionTurnTitle: null,
    currentMainModeKey: "chat",
    turnId: "turn-semantic",
    ensuredSessionId: 123,
    sessionScopeKey: "/tmp/main-project",
    effectiveRunIntent: "analyze",
    preferredLanguage: "zh",
    currentConfig: config,
    contextSignals: {
      imageParts: 1,
      mentionedFilePaths: ["src/App.tsx"],
      attachedFilePaths: ["Uploads/screen.png"],
    },
    titleIntentSignature: "analyze|分析这个截图里的布局问题|images:1|mentions:src/App.tsx|attachments:Uploads/screen.png",
    seededSessionTitleCandidate: "分析截图中的问题",
  });

  assert.ok(decision);
  assert.equal(decision.expectedTurnId, "turn-semantic");
  assert.equal(decision.expectedTurnPrompt, "分析这个截图里的布局问题");
  assert.equal(decision.expectedSessionId, 123);
  assert.equal(decision.sessionScopeKey, "/tmp/main-project");
  assert.equal(decision.titleIntentSignature, "analyze|分析这个截图里的布局问题|images:1|mentions:src/App.tsx|attachments:Uploads/screen.png");
  assert.equal(decision.seededSessionTitleCandidate, "分析截图中的问题");
  assert.deepEqual(decision.request, {
    input: "分析这个截图里的布局问题",
    intent: "analyze",
    language: "zh",
    config,
    contextSignals: {
      imageParts: 1,
      mentionedFilePaths: ["src/App.tsx"],
      attachedFilePaths: ["Uploads/screen.png"],
      subagentPreference: "unspecified",
    },
  });
});

test("local studio turn patch appends user and system blocks for new visible turns", () => {
  const parentTurn = turn({
    id: "parent",
    status: "awaiting_approval",
    collapsed: false,
  });
  const patch = buildSubmitLocalStudioTurnPatch({
    taskFlow: [{ id: 1, turnId: "parent", type: "user", content: "先规划" }],
    conversationTurns: [parentTurn],
    text: "/help",
    systemContent: "Game Studio help",
    turnId: "turn-local",
    userBlockId: 2,
    systemBlockId: 3,
    userContextItems: [{ kind: "file", path: "Assets/Main.cs", label: "Assets/Main.cs", status: "ready" }],
    isHidden: false,
    reuseCurrentTurn: false,
    parentPlanTurnId: "parent",
    parentPlanTurnDoneSummary: "计划已批准，执行已交接到新的回合。",
    effectiveRunIntent: "studio_workflow",
    effectiveDisplayIntent: "studio_workflow",
    effectiveIntentSummary: "Game Studio：帮助",
    effectiveCommandDirective: { kind: "studio", source: "studio_slash", requiresApproval: false },
    effectiveWorkflowMode: "edit",
    turnTitle: "Game Studio Help",
    systemVariant: "game_studio_local_markdown",
    createdAtMs: 456,
  });

  assert.equal(patch.taskFlow.length, 3);
  assert.equal(patch.userBlock.id, 2);
  assert.equal(patch.userBlock.content, "/help");
  assert.equal(patch.userBlock.contextItems.length, 1);
  assert.equal(patch.systemBlock.id, 3);
  assert.equal(patch.systemBlock.variant, "game_studio_local_markdown");
  assert.equal(patch.conversationTurns[0].id, "parent");
  assert.equal(patch.conversationTurns[0].status, "done");
  assert.equal(patch.conversationTurns[0].collapsed, true);
  assert.equal(patch.conversationTurns[0].summary, "计划已批准，执行已交接到新的回合。");
  assert.equal(patch.conversationTurns[1].id, "turn-local");
  assert.equal(patch.conversationTurns[1].status, "done");
  assert.equal(patch.conversationTurns[1].summary, "Game Studio help");
  assert.deepEqual(patch.conversationTurns[1].blockIds, [2, 3]);
});

test("local studio turn patch reuses existing turns and keeps block ids unique", () => {
  const existingTurn = turn({
    id: "turn-1",
    status: "awaiting_input",
    intent: "plan",
    displayIntent: "plan",
    intentSummary: "已有摘要",
    blockIds: [7],
  });
  const patch = buildSubmitLocalStudioTurnPatch({
    taskFlow: [{ id: 7, turnId: "turn-1", type: "user", content: "/agent" }],
    conversationTurns: [existingTurn],
    text: "/agent gameplay",
    systemContent: "Specialist switched",
    turnId: "turn-1",
    userBlockId: 7,
    systemBlockId: 8,
    isHidden: false,
    reuseCurrentTurn: true,
    parentPlanTurnDoneSummary: "done",
    effectiveRunIntent: "studio_workflow",
    effectiveDisplayIntent: "studio_workflow",
    effectiveIntentSummary: "Game Studio：专家",
    effectiveCommandDirective: null,
    effectiveWorkflowMode: "edit",
    turnTitle: "Switch specialist",
    createdAtMs: 789,
  });

  assert.equal(patch.taskFlow.length, 3);
  assert.equal(patch.conversationTurns.length, 1);
  assert.equal(patch.conversationTurns[0].status, "done");
  assert.equal(patch.conversationTurns[0].displayIntent, "studio_workflow");
  assert.equal(patch.conversationTurns[0].intentSummary, "已有摘要");
  assert.deepEqual(patch.conversationTurns[0].blockIds, [7, 8]);
});

test("run state patch clears visible input, consumed reply options, plan state, and grants consent", () => {
  const patch = buildSubmitRunStatePatch({
    turnId: "turn-1",
    isHidden: false,
    currentInput: "用户还在输入",
    preferredLanguage: "zh",
    shouldArchiveChoiceFeedback: true,
    currentNormalizedStreamState: {
      visibleText: "请选择",
      hiddenThought: "x",
      replyOptions: [{ label: "执行一次", value: "执行一次", action: "execute_once" }],
      hasExplicitUserChoiceRequest: true,
      toolCalls: [],
      finishReason: "stop",
    },
    parsedStudioCommand: { type: "workflow", slug: "implement", args: "camera" },
    effectiveWorkflowMode: "edit",
    preservePlanState: false,
    shouldGrantExecutionConsentForTurn: true,
    currentConfig: { workflowMode: "chat", language: "zh" },
  });

  assert.equal(patch.currentTurnId, "turn-1");
  assert.equal(patch.input, "");
  assert.equal(patch.preferredResponseLanguage, "zh");
  assert.equal(patch.pendingSlashCommand.slug, "implement");
  assert.equal(patch.lockedComposerIntent, null);
  assert.equal(patch.pendingRunDecision, null);
  assert.equal(patch.isGenerating, true);
  assert.equal(patch.config.workflowMode, "edit");
  assert.equal(patch.config.language, "zh");
  assert.deepEqual(patch.normalizedStreamState.replyOptions, []);
  assert.equal(patch.normalizedStreamState.finishReason, null);
  assert.equal(patch.isPlanApproved, false);
  assert.equal(patch.planApprovalChoice, null);
  assert.equal(patch.pendingPlanApprovalHandoff, null);
  assert.equal(patch.planApprovalExecutionStartedForTurnId, null);
  assert.equal(patch.clearedPlanTurnId, null);
  assert.equal(patch.planAutoResumeCount, 0);
  assert.equal(patch.planExecutionProgressSnapshot, null);
  assert.deepEqual(patch.currentTurnExecutionConsent, { turnId: "turn-1", granted: true });
  assert.equal(patch.elapsedTime, 0);
});

test("run state patch preserves hidden input and approved plan state when requested", () => {
  const patch = buildSubmitRunStatePatch({
    turnId: "turn-hidden",
    isHidden: true,
    currentInput: "draft text",
    preferredLanguage: "en",
    shouldArchiveChoiceFeedback: false,
    currentNormalizedStreamState: {
      visibleText: "",
      hiddenThought: "",
      replyOptions: [{ label: "Continue", value: "Continue" }],
      hasExplicitUserChoiceRequest: false,
      toolCalls: [],
      finishReason: "stop",
    },
    parsedStudioCommand: { type: "agent", slug: "gameplay" },
    effectiveWorkflowMode: "plan",
    preservePlanState: true,
    shouldGrantExecutionConsentForTurn: false,
    currentConfig: { workflowMode: "edit", language: "en" },
  });

  assert.equal(patch.input, "draft text");
  assert.equal(patch.pendingSlashCommand, null);
  assert.equal(patch.config.workflowMode, "plan");
  assert.equal(patch.normalizedStreamState, undefined);
  assert.equal(Object.hasOwn(patch, "isPlanApproved"), false);
  assert.equal(Object.hasOwn(patch, "currentTurnExecutionConsent"), false);
});

test("approved same-turn execution commit clears pending transition only when a run state is created", () => {
  const patch = buildSubmitRunStatePatch({
    turnId: "turn-plan",
    isHidden: true,
    currentInput: "",
    preferredLanguage: "en",
    shouldArchiveChoiceFeedback: false,
    currentNormalizedStreamState: {
      visibleText: "",
      hiddenThought: "",
      replyOptions: [],
      hasExplicitUserChoiceRequest: false,
      toolCalls: [],
      finishReason: null,
    },
    parsedStudioCommand: null,
    effectiveWorkflowMode: "plan",
    preservePlanState: true,
    shouldGrantExecutionConsentForTurn: true,
    currentConfig: { workflowMode: "plan", language: "en" },
  });

  assert.equal(patch.pendingPlanApprovalHandoff, null);
  assert.equal(patch.planApprovalExecutionStartedForTurnId, "turn-plan");
  assert.deepEqual(patch.currentTurnExecutionConsent, { turnId: "turn-plan", granted: true });
});

test("harness run marker draft initializes launch telemetry without store state", () => {
  const marker = buildSubmitHarnessRunMarkerDraft({
    runId: "run-1",
    instanceId: "instance-1",
    runSessionKey: "/tmp/game:42",
    runWorkspace: "/tmp/game",
    runSessionId: 42,
    turnId: "turn-1",
    effectiveRunIntent: "studio_workflow",
    runtimeRunIntent: "execute",
    planStage: "approved",
    isPlanApproved: true,
    messagesLen: 7,
    startedAtMs: 123456,
  });

  assert.equal(marker.schemaVersion, 1);
  assert.equal(marker.runId, "run-1");
  assert.equal(marker.instanceId, "instance-1");
  assert.equal(marker.sessionKey, "/tmp/game:42");
  assert.equal(marker.workspace, "/tmp/game");
  assert.equal(marker.sessionId, 42);
  assert.equal(marker.turnId, "turn-1");
  assert.equal(marker.status, "running");
  assert.equal(marker.workflowMode, "edit");
  assert.equal(marker.runtimeIntent, "execute");
  assert.equal(marker.planStage, "approved");
  assert.equal(marker.isPlanApproved, true);
  assert.equal(marker.iteration, 0);
  assert.equal(marker.maxIterations, 0);
  assert.equal(marker.messagesLen, 7);
  assert.equal(marker.toolCount, 0);
  assert.equal(marker.latestTool, null);
  assert.equal(marker.latestToolTarget, null);
  assert.equal(marker.activeStreamId, null);
  assert.equal(marker.streamStatus, "run_started");
  assert.equal(marker.streamChunkCount, 0);
  assert.equal(marker.streamByteCount, 0);
  assert.equal(marker.streamElapsedMs, null);
  assert.equal(marker.streamLifecycleStatus, null);
  assert.equal(marker.lastStreamError, null);
  assert.equal(marker.startedAt, 123456);
  assert.equal(marker.updatedAt, 123456);
  assert.equal(marker.closedAt, null);
  assert.equal(marker.closeReason, null);
});

test("harness run marker draft normalizes missing workspace and session id", () => {
  const marker = buildSubmitHarnessRunMarkerDraft({
    runId: "run-2",
    instanceId: "instance-2",
    runSessionKey: "__MAIN_GLOBAL_CHAT__:9",
    runWorkspace: "",
    runSessionId: null,
    turnId: "turn-2",
    effectiveRunIntent: "respond",
    runtimeRunIntent: "respond",
    planStage: "idle",
    isPlanApproved: false,
    messagesLen: 1,
    startedAtMs: 987,
  });

  assert.equal(marker.workspace, null);
  assert.equal(marker.sessionId, null);
  assert.equal(marker.workflowMode, "chat");
  assert.equal(marker.runtimeIntent, "respond");
});

test("visible turn patch archives selected reply options and appends a new user turn", () => {
  const previousTurn = turn({
    id: "turn-1",
    blockIds: [7],
    collapsed: false,
  });
  const patch = buildSubmitVisibleTurnPatch({
    taskFlow: [
      {
        id: 7,
        turnId: "turn-1",
        type: "agent",
        content: "是否执行？",
        options: [
          { label: "执行一次", value: "执行一次", action: "execute_once" },
        ],
      },
    ],
    conversationTurns: [previousTurn],
    text: "执行一次",
    turnId: "turn-2",
    userBlockId: 8,
    userContextItems: [{ kind: "file", path: "src/App.tsx", label: "src/App.tsx", status: "ready" }],
    images: ["data:image/png;base64,abc"],
    isHidden: false,
    reuseCurrentTurn: false,
    parentPlanTurnDoneSummary: "done",
    isInternalTurn: false,
    shouldExplicitlyReuseCurrentTurn: false,
    shouldAutoResumeChoiceTurn: false,
    currentTurnHasReplyOptions: false,
    explicitReplyOptionSourceTurnId: "turn-1",
    selectedReplyOptionText: "执行一次",
    effectiveRunIntent: "execute",
    effectiveDisplayIntent: "execute",
    effectiveIntentSummary: "执行：执行一次",
    effectiveCommandDirective: null,
    effectiveWorkflowMode: "edit",
    initialTurnStatus: "executing",
    turnTitle: "执行一次",
    createdAtMs: 123,
  });

  assert.equal(patch.shouldArchiveChoiceFeedback, true);
  assert.equal(patch.archiveSummary.archivedOptionBlocks, 1);
  assert.equal(patch.archiveSummary.matchMode, "turn");
  assert.equal(patch.taskFlow.length, 2);
  assert.equal(patch.taskFlow[0].type, "agent");
  assert.equal(patch.taskFlow[0].archivedAfterChoice, true);
  assert.equal(patch.taskFlow[0].archivedProposal, true);
  assert.equal(patch.userBlock.id, 8);
  assert.deepEqual(patch.userBlock.images, ["data:image/png;base64,abc"]);
  assert.equal(patch.conversationTurns[0].collapsed, true);
  assert.equal(patch.conversationTurns[1].id, "turn-2");
  assert.deepEqual(patch.conversationTurns[1].blockIds, [8]);
});

test("visible turn patch appends user blocks to reused turns without duplicating ids", () => {
  const existingTurn = turn({
    id: "turn-1",
    blockIds: [1],
    status: "awaiting_input",
    intent: "respond",
    mode: "chat",
  });
  const patch = buildSubmitVisibleTurnPatch({
    taskFlow: [
      { id: 1, turnId: "turn-1", type: "user", content: "原始问题" },
    ],
    conversationTurns: [existingTurn],
    text: "继续修复",
    turnId: "turn-1",
    userBlockId: 2,
    isHidden: false,
    reuseCurrentTurn: true,
    parentPlanTurnDoneSummary: "done",
    isInternalTurn: false,
    shouldExplicitlyReuseCurrentTurn: true,
    shouldAutoResumeChoiceTurn: false,
    currentTurnHasReplyOptions: false,
    effectiveRunIntent: "execute",
    effectiveDisplayIntent: "execute",
    effectiveIntentSummary: "执行：继续修复",
    effectiveCommandDirective: { kind: "file_modify", source: "continuation", requiresApproval: true },
    effectiveWorkflowMode: "edit",
    initialTurnStatus: "executing",
    turnTitle: "继续修复",
    createdAtMs: 456,
  });

  assert.equal(patch.taskFlow.length, 2);
  assert.equal(patch.userBlock.id, 2);
  assert.equal(patch.conversationTurns.length, 1);
  assert.equal(patch.conversationTurns[0].status, "executing");
  assert.equal(patch.conversationTurns[0].intent, "execute");
  assert.equal(patch.conversationTurns[0].mode, "edit");
  assert.deepEqual(patch.conversationTurns[0].blockIds, [1, 2]);
});

test("visible turn patch creates hidden internal turns without user blocks", () => {
  const parentTurn = turn({
    id: "parent",
    intent: "plan",
    displayIntent: "plan",
    status: "awaiting_approval",
  });
  const patch = buildSubmitVisibleTurnPatch({
    taskFlow: [],
    conversationTurns: [parentTurn],
    text: "hidden resume",
    turnId: "turn-hidden",
    userBlockId: null,
    isHidden: true,
    reuseCurrentTurn: false,
    uiParentTurnId: "parent",
    parentPlanTurnId: "parent",
    parentPlanTurnDoneSummary: "Plan approved; execution was handed off to a new turn.",
    isInternalTurn: true,
    shouldExplicitlyReuseCurrentTurn: false,
    shouldAutoResumeChoiceTurn: false,
    currentTurnHasReplyOptions: false,
    effectiveRunIntent: "plan",
    effectiveDisplayIntent: "execute",
    effectiveIntentSummary: "执行：hidden resume",
    effectiveCommandDirective: null,
    effectiveWorkflowMode: "plan",
    initialTurnStatus: "planning",
    turnTitle: "Plan Execution Resume",
    createdAtMs: 789,
  });

  assert.equal(patch.userBlock, null);
  assert.equal(patch.taskFlow.length, 0);
  assert.equal(patch.conversationTurns[0].id, "parent");
  assert.equal(patch.conversationTurns[0].status, "done");
  assert.equal(patch.conversationTurns[0].summary, "Plan approved; execution was handed off to a new turn.");
  assert.equal(patch.conversationTurns[1].id, "turn-hidden");
  assert.equal(patch.conversationTurns[1].uiVisibility, "internal");
  assert.deepEqual(patch.conversationTurns[1].blockIds, []);
});

test("execution approval decision builds pending confirmation for real operations", () => {
  const decision = resolveSubmitExecutionApprovalDecision({
    text: "直接修改 src/App.tsx",
    preferredLanguage: "zh",
    resolution: baseResolution({
      intent: "execute",
      riskLevel: "medium",
      reason: "file edit required",
    }),
    effectiveCommandDirective: {
      kind: "file_modify",
      source: "natural_language",
      requiresApproval: true,
    },
    isLocalFastStudioCommand: false,
  });

  assert.equal(decision.locallyRequiresExecutionApproval, true);
  assert.equal(decision.pendingRunDecision.source, "pre_submit");
  assert.equal(decision.pendingRunDecision.suggestedIntent, "execute");
  assert.deepEqual(
    decision.pendingRunDecision.options.map((option) => option.id),
    ["execute", "respond"],
  );
});

test("execution approval decision skips local-fast Game Studio commands", () => {
  const decision = resolveSubmitExecutionApprovalDecision({
    text: "/help",
    preferredLanguage: "zh",
    resolution: baseResolution({
      intent: "studio_workflow",
      riskLevel: "medium",
      reason: "local command",
    }),
    effectiveCommandDirective: {
      kind: "studio",
      source: "studio_slash",
      requiresApproval: true,
    },
    isLocalFastStudioCommand: true,
  });

  assert.equal(decision.locallyRequiresExecutionApproval, true);
  assert.equal(decision.pendingRunDecision, null);
});

test("preflight result decision preserves model-provided user choice options", () => {
  const decision = resolveSubmitPreflightResultDecision({
    text: "帮我处理这个大改动",
    preferredLanguage: "zh",
    resolution: baseResolution({
      intent: "plan",
      riskLevel: "high",
      reason: "local planner wants a decision",
    }),
    preflight: {
      intent: "plan",
      confidence: 0.62,
      reason: "ambiguous scope",
      needsUserChoice: true,
      question: "先规划还是直接执行？",
      options: [
        { id: "plan", label: "先规划", value: "先给我计划" },
        { id: "respond", label: "先解释", value: "先解释风险" },
      ],
      commandDirective: { kind: "none", source: "preflight", requiresApproval: false },
    },
  });

  assert.equal(decision.kind, "ask_user_choice");
  assert.equal(decision.pendingRunDecision.source, "preflight");
  assert.equal(decision.pendingRunDecision.title, "先规划还是直接执行？");
  assert.deepEqual(
    decision.pendingRunDecision.options.map((option) => option.id),
    ["plan", "respond"],
  );
});

test("preflight result decision asks before upgrading natural chat to execution", () => {
  const decision = resolveSubmitPreflightResultDecision({
    text: "顺手把这个文件改掉",
    preferredLanguage: "zh",
    resolution: baseResolution(),
    preflight: {
      intent: "execute",
      confidence: 0.88,
      reason: "requires a real file edit",
      riskLevel: "medium",
      requiresApproval: true,
      commandDirective: {
        kind: "file_modify",
        source: "preflight",
        requiresApproval: true,
      },
    },
  });

  assert.equal(decision.kind, "ask_execution_confirmation");
  assert.equal(decision.resolvedIntent, "execute");
  assert.equal(decision.preflightSuggestsOperation, true);
  assert.equal(decision.pendingRunDecision.suggestedIntent, "execute");
  assert.deepEqual(
    decision.pendingRunDecision.options.map((option) => option.id),
    ["execute", "respond", "plan"],
  );
});

test("preflight result decision resumes with local resolution when preflight returns nothing", () => {
  const decision = resolveSubmitPreflightResultDecision({
    text: "解释一下这个设计",
    preferredLanguage: "en",
    resolution: baseResolution({
      intent: "respond",
      reason: "local router keeps this as a natural reply",
    }),
    preflight: null,
  });

  assert.equal(decision.kind, "resume_with_preflight");
  assert.equal(decision.pendingRunDecision, null);
  assert.equal(decision.resolvedIntent, "respond");
  assert.equal(decision.commandDirective.kind, "none");
  assert.equal(decision.preflightSuggestsOperation, false);
  assert.match(decision.intentSummary, /Respond|natural reply/i);
});

test("preflight staleness decision ignores unchanged empty composer input", () => {
  const decision = resolveSubmitPreflightStalenessDecision({
    originalText: "顺手把这个文件改掉",
    latestInput: "   ",
    originalMainModeKey: "main_mode",
    latestMainModeKey: "main_mode",
    lockedComposerIntent: null,
  });

  assert.equal(decision.stale, false);
  assert.equal(decision.latestChars, 0);
  assert.equal(decision.hasExplicitShortcut, false);
});

test("preflight staleness decision detects changed input mode and locks", () => {
  const changedInput = resolveSubmitPreflightStalenessDecision({
    originalText: "顺手把这个文件改掉",
    latestInput: "先解释一下",
    originalMainModeKey: "main_mode",
    latestMainModeKey: "main_mode",
    lockedComposerIntent: null,
  });
  assert.equal(changedInput.stale, true);
  assert.equal(changedInput.latestChars, "先解释一下".length);

  const changedMode = resolveSubmitPreflightStalenessDecision({
    originalText: "顺手把这个文件改掉",
    latestInput: "   ",
    originalMainModeKey: "main_mode",
    latestMainModeKey: "game_studio",
    lockedComposerIntent: null,
  });
  assert.equal(changedMode.stale, true);

  const lockedIntent = resolveSubmitPreflightStalenessDecision({
    originalText: "顺手把这个文件改掉",
    latestInput: "   ",
    originalMainModeKey: "main_mode",
    latestMainModeKey: "main_mode",
    lockedComposerIntent: "plan",
  });
  assert.equal(lockedIntent.stale, true);
  assert.equal(lockedIntent.hasLockedComposerIntent, true);
});

test("preflight staleness decision detects explicit shortcuts in the latest input", () => {
  const decision = resolveSubmitPreflightStalenessDecision({
    originalText: "顺手把这个文件改掉",
    latestInput: "/plan 先规划",
    originalMainModeKey: "main_mode",
    latestMainModeKey: "main_mode",
    lockedComposerIntent: null,
  });

  assert.equal(decision.stale, true);
  assert.equal(decision.hasExplicitShortcut, true);
});

test("blocking preflight effect builds a stable request descriptor only when the gate is active", () => {
  const skipped = buildSubmitBlockingPreflightEffect({
    resolution: baseResolution({ intent: "plan", riskLevel: "medium" }),
    currentMainModeKey: "game_studio",
    text: "帮我做一个大改动",
    preferredLanguage: "zh",
    currentConfig: { language: "zh" },
    sendOriginSessionKey: "workspace:1",
  });
  assert.equal(skipped, null);

  const config = { language: "zh", activeProfile: "local" };
  const effect = buildSubmitBlockingPreflightEffect({
    resolution: baseResolution({ intent: "plan", riskLevel: "medium", reason: "low confidence plan" }),
    currentMainModeKey: "main_mode",
    text: "帮我做一个大改动",
    images: ["data:image/png;base64,abc"],
    options: { preservePlanState: true, turnIdOverride: "turn-override" },
    preferredLanguage: "zh",
    currentConfig: config,
    sendOriginSessionKey: "workspace:1",
  });

  assert.ok(effect);
  assert.deepEqual(effect.request, {
    input: "帮我做一个大改动",
    language: "zh",
    mainModeKey: "main_mode",
    config,
  });
  assert.equal(effect.originalText, "帮我做一个大改动");
  assert.deepEqual(effect.originalImages, ["data:image/png;base64,abc"]);
  assert.equal(effect.originalOptions.turnIdOverride, "turn-override");
  assert.equal(effect.sendOriginSessionKey, "workspace:1");
});

test("preflight effect action discards stale composer state before applying decisions", () => {
  const effect = buildSubmitBlockingPreflightEffect({
    resolution: baseResolution({ intent: "plan", riskLevel: "medium" }),
    currentMainModeKey: "main_mode",
    text: "帮我做一个大改动",
    preferredLanguage: "zh",
    currentConfig: { language: "zh" },
    sendOriginSessionKey: "workspace:1",
  });

  const action = resolveSubmitPreflightEffectAction({
    effect,
    preflight: {
      intent: "plan",
      confidence: 0.99,
      reason: "would otherwise resume",
    },
    latestInput: "/plan 改成先规划",
    latestMainModeKey: "main_mode",
    lockedComposerIntent: null,
    isOriginSessionActive: true,
  });

  assert.equal(action.kind, "stale_discard");
  assert.equal(action.log.originalChars, "帮我做一个大改动".length);
  assert.equal(action.log.hasExplicitShortcut, true);
});

test("preflight effect action applies pending decisions before inactive-session checks", () => {
  const effect = buildSubmitBlockingPreflightEffect({
    resolution: baseResolution({ intent: "plan", riskLevel: "high", reason: "ambiguous scope" }),
    currentMainModeKey: "main_mode",
    text: "帮我处理这个大改动",
    preferredLanguage: "zh",
    currentConfig: { language: "zh" },
    sendOriginSessionKey: "workspace:1",
  });

  const action = resolveSubmitPreflightEffectAction({
    effect,
    preflight: {
      intent: "plan",
      confidence: 0.62,
      reason: "ambiguous scope",
      needsUserChoice: true,
      question: "先规划还是直接执行？",
      options: [
        { id: "plan", label: "先规划", value: "先给我计划" },
        { id: "respond", label: "先解释", value: "先解释风险" },
      ],
    },
    latestInput: "   ",
    latestMainModeKey: "main_mode",
    lockedComposerIntent: null,
    isOriginSessionActive: false,
  });

  assert.equal(action.kind, "set_pending_decision");
  assert.equal(action.pendingRunDecision.source, "preflight");
  assert.equal(action.pendingRunDecision.title, "先规划还是直接执行？");
});

test("preflight effect action skips inactive sessions or resumes with forced skip-intent options", () => {
  const effect = buildSubmitBlockingPreflightEffect({
    resolution: baseResolution({ intent: "plan", riskLevel: "medium", reason: "low confidence plan" }),
    currentMainModeKey: "main_mode",
    text: "帮我做一个大改动",
    images: ["img"],
    options: { preservePlanState: true, turnIdOverride: "turn-override" },
    preferredLanguage: "zh",
    currentConfig: { language: "zh" },
    sendOriginSessionKey: "workspace:1",
  });

  const skipped = resolveSubmitPreflightEffectAction({
    effect,
    preflight: null,
    latestInput: "   ",
    latestMainModeKey: "main_mode",
    lockedComposerIntent: null,
    isOriginSessionActive: false,
  });
  assert.equal(skipped.kind, "skip_inactive_session");
  assert.equal(skipped.phase, "intent_preflight");
  assert.equal(skipped.sessionKey, "workspace:1");

  const resumed = resolveSubmitPreflightEffectAction({
    effect,
    preflight: {
      intent: "plan",
      confidence: 0.96,
      reason: "confirmed planning",
      title: "制定方案",
      summary: "计划：制定方案",
    },
    latestInput: "   ",
    latestMainModeKey: "main_mode",
    lockedComposerIntent: null,
    isOriginSessionActive: true,
  });
  assert.equal(resumed.kind, "resume");
  assert.equal(resumed.text, "帮我做一个大改动");
  assert.deepEqual(resumed.images, ["img"]);
  assert.equal(resumed.options.preservePlanState, true);
  assert.equal(resumed.options.turnIdOverride, "turn-override");
  assert.equal(resumed.options.skipIntentResolution, true);
  assert.equal(resumed.options.resolvedIntent, "plan");
  assert.equal(resumed.options.turnTitle, "制定方案");
  assert.equal(resumed.options.intentSummary, "计划：制定方案");
});

test("preflight resume options preserve original options and force skip intent resolution", () => {
  const decision = resolveSubmitPreflightResultDecision({
    text: "顺手把这个文件改掉",
    preferredLanguage: "zh",
    resolution: baseResolution({
      intent: "execute",
      riskLevel: "medium",
      reason: "file edit required",
    }),
    preflight: {
      intent: "execute",
      confidence: 0.98,
      reason: "confirmed edit",
      title: "修复文件",
      summary: "执行：修复文件",
      commandDirective: {
        kind: "file_modify",
        source: "preflight",
        requiresApproval: true,
      },
    },
  });
  const options = buildSubmitPreflightResumeOptions({
    options: {
      hidden: true,
      preservePlanState: true,
      skipIntentResolution: false,
      intentSummary: "旧摘要",
    },
    decision,
  });

  assert.equal(options.hidden, true);
  assert.equal(options.preservePlanState, true);
  assert.equal(options.skipIntentResolution, true);
  assert.equal(options.resolvedIntent, "execute");
  assert.equal(options.commandDirective.kind, "file_modify");
  assert.equal(options.turnTitle, "修复文件");
  assert.equal(options.intentSummary, "执行：修复文件");
});
