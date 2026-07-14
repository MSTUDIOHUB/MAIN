import type { PlanRuntimePhase } from "../../workflowModels";

/**
 * `needs_evidence` serves two different runtime transactions. A model-authored
 * draft may use structural facts and infer the remaining relationships, while
 * deterministic runtime materialization must not infer a diagnosis. Keep the
 * recovery objective explicit so phase transitions cannot silently swap those
 * two evidence thresholds.
 */
export type PlanEvidenceRecoveryObjective =
  | "none"
  | "model_draft"
  | "deterministic_closure";

export interface PlanLoopRuntimeState {
  planRuntimePhase: PlanRuntimePhase;
  planQualityRejectCount: number;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
  planFacetMappingSource: string;
  planArtifactQualityRejected: boolean;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planEvidenceRecoveryPasses: number;
  planEvidenceNoProgressPasses: number;
  planReasoningOnlyRecoveryPasses: number;
  planAutoScaffoldPromptIssued: boolean;
  planDraftingRecoveryReadCount: number;
  planClosureEvidenceRecoveryIssued: boolean;
  planReadOnlyConvergenceBatches: number;
  planReadOnlyConvergenceTools: number;
  sawPlanModeToolActivity: boolean;
  usedPlanRecoveryPrompt: boolean;
  usedPlanClosureGuard: boolean;
  usedPlanClosurePrompt: boolean;
  usedPlanReadOnlyConvergencePrompt: boolean;
  planPostConvergenceToolRedirectCount: number;
}

/** Quality fields committed atomically with a Plan phase transition. */
export interface PlanRuntimePhaseQualitySnapshot {
  qualityRejectCount?: number;
  missingSections?: string[];
}

export function createPlanLoopRuntimeState(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
}): PlanLoopRuntimeState {
  return {
    planRuntimePhase:
      input.workflowMode === "plan" && !input.isPlanApproved
        ? "explore_structure"
        : "grounding",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planFacetMappingSource: "",
    planArtifactQualityRejected: false,
    planEvidenceRecoveryObjective: "none",
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 0,
    planReasoningOnlyRecoveryPasses: 0,
    planAutoScaffoldPromptIssued: false,
    planDraftingRecoveryReadCount: 0,
    planClosureEvidenceRecoveryIssued: false,
    planReadOnlyConvergenceBatches: 0,
    planReadOnlyConvergenceTools: 0,
    sawPlanModeToolActivity: false,
    usedPlanRecoveryPrompt: false,
    usedPlanClosureGuard: false,
    usedPlanClosurePrompt: false,
    usedPlanReadOnlyConvergencePrompt: false,
    planPostConvergenceToolRedirectCount: 0,
  };
}

export function applyPlanRuntimePhase(
  state: PlanLoopRuntimeState,
  input: { phase: PlanRuntimePhase; reason?: string },
): { state: PlanLoopRuntimeState; changed: boolean } {
  if (state.planRuntimePhase === input.phase && !input.reason) {
    return { state, changed: false };
  }
  return {
    state: {
      ...state,
      planRuntimePhase: input.phase,
    },
    changed: true,
  };
}

export function applyReasoningNoToolPlanRuntimeState(
  state: PlanLoopRuntimeState,
  input: Pick<
    PlanLoopRuntimeState,
    "planReasoningOnlyRecoveryPasses" | "planEvidenceRecoveryObjective"
  >,
): PlanLoopRuntimeState {
  return {
    ...state,
    planReasoningOnlyRecoveryPasses: input.planReasoningOnlyRecoveryPasses,
    planEvidenceRecoveryObjective:
      input.planEvidenceRecoveryObjective ?? state.planEvidenceRecoveryObjective,
  };
}

export function applyPlanEvidenceRecoveryRuntimeState(
  state: PlanLoopRuntimeState,
  input: Pick<
    PlanLoopRuntimeState,
    "planEvidenceRecoveryPasses" | "planEvidenceRecoveryObjective"
  >,
): PlanLoopRuntimeState {
  return {
    ...state,
    planEvidenceRecoveryPasses: input.planEvidenceRecoveryPasses,
    planEvidenceRecoveryObjective:
      input.planEvidenceRecoveryObjective ?? state.planEvidenceRecoveryObjective,
  };
}

export function applyPlanPostConvergenceRuntimeState(
  state: PlanLoopRuntimeState,
  input: Pick<
    PlanLoopRuntimeState,
    | "planPostConvergenceToolRedirectCount"
    | "planDraftingRecoveryReadCount"
    | "planReasoningOnlyRecoveryPasses"
    | "planEvidenceRecoveryObjective"
    | "planAutoScaffoldPromptIssued"
  > & Partial<Pick<PlanLoopRuntimeState, "planEvidenceRecoveryPasses">>,
): PlanLoopRuntimeState {
  return {
    ...state,
    planPostConvergenceToolRedirectCount: input.planPostConvergenceToolRedirectCount,
    planDraftingRecoveryReadCount: input.planDraftingRecoveryReadCount,
    planEvidenceRecoveryPasses:
      input.planEvidenceRecoveryPasses ?? state.planEvidenceRecoveryPasses,
    planReasoningOnlyRecoveryPasses: input.planReasoningOnlyRecoveryPasses,
    planEvidenceRecoveryObjective:
      input.planEvidenceRecoveryObjective ?? state.planEvidenceRecoveryObjective,
    planAutoScaffoldPromptIssued: input.planAutoScaffoldPromptIssued,
  };
}

export function applyPlanNoToolRuntimeState(
  state: PlanLoopRuntimeState,
  input: Pick<
    PlanLoopRuntimeState,
    | "usedPlanRecoveryPrompt"
    | "planClosureEvidenceRecoveryIssued"
    | "planQualityRejectCount"
    | "planLastQualityGateReason"
    | "planLastMissingSections"
    | "planFacetMappingSource"
    | "planArtifactQualityRejected"
    | "planEvidenceRecoveryObjective"
    | "planAutoScaffoldPromptIssued"
    | "planEvidenceRecoveryPasses"
  >,
): PlanLoopRuntimeState {
  return {
    ...state,
    usedPlanRecoveryPrompt: input.usedPlanRecoveryPrompt,
    planClosureEvidenceRecoveryIssued: input.planClosureEvidenceRecoveryIssued,
    planQualityRejectCount: input.planQualityRejectCount ?? state.planQualityRejectCount,
    planLastQualityGateReason: input.planLastQualityGateReason ?? state.planLastQualityGateReason,
    planLastMissingSections: input.planLastMissingSections ?? state.planLastMissingSections,
    planFacetMappingSource: input.planFacetMappingSource ?? state.planFacetMappingSource,
    planArtifactQualityRejected: input.planArtifactQualityRejected ?? state.planArtifactQualityRejected,
    planEvidenceRecoveryObjective:
      input.planEvidenceRecoveryObjective ?? state.planEvidenceRecoveryObjective,
    planAutoScaffoldPromptIssued: input.planAutoScaffoldPromptIssued ?? state.planAutoScaffoldPromptIssued,
    planEvidenceRecoveryPasses: input.planEvidenceRecoveryPasses ?? state.planEvidenceRecoveryPasses,
  };
}

export function applyToolResultPlanRuntimeState(
  state: PlanLoopRuntimeState,
  input: Pick<
    PlanLoopRuntimeState,
    "planDraftingRecoveryReadCount" | "planEvidenceRecoveryObjective"
  > &
    Partial<Pick<PlanLoopRuntimeState, "planRuntimePhase">>,
): PlanLoopRuntimeState {
  return {
    ...state,
    planRuntimePhase: input.planRuntimePhase ?? state.planRuntimePhase,
    planDraftingRecoveryReadCount: input.planDraftingRecoveryReadCount,
    planEvidenceRecoveryObjective:
      input.planEvidenceRecoveryObjective ?? state.planEvidenceRecoveryObjective,
  };
}

export function applyPlanQualityRuntimeState(
  state: PlanLoopRuntimeState,
  input: Pick<
    PlanLoopRuntimeState,
    | "planQualityRejectCount"
    | "planLastQualityGateReason"
    | "planLastMissingSections"
    | "planArtifactQualityRejected"
    | "planAutoScaffoldPromptIssued"
    | "planClosureEvidenceRecoveryIssued"
    | "planEvidenceRecoveryObjective"
    | "planEvidenceRecoveryPasses"
    | "planEvidenceNoProgressPasses"
  >,
): PlanLoopRuntimeState {
  return {
    ...state,
    planQualityRejectCount: input.planQualityRejectCount,
    planLastQualityGateReason: input.planLastQualityGateReason,
    planLastMissingSections: input.planLastMissingSections,
    planArtifactQualityRejected: input.planArtifactQualityRejected,
    planAutoScaffoldPromptIssued: input.planAutoScaffoldPromptIssued,
    planClosureEvidenceRecoveryIssued: input.planClosureEvidenceRecoveryIssued,
    planEvidenceRecoveryObjective:
      input.planEvidenceRecoveryObjective ?? state.planEvidenceRecoveryObjective,
    planEvidenceRecoveryPasses: input.planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: input.planEvidenceNoProgressPasses,
  };
}

export function applyPlanReadOnlyConvergenceRuntimeState(
  state: PlanLoopRuntimeState,
  input: Pick<
    PlanLoopRuntimeState,
    | "planReadOnlyConvergenceBatches"
    | "planReadOnlyConvergenceTools"
    | "usedPlanReadOnlyConvergencePrompt"
    | "planEvidenceRecoveryObjective"
  >,
): PlanLoopRuntimeState {
  return {
    ...state,
    planReadOnlyConvergenceBatches: input.planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools: input.planReadOnlyConvergenceTools,
    usedPlanReadOnlyConvergencePrompt: input.usedPlanReadOnlyConvergencePrompt,
    planEvidenceRecoveryObjective:
      input.planEvidenceRecoveryObjective ?? state.planEvidenceRecoveryObjective,
  };
}

export function markPlanModeToolActivity(
  state: PlanLoopRuntimeState,
): PlanLoopRuntimeState {
  if (state.sawPlanModeToolActivity) return state;
  return {
    ...state,
    sawPlanModeToolActivity: true,
  };
}

export function markPlanClosurePromptIssued(
  state: PlanLoopRuntimeState,
): PlanLoopRuntimeState {
  if (state.usedPlanClosureGuard && state.usedPlanClosurePrompt) return state;
  return {
    ...state,
    usedPlanClosureGuard: true,
    usedPlanClosurePrompt: true,
  };
}

export function resetPlanRecoveryPromptRuntimeState(
  state: PlanLoopRuntimeState,
): PlanLoopRuntimeState {
  if (!state.usedPlanRecoveryPrompt) return state;
  return {
    ...state,
    usedPlanRecoveryPrompt: false,
  };
}
