import {
  buildExecuteMaxIterationsAutoResumeNotice,
  buildExecuteMaxIterationsPauseNotice,
  buildPlanMaxIterationsAutoResumeNotice,
  buildPlanMaxIterationsCheckpoint,
  buildPlanMaxIterationsPauseNotice,
  buildPlanProgressSignatureFromToolActivity,
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import {
  resolveExecuteRecoveryActionContract,
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import type { ResolvedUserIntent } from "../../runIntent";
import type {
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
} from "../../workflowModels";
import { logAgentEvent, truncateForLog } from "../../orchestrator";
import type {
  MaxIterationsCheckpointHandling,
  OrchestratorCallbacks,
} from "../types";
import {
  hasDurableExecutionProgress,
  scopeExecutionEvidenceLedger,
} from "../../verificationEvidence";
import { resolveDevServerRuntimeState } from "../../devServerRuntime";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";

export type MaxIterationBoundaryResult = {
  status: "handled";
};

async function resolveCheckpointHandling(
  checkpoint: ReturnType<typeof buildPlanMaxIterationsCheckpoint>,
  handler?: (
    value: ReturnType<typeof buildPlanMaxIterationsCheckpoint>,
  ) => MaxIterationsCheckpointHandling | Promise<MaxIterationsCheckpointHandling>,
  getAutoResumeCount?: () => number,
) {
  const handling = await handler?.(checkpoint);
  const explicitAutoResume = checkpoint.autoResumeEligible &&
    typeof handling === "object" &&
    handling.status === "auto_resume_scheduled";
  const effectiveAutoResumeCount = explicitAutoResume
    ? Math.max(checkpoint.autoResumeCount, handling.checkpoint.autoResumeCount)
    : Math.max(checkpoint.autoResumeCount, getAutoResumeCount?.() ?? checkpoint.autoResumeCount);
  return {
    handled: handling === true || explicitAutoResume,
    autoResumeScheduled: checkpoint.autoResumeEligible && (
      explicitAutoResume ||
      (handling === true && effectiveAutoResumeCount > checkpoint.autoResumeCount)
    ),
    checkpoint: { ...checkpoint, autoResumeCount: effectiveAutoResumeCount },
  };
}

export async function handleMaxIterationBoundary(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  effectiveMaxIterations: number;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  lastAssistantTextForCheckpoint: string;
  sawExecuteOperationEvidence: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryState?: ExecuteRecoveryRuntimeState | null;
  transactionId?: string | null;
  emitPlanExecutionProgress: (
    phase: PlanExecutionProgressPhase,
    overrides?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
  emitRunPausedEvent: (reason: string, message: string) => void;
}): Promise<MaxIterationBoundaryResult> {
  const {
    callbacks,
    workflowMode,
    runtimeIntent,
    effectiveMaxIterations,
    recentPlanToolActivity,
    recentToolActivity,
    lastAssistantTextForCheckpoint,
    sawExecuteOperationEvidence,
    executeRecoveryMode,
    emitPlanExecutionProgress,
    emitRunPausedEvent,
  } = input;

  // Approved Plan execution uses the normal execute workflow. Plan-specific
  // checkpointing is selected from durable approval provenance, not mode.
  const approvedPlanBoundary = callbacks.getIsPlanApproved();
  if (approvedPlanBoundary || workflowMode === "edit") {
    const isPlanBoundary = approvedPlanBoundary;
    const recentActivity = isPlanBoundary ? recentPlanToolActivity : recentToolActivity;
    const evidenceLedger = callbacks.getPlanExecutionEvidenceLedger?.() || [];
    const transactionId = input.transactionId ?? callbacks.getCurrentTurnId?.() ?? null;
    const scopedLedger = scopeExecutionEvidenceLedger(evidenceLedger, transactionId);
    const devServerState = resolveDevServerRuntimeState(scopedLedger);
    const recoveryState = input.executeRecoveryState;
    const recoveryActionContract = resolveExecuteRecoveryActionContract(
      recoveryState?.mode || executeRecoveryMode,
      {
        expectedTarget: recoveryState?.expectedTarget,
        readLease: recoveryState?.readLease,
        sourceObservationKey: recoveryState?.sourceObservationKey,
        decisionCheckpoint: recoveryState?.decisionCheckpoint,
        phaseNoProgressCount: recoveryState?.phaseNoProgressCount,
        protocolNoProgressCount: recoveryState?.protocolNoProgressCount,
        protocolNoProgressFingerprint: recoveryState?.protocolNoProgressFingerprint,
        devServerStatus: devServerState.status,
        devServerNextCapability: devServerState.nextCapability,
        devServerUrl: devServerState.url,
        ptyGeneration: devServerState.foregroundGeneration,
        ptyOutputSequence: devServerState.outputSequence,
      },
    );
    const autoResumeEligible = hasDurableExecutionProgress({
      ledger: evidenceLedger,
      transactionId,
      recoveryActionContract,
    });
    const checkpoint = buildPlanMaxIterationsCheckpoint({
      iterationCount: effectiveMaxIterations,
      maxIterations: effectiveMaxIterations,
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      autoResumeEligible,
      tasks: isPlanBoundary ? callbacks.getPlanTasks() : [],
      evidenceLedger,
      recentToolActivity: recentActivity,
      lastAssistantText: lastAssistantTextForCheckpoint,
      unresolvedBlockers: [
        `Agent loop reached maximum iterations (${effectiveMaxIterations}) while ${
          isPlanBoundary ? "plan execution" : "execute runtime"
        } was still active.`,
      ],
    });
    logAgentEvent(isPlanBoundary
      ? "max_iterations_checkpoint"
      : "execute_max_iterations_checkpoint", {
      workflowMode,
      iteration: effectiveMaxIterations,
      autoResumeCount: checkpoint.autoResumeCount,
      recentToolActivity: checkpoint.recentToolActivity.length,
      ...(isPlanBoundary ? { remainingTasks: checkpoint.remainingTasks.length } : {}),
      ...(!isPlanBoundary ? { sawExecuteOperationEvidence, executeRecoveryMode } : {}),
      transactionId,
      recoveryPhase: recoveryActionContract.phase,
      nextRequiredCapability: recoveryActionContract.nextRequiredCapability,
      structuredEvidenceCount: scopedLedger.length,
      autoResumeEligible,
    });
    const handling = await resolveCheckpointHandling(
      checkpoint,
      isPlanBoundary
        ? callbacks.onPlanMaxIterationsCheckpoint
          ? (value) => callbacks.onPlanMaxIterationsCheckpoint?.(value) ?? false
          : undefined
        : callbacks.onExecuteMaxIterationsCheckpoint
        ? (value) => callbacks.onExecuteMaxIterationsCheckpoint?.(value) ?? false
        : undefined,
      callbacks.getPlanAutoResumeCount
        ? () => callbacks.getPlanAutoResumeCount?.() ?? 0
        : undefined,
    );
    const boundaryNotice = handling.autoResumeScheduled
      ? isPlanBoundary
        ? buildPlanMaxIterationsAutoResumeNotice(
            handling.checkpoint,
            callbacks.getPreferredLanguage(),
          )
        : buildExecuteMaxIterationsAutoResumeNotice(
            handling.checkpoint,
            callbacks.getPreferredLanguage(),
          )
      : isPlanBoundary
      ? buildPlanMaxIterationsPauseNotice(
          handling.checkpoint,
          callbacks.getPreferredLanguage(),
        )
      : buildExecuteMaxIterationsPauseNotice(
          handling.checkpoint,
          callbacks.getPreferredLanguage(),
        );

    if (isPlanBoundary && !handling.handled) {
      emitPlanExecutionProgress("paused", {
        nextStep: callbacks.getPreferredLanguage() === "zh"
          ? "点击 Resume Execution 后从检查点继续"
          : "click Resume Execution to continue from checkpoint",
      });
    }
    emitRunPausedEvent(
      handling.autoResumeScheduled ? "max_iterations_auto_resume" : "max_iterations_boundary",
      boundaryNotice,
    );
    if (handling.handled) {
      callbacks.onStatusChange("idle");
      return { status: "handled" };
    }
    if (isPlanBoundary) {
      callbacks.onStatusChange("idle");
      callbacks.onNonActionableStop(
        boundaryNotice,
        "incomplete_plan",
        {
          phase: "paused",
          recoveryReason: "plan_max_iterations_checkpoint",
          repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity),
          progressSignature: buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity),
          nextStep: callbacks.getPreferredLanguage() === "zh"
            ? "点击 Resume Execution 后复用检查点，先核查当前 workspace，再继续未满足证据的任务"
            : "click Resume Execution to reuse the checkpoint, inspect current workspace, and continue evidence-unsatisfied tasks",
        },
      );
    } else {
      callbacks.onNonActionableStop(boundaryNotice, "no_action");
      callbacks.onStatusChange("idle");
    }
    return { status: "handled" };
  }

  const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
  const progressSignature = buildPlanProgressSignatureFromToolActivity(recentToolActivity);
  logAgentEvent("loop_stop", {
    reason: "max_iterations_boundary",
    iteration: effectiveMaxIterations,
    workflowMode,
    runtimeIntent,
    repeatedTargets,
    progressSignature: truncateForLog(progressSignature, 220),
  });
  const pauseNotice = callbacks.getPreferredLanguage() === "zh"
    ? `本轮达到 ${effectiveMaxIterations} 轮安全边界，已停止在可恢复状态。`
    : `This turn reached the ${effectiveMaxIterations}-iteration safety boundary and stopped in a recoverable state.`;
  callbacks.onNonActionableStop(
    pauseNotice,
    "no_action",
    {
      progressSignature,
      repeatedTargets,
      recoveryReason: "max_iterations_boundary",
      nextStep: callbacks.getPreferredLanguage() === "zh"
        ? "复用已读上下文，直接总结、换目标或说明具体阻塞"
        : "reuse cached context, summarize directly, switch targets, or state the concrete blocker",
    },
  );
  callbacks.onStatusChange("idle");
  emitRunPausedEvent("max_iterations_boundary", pauseNotice);
  return { status: "handled" };
}
