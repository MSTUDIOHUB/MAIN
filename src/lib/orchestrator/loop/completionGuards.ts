import { buildEffectiveTurnContract, type EffectiveTurnContract, type ResolvedUserIntent } from "../../runIntent";
import {
  type PlanExecutionEvidenceEntry,
} from "../../workflowModels";
import { evaluateApprovedPlanExecution } from "../../planExecutionEvaluation";
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
  resolveLatestUnreconciledFailureSignal,
  scopeExecutionEvidenceLedger,
  resolveCommandEvidenceRequirements,
  type ExecuteEvidenceClosureAudit,
} from "../../verificationEvidence";
import { resolveExecuteRecoveryActionContract } from "../../executeRecoveryTools";
import { resolveApprovedPlanTurnExpectations } from "./turnContractRuntime";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";

type NonActionableStopReason = Parameters<OrchestratorCallbacks["onNonActionableStop"]>[1];
type NonActionableStopProgress = Parameters<OrchestratorCallbacks["onNonActionableStop"]>[2];

export interface ExecutionCheckpointPresentation {
  message: string;
  title: string;
  summary: string;
  target: string;
  tool: string;
  latestEvidence: string;
  nextStep: string;
}

function uniqueMutationTargets(ledger: PlanExecutionEvidenceEntry[]): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const entry of ledger) {
    if (entry.kind !== "file" && entry.kind !== "deliverable") continue;
    const target = String(entry.target || entry.value || "").trim().replace(/\\/g, "/");
    const key = target.toLowerCase();
    if (!target || seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

/**
 * Build one user-visible terminal checkpoint from trusted execution evidence.
 * This is intentionally independent of held model prose: a paused run must
 * still say what changed, what automation observed, and what remains.
 */
export function buildExecutionCheckpointPresentation(input: {
  ledger: PlanExecutionEvidenceEntry[];
  transactionId?: string | null;
  validationExpected?: boolean;
  mutationExpected?: boolean;
  language: "zh" | "en";
  fallbackMessage: string;
  fallbackNextStep?: string;
}): ExecutionCheckpointPresentation {
  const ledger = scopeExecutionEvidenceLedger(input.ledger, input.transactionId);
  const audit = buildExecuteEvidenceClosureAudit({
    ledger,
    validationExpected: input.validationExpected !== false,
    mutationExpected: input.mutationExpected,
  });
  const mutationTargets = uniqueMutationTargets(ledger);
  const mutationCount = ledger.filter((entry) =>
    entry.kind === "file" || entry.kind === "deliverable"
  ).length;
  const ready = [...ledger].reverse().find((entry) =>
    entry.observationStatus === "ready" &&
    /^https?:\/\//i.test(String(entry.value || entry.target || ""))
  );
  const readyUrl = ready ? String(ready.value || ready.target || "").trim() : "";
  const failure = resolveLatestUnreconciledFailureSignal({ ledger });
  const target = failure?.sourceTarget || mutationTargets[mutationTargets.length - 1] || "";
  const detail = String(failure?.detail || input.fallbackMessage).replace(/\s+/g, " ").trim();
  const tool = String(failure?.entry.sourceTool || "").trim();

  if (input.language === "zh") {
    const nextStep = failure?.domain === "browser" && target
      ? `修复 ${target} 中浏览器验收捕获的问题，然后对同一行为重新执行浏览器交互验收。`
      : failure?.domain === "process"
      ? "根据现有 PTY generation 的状态恢复进程或健康检查；只有真实进程证据才重启服务器。"
      : failure?.domain === "command"
      ? `修复${target ? ` ${target} 的` : ""}命令诊断并重新运行同一验证命令。`
      : input.fallbackNextStep || "从当前证据检查点恢复精确修改或验证。";
    const title = failure?.domain === "browser"
      ? "浏览器验收发现源码问题"
      : "执行已暂停，结果已保留";
    const lines = [
      "执行尚未完成，但本轮可信结果已保留：",
      mutationCount > 0
        ? `- 已执行 ${mutationCount} 次文件修改，涉及 ${mutationTargets.length} 个文件：${mutationTargets.slice(0, 8).join("、")}${mutationTargets.length > 8 ? " 等" : ""}`
        : "",
      readyUrl ? `- 开发服务器已就绪：${readyUrl}` : "",
      audit.validationCount > 0 ? `- 已通过 ${audit.validationCount} 项自动验证。` : "",
      failure ? `- 当前阻断：${detail}` : `- 当前阻断：${input.fallbackMessage}`,
      `- 下一步：${nextStep}`,
    ].filter(Boolean);
    return {
      message: lines.join("\n"),
      title,
      summary: failure ? `自动验收未通过：${detail}` : input.fallbackMessage,
      target,
      tool,
      latestEvidence: failure ? detail : readyUrl || input.fallbackMessage,
      nextStep,
    };
  }

  const nextStep = failure?.domain === "browser" && target
    ? `Repair the browser-observed failure in ${target}, then rerun the same browser interaction validation.`
    : failure?.domain === "process"
    ? "Recover the process or health check from the current PTY generation; restart only when process evidence requires it."
    : failure?.domain === "command"
    ? `Repair the command diagnostic${target ? ` in ${target}` : ""} and rerun the same validation command.`
    : input.fallbackNextStep || "Resume the exact mutation or validation from the current evidence checkpoint.";
  const title = failure?.domain === "browser"
    ? "Browser validation found a source failure"
    : "Execution paused with results preserved";
  const lines = [
    "Execution is not complete, but trusted results from this run were preserved:",
    mutationCount > 0
      ? `- ${mutationCount} file mutations across ${mutationTargets.length} files: ${mutationTargets.slice(0, 8).join(", ")}${mutationTargets.length > 8 ? ", and others" : ""}`
      : "",
    readyUrl ? `- Dev server ready: ${readyUrl}` : "",
    audit.validationCount > 0 ? `- ${audit.validationCount} automated validations passed.` : "",
    failure ? `- Current blocker: ${detail}` : `- Current blocker: ${input.fallbackMessage}`,
    `- Next: ${nextStep}`,
  ].filter(Boolean);
  return {
    message: lines.join("\n"),
    title,
    summary: failure ? `Automated validation failed: ${detail}` : input.fallbackMessage,
    target,
    tool,
    latestEvidence: failure ? detail : readyUrl || input.fallbackMessage,
    nextStep,
  };
}

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
      case "mutation_required":
        return {
          message: "执行已暂停：本轮明确要求修改，但证据账本中没有任何真实文件修改。成功命令不能替代缺失的源码写入。",
          nextStep: "复用已读源码，执行目标内的真实修改，再运行对应验证。",
        };
      case "validation_required":
        return {
          message: "执行已暂停：本轮是命令或 Git 执行任务，虽然不要求修改文件，但证据账本中没有成功的目标命令证据。其他只读工具不能替代实际执行。",
          nextStep: "执行任务要求的命令并保存成功结果；若命令失败，请如实报告失败而不是完成。",
        };
      case "pty_observation_required":
        return {
          message: "执行已暂停：开发服务器已启动，但最新修改之后尚未获得同一 PTY generation 的就绪观察。PTY_BUSY 只表示当前集成 PTY 正承载前台服务，不表示端口或所有终端不可用。",
          nextStep: "调用 get_pty_status 或 read_pty_since 观察现有进程；确认 ready 后重新核对剩余义务，仅在存在浏览器交互义务时进入浏览器验收。",
        };
      case "browser_validation_required":
        return {
          message: "执行已暂停：开发服务器已有最新就绪证据，但最新修改之后尚未完成浏览器验收。服务器 ready 不能替代页面/DOM 验证。",
          nextStep: "复用已确认的 ready URL 调用 browser_evaluate，再核对剩余证据。",
        };
      case "unreconciled_failure":
        return {
          message: "执行已暂停：最新修改之后仍有未消解的实际命令、进程、浏览器或源码失败证据，不能报告完成。",
          nextStep: "按结构化失败来源修复源码、命令或进程，再重新运行对应验证；策略延期或 PTY_BUSY 不应记为实际失败。",
        };
      default:
        return {
          message: "执行已暂停：检测到成功修改，但最新修改之后没有可信的有限命令或浏览器验证证据。源码复读不能替代验收。",
          nextStep: "运行与改动对应的有限测试/构建，或完成浏览器验证后再总结。",
        };
    }
  }
  switch (audit.gap) {
    case "mutation_required":
      return {
        message: "Execution paused: this turn required a mutation, but the evidence ledger contains no real file change. A successful command cannot substitute for the missing source edit.",
        nextStep: "Reuse the observed source, make the in-scope change, then run the corresponding validation.",
      };
    case "validation_required":
      return {
        message: "Execution paused: this command or Git task did not require a file mutation, but the ledger contains no successful command evidence for the requested operation. Other read-only tools cannot substitute for execution.",
        nextStep: "Run the requested command and retain its successful result; if it fails, report the failure instead of completion.",
      };
    case "pty_observation_required":
      return {
        message: "Execution paused: the dev server was launched, but no ready observation for the current PTY generation exists after the latest mutation. PTY_BUSY means this integrated PTY is hosting a foreground process; it does not mean the port or every terminal is unavailable.",
        nextStep: "Observe the existing process with get_pty_status or read_pty_since, then reconcile the remaining obligations; enter browser validation only when an interaction obligation exists.",
      };
    case "browser_validation_required":
      return {
        message: "Execution paused: the dev server is ready, but no browser validation was recorded after the latest mutation. Readiness alone does not verify the page or DOM.",
        nextStep: "Use browser_evaluate with the observed ready URL, then reconcile the remaining evidence.",
      };
    case "unreconciled_failure":
      return {
        message: "Execution paused: an actual command, process, browser, or source failure after the latest mutation remains unresolved, so completion would be untruthful.",
        nextStep: "Repair the structured source, command, or process failure and rerun its validation; policy deferrals and PTY_BUSY must not be recorded as actual failures.",
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
  options: { sawExecutionEvidence?: boolean } = {},
): AgentLoopOutcome {
  const recoveryReason = progress?.recoveryReason || reason;
  if (recoveryReason === "plan_candidate_repair_budget_exhausted") {
    return {
      status: "paused",
      pauseKind: "action_required",
      reason: recoveryReason,
    };
  }
  if (
    progress?.phase === "paused" ||
    isRecoverableRuntimePauseReason(recoveryReason)
  ) {
    return {
      status: "paused",
      pauseKind: "recoverable",
      reason: recoveryReason,
    };
  }
  const resultKind = reason === "no_output"
    ? "error" as const
    : options.sawExecutionEvidence
    ? "partial" as const
    : "blocked" as const;
  return { status: "completed", resultKind, reason: recoveryReason };
}

/**
 * These boundaries preserve a resumable runtime checkpoint. Keep the mapping
 * provider-, model-, language-, and project-neutral: the runtime reason owns
 * the lifecycle meaning, not the prose that happened to accompany it.
 */
export function isRecoverableRuntimePauseReason(reason: string): boolean {
  return new Set([
    "plan_generation_failed",
    "plan_required_tool_protocol_violation",
    "stream_no_visible_progress_timeout",
    "stream_max_elapsed_timeout",
    "max_iterations_auto_resume",
    "max_iterations_boundary",
    "plan_max_iterations_checkpoint",
    "execute_max_iterations_checkpoint",
    "chat_max_iterations_strategy_exhausted",
    "execute_recovery_no_progress_limit",
    "execute_no_progress_batch_loop",
  ]).has(String(reason || "").trim());
}

export function resolveFinalTurnContractForCompletion(input: {
  callbacks: OrchestratorCallbacks;
  latestTurnContract: EffectiveTurnContract | null;
}): EffectiveTurnContract {
  if (input.latestTurnContract) return input.latestTurnContract;
  const { callbacks } = input;
  const finalRuntimeIntent: ResolvedUserIntent =
    callbacks.getRuntimeRunIntent?.() ?? callbacks.getCurrentRunIntent();
  const approvedPlanExpectations = resolveApprovedPlanTurnExpectations({
    planApproved: callbacks.getIsPlanApproved(),
    tasks: callbacks.getPlanTasks(),
    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
  });
  return buildEffectiveTurnContract({
    conversationIntent: callbacks.getCurrentRunIntent(),
    runtimeIntent: finalRuntimeIntent,
    commandDirective: callbacks.getCommandDirective?.() ?? null,
    planApproved: callbacks.getIsPlanApproved(),
    executionConsentGranted:
      callbacks.getExecutionConsentGranted?.() === true ||
      callbacks.getIsPlanApproved(),
    ...approvedPlanExpectations,
  });
}

export function runApprovedPlanCompletionGuard(input: {
  outcome: AgentLoopOutcome;
  callbacks: OrchestratorCallbacks;
  sawExecutionEvidence: boolean;
  executeRecoveryState?: ExecuteRecoveryRuntimeState | null;
}): AgentLoopOutcome | null {
  const { outcome, callbacks, sawExecutionEvidence } = input;
  if (
    outcome.status !== "completed" ||
    (outcome.resultKind !== undefined && outcome.resultKind !== "success")
  ) return null;
  if (!callbacks.getIsPlanApproved()) return null;
  if (callbacks.getIsApprovedPlanExecutionTransitionPending?.() === true) {
    logAgentEvent("plan_completion_guard_deferred_pending_same_turn_execution", {
      reason: "approval_transition_not_consumed_by_current_loop",
      sawExecutionEvidence,
    });
    return {
      status: "paused",
      pauseKind: "recoverable",
      reason: "approved_plan_same_turn_execution_pending",
    };
  }

  const evaluation = evaluateApprovedPlanExecution({
    tasks: callbacks.getPlanTasks(),
    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
    activeRecovery: input.executeRecoveryState || null,
    turnId: callbacks.getCurrentTurnId?.() || null,
    commandDirective: callbacks.getCommandDirective?.() || null,
  });
  const audit = evaluation.taskAudit;
  const evidenceClosureAudit = evaluation.evidenceClosure;
  const activeRecoveryPending = evaluation.activeRecoveryPending;
  if (evaluation.completionAllowed) {
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
    completionGap: evaluation.gap,
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
      recoveryReason: sawExecutionEvidence
        ? "approved_plan_completion_guard_incomplete_after_change"
        : "approved_plan_completion_guard_no_evidence",
      nextStep: closureGap?.nextStep || (language === "zh"
        ? "批准计划尚缺真实执行证据；恢复后必须写入、运行命令、做浏览器验证，或明确外部验证边界。"
        : "The approved plan still lacks real execution evidence; resume by writing, running commands, browser-validating, or stating the external validation boundary."),
    },
  );
  callbacks.onStatusChange("idle");
  return {
    status: "completed",
    resultKind: sawExecutionEvidence ? "partial" : "blocked",
    reason: "approved_plan_completion_guard",
  };
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
    (outcome.resultKind !== undefined && outcome.resultKind !== "success") ||
    finalTurnContract.completionEvidenceRequired !== "execution_evidence" ||
    approvedPlanAlreadyAudited
  ) {
    return null;
  }

  const evidenceClosureAudit = buildExecuteEvidenceClosureAudit({
    ledger: callbacks.getPlanExecutionEvidenceLedger(),
    validationExpected: finalTurnContract.validationExpected === true,
    mutationExpected: finalTurnContract.mutationExpected === true,
    transactionId: callbacks.getCurrentTurnId?.() || null,
    requiredCommandEvidence: resolveCommandEvidenceRequirements({
      tasks: callbacks.getIsPlanApproved()
        ? callbacks.getPlanTasks()
        : [],
      commandDirective: callbacks.getCommandDirective?.() || null,
    }),
  });
  const missingAnyExecutionEvidence = !sawExecutionEvidence;
  const missingRequiredEvidenceClosure =
    !evidenceClosureAudit.completionAllowed &&
    (
      finalTurnContract.mutationExpected === true ||
      finalTurnContract.validationExpected === true ||
      evidenceClosureAudit.unresolvedFailureCount > 0
    );
  const activeRecoveryPending = Boolean(
    executeRecoveryState && executeRecoveryState.mode !== "normal",
  );
  if (!missingAnyExecutionEvidence && !missingRequiredEvidenceClosure && !activeRecoveryPending) return null;

  const language = callbacks.getPreferredLanguage();
  const recoveryGap = activeRecoveryPending && executeRecoveryState
    ? describePendingRecoveryPhase(executeRecoveryState, language)
    : null;
  const closureGap = recoveryGap || (missingRequiredEvidenceClosure
    ? describeEvidenceClosureGap(evidenceClosureAudit, language)
    : null);
  logAgentEvent(
    missingRequiredEvidenceClosure
      ? "execute_completion_outcome_with_evidence_gap"
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
        : missingAnyExecutionEvidence
        ? "execution_evidence_required"
        : missingRequiredEvidenceClosure
        ? `execution_evidence_gap:${evidenceClosureAudit.gap}`
        : "execution_evidence_required",
      nextStep: closureGap?.nextStep || (language === "zh"
        ? "复用已读上下文，恢复后必须产生真实写入/验证证据，或明确阻塞。"
        : "Reuse read context and resume with real write/validation evidence, or a concrete blocker."),
    },
  );
  callbacks.onStatusChange("idle");
  return {
    status: "completed",
    resultKind: sawExecutionEvidence ? "partial" : "blocked",
    reason: activeRecoveryPending
      ? "execution_evidence_gap:recovery_phase_pending"
      : missingAnyExecutionEvidence
      ? "execution_evidence_required"
      : missingRequiredEvidenceClosure
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
  if (
    input.outcome.status !== "completed" ||
    (input.outcome.resultKind !== undefined && input.outcome.resultKind !== "success")
  ) return input.outcome;
  const approvedPlanGuardOutcome = runApprovedPlanCompletionGuard(input);
  if (approvedPlanGuardOutcome) return approvedPlanGuardOutcome;

  const approvedPlanAlreadyAudited =
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
