import { hasTurnProvidedContext, normalizeTurnInputContextSignals, type TurnInputContextLike } from "./turnIntake";

export const PLAN_READONLY_CONVERGENCE_BATCH_LIMIT = 3;
export const PLAN_READONLY_CONVERGENCE_TOOL_LIMIT = 12;
export const PLAN_CONTEXT_READONLY_CONVERGENCE_BATCH_LIMIT = 2;
export const PLAN_CONTEXT_READONLY_CONVERGENCE_TOOL_LIMIT = 6;

export function shouldTriggerPlanReadOnlyConvergence(input: {
  isUnapprovedPlanReadOnlyBatch: boolean;
  hasPlanDecisionOutput: boolean;
  batchCount: number;
  toolCount: number;
  userContext?: TurnInputContextLike;
}): boolean {
  if (!input.isUnapprovedPlanReadOnlyBatch || input.hasPlanDecisionOutput) return false;
  const userContext = normalizeTurnInputContextSignals(input.userContext);
  const batchLimit = hasTurnProvidedContext(userContext)
    ? PLAN_CONTEXT_READONLY_CONVERGENCE_BATCH_LIMIT
    : PLAN_READONLY_CONVERGENCE_BATCH_LIMIT;
  const toolLimit = hasTurnProvidedContext(userContext)
    ? PLAN_CONTEXT_READONLY_CONVERGENCE_TOOL_LIMIT
    : PLAN_READONLY_CONVERGENCE_TOOL_LIMIT;
  return (
    input.batchCount >= batchLimit ||
    input.toolCount >= toolLimit
  );
}
