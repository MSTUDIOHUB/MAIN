export type StoppedRunDisposition =
  | "plan_review"
  | "staged_completion"
  | "committed_pause"
  | "assistant_pause";

/**
 * Resolve terminal ownership after an assistant phase stops. A review-ready
 * Plan is a paused Run inside a still-open Turn and therefore must supersede
 * any generic completion staged by a final-text compatibility path.
 */
export function resolveStoppedRunDisposition(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  status: string;
  hasStagedTurnCompletion: boolean;
  committedPauseReason?: string | null;
}): StoppedRunDisposition {
  if (
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    input.status === "pending_review"
  ) {
    return "plan_review";
  }
  if (input.hasStagedTurnCompletion) return "staged_completion";
  if (input.committedPauseReason) return "committed_pause";
  return "assistant_pause";
}
