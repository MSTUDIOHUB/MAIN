import type { GoalRecoveryState, GoalStatus } from "./goalState";

export type GoalInnerOutcomeStatus =
  | "completed"
  | "paused"
  | "stopped_no_action"
  | "stopped_no_output"
  | "aborted"
  | "error";

export type GoalInnerOutcomeAction =
  | "continue"
  | "recover"
  | "awaiting_input"
  | "paused"
  | "failed";

export interface GoalInnerOutcomeDecision {
  action: GoalInnerOutcomeAction;
  reason: string;
  normalizedCause?: string;
}

export const GOAL_RECOVERY_BLOCK_THRESHOLD = 3;

const USER_INPUT_RE = /(?:awaiting_user_choice|user[_\s-]?choice|user[_\s-]?confirm|permission|approval|required[_\s-]?input|pending_review|needs?[_\s-]?input)/i;
const USER_PAUSE_RE = /(?:user[_\s-]?(?:paused?|cancelled?)|goal[_\s-]?(?:paused?|cancelled?))/i;
const UNRECOVERABLE_RE = /(?:authentication|unauthori[sz]ed|forbidden|invalid[_\s-](?:configuration|schema)|unsupported[_\s-](?:provider|model|protocol)|model[_\s-]not[_\s-]found|workspace[_\s-]unavailable|no_active_goal)/i;
const RUNTIME_PAUSE_BOUNDARY_RE = /(?:execute_recovery_no_progress_limit|max_recovery_iterations_reached|agent_loop_no_terminal_outcome|repeated_failure_blocked)/i;
const PROTOCOL_NO_PROGRESS_RE = /(?:required_tool_call_(?:protocol_)?violation|required_tool_call_not_available|tool_call_protocol|protocol_no_progress)/i;

export function normalizeGoalRecoveryCause(
  status: GoalInnerOutcomeStatus | "exception" | "no_progress",
  reason: string,
): string {
  const text = String(reason || status)
    .trim()
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/g, "<id>")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ");
  if (/max_iterations/.test(text)) return "max_iterations_boundary";
  if (USER_INPUT_RE.test(text)) return "awaiting_user_input";
  if (PROTOCOL_NO_PROGRESS_RE.test(text)) return "protocol_no_progress";
  if (RUNTIME_PAUSE_BOUNDARY_RE.test(text)) return "runtime_pause_boundary";
  if (/stream|timeout|connection|gateway|temporar|provider/.test(text)) return "transient_provider_failure";
  if (/no[_\s-]?progress/.test(text) || status === "no_progress") return "no_progress";
  if (status === "stopped_no_output" || /no[_\s-]?output/.test(text)) return "no_output";
  if (status === "stopped_no_action" || /no[_\s-]?action/.test(text)) return "no_action";
  return `${status}:${text.slice(0, 160) || "unknown"}`;
}

export function resolveGoalInnerOutcomeDecision(input: {
  status?: GoalInnerOutcomeStatus;
  stopReason?: string;
  sliceBoundaryReached?: boolean;
  isAborted?: boolean;
}): GoalInnerOutcomeDecision {
  const status = input.status || "completed";
  const reason = String(input.stopReason || status).trim() || status;
  if (status === "aborted" || input.isAborted || USER_PAUSE_RE.test(reason)) {
    return { action: "paused", reason };
  }
  if (USER_INPUT_RE.test(reason)) {
    return { action: "awaiting_input", reason };
  }
  if (UNRECOVERABLE_RE.test(reason)) {
    return { action: "failed", reason };
  }
  if (status === "paused" || RUNTIME_PAUSE_BOUNDARY_RE.test(reason)) {
    return { action: "paused", reason };
  }
  if (status === "completed" || input.sliceBoundaryReached || reason === "max_iterations_boundary") {
    return { action: "continue", reason };
  }
  return {
    action: "recover",
    reason,
    normalizedCause: normalizeGoalRecoveryCause(status, reason),
  };
}

export function advanceGoalRecoveryState(input: {
  previous?: GoalRecoveryState;
  normalizedCause: string;
  reason: string;
  now?: number;
}): GoalRecoveryState {
  const sameCause = input.previous?.normalizedCause === input.normalizedCause;
  return {
    normalizedCause: input.normalizedCause,
    consecutiveCount: sameCause ? Math.max(0, input.previous?.consecutiveCount || 0) + 1 : 1,
    lastReason: input.reason,
    updatedAt: input.now ?? Date.now(),
  };
}

export function goalStatusForOutcomeAction(action: GoalInnerOutcomeAction): GoalStatus | null {
  if (action === "awaiting_input") return "awaiting_input";
  if (action === "paused") return "paused";
  if (action === "failed") return "failed";
  return null;
}
