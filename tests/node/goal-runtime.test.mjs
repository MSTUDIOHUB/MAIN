import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const goalState = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalState.ts"));
const goalRuntime = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalRuntime.ts"));
const goalBudget = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalBudget.ts"));
const goalContext = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalContextStrategy.ts"));
const goalEngine = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalEngine.ts"));
const goalContinuity = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalContinuity.ts"));
const goalSourceContext = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalSourceContext.ts"));
const goalEventIdentity = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalEventIdentity.ts"));
const goalPersistence = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalPersistence.ts"));
const goalRunOwnership = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalRunOwnership.ts"));
const goalOutcomePolicy = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalOutcomePolicy.ts"));

function createIteration(index) {
  return {
    index,
    phase: "observe",
    startedAt: index,
    endedAt: index + 1,
    summary: `iteration ${index}`,
    toolCallCount: 1,
    filesModified: [],
    testsRun: [],
    testsPassed: null,
    unresolvedBlockers: [],
  };
}

test("Goal persistence deletion paths accept one safe id segment and reject traversal", () => {
  assert.equal(
    goalPersistence.resolveGoalRuntimeRelativeDirPath("goal_1783949110423_1"),
    ".MAIN/goals/goal_1783949110423_1",
  );
  for (const unsafe of ["../goal-1", "goal/child", "goal\\child", ".", "..", " goal-1", "goal-1 "]) {
    assert.throws(
      () => goalPersistence.resolveGoalRuntimeRelativeDirPath(unsafe),
      /Invalid Goal id path segment/,
    );
  }
});

test("Goal persistence deletion tombstones are scoped by workspace and goal id", () => {
  const workspaceA = "/tmp/goal-delete-a";
  const workspaceB = "/tmp/goal-delete-b";
  const goalId = "goal_123_1";
  goalPersistence.markGoalRuntimeDeleted(workspaceA, goalId);
  assert.equal(goalPersistence.isGoalRuntimeDeleted(workspaceA, goalId), true);
  assert.equal(goalPersistence.isGoalRuntimeDeleted(workspaceB, goalId), false);
  assert.equal(goalPersistence.isGoalRuntimeDeleted(workspaceA, "goal_123_2"), false);
  goalPersistence.unmarkGoalRuntimeDeleted(workspaceA, goalId);
  assert.equal(goalPersistence.isGoalRuntimeDeleted(workspaceA, goalId), false);
});

test("a live Goal deletion keeps its durable fence until the next process", () => {
  const workspace = "/tmp/goal-delete-live-fence";
  const goalId = "goal_123_3";
  goalPersistence.markGoalRuntimeDeleted(workspace, goalId, {
    retainFenceForProcess: true,
  });
  assert.equal(
    goalPersistence.shouldRetainGoalDeletionFenceForCurrentProcess(workspace, goalId),
    true,
  );
  goalPersistence.unmarkGoalRuntimeDeleted(workspace, goalId);
  assert.equal(
    goalPersistence.shouldRetainGoalDeletionFenceForCurrentProcess(workspace, goalId),
    false,
  );
});

test("durable Goal deletion fences round-trip only safe exact identities", () => {
  const goalId = "goal_123_9";
  const serialized = goalPersistence.serializeGoalDeletionFence({
    goalId,
    ownerSessionKey: "/workspace:42",
    deletedAt: 500,
  });
  assert.deepEqual(goalPersistence.deserializeGoalDeletionFence(serialized, goalId), {
    schemaVersion: 1,
    goalId,
    ownerSessionKey: "/workspace:42",
    deletedAt: 500,
  });
  assert.equal(
    goalPersistence.resolveGoalDeletionFenceRelativePath(goalId),
    `.MAIN/goals/.deleted/${goalId}.json`,
  );
  assert.equal(goalPersistence.deserializeGoalDeletionFence(serialized, "goal_other"), null);
  assert.deepEqual(goalPersistence.registerGoalDeletionFenceEntries("/workspace", [
    { name: `${goalId}.json`, is_dir: false },
    { name: "../escape.json", is_dir: false },
    { name: "nested", is_dir: true },
  ]), [goalId]);
  assert.equal(goalPersistence.isGoalRuntimeDeleted("/workspace", goalId), true);
  goalPersistence.unmarkGoalRuntimeDeleted("/workspace", goalId);
});

test("Goal pause/delete recognizes only an exact queued continuation owner", () => {
  const goal = {
    id: "goal_123_1",
    revision: 3,
    sessionKey: "/workspace:42",
    ownerTurnId: "turn-goal",
  };
  const queuedMessage = {
    text: "resume exact goal",
    sessionKey: "/workspace:42",
    status: "queued",
    goalContinuationAuthorization: {
      kind: "goal_continuation_authorization",
      source: "goal_manual_resume",
      workspaceKey: "/workspace",
      sessionKey: "/workspace:42",
      goalId: "goal_123_1",
      goalRevision: 3,
      ownerTurnId: "turn-goal",
    },
  };
  const exactInput = {
    queuedMessage,
    goal,
    workspaceKey: "/workspace",
    sessionKey: "/workspace:42",
    expectedText: "resume exact goal",
    expectedSource: "goal_manual_resume",
  };

  assert.equal(
    goalRunOwnership.isQueuedGoalContinuationOwnedByGoal(exactInput),
    true,
  );
  for (const mismatch of [
    { queuedMessage: { ...queuedMessage, text: "unrelated user message" } },
    { sessionKey: "/workspace:43" },
    { goal: { ...goal, revision: 4 } },
    { goal: { ...goal, ownerTurnId: "turn-other" } },
    { expectedSource: "goal_user_choice" },
  ]) {
    assert.equal(
      goalRunOwnership.isQueuedGoalContinuationOwnedByGoal({
        ...exactInput,
        ...mismatch,
      }),
      false,
    );
  }
});

test("removing an unleased queued Goal continuation rolls back only its exact owner", () => {
  const goal = {
    id: "goal_123_1",
    revision: 3,
    status: "active",
    sessionKey: "/workspace:42",
    ownerTurnId: "turn-goal",
  };
  const queuedMessage = {
    id: "queue-goal-resume",
    text: "resume exact goal",
    sessionKey: "/workspace:42",
    status: "queued",
    goalContinuationAuthorization: {
      kind: "goal_continuation_authorization",
      source: "goal_manual_resume",
      workspaceKey: "/workspace",
      sessionKey: "/workspace:42",
      goalId: goal.id,
      goalRevision: goal.revision,
      ownerTurnId: goal.ownerTurnId,
    },
  };
  const foreignRunMarker = {
    status: "running",
    runtimeIntent: "execute",
    workspace: "/workspace",
    sessionKey: "/workspace:42",
    turnId: "turn-foreign",
  };
  const baseInput = {
    queuedMessage,
    goal,
    marker: foreignRunMarker,
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
  };

  assert.deepEqual(
    goalRunOwnership.resolveQueuedGoalContinuationRemoval({
      ...baseInput,
      mode: "discarded",
    }),
    {
      shouldPauseGoal: true,
      reason: "orphaned_before_run_lease",
      leaseReason: "runtime_intent_mismatch",
    },
  );
  assert.deepEqual(
    goalRunOwnership.resolveQueuedGoalContinuationRemoval({
      ...baseInput,
      mode: "consumed",
    }),
    { shouldPauseGoal: false, reason: "replay_consumed" },
  );
  assert.deepEqual(
    goalRunOwnership.resolveQueuedGoalContinuationRemoval({
      ...baseInput,
      mode: "replaced",
      marker: {
        status: "running",
        runtimeIntent: "goal",
        workspace: "/workspace",
        sessionKey: "/workspace:42",
        turnId: "turn-goal",
      },
    }),
    {
      shouldPauseGoal: false,
      reason: "goal_run_lease_acquired",
      leaseReason: "owned_goal_run",
    },
  );
  assert.deepEqual(
    goalRunOwnership.resolveQueuedGoalContinuationRemoval({
      ...baseInput,
      mode: "discarded",
      currentSessionKey: "/workspace:43",
    }),
    { shouldPauseGoal: false, reason: "queue_owner_mismatch" },
  );
});

test("Goal deletion aborts only the exact running Goal owner lease", () => {
  const decision = goalRunOwnership.resolveGoalRunAbortOwnership({
    goal: {
      status: "active",
      sessionKey: "/workspace:42",
      ownerTurnId: "turn-goal",
    },
    marker: {
      status: "running",
      runtimeIntent: "goal",
      sessionKey: "/workspace:42",
      turnId: "turn-goal",
      workspace: "/workspace",
    },
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
    isGenerating: true,
    hasAbortController: true,
  });

  assert.deepEqual(decision, { owned: true, reason: "owned_goal_run" });
});

test("a stale active Goal cannot abort the current non-Goal run", () => {
  const decision = goalRunOwnership.resolveGoalRunAbortOwnership({
    goal: {
      status: "active",
      sessionKey: "/workspace:42",
      ownerTurnId: "turn-old-goal",
    },
    marker: {
      status: "running",
      runtimeIntent: "execute",
      sessionKey: "/workspace:42",
      turnId: "turn-current-execute",
      workspace: "/workspace",
    },
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
    isGenerating: true,
    hasAbortController: true,
  });

  assert.deepEqual(decision, { owned: false, reason: "runtime_intent_mismatch" });
});

test("pausing a queued Goal preserves the foreign run and settles the Goal as paused", () => {
  const goal = {
    id: "goal-queued",
    revision: 3,
    status: "active",
    sessionKey: "/workspace:42",
    ownerTurnId: "turn-goal-resume",
  };
  const decision = goalRunOwnership.resolveGoalPauseTransition({
    goal,
    queuedMessage: {
      id: "queued-goal-resume",
      status: "queued",
      sessionKey: "/workspace:42",
      goalContinuationAuthorization: {
        kind: "goal_continuation_authorization",
        source: "goal_manual_resume",
        workspaceKey: "/workspace",
        sessionKey: "/workspace:42",
        goalId: goal.id,
        goalRevision: goal.revision,
        ownerTurnId: goal.ownerTurnId,
      },
    },
    marker: {
      status: "running",
      runtimeIntent: "execute",
      sessionKey: "/workspace:42",
      turnId: "turn-foreign-execute",
      workspace: "/workspace",
    },
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
    isGenerating: true,
    hasAbortController: true,
  });

  assert.deepEqual(decision, {
    nextStatus: "paused",
    shouldAbortRun: false,
    shouldClearQueuedContinuation: true,
    abortReason: "runtime_intent_mismatch",
  });
});

test("Goal workflow callbacks are fenced by the captured owner Turn", () => {
  const captured = {
    goalId: "goal-1",
    goalRevision: 4,
    ownerTurnId: "turn-old",
  };
  assert.equal(goalRunOwnership.isCurrentGoalWorkflowOwner({
    ...captured,
    currentGoal: { id: "goal-1", revision: 4, ownerTurnId: "turn-old" },
  }), true);
  assert.equal(goalRunOwnership.isCurrentGoalWorkflowOwner({
    ...captured,
    currentGoal: { id: "goal-1", revision: 4, ownerTurnId: "turn-resumed" },
  }), false);

  const workflowSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );
  const goalLoopStart = workflowSource.indexOf("const executeLoopStrategy =");
  const goalLoopEnd = workflowSource.indexOf("return executeAgentLoop(callbacks, abortCtrl);", goalLoopStart);
  const goalLoopSource = workflowSource.slice(goalLoopStart, goalLoopEnd);
  assert.match(goalLoopSource, /const goalOwnerTurnId = String\(activeGoal\.ownerTurnId \|\| turnId\)\.trim\(\)/);
  assert.match(goalLoopSource, /isCurrentGoalWorkflowOwner\(\{[\s\S]*?ownerTurnId: goalOwnerTurnId/);
});

test("Goal pause binds the global AbortController to the owner-scoped decision", () => {
  const storeSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/store/useAppStore.ts"),
    "utf8",
  );
  const pauseStart = storeSource.indexOf("pauseGoal: (expectedIdentity) => {");
  const pauseEnd = storeSource.indexOf("resumeGoal: (expectedIdentity) => {", pauseStart);
  const pauseSource = storeSource.slice(pauseStart, pauseEnd);
  assert.match(pauseSource, /const pauseTransition = resolveGoalPauseTransition\(\{/);
  assert.match(pauseSource, /if \(pauseTransition\.shouldAbortRun\) abortController\?\.abort\(\)/);
  assert.equal((pauseSource.match(/abortController\?\.abort\(\)/g) || []).length, 1);
});

test("Goal deletion claims an action request only through the exact Goal marker", () => {
  const goal = {
    sessionKey: "/workspace:42",
    ownerTurnId: "turn-shared",
  };
  const actionRequest = {
    kind: "user_choice",
    status: "pending",
    sessionKey: "/workspace:42",
    turnId: "turn-shared",
    runId: "run-shared",
  };
  const marker = {
    status: "paused",
    runtimeIntent: "goal",
    sessionKey: "/workspace:42",
    turnId: "turn-shared",
    workspace: "/workspace",
    runId: "run-goal-outer",
    activeRunId: "run-shared",
  };

  assert.deepEqual(goalRunOwnership.resolveGoalActionRequestOwnership({
    goal,
    marker,
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
    actionRequest,
  }), { owned: true, reason: "owned_goal_run" });

  assert.deepEqual(goalRunOwnership.resolveGoalActionRequestOwnership({
    goal,
    marker: { ...marker, runtimeIntent: "execute" },
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
    actionRequest,
  }), { owned: false, reason: "runtime_intent_mismatch" });
});

test("a Goal-owned pending permission remains an abortable lease while generation is paused", () => {
  const marker = {
    status: "running",
    runtimeIntent: "goal",
    sessionKey: "/workspace:42",
    turnId: "turn-goal",
    workspace: "/workspace",
    runId: "run-goal-outer",
    activeRunId: "run-goal-review",
  };
  const goal = {
    status: "active",
    sessionKey: "/workspace:42",
    ownerTurnId: "turn-goal",
  };
  const pending = goalRunOwnership.resolveGoalPendingReviewOwnership({
    goal,
    marker,
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
    agentStatus: "pending_review",
    actionRequest: {
      kind: "tool_permission",
      status: "pending",
      sessionKey: "/workspace:42",
      turnId: "turn-goal",
      runId: "run-goal-review",
      taskId: 73,
    },
    pendingReviewTaskId: 73,
    hasPendingReviewResolver: true,
  });

  assert.deepEqual(pending, { owned: true, reason: "owned_goal_run" });
  assert.deepEqual(goalRunOwnership.resolveGoalRunAbortOwnership({
    goal,
    marker,
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
    isGenerating: false,
    hasAbortController: true,
    hasOwnedPendingReview: pending.owned,
  }), { owned: true, reason: "owned_goal_run" });
});

test("a pending permission with a different action run cannot be claimed by Goal deletion", () => {
  const decision = goalRunOwnership.resolveGoalPendingReviewOwnership({
    goal: {
      status: "active",
      sessionKey: "/workspace:42",
      ownerTurnId: "turn-goal",
    },
    marker: {
      status: "running",
      runtimeIntent: "goal",
      sessionKey: "/workspace:42",
      turnId: "turn-goal",
      workspace: "/workspace",
      runId: "run-goal-outer",
      activeRunId: "run-goal-review-current",
    },
    currentWorkspace: "/workspace",
    currentSessionKey: "/workspace:42",
    agentStatus: "pending_review",
    actionRequest: {
      kind: "tool_permission",
      status: "pending",
      sessionKey: "/workspace:42",
      turnId: "turn-goal",
      runId: "run-goal-review-stale",
      taskId: 73,
    },
    pendingReviewTaskId: 73,
    hasPendingReviewResolver: true,
  });

  assert.deepEqual(decision, { owned: false, reason: "action_request_mismatch" });
});

test("Goal Runtime creates a versioned contract with structured completion criteria", () => {
  const goal = goalState.createGoalDefinition({
    objective: "重构 Capsule；完成标准：三大主题均通过 Playwright 测试；约束：保持兼容",
  });

  assert.equal(goal.schemaVersion, 3);
  assert.equal(goal.revision, 1);
  assert.ok(goal.criteria.length >= 1);
  assert.equal(goal.criteria[0].text, "三大主题均通过 Playwright 测试");
  assert.ok(goal.criteria.every((criterion) => criterion.status === "pending"));
  assert.deepEqual(goal.constraints, ["保持兼容"]);
});

test("Goal tool-result checkpoints stop only after every criterion has fresh evidence", () => {
  const goal = goalState.createGoalDefinition({
    objective: "更新两个模块并验证",
    definitionOfDone: [
      "修改 src/a.ts",
      "修改 src/b.ts",
      "运行类型检查通过",
    ],
  });

  const first = goalRuntime.evaluateGoalEvidenceCheckpoint({
    goal,
    iteration: 1,
    evidence: [],
    observations: [
      { name: "apply_patch", target: "src/a.ts", result: "Patch applied" },
      { name: "run_command", target: "npx tsc --noEmit", result: "exitCode: 0" },
    ],
    now: 100,
  });
  assert.equal(first.passed, false);
  assert.ok(first.reasons.some((reason) => reason.startsWith("criterion_evidence_required:")));

  const second = goalRuntime.evaluateGoalEvidenceCheckpoint({
    goal,
    iteration: 1,
    evidence: first.evidence,
    observations: [
      { name: "apply_patch", target: "src/b.ts", result: "Patch applied" },
    ],
    now: 200,
  });
  assert.equal(second.passed, false);
  assert.ok(second.reasons.includes("verification_stale_after_mutation"));

  const third = goalRuntime.evaluateGoalEvidenceCheckpoint({
    goal,
    iteration: 1,
    evidence: second.evidence,
    observations: [
      { name: "run_command", target: "npx tsc --noEmit", result: "exitCode: 0" },
    ],
    now: 300,
  });
  assert.equal(third.passed, true);
  assert.equal(third.reasons.length, 0);
  assert.equal(third.criteria.every((criterion) => criterion.status === "satisfied"), true);
});

test("Goal events use the session runtime key and remain on the owner turn", () => {
  assert.deepEqual(goalEventIdentity.resolveGoalEventOwnerIdentity({
    goal: { sessionKey: "/workspace:42", ownerTurnId: "turn-goal" },
    currentWorkspace: "/other",
    currentSessionId: 9,
    currentTurnId: "turn-current",
  }), {
    threadId: "/workspace:42",
    turnId: "turn-goal",
  });

  assert.deepEqual(goalEventIdentity.resolveGoalEventOwnerIdentity({
    goal: {},
    currentWorkspace: "/workspace",
    currentSessionId: 42,
    currentTurnId: "turn-current",
  }), {
    threadId: "/workspace:42",
    turnId: "turn-current",
  });
});

test("each Goal slice contract includes revision and bounded prior evidence mappings", () => {
  const goal = goalState.createGoalDefinition({ objective: "Fix the capsule and run lint" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "apply_patch", target: "src/components/ExecutionCapsule.tsx", result: "Done" },
    ],
  });
  const context = goalContext.buildGoalIterationSystemContext({
    goal,
    checkpoint: null,
    latestVerification: null,
    nextIteration: 2,
    language: "en",
    evidence,
  });
  assert.match(context, /\*\*Revision\*\*: 1/);
  assert.match(context, /Existing Structured Evidence/);
  assert.match(context, /ExecutionCapsule\.tsx/);
  assert.match(context, /criteria=criterion_1/);
});

test("Goal context promotes an explicit multi-subagent preference without making delegation a quota", () => {
  const goal = goalState.createGoalDefinition({
    objective: "修复启动白屏，可以开启多个subagent协同工作",
  });
  const context = goalContext.buildGoalIterationSystemContext({
    goal,
    checkpoint: null,
    latestVerification: null,
    nextIteration: 1,
    language: "zh",
  });

  assert.match(context, /子智能体协作偏好/);
  assert.match(context, /模型应先按目标与问题结构决定是否委派/);
  assert.match(context, /独立成功标准和明确收益/);
  assert.match(context, /不按目录凑数/);
  assert.match(context, /终态后永久关闭/);
  assert.match(context, /已验证的精简证据/);
});

test("tool result parsing accepts zero failures and rejects explicit failures", () => {
  assert.equal(goalRuntime.isGoalToolResultSuccessful("12 passed, 0 failed"), true);
  assert.equal(goalRuntime.isGoalToolResultSuccessful("0 errors"), true);
  assert.equal(goalRuntime.isGoalToolResultSuccessful("Tests failed: assertion mismatch"), false);
  assert.equal(goalRuntime.isGoalToolResultSuccessful('{"exitCode":1}'), false);
  assert.equal(goalRuntime.isGoalToolResultSuccessful("BROWSER_VALIDATION_FAILED: locator missing"), false);
});

test("Goal browser failures retain structured diagnostics and screenshot references", () => {
  const goal = goalState.createGoalDefinition({ objective: "Fix the editor and verify it in the browser" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 20,
    observations: [{
      name: "browser_evaluate",
      target: "http://localhost:1420/",
      success: false,
      result: `BROWSER_VALIDATION_FAILED: locator missing\n${JSON.stringify({
        ok: false,
        failureType: "validation_spec_error",
        failureReasons: ["missing_locator"],
        failureSummary: "click selector #new-file-btn was not found",
        screenshotPath: ".MAIN/browser-validation/failure.png",
        pageErrors: [],
        consoleErrors: [],
        assertions: [],
      })}`,
    }],
  });

  assert.equal(evidence[0].status, "failed");
  assert.match(evidence[0].summary, /validation_spec_error|missing_locator/);
  assert.match(evidence[0].summary, /#new-file-btn/);
  assert.deepEqual(evidence[0].references, [".MAIN/browser-validation/failure.png"]);
});

test("Goal desktop failures retain their structured blocker and screenshot reference", () => {
  const goal = goalState.createGoalDefinition({ objective: "Control MAIN and verify the native window" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 3,
    now: 30,
    observations: [{
      name: "computer_use",
      target: "MAIN",
      success: false,
      result: `DESKTOP_CONTROL_FAILED:\n${JSON.stringify({
        ok: false,
        failureType: "permission_required",
        failureReasons: ["Accessibility permission is required"],
        failureSummary: "Enable MAIN in macOS Accessibility settings",
        actions: [],
        assertions: [],
        screenshotPath: ".MAIN/desktop-validation/failure.png",
      })}`,
    }],
  });

  assert.equal(evidence[0].kind, "desktop");
  assert.equal(evidence[0].status, "failed");
  assert.match(evidence[0].summary, /permission_required/);
  assert.match(evidence[0].summary, /Accessibility/);
  assert.deepEqual(evidence[0].references, [".MAIN/desktop-validation/failure.png"]);
});

test("Goal outcome policy preserves explicit pause boundaries before slice auto-continuation", () => {
  assert.deepEqual(goalOutcomePolicy.resolveGoalInnerOutcomeDecision({
    status: "paused",
    stopReason: "execute_recovery_no_progress_limit",
    sliceBoundaryReached: true,
  }), {
    action: "paused",
    reason: "execute_recovery_no_progress_limit",
  });
  const protocol = goalOutcomePolicy.resolveGoalInnerOutcomeDecision({
    status: "stopped_no_action",
    stopReason: "required_tool_call_protocol_violation_after_change",
  });
  assert.equal(protocol.action, "recover");
  assert.equal(protocol.normalizedCause, "protocol_no_progress");

  const canonicalNoAction = goalOutcomePolicy.resolveGoalInnerOutcomeDecision({
    status: "paused",
    pauseKind: "no_action",
    stopReason: "execution_evidence_required",
  });
  assert.deepEqual(canonicalNoAction, {
    action: "recover",
    reason: "execution_evidence_required",
    normalizedCause: "no_action",
  });

  const canonicalError = goalOutcomePolicy.resolveGoalInnerOutcomeDecision({
    status: "completed",
    resultKind: "error",
    stopReason: "provider stream failed",
  });
  assert.equal(canonicalError.action, "recover");
  assert.equal(canonicalError.normalizedCause, "transient_provider_failure");

  const workflowSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );
  assert.match(workflowSource, /exactMaxIterationBoundary/);
  assert.doesNotMatch(
    workflowSource,
    /sliceBoundaryReached[\s\S]{0,260}deferredNonActionableStop\?\.\[1\]\s*===\s*"no_action"/,
    "a generic no-action/protocol pause must not be rewritten as an automatic Goal slice boundary",
  );
});

test("a completion marker without fresh execution evidence is only a candidate", () => {
  const goal = goalState.createGoalDefinition({ objective: "重构 Goal Runtime 并运行测试" });
  const result = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [],
    completionCandidate: true,
  });

  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("no_fresh_execution_evidence"));
  assert.ok(result.reasons.includes("mutation_evidence_required"));
  assert.ok(result.reasons.includes("verification_evidence_required"));
});

test("mutation goals require both a file change and a recognized verification result", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and verify with lint" });
  const fileOnly = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 100,
    observations: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
  });
  const genericCommand = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 200,
    observations: [{ name: "run_command", arguments: { command: "pwd" }, result: "ok" }],
  });

  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...fileOnly, ...genericCommand],
    completionCandidate: true,
  }).passed, false);

  const lintEvidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 300,
    observations: [{ name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" }],
  });
  const completed = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...fileOnly, ...lintEvidence],
    completionCandidate: true,
  });

  assert.equal(completed.passed, true);
  assert.ok(completed.criteria.every((criterion) => criterion.status === "satisfied"));
});

test("a test-or-typecheck completion criterion accepts either verified branch", () => {
  const goal = goalState.createGoalDefinition({
    objective: "修改 CSV 解析器。完成标准：源码已修改且运行测试或类型检查通过；约束：保持兼容",
  });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "replace_in_file", target: "src/hooks/useCsvParser.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npx tsc --noEmit" }, result: "0 errors" },
    ],
  });

  const result = goalRuntime.evaluateGoalCompletion({ goal, evidence, completionCandidate: true });
  assert.equal(result.passed, true);
  assert.equal(result.criteria[0].status, "satisfied");
  assert.equal(result.criteria[0].evidenceIds.length, 2);
});

test("editing a goal invalidates evidence from the previous revision", () => {
  const original = goalState.createGoalDefinition({ objective: "Fix the capsule and run tests" });
  const oldEvidence = goalRuntime.createGoalEvidenceEntries({
    goal: original,
    iteration: 1,
    observations: [
      { name: "apply_patch", target: "src/components/ChatArea.tsx", result: "Done" },
      { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
    ],
  });
  const edited = goalState.updateGoalDefinitionText(original, "Fix the capsule, tests, and light theme");
  const result = goalRuntime.evaluateGoalCompletion({ goal: edited, evidence: oldEvidence, completionCandidate: true });

  assert.equal(edited.revision, 2);
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("no_fresh_execution_evidence"));
});

test("a later passing verification supersedes an earlier failure for the same target", () => {
  const goal = goalState.createGoalDefinition({ objective: "Fix runtime and run npm test" });
  const fileEvidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 100,
    observations: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
  });
  const failedTest = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 200,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: '{"exitCode":1}' }],
  });
  const passingRetry = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 300,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: "14 passed, 0 failed" }],
  });

  const result = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...fileEvidence, ...failedTest, ...passingRetry],
    completionCandidate: true,
  });
  assert.equal(result.passed, true);
  assert.ok(!result.reasons.includes("verification_failed"));
});

test("a later mutation invalidates same-revision verification until validation runs again", () => {
  const goal = goalState.createGoalDefinition({ objective: "Fix runtime and verify with npm test" });
  const firstMutation = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 100,
    observations: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
  });
  const earlyVerification = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 200,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: "14 passed, 0 failed" }],
  });
  const laterMutation = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 300,
    observations: [{ name: "apply_patch", target: "src/lib/goalEngine.ts", result: "Done" }],
  });

  const stale = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...firstMutation, ...earlyVerification, ...laterMutation],
    completionCandidate: true,
  });
  assert.equal(stale.passed, false);
  assert.ok(stale.reasons.includes("verification_stale_after_mutation"));
  assert.ok(stale.reasons.includes("verification_evidence_required"));

  const finalVerification = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 400,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: "15 passed, 0 failed" }],
  });
  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...firstMutation, ...earlyVerification, ...laterMutation, ...finalVerification],
    completionCandidate: true,
  }).passed, true);
});

test("mutation criteria invalidate old validation even when the referential objective is generic", () => {
  const goal = goalState.createGoalDefinition({
    objective: "完成上述计划",
    sourceContext: "[unfinished_criteria]\n- 修改 Goal 状态机\n- 运行 npm test 验证",
  });
  const earlyVerification = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 100,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: "10 passed, 0 failed" }],
  });
  const laterMutation = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 200,
    observations: [{ name: "apply_patch", target: "src/lib/goalEngine.ts", result: "Done" }],
  });
  const result = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...earlyVerification, ...laterMutation],
    completionCandidate: true,
  });

  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("verification_stale_after_mutation"));
});

test("read-only repetition is still treated as no progress", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor the runtime" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  const iterations = [createIteration(1), createIteration(2), createIteration(3)];
  progress.totalIterationsUsed = 3;
  progress.iterations = iterations;
  progress.evidence = iterations.flatMap((iteration) => goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: iteration.index,
    observations: [{ name: "read_file", target: "src/lib/goalRuntime.ts", result: "content" }],
  }));

  const check = goalBudget.checkGoalBudget({
    goal,
    progress,
    budget: goalBudget.resolveGoalBudget({ maxNoProgressIterations: 3, userConfirmInterval: 0 }),
    recentIterations: iterations,
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "no_progress");
});

test("read-only shell inspection does not count as Goal execution progress", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor the runtime" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [{ name: "run_command", arguments: { command: "git status" }, result: "clean" }],
  });

  assert.equal(evidence[0].kind, "read");
  assert.equal(evidence[0].status, "observed");
  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal,
    evidence,
    completionCandidate: true,
  }).passed, false);
});

test("GoalTurnContract is revisioned, continuous, and asks for runtime-gated completion", () => {
  const goal = goalState.createGoalDefinition({
    objective: "实现持久目标并运行测试，可以开启多个 subagent 协同工作",
    iterationBudget: 25,
  });
  const contract = goalContext.buildGoalTurnContract({
    goal,
    checkpoint: null,
    latestVerification: null,
    nextIteration: 4,
    language: "zh",
  });

  assert.equal(contract.iteration, 4);
  assert.equal(contract.goalSliceId, `${goal.id}:slice:4`);
  assert.equal(contract.objective, goal.objective);
  assert.equal(contract.phase, "execute");
  assert.equal(contract.maxIterations, 25);
  assert.match(contract.cacheKey, new RegExp(`^${goal.id}:1:4:`));
  assert.match(contract.context, /同一个持续目标/);
  assert.doesNotMatch(contract.context, /连续执行 4\/25|迭代 4\/25/);
  assert.match(contract.context, /GOAL_COMPLETION_CANDIDATE/);
  assert.match(contract.context, /自主执行态/);
  assert.match(contract.context, /立即调用工具推进/);
  assert.match(contract.context, /子智能体协作偏好/);
  assert.doesNotMatch(contract.context, /Plan → Execute → Observe/);
  assert.match(contract.context, /不要在模型内部自行开启无限循环/);
  assert.match(contract.context, /不要修改 `.MAIN\/goals\/` 中的运行时状态文件/);
  assert.doesNotMatch(contract.context, /完成本轮任务后，更新/);
});

test("new Goal continuations begin in execute rather than plan phase", () => {
  const iteration = goalState.createGoalIteration(2, "goal-phase", 1);
  assert.equal(iteration.phase, "execute");
});

test("restoring an interrupted Goal pauses it and excludes offline time", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  progress.usage.activeDurationMs = 4_000;
  progress.usage.activeStartedAt = 10_000;
  const snapshot = {
    ...goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" }),
    updatedAt: 16_000,
  };

  const restored = goalRuntime.restoreGoalRuntimeSnapshot(snapshot, 100_000);
  assert.equal(restored.status, "paused");
  assert.equal(restored.goal.status, "paused");
  assert.equal(restored.phase, "re_plan");
  assert.equal(restored.progress.usage.activeDurationMs, 10_000);
  assert.equal(restored.progress.usage.activeStartedAt, null);
  assert.match(restored.pauseReason, /resume explicitly/);
});

test("normalizing a live Goal snapshot does not apply cold-start pause semantics", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  const snapshot = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });
  const normalized = goalRuntime.normalizeGoalRuntimeSnapshot(snapshot);

  assert.equal(normalized.status, "active");
  assert.equal(normalized.goal.status, "active");
  assert.equal(normalized.progress.usage.activeStartedAt, progress.usage.activeStartedAt);
});

function createEngineCallbacks(runAgentIteration) {
  const writes = [];
  const outcomes = [];
  const runtimeUpdates = [];
  return {
    writes,
    outcomes,
    runtimeUpdates,
    callbacks: {
      getPreferredLanguage: () => "en",
      getWorkspacePath: () => "/tmp/goal-runtime-test",
      runAgentIteration,
      writeFile: async (filePath, content) => writes.push({ filePath, content }),
      readFile: async () => null,
      isAborted: () => false,
      onGoalProgressUpdate: () => {},
      onGoalRuntimeUpdate: (runtime) => runtimeUpdates.push(runtime),
      onGoalIterationStart: () => {},
      onGoalIterationEnd: () => {},
      onGoalCheckpointSaved: () => {},
      onGoalUserConfirmNeeded: async () => false,
      onGoalOutcome: (outcome) => outcomes.push(outcome),
    },
  };
}

test("a paused Goal resumes in place with retained evidence and one-shot user guidance", async () => {
  const goal = goalState.createGoalDefinition({
    objective: "修复 src/main.js 并运行 npm run build",
    iterationBudget: 6,
  });
  goal.status = "awaiting_input";
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  progress.currentIteration = 1;
  progress.totalIterationsUsed = 1;
  progress.stopClass = "awaiting_input";
  progress.pauseReason = "awaiting_explicit_user_choice";
  progress.lastStopReason = "awaiting_explicit_user_choice";
  progress.continuation = goalContinuity.createGoalContinuationState({
    sourceIteration: 1,
    messages: [
      {
        role: "assistant",
        content: "Root cause confirmed: startup code dereferences a missing DOM element.",
        tool_calls: [{
          id: "read-main",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/main.js"}' },
        }],
      },
      {
        role: "tool",
        tool_call_id: "read-main",
        content: "const editor = document.getElementById('editor');",
      },
    ],
  });

  let observedInput;
  const debugEvents = [];
  const harness = createEngineCallbacks(async (input) => {
    observedInput = input;
    return {
      assistantText: "Applied the selected startup behavior and verified it. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [
        { name: "apply_patch", target: "src/main.js", result: "Done" },
        { name: "run_command", arguments: { command: "npm run build" }, result: "0 errors" },
      ],
      tokensUsed: 80,
      completed: true,
      outcomeStatus: "completed",
    };
  });
  harness.callbacks.onDebugEvent = (event, data) => debugEvents.push({ event, data });

  const outcome = await goalEngine.executeGoalLoop({
    goal,
    callbacks: harness.callbacks,
    existingProgress: progress,
    userGuidance: "采用欢迎页启动行为",
  });

  assert.equal(outcome.status, "completed");
  assert.equal(observedInput.goalTurnContract.goalId, goal.id);
  assert.match(observedInput.goalSystemContext, /修复 src\/main\.js 并运行 npm run build/);
  assert.match(observedInput.goalSystemContext, /采用欢迎页启动行为/);
  assert.equal(
    observedInput.continuation.messages.some((message) =>
      message.content.includes("Root cause confirmed")
    ),
    true,
  );
  assert.ok(debugEvents.some(({ event, data }) =>
    event === "goal_continuation_guidance_applied"
    && data?.previousStatus === "awaiting_input"
    && data?.retainedOperations === 1
  ));
});

test("preferred subagent work persists its structured preference through Goal contracts", async () => {
  const goal = goalState.createGoalDefinition({
    objective: "修复跨模块问题，可以开启多个subagent协同工作",
    iterationBudget: 4,
  });
  let observedContract = null;
  const harness = createEngineCallbacks(async (input) => {
    observedContract = input.goalTurnContract;
    return {
      assistantText: "Implemented and verified. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [
        { name: "apply_patch", target: "src/runtime.ts", result: "Done" },
        { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
      ],
      tokensUsed: 50,
      completed: true,
      outcomeStatus: "completed",
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });

  assert.equal(outcome.status, "completed");
  assert.equal(goal.subagentPreference, "preferred");
  assert.equal(observedContract.subagentPreference, "preferred");
  assert.match(observedContract.context, /model first decides from the goal and problem structure whether delegation helps/);
  assert.match(observedContract.context, /fresh one-shot agents only for narrow semantic tasks/);
  assert.match(observedContract.context, /never as directory-based filler/);
  assert.match(observedContract.context, /verified compact evidence only/);
});

test("Goal Engine completes only after a tool-backed mutation and verification slice", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Implemented and verified. GOAL_COMPLETION_CANDIDATE",
    toolCalls: [
      { name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
    ],
    tokensUsed: 120,
    completed: true,
    outcomeStatus: "completed",
  }));

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.iterationsUsed, 1);
  assert.equal(harness.outcomes.at(-1).status, "completed");
  assert.ok(harness.writes.some((write) => write.filePath.endsWith(`/.MAIN/goals/${goal.id}/state.json`)));
  assert.ok(harness.writes.some((write) => write.filePath.endsWith(`/.MAIN/goals/${goal.id}/evidence.jsonl`)));
});

test("a deleted Goal tombstone prevents the aborted loop from recreating persistence files", async () => {
  const workspace = "/tmp/goal-runtime-test";
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  const debugEvents = [];
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Implemented and verified. GOAL_COMPLETION_CANDIDATE",
    toolCalls: [
      { name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
    ],
    tokensUsed: 120,
    completed: true,
    outcomeStatus: "completed",
  }));
  harness.callbacks.onDebugEvent = (event, data) => debugEvents.push({ event, data });

  goalPersistence.markGoalRuntimeDeleted(workspace, goal.id);
  try {
    const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
    assert.equal(outcome.status, "completed");
    assert.equal(harness.writes.length, 0);
    assert.ok(debugEvents.some(({ event }) => event === "goal_persist_skipped_deleted"));
  } finally {
    goalPersistence.unmarkGoalRuntimeDeleted(workspace, goal.id);
  }
});

test("Goal Engine completes from verified evidence after a non-terminal provider stop without a model marker", async () => {
  const goal = goalState.createGoalDefinition({
    objective: "Update the parser. Definition of done: modify source and run typecheck",
    iterationBudget: 6,
  });
  const debugEvents = [];
  const harness = createEngineCallbacks(async () => ({
    assistantText: "The parser was updated and typecheck passed.",
    toolCalls: [
      { name: "apply_patch", target: "src/hooks/useCsvParser.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npx tsc --noEmit" }, result: "0 errors" },
    ],
    tokensUsed: 120,
    completed: false,
    outcomeStatus: "stopped_no_output",
    stopReason: "no_output",
    sliceBoundaryReached: false,
  }));
  harness.callbacks.onDebugEvent = (event, data) => debugEvents.push({ event, data });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.iterationsUsed, 1);
  assert.ok(debugEvents.some(({ event }) => event === "goal_runtime_evidence_completion_candidate"));
  assert.equal(
    debugEvents.find(({ event }) => event === "goal_continuation_start")?.data?.continuationId,
    `${goal.id}:slice:1`,
  );
  assert.ok(debugEvents.some(({ event, data }) =>
    event === "goal_completion_accepted"
    && data?.candidateSource === "runtime_evidence"
    && data?.continuationId === `${goal.id}:slice:1`
  ));
});

test("Goal Engine retries a normalized recoverable error and blocks on the third occurrence", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    runs += 1;
    return {
      assistantText: "Unable to finish this slice",
      toolCalls: [],
      tokensUsed: 40,
      completed: false,
      outcomeStatus: "error",
      error: "provider stream failed",
    };
  });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(runs, 3);
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.reason, /provider stream failed/);
  assert.equal(outcome.finalCheckpoint.iteration, 3);
  assert.equal(harness.runtimeUpdates.at(-1).status, "blocked");
  assert.equal(harness.runtimeUpdates.at(-1).progress.recoveryState.consecutiveCount, 3);
});

test("Goal Engine resumes from retained conclusions after a recoverable stream failure", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Update Goal Runtime and run lint", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async (input) => {
    runs += 1;
    if (runs === 1) {
      const error = new Error("provider stream failed");
      error.goalContinuationState = goalContinuity.createGoalContinuationState({
        sourceIteration: 1,
        messages: [
          { role: "assistant", content: "Root cause confirmed in `src/lib/goalRuntime.ts`; the next action is the patch." },
        ],
      });
      error.goalIterationUsage = { modelIterations: 1, toolCalls: 0, tokensUsed: 30, estimatedTokens: true };
      throw error;
    }

    assert.equal(input.continuation.messages[0].content.includes("Root cause confirmed"), true);
    return {
      assistantText: "Patched and linted. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [
        { name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" },
        { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
      ],
      tokensUsed: 60,
      completed: true,
      outcomeStatus: "completed",
    };
  });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(runs, 2);
  assert.equal(harness.runtimeUpdates.some((runtime) =>
    runtime.progress.continuation?.messages[0]?.content.includes("Root cause confirmed")
  ), true);
});

test("Goal Engine carries conclusions and operation context across internal continuations", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  const seenContracts = [];
  let runs = 0;
  const harness = createEngineCallbacks(async (input) => {
    runs += 1;
    seenContracts.push(input.goalTurnContract);
    if (runs === 1) {
      const continuation = goalContinuity.createGoalContinuationState({
        sourceIteration: 1,
        messages: [
          { role: "assistant", content: "Concrete finding: `src/lib/goalRuntime.ts` still needs lint verification." },
          {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call-patch",
              type: "function",
              function: { name: "apply_patch", arguments: JSON.stringify({ patch: "*** Update File: src/lib/goalRuntime.ts" }) },
            }],
          },
          { role: "tool", tool_call_id: "call-patch", content: "Done" },
        ],
      });
      return {
        assistantText: "I have finished reading the relevant files.\n\nConcrete finding: `src/lib/goalRuntime.ts` was patched and still needs lint verification.\n\n## Next\n- Run lint",
        toolCalls: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
        tokensUsed: 80,
        completed: true,
        outcomeStatus: "completed",
        continuation,
      };
    }
    assert.equal(input.continuation.messages[0].content.includes("Concrete finding"), true);
    assert.equal(input.continuation.messages[1].tool_calls[0].function.name, "apply_patch");
    assert.equal(input.continuation.messages[2].content, "Done");
    return {
      assistantText: "Lint passed. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [{ name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" }],
      tokensUsed: 40,
      completed: true,
      outcomeStatus: "completed",
    };
  });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(runs, 2);
  assert.equal(seenContracts[1].iteration, 2);
  assert.match(seenContracts[1].context, /Continuation 1/);
  assert.match(seenContracts[1].context, /Concrete finding/);
  assert.match(seenContracts[1].context, /src\/lib\/goalRuntime\.ts/);
  assert.match(seenContracts[1].context, /Run lint/);
});

test("Goal continuation transport preserves complete tool pairs and strips runtime control messages", () => {
  const state = goalContinuity.createGoalContinuationState({
    sourceIteration: 3,
    messages: [
      { role: "system", content: "large regenerated system prompt" },
      { role: "user", content: '[goal_continuation goal_id="g" index="3"]\ncontinue\n[/goal_continuation]' },
      { role: "user", content: "EXECUTE_RECOVERY: Now immediately continue using tools." },
      { role: "assistant", content: "The root cause is in `src/main.ts:L120`: `editor.getValue()` is invalid for a textarea." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "read-1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/main.ts","start_line":110}' },
        }],
        reasoning_content: "private reasoning must not persist",
      },
      { role: "tool", tool_call_id: "read-1", content: "const editor = document.querySelector('textarea')" },
      { role: "tool", tool_call_id: "orphan", content: "orphan result" },
    ],
  });

  assert.equal(state.messages.some((message) => message.role === "system"), false);
  assert.equal(state.messages.some((message) => message.content.includes("goal_continuation")), false);
  assert.equal(state.messages.some((message) => message.content.includes("EXECUTE_RECOVERY")), false);
  assert.equal(state.messages.some((message) => message.content.includes("private reasoning")), false);
  assert.equal(state.messages.some((message) => message.tool_call_id === "orphan"), false);
  assert.equal(state.messages.find((message) => message.tool_calls)?.tool_calls[0].function.arguments.includes("src/main.ts"), true);
  assert.equal(state.messages.find((message) => message.role === "tool")?.content.includes("textarea"), true);
  assert.match(state.memoryPacket, /src\/main\.ts/);
});

test("Goal continuation drops expired recovery tool errors without losing real tool evidence", () => {
  const state = goalContinuity.createGoalContinuationState({
    sourceIteration: 4,
    messages: [
      {
        role: "assistant",
        content: "I need both the source and the page shell before editing.",
        tool_calls: [
          {
            id: "read-source",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/main.js"}' },
          },
          {
            id: "read-page",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"index.html"}' },
          },
          {
            id: "deferred-edit",
            type: "function",
            function: { name: "apply_patch", arguments: '{"patch":"*** Begin Patch"}' },
          },
          {
            id: "persisted-browser-retry",
            type: "function",
            function: { name: "browser_evaluate", arguments: '{"url":"http://localhost:1420/"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "read-source", content: "const app = document.querySelector('#app');" },
      {
        role: "tool",
        tool_call_id: "read-page",
        content: [
          '[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"blocked","tool_call_id":"read-page","tool":"read_file","target":"index.html"}',
          "Error: READ_FILE_NOT_AVAILABLE_IN_RECOVERY: read_file is not exposed in the current goal recovery step.",
        ].join("\n"),
      },
      {
        role: "tool",
        tool_call_id: "deferred-edit",
        content: "EXECUTE_RECOVERY_BATCH_DEFERRED: consume the selected read before editing.",
      },
      {
        role: "tool",
        tool_call_id: "persisted-browser-retry",
        content: "BROWSER_VALIDATION_PERSISTED_FAILURE_REUSED: unchanged stable failure was not executed.",
      },
      {
        role: "assistant",
        content: "A missing file is durable workspace evidence.",
        tool_calls: [{
          id: "read-missing",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"missing.html"}' },
        }],
      },
      { role: "tool", tool_call_id: "read-missing", content: "ENOENT: missing.html" },
    ],
  });

  const restored = goalContinuity.restoreGoalContinuationMessages(state);
  const callIds = restored.flatMap((message) => (message.tool_calls || []).map((call) => call.id));
  const resultIds = restored.flatMap((message) => message.tool_call_id ? [message.tool_call_id] : []);

  assert.deepEqual(callIds.sort(), ["read-missing", "read-source"]);
  assert.deepEqual(resultIds.sort(), ["read-missing", "read-source"]);
  assert.equal(restored.some((message) => message.content.includes("READ_FILE_NOT_AVAILABLE_IN_RECOVERY")), false);
  assert.equal(restored.some((message) => message.content.includes("EXECUTE_RECOVERY_BATCH_DEFERRED")), false);
  assert.equal(restored.some((message) => message.content.includes("BROWSER_VALIDATION_PERSISTED_FAILURE_REUSED")), false);
  assert.equal(restored.some((message) => message.content.includes("querySelector")), true);
  assert.equal(restored.some((message) => message.content.includes("ENOENT")), true);
  assert.doesNotMatch(state.memoryPacket || "", /READ_FILE_NOT_AVAILABLE_IN_RECOVERY/);
});

test("Goal continuation prompt makes the current tool surface authoritative", () => {
  const english = goalContinuity.buildGoalContinuationPrompt({
    language: "en",
    goalId: "goal-tools",
    continuationIndex: 2,
  });
  const chinese = goalContinuity.buildGoalContinuationPrompt({
    language: "zh",
    goalId: "goal-tools",
    continuationIndex: 2,
  });

  assert.match(english, /tools exposed for this continuation are authoritative/i);
  assert.match(english, /temporary tool-unavailable recovery result has expired/i);
  assert.match(english, /one fixed action order/i);
  assert.match(chinese, /以本次实际开放的工具为准/);
  assert.match(chinese, /已经失效/);
  assert.match(chinese, /遵循固定行动顺序/);
});

test("Goal continuation restores the unfinished recovery phase across slices", () => {
  const stateFor = (toolCalls, results) => goalContinuity.createGoalContinuationState({
    sourceIteration: 2,
    messages: [
      {
        role: "assistant",
        content: "Continue the file-change goal.",
        tool_calls: toolCalls.map((call, index) => ({
          id: `call-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })),
      },
      ...results.map((content, index) => ({
        role: "tool",
        tool_call_id: `call-${index}`,
        content,
      })),
    ],
  });

  const afterRead = stateFor(
    [{ name: "read_file", arguments: { path: "src/App.tsx" } }],
    ["---CONTENT START---\nexport const app = true;\n---CONTENT END---"],
  );
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    afterRead,
    { mutationRequired: true },
  ), null, "a legacy plain read must not invent recovery at a slice boundary");

  const persistedAfterRead = goalContinuity.createGoalContinuationState({
    sourceIteration: 2,
    messages: afterRead.messages,
    executeRecoveryState: {
      mode: "mutation_first",
      reason: "recovery_context_observed",
      expectedTarget: "src/App.tsx",
    },
  });
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    persistedAfterRead,
    { mutationRequired: true },
  ), "mutation_first");

  const afterMutation = stateFor(
    [{ name: "apply_patch", arguments: { patch: "update src/App.tsx" } }],
    ['{"path":"src/App.tsx","changed":true}'],
  );
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    afterMutation,
    { mutationRequired: true },
  ), "validation_only");

  const afterValidation = stateFor(
    [
      { name: "apply_patch", arguments: { patch: "update src/App.tsx" } },
      { name: "run_command", arguments: { command: "npm test" } },
    ],
    ['{"path":"src/App.tsx","changed":true}', '{"exitCode":0,"stdout":"passed"}'],
  );
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    afterValidation,
    { mutationRequired: true },
  ), null);

  const afterMismatch = stateFor(
    [{ name: "replace_in_file", arguments: { path: "src/App.tsx" } }],
    ["Error: search_text mismatch; no match found"],
  );
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    afterMismatch,
    { mutationRequired: true },
  ), null, "legacy localized failure prose must not invent a recovery transaction");

  for (const noEffectResult of [
    '{"noOp":true}',
    "empty_change",
    "identical_content",
    "no changes",
  ]) {
    const legacyNoEffect = stateFor(
      [
        { name: "replace_in_file", arguments: { path: "src/App.tsx" } },
        { name: "read_file", arguments: { path: "src/App.tsx" } },
        { name: "replace_in_file", arguments: { path: "src/App.tsx" } },
      ],
      [
        "Error: search_text mismatch; no match found",
        "current target context",
        noEffectResult,
      ],
    );
    assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
      legacyNoEffect,
      { mutationRequired: true },
    ), null, `${noEffectResult} must not invent recovery from legacy prose`);
  }
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    persistedAfterRead,
    { mutationRequired: false },
  ), null, "non-mutation goals must not inherit a file-edit phase");

  assert.deepEqual(goalContinuity.resolveGoalContinuationExecuteRecoveryState(
    persistedAfterRead,
    { mutationRequired: true },
  ), {
    mode: "mutation_first",
    reason: "recovery_context_observed",
    expectedTarget: "src/App.tsx",
    phase: "mutation",
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    readLease: null,
    sourceObservationKey: null,
    decisionCheckpoint: null,
  });
});

test("Goal continuation preserves the exact recovery contract snapshot across slices", () => {
  const recoveryState = {
    mode: "patch_recovery_read",
    reason: "patch_context_required",
    expectedTarget: "src/toolbar.ts",
    attempts: 4,
    phaseNoProgressCount: 3,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    readLease: {
      purpose: "patch_recovery",
      target: "src/toolbar.ts",
      requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
      observationKey: "src/toolbar.ts:205-256:v7",
      observedVersion: "v7",
      mismatchFingerprint: "patch_mismatch::src/toolbar.ts::invalid_patch",
      state: "active",
    },
    sourceObservationKey: "src/toolbar.ts:205-256:v7",
    decisionCheckpoint: {
      expectedTarget: "src/toolbar.ts",
      sourceObservationKey: "src/toolbar.ts:205-256:v7",
      nextRequiredCapability: "targeted_read",
      evidenceVersion: "v7",
      planTaskId: "task-toolbar",
      requirementRef: "REQ-TOOLBAR",
      pendingFiniteValidation: { command: "npm test", cwd: "." },
      validationMutationReopenCount: 2,
      validationMutationReopenFingerprints: [
        "tool:replace_in_file|target:src/toolbar.ts|locus:11111111|requirement:req-toolbar",
        "tool:replace_in_file|target:src/toolbar.ts|locus:22222222|requirement:req-toolbar",
      ],
      objectiveMutationEvidence: [{
        target: "src/toolbar.ts",
        requirementRef: "REQ-TOOLBAR",
      }],
      objectiveClosurePending: true,
      browserFailureFingerprint: "browser-failure-v1",
      browserFailureCallSignature: "browser_evaluate::exact-v1",
      browserFailureDetail: "selector #open was not found",
      browserFailedLocator: "#open",
      browserLocatorCandidates: ["#open-document"],
      browserRequestedUrl: "http://localhost:1420/",
    },
  };
  const first = goalContinuity.createGoalContinuationState({
    sourceIteration: 5,
    messages: [{ role: "assistant", content: "Resume the exact source window." }],
    executeRecoveryState: recoveryState,
    now: 100,
  });
  const second = goalContinuity.createGoalContinuationState({
    sourceIteration: 6,
    previous: first,
    messages: [{ role: "assistant", content: "Continue without losing the lease." }],
    now: 200,
  });

  const expected = {
    ...recoveryState,
    phase: "context",
  };
  assert.deepEqual(first.executeRecoveryState, expected);
  assert.deepEqual(second.executeRecoveryState, expected);
  assert.deepEqual(goalContinuity.resolveGoalContinuationExecuteRecoveryState(
    second,
    { mutationRequired: true },
  ), expected);
});

test("Goal continuation uses the core segmented-read and targeting normalizers", () => {
  const state = goalContinuity.createGoalContinuationState({
    sourceIteration: 8,
    messages: [{ role: "assistant", content: "Continue the reviewed range." }],
    executeRecoveryState: {
      mode: "patch_recovery_read",
      reason: "reviewed_range_incomplete",
      expectedTarget: "src/main.js",
      readLease: {
        purpose: "plan_line_context",
        target: "src/main.js",
        requestedRange: { startLine: 381, endLine: 900, maxLines: 520 },
        requiredRange: { startLine: 205, endLine: 900, maxLines: 696 },
        coveredRanges: [{ startLine: 205, endLine: 380 }],
        coverageMode: "segmented_exact",
        observationKeys: ["main:205-380:v1"],
        observedVersion: "v1",
        state: "available",
      },
      decisionCheckpoint: {
        expectedTarget: "src/main.js",
        sourceObservationKey: "main:205-380:v1",
        nextRequiredCapability: "targeting",
        evidenceVersion: "v1",
      },
    },
  });
  assert.equal(state.executeRecoveryState.readLease.purpose, "plan_line_context");
  assert.equal(state.executeRecoveryState.readLease.coverageMode, "segmented_exact");
  assert.deepEqual(state.executeRecoveryState.readLease.requiredRange, {
    startLine: 205,
    endLine: 900,
    maxLines: 696,
  });
  assert.deepEqual(state.executeRecoveryState.readLease.coveredRanges, [
    { startLine: 205, endLine: 380 },
  ]);
  assert.deepEqual(state.executeRecoveryState.readLease.observationKeys, ["main:205-380:v1"]);
  assert.equal(state.executeRecoveryState.decisionCheckpoint.nextRequiredCapability, "targeting");
});

test("Goal continuation preserves recover_process as the next required capability", () => {
  const state = goalContinuity.createGoalContinuationState({
    sourceIteration: 7,
    messages: [{ role: "assistant", content: "Recover the failed foreground process." }],
    executeRecoveryState: {
      mode: "validation_only",
      reason: "foreground_process_exited",
      expectedTarget: "npm run dev",
      phase: "reconcile",
      decisionCheckpoint: {
        expectedTarget: "npm run dev",
        sourceObservationKey: null,
        nextRequiredCapability: "recover_process",
        evidenceVersion: "pty-generation-4",
      },
    },
    now: 300,
  });
  const restored = goalContinuity.resolveGoalContinuationExecuteRecoveryState(
    state,
    { mutationRequired: true },
  );

  assert.equal(restored.decisionCheckpoint.nextRequiredCapability, "recover_process");
  assert.equal(restored.phase, "reconcile");
});

test("Goal continuation treats structured feedback status as authoritative", () => {
  const envelope = ({ status, id, tool, target, body }) => [
    `[MAIN_TOOL_FEEDBACK_V1]${JSON.stringify({
      version: 1,
      status,
      tool_call_id: id,
      tool,
      target,
    })}`,
    body,
  ].join("\n");
  const stateFor = (status, tool = "read_file", body = "current file content") =>
    goalContinuity.createGoalContinuationState({
      sourceIteration: 2,
      messages: [
        {
          role: "assistant",
          content: "Continue.",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: tool, arguments: '{"path":"src/App.tsx"}' },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: envelope({ status, id: "call-1", tool, target: "src/App.tsx", body }),
        },
      ],
    });

  for (const status of ["failed", "blocked", "declined", "cached", "no_effect_mutation", "no_op"]) {
    assert.equal(
      goalContinuity.resolveGoalContinuationExecuteRecoveryState(
        stateFor(status),
        { mutationRequired: true },
      ),
      null,
      `${status} must not be replayed as a fresh read`,
    );
  }

  const misleadingFailure = stateFor("failed", "read_file", "export const app = true;");
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    misleadingFailure,
    { mutationRequired: true },
  ), null, "a success-looking body cannot override a failed envelope status");

  const misleadingSuccess = stateFor("completed", "read_file", "Error: stale legacy text");
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    misleadingSuccess,
    { mutationRequired: true },
  ), null, "a completed plain read is valid evidence but must not invent recovery without a runtime snapshot");
});

test("Goal continuation restores one target-scoped recovery transaction", () => {
  const envelope = ({ status = "completed", id, tool, target, body }) => [
    `[MAIN_TOOL_FEEDBACK_V1]${JSON.stringify({
      version: 1,
      status,
      tool_call_id: id,
      tool,
      target,
    })}`,
    body,
  ].join("\n");
  const createState = (operations) => goalContinuity.createGoalContinuationState({
    sourceIteration: 3,
    messages: operations.flatMap((operation, index) => {
      const id = `call-${index}`;
      return [
        {
          role: "assistant",
          content: operation.assistant || "Continue the same transaction.",
          tool_calls: [{
            id,
            type: "function",
            function: {
              name: operation.tool,
              arguments: JSON.stringify(operation.arguments || {}),
            },
          }],
        },
        {
          role: "tool",
          tool_call_id: id,
          content: envelope({
            status: operation.status || "completed",
            id,
            tool: operation.tool,
            target: operation.target || "",
            body: operation.body || "",
          }),
        },
      ];
    }),
  });

  const afterTargetedRead = createState([
    {
      tool: "replace_in_file",
      arguments: { path: "/workspace/src/App.tsx" },
      target: "/workspace/src/App.tsx",
      status: "failed",
      body: "search_text mismatch; no match found",
    },
    {
      tool: "read_file",
      arguments: { path: "src/Other.tsx" },
      target: "src/Other.tsx",
      body: "unrelated context",
    },
    {
      tool: "read_file",
      arguments: { path: "src/App.tsx" },
      target: "src/App.tsx",
      body: "Error: stale legacy text inside a completed structured result",
    },
  ]);
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryState(
    afterTargetedRead,
    { mutationRequired: true },
  ), null, "tool prose without a persisted contract must not recreate hidden recovery state");

  const noEffectMutation = createState([
    {
      tool: "replace_in_file",
      arguments: { path: "src/App.tsx" },
      target: "src/App.tsx",
      status: "failed",
      body: "search_text mismatch; no match found",
    },
    {
      tool: "read_file",
      arguments: { path: "src/App.tsx" },
      target: "src/App.tsx",
      body: "current target context",
    },
    {
      tool: "replace_in_file",
      arguments: { path: "src/App.tsx" },
      target: "src/App.tsx",
      status: "no_effect_mutation",
      body: "Done",
    },
  ]);
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    noEffectMutation,
    { mutationRequired: true },
  ), null, "a structured no-effect result cannot create a transaction without a persisted checkpoint");
});

test("Goal continuation uses live verification semantics and does not reopen after validation", () => {
  const envelope = ({ status = "completed", id, tool, target = "", body = "" }) => [
    `[MAIN_TOOL_FEEDBACK_V1]${JSON.stringify({
      version: 1,
      status,
      tool_call_id: id,
      tool,
      target,
    })}`,
    body,
  ].join("\n");
  const stateFor = (operations) => goalContinuity.createGoalContinuationState({
    sourceIteration: 4,
    messages: operations.flatMap((operation, index) => {
      const id = `verify-${index}`;
      return [
        {
          role: "assistant",
          content: "Continue.",
          tool_calls: [{
            id,
            type: "function",
            function: { name: operation.tool, arguments: JSON.stringify(operation.arguments || {}) },
          }],
        },
        {
          role: "tool",
          tool_call_id: id,
          content: envelope({ ...operation, id }),
        },
      ];
    }),
  });
  const mutation = {
    tool: "replace_in_file",
    arguments: { path: "src/App.tsx" },
    target: "src/App.tsx",
    body: "updated",
  };

  for (const nonVerification of [
    { tool: "execute_command", body: '{"running":true}' },
    { tool: "send_pty_input", body: "npm test" },
    { tool: "read_pty_tail", body: '{"running":true,"output":"starting"}' },
    { tool: "git_diff", body: "diff --git a/src/App.tsx b/src/App.tsx" },
    { tool: "clear_pty_buffer", body: "cleared" },
  ]) {
    assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
      stateFor([mutation, nonVerification]),
      { mutationRequired: true },
    ), "validation_only", `${nonVerification.tool} must not close validation`);
  }

  const readyPty = stateFor([
    mutation,
    {
      tool: "read_pty_tail",
      body: '{"running":true,"output":"Local: http://localhost:1420/ ready in 200 ms"}',
    },
  ]);
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    readyPty,
    { mutationRequired: true },
  ), null, "a ready PTY observation closes validation");

  const failedCommand = stateFor([
    mutation,
    { tool: "run_command", status: "failed", body: '{"exitCode":0,"stdout":"passed"}' },
  ]);
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryMode(
    failedCommand,
    { mutationRequired: true },
  ), "validation_only", "failed envelope status wins over success-looking command output");

  const readAfterVerifiedMutation = stateFor([
    mutation,
    { tool: "run_command", body: '{"exitCode":0,"stdout":"passed"}' },
    {
      tool: "read_file",
      arguments: { path: "src/App.tsx" },
      target: "src/App.tsx",
      body: "post-validation inspection",
    },
  ]);
  assert.equal(goalContinuity.resolveGoalContinuationExecuteRecoveryState(
    readAfterVerifiedMutation,
    { mutationRequired: true },
  ), null, "ordinary post-validation reads must not reopen a completed transaction");
});

test("Goal runtime normalization preserves durable continuation memory idempotently", () => {
  const goal = goalState.createGoalDefinition({ objective: "Continue one persistent task" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  progress.continuation = goalContinuity.createGoalContinuationState({
    sourceIteration: 2,
    messages: [
      { role: "assistant", content: "Keep this exact conclusion about `src/lib/goalRuntime.ts`." },
    ],
  });
  progress.continuation.memoryPacket = "durable older operation memory";
  progress.continuation.executeRecoveryState = {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: "src/lib/goalRuntime.ts",
  };
  const snapshot = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });

  const once = goalRuntime.normalizeGoalRuntimeSnapshot(snapshot);
  const twice = goalRuntime.normalizeGoalRuntimeSnapshot(once);

  assert.equal(once.progress.continuation.memoryPacket, "durable older operation memory");
  assert.equal(twice.progress.continuation.memoryPacket, once.progress.continuation.memoryPacket);
  assert.deepEqual(twice.progress.continuation.messages, once.progress.continuation.messages);
  assert.deepEqual(twice.progress.continuation.executeRecoveryState, {
    mode: "validation_only",
    reason: "recovery_mutation_observed",
    expectedTarget: "src/lib/goalRuntime.ts",
    phase: "validation",
    phaseNoProgressCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    readLease: null,
    sourceObservationKey: null,
    decisionCheckpoint: null,
  });
});

test("Goal runtime normalization removes stale recovery restrictions from persisted memory", () => {
  const goal = goalState.createGoalDefinition({ objective: "Resume a goal with migrated memory" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  progress.continuation = goalContinuity.createGoalContinuationState({
    sourceIteration: 3,
    messages: [
      { role: "assistant", content: "The next durable action is editing `src/main.ts`." },
    ],
  });
  progress.continuation.memoryPacket = [
    "Historical compacted context",
    "READ_FILE_NOT_AVAILABLE_IN_RECOVERY: read_file was hidden in a prior loop.",
  ].join("\n");
  progress.continuation.compacted = true;
  const snapshot = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });

  const normalized = goalRuntime.normalizeGoalRuntimeSnapshot(snapshot);
  assert.doesNotMatch(normalized.progress.continuation.memoryPacket || "", /READ_FILE_NOT_AVAILABLE_IN_RECOVERY/);
  assert.match(normalized.progress.continuation.memoryPacket || "", /src\/main\.ts/);
  assert.equal(normalized.progress.continuation.compacted, true);

  const continued = goalContinuity.createGoalContinuationState({
    sourceIteration: 4,
    previous: progress.continuation,
    messages: [{ role: "assistant", content: "Keep the new durable conclusion." }],
  });
  assert.doesNotMatch(continued.memoryPacket || "", /READ_FILE_NOT_AVAILABLE_IN_RECOVERY/);
  assert.match(continued.memoryPacket || "", /new durable conclusion/i);
  assert.equal(
    goalContinuity.sanitizeGoalContinuationMemoryPacket(
      'Evidence:\n- const marker = "READ_FILE_NOT_AVAILABLE_IN_RECOVERY:";',
    ),
    'Evidence:\n- const marker = "READ_FILE_NOT_AVAILABLE_IN_RECOVERY:";',
    "source code mentioning the legacy marker is not transient runtime control",
  );
});

test("Goal continuation compaction keeps bounded complete tool protocol groups", () => {
  const messages = [];
  for (let index = 0; index < 80; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: `call-${index}`,
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: `src/file-${index}.ts` }) },
      }],
    });
    messages.push({ role: "tool", tool_call_id: `call-${index}`, content: `content-${index}` });
  }
  messages.push({ role: "assistant", content: "Latest concrete conclusion must survive compaction." });

  const state = goalContinuity.createGoalContinuationState({ sourceIteration: 4, messages });
  const callIds = new Set(state.messages.flatMap((message) =>
    (message.tool_calls || []).map((call) => call.id)
  ));
  const resultIds = new Set(state.messages.flatMap((message) =>
    message.tool_call_id ? [message.tool_call_id] : []
  ));

  assert.equal(state.compacted, true);
  assert.equal(state.messages.length <= 72, true);
  assert.deepEqual([...callIds].sort(), [...resultIds].sort());
  assert.equal(state.messages.at(-1).content.includes("Latest concrete conclusion"), true);

  const next = goalContinuity.createGoalContinuationState({
    sourceIteration: 5,
    previous: { ...state, messages: state.messages.slice(-1) },
    messages: [
      state.messages.at(-1),
      { role: "assistant", content: "One more conclusion." },
    ],
  });
  assert.equal(next.compacted, true);
  assert.match(next.memoryPacket, /Latest concrete conclusion|One more conclusion/);
});

test("periodic user confirmation pause is persisted before Goal Engine returns", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Analyze a large repository", iterationBudget: 10 });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  progress.totalIterationsUsed = 2;
  progress.currentIteration = 2;
  const harness = createEngineCallbacks(async () => {
    throw new Error("agent iteration should not run before confirmation");
  });

  const outcome = await goalEngine.executeGoalLoop({
    goal,
    callbacks: harness.callbacks,
    existingProgress: progress,
    budgetOverrides: { userConfirmInterval: 2, maxIterations: 10 },
  });
  assert.equal(outcome.status, "awaiting_input");
  assert.ok(harness.writes.length >= 3);
  assert.ok(harness.writes.some((write) => write.filePath.endsWith(`/.MAIN/goals/${goal.id}/progress.md`)));
  assert.equal(harness.runtimeUpdates.at(-1).status, "awaiting_input");
});

test("Goal v3 keeps a canonical objective and bounded prior-turn source context", () => {
  const wrapper = [
    "[turn_intake]",
    "workflowMode: edit",
    "imageParts: 0",
    "priority: internal runtime instruction that must not become the objective",
    "[user_request]",
    "修复这些问题",
    "[/user_request]",
    "[/turn_intake]",
  ].join("\n");
  const goal = goalState.createGoalDefinition({ objective: wrapper });

  assert.equal(goal.objective, "修复这些问题");
  assert.equal(goal.rawText, "修复这些问题");
  assert.ok(goal.sourceContext.length <= goalState.GOAL_SOURCE_CONTEXT_MAX_CHARS);
  assert.match(goal.sourceContext, /workflowMode: edit/);
  assert.doesNotMatch(goal.sourceContext, /priority:|\[turn_intake\]|internal runtime instruction/);
});

test("Goal source context snapshots retain prior canonical user and assistant conclusions", () => {
  const sourceContext = goalSourceContext.buildGoalSourceContextSnapshot({
    objective: "修复这些问题",
    agentMessages: [
      { role: "system", content: "runtime system prompt" },
      { role: "user", content: "[turn_intake]\n[user_request]\n先分析 Plan 渲染问题\n[/user_request]\n[/turn_intake]" },
      { role: "assistant", content: "Plan conclusion: the final artifact was not materialized." },
      { role: "tool", content: "large tool payload", tool_call_id: "tool-1" },
    ],
    conversationTurns: [{ summary: "上一轮确认：仅在 ChatArea 渲染了文本。", status: "done" }],
  });

  assert.match(sourceContext, /先分析 Plan 渲染问题/);
  assert.match(sourceContext, /Plan conclusion/);
  assert.match(sourceContext, /仅在 ChatArea 渲染了文本/);
  assert.doesNotMatch(sourceContext, /runtime system prompt|large tool payload|\[turn_intake\]/);
  assert.ok(sourceContext.length <= goalState.GOAL_SOURCE_CONTEXT_MAX_CHARS);
});

test("referential Goal expands durable unfinished work and Plan artifacts into separate criteria", () => {
  const sourceContext = goalSourceContext.buildGoalSourceContextSnapshot({
    objective: "修复这些问题",
    agentMessages: [],
    conversationTurns: [{
      summary: "上一轮尚未完成。",
      durableContext: {
        schemaVersion: 1,
        turnId: "turn-prior",
        visibleUserMessages: ["修复 Plan 和 Goal"],
        finalAssistantAnswer: "仍有两项待处理。",
        execution: {
          decisions: [],
          modifiedFiles: [],
          validations: [],
          failures: [],
          unfinished: ["修复 Plan 审批身份绑定", "验证 Goal slice 自动续跑"],
          artifacts: [".MAIN/plans/plan.md"],
        },
        committedAt: 1,
      },
    }],
    planArtifacts: [{
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: "# Plan\n\n- 修复 Plan 审批身份绑定\n- 验证 Goal slice 自动续跑",
    }],
  });
  const goal = goalState.createGoalDefinition({ objective: "修复这些问题", sourceContext });

  assert.equal(goal.criteriaReviewRequired, false);
  assert.equal(goal.status, "active");
  assert.deepEqual(goal.definitionOfDone, ["修复 Plan 审批身份绑定", "验证 Goal slice 自动续跑"]);
  assert.equal(goal.criteria.length, 2);
});

test("referential Goal without structured source criteria pauses before any agent slice", async () => {
  const goal = goalState.createGoalDefinition({ objective: "修复这些问题" });
  assert.equal(goal.criteriaReviewRequired, true);
  assert.equal(goal.status, "awaiting_input");
  let iterations = 0;
  const harness = createEngineCallbacks(async () => {
    iterations += 1;
    throw new Error("ambiguous Goal must not execute");
  });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(iterations, 0);
  assert.equal(outcome.status, "awaiting_input");
  assert.equal(outcome.stopClass, "awaiting_input");
  assert.equal(outcome.reason, "goal_criteria_clarification_required");
});

test("polluted Goal v2 migration invalidates old evidence and requires review", () => {
  const pollutedText = [
    "[turn_intake]",
    "workflowMode: edit",
    "priority: runtime-only",
    "[user_request]",
    "Fix Goal Runtime and run tests",
    "[/user_request]",
    "[/turn_intake]",
  ].join("\n");
  const legacyGoal = {
    ...goalState.createGoalDefinition({ objective: "placeholder" }),
    schemaVersion: 2,
    objective: pollutedText,
    rawText: pollutedText,
    revision: 1,
    status: "active",
    criteria: [{ id: "criterion_1", text: pollutedText, required: true, status: "satisfied", evidenceIds: ["old"] }],
  };
  const progress = goalState.createGoalProgress(legacyGoal.id, ".MAIN/goals/progress.md");
  progress.evidence = [{
    id: "old",
    goalId: legacyGoal.id,
    goalRevision: 1,
    iteration: 1,
    kind: "test",
    status: "passed",
    sourceTool: "run_command",
    target: "npm test",
    summary: "passed",
    references: [],
    criterionIds: ["criterion_1"],
    createdAt: 1,
  }];
  const migrated = goalRuntime.normalizeGoalRuntimeSnapshot({
    schemaVersion: 2,
    goal: legacyGoal,
    progress,
    status: "active",
    phase: "execute",
    updatedAt: 10,
  });

  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.goal.objective, "Fix Goal Runtime and run tests");
  assert.equal(migrated.goal.revision, 2);
  assert.doesNotMatch(migrated.goal.sourceContext || "", /\[turn_intake\]|priority:/);
  assert.equal(migrated.status, "paused");
  assert.equal(migrated.pauseReason, "goal_definition_migrated_review_required");
  assert.ok(migrated.goal.criteria.every((criterion) => criterion.status === "pending"));
  assert.deepEqual(migrated.progress.evidence[0].criterionIds, []);
  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal: migrated.goal,
    evidence: migrated.progress.evidence,
    completionCandidate: true,
  }).passed, false);
});

test("clean Goal v2 migration upgrades in place without a review pause", () => {
  const legacyGoal = {
    ...goalState.createGoalDefinition({ objective: "Analyze the repository" }),
    schemaVersion: 2,
    revision: 4,
    status: "active",
  };
  const migrated = goalState.migrateGoalDefinition(legacyGoal);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.revision, 4);
  assert.equal(migrated.status, "active");
  assert.equal(migrated.migrationReviewRequired, false);
});

test("central Goal tool classification treats project skeleton as read and unknown tools as non-authoritative", () => {
  const goal = goalState.createGoalDefinition({ objective: "Analyze the repository" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "get_project_skeleton", result: "src/" },
      { name: "mystery_success_tool", result: "ok", success: true },
    ],
  });
  assert.equal(evidence[0].kind, "read");
  assert.equal(evidence[0].status, "observed");
  assert.equal(evidence[1].kind, "unknown");
  assert.equal(evidence[1].status, "observed");
  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [evidence[1]],
    completionCandidate: true,
  }).passed, false);
});

test("Goal MCP classification distinguishes reads, workspace mutations, and unknown actions", () => {
  const goal = goalState.createGoalDefinition({ objective: "修改 Unity 脚本并验证" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 20,
    observations: [
      { name: "mcp__unity__read_console", result: "no errors" },
      { name: "mcp__unity__script_apply_edits", target: "Assets/Foo.cs", result: "updated" },
      { name: "mcp__vendor__mystery", result: "ok" },
    ],
  });
  assert.deepEqual(evidence.map((entry) => entry.kind), ["read", "file_change", "unknown"]);
  assert.equal(evidence[0].status, "observed");
  assert.equal(evidence[1].status, "passed");
  assert.equal(evidence[2].status, "observed");
});

test("Goal observation reconciliation does not duplicate completed transcript tool calls", () => {
  const merged = goalRuntime.mergeGoalToolObservations(
    [
      {
        id: "call-write-a",
        name: "apply_patch",
        arguments: { path: "src/a.ts" },
        result: "Done",
      },
      {
        id: "call-write-b",
        name: "apply_patch",
        arguments: { path: "src/b.ts" },
        result: "Done",
      },
    ],
    [
      {
        id: "call-write-a",
        name: "apply_patch",
        target: "src/a.ts",
        result: "Applied patch",
        success: true,
      },
      {
        id: "legacy-runtime-b",
        name: "apply_patch",
        target: "src/b.ts",
        result: "Applied patch",
        success: true,
      },
    ],
  );

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((entry) => goalRuntime.resolveGoalToolTarget(entry)), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(merged.map((entry) => entry.success), [true, true]);

  const goal = goalState.createGoalDefinition({
    objective: "修改 src/a.ts 和 src/b.ts",
    definitionOfDone: ["修改 src/a.ts", "修改 src/b.ts"],
  });
  const evidence = goalRuntime.createGoalEvidenceEntries({ goal, iteration: 1, observations: merged, now: 10 });
  assert.equal(evidence.length, 2, "one runtime lifecycle block must map to one provider tool call");
});

test("completion evidence is assigned per criterion instead of blanket-copying all evidence", () => {
  const goal = goalState.createGoalDefinition({
    objective: "Ship the widget",
    definitionOfDone: ["Implement the widget", "npm test passes"],
  });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "apply_patch", target: "src/widget.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npm test" }, result: "12 passed, 0 failed" },
    ],
  });
  const result = goalRuntime.evaluateGoalCompletion({ goal, evidence, completionCandidate: true });
  assert.equal(result.passed, true);
  assert.deepEqual(result.criteria[0].evidenceIds, [evidence[0].id]);
  assert.deepEqual(result.criteria[1].evidenceIds, [evidence[1].id]);
});

test("one file change cannot satisfy two distinct mutation criteria", () => {
  const goal = goalState.createGoalDefinition({
    objective: "Implement both features",
    definitionOfDone: ["Implement feature alpha", "Implement feature beta"],
  });
  const alphaOnly = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "apply_patch", target: "src/feature-alpha.ts", result: "Done" },
    ],
  });
  const result = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: alphaOnly,
    completionCandidate: true,
  });

  assert.equal(result.passed, false);
  assert.equal(result.criteria[0].status, "satisfied");
  assert.equal(result.criteria[1].status, "pending");
  assert.deepEqual(result.criteria[0].evidenceIds, [alphaOnly[0].id]);
  assert.deepEqual(result.criteria[1].evidenceIds, []);
});

test("finite Goal budget normalization rejects NaN and Infinity overrides", () => {
  const budget = goalBudget.resolveGoalBudget({
    maxIterations: Number.NaN,
    maxTokens: Number.POSITIVE_INFINITY,
    maxToolCalls: Number.POSITIVE_INFINITY,
    maxDurationMs: Number.POSITIVE_INFINITY,
    checkpointInterval: Number.NaN,
    userConfirmInterval: Number.POSITIVE_INFINITY,
    maxNoProgressIterations: Number.NaN,
  });
  assert.equal(budget.maxIterations, goalBudget.DEFAULT_GOAL_BUDGET.maxIterations);
  assert.equal(budget.maxTokens, undefined);
  assert.equal(budget.maxToolCalls, goalBudget.DEFAULT_GOAL_BUDGET.maxToolCalls);
  assert.equal(budget.maxDurationMs, goalBudget.DEFAULT_GOAL_BUDGET.maxDurationMs);
  assert.ok(Object.values(budget).filter((value) => value !== undefined).every(Number.isFinite));
});

test("inner max-iterations is an automatic next slice with exact stop reason and usage", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    runs += 1;
    if (runs === 1) {
      return {
        assistantText: "Patched the runtime.\n## Next\n- Run lint",
        toolCalls: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
        tokensUsed: 500,
        completed: false,
        outcomeStatus: "stopped_no_action",
        stopReason: "max_iterations_boundary",
        sliceBoundaryReached: true,
        usage: { modelIterations: 8, toolCalls: 1, tokensUsed: 500, estimatedTokens: true },
      };
    }
    return {
      assistantText: "Lint passed. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [{ name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" }],
      tokensUsed: 200,
      completed: true,
      outcomeStatus: "completed",
      stopReason: "agent_loop_completed",
      usage: { modelIterations: 2, toolCalls: 1, tokensUsed: 200, estimatedTokens: true },
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(runs, 2);
  assert.equal(outcome.usage.modelIterations, 10);
  assert.equal(outcome.usage.toolCalls, 2);
  assert.equal(outcome.usage.totalTokensUsed, 700);
  assert.equal(outcome.lastStopReason, "agent_loop_completed");
  assert.equal(harness.runtimeUpdates.at(-1).progress.iterations[0].stopReason, "max_iterations_boundary");
  assert.equal(harness.runtimeUpdates.at(-1).progress.iterations[0].stopClass, "slice_budget_exhausted");
});

test("read-only 8/8 slice preserves slice_budget_exhausted while recovery tracks no progress", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    runs += 1;
    if (runs === 1) {
      return {
        assistantText: "Inspected the project; implementation remains.",
        toolCalls: [{ name: "get_project_skeleton", result: "src/" }],
        tokensUsed: 300,
        completed: false,
        outcomeStatus: "stopped_no_action",
        stopReason: "max_iterations_boundary",
        sliceBoundaryReached: true,
        usage: { modelIterations: 8, toolCalls: 1, tokensUsed: 300, estimatedTokens: true },
      };
    }
    return {
      assistantText: "Implemented and verified. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [
        { name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" },
        { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
      ],
      tokensUsed: 200,
      completed: true,
      outcomeStatus: "completed",
      stopReason: "agent_loop_completed",
      usage: { modelIterations: 2, toolCalls: 2, tokensUsed: 200, estimatedTokens: true },
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  const firstSlice = harness.runtimeUpdates.at(-1).progress.iterations[0];
  assert.equal(firstSlice.stopClass, "slice_budget_exhausted");
});

test("canonical action-required and error conclusions map to awaiting_input and failed", async () => {
  const permissionGoal = goalState.createGoalDefinition({ objective: "Fix runtime", iterationBudget: 10 });
  const permissionHarness = createEngineCallbacks(async () => ({
    assistantText: "Approval required",
    toolCalls: [],
    tokensUsed: 10,
    completed: false,
    outcomeStatus: "paused",
    outcomePauseKind: "action_required",
    stopReason: "permission_approval_required",
  }));
  const permissionOutcome = await goalEngine.executeGoalLoop({ goal: permissionGoal, callbacks: permissionHarness.callbacks });
  assert.equal(permissionOutcome.status, "awaiting_input");
  assert.equal(permissionOutcome.stopClass, "awaiting_input");

  const fatalGoal = goalState.createGoalDefinition({ objective: "Fix runtime", iterationBudget: 10 });
  const fatalHarness = createEngineCallbacks(async () => ({
    assistantText: "Model unavailable",
    toolCalls: [],
    tokensUsed: 10,
    completed: true,
    outcomeStatus: "completed",
    outcomeResultKind: "error",
    stopReason: "model_not_found",
  }));
  const fatalOutcome = await goalEngine.executeGoalLoop({ goal: fatalGoal, callbacks: fatalHarness.callbacks });
  assert.equal(fatalOutcome.status, "failed");
  assert.equal(fatalOutcome.stopClass, "unrecoverable_error");
});

test("only the same normalized recoverable cause reaches blocked", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor runtime and run lint", iterationBudget: 10 });
  const results = [
    { outcomeStatus: "error", stopReason: "provider stream failed", assistantText: "retry", toolCalls: [] },
    { outcomeStatus: "stopped_no_output", stopReason: "no_output", assistantText: "retry", toolCalls: [] },
    { outcomeStatus: "error", stopReason: "provider stream failed", assistantText: "retry", toolCalls: [] },
    {
      outcomeStatus: "completed",
      stopReason: "agent_loop_completed",
      assistantText: "Done. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [
        { name: "apply_patch", target: "src/runtime.ts", result: "Done" },
        { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
      ],
    },
  ];
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    const result = results[runs++];
    return {
      ...result,
      tokensUsed: 10,
      completed: result.outcomeStatus === "completed",
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(runs, 4);
});

test("three completed but evidence-free slices become no_progress blocked", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor runtime", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    runs += 1;
    return {
      assistantText: "Inspected only",
      toolCalls: [{ name: "get_project_skeleton", result: "src/" }],
      tokensUsed: 10,
      completed: true,
      outcomeStatus: "completed",
      stopReason: "agent_loop_completed",
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.stopClass, "blocked");
  assert.equal(outcome.reason, "no_progress");
  assert.equal(runs, 3);
  assert.equal(outcome.finalCheckpoint.iteration, 3);
});

test("an inner abort maps to paused instead of recovery", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor runtime", iterationBudget: 10 });
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Stopped",
    toolCalls: [],
    tokensUsed: 0,
    completed: false,
    outcomeStatus: "aborted",
    stopReason: "agent_loop_aborted",
  }));
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.stopClass, "user_paused");
});

test("total Goal slice budget pauses with an exact resumable stop class", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor runtime", iterationBudget: 1 });
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Patched one file; validation remains.",
    toolCalls: [{ name: "apply_patch", target: "src/runtime.ts", result: "Done" }],
    tokensUsed: 20,
    completed: false,
    outcomeStatus: "stopped_no_action",
    stopReason: "slice_work_remaining",
  }));
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.stopClass, "total_slice_budget_exhausted");
  assert.equal(outcome.lastStopReason, "iteration_limit");
  assert.equal(harness.runtimeUpdates.at(-1).status, "paused");
  assert.equal(harness.runtimeUpdates.at(-1).stopClass, "total_slice_budget_exhausted");
});

test("Goal tool-call budget is enforced independently from slice and token budgets", async () => {
  const goal = goalState.createGoalDefinition({
    objective: "Refactor runtime",
    iterationBudget: 10,
    toolCallBudget: 1,
  });
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Patched one file; validation remains.",
    toolCalls: [{ name: "apply_patch", target: "src/runtime.ts", result: "Done" }],
    tokensUsed: 20,
    completed: false,
    outcomeStatus: "stopped_no_action",
    stopReason: "slice_work_remaining",
  }));
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.stopClass, "tool_call_budget_exhausted");
  assert.equal(outcome.usage.toolCalls, 1);
});
