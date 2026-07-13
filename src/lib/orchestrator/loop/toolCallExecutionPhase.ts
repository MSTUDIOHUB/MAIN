import type { HooksConfig } from "../../hooks";
import {
  buildAssistantHistoryMessage,
  isReviewablePlanStage,
  isSuccessfulPlanArtifactWriteResult,
  logAgentEvent,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
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
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
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
  allowApprovedPlanRecoveryFileRead: boolean;
  effectiveExecuteRecoveryFileRead: boolean;
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
    count: input.effectiveToolCalls.length,
    names: input.effectiveToolCalls.map((call) => call.name).slice(0, 12),
  });
  input.emitTaskOrchestratorPhase("EXECUTE_STEP", {
    iteration: input.iteration,
    toolCalls: input.effectiveToolCalls.length,
    toolNames: input.effectiveToolCalls.map((call) => call.name).slice(0, 12),
  });

  const toolCallsForMsg: ToolCallInMessage[] = input.effectiveToolCalls.map((tc) => ({
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
    toolCalls: input.effectiveToolCalls,
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
    allowApprovedPlanRecoveryFileRead: input.allowApprovedPlanRecoveryFileRead,
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
    clearExecuteRecovery: clearExecuteRecoveryAndSync,
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
      ...input.effectiveToolCalls
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
