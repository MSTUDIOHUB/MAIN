import {
  isReviewablePlanStage,
  isSuccessfulPlanArtifactWriteResult,
  logAgentEvent,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import type { ToolCapabilityRegistry, ToolPermissionPolicy } from "../../toolCapabilities";
import type { MainThreadEventInput, ToolFeedbackFormat } from "../../turnEvents";
import type { TurnInputContextSignals } from "../../turnIntake";
import type {
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
  PlanRuntimePhase,
} from "../../workflowModels";
import { buildPlanTaskEvidenceAudit } from "../../workflowModels";
import type { OrchestratorCallbacks, ToolCallToExecute, ToolExecutionResult } from "../types";
import type { ApprovedPlanNoProgressDecision } from "./loopRecovery";
import {
  handleCrossIterationReadFileLoopRecovery,
  handleExecuteConvergencePrompt,
  handleNoProgressRecovery,
  handleReadFileRepeatLimitRecovery,
  handleRepeatedEditValidationRecovery,
  handleStrictRepeatGuardRecovery,
  handleTargetProgressLoopRecovery,
} from "./loopRecovery";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import {
  applyCrossIterationReadFileRecoveryState,
  setRepeatedEditValidationRecoveryAttempts,
} from "./executeRecoveryRuntime";
import type {
  PlanLoopRuntimeState,
  PlanRuntimePhaseQualitySnapshot,
} from "./planRuntimeState";
import {
  applyPlanQualityRuntimeState,
  applyPlanReadOnlyConvergenceRuntimeState,
  applyPlanRuntimePhase,
} from "./planRuntimeState";
import type { AgentLoopGuardRuntimeState } from "./loopGuardRuntimeState";
import {
  applyNoProgressTrackingRuntimeState,
  applyToolFailureSignatureRuntimeState,
  getNoProgressTrackingRuntimeState,
} from "./loopGuardRuntimeState";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import { applyExecuteConvergencePromptState } from "./recoveryPromptRuntimeState";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import type { ApprovedPlanRecoveryRuntimeState } from "./approvedPlanRecoveryRuntime";
import {
  handlePlanQualityRecoveryAfterToolResults,
  shouldPauseForReviewablePlanArtifactAfterToolResults,
} from "./planQualityRecovery";
import { handlePlanReadOnlyConvergence } from "./planConvergence";
import { appendToolResultsToHistory } from "./toolResultHistory";
import type { TurnIterationContext } from "./turnIterationContext";

type WorkflowMode = "chat" | "edit" | "plan";

type SetPlanRuntimePhase = (
  phase: PlanRuntimePhase,
  reason?: string,
  status?: "pending" | "running" | "done" | "failed",
  qualitySnapshot?: PlanRuntimePhaseQualitySnapshot,
) => void;

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

type EmitPlanExecutionProgress = (
  phase: PlanExecutionProgressPhase,
  overrides?: Partial<PlanExecutionProgressUpdate>,
) => void;

type ActivateExecuteRecovery = (
  mode: Exclude<ExecuteRecoveryRuntimeState["mode"], "normal">,
  reason: string,
  context?: Record<string, unknown>,
) => ExecuteRecoveryRuntimeState;

type ActivateChatFinalSynthesis = (
  reason: string,
  context?: Record<string, unknown>,
) => void;

type ApprovedPlanNoProgressAction = (input: ApprovedPlanNoProgressDecision) => void;
type ApprovedPlanNoProgressRecoveryAction = (
  input: ApprovedPlanNoProgressDecision,
) => ApprovedPlanRecoveryRuntimeState;

export type ToolResultRecoveryPhaseResult =
  | {
      status: "continue" | "stopped" | "plan_completed";
      planRuntimeState: PlanLoopRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
      approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
      completionAudit?: { completedCount: number; totalCount: number };
    }
  | {
      status: "completed";
      planRuntimeState: PlanLoopRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
      approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
      completionAudit?: { completedCount: number; totalCount: number };
    };

export async function handleToolResultRecoveryPhase(input: {
  callbacks: OrchestratorCallbacks;
  workspace: string;
  activeProfile: string;
  toolFeedbackFormat: ToolFeedbackFormat;
  toolPermissionPolicy: ToolPermissionPolicy;
  workflowMode: WorkflowMode;
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  effectiveMaxIterations: number;
  effectiveToolCalls: ToolCallToExecute[];
  results: ToolExecutionResult[];
  toolArgsByCallId: Map<string, Record<string, unknown>>;
  toolFailureSignatures: Map<string, string>;
  hasPlanDecisionOutput: boolean;
  unityMcpFallbackPrompt: string | null;
  remainingTaskText: string | null;
  successfulReadOnlyExplorationResultCount: number;
  isUnapprovedPlanReadOnlyBatch: boolean;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  latestUserPromptText: string;
  availableToolNames: Set<string>;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  snapshotContextLimit?: number;
  repairExecutionRequestInChat: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  planRuntimeState: PlanLoopRuntimeState;
  loopGuardRuntimeState: AgentLoopGuardRuntimeState;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId" | "turnContext">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTurnFailedEvent: (message: string) => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
  activateExecuteRecovery: ActivateExecuteRecovery;
  activateChatFinalSynthesis: ActivateChatFinalSynthesis;
  continueApprovedPlanWithStrategySwitch: ApprovedPlanNoProgressRecoveryAction;
  pauseApprovedPlanNoProgressLoop: ApprovedPlanNoProgressAction;
  setPlanRuntimePhase: SetPlanRuntimePhase;
  pauseForReviewablePlanArtifact: (
    trigger: string,
    runtimeStateOverride?: Pick<PlanLoopRuntimeState, "planArtifactQualityRejected">,
  ) => Promise<"not_reviewable" | "stopped" | "approved_continue">;
}): Promise<ToolResultRecoveryPhaseResult> {
  let planRuntimeState = input.planRuntimeState;
  let loopGuardRuntimeState = input.loopGuardRuntimeState;
  let executeRecoveryState = input.executeRecoveryState;
  let recoveryPromptState = input.recoveryPromptState;
  let approvedPlanRecoveryState = input.approvedPlanRecoveryState;
  let completionAudit: { completedCount: number; totalCount: number } | undefined;
  const activateExecuteRecoveryAndSync: ActivateExecuteRecovery = (mode, reason, context) => {
    // The callback updates the outer loop immediately. Mirror the returned
    // state locally so this phase cannot fold an older `normal` state back over
    // the activation when it returns.
    executeRecoveryState = input.activateExecuteRecovery(mode, reason, context);
    return executeRecoveryState;
  };
  const setPlanRuntimePhaseAndSync: SetPlanRuntimePhase = (
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

  const planQualityRecovery = handlePlanQualityRecoveryAfterToolResults({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    iteration: input.iteration,
    results: input.results,
    ...planRuntimeState,
    recentPlanToolActivity: input.recentPlanToolActivity,
    attemptedPlanWriteTargets: input.attemptedPlanWriteTargets,
    latestUserPromptText: input.latestUserPromptText,
    setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
  });
  planRuntimeState = applyPlanQualityRuntimeState(
    planRuntimeState,
    planQualityRecovery,
  );
  const pendingPlanRuntimeRecoveryPrompt = planQualityRecovery.pendingPlanRuntimeRecoveryPrompt;

  // Codex-style Plan execution is runtime-owned: once every task in the
  // approved revision has fresh trusted evidence, do not spend another model
  // turn asking it to narrate or declare completion.  Persist the current tool
  // results first, then close the execution lease deterministically.
  if (input.workflowMode === "plan" && input.callbacks.getIsPlanApproved()) {
    const audit = buildPlanTaskEvidenceAudit({
      tasks: input.callbacks.getPlanTasks(),
      evidenceLedger: input.callbacks.getPlanExecutionEvidenceLedger(),
      highlightNext: true,
    });
    if (
      audit.totalCount > 0 &&
      audit.allTrustedComplete &&
      !audit.pendingExternalValidation
    ) {
      appendToolResultsToHistory({
        callbacks: input.callbacks,
        toolFeedbackFormat: input.toolFeedbackFormat,
        results: input.results,
        toolArgsByCallId: input.toolArgsByCallId,
        iterationContext: input.iterationContext,
        emitTurnEvent: input.emitTurnEvent,
      });
      input.emitTaskOrchestratorPhase("DONE", {
        reason: "plan_evidence_complete_after_tool",
        iteration: input.iteration,
        completed: audit.completedCount,
        total: audit.totalCount,
      });
      input.emitPlanExecutionProgress("completed", {
        currentTask: "",
        currentTool: "",
        nextStep: "",
      });
      input.callbacks.onPlanStageChanged("completed");
      logAgentEvent("plan_execution_completed_from_runtime_evidence", {
        iteration: input.iteration,
        completed: audit.completedCount,
        total: audit.totalCount,
        evidenceCount: input.callbacks.getPlanExecutionEvidenceLedger().length,
        modelCompletionClaimRequired: false,
      });
      completionAudit = {
        completedCount: audit.completedCount,
        totalCount: audit.totalCount,
      };
      return finish("plan_completed");
    }
  }

  const noProgressRecovery = handleNoProgressRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    recentToolActivity: input.recentToolActivity,
    recentPlanToolActivity: input.recentPlanToolActivity,
    sawExecuteOperationEvidence:
      input.evidenceRuntimeState.sawExecuteOperationEvidence,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    repairExecutionRequestInChat: input.repairExecutionRequestInChat,
    latestUserPromptText: input.latestUserPromptText,
    isUnapprovedPlanReadOnlyBatch: input.isUnapprovedPlanReadOnlyBatch,
    planReadOnlyConvergenceBatches: planRuntimeState.planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools: planRuntimeState.planReadOnlyConvergenceTools,
    remainingTaskText: input.remainingTaskText,
    approvedPlanNoProgressRecoveryAttempts:
      input.approvedPlanRecoveryState.approvedPlanNoProgressRecoveryAttempts,
    tracking: getNoProgressTrackingRuntimeState(loopGuardRuntimeState),
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    activateChatFinalSynthesis: input.activateChatFinalSynthesis,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
  });
  loopGuardRuntimeState = applyNoProgressTrackingRuntimeState(
    loopGuardRuntimeState,
    noProgressRecovery.tracking,
  );
  if (noProgressRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (noProgressRecovery.status === "continue") {
    return finish("continue");
  }
  let pendingExecuteRecoveryPrompt = noProgressRecovery.pendingExecuteRecoveryPrompt;
  let pendingExecuteNoProgressPause = noProgressRecovery.pendingExecuteNoProgressPause;
  const approvedPlanNoProgressDecision = noProgressRecovery.approvedPlanNoProgressDecision;

  loopGuardRuntimeState = applyToolFailureSignatureRuntimeState(
    loopGuardRuntimeState,
    {
      results: input.results,
      toolFailureSignatures: input.toolFailureSignatures,
    },
  );

  appendToolResultsToHistory({
    callbacks: input.callbacks,
    toolFeedbackFormat: input.toolFeedbackFormat,
    results: input.results,
    toolArgsByCallId: input.toolArgsByCallId,
    iterationContext: input.iterationContext,
    emitTurnEvent: input.emitTurnEvent,
  });

  const readFileRepeatLimitRecovery = handleReadFileRepeatLimitRecovery({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    recentPlanToolActivity: input.recentPlanToolActivity,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
  });
  if (readFileRepeatLimitRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (readFileRepeatLimitRecovery.status === "pending_prompt") {
    pendingExecuteRecoveryPrompt = readFileRepeatLimitRecovery.prompt;
  }

  const crossIterationReadFileRecovery = handleCrossIterationReadFileLoopRecovery({
    callbacks: input.callbacks,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    snapshotContextLimit: input.snapshotContextLimit,
    crossIterationFileReads: loopGuardRuntimeState.crossIterationFileReads,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    consecutiveBlockedReadFileInRecoveryCount:
      executeRecoveryState.consecutiveBlockedReadFileCount,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  executeRecoveryState = applyCrossIterationReadFileRecoveryState(executeRecoveryState, {
    mode: crossIterationReadFileRecovery.executeRecoveryMode,
    reason: crossIterationReadFileRecovery.executeRecoveryReason,
    consecutiveBlockedReadFileCount:
      crossIterationReadFileRecovery.consecutiveBlockedReadFileInRecoveryCount,
  });

  if (input.unityMcpFallbackPrompt) {
    input.callbacks.appendMessage({
      role: "user",
      content: input.unityMcpFallbackPrompt,
    });
  }

  const repeatedEditValidationRecovery = handleRepeatedEditValidationRecovery({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    availableToolNames: input.availableToolNames,
    recentToolActivity: input.recentToolActivity,
    successfulEditTargetsSinceVerification:
      loopGuardRuntimeState.successfulEditTargetsSinceVerification,
    repeatedEditValidationRecoveryAttempts:
      executeRecoveryState.repeatedEditValidationAttempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    emitPlanExecutionProgress: input.emitPlanExecutionProgress,
  });
  executeRecoveryState = setRepeatedEditValidationRecoveryAttempts(
    executeRecoveryState,
    repeatedEditValidationRecovery.repeatedEditValidationRecoveryAttempts,
  );
  if (repeatedEditValidationRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (repeatedEditValidationRecovery.status === "pending_prompt") {
    input.callbacks.appendMessage({
      role: "user",
      content: repeatedEditValidationRecovery.prompt,
    });
    return finish("continue");
  }
  if (pendingExecuteRecoveryPrompt) {
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: pendingExecuteRecoveryPrompt,
    });
    return finish("continue");
  }
  if (pendingExecuteNoProgressPause) {
    input.callbacks.onNonActionableStop(
      pendingExecuteNoProgressPause.notice,
      "no_action",
      {
        progressSignature: pendingExecuteNoProgressPause.progressSignature,
        repeatedTargets: pendingExecuteNoProgressPause.repeatedTargets,
        recoveryReason: pendingExecuteNoProgressPause.reason,
        nextStep: input.callbacks.getPreferredLanguage() === "zh"
          ? "复用已读上下文，转向写入/命令/浏览器验证，或说明真实阻塞"
          : "reuse cached context and pivot to patch/run/browser validation, or state the real blocker",
      },
    );
    input.callbacks.onStatusChange("idle");
    return finish("stopped");
  }
  if (pendingPlanRuntimeRecoveryPrompt) {
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: pendingPlanRuntimeRecoveryPrompt,
    });
    return finish("continue");
  }

  if (approvedPlanNoProgressDecision) {
    if (approvedPlanNoProgressDecision.action === "recover") {
      approvedPlanRecoveryState = input.continueApprovedPlanWithStrategySwitch(
        approvedPlanNoProgressDecision,
      );
      return finish("continue");
    }
    input.pauseApprovedPlanNoProgressLoop(approvedPlanNoProgressDecision);
    return finish("stopped");
  }

  const planReadOnlyConvergence = handlePlanReadOnlyConvergence({
    callbacks: input.callbacks,
    iteration: input.iteration,
    isUnapprovedPlanReadOnlyBatch: input.isUnapprovedPlanReadOnlyBatch,
    hasPlanDecisionOutput: input.hasPlanDecisionOutput,
    successfulReadOnlyExplorationResultCount:
      input.successfulReadOnlyExplorationResultCount,
    planReadOnlyConvergenceBatches: planRuntimeState.planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools: planRuntimeState.planReadOnlyConvergenceTools,
    usedPlanReadOnlyConvergencePrompt:
      planRuntimeState.usedPlanReadOnlyConvergencePrompt,
    turnInputContextSignals: input.turnInputContextSignals,
    recentPlanToolActivity: input.recentPlanToolActivity,
    lastAssistantTextForCheckpoint:
      input.evidenceRuntimeState.lastAssistantTextForCheckpoint,
    setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
  });
  planRuntimeState = applyPlanReadOnlyConvergenceRuntimeState(
    planRuntimeState,
    planReadOnlyConvergence,
  );
  if (planReadOnlyConvergence.status === "continue") {
    return finish("continue");
  }

  if (shouldPauseForReviewablePlanArtifactAfterToolResults({
    workflowMode: input.workflowMode,
    isPlanApproved: input.callbacks.getIsPlanApproved(),
    planArtifactQualityRejected: planRuntimeState.planArtifactQualityRejected,
    results: input.results,
  })) {
    const currentStage = input.callbacks.getPlanStage();
    if (isReviewablePlanStage(currentStage)) {
      const reviewResult = await input.pauseForReviewablePlanArtifact(
        "post_tool_plan_artifact_write",
        {
          // The outer loop folds this phase only after it returns. Use the
          // current batch's already-folded quality state so an accepted
          // rewrite can enter review immediately instead of seeing stale true.
          planArtifactQualityRejected: planRuntimeState.planArtifactQualityRejected,
        },
      );
      if (reviewResult === "approved_continue") return finish("continue");
      if (reviewResult === "stopped") return finish("stopped");
    } else {
      logAgentEvent("plan_artifact_write_not_reviewable_after_tool", {
        iteration: input.iteration,
        planStage: currentStage,
        targets: input.results
          .filter(isSuccessfulPlanArtifactWriteResult)
          .map((result) => result.target)
          .slice(0, 6),
      });
    }
  }

  if (
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved() &&
    input.results.some((result) => !result.isError)
  ) {
    input.callbacks.onPlanStageChanged("executing");
  }

  if (input.workflowMode === "plan" && input.callbacks.getIsPlanApproved()) {
    if (input.results.some((result) => result.isError)) {
      input.emitPlanExecutionProgress("tool_error");
    } else if (input.results.some((result) => !result.isError)) {
      input.emitPlanExecutionProgress("tool_done");
    }
  }

  const strictRepeatGuardRecovery = handleStrictRepeatGuardRecovery({
    callbacks: input.callbacks,
    workspace: input.workspace,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    effectiveToolCalls: input.effectiveToolCalls,
    recentToolCalls: loopGuardRuntimeState.recentToolCalls,
    repeatGuardRecoveredSignatures:
      loopGuardRuntimeState.repeatGuardRecoveredSignatures,
    failedToolCallCounts: loopGuardRuntimeState.failedToolCallCounts,
    recentPlanToolActivity: input.recentPlanToolActivity,
    availableToolNames: input.availableToolNames,
    toolCapabilityRegistry: input.toolCapabilityRegistry,
    toolPermissionPolicy: input.toolPermissionPolicy,
    emitTurnFailedEvent: input.emitTurnFailedEvent,
  });
  if (strictRepeatGuardRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (strictRepeatGuardRecovery.status === "continue") {
    return finish("continue");
  }

  const targetProgressLoopRecovery = handleTargetProgressLoopRecovery({
    callbacks: input.callbacks,
    workspace: input.workspace,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    results: input.results,
    effectiveToolCalls: input.effectiveToolCalls,
    recentTargetToolCalls: loopGuardRuntimeState.recentTargetToolCalls,
    targetProgressGuardRecoveredSignatures:
      loopGuardRuntimeState.targetProgressGuardRecoveredSignatures,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  if (targetProgressLoopRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (targetProgressLoopRecovery.status === "continue") {
    return finish("continue");
  }

  const executeConvergencePrompt = handleExecuteConvergencePrompt({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    effectiveMaxIterations: input.effectiveMaxIterations,
    usedExecuteConvergencePrompt: recoveryPromptState.usedExecuteConvergencePrompt,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryMode: executeRecoveryState.mode,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  recoveryPromptState = applyExecuteConvergencePromptState(
    recoveryPromptState,
    executeConvergencePrompt,
  );

  logAgentEvent("post_tool_result_continuation", {
    stage: "loop_continue",
    iteration: input.iteration,
    nextIteration: input.iteration + 1,
    pendingExecuteRecovery: !!pendingExecuteRecoveryPrompt,
    pendingPlanRecovery: !!pendingPlanRuntimeRecoveryPrompt,
    usedExecuteConvergencePrompt: recoveryPromptState.usedExecuteConvergencePrompt,
    repeatedEditTargets: Array.from(
      loopGuardRuntimeState.successfulEditTargetsSinceVerification.entries(),
    ).slice(-6),
    runtimeIntent: input.runtimeIntent,
    workflowMode: input.workflowMode,
    planApproved: input.callbacks.getIsPlanApproved(),
  });

  return finish("completed");

  function finish(
    status: ToolResultRecoveryPhaseResult["status"],
  ): ToolResultRecoveryPhaseResult {
    return {
      status,
      planRuntimeState,
      loopGuardRuntimeState,
      executeRecoveryState,
      recoveryPromptState,
      approvedPlanRecoveryState,
      ...(completionAudit ? { completionAudit } : {}),
    };
  }
}
