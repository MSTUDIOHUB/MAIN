import { isExecutionPlanArtifactWrite, isSuccessfulPlanArtifactWriteResult, isTasksPlanWrite, truncateForLog } from "../../orchestrator";
import {
  EDIT_PROGRESS_TOOL_NAMES,
  EXECUTION_VERIFICATION_TOOL_NAMES,
  MAX_PLAN_EVIDENCE_TOOL_ACTIVITY,
  MAX_RECENT_PLAN_TOOL_ACTIVITY,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
} from "../../orchestrator";
import {
  hasResolvedWorkspaceMutationTarget,
  isWorkspaceMutationToolCall,
  isWorkspaceMutationToolName,
} from "../../workspaceMutationTools";
import { browserResultLooksSuccessful, classifyCommandResultOutcome } from "../../planEvidence";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  extractPlanEvidenceFacts,
  mergePlanEvidenceFacts,
  summarizePlanEvidenceDetail,
} from "../../planMaterialization";
import { isNoOpToolFeedback, parseToolFeedbackEnvelope } from "../../toolFeedbackEnvelope";
import type { ToolExecutionResult } from "../types";
import { isSuccessfulVerificationToolObservation } from "../../verificationEvidence";
import { normalizeWorkspacePathIdentity } from "../../workspacePaths";

const SUBAGENT_EVIDENCE_TOOLS = new Set([
  "read_file",
  "read_file_window",
  "read_document",
  "get_file_outline",
  "grep_search",
  "code_ast_query",
  "find_symbol_references",
  "git_diff",
]);

function compactLatestActivityDetail(value: string, maxChars: number): string {
  const detail = String(value || "").trim();
  if (detail.length <= maxChars) return detail;
  const separator = " … ";
  const headBudget = Math.min(80, Math.max(0, maxChars - separator.length));
  const tailBudget = Math.max(0, maxChars - separator.length - headBudget);
  return `${detail.slice(0, headBudget)}${separator}${detail.slice(-tailBudget)}`;
}

function extractAstObservation(
  result: ToolExecutionResult,
): PlanToolActivitySummary["astObservation"] | undefined {
  if (result.name !== "code_ast_query" || result.isError) return undefined;
  const parsedFeedback = parseToolFeedbackEnvelope(result.content || "");
  const body = parsedFeedback?.body || result.content || "";
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    payload = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const path = String(payload.path || result.target || "").trim();
  const language = String(payload.language || "").trim();
  const versionToken = String(payload.versionToken || "").trim();
  const query = String(payload.query || "").trim();
  const rawExactMatchCount = Number(payload.exactMatchCount);
  if (!path || !language || !versionToken || !Array.isArray(payload.symbols)) return undefined;
  const symbols = payload.symbols.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const symbol = item as Record<string, unknown>;
    const name = String(symbol.name || "").trim();
    const kind = String(symbol.kind || "").trim();
    const syntaxKind = String(symbol.syntaxKind || "").trim();
    const rawStartLine = Number(symbol.startLine);
    const rawEndLine = Number(symbol.endLine);
    if (!Number.isFinite(rawStartLine) || !Number.isFinite(rawEndLine)) return [];
    const startLine = Math.floor(rawStartLine);
    const endLine = Math.floor(rawEndLine);
    if (!name || !kind || !syntaxKind || startLine <= 0 || endLine < startLine) return [];
    return [{ name, kind, syntaxKind, startLine, endLine }];
  }).slice(0, 120);
  return {
    path,
    language,
    versionToken,
    query,
    exactMatchCount: Number.isFinite(rawExactMatchCount)
      ? Math.max(0, Math.floor(rawExactMatchCount))
      : 0,
    hasErrors: payload.hasErrors === true,
    truncated: payload.truncated === true || payload.symbols.length > symbols.length,
    symbols,
  };
}

function appendBoundedToolActivity(
  targetList: PlanToolActivitySummary[],
  activity: PlanToolActivitySummary,
  maxItems = MAX_RECENT_PLAN_TOOL_ACTIVITY,
  mergeByTarget = false,
): void {
  if (mergeByTarget) {
    const normalizedTarget = String(activity.target || "").replace(/\\/g, "/").toLowerCase();
    const delegatedIdentity = (item: PlanToolActivitySummary): string => {
      const delegated = item.delegatedObservation;
      if (!delegated) return "";
      if (delegated.sourceObservationKey) return delegated.sourceObservationKey;
      const range = delegated.sourceRange;
      return [
        delegated.sourceVersion || "",
        range ? `${range.startLine}-${range.endLine}/${range.totalLines}` : "",
      ].filter(Boolean).join("::");
    };
    const activityDelegatedIdentity = delegatedIdentity(activity);
    const existing = targetList.find((item) =>
      item.name === activity.name &&
      String(item.target || "").replace(/\\/g, "/").toLowerCase() === normalizedTarget &&
      (
        !activityDelegatedIdentity ||
        delegatedIdentity(item) === activityDelegatedIdentity
      )
    );
    if (existing) {
      existing.facts = mergePlanEvidenceFacts(existing.facts, activity.facts);
      if (activity.readFileObservation) {
        existing.readFileObservation = { ...activity.readFileObservation };
      }
      if (activity.astObservation) {
        existing.astObservation = {
          ...activity.astObservation,
          symbols: activity.astObservation.symbols.map((symbol) => ({ ...symbol })),
        };
      }
      if (activity.delegatedObservation) {
        existing.delegatedObservation = {
          ...activity.delegatedObservation,
          owner: { ...activity.delegatedObservation.owner },
          ...(activity.delegatedObservation.sourceRange
            ? { sourceRange: { ...activity.delegatedObservation.sourceRange } }
            : {}),
        };
      }
      const details = [existing.detail, activity.detail]
        .map((detail) => String(detail || "").trim())
        .filter((detail, index, all) => detail && all.indexOf(detail) === index);
      existing.status = existing.status === "succeeded" || activity.status === "succeeded"
        ? "succeeded"
        : activity.status;
      if (details.length === 1) existing.detail = details[0].slice(0, 440);
      if (details.length > 1) {
        const latest = details[details.length - 1];
        const separator = " | ";
        const latestBudget = Math.min(latest.length, 260);
        const previousBudget = Math.max(0, 440 - separator.length - latestBudget);
        existing.detail = `${compactLatestActivityDetail(details[0], previousBudget)}${separator}${compactLatestActivityDetail(latest, latestBudget)}`;
      }
      return;
    }
  }
  targetList.push(activity);
  if (targetList.length > maxItems) {
    targetList.splice(0, targetList.length - maxItems);
  }
}

export interface ToolActivityRetentionOptions {
  evidenceLedger?: boolean;
}

export function extractDelegatedSubagentActivities(
  result: ToolExecutionResult,
): PlanToolActivitySummary[] {
  if (result.name !== "wait_subagents" || result.isError) return [];
  const parsedFeedback = parseToolFeedbackEnvelope(result.content || "");
  const body = parsedFeedback?.body || result.content || "";
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  const results = Array.isArray((payload as { results?: unknown[] })?.results)
    ? (payload as { results: unknown[] }).results
    : [];
  const activities: PlanToolActivitySummary[] = [];
  for (const envelope of results) {
    const record = envelope && typeof envelope === "object"
      ? envelope as Record<string, unknown>
      : {};
    const status = String(record.status || "");
    const envelopeSubagentId = String(record.subagentId || "").trim();
    if (!/^(?:completed|blocked|degraded)$/.test(status) || !Array.isArray(record.evidence)) continue;
    const closureAudit = record.closureAudit && typeof record.closureAudit === "object"
      ? record.closureAudit as Record<string, unknown>
      : null;
    // A runtime that publishes a structured closure audit owns the stronger
    // completion contract. Partial child observations remain visible in the
    // child run, but cannot be promoted as completed parent-plan evidence.
    // Older envelopes without closureAudit remain compatible and are still
    // checked evidence-by-evidence below.
    if (closureAudit && closureAudit.state !== "satisfied") continue;
    const requiredPaths = Array.isArray(closureAudit?.requiredPaths)
      ? closureAudit.requiredPaths.map((path) => String(path || "").trim()).filter(Boolean)
      : [];
    const coveredPaths = new Set(Array.isArray(closureAudit?.coveredPaths)
      ? closureAudit.coveredPaths
        .map((path) => normalizeWorkspacePathIdentity(String(path || "")))
        .filter(Boolean)
      : []);
    const failedPaths = Array.isArray(closureAudit?.failedPaths)
      ? closureAudit.failedPaths.map((path) => String(path || "").trim()).filter(Boolean)
      : [];
    const uncoveredPaths = Array.isArray(closureAudit?.uncoveredPaths)
      ? closureAudit.uncoveredPaths.map((path) => String(path || "").trim()).filter(Boolean)
      : [];
    const hasPathCoverageAudit = requiredPaths.length > 0 ||
      Array.isArray(closureAudit?.coveredPaths) ||
      Array.isArray(closureAudit?.failedPaths) ||
      Array.isArray(closureAudit?.uncoveredPaths);
    const substantiveEvidencePaths = new Set(record.evidence.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const evidence = item as Record<string, unknown>;
      const observation = evidence.observation && typeof evidence.observation === "object"
        ? evidence.observation as Record<string, unknown>
        : null;
      if (observation?.substantive !== true) return [];
      const path = String(observation.sourcePath || evidence.target || "").trim();
      const identity = normalizeWorkspacePathIdentity(path);
      return identity ? [identity] : [];
    }));
    if (
      closureAudit &&
      hasPathCoverageAudit &&
      (
        failedPaths.length > 0 ||
        uncoveredPaths.length > 0 ||
        requiredPaths.some((path) => {
          const identity = normalizeWorkspacePathIdentity(path);
          return !identity || !coveredPaths.has(identity) || !substantiveEvidencePaths.has(identity);
        })
      )
    ) continue;
    for (const item of record.evidence) {
      const evidence = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const observation = evidence.observation && typeof evidence.observation === "object"
        ? evidence.observation as Record<string, unknown>
        : null;
      // Structured observations distinguish tool activity from evidence that
      // can support the parent plan. Empty outlines and other non-substantive
      // observations stay visible in the child run but must not enter the
      // parent's evidence ledger. Legacy evidence without this field keeps the
      // provenance checks below for backward compatibility.
      if (observation && observation.substantive !== true) continue;
      const provenance = evidence.provenance && typeof evidence.provenance === "object"
        ? evidence.provenance as Record<string, unknown>
        : {};
      const sourceObservation = provenance.sourceObservation &&
          typeof provenance.sourceObservation === "object"
        ? provenance.sourceObservation as Record<string, unknown>
        : null;
      const sourceToolCallId = String(provenance.sourceToolCallId || "").trim();
      const sourceObservationKey = String(sourceObservation?.key || "").trim();
      const ownerRecord = provenance.owner && typeof provenance.owner === "object"
        ? provenance.owner as Record<string, unknown>
        : null;
      const ownerSubagentId = String(ownerRecord?.subagentId || "").trim();
      // Child summary prose and legacy unprovenanced payloads are hypotheses,
      // never ledger evidence. At least one concrete tool/observation identity
      // and an owner matching the enclosing child result must accompany a
      // runtime-authored tool_observation entry.
      if (
        provenance.source !== "tool_observation" ||
        (!sourceToolCallId && !sourceObservationKey) ||
        ownerRecord?.agentKind !== "subagent" ||
        !ownerSubagentId ||
        ownerSubagentId !== envelopeSubagentId
      ) continue;
      const name = String(evidence.tool || "").trim();
      const target = String(evidence.target || "").trim();
      if (!SUBAGENT_EVIDENCE_TOOLS.has(name) || !target) continue;
      const rawFacts = Array.isArray(evidence.facts)
        ? evidence.facts.map((fact) => String(fact || ""))
        : [];
      const referencedFacts = Array.isArray(provenance.factReferences)
        ? provenance.factReferences.map((reference) =>
            reference && typeof reference === "object"
              ? String((reference as Record<string, unknown>).fact || "")
              : ""
          )
        : [];
      const detail = summarizePlanEvidenceDetail({
        tool: name,
        target,
        content: String(evidence.detail || ""),
        // Controlled children already compact repeated observations to a
        // bounded first+latest detail. Preserve that envelope here; a second
        // short prefix trim can discard the newest fact (for example a port
        // found in a later window of the same file).
        maxChars: 440,
      });
      const facts = mergePlanEvidenceFacts(rawFacts, referencedFacts);
      const sourceRangeRecord = provenance.sourceRange && typeof provenance.sourceRange === "object"
        ? provenance.sourceRange as Record<string, unknown>
        : null;
      const sourceRange = sourceRangeRecord &&
          Number.isFinite(Number(sourceRangeRecord.startLine)) &&
          Number.isFinite(Number(sourceRangeRecord.endLine)) &&
          Number.isFinite(Number(sourceRangeRecord.totalLines))
        ? {
            startLine: Math.max(1, Math.floor(Number(sourceRangeRecord.startLine))),
            endLine: Math.max(1, Math.floor(Number(sourceRangeRecord.endLine))),
            totalLines: Math.max(1, Math.floor(Number(sourceRangeRecord.totalLines))),
            truncated: Boolean(sourceRangeRecord.truncated),
          }
        : undefined;
      appendBoundedToolActivity(activities, {
        name,
        target,
        status: "succeeded",
        ...(detail ? { detail } : {}),
        ...(facts.length > 0 ? { facts } : {}),
        delegatedObservation: {
          owner: {
            agentKind: "subagent",
            subagentId: ownerSubagentId,
            ...(String(ownerRecord.parentTurnId || "").trim()
              ? { parentTurnId: String(ownerRecord.parentTurnId).trim() }
              : {}),
            ...(String(ownerRecord.runId || "").trim()
              ? { runId: String(ownerRecord.runId).trim() }
              : {}),
          },
          ...(sourceToolCallId ? { sourceToolCallId } : {}),
          ...(sourceObservationKey ? { sourceObservationKey } : {}),
          ...(String(provenance.sourceVersion || sourceObservation?.versionToken || "").trim()
            ? { sourceVersion: String(provenance.sourceVersion || sourceObservation?.versionToken).trim() }
            : {}),
          ...(String(provenance.sourceContentHash || "").trim()
            ? { sourceContentHash: String(provenance.sourceContentHash).trim() }
            : {}),
          ...(Number.isFinite(Number(provenance.sourceContentChars))
            ? { sourceContentChars: Math.max(0, Math.floor(Number(provenance.sourceContentChars))) }
            : {}),
          ...(sourceRange ? { sourceRange } : {}),
          parentContextState: "reference_only",
          requiresParentReread: true,
        },
      }, MAX_RECENT_PLAN_TOOL_ACTIVITY, true);
      if (activities.length >= MAX_RECENT_PLAN_TOOL_ACTIVITY) return activities;
    }
  }
  return activities;
}

/**
 * Preserve an incomplete child's exact path handoff without promoting any of
 * its partial observations as trusted parent evidence. The child lease is
 * already released at join; this marker only exposes a targeted parent read
 * when the user's instructions permit it.
 */
export function extractSubagentParentRereadObligations(
  result: ToolExecutionResult,
): PlanToolActivitySummary[] {
  if (result.name !== "wait_subagents" || result.isError) return [];
  const parsedFeedback = parseToolFeedbackEnvelope(result.content || "");
  const body = parsedFeedback?.body || result.content || "";
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  const results = Array.isArray((payload as { results?: unknown[] })?.results)
    ? (payload as { results: unknown[] }).results
    : [];
  const obligations: PlanToolActivitySummary[] = [];
  for (const envelope of results) {
    const record = envelope && typeof envelope === "object"
      ? envelope as Record<string, unknown>
      : {};
    const subagentId = String(record.subagentId || "").trim();
    const closureAudit = record.closureAudit && typeof record.closureAudit === "object"
      ? record.closureAudit as Record<string, unknown>
      : null;
    if (!subagentId || !closureAudit) continue;
    const requiredPaths = new Map((Array.isArray(closureAudit.requiredPaths)
      ? closureAudit.requiredPaths
      : []).flatMap((value) => {
        const path = String(value || "").trim();
        const identity = normalizeWorkspacePathIdentity(path);
        return identity ? [[identity, path] as const] : [];
      }));
    const unresolvedPaths = [closureAudit.failedPaths, closureAudit.uncoveredPaths]
      .flatMap((value) => Array.isArray(value) ? value : [])
      .map((value) => String(value || "").trim());
    for (const path of unresolvedPaths) {
      const identity = normalizeWorkspacePathIdentity(path);
      const requiredPath = identity ? requiredPaths.get(identity) : "";
      if (!requiredPath || obligations.some((item) =>
        item.delegatedObservation?.owner.subagentId === subagentId &&
        normalizeWorkspacePathIdentity(item.target) === identity
      )) continue;
      appendBoundedToolActivity(obligations, {
        name: "read_file",
        target: requiredPath,
        status: "failed",
        detail: "Incomplete child closure left this exact scoped path unresolved; parent reread is permitted after join only when consistent with the user instruction.",
        delegatedObservation: {
          owner: { agentKind: "subagent", subagentId },
          parentContextState: "reference_only",
          requiresParentReread: true,
        },
      }, MAX_RECENT_PLAN_TOOL_ACTIVITY, true);
    }
  }
  return obligations;
}

export function toolResultCountsAsExecutionEvidence(
  result: ToolExecutionResult,
  args: Record<string, unknown>,
): boolean {
  if (result.isError) return false;
  if (result.name === "send_pty_input") return false;
  // Coordination lifecycle is not task execution evidence. Only concrete
  // child tool observations promoted below, or a parent-side verification of
  // them, may contribute evidence to the execution ledger.
  if (result.name === "spawn_subagent" || result.name === "wait_subagents") return false;
  const envelope = parseToolFeedbackEnvelope(result.content || "");
  const feedbackStatus = envelope?.envelope.status || "";
  if (feedbackStatus === "no_op" || feedbackStatus === "no_effect_mutation" || feedbackStatus === "cached") {
    return false;
  }
  const isWorkspaceMutation = isWorkspaceMutationToolCall(result.name, args);
  if (isWorkspaceMutationToolName(result.name) && !isWorkspaceMutation) return false;
  if (isWorkspaceMutation && isNoOpToolFeedback(result.content || result.displayContent || "")) {
    return false;
  }
  if (isSuccessfulPlanArtifactWriteResult(result) || isExecutionPlanArtifactWrite(result.name, args) || isTasksPlanWrite(result.name, args)) {
    return false;
  }
  if (
    (result.name === "run_command" || result.name === "execute_command") &&
    classifyCommandResultOutcome(result.name, result.content || "") !== "succeeded"
  ) {
    return false;
  }
  if (result.name === "browser_evaluate" && !browserResultLooksSuccessful(result.content || "")) {
    return false;
  }
  return !PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name);
}

export function rememberToolActivity(
  targetList: PlanToolActivitySummary[],
  result: ToolExecutionResult,
  options: ToolActivityRetentionOptions = {},
): void {
  if (result.internalFeedback) return;
  const rawDetail = result.displayContent || result.content || "";
  const planEvidenceDetail = summarizePlanEvidenceDetail({
    tool: result.name,
    target: result.target,
    content: rawDetail,
    maxChars: 220,
  });
  const detail = planEvidenceDetail || (/\bREAD_FILE_RESULT\b/i.test(rawDetail) ? "" : truncateForLog(rawDetail, 120));
  const facts = mergePlanEvidenceFacts(
    extractPlanEvidenceFacts(rawDetail),
    extractPlanEvidenceFacts(planEvidenceDetail),
  );
  const astObservation = extractAstObservation(result);
  const commandOutcome = result.isError
    ? "failed"
    : classifyCommandResultOutcome(result.name, result.content || "");
  appendBoundedToolActivity(targetList, {
    name: result.name,
    target: result.target,
    status: commandOutcome === "failed"
      ? "failed"
      : commandOutcome === "running"
      ? "called"
      : "succeeded",
    ...(detail ? { detail } : {}),
    ...(facts.length > 0 ? { facts } : {}),
    ...(result.readFileObservation
      ? { readFileObservation: { ...result.readFileObservation } }
      : {}),
    ...(astObservation
      ? { astObservation }
      : {}),
  }, options.evidenceLedger ? MAX_PLAN_EVIDENCE_TOOL_ACTIVITY : MAX_RECENT_PLAN_TOOL_ACTIVITY, options.evidenceLedger);
}

export function rememberDelegatedSubagentActivities(
  targetList: PlanToolActivitySummary[],
  activities: PlanToolActivitySummary[],
  options: ToolActivityRetentionOptions = {},
): void {
  activities.forEach((activity) => appendBoundedToolActivity(
    targetList,
    activity,
    options.evidenceLedger ? MAX_PLAN_EVIDENCE_TOOL_ACTIVITY : MAX_RECENT_PLAN_TOOL_ACTIVITY,
    options.evidenceLedger,
  ));
}

export function isEditProgressResult(result: ToolExecutionResult): boolean {
  if (result.isError || result.internalFeedback) return false;
  if (isNoOpToolFeedback(result.content || result.displayContent || "")) return false;
  if (EDIT_PROGRESS_TOOL_NAMES.has(result.name)) {
    return hasResolvedWorkspaceMutationTarget(result.name, result.target || "");
  }
  return String(result.target || "").startsWith("shell-write:");
}

export function isVerificationEvidenceResult(result: ToolExecutionResult): boolean {
  return EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name) &&
    isSuccessfulVerificationToolObservation(result);
}
