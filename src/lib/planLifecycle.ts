import type { NormalizedStreamState, PlanArtifact, PlanExecutionEvidenceEntry, PlanStage, PlanTask } from "./workflowModels";

export interface ClosedActivePlanRuntimePatch {
  isPlanApproved: false;
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planExecutionEvidenceLedger: PlanExecutionEvidenceEntry[];
  planExecutionEvidenceCount: 0;
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
    planStage: "idle",
    showPlanPanel: false,
  };
}
