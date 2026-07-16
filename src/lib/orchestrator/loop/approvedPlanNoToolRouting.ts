import { shouldHandleApprovedPlanExecutionNoTool } from "../../planExecutionNoTool";
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
    // Missing capability metadata is not evidence that a browser exists.
    // Keep an automatable browser obligation unresolved until the actual tool
    // surface exposes it; manual review remains advisory and cannot close it.
    availableToolNames: input.availableToolNames || new Set<string>(),
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
