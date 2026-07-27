import { isNoOpToolFeedback } from "./toolFeedbackEnvelope";
import {
  BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES,
  isWorkspaceMutationToolCall,
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "./workspaceMutationTools";

/**
 * Minimal structural result consumed by evidence and cache invalidation.
 * Execution engines may carry richer provider/UI fields, but this pure module
 * must not depend on an engine-owned result type.
 */
export interface ToolResultEffectRecord {
  name: string;
  target: string;
  content: string;
  isError: boolean;
  displayContent?: string;
  internalFeedback?: boolean;
  lifecycleState?: string;
  executionName?: string;
  catalogIdentity?: {
    source?: string;
  };
  executedArgs?: Record<string, unknown>;
  workspaceMutationEvidence?: {
    changedPaths?: string[];
  };
  executionAttempted?: boolean;
  workspaceEffect?: string;
}

const NON_EXECUTED_LIFECYCLE_STATES = new Set([
  "queued",
  "awaiting_review",
  "running",
  "failed",
  "declined",
  "blocked",
]);

/**
 * Transport completion is not execution completion. Policy feedback, review
 * rejection, and pre-execution lifecycle states must never become durable
 * task or workspace-mutation evidence.
 */
export function hasCompletedToolExecution(
  result: Pick<ToolResultEffectRecord, "isError"> &
    Partial<Pick<ToolResultEffectRecord, "internalFeedback" | "lifecycleState">>,
): boolean {
  if (result.isError || result.internalFeedback) return false;
  return !NON_EXECUTED_LIFECYCLE_STATES.has(String(result.lifecycleState || ""));
}

export function getToolExecutionName(
  result: Pick<ToolResultEffectRecord, "name"> &
    Partial<Pick<ToolResultEffectRecord, "executionName">>,
): string {
  return String(result.executionName || result.name || "").trim();
}

export function getToolExecutionArgs(
  result: Partial<Pick<ToolResultEffectRecord, "executedArgs">>,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  return result.executedArgs && typeof result.executedArgs === "object"
    ? result.executedArgs
    : fallback;
}

/**
 * Runtime-observed workspace mutation truth is independent from tool success.
 * An executor can mutate a file and then fail, so callers that track stale
 * source context must retain the observed paths without promoting the call to
 * successful execution evidence.
 */
export function getObservedWorkspaceMutationPaths(
  result: Partial<Pick<ToolResultEffectRecord, "workspaceMutationEvidence">>,
): string[] {
  return [...new Set(
    (result.workspaceMutationEvidence?.changedPaths || [])
      .map((path) => String(path || "").trim())
      .filter(Boolean),
  )];
}

export function hasObservedWorkspaceMutationEffect(
  result: Partial<Pick<ToolResultEffectRecord, "workspaceMutationEvidence">>,
): boolean {
  return getObservedWorkspaceMutationPaths(result).length > 0;
}

/**
 * Plan evidence must retain the same catalog-provenance boundary as execution
 * evidence. An external tool that happens to use a built-in editor name cannot
 * satisfy a file obligation from success prose alone.
 */
export function canRecordPlanExecutionEvidenceForTool(input: {
  executionName: string;
  catalogIdentity?: ToolResultEffectRecord["catalogIdentity"];
  hasObservedDiff: boolean;
}): boolean {
  const executionName = String(input.executionName || "").trim();
  if (!isWorkspaceMutationToolName(executionName)) return true;
  if (input.hasObservedDiff) return true;
  return input.catalogIdentity?.source === "built_in" &&
    BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES.has(executionName);
}

/**
 * Built-in editors are trusted only after their executor completed. External
 * editors additionally need a runtime-observed diff; an MCP success sentence
 * is not durable mutation evidence.
 */
export function hasVerifiedWorkspaceMutationEffect(
  result: Pick<ToolResultEffectRecord, "name" | "target" | "content" | "isError"> &
    Partial<Pick<ToolResultEffectRecord,
      "displayContent" | "internalFeedback" | "lifecycleState" | "executionName" |
      "catalogIdentity" | "executedArgs" | "workspaceMutationEvidence">>,
  fallbackArgs: Record<string, unknown> = {},
): boolean {
  if (!hasCompletedToolExecution(result)) return false;
  const executionName = getToolExecutionName(result);
  const args = getToolExecutionArgs(result, fallbackArgs);
  if (!isWorkspaceMutationToolCall(executionName, args)) return false;
  if (isNoOpToolFeedback(result.content || result.displayContent || "")) return false;

  const observedPaths = result.workspaceMutationEvidence?.changedPaths
    ?.map((path) => String(path || "").trim())
    .filter(Boolean) ?? [];
  if (
    result.catalogIdentity?.source === "built_in" &&
    BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES.has(executionName)
  ) {
    return observedPaths.length > 0 ||
      resolveWorkspaceMutationTargets(executionName, args, result.target).length > 0;
  }
  return observedPaths.length > 0;
}

/**
 * Cache safety is intentionally broader than success evidence. Once an
 * editor or shell backend was invoked it may have changed disk before
 * returning an error, so observations must be conservatively invalidated.
 */
export function mayHaveWorkspaceSideEffects(
  result: Pick<ToolResultEffectRecord, "name" | "target" | "content" | "isError"> &
    Partial<Pick<ToolResultEffectRecord,
      "displayContent" | "executionAttempted" | "executionName" | "executedArgs" |
      "workspaceMutationEvidence">>,
  fallbackArgs: Record<string, unknown> = {},
): boolean {
  if ((result.workspaceMutationEvidence?.changedPaths?.length ?? 0) > 0) return true;
  if ((result as Partial<ToolResultEffectRecord>).workspaceEffect === "none") return false;
  if (["verified", "possible", "partial"].includes(
    String((result as Partial<ToolResultEffectRecord>).workspaceEffect || ""),
  )) return true;
  if (result.executionAttempted !== true) return false;
  const executionName = getToolExecutionName(result);
  const args = getToolExecutionArgs(result, fallbackArgs);
  if (isWorkspaceMutationToolCall(executionName, args)) return true;
  return executionName === "run_command" || executionName === "execute_command" || executionName === "send_pty_input";
}
