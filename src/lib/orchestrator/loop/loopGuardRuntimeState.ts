import { classifyCommandResultOutcome } from "../../planEvidence";

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
