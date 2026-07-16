import {
  getHarnessActionRunId,
  type HarnessRunMarker,
} from "./harnessCrashTelemetry";
import type { GoalDefinition } from "./goalState";

export type GoalRunAbortOwnershipReason =
  | "owned_goal_run"
  | "goal_not_running"
  | "no_active_run_lease"
  | "marker_not_running"
  | "runtime_intent_mismatch"
  | "session_mismatch"
  | "turn_mismatch"
  | "workspace_mismatch"
  | "pending_review_mismatch"
  | "action_request_mismatch";

export interface GoalRunAbortOwnershipDecision {
  owned: boolean;
  reason: GoalRunAbortOwnershipReason;
}

interface GoalOwnedActionRequest {
  kind?: string | null;
  status?: string | null;
  sessionKey?: string | null;
  turnId?: string | null;
  runId?: string | null;
  taskId?: number | null;
}

interface QueuedGoalContinuationAuthorization {
  kind?: string | null;
  source?: string | null;
  workspaceKey?: string | null;
  sessionKey?: string | null;
  goalId?: string | null;
  goalRevision?: number | null;
  ownerTurnId?: string | null;
}

interface QueuedGoalContinuation {
  text?: string | null;
  sessionKey?: string | null;
  status?: string | null;
  goalContinuationAuthorization?: QueuedGoalContinuationAuthorization | null;
}

export type QueuedGoalContinuationRemovalMode =
  | "consumed"
  | "discarded"
  | "replaced";

export type QueuedGoalContinuationRemovalReason =
  | "replay_consumed"
  | "goal_not_active"
  | "queue_owner_mismatch"
  | "goal_run_lease_acquired"
  | "orphaned_before_run_lease";

export interface QueuedGoalContinuationRemovalDecision {
  shouldPauseGoal: boolean;
  reason: QueuedGoalContinuationRemovalReason;
  leaseReason?: GoalRunAbortOwnershipReason;
}

/**
 * A queued continuation belongs to a Goal only when every durable owner field
 * still agrees. This is intentionally stricter than matching the generated
 * resume text so pause/delete cannot discard an unrelated user message.
 */
export function isQueuedGoalContinuationOwnedByGoal(input: {
  queuedMessage: QueuedGoalContinuation | null | undefined;
  goal: Pick<GoalDefinition, "id" | "revision" | "sessionKey" | "ownerTurnId">;
  workspaceKey: string | null | undefined;
  sessionKey: string | null | undefined;
  expectedText?: string | null;
  expectedSource?: string | null;
}): boolean {
  const queued = input.queuedMessage;
  const authorization = queued?.goalContinuationAuthorization;
  const workspaceKey = String(input.workspaceKey || "").trim();
  const sessionKey = String(input.sessionKey || "").trim();
  const goalSessionKey = String(input.goal.sessionKey || "").trim();
  const ownerTurnId = String(input.goal.ownerTurnId || "").trim();
  if (
    queued?.status !== "queued" ||
    authorization?.kind !== "goal_continuation_authorization" ||
    !workspaceKey ||
    !sessionKey ||
    queued.sessionKey !== sessionKey ||
    authorization.workspaceKey !== workspaceKey ||
    authorization.sessionKey !== sessionKey ||
    authorization.goalId !== input.goal.id ||
    Number(authorization.goalRevision) !== Math.max(1, Number(input.goal.revision) || 1) ||
    !ownerTurnId ||
    authorization.ownerTurnId !== ownerTurnId ||
    (goalSessionKey && goalSessionKey !== sessionKey && goalSessionKey !== workspaceKey)
  ) {
    return false;
  }
  if (input.expectedText != null && queued.text !== input.expectedText) return false;
  if (
    input.expectedSource != null &&
    authorization.source !== input.expectedSource
  ) {
    return false;
  }
  return true;
}

/**
 * A manual Goal resume becomes `active` before the next run can acquire its
 * harness lease. While it is waiting behind another run, the exact queued
 * continuation is therefore part of the Goal's ownership contract. Removing
 * that queue entry without consuming it would otherwise leave a phantom
 * `active` Goal with no process capable of advancing it.
 *
 * Normal replay is explicitly classified as `consumed`; it must never roll the
 * newly acquired run back. A live exact Goal lease also wins over a late UI
 * discard. Every other message/session/Goal mismatch is a no-op.
 */
export function resolveQueuedGoalContinuationRemoval(input: {
  mode: QueuedGoalContinuationRemovalMode;
  queuedMessage: QueuedGoalContinuation | null | undefined;
  goal: Pick<GoalDefinition, "id" | "revision" | "sessionKey" | "ownerTurnId" | "status">;
  marker: HarnessRunMarker | null | undefined;
  currentWorkspace: string | null | undefined;
  currentSessionKey: string | null | undefined;
}): QueuedGoalContinuationRemovalDecision {
  if (input.mode === "consumed") {
    return { shouldPauseGoal: false, reason: "replay_consumed" };
  }
  if (input.goal.status !== "active") {
    return { shouldPauseGoal: false, reason: "goal_not_active" };
  }
  if (!isQueuedGoalContinuationOwnedByGoal({
    queuedMessage: input.queuedMessage,
    goal: input.goal,
    workspaceKey: input.currentWorkspace,
    sessionKey: input.currentSessionKey,
  })) {
    return { shouldPauseGoal: false, reason: "queue_owner_mismatch" };
  }

  const leaseDecision = resolveGoalHarnessOwnership({
    goal: input.goal,
    marker: input.marker,
    currentWorkspace: input.currentWorkspace,
    currentSessionKey: input.currentSessionKey,
  });
  if (leaseDecision.owned) {
    return {
      shouldPauseGoal: false,
      reason: "goal_run_lease_acquired",
      leaseReason: leaseDecision.reason,
    };
  }
  return {
    shouldPauseGoal: true,
    reason: "orphaned_before_run_lease",
    leaseReason: leaseDecision.reason,
  };
}

function resolveGoalHarnessOwnership(input: {
  goal: Pick<GoalDefinition, "sessionKey" | "ownerTurnId">;
  marker: HarnessRunMarker | null | undefined;
  currentWorkspace: string | null | undefined;
  currentSessionKey: string | null | undefined;
  allowPausedMarker?: boolean;
}): GoalRunAbortOwnershipDecision {
  const marker = input.marker;
  if (
    !marker ||
    (marker.status !== "running" && !(input.allowPausedMarker && marker.status === "paused"))
  ) {
    return { owned: false, reason: "marker_not_running" };
  }
  if (marker.runtimeIntent !== "goal") {
    return { owned: false, reason: "runtime_intent_mismatch" };
  }

  const goalSessionKey = String(input.goal.sessionKey || "").trim();
  const currentSessionKey = String(input.currentSessionKey || "").trim();
  if (
    !goalSessionKey ||
    !currentSessionKey ||
    marker.sessionKey !== goalSessionKey ||
    marker.sessionKey !== currentSessionKey
  ) {
    return { owned: false, reason: "session_mismatch" };
  }

  const ownerTurnId = String(input.goal.ownerTurnId || "").trim();
  if (!ownerTurnId || marker.turnId !== ownerTurnId) {
    return { owned: false, reason: "turn_mismatch" };
  }

  const currentWorkspace = String(input.currentWorkspace || "").trim();
  const markerWorkspace = String(marker.workspace || "").trim();
  if (markerWorkspace && (!currentWorkspace || markerWorkspace !== currentWorkspace)) {
    return { owned: false, reason: "workspace_mismatch" };
  }

  return { owned: true, reason: "owned_goal_run" };
}

/**
 * Resolve whether a pending action request belongs to the exact Goal run.
 * Session/turn equality alone is insufficient because an Execute run may reuse
 * the same logical turn after a stale Goal record has been left in the Store.
 */
export function resolveGoalActionRequestOwnership(input: {
  goal: Pick<GoalDefinition, "sessionKey" | "ownerTurnId">;
  marker: HarnessRunMarker | null | undefined;
  currentWorkspace: string | null | undefined;
  currentSessionKey: string | null | undefined;
  actionRequest: GoalOwnedActionRequest | null | undefined;
}): GoalRunAbortOwnershipDecision {
  const harnessOwnership = resolveGoalHarnessOwnership({
    goal: input.goal,
    marker: input.marker,
    currentWorkspace: input.currentWorkspace,
    currentSessionKey: input.currentSessionKey,
    // Goal permission requests keep a running marker, while user-choice and
    // Goal-confirmation requests are intentionally projected as paused.
    allowPausedMarker: true,
  });
  if (!harnessOwnership.owned) return harnessOwnership;

  const request = input.actionRequest;
  const actionRunId = getHarnessActionRunId(input.marker);
  if (
    !request ||
    request.status !== "pending" ||
    request.sessionKey !== input.marker?.sessionKey ||
    request.turnId !== input.marker?.turnId ||
    !actionRunId ||
    request.runId !== actionRunId
  ) {
    return { owned: false, reason: "action_request_mismatch" };
  }
  return { owned: true, reason: "owned_goal_run" };
}

/**
 * The app has one global AbortController, so a stale Goal record must never
 * infer ownership from its own `status`. Deletion may abort only the exact
 * running Goal lease identified by the durable harness marker.
 */
export function resolveGoalRunAbortOwnership(input: {
  goal: Pick<GoalDefinition, "status" | "sessionKey" | "ownerTurnId">;
  marker: HarnessRunMarker | null | undefined;
  currentWorkspace: string | null | undefined;
  currentSessionKey: string | null | undefined;
  isGenerating: boolean;
  hasAbortController: boolean;
  hasOwnedPendingReview?: boolean;
}): GoalRunAbortOwnershipDecision {
  if (input.goal.status !== "active" && input.goal.status !== "pausing") {
    return { owned: false, reason: "goal_not_running" };
  }
  if ((!input.isGenerating && input.hasOwnedPendingReview !== true) || !input.hasAbortController) {
    return { owned: false, reason: "no_active_run_lease" };
  }
  return resolveGoalHarnessOwnership(input);
}

/** A pending permission is part of the Goal lease even though the UI marks
 * `isGenerating=false`. It is owned only when the resolver, task, request and
 * active harness child all identify the same Goal run. */
export function resolveGoalPendingReviewOwnership(input: {
  goal: Pick<GoalDefinition, "status" | "sessionKey" | "ownerTurnId">;
  marker: HarnessRunMarker | null | undefined;
  currentWorkspace: string | null | undefined;
  currentSessionKey: string | null | undefined;
  agentStatus: string | null | undefined;
  actionRequest: GoalOwnedActionRequest | null | undefined;
  pendingReviewTaskId: number | null | undefined;
  hasPendingReviewResolver: boolean;
}): GoalRunAbortOwnershipDecision {
  if (input.goal.status !== "active" && input.goal.status !== "pausing") {
    return { owned: false, reason: "goal_not_running" };
  }
  if (
    input.agentStatus !== "pending_review" ||
    !input.hasPendingReviewResolver ||
    input.pendingReviewTaskId == null
  ) {
    return { owned: false, reason: "pending_review_mismatch" };
  }
  const harnessOwnership = resolveGoalHarnessOwnership(input);
  if (!harnessOwnership.owned) return harnessOwnership;

  const request = input.actionRequest;
  const actionRunId = String(input.marker?.activeRunId || input.marker?.runId || "").trim();
  if (
    request?.kind !== "tool_permission" ||
    request.status !== "pending" ||
    request.sessionKey !== input.marker?.sessionKey ||
    request.turnId !== input.marker?.turnId ||
    request.runId !== actionRunId ||
    request.taskId !== input.pendingReviewTaskId
  ) {
    return { owned: false, reason: "action_request_mismatch" };
  }
  return { owned: true, reason: "owned_goal_run" };
}
