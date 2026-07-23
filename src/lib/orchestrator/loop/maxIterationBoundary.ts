import {
  buildChatMaxIterationsAutoResumeNotice,
  buildChatMaxIterationsPauseNotice,
  buildExecuteMaxIterationsAutoResumeNotice,
  buildExecuteMaxIterationsPauseNotice,
  buildPlanMaxIterationsAutoResumeNotice,
  buildPlanMaxIterationsCheckpoint,
  buildPlanMaxIterationsPauseNotice,
  buildPlanProgressSignatureFromToolActivity,
  resolveExecuteMaxIterationsRecoveryDecision,
  resolveChatMaxIterationStrategyPivot,
  resolveMaxIterationStrategyPivot,
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import {
  resolveExecuteRecoveryActionContract,
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
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
  const executeLikeChatBoundary = workflowMode === "chat" && (
    isMutationRuntimeIntent(runtimeIntent) ||
    input.executeRecoveryState?.reason?.startsWith("chat_repair_strategy_pivot:") === true
  );
  if (approvedPlanBoundary || workflowMode === "edit" || executeLikeChatBoundary) {
    const isPlanBoundary = approvedPlanBoundary;
    const recentActivity = isPlanBoundary ? recentPlanToolActivity : recentToolActivity;
    const evidenceLedger = callbacks.getPlanExecutionEvidenceLedger?.() || [];
    const transactionId = input.transactionId ?? callbacks.getCurrentTurnId?.() ?? null;
    const scopedLedger = scopeExecutionEvidenceLedger(evidenceLedger, transactionId);
    const devServerState = resolveDevServerRuntimeState(scopedLedger);
    const recoveryState = input.executeRecoveryState;
    const executeBoundaryDecision = !isPlanBoundary
      ? resolveExecuteMaxIterationsRecoveryDecision({
          evidenceLedger,
          recoveryState,
          transactionId,
        })
      : null;
    const recoveryActionContract = resolveExecuteRecoveryActionContract(
      executeBoundaryDecision?.mode || recoveryState?.mode || executeRecoveryMode,
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
    const hasDurableProgress = hasDurableExecutionProgress({
      ledger: evidenceLedger,
      transactionId,
      recoveryActionContract,
    });
    const planTasks = isPlanBoundary ? callbacks.getPlanTasks() : [];
    const planObjectiveComplete = isPlanBoundary && planTasks.length > 0 &&
      planTasks.every((task) =>
        task.status === "completed" || task.evidenceStatus === "satisfied"
      );
    const objectiveComplete = planObjectiveComplete ||
      (!isPlanBoundary && executeBoundaryDecision?.gap === "none");
    const strategyDecision = resolveMaxIterationStrategyPivot({
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      objectiveComplete,
      nextRequiredCapability: recoveryActionContract.nextRequiredCapability,
    });
    const autoResumeEligible = strategyDecision.selected !== null;
    const checkpoint = buildPlanMaxIterationsCheckpoint({
      iterationCount: effectiveMaxIterations,
      maxIterations: effectiveMaxIterations,
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      autoResumeEligible,
      strategyPivot: strategyDecision.selected,
      attemptedStrategyPivots: strategyDecision.attempted,
      remainingStrategyPivots: strategyDecision.remaining,
      strategyPivotBudget: strategyDecision.hardLimit,
      strategyCapability: recoveryActionContract.nextRequiredCapability,
      tasks: planTasks,
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
      hasDurableProgress,
      autoResumeEligible,
      strategyPivot: checkpoint.strategyPivot,
      attemptedStrategyPivots: checkpoint.attemptedStrategyPivots,
      strategyPivotBudget: checkpoint.strategyPivotBudget,
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
          recoveryReason: "max_iterations_boundary",
          repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity),
          progressSignature: buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity),
          nextStep: callbacks.getPreferredLanguage() === "zh"
            ? "点击 Resume Execution 后复用检查点，先核查当前 workspace，再继续未满足证据的任务"
            : "click Resume Execution to reuse the checkpoint, inspect current workspace, and continue evidence-unsatisfied tasks",
        },
      );
    } else {
      callbacks.onNonActionableStop(boundaryNotice, "no_action", {
        phase: "paused",
        recoveryReason: "max_iterations_boundary",
        repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
        progressSignature: buildPlanProgressSignatureFromToolActivity(recentToolActivity),
        nextStep: callbacks.getPreferredLanguage() === "zh"
          ? "从已保存的执行检查点恢复，并继续尚未闭环的最小写入或验证动作"
          : "resume from the saved execution checkpoint and continue the smallest unfinished mutation or validation action",
      });
      callbacks.onStatusChange("idle");
    }
    return { status: "handled" };
  }

  const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
  const progressSignature = buildPlanProgressSignatureFromToolActivity(recentToolActivity);
  const strategyDecision = resolveChatMaxIterationStrategyPivot({
    autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
  });
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: effectiveMaxIterations,
    maxIterations: effectiveMaxIterations,
    autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
    autoResumeEligible: strategyDecision.selected !== null,
    strategyPivot: strategyDecision.selected,
    attemptedStrategyPivots: strategyDecision.attempted,
    remainingStrategyPivots: strategyDecision.remaining,
    strategyPivotBudget: strategyDecision.hardLimit,
    strategyCapability: null,
    tasks: [],
    evidenceLedger: [],
    recentToolActivity,
    lastAssistantText: lastAssistantTextForCheckpoint,
    unresolvedBlockers: [
      `Conversation reached maximum iterations (${effectiveMaxIterations}) before a deliverable answer was committed.`,
    ],
  });
  const isSubagentBoundary = (callbacks.getSubagentDepth?.() ?? 0) > 0;
  if (isSubagentBoundary) {
    const activitySummary = recentToolActivity.slice(-4).map((activity) => {
      const target = activity.target ? ` ${activity.target}` : "";
      return `${activity.name}${target}: ${activity.status}`;
    });
    const partialSummary = callbacks.getPreferredLanguage() === "zh"
      ? [
          "子智能体已达到本次有界执行轮次，以下为交还主线程的部分结果；主线程应结合这些证据继续，而不是把它当作任务完成。",
          lastAssistantTextForCheckpoint
            ? `部分结论：${lastAssistantTextForCheckpoint}`
            : "部分结论：尚未形成完整结论。",
          activitySummary.length > 0
            ? `最近观察：${activitySummary.join("；")}`
            : "最近观察：暂无可概括的工具观察。",
        ].join("\n")
      : [
          "The subagent reached its bounded turn limit. This is a partial handoff to the parent, which should continue from the retained evidence rather than treat the task as complete.",
          lastAssistantTextForCheckpoint
            ? `Partial conclusion: ${lastAssistantTextForCheckpoint}`
            : "Partial conclusion: no complete conclusion was formed.",
          activitySummary.length > 0
            ? `Recent observations: ${activitySummary.join("; ")}`
            : "Recent observations: no tool observation is available to summarize.",
        ].join("\n");
    callbacks.onTurnSummaryReady(partialSummary);
    callbacks.onAssistantFinalText(partialSummary, [], {
      hasToolCalls: recentToolActivity.length > 0,
      preserveAssistantText: true,
      capsuleCandidate: false,
      modelAuthored: false,
      visibility: "stage_summary",
    });
    callbacks.onNonActionableStop(partialSummary, "no_action", {
      progressSignature,
      repeatedTargets,
      recoveryReason: "subagent_max_iterations_partial_handoff",
      nextStep: callbacks.getPreferredLanguage() === "zh"
        ? "由主线程复用部分结论和观察继续处理剩余问题"
        : "let the parent reuse the partial conclusion and observations to continue the remaining work",
    });
    callbacks.onStatusChange("idle");
    emitRunPausedEvent("subagent_max_iterations_partial_handoff", partialSummary);
    logAgentEvent("subagent_max_iterations_partial_handoff", {
      iteration: effectiveMaxIterations,
      runtimeIntent,
      recentToolActivity: recentToolActivity.length,
      progressSignature: truncateForLog(progressSignature, 220),
    });
    return { status: "handled" };
  }

  const handling = await resolveCheckpointHandling(
    checkpoint,
    callbacks.onChatMaxIterationsCheckpoint
      ? (value) => callbacks.onChatMaxIterationsCheckpoint?.(value) ?? false
      : undefined,
    callbacks.getPlanAutoResumeCount
      ? () => callbacks.getPlanAutoResumeCount?.() ?? 0
      : undefined,
  );
  const boundaryNotice = handling.autoResumeScheduled
    ? buildChatMaxIterationsAutoResumeNotice(
        handling.checkpoint,
        callbacks.getPreferredLanguage(),
      )
    : buildChatMaxIterationsPauseNotice(
        handling.checkpoint,
        callbacks.getPreferredLanguage(),
      );
  logAgentEvent(handling.autoResumeScheduled ? "chat_max_iterations_strategy_pivot" : "loop_stop", {
    reason: handling.autoResumeScheduled
      ? "chat_max_iterations_auto_resume"
      : "chat_max_iterations_boundary",
    iteration: effectiveMaxIterations,
    workflowMode,
    runtimeIntent,
    repeatedTargets,
    progressSignature: truncateForLog(progressSignature, 220),
    strategyPivot: handling.checkpoint.strategyPivot,
    attemptedStrategyPivots: handling.checkpoint.attemptedStrategyPivots,
  });
  emitRunPausedEvent(
    handling.autoResumeScheduled ? "max_iterations_auto_resume" : "max_iterations_boundary",
    boundaryNotice,
  );
  if (handling.handled) {
    callbacks.onStatusChange("idle");
    return { status: "handled" };
  }
  callbacks.onNonActionableStop(
    boundaryNotice,
    "no_action",
    {
      progressSignature,
      repeatedTargets,
      recoveryReason: "max_iterations_boundary",
      nextStep: callbacks.getPreferredLanguage() === "zh"
        ? "复用已有上下文直接回答；只有确有信息缺口时才做一次不同的有界观察"
        : "reuse retained context and answer directly; make one different bounded observation only for a genuine information gap",
    },
  );
  callbacks.onStatusChange("idle");
  return { status: "handled" };
}
