import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const moduleCache = new Map();
function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const actionRequests = loadTranspiledModuleSync(path.join(process.cwd(), "src/lib/actionRequest.ts"));
const actionRequestRestore = loadTranspiledModuleSync(path.join(process.cwd(), "src/lib/actionRequestRestore.ts"));
const planIdentity = loadTranspiledModuleSync(path.join(process.cwd(), "src/lib/planApprovalIdentity.ts"));
const pendingToolReview = loadTranspiledModuleSync(path.join(process.cwd(), "src/lib/pendingToolReview.ts"));
const runTransitions = loadTranspiledModuleSync(path.join(process.cwd(), "src/lib/runTransitionReducer.ts"));
const turnEvents = loadTranspiledModuleSync(path.join(process.cwd(), "src/lib/turnEvents.ts"));

test("only a pending tool permission owned by the current run renders the permission capsule", () => {
  const base = {
    schemaVersion: 1,
    requestId: "request-1",
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    title: "Fix approval state",
    status: "pending",
    createdAt: 1,
  };
  const permission = {
    ...base,
    kind: "tool_permission",
    taskId: 7,
    toolName: "apply_patch",
    target: "src/App.tsx",
  };
  const exactOwner = {
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    requestId: "request-1",
    taskId: 7,
  };
  assert.equal(actionRequests.shouldRenderPermissionCapsule({ request: permission, ...exactOwner }), true);
  for (const mismatch of [
    { sessionKey: "session-2" },
    { turnId: "turn-2" },
    { runId: "run-1:goal:slice:1" },
    { requestId: "request-2" },
    { taskId: 8 },
  ]) {
    assert.equal(actionRequests.shouldRenderPermissionCapsule({ request: permission, ...exactOwner, ...mismatch }), false);
  }
  assert.equal(actionRequests.shouldRenderPermissionCapsule({ request: permission, ...exactOwner, runId: null }), false);
  assert.equal(actionRequests.shouldRenderPermissionCapsule({
    request: { ...base, kind: "plan_review", planRevision: 1, artifactHash: "hash", artifactPaths: [] },
    ...exactOwner,
  }), false);
  assert.deepEqual(actionRequests.getToolPermissionResolutionIdentity(permission), exactOwner);
  assert.equal(actionRequests.isExactToolPermissionResolutionIdentity(permission, exactOwner), true);
  assert.equal(actionRequests.isExactToolPermissionResolutionIdentity(permission, { ...exactOwner, requestId: "stale" }), false);
});

test("plan review requests bind the exact revision and artifact hash", () => {
  const request = actionRequests.buildPlanReviewActionRequest({
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-plan-review",
    parentRunId: "run-plan-draft",
    title: "Review runtime plan",
    planRevision: 3,
    artifactHash: "plan-hash-3",
    artifactPaths: [".MAIN/plans/plan.md"],
    now: 9,
  });
  assert.equal(request.kind, "plan_review");
  assert.equal(request.planRevision, 3);
  assert.equal(request.artifactHash, "plan-hash-3");
  assert.deepEqual(request.artifactPaths, [".MAIN/plans/plan.md"]);
  assert.equal(request.parentRunId, "run-plan-draft");
});

test("user choices require the exact pending request identity and selected option", () => {
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey: "session-1",
    turnId: "turn-choice",
    runId: "run-choice",
    parentRunId: "run-parent",
    title: "Choose a strategy",
    optionValues: ["Use A", "Use B"],
    allowCustomReply: true,
    now: 10,
  });
  const identity = actionRequests.toUserChoiceResolutionIdentity(request);
  assert.equal(actionRequests.isMatchingUserChoiceResolution({
    identity,
    sessionKey: "session-1",
    turnId: "turn-choice",
    optionValue: "Use B",
  }), true);
  assert.equal(actionRequests.isExactUserChoiceResolutionIdentity(
    identity,
    { ...identity, requestId: "stale-request" },
  ), false);
  assert.equal(actionRequests.isMatchingUserChoiceResolution({
    identity: { ...identity, status: "resolved" },
    sessionKey: "session-1",
    turnId: "turn-choice",
    optionValue: "Use B",
  }), false);
  assert.equal(actionRequests.isMatchingUserChoiceResolution({
    identity,
    sessionKey: "session-2",
    turnId: "turn-choice",
    optionValue: "Use B",
  }), false);
  assert.equal(actionRequests.isMatchingUserChoiceResolution({
    identity,
    sessionKey: "session-1",
    turnId: "turn-choice",
    optionValue: "Use C",
  }), false);
  assert.equal(actionRequests.isMatchingUserChoiceResolution({
    identity,
    sessionKey: "session-1",
    turnId: "turn-choice",
    optionValue: "A custom answer",
    isCustomReply: true,
  }), true);
  assert.equal(actionRequests.isMatchingUserChoiceResolution({
    identity: { ...identity, allowCustomReply: false },
    sessionKey: "session-1",
    turnId: "turn-choice",
    optionValue: "A custom answer",
    isCustomReply: true,
  }), false);
});

test("Goal controls cannot cross a confirmation request or run boundary", () => {
  const request = actionRequests.buildGoalConfirmationActionRequest({
    sessionKey: "session-1",
    turnId: "turn-goal",
    runId: "run-goal-2",
    title: "Long goal",
    goalId: "goal-1",
    goalRevision: 3,
    reason: "periodic checkpoint",
    now: 11,
  });
  const runOwner = {
    status: "paused",
    sessionKey: "session-1",
    turnId: "turn-goal",
    runId: "run-goal-2",
  };
  assert.equal(actionRequests.isCurrentGoalControlResolution({
    request,
    identity: { goalId: "goal-1", goalRevision: 3, requestId: request.requestId },
    goalId: "goal-1",
    goalRevision: 3,
    runOwner,
  }), true);
  assert.equal(actionRequests.isCurrentGoalControlResolution({
    request,
    identity: { goalId: "goal-1", goalRevision: 3 },
    goalId: "goal-1",
    goalRevision: 3,
    runOwner,
  }), false, "a control rendered before confirmation cannot resolve a newer confirmation");
  assert.equal(actionRequests.isCurrentGoalControlResolution({
    request,
    identity: { goalId: "goal-1", goalRevision: 3, requestId: request.requestId },
    goalId: "goal-1",
    goalRevision: 3,
    runOwner: { ...runOwner, runId: "run-stale" },
  }), false);
  assert.equal(actionRequests.isCurrentGoalControlResolution({
    request: null,
    identity: { goalId: "goal-1", goalRevision: 3 },
    goalId: "goal-1",
    goalRevision: 3,
  }), true);
  assert.equal(actionRequests.isCurrentGoalControlResolution({
    request: { ...request, goalId: "goal-2" },
    identity: { goalId: "goal-1", goalRevision: 3 },
    goalId: "goal-1",
    goalRevision: 3,
    runOwner,
  }), false, "a control must not consume another Goal's confirmation request");

  const toolPermission = {
    schemaVersion: 1,
    requestId: "permission-1",
    kind: "tool_permission",
    sessionKey: "session-1",
    turnId: "turn-goal",
    runId: "run-goal-2",
    title: "Read a protected file",
    status: "pending",
    createdAt: 12,
    taskId: 9,
    toolName: "read_file",
    target: "src/main.ts",
  };
  assert.equal(actionRequests.isCurrentGoalControlResolution({
    request: toolPermission,
    identity: { goalId: "goal-1", goalRevision: 3 },
    goalId: "goal-1",
    goalRevision: 3,
    runOwner,
  }), false, "a Goal resume control cannot consume an exact pending tool permission");
  const userChoice = actionRequests.buildUserChoiceActionRequest({
    sessionKey: "session-1",
    turnId: "turn-goal",
    runId: "run-goal-2",
    title: "Choose recovery",
    optionValues: ["Retry", "Stop"],
    now: 13,
  });
  assert.equal(actionRequests.isCurrentGoalControlResolution({
    request: userChoice,
    identity: { goalId: "goal-1", goalRevision: 3 },
    goalId: "goal-1",
    goalRevision: 3,
    runOwner,
  }), false, "a Goal resume control cannot bypass a pending user choice");

  assert.equal(actionRequests.isCurrentGoalAdministrativeControl({
    request: toolPermission,
    identity: { goalId: "goal-1", goalRevision: 3 },
    goalId: "goal-1",
    goalRevision: 3,
  }), true, "pause and clear remain available without consuming another request");
  assert.equal(actionRequests.isCurrentGoalAdministrativeControl({
    request,
    identity: { goalId: "goal-1", goalRevision: 3 },
    goalId: "goal-1",
    goalRevision: 3,
  }), false, "an administrative control rendered before confirmation cannot clear a newer checkpoint");
  assert.equal(actionRequests.isCurrentGoalAdministrativeControl({
    request,
    identity: { goalId: "goal-1", goalRevision: 3, requestId: request.requestId },
    goalId: "goal-1",
    goalRevision: 3,
  }), true);
  assert.equal(
    actionRequests.clearGoalConfirmationActionRequest(toolPermission, "goal-1", 3),
    toolPermission,
  );
  assert.equal(
    actionRequests.clearGoalConfirmationActionRequest({ ...request, goalId: "goal-2" }, "goal-1", 3)?.goalId,
    "goal-2",
  );
  assert.equal(actionRequests.clearGoalConfirmationActionRequest(request, "goal-1", 3), null);
});

test("runtime restore revives only exact resumable action checkpoints", () => {
  const owner = {
    status: "paused",
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
  };
  const choice = actionRequests.buildUserChoiceActionRequest({
    sessionKey: owner.sessionKey,
    turnId: owner.turnId,
    runId: owner.runId,
    title: "Choose",
    optionValues: ["A", "B"],
    allowCustomReply: true,
    now: 20,
  });
  const choiceBlock = {
    id: 1,
    turnId: owner.turnId,
    type: "agent",
    content: "Choose",
    options: [{ label: "A", value: "A" }, { label: "B", value: "B" }],
    choiceRequest: actionRequests.toUserChoiceResolutionIdentity(choice),
  };
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: choice,
    runOwner: owner,
    taskFlow: [choiceBlock],
  })?.requestId, choice.requestId);
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: choice,
    runOwner: { ...owner, runId: "stale-run" },
    taskFlow: [choiceBlock],
  }), null);
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: choice,
    runOwner: owner,
    taskFlow: [{ ...choiceBlock, options: [{ label: "A", value: "A" }] }],
  }), null);

  const planReview = actionRequests.buildPlanReviewActionRequest({
    sessionKey: owner.sessionKey,
    turnId: owner.turnId,
    runId: owner.runId,
    title: "Review",
    planRevision: 2,
    artifactHash: "hash-2",
    artifactPaths: [".MAIN/plans/plan.md"],
    now: 21,
  });
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: planReview,
    runOwner: owner,
    planIdentity: { revision: 2, artifactHash: "hash-2", artifactPaths: [], artifactCount: 1 },
  })?.requestId, planReview.requestId);
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: planReview,
    runOwner: owner,
    planIdentity: { revision: 3, artifactHash: "hash-3", artifactPaths: [], artifactCount: 1 },
  }), null);

  const confirmation = actionRequests.buildGoalConfirmationActionRequest({
    sessionKey: owner.sessionKey,
    turnId: owner.turnId,
    runId: owner.runId,
    title: "Confirm",
    goalId: "goal-1",
    goalRevision: 4,
    reason: "checkpoint",
    now: 22,
  });
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: confirmation,
    runOwner: owner,
    goalRuntime: {
      status: "awaiting_input",
      goal: { id: "goal-1", revision: 4, sessionKey: "session-1", ownerTurnId: "turn-1" },
    },
  })?.requestId, confirmation.requestId);
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: confirmation,
    runOwner: owner,
    goalRuntime: {
      status: "paused",
      goal: { id: "goal-1", revision: 4, sessionKey: "session-1", ownerTurnId: "turn-1" },
    },
  }), null);

  const permission = {
    schemaVersion: 1,
    requestId: "permission-restore",
    kind: "tool_permission",
    sessionKey: owner.sessionKey,
    turnId: owner.turnId,
    runId: owner.runId,
    title: "Write",
    status: "pending",
    createdAt: 23,
    taskId: 3,
    toolName: "write_file",
    target: "src/main.ts",
  };
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: permission,
    runOwner: owner,
  }), null, "tool permission resolvers are process-local and cannot be revived after reload");
  assert.equal(actionRequestRestore.restorePendingActionRequest({
    request: { ...choice, status: "resolved" },
    runOwner: owner,
    taskFlow: [choiceBlock],
  }), null);
});

test("malformed persisted action requests are cleared instead of revived", () => {
  const valid = actionRequests.buildUserChoiceActionRequest({
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    title: "Choose",
    optionValues: ["A"],
    allowCustomReply: true,
    now: 12,
  });
  assert.equal(actionRequests.normalizeActionRequest(valid)?.requestId, valid.requestId);
  assert.equal(actionRequests.normalizeActionRequest({ ...valid, schemaVersion: undefined }), null);
  assert.equal(actionRequests.normalizeActionRequest({ ...valid, requestId: "" }), null);
  assert.equal(actionRequests.normalizeActionRequest({ ...valid, status: "unexpected" }), null);
});

test("terminal action requests cannot be rendered as pending permissions", () => {
  const normalized = actionRequests.normalizeActionRequest({
    requestId: "request-1",
    kind: "tool_permission",
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    title: "Task",
    status: "resolved",
    createdAt: 1,
    taskId: 2,
    toolName: "run_command",
    target: "npm test",
  });
  assert.equal(actionRequests.isPendingActionRequest(normalized), false);
  assert.equal(actionRequests.shouldRenderPermissionCapsule({
    request: normalized,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    requestId: "request-1",
    taskId: 2,
  }), false);
});

test("workflow-specific terminal actions clear only their own request kind", () => {
  const confirmation = actionRequests.buildGoalConfirmationActionRequest({
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-goal",
    title: "Long goal",
    goalId: "goal-1",
    goalRevision: 2,
    reason: "periodic checkpoint",
    now: 2,
  });
  assert.equal(actionRequests.clearActionRequestOfKind(confirmation, "goal_confirmation"), null);
  assert.equal(actionRequests.clearActionRequestOfKind(confirmation, "plan_review"), confirmation);
  assert.equal(actionRequests.clearActionRequestOfKind(null, "goal_confirmation"), null);
});

test("run transition reducer atomically enforces action-request lifecycle invariants", () => {
  const request = actionRequests.buildPlanReviewActionRequest({
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-review",
    title: "Review",
    planRevision: 1,
    artifactHash: "hash-1",
    artifactPaths: [".MAIN/plans/plan.md"],
    now: 1,
  });
  const requested = runTransitions.reduceRunTransition(
    {
      activeActionRequest: null,
      runtimeEvents: [],
      conversationTurns: [{
        id: "turn-1",
        status: "awaiting_approval",
        runtimeOutcome: {
          status: "paused",
          runId: "run-review",
          reason: "plan_review",
        },
      }],
    },
    {
      type: "action_required",
      request,
      events: [turnEvents.withEventSchema({
        type: "run.paused",
        threadId: "session-1",
        turnId: "turn-1",
        runId: "run-review",
        parentRunId: null,
        timestampMs: 2,
        reason: "plan_review",
        message: "review",
      })],
    },
  );
  assert.equal(requested.activeActionRequest.requestId, request.requestId);

  const childStarted = runTransitions.reduceRunTransition(requested, {
    type: "runtime_event",
    event: turnEvents.withEventSchema({
      type: "run.started",
      threadId: "session-1",
      turnId: "turn-1",
      runId: "run-execute",
      parentRunId: "run-review",
      timestampMs: 3,
    }),
  });
  assert.equal(childStarted.activeActionRequest, null);
  assert.equal(childStarted.conversationTurns[0].status, "executing");
  assert.equal(childStarted.conversationTurns[0].runtimeOutcome, undefined);

  const terminal = runTransitions.reduceRunTransition(
    { activeActionRequest: request, runtimeEvents: [] },
    {
      type: "runtime_event",
      event: turnEvents.withEventSchema({
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        runId: "run-review",
        parentRunId: null,
        timestampMs: 4,
        resultKind: "error",
        summary: "The run concluded with an error result.",
      }),
    },
  );
  assert.equal(terminal.activeActionRequest, null);
});

test("run transition reducer preserves requests on terminal conflicts and clears only accepted exact terminals", () => {
  const request = actionRequests.buildPlanReviewActionRequest({
    sessionKey: "session-conflict",
    turnId: "turn-conflict",
    runId: "run-review",
    title: "Review",
    planRevision: 1,
    artifactHash: "hash-conflict",
    artifactPaths: [".MAIN/plans/plan.md"],
    now: 10,
  });
  const paused = turnEvents.withEventSchema({
    type: "run.paused",
    threadId: "session-conflict",
    turnId: "turn-conflict",
    runId: "run-review",
    parentRunId: null,
    timestampMs: 11,
    reason: "plan_review",
    message: "Review the plan.",
  });
  const pending = runTransitions.reduceRunTransition(
    { activeActionRequest: null, runtimeEvents: [] },
    { type: "action_required", request, events: [paused] },
  );

  const lateConflictingTerminal = runTransitions.reduceRunTransition(pending, {
    type: "runtime_event",
    event: turnEvents.withEventSchema({
      type: "run.completed",
      threadId: "session-conflict",
      turnId: "turn-conflict",
      runId: "run-review",
      parentRunId: null,
      timestampMs: 12,
      resultKind: "error",
    }),
  });
  assert.equal(lateConflictingTerminal.activeActionRequest, request);
  assert.deepEqual(lateConflictingTerminal.runtimeEvents.map((event) => event.type), ["run.paused"]);

  const lateLegacyFailure = runTransitions.reduceRunTransition(pending, {
    type: "runtime_event",
    event: turnEvents.withEventSchema({
      type: "run.failed",
      threadId: "session-conflict",
      turnId: "turn-conflict",
      runId: "run-review",
      parentRunId: null,
      timestampMs: 12,
      error: { message: "persisted legacy terminal arrived late" },
    }),
  });
  assert.equal(lateLegacyFailure.activeActionRequest, request);
  assert.deepEqual(lateLegacyFailure.runtimeEvents.map((event) => event.type), ["run.paused"]);

  const otherRunAborted = runTransitions.reduceRunTransition(
    { activeActionRequest: request, runtimeEvents: [] },
    {
      type: "runtime_event",
      event: turnEvents.withEventSchema({
        type: "run.aborted",
        threadId: "session-conflict",
        turnId: "turn-conflict",
        runId: "run-other",
        parentRunId: null,
        timestampMs: 13,
        reason: "user_cancelled",
      }),
    },
  );
  assert.equal(otherRunAborted.activeActionRequest, request);

  const exactRunAborted = runTransitions.reduceRunTransition(
    { activeActionRequest: request, runtimeEvents: [] },
    {
      type: "runtime_event",
      event: turnEvents.withEventSchema({
        type: "run.aborted",
        threadId: "session-conflict",
        turnId: "turn-conflict",
        runId: "run-review",
        parentRunId: null,
        timestampMs: 14,
        reason: "user_cancelled",
      }),
    },
  );
  assert.equal(exactRunAborted.activeActionRequest, null);
});

test("action-required transition cannot mount a request beside an accepted terminal", () => {
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey: "session-terminal-batch",
    turnId: "turn-terminal-batch",
    runId: "run-terminal-batch",
    title: "Choose",
    optionValues: ["Continue", "Stop"],
    allowCustomReply: false,
    now: 20,
  });
  const state = runTransitions.reduceRunTransition(
    { activeActionRequest: null, runtimeEvents: [] },
    {
      type: "action_required",
      request,
      events: [turnEvents.withEventSchema({
        type: "run.completed",
        threadId: "session-terminal-batch",
        turnId: "turn-terminal-batch",
        runId: "run-terminal-batch",
        parentRunId: null,
        timestampMs: 21,
        resultKind: "blocked",
      })],
    },
  );
  assert.equal(state.activeActionRequest, null);
  assert.deepEqual(state.runtimeEvents.map((event) => event.type), ["run.completed"]);
});

test("tool review builds a run-owned permission request with an auditable target", () => {
  const request = pendingToolReview.buildToolPermissionActionRequest({
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    title: "Fix the viewer",
    taskId: 9,
    toolCall: {
      name: "run_command",
      arguments: { command: "npm test" },
      shellPermissionDecision: { requiresApproval: true },
    },
    now: 42,
  });
  assert.equal(request.kind, "tool_permission");
  assert.equal(request.taskId, 9);
  assert.equal(request.target, "npm test");
  assert.equal(request.risk, "shell");
  assert.equal(request.title, "Fix the viewer");
  assert.equal(actionRequests.isActionRequestOwnedByRun(request, {
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
  }), true);
});

test("desktop review target discloses constrained actions without exposing filled text", () => {
  const request = pendingToolReview.buildToolPermissionActionRequest({
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    title: "Validate MAIN",
    taskId: 10,
    toolCall: {
      name: "computer_use",
      risk: "desktop_control",
      arguments: {
        app_name: "MAIN",
        actions: "click: Open\nfill: File name => private-value\npress: Enter",
        screenshot: true,
      },
    },
    now: 43,
  });
  assert.equal(request.risk, "desktop_control");
  assert.match(request.target, /^MAIN · click: Open; fill: File name => \[text\]; press: Enter · screenshot$/);
  assert.doesNotMatch(request.target, /private-value/);
});

test("visible pending tool review resolves only the request exact task and turn", () => {
  const request = pendingToolReview.buildToolPermissionActionRequest({
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    title: "Fix the viewer",
    taskId: 9,
    toolCall: {
      name: "run_command",
      arguments: { command: "npm test" },
    },
    now: 42,
  });
  const exactTask = {
    id: 9,
    turnId: "turn-1",
    type: "tool",
    toolName: "run_command",
    target: "npm test",
    status: "pending_review",
    toolStatus: "pending",
    message: "Waiting",
  };
  const staleActiveTask = { ...exactTask, turnId: "turn-stale", target: "stale command" };
  const resolved = pendingToolReview.resolveVisiblePendingToolReview({
    taskFlow: [exactTask],
    request,
    pendingReviewTaskId: 9,
    pendingToolCall: { name: "run_command", arguments: { command: "npm test" } },
    activeDiffTask: staleActiveTask,
  });
  assert.equal(resolved.id, 9);
  assert.equal(resolved.turnId, "turn-1");
  assert.equal(resolved.target, "npm test");

  assert.equal(pendingToolReview.resolveVisiblePendingToolReview({
    taskFlow: [staleActiveTask],
    request,
    pendingReviewTaskId: 10,
    pendingToolCall: { name: "run_command", arguments: { command: "npm test" } },
    activeDiffTask: staleActiveTask,
  }), null);

  assert.equal(pendingToolReview.resolveVisiblePendingToolReview({
    taskFlow: [],
    request,
    pendingReviewTaskId: 9,
    pendingToolCall: { name: "run_command", arguments: { command: "npm run stale" } },
  }), null);

  const fallback = pendingToolReview.resolveVisiblePendingToolReview({
    taskFlow: [],
    request,
    pendingReviewTaskId: 9,
    pendingToolCall: { name: "run_command", arguments: { command: "npm test" } },
  });
  assert.equal(fallback.id, 9);
  assert.equal(fallback.turnId, "turn-1");
  assert.equal(fallback.target, "npm test");
});

test("plan approval identity changes whenever a reviewable artifact changes", () => {
  const artifact = {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content: "# Plan\n\n- Change A",
    revision: 1,
    updatedAt: 1,
  };
  const first = planIdentity.buildPlanApprovalIdentity([artifact]);
  const same = planIdentity.buildPlanApprovalIdentity([{ ...artifact, updatedAt: 99 }]);
  const changed = planIdentity.buildPlanApprovalIdentity([{ ...artifact, content: "# Plan\n\n- Change B", revision: 2 }]);
  assert.deepEqual(first, same);
  assert.notEqual(first.artifactHash, changed.artifactHash);
  assert.equal(changed.revision, 2);
  assert.equal(planIdentity.isPlanApprovalIdentityCurrent({ artifacts: [artifact], revision: 1, artifactHash: first.artifactHash }), true);
  assert.equal(planIdentity.isPlanApprovalIdentityCurrent({ artifacts: [artifact], revision: 2, artifactHash: first.artifactHash }), false);
});
