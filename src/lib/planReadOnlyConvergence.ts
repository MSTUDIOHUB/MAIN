import type { PlanRuntimePhase } from "./workflowModels";
import { buildPlanEvidenceBundle, isPlanEvidenceBundleReady } from "./planEvidence";
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
}

const PLAN_READ_ONLY_TOOL_NAMES = new Set([
  "spawn_subagent",
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
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
const PLAN_TARGETED_EVIDENCE_TOOL_NAMES = new Set([
  "spawn_subagent",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "get_file_outline",
  "repo_map_search",
  "repo_map_context",
  "repo_map_impact",
  "read_pty_tail",
  "read_pty_since",
  "read_pty_buffer",
  "get_pty_status",
]);
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

function isPlanRuntimeReadOnlyPhase(phase?: PlanRuntimePhase): boolean {
  return phase === "explore_structure" || phase === "grounding" || phase === "synthesis" || phase === "needs_evidence";
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
  const providedPaths = [...userContext.mentionedFilePaths, ...userContext.attachedFilePaths];
  const readProvidedPath = providedPaths.length > 0 && successful.some((item) =>
    PLAN_TARGETED_EVIDENCE_TOOL_NAMES.has(String(item.name || "")) &&
    targetMatchesProvidedPath(String(item.target || ""), providedPaths)
  );
  const semanticBundle = buildPlanEvidenceBundle({
    turnId: "readiness",
    objective: "plan evidence readiness",
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

  if (input.hasBlockingUserChoice) {
    return {
      status: "blocked_user_choice",
      reason: "blocking_user_choice",
      ...counts,
    };
  }

  if (hasProvidedContext && !input.hasObservedUserContext) {
    return {
      status: "needs_observation",
      reason: "provided_context_not_observed",
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

export function filterPlanToolNamesForRuntimePhase(input: {
  toolNames: string[];
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planRuntimePhase?: PlanRuntimePhase;
}): string[] {
  if (input.workflowMode !== "plan" || input.isPlanApproved || !input.planRuntimePhase) {
    return input.toolNames;
  }
  if (input.planRuntimePhase === "explore_structure") {
    return input.toolNames.filter((name) => name === "get_project_skeleton");
  }
  if (isPlanRuntimeReadOnlyPhase(input.planRuntimePhase)) {
    return input.toolNames.filter(isPlanReadOnlyToolName);
  }
  if (isPlanRuntimeFinalizationPhase(input.planRuntimePhase)) {
    return input.toolNames.filter(isPlanPostConvergenceArtifactToolName);
  }
  return input.toolNames;
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
  if (
    readiness.status === "needs_targeted_read" &&
    readiness.successfulSearches > 0 &&
    input.batchCount >= 1
  ) {
    return true;
  }
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
