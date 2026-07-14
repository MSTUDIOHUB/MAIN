import {
  buildPlanAutoScaffoldPrompt,
  buildPlanClosureEvidenceRecoveryPrompt,
  buildPlanPostConvergenceToolRedirectPrompt,
  buildPlanReadOnlyConvergencePrompt,
} from "../../orchestrator/planOrchestration";
import {
  assessPlanEvidenceReadiness,
  shouldTriggerPlanReadOnlyConvergence,
} from "../../planReadOnlyConvergence";
import {
  buildPlanTargetedEvidenceRecoveryPrompt,
  resolvePlanSuppressedToolRecovery,
  shouldRedirectPlanRuntimeToolsAfterReadOnlyConvergence,
  type PlanRuntimeMode,
} from "../../planRuntime";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import type { StreamResult } from "../../streaming";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanRuntimePhase } from "../../workflowModels";
import { assessPlanClosureEvidence } from "../../planEvidence";
import {
  buildAssistantHistoryMessage,
  collectPlanClosureMaterializationInput,
  getOriginalUserPromptForPlanFallback,
  hasPlanUserContextObservation,
  logAgentEvent,
} from "../../orchestrator";
import type { AgentMessage, OrchestratorCallbacks, ToolCallToExecute } from "../types";

export type PlanReadOnlyConvergenceResult = {
  status: "none" | "continue";
  planReadOnlyConvergenceBatches: number;
  planReadOnlyConvergenceTools: number;
  usedPlanReadOnlyConvergencePrompt: boolean;
};

export type PlanPostConvergenceToolRedirectResult = {
  status: "none" | "continue" | "stopped";
  planPostConvergenceToolRedirectCount: number;
  planDraftingRecoveryReadCount: number;
  planEvidenceRecoveryPasses: number;
  planReasoningOnlyRecoveryPasses: number;
  planAutoScaffoldPromptIssued: boolean;
};

export const MAX_PLAN_POST_CONVERGENCE_TOOL_REDIRECTS = 3;

export function handlePlanReadOnlyConvergence(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  isUnapprovedPlanReadOnlyBatch: boolean;
  hasPlanDecisionOutput: boolean;
  successfulReadOnlyExplorationResultCount: number;
  planReadOnlyConvergenceBatches: number;
  planReadOnlyConvergenceTools: number;
  usedPlanReadOnlyConvergencePrompt: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  recentPlanToolActivity: PlanToolActivitySummary[];
  lastAssistantTextForCheckpoint: string;
  setPlanRuntimePhase: (phase: PlanRuntimePhase, reason: string) => void;
}): PlanReadOnlyConvergenceResult {
  const {
    callbacks,
    iteration,
    isUnapprovedPlanReadOnlyBatch,
    hasPlanDecisionOutput,
    successfulReadOnlyExplorationResultCount,
    turnInputContextSignals,
    recentPlanToolActivity,
    lastAssistantTextForCheckpoint,
    setPlanRuntimePhase,
  } = input;

  let planReadOnlyConvergenceBatches = input.planReadOnlyConvergenceBatches;
  let planReadOnlyConvergenceTools = input.planReadOnlyConvergenceTools;
  let usedPlanReadOnlyConvergencePrompt = input.usedPlanReadOnlyConvergencePrompt;
  const userGoal = getOriginalUserPromptForPlanFallback(callbacks);

  if (isUnapprovedPlanReadOnlyBatch && !hasPlanDecisionOutput) {
    planReadOnlyConvergenceBatches += 1;
    planReadOnlyConvergenceTools += successfulReadOnlyExplorationResultCount;
  } else if (!isUnapprovedPlanReadOnlyBatch || hasPlanDecisionOutput) {
    planReadOnlyConvergenceBatches = 0;
    planReadOnlyConvergenceTools = 0;
  }

  const planEvidenceReadinessForConvergence = assessPlanEvidenceReadiness({
    userGoal,
    userContext: turnInputContextSignals,
    recentToolActivity: recentPlanToolActivity,
    hasObservedUserContext: hasPlanUserContextObservation(
      callbacks.getMessages() as AgentMessage[],
      lastAssistantTextForCheckpoint,
    ),
  });
  const shouldConvergeUnapprovedPlanReadOnly = shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch,
    hasPlanDecisionOutput,
    batchCount: planReadOnlyConvergenceBatches,
    toolCount: planReadOnlyConvergenceTools,
    userGoal,
    userContext: turnInputContextSignals,
    recentToolActivity: recentPlanToolActivity,
    hasObservedUserContext: planEvidenceReadinessForConvergence.status !== "needs_observation",
    convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
  });

  if (!shouldConvergeUnapprovedPlanReadOnly) {
    return {
      status: "none",
      planReadOnlyConvergenceBatches,
      planReadOnlyConvergenceTools,
      usedPlanReadOnlyConvergencePrompt,
    };
  }

  const language = MODEL_CONTROL_LANGUAGE;
  const convergencePhase = planEvidenceReadinessForConvergence.status === "needs_targeted_read"
    ? "needs_evidence"
    : "synthesis";
  const convergenceReason = planEvidenceReadinessForConvergence.status === "needs_targeted_read"
    ? planEvidenceReadinessForConvergence.reason
    : "targeted evidence ready";
  setPlanRuntimePhase(convergencePhase, convergenceReason);
  logAgentEvent("plan_readonly_convergence_threshold", {
    iteration,
    batches: planReadOnlyConvergenceBatches,
    tools: planReadOnlyConvergenceTools,
    imageParts: turnInputContextSignals.imageParts,
    mentionedFilePaths: turnInputContextSignals.mentionedFilePaths.length,
    attachedFilePaths: turnInputContextSignals.attachedFilePaths.length,
    promptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
    evidenceReadiness: planEvidenceReadinessForConvergence.status,
    evidenceReadinessReason: planEvidenceReadinessForConvergence.reason,
    successfulTargetedReads: planEvidenceReadinessForConvergence.successfulTargetedReads,
    successfulSearches: planEvidenceReadinessForConvergence.successfulSearches,
    semanticFacts: planEvidenceReadinessForConvergence.semanticFacts,
    changeTargets: planEvidenceReadinessForConvergence.changeTargets,
  });

  if (!usedPlanReadOnlyConvergencePrompt) {
    usedPlanReadOnlyConvergencePrompt = true;
    setPlanRuntimePhase(
      planEvidenceReadinessForConvergence.status === "needs_targeted_read" ? "needs_evidence" : "drafting",
      convergenceReason,
    );
    let convergencePrompt = buildPlanReadOnlyConvergencePrompt(
      language,
      planReadOnlyConvergenceBatches,
      planReadOnlyConvergenceTools,
      turnInputContextSignals,
    );
    if (planEvidenceReadinessForConvergence.status === "needs_targeted_read") {
      const closureInput = collectPlanClosureMaterializationInput(
        callbacks,
        recentPlanToolActivity,
        [],
        userGoal,
      );
      const closureAssessment = assessPlanClosureEvidence(closureInput.evidenceBundle);
      convergencePrompt = buildPlanClosureEvidenceRecoveryPrompt(
        language,
        planEvidenceReadinessForConvergence.reason,
        userGoal,
        {
          unresolvedContractKinds: closureAssessment.unresolvedContractKinds,
          confirmedChangeTargets: closureInput.evidenceBundle.changeTargets,
        },
      );
    }
    callbacks.appendMessage({ role: "user", content: convergencePrompt });
    return {
      status: "continue",
      planReadOnlyConvergenceBatches,
      planReadOnlyConvergenceTools,
      usedPlanReadOnlyConvergencePrompt,
    };
  }

  return {
    status: "none",
    planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools,
    usedPlanReadOnlyConvergencePrompt,
  };
}

export function handlePlanPostConvergenceToolRedirect(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  workflowMode: PlanRuntimeMode;
  availableToolNames: Set<string>;
  effectiveToolCalls: ToolCallToExecute[];
  isAllowedUnapprovedPlanDraftMutationCall: (call: ToolCallToExecute) => boolean;
  hasPlanDecisionOutput: boolean;
  usedPlanReadOnlyConvergencePrompt: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  recentPlanToolActivity: PlanToolActivitySummary[];
  lastAssistantTextForCheckpoint: string;
  visibleAssistantText: string;
  assistantHistoryText: string;
  providerReasoningForHistory: Pick<StreamResult, "reasoningContent" | "reasoningField"> | null;
  assistantMsgId: string;
  planRuntimePhase: PlanRuntimePhase;
  planPostConvergenceToolRedirectCount: number;
  planDraftingRecoveryReadCount: number;
  planReasoningOnlyRecoveryPasses: number;
  planEvidenceRecoveryPasses: number;
  planQualityRejectCount: number;
  planAutoScaffoldPromptIssued: boolean;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
  latestUserPromptText: string;
  setPlanRuntimePhase: (phase: PlanRuntimePhase, reason: string) => void;
}): PlanPostConvergenceToolRedirectResult {
  const {
    callbacks,
    iteration,
    workflowMode,
    availableToolNames,
    effectiveToolCalls,
    isAllowedUnapprovedPlanDraftMutationCall,
    hasPlanDecisionOutput,
    usedPlanReadOnlyConvergencePrompt,
    turnInputContextSignals,
    recentPlanToolActivity,
    lastAssistantTextForCheckpoint,
    visibleAssistantText,
    assistantHistoryText,
    providerReasoningForHistory,
    assistantMsgId,
    planRuntimePhase,
    planQualityRejectCount,
    planLastQualityGateReason,
    planLastMissingSections,
    latestUserPromptText,
    setPlanRuntimePhase,
  } = input;

  let planPostConvergenceToolRedirectCount = input.planPostConvergenceToolRedirectCount;
  let planDraftingRecoveryReadCount = input.planDraftingRecoveryReadCount;
  let planEvidenceRecoveryPasses = input.planEvidenceRecoveryPasses;
  let planReasoningOnlyRecoveryPasses = input.planReasoningOnlyRecoveryPasses;
  let planAutoScaffoldPromptIssued = input.planAutoScaffoldPromptIssued;

  const finish = (status: PlanPostConvergenceToolRedirectResult["status"]): PlanPostConvergenceToolRedirectResult => ({
    status,
    planPostConvergenceToolRedirectCount,
    planDraftingRecoveryReadCount,
    planEvidenceRecoveryPasses,
    planReasoningOnlyRecoveryPasses,
    planAutoScaffoldPromptIssued,
  });

  const planEvidenceReadinessForRedirect = assessPlanEvidenceReadiness({
    userGoal: latestUserPromptText || getOriginalUserPromptForPlanFallback(callbacks),
    userContext: turnInputContextSignals,
    recentToolActivity: recentPlanToolActivity,
    hasObservedUserContext: hasPlanUserContextObservation(
      callbacks.getMessages() as AgentMessage[],
      lastAssistantTextForCheckpoint || visibleAssistantText,
    ),
  });
  const shouldRedirectPostConvergenceToolCalls = shouldRedirectPlanRuntimeToolsAfterReadOnlyConvergence({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
    hasPlanDecisionOutput,
    toolNames: effectiveToolCalls
      .filter((call) => !isAllowedUnapprovedPlanDraftMutationCall(call))
      .map((call) => call.name),
    evidenceReadiness: planEvidenceReadinessForRedirect.status,
    planRuntimePhase,
  });
  if (!shouldRedirectPostConvergenceToolCalls) {
    return finish("none");
  }

  const nextRedirectCount = planPostConvergenceToolRedirectCount + 1;
  if (nextRedirectCount > MAX_PLAN_POST_CONVERGENCE_TOOL_REDIRECTS) {
    const stopReason = "post_convergence_tool_redirect_budget_exhausted";
    logAgentEvent("plan_post_convergence_tool_redirect_exhausted", {
      iteration,
      redirectCount: planPostConvergenceToolRedirectCount,
      maxRedirects: MAX_PLAN_POST_CONVERGENCE_TOOL_REDIRECTS,
      toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
      planRuntimePhase,
      qualityRejectCount: planQualityRejectCount,
      qualityGateReason: planLastQualityGateReason,
    });
    logAgentEvent("loop_stop", {
      reason: stopReason,
      iteration,
      redirectCount: planPostConvergenceToolRedirectCount,
      planRuntimePhase,
    });
    setPlanRuntimePhase("blocked", stopReason);
    callbacks.onNonActionableStop(
      callbacks.getPreferredLanguage() === "zh"
        ? "计划收敛已暂停：证据冻结后仍连续请求不可用的工具，未能形成通过校验的计划。请重试本轮或补充约束。"
        : "Plan convergence paused: after evidence was frozen, the model kept requesting unavailable tools and did not produce a validated plan. Retry the turn or add constraints.",
      "incomplete_plan",
      {
        recoveryReason: "plan_generation_failed",
        nextStep: stopReason,
      },
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  }
  planPostConvergenceToolRedirectCount = nextRedirectCount;

  const language = MODEL_CONTROL_LANGUAGE;
  const hasMeaningfulVisibleText = visibleAssistantText.trim().length > 0;
  if (hasMeaningfulVisibleText) {
    callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
  } else {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
  }
  logAgentEvent("plan_post_convergence_tool_redirect", {
    iteration,
    redirectCount: planPostConvergenceToolRedirectCount,
    maxRedirects: MAX_PLAN_POST_CONVERGENCE_TOOL_REDIRECTS,
    toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
    imageParts: turnInputContextSignals.imageParts,
    mentionedFilePaths: turnInputContextSignals.mentionedFilePaths.length,
    attachedFilePaths: turnInputContextSignals.attachedFilePaths.length,
    preservedVisibleText: hasMeaningfulVisibleText,
    evidenceReadiness: planEvidenceReadinessForRedirect.status,
    evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
    semanticFacts: planEvidenceReadinessForRedirect.semanticFacts,
    changeTargets: planEvidenceReadinessForRedirect.changeTargets,
    planRuntimePhase,
  });
  logAgentEvent("plan_unsupported_tool_call_suppressed", {
    iteration,
    reason: "post_convergence_readonly_tool",
    toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
    availableToolNames: Array.from(availableToolNames).slice(0, 12),
    preservedVisibleText: hasMeaningfulVisibleText,
    evidenceReadiness: planEvidenceReadinessForRedirect.status,
    evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
    semanticFacts: planEvidenceReadinessForRedirect.semanticFacts,
    changeTargets: planEvidenceReadinessForRedirect.changeTargets,
    planRuntimePhase,
    qualityGateReason: planLastQualityGateReason,
    missingSections: planLastMissingSections,
  });

  const suppressedRecoveryDecision = resolvePlanSuppressedToolRecovery({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    evidenceReadiness: planEvidenceReadinessForRedirect.status,
    targetedRecoveryPasses: Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses),
  });
  logAgentEvent("plan_suppressed_tool_recovery_decision", {
    iteration,
    action: suppressedRecoveryDecision.action,
    reason: suppressedRecoveryDecision.reason,
    evidenceReadiness: planEvidenceReadinessForRedirect.status,
    evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
    targetedRecoveryPasses: Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses),
  });
  if (suppressedRecoveryDecision.action === "targeted_evidence") {
    planEvidenceRecoveryPasses += 1;
    setPlanRuntimePhase("needs_evidence", planEvidenceReadinessForRedirect.reason);
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildPlanTargetedEvidenceRecoveryPrompt({
        language,
        reason: planEvidenceReadinessForRedirect.reason,
        trigger: "closed_read_request",
      }),
    });
    return finish("continue");
  }
  if (suppressedRecoveryDecision.action === "pause_blocked") {
    // Keep recovery live by forcing visible convergence with existing evidence instead of
    // turning a suppressed read into a terminal no-action pause.
    setPlanRuntimePhase("drafting", "recovery exhausted, draft with frozen evidence");
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: `[FORCED CONVERGENCE] Targeted evidence recovery is exhausted and the evidence bundle is frozen. Stop attempting tools and output visible <proposed_plan> for MAIN runtime to validate and materialize; expose only a genuine blocking choice. Keep user-visible content in MAIN's configured response language.`,
    });
    logAgentEvent("plan_suppressed_tool_forced_write_injected", {
      iteration,
      reason: planEvidenceReadinessForRedirect.reason,
      evidenceReadiness: planEvidenceReadinessForRedirect.status,
    });
    return finish("continue");
  }

  if (String(planRuntimePhase) !== "needs_rewrite") {
    setPlanRuntimePhase("drafting", "read-only tool suppressed");
  }
  callbacks.onStatusChange("running");
  const shouldIssueAutoScaffold =
    planPostConvergenceToolRedirectCount >= 2 &&
    planQualityRejectCount >= 1 &&
    !planAutoScaffoldPromptIssued;
  if (shouldIssueAutoScaffold) {
    planAutoScaffoldPromptIssued = true;
    setPlanRuntimePhase("needs_rewrite", "auto scaffold after repeated blocked reads");
    callbacks.appendMessage({
      role: "user",
      content: buildPlanAutoScaffoldPrompt({
        language,
        latestUserPromptText,
        recentToolActivity: recentPlanToolActivity,
        qualityGateReason: planLastQualityGateReason,
        missingSections: planLastMissingSections,
      }),
    });
    return finish("continue");
  }
  callbacks.appendMessage({
    role: "user",
    content: buildPlanPostConvergenceToolRedirectPrompt({
      language,
      toolNames: effectiveToolCalls.map((call) => call.name),
      userContext: turnInputContextSignals,
      phase: planRuntimePhase,
      qualityGateReason: planLastQualityGateReason,
      missingSections: planLastMissingSections,
      rejectCount: planQualityRejectCount,
    }),
  });
  return finish("continue");
}
