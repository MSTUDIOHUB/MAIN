import type { PlanRuntimePhase } from "./workflowModels";
import {
  assessPlanClosureEvidence,
  buildPlanEvidenceBundle,
  isPlanEvidenceBundleReady,
} from "./planEvidence";
import { hasTurnProvidedContext, normalizeTurnInputContextSignals, type TurnInputContextLike } from "./turnIntake";
import { workspacePathsReferToSameFile } from "./workspacePaths";

export const PLAN_READONLY_CONVERGENCE_BATCH_LIMIT = 3;
export const PLAN_READONLY_CONVERGENCE_TOOL_LIMIT = 12;
export const PLAN_CONTEXT_READONLY_CONVERGENCE_BATCH_LIMIT = 1;
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
  semanticFacts: number;
  changeTargets: number;
}

export interface PlanToolActivityLike {
  name?: string;
  target?: string;
  status?: string;
  detail?: string;
  delegatedObservation?: {
    planningEvidenceState?: "reusable" | "unresolved";
  };
}

const PLAN_READ_ONLY_TOOL_NAMES = new Set([
  "spawn_subagent",
  "wait_subagents",
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "web_search",
  "web_fetch",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "code_ast_query",
  "find_symbol_references",
  "git_status",
  "git_diff",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "knowledge_search",
  "knowledge_get_excerpt",
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);
const PLAN_TARGETED_EVIDENCE_TOOL_NAMES = new Set([
  "spawn_subagent",
  "wait_subagents",
  "glob_search",
  "grep_search",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "get_file_outline",
  "code_ast_query",
  "find_symbol_references",
  "git_diff",
  "repo_map_search",
  "repo_map_context",
  "repo_map_impact",
  "read_pty_tail",
  "read_pty_since",
  "read_pty_buffer",
  "get_pty_status",
]);

function isPlanEvidenceSearchTool(name: string): boolean {
  return name === "grep_search" || name === "glob_search";
}

function isPlanTargetedEvidenceRead(name: string): boolean {
  return PLAN_TARGETED_EVIDENCE_TOOL_NAMES.has(name) && !isPlanEvidenceSearchTool(name);
}
const PLAN_DRAFT_WRITE_TOOL_NAMES = new Set([
  "write_file",
  "replace_in_file",
]);

export function isPlanReadOnlyToolName(name: string): boolean {
  return PLAN_READ_ONLY_TOOL_NAMES.has(String(name || ""));
}

export function isPlanPostConvergenceArtifactToolName(name: string): boolean {
  return PLAN_DRAFT_WRITE_TOOL_NAMES.has(String(name || ""));
}

function isPlanRuntimeFinalizationPhase(phase?: PlanRuntimePhase): boolean {
  return (
    phase === "synthesis" ||
    phase === "drafting" ||
    phase === "needs_rewrite" ||
    phase === "review_ready" ||
    phase === "blocked"
  );
}

function isPlanEvidenceRecoveryPhase(phase?: PlanRuntimePhase): boolean {
  return phase === "needs_evidence";
}

function isSuccessfulActivity(activity: PlanToolActivityLike): boolean {
  return String(activity.status || "").toLowerCase() === "succeeded";
}

function hasConcreteTarget(activity: PlanToolActivityLike): boolean {
  const target = String(activity.target || "").trim();
  if (!target) return false;
  return target !== "." && target !== "./" && target !== "get_project_skeleton";
}

function normalizeEvidencePath(path: string): string {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase().trim();
}

function targetMatchesProvidedPath(target: string, providedPaths: string[]): boolean {
  const normalizedTarget = normalizeEvidencePath(target);
  if (!normalizedTarget) return false;
  return providedPaths.some((rawPath) => {
    const normalizedPath = normalizeEvidencePath(rawPath);
    if (!normalizedPath) return false;
    return workspacePathsReferToSameFile(normalizedTarget, normalizedPath);
  });
}

export function assessPlanEvidenceReadiness(input: {
  userGoal?: string;
  userContext?: TurnInputContextLike;
  recentToolActivity?: PlanToolActivityLike[];
  hasGroundedVisualContext?: boolean;
  /** @deprecated Use hasGroundedVisualContext. Kept for persisted callers. */
  hasObservedUserContext?: boolean;
  hasBlockingUserChoice?: boolean;
}): PlanEvidenceReadinessResult {
  const userContext = normalizeTurnInputContextSignals(input.userContext);
  const activity = Array.isArray(input.recentToolActivity) ? input.recentToolActivity : [];
  const successful = activity.filter(isSuccessfulActivity);
  const successfulTargetedReads = successful.filter((item) =>
    isPlanTargetedEvidenceRead(String(item.name || "")) && hasConcreteTarget(item)
  ).length;
  const successfulSearches = successful.filter((item) =>
    isPlanEvidenceSearchTool(String(item.name || "")) &&
    hasConcreteTarget(item)
  ).length;
  const providedPaths = [...userContext.mentionedFilePaths, ...userContext.attachedFilePaths];
  const readProvidedPath = providedPaths.length > 0 && successful.some((item) =>
    isPlanTargetedEvidenceRead(String(item.name || "")) &&
    targetMatchesProvidedPath(String(item.target || ""), providedPaths)
  );
  const semanticBundle = buildPlanEvidenceBundle({
    turnId: "readiness",
    objective: String(input.userGoal || "plan evidence readiness"),
    evidenceRecords: successful.map((item) => ({
      tool: String(item.name || ""),
      target: String(item.target || ""),
      status: "succeeded",
      summary: String(item.detail || ""),
    })),
    files: successful.map((item) => String(item.target || "")),
  });
  const semanticFacts = semanticBundle.facts.length;
  const changeTargets = semanticBundle.changeTargets.length;
  const counts = { successfulTargetedReads, successfulSearches, semanticFacts, changeTargets };
  const hasGroundedVisualContext =
    input.hasGroundedVisualContext ?? input.hasObservedUserContext ?? false;

  if (input.hasBlockingUserChoice) {
    return {
      status: "blocked_user_choice",
      reason: "blocking_user_choice",
      ...counts,
    };
  }

  if (userContext.imageParts > 0 && !hasGroundedVisualContext) {
    return {
      status: "needs_observation",
      reason: "visual_context_not_model_visible",
      ...counts,
    };
  }

  if (providedPaths.length > 0 && !readProvidedPath) {
    return {
      status: "needs_observation",
      reason: "provided_file_not_read",
      ...counts,
    };
  }

  if (successfulTargetedReads <= 0) {
    return {
      status: "needs_targeted_read",
      reason: successfulSearches > 0 ? "search_without_targeted_read" : "no_targeted_evidence_read",
      ...counts,
    };
  }

  if (!isPlanEvidenceBundleReady(semanticBundle)) {
    return {
      status: "needs_targeted_read",
      reason: semanticFacts <= 0 ? "targeted_reads_without_semantic_facts" : "semantic_facts_without_change_target",
      ...counts,
    };
  }

  const closureAssessment = assessPlanClosureEvidence(semanticBundle);
  if (!closureAssessment.ready) {
    return {
      status: "needs_targeted_read",
      reason: closureAssessment.reason,
      ...counts,
    };
  }

  if (!readProvidedPath && successfulTargetedReads < 2 && successfulSearches < 1) {
    return {
      status: "needs_targeted_read",
      reason: "insufficient_targeted_evidence",
      ...counts,
    };
  }

  return {
    status: "ready_for_plan",
    reason: "targeted_evidence_available",
    ...counts,
  };
}

export function shouldNarrowPlanToolsAfterReadOnlyConvergence(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  convergencePromptAlreadyUsed: boolean;
  evidenceReadiness?: PlanEvidenceReadiness;
  planRuntimePhase?: PlanRuntimePhase;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved) return false;
  if (isPlanRuntimeFinalizationPhase(input.planRuntimePhase)) return true;
  if (isPlanEvidenceRecoveryPhase(input.planRuntimePhase)) return false;
  if (!input.convergencePromptAlreadyUsed) return false;
  if (input.evidenceReadiness === "needs_targeted_read") return true;
  return input.evidenceReadiness === "ready_for_plan" || input.evidenceReadiness === "blocked_user_choice";
}

export function filterPlanToolNamesAfterReadOnlyConvergence(input: {
  toolNames: string[];
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  convergencePromptAlreadyUsed: boolean;
  evidenceReadiness?: PlanEvidenceReadiness;
  planRuntimePhase?: PlanRuntimePhase;
}): string[] {
  if (!shouldNarrowPlanToolsAfterReadOnlyConvergence(input)) return input.toolNames;
  if (input.evidenceReadiness === "needs_targeted_read") {
    return input.toolNames.filter((name) => PLAN_TARGETED_EVIDENCE_TOOL_NAMES.has(name));
  }
  return input.toolNames.filter(isPlanPostConvergenceArtifactToolName);
}

export function shouldTriggerPlanReadOnlyConvergence(input: {
  isUnapprovedPlanReadOnlyBatch: boolean;
  hasPlanDecisionOutput: boolean;
  batchCount: number;
  toolCount: number;
  userGoal?: string;
  userContext?: TurnInputContextLike;
  recentToolActivity?: PlanToolActivityLike[];
  hasGroundedVisualContext?: boolean;
  /** @deprecated Use hasGroundedVisualContext. Kept for persisted callers. */
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
    userGoal: input.userGoal,
    userContext,
    recentToolActivity: input.recentToolActivity,
    hasGroundedVisualContext:
      input.hasGroundedVisualContext ?? input.hasObservedUserContext,
  });
  const successfulActivity = (input.recentToolActivity || []).filter(isSuccessfulActivity);
  const reusableDelegatedTargets = new Set(successfulActivity.flatMap((activity) => {
    if (activity.delegatedObservation?.planningEvidenceState !== "reusable") return [];
    const target = normalizeEvidencePath(String(activity.target || ""));
    return target ? [target] : [];
  }));
  const hasParentOwnedTargetedRead = successfulActivity.some((activity) =>
    !activity.delegatedObservation &&
    isPlanTargetedEvidenceRead(String(activity.name || "")) &&
    hasConcreteTarget(activity)
  );
  // Joined child evidence is already one bounded exploration batch. Once two
  // independently scoped, provenance-backed observations and a parent-owned
  // targeted read exist, a second batch is enough to make the runtime decide
  // whether to draft or request one exact missing contract. This is based on
  // evidence shape, never provider/model identity or response wording.
  const reusableDelegatedConvergenceReady =
    reusableDelegatedTargets.size >= 2 &&
    hasParentOwnedTargetedRead &&
    input.batchCount >= 2;
  if (
    readiness.status === "needs_targeted_read" &&
    (
      reusableDelegatedConvergenceReady ||
      (readiness.successfulSearches > 0 && input.batchCount >= 1) ||
      (
        readiness.successfulTargetedReads >= 2 &&
        (input.batchCount >= batchLimit || input.toolCount >= toolLimit)
      )
    )
  ) {
    return true;
  }
  if (readiness.status !== "ready_for_plan" && readiness.status !== "blocked_user_choice") {
    return false;
  }
  return (
    reusableDelegatedConvergenceReady ||
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
  planRuntimePhase?: PlanRuntimePhase;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved) return false;
  if (isPlanEvidenceRecoveryPhase(input.planRuntimePhase)) return false;
  if (input.hasPlanDecisionOutput) return false;
  const isFinalizationPhase = isPlanRuntimeFinalizationPhase(input.planRuntimePhase);
  if (isFinalizationPhase) return input.toolNames.length > 0;
  if (!input.convergencePromptAlreadyUsed) return false;
  if (input.evidenceReadiness === "needs_targeted_read") {
    return input.toolNames.some((name) =>
      PLAN_READ_ONLY_TOOL_NAMES.has(name) &&
      !PLAN_TARGETED_EVIDENCE_TOOL_NAMES.has(name)
    );
  }
  if (input.evidenceReadiness !== "ready_for_plan" && input.evidenceReadiness !== "blocked_user_choice") {
    return false;
  }
  return input.toolNames.some((name) => PLAN_READ_ONLY_TOOL_NAMES.has(name));
}
