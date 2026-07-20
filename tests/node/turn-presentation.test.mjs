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
  buildCapsuleStatusProjection,
  buildPlanExecutionCapsuleProjection,
  buildTurnPresentationModel,
  canOfferPlanContinuation,
  isPlanActionRequestPresentationEligible,
  isPlanReviewCapsulePresentationEligible,
  resolveGoalPresentationBehavior,
  resolvePlanPresentationBehavior,
  resolveTurnPresentationLifecycle,
  shouldRenderTurnBoundary,
} = module.exports;

test("Capsule status projection exposes only structured high-level lifecycle copy", () => {
  const cases = [
    [{ presentation: { intent: "respond", lifecycle: "active", status: "planning" }, isRunActive: true }, "analyzing", "正在分析"],
    [{ presentation: { intent: "plan", lifecycle: "active", status: "planning" }, planStage: "design" }, "planning", "正在制定计划"],
    [{ presentation: { intent: "plan", lifecycle: "active", status: "executing" }, planStage: "executing", planExecutionPhase: "tool_start" }, "executing", "正在执行"],
    [{ presentation: { intent: "plan", lifecycle: "active", status: "executing" }, planStage: "executing", currentTaskExecutionKind: "validation" }, "validating", "正在验证"],
    [{ presentation: { intent: "plan", lifecycle: "active", status: "executing" }, planExecutionPhase: "auto_resume" }, "recovering", "正在恢复"],
    [{ presentation: { intent: "plan", lifecycle: "action_required", status: "awaiting_approval" }, actionKind: "plan_review" }, "awaiting_approval", "等待批准"],
    [{ presentation: { intent: "execute", lifecycle: "action_required", status: "awaiting_input" }, actionKind: "tool_permission" }, "awaiting_permission", "等待权限"],
    [{ presentation: { intent: "execute", lifecycle: "action_required", status: "awaiting_input" }, actionKind: "user_choice" }, "awaiting_choice", "等待选择"],
    [{ presentation: { intent: "execute", lifecycle: "resumable", status: "paused" } }, "paused", "已暂停"],
    [{ presentation: { intent: "execute", lifecycle: "success", status: "done" } }, "completed", "已完成"],
    [{ presentation: { intent: "execute", lifecycle: "partial", status: "partial" } }, "partial", "部分完成"],
    [{ presentation: { intent: "execute", lifecycle: "blocked", status: "blocked" } }, "blocked", "已受阻"],
    [{ presentation: { intent: "execute", lifecycle: "canceled", status: "canceled" } }, "canceled", "已取消"],
    [{ presentation: { intent: "execute", lifecycle: "failed", status: "error" } }, "error", "发生错误"],
  ];

  for (const [input, kind, label] of cases) {
    assert.deepEqual(buildCapsuleStatusProjection({ ...input, language: "zh" }), { kind, label });
  }

  assert.deepEqual(buildCapsuleStatusProjection({
    language: "en",
    presentation: { intent: "execute", lifecycle: "active", status: "executing" },
    planExecutionPhase: "context_compression",
  }), { kind: "recovering", label: "Recovering" });

  assert.deepEqual(buildCapsuleStatusProjection({
    language: "en",
    presentation: { intent: "plan", lifecycle: "success", status: "success" },
    planStage: "executing",
    planExecutionPhase: "paused",
    agentStatus: "error",
  }), { kind: "completed", label: "Completed" });

  const chatAreaSource = fs.readFileSync(
    path.join(workspaceRoot, "src/components/ChatArea.tsx"),
    "utf8",
  );
  const executionCapsuleSource = fs.readFileSync(
    path.join(workspaceRoot, "src/components/ExecutionCapsule.tsx"),
    "utf8",
  );
  assert.match(chatAreaSource, /data-testid="capsule-status-label"/);
  assert.match(chatAreaSource, /className=\{`min-w-0 block flex-1 truncate whitespace-nowrap/);
  assert.doesNotMatch(chatAreaSource, /currentTurnState\.capsuleExplanation/);
  assert.doesNotMatch(chatAreaSource, /deriveDynamicFirstPersonText/);
  assert.doesNotMatch(chatAreaSource, /planExecutionCapsuleProjection\?\.headline/);
  assert.doesNotMatch(chatAreaSource, /capsuleRunStatus\.activityText/);
  assert.doesNotMatch(executionCapsuleSource, /\{activeReviewTask\.target\}/);
});

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

test("canonical runtime outcomes own terminal presentation semantics", () => {
  const terminalCases = [
    ["success", "success", "ordinary", "Completed"],
    ["partial", "partial", "partial", "Partially completed"],
    ["blocked", "blocked", "blocked", "Blocked"],
    ["error", "error", "error", "Error"],
    ["canceled", "canceled", "canceled", "Canceled"],
  ];

  for (const [resultKind, lifecycle, kind, statusLabel] of terminalCases) {
    const model = buildTurnPresentationModel({
      language: "en",
      turn: turn({
        intent: "respond",
        status: "executing",
        runtimeOutcome: {
          status: "completed",
          reason: `terminal_${resultKind}`,
          resultKind,
          runId: `run-${resultKind}`,
          parentRunId: null,
          updatedAt: 10,
        },
      }),
      statusOverride: "paused",
      hasActionRequest: true,
      actionKind: "user_choice",
    });
    assert.equal(model.status, resultKind);
    assert.equal(model.lifecycle, lifecycle);
    assert.equal(model.kind, kind);
    assert.equal(model.statusLabel, statusLabel);
    assert.equal(model.outcomeStatus, "completed");
    assert.equal(model.resultKind, resultKind);
    assert.equal(model.actionKind, undefined);
  }

  const legacyCanceled = buildTurnPresentationModel({
    language: "en",
    turn: turn({
      status: "executing",
      runtimeOutcome: {
        status: "aborted",
        reason: "user_cancelled",
        resultKind: "canceled",
        runId: "run-canceled",
        parentRunId: null,
        updatedAt: 11,
      },
    }),
    statusOverride: "paused",
  });
  assert.deepEqual(
    [
      legacyCanceled.status,
      legacyCanceled.lifecycle,
      legacyCanceled.kind,
      legacyCanceled.statusLabel,
      legacyCanceled.resultKind,
      legacyCanceled.outcomeStatus,
    ],
    ["canceled", "canceled", "canceled", "Canceled", "canceled", "aborted"],
  );
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

test("legacy statuses retain the six-state compatibility lifecycle projection", () => {
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

test("a rejected visible candidate cannot render formal Plan continuation controls", () => {
  const base = {
    hasActivePlanContext: true,
    isPlanApproved: false,
    isAwaitingInput: false,
    canApproveExecution: false,
    agentStatus: "idle",
  };

  assert.equal(canOfferPlanContinuation({
    ...base,
    materializedArtifactCount: 0,
  }), false);
  assert.equal(canOfferPlanContinuation({
    ...base,
    materializedArtifactCount: 1,
  }), true);
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

test("Plan review Capsule requires the exact paused request and current artifact identity", () => {
  const base = {
    actionKind: "plan_review",
    requestStatus: "pending",
    requestSessionKey: "workspace:7",
    requestTurnId: "turn-7",
    requestRunId: "run-7",
    requestPlanRevision: 3,
    requestArtifactHash: "plan-hash-3",
    markerStatus: "paused",
    markerSessionKey: "workspace:7",
    markerTurnId: "turn-7",
    markerRunId: "run-7",
    expectedSessionKey: "workspace:7",
    expectedTurnId: "turn-7",
    currentPlanRevision: 3,
    currentArtifactHash: "plan-hash-3",
  };

  assert.equal(isPlanReviewCapsulePresentationEligible(base), true);
  assert.equal(isPlanReviewCapsulePresentationEligible({ ...base, markerStatus: "running" }), false);
  assert.equal(isPlanReviewCapsulePresentationEligible({ ...base, requestPlanRevision: 2 }), false);
  assert.equal(isPlanReviewCapsulePresentationEligible({ ...base, requestArtifactHash: "stale-hash" }), false);
  assert.equal(isPlanReviewCapsulePresentationEligible({ ...base, actionKind: "tool_permission" }), false);
});

test("preapproval Plan runtime has no user-facing Capsule projection", () => {
  assert.equal(module.exports.buildPlanDraftRuntimeCapsuleProjection, undefined);
  assert.doesNotMatch(source, /PlanDraftRuntimeCapsuleProjection/);
  assert.doesNotMatch(source, /buildPlanDraftRuntimeCapsuleProjection/);
});

test("Plan execution Capsule headline follows runtime progress instead of the first incomplete artifact task", () => {
  const tasks = [
    {
      id: "task-read-placeholder",
      text: "需要读取 src/main.js 中 openFile 函数的完整实现以确认 dialog 调用细节",
      status: "in_progress",
      evidence: [{ kind: "file", value: "src/main.js" }],
    },
    {
      id: "task-patch-runtime",
      text: "修改 src/runtime.ts 的恢复状态投影",
      status: "pending",
      evidence: [{ kind: "file", value: "src/runtime.ts" }],
    },
  ];
  const baseSnapshot = {
    turnId: "turn-plan",
    phase: "running",
    currentTask: tasks[0].text,
    currentTool: "暂无工具调用",
    latestEvidence: "",
    nextStep: "执行真实修改",
    iteration: 1,
    maxIterations: 50,
    autoResumeCount: 0,
    updatedAt: 1,
  };

  const placeholder = buildPlanExecutionCapsuleProjection({
    snapshot: baseSnapshot,
    tasks,
    language: "zh",
  });
  assert.equal(placeholder.headline, "正在推进计划任务");
  assert.equal(placeholder.currentTask, "");
  assert.equal(placeholder.currentTaskId, null);

  const activeReadTool = buildPlanExecutionCapsuleProjection({
    snapshot: {
      ...baseSnapshot,
      phase: "tool_start",
      currentTool: "read_file · src/main.js",
    },
    tasks,
    language: "zh",
  });
  assert.match(activeReadTool.headline, /正在执行.*read_file.*src\/main\.js/);
  assert.equal(activeReadTool.currentTool, "read_file · src/main.js");
  assert.equal(activeReadTool.currentTask, "");
  assert.equal(activeReadTool.currentTaskId, null);

  const authoredReadThenPatchTask = {
    id: "task-read-then-patch",
    text: "先读取 src/runtime.ts，然后修改恢复状态投影",
    status: "pending",
    evidence: [{ kind: "file", value: "src/runtime.ts" }],
  };
  const authoredReadThenPatch = buildPlanExecutionCapsuleProjection({
    snapshot: {
      ...baseSnapshot,
      phase: "tool_start",
      currentTask: authoredReadThenPatchTask.text,
      currentTool: "read_file · src/runtime.ts",
    },
    tasks: [authoredReadThenPatchTask],
    language: "zh",
  });
  assert.equal(authoredReadThenPatch.currentTask, authoredReadThenPatchTask.text);
  assert.equal(authoredReadThenPatch.currentTaskId, authoredReadThenPatchTask.id);

  const activeTool = buildPlanExecutionCapsuleProjection({
    snapshot: {
      ...baseSnapshot,
      phase: "tool_start",
      currentTask: tasks[1].text,
      currentTool: "apply_patch · src/runtime.ts",
    },
    tasks,
    language: "zh",
  });
  assert.match(activeTool.headline, /正在执行.*apply_patch.*src\/runtime\.ts/);
  assert.equal(activeTool.currentTaskId, "task-patch-runtime");

  const failed = buildPlanExecutionCapsuleProjection({
    snapshot: {
      ...baseSnapshot,
      phase: "tool_error",
      currentTask: tasks[1].text,
      currentTool: "apply_patch · src/runtime.ts",
      recoveryReason: "invalid_patch",
      repeatedTargets: ["src/runtime.ts"],
    },
    tasks,
    language: "en",
  });
  assert.equal(failed.tone, "failed");
  assert.match(failed.headline, /Tool execution failed.*apply_patch/);
  assert.equal(failed.recoveryReason, "invalid_patch");
  assert.deepEqual(failed.repeatedTargets, ["src/runtime.ts"]);
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
    resolveGoalPresentationBehavior({ lifecycle: "action_required", status: "awaiting_input", actionKind: "goal_confirmation" }),
    { tone: "paused", primaryAction: "resume", primaryActionPending: false, canEdit: true, canResume: true },
  );
  for (const actionKind of ["tool_permission", "user_choice"]) {
    assert.deepEqual(
      resolveGoalPresentationBehavior({ lifecycle: "action_required", status: "awaiting_input", actionKind }),
      { tone: "paused", primaryAction: "pause", primaryActionPending: false, canEdit: false, canResume: false },
    );
  }
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
