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

type NonActionableStopReason = Parameters<OrchestratorCallbacks["onNonActionableStop"]>[1];
type NonActionableStopProgress = Parameters<OrchestratorCallbacks["onNonActionableStop"]>[2];

export function resolveNonActionableStopOutcome(
  reason: NonActionableStopReason,
  progress?: NonActionableStopProgress,
): AgentLoopOutcome {
  const status: AgentLoopOutcome["status"] =
    reason === "no_output" ? "stopped_no_output" :
    progress?.recoveryReason === "approved_plan_completion_guard_no_evidence" ? "stopped_no_action" :
    reason === "incomplete_plan" ? "paused" :
    "stopped_no_action";
  return { status, reason };
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
  if (
    audit.totalCount > 0 &&
    audit.allTrustedComplete &&
    !audit.pendingExternalValidation &&
    audit.pendingUserValidationTasks.length === 0 &&
    sawExecutionEvidence
  ) {
    return null;
  }

  const language = callbacks.getPreferredLanguage();
  const remainingText = formatPlanAuditRemainingTasks(
    audit,
    language,
    language === "zh"
      ? "- 已批准 Plan 尚未产生可审计的运行时任务证据。"
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
  });
  callbacks.onNonActionableStop(
    buildApprovedPlanNoToolPauseMessage(
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
      nextStep: language === "zh"
        ? "批准计划尚缺真实执行证据；恢复后必须写入、运行命令、做浏览器验证，或明确外部验证边界。"
        : "The approved plan still lacks real execution evidence; resume by writing, running commands, browser-validating, or stating the external validation boundary.",
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
}): AgentLoopOutcome | null {
  const {
    outcome,
    callbacks,
    finalTurnContract,
    approvedPlanAlreadyAudited,
    sawExecutionEvidence,
  } = input;
  if (
    outcome.status !== "completed" ||
    finalTurnContract.completionEvidenceRequired !== "execution_evidence" ||
    approvedPlanAlreadyAudited ||
    sawExecutionEvidence
  ) {
    return null;
  }

  const language = callbacks.getPreferredLanguage();
  logAgentEvent("execute_completion_outcome_without_evidence", {
    conversationIntent: finalTurnContract.conversationIntent,
    runtimeIntent: finalTurnContract.runtimeIntent,
    approvalState: finalTurnContract.approvalState,
    mutationExpected: finalTurnContract.mutationExpected,
    evidenceRequired: finalTurnContract.completionEvidenceRequired,
  });
  callbacks.onNonActionableStop(
    language === "zh"
      ? "执行已暂停：本轮需要真实执行证据，但没有检测到源码/文件写入、成功命令、浏览器验证或明确外部验证边界。如果前面只是重复只读检查，请复用已读上下文，恢复后直接调用可用写入/验证工具，或说明具体阻塞。"
      : "Execution paused: this turn required execution evidence, but no source/file write, successful command, browser validation, or explicit external validation boundary was detected. If the prior steps were read-only, reuse read context and resume by calling the available write/validation tools, or state the concrete blocker.",
    "no_action",
    {
      phase: "paused",
      nextStep: language === "zh"
        ? "复用已读上下文，恢复后必须产生真实写入/验证证据，或明确阻塞。"
        : "Reuse read context and resume with real write/validation evidence, or a concrete blocker.",
    },
  );
  callbacks.onStatusChange("idle");
  return { status: "stopped_no_action", reason: "execution_evidence_required" };
}

export function runAgentLoopCompletionGuards(input: {
  outcome: AgentLoopOutcome;
  callbacks: OrchestratorCallbacks;
  latestTurnContract: EffectiveTurnContract | null;
  sawExecutionEvidence: boolean;
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
  }) ?? input.outcome;
}
