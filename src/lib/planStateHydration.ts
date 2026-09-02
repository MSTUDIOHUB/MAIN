import { looksLikeExistingPlanExecutionRequest } from "./runIntent";

export type PlanStateHydrationReason =
  | "existing_plan_execution"
  | "resume_plan_semantic"
  | "continuation_state";

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

export function resolvePlanStateHydrationReason(input: {
  text: string;
  hasPlanState: boolean;
  hasContinuationState: boolean;
}): PlanStateHydrationReason | null {
  if (input.hasPlanState) return null;
  if (looksLikeExistingPlanExecutionRequest(input.text)) return "existing_plan_execution";
  if (looksLikeResumePlanSemantic(input.text)) return "resume_plan_semantic";
  if (input.hasContinuationState) return "continuation_state";
  return null;
}
