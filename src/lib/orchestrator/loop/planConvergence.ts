import {
  buildPlanAutoScaffoldPrompt,
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
import type { StreamResult } from "../../streaming";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanRuntimePhase } from "../../workflowModels";
import {
  buildAssistantHistoryMessage,
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
  status: "none" | "continue";
  planPostConvergenceToolRedirectCount: number;
  planDraftingRecoveryReadCount: number;
  planReasoningOnlyRecoveryPasses: number;
  planAutoScaffoldPromptIssued: boolean;
};

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

  if (isUnapprovedPlanReadOnlyBatch && !hasPlanDecisionOutput) {
    planReadOnlyConvergenceBatches += 1;
    planReadOnlyConvergenceTools += successfulReadOnlyExplorationResultCount;
  } else if (!isUnapprovedPlanReadOnlyBatch || hasPlanDecisionOutput) {
    planReadOnlyConvergenceBatches = 0;
    planReadOnlyConvergenceTools = 0;
  }

  const planEvidenceReadinessForConvergence = assessPlanEvidenceReadiness({
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

  const language = callbacks.getPreferredLanguage();
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
  });

  if (!usedPlanReadOnlyConvergencePrompt) {
    usedPlanReadOnlyConvergencePrompt = true;
    setPlanRuntimePhase(
      planEvidenceReadinessForConvergence.status === "needs_targeted_read" ? "needs_evidence" : "drafting",
      convergenceReason,
    );
    callbacks.appendMessage({
      role: "user",
      content: buildPlanReadOnlyConvergencePrompt(
        language,
        planReadOnlyConvergenceBatches,
        planReadOnlyConvergenceTools,
        turnInputContextSignals,
      ),
    });
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
    planEvidenceRecoveryPasses,
    planQualityRejectCount,
    planLastQualityGateReason,
    planLastMissingSections,
    latestUserPromptText,
    setPlanRuntimePhase,
  } = input;

  let planPostConvergenceToolRedirectCount = input.planPostConvergenceToolRedirectCount;
  let planDraftingRecoveryReadCount = input.planDraftingRecoveryReadCount;
  let planReasoningOnlyRecoveryPasses = input.planReasoningOnlyRecoveryPasses;
  let planAutoScaffoldPromptIssued = input.planAutoScaffoldPromptIssued;

  const finish = (status: PlanPostConvergenceToolRedirectResult["status"]): PlanPostConvergenceToolRedirectResult => ({
    status,
    planPostConvergenceToolRedirectCount,
    planDraftingRecoveryReadCount,
    planReasoningOnlyRecoveryPasses,
    planAutoScaffoldPromptIssued,
  });

  const planEvidenceReadinessForRedirect = assessPlanEvidenceReadiness({
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

  const language = callbacks.getPreferredLanguage();
  const hasMeaningfulVisibleText = visibleAssistantText.trim().length > 0;
  if (hasMeaningfulVisibleText) {
    callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
  } else {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
  }
  logAgentEvent("plan_post_convergence_tool_redirect", {
    iteration,
    redirectCount: planPostConvergenceToolRedirectCount + 1,
    toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
    imageParts: turnInputContextSignals.imageParts,
    mentionedFilePaths: turnInputContextSignals.mentionedFilePaths.length,
    attachedFilePaths: turnInputContextSignals.attachedFilePaths.length,
    preservedVisibleText: hasMeaningfulVisibleText,
    evidenceReadiness: planEvidenceReadinessForRedirect.status,
    evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
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
    planRuntimePhase,
    qualityGateReason: planLastQualityGateReason,
    missingSections: planLastMissingSections,
  });

  const suppressedToolNames = effectiveToolCalls.map((call) => call.name);
  const isDraftingReadAttempt =
    planRuntimePhase === "drafting" &&
    suppressedToolNames.some((toolName) =>
      toolName === "read_file" || toolName === "read_document" || toolName === "get_file_outline"
    );
  if (isDraftingReadAttempt && planDraftingRecoveryReadCount < 1) {
    planDraftingRecoveryReadCount += 1;
    planReasoningOnlyRecoveryPasses += 1;
    const readToolsAvailable = ["read_file", "read_document", "get_file_outline"].some((name) => availableToolNames.has(name));
    const urgencyHint = readToolsAvailable
      ? (language === "zh"
        ? `PLAN_DRAFTING_RECOVERY_READ: 这是唯一一次 drafting 补读机会。请只读取刚才缺失的最具体文件，然后立即用 write_file 或 replace_in_file 写入 .MAIN/plans/plan.md。不要继续探索。尝试的读工具：${suppressedToolNames.join(", ")}。`
        : `PLAN_DRAFTING_RECOVERY_READ: This is the only drafting recovery read. Read only the most specific missing file, then immediately write .MAIN/plans/plan.md with write_file or replace_in_file. Do not continue exploring. Attempted read tools: ${suppressedToolNames.join(", ")}.`)
      : (language === "zh"
        ? `PLAN_DRAFTING_WRITE_NOW: 当前 drafting 工具面没有读取工具。不要再尝试读取；请基于已有证据立即用 write_file 或 replace_in_file 写入 .MAIN/plans/plan.md。若确有阻塞性取舍，请输出 <user_options> 后停止。`
        : `PLAN_DRAFTING_WRITE_NOW: No read tools are available in the current drafting tool surface. Do not attempt more reads; write .MAIN/plans/plan.md now with write_file or replace_in_file from existing evidence. If a blocking decision remains, output <user_options> and stop.`);
    callbacks.appendMessage({
      role: "user",
      content: urgencyHint,
    });
    logAgentEvent("plan_drafting_recovery_read_injected", {
      iteration,
      attemptedTools: suppressedToolNames,
      planDraftingRecoveryReadCount,
      readToolsAvailable,
      maxRecoveryReads: 1,
    });
    return finish("continue");
  }

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
    planReasoningOnlyRecoveryPasses += 1;
    setPlanRuntimePhase("needs_evidence", planEvidenceReadinessForRedirect.reason);
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildPlanTargetedEvidenceRecoveryPrompt({
        language,
        reason: planEvidenceReadinessForRedirect.reason,
      }),
    });
    return finish("continue");
  }
  if (suppressedRecoveryDecision.action === "pause_blocked") {
    // Keep recovery live by forcing a plan write with existing evidence instead of
    // turning a suppressed read into a terminal no-action pause.
    planPostConvergenceToolRedirectCount += 1;
    setPlanRuntimePhase("drafting", "recovery exhausted, write with existing evidence");
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: language === "zh"
        ? `【强制写入提示】定向补证和恢复读取已全部使用完毕，证据已充分。请立即停止尝试任何只读工具，直接使用 write_file 或 replace_in_file 创建或更新 .MAIN/plans/plan.md。如果你认为还需要某个具体文件的信息，在计划中将该缺失信息标记为"用户待提供"并写入计划；否则现在就写。`
        : `[FORCED WRITE] All targeted evidence recovery passes and controlled recovery reads are exhausted — you have sufficient evidence. Immediately stop attempting read tools and use write_file or replace_in_file to create or update .MAIN/plans/plan.md. If you believe a specific file is missing, mark it as "pending user input" within the plan itself; otherwise write the plan now.`,
    });
    logAgentEvent("plan_suppressed_tool_forced_write_injected", {
      iteration,
      reason: planEvidenceReadinessForRedirect.reason,
      evidenceReadiness: planEvidenceReadinessForRedirect.status,
    });
    return finish("continue");
  }

  planPostConvergenceToolRedirectCount += 1;
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
