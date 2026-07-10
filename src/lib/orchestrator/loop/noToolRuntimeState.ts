export interface AgentLoopNoToolRuntimeState {
  consecutiveNoToolCount: number;
  consecutiveEmptyResponseCount: number;
  emptyResponseCountThisTurn: number;
  consecutiveReasoningDominatedCount: number;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
}

export function createAgentLoopNoToolRuntimeState(): AgentLoopNoToolRuntimeState {
  return {
    consecutiveNoToolCount: 0,
    consecutiveEmptyResponseCount: 0,
    emptyResponseCountThisTurn: 0,
    consecutiveReasoningDominatedCount: 0,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  };
}

export function applyConsecutiveNoToolRuntimeState(
  state: AgentLoopNoToolRuntimeState,
  input: Pick<AgentLoopNoToolRuntimeState, "consecutiveNoToolCount">,
): AgentLoopNoToolRuntimeState {
  return {
    ...state,
    consecutiveNoToolCount: input.consecutiveNoToolCount,
  };
}

export function incrementConsecutiveNoToolRuntimeState(
  state: AgentLoopNoToolRuntimeState,
): AgentLoopNoToolRuntimeState {
  return {
    ...state,
    consecutiveNoToolCount: state.consecutiveNoToolCount + 1,
  };
}

export function resetConsecutiveNoToolRuntimeState(
  state: AgentLoopNoToolRuntimeState,
): AgentLoopNoToolRuntimeState {
  if (state.consecutiveNoToolCount === 0) return state;
  return {
    ...state,
    consecutiveNoToolCount: 0,
  };
}

export function applyReasoningDominatedNoToolRuntimeState(
  state: AgentLoopNoToolRuntimeState,
  input: Pick<AgentLoopNoToolRuntimeState, "consecutiveReasoningDominatedCount">,
): AgentLoopNoToolRuntimeState {
  return {
    ...state,
    consecutiveReasoningDominatedCount: input.consecutiveReasoningDominatedCount,
  };
}

export function applyEmptyResponseNoToolRuntimeState(
  state: AgentLoopNoToolRuntimeState,
  input: Pick<
    AgentLoopNoToolRuntimeState,
    | "consecutiveEmptyResponseCount"
    | "emptyResponseCountThisTurn"
    | "recoveringFromEmptyAssistantReplyAfterWrite"
  >,
): AgentLoopNoToolRuntimeState {
  return {
    ...state,
    consecutiveEmptyResponseCount: input.consecutiveEmptyResponseCount,
    emptyResponseCountThisTurn: input.emptyResponseCountThisTurn,
    recoveringFromEmptyAssistantReplyAfterWrite:
      input.recoveringFromEmptyAssistantReplyAfterWrite,
  };
}

export function resetEmptyAndReasoningNoToolRuntimeState(
  state: AgentLoopNoToolRuntimeState,
): AgentLoopNoToolRuntimeState {
  if (
    state.consecutiveEmptyResponseCount === 0 &&
    state.consecutiveReasoningDominatedCount === 0
  ) {
    return state;
  }
  return {
    ...state,
    consecutiveEmptyResponseCount: 0,
    consecutiveReasoningDominatedCount: 0,
  };
}

export function applyRecoveringFromEmptyAssistantReplyRuntimeState(
  state: AgentLoopNoToolRuntimeState,
  input: Pick<AgentLoopNoToolRuntimeState, "recoveringFromEmptyAssistantReplyAfterWrite">,
): AgentLoopNoToolRuntimeState {
  return {
    ...state,
    recoveringFromEmptyAssistantReplyAfterWrite:
      input.recoveringFromEmptyAssistantReplyAfterWrite,
  };
}
