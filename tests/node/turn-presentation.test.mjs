import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const sourcePath = path.join(workspaceRoot, "src/lib/turnPresentation.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function("exports", "module", "require", transpiled)(
  module.exports,
  module,
  createRequire(sourcePath),
);

const {
  buildTurnPresentationModel,
  isPlanActionRequestPresentationEligible,
  resolveGoalPresentationBehavior,
  resolvePlanPresentationBehavior,
  resolveTurnPresentationLifecycle,
  shouldRenderTurnBoundary,
} = module.exports;

function turn(overrides = {}) {
  return {
    id: "turn-1",
    userPrompt: "Explain the runtime boundary",
    title: "New task",
    mode: "chat",
    intent: "respond",
    status: "done",
    collapsed: false,
    ...overrides,
  };
}

test("ordinary turns hide the heavy state anchor while legacy collapsed only folds process", () => {
  const model = buildTurnPresentationModel({
    turn: turn({ collapsed: true }),
    language: "en",
  });

  assert.equal(model.kind, "ordinary");
  assert.equal(model.lifecycle, "success");
  assert.equal(model.showStateAnchor, false);
  assert.equal(model.processCollapsed, true);
  assert.equal(model.keepUserVisible, true);
  assert.equal(model.keepFinalAssistantVisible, true);
  assert.equal(model.title, "Explain the runtime boundary");

  const migrated = buildTurnPresentationModel({
    turn: turn({ processCollapsed: false, collapsed: true }),
    language: "en",
  });
  assert.equal(migrated.processCollapsed, false);
});

test("Plan Goal and exceptional states retain a presentation anchor", () => {
  const plan = buildTurnPresentationModel({
    turn: turn({ intent: "plan", displayIntent: "execute", mode: "plan", status: "done", title: "Plan runtime changes" }),
  });
  const goal = buildTurnPresentationModel({
    turn: turn({ intent: "goal", status: "executing", title: "Goal runtime changes" }),
  });
  const paused = buildTurnPresentationModel({ turn: turn({ status: "paused" }) });
  const blocked = buildTurnPresentationModel({ turn: turn({ status: "stopped_no_action" }) });
  const failed = buildTurnPresentationModel({ turn: turn({ status: "error" }) });

  assert.deepEqual(
    [plan.kind, goal.kind, paused.kind, blocked.kind, failed.kind],
    ["plan", "goal", "paused", "blocked", "failed"],
  );
  assert.ok([plan, goal, paused, blocked, failed].every((model) => model.showStateAnchor));
});

test("awaiting state stays process-expanded and carries optional runtime identity", () => {
  const model = buildTurnPresentationModel({
    turn: turn({ status: "awaiting_input", collapsed: true }),
    runId: "run-2",
    requestId: "request-3",
    actionKind: "user_choice",
    statusLabel: "Waiting for choice",
  });

  assert.equal(model.kind, "awaiting");
  assert.equal(model.lifecycle, "action_required");
  assert.equal(model.processCollapsed, false);
  assert.equal(model.turnId, "turn-1");
  assert.equal(model.runId, "run-2");
  assert.equal(model.requestId, "request-3");
  assert.equal(model.actionKind, "user_choice");
  assert.equal(model.statusLabel, "Waiting for choice");
});

test("all workflow surfaces share the same six-state lifecycle projection", () => {
  assert.deepEqual(
    [
      resolveTurnPresentationLifecycle("executing"),
      resolveTurnPresentationLifecycle("done"),
      resolveTurnPresentationLifecycle("stopped_no_action"),
      resolveTurnPresentationLifecycle("paused"),
      resolveTurnPresentationLifecycle("error"),
      resolveTurnPresentationLifecycle("executing", true),
    ],
    ["active", "success", "no_action", "resumable", "failed", "action_required"],
  );

});

test("Plan behavior requires both the lifecycle action kind and business approval gate", () => {
  const review = resolvePlanPresentationBehavior({
    lifecycle: "action_required",
    actionKind: "plan_review",
    canApproveExecution: true,
  });
  assert.equal(review.mode, "review");
  assert.equal(review.showReviewActions, true);
  assert.equal(review.showChoiceCheckpoint, false);

  const unmaterializedReview = resolvePlanPresentationBehavior({
    lifecycle: "action_required",
    actionKind: "plan_review",
    canApproveExecution: false,
  });
  assert.equal(unmaterializedReview.mode, "review");
  assert.equal(unmaterializedReview.showReviewActions, false);

  const choice = resolvePlanPresentationBehavior({
    lifecycle: "action_required",
    actionKind: "user_choice",
    canApproveExecution: true,
  });
  assert.equal(choice.mode, "choice");
  assert.equal(choice.showReviewActions, false);
  assert.equal(choice.showChoiceCheckpoint, true);

  const resumePlan = resolvePlanPresentationBehavior({
    lifecycle: "resumable",
    canContinuePlanning: true,
    canResumeExecution: false,
  });
  assert.equal(resumePlan.mode, "resumable");
  assert.equal(resumePlan.showContinuePlanning, true);
  assert.equal(resumePlan.showResumeExecution, false);

  const resumeExecution = resolvePlanPresentationBehavior({
    lifecycle: "resumable",
    canContinuePlanning: false,
    canResumeExecution: true,
  });
  assert.equal(resumeExecution.showContinuePlanning, false);
  assert.equal(resumeExecution.showResumeExecution, true);
});

test("Plan requests are presentable only for the exact paused owner run", () => {
  const base = {
    actionKind: "plan_review",
    requestStatus: "pending",
    requestSessionKey: "workspace:7",
    requestTurnId: "turn-7",
    requestRunId: "run-7",
    markerSessionKey: "workspace:7",
    markerTurnId: "turn-7",
    markerRunId: "run-7",
    expectedSessionKey: "workspace:7",
    expectedTurnId: "turn-7",
  };

  assert.equal(isPlanActionRequestPresentationEligible({ ...base, markerStatus: "paused" }), true);
  for (const terminalOrActiveStatus of ["running", "completed", "error", "closed"]) {
    assert.equal(
      isPlanActionRequestPresentationEligible({ ...base, markerStatus: terminalOrActiveStatus }),
      false,
      terminalOrActiveStatus,
    );
  }
  assert.equal(
    isPlanActionRequestPresentationEligible({ ...base, markerStatus: "paused", markerRunId: "run-old" }),
    false,
  );
  assert.equal(
    isPlanActionRequestPresentationEligible({ ...base, markerStatus: "paused", actionKind: "tool_permission" }),
    false,
  );
});

test("Goal behavior projects tone and primary controls from lifecycle", () => {
  assert.deepEqual(
    resolveGoalPresentationBehavior({ lifecycle: "active", status: "active" }),
    { tone: "active", primaryAction: "pause", primaryActionPending: false, canEdit: true, canResume: false },
  );
  assert.deepEqual(
    resolveGoalPresentationBehavior({ lifecycle: "resumable", status: "paused" }),
    { tone: "paused", primaryAction: "resume", primaryActionPending: false, canEdit: true, canResume: true },
  );
  assert.deepEqual(
    resolveGoalPresentationBehavior({ lifecycle: "resumable", status: "pausing" }),
    { tone: "paused", primaryAction: "pause", primaryActionPending: true, canEdit: false, canResume: false },
  );
  assert.deepEqual(
    resolveGoalPresentationBehavior({ lifecycle: "action_required", status: "awaiting_input" }),
    { tone: "paused", primaryAction: "resume", primaryActionPending: false, canEdit: true, canResume: true },
  );
  assert.deepEqual(
    resolveGoalPresentationBehavior({ lifecycle: "success", status: "completed" }),
    { tone: "completed", primaryAction: null, primaryActionPending: false, canEdit: false, canResume: false },
  );
  assert.deepEqual(
    resolveGoalPresentationBehavior({ lifecycle: "failed", status: "failed" }),
    { tone: "failed", primaryAction: null, primaryActionPending: false, canEdit: false, canResume: false },
  );
});

test("turn boundaries render only between adjacent visible turns", () => {
  assert.equal(shouldRenderTurnBoundary(0, 0), false);
  assert.equal(shouldRenderTurnBoundary(0, 1), false);
  assert.equal(shouldRenderTurnBoundary(0, 2), true);
  assert.equal(shouldRenderTurnBoundary(1, 2), false);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => shouldRenderTurnBoundary(index, 4)),
    [true, true, true, false],
  );
});

test("collapsed process keeps every user message and the final assistant visible", () => {
  const chatAreaSource = fs.readFileSync(
    path.join(workspaceRoot, "src/components/ChatArea.tsx"),
    "utf8",
  );
  assert.match(chatAreaSource, /additionalVisibleUserBlocks/);
  assert.match(chatAreaSource, /additionalVisibleUserBlocks\.map/);
  assert.match(chatAreaSource, /finalVisibleAgentBlock/);
  assert.match(chatAreaSource, /latestTurnChoiceBlock/);
  assert.doesNotMatch(chatAreaSource, /turn\.id === capsuleControlTurn\?\.id && isAwaitingInteractiveChoice/);
  assert.doesNotMatch(chatAreaSource, /<TurnSummaryCard[\s\S]{0,320}embedded/);
});
