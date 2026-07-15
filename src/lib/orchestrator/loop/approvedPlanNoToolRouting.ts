import { shouldHandleApprovedPlanExecutionNoTool } from "../../planExecutionNoTool";
import type { LegacyWorkflowMode } from "../../runIntent";
import { looksLikePlanCompletionClaim } from "../../orchestrator/prompts/executePrompts";
import { resolveApprovedPlanValidationBoundary } from "../../orchestrator/prompts/planPrompts";
import {
  buildPlanTaskEvidenceAudit,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
  type PlanTaskEvidenceAudit,
} from "../../workflowModels";

export interface ApprovedPlanNoToolRoute {
  audit: PlanTaskEvidenceAudit | null;
  approvedPlanMissingTasks: boolean;
  hasRemainingApprovedPlanTasks: boolean;
  shouldHandleApprovedPlanNoTool: boolean;
  shouldSuppressApprovedPlanNoToolText: boolean;
  rejectedCompletionClaim: boolean;
  shouldHideApprovedPlanNoToolText: boolean;
  shouldLogApprovedPlanNoToolRoute: boolean;
}

export function resolveApprovedPlanNoToolRoute(input: {
  workflowMode: LegacyWorkflowMode;
  isPlanApproved: boolean;
  planStage: string;
  toolCallCount: number;
  planTasks: PlanTask[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
  userVisibleText: string;
  availableToolNames?: Set<string>;
}): ApprovedPlanNoToolRoute {
  const isApprovedPlanNoToolTurn =
    input.isPlanApproved &&
    input.planStage === "executing" &&
    input.toolCallCount === 0;
  const baseAudit = isApprovedPlanNoToolTurn
    ? buildPlanTaskEvidenceAudit({
        tasks: input.planTasks,
        evidenceLedger: input.evidenceLedger,
        highlightNext: true,
      })
    : null;
  const validationBoundary = resolveApprovedPlanValidationBoundary({
    audit: baseAudit,
    // Older direct callers do not provide a tool surface. Default to the
    // conservative "browser may be available" path so missing metadata never
    // downgrades an automatable browser obligation into advisory user review.
    availableToolNames: input.availableToolNames || new Set<string>(["browser_evaluate"]),
  });
  const audit = baseAudit && validationBoundary === "pause_external_validation"
    ? { ...baseAudit, acceptedCompletion: true }
    : baseAudit;
  const approvedPlanMissingTasks = isApprovedPlanNoToolTurn && audit?.totalCount === 0;
  const hasRemainingApprovedPlanTasks =
    isApprovedPlanNoToolTurn &&
    !!audit &&
    !audit.acceptedCompletion;
  const shouldHandleApprovedPlanNoTool = shouldHandleApprovedPlanExecutionNoTool({
    workflowMode: input.workflowMode,
    isPlanApproved: input.isPlanApproved,
    planStage: input.planStage,
    toolCallCount: input.toolCallCount,
    audit,
  });
  const shouldSuppressApprovedPlanNoToolText =
    shouldHandleApprovedPlanNoTool ||
    approvedPlanMissingTasks ||
    hasRemainingApprovedPlanTasks;
  const rejectedCompletionClaim =
    shouldSuppressApprovedPlanNoToolText && looksLikePlanCompletionClaim(input.userVisibleText);
  const shouldHideApprovedPlanNoToolText =
    shouldSuppressApprovedPlanNoToolText && rejectedCompletionClaim;

  return {
    audit,
    approvedPlanMissingTasks,
    hasRemainingApprovedPlanTasks,
    shouldHandleApprovedPlanNoTool,
    shouldSuppressApprovedPlanNoToolText,
    rejectedCompletionClaim,
    shouldHideApprovedPlanNoToolText,
    shouldLogApprovedPlanNoToolRoute: isApprovedPlanNoToolTurn,
  };
}
