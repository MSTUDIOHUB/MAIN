import type { TurnRunPhase } from "./turnRuntimeContract";

export const MAX_LATE_GUIDANCE_COMPLETION_CONTINUATIONS = 1 as const;

export type RuntimeGuidanceCompletionFenceDecision =
  | { readonly kind: "not_applicable" }
  | { readonly kind: "acquire_completion"; readonly alreadyFinalizing: boolean }
  | { readonly kind: "continue_with_guidance"; readonly guidanceId: string }
  | {
      readonly kind: "reject_completion";
      readonly reason:
        | "run_not_running"
        | "late_guidance_budget_exhausted";
    };

/**
 * Pure completion-fence policy. Store/runtime adapters own identity validation
 * and the atomic phase transition; this helper owns only the provider-neutral
 * decision once an exact Run snapshot has been established.
 */
export function decideRuntimeGuidanceCompletionFence(input: {
  readonly completionCandidate: boolean;
  readonly runStatus: "running" | "paused" | "aborted" | "completed" | null;
  readonly runPhase: TurnRunPhase | null;
  readonly exactPendingGuidanceId: string | null;
  readonly lateGuidanceContinuationsUsed: number;
}): RuntimeGuidanceCompletionFenceDecision {
  if (!input.completionCandidate) return { kind: "not_applicable" };
  if (input.runStatus !== "running") {
    return { kind: "reject_completion", reason: "run_not_running" };
  }

  const pendingGuidanceId = String(input.exactPendingGuidanceId || "").trim();
  if (pendingGuidanceId) {
    if (
      Math.max(0, Math.floor(input.lateGuidanceContinuationsUsed)) >=
      MAX_LATE_GUIDANCE_COMPLETION_CONTINUATIONS
    ) {
      return {
        kind: "reject_completion",
        reason: "late_guidance_budget_exhausted",
      };
    }
    return { kind: "continue_with_guidance", guidanceId: pendingGuidanceId };
  }

  return {
    kind: "acquire_completion",
    alreadyFinalizing: input.runPhase === "finalizing",
  };
}

/** Only an uncontested completion candidate may seal Guide admission. */
export function shouldTransitionRunToFinalizing(
  decision: RuntimeGuidanceCompletionFenceDecision,
): boolean {
  return decision.kind === "acquire_completion";
}
