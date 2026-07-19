import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import {
  extractDelegatedSubagentActivities,
  extractSubagentParentRereadObligations,
  rememberDelegatedSubagentActivities,
} from "./toolActivityTracking";

export function shouldJoinPendingSubagentsAfterScopeDeferral(
  results: ToolExecutionResult[],
): boolean {
  const hasParentScopeDeferral = results.some((result) =>
    result.internalFeedback === true &&
    result.qualityGateReason === "subagent_scope_policy_deferred"
  );
  // A mixed batch may contain a real mutation/validation outcome whose normal
  // recovery and failure accounting must not be skipped. Deterministic join is
  // the whole-batch outcome only when every result is runtime-owned feedback.
  return hasParentScopeDeferral && results.every((result) =>
    result.internalFeedback === true
  );
}

export async function joinPendingSubagentsForParent(input: {
  callbacks: OrchestratorCallbacks;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  reason: "plan_finalization" | "parent_final_response" | "scope_conflict";
}): Promise<boolean> {
  const pendingIds = input.callbacks.getPendingSubagentIds?.() || [];
  if (pendingIds.length === 0 || !input.callbacks.waitSubagents) return false;

  input.callbacks.onDebugEvent?.("parent_join_required", {
    reason: input.reason,
    pendingIds,
    pendingCount: pendingIds.length,
  });
  const joined = await input.callbacks.waitSubagents({ subagentIds: pendingIds });
  const content = JSON.stringify(joined);
  input.callbacks.appendMessage({
    role: "user",
    content: input.callbacks.getPreferredLanguage() === "zh"
      ? `SUBAGENT_JOIN_RESULT：运行时已汇合子智能体。summary 是子模型生成的未验证假设，不能单独作为事实；只有 provenance.source=tool_observation、带 owner、工具调用身份、版本和内容哈希的 evidence 才可复用。缺少完整版本身份或不具备自校验能力的修改，只能在租约释放后把对应路径作为定向 parent read_file 候选。degraded/blocked 子任务不会提升为完成证据；其 failed/uncovered 精确路径也仅作为父任务补读候选。若用户禁止主线程重读，则必须保留为未解决阻塞，不能把补读或 partial output 宣称为完成。\n${content}`
      : `SUBAGENT_JOIN_RESULT: The runtime joined the subagents. Each summary is an unverified child hypothesis and is not evidence by itself. Evidence is reusable only with tool_observation provenance, owner, tool-call identity, version, and content hash. Evidence without complete version identity, or a mutation that cannot self-verify its source context, remains only a targeted parent read_file candidate after the lease is released. A degraded/blocked child is never promoted as completion evidence; exact failed/uncovered paths are also only parent-reread candidates. If the user forbids parent rereads, keep them as unresolved blockers and do not claim the reread or partial output as completion.\n${content}`,
  });
  const syntheticResult: ToolExecutionResult = {
    toolCallId: `runtime-wait-subagents-${Date.now()}`,
    name: "wait_subagents",
    target: pendingIds.join(","),
    content,
    isError: false,
    lifecycleState: "completed",
  };
  const delegatedEvidenceActivities = extractDelegatedSubagentActivities(syntheticResult);
  const parentRereadObligations = extractSubagentParentRereadObligations(syntheticResult);
  const delegatedActivities = [...delegatedEvidenceActivities, ...parentRereadObligations];
  const sourceEvidenceCount = joined.results.reduce(
    (count, entry) => count + entry.evidence.length,
    0,
  );
  const distinctEvidenceTargets = new Set(
    delegatedActivities.map((activity) => activity.target).filter(Boolean),
  ).size;
  rememberDelegatedSubagentActivities(input.recentToolActivity, delegatedActivities);
  rememberDelegatedSubagentActivities(input.recentPlanToolActivity, delegatedActivities);
  input.callbacks.onDebugEvent?.("parent_join_injected", {
    reason: input.reason,
    requestedIds: pendingIds,
    resultIds: joined.results.map((entry) => entry.subagentId),
    statuses: joined.results.map((entry) => entry.status),
    evidenceCount: delegatedEvidenceActivities.length,
    sourceEvidenceCount,
    evidenceAdoptionRate: sourceEvidenceCount > 0
      ? delegatedEvidenceActivities.length / sourceEvidenceCount
      : 0,
    distinctEvidenceTargets,
    requiredParentRereads: delegatedActivities.filter((activity) =>
      activity.delegatedObservation?.requiresParentReread === true
    ).length,
    versionedReuseCandidates: delegatedActivities.filter((activity) =>
      activity.name === "read_file" &&
      !!activity.delegatedObservation?.sourceToolCallId &&
      !!activity.delegatedObservation?.sourceObservationKey &&
      !!activity.delegatedObservation?.sourceVersion &&
      !!activity.delegatedObservation?.sourceContentHash &&
      Number.isFinite(activity.delegatedObservation?.sourceContentChars)
    ).length,
    potentialParentDiscoveryReadsAvoided: distinctEvidenceTargets,
    baselineComparison: "not_available",
    summaryProseTrusted: false,
    provenanceBackedEvidenceCount: delegatedEvidenceActivities.length,
    delegatedObservationReuse: "version_checked_self_verifying_mutations_only",
    pendingIds: joined.pendingIds,
  });
  return true;
}
