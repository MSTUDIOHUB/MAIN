import type { TaskBlock } from "./taskTypes";
import {
  isExactUserChoiceResolutionIdentity,
  normalizeActionRequest,
  type ActionRequest,
} from "./actionRequest";
import type { PlanApprovalIdentity } from "./planApprovalIdentity";

export interface RestorableRunOwner {
  status?: string | null;
  sessionKey?: string | null;
  turnId?: string | null;
  runId?: string | null;
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

function isExactPausedRunOwner(
  request: ActionRequest,
  owner: RestorableRunOwner | null | undefined,
): boolean {
  return owner?.status === "paused" &&
    owner.sessionKey === request.sessionKey &&
    owner.turnId === request.turnId &&
    owner.runId === request.runId;
}

/**
 * Restore only checkpoints that can be resumed without an in-memory callback.
 * Tool permissions deliberately cannot survive a reload because their promise
 * resolver and exact tool-call lease are process-local.
 */
export function restorePendingActionRequest(input: {
  request: unknown;
  runOwner: RestorableRunOwner | null | undefined;
  planIdentity?: PlanApprovalIdentity | null;
  taskFlow?: TaskBlock[];
  goalRuntime?: RestorableGoalRuntimeIdentity | null;
}): ActionRequest | null {
  const request = normalizeActionRequest(input.request);
  if (!request || request.status !== "pending" || !isExactPausedRunOwner(request, input.runOwner)) {
    return null;
  }

  if (request.kind === "plan_review") {
    return input.planIdentity &&
      input.planIdentity.revision === request.planRevision &&
      input.planIdentity.artifactHash === request.artifactHash
      ? request
      : null;
  }

  if (request.kind === "user_choice") {
    const taskFlow = Array.isArray(input.taskFlow) ? input.taskFlow : [];
    const hasExactChoiceBlock = taskFlow.some((block) =>
      block.type === "agent" &&
      block.turnId === request.turnId &&
      isExactUserChoiceResolutionIdentity(block.choiceRequest, request) &&
      Array.isArray(block.options) &&
      block.options.length === request.optionValues.length &&
      block.options.every((option, index) =>
        String(option.value || option.label || "").trim() === request.optionValues[index]
      )
    );
    return hasExactChoiceBlock ? request : null;
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
