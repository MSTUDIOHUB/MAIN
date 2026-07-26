import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  isFinitePlanValidationCommand,
  type PlanExecutionEvidenceEntry,
} from "../../workflowModels";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import {
  isAuthoritativeSubagentClosure,
  type CollaborationTaskJoinOutcome,
} from "../../subagents";
import { parseToolFeedbackEnvelope } from "../../toolFeedbackEnvelope";
import type { WaitSubagentsResult } from "../../subagents";
import { isWorkspaceMutationToolName } from "../../workspaceMutationTools";
import {
  extractDelegatedSubagentActivities,
  extractSubagentParentRereadObligations,
  rememberDelegatedSubagentActivities,
} from "./toolActivityTracking";

const PARENT_STABLE_WORKSPACE_TOOL_NAMES = new Set([
  "execute_command",
  "start_dev_server",
  "browser_evaluate",
  "computer_use",
]);

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
  adoptedMutationEvidenceCount: number;
  adoptedMutationTargets: string[];
  taskOutcomes: CollaborationTaskJoinOutcome[];
}

function compactSubagentJoinText(value: unknown, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 34)).trimEnd()}\n[model join view compacted]`;
}

function parseJoinedSubagentResultRecords(
  result: ToolExecutionResult,
): Record<string, unknown>[] {
  if (result.name !== "wait_subagents" || result.isError) return [];
  const evidenceContent = result.runtimeEvidenceContent || result.content || "";
  const parsedFeedback = parseToolFeedbackEnvelope(evidenceContent);
  const body = parsedFeedback?.body || evidenceContent;
  try {
    const payload = JSON.parse(body) as { results?: unknown[] };
    return Array.isArray(payload?.results)
      ? payload.results.filter((value): value is Record<string, unknown> =>
          !!value && typeof value === "object" && !Array.isArray(value)
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Adopt only runtime-authored, successful child mutation records whose
 * closure owner matches the joined result. Child prose never participates.
 */
export function extractJoinedSubagentMutationEvidence(
  result: ToolExecutionResult,
): PlanExecutionEvidenceEntry[] {
  const adopted: PlanExecutionEvidenceEntry[] = [];
  const seenIds = new Set<string>();
  for (const record of parseJoinedSubagentResultRecords(result)) {
    const subagentId = String(record.subagentId || "").trim();
    const collaborationTaskId = String(record.collaborationTaskId || "").trim();
    const scopeKey = String(record.scopeKey || "").trim();
    const closureAudit = record.closureAudit && typeof record.closureAudit === "object"
      ? record.closureAudit as Record<string, unknown>
      : null;
    if (
      !subagentId ||
      !scopeKey ||
      !isAuthoritativeSubagentClosure(closureAudit, {
        ...(collaborationTaskId ? { collaborationTaskId } : {}),
        subagentId,
        scopeKey,
      })
    ) continue;
    const closureRunId = String(closureAudit.owner.runId || "").trim();
    const mutationEvidence = Array.isArray(record.mutationEvidence)
      ? record.mutationEvidence
      : [];
    for (const value of mutationEvidence) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as PlanExecutionEvidenceEntry;
      const id = String(entry.id || "").trim();
      const target = String(entry.target || entry.value || "").trim();
      if (
        !id ||
        seenIds.has(id) ||
        entry.kind !== "file" ||
        !target ||
        !isWorkspaceMutationToolName(entry.sourceTool) ||
        String(entry.transactionId || "").trim() !== subagentId ||
        (closureRunId && String(entry.runId || "").trim() !== closureRunId) ||
        ["failed", "pending", "unknown", "running", "stopped"].includes(
          String(entry.observationStatus || ""),
        )
      ) continue;
      seenIds.add(id);
      adopted.push({
        ...entry,
        target,
        value: target,
      });
    }
  }
  return adopted;
}

/**
 * Commands and interactive checks must observe a settled child-write
 * boundary. Read/edit work may continue concurrently until this exact point.
 */
export function shouldJoinPendingSubagentsBeforeParentValidation(input: {
  subagentDepth: number;
  pendingSubagentIds: string[];
  toolCalls: Array<{ name: string; arguments?: string }>;
  recoveryNextCapability?: string | null;
}): boolean {
  if (input.subagentDepth > 0 || input.pendingSubagentIds.length === 0) {
    return false;
  }
  return input.toolCalls.some((call) => {
    if (PARENT_STABLE_WORKSPACE_TOOL_NAMES.has(call.name)) return true;
    if (call.name !== "run_command") return false;
    if (
      input.recoveryNextCapability === "validation" ||
      input.recoveryNextCapability === "reconcile_server"
    ) return true;
    try {
      const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      return isFinitePlanValidationCommand(String(args.command || ""));
    } catch {
      return false;
    }
  });
}

/**
 * Keep the complete child envelope in the runtime evidence ledger while
 * projecting only decision-useful evidence into the parent model transcript.
 * In particular, factReferences repeat the same observation identity once per
 * derived fact and can turn a two-child join into a 30k+ user message without
 * giving the parent any additional source truth.
 */
export function buildSubagentJoinModelPayload(waitResult: WaitSubagentsResult): {
  results: Array<Record<string, unknown>>;
  pendingIds: string[];
} {
  return {
    pendingIds: waitResult.pendingIds,
    results: waitResult.results.map((entry) => {
      const evidenceLimit = 12;
      const closureAudit = entry.closureAudit;
      return {
        subagentId: entry.subagentId,
        collaborationTaskId: entry.collaborationTaskId,
        taskKey: entry.scopeKey,
        name: entry.name,
        scopeKey: entry.scopeKey,
        status: entry.status,
        evidence: entry.evidence.slice(0, evidenceLimit).map((evidence) => ({
          tool: evidence.tool,
          target: evidence.target,
          detail: compactSubagentJoinText(evidence.detail, 700),
          ...(evidence.facts?.length
            ? {
                facts: evidence.facts
                  .slice(0, 16)
                  .map((fact) => compactSubagentJoinText(fact, 240)),
                factsTruncated: evidence.facts.length > 16,
              }
            : {}),
          ...(evidence.observation
            ? {
                observation: {
                  kind: evidence.observation.kind,
                  sourcePath: evidence.observation.sourcePath,
                  contentChars: evidence.observation.contentChars,
                  negative: evidence.observation.negative,
                  substantive: evidence.observation.substantive,
                  ...(evidence.observation.queryRef
                    ? { queryRef: evidence.observation.queryRef }
                    : {}),
                  ...(evidence.observation.observedTargetRefs?.length
                    ? {
                        observedTargetRefs:
                          evidence.observation.observedTargetRefs.slice(0, 16),
                      }
                    : {}),
                  ...(evidence.observation.observedOccurrences?.length
                    ? {
                        observedOccurrences:
                          evidence.observation.observedOccurrences.slice(0, 16),
                      }
                    : {}),
                },
              }
            : {}),
          provenance: {
            source: evidence.provenance.source,
            owner: evidence.provenance.owner,
            sourceToolCallId: evidence.provenance.sourceToolCallId,
            ...(evidence.provenance.sourceObservation
              ? {
                  sourceObservation: {
                    key: evidence.provenance.sourceObservation.key,
                    path: evidence.provenance.sourceObservation.path,
                    versionToken:
                      evidence.provenance.sourceObservation.versionToken,
                    contentHash:
                      evidence.provenance.sourceObservation.contentHash,
                    source: evidence.provenance.sourceObservation.source,
                    window: evidence.provenance.sourceObservation.window,
                  },
                }
              : {}),
            sourceVersion: evidence.provenance.sourceVersion,
            sourceContentHash: evidence.provenance.sourceContentHash,
            sourceContentChars: evidence.provenance.sourceContentChars,
            sourceRange: evidence.provenance.sourceRange,
          },
        })),
        evidenceCount: entry.evidence.length,
        evidenceTruncated: entry.evidence.length > evidenceLimit,
        ...(closureAudit
          ? {
              closureAudit: {
                schemaVersion: closureAudit.schemaVersion,
                scopeKey: closureAudit.scopeKey,
                status: closureAudit.status,
                state: closureAudit.state,
                remainingWork: closureAudit.remainingWork,
                observationCount: closureAudit.observationCount,
                substantiveEvidenceCount:
                  closureAudit.substantiveEvidenceCount,
                requiredPaths: closureAudit.requiredPaths.slice(0, 24),
                coveredPaths: closureAudit.coveredPaths.slice(0, 24),
                failedPaths: closureAudit.failedPaths.slice(0, 24),
                uncoveredPaths: closureAudit.uncoveredPaths.slice(0, 24),
                reasonCode: closureAudit.reasonCode,
                reason: compactSubagentJoinText(closureAudit.reason, 500),
              },
            }
          : {}),
        ...(entry.blocker
          ? { blocker: compactSubagentJoinText(entry.blocker, 800) }
          : {}),
        ...(entry.remainingWork
          ? { remainingWork: compactSubagentJoinText(entry.remainingWork, 800) }
          : {}),
        ...(entry.error
          ? { error: compactSubagentJoinText(entry.error, 800) }
          : {}),
      };
    }),
  };
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
    adoptedMutationEvidenceCount: 0,
    adoptedMutationTargets: [],
    taskOutcomes: [],
  };
}

/**
 * Project a completed wait_subagents tool observation onto the same typed
 * scope outcome used by runtime-owned joins. Keeping this projection in one
 * place prevents an explicit model wait from adopting child evidence while
 * leaving the collaboration ledger stuck in `spawned`.
 */
export function extractCollaborationTaskJoinOutcomes(
  result: ToolExecutionResult,
): CollaborationTaskJoinOutcome[] {
  const results = parseJoinedSubagentResultRecords(result);
  const delegatedEvidenceActivities = extractDelegatedSubagentActivities(
    result,
    { evidenceLedger: true },
  );
  return results.flatMap((entry) => {
    const subagentId = String(entry.subagentId || "").trim();
    const collaborationTaskId = String(entry.collaborationTaskId || "").trim();
    const taskKey = String(entry.scopeKey || "").trim();
    const status = String(entry.status || "").trim();
    if (!collaborationTaskId || !subagentId || !taskKey || !status) return [];
    const closureAudit = entry.closureAudit && typeof entry.closureAudit === "object"
      ? entry.closureAudit as Record<string, unknown>
      : null;
    const authoritativeClosure = isAuthoritativeSubagentClosure(closureAudit, {
      collaborationTaskId,
      subagentId,
      scopeKey: taskKey,
    });
    const closureState = authoritativeClosure && closureAudit?.state === "satisfied"
      ? "satisfied" as const
      : authoritativeClosure && closureAudit?.state === "partial"
        ? "partial" as const
        : "unverified" as const;
    const adoptedEvidenceCount = delegatedEvidenceActivities.filter((activity) =>
      activity.delegatedObservation?.owner.collaborationTaskId ===
        collaborationTaskId &&
      activity.delegatedObservation?.owner.subagentId === subagentId
    ).length;
    const adoptedEvidenceTargets = [...new Set(delegatedEvidenceActivities
      .filter((activity) =>
        activity.delegatedObservation?.owner.collaborationTaskId ===
          collaborationTaskId &&
        activity.delegatedObservation?.owner.subagentId === subagentId
      )
      .map((activity) => String(activity.target || "").trim())
      .filter(Boolean))];
    return [{
      collaborationTaskId,
      subagentId,
      taskKey,
      status,
      closureState,
      adoptedEvidenceCount,
      adoptedEvidenceTargets,
      evidenceAdopted:
        (closureState === "satisfied" || closureState === "partial") &&
        Number(closureAudit?.substantiveEvidenceCount || 0) > 0 &&
        adoptedEvidenceCount > 0,
      terminalComplete:
        status === "completed" && closureState === "satisfied",
    }];
  });
}

export async function joinPendingSubagentsForParent(input: {
  callbacks: OrchestratorCallbacks;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  reason:
    | "plan_finalization"
    | "parent_final_response"
    | "parent_validation"
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
  const modelContent = JSON.stringify(buildSubagentJoinModelPayload(waitResult));
  input.callbacks.appendMessage({
    role: "user",
    content: input.callbacks.getPreferredLanguage() === "zh"
      ? `SUBAGENT_JOIN_RESULT：运行时已汇合子智能体。为避免未验证建议覆盖父任务判断，模型上下文只注入 provenance.source=tool_observation、带 owner 和工具调用身份的实质性 evidence；子模型的自由文本 summary/parentHandoff 仅保留在审计记录中。degraded/blocked 子任务本身不会提升为完成，但其中被运行时接受且路径已覆盖的独立观察仍可用于制定计划；failed/uncovered 精确路径继续作为父任务补读候选。执行阶段的修改仍需完整版本身份和父级验证。若用户禁止主线程重读，则必须把未覆盖路径保留为未解决阻塞，不能把 partial output 宣称为完成。\n${modelContent}`
      : `SUBAGENT_JOIN_RESULT: The runtime joined the subagents. To keep unverified recommendations from overriding the parent judgment, only substantive evidence with tool_observation provenance, an owner, and tool-call identity is injected into the model context; free-form child summary/parentHandoff text remains in the audit record only. A degraded or blocked child is never promoted as task completion, but independently accepted observations on covered paths remain usable for Plan authoring; exact failed or uncovered paths remain targeted parent read_file candidates. Execution mutations still require complete version identity and parent verification. If the user forbids parent rereads, keep uncovered paths as unresolved blockers and do not claim partial output as completion.\n${modelContent}`,
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
  const taskOutcomes = extractCollaborationTaskJoinOutcomes(syntheticResult);
  const mutationEvidence = extractJoinedSubagentMutationEvidence(syntheticResult);
  input.callbacks.adoptSubagentMutationEvidence?.(mutationEvidence);
  const adoptedMutationTargets = [...new Set(mutationEvidence
    .map((entry) => String(entry.target || entry.value || "").trim())
    .filter(Boolean))];
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
    adoptedMutationEvidenceCount: mutationEvidence.length,
    adoptedMutationTargets,
    taskOutcomes,
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
    internalPayloadChars: content.length,
    modelPayloadChars: modelContent.length,
    pendingIds: waitResult.pendingIds,
  });
  return {
    joined: true,
    requestedIds: pendingIds,
    resultIds: waitResult.results.map((entry) => entry.subagentId),
    adoptedEvidenceCount: delegatedEvidenceActivities.length,
    sourceEvidenceCount,
    requiredParentRereads,
    adoptedMutationEvidenceCount: mutationEvidence.length,
    adoptedMutationTargets,
    taskOutcomes,
  };
}
