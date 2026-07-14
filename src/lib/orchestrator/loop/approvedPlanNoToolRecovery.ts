import {
  buildPlanExecutionNoToolRecoveryPrompt,
} from "../../planExecutionNoTool";
import {
  isCachedReadOnlyPlanActivity,
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import {
  describeApprovedPlanRecoveryToolSurface,
} from "../../approvedPlanRecoveryTools";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  buildApprovedPlanValidationPendingMessage,
  buildBrowserValidationContinuationPrompt,
  buildPlanCommandExecutionHint,
  formatPlanAuditRemainingTasks,
  logAgentEvent,
  MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS,
  MAX_NO_ACTION_RETRIES,
  resolveApprovedPlanValidationBoundary,
} from "../../orchestrator";
import {
  hasBrowserValidationCapability,
  type PlanExecutionProgressPhase,
  type PlanExecutionProgressUpdate,
  type PlanTaskEvidenceAudit,
} from "../../workflowModels";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import type { OrchestratorCallbacks } from "../types";
import {
  continueApprovedPlanWithStrategySwitch,
  pauseApprovedPlanNoProgressLoop,
} from "./approvedPlanRecoveryActions";

type EmitPlanExecutionProgress = (
  phase: PlanExecutionProgressPhase,
  overrides?: Partial<PlanExecutionProgressUpdate>,
) => void;

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

export type ApprovedPlanNoToolRecoveryResult = {
  status: "none" | "continue" | "stopped";
  consecutiveNoToolCount: number;
  approvedPlanNoProgressRecoveryAttempts: number;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  approvedPlanLongReasoningNoActionCount: number;
};

export function resolveApprovedPlanNoToolCheckpointLimit(activeProfile: string): number {
  return activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES;
}

export function handleApprovedPlanNoToolRecovery(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: string;
  planStage: string;
  isApprovedPlanExecutionTurn: boolean;
  effectiveToolCallCount: number;
  shouldSuppressApprovedPlanNoToolText: boolean;
  approvedPlanAuditForNoTool: PlanTaskEvidenceAudit | null;
  rejectedCompletionClaim: boolean;
  availableToolNames: Set<string>;
  wasTruncated: boolean;
  sawExecuteOperationEvidence: boolean;
  normalized: {
    finishReason?: string | null;
    hiddenThought: string;
    visibleText: string;
    toolCalls: unknown[];
  };
  finalReplyOptionsCount: number;
  streamText: string;
  iterationRequestStartedAt: number;
  recentPlanToolActivity: PlanToolActivitySummary[];
  consecutiveNoToolCount: number;
  approvedPlanNoProgressRecoveryAttempts: number;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  approvedPlanLongReasoningNoActionCount: number;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
}): ApprovedPlanNoToolRecoveryResult {
  const {
    callbacks,
    activeProfile,
    iteration,
    workflowMode,
    runtimeIntent,
    planStage,
    approvedPlanAuditForNoTool,
    rejectedCompletionClaim,
    availableToolNames,
    wasTruncated,
    sawExecuteOperationEvidence,
    normalized,
    finalReplyOptionsCount,
    streamText,
    iterationRequestStartedAt,
    recentPlanToolActivity,
    emitTaskOrchestratorPhase,
    emitPlanExecutionProgress,
  } = input;

  let consecutiveNoToolCount = input.consecutiveNoToolCount;
  let approvedPlanNoProgressRecoveryAttempts = input.approvedPlanNoProgressRecoveryAttempts;
  let approvedPlanActionOnlyRecoveryActive = input.approvedPlanActionOnlyRecoveryActive;
  let approvedPlanNoToolRecoveryFileReadActive = input.approvedPlanNoToolRecoveryFileReadActive;
  let approvedPlanLongReasoningNoActionCount = input.approvedPlanLongReasoningNoActionCount;

  const finish = (status: ApprovedPlanNoToolRecoveryResult["status"]): ApprovedPlanNoToolRecoveryResult => ({
    status,
    consecutiveNoToolCount,
    approvedPlanNoProgressRecoveryAttempts,
    approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive,
    approvedPlanLongReasoningNoActionCount,
  });

  if (
    !input.isApprovedPlanExecutionTurn ||
    input.effectiveToolCallCount > 0 ||
    !input.shouldSuppressApprovedPlanNoToolText
  ) {
    return finish("none");
  }

  callbacks.onStatusChange("running");
  consecutiveNoToolCount += 1;
  const language = callbacks.getPreferredLanguage();
  const approvedPlanTasks = approvedPlanAuditForNoTool?.tasks || callbacks.getPlanTasks();
  const approvedPlanMissingTasks = (approvedPlanAuditForNoTool?.totalCount || 0) === 0;
  const remainingText = approvedPlanAuditForNoTool
    ? formatPlanAuditRemainingTasks(
        approvedPlanAuditForNoTool,
        language,
        language === "zh"
          ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
          : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.",
      )
    : language === "zh"
    ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
    : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.";
  const validationBoundary = resolveApprovedPlanValidationBoundary({
    audit: approvedPlanAuditForNoTool,
    availableToolNames,
  });
  const browserValidationAvailable = hasBrowserValidationCapability(availableToolNames);
  const truncatedAfterCachedReadOnly =
    wasTruncated &&
    !sawExecuteOperationEvidence &&
    recentPlanToolActivity.slice(-4).some(isCachedReadOnlyPlanActivity);
  const approvedPlanLengthNoAction =
    wasTruncated &&
    normalized.toolCalls.length === 0 &&
    finalReplyOptionsCount === 0;
  const recentActivitySummary = recentPlanToolActivity
    .slice(-4)
    .map((item) => [item.status, item.name, item.target, item.detail].filter(Boolean).join(" "))
    .join(language === "zh" ? "；" : "; ");

  if (validationBoundary === "pause_external_validation" && approvedPlanAuditForNoTool) {
    logAgentEvent("plan_execution_validation_boundary", {
      iteration,
      reason: "external_validation_unavailable",
      auditCompleted: approvedPlanAuditForNoTool.completedCount,
      auditTotal: approvedPlanAuditForNoTool.totalCount,
      remaining: approvedPlanAuditForNoTool.remainingTasks.length,
      pendingUserValidation: approvedPlanAuditForNoTool.pendingUserValidationTasks.length,
      browserValidationAvailable,
    });
    emitPlanExecutionProgress("paused", {
      currentTask: language === "zh" ? "待用户验证" : "pending user validation",
      nextStep: language === "zh"
        ? "自动验证能力不足，等待用户完成浏览器/Tauri/人工确认"
        : "automation boundary reached; wait for browser/Tauri/user confirmation",
    });
    callbacks.onNonActionableStop(
      buildApprovedPlanValidationPendingMessage({
        language,
        audit: approvedPlanAuditForNoTool,
        browserValidationAvailable,
      }),
      "incomplete_plan",
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  }

  if (approvedPlanLengthNoAction) {
    approvedPlanLongReasoningNoActionCount += 1;
    const recoveryInput = {
      callbacks,
      iteration,
      recentPlanToolActivity,
      emitTaskOrchestratorPhase,
      emitPlanExecutionProgress,
      reason: "approved_plan_reasoning_length_no_action",
      remainingText,
      logContext: {
        finishReason: normalized.finishReason || "unknown",
        hiddenThoughtChars: normalized.hiddenThought.length,
        visibleChars: normalized.visibleText.length,
        contentChars: streamText.length,
        streamElapsedMs: Date.now() - iterationRequestStartedAt,
        longReasoningNoActionCount: approvedPlanLongReasoningNoActionCount,
      },
    };
    logAgentEvent("long_reasoning_no_action", {
      iteration,
      workflowMode,
      runtimeIntent,
      planStage,
      isPlanApproved: callbacks.getIsPlanApproved(),
      count: approvedPlanLongReasoningNoActionCount,
      finishReason: normalized.finishReason || "unknown",
      hiddenThoughtChars: normalized.hiddenThought.length,
      visibleChars: normalized.visibleText.length,
      contentChars: streamText.length,
      streamElapsedMs: Date.now() - iterationRequestStartedAt,
      approvedPlanNoProgressRecoveryAttempts,
      remainingTasks: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
      repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity),
    });
    if (
      approvedPlanLongReasoningNoActionCount === 1 &&
      approvedPlanNoProgressRecoveryAttempts < MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS
    ) {
      const result = continueApprovedPlanWithStrategySwitch({
        ...recoveryInput,
        approvedPlanNoProgressRecoveryAttempts,
      });
      approvedPlanNoProgressRecoveryAttempts = result.approvedPlanNoProgressRecoveryAttempts;
      approvedPlanActionOnlyRecoveryActive = result.approvedPlanActionOnlyRecoveryActive;
      return finish("continue");
    }
    pauseApprovedPlanNoProgressLoop({
      ...recoveryInput,
      repeats: Math.max(1, approvedPlanLongReasoningNoActionCount),
    });
    return finish("stopped");
  }

  if (truncatedAfterCachedReadOnly) {
    const recoveryInput = {
      callbacks,
      iteration,
      recentPlanToolActivity,
      emitTaskOrchestratorPhase,
      emitPlanExecutionProgress,
      reason: "no_progress_cached_read_only_length",
      remainingText,
      logContext: {
        finishReason: normalized.finishReason || "unknown",
        hiddenThoughtChars: normalized.hiddenThought.length,
        visibleChars: normalized.visibleText.length,
      },
    };
    if (approvedPlanNoProgressRecoveryAttempts < MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS) {
      const result = continueApprovedPlanWithStrategySwitch({
        ...recoveryInput,
        approvedPlanNoProgressRecoveryAttempts,
      });
      approvedPlanNoProgressRecoveryAttempts = result.approvedPlanNoProgressRecoveryAttempts;
      approvedPlanActionOnlyRecoveryActive = result.approvedPlanActionOnlyRecoveryActive;
      return finish("continue");
    }
    pauseApprovedPlanNoProgressLoop({
      ...recoveryInput,
      repeats: Math.max(1, consecutiveNoToolCount),
    });
    return finish("stopped");
  }

  logAgentEvent("plan_execution_no_tool_reprompt", {
    iteration,
    consecutiveNoToolCount,
    visibleChars: normalized.visibleText.length,
    completionClaimRejected: rejectedCompletionClaim,
    missingTasksArtifact: approvedPlanMissingTasks,
    auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
    auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
    remaining: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
    pendingUserValidation: approvedPlanAuditForNoTool?.pendingUserValidationTasks.length ?? 0,
    pendingExternalValidation: approvedPlanAuditForNoTool?.pendingExternalValidation ?? false,
    route: "approved_plan_execution_no_tool",
  });
  approvedPlanActionOnlyRecoveryActive = true;
  approvedPlanNoToolRecoveryFileReadActive = true;
  logAgentEvent("approved_plan_no_tool_recovery_tool_surface", {
    iteration,
    allowFileRead: true,
    recoveryToolSurface: describeApprovedPlanRecoveryToolSurface(true),
    availableTools: Array.from(availableToolNames).slice(0, 24),
  });

  if (consecutiveNoToolCount >= resolveApprovedPlanNoToolCheckpointLimit(activeProfile)) {
    logAgentEvent("plan_execution_no_tool_checkpoint_recovery", {
      iteration,
      consecutiveNoToolCount,
      completionClaimRejected: rejectedCompletionClaim,
      auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
      auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
      approvedPlanNoProgressRecoveryAttempts,
    });
    const result = continueApprovedPlanWithStrategySwitch({
      callbacks,
      iteration,
      recentPlanToolActivity,
      approvedPlanNoProgressRecoveryAttempts,
      emitTaskOrchestratorPhase,
      emitPlanExecutionProgress,
      reason: "plan_execution_no_tool_checkpoint_recovery",
      remainingText,
      logContext: {
        completionClaimRejected: rejectedCompletionClaim,
        auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
        auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
        recentActivitySummary,
      },
    });
    consecutiveNoToolCount = 0;
    approvedPlanNoProgressRecoveryAttempts = result.approvedPlanNoProgressRecoveryAttempts;
    approvedPlanActionOnlyRecoveryActive = result.approvedPlanActionOnlyRecoveryActive;
    return finish("continue");
  }

  callbacks.appendMessage({
    role: "user",
    content: validationBoundary === "browser_prompt"
      ? buildBrowserValidationContinuationPrompt({ language: MODEL_CONTROL_LANGUAGE, remainingText })
      : buildPlanExecutionNoToolRecoveryPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          missingTasksArtifact: approvedPlanMissingTasks,
          remainingText,
          commandHint: buildPlanCommandExecutionHint(approvedPlanTasks, MODEL_CONTROL_LANGUAGE),
          recentActivitySummary,
          rejectedCompletionClaim,
        }),
  });
  return finish("continue");
}
