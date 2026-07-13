import { isExecutionPlanArtifactWrite, isSuccessfulPlanArtifactWriteResult, isTasksPlanWrite, truncateForLog } from "../../orchestrator";
import {
  EDIT_PROGRESS_TOOL_NAMES,
  EXECUTION_VERIFICATION_TOOL_NAMES,
  MAX_PLAN_EVIDENCE_TOOL_ACTIVITY,
  MAX_RECENT_PLAN_TOOL_ACTIVITY,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
} from "../../orchestrator";
import { browserResultLooksSuccessful, commandResultLooksSuccessful } from "../../planEvidence";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { summarizePlanEvidenceDetail } from "../../planMaterialization";
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
      const details = [existing.detail, activity.detail]
        .map((detail) => String(detail || "").trim())
        .filter((detail, index, all) => detail && all.indexOf(detail) === index);
      existing.status = existing.status === "succeeded" || activity.status === "succeeded"
        ? "succeeded"
        : activity.status;
      if (details.length > 0) existing.detail = details.join(" | ").slice(0, 440);
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
  const seen = new Set<string>();
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
      const key = `${name}:${target}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const detail = summarizePlanEvidenceDetail({
        tool: name,
        target,
        content: String(evidence.detail || ""),
        maxChars: 220,
      });
      activities.push({
        name,
        target,
        status: "succeeded",
        ...(detail ? { detail } : {}),
      });
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
  const envelope = parseToolFeedbackEnvelope(result.content || "");
  const feedbackStatus = envelope?.envelope.status || "";
  if (feedbackStatus === "no_op" || feedbackStatus === "no_effect_mutation" || feedbackStatus === "cached") {
    return false;
  }
  if (/"noOp"\s*:\s*true|NO_EFFECT_MUTATION|FILE_UNCHANGED_STUB|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT|no-op|nothing to (?:change|patch|write)|already matched requested content/i.test(result.content || "")) {
    return false;
  }
  if (isSuccessfulPlanArtifactWriteResult(result) || isExecutionPlanArtifactWrite(result.name, args) || isTasksPlanWrite(result.name, args)) {
    return false;
  }
  if (
    (result.name === "run_command" || result.name === "execute_command" || result.name === "send_pty_input") &&
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
  appendBoundedToolActivity(targetList, {
    name: result.name,
    target: result.target,
    status: result.isError ? "failed" : "succeeded",
    ...(detail ? { detail } : {}),
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
  return EDIT_PROGRESS_TOOL_NAMES.has(result.name) || String(result.target || "").startsWith("shell-write:");
}

export function isVerificationEvidenceResult(result: ToolExecutionResult): boolean {
  return EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name) &&
    isSuccessfulVerificationToolObservation(result);
}
