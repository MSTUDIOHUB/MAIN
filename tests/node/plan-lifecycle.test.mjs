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
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
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

const {
  PLAN_LIFECYCLE_SCHEMA_VERSION,
  PLAN_LIFECYCLE_STATUSES,
  createPlanLifecycleState,
  ensurePlanLifecycleOwner,
  isPlanApprovalLeaseBoundToState,
  isPlanLifecycleExecutionAuthorized,
  isPlanLifecycleExecutionAuthorizedForRun,
  migrateLegacyPlanLifecycle,
  reducePlanLifecycle,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planLifecycle.ts"));
const {
  issuePlanAutoResumeAttempt,
  issuePlanExplicitResumeAttempt,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionContinuation.ts"));
const {
  capturePlanExecutionRunProvenance,
  doesLifecycleRetainPlanExecutionProvenance,
  isPlanExecutionRunProvenanceForOwner,
  normalizePlanExecutionRunProvenance,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionProvenance.ts"));

const sessionKey = "workspace-a::session-7";
const sessionEpoch = "session-owner-epoch-3";

function artifact(overrides = {}) {
  return {
    revision: 4,
    artifactHash: "sha256:plan-four",
    artifactPaths: ["./.MAIN/plans/tasks.md", ".MAIN/plans/plan.md"],
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    sessionKey,
    sessionEpoch,
    turnId: "turn-plan-4",
    runId: "run-review-4",
    parentRunId: "run-plan-author-4",
    requestId: "request-review-4",
    planRevision: 4,
    artifactHash: "sha256:plan-four",
    artifactPaths: [".MAIN/plans/plan.md", ".MAIN\\plans\\tasks.md"],
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    sessionKey,
    sessionEpoch,
    turnId: "turn-plan-4",
    runId: "run-review-4",
    requestId: "request-review-4",
    kind: "action_decision",
    ...overrides,
  };
}

function approvalLease(overrides = {}) {
  return {
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    leaseId: "lease-plan-4",
    sessionKey,
    sessionEpoch,
    planTurnId: "turn-plan-4",
    reviewRunId: "run-review-4",
    requestId: "request-review-4",
    planRevision: 4,
    artifactHash: "sha256:plan-four",
    artifactPaths: [".MAIN/plans/tasks.md", ".MAIN/plans/plan.md"],
    approvedAt: 40,
    approvalTurnId: "turn-plan-4",
    approvalRunId: "run-review-4",
    approvalDecisionKind: "action_decision",
    ...overrides,
  };
}

function executionLease(overrides = {}) {
  const defaults = {
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    executionLeaseId: "execution-lease-1",
    approvalLeaseId: "lease-plan-4",
    sessionKey,
    sessionEpoch,
    planTurnId: "turn-plan-4",
    executionTurnId: "turn-plan-4",
    executionRunId: "run-execution-1",
    parentRunId: "run-review-4",
    attempt: 1,
    issuedAt: 40,
    reason: "initial_approval",
    instructionHash: "plan-instruction-sha256-one",
    authorization: decision(),
  };
  return { ...defaults, ...overrides };
}

function owner(overrides = {}) {
  return {
    turnId: "turn-plan-4",
    runId: "run-execution-1",
    parentRunId: "run-review-4",
    attempt: 1,
    startedAt: 41,
    ...overrides,
  };
}

function apply(state, command) {
  const result = reducePlanLifecycle(state, command);
  assert.equal(result.disposition, "applied", result.reason);
  return result.state;
}

function awaitingState() {
  let state = createPlanLifecycleState({ sessionKey, sessionEpoch, updatedAt: 1 });
  state = apply(state, {
    type: "start_drafting", expectedVersion: state.version, at: 10,
    planTurnId: "turn-plan-4", artifactIdentity: artifact(),
  });
  return apply(state, {
    type: "request_review", expectedVersion: state.version, at: 20,
    artifactIdentity: artifact(), reviewIdentity: review(),
  });
}

function handoffState(overrides = {}) {
  const state = awaitingState();
  return apply(state, {
    type: "approve", expectedVersion: state.version, at: 40,
    expectedReviewIdentity: review(), decisionIdentity: decision(),
    lease: approvalLease(), executionLease: executionLease(overrides),
  });
}

function executingState() {
  const state = handoffState();
  return apply(state, {
    type: "execution_started", expectedVersion: state.version, at: 41,
    executionLeaseId: "execution-lease-1",
    instructionHash: "plan-instruction-sha256-one",
    execution: owner(),
  });
}

function pauseExecuting(state, at = 50, pause = {
  reason: "bounded_checkpoint", resultKind: "partial", resumeCondition: "continue_plan",
}) {
  return apply(state, {
    type: "pause", expectedVersion: state.version, at, pause,
    expectedExecutionLeaseId: state.executionLease.executionLeaseId,
    expectedExecution: state.execution,
  });
}

test("canonical lifecycle has seven statuses and no failed state", () => {
  assert.deepEqual([...PLAN_LIFECYCLE_STATUSES], [
    "empty", "drafting", "awaiting_approval", "handoff_pending", "executing", "paused", "completed",
  ]);
  assert.equal(PLAN_LIFECYCLE_STATUSES.includes("failed"), false);
  const state = createPlanLifecycleState({ sessionKey, sessionEpoch, updatedAt: 7 });
  assert.deepEqual(Object.keys(state).sort(), [
    "approvalLease", "artifactIdentity", "execution", "executionLease", "lastIssuedAttempt",
    "pause", "planTurnId", "reviewIdentity", "schemaVersion", "sessionEpoch", "sessionKey",
    "status", "updatedAt", "version",
  ]);
  assert.equal(state.lastIssuedAttempt, 0);
  assert.equal(Object.isFrozen(state), true);
});

test("hydration is discovery-only and cannot overwrite active execution", () => {
  const initial = createPlanLifecycleState({ sessionKey, sessionEpoch });
  const hydrated = reducePlanLifecycle(initial, {
    type: "hydrate_discovery", expectedVersion: 0, at: 2,
    planTurnId: "turn-plan-4", artifactIdentity: artifact(),
  });
  assert.equal(hydrated.disposition, "applied");
  assert.equal(hydrated.state.status, "drafting");
  assert.equal(hydrated.state.approvalLease, null);
  assert.equal(hydrated.state.executionLease, null);

  const executing = executingState();
  const rejected = reducePlanLifecycle(executing, {
    type: "hydrate_discovery", expectedVersion: executing.version, at: 60,
    planTurnId: "turn-plan-4", artifactIdentity: artifact(),
  });
  assert.equal(rejected.disposition, "rejected");
  assert.equal(rejected.reason, "transition_not_allowed");
});

test("review and approval bind exact artifact, Session generation, and decision owner", () => {
  const awaiting = awaitingState();
  for (const badDecision of [
    decision({ sessionEpoch: "old-epoch" }),
    decision({ runId: "other-run" }),
    decision({ kind: "action_decision", turnId: "other-turn" }),
  ]) {
    const rejected = reducePlanLifecycle(awaiting, {
      type: "approve", expectedVersion: awaiting.version, at: 40,
      expectedReviewIdentity: review(), decisionIdentity: badDecision,
      lease: approvalLease({
        approvalTurnId: badDecision.turnId,
        approvalRunId: badDecision.runId,
        approvalDecisionKind: badDecision.kind,
      }),
      executionLease: executionLease({ authorization: badDecision }),
    });
    assert.equal(rejected.disposition, "rejected");
  }

  const workspaceDecision = decision({
    kind: "workspace_turn", turnId: "turn-approve-9", runId: "run-approve-9",
  });
  const accepted = reducePlanLifecycle(awaiting, {
    type: "approve", expectedVersion: awaiting.version, at: 40,
    expectedReviewIdentity: review(), decisionIdentity: workspaceDecision,
    lease: approvalLease({
      approvalTurnId: workspaceDecision.turnId,
      approvalRunId: workspaceDecision.runId,
      approvalDecisionKind: "workspace_turn",
    }),
    executionLease: executionLease({
      executionTurnId: workspaceDecision.turnId,
      parentRunId: workspaceDecision.runId,
      authorization: workspaceDecision,
    }),
  });
  assert.equal(accepted.disposition, "applied");
  assert.equal(accepted.state.status, "handoff_pending");
  assert.equal(accepted.state.lastIssuedAttempt, 1);
  assert.equal(isPlanApprovalLeaseBoundToState(accepted.state), true);
});

test("approval and exact start are immutable, CAS guarded, and instruction-bound", () => {
  const mutablePaths = [".MAIN/plans/tasks.md", ".MAIN/plans/plan.md"];
  const awaiting = awaitingState();
  const command = {
    type: "approve", expectedVersion: awaiting.version, at: 40,
    expectedReviewIdentity: review(), decisionIdentity: decision(),
    lease: approvalLease({ artifactPaths: mutablePaths }), executionLease: executionLease(),
  };
  const approved = reducePlanLifecycle(awaiting, command);
  assert.equal(approved.disposition, "applied");
  mutablePaths.push(".MAIN/plans/design.md");
  assert.deepEqual(approved.state.approvalLease.artifactPaths, [
    ".MAIN/plans/plan.md", ".MAIN/plans/tasks.md",
  ]);

  const duplicate = reducePlanLifecycle(approved.state, {
    ...command, lease: approvalLease(), executionLease: executionLease(),
  });
  assert.equal(duplicate.disposition, "idempotent");

  for (const bad of [
    { instructionHash: "wrong", execution: owner() },
    { instructionHash: "plan-instruction-sha256-one", execution: owner({ attempt: 2 }) },
    { instructionHash: "plan-instruction-sha256-one", execution: owner({ runId: "other-run" }) },
  ]) {
    const rejected = reducePlanLifecycle(approved.state, {
      type: "execution_started", expectedVersion: approved.state.version, at: 41,
      executionLeaseId: "execution-lease-1", ...bad,
    });
    assert.equal(rejected.disposition, "rejected");
  }

  const executing = executingState();
  assert.equal(isPlanLifecycleExecutionAuthorized(executing), true);
  assert.equal(isPlanLifecycleExecutionAuthorizedForRun(executing, {
    executionLeaseId: "execution-lease-1", turnId: "turn-plan-4", runId: "run-execution-1",
    parentRunId: "run-review-4", attempt: 1,
  }), true);
});

test("Plan execution provenance is captured only after exact Run admission and is immutable", () => {
  const executing = executingState();
  const provenance = capturePlanExecutionRunProvenance(executing);
  assert.deepEqual(provenance, {
    schemaVersion: 1,
    sessionKey,
    sessionEpoch,
    planTurnId: "turn-plan-4",
    approvalLeaseId: "lease-plan-4",
    planRevision: 4,
    artifactHash: "sha256:plan-four",
    executionLeaseId: "execution-lease-1",
    executionTurnId: "turn-plan-4",
    executionRunId: "run-execution-1",
    parentRunId: "run-review-4",
    attempt: 1,
    instructionHash: "plan-instruction-sha256-one",
  });
  assert.equal(Object.isFrozen(provenance), true);
  assert.equal(capturePlanExecutionRunProvenance(handoffState()), null);
  assert.equal(capturePlanExecutionRunProvenance(pauseExecuting(executing)), null);

  const normalized = normalizePlanExecutionRunProvenance({ ...provenance });
  assert.deepEqual(normalized, provenance);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(isPlanExecutionRunProvenanceForOwner(provenance, {
    sessionKey,
    turnId: "turn-plan-4",
    runId: "run-execution-1",
    parentRunId: "run-review-4",
  }), true);
  assert.equal(isPlanExecutionRunProvenanceForOwner(provenance, {
    sessionKey,
    turnId: "turn-plan-4",
    runId: "stale-run",
    parentRunId: "run-review-4",
  }), false);

  for (const malformed of [
    { ...provenance, schemaVersion: 2 },
    { ...provenance, attempt: 0 },
    { ...provenance, planRevision: 0 },
    { ...provenance, instructionHash: " " },
    { ...provenance, artifactHash: " " },
    { ...provenance, parentRunId: provenance.executionRunId },
  ]) {
    assert.equal(normalizePlanExecutionRunProvenance(malformed), null);
  }
});

test("paused Plan retains only the exact admitted Run provenance", () => {
  const executing = executingState();
  const provenance = capturePlanExecutionRunProvenance(executing);
  const paused = pauseExecuting(executing);
  assert.equal(doesLifecycleRetainPlanExecutionProvenance(executing, provenance), true);
  assert.equal(doesLifecycleRetainPlanExecutionProvenance(paused, provenance), true);

  for (const stale of [
    { ...paused, sessionEpoch: "stale-epoch" },
    {
      ...paused,
      artifactIdentity: { ...paused.artifactIdentity, revision: paused.artifactIdentity.revision + 1 },
    },
    {
      ...paused,
      approvalLease: { ...paused.approvalLease, leaseId: "stale-approval-lease" },
    },
    {
      ...paused,
      executionLease: { ...paused.executionLease, instructionHash: "stale-instruction" },
    },
    {
      ...paused,
      execution: { ...paused.execution, runId: "stale-run" },
    },
    { ...paused, lastIssuedAttempt: paused.lastIssuedAttempt + 1 },
  ]) {
    assert.equal(doesLifecycleRetainPlanExecutionProvenance(stale, provenance), false);
  }
});

test("execution terminal transitions require the exact lease and owner", () => {
  const executing = executingState();
  const staleComplete = reducePlanLifecycle(executing, {
    type: "complete", expectedVersion: executing.version, at: 50,
    expectedExecutionLeaseId: "old-lease", expectedExecution: owner(),
  });
  assert.equal(staleComplete.disposition, "rejected");

  const stalePause = reducePlanLifecycle(executing, {
    type: "pause", expectedVersion: executing.version, at: 50,
    pause: { reason: "error", resultKind: "error", resumeCondition: "retry" },
    expectedExecutionLeaseId: "execution-lease-1",
    expectedExecution: owner({ runId: "old-run" }),
  });
  assert.equal(stalePause.disposition, "rejected");

  const completed = reducePlanLifecycle(executing, {
    type: "complete", expectedVersion: executing.version, at: 50,
    expectedExecutionLeaseId: "execution-lease-1", expectedExecution: owner(),
  });
  assert.equal(completed.disposition, "applied");
  assert.equal(completed.state.status, "completed");
  const duplicate = reducePlanLifecycle(completed.state, {
    type: "complete", expectedVersion: executing.version, at: 50,
    expectedExecutionLeaseId: "execution-lease-1", expectedExecution: owner(),
  });
  assert.equal(duplicate.disposition, "idempotent");
});

test("an exact paused execution can be reclassified for explicit resume without changing authority", () => {
  const paused = pauseExecuting(executingState(), 50, {
    reason: "tool_permission",
    resultKind: "partial",
    resumeCondition: "resolve_action_request",
  });
  const reclassified = reducePlanLifecycle(paused, {
    type: "pause",
    expectedVersion: paused.version,
    at: 51,
    expectedExecutionLeaseId: paused.executionLease.executionLeaseId,
    expectedExecution: paused.execution,
    pause: {
      reason: "plan_action_continuation_admission_rejected",
      resultKind: "error",
      resumeCondition: "explicit_resume",
    },
  });
  assert.equal(reclassified.disposition, "applied");
  assert.equal(reclassified.state.status, "paused");
  assert.deepEqual(reclassified.state.pause, {
    reason: "plan_action_continuation_admission_rejected",
    resultKind: "error",
    resumeCondition: "explicit_resume",
  });
  assert.equal(reclassified.state.approvalLease, paused.approvalLease);
  assert.equal(reclassified.state.executionLease, paused.executionLease);
  assert.equal(reclassified.state.execution, paused.execution);

  for (const stale of [
    { expectedExecutionLeaseId: "stale-lease", expectedExecution: paused.execution },
    {
      expectedExecutionLeaseId: paused.executionLease.executionLeaseId,
      expectedExecution: { ...paused.execution, runId: "stale-run" },
    },
  ]) {
    const rejected = reducePlanLifecycle(paused, {
      type: "pause",
      expectedVersion: paused.version,
      at: 51,
      ...stale,
      pause: {
        reason: "plan_action_continuation_admission_rejected",
        resultKind: "error",
        resumeCondition: "explicit_resume",
      },
    });
    assert.equal(rejected.disposition, "rejected");
    assert.equal(rejected.reason, "execution_owner_mismatch");
  }
});

test("initial plus explicit and auto resumes form attempts 1→2→3 with exact lineage", () => {
  let state = pauseExecuting(executingState());
  const explicitAuthorization = {
    kind: "workspace_turn", sessionKey, sessionEpoch,
    turnId: "turn-resume-2", runId: "run-resume-decision-2", requestId: "resume-request-2",
  };
  const secondLease = executionLease({
    executionLeaseId: "execution-lease-2", executionTurnId: "turn-resume-2",
    executionRunId: "run-execution-2", parentRunId: "run-execution-1", attempt: 2,
    issuedAt: 51, reason: "explicit_resume", instructionHash: "plan-instruction-sha256-two",
    authorization: explicitAuthorization,
  });
  state = apply(state, {
    type: "resume_execution", expectedVersion: state.version, at: 51,
    approvalLeaseId: "lease-plan-4", executionLease: secondLease,
  });
  assert.equal(state.lastIssuedAttempt, 2);
  state = apply(state, {
    type: "execution_started", expectedVersion: state.version, at: 52,
    executionLeaseId: "execution-lease-2", instructionHash: "plan-instruction-sha256-two",
    execution: owner({
      turnId: "turn-resume-2", runId: "run-execution-2", parentRunId: "run-execution-1",
      attempt: 2, startedAt: 52,
    }),
  });
  state = pauseExecuting(state, 60);

  const thirdLease = executionLease({
    executionLeaseId: "execution-lease-3", executionTurnId: "turn-resume-2",
    executionRunId: "run-execution-3", parentRunId: "run-execution-2", attempt: 3,
    issuedAt: 61, reason: "auto_resume", instructionHash: "plan-instruction-sha256-three",
    authorization: {
      kind: "auto_resume_checkpoint", sessionKey, sessionEpoch,
      turnId: "turn-resume-2", runId: "run-execution-2", requestId: "checkpoint-2",
      priorExecutionLeaseId: "execution-lease-2", checkpointHash: "checkpoint-sha256-two",
    },
  });
  state = apply(state, {
    type: "resume_execution", expectedVersion: state.version, at: 61,
    approvalLeaseId: "lease-plan-4", executionLease: thirdLease,
  });
  assert.equal(state.lastIssuedAttempt, 3);
  assert.equal(state.execution.runId, "run-execution-2");
  state = apply(state, {
    type: "execution_started", expectedVersion: state.version, at: 62,
    executionLeaseId: "execution-lease-3", instructionHash: "plan-instruction-sha256-three",
    execution: owner({
      turnId: "turn-resume-2", runId: "run-execution-3", parentRunId: "run-execution-2",
      attempt: 3, startedAt: 62,
    }),
  });
  assert.equal(isPlanLifecycleExecutionAuthorized(state), true);
});

test("bounded auto-resume issues a one-shot child handoff from the exact checkpoint", () => {
  const issued = issuePlanAutoResumeAttempt({
    lifecycle: executingState(),
    instruction: "continue from checkpoint",
    checkpointHash: "checkpoint-sha256-1",
    executionRunId: "run-execution-2",
    executionLeaseId: "execution-lease-2",
    authorizationRequestId: "checkpoint-request-2",
    issuedAt: 50,
    pause: {
      reason: "max_iterations_auto_resume",
      resultKind: "partial",
      resumeCondition: "bounded_auto_resume_checkpoint",
    },
  });
  assert.equal(issued.ok, true);
  assert.equal(issued.lifecycle.status, "handoff_pending");
  assert.equal(issued.lifecycle.lastIssuedAttempt, 2);
  assert.equal(issued.handoff.executionRunId, "run-execution-2");
  assert.equal(issued.handoff.parentRunId, "run-execution-1");
  assert.equal(issued.handoff.executionAttempt, 2);
  assert.equal(issued.lifecycle.execution.runId, "run-execution-1");
  assert.equal(issued.lifecycle.executionLease.authorization.kind, "auto_resume_checkpoint");
});

test("tool approval continuation requires the exact paused Run and action decision", () => {
  const paused = pauseExecuting(executingState(), 50, {
    reason: "tool_permission",
    resultKind: "partial",
    resumeCondition: "resolve_action_request",
  });
  const issued = issuePlanExplicitResumeAttempt({
    lifecycle: paused,
    instruction: "tool permission continuation",
    executionRunId: "run-action-2",
    executionLeaseId: "execution-action-2",
    authorization: {
      kind: "action_decision",
      turnId: "turn-plan-4",
      runId: "run-execution-1",
      requestId: "tool-request-2",
    },
    issuedAt: 51,
  });
  assert.equal(issued.ok, true);
  assert.equal(issued.lifecycle.status, "handoff_pending");
  assert.equal(issued.handoff.parentRunId, "run-execution-1");
  assert.equal(issued.handoff.executionAttempt, 2);

  const stale = issuePlanExplicitResumeAttempt({
    lifecycle: paused,
    instruction: "tool permission continuation",
    executionRunId: "run-action-stale",
    executionLeaseId: "execution-action-stale",
    authorization: {
      kind: "action_decision",
      turnId: "turn-plan-4",
      runId: "stale-run",
      requestId: "tool-request-stale",
    },
    issuedAt: 51,
  });
  assert.equal(stale.ok, false);
});

test("an unstarted reserved Run never becomes the next parent", () => {
  let state = handoffState();
  state = apply(state, {
    type: "pause", expectedVersion: state.version, at: 42,
    pause: { reason: "admission_rejected", resultKind: "error", resumeCondition: "retry" },
  });
  const authorization = {
    kind: "workspace_turn", sessionKey, sessionEpoch,
    turnId: "turn-retry-2", runId: "run-retry-decision-2", requestId: "retry-request-2",
  };
  const nextLease = executionLease({
    executionLeaseId: "execution-lease-2", executionTurnId: "turn-retry-2",
    executionRunId: "run-execution-2", parentRunId: "run-review-4", attempt: 2,
    issuedAt: 43, reason: "explicit_resume", instructionHash: "plan-instruction-sha256-two",
    authorization,
  });
  const resumed = reducePlanLifecycle(state, {
    type: "resume_execution", expectedVersion: state.version, at: 43,
    approvalLeaseId: "lease-plan-4", executionLease: nextLease,
  });
  assert.equal(resumed.disposition, "applied");
  assert.equal(resumed.state.executionLease.parentRunId, "run-review-4");
  assert.notEqual(resumed.state.executionLease.parentRunId, "run-execution-1");
});

test("explicit resume replaces an unstarted reservation with a fresh attempt-scoped lease", () => {
  let state = handoffState();
  state = apply(state, {
    type: "pause", expectedVersion: state.version, at: 42,
    pause: {
      reason: "plan_execution_admission_rejected",
      resultKind: "error",
      resumeCondition: "explicit_resume",
    },
  });
  assert.equal(state.execution, null);
  assert.equal(state.lastIssuedAttempt, 1);

  const issued = issuePlanExplicitResumeAttempt({
    lifecycle: state,
    instruction: "retry the approved plan",
    executionRunId: "run-execution-2",
    executionLeaseId: "execution-lease-2",
    authorization: {
      kind: "action_decision",
      turnId: state.approvalLease.approvalTurnId,
      runId: state.approvalLease.approvalRunId,
      requestId: "resume-request-2",
    },
    issuedAt: 43,
  });
  assert.equal(issued.ok, true);
  assert.equal(issued.lifecycle.status, "handoff_pending");
  assert.equal(issued.lifecycle.execution, null);
  assert.equal(issued.lifecycle.lastIssuedAttempt, 2);
  assert.equal(issued.lifecycle.executionLease.executionLeaseId, "execution-lease-2");
  assert.equal(issued.lifecycle.executionLease.parentRunId, "run-review-4");
  assert.notEqual(issued.lifecycle.executionLease.executionRunId, "run-execution-1");
  assert.equal(issued.handoff.executionAttempt, 2);

  const staleOwner = issuePlanExplicitResumeAttempt({
    lifecycle: state,
    instruction: "retry the approved plan",
    executionRunId: "run-execution-stale",
    executionLeaseId: "execution-lease-stale",
    authorization: {
      kind: "action_decision",
      turnId: state.approvalLease.approvalTurnId,
      runId: "stale-approval-run",
      requestId: "resume-request-stale",
    },
    issuedAt: 43,
  });
  assert.equal(staleOwner.ok, false);
});

test("artifact changes revoke all authority atomically", () => {
  const executing = executingState();
  const changed = reducePlanLifecycle(executing, {
    type: "artifact_changed", expectedVersion: executing.version, at: 55,
    artifactIdentity: artifact({ revision: 5, artifactHash: "sha256:plan-five" }),
  });
  assert.equal(changed.disposition, "applied");
  assert.equal(changed.state.status, "paused");
  assert.equal(changed.state.approvalLease, null);
  assert.equal(changed.state.executionLease, null);
  assert.equal(changed.state.execution, null);
  assert.equal(changed.state.lastIssuedAttempt, 0);
});

test("restore retains exact approval audit but retires execution authority", () => {
  const migrated = migrateLegacyPlanLifecycle({
    version: 8, status: "executing", sessionKey, sessionEpoch,
    planTurnId: "turn-plan-4", artifactIdentity: artifact(), reviewIdentity: review(),
    approvalLease: approvalLease(), executionLease: executionLease(), execution: owner(),
    lastIssuedAttempt: 1, isPlanApproved: true, updatedAt: 70,
  });
  assert.equal(migrated.status, "paused");
  assert.equal(migrated.approvalLease.leaseId, "lease-plan-4");
  assert.equal(migrated.executionLease, null);
  assert.equal(migrated.execution.runId, "run-execution-1");
  assert.equal(migrated.lastIssuedAttempt, 1);
  assert.equal(isPlanApprovalLeaseBoundToState(migrated), true);
  assert.equal(isPlanLifecycleExecutionAuthorized(migrated), false);

  const unverifiable = migrateLegacyPlanLifecycle({
    sessionKey, sessionEpoch, planTurnId: "turn-plan-4", artifactIdentity: artifact(),
    reviewIdentity: review(), isPlanApproved: true,
  });
  assert.equal(unverifiable.status, "paused");
  assert.equal(unverifiable.approvalLease, null);
  assert.equal(unverifiable.pause.reason, "legacy_approval_unverifiable");
});

test("stale CAS is pure and cannot mutate a prior snapshot", () => {
  const awaiting = awaitingState();
  const before = structuredClone(awaiting);
  const stale = reducePlanLifecycle(awaiting, {
    type: "approve", expectedVersion: awaiting.version - 1, at: 40,
    expectedReviewIdentity: review(), decisionIdentity: decision(),
    lease: approvalLease(), executionLease: executionLease(),
  });
  assert.equal(stale.disposition, "rejected");
  assert.equal(stale.reason, "version_conflict");
  assert.strictEqual(stale.state, awaiting);
  assert.deepEqual(awaiting, before);
});

test("recreating a Session with the same key mints an empty lifecycle owner for the new epoch", () => {
  const prior = executingState();
  const rebound = ensurePlanLifecycleOwner({
    lifecycle: prior,
    sessionKey,
    sessionEpoch: "session-owner-epoch-recreated",
    at: 90,
  });

  assert.notStrictEqual(rebound, prior);
  assert.equal(rebound.sessionKey, sessionKey);
  assert.equal(rebound.sessionEpoch, "session-owner-epoch-recreated");
  assert.equal(rebound.status, "empty");
  assert.equal(rebound.planTurnId, null);
  assert.equal(rebound.approvalLease, null);
  assert.equal(rebound.executionLease, null);
  assert.equal(rebound.execution, null);
  assert.equal(rebound.lastIssuedAttempt, 0);
});
