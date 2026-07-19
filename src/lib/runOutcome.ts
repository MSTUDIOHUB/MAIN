export type AgentLoopResultKind = "success" | "partial" | "blocked" | "error";

/** Canonical reason shared by the producer and owner of a user-choice pause. */
export const USER_CHOICE_PAUSE_REASON = "awaiting_user_choice" as const;

export type AgentLoopPauseKind =
  | "action_required"
  | "no_action"
  | "no_output"
  | "recoverable";

export type AgentLoopOutcomeStatus = "completed" | "paused" | "aborted";

export type AgentLoopOutcome =
  | {
      status: "completed";
      reason: string;
      resultKind: AgentLoopResultKind;
    }
  | {
      status: "paused";
      reason: string;
      pauseKind: AgentLoopPauseKind;
    }
  | {
      status: "aborted";
      reason: string;
    };

/** Persisted and pre-contract values accepted only at compatibility boundaries. */
export type LegacyAgentLoopOutcomeStatus =
  | AgentLoopOutcomeStatus
  | "stopped_no_action"
  | "stopped_no_output"
  | "error"
  | "failed";

export interface LegacyAgentLoopOutcomeLike {
  status?: LegacyAgentLoopOutcomeStatus | string | null;
  reason?: string | null;
  resultKind?: AgentLoopResultKind | string | null;
  pauseKind?: AgentLoopPauseKind | string | null;
}

const RESULT_KINDS = new Set<AgentLoopResultKind>([
  "success",
  "partial",
  "blocked",
  "error",
]);

const PAUSE_KINDS = new Set<AgentLoopPauseKind>([
  "action_required",
  "no_action",
  "no_output",
  "recoverable",
]);

function normalizeReason(value: unknown, fallback: string): string {
  const reason = String(value || "").trim().replace(/\s+/g, " ");
  return reason || fallback;
}

function isResultKind(value: unknown): value is AgentLoopResultKind {
  return typeof value === "string" && RESULT_KINDS.has(value as AgentLoopResultKind);
}

function isPauseKind(value: unknown): value is AgentLoopPauseKind {
  return typeof value === "string" && PAUSE_KINDS.has(value as AgentLoopPauseKind);
}

/**
 * Infer only from stable runtime reason codes. This is a compatibility aid,
 * not natural-language routing; new producers must set pauseKind explicitly.
 */
function inferLegacyPauseKind(reason: string): AgentLoopPauseKind {
  const code = reason.trim().toLowerCase();
  if (
    code === "awaiting_user_choice" ||
    code.includes("approval_required") ||
    code.includes("permission_required") ||
    code.includes("review_required") ||
    code.includes("awaiting_input")
  ) {
    return "action_required";
  }
  if (code === "no_output" || code.includes("no_output")) return "no_output";
  if (code === "no_action" || code.includes("no_action")) return "no_action";
  return "recoverable";
}

export function completedAgentLoopOutcome(
  reason: string,
  resultKind: AgentLoopResultKind = "success",
): AgentLoopOutcome {
  return {
    status: "completed",
    reason: normalizeReason(reason, "agent_loop_completed"),
    resultKind,
  };
}

export function pausedAgentLoopOutcome(
  reason: string,
  pauseKind: AgentLoopPauseKind,
): AgentLoopOutcome {
  if (pauseKind === "no_output") {
    return completedAgentLoopOutcome(reason, "error");
  }
  if (pauseKind === "no_action") {
    return completedAgentLoopOutcome(reason, "blocked");
  }
  return {
    status: "paused",
    reason: normalizeReason(reason, "agent_loop_paused"),
    pauseKind,
  };
}

export function abortedAgentLoopOutcome(reason = "agent_loop_aborted"): AgentLoopOutcome {
  return {
    status: "aborted",
    reason: normalizeReason(reason, "agent_loop_aborted"),
  };
}

/**
 * Collapse historical terminal labels into the application contract.
 * Runtime errors close with an explicit error result; they are not a fourth
 * application-level terminal status and are never projected as success.
 */
export function normalizeAgentLoopOutcome(
  input: LegacyAgentLoopOutcomeLike,
): AgentLoopOutcome {
  const status = String(input?.status || "").trim().toLowerCase();
  const reason = normalizeReason(input?.reason, status || "agent_loop_unknown_outcome");

  if (status === "completed") {
    return completedAgentLoopOutcome(
      reason,
      isResultKind(input.resultKind) ? input.resultKind : "success",
    );
  }
  if (status === "paused") {
    const pauseKind = isPauseKind(input.pauseKind)
      ? input.pauseKind
      : inferLegacyPauseKind(reason);
    return pausedAgentLoopOutcome(reason, pauseKind);
  }
  if (status === "aborted") return abortedAgentLoopOutcome(reason);
  if (status === "stopped_no_action") {
    return completedAgentLoopOutcome(reason, "blocked");
  }
  if (status === "stopped_no_output") {
    return completedAgentLoopOutcome(reason, "error");
  }
  if (status === "error" || status === "failed") {
    return completedAgentLoopOutcome(reason, "error");
  }
  return completedAgentLoopOutcome(
    normalizeReason(input?.reason, `agent_loop_unknown_outcome:${status || "missing"}`),
    "error",
  );
}

export function isSuccessfulAgentLoopOutcome(
  outcome: AgentLoopOutcome,
): outcome is Extract<AgentLoopOutcome, { status: "completed" }> {
  return outcome.status === "completed" && outcome.resultKind === "success";
}

export function isErrorAgentLoopOutcome(
  outcome: AgentLoopOutcome,
): outcome is Extract<AgentLoopOutcome, { status: "completed" }> {
  return outcome.status === "completed" && outcome.resultKind === "error";
}
