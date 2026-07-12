import type { PlanRuntimePhase } from "./workflowModels";
import type { PlanEvidenceReadiness } from "./planReadOnlyConvergence";
import { isPlanReadOnlyToolName } from "./planReadOnlyConvergence";

export type PlanRuntimeMode = "chat" | "edit" | "plan";

export type PlanFinalizationRecoveryAction =
  | "ignore"
  | "targeted_evidence"
  | "pause_blocked";

export interface PlanFinalizationRecoveryDecision {
  action: PlanFinalizationRecoveryAction;
  reason: string;
}

function isPlanRuntimeReadOnlyPhase(phase?: PlanRuntimePhase): boolean {
  return phase === "explore_structure" || phase === "grounding" || phase === "needs_evidence";
}

export function isPlanRuntimeFinalizationPhase(phase?: PlanRuntimePhase): boolean {
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
  "spawn_subagent",
  "wait_subagents",
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
  "spawn_subagent",
  "wait_subagents",
  // Allow read_file during structure exploration so the model can read
  // specific files discovered by get_project_skeleton. This prevents
  // the model from getting stuck trying unsupported tools.
  "read_file",
]);

const PLAN_DRAFT_WRITE_TOOL_NAMES = new Set([
  "write_file",
  "replace_in_file",
]);

export function isPlanDraftWriteToolName(name: string): boolean {
  return PLAN_DRAFT_WRITE_TOOL_NAMES.has(String(name || ""));
}

export function shouldAdvancePlanFromStructureOnTargetedRead(input: {
  workflowMode: PlanRuntimeMode;
  isPlanApproved: boolean;
  planRuntimePhase?: PlanRuntimePhase;
  requestedToolNames: string[];
}): boolean {
  if (
    input.workflowMode !== "plan" ||
    input.isPlanApproved ||
    input.planRuntimePhase !== "explore_structure"
  ) {
    return false;
  }
  return input.requestedToolNames.some((name) =>
    name !== "get_project_skeleton" && isPlanReadOnlyToolName(name)
  );
}

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
    return input.toolNames.filter((name) => name === "spawn_subagent" || name === "wait_subagents" || isPlanReadOnlyToolName(name));
  }
  if (isPlanRuntimeFinalizationPhase(input.planRuntimePhase)) {
    // Runtime owns plan.md materialization. The model drafts visible Markdown
    // against the frozen evidence bundle and receives no tools in this phase.
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

export function shouldRedirectPlanRuntimeToolsAfterReadOnlyConvergence(input: {
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

export const MAX_PLAN_EVIDENCE_RECOVERY_PASSES = 3;
export const MAX_PLAN_REASONING_ONLY_READY_RECOVERY_PASSES = 1;

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
  const maxRecoveryPasses = hasReadyPlanEvidence(input.evidenceReadiness)
    ? MAX_PLAN_REASONING_ONLY_READY_RECOVERY_PASSES
    : MAX_PLAN_EVIDENCE_RECOVERY_PASSES;
  if (input.targetedRecoveryPasses < maxRecoveryPasses) {
    return {
      action: "targeted_evidence",
      reason: hasReadyPlanEvidence(input.evidenceReadiness)
        ? "ready_evidence_missing_visible_plan"
        : input.evidenceReadiness || "insufficient_evidence",
    };
  }
  return {
    action: "pause_blocked",
    reason: hasReadyPlanEvidence(input.evidenceReadiness)
      ? "ready_evidence_missing_visible_plan_after_recovery"
      : input.evidenceReadiness || "insufficient_evidence_after_recovery",
  };
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
  const maxRecoveryPasses = hasReadyPlanEvidence(input.evidenceReadiness)
    ? MAX_PLAN_REASONING_ONLY_READY_RECOVERY_PASSES
    : MAX_PLAN_EVIDENCE_RECOVERY_PASSES;
  if (input.targetedRecoveryPasses < maxRecoveryPasses) {
    return {
      action: "targeted_evidence",
      reason: hasReadyPlanEvidence(input.evidenceReadiness)
        ? "suppressed_tool_ready_evidence_missing_visible_plan"
        : input.evidenceReadiness || "insufficient_evidence",
    };
  }
  return {
    action: "pause_blocked",
    reason: hasReadyPlanEvidence(input.evidenceReadiness)
      ? "suppressed_tool_ready_evidence_missing_visible_plan_after_recovery"
      : input.evidenceReadiness || "insufficient_evidence_after_recovery",
  };
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
  trigger?: "reasoning_only" | "closed_read_request";
}): string {
  const closedReadRequest = input.trigger === "closed_read_request";
  if (input.language === "en") {
    return [
      closedReadRequest
        ? "PLAN_TARGETED_EVIDENCE_RECOVERY: The plan requested more read-only evidence after the drafting tool surface had closed."
        : "PLAN_TARGETED_EVIDENCE_RECOVERY: The previous planning turn ended in hidden reasoning without a reviewable plan.",
      input.reason ? `Evidence readiness: ${input.reason}.` : "",
      "Do tightly scoped read-only evidence pass(es) now. Prefer the most specific file/path/symbol from the user request or the latest evidence.",
      "After the read/search result, stop exploring and output a concise visible `<proposed_plan>`. MAIN runtime owns `.MAIN/plans/plan.md` materialization.",
      "Do not ask for approval again and do not modify source or deliverable files before approval.",
    ].filter(Boolean).join("\n");
  }
  return [
    closedReadRequest
      ? "PLAN_TARGETED_EVIDENCE_RECOVERY: 计划在 drafting 工具面关闭后仍请求补充只读证据。"
      : "PLAN_TARGETED_EVIDENCE_RECOVERY: 上一条计划回复只有隐藏推理，没有形成可审批计划。",
    input.reason ? `证据状态：${input.reason}。` : "",
    "现在只做精确定向的只读补证。优先读取用户请求或已有证据里最具体的文件、路径或符号。",
    "拿到读取/搜索结果后，停止探索并输出精简的可见 `<proposed_plan>`；`.MAIN/plans/plan.md` 由 MAIN runtime 负责物化。",
    "不要再次询问是否批准，也不要在批准前修改源码或最终交付文件。",
  ].filter(Boolean).join("\n");
}

export function buildPlanEvidenceBlockedPauseMessage(input: {
  language: "zh" | "en";
  reason?: string;
}): string {
  if (input.language === "en") {
    return [
      "Plan generation paused: targeted evidence recovery passes were already used, but the evidence is still not sufficient for a reviewable plan.",
      input.reason ? `Current blocker: ${input.reason}.` : "",
      "MAIN did not synthesize a fallback plan. Resume with a concrete missing file/path/fact, or provide the key decision needed before the model can produce `.MAIN/plans/plan.md`.",
    ].filter(Boolean).join("\n");
  }
  return [
    "计划生成已暂停：已经使用过定向补证，但证据仍不足以生成可审批计划。",
    input.reason ? `当前阻塞：${input.reason}。` : "",
    "MAIN 不会再自动拼接兜底计划。继续时请给出具体缺失的文件/路径/事实，或提供模型生成 `.MAIN/plans/plan.md` 前必须确定的关键选择。",
  ].filter(Boolean).join("\n");
}
