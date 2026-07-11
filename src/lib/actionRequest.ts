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
  toolName: string;
  target: string;
  risk?: "local_file_read" | "browser_control" | "shell" | "write" | "external_write" | "unknown";
}

export interface PlanReviewActionRequest extends ActionRequestBase {
  kind: "plan_review";
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
  "sessionKey" | "turnId" | "runId" | "requestId" | "planRevision" | "artifactHash"
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
  } | null;
}): boolean {
  const identity = input.identity;
  if (!identity || !input.goalId) return false;
  if (identity.goalId !== input.goalId || identity.goalRevision !== input.goalRevision) return false;

  const pendingGoalConfirmation = input.request?.kind === "goal_confirmation" &&
    input.request.status === "pending"
      ? input.request
      : null;
  if (!pendingGoalConfirmation) return !identity.requestId;
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
    input.runOwner.runId === confirmation.runId;
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
    return {
      ...base,
      kind,
      taskId,
      toolName,
      target: normalizeNonEmptyString(record.target) || toolName,
      ...(typeof record.risk === "string" ? { risk: record.risk as ToolPermissionActionRequest["risk"] } : {}),
    };
  }
  if (kind === "plan_review") {
    const artifactHash = normalizeNonEmptyString(record.artifactHash);
    if (!artifactHash) return null;
    return {
      ...base,
      kind,
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
