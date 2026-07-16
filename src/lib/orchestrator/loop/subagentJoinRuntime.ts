import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import {
  extractDelegatedSubagentActivities,
  rememberDelegatedSubagentActivities,
} from "./toolActivityTracking";

export async function joinPendingSubagentsForParent(input: {
  callbacks: OrchestratorCallbacks;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  reason: "plan_finalization" | "parent_final_response";
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
      ? `SUBAGENT_JOIN_RESULT：运行时已汇合子智能体。summary 是子模型生成的未验证假设，不能单独作为事实；只有 provenance.source=tool_observation、带 owner 且带工具调用或源码观察身份的 evidence 才是可信线索。join 仅注入紧凑引用，不会把 child 的源码窗口变成 parent 已消费上下文；在据此修改文件前，必须在租约释放后对相同目标做一次定向 read_file。\n${content}`
      : `SUBAGENT_JOIN_RESULT: The runtime joined the subagents. Each summary is an unverified child hypothesis and is not evidence by itself; only evidence with provenance.source=tool_observation, an owner, and a tool-call or source-observation identity is a trusted lead. Join injects only a compact reference and never turns a child's source window into parent-consumed context; before mutating from it, perform a targeted read_file for the same target after the lease is released.\n${content}`,
  });
  const syntheticResult: ToolExecutionResult = {
    toolCallId: `runtime-wait-subagents-${Date.now()}`,
    name: "wait_subagents",
    target: pendingIds.join(","),
    content,
    isError: false,
    lifecycleState: "completed",
  };
  const delegatedActivities = extractDelegatedSubagentActivities(syntheticResult);
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
    evidenceCount: delegatedActivities.length,
    sourceEvidenceCount,
    evidenceAdoptionRate: sourceEvidenceCount > 0
      ? delegatedActivities.length / sourceEvidenceCount
      : 0,
    distinctEvidenceTargets,
    requiredParentRereads: delegatedActivities.filter((activity) =>
      activity.delegatedObservation?.requiresParentReread === true
    ).length,
    potentialParentDiscoveryReadsAvoided: distinctEvidenceTargets,
    baselineComparison: "not_available",
    summaryProseTrusted: false,
    provenanceBackedEvidenceCount: delegatedActivities.length,
    delegatedObservationReuse: "reference_only_requires_parent_reread",
    pendingIds: joined.pendingIds,
  });
  return true;
}
