import {
  normalizeExecuteRecoveryMode,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";

export const MAX_EXECUTE_RECOVERY_ITERATIONS = 6;

export interface ExecuteRecoveryRuntimeState {
  mode: ExecuteRecoveryMode;
  reason: string;
  attempts: number;
  iterationCount: number;
  consecutiveBlockedReadFileCount: number;
  repeatedEditValidationAttempts: number;
}

export function createExecuteRecoveryRuntimeState(input: {
  workflowMode: "chat" | "edit" | "plan";
  forcedMode?: ExecuteRecoveryMode | null;
}): ExecuteRecoveryRuntimeState {
  const mode = input.workflowMode === "edit"
    ? normalizeExecuteRecoveryMode(input.forcedMode)
    : "normal";
  return {
    mode,
    reason: mode === "normal" ? "" : "forced_execute_recovery",
    attempts: mode === "normal" ? 0 : 1,
    iterationCount: 0,
    consecutiveBlockedReadFileCount: 0,
    repeatedEditValidationAttempts: 0,
  };
}

export function activateExecuteRecoveryRuntimeState(
  state: ExecuteRecoveryRuntimeState,
  input: {
    mode: Exclude<ExecuteRecoveryMode, "normal">;
    reason: string;
  },
): ExecuteRecoveryRuntimeState {
  return {
    ...state,
    mode: normalizeExecuteRecoveryMode(input.mode) as Exclude<ExecuteRecoveryMode, "normal">,
    reason: input.reason,
    attempts: state.attempts + 1,
  };
}

export function clearExecuteRecoveryRuntimeState(
  state: ExecuteRecoveryRuntimeState,
): ExecuteRecoveryRuntimeState {
  return {
    ...state,
    mode: "normal",
    reason: "",
    attempts: 0,
    iterationCount: 0,
  };
}

export function advanceExecuteRecoveryRuntimeIteration(
  state: ExecuteRecoveryRuntimeState,
): {
  state: ExecuteRecoveryRuntimeState;
  maxIterations: number;
  reachedMaxIterations: boolean;
} {
  if (state.mode === "normal") {
    return {
      state,
      maxIterations: MAX_EXECUTE_RECOVERY_ITERATIONS,
      reachedMaxIterations: false,
    };
  }

  const nextState = {
    ...state,
    iterationCount: state.iterationCount + 1,
  };
  return {
    state: nextState,
    maxIterations: MAX_EXECUTE_RECOVERY_ITERATIONS,
    reachedMaxIterations: nextState.iterationCount >= MAX_EXECUTE_RECOVERY_ITERATIONS,
  };
}

export function applyCrossIterationReadFileRecoveryState(
  state: ExecuteRecoveryRuntimeState,
  input: {
    mode: ExecuteRecoveryMode;
    reason: string;
    consecutiveBlockedReadFileCount: number;
  },
): ExecuteRecoveryRuntimeState {
  return {
    ...state,
    mode: input.mode,
    reason: input.reason,
    consecutiveBlockedReadFileCount: input.consecutiveBlockedReadFileCount,
  };
}

export function setRepeatedEditValidationRecoveryAttempts(
  state: ExecuteRecoveryRuntimeState,
  repeatedEditValidationAttempts: number,
): ExecuteRecoveryRuntimeState {
  return {
    ...state,
    repeatedEditValidationAttempts,
  };
}

export function buildExecuteRecoveryMaxIterationsPrompt(input: {
  language: string;
  maxIterations?: number;
}): string {
  const maxIterations = input.maxIterations ?? MAX_EXECUTE_RECOVERY_ITERATIONS;
  return input.language === "zh"
    ? `[System: 恢复模式已持续 ${maxIterations} 次迭代未取得进展。已自动退出恢复模式，所有工具已恢复可用。请重新读取目标文件（使用 start_line/max_lines 限定范围），然后执行修改。如果确实无法完成，请向用户说明原因。]`
    : `[System: Recovery mode has persisted for ${maxIterations} iterations without progress. Exiting recovery - all tools are now available. Re-read the target file (with start_line/max_lines), then make your edit. If genuinely blocked, explain why to the user.]`;
}
