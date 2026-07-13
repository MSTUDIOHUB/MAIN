import { isExecutionPlanArtifactWrite, isSuccessfulPlanArtifactWriteResult, isTasksPlanWrite, truncateForLog } from "../../orchestrator";
import {
  EDIT_PROGRESS_TOOL_NAMES,
  EXECUTION_VERIFICATION_TOOL_NAMES,
  MAX_RECENT_PLAN_TOOL_ACTIVITY,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
} from "../../orchestrator";
import { browserResultLooksSuccessful, commandResultLooksSuccessful } from "../../planEvidence";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { summarizePlanEvidenceDetail } from "../../planMaterialization";
import { parseToolFeedbackEnvelope } from "../../toolFeedbackEnvelope";
import type { ToolExecutionResult } from "../types";
import { analyzePtyObservationResult } from "../../devServerRuntime";

const PTY_OBSERVATION_TOOL_NAMES = new Set([
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

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
  targetList.push({
    name: result.name,
    target: result.target,
    status: result.isError ? "failed" : "succeeded",
    ...(detail ? { detail } : {}),
  });
  if (targetList.length > MAX_RECENT_PLAN_TOOL_ACTIVITY) {
    targetList.splice(0, targetList.length - MAX_RECENT_PLAN_TOOL_ACTIVITY);
  }
}

export function isEditProgressResult(result: ToolExecutionResult): boolean {
  return EDIT_PROGRESS_TOOL_NAMES.has(result.name) || String(result.target || "").startsWith("shell-write:");
}

export function isVerificationEvidenceResult(result: ToolExecutionResult): boolean {
  if (
    result.isError ||
    result.internalFeedback ||
    !EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name)
  ) {
    return false;
  }
  if (result.name === "browser_evaluate") {
    return browserResultLooksSuccessful(result.content || "");
  }
  // Dispatching a PTY command or typing into it is execution progress, not
  // verification. A later PTY observation owns the long-lived process state.
  if (result.name === "execute_command" || result.name === "send_pty_input") {
    return false;
  }
  if (PTY_OBSERVATION_TOOL_NAMES.has(result.name)) {
    const observation = analyzePtyObservationResult(result.content || "");
    return observation.status === "ready";
  }
  if (result.name === "run_command") {
    return commandResultLooksSuccessful(result.name, result.content || "");
  }
  return true;
}
