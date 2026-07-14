import {
  buildReadOnlyPermissionContinuationPrompt,
  serializeAssistantReplyForHistory,
} from "../../replyOptions";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import { progressNarrationToText } from "../../progressNarration";
import {
  buildAssistantHistoryMessage,
  buildReadOnlyPermissionHardRecoveryPrompt,
  buildToolActionNarration,
  getToolTarget,
  logAgentEvent,
  MAX_NO_ACTION_RETRIES,
  parseToolCallArguments,
  summarizeReplyOptionsForLog,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type {
  NormalizedStreamState,
  PlanTaskEvidenceAudit,
  ReplyOption,
} from "../../workflowModels";
import type { OrchestratorCallbacks, ToolCallToExecute } from "../types";
import { resolveApprovedPlanNoToolRoute } from "./approvedPlanNoToolRouting";
import type { ApprovedPlanRecoveryRuntimeState } from "./approvedPlanRecoveryRuntime";
import { resetApprovedPlanLongReasoningNoActionCount } from "./approvedPlanRecoveryRuntime";
import {
  isHiddenThoughtOnlyNoToolStop,
  resolveClosedPlanReadOnlyContinuation,
  resolveNonBlockingPlanChoiceLoop,
  resolveAssistantReplyOptionRouting,
  resolveToolProtocolStreamClearDecision,
  shouldAutoContinueNonBlockingPlanChoices,
  shouldTrackAssistantCheckpoint,
} from "./assistantOutputRouting";
import { handleAssistantLanguageRecovery } from "./assistantRecoveryHandling";
import type { ProviderReasoningForHistory } from "./assistantResponseProcessing";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import { setLastAssistantTextForCheckpointRuntimeState } from "./evidenceRuntimeState";
import type { AgentLoopNoToolRuntimeState } from "./noToolRuntimeState";
import {
  buildPlanTargetedEvidenceRecoveryPrompt,
  shouldAdvancePlanFromStructureOnTargetedRead,
} from "../../planRuntime";
import {
  incrementConsecutiveNoToolRuntimeState,
  resetConsecutiveNoToolRuntimeState,
} from "./noToolRuntimeState";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import {
  applyPlanEvidenceRecoveryRuntimeState,
  applyPlanPostConvergenceRuntimeState,
  applyPlanRuntimePhase,
  markPlanModeToolActivity,
} from "./planRuntimeState";
import { handlePlanPostConvergenceToolRedirect } from "./planConvergence";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import { markReadOnlyPermissionHardRecoveryPromptUsed } from "./recoveryPromptRuntimeState";
import {
  isAllowedUnapprovedPlanDraftMutationCallForRuntime,
  resolveToolProgressPresentation,
  resolveToolProgressRouting,
  shouldInjectRuntimeToolNarration,
} from "./toolProgressRouting";

type WorkflowMode = "chat" | "edit" | "plan";

type AssistantOutputBaseResult = {
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
};

export type AssistantOutputPhaseResult =
  | (AssistantOutputBaseResult & { status: "continue" })
  | (AssistantOutputBaseResult & { status: "stopped" })
  | (AssistantOutputBaseResult & {
      status: "completed";
      shouldPauseForUserChoice: boolean;
      shouldSuppressApprovedPlanNoToolText: boolean;
      approvedPlanAuditForNoTool: PlanTaskEvidenceAudit | null;
      rejectedCompletionClaim: boolean;
      wasTruncated: boolean;
      historyAssistantText: string;
      assistantHistoryText: string;
      hasExecutablePlanProposalOptions: boolean;
      hasMeaningfulVisibleText: boolean;
      visibleAssistantText: string;
      hiddenThoughtOnlyNoToolStop: boolean;
    });

export function handleAssistantOutputPhase(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  assistantMsgId: string;
  iteration: number;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  workspace: string;
  latestUserPromptText: string;
  availableToolNames: Set<string>;
  effectiveToolCalls: ToolCallToExecute[];
  normalized: NormalizedStreamState;
  streamText: string;
  providerReasoningForHistory: ProviderReasoningForHistory;
  compactedProseCodeDump: boolean;
  autoContinueReadOnlyPermission: boolean;
  suppressPlanContinuationReplyOptions: boolean;
  sourceVisibleText: string;
  finalVisibleText: string;
  currentPlanStageForReview: ReturnType<OrchestratorCallbacks["getPlanStage"]>;
  isApprovedPlanExecutionTurn: boolean;
  hasStructuredProposal: boolean;
  hasReadyPlanArtifacts: boolean;
  hasReviewablePlanArtifacts: boolean;
  rawFinalReplyOptions: ReplyOption[];
  planReplyOptionsRoutedToArtifact: boolean;
  finalReplyOptions: ReplyOption[];
  injectedRequiredWebResearchCall: boolean;
  userVisibleText: string;
  recentReadOnlyActivityCountForChat: number;
  chatFinalSynthesisActive: boolean;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  turnInputContextSignals: Parameters<typeof handlePlanPostConvergenceToolRedirect>[0]["turnInputContextSignals"];
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  activateChatFinalSynthesis: (
    reason: string,
    logContext?: Record<string, unknown>,
  ) => void;
  setPlanRuntimePhase: Parameters<typeof handlePlanPostConvergenceToolRedirect>[0]["setPlanRuntimePhase"];
}): AssistantOutputPhaseResult {
  const {
    callbacks,
    assistantMsgId,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    workspace,
    effectiveToolCalls,
    normalized,
    streamText,
    finalReplyOptions,
    userVisibleText,
  } = input;
  let noToolRuntimeState = input.noToolRuntimeState;
  let planRuntimeState = input.planRuntimeState;
  let approvedPlanRecoveryState = input.approvedPlanRecoveryState;
  let evidenceRuntimeState = input.evidenceRuntimeState;
  let recoveryPromptState = input.recoveryPromptState;
  const setPlanRuntimePhaseAndSync: typeof input.setPlanRuntimePhase = (phase, reason) => {
    input.setPlanRuntimePhase(phase, reason);
    planRuntimeState = applyPlanRuntimePhase(planRuntimeState, { phase, reason }).state;
  };

  const finishControl = (
    status: "continue" | "stopped",
  ): AssistantOutputPhaseResult => ({
    status,
    noToolRuntimeState,
    planRuntimeState,
    approvedPlanRecoveryState,
    evidenceRuntimeState,
    recoveryPromptState,
  });

  if (input.compactedProseCodeDump) {
    logAgentEvent("prose_code_dump_compacted", {
      iteration,
      originalVisibleChars: normalized.visibleText.length,
      compactedVisibleChars: input.finalVisibleText.length,
      workflowMode,
      turnIntent,
    });
  }

  const approvedPlanNoToolRoute = resolveApprovedPlanNoToolRoute({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    planStage: input.currentPlanStageForReview,
    toolCallCount: effectiveToolCalls.length,
    planTasks: callbacks.getPlanTasks(),
    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
    userVisibleText,
  });
  const approvedPlanAuditForNoTool = approvedPlanNoToolRoute.audit;
  const approvedPlanMissingTasksForNoTool =
    approvedPlanNoToolRoute.approvedPlanMissingTasks;
  const shouldHandleApprovedPlanNoTool =
    approvedPlanNoToolRoute.shouldHandleApprovedPlanNoTool;
  const shouldSuppressApprovedPlanNoToolText =
    approvedPlanNoToolRoute.shouldSuppressApprovedPlanNoToolText;
  const rejectedCompletionClaim =
    approvedPlanNoToolRoute.rejectedCompletionClaim;
  const shouldHideApprovedPlanNoToolText =
    approvedPlanNoToolRoute.shouldHideApprovedPlanNoToolText;

  if (
    shouldSuppressApprovedPlanNoToolText &&
    (userVisibleText.trim() || finalReplyOptions.length > 0)
  ) {
    if (shouldHideApprovedPlanNoToolText) {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    }
    logAgentEvent(
      rejectedCompletionClaim
        ? "plan_completion_claim_rejected"
        : "plan_no_tool_text_suppressed",
      {
        iteration,
        completionClaimRejected: rejectedCompletionClaim,
        auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
        auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
        remaining: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
        visibleChars: userVisibleText.length,
        preservedVisibleText: !shouldHideApprovedPlanNoToolText,
      },
    );
  }
  if (approvedPlanNoToolRoute.shouldLogApprovedPlanNoToolRoute) {
    logAgentEvent("approved_plan_no_tool_route", {
      iteration,
      planStage: input.currentPlanStageForReview,
      handledByExecutionCheckpoint: shouldHandleApprovedPlanNoTool,
      missingTasksArtifact: approvedPlanMissingTasksForNoTool,
      remainingTasks: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
      pendingUserValidation:
        approvedPlanAuditForNoTool?.pendingUserValidationTasks.length ?? 0,
      pendingExternalValidation:
        approvedPlanAuditForNoTool?.pendingExternalValidation ?? false,
      allTrustedComplete:
        approvedPlanAuditForNoTool?.allTrustedComplete ?? false,
      acceptedCompletion:
        approvedPlanAuditForNoTool?.acceptedCompletion ?? false,
      visibleChars: userVisibleText.length,
    });
  }

  const languageRecovery = handleAssistantLanguageRecovery({
    callbacks,
    assistantMsgId,
    iteration,
    workflowMode,
    runtimeIntent,
    userVisibleText,
    shouldSuppressApprovedPlanNoToolText,
    effectiveToolCallCount: effectiveToolCalls.length,
    injectedRequiredWebResearchCall: input.injectedRequiredWebResearchCall,
    chatFinalSynthesisActive: input.chatFinalSynthesisActive,
    recoveryPromptState,
    recentReadOnlyActivityCountForChat:
      input.recentReadOnlyActivityCountForChat,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
    activateChatFinalSynthesis: input.activateChatFinalSynthesis,
  });
  recoveryPromptState = languageRecovery.recoveryPromptState;
  if (languageRecovery.status === "continue") {
    return finishControl("continue");
  }
  let visibleAssistantText = languageRecovery.visibleAssistantText;

  const isAllowedUnapprovedPlanDraftMutationCall = (
    call: ToolCallToExecute,
  ) =>
    isAllowedUnapprovedPlanDraftMutationCallForRuntime({
      call,
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      workspace,
    });
  const toolProgressRouting = resolveToolProgressRouting({
    effectiveToolCalls,
    availableToolNames: input.availableToolNames,
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    workspace,
    visibleAssistantText,
  });
  const {
    unsupportedToolCalls,
    progressEligibleToolCalls,
    hasSuppressedUnsupportedPlanToolCalls,
    hasSubstantivePlanAssistantText,
  } = toolProgressRouting;
  const toolActionNarration =
    progressEligibleToolCalls.length > 0
      ? buildToolActionNarration({
          calls: progressEligibleToolCalls,
          workspace,
          language: callbacks.getPreferredLanguage(),
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          userGoal: input.latestUserPromptText,
          turnIntent,
          currentHypothesis:
            visibleAssistantText.trim() ||
            evidenceRuntimeState.lastAssistantTextForCheckpoint,
          previousObservation:
            input.recentToolActivity[input.recentToolActivity.length - 1]
              ?.detail || "",
          userContext: input.turnInputContextSignals,
        })
      : null;
  const runtimeNarrationInjected = shouldInjectRuntimeToolNarration({
    progressEligibleToolCallCount: progressEligibleToolCalls.length,
    visibleAssistantText,
    hasToolActionNarration: !!toolActionNarration,
  });
  if (runtimeNarrationInjected && toolActionNarration) {
    visibleAssistantText = progressNarrationToText(
      toolActionNarration,
      callbacks.getPreferredLanguage(),
    );
    logAgentEvent("tool_action_narration_injected", {
      iteration,
      workflowMode,
      turnIntent,
      toolCalls: progressEligibleToolCalls.length,
      toolNames: progressEligibleToolCalls
        .map((call) => call.name)
        .slice(0, 8),
    });
  }
  if (hasSuppressedUnsupportedPlanToolCalls) {
    logAgentEvent("plan_unsupported_tool_call_suppressed", {
      iteration,
      reason: "unavailable_before_progress",
      toolNames: unsupportedToolCalls.map((call) => call.name).slice(0, 8),
      availableToolNames: Array.from(input.availableToolNames).slice(0, 12),
      preservedVisibleText: visibleAssistantText.trim().length > 0,
      planRuntimePhase: planRuntimeState.planRuntimePhase,
    });
    if (shouldAdvancePlanFromStructureOnTargetedRead({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      planRuntimePhase: planRuntimeState.planRuntimePhase,
      requestedToolNames: unsupportedToolCalls.map((call) => call.name),
    })) {
      setPlanRuntimePhaseAndSync(
        "grounding",
        "targeted read requested before the structure pass",
      );
      logAgentEvent("plan_structure_phase_advanced_for_targeted_read", {
        iteration,
        requestedToolNames: unsupportedToolCalls.map((call) => call.name).slice(0, 8),
        previousPhase: "explore_structure",
        nextPhase: "grounding",
      });
    }
  }

  const toolProtocolStreamClear = resolveToolProtocolStreamClearDecision({
    toolCallCount: effectiveToolCalls.length,
    streamText,
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    visibleAssistantText,
  });
  if (toolProtocolStreamClear.shouldClear) {
    if (!toolProtocolStreamClear.preserveScopedPlanVisibleText) {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    }
    logAgentEvent("tool_protocol_stream_cleared", {
      iteration,
      toolCalls: effectiveToolCalls.length,
      narrationInjected: visibleAssistantText.trim().length > 0,
      preservedVisibleText:
        toolProtocolStreamClear.preserveScopedPlanVisibleText,
      workflowMode,
      turnIntent,
    });
  }

  const historyAssistantText = visibleAssistantText || "";
  if (
    shouldTrackAssistantCheckpoint({
      historyAssistantText,
      runtimeNarrationInjected,
    })
  ) {
    evidenceRuntimeState = setLastAssistantTextForCheckpointRuntimeState(
      evidenceRuntimeState,
      historyAssistantText,
    );
  }

  const autoContinueNonBlockingPlanChoices =
    shouldAutoContinueNonBlockingPlanChoices({
      suppressPlanContinuationReplyOptions:
        input.suppressPlanContinuationReplyOptions,
      toolCallCount: effectiveToolCalls.length,
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      hasSubstantivePlanAssistantText,
    });
  if (
    input.suppressPlanContinuationReplyOptions &&
    hasSubstantivePlanAssistantText &&
    effectiveToolCalls.length === 0 &&
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved()
  ) {
    logAgentEvent("plan_non_blocking_options_stripped_candidate_preserved", {
      iteration,
      replyOptions: normalized.replyOptions.length,
      visibleChars: input.sourceVisibleText.length,
      planRuntimePhase: planRuntimeState.planRuntimePhase,
    });
  }
  const closedPlanReadOnlyContinuation = resolveClosedPlanReadOnlyContinuation({
    suppressPlanContinuationReplyOptions:
      input.suppressPlanContinuationReplyOptions,
    replyOptions: normalized.replyOptions,
    toolCallCount: effectiveToolCalls.length,
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    availableToolCount: input.availableToolNames.size,
    planRuntimePhase: planRuntimeState.planRuntimePhase,
    targetedRecoveryPasses: Math.max(
      planRuntimeState.planEvidenceRecoveryPasses,
      planRuntimeState.planReasoningOnlyRecoveryPasses,
    ),
  });
  if (closedPlanReadOnlyContinuation.action === "targeted_evidence") {
    logAgentEvent("plan_closed_tool_surface_read_recovery", {
      iteration,
      previousPhase: planRuntimeState.planRuntimePhase,
      availableToolCount: input.availableToolNames.size,
      replyOptions: normalized.replyOptions.length,
      recoveryReason: closedPlanReadOnlyContinuation.reason || null,
      targetedRecoveryPasses: Math.max(
        planRuntimeState.planEvidenceRecoveryPasses,
        planRuntimeState.planReasoningOnlyRecoveryPasses,
      ),
    });
    const nonBlockingHistoryText = serializeAssistantReplyForHistory(
      historyAssistantText,
      [],
    );
    if (nonBlockingHistoryText.trim()) {
      callbacks.appendMessage(
        buildAssistantHistoryMessage(
          nonBlockingHistoryText,
          input.providerReasoningForHistory,
        ),
      );
    }
    planRuntimeState = applyPlanEvidenceRecoveryRuntimeState(planRuntimeState, {
      // Opening the tool surface is not evidence. Count only completed
      // deterministic recovery batches; valid later windows must remain legal.
      planEvidenceRecoveryPasses: planRuntimeState.planEvidenceRecoveryPasses,
      planEvidenceRecoveryObjective: "model_draft",
    });
    setPlanRuntimePhaseAndSync(
      "needs_evidence",
      closedPlanReadOnlyContinuation.reason || "closed plan tool surface requires scoped evidence",
    );
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildPlanTargetedEvidenceRecoveryPrompt({
        language: MODEL_CONTROL_LANGUAGE,
        reason: closedPlanReadOnlyContinuation.reason,
        trigger: "closed_read_request",
      }),
    });
    return finishControl("continue");
  }
  if (closedPlanReadOnlyContinuation.action === "defer") {
    logAgentEvent("plan_closed_tool_surface_read_recovery_exhausted", {
      iteration,
      previousPhase: planRuntimeState.planRuntimePhase,
      availableToolCount: input.availableToolNames.size,
      replyOptions: normalized.replyOptions.length,
      recoveryReason: closedPlanReadOnlyContinuation.reason || null,
    });
  }
  if (autoContinueNonBlockingPlanChoices && closedPlanReadOnlyContinuation.action !== "defer") {
    const loopDecision = resolveNonBlockingPlanChoiceLoop({
      consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
      maxAutoContinues: MAX_NO_ACTION_RETRIES,
    });
    noToolRuntimeState =
      incrementConsecutiveNoToolRuntimeState(noToolRuntimeState);
    if (loopDecision.action === "force_finalize") {
      logAgentEvent("plan_non_blocking_choice_auto_continue_limit", {
        iteration,
        consecutiveNoToolCount: loopDecision.nextConsecutiveNoToolCount,
        maxAutoContinues: MAX_NO_ACTION_RETRIES,
        optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
        workflowMode,
        turnIntent,
        action: "force_plan_finalization",
      });
      noToolRuntimeState =
        resetConsecutiveNoToolRuntimeState(noToolRuntimeState);
      setPlanRuntimePhaseAndSync(
        "drafting",
        "non-blocking choice loop forced plan finalization",
      );
    }
    logAgentEvent("plan_non_blocking_choice_auto_continue", {
      iteration,
      consecutiveNoToolCount: loopDecision.nextConsecutiveNoToolCount,
      replyOptions: normalized.replyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
      visibleChars: normalized.visibleText.length,
      workflowMode,
      turnIntent,
    });
    const nonBlockingHistoryText = serializeAssistantReplyForHistory(
      historyAssistantText,
      [],
    );
    if (nonBlockingHistoryText.trim()) {
      callbacks.appendMessage(
        buildAssistantHistoryMessage(
          nonBlockingHistoryText,
          input.providerReasoningForHistory,
        ),
      );
    }
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content:
        loopDecision.action === "force_finalize"
          ? "The runtime resolved the repeated non-blocking options automatically. Complete planning now: call exactly one targeted read-only tool only if evidence is missing; otherwise output the complete reviewable `<proposed_plan>`. Do not emit more options or ask whether to continue; MAIN runtime owns the plan artifact."
          : "MAIN treated the previous non-blocking plan options as permission to continue planning: do not ask whether to start exploration or provide paths again; immediately call one specific read/search tool for the missing evidence. If evidence is sufficient, output the complete reviewable `<proposed_plan>`; MAIN runtime owns the plan artifact.",
    });
    return finishControl("continue");
  }

  const assistantReplyOptionRouting = resolveAssistantReplyOptionRouting({
    rawFinalReplyOptions: input.rawFinalReplyOptions,
    finalReplyOptions,
    toolCallCount: effectiveToolCalls.length,
    workflowMode,
    hasStructuredProposal: input.hasStructuredProposal,
    hasReadyPlanArtifacts: input.hasReadyPlanArtifacts,
    isPlanApproved: callbacks.getIsPlanApproved(),
    forcePause: normalized.hasExplicitUserChoiceRequest,
    finishReason: normalized.finishReason,
  });
  const { hasExecutablePlanProposalOptions, shouldPauseForUserChoice } =
    assistantReplyOptionRouting;

  if (!shouldHideApprovedPlanNoToolText) {
    callbacks.onTurnSummaryReady(visibleAssistantText);
  }

  if (normalized.hiddenThought) {
    callbacks.onThought(normalized.hiddenThought);
  }

  const toolProgressPresentation = resolveToolProgressPresentation({
    progressEligibleToolCallCount: progressEligibleToolCalls.length,
    finalReplyOptionCount: finalReplyOptions.length,
    hasSubstantivePlanAssistantText,
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    runtimeNarrationInjected,
    visibleAssistantText,
    shouldSuppressApprovedPlanNoToolText,
  });
  const {
    shouldRenderToolProgress,
    shouldPreserveApprovedExecutionText,
  } = toolProgressPresentation;
  if (
    !shouldHideApprovedPlanNoToolText &&
    (visibleAssistantText || finalReplyOptions.length > 0)
  ) {
    callbacks.onAssistantFinalText(visibleAssistantText, finalReplyOptions, {
      hasToolCalls: effectiveToolCalls.length > 0,
      visibility: toolProgressPresentation.visibility,
      preserveAssistantText: shouldPreserveApprovedExecutionText,
      capsuleCandidate: toolProgressPresentation.capsuleCandidate,
      modelAuthored: toolProgressPresentation.modelAuthored,
      progress: shouldRenderToolProgress ? toolActionNarration || undefined : undefined,
      awaitingInput: shouldPauseForUserChoice,
      hiddenThought: normalized.hiddenThought,
      toolCalls: progressEligibleToolCalls.map((call) => {
        const args = parseToolCallArguments(call, workspace);
        return {
          id: call.id,
          name: call.name,
          target: getToolTarget(call.name, args),
        };
      }),
    });
  }

  if (input.autoContinueReadOnlyPermission) {
    noToolRuntimeState =
      incrementConsecutiveNoToolRuntimeState(noToolRuntimeState);
    logAgentEvent("readonly_permission_auto_continue", {
      iteration,
      consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
      visibleChars: normalized.visibleText.length,
      strippedVisibleChars: input.finalVisibleText.length,
    });
    if (
      noToolRuntimeState.consecutiveNoToolCount >=
      (input.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)
    ) {
      logAgentEvent("readonly_permission_auto_continue_limit", {
        iteration,
        consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
        workflowMode,
        turnIntent,
        runtimeIntent,
        usedHardRecovery:
          recoveryPromptState.usedReadOnlyPermissionHardRecoveryPrompt,
      });
      if (!recoveryPromptState.usedReadOnlyPermissionHardRecoveryPrompt) {
        recoveryPromptState =
          markReadOnlyPermissionHardRecoveryPromptUsed(recoveryPromptState);
        noToolRuntimeState =
          resetConsecutiveNoToolRuntimeState(noToolRuntimeState);
        if (historyAssistantText.trim()) {
          callbacks.appendMessage(
            buildAssistantHistoryMessage(
              historyAssistantText,
              input.providerReasoningForHistory,
            ),
          );
        }
        callbacks.onStatusChange("running");
        callbacks.appendMessage({
          role: "user",
          content: buildReadOnlyPermissionHardRecoveryPrompt(
            MODEL_CONTROL_LANGUAGE,
            workflowMode,
          ),
        });
        return finishControl("continue");
      }
      callbacks.onNonActionableStop(
        callbacks.getPreferredLanguage() === "zh"
          ? "本轮已暂停：模型在只读许可已授予后仍没有产生有效工具动作。恢复时请直接使用一个未缓存的定向工具调用，或基于已缓存内容继续写入/验证。"
          : "This turn is paused: after read-only permission was granted, the model still did not produce useful tool action. Resume with one uncached targeted tool call, or continue from cached content with write/validation.",
        workflowMode === "plan" ? "incomplete_plan" : "no_action",
      );
      callbacks.onStatusChange("idle");
      return finishControl("stopped");
    }

    if (historyAssistantText.trim()) {
      callbacks.appendMessage(
        buildAssistantHistoryMessage(
          historyAssistantText,
          input.providerReasoningForHistory,
        ),
      );
    }
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildReadOnlyPermissionContinuationPrompt(
        MODEL_CONTROL_LANGUAGE,
        {
          allowFileRead: input.availableToolNames.has("read_file"),
        },
      ),
    });
    return finishControl("continue");
  }

  if (workflowMode === "plan" && effectiveToolCalls.length > 0) {
    planRuntimeState = markPlanModeToolActivity(planRuntimeState);
  }

  const assistantHistoryText = serializeAssistantReplyForHistory(
    historyAssistantText,
    finalReplyOptions,
  );
  const hasMeaningfulVisibleText = visibleAssistantText.trim().length > 0;
  const wasTruncated = normalized.finishReason === "length";
  if (
    wasTruncated &&
    normalized.replyOptions.length === 0 &&
    effectiveToolCalls.length === 0
  ) {
    const diagMsg =
      callbacks.getPreferredLanguage() === "zh"
        ? `[System: 上一条回复因长度被截断。上下文可能已接近上限。请基于已有上下文直接行动，不要输出长段落或重复读取文件。如果已掌握足够信息，直接执行写入、验证或给出最终结论。]`
        : `[System: Response was truncated due to length. Context is likely near the limit. Act on what you already know — do not output long prose or re-read files. If you have enough information, execute writes, run validation, or give the final conclusion now.]`;
    callbacks.appendMessage({ role: "system", content: diagMsg });
  }

  const hiddenThoughtOnlyNoToolStop = isHiddenThoughtOnlyNoToolStop({
    toolCallCount: effectiveToolCalls.length,
    replyOptionCount: finalReplyOptions.length,
    hasMeaningfulVisibleText,
    hiddenThought: normalized.hiddenThought,
  });
  if (effectiveToolCalls.length > 0) {
    approvedPlanRecoveryState =
      resetApprovedPlanLongReasoningNoActionCount(approvedPlanRecoveryState);
  }

  logAgentEvent("normalized_turn", {
    iteration,
    visibleChars: normalized.visibleText.length,
    hiddenThoughtChars: normalized.hiddenThought.length,
    replyOptions: normalized.replyOptions.length,
    toolCalls: effectiveToolCalls.length,
    finishReason: normalized.finishReason || "unknown",
    hasStructuredProposal: input.hasStructuredProposal,
    planStage: input.currentPlanStageForReview,
    isPlanApproved: callbacks.getIsPlanApproved(),
  });

  if (finalReplyOptions.length > 0 && !shouldPauseForUserChoice) {
    logAgentEvent("reply_options_rejected", {
      iteration,
      reason: wasTruncated
        ? "truncated_inferred_options"
        : "non_pauseable_options",
      replyOptions: finalReplyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
      finishReason: normalized.finishReason || "unknown",
      workflowMode,
      turnIntent,
    });
  }

  const planPostConvergenceToolRedirect =
    handlePlanPostConvergenceToolRedirect({
      callbacks,
      iteration,
      workflowMode,
      availableToolNames: input.availableToolNames,
      effectiveToolCalls,
      isAllowedUnapprovedPlanDraftMutationCall,
      hasPlanDecisionOutput:
        input.hasStructuredProposal ||
        finalReplyOptions.length > 0 ||
        input.hasReviewablePlanArtifacts,
      turnInputContextSignals: input.turnInputContextSignals,
      recentPlanToolActivity: input.recentPlanToolActivity,
      lastAssistantTextForCheckpoint:
        evidenceRuntimeState.lastAssistantTextForCheckpoint,
      visibleAssistantText,
      assistantHistoryText,
      providerReasoningForHistory: input.providerReasoningForHistory,
      assistantMsgId,
      ...planRuntimeState,
      latestUserPromptText: input.latestUserPromptText,
      setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
    });
  planRuntimeState = applyPlanPostConvergenceRuntimeState(
    planRuntimeState,
    planPostConvergenceToolRedirect,
  );
  if (planPostConvergenceToolRedirect.status === "continue") {
    return finishControl("continue");
  }
  if (planPostConvergenceToolRedirect.status === "stopped") {
    return finishControl("stopped");
  }

  return {
    status: "completed",
    noToolRuntimeState,
    planRuntimeState,
    approvedPlanRecoveryState,
    evidenceRuntimeState,
    recoveryPromptState,
    shouldPauseForUserChoice,
    shouldSuppressApprovedPlanNoToolText,
    approvedPlanAuditForNoTool,
    rejectedCompletionClaim,
    wasTruncated,
    historyAssistantText,
    assistantHistoryText,
    hasExecutablePlanProposalOptions,
    hasMeaningfulVisibleText,
    visibleAssistantText,
    hiddenThoughtOnlyNoToolStop,
  };
}
