import { workspacePathsReferToSameFile } from "../../workspacePaths";

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
  crossIterationFileReads: Map<string, number>;
  successfulEditTargetsSinceVerification: Map<string, number>;
  lastNoProgressBatchSignature: string;
  noProgressBatchRepeatCount: number;
  consecutiveReadFileOnlyCacheHits: number;
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
>;

export type ToolFailureSignatureResult = {
  toolCallId: string;
  isError?: boolean;
  internalFeedback?: boolean;
};

export function createAgentLoopGuardRuntimeState(): AgentLoopGuardRuntimeState {
  return {
    crossIterationFileReads: new Map(),
    successfulEditTargetsSinceVerification: new Map(),
    lastNoProgressBatchSignature: "",
    noProgressBatchRepeatCount: 0,
    consecutiveReadFileOnlyCacheHits: 0,
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
  };
}

export function clearCrossIterationReadTrackingForTarget(
  state: AgentLoopGuardRuntimeState,
  target?: string | null,
): AgentLoopGuardRuntimeState {
  if (!target) return state;
  const trackedTarget = [...state.crossIterationFileReads.keys()].find((candidate) =>
    workspacePathsReferToSameFile(candidate, target)
  );
  if (!trackedTarget) return state;
  state.crossIterationFileReads.delete(trackedTarget);
  return state;
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
    if (result.isError) {
      state.failedToolCallCounts.set(
        signature,
        (state.failedToolCallCounts.get(signature) ?? 0) + 1,
      );
    } else {
      state.failedToolCallCounts.delete(signature);
    }
  }
  return state;
}
