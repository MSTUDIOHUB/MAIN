import type { MainModeKey } from "../../mainModes";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type { EffectiveTurnContract } from "../../runIntent";
import { logAgentEvent } from "../../orchestrator";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import type { MainThreadEventInput } from "../../turnEvents";
import type {
  NormalizedStreamState,
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
  PlanTaskEvidenceAudit,
  ReplyOption,
} from "../../workflowModels";
import type { OrchestratorCallbacks, ToolCallToExecute } from "../types";
import { handleApprovedPlanFinalization } from "./approvedPlanFinalization";
import type { ProviderReasoningForHistory } from "./assistantResponseProcessing";
import { handleExecuteNoToolRecovery } from "./executeNoToolRecovery";
import { handleFinalNoToolAssistantTurn, handleReplyOptionsPause } from "./finalTurnCompletion";
import { handleMissingToolNoToolRecovery } from "./missingToolNoToolRecovery";
import type { AgentLoopNoToolRuntimeState } from "./noToolRuntimeState";
import {
  applyConsecutiveNoToolRuntimeState,
  applyRecoveringFromEmptyAssistantReplyRuntimeState,
} from "./noToolRuntimeState";
import { handlePlanNoToolRecovery } from "./planNoToolRecovery";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import { applyPlanNoToolRuntimeState, applyPlanRuntimePhase } from "./planRuntimeState";
import type { TurnIterationContext } from "./turnIterationContext";
import { joinPendingSubagentsForParent } from "./subagentJoinRuntime";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import type { ExecuteRecoveryMode } from "../../executeRecoveryTools";
import { resolvePreCompletionEvidenceRecoveryDecision } from "./preCompletionEvidenceRecovery";
import { resolveCommandEvidenceRequirements } from "../../verificationEvidence";
import { isWorkspaceMutationToolName } from "../../workspaceMutationTools";

type WorkflowMode = "chat" | "edit" | "plan";

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

type EmitPlanExecutionProgress = (
  phase: PlanExecutionProgressPhase,
  overrides?: Partial<PlanExecutionProgressUpdate>,
) => void;

export type AssistantCompletionPhaseResult = {
  status: "completed" | "continue" | "stopped";
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
};

export function resolveValidationMutationReopen(input: {
  recoveryState: ExecuteRecoveryRuntimeState;
  protocolViolation?: NormalizedStreamState["protocolViolation"];
  protocolActualTools?: string[];
}): { requestedTools: string[] } | null {
  const validationActive =
    input.recoveryState.mode === "validation_only" ||
    input.recoveryState.mode === "finite_validation_only" ||
    input.recoveryState.decisionCheckpoint?.nextRequiredCapability === "validation";
  if (!validationActive) return null;
  if (
    input.protocolViolation !== "required_tool_call_not_available" &&
    input.protocolViolation !== "required_function_call_mismatch"
  ) return null;

  const requestedTools = [...new Set((input.protocolActualTools || [])
    .filter((name) => isWorkspaceMutationToolName(name)))];
  if (requestedTools.length === 0) return null;

  // One recovery activation establishes mutation -> validation. A single
  // reopen is allowed when the model explicitly reports that more mutation is
  // needed. A second reopen would indicate semantic no-progress and must be
  // handled by the bounded checkpoint instead of oscillating forever.
  if (input.recoveryState.attempts > 1) return null;
  return { requestedTools };
}

export async function handleAssistantCompletionPhase(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  iteration: number;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  effectiveTurnContract: EffectiveTurnContract | null;
  mainModeKey?: MainModeKey;
  commandDirectiveAction?: string | null;
  workspace: string;
  latestUserPromptText: string;
  forceXmlTools: boolean;
  availableToolNames: Set<string>;
  effectiveToolCalls: ToolCallToExecute[];
  finalReplyOptions: ReplyOption[];
  shouldPauseForUserChoice: boolean;
  shouldSuppressApprovedPlanNoToolText: boolean;
  hasStructuredProposal: boolean;
  currentPlanStageForReview: ReturnType<OrchestratorCallbacks["getPlanStage"]>;
  approvedPlanAuditForNoTool: PlanTaskEvidenceAudit | null;
  rejectedCompletionClaim: boolean;
  wasTruncated: boolean;
  sawExecuteOperationEvidence: boolean;
  normalized: NormalizedStreamState;
  streamText: string;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  sourceVisibleText: string;
  assistantHistoryText: string;
  providerReasoningForHistory: ProviderReasoningForHistory;
  assistantMsgId: string;
  hasReviewablePlanArtifacts: boolean;
  hasExecutablePlanProposalOptions: boolean;
  planReplyOptionsRoutedToArtifact: boolean;
  hasMeaningfulVisibleText: boolean;
  visibleAssistantText: string;
  userVisibleText: string;
  compactedProseCodeDump: boolean;
  hiddenThoughtOnlyNoToolStop: boolean;
  recentSuccessfulProjectWrite?: {
    name?: string | null;
    target?: string | null;
  } | null;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
  turnInputContextSignals: Parameters<typeof handlePlanNoToolRecovery>[0]["turnInputContextSignals"];
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  unityConsoleDiagnosticsRequested: boolean;
  unityConsoleFinalVerificationRequired: boolean;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTurnCompletedEvent: () => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
  setPlanRuntimePhase: Parameters<typeof handlePlanNoToolRecovery>[0]["setPlanRuntimePhase"];
  waitForPlanApprovalIfNeeded: Parameters<typeof handlePlanNoToolRecovery>[0]["waitForPlanApprovalIfNeeded"];
  tryClosePlanWithEvidence: Parameters<typeof handlePlanNoToolRecovery>[0]["tryClosePlanWithEvidence"];
  getExecuteRecoveryState: () => ExecuteRecoveryRuntimeState;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => void;
}): Promise<AssistantCompletionPhaseResult> {
  let noToolRuntimeState = input.noToolRuntimeState;
  let planRuntimeState = input.planRuntimeState;
  const effectiveToolCallCount = input.effectiveToolCalls.length;
  const completion = {
    assistantHistoryText: input.assistantHistoryText,
    providerReasoningForHistory: input.providerReasoningForHistory,
    assistantMsgId: input.assistantMsgId,
    iterationContext: input.iterationContext,
    emitTurnEvent: input.emitTurnEvent,
    emitTurnCompletedEvent: input.emitTurnCompletedEvent,
  };

  if (
    effectiveToolCallCount === 0 &&
    await joinPendingSubagentsForParent({
      callbacks: input.callbacks,
      recentToolActivity: input.recentToolActivity,
      recentPlanToolActivity: input.recentPlanToolActivity,
      reason: "parent_final_response",
    })
  ) {
    input.callbacks.onStatusChange("running");
    return finish("continue");
  }

  const replyOptionsPause = handleReplyOptionsPause({
    callbacks: input.callbacks,
    iteration: input.iteration,
    shouldPauseForUserChoice: input.shouldPauseForUserChoice,
    shouldSuppressApprovedPlanNoToolText: input.shouldSuppressApprovedPlanNoToolText,
    replyOptions: input.finalReplyOptions,
    effectiveToolCallCount,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    hasStructuredProposal: input.hasStructuredProposal,
    planStage: input.currentPlanStageForReview,
    isPlanApproved: input.callbacks.getIsPlanApproved(),
    completion,
  });
  if (replyOptionsPause.status === "stopped") {
    return finish("stopped");
  }

  if (effectiveToolCallCount > 0) {
    return finish("completed");
  }

  // Runtime evidence owns the next action before any prose-based missing-tool
  // heuristic. A completion-looking sentence cannot redirect a known ledger
  // gap into a generic reprompt or end the turn.
  const externalReviewIsAdvisory = Boolean(
    input.callbacks.getIsPlanApproved() &&
    input.approvedPlanAuditForNoTool?.acceptedCompletion &&
    input.approvedPlanAuditForNoTool.pendingExternalValidation
  );
  const currentExecuteRecoveryState = input.getExecuteRecoveryState();
  const preCompletionRecovery = resolvePreCompletionEvidenceRecoveryDecision({
    ledger: input.callbacks.getPlanExecutionEvidenceLedger(),
    // Manual/user review remains an advisory conclusion. It never turns off
    // the independent post-mutation automatic validation contract.
    validationExpected: input.effectiveTurnContract?.validationExpected === true,
    mutationExpected: input.effectiveTurnContract?.mutationExpected === true,
    transactionId: input.iterationContext.eventTurnId,
    requiredCommandEvidence: resolveCommandEvidenceRequirements({
      tasks: input.callbacks.getIsPlanApproved()
        ? input.callbacks.getPlanTasks()
        : [],
      commandDirective: input.callbacks.getCommandDirective?.() || null,
    }),
    currentRecoveryMode: currentExecuteRecoveryState.mode,
    currentRequiredCapability:
      currentExecuteRecoveryState.decisionCheckpoint?.nextRequiredCapability || null,
    availableToolNames: input.availableToolNames,
  });
  if (preCompletionRecovery) {
    input.callbacks.onStreamToken("__ESCALATION_RESET__:evidence_recovery", input.assistantMsgId);
    input.activateExecuteRecovery(
      preCompletionRecovery.mode,
      preCompletionRecovery.reason,
      {
        expectedTarget: preCompletionRecovery.expectedTarget,
        evidenceGap: preCompletionRecovery.gap,
        nextRequiredCapability: preCompletionRecovery.nextRequiredCapability,
        decisionCheckpoint: {
          expectedTarget: preCompletionRecovery.expectedTarget,
          sourceObservationKey: null,
          nextRequiredCapability: preCompletionRecovery.nextRequiredCapability,
        },
        source: "precompletion_evidence_audit",
      },
    );
    const nextState = input.getExecuteRecoveryState();
    input.callbacks.onStatusChange("running");
    const language = input.callbacks.getPreferredLanguage();
    input.callbacks.appendMessage({
      role: "system",
      content: language === "zh"
        ? `[System: 最终结论暂存，尚未提交。执行证据缺口为 ${preCompletionRecovery.gap}；下一步必须调用 ${preCompletionRecovery.nextRequiredCapability} 能力取得真实证据，再重新核对完成条件。]`
        : `[System: The final conclusion is being held as a draft. The execution-evidence gap is ${preCompletionRecovery.gap}; next call the ${preCompletionRecovery.nextRequiredCapability} capability, collect real evidence, and re-audit completion.]`,
    });
    logAgentEvent("precompletion_evidence_recovery_activated", {
      iteration: input.iteration,
      gap: preCompletionRecovery.gap,
      recoveryMode: nextState.mode,
      expectedTarget: nextState.expectedTarget,
      nextRequiredCapability: preCompletionRecovery.nextRequiredCapability,
      draftChars: input.visibleAssistantText.length,
      validationExpected: input.effectiveTurnContract?.validationExpected === true,
      mutationExpected: input.effectiveTurnContract?.mutationExpected === true,
      externalReviewIsAdvisory,
    });
    return finish("continue");
  }

  const validationMutationReopen = resolveValidationMutationReopen({
    recoveryState: currentExecuteRecoveryState,
    protocolViolation: input.normalized.protocolViolation,
    protocolActualTools: input.normalized.protocolActualTools,
  });
  if (validationMutationReopen) {
    const currentCheckpoint = currentExecuteRecoveryState.decisionCheckpoint;
    input.callbacks.onStreamToken("__ESCALATION_RESET__:validation_mutation_reopen", input.assistantMsgId);
    input.activateExecuteRecovery(
      "mutation_first",
      "validation_followup_mutation_requested",
      {
        expectedTarget: currentExecuteRecoveryState.expectedTarget,
        sourceObservationKey: currentExecuteRecoveryState.sourceObservationKey,
        decisionCheckpoint: {
          expectedTarget: currentExecuteRecoveryState.expectedTarget,
          sourceObservationKey: currentExecuteRecoveryState.sourceObservationKey,
          nextRequiredCapability: "mutation",
          ...(currentCheckpoint?.evidenceVersion
            ? { evidenceVersion: currentCheckpoint.evidenceVersion }
            : {}),
          ...(currentCheckpoint?.planTaskId
            ? { planTaskId: currentCheckpoint.planTaskId }
            : {}),
          ...(currentCheckpoint?.requirementRef
            ? { requirementRef: currentCheckpoint.requirementRef }
            : {}),
          ...(currentCheckpoint?.pendingFiniteValidation
            ? { pendingFiniteValidation: currentCheckpoint.pendingFiniteValidation }
            : {}),
        },
        source: "validation_requested_followup_mutation",
      },
    );
    input.callbacks.onStatusChange("running");
    const requestExcerpt = input.latestUserPromptText.replace(/\s+/g, " ").trim().slice(0, 800);
    input.callbacks.appendMessage({
      role: "system",
      content: [
        "VALIDATION_MUTATION_REOPEN: The validation checkpoint is retained, but the mutation surface has been reopened once because the previous response explicitly requested a workspace edit tool.",
        `Requested edit tools: ${validationMutationReopen.requestedTools.join(", ")}.`,
        requestExcerpt ? `Original turn objective: ${requestExcerpt}` : "",
        "Make only the remaining task-relevant edit. Do not substitute a cosmetic or nearby change for an unresolved requested outcome. The retained finite validation will run after the mutation.",
      ].filter(Boolean).join("\n"),
    });
    logAgentEvent("validation_mutation_surface_reopened", {
      iteration: input.iteration,
      requestedTools: validationMutationReopen.requestedTools,
      expectedTarget: currentExecuteRecoveryState.expectedTarget,
      recoveryAttempts: currentExecuteRecoveryState.attempts,
      pendingFiniteValidation: currentCheckpoint?.pendingFiniteValidation || null,
    });
    return finish("continue");
  }

  // Transport errors must be observable before an active evidence contract
  // sends the next identical request. Keep generic prose/XML recovery out of
  // the evidence transaction; the contract already owns its next capability.
  const executeNoToolRecovery = handleExecuteNoToolRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    runtimeIntent: input.runtimeIntent,
    forceXmlTools: input.forceXmlTools,
    availableToolNames: input.availableToolNames,
    effectiveToolCallCount,
    finalReplyOptionsCount: input.finalReplyOptions.length,
    shouldPauseForUserChoice: input.shouldPauseForUserChoice,
    sawExecuteOperationEvidence: input.sawExecuteOperationEvidence,
    visibleText: input.visibleAssistantText || input.userVisibleText,
    protocolViolation: input.normalized.protocolViolation,
    protocolViolationOnly: currentExecuteRecoveryState.mode !== "normal",
    assistantMsgId: input.assistantMsgId,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
  });
  noToolRuntimeState = applyConsecutiveNoToolRuntimeState(
    noToolRuntimeState,
    executeNoToolRecovery,
  );
  if (executeNoToolRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (executeNoToolRecovery.status === "continue") {
    return finish("continue");
  }

  if (currentExecuteRecoveryState.mode !== "normal") {
    // The active recovery transaction still owns the next capability. The
    // resolver deliberately does not reactivate an existing transaction, but
    // that must never be interpreted as evidence closure or permission to
    // publish the held final draft.
    input.callbacks.onStreamToken("__ESCALATION_RESET__:evidence_recovery", input.assistantMsgId);
    input.callbacks.onStatusChange("running");
    logAgentEvent("precompletion_evidence_recovery_still_active", {
      iteration: input.iteration,
      recoveryMode: currentExecuteRecoveryState.mode,
      expectedTarget: currentExecuteRecoveryState.expectedTarget,
      nextRequiredCapability: currentExecuteRecoveryState.decisionCheckpoint?.nextRequiredCapability || null,
    });
    return finish("continue");
  }

  const setPlanRuntimePhaseAndSync: typeof input.setPlanRuntimePhase = (
    phase,
    reason,
    status,
    qualitySnapshot,
  ) => {
    input.setPlanRuntimePhase(phase, reason, status, qualitySnapshot);
    planRuntimeState = applyPlanRuntimePhase({
      ...planRuntimeState,
      ...(qualitySnapshot?.qualityRejectCount != null
        ? { planQualityRejectCount: qualitySnapshot.qualityRejectCount }
        : {}),
      ...(qualitySnapshot?.missingSections
        ? { planLastMissingSections: [...qualitySnapshot.missingSections] }
        : {}),
    }, { phase, reason }).state;
  };
  const planNoToolRecovery = await handlePlanNoToolRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    commandDirectiveAction: input.commandDirectiveAction,
    workspace: input.workspace,
    latestUserPromptText: input.latestUserPromptText,
    streamText: input.streamText,
    sourceVisibleText: input.sourceVisibleText,
    assistantHistoryText: input.assistantHistoryText,
    providerReasoningForHistory: input.providerReasoningForHistory,
    hasStructuredProposal: input.hasStructuredProposal,
    hasReviewablePlanArtifacts: input.hasReviewablePlanArtifacts,
    wasTruncated: input.wasTruncated,
    hasExecutablePlanProposalOptions: input.hasExecutablePlanProposalOptions,
    planReplyOptionsRoutedToArtifact: input.planReplyOptionsRoutedToArtifact,
    finalReplyOptionsCount: input.finalReplyOptions.length,
    effectiveToolCallCount,
    hasMeaningfulVisibleText: input.hasMeaningfulVisibleText,
    normalizedVisibleText: input.normalized.visibleText,
    normalizedFinishReason: input.normalized.finishReason,
    recentPlanToolActivity: input.recentPlanToolActivity,
    attemptedPlanWriteTargets: input.attemptedPlanWriteTargets,
    turnInputContextSignals: input.turnInputContextSignals,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
    ...planRuntimeState,
    setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
    waitForPlanApprovalIfNeeded: input.waitForPlanApprovalIfNeeded,
    tryClosePlanWithEvidence: input.tryClosePlanWithEvidence,
  });
  noToolRuntimeState = applyConsecutiveNoToolRuntimeState(
    noToolRuntimeState,
    planNoToolRecovery,
  );
  planRuntimeState = applyPlanNoToolRuntimeState(
    planRuntimeState,
    planNoToolRecovery,
  );
  if (planNoToolRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (planNoToolRecovery.status === "continue") {
    return finish("continue");
  }

  const missingToolNoToolRecovery = handleMissingToolNoToolRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    runtimeIntent: input.runtimeIntent,
    mainModeKey: input.mainModeKey,
    hasMeaningfulVisibleText: input.hasMeaningfulVisibleText,
    compactedProseCodeDump: input.compactedProseCodeDump,
    wasTruncated: input.wasTruncated,
    normalizedFinishReason: input.normalized.finishReason,
    normalizedToolCallCount: input.normalized.toolCalls.length,
    visibleText: input.normalized.visibleText,
    visibleFallbackText: input.visibleAssistantText || input.userVisibleText,
    assistantMsgId: input.assistantMsgId,
    hiddenThoughtOnlyNoToolStop: input.hiddenThoughtOnlyNoToolStop,
    recentSuccessfulProjectWrite: input.recentSuccessfulProjectWrite,
    recoveringFromEmptyAssistantReplyAfterWrite:
      input.recoveringFromEmptyAssistantReplyAfterWrite,
    recentToolActivity: input.recentToolActivity,
    sawExecuteOperationEvidence: input.sawExecuteOperationEvidence,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
  });
  noToolRuntimeState = applyConsecutiveNoToolRuntimeState(
    noToolRuntimeState,
    missingToolNoToolRecovery,
  );
  noToolRuntimeState = applyRecoveringFromEmptyAssistantReplyRuntimeState(
    noToolRuntimeState,
    missingToolNoToolRecovery,
  );
  if (missingToolNoToolRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (missingToolNoToolRecovery.status === "continue") {
    return finish("continue");
  }

  if (
    input.unityConsoleDiagnosticsRequested &&
    input.unityConsoleFinalVerificationRequired
  ) {
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: input.callbacks.getPreferredLanguage() === "zh"
        ? "在输出最终结论前，必须先完成一次最终验证：先调用 refresh_unity，再调用 read_console。完成这一次验证后再给结论，不要重复多轮验证。"
        : "Before giving the final conclusion, run one final verification pass: call refresh_unity first, then read_console. After this single verification pass, provide the conclusion without repeating more verification loops.",
    });
    return finish("continue");
  }

  const approvedPlanFinalization = handleApprovedPlanFinalization({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    iteration: input.iteration,
    approvedPlanAuditForNoTool: input.approvedPlanAuditForNoTool,
    rejectedCompletionClaim: input.rejectedCompletionClaim,
    availableToolNames: input.availableToolNames,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
    emitPlanExecutionProgress: input.emitPlanExecutionProgress,
    executeRecoveryState: input.getExecuteRecoveryState(),
  });
  noToolRuntimeState = applyConsecutiveNoToolRuntimeState(
    noToolRuntimeState,
    approvedPlanFinalization,
  );
  if (approvedPlanFinalization.status === "stopped") {
    return finish("stopped");
  }
  if (approvedPlanFinalization.status === "continue") {
    return finish("continue");
  }

  input.callbacks.onStreamToken("__EVIDENCE_DRAFT_COMMIT__:evidence_closed", input.assistantMsgId);
  const finalNoToolAssistantTurn = handleFinalNoToolAssistantTurn({
    callbacks: input.callbacks,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    isPlanApproved: input.callbacks.getIsPlanApproved(),
    normalizedVisibleChars: input.normalized.visibleText.length,
    normalizedReplyOptionCount: input.normalized.replyOptions.length,
    completion,
  });
  if (finalNoToolAssistantTurn.status === "stopped") {
    return finish("stopped");
  }

  return finish("completed");

  function finish(
    status: AssistantCompletionPhaseResult["status"],
  ): AssistantCompletionPhaseResult {
    return {
      status,
      noToolRuntimeState,
      planRuntimeState,
    };
  }
}
