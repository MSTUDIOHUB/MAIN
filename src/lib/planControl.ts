import type { PlanArtifact, PlanStage, ReplyOption } from "./workflowModels";

const REVIEWABLE_PLAN_STAGES = new Set<PlanStage>(["design", "bugfix", "ready_to_execute"]);
const REVIEWABLE_PLAN_ARTIFACTS = new Set(["design", "bugfix", "tasks"]);

export function hasReviewablePlanContext(input: {
  planArtifacts?: PlanArtifact[];
  planStage?: PlanStage;
}): boolean {
  if (input.planStage && REVIEWABLE_PLAN_STAGES.has(input.planStage)) return true;
  return (input.planArtifacts || []).some((artifact) => REVIEWABLE_PLAN_ARTIFACTS.has(artifact.kind));
}

export function looksLikePlanApprovalQuickReply(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  return (
    /(?:批准|同意|确认).{0,12}(?:方案|计划|执行)/i.test(normalized) ||
    /(?:开始|进入).{0,8}执行/i.test(normalized) ||
    /approve.{0,20}(?:plan|execution)/i.test(normalized) ||
    /confirm.{0,20}(?:execution|start)/i.test(normalized) ||
    /start execution/i.test(normalized)
  );
}

export function normalizePlanApprovalChoice(text: string | null | undefined): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 240)}...`;
}

export function buildPlanApprovalChoiceHint(
  text: string | null | undefined,
  language: "zh" | "en",
): string {
  const normalized = normalizePlanApprovalChoice(text);
  if (!normalized) return "";
  return language === "zh"
    ? `用户批准并选择：${normalized}\n`
    : `The user approved and selected: ${normalized}\n`;
}

export function shouldRouteQuickReplyToPlanApproval(input: {
  text: string;
  optionAction?: ReplyOption["action"];
  sourceIntent?: string | null;
  isPlanApproved?: boolean;
  planArtifacts?: PlanArtifact[];
  planStage?: PlanStage;
}): boolean {
  if (input.optionAction) return false;
  if (input.sourceIntent !== "plan") return false;
  if (input.isPlanApproved) return false;
  if (!hasReviewablePlanContext(input)) return false;
  return looksLikePlanApprovalQuickReply(input.text);
}
