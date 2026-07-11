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
    { activeActionRequest: null, runtimeEvents: [] },
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

  const terminal = runTransitions.reduceRunTransition(
    { activeActionRequest: request, runtimeEvents: [] },
    {
      type: "runtime_event",
      event: turnEvents.withEventSchema({
        type: "run.failed",
        threadId: "session-1",
        turnId: "turn-1",
        runId: "run-review",
        parentRunId: null,
        timestampMs: 4,
        error: { message: "failed" },
      }),
    },
  );
  assert.equal(terminal.activeActionRequest, null);
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
