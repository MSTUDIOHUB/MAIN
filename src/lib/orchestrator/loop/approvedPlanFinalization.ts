import {
  buildPlanTaskEvidenceAudit,
  hasBrowserValidationCapability,
  type PlanExecutionProgressPhase,
  type PlanExecutionProgressUpdate,
  type PlanTask,
  type PlanTaskEvidenceAudit,
} from "../../workflowModels";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import {
  buildApprovedPlanContinuationPrompt,
  buildApprovedPlanNoToolPauseMessage,
  buildApprovedPlanValidationPendingMessage,
  buildBrowserValidationContinuationPrompt,
  buildPlanCommandExecutionHint,
  formatPlanAuditRemainingTasks,
  logAgentEvent,
  resolveApprovedPlanValidationBoundary,
} from "../../orchestrator";
import type { OrchestratorCallbacks } from "../types";
import { resolveExecuteNoToolCheckpointLimit } from "./executeNoToolRecovery";

export type ApprovedPlanFinalizationResult = {
  status: "none" | "continue" | "stopped";
  consecutiveNoToolCount: number;
};

export function buildApprovedPlanEvidenceCompletionMessage(input: {
  language: "zh" | "en";
  completedCount: number;
  totalCount: number;
}): string {
  if (input.language === "en") {
    return `Completed the approved Plan (${input.completedCount}/${input.totalCount}). MAIN verified the planned mutations and validation evidence for every task; no additional model-authored completion claim was required.`;
  }
  return `已按批准的 Plan 完成全部任务（${input.completedCount}/${input.totalCount}）。MAIN 已逐项核验计划要求的修改和验证证据，无需再依赖模型额外声明完成。`;
}

function buildApprovedPlanContinuationForRemainingTasks(input: {
  callbacks: OrchestratorCallbacks;
  audit: PlanTaskEvidenceAudit | null;
  approvedPlanTasks: PlanTask[];
  approvedPlanMissingTasks: boolean;
  rejectedCompletionClaim: boolean;
  availableToolNames: Set<string>;
}): string {
  const {
    callbacks,
    audit,
    approvedPlanTasks,
    approvedPlanMissingTasks,
    rejectedCompletionClaim,
    availableToolNames,
  } = input;
  const language = callbacks.getPreferredLanguage();
  const remainingText = audit
    ? formatPlanAuditRemainingTasks(
        audit,
        language,
        language === "zh"
          ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
          : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.",
      )
    : language === "zh"
    ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
    : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.";
  const validationBoundary = resolveApprovedPlanValidationBoundary({
    audit,
    availableToolNames,
  });

  if (validationBoundary === "browser_prompt") {
    return buildBrowserValidationContinuationPrompt({ language, remainingText });
  }

  const prefix = approvedPlanMissingTasks
    ? `${buildApprovedPlanContinuationPrompt(callbacks)}\n\n`
    : language === "zh"
    ? `${rejectedCompletionClaim ? "你刚才的完成声明没有通过可信证据审计；不要再输出完成总结，先继续真实执行。\n" : ""}继续执行当前任务清单中证据未满足的任务。不要重复计划说明，直接根据当前进度继续实现下一个任务；如果需要修改文件，继续使用工具调用。只有同一文件版本、同一读取范围仍在当前上下文且再次读取只返回 \`FILE_UNCHANGED_STUB\` 时，才应停止该无进展重复并转向写入/替换、其他必要范围、验证或精确阻塞；文件修改后、上下文已淘汰或读取不同范围时可以重新读取。凡是任务里带有 shell 命令的，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr；长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查结果。完成当前任务后，必须先产生真实文件/命令/验证证据；如果 \`.MAIN/plans/tasks.md\` 已存在，再更新对应 checkbox 为 \`[x]\`。只有所有任务证据满足后才能结束。\n下一批优先任务：\n`
    : `${rejectedCompletionClaim ? "Your completion claim did not pass the trusted evidence audit; do not output a final summary yet, continue the real work first.\n" : ""}Continue executing tasks whose evidence is not satisfied in the current task list. Do not restate the plan; just move to the next task based on the current progress. Stop rereading only when the same range of the same unchanged file version is still in active context and another read returns \`FILE_UNCHANGED_STUB\`; a changed file, an evicted result, or a different required range may be read again. Otherwise patch/write, inspect another needed range, validate, or pause with the exact blocker. If a task includes shell commands, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. After each task, produce real file/command/verification evidence; if \`.MAIN/plans/tasks.md\` exists, update the matching checkbox to \`[x]\`. Only stop when every task has satisfied evidence.\nNext priority tasks:\n`;

  return `${prefix}${remainingText}\n\n${buildPlanCommandExecutionHint(approvedPlanTasks, language)}`;
}

export function handleApprovedPlanFinalization(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  approvedPlanAuditForNoTool: PlanTaskEvidenceAudit | null;
  rejectedCompletionClaim: boolean;
  availableToolNames: Set<string>;
  consecutiveNoToolCount: number;
  emitTaskOrchestratorPhase: (phase: TaskOrchestratorPhase, extra?: Record<string, unknown>) => void;
  emitPlanExecutionProgress: (
    phase: PlanExecutionProgressPhase,
    overrides?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
}): ApprovedPlanFinalizationResult {
  const {
    callbacks,
    activeProfile,
    iteration,
    workflowMode,
    approvedPlanAuditForNoTool,
    rejectedCompletionClaim,
    availableToolNames,
    emitTaskOrchestratorPhase,
    emitPlanExecutionProgress,
  } = input;
  let consecutiveNoToolCount = input.consecutiveNoToolCount;
  const finish = (status: ApprovedPlanFinalizationResult["status"]): ApprovedPlanFinalizationResult => ({
    status,
    consecutiveNoToolCount,
  });

  if (workflowMode !== "plan" || !callbacks.getIsPlanApproved()) {
    return finish("none");
  }

  const approvedPlanAudit = approvedPlanAuditForNoTool ||
    buildPlanTaskEvidenceAudit({
      tasks: callbacks.getPlanTasks(),
      evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
      highlightNext: true,
    });
  const approvedPlanTasks = approvedPlanAudit.tasks || [];
  const approvedPlanMissingTasks = (approvedPlanAudit.totalCount || 0) === 0;
  const hasRemainingApprovedPlanTasks =
    !!approvedPlanAudit &&
    (!approvedPlanAudit.allTrustedComplete || approvedPlanAudit.pendingExternalValidation);

  if (approvedPlanMissingTasks || hasRemainingApprovedPlanTasks) {
    callbacks.onStatusChange("running");
    consecutiveNoToolCount += 1;
    const language = callbacks.getPreferredLanguage();
    const remainingText = formatPlanAuditRemainingTasks(
      approvedPlanAudit,
      language,
      language === "zh"
        ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
        : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.",
    );
    const validationBoundary = resolveApprovedPlanValidationBoundary({
      audit: approvedPlanAudit,
      availableToolNames,
    });
    const browserValidationAvailable = hasBrowserValidationCapability(availableToolNames);
    if (validationBoundary === "pause_external_validation") {
      logAgentEvent("plan_execution_validation_boundary", {
        iteration,
        reason: "external_validation_unavailable",
        auditCompleted: approvedPlanAudit.completedCount,
        auditTotal: approvedPlanAudit.totalCount,
        remaining: approvedPlanAudit.remainingTasks.length,
        pendingUserValidation: approvedPlanAudit.pendingUserValidationTasks.length,
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
          audit: approvedPlanAudit,
          browserValidationAvailable,
        }),
        "incomplete_plan",
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }

    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      logAgentEvent("loop_stop", {
        reason: "remaining_plan_tasks_limit",
        iteration,
        consecutiveNoToolCount,
        completionClaimRejected: rejectedCompletionClaim,
        auditCompleted: approvedPlanAudit.completedCount,
        auditTotal: approvedPlanAudit.totalCount,
      });
      emitPlanExecutionProgress("paused", {
        nextStep: language === "zh"
          ? "点击 Resume Execution 后重新读取当前 workspace 状态并继续"
          : "click Resume Execution, reread current workspace state, and continue",
      });
      callbacks.onNonActionableStop(
        buildApprovedPlanNoToolPauseMessage(
          language,
          remainingText,
          consecutiveNoToolCount,
          approvedPlanAudit,
          rejectedCompletionClaim,
          Array.from(availableToolNames),
        ),
        "incomplete_plan",
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }

    callbacks.appendMessage({
      role: "user",
      content: buildApprovedPlanContinuationForRemainingTasks({
        callbacks,
        audit: approvedPlanAudit,
        approvedPlanTasks,
        approvedPlanMissingTasks,
        rejectedCompletionClaim,
        availableToolNames,
      }),
    });
    return finish("continue");
  }

  if (approvedPlanAudit.pendingUserValidationTasks.length > 0) {
    const language = callbacks.getPreferredLanguage();
    emitPlanExecutionProgress("paused", {
      currentTask: language === "zh" ? "待用户验证" : "pending user validation",
      nextStep: language === "zh"
        ? "自动部分已完成，等待用户完成剩余验证"
        : "automated work is complete; waiting for remaining user validation",
    });
    callbacks.onNonActionableStop(
      buildApprovedPlanValidationPendingMessage({
        language,
        audit: approvedPlanAudit,
        browserValidationAvailable: hasBrowserValidationCapability(availableToolNames),
      }),
      "incomplete_plan",
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  }

  const finalPlanAudit = buildPlanTaskEvidenceAudit({
    tasks: callbacks.getPlanTasks(),
    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
    highlightNext: true,
  });
  if (
    finalPlanAudit.totalCount === 0 ||
    !finalPlanAudit.allTrustedComplete ||
    finalPlanAudit.pendingExternalValidation
  ) {
    logAgentEvent("plan_completion_guard_reprompt", {
      iteration,
      completed: finalPlanAudit.completedCount,
      total: finalPlanAudit.totalCount,
      remaining: finalPlanAudit.remainingTasks.length,
      pendingExternalValidation: finalPlanAudit.pendingExternalValidation,
      pendingUserValidation: finalPlanAudit.pendingUserValidationTasks.length,
    });
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: callbacks.getPreferredLanguage() === "zh"
        ? [
            "MAIN 的完成闸门没有通过：当前已批准 Plan 不能仅凭模型正文或单次工具结果结束。",
            "请继续真实执行并产生文件/命令/验证证据；如果只剩浏览器/Tauri/用户验证且自动工具不可用，请暂停并说明待用户验证。",
          ].join("\n")
        : [
            "MAIN's completion gate did not pass: the approved Plan cannot end from assistant prose or a single tool result alone.",
            "Continue with real execution evidence from files, commands, or validation. If only browser/Tauri/user validation remains and automation is unavailable, pause and report pending user validation.",
          ].join("\n"),
    });
    return finish("continue");
  }

  emitTaskOrchestratorPhase("DONE", {
    reason: "plan_evidence_complete",
    iteration,
  });
  emitPlanExecutionProgress("completed");
  callbacks.onPlanStageChanged("completed");
  return finish("none");
}
