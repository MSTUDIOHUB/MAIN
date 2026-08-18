import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

function loadTsWithMocks(sourcePath, mocks, scopedCache = new Map()) {
  const normalized = path.resolve(sourcePath);
  if (scopedCache.has(normalized)) return scopedCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  scopedCache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTsWithMocks(candidate, mocks, scopedCache);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  scopedCache.set(normalized, module.exports);
  return module.exports;
}

const runtime = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
const adapter = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/workPlanAdapter.ts"));
const approval = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planApproval.ts"));
const handoff = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planHandoff.ts"));
const engineSelection = loadTs(path.join(workspaceRoot, "src/lib/runtimeEngineSelection.ts"));
const runIntent = loadTs(path.join(workspaceRoot, "src/lib/runIntent.ts"));
const planProtocol = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planModelProtocol.ts"));

const turn = {
  workspaceKey: "/fixture",
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  clientSubmissionId: "submission-a",
  turnId: "turn-a",
};
const run = {
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  turnId: "turn-a",
  runId: "review-run-a",
  parentRunId: null,
  attemptId: "review-run-a",
};

test("Plan preserves an admitted read_file window without a second truncation", async () => {
  const sourceWindow = `${"x".repeat(12_500)}\nTAIL_MARKER`;
  const planEvidence = loadTsWithMocks(
    path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"),
    new Map([
      ["../../lib/toolExecutor", {
        executeTool: async () => sourceWindow,
      }],
      ["../../lib/toolTarget", {
        getToolTarget: () => "src/large.ts",
      }],
      ["../../lib/workspacePaths", {
        workspacePathsReferToSameFile: (left, right) => left === right,
      }],
      ["./sourceEvidenceVersion", {
        resolveRuntimeV2SourceEvidenceVersion: async () => "sha256-large",
      }],
    ]),
  );
  const messages = [];
  const evidence = [];
  const evidenceContents = new Map();
  const settlements = [];
  await planEvidence.executeReadOnlyPlanTool({
    context: {
      runWorkspace: "/fixture",
      runSessionKey: "session",
      runtimeContextBudget: {
        contextLimit: 65_536,
        outputBudget: 8_192,
        inputBudget: 57_344,
        readWindowChars: 32_000,
      },
    },
    ledger: {
      schedule: async () => ({ idempotencyKey: "plan-read-large" }),
      settleCommand: async (event) => settlements.push(event),
      recordSoftSignal: async () => undefined,
    },
    run,
    call: {
      id: "read-large",
      name: "read_file",
      arguments: { path: "src/large.ts" },
    },
    messages,
    evidence,
    evidenceContents,
    parallelReadCount: 1,
    logStoreEvent: () => undefined,
  });

  assert.equal(settlements[0]?.status, "succeeded");
  assert.equal(evidenceContents.get("E1"), sourceWindow);
  assert.match(messages[0]?.content || "", /TAIL_MARKER$/);
  assert.equal(messages[0]?.content.includes(sourceWindow), true);
});

function plan() {
  return runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "修复文件打开与标签显示",
      summary: "统一文件打开入口和保存路径判断。",
      findings: [{ statement: "已确认两个入口竞争创建标签。", basis: ["E1"] }],
      steps: [{
        title: "统一标签生命周期",
        operation: "modify",
        targets: ["src/main.js"],
        basis: ["E1"],
        change: "打开文件时替换空白初始标签。",
        expectedOutcome: "只显示当前文件标签。",
        dependsOn: [],
        criterionIds: ["criterion-user-objective"],
      }],
      validations: [{
        stepIndexes: [0],
        kind: "finite_command",
        command: "npm run build",
        expectedOutcome: "构建通过。",
        required: true,
        criterionIds: ["criterion-user-objective"],
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [{
      id: "E1",
      target: "src/main.js",
      version: "sha-source",
      statement: "两个入口创建标签。",
    }],
    id: "WP-production",
    revision: 2,
    createdAt: 10,
  });
}

function event(sequence, at, value) {
  return {
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence,
    eventId: `event-${sequence}`,
    at,
    ...value,
  };
}

function reviewCheckpoint() {
  const sealed = plan();
  const commit = adapter.createRuntimeV2PlanReviewCommit({
    plan: sealed,
    turn,
    run,
    requestId: "review-request-a",
    createdAt: 20,
  });
  let checkpoint = null;
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint?.revision || 0,
      event: value,
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  append(event(0, 10, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    objective: sealed.draft.objective,
    constraints: [],
    acceptanceCriteria: [],
  }));
  append(event(1, 11, { type: "run.started", run, phase: "planning" }));
  append(event(2, 20, {
    type: "work_plan.sealed",
    run,
    workPlan: adapter.toRuntimeV2WorkPlanReference(sealed),
    sealedPlan: sealed,
    reviewCommit: commit,
  }));
  return { checkpoint, sealed, commit };
}

function planningCheckpointWithCompletedChild() {
  const startedAt = Date.now();
  const evidenceId = "child:0123456789abcdef0123456789abcdef:E1";
  const evidence = {
    id: evidenceId,
    kind: "subagent",
    target: "src/main.js",
    version: "sha-cold-child",
  };
  const report = runtime.compileRuntimeV2SubagentReport({
    draft: {
      summary: `Cold-restored child report cites ${evidenceId}.`,
      findings: [{
        statement: "The restored child found the existing owner in src/main.js.",
        evidence_ids: [evidenceId],
      }],
      unresolved: [],
    },
    evidence: [evidence],
  });
  const scheduled = runtime.scheduleReadOnlySubagents({
    parentRun: run,
    candidates: [{
      scopeKey: "cold-owner-review",
      taskKind: "review",
      name: "Cold owner reviewer",
      role: "reviewer",
      objective: "Review the existing source owner before planning.",
      successCriteria: "Return one cited finding.",
      allowedPaths: ["src/main.js"],
    }],
    maxActiveJobs: 1,
    requestedAt: startedAt + 2,
    nextId: () => "cold-plan-child",
  });
  const child = scheduled.jobs[0];
  let checkpoint = null;
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint?.revision || 0,
      event: value,
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  append(event(0, startedAt - 1, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    subagentRequirement: "required",
    objective: "修复文件打开与标签显示",
    constraints: [],
    acceptanceCriteria: ["修复文件打开与标签显示"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  }));
  append(event(1, startedAt, { type: "run.started", run, phase: "planning" }));
  append(event(2, startedAt + 2, {
    type: "subagents.scheduled",
    run,
    maxActiveSubagents: 1,
    jobs: scheduled.jobs,
  }));
  append(event(3, startedAt + 3, {
    type: "subagent.telemetry",
    run,
    telemetry: { jobId: child.id, phase: "request_opened", at: startedAt + 3 },
  }));
  append(event(4, startedAt + 4, {
    type: "subagent.telemetry",
    run,
    telemetry: { jobId: child.id, phase: "first_token", at: startedAt + 4 },
  }));
  append(event(5, startedAt + 5, {
    type: "subagent.telemetry",
    run,
    telemetry: { jobId: child.id, phase: "closed", at: startedAt + 5 },
  }));
  append(event(6, startedAt + 6, {
    type: "subagent.completed",
    run,
    jobId: child.id,
    status: "completed",
    summary: report.summary,
    evidence: [evidence],
    report,
  }));
  append(event(7, startedAt + 7, {
    type: "subagent.handoff_delivered",
    run,
    jobId: child.id,
    contextEntryId: `child:${child.id}`,
    evidenceIds: [evidenceId],
  }));
  return { checkpoint, child, evidence, evidenceId, report };
}

function reviewingCheckpointWithUnreconciledChildHandoff() {
  const restored = planningCheckpointWithCompletedChild();
  const sealed = runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "修复文件打开与标签显示",
      summary: "Adopt the completed cold-restored child finding.",
      findings: [],
      steps: [{
        title: "Create the child-grounded owner",
        operation: "create",
        targets: ["src/cold-child-owner.js"],
        basis: [restored.evidenceId],
        change: "Create the bounded owner justified by the child finding.",
        expectedOutcome: "The child-grounded owner exists.",
        dependsOn: [],
        criterionIds: ["criterion-user-objective"],
      }],
      validations: [{
        stepIndexes: [0],
        kind: "finite_command",
        command: "npm run build",
        cwd: "/fixture",
        expectedOutcome: "Build succeeds.",
        required: true,
        criterionIds: ["criterion-user-objective"],
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [{
      id: restored.evidence.id,
      target: restored.evidence.target,
      version: null,
      statement: "The restored child found the existing source owner.",
    }],
    id: "WP-cold-child-unreconciled",
    revision: 1,
    createdAt: restored.checkpoint.aggregate.updatedAt + 1,
  });
  const commit = adapter.createRuntimeV2PlanReviewCommit({
    plan: sealed,
    turn,
    run,
    requestId: "review-cold-child-unreconciled",
    createdAt: restored.checkpoint.aggregate.updatedAt + 1,
  });
  const appended = runtime.appendRuntimeV2Checkpoint({
    checkpoint: restored.checkpoint,
    owner: turn,
    expectedRevision: restored.checkpoint.revision,
    event: event(
      restored.checkpoint.aggregate.nextSequence,
      restored.checkpoint.aggregate.updatedAt + 1,
      {
      type: "work_plan.sealed",
      run,
      workPlan: adapter.toRuntimeV2WorkPlanReference(sealed),
      sealedPlan: sealed,
      reviewCommit: commit,
      },
    ),
  });
  assert.equal(appended.disposition, "committed");
  assert.ok(appended.checkpoint);
  assert.equal(
    appended.checkpoint.aggregate.events.some((entry) =>
      entry.type === "subagent.handoff_applied"
    ),
    false,
  );
  return {
    checkpoint: appended.checkpoint,
    child: restored.child,
    evidenceId: restored.evidenceId,
    sealed,
  };
}

function planningCheckpointWithRequirement(subagentRequirement) {
  const startedAt = Date.now();
  let checkpoint = null;
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint?.revision || 0,
      event: value,
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  append(event(0, startedAt - 1, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    subagentRequirement,
    objective: "修复文件打开与标签显示",
    constraints: [],
    acceptanceCriteria: ["修复文件打开与标签显示"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  }));
  append(event(1, startedAt, { type: "run.started", run, phase: "planning" }));
  return checkpoint;
}

function planningCheckpointWithRequiredSpawnTimeouts(timeoutCount) {
  let checkpoint = planningCheckpointWithRequirement("required");
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint.revision,
      event: event(
        checkpoint.aggregate.nextSequence,
        checkpoint.aggregate.updatedAt + 1,
        value,
      ),
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  for (let index = 0; index < timeoutCount; index += 1) {
    const idempotencyKey = `cold-required-spawn-timeout-${index + 1}`;
    append({
      type: "command.scheduled",
      run,
      command: {
        idempotencyKey,
        kind: "request_model",
        run,
        phase: "planning",
        payload: {
          mode: "plan",
          stage: "discovery",
          toolExpectation: "required",
          objective: "修复文件打开与标签显示",
          evidenceIds: [],
          transport: "native_tool",
          requiredSpawn: true,
          submissionRepairPending: false,
          collaborationAllowed: true,
          collaborationRequired: true,
          collaborationRequirementMet: false,
          remainingSubagentCapacity: 1,
          activeSubagents: [],
        },
      },
    });
    append({
      type: "command.completed",
      run,
      idempotencyKey,
      status: "failed",
      failureReasonCode:
        "runtime_v2_plan_required_collaboration_provider_timeout",
    });
  }
  assert.equal(checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(checkpoint.aggregate.subagents, []);
  assert.deepEqual(checkpoint.aggregate.scheduledCommands, []);
  return checkpoint;
}

function planningCheckpointWithTypedSubmissionRejection() {
  const runStartedAt = 1_000_000;
  const rejectionAt = runStartedAt + planProtocol.PLAN_MODEL_DEADLINE_MS - 10;
  const toolCallId = "cold-rejected-work-plan";
  const idempotencyKey = "cold-rejected-work-plan-command";
  const candidate = {
    planMarkdown: "Create the cold-repair owner from the rejected typed candidate.",
    changes: [{
      title: "Create the cold-repair owner",
      operation: "create",
      targets: ["src/cold-repair-owner.js"],
      change: "Create the bounded owner behind the existing module boundary.",
      expectedOutcome: "The cold-repair owner exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [1],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  let checkpoint = null;
  const append = (at, value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint?.revision || 0,
      event: event(checkpoint?.aggregate.nextSequence || 0, at, value),
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  append(runStartedAt - 1, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    subagentRequirement: "optional",
    objective: "修复文件打开与标签显示",
    constraints: [],
    acceptanceCriteria: ["修复文件打开与标签显示"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  });
  append(runStartedAt, { type: "run.started", run, phase: "planning" });
  append(rejectionAt - 1, {
    type: "command.scheduled",
    run,
    command: {
      idempotencyKey,
      kind: "execute_tool",
      run,
      phase: "planning",
      payload: {
        toolCallId,
        toolName: "submit_runtime_v2_work_plan",
        arguments: candidate,
        runtimeControlPlane: true,
      },
    },
  });
  append(rejectionAt, {
    type: "tool.completed",
    run,
    idempotencyKey,
    status: "failed",
    evidence: [],
    failureKind: "protocol_invalid",
    failureReasonCode: "runtime_v2_plan_submission_validation_rejected",
    presentation: {
      toolName: "submit_runtime_v2_work_plan",
      target: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      message:
        "WORK_PLAN_REJECTED: validations[0].stepIndexes references an unknown step.",
    },
  });
  assert.equal(checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(checkpoint.aggregate.scheduledCommands, []);
  return { checkpoint, candidate, rejectionAt, runStartedAt, toolCallId };
}

function planningCheckpointWithRepeatedSubmitOnlyArgumentViolations() {
  const restored = planningCheckpointWithTypedSubmissionRejection();
  let checkpoint = restored.checkpoint;
  const append = (at, value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint.revision,
      event: event(checkpoint.aggregate.nextSequence, at, value),
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  for (let index = 0; index < 2; index += 1) {
    const idempotencyKey = `cold-submit-argument-rejection-${index + 1}`;
    append(restored.rejectionAt + (index * 2) + 1, {
      type: "command.scheduled",
      run,
      command: {
        idempotencyKey,
        kind: "request_model",
        run,
        phase: "planning",
        payload: {
          mode: "plan",
          stage: "synthesis",
          toolExpectation: "required",
          objective: "修复文件打开与标签显示",
          evidenceIds: [],
          transport: "native_tool",
          submissionRepairPending: true,
          compactRecovery: false,
          collaborationAllowed: false,
          collaborationRequired: false,
          collaborationRequirementMet: false,
          remainingSubagentCapacity: 0,
          activeSubagents: [],
          requiredSpawn: false,
        },
      },
    });
    append(restored.rejectionAt + (index * 2) + 2, {
      type: "provider.responded",
      run,
      idempotencyKey,
      result: {
        visibleText: "",
        toolCalls: [],
        usage: {},
        diagnostics: [{
          code: "tool_arguments_rejected",
          message:
            "submit_runtime_v2_work_plan did not satisfy its exact advertised Plan schema: arguments.changes[0].dependsOn is required.",
          retryable: true,
        }],
      },
    });
  }
  assert.deepEqual(checkpoint.aggregate.scheduledCommands, []);
  assert.equal(
    checkpoint.aggregate.events.filter((entry) =>
      entry.type === "provider.responded" &&
      entry.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "tool_arguments_rejected"
      )
    ).length,
    2,
  );
  return {
    ...restored,
    checkpoint,
    restoredAt: restored.rejectionAt + 5,
    effectiveDeadlineAt:
      restored.rejectionAt +
      planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
  };
}

function planningCheckpointWithActiveChild() {
  const startedAt = Date.now();
  const scheduled = runtime.scheduleReadOnlySubagents({
    parentRun: run,
    candidates: [{
      scopeKey: "cold-active-review",
      taskKind: "review",
      name: "Cold active reviewer",
      role: "reviewer",
      objective: "Review the existing owner before the Plan deadline.",
      successCriteria: "Return one bounded source finding.",
      allowedPaths: ["src/main.js"],
    }],
    maxActiveJobs: 2,
    requestedAt: startedAt + 2,
    nextId: () => "cold-active-child",
  });
  const child = scheduled.jobs[0];
  let checkpoint = null;
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint?.revision || 0,
      event: value,
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  append(event(0, startedAt - 1, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    subagentRequirement: "optional",
    objective: "修复文件打开与标签显示",
    constraints: [],
    acceptanceCriteria: ["修复文件打开与标签显示"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  }));
  append(event(1, startedAt, { type: "run.started", run, phase: "planning" }));
  append(event(2, startedAt + 2, {
    type: "subagents.scheduled",
    run,
    maxActiveSubagents: 2,
    jobs: scheduled.jobs,
  }));
  append(event(3, startedAt + 3, {
    type: "subagent.telemetry",
    run,
    telemetry: { jobId: child.id, phase: "request_opened", at: startedAt + 3 },
  }));
  return { checkpoint, child };
}

function actionRequest(commit, overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: commit.review.requestId,
    kind: "plan_review",
    sessionKey: commit.review.sessionKey,
    sessionEpoch: commit.review.sessionEpoch,
    turnId: commit.review.turnId,
    runId: commit.review.runId,
    parentRunId: commit.review.parentRunId,
    title: "Review",
    status: "pending",
    createdAt: commit.review.createdAt,
    planRevision: commit.authority.revision,
    artifactHash: commit.authority.projectionHash,
    artifactPaths: [commit.artifact.path],
    ...overrides,
  };
}

async function runProductionPlanScenario(
  streamCompletion,
  toolExecution,
  options = {},
) {
  let taskId = 0;
  const logs = [];
  let state = {
    conversationTurns: [{
      id: turn.turnId,
      clientSubmissionId: turn.clientSubmissionId,
      userPrompt: "修复文件打开与标签显示",
      status: "running",
      blockIds: [],
    }],
    config: options.config || { language: "zh" },
    planLifecycle: {
      sessionKey: turn.sessionKey,
      sessionEpoch: turn.sessionEpoch,
    },
    runtimeV2Checkpoints: options.initialCheckpoint
      ? { [turn.turnId]: options.initialCheckpoint }
      : {},
    runtimeEvents: [],
    taskFlow: [],
    harnessRunMarker: {
      sessionKey: turn.sessionKey,
      turnId: turn.turnId,
      runId: run.runId,
      status: "running",
    },
    _nextTaskId() {
      taskId += 1;
      return taskId;
    },
  };
  const get = () => state;
  const set = (patchOrUpdater) => {
    const patch = typeof patchOrUpdater === "function"
      ? patchOrUpdater(state)
      : patchOrUpdater;
    state = { ...state, ...(patch || {}) };
  };
  const checkpointPort = {
    getRuntimeV2Checkpoint(current, owner) {
      return current.runtimeV2Checkpoints?.[owner.turnId] || null;
    },
    createRuntimeV2CheckpointPort() {
      return {
        async load({ owner }) {
          return state.runtimeV2Checkpoints?.[owner.turnId] || null;
        },
        async append(input) {
          const current = state.runtimeV2Checkpoints?.[input.owner.turnId] || null;
          const result = runtime.appendRuntimeV2Checkpoint({
            checkpoint: current,
            owner: input.owner,
            expectedRevision: input.expectedRevision,
            event: input.event,
          });
          if (result.checkpoint) {
            state = {
              ...state,
              runtimeV2Checkpoints: {
                ...state.runtimeV2Checkpoints,
                [input.owner.turnId]: result.checkpoint,
              },
            };
          }
          return result;
        },
      };
    },
  };
  const mocks = new Map([
    ["../../lib/providerLaneSettings", {
      deriveStreamSettings: () => ({
        provider: "OMLX",
        apiProtocol: "openai",
        toolProtocol: "auto",
      }),
      deriveBudgetedStreamSettings: (_config, budget) => ({
        contextLimit: budget?.contextLimit,
        provider: "OMLX",
        apiProtocol: "openai",
        toolProtocol: "auto",
      }),
      deriveProviderAdapterCapabilities: () => ({
        nativeToolRoundTrip: options.nativeToolRoundTrip ?? true,
        reasoningToggle: options.reasoningToggle ?? false,
      }),
    }],
    ["../../lib/toolTarget", {
      getToolTarget: (_name, args) => String(args.path || args.query || ""),
    }],
    ["../../lib/streaming", { streamChatCompletion: streamCompletion }],
    ["../../lib/modelLaneCoordinator", {
      acquireModelLane: options.acquireModelLane || (async () => ({
        markFirstToken() {},
        reportFailure() {},
        release() {},
        setPressureHandler() {},
      })),
    }],
    ["../../lib/subagents", {
      resolveSubagentCapacityPolicy: () =>
        options.subagentCapacityPolicy || {
          maxActiveRequests: 0,
          modelRequestMode: "serialized",
        },
    }],
    ["../../lib/toolExecutor", { executeTool: toolExecution }],
    ["../../lib/toolSchemas", {
      READ_ONLY_SUBAGENT_ACCESS_MODES: ["read"],
      READ_ONLY_SUBAGENT_TASK_KINDS: ["explore", "review", "validate"],
      RUNTIME_V2_SUBAGENT_ACCESS_MODES: ["read", "write"],
      RUNTIME_V2_SUBAGENT_TASK_KINDS: ["explore", "review", "validate", "implement"],
      RUNTIME_V2_SUBAGENT_IMPLEMENTATION_OPERATIONS: ["create", "modify", "delete"],
      TOOL_DEFINITIONS: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read one source window.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              start_line: {
                type: "number",
                runtimeIdentityDefault: 1,
              },
              end_line: { type: "number" },
              max_lines: { type: "number" },
              start_char: { type: "number" },
              max_chars: { type: "number" },
            },
            required: ["path"],
          },
        },
      }, {
        type: "function",
        function: {
          name: "spawn_subagent",
          description: "Spawn one child.",
          parameters: {
            type: "object",
            properties: {
              task_key: { type: "string" },
              task_kind: { type: "string", enum: ["explore", "review", "validate", "implement"] },
              access_mode: { type: "string", enum: ["read", "write"] },
              objective: { type: "string" },
              success_criteria: { type: "string" },
              required_paths: { type: "string" },
              allowed_paths: { type: "string" },
              implementation_operation: { type: "string" },
              implementation_plan: { type: "string" },
            },
            required: ["objective", "required_paths"],
          },
        },
      }, {
        type: "function",
        function: {
          name: "wait_subagents",
          description: "Join children.",
          parameters: {
            type: "object",
            properties: {
              subagent_ids: { type: "string" },
              collaboration_task_ids: { type: "string" },
            },
            required: [],
          },
        },
      }],
    }],
    ["../../lib/runtime-v2", runtime],
    ["./checkpointPort", checkpointPort],
    ["./projectionPort", {
      createRuntimeV2ProjectionPort: () => ({ async publish() {} }),
    }],
    ["./workPlanAdapter", adapter],
  ]);
  const planRunner = loadTsWithMocks(
    path.join(workspaceRoot, "src/store/runtimeV2/planRunner.ts"),
    mocks,
  );
  const abortCtrl = new AbortController();
  options.onAbortCtrl?.(abortCtrl);
  const settlement = await planRunner.runSubmitRuntimeV2Plan({
    get,
    set,
    context: {
      turnId: turn.turnId,
      runSessionKey: turn.sessionKey,
      harnessRunId: run.runId,
      runWorkspace: turn.workspaceKey,
      runScopeKey: turn.workspaceKey,
      runSessionId: 1,
      phaseLanguage: "zh",
      abortCtrl,
      timerInterval: undefined,
      runtimeContextBudget: options.runtimeContextBudget || {
        contextLimit: 32_768,
        outputBudget: 4_096,
        inputBudget: 28_672,
        readWindowChars: 18_000,
        source: "configured",
        providerContextLimit: null,
        availableMemoryBytes: null,
      },
      turnInputContextSignals: options.turnInputContextSignals || {
        subagentPreference: "unspecified",
      },
    },
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    buildSessionRuntimeSnapshot: (state) => state,
    publishOwnerScopedRuntimeProjection: () => ({
      published: true,
      disposition: "published",
    }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: (eventName, data) => logs.push({ eventName, data }),
  });
  return {
    settlement,
    state,
    checkpoint: state.runtimeV2Checkpoints[turn.turnId],
    logs,
  };
}

function testModelLaneLease() {
  return {
    markFirstToken() {},
    reportFailure() {},
    release() {},
    setPressureHandler() {},
  };
}

async function withFakePlanClock(startAt, task) {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = startAt;
  let nextTimerId = 0;
  const timers = new Map();
  const timerArms = [];
  const runDueTimers = () => {
    for (let pass = 0; pass < 20; pass += 1) {
      const due = [...timers.entries()].filter(([, timer]) =>
        timer.dueAt <= now
      );
      if (due.length === 0) return;
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.callback(...timer.args);
      }
    }
    throw new Error("fake Plan timers did not converge");
  };
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const delayMs = Math.max(0, Number(delay) || 0);
    const handle = { fakePlanTimerId: ++nextTimerId };
    timerArms.push({ armedAt: now, delayMs });
    timers.set(handle, { callback, args, dueAt: now + delayMs });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };
  try {
    return await task({
      get now() {
        return now;
      },
      timerArms,
      async advanceBy(ms) {
        now += ms;
        runDueTimers();
        await Promise.resolve();
      },
    });
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test("Plan admission selects Runtime v2 and the production runner owns the Plan route", () => {
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("plan"), "v2");
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("execute"), "v2");
  for (const intent of ["respond", "discuss", "analyze", "summarize", "report"]) {
    assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn(intent), "v2");
    assert.equal(engineSelection.isRuntimeV2GlobalChatTurn(intent, undefined), true);
    assert.equal(engineSelection.isRuntimeV2GlobalChatTurn(intent, "/workspace"), false);
    assert.equal(engineSelection.isRuntimeV2WorkspaceReadTurn(intent, "/workspace"), true);
  }
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("goal"), "v2");
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("studio_workflow"), "v2");
  assert.equal(runIntent.resolveWorkspaceAwareWorkflowMode("chat", false), "chat");
  assert.equal(runIntent.resolveWorkspaceAwareWorkflowMode("chat", true), "edit");
  assert.equal(runIntent.resolveWorkspaceAwareWorkflowMode("plan", true), "plan");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "respond",
    runtimeIntent: "respond",
    runWorkspace: undefined,
  }), "chat");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "respond",
    runtimeIntent: "respond",
    runWorkspace: undefined,
    hasAttachedFiles: true,
  }), "workspace_read");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "respond",
    runtimeIntent: "respond",
    runWorkspace: "/workspace",
  }), "workspace_read");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "execute",
    runtimeIntent: "execute",
    runWorkspace: "/workspace",
  }), "execute");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "respond",
    runtimeIntent: "execute",
    runWorkspace: "/workspace",
  }), "execute");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "execute",
    runtimeIntent: "goal",
    runWorkspace: "/workspace",
  }), "goal");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "studio_workflow",
    runtimeIntent: "studio_workflow",
    runWorkspace: "/workspace",
  }), "studio");

  const app = fs.readFileSync(
    path.join(workspaceRoot, "src/App.tsx"),
    "utf8",
  );
  assert.match(app, /setWorkflowMode\(isGlobalChat \? "chat" : "edit"\)/);
  assert.match(
    app,
    /activeScopeKey === GLOBAL_CHAT_KEY[\s\S]{0,160}resolveWorkspaceAwareWorkflowMode\(state\.config\.workflowMode, true\)/,
  );
  assert.match(
    app,
    /setCurrentWorkspace\(stablePath\);[\s\S]{0,160}resetToEmptyChatView\(\);[\s\S]{0,160}hydrateWorkspacePlanForEmptySession\("workspace_open_empty"\)/,
  );
  const store = fs.readFileSync(
    path.join(workspaceRoot, "src/store/useAppStore.ts"),
    "utf8",
  );
  assert.match(
    store,
    /setCurrentWorkspace:[\s\S]*?workflowMode:\s*"chat"[\s\S]*?workflowMode:\s*resolveWorkspaceAwareWorkflowMode\([\s\S]*?s\.config\.workflowMode,[\s\S]*?true/,
  );
  assert.match(
    store,
    /setWorkflowMode:\s*\(mode\)\s*=>[\s\S]*?resolveWorkspaceAwareWorkflowMode\([\s\S]*?mode,[\s\S]*?s\.currentWorkspace/,
  );
  const configSlice = fs.readFileSync(
    path.join(workspaceRoot, "src/store/slices/configSlice.ts"),
    "utf8",
  );
  assert.match(
    configSlice,
    /workflowMode:\s*resolveWorkspaceAwareWorkflowMode\([\s\S]*?nextConfig\.workflowMode,[\s\S]*?s\.currentWorkspace/,
  );

  const runner = fs.readFileSync(
    path.join(workspaceRoot, "src/store/submitRuntimeRunner.ts"),
    "utf8",
  );
  assert.match(runner, /resolveRuntimeV2VisibleRunnerKind/);
  assert.doesNotMatch(runner, /canRunRuntimeV2Plan/);
  assert.match(runner, /runSubmitRuntimeV2Plan/);
  assert.match(runner, /runSubmitRuntimeV2Goal/);
  assert.match(runner, /runSubmitRuntimeV2WorkspaceRead/);
  assert.match(runner, /runtimeV2RunnerKind === "workspace_read"/);
  assert.doesNotMatch(runner, /\bnew WorkflowEngine\b|orchestrator\/workflowEngine/);

  const planRunner = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/planRunner.ts"),
    "utf8",
  );
  const planReviewProjection = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/planReviewProjection.ts"),
    "utf8",
  );
  const planImplementation = `${planRunner}\n${planReviewProjection}`;
  assert.doesNotMatch(planImplementation, /\bPlanArtifact\b|planMaterialization|extractPlan|parsePlan/);
  assert.match(planRunner, /createRuntimeV2PlanReviewCommit/);
  assert.match(planReviewProjection, /content: input\.plan\.markdown/);
  assert.match(planRunner, /reviewCommit: commit/);
  assert.match(planReviewProjection, /markdown: input\.commit\.chat\.markdown/);
  assert.doesNotMatch(planRunner, /plan:soft-round-limit|PLAN_MODEL_ROUND_LIMIT/);
  assert.match(planRunner, /runtime_v2_plan_soft_round_signal/);
  assert.match(planRunner, /terminal:\s*false/);
  assert.match(planRunner, /PLAN_MODEL_DEADLINE_MS/);
});

test("optional preferred Plan advertises collaboration without the hard spawn gate", async () => {
  const requests = [];
  let round = 0;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      round += 1;
      requests.push({ messages, tools, requestOptions });
      if (round === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "read-before-plan",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: "",
        toolCalls: [{
          id: "submit-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: "Use the reviewed source and keep the existing owner boundary.",
            changes: [{
              title: "Update the source owner",
              operation: "modify",
              targets: ["src/main.js"],
              change: "Update the reviewed owner without widening scope.",
              expectedOutcome: "The owner remains coherent.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const owner = true;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "preferred",
        subagentRequirement: "optional",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(result.settlement.outcome.status, "paused");
  const firstToolNames = requests[0].tools.map((tool) => tool.function.name);
  assert.deepEqual(firstToolNames, [
    "read_file",
    "spawn_subagent",
    "submit_runtime_v2_work_plan",
  ]);
  assert.equal(requests[0].requestOptions.toolChoice, "required");
  const opened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.deepEqual(opened.data.offeredToolNames, firstToolNames);
  const firstRequestCommand = result.checkpoint.aggregate.events.find((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  )?.command;
  assert.equal(firstRequestCommand.payload.collaborationAllowed, true);
  assert.equal(firstRequestCommand.payload.collaborationPreferred, true);
  assert.equal(firstRequestCommand.payload.collaborationRequired, false);
  assert.equal(firstRequestCommand.payload.collaborationRequirementMet, false);
  assert.equal(firstRequestCommand.payload.maxActiveSubagents, 1);
  assert.equal(firstRequestCommand.payload.remainingSubagentCapacity, 1);
  const admitted = result.checkpoint.aggregate.events.find((entry) =>
    entry.type === "turn.admitted"
  );
  assert.deepEqual(admitted.acceptanceCriterionIds, [
    "criterion-user-objective",
  ]);
  assert.deepEqual(admitted.acceptanceCriteria, [
    "修复文件打开与标签显示",
  ]);
  assert.match(
    requests[0].messages.map((message) => String(message.content || "")).join("\n"),
    /criterion-user-objective: 修复文件打开与标签显示/,
  );
});

test("production Plan hard-admits one required child before restoring discovery", async () => {
  const parentRequests = [];
  let parentRound = 0;
  let abortCtrl = null;
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      const transcript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      if (/read-only child of the current MAIN turn/i.test(transcript)) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          content: "No child evidence was produced before cancellation.",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }

      parentRound += 1;
      parentRequests.push({ tools, requestOptions });
      if (parentRound === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "required-plan-child",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "required-plan-child",
              task_kind: "review",
              access_mode: "read",
              objective: "Review the current source owner independently.",
              success_criteria: "Return one evidence-backed finding.",
              required_paths: "src/main.js",
              allowed_paths: "src/main.js",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("required-plan-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const owner = true;";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required-plan-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  assert.deepEqual(
    parentRequests[0].tools.map((tool) => tool.function.name),
    ["spawn_subagent"],
  );
  assert.deepEqual(parentRequests[0].requestOptions.toolChoice, {
    type: "function",
    function: { name: "spawn_subagent" },
  });
  assert.deepEqual(
    parentRequests[1].tools.map((tool) => tool.function.name),
    ["read_file", "wait_subagents", "submit_runtime_v2_work_plan"],
  );

  const requestCommands = result.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(requestCommands[0].command.payload.collaborationRequired, true);
  assert.equal(
    requestCommands[0].command.payload.collaborationRequirementMet,
    false,
  );
  assert.equal(requestCommands[1].command.payload.collaborationRequired, true);
  assert.equal(
    requestCommands[1].command.payload.collaborationRequirementMet,
    true,
  );
});

test("required Plan normalizes an in-workspace absolute child scope before restoring discovery", async () => {
  const absoluteScope = `${turn.workspaceKey}/src/main.js`;
  const spawnCallId = "required-plan-absolute-scope";
  const parentRequests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  let childRequestStarted = false;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      const transcript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      if (/read-only child of the current MAIN turn/i.test(transcript)) {
        childRequestStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          content: "No child evidence was produced before cancellation.",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }

      parentRequests.push({ messages, tools, requestOptions });
      if (parentRequests.length === 1) {
        return {
          content: "",
          toolCalls: [{
            id: spawnCallId,
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "required-plan-absolute-scope",
              task_kind: "review",
              access_mode: "read",
              objective: "Review the current source owner independently.",
              success_criteria: "Return one evidence-backed finding.",
              required_paths: absoluteScope,
              allowed_paths: absoluteScope,
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("required-plan-absolute-scope-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const owner = true;";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required-plan-absolute-scope-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  assert.deepEqual(
    parentRequests[0].tools.map((tool) => tool.function.name),
    ["spawn_subagent"],
  );
  assert.deepEqual(parentRequests[0].requestOptions.toolChoice, {
    type: "function",
    function: { name: "spawn_subagent" },
  });
  assert.deepEqual(
    parentRequests[1].tools.map((tool) => tool.function.name),
    ["read_file", "wait_subagents", "submit_runtime_v2_work_plan"],
  );
  assert.equal(parentRequests[1].requestOptions.toolChoice, "required");

  const aggregate = result.checkpoint.aggregate;
  const admittedSpawn = aggregate.events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.toolCalls.some((call) => call.id === spawnCallId)
  )?.result.toolCalls.find((call) => call.id === spawnCallId);
  assert.deepEqual(admittedSpawn?.arguments, {
    task_key: "required-plan-absolute-scope",
    task_kind: "review",
    access_mode: "read",
    objective: "Review the current source owner independently.",
    success_criteria: "Return one evidence-backed finding.",
    required_paths: "src/main.js",
    allowed_paths: "src/main.js",
  });
  const scheduled = aggregate.events.filter((entry) =>
    entry.type === "subagents.scheduled" &&
    entry.jobs.some((job) => job.sourceToolCallId === spawnCallId)
  );
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].jobs.length, 1);
  assert.deepEqual(scheduled[0].jobs[0].allowedPaths, ["src/main.js"]);
  assert.equal(childRequestStarted, true);

  const requestCommands = aggregate.events.filter((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(
    requestCommands[0].command.payload.collaborationRequirementMet,
    false,
  );
  assert.equal(
    requestCommands[1].command.payload.collaborationRequirementMet,
    true,
  );
});

test("required Plan rejects an unadvertised submission and keeps the spawn gate", async () => {
  const parentRequests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const prematureSubmission = {
    planMarkdown: "Create the bounded fixture and verify it.",
    changes: [{
      title: "Create the fixture",
      operation: "create",
      targets: ["required-fixture.js"],
      change: "Create one bounded fixture without changing existing source.",
      expectedOutcome: "The fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const result = await runProductionPlanScenario(
    async (
      _messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      parentRequests.push({ tools, requestOptions });
      if (parentRequests.length === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "premature-required-plan",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(prematureSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("required-plan-rejection-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required-plan-rejection-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  for (const request of parentRequests) {
    assert.deepEqual(
      request.tools.map((tool) => tool.function.name),
      ["spawn_subagent"],
    );
    assert.deepEqual(request.requestOptions.toolChoice, {
      type: "function",
      function: { name: "spawn_subagent" },
    });
  }
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "work_plan.sealed"
    ),
    false,
  );
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.ok(result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_submission_rejected" &&
    /required planning collaboration/i.test(String(entry.data?.detail || ""))
  ), JSON.stringify(result.logs.filter((entry) =>
    /plan_submission|provider_request/.test(entry.eventName)
  )));
});

test("required Plan rejects an unadvertised read batch before admitting a legal spawn", async () => {
  const unadvertisedCallIds = [
    "required-gate-read-main",
    "required-gate-read-helper",
  ];
  const unadvertisedTargets = [
    "src/required-gate-main.js",
    "src/required-gate-helper.js",
  ];
  const parentRequests = [];
  const readExecutions = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  let childRequestStarted = false;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      const transcript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      if (/read-only child of the current MAIN turn/i.test(transcript)) {
        childRequestStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          content: "No child evidence was produced before cancellation.",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }

      parentRequests.push({ messages, tools, requestOptions });
      if (parentRequests.length === 1) {
        return {
          content: "",
          toolCalls: unadvertisedCallIds.map((id, index) => ({
            id,
            name: "read_file",
            arguments: JSON.stringify({ path: unadvertisedTargets[index] }),
          })),
          usage: {},
          protocolViolation: null,
        };
      }
      if (parentRequests.length === 2) {
        return {
          content: "",
          toolCalls: [{
            id: "required-gate-legal-spawn",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "required-gate-legal-spawn",
              task_kind: "review",
              access_mode: "read",
              objective: "Review the current source owner independently.",
              success_criteria: "Return one evidence-backed finding.",
              required_paths: "src/main.js",
              allowed_paths: "src/main.js",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("required-plan-read-rejection-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        readExecutions.push(String(args.path || ""));
        return "export const shouldNeverBeObserved = true;";
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required-plan-read-rejection-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 3);
  for (const request of parentRequests.slice(0, 2)) {
    assert.deepEqual(
      request.tools.map((tool) => tool.function.name),
      ["spawn_subagent"],
    );
    assert.deepEqual(request.requestOptions.toolChoice, {
      type: "function",
      function: { name: "spawn_subagent" },
    });
  }
  assert.deepEqual(
    parentRequests[2].tools.map((tool) => tool.function.name),
    ["read_file", "wait_subagents", "submit_runtime_v2_work_plan"],
  );
  assert.deepEqual(readExecutions, []);

  const rejectionMessages = parentRequests[1].messages.filter((message) =>
    message.role === "tool" &&
    unadvertisedCallIds.includes(message.tool_call_id)
  );
  assert.deepEqual(
    rejectionMessages.map((message) => message.tool_call_id).sort(),
    [...unadvertisedCallIds].sort(),
  );
  for (const message of rejectionMessages) {
    assert.match(
      String(message.content || ""),
      /^PLAN_TOOL_NOT_ADVERTISED:/,
    );
  }

  const aggregate = result.checkpoint.aggregate;
  assert.equal(
    aggregate.evidence.some((entry) =>
      unadvertisedTargets.includes(entry.target)
    ),
    false,
  );
  const unadvertisedCommands = aggregate.events.filter((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "execute_tool" &&
    unadvertisedCallIds.includes(entry.command.payload.toolCallId)
  );
  assert.deepEqual(unadvertisedCommands, []);
  assert.equal(
    aggregate.events.some((entry) => entry.type === "tool.completed"),
    false,
  );
  const quarantinedProviderResponse = aggregate.events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_surface_rejected"
    )
  );
  assert.ok(quarantinedProviderResponse);
  assert.deepEqual(quarantinedProviderResponse.result.toolCalls, []);
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_read_completed" &&
      unadvertisedTargets.includes(entry.data?.target)
    ),
    false,
  );
  assert.equal(childRequestStarted, true);
  assert.ok(aggregate.events.some((entry) =>
    entry.type === "subagents.scheduled" &&
    entry.jobs.some((job) => job.sourceToolCallId === "required-gate-legal-spawn")
  ));
});

test("required Plan with zero child capacity blocks before calling the provider", async () => {
  let providerCalls = 0;
  const result = await runProductionPlanScenario(
    async () => {
      providerCalls += 1;
      throw new Error("the provider must not be called without required child capacity");
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 0,
        modelRequestMode: "serialized",
      },
    },
  );

  assert.equal(providerCalls, 0);
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "blocked");
  const aggregate = result.checkpoint.aggregate;
  assert.equal(aggregate.terminalOutcome?.resultKind, "blocked");
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.equal(
    aggregate.events.some((entry) => entry.type === "work_plan.sealed"),
    false,
  );
  assert.deepEqual(aggregate.scheduledCommands, []);
  assert.equal(
    aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ),
    false,
  );
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_opened"
    ),
    false,
  );
  const terminalLog = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(terminalLog?.data?.resultKind, "blocked");
  assert.equal(
    terminalLog?.data?.detailCode,
    "runtime_v2_plan_required_collaboration_unavailable",
  );
});

test("required Plan retries one timed-out native spawn surface before bounded blocked closure", async () => {
  const requests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (
      messages,
      settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({
        transcript: messages
          .map((message) => String(message.content || ""))
          .join("\n"),
        settings,
        toolNames: tools.map((tool) => tool.function.name),
        requestOptions,
      });
      if (requests.length <= 2) {
        throw new Error(
          "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: required spawn request produced no semantic action",
        );
      }
      abortCtrl.abort("unexpected third required spawn request");
      throw new Error("required spawn recovery exceeded one retry");
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required spawn timeout recovery test timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  const falseSynthesisSwitch = result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_provider_failed" &&
    entry.data?.action === "switch_to_synthesis"
  );
  assert.deepEqual(
    {
      providerCalls: requests.length,
      falseSynthesisSwitch,
    },
    {
      providerCalls: 2,
      falseSynthesisSwitch: false,
    },
    "required spawn timeout recovery is single-use and remains real discovery",
  );
  for (const request of requests) {
    assert.deepEqual(request.toolNames, ["spawn_subagent"]);
    assert.deepEqual(request.requestOptions.toolChoice, {
      type: "function",
      function: { name: "spawn_subagent" },
    });
    assert.equal(request.requestOptions.timeoutMs,
      planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS);
    assert.equal(request.requestOptions.responseFormat, undefined);
  }

  const opened = result.logs.filter((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.equal(opened.length, 2);
  for (const entry of opened) {
    assert.equal(entry.data?.stage, "discovery");
    assert.equal(entry.data?.requestedTransport, "native_tool");
    assert.equal(entry.data?.transport, "native_tool");
    assert.equal(entry.data?.requiredSpawn, true);
    assert.deepEqual(entry.data?.offeredToolNames, ["spawn_subagent"]);
    assert.equal(entry.data?.timeoutMs, planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS);
  }
  const closed = result.logs.filter((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_closed"
  );
  assert.equal(closed.length, 2);
  for (const entry of closed) {
    assert.equal(entry.data?.stage, "discovery");
    assert.equal(entry.data?.transport, "native_tool");
    assert.equal(entry.data?.timeoutMs, planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS);
    assert.equal(entry.data?.timedOut, true);
  }
  assert.equal(falseSynthesisSwitch, false);
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_synthesis_timeout" ||
      entry.eventName === "runtime_v2_plan_provider_transport_fallback"
    ),
    false,
  );

  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "blocked");
  const aggregate = result.checkpoint.aggregate;
  assert.equal(aggregate.terminalOutcome?.resultKind, "blocked");
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.equal(
    aggregate.events.some((entry) => entry.type === "work_plan.sealed"),
    false,
  );
  assert.deepEqual(aggregate.subagents, []);
  assert.deepEqual(aggregate.scheduledCommands, []);
  assert.equal(
    aggregate.events.filter((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ).length,
    2,
  );
  assert.equal(
    aggregate.events.some((entry) =>
      entry.type === "subagents.scheduled" ||
      (
        entry.type === "command.scheduled" &&
        entry.command.kind === "schedule_subagents"
      )
    ),
    false,
  );
  const terminal = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(terminal?.data?.resultKind, "blocked");
  assert.match(String(terminal?.data?.detailCode || ""), /required_collaboration/);
  assert.notEqual(terminal?.data?.detailCode, "runtime_v2_plan_deadline_reached");
});

test("cold-restored required spawn timeout receipts never renew the single retry", async () => {
  const oneTimeoutCheckpoint = planningCheckpointWithRequiredSpawnTimeouts(1);
  const retryRequests = [];
  let retryAbortCtrl = null;
  let retryDiagnosticAbort = null;
  const retried = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      retryRequests.push({
        transcript: messages
          .map((message) => String(message.content || ""))
          .join("\n"),
        toolNames: tools.map((tool) => tool.function.name),
        requestOptions,
      });
      if (retryRequests.length > 1) {
        retryAbortCtrl.abort("cold required spawn retry was renewed");
        throw new Error("cold required spawn retry exceeded its durable budget");
      }
      throw new Error(
        "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: restored required spawn retry produced no semantic action",
      );
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: oneTimeoutCheckpoint,
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        retryAbortCtrl = controller;
        retryDiagnosticAbort = setTimeout(
          () => controller.abort("cold required spawn retry test timeout"),
          2_000,
        );
      },
    },
  );
  if (retryDiagnosticAbort) clearTimeout(retryDiagnosticAbort);

  assert.equal(retryRequests.length, 1);
  assert.deepEqual(retryRequests[0].toolNames, ["spawn_subagent"]);
  assert.deepEqual(retryRequests[0].requestOptions.toolChoice, {
    type: "function",
    function: { name: "spawn_subagent" },
  });
  assert.equal(
    retryRequests[0].requestOptions.timeoutMs,
    planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS,
  );
  assert.equal(retryRequests[0].requestOptions.responseFormat, undefined);
  const retryOpened = retried.logs.filter((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.equal(retryOpened.length, 1);
  assert.equal(retryOpened[0].data?.stage, "discovery");
  assert.equal(retryOpened[0].data?.requestedTransport, "native_tool");
  assert.equal(retryOpened[0].data?.transport, "native_tool");
  assert.equal(retryOpened[0].data?.requiredSpawn, true);
  assert.deepEqual(retryOpened[0].data?.offeredToolNames, ["spawn_subagent"]);
  const retryTimeout = retried.logs.find((entry) =>
    entry.eventName ===
      "runtime_v2_plan_required_collaboration_provider_timeout"
  );
  assert.equal(retryTimeout?.data?.attempt, 2);
  assert.equal(retryTimeout?.data?.maxAttempts, 2);
  assert.equal(retryTimeout?.data?.stage, "discovery");
  assert.equal(retryTimeout?.data?.transport, "native_tool");
  assert.equal(retryTimeout?.data?.terminal, true);
  assert.equal(retryTimeout?.data?.action, "block");
  assert.equal(
    retried.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_failed" &&
      entry.data?.action === "switch_to_synthesis"
    ),
    false,
  );
  assert.equal(retried.settlement.outcome.status, "completed");
  assert.equal(retried.settlement.outcome.resultKind, "blocked");
  assert.equal(retried.checkpoint.aggregate.terminalOutcome?.resultKind, "blocked");
  assert.equal(retried.checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(retried.checkpoint.aggregate.subagents, []);
  assert.deepEqual(retried.checkpoint.aggregate.scheduledCommands, []);
  const durableRetryTimeouts = retried.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "command.completed" &&
    entry.status === "failed" &&
    entry.failureReasonCode ===
      "runtime_v2_plan_required_collaboration_provider_timeout"
  );
  assert.equal(durableRetryTimeouts.length, 2);
  assert.equal(
    retried.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model" &&
      entry.command.payload.requiredSpawn === true
    ).length,
    2,
  );

  const twoTimeoutCheckpoint = planningCheckpointWithRequiredSpawnTimeouts(2);
  let exhaustedProviderCalls = 0;
  const exhausted = await runProductionPlanScenario(
    async () => {
      exhaustedProviderCalls += 1;
      throw new Error("a fully consumed cold spawn retry must not call the provider");
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: twoTimeoutCheckpoint,
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(exhaustedProviderCalls, 0);
  assert.equal(
    exhausted.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_opened"
    ),
    false,
  );
  assert.equal(exhausted.settlement.outcome.status, "completed");
  assert.equal(exhausted.settlement.outcome.resultKind, "blocked");
  assert.equal(exhausted.checkpoint.aggregate.terminalOutcome?.resultKind, "blocked");
  assert.equal(exhausted.checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(exhausted.checkpoint.aggregate.subagents, []);
  assert.deepEqual(exhausted.checkpoint.aggregate.scheduledCommands, []);
  assert.equal(
    exhausted.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model" &&
      entry.command.payload.requiredSpawn === true
    ).length,
    2,
  );
  const exhaustedTerminal = exhausted.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(exhaustedTerminal?.data?.resultKind, "blocked");
  assert.equal(
    exhaustedTerminal?.data?.detailCode,
    "runtime_v2_plan_required_collaboration_provider_timeout",
  );
});

test("cold-restored required Plan rehydrates completed child evidence before its first provider request", async () => {
  const restored = planningCheckpointWithCompletedChild();
  let providerCalls = 0;
  let firstTranscript = "";
  let firstToolNames = [];
  let firstToolChoice = null;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      providerCalls += 1;
      firstTranscript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      firstToolNames = tools.map((tool) => tool.function.name);
      firstToolChoice = requestOptions.toolChoice;
      return {
        content: "",
        toolCalls: [{
          id: "submit-from-restored-child",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: `Adopt the restored child finding ${restored.evidenceId}.`,
            changes: [{
              title: "Create the bounded repaired owner",
              operation: "create",
              targets: ["src/restored-owner.js"],
              basis: [restored.evidenceId],
              change: "Create the repaired owner described by the restored child finding.",
              expectedOutcome: "The repaired owner exists without modifying the reviewed source.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: restored.checkpoint,
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(providerCalls, 1);
  assert.match(firstTranscript, new RegExp(
    restored.evidenceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ));
  assert.match(firstTranscript, /Cold-restored child report cites/);
  assert.match(
    firstTranscript,
    /The restored child found the existing owner in src\/main\.js/,
  );
  assert.equal(firstToolNames.includes("spawn_subagent"), false);
  assert.equal(firstToolNames.includes("submit_runtime_v2_work_plan"), true);
  assert.equal(firstToolChoice, "required");
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.ok(
    result.checkpoint.aggregate.sealedWorkPlan.draft.steps[0].basis.includes(
      restored.evidenceId,
    ),
  );
  assert.equal(
    result.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "subagents.scheduled"
    ).length,
    1,
  );
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "schedule_subagents"
    ),
    false,
  );
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_submission_rejected"
    ),
    false,
  );
  const firstRequest = result.checkpoint.aggregate.events.find((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(firstRequest.command.payload.collaborationRequired, true);
  assert.equal(firstRequest.command.payload.collaborationRequirementMet, true);
});

test("cold-restored reviewing Plan reconciles one missing sealed child handoff exactly once", async () => {
  const restored = reviewingCheckpointWithUnreconciledChildHandoff();
  let providerCalls = 0;
  const runRestoredReview = (initialCheckpoint) => runProductionPlanScenario(
    async () => {
      providerCalls += 1;
      throw new Error("a reviewing cold restore must not call the provider");
    },
    async (name) => {
      throw new Error(`a reviewing cold restore must not execute ${name}`);
    },
    { initialCheckpoint },
  );

  const first = await runRestoredReview(restored.checkpoint);
  assert.equal(providerCalls, 0);
  assert.equal(first.settlement.outcome.status, "paused");
  const sealed = first.checkpoint.aggregate.events.find((entry) =>
    entry.type === "work_plan.sealed"
  );
  assert.ok(sealed);
  const firstApplied = first.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "subagent.handoff_applied"
  );
  assert.equal(firstApplied.length, 1);
  assert.equal(firstApplied[0].jobId, restored.child.id);
  assert.deepEqual(firstApplied[0].evidenceIds, [restored.evidenceId]);
  assert.equal(firstApplied[0].source, "work_plan");
  assert.equal(firstApplied[0].sourceEventId, sealed.eventId);
  assert.ok(firstApplied[0].sequence > sealed.sequence);
  const reconciledRevision = first.checkpoint.revision;

  const second = await runRestoredReview(first.checkpoint);
  assert.equal(providerCalls, 0);
  assert.equal(second.settlement.outcome.status, "paused");
  assert.equal(second.checkpoint.revision, reconciledRevision);
  const secondApplied = second.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "subagent.handoff_applied"
  );
  assert.equal(secondApplied.length, 1);
  assert.equal(secondApplied[0].eventId, firstApplied[0].eventId);
});

test("cold-restored Plan derives its lifecycle deadline from durable run.started time", async () => {
  const checkpoint = planningCheckpointWithRequirement("optional");
  const durableRunStarted = checkpoint.aggregate.events.find((entry) =>
    entry.type === "run.started"
  );
  assert.ok(durableRunStarted);
  const originalNow = Date.now;
  let providerCalls = 0;
  let result;

  Date.now = () =>
    durableRunStarted.at + planProtocol.PLAN_MODEL_DEADLINE_MS + 1;
  try {
    result = await runProductionPlanScenario(
      async () => {
        providerCalls += 1;
        return {
          content: "",
          toolCalls: [{
            id: "submit-after-expired-cold-restore",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "Create and validate the bounded restored fixture.",
              changes: [{
                title: "Create the restored fixture",
                operation: "create",
                targets: ["src/restored-deadline.js"],
                change: "Create the bounded fixture after review.",
                expectedOutcome: "The restored fixture exists.",
                dependsOn: [],
                criterionIds: ["criterion-user-objective"],
              }],
              validations: [{
                kind: "finite_command",
                command: "npm run build",
                cwd: "/fixture",
                expectedOutcome: "Build succeeds.",
                required: true,
                stepIndexes: [0],
                criterionIds: ["criterion-user-objective"],
              }],
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      { initialCheckpoint: checkpoint },
    );
  } finally {
    Date.now = originalNow;
  }

  assert.equal(
    providerCalls,
    0,
    "cold recovery must not grant a fresh eight-minute Plan lifecycle",
  );
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ),
    false,
  );
  const terminal = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(terminal?.data?.detailCode, "runtime_v2_plan_deadline_reached");
});

test("Plan applies child handoff only from a sealed WorkPlan basis, not a rejected truncated result", async () => {
  const restored = planningCheckpointWithCompletedChild();
  let providerRound = 0;
  const result = await runProductionPlanScenario(
    async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return {
          content: `I inspected ${restored.evidenceId}, but this WorkPlan response was truncated.`,
          toolCalls: [{
            id: "truncated-child-plan",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "This incomplete submission does not adopt child evidence.",
              changes: [],
            }),
          }],
          finishReason: "length",
          usage: {},
          protocolViolation: "tool_call_truncated",
        };
      }
      return {
        content: "",
        toolCalls: [{
          id: "submit-sealed-child-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: `Adopt the completed child finding ${restored.evidenceId}.`,
            changes: [{
              title: "Create the child-grounded owner",
              operation: "create",
              targets: ["src/child-grounded-owner.js"],
              basis: [restored.evidenceId],
              change: "Create the bounded owner justified by the completed child finding.",
              expectedOutcome: "The child-grounded owner exists.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: restored.checkpoint,
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(providerRound, 2);
  assert.equal(result.settlement.outcome.status, "paused");
  const events = result.checkpoint.aggregate.events;
  const rejectedProviderResult = events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_arguments_rejected"
    )
  );
  assert.ok(rejectedProviderResult);
  assert.deepEqual(rejectedProviderResult.result.toolCalls, []);
  assert.match(
    rejectedProviderResult.result.visibleText || "",
    new RegExp(restored.evidenceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.ok(result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_provider_response_shape" &&
    entry.data?.finishReason === "length" &&
    entry.data?.admittedToolCallCount === 0
  ));
  const sealed = events.find((entry) => entry.type === "work_plan.sealed");
  assert.ok(sealed);
  assert.ok(sealed.sealedPlan.draft.steps[0].basis.includes(restored.evidenceId));
  const applied = events.filter((entry) =>
    entry.type === "subagent.handoff_applied"
  );
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].evidenceIds, [restored.evidenceId]);
  assert.equal(
    applied[0].sourceEventId,
    sealed.eventId,
    "only the successfully sealed structured basis may adopt child evidence",
  );
  assert.equal(applied[0].source, "work_plan");
  assert.ok(applied[0].sequence > sealed.sequence);
  assert.notEqual(applied[0].sourceEventId, rejectedProviderResult.eventId);
});

test("Plan withholds new spawn below the shared child runway while preserving active wait", async () => {
  const originalNow = Date.now;
  const firstRestored = planningCheckpointWithActiveChild();
  const runStartedAt = firstRestored.checkpoint.aggregate.events.find((entry) =>
    entry.type === "run.started"
  )?.at;
  assert.equal(typeof runStartedAt, "number");
  const now = runStartedAt +
    planProtocol.PLAN_MODEL_DEADLINE_MS -
    runtime.RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS +
    1;
  const waitRequests = [];
  let waitAbortCtrl = null;
  let waitDiagnosticAbort = null;
  let waitResult;

  Date.now = () => now;
  try {
    waitResult = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        _callbacks,
        _signal,
        tools,
        _maxOutputTokens,
        requestOptions,
      ) => {
        waitRequests.push({
          toolNames: tools.map((tool) => tool.function.name),
          requestOptions,
        });
        if (waitRequests.length === 1) {
          return {
            content: "",
            toolCalls: [{
              id: "wait-near-plan-deadline",
              name: "wait_subagents",
              arguments: JSON.stringify({
                collaboration_task_ids: firstRestored.child.scopeKey,
              }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        waitAbortCtrl.abort("near-deadline wait contract captured");
        return {
          content: "",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        initialCheckpoint: firstRestored.checkpoint,
        turnInputContextSignals: {
          subagentPreference: "preferred",
          subagentRequirement: "optional",
        },
        subagentCapacityPolicy: {
          maxActiveRequests: 2,
          modelRequestMode: "parallel",
        },
        onAbortCtrl: (controller) => {
          waitAbortCtrl = controller;
          waitDiagnosticAbort = setTimeout(
            () => controller.abort("near-deadline wait test timeout"),
            2_000,
          );
        },
      },
    );
  } finally {
    Date.now = originalNow;
    if (waitDiagnosticAbort) clearTimeout(waitDiagnosticAbort);
  }

  assert.ok(waitRequests.length >= 1);
  assert.equal(waitRequests[0].toolNames.includes("spawn_subagent"), false);
  assert.equal(waitRequests[0].toolNames.includes("wait_subagents"), true);
  assert.equal(waitRequests[0].requestOptions.toolChoice, "required");
  assert.ok(waitResult.checkpoint.aggregate.events.some((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "join_subagents"
  ));
  assert.ok(waitResult.checkpoint.aggregate.events.some((entry) =>
    entry.type === "subagent.completed" &&
    entry.jobId === firstRestored.child.id
  ));

  const secondRestored = planningCheckpointWithActiveChild();
  const secondRunStartedAt = secondRestored.checkpoint.aggregate.events.find(
    (entry) => entry.type === "run.started",
  )?.at;
  assert.equal(typeof secondRunStartedAt, "number");
  const secondNow = secondRunStartedAt +
    planProtocol.PLAN_MODEL_DEADLINE_MS -
    runtime.RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS +
    1;
  const spawnRequests = [];
  let spawnAbortCtrl = null;
  let spawnDiagnosticAbort = null;
  let spawnResult;
  Date.now = () => secondNow;
  try {
    spawnResult = await runProductionPlanScenario(
      async (
        _messages,
        settings,
        _callbacks,
        _signal,
        tools,
        _maxOutputTokens,
        requestOptions,
      ) => {
        spawnRequests.push({
          toolNames: tools.map((tool) => tool.function.name),
          requestOptions,
        });
        spawnAbortCtrl.abort("near-deadline spawn admission captured");
        return {
          content: "",
          toolCalls: [{
            id: "late-duplicate-spawn",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: secondRestored.child.scopeKey,
              task_kind: "review",
              access_mode: "read",
              objective: "Start another review despite insufficient lifecycle runway.",
              success_criteria: "Return one bounded source finding.",
              required_paths: "src/main.js",
              allowed_paths: "src/main.js",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        initialCheckpoint: secondRestored.checkpoint,
        turnInputContextSignals: {
          subagentPreference: "preferred",
          subagentRequirement: "optional",
        },
        subagentCapacityPolicy: {
          maxActiveRequests: 2,
          modelRequestMode: "parallel",
        },
        onAbortCtrl: (controller) => {
          spawnAbortCtrl = controller;
          spawnDiagnosticAbort = setTimeout(
            () => controller.abort("near-deadline spawn test timeout"),
            2_000,
          );
        },
      },
    );
  } finally {
    Date.now = originalNow;
    if (spawnDiagnosticAbort) clearTimeout(spawnDiagnosticAbort);
  }

  assert.equal(spawnRequests.length, 1);
  assert.equal(spawnRequests[0].toolNames.includes("spawn_subagent"), false);
  assert.equal(spawnRequests[0].toolNames.includes("wait_subagents"), true);
  const quarantined = spawnResult.checkpoint.aggregate.events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_surface_rejected"
    )
  );
  assert.ok(quarantined);
  assert.deepEqual(quarantined.result.toolCalls, []);
  assert.equal(
    spawnResult.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "subagents.scheduled"
    ).length,
    1,
    "the original active child must remain the only admitted child",
  );
  assert.equal(
    spawnResult.checkpoint.aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "schedule_subagents"
    ),
    false,
  );
});

test("cold-restored aggregate required Plan cannot be downgraded by optional context", async () => {
  const requests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const prematureSubmission = {
    planMarkdown: "Attempt to submit without the required restored collaboration.",
    changes: [{
      title: "Create the bounded fixture",
      operation: "create",
      targets: ["src/restored-required.js"],
      change: "Create the bounded fixture after planning approval.",
      expectedOutcome: "The fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({ messages, tools, requestOptions });
      if (requests.length === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "restored-required-premature-submit",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(prematureSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      abortCtrl.abort("restored-required-gate-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: planningCheckpointWithRequirement("required"),
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "optional",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("restored-required-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(
      request.tools.map((tool) => tool.function.name),
      ["spawn_subagent"],
    );
    assert.deepEqual(request.requestOptions.toolChoice, {
      type: "function",
      function: { name: "spawn_subagent" },
    });
  }
  assert.match(
    requests[0].messages.map((message) => message.content || "").join("\n"),
    /\[REQUIRED COLLABORATION\]/,
  );
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "work_plan.sealed"
    ),
    false,
  );
  assert.equal(result.checkpoint.aggregate.subagents.length, 0);
  const requestCommands = result.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(requestCommands.length, 2);
  assert.equal(requestCommands[0].command.payload.collaborationRequired, true);
  assert.equal(requestCommands[1].command.payload.collaborationRequired, true);
  assert.ok(result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_submission_rejected" &&
    /required planning collaboration/i.test(String(entry.data?.detail || ""))
  ));
});

test("cold-restored aggregate optional Plan cannot be upgraded by required context", async () => {
  let providerCalls = 0;
  let firstTranscript = "";
  let firstToolNames = [];
  let firstToolChoice = null;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      providerCalls += 1;
      firstTranscript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      firstToolNames = tools.map((tool) => tool.function.name);
      firstToolChoice = requestOptions.toolChoice;
      return {
        content: "",
        toolCalls: [{
          id: "submit-restored-optional-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: "Create and validate the bounded optional fixture.",
            changes: [{
              title: "Create the optional fixture",
              operation: "create",
              targets: ["src/restored-optional.js"],
              change: "Create the bounded fixture after approval.",
              expectedOutcome: "The optional fixture exists.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: planningCheckpointWithRequirement("optional"),
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(providerCalls, 1);
  assert.equal(firstTranscript.includes("[REQUIRED COLLABORATION]"), false);
  assert.deepEqual(firstToolNames, [
    "read_file",
    "submit_runtime_v2_work_plan",
  ]);
  assert.equal(firstToolChoice, "required");
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.ok(result.checkpoint.aggregate.sealedWorkPlan);
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "subagents.scheduled" ||
      (
        entry.type === "command.scheduled" &&
        entry.command.kind === "schedule_subagents"
      )
    ),
    false,
  );
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_submission_rejected"
    ),
    false,
  );
  const firstRequest = result.checkpoint.aggregate.events.find((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(firstRequest.command.payload.collaborationRequired, false);
  assert.equal(firstRequest.command.payload.collaborationRequirementMet, false);
});

test("production Plan rejects an incomplete typed graph before sealing", async () => {
  let round = 0;
  let correctionTranscript = "";
  const validSubmission = {
    planMarkdown: "Create the implementation before its deterministic tests.",
    changes: [{
      title: "Create implementation",
      operation: "create",
      targets: ["snake.py"],
      change: "Create the game implementation.",
      expectedOutcome: "The implementation exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }, {
      title: "Create tests",
      operation: "create",
      targets: ["test_snake.py"],
      change: "Create deterministic logic tests.",
      expectedOutcome: "The implementation has automated coverage.",
      dependsOn: [0],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "python3 -m unittest -v",
      expectedOutcome: "The tests pass.",
      required: true,
      stepIndexes: [0, 1],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const result = await runProductionPlanScenario(
    async (messages) => {
      round += 1;
      if (round === 1) {
        const invalidSubmission = structuredClone(validSubmission);
        delete invalidSubmission.changes[1].dependsOn;
        return {
          content: "",
          toolCalls: [{
            id: "submit-incomplete-graph",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(invalidSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      correctionTranscript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      return {
        content: "",
        toolCalls: [{
          id: "submit-corrected-graph",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify(validSubmission),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "empty fixture";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(round, 2);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.match(
    correctionTranscript,
    /PLAN_TOOL_ARGUMENTS_REJECTED:.*arguments\.changes\[1\]\.dependsOn is required/,
  );
  const rejectedProviderResult = result.checkpoint.aggregate.events.find(
    (event) =>
      event.type === "provider.responded" &&
      event.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "tool_arguments_rejected"
      ),
  );
  assert.ok(rejectedProviderResult);
  assert.deepEqual(rejectedProviderResult.result.toolCalls, []);
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "work_plan.sealed"
    ).length,
    1,
  );
  assert.ok(result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_submission_rejected" &&
    /arguments\.changes\[1\]\.dependsOn is required/.test(
      String(entry.data?.detail || ""),
    )
  ));
});

test("production Plan runs, joins, and adopts one read-only child before review", async () => {
  let parentRound = 0;
  let childRound = 0;
  let parentReadWhileChildActive = false;
  let childInFlight = false;
  const requestTools = [];
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, callbacks, _signal, tools) => {
      const requestTranscript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      if (/read-only child of the current MAIN turn/i.test(requestTranscript)) {
        childRound += 1;
        childInFlight = true;
        callbacks.onLifecycle?.({ phase: "first_chunk" });
        if (childRound === 1) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          childInFlight = false;
          return {
            content: "",
            toolCalls: [{
              id: "child-read-main",
              name: "read_file",
              arguments: JSON.stringify({ path: "src/main.js" }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        const transcript = messages
          .map((message) => String(message.content || ""))
          .join("\n");
        const evidenceId = transcript.match(/child:[^\s,]+:E1/)?.[0];
        assert.ok(evidenceId, "the child must cite its real tool evidence");
        assert.match(
          evidenceId,
          /^child:[0-9a-f]{32}:E1$/,
          "provider-facing child evidence ids must stay compact and stable",
        );
        if (childRound === 2) {
          childInFlight = false;
          return {
            content: "The reviewed owner is in src/main.js.",
            semanticContent: "The reviewed owner is in src/main.js.",
            actionableContent: "The reviewed owner is in src/main.js.",
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        }
      assert.match(
        transcript,
        /CHILD_REPORT_REJECTED/,
          "an uncited ordinary final must receive one causal report repair turn",
        );
        assert.equal(
          tools.length,
          1,
          "the bounded report-repair turn must expose one report tool",
        );
        assert.equal(
          tools[0]?.function?.name,
          "submit_runtime_v2_subagent_report",
        );
        assert.deepEqual(
          tools[0]?.function?.parameters?.properties?.findings?.items
            ?.properties?.evidence_ids?.items?.enum,
          [evidenceId],
        );
        childInFlight = false;
        const childSummary =
          `The reviewed owner is in src/main.js (${evidenceId}).`;
        return {
          content: "",
          semanticContent: "",
          actionableContent: "",
          toolCalls: [{
            id: "submit-child-report",
            name: "submit_runtime_v2_subagent_report",
            arguments: JSON.stringify({
              summary: childSummary,
              findings: [{
                statement: "The reviewed owner is in src/main.js.",
                evidence_ids: [evidenceId],
              }],
              unresolved: [],
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      parentRound += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      const names = tools.map((tool) => tool.function.name);
      requestTools.push(names);
      if (parentRound === 1) {
        assert.equal(names.includes("spawn_subagent"), true);
        return {
          content: "",
          toolCalls: [{
            id: "spawn-owner-review",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "owner-review",
              task_kind: "review",
              access_mode: "read",
              objective: "Independently review the current source owner.",
              success_criteria: "Return one cited source finding.",
              required_paths: "src/main.js",
              allowed_paths: "src/main.js",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (parentRound === 2) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        parentReadWhileChildActive = childInFlight;
        assert.equal(names.includes("wait_subagents"), true);
        assert.equal(names.includes("spawn_subagent"), false);
        return {
          content: "",
          toolCalls: [{
            id: "parent-read-main",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (parentRound === 3) {
        assert.equal(names.includes("wait_subagents"), true);
        return {
          content: "",
          toolCalls: [{
            id: "wait-owner-review",
            name: "wait_subagents",
            arguments: JSON.stringify({
              collaboration_task_ids: "owner-review",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      const transcript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      const childEvidenceId = transcript.match(/child:[^\s,]+:E1/)?.[0];
      assert.ok(childEvidenceId, "joined child evidence must reach the parent");
      if (parentRound === 4) {
        assert.match(transcript, /SUBAGENT_RESULTS/);
        return {
          content: "",
          toolCalls: [{
            id: "submit-without-child-adoption",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "Use only the parent source observation.",
              changes: [{
                title: "Update the reviewed owner",
                operation: "modify",
                targets: ["src/main.js"],
                basis: ["E2"],
                change: "Update the reviewed owner while preserving its public boundary.",
                expectedOutcome: "The owner remains coherent.",
                dependsOn: [],
                criterionIds: ["criterion-user-objective"],
              }],
              validations: [{
                kind: "finite_command",
                command: "npm run build",
                cwd: "/fixture",
                expectedOutcome: "Build succeeds.",
                required: true,
                stepIndexes: [0],
                criterionIds: ["criterion-user-objective"],
              }],
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      assert.match(
        transcript,
        /Completed planning child evidence must be explicitly assessed/,
      );
      assert.deepEqual(
        names,
        ["submit_runtime_v2_work_plan"],
        "a rejected submission must enter the submit-only repair surface",
      );
      assert.match(transcript, /Correct the rejected WorkPlan structure/);
      assert.match(transcript, /Rejected submission to correct/);
      assert.match(transcript, /Child report: The reviewed owner is in src\/main\.js/);
      assert.match(transcript, /Finding: The reviewed owner is in src\/main\.js/);
      assert.match(transcript, new RegExp(childEvidenceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      if (parentRound === 5) {
        assert.match(transcript, /Use only the parent source observation/);
        return {
          content: "",
          toolCalls: [{
            id: "submit-still-without-child-adoption",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "Second rejected submission still omits child adoption.",
              changes: [{
                title: "Update the reviewed owner",
                operation: "modify",
                targets: ["src/main.js"],
                basis: ["E2"],
                change: "Update the reviewed owner while preserving its public boundary.",
                expectedOutcome: "The owner remains coherent.",
                dependsOn: [],
                criterionIds: ["criterion-user-objective"],
              }],
              validations: [{
                kind: "finite_command",
                command: "npm run build",
                cwd: "/fixture",
                expectedOutcome: "Build succeeds.",
                required: true,
                stepIndexes: [0],
                criterionIds: ["criterion-user-objective"],
              }],
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      assert.match(
        transcript,
        /Second rejected submission still omits child adoption/,
        "a second rejection must remain in the narrow semantic repair window",
      );
      return {
        content: "",
        toolCalls: [{
          id: "submit-after-child",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: `Use parent source E2 and adopted child finding ${childEvidenceId}.`,
            changes: [{
              title: "Update the reviewed owner",
              operation: "modify",
              targets: ["src/main.js"],
              basis: ["E2", childEvidenceId],
              change: "Update the reviewed owner while preserving its public boundary.",
              expectedOutcome: "The owner remains coherent.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        return args.__raw
          ? "export const owner = 'reviewed';"
          : "export const owner = 'reviewed';";
      }
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: { subagentPreference: "preferred" },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        diagnosticAbort = setTimeout(
          () => controller.abort("plan-collaboration-test-timeout"),
          2_000,
        );
      },
    },
  );

  if (diagnosticAbort) clearTimeout(diagnosticAbort);
  assert.equal(
    result.settlement.outcome.status,
    "paused",
    JSON.stringify({
      parentRound,
      childRound,
      events: result.checkpoint.aggregate.events.map((entry) =>
        entry.type === "command.scheduled"
          ? `${entry.type}:${entry.command.kind}`
          : entry.type
      ),
      logs: result.logs.slice(-8),
      collaborationFailures: result.logs.filter((entry) =>
        /collaboration/.test(entry.eventName)
      ),
      subagentLogs: result.logs.filter((entry) =>
        /subagent/.test(entry.eventName)
      ),
    }),
  );
  assert.equal(parentReadWhileChildActive, true);
  assert.equal(parentRound, 6);
  assert.equal(childRound, 3);
  const aggregate = result.checkpoint.aggregate;
  const events = aggregate.events;
  const sequenceOf = (type) => events.find((entry) => entry.type === type)?.sequence;
  assert.ok(events.some((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "schedule_subagents"
  ));
  assert.ok(events.some((entry) => entry.type === "subagents.scheduled"));
  assert.ok(events.some((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "join_subagents"
  ));
  const childCompletion = events.find((entry) =>
    entry.type === "subagent.completed"
  );
  assert.equal(childCompletion?.status, "completed");
  assert.ok(childCompletion?.report);
  assert.ok(events.some((entry) => entry.type === "subagent.handoff_delivered"));
  assert.ok(events.some((entry) => entry.type === "subagent.handoff_applied"));
  assert.ok(sequenceOf("subagent.completed") < sequenceOf("work_plan.sealed"));
  assert.ok(sequenceOf("work_plan.sealed") < sequenceOf("subagent.handoff_applied"));
  assert.equal(
    aggregate.subagents.some((job) =>
      job.status === "queued" || job.status === "running"
    ),
    false,
  );
  assert.equal(aggregate.subagents[0]?.status, "completed");
  assert.ok(aggregate.subagents[0]?.report);
  const childEvidence = aggregate.sealedWorkPlan.evidence.find((entry) =>
    entry.id.startsWith("child:")
  );
  assert.ok(childEvidence, JSON.stringify({
    sealedEvidence: aggregate.sealedWorkPlan.evidence,
    stepBasis: aggregate.sealedWorkPlan.draft.steps[0].basis,
    completed: events.filter((entry) =>
      entry.type === "subagent.completed"
    ),
  }));
  assert.equal(childEvidence.version, null);
  assert.ok(
    aggregate.sealedWorkPlan.draft.steps[0].basis.includes(childEvidence.id),
  );
  assert.ok(requestTools[1].includes("wait_subagents"));
  assert.deepEqual(requestTools[4], ["submit_runtime_v2_work_plan"]);
  assert.deepEqual(requestTools[5], ["submit_runtime_v2_work_plan"]);
  const rejectionLogIndex = result.logs.findIndex((entry) =>
    entry.eventName === "runtime_v2_plan_submission_rejected"
  );
  assert.ok(rejectionLogIndex >= 0);
  const repairRequest = result.logs.slice(rejectionLogIndex + 1).find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.equal(repairRequest?.data?.stage, "synthesis");
  assert.equal(repairRequest?.data?.compactRecovery, false);
  assert.deepEqual(repairRequest?.data?.offeredToolNames, [
    "submit_runtime_v2_work_plan",
  ]);
});

test("production Plan quarantines implement/write spawn arguments outside the advertised discovery schema", async () => {
  const parentRequests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools) => {
      parentRequests.push({
        messages,
        toolNames: tools.map((tool) => tool.function.name),
      });
      if (parentRequests.length === 1) {
        assert.ok(tools.some((tool) =>
          tool.function.name === "spawn_subagent"
        ));
        return {
          content: "",
          toolCalls: [{
            id: "malformed-plan-writer",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "plan-writer",
              task_kind: "implement",
              access_mode: "write",
              objective: "Write before approval.",
              success_criteria: "Create src/new.js.",
              required_paths: "src/new.js",
              allowed_paths: "src/new.js",
              implementation_operation: "create",
              implementation_plan: "Create the file immediately.",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("plan-argument-rejection-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: { subagentPreference: "preferred" },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("plan-argument-rejection-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  assert.deepEqual(
    parentRequests[1].toolNames,
    parentRequests[0].toolNames,
    "an argument rejection must preserve the ordinary discovery surface",
  );
  assert.ok(parentRequests[1].toolNames.includes(
    "submit_runtime_v2_work_plan",
  ));
  assert.equal(result.checkpoint.aggregate.subagents.length, 0);
  const events = result.checkpoint.aggregate.events;
  assert.equal(
    events.some((entry) =>
      entry.type === "subagents.scheduled"
    ),
    false,
  );
  assert.equal(
    events.some((entry) =>
      entry.type === "command.scheduled" &&
      (entry.command.kind === "schedule_subagents" ||
        entry.command.kind === "execute_tool")
    ),
    false,
  );
  const quarantined = events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_arguments_rejected"
    )
  );
  assert.ok(quarantined);
  assert.deepEqual(quarantined.result.toolCalls, []);
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_collaboration_failed"
    ),
    false,
  );
});

test("production Plan quarantines an advertised read_file call missing its required path", async () => {
  const invalidCallId = "plan-read-without-required-path";
  const parentRequests = [];
  const readExecutions = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools) => {
      parentRequests.push({
        messages,
        toolNames: tools.map((tool) => tool.function.name),
      });
      if (parentRequests.length === 1) {
        assert.ok(tools.some((tool) =>
          tool.function.name === "read_file"
        ));
        return {
          content: "",
          toolCalls: [{
            id: invalidCallId,
            name: "read_file",
            arguments: JSON.stringify({}),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("plan-read-argument-rejection-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        readExecutions.push({ ...args });
        return "export const shouldNeverBeObserved = true;";
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("plan-read-argument-rejection-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  assert.deepEqual(
    parentRequests[1].toolNames,
    parentRequests[0].toolNames,
    "a malformed advertised read must not advance discovery to synthesis",
  );
  assert.deepEqual(readExecutions, []);
  const events = result.checkpoint.aggregate.events;
  const quarantined = events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_arguments_rejected"
    )
  );
  assert.ok(quarantined);
  assert.deepEqual(quarantined.result.toolCalls, []);
  assert.equal(
    events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "execute_tool" &&
      entry.command.payload.toolCallId === invalidCallId
    ),
    false,
  );
  assert.equal(
    events.some((entry) =>
      entry.type === "tool.completed"
    ),
    false,
  );
});

test("production Plan runner seals the first valid evidence-grounded plan and pauses for review", async () => {
  const draft = plan().draft;
  const reviewedDraft = {
    ...draft,
    findings: draft.findings.map((finding) => ({
      ...finding,
      basis: ["E2"],
    })),
    steps: draft.steps.map((step) => ({
      ...step,
      basis: ["E2"],
    })),
  };
  let writtenPlan = null;
  let providerRound = 0;
  let acceptedSubmissionRequest = null;
  const observedReadArgs = [];
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools) => {
      providerRound += 1;
      const offeredNames = tools.map((definition) => definition.function.name);
      if (
        providerRound === 1 ||
        (offeredNames.length === 1 && offeredNames[0] === "read_file")
      ) {
        return {
          content: "",
          toolCalls: [{
            id: `read-source-${providerRound}`,
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (providerRound === 2) {
        return {
          content: "",
          toolCalls: [{
            id: "reject-protocol-markup",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown:
                "让我用 <function=read_file> 后再计划。",
              changes: reviewedDraft.steps,
              validations: reviewedDraft.validations,
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      acceptedSubmissionRequest = messages;
      return {
        content: "",
        toolCalls: [{
          id: "submit-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: reviewedDraft.summary,
            changes: reviewedDraft.steps,
            validations: reviewedDraft.validations,
            questions: reviewedDraft.blockingQuestions,
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        observedReadArgs.push({ ...args });
        return "const openFile = true;";
      }
      if (name === "write_file") {
        writtenPlan = String(args.content || "");
        return "written";
      }
      throw new Error(`unexpected tool ${name}`);
    },
  );
  assert.equal(providerRound, 3);
  assert.ok(observedReadArgs.some((args) =>
    args.__raw !== true &&
    args.max_chars === 18_000
  ));
  assert.ok(observedReadArgs.some((args) =>
    args.__raw === true &&
    args.max_chars === undefined
  ));
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "work_plan.sealed"
    ).length,
    1,
  );
  const resolved = adapter.resolveRuntimeV2PlanReviewFromAggregate(
    result.checkpoint.aggregate,
  );
  assert.ok(resolved?.pending);
  assert.equal(writtenPlan, resolved.plan.markdown);
  assert.equal(resolved.commit.artifact.content, writtenPlan);
  assert.ok(result.checkpoint.aggregate.events.some((event) =>
    event.type === "projection.published" &&
    event.audience === "capsule_live"
  ));
  const acceptedSubmissionText = acceptedSubmissionRequest
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.match(acceptedSubmissionText, /WORK_PLAN_REJECTED/);
  assert.doesNotMatch(acceptedSubmissionText, /mandatory evidence audit/);
});

test("Plan discovery keeps read and submit tools available until the model submits", async () => {
  const reviewedDraft = {
    ...plan().draft,
    findings: plan().draft.findings.map((finding) => ({
      ...finding,
      basis: ["unknown-model-evidence"],
    })),
    steps: plan().draft.steps.map((step) => ({
      ...step,
      basis: [],
    })),
    validations: plan().draft.validations.map((validation) => ({
      ...validation,
      stepIndexes: [0],
    })),
  };
  let providerRound = 0;
  let synthesisRequest = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools, _metadata, options) => {
      providerRound += 1;
      if (providerRound <= 8) {
        const sourcePath = [
          "src/main.js",
          "./src/main.js",
          "/fixture/src/main.js",
        ][providerRound % 3];
        return {
          content: "",
          toolCalls: [{
            id: `repeat-read-${providerRound}`,
            name: "read_file",
            arguments: JSON.stringify({
              path: sourcePath,
              start_line: providerRound,
              max_lines: 1,
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      synthesisRequest ||= { messages, tools, options };
      return {
        content: "",
        toolCalls: [{
          id: "submit-after-discovery-boundary",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: [
              "根因位于文件打开状态的所有权。",
              "",
              "保持现有 UI 边界，只修复状态切换。",
            ].join("\n"),
            changes: JSON.stringify(reviewedDraft.steps.map((step) => ({
              title: step.title,
              operation: step.operation,
              targets: step.targets,
              change: step.change,
              expectedOutcome: step.expectedOutcome,
              dependsOn: step.dependsOn,
              criterionIds: step.criterionIds,
            }))),
            validations: JSON.stringify(reviewedDraft.validations.map((validation) => ({
              kind: validation.kind,
              command: validation.command,
              cwd: validation.cwd,
              expectedOutcome: validation.expectedOutcome,
              required: validation.required,
              stepIndexes: validation.stepIndexes,
              criterionIds: validation.criterionIds,
            }))),
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        return args.__raw
          ? "const openFile = true;\nconst saveFile = true;"
          : `window-${args.start_line}`;
      }
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 9);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(
    synthesisRequest.tools.map((definition) => definition.function.name),
    ["read_file", "submit_runtime_v2_work_plan"],
  );
  const submitTool = synthesisRequest.tools.find((definition) =>
    definition.function.name === "submit_runtime_v2_work_plan"
  );
  assert.ok(submitTool);
  assert.deepEqual(
    submitTool.function.parameters.required,
    ["planMarkdown", "changes", "validations"],
  );
  assert.equal(
    submitTool.function.parameters.properties.findingsJson,
    undefined,
  );
  assert.equal(synthesisRequest.options.toolChoice, "required");
  assert.doesNotMatch(
    synthesisRequest.messages.map((message) => String(message.content || "")).join("\n"),
    /read-only discovery window is closed/,
  );
  assert.match(String(synthesisRequest.messages[0]?.content || ""), /MAIN RUNTIME V2 PLAN/);
  assert.equal(
    result.checkpoint.aggregate.evidence.filter((entry) =>
      entry.kind === "source" && entry.target === "src/main.js"
    ).length,
    1,
  );
  const synthesisText = synthesisRequest.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(
    synthesisText,
    /E2 · (?:\.\/|\/fixture\/)?src\/main\.js · sha256-/,
    "continued discovery must keep the canonical tool transcript instead of adding a synthesis evidence copy",
  );
  assert.match(
    synthesisText,
    /window-8/,
    "later windows of the same source version must remain available to synthesis",
  );
});

test("Plan synthesis falls back once from ignored native tools to a schema-bound response", async () => {
  let providerRound = 0;
  const synthesisRequests = [];
  const submission = {
    planMarkdown: "根因位于文件打开状态的所有权；修改保持现有工具边界。",
    changes: [{
      title: "统一标签生命周期",
      operation: "modify",
      targets: ["src/main.js"],
      change: "打开文件时替换仍为空白且未修改的初始标签。",
      expectedOutcome: "只显示当前文件标签。",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
        expectedOutcome: "构建通过。",
        required: true,
        stepIndexes: [0],
        criterionIds: ["criterion-user-objective"],
      }],
  };
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools, maxTokens, options) => {
      providerRound += 1;
      if (providerRound <= 8) {
        return {
          content: "",
          toolCalls: [{
            id: `read-before-fallback-${providerRound}`,
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      synthesisRequests.push({ messages, tools, maxTokens, options });
      if (providerRound === 9) {
        return {
          content: "I need to call submit_runtime_v2_work_plan, but I am still describing its parameters.",
          toolCalls: [],
          finishReason: "length",
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: JSON.stringify(submission),
        toolCalls: [],
        finishReason: "stop",
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 11);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(
    synthesisRequests[0].tools.map((tool) => tool.function.name),
    ["read_file", "submit_runtime_v2_work_plan"],
  );
  assert.equal(synthesisRequests[0].options.toolChoice, "required");
  assert.equal(synthesisRequests[1].maxTokens, 4_096);
  assert.deepEqual(
    synthesisRequests[1].tools.map((tool) => tool.function.name),
    ["submit_runtime_v2_work_plan"],
  );
  assert.deepEqual(synthesisRequests[1].options.toolChoice, {
    type: "function",
    function: { name: "submit_runtime_v2_work_plan" },
  });
  assert.equal(synthesisRequests[2].maxTokens, 4_096);
  assert.deepEqual(synthesisRequests[2].tools, []);
  assert.equal(synthesisRequests[2].options.toolChoice, undefined);
  assert.equal(synthesisRequests[2].options.responseFormat.type, "json_schema");
  assert.match(
    synthesisRequests[2].messages
      .map((message) => String(message.content || ""))
      .join("\n"),
    /Return exactly one JSON object/,
  );
  assert.equal(result.checkpoint.aggregate.recovery.transportAttempts, 0);
  assert.ok(result.checkpoint.aggregate.events.some((event) =>
    event.type === "soft_signal.observed" &&
    event.signal === "protocol_drift"
  ));
  assert.ok(result.checkpoint.aggregate.events.some((event) =>
    event.type === "provider.responded" &&
    event.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "structured_response_adapted"
    )
  ));
});

test("Plan synthesis preserves an admitted output budget above 4096 tokens", async () => {
  const requests = [];
  const admittedOutputBudget = 8_192;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({
        messages,
        toolNames: tools.map((tool) => tool.function.name),
        maxOutputTokens,
        requestOptions,
      });
      if (requests.length === 1) {
        return {
          content: "I have enough context and will now submit the structured WorkPlan.",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: "",
        toolCalls: [{
          id: "submit-with-admitted-output-budget",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: "Create the bounded owner and validate the repository build.",
            changes: [{
              title: "Create the bounded owner",
              operation: "create",
              targets: ["src/output-budget-owner.js"],
              change: "Create the bounded owner behind the existing module boundary.",
              expectedOutcome: "The bounded owner exists.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      runtimeContextBudget: {
        contextLimit: 65_536,
        outputBudget: admittedOutputBudget,
        inputBudget: 57_344,
        readWindowChars: 32_000,
        source: "configured",
        providerContextLimit: 65_536,
        availableMemoryBytes: null,
      },
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.deepEqual(requests[1].toolNames, ["submit_runtime_v2_work_plan"]);
  assert.deepEqual(requests[1].requestOptions.toolChoice, {
    type: "function",
    function: { name: "submit_runtime_v2_work_plan" },
  });
  assert.equal(
    requests[1].maxOutputTokens,
    admittedOutputBudget,
    "synthesis must not replace the shared Run output budget with a fixed 4096-token cap",
  );
  const synthesisOpened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened" &&
    entry.data?.stage === "synthesis"
  );
  assert.equal(synthesisOpened?.data?.maxOutputTokens, admittedOutputBudget);
});

test("Plan uses the text envelope first when the adapter lacks native tool round-trip", async () => {
  const requests = [];
  const readArguments = [];
  const submission = {
    planMarkdown: "Use the evidence-backed owner and preserve the existing boundary.",
    changes: [{
      title: "Repair the owner",
      operation: "modify",
      targets: ["src/main.js"],
      change: "Update the reviewed lifecycle owner.",
      expectedOutcome: "The visible lifecycle remains coherent.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const envelope = (toolCalls) =>
    `<runtime-v2-tools>${JSON.stringify({ toolCalls })}</runtime-v2-tools>`;
  let round = 0;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools, _maxTokens, requestOptions) => {
      round += 1;
      requests.push({ messages, tools, requestOptions });
      return round === 1
        ? {
            content: envelope([{
              id: "read-main",
              name: "read_file",
              arguments: { path: "src/main.js" },
            }, {
              id: "read-editor",
              name: "read_file",
              arguments: { path: "src/editor.js" },
            }, {
              id: "read-toolbar",
              name: "read_file",
              arguments: { path: "src/toolbar.js" },
            }]),
            toolCalls: [],
            finishReason: "stop",
            usage: {},
            protocolViolation: null,
          }
        : {
            content: envelope([{
              id: "submit-plan",
              name: "submit_runtime_v2_work_plan",
              arguments: submission,
            }]),
            toolCalls: [],
            finishReason: "stop",
            usage: {},
            protocolViolation: null,
          };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        if (args.__raw !== true) readArguments.push(args);
        return "const owner = true;";
      }
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    { nativeToolRoundTrip: false },
  );

  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.tools, []);
    assert.equal(request.requestOptions.toolChoice, undefined);
    const prompt = request.messages
      .map((message) => String(message.content || ""))
      .join("\n");
    assert.match(prompt, /<runtime-v2-tools>/);
  }
  assert.match(
    requests[0].messages
      .map((message) => String(message.content || ""))
      .join("\n"),
    /read_file/,
  );
  assert.deepEqual(
    readArguments.map((args) => args.max_chars),
    [6_000, 6_000, 6_000],
    "one provider-selected read batch shares the Run window instead of multiplying it",
  );
});

test("schema-bound Plan response ingress never searches surrounding prose for JSON", () => {
  const submission = {
    planMarkdown: "Plan",
    changes: [{
      targets: ["src/main.js"],
      change: "Change it.",
      dependsOn: [],
    }],
    validations: [{
      kind: "assertion",
      expectedOutcome: "Works.",
      stepIndexes: [0],
    }],
  };
  assert.deepEqual(
    planProtocol.decodeExactStructuredPlanResponse(JSON.stringify(submission)),
    submission,
  );
  assert.deepEqual(
    planProtocol.decodeExactStructuredPlanResponse(
      `\`\`\`json\n${JSON.stringify(submission)}\n\`\`\``,
    ),
    submission,
  );
  assert.equal(
    planProtocol.decodeExactStructuredPlanResponse(
      `Here is the plan:\n${JSON.stringify(submission)}`,
    ),
    null,
  );
});

test("WorkPlan compilation removes unsafe finite commands only when another executable validation remains", () => {
  const evidence = [{
    id: "E1",
    target: "src/main.js",
    version: "sha256-reviewed",
    statement: "Reviewed source.",
  }];
  const candidate = {
    planMarkdown: "Make the reviewed change and verify the observable behavior.",
    changes: [{
      operation: "modify",
      targets: ["src/main.js"],
      change: "Update the reviewed behavior.",
      expectedOutcome: "The behavior is corrected.",
      dependsOn: [],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run dev",
      expectedOutcome: "The development server starts.",
      required: true,
      stepIndexes: [0],
    }, {
      kind: "browser",
      expectedOutcome: "The corrected behavior is visible in the application.",
      required: true,
      stepIndexes: [0],
    }],
  };
  const compiled = planProtocol.workPlanDraftFromSubmission(
    candidate,
    evidence,
    "Repair the reviewed behavior.",
  );
  assert.deepEqual(
    compiled.draft.validations.map((validation) => validation.kind),
    ["browser"],
  );
  assert.ok(compiled.normalizationReasons.includes(
    "validations[0]:unsafe_finite_command_removed",
  ));
  assert.doesNotThrow(() => runtime.sealWorkPlanV1({
    draft: compiled.draft,
    evidence,
    createdAt: 1,
  }));

  const withoutFallback = planProtocol.workPlanDraftFromSubmission(
    { ...candidate, validations: candidate.validations.slice(0, 1) },
    evidence,
    "Repair the reviewed behavior.",
  );
  assert.throws(
    () => runtime.sealWorkPlanV1({
      draft: withoutFallback.draft,
      evidence,
      createdAt: 1,
    }),
    /needs at least one required validation/,
  );
});

test("cold-restored typed WorkPlan rejection resumes one submit-only repair within its durable grace", async () => {
  const restored = planningCheckpointWithTypedSubmissionRejection();
  const corrected = structuredClone(restored.candidate);
  corrected.validations[0].stepIndexes = [0];
  const originalNow = Date.now;
  const requests = [];
  let repaired;
  let expired;
  let expiredProviderCalls = 0;

  try {
    Date.now = () => restored.rejectionAt + 1_000;
    repaired = await runProductionPlanScenario(
      async (
        messages,
        _settings,
        _callbacks,
        _signal,
        tools,
        _maxOutputTokens,
        requestOptions,
      ) => {
        requests.push({
          transcript: messages
            .map((message) => String(message.content || ""))
            .join("\n"),
          toolNames: tools.map((tool) => tool.function.name),
          requestOptions,
        });
        return {
          content: "",
          toolCalls: [{
            id: "cold-corrected-work-plan",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(corrected),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      { initialCheckpoint: restored.checkpoint },
    );

    Date.now = () =>
      restored.rejectionAt +
      planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS +
      1;
    expired = await runProductionPlanScenario(
      async () => {
        expiredProviderCalls += 1;
        throw new Error("an expired cold repair must not call the provider");
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      { initialCheckpoint: restored.checkpoint },
    );
  } finally {
    Date.now = originalNow;
  }

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].toolNames, ["submit_runtime_v2_work_plan"]);
  assert.deepEqual(requests[0].requestOptions.toolChoice, {
    type: "function",
    function: { name: "submit_runtime_v2_work_plan" },
  });
  assert.equal(
    requests[0].requestOptions.timeoutMs,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS - 1_000,
  );
  assert.match(requests[0].transcript, /WORK_PLAN_REJECTED:/);
  assert.match(requests[0].transcript, /validations\[0\]\.stepIndexes references an unknown step/);
  assert.match(requests[0].transcript, /Rejected submission to correct/);
  assert.match(requests[0].transcript, /src\/cold-repair-owner\.js/);
  assert.match(requests[0].transcript, /"stepIndexes":\[1\]/);
  const repairOpened = repaired.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.equal(repairOpened?.data?.stage, "synthesis");
  assert.equal(repairOpened?.data?.submissionRepairPending, true);
  assert.equal(repaired.settlement.outcome.status, "paused");
  assert.equal(repaired.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(
    repaired.checkpoint.aggregate.sealedWorkPlan.draft.validations[0].stepIndexes,
    [0],
  );
  assert.equal(
    restored.checkpoint.aggregate.events.some((entry) =>
      entry.type === "work_plan.sealed"
    ),
    false,
  );

  assert.equal(expiredProviderCalls, 0);
  assert.equal(expired.settlement.outcome.status, "completed");
  assert.equal(expired.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    expired.checkpoint.aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ),
    false,
  );
  const terminal = expired.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(terminal?.data?.detailCode, "runtime_v2_plan_deadline_reached");
});

test("typed WorkPlan rejection receives one bounded submit-only grace past the lifecycle deadline", async () => {
  const originalNow = Date.now;
  const startedAt = 1_000_000;
  let now = startedAt;
  const requests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const rejectedSubmission = {
    planMarkdown: "Create the bounded owner and verify it with the repository build.",
    changes: [{
      title: "Create the bounded owner",
      operation: "create",
      targets: ["src/bounded-owner.js"],
      change: "Create the requested owner behind the existing module boundary.",
      expectedOutcome: "The bounded owner exists without changing unrelated files.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "The repository build succeeds.",
      required: true,
      stepIndexes: [1],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  let result;

  Date.now = () => now;
  try {
    result = await runProductionPlanScenario(
      async (
        messages,
        settings,
        _callbacks,
        _signal,
        tools,
        _maxOutputTokens,
        requestOptions,
      ) => {
        requests.push({
          transcript: messages
            .map((message) => String(message.content || ""))
            .join("\n"),
          toolNames: tools.map((tool) => tool.function.name),
          requestOptions,
          settings,
        });
        if (requests.length === 1) {
          now = startedAt + planProtocol.PLAN_MODEL_DEADLINE_MS - 10;
        } else if (requests.length === 2) {
          now = startedAt +
            planProtocol.PLAN_MODEL_DEADLINE_MS +
            planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS +
            1;
        } else {
          abortCtrl.abort("unexpected repeated WorkPlan repair grace");
        }
        return {
          content: "",
          toolCalls: [{
            id: `reject-work-plan-${requests.length}`,
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(rejectedSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        reasoningToggle: true,
        onAbortCtrl: (controller) => {
          abortCtrl = controller;
          diagnosticAbort = setTimeout(
            () => controller.abort("WorkPlan grace test timeout"),
            2_000,
          );
        },
      },
    );
  } finally {
    Date.now = originalNow;
    if (diagnosticAbort) clearTimeout(diagnosticAbort);
  }

  assert.equal(requests.length, 2, "a second rejection must not renew the grace");
  assert.deepEqual(requests[1].toolNames, ["submit_runtime_v2_work_plan"]);
  assert.deepEqual(requests[1].requestOptions.toolChoice, {
    type: "function",
    function: { name: "submit_runtime_v2_work_plan" },
  });
  assert.equal(
    requests[1].requestOptions.timeoutMs,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
    "typed rejection repair needs one full but bounded provider request",
  );
  assert.match(requests[1].transcript, /WORK_PLAN_REJECTED/);
  assert.equal(requests[1].settings.reasoningRequest, "off");
  assert.equal(requests[1].settings.preserveAssistantReasoning, false);

  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "work_plan.sealed"
    ),
    false,
  );
  const firstRejection = result.logs.findIndex((entry) =>
    entry.eventName === "runtime_v2_plan_submission_rejected"
  );
  const repairOpened = result.logs.findIndex((entry, index) =>
    index > firstRejection &&
    entry.eventName === "runtime_v2_plan_provider_request_opened" &&
    entry.data?.submissionRepairPending === true
  );
  const secondRejection = result.logs.findIndex((entry, index) =>
    index > repairOpened &&
    entry.eventName === "runtime_v2_plan_submission_rejected"
  );
  const terminal = result.logs.findIndex((entry, index) =>
    index > secondRejection &&
    entry.eventName === "runtime_v2_plan_terminal" &&
    entry.data?.detailCode === "runtime_v2_plan_deadline_reached"
  );
  assert.ok(firstRejection >= 0);
  assert.ok(repairOpened > firstRejection);
  assert.ok(secondRejection > repairOpened);
  assert.ok(terminal > secondRejection);
  assert.equal(result.logs[repairOpened].data.timeoutMs,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS);
});

test("a repeated submit-only Plan argument violation pivots to one compact structured recovery", async () => {
  const requests = [];
  const validSubmission = {
    planMarkdown: "Create the bounded repair owner and verify the repository build.",
    changes: [{
      title: "Create the bounded repair owner",
      operation: "create",
      targets: ["src/repeated-repair-owner.js"],
      change: "Create the bounded owner behind the existing module boundary.",
      expectedOutcome: "The bounded repair owner exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "The repository build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const typedRejectedSubmission = structuredClone(validSubmission);
  typedRejectedSubmission.validations[0].stepIndexes = [1];
  const argumentRejectedSubmission = structuredClone(validSubmission);
  delete argumentRejectedSubmission.changes[0].dependsOn;

  const result = await runProductionPlanScenario(
    async (
      messages,
      settings,
      _callbacks,
      _signal,
      tools,
      maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({
        transcript: messages
          .map((message) => String(message.content || ""))
          .join("\n"),
        settings,
        toolNames: tools.map((tool) => tool.function.name),
        maxOutputTokens,
        requestOptions,
      });
      if (requests.length === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "typed-rejected-before-repeated-arguments",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(typedRejectedSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (requests.length === 2 || requests.length === 3) {
        return {
          content: "",
          toolCalls: [{
            id: `repeat-invalid-submit-arguments-${requests.length - 1}`,
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(argumentRejectedSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: JSON.stringify(validSubmission),
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    { reasoningToggle: true },
  );

  assert.deepEqual(requests[1].toolNames, [
    "submit_runtime_v2_work_plan",
  ]);
  assert.deepEqual(requests[2].toolNames, [
    "submit_runtime_v2_work_plan",
  ]);
  assert.deepEqual(requests[1].requestOptions.toolChoice, {
    type: "function",
    function: { name: "submit_runtime_v2_work_plan" },
  });
  assert.match(requests[2].transcript, /PLAN_TOOL_ARGUMENTS_REJECTED/);

  const compactRecovery = requests[3];
  assert.ok(compactRecovery, "the repeated violation must open one recovery request");
  assert.deepEqual(
    compactRecovery.toolNames,
    [],
    "a third request must not repeat the same native submit-only surface",
  );
  assert.equal(compactRecovery.requestOptions.toolChoice, undefined);
  assert.equal(
    compactRecovery.requestOptions.responseFormat?.type,
    "json_schema",
  );
  assert.equal(
    compactRecovery.maxOutputTokens,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
  );
  assert.equal(compactRecovery.settings.reasoningRequest, "off");
  assert.equal(compactRecovery.settings.preserveAssistantReasoning, false);
  assert.match(compactRecovery.transcript, /Rejected submission to correct/);
  assert.match(compactRecovery.transcript, /PLAN_TOOL_ARGUMENTS_REJECTED/);
  assert.equal(
    requests.length,
    4,
    "one compact structured recovery must seal without another native retry",
  );
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");

  const argumentRejections = result.checkpoint.aggregate.events.filter(
    (event) =>
      event.type === "provider.responded" &&
      event.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "tool_arguments_rejected"
      ),
  );
  assert.equal(argumentRejections.length, 2);
  const compactOpened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened" &&
    entry.data?.compactRecovery === true
  );
  assert.ok(compactOpened);
  assert.equal(compactOpened.data?.submissionRepairPending, true);
  assert.equal(compactOpened.data?.transport, "structured_response");
  assert.equal(compactOpened.data?.repairReasoningDisabled, true);
});

test("cold Plan restore preserves repeated submit-only violations and starts at compact structured recovery", async () => {
  const restored = planningCheckpointWithRepeatedSubmitOnlyArgumentViolations();
  const correctedSubmission = structuredClone(restored.candidate);
  correctedSubmission.validations[0].stepIndexes = [0];
  const originalNow = Date.now;
  const requests = [];
  let result;

  Date.now = () => restored.restoredAt;
  try {
    result = await runProductionPlanScenario(
      async (
        messages,
        settings,
        _callbacks,
        _signal,
        tools,
        maxOutputTokens,
        requestOptions,
      ) => {
        requests.push({
          transcript: messages
            .map((message) => String(message.content || ""))
            .join("\n"),
          settings,
          toolNames: tools.map((tool) => tool.function.name),
          maxOutputTokens,
          requestOptions,
        });
        if (requestOptions.responseFormat?.type === "json_schema") {
          return {
            content: JSON.stringify(correctedSubmission),
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        }
        return {
          content: "",
          toolCalls: [{
            id: "cold-native-retry-must-not-be-granted",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(correctedSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        initialCheckpoint: restored.checkpoint,
        reasoningToggle: true,
      },
    );
  } finally {
    Date.now = originalNow;
  }

  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0].toolNames,
    [],
    "restore must not re-grant the already exhausted native submit surface",
  );
  assert.equal(requests[0].requestOptions.toolChoice, undefined);
  assert.equal(requests[0].requestOptions.responseFormat?.type, "json_schema");
  assert.equal(
    requests[0].maxOutputTokens,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
  );
  assert.equal(requests[0].settings.reasoningRequest, "off");
  assert.equal(requests[0].settings.preserveAssistantReasoning, false);
  assert.match(requests[0].transcript, /WORK_PLAN_REJECTED/);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  const opened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.equal(opened?.data?.stage, "synthesis");
  assert.equal(opened?.data?.submissionRepairPending, true);
  assert.equal(opened?.data?.compactRecovery, true);
  assert.equal(opened?.data?.transport, "structured_response");
});

test("an invalid sole structured Plan submission recovery terminates without transport rebound", async () => {
  const restored = planningCheckpointWithRepeatedSubmitOnlyArgumentViolations();
  const originalNow = Date.now;
  let now = restored.restoredAt;
  const requests = [];
  let result;

  Date.now = () => now;
  try {
    result = await runProductionPlanScenario(
      async (
        messages,
        settings,
        _callbacks,
        _signal,
        tools,
        maxOutputTokens,
        requestOptions,
      ) => {
        requests.push({
          transcript: messages
            .map((message) => String(message.content || ""))
            .join("\n"),
          settings,
          toolNames: tools.map((tool) => tool.function.name),
          maxOutputTokens,
          requestOptions,
        });
        if (requests.length > 1) {
          now = restored.effectiveDeadlineAt + 1;
        }
        return {
          content: "{}",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        initialCheckpoint: restored.checkpoint,
        reasoningToggle: true,
      },
    );
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(
    requests[0]?.toolNames,
    [],
    "the sole post-violation recovery must use structured response",
  );
  assert.equal(requests[0]?.requestOptions.responseFormat?.type, "json_schema");
  assert.equal(requests[0]?.settings.reasoningRequest, "off");
  assert.equal(
    requests.length,
    1,
    "an invalid structured recovery must not rebound to native or another request",
  );
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "error");
  assert.equal(result.checkpoint.aggregate.terminalOutcome?.resultKind, "error");
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(result.checkpoint.aggregate.scheduledCommands, []);
  assert.equal(
    result.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ).length,
    3,
    "the durable two native attempts may be followed by only one structured attempt",
  );
  const terminal = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(
    terminal?.data?.detailCode,
    "runtime_v2_plan_submission_transport_recovery_exhausted",
  );
});

test("active Plan stream progress outlives the 90s request watchdog but not the durable lifecycle", async () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 2_000_000;
  let nextTimerId = 0;
  const timers = new Map();
  const scheduledTimeouts = [];
  const runDueTimers = () => {
    for (let pass = 0; pass < 10; pass += 1) {
      const due = [...timers.entries()].filter(([, timer]) =>
        timer.dueAt <= now
      );
      if (due.length === 0) return;
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.callback(...timer.args);
      }
    }
    throw new Error("fake Plan timers did not converge");
  };
  let abortCtrl = null;
  const diagnosticAborts = [];
  let providerCalls = 0;
  let signalAbortedAfterActiveDeadline = null;
  let requestWallClockMs = 0;
  let activeResult;
  let durableResult;
  let durableProviderCalls = 0;
  let durableSignalAborted = null;

  Date.now = () => now;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const handle = { fakePlanTimerId: ++nextTimerId };
    scheduledTimeouts.push(Number(delay));
    timers.set(handle, {
      callback,
      args,
      dueAt: now + Math.max(0, Number(delay) || 0),
    });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };
  try {
    activeResult = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        callbacks,
        signal,
        _tools,
        _maxOutputTokens,
        _requestOptions,
      ) => {
        providerCalls += 1;
        if (providerCalls > 1) {
          abortCtrl.abort("active Plan stream was killed by the fixed request watchdog");
          return {
            content: "",
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        }
        const requestStartedAt = now;
        for (const [elapsedMs, phase, token] of [
          [30_000, "first_chunk", "bounded semantic progress 1"],
          [100_000, "chunk_progress", " bounded semantic progress 2"],
          [170_000, "chunk_progress", " bounded semantic progress 3"],
          [240_000, "chunk_progress", " bounded semantic progress 4"],
        ]) {
          now = requestStartedAt + elapsedMs;
          runDueTimers();
          callbacks.onLifecycle?.({ phase });
          callbacks.onToken?.(token);
        }
        now = requestStartedAt + 3 * planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS + 1;
        runDueTimers();
        await Promise.resolve();
        requestWallClockMs = now - requestStartedAt;
        signalAbortedAfterActiveDeadline = signal.aborted;
        return {
          content: "",
          toolCalls: [{
            id: "submit-after-active-stream-progress",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "Create the active-stream fixture and verify the build.",
              changes: [{
                title: "Create the active-stream fixture",
                operation: "create",
                targets: ["src/active-stream-fixture.js"],
                change: "Create the bounded fixture behind the existing module boundary.",
                expectedOutcome: "The active-stream fixture exists.",
                dependsOn: [],
                criterionIds: ["criterion-user-objective"],
              }],
              validations: [{
                kind: "finite_command",
                command: "npm run build",
                cwd: "/fixture",
                expectedOutcome: "Build succeeds.",
                required: true,
                stepIndexes: [0],
                criterionIds: ["criterion-user-objective"],
              }],
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        onAbortCtrl: (controller) => {
          abortCtrl = controller;
          diagnosticAborts.push(originalSetTimeout(
            () => controller.abort("active Plan stream test timeout"),
            2_000,
          ));
        },
      },
    );

    durableResult = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        callbacks,
        signal,
      ) => {
        durableProviderCalls += 1;
        const requestStartedAt = now;
        for (let elapsedMs = 60_000; elapsedMs < planProtocol.PLAN_MODEL_DEADLINE_MS;
          elapsedMs += 60_000) {
          now = requestStartedAt + elapsedMs;
          runDueTimers();
          callbacks.onLifecycle?.({
            phase: elapsedMs === 60_000 ? "first_chunk" : "chunk_progress",
          });
          callbacks.onToken?.("still producing a bounded Plan response");
        }
        now = requestStartedAt + planProtocol.PLAN_MODEL_DEADLINE_MS + 1;
        runDueTimers();
        await Promise.resolve();
        durableSignalAborted = signal.aborted;
        return {
          content: "",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        onAbortCtrl: (controller) => {
          diagnosticAborts.push(originalSetTimeout(
            () => controller.abort("durable Plan deadline test timeout"),
            2_000,
          ));
        },
      },
    );
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const handle of diagnosticAborts) originalClearTimeout(handle);
  }

  assert.ok(requestWallClockMs > 3 * planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS);
  assert.ok(scheduledTimeouts.includes(planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS));
  assert.deepEqual(
    {
      providerCalls,
      signalAbortedAfterActiveDeadline,
      outcomeStatus: activeResult.settlement.outcome.status,
      phase: activeResult.checkpoint.aggregate.phase,
    },
    {
      providerCalls: 1,
      signalAbortedAfterActiveDeadline: false,
      outcomeStatus: "paused",
      phase: "reviewing",
    },
    "recent stream lifecycle/token progress must renew the request watchdog",
  );
  assert.equal(
    activeResult.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_closed" &&
      entry.data?.timedOut === true
    ),
    false,
  );
  assert.equal(
    activeResult.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "work_plan.sealed"
    ).length,
    1,
  );

  assert.equal(durableProviderCalls, 1);
  assert.equal(durableSignalAborted, true);
  assert.equal(durableResult.settlement.outcome.status, "completed");
  assert.equal(durableResult.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    durableResult.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_closed" &&
      entry.data?.timedOut === true
    ),
    true,
  );
  const durableTerminal = durableResult.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(
    durableTerminal?.data?.detailCode,
    "runtime_v2_plan_deadline_reached",
  );
});

test("Plan model-lane queue time does not spend the provider inactivity lease and remains durable-deadline bounded", async () => {
  const submission = {
    planMarkdown: "Create the queued-lane fixture and verify the repository build.",
    changes: [{
      title: "Create the queued-lane fixture",
      operation: "create",
      targets: ["src/queued-lane-fixture.js"],
      change: "Create one bounded fixture behind the existing module boundary.",
      expectedOutcome: "The queued-lane fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };

  const queued = await withFakePlanClock(3_000_000, async (clock) => {
    let laneRequestedAt = null;
    let laneAdmittedAt = null;
    let streamStartedAt = null;
    let streamSignalAborted = null;
    let providerCalls = 0;
    const result = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        _callbacks,
        signal,
      ) => {
        providerCalls += 1;
        streamStartedAt = clock.now;
        streamSignalAborted = signal.aborted;
        return {
          content: "",
          toolCalls: [{
            id: "submit-after-queued-lane",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(submission),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        acquireModelLane: async ({ signal }) => {
          laneRequestedAt = clock.now;
          assert.equal(
            clock.timerArms.some((entry) =>
              entry.delayMs === planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
            ),
            false,
            "the provider inactivity lease must not start while the model lane is queued",
          );
          await clock.advanceBy(
            planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS + 30_000,
          );
          assert.equal(signal.aborted, false);
          laneAdmittedAt = clock.now;
          return testModelLaneLease();
        },
      },
    );
    return {
      result,
      providerCalls,
      laneRequestedAt,
      laneAdmittedAt,
      streamStartedAt,
      streamSignalAborted,
      timerArms: [...clock.timerArms],
    };
  });

  assert.ok(
    queued.laneAdmittedAt - queued.laneRequestedAt >
      planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS,
  );
  assert.equal(queued.streamStartedAt, queued.laneAdmittedAt);
  assert.equal(queued.streamSignalAborted, false);
  assert.equal(queued.providerCalls, 1);
  assert.equal(queued.result.settlement.outcome.status, "paused");
  assert.equal(queued.result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(
    queued.result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_closed" &&
      entry.data?.timedOut === true
    ),
    false,
  );
  const queuedInactivityArm = queued.timerArms.find((entry) =>
    entry.delayMs === planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
  );
  assert.equal(
    queuedInactivityArm?.armedAt,
    queued.laneAdmittedAt,
    "the 90s inactivity lease starts only after lane admission",
  );
  assert.equal(
    queued.timerArms.some((entry) =>
      entry.armedAt === queued.laneRequestedAt &&
      entry.delayMs > planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
    ),
    true,
    "a separate durable Plan lifecycle timer must own queued wall clock",
  );

  const deadlineBound = await withFakePlanClock(4_000_000, async (clock) => {
    let streamCalls = 0;
    let queuedSignalAborted = null;
    const result = await runProductionPlanScenario(
      async () => {
        streamCalls += 1;
        throw new Error("stream must not open after the durable Plan deadline");
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        acquireModelLane: async ({ signal }) => {
          await clock.advanceBy(planProtocol.PLAN_MODEL_DEADLINE_MS + 1);
          queuedSignalAborted = signal.aborted;
          return testModelLaneLease();
        },
      },
    );
    return {
      result,
      streamCalls,
      queuedSignalAborted,
      timerArms: [...clock.timerArms],
    };
  });
  assert.equal(deadlineBound.streamCalls, 0);
  assert.equal(deadlineBound.queuedSignalAborted, true);
  assert.equal(
    deadlineBound.timerArms.some((entry) =>
      entry.delayMs === planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
    ),
    false,
    "lane wait must not arm a provider inactivity timer even when lifecycle expires",
  );
  assert.equal(deadlineBound.result.settlement.outcome.status, "completed");
  assert.equal(deadlineBound.result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    deadlineBound.result.logs.find((entry) =>
      entry.eventName === "runtime_v2_plan_terminal"
    )?.data?.detailCode,
    "runtime_v2_plan_deadline_reached",
  );
});

test("Plan provider inactivity lease still times out 90s without a chunk after lane admission", async () => {
  const submission = {
    planMarkdown: "Recover from the stalled stream with a bounded structured Plan.",
    changes: [{
      title: "Create the post-stall fixture",
      operation: "create",
      targets: ["src/post-stall-fixture.js"],
      change: "Create one bounded fixture behind the existing module boundary.",
      expectedOutcome: "The post-stall fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const observed = await withFakePlanClock(5_000_000, async (clock) => {
    let providerCalls = 0;
    let firstLaneAdmittedAt = null;
    let firstStreamStartedAt = null;
    let firstSignalAborted = null;
    const result = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        _callbacks,
        signal,
      ) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          firstStreamStartedAt = clock.now;
          await clock.advanceBy(
            planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS + 1,
          );
          firstSignalAborted = signal.aborted;
          return {
            content: "",
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        }
        return {
          content: JSON.stringify(submission),
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        acquireModelLane: async () => {
          if (firstLaneAdmittedAt === null) firstLaneAdmittedAt = clock.now;
          return testModelLaneLease();
        },
      },
    );
    return {
      result,
      providerCalls,
      firstLaneAdmittedAt,
      firstStreamStartedAt,
      firstSignalAborted,
      timerArms: [...clock.timerArms],
    };
  });

  assert.equal(observed.firstStreamStartedAt, observed.firstLaneAdmittedAt);
  assert.equal(observed.firstSignalAborted, true);
  assert.equal(observed.providerCalls, 2);
  const firstInactivityArm = observed.timerArms.find((entry) =>
    entry.delayMs === planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
  );
  assert.equal(firstInactivityArm?.armedAt, observed.firstLaneAdmittedAt);
  const timedOutRequest = observed.result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_closed" &&
    entry.data?.timedOut === true
  );
  assert.ok(timedOutRequest);
  assert.equal(timedOutRequest.data?.stage, "discovery");
  assert.equal(
    timedOutRequest.data?.timeoutMs,
    planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS,
  );
  assert.equal(observed.result.settlement.outcome.status, "paused");
  assert.equal(observed.result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(
    observed.result.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "work_plan.sealed"
    ).length,
    1,
  );
});

test("compact Plan synthesis recovery couples its 90s deadline to bounded output and reasoning off", async () => {
  const requests = [];
  const runtimeOutputBudget = 32_768;
  const submission = {
    planMarkdown: "Create the bounded recovery fixture and verify the repository build.",
    changes: [{
      title: "Create the recovery fixture",
      operation: "create",
      targets: ["src/compact-recovery-fixture.js"],
      change: "Create one bounded fixture behind the existing module boundary.",
      expectedOutcome: "The recovery fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const result = await runProductionPlanScenario(
    async (
      messages,
      settings,
      _callbacks,
      _signal,
      tools,
      maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({
        messages,
        settings,
        toolNames: tools.map((tool) => tool.function.name),
        maxOutputTokens,
        requestOptions,
      });
      if (requests.length === 1) {
        throw new Error("ECONNRESET: discovery transport closed before an action");
      }
      return {
        content: JSON.stringify(submission),
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      reasoningToggle: true,
      runtimeContextBudget: {
        contextLimit: 65_536,
        outputBudget: runtimeOutputBudget,
        inputBudget: 32_768,
        readWindowChars: 32_000,
        source: "configured",
        providerContextLimit: 65_536,
        availableMemoryBytes: null,
      },
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  const recovery = requests[1];
  assert.deepEqual(recovery.toolNames, []);
  assert.equal(recovery.requestOptions.toolChoice, undefined);
  assert.equal(recovery.requestOptions.responseFormat?.type, "json_schema");
  assert.deepEqual(
    {
      maxOutputTokens: recovery.maxOutputTokens,
      reasoningRequest: recovery.settings.reasoningRequest ?? null,
      preserveAssistantReasoning:
        recovery.settings.preserveAssistantReasoning ?? null,
      timeoutMs: recovery.requestOptions.timeoutMs,
    },
    {
      maxOutputTokens: planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
      reasoningRequest: "off",
      preserveAssistantReasoning: false,
      timeoutMs: planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
    },
    "a fixed 90s recovery request cannot retain both the 32768-token budget and provider reasoning",
  );
  const opened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened" &&
    entry.data?.compactRecovery === true
  );
  assert.ok(opened);
  assert.equal(opened.data?.stage, "synthesis");
  assert.equal(opened.data?.requestedTransport, "structured_response");
  assert.equal(opened.data?.transport, "structured_response");
  assert.equal(opened.data?.maxOutputTokens,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS);
  assert.equal(opened.data?.timeoutMs,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS);
  assert.equal(opened.data?.repairReasoningDisabled, true);
});

test("a closed synthesis request gets compact sequential recovery without overlap", async () => {
  let providerRound = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const synthesisRequests = [];
  const submission = JSON.stringify({
    planMarkdown: "根因位于文件打开状态的所有权；修改保持现有工具边界。",
    changes: [{
      title: "统一标签生命周期",
      operation: "modify",
      targets: ["src/main.js"],
      change: "打开文件时替换仍为空白且未修改的初始标签。",
      expectedOutcome: "只显示当前文件标签。",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "构建通过。",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  });
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools, maxTokens, options) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        providerRound += 1;
        if (providerRound <= 8) {
          const sourcePath = providerRound === 1
            ? "src/main.js"
            : `src/helper-${providerRound}.js`;
          return {
            content: "",
            toolCalls: [{
              id: `read-before-timeout-${providerRound}`,
              name: "read_file",
              arguments: JSON.stringify({ path: sourcePath }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        synthesisRequests.push({ messages, maxTokens, options });
        if (providerRound === 9) {
          throw new Error(
            "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced keepalive chunks without a semantic action",
          );
        }
        return {
          content: submission,
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      } finally {
        activeRequests -= 1;
      }
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        return args.__raw
          ? `const source = ${JSON.stringify(String(args.path || ""))};\n${"x".repeat(5_000)}`
          : `${String(args.path || "")}:${String(args.start_line || 1)}\n${"x".repeat(5_000)}`;
      }
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 10);
  assert.equal(maxActiveRequests, 1);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.checkpoint.aggregate.scheduledCommands.length, 0);
  assert.equal(synthesisRequests.length, 2);
  assert.equal(synthesisRequests[0].maxTokens, 4_096);
  assert.equal(synthesisRequests[1].maxTokens, 4_096);
  assert.ok(
    synthesisRequests[1].messages.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ) <
    synthesisRequests[0].messages.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ),
  );
  assert.match(
    synthesisRequests[1].messages
      .map((message) => String(message.content || ""))
      .join("\n"),
    /preceding synthesis request did not produce a complete submission/,
  );
  assert.ok(synthesisRequests[1].options.responseFormat);
  assert.equal(result.checkpoint.aggregate.recovery.transportAttempts, 0);
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === "protocol_drift"
    ).length,
    1,
  );
});

test("repeated synthesis timeouts stay soft and a later submission can succeed", async () => {
  let providerRound = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const submission = JSON.stringify({
    planMarkdown: "根据已读取源码修复文件标签生命周期并验证构建。",
    changes: [{
      title: "统一标签生命周期",
      operation: "modify",
      targets: ["src/main.js"],
      change: "打开文件时替换仍为空白且未修改的初始标签。",
      expectedOutcome: "只显示当前文件标签。",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "构建通过。",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  });
  const result = await runProductionPlanScenario(
    async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        providerRound += 1;
        if (providerRound <= 8) {
          return {
            content: "",
            toolCalls: [{
              id: `read-before-double-timeout-${providerRound}`,
              name: "read_file",
              arguments: JSON.stringify({ path: "src/main.js" }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        if (providerRound <= 11) {
          throw new Error(
            "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced keepalive chunks without a semantic action",
          );
        }
        return {
          content: submission,
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      } finally {
        activeRequests -= 1;
      }
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 12);
  assert.equal(maxActiveRequests, 1);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.checkpoint.aggregate.scheduledCommands.length, 0);
  assert.equal(result.checkpoint.aggregate.terminalOutcome, null);
  assert.equal(result.checkpoint.aggregate.recovery.exhausted, null);
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "run.completed"
    ).length,
    0,
  );
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "recovery.exhausted"
    ).length,
    0,
  );
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === "protocol_drift"
    ).length,
    1,
  );
});

test("Plan no-action remains bounded and can recover after both synthesis transports", async () => {
  let providerRound = 0;
  const submission = JSON.stringify({
    planMarkdown: "根据已读取源码修复文件标签生命周期并验证构建。",
    changes: [{
      title: "统一标签生命周期",
      operation: "modify",
      targets: ["src/main.js"],
      change: "打开文件时替换仍为空白且未修改的初始标签。",
      expectedOutcome: "只显示当前文件标签。",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "构建通过。",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  });
  const result = await runProductionPlanScenario(
    async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "read-before-no-action",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (providerRound <= 5) {
        return {
          content: "仍在分析",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: submission,
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );
  const aggregate = result.checkpoint.aggregate;
  assert.equal(providerRound, 6);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(aggregate.phase, "reviewing");
  assert.equal(aggregate.scheduledCommands.length, 0);
  assert.ok(aggregate.workPlan);
  assert.equal(aggregate.recovery.exhausted, null);
  assert.equal(
    aggregate.events.filter((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === "no_tool_call"
    ).length,
    1,
  );
  assert.equal(
    aggregate.events.filter((event) => event.type === "run.completed").length,
    0,
  );
  assert.equal(
    aggregate.events.filter((event) => event.type === "turn.completed").length,
    0,
  );
  assert.equal(
    aggregate.events.filter((event) =>
      event.type === "projection.published" && event.audience === "final"
    ).length,
    0,
  );
});

test("only structured provider transport unavailability closes Plan recovery", async () => {
  let providerRound = 0;
  const result = await runProductionPlanScenario(
    async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "read-before-provider-unavailable",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      throw new runtime.RuntimeV2ProviderTransportsUnavailableError();
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      throw new Error(`unexpected tool ${name}`);
    },
  );
  const aggregate = result.checkpoint.aggregate;
  assert.equal(providerRound, 2);
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "partial");
  assert.equal(aggregate.phase, "completed");
  assert.equal(aggregate.terminalOutcome?.resultKind, "partial");
  assert.equal(aggregate.recovery.exhausted, null);
  assert.equal(
    aggregate.events.filter((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === "protocol_drift"
    ).length,
    0,
  );
});

test("one sealed WorkPlan and ReviewCommit survive checkpoint cold recovery", () => {
  const { checkpoint, sealed, commit } = reviewCheckpoint();
  const persisted = runtime.serializeRuntimeV2CheckpointMap({
    [turn.turnId]: checkpoint,
  })[turn.turnId];
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted, "aggregate"),
    false,
    "the durable checkpoint must contain only the canonical event ledger",
  );
  const restored = runtime.normalizeRuntimeV2Checkpoint(
    JSON.parse(JSON.stringify(persisted)),
    turn,
  );
  assert.ok(restored);
  assert.deepEqual(restored.aggregate.sealedWorkPlan, sealed);
  assert.deepEqual(restored.aggregate.planReviewCommit, commit);
  const resolved = adapter.resolveRuntimeV2PlanReviewFromAggregate(restored.aggregate);
  assert.equal(resolved?.pending, true);
  assert.equal(resolved?.commit.artifact.content, sealed.markdown);
  assert.equal(resolved?.commit.panel.markdown, sealed.markdown);
});

test("approval appends to the same v2 checkpoint only for the exact owner, request and authority", async () => {
  const { checkpoint, commit } = reviewCheckpoint();
  let current = checkpoint;
  let appendCount = 0;
  const port = {
    async load() {
      return current;
    },
    async append(input) {
      appendCount += 1;
      const result = runtime.appendRuntimeV2Checkpoint({
        checkpoint: current,
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        event: input.event,
      });
      if (result.checkpoint) current = result.checkpoint;
      return result;
    },
  };
  const request = actionRequest(commit);
  const result = await approval.approveRuntimeV2PlanReviewCheckpoint({
    checkpoint,
    port,
    request,
    expected: request,
    now: 30,
    eventId: "approved-event",
  });
  assert.equal(result.ok, true);
  assert.equal(appendCount, 1);
  assert.equal(result.checkpoint.aggregate.phase, "preparing");
  assert.equal(result.checkpoint.aggregate.workPlan.status, "approved");
  const approved = adapter.resolveApprovedRuntimeV2WorkPlanFromAggregate(
    result.checkpoint.aggregate,
  );
  assert.equal(approved?.plan.id, commit.authority.id);
  assert.deepEqual(approved?.commit, commit);

  for (const altered of [
    actionRequest(commit, { requestId: "stale-request" }),
    actionRequest(commit, { sessionKey: "session-b" }),
    actionRequest(commit, { sessionEpoch: "epoch-b" }),
    actionRequest(commit, { runId: "review-run-b" }),
    actionRequest(commit, { parentRunId: "wrong-parent" }),
    actionRequest(commit, { planRevision: commit.authority.revision + 1 }),
    actionRequest(commit, { artifactHash: "wrong-projection" }),
    actionRequest(commit, { artifactPaths: [".MAIN/plans/other.md"] }),
  ]) {
    let called = false;
    const rejected = await approval.approveRuntimeV2PlanReviewCheckpoint({
      checkpoint,
      port: {
        async load() { return checkpoint; },
        async append() {
          called = true;
          throw new Error("must not append");
        },
      },
      request: altered,
      expected: altered,
      now: 30,
      eventId: "must-not-append",
    });
    assert.equal(rejected.ok, false);
    assert.equal(called, false);
  }

  let ownerAppendCalled = false;
  const wrongOwner = await approval.approveRuntimeV2PlanReviewCheckpoint({
    checkpoint: {
      ...checkpoint,
      owner: { ...checkpoint.owner, sessionEpoch: "epoch-b" },
    },
    port: {
      async load() { return checkpoint; },
      async append() {
        ownerAppendCalled = true;
        throw new Error("must not append");
      },
    },
    request,
    expected: request,
    now: 30,
    eventId: "wrong-owner-must-not-append",
  });
  assert.equal(wrongOwner.ok, false);
  assert.equal(ownerAppendCalled, false);
});

test("tampered persisted projections fail closed instead of becoming review authority", () => {
  const { checkpoint } = reviewCheckpoint();
  const tamperedAggregate = {
    ...checkpoint.aggregate,
    planReviewCommit: {
      ...checkpoint.aggregate.planReviewCommit,
      panel: {
        ...checkpoint.aggregate.planReviewCommit.panel,
        markdown: "# tampered",
      },
    },
  };
  assert.equal(adapter.resolveRuntimeV2PlanReviewFromAggregate(tamperedAggregate), null);
});

test("approval is exactly once under competing callbacks and only one callback may dispatch", async () => {
  const { checkpoint, commit } = reviewCheckpoint();
  let current = checkpoint;
  let committedCount = 0;
  const request = actionRequest(commit);
  const port = {
    async load() {
      return current;
    },
    async append(input) {
      await Promise.resolve();
      const result = runtime.appendRuntimeV2Checkpoint({
        checkpoint: current,
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        event: input.event,
      });
      if (result.disposition === "committed") {
        current = result.checkpoint;
        committedCount += 1;
      }
      return result;
    },
  };
  const inputs = ["approval-race", "approval-race"].map((eventId) =>
    approval.approveRuntimeV2PlanReviewCheckpoint({
      checkpoint,
      port,
      request,
      expected: request,
      now: 30,
      eventId,
    })
  );
  const results = await Promise.all(inputs);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) =>
      !result.ok && result.reason === "runtime_v2_plan_already_approved"
    ).length,
    1,
  );
  assert.equal(committedCount, 1);
  assert.equal(current.aggregate.phase, "preparing");
});

test("approved execution authority rejects owner, reference and projection tampering", async () => {
  const { checkpoint, commit } = reviewCheckpoint();
  let current = checkpoint;
  const result = await approval.approveRuntimeV2PlanReviewCheckpoint({
    checkpoint,
    port: {
      async load() { return current; },
      async append(input) {
        const appended = runtime.appendRuntimeV2Checkpoint({
          checkpoint: current,
          owner: input.owner,
          expectedRevision: input.expectedRevision,
          event: input.event,
        });
        if (appended.checkpoint) current = appended.checkpoint;
        return appended;
      },
    },
    request: actionRequest(commit),
    expected: actionRequest(commit),
    now: 30,
    eventId: "approved-for-integrity-test",
  });
  assert.equal(result.ok, true);
  const aggregate = result.checkpoint.aggregate;
  assert.ok(adapter.resolveApprovedRuntimeV2WorkPlanFromAggregate(aggregate));
  for (const phase of ["validating", "finalizing"]) {
    const executing = {
      ...aggregate,
      phase,
      run: { ...aggregate.run, phase },
    };
    assert.ok(
      adapter.resolveApprovedRuntimeV2WorkPlanFromAggregate(executing),
      `approved authority must remain available during ${phase}`,
    );
  }
  for (const altered of [
    { ...aggregate, phase: "reviewing" },
    { ...aggregate, workPlan: { ...aggregate.workPlan, status: "pending_review" } },
    {
      ...aggregate,
      workPlan: { ...aggregate.workPlan, digest: "tampered-digest" },
    },
    {
      ...aggregate,
      planReviewCommit: {
        ...aggregate.planReviewCommit,
        review: {
          ...aggregate.planReviewCommit.review,
          sessionEpoch: "epoch-b",
        },
      },
    },
    {
      ...aggregate,
      planReviewCommit: {
        ...aggregate.planReviewCommit,
        chat: {
          ...aggregate.planReviewCommit.chat,
          markdown: "tampered projection",
        },
      },
    },
  ]) {
    assert.equal(adapter.resolveApprovedRuntimeV2WorkPlanFromAggregate(altered), null);
  }
});

test("approval handoff resumes the review Run through v2 Execute without a legacy lease", () => {
  const store = fs.readFileSync(
    path.join(workspaceRoot, "src/store/useAppStore.ts"),
    "utf8",
  );
  const approvalBranch = store.slice(
    store.indexOf("runtimeV2Review?.pending"),
    store.indexOf("if (state.isPlanApproved", store.indexOf("runtimeV2Review?.pending")),
  );
  assert.match(
    approvalBranch,
    /approveAndDispatchRuntimeV2Plan/,
  );
  assert.match(approvalBranch, /runIdOverride:\s*runId/);
  assert.match(approvalBranch, /runtimeIntentOverride:\s*"execute"/);
  assert.match(approvalBranch, /executionConsentGranted:\s*true/);
  assert.doesNotMatch(approvalBranch, /planExecution\s*:/);
  assert.doesNotMatch(approvalBranch, /startPlanApprovalExecution|pendingPlanApprovalHandoff/);
  assert.doesNotMatch(approvalBranch, /execution dispatch did not start|执行调度未能启动/);
});

test("a rejected approved-Plan dispatch writes one final error instead of pausing", async () => {
  const { checkpoint, commit } = reviewCheckpoint();
  let current = checkpoint;
  const port = {
    async load() { return current; },
    async append(input) {
      const result = runtime.appendRuntimeV2Checkpoint({
        checkpoint: current,
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        event: input.event,
      });
      if (result.checkpoint) current = result.checkpoint;
      return result;
    },
  };
  const approved = await approval.approveRuntimeV2PlanReviewCheckpoint({
    checkpoint,
    port,
    request: actionRequest(commit),
    expected: actionRequest(commit),
    now: 30,
    eventId: "approve-before-handoff-failure",
  });
  assert.equal(approved.ok, true);
  const closed = await handoff.finishRuntimeV2PlanHandoffFailure({
    checkpoint: approved.checkpoint,
    checkpointPort: port,
    projectionPort: { async publish() {} },
    now: 40,
    eventIdBase: "handoff-failure",
    reason: "Execution ownership was not acquired.",
  });
  assert.equal(closed.ok, true);
  assert.equal(current.aggregate.phase, "completed");
  assert.equal(current.aggregate.terminalOutcome.resultKind, "error");
  assert.equal(current.aggregate.scheduledCommands.length, 0);
  assert.equal(
    current.aggregate.events.filter((event) => event.type === "run.completed").length,
    1,
  );
  assert.equal(
    current.aggregate.events.filter((event) => event.type === "turn.completed").length,
    1,
  );
  assert.equal(
    current.aggregate.events.filter((event) =>
      event.type === "projection.published" && event.audience === "final"
    ).length,
    1,
  );
  const repeated = await handoff.finishRuntimeV2PlanHandoffFailure({
    checkpoint: current,
    checkpointPort: port,
    projectionPort: { async publish() {} },
    now: 50,
    eventIdBase: "handoff-failure-repeat",
    reason: "Execution ownership was not acquired.",
  });
  assert.equal(repeated.ok, true);
  assert.equal(
    current.aggregate.events.filter((event) => event.type === "run.completed").length,
    1,
  );
});
