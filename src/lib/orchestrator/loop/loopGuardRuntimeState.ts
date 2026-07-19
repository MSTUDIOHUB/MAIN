import { classifyCommandResultOutcome } from "../../planEvidence";
import type { ExecuteNoProgressStrategyPivot } from "../../executeRecoveryTools";

export type RecentLoopGuardToolCall = {
  name: string;
  argsKey: string;
};

export type RecentTargetProgressToolCall = {
  name: string;
  targetKey: string;
  family: "edit" | "verify" | "other";
};

export interface AgentLoopGuardRuntimeState {
  lastNoProgressBatchSignature: string;
  noProgressBatchRepeatCount: number;
  consecutiveReadFileOnlyCacheHits: number;
  lastReadFileOnlyObservationSignature: string;
  noProgressStrategyPivots: ExecuteNoProgressStrategyPivot[];
  recentToolCalls: RecentLoopGuardToolCall[];
  recentTargetToolCalls: RecentTargetProgressToolCall[];
  repeatGuardRecoveredSignatures: Set<string>;
  targetProgressGuardRecoveredSignatures: Set<string>;
  failedToolCallCounts: Map<string, number>;
}

export type NoProgressLoopTrackingState = Pick<
  AgentLoopGuardRuntimeState,
  | "lastNoProgressBatchSignature"
  | "noProgressBatchRepeatCount"
  | "consecutiveReadFileOnlyCacheHits"
  | "lastReadFileOnlyObservationSignature"
  | "noProgressStrategyPivots"
>;

export type ToolFailureSignatureResult = {
  toolCallId: string;
  name?: string;
  content?: string;
  isError?: boolean;
  internalFeedback?: boolean;
};

export function createAgentLoopGuardRuntimeState(): AgentLoopGuardRuntimeState {
  return {
    lastNoProgressBatchSignature: "",
    noProgressBatchRepeatCount: 0,
    consecutiveReadFileOnlyCacheHits: 0,
    lastReadFileOnlyObservationSignature: "",
    noProgressStrategyPivots: [],
    recentToolCalls: [],
    recentTargetToolCalls: [],
    repeatGuardRecoveredSignatures: new Set(),
    targetProgressGuardRecoveredSignatures: new Set(),
    failedToolCallCounts: new Map(),
  };
}

export function getNoProgressTrackingRuntimeState(
  state: AgentLoopGuardRuntimeState,
): NoProgressLoopTrackingState {
  return {
    lastNoProgressBatchSignature: state.lastNoProgressBatchSignature,
    noProgressBatchRepeatCount: state.noProgressBatchRepeatCount,
    consecutiveReadFileOnlyCacheHits: state.consecutiveReadFileOnlyCacheHits,
    lastReadFileOnlyObservationSignature: state.lastReadFileOnlyObservationSignature,
    noProgressStrategyPivots: [...state.noProgressStrategyPivots],
  };
}

export function applyNoProgressTrackingRuntimeState(
  state: AgentLoopGuardRuntimeState,
  input: NoProgressLoopTrackingState,
): AgentLoopGuardRuntimeState {
  return {
    ...state,
    lastNoProgressBatchSignature: input.lastNoProgressBatchSignature,
    noProgressBatchRepeatCount: input.noProgressBatchRepeatCount,
    consecutiveReadFileOnlyCacheHits: input.consecutiveReadFileOnlyCacheHits,
    lastReadFileOnlyObservationSignature: input.lastReadFileOnlyObservationSignature,
    noProgressStrategyPivots: [...(input.noProgressStrategyPivots || [])],
  };
}

export function applyToolFailureSignatureRuntimeState(
  state: AgentLoopGuardRuntimeState,
  input: {
    results: ToolFailureSignatureResult[];
    toolFailureSignatures: Map<string, string>;
  },
): AgentLoopGuardRuntimeState {
  for (const result of input.results) {
    const signature = input.toolFailureSignatures.get(result.toolCallId);
    if (!signature) continue;
    if (result.internalFeedback) continue;
    const outcome = result.isError
      ? "failed"
      : classifyCommandResultOutcome(result.name || "", result.content || "");
    if (outcome === "failed") {
      state.failedToolCallCounts.set(
        signature,
        (state.failedToolCallCounts.get(signature) ?? 0) + 1,
      );
    } else if (outcome === "succeeded") {
      state.failedToolCallCounts.delete(signature);
    }
  }
  return state;
}

/** A real structured mutation starts a new read/fix/verify progress epoch. */
export function resetLoopGuardRuntimeStateAfterMutation(
  state: AgentLoopGuardRuntimeState,
): AgentLoopGuardRuntimeState {
  state.lastNoProgressBatchSignature = "";
  state.noProgressBatchRepeatCount = 0;
  state.consecutiveReadFileOnlyCacheHits = 0;
  state.lastReadFileOnlyObservationSignature = "";
  state.noProgressStrategyPivots.length = 0;
  state.recentToolCalls.length = 0;
  state.recentTargetToolCalls.length = 0;
  state.repeatGuardRecoveredSignatures.clear();
  state.targetProgressGuardRecoveredSignatures.clear();
  state.failedToolCallCounts.clear();
  return state;
}
