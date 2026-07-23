import {
  EXECUTE_CONVERGENCE_PROMPT_RATIO,
  MAX_NO_PROGRESS_LOOP_REPEATS,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
  buildExecuteConvergencePrompt,
  buildNoProgressBatchSignature,
  getToolTarget,
  isReadFileOnlyPattern,
  logAgentEvent,
  parseToolCallArguments,
  targetProgressOutcomeForToolResult,
  targetProgressReasonForToolResult,
  truncateForLog,
} from "../../orchestrator";
import { isApprovedPlanCachedReadOnlyNoProgressBatch } from "../../approvedPlanRecoveryTools";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import { isPtyControlInput } from "../../ptyCommandRuntime";
import {
  EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS,
  buildExecuteNoProgressLoopPauseNotice,
  buildExecuteRecoveryPrompt,
  isReadOnlyNoProgressDetail,
  resolveExecuteRecoveryActionContract,
  resolveExecuteNoProgressStrategyDecision,
  resolveExecuteReadOnlyRecoveryTrigger,
  resolveReadOnlyNoProgressTrigger,
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
  type ExecuteNoProgressStrategyPivot,
} from "../../executeRecoveryTools";
import {
  buildPlanNoProgressLoopPauseNotice,
  buildPlanProgressSignatureFromToolActivity,
  hasPendingApprovedPlanSourceMutation,
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
  formatRepeatLoopFatalMessage,
  formatTargetProgressLoopRecoveryMessage,
  getShellMutationTargetForLoopGuard,
  isReadOnlyShellInspectionToolCall,
  registerTargetProgressEventForLoopGuard,
  registerToolCallForRepeatGuard,
} from "../../repetitionGuard";
import {
  isPlanTaskTrustedComplete,
} from "../../workflowModels";
import {
  isToolAutoExecutableForCall,
  type ToolCapabilityRegistry,
  type ToolPermissionPolicy,
} from "../../toolCapabilities";
import type { OrchestratorCallbacks, ToolCallToExecute, ToolExecutionResult } from "../types";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import { hasSuccessfulWorkspaceMutationEvidence } from "../../verificationEvidence";

export { resolveDirectMutationPreflightRecovery } from "./mutationFailureRecovery";

function resolveRuntimeRecoveryActionContract(state: ExecuteRecoveryRuntimeState) {
  return resolveExecuteRecoveryActionContract(state.mode, {
    expectedTarget: state.expectedTarget,
    readLease: state.readLease,
    sourceObservationKey: state.sourceObservationKey,
    decisionCheckpoint: state.decisionCheckpoint,
    phaseNoProgressCount: state.phaseNoProgressCount,
    protocolNoProgressCount: state.protocolNoProgressCount,
    protocolNoProgressFingerprint: state.protocolNoProgressFingerprint,
  });
}

function isExecuteMutationRecoveryEligible(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
}): boolean {
  if (!isMutationRuntimeIntent(input.runtimeIntent)) return false;
  if (input.workflowMode !== "edit") return false;
  if (!input.callbacks.getIsPlanApproved()) return true;
  return hasPendingApprovedPlanSourceMutation(
    input.callbacks.getPlanTasks(),
    input.callbacks.getPlanExecutionEvidenceLedger(),
  );
}

export interface NoProgressTrackingState {
  lastNoProgressBatchSignature: string;
  noProgressBatchRepeatCount: number;
  consecutiveReadFileOnlyCacheHits: number;
  lastReadFileOnlyObservationSignature: string;
  noProgressStrategyPivots: ExecuteNoProgressStrategyPivot[];
}

function buildReadFileOnlyObservationBatchSignature(results: ToolExecutionResult[]): string {
  if (!isReadFileOnlyPattern(results)) return "";
  return results
    .map((result) => {
      const detail = String(result.displayContent || result.content || "");
      if (/^\s*READ_FILE_WINDOW_NARROWED\b/i.test(detail)) {
        const observation = result.readFileObservation;
        return [
          observation?.path || result.target || "read_file",
          observation?.versionToken || "unknown-version",
          "overlap-extension",
        ].join("::");
      }
      return result.readFileObservation?.key || buildNoProgressBatchSignature([result]);
    })
    .filter(Boolean)
    .sort()
    .join("||");
}

export interface PendingExecuteNoProgressPause {
  notice: string;
  repeatedTargets: string[];
  progressSignature: string;
  reason: string;
}

export type NoProgressRecoveryResult =
  | {
      status: "none";
      tracking: NoProgressTrackingState;
      noProgressBatchSignature: string;
      pendingExecuteRecoveryPrompt: string | null;
      pendingExecuteNoProgressPause: PendingExecuteNoProgressPause | null;
    }
  | {
      status: "continue";
      tracking: NoProgressTrackingState;
      noProgressBatchSignature: string;
      pendingExecuteRecoveryPrompt: string | null;
      pendingExecuteNoProgressPause: PendingExecuteNoProgressPause | null;
    }
  | {
      status: "stopped";
      tracking: NoProgressTrackingState;
      noProgressBatchSignature: string;
      pendingExecuteRecoveryPrompt: string | null;
      pendingExecuteNoProgressPause: PendingExecuteNoProgressPause | null;
    };

export function handleNoProgressRecovery(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  results: ToolExecutionResult[];
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  sawExecuteOperationEvidence: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryReason: string;
  executeRecoveryAttempts: number;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  repairExecutionRequestInChat: boolean;
  latestUserPromptText: string;
  isUnapprovedPlanReadOnlyBatch: boolean;
  planReadOnlyConvergenceBatches: number;
  planReadOnlyConvergenceTools: number;
  remainingTaskText?: string | null;
  availableToolNames: Set<string>;
  tracking: NoProgressTrackingState;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => ExecuteRecoveryRuntimeState;
  activateChatFinalSynthesis: (reason: string, context?: Record<string, unknown>) => void;
  emitTaskOrchestratorPhase: (phase: "EXECUTE_RECOVERY" | "PAUSED", details?: Record<string, unknown>) => void;
}): NoProgressRecoveryResult {
  const {
    callbacks,
    workflowMode,
    runtimeIntent,
    iteration,
    results,
    recentToolActivity,
    recentPlanToolActivity,
    sawExecuteOperationEvidence,
    executeRecoveryMode,
    executeRecoveryReason,
    executeRecoveryAttempts,
    executeRecoveryState,
    repairExecutionRequestInChat,
    latestUserPromptText,
    isUnapprovedPlanReadOnlyBatch,
    planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools,
    remainingTaskText,
    availableToolNames,
    activateExecuteRecovery,
    activateChatFinalSynthesis,
    emitTaskOrchestratorPhase,
  } = input;

  const noProgressBatchSignature = buildNoProgressBatchSignature(results);
  let {
    lastNoProgressBatchSignature,
    noProgressBatchRepeatCount,
    consecutiveReadFileOnlyCacheHits,
    lastReadFileOnlyObservationSignature,
  } = input.tracking;
  const noProgressStrategyPivots = [
    ...(input.tracking.noProgressStrategyPivots || []),
  ];
  if (noProgressBatchSignature) {
    if (noProgressBatchSignature === lastNoProgressBatchSignature) {
      noProgressBatchRepeatCount += 1;
    } else {
      lastNoProgressBatchSignature = noProgressBatchSignature;
      noProgressBatchRepeatCount = 1;
    }
  } else {
    lastNoProgressBatchSignature = "";
    noProgressBatchRepeatCount = 0;
  }

  const readFileOnlyObservationSignature = buildReadFileOnlyObservationBatchSignature(results);
  if (readFileOnlyObservationSignature) {
    const previousReadFileOnlyObservationSignature =
      lastReadFileOnlyObservationSignature ||
      (consecutiveReadFileOnlyCacheHits > 0 ? readFileOnlyObservationSignature : "");
    if (readFileOnlyObservationSignature === previousReadFileOnlyObservationSignature) {
      consecutiveReadFileOnlyCacheHits += 1;
      lastReadFileOnlyObservationSignature = readFileOnlyObservationSignature;
    } else {
      lastReadFileOnlyObservationSignature = readFileOnlyObservationSignature;
      consecutiveReadFileOnlyCacheHits = 1;
    }
  } else {
    consecutiveReadFileOnlyCacheHits = 0;
    lastReadFileOnlyObservationSignature = "";
  }

  const tracking = {
    lastNoProgressBatchSignature,
    noProgressBatchRepeatCount,
    consecutiveReadFileOnlyCacheHits,
    lastReadFileOnlyObservationSignature,
    noProgressStrategyPivots,
  };

  let pendingExecuteRecoveryPrompt: string | null = null;
  let pendingExecuteNoProgressPause: PendingExecuteNoProgressPause | null = null;
  let currentExecuteRecoveryMode = executeRecoveryMode;
  let currentExecuteRecoveryReason = executeRecoveryReason;
  let currentExecuteRecoveryAttempts = executeRecoveryAttempts;
  let currentExecuteRecoveryState = executeRecoveryState;
  const executeMutationRecoveryEligible = isExecuteMutationRecoveryEligible({
    callbacks,
    workflowMode,
    runtimeIntent,
  });
  const activateTrackedExecuteRecovery = (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => {
    currentExecuteRecoveryMode = mode;
    currentExecuteRecoveryReason = reason;
    currentExecuteRecoveryAttempts += 1;
    const activatedState = activateExecuteRecovery(mode, reason, context);
    if (activatedState) currentExecuteRecoveryState = activatedState;
    return currentExecuteRecoveryState;
  };

  const executeReadOnlyRecovery =
    executeMutationRecoveryEligible &&
    currentExecuteRecoveryMode === "normal"
      ? resolveExecuteReadOnlyRecoveryTrigger({
          results,
          recentActivity: recentToolActivity,
          readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
          sawExecuteOperationEvidence,
          noProgressBatchRepeatCount,
          minReadOnlyActivities: currentExecuteRecoveryMode === "normal" ? 8 : Infinity,
          minCachedReadOnlyActivities: currentExecuteRecoveryMode === "normal" ? 3 : Infinity,
          maxNoProgressReadOnlyRepeats: 2,
          maxReadOnlyToolChars: 48000,
        })
      : { shouldRecover: false, reason: "", readOnlyActivityCount: 0, batchToolChars: 0 };
  if (executeReadOnlyRecovery.shouldRecover) {
    const language = callbacks.getPreferredLanguage();
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    if (currentExecuteRecoveryAttempts < 2) {
      // Read-only convergence already has context. Move to one mutation step;
      // the context-read phase is reserved for an actual patch mismatch.
      const nextMode: Exclude<ExecuteRecoveryMode, "normal"> = "mutation_first";
      const activatedRecovery = activateTrackedExecuteRecovery(nextMode, executeReadOnlyRecovery.reason, {
        readOnlyActivityCount: executeReadOnlyRecovery.readOnlyActivityCount,
        batchToolChars: executeReadOnlyRecovery.batchToolChars,
        repeatedTargets,
      });
      pendingExecuteRecoveryPrompt = buildExecuteRecoveryPrompt({
        language: MODEL_CONTROL_LANGUAGE,
        reason: executeReadOnlyRecovery.reason,
        contract: resolveRuntimeRecoveryActionContract(activatedRecovery),
        repeatedTargets,
        recentActivity: recentToolActivity,
      });
    } else {
      const remainingText = callbacks.getPreferredLanguage() === "zh"
        ? "执行恢复后仍只有只读探索，没有写入、命令或浏览器验证证据。"
        : "execute recovery still produced read-only exploration without write, command, or browser validation evidence";
      pendingExecuteNoProgressPause = {
        notice: buildExecuteNoProgressLoopPauseNotice({
          language,
          repeats: Math.max(1, noProgressBatchRepeatCount),
          remainingTask: remainingText,
          recentActivity: recentToolActivity,
          repeatedTargets,
        }),
        repeatedTargets,
        progressSignature: buildPlanProgressSignatureFromToolActivity(recentToolActivity) || noProgressBatchSignature,
        reason: executeReadOnlyRecovery.reason,
      };
    }
  }

  const chatReadOnlyNoProgress =
    workflowMode === "chat" && runtimeIntent === "respond"
      ? resolveReadOnlyNoProgressTrigger({
          results,
          recentActivity: recentToolActivity,
          readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
          sawExecuteOperationEvidence,
          noProgressBatchRepeatCount,
          minReadOnlyActivities: 16,
          minCachedReadOnlyActivities: 6,
          maxNoProgressReadOnlyRepeats: 3,
          maxReadOnlyToolChars: 48000,
        })
      : { shouldRecover: false, reason: "", readOnlyActivityCount: 0, batchToolChars: 0 };
  if (chatReadOnlyNoProgress.shouldRecover) {
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    const progressSignature = buildPlanProgressSignatureFromToolActivity(recentToolActivity) || noProgressBatchSignature;
    if (repairExecutionRequestInChat) {
      const strategyDecision = resolveExecuteNoProgressStrategyDecision({
        attemptedStrategies: noProgressStrategyPivots,
        unfinishedObjective: latestUserPromptText,
        availableToolNames,
        cause: chatReadOnlyNoProgress.reason,
        language: callbacks.getPreferredLanguage(),
      });
      if (strategyDecision.action === "continue_with_pivot") {
        noProgressStrategyPivots.splice(
          0,
          noProgressStrategyPivots.length,
          ...strategyDecision.attemptedStrategies,
        );
        const activatedRecovery = activateTrackedExecuteRecovery(
          "mutation_first",
          `chat_repair_strategy_pivot:${strategyDecision.strategy}`,
          {
            resetExpectedTarget: true,
            readLease: null,
            decisionCheckpoint: {
              expectedTarget: null,
              sourceObservationKey: null,
              nextRequiredCapability: "mutation",
              noProgressStrategyPivots: strategyDecision.attemptedStrategies,
            },
          },
        );
        callbacks.appendMessage({
          role: "user",
          content: [
            strategyDecision.prompt,
            buildExecuteRecoveryPrompt({
              language: MODEL_CONTROL_LANGUAGE,
              reason: `chat_repair_strategy_pivot:${strategyDecision.strategy}`,
              contract: resolveRuntimeRecoveryActionContract(activatedRecovery),
              repeatedTargets,
              recentActivity: recentToolActivity,
            }),
          ].join("\n\n"),
        });
        callbacks.onStatusChange("running");
        logAgentEvent("chat_repair_no_progress_strategy_pivot", {
          iteration,
          strategy: strategyDecision.strategy,
          attemptedStrategies: strategyDecision.attemptedStrategies,
          repeatedTargets,
          progressSignature: truncateForLog(progressSignature, 220),
        });
        return {
          status: "continue",
          tracking,
          noProgressBatchSignature,
          pendingExecuteRecoveryPrompt,
          pendingExecuteNoProgressPause,
        };
      }
      logAgentEvent("chat_repair_readonly_no_progress_paused", {
        reason: chatReadOnlyNoProgress.reason,
        iteration,
        repeats: noProgressBatchRepeatCount,
        readOnlyActivityCount: chatReadOnlyNoProgress.readOnlyActivityCount,
        batchToolChars: chatReadOnlyNoProgress.batchToolChars,
        repeatedTargets,
        progressSignature: truncateForLog(progressSignature, 220),
        userPromptPreview: truncateForLog(latestUserPromptText, 180),
      });
      const language = callbacks.getPreferredLanguage();
      callbacks.onNonActionableStop(
        buildExecuteNoProgressLoopPauseNotice({
          language,
          scope: "chat",
          repeats: Math.max(1, noProgressBatchRepeatCount),
          remainingTask: language === "zh"
            ? "用户目标是找到问题并修复；当前回合只完成了只读排查，没有进入写入、命令验证、浏览器验证或明确阻塞。请继续时按执行意图恢复，而不是再输出普通总结。"
            : "The user's goal is to find and fix the issue; this turn only completed read-only investigation and did not reach a write, command validation, browser validation, or concrete blocker. Resume as execution instead of ending with a plain summary.",
          recentActivity: recentToolActivity,
          repeatedTargets,
        }),
        "no_action",
        {
          phase: "paused",
          nextStep: language === "zh"
            ? "继续时应进入执行能力，基于已读证据直接修复/验证，或说明精确阻塞。"
            : "Resume with execution capabilities and patch/validate from cached evidence, or state the exact blocker.",
          repeatedTargets,
          progressSignature,
        },
      );
      callbacks.onStatusChange("idle");
      return {
        status: "stopped",
        tracking,
        noProgressBatchSignature,
        pendingExecuteRecoveryPrompt,
        pendingExecuteNoProgressPause,
      };
    }
    activateChatFinalSynthesis(chatReadOnlyNoProgress.reason, {
      repeats: noProgressBatchRepeatCount,
      readOnlyActivityCount: chatReadOnlyNoProgress.readOnlyActivityCount,
      batchToolChars: chatReadOnlyNoProgress.batchToolChars,
      repeatedTargets,
      progressSignature: truncateForLog(progressSignature, 220),
    });
    logAgentEvent("chat_readonly_no_progress_final_synthesis", {
      reason: chatReadOnlyNoProgress.reason,
      iteration,
      repeats: noProgressBatchRepeatCount,
      readOnlyActivityCount: chatReadOnlyNoProgress.readOnlyActivityCount,
      batchToolChars: chatReadOnlyNoProgress.batchToolChars,
      repeatedTargets,
      progressSignature: truncateForLog(progressSignature, 220),
    });
    callbacks.onStatusChange("running");
    return {
      status: "continue",
      tracking,
      noProgressBatchSignature,
      pendingExecuteRecoveryPrompt,
      pendingExecuteNoProgressPause,
    };
  }

  const approvedPlanCachedReadOnlyBatch =
    callbacks.getIsPlanApproved() &&
    hasPendingApprovedPlanSourceMutation(
      callbacks.getPlanTasks(),
      callbacks.getPlanExecutionEvidenceLedger(),
    ) &&
    isApprovedPlanCachedReadOnlyNoProgressBatch({
      results,
      readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
      sawExecutionEvidence: sawExecuteOperationEvidence,
    });
  if (approvedPlanCachedReadOnlyBatch) {
    const repeatedTargets = summarizeRepeatedExecuteTargets(
      recentToolActivity.slice(-12),
    );
    const activatedRecovery = activateTrackedExecuteRecovery(
      "mutation_first",
      "no_progress_cached_read_only_batch",
      {
        repeatedTargets,
        currentBatchTools: results.map((result) => result.name).slice(0, 8),
        currentBatchTargets: results.map((result) => result.target).filter(Boolean).slice(0, 8),
      },
    );
    pendingExecuteRecoveryPrompt = buildExecuteRecoveryPrompt({
      language: MODEL_CONTROL_LANGUAGE,
      reason: "no_progress_cached_read_only_batch",
      contract: resolveRuntimeRecoveryActionContract(activatedRecovery),
      repeatedTargets,
      recentActivity: recentToolActivity,
    });
    logAgentEvent("approved_plan_cached_read_only_entered_execute_recovery", {
      iteration,
      repeatedTargets,
      phase: resolveRuntimeRecoveryActionContract(activatedRecovery).phase,
      protocolNoProgressCount: activatedRecovery.protocolNoProgressCount,
    });
  }

  if (noProgressBatchRepeatCount >= MAX_NO_PROGRESS_LOOP_REPEATS) {
    if (isUnapprovedPlanReadOnlyBatch) {
      logAgentEvent("no_progress_deferred_to_plan_readonly_convergence", {
        iteration,
        repeats: noProgressBatchRepeatCount,
        batches: planReadOnlyConvergenceBatches,
        tools: planReadOnlyConvergenceTools,
      });
    } else if (executeMutationRecoveryEligible && pendingExecuteRecoveryPrompt) {
      logAgentEvent("execute_no_progress_deferred_to_recovery", {
        iteration,
        repeats: noProgressBatchRepeatCount,
        executeRecoveryMode: currentExecuteRecoveryMode,
        executeRecoveryReason: currentExecuteRecoveryReason,
      });
    } else if (executeMutationRecoveryEligible) {
      const language = callbacks.getPreferredLanguage();
      const repeatedTargets = pendingExecuteNoProgressPause?.repeatedTargets.length
        ? pendingExecuteNoProgressPause.repeatedTargets
        : summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
      const progressSignature =
        pendingExecuteNoProgressPause?.progressSignature ||
        buildPlanProgressSignatureFromToolActivity(recentToolActivity) ||
        noProgressBatchSignature;
      const currentTaskId = currentExecuteRecoveryState.decisionCheckpoint?.planTaskId || "";
      const currentTask = callbacks.getPlanTasks().find((task) =>
        currentTaskId && String(task.id || "") === currentTaskId
      );
      const strategyDecision = resolveExecuteNoProgressStrategyDecision({
        attemptedStrategies:
          currentExecuteRecoveryState.decisionCheckpoint?.noProgressStrategyPivots,
        currentTaskId,
        expectedTarget: currentExecuteRecoveryState.expectedTarget,
        unfinishedObjective: currentTask?.text || remainingTaskText,
        availableToolNames,
        cause: pendingExecuteNoProgressPause?.reason || "execute_no_progress_batch_loop",
        language,
      });
      if (strategyDecision.action === "continue_with_pivot") {
        const priorCheckpoint = currentExecuteRecoveryState.decisionCheckpoint;
        const activatedRecovery = activateTrackedExecuteRecovery(
          "mutation_first",
          `no_progress_strategy_pivot:${strategyDecision.strategy}`,
          {
            expectedTarget: currentExecuteRecoveryState.expectedTarget,
            readLease: null,
            sourceObservationKey: currentExecuteRecoveryState.sourceObservationKey,
            decisionCheckpoint: {
              ...(priorCheckpoint || {
                expectedTarget: currentExecuteRecoveryState.expectedTarget,
                sourceObservationKey: currentExecuteRecoveryState.sourceObservationKey,
              }),
              nextRequiredCapability: "mutation",
              noProgressStrategyPivots: strategyDecision.attemptedStrategies,
            },
          },
        );
        pendingExecuteRecoveryPrompt = [
          strategyDecision.prompt,
          buildExecuteRecoveryPrompt({
            language: MODEL_CONTROL_LANGUAGE,
            reason: `no_progress_strategy_pivot:${strategyDecision.strategy}`,
            contract: resolveRuntimeRecoveryActionContract(activatedRecovery),
            repeatedTargets,
            recentActivity: recentToolActivity,
          }),
        ].join("\n\n");
        logAgentEvent("execute_no_progress_strategy_pivot", {
          iteration,
          strategy: strategyDecision.strategy,
          attemptedStrategies: strategyDecision.attemptedStrategies,
          currentTaskId: activatedRecovery.decisionCheckpoint?.planTaskId || null,
          expectedTarget: activatedRecovery.expectedTarget,
          repeatedTargets,
        });
        callbacks.onStatusChange("running");
        return {
          status: "continue",
          tracking,
          noProgressBatchSignature,
          pendingExecuteRecoveryPrompt,
          pendingExecuteNoProgressPause: null,
        };
      }
      const pauseNotice = pendingExecuteNoProgressPause?.notice || buildExecuteNoProgressLoopPauseNotice({
        language,
        repeats: noProgressBatchRepeatCount,
        remainingTask: language === "zh"
          ? "先停止重复读取，改为写入、命令验证、浏览器验证，或说明真实阻塞。"
          : "stop repeated reads and pivot to patch/write, command validation, browser validation, or the real blocker",
        recentActivity: recentToolActivity,
        repeatedTargets,
      });
      logAgentEvent("loop_stop", {
        reason: "execute_no_progress_batch_loop",
        iteration,
        repeats: noProgressBatchRepeatCount,
        repeatedTargets,
        progressSignature: truncateForLog(progressSignature, 220),
        recoveryReason: pendingExecuteNoProgressPause?.reason || "",
      });
      emitTaskOrchestratorPhase("PAUSED", {
        reason: "execute_no_progress_batch_loop",
        iteration,
        repeats: noProgressBatchRepeatCount,
        remainingTask: language === "zh"
          ? "复用已读上下文，改为执行动作或说明真实阻塞。"
          : "reuse read context, take action, or state the real blocker",
        repeatedTargets,
      });
      callbacks.onNonActionableStop(
        pauseNotice,
        "no_action",
        {
          progressSignature,
          repeatedTargets,
          recoveryReason: "execute_no_progress_batch_loop",
          nextStep: language === "zh"
            ? "复用已读上下文，转向写入/命令/浏览器验证，或说明真实阻塞"
            : "reuse cached context and pivot to patch/run/browser validation, or state the real blocker",
        },
      );
      callbacks.onStatusChange("idle");
      return {
        status: "stopped",
        tracking,
        noProgressBatchSignature,
        pendingExecuteRecoveryPrompt,
        pendingExecuteNoProgressPause,
      };
    } else {
      const remainingText = remainingTaskText || (
        callbacks.getPreferredLanguage() === "zh"
          ? "先重新核对当前目标与参数，再选择不同策略继续。"
          : "Recheck current targets and parameters, then continue with a different strategy."
      );
      const language = callbacks.getPreferredLanguage();
      const repeatedTargets = (() => {
        const counts = new Map<string, number>();
        for (const activity of recentPlanToolActivity.slice(-8)) {
          const target = String(activity.target || "").trim();
          if (!target) continue;
          const cachedWeight = isReadOnlyNoProgressDetail(activity.detail) ? 2 : 1;
          counts.set(target, (counts.get(target) || 0) + cachedWeight);
        }
        return [...counts.entries()]
          .filter(([, count]) => count >= 2)
          .sort((a, b) => b[1] - a[1])
          .map(([target]) => target)
          .slice(0, 4);
      })();
      const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity) || noProgressBatchSignature;
      const pauseNotice = buildPlanNoProgressLoopPauseNotice({
        language,
        repeats: noProgressBatchRepeatCount,
        remainingTask: remainingText,
        evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
        recentToolActivity: recentPlanToolActivity,
        repeatedTargets,
      });
      logAgentEvent("loop_stop", {
        reason: "no_progress_batch_loop",
        iteration,
        repeats: noProgressBatchRepeatCount,
        repeatedTargets,
        progressSignature: truncateForLog(progressSignature, 220),
      });
      emitTaskOrchestratorPhase("PAUSED", {
        reason: "no_progress_batch_loop",
        iteration,
        repeats: noProgressBatchRepeatCount,
        remainingTask: remainingText,
        repeatedTargets,
      });
      callbacks.onNonActionableStop(
        pauseNotice,
        "no_action",
        {
          progressSignature,
          repeatedTargets,
          recoveryReason: "no_progress_batch_loop",
          nextStep: language === "zh"
            ? "换目标、改为写入/命令/浏览器验证，或说明真实阻塞"
            : "switch target, patch/run/browser-verify, or state the real blocker",
        },
      );
      callbacks.onStatusChange("idle");
      return {
        status: "stopped",
        tracking,
        noProgressBatchSignature,
        pendingExecuteRecoveryPrompt,
        pendingExecuteNoProgressPause,
      };
    }
  }

  return {
    status: "none",
    tracking,
    noProgressBatchSignature,
    pendingExecuteRecoveryPrompt,
    pendingExecuteNoProgressPause,
  };
}

export type TargetProgressLoopRecoveryResult =
  | { status: "none" }
  | { status: "continue" }
  | { status: "stopped" };

export function handleTargetProgressLoopRecovery(input: {
  callbacks: OrchestratorCallbacks;
  workspace: string | null | undefined;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  results: ToolExecutionResult[];
  effectiveToolCalls: ToolCallToExecute[];
  recentTargetToolCalls: Array<{ name: string; targetKey: string; family: "edit" | "verify" | "other" }>;
  targetProgressGuardRecoveredSignatures: Set<string>;
  recentToolActivity: PlanToolActivitySummary[];
  executeRecoveryAttempts: number;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => ExecuteRecoveryRuntimeState;
}): TargetProgressLoopRecoveryResult {
  const {
    callbacks,
    workspace,
    workflowMode,
    runtimeIntent,
    results,
    effectiveToolCalls,
    recentTargetToolCalls,
    targetProgressGuardRecoveredSignatures,
    recentToolActivity,
    executeRecoveryAttempts,
    activateExecuteRecovery,
  } = input;

  const resultByToolCallId = new Map(results.map((result) => [result.toolCallId, result]));
  for (const toolCall of effectiveToolCalls) {
    const toolArgs = parseToolCallArguments(toolCall, workspace);
    const target = getShellMutationTargetForLoopGuard(toolCall.name, toolArgs) || getToolTarget(toolCall.name, toolArgs);
    const toolResult = resultByToolCallId.get(toolCall.id);
    const outcome = targetProgressOutcomeForToolResult(toolResult);
    const reason = targetProgressReasonForToolResult(toolResult);
    const progressCheck = registerTargetProgressEventForLoopGuard(recentTargetToolCalls, {
      name: toolCall.name,
      target,
      outcome,
      reason,
    });
    if (!progressCheck.repeated) continue;

    const recoveryMessage = formatTargetProgressLoopRecoveryMessage(
      progressCheck.family,
      target || progressCheck.targetKey,
      progressCheck.threshold,
    );
    const isExecuteTargetRecoveryEligible =
      isExecuteMutationRecoveryEligible({ callbacks, workflowMode, runtimeIntent }) &&
      progressCheck.family === "edit" &&
      (outcome === "blocked" || outcome === "failed" || outcome === "no_change");
    const displayTarget = String(target || progressCheck.targetKey || "").replace(/^shell-write:/, "");
    const appendExecuteTargetRecoveryPrompt = (
      mode: Exclude<ExecuteRecoveryMode, "normal">,
      recoveryReason: string,
    ) => {
      const activatedRecovery = activateExecuteRecovery(mode, recoveryReason, {
        target: displayTarget,
        outcome,
        reason,
      });
      callbacks.appendMessage({
        role: "user",
        content: buildExecuteRecoveryPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          reason: recoveryReason,
          contract: resolveRuntimeRecoveryActionContract(activatedRecovery),
          repeatedTargets: displayTarget ? [displayTarget] : summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
          recentActivity: recentToolActivity,
        }),
      });
    };

    if (!targetProgressGuardRecoveredSignatures.has(progressCheck.signature)) {
      targetProgressGuardRecoveredSignatures.add(progressCheck.signature);
      recentTargetToolCalls.length = 0;
      callbacks.onToolError(toolCall.name, target, recoveryMessage, { toolCallId: toolCall.id });
      callbacks.appendMessage({
        role: "system",
        content: `[System: ${recoveryMessage}]`,
      });
      if (isExecuteTargetRecoveryEligible && executeRecoveryAttempts < 2) {
        appendExecuteTargetRecoveryPrompt("mutation_first", "target_progress_mutation_failure");
      }
      return { status: "continue" };
    }

    if (isExecuteTargetRecoveryEligible && executeRecoveryAttempts < 3) {
      recentTargetToolCalls.length = 0;
      callbacks.onToolError(toolCall.name, target, recoveryMessage, { toolCallId: toolCall.id });
      callbacks.appendMessage({
        role: "system",
        content: `[System: ${recoveryMessage}]`,
      });
      appendExecuteTargetRecoveryPrompt("mutation_first", "target_progress_no_diff_chain");
      return { status: "continue" };
    }

    callbacks.onNonActionableStop(
      callbacks.getPreferredLanguage() === "zh"
        ? [
            "执行已暂停：检测到同一目标上的工具进展循环。",
            recoveryMessage,
            "请继续时先核查当前 workspace 状态，再选择不同策略或输出最终结果。",
          ].join("\n")
        : [
            "Execution paused: detected a tool progress loop on the same target.",
            recoveryMessage,
            "On resume, first inspect current workspace state, then choose a different strategy or output the final result.",
          ].join("\n"),
      "no_action",
    );
    callbacks.onStatusChange("idle");
    return { status: "stopped" };
  }

  return { status: "none" };
}

export function handleExecuteConvergencePrompt(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  effectiveMaxIterations: number;
  usedExecuteConvergencePrompt: boolean;
  recentToolActivity: PlanToolActivitySummary[];
  executeRecoveryMode: ExecuteRecoveryMode;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => void;
}): { usedExecuteConvergencePrompt: boolean } {
  const {
    callbacks,
    workflowMode,
    runtimeIntent,
    iteration,
    effectiveMaxIterations,
    usedExecuteConvergencePrompt,
    recentToolActivity,
    executeRecoveryMode,
    activateExecuteRecovery,
  } = input;

  const shouldConvergeExecuteTurn = workflowMode === "edit";
  if (
    !shouldConvergeExecuteTurn ||
    usedExecuteConvergencePrompt ||
    iteration < Math.max(
      8,
      Math.floor(effectiveMaxIterations * EXECUTE_CONVERGENCE_PROMPT_RATIO),
    )
  ) {
    return { usedExecuteConvergencePrompt };
  }

  logAgentEvent("execute_convergence_prompt", {
    iteration,
    maxIterations: effectiveMaxIterations,
    recentToolActivity: recentToolActivity.length,
    executeRecoveryMode,
  });
  if (isExecuteMutationRecoveryEligible({ callbacks, workflowMode, runtimeIntent })) {
    const recoveryMode = !callbacks.getIsPlanApproved() &&
        hasSuccessfulWorkspaceMutationEvidence({
          ledger: callbacks.getPlanExecutionEvidenceLedger(),
          transactionId: callbacks.getCurrentTurnId?.(),
        })
      ? "validation_only"
      : "mutation_first";
    activateExecuteRecovery(recoveryMode, "execute_convergence_prompt", {
      maxIterations: effectiveMaxIterations,
      recentToolActivity: recentToolActivity.length,
      recoveryMode,
      // A convergence checkpoint audits the whole objective. A single-file
      // lock belongs only to the preceding read/mutate transaction and must
      // not prevent the model from fixing another file in the same turn.
      resetExpectedTarget: true,
    });
  }
  callbacks.appendMessage({
    role: "user",
    content: buildExecuteConvergencePrompt(MODEL_CONTROL_LANGUAGE, iteration, effectiveMaxIterations),
  });

  return { usedExecuteConvergencePrompt: true };
}

export type StrictRepeatGuardRecoveryResult =
  | { status: "none" }
  | { status: "continue" }
  | { status: "stopped" };

export function handleStrictRepeatGuardRecovery(input: {
  callbacks: OrchestratorCallbacks;
  workspace: string;
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  effectiveToolCalls: ToolCallToExecute[];
  results: ToolExecutionResult[];
  recentToolCalls: Array<{ name: string; argsKey: string }>;
  repeatGuardRecoveredSignatures: Set<string>;
  recentPlanToolActivity: PlanToolActivitySummary[];
  availableToolNames: Set<string>;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  toolPermissionPolicy: ToolPermissionPolicy;
  executeRecoveryState?: ExecuteRecoveryRuntimeState;
  activateExecuteRecovery?: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => ExecuteRecoveryRuntimeState;
}): StrictRepeatGuardRecoveryResult {
  const {
    callbacks,
    workspace,
    runtimeIntent,
    iteration,
    effectiveToolCalls,
    results,
    recentToolCalls,
    repeatGuardRecoveredSignatures,
    recentPlanToolActivity,
    availableToolNames,
    toolCapabilityRegistry,
    toolPermissionPolicy,
    executeRecoveryState,
    activateExecuteRecovery,
  } = input;

  let currentExecuteRecoveryState = executeRecoveryState;
  const appendStructuredRepeatPivot = (pivotInput: {
    signature: string;
    toolName: string;
    target: string;
    cause: string;
    closeReadSurface: boolean;
    policyFeedback?: string;
  }): boolean => {
    const attemptedStrategies = EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS.filter((strategy) =>
      repeatGuardRecoveredSignatures.has(
        `${pivotInput.signature}:strategy:${strategy}`,
      )
    );
    const currentTaskId = currentExecuteRecoveryState?.decisionCheckpoint?.planTaskId || "";
    const currentTask = callbacks.getPlanTasks().find((task) =>
      currentTaskId && String(task.id || "") === currentTaskId
    );
    const decision = resolveExecuteNoProgressStrategyDecision({
      attemptedStrategies,
      currentTaskId,
      expectedTarget: currentExecuteRecoveryState?.expectedTarget || pivotInput.target,
      unfinishedObjective: currentTask?.text,
      availableToolNames,
      cause: pivotInput.cause,
      language: callbacks.getPreferredLanguage(),
      requireExecutionEvidence:
        callbacks.getIsPlanApproved() || isMutationRuntimeIntent(runtimeIntent),
    });
    if (decision.action !== "continue_with_pivot") return false;

    repeatGuardRecoveredSignatures.add(pivotInput.signature);
    repeatGuardRecoveredSignatures.add(
      `${pivotInput.signature}:strategy:${decision.strategy}`,
    );
    recentToolCalls.length = 0;
    if (
      pivotInput.closeReadSurface &&
      activateExecuteRecovery &&
      (callbacks.getIsPlanApproved() || isMutationRuntimeIntent(runtimeIntent))
    ) {
      const priorCheckpoint = currentExecuteRecoveryState?.decisionCheckpoint;
      currentExecuteRecoveryState = activateExecuteRecovery(
        "mutation_first",
        `repeat_guard_strategy_pivot:${decision.strategy}`,
        {
          expectedTarget: currentExecuteRecoveryState?.expectedTarget || pivotInput.target,
          readLease: null,
          sourceObservationKey: currentExecuteRecoveryState?.sourceObservationKey || null,
          decisionCheckpoint: {
            ...(priorCheckpoint || {
              expectedTarget: currentExecuteRecoveryState?.expectedTarget || pivotInput.target,
              sourceObservationKey: currentExecuteRecoveryState?.sourceObservationKey || null,
            }),
            nextRequiredCapability: "mutation",
            noProgressStrategyPivots: decision.attemptedStrategies,
          },
        },
      );
    }
    callbacks.appendMessage({
      role: "system",
      content: `[System: ${[
        pivotInput.policyFeedback,
        decision.prompt,
      ].filter(Boolean).join("\n\n")}]`,
    });
    logAgentEvent("strict_repeat_strategy_pivot", {
      iteration,
      tool: pivotInput.toolName,
      target: pivotInput.target,
      strategy: decision.strategy,
      attemptedStrategies: decision.attemptedStrategies,
      runtimeIntent,
    });
    return true;
  };

  const resultByToolCallId = new Map(
    results.map((result) => [result.toolCallId, result]),
  );

  for (const toolCall of effectiveToolCalls) {
    const executionResult = resultByToolCallId.get(toolCall.id);
    const toolArgs = parseToolCallArguments(toolCall, workspace);
    const target = executionResult?.target || getToolTarget(toolCall.name, toolArgs);
    const policySignature = buildRepeatLoopSignature(
      toolCall.name,
      buildRepeatLoopArgsKey(toolArgs),
    );
    if (
      executionResult?.internalFeedback === true &&
      (executionResult.qualityGateReason === "repeated_failure_blocked" ||
        executionResult.qualityGateReason === "repeated_failure_exhausted")
    ) {
      if (appendStructuredRepeatPivot({
        signature: policySignature,
        toolName: toolCall.name,
        target,
        cause: executionResult.qualityGateReason,
        closeReadSurface: toolCall.name === "read_file",
        policyFeedback: executionResult.content,
      })) {
        return { status: "continue" };
      }
      const notice = callbacks.getPreferredLanguage() === "zh"
        ? `执行已暂停：${toolCall.name}${target ? ` (${target})` : ""} 在两次差异化策略纠正后仍被原样请求。`
        : `Execution paused: ${toolCall.name}${target ? ` (${target})` : ""} was requested unchanged after both differentiated strategy pivots.`;
      callbacks.onNonActionableStop(notice, "no_action", {
        recoveryReason: "repeated_failure_policy_no_progress",
        repeatedTargets: target ? [target] : [],
        nextStep: callbacks.getPreferredLanguage() === "zh"
          ? "改变参数、目标或工具，或说明真实阻塞"
          : "change arguments, target, or tool, or state the real blocker",
      });
      callbacks.onStatusChange("idle");
      logAgentEvent("repeated_failure_policy_exhausted", {
        iteration,
        tool: toolCall.name,
        target,
        attemptedStrategies: [...EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS],
      });
      return { status: "stopped" };
    }
    // The strict guard protects real repeated executions. Calls converted by
    // preflight/recovery policy into internal feedback never reached a tool,
    // so their bounded convergence belongs to RecoveryActionContract's
    // protocol-no-progress counter instead of this global fatal guard.
    if (!executionResult || executionResult.internalFeedback) continue;
    const autoExecutable = isToolAutoExecutableForCall(
      toolCall.name,
      toolArgs,
      toolCapabilityRegistry,
      toolPermissionPolicy,
      {
        workspace,
        approvedLocalFileReadPaths: callbacks.getApprovedLocalFileReadPaths(),
      },
    );
    const readOnlyShellInspection = isReadOnlyShellInspectionToolCall(toolCall.name, toolArgs);
    const repeatGuardReadOnly = autoExecutable || readOnlyShellInspection;
    const repeatCheck = registerToolCallForRepeatGuard(
      recentToolCalls,
      toolCall.name,
      toolArgs,
      repeatGuardReadOnly,
    );
    if (!repeatCheck.repeated) continue;

    const repeatedPtyControl = toolCall.name === "send_pty_input" && isPtyControlInput(
      typeof toolArgs.input === "string" ? toolArgs.input : "",
      typeof toolArgs.control === "string" ? toolArgs.control : undefined,
    );
    if (repeatedPtyControl) {
      const recoveryMessage = callbacks.getPreferredLanguage() === "zh"
        ? "PTY_CONTROL_ALREADY_SENT: 同一终端控制动作已经投递；不要再次发送。下一步必须使用 get_pty_status/read_pty_since 观察当前代状态，或直接继续下一个任务。"
        : "PTY_CONTROL_ALREADY_SENT: the same terminal control was already delivered; do not send it again. Next, observe the current generation with get_pty_status/read_pty_since or continue the next task.";
      recentToolCalls.length = 0;
      repeatGuardRecoveredSignatures.add(repeatCheck.signature);
      callbacks.onToolDone(toolCall.name, target, recoveryMessage, {
        toolCallId: toolCall.id,
        internalFeedback: true,
        qualityGateReason: "pty_control_observation_required",
      });
      callbacks.appendMessage({ role: "system", content: `[System: ${recoveryMessage}]` });
      logAgentEvent("pty_control_repeat_redirected", {
        iteration,
        tool: toolCall.name,
        target,
        threshold: repeatCheck.threshold,
      });
      return { status: "continue" };
    }
    const repeatCause = callbacks.getIsPlanApproved() && toolCall.name === "browser_evaluate"
      ? "approved_plan_repeated_browser_validation"
      : callbacks.getIsPlanApproved() && runtimeIntent === "execute" && toolCall.name === "read_file"
      ? "approved_plan_repeated_read_file"
      : `strict_repeat_${toolCall.name}`;
    if (appendStructuredRepeatPivot({
      signature: repeatCheck.signature,
      toolName: toolCall.name,
      target,
      cause: repeatCause,
      closeReadSurface: toolCall.name === "read_file",
    })) {
      return { status: "continue" };
    }

    if (callbacks.getIsPlanApproved() && toolCall.name === "browser_evaluate") {
      const language = callbacks.getPreferredLanguage();
      const repeatedTargets = target ? [target] : summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
      const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
      const notice = language === "zh"
        ? [
            "执行已暂停：浏览器验证重复调用同一目标，没有产生新的执行证据。",
            `重复目标：${repeatedTargets.join("、") || "未定位到单一目标"}`,
            "MAIN 已保留最近一次 Browser/Playwright 结果；继续时请复用已有验证，改为下一个任务、命令验证、源码修正或最终总结。",
          ].join("\n")
        : [
            "Execution paused: browser validation repeated the same target without new evidence.",
            `Repeated target: ${repeatedTargets.join(", ") || "no single target identified"}`,
            "MAIN kept the latest Browser/Playwright result; on resume, reuse it and move to the next task, command validation, source edit, or final summary.",
          ].join("\n");
      logAgentEvent("loop_stop", {
        reason: "approved_plan_repeated_browser_validation",
        iteration,
        target,
        progressSignature: truncateForLog(progressSignature, 220),
      });
      callbacks.onNonActionableStop(
        notice,
        "no_action",
        {
          progressSignature,
          repeatedTargets,
          recoveryReason: "approved_plan_repeated_browser_validation",
          nextStep: language === "zh"
            ? "复用已有浏览器结果，转向下一个任务、命令验证、源码修正或最终总结"
            : "reuse the browser result and move to the next task, command validation, source edit, or final summary",
        },
      );
      callbacks.onStatusChange("idle");
      return { status: "stopped" };
    }

    const remainingTask = callbacks.getPlanTasks().find((task) => !isPlanTaskTrustedComplete(task));
    const defaultSuggestedNextTask = callbacks.getPreferredLanguage() === "zh"
      ? "先复用已成功结果，再继续下一个文件或不同目标"
      : "reuse successful results already in context, then continue with the next file or a different target";
    if (callbacks.getIsPlanApproved() && runtimeIntent === "execute" && toolCall.name === "read_file") {
      const language = callbacks.getPreferredLanguage();
      const repeatedTargets = target ? [target] : summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
      const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
      const notice = language === "zh"
        ? [
            "计划执行已暂停：模型重复读取同一个源码目标，没有产生新的执行证据。",
            `重复目标：${repeatedTargets.join("、") || "未定位到单一目标"}`,
            `下一步建议：${remainingTask?.text || defaultSuggestedNextTask}`,
            "MAIN 已保留最近读取内容；继续时请复用缓存上下文，改为精确 patch/replace/write、运行验证，或说明真实阻塞。",
          ].join("\n")
        : [
            "Plan execution paused: the model repeatedly read the same source target without producing new execution evidence.",
            `Repeated target: ${repeatedTargets.join(", ") || "no single target identified"}`,
            `Suggested next step: ${remainingTask?.text || defaultSuggestedNextTask}`,
            "MAIN kept the latest file content; on resume, reuse cached context and switch to a precise patch/replace/write, validation, or a concrete blocker.",
          ].join("\n");
      logAgentEvent("loop_stop", {
        reason: "approved_plan_repeated_read_file",
        iteration,
        target,
        progressSignature: truncateForLog(progressSignature, 220),
        repeatedTargets,
      });
      callbacks.onNonActionableStop(
        notice,
        "no_action",
        {
          progressSignature,
          repeatedTargets,
          recoveryReason: "approved_plan_repeated_read_file",
          nextStep: language === "zh"
            ? "复用缓存源码内容，改为 patch/replace/write、验证或明确阻塞"
            : "reuse cached source context and pivot to patch/replace/write, validation, or blocker",
        },
      );
      callbacks.onStatusChange("idle");
      return { status: "stopped" };
    }

    const fatalMessage = formatRepeatLoopFatalMessage(toolCall.name, target, repeatCheck.threshold);
    const recentEvidence = callbacks.getPlanExecutionEvidenceLedger()
      .filter((entry) => !["failed", "pending", "running", "unknown", "stopped"].includes(
        String(entry.observationStatus || ""),
      ))
      .slice(-5);
    const recentEvidenceText = recentEvidence.length > 0
      ? recentEvidence.map((entry) => `${entry.kind}:${entry.target || entry.value} via ${entry.sourceTool}`).join(" | ")
      : callbacks.getPreferredLanguage() === "zh" ? "无" : "none";
    const structuredRecovery = callbacks.getPreferredLanguage() === "zh"
      ? [
          "RecoveryDetails:",
          `- duplicateTool: ${toolCall.name}`,
          `- target: ${target || "unknown"}`,
          `- duplicateCount: ${repeatCheck.threshold}+`,
          `- recentSuccessfulEvidence: ${recentEvidenceText}`,
          `- suggestedNextTask: ${remainingTask?.text || defaultSuggestedNextTask}`,
        ].join("\n")
      : [
          "RecoveryDetails:",
          `- duplicateTool: ${toolCall.name}`,
          `- target: ${target || "unknown"}`,
          `- duplicateCount: ${repeatCheck.threshold}+`,
          `- recentSuccessfulEvidence: ${recentEvidenceText}`,
          `- suggestedNextTask: ${remainingTask?.text || defaultSuggestedNextTask}`,
        ].join("\n");
    const recoveryHint = remainingTask
      ? callbacks.getPreferredLanguage() === "zh"
        ? `\nRecovery: 请开启新的恢复上下文，从证据未满足的任务继续：${remainingTask.text}`
        : `\nRecovery: start a fresh recovery context and continue with an evidence-unsatisfied task such as: ${remainingTask.text}`
      : callbacks.getPreferredLanguage() === "zh"
      ? "\nRecovery: 请开启新的恢复上下文，先复用已成功结果，再继续下一个文件或不同目标。"
      : "\nRecovery: start a fresh recovery context, reuse successful results, then continue with the next file or a different target.";
    const pauseNotice = `${fatalMessage}\n${structuredRecovery}${recoveryHint}`;
    callbacks.onNonActionableStop(pauseNotice, "no_action", {
      progressSignature: buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity),
      repeatedTargets: target ? [target] : [],
      recoveryReason: "strict_repeat_strategy_exhausted",
      nextStep: remainingTask?.text || defaultSuggestedNextTask,
    });
    callbacks.onStatusChange("idle");
    logAgentEvent("loop_stop", {
      reason: "strict_repeat_strategy_exhausted",
      iteration,
      tool: toolCall.name,
      target,
      attemptedStrategies: [...EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS],
    });
    return { status: "stopped" };
  }

  return { status: "none" };
}
