import { normalizeRuntimeV2Checkpoint } from "./runtime-v2/checkpoint";
import { runtimeV2PendingGuidance } from "./runtime-v2/guidance";
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
  runtimeV2Guidance?: true;
  guidancePending?: boolean;
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
  runtimeV2Checkpoint?: unknown;
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

  const runtimeV2 = input.expectedOwner && input.runtimeV2Checkpoint
    ? normalizeRuntimeV2Checkpoint(input.runtimeV2Checkpoint, {
        workspaceKey: input.expectedOwner.workspaceKey ?? undefined,
        sessionKey: input.expectedOwner.sessionKey ?? undefined,
        sessionEpoch: input.expectedOwner.sessionEpoch ?? undefined,
        turnId: input.expectedOwner.turnId ?? undefined,
      })?.aggregate
    : null;
  if (runtimeV2 && !runtimeV2.terminalOutcome) {
    const run = runtimeV2.run;
    const target = input.runtimeOwnerObserved && run?.status === "running" &&
      run.phase !== "reviewing" && run.phase !== "finalizing" ? run.identity : null;
    return {
      mode: target ? "guidance_or_queue" : "queue_only",
      activeTurn: null,
      guidanceTarget: target,
      runtimeV2Guidance: true,
      guidancePending: !!runtimeV2PendingGuidance(runtimeV2),
      submitDecision: { kind: "reject", createsTurn: false, reason: "active_run_requires_explicit_ingress" },
      queueDecision,
      guidanceDecision: target
        ? { kind: "attach_guidance", createsTurn: false, admission: "active_run", target }
        : { kind: "reject", createsTurn: false, reason: "active_run_not_guidable" },
    };
  }

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
