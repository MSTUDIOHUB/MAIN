import {
  buildExecuteMaxIterationsPauseNotice,
  buildPlanMaxIterationsCheckpoint,
  buildPlanMaxIterationsPauseNotice,
  buildPlanProgressSignatureFromToolActivity,
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import {
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import type { ResolvedUserIntent } from "../../runIntent";
import type {
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
} from "../../workflowModels";
import {
  logAgentEvent,
  truncateForLog,
} from "../../orchestrator";
import type { OrchestratorCallbacks } from "../types";

export type MaxIterationBoundaryResult = {
  status: "handled";
};

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
  emitPlanExecutionProgress: (
    phase: PlanExecutionProgressPhase,
    overrides?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
  emitTurnCompletedEvent: () => void;
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
    emitTurnCompletedEvent,
  } = input;

  if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
    const checkpoint = buildPlanMaxIterationsCheckpoint({
      iterationCount: effectiveMaxIterations,
      maxIterations: effectiveMaxIterations,
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      tasks: callbacks.getPlanTasks(),
      evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
      recentToolActivity: recentPlanToolActivity,
      lastAssistantText: lastAssistantTextForCheckpoint,
      unresolvedBlockers: [
        `Agent loop reached maximum iterations (${effectiveMaxIterations}) while plan execution was still active.`,
      ],
    });
    logAgentEvent("max_iterations_checkpoint", {
      workflowMode,
      iteration: effectiveMaxIterations,
      autoResumeCount: checkpoint.autoResumeCount,
      remainingTasks: checkpoint.remainingTasks.length,
      recentToolActivity: checkpoint.recentToolActivity.length,
    });
    emitPlanExecutionProgress("paused", {
      nextStep: callbacks.getPreferredLanguage() === "zh"
        ? "点击 Resume Execution 后从检查点继续"
        : "click Resume Execution to continue from checkpoint",
    });
    callbacks.onStatusChange("idle");
    const handled = await callbacks.onPlanMaxIterationsCheckpoint?.(checkpoint);
    if (handled) return { status: "handled" };
    callbacks.onNonActionableStop(
      buildPlanMaxIterationsPauseNotice(checkpoint, callbacks.getPreferredLanguage()),
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
    return { status: "handled" };
  }

  if (workflowMode === "edit") {
    const checkpoint = buildPlanMaxIterationsCheckpoint({
      iterationCount: effectiveMaxIterations,
      maxIterations: effectiveMaxIterations,
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      tasks: [],
      evidenceLedger: [],
      recentToolActivity,
      lastAssistantText: lastAssistantTextForCheckpoint,
      unresolvedBlockers: [
        `Agent loop reached maximum iterations (${effectiveMaxIterations}) while execute runtime was still active.`,
      ],
    });
    logAgentEvent("execute_max_iterations_checkpoint", {
      workflowMode,
      iteration: effectiveMaxIterations,
      autoResumeCount: checkpoint.autoResumeCount,
      recentToolActivity: checkpoint.recentToolActivity.length,
      sawExecuteOperationEvidence,
      executeRecoveryMode,
    });
    const handled = await callbacks.onExecuteMaxIterationsCheckpoint?.(checkpoint);
    if (handled) {
      callbacks.onStatusChange("idle");
      return { status: "handled" };
    }
    callbacks.onNonActionableStop(
      buildExecuteMaxIterationsPauseNotice(checkpoint, callbacks.getPreferredLanguage()),
      "no_action",
    );
    callbacks.onStatusChange("idle");
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
  callbacks.onNonActionableStop(
    callbacks.getPreferredLanguage() === "zh"
      ? `本轮达到 ${effectiveMaxIterations} 轮安全边界，已停止在可恢复状态。`
      : `This turn reached the ${effectiveMaxIterations}-iteration safety boundary and stopped in a recoverable state.`,
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
  emitTurnCompletedEvent();
  return { status: "handled" };
}
