import {
  decideTurnIngress,
  type CanonicalRunIdentity,
  type CanonicalTurnRuntimeState,
  type TurnIngressDecision,
  type TurnStrategy,
} from "./turnRuntimeContract";
import {
  normalizeTurnRuntimeCheckpoint,
  type TurnRuntimeCheckpointExpectedOwner,
} from "./turnRuntimeCheckpoint";

export type TurnIngressMode = "submit" | "queue_only" | "guidance_or_queue";

export interface TurnIngressAvailability {
  mode: TurnIngressMode;
  activeTurn: CanonicalTurnRuntimeState | null;
  guidanceTarget: CanonicalRunIdentity | null;
  submitDecision: TurnIngressDecision;
  queueDecision: TurnIngressDecision;
  guidanceDecision: TurnIngressDecision;
}

/** Keep all providers and UI surfaces on the same four canonical strategies. */
export function resolveTurnStrategyFromIntent(
  intent: unknown,
  legacyMode?: unknown,
): TurnStrategy {
  const normalized = String(intent || legacyMode || "").trim();
  if (normalized === "plan") return "plan";
  if (normalized === "goal") return "goal";
  if (normalized === "execute" || normalized === "studio_workflow" || legacyMode === "edit") {
    return "execute";
  }
  return "chat";
}

/**
 * Production ingress selector. A model stream, pending request, or other live
 * owner without an exact canonical checkpoint is Queue-only (fail closed).
 */
export function selectTurnIngressAvailability(input: {
  checkpoint: unknown;
  expectedOwner: TurnRuntimeCheckpointExpectedOwner | null;
  strategy: TurnStrategy;
  runtimeOwnerObserved: boolean;
}): TurnIngressAvailability {
  const checkpoint = input.expectedOwner
    ? normalizeTurnRuntimeCheckpoint(input.checkpoint, {
        expectedOwner: input.expectedOwner,
      })
    : null;
  const activeTurn = checkpoint?.canonical || null;
  const submitDecision = decideTurnIngress({
    mode: "submit",
    strategy: input.strategy,
    activeTurn,
  });
  const queueDecision = decideTurnIngress({
    mode: "queue",
    strategy: input.strategy,
    activeTurn,
  });
  const guidanceDecision = decideTurnIngress({
    mode: "guidance",
    activeTurn,
  });

  if (submitDecision.kind === "reject") {
    if (guidanceDecision.kind === "attach_guidance") {
      return {
        mode: "guidance_or_queue",
        activeTurn,
        guidanceTarget: guidanceDecision.target,
        submitDecision,
        queueDecision,
        guidanceDecision,
      };
    }
    return {
      mode: "queue_only",
      activeTurn,
      guidanceTarget: null,
      submitDecision,
      queueDecision,
      guidanceDecision,
    };
  }

  if (input.runtimeOwnerObserved) {
    return {
      mode: "queue_only",
      activeTurn,
      guidanceTarget: null,
      submitDecision,
      queueDecision,
      guidanceDecision,
    };
  }

  return {
    mode: "submit",
    activeTurn,
    guidanceTarget: null,
    submitDecision,
    queueDecision,
    guidanceDecision,
  };
}
