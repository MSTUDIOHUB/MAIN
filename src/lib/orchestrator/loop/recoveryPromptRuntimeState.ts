export interface AgentLoopRecoveryPromptRuntimeState {
  usedToolUnavailableRecoveryPrompt: boolean;
  usedPseudoToolCallRecoveryPrompt: boolean;
  usedMalformedToolUseRecoveryPrompt: boolean;
  usedLanguageMismatchRecoveryPrompt: boolean;
  usedExecuteConvergencePrompt: boolean;
  usedReadOnlyPermissionHardRecoveryPrompt: boolean;
}

export function createAgentLoopRecoveryPromptRuntimeState(): AgentLoopRecoveryPromptRuntimeState {
  return {
    usedToolUnavailableRecoveryPrompt: false,
    usedPseudoToolCallRecoveryPrompt: false,
    usedMalformedToolUseRecoveryPrompt: false,
    usedLanguageMismatchRecoveryPrompt: false,
    usedExecuteConvergencePrompt: false,
    usedReadOnlyPermissionHardRecoveryPrompt: false,
  };
}

export function markToolUnavailableRecoveryPromptUsed(
  state: AgentLoopRecoveryPromptRuntimeState,
): AgentLoopRecoveryPromptRuntimeState {
  if (state.usedToolUnavailableRecoveryPrompt) return state;
  return {
    ...state,
    usedToolUnavailableRecoveryPrompt: true,
  };
}

export function markPseudoToolCallRecoveryPromptUsed(
  state: AgentLoopRecoveryPromptRuntimeState,
): AgentLoopRecoveryPromptRuntimeState {
  if (state.usedPseudoToolCallRecoveryPrompt) return state;
  return {
    ...state,
    usedPseudoToolCallRecoveryPrompt: true,
  };
}

export function markLanguageMismatchRecoveryPromptUsed(
  state: AgentLoopRecoveryPromptRuntimeState,
): AgentLoopRecoveryPromptRuntimeState {
  if (state.usedLanguageMismatchRecoveryPrompt) return state;
  return {
    ...state,
    usedLanguageMismatchRecoveryPrompt: true,
  };
}

export function markReadOnlyPermissionHardRecoveryPromptUsed(
  state: AgentLoopRecoveryPromptRuntimeState,
): AgentLoopRecoveryPromptRuntimeState {
  if (state.usedReadOnlyPermissionHardRecoveryPrompt) return state;
  return {
    ...state,
    usedReadOnlyPermissionHardRecoveryPrompt: true,
  };
}

export function applyMalformedToolUseRecoveryPromptState(
  state: AgentLoopRecoveryPromptRuntimeState,
  input: Pick<AgentLoopRecoveryPromptRuntimeState, "usedMalformedToolUseRecoveryPrompt">,
): AgentLoopRecoveryPromptRuntimeState {
  return {
    ...state,
    usedMalformedToolUseRecoveryPrompt: input.usedMalformedToolUseRecoveryPrompt,
  };
}

export function applyExecuteConvergencePromptState(
  state: AgentLoopRecoveryPromptRuntimeState,
  input: Pick<AgentLoopRecoveryPromptRuntimeState, "usedExecuteConvergencePrompt">,
): AgentLoopRecoveryPromptRuntimeState {
  return {
    ...state,
    usedExecuteConvergencePrompt: input.usedExecuteConvergencePrompt,
  };
}

export function resetTransientRecoveryPromptRuntimeState(
  state: AgentLoopRecoveryPromptRuntimeState,
): AgentLoopRecoveryPromptRuntimeState {
  if (
    !state.usedToolUnavailableRecoveryPrompt &&
    !state.usedPseudoToolCallRecoveryPrompt &&
    !state.usedMalformedToolUseRecoveryPrompt &&
    !state.usedLanguageMismatchRecoveryPrompt &&
    !state.usedReadOnlyPermissionHardRecoveryPrompt
  ) {
    return state;
  }
  return {
    ...state,
    usedToolUnavailableRecoveryPrompt: false,
    usedPseudoToolCallRecoveryPrompt: false,
    usedMalformedToolUseRecoveryPrompt: false,
    usedLanguageMismatchRecoveryPrompt: false,
    usedReadOnlyPermissionHardRecoveryPrompt: false,
  };
}
