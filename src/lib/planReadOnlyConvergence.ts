export const PLAN_READONLY_CONVERGENCE_BATCH_LIMIT = 3;
export const PLAN_READONLY_CONVERGENCE_TOOL_LIMIT = 12;

export function shouldTriggerPlanReadOnlyConvergence(input: {
  isUnapprovedPlanReadOnlyBatch: boolean;
  hasPlanDecisionOutput: boolean;
  batchCount: number;
  toolCount: number;
}): boolean {
  if (!input.isUnapprovedPlanReadOnlyBatch || input.hasPlanDecisionOutput) return false;
  return (
    input.batchCount >= PLAN_READONLY_CONVERGENCE_BATCH_LIMIT ||
    input.toolCount >= PLAN_READONLY_CONVERGENCE_TOOL_LIMIT
  );
}
