export interface ApplySubmitPlanStateResetInput<TNormalizedStreamState> {
  shouldResetPlanState: boolean;
  defaultNormalizedStreamState: TNormalizedStreamState;
  setState: (patch: any) => void;
}

export function applySubmitPlanStateReset<TNormalizedStreamState>(
  input: ApplySubmitPlanStateResetInput<TNormalizedStreamState>,
): boolean {
  if (!input.shouldResetPlanState) return false;

  input.setState({
    isPlanApproved: false,
    planApprovalChoice: null,
    pendingPlanApprovalHandoff: null,
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: null,
    normalizedStreamState: input.defaultNormalizedStreamState,
    planArtifacts: [],
    planTasks: [],
    planStage: "idle" as const,
    clearedPlanTurnId: null,
    currentTurnExecutionConsent: { turnId: null, granted: false },
  });
  return true;
}
