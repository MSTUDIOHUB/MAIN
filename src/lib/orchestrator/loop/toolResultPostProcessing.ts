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
  classifyCommandResultOutcome,
  isPlanEvidenceBundleReady,
} from "../../planEvidence";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import { getTaskTargetingEvidenceKey, type TaskOrchestratorPhase } from "../../taskTargeting";
import { isPlanTaskTrustedComplete, type PlanRuntimePhase } from "../../workflowModels";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import type { PlanEvidenceRecoveryObjective } from "./planRuntimeState";
import {
  extractDelegatedSubagentActivities,
  extractSubagentParentRereadObligations,
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
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  recentSuccessfulProjectWrite: RecentSuccessfulProjectWrite;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
  unityConsoleFinalVerificationRequired: boolean;
  unityConsoleRefreshObservedAfterWrite: boolean;
  unityMcpForceConsoleFirstPending: boolean;
  unityConsoleMissingFirstToolRepromptIssued: boolean;
  unityMcpFallbackPrompt: string | null;
  planDraftingRecoveryReadCount: number;
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
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planDraftingRecoveryReadCount: number;
  hasPlanDecisionOutput: boolean;
  unityConsoleDiagnosticsRequested: boolean;
  unityConsoleFinalVerificationRequired: boolean;
  unityConsoleRefreshObservedAfterWrite: boolean;
  unityMcpForceConsoleFirstPending: boolean;
  unityConsoleMissingFirstToolRepromptIssued: boolean;
  forceXmlTools: boolean;
  recentSuccessfulProjectWrite: RecentSuccessfulProjectWrite;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
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
  let effectivePlanRuntimePhase = planRuntimePhase;
  const setPlanRuntimePhase: SetPlanRuntimePhase = (phase, reason, status) => {
    effectivePlanRuntimePhase = phase;
    commitPlanRuntimePhase(phase, reason, status);
  };
  // Internal quality-gate feedback is model/runtime control flow. It must not
  // become user progress, execution evidence, task targeting or success usage.
  const externalResults = results.filter((result) => !result.internalFeedback);
  externalResults.forEach((result) => callbacks.onToolResultObserved?.(result));
  const delegatedEvidenceActivities = externalResults.flatMap(extractDelegatedSubagentActivities);
  const parentRereadObligations = externalResults.flatMap(extractSubagentParentRereadObligations);
  const delegatedActivities = [...delegatedEvidenceActivities, ...parentRereadObligations];
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
  if (delegatedEvidenceActivities.length > 0) {
    callbacks.onDebugEvent?.("subagent_evidence_promoted", {
      iteration,
      evidenceCount: delegatedEvidenceActivities.length,
      provenanceSource: "tool_observation",
      summaryProseTrusted: false,
      childOwnedObservationCount: delegatedEvidenceActivities.filter((activity) =>
        activity.delegatedObservation?.owner.agentKind === "subagent"
      ).length,
      parentConsumedObservationCount: 0,
      requiresParentRereadCount: parentRereadObligations.length,
      targets: delegatedEvidenceActivities.map((activity) => activity.target).slice(0, 12),
    });
  }

  const unityConsoleResult = resolveUnityMcpForcedConsoleResult({
    results: externalResults,
    unityMcpForceConsoleFirstPending,
    unityConsoleMissingFirstToolRepromptIssued,
    forceXmlTools: input.forceXmlTools,
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

  if (workflowMode === "plan" || callbacks.getIsPlanApproved()) {
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
    // after every successful read batch. Do not close the read surface merely
    // because files and symbols were observed: diagnosis/repair plans still need
    // evidence that connects the user's objective to a confirmed rationale.
    const closureInput = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      [],
      "",
    );
    const bundle = closureInput.evidenceBundle;
    const closureAssessment = assessPlanClosureEvidence(bundle);
    const modelAuthoredDraftReady = isPlanEvidenceBundleReady(bundle);
    const shouldAdvanceToDrafting = closureAssessment.ready;
    if (shouldAdvanceToDrafting) {
      setPlanRuntimePhase(
        "drafting",
        "plan closure evidence ready",
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
        evidenceRecoveryObjective: input.planEvidenceRecoveryObjective,
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
        evidenceRecoveryObjective: input.planEvidenceRecoveryObjective,
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

  const resultOutcomeForEvidence = (result: ToolExecutionResult) =>
    result.isError ? "failed" : classifyCommandResultOutcome(result.name, result.content || "");
  const failedEvidenceResults = externalResults.filter((result) =>
    resultOutcomeForEvidence(result) === "failed"
  );
  const firstFailedEvidenceResult = failedEvidenceResults[0];
  const firstFailedEvidenceLifecycleState = firstFailedEvidenceResult
    ? inferLifecycleStateFromToolResult({ ...firstFailedEvidenceResult, isError: true })
    : null;
  const successfulResultCount = externalResults.filter((result) =>
    resultOutcomeForEvidence(result) === "succeeded"
  ).length;
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
  return {
    planRuntimePhase: effectivePlanRuntimePhase,
    planEvidenceRecoveryObjective: input.planEvidenceRecoveryObjective,
    recentSuccessfulProjectWrite,
    recoveringFromEmptyAssistantReplyAfterWrite,
    unityConsoleFinalVerificationRequired,
    unityConsoleRefreshObservedAfterWrite,
    unityMcpForceConsoleFirstPending,
    unityConsoleMissingFirstToolRepromptIssued,
    unityMcpFallbackPrompt,
    planDraftingRecoveryReadCount,
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
