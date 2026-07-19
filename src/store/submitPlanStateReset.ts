import {
  reducePlanLifecycle,
  type PlanLifecycleState,
} from "../lib/planLifecycle";

export interface ApplySubmitPlanStateResetInput<TNormalizedStreamState> {
  shouldResetPlanState: boolean;
  defaultNormalizedStreamState: TNormalizedStreamState;
  planLifecycle: PlanLifecycleState;
  now?: number;
  setState: (patch: any) => void;
}

export function applySubmitPlanStateReset<TNormalizedStreamState>(
  input: ApplySubmitPlanStateResetInput<TNormalizedStreamState>,
): boolean {
  if (!input.shouldResetPlanState) return false;

  const lifecycleReset = reducePlanLifecycle(input.planLifecycle, {
    type: "reset",
    expectedVersion: input.planLifecycle.version,
    at: input.now ?? Date.now(),
  });
  if (lifecycleReset.disposition === "rejected") return false;

  input.setState({
    planLifecycle: lifecycleReset.state,
    isPlanApproved: false,
    planApprovalChoice: null,
    pendingPlanApprovalHandoff: null,
    planApprovalExecutionStartedForTurnId: null,
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
