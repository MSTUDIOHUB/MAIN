import type { PlanRuntimePhase } from "./workflowModels";
import type { PlanEvidenceReadiness } from "./planReadOnlyConvergence";
import { isPlanReadOnlyToolName } from "./planReadOnlyConvergence";

export type PlanRuntimeMode = "chat" | "edit" | "plan";

export type PlanFinalizationRecoveryAction =
  | "ignore"
  | "deterministic_materialization"
  | "targeted_evidence"
  | "pause_blocked";

export interface PlanFinalizationRecoveryDecision {
  action: PlanFinalizationRecoveryAction;
  reason: string;
}

function isPlanRuntimeReadOnlyPhase(phase?: PlanRuntimePhase): boolean {
  return phase === "explore_structure" || phase === "grounding" || phase === "needs_evidence";
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

function hasReadyPlanEvidence(status?: PlanEvidenceReadiness): boolean {
  return status === "ready_for_plan" || status === "blocked_user_choice";
}

const PLAN_TARGETED_EVIDENCE_TOOL_NAMES = new Set([
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

const PLAN_STRUCTURE_EXPLORATION_TOOL_NAMES = new Set([
  "get_project_skeleton",
]);

export function filterPlanToolNamesForRuntimePhase(input: {
  toolNames: string[];
  workflowMode: PlanRuntimeMode;
  isPlanApproved: boolean;
  planRuntimePhase?: PlanRuntimePhase;
}): string[] {
  if (input.workflowMode !== "plan" || input.isPlanApproved || !input.planRuntimePhase) {
    return input.toolNames;
  }
  if (input.planRuntimePhase === "explore_structure") {
    return input.toolNames.filter((name) => PLAN_STRUCTURE_EXPLORATION_TOOL_NAMES.has(name));
  }
  if (input.planRuntimePhase === "needs_evidence") {
    return input.toolNames.filter((name) => PLAN_TARGETED_EVIDENCE_TOOL_NAMES.has(name));
  }
  if (isPlanRuntimeReadOnlyPhase(input.planRuntimePhase)) {
    return input.toolNames.filter(isPlanReadOnlyToolName);
  }
  if (isPlanRuntimeFinalizationPhase(input.planRuntimePhase)) {
    return [];
  }
  return input.toolNames;
}

export function shouldClosePlanToolSurfaceAfterReadOnlyConvergence(input: {
  workflowMode: PlanRuntimeMode;
  isPlanApproved: boolean;
  convergencePromptAlreadyUsed: boolean;
  evidenceReadiness?: PlanEvidenceReadiness;
  planRuntimePhase?: PlanRuntimePhase;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved) return false;
  if (isPlanEvidenceRecoveryPhase(input.planRuntimePhase)) return false;
  if (isPlanRuntimeFinalizationPhase(input.planRuntimePhase)) return true;
  if (!input.convergencePromptAlreadyUsed) return false;
  return hasReadyPlanEvidence(input.evidenceReadiness);
}

export function shouldRedirectPlanToolsAfterReadOnlyConvergence(input: {
  workflowMode: PlanRuntimeMode;
  isPlanApproved: boolean;
  convergencePromptAlreadyUsed: boolean;
  hasPlanDecisionOutput: boolean;
  toolNames: string[];
  evidenceReadiness?: PlanEvidenceReadiness;
  planRuntimePhase?: PlanRuntimePhase;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved) return false;
  if (input.hasPlanDecisionOutput) return false;
  if (isPlanEvidenceRecoveryPhase(input.planRuntimePhase)) return false;
  if (input.toolNames.length === 0) return false;
  if (isPlanRuntimeFinalizationPhase(input.planRuntimePhase)) return true;
  if (!input.convergencePromptAlreadyUsed) return false;
  if (!hasReadyPlanEvidence(input.evidenceReadiness)) return false;
  return input.toolNames.some(isPlanReadOnlyToolName);
}

export function resolvePlanNoActionRecovery(input: {
  workflowMode: PlanRuntimeMode;
  isPlanApproved: boolean;
  reasoningOnly: boolean;
  evidenceReadiness?: PlanEvidenceReadiness;
  targetedRecoveryPasses: number;
}): PlanFinalizationRecoveryDecision {
  if (input.workflowMode !== "plan" || input.isPlanApproved || !input.reasoningOnly) {
    return { action: "ignore", reason: "not_unapproved_plan_reasoning_only" };
  }
  if (hasReadyPlanEvidence(input.evidenceReadiness)) {
    return { action: "deterministic_materialization", reason: "evidence_ready_for_plan" };
  }
  if (input.targetedRecoveryPasses < 1) {
    return { action: "targeted_evidence", reason: input.evidenceReadiness || "insufficient_evidence" };
  }
  return { action: "pause_blocked", reason: input.evidenceReadiness || "insufficient_evidence_after_recovery" };
}

export function resolvePlanSuppressedToolRecovery(input: {
  workflowMode: PlanRuntimeMode;
  isPlanApproved: boolean;
  evidenceReadiness?: PlanEvidenceReadiness;
  targetedRecoveryPasses: number;
}): PlanFinalizationRecoveryDecision {
  if (input.workflowMode !== "plan" || input.isPlanApproved) {
    return { action: "ignore", reason: "not_unapproved_plan" };
  }
  if (hasReadyPlanEvidence(input.evidenceReadiness)) {
    return { action: "deterministic_materialization", reason: "suppressed_tool_after_ready_evidence" };
  }
  if (input.targetedRecoveryPasses < 1) {
    return { action: "targeted_evidence", reason: input.evidenceReadiness || "insufficient_evidence" };
  }
  return { action: "pause_blocked", reason: input.evidenceReadiness || "insufficient_evidence_after_recovery" };
}

export function shouldSuppressPlanTruncationWarning(input: {
  workflowMode: PlanRuntimeMode;
  isPlanApproved: boolean;
  finishReason?: "stop" | "length" | "tool_calls" | null;
  reasoningOnly: boolean;
}): boolean {
  return (
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    input.finishReason === "length" &&
    input.reasoningOnly
  );
}

export function buildPlanTargetedEvidenceRecoveryPrompt(input: {
  language: "zh" | "en";
  reason?: string;
}): string {
  if (input.language === "en") {
    return [
      "PLAN_TARGETED_EVIDENCE_RECOVERY: The previous planning turn ended in hidden reasoning without a reviewable plan.",
      input.reason ? `Evidence readiness: ${input.reason}.` : "",
      "Do exactly one tightly scoped read-only evidence pass now. Prefer the most specific file/path/symbol from the user request or the latest evidence.",
      "After that single read/search result, stop exploring and produce a concise visible `<proposed_plan>` or Codex-style Proposal. MAIN will materialize it into `.MAIN/plans/plan.md` for review.",
      "Do not call write_file or replace_in_file just to finish planning.",
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_TARGETED_EVIDENCE_RECOVERY: 上一条计划回复只有隐藏推理，没有形成可审批计划。",
    input.reason ? `证据状态：${input.reason}。` : "",
    "现在只做一次精确定向的只读补证。优先读取用户请求或已有证据里最具体的文件、路径或符号。",
    "拿到这一次读取/搜索结果后，停止探索，直接输出精简可见的 `<proposed_plan>` 或 Codex-style Proposal；MAIN 会把它物化为 `.MAIN/plans/plan.md` 供审批。",
    "不要为了完成规划而调用 write_file 或 replace_in_file。",
  ].filter(Boolean).join("\n");
}

export function buildPlanEvidenceBlockedPauseMessage(input: {
  language: "zh" | "en";
  reason?: string;
}): string {
  if (input.language === "en") {
    return [
      "Plan generation paused: one targeted evidence recovery pass was already used, but the evidence is still not sufficient for a reviewable plan.",
      input.reason ? `Current blocker: ${input.reason}.` : "",
      "Resume with a concrete missing file/path/fact, or provide the key decision needed before MAIN can produce `.MAIN/plans/plan.md`.",
    ].filter(Boolean).join("\n");
  }
  return [
    "计划生成已暂停：已经使用过一次定向补证，但证据仍不足以生成可审批计划。",
    input.reason ? `当前阻塞：${input.reason}。` : "",
    "继续时请给出具体缺失的文件/路径/事实，或提供生成 `.MAIN/plans/plan.md` 前必须确定的关键选择。",
  ].filter(Boolean).join("\n");
}
