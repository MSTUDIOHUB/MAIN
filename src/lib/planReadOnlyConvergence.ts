import { hasTurnProvidedContext, normalizeTurnInputContextSignals, type TurnInputContextLike } from "./turnIntake";

export const PLAN_READONLY_CONVERGENCE_BATCH_LIMIT = 3;
export const PLAN_READONLY_CONVERGENCE_TOOL_LIMIT = 12;
export const PLAN_CONTEXT_READONLY_CONVERGENCE_BATCH_LIMIT = 2;
export const PLAN_CONTEXT_READONLY_CONVERGENCE_TOOL_LIMIT = 6;
export type PlanEvidenceReadiness =
  | "needs_observation"
  | "needs_targeted_read"
  | "ready_for_plan"
  | "blocked_user_choice";

export interface PlanEvidenceReadinessResult {
  status: PlanEvidenceReadiness;
  reason: string;
  successfulTargetedReads: number;
  successfulSearches: number;
}

export interface PlanToolActivityLike {
  name?: string;
  target?: string;
  status?: string;
  detail?: string;
}

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
const PLAN_BROAD_READ_ONLY_TOOL_NAMES = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "index_workspace_documents",
]);
const PLAN_TARGETED_EVIDENCE_TOOL_NAMES = new Set([
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "get_file_outline",
  "read_pty_tail",
  "read_pty_since",
  "read_pty_buffer",
  "get_pty_status",
]);
const PLAN_POST_CONVERGENCE_ARTIFACT_TOOL_NAMES = new Set([
  "write_file",
  "replace_in_file",
]);

function isSuccessfulActivity(activity: PlanToolActivityLike): boolean {
  return String(activity.status || "").toLowerCase() === "succeeded";
}

function hasConcreteTarget(activity: PlanToolActivityLike): boolean {
  const target = String(activity.target || "").trim();
  if (!target) return false;
  return target !== "." && target !== "./" && target !== "get_project_skeleton";
}

export function assessPlanEvidenceReadiness(input: {
  userContext?: TurnInputContextLike;
  recentToolActivity?: PlanToolActivityLike[];
  hasObservedUserContext?: boolean;
  hasBlockingUserChoice?: boolean;
}): PlanEvidenceReadinessResult {
  const userContext = normalizeTurnInputContextSignals(input.userContext);
  const hasProvidedContext = hasTurnProvidedContext(userContext);
  const activity = Array.isArray(input.recentToolActivity) ? input.recentToolActivity : [];
  const successful = activity.filter(isSuccessfulActivity);
  const successfulTargetedReads = successful.filter((item) =>
    PLAN_TARGETED_EVIDENCE_TOOL_NAMES.has(String(item.name || "")) && hasConcreteTarget(item)
  ).length;
  const successfulSearches = successful.filter((item) =>
    (String(item.name || "") === "grep_search" || String(item.name || "") === "glob_search") &&
    hasConcreteTarget(item)
  ).length;

  if (input.hasBlockingUserChoice) {
    return {
      status: "blocked_user_choice",
      reason: "blocking_user_choice",
      successfulTargetedReads,
      successfulSearches,
    };
  }

  if (hasProvidedContext && !input.hasObservedUserContext) {
    return {
      status: "needs_observation",
      reason: "provided_context_not_observed",
      successfulTargetedReads,
      successfulSearches,
    };
  }

  if (successfulTargetedReads <= 0) {
    return {
      status: "needs_targeted_read",
      reason: successfulSearches > 0 ? "search_without_targeted_read" : "no_targeted_evidence_read",
      successfulTargetedReads,
      successfulSearches,
    };
  }

  return {
    status: "ready_for_plan",
    reason: "targeted_evidence_available",
    successfulTargetedReads,
    successfulSearches,
  };
}

export function shouldNarrowPlanToolsAfterReadOnlyConvergence(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  convergencePromptAlreadyUsed: boolean;
  evidenceReadiness?: PlanEvidenceReadiness;
}): boolean {
  void input;
  return false;
}

export function isPlanPostConvergenceArtifactToolName(name: string): boolean {
  return PLAN_POST_CONVERGENCE_ARTIFACT_TOOL_NAMES.has(name);
}

export function filterPlanToolNamesAfterReadOnlyConvergence(input: {
  toolNames: string[];
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  convergencePromptAlreadyUsed: boolean;
}): string[] {
  if (!shouldNarrowPlanToolsAfterReadOnlyConvergence(input)) return input.toolNames;
  return input.toolNames.filter(isPlanPostConvergenceArtifactToolName);
}

export function shouldTriggerPlanReadOnlyConvergence(input: {
  isUnapprovedPlanReadOnlyBatch: boolean;
  hasPlanDecisionOutput: boolean;
  batchCount: number;
  toolCount: number;
  userContext?: TurnInputContextLike;
  recentToolActivity?: PlanToolActivityLike[];
  hasObservedUserContext?: boolean;
  convergencePromptAlreadyUsed?: boolean;
}): boolean {
  if (!input.isUnapprovedPlanReadOnlyBatch || input.hasPlanDecisionOutput) return false;
  if (input.convergencePromptAlreadyUsed) return false;
  const userContext = normalizeTurnInputContextSignals(input.userContext);
  const batchLimit = hasTurnProvidedContext(userContext)
    ? PLAN_CONTEXT_READONLY_CONVERGENCE_BATCH_LIMIT
    : PLAN_READONLY_CONVERGENCE_BATCH_LIMIT;
  const toolLimit = hasTurnProvidedContext(userContext)
    ? PLAN_CONTEXT_READONLY_CONVERGENCE_TOOL_LIMIT
    : PLAN_READONLY_CONVERGENCE_TOOL_LIMIT;
  const readiness = assessPlanEvidenceReadiness({
    userContext,
    recentToolActivity: input.recentToolActivity,
    hasObservedUserContext: input.hasObservedUserContext,
  });
  if (readiness.status !== "ready_for_plan" && readiness.status !== "blocked_user_choice") {
    return false;
  }
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
  evidenceReadiness?: PlanEvidenceReadiness;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved) return false;
  if (!input.convergencePromptAlreadyUsed || input.hasPlanDecisionOutput) return false;
  if (input.evidenceReadiness !== "ready_for_plan" && input.evidenceReadiness !== "blocked_user_choice") {
    return false;
  }
  return input.toolNames.some((name) =>
    PLAN_BROAD_READ_ONLY_TOOL_NAMES.has(name) ||
    (PLAN_READ_ONLY_TOOL_NAMES.has(name) && !PLAN_TARGETED_EVIDENCE_TOOL_NAMES.has(name))
  );
}
