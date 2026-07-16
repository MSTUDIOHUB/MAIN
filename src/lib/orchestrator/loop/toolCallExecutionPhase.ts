import type { HooksConfig } from "../../hooks";
import {
  buildPatchRecoveryReadNoProgressFingerprint,
  isReadOnlyNoProgressDetail,
  readEvidenceSatisfiesRecoveryLease,
  requestedRangeFromReadObservationSignature,
  resolveExecuteRecoveryActionContract,
  resolveExecutePatchRecoveryTarget,
  type ReadProgressFingerprint,
  type RecoveryActionContract,
} from "../../executeRecoveryTools";
import {
  buildAssistantHistoryMessage,
  isProjectSourceWriteResult,
  isReviewablePlanStage,
  isSuccessfulPlanArtifactWriteResult,
  logAgentEvent,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { extractReadFileWindowMetadata } from "../../readFileWindow";
import type { ResolvedUserIntent } from "../../runIntent";
import type { TaskOrchestratorPhase, TaskTargetingProfile } from "../../taskTargeting";
import type { ToolCapabilityRegistry, ToolPermissionPolicy } from "../../toolCapabilities";
import type { ToolDefinition } from "../../toolSchemas";
import type { MainThreadEventInput, ToolFeedbackFormat } from "../../turnEvents";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanRuntimePhase } from "../../workflowModels";
import type {
  AgentMessage,
  OrchestratorCallbacks,
  ToolCallInMessage,
  ToolCallToExecute,
  ToolExecutionResult,
} from "../types";
import type { ApprovedPlanRecoveryRuntimeState } from "./approvedPlanRecoveryRuntime";
import { applyApprovedPlanToolResultRecoveryState } from "./approvedPlanRecoveryRuntime";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import {
  applyRecentSuccessfulProjectWriteRuntimeState,
  markExecuteOperationEvidenceRuntimeState,
} from "./evidenceRuntimeState";
import {
  refundExecuteRecoveryRuntimeIteration,
  registerExecuteRecoveryProtocolNoProgress,
  transitionExecuteRecoveryRuntimeState,
  type ExecuteRecoveryRuntimeState,
} from "./executeRecoveryRuntime";
import type { AgentLoopGuardRuntimeState } from "./loopGuardRuntimeState";
import { clearCrossIterationReadTrackingForTarget } from "./loopGuardRuntimeState";
import type { AgentLoopNoToolRuntimeState } from "./noToolRuntimeState";
import {
  applyRecoveringFromEmptyAssistantReplyRuntimeState,
  resetConsecutiveNoToolRuntimeState,
} from "./noToolRuntimeState";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import {
  applyToolResultPlanRuntimeState,
  resetPlanRecoveryPromptRuntimeState,
} from "./planRuntimeState";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import { resetTransientRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import type { AgentLoopToolExecutionRuntimeState } from "./toolExecutionRuntimeState";
import { partitionToolCallsForExecution } from "./toolCallPartitioning";
import { executeToolExecutionRound } from "./toolExecutionRound";
import { isVerificationEvidenceResult } from "./toolActivityTracking";
import { handleToolResultPostProcessing } from "./toolResultPostProcessing";
import { appendToolResultsToHistory } from "./toolResultHistory";
import type { TurnIterationContext } from "./turnIterationContext";
import type { UnityMcpRuntimeState } from "./unityMcpRuntime";
import {
  applyUnityMcpToolResultState,
  markUnityMcpToolCallsDetected,
} from "./unityMcpRuntime";

type WorkflowMode = "chat" | "edit" | "plan";
type ProviderReasoningForHistory = Parameters<typeof buildAssistantHistoryMessage>[1];

function observedReadResultRange(result: ToolExecutionResult) {
  const metadata = extractReadFileWindowMetadata(result.content || "");
  if (metadata) {
    return {
      startLine: metadata.returnedStartLine,
      endLine: metadata.returnedEndLine,
      maxLines: Math.max(1, metadata.returnedEndLine - metadata.returnedStartLine + 1),
    };
  }
  return requestedRangeFromReadObservationSignature(
    result.readFileObservation?.requestSignature || "",
  );
}

function buildReadProgressFingerprint(
  state: ExecuteRecoveryRuntimeState,
  result: ToolExecutionResult,
): ReadProgressFingerprint | null {
  if (result.name !== "read_file") return null;
  const detail = String(result.displayContent || result.content || "");
  const coverageKind = /^\s*READ_FILE_WINDOW_NARROWED\b/i.test(detail)
    ? "overlap_extension" as const
    : isReadOnlyNoProgressDetail(detail)
    ? "same_window" as const
    : "new_window" as const;
  const requestedRange = requestedRangeFromReadObservationSignature(
    result.readFileObservation?.requestSignature || "",
  );
  const target = String(result.target || state.expectedTarget || "")
    .replace(/\\/g, "/")
    .trim()
    .toLowerCase();
  const observedVersion = result.readFileObservation?.versionToken || null;
  const checkpoint = state.decisionCheckpoint
    ? { ...state.decisionCheckpoint }
    : null;
  const checkpointKey = checkpoint
    ? [
        checkpoint.expectedTarget || "",
        checkpoint.sourceObservationKey || "",
        checkpoint.nextRequiredCapability,
        checkpoint.evidenceVersion || "",
      ].join(":")
    : "none";
  const phase = resolveExecuteRecoveryActionContract(state.mode, {
    expectedTarget: state.expectedTarget,
    readLease: state.readLease,
    sourceObservationKey: state.sourceObservationKey,
    decisionCheckpoint: state.decisionCheckpoint,
    phaseNoProgressCount: state.phaseNoProgressCount,
    protocolNoProgressCount: state.protocolNoProgressCount,
    protocolNoProgressFingerprint: state.protocolNoProgressFingerprint,
  }).phase;
  const purpose = state.readLease?.purpose || "unleased";
  return {
    phase,
    target,
    observedVersion,
    purpose,
    coverage: requestedRange
      ? { kind: coverageKind, ...requestedRange }
      : { kind: coverageKind },
    decisionCheckpoint: checkpoint,
    semanticKey: [
      phase,
      target,
      observedVersion || "unknown-version",
      purpose,
      coverageKind,
      checkpointKey,
    ].join("::"),
  };
}

function buildRecoveryProtocolNoProgressFingerprint(
  state: ExecuteRecoveryRuntimeState,
  results: ToolExecutionResult[],
): { semanticKey: string; readProgress: ReadProgressFingerprint[] } {
  const target = String(state.expectedTarget || "")
    .replace(/\\/g, "/")
    .trim()
    .toLowerCase();
  const readProgress = results
    .map((result) => buildReadProgressFingerprint(state, result))
    .filter((item): item is ReadProgressFingerprint => item !== null);
  if (
    state.mode === "patch_recovery_read" &&
    results.some((result) =>
      result.name === "read_file" &&
      isReadOnlyNoProgressDetail(String(result.displayContent || result.content || ""))
    )
  ) {
    return {
      semanticKey: [
        buildPatchRecoveryReadNoProgressFingerprint(state.expectedTarget || ""),
        ...readProgress.map((item) => item.semanticKey),
      ].join("::"),
      readProgress,
    };
  }
  const resultKinds = results.map((result) => {
    const detail = String(result.displayContent || result.content || "");
    const category = /^\s*READ_FILE_WINDOW_NARROWED\b/i.test(detail)
      ? "read_overlap_extension"
      : isReadOnlyNoProgressDetail(detail)
      ? "read_unchanged"
      : result.internalFeedback
      ? `policy:${result.qualityGateReason || result.lifecycleState || "deferred"}`
      : result.isError
      ? "actual_failure"
      : "unchanged";
    return `${result.name}:${String(result.target || "").replace(/\\/g, "/").toLowerCase()}:${category}`;
  }).sort();
  return {
    semanticKey: [
      `${state.mode}::${target}::${resultKinds.join("|")}`,
      ...readProgress.map((item) => item.semanticKey),
    ].join("::"),
    readProgress,
  };
}

function normalizeLeaseBackedReadToolCalls(
  calls: ToolCallToExecute[],
  state: ExecuteRecoveryRuntimeState,
  contract: RecoveryActionContract,
): ToolCallToExecute[] {
  const lease = state.readLease;
  if (
    !lease ||
    (lease.state !== "available" && lease.state !== "active")
  ) {
    return calls;
  }
  if (contract.nextRequiredCapability !== "targeted_read") return calls;
  return calls.map((call) => {
    if (call.name !== "read_file") return call;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.arguments || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // The lease is authoritative even when a local model emitted malformed
      // or incomplete arguments for the required read capability.
    }
    const range = lease.requestedRange;
    const normalizedArgs: Record<string, unknown> = {
      ...args,
      path: lease.target,
      ...(range?.startLine ? { start_line: range.startLine } : {}),
      ...(range?.endLine ? { end_line: range.endLine } : {}),
      ...(range?.maxLines ? { max_lines: range.maxLines } : {}),
    };
    return {
      ...call,
      arguments: JSON.stringify(normalizedArgs),
    };
  });
}

type SetPlanRuntimePhase = (
  phase: PlanRuntimePhase,
  reason?: string,
  status?: "pending" | "running" | "done" | "failed",
) => void;

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

export type ToolCallExecutionPhaseResult =
  | {
      status: "aborted";
      noToolRuntimeState: AgentLoopNoToolRuntimeState;
      planRuntimeState: PlanLoopRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
      unityMcpRuntimeState: UnityMcpRuntimeState;
      evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
      allResults: ToolExecutionResult[];
      toolArgsByCallId: Map<string, Record<string, unknown>>;
      toolFailureSignatures: Map<string, string>;
    }
  | {
      status: "completed";
      noToolRuntimeState: AgentLoopNoToolRuntimeState;
      planRuntimeState: PlanLoopRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
      unityMcpRuntimeState: UnityMcpRuntimeState;
      evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
      allResults: ToolExecutionResult[];
      toolArgsByCallId: Map<string, Record<string, unknown>>;
      toolFailureSignatures: Map<string, string>;
      hasPlanDecisionOutput: boolean;
      unityMcpFallbackPrompt: string | null;
      remainingTaskText: string | null;
      successfulReadOnlyExplorationResultCount: number;
      isUnapprovedPlanReadOnlyBatch: boolean;
    };

export async function executeToolCallPhase(input: {
  callbacks: OrchestratorCallbacks;
  abortSignal: AbortSignal;
  workspace: string;
  iteration: number;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  effectiveToolCalls: ToolCallToExecute[];
  historyAssistantText: string;
  providerReasoningForHistory: ProviderReasoningForHistory;
  finalReplyOptionCount: number;
  hasStructuredProposal: boolean;
  iterationAllTools: ToolDefinition[];
  availableToolNames: Set<string>;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  toolPermissionPolicy: ToolPermissionPolicy;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  latestUserPromptText: string;
  managedAgentMessages: AgentMessage[];
  effectiveExecuteRecoveryFileRead: boolean;
  recoveryActionContract: RecoveryActionContract;
  hooksConfig: HooksConfig;
  turnInputContextSignals: TurnInputContextSignals;
  taskTargetingEvidence: Set<string>;
  unityConsoleDiagnosticsRequested: boolean;
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  unityMcpRuntimeState: UnityMcpRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  loopGuardRuntimeState: AgentLoopGuardRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  toolExecutionRuntimeState: AgentLoopToolExecutionRuntimeState;
  toolFeedbackFormat: ToolFeedbackFormat;
  failedToolCallCounts: Map<string, number>;
  buildCurrentTaskTargetingProfile: () => TaskTargetingProfile;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId" | "turnContext">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  markExecuteOperationEvidence: () => void;
  activateUnityMcpFallback: (reason: string) => void;
  setPlanRuntimePhase: SetPlanRuntimePhase;
  clearExecuteRecovery: (
    reason: string,
    resetTarget?: string,
    stateOverride?: ExecuteRecoveryRuntimeState,
  ) => ExecuteRecoveryRuntimeState;
}): Promise<ToolCallExecutionPhaseResult> {
  let noToolRuntimeState = resetConsecutiveNoToolRuntimeState(
    input.noToolRuntimeState,
  );
  let planRuntimeState = resetPlanRecoveryPromptRuntimeState(
    input.planRuntimeState,
  );
  let recoveryPromptState = resetTransientRecoveryPromptRuntimeState(
    input.recoveryPromptState,
  );
  let unityMcpRuntimeState = markUnityMcpToolCallsDetected(
    input.unityMcpRuntimeState,
  );
  let evidenceRuntimeState = input.evidenceRuntimeState;
  let executeRecoveryState = input.executeRecoveryState;
  let loopGuardRuntimeState = input.loopGuardRuntimeState;
  let approvedPlanRecoveryState = input.approvedPlanRecoveryState;
  const effectiveToolCalls = normalizeLeaseBackedReadToolCalls(
    input.effectiveToolCalls,
    executeRecoveryState,
    input.recoveryActionContract,
  );
  if (effectiveToolCalls.some((call, index) =>
    call.arguments !== input.effectiveToolCalls[index]?.arguments
  )) {
    logAgentEvent("execute_recovery_read_args_normalized", {
      iteration: input.iteration,
      target: executeRecoveryState.readLease?.target || executeRecoveryState.expectedTarget,
      purpose: executeRecoveryState.readLease?.purpose || null,
      requestedRange: executeRecoveryState.readLease?.requestedRange || null,
      coverageMode: executeRecoveryState.readLease?.coverageMode || "exact",
    });
  }
  const markExecuteOperationEvidenceAndSync = () => {
    input.markExecuteOperationEvidence();
    evidenceRuntimeState = markExecuteOperationEvidenceRuntimeState(
      evidenceRuntimeState,
    );
  };
  const clearExecuteRecoveryAndSync = (
    reason: string,
    resetTarget?: string,
  ) => {
    const recoveryWasActive = executeRecoveryState.mode !== "normal";
    executeRecoveryState = input.clearExecuteRecovery(
      reason,
      resetTarget,
      executeRecoveryState,
    );
    if (recoveryWasActive) {
      loopGuardRuntimeState = clearCrossIterationReadTrackingForTarget(
        loopGuardRuntimeState,
        resetTarget,
      );
    }
    return executeRecoveryState;
  };

  logAgentEvent("tool_calls_detected", {
    iteration: input.iteration,
    count: effectiveToolCalls.length,
    names: effectiveToolCalls.map((call) => call.name).slice(0, 12),
  });
  input.emitTaskOrchestratorPhase("EXECUTE_STEP", {
    iteration: input.iteration,
    toolCalls: effectiveToolCalls.length,
    toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 12),
  });

  const toolCallsForMsg: ToolCallInMessage[] = effectiveToolCalls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: tc.arguments,
    },
  }));

  input.callbacks.appendMessage(buildAssistantHistoryMessage(
    input.historyAssistantText,
    input.providerReasoningForHistory,
    { tool_calls: toolCallsForMsg },
  ));

  const partitionedToolCalls = await partitionToolCallsForExecution({
    toolCalls: effectiveToolCalls,
    workspace: input.workspace,
    callbacks: input.callbacks,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    planRuntimePhase: planRuntimeState.planRuntimePhase,
    availableToolNames: input.availableToolNames,
    toolCapabilityRegistry: input.toolCapabilityRegistry,
    toolPermissionPolicy: input.toolPermissionPolicy,
    recentPlanToolActivity: input.recentPlanToolActivity,
    recentToolActivity: input.recentToolActivity,
    attemptedPlanWriteTargets: input.attemptedPlanWriteTargets,
    latestUserPromptText: input.latestUserPromptText,
    managedAgentMessages: input.managedAgentMessages,
    failedToolCallCounts: input.failedToolCallCounts,
    buildCurrentTaskTargetingProfile: input.buildCurrentTaskTargetingProfile,
    ...approvedPlanRecoveryState,
    executeRecoveryState,
    recoveryActionContract: input.recoveryActionContract,
    effectiveExecuteRecoveryFileRead: input.effectiveExecuteRecoveryFileRead,
    ...input.toolExecutionRuntimeState,
    iterationContext: input.iterationContext,
    emitTurnEvent: input.emitTurnEvent,
  });
  const {
    readOnlyCalls,
    localFileReadCalls,
    specFileCalls,
    writeCalls,
    toolArgsByCallId,
    readOnlyCallSignatures,
    readFileWindowNarrowedNotes,
    toolFailureSignatures,
  } = partitionedToolCalls;
  const allResults: ToolExecutionResult[] = [
    ...partitionedToolCalls.preExecutionResults,
  ];

  const toolExecutionRound = await executeToolExecutionRound({
    readOnlyCalls,
    localFileReadCalls,
    specFileCalls,
    writeCalls,
    workspace: input.workspace,
    callbacks: input.callbacks,
    iteration: input.iteration,
    iterationAllTools: input.iterationAllTools,
    hooksConfig: input.hooksConfig,
    turnInputContextSignals: input.turnInputContextSignals,
    recentPlanToolActivity: input.recentPlanToolActivity,
    attemptedPlanWriteTargets: input.attemptedPlanWriteTargets,
    abortSignal: input.abortSignal,
    readOnlyCallSignatures,
    readFileWindowNarrowedNotes,
    ...input.toolExecutionRuntimeState,
  });
  allResults.push(...toolExecutionRound.results);
  const wasAborted = toolExecutionRound.status === "aborted";

  const recoveryStateAtBatchStart = executeRecoveryState;
  const activeRecoveryReadLease =
    recoveryStateAtBatchStart.readLease &&
    (recoveryStateAtBatchStart.readLease.state === "available" ||
      recoveryStateAtBatchStart.readLease.state === "active")
      ? recoveryStateAtBatchStart.readLease
      : null;
  const activePatchReadLease =
    recoveryStateAtBatchStart.mode === "patch_recovery_read" &&
    activeRecoveryReadLease?.purpose === "patch_recovery"
      ? activeRecoveryReadLease
      : null;
  const freshReadResult = allResults.find((result) => {
    if (result.name !== "read_file" || result.isError || result.internalFeedback) return false;
    const detail = String(result.displayContent || result.content || "");
    const overlapExtension = /^\s*READ_FILE_WINDOW_NARROWED\b/i.test(detail);
    const satisfiesActiveReadLease = Boolean(
      activeRecoveryReadLease &&
      readEvidenceSatisfiesRecoveryLease({
        lease: activeRecoveryReadLease,
        target: result.target,
        requestedRange: observedReadResultRange(result),
        observedVersion: result.readFileObservation?.versionToken || null,
      })
    );
    // Keep a real overlapping window visible to the recovery state machine
    // while a lease is active. It may carry a newer file version even when it
    // cannot satisfy the old range/version identity; the transition then
    // invalidates the stale lease and returns to structural targeting.
    if (overlapExtension && !satisfiesActiveReadLease && !activeRecoveryReadLease) return false;
    if (result.readFileObservation?.source === "stub" && satisfiesActiveReadLease) {
      return true;
    }
    return result.readFileObservation?.source
      ? result.readFileObservation.source !== "stub"
      : !isReadOnlyNoProgressDetail(detail);
  });
  const mutationResult = allResults.find((result) =>
    !result.internalFeedback && isProjectSourceWriteResult(result)
  );
  const validationResult = allResults.find(isVerificationEvidenceResult);
  const recoveryIterationBudgetNeutral =
    executeRecoveryState.mode !== "normal" &&
    allResults.length > 0 &&
    allResults.every((result) =>
      result.internalFeedback === true ||
      (
        result.name === "read_file" &&
        !result.isError &&
        isReadOnlyNoProgressDetail(String(result.displayContent || result.content || ""))
      ) ||
      (
        ["read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status"].includes(result.name) &&
        !result.isError
      )
    );
  const expectedRecoveryTarget = executeRecoveryState.expectedTarget || (
    executeRecoveryState.mode === "patch_recovery_read"
      ? resolveExecutePatchRecoveryTarget(input.recentToolActivity)
      : null
  );
  const attemptedPatchRecoveryRead = Boolean(
    activePatchReadLease?.state === "available" &&
    allResults.some((result) =>
      result.name === "read_file" &&
      readEvidenceSatisfiesRecoveryLease({
        lease: activePatchReadLease,
        target: result.target,
        requestedRange: observedReadResultRange(result),
        observedVersion: result.readFileObservation?.versionToken || null,
      })
    )
  );
  if (attemptedPatchRecoveryRead && executeRecoveryState.readLease) {
    executeRecoveryState = {
      ...executeRecoveryState,
      readLease: { ...executeRecoveryState.readLease, state: "active" },
    };
  }
  const recoveryTransition = transitionExecuteRecoveryRuntimeState(
    executeRecoveryState,
    {
      expectedTarget: expectedRecoveryTarget,
      freshReadTarget: freshReadResult?.target,
      sourceObservationKey: freshReadResult?.readFileObservation?.key,
      sourceRequestedRange: freshReadResult
        ? observedReadResultRange(freshReadResult)
        : null,
      sourceObservedVersion: freshReadResult?.readFileObservation?.versionToken || null,
      sourceRangeWasRuntimeNarrowed: freshReadResult
        ? /^\s*READ_FILE_WINDOW_NARROWED\b/i.test(String(
            freshReadResult.displayContent || freshReadResult.content || "",
          ))
        : false,
      mutationTarget: mutationResult?.target,
      validationTarget: validationResult?.target || validationResult?.name,
      validationToolName: validationResult?.name,
    },
  );
  if (recoveryTransition.transition === "validation_to_normal") {
    executeRecoveryState = clearExecuteRecoveryAndSync(
      "recovery_validation_observed",
      recoveryTransition.target || undefined,
    );
  } else if (recoveryTransition.transition !== "none") {
    const previousMode = executeRecoveryState.mode;
    executeRecoveryState = recoveryTransition.state;
    logAgentEvent("execute_recovery_phase_transition", {
      iteration: input.iteration,
      transition: recoveryTransition.transition,
      previousMode,
      nextMode: executeRecoveryState.mode,
      target: recoveryTransition.target,
      executeRecoveryAttempts: executeRecoveryState.attempts,
    });
  } else if (recoveryIterationBudgetNeutral) {
    executeRecoveryState = refundExecuteRecoveryRuntimeIteration(recoveryTransition.state);
    const ptyWaitOnly = allResults.every((result) =>
      ["read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status"].includes(result.name) &&
      !result.isError
    );
    let semanticNoProgressFingerprint: string | null = null;
    if (!ptyWaitOnly) {
      const protocolFingerprint = buildRecoveryProtocolNoProgressFingerprint(
        executeRecoveryState,
        allResults,
      );
      semanticNoProgressFingerprint =
        executeRecoveryState.reason === "approved_plan_scope_blocked" &&
        executeRecoveryState.protocolNoProgressFingerprint
          ? executeRecoveryState.protocolNoProgressFingerprint
          : protocolFingerprint.semanticKey;
      executeRecoveryState = registerExecuteRecoveryProtocolNoProgress(
        executeRecoveryState,
        semanticNoProgressFingerprint,
      );
      logAgentEvent("execute_recovery_read_progress_fingerprint", {
        iteration: input.iteration,
        fingerprints: protocolFingerprint.readProgress,
      });
    }
    logAgentEvent("execute_recovery_phase_budget_preserved", {
      iteration: input.iteration,
      mode: executeRecoveryState.mode,
      reason: "policy_deferral_cache_stub_or_pty_wait",
      phaseNoProgressCount: executeRecoveryState.phaseNoProgressCount,
      protocolNoProgressCount: executeRecoveryState.protocolNoProgressCount,
      protocolNoProgressFingerprint: executeRecoveryState.protocolNoProgressFingerprint,
      semanticNoProgressFingerprint,
      resultKinds: allResults.map((result) => ({
        name: result.name,
        internalFeedback: result.internalFeedback === true,
        isError: result.isError === true,
        qualityGateReason: result.qualityGateReason || null,
      })),
    });
  } else if (recoveryTransition.state !== executeRecoveryState) {
    // A known patch target remains part of the transaction even if the model
    // attempted an unrelated read or mutation that cannot advance the phase.
    executeRecoveryState = recoveryTransition.state;
  }

  const hasPlanDecisionOutput =
    input.hasStructuredProposal ||
    input.finalReplyOptionCount > 0 ||
    isReviewablePlanStage(input.callbacks.getPlanStage()) ||
    allResults.some(isSuccessfulPlanArtifactWriteResult);
  const toolResultPostProcessing = handleToolResultPostProcessing({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: allResults,
    toolArgsByCallId,
    taskTargetingEvidence: input.taskTargetingEvidence,
    recentToolActivity: input.recentToolActivity,
    recentPlanToolActivity: input.recentPlanToolActivity,
    ...planRuntimeState,
    hasPlanDecisionOutput,
    unityConsoleDiagnosticsRequested: input.unityConsoleDiagnosticsRequested,
    unityConsoleFinalVerificationRequired:
      unityMcpRuntimeState.consoleFinalVerificationRequired,
    unityConsoleRefreshObservedAfterWrite:
      unityMcpRuntimeState.consoleRefreshObservedAfterWrite,
    unityMcpForceConsoleFirstPending:
      unityMcpRuntimeState.forceConsoleFirstPending,
    unityConsoleMissingFirstToolRepromptIssued:
      unityMcpRuntimeState.consoleMissingFirstToolRepromptIssued,
    recentSuccessfulProjectWrite:
      evidenceRuntimeState.recentSuccessfulProjectWrite,
    recoveringFromEmptyAssistantReplyAfterWrite:
      noToolRuntimeState.recoveringFromEmptyAssistantReplyAfterWrite,
    ...approvedPlanRecoveryState,
    markExecuteOperationEvidence: markExecuteOperationEvidenceAndSync,
    activateUnityMcpFallback: input.activateUnityMcpFallback,
    setPlanRuntimePhase: input.setPlanRuntimePhase,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
  });
  evidenceRuntimeState = applyRecentSuccessfulProjectWriteRuntimeState(
    evidenceRuntimeState,
    toolResultPostProcessing,
  );
  noToolRuntimeState = applyRecoveringFromEmptyAssistantReplyRuntimeState(
    noToolRuntimeState,
    toolResultPostProcessing,
  );
  unityMcpRuntimeState = applyUnityMcpToolResultState(
    unityMcpRuntimeState,
    toolResultPostProcessing,
  );
  planRuntimeState = applyToolResultPlanRuntimeState(
    planRuntimeState,
    toolResultPostProcessing,
  );
  approvedPlanRecoveryState = applyApprovedPlanToolResultRecoveryState(
    approvedPlanRecoveryState,
    toolResultPostProcessing,
  );

  if (wasAborted) {
    // The assistant tool_calls message is already in history. Close every call
    // before pausing so native providers never receive dangling tool calls on
    // resume. Only observed results participate in evidence/recovery folding;
    // unstarted calls are protocol-only internal feedback.
    const observedToolCallIds = new Set(allResults.map((result) => result.toolCallId));
    const protocolResults = [
      ...allResults,
      ...effectiveToolCalls
        .filter((call) => !observedToolCallIds.has(call.id))
        .map((call): ToolExecutionResult => {
          const args = toolArgsByCallId.get(call.id) || {};
          const target = String(
            args.path || args.command || args.url || args.query || call.name,
          ).trim();
          return {
            toolCallId: call.id,
            name: call.name,
            target,
            content:
              "TOOL_CALL_ABORTED: The run was stopped before this tool call started. Resume in the same turn if it is still needed.",
            isError: true,
            lifecycleState: "blocked",
            internalFeedback: true,
          };
        }),
    ];
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: protocolResults,
      toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    return {
      status: "aborted",
      noToolRuntimeState,
      planRuntimeState,
      recoveryPromptState,
      unityMcpRuntimeState,
      evidenceRuntimeState,
      executeRecoveryState,
      loopGuardRuntimeState,
      approvedPlanRecoveryState,
      allResults: protocolResults,
      toolArgsByCallId,
      toolFailureSignatures,
    };
  }

  return {
    status: "completed",
    noToolRuntimeState,
    planRuntimeState,
    recoveryPromptState,
    unityMcpRuntimeState,
    evidenceRuntimeState,
    executeRecoveryState,
    loopGuardRuntimeState,
    approvedPlanRecoveryState,
    allResults,
    toolArgsByCallId,
    toolFailureSignatures,
    hasPlanDecisionOutput,
    unityMcpFallbackPrompt: toolResultPostProcessing.unityMcpFallbackPrompt,
    remainingTaskText: toolResultPostProcessing.remainingTaskText,
    successfulReadOnlyExplorationResultCount:
      toolResultPostProcessing.successfulReadOnlyExplorationResultCount,
    isUnapprovedPlanReadOnlyBatch:
      toolResultPostProcessing.isUnapprovedPlanReadOnlyBatch,
  };
}
