import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import { isAuthoritativeSubagentClosure } from "../../subagents";
import type { PreferredDelegationScopeJoinOutcome } from "../../preferredDelegationScopes";
import { parseToolFeedbackEnvelope } from "../../toolFeedbackEnvelope";
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

export interface ParentSubagentJoinResult {
  joined: boolean;
  requestedIds: string[];
  resultIds: string[];
  adoptedEvidenceCount: number;
  sourceEvidenceCount: number;
  requiredParentRereads: number;
  scopeOutcomes: PreferredDelegationScopeJoinOutcome[];
}

function emptyParentSubagentJoinResult(
  requestedIds: string[] = [],
): ParentSubagentJoinResult {
  return {
    joined: false,
    requestedIds,
    resultIds: [],
    adoptedEvidenceCount: 0,
    sourceEvidenceCount: 0,
    requiredParentRereads: 0,
    scopeOutcomes: [],
  };
}

/**
 * Project a completed wait_subagents tool observation onto the same typed
 * scope outcome used by runtime-owned joins. Keeping this projection in one
 * place prevents an explicit model wait from adopting child evidence while
 * leaving the collaboration ledger stuck in `spawned`.
 */
export function extractPreferredDelegationScopeJoinOutcomes(
  result: ToolExecutionResult,
): PreferredDelegationScopeJoinOutcome[] {
  if (result.name !== "wait_subagents" || result.isError) return [];
  const evidenceContent = result.runtimeEvidenceContent || result.content || "";
  const parsedFeedback = parseToolFeedbackEnvelope(evidenceContent);
  const body = parsedFeedback?.body || evidenceContent;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  const results = Array.isArray((payload as { results?: unknown[] })?.results)
    ? (payload as { results: unknown[] }).results
    : [];
  const delegatedEvidenceActivities = extractDelegatedSubagentActivities(
    result,
    { evidenceLedger: true },
  );
  return results.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    const subagentId = String(entry.subagentId || "").trim();
    const scopeKey = String(entry.scopeKey || "").trim();
    const status = String(entry.status || "").trim();
    if (!subagentId || !scopeKey || !status) return [];
    const closureAudit = entry.closureAudit && typeof entry.closureAudit === "object"
      ? entry.closureAudit as Record<string, unknown>
      : null;
    const authoritativeClosure = isAuthoritativeSubagentClosure(closureAudit, {
      subagentId,
      scopeKey,
    });
    const closureState = authoritativeClosure && closureAudit?.state === "satisfied"
      ? "satisfied" as const
      : authoritativeClosure && closureAudit?.state === "partial"
        ? "partial" as const
        : "unverified" as const;
    const adoptedEvidenceCount = delegatedEvidenceActivities.filter((activity) =>
      activity.delegatedObservation?.owner.subagentId === subagentId
    ).length;
    const adoptedEvidenceTargets = [...new Set(delegatedEvidenceActivities
      .filter((activity) =>
        activity.delegatedObservation?.owner.subagentId === subagentId
      )
      .map((activity) => String(activity.target || "").trim())
      .filter(Boolean))];
    return [{
      subagentId,
      scopeKey,
      status,
      closureState,
      adoptedEvidenceCount,
      adoptedEvidenceTargets,
      consumed:
        status === "completed" &&
        closureState === "satisfied" &&
        Number(closureAudit?.substantiveEvidenceCount || 0) > 0 &&
        adoptedEvidenceCount > 0,
    }];
  });
}

export async function joinPendingSubagentsForParent(input: {
  callbacks: OrchestratorCallbacks;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  reason:
    | "preferred_early_materialization"
    | "plan_finalization"
    | "parent_final_response"
    | "scope_conflict";
}): Promise<ParentSubagentJoinResult> {
  const pendingIds = input.callbacks.getPendingSubagentIds?.() || [];
  if (pendingIds.length === 0 || !input.callbacks.waitSubagents) {
    return emptyParentSubagentJoinResult(pendingIds);
  }

  input.callbacks.onDebugEvent?.("parent_join_required", {
    reason: input.reason,
    pendingIds,
    pendingCount: pendingIds.length,
  });
  const waitResult = await input.callbacks.waitSubagents({ subagentIds: pendingIds });
  const content = JSON.stringify(waitResult);
  input.callbacks.appendMessage({
    role: "user",
    content: input.callbacks.getPreferredLanguage() === "zh"
      ? `SUBAGENT_JOIN_RESULT：运行时已汇合子智能体。summary 是子模型生成的未验证假设，不能单独作为事实；只有 provenance.source=tool_observation、带 owner 和工具调用身份的实质性 evidence 才能进入计划证据账本。degraded/blocked 子任务本身不会提升为完成，但其中被运行时接受且路径已覆盖的独立观察仍可用于制定计划；failed/uncovered 精确路径继续作为父任务补读候选。执行阶段的修改仍需完整版本身份和父级验证。若用户禁止主线程重读，则必须把未覆盖路径保留为未解决阻塞，不能把 partial output 宣称为完成。\n${content}`
      : `SUBAGENT_JOIN_RESULT: The runtime joined the subagents. Each summary is an unverified child hypothesis and is not evidence by itself. Only substantive evidence with tool_observation provenance, an owner, and tool-call identity may enter the Plan evidence ledger. A degraded or blocked child is never promoted as task completion, but independently accepted observations on covered paths remain usable for Plan authoring; exact failed or uncovered paths remain targeted parent read_file candidates. Execution mutations still require complete version identity and parent verification. If the user forbids parent rereads, keep uncovered paths as unresolved blockers and do not claim partial output as completion.\n${content}`,
  });
  const syntheticResult: ToolExecutionResult = {
    toolCallId: `runtime-wait-subagents-${Date.now()}`,
    name: "wait_subagents",
    target: pendingIds.join(","),
    content,
    isError: false,
    lifecycleState: "completed",
  };
  const delegatedEvidenceActivities = extractDelegatedSubagentActivities(
    syntheticResult,
    { evidenceLedger: true },
  );
  const parentRereadObligations = extractSubagentParentRereadObligations(
    syntheticResult,
    { evidenceLedger: true },
  );
  const delegatedActivities = [...delegatedEvidenceActivities, ...parentRereadObligations];
  const sourceEvidenceCount = waitResult.results.reduce(
    (count, entry) => count + entry.evidence.length,
    0,
  );
  const distinctEvidenceTargets = new Set(
    delegatedActivities.map((activity) => activity.target).filter(Boolean),
  ).size;
  const requiredParentRereads = delegatedActivities.filter((activity) =>
    activity.delegatedObservation?.requiresParentReread === true
  ).length;
  const scopeOutcomes = extractPreferredDelegationScopeJoinOutcomes(syntheticResult);
  rememberDelegatedSubagentActivities(input.recentToolActivity, delegatedActivities);
  rememberDelegatedSubagentActivities(
    input.recentPlanToolActivity,
    delegatedActivities,
    { evidenceLedger: true },
  );
  input.callbacks.onDebugEvent?.("parent_join_injected", {
    reason: input.reason,
    requestedIds: pendingIds,
    resultIds: waitResult.results.map((entry) => entry.subagentId),
    statuses: waitResult.results.map((entry) => entry.status),
    evidenceCount: delegatedEvidenceActivities.length,
    sourceEvidenceCount,
    evidenceAdoptionRate: sourceEvidenceCount > 0
      ? delegatedEvidenceActivities.length / sourceEvidenceCount
      : 0,
    distinctEvidenceTargets,
    requiredParentRereads,
    scopeOutcomes,
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
    delegatedObservationReuse: "plan_observations_reused_execution_mutations_parent_verified",
    pendingIds: waitResult.pendingIds,
  });
  return {
    joined: true,
    requestedIds: pendingIds,
    resultIds: waitResult.results.map((entry) => entry.subagentId),
    adoptedEvidenceCount: delegatedEvidenceActivities.length,
    sourceEvidenceCount,
    requiredParentRereads,
    scopeOutcomes,
  };
}
