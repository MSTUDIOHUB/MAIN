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
      ? `SUBAGENT_JOIN_RESULT：运行时已汇合子智能体。请基于下面的结构化摘要和证据继续整合，不要重新探索其租约范围。\n${content}`
      : `SUBAGENT_JOIN_RESULT: The runtime joined the subagents. Continue from the structured summaries and evidence below without re-exploring their leased scopes.\n${content}`,
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
  rememberDelegatedSubagentActivities(input.recentToolActivity, delegatedActivities);
  rememberDelegatedSubagentActivities(input.recentPlanToolActivity, delegatedActivities);
  input.callbacks.onDebugEvent?.("parent_join_injected", {
    reason: input.reason,
    requestedIds: pendingIds,
    resultIds: joined.results.map((entry) => entry.subagentId),
    statuses: joined.results.map((entry) => entry.status),
    evidenceCount: delegatedActivities.length,
    pendingIds: joined.pendingIds,
  });
  return true;
}
