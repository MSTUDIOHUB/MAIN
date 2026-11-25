import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const kernel = load("src/lib/runtime-v2/index.ts");
const review = load("src/store/runtimeV2/workPlanAdapter.ts");
const { workPlanDraftFromSubmission } = load("src/store/runtimeV2/workPlanSubmission.ts");
const { SUBMIT_WORK_PLAN_TOOL } = load("src/store/runtimeV2/planModelProtocol.ts");
const { createRuntimeV2SchedulerPort } = load("src/store/runtimeV2/executionSchedulerPort.ts");

const turn = {
  workspaceKey: "/fixture-ws",
  sessionKey: "session-delegation",
  sessionEpoch: "epoch-1",
  clientSubmissionId: "sub-delegation",
  turnId: "turn-delegation",
};

const run = {
  sessionKey: turn.sessionKey,
  sessionEpoch: turn.sessionEpoch,
  turnId: turn.turnId,
  runId: "run-delegation",
  parentRunId: null,
  attemptId: "attempt-delegation",
};

function append(state, type, fields = {}) {
  return kernel.transition(state, {
    schemaVersion: kernel.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state ? state.nextSequence : 0,
    eventId: `del-ev-${(state?.nextSequence ?? 0) + 1}`,
    at: (state?.updatedAt ?? 0) + 1,
    type,
    ...fields,
  });
}

test("workPlanDraftFromSubmission removes false auto-infer claims and authorizes same-turn defect repair only on new plans", () => {
  assert.doesNotMatch(SUBMIT_WORK_PLAN_TOOL.function.description, /省略的依赖关系.*自动推断/);
  assert.doesNotMatch(SUBMIT_WORK_PLAN_TOOL.function.parameters.properties.changes.items.properties.dependsOn.description, /默认自动推断/);
  assert.match(SUBMIT_WORK_PLAN_TOOL.function.parameters.properties.changes.items.properties.dependsOn.description, /不会自动推断/);

  const submitted = workPlanDraftFromSubmission(
    {
      planMarkdown: "# MFramework",
      changes: [
        { title: "Define IService", operation: "create", targets: ["Assets/Core/IService.cs"], change: "Add IService", dependsOn: [] },
        { title: "Implement ServiceContainer", operation: "create", targets: ["Assets/Core/ServiceContainer.cs"], change: "Add container", dependsOn: [0] },
      ],
      validations: [{ kind: "advisory", expectedOutcome: "Manual check", stepIndexes: [0, 1] }],
    },
    [],
    "Build core interfaces",
    [],
  );
  assert.equal(submitted.draft.sameTurnDefectCorrection, "authorized");

  const sealed = kernel.sealWorkPlanV1({ draft: submitted.draft, evidence: [], createdAt: 1 });
  assert.match(sealed.markdown, /本轮修复预授权/);

  const legacySealed = kernel.sealWorkPlanV1({
    draft: { ...submitted.draft, sameTurnDefectCorrection: undefined },
    evidence: [],
    createdAt: 1,
  });
  assert.doesNotMatch(legacySealed.markdown, /本轮修复预授权/);
});

test("approved WorkPlan authorizes parallel ready implement delegation in observing and rejects blocked/conflicting/mismatched scopes with exact ready targets", async () => {
  const plan = kernel.sealWorkPlanV1({
    createdAt: 1,
    evidence: [],
    draft: {
      schemaVersion: kernel.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Create base interfaces and dependent container",
      summary: "Parallel interfaces then dependent container.",
      findings: [],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
      sameTurnDefectCorrection: "authorized",
      steps: [
        { title: "IService", operation: "create", targets: ["Assets/Core/IService.cs"], basis: [], change: "Add IService", expectedOutcome: "IService.cs created", dependsOn: [] },
        { title: "ILogger", operation: "create", targets: ["Assets/Log/ILogger.cs"], basis: [], change: "Add ILogger", expectedOutcome: "ILogger.cs created", dependsOn: [] },
        { title: "ServiceContainer", operation: "create", targets: ["Assets/Core/ServiceContainer.cs"], basis: [], change: "Add ServiceContainer", expectedOutcome: "ServiceContainer.cs created", dependsOn: [0, 1] },
      ],
      validations: [{ kind: "advisory", stepIndexes: [0, 1, 2], expectedOutcome: "Manual check", required: false }],
    },
  });
  const commit = review.createRuntimeV2PlanReviewCommit({ plan, turn, run, requestId: "req-1", createdAt: 1 });

  let preApproval = append(null, "turn.admitted", { turn, strategy: "plan", objective: plan.draft.objective, constraints: [], acceptanceCriteria: [] });
  preApproval = append(preApproval, "run.started", { run, phase: "planning" });

  let state = preApproval;
  const closedMessages = [];
  const logs = [];
  const live = { messages: [], childRuns: new Map(), childTelemetry: new Map(), childWriteScopes: new Map(), latestProviderRequestSourceCoverage: [] };
  const makeScheduler = () => createRuntimeV2SchedulerPort({
    live,
    context: { turnId: turn.turnId, runWorkspace: turn.workspaceKey, runSessionKey: turn.sessionKey },
    nextId: (prefix) => `${prefix}-${Math.random().toString(16).slice(2, 8)}`,
    now: () => 100,
    logStoreEvent: (type, payload) => logs.push({ type, payload }),
    get: () => ({
      currentTurnId: turn.turnId,
      conversationTurns: [{ id: turn.turnId, userPrompt: plan.draft.objective, status: "executing" }],
      runtimeV2Checkpoints: {
        [turn.turnId]: kernel.createRuntimeV2Checkpoint({ aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt }),
      },
      toolResultHistory: closedMessages,
    }),
  });

  // 1. Pre-approval write delegation must be rejected
  await assert.rejects(
    () => makeScheduler().prepareSchedule({
      command: {
        idempotencyKey: "cmd-pre-write",
        kind: "schedule_subagents",
        run,
        phase: "planning",
        payload: {
          toolCallId: "tc-pre",
          maxActiveSubagents: 4,
          arguments: {
            task_key: "impl-iservice",
            task_kind: "implement",
            access_mode: "write",
            implementation_operation: "create",
            implementation_plan: "Create IService.cs",
            success_criteria: "IService.cs exists",
            objective: "Create IService.cs",
            name: "iservice-writer",
            role: "implementer",
            required_paths: "Assets/Core/IService.cs",
          },
        },
      },
    }),
    /approved WorkPlan is required/i,
  );

  // 2. Post-approval in `observing`: S1 and S2 can BOTH be delegated in parallel
  state = append(state, "work_plan.sealed", { run, workPlan: review.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit });
  state = append(state, "work_plan.approved", { run, workPlan: review.toRuntimeV2WorkPlanReference(plan, "approved") });
  state = append(state, "phase.changed", { run, phase: "observing", reason: "Approved plan starts in observing" });

  const scheduleCmd = (id, taskKey, op, targetPath) => ({
    idempotencyKey: id,
    kind: "schedule_subagents",
    run,
    phase: "observing",
    payload: {
      toolCallId: `tc-${id}`,
      maxActiveSubagents: 4,
      arguments: {
        task_key: taskKey,
        task_kind: "implement",
        access_mode: "write",
        implementation_operation: op,
        implementation_plan: `Implement ${targetPath}`,
        success_criteria: `${targetPath} created`,
        objective: `Implement ${targetPath}`,
        name: taskKey,
        role: "implementer",
        required_paths: targetPath,
      },
    },
  });

  const s1Scheduled = await makeScheduler().prepareSchedule({
    command: scheduleCmd("cmd-s1", "task-s1", "create", "Assets/Core/IService.cs"),
  });
  assert.equal(s1Scheduled.jobs.length, 1);
  state = append(state, "subagents.scheduled", { run, maxActiveSubagents: 4, jobs: s1Scheduled.jobs });

  const s2Scheduled = await makeScheduler().prepareSchedule({
    command: scheduleCmd("cmd-s2", "task-s2", "create", "Assets/Log/ILogger.cs"),
  });
  assert.equal(s2Scheduled.jobs.length, 1);
  state = append(state, "subagents.scheduled", { run, maxActiveSubagents: 4, jobs: s2Scheduled.jobs });

  // Phase advances from observing to acting while delegated write children are active
  assert.equal(
    kernel.decideRuntimeV2ExecutePhaseTransition(state, { isMutationToolName: () => false })?.to,
    "acting",
  );

  // Overlapping target on active S1 is rejected with accurate reason
  await assert.rejects(
    () => makeScheduler().prepareSchedule({
      command: scheduleCmd("cmd-dup", "task-dup", "create", "Assets/Core/IService.cs"),
    }),
    /overlap active implementation child/i,
  );

  // Blocked dependent S3 before S1 & S2 finish is rejected
  await assert.rejects(
    () => makeScheduler().prepareSchedule({
      command: scheduleCmd("cmd-s3-early", "task-s3-early", "create", "Assets/Core/ServiceContainer.cs"),
    }),
    /prerequisite dependency steps \(dependsOn\)/i,
  );

  // Complete S1 & S2 mutations (subagent.telemetry closes before subagent.completed)
  const completeJob = (jobId, summary, evidenceId, target, version) => {
    const job = state.subagents.find((item) => item.id === jobId);
    const tBase = Math.max(state?.updatedAt ?? 0, job?.requestedAt ?? 0);
    state = append(state, "subagent.telemetry", { run, telemetry: { jobId, phase: "request_opened", at: tBase + 1 } });
    state = append(state, "subagent.telemetry", { run, telemetry: { jobId, phase: "closed", at: tBase + 2 } });
    const evList = [{ id: evidenceId, kind: "mutation", target, version }];
    state = append(state, "subagent.completed", {
      run, jobId, status: "completed", summary,
      evidence: evList,
      report: kernel.compileRuntimeV2SubagentTextReport({ summary: `${summary} (${evidenceId})`, evidence: evList }),
    });
  };
  completeJob(s1Scheduled.jobs[0].id, "Created IService.cs", "m-s1", "Assets/Core/IService.cs", "sha256-" + "a".repeat(64));
  completeJob(s2Scheduled.jobs[0].id, "Created ILogger.cs", "m-s2", "Assets/Log/ILogger.cs", "sha256-" + "b".repeat(64));

  // Operation mismatch & outside plan rejections include currently delegable S3
  await assert.rejects(
    () => makeScheduler().prepareSchedule({
      command: scheduleCmd("cmd-s3-bad-op", "task-s3-bad-op", "modify", "Assets/Core/ServiceContainer.cs"),
    }),
    /Currently delegable ready steps: S3\(create: Assets\/Core\/ServiceContainer\.cs\)/i,
  );
  await assert.rejects(
    () => makeScheduler().prepareSchedule({
      command: scheduleCmd("cmd-outside", "task-outside", "create", "Assets/Unknown.cs"),
    }),
    /outside the approved WorkPlan[\s\S]*S3\(create: Assets\/Core\/ServiceContainer\.cs\)/i,
  );

  // Now valid S3 scheduling succeeds
  const s3Scheduled = await makeScheduler().prepareSchedule({
    command: scheduleCmd("cmd-s3-ok", "task-s3-ok", "create", "Assets/Core/ServiceContainer.cs"),
  });
  assert.equal(s3Scheduled.jobs.length, 1);
  state = append(state, "subagents.scheduled", { run, maxActiveSubagents: 4, jobs: s3Scheduled.jobs });

  completeJob(s3Scheduled.jobs[0].id, "Created ServiceContainer.cs", "m-s3", "Assets/Core/ServiceContainer.cs", "sha256-" + "c".repeat(64));

  // After all delegated targets commit while still in observing, phase transitions cleanly to validating
  assert.equal(
    kernel.decideRuntimeV2ExecutePhaseTransition(state, { isMutationToolName: () => false })?.to,
    "validating",
  );
});
