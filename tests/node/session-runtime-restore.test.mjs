import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();
let tauriInvoke = async () => "";

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  // Vite expands the bundled Game Studio pack through import.meta.glob. The
  // restore tests do not use those assets, so replace only that build-time
  // expression while executing the store module in Node.
  const source = fs.readFileSync(normalizedPath, "utf8").replace(
    /import\.meta\.glob\([\s\S]*?\)\s+as Record<string, string>/g,
    "({}) as Record<string, string>",
  );
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith("@tauri-apps/")) {
      return {
        invoke: (...args) => tauriInvoke(...args),
        isTauri: () => false,
        listen: async () => () => {},
        open: async () => null,
        relaunch: async () => {},
        exit: async () => {},
        check: async () => null,
      };
    }
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
        path.join(basePath, "index.tsx"),
      ]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildEmptySessionRuntimeSnapshot,
  buildSessionRuntimeSnapshotFromStoreState,
  normalizeSessionRuntimeSnapshot,
  sanitizeTaskBlocksForPersist,
  useAppStore,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/store/useAppStore.ts"));
const { createSubmitSessionRuntimeFacade } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitRuntimeFacade.ts"),
);
const {
  createWorkspaceTurnQueueState,
  reduceWorkspaceTurnQueue,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/store/workspaceTurnQueue.ts"));
const { beginSessionCancellation, getPendingSessionCancellation } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/sessionCancellationBarrier.ts"),
);
const actionRequests = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/actionRequest.ts"));
const pendingToolReview = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/pendingToolReview.ts"));
const turnEvents = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnEvents.ts"));
const goalState = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalState.ts"));
const goalRuntime = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalRuntime.ts"));
const goalPersistence = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalPersistence.ts"));
const {
  extractPlanTasks,
  validatePlanArtifactContent,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));
const {
  PLAN_LIFECYCLE_SCHEMA_VERSION,
  createPlanLifecycleState,
  reducePlanLifecycle,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planLifecycle.ts"));
const { buildPlanApprovalIdentity } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planApprovalIdentity.ts"),
);
const { hashPlanCandidate, hashPlanProjection } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planContract.ts"),
);

const exactPlanSessionKey = "plan-session";
const exactPlanSessionEpoch = "plan-session-epoch-1";

test("runtime guidance user records preserve their stable identity across persistence", () => {
  const persisted = sanitizeTaskBlocksForPersist([
    {
      id: 41,
      turnId: "turn-guided",
      type: "user",
      content: "继续验证当前回合",
      runtimeGuidance: { id: " guidance-41 " },
    },
  ]);

  assert.deepEqual(persisted, [
    {
      id: 41,
      turnId: "turn-guided",
      type: "user",
      content: "继续验证当前回合",
      runtimeGuidance: { id: "guidance-41" },
    },
  ]);
});

function applyPlanTransition(state, command) {
  const result = reducePlanLifecycle(state, command);
  assert.equal(result.disposition, "applied", result.reason);
  return result.state;
}

function exactExecutingPlanLifecycle(artifacts) {
  const identity = buildPlanApprovalIdentity(artifacts);
  const review = {
    sessionKey: exactPlanSessionKey,
    sessionEpoch: exactPlanSessionEpoch,
    turnId: "turn-plan",
    runId: "run-outer",
    parentRunId: null,
    requestId: "request-plan-review",
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
  };
  let state = createPlanLifecycleState({
    sessionKey: exactPlanSessionKey,
    sessionEpoch: exactPlanSessionEpoch,
    updatedAt: 1,
  });
  state = applyPlanTransition(state, {
    type: "start_drafting",
    expectedVersion: state.version,
    at: 10,
    planTurnId: "turn-plan",
    artifactIdentity: identity,
  });
  state = applyPlanTransition(state, {
    type: "request_review",
    expectedVersion: state.version,
    at: 20,
    artifactIdentity: identity,
    reviewIdentity: review,
  });
  const decision = {
    sessionKey: exactPlanSessionKey,
    sessionEpoch: exactPlanSessionEpoch,
    turnId: "turn-plan",
    runId: "run-outer",
    requestId: "request-plan-review",
    kind: "action_decision",
  };
  const approvalLease = {
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    leaseId: "approval-lease-1",
    sessionKey: exactPlanSessionKey,
    sessionEpoch: exactPlanSessionEpoch,
    planTurnId: "turn-plan",
    reviewRunId: "run-outer",
    requestId: "request-plan-review",
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
    approvedAt: 30,
    approvalTurnId: "turn-plan",
    approvalRunId: "run-outer",
    approvalDecisionKind: "action_decision",
  };
  const executionLease = {
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    executionLeaseId: "execution-lease-1",
    approvalLeaseId: approvalLease.leaseId,
    sessionKey: exactPlanSessionKey,
    sessionEpoch: exactPlanSessionEpoch,
    planTurnId: "turn-plan",
    executionTurnId: "turn-plan",
    executionRunId: "run-child",
    parentRunId: "run-outer",
    attempt: 1,
    issuedAt: 30,
    reason: "initial_approval",
    instructionHash: "instruction-hash-1",
    authorization: decision,
  };
  state = applyPlanTransition(state, {
    type: "approve",
    expectedVersion: state.version,
    at: 30,
    expectedReviewIdentity: review,
    decisionIdentity: decision,
    lease: approvalLease,
    executionLease,
  });
  return applyPlanTransition(state, {
    type: "execution_started",
    expectedVersion: state.version,
    at: 31,
    executionLeaseId: executionLease.executionLeaseId,
    instructionHash: executionLease.instructionHash,
    execution: {
      turnId: "turn-plan",
      runId: "run-child",
      parentRunId: "run-outer",
      attempt: 1,
      startedAt: 31,
    },
  });
}

const exactPlanRestoreOptions = {
  expectedSessionKey: exactPlanSessionKey,
  expectedSessionEpoch: exactPlanSessionEpoch,
};

function buildQueuedWorkspaceTurn(
  sessionKey,
  sessionEpoch,
  suffix,
  userBlockId = 10_001,
  payload = { text: `queued ${suffix}` },
) {
  const submittedAt = 10;
  const clientSubmissionId = `submission-${suffix}`;
  const receipt = {
    schemaVersion: 1,
    kind: "workspace_turn_receipt",
    receiptId: `receipt-${suffix}`,
    clientSubmissionId,
    sessionKey,
    sessionEpoch,
    turnId: `turn-${suffix}`,
    userBlockId,
    acceptedAt: submittedAt,
  };
  let queue = createWorkspaceTurnQueueState({
    sessionKey,
    sessionEpoch,
    updatedAt: 1,
  });
  const appended = reduceWorkspaceTurnQueue(queue, {
    type: "append",
    expectedVersion: queue.version,
    at: submittedAt,
    instruction: {
      schemaVersion: 1,
      kind: "workspace_instruction",
      clientSubmissionId,
      sessionKey,
      sessionEpoch,
      source: "composer",
      submittedAt,
      payload,
    },
    receipt,
  });
  assert.equal(appended.disposition, "applied", appended.reason);
  queue = appended.state;
  const committed = reduceWorkspaceTurnQueue(queue, {
    type: "commit",
    expectedVersion: queue.version,
    at: submittedAt + 1,
    clientSubmissionId,
    receiptId: receipt.receiptId,
    sessionKey,
    sessionEpoch,
  });
  assert.equal(committed.disposition, "applied", committed.reason);
  return committed.state;
}

function buildDispatchingWorkspaceTurn(
  sessionKey,
  sessionEpoch,
  suffix,
  userBlockId = 10_001,
  payload = { text: `queued ${suffix}` },
) {
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    suffix,
    userBlockId,
    payload,
  );
  const claimed = reduceWorkspaceTurnQueue(queue, {
    type: "claim",
    expectedVersion: queue.version,
    at: 12,
    claimId: `claim-${suffix}`,
    sessionKey,
    sessionEpoch,
  });
  assert.equal(claimed.disposition, "applied", claimed.reason);
  return claimed.state;
}

function appendQueuedWorkspaceTurn(
  queue,
  suffix,
  userBlockId,
  payload = { text: `queued ${suffix}` },
) {
  const submittedAt = queue.updatedAt + 10;
  const clientSubmissionId = `submission-${suffix}`;
  const receipt = {
    schemaVersion: 1,
    kind: "workspace_turn_receipt",
    receiptId: `receipt-${suffix}`,
    clientSubmissionId,
    sessionKey: queue.sessionKey,
    sessionEpoch: queue.sessionEpoch,
    turnId: `turn-${suffix}`,
    userBlockId,
    acceptedAt: submittedAt,
  };
  const appended = reduceWorkspaceTurnQueue(queue, {
    type: "append",
    expectedVersion: queue.version,
    at: submittedAt,
    instruction: {
      schemaVersion: 1,
      kind: "workspace_instruction",
      clientSubmissionId,
      sessionKey: queue.sessionKey,
      sessionEpoch: queue.sessionEpoch,
      source: "composer",
      submittedAt,
      payload,
    },
    receipt,
  });
  assert.equal(appended.disposition, "applied", appended.reason);
  const committed = reduceWorkspaceTurnQueue(appended.state, {
    type: "commit",
    expectedVersion: appended.state.version,
    at: submittedAt + 1,
    clientSubmissionId,
    receiptId: receipt.receiptId,
    sessionKey: queue.sessionKey,
    sessionEpoch: queue.sessionEpoch,
  });
  assert.equal(committed.disposition, "applied", committed.reason);
  return committed.state;
}

function buildExactWorkspaceInstructionProjection(
  entry,
  {
    status = "executing",
    summary = "",
    runtimeOutcome,
    finalBlock,
  } = {},
) {
  const userBlock = {
    id: entry.receipt.userBlockId,
    turnId: entry.receipt.turnId,
    type: "user",
    content: entry.instruction.payload.text,
    ...(entry.instruction.payload.images?.length
      ? { images: [...entry.instruction.payload.images] }
      : {}),
  };
  const taskFlow = [userBlock, ...(finalBlock ? [finalBlock] : [])];
  return {
    taskFlow,
    conversationTurns: [{
      id: entry.receipt.turnId,
      clientSubmissionId: entry.instruction.clientSubmissionId,
      workspaceInstructionReceiptId: entry.receipt.receiptId,
      workspaceInstructionSource: entry.instruction.source,
      userPrompt: entry.instruction.payload.text,
      title: entry.instruction.payload.text,
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status,
      summary,
      blockIds: taskFlow.map((block) => block.id),
      processCollapsed: false,
      collapsed: false,
      createdAt: entry.receipt.acceptedAt,
      ...(runtimeOutcome ? { runtimeOutcome } : {}),
    }],
  };
}

async function waitForStoreState(predicate, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = useAppStore.getState();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return useAppStore.getState();
}

function buildApprovedPlanContent() {
  return [
    "# Plan 恢复批准边界",
    "",
    "## 用户目标",
    "- 恢复时必须以完整的可审查 artifact 集合验证批准身份。",
    "",
    "## 摘要",
    "- 已读取恢复入口与批准 identity 构建逻辑。",
    "",
    "## 已读证据",
    "- `src/store/useAppStore.ts`：恢复后重新计算 artifact identity。",
    "",
    "## 关键改动",
    "- 当任一可审查 artifact 无效时使旧批准整体失效。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持 PlanArtifact 和 PlanApprovalIdentity 类型不变。",
    "",
    "## 执行步骤",
    "1. 清理所有持久化 artifact。",
    "2. 比较清理前后的完整批准 identity。",
    "",
    "## 验证标准",
    "- 集合缺失任一可审查 artifact 时 isPlanApproved 为 false。",
    "",
    "## 测试方案",
    "- 运行 session runtime restore 定向测试。",
    "",
    "## 假设与默认值",
    "- design.md 与 plan.md 都属于用户批准绑定的内容。",
    "",
  ].join("\n");
}

test("subagent collaboration preference is session-scoped and backward compatible", () => {
  assert.equal(normalizeSessionRuntimeSnapshot({})?.preferSubagents, false);
  assert.equal(normalizeSessionRuntimeSnapshot({ preferSubagents: true })?.preferSubagents, true);
  assert.equal(
    buildSessionRuntimeSnapshotFromStoreState({ preferSubagents: true }).preferSubagents,
    true,
  );
});

test("a fresh Session snapshot cannot inherit runtime identity, memory, Goal, or queue time from its predecessor", () => {
  const createdAt = 2_000;
  const sessionKey = "/tmp/fresh-session:2000";
  const sessionEpoch = "fresh-session-epoch";
  const foreignSessionKey = "/tmp/fresh-session:1000";
  const snapshot = buildEmptySessionRuntimeSnapshot({
    currentSessionId: 1_000,
    currentWorkspace: "/tmp/fresh-session",
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    runtimeEvents: [{
      schemaVersion: 2,
      type: "run.started",
      threadId: foreignSessionKey,
      turnId: "turn-foreign",
      timestampMs: 1,
      runId: "run-foreign",
      parentRunId: null,
    }],
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "instance-foreign",
      runId: "run-foreign",
      sessionKey: foreignSessionKey,
      turnId: "turn-foreign",
      status: "paused",
      startedAt: 1,
      updatedAt: 1,
      closedAt: 1,
      closeReason: "waiting",
    },
    activeActionRequest: {
      schemaVersion: 1,
      requestId: "request-foreign",
      kind: "user_choice",
      sessionKey: foreignSessionKey,
      turnId: "turn-foreign",
      runId: "run-foreign",
      parentRunId: null,
      title: "Foreign choice",
      status: "pending",
      createdAt: 1,
      optionValues: ["continue"],
    },
    turnRuntimeCheckpoints: {
      "turn-foreign": {
        schemaVersion: 1,
        turnId: "turn-foreign",
        sessionKey: foreignSessionKey,
        sessionEpoch: "foreign-session-epoch",
      },
    },
    subagentClosureReceiptLedger: {
      schemaVersion: 1,
      owner: {
        workspaceKey: "/tmp/fresh-session",
        sessionKey: foreignSessionKey,
        sessionEpoch: "foreign-session-epoch",
      },
      receipts: {},
      updatedAt: 1,
    },
    contextMemoryState: { summary: "foreign memory" },
    contextMemoryStateByRuntimeKey: { foreign: { summary: "foreign lane memory" } },
    providerCompatibilityByRuntimeKey: { foreign: { forceXml: true } },
    planAutoResumeCount: 8,
    planExecutionProgressSnapshot: { turnId: "turn-foreign", runId: "run-foreign" },
    activeGoal: {
      id: "goal-foreign",
      objective: "Foreign goal",
      definitionOfDone: [],
      createdAt: 1,
      status: "active",
      iterationBudget: 10,
      sessionKey: foreignSessionKey,
    },
    goalProgress: { goalId: "goal-foreign" },
    goalStatus: "active",
    goalRuntime: { schemaVersion: 3 },
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: true,
  }, "main_mode", {
    sessionKey,
    sessionEpoch,
    createdAt,
  });

  assert.deepEqual(snapshot.runtimeEvents, []);
  assert.equal(snapshot.harnessRunMarker, null);
  assert.equal(snapshot.activeActionRequest, null);
  assert.deepEqual(snapshot.turnRuntimeCheckpoints, {});
  assert.equal(snapshot.subagentClosureReceiptLedger, null);
  assert.equal(snapshot.contextMemoryState, null);
  assert.deepEqual(snapshot.contextMemoryStateByRuntimeKey, {});
  assert.deepEqual(snapshot.providerCompatibilityByRuntimeKey, {});
  assert.equal(snapshot.planAutoResumeCount, 0);
  assert.equal(snapshot.planExecutionProgressSnapshot, null);
  assert.equal(snapshot.activeGoal, null);
  assert.equal(snapshot.goalProgress, null);
  assert.equal(snapshot.goalStatus, "paused");
  assert.equal(snapshot.goalRuntime, null);
  assert.equal(snapshot.planLifecycle.sessionKey, sessionKey);
  assert.equal(snapshot.planLifecycle.sessionEpoch, sessionEpoch);
  assert.equal(snapshot.planLifecycle.updatedAt, createdAt);
  assert.equal(snapshot.workspaceTurnQueue.sessionKey, sessionKey);
  assert.equal(snapshot.workspaceTurnQueue.sessionEpoch, sessionEpoch);
  assert.equal(snapshot.workspaceTurnQueue.updatedAt, createdAt);
});

test("cold restore rejects cross-Session controls, events, queued work, and Goal runtime at the container boundary", () => {
  const sessionKey = "/tmp/restore-container:2";
  const foreignSessionKey = "/tmp/restore-container:1";
  const foreignGoal = goalState.createGoalDefinition({
    objective: "Foreign persisted Goal",
    sessionKey: foreignSessionKey,
    ownerTurnId: "turn-foreign-goal",
  });
  const foreignGoalProgress = goalState.createGoalProgress(foreignGoal.id, "progress.md");
  const foreignGoalRuntime = goalRuntime.buildGoalRuntimeSnapshot({
    goal: foreignGoal,
    progress: foreignGoalProgress,
    phase: "execute",
  });
  const restored = normalizeSessionRuntimeSnapshot({
    runtimeEvents: [
      {
        schemaVersion: 2,
        type: "run.started",
        threadId: foreignSessionKey,
        turnId: "turn-foreign",
        timestampMs: 1,
        runId: "run-foreign",
        parentRunId: null,
      },
      {
        schemaVersion: 2,
        type: "run.started",
        threadId: sessionKey,
        turnId: "turn-current",
        timestampMs: 2,
        runId: "run-current",
        parentRunId: null,
      },
    ],
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "instance-foreign",
      runId: "run-foreign",
      sessionKey: foreignSessionKey,
      turnId: "turn-foreign",
      status: "paused",
      startedAt: 1,
      updatedAt: 1,
      closedAt: 1,
      closeReason: "waiting",
    },
    activeActionRequest: {
      schemaVersion: 1,
      requestId: "request-foreign",
      kind: "user_choice",
      sessionKey: foreignSessionKey,
      turnId: "turn-foreign",
      runId: "run-foreign",
      parentRunId: null,
      title: "Foreign choice",
      status: "pending",
      createdAt: 1,
      optionValues: ["continue"],
    },
    queuedUserMessage: {
      id: "queued-foreign",
      sessionKey: foreignSessionKey,
      text: "Continue foreign Goal",
      status: "queued",
      createdAt: 1,
      runtimeIntentOverride: "goal",
      goalContinuationAuthorization: {
        kind: "goal_continuation_authorization",
        source: "goal_manual_resume",
        workspaceKey: "/tmp/restore-container",
        sessionKey: foreignSessionKey,
        goalId: foreignGoal.id,
        goalRevision: foreignGoal.revision || 1,
        ownerTurnId: "turn-foreign-goal",
      },
    },
    activeGoal: foreignGoal,
    goalProgress: foreignGoalProgress,
    goalStatus: "active",
    goalRuntime: foreignGoalRuntime,
    taskFlow: [],
    agentMessages: [],
    conversationTurns: [],
    currentTurnId: null,
  }, {
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: "restore-container-epoch",
  });

  assert.equal(restored.harnessRunMarker, null);
  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.queuedUserMessage, null);
  assert.equal(restored.activeGoal, null);
  assert.equal(restored.goalProgress, null);
  assert.equal(restored.goalRuntime, null);
  assert.equal(restored.goalStatus, "paused");
  assert.deepEqual(
    restored.runtimeEvents.map((event) => event.threadId),
    [sessionKey],
  );
});

test("cold restore quarantines a keyless queued message with no current Session owner", () => {
  const restored = normalizeSessionRuntimeSnapshot({
    queuedUserMessage: {
      id: "queued-without-owner",
      text: "Continue",
      status: "queued",
      createdAt: 1,
    },
  }, {
    expectedSessionKey: "/tmp/restore-queue-owner:2",
    expectedSessionEpoch: "restore-queue-owner-epoch",
  });

  assert.equal(restored.queuedUserMessage, null);
});

test("cold restore preserves exact Goals and only evidence-owned workspace or keyless legacy Goals", () => {
  const sessionKey = "/tmp/restore-goal-owner:2";
  const workspace = "/tmp/restore-goal-owner";
  for (const ownerSessionKey of [sessionKey, workspace, undefined]) {
    const goal = goalState.createGoalDefinition({
      objective: ownerSessionKey ? "Exact Goal" : "Legacy keyless Goal",
      sessionKey: ownerSessionKey,
      ownerTurnId: "turn-goal-owner",
    });
    const progress = goalState.createGoalProgress(goal.id, "progress.md");
    const runtime = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });
    const restored = normalizeSessionRuntimeSnapshot({
      activeGoal: goal,
      goalProgress: progress,
      goalStatus: "active",
      goalRuntime: runtime,
      taskFlow: [],
      agentMessages: [],
      conversationTurns: ownerSessionKey === sessionKey
        ? []
        : [{
            id: goal.ownerTurnId,
            userPrompt: "Continue the legacy Goal",
            title: "Legacy Goal",
            mode: "edit",
            status: "paused",
            summary: "Paused legacy Goal",
            blockIds: [],
            collapsed: false,
            createdAt: 1,
          }],
      currentTurnId: null,
    }, {
      expectedSessionKey: sessionKey,
      expectedSessionEpoch: "restore-goal-owner-epoch",
      workspacePath: workspace,
    });

    assert.equal(restored.activeGoal?.id, goal.id);
    assert.equal(restored.goalRuntime?.goal.id, goal.id);
    assert.equal(restored.goalProgress?.goalId, goal.id);
  }
});

test("cold restore quarantines workspace-scoped and keyless legacy Goals without local Turn ownership evidence", () => {
  const sessionKey = "/tmp/restore-goal-quarantine:2";
  const workspace = "/tmp/restore-goal-quarantine";
  for (const ownerSessionKey of [workspace, undefined]) {
    const goal = goalState.createGoalDefinition({
      objective: "Ambiguous legacy Goal",
      sessionKey: ownerSessionKey,
      ownerTurnId: "turn-not-in-current-container",
    });
    const progress = goalState.createGoalProgress(goal.id, "progress.md");
    const runtime = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });
    const restored = normalizeSessionRuntimeSnapshot({
      activeGoal: goal,
      goalProgress: progress,
      goalStatus: "active",
      goalRuntime: runtime,
      taskFlow: [],
      agentMessages: [],
      conversationTurns: [],
      currentTurnId: null,
    }, {
      expectedSessionKey: sessionKey,
      expectedSessionEpoch: "restore-goal-quarantine-epoch",
      workspacePath: workspace,
    });

    assert.equal(restored.activeGoal, null);
    assert.equal(restored.goalRuntime, null);
    assert.equal(restored.goalProgress, null);
    assert.equal(restored.goalStatus, "paused");
  }
});

test("cold restore never mixes accepted Goal identity with progress from another Goal", () => {
  const sessionKey = "/tmp/restore-goal-progress:2";
  const goal = goalState.createGoalDefinition({
    objective: "Current Goal",
    sessionKey,
    ownerTurnId: "turn-current-goal",
  });
  const foreignProgress = {
    ...goalState.createGoalProgress("goal-from-another-session", "foreign-progress.md"),
    evidence: [{ id: "foreign-evidence" }],
    milestones: [{ id: "foreign-milestone", text: "Foreign", status: "completed" }],
  };
  const runtime = goalRuntime.buildGoalRuntimeSnapshot({
    goal,
    progress: foreignProgress,
    phase: "execute",
  });
  const restored = normalizeSessionRuntimeSnapshot({
    activeGoal: goal,
    goalProgress: foreignProgress,
    goalStatus: "active",
    goalRuntime: runtime,
  }, {
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: "restore-goal-progress-epoch",
  });

  assert.equal(restored.activeGoal?.id, goal.id);
  assert.equal(restored.goalRuntime?.goal.id, goal.id);
  assert.equal(restored.goalProgress?.goalId, goal.id);
  assert.equal(restored.goalRuntime?.progress.goalId, goal.id);
  assert.deepEqual(restored.goalProgress?.evidence, []);
  assert.deepEqual(restored.goalProgress?.milestones, []);
  assert.equal(restored.goalProgress?.progressFile, "");
});

test("FIFO acknowledgement saves the live Session without revoking its seeded submit owner", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/fifo-owner-preservation";
  const sessionId = 2_001;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "fifo-owner-preservation-epoch";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "owner-preservation",
    20_001,
  );
  const turnId = queue.entries[0].receipt.turnId;
  let facade;
  let ownerToken;
  let revisionBeforeAckSave;

  try {
    useAppStore.setState({
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      sessionsByWorkspace: {
        ...originalState.sessionsByWorkspace,
        [workspace]: [{
          id: sessionId,
          title: "FIFO owner preservation",
          date: new Date(0).toISOString(),
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      harnessRunMarker: null,
      activeActionRequest: null,
      currentTurnId: null,
      isGenerating: false,
      agentStatus: "idle",
      abortController: null,
      sendMessage: () => {
        const runtimeKeys = [
          "currentTurnId",
          "isGenerating",
          "agentStatus",
          "abortController",
          "taskFlow",
          "conversationTurns",
          "runtimeEvents",
          "workspaceTurnQueue",
        ];
        const createRuntime = (state) => Object.fromEntries(
          runtimeKeys.map((key) => [key, state[key]]),
        );
        const pickRuntime = (source) => Object.fromEntries(
          runtimeKeys
            .filter((key) => Object.hasOwn(source, key))
            .map((key) => [key, source[key]]),
        );
        facade = createSubmitSessionRuntimeFacade({
          get: () => useAppStore.getState(),
          set: (patchOrUpdater) => useAppStore.setState(patchOrUpdater),
          runSessionKey: sessionKey,
          createRuntimeFromState: createRuntime,
          pickRuntimePatch: pickRuntime,
        });
        facade.seedSessionRuntime();
        ownerToken = facade.getSessionRuntimeOwnerToken();
        facade.sessionSet({
          currentTurnId: turnId,
          isGenerating: true,
          agentStatus: "running",
        });
        revisionBeforeAckSave = facade.getSessionRevisionToken();
        return true;
      },
    });

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    assert.ok(facade);
    assert.equal(facade.hasSessionRuntimeOwnership(ownerToken), true);
    assert.notEqual(facade.getSessionRevisionToken(), revisionBeforeAckSave);
    assert.deepEqual(
      facade.publishOwnerScopedRuntimeProjection({
        projectedState: { ...facade.sessionGet(), agentStatus: "idle" },
        scopeKey: workspace,
        sessionId,
        expectedRevisionToken: revisionBeforeAckSave,
      }),
      { published: false, disposition: "revision_conflict" },
    );
    assert.equal(useAppStore.getState().currentTurnId, turnId);
    assert.equal(useAppStore.getState().isGenerating, true);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("delayed FIFO bootstrap keeps its owner through ACK and reaches the OMLX transport", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const workspace = "/tmp/fifo-omlx-bootstrap-owner";
  const sessionId = 2_002;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "fifo-omlx-bootstrap-owner-epoch";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "omlx-bootstrap-owner",
    20_002,
    { text: "Summarize this workspace in one sentence." },
  );
  const receipt = queue.entries[0].receipt;
  const defaultTauriInvoke = tauriInvoke;
  const originalWindow = globalThis.window;
  const localStorageValues = new Map();
  let signalTreeStarted;
  const treeStarted = new Promise((resolve) => {
    signalTreeStarted = resolve;
  });
  let releaseTree;
  const treeGate = new Promise((resolve) => {
    releaseTree = resolve;
  });
  const streamInvocations = [];

  try {
    globalThis.window = {
      localStorage: {
        getItem: (key) => localStorageValues.get(String(key)) ?? null,
        setItem: (key, value) => localStorageValues.set(String(key), String(value)),
        removeItem: (key) => localStorageValues.delete(String(key)),
      },
    };
    tauriInvoke = async (command, args) => {
      if (command === "get_project_skeleton") {
        signalTreeStarted();
        await treeGate;
        return "src/\n  main.ts";
      }
      if (command === "start_chat_stream") {
        streamInvocations.push(args);
        throw new Error("deterministic OMLX transport fixture failure");
      }
      if (command === "save_project_session") return args?.session ?? null;
      return "";
    };
    useAppStore.setState({
      ...originalState,
      config: {
        ...originalState.config,
        language: "en",
        workflowMode: "chat",
        activeProfile: "local",
        sessionRecordingEnabled: false,
        instructionsEnabled: false,
        hooksEnabled: false,
        local: {
          ...originalState.config.local,
          provider: "OMLX",
          endpoint: "http://127.0.0.1:8000/v1",
          model: "fixture-omlx-model",
          apiKey: "fixture-key",
        },
      },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "FIFO OMLX bootstrap owner",
          date: new Date(0).toISOString(),
          active: true,
          planLifecycleEpoch: sessionEpoch,
          recordingDisabled: true,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      taskFlow: [],
      agentMessages: [],
      conversationTurns: [],
      runtimeEvents: [],
      harnessRunMarker: null,
      activeActionRequest: null,
      currentTurnId: null,
      isGenerating: false,
      agentStatus: "idle",
      abortController: null,
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      sendMessage: realSendMessage,
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    await treeStarted;
    assert.equal(
      useAppStore.getState().workspaceTurnQueue.entries.length,
      0,
      "FIFO ACK must be saved while workspace discovery is still pending",
    );
    releaseTree();

    const settled = await waitForStoreState((state) =>
      streamInvocations.length > 0 &&
      state.runtimeEvents.some((event) =>
        event.type === "turn.completed" &&
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId
      ) &&
      state.isGenerating === false,
    250);
    const ownedEvents = settled.runtimeEvents.filter((event) =>
      event.threadId === sessionKey && event.turnId === receipt.turnId
    );
    const turn = settled.conversationTurns.find((candidate) => candidate.id === receipt.turnId);
    assert.equal(streamInvocations.length >= 1, true, JSON.stringify({
      events: ownedEvents,
      turn,
      agentBlocks: settled.taskFlow.filter((block) => block.type === "agent"),
    }));
    assert.match(String(streamInvocations[0]?.url || ""), /127\.0\.0\.1:8000\/v1\/chat\/completions$/);
    assert.equal(ownedEvents.filter((event) => event.type === "run.started").length >= 1, true);
    assert.equal(ownedEvents.filter((event) => event.type === "run.completed").length, 1);
    assert.equal(ownedEvents.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(ownedEvents.find((event) => event.type === "run.completed")?.resultKind, "error");
    assert.equal(ownedEvents.find((event) => event.type === "turn.completed")?.resultKind, "error");
    assert.equal(turn?.status, "error");
    assert.equal(turn?.runtimeOutcome?.resultKind, "error");
    assert.equal(settled.isGenerating, false);
    assert.equal(settled.agentStatus, "error");
    assert.match(turn?.summary || "", /turn failed|did not finish/i);
    assert.equal(
      settled.taskFlow.filter((block) =>
        block.type === "agent" &&
        block.turnId === receipt.turnId &&
        block.visibility === "assistant_final"
      ).length,
      1,
    );
  } finally {
    releaseTree?.();
    tauriInvoke = defaultTauriInvoke;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    useAppStore.setState(originalState, true);
  }
});

test("online snapshots preserve a live Turn and only cold restore pauses it", () => {
  const liveTurn = {
    id: "turn-live",
    userPrompt: "continue the workspace task",
    title: "continue the workspace task",
    mode: "edit",
    intent: "execute",
    status: "executing",
    summary: "",
    blockIds: [],
    collapsed: false,
    createdAt: 1,
  };
  const liveSnapshot = buildSessionRuntimeSnapshotFromStoreState({
    taskFlow: [],
    conversationTurns: [liveTurn],
  });

  assert.equal(liveSnapshot.conversationTurns[0].status, "executing");
  assert.equal(liveSnapshot.conversationTurns[0].processCollapsed, false);

  const restored = normalizeSessionRuntimeSnapshot(liveSnapshot);
  assert.equal(restored.conversationTurns[0].status, "paused");
  assert.match(restored.conversationTurns[0].summary, /application restart/i);
});

test("cold restore quarantines unresolved local-fast work and never silently replays its side effect", () => {
  const workspace = "/tmp/session-local-fast-cold-restore";
  const sessionId = 73;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-local-fast-cold-restore";

  const restorePersistedHead = ({
    suffix,
    text,
    conclusion = "none",
    queueStatus = "dispatching",
    includeRunStart = true,
    duplicateRunStart = false,
    extraStreamingFinal = false,
    startParentRunId = null,
    completionParentRunId = startParentRunId,
    outcomeParentRunId = startParentRunId,
    completionRunId = null,
  }) => {
    const queue = (queueStatus === "queued"
      ? buildQueuedWorkspaceTurn
      : buildDispatchingWorkspaceTurn)(
      sessionKey,
      sessionEpoch,
      suffix,
      73_001,
      { text },
    );
    const receipt = queue.entries[0].receipt;
    const runId = `run-${suffix}`;
    const runtimeEvents = includeRunStart
      ? [{
          schemaVersion: 2,
          type: "run.started",
          threadId: sessionKey,
          turnId: receipt.turnId,
          timestampMs: 13,
          runId,
          parentRunId: startParentRunId,
        }]
      : [];
    if (duplicateRunStart && runtimeEvents[0]) {
      runtimeEvents.push({
        ...runtimeEvents[0],
        runId: `${runId}-duplicate`,
      });
    }
    if (conclusion === "run_only" || conclusion === "canonical") {
      runtimeEvents.push({
        schemaVersion: 2,
        type: "run.completed",
        threadId: sessionKey,
        turnId: receipt.turnId,
        timestampMs: 14,
        runId: completionRunId || runId,
        parentRunId: completionParentRunId,
        resultKind: "success",
        summary: "Local command completed.",
      });
    }
    if (conclusion === "canonical") {
      runtimeEvents.push({
        schemaVersion: 2,
        type: "turn.completed",
        threadId: sessionKey,
        turnId: receipt.turnId,
        timestampMs: 14,
        resultKind: "success",
      });
    }
    const persistedSnapshot = JSON.parse(JSON.stringify(
      buildSessionRuntimeSnapshotFromStoreState({
        currentWorkspace: workspace,
        currentSessionId: sessionId,
        taskFlow: [
          {
            id: receipt.userBlockId,
            turnId: receipt.turnId,
            type: "user",
            content: text,
          },
          ...(conclusion === "canonical"
            ? [{
                id: receipt.userBlockId + 1,
                turnId: receipt.turnId,
                type: "agent",
                content: "Local command completed.",
                streaming: false,
                visibility: "assistant_final",
              }, ...(extraStreamingFinal
                ? [{
                    id: receipt.userBlockId + 2,
                    turnId: receipt.turnId,
                    type: "agent",
                    content: "Stale streaming final.",
                    streaming: true,
                    visibility: "assistant_final",
                  }]
                : [])]
            : []),
        ],
        conversationTurns: [{
          id: receipt.turnId,
          clientSubmissionId: receipt.clientSubmissionId,
          workspaceInstructionReceiptId: receipt.receiptId,
          workspaceInstructionSource: queue.entries[0].instruction.source,
          userPrompt: text,
          title: text,
          mode: "edit",
          intent: "execute",
          displayIntent: "execute",
          status: conclusion === "none" ? "executing" : "done",
          summary: conclusion === "none" ? "" : "Local command completed.",
          blockIds: [
            receipt.userBlockId,
            ...(conclusion === "canonical"
              ? [
                  receipt.userBlockId + 1,
                  ...(extraStreamingFinal ? [receipt.userBlockId + 2] : []),
                ]
              : []),
          ],
          collapsed: false,
          createdAt: receipt.acceptedAt,
          ...(conclusion !== "none"
            ? {
                runtimeOutcome: {
                  status: "completed",
                  resultKind: "success",
                  runId,
                  parentRunId: outcomeParentRunId,
                  updatedAt: 14,
                },
              }
            : {}),
        }],
        currentTurnId: receipt.turnId,
        runtimeEvents,
        harnessRunMarker: null,
        workspaceTurnQueue: queue,
        workspaceInstructionLedger: [],
        selectedMainModeKey: "game_studio",
        selectedNexusModeKey: "nexus_game_studio",
        activeStudioAgentKey: "studio_auto",
        gameStudioInitialized: true,
      }),
    ));
    return {
      receipt,
      persistedSnapshot,
      restored: normalizeSessionRuntimeSnapshot(persistedSnapshot, {
        restoreInterruptedGoal: true,
        workspacePath: workspace,
        expectedSessionKey: sessionKey,
        expectedSessionEpoch: sessionEpoch,
        quarantineInterruptedLocalFast: true,
      }),
    };
  };

  const interruptedLocalFast = restorePersistedHead({
    suffix: "local-fast-interrupted",
    text: "/agent writer",
  });
  assert.equal(interruptedLocalFast.restored.workspaceTurnQueue.entries.length, 0);
  const interruptedTurn = interruptedLocalFast.restored.conversationTurns.find(
    (turn) => turn.id === interruptedLocalFast.receipt.turnId,
  );
  assert.equal(interruptedTurn.runtimeOutcome?.status, "completed");
  assert.equal(interruptedTurn.runtimeOutcome?.resultKind, "error");
  const interruptedFinals = interruptedLocalFast.restored.taskFlow.filter((block) =>
    block.turnId === interruptedLocalFast.receipt.turnId &&
    block.type === "agent" &&
    block.visibility === "assistant_final"
  );
  assert.equal(interruptedFinals.length, 1);
  assert.equal(interruptedFinals[0].content, interruptedTurn.summary);
  assert.equal(
    interruptedTurn.summary.length > 96,
    true,
    "the full authoritative quarantine summary must not be truncated",
  );
  assert.equal(
    interruptedLocalFast.restored.runtimeEvents.some((event) =>
      event.type === "run.completed" &&
      event.turnId === interruptedLocalFast.receipt.turnId &&
      event.resultKind === "error" &&
      event.summary === interruptedTurn.summary
    ),
    true,
  );

  const runOnlyLocalFast = restorePersistedHead({
    suffix: "local-fast-run-only",
    text: "/agent writer",
    conclusion: "run_only",
  });
  assert.equal(
    runOnlyLocalFast.restored.workspaceTurnQueue.entries.length,
    0,
    "run.completed is repaired into one visible canonical Turn before retirement",
  );
  assert.equal(
    runOnlyLocalFast.restored.conversationTurns.find(
      (turn) => turn.id === runOnlyLocalFast.receipt.turnId,
    )?.runtimeOutcome?.resultKind,
    "success",
  );

  const completedLocalFast = restorePersistedHead({
    suffix: "local-fast-completed",
    text: "/agent writer",
    conclusion: "canonical",
  });
  assert.equal(
    completedLocalFast.restored.workspaceTurnQueue.entries.length,
    0,
    "matching run.completed and turn.completed may retire the local-fast FIFO head",
  );

  const completedWithoutStart = restorePersistedHead({
    suffix: "local-fast-completed-without-start",
    text: "/agent writer",
    conclusion: "canonical",
    includeRunStart: false,
  });
  const completedWithoutStartTurn = completedWithoutStart.restored.conversationTurns.find(
    (turn) => turn.id === completedWithoutStart.receipt.turnId,
  );
  assert.equal(completedWithoutStart.restored.workspaceTurnQueue.entries.length, 0);
  assert.equal(
    completedWithoutStart.restored.runtimeEvents.filter((event) =>
      event.type === "run.started" &&
      event.turnId === completedWithoutStart.receipt.turnId &&
      event.runId === completedWithoutStartTurn.runtimeOutcome?.runId
    ).length,
    1,
    "a terminal projection without run.started is repaired under its exact Run owner",
  );
  const completedWithoutStartConclusions = completedWithoutStart.restored.runtimeEvents.filter(
    (event) =>
      event.type === "run.completed" &&
      event.turnId === completedWithoutStart.receipt.turnId,
  );
  assert.equal(completedWithoutStartConclusions.length, 1);
  assert.equal(completedWithoutStartConclusions[0].resultKind, "success");
  assert.equal(completedWithoutStartConclusions[0].summary, "Local command completed.");
  for (const conclusion of completedWithoutStartConclusions) {
    assert.equal(
      completedWithoutStart.restored.runtimeEvents.filter((event) =>
        event.type === "run.started" &&
        event.turnId === conclusion.turnId &&
        event.runId === conclusion.runId &&
        event.parentRunId === conclusion.parentRunId
      ).length,
      1,
      "restore must not retain an orphan run.completed after repairing a missing start",
    );
  }
  const repairedStartIndex = completedWithoutStart.restored.runtimeEvents.findIndex((event) =>
    event.type === "run.started" &&
    event.turnId === completedWithoutStart.receipt.turnId
  );
  const repairedRunConclusionIndex = completedWithoutStart.restored.runtimeEvents.findIndex(
    (event) =>
      event.type === "run.completed" &&
      event.turnId === completedWithoutStart.receipt.turnId,
  );
  const repairedTurnConclusionIndex = completedWithoutStart.restored.runtimeEvents.findIndex(
    (event) =>
      event.type === "turn.completed" &&
      event.turnId === completedWithoutStart.receipt.turnId,
  );
  assert.equal(
    repairedStartIndex < repairedRunConclusionIndex &&
      repairedRunConclusionIndex < repairedTurnConclusionIndex,
    true,
    "the repaired trace must preserve start -> run.completed -> turn.completed order",
  );
  assert.equal(
    completedWithoutStart.restored.runtimeEvents[repairedStartIndex].timestampMs <=
      completedWithoutStart.restored.runtimeEvents[repairedRunConclusionIndex].timestampMs,
    true,
  );
  assert.equal(
    completedWithoutStart.restored.conversationTurns.some((turn) =>
      turn.id.startsWith("local-slash-recovery-")
    ),
    false,
  );

  const duplicateStart = restorePersistedHead({
    suffix: "local-fast-duplicate-start",
    text: "/agent writer",
    conclusion: "canonical",
    duplicateRunStart: true,
  });
  assert.equal(duplicateStart.restored.workspaceTurnQueue.entries.length, 0);
  assert.equal(
    duplicateStart.restored.conversationTurns.some((turn) =>
      turn.id.startsWith("local-slash-recovery-") &&
      turn.runtimeOutcome?.resultKind === "error"
    ),
    true,
    "a duplicate source start is quarantined through a distinct recovery owner",
  );
  assert.equal(
    duplicateStart.restored.runtimeEvents.filter((event) =>
      event.type === "turn.completed" &&
      event.turnId === duplicateStart.receipt.turnId
    ).length,
    1,
    "the exact admitted source Turn retains its terminal lifecycle",
  );
  const duplicateSourceTurnTerminalIndex = duplicateStart.restored.runtimeEvents.findIndex(
    (event) =>
      event.type === "turn.completed" &&
      event.turnId === duplicateStart.receipt.turnId,
  );
  const duplicateSourceStarts = duplicateStart.restored.runtimeEvents.filter((event) =>
    event.type === "run.started" &&
    event.turnId === duplicateStart.receipt.turnId
  );
  assert.equal(duplicateSourceStarts.length, 2);
  for (const start of duplicateSourceStarts) {
    const matchingConclusions = duplicateStart.restored.runtimeEvents.filter((event) =>
      event.type === "run.completed" &&
      event.turnId === start.turnId &&
      event.runId === start.runId
    );
    assert.equal(matchingConclusions.length, 1);
    assert.equal(
      duplicateStart.restored.runtimeEvents.indexOf(start) <
        duplicateStart.restored.runtimeEvents.indexOf(matchingConclusions[0]) &&
        duplicateStart.restored.runtimeEvents.indexOf(matchingConclusions[0]) <
          duplicateSourceTurnTerminalIndex,
      true,
      "every corrupt source Run must close before the admitted Turn terminal",
    );
  }
  const duplicateSourceTurn = duplicateStart.restored.conversationTurns.find(
    (turn) => turn.id === duplicateStart.receipt.turnId,
  );
  const duplicateSourceOutcome = duplicateSourceTurn.runtimeOutcome;
  const duplicateOutcomeConclusions = duplicateStart.restored.runtimeEvents.filter((event) =>
    event.type === "run.completed" &&
    event.turnId === duplicateStart.receipt.turnId &&
    event.runId === duplicateSourceOutcome?.runId
  );
  const duplicateSourceFinals = duplicateStart.restored.taskFlow.filter((block) =>
    block.type === "agent" &&
    block.turnId === duplicateStart.receipt.turnId &&
    block.visibility === "assistant_final"
  );
  assert.equal(duplicateOutcomeConclusions.length, 1);
  assert.equal(
    duplicateSourceOutcome?.parentRunId,
    duplicateOutcomeConclusions[0].parentRunId,
  );
  assert.equal(
    duplicateSourceOutcome?.resultKind,
    duplicateOutcomeConclusions[0].resultKind,
  );
  assert.equal(duplicateSourceTurn.summary, duplicateOutcomeConclusions[0].summary);
  assert.equal(duplicateSourceFinals.length, 1);
  assert.equal(duplicateSourceFinals[0].content, duplicateOutcomeConclusions[0].summary);

  const unresolvedDuplicateStart = restorePersistedHead({
    suffix: "local-fast-unresolved-duplicate-start",
    text: "/agent writer",
    duplicateRunStart: true,
  });
  const unresolvedDuplicateSource = unresolvedDuplicateStart.restored.conversationTurns.find(
    (turn) => turn.id === unresolvedDuplicateStart.receipt.turnId,
  );
  assert.equal(unresolvedDuplicateStart.restored.workspaceTurnQueue.entries.length, 0);
  assert.equal(unresolvedDuplicateSource.runtimeOutcome?.status, "completed");
  assert.equal(unresolvedDuplicateSource.runtimeOutcome?.resultKind, "error");
  assert.equal(
    unresolvedDuplicateStart.restored.runtimeEvents.filter((event) =>
      event.type === "turn.completed" &&
      event.turnId === unresolvedDuplicateStart.receipt.turnId
    ).length,
    1,
    "a corrupt multi-Run source without a terminal is closed before recovery presentation",
  );
  assert.equal(
    unresolvedDuplicateStart.restored.conversationTurns.some((turn) =>
      turn.id.startsWith("local-slash-recovery-") &&
      turn.runtimeOutcome?.resultKind === "error"
    ),
    true,
  );

  const duplicateFinal = restorePersistedHead({
    suffix: "local-fast-duplicate-final",
    text: "/agent writer",
    conclusion: "canonical",
    extraStreamingFinal: true,
  });
  assert.equal(duplicateFinal.restored.workspaceTurnQueue.entries.length, 0);
  assert.equal(
    duplicateFinal.restored.taskFlow.filter((block) =>
      block.turnId === duplicateFinal.receipt.turnId &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
    ).length,
    1,
    "a streaming duplicate final is canonicalized instead of being ignored",
  );

  const parentConflict = restorePersistedHead({
    suffix: "local-fast-parent-conflict",
    text: "/agent writer",
    conclusion: "canonical",
    startParentRunId: "run-parent-start",
    completionParentRunId: "run-parent-completion",
    outcomeParentRunId: "run-parent-start",
  });
  assert.equal(
    parentConflict.restored.workspaceTurnQueue.entries.length,
    0,
    "a conflicting persisted parent owner must not wedge the terminal FIFO head",
  );
  assert.equal(
    parentConflict.restored.conversationTurns.some((turn) =>
      turn.id.startsWith("local-slash-recovery-") &&
      turn.runtimeOutcome?.resultKind === "error"
    ),
    true,
    "parent ownership conflict is isolated under a recovery child",
  );

  const noStartOutcomeMismatch = restorePersistedHead({
    suffix: "local-fast-no-start-outcome-mismatch",
    text: "/agent writer",
    conclusion: "canonical",
    includeRunStart: false,
    completionRunId: "run-local-fast-other-owner",
  });
  const mismatchTurnTerminalIndex = noStartOutcomeMismatch.restored.runtimeEvents.findIndex(
    (event) =>
      event.type === "turn.completed" &&
      event.turnId === noStartOutcomeMismatch.receipt.turnId,
  );
  assert.equal(noStartOutcomeMismatch.restored.workspaceTurnQueue.entries.length, 0);
  const mismatchSourceStarts = noStartOutcomeMismatch.restored.runtimeEvents.filter((event) =>
    event.type === "run.started" &&
    event.turnId === noStartOutcomeMismatch.receipt.turnId
  );
  assert.equal(mismatchSourceStarts.length, 2);
  for (const start of mismatchSourceStarts) {
    const conclusionIndex = noStartOutcomeMismatch.restored.runtimeEvents.findIndex((event) =>
      event.type === "run.completed" &&
      event.turnId === start.turnId &&
      event.runId === start.runId
    );
    assert.equal(
      noStartOutcomeMismatch.restored.runtimeEvents.indexOf(start) < conclusionIndex &&
        conclusionIndex < mismatchTurnTerminalIndex,
      true,
      "all repaired source Runs must finish before the existing Turn terminal",
    );
  }

  const queuedWithoutFence = restorePersistedHead({
    suffix: "local-fast-queued-without-fence",
    text: "/agent writer",
    queueStatus: "queued",
    includeRunStart: false,
  });
  assert.equal(
    queuedWithoutFence.restored.workspaceTurnQueue.entries.length,
    0,
    "without a durable pre-execution fence, queued local-fast work is also quarantined",
  );
  assert.equal(
    queuedWithoutFence.restored.conversationTurns.find(
      (turn) => turn.id === queuedWithoutFence.receipt.turnId,
    )?.runtimeOutcome?.resultKind,
    "error",
  );
  const liveNormalization = normalizeSessionRuntimeSnapshot(
    queuedWithoutFence.persistedSnapshot,
    {
      restoreInterruptedGoal: true,
      workspacePath: workspace,
      expectedSessionKey: sessionKey,
      expectedSessionEpoch: sessionEpoch,
    },
  );
  assert.equal(liveNormalization.workspaceTurnQueue.entries.length, 1);
  assert.equal(liveNormalization.workspaceTurnQueue.entries[0].status, "queued");

  const driftQueue = buildDispatchingWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "local-fast-identity-drift",
    73_101,
    { text: "/agent writer" },
  );
  const driftReceipt = driftQueue.entries[0].receipt;
  const sourceRunId = "run-local-fast-identity-drift";
  const recoveryTurnId = "local-slash-recovery-identity-drift";
  const recoveryRunId = `${sourceRunId}-presentation-recovery`;
  const recoverySummary = "Slash command failed after its Turn identity changed.";
  const driftSnapshot = JSON.parse(JSON.stringify(
    buildSessionRuntimeSnapshotFromStoreState({
      currentWorkspace: workspace,
      currentSessionId: sessionId,
      taskFlow: [
        {
          id: driftReceipt.userBlockId,
          turnId: driftReceipt.turnId,
          type: "user",
          content: "same-ID replacement owner",
        },
        {
          id: 73_102,
          turnId: recoveryTurnId,
          type: "user",
          content: "/agent writer",
        },
        {
          id: 73_103,
          turnId: recoveryTurnId,
          type: "agent",
          content: recoverySummary,
          streaming: false,
          visibility: "assistant_final",
        },
      ],
      conversationTurns: [
        {
          id: driftReceipt.turnId,
          clientSubmissionId: "submission-replacement-owner",
          workspaceInstructionReceiptId: "receipt-replacement-owner",
          userPrompt: "same-ID replacement owner",
          title: "Replacement",
          mode: "edit",
          intent: "execute",
          displayIntent: "execute",
          status: "executing",
          summary: "",
          blockIds: [driftReceipt.userBlockId],
          collapsed: false,
          createdAt: driftReceipt.acceptedAt + 1,
        },
        {
          id: recoveryTurnId,
          userPrompt: "/agent writer",
          title: "Recovered local slash conclusion",
          mode: "edit",
          intent: "execute",
          displayIntent: "execute",
          status: "error",
          summary: recoverySummary,
          blockIds: [73_102, 73_103],
          collapsed: false,
          createdAt: 15,
          runtimeOutcome: {
            status: "completed",
            reason: "local_slash_presentation_recovered",
            resultKind: "error",
            runId: recoveryRunId,
            parentRunId: sourceRunId,
            updatedAt: 15,
          },
        },
      ],
      currentTurnId: driftReceipt.turnId,
      runtimeEvents: [
        {
          schemaVersion: 2,
          type: "run.started",
          threadId: sessionKey,
          turnId: driftReceipt.turnId,
          timestampMs: 13,
          runId: sourceRunId,
          parentRunId: null,
        },
        {
          schemaVersion: 2,
          type: "run.completed",
          threadId: sessionKey,
          turnId: driftReceipt.turnId,
          timestampMs: 15,
          runId: sourceRunId,
          parentRunId: null,
          resultKind: "error",
          summary: recoverySummary,
        },
        {
          schemaVersion: 2,
          type: "run.started",
          threadId: sessionKey,
          turnId: recoveryTurnId,
          timestampMs: 15,
          runId: recoveryRunId,
          parentRunId: sourceRunId,
        },
        {
          schemaVersion: 2,
          type: "run.completed",
          threadId: sessionKey,
          turnId: recoveryTurnId,
          timestampMs: 15,
          runId: recoveryRunId,
          parentRunId: sourceRunId,
          resultKind: "error",
          summary: recoverySummary,
        },
        {
          schemaVersion: 2,
          type: "turn.completed",
          threadId: sessionKey,
          turnId: recoveryTurnId,
          timestampMs: 15,
          resultKind: "error",
        },
      ],
      harnessRunMarker: null,
      workspaceTurnQueue: driftQueue,
      workspaceInstructionLedger: [],
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_writer",
      gameStudioInitialized: true,
    }),
  ));
  const restoredDrift = normalizeSessionRuntimeSnapshot(driftSnapshot, {
    restoreInterruptedGoal: true,
    workspacePath: workspace,
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: sessionEpoch,
    quarantineInterruptedLocalFast: true,
  });
  assert.equal(
    restoredDrift.workspaceTurnQueue.entries.length,
    0,
    "a canonical recovery child proves the source receipt already executed",
  );
  assert.equal(
    restoredDrift.conversationTurns.find((turn) => turn.id === driftReceipt.turnId)
      ?.runtimeOutcome,
    undefined,
    "restore must not assign the source terminal to a same-ID replacement",
  );
  assert.equal(
    restoredDrift.taskFlow.filter((block) =>
      block.turnId === recoveryTurnId &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
    ).length,
    1,
  );

  const payloadDriftQueue = buildDispatchingWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "local-fast-payload-drift",
    73_201,
    { text: "/agent writer" },
  );
  const payloadDriftReceipt = payloadDriftQueue.entries[0].receipt;
  const payloadDriftRunId = "run-local-fast-payload-drift";
  const payloadDriftSnapshot = JSON.parse(JSON.stringify(
    buildSessionRuntimeSnapshotFromStoreState({
      currentWorkspace: workspace,
      currentSessionId: sessionId,
      taskFlow: [{
        id: payloadDriftReceipt.userBlockId,
        turnId: payloadDriftReceipt.turnId,
        type: "user",
        content: "same identities, replaced payload",
      }],
      conversationTurns: [{
        id: payloadDriftReceipt.turnId,
        clientSubmissionId: payloadDriftReceipt.clientSubmissionId,
        workspaceInstructionReceiptId: payloadDriftReceipt.receiptId,
        userPrompt: "same identities, replaced payload",
        title: "Replacement payload",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "executing",
        summary: "",
        blockIds: [payloadDriftReceipt.userBlockId],
        collapsed: false,
        createdAt: payloadDriftReceipt.acceptedAt,
      }],
      currentTurnId: payloadDriftReceipt.turnId,
      runtimeEvents: [{
        schemaVersion: 2,
        type: "run.started",
        threadId: sessionKey,
        turnId: payloadDriftReceipt.turnId,
        timestampMs: 17,
        runId: payloadDriftRunId,
        parentRunId: null,
      }],
      harnessRunMarker: null,
      workspaceTurnQueue: payloadDriftQueue,
      workspaceInstructionLedger: [],
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_writer",
      gameStudioInitialized: true,
    }),
  ));
  const restoredPayloadDrift = normalizeSessionRuntimeSnapshot(payloadDriftSnapshot, {
    restoreInterruptedGoal: true,
    workspacePath: workspace,
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: sessionEpoch,
    quarantineInterruptedLocalFast: true,
  });
  const payloadReplacement = restoredPayloadDrift.conversationTurns.find(
    (turn) => turn.id === payloadDriftReceipt.turnId,
  );
  const payloadRecovery = restoredPayloadDrift.conversationTurns.find(
    (turn) => turn.id !== payloadDriftReceipt.turnId &&
      turn.id.startsWith("local-slash-recovery-") &&
      turn.runtimeOutcome?.parentRunId === payloadDriftRunId,
  );
  assert.equal(restoredPayloadDrift.workspaceTurnQueue.entries.length, 0);
  assert.equal(payloadReplacement.userPrompt, "same identities, replaced payload");
  assert.equal(payloadReplacement.runtimeOutcome, undefined);
  assert.equal(payloadRecovery?.runtimeOutcome?.resultKind, "error");
  assert.equal(
    restoredPayloadDrift.runtimeEvents.some((event) =>
      event.type === "run.completed" &&
      event.turnId === payloadDriftReceipt.turnId &&
      event.runId === payloadDriftRunId &&
      event.resultKind === "error"
    ),
    true,
    "the immutable source Run must close before the recovery child owns presentation",
  );

  const admittedModelWorkflow = restorePersistedHead({
    suffix: "model-workflow-started",
    text: "Inspect the workspace",
  });
  assert.equal(
    admittedModelWorkflow.restored.workspaceTurnQueue.entries.length,
    0,
    "non-local-fast admission keeps the existing run.started acknowledgement behavior",
  );
});

test("cold restore never adopts same-turn lookalike lifecycle evidence for another FIFO owner", () => {
  const workspace = "/tmp/session-model-workflow-lookalike";
  const sessionId = 74;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-model-workflow-lookalike";

  for (const variant of [
    { suffix: "dispatching-terminal", queueStatus: "dispatching", terminal: true },
    { suffix: "queued-start", queueStatus: "queued", terminal: false },
  ]) {
    const queue = (variant.queueStatus === "dispatching"
      ? buildDispatchingWorkspaceTurn
      : buildQueuedWorkspaceTurn)(
      sessionKey,
      sessionEpoch,
      variant.suffix,
      variant.terminal ? 74_001 : 74_101,
      { text: `inspect exact owner ${variant.suffix}` },
    );
    const entry = queue.entries[0];
    const replacementText = `unrelated replacement ${variant.suffix}`;
    const replacementRunId = `run-lookalike-${variant.suffix}`;
    const replacementFinalId = entry.receipt.userBlockId + 1;
    const replacementSummary = `Unrelated ${variant.suffix} conclusion.`;
    const runtimeEvents = [turnEvents.withEventSchema({
      type: "run.started",
      threadId: sessionKey,
      turnId: entry.receipt.turnId,
      runId: replacementRunId,
      parentRunId: null,
      timestampMs: 20,
    })];
    if (variant.terminal) {
      runtimeEvents.push(
        turnEvents.withEventSchema({
          type: "run.completed",
          threadId: sessionKey,
          turnId: entry.receipt.turnId,
          runId: replacementRunId,
          parentRunId: null,
          timestampMs: 21,
          resultKind: "success",
          summary: replacementSummary,
        }),
        turnEvents.withEventSchema({
          type: "turn.completed",
          threadId: sessionKey,
          turnId: entry.receipt.turnId,
          timestampMs: 22,
          resultKind: "success",
        }),
      );
    }

    const restored = normalizeSessionRuntimeSnapshot({
      taskFlow: [{
        id: entry.receipt.userBlockId,
        turnId: entry.receipt.turnId,
        type: "user",
        content: replacementText,
      }, ...(variant.terminal
        ? [{
            id: replacementFinalId,
            turnId: entry.receipt.turnId,
            type: "agent",
            content: replacementSummary,
            streaming: false,
            visibility: "assistant_final",
          }]
        : [])],
      conversationTurns: [{
        id: entry.receipt.turnId,
        clientSubmissionId: `replacement-submission-${variant.suffix}`,
        workspaceInstructionReceiptId: `replacement-receipt-${variant.suffix}`,
        workspaceInstructionSource: "replay",
        userPrompt: replacementText,
        title: replacementText,
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: variant.terminal ? "done" : "executing",
        summary: variant.terminal ? replacementSummary : "",
        blockIds: [
          entry.receipt.userBlockId,
          ...(variant.terminal ? [replacementFinalId] : []),
        ],
        collapsed: false,
        createdAt: entry.receipt.acceptedAt + 1,
        ...(variant.terminal
          ? {
              runtimeOutcome: {
                status: "completed",
                reason: "unrelated_owner_completed",
                resultKind: "success",
                runId: replacementRunId,
                parentRunId: null,
                updatedAt: 22,
              },
            }
          : {}),
      }],
      currentTurnId: entry.receipt.turnId,
      runtimeEvents,
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
    }, {
      workspacePath: workspace,
      expectedSessionKey: sessionKey,
      expectedSessionEpoch: sessionEpoch,
    });

    const replacement = restored.conversationTurns.find(
      (turn) => turn.id === entry.receipt.turnId,
    );
    const recoveryTurns = restored.conversationTurns.filter((turn) =>
      turn.id.startsWith(`workspace-recovery-${entry.receipt.receiptId}`)
    );
    assert.equal(
      restored.workspaceTurnQueue.entries.length,
      0,
      `${variant.suffix}: the poisoned receipt may retire only through visible recovery`,
    );
    assert.equal(replacement.clientSubmissionId, `replacement-submission-${variant.suffix}`);
    assert.equal(replacement.workspaceInstructionReceiptId, `replacement-receipt-${variant.suffix}`);
    assert.equal(replacement.userPrompt, replacementText);
    if (variant.terminal) {
      assert.equal(replacement.runtimeOutcome?.runId, replacementRunId);
      assert.equal(replacement.runtimeOutcome?.resultKind, "success");
    } else {
      assert.equal(replacement.runtimeOutcome, undefined);
    }
    assert.equal(recoveryTurns.length, 1, `${variant.suffix}: recovery must be visible`);

    const recovery = recoveryTurns[0];
    const recoveryEvents = restored.runtimeEvents.filter((event) =>
      "turnId" in event && event.turnId === recovery.id
    );
    assert.deepEqual(
      recoveryEvents.map((event) => event.type),
      ["run.started", "run.completed", "turn.completed"],
      `${variant.suffix}: recovery lifecycle must be canonical`,
    );
    assert.equal(recovery.runtimeOutcome?.status, "completed");
    assert.equal(recovery.runtimeOutcome?.resultKind, "error");
    assert.equal(recovery.runtimeOutcome?.parentRunId, null);
    assert.equal(recoveryEvents[0].runId, recovery.runtimeOutcome?.runId);
    assert.equal(recoveryEvents[1].runId, recovery.runtimeOutcome?.runId);
    assert.equal(recoveryEvents[1].parentRunId, recovery.runtimeOutcome?.parentRunId);
    assert.equal(recoveryEvents[1].resultKind, recovery.runtimeOutcome?.resultKind);
    assert.equal(recoveryEvents[1].summary, recovery.summary);
    assert.equal(recoveryEvents[2].resultKind, recovery.runtimeOutcome?.resultKind);
    const recoveryFinals = restored.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === recovery.id &&
      block.visibility === "assistant_final"
    );
    assert.equal(recoveryFinals.length, 1);
    assert.equal(recoveryFinals[0].streaming, false);
    assert.equal(recoveryFinals[0].content, recovery.summary);
  }
});

test("cold restore rejects an exact-looking owner when its Turn omits the receipt user block", () => {
  const workspace = "/tmp/session-model-workflow-missing-user-block-owner";
  const sessionId = 741;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-model-workflow-missing-user-block-owner";
  const queue = buildDispatchingWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "model-workflow-missing-user-block-owner",
    74_201,
    { text: "Inspect the exact workspace owner" },
  );
  const entry = queue.entries[0];
  const sourceRunId = "run-model-workflow-missing-user-block-owner";
  const projection = buildExactWorkspaceInstructionProjection(entry);
  const restored = normalizeSessionRuntimeSnapshot({
    ...projection,
    conversationTurns: projection.conversationTurns.map((turn) => ({
      ...turn,
      blockIds: [],
    })),
    currentTurnId: entry.receipt.turnId,
    runtimeEvents: [turnEvents.withEventSchema({
      type: "run.started",
      threadId: sessionKey,
      turnId: entry.receipt.turnId,
      runId: sourceRunId,
      parentRunId: null,
      timestampMs: 20,
    })],
    workspaceTurnQueue: queue,
    workspaceInstructionLedger: [],
  }, {
    workspacePath: workspace,
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: sessionEpoch,
  });

  const sourceTurn = restored.conversationTurns.find(
    (turn) => turn.id === entry.receipt.turnId,
  );
  const sourceUserBlock = restored.taskFlow.find(
    (block) => block.id === entry.receipt.userBlockId,
  );
  const sourceEvents = restored.runtimeEvents.filter((event) =>
    "turnId" in event && event.turnId === entry.receipt.turnId
  );
  const recoveryTurns = restored.conversationTurns.filter((turn) =>
    turn.id.startsWith(`workspace-recovery-${entry.receipt.receiptId}`)
  );

  assert.equal(restored.workspaceTurnQueue.entries.length, 0);
  assert.equal(sourceTurn.clientSubmissionId, entry.instruction.clientSubmissionId);
  assert.equal(sourceTurn.workspaceInstructionReceiptId, entry.receipt.receiptId);
  assert.equal(sourceTurn.workspaceInstructionSource, entry.instruction.source);
  assert.equal(sourceTurn.userPrompt, entry.instruction.payload.text);
  assert.deepEqual(
    sourceTurn.blockIds,
    [],
    "restore must not silently attach the receipt block to an unrelated source Turn",
  );
  assert.equal(sourceTurn.runtimeOutcome, undefined);
  assert.deepEqual(sourceUserBlock, projection.taskFlow[0]);
  assert.deepEqual(
    sourceEvents.map((event) => event.type),
    ["run.started"],
    "fail-closed recovery must not append terminal events to the noncanonical source",
  );
  assert.equal(recoveryTurns.length, 1);
  const recovery = recoveryTurns[0];
  const recoveryEvents = restored.runtimeEvents.filter((event) =>
    "turnId" in event && event.turnId === recovery.id
  );
  assert.deepEqual(recoveryEvents.map((event) => event.type), [
    "run.started",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(recovery.runtimeOutcome?.status, "completed");
  assert.equal(recovery.runtimeOutcome?.resultKind, "error");
  assert.equal(recoveryEvents[1]?.resultKind, "error");
  assert.equal(recoveryEvents[2]?.resultKind, "error");
});

test("cold restore reserves later queued receipt block IDs while fail-closing the FIFO head", () => {
  const workspace = "/tmp/session-model-workflow-reserved-receipt-blocks";
  const sessionId = 742;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-model-workflow-reserved-receipt-blocks";

  for (const [index, variant] of [
    { suffix: "source-final", projectionConflict: false },
    { suffix: "recovery-final", projectionConflict: true },
  ].entries()) {
    const firstUserBlockId = 74_301 + (index * 100);
    let queue = buildDispatchingWorkspaceTurn(
      sessionKey,
      sessionEpoch,
      `reserved-${variant.suffix}`,
      firstUserBlockId,
      { text: `Inspect reserved IDs for ${variant.suffix}` },
    );
    queue = appendQueuedWorkspaceTurn(
      queue,
      `reserved-${variant.suffix}-next`,
      firstUserBlockId + 1,
      { text: `Continue after ${variant.suffix}` },
    );
    const [firstEntry, nextEntry] = queue.entries;
    const exactProjection = buildExactWorkspaceInstructionProjection(firstEntry);
    const unrelatedTurnId = `turn-unrelated-${variant.suffix}`;
    const taskFlow = variant.projectionConflict
      ? [{
          id: firstEntry.receipt.userBlockId,
          turnId: unrelatedTurnId,
          type: "user",
          content: `Unrelated history for ${variant.suffix}`,
        }]
      : exactProjection.taskFlow;
    const conversationTurns = variant.projectionConflict
      ? [{
          id: unrelatedTurnId,
          userPrompt: `Unrelated history for ${variant.suffix}`,
          title: "Unrelated history",
          mode: "edit",
          intent: "execute",
          displayIntent: "execute",
          status: "done",
          summary: "Unrelated history remains unchanged.",
          blockIds: [firstEntry.receipt.userBlockId],
          collapsed: false,
          createdAt: firstEntry.receipt.acceptedAt - 1,
        }]
      : exactProjection.conversationTurns;
    const runtimeEvents = variant.projectionConflict
      ? []
      : [turnEvents.withEventSchema({
          type: "run.started",
          threadId: sessionKey,
          turnId: firstEntry.receipt.turnId,
          runId: `run-${variant.suffix}`,
          parentRunId: null,
          timestampMs: 20,
        })];

    const restored = normalizeSessionRuntimeSnapshot({
      taskFlow,
      conversationTurns,
      currentTurnId: firstEntry.receipt.turnId,
      runtimeEvents,
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
    }, {
      workspacePath: workspace,
      expectedSessionKey: sessionKey,
      expectedSessionEpoch: sessionEpoch,
    });

    assert.deepEqual(
      restored.workspaceTurnQueue.entries.map((entry) => entry.receipt.receiptId),
      [nextEntry.receipt.receiptId],
      `${variant.suffix}: only the fail-closed head may retire`,
    );
    const nextTurn = restored.conversationTurns.find(
      (turn) => turn.id === nextEntry.receipt.turnId,
    );
    const nextUserBlocks = restored.taskFlow.filter(
      (block) => block.id === nextEntry.receipt.userBlockId,
    );
    assert.equal(nextTurn?.workspaceInstructionReceiptId, nextEntry.receipt.receiptId);
    assert.equal(nextTurn?.userPrompt, nextEntry.instruction.payload.text);
    assert.deepEqual(nextTurn?.blockIds, [nextEntry.receipt.userBlockId]);
    assert.equal(nextUserBlocks.length, 1);
    assert.equal(nextUserBlocks[0].turnId, nextEntry.receipt.turnId);
    assert.equal(nextUserBlocks[0].type, "user");

    const conclusionTurn = variant.projectionConflict
      ? restored.conversationTurns.find((turn) =>
          turn.id.startsWith(`workspace-recovery-${firstEntry.receipt.receiptId}`)
        )
      : restored.conversationTurns.find((turn) => turn.id === firstEntry.receipt.turnId);
    const conclusionFinals = restored.taskFlow.filter((block) =>
      block.turnId === conclusionTurn?.id &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
    );
    assert.equal(conclusionTurn?.runtimeOutcome?.resultKind, "error");
    assert.equal(conclusionFinals.length, 1);
    assert.notEqual(
      conclusionFinals[0].id,
      nextEntry.receipt.userBlockId,
      `${variant.suffix}: generated conclusion must not consume the next receipt block ID`,
    );
  }
});

test("cold restore completes an exact run-only FIFO projection without rewriting its result", () => {
  const workspace = "/tmp/session-model-workflow-run-only";
  const sessionId = 75;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-model-workflow-run-only";
  const queue = buildDispatchingWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "model-workflow-run-only",
    75_001,
    { text: "Verify the durable partial result" },
  );
  const entry = queue.entries[0];
  const runId = "run-model-workflow-partial";
  const summary = "The durable mutation is complete; an optional check remains.";
  const projection = buildExactWorkspaceInstructionProjection(entry, {
    status: "done",
    summary,
    runtimeOutcome: {
      status: "completed",
      reason: "durable_partial_result",
      resultKind: "partial",
      runId,
      parentRunId: null,
      updatedAt: 31,
    },
  });
  const restored = normalizeSessionRuntimeSnapshot({
    ...projection,
    currentTurnId: entry.receipt.turnId,
    runtimeEvents: [
      turnEvents.withEventSchema({
        type: "run.started",
        threadId: sessionKey,
        turnId: entry.receipt.turnId,
        runId,
        parentRunId: null,
        timestampMs: 30,
      }),
      turnEvents.withEventSchema({
        type: "run.completed",
        threadId: sessionKey,
        turnId: entry.receipt.turnId,
        runId,
        parentRunId: null,
        timestampMs: 31,
        resultKind: "partial",
        summary,
      }),
    ],
    workspaceTurnQueue: queue,
    workspaceInstructionLedger: [],
  }, {
    workspacePath: workspace,
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: sessionEpoch,
  });

  const restoredTurn = restored.conversationTurns.find(
    (turn) => turn.id === entry.receipt.turnId,
  );
  const ownedEvents = restored.runtimeEvents.filter((event) =>
    "turnId" in event && event.turnId === entry.receipt.turnId
  );
  const finals = restored.taskFlow.filter((block) =>
    block.type === "agent" &&
    block.turnId === entry.receipt.turnId &&
    block.visibility === "assistant_final"
  );
  assert.equal(restored.workspaceTurnQueue.entries.length, 0);
  assert.deepEqual(
    ownedEvents.map((event) => event.type),
    ["run.started", "run.completed", "turn.completed"],
  );
  assert.equal(ownedEvents[1].runId, runId);
  assert.equal(ownedEvents[1].resultKind, "partial");
  assert.equal(ownedEvents[1].summary, summary);
  assert.equal(ownedEvents[2].resultKind, "partial");
  assert.equal(restoredTurn.runtimeOutcome?.runId, runId);
  assert.equal(restoredTurn.runtimeOutcome?.parentRunId, null);
  assert.equal(restoredTurn.runtimeOutcome?.resultKind, "partial");
  assert.equal(restoredTurn.summary, summary);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].streaming, false);
  assert.equal(finals[0].content, summary);
});

test("queued Goal continuation guidance survives session normalization only with authorization", () => {
  const authorization = {
    kind: "goal_continuation_authorization",
    source: "goal_manual_resume",
    workspaceKey: "/repo",
    sessionKey: "/repo:7",
    goalId: "goal-1",
    goalRevision: 2,
    ownerTurnId: "turn-goal",
  };
  const restored = normalizeSessionRuntimeSnapshot({
    queuedUserMessage: {
      id: "queued-goal-guidance",
      sessionKey: "/repo:7",
      text: "queue display text",
      status: "queued",
      createdAt: 100,
      goalContinuationAuthorization: authorization,
      goalContinuationGuidance: "exact continuation guidance",
    },
  });
  assert.equal(
    restored.queuedUserMessage.goalContinuationGuidance,
    "exact continuation guidance",
  );

  const untrusted = normalizeSessionRuntimeSnapshot({
    queuedUserMessage: {
      id: "queued-untrusted-guidance",
      sessionKey: "/repo:7",
      text: "queue display text",
      status: "queued",
      createdAt: 100,
      goalContinuationGuidance: "must not survive alone",
    },
  });
  assert.equal(untrusted.queuedUserMessage.goalContinuationGuidance, undefined);
});

function planArtifact(content, overrides = {}) {
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    revision: 4,
    updatedAt: 100,
    ...overrides,
  };
}

function tasksArtifact(content, overrides = {}) {
  return {
    kind: "tasks",
    path: ".MAIN/plans/tasks.md",
    title: "Tasks",
    content,
    revision: 4,
    updatedAt: 101,
    ...overrides,
  };
}

function approvedTaskArtifact() {
  return tasksArtifact([
    "# Tasks",
    "",
    "- [ ] 修改 src/main.js 中的 handleOpenFile()，统一文件打开入口 — 证据: file:src/main.js",
    "- [ ] 修改 src/main.js 中的 closeTab()，保留正确的活动标签 — 证据: file:src/main.js",
    "- [ ] 运行恢复链路测试 — 证据: cmd:node --test tests/node/session-runtime-restore.test.mjs",
    "",
  ].join("\n"));
}

function sealedPlanCandidateForRestore(content) {
  return {
    schemaVersion: 4,
    state: "sealed",
    contractId: "restore-contract:bundle-1",
    authoringContractId: "restore-contract",
    bundleHash: "bundle-1",
    objective: "Restore exact-owner Plan checkpoint evidence safely.",
    goals: [{ id: "G1", index: 1, text: "Preserve only exact-owner checkpoint evidence." }],
    diagnosisRequired: false,
    evidence: [],
    summary: ["Keep checkpoint history separate from execution authority."],
    diagnoses: [],
    findings: [],
    changes: [{
      id: "C1",
      text: "Modify src/main.js under the reviewed Plan.",
      targetRef: "src/main.js",
      evidenceRefs: [],
      diagnosisRefs: [],
      goalRefs: ["G1"],
      operation: "modify",
      expectedOutcome: "The reviewed mutation is applied.",
      relationships: [],
      executionEvidence: [],
    }],
    decisions: [],
    interfaces: [],
    tests: ["Run the restore regression."],
    validations: [{
      id: "V1",
      goalRefs: ["G1"],
      changeRefs: ["C1"],
      primitive: {
        kind: "finite_command",
        acceptance: "required",
        command: "node --test tests/node/session-runtime-restore.test.mjs",
        capability: "test",
        segments: [{
          command: "node --test tests/node/session-runtime-restore.test.mjs",
          connector: "start",
          role: "validator",
          capability: "test",
        }],
      },
      expectedOutcome: "The restore regression exits successfully.",
      blocking: true,
    }],
    assumptions: [],
    blockingChoices: [],
    projection: {
      format: "markdown",
      content,
      contentHash: hashPlanProjection(content),
    },
  };
}

function planConversationTurn(overrides = {}) {
  return {
    id: "turn-plan",
    userPrompt: "执行已批准的恢复计划",
    title: "恢复计划",
    mode: "plan",
    intent: "plan",
    displayIntent: "execute",
    status: "executing",
    summary: "",
    blockIds: [],
    collapsed: false,
    createdAt: 100,
    ...overrides,
  };
}

function planHarnessMarker(overrides = {}) {
  return {
    schemaVersion: 1,
    instanceId: "test-instance",
    sessionKey: "plan-session",
    workspace: "/repo",
    sessionId: 1,
    turnId: "turn-plan",
    runId: "run-outer",
    activeRunId: "run-child",
    activeParentRunId: "run-outer",
    status: "running",
    workflowMode: "plan",
    runtimeIntent: "execute",
    planStage: "executing",
    isPlanApproved: true,
    iteration: 2,
    maxIterations: 50,
    messagesLen: 2,
    toolCount: 1,
    latestTool: "read_file",
    latestToolTarget: "src/main.js",
    activeStreamId: null,
    streamStatus: null,
    streamChunkCount: 0,
    streamByteCount: 0,
    streamElapsedMs: null,
    streamLifecycleStatus: null,
    lastStreamError: null,
    startedAt: 100,
    updatedAt: 200,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

function buildUnsupportedPlanContent() {
  return [
    "# MD Viewer 文件打开修复计划",
    "",
    "## 用户目标",
    "- 修复双击 Markdown 文件后窗口空白和工具栏打开按钮无效的问题。",
    "",
    "## 摘要",
    "- 已读取 `src-tauri/src/main.rs` 和 `src/main.js`，准备连接文件打开链路。",
    "",
    "## 关键改动",
    "- `src/main.js` 可能需要新增 `open-file` 事件监听器。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持现有事件名称不变。",
    "",
    "## 执行步骤",
    "1. 先确认前端监听器，再决定修改方案。",
    "",
    "## 验证标准",
    "- 双击文件和点击打开按钮均可加载内容。",
    "",
    "## 测试方案",
    "- 运行 cargo check 并手动验证。",
    "",
    "## 假设与默认值",
    "- 默认前端尚未注册监听器。",
    "",
  ].join("\n");
}

test("restore invalidates approval when sanitization removes one reviewable artifact from a multi-artifact identity", () => {
  const plan = planArtifact(buildApprovedPlanContent());
  const invalidDesign = {
    kind: "design",
    path: ".MAIN/plans/design.md",
    title: "Design",
    content: "# Design\n\nTBD",
    revision: 4,
    updatedAt: 101,
  };
  assert.equal(validatePlanArtifactContent(plan.content, "plan").ok, true);
  assert.equal(validatePlanArtifactContent(invalidDesign.content, "design").ok, false);

  const restored = normalizeSessionRuntimeSnapshot({
    planArtifacts: [plan, invalidDesign],
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
    planExecutionEvidenceLedger: [{ id: "legacy-evidence" }],
    planExecutionEvidenceCount: 1,
  });

  assert.equal(restored.isPlanApproved, false);
  assert.deepEqual(restored.planArtifacts.map((artifact) => artifact.path), [".MAIN/plans/plan.md"]);
  assert.equal(restored.planApprovalChoice, "");
  assert.deepEqual(restored.planExecutionEvidenceLedger, []);
  assert.equal(restored.planExecutionEvidenceCount, 0);
});

test("restore keeps an invalid approved Plan as audit history while revoking execution", () => {
  const invalidPlan = planArtifact(buildUnsupportedPlanContent(), { revision: 2 });
  const restored = normalizeSessionRuntimeSnapshot({
    planArtifacts: [invalidPlan],
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  });

  assert.equal(restored.isPlanApproved, false);
  assert.equal(restored.planStage, "plan");
  assert.equal(restored.planArtifacts.length, 1);
  assert.equal(restored.planArtifacts[0].content, invalidPlan.content.trim());
  assert.equal(restored.planApprovalChoice, "");
});

test("restore preserves currentTaskId and migrates legacy task text only when the approved graph is unique", () => {
  const plan = planArtifact(buildApprovedPlanContent());
  const tasks = approvedTaskArtifact();
  assert.equal(validatePlanArtifactContent(tasks.content, "tasks").ok, true);
  const planTasks = extractPlanTasks(tasks.content);
  const progress = {
    turnId: "turn-plan",
    phase: "running",
    currentTask: planTasks[0].text,
    currentTool: "read_file · src/main.js",
    latestEvidence: "read src/main.js",
    nextStep: "apply the reviewed mutation",
    iteration: 2,
    maxIterations: 50,
    autoResumeCount: 0,
    updatedAt: 100,
  };
  const migrated = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionProgressSnapshot: {
      ...progress,
      currentTaskId: planTasks[0].id,
      currentTask: "stale display text must not replace the stable id",
    },
    planLifecycle: exactExecutingPlanLifecycle([plan, tasks]),
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  }, exactPlanRestoreOptions);
  assert.equal(migrated.isPlanApproved, false);
  assert.equal(migrated.planLifecycle.status, "paused");
  assert.equal(migrated.planLifecycle.executionLease, null);
  assert.equal(migrated.planExecutionProgressSnapshot.currentTaskId, planTasks[0].id);
  assert.equal(migrated.planExecutionProgressSnapshot.phase, "paused");
  assert.equal(migrated.planTasks.length, 3);
  assert.equal(migrated.planTasks[0].text, planTasks[0].text);

  const legacy = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionProgressSnapshot: progress,
    planLifecycle: exactExecutingPlanLifecycle([plan, tasks]),
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  }, exactPlanRestoreOptions);
  assert.equal(legacy.isPlanApproved, false);
  assert.equal(legacy.planExecutionProgressSnapshot.currentTaskId, planTasks[0].id);

  const ambiguous = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionProgressSnapshot: { ...progress, currentTask: "读取 src/main.js" },
    planLifecycle: exactExecutingPlanLifecycle([plan, tasks]),
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  }, exactPlanRestoreOptions);
  assert.equal(ambiguous.isPlanApproved, false);
  assert.equal(ambiguous.planStage, "plan");
  assert.equal(ambiguous.planExecutionProgressSnapshot, null);
});

test("restore preserves a legacy execution checkpoint identity while revoking its active lease", () => {
  const plan = planArtifact(buildApprovedPlanContent());
  const tasks = approvedTaskArtifact();
  const legacyArtifactIdentity = buildPlanApprovalIdentity([plan, tasks]);
  assert.equal(plan.candidate, undefined);
  const planTasks = extractPlanTasks(tasks.content);
  const baseProgress = {
    turnId: "turn-plan",
    runId: "run-child",
    parentRunId: "run-outer",
    phase: "running",
    currentTaskId: planTasks[0].id,
    currentTask: planTasks[0].text,
    currentTool: "read_file · src/main.js",
    latestEvidence: "read src/main.js",
    nextStep: "apply the reviewed mutation",
    iteration: 2,
    maxIterations: 50,
    autoResumeCount: 0,
    updatedAt: 100,
  };

  const valid = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionProgressSnapshot: baseProgress,
    harnessRunMarker: planHarnessMarker(),
    planLifecycle: exactExecutingPlanLifecycle([plan, tasks]),
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  }, exactPlanRestoreOptions);
  assert.equal(valid.isPlanApproved, false);
  assert.equal(valid.planLifecycle.status, "paused");
  assert.equal(valid.planLifecycle.executionLease, null);
  assert.equal(
    valid.planLifecycle.artifactIdentity?.artifactHash,
    legacyArtifactIdentity.artifactHash,
  );
  assert.equal(valid.planExecutionProgressSnapshot.currentTaskId, planTasks[0].id);
  assert.equal(valid.activeActionRequest, null);
  assert.equal(valid.harnessRunMarker.status, "paused");
  assert.equal(valid.runtimeEvents.at(-1).type, "run.paused");

  for (const mismatch of ["turn", "run"]) {
    const restored = normalizeSessionRuntimeSnapshot({
      currentTurnId: "turn-plan",
      conversationTurns: [planConversationTurn()],
      planArtifacts: [plan, tasks],
      planTasks,
      planExecutionProgressSnapshot: {
        ...baseProgress,
        ...(mismatch === "turn" ? { turnId: "turn-stale" } : { runId: "run-stale" }),
      },
      harnessRunMarker: planHarnessMarker(),
      planLifecycle: exactExecutingPlanLifecycle([plan, tasks]),
      isPlanApproved: true,
      planStage: "executing",
      planApprovalChoice: "approve",
    }, exactPlanRestoreOptions);

    assert.equal(restored.isPlanApproved, false, mismatch);
    assert.equal(restored.planStage, "plan", mismatch);
    assert.equal(restored.planExecutionProgressSnapshot, null, mismatch);
    assert.equal(restored.harnessRunMarker.status, "paused", mismatch);
    assert.equal(restored.runtimeEvents.at(-1).type, "run.paused", mismatch);
    assert.equal(restored.conversationTurns[0].status, "paused", mismatch);
    assert.equal(restored.planArtifacts.some((artifact) => artifact.kind === "plan"), true, mismatch);
  }
});

test("restore retains checkpoint evidence only for the exact Session container epoch", () => {
  const plan = planArtifact(buildApprovedPlanContent());
  const tasks = approvedTaskArtifact();
  const planTasks = extractPlanTasks(tasks.content);
  const evidence = [{
    id: "evidence-exact-owner",
    turnId: "turn-plan",
    runId: "run-child",
    kind: "file",
    target: "src/main.js",
    value: "verified exact owner checkpoint",
    createdAt: 90,
  }];
  const snapshot = {
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionEvidenceLedger: evidence,
    planExecutionEvidenceCount: 1,
    planExecutionProgressSnapshot: {
      turnId: "turn-plan",
      runId: "run-child",
      parentRunId: "run-outer",
      phase: "running",
      currentTaskId: planTasks[0].id,
      currentTask: planTasks[0].text,
      latestEvidence: evidence[0].value,
      iteration: 2,
      maxIterations: 50,
      autoResumeCount: 0,
      updatedAt: 100,
    },
    harnessRunMarker: planHarnessMarker(),
    planLifecycle: exactExecutingPlanLifecycle([plan, tasks]),
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  };

  const exact = normalizeSessionRuntimeSnapshot(snapshot, exactPlanRestoreOptions);
  assert.equal(exact.isPlanApproved, false);
  assert.equal(exact.planLifecycle.status, "paused");
  assert.equal(exact.planLifecycle.executionLease, null);
  assert.deepEqual(exact.planExecutionEvidenceLedger, evidence);
  assert.equal(exact.planExecutionEvidenceCount, 1);
  assert.equal(exact.planExecutionProgressSnapshot.phase, "paused");

  const crossEpoch = normalizeSessionRuntimeSnapshot(snapshot, {
    expectedSessionKey: exactPlanSessionKey,
    expectedSessionEpoch: "plan-session-epoch-recreated",
  });
  assert.equal(crossEpoch.isPlanApproved, false);
  assert.equal(crossEpoch.planLifecycle.sessionKey, exactPlanSessionKey);
  assert.equal(crossEpoch.planLifecycle.sessionEpoch, "plan-session-epoch-recreated");
  assert.equal(crossEpoch.planLifecycle.approvalLease, null);
  assert.equal(crossEpoch.planLifecycle.executionLease, null);
  assert.deepEqual(crossEpoch.planExecutionEvidenceLedger, []);
  assert.equal(crossEpoch.planExecutionEvidenceCount, 0);
  assert.equal(crossEpoch.planExecutionProgressSnapshot, null);

  const crossSession = normalizeSessionRuntimeSnapshot(snapshot, {
    expectedSessionKey: "other-plan-session",
    expectedSessionEpoch: "other-plan-epoch",
  });
  assert.equal(crossSession.planLifecycle.sessionKey, "other-plan-session");
  assert.equal(crossSession.planLifecycle.sessionEpoch, "other-plan-epoch");
  assert.equal(crossSession.planLifecycle.approvalLease, null);
  assert.deepEqual(crossSession.planExecutionEvidenceLedger, []);
});

test("restore fail-closes exact-owner checkpoint evidence when a typed Plan candidate drifts", () => {
  const content = buildApprovedPlanContent();
  const validCandidate = sealedPlanCandidateForRestore(content);
  const driftedContent = `${content}\n\nUnreviewed projection drift.`;
  const driftedCandidate = {
    ...validCandidate,
    projection: {
      ...validCandidate.projection,
      content: driftedContent,
      contentHash: hashPlanProjection(driftedContent),
    },
  };
  const plan = planArtifact(content, {
    candidate: driftedCandidate,
    candidateHash: hashPlanCandidate(driftedCandidate),
    authoringContractId: driftedCandidate.authoringContractId,
  });
  const tasks = approvedTaskArtifact();
  const planTasks = extractPlanTasks(tasks.content);
  const evidence = [{
    id: "evidence-drifted-candidate",
    turnId: "turn-plan",
    runId: "run-child",
    kind: "file",
    target: "src/main.js",
    value: "must not survive candidate drift",
    createdAt: 90,
  }];

  const restored = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionEvidenceLedger: evidence,
    planExecutionEvidenceCount: evidence.length,
    planExecutionProgressSnapshot: {
      turnId: "turn-plan",
      runId: "run-child",
      parentRunId: "run-outer",
      phase: "running",
      currentTaskId: planTasks[0].id,
      currentTask: planTasks[0].text,
      iteration: 2,
      maxIterations: 50,
      autoResumeCount: 0,
      updatedAt: 100,
    },
    harnessRunMarker: planHarnessMarker(),
    planLifecycle: exactExecutingPlanLifecycle([plan, tasks]),
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  }, exactPlanRestoreOptions);

  assert.equal(restored.isPlanApproved, false);
  assert.equal(restored.planStage, "plan");
  assert.equal(restored.planExecutionProgressSnapshot, null);
  assert.deepEqual(restored.planExecutionEvidenceLedger, []);
  assert.equal(restored.planExecutionEvidenceCount, 0);
});

test("restore rewrites the exact owner pause boundary when an internal Plan choice request is cleared", () => {
  const sessionKey = "md-viewer-session";
  const turnId = "turn-plan-draft";
  const runId = "run-plan-draft";
  const optionValues = [
    "我需要先查看 main.js 中是否有 open-file 事件监听器，再决定方案",
    "先修复 main.rs 中的 handle_open_url，再处理前端部分",
    "我需要了解 Tauri 2 dialog 插件的正确导入方式后再执行",
  ];
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId,
    title: "选择下一步",
    optionValues,
    allowCustomReply: true,
    now: 200,
  });
  const choiceRequest = actionRequests.toUserChoiceResolutionIdentity(request);
  const blockContent = [
    "# 问题根因确认（8 条要点）",
    "",
    "已读取后端 URL 回调、前端事件监听和工具栏异步文件选择链路。",
  ].join("\n");

  const restored = normalizeSessionRuntimeSnapshot({
    planArtifacts: [planArtifact(buildUnsupportedPlanContent(), { revision: 1 })],
    isPlanApproved: false,
    planStage: "plan",
    activeActionRequest: request,
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId,
      status: "paused",
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "plan",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 200,
      closedAt: 200,
      closeReason: "awaiting_user_choice",
    },
    taskFlow: [{
      id: 101,
      type: "agent",
      turnId,
      content: blockContent,
      options: optionValues.map((value) => ({ label: value, value })),
      choiceRequest,
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "使用 Plan 模式分析并修复 MD Viewer 文件打开问题",
      title: "修复 MD Viewer",
      mode: "plan",
      intent: "plan",
      displayIntent: "plan",
      status: "awaiting_input",
      summary: "等待选择下一步",
      blockIds: [101],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [
      {
        schemaVersion: 2,
        type: "run.started",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        timestampMs: 100,
      },
      {
        schemaVersion: 2,
        type: "approval.requested",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        requestId: request.requestId,
        actionKind: "user_choice",
        title: request.title,
        reason: "awaiting_user_choice",
        timestampMs: 190,
      },
      {
        schemaVersion: 2,
        type: "run.paused",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        reason: "awaiting_user_choice",
        message: "Waiting for a user choice.",
        timestampMs: 200,
      },
    ],
  });

  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.harnessRunMarker.closeReason, "invalid_plan_user_choice_cleared");
  assert.equal(restored.conversationTurns[0].status, "paused");
  assert.equal(restored.taskFlow[0].choiceRequest, undefined);
  assert.deepEqual(restored.taskFlow[0].options, []);

  const ownedRunEvents = restored.runtimeEvents.filter((event) =>
    event.threadId === sessionKey &&
    event.turnId === turnId &&
    event.runId === runId
  );
  assert.deepEqual(ownedRunEvents.map((event) => event.type), ["run.started", "run.paused"]);
  const pause = ownedRunEvents.find((event) => event.type === "run.paused");
  assert.equal(pause.reason, "invalid_plan_user_choice_cleared");
  assert.match(pause.message, /Plan|计划/i);
});

test("restore removes a genuine but stale choice whose run owner no longer matches", () => {
  const sessionKey = "md-viewer-session";
  const turnId = "turn-startup-choice";
  const optionValues = [
    "启动时默认显示空白页，由用户手动选择文件",
    "启动时自动恢复上次打开的 Markdown 文件",
  ];
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId: "run-old",
    title: "选择启动体验",
    optionValues,
    allowCustomReply: false,
    now: 300,
  });
  const restored = normalizeSessionRuntimeSnapshot({
    activeActionRequest: request,
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId: "run-outer",
      activeRunId: "run-new",
      status: "paused",
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "plan",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 300,
      closedAt: 300,
      closeReason: "awaiting_user_choice",
    },
    taskFlow: [{
      id: 301,
      type: "agent",
      turnId,
      content: "请选择启动时的默认用户体验：显示空白页，还是恢复上次文件？",
      options: optionValues.map((value) => ({ label: value, value })),
      choiceRequest: actionRequests.toUserChoiceResolutionIdentity(request),
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "规划 MD Viewer 的默认启动体验",
      title: "默认启动体验",
      mode: "plan",
      intent: "plan",
      displayIntent: "plan",
      status: "awaiting_input",
      summary: "等待选择",
      blockIds: [301],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [{
      schemaVersion: 2,
      type: "run.paused",
      threadId: sessionKey,
      turnId,
      runId: "run-old",
      parentRunId: null,
      reason: "awaiting_user_choice",
      message: "Waiting",
      timestampMs: 300,
    }],
  });

  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.conversationTurns[0].status, "paused");
  assert.deepEqual(restored.taskFlow[0].options, []);
  assert.equal(restored.taskFlow[0].choiceRequest, undefined);
  const staleOwnerPause = restored.runtimeEvents.find((event) =>
    event.type === "run.paused" && event.runId === "run-old"
  );
  const projectedRunPause = restored.runtimeEvents.find((event) =>
    event.type === "run.paused" && event.runId === "run-new"
  );
  assert.equal(staleOwnerPause?.reason, "stale_user_choice_cleared");
  assert.equal(projectedRunPause?.reason, "restored_inconsistent_checkpoint");
  assert.equal(restored.harnessRunMarker.closeReason, "awaiting_user_choice");
});

test("turn.completed without a marker restores a missing final only for loaded terminal Turns", () => {
  const sessionKey = "event-owned-missing-final-session";
  const turnId = "turn-event-owned-missing-final";
  const unrelatedTurnId = "turn-without-completion";
  const unloadedTurnId = "turn-not-loaded";
  const restored = normalizeSessionRuntimeSnapshot({
    taskFlow: [],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "Recover the durable conclusion",
        title: "Missing final",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "paused",
        summary: "Waiting for projection",
        blockIds: [],
        collapsed: false,
        createdAt: 100,
      },
      {
        id: unrelatedTurnId,
        userPrompt: "Leave this Turn alone",
        title: "Unrelated Turn",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "paused",
        summary: "Still paused",
        blockIds: [],
        collapsed: false,
        createdAt: 200,
      },
    ],
    runtimeEvents: [
      turnEvents.withEventSchema({
        type: "run.completed",
        threadId: sessionKey,
        turnId,
        runId: "run-event-owned-older",
        parentRunId: null,
        timestampMs: 400,
        resultKind: "success",
        summary: "Superseded run summary.",
      }),
      turnEvents.withEventSchema({
        type: "run.completed",
        threadId: sessionKey,
        turnId,
        runId: "run-event-owned",
        parentRunId: "run-parent",
        timestampMs: 500,
        resultKind: "partial",
        summary: "The verified work is durable; one advisory remains.",
      }),
      turnEvents.withEventSchema({
        type: "turn.completed",
        threadId: sessionKey,
        turnId,
        timestampMs: 510,
        resultKind: "partial",
      }),
      turnEvents.withEventSchema({
        type: "turn.completed",
        threadId: sessionKey,
        turnId: unloadedTurnId,
        timestampMs: 520,
        resultKind: "success",
      }),
    ],
  });

  const terminalTurn = restored.conversationTurns.find((turn) => turn.id === turnId);
  const unrelatedTurn = restored.conversationTurns.find((turn) => turn.id === unrelatedTurnId);
  const finals = restored.taskFlow.filter((block) =>
    block.type === "agent" && block.visibility === "assistant_final"
  );
  assert.equal(terminalTurn.status, "done");
  assert.deepEqual(terminalTurn.runtimeOutcome, {
    status: "completed",
    reason: "The verified work is durable; one advisory remains.",
    resultKind: "partial",
    runId: "run-event-owned",
    parentRunId: "run-parent",
    updatedAt: 510,
  });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].turnId, turnId);
  assert.equal(finals[0].streaming, false);
  assert.equal(finals[0].hiddenProcess, false);
  assert.match(finals[0].content, /verified work is durable/i);
  assert.equal(terminalTurn.blockIds.includes(finals[0].id), true);
  assert.equal(unrelatedTurn.status, "paused");
  assert.equal(unrelatedTurn.runtimeOutcome, undefined);
  assert.equal(restored.taskFlow.some((block) => block.turnId === unloadedTurnId), false);
});

test("generic terminal-final repair reserves consecutive unprojected FIFO user block IDs", () => {
  const workspace = "/tmp/session-terminal-final-reserved-receipts";
  const sessionId = 743;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-terminal-final-reserved-receipts";
  const terminalTurnId = "turn-terminal-final-before-queued-projections";
  const terminalUserBlockId = 74_500;
  let queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "terminal-final-reserved-first",
    terminalUserBlockId + 1,
    { text: "Project the first queued receipt" },
  );
  queue = appendQueuedWorkspaceTurn(
    queue,
    "terminal-final-reserved-second",
    terminalUserBlockId + 2,
    { text: "Project the second queued receipt" },
  );
  const reservedEntries = [...queue.entries];

  const restored = normalizeSessionRuntimeSnapshot({
    taskFlow: [{
      id: terminalUserBlockId,
      turnId: terminalTurnId,
      type: "user",
      content: "Repair this terminal conclusion",
    }],
    conversationTurns: [{
      id: terminalTurnId,
      userPrompt: "Repair this terminal conclusion",
      title: "Terminal conclusion repair",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "paused",
      summary: "Waiting for the durable conclusion projection.",
      blockIds: [terminalUserBlockId],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [
      turnEvents.withEventSchema({
        type: "run.completed",
        threadId: sessionKey,
        turnId: terminalTurnId,
        runId: "run-terminal-final-before-queued-projections",
        parentRunId: null,
        timestampMs: 200,
        resultKind: "success",
        summary: "The durable terminal conclusion was recovered.",
      }),
      turnEvents.withEventSchema({
        type: "turn.completed",
        threadId: sessionKey,
        turnId: terminalTurnId,
        timestampMs: 201,
        resultKind: "success",
      }),
    ],
    workspaceTurnQueue: queue,
    workspaceInstructionLedger: [],
  }, {
    workspacePath: workspace,
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: sessionEpoch,
  });

  const reservedUserBlockIds = reservedEntries.map((entry) => entry.receipt.userBlockId);
  const terminalFinals = restored.taskFlow.filter((block) =>
    block.turnId === terminalTurnId &&
    block.type === "agent" &&
    block.visibility === "assistant_final"
  );
  assert.equal(terminalFinals.length, 1);
  assert.equal(terminalFinals[0].id, terminalUserBlockId + 3);
  assert.equal(reservedUserBlockIds.includes(terminalFinals[0].id), false);
  assert.deepEqual(
    restored.workspaceTurnQueue.entries.map((entry) => entry.receipt.receiptId),
    reservedEntries.map((entry) => entry.receipt.receiptId),
    "generic final repair must leave both never-started FIFO receipts replayable",
  );

  for (const entry of reservedEntries) {
    const projectedTurn = restored.conversationTurns.find(
      (turn) => turn.id === entry.receipt.turnId,
    );
    const projectedUserBlocks = restored.taskFlow.filter(
      (block) => block.id === entry.receipt.userBlockId,
    );
    assert.equal(projectedTurn?.workspaceInstructionReceiptId, entry.receipt.receiptId);
    assert.equal(projectedTurn?.userPrompt, entry.instruction.payload.text);
    assert.deepEqual(projectedTurn?.blockIds, [entry.receipt.userBlockId]);
    assert.equal(projectedUserBlocks.length, 1);
    assert.equal(projectedUserBlocks[0].turnId, entry.receipt.turnId);
    assert.equal(projectedUserBlocks[0].type, "user");
  }
});

test("turn.completed without a marker keeps one canonical final when two were persisted", () => {
  const sessionKey = "event-owned-duplicate-final-session";
  const turnId = "turn-event-owned-duplicate-final";
  const restored = normalizeSessionRuntimeSnapshot({
    taskFlow: [
      {
        id: 901,
        type: "agent",
        turnId,
        content: "Older final",
        visibility: "assistant_final",
      },
      {
        id: 902,
        type: "agent",
        turnId,
        content: "Canonical final",
        streaming: true,
        hiddenProcess: true,
        visibility: "assistant_final",
      },
    ],
    conversationTurns: [{
      id: turnId,
      userPrompt: "Deduplicate the conclusion",
      title: "Duplicate final",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "paused",
      summary: "Waiting",
      blockIds: [901],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [
      turnEvents.withEventSchema({
        type: "run.completed",
        threadId: sessionKey,
        turnId,
        runId: "run-duplicate-final",
        parentRunId: null,
        timestampMs: 500,
        resultKind: "success",
        summary: "Completed once.",
      }),
      turnEvents.withEventSchema({
        type: "turn.completed",
        threadId: sessionKey,
        turnId,
        timestampMs: 501,
        resultKind: "success",
      }),
    ],
  });

  const finals = restored.taskFlow.filter((block) =>
    block.type === "agent" &&
    block.turnId === turnId &&
    block.visibility === "assistant_final"
  );
  assert.deepEqual(finals.map((block) => block.id), [902]);
  assert.equal(finals[0].content, "Canonical final");
  assert.equal(finals[0].streaming, false);
  assert.equal(finals[0].hiddenProcess, false);
  assert.equal(restored.taskFlow.find((block) => block.id === 901)?.visibility, "assistant_update");
  assert.deepEqual(restored.conversationTurns[0].blockIds, [901, 902]);
  assert.equal(restored.conversationTurns[0].status, "done");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.runId, "run-duplicate-final");
});

test("turn.completed without a marker closes an executing Turn and repairs its empty final", () => {
  const sessionKey = "event-owned-executing-session";
  const turnId = "turn-event-owned-executing";
  const restored = normalizeSessionRuntimeSnapshot({
    taskFlow: [{
      id: 911,
      type: "agent",
      turnId,
      content: "   ",
      streaming: true,
      hiddenProcess: true,
      visibility: "assistant_final",
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "Finish despite the crash",
      title: "Executing terminal Turn",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "executing",
      summary: "Still executing",
      blockIds: [911],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [
      turnEvents.withEventSchema({
        type: "run.completed",
        threadId: sessionKey,
        turnId,
        runId: "run-executing-terminal",
        parentRunId: null,
        timestampMs: 600,
        resultKind: "error",
        summary: "The executor ended with a durable error conclusion.",
      }),
      turnEvents.withEventSchema({
        type: "turn.completed",
        threadId: sessionKey,
        turnId,
        timestampMs: 601,
        resultKind: "error",
      }),
    ],
  });

  const final = restored.taskFlow.find((block) => block.id === 911);
  assert.equal(restored.conversationTurns[0].status, "done");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.status, "completed");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.resultKind, "error");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.runId, "run-executing-terminal");
  assert.equal(final?.visibility, "assistant_final");
  assert.equal(final?.streaming, false);
  assert.equal(final?.hiddenProcess, false);
  assert.match(final?.content || "", /durable error conclusion/i);
  assert.equal(restored.runtimeEvents.some((event) => event.type === "run.paused"), false);
});

test("restore projects terminal markers instead of inventing a resumable pause", () => {
  for (const status of ["completed", "error"]) {
    const sessionKey = `terminal-${status}-session`;
    const turnId = `turn-${status}`;
    const runId = `run-${status}`;
    const request = actionRequests.buildUserChoiceActionRequest({
      sessionKey,
      turnId,
      runId,
      title: "Stale terminal choice",
      optionValues: ["A", "B"],
      allowCustomReply: false,
      now: 500,
    });
    const restored = normalizeSessionRuntimeSnapshot({
      activeActionRequest: request,
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: "test-instance",
        sessionKey,
        turnId,
        runId,
        activeRunId: runId,
        status,
        terminalResultKind: status === "completed" ? "success" : "error",
        workflowMode: "plan",
        runtimeIntent: "plan",
        planStage: "plan",
        isPlanApproved: false,
        startedAt: 100,
        updatedAt: 500,
        closedAt: 500,
        closeReason: status === "completed" ? "completed" : "agent_loop_crashed",
        lastStreamError: status === "error" ? "terminal failure" : null,
      },
      taskFlow: [{
        id: 501,
        type: "agent",
        turnId,
        content: "Choose A or B",
        options: ["A", "B"].map((value) => ({ label: value, value })),
        choiceRequest: actionRequests.toUserChoiceResolutionIdentity(request),
      }],
      conversationTurns: [{
        id: turnId,
        userPrompt: "Finish the terminal run",
        title: "Terminal restore",
        mode: "plan",
        intent: "plan",
        displayIntent: "plan",
        status: "awaiting_input",
        summary: "Waiting",
        blockIds: [501],
        collapsed: false,
        createdAt: 100,
      }],
      runtimeEvents: [],
    });

    assert.equal(restored.activeActionRequest, null);
    assert.equal(restored.conversationTurns[0].status, "done");
    assert.equal(restored.conversationTurns[0].runtimeOutcome?.status, "completed");
    assert.equal(
      restored.conversationTurns[0].runtimeOutcome?.resultKind,
      status === "completed" ? "success" : "error",
    );
    const runEvents = restored.runtimeEvents.filter((event) => event.runId === runId);
    assert.deepEqual(runEvents.map((event) => event.type), [
      "run.started",
      "run.completed",
    ]);
    assert.equal(runEvents[1]?.resultKind, status === "completed" ? "success" : "error");
    assert.equal(runEvents.some((event) => event.type === "run.paused"), false);
    const turnTerminal = restored.runtimeEvents.find((event) =>
      event.type === "turn.completed" && event.turnId === turnId
    );
    assert.equal(turnTerminal?.resultKind, status === "completed" ? "success" : "error");
    const visibleFinals = restored.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === turnId &&
      block.visibility === "assistant_final"
    );
    assert.equal(visibleFinals.length, 1);
    assert.equal(restored.conversationTurns[0].blockIds.includes(visibleFinals[0].id), true);
    assert.match(
      visibleFinals[0].content,
      status === "error" ? /terminal failure/ : /completed/i,
    );
  }
});

test("restore preserves partial terminal truth and legacy completed markers fail closed", () => {
  for (const fixture of [
    { suffix: "partial", terminalResultKind: "partial", expected: "partial" },
    { suffix: "legacy", terminalResultKind: undefined, expected: "blocked" },
  ]) {
    const sessionKey = `terminal-${fixture.suffix}-session`;
    const turnId = `turn-${fixture.suffix}`;
    const runId = `run-${fixture.suffix}`;
    const restored = normalizeSessionRuntimeSnapshot({
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: `instance-${fixture.suffix}`,
        sessionKey,
        turnId,
        runId,
        activeRunId: runId,
        status: "completed",
        ...(fixture.terminalResultKind
          ? { terminalResultKind: fixture.terminalResultKind }
          : {}),
        workflowMode: "edit",
        runtimeIntent: "execute",
        planStage: "completed",
        isPlanApproved: false,
        startedAt: 100,
        updatedAt: 500,
        closedAt: 500,
        closeReason: "restored_terminal_checkpoint",
      },
      taskFlow: [{
        id: 701,
        type: "user",
        turnId,
        content: "请完成所有修改。",
      }],
      conversationTurns: [{
        id: turnId,
        userPrompt: "请完成所有修改。",
        title: "终态恢复",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "executing",
        summary: "执行中",
        blockIds: [701],
        collapsed: false,
        createdAt: 100,
      }],
      runtimeEvents: [],
    });

    assert.equal(restored.conversationTurns[0].runtimeOutcome?.resultKind, fixture.expected);
    assert.equal(restored.runtimeEvents.find((event) =>
      event.type === "run.completed" && event.runId === runId
    )?.resultKind, fixture.expected);
    assert.equal(restored.runtimeEvents.find((event) =>
      event.type === "turn.completed" && event.turnId === turnId
    )?.resultKind, fixture.expected);
    assert.doesNotMatch(restored.conversationTurns[0].summary, /成功完成/);
  }
});

test("terminal marker restore keeps the last final and demotes only earlier same-Turn finals", () => {
  const sessionKey = "terminal-duplicate-final-session";
  const turnId = "turn-terminal-duplicate-final";
  const unrelatedTurnId = "turn-unrelated-duplicate-final";
  const runId = "run-terminal-duplicate-final";
  const restored = normalizeSessionRuntimeSnapshot({
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId,
      activeRunId: runId,
      status: "completed",
      workflowMode: "edit",
      runtimeIntent: "execute",
      planStage: "idle",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 500,
      closedAt: 500,
      closeReason: "completed",
      lastStreamError: null,
    },
    taskFlow: [
      {
        id: 601,
        type: "agent",
        turnId,
        content: "Older final",
        visibility: "assistant_final",
        publicProgress: {
          schemaVersion: 1,
          kind: "assistant_commentary",
          source: "model_visible_content",
          sessionKey,
          turnId,
          displayTurnId: turnId,
          runId,
          parentRunId: null,
          createdAt: 200,
        },
      },
      {
        id: 602,
        type: "agent",
        turnId,
        content: "Canonical final",
        streaming: true,
        hiddenProcess: true,
        visibility: "assistant_final",
        publicProgress: {
          schemaVersion: 1,
          kind: "assistant_commentary",
          source: "model_visible_content",
          sessionKey,
          turnId,
          displayTurnId: turnId,
          runId,
          parentRunId: null,
          createdAt: 300,
        },
      },
      {
        id: 603,
        type: "agent",
        turnId: unrelatedTurnId,
        content: "Unrelated older final",
        visibility: "assistant_final",
      },
      {
        id: 604,
        type: "agent",
        turnId: unrelatedTurnId,
        content: "Unrelated newer final",
        visibility: "assistant_final",
      },
    ],
    conversationTurns: [{
      id: turnId,
      userPrompt: "Finish the run",
      title: "Terminal duplicate final",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "done",
      summary: "Completed",
      blockIds: [601],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [],
  });

  const ownedFinals = restored.taskFlow.filter((block) =>
    block.type === "agent" &&
    block.turnId === turnId &&
    block.visibility === "assistant_final"
  );
  assert.deepEqual(ownedFinals.map((block) => block.id), [602]);
  assert.equal(ownedFinals[0].content, "Canonical final");
  assert.equal(ownedFinals[0].streaming, false);
  assert.equal(ownedFinals[0].hiddenProcess, false);
  const demotedFinal = restored.taskFlow.find((block) => block.id === 601);
  assert.equal(demotedFinal?.visibility, "assistant_update");
  assert.equal(demotedFinal?.publicProgress, undefined);
  assert.equal(ownedFinals[0].publicProgress, undefined);
  assert.deepEqual(restored.conversationTurns[0].blockIds, [601, 602]);
  assert.equal(
    restored.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === unrelatedTurnId &&
      block.visibility === "assistant_final"
    ).length,
    2,
  );
});

test("terminal marker restore closes executing and planning owners and repairs empty streaming finals", () => {
  for (const [index, initialStatus] of ["executing", "planning"].entries()) {
    const sessionKey = `terminal-${initialStatus}-owner-session`;
    const turnId = `turn-terminal-${initialStatus}-owner`;
    const runId = `run-terminal-${initialStatus}-owner`;
    const finalBlockId = 700 + index;
    const restored = normalizeSessionRuntimeSnapshot({
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: "test-instance",
        sessionKey,
        turnId,
        runId,
        activeRunId: runId,
        status: "completed",
        workflowMode: initialStatus === "planning" ? "plan" : "edit",
        runtimeIntent: initialStatus === "planning" ? "plan" : "execute",
        planStage: initialStatus === "planning" ? "plan" : "idle",
        isPlanApproved: false,
        startedAt: 100,
        updatedAt: 500,
        closedAt: 500,
        closeReason: "partial_checkpoint",
        lastStreamError: null,
      },
      taskFlow: [{
        id: finalBlockId,
        type: "agent",
        turnId,
        content: "   ",
        streaming: true,
        hiddenProcess: true,
        visibility: "assistant_final",
      }],
      conversationTurns: [{
        id: turnId,
        userPrompt: "Complete this work",
        title: "Terminal owner restore",
        mode: initialStatus === "planning" ? "plan" : "edit",
        intent: initialStatus === "planning" ? "plan" : "execute",
        displayIntent: initialStatus === "planning" ? "plan" : "execute",
        status: initialStatus,
        summary: "In progress",
        blockIds: [finalBlockId],
        collapsed: false,
        createdAt: 100,
      }],
      runtimeEvents: [turnEvents.withEventSchema({
        type: "run.completed",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        timestampMs: 500,
        resultKind: "partial",
        summary: "Some work remains documented.",
      })],
    });

    const restoredTurn = restored.conversationTurns[0];
    const restoredFinal = restored.taskFlow.find((block) => block.id === finalBlockId);
    assert.equal(restoredTurn.status, "done");
    assert.equal(restoredTurn.runtimeOutcome?.status, "completed");
    assert.equal(restoredTurn.runtimeOutcome?.resultKind, "partial");
    assert.equal(restoredFinal?.visibility, "assistant_final");
    assert.equal(restoredFinal?.streaming, false);
    assert.equal(restoredFinal?.hiddenProcess, false);
    assert.match(restoredFinal?.content || "", /partial/i);
    assert.equal(restored.runtimeEvents.some((event) => event.type === "run.paused"), false);
  }
});

test("restore canonicalizes an abort-only trace before preserving its canceled outcome", () => {
  const sessionKey = "terminal-aborted-session";
  const turnId = "turn-aborted";
  const runId = "run-aborted";
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId,
    title: "Stale choice after cancellation",
    optionValues: ["Continue", "Stop"],
    allowCustomReply: false,
    now: 500,
  });
  const restored = normalizeSessionRuntimeSnapshot({
    activeActionRequest: request,
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId,
      activeRunId: runId,
      status: "completed",
      workflowMode: "edit",
      runtimeIntent: "execute",
      planStage: "idle",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 500,
      closedAt: 500,
      closeReason: "user_cancelled",
      lastStreamError: null,
    },
    taskFlow: [{
      id: 601,
      type: "agent",
      turnId,
      content: "Continue or stop?",
      options: ["Continue", "Stop"].map((value) => ({ label: value, value })),
      choiceRequest: actionRequests.toUserChoiceResolutionIdentity(request),
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "Cancel this work",
      title: "Canceled turn",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "awaiting_input",
      summary: "Waiting",
      blockIds: [601],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [
      turnEvents.withEventSchema({
        type: "run.aborted",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        timestampMs: 500,
        reason: "user_cancelled",
        message: "The user canceled this run.",
      }),
      turnEvents.withEventSchema({
        type: "turn.completed",
        threadId: sessionKey,
        turnId,
        timestampMs: 500,
        resultKind: "canceled",
      }),
    ],
  });

  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.conversationTurns[0].status, "done");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.status, "completed");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.resultKind, "canceled");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.reason, "user_cancelled");
  const runEvents = restored.runtimeEvents.filter((event) => event.runId === runId);
  assert.deepEqual(runEvents.map((event) => event.type), [
    "run.started",
    "run.aborted",
    "run.completed",
  ]);
  assert.equal(runEvents[2]?.resultKind, "canceled");
  const turnTerminals = restored.runtimeEvents.filter((event) =>
    event.turnId === turnId && event.type === "turn.completed"
  );
  assert.deepEqual(turnTerminals.map((event) => [event.type, event.resultKind]), [
    ["turn.completed", "canceled"],
  ]);
  assert.equal(restored.runtimeEvents.some((event) => event.type === "run.paused"), false);
  assert.equal(restored.runtimeEvents.some((event) => event.type === "run.failed"), false);
});

test("restore clears non-resumable tool permission state and preserves a paused event", () => {
  const sessionKey = "tool-session";
  const turnId = "turn-tool";
  const runId = "run-tool";
  const request = pendingToolReview.buildToolPermissionActionRequest({
    sessionKey,
    turnId,
    runId,
    title: "修改源码",
    taskId: 401,
    toolCall: { name: "write_file", arguments: { path: "src/app.ts" } },
    now: 400,
  });
  const restored = normalizeSessionRuntimeSnapshot({
    activeActionRequest: request,
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId,
      status: "paused",
      workflowMode: "edit",
      runtimeIntent: "execute",
      planStage: "idle",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 400,
      closedAt: 400,
      closeReason: "tool_permission",
    },
    taskFlow: [{
      id: 401,
      type: "tool",
      turnId,
      toolName: "write_file",
      target: "src/app.ts",
      status: "pending_review",
      toolStatus: "pending",
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "修改 src/app.ts",
      title: "修改源码",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "awaiting_approval",
      summary: "等待批准",
      blockIds: [401],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [],
  });

  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.conversationTurns[0].status, "paused");
  assert.equal(restored.taskFlow[0].toolStatus, "failed");
  assert.equal(restored.harnessRunMarker.closeReason, "non_resumable_tool_permission_cleared");
  assert.equal(restored.runtimeEvents.at(-1).type, "run.paused");
  assert.equal(restored.runtimeEvents.at(-1).reason, "non_resumable_tool_permission_cleared");
});

test("restore emits run.paused when a running marker was interrupted by restart", () => {
  const restored = normalizeSessionRuntimeSnapshot({
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey: "restart-session",
      turnId: "turn-restart",
      runId: "run-restart",
      status: "running",
      workflowMode: "edit",
      runtimeIntent: "execute",
      planStage: "idle",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 500,
      closedAt: null,
      closeReason: null,
    },
    conversationTurns: [{
      id: "turn-restart",
      userPrompt: "继续修复",
      title: "继续修复",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "executing",
      summary: "",
      blockIds: [],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [{
      schemaVersion: 2,
      type: "run.started",
      threadId: "restart-session",
      turnId: "turn-restart",
      runId: "run-restart",
      parentRunId: null,
      timestampMs: 100,
    }],
  });

  assert.equal(restored.harnessRunMarker.status, "paused");
  assert.deepEqual(restored.runtimeEvents.map((event) => event.type), ["run.started", "run.paused"]);
  assert.equal(restored.runtimeEvents[1].reason, "application_restarted");
});

test("paused Harness restore adopts only one exact Run start and fail-closes corrupt starts", () => {
  const workspace = "/tmp/session-paused-harness-owner";
  const sessionId = 76;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-paused-harness-owner";

  const restoreVariant = (variant) => {
    const suffix = `paused-harness-${variant}`;
    const queue = buildDispatchingWorkspaceTurn(
      sessionKey,
      sessionEpoch,
      suffix,
      variant === "missing" ? 76_001 : variant === "wrong_parent" ? 76_101 : 76_201,
      { text: `Resume ${variant} Harness checkpoint` },
    );
    const entry = queue.entries[0];
    const runId = `run-${suffix}`;
    const projection = buildExactWorkspaceInstructionProjection(entry, {
      status: "paused",
      summary: "Waiting to resume the exact checkpoint.",
    });
    const starts = variant === "missing"
      ? []
      : variant === "wrong_parent"
      ? [{ runId, parentRunId: "run-unrelated-parent", timestampMs: 100 }]
      : [
          { runId, parentRunId: null, timestampMs: 100 },
          { runId, parentRunId: null, timestampMs: 101 },
        ];
    const restored = normalizeSessionRuntimeSnapshot({
      ...projection,
      currentTurnId: entry.receipt.turnId,
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: `instance-${variant}`,
        sessionKey,
        turnId: entry.receipt.turnId,
        runId,
        activeRunId: runId,
        parentRunId: null,
        activeParentRunId: null,
        status: "paused",
        workflowMode: "edit",
        runtimeIntent: "execute",
        planStage: "idle",
        isPlanApproved: false,
        startedAt: 100,
        updatedAt: 200,
        closedAt: 200,
        closeReason: "restored_paused_checkpoint",
      },
      runtimeEvents: starts.map((start) => turnEvents.withEventSchema({
        type: "run.started",
        threadId: sessionKey,
        turnId: entry.receipt.turnId,
        runId: start.runId,
        parentRunId: start.parentRunId,
        timestampMs: start.timestampMs,
      })),
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
    }, {
      workspacePath: workspace,
      expectedSessionKey: sessionKey,
      expectedSessionEpoch: sessionEpoch,
    });
    return { entry, restored, runId };
  };

  const adopted = restoreVariant("missing");
  const adoptedEvents = adopted.restored.runtimeEvents.filter((event) =>
    "turnId" in event &&
    event.turnId === adopted.entry.receipt.turnId &&
    "runId" in event &&
    event.runId === adopted.runId
  );
  assert.equal(adopted.restored.workspaceTurnQueue.entries.length, 0);
  assert.equal(adopted.restored.harnessRunMarker?.status, "paused");
  assert.deepEqual(adoptedEvents.map((event) => event.type), ["run.started", "run.paused"]);
  assert.equal(adoptedEvents[0].parentRunId, null);
  assert.equal(adoptedEvents[1].parentRunId, null);
  assert.equal(adoptedEvents[0].timestampMs <= adoptedEvents[1].timestampMs, true);
  assert.equal(
    adopted.restored.runtimeEvents.some((event) =>
      event.type === "turn.completed" && event.turnId === adopted.entry.receipt.turnId
    ),
    false,
    "a synthesized exact start is adopted as a resumable pause, not terminalized",
  );
  assert.equal(
    adopted.restored.conversationTurns.find(
      (turn) => turn.id === adopted.entry.receipt.turnId,
    )?.runtimeOutcome,
    undefined,
  );

  for (const variant of ["wrong_parent", "duplicate"]) {
    const rejected = restoreVariant(variant);
    const sourceTurn = rejected.restored.conversationTurns.find(
      (turn) => turn.id === rejected.entry.receipt.turnId,
    );
    const sourceFinals = rejected.restored.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === rejected.entry.receipt.turnId &&
      block.visibility === "assistant_final"
    );
    assert.equal(rejected.restored.workspaceTurnQueue.entries.length, 0, variant);
    assert.equal(
      rejected.restored.harnessRunMarker,
      null,
      `${variant}: a corrupt paused marker must not remain resumable`,
    );
    assert.equal(sourceTurn.runtimeOutcome?.status, "completed", variant);
    assert.equal(sourceTurn.runtimeOutcome?.resultKind, "error", variant);
    assert.equal(sourceFinals.length, 1, variant);
    assert.equal(sourceFinals[0].streaming, false, variant);
    assert.equal(sourceFinals[0].content, sourceTurn.summary, variant);
    assert.equal(
      rejected.restored.runtimeEvents.filter((event) =>
        event.type === "turn.completed" && event.turnId === rejected.entry.receipt.turnId
      ).length,
      1,
      `${variant}: fail-close must create exactly one source Turn conclusion`,
    );
  }
});

test("a loaded durable Goal deletion fence prevents an old session snapshot from resurrecting", () => {
  const workspace = "/tmp/deleted-goal-restore";
  const sessionKey = `${workspace}:71`;
  const turnId = "turn-deleted-goal";
  const runId = "run-deleted-goal";
  const goal = goalState.createGoalDefinition({
    objective: "修复按钮并验证交互",
    sessionKey,
    ownerTurnId: turnId,
  });
  const progress = goalState.createGoalProgress(goal.id, "progress.md");
  const runtime = goalRuntime.buildGoalRuntimeSnapshot({
    goal,
    progress,
    phase: "execute",
  });
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId,
    title: "Goal choice",
    optionValues: ["继续"],
    allowCustomReply: true,
    now: 200,
  });

  goalPersistence.markGoalRuntimeDeleted(workspace, goal.id);
  try {
    const restored = normalizeSessionRuntimeSnapshot({
      activeGoal: goal,
      goalProgress: progress,
      goalStatus: "awaiting_input",
      goalRuntime: { ...runtime, status: "awaiting_input" },
      queuedUserMessage: {
        id: "queued-deleted-goal",
        sessionKey,
        text: "继续",
        status: "queued",
        createdAt: 210,
        runtimeIntentOverride: "goal",
        goalContinuationAuthorization: {
          kind: "goal_continuation_authorization",
          source: "goal_user_choice",
          workspaceKey: workspace,
          sessionKey,
          goalId: goal.id,
          goalRevision: goal.revision || 1,
          ownerTurnId: turnId,
          requestId: request.requestId,
        },
        goalContinuationGuidance: "继续",
      },
      activeActionRequest: request,
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: "deleted-goal-instance",
        sessionKey,
        workspace,
        sessionId: 71,
        turnId,
        runId,
        status: "paused",
        workflowMode: "edit",
        runtimeIntent: "goal",
        planStage: "idle",
        isPlanApproved: false,
        iteration: 1,
        maxIterations: 6,
        messagesLen: 2,
        toolCount: 0,
        latestTool: null,
        latestToolTarget: null,
        activeStreamId: null,
        streamStatus: "closed",
        streamChunkCount: 0,
        streamByteCount: 0,
        streamElapsedMs: 0,
        streamLifecycleStatus: "completed",
        lastStreamError: null,
        startedAt: 100,
        updatedAt: 200,
        closedAt: 200,
        closeReason: "awaiting_user_choice",
      },
      taskFlow: [{
        id: 501,
        type: "agent",
        turnId,
        content: "请选择",
        options: [{ label: "继续", value: "继续" }],
        choiceRequest: request,
      }],
      conversationTurns: [{
        id: turnId,
        userPrompt: "修复按钮",
        title: "Goal",
        mode: "edit",
        intent: "goal",
        displayIntent: "goal",
        status: "awaiting_input",
        summary: "等待选择",
        blockIds: [501],
        collapsed: false,
        createdAt: 100,
      }],
    }, {
      restoreInterruptedGoal: true,
      workspacePath: workspace,
    });

    assert.equal(restored.activeGoal, null);
    assert.equal(restored.goalRuntime, null);
    assert.equal(restored.goalProgress, null);
    assert.equal(restored.goalStatus, "paused");
    assert.equal(restored.queuedUserMessage, null);
    assert.equal(restored.activeActionRequest, null);
    assert.equal(restored.harnessRunMarker, null);
    assert.deepEqual(restored.taskFlow[0].options, []);
    assert.equal(restored.conversationTurns[0].status, "paused");
  } finally {
    goalPersistence.unmarkGoalRuntimeDeleted(workspace, goal.id);
  }
});

test("a Goal deletion fence preserves an unrelated pending request in the same session", () => {
  const workspace = "/tmp/deleted-goal-with-new-run";
  const sessionKey = `${workspace}:72`;
  const goalTurnId = "turn-old-goal";
  const requestTurnId = "turn-current-run";
  const requestRunId = "run-current-run";
  const goal = goalState.createGoalDefinition({
    objective: "旧 Goal",
    sessionKey,
    ownerTurnId: goalTurnId,
  });
  const progress = goalState.createGoalProgress(goal.id, "progress.md");
  const runtime = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId: requestTurnId,
    runId: requestRunId,
    title: "Current non-Goal choice",
    optionValues: ["保留这个选择"],
    allowCustomReply: true,
    now: 300,
  });

  goalPersistence.markGoalRuntimeDeleted(workspace, goal.id);
  try {
    const restored = normalizeSessionRuntimeSnapshot({
      activeGoal: goal,
      goalProgress: progress,
      goalStatus: "active",
      goalRuntime: runtime,
      activeActionRequest: request,
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: "current-run-instance",
        sessionKey,
        workspace,
        sessionId: 72,
        turnId: requestTurnId,
        runId: requestRunId,
        status: "paused",
        workflowMode: "edit",
        runtimeIntent: "execute",
        planStage: "idle",
        isPlanApproved: false,
        iteration: 1,
        maxIterations: 6,
        messagesLen: 2,
        toolCount: 0,
        latestTool: null,
        latestToolTarget: null,
        activeStreamId: null,
        streamStatus: "closed",
        streamChunkCount: 0,
        streamByteCount: 0,
        streamElapsedMs: 0,
        streamLifecycleStatus: "completed",
        lastStreamError: null,
        startedAt: 200,
        updatedAt: 300,
        closedAt: 300,
        closeReason: "awaiting_user_choice",
      },
      taskFlow: [{
        id: 601,
        type: "agent",
        turnId: requestTurnId,
        content: "请选择当前请求",
        options: [{ label: "保留这个选择", value: "保留这个选择" }],
        choiceRequest: request,
      }],
      conversationTurns: [{
        id: requestTurnId,
        userPrompt: "当前非 Goal 请求",
        title: "Current request",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "awaiting_input",
        summary: "等待选择",
        blockIds: [601],
        collapsed: false,
        createdAt: 200,
      }],
    }, {
      restoreInterruptedGoal: true,
      workspacePath: workspace,
    });

    assert.equal(restored.activeGoal, null);
    assert.equal(restored.goalRuntime, null);
    assert.equal(restored.activeActionRequest?.requestId, request.requestId);
    assert.equal(restored.harnessRunMarker?.runId, requestRunId);
    assert.equal(restored.taskFlow[0].options.length, 1);
    assert.equal(restored.conversationTurns[0].status, "awaiting_input");
  } finally {
    goalPersistence.unmarkGoalRuntimeDeleted(workspace, goal.id);
  }
});

test("switching A to B preserves B background runtime and queued workspace Turns", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-owner-switch";
  const sessionAId = 101;
  const sessionBId = 202;
  const sessionAKey = `${workspace}:${sessionAId}`;
  const sessionBKey = `${workspace}:${sessionBId}`;
  const sessionAEpoch = "epoch-a";
  const sessionBEpoch = "epoch-b";
  const queueB = buildQueuedWorkspaceTurn(sessionBKey, sessionBEpoch, "background-b");
  const backgroundRuntimeB = {
    owner: "background-b",
    agentStatus: "running",
    isGenerating: true,
    currentTurnId: "turn-running-b",
    workspaceTurnQueue: queueB,
    workspaceInstructionLedger: [{
      clientSubmissionId: "submission-completed-b",
      payloadIdentity: "payload-completed-b",
      receipt: {
        schemaVersion: 1,
        kind: "workspace_turn_receipt",
        receiptId: "receipt-completed-b",
        clientSubmissionId: "submission-completed-b",
        sessionKey: sessionBKey,
        sessionEpoch: sessionBEpoch,
        turnId: "turn-completed-b",
        userBlockId: 10_002,
        acceptedAt: 1,
      },
    }],
    transcriptPartial: true,
    transcriptLoadedTurns: 30,
    transcriptTotalTurns: 44,
  };

  try {
    useAppStore.setState({
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionAId,
      activeSessionByWorkspace: { [workspace]: sessionAId },
      sessionsByWorkspace: {
        [workspace]: [
          {
            id: sessionAId,
            title: "Session A",
            date: "Today",
            active: true,
            planLifecycleEpoch: sessionAEpoch,
            messages: [],
          },
          {
            id: sessionBId,
            title: "Session B",
            date: "Today",
            active: false,
            planLifecycleEpoch: sessionBEpoch,
            messages: [],
          },
        ],
      },
      runtimeBySessionKey: {
        [sessionAKey]: { owner: "visible-a" },
        [sessionBKey]: backgroundRuntimeB,
      },
    });

    useAppStore.getState().setCurrentSessionId(sessionBId);

    const switched = useAppStore.getState();
    assert.equal(switched.currentSessionId, sessionBId);
    assert.equal(switched.runtimeBySessionKey[sessionBKey], backgroundRuntimeB);
    assert.equal(switched.runtimeBySessionKey[sessionBKey].agentStatus, "running");
    assert.equal(switched.runtimeBySessionKey[sessionBKey].isGenerating, true);
    assert.equal(switched.runtimeBySessionKey[sessionBKey].workspaceTurnQueue, queueB);
    assert.equal(switched.runtimeBySessionKey[sessionBKey].workspaceTurnQueue.entries.length, 1);
    assert.equal(switched.runtimeBySessionKey[sessionBKey].workspaceInstructionLedger.length, 1);
    assert.equal(switched.runtimeBySessionKey[sessionBKey].transcriptTotalTurns, 44);
    assert.equal(switched.workspaceTurnQueue, null, "visible UI remains blank until B restore publishes");
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("switching to a recording-disabled Session preserves its memory-only FIFO", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-owner-switch-memory";
  const sessionAId = 303;
  const sessionBId = 404;
  const sessionBKey = `${workspace}:${sessionBId}`;
  const sessionBEpoch = "epoch-memory-b";
  const queueB = buildQueuedWorkspaceTurn(sessionBKey, sessionBEpoch, "memory-b");
  const memoryRuntimeB = {
    owner: "memory-b",
    agentStatus: "idle",
    isGenerating: false,
    workspaceTurnQueue: queueB,
    workspaceInstructionLedger: [],
    transcriptPartial: false,
    transcriptLoadedTurns: 1,
    transcriptTotalTurns: 1,
  };

  try {
    useAppStore.setState({
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionAId,
      activeSessionByWorkspace: { [workspace]: sessionAId },
      sessionsByWorkspace: {
        [workspace]: [
          {
            id: sessionAId,
            title: "Session A",
            date: "Today",
            active: true,
            planLifecycleEpoch: "epoch-memory-a",
            messages: [],
          },
          {
            id: sessionBId,
            title: "Session B memory only",
            date: "Today",
            active: false,
            planLifecycleEpoch: sessionBEpoch,
            storageStatus: "temporary",
            recordingDisabled: true,
            messages: [],
          },
        ],
      },
      runtimeBySessionKey: { [sessionBKey]: memoryRuntimeB },
    });

    useAppStore.getState().setCurrentSessionId(sessionBId);

    const switched = useAppStore.getState();
    const sessionB = switched.sessionsByWorkspace[workspace].find(
      (session) => session.id === sessionBId,
    );
    assert.equal(sessionB.recordingDisabled, true);
    assert.equal(switched.runtimeBySessionKey[sessionBKey], memoryRuntimeB);
    assert.equal(switched.runtimeBySessionKey[sessionBKey].workspaceTurnQueue, queueB);
    assert.equal(
      switched.runtimeBySessionKey[sessionBKey].workspaceTurnQueue.entries[0].receipt.turnId,
      "turn-memory-b",
    );
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher rebuilds a paged-out FIFO head and adopts its exact durable identities", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-paged-queue";
  const sessionId = 505;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-paged-queue";
  const queue = buildQueuedWorkspaceTurn(sessionKey, sessionEpoch, "paged-head", 50_001);
  const newerTurns = Array.from({ length: 30 }, (_, index) => ({
    id: `turn-newer-${index}`,
    userPrompt: `newer ${index}`,
    title: `Newer ${index}`,
    mode: "chat",
    intent: "respond",
    displayIntent: "respond",
    status: "done",
    summary: "done",
    blockIds: [20_000 + index],
    collapsed: false,
    createdAt: 100 + index,
  }));
  const newerBlocks = newerTurns.map((turn, index) => ({
    id: 20_000 + index,
    turnId: turn.id,
    type: "user",
    content: turn.userPrompt,
  }));
  let capturedDispatch = null;

  try {
    useAppStore.setState({
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Paged queue",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: newerBlocks,
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      taskFlow: newerBlocks,
      conversationTurns: newerTurns,
      runtimeEvents: [],
      transcriptPartial: true,
      transcriptLoadedTurns: 30,
      transcriptTotalTurns: 31,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: (text, images, options) => {
        capturedDispatch = { text, images, options };
        useAppStore.setState({ currentTurnId: options.turnIdOverride });
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    });

    const dispatched = useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey);
    const current = useAppStore.getState();
    const receipt = queue.entries[0].receipt;
    const rebuiltTurn = current.conversationTurns.find((turn) => turn.id === receipt.turnId);
    const rebuiltBlock = current.taskFlow.find((block) => block.id === receipt.userBlockId);

    assert.equal(dispatched, true);
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(capturedDispatch.options.turnIdOverride, receipt.turnId);
    assert.equal(capturedDispatch.options.admittedUserBlockId, receipt.userBlockId);
    assert.equal(capturedDispatch.options.workspaceInstructionClaim.turnId, receipt.turnId);
    assert.equal(rebuiltTurn.clientSubmissionId, receipt.clientSubmissionId);
    assert.deepEqual(rebuiltTurn.blockIds, [receipt.userBlockId]);
    assert.equal(rebuiltBlock.type, "user");
    assert.equal(rebuiltBlock.turnId, receipt.turnId);
    assert.equal(current.transcriptLoadedTurns, 31);
    assert.equal(current.transcriptTotalTurns, 31);
    assert.equal(current._nextTaskId() > receipt.userBlockId, true);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("workspace-adopted async local-fast completion retains its FIFO claim until the terminal conclusion is durable", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const workspace = "/tmp/session-local-fast-fifo";
  const sessionId = 556;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-local-fast-fifo";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "local-fast-fifo",
    55_601,
    { text: "/agent writer" },
  );
  const receipt = queue.entries[0].receipt;
  const persistenceCheckpoints = [];
  let claimedQueueSnapshot = null;
  let agentSwitchStarted = 0;
  let resolveAgentSwitch;
  const pendingAgentSwitch = new Promise((resolve) => {
    resolveAgentSwitch = resolve;
  });

  const captureStoreProjection = (source) => {
    const current = useAppStore.getState();
    persistenceCheckpoints.push({
      source,
      queueEntries: current.workspaceTurnQueue?.entries.map((entry) => ({
        turnId: entry.receipt.turnId,
        status: entry.status,
      })) || [],
      currentTurnId: current.currentTurnId,
      hasTurnConclusion: current.runtimeEvents.some((event) =>
        event.type === "turn.completed" &&
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId
      ),
      runtimeOutcome: current.conversationTurns.find(
        (turn) => turn.id === receipt.turnId,
      )?.runtimeOutcome || null,
    });
  };

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, sessionRecordingEnabled: false },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Local-fast FIFO",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          recordingDisabled: true,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      setActiveStudioAgentKey: async () => {
        agentSwitchStarted += 1;
        return pendingAgentSwitch;
      },
      sendMessage: realSendMessage,
      updateSession: (_scopeKey, _sessionId, patch) => {
        const snapshot = patch.runtimeSnapshot?.snapshot || patch.runtimeSnapshot || null;
        persistenceCheckpoints.push({
          source: "local-fast-terminal",
          queueEntries: snapshot?.workspaceTurnQueue?.entries?.map((entry) => ({
            turnId: entry.receipt.turnId,
            status: entry.status,
          })) || [],
          currentTurnId: snapshot?.currentTurnId || null,
          hasTurnConclusion: snapshot?.runtimeEvents?.some((event) =>
            event.type === "turn.completed" &&
            event.threadId === sessionKey &&
            event.turnId === receipt.turnId
          ) === true,
          runtimeOutcome: snapshot?.conversationTurns?.find(
            (turn) => turn.id === receipt.turnId,
          )?.runtimeOutcome || null,
        });
      },
      saveCurrentRuntimeToSession: () => captureStoreProjection("fifo-dispatcher"),
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    for (let attempt = 0; attempt < 10 && agentSwitchStarted === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    let current = useAppStore.getState();
    assert.equal(agentSwitchStarted, 1, "the real local-fast handler must own the pending work");
    assert.equal(current.currentTurnId, receipt.turnId);
    assert.equal(current.workspaceTurnQueue.entries.length, 1);
    assert.equal(current.workspaceTurnQueue.entries[0].status, "dispatching");
    claimedQueueSnapshot = current.workspaceTurnQueue;
    assert.equal(
      current.runtimeEvents.some((event) =>
        event.type === "turn.completed" && event.turnId === receipt.turnId
      ),
      false,
    );
    assert.equal(
      current.conversationTurns.find((turn) => turn.id === receipt.turnId)?.runtimeOutcome,
      undefined,
    );

    // Merely observing the adopted Turn as current must not acknowledge the
    // durable head while its asynchronous local-fast side effect is pending.
    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), false);
    current = useAppStore.getState();
    assert.equal(current.currentTurnId, receipt.turnId);
    assert.equal(current.workspaceTurnQueue.entries.length, 1);
    assert.equal(current.workspaceTurnQueue.entries[0].status, "dispatching");
    assert.equal(
      persistenceCheckpoints.some((checkpoint) =>
        checkpoint.source === "fifo-dispatcher" && checkpoint.queueEntries.length === 0
      ),
      false,
      "currentTurnId alone must never persist a FIFO acknowledgement",
    );

    resolveAgentSwitch();
    await pendingAgentSwitch;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (useAppStore.getState().workspaceTurnQueue?.entries.length === 0) break;
    }

    current = useAppStore.getState();
    const ownedTurn = current.conversationTurns.find((turn) => turn.id === receipt.turnId);
    const terminalEvents = current.runtimeEvents.filter((event) =>
      event.type === "turn.completed" &&
      event.threadId === sessionKey &&
      event.turnId === receipt.turnId
    );
    const durableSession = current.sessionsByWorkspace[workspace].find(
      (session) => session.id === sessionId,
    );
    const durableSnapshot = durableSession?.runtimeSnapshot?.snapshot ||
      durableSession?.runtimeSnapshot ||
      null;
    const durableHead = durableSnapshot?.workspaceTurnQueue?.entries?.[0] || null;
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(terminalEvents.length, 1);
    assert.equal(ownedTurn.runtimeOutcome?.status, "completed");
    assert.equal(ownedTurn.runtimeOutcome?.resultKind, "success");
    assert.equal(
      current.taskFlow.filter((block) =>
        block.turnId === receipt.turnId &&
        block.type === "agent" &&
        block.visibility === "assistant_final"
      ).length,
      1,
    );
    assert.ok(
      durableHead &&
        durableHead.receipt.receiptId === receipt.receiptId &&
        durableHead.status === "dispatching",
      "the durability barrier must persist terminal evidence with its exact dispatching head",
    );
    assert.equal(
      durableSnapshot.runtimeEvents.some((event) =>
        event.type === "turn.completed" &&
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId
      ),
      true,
    );
    const durableTurn = durableSnapshot.conversationTurns.find(
      (turn) => turn.id === receipt.turnId,
    );
    assert.equal(durableTurn.runtimeOutcome?.status, "completed");
    assert.equal(durableTurn.runtimeOutcome?.resultKind, "success");
    assert.equal(
      persistenceCheckpoints.some((checkpoint) =>
        checkpoint.source === "fifo-dispatcher" && checkpoint.queueEntries.length === 0
      ),
      false,
      "in-memory FIFO retirement must not be persisted through the active-global save helper",
    );

    // Re-introduce the exact stale dispatching checkpoint to make transient
    // map cleanup observable through public Store behavior. Before completion
    // the duplicate dispatcher call above retained this head; after canonical
    // verification and retirement, the lease must be gone/settled so restore
    // reconciliation can discard the already-terminal checkpoint.
    assert.ok(claimedQueueSnapshot);
    useAppStore.setState({ workspaceTurnQueue: claimedQueueSnapshot });
    assert.equal(
      useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey),
      false,
    );
    assert.equal(
      useAppStore.getState().workspaceTurnQueue.entries.length,
      0,
      "the execution lease map must be cleaned only after the verifier retires the real head",
    );
  } finally {
    resolveAgentSwitch?.();
    await pendingAgentSwitch.catch(() => {});
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    useAppStore.setState(originalState, true);
  }
});

test("permanent local-fast storage failure memory-closes the Turn and advances the next FIFO head exactly once", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const workspace = "/tmp/session-local-fast-memory-fallback-fifo";
  const sessionId = 564;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-local-fast-memory-fallback-fifo";
  let queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "memory-fallback-first",
    56_401,
    { text: "/agent writer" },
  );
  queue = appendQueuedWorkspaceTurn(
    queue,
    "memory-fallback-second",
    56_501,
    { text: "Follow-up after local-fast" },
  );
  const receipts = queue.entries.map((entry) => entry.receipt);
  const handlerAgents = [];
  let nextHeadDispatchCalls = 0;
  let saveCalls = 0;
  let metadataRefreshCalls = 0;
  const defaultTauriInvoke = tauriInvoke;

  try {
    tauriInvoke = async (command) => {
      if (command === "save_project_session") {
        saveCalls += 1;
        const error = new Error("permanent Project Session storage failure");
        error.code = "database";
        throw error;
      }
      if (command === "load_project_session_meta") {
        metadataRefreshCalls += 1;
        throw new Error("metadata unavailable with storage");
      }
      return "";
    };
    useAppStore.setState({
      ...originalState,
      config: {
        ...originalState.config,
        language: "en",
        sessionRecordingEnabled: true,
      },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Memory fallback FIFO",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          storageStatus: "temporary",
          recordingDisabled: false,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 2,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      setActiveStudioAgentKey: async (agent) => {
        handlerAgents.push(agent);
        useAppStore.setState({ activeStudioAgentKey: agent });
      },
      sendMessage: (text, images, options) => {
        if (options?.turnIdOverride === receipts[0].turnId) {
          return realSendMessage(text, images, options);
        }
        if (options?.turnIdOverride === receipts[1].turnId) {
          nextHeadDispatchCalls += 1;
          // Make the next head fail synchronously after proving it reached the
          // dispatcher. Its standard fail-closed path supplies the conclusion.
          return false;
        }
        throw new Error(`unexpected FIFO Turn ${options?.turnIdOverride || "missing"}`);
      },
      // Keep this test focused on the terminal persistence boundary. The real
      // durable adapter is still exercised by persistSubmitRuntimeProjection.
      updateSession: () => {},
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = useAppStore.getState();
      if (
        current.workspaceTurnQueue?.entries.length === 0 &&
        nextHeadDispatchCalls === 1 &&
        metadataRefreshCalls >= 3
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const current = useAppStore.getState();
    const session = current.sessionsByWorkspace[workspace].find(
      (candidate) => candidate.id === sessionId,
    );
    assert.equal(saveCalls >= 1, true, "the real Project Session adapter is exercised");
    assert.equal(
      metadataRefreshCalls >= 3,
      true,
      "the permanent failure reaches the bounded retry/fallback path",
    );
    assert.deepEqual(handlerAgents, ["writer"], "the local side effect runs exactly once");
    assert.equal(nextHeadDispatchCalls, 1, "the next FIFO head advances exactly once");
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(session.storageStatus, "temporary");
    assert.equal(
      session.recordingDisabled,
      false,
      "temporary fallback must leave durable recording eligible for a later save",
    );
    for (const [index, receipt] of receipts.entries()) {
      const turn = current.conversationTurns.find((candidate) => candidate.id === receipt.turnId);
      assert.equal(turn.runtimeOutcome?.status, "completed");
      assert.equal(turn.runtimeOutcome?.resultKind, index === 0 ? "success" : "error");
      assert.equal(
        current.taskFlow.filter((block) =>
          block.turnId === receipt.turnId &&
          block.type === "agent" &&
          block.visibility === "assistant_final"
        ).length,
        1,
      );
      assert.equal(
        current.runtimeEvents.filter((event) =>
          event.type === "turn.completed" &&
          event.threadId === sessionKey &&
          event.turnId === receipt.turnId
        ).length,
        1,
      );
    }
  } finally {
    tauriInvoke = defaultTauriInvoke;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    useAppStore.setState(originalState, true);
  }
});

test("recording-disabled local-fast durable publication survives a real no-op updateSession", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const realUpdateSession = originalState.updateSession;
  const workspace = "/tmp/session-local-fast-real-update-session";
  const sessionId = 565;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-local-fast-real-update-session";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "real-update-session",
    56_501,
    { text: "/agent writer" },
  );
  const receipt = queue.entries[0].receipt;
  let resolveAgentSwitch;
  let agentSwitchStarted = 0;
  const pendingAgentSwitch = new Promise((resolve) => {
    resolveAgentSwitch = resolve;
  });

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, sessionRecordingEnabled: false },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Real updateSession local-fast",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          // rememberDurableState writes these exact values. The production
          // updateSession call must therefore be a semantic no-op without
          // replacing the opaque runtime revision token.
          storageStatus: "temporary",
          recordingDisabled: true,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      setActiveStudioAgentKey: async () => {
        agentSwitchStarted += 1;
        return pendingAgentSwitch;
      },
      sendMessage: realSendMessage,
      updateSession: realUpdateSession,
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    await waitForStoreState(() => agentSwitchStarted === 1);
    assert.equal(agentSwitchStarted, 1);
    assert.equal(useAppStore.getState().workspaceTurnQueue.entries[0].status, "dispatching");
    const ownerRevisionBeforeNoop = useAppStore.getState().runtimeBySessionKey[sessionKey];
    useAppStore.getState().updateSession(workspace, sessionId, {
      storageStatus: "temporary",
      recordingDisabled: true,
    });
    assert.equal(
      useAppStore.getState().runtimeBySessionKey[sessionKey],
      ownerRevisionBeforeNoop,
      "a no-op Session metadata write must preserve the opaque runtime revision token",
    );

    resolveAgentSwitch();
    await pendingAgentSwitch;
    const settled = await waitForStoreState((current) =>
      current.workspaceTurnQueue?.entries.length === 0 &&
      current.runtimeEvents.some((event) =>
        event.type === "turn.completed" &&
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId
      ),
      80,
    );
    const durableSession = settled.sessionsByWorkspace[workspace].find(
      (session) => session.id === sessionId,
    );
    const durableSnapshot = durableSession?.runtimeSnapshot?.snapshot ||
      durableSession?.runtimeSnapshot ||
      null;

    assert.equal(settled.workspaceTurnQueue.entries.length, 0);
    assert.equal(
      settled.runtimeEvents.filter((event) =>
        event.type === "turn.completed" &&
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId
      ).length,
      1,
    );
    assert.equal(
      settled.conversationTurns.find((turn) => turn.id === receipt.turnId)
        ?.runtimeOutcome?.resultKind,
      "success",
    );
    assert.equal(
      durableSnapshot.workspaceTurnQueue.entries[0].receipt.receiptId,
      receipt.receiptId,
      "the memory durability barrier retains the dispatching receipt on its terminal snapshot",
    );
    assert.equal(
      durableSnapshot.runtimeEvents.some((event) =>
        event.type === "turn.completed" &&
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId
      ),
      true,
    );
  } finally {
    resolveAgentSwitch?.();
    await pendingAgentSwitch.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    useAppStore.setState(originalState, true);
  }
});

test("session sync treats return-current-state updaters as no-ops while preserving explicit replace restores", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-sync-noop";
  const sessionId = 568;
  const sessionKey = `${workspace}:${sessionId}`;

  try {
    useAppStore.setState({
      ...originalState,
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Session sync no-op",
          date: "Today",
          active: true,
          planLifecycleEpoch: "epoch-session-sync-noop",
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
    }, true);
    // Seed the active Session's opaque runtime object through the middleware.
    useAppStore.setState({ isGenerating: false });
    const runtimeBeforeNoop = useAppStore.getState().runtimeBySessionKey[sessionKey];
    assert.ok(runtimeBeforeNoop);

    useAppStore.getState().removeSession("/missing-workspace", 999_999);
    assert.equal(
      useAppStore.getState().runtimeBySessionKey[sessionKey],
      runtimeBeforeNoop,
      "an updater returning the current Store must not mint a new runtime revision token",
    );

    const replacement = {
      ...useAppStore.getState(),
      currentWorkspace: null,
      currentSessionId: null,
      input: "replace=true restore survived",
    };
    useAppStore.setState(replacement, true);
    assert.equal(useAppStore.getState().input, "replace=true restore survived");
    assert.equal(useAppStore.getState().currentWorkspace, null);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("workspace local-fast completion settles captured Session A after the UI switches to B", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const workspace = "/tmp/session-local-fast-owner-switch";
  const sessionAId = 566;
  const sessionBId = 567;
  const sessionAKey = `${workspace}:${sessionAId}`;
  const sessionBKey = `${workspace}:${sessionBId}`;
  const sessionEpoch = "epoch-local-fast-owner-switch";
  const firstQueue = buildQueuedWorkspaceTurn(
    sessionAKey,
    sessionEpoch,
    "owner-switch-a",
    56_601,
    { text: "/agent writer" },
  );
  const queue = appendQueuedWorkspaceTurn(
    firstQueue,
    "owner-switch-a-next",
    56_602,
    { text: "/auto" },
  );
  const receipt = queue.entries[0].receipt;
  let agentSwitchStarted = 0;
  let resolveAgentSwitch;
  const pendingAgentSwitch = new Promise((resolve) => {
    resolveAgentSwitch = resolve;
  });

  const bTaskFlow = [{
    id: 56_700,
    turnId: "turn-b-visible",
    type: "user",
    content: "B remains visible",
  }];
  const bConversationTurns = [{
    id: "turn-b-visible",
    userPrompt: "B remains visible",
    title: "Session B",
    mode: "chat",
    intent: "respond",
    displayIntent: "respond",
    status: "done",
    summary: "B unchanged",
    blockIds: [56_700],
    collapsed: false,
    createdAt: 100,
  }];

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, sessionRecordingEnabled: false },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionAId,
      activeSessionByWorkspace: { [workspace]: sessionAId },
      sessionsByWorkspace: {
        [workspace]: [
          {
            id: sessionAId,
            title: "Local-fast owner A",
            date: "Today",
            active: true,
            planLifecycleEpoch: sessionEpoch,
            recordingDisabled: true,
            messages: [],
          },
          {
            id: sessionBId,
            title: "Visible B",
            date: "Today",
            active: false,
            planLifecycleEpoch: "epoch-owner-switch-b",
            recordingDisabled: true,
            messages: bTaskFlow,
          },
        ],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 2,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      setActiveStudioAgentKey: async () => {
        agentSwitchStarted += 1;
        return pendingAgentSwitch;
      },
      sendMessage: realSendMessage,
      updateSession: () => {},
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionAKey), true);
    await waitForStoreState(() => agentSwitchStarted === 1);
    const runningA = useAppStore.getState();
    assert.equal(agentSwitchStarted, 1);
    assert.ok(runningA.runtimeBySessionKey[sessionAKey]);
    const bRuntime = {
      ...runningA.runtimeBySessionKey[sessionAKey],
      taskFlow: bTaskFlow,
      conversationTurns: bConversationTurns,
      runtimeEvents: [],
      currentTurnId: "turn-b-visible",
      workspaceTurnQueue: null,
      workspaceInstructionLedger: [],
      isGenerating: false,
      agentStatus: "idle",
      abortController: null,
    };
    useAppStore.setState((current) => ({
      currentSessionId: sessionBId,
      activeSessionByWorkspace: { [workspace]: sessionBId },
      runtimeBySessionKey: {
        ...current.runtimeBySessionKey,
        [sessionBKey]: bRuntime,
      },
      taskFlow: bTaskFlow,
      conversationTurns: bConversationTurns,
      runtimeEvents: [],
      currentTurnId: "turn-b-visible",
      workspaceTurnQueue: null,
      workspaceInstructionLedger: [],
      isGenerating: false,
      agentStatus: "idle",
      abortController: null,
    }));

    resolveAgentSwitch();
    await pendingAgentSwitch;
    const settled = await waitForStoreState((current) => {
      const owner = current.runtimeBySessionKey[sessionAKey];
      return !!owner &&
        owner.workspaceTurnQueue?.entries.length === 1 &&
        owner.workspaceTurnQueue.entries[0].receipt.receiptId ===
          "receipt-owner-switch-a-next" &&
        owner.abortController === null;
    });
    const ownerA = settled.runtimeBySessionKey[sessionAKey];

    assert.equal(settled.currentSessionId, sessionBId);
    assert.equal(settled.currentTurnId, "turn-b-visible");
    assert.deepEqual(settled.taskFlow, bTaskFlow);
    assert.deepEqual(settled.conversationTurns, bConversationTurns);
    assert.deepEqual(settled.runtimeEvents, []);
    assert.equal(settled.workspaceTurnQueue, null);
    assert.equal(settled.agentStatus, "idle");
    assert.equal(settled.isGenerating, false);
    assert.equal(agentSwitchStarted, 1, "background A must not dispatch its next FIFO item");
    assert.equal(ownerA.workspaceTurnQueue.entries.length, 1);
    assert.equal(
      ownerA.workspaceTurnQueue.entries[0].receipt.receiptId,
      "receipt-owner-switch-a-next",
    );
    assert.equal(
      ownerA.runtimeEvents.filter((event) =>
        event.type === "turn.completed" &&
        event.threadId === sessionAKey &&
        event.turnId === receipt.turnId
      ).length,
      1,
    );
    assert.equal(
      ownerA.conversationTurns.find((turn) => turn.id === receipt.turnId)
        ?.runtimeOutcome?.resultKind,
      "success",
    );
    assert.equal(ownerA.abortController, null);
    assert.equal(ownerA.isGenerating, false);
    assert.equal(ownerA.agentStatus, "idle");
  } finally {
    resolveAgentSwitch?.();
    await pendingAgentSwitch.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    useAppStore.setState(originalState, true);
  }
});

test("workspace local-fast cleanup does not reset a same-turn-id replacement owner", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const workspace = "/tmp/session-local-fast-same-id-replacement";
  const sessionId = 568;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-local-fast-same-id-replacement";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "same-id-replacement",
    56_801,
    { text: "/agent writer" },
  );
  const receipt = queue.entries[0].receipt;
  let resolveAgentSwitch;
  let agentSwitchStarted = 0;
  const pendingAgentSwitch = new Promise((resolve) => {
    resolveAgentSwitch = resolve;
  });

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, sessionRecordingEnabled: false },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Same-ID replacement",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          recordingDisabled: true,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      setActiveStudioAgentKey: async () => {
        agentSwitchStarted += 1;
        return pendingAgentSwitch;
      },
      sendMessage: realSendMessage,
      updateSession: () => {},
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    await waitForStoreState(() => agentSwitchStarted === 1);
    const running = useAppStore.getState();
    const originalController = running.abortController;
    const admittedTurn = running.conversationTurns.find(
      (turn) => turn.id === receipt.turnId,
    );
    assert.ok(originalController);
    assert.equal(admittedTurn.clientSubmissionId, receipt.clientSubmissionId);
    assert.equal(admittedTurn.workspaceInstructionReceiptId, receipt.receiptId);

    useAppStore.setState((current) => ({
      taskFlow: current.taskFlow.map((block) =>
        block.id === receipt.userBlockId
          ? { ...block, content: "replacement owner" }
          : block
      ),
      conversationTurns: current.conversationTurns.map((turn) =>
        turn.id === receipt.turnId
          ? {
              ...turn,
              clientSubmissionId: "submission-replacement-owner",
              workspaceInstructionReceiptId: "receipt-replacement-owner",
              userPrompt: "replacement owner",
              status: "executing",
              summary: "",
              runtimeOutcome: undefined,
            }
          : turn
      ),
      currentTurnId: receipt.turnId,
      isGenerating: true,
      agentStatus: "running",
      // Deliberately retain the same controller: immutable admission identity,
      // not controller equality, must fence the old completion's UI cleanup.
      abortController: originalController,
    }));

    resolveAgentSwitch();
    await pendingAgentSwitch;
    const settled = await waitForStoreState((current) =>
      current.workspaceTurnQueue?.entries.length === 0 &&
      current.conversationTurns.some((turn) =>
        turn.id.startsWith("local-slash-recovery-") &&
        turn.runtimeOutcome?.status === "completed"
      )
    );
    const replacement = settled.conversationTurns.find(
      (turn) => turn.id === receipt.turnId,
    );
    const recoveryTurns = settled.conversationTurns.filter((turn) =>
      turn.id.startsWith("local-slash-recovery-") &&
      turn.runtimeOutcome?.status === "completed"
    );

    assert.equal(settled.workspaceTurnQueue.entries.length, 0);
    assert.equal(replacement.clientSubmissionId, "submission-replacement-owner");
    assert.equal(replacement.workspaceInstructionReceiptId, "receipt-replacement-owner");
    assert.equal(replacement.runtimeOutcome, undefined);
    assert.equal(recoveryTurns.length, 1);
    assert.equal(recoveryTurns[0].runtimeOutcome.resultKind, "error");
    assert.equal(settled.currentTurnId, receipt.turnId);
    assert.equal(settled.abortController, originalController);
    assert.equal(settled.isGenerating, true);
    assert.equal(settled.agentStatus, "running");
    assert.equal(
      settled.runtimeEvents.filter((event) =>
        event.type === "run.completed" &&
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId
      ).length,
      1,
      "the original Run is closed without assigning the replacement a Turn terminal",
    );
    assert.equal(
      settled.runtimeEvents.some((event) =>
        event.type === "turn.completed" &&
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId
      ),
      false,
    );
  } finally {
    resolveAgentSwitch?.();
    await pendingAgentSwitch.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    useAppStore.setState(originalState, true);
  }
});

test("workspace local-fast owner loss releases transient maps after completion rejection", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const workspace = "/tmp/session-local-fast-owner-loss";
  const sessionId = 569;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-local-fast-owner-loss";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "owner-loss",
    56_901,
    { text: "/agent writer" },
  );
  let resolveAgentSwitch;
  let agentSwitchStarted = 0;
  const pendingAgentSwitch = new Promise((resolve) => {
    resolveAgentSwitch = resolve;
  });

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, sessionRecordingEnabled: false },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Local-fast owner loss",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          recordingDisabled: true,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      setActiveStudioAgentKey: async () => {
        agentSwitchStarted += 1;
        return pendingAgentSwitch;
      },
      sendMessage: realSendMessage,
      updateSession: () => {},
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    await waitForStoreState(() => agentSwitchStarted === 1);
    useAppStore.setState((current) => {
      const runtimeBySessionKey = { ...current.runtimeBySessionKey };
      delete runtimeBySessionKey[sessionKey];
      return {
        runtimeBySessionKey,
        sessionsByWorkspace: { ...current.sessionsByWorkspace, [workspace]: [] },
      };
    });

    resolveAgentSwitch();
    await pendingAgentSwitch;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(getPendingSessionCancellation(sessionKey), null);

    // Once the durable helper rejects with owner loss, the dispatcher must
    // release only its transient lease maps. A subsequent Stop therefore takes
    // the generic replacement/deletion path and creates a cancellation fence;
    // a leaked local-fast map would intercept this call and return early.
    useAppStore.getState().stopGeneration();
    const cancellation = getPendingSessionCancellation(sessionKey);
    assert.ok(cancellation, "owner-loss rejection must not leave a stale local-fast lease map");
    await cancellation.promise;
  } finally {
    resolveAgentSwitch?.();
    await pendingAgentSwitch.catch(() => {});
    const cancellation = getPendingSessionCancellation(sessionKey);
    await cancellation?.promise.catch(() => {});
    useAppStore.setState(originalState, true);
  }
});

test("stopGeneration cancels a workspace local-fast Turn before its deferred side-effect commit", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const workspace = "/tmp/session-local-fast-cancel";
  const sessionId = 557;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-local-fast-cancel";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "local-fast-cancel",
    55_701,
    { text: "/agent writer" },
  );
  const receipt = queue.entries[0].receipt;
  let agentSwitchCommits = 0;

  try {
    useAppStore.setState({
      ...originalState,
      config: {
        ...originalState.config,
        language: "en",
        sessionRecordingEnabled: false,
      },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Local-fast cancellation",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          recordingDisabled: true,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      imageStudio: {
        ...originalState.imageStudio,
        activeJobId: null,
        activeStreamId: null,
      },
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      setActiveStudioAgentKey: async () => {
        agentSwitchCommits += 1;
      },
      sendMessage: realSendMessage,
      updateSession: () => {},
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    const admitted = useAppStore.getState();
    assert.equal(admitted.currentTurnId, receipt.turnId);
    assert.equal(admitted.workspaceTurnQueue.entries.length, 1);
    assert.equal(admitted.workspaceTurnQueue.entries[0].status, "dispatching");
    assert.equal(admitted.isGenerating, true);

    // startGameStudioLocalSlashSubmission deliberately defers the side-effect
    // commit by one microtask so the production lease and AbortController are
    // installed first. Cancel in this same call stack, before yielding.
    useAppStore.getState().stopGeneration();
    assert.equal(agentSwitchCommits, 0);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const current = useAppStore.getState();
      if (
        current.workspaceTurnQueue?.entries.length === 0 &&
        current.runtimeEvents.some((event) =>
          event.type === "turn.completed" &&
          event.threadId === sessionKey &&
          event.turnId === receipt.turnId
        )
      ) break;
    }

    const current = useAppStore.getState();
    const originalTurns = current.conversationTurns.filter(
      (turn) => turn.id === receipt.turnId,
    );
    const assistantFinals = current.taskFlow.filter((block) =>
      block.turnId === receipt.turnId &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
    );
    const cancellationLifecycle = current.runtimeEvents.filter((event) =>
      event.threadId === sessionKey &&
      event.turnId === receipt.turnId &&
      (
        event.type === "run.aborted" ||
        event.type === "run.completed" ||
        event.type === "turn.completed"
      )
    );

    assert.equal(agentSwitchCommits, 0, "cancellation must win before the local side effect");
    assert.equal(current.activeStudioAgentKey, "studio_auto");
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(originalTurns.length, 1);
    assert.equal(originalTurns[0].runtimeOutcome?.status, "completed");
    assert.equal(originalTurns[0].runtimeOutcome?.resultKind, "canceled");
    assert.equal(assistantFinals.length, 1);
    assert.match(assistantFinals[0].content, /canceled/i);
    assert.deepEqual(
      cancellationLifecycle.map((event) => event.type),
      ["run.aborted", "run.completed", "turn.completed"],
    );
    assert.equal(cancellationLifecycle[1]?.resultKind, "canceled");
    assert.equal(cancellationLifecycle[2]?.resultKind, "canceled");
    assert.deepEqual(
      current.conversationTurns.map((turn) => turn.id),
      [receipt.turnId],
      "cancellation must not fabricate a recovery error Turn",
    );
    assert.equal(
      current.conversationTurns.some((turn) =>
        turn.runtimeOutcome?.resultKind === "error" ||
        turn.id.startsWith("local-slash-recovery-")
      ),
      false,
    );
  } finally {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    useAppStore.setState(originalState, true);
  }
});

test("late cancellation reconciliation cannot cancel a successor Run on the same Turn", async () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-cancel-successor";
  const sessionId = 558;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-cancel-successor";
  const turnId = "turn-cancel-successor";
  const oldRunId = "run-old-owner";
  const successorRunId = "run-successor-owner";
  const oldController = new AbortController();
  const successorController = new AbortController();
  const oldRequest = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId: oldRunId,
    title: "Old request",
    optionValues: ["Continue"],
    allowCustomReply: true,
    now: 1,
  });
  const successorRequest = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId: successorRunId,
    title: "Successor request",
    optionValues: ["Continue successor"],
    allowCustomReply: true,
    now: 2,
  });
  const oldMarker = {
    schemaVersion: 1,
    instanceId: "instance-cancel-successor",
    sessionKey,
    workspace,
    sessionId,
    turnId,
    runId: oldRunId,
    activeRunId: oldRunId,
    activeParentRunId: null,
    parentRunId: null,
    status: "running",
    planStage: "idle",
    isPlanApproved: false,
    startedAt: 1,
    updatedAt: 1,
    closedAt: null,
    closeReason: null,
  };
  const successorMarker = {
    ...oldMarker,
    runId: successorRunId,
    activeRunId: successorRunId,
    startedAt: 2,
    updatedAt: 2,
  };

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, sessionRecordingEnabled: false },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Cancellation successor",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          recordingDisabled: true,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      currentTurnId: turnId,
      conversationTurns: [{
        id: turnId,
        userPrompt: "Run and then stop",
        title: "Cancellation successor",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "executing",
        summary: "",
        blockIds: [1],
        collapsed: false,
        createdAt: 1,
      }],
      taskFlow: [{ id: 1, turnId, type: "user", content: "Run and then stop" }],
      runtimeEvents: [{
        schemaVersion: 2,
        type: "run.started",
        threadId: sessionKey,
        turnId,
        timestampMs: 1,
        runId: oldRunId,
        parentRunId: null,
      }],
      harnessRunMarker: oldMarker,
      activeActionRequest: oldRequest,
      abortController: oldController,
      isGenerating: true,
      agentStatus: "running",
      pendingReviewResolve: () => {},
      pendingReviewTaskId: null,
      pendingToolCall: null,
    }, true);

    assert.equal(useAppStore.getState().closeTurnAsCanceled(turnId, {
      reason: "late_user_cancelled",
      message: "Old run canceled.",
    }), true);
    const cancellation = getPendingSessionCancellation(sessionKey);
    assert.ok(cancellation);

    useAppStore.setState((state) => ({
      harnessRunMarker: successorMarker,
      activeActionRequest: successorRequest,
      abortController: successorController,
      isGenerating: true,
      agentStatus: "running",
      pendingReviewResolve: () => {},
      pendingReviewTaskId: null,
      pendingToolCall: null,
      runtimeEvents: [
        ...state.runtimeEvents,
        {
          schemaVersion: 2,
          type: "run.started",
          threadId: sessionKey,
          turnId,
          timestampMs: 2,
          runId: successorRunId,
          parentRunId: null,
        },
      ],
    }));

    const settlement = await cancellation.promise;
    const current = useAppStore.getState();
    assert.equal(settlement.terminalSettled, false);
    assert.equal(settlement.disposition, "reconciliation_exhausted:owner_transferred");
    assert.equal(current.abortController, successorController);
    assert.equal(current.harnessRunMarker, successorMarker);
    assert.equal(current.activeActionRequest, successorRequest);
    assert.equal(current.isGenerating, true);
    assert.equal(current.agentStatus, "running");
    assert.equal(current.runtimeEvents.filter((event) =>
      event.threadId === sessionKey &&
      event.turnId === turnId &&
      (
        event.type === "run.aborted" ||
        event.type === "run.completed" ||
        event.type === "turn.completed"
      )
    ).length, 0);
    assert.equal(current.taskFlow.some((block) =>
      block.turnId === turnId && block.visibility === "assistant_final"
    ), false);
  } finally {
    const cancellation = getPendingSessionCancellation(sessionKey);
    await cancellation?.promise.catch(() => {});
    useAppStore.setState(originalState, true);
  }
});

test("already-closed reconciliation restores a missing success final after control cleanup", async () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-terminal-final-repair";
  const sessionId = 559;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-terminal-final-repair";
  const turnId = "turn-terminal-final-repair";
  const runId = "run-terminal-final-repair";
  const controller = new AbortController();
  const successSummary = "The requested work completed successfully.";

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, language: "en", sessionRecordingEnabled: false },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Terminal final repair",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          recordingDisabled: true,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      currentTurnId: turnId,
      conversationTurns: [{
        id: turnId,
        userPrompt: "Complete the work",
        title: "Terminal final repair",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "done",
        summary: successSummary,
        blockIds: [1],
        collapsed: false,
        createdAt: 1,
        runtimeOutcome: {
          status: "completed",
          resultKind: "success",
          reason: "agent_loop_completed",
          runId,
          parentRunId: null,
          updatedAt: 3,
        },
      }],
      taskFlow: [{ id: 1, turnId, type: "user", content: "Complete the work" }],
      runtimeEvents: [
        {
          schemaVersion: 2,
          type: "run.started",
          threadId: sessionKey,
          turnId,
          timestampMs: 1,
          runId,
          parentRunId: null,
        },
        {
          schemaVersion: 2,
          type: "run.completed",
          threadId: sessionKey,
          turnId,
          timestampMs: 2,
          runId,
          parentRunId: null,
          resultKind: "success",
          summary: successSummary,
        },
        {
          schemaVersion: 2,
          type: "turn.completed",
          threadId: sessionKey,
          turnId,
          timestampMs: 3,
          resultKind: "success",
        },
      ],
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: "instance-terminal-final-repair",
        sessionKey,
        workspace,
        sessionId,
        turnId,
        runId,
        activeRunId: runId,
        activeParentRunId: null,
        parentRunId: null,
        status: "running",
        planStage: "idle",
        isPlanApproved: false,
        startedAt: 1,
        updatedAt: 1,
        closedAt: null,
        closeReason: null,
      },
      activeActionRequest: null,
      abortController: controller,
      isGenerating: true,
      agentStatus: "running",
    }, true);

    assert.equal(useAppStore.getState().closeTurnAsCanceled(turnId, {
      reason: "late_user_cancelled",
      message: "This cancellation text must not become the final.",
    }), true);
    const cancellation = getPendingSessionCancellation(sessionKey);
    assert.ok(cancellation);
    const settlement = await cancellation.promise;
    const current = useAppStore.getState();
    const finalBlocks = current.taskFlow.filter((block) =>
      block.turnId === turnId &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
    );

    assert.equal(settlement.terminalSettled, true);
    assert.equal(finalBlocks.length, 1);
    assert.equal(finalBlocks[0].content, successSummary);
    assert.doesNotMatch(finalBlocks[0].content, /cancel/i);
    assert.equal(current.abortController, null);
    assert.equal(current.isGenerating, false);
    assert.equal(current.agentStatus, "idle");
    assert.equal(current.harnessRunMarker?.status, "completed");
    assert.equal(current.harnessRunMarker?.closeReason, "agent_loop_completed");
    assert.deepEqual(current.runtimeEvents.map((event) => event.type), [
      "run.started",
      "run.completed",
      "turn.completed",
    ]);
    assert.equal(current.runtimeEvents[1]?.resultKind, "success");
    assert.equal(current.runtimeEvents[2]?.resultKind, "success");
  } finally {
    const cancellation = getPendingSessionCancellation(sessionKey);
    await cancellation?.promise.catch(() => {});
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher quarantines a live lost-lease local-fast head without rerunning its handler", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-local-fast-live-lost-lease";
  const sessionId = 558;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-local-fast-live-lost-lease";
  const queue = buildDispatchingWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "local-fast-live-lost-lease",
    55_801,
    { text: "/agent writer" },
  );
  const receipt = queue.entries[0].receipt;
  const runId = "run-local-fast-live-lost-lease";
  let handlerCalls = 0;

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, language: "en" },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Lost local-fast lease",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          recordingDisabled: true,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [{
        id: receipt.userBlockId,
        turnId: receipt.turnId,
        type: "user",
        content: "/agent writer",
      }],
      conversationTurns: [{
        id: receipt.turnId,
        clientSubmissionId: receipt.clientSubmissionId,
        workspaceInstructionReceiptId: receipt.receiptId,
        workspaceInstructionSource: queue.entries[0].instruction.source,
        userPrompt: "/agent writer",
        title: "Switch specialist",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "executing",
        summary: "",
        blockIds: [receipt.userBlockId],
        collapsed: false,
        createdAt: receipt.acceptedAt,
      }],
      runtimeEvents: [{
        schemaVersion: 2,
        type: "run.started",
        threadId: sessionKey,
        turnId: receipt.turnId,
        timestampMs: 12,
        runId,
        parentRunId: null,
      }],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      abortController: null,
      harnessRunMarker: null,
      sendMessage: () => {
        handlerCalls += 1;
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(
      useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey),
      false,
    );
    const current = useAppStore.getState();
    const turn = current.conversationTurns.find((candidate) => candidate.id === receipt.turnId);
    const finals = current.taskFlow.filter((block) =>
      block.turnId === receipt.turnId &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
    );

    assert.equal(handlerCalls, 0, "a lost local-fast lease must never replay the side effect");
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(turn.runtimeOutcome?.status, "completed");
    assert.equal(turn.runtimeOutcome?.resultKind, "error");
    assert.equal(finals.length, 1);
    assert.equal(finals[0].content, turn.summary);
    assert.deepEqual(
      current.runtimeEvents.filter((event) =>
        event.threadId === sessionKey &&
        event.turnId === receipt.turnId &&
        (event.type === "run.completed" || event.type === "turn.completed")
      ).map((event) => event.type),
      ["run.completed", "turn.completed"],
    );
    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), false);
    assert.equal(handlerCalls, 0);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher closes a poisoned paged head with a visible error before advancing FIFO", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-paged-conflict";
  const sessionId = 606;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-paged-conflict";
  const queue = buildQueuedWorkspaceTurn(sessionKey, sessionEpoch, "conflict-head");
  const receipt = queue.entries[0].receipt;
  let sendCalled = false;

  try {
    useAppStore.setState({
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Paged conflict",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      taskFlow: [{
        id: receipt.userBlockId,
        turnId: "unrelated-turn",
        type: "user",
        content: "unrelated history",
      }],
      conversationTurns: [{
        id: "unrelated-turn",
        userPrompt: "unrelated history",
        title: "Unrelated",
        mode: "chat",
        intent: "respond",
        displayIntent: "respond",
        status: "done",
        summary: "done",
        blockIds: [receipt.userBlockId],
        collapsed: false,
        createdAt: 100,
      }],
      runtimeEvents: [],
      transcriptPartial: true,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 2,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: () => {
        sendCalled = true;
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    });

    const dispatched = useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey);
    const current = useAppStore.getState();
    const recoveryTurn = current.conversationTurns.find((turn) =>
      turn.id.startsWith(`workspace-recovery-${receipt.receiptId}`)
    );
    const recoveryBlocks = current.taskFlow.filter(
      (block) => block.turnId === recoveryTurn?.id,
    );

    assert.equal(dispatched, true);
    assert.equal(sendCalled, false, "conflicting history must never be adopted");
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(recoveryTurn.status, "error");
    assert.equal(recoveryTurn.runtimeOutcome.status, "completed");
    assert.equal(recoveryTurn.runtimeOutcome.resultKind, "error");
    assert.equal(recoveryBlocks.some((block) => block.type === "user"), true);
    assert.equal(
      recoveryBlocks.some((block) =>
        block.type === "agent" && block.visibility === "assistant_final"
      ),
      true,
    );
    assert.equal(
      current.runtimeEvents.some((event) =>
        event.type === "turn.completed" &&
        event.turnId === recoveryTurn.id &&
        event.resultKind === "error"
      ),
      true,
    );
    const recoveryRunEvents = current.runtimeEvents.filter((event) =>
      "turnId" in event &&
      event.turnId === recoveryTurn.id &&
      (event.type === "run.started" || event.type === "run.completed")
    );
    assert.deepEqual(
      recoveryRunEvents.map((event) => event.type),
      ["run.started", "run.completed"],
    );
    assert.equal(recoveryRunEvents[0].runId, recoveryTurn.runtimeOutcome.runId);
    assert.equal(recoveryRunEvents[1].runId, recoveryTurn.runtimeOutcome.runId);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher retires an exact terminal race and advances FIFO without duplicating its conclusion", async () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-terminal-race";
  const sessionId = 607;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-terminal-race";
  let queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "terminal-race-first",
    61_001,
  );
  const firstEntry = queue.entries[0];
  const secondReceipt = {
    schemaVersion: 1,
    kind: "workspace_turn_receipt",
    receiptId: "receipt-terminal-race-second",
    clientSubmissionId: "submission-terminal-race-second",
    sessionKey,
    sessionEpoch,
    turnId: "turn-terminal-race-second",
    userBlockId: 61_002,
    acceptedAt: 20,
  };
  const secondInstruction = {
    schemaVersion: 1,
    kind: "workspace_instruction",
    clientSubmissionId: secondReceipt.clientSubmissionId,
    sessionKey,
    sessionEpoch,
    source: "composer",
    submittedAt: 20,
    payload: { text: "queued terminal-race-second" },
  };
  const appended = reduceWorkspaceTurnQueue(queue, {
    type: "append",
    expectedVersion: queue.version,
    at: 20,
    instruction: secondInstruction,
    receipt: secondReceipt,
  });
  assert.equal(appended.disposition, "applied", appended.reason);
  const committed = reduceWorkspaceTurnQueue(appended.state, {
    type: "commit",
    expectedVersion: appended.state.version,
    at: 21,
    clientSubmissionId: secondReceipt.clientSubmissionId,
    receiptId: secondReceipt.receiptId,
    sessionKey,
    sessionEpoch,
  });
  assert.equal(committed.disposition, "applied", committed.reason);
  queue = committed.state;

  const firstRunId = "run-terminal-race-first";
  const firstSummary = "The exact admitted Turn already completed.";
  const firstFinalBlockId = 61_003;
  const saveCheckpoints = [];
  const sendCounts = new Map();

  try {
    useAppStore.setState({
      ...originalState,
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Terminal race",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [{
        id: firstEntry.receipt.userBlockId,
        turnId: firstEntry.receipt.turnId,
        type: "user",
        content: firstEntry.instruction.payload.text,
      }],
      conversationTurns: [{
        id: firstEntry.receipt.turnId,
        clientSubmissionId: firstEntry.instruction.clientSubmissionId,
        workspaceInstructionReceiptId: firstEntry.receipt.receiptId,
        workspaceInstructionSource: firstEntry.instruction.source,
        userPrompt: firstEntry.instruction.payload.text,
        title: "Terminal race first",
        mode: "chat",
        intent: "respond",
        displayIntent: "respond",
        status: "executing",
        summary: "",
        blockIds: [firstEntry.receipt.userBlockId],
        processCollapsed: false,
        collapsed: false,
        createdAt: firstEntry.receipt.acceptedAt,
      }],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 2,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: (_text, _images, options) => {
        const turnId = options?.turnIdOverride;
        sendCounts.set(turnId, (sendCounts.get(turnId) || 0) + 1);
        if (turnId === firstEntry.receipt.turnId) {
          const timestampMs = 30;
          let events = turnEvents.appendRuntimeEvent(
            useAppStore.getState().runtimeEvents,
            turnEvents.withEventSchema({
              type: "run.started",
              threadId: sessionKey,
              turnId,
              timestampMs,
              runId: firstRunId,
              parentRunId: null,
            }),
          );
          events = turnEvents.appendRuntimeEvent(events, turnEvents.withEventSchema({
            type: "run.completed",
            threadId: sessionKey,
            turnId,
            timestampMs,
            runId: firstRunId,
            parentRunId: null,
            resultKind: "success",
            summary: firstSummary,
          }));
          events = turnEvents.appendRuntimeEvent(events, turnEvents.withEventSchema({
            type: "turn.completed",
            threadId: sessionKey,
            turnId,
            timestampMs,
            resultKind: "success",
          }));
          useAppStore.setState((current) => ({
            runtimeEvents: events,
            taskFlow: [...current.taskFlow, {
              id: firstFinalBlockId,
              turnId,
              type: "agent",
              content: firstSummary,
              streaming: false,
              visibility: "assistant_final",
            }],
            conversationTurns: current.conversationTurns.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    status: "done",
                    summary: firstSummary,
                    blockIds: [...turn.blockIds, firstFinalBlockId],
                    runtimeOutcome: {
                      status: "completed",
                      reason: "terminal_race_fixture",
                      resultKind: "success",
                      runId: firstRunId,
                      parentRunId: null,
                      updatedAt: timestampMs,
                    },
                  }
                : turn
            ),
          }));
          return false;
        }
        useAppStore.setState({ currentTurnId: turnId });
        return true;
      },
      saveCurrentRuntimeToSession: () => {
        saveCheckpoints.push(
          (useAppStore.getState().workspaceTurnQueue?.entries || []).map(
            (entry) => entry.receipt.receiptId,
          ),
        );
      },
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const current = useAppStore.getState();
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(sendCounts.get(firstEntry.receipt.turnId), 1);
    assert.equal(sendCounts.get(secondReceipt.turnId), 1);
    assert.deepEqual(saveCheckpoints, [[secondReceipt.receiptId], []]);
    assert.equal(
      current.runtimeEvents.filter((event) =>
        event.type === "run.started" && event.turnId === firstEntry.receipt.turnId
      ).length,
      1,
    );
    assert.equal(
      current.runtimeEvents.filter((event) =>
        event.type === "run.completed" && event.turnId === firstEntry.receipt.turnId
      ).length,
      1,
    );
    assert.equal(
      current.runtimeEvents.filter((event) =>
        event.type === "turn.completed" && event.turnId === firstEntry.receipt.turnId
      ).length,
      1,
    );
    assert.equal(
      current.taskFlow.filter((block) =>
        block.type === "agent" &&
        block.turnId === firstEntry.receipt.turnId &&
        block.visibility === "assistant_final"
      ).length,
      1,
    );
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher fails closed an aged starting claim and advances the next FIFO Turn exactly once", async () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-aged-starting-claim";
  const sessionId = 611;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-aged-starting-claim";
  let queue = buildDispatchingWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "aged-starting-first",
    61_401,
  );
  queue = appendQueuedWorkspaceTurn(
    queue,
    "aged-starting-second",
    61_402,
  );
  const [firstEntry, secondEntry] = queue.entries;
  const projection = buildExactWorkspaceInstructionProjection(firstEntry);
  const sendCounts = new Map();
  const dispatchQueueHeads = [];

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, language: "en" },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Aged starting claim",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      ...projection,
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 2,
      isGenerating: true,
      agentStatus: "running",
      currentTurnId: firstEntry.receipt.turnId,
      abortController: null,
      harnessRunMarker: null,
      sendMessage: (_text, _images, options) => {
        const turnId = options?.turnIdOverride;
        sendCounts.set(turnId, (sendCounts.get(turnId) || 0) + 1);
        dispatchQueueHeads.push(
          useAppStore.getState().workspaceTurnQueue?.entries.map(
            (entry) => entry.receipt.turnId,
          ) || [],
        );
        useAppStore.setState({
          currentTurnId: turnId,
          isGenerating: true,
          agentStatus: "running",
        });
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    }, true);

    useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey);
    const settled = await waitForStoreState((state) =>
      sendCounts.get(secondEntry.receipt.turnId) === 1 &&
      state.workspaceTurnQueue?.entries.length === 0
    );
    const firstTurn = settled.conversationTurns.find(
      (turn) => turn.id === firstEntry.receipt.turnId,
    );
    const firstFinals = settled.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === firstEntry.receipt.turnId &&
      block.visibility === "assistant_final"
    );
    const firstLifecycle = settled.runtimeEvents.filter((event) =>
      "turnId" in event && event.turnId === firstEntry.receipt.turnId
    );

    assert.equal(sendCounts.get(firstEntry.receipt.turnId) || 0, 0);
    assert.equal(sendCounts.get(secondEntry.receipt.turnId), 1);
    assert.deepEqual(dispatchQueueHeads, [[secondEntry.receipt.turnId]]);
    assert.equal(settled.workspaceTurnQueue.entries.length, 0);
    assert.equal(firstTurn?.runtimeOutcome?.status, "completed");
    assert.equal(firstTurn?.runtimeOutcome?.resultKind, "error");
    assert.match(firstTurn?.summary || "", /stale dispatch claim|visible error/i);
    assert.equal(firstFinals.length, 1);
    assert.equal(firstFinals[0].content, firstTurn?.summary);
    assert.deepEqual(firstLifecycle.map((event) => event.type), [
      "run.started",
      "run.completed",
      "turn.completed",
    ]);
    assert.equal(firstLifecycle[1]?.resultKind, "error");
    assert.equal(firstLifecycle[2]?.resultKind, "error");
  } finally {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher gives a fresh exact starting claim one retry before failing closed", async () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-fresh-starting-claim";
  const sessionId = 612;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-fresh-starting-claim";
  const queued = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "fresh-starting",
    61_501,
  );
  const claimed = reduceWorkspaceTurnQueue(queued, {
    type: "claim",
    expectedVersion: queued.version,
    at: Date.now(),
    claimId: "claim-fresh-starting",
    sessionKey,
    sessionEpoch,
  });
  assert.equal(claimed.disposition, "applied", claimed.reason);
  const queue = claimed.state;
  const entry = queue.entries[0];
  const projection = buildExactWorkspaceInstructionProjection(entry);
  const originalDispatcher = originalState.dispatchNextWorkspaceInstruction;
  let scheduledRetryCalls = 0;
  let saveCalls = 0;

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, language: "en" },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Fresh starting claim",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      ...projection,
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 1,
      isGenerating: true,
      agentStatus: "running",
      currentTurnId: entry.receipt.turnId,
      abortController: null,
      harnessRunMarker: null,
      dispatchNextWorkspaceInstruction: (...args) => {
        scheduledRetryCalls += 1;
        return originalDispatcher(...args);
      },
      sendMessage: () => {
        assert.fail("a claimed starting Turn must not be replayed");
      },
      saveCurrentRuntimeToSession: () => {
        saveCalls += 1;
      },
    }, true);

    assert.equal(originalDispatcher(sessionKey), false);
    const immediate = useAppStore.getState();
    assert.equal(scheduledRetryCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(immediate.workspaceTurnQueue.entries.length, 1);
    assert.equal(immediate.workspaceTurnQueue.entries[0].status, "dispatching");
    assert.equal(
      immediate.runtimeEvents.some((event) =>
        event.type === "turn.completed" && event.turnId === entry.receipt.turnId
      ),
      false,
    );
    assert.equal(
      immediate.taskFlow.some((block) =>
        block.type === "agent" &&
        block.turnId === entry.receipt.turnId &&
        block.visibility === "assistant_final"
      ),
      false,
    );

    const settled = await waitForStoreState((state) =>
      state.workspaceTurnQueue?.entries.length === 0
    );
    const turn = settled.conversationTurns.find(
      (candidate) => candidate.id === entry.receipt.turnId,
    );
    assert.equal(scheduledRetryCalls, 1);
    assert.equal(saveCalls, 1);
    assert.equal(turn?.runtimeOutcome?.status, "completed");
    assert.equal(turn?.runtimeOutcome?.resultKind, "error");
  } finally {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    useAppStore.setState(originalState, true);
  }
});

test("live FIFO completion cannot retire a same-ID replacement with a drifted envelope", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-live-envelope-replacement";
  const sessionId = 608;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-live-envelope-replacement";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "live-envelope-replacement",
    61_101,
  );
  const entry = queue.entries[0];
  const projection = buildExactWorkspaceInstructionProjection(entry);
  const runId = "run-live-envelope-old-owner";
  const summary = "The old envelope completed before replacement.";
  const finalBlockId = 61_102;
  let saveCalls = 0;

  try {
    useAppStore.setState({
      ...originalState,
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Live envelope replacement",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      ...projection,
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: () => {
        useAppStore.setState((current) => {
          const activeHead = current.workspaceTurnQueue.entries[0];
          const replacementHead = {
            ...activeHead,
            instruction: {
              ...activeHead.instruction,
              source: "replay",
              submittedAt: 9,
              payload: { text: "replacement envelope payload" },
            },
            receipt: {
              ...activeHead.receipt,
              acceptedAt: 9,
            },
          };
          return {
            workspaceTurnQueue: {
              ...current.workspaceTurnQueue,
              entries: [replacementHead],
            },
            runtimeEvents: [
              turnEvents.withEventSchema({
                type: "run.started",
                threadId: sessionKey,
                turnId: entry.receipt.turnId,
                runId,
                parentRunId: null,
                timestampMs: 30,
              }),
              turnEvents.withEventSchema({
                type: "run.completed",
                threadId: sessionKey,
                turnId: entry.receipt.turnId,
                runId,
                parentRunId: null,
                timestampMs: 31,
                resultKind: "success",
                summary,
              }),
              turnEvents.withEventSchema({
                type: "turn.completed",
                threadId: sessionKey,
                turnId: entry.receipt.turnId,
                timestampMs: 32,
                resultKind: "success",
              }),
            ],
            taskFlow: [...current.taskFlow, {
              id: finalBlockId,
              turnId: entry.receipt.turnId,
              type: "agent",
              content: summary,
              streaming: false,
              visibility: "assistant_final",
            }],
            conversationTurns: current.conversationTurns.map((turn) =>
              turn.id === entry.receipt.turnId
                ? {
                    ...turn,
                    status: "done",
                    summary,
                    blockIds: [...turn.blockIds, finalBlockId],
                    runtimeOutcome: {
                      status: "completed",
                      reason: "old_envelope_completed",
                      resultKind: "success",
                      runId,
                      parentRunId: null,
                      updatedAt: 32,
                    },
                  }
                : turn
            ),
          };
        });
        return false;
      },
      saveCurrentRuntimeToSession: () => {
        saveCalls += 1;
      },
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), false);
    const current = useAppStore.getState();
    const replacement = current.workspaceTurnQueue.entries[0];
    assert.equal(current.workspaceTurnQueue.entries.length, 1);
    assert.equal(replacement.status, "dispatching");
    assert.equal(replacement.receipt.receiptId, entry.receipt.receiptId);
    assert.equal(replacement.receipt.turnId, entry.receipt.turnId);
    assert.equal(replacement.receipt.acceptedAt, 9);
    assert.equal(replacement.instruction.clientSubmissionId, entry.instruction.clientSubmissionId);
    assert.equal(replacement.instruction.submittedAt, 9);
    assert.equal(replacement.instruction.source, "replay");
    assert.equal(replacement.instruction.payload.text, "replacement envelope payload");
    assert.equal(saveCalls, 0);
    assert.equal(
      current.runtimeEvents.filter((event) =>
        event.type === "turn.completed" && event.turnId === entry.receipt.turnId
      ).length,
      1,
      "the old terminal is present but cannot authorize removal of the replacement envelope",
    );
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher preserves an exact adapter error outcome while repairing missing terminals", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-adapter-error-outcome";
  const sessionId = 609;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-adapter-error-outcome";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "adapter-error-outcome",
    61_201,
  );
  const entry = queue.entries[0];
  const projection = buildExactWorkspaceInstructionProjection(entry);
  const runId = "run-adapter-error-outcome";
  const summary = "The exact adapter concluded with a durable error.";

  try {
    useAppStore.setState({
      ...originalState,
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Adapter error outcome",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      ...projection,
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: () => {
        useAppStore.setState((current) => ({
          conversationTurns: current.conversationTurns.map((turn) =>
            turn.id === entry.receipt.turnId
              ? {
                  ...turn,
                  status: "done",
                  summary,
                  runtimeOutcome: {
                    status: "completed",
                    reason: "adapter_error",
                    resultKind: "error",
                    runId,
                    parentRunId: null,
                    updatedAt: 40,
                  },
                }
              : turn
          ),
        }));
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    const current = useAppStore.getState();
    const turn = current.conversationTurns.find((candidate) =>
      candidate.id === entry.receipt.turnId
    );
    const ownedEvents = current.runtimeEvents.filter((event) =>
      "turnId" in event && event.turnId === entry.receipt.turnId
    );
    const finals = current.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === entry.receipt.turnId &&
      block.visibility === "assistant_final"
    );
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(turn.runtimeOutcome?.runId, runId);
    assert.equal(turn.runtimeOutcome?.resultKind, "error");
    assert.equal(turn.summary, summary);
    assert.deepEqual(ownedEvents.map((event) => event.type), [
      "run.started",
      "run.completed",
      "turn.completed",
    ]);
    assert.equal(ownedEvents[1].runId, runId);
    assert.equal(ownedEvents[1].resultKind, "error");
    assert.equal(ownedEvents[1].summary, summary);
    assert.equal(ownedEvents[2].resultKind, "error");
    assert.equal(finals.length, 1);
    assert.equal(finals[0].content, summary);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher canonicalizes an exact adapter aborted outcome under its original Run owner", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-adapter-aborted-outcome";
  const sessionId = 610;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-adapter-aborted-outcome";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "adapter-aborted-outcome",
    61_301,
  );
  const entry = queue.entries[0];
  const projection = buildExactWorkspaceInstructionProjection(entry);
  const runId = "run-adapter-aborted-outcome";
  const parentRunId = "run-adapter-aborted-parent";
  const summary = "The exact adapter was canceled before it could finish.";

  try {
    useAppStore.setState({
      ...originalState,
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Adapter aborted outcome",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      ...projection,
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: () => {
        useAppStore.setState((current) => ({
          conversationTurns: current.conversationTurns.map((turn) =>
            turn.id === entry.receipt.turnId
              ? {
                  ...turn,
                  status: "done",
                  summary,
                  runtimeOutcome: {
                    status: "aborted",
                    reason: "user_cancelled",
                    runId,
                    parentRunId,
                    updatedAt: 40,
                  },
                }
              : turn
          ),
        }));
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    const current = useAppStore.getState();
    const turn = current.conversationTurns.find((candidate) =>
      candidate.id === entry.receipt.turnId
    );
    const ownedEvents = current.runtimeEvents.filter((event) =>
      "turnId" in event && event.turnId === entry.receipt.turnId
    );
    const finals = current.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === entry.receipt.turnId &&
      block.visibility === "assistant_final"
    );

    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.deepEqual(ownedEvents.map((event) => event.type), [
      "run.started",
      "run.aborted",
      "run.completed",
      "turn.completed",
    ]);
    for (const event of ownedEvents.slice(0, 3)) {
      assert.equal(event.runId, runId);
      assert.equal(event.parentRunId, parentRunId);
    }
    assert.equal(ownedEvents[2]?.resultKind, "canceled");
    assert.equal(ownedEvents[3]?.resultKind, "canceled");
    assert.equal(turn.runtimeOutcome?.status, "completed");
    assert.equal(turn.runtimeOutcome?.resultKind, "canceled");
    assert.equal(turn.runtimeOutcome?.runId, runId);
    assert.equal(turn.runtimeOutcome?.parentRunId, parentRunId);
    assert.equal(turn.summary, summary);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].content, summary);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher repairs a corrupt exact canceled source with one canonical abort sequence before recovery", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-corrupt-canceled-source-recovery";
  const sessionId = 613;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-corrupt-canceled-source-recovery";
  const queue = buildQueuedWorkspaceTurn(
    sessionKey,
    sessionEpoch,
    "corrupt-canceled-source-recovery",
    61_601,
  );
  const entry = queue.entries[0];
  const projection = buildExactWorkspaceInstructionProjection(entry);
  const sourceRunId = "run-corrupt-canceled-source";
  const sourceParentRunId = "run-corrupt-canceled-parent";
  const sourceSummary = "The exact source was canceled before its corrupt trace was isolated.";
  const sourceFinalBlockId = entry.receipt.userBlockId + 1;

  try {
    useAppStore.setState({
      ...originalState,
      config: { ...originalState.config, language: "en" },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Corrupt canceled source recovery",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      runtimeBySessionKey: {},
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      ...projection,
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: () => {
        useAppStore.setState((current) => ({
          taskFlow: [...current.taskFlow, {
            id: sourceFinalBlockId,
            turnId: entry.receipt.turnId,
            type: "agent",
            content: sourceSummary,
            streaming: false,
            visibility: "assistant_final",
          }],
          conversationTurns: current.conversationTurns.map((turn) =>
            turn.id === entry.receipt.turnId
              ? {
                  ...turn,
                  status: "done",
                  summary: sourceSummary,
                  blockIds: [...turn.blockIds, sourceFinalBlockId],
                  runtimeOutcome: {
                    status: "completed",
                    reason: "adapter_canceled_with_corrupt_trace",
                    resultKind: "canceled",
                    runId: sourceRunId,
                    parentRunId: sourceParentRunId,
                    updatedAt: 44,
                  },
                }
              : turn
          ),
          runtimeEvents: [
            turnEvents.withEventSchema({
              type: "run.started",
              threadId: sessionKey,
              turnId: entry.receipt.turnId,
              runId: sourceRunId,
              parentRunId: sourceParentRunId,
              timestampMs: 40,
            }),
            turnEvents.withEventSchema({
              type: "run.aborted",
              threadId: sessionKey,
              turnId: entry.receipt.turnId,
              runId: sourceRunId,
              parentRunId: sourceParentRunId,
              timestampMs: 41,
              reason: "user_cancelled",
              message: sourceSummary,
            }),
            turnEvents.withEventSchema({
              type: "run.completed",
              threadId: sessionKey,
              turnId: entry.receipt.turnId,
              runId: sourceRunId,
              parentRunId: sourceParentRunId,
              timestampMs: 42,
              resultKind: "canceled",
              summary: sourceSummary,
            }),
            // A duplicate source conclusion makes the exact source trace
            // corrupt while preserving its authoritative canceled Turn fact.
            turnEvents.withEventSchema({
              type: "run.completed",
              threadId: sessionKey,
              turnId: entry.receipt.turnId,
              runId: sourceRunId,
              parentRunId: sourceParentRunId,
              timestampMs: 43,
              resultKind: "canceled",
              summary: sourceSummary,
            }),
            turnEvents.withEventSchema({
              type: "turn.completed",
              threadId: sessionKey,
              turnId: entry.receipt.turnId,
              timestampMs: 44,
              resultKind: "canceled",
            }),
          ],
        }));
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
    const current = useAppStore.getState();
    const sourceTurn = current.conversationTurns.find(
      (turn) => turn.id === entry.receipt.turnId,
    );
    const repairedSourceRunId = sourceTurn?.runtimeOutcome?.runId;
    const repairedSourceEvents = current.runtimeEvents.filter((event) =>
      event.threadId === sessionKey &&
      "turnId" in event &&
      event.turnId === entry.receipt.turnId &&
      (
        ("runId" in event && event.runId === repairedSourceRunId) ||
        event.type === "turn.completed"
      )
    );
    const recoveryTurn = current.conversationTurns.find((turn) =>
      turn.id.startsWith(`workspace-recovery-${entry.receipt.receiptId}`)
    );
    const recoveryEvents = current.runtimeEvents.filter((event) =>
      event.threadId === sessionKey &&
      "turnId" in event &&
      event.turnId === recoveryTurn?.id
    );
    const sourceFinals = current.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === entry.receipt.turnId &&
      block.visibility === "assistant_final"
    );
    const recoveryFinals = current.taskFlow.filter((block) =>
      block.type === "agent" &&
      block.turnId === recoveryTurn?.id &&
      block.visibility === "assistant_final"
    );

    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.ok(repairedSourceRunId?.startsWith("run-admission-source-recovery-"));
    assert.notEqual(repairedSourceRunId, sourceRunId);
    assert.deepEqual(repairedSourceEvents.map((event) => event.type), [
      "run.started",
      "run.aborted",
      "run.completed",
      "turn.completed",
    ]);
    for (const event of repairedSourceEvents.slice(0, 3)) {
      assert.equal(event.runId, repairedSourceRunId);
      assert.equal(event.parentRunId, null);
    }
    assert.equal(repairedSourceEvents[2]?.resultKind, "canceled");
    assert.equal(repairedSourceEvents[3]?.resultKind, "canceled");
    assert.equal(sourceTurn?.runtimeOutcome?.status, "completed");
    assert.equal(sourceTurn?.runtimeOutcome?.resultKind, "canceled");
    assert.equal(sourceTurn?.runtimeOutcome?.parentRunId, null);
    assert.equal(sourceFinals.length, 1);
    assert.equal(sourceFinals[0].content, sourceTurn?.summary);

    assert.ok(recoveryTurn, "a corrupt exact source must receive a distinct recovery child");
    assert.deepEqual(recoveryEvents.map((event) => event.type), [
      "run.started",
      "run.completed",
      "turn.completed",
    ]);
    assert.equal(recoveryEvents[0]?.runId, recoveryEvents[1]?.runId);
    assert.equal(recoveryEvents[0]?.parentRunId, repairedSourceRunId);
    assert.equal(recoveryEvents[1]?.parentRunId, repairedSourceRunId);
    assert.equal(recoveryEvents[1]?.resultKind, "error");
    assert.equal(recoveryEvents[2]?.resultKind, "error");
    assert.equal(recoveryTurn?.runtimeOutcome?.status, "completed");
    assert.equal(recoveryTurn?.runtimeOutcome?.resultKind, "error");
    assert.equal(recoveryTurn?.runtimeOutcome?.runId, recoveryEvents[0]?.runId);
    assert.equal(recoveryTurn?.runtimeOutcome?.parentRunId, repairedSourceRunId);
    assert.equal(recoveryFinals.length, 1);
    assert.equal(recoveryFinals[0].content, recoveryTurn?.summary);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("pending cancellation keeps a newly admitted workspace Turn queued until terminal settlement", async () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-cancellation-fifo";
  const sessionId = 707;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-cancellation-fifo";
  const queue = buildQueuedWorkspaceTurn(sessionKey, sessionEpoch, "after-cancel", 60_001);
  const receipt = queue.entries[0].receipt;
  let settleCancellation;
  const cancellationSettlement = new Promise((resolve) => {
    settleCancellation = resolve;
  });
  let dispatchCount = 0;
  let dispatchedClaim = null;

  const cancellation = beginSessionCancellation(
    sessionKey,
    "turn-being-canceled",
    () => cancellationSettlement,
  );
  assert.equal(cancellation.started, true);

  try {
    useAppStore.setState({
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Cancellation FIFO",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 1,
      isGenerating: true,
      agentStatus: "running",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: (_text, _images, options) => {
        dispatchCount += 1;
        dispatchedClaim = options.workspaceInstructionClaim;
        useAppStore.setState({ currentTurnId: options.turnIdOverride });
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    });

    assert.equal(
      useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey),
      false,
    );
    let current = useAppStore.getState();
    assert.equal(dispatchCount, 0, "the cancel fence must prevent claim execution");
    assert.equal(current.workspaceTurnQueue.entries[0].status, "queued");
    assert.equal(current.queuedUserMessage, null);
    assert.equal(
      current.runtimeEvents.some((event) =>
        event.turnId === receipt.turnId && event.type === "turn.completed"
      ),
      false,
      "the fenced Turn must not receive a fabricated completion",
    );

    // The cancellation terminal transaction publishes idle before releasing
    // the fence; the registered FIFO callback must then retry the exact head.
    useAppStore.setState({ isGenerating: false, agentStatus: "idle" });
    settleCancellation({
      sessionKey,
      turnId: "turn-being-canceled",
      terminalSettled: true,
      disposition: "committed",
      queueDisposition: "replay",
    });
    await cancellation.cancellation.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    current = useAppStore.getState();
    assert.equal(dispatchCount, 1);
    assert.equal(dispatchedClaim.turnId, receipt.turnId);
    assert.equal(dispatchedClaim.receiptId, receipt.receiptId);
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(current.queuedUserMessage, null);
  } finally {
    settleCancellation?.({
      sessionKey,
      turnId: "turn-being-canceled",
      terminalSettled: true,
      disposition: "test_cleanup",
      queueDisposition: "discard",
    });
    await cancellation.cancellation.promise.catch(() => {});
    useAppStore.setState(originalState, true);
  }
});

test("a cancellation that races a durable claim releases and retries the exact FIFO Turn", async () => {
  const originalState = useAppStore.getState();
  const realSendMessage = originalState.sendMessage;
  const workspace = "/tmp/session-cancellation-claim-race";
  const sessionId = 808;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-cancellation-claim-race";
  const queue = buildQueuedWorkspaceTurn(sessionKey, sessionEpoch, "claim-race", 70_001);
  const receipt = queue.entries[0].receipt;
  let cancellation = null;
  let settleCancellation;
  const cancellationSettlement = new Promise((resolve) => {
    settleCancellation = resolve;
  });
  let firstClaim = null;
  let replayClaim = null;
  let replayCount = 0;
  let claimAwareSendResult = null;

  const replaySend = (_text, _images, options) => {
    replayCount += 1;
    replayClaim = options.workspaceInstructionClaim;
    useAppStore.setState({ currentTurnId: options.turnIdOverride });
    return true;
  };

  try {
    useAppStore.setState({
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Cancellation claim race",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 1,
      isGenerating: false,
      agentStatus: "idle",
      currentTurnId: null,
      harnessRunMarker: null,
      sendMessage: (text, images, options) => {
        firstClaim = options.workspaceInstructionClaim;
        cancellation = beginSessionCancellation(
          sessionKey,
          "turn-racing-cancel",
          () => cancellationSettlement,
        );
        assert.equal(cancellation.started, true);
        useAppStore.setState({ sendMessage: replaySend });
        claimAwareSendResult = realSendMessage(text, images, options);
        return claimAwareSendResult;
      },
      saveCurrentRuntimeToSession: () => {},
    });

    assert.equal(
      useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey),
      false,
    );
    let current = useAppStore.getState();
    assert.equal(claimAwareSendResult, false);
    assert.equal(firstClaim.turnId, receipt.turnId);
    assert.equal(current.workspaceTurnQueue.entries[0].status, "queued");
    assert.equal(current.queuedUserMessage, null, "durable claim must not enter the legacy queue");
    assert.equal(
      current.runtimeEvents.some((event) =>
        event.turnId === receipt.turnId && event.type === "turn.completed"
      ),
      false,
      "claim rejection during cancel must not fabricate success",
    );

    settleCancellation({
      sessionKey,
      turnId: "turn-racing-cancel",
      terminalSettled: true,
      disposition: "committed",
      queueDisposition: "replay",
    });
    await cancellation.cancellation.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    current = useAppStore.getState();
    assert.equal(replayCount, 1);
    assert.equal(replayClaim.turnId, receipt.turnId);
    assert.equal(replayClaim.receiptId, receipt.receiptId);
    assert.notEqual(replayClaim.claimId, firstClaim.claimId);
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(current.queuedUserMessage, null);
  } finally {
    settleCancellation?.({
      sessionKey,
      turnId: "turn-racing-cancel",
      terminalSettled: true,
      disposition: "test_cleanup",
      queueDisposition: "discard",
    });
    await cancellation?.cancellation.promise.catch(() => {});
    useAppStore.setState(originalState, true);
  }
});

test("unverified cancellation settlement fail-closes the exact admitted Turn with a visible conclusion", async () => {
  const originalState = useAppStore.getState();
  const cases = [
    { suffix: "unsettled", rejects: false },
    { suffix: "rejected", rejects: true },
  ];

  try {
    for (const [index, testCase] of cases.entries()) {
      const workspace = `/tmp/session-cancellation-${testCase.suffix}`;
      const sessionId = 900 + index;
      const sessionKey = `${workspace}:${sessionId}`;
      const sessionEpoch = `epoch-cancellation-${testCase.suffix}`;
      const queue = buildQueuedWorkspaceTurn(
        sessionKey,
        sessionEpoch,
        testCase.suffix,
        80_001 + index,
      );
      const receipt = queue.entries[0].receipt;
      let sendCount = 0;

      useAppStore.setState({
        ...originalState,
        currentWorkspace: workspace,
        selectedWorkspace: workspace,
        currentSessionId: sessionId,
        activeSessionByWorkspace: { [workspace]: sessionId },
        sessionsByWorkspace: {
          [workspace]: [{
            id: sessionId,
            title: `Cancellation ${testCase.suffix}`,
            date: "Today",
            active: true,
            planLifecycleEpoch: sessionEpoch,
            messages: [],
          }],
        },
        workspaceTurnQueue: queue,
        workspaceInstructionLedger: [],
        queuedUserMessage: null,
        taskFlow: [],
        conversationTurns: [],
        runtimeEvents: [],
        transcriptPartial: false,
        transcriptLoadedTurns: 0,
        transcriptTotalTurns: 1,
        isGenerating: true,
        agentStatus: "running",
        currentTurnId: "turn-being-canceled",
        harnessRunMarker: null,
        sendMessage: () => {
          sendCount += 1;
          return true;
        },
        saveCurrentRuntimeToSession: () => {},
      }, true);

      const cancellation = beginSessionCancellation(
        sessionKey,
        "turn-being-canceled",
        () => testCase.rejects
          ? Promise.reject(new Error("cancel persistence unavailable"))
          : Promise.resolve({
              sessionKey,
              turnId: "turn-being-canceled",
              terminalSettled: false,
              disposition: "terminal_projection_unverified",
            }),
      );
      assert.equal(cancellation.started, true);
      assert.equal(
        useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey),
        false,
      );
      assert.equal(useAppStore.getState().workspaceTurnQueue.entries[0].status, "queued");

      await cancellation.cancellation.promise.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      const current = useAppStore.getState();
      const closedTurn = current.conversationTurns.find(
        (turn) => turn.id === receipt.turnId,
      );
      const visibleFinal = current.taskFlow.find((block) =>
        block.turnId === receipt.turnId &&
        block.type === "agent" &&
        block.visibility === "assistant_final"
      );
      assert.equal(sendCount, 0, "unverified cancellation must never execute the new Turn");
      assert.equal(current.workspaceTurnQueue.entries.length, 0);
      assert.equal(current.queuedUserMessage, null);
      assert.equal(closedTurn.status, "error");
      assert.equal(closedTurn.runtimeOutcome.status, "completed");
      assert.equal(closedTurn.runtimeOutcome.resultKind, "error");
      assert.equal(typeof visibleFinal?.content, "string");
      assert.equal(
        current.runtimeEvents.some((event) =>
          event.type === "turn.completed" &&
          event.turnId === receipt.turnId &&
          event.resultKind === "error"
        ),
        true,
      );
      assert.equal(
        current.runtimeEvents.some((event) =>
          event.type === "turn.completed" &&
          event.turnId === receipt.turnId &&
          event.resultKind === "success"
        ),
        false,
      );
    }
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("dispatcher applies exact pending-review approve and reject decisions without duplicating the admitted user block", () => {
  const originalState = useAppStore.getState();
  const cases = [
    { actionDecision: "approve", optionAction: "execute_once", text: "Run once", resolverAction: "accept" },
    { actionDecision: "reject", optionAction: "cancel_operation", text: "Cancel", resolverAction: "reject" },
  ];

  try {
    for (const [index, testCase] of cases.entries()) {
      const workspace = `/tmp/session-pending-review-${testCase.actionDecision}`;
      const sessionId = 1_100 + index;
      const sessionKey = `${workspace}:${sessionId}`;
      const sessionEpoch = `epoch-pending-review-${testCase.actionDecision}`;
      const sourceTurnId = `turn-review-${testCase.actionDecision}`;
      const sourceRunId = `run-review-${testCase.actionDecision}`;
      const requestId = `request-review-${testCase.actionDecision}`;
      const optionValues = [testCase.text];
      const choiceIdentity = {
        sessionKey,
        turnId: sourceTurnId,
        runId: sourceRunId,
        requestId,
        parentRunId: null,
        optionValues,
        allowCustomReply: false,
        status: "pending",
      };
      const payload = {
        text: testCase.text,
        dispatchHints: {
          ...(testCase.actionDecision === "approve" ? { executionConsentGranted: true } : {}),
          replyOptionSourceTurnId: sourceTurnId,
          selectedReplyOptionText: testCase.text,
          replyOptionRequestIdentity: choiceIdentity,
        },
      };
      const queue = buildQueuedWorkspaceTurn(
        sessionKey,
        sessionEpoch,
        `pending-review-${testCase.actionDecision}`,
        90_001 + index,
        payload,
      );
      const receipt = queue.entries[0].receipt;
      const resolverCalls = [];
      let sendCount = 0;
      let abortCount = 0;

      useAppStore.setState({
        ...originalState,
        currentWorkspace: workspace,
        selectedWorkspace: workspace,
        currentSessionId: sessionId,
        activeSessionByWorkspace: { [workspace]: sessionId },
        sessionsByWorkspace: {
          [workspace]: [{
            id: sessionId,
            title: `Pending review ${testCase.actionDecision}`,
            date: "Today",
            active: true,
            planLifecycleEpoch: sessionEpoch,
            messages: [],
          }],
        },
        workspaceTurnQueue: queue,
        workspaceInstructionLedger: [],
        queuedUserMessage: null,
        taskFlow: [
          { id: 1, turnId: sourceTurnId, type: "user", content: "Review this operation" },
          {
            id: 2,
            turnId: sourceTurnId,
            type: "agent",
            content: "Choose",
            options: [{
              label: testCase.text,
              value: testCase.text,
              action: testCase.optionAction,
            }],
            choiceRequest: choiceIdentity,
          },
        ],
        conversationTurns: [{
          id: sourceTurnId,
          userPrompt: "Review this operation",
          title: "Review",
          mode: "edit",
          intent: "execute",
          displayIntent: "execute",
          status: "awaiting_approval",
          summary: "",
          blockIds: [1, 2],
          collapsed: false,
          createdAt: 1,
        }],
        runtimeEvents: [{
          schemaVersion: 2,
          type: "run.started",
          threadId: sessionKey,
          turnId: sourceTurnId,
          timestampMs: 1,
          runId: sourceRunId,
          parentRunId: null,
        }],
        transcriptPartial: false,
        transcriptLoadedTurns: 1,
        transcriptTotalTurns: 2,
        isGenerating: true,
        agentStatus: "pending_review",
        currentTurnId: sourceTurnId,
        harnessRunMarker: null,
        activeActionRequest: {
          schemaVersion: 1,
          requestId,
          kind: "user_choice",
          sessionKey,
          turnId: sourceTurnId,
          runId: sourceRunId,
          parentRunId: null,
          title: "Review",
          status: "pending",
          createdAt: 1,
          optionValues,
          allowCustomReply: false,
        },
        pendingReviewResolve: (decision) => resolverCalls.push(decision),
        pendingReviewTaskId: 2,
        abortController: {
          abort() {
            abortCount += 1;
          },
        },
        sendMessage: () => {
          sendCount += 1;
          return true;
        },
        saveCurrentRuntimeToSession: () => {},
      }, true);

      assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);
      const current = useAppStore.getState();
      const admittedUserBlocks = current.taskFlow.filter((block) =>
        block.type === "user" && block.turnId === receipt.turnId
      );
      const admittedFinals = current.taskFlow.filter((block) =>
        block.type === "agent" &&
        block.turnId === receipt.turnId &&
        block.visibility === "assistant_final"
      );
      const sourceChoice = current.taskFlow.find((block) => block.id === 2);
      assert.deepEqual(resolverCalls, [{ action: testCase.resolverAction }]);
      assert.equal(sendCount, 0, "an exact ActionDecision must not launch a second agent Run");
      assert.equal(abortCount, testCase.actionDecision === "reject" ? 1 : 0);
      assert.equal(current.workspaceTurnQueue.entries.length, 0);
      assert.equal(admittedUserBlocks.length, 1);
      assert.equal(admittedUserBlocks[0].id, receipt.userBlockId);
      assert.equal(admittedFinals.length, 1);
      assert.equal(sourceChoice.archivedAfterChoice, true);
      assert.equal(sourceChoice.options, undefined);
      assert.equal(current.activeActionRequest, null);
      assert.equal(
        current.runtimeEvents.some((event) =>
          event.type === "turn.completed" &&
          event.turnId === receipt.turnId &&
          event.resultKind === "success"
        ),
        true,
      );
    }
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test("an unrelated durable Turn stays queued during pending review and takes FIFO ownership only after review conclusion", () => {
  const originalState = useAppStore.getState();
  const workspace = "/tmp/session-pending-review-unrelated";
  const sessionId = 1_200;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = "epoch-pending-review-unrelated";
  const sourceTurnId = "turn-review-unrelated";
  const sourceRunId = "run-review-unrelated";
  const queue = buildQueuedWorkspaceTurn(sessionKey, sessionEpoch, "pending-review-unrelated", 91_001);
  const receipt = queue.entries[0].receipt;
  const reviewDecisions = [];
  const dispatchClaims = [];
  let sendInvocations = 0;

  try {
    useAppStore.setState({
      ...originalState,
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      currentSessionId: sessionId,
      activeSessionByWorkspace: { [workspace]: sessionId },
      sessionsByWorkspace: {
        [workspace]: [{
          id: sessionId,
          title: "Pending review unrelated",
          date: "Today",
          active: true,
          planLifecycleEpoch: sessionEpoch,
          messages: [],
        }],
      },
      workspaceTurnQueue: queue,
      workspaceInstructionLedger: [],
      queuedUserMessage: null,
      taskFlow: [],
      conversationTurns: [{
        id: sourceTurnId,
        userPrompt: "Old review",
        title: "Old review",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "awaiting_approval",
        summary: "",
        blockIds: [],
        collapsed: false,
        createdAt: 1,
      }],
      runtimeEvents: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 1,
      transcriptTotalTurns: 2,
      isGenerating: true,
      agentStatus: "pending_review",
      currentTurnId: sourceTurnId,
      activeActionRequest: null,
      pendingReviewResolve: (decision) => reviewDecisions.push(decision),
      pendingReviewTaskId: 5,
      abortController: { abort() {} },
      sendMessage: (_text, _images, options) => {
        sendInvocations += 1;
        dispatchClaims.push(options.workspaceInstructionClaim);
        useAppStore.setState({ currentTurnId: options.turnIdOverride });
        return true;
      },
      saveCurrentRuntimeToSession: () => {},
    }, true);

    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), false);
    let current = useAppStore.getState();
    assert.deepEqual(reviewDecisions, []);
    assert.equal(current.workspaceTurnQueue.entries[0].status, "queued");
    assert.equal(current.queuedUserMessage, null);
    assert.equal(sendInvocations, 0);

    useAppStore.setState({
      agentStatus: "idle",
      isGenerating: false,
      currentTurnId: null,
      conversationTurns: current.conversationTurns.map((turn) =>
        turn.id === sourceTurnId
          ? {
              ...turn,
              status: "done",
              summary: "The pending review concluded before FIFO advanced.",
              runtimeOutcome: {
                status: "completed",
                reason: "review_concluded",
                resultKind: "canceled",
                runId: sourceRunId,
                parentRunId: null,
                updatedAt: 2,
              },
            }
          : turn
      ),
      activeActionRequest: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      abortController: null,
    });
    assert.equal(useAppStore.getState().dispatchNextWorkspaceInstruction(sessionKey), true);

    current = useAppStore.getState();
    assert.deepEqual(reviewDecisions, []);
    assert.equal(sendInvocations, 1);
    assert.equal(dispatchClaims[0].turnId, receipt.turnId);
    assert.equal(dispatchClaims[0].receiptId, receipt.receiptId);
    assert.equal(current.workspaceTurnQueue.entries.length, 0);
    assert.equal(current.queuedUserMessage, null);
  } finally {
    useAppStore.setState(originalState, true);
  }
});
