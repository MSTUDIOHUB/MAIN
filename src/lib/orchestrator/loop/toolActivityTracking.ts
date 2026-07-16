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
import { browserResultLooksSuccessful, commandResultLooksSuccessful } from "../../planEvidence";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  extractPlanEvidenceFacts,
  mergePlanEvidenceFacts,
  summarizePlanEvidenceDetail,
} from "../../planMaterialization";
import { parseToolFeedbackEnvelope } from "../../toolFeedbackEnvelope";
import type { ToolExecutionResult } from "../types";
import { isSuccessfulVerificationToolObservation } from "../../verificationEvidence";

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
    for (const item of record.evidence) {
      const evidence = item && typeof item === "object" ? item as Record<string, unknown> : {};
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

export function toolResultCountsAsExecutionEvidence(
  result: ToolExecutionResult,
  args: Record<string, unknown>,
): boolean {
  if (result.isError) return false;
  if (result.name === "send_pty_input") return false;
  const envelope = parseToolFeedbackEnvelope(result.content || "");
  const feedbackStatus = envelope?.envelope.status || "";
  if (feedbackStatus === "no_op" || feedbackStatus === "no_effect_mutation" || feedbackStatus === "cached") {
    return false;
  }
  const isWorkspaceMutation = isWorkspaceMutationToolCall(result.name, args);
  if (isWorkspaceMutationToolName(result.name) && !isWorkspaceMutation) return false;
  if (
    isWorkspaceMutation &&
    /"noOp"\s*:\s*true|NO_EFFECT_MUTATION|no-op|nothing to (?:change|patch|write)|already matched requested content/i.test(result.content || "")
  ) {
    return false;
  }
  if (isSuccessfulPlanArtifactWriteResult(result) || isExecutionPlanArtifactWrite(result.name, args) || isTasksPlanWrite(result.name, args)) {
    return false;
  }
  if (
    (result.name === "run_command" || result.name === "execute_command") &&
    !commandResultLooksSuccessful(result.name, result.content || "")
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
  appendBoundedToolActivity(targetList, {
    name: result.name,
    target: result.target,
    status: result.isError ? "failed" : "succeeded",
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
  if (
    /"noOp"\s*:\s*true|NO_EFFECT_MUTATION|"status"\s*:\s*"(?:no_op|no_effect_mutation)"|no-op|nothing to (?:change|patch|write)|already matched requested content/i.test(
      String(result.content || result.displayContent || ""),
    )
  ) {
    return false;
  }
  if (EDIT_PROGRESS_TOOL_NAMES.has(result.name)) {
    return hasResolvedWorkspaceMutationTarget(result.name, result.target || "");
  }
  return String(result.target || "").startsWith("shell-write:");
}

export function isVerificationEvidenceResult(result: ToolExecutionResult): boolean {
  return EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name) &&
    isSuccessfulVerificationToolObservation(result);
}
