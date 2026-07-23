import type { TaskBlock } from "./taskTypes";
import {
  isExactUserChoiceResolutionIdentity,
  normalizeActionRequest,
  type ActionRequest,
} from "./actionRequest";
import type { PlanApprovalIdentity } from "./planApprovalIdentity";
import {
  shouldRouteUnapprovedPlanReplyOptionsToArtifact,
} from "./replyOptions";
import { looksLikeSubstantivePlanAssistantText } from "./workflowModels";

export interface RestorableRunOwner {
  status?: string | null;
  sessionKey?: string | null;
  turnId?: string | null;
  runId?: string | null;
  activeRunId?: string | null;
}

export interface RestorableGoalRuntimeIdentity {
  status?: string | null;
  goal?: {
    id?: string | null;
    revision?: number | null;
    sessionKey?: string | null;
    ownerTurnId?: string | null;
  } | null;
}

function findExactUserChoiceBlock(
  request: Extract<ActionRequest, { kind: "user_choice" }>,
  taskFlow: TaskBlock[],
): Extract<TaskBlock, { type: "agent" }> | null {
  const block = taskFlow.find((candidate) =>
    candidate.type === "agent" &&
    candidate.turnId === request.turnId &&
    isExactUserChoiceResolutionIdentity(candidate.choiceRequest, request) &&
    Array.isArray(candidate.options) &&
    candidate.options.length === request.optionValues.length &&
    candidate.options.every((option, index) =>
      String(option.value || option.label || "").trim() === request.optionValues[index]
    )
  );
  return block?.type === "agent" ? block : null;
}

export function isInternalUnapprovedPlanChoiceRestore(input: {
  request: ActionRequest | null | undefined;
  planIdentity?: PlanApprovalIdentity | null;
  taskFlow?: TaskBlock[];
  unapprovedPlanTurnIds?: string[];
}): boolean {
  const request = input.request;
  if (
    request?.kind !== "user_choice" ||
    !(input.unapprovedPlanTurnIds || []).includes(request.turnId)
  ) {
    return false;
  }
  const exactChoiceBlock = findExactUserChoiceBlock(request, input.taskFlow || []);
  if (!exactChoiceBlock) return false;
  const replyOptions = Array.isArray(exactChoiceBlock.options) ? exactChoiceBlock.options : [];
  const visibleText = String(exactChoiceBlock.content || "");
  return shouldRouteUnapprovedPlanReplyOptionsToArtifact({
    replyOptions,
    workflowMode: "plan",
    isPlanApproved: false,
    hasStructuredProposal: looksLikeSubstantivePlanAssistantText(visibleText),
    hasReadyPlanArtifacts: !!input.planIdentity,
    hasReviewablePlanArtifacts: !!input.planIdentity,
    visibleText,
  });
}

export function stripRestoredUserChoiceControlText(
  text: string,
  optionValues: string[],
): string {
  const raw = String(text || "");
  let cleaned = raw.replace(/\s*<user_options\b[\s\S]*?<\/user_options>\s*/gi, "\n");
  const choicesIndex = cleaned.lastIndexOf("User choices:");
  if (choicesIndex >= 0) {
    const suffix = cleaned.slice(choicesIndex);
    if (optionValues.length > 0 && optionValues.every((value) => suffix.includes(value))) {
      cleaned = cleaned.slice(0, choicesIndex);
    }
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

function isExactPausedRunOwner(
  request: ActionRequest,
  owner: RestorableRunOwner | null | undefined,
): boolean {
  const actionRunId = String(owner?.activeRunId || owner?.runId || "").trim();
  return owner?.status === "paused" &&
    owner.sessionKey === request.sessionKey &&
    owner.turnId === request.turnId &&
    actionRunId === request.runId;
}

/**
 * Restore only checkpoints that can be resumed without an in-memory callback.
 * Tool permissions deliberately cannot survive a reload because their promise
 * resolver and exact tool-call lease are process-local.
 */
export function restorePendingActionRequest(input: {
  request: unknown;
  runOwner: RestorableRunOwner | null | undefined;
  /** Generic identity retained for legacy Plan/history compatibility. */
  planIdentity?: PlanApprovalIdentity | null;
  /** Typed authority required to restore a pending Plan review control. */
  planReviewIdentity?: PlanApprovalIdentity | null;
  taskFlow?: TaskBlock[];
  goalRuntime?: RestorableGoalRuntimeIdentity | null;
  unapprovedPlanTurnIds?: string[];
}): ActionRequest | null {
  const request = normalizeActionRequest(input.request);
  if (!request || request.status !== "pending" || !isExactPausedRunOwner(request, input.runOwner)) {
    return null;
  }

  if (request.kind === "plan_review") {
    return input.planReviewIdentity &&
      input.planReviewIdentity.revision === request.planRevision &&
      input.planReviewIdentity.artifactHash === request.artifactHash
      ? request
      : null;
  }

  if (request.kind === "user_choice") {
    const taskFlow = Array.isArray(input.taskFlow) ? input.taskFlow : [];
    const exactChoiceBlock = findExactUserChoiceBlock(request, taskFlow);
    if (!exactChoiceBlock) return null;
    if (isInternalUnapprovedPlanChoiceRestore({
      request,
      planIdentity: input.planIdentity,
      taskFlow,
      unapprovedPlanTurnIds: input.unapprovedPlanTurnIds,
    })) {
      return null;
    }
    return request;
  }

  if (request.kind === "goal_confirmation") {
    const goalRuntime = input.goalRuntime;
    const goal = goalRuntime?.goal;
    return goalRuntime?.status === "awaiting_input" &&
      goal?.id === request.goalId &&
      (!goal.sessionKey || goal.sessionKey === request.sessionKey) &&
      (Number(goal.revision) || 1) === request.goalRevision &&
      goal.ownerTurnId === request.turnId
      ? request
      : null;
  }

  return null;
}
