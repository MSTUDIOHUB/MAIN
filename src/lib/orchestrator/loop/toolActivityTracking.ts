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

function appendBoundedToolActivity(
  targetList: PlanToolActivitySummary[],
  activity: PlanToolActivitySummary,
  maxItems = MAX_RECENT_PLAN_TOOL_ACTIVITY,
  mergeByTarget = false,
): void {
  if (mergeByTarget) {
    const normalizedTarget = String(activity.target || "").replace(/\\/g, "/").toLowerCase();
    const existing = targetList.find((item) =>
      item.name === activity.name &&
      String(item.target || "").replace(/\\/g, "/").toLowerCase() === normalizedTarget
    );
    if (existing) {
      existing.facts = mergePlanEvidenceFacts(existing.facts, activity.facts);
      if (activity.readFileObservation) {
        existing.readFileObservation = { ...activity.readFileObservation };
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
    if (!/^(?:completed|blocked|degraded)$/.test(status) || !Array.isArray(record.evidence)) continue;
    for (const item of record.evidence) {
      const evidence = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const name = String(evidence.tool || "").trim();
      const target = String(evidence.target || "").trim();
      if (!SUBAGENT_EVIDENCE_TOOLS.has(name) || !target) continue;
      const rawFacts = Array.isArray(evidence.facts)
        ? evidence.facts.map((fact) => String(fact || ""))
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
      const facts = mergePlanEvidenceFacts(rawFacts, extractPlanEvidenceFacts(detail));
      appendBoundedToolActivity(activities, {
        name,
        target,
        status: "succeeded",
        ...(detail ? { detail } : {}),
        ...(facts.length > 0 ? { facts } : {}),
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
  appendBoundedToolActivity(targetList, {
    name: result.name,
    target: result.target,
    status: result.isError ? "failed" : "succeeded",
    ...(detail ? { detail } : {}),
    ...(facts.length > 0 ? { facts } : {}),
    ...(result.readFileObservation
      ? { readFileObservation: { ...result.readFileObservation } }
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
