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
import { normalizeUserQuestionnaire, sameUserQuestionnaire, validateUserChoiceAnswer, type UserQuestionnaire, type UserChoiceAnswer } from "./userQuestions";
import { normalizePlanDocumentRef, type PlanDocumentRef } from "./planDocuments";

export const ACTION_REQUEST_SCHEMA_VERSION = 1 as const;

export type ActionRequestKind =
  | "tool_permission"
  | "plan_review"
  | "user_choice";

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
  /** Disclosure only; execution rechecks the canonical Turn requirement. */
  readonly approvalRequiredCapability?: import("./turnCapabilities").TurnCapability;
  /** Immutable Plan-attempt provenance; once present this request may never downgrade to a generic continuation. */
  readonly planExecution?: ToolPermissionPlanExecutionIdentity;
}

export function requiresPerCallToolPermissionApproval(
  risk: ToolPermissionActionRequest["risk"],
  approvalRequiredCapability?: import("./turnCapabilities").TurnCapability,
): boolean {
  return approvalRequiredCapability !== undefined || isPerCallOnlyToolRisk(risk);
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
  readonly documentRef?: PlanDocumentRef;
}

export interface UserChoiceActionRequest extends ActionRequestBase {
  kind: "user_choice";
  readonly questionnaire?: UserQuestionnaire;
  executionBlocker?: { readonly sessionEpoch: string };
  optionValues: string[];
  allowCustomReply: boolean;
}

export type ActionRequest =
  | ToolPermissionActionRequest
  | PlanReviewActionRequest
  | UserChoiceActionRequest;

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
  "sessionKey" | "turnId" | "runId" | "requestId" | "parentRunId" | "optionValues" | "allowCustomReply" | "status" | "executionBlocker" | "questionnaire"
>;

export type PlanReviewResolutionIdentity = Pick<
  PlanReviewActionRequest,
  "sessionKey" | "sessionEpoch" | "turnId" | "runId" | "parentRunId" | "requestId" | "planRevision" | "artifactHash" | "documentRef"
>;

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
    ...(request.questionnaire ? { questionnaire: structuredClone(request.questionnaire) } : {}),
    ...(request.executionBlocker ? { executionBlocker: request.executionBlocker } : {}),
  };
}

export function isExactUserChoiceResolutionIdentity(
  current: UserChoiceResolutionIdentity | null | undefined,
  submitted: UserChoiceResolutionIdentity | null | undefined,
): boolean {
  if (!current || !submitted || current.status !== "pending" || submitted.status !== "pending") return false;
  return current.sessionKey === submitted.sessionKey &&
    current.executionBlocker?.sessionEpoch === submitted.executionBlocker?.sessionEpoch &&
    current.turnId === submitted.turnId &&
    current.runId === submitted.runId &&
    current.requestId === submitted.requestId &&
    (current.parentRunId || null) === (submitted.parentRunId || null) &&
    current.allowCustomReply === submitted.allowCustomReply &&
    sameUserQuestionnaire(current.questionnaire, submitted.questionnaire) &&
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
    !identity.questionnaire &&
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

export function isMatchingStructuredUserChoiceResolution(input: {
  current: UserChoiceResolutionIdentity | null | undefined;
  submitted: UserChoiceResolutionIdentity | null | undefined;
  answer: UserChoiceAnswer;
}): boolean {
  return isExactUserChoiceResolutionIdentity(input.current, input.submitted) &&
    !!input.current?.questionnaire && validateUserChoiceAnswer(input.current.questionnaire, input.answer, input.current.requestId).ok;
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
  documentRef?: PlanDocumentRef;
  now?: number;
}): PlanReviewActionRequest {
  const documentRef = input.documentRef ? normalizePlanDocumentRef(input.documentRef) : null;
  if (input.documentRef && (!documentRef || documentRef.owner.sessionKey !== input.sessionKey || documentRef.owner.turnId !== input.turnId || (input.sessionEpoch && documentRef.owner.sessionEpoch !== input.sessionEpoch))) throw new Error("INVALID_PLAN_DOCUMENT_OWNER");
  return {
    ...buildBaseActionRequest({ ...input, kind: "plan_review" }),
    kind: "plan_review",
    ...(normalizeNonEmptyString(input.sessionEpoch)
      ? { sessionEpoch: normalizeNonEmptyString(input.sessionEpoch) }
      : {}),
    planRevision: Math.max(1, Number(input.planRevision) || 1),
    artifactHash: input.artifactHash,
    artifactPaths: [...input.artifactPaths],
    ...(documentRef ? { documentRef } : {}),
  };
}

export function buildUserChoiceActionRequest(input: {
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  title: string;
  optionValues: string[];
  questionnaire?: UserQuestionnaire;
  allowCustomReply?: boolean;
  now?: number;
}): UserChoiceActionRequest {
  const questionnaire = input.questionnaire ? normalizeUserQuestionnaire(input.questionnaire) : null;
  if (input.questionnaire && !questionnaire) throw new Error("INVALID_USER_QUESTIONNAIRE");
  return {
    ...buildBaseActionRequest({ ...input, kind: "user_choice" }),
    kind: "user_choice",
    optionValues: input.optionValues.map(normalizeNonEmptyString).filter(Boolean),
    ...(questionnaire ? { questionnaire } : {}),
    allowCustomReply: input.allowCustomReply === true,
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
 * checkpoints. Plan review, reply choices and User confirmations have their own
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
    kind !== "user_choice"
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
    const documentRef = record.documentRef === undefined ? undefined : normalizePlanDocumentRef(record.documentRef);
    if (record.documentRef !== undefined && (!documentRef || documentRef.owner.sessionKey !== sessionKey || documentRef.owner.turnId !== turnId || (record.sessionEpoch && documentRef.owner.sessionEpoch !== record.sessionEpoch))) return null;
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
      ...(documentRef ? { documentRef } : {}),
      artifactPaths: Array.isArray(record.artifactPaths)
        ? record.artifactPaths.map(normalizeNonEmptyString).filter(Boolean)
        : [],
    };
  }
  if (kind === "user_choice") {
    const questionnaire = record.questionnaire === undefined ? undefined : normalizeUserQuestionnaire(record.questionnaire);
    if (record.questionnaire !== undefined && !questionnaire) return null;
    return {
      ...base,
      kind,
      ...(questionnaire ? { questionnaire } : {}),
      ...(record.executionBlocker && typeof record.executionBlocker === "object" && typeof (record.executionBlocker as any).sessionEpoch === "string"
        ? { executionBlocker: { sessionEpoch: (record.executionBlocker as any).sessionEpoch } } : {}),
      optionValues: Array.isArray(record.optionValues)
        ? record.optionValues.map(normalizeNonEmptyString).filter(Boolean)
        : [],
      allowCustomReply: record.allowCustomReply === true,
    };
  }
  return null;
}
