import type { NormalizedStreamState, PlanArtifact, PlanExecutionEvidenceEntry, PlanExecutionProgressSnapshot, PlanStage, PlanTask } from "./workflowModels";

export interface ClosedActivePlanRuntimePatch {
  isPlanApproved: false;
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planExecutionEvidenceLedger: PlanExecutionEvidenceEntry[];
  planExecutionEvidenceCount: 0;
  planAutoResumeCount: 0;
  planExecutionProgressSnapshot: PlanExecutionProgressSnapshot | null;
  planStage: PlanStage;
  showPlanPanel: false;
  normalizedStreamState?: NormalizedStreamState;
}

export function buildClosedActivePlanRuntimePatch(): ClosedActivePlanRuntimePatch {
  return {
    isPlanApproved: false,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: null,
    planStage: "idle",
    showPlanPanel: false,
  };
}
