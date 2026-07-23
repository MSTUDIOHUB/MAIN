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
  isPlanRuntimeFinalizationPhase,
  isPlanTargetedEvidenceToolName,
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
  derivePlanEvidenceObligations,
  getPlanEvidenceObligationKey,
} from "../../planEvidenceObligations";
import {
  buildAssistantHistoryMessage,
  collectPlanClosureMaterializationInput,
  getOriginalUserPromptForPlanFallback,
  hasPlanVisualContextGrounding,
  logAgentEvent,
} from "../../orchestrator";
import type { AgentMessage, OrchestratorCallbacks, ToolCallToExecute } from "../types";
import type { PlanEvidenceRecoveryObjective } from "./planRuntimeState";
import { buildPlanEvidenceProgressFingerprint } from "./planRuntimeState";

export type PlanReadOnlyConvergenceResult = {
  status: "none" | "continue";
  planReadOnlyConvergenceBatches: number;
  planReadOnlyConvergenceTools: number;
  usedPlanReadOnlyConvergencePrompt: boolean;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planEvidenceProgressFingerprint: string;
};

export type PlanPostConvergenceToolRedirectResult = {
  status: "none" | "continue" | "stopped";
  planPostConvergenceToolRedirectCount: number;
  planDraftingRecoveryReadCount: number;
  planEvidenceRecoveryPasses: number;
  planReasoningOnlyRecoveryPasses: number;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planEvidenceProgressFingerprint: string;
  planAutoScaffoldPromptIssued: boolean;
};

export const MAX_PLAN_POST_CONVERGENCE_TOOL_REDIRECTS = 3;

function freezePlanEvidenceRecoveryBaseline(input: {
  callbacks: OrchestratorCallbacks;
  recentPlanToolActivity: PlanToolActivitySummary[];
  latestUserPromptText: string;
}): string {
  const closureInput = collectPlanClosureMaterializationInput(
    input.callbacks,
    input.recentPlanToolActivity,
    [],
    input.latestUserPromptText,
  );
  const coverageKeys = new Set(input.recentPlanToolActivity.flatMap((activity) => {
    const observation = activity.readFileObservation;
    if (!observation) return [];
    const key = observation.key || [
      observation.path,
      observation.versionToken,
      observation.requestSignature,
    ].join("::");
    return key ? [key] : [];
  }));
  return buildPlanEvidenceProgressFingerprint({
    bundleHash: closureInput.evidenceBundle.hash,
    coverageKeys,
    obligationKeys: new Set(derivePlanEvidenceObligations({
      objective: input.latestUserPromptText,
      activities: input.recentPlanToolActivity,
    }).map(getPlanEvidenceObligationKey)),
  });
}

export function handlePlanReadOnlyConvergence(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  isUnapprovedPlanReadOnlyBatch: boolean;
  hasPlanDecisionOutput: boolean;
  successfulReadOnlyExplorationResultCount: number;
  planReadOnlyConvergenceBatches: number;
  planReadOnlyConvergenceTools: number;
  usedPlanReadOnlyConvergencePrompt: boolean;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planEvidenceProgressFingerprint?: string;
  planRuntimePhase?: PlanRuntimePhase;
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
    setPlanRuntimePhase,
  } = input;

  let planReadOnlyConvergenceBatches = input.planReadOnlyConvergenceBatches;
  let planReadOnlyConvergenceTools = input.planReadOnlyConvergenceTools;
  let usedPlanReadOnlyConvergencePrompt = input.usedPlanReadOnlyConvergencePrompt;
  let planEvidenceRecoveryObjective = input.planEvidenceRecoveryObjective ?? "none";
  let planEvidenceProgressFingerprint = input.planEvidenceProgressFingerprint ?? "";
  const userGoal = getOriginalUserPromptForPlanFallback(callbacks);

  // Tool-result reconciliation may already have moved this exact batch into a
  // finalization phase. Read-only convergence must be monotonic and cannot
  // re-open the stricter evidence phase from a stale pre-reconciliation view.
  if (isPlanRuntimeFinalizationPhase(input.planRuntimePhase)) {
    return {
      status: "none",
      planReadOnlyConvergenceBatches,
      planReadOnlyConvergenceTools,
      usedPlanReadOnlyConvergencePrompt,
      planEvidenceRecoveryObjective,
      planEvidenceProgressFingerprint,
    };
  }

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
    hasGroundedVisualContext: hasPlanVisualContextGrounding(
      callbacks.getMessages() as AgentMessage[],
      callbacks.getCurrentTurnId?.(),
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
    hasGroundedVisualContext: planEvidenceReadinessForConvergence.status !== "needs_observation",
    convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
  });

  if (!shouldConvergeUnapprovedPlanReadOnly) {
    return {
      status: "none",
      planReadOnlyConvergenceBatches,
      planReadOnlyConvergenceTools,
      usedPlanReadOnlyConvergencePrompt,
      planEvidenceRecoveryObjective,
      planEvidenceProgressFingerprint,
    };
  }

  const language = MODEL_CONTROL_LANGUAGE;
  const convergencePhase = planEvidenceReadinessForConvergence.status === "needs_targeted_read"
    ? "needs_evidence"
    : "synthesis";
  const convergenceReason = planEvidenceReadinessForConvergence.status === "needs_targeted_read"
    ? planEvidenceReadinessForConvergence.reason
    : "targeted evidence ready";
  planEvidenceRecoveryObjective = convergencePhase === "needs_evidence"
    ? "model_draft"
    : "none";
  if (
    convergencePhase === "needs_evidence" &&
    (
      input.planEvidenceRecoveryObjective !== "model_draft" ||
      !planEvidenceProgressFingerprint
    )
  ) {
    planEvidenceProgressFingerprint = freezePlanEvidenceRecoveryBaseline({
      callbacks,
      recentPlanToolActivity,
      latestUserPromptText: userGoal,
    });
  }
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
      const evidenceObligations = derivePlanEvidenceObligations({
        objective: userGoal,
        activities: recentPlanToolActivity,
      });
      convergencePrompt = buildPlanClosureEvidenceRecoveryPrompt(
        language,
        planEvidenceReadinessForConvergence.reason,
        userGoal,
        {
          unresolvedContractKinds: closureAssessment.unresolvedContractKinds,
          confirmedChangeTargets: closureInput.evidenceBundle.changeTargets,
          evidenceObligations,
        },
      );
    }
    callbacks.appendMessage({ role: "user", content: convergencePrompt });
    return {
      status: "continue",
      planReadOnlyConvergenceBatches,
      planReadOnlyConvergenceTools,
      usedPlanReadOnlyConvergencePrompt,
      planEvidenceRecoveryObjective,
      planEvidenceProgressFingerprint,
    };
  }

  return {
    status: "none",
    planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools,
    usedPlanReadOnlyConvergencePrompt,
    planEvidenceRecoveryObjective,
    planEvidenceProgressFingerprint,
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
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planEvidenceProgressFingerprint?: string;
  planQualityRejectCount: number;
  planAutoScaffoldPromptIssued: boolean;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
  latestUserPromptText: string;
  preferredDelegationRequired?: boolean;
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
    visibleAssistantText,
    assistantHistoryText,
    providerReasoningForHistory,
    assistantMsgId,
    planRuntimePhase,
    planQualityRejectCount,
    planLastQualityGateReason,
    planLastMissingSections,
    latestUserPromptText,
    preferredDelegationRequired = false,
    setPlanRuntimePhase,
  } = input;

  let planPostConvergenceToolRedirectCount = input.planPostConvergenceToolRedirectCount;
  let planDraftingRecoveryReadCount = input.planDraftingRecoveryReadCount;
  let planEvidenceRecoveryPasses = input.planEvidenceRecoveryPasses;
  let planReasoningOnlyRecoveryPasses = input.planReasoningOnlyRecoveryPasses;
  let planEvidenceRecoveryObjective = input.planEvidenceRecoveryObjective ?? "none";
  let planEvidenceProgressFingerprint = input.planEvidenceProgressFingerprint ?? "";
  let planAutoScaffoldPromptIssued = input.planAutoScaffoldPromptIssued;

  const finish = (status: PlanPostConvergenceToolRedirectResult["status"]): PlanPostConvergenceToolRedirectResult => ({
    status,
    planPostConvergenceToolRedirectCount,
    planDraftingRecoveryReadCount,
    planEvidenceRecoveryPasses,
    planReasoningOnlyRecoveryPasses,
    planEvidenceRecoveryObjective,
    planEvidenceProgressFingerprint,
    planAutoScaffoldPromptIssued,
  });

  const planEvidenceReadinessForRedirect = assessPlanEvidenceReadiness({
    userGoal: latestUserPromptText || getOriginalUserPromptForPlanFallback(callbacks),
    userContext: turnInputContextSignals,
    recentToolActivity: recentPlanToolActivity,
    hasGroundedVisualContext: hasPlanVisualContextGrounding(
      callbacks.getMessages() as AgentMessage[],
      callbacks.getCurrentTurnId?.(),
    ),
  });
  const redirectEligibleToolCalls = effectiveToolCalls.filter((call) =>
    !isAllowedUnapprovedPlanDraftMutationCall(call) &&
    !(preferredDelegationRequired && call.name === "spawn_subagent")
  );
  const shouldRedirectPostConvergenceToolCalls = shouldRedirectPlanRuntimeToolsAfterReadOnlyConvergence({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
    hasPlanDecisionOutput,
    toolNames: redirectEligibleToolCalls.map((call) => call.name),
    evidenceReadiness: planEvidenceReadinessForRedirect.status,
    planRuntimePhase,
  });
  if (!shouldRedirectPostConvergenceToolCalls) {
    return finish("none");
  }

  const requestedTargetedEvidence = redirectEligibleToolCalls
    .some((call) => isPlanTargetedEvidenceToolName(call.name));

  const nextRedirectCount = planPostConvergenceToolRedirectCount + 1;
  if (
    !requestedTargetedEvidence &&
    nextRedirectCount > MAX_PLAN_POST_CONVERGENCE_TOOL_REDIRECTS
  ) {
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
  if (!requestedTargetedEvidence) {
    planPostConvergenceToolRedirectCount = nextRedirectCount;
  }

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
    requestedTargetedEvidence,
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
    requestedTargetedEvidence,
  });

  if (requestedTargetedEvidence) {
    // A different file/range or a post-mutation reread is legitimate progress.
    // Reopen the read-only surface without consuming a count-based budget;
    // duplicate unchanged windows are bounded after their result is known.
    planEvidenceRecoveryObjective = "model_draft";
    if (
      input.planEvidenceRecoveryObjective !== "model_draft" ||
      !planEvidenceProgressFingerprint
    ) {
      planEvidenceProgressFingerprint = freezePlanEvidenceRecoveryBaseline({
        callbacks,
        recentPlanToolActivity,
        latestUserPromptText,
      });
    }
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

  // Finalization is entered only after a model-draft bundle has been frozen.
  // Do not reclassify that same bundle with deterministic materialization's
  // stricter closure threshold merely because the model requested one read.
  const recoveryEvidenceReadiness = isPlanRuntimeFinalizationPhase(planRuntimePhase)
    ? "ready_for_plan"
    : planEvidenceReadinessForRedirect.status;
  const suppressedRecoveryDecision = resolvePlanSuppressedToolRecovery({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    evidenceReadiness: recoveryEvidenceReadiness,
    targetedRecoveryPasses: Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses),
  });
  logAgentEvent("plan_suppressed_tool_recovery_decision", {
    iteration,
    action: suppressedRecoveryDecision.action,
    reason: suppressedRecoveryDecision.reason,
    evidenceReadiness: recoveryEvidenceReadiness,
    evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
    targetedRecoveryPasses: Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses),
  });
  if (suppressedRecoveryDecision.action === "targeted_evidence") {
    planEvidenceRecoveryPasses += 1;
    planEvidenceRecoveryObjective = "model_draft";
    if (
      input.planEvidenceRecoveryObjective !== "model_draft" ||
      !planEvidenceProgressFingerprint
    ) {
      planEvidenceProgressFingerprint = freezePlanEvidenceRecoveryBaseline({
        callbacks,
        recentPlanToolActivity,
        latestUserPromptText,
      });
    }
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
    planEvidenceRecoveryObjective = "none";
    setPlanRuntimePhase("drafting", "recovery exhausted, draft with frozen evidence");
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: `[FORCED CONVERGENCE] Targeted evidence recovery is exhausted and the evidence bundle is frozen. Stop attempting discovery tools and submit the complete typed graph through the transport declared by the latest [PLAN AUTHORING CONTRACT]; MAIN runtime validates and renders it. Expose only a genuine blocking choice. Keep typed field text in MAIN's configured response language.`,
    });
    logAgentEvent("plan_suppressed_tool_forced_write_injected", {
      iteration,
      reason: planEvidenceReadinessForRedirect.reason,
      evidenceReadiness: planEvidenceReadinessForRedirect.status,
    });
    return finish("continue");
  }

  if (String(planRuntimePhase) !== "needs_rewrite") {
    planEvidenceRecoveryObjective = "none";
    setPlanRuntimePhase("drafting", "read-only tool suppressed");
  }
  callbacks.onStatusChange("running");
  const shouldIssueAutoScaffold =
    planPostConvergenceToolRedirectCount >= 2 &&
    planQualityRejectCount >= 1 &&
    !planAutoScaffoldPromptIssued;
  if (shouldIssueAutoScaffold) {
    planAutoScaffoldPromptIssued = true;
    planEvidenceRecoveryObjective = "none";
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
  planEvidenceRecoveryObjective = "none";
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
