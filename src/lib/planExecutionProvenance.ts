import {
  isPlanApprovalLeaseBoundToState,
  type PlanLifecycleState,
} from "./planLifecycle";

export const PLAN_EXECUTION_PROVENANCE_SCHEMA_VERSION = 1 as const;

/** Immutable historical classification minted only after a Plan Run is admitted. */
export interface PlanExecutionRunProvenance {
  readonly schemaVersion: typeof PLAN_EXECUTION_PROVENANCE_SCHEMA_VERSION;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly planTurnId: string;
  readonly approvalLeaseId: string;
  readonly planRevision: number;
  readonly artifactHash: string;
  readonly executionLeaseId: string;
  readonly executionTurnId: string;
  readonly executionRunId: string;
  readonly parentRunId: string | null;
  readonly attempt: number;
  readonly instructionHash: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNonEmptyString(value: unknown): string | null | undefined {
  if (value == null) return null;
  return nonEmptyString(value) || undefined;
}

export function normalizePlanExecutionRunProvenance(
  value: unknown,
): PlanExecutionRunProvenance | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Number(record.schemaVersion) !== PLAN_EXECUTION_PROVENANCE_SCHEMA_VERSION) return null;
  const sessionKey = nonEmptyString(record.sessionKey);
  const sessionEpoch = nonEmptyString(record.sessionEpoch);
  const planTurnId = nonEmptyString(record.planTurnId);
  const approvalLeaseId = nonEmptyString(record.approvalLeaseId);
  const artifactHash = nonEmptyString(record.artifactHash);
  const executionLeaseId = nonEmptyString(record.executionLeaseId);
  const executionTurnId = nonEmptyString(record.executionTurnId);
  const executionRunId = nonEmptyString(record.executionRunId);
  const parentRunId = nullableNonEmptyString(record.parentRunId);
  const instructionHash = nonEmptyString(record.instructionHash);
  const attempt = Number(record.attempt);
  const planRevision = Number(record.planRevision);
  if (
    !sessionKey || !sessionEpoch || !planTurnId || !approvalLeaseId ||
    !artifactHash || !executionLeaseId || !executionTurnId || !executionRunId ||
    parentRunId === undefined || !instructionHash ||
    !Number.isInteger(attempt) || attempt < 1 ||
    !Number.isInteger(planRevision) || planRevision < 1 ||
    executionRunId === parentRunId
  ) return null;
  return Object.freeze({
    schemaVersion: PLAN_EXECUTION_PROVENANCE_SCHEMA_VERSION,
    sessionKey,
    sessionEpoch,
    planTurnId,
    approvalLeaseId,
    planRevision,
    artifactHash,
    executionLeaseId,
    executionTurnId,
    executionRunId,
    parentRunId,
    attempt,
    instructionHash,
  });
}

export function isPlanExecutionRunProvenanceForOwner(
  provenance: PlanExecutionRunProvenance | null | undefined,
  owner: {
    sessionKey: string;
    turnId: string;
    runId: string;
    parentRunId: string | null;
  },
): boolean {
  return !!provenance &&
    provenance.sessionKey === owner.sessionKey &&
    provenance.executionTurnId === owner.turnId &&
    provenance.executionRunId === owner.runId &&
    provenance.parentRunId === owner.parentRunId;
}

export function capturePlanExecutionRunProvenance(
  lifecycle: PlanLifecycleState | null | undefined,
): PlanExecutionRunProvenance | null {
  if (
    lifecycle?.status !== "executing" ||
    !lifecycle.planTurnId ||
    !lifecycle.artifactIdentity ||
    !lifecycle.approvalLease ||
    !lifecycle.executionLease ||
    !lifecycle.execution ||
    !isPlanApprovalLeaseBoundToState(lifecycle) ||
    lifecycle.lastIssuedAttempt !== lifecycle.executionLease.attempt ||
    lifecycle.execution.turnId !== lifecycle.executionLease.executionTurnId ||
    lifecycle.execution.runId !== lifecycle.executionLease.executionRunId ||
    lifecycle.execution.parentRunId !== lifecycle.executionLease.parentRunId ||
    lifecycle.execution.attempt !== lifecycle.executionLease.attempt
  ) return null;
  return normalizePlanExecutionRunProvenance({
    schemaVersion: PLAN_EXECUTION_PROVENANCE_SCHEMA_VERSION,
    sessionKey: lifecycle.sessionKey,
    sessionEpoch: lifecycle.sessionEpoch,
    planTurnId: lifecycle.planTurnId,
    approvalLeaseId: lifecycle.approvalLease.leaseId,
    planRevision: lifecycle.artifactIdentity.revision,
    artifactHash: lifecycle.artifactIdentity.artifactHash,
    executionLeaseId: lifecycle.executionLease.executionLeaseId,
    executionTurnId: lifecycle.execution.turnId,
    executionRunId: lifecycle.execution.runId,
    parentRunId: lifecycle.execution.parentRunId,
    attempt: lifecycle.execution.attempt,
    instructionHash: lifecycle.executionLease.instructionHash,
  });
}

/** Authorization may be paused, but its historical Run classification must remain exact. */
export function doesLifecycleRetainPlanExecutionProvenance(
  lifecycle: PlanLifecycleState | null | undefined,
  provenance: PlanExecutionRunProvenance | null | undefined,
): boolean {
  if (
    !provenance ||
    !lifecycle ||
    (lifecycle.status !== "executing" && lifecycle.status !== "paused") ||
    !lifecycle.artifactIdentity ||
    !lifecycle.approvalLease ||
    !lifecycle.executionLease ||
    !lifecycle.execution ||
    !isPlanApprovalLeaseBoundToState(lifecycle)
  ) return false;
  return lifecycle.sessionKey === provenance.sessionKey &&
    lifecycle.sessionEpoch === provenance.sessionEpoch &&
    lifecycle.planTurnId === provenance.planTurnId &&
    lifecycle.artifactIdentity.revision === provenance.planRevision &&
    lifecycle.artifactIdentity.artifactHash === provenance.artifactHash &&
    lifecycle.approvalLease.leaseId === provenance.approvalLeaseId &&
    lifecycle.executionLease.executionLeaseId === provenance.executionLeaseId &&
    lifecycle.executionLease.instructionHash === provenance.instructionHash &&
    lifecycle.executionLease.executionTurnId === provenance.executionTurnId &&
    lifecycle.executionLease.executionRunId === provenance.executionRunId &&
    lifecycle.executionLease.parentRunId === provenance.parentRunId &&
    lifecycle.executionLease.attempt === provenance.attempt &&
    lifecycle.lastIssuedAttempt === provenance.attempt &&
    lifecycle.execution.turnId === provenance.executionTurnId &&
    lifecycle.execution.runId === provenance.executionRunId &&
    lifecycle.execution.parentRunId === provenance.parentRunId &&
    lifecycle.execution.attempt === provenance.attempt;
}
