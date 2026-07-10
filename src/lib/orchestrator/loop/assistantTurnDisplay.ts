import { hasTieredPlanProposal } from "../../planProposal";
import {
  hasExecutableProposalReplyOptions,
  hasOnlyNonBlockingPlanReplyOptions,
  hasOnlyReadOnlyPermissionReplyOptions,
  shouldAutoContinueReadOnlyPermission,
  shouldRouteUnapprovedPlanReplyOptionsToArtifact,
  shouldSuppressApprovedPlanExecutionReplyOptions,
  stripReadOnlyPermissionPrompt,
} from "../../replyOptions";
import type { LegacyWorkflowMode, ResolvedUserIntent } from "../../runIntent";
import {
  buildProseCodeDumpNotice,
  isReviewablePlanStage,
  shouldCompactProseCodeDump,
} from "../../orchestrator";
import { buildPlanFallbackNotice } from "../../orchestrator/planOrchestration";
import type { PlanStage, ReplyOption } from "../../workflowModels";

export interface AssistantTurnDisplayDecision {
  compactedProseCodeDump: boolean;
  compactedIncompletePlanText: boolean;
  autoContinueReadOnlyPermission: boolean;
  suppressReadOnlyPermissionOptionsForToolCalls: boolean;
  suppressTruncatedReadOnlyPermissionOptions: boolean;
  suppressReadOnlyPermissionOptions: boolean;
  suppressPlanContinuationReplyOptions: boolean;
  suppressExecutableProposalOptionsForToolCalls: boolean;
  suppressApprovedPlanExecutionReplyOptions: boolean;
  suppressNonDecisionReplyOptions: boolean;
  currentPlanStageForReview: PlanStage;
  isApprovedPlanExecutionTurn: boolean;
  sourceVisibleText: string;
  hasStructuredProposal: boolean;
  hasReadyPlanArtifacts: boolean;
  hasReviewablePlanArtifacts: boolean;
  rawFinalReplyOptions: ReplyOption[];
  planReplyOptionsRoutedToArtifact: boolean;
  normalizedVisibleTextForUser: string;
  finalVisibleText: string;
  finalReplyOptions: ReplyOption[];
}

export function resolveAssistantTurnDisplayDecision(input: {
  workflowMode: LegacyWorkflowMode;
  turnIntent: ResolvedUserIntent;
  streamText: string;
  normalizedVisibleText: string;
  normalizedBaseVisibleText: string;
  normalizedFinishReason?: string | null;
  normalizedReplyOptions: ReplyOption[];
  effectiveToolCallCount: number;
  isPlanApproved: boolean;
  planStage: PlanStage;
  sawPlanModeToolActivity: boolean;
  readOnlyAutoApproveForSession: boolean;
  language: "zh" | "en";
}): AssistantTurnDisplayDecision {
  const compactedProseCodeDump = shouldCompactProseCodeDump({
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    visibleText: input.normalizedVisibleText,
    toolCallCount: input.effectiveToolCallCount,
    isPlanApproved: input.isPlanApproved,
  });
  const sourceVisibleText = input.normalizedBaseVisibleText || input.normalizedVisibleText;
  const compactedIncompletePlanText =
    !compactedProseCodeDump &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    input.effectiveToolCallCount === 0 &&
    input.normalizedFinishReason === "length" &&
    sourceVisibleText.trim().length > 1200;
  const autoContinueReadOnlyPermission =
    input.effectiveToolCallCount === 0 &&
    !compactedProseCodeDump &&
    shouldAutoContinueReadOnlyPermission({
      replyOptions: input.normalizedReplyOptions,
      readOnlyAutoApproveForSession: input.readOnlyAutoApproveForSession,
    });
  const suppressReadOnlyPermissionOptionsForToolCalls =
    input.effectiveToolCallCount > 0 &&
    hasOnlyReadOnlyPermissionReplyOptions(input.normalizedReplyOptions);
  const suppressTruncatedReadOnlyPermissionOptions =
    input.effectiveToolCallCount === 0 &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    input.normalizedFinishReason === "length" &&
    hasOnlyReadOnlyPermissionReplyOptions(input.normalizedReplyOptions);
  const suppressReadOnlyPermissionOptions =
    autoContinueReadOnlyPermission ||
    suppressReadOnlyPermissionOptionsForToolCalls ||
    suppressTruncatedReadOnlyPermissionOptions;
  const suppressPlanContinuationReplyOptions =
    input.effectiveToolCallCount === 0 &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    hasOnlyNonBlockingPlanReplyOptions(input.normalizedReplyOptions);
  const suppressExecutableProposalOptionsForToolCalls =
    input.effectiveToolCallCount > 0 &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    hasExecutableProposalReplyOptions(input.normalizedReplyOptions);
  const currentPlanStageForReview = input.planStage;
  const isApprovedPlanExecutionTurn =
    input.isPlanApproved &&
    currentPlanStageForReview === "executing";
  const suppressApprovedPlanExecutionReplyOptions =
    shouldSuppressApprovedPlanExecutionReplyOptions({
      replyOptions: input.normalizedReplyOptions,
      workflowMode: input.workflowMode,
      isPlanApproved: input.isPlanApproved,
      planStage: currentPlanStageForReview,
    });
  const suppressNonDecisionReplyOptions =
    suppressReadOnlyPermissionOptions ||
    suppressPlanContinuationReplyOptions ||
    suppressExecutableProposalOptionsForToolCalls ||
    suppressApprovedPlanExecutionReplyOptions;
  const hasStructuredProposal = hasTieredPlanProposal(input.streamText);
  const hasReadyPlanArtifacts = currentPlanStageForReview === "ready_to_execute";
  const hasReviewablePlanArtifacts = isReviewablePlanStage(currentPlanStageForReview);
  const rawFinalReplyOptions = compactedProseCodeDump || suppressNonDecisionReplyOptions
    ? []
    : input.normalizedReplyOptions;
  const planReplyOptionsRoutedToArtifact = shouldRouteUnapprovedPlanReplyOptionsToArtifact({
    replyOptions: rawFinalReplyOptions,
    workflowMode: input.workflowMode,
    isPlanApproved: input.isPlanApproved,
    hasStructuredProposal,
    hasReadyPlanArtifacts,
    hasReviewablePlanArtifacts,
    sawPlanModeToolActivity: input.sawPlanModeToolActivity,
    visibleText: sourceVisibleText,
  });
  const normalizedVisibleTextForUser = suppressReadOnlyPermissionOptions
    ? stripReadOnlyPermissionPrompt(input.normalizedVisibleText)
    : input.normalizedVisibleText;
  const finalVisibleText = compactedProseCodeDump
    ? buildProseCodeDumpNotice(input.language, input.normalizedVisibleText.length)
    : compactedIncompletePlanText
      ? buildPlanFallbackNotice(input.language, sourceVisibleText.length)
      : normalizedVisibleTextForUser;
  const finalReplyOptions = planReplyOptionsRoutedToArtifact ? [] : rawFinalReplyOptions;

  return {
    compactedProseCodeDump,
    compactedIncompletePlanText,
    autoContinueReadOnlyPermission,
    suppressReadOnlyPermissionOptionsForToolCalls,
    suppressTruncatedReadOnlyPermissionOptions,
    suppressReadOnlyPermissionOptions,
    suppressPlanContinuationReplyOptions,
    suppressExecutableProposalOptionsForToolCalls,
    suppressApprovedPlanExecutionReplyOptions,
    suppressNonDecisionReplyOptions,
    currentPlanStageForReview,
    isApprovedPlanExecutionTurn,
    sourceVisibleText,
    hasStructuredProposal,
    hasReadyPlanArtifacts,
    hasReviewablePlanArtifacts,
    rawFinalReplyOptions,
    planReplyOptionsRoutedToArtifact,
    normalizedVisibleTextForUser,
    finalVisibleText,
    finalReplyOptions,
  };
}
