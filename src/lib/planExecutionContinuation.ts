import { buildPlanExecutionInstructionHash } from "./planApprovalIdentity";
import {
  PLAN_LIFECYCLE_SCHEMA_VERSION,
  isPlanApprovalLeaseBoundToState,
  isPlanLifecycleExecutionAuthorized,
  reducePlanLifecycle,
  type PlanLifecyclePause,
  type PlanLifecycleState,
} from "./planLifecycle";
import type { PlanApprovalHandoff } from "./sessionTypes";

export type PlanAutoResumeIssueResult =
  | Readonly<{
      ok: true;
      lifecycle: PlanLifecycleState;
      handoff: PlanApprovalHandoff;
    }>
  | Readonly<{
      ok: false;
      reason: string;
    }>;

export type PlanExplicitResumeIssueResult = PlanAutoResumeIssueResult;

/**
 * Atomically derives one bounded auto-resume attempt from the exact execution
 * that reached a checkpoint. The caller still has to CAS the returned state
 * into the Session; this function never dispatches a Run by itself.
 */
export function issuePlanAutoResumeAttempt(input: {
  lifecycle: PlanLifecycleState;
  instruction: string;
  checkpointHash: string;
  executionRunId: string;
  executionLeaseId: string;
  authorizationRequestId: string;
  issuedAt: number;
  pause: PlanLifecyclePause;
}): PlanAutoResumeIssueResult {
  const lifecycle = input.lifecycle;
  if (
    !isPlanLifecycleExecutionAuthorized(lifecycle) ||
    !lifecycle.approvalLease ||
    !lifecycle.executionLease ||
    !lifecycle.execution ||
    !lifecycle.planTurnId ||
    !lifecycle.artifactIdentity
  ) {
    return { ok: false, reason: "plan_execution_not_authorized" };
  }
  const requiredParts = [
    input.instruction,
    input.checkpointHash,
    input.executionRunId,
    input.executionLeaseId,
    input.authorizationRequestId,
  ];
  if (requiredParts.some((value) => !String(value || "").trim())) {
    return { ok: false, reason: "invalid_auto_resume_identity" };
  }
  const paused = reducePlanLifecycle(lifecycle, {
    type: "pause",
    expectedVersion: lifecycle.version,
    at: input.issuedAt,
    expectedExecutionLeaseId: lifecycle.executionLease.executionLeaseId,
    expectedExecution: lifecycle.execution,
    pause: input.pause,
  });
  if (paused.disposition === "rejected") {
    return { ok: false, reason: paused.reason || "plan_pause_rejected" };
  }

  const attempt = paused.state.lastIssuedAttempt + 1;
  const instructionHash = buildPlanExecutionInstructionHash(input.instruction);
  const executionLease = {
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    executionLeaseId: input.executionLeaseId,
    approvalLeaseId: lifecycle.approvalLease.leaseId,
    sessionKey: lifecycle.sessionKey,
    sessionEpoch: lifecycle.sessionEpoch,
    planTurnId: lifecycle.planTurnId,
    executionTurnId: lifecycle.execution.turnId,
    executionRunId: input.executionRunId,
    parentRunId: lifecycle.execution.runId,
    attempt,
    issuedAt: input.issuedAt,
    reason: "auto_resume" as const,
    instructionHash,
    authorization: {
      kind: "auto_resume_checkpoint" as const,
      sessionKey: lifecycle.sessionKey,
      sessionEpoch: lifecycle.sessionEpoch,
      turnId: lifecycle.execution.turnId,
      runId: lifecycle.execution.runId,
      requestId: input.authorizationRequestId,
      priorExecutionLeaseId: lifecycle.executionLease.executionLeaseId,
      checkpointHash: input.checkpointHash,
    },
  };
  const resumed = reducePlanLifecycle(paused.state, {
    type: "resume_execution",
    expectedVersion: paused.state.version,
    at: input.issuedAt,
    approvalLeaseId: lifecycle.approvalLease.leaseId,
    executionLease,
  });
  if (resumed.disposition === "rejected") {
    return { ok: false, reason: resumed.reason || "plan_auto_resume_rejected" };
  }

  return {
    ok: true,
    lifecycle: resumed.state,
    handoff: {
      planTurnId: lifecycle.planTurnId,
      requestedAt: input.issuedAt,
      approvalLeaseId: lifecycle.approvalLease.leaseId,
      executionLeaseId: executionLease.executionLeaseId,
      sessionEpoch: lifecycle.sessionEpoch,
      reviewRequestId: lifecycle.approvalLease.requestId,
      executionTurnId: executionLease.executionTurnId,
      executionRunId: executionLease.executionRunId,
      executionAttempt: executionLease.attempt,
      executionInstructionHash: instructionHash,
      prompt: input.instruction,
      planRevision: lifecycle.artifactIdentity.revision,
      artifactHash: lifecycle.artifactIdentity.artifactHash,
      artifactPaths: [...lifecycle.artifactIdentity.artifactPaths],
      parentRunId: executionLease.parentRunId,
    },
  };
}

/** Issue a child execution attempt from one exact structured action decision. */
export function issuePlanExplicitResumeAttempt(input: {
  lifecycle: PlanLifecycleState;
  instruction: string;
  executionRunId: string;
  executionLeaseId: string;
  authorization: {
    kind: "action_decision" | "workspace_turn";
    turnId: string;
    runId: string;
    requestId: string;
  };
  issuedAt: number;
}): PlanExplicitResumeIssueResult {
  const lifecycle = input.lifecycle;
  if (
    lifecycle.status !== "paused" ||
    !lifecycle.approvalLease ||
    !lifecycle.planTurnId ||
    !lifecycle.artifactIdentity ||
    !isPlanApprovalLeaseBoundToState(lifecycle)
  ) {
    return { ok: false, reason: "plan_execution_not_paused" };
  }
  const requiredParts = [
    input.instruction,
    input.executionRunId,
    input.executionLeaseId,
    input.authorization.turnId,
    input.authorization.runId,
    input.authorization.requestId,
  ];
  if (requiredParts.some((value) => !String(value || "").trim())) {
    return { ok: false, reason: "invalid_explicit_resume_identity" };
  }
  const attempt = lifecycle.lastIssuedAttempt + 1;
  const instructionHash = buildPlanExecutionInstructionHash(input.instruction);
  const parentRunId = lifecycle.execution?.runId || lifecycle.approvalLease.approvalRunId;
  const executionLease = {
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    executionLeaseId: input.executionLeaseId,
    approvalLeaseId: lifecycle.approvalLease.leaseId,
    sessionKey: lifecycle.sessionKey,
    sessionEpoch: lifecycle.sessionEpoch,
    planTurnId: lifecycle.planTurnId,
    executionTurnId: input.authorization.turnId,
    executionRunId: input.executionRunId,
    parentRunId,
    attempt,
    issuedAt: input.issuedAt,
    reason: "explicit_resume" as const,
    instructionHash,
    authorization: {
      kind: input.authorization.kind,
      sessionKey: lifecycle.sessionKey,
      sessionEpoch: lifecycle.sessionEpoch,
      turnId: input.authorization.turnId,
      runId: input.authorization.runId,
      requestId: input.authorization.requestId,
    },
  };
  const resumed = reducePlanLifecycle(lifecycle, {
    type: "resume_execution",
    expectedVersion: lifecycle.version,
    at: input.issuedAt,
    approvalLeaseId: lifecycle.approvalLease.leaseId,
    executionLease,
  });
  if (resumed.disposition === "rejected") {
    return { ok: false, reason: resumed.reason || "plan_explicit_resume_rejected" };
  }
  return {
    ok: true,
    lifecycle: resumed.state,
    handoff: {
      planTurnId: lifecycle.planTurnId,
      requestedAt: input.issuedAt,
      approvalLeaseId: lifecycle.approvalLease.leaseId,
      executionLeaseId: executionLease.executionLeaseId,
      sessionEpoch: lifecycle.sessionEpoch,
      reviewRequestId: lifecycle.approvalLease.requestId,
      executionTurnId: executionLease.executionTurnId,
      executionRunId: executionLease.executionRunId,
      executionAttempt: executionLease.attempt,
      executionInstructionHash: instructionHash,
      prompt: input.instruction,
      planRevision: lifecycle.artifactIdentity.revision,
      artifactHash: lifecycle.artifactIdentity.artifactHash,
      artifactPaths: [...lifecycle.artifactIdentity.artifactPaths],
      parentRunId: executionLease.parentRunId,
    },
  };
}
