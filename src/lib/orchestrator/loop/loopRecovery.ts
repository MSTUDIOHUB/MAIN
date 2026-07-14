import {
  EXECUTION_VERIFICATION_TOOL_NAMES,
  EXECUTE_CONVERGENCE_PROMPT_RATIO,
  MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS,
  MAX_CONSECUTIVE_READ_ONLY_ITERATIONS,
  MAX_NO_PROGRESS_LOOP_REPEATS,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
  PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO,
  buildExecuteConvergencePrompt,
  buildNoProgressBatchSignature,
  buildReadFileRepeatLimitBatchPauseNotice,
  getToolTarget,
  isReadFileRepeatLimitResult,
  isReadFileOnlyPattern,
  logAgentEvent,
  parseToolCallArguments,
  summarizeReadFileRepeatLimitBatch,
  targetProgressOutcomeForToolResult,
  targetProgressReasonForToolResult,
  truncateForLog,
} from "../../orchestrator";
import { isApprovedPlanCachedReadOnlyNoProgressBatch } from "../../approvedPlanRecoveryTools";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  buildExecuteNoProgressLoopPauseNotice,
  buildExecuteRecoveryPrompt,
  buildExecuteValidationRecoveryPrompt,
  isExecutePatchMismatchRecoveryActivity,
  isReadOnlyNoProgressDetail,
  resolveExecuteReadOnlyRecoveryTrigger,
  resolveReadOnlyNoProgressTrigger,
  shouldAllowExecuteRecoveryFileRead,
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import {
  buildPlanNoProgressLoopPauseNotice,
  buildPlanProgressSignatureFromToolActivity,
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import {
  formatRepeatLoopFatalMessage,
  formatRepeatLoopRecoveryMessage,
  formatTargetProgressLoopRecoveryMessage,
  getShellMutationTargetForLoopGuard,
  isReadOnlyShellInspectionToolCall,
  registerTargetProgressEventForLoopGuard,
  registerToolCallForRepeatGuard,
} from "../../repetitionGuard";
import {
  buildPlanTaskEvidenceAudit,
  isPlanTaskTrustedComplete,
  planTaskHasUnsatisfiedSourceMutationEvidence,
} from "../../workflowModels";
import { workspacePathsReferToSameFile } from "../../workspacePaths";
import {
  isToolAutoExecutableForCall,
  type ToolCapabilityRegistry,
  type ToolPermissionPolicy,
} from "../../toolCapabilities";
import type { OrchestratorCallbacks, ToolCallToExecute, ToolExecutionResult } from "../types";
import {
  isEditProgressResult,
  isVerificationEvidenceResult,
} from "./toolActivityTracking";
import type { CrossIterationFileReadObservation } from "./loopGuardRuntimeState";

const DEFAULT_CROSS_ITERATION_READ_CONTEXT_LIMIT = 128000;
const SMALL_CONTEXT_READ_LOOP_THRESHOLD = 16384;
const MEDIUM_CONTEXT_READ_LOOP_THRESHOLD = 65536;
const SMALL_CONTEXT_MAX_CROSS_READS = 3;
const MEDIUM_CONTEXT_MAX_CROSS_READS = 4;
const LARGE_CONTEXT_MAX_CROSS_READS = 5;
const BLOCKED_READS_BEFORE_RECOVERY_RESET = 2;

function hasPendingApprovedPlanSourceMutation(callbacks: OrchestratorCallbacks): boolean {
  if (!callbacks.getIsPlanApproved()) return false;
  const tasks = callbacks.getPlanTasks();
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  const audit = buildPlanTaskEvidenceAudit({
    tasks,
    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
    preserveMissing: true,
    highlightNext: true,
  });
  const evidenceLedger = callbacks.getPlanExecutionEvidenceLedger();
  return audit.remainingTasks.some((task) =>
    planTaskHasUnsatisfiedSourceMutationEvidence(task, evidenceLedger)
  );
}

function isExecuteMutationRecoveryEligible(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
}): boolean {
  if (!isMutationRuntimeIntent(input.runtimeIntent)) return false;
  if (input.workflowMode === "edit") return true;
  return input.workflowMode === "plan" &&
    hasPendingApprovedPlanSourceMutation(input.callbacks);
}

function resolveCrossIterationReadThreshold(contextLimit?: number): number {
  const effectiveContextLimit = contextLimit ?? DEFAULT_CROSS_ITERATION_READ_CONTEXT_LIMIT;
  if (effectiveContextLimit <= SMALL_CONTEXT_READ_LOOP_THRESHOLD) return SMALL_CONTEXT_MAX_CROSS_READS;
  if (effectiveContextLimit <= MEDIUM_CONTEXT_READ_LOOP_THRESHOLD) return MEDIUM_CONTEXT_MAX_CROSS_READS;
  return LARGE_CONTEXT_MAX_CROSS_READS;
}

export interface NoProgressTrackingState {
  lastNoProgressBatchSignature: string;
  noProgressBatchRepeatCount: number;
  consecutiveReadFileOnlyCacheHits: number;
  lastReadFileOnlyObservationSignature: string;
}

function buildReadFileOnlyObservationBatchSignature(results: ToolExecutionResult[]): string {
  if (!isReadFileOnlyPattern(results)) return "";
  return results
    .map((result) => result.readFileObservation?.key || buildNoProgressBatchSignature([result]))
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

export interface ApprovedPlanNoProgressDecision {
  action: "recover" | "pause";
  reason: string;
  remainingText: string;
  repeats: number;
  logContext: Record<string, unknown>;
}

export interface DirectMutationPreflightRecoveryDecision {
  mode: "patch_recovery_read";
  reason: "mutation_preflight_invalid_patch" | "mutation_preflight_search_text_mismatch";
  target: string;
}

export function resolveDirectMutationPreflightRecovery(input: {
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  isPlanApproved: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryAttempts: number;
  results: ToolExecutionResult[];
}): DirectMutationPreflightRecoveryDecision | null {
  const eligibleWorkflow =
    input.workflowMode === "edit" ||
    (input.workflowMode === "plan" && input.isPlanApproved);
  if (
    !eligibleWorkflow ||
    !isMutationRuntimeIntent(input.runtimeIntent) ||
    input.executeRecoveryMode !== "normal" ||
    input.executeRecoveryAttempts >= 2
  ) {
    return null;
  }

  for (const result of input.results) {
    const diagnostic = [
      result.content,
      result.displayContent,
      result.qualityGateReason,
      result.lifecycleState,
    ].filter(Boolean).join("\n");
    if (!isExecutePatchMismatchRecoveryActivity({
      name: result.name,
      status: result.isError ? "failed" : "succeeded",
      target: result.target,
      detail: diagnostic,
    })) {
      continue;
    }
    const reason = /invalid_patch|invalid patch|无效|无法应用/i.test(diagnostic)
      ? "mutation_preflight_invalid_patch"
      : "mutation_preflight_search_text_mismatch";
    return {
      mode: "patch_recovery_read",
      reason,
      target: String(result.target || "").trim(),
    };
  }
  return null;
}

export type NoProgressRecoveryResult =
  | {
      status: "none";
      tracking: NoProgressTrackingState;
      noProgressBatchSignature: string;
      pendingExecuteRecoveryPrompt: string | null;
      pendingExecuteNoProgressPause: PendingExecuteNoProgressPause | null;
      approvedPlanNoProgressDecision: ApprovedPlanNoProgressDecision | null;
    }
  | {
      status: "continue";
      tracking: NoProgressTrackingState;
      noProgressBatchSignature: string;
      pendingExecuteRecoveryPrompt: string | null;
      pendingExecuteNoProgressPause: PendingExecuteNoProgressPause | null;
      approvedPlanNoProgressDecision: ApprovedPlanNoProgressDecision | null;
    }
  | {
      status: "stopped";
      tracking: NoProgressTrackingState;
      noProgressBatchSignature: string;
      pendingExecuteRecoveryPrompt: string | null;
      pendingExecuteNoProgressPause: PendingExecuteNoProgressPause | null;
      approvedPlanNoProgressDecision: ApprovedPlanNoProgressDecision | null;
    };

export function handleNoProgressRecovery(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
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
  repairExecutionRequestInChat: boolean;
  latestUserPromptText: string;
  isUnapprovedPlanReadOnlyBatch: boolean;
  planReadOnlyConvergenceBatches: number;
  planReadOnlyConvergenceTools: number;
  remainingTaskText?: string | null;
  approvedPlanNoProgressRecoveryAttempts: number;
  tracking: NoProgressTrackingState;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => void;
  activateChatFinalSynthesis: (reason: string, context?: Record<string, unknown>) => void;
  emitTaskOrchestratorPhase: (phase: "EXECUTE_RECOVERY" | "PAUSED", details?: Record<string, unknown>) => void;
}): NoProgressRecoveryResult {
  const {
    callbacks,
    activeProfile,
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
    repairExecutionRequestInChat,
    latestUserPromptText,
    isUnapprovedPlanReadOnlyBatch,
    planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools,
    remainingTaskText,
    approvedPlanNoProgressRecoveryAttempts,
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
  };

  let pendingExecuteRecoveryPrompt: string | null = null;
  let pendingExecuteNoProgressPause: PendingExecuteNoProgressPause | null = null;
  let approvedPlanNoProgressDecision: ApprovedPlanNoProgressDecision | null = null;
  let currentExecuteRecoveryMode = executeRecoveryMode;
  let currentExecuteRecoveryReason = executeRecoveryReason;
  let currentExecuteRecoveryAttempts = executeRecoveryAttempts;
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
    activateExecuteRecovery(mode, reason, context);
  };

  const directMutationPreflightRecovery = resolveDirectMutationPreflightRecovery({
    workflowMode,
    runtimeIntent,
    isPlanApproved: callbacks.getIsPlanApproved(),
    executeRecoveryMode: currentExecuteRecoveryMode,
    executeRecoveryAttempts: currentExecuteRecoveryAttempts,
    results,
  });
  if (directMutationPreflightRecovery) {
    const repeatedTargets = directMutationPreflightRecovery.target
      ? [directMutationPreflightRecovery.target]
      : summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    activateTrackedExecuteRecovery(
      directMutationPreflightRecovery.mode,
      directMutationPreflightRecovery.reason,
      {
        target: directMutationPreflightRecovery.target || null,
        repeatedTargets,
      },
    );
    pendingExecuteRecoveryPrompt = buildExecuteRecoveryPrompt({
      language: MODEL_CONTROL_LANGUAGE,
      reason: directMutationPreflightRecovery.reason,
      mode: directMutationPreflightRecovery.mode,
      repeatedTargets,
      recentActivity: recentToolActivity,
      allowFileRead: true,
    });
  }

  const isReadFileOnlyLoop = consecutiveReadFileOnlyCacheHits >= MAX_CONSECUTIVE_READ_ONLY_ITERATIONS;
  if (isReadFileOnlyLoop && currentExecuteRecoveryMode === "normal" && executeMutationRecoveryEligible) {
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    activateTrackedExecuteRecovery("mutation_first", "read_file_only_loop", {
      repeatedTargets,
    });
    pendingExecuteRecoveryPrompt = buildExecuteRecoveryPrompt({
      language: MODEL_CONTROL_LANGUAGE,
      reason: "read_file_only_loop",
      mode: "mutation_first",
      repeatedTargets,
      recentActivity: recentToolActivity,
      allowFileRead: false,
    });
  }

  const executeReadOnlyRecovery =
    executeMutationRecoveryEligible &&
    currentExecuteRecoveryMode === "normal"
      ? resolveExecuteReadOnlyRecoveryTrigger({
          results,
          recentActivity: recentToolActivity,
          readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
          sawExecuteOperationEvidence,
          noProgressBatchRepeatCount,
          minReadOnlyActivities: currentExecuteRecoveryMode === "normal"
            ? (activeProfile === "local" ? 10 : 8)
            : Infinity,
          minCachedReadOnlyActivities: currentExecuteRecoveryMode === "normal"
            ? (activeProfile === "local" ? 4 : 3)
            : Infinity,
          maxNoProgressReadOnlyRepeats: activeProfile === "local" ? 3 : 2,
          maxReadOnlyToolChars: activeProfile === "local" ? 100000 : 30000,
        })
      : { shouldRecover: false, reason: "", readOnlyActivityCount: 0, batchToolChars: 0 };
  if (executeReadOnlyRecovery.shouldRecover) {
    const language = callbacks.getPreferredLanguage();
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    if (currentExecuteRecoveryAttempts < 2) {
      // Read-only convergence already has context. Move to one mutation step;
      // the context-read phase is reserved for an actual patch mismatch.
      const nextMode: Exclude<ExecuteRecoveryMode, "normal"> = "mutation_first";
      activateTrackedExecuteRecovery(nextMode, executeReadOnlyRecovery.reason, {
        readOnlyActivityCount: executeReadOnlyRecovery.readOnlyActivityCount,
        batchToolChars: executeReadOnlyRecovery.batchToolChars,
        repeatedTargets,
      });
      pendingExecuteRecoveryPrompt = buildExecuteRecoveryPrompt({
        language: MODEL_CONTROL_LANGUAGE,
        reason: executeReadOnlyRecovery.reason,
        mode: nextMode,
        repeatedTargets,
        recentActivity: recentToolActivity,
        allowFileRead: shouldAllowExecuteRecoveryFileRead(recentToolActivity, nextMode),
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
          minReadOnlyActivities: activeProfile === "local" ? 24 : 16,
          minCachedReadOnlyActivities: activeProfile === "local" ? 10 : 6,
          maxNoProgressReadOnlyRepeats: activeProfile === "local" ? 5 : 3,
          maxReadOnlyToolChars: activeProfile === "local" ? 80000 : 48000,
        })
      : { shouldRecover: false, reason: "", readOnlyActivityCount: 0, batchToolChars: 0 };
  if (chatReadOnlyNoProgress.shouldRecover) {
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    const progressSignature = buildPlanProgressSignatureFromToolActivity(recentToolActivity) || noProgressBatchSignature;
    if (repairExecutionRequestInChat) {
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
        approvedPlanNoProgressDecision,
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
      approvedPlanNoProgressDecision,
    };
  }

  const approvedPlanCachedReadOnlyBatch =
    workflowMode === "plan" &&
    callbacks.getIsPlanApproved() &&
    isApprovedPlanCachedReadOnlyNoProgressBatch({
      results,
      readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
      sawExecutionEvidence: sawExecuteOperationEvidence,
    });
  if (approvedPlanCachedReadOnlyBatch) {
    const remainingText = remainingTaskText || (
      callbacks.getPreferredLanguage() === "zh"
        ? "当前已批准计划仍有任务缺少写入、命令或浏览器验证证据。"
        : "the approved plan still has tasks missing write, command, or browser validation evidence"
    );
    const recoveryInput = {
      reason: "no_progress_cached_read_only_batch",
      remainingText,
      logContext: {
        currentBatchTools: results.map((result) => result.name).slice(0, 8),
        currentBatchTargets: results.map((result) => result.target).filter(Boolean).slice(0, 8),
      },
    };
    approvedPlanNoProgressDecision = {
      ...recoveryInput,
      action: approvedPlanNoProgressRecoveryAttempts < MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS
        ? "recover"
        : "pause",
      repeats: Math.max(1, noProgressBatchRepeatCount),
    };
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
        approvedPlanNoProgressDecision,
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
        approvedPlanNoProgressDecision,
      };
    }
  }

  return {
    status: "none",
    tracking,
    noProgressBatchSignature,
    pendingExecuteRecoveryPrompt,
    pendingExecuteNoProgressPause,
    approvedPlanNoProgressDecision,
  };
}

export type ReadFileRepeatLimitRecoveryResult =
  | { status: "none" }
  | { status: "stopped" }
  | { status: "pending_prompt"; prompt: string };

export interface CrossIterationReadFileLoopRecoveryResult {
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryReason: string;
  consecutiveBlockedReadFileInRecoveryCount: number;
}

export function handleCrossIterationReadFileLoopRecovery(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  results: ToolExecutionResult[];
  snapshotContextLimit?: number;
  crossIterationFileReads: Map<string, CrossIterationFileReadObservation>;
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryReason: string;
  consecutiveBlockedReadFileInRecoveryCount: number;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => void;
}): CrossIterationReadFileLoopRecoveryResult {
  const {
    callbacks,
    runtimeIntent,
    iteration,
    results,
    snapshotContextLimit,
    crossIterationFileReads,
    activateExecuteRecovery,
  } = input;

  let executeRecoveryMode = input.executeRecoveryMode;
  let executeRecoveryReason = input.executeRecoveryReason;
  let consecutiveBlockedReadFileInRecoveryCount = input.consecutiveBlockedReadFileInRecoveryCount;
  if (!isExecuteMutationRecoveryEligible({
    callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent,
  })) {
    return {
      executeRecoveryMode,
      executeRecoveryReason,
      consecutiveBlockedReadFileInRecoveryCount,
    };
  }

  let matchingMutationProgressObserved = false;
  for (const result of results) {
    if (!isEditProgressResult(result) || !result.target) continue;
    for (const [key, observation] of [...crossIterationFileReads.entries()]) {
      if (!workspacePathsReferToSameFile(observation.path, result.target)) continue;
      crossIterationFileReads.delete(key);
      matchingMutationProgressObserved = true;
    }
  }
  // A successful command or an edit to another file does not change the
  // cached version/range of this read target. Keeping its streak prevents
  // read A -> pwd/edit B -> read A from evading loop recovery indefinitely.
  if (matchingMutationProgressObserved) consecutiveBlockedReadFileInRecoveryCount = 0;

  let blockedReadFileDetected = false;
  for (const result of results) {
    if (result.internalFeedback) continue;
    if (result.name !== "read_file") continue;
    const target = result.target;
    if (!target) continue;
    const readObservation = result.readFileObservation;

    if (!result.isError) {
      const noProgressRead = isReadOnlyNoProgressDetail(
        String(result.displayContent || result.content || ""),
      );
      if (!noProgressRead) {
        // A fresh read of a new range is legal and must not erase another
        // range's streak. A conservative command-cache invalidation can also
        // re-execute the same unchanged range; keeping that exact identity
        // prevents `read A -> pwd -> read A` from evading loop recovery.
        // Only a genuinely new file version retires older version streaks.
        if (readObservation) {
          for (const [key, observation] of [...crossIterationFileReads.entries()]) {
            if (!workspacePathsReferToSameFile(observation.path, readObservation.path)) continue;
            if (observation.versionToken !== readObservation.versionToken) {
              crossIterationFileReads.delete(key);
            }
          }
        }
        continue;
      }
      // Count only observations the cache has proved were already seen for
      // this file version/range. This detects loops without imposing a raw
      // limit on how often a large or newly changed file may be read.
      const observationKey = readObservation?.key || buildNoProgressBatchSignature([result]);
      if (!observationKey) continue;
      const previousObservation = crossIterationFileReads.get(observationKey);
      const count = (previousObservation?.count || 0) + 1;
      crossIterationFileReads.set(observationKey, {
        path: readObservation?.path || target,
        versionToken: readObservation?.versionToken || "legacy",
        count,
      });
      if (crossIterationFileReads.size > 240) {
        const oldestKey = crossIterationFileReads.keys().next().value;
        if (oldestKey) crossIterationFileReads.delete(oldestKey);
      }
      const crossReadThreshold = resolveCrossIterationReadThreshold(snapshotContextLimit);
      if (count >= crossReadThreshold && executeRecoveryMode === "normal") {
        const reason = "cross_iteration_file_read_loop";
        executeRecoveryMode = "mutation_first";
        executeRecoveryReason = reason;
        activateExecuteRecovery("mutation_first", reason, {
          target,
          crossIterationReads: count,
        });
        callbacks.appendMessage({
          role: "system",
          content: `[System: Cross-iteration observation-only read_file loop detected for ${target} (${count} reads without task progress; latest=${noProgressRead ? "cached/replayed" : "fresh observation"}). The reads remain valid evidence, but the pending mutation task has not advanced. Act now with a scoped write, validation, or an exact blocker. Do not output long prose.]`,
        });
        logAgentEvent("cross_iteration_file_read_loop", {
          iteration,
          target,
          crossIterationReads: count,
          latestReadKind: "cached_or_replayed",
        });
      }
      continue;
    }

    const repeatedTargetReadCount = [...crossIterationFileReads.values()]
      .filter((observation) => workspacePathsReferToSameFile(observation.path, target))
      .reduce((max, observation) => Math.max(max, observation.count), 0);
    if (executeRecoveryMode !== "normal" || repeatedTargetReadCount >= 2) {
      blockedReadFileDetected = true;
    }
  }

  if (blockedReadFileDetected) {
    consecutiveBlockedReadFileInRecoveryCount += 1;
    if (consecutiveBlockedReadFileInRecoveryCount >= BLOCKED_READS_BEFORE_RECOVERY_RESET) {
      executeRecoveryMode = "normal";
      consecutiveBlockedReadFileInRecoveryCount = 0;
      logAgentEvent("execute_recovery_reset_after_blocked_reads", {
        iteration,
        executeRecoveryMode,
      });
      callbacks.appendMessage({
        role: "system",
        content: callbacks.getPreferredLanguage() === "zh"
          ? "[System: 已解除文件读取恢复模式限制。请切至变动修改或运行验证命令，避免重复读取同一文件。]"
          : "[System: Read-only recovery restriction lifted. Avoid re-reading identical files; pivot to editing or validation.]",
      });
      return {
        executeRecoveryMode,
        executeRecoveryReason: "",
        consecutiveBlockedReadFileInRecoveryCount,
      };
    }

    const usedTools = results.map((result) => result.name).filter(Boolean).join(", ");
    const recoveryPrompt = "[System: read_file is not available in the current recovery mode. You have attempted to read multiple times and the tool has blocked this action. Immediately act with available tools: use replace_in_file, write_file, apply_patch to edit code, or execute_command to run validation. Do not attempt read_file again.]";
    callbacks.appendMessage({ role: "user", content: recoveryPrompt });
    logAgentEvent("blocked_read_file_recovery_prompt_injected", {
      iteration,
      usedTools,
      executeRecoveryMode,
    });
  } else {
    consecutiveBlockedReadFileInRecoveryCount = 0;
  }

  return {
    executeRecoveryMode,
    executeRecoveryReason,
    consecutiveBlockedReadFileInRecoveryCount,
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
  ) => void;
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
      isMutationRuntimeIntent(runtimeIntent) &&
      progressCheck.family === "edit" &&
      (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
      (outcome === "blocked" || outcome === "failed" || outcome === "no_change");
    const displayTarget = String(target || progressCheck.targetKey || "").replace(/^shell-write:/, "");
    const appendExecuteTargetRecoveryPrompt = (
      mode: Exclude<ExecuteRecoveryMode, "normal">,
      recoveryReason: string,
    ) => {
      activateExecuteRecovery(mode, recoveryReason, {
        target: displayTarget,
        outcome,
        reason,
      });
      callbacks.appendMessage({
        role: "user",
        content: buildExecuteRecoveryPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          reason: recoveryReason,
          mode,
          repeatedTargets: displayTarget ? [displayTarget] : summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
          recentActivity: recentToolActivity,
          allowFileRead: mode === "patch_recovery_read",
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
        appendExecuteTargetRecoveryPrompt("patch_recovery_read", "target_progress_patch_mismatch");
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

  const shouldConvergeExecuteTurn =
    workflowMode === "edit" ||
    (workflowMode === "plan" && callbacks.getIsPlanApproved() && runtimeIntent === "execute");
  const convergencePromptRatio =
    workflowMode === "plan" && callbacks.getIsPlanApproved()
      ? PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO
      : EXECUTE_CONVERGENCE_PROMPT_RATIO;

  if (
    !shouldConvergeExecuteTurn ||
    usedExecuteConvergencePrompt ||
    iteration < Math.max(8, Math.floor(effectiveMaxIterations * convergencePromptRatio))
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
    activateExecuteRecovery("mutation_first", "execute_convergence_prompt", {
      maxIterations: effectiveMaxIterations,
      recentToolActivity: recentToolActivity.length,
    });
  }
  callbacks.appendMessage({
    role: "user",
    content: buildExecuteConvergencePrompt(MODEL_CONTROL_LANGUAGE, iteration, effectiveMaxIterations),
  });

  return { usedExecuteConvergencePrompt: true };
}

export function handleReadFileRepeatLimitRecovery(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  results: ToolExecutionResult[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  executeRecoveryAttempts: number;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => void;
  emitTaskOrchestratorPhase: (phase: "EXECUTE_RECOVERY" | "PAUSED", details?: Record<string, unknown>) => void;
}): ReadFileRepeatLimitRecoveryResult {
  const {
    callbacks,
    workflowMode,
    runtimeIntent,
    iteration,
    results,
    recentPlanToolActivity,
    recentToolActivity,
    executeRecoveryAttempts,
    activateExecuteRecovery,
    emitTaskOrchestratorPhase,
  } = input;

  const approvedPlanReadFileRepeatLimit =
    workflowMode === "plan" &&
    callbacks.getIsPlanApproved() &&
    runtimeIntent === "execute" &&
    results.some(isReadFileRepeatLimitResult);
  if (approvedPlanReadFileRepeatLimit) {
    const language = callbacks.getPreferredLanguage();
    const repeatResults = results.filter(isReadFileRepeatLimitResult);
    const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity)
      .concat(repeatResults.map((result) => result.target).filter((target): target is string => Boolean(target)))
      .filter((target, index, all) => target && all.indexOf(target) === index)
      .slice(0, 4);
    const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
    if (executeRecoveryAttempts < MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS) {
      const recoveryReason = "approved_plan_read_file_repeat_limit";
      activateExecuteRecovery("mutation_first", recoveryReason, {
        repeatedTargets,
        repeatResults: repeatResults.length,
      });
      logAgentEvent("approved_plan_read_file_repeat_limit_recovery", {
        iteration,
        repeatedTargets,
        progressSignature: truncateForLog(progressSignature, 220),
        repeatResults: repeatResults.length,
        executeRecoveryAttempts,
        recoveryToolSurface: "action_only",
      });
      emitTaskOrchestratorPhase("EXECUTE_RECOVERY", {
        reason: recoveryReason,
        iteration,
        repeatedTargets,
        remainingTask: language === "zh"
          ? "禁止再次读取缓存目标；改为源码修改、命令/浏览器验证或明确阻塞。"
          : "do not reread cached targets; switch to source edits, command/browser validation, or a concrete blocker",
      });
      return {
        status: "pending_prompt",
        prompt: buildExecuteRecoveryPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          reason: recoveryReason,
          mode: "mutation_first",
          repeatedTargets,
          recentActivity: recentPlanToolActivity,
          allowFileRead: false,
        }),
      };
    }
    const notice = language === "zh"
      ? [
          "计划执行已暂停：模型再次请求了已被重复读取保护拦截的 read_file。",
          repeatedTargets.length ? `重复目标：${repeatedTargets.join("、")}` : "",
          "MAIN 已保留当前缓存文件内容和工具结果；继续时应复用这些上下文，改为精确 patch/replace、运行验证命令、浏览器验证，或说明真实阻塞。",
        ].filter(Boolean).join("\n")
      : [
          "Plan execution paused: the model asked for a read_file call that the repeat-read guard already blocked.",
          repeatedTargets.length ? `Repeated targets: ${repeatedTargets.join(", ")}` : "",
          "MAIN kept the cached file content and tool results; on resume, reuse that context and switch to a precise patch/replace, command validation, browser validation, or a concrete blocker.",
        ].filter(Boolean).join("\n");
    logAgentEvent("loop_stop", {
      reason: "approved_plan_read_file_repeat_limit",
      iteration,
      repeatedTargets,
      progressSignature: truncateForLog(progressSignature, 220),
      repeatResults: repeatResults.length,
    });
    emitTaskOrchestratorPhase("PAUSED", {
      reason: "approved_plan_read_file_repeat_limit",
      iteration,
      repeatedTargets,
      remainingTask: language === "zh"
        ? "复用已读文件上下文，改为源码修改、命令/浏览器验证或明确阻塞。"
        : "reuse cached file context and switch to source edits, command/browser validation, or a concrete blocker",
    });
    callbacks.onNonActionableStop(
      notice,
      "no_action",
      {
        progressSignature,
        repeatedTargets,
        recoveryReason: "approved_plan_read_file_repeat_limit",
        nextStep: language === "zh"
          ? "复用缓存内容，转向 patch/replace、验证或阻塞说明"
          : "reuse cached context and pivot to patch/replace, validation, or blocker",
      },
    );
    callbacks.onStatusChange("idle");
    return { status: "stopped" };
  }

  const readFileRepeatLimitBatch = workflowMode === "edit"
    ? summarizeReadFileRepeatLimitBatch(results)
    : null;
  if (!readFileRepeatLimitBatch) {
    return { status: "none" };
  }

  const language = callbacks.getPreferredLanguage();
  const repeatedTargets = [readFileRepeatLimitBatch.target].filter(Boolean);
  if (isMutationRuntimeIntent(runtimeIntent) && executeRecoveryAttempts < 2) {
    activateExecuteRecovery("mutation_first", "read_file_repeat_limit_batch", {
      target: readFileRepeatLimitBatch.target,
      total: readFileRepeatLimitBatch.total,
      targetCount: readFileRepeatLimitBatch.targetCount,
      repeatedTargets,
    });
    logAgentEvent("read_file_repeat_limit_recovery", {
      iteration,
      target: readFileRepeatLimitBatch.target,
      total: readFileRepeatLimitBatch.total,
      targetCount: readFileRepeatLimitBatch.targetCount,
      executeRecoveryAttempts,
    });
    emitTaskOrchestratorPhase("EXECUTE_RECOVERY", {
      reason: "read_file_repeat_limit_batch",
      iteration,
      repeatedTargets,
      remainingTask: language === "zh"
        ? "复用已读文件上下文，下一轮禁用重复读取并转向修改、命令/浏览器验证或明确阻塞。"
        : "reuse cached file context; next step disables repeated reads and pivots to patching, command/browser validation, or a blocker",
    });
    return {
      status: "pending_prompt",
      prompt: buildExecuteRecoveryPrompt({
        language: MODEL_CONTROL_LANGUAGE,
        reason: "read_file_repeat_limit_batch",
        mode: "mutation_first",
        repeatedTargets,
        recentActivity: recentToolActivity,
      }),
    };
  }

  const pauseNotice = buildReadFileRepeatLimitBatchPauseNotice({
    language,
    target: readFileRepeatLimitBatch.target,
    total: readFileRepeatLimitBatch.total,
    targetCount: readFileRepeatLimitBatch.targetCount,
  });
  logAgentEvent("loop_stop", {
    reason: "read_file_repeat_limit_batch",
    iteration,
    target: readFileRepeatLimitBatch.target,
    total: readFileRepeatLimitBatch.total,
    targetCount: readFileRepeatLimitBatch.targetCount,
  });
  emitTaskOrchestratorPhase("PAUSED", {
    reason: "read_file_repeat_limit_batch",
    iteration,
    repeatedTargets,
    remainingTask: language === "zh"
      ? "复用已读文件上下文，改为修改、验证或说明阻塞。"
      : "reuse cached file context and switch to patching, validation, or a blocker",
  });
  callbacks.onNonActionableStop(
    pauseNotice,
    "no_action",
    {
      repeatedTargets,
      recoveryReason: "read_file_repeat_limit_batch",
      nextStep: language === "zh"
        ? "复用缓存内容，转向 patch/验证/阻塞说明"
        : "reuse cached context and pivot to patch/validation/blocker",
    },
  );
  callbacks.onStatusChange("idle");
  return { status: "stopped" };
}

export type RepeatedEditValidationRecoveryResult =
  | {
      status: "none";
      repeatedEditValidationRecoveryAttempts: number;
    }
  | {
      status: "pending_prompt";
      prompt: string;
      repeatedEditValidationRecoveryAttempts: number;
    }
  | {
      status: "stopped";
      repeatedEditValidationRecoveryAttempts: number;
    };

function normalizeLoopGuardTarget(target: string): string {
  return String(target || "")
    .replace(/^shell-write:/, "")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function handleRepeatedEditValidationRecovery(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  results: ToolExecutionResult[];
  availableToolNames: Set<string>;
  recentToolActivity: PlanToolActivitySummary[];
  successfulEditTargetsSinceVerification: Map<string, number>;
  repeatedEditValidationRecoveryAttempts: number;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => void;
  emitPlanExecutionProgress: (phase: "running", update?: Record<string, unknown>) => void;
}): RepeatedEditValidationRecoveryResult {
  const {
    callbacks,
    workflowMode,
    runtimeIntent,
    iteration,
    results,
    availableToolNames,
    recentToolActivity,
    successfulEditTargetsSinceVerification,
    activateExecuteRecovery,
    emitPlanExecutionProgress,
  } = input;
  let repeatedEditValidationRecoveryAttempts = input.repeatedEditValidationRecoveryAttempts;

  if (results.some(isVerificationEvidenceResult)) {
    successfulEditTargetsSinceVerification.clear();
    repeatedEditValidationRecoveryAttempts = 0;
  }

  for (const result of results) {
    if (result.isError || result.internalFeedback || !isEditProgressResult(result)) continue;
    const targetKey = normalizeLoopGuardTarget(result.target);
    if (!targetKey) continue;

    // Editing a different file resets older edit counters, so cross-file
    // refactors can still alternate targets without tripping this guard.
    for (const key of Array.from(successfulEditTargetsSinceVerification.keys())) {
      if (key !== targetKey) {
        successfulEditTargetsSinceVerification.delete(key);
      }
    }

    const count = (successfulEditTargetsSinceVerification.get(targetKey) || 0) + 1;
    successfulEditTargetsSinceVerification.set(targetKey, count);
    // Three successful writes to the same target without validation is enough
    // to detect a stale-edit loop. Waiting for five allowed local models to
    // repeatedly damage syntax before the runtime forced a compile/test step.
    if (count < 3) continue;

    const displayTarget = String(result.target || targetKey).replace(/^shell-write:/, "");
    const language = callbacks.getPreferredLanguage();
    const availableValidationTools = Array.from(availableToolNames)
      .filter((name) => EXECUTION_VERIFICATION_TOOL_NAMES.has(name))
      .filter((name) => name !== "send_pty_input" && name !== "clear_pty_buffer");
    const canAttemptValidationRecovery =
      isMutationRuntimeIntent(runtimeIntent) &&
      (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
      repeatedEditValidationRecoveryAttempts < 1 &&
      availableValidationTools.length > 0;
    if (canAttemptValidationRecovery) {
      repeatedEditValidationRecoveryAttempts += 1;
      activateExecuteRecovery("validation_only", "repeat_edit_target_without_validation", {
        target: displayTarget,
        editCount: count,
        validationTools: availableValidationTools,
      });
      logAgentEvent("repeat_edit_target_validation_recovery", {
        iteration,
        target: displayTarget,
        editCount: count,
        attempts: repeatedEditValidationRecoveryAttempts,
        validationTools: availableValidationTools,
      });
      emitPlanExecutionProgress("running", {
        repeatedTargets: [displayTarget],
        recoveryReason: "repeat_edit_target_without_validation",
        nextStep: language === "zh"
          ? "同一目标已连续修改；下一轮强制先运行命令或浏览器验证"
          : "same target was edited repeatedly; next turn must run command or browser validation first",
      });
      callbacks.onStatusChange("running");
      return {
        status: "pending_prompt",
        repeatedEditValidationRecoveryAttempts,
        prompt: buildExecuteValidationRecoveryPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          reason: "repeat_edit_target_without_validation",
          target: displayTarget,
          editCount: count,
          recentActivity: recentToolActivity,
          availableValidationTools,
        }),
      };
    }

    logAgentEvent("loop_stop", {
      reason: "repeat_edit_target_without_validation",
      iteration,
      target: displayTarget,
      editCount: count,
      validationRecoveryAttempts: repeatedEditValidationRecoveryAttempts,
      validationTools: availableValidationTools,
    });
    callbacks.onNonActionableStop(
      language === "zh"
        ? [
            "执行已暂停：同一回合连续修改同一目标，但期间没有新的验证证据。",
            `重复目标：${displayTarget}`,
            "继续前请先运行测试、命令或浏览器验证；如果无法验证，请说明真实阻塞并给出当前状态。",
          ].join("\n")
        : [
            "Execution paused: this turn kept editing the same target without fresh validation evidence.",
            `Repeated target: ${displayTarget}`,
            "Before continuing, run a test, command, or browser validation; if validation is blocked, state the blocker and current status.",
          ].join("\n"),
      "no_action",
      {
        repeatedTargets: [displayTarget],
        recoveryReason: "repeat_edit_target_without_validation",
        nextStep: language === "zh"
          ? "先验证当前目标，再决定继续修改、换目标或总结"
          : "validate this target before editing it again, switching targets, or summarizing",
      },
    );
    callbacks.onStatusChange("idle");
    return {
      status: "stopped",
      repeatedEditValidationRecoveryAttempts,
    };
  }

  return {
    status: "none",
    repeatedEditValidationRecoveryAttempts,
  };
}

export type StrictRepeatGuardRecoveryResult =
  | { status: "none" }
  | { status: "continue" }
  | { status: "stopped" };

export function handleStrictRepeatGuardRecovery(input: {
  callbacks: OrchestratorCallbacks;
  workspace: string;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  effectiveToolCalls: ToolCallToExecute[];
  recentToolCalls: Array<{ name: string; argsKey: string }>;
  repeatGuardRecoveredSignatures: Set<string>;
  failedToolCallCounts: Map<string, number>;
  recentPlanToolActivity: PlanToolActivitySummary[];
  availableToolNames: Set<string>;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  toolPermissionPolicy: ToolPermissionPolicy;
  emitTurnFailedEvent: (message: string) => void;
}): StrictRepeatGuardRecoveryResult {
  const {
    callbacks,
    workspace,
    workflowMode,
    runtimeIntent,
    iteration,
    effectiveToolCalls,
    recentToolCalls,
    repeatGuardRecoveredSignatures,
    failedToolCallCounts,
    recentPlanToolActivity,
    availableToolNames,
    toolCapabilityRegistry,
    toolPermissionPolicy,
    emitTurnFailedEvent,
  } = input;

  for (const toolCall of effectiveToolCalls) {
    const toolArgs = parseToolCallArguments(toolCall, workspace);
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

    const target = getToolTarget(toolCall.name, toolArgs);
    if (repeatGuardReadOnly && (readOnlyShellInspection || !repeatGuardRecoveredSignatures.has(repeatCheck.signature))) {
      const recoveryMessage = formatRepeatLoopRecoveryMessage(
        toolCall.name,
        target,
        repeatCheck.threshold,
        availableToolNames,
      );
      repeatGuardRecoveredSignatures.add(repeatCheck.signature);
      if (readOnlyShellInspection) {
        failedToolCallCounts.set(repeatCheck.signature, 3);
      }
      recentToolCalls.length = 0;
      callbacks.onToolError(toolCall.name, target, recoveryMessage, { toolCallId: toolCall.id });
      callbacks.appendMessage({
        role: "system",
        content: `[System: ${recoveryMessage}]`,
      });
      return { status: "continue" };
    }

    if (workflowMode === "plan" && callbacks.getIsPlanApproved() && toolCall.name === "browser_evaluate") {
      const recoveryMessage = formatRepeatLoopRecoveryMessage(
        toolCall.name,
        target,
        repeatCheck.threshold,
        availableToolNames,
      );
      if (!repeatGuardRecoveredSignatures.has(repeatCheck.signature)) {
        repeatGuardRecoveredSignatures.add(repeatCheck.signature);
        recentToolCalls.length = 0;
        callbacks.onToolError(toolCall.name, target, recoveryMessage, { toolCallId: toolCall.id });
        callbacks.appendMessage({
          role: "system",
          content: `[System: ${recoveryMessage}]`,
        });
        return { status: "continue" };
      }

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
    const recentEvidence = callbacks.getPlanExecutionEvidenceLedger().slice(-5);
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
    callbacks.onError(`${fatalMessage}\n${structuredRecovery}${recoveryHint}`);
    callbacks.onStatusChange("error");
    emitTurnFailedEvent(fatalMessage);
    return { status: "stopped" };
  }

  return { status: "none" };
}
