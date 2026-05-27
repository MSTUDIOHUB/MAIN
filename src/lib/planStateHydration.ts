import type { PendingSlashCommand, StudioWorkflowCommandSlug } from "./gameStudioCatalog";
import { looksLikeExistingPlanExecutionRequest } from "./runIntent";

export type PlanStateHydrationReason =
  | "existing_plan_execution"
  | "resume_plan_semantic"
  | "continuation_state"
  | "studio_execution_command";

export const DEFAULT_STUDIO_EXECUTION_HYDRATION_COMMANDS: readonly StudioWorkflowCommandSlug[] = [
  "dev-story",
  "story-done",
  "sprint-status",
  "story-readiness",
  "smoke-check",
  "regression-suite",
  "release-checklist",
  "launch-checklist",
  "milestone-review",
  "hotfix",
  "day-one-patch",
  "team-qa",
] as const;

const STUDIO_EXECUTION_HYDRATION_COMMAND_SET = new Set<StudioWorkflowCommandSlug>(
  DEFAULT_STUDIO_EXECUTION_HYDRATION_COMMANDS,
);

const RESUME_PLAN_SEMANTIC_PATTERNS = [
  /(?:继续|恢复|接着).{0,20}(?:执行|计划|任务)/i,
  /(?:继续|恢复|接着).{0,20}(?:完成|推进|落地).{0,20}(?:计划方案|计划|方案|任务)/i,
  /(?:把|将).{0,8}(?:计划方案|计划|方案|剩余任务).{0,20}(?:继续|接着).{0,20}(?:做完|完成|执行|落地)/i,
  /(?:继续|恢复).{0,24}(?:plan|tasks?|execution)/i,
  /\b(?:resume|continue)\b.{0,24}\b(?:plan|task list|execution)\b/i,
  /\b(?:resume|continue|finish)\b.{0,32}\b(?:plan|plan execution|planned tasks)\b/i,
];

function looksLikeResumePlanSemantic(input: string): boolean {
  const normalized = String(input || "").trim();
  if (!normalized) return false;
  return RESUME_PLAN_SEMANTIC_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isStudioExecutionHydrationCommand(
  command: PendingSlashCommand | null | undefined,
): boolean {
  return !!command && command.type === "workflow" && STUDIO_EXECUTION_HYDRATION_COMMAND_SET.has(command.slug);
}

export function resolvePlanStateHydrationReason(input: {
  text: string;
  hasPlanState: boolean;
  hasContinuationState: boolean;
  slashCommand: PendingSlashCommand | null | undefined;
}): PlanStateHydrationReason | null {
  if (input.hasPlanState) return null;
  if (looksLikeExistingPlanExecutionRequest(input.text)) return "existing_plan_execution";
  if (looksLikeResumePlanSemantic(input.text)) return "resume_plan_semantic";
  if (input.hasContinuationState) return "continuation_state";
  if (isStudioExecutionHydrationCommand(input.slashCommand)) return "studio_execution_command";
  return null;
}

export function shouldPromoteHydratedPlanToExecuting(
  reason: PlanStateHydrationReason,
): boolean {
  return reason === "existing_plan_execution" ||
    reason === "resume_plan_semantic" ||
    reason === "continuation_state" ||
    reason === "studio_execution_command";
}
