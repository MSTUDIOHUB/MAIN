import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { EffectiveTurnContract, ResolvedUserIntent } from "../../runIntent";
import type { StreamResult } from "../../streaming";
import type { ToolDefinition } from "../../toolSchemas";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { OrchestratorCallbacks, ToolCallToExecute } from "../types";
import { handleAssistantCompletionPhase } from "./assistantCompletionPhase";
import { handleAssistantDisplayActionPhase } from "./assistantDisplayActionPhase";
import { handleAssistantOutputPhase } from "./assistantOutputPhase";
import type { ProviderReasoningForHistory } from "./assistantResponseProcessing";
import { handleAssistantStreamPostProcessingPhase } from "./assistantStreamPostProcessingPhase";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import type { AgentLoopGuardRuntimeState } from "./loopGuardRuntimeState";
import type { AgentLoopNoToolRuntimeState } from "./noToolRuntimeState";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import type { AgentLoopStreamRuntimeState } from "./streamRuntimeState";
import type { TurnIterationContext } from "./turnIterationContext";
import type { AgentLoopRuntimeState } from "./turnPreparation";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import {
  handleUnityMcpNoToolRecovery,
  type UnityMcpRuntimeState,
} from "./unityMcpRuntime";

type SetPlanRuntimePhase = Parameters<typeof handleAssistantCompletionPhase>[0]["setPlanRuntimePhase"];
type ActivateExecuteRecovery = Parameters<typeof handleAssistantStreamPostProcessingPhase>[0]["activateExecuteRecovery"];
type ActivateChatFinalSynthesis = Parameters<typeof handleAssistantDisplayActionPhase>[0]["activateChatFinalSynthesis"];
type PauseForReviewablePlanArtifact = Parameters<typeof handleAssistantStreamPostProcessingPhase>[0]["pauseForReviewablePlanArtifact"];
type TryClosePlanWithEvidence = Parameters<typeof handleAssistantCompletionPhase>[0]["tryClosePlanWithEvidence"];
type WaitForPlanApprovalIfNeeded = Parameters<typeof handleAssistantCompletionPhase>[0]["waitForPlanApprovalIfNeeded"];
type EmitTaskOrchestratorPhase = Parameters<typeof handleAssistantCompletionPhase>[0]["emitTaskOrchestratorPhase"];
type EmitPlanExecutionProgress = Parameters<typeof handleAssistantCompletionPhase>[0]["emitPlanExecutionProgress"];
type EmitTurnEvent = Parameters<typeof handleAssistantCompletionPhase>[0]["emitTurnEvent"];

type AssistantIterationBaseResult = {
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  unityMcpRuntimeState: UnityMcpRuntimeState;
};

export type AssistantIterationPhaseResult =
  | (AssistantIterationBaseResult & { status: "continue" })
  | (AssistantIterationBaseResult & { status: "stopped" })
  | (AssistantIterationBaseResult & {
      status: "completed";
      effectiveToolCalls: ToolCallToExecute[];
      historyAssistantText: string;
      providerReasoningForHistory: ProviderReasoningForHistory;
      finalReplyOptionCount: number;
      hasStructuredProposal: boolean;
    });

export async function handleAssistantIterationPhase(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  streamResult: StreamResult;
  iteration: number;
  effectiveMaxIterations: number;
  iterationRequestStartedAt: number;
  runtimeIntent: ResolvedUserIntent;
  effectiveTurnContract: EffectiveTurnContract | null;
  forceXmlTools: boolean;
  iterationAllTools: ToolDefinition[];
  llmTools: ToolDefinition[];
  managedMessageCount: number;
  assistantMsgId: string;
  finalTextOnlyStep: boolean;
  availableToolNames: Set<string>;
  webSearchEnabled: boolean;
  latestUserPromptText: string;
  repairExecutionRequestInChat: boolean;
  commandDirectiveAction?: string | null;
  unityConsoleDiagnosticsRequested: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  streamRuntimeState: AgentLoopStreamRuntimeState;
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  loopGuardRuntimeState: AgentLoopGuardRuntimeState;
  unityMcpRuntimeState: UnityMcpRuntimeState;
  iterationContext: TurnIterationContext;
  emitTurnEvent: EmitTurnEvent;
  emitTurnCompletedEvent: () => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
  setPlanRuntimePhase: SetPlanRuntimePhase;
  activateExecuteRecovery: ActivateExecuteRecovery;
  activateChatFinalSynthesis: ActivateChatFinalSynthesis;
  activateUnityMcpFallback: (reason: string) => void;
  pauseForReviewablePlanArtifact: PauseForReviewablePlanArtifact;
  tryClosePlanWithEvidence: TryClosePlanWithEvidence;
  waitForPlanApprovalIfNeeded: WaitForPlanApprovalIfNeeded;
  getExecuteRecoveryState: () => ExecuteRecoveryRuntimeState;
}): Promise<AssistantIterationPhaseResult> {
  let noToolRuntimeState = input.noToolRuntimeState;
  let planRuntimeState = input.planRuntimeState;
  let recoveryPromptState = input.recoveryPromptState;
  let evidenceRuntimeState = input.evidenceRuntimeState;
  let unityMcpRuntimeState = input.unityMcpRuntimeState;
  const {
    callbacks,
    runtimeState,
    iteration,
    runtimeIntent,
    iterationContext,
  } = input;
  const {
    config,
    isCloudProfile,
    mainModeKey,
    turnIntent,
    workflowMode,
    workspace,
  } = runtimeState;

  const assistantStreamPostProcessingPhase =
    await handleAssistantStreamPostProcessingPhase({
      callbacks,
      runtimeState,
      streamResult: input.streamResult,
      iteration,
      iterationRequestStartedAt: input.iterationRequestStartedAt,
      runtimeIntent,
      forceXmlTools: input.forceXmlTools,
      llmToolCount: input.llmTools.length,
      managedMessageCount: input.managedMessageCount,
      currentMaxTokens: input.streamRuntimeState.currentMaxTokens,
      turnContext: iterationContext.turnContext,
      assistantMsgId: input.assistantMsgId,
      effectiveMaxIterations: input.effectiveMaxIterations,
      finalTextOnlyStep: input.finalTextOnlyStep,
      chatFinalSynthesisActive: input.streamRuntimeState.chatFinalSynthesisActive,
      chatFinalSynthesisReason: input.streamRuntimeState.chatFinalSynthesisReason,
      repairExecutionRequestInChat: input.repairExecutionRequestInChat,
      noProgressBatchRepeatCount:
        input.loopGuardRuntimeState.noProgressBatchRepeatCount,
      turnInputContextSignals: input.turnInputContextSignals,
      recentPlanToolActivity: input.recentPlanToolActivity,
      recentToolActivity: input.recentToolActivity,
      lastAssistantTextForCheckpoint:
        input.evidenceRuntimeState.lastAssistantTextForCheckpoint,
      recentSuccessfulProjectWrite:
        input.evidenceRuntimeState.recentSuccessfulProjectWrite,
      noToolRuntimeState,
      planRuntimeState,
      recoveryPromptState,
      iterationContext,
      emitTurnEvent: input.emitTurnEvent,
      emitTurnCompletedEvent: input.emitTurnCompletedEvent,
      setPlanRuntimePhase: input.setPlanRuntimePhase,
      activateExecuteRecovery: input.activateExecuteRecovery,
      pauseForReviewablePlanArtifact: input.pauseForReviewablePlanArtifact,
      tryClosePlanWithEvidence: input.tryClosePlanWithEvidence,
    });
  noToolRuntimeState =
    assistantStreamPostProcessingPhase.noToolRuntimeState;
  planRuntimeState =
    assistantStreamPostProcessingPhase.planRuntimeState;
  recoveryPromptState =
    assistantStreamPostProcessingPhase.recoveryPromptState;
  if (assistantStreamPostProcessingPhase.status !== "completed") {
    return {
      status: assistantStreamPostProcessingPhase.status,
      noToolRuntimeState,
      planRuntimeState,
      recoveryPromptState,
      evidenceRuntimeState,
      unityMcpRuntimeState,
    };
  }
  const {
    streamText,
    providerReasoningForHistory,
    normalizedBase,
    normalized,
  } = assistantStreamPostProcessingPhase;
  let { effectiveToolCalls } = assistantStreamPostProcessingPhase;

  const assistantDisplayActionPhase = handleAssistantDisplayActionPhase({
    callbacks,
    assistantMsgId: input.assistantMsgId,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    streamText,
    normalizedBaseVisibleText: normalizedBase.visibleText,
    normalized,
    effectiveToolCalls,
    availableToolNames: input.availableToolNames,
    webSearchEnabled: input.webSearchEnabled,
    latestUserPromptText: input.latestUserPromptText,
    recentToolActivity: input.recentToolActivity,
    sawPlanModeToolActivity: planRuntimeState.sawPlanModeToolActivity,
    sawExecuteOperationEvidence:
      evidenceRuntimeState.sawExecuteOperationEvidence,
    recoveryPromptState,
    chatFinalSynthesisActive: input.streamRuntimeState.chatFinalSynthesisActive,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
    isCloudProfile,
    iterationToolCount: input.iterationAllTools.length,
    llmToolCount: input.llmTools.length,
    messages: callbacks.getMessages(),
    activateChatFinalSynthesis: input.activateChatFinalSynthesis,
  });
  recoveryPromptState = assistantDisplayActionPhase.recoveryPromptState;
  if (assistantDisplayActionPhase.status !== "completed") {
    return {
      status: assistantDisplayActionPhase.status,
      noToolRuntimeState,
      planRuntimeState,
      recoveryPromptState,
      evidenceRuntimeState,
      unityMcpRuntimeState,
    };
  }
  effectiveToolCalls = assistantDisplayActionPhase.effectiveToolCalls;
  if (effectiveToolCalls.length > 0) {
    callbacks.onStreamToken("__EVIDENCE_DRAFT_COMMIT__:tool_call", input.assistantMsgId);
  }

  const unityMcpNoToolRecovery = handleUnityMcpNoToolRecovery({
    callbacks,
    state: unityMcpRuntimeState,
    iteration,
    toolCallCount: effectiveToolCalls.length,
    replyOptionCount: assistantDisplayActionPhase.finalReplyOptions.length,
    unityConsoleDiagnosticsRequested: input.unityConsoleDiagnosticsRequested,
    forceXmlTools: input.forceXmlTools,
    activateUnityMcpFallback: input.activateUnityMcpFallback,
  });
  unityMcpRuntimeState = unityMcpNoToolRecovery.state;
  if (unityMcpNoToolRecovery.status === "continue") {
    return {
      status: "continue",
      noToolRuntimeState,
      planRuntimeState,
      recoveryPromptState,
      evidenceRuntimeState,
      unityMcpRuntimeState,
    };
  }

  const assistantOutputPhase = handleAssistantOutputPhase({
    callbacks,
    activeProfile: config.activeProfile,
    assistantMsgId: input.assistantMsgId,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    workspace,
    latestUserPromptText: input.latestUserPromptText,
    availableToolNames: input.availableToolNames,
    effectiveToolCalls,
    normalized,
    streamText,
    providerReasoningForHistory,
    compactedProseCodeDump: assistantDisplayActionPhase.compactedProseCodeDump,
    autoContinueReadOnlyPermission: assistantDisplayActionPhase.autoContinueReadOnlyPermission,
    suppressPlanContinuationReplyOptions: assistantDisplayActionPhase.suppressPlanContinuationReplyOptions,
    sourceVisibleText: assistantDisplayActionPhase.sourceVisibleText,
    finalVisibleText: assistantDisplayActionPhase.finalVisibleText,
    currentPlanStageForReview: assistantDisplayActionPhase.currentPlanStageForReview,
    isApprovedPlanExecutionTurn: assistantDisplayActionPhase.isApprovedPlanExecutionTurn,
    hasStructuredProposal: assistantDisplayActionPhase.hasStructuredProposal,
    hasReadyPlanArtifacts: assistantDisplayActionPhase.hasReadyPlanArtifacts,
    hasReviewablePlanArtifacts: assistantDisplayActionPhase.hasReviewablePlanArtifacts,
    rawFinalReplyOptions: assistantDisplayActionPhase.rawFinalReplyOptions,
    planReplyOptionsRoutedToArtifact: assistantDisplayActionPhase.planReplyOptionsRoutedToArtifact,
    finalReplyOptions: assistantDisplayActionPhase.finalReplyOptions,
    injectedRequiredWebResearchCall: assistantDisplayActionPhase.injectedRequiredWebResearchCall,
    userVisibleText: assistantDisplayActionPhase.userVisibleText,
    recentReadOnlyActivityCountForChat: assistantDisplayActionPhase.recentReadOnlyActivityCountForChat,
    chatFinalSynthesisActive: input.streamRuntimeState.chatFinalSynthesisActive,
    recentPlanToolActivity: input.recentPlanToolActivity,
    recentToolActivity: input.recentToolActivity,
    turnInputContextSignals: input.turnInputContextSignals,
    noToolRuntimeState,
    planRuntimeState,
    evidenceRuntimeState,
    recoveryPromptState,
    activateChatFinalSynthesis: input.activateChatFinalSynthesis,
    setPlanRuntimePhase: input.setPlanRuntimePhase,
  });
  noToolRuntimeState = assistantOutputPhase.noToolRuntimeState;
  planRuntimeState = assistantOutputPhase.planRuntimeState;
  evidenceRuntimeState = assistantOutputPhase.evidenceRuntimeState;
  recoveryPromptState = assistantOutputPhase.recoveryPromptState;
  if (assistantOutputPhase.status !== "completed") {
    return {
      status: assistantOutputPhase.status,
      noToolRuntimeState,
      planRuntimeState,
      recoveryPromptState,
      evidenceRuntimeState,
      unityMcpRuntimeState,
    };
  }

  const assistantCompletionPhase = await handleAssistantCompletionPhase({
    callbacks,
    activeProfile: config.activeProfile,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    effectiveTurnContract: input.effectiveTurnContract,
    mainModeKey,
    commandDirectiveAction: input.commandDirectiveAction,
    workspace,
    latestUserPromptText: input.latestUserPromptText,
    forceXmlTools: input.forceXmlTools,
    availableToolNames: input.availableToolNames,
    effectiveToolCalls,
    finalReplyOptions: assistantDisplayActionPhase.finalReplyOptions,
    shouldPauseForUserChoice: assistantOutputPhase.shouldPauseForUserChoice,
    shouldSuppressApprovedPlanNoToolText:
      assistantOutputPhase.shouldSuppressApprovedPlanNoToolText,
    hasStructuredProposal: assistantDisplayActionPhase.hasStructuredProposal,
    currentPlanStageForReview: assistantDisplayActionPhase.currentPlanStageForReview,
    approvedPlanAuditForNoTool: assistantOutputPhase.approvedPlanAuditForNoTool,
    rejectedCompletionClaim: assistantOutputPhase.rejectedCompletionClaim,
    wasTruncated: assistantOutputPhase.wasTruncated,
    sawExecuteOperationEvidence:
      evidenceRuntimeState.sawExecuteOperationEvidence,
    normalized,
    streamText,
    recentPlanToolActivity: input.recentPlanToolActivity,
    recentToolActivity: input.recentToolActivity,
    attemptedPlanWriteTargets: input.attemptedPlanWriteTargets,
    sourceVisibleText: assistantDisplayActionPhase.sourceVisibleText,
    assistantHistoryText: assistantOutputPhase.assistantHistoryText,
    providerReasoningForHistory,
    assistantMsgId: input.assistantMsgId,
    hasReviewablePlanArtifacts: assistantDisplayActionPhase.hasReviewablePlanArtifacts,
    hasExecutablePlanProposalOptions:
      assistantOutputPhase.hasExecutablePlanProposalOptions,
    planReplyOptionsRoutedToArtifact:
      assistantDisplayActionPhase.planReplyOptionsRoutedToArtifact,
    hasMeaningfulVisibleText: assistantOutputPhase.hasMeaningfulVisibleText,
    visibleAssistantText: assistantOutputPhase.visibleAssistantText,
    userVisibleText: assistantDisplayActionPhase.userVisibleText,
    compactedProseCodeDump: assistantDisplayActionPhase.compactedProseCodeDump,
    hiddenThoughtOnlyNoToolStop: assistantOutputPhase.hiddenThoughtOnlyNoToolStop,
    recentSuccessfulProjectWrite:
      evidenceRuntimeState.recentSuccessfulProjectWrite,
    recoveringFromEmptyAssistantReplyAfterWrite:
      noToolRuntimeState.recoveringFromEmptyAssistantReplyAfterWrite,
    turnInputContextSignals: input.turnInputContextSignals,
    noToolRuntimeState,
    planRuntimeState,
    unityConsoleDiagnosticsRequested: input.unityConsoleDiagnosticsRequested,
    unityConsoleFinalVerificationRequired:
      unityMcpRuntimeState.consoleFinalVerificationRequired,
    iterationContext,
    emitTurnEvent: input.emitTurnEvent,
    emitTurnCompletedEvent: input.emitTurnCompletedEvent,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
    emitPlanExecutionProgress: input.emitPlanExecutionProgress,
    setPlanRuntimePhase: input.setPlanRuntimePhase,
    waitForPlanApprovalIfNeeded: input.waitForPlanApprovalIfNeeded,
    tryClosePlanWithEvidence: input.tryClosePlanWithEvidence,
    getExecuteRecoveryState: input.getExecuteRecoveryState,
    activateExecuteRecovery: input.activateExecuteRecovery,
  });
  noToolRuntimeState = assistantCompletionPhase.noToolRuntimeState;
  planRuntimeState = assistantCompletionPhase.planRuntimeState;
  if (assistantCompletionPhase.status !== "completed") {
    return {
      status: assistantCompletionPhase.status,
      noToolRuntimeState,
      planRuntimeState,
      recoveryPromptState,
      evidenceRuntimeState,
      unityMcpRuntimeState,
    };
  }

  return {
    status: "completed",
    noToolRuntimeState,
    planRuntimeState,
    recoveryPromptState,
    evidenceRuntimeState,
    unityMcpRuntimeState,
    effectiveToolCalls,
    historyAssistantText: assistantOutputPhase.historyAssistantText,
    providerReasoningForHistory,
    finalReplyOptionCount: assistantDisplayActionPhase.finalReplyOptions.length,
    hasStructuredProposal: assistantDisplayActionPhase.hasStructuredProposal,
  };
}
