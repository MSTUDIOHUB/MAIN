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
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import type { ResolvedUserIntent } from "../../runIntent";
import type {
  PlanExecutionEvidenceEntry,
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
} from "../../workflowModels";
import { isFinitePlanValidationCommand } from "../../workflowModels";
import { browserResultLooksSuccessful } from "../../planEvidence";
import {
  EDIT_PROGRESS_TOOL_NAMES,
  logAgentEvent,
  truncateForLog,
} from "../../orchestrator";
import type { OrchestratorCallbacks } from "../types";
import { hasResolvedWorkspaceMutationTarget } from "../../workspaceMutationTools";

export type MaxIterationBoundaryResult = {
  status: "handled";
};

const PTY_OBSERVATION_ACTIVITY_TOOLS = new Set([
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

const NON_DURABLE_ACTIVITY_DETAIL_RE =
  /NO_EFFECT_MUTATION|FILE_UNCHANGED_STUB|CACHED_FILE_REPLAY|no-?op|nothing to (?:change|patch|write)|(?:assertion|validation|command).{0,40}(?:failed|error)|"(?:ok|success)"\s*:\s*false|exit(?:Code|_code)?[=:"\s]+[1-9]/i;

function hasRecentReadyPtyEvidence(
  activity: PlanToolActivitySummary[],
  evidenceLedger: PlanExecutionEvidenceEntry[],
): boolean {
  const recentPtyTools = new Set(activity
    .filter((entry) =>
      entry.status === "succeeded" &&
      PTY_OBSERVATION_ACTIVITY_TOOLS.has(entry.name) &&
      !NON_DURABLE_ACTIVITY_DETAIL_RE.test(String(entry.detail || ""))
    )
    .map((entry) => entry.name));
  if (recentPtyTools.size === 0) return false;
  const latestObservation = [...evidenceLedger].reverse().find((entry) =>
    recentPtyTools.has(entry.sourceTool)
  );
  return latestObservation?.observationStatus === "ready";
}

function hasDurableExecutionActivity(
  activity: PlanToolActivitySummary[],
  evidenceLedger: PlanExecutionEvidenceEntry[] = [],
): boolean {
  const hasDurableActivity = activity.some((entry) => {
    if (
      entry.status !== "succeeded" ||
      /(?:^|[\\/])\.MAIN[\\/]plans[\\/]/i.test(String(entry.target || "")) ||
      NON_DURABLE_ACTIVITY_DETAIL_RE.test(String(entry.detail || ""))
    ) {
      return false;
    }
    if (
      (EDIT_PROGRESS_TOOL_NAMES.has(entry.name) &&
        hasResolvedWorkspaceMutationTarget(entry.name, entry.target || "")) ||
      String(entry.target || "").startsWith("shell-write:")
    ) {
      return true;
    }
    if (entry.name === "run_command") {
      return isFinitePlanValidationCommand(String(entry.target || ""));
    }
    return entry.name === "browser_evaluate" &&
      browserResultLooksSuccessful(String(entry.detail || ""));
  });
  return hasDurableActivity || hasRecentReadyPtyEvidence(activity, evidenceLedger);
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

  if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
    const autoResumeEligible =
      sawExecuteOperationEvidence &&
      hasDurableExecutionActivity(
        recentPlanToolActivity,
        callbacks.getPlanExecutionEvidenceLedger(),
      );
    const checkpoint = buildPlanMaxIterationsCheckpoint({
      iterationCount: effectiveMaxIterations,
      maxIterations: effectiveMaxIterations,
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      autoResumeEligible,
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
      autoResumeEligible,
    });
    const handling = await callbacks.onPlanMaxIterationsCheckpoint?.(checkpoint);
    const explicitAutoResume = checkpoint.autoResumeEligible &&
      typeof handling === "object" &&
      handling?.status === "auto_resume_scheduled";
    const handled = handling === true || explicitAutoResume;
    const effectiveAutoResumeCount = explicitAutoResume
      ? Math.max(checkpoint.autoResumeCount, handling.checkpoint.autoResumeCount)
      : Math.max(
          checkpoint.autoResumeCount,
          callbacks.getPlanAutoResumeCount?.() ?? checkpoint.autoResumeCount,
        );
    const autoResumeScheduled = checkpoint.autoResumeEligible && (explicitAutoResume || (
      handling === true && effectiveAutoResumeCount > checkpoint.autoResumeCount
    ));
    const boundaryCheckpoint = {
      ...checkpoint,
      autoResumeCount: effectiveAutoResumeCount,
    };
    const boundaryNotice = autoResumeScheduled
      ? buildPlanMaxIterationsAutoResumeNotice(
          boundaryCheckpoint,
          callbacks.getPreferredLanguage(),
        )
      : buildPlanMaxIterationsPauseNotice(
          boundaryCheckpoint,
          callbacks.getPreferredLanguage(),
        );
    if (!handled) {
      emitPlanExecutionProgress("paused", {
        nextStep: callbacks.getPreferredLanguage() === "zh"
          ? "点击 Resume Execution 后从检查点继续"
          : "click Resume Execution to continue from checkpoint",
      });
    }
    emitRunPausedEvent(
      autoResumeScheduled ? "max_iterations_auto_resume" : "max_iterations_boundary",
      boundaryNotice,
    );
    callbacks.onStatusChange("idle");
    if (handled) return { status: "handled" };
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
    return { status: "handled" };
  }

  if (workflowMode === "edit") {
    const autoResumeEligible =
      sawExecuteOperationEvidence &&
      hasDurableExecutionActivity(
        recentToolActivity,
        callbacks.getPlanExecutionEvidenceLedger?.() || [],
      );
    const checkpoint = buildPlanMaxIterationsCheckpoint({
      iterationCount: effectiveMaxIterations,
      maxIterations: effectiveMaxIterations,
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      autoResumeEligible,
      tasks: [],
      evidenceLedger: callbacks.getPlanExecutionEvidenceLedger?.() || [],
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
      autoResumeEligible,
    });
    const handling = await callbacks.onExecuteMaxIterationsCheckpoint?.(checkpoint);
    const explicitAutoResume = checkpoint.autoResumeEligible &&
      typeof handling === "object" &&
      handling?.status === "auto_resume_scheduled";
    const handled = handling === true || explicitAutoResume;
    const effectiveAutoResumeCount = explicitAutoResume
      ? Math.max(checkpoint.autoResumeCount, handling.checkpoint.autoResumeCount)
      : Math.max(
          checkpoint.autoResumeCount,
          callbacks.getPlanAutoResumeCount?.() ?? checkpoint.autoResumeCount,
        );
    const autoResumeScheduled = checkpoint.autoResumeEligible && (explicitAutoResume || (
      handling === true && effectiveAutoResumeCount > checkpoint.autoResumeCount
    ));
    const boundaryCheckpoint = {
      ...checkpoint,
      autoResumeCount: effectiveAutoResumeCount,
    };
    const boundaryNotice = autoResumeScheduled
      ? buildExecuteMaxIterationsAutoResumeNotice(
          boundaryCheckpoint,
          callbacks.getPreferredLanguage(),
        )
      : buildExecuteMaxIterationsPauseNotice(
          boundaryCheckpoint,
          callbacks.getPreferredLanguage(),
        );
    emitRunPausedEvent(
      autoResumeScheduled ? "max_iterations_auto_resume" : "max_iterations_boundary",
      boundaryNotice,
    );
    if (handled) {
      callbacks.onStatusChange("idle");
      return { status: "handled" };
    }
    callbacks.onNonActionableStop(
      boundaryNotice,
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
