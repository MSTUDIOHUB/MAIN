import {
  logAgentEvent,
  summarizeReplyOptionsForLog,
  truncateForLog,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import { generateId } from "../../utils";
import type { NormalizedStreamState, ReplyOption } from "../../workflowModels";
import type { AgentMessage, OrchestratorCallbacks, ToolCallToExecute } from "../types";
import {
  resolveApprovedPlanFiniteCommandInjection,
  resolveAssistantActionRouting,
} from "./assistantActionRouting";
import { handleAssistantNoToolRecovery } from "./assistantRecoveryHandling";
import { resolveAssistantTurnDisplayDecision } from "./assistantTurnDisplay";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";

type WorkflowMode = "chat" | "edit" | "plan";

type AssistantDisplayActionBaseResult = {
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
};

export type AssistantDisplayActionPhaseResult =
  | (AssistantDisplayActionBaseResult & { status: "continue" })
  | (AssistantDisplayActionBaseResult & { status: "stopped" })
  | (AssistantDisplayActionBaseResult & {
      status: "completed";
      effectiveToolCalls: ToolCallToExecute[];
      finalReplyOptions: ReplyOption[];
      rawFinalReplyOptions: ReplyOption[];
      compactedProseCodeDump: boolean;
      autoContinueReadOnlyPermission: boolean;
      suppressPlanContinuationReplyOptions: boolean;
      suppressInferredReplyOptionsForToolCalls: boolean;
      sourceVisibleText: string;
      finalVisibleText: string;
      currentPlanStageForReview: ReturnType<OrchestratorCallbacks["getPlanStage"]>;
      isApprovedPlanExecutionTurn: boolean;
      hasStructuredProposal: boolean;
      hasReadyPlanArtifacts: boolean;
      hasReviewablePlanArtifacts: boolean;
      planReplyOptionsRoutedToArtifact: boolean;
      injectedRequiredWebResearchCall: boolean;
      userVisibleText: string;
      recentReadOnlyActivityCountForChat: number;
    });

export function handleAssistantDisplayActionPhase(input: {
  callbacks: OrchestratorCallbacks;
  assistantMsgId: string;
  iteration: number;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  streamText: string;
  normalizedBaseVisibleText: string;
  normalized: NormalizedStreamState;
  effectiveToolCalls: ToolCallToExecute[];
  availableToolNames: Set<string>;
  webSearchEnabled: boolean;
  latestUserPromptText: string;
  recentToolActivity: PlanToolActivitySummary[];
  sawPlanModeToolActivity: boolean;
  sawExecuteOperationEvidence: boolean;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  chatFinalSynthesisActive: boolean;
  consecutiveNoToolCount: number;
  isCloudProfile: boolean;
  iterationToolCount: number;
  llmToolCount: number;
  messages: AgentMessage[];
  activateChatFinalSynthesis: (
    reason: string,
    logContext?: Record<string, unknown>,
  ) => void;
}): AssistantDisplayActionPhaseResult {
  let recoveryPromptState = input.recoveryPromptState;
  let effectiveToolCalls = input.effectiveToolCalls;
  const {
    callbacks,
    assistantMsgId,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    normalized,
  } = input;

  const assistantTurnDisplay = resolveAssistantTurnDisplayDecision({
    workflowMode,
    turnIntent,
    runtimeIntent,
    streamText: input.streamText,
    normalizedVisibleText: normalized.visibleText,
    normalizedBaseVisibleText: input.normalizedBaseVisibleText,
    normalizedFinishReason: normalized.finishReason,
    normalizedReplyOptions: normalized.replyOptions,
    effectiveToolCallCount: effectiveToolCalls.length,
    isPlanApproved: callbacks.getIsPlanApproved(),
    planStage: callbacks.getPlanStage(),
    sawPlanModeToolActivity: input.sawPlanModeToolActivity,
    sawExecuteOperationEvidence: input.sawExecuteOperationEvidence,
    readOnlyAutoApproveForSession:
      workflowMode === "edit" || callbacks.getReadOnlyAutoApproveForSession(),
    language: callbacks.getPreferredLanguage(),
  });
  const {
    compactedProseCodeDump,
    compactedIncompletePlanText,
    autoContinueReadOnlyPermission,
    suppressReadOnlyPermissionOptionsForToolCalls,
    suppressTruncatedReadOnlyPermissionOptions,
    suppressPlanContinuationReplyOptions,
    suppressExecutableProposalOptionsForToolCalls,
    suppressInferredReplyOptionsForToolCalls,
    suppressApprovedPlanExecutionReplyOptions,
    suppressMutationRuntimeReplyOptions,
    suppressInferredOperationApprovalAfterExecution,
    sourceVisibleText,
    currentPlanStageForReview,
    isApprovedPlanExecutionTurn,
    hasStructuredProposal,
    hasReadyPlanArtifacts,
    hasReviewablePlanArtifacts,
    rawFinalReplyOptions,
    planReplyOptionsRoutedToArtifact,
    finalVisibleText,
    finalReplyOptions,
  } = assistantTurnDisplay;

  const assistantActionRouting = resolveAssistantActionRouting({
    effectiveToolCalls,
    finalReplyOptions,
    compactedProseCodeDump,
    compactedIncompletePlanText,
    streamText: input.streamText,
    normalizedVisibleText: normalized.visibleText,
    normalizedHiddenThought: normalized.hiddenThought,
    finalVisibleText,
    messages: input.messages,
    availableToolNames: input.availableToolNames,
    workflowMode,
    turnIntent,
    runtimeIntent,
    webSearchEnabled: input.webSearchEnabled,
    latestUserPromptText: input.latestUserPromptText,
    recentToolActivity: input.recentToolActivity,
    webSearchProvider: callbacks.getWebSearchProvider?.(),
    buildToolCallId: () => `call_${generateId()}`,
  });
  effectiveToolCalls = assistantActionRouting.effectiveToolCalls;
  const {
    injectedRequiredWebResearchCall,
    pseudoToolNameCandidate,
    pseudoRecovery,
    pseudoToolCallPlaceholder,
    syntheticVisibleConclusion,
    userVisibleText: routedUserVisibleText,
  } = assistantActionRouting;

  const approvedPlanFiniteCommandInjection = resolveApprovedPlanFiniteCommandInjection({
    isApprovedPlanExecutionTurn,
    toolCallCount: effectiveToolCalls.length,
    replyOptionCount: finalReplyOptions.length,
    availableToolNames: input.availableToolNames,
    tasks: callbacks.getPlanTasks(),
    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
    recentToolActivity: input.recentToolActivity,
    buildToolCallId: () => `call_${generateId()}`,
  });
  if (approvedPlanFiniteCommandInjection) {
    effectiveToolCalls = [approvedPlanFiniteCommandInjection.call];
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    logAgentEvent("approved_plan_finite_command_injected", {
      iteration,
      command: approvedPlanFiniteCommandInjection.command,
      taskId: approvedPlanFiniteCommandInjection.task.id,
      reason: "single_remaining_approved_finite_command",
      workflowMode,
      runtimeIntent,
    });
  }
  const userVisibleText = approvedPlanFiniteCommandInjection
    ? ""
    : routedUserVisibleText;

  if (pseudoRecovery?.call) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    logAgentEvent("pseudo_tool_recovered", {
      iteration,
      requestedToolName: pseudoRecovery.requestedToolName,
      recoveredToolName: pseudoRecovery.recoveredToolName,
      reason: pseudoRecovery.reason,
      argumentKeys: pseudoRecovery.argumentKeys,
      mentionedPathCount: pseudoRecovery.mentionedPathCount,
      workflowMode,
      turnIntent,
    });
  } else if (pseudoRecovery) {
    logAgentEvent("pseudo_tool_recovery_unavailable", {
      iteration,
      requestedToolName: pseudoRecovery.requestedToolName,
      reason: pseudoRecovery.reason,
      mentionedPathCount: pseudoRecovery.mentionedPathCount,
      workflowMode,
      turnIntent,
    });
  }
  if (injectedRequiredWebResearchCall) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    logAgentEvent("web_research_required_tool_injected", {
      iteration,
      workflowMode,
      turnIntent,
      runtimeIntent,
      query: truncateForLog(assistantActionRouting.webResearchQuery || "", 180),
      provider: assistantActionRouting.webResearchProvider || "duckduckgo",
      visibleChars: finalVisibleText.length,
    });
  }
  if (suppressReadOnlyPermissionOptionsForToolCalls) {
    logAgentEvent("readonly_permission_options_ignored_for_tool_call", {
      iteration,
      toolCalls: effectiveToolCalls.length,
      replyOptions: normalized.replyOptions.length,
      workflowMode,
      turnIntent,
    });
  }
  if (suppressTruncatedReadOnlyPermissionOptions) {
    logAgentEvent("truncated_readonly_permission_options_ignored", {
      iteration,
      replyOptions: normalized.replyOptions.length,
      hiddenThoughtChars: normalized.hiddenThought.length,
      visibleChars: normalized.visibleText.length,
      workflowMode,
      turnIntent,
    });
  }
  if (suppressPlanContinuationReplyOptions) {
    logAgentEvent("plan_continuation_reply_options_ignored", {
      iteration,
      replyOptions: normalized.replyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
      visibleChars: normalized.visibleText.length,
      workflowMode,
      turnIntent,
    });
  }
  if (suppressExecutableProposalOptionsForToolCalls) {
    logAgentEvent("plan_executable_reply_options_ignored_for_tool_call", {
      iteration,
      toolCalls: effectiveToolCalls.length,
      replyOptions: normalized.replyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
      workflowMode,
      turnIntent,
    });
  }
  if (suppressInferredReplyOptionsForToolCalls) {
    logAgentEvent("inferred_reply_options_ignored_for_tool_call", {
      iteration,
      toolCalls: effectiveToolCalls.length,
      replyOptions: normalized.replyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
      workflowMode,
      turnIntent,
      runtimeIntent,
    });
  }
  if (suppressApprovedPlanExecutionReplyOptions) {
    logAgentEvent("approved_plan_execution_reply_options_ignored", {
      iteration,
      replyOptions: normalized.replyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
      visibleChars: normalized.visibleText.length,
      workflowMode,
      turnIntent,
      runtimeIntent,
      planStage: currentPlanStageForReview,
    });
    logAgentEvent("approved_plan_execution_nonblocking_options_ignored", {
      iteration,
      reason: effectiveToolCalls.length > 0
        ? "tool_calls_present"
        : "not_explicit_blocking_user_decision",
      replyOptions: normalized.replyOptions.length,
      toolCalls: effectiveToolCalls.length,
      workflowMode,
      turnIntent,
      runtimeIntent,
      planStage: currentPlanStageForReview,
    });
  }
  if (suppressMutationRuntimeReplyOptions) {
    logAgentEvent("mutation_runtime_reply_options_suppressed", {
      iteration,
      reason: effectiveToolCalls.length > 0
        ? "tool_calls_present"
        : "model_owned_work_or_reapproval",
      replyOptions: normalized.replyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
      toolCalls: effectiveToolCalls.length,
      workflowMode,
      turnIntent,
      runtimeIntent,
    });
  }
  if (suppressInferredOperationApprovalAfterExecution) {
    logAgentEvent("inferred_operation_approval_suppressed_after_execution", {
      iteration,
      workflowMode,
      turnIntent,
      runtimeIntent,
      finishReason: normalized.finishReason || "unknown",
      executionEvidenceObserved: input.sawExecuteOperationEvidence,
      suppressedOptions:
        normalized.replyOptions.length - rawFinalReplyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
    });
  }
  if (planReplyOptionsRoutedToArtifact) {
    logAgentEvent("plan_reply_options_routed_to_artifact", {
      iteration,
      replyOptions: rawFinalReplyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(rawFinalReplyOptions),
      sawPlanModeToolActivity: input.sawPlanModeToolActivity,
      visibleChars: sourceVisibleText.length,
      workflowMode,
      turnIntent,
    });
  }
  if (syntheticVisibleConclusion) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    logAgentEvent("synthetic_visible_conclusion_suppressed", {
      iteration,
      workflowMode,
      turnIntent,
      hiddenThoughtChars: normalized.hiddenThought.length,
      toolCalls: effectiveToolCalls.length,
    });
  }
  if (finalReplyOptions.length > 0) {
    logAgentEvent("reply_options_detected", {
      iteration,
      replyOptions: finalReplyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
      toolCalls: effectiveToolCalls.length,
      workflowMode,
      turnIntent,
    });
  }

  const assistantNoToolRecovery = handleAssistantNoToolRecovery({
    callbacks,
    assistantMsgId,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    finishReason: normalized.finishReason,
    effectiveToolCallCount: effectiveToolCalls.length,
    finalReplyOptionCount: finalReplyOptions.length,
    userVisibleText,
    normalizedVisibleText: normalized.visibleText,
    normalizedHiddenThought: normalized.hiddenThought,
    compactedProseCodeDump,
    chatFinalSynthesisActive: input.chatFinalSynthesisActive,
    recentToolActivity: input.recentToolActivity,
    consecutiveNoToolCount: input.consecutiveNoToolCount,
    isCloudProfile: input.isCloudProfile,
    iterationToolCount: input.iterationToolCount,
    llmToolCount: input.llmToolCount,
    pseudoToolCallPlaceholder,
    pseudoToolNameCandidate,
    recoveryPromptState,
    activateChatFinalSynthesis: input.activateChatFinalSynthesis,
  });
  recoveryPromptState = assistantNoToolRecovery.recoveryPromptState;
  if (assistantNoToolRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (assistantNoToolRecovery.status === "continue") {
    return finish("continue");
  }

  return {
    status: "completed",
    recoveryPromptState,
    effectiveToolCalls,
    finalReplyOptions,
    rawFinalReplyOptions,
    compactedProseCodeDump,
    autoContinueReadOnlyPermission,
    suppressPlanContinuationReplyOptions,
    suppressInferredReplyOptionsForToolCalls,
    sourceVisibleText,
    finalVisibleText,
    currentPlanStageForReview,
    isApprovedPlanExecutionTurn,
    hasStructuredProposal,
    hasReadyPlanArtifacts,
    hasReviewablePlanArtifacts,
    planReplyOptionsRoutedToArtifact,
    injectedRequiredWebResearchCall,
    userVisibleText,
    recentReadOnlyActivityCountForChat:
      assistantNoToolRecovery.recentReadOnlyActivityCountForChat,
  };

  function finish(
    status: "continue",
  ): AssistantDisplayActionBaseResult & { status: "continue" };
  function finish(
    status: "stopped",
  ): AssistantDisplayActionBaseResult & { status: "stopped" };
  function finish(
    status: "continue" | "stopped",
  ): AssistantDisplayActionBaseResult & { status: "continue" | "stopped" } {
    return {
      status,
      recoveryPromptState,
    };
  }
}
