import {
  normalizeExecuteRecoveryMode,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import { workspacePathsReferToSameFile } from "../../workspacePaths";

export const MAX_EXECUTE_RECOVERY_ITERATIONS = 6;

export interface ExecuteRecoveryRuntimeState {
  mode: ExecuteRecoveryMode;
  reason: string;
  /** File identity carried by the complete context -> mutation -> validation transaction. */
  expectedTarget: string | null;
  attempts: number;
  iterationCount: number;
  consecutiveBlockedReadFileCount: number;
  repeatedEditValidationAttempts: number;
}

export type ExecuteRecoveryPhaseTransition =
  | "none"
  | "context_to_mutation"
  | "mutation_to_validation"
  | "validation_to_normal";

export interface ExecuteRecoveryObservation {
  expectedTarget?: string | null;
  freshReadTarget?: string | null;
  mutationTarget?: string | null;
  validationTarget?: string | null;
}

export interface ForcedExecuteRecoveryRuntimeState {
  mode: ExecuteRecoveryMode;
  reason?: string | null;
  expectedTarget?: string | null;
}

export function createExecuteRecoveryRuntimeState(input: {
  workflowMode: "chat" | "edit" | "plan";
  forcedMode?: ExecuteRecoveryMode | null;
  forcedState?: ForcedExecuteRecoveryRuntimeState | null;
}): ExecuteRecoveryRuntimeState {
  const mode = input.workflowMode === "edit"
    ? normalizeExecuteRecoveryMode(input.forcedState?.mode ?? input.forcedMode)
    : "normal";
  return {
    mode,
    reason: mode === "normal"
      ? ""
      : input.forcedState?.reason?.trim() || "forced_execute_recovery",
    expectedTarget: mode === "normal"
      ? null
      : input.forcedState?.expectedTarget?.trim() || null,
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
    expectedTarget?: string | null;
  },
): ExecuteRecoveryRuntimeState {
  return {
    ...state,
    mode: normalizeExecuteRecoveryMode(input.mode) as Exclude<ExecuteRecoveryMode, "normal">,
    reason: input.reason,
    expectedTarget: input.expectedTarget?.trim() || state.expectedTarget,
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
    expectedTarget: null,
    attempts: 0,
    iterationCount: 0,
  };
}

/**
 * Advance an active recovery transaction from observed tool evidence. Phase
 * transitions do not consume another recovery attempt: they are progress in
 * the same transaction. Only a verified validation result may return to the
 * normal tool surface.
 */
export function transitionExecuteRecoveryRuntimeState(
  state: ExecuteRecoveryRuntimeState,
  observation: ExecuteRecoveryObservation,
): {
  state: ExecuteRecoveryRuntimeState;
  transition: ExecuteRecoveryPhaseTransition;
  target: string | null;
  consumedExpectedRead: boolean;
} {
  if (state.mode === "normal") {
    return { state, transition: "none", target: null, consumedExpectedRead: false };
  }

  const observedExpectedTarget = observation.expectedTarget?.trim() || null;
  const expectedTarget = state.expectedTarget || observedExpectedTarget;
  const transactionState = expectedTarget && expectedTarget !== state.expectedTarget
    ? { ...state, expectedTarget }
    : state;

  if (state.mode === "patch_recovery_read" && observation.freshReadTarget) {
    const contextTarget = expectedTarget || observation.freshReadTarget;
    if (!workspacePathsReferToSameFile(observation.freshReadTarget, contextTarget)) {
      return {
        state: transactionState,
        transition: "none",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
    return {
      state: {
        ...transactionState,
        mode: "mutation_first",
        reason: "recovery_context_observed",
        expectedTarget: contextTarget,
      },
      transition: "context_to_mutation",
      target: contextTarget,
      consumedExpectedRead: true,
    };
  }

  if ((state.mode === "mutation_first" || state.mode === "action_only") && observation.mutationTarget) {
    const mutationTarget = expectedTarget || observation.mutationTarget;
    if (!workspacePathsReferToSameFile(observation.mutationTarget, mutationTarget)) {
      return {
        state: transactionState,
        transition: "none",
        target: mutationTarget,
        consumedExpectedRead: false,
      };
    }
    return {
      state: {
        ...transactionState,
        mode: "validation_only",
        reason: "recovery_mutation_observed",
        expectedTarget: mutationTarget,
      },
      transition: "mutation_to_validation",
      target: mutationTarget,
      consumedExpectedRead: false,
    };
  }

  if (state.mode === "validation_only" && observation.validationTarget) {
    return {
      state: clearExecuteRecoveryRuntimeState(transactionState),
      transition: "validation_to_normal",
      // Validation is often a workspace command rather than a file-targeted
      // operation. Clear bookkeeping against the transaction file identity.
      target: expectedTarget || observation.validationTarget,
      consumedExpectedRead: false,
    };
  }

  return {
    state: transactionState,
    transition: "none",
    target: expectedTarget,
    consumedExpectedRead: false,
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
    expectedTarget: input.mode === "normal" ? null : state.expectedTarget,
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
