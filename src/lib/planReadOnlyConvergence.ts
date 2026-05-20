import { hasTurnProvidedContext, normalizeTurnInputContextSignals, type TurnInputContextLike } from "./turnIntake";

export const PLAN_READONLY_CONVERGENCE_BATCH_LIMIT = 3;
export const PLAN_READONLY_CONVERGENCE_TOOL_LIMIT = 12;
export const PLAN_CONTEXT_READONLY_CONVERGENCE_BATCH_LIMIT = 2;
export const PLAN_CONTEXT_READONLY_CONVERGENCE_TOOL_LIMIT = 6;
const PLAN_READ_ONLY_TOOL_NAMES = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

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

export function shouldRedirectPlanToolsAfterReadOnlyConvergence(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  convergencePromptAlreadyUsed: boolean;
  hasPlanDecisionOutput: boolean;
  toolNames: string[];
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved) return false;
  if (!input.convergencePromptAlreadyUsed || input.hasPlanDecisionOutput) return false;
  return input.toolNames.some((name) => PLAN_READ_ONLY_TOOL_NAMES.has(name));
}
