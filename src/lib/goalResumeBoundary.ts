import {
  isConversationTurnRuntimeClosed,
  type ConversationTurn,
} from "./workflowModels";
import type {
  GoalDefinition,
  GoalProgress,
  GoalRuntimeSnapshot,
  GoalStatus,
} from "./goalState";
import { isTerminalTurnEvent, type MainThreadEvent } from "./turnEvents";

const LEGACY_CLOSED_TURN_STATUSES = new Set([
  "done",
  "completed_with_changes",
  "stopped_no_action",
  "stopped_no_output",
  "error",
]);

const GOAL_RESUMABLE_STATUSES = new Set([
  "paused",
  "awaiting_input",
  "blocked",
]);

interface GoalContinuationOwnerIdentity {
  goalId: string;
  goalRevision: number;
  ownerTurnId: string;
}

export interface AcceptedGoalContinuationState {
  previousStatus: GoalStatus;
  transitioned: boolean;
  goal: GoalDefinition;
  progress: GoalProgress;
  runtime: GoalRuntimeSnapshot;
}

/**
 * Activate a Goal only after the continuation has acquired its exact Run
 * lease. Until then a manual resume remains paused, so a rejected or queued
 * submission cannot consume budget, erase recovery state, or publish a false
 * `goal.state_changed -> active` fact.
 */
export function buildAcceptedGoalContinuationState(input: {
  goal: GoalDefinition | null | undefined;
  progress: GoalProgress | null | undefined;
  runtime: GoalRuntimeSnapshot | null | undefined;
  authorization: GoalContinuationOwnerIdentity;
  ownerTurnId: string;
  nowMs?: number;
}): AcceptedGoalContinuationState | null {
  const goal = input.goal;
  const progress = input.progress;
  const ownerTurnId = String(input.ownerTurnId || "").trim();
  if (!goal || !progress || !ownerTurnId) return null;

  const goalRevision = Math.max(1, Number(goal.revision) || 1);
  const currentOwnerTurnId = String(goal.ownerTurnId || "").trim();
  const alreadyActiveForOwner = goal.status === "active" &&
    currentOwnerTurnId === ownerTurnId;
  if (
    input.authorization.goalId !== goal.id ||
    input.authorization.goalRevision !== goalRevision ||
    String(input.authorization.ownerTurnId || "").trim() !== currentOwnerTurnId ||
    progress.goalId !== goal.id ||
    (!GOAL_RESUMABLE_STATUSES.has(goal.status) && !alreadyActiveForOwner)
  ) {
    return null;
  }

  const timestampMs = input.nowMs ?? Date.now();
  const previousStatus = goal.status;
  if (alreadyActiveForOwner) {
    const runtimeMatches = input.runtime?.goal.id === goal.id &&
      Math.max(1, Number(input.runtime.goal.revision) || 1) === goalRevision;
    return {
      previousStatus,
      transitioned: false,
      goal,
      progress,
      runtime: runtimeMatches
        ? input.runtime!
        : {
            schemaVersion: 3,
            goal,
            progress,
            status: "active",
            phase: "re_plan",
            updatedAt: timestampMs,
          },
    };
  }
  const nextGoal: GoalDefinition = {
    ...goal,
    ownerTurnId,
    status: "active",
    updatedAt: timestampMs,
  };
  const clearBlockedAudit = previousStatus === "blocked";
  const clearStopBoundary = clearBlockedAudit ||
    progress.stopClass === "awaiting_input" ||
    progress.stopClass === "user_paused" ||
    progress.stopClass === "blocked";
  const usage = progress.usage || {
    modelIterations: 0,
    toolCalls: 0,
    totalTokensUsed: progress.totalTokensUsed || 0,
    activeDurationMs: 0,
    activeStartedAt: null,
    estimatedTokens: progress.estimatedTokens === true,
  };
  const nextProgress: GoalProgress = {
    ...progress,
    pauseReason: undefined,
    lastUserConfirmedIteration: progress.totalIterationsUsed || 0,
    ...(clearBlockedAudit
      ? {
          recoveryState: undefined,
          recoveryAuditStartIteration: progress.totalIterationsUsed || 0,
        }
      : {}),
    ...(clearStopBoundary
      ? {
          lastStopReason: undefined,
          stopClass: undefined,
        }
      : {}),
    usage: {
      ...usage,
      activeStartedAt: timestampMs,
    },
    lastUpdatedAt: timestampMs,
  };
  const runtimeMatches = input.runtime?.goal.id === goal.id &&
    Math.max(1, Number(input.runtime.goal.revision) || 1) === goalRevision;
  const nextRuntime: GoalRuntimeSnapshot = {
    ...(runtimeMatches
      ? input.runtime!
      : {
          schemaVersion: 3 as const,
          goal: nextGoal,
          progress: nextProgress,
          status: "active" as const,
          phase: "re_plan" as const,
          updatedAt: timestampMs,
        }),
    goal: nextGoal,
    progress: nextProgress,
    status: "active",
    phase: "re_plan",
    pauseReason: undefined,
    stopClass: nextProgress.stopClass,
    updatedAt: timestampMs,
  };

  return {
    previousStatus,
    transitioned: true,
    goal: nextGoal,
    progress: nextProgress,
    runtime: nextRuntime,
  };
}

function createGoalResumeTurnId(nowMs: number): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `turn-goal-resume-${uuid}`
    : `turn-goal-resume-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isGoalOwnerTurnClosed(input: {
  ownerTurn?: ConversationTurn | null;
  ownerTurnId?: string | null;
  sessionKey: string;
  runtimeEvents: MainThreadEvent[];
}): boolean {
  const ownerTurnId = String(input.ownerTurnId || input.ownerTurn?.id || "").trim();
  if (!ownerTurnId || !input.ownerTurn) return true;
  if (isConversationTurnRuntimeClosed(input.ownerTurn.runtimeOutcome)) return true;
  if (LEGACY_CLOSED_TURN_STATUSES.has(input.ownerTurn.status)) return true;
  return input.runtimeEvents.some((event) =>
    isTerminalTurnEvent(event) &&
    event.threadId === input.sessionKey &&
    event.turnId === ownerTurnId
  );
}

/**
 * A Goal may outlive the Turn that most recently worked on it. Only a genuine
 * pause can continue as a child Run in that Turn; a closed or missing owner
 * gets a fresh visible continuation Turn and the old terminal remains immutable.
 */
export function resolveGoalResumeTurnBoundary(input: {
  ownerTurnId?: string | null;
  sessionKey: string;
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
  nowMs?: number;
  createTurnId?: () => string;
}): {
  turnId: string;
  previousOwnerTurnId: string | null;
  parentRunId: string | null;
  reuseCurrentTurn: boolean;
  createVisibleTurnForHiddenMessage: boolean;
  reason: "paused_owner" | "closed_owner" | "missing_owner" | "non_paused_owner";
} {
  const previousOwnerTurnId = String(input.ownerTurnId || "").trim() || null;
  const ownerTurn = previousOwnerTurnId
    ? input.conversationTurns.find((turn) => turn.id === previousOwnerTurnId) || null
    : null;
  const ownerClosed = isGoalOwnerTurnClosed({
    ownerTurn,
    ownerTurnId: previousOwnerTurnId,
    sessionKey: input.sessionKey,
    runtimeEvents: input.runtimeEvents,
  });
  const pausedOwner = !!ownerTurn && !ownerClosed && (
    ownerTurn.runtimeOutcome?.status === "paused" ||
    (!ownerTurn.runtimeOutcome && (
      ownerTurn.status === "paused" ||
      ownerTurn.status === "awaiting_input" ||
      ownerTurn.status === "awaiting_approval"
    ))
  );
  if (previousOwnerTurnId && pausedOwner) {
    const parentRunId = String(ownerTurn.runtimeOutcome?.runId || "").trim() || null;
    return {
      turnId: previousOwnerTurnId,
      previousOwnerTurnId,
      parentRunId,
      reuseCurrentTurn: true,
      createVisibleTurnForHiddenMessage: false,
      reason: "paused_owner",
    };
  }

  return {
    turnId: input.createTurnId?.() || createGoalResumeTurnId(input.nowMs ?? Date.now()),
    previousOwnerTurnId,
    parentRunId: null,
    reuseCurrentTurn: false,
    createVisibleTurnForHiddenMessage: true,
    reason: !ownerTurn
      ? "missing_owner"
      : ownerClosed
      ? "closed_owner"
      : "non_paused_owner",
  };
}

/** Goal controls follow the durable Goal lifecycle after its owner Turn closes. */
export function shouldDetachGoalPresentationFromOwnerTurn(input: {
  goalStatus: string;
  ownerTurn?: ConversationTurn | null;
  ownerTurnId?: string | null;
  sessionKey: string;
  runtimeEvents: MainThreadEvent[];
}): boolean {
  return GOAL_RESUMABLE_STATUSES.has(String(input.goalStatus || "")) &&
    isGoalOwnerTurnClosed(input);
}
