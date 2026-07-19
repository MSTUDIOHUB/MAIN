import { canonicalizePlanArtifactPath } from "./workflowModels";
import type {
  NormalizedStreamState,
  PlanArtifact,
  PlanExecutionEvidenceEntry,
  PlanExecutionProgressSnapshot,
  PlanStage,
  PlanTask,
} from "./workflowModels";

export interface ClosedActivePlanRuntimePatch {
  isPlanApproved: false;
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planExecutionEvidenceLedger: PlanExecutionEvidenceEntry[];
  planExecutionEvidenceCount: 0;
  planAutoResumeCount: 0;
  planExecutionProgressSnapshot: PlanExecutionProgressSnapshot | null;
  planStage: PlanStage;
  showPlanPanel: false;
  normalizedStreamState?: NormalizedStreamState;
}

export function buildClosedActivePlanRuntimePatch(): ClosedActivePlanRuntimePatch {
  return {
    isPlanApproved: false,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: null,
    planStage: "idle",
    showPlanPanel: false,
  };
}

export const PLAN_LIFECYCLE_SCHEMA_VERSION = 2 as const;

/**
 * Plan owns workflow progress only. A Run or Turn can conclude with an error
 * result while the durable Plan remains paused and resumable.
 */
export const PLAN_LIFECYCLE_STATUSES = Object.freeze([
  "empty",
  "drafting",
  "awaiting_approval",
  "handoff_pending",
  "executing",
  "paused",
  "completed",
] as const);

export type PlanLifecycleStatus = (typeof PLAN_LIFECYCLE_STATUSES)[number];

export interface PlanArtifactIdentity {
  readonly revision: number;
  readonly artifactHash: string;
  readonly artifactPaths: readonly string[];
}

export interface PlanReviewIdentity {
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly turnId: string;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly requestId: string;
  readonly planRevision: number;
  readonly artifactHash: string;
  readonly artifactPaths: readonly string[];
}

export type PlanApprovalDecisionKind = "action_decision" | "workspace_turn";

export interface PlanApprovalDecisionIdentity {
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly turnId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly kind: PlanApprovalDecisionKind;
}

/**
 * Immutable capability minted by one exact review decision. It is deliberately
 * narrower than a persisted "approved" flag: a different Session generation,
 * review request, artifact revision, or execution owner cannot reuse it.
 */
export interface PlanApprovalLease {
  readonly schemaVersion: typeof PLAN_LIFECYCLE_SCHEMA_VERSION;
  readonly leaseId: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly planTurnId: string;
  readonly reviewRunId: string;
  readonly requestId: string;
  readonly planRevision: number;
  readonly artifactHash: string;
  readonly artifactPaths: readonly string[];
  readonly approvedAt: number;
  /** Turn that carried the approval decision; it may differ from planTurnId. */
  readonly approvalTurnId: string;
  readonly approvalRunId: string;
  readonly approvalDecisionKind: PlanApprovalDecisionKind;
}

export type PlanExecutionLeaseReason = "initial_approval" | "explicit_resume" | "auto_resume";

export type PlanExecutionAuthorization =
  | Readonly<{
      kind: "action_decision" | "workspace_turn";
      sessionKey: string;
      sessionEpoch: string;
      turnId: string;
      runId: string;
      requestId: string;
    }>
  | Readonly<{
      kind: "auto_resume_checkpoint";
      sessionKey: string;
      sessionEpoch: string;
      turnId: string;
      runId: string;
      requestId: string;
      priorExecutionLeaseId: string;
      checkpointHash: string;
    }>;

/** One immutable, single-Run execution attempt authorized by an approval lease. */
export interface PlanExecutionLease {
  readonly schemaVersion: typeof PLAN_LIFECYCLE_SCHEMA_VERSION;
  readonly executionLeaseId: string;
  readonly approvalLeaseId: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly planTurnId: string;
  readonly executionTurnId: string;
  readonly executionRunId: string;
  readonly parentRunId: string | null;
  /** Monotonic within one approval lease; authorization never depends on wall clock order. */
  readonly attempt: number;
  readonly issuedAt: number;
  readonly reason: PlanExecutionLeaseReason;
  readonly instructionHash: string;
  /** Exact user decision or bounded runtime checkpoint that issued this attempt. */
  readonly authorization: PlanExecutionAuthorization;
}

export interface PlanLifecycleExecutionOwner {
  readonly turnId: string;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly attempt: number;
  readonly startedAt: number;
}

export type PlanLifecyclePauseResultKind = "partial" | "blocked" | "error";

export interface PlanLifecyclePause {
  readonly reason: string;
  readonly resultKind: PlanLifecyclePauseResultKind;
  readonly resumeCondition: string;
}

export interface PlanLifecycleState {
  readonly schemaVersion: typeof PLAN_LIFECYCLE_SCHEMA_VERSION;
  /** Monotonic compare-and-swap revision for this Session-owned Plan. */
  readonly version: number;
  readonly status: PlanLifecycleStatus;
  readonly sessionKey: string;
  /** Opaque owner generation; reusing a Session key must mint a new value. */
  readonly sessionEpoch: string;
  readonly planTurnId: string | null;
  readonly artifactIdentity: PlanArtifactIdentity | null;
  readonly reviewIdentity: PlanReviewIdentity | null;
  readonly approvalLease: PlanApprovalLease | null;
  readonly executionLease: PlanExecutionLease | null;
  /** Monotonic issuance counter; unlike execution, this includes attempts that never started. */
  readonly lastIssuedAttempt: number;
  /** Last attempt that actually crossed run.started; never points at a reserved ghost Run. */
  readonly execution: PlanLifecycleExecutionOwner | null;
  readonly pause: PlanLifecyclePause | null;
  readonly updatedAt: number;
}

interface PlanLifecycleCommandBase {
  readonly expectedVersion: number;
  /** Explicit event time keeps the reducer deterministic and replayable. */
  readonly at: number;
}

export type PlanLifecycleCommand =
  | (PlanLifecycleCommandBase & {
      readonly type: "hydrate_discovery";
      readonly planTurnId?: string | null;
      readonly artifactIdentity: PlanArtifactIdentity | null;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "start_drafting";
      readonly planTurnId: string;
      readonly artifactIdentity?: PlanArtifactIdentity | null;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "request_review";
      readonly artifactIdentity: PlanArtifactIdentity;
      readonly reviewIdentity: PlanReviewIdentity;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "approve";
      readonly expectedReviewIdentity: PlanReviewIdentity;
      readonly decisionIdentity: PlanApprovalDecisionIdentity;
      readonly lease: PlanApprovalLease;
      readonly executionLease: PlanExecutionLease;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "execution_started";
      readonly executionLeaseId: string;
      readonly instructionHash: string;
      readonly execution: PlanLifecycleExecutionOwner;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "resume_execution";
      readonly approvalLeaseId: string;
      readonly executionLease: PlanExecutionLease;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "pause";
      readonly pause: PlanLifecyclePause;
      readonly expectedExecutionLeaseId?: string;
      readonly expectedExecution?: PlanLifecycleExecutionOwner;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "complete";
      readonly expectedExecutionLeaseId: string;
      readonly expectedExecution: PlanLifecycleExecutionOwner;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "artifact_changed";
      readonly artifactIdentity: PlanArtifactIdentity | null;
    })
  | (PlanLifecycleCommandBase & {
      readonly type: "reset";
    });

export type PlanLifecycleTransitionDisposition = "applied" | "idempotent" | "rejected";

export type PlanLifecycleTransitionRejection =
  | "version_conflict"
  | "invalid_command_time"
  | "invalid_plan_turn"
  | "invalid_artifact_identity"
  | "invalid_review_identity"
  | "invalid_approval_lease"
  | "invalid_execution_lease"
  | "invalid_execution_owner"
  | "invalid_pause"
  | "transition_not_allowed"
  | "review_identity_mismatch"
  | "approval_lease_mismatch"
  | "approval_decision_mismatch"
  | "instruction_hash_mismatch"
  | "attempt_mismatch"
  | "execution_owner_mismatch"
  | "unknown_command";

export interface PlanLifecycleTransitionResult {
  readonly state: PlanLifecycleState;
  readonly disposition: PlanLifecycleTransitionDisposition;
  readonly reason?: PlanLifecycleTransitionRejection;
}

export interface CreatePlanLifecycleStateInput {
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly updatedAt?: number;
}

/** Mint a new opaque owner generation whenever a Session key is rebound. */
export function createPlanLifecycleSessionEpoch(now = Date.now()): string {
  const nonce = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  return `plan-session-${now}-${nonce}`;
}

export interface LegacyPlanLifecycleSnapshot {
  readonly version?: number;
  readonly status?: string | null;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly planTurnId?: string | null;
  readonly artifactIdentity?: PlanArtifactIdentity | null;
  readonly reviewIdentity?: PlanReviewIdentity | null;
  readonly approvalLease?: PlanApprovalLease | null;
  readonly executionLease?: PlanExecutionLease | null;
  readonly lastIssuedAttempt?: number;
  readonly execution?: PlanLifecycleExecutionOwner | null;
  readonly isPlanApproved?: boolean;
  readonly planStage?: string | null;
  readonly updatedAt?: number;
}

function isRequiredIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isValidEventTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function canonicalizeArtifactPaths(paths: readonly string[]): readonly string[] | null {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const canonicalPaths = [...new Set(paths.map((path) => canonicalizePlanArtifactPath(path)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return canonicalPaths.length > 0 ? Object.freeze(canonicalPaths) : null;
}

function normalizeArtifactIdentity(identity: PlanArtifactIdentity): PlanArtifactIdentity | null {
  if (!identity || !isValidRevision(identity.revision) || !isRequiredIdentityPart(identity.artifactHash)) {
    return null;
  }
  const artifactPaths = canonicalizeArtifactPaths(identity.artifactPaths);
  if (!artifactPaths) return null;
  return Object.freeze({
    revision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths,
  });
}

function normalizeReviewIdentity(identity: PlanReviewIdentity): PlanReviewIdentity | null {
  if (
    !identity ||
    !isRequiredIdentityPart(identity.sessionKey) ||
    !isRequiredIdentityPart(identity.sessionEpoch) ||
    !isRequiredIdentityPart(identity.turnId) ||
    !isRequiredIdentityPart(identity.runId) ||
    (identity.parentRunId !== null && !isRequiredIdentityPart(identity.parentRunId)) ||
    !isRequiredIdentityPart(identity.requestId) ||
    !isValidRevision(identity.planRevision) ||
    !isRequiredIdentityPart(identity.artifactHash)
  ) {
    return null;
  }
  const artifactPaths = canonicalizeArtifactPaths(identity.artifactPaths);
  if (!artifactPaths) return null;
  return Object.freeze({
    sessionKey: identity.sessionKey,
    sessionEpoch: identity.sessionEpoch,
    turnId: identity.turnId,
    runId: identity.runId,
    parentRunId: identity.parentRunId,
    requestId: identity.requestId,
    planRevision: identity.planRevision,
    artifactHash: identity.artifactHash,
    artifactPaths,
  });
}

function normalizeApprovalDecisionIdentity(
  identity: PlanApprovalDecisionIdentity,
): PlanApprovalDecisionIdentity | null {
  if (
    !identity ||
    !isRequiredIdentityPart(identity.sessionKey) ||
    !isRequiredIdentityPart(identity.sessionEpoch) ||
    !isRequiredIdentityPart(identity.turnId) ||
    !isRequiredIdentityPart(identity.runId) ||
    !isRequiredIdentityPart(identity.requestId) ||
    (identity.kind !== "action_decision" && identity.kind !== "workspace_turn")
  ) {
    return null;
  }
  return Object.freeze({ ...identity });
}

function normalizeApprovalLease(lease: PlanApprovalLease): PlanApprovalLease | null {
  if (
    !lease ||
    lease.schemaVersion !== PLAN_LIFECYCLE_SCHEMA_VERSION ||
    !isRequiredIdentityPart(lease.leaseId) ||
    !isRequiredIdentityPart(lease.sessionKey) ||
    !isRequiredIdentityPart(lease.sessionEpoch) ||
    !isRequiredIdentityPart(lease.planTurnId) ||
    !isRequiredIdentityPart(lease.reviewRunId) ||
    !isRequiredIdentityPart(lease.requestId) ||
    !isValidRevision(lease.planRevision) ||
    !isRequiredIdentityPart(lease.artifactHash) ||
    !isValidEventTime(lease.approvedAt) ||
    !isRequiredIdentityPart(lease.approvalTurnId) ||
    !isRequiredIdentityPart(lease.approvalRunId) ||
    (
      lease.approvalDecisionKind !== "action_decision" &&
      lease.approvalDecisionKind !== "workspace_turn"
    )
  ) {
    return null;
  }
  const artifactPaths = canonicalizeArtifactPaths(lease.artifactPaths);
  if (!artifactPaths) return null;
  return Object.freeze({
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    leaseId: lease.leaseId,
    sessionKey: lease.sessionKey,
    sessionEpoch: lease.sessionEpoch,
    planTurnId: lease.planTurnId,
    reviewRunId: lease.reviewRunId,
    requestId: lease.requestId,
    planRevision: lease.planRevision,
    artifactHash: lease.artifactHash,
    artifactPaths,
    approvedAt: lease.approvedAt,
    approvalTurnId: lease.approvalTurnId,
    approvalRunId: lease.approvalRunId,
    approvalDecisionKind: lease.approvalDecisionKind,
  });
}

function normalizeExecutionAuthorization(
  authorization: PlanExecutionAuthorization,
): PlanExecutionAuthorization | null {
  if (
    !authorization ||
    !isRequiredIdentityPart(authorization.sessionKey) ||
    !isRequiredIdentityPart(authorization.sessionEpoch) ||
    !isRequiredIdentityPart(authorization.turnId) ||
    !isRequiredIdentityPart(authorization.runId) ||
    !isRequiredIdentityPart(authorization.requestId)
  ) {
    return null;
  }
  if (authorization.kind === "action_decision" || authorization.kind === "workspace_turn") {
    return Object.freeze({ ...authorization });
  }
  if (
    authorization.kind !== "auto_resume_checkpoint" ||
    !isRequiredIdentityPart(authorization.priorExecutionLeaseId) ||
    !isRequiredIdentityPart(authorization.checkpointHash)
  ) {
    return null;
  }
  return Object.freeze({ ...authorization });
}

function normalizeExecutionLease(lease: PlanExecutionLease): PlanExecutionLease | null {
  const authorization = lease
    ? normalizeExecutionAuthorization(lease.authorization)
    : null;
  if (
    !lease ||
    lease.schemaVersion !== PLAN_LIFECYCLE_SCHEMA_VERSION ||
    !isRequiredIdentityPart(lease.executionLeaseId) ||
    !isRequiredIdentityPart(lease.approvalLeaseId) ||
    !isRequiredIdentityPart(lease.sessionKey) ||
    !isRequiredIdentityPart(lease.sessionEpoch) ||
    !isRequiredIdentityPart(lease.planTurnId) ||
    !isRequiredIdentityPart(lease.executionTurnId) ||
    !isRequiredIdentityPart(lease.executionRunId) ||
    (lease.parentRunId !== null && !isRequiredIdentityPart(lease.parentRunId)) ||
    !Number.isInteger(lease.attempt) ||
    lease.attempt < 1 ||
    !isValidEventTime(lease.issuedAt) ||
    !isRequiredIdentityPart(lease.instructionHash) ||
    !authorization ||
    (
      lease.reason !== "initial_approval" &&
      lease.reason !== "explicit_resume" &&
      lease.reason !== "auto_resume"
    )
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    executionLeaseId: lease.executionLeaseId,
    approvalLeaseId: lease.approvalLeaseId,
    sessionKey: lease.sessionKey,
    sessionEpoch: lease.sessionEpoch,
    planTurnId: lease.planTurnId,
    executionTurnId: lease.executionTurnId,
    executionRunId: lease.executionRunId,
    parentRunId: lease.parentRunId,
    attempt: lease.attempt,
    issuedAt: lease.issuedAt,
    reason: lease.reason,
    instructionHash: lease.instructionHash,
    authorization,
  });
}

function normalizeExecutionOwner(
  execution: PlanLifecycleExecutionOwner,
): PlanLifecycleExecutionOwner | null {
  if (
    !execution ||
    !isRequiredIdentityPart(execution.turnId) ||
    !isRequiredIdentityPart(execution.runId) ||
    (execution.parentRunId !== null && !isRequiredIdentityPart(execution.parentRunId)) ||
    !Number.isInteger(execution.attempt) ||
    execution.attempt < 1 ||
    !isValidEventTime(execution.startedAt)
  ) {
    return null;
  }
  return Object.freeze({
    turnId: execution.turnId,
    runId: execution.runId,
    parentRunId: execution.parentRunId,
    attempt: execution.attempt,
    startedAt: execution.startedAt,
  });
}

function normalizePause(pause: PlanLifecyclePause): PlanLifecyclePause | null {
  if (
    !pause ||
    !isRequiredIdentityPart(pause.reason) ||
    !isRequiredIdentityPart(pause.resumeCondition) ||
    (pause.resultKind !== "partial" && pause.resultKind !== "blocked" && pause.resultKind !== "error")
  ) {
    return null;
  }
  return Object.freeze({
    reason: pause.reason,
    resultKind: pause.resultKind,
    resumeCondition: pause.resumeCondition,
  });
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

export function arePlanArtifactIdentitiesEqual(
  left: PlanArtifactIdentity | null,
  right: PlanArtifactIdentity | null,
): boolean {
  if (!left || !right) return left === right;
  const normalizedLeft = normalizeArtifactIdentity(left);
  const normalizedRight = normalizeArtifactIdentity(right);
  return !!normalizedLeft && !!normalizedRight &&
    normalizedLeft.revision === normalizedRight.revision &&
    normalizedLeft.artifactHash === normalizedRight.artifactHash &&
    pathsEqual(normalizedLeft.artifactPaths, normalizedRight.artifactPaths);
}

function reviewIdentitiesEqual(left: PlanReviewIdentity, right: PlanReviewIdentity): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.requestId === right.requestId &&
    left.planRevision === right.planRevision &&
    left.artifactHash === right.artifactHash &&
    pathsEqual(left.artifactPaths, right.artifactPaths);
}

function executionAuthorizationsEqual(
  left: PlanExecutionAuthorization,
  right: PlanExecutionAuthorization,
): boolean {
  if (
    left.kind !== right.kind ||
    left.sessionKey !== right.sessionKey ||
    left.sessionEpoch !== right.sessionEpoch ||
    left.turnId !== right.turnId ||
    left.runId !== right.runId ||
    left.requestId !== right.requestId
  ) {
    return false;
  }
  if (left.kind !== "auto_resume_checkpoint" || right.kind !== "auto_resume_checkpoint") {
    return true;
  }
  return left.priorExecutionLeaseId === right.priorExecutionLeaseId &&
    left.checkpointHash === right.checkpointHash;
}

function leasesEqual(left: PlanApprovalLease, right: PlanApprovalLease): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.leaseId === right.leaseId &&
    left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.planTurnId === right.planTurnId &&
    left.reviewRunId === right.reviewRunId &&
    left.requestId === right.requestId &&
    left.planRevision === right.planRevision &&
    left.artifactHash === right.artifactHash &&
    pathsEqual(left.artifactPaths, right.artifactPaths) &&
    left.approvedAt === right.approvedAt &&
    left.approvalTurnId === right.approvalTurnId &&
    left.approvalRunId === right.approvalRunId &&
    left.approvalDecisionKind === right.approvalDecisionKind;
}

function executionLeasesEqual(left: PlanExecutionLease, right: PlanExecutionLease): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.executionLeaseId === right.executionLeaseId &&
    left.approvalLeaseId === right.approvalLeaseId &&
    left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.planTurnId === right.planTurnId &&
    left.executionTurnId === right.executionTurnId &&
    left.executionRunId === right.executionRunId &&
    left.parentRunId === right.parentRunId &&
    left.attempt === right.attempt &&
    left.issuedAt === right.issuedAt &&
    left.reason === right.reason &&
    left.instructionHash === right.instructionHash &&
    executionAuthorizationsEqual(left.authorization, right.authorization);
}

function executionOwnersEqual(
  left: PlanLifecycleExecutionOwner,
  right: PlanLifecycleExecutionOwner,
): boolean {
  return left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attempt === right.attempt &&
    left.startedAt === right.startedAt;
}

function pausesEqual(left: PlanLifecyclePause, right: PlanLifecyclePause): boolean {
  return left.reason === right.reason &&
    left.resultKind === right.resultKind &&
    left.resumeCondition === right.resumeCondition;
}

function artifactMatchesReview(
  artifactIdentity: PlanArtifactIdentity,
  reviewIdentity: PlanReviewIdentity,
): boolean {
  return artifactIdentity.revision === reviewIdentity.planRevision &&
    artifactIdentity.artifactHash === reviewIdentity.artifactHash &&
    pathsEqual(artifactIdentity.artifactPaths, reviewIdentity.artifactPaths);
}

function leaseMatchesReviewAndArtifact(input: {
  state: Pick<PlanLifecycleState, "sessionKey" | "sessionEpoch" | "planTurnId">;
  artifactIdentity: PlanArtifactIdentity;
  reviewIdentity: PlanReviewIdentity;
  lease: PlanApprovalLease;
}): boolean {
  const { state, artifactIdentity, reviewIdentity, lease } = input;
  return reviewIdentity.sessionKey === state.sessionKey &&
    reviewIdentity.sessionEpoch === state.sessionEpoch &&
    reviewIdentity.turnId === state.planTurnId &&
    artifactMatchesReview(artifactIdentity, reviewIdentity) &&
    lease.sessionKey === state.sessionKey &&
    lease.sessionEpoch === state.sessionEpoch &&
    lease.planTurnId === reviewIdentity.turnId &&
    lease.reviewRunId === reviewIdentity.runId &&
    lease.requestId === reviewIdentity.requestId &&
    lease.planRevision === artifactIdentity.revision &&
    lease.artifactHash === artifactIdentity.artifactHash &&
    pathsEqual(lease.artifactPaths, artifactIdentity.artifactPaths);
}

function approvalDecisionMatchesLease(input: {
  state: Pick<PlanLifecycleState, "sessionKey" | "sessionEpoch">;
  reviewIdentity: PlanReviewIdentity;
  decisionIdentity: PlanApprovalDecisionIdentity;
  lease: PlanApprovalLease;
}): boolean {
  const { state, reviewIdentity, decisionIdentity, lease } = input;
  const commonIdentityMatches = decisionIdentity.sessionKey === state.sessionKey &&
    decisionIdentity.sessionEpoch === state.sessionEpoch &&
    decisionIdentity.requestId === reviewIdentity.requestId &&
    lease.approvalTurnId === decisionIdentity.turnId &&
    lease.approvalRunId === decisionIdentity.runId &&
    lease.approvalDecisionKind === decisionIdentity.kind;
  if (!commonIdentityMatches) return false;
  return decisionIdentity.kind === "workspace_turn" || (
    decisionIdentity.turnId === reviewIdentity.turnId &&
    decisionIdentity.runId === reviewIdentity.runId
  );
}

function executionAuthorizationMatchesOwner(
  state: Pick<PlanLifecycleState, "sessionKey" | "sessionEpoch">,
  authorization: PlanExecutionAuthorization,
): boolean {
  return authorization.sessionKey === state.sessionKey &&
    authorization.sessionEpoch === state.sessionEpoch;
}

function initialExecutionAuthorizationMatchesDecision(
  executionLease: PlanExecutionLease,
  decisionIdentity: PlanApprovalDecisionIdentity,
): boolean {
  const authorization = executionLease.authorization;
  return authorization.kind === decisionIdentity.kind &&
    authorization.sessionKey === decisionIdentity.sessionKey &&
    authorization.sessionEpoch === decisionIdentity.sessionEpoch &&
    authorization.turnId === decisionIdentity.turnId &&
    authorization.runId === decisionIdentity.runId &&
    authorization.requestId === decisionIdentity.requestId;
}

function executionLeaseMatchesApproval(input: {
  state: Pick<PlanLifecycleState, "sessionKey" | "sessionEpoch" | "planTurnId" | "executionLease" | "execution">;
  approvalLease: PlanApprovalLease;
  executionLease: PlanExecutionLease;
  expectedParentRunId: string;
  expectedAttempt: number;
  reason: PlanExecutionLeaseReason;
}): boolean {
  const { state, approvalLease, executionLease } = input;
  return executionLease.approvalLeaseId === approvalLease.leaseId &&
    executionLease.sessionKey === state.sessionKey &&
    executionLease.sessionEpoch === state.sessionEpoch &&
    executionLease.planTurnId === state.planTurnId &&
    executionLease.parentRunId === input.expectedParentRunId &&
    executionLease.attempt === input.expectedAttempt &&
    executionLease.reason === input.reason;
}

function executionLeaseIsBoundToApproval(input: {
  state: Pick<PlanLifecycleState, "sessionKey" | "sessionEpoch" | "planTurnId">;
  approvalLease: PlanApprovalLease;
  executionLease: PlanExecutionLease;
}): boolean {
  return input.executionLease.approvalLeaseId === input.approvalLease.leaseId &&
    input.executionLease.sessionKey === input.state.sessionKey &&
    input.executionLease.sessionEpoch === input.state.sessionEpoch &&
    input.executionLease.planTurnId === input.state.planTurnId &&
    executionAuthorizationMatchesOwner(input.state, input.executionLease.authorization) &&
    input.executionLease.attempt >= 1;
}

function resumeAuthorizationMatchesState(input: {
  state: PlanLifecycleState;
  executionLease: PlanExecutionLease;
}): boolean {
  const { state, executionLease } = input;
  const authorization = executionLease.authorization;
  if (!executionAuthorizationMatchesOwner(state, authorization)) return false;
  if (executionLease.reason === "explicit_resume") {
    if (
      (authorization.kind !== "action_decision" && authorization.kind !== "workspace_turn") ||
      authorization.requestId === state.approvalLease?.requestId ||
      executionLease.executionTurnId !== authorization.turnId
    ) return false;
    // A structured action resolves the exact paused Run it is attached to.
    // Natural-language workspace resume is admitted as its own decision Turn
    // and therefore has a distinct authorization Run identity.
    if (authorization.kind === "workspace_turn") return true;
    const priorActionOwner = state.execution
      ? {
          turnId: state.execution.turnId,
          runId: state.execution.runId,
        }
      : state.approvalLease
      ? {
          // An attempt that never crossed run.started has no execution owner.
          // Its approval decision remains the only durable action boundary;
          // the reserved ghost Run must never become the next parent.
          turnId: state.approvalLease.approvalTurnId,
          runId: state.approvalLease.approvalRunId,
        }
      : null;
    return !!priorActionOwner &&
      authorization.turnId === priorActionOwner.turnId &&
      authorization.runId === priorActionOwner.runId;
  }
  if (executionLease.reason !== "auto_resume" || authorization.kind !== "auto_resume_checkpoint") {
    return false;
  }
  return !!state.execution && !!state.executionLease &&
    authorization.turnId === state.execution.turnId &&
    authorization.runId === state.execution.runId &&
    authorization.priorExecutionLeaseId === state.executionLease.executionLeaseId &&
    executionLease.executionTurnId === state.execution.turnId;
}

export function isPlanApprovalLeaseBoundToState(state: PlanLifecycleState): boolean {
  return !!state.artifactIdentity && !!state.reviewIdentity && !!state.approvalLease &&
    leaseMatchesReviewAndArtifact({
      state,
      artifactIdentity: state.artifactIdentity,
      reviewIdentity: state.reviewIdentity,
      lease: state.approvalLease,
    });
}

export function isPlanLifecycleExecutionAuthorized(state: PlanLifecycleState): boolean {
  if (
    state.status !== "executing" ||
    !state.execution ||
    !state.approvalLease ||
    !state.executionLease
  ) return false;
  return isPlanApprovalLeaseBoundToState(state) &&
    executionLeaseIsBoundToApproval({
      state,
      approvalLease: state.approvalLease,
      executionLease: state.executionLease,
    }) &&
    state.lastIssuedAttempt === state.executionLease.attempt &&
    state.execution.turnId === state.executionLease.executionTurnId &&
    state.execution.runId === state.executionLease.executionRunId &&
    state.execution.parentRunId === state.executionLease.parentRunId &&
    state.execution.attempt === state.executionLease.attempt;
}

export function isPlanLifecycleExecutionAuthorizedForRun(
  state: PlanLifecycleState,
  input: {
    executionLeaseId: string;
    turnId: string;
    runId: string;
    parentRunId: string | null;
    attempt: number;
  },
): boolean {
  return isPlanLifecycleExecutionAuthorized(state) &&
    state.executionLease?.executionLeaseId === input.executionLeaseId &&
    state.execution?.turnId === input.turnId &&
    state.execution.runId === input.runId &&
    state.execution.parentRunId === input.parentRunId &&
    state.execution.attempt === input.attempt;
}

function terminalExecutionExpectationMatches(
  state: PlanLifecycleState,
  executionLeaseId: string | undefined,
  execution: PlanLifecycleExecutionOwner | undefined,
): boolean {
  return !!executionLeaseId && !!execution &&
    state.executionLease?.executionLeaseId === executionLeaseId &&
    !!state.execution && executionOwnersEqual(state.execution, execution);
}

function freezeState(state: PlanLifecycleState): PlanLifecycleState {
  return Object.freeze(state);
}

export function createPlanLifecycleState(input: CreatePlanLifecycleStateInput): PlanLifecycleState {
  if (!isRequiredIdentityPart(input.sessionKey) || !isRequiredIdentityPart(input.sessionEpoch)) {
    throw new Error("Plan lifecycle requires an exact Session key and owner epoch.");
  }
  const updatedAt = input.updatedAt ?? 0;
  if (!isValidEventTime(updatedAt)) {
    throw new Error("Plan lifecycle requires a finite non-negative update time.");
  }
  return freezeState({
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    version: 0,
    status: "empty",
    sessionKey: input.sessionKey,
    sessionEpoch: input.sessionEpoch,
    planTurnId: null,
    artifactIdentity: null,
    reviewIdentity: null,
    approvalLease: null,
    executionLease: null,
    lastIssuedAttempt: 0,
    execution: null,
    pause: null,
    updatedAt,
  });
}

export function ensurePlanLifecycleOwner(input: {
  lifecycle: PlanLifecycleState | null | undefined;
  sessionKey: string;
  sessionEpoch?: string;
  at: number;
}): PlanLifecycleState {
  if (
    input.lifecycle?.sessionKey === input.sessionKey &&
    (!input.sessionEpoch || input.lifecycle.sessionEpoch === input.sessionEpoch)
  ) return input.lifecycle;
  return createPlanLifecycleState({
    sessionKey: input.sessionKey,
    sessionEpoch: input.sessionEpoch || createPlanLifecycleSessionEpoch(input.at),
    updatedAt: input.at,
  });
}

function rejected(
  state: PlanLifecycleState,
  reason: PlanLifecycleTransitionRejection,
): PlanLifecycleTransitionResult {
  return Object.freeze({ state, disposition: "rejected", reason });
}

function idempotent(state: PlanLifecycleState): PlanLifecycleTransitionResult {
  return Object.freeze({ state, disposition: "idempotent" });
}

function applied(
  state: PlanLifecycleState,
  at: number,
  patch: Partial<PlanLifecycleState>,
): PlanLifecycleTransitionResult {
  const nextState = freezeState({
    ...state,
    ...patch,
    schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
    version: state.version + 1,
    updatedAt: at,
  });
  return Object.freeze({ state: nextState, disposition: "applied" });
}

function isExactApproveRetry(
  state: PlanLifecycleState,
  expectedReviewIdentity: PlanReviewIdentity,
  decisionIdentity: PlanApprovalDecisionIdentity,
  lease: PlanApprovalLease,
  executionLease: PlanExecutionLease,
): boolean {
  return !!state.reviewIdentity && !!state.approvalLease && !!state.executionLease &&
    reviewIdentitiesEqual(state.reviewIdentity, expectedReviewIdentity) &&
    approvalDecisionMatchesLease({
      state,
      reviewIdentity: state.reviewIdentity,
      decisionIdentity,
      lease,
    }) &&
    leasesEqual(state.approvalLease, lease) &&
    executionLeasesEqual(state.executionLease, executionLease);
}

function requiresFreshReviewAfterArtifactChange(state: PlanLifecycleState): boolean {
  return state.approvalLease !== null ||
    state.status === "handoff_pending" ||
    state.status === "executing" ||
    (state.status === "paused" && (
      state.pause?.reason === "artifact_identity_changed" ||
      state.pause?.reason === "legacy_approval_unverifiable" ||
      state.pause?.reason === "legacy_execution_requires_resume"
    ));
}

/** Pure, deterministic lifecycle transition. No command may bypass its CAS. */
export function reducePlanLifecycle(
  state: PlanLifecycleState,
  command: PlanLifecycleCommand,
): PlanLifecycleTransitionResult {
  if (!isValidEventTime(command.at)) return rejected(state, "invalid_command_time");

  if (command.type === "approve") {
    const normalizedReview = normalizeReviewIdentity(command.expectedReviewIdentity);
    const normalizedDecision = normalizeApprovalDecisionIdentity(command.decisionIdentity);
    const normalizedLease = normalizeApprovalLease(command.lease);
    const normalizedExecutionLease = normalizeExecutionLease(command.executionLease);
    if (
      normalizedReview &&
      normalizedDecision &&
      normalizedLease &&
      normalizedExecutionLease &&
      isExactApproveRetry(
        state,
        normalizedReview,
        normalizedDecision,
        normalizedLease,
        normalizedExecutionLease,
      )
    ) {
      return idempotent(state);
    }
  }
  if (command.type === "request_review") {
    const normalizedArtifact = normalizeArtifactIdentity(command.artifactIdentity);
    const normalizedReview = normalizeReviewIdentity(command.reviewIdentity);
    if (
      state.status === "awaiting_approval" &&
      normalizedArtifact &&
      normalizedReview &&
      !!state.artifactIdentity &&
      !!state.reviewIdentity &&
      arePlanArtifactIdentitiesEqual(state.artifactIdentity, normalizedArtifact) &&
      reviewIdentitiesEqual(state.reviewIdentity, normalizedReview)
    ) {
      return idempotent(state);
    }
  }
  if (command.type === "execution_started") {
    const normalizedExecution = normalizeExecutionOwner(command.execution);
    if (
      normalizedExecution &&
      state.status === "executing" &&
      state.execution &&
      state.executionLease?.executionLeaseId === command.executionLeaseId &&
      state.executionLease.instructionHash === command.instructionHash &&
      executionOwnersEqual(state.execution, normalizedExecution) &&
      isPlanLifecycleExecutionAuthorized(state)
    ) {
      return idempotent(state);
    }
  }
  if (
    command.type === "resume_execution" &&
    (state.status === "handoff_pending" || state.status === "executing") &&
    state.approvalLease?.leaseId === command.approvalLeaseId &&
    !!state.executionLease &&
    executionLeasesEqual(state.executionLease, command.executionLease) &&
    isPlanApprovalLeaseBoundToState(state)
  ) {
    return idempotent(state);
  }
  if (command.type === "pause") {
    const normalizedPause = normalizePause(command.pause);
    if (
      state.status === "paused" &&
      state.pause &&
      normalizedPause &&
      pausesEqual(state.pause, normalizedPause)
    ) {
      return idempotent(state);
    }
  }
  if (
    command.type === "complete" &&
    state.status === "completed" &&
    terminalExecutionExpectationMatches(
      state,
      command.expectedExecutionLeaseId,
      normalizeExecutionOwner(command.expectedExecution) || undefined,
    )
  ) return idempotent(state);
  if (
    command.type === "artifact_changed" &&
    arePlanArtifactIdentitiesEqual(state.artifactIdentity, command.artifactIdentity)
  ) {
    return idempotent(state);
  }
  if (
    command.type === "hydrate_discovery" &&
    (state.status === "empty" || state.status === "drafting") &&
    (command.planTurnId ?? null) === state.planTurnId &&
    arePlanArtifactIdentitiesEqual(state.artifactIdentity, command.artifactIdentity)
  ) {
    return idempotent(state);
  }
  if (
    command.type === "start_drafting" &&
    state.status === "drafting" &&
    command.planTurnId === state.planTurnId &&
    arePlanArtifactIdentitiesEqual(state.artifactIdentity, command.artifactIdentity ?? null)
  ) {
    return idempotent(state);
  }
  if (
    command.type === "reset" &&
    state.status === "empty" &&
    state.planTurnId === null &&
    state.artifactIdentity === null &&
    state.reviewIdentity === null &&
    state.approvalLease === null &&
    state.executionLease === null &&
    state.lastIssuedAttempt === 0 &&
    state.execution === null &&
    state.pause === null
  ) {
    return idempotent(state);
  }

  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion !== state.version) {
    return rejected(state, "version_conflict");
  }

  switch (command.type) {
    case "hydrate_discovery": {
      if (state.status !== "empty" && state.status !== "drafting") {
        return rejected(state, "transition_not_allowed");
      }
      if (command.planTurnId != null && !isRequiredIdentityPart(command.planTurnId)) {
        return rejected(state, "invalid_plan_turn");
      }
      const artifactIdentity = command.artifactIdentity === null
        ? null
        : normalizeArtifactIdentity(command.artifactIdentity);
      if (command.artifactIdentity !== null && !artifactIdentity) {
        return rejected(state, "invalid_artifact_identity");
      }
      return applied(state, command.at, {
        status: artifactIdentity ? "drafting" : "empty",
        planTurnId: command.planTurnId ?? null,
        artifactIdentity,
        reviewIdentity: null,
        approvalLease: null,
        executionLease: null,
        lastIssuedAttempt: 0,
        execution: null,
        pause: null,
      });
    }
    case "start_drafting": {
      if (state.status === "handoff_pending" || state.status === "executing") {
        return rejected(state, "transition_not_allowed");
      }
      if (!isRequiredIdentityPart(command.planTurnId)) {
        return rejected(state, "invalid_plan_turn");
      }
      const artifactInput = command.artifactIdentity ?? null;
      const artifactIdentity = artifactInput === null ? null : normalizeArtifactIdentity(artifactInput);
      if (artifactInput !== null && !artifactIdentity) {
        return rejected(state, "invalid_artifact_identity");
      }
      return applied(state, command.at, {
        status: "drafting",
        planTurnId: command.planTurnId,
        artifactIdentity,
        reviewIdentity: null,
        approvalLease: null,
        executionLease: null,
        lastIssuedAttempt: 0,
        execution: null,
        pause: null,
      });
    }
    case "request_review": {
      if (
        state.status !== "drafting" &&
        state.status !== "awaiting_approval" &&
        !(state.status === "paused" && state.approvalLease === null && state.execution === null)
      ) {
        return rejected(state, "transition_not_allowed");
      }
      const artifactIdentity = normalizeArtifactIdentity(command.artifactIdentity);
      if (!artifactIdentity) return rejected(state, "invalid_artifact_identity");
      const reviewIdentity = normalizeReviewIdentity(command.reviewIdentity);
      if (!reviewIdentity) return rejected(state, "invalid_review_identity");
      if (
        reviewIdentity.sessionKey !== state.sessionKey ||
        reviewIdentity.sessionEpoch !== state.sessionEpoch ||
        !artifactMatchesReview(artifactIdentity, reviewIdentity) ||
        !arePlanArtifactIdentitiesEqual(state.artifactIdentity, artifactIdentity)
      ) {
        return rejected(state, "review_identity_mismatch");
      }
      return applied(state, command.at, {
        status: "awaiting_approval",
        planTurnId: reviewIdentity.turnId,
        artifactIdentity,
        reviewIdentity,
        approvalLease: null,
        executionLease: null,
        lastIssuedAttempt: 0,
        execution: null,
        pause: null,
      });
    }
    case "approve": {
      if (
        state.status !== "awaiting_approval" ||
        !state.artifactIdentity ||
        !state.reviewIdentity
      ) {
        return rejected(state, "transition_not_allowed");
      }
      const expectedReviewIdentity = normalizeReviewIdentity(command.expectedReviewIdentity);
      if (!expectedReviewIdentity) return rejected(state, "invalid_review_identity");
      if (!reviewIdentitiesEqual(state.reviewIdentity, expectedReviewIdentity)) {
        return rejected(state, "review_identity_mismatch");
      }
      const decisionIdentity = normalizeApprovalDecisionIdentity(command.decisionIdentity);
      if (!decisionIdentity) return rejected(state, "invalid_approval_lease");
      const approvalLease = normalizeApprovalLease(command.lease);
      if (!approvalLease) return rejected(state, "invalid_approval_lease");
      if (!leaseMatchesReviewAndArtifact({
        state,
        artifactIdentity: state.artifactIdentity,
        reviewIdentity: state.reviewIdentity,
        lease: approvalLease,
      })) {
        return rejected(state, "approval_lease_mismatch");
      }
      if (!approvalDecisionMatchesLease({
        state,
        reviewIdentity: state.reviewIdentity,
        decisionIdentity,
        lease: approvalLease,
      })) {
        return rejected(state, "approval_decision_mismatch");
      }
      const executionLease = normalizeExecutionLease(command.executionLease);
      if (!executionLease) return rejected(state, "invalid_execution_lease");
      if (executionLease.attempt !== 1) return rejected(state, "attempt_mismatch");
      if (!executionLeaseMatchesApproval({
        state,
        approvalLease,
        executionLease,
        expectedParentRunId: approvalLease.approvalRunId,
        expectedAttempt: 1,
        reason: "initial_approval",
      }) ||
        executionLease.executionTurnId !== decisionIdentity.turnId ||
        executionLease.executionRunId === executionLease.parentRunId ||
        !initialExecutionAuthorizationMatchesDecision(executionLease, decisionIdentity)
      ) {
        return rejected(state, "execution_owner_mismatch");
      }
      return applied(state, command.at, {
        status: "handoff_pending",
        approvalLease,
        executionLease,
        lastIssuedAttempt: 1,
        execution: null,
        pause: null,
      });
    }
    case "execution_started": {
      if (state.status !== "handoff_pending" || !state.approvalLease || !state.executionLease) {
        return rejected(state, "transition_not_allowed");
      }
      const execution = normalizeExecutionOwner(command.execution);
      if (!execution) return rejected(state, "invalid_execution_owner");
      if (
        command.executionLeaseId !== state.executionLease.executionLeaseId ||
        !isPlanApprovalLeaseBoundToState(state) ||
        state.lastIssuedAttempt !== state.executionLease.attempt ||
        command.instructionHash !== state.executionLease.instructionHash ||
        execution.turnId !== state.executionLease.executionTurnId ||
        execution.runId !== state.executionLease.executionRunId ||
        execution.parentRunId !== state.executionLease.parentRunId ||
        execution.attempt !== state.executionLease.attempt
      ) {
        return command.instructionHash !== state.executionLease.instructionHash
          ? rejected(state, "instruction_hash_mismatch")
          : rejected(state, "execution_owner_mismatch");
      }
      return applied(state, command.at, {
        status: "executing",
        execution,
        pause: null,
      });
    }
    case "resume_execution": {
      if (
        state.status !== "paused" ||
        !state.approvalLease ||
        command.approvalLeaseId !== state.approvalLease.leaseId ||
        !isPlanApprovalLeaseBoundToState(state)
      ) {
        return rejected(state, "approval_lease_mismatch");
      }
      const executionLease = normalizeExecutionLease(command.executionLease);
      if (!executionLease) return rejected(state, "invalid_execution_lease");
      const expectedAttempt = state.lastIssuedAttempt + 1;
      if (executionLease.attempt !== expectedAttempt) {
        return rejected(state, "attempt_mismatch");
      }
      if (
        executionLease.reason === "initial_approval" ||
        executionLease.executionRunId === executionLease.parentRunId ||
        executionLease.executionLeaseId === state.executionLease?.executionLeaseId ||
        executionLease.executionRunId === state.executionLease?.executionRunId ||
        !executionLeaseMatchesApproval({
          state,
          approvalLease: state.approvalLease,
          executionLease,
          expectedParentRunId: state.execution?.runId || state.approvalLease.approvalRunId,
          expectedAttempt,
          reason: executionLease.reason,
        }) ||
        !resumeAuthorizationMatchesState({ state, executionLease })
      ) {
        return rejected(state, "execution_owner_mismatch");
      }
      return applied(state, command.at, {
        status: "handoff_pending",
        executionLease,
        lastIssuedAttempt: expectedAttempt,
        pause: null,
      });
    }
    case "pause": {
      if (
        state.status !== "drafting" &&
        state.status !== "awaiting_approval" &&
        state.status !== "handoff_pending" &&
        state.status !== "executing" &&
        state.status !== "paused"
      ) {
        return rejected(state, "transition_not_allowed");
      }
      const pause = normalizePause(command.pause);
      if (!pause) return rejected(state, "invalid_pause");
      if (state.status === "executing" || state.status === "paused") {
        const expectedExecution = command.expectedExecution
          ? normalizeExecutionOwner(command.expectedExecution)
          : null;
        const retainsExactPausedExecution = state.status === "paused" &&
          !!state.executionLease &&
          !!state.execution &&
          !!state.approvalLease &&
          isPlanApprovalLeaseBoundToState(state) &&
          executionLeaseIsBoundToApproval({
            state,
            approvalLease: state.approvalLease,
            executionLease: state.executionLease,
          }) &&
          state.lastIssuedAttempt === state.executionLease.attempt &&
          state.execution.turnId === state.executionLease.executionTurnId &&
          state.execution.runId === state.executionLease.executionRunId &&
          state.execution.parentRunId === state.executionLease.parentRunId &&
          state.execution.attempt === state.executionLease.attempt;
        if (
          !expectedExecution ||
          !terminalExecutionExpectationMatches(
            state,
            command.expectedExecutionLeaseId,
            expectedExecution,
          ) ||
          (state.status === "executing"
            ? !isPlanLifecycleExecutionAuthorized(state)
            : !retainsExactPausedExecution)
        ) {
          return rejected(state, "execution_owner_mismatch");
        }
      }
      return applied(state, command.at, { status: "paused", pause });
    }
    case "complete": {
      const expectedExecution = normalizeExecutionOwner(command.expectedExecution);
      if (
        state.status !== "executing" ||
        !expectedExecution ||
        !isPlanLifecycleExecutionAuthorized(state) ||
        !terminalExecutionExpectationMatches(
          state,
          command.expectedExecutionLeaseId,
          expectedExecution,
        )
      ) {
        return rejected(state, "transition_not_allowed");
      }
      return applied(state, command.at, { status: "completed", pause: null });
    }
    case "artifact_changed": {
      const artifactIdentity = command.artifactIdentity === null
        ? null
        : normalizeArtifactIdentity(command.artifactIdentity);
      if (command.artifactIdentity !== null && !artifactIdentity) {
        return rejected(state, "invalid_artifact_identity");
      }
      const mustReviewAgain = requiresFreshReviewAfterArtifactChange(state);
      return applied(state, command.at, {
        status: mustReviewAgain ? "paused" : artifactIdentity ? "drafting" : "empty",
        artifactIdentity,
        reviewIdentity: null,
        approvalLease: null,
        executionLease: null,
        lastIssuedAttempt: 0,
        execution: null,
        pause: mustReviewAgain
          ? Object.freeze({
              reason: "artifact_identity_changed",
              resultKind: "blocked" as const,
              resumeCondition: "review_current_plan",
            })
          : null,
      });
    }
    case "reset":
      return applied(state, command.at, {
        status: "empty",
        planTurnId: null,
        artifactIdentity: null,
        reviewIdentity: null,
        approvalLease: null,
        executionLease: null,
        lastIssuedAttempt: 0,
        execution: null,
        pause: null,
      });
    default:
      return rejected(state, "unknown_command");
  }
}

export function applyPlanArtifactIdentity(input: {
  lifecycle: PlanLifecycleState | null | undefined;
  sessionKey: string;
  artifactIdentity: PlanArtifactIdentity | null;
  at: number;
}): PlanLifecycleState {
  const owner = ensurePlanLifecycleOwner({
    lifecycle: input.lifecycle,
    sessionKey: input.sessionKey,
    at: input.at,
  });
  const transition = reducePlanLifecycle(owner, {
    type: "artifact_changed",
    expectedVersion: owner.version,
    at: input.at,
    artifactIdentity: input.artifactIdentity,
  });
  return transition.disposition === "rejected" ? owner : transition.state;
}

export function applyPlanReviewIdentity(input: {
  lifecycle: PlanLifecycleState | null | undefined;
  artifactIdentity: PlanArtifactIdentity;
  reviewIdentity: PlanReviewIdentity;
  at: number;
}): PlanLifecycleState | null {
  let lifecycle = ensurePlanLifecycleOwner({
    lifecycle: input.lifecycle,
    sessionKey: input.reviewIdentity.sessionKey,
    sessionEpoch: input.reviewIdentity.sessionEpoch,
    at: input.at,
  });
  lifecycle = applyPlanArtifactIdentity({
    lifecycle,
    sessionKey: input.reviewIdentity.sessionKey,
    artifactIdentity: input.artifactIdentity,
    at: input.at,
  });
  if (lifecycle.status === "empty") {
    const drafting = reducePlanLifecycle(lifecycle, {
      type: "start_drafting",
      expectedVersion: lifecycle.version,
      at: input.at,
      planTurnId: input.reviewIdentity.turnId,
      artifactIdentity: input.artifactIdentity,
    });
    if (drafting.disposition === "rejected") return null;
    lifecycle = drafting.state;
  }
  const review = reducePlanLifecycle(lifecycle, {
    type: "request_review",
    expectedVersion: lifecycle.version,
    at: input.at,
    artifactIdentity: input.artifactIdentity,
    reviewIdentity: input.reviewIdentity,
  });
  return review.disposition === "rejected" ? null : review.state;
}

export function applyPlanLifecyclePause(input: {
  lifecycle: PlanLifecycleState;
  pause: PlanLifecyclePause;
  at: number;
}): PlanLifecycleState {
  const transition = reducePlanLifecycle(input.lifecycle, {
    type: "pause",
    expectedVersion: input.lifecycle.version,
    at: input.at,
    pause: input.pause,
  });
  return transition.disposition === "rejected" ? input.lifecycle : transition.state;
}

function normalizeLegacyVersion(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeLegacyAttempt(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Legacy restoration is discovery, not authority creation. Even a fully bound
 * historical lease is restored paused and needs an explicit resume boundary.
 */
export function migrateLegacyPlanLifecycle(
  snapshot: LegacyPlanLifecycleSnapshot,
): PlanLifecycleState {
  const base = createPlanLifecycleState({
    sessionKey: snapshot.sessionKey,
    sessionEpoch: snapshot.sessionEpoch,
    updatedAt: isValidEventTime(snapshot.updatedAt) ? snapshot.updatedAt : 0,
  });
  const version = normalizeLegacyVersion(snapshot.version);
  const planTurnId = snapshot.planTurnId == null || isRequiredIdentityPart(snapshot.planTurnId)
    ? snapshot.planTurnId ?? null
    : null;
  const artifactIdentity = snapshot.artifactIdentity
    ? normalizeArtifactIdentity(snapshot.artifactIdentity)
    : null;
  const reviewIdentity = snapshot.reviewIdentity
    ? normalizeReviewIdentity(snapshot.reviewIdentity)
    : null;
  const reviewIsExact = !!artifactIdentity && !!reviewIdentity &&
    reviewIdentity.sessionKey === base.sessionKey &&
    reviewIdentity.sessionEpoch === base.sessionEpoch &&
    reviewIdentity.turnId === planTurnId &&
    artifactMatchesReview(artifactIdentity, reviewIdentity);
  const approvalLease = snapshot.approvalLease
    ? normalizeApprovalLease(snapshot.approvalLease)
    : null;
  const leaseIsExact = reviewIsExact && !!approvalLease && !!artifactIdentity && !!reviewIdentity &&
    leaseMatchesReviewAndArtifact({
      state: { sessionKey: base.sessionKey, sessionEpoch: base.sessionEpoch, planTurnId },
      artifactIdentity,
      reviewIdentity,
      lease: approvalLease,
    });
  const executionLease = snapshot.executionLease
    ? normalizeExecutionLease(snapshot.executionLease)
    : null;
  const executionLeaseIsExact = leaseIsExact && !!approvalLease && !!executionLease &&
    executionLeaseIsBoundToApproval({
      state: { sessionKey: base.sessionKey, sessionEpoch: base.sessionEpoch, planTurnId },
      approvalLease,
      executionLease,
    });
  const execution = snapshot.execution
    ? normalizeExecutionOwner(snapshot.execution)
    : null;
  const executionIsExact = executionLeaseIsExact && !!executionLease && !!execution &&
    execution.turnId === executionLease.executionTurnId &&
    execution.runId === executionLease.executionRunId &&
    execution.parentRunId === executionLease.parentRunId &&
    execution.attempt === executionLease.attempt;
  const lastIssuedAttempt = Math.max(
    normalizeLegacyAttempt(snapshot.lastIssuedAttempt),
    executionLeaseIsExact ? executionLease?.attempt || 0 : 0,
    executionIsExact ? execution?.attempt || 0 : 0,
  );
  const claimsApproval = snapshot.isPlanApproved === true ||
    snapshot.status === "handoff_pending" ||
    snapshot.status === "executing" ||
    (snapshot.status === "paused" && !!snapshot.approvalLease);

  if (claimsApproval) {
    return freezeState({
      ...base,
      version,
      status: "paused",
      planTurnId,
      artifactIdentity,
      reviewIdentity: leaseIsExact ? reviewIdentity : null,
      approvalLease: leaseIsExact ? approvalLease : null,
      // A restarted process can retain approval capability for an explicit
      // resume, but an unconsumed/active attempt is always retired.
      executionLease: null,
      lastIssuedAttempt,
      execution: executionIsExact ? execution : null,
      pause: Object.freeze({
        reason: leaseIsExact
          ? "legacy_execution_requires_resume"
          : "legacy_approval_unverifiable",
        resultKind: "blocked",
        resumeCondition: leaseIsExact ? "issue_new_execution_lease" : "review_current_plan",
      }),
    });
  }

  if (reviewIsExact) {
    return freezeState({
      ...base,
      version,
      status: "awaiting_approval",
      planTurnId,
      artifactIdentity,
      reviewIdentity,
      lastIssuedAttempt: 0,
    });
  }

  if (artifactIdentity && (snapshot.status === "completed" || snapshot.planStage === "completed")) {
    return freezeState({
      ...base,
      version,
      status: "completed",
      planTurnId,
      artifactIdentity,
      lastIssuedAttempt: 0,
    });
  }

  return freezeState({
    ...base,
    version,
    status: artifactIdentity ? "drafting" : "empty",
    planTurnId,
    artifactIdentity,
    lastIssuedAttempt: 0,
  });
}

export const migrateLegacyPlanLifecycleState = migrateLegacyPlanLifecycle;
