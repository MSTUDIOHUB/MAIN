export type RecentSuccessfulProjectWrite = {
  name: string;
  target: string;
} | null;

export interface AgentLoopEvidenceRuntimeState {
  recentSuccessfulProjectWrite: RecentSuccessfulProjectWrite;
  sawExecuteOperationEvidence: boolean;
  lastAssistantTextForCheckpoint: string;
}

export function createAgentLoopEvidenceRuntimeState(): AgentLoopEvidenceRuntimeState {
  return {
    recentSuccessfulProjectWrite: null,
    sawExecuteOperationEvidence: false,
    lastAssistantTextForCheckpoint: "",
  };
}

export function markExecuteOperationEvidenceRuntimeState(
  state: AgentLoopEvidenceRuntimeState,
): AgentLoopEvidenceRuntimeState {
  if (state.sawExecuteOperationEvidence) return state;
  return {
    ...state,
    sawExecuteOperationEvidence: true,
  };
}

export function applyRecentSuccessfulProjectWriteRuntimeState(
  state: AgentLoopEvidenceRuntimeState,
  input: Pick<AgentLoopEvidenceRuntimeState, "recentSuccessfulProjectWrite">,
): AgentLoopEvidenceRuntimeState {
  return {
    ...state,
    recentSuccessfulProjectWrite: input.recentSuccessfulProjectWrite,
  };
}

export function setLastAssistantTextForCheckpointRuntimeState(
  state: AgentLoopEvidenceRuntimeState,
  lastAssistantTextForCheckpoint: string,
): AgentLoopEvidenceRuntimeState {
  return {
    ...state,
    lastAssistantTextForCheckpoint,
  };
}
