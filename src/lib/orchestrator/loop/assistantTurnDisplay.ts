import { hasExplicitPlanProposal, hasTieredPlanProposal } from "../../planProposal";
import {
  hasExecutableProposalReplyOptions,
  hasOnlyNonBlockingPlanReplyOptions,
  hasOnlyReadOnlyPermissionReplyOptions,
  shouldAutoContinueReadOnlyPermission,
  shouldRouteUnapprovedPlanReplyOptionsToArtifact,
  shouldSuppressApprovedPlanExecutionReplyOptions,
  stripReadOnlyPermissionPrompt,
} from "../../replyOptions";
import { isMutationRuntimeIntent, type LegacyWorkflowMode, type ResolvedUserIntent } from "../../runIntent";
import {
  buildProseCodeDumpNotice,
  isReviewablePlanStage,
  looksLikeOperationCompletionClaim,
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
  suppressInferredOperationApprovalAfterExecution: boolean;
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
  runtimeIntent: ResolvedUserIntent;
  streamText: string;
  normalizedVisibleText: string;
  normalizedBaseVisibleText: string;
  normalizedFinishReason?: string | null;
  normalizedReplyOptions: ReplyOption[];
  effectiveToolCallCount: number;
  isPlanApproved: boolean;
  planStage: PlanStage;
  sawPlanModeToolActivity: boolean;
  sawExecuteOperationEvidence: boolean;
  readOnlyAutoApproveForSession: boolean;
  language: "zh" | "en";
}): AssistantTurnDisplayDecision {
  const isExecutionRuntime =
    input.workflowMode === "edit" ||
    isMutationRuntimeIntent(input.runtimeIntent) ||
    input.runtimeIntent === "studio_workflow";
  const executionConclusionCandidate =
    isExecutionRuntime &&
    input.sawExecuteOperationEvidence &&
    input.effectiveToolCallCount === 0 &&
    input.normalizedFinishReason === "stop" &&
    looksLikeOperationCompletionClaim(
      input.normalizedBaseVisibleText || input.normalizedVisibleText,
    );
  // proposal_follow_up is synthesized from prose for compatibility with
  // models that omit <user_options>. Once this execution has real evidence,
  // inferred future-work suggestions must not reopen approval. Explicit model
  // choices remain untouched and can still pause at a genuine decision fork.
  const normalizedReplyOptions = executionConclusionCandidate
    ? input.normalizedReplyOptions.filter((option) => option.source !== "proposal_follow_up")
    : input.normalizedReplyOptions;
  const suppressInferredOperationApprovalAfterExecution =
    normalizedReplyOptions.length !== input.normalizedReplyOptions.length;
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
      replyOptions: normalizedReplyOptions,
      readOnlyAutoApproveForSession: input.readOnlyAutoApproveForSession,
    });
  const suppressReadOnlyPermissionOptionsForToolCalls =
    input.effectiveToolCallCount > 0 &&
    hasOnlyReadOnlyPermissionReplyOptions(normalizedReplyOptions);
  const suppressTruncatedReadOnlyPermissionOptions =
    input.effectiveToolCallCount === 0 &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    input.normalizedFinishReason === "length" &&
    hasOnlyReadOnlyPermissionReplyOptions(normalizedReplyOptions);
  const suppressReadOnlyPermissionOptions =
    autoContinueReadOnlyPermission ||
    suppressReadOnlyPermissionOptionsForToolCalls ||
    suppressTruncatedReadOnlyPermissionOptions;
  const suppressPlanContinuationReplyOptions =
    input.effectiveToolCallCount === 0 &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    hasOnlyNonBlockingPlanReplyOptions(normalizedReplyOptions);
  const suppressExecutableProposalOptionsForToolCalls =
    input.effectiveToolCallCount > 0 &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    hasExecutableProposalReplyOptions(normalizedReplyOptions);
  const currentPlanStageForReview = input.planStage;
  const isApprovedPlanExecutionTurn =
    input.isPlanApproved &&
    currentPlanStageForReview === "executing";
  const suppressApprovedPlanExecutionReplyOptions =
    shouldSuppressApprovedPlanExecutionReplyOptions({
      replyOptions: normalizedReplyOptions,
      workflowMode: input.workflowMode,
      isPlanApproved: input.isPlanApproved,
      planStage: currentPlanStageForReview,
    });
  const suppressNonDecisionReplyOptions =
    suppressReadOnlyPermissionOptions ||
    suppressPlanContinuationReplyOptions ||
    suppressExecutableProposalOptionsForToolCalls ||
    suppressApprovedPlanExecutionReplyOptions;
  const hasStructuredProposal = input.workflowMode === "plan"
    ? hasTieredPlanProposal(input.streamText)
    : hasExplicitPlanProposal(input.streamText);
  const hasReadyPlanArtifacts = currentPlanStageForReview === "ready_to_execute";
  const hasReviewablePlanArtifacts = isReviewablePlanStage(currentPlanStageForReview);
  const rawFinalReplyOptions = compactedProseCodeDump || suppressNonDecisionReplyOptions
    ? []
    : normalizedReplyOptions;
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
    suppressInferredOperationApprovalAfterExecution,
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
