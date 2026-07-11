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
  buildPlanDraftRuntimeCapsuleProjection,
  buildPlanExecutionCapsuleProjection,
  buildTurnPresentationModel,
  isPlanActionRequestPresentationEligible,
  isPlanReviewCapsulePresentationEligible,
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

test("preapproval Plan phase projection requires the exact run and never exposes reasoning text", () => {
  const block = {
    id: 41,
    type: "progress",
    turnId: "turn-plan-draft",
    runId: "run-plan-draft",
    parentRunId: null,
    phase: "summarizing",
    title: "Needs rewrite",
    why: "草稿结构不完整，直接重写可见方案。",
    action: "第 4 次计划生成已持续 65 秒，收到 420 个流式分块；隐藏推理正文不会展示。",
    next: "计划通过质量门后才会进入审核。",
    status: "running",
    source: "runtime",
    targets: [],
    evidence: "",
    phaseReason: "excessive_plan_code_dump",
    iteration: 4,
    qualityRejectCount: 1,
    elapsedMs: 65_000,
    reasoningText: "SECRET MODEL REASONING MUST NEVER RENDER",
    turnPhase: {
      id: "plan_needs_rewrite",
      kind: "diagnosis",
      title: "Needs rewrite",
      summary: "草稿结构不完整，直接重写可见方案。",
      domain: "plan_runtime",
      status: "running",
    },
  };

  const projection = buildPlanDraftRuntimeCapsuleProjection({
    blocks: [block],
    expectedTurnId: "turn-plan-draft",
    expectedRunId: "run-plan-draft",
    language: "zh",
  });
  assert.equal(projection.phaseId, "needs_rewrite");
  assert.equal(projection.runId, "run-plan-draft");
  assert.equal(projection.iteration, 4);
  assert.equal(projection.elapsedMs, 65_000);
  assert.match(projection.heartbeat, /65 秒/);
  assert.match(projection.reason, /excessive_plan_code_dump/);
  assert.doesNotMatch(JSON.stringify(projection), /SECRET MODEL REASONING/);

  assert.equal(buildPlanDraftRuntimeCapsuleProjection({
    blocks: [block],
    expectedTurnId: "turn-plan-draft",
    expectedRunId: "run-stale",
  }), null);
  assert.equal(buildPlanDraftRuntimeCapsuleProjection({
    blocks: [{ ...block, turnPhase: { ...block.turnPhase, status: "done" } }],
    expectedTurnId: "turn-plan-draft",
    expectedRunId: "run-plan-draft",
  }), null);
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
