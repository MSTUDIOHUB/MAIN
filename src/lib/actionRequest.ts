import {
  doesLifecycleRetainPlanExecutionProvenance,
  isPlanExecutionRunProvenanceForOwner,
  normalizePlanExecutionRunProvenance,
  type PlanExecutionRunProvenance,
} from "./planExecutionProvenance";
import type { HarnessRunMarker } from "./harnessCrashTelemetry";
import { isHarnessMarkerOwnedByPlanExecution } from "./planExecutionOwnership";
import type { PlanLifecycleState } from "./planLifecycle";
import { isPerCallOnlyToolRisk, type ToolRiskLevel } from "./toolCapabilities";

export const ACTION_REQUEST_SCHEMA_VERSION = 1 as const;

export type ActionRequestKind =
  | "tool_permission"
  | "plan_review"
  | "user_choice"
  | "goal_confirmation";

export type ActionRequestStatus = "pending" | "resolved" | "cancelled" | "stale";

export interface ActionRequestBase {
  schemaVersion: typeof ACTION_REQUEST_SCHEMA_VERSION;
  requestId: string;
  kind: ActionRequestKind;
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  title: string;
  status: ActionRequestStatus;
  createdAt: number;
  resolvedAt?: number | null;
}

export interface ToolPermissionActionRequest extends ActionRequestBase {
  kind: "tool_permission";
  taskId: number;
  /** Exact provider/runtime call identity used to bind in-memory final arguments. */
  toolCallId?: string;
  toolName: string;
  target: string;
  risk?: ToolRiskLevel | "write" | "unknown";
  /** Immutable Plan-attempt provenance; once present this request may never downgrade to a generic continuation. */
  readonly planExecution?: ToolPermissionPlanExecutionIdentity;
}

export function requiresPerCallToolPermissionApproval(
  risk: ToolPermissionActionRequest["risk"],
): boolean {
  return isPerCallOnlyToolRisk(risk);
}

export type ToolPermissionPlanExecutionIdentity = PlanExecutionRunProvenance;

export interface PendingPlanToolPermissionInvalidation {
  readonly requestId: string;
  readonly taskId: number;
  readonly patch: Readonly<{
    activeActionRequest: null;
    pendingReviewResolve: null;
    pendingReviewTaskId: null;
    pendingToolCall: null;
  }>;
  readonly resolve: ((decision: { action: "reject" }) => unknown) | null;
  /** Stops the stale Plan Run after the waiting review Promise is released. */
  readonly abort: (() => void) | null;
}

const settledPlanToolPermissionInvalidations = new WeakSet<object>();

export interface PlanReviewActionRequest extends ActionRequestBase {
  kind: "plan_review";
  /** Runtime v2 owner epoch. Legacy requests omit it and can only resolve
   * through the legacy authority path. */
  sessionEpoch?: string;
  planRevision: number;
  artifactHash: string;
  artifactPaths: string[];
}

export interface UserChoiceActionRequest extends ActionRequestBase {
  kind: "user_choice";
  optionValues: string[];
  allowCustomReply: boolean;
}

export interface GoalConfirmationActionRequest extends ActionRequestBase {
  kind: "goal_confirmation";
  goalId: string;
  goalRevision: number;
  reason: string;
}

export type ActionRequest =
  | ToolPermissionActionRequest
  | PlanReviewActionRequest
  | UserChoiceActionRequest
  | GoalConfirmationActionRequest;

/**
 * Immutable identity captured by a permission control when it is rendered.
 * Resolution handlers must compare every field with the currently pending
 * request before performing any state change. This prevents a click queued on
 * an old DOM node from approving a newer tool request.
 */
export type ToolPermissionResolutionIdentity = Pick<
  ToolPermissionActionRequest,
  "sessionKey" | "turnId" | "runId" | "requestId" | "taskId"
>;

/** Durable identity stored with an awaiting-choice assistant block. */
export type UserChoiceResolutionIdentity = Pick<
  UserChoiceActionRequest,
  "sessionKey" | "turnId" | "runId" | "requestId" | "parentRunId" | "optionValues" | "allowCustomReply" | "status"
>;

export type PlanReviewResolutionIdentity = Pick<
  PlanReviewActionRequest,
  "sessionKey" | "sessionEpoch" | "turnId" | "runId" | "parentRunId" | "requestId" | "planRevision" | "artifactHash"
>;

export type GoalConfirmationResolutionIdentity = Pick<
  GoalConfirmationActionRequest,
  "sessionKey" | "turnId" | "runId" | "requestId" | "goalId" | "goalRevision"
>;

/** Identity captured by a Goal control. A request id is present only while the
 * Goal is stopped at an explicit confirmation boundary. */
export interface GoalControlIdentity {
  goalId: string;
  goalRevision: number;
  requestId?: string;
}

export function isCurrentGoalControlResolution(input: {
  request: ActionRequest | null | undefined;
  identity: GoalControlIdentity | null | undefined;
  goalId: string | null | undefined;
  goalRevision: number;
  runOwner?: {
    status?: string | null;
    sessionKey?: string | null;
    turnId?: string | null;
    runId?: string | null;
    activeRunId?: string | null;
  } | null;
}): boolean {
  const identity = input.identity;
  if (!identity || !input.goalId) return false;
  if (identity.goalId !== input.goalId || identity.goalRevision !== input.goalRevision) return false;

  const pendingRequest = input.request?.status === "pending" ? input.request : null;
  if (!pendingRequest) return !identity.requestId;
  if (pendingRequest.kind !== "goal_confirmation") return false;
  const pendingGoalConfirmation = pendingRequest;
  if (
    pendingGoalConfirmation.goalId !== input.goalId ||
    pendingGoalConfirmation.goalRevision !== input.goalRevision
  ) {
    return false;
  }
  const confirmation = pendingGoalConfirmation;

  return identity.requestId === confirmation.requestId &&
    input.runOwner?.status === "paused" &&
    input.runOwner.sessionKey === confirmation.sessionKey &&
    input.runOwner.turnId === confirmation.turnId &&
    (input.runOwner.activeRunId || input.runOwner.runId) === confirmation.runId;
}

/** Pause and clear are administrative Goal controls rather than resolutions of
 * a pending permission/choice. They still bind the exact Goal revision, and a
 * request id (when captured) must match the current Goal confirmation. */
export function isCurrentGoalAdministrativeControl(input: {
  request: ActionRequest | null | undefined;
  identity: GoalControlIdentity | null | undefined;
  goalId: string | null | undefined;
  goalRevision: number;
}): boolean {
  const identity = input.identity;
  if (!identity || !input.goalId) return false;
  if (identity.goalId !== input.goalId || identity.goalRevision !== input.goalRevision) return false;
  const confirmation = input.request?.kind === "goal_confirmation" &&
    input.request.status === "pending" &&
    input.request.goalId === input.goalId &&
    input.request.goalRevision === input.goalRevision
      ? input.request
      : null;
  if (!confirmation) return !identity.requestId;
  return confirmation.requestId === identity.requestId;
}

export function clearGoalConfirmationActionRequest(
  request: ActionRequest | null | undefined,
  goalId: string,
  goalRevision: number,
): ActionRequest | null {
  return request?.kind === "goal_confirmation" &&
    request.goalId === goalId &&
    request.goalRevision === goalRevision
    ? null
    : request || null;
}

export function toUserChoiceResolutionIdentity(
  request: UserChoiceActionRequest,
): UserChoiceResolutionIdentity {
  return {
    sessionKey: request.sessionKey,
    turnId: request.turnId,
    runId: request.runId,
    requestId: request.requestId,
    parentRunId: request.parentRunId || null,
    optionValues: [...request.optionValues],
    allowCustomReply: request.allowCustomReply,
    status: request.status,
  };
}

export function isExactUserChoiceResolutionIdentity(
  current: UserChoiceResolutionIdentity | null | undefined,
  submitted: UserChoiceResolutionIdentity | null | undefined,
): boolean {
  if (!current || !submitted || current.status !== "pending" || submitted.status !== "pending") return false;
  return current.sessionKey === submitted.sessionKey &&
    current.turnId === submitted.turnId &&
    current.runId === submitted.runId &&
    current.requestId === submitted.requestId &&
    (current.parentRunId || null) === (submitted.parentRunId || null) &&
    current.allowCustomReply === submitted.allowCustomReply &&
    current.optionValues.length === submitted.optionValues.length &&
    current.optionValues.every((value, index) =>
      normalizeNonEmptyString(value) === normalizeNonEmptyString(submitted.optionValues[index])
    );
}

export function isMatchingUserChoiceResolution(input: {
  identity: UserChoiceResolutionIdentity | null | undefined;
  sessionKey: string;
  turnId: string;
  optionValue: string;
  isCustomReply?: boolean;
}): boolean {
  const identity = input.identity;
  const optionValue = normalizeNonEmptyString(input.optionValue);
  return !!identity &&
    identity.status === "pending" &&
    identity.sessionKey === input.sessionKey &&
    identity.turnId === input.turnId &&
    !!identity.runId &&
    !!identity.requestId &&
    !!optionValue &&
    (input.isCustomReply === true
      ? identity.allowCustomReply === true
      : identity.optionValues.some((value) => normalizeNonEmptyString(value) === optionValue));
}

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createActionRequestId(
  kind: ActionRequestKind,
  runId: string,
  now = Date.now(),
): string {
  const safeRunId = normalizeNonEmptyString(runId) || "unknown-run";
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10);
  return `action-${kind}-${safeRunId}-${now}-${random}`;
}

function buildBaseActionRequest(input: {
  kind: ActionRequestKind;
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  title: string;
  now?: number;
}): ActionRequestBase {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: ACTION_REQUEST_SCHEMA_VERSION,
    requestId: createActionRequestId(input.kind, input.runId, now),
    kind: input.kind,
    sessionKey: input.sessionKey,
    turnId: input.turnId,
    runId: input.runId,
    parentRunId: input.parentRunId || null,
    title: normalizeNonEmptyString(input.title) || "Current task",
    status: "pending",
    createdAt: now,
  };
}

export function buildPlanReviewActionRequest(input: {
  sessionKey: string;
  sessionEpoch?: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  title: string;
  planRevision: number;
  artifactHash: string;
  artifactPaths: string[];
  now?: number;
}): PlanReviewActionRequest {
  return {
    ...buildBaseActionRequest({ ...input, kind: "plan_review" }),
    kind: "plan_review",
    ...(normalizeNonEmptyString(input.sessionEpoch)
      ? { sessionEpoch: normalizeNonEmptyString(input.sessionEpoch) }
      : {}),
    planRevision: Math.max(1, Number(input.planRevision) || 1),
    artifactHash: input.artifactHash,
    artifactPaths: [...input.artifactPaths],
  };
}

export function buildUserChoiceActionRequest(input: {
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  title: string;
  optionValues: string[];
  allowCustomReply?: boolean;
  now?: number;
}): UserChoiceActionRequest {
  return {
    ...buildBaseActionRequest({ ...input, kind: "user_choice" }),
    kind: "user_choice",
    optionValues: input.optionValues.map(normalizeNonEmptyString).filter(Boolean),
    allowCustomReply: input.allowCustomReply === true,
  };
}

export function buildGoalConfirmationActionRequest(input: {
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  title: string;
  goalId: string;
  goalRevision: number;
  reason: string;
  now?: number;
}): GoalConfirmationActionRequest {
  return {
    ...buildBaseActionRequest({ ...input, kind: "goal_confirmation" }),
    kind: "goal_confirmation",
    goalId: input.goalId,
    goalRevision: Math.max(1, Number(input.goalRevision) || 1),
    reason: normalizeNonEmptyString(input.reason) || "periodic_confirmation",
  };
}

export function isPendingActionRequest(
  request: ActionRequest | null | undefined,
): request is ActionRequest {
  return !!request && request.status === "pending";
}

export function isToolPermissionActionRequest(
  request: ActionRequest | null | undefined,
): request is ToolPermissionActionRequest {
  return isPendingActionRequest(request) && request.kind === "tool_permission";
}

export function getToolPermissionResolutionIdentity(
  request: ToolPermissionActionRequest,
): ToolPermissionResolutionIdentity {
  return {
    sessionKey: request.sessionKey,
    turnId: request.turnId,
    runId: request.runId,
    requestId: request.requestId,
    taskId: request.taskId,
  };
}

export function isExactToolPermissionResolutionIdentity(
  request: ActionRequest | null | undefined,
  identity: ToolPermissionResolutionIdentity | null | undefined,
): request is ToolPermissionActionRequest {
  return isToolPermissionActionRequest(request) &&
    !!identity &&
    request.sessionKey === identity.sessionKey &&
    request.turnId === identity.turnId &&
    request.runId === identity.runId &&
    request.requestId === identity.requestId &&
    request.taskId === identity.taskId;
}

export function isToolPermissionPlanExecutionIdentityCurrent(
  request: ToolPermissionActionRequest,
  lifecycle: PlanLifecycleState | null | undefined,
): boolean {
  const identity = request.planExecution;
  return !!identity && isPlanExecutionAttemptIdentityCurrentForRun({
    identity,
    owner: {
      sessionKey: request.sessionKey,
      turnId: request.turnId,
      runId: request.runId,
      parentRunId: request.parentRunId || null,
    },
    lifecycle,
  });
}

export function isPlanExecutionAttemptIdentityCurrentForRun(input: {
  identity: ToolPermissionPlanExecutionIdentity;
  owner: {
    sessionKey: string;
    turnId: string;
    runId: string;
    parentRunId: string | null;
  };
  lifecycle: PlanLifecycleState | null | undefined;
}): boolean {
  const { identity, owner, lifecycle } = input;
  return isPlanExecutionRunProvenanceForOwner(identity, owner) &&
    doesLifecycleRetainPlanExecutionProvenance(lifecycle, identity);
}

/**
 * Builds the single atomic invalidation patch for a pending Plan-owned tool
 * review. Generic tool permissions deliberately return null and are not
 * coupled to Plan artifact lifecycle changes.
 */
export function buildPendingPlanToolPermissionInvalidation(
  state: {
    activeActionRequest?: ActionRequest | null;
    pendingReviewResolve?: ((decision: { action: "reject" }) => unknown) | null;
    pendingReviewTaskId?: number | null;
    abortController?: { abort: () => void; signal?: { aborted?: boolean } } | null;
    planLifecycle?: PlanLifecycleState | null;
    harnessRunMarker?: HarnessRunMarker | null;
  },
  shouldInvalidate: boolean,
): PendingPlanToolPermissionInvalidation | null {
  const request = state.activeActionRequest;
  if (
    !shouldInvalidate ||
    request?.kind !== "tool_permission" ||
    !request.planExecution
  ) return null;
  const resolve =
    state.pendingReviewTaskId === request.taskId &&
    typeof state.pendingReviewResolve === "function"
      ? state.pendingReviewResolve
      : null;
  const ownsPlanExecution = isHarnessMarkerOwnedByPlanExecution({
    lifecycle: state.planLifecycle,
    marker: state.harnessRunMarker,
  });
  return {
    requestId: request.requestId,
    taskId: request.taskId,
    patch: {
      activeActionRequest: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
    },
    resolve,
    abort:
      ownsPlanExecution &&
      state.abortController &&
      state.abortController.signal?.aborted !== true
        ? () => state.abortController?.abort()
        : null,
  };
}

export function settlePendingPlanToolPermissionInvalidation(
  invalidation: PendingPlanToolPermissionInvalidation | null | undefined,
): boolean {
  if (!invalidation || settledPlanToolPermissionInvalidations.has(invalidation)) return false;
  settledPlanToolPermissionInvalidations.add(invalidation);
  let settled = false;
  try {
    if (invalidation.resolve) {
      const result = invalidation.resolve({ action: "reject" });
      settled = result !== false;
    }
  } finally {
    invalidation.abort?.();
  }
  return settled;
}

export function clearActionRequestOfKind(
  request: ActionRequest | null | undefined,
  kind: ActionRequestKind,
): ActionRequest | null {
  return request?.kind === kind ? null : request || null;
}

export function isActionRequestOwnedByRun(
  request: ActionRequest | null | undefined,
  owner: { sessionKey: string; turnId: string; runId: string },
): boolean {
  return !!request &&
    request.sessionKey === owner.sessionKey &&
    request.turnId === owner.turnId &&
    request.runId === owner.runId;
}

export function resolveActionRequest(
  request: ActionRequest,
  status: Extract<ActionRequestStatus, "resolved" | "cancelled" | "stale">,
  now = Date.now(),
): ActionRequest {
  if (request.status !== "pending") return request;
  return {
    ...request,
    status,
    resolvedAt: now,
  } as ActionRequest;
}

/**
 * The global permission capsule is deliberately narrower than the set of all
 * checkpoints. Plan review, reply choices and Goal confirmations have their own
 * workflow-specific UI and must never be projected as a tool permission.
 */
export function shouldRenderPermissionCapsule(input: {
  request: ActionRequest | null | undefined;
  sessionKey: string;
  turnId?: string | null;
  runId?: string | null;
  requestId?: string | null;
  taskId?: number | null;
}): boolean {
  if (!isToolPermissionActionRequest(input.request)) return false;
  if (
    !input.sessionKey ||
    !input.turnId ||
    !input.runId ||
    !input.requestId ||
    input.taskId == null
  ) {
    return false;
  }
  return input.request.sessionKey === input.sessionKey &&
    input.request.turnId === input.turnId &&
    input.request.runId === input.runId &&
    input.request.requestId === input.requestId &&
    input.request.taskId === input.taskId;
}

export function normalizeActionRequest(value: unknown): ActionRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Number(record.schemaVersion) !== ACTION_REQUEST_SCHEMA_VERSION) return null;
  const kind = record.kind;
  if (
    kind !== "tool_permission" &&
    kind !== "plan_review" &&
    kind !== "user_choice" &&
    kind !== "goal_confirmation"
  ) {
    return null;
  }
  const sessionKey = normalizeNonEmptyString(record.sessionKey);
  const turnId = normalizeNonEmptyString(record.turnId);
  const runId = normalizeNonEmptyString(record.runId);
  const requestId = normalizeNonEmptyString(record.requestId);
  if (!sessionKey || !turnId || !runId || !requestId) return null;
  const status = record.status === "pending" || record.status === "resolved" || record.status === "cancelled" || record.status === "stale"
    ? record.status
    : null;
  if (!status) return null;
  const base: ActionRequestBase = {
    schemaVersion: ACTION_REQUEST_SCHEMA_VERSION,
    requestId,
    kind,
    sessionKey,
    turnId,
    runId,
    parentRunId: normalizeNonEmptyString(record.parentRunId) || null,
    title: normalizeNonEmptyString(record.title) || "Current task",
    status,
    createdAt: Math.max(0, Number(record.createdAt) || Date.now()),
    resolvedAt: Number.isFinite(Number(record.resolvedAt)) ? Math.max(0, Number(record.resolvedAt)) : null,
  };

  if (kind === "tool_permission") {
    const taskId = Number(record.taskId);
    const toolName = normalizeNonEmptyString(record.toolName);
    if (!Number.isFinite(taskId) || !toolName) return null;
    let planExecution: ToolPermissionPlanExecutionIdentity | undefined;
    if (record.planExecution !== undefined) {
      planExecution = normalizePlanExecutionRunProvenance(record.planExecution) || undefined;
      if (!planExecution || !isPlanExecutionRunProvenanceForOwner(planExecution, {
        sessionKey,
        turnId,
        runId,
        parentRunId: base.parentRunId || null,
      })) return null;
    }
    return {
      ...base,
      kind,
      taskId,
      ...(normalizeNonEmptyString(record.toolCallId)
        ? { toolCallId: normalizeNonEmptyString(record.toolCallId) }
        : {}),
      toolName,
      target: normalizeNonEmptyString(record.target) || toolName,
      ...(typeof record.risk === "string" ? { risk: record.risk as ToolPermissionActionRequest["risk"] } : {}),
      ...(planExecution ? { planExecution } : {}),
    };
  }
  if (kind === "plan_review") {
    const artifactHash = normalizeNonEmptyString(record.artifactHash);
    if (!artifactHash) return null;
    return {
      ...base,
      kind,
      ...(normalizeNonEmptyString(record.sessionEpoch)
        ? { sessionEpoch: normalizeNonEmptyString(record.sessionEpoch) }
        : {}),
      planRevision: Math.max(1, Number(record.planRevision) || 1),
      artifactHash,
      artifactPaths: Array.isArray(record.artifactPaths)
        ? record.artifactPaths.map(normalizeNonEmptyString).filter(Boolean)
        : [],
    };
  }
  if (kind === "user_choice") {
    return {
      ...base,
      kind,
      optionValues: Array.isArray(record.optionValues)
        ? record.optionValues.map(normalizeNonEmptyString).filter(Boolean)
        : [],
      allowCustomReply: record.allowCustomReply === true,
    };
  }
  const goalId = normalizeNonEmptyString(record.goalId);
  if (!goalId) return null;
  return {
    ...base,
    kind,
    goalId,
    goalRevision: Math.max(1, Number(record.goalRevision) || 1),
    reason: normalizeNonEmptyString(record.reason) || "periodic_confirmation",
  };
}
