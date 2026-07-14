import { buildExecutionDigest } from "../../executionDigest";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  collectPlanClosureMaterializationInput,
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
import {
  assessPlanClosureEvidence,
  isPlanEvidenceBundleReady,
} from "../../planEvidence";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import { getTaskTargetingEvidenceKey, type TaskOrchestratorPhase } from "../../taskTargeting";
import { isPlanTaskTrustedComplete, type PlanRuntimePhase } from "../../workflowModels";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import {
  extractDelegatedSubagentActivities,
  isVerificationEvidenceResult,
  rememberDelegatedSubagentActivities,
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
  planRuntimePhase: PlanRuntimePhase;
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
    setPlanRuntimePhase: commitPlanRuntimePhase,
    emitTaskOrchestratorPhase,
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
  let effectivePlanRuntimePhase = planRuntimePhase;
  const setPlanRuntimePhase: SetPlanRuntimePhase = (phase, reason, status) => {
    effectivePlanRuntimePhase = phase;
    commitPlanRuntimePhase(phase, reason, status);
  };
  // Internal quality-gate feedback is model/runtime control flow. It must not
  // become user progress, execution evidence, task targeting or success usage.
  const externalResults = results.filter((result) => !result.internalFeedback);
  const delegatedActivities = externalResults.flatMap(extractDelegatedSubagentActivities);
  const directlyTrackedResults = externalResults.filter((result) =>
    result.name !== "spawn_subagent" && result.name !== "wait_subagents"
  );

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
  for (const activity of delegatedActivities) {
    const targetingEvidenceKey = getTaskTargetingEvidenceKey(
      activity.name,
      { path: activity.target },
      activity.target,
    );
    if (targetingEvidenceKey) taskTargetingEvidence.add(targetingEvidenceKey);
  }
  if (delegatedActivities.length > 0) {
    callbacks.onDebugEvent?.("subagent_evidence_promoted", {
      iteration,
      evidenceCount: delegatedActivities.length,
      targets: delegatedActivities.map((activity) => activity.target).slice(0, 12),
    });
  }

  const unityConsoleResult = resolveUnityMcpForcedConsoleResult({
    results: externalResults,
    unityMcpForceConsoleFirstPending,
    unityConsoleMissingFirstToolRepromptIssued,
    language: MODEL_CONTROL_LANGUAGE,
  });
  if (unityConsoleResult.fallbackReason) {
    activateUnityMcpFallback(unityConsoleResult.fallbackReason);
  }
  unityMcpForceConsoleFirstPending = unityConsoleResult.unityMcpForceConsoleFirstPending;
  unityConsoleMissingFirstToolRepromptIssued = unityConsoleResult.unityConsoleMissingFirstToolRepromptIssued;
  const unityMcpFallbackPrompt = unityConsoleResult.prompt;

  directlyTrackedResults.forEach((result) => rememberToolActivity(recentToolActivity, result));
  rememberDelegatedSubagentActivities(recentToolActivity, delegatedActivities);
  const remainingTaskText =
    callbacks.getPlanTasks().find((task) => !isPlanTaskTrustedComplete(task))?.text ?? null;
  const digestResults = [
    ...directlyTrackedResults,
    ...delegatedActivities.map((activity, index) => ({
      toolCallId: `delegated-evidence-${index}`,
      name: activity.name,
      target: activity.target,
      content: activity.detail || "delegated subagent evidence",
      isError: false,
    })),
  ];
  if (callbacks.onExecutionDigestUpdate && digestResults.length > 0) {
    const digest = buildExecutionDigest({
      language: callbacks.getPreferredLanguage(),
      turnIntent,
      toolResults: digestResults,
      remainingTask: remainingTaskText || undefined,
    });
    if (digest) callbacks.onExecutionDigestUpdate(digest);
  }

  if (workflowMode === "plan") {
    directlyTrackedResults.forEach((result) => rememberToolActivity(
      recentPlanToolActivity,
      result,
      { evidenceLedger: true },
    ));
    rememberDelegatedSubagentActivities(
      recentPlanToolActivity,
      delegatedActivities,
      { evidenceLedger: true },
    );
    if (
      !callbacks.getIsPlanApproved() &&
      planRuntimePhase === "drafting" &&
      externalResults.some((r) =>
        r.name === "read_file" ||
        r.name === "read_document" ||
        r.name === "get_file_outline" ||
        r.name === "code_ast_query" ||
        r.name === "find_symbol_references" ||
        r.name === "git_diff"
      )
    ) {
      planDraftingRecoveryReadCount += 1;
    }
  }
  if (
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    !hasPlanDecisionOutput &&
    ["explore_structure", "grounding", "needs_evidence", "synthesis"].includes(String(planRuntimePhase))
  ) {
    // Evidence convergence is a runtime decision, not a model/iteration-count
    // decision. Build the exact bundle that drafting and validation will use
    // after every successful read batch. A model-authored draft can synthesize
    // relationships across grounded source excerpts, so its read surface closes
    // once the bundle has semantic facts and change owners. The stricter closure
    // assessment is reserved for deterministic runtime materialization, which
    // cannot safely infer a diagnosis that the evidence does not state.
    const closureInput = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      [],
      "",
    );
    const bundle = closureInput.evidenceBundle;
    const closureAssessment = assessPlanClosureEvidence(bundle);
    const modelAuthoredDraftReady = isPlanEvidenceBundleReady(bundle);
    const shouldAdvanceToDrafting = closureAssessment.ready || (
      modelAuthoredDraftReady && String(planRuntimePhase) !== "needs_evidence"
    );
    if (shouldAdvanceToDrafting) {
      setPlanRuntimePhase(
        "drafting",
        closureAssessment.ready
          ? "plan closure evidence ready"
          : "model-authored plan evidence ready",
      );
      logAgentEvent("plan_evidence_bundle_ready", {
        iteration,
        evidenceBundleId: bundle.bundleId,
        evidenceBundleHash: bundle.hash,
        evidenceLedgerEntries: recentPlanToolActivity.length,
        bundleReady: true,
        closureReady: closureAssessment.ready,
        modelAuthoredDraftReady,
        deterministicMaterializationReady: closureAssessment.ready,
        closureReason: closureAssessment.reason,
        objectiveTargetMatches: closureAssessment.objectiveTargetMatches,
        defectSignalMatches: closureAssessment.defectSignalMatches,
        contractMismatchMatches: closureAssessment.contractMismatchMatches,
        contractMismatchKinds: closureAssessment.contractMismatchKinds,
        unresolvedContractKinds: closureAssessment.unresolvedContractKinds,
        semanticFacts: bundle.facts.length,
        changeTargets: bundle.changeTargets.length,
        changeTargetPaths: bundle.changeTargets,
        verificationTargets: bundle.verificationTargets.length,
        previousPhase: planRuntimePhase,
      });
    } else if (modelAuthoredDraftReady) {
      logAgentEvent("plan_evidence_bundle_open", {
        iteration,
        evidenceBundleId: bundle.bundleId,
        evidenceBundleHash: bundle.hash,
        evidenceLedgerEntries: recentPlanToolActivity.length,
        bundleReady: true,
        closureReady: false,
        modelAuthoredDraftReady,
        deterministicMaterializationReady: false,
        closureReason: closureAssessment.reason,
        objectiveTargetMatches: closureAssessment.objectiveTargetMatches,
        defectSignalMatches: closureAssessment.defectSignalMatches,
        contractMismatchMatches: closureAssessment.contractMismatchMatches,
        contractMismatchKinds: closureAssessment.contractMismatchKinds,
        unresolvedContractKinds: closureAssessment.unresolvedContractKinds,
        semanticFacts: bundle.facts.length,
        changeTargets: bundle.changeTargets.length,
        changeTargetPaths: bundle.changeTargets,
        verificationTargets: bundle.verificationTargets.length,
        previousPhase: planRuntimePhase,
      });
      if (planRuntimePhase === "explore_structure") {
        setPlanRuntimePhase("grounding", closureAssessment.reason);
      }
    } else if (
      planRuntimePhase === "explore_structure" &&
      externalResults.some((result) =>
        !result.isError &&
        result.name !== "get_project_skeleton" &&
        PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
      )
    ) {
      // read_file is intentionally available during structure exploration.
      // A successful targeted read therefore has to advance the phase here;
      // waiting for the old "unsupported tool" redirect leaves the runtime in
      // explore_structure forever and prevents bundle injection/drafting.
      setPlanRuntimePhase("grounding", "targeted evidence read completed");
      logAgentEvent("plan_structure_phase_advanced_for_targeted_result", {
        iteration,
        previousPhase: planRuntimePhase,
        nextPhase: "grounding",
        toolNames: externalResults
          .filter((result) => !result.isError)
          .map((result) => result.name)
          .slice(0, 8),
      });
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
  return {
    planRuntimePhase: effectivePlanRuntimePhase,
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
