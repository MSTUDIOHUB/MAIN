import { buildEffectiveTurnContract, type EffectiveTurnContract, type ResolvedUserIntent } from "../../runIntent";
import { buildPlanTaskEvidenceAudit } from "../../workflowModels";
import {
  buildApprovedPlanNoToolPauseMessage,
  formatPlanAuditRemainingTasks,
} from "../prompts/planPrompts";
import {
  logAgentEvent,
} from "../../orchestrator";
import type { AgentLoopOutcome, OrchestratorCallbacks } from "../types";
import {
  buildExecuteEvidenceClosureAudit,
  type ExecuteEvidenceClosureAudit,
} from "../../verificationEvidence";
import { resolveExecuteRecoveryActionContract } from "../../executeRecoveryTools";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";

type NonActionableStopReason = Parameters<OrchestratorCallbacks["onNonActionableStop"]>[1];
type NonActionableStopProgress = Parameters<OrchestratorCallbacks["onNonActionableStop"]>[2];

function describePendingRecoveryPhase(
  state: ExecuteRecoveryRuntimeState,
  language: "zh" | "en",
): { message: string; nextStep: string; nextRequiredCapability: string } {
  const contract = resolveExecuteRecoveryActionContract(state.mode, {
    expectedTarget: state.expectedTarget,
    readLease: state.readLease,
    sourceObservationKey: state.sourceObservationKey,
    decisionCheckpoint: state.decisionCheckpoint,
    phaseNoProgressCount: state.phaseNoProgressCount,
  });
  return language === "zh"
    ? {
        message: `执行已暂停：恢复事务仍处于 ${contract.phase} 阶段，所需下一能力是 ${contract.nextRequiredCapability}；未完成的运行时阶段不能被最终文本跳过。`,
        nextStep: `从当前证据检查点继续 ${contract.nextRequiredCapability}，完成 reconcile 后再总结。`,
        nextRequiredCapability: contract.nextRequiredCapability,
      }
    : {
        message: `Execution paused: the recovery transaction is still in ${contract.phase}; its required next capability is ${contract.nextRequiredCapability}. Final text cannot bypass an active runtime phase.`,
        nextStep: `Resume ${contract.nextRequiredCapability} from the current evidence checkpoint and reconcile before summarizing.`,
        nextRequiredCapability: contract.nextRequiredCapability,
      };
}

function describeEvidenceClosureGap(
  audit: ExecuteEvidenceClosureAudit,
  language: "zh" | "en",
): { message: string; nextStep: string } {
  if (language === "zh") {
    switch (audit.gap) {
      case "pty_observation_required":
        return {
          message: "执行已暂停：开发服务器已启动，但最新修改之后尚未获得同一 PTY generation 的就绪观察。PTY_BUSY 只表示当前集成 PTY 正承载前台服务，不表示端口或所有终端不可用。",
          nextStep: "调用 get_pty_status 或 read_pty_since 观察现有进程；确认 ready URL 后再做浏览器验收。",
        };
      case "browser_validation_required":
        return {
          message: "执行已暂停：开发服务器已有最新就绪证据，但最新修改之后尚未完成浏览器验收。服务器 ready 不能替代页面/DOM 验证。",
          nextStep: "复用已确认的 ready URL 调用 browser_evaluate，再核对剩余证据。",
        };
      case "unreconciled_failure":
        return {
          message: "执行已暂停：最新修改之后仍有未消解的实际命令或开发服务器失败证据，不能报告完成。",
          nextStep: "修复失败原因并重新运行对应验证；策略延期或 PTY_BUSY 不应记为实际失败。",
        };
      default:
        return {
          message: "执行已暂停：检测到成功修改，但最新修改之后没有可信的有限命令或浏览器验证证据。源码复读不能替代验收。",
          nextStep: "运行与改动对应的有限测试/构建，或完成浏览器验证后再总结。",
        };
    }
  }
  switch (audit.gap) {
    case "pty_observation_required":
      return {
        message: "Execution paused: the dev server was launched, but no ready observation for the current PTY generation exists after the latest mutation. PTY_BUSY means this integrated PTY is hosting a foreground process; it does not mean the port or every terminal is unavailable.",
        nextStep: "Observe the existing process with get_pty_status or read_pty_since, then browser-validate the ready URL.",
      };
    case "browser_validation_required":
      return {
        message: "Execution paused: the dev server is ready, but no browser validation was recorded after the latest mutation. Readiness alone does not verify the page or DOM.",
        nextStep: "Use browser_evaluate with the observed ready URL, then reconcile the remaining evidence.",
      };
    case "unreconciled_failure":
      return {
        message: "Execution paused: an actual command or dev-server failure after the latest mutation remains unresolved, so completion would be untruthful.",
        nextStep: "Repair and rerun the failed validation; policy deferrals and PTY_BUSY must not be recorded as actual failures.",
      };
    default:
      return {
        message: "Execution paused: a mutation succeeded, but no trusted finite-command or browser validation exists after the latest mutation. A source reread is not completion evidence.",
        nextStep: "Run a focused finite check or browser validation for the change before summarizing.",
      };
  }
}

export function resolveNonActionableStopOutcome(
  reason: NonActionableStopReason,
  progress?: NonActionableStopProgress,
): AgentLoopOutcome {
  const status: AgentLoopOutcome["status"] =
    reason === "no_output" ? "stopped_no_output" :
    progress?.recoveryReason === "approved_plan_completion_guard_no_evidence" ? "stopped_no_action" :
    reason === "incomplete_plan" ? "paused" :
    "stopped_no_action";
  return { status, reason: progress?.recoveryReason || reason };
}

export function resolveFinalTurnContractForCompletion(input: {
  callbacks: OrchestratorCallbacks;
  latestTurnContract: EffectiveTurnContract | null;
}): EffectiveTurnContract {
  if (input.latestTurnContract) return input.latestTurnContract;
  const { callbacks } = input;
  const finalRuntimeIntent: ResolvedUserIntent =
    callbacks.getRuntimeRunIntent?.() ??
    (callbacks.getCurrentRunIntent() === "plan" && callbacks.getIsPlanApproved()
      ? "execute"
      : callbacks.getCurrentRunIntent());
  return buildEffectiveTurnContract({
    conversationIntent: callbacks.getCurrentRunIntent(),
    runtimeIntent: finalRuntimeIntent,
    commandDirective: callbacks.getCommandDirective?.() ?? null,
    planApproved: callbacks.getIsPlanApproved(),
    executionConsentGranted:
      callbacks.getExecutionConsentGranted?.() === true ||
      callbacks.getIsPlanApproved(),
  });
}

export function runApprovedPlanCompletionGuard(input: {
  outcome: AgentLoopOutcome;
  callbacks: OrchestratorCallbacks;
  sawExecutionEvidence: boolean;
  executeRecoveryState?: ExecuteRecoveryRuntimeState | null;
}): AgentLoopOutcome | null {
  const { outcome, callbacks, sawExecutionEvidence } = input;
  if (outcome.status !== "completed") return null;
  if (callbacks.getWorkflowMode() !== "plan" || !callbacks.getIsPlanApproved()) return null;
  if (callbacks.getIsApprovedPlanExecutionTransitionPending?.() === true) {
    logAgentEvent("plan_completion_guard_deferred_pending_same_turn_execution", {
      reason: "approval_transition_not_consumed_by_current_loop",
      sawExecutionEvidence,
    });
    return {
      status: "paused",
      reason: "approved_plan_same_turn_execution_pending",
    };
  }

  const audit = buildPlanTaskEvidenceAudit({
    tasks: callbacks.getPlanTasks(),
    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
    highlightNext: true,
  });
  const externalReviewIsAdvisory =
    callbacks.getPlanStage?.() === "completed" && audit.pendingExternalValidation;
  const evidenceClosureAudit = buildExecuteEvidenceClosureAudit({
    ledger: callbacks.getPlanExecutionEvidenceLedger(),
    validationExpected: !externalReviewIsAdvisory,
  });
  const activeRecoveryPending = Boolean(
    input.executeRecoveryState && input.executeRecoveryState.mode !== "normal",
  );
  if (
    audit.totalCount > 0 &&
    (audit.acceptedCompletion || callbacks.getPlanStage?.() === "completed") &&
    sawExecutionEvidence &&
    evidenceClosureAudit.completionAllowed &&
    !activeRecoveryPending
  ) {
    return null;
  }

  const language = callbacks.getPreferredLanguage();
  const recoveryGap = activeRecoveryPending && input.executeRecoveryState
    ? describePendingRecoveryPhase(input.executeRecoveryState, language)
    : null;
  const closureGap = recoveryGap || (evidenceClosureAudit.completionAllowed
    ? null
    : describeEvidenceClosureGap(evidenceClosureAudit, language));
  const remainingText = formatPlanAuditRemainingTasks(
    audit,
    language,
    language === "zh"
      ? closureGap
        ? `- ${closureGap.nextStep}`
        : "- 已批准 Plan 尚未产生可审计的运行时任务证据。"
      : closureGap
      ? `- ${closureGap.nextStep}`
      : "- The approved Plan has not produced auditable runtime task evidence yet.",
  );
  logAgentEvent("plan_completion_guard_outcome_no_evidence", {
    completed: audit.completedCount,
    total: audit.totalCount,
    remaining: audit.remainingTasks.length,
    pendingExternalValidation: audit.pendingExternalValidation,
    pendingUserValidation: audit.pendingUserValidationTasks.length,
    acceptedCompletion: audit.acceptedCompletion,
    allTrustedComplete: audit.allTrustedComplete,
    sawExecutionEvidence,
    evidenceClosureGap: evidenceClosureAudit.gap,
    mutations: evidenceClosureAudit.mutationCount,
    validations: evidenceClosureAudit.validationCount,
    unresolvedFailures: evidenceClosureAudit.unresolvedFailureCount,
    activeRecoveryMode: input.executeRecoveryState?.mode || "normal",
    activeRecoveryNextCapability: recoveryGap?.nextRequiredCapability || null,
  });
  callbacks.onNonActionableStop(
    closureGap?.message || buildApprovedPlanNoToolPauseMessage(
        language,
        remainingText,
        1,
        audit,
        false,
      ),
    "incomplete_plan",
    {
      phase: "paused",
      recoveryReason: "approved_plan_completion_guard_no_evidence",
      nextStep: closureGap?.nextStep || (language === "zh"
        ? "批准计划尚缺真实执行证据；恢复后必须写入、运行命令、做浏览器验证，或明确外部验证边界。"
        : "The approved plan still lacks real execution evidence; resume by writing, running commands, browser-validating, or stating the external validation boundary."),
    },
  );
  callbacks.onStatusChange("idle");
  return { status: "stopped_no_action", reason: "approved_plan_completion_guard" };
}

export function runExecutionEvidenceCompletionGuard(input: {
  outcome: AgentLoopOutcome;
  callbacks: OrchestratorCallbacks;
  finalTurnContract: EffectiveTurnContract;
  approvedPlanAlreadyAudited: boolean;
  sawExecutionEvidence: boolean;
  executeRecoveryState?: ExecuteRecoveryRuntimeState | null;
}): AgentLoopOutcome | null {
  const {
    outcome,
    callbacks,
    finalTurnContract,
    approvedPlanAlreadyAudited,
    sawExecutionEvidence,
    executeRecoveryState,
  } = input;
  if (
    outcome.status !== "completed" ||
    finalTurnContract.completionEvidenceRequired !== "execution_evidence" ||
    approvedPlanAlreadyAudited
  ) {
    return null;
  }

  const evidenceClosureAudit = buildExecuteEvidenceClosureAudit({
    ledger: callbacks.getPlanExecutionEvidenceLedger(),
    validationExpected: finalTurnContract.validationExpected === true,
  });
  const missingAnyExecutionEvidence = !sawExecutionEvidence;
  const missingRequiredValidationClosure =
    !evidenceClosureAudit.completionAllowed &&
    (
      finalTurnContract.validationExpected === true ||
      evidenceClosureAudit.unresolvedFailureCount > 0
    );
  const activeRecoveryPending = Boolean(
    executeRecoveryState && executeRecoveryState.mode !== "normal",
  );
  if (!missingAnyExecutionEvidence && !missingRequiredValidationClosure && !activeRecoveryPending) return null;

  const language = callbacks.getPreferredLanguage();
  const recoveryGap = activeRecoveryPending && executeRecoveryState
    ? describePendingRecoveryPhase(executeRecoveryState, language)
    : null;
  const closureGap = recoveryGap || (missingRequiredValidationClosure
    ? describeEvidenceClosureGap(evidenceClosureAudit, language)
    : null);
  logAgentEvent(
    missingRequiredValidationClosure
      ? "execute_completion_outcome_without_post_mutation_validation"
      : "execute_completion_outcome_without_evidence",
    {
    conversationIntent: finalTurnContract.conversationIntent,
    runtimeIntent: finalTurnContract.runtimeIntent,
    approvalState: finalTurnContract.approvalState,
    mutationExpected: finalTurnContract.mutationExpected,
    validationExpected: finalTurnContract.validationExpected,
    evidenceRequired: finalTurnContract.completionEvidenceRequired,
    evidenceClosureGap: evidenceClosureAudit.gap,
    mutations: evidenceClosureAudit.mutationCount,
    validations: evidenceClosureAudit.validationCount,
    unresolvedFailures: evidenceClosureAudit.unresolvedFailureCount,
    latestMutationAt: evidenceClosureAudit.latestMutationAt,
    latestValidationAt: evidenceClosureAudit.latestValidationAt,
    latestReadyAt: evidenceClosureAudit.latestReadyAt,
    activeRecoveryMode: executeRecoveryState?.mode || "normal",
    activeRecoveryNextCapability: recoveryGap?.nextRequiredCapability || null,
  });
  callbacks.onNonActionableStop(
    closureGap?.message || (language === "zh"
      ? "执行已暂停：本轮需要真实执行证据，但没有检测到源码/文件写入、成功命令、浏览器验证或明确外部验证边界。如果前面只是重复只读检查，请复用已读上下文，恢复后直接调用可用写入/验证工具，或说明具体阻塞。"
      : "Execution paused: this turn required execution evidence, but no source/file write, successful command, browser validation, or explicit external validation boundary was detected. If the prior steps were read-only, reuse read context and resume by calling the available write/validation tools, or state the concrete blocker."),
    "no_action",
    {
      phase: "paused",
      recoveryReason: activeRecoveryPending
        ? "execution_evidence_gap:recovery_phase_pending"
        : missingRequiredValidationClosure
        ? `execution_evidence_gap:${evidenceClosureAudit.gap}`
        : "execution_evidence_required",
      nextStep: closureGap?.nextStep || (language === "zh"
        ? "复用已读上下文，恢复后必须产生真实写入/验证证据，或明确阻塞。"
        : "Reuse read context and resume with real write/validation evidence, or a concrete blocker."),
    },
  );
  callbacks.onStatusChange("idle");
  return {
    status: "stopped_no_action",
    reason: activeRecoveryPending
      ? "execution_evidence_gap:recovery_phase_pending"
      : missingRequiredValidationClosure
      ? `execution_evidence_gap:${evidenceClosureAudit.gap}`
      : "execution_evidence_required",
  };
}

export function runAgentLoopCompletionGuards(input: {
  outcome: AgentLoopOutcome;
  callbacks: OrchestratorCallbacks;
  latestTurnContract: EffectiveTurnContract | null;
  sawExecutionEvidence: boolean;
  executeRecoveryState?: ExecuteRecoveryRuntimeState | null;
}): AgentLoopOutcome {
  const approvedPlanGuardOutcome = runApprovedPlanCompletionGuard(input);
  if (approvedPlanGuardOutcome) return approvedPlanGuardOutcome;

  const approvedPlanAlreadyAudited =
    input.callbacks.getWorkflowMode() === "plan" &&
    input.callbacks.getIsPlanApproved();
  const finalTurnContract = resolveFinalTurnContractForCompletion({
    callbacks: input.callbacks,
    latestTurnContract: input.latestTurnContract,
  });
  return runExecutionEvidenceCompletionGuard({
    outcome: input.outcome,
    callbacks: input.callbacks,
    finalTurnContract,
    approvedPlanAlreadyAudited,
    sawExecutionEvidence: input.sawExecutionEvidence,
    executeRecoveryState: input.executeRecoveryState,
  }) ?? input.outcome;
}
