import {
  buildPlanTaskEvidenceAudit,
  type PlanExecutionProgressPhase,
  type PlanExecutionProgressUpdate,
  type PlanTask,
  type PlanTaskEvidenceAudit,
} from "../../workflowModels";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import {
  buildApprovedPlanContinuationPrompt,
  buildApprovedPlanNoToolPauseMessage,
  buildBrowserValidationContinuationPrompt,
  buildPlanCommandExecutionHint,
  formatPlanAuditRemainingTasks,
  logAgentEvent,
  resolveApprovedPlanValidationBoundary,
} from "../../orchestrator";
import type { OrchestratorCallbacks } from "../types";
import { resolveExecuteNoToolCheckpointLimit } from "./executeNoToolRecovery";
import { buildExecuteEvidenceClosureAudit } from "../../verificationEvidence";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";

export type ApprovedPlanFinalizationResult = {
  status: "none" | "continue" | "stopped";
  consecutiveNoToolCount: number;
};

function formatUserValidationConclusionTasks(
  tasks: PlanTask[],
  language: "zh" | "en",
): string {
  return tasks.slice(0, 8).map((task, index) => {
    const detail = String(task.blockedReason || "").trim();
    return `${index + 1}. ${task.text}${detail ? ` — ${detail}` : ""}`;
  }).join("\n") || (language === "zh" ? "1. 按实际运行环境复核最终交互。" : "1. Review the final interaction in the target runtime.");
}

/**
 * External/user review belongs in the conclusion. It is intentionally not an
 * acceptance gate once the runtime audit has accepted all automatable work.
 */
export function appendApprovedPlanUserValidationConclusion(input: {
  text: string;
  audit: Pick<PlanTaskEvidenceAudit, "acceptedCompletion" | "pendingUserValidationTasks"> | null;
  language: "zh" | "en";
}): string {
  const pending = input.audit?.pendingUserValidationTasks || [];
  if (!input.audit?.acceptedCompletion || pending.length === 0) {
    return input.text;
  }
  const base = String(input.text || "").trim() || (input.language === "zh"
    ? "自动执行与可用验证已完成。"
    : "Automated execution and available validation are complete.");
  const heading = input.language === "zh"
    ? "建议用户复核（不影响本次任务完成状态）："
    : "Suggested user review (does not affect this task's completed status):";
  return `${base}\n\n${heading}\n${formatUserValidationConclusionTasks(pending, input.language)}`;
}

export function buildApprovedPlanEvidenceCompletionMessage(input: {
  language: "zh" | "en";
  completedCount: number;
  totalCount: number;
  pendingUserValidationTasks?: PlanTask[];
}): string {
  const pending = input.pendingUserValidationTasks || [];
  const base = input.language === "en"
    ? pending.length > 0
      ? "Completed all automatable work in the approved Plan. MAIN verified the available mutation and validation evidence; external user review is reported separately below."
      : `Completed the approved Plan (${input.completedCount}/${input.totalCount}). MAIN verified the planned mutations and validation evidence for every task; no additional model-authored completion claim was required.`
    : pending.length > 0
    ? "已完成批准 Plan 中所有可自动执行和验收的工作。MAIN 已核验现有修改与自动验证证据；外部用户复核单独列在下方。"
    : `已按批准的 Plan 完成全部任务（${input.completedCount}/${input.totalCount}）。MAIN 已逐项核验计划要求的修改和验证证据，无需再依赖模型额外声明完成。`;
  return appendApprovedPlanUserValidationConclusion({
    text: base,
    audit: {
      acceptedCompletion: true,
      pendingUserValidationTasks: pending,
    },
    language: input.language,
  });
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

  if (
    validationBoundary === "browser_prompt" ||
    validationBoundary === "pause_browser_unavailable"
  ) {
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
  executeRecoveryState?: ExecuteRecoveryRuntimeState | null;
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

  const baseApprovedPlanAudit = approvedPlanAuditForNoTool ||
    buildPlanTaskEvidenceAudit({
      tasks: callbacks.getPlanTasks(),
      evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
      highlightNext: true,
    });
  const approvedPlanValidationBoundary = resolveApprovedPlanValidationBoundary({
    audit: baseApprovedPlanAudit,
    availableToolNames,
  });
  const approvedPlanAudit = approvedPlanValidationBoundary === "pause_external_validation"
    ? { ...baseApprovedPlanAudit, acceptedCompletion: true }
    : baseApprovedPlanAudit;
  const approvedPlanTasks = approvedPlanAudit.tasks || [];
  const approvedPlanMissingTasks = (approvedPlanAudit.totalCount || 0) === 0;
  const hasRemainingApprovedPlanTasks =
    !!approvedPlanAudit &&
    !approvedPlanAudit.acceptedCompletion;

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

  const baseFinalPlanAudit = buildPlanTaskEvidenceAudit({
    tasks: callbacks.getPlanTasks(),
    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
    highlightNext: true,
  });
  const finalValidationBoundary = resolveApprovedPlanValidationBoundary({
    audit: baseFinalPlanAudit,
    availableToolNames,
  });
  const finalPlanAudit = finalValidationBoundary === "pause_external_validation"
    ? { ...baseFinalPlanAudit, acceptedCompletion: true }
    : baseFinalPlanAudit;
  const evidenceClosureAudit = buildExecuteEvidenceClosureAudit({
    ledger: callbacks.getPlanExecutionEvidenceLedger(),
    validationExpected: true,
  });
  const activeRecoveryPending = Boolean(
    input.executeRecoveryState && input.executeRecoveryState.mode !== "normal",
  );
  if (
    finalPlanAudit.totalCount > 0 &&
    finalPlanAudit.acceptedCompletion &&
    !evidenceClosureAudit.completionAllowed &&
    !activeRecoveryPending
  ) {
    // The shared pre-completion phase owns exact capability selection. Do not
    // emit a generic Plan reprompt here: returning "none" lets the caller
    // atomically activate finite validation, PTY observation, browser action,
    // or reconciliation before any final text is committed.
    logAgentEvent("plan_completion_evidence_recovery_delegated", {
      iteration,
      evidenceClosureGap: evidenceClosureAudit.gap,
      mutations: evidenceClosureAudit.mutationCount,
      validations: evidenceClosureAudit.validationCount,
      unsatisfiedObligations: evidenceClosureAudit.unsatisfiedObligationCount,
    });
    return finish("none");
  }
  if (
    finalPlanAudit.totalCount === 0 ||
    !finalPlanAudit.acceptedCompletion ||
    !evidenceClosureAudit.completionAllowed ||
    activeRecoveryPending
  ) {
    logAgentEvent("plan_completion_guard_reprompt", {
      iteration,
      completed: finalPlanAudit.completedCount,
      total: finalPlanAudit.totalCount,
      remaining: finalPlanAudit.remainingTasks.length,
      pendingExternalValidation: finalPlanAudit.pendingExternalValidation,
      pendingUserValidation: finalPlanAudit.pendingUserValidationTasks.length,
      evidenceClosureGap: evidenceClosureAudit.gap,
      activeRecoveryMode: input.executeRecoveryState?.mode || "normal",
    });
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: callbacks.getPreferredLanguage() === "zh"
          ? [
            "MAIN 的完成闸门没有通过：当前已批准 Plan 不能仅凭模型正文或单次工具结果结束。",
            `请继续补齐仍可自动执行的文件、命令或浏览器证据（当前闭环缺口：${activeRecoveryPending ? `active_recovery:${input.executeRecoveryState?.mode}` : evidenceClosureAudit.gap}）；纯用户/Tauri/外部复核只写入最终结论，不作为任务成功闸门。`,
          ].join("\n")
        : [
            "MAIN's completion gate did not pass: the approved Plan cannot end from assistant prose or a single tool result alone.",
            `Continue with any still-automatable file, command, or browser evidence (current closure gap: ${activeRecoveryPending ? `active_recovery:${input.executeRecoveryState?.mode}` : evidenceClosureAudit.gap}). Pure user/Tauri/external review belongs in the final conclusion and is not a success gate.`,
          ].join("\n"),
    });
    return finish("continue");
  }

  emitTaskOrchestratorPhase("DONE", {
    reason: finalPlanAudit.pendingExternalValidation
      ? "plan_automation_evidence_complete_external_review_advisory"
      : "plan_evidence_complete",
    iteration,
    pendingUserValidation: finalPlanAudit.pendingUserValidationTasks.length,
  });
  emitPlanExecutionProgress("completed");
  callbacks.onPlanStageChanged("completed");
  return finish("none");
}
