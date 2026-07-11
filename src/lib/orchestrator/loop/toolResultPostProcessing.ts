import { buildExecutionDigest } from "../../executionDigest";
import {
  EDIT_PROGRESS_TOOL_NAMES,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
  compactDiagnosticText,
  inferLifecycleStateFromToolResult,
  isProjectSourceWriteResult,
  logAgentEvent,
  shouldDeferNoProgressStopToPlanReadOnlyConvergence,
  targetProgressReasonForToolResult,
} from "../../orchestrator";
import { isUnityScriptWriteToolCall } from "../../orchestrator/unityDiagnostics";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import { getTaskTargetingEvidenceKey, type TaskOrchestratorPhase } from "../../taskTargeting";
import { isPlanTaskTrustedComplete, type PlanRuntimePhase } from "../../workflowModels";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import {
  isVerificationEvidenceResult,
  rememberToolActivity,
  toolResultCountsAsExecutionEvidence,
} from "./toolActivityTracking";
import { resolveUnityMcpForcedConsoleResult } from "./unityMcpRuntime";

type WorkflowMode = "chat" | "edit" | "plan";

type SetPlanRuntimePhase = (
  phase: PlanRuntimePhase,
  reason?: string,
  status?: "pending" | "running" | "done" | "failed",
) => void;

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

type RecentSuccessfulProjectWrite = { name: string; target: string } | null;

export type ToolResultPostProcessingResult = {
  recentSuccessfulProjectWrite: RecentSuccessfulProjectWrite;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
  unityConsoleFinalVerificationRequired: boolean;
  unityConsoleRefreshObservedAfterWrite: boolean;
  unityMcpForceConsoleFirstPending: boolean;
  unityConsoleMissingFirstToolRepromptIssued: boolean;
  unityMcpFallbackPrompt: string | null;
  planDraftingRecoveryReadCount: number;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  approvedPlanNoProgressRecoveryAttempts: number;
  remainingTaskText: string | null;
  successfulReadOnlyExplorationResultCount: number;
  nonReadOnlySuccessfulResultCount: number;
  isUnapprovedPlanReadOnlyBatch: boolean;
};

export function handleToolResultPostProcessing(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  results: ToolExecutionResult[];
  toolArgsByCallId: Map<string, Record<string, unknown>>;
  taskTargetingEvidence: Set<string>;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  planRuntimePhase: PlanRuntimePhase;
  planDraftingRecoveryReadCount: number;
  hasPlanDecisionOutput: boolean;
  unityConsoleDiagnosticsRequested: boolean;
  unityConsoleFinalVerificationRequired: boolean;
  unityConsoleRefreshObservedAfterWrite: boolean;
  unityMcpForceConsoleFirstPending: boolean;
  unityConsoleMissingFirstToolRepromptIssued: boolean;
  recentSuccessfulProjectWrite: RecentSuccessfulProjectWrite;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  approvedPlanNoProgressRecoveryAttempts: number;
  markExecuteOperationEvidence: () => void;
  activateUnityMcpFallback: (reason: string) => void;
  setPlanRuntimePhase: SetPlanRuntimePhase;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  clearExecuteRecovery: (reason: string, resetTarget?: string) => void;
}): ToolResultPostProcessingResult {
  const {
    callbacks,
    workflowMode,
    turnIntent,
    runtimeIntent,
    iteration,
    results,
    toolArgsByCallId,
    taskTargetingEvidence,
    recentToolActivity,
    recentPlanToolActivity,
    planRuntimePhase,
    hasPlanDecisionOutput,
    unityConsoleDiagnosticsRequested,
    markExecuteOperationEvidence,
    activateUnityMcpFallback,
    setPlanRuntimePhase,
    emitTaskOrchestratorPhase,
    clearExecuteRecovery,
  } = input;

  let recentSuccessfulProjectWrite = input.recentSuccessfulProjectWrite;
  let recoveringFromEmptyAssistantReplyAfterWrite = input.recoveringFromEmptyAssistantReplyAfterWrite;
  let unityConsoleFinalVerificationRequired = input.unityConsoleFinalVerificationRequired;
  let unityConsoleRefreshObservedAfterWrite = input.unityConsoleRefreshObservedAfterWrite;
  let unityMcpForceConsoleFirstPending = input.unityMcpForceConsoleFirstPending;
  let unityConsoleMissingFirstToolRepromptIssued = input.unityConsoleMissingFirstToolRepromptIssued;
  let planDraftingRecoveryReadCount = input.planDraftingRecoveryReadCount;
  let approvedPlanActionOnlyRecoveryActive = input.approvedPlanActionOnlyRecoveryActive;
  let approvedPlanNoToolRecoveryFileReadActive = input.approvedPlanNoToolRecoveryFileReadActive;
  let approvedPlanNoProgressRecoveryAttempts = input.approvedPlanNoProgressRecoveryAttempts;
  // Internal quality-gate feedback is model/runtime control flow. It must not
  // become user progress, execution evidence, task targeting or success usage.
  const externalResults = results.filter((result) => !result.internalFeedback);

  const resultCountsAsExecutionEvidence = (result: ToolExecutionResult): boolean => {
    const resultArgs = toolArgsByCallId.get(result.toolCallId) ?? {};
    return toolResultCountsAsExecutionEvidence(result, resultArgs) ||
      isVerificationEvidenceResult(result);
  };

  for (const result of externalResults) {
    if (result.isError) continue;
    const resultArgs = toolArgsByCallId.get(result.toolCallId) ?? {};
    const countsAsExecutionEvidence = resultCountsAsExecutionEvidence(result);
    if (countsAsExecutionEvidence) {
      markExecuteOperationEvidence();
    }
    const targetingEvidenceKey = getTaskTargetingEvidenceKey(result.name, resultArgs, result.target);
    if (targetingEvidenceKey) {
      taskTargetingEvidence.add(targetingEvidenceKey);
    }
    if (unityConsoleDiagnosticsRequested && isUnityScriptWriteToolCall(result.name, resultArgs)) {
      unityConsoleFinalVerificationRequired = true;
      unityConsoleRefreshObservedAfterWrite = false;
    }
    if (unityConsoleDiagnosticsRequested && unityConsoleFinalVerificationRequired) {
      if (result.name === "refresh_unity") {
        unityConsoleRefreshObservedAfterWrite = true;
      } else if (result.name === "read_console" && unityConsoleRefreshObservedAfterWrite) {
        unityConsoleFinalVerificationRequired = false;
        unityConsoleRefreshObservedAfterWrite = false;
      }
    }

    if (isProjectSourceWriteResult(result)) {
      recentSuccessfulProjectWrite = {
        name: result.name,
        target: result.target,
      };
      recoveringFromEmptyAssistantReplyAfterWrite = false;
      continue;
    }
    if (isVerificationEvidenceResult(result)) {
      recentSuccessfulProjectWrite = null;
      recoveringFromEmptyAssistantReplyAfterWrite = false;
    }
  }

  const unityConsoleResult = resolveUnityMcpForcedConsoleResult({
    results: externalResults,
    unityMcpForceConsoleFirstPending,
    unityConsoleMissingFirstToolRepromptIssued,
    language: callbacks.getPreferredLanguage(),
  });
  if (unityConsoleResult.fallbackReason) {
    activateUnityMcpFallback(unityConsoleResult.fallbackReason);
  }
  unityMcpForceConsoleFirstPending = unityConsoleResult.unityMcpForceConsoleFirstPending;
  unityConsoleMissingFirstToolRepromptIssued = unityConsoleResult.unityConsoleMissingFirstToolRepromptIssued;
  const unityMcpFallbackPrompt = unityConsoleResult.prompt;

  externalResults.forEach((result) => rememberToolActivity(recentToolActivity, result));
  const remainingTaskText =
    callbacks.getPlanTasks().find((task) => !isPlanTaskTrustedComplete(task))?.text ?? null;
  if (callbacks.onExecutionDigestUpdate && externalResults.length > 0) {
    const digest = buildExecutionDigest({
      language: callbacks.getPreferredLanguage(),
      turnIntent,
      toolResults: externalResults,
      remainingTask: remainingTaskText || undefined,
    });
    if (digest) callbacks.onExecutionDigestUpdate(digest);
  }

  if (workflowMode === "plan") {
    externalResults.forEach((result) => rememberToolActivity(recentPlanToolActivity, result));
    if (
      !callbacks.getIsPlanApproved() &&
      planRuntimePhase === "drafting" &&
      externalResults.some((r) => r.name === "read_file" || r.name === "read_document" || r.name === "get_file_outline")
    ) {
      planDraftingRecoveryReadCount += 1;
    }
  }
  if (
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    planRuntimePhase === "explore_structure" &&
    externalResults.some((result) => result.name === "get_project_skeleton")
  ) {
    const structureSucceeded = externalResults.some((result) =>
      result.name === "get_project_skeleton" &&
      !result.isError
    );
    if (structureSucceeded) {
      setPlanRuntimePhase("explore_structure", "project structure explored", "done");
      setPlanRuntimePhase("grounding", "after project structure");
    } else {
      setPlanRuntimePhase("grounding", "project structure unavailable; continue targeted grounding");
    }
  }

  const failedEvidenceResults = externalResults.filter((result) => result.isError);
  const firstFailedEvidenceResult = failedEvidenceResults[0];
  const firstFailedEvidenceLifecycleState = firstFailedEvidenceResult
    ? inferLifecycleStateFromToolResult(firstFailedEvidenceResult)
    : null;
  const successfulResultCount = externalResults.filter((result) => !result.isError).length;
  emitTaskOrchestratorPhase("EVIDENCE_RECONCILE", {
    iteration,
    results: externalResults.length,
    successfulResults: successfulResultCount,
    failedResults: failedEvidenceResults.length,
    firstFailureReason: firstFailedEvidenceResult
      ? compactDiagnosticText(targetProgressReasonForToolResult(firstFailedEvidenceResult))
      : null,
    firstFailureTool: firstFailedEvidenceResult?.name ?? null,
    firstFailureTarget: firstFailedEvidenceResult?.target ?? null,
    firstFailureLifecycleState: firstFailedEvidenceLifecycleState,
    tool: firstFailedEvidenceResult?.name ?? null,
    target: firstFailedEvidenceResult?.target ?? null,
    lifecycleState: firstFailedEvidenceLifecycleState,
    evidenceKeys: [...taskTargetingEvidence].slice(-8),
  });
  logAgentEvent("post_tool_result_continuation", {
    stage: "after_evidence_reconcile",
    iteration,
    results: externalResults.length,
    successfulResults: successfulResultCount,
    internalFeedbackResults: results.length - externalResults.length,
    editResults: externalResults.filter((result) => !result.isError && EDIT_PROGRESS_TOOL_NAMES.has(result.name)).length,
    verificationResults: externalResults.filter(isVerificationEvidenceResult).length,
    runtimeIntent,
    workflowMode,
    planApproved: callbacks.getIsPlanApproved(),
  });

  const successfulReadOnlyExplorationResultCount = externalResults.filter((result) =>
    !result.isError && PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
  ).length;
  const nonReadOnlySuccessfulResultCount = externalResults.filter((result) =>
    resultCountsAsExecutionEvidence(result) &&
    !PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
  ).length;
  if (
    workflowMode === "plan" &&
    callbacks.getIsPlanApproved() &&
    approvedPlanNoToolRecoveryFileReadActive &&
    externalResults.some((result) => result.name === "read_file")
  ) {
    approvedPlanNoToolRecoveryFileReadActive = false;
  }
  if (workflowMode === "plan" && callbacks.getIsPlanApproved() && nonReadOnlySuccessfulResultCount > 0) {
    approvedPlanActionOnlyRecoveryActive = false;
    approvedPlanNoToolRecoveryFileReadActive = false;
    approvedPlanNoProgressRecoveryAttempts = 0;
  }
  if (workflowMode === "edit" && nonReadOnlySuccessfulResultCount > 0) {
    const firstSuccessTarget = externalResults.find(
      (result) => resultCountsAsExecutionEvidence(result) &&
        !PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
    )?.target;
    clearExecuteRecovery("action_evidence_observed", firstSuccessTarget || undefined);
  }

  return {
    recentSuccessfulProjectWrite,
    recoveringFromEmptyAssistantReplyAfterWrite,
    unityConsoleFinalVerificationRequired,
    unityConsoleRefreshObservedAfterWrite,
    unityMcpForceConsoleFirstPending,
    unityConsoleMissingFirstToolRepromptIssued,
    unityMcpFallbackPrompt,
    planDraftingRecoveryReadCount,
    approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive,
    approvedPlanNoProgressRecoveryAttempts,
    remainingTaskText,
    successfulReadOnlyExplorationResultCount,
    nonReadOnlySuccessfulResultCount,
    isUnapprovedPlanReadOnlyBatch: shouldDeferNoProgressStopToPlanReadOnlyConvergence({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      hasPlanDecisionOutput,
      resultCount: externalResults.length,
      successfulReadOnlyResultCount: successfulReadOnlyExplorationResultCount,
      nonReadOnlySuccessfulResultCount,
    }),
  };
}
