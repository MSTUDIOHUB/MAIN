export interface ApprovedPlanRecoveryRuntimeState {
  approvedPlanNoProgressRecoveryAttempts: number;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  approvedPlanLongReasoningNoActionCount: number;
}

export function createApprovedPlanRecoveryRuntimeState(): ApprovedPlanRecoveryRuntimeState {
  return {
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanLongReasoningNoActionCount: 0,
  };
}

export function resetApprovedPlanHandoffRecoveryState(
  state: ApprovedPlanRecoveryRuntimeState,
): ApprovedPlanRecoveryRuntimeState {
  return {
    ...state,
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanLongReasoningNoActionCount: 0,
  };
}

export function resetApprovedPlanLongReasoningNoActionCount(
  state: ApprovedPlanRecoveryRuntimeState,
): ApprovedPlanRecoveryRuntimeState {
  return {
    ...state,
    approvedPlanLongReasoningNoActionCount: 0,
  };
}

export function applyApprovedPlanStrategySwitchRecoveryState(
  state: ApprovedPlanRecoveryRuntimeState,
  input: Pick<
    ApprovedPlanRecoveryRuntimeState,
    "approvedPlanNoProgressRecoveryAttempts" | "approvedPlanActionOnlyRecoveryActive"
  >,
): ApprovedPlanRecoveryRuntimeState {
  return {
    ...state,
    approvedPlanNoProgressRecoveryAttempts: input.approvedPlanNoProgressRecoveryAttempts,
    approvedPlanActionOnlyRecoveryActive: input.approvedPlanActionOnlyRecoveryActive,
  };
}

export function applyApprovedPlanActionOnlyRecoveryState(
  state: ApprovedPlanRecoveryRuntimeState,
  input: Pick<ApprovedPlanRecoveryRuntimeState, "approvedPlanActionOnlyRecoveryActive">,
): ApprovedPlanRecoveryRuntimeState {
  return {
    ...state,
    approvedPlanActionOnlyRecoveryActive: input.approvedPlanActionOnlyRecoveryActive,
  };
}

export function applyApprovedPlanNoToolRecoveryState(
  state: ApprovedPlanRecoveryRuntimeState,
  input: ApprovedPlanRecoveryRuntimeState,
): ApprovedPlanRecoveryRuntimeState {
  return {
    ...state,
    ...input,
  };
}

export function applyApprovedPlanToolResultRecoveryState(
  state: ApprovedPlanRecoveryRuntimeState,
  input: Pick<
    ApprovedPlanRecoveryRuntimeState,
    | "approvedPlanActionOnlyRecoveryActive"
    | "approvedPlanNoToolRecoveryFileReadActive"
    | "approvedPlanNoProgressRecoveryAttempts"
  >,
): ApprovedPlanRecoveryRuntimeState {
  return {
    ...state,
    approvedPlanActionOnlyRecoveryActive: input.approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive: input.approvedPlanNoToolRecoveryFileReadActive,
    approvedPlanNoProgressRecoveryAttempts: input.approvedPlanNoProgressRecoveryAttempts,
  };
}
