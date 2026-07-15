import {
  buildFailedFiniteValidationRecoveryPrompt,
  classifyFailedFiniteValidationOutcome,
  failedFiniteValidationMatchesPendingPlanEvidence,
  hasPendingPlanCommandEvidence,
  resolveFailedFiniteValidationRecoveryPolicy,
  shouldEnterFailedFiniteValidationRecovery,
} from "../../executeRecoveryTools";
import {
  isReviewablePlanStage,
  isSuccessfulPlanArtifactWriteResult,
  logAgentEvent,
  resolveApprovedPlanValidationBoundary,
} from "../../orchestrator";
import { commandResultLooksSuccessful } from "../../planEvidence";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import type { ResolvedUserIntent } from "../../runIntent";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import type { ToolCapabilityRegistry, ToolPermissionPolicy } from "../../toolCapabilities";
import type { MainThreadEventInput, ToolFeedbackFormat } from "../../turnEvents";
import type { TurnInputContextSignals } from "../../turnIntake";
import type {
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
  PlanRuntimePhase,
  PlanTask,
} from "../../workflowModels";
import { buildPlanTaskEvidenceAudit } from "../../workflowModels";
import { buildExecuteEvidenceClosureAudit } from "../../verificationEvidence";
import type { OrchestratorCallbacks, ToolCallToExecute, ToolExecutionResult } from "../types";
import type { ApprovedPlanNoProgressDecision } from "./loopRecovery";
import {
  handleCrossIterationReadFileLoopRecovery,
  handleExecuteConvergencePrompt,
  handleNoProgressRecovery,
  handleReadFileRepeatLimitRecovery,
  handleRepeatedEditValidationRecovery,
  handleStrictRepeatGuardRecovery,
  handleTargetProgressLoopRecovery,
} from "./loopRecovery";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import {
  applyCrossIterationReadFileRecoveryState,
  clearExecuteRecoveryRuntimeState,
  resolvePtyObservationPolicyDeferral,
  setRepeatedEditValidationRecoveryAttempts,
} from "./executeRecoveryRuntime";
import type {
  PlanLoopRuntimeState,
  PlanRuntimePhaseQualitySnapshot,
} from "./planRuntimeState";
import {
  applyPlanQualityRuntimeState,
  applyPlanReadOnlyConvergenceRuntimeState,
  applyPlanRuntimePhase,
} from "./planRuntimeState";
import type { AgentLoopGuardRuntimeState } from "./loopGuardRuntimeState";
import {
  applyNoProgressTrackingRuntimeState,
  applyToolFailureSignatureRuntimeState,
  getNoProgressTrackingRuntimeState,
} from "./loopGuardRuntimeState";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import { applyExecuteConvergencePromptState } from "./recoveryPromptRuntimeState";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import type { ApprovedPlanRecoveryRuntimeState } from "./approvedPlanRecoveryRuntime";
import {
  handlePlanQualityRecoveryAfterToolResults,
  shouldPauseForReviewablePlanArtifactAfterToolResults,
} from "./planQualityRecovery";
import { handlePlanReadOnlyConvergence } from "./planConvergence";
import { appendToolResultsToHistory } from "./toolResultHistory";
import type { TurnIterationContext } from "./turnIterationContext";

type WorkflowMode = "chat" | "edit" | "plan";

type ApprovedPlanCompletionAudit = {
  completedCount: number;
  totalCount: number;
  pendingUserValidationTasks?: PlanTask[];
};

type SetPlanRuntimePhase = (
  phase: PlanRuntimePhase,
  reason?: string,
  status?: "pending" | "running" | "done" | "failed",
  qualitySnapshot?: PlanRuntimePhaseQualitySnapshot,
) => void;

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

type EmitPlanExecutionProgress = (
  phase: PlanExecutionProgressPhase,
  overrides?: Partial<PlanExecutionProgressUpdate>,
) => void;

type ActivateExecuteRecovery = (
  mode: Exclude<ExecuteRecoveryRuntimeState["mode"], "normal">,
  reason: string,
  context?: Record<string, unknown>,
) => ExecuteRecoveryRuntimeState;

type ActivateChatFinalSynthesis = (
  reason: string,
  context?: Record<string, unknown>,
) => void;

type ApprovedPlanNoProgressAction = (input: ApprovedPlanNoProgressDecision) => void;
type ApprovedPlanNoProgressRecoveryAction = (
  input: ApprovedPlanNoProgressDecision,
) => ApprovedPlanRecoveryRuntimeState;

const APPROVED_PLAN_SCOPE_BLOCKED_RE = /\bAPPROVED_PLAN_SCOPE_BLOCKED\b/;

function getApprovedPlanScopeBlockedTargets(results: ToolExecutionResult[]): string[] {
  return Array.from(new Set(
    results
      .filter((result) =>
        result.isError &&
        APPROVED_PLAN_SCOPE_BLOCKED_RE.test(String(result.content || ""))
      )
      .map((result) => String(result.target || "").trim())
      .filter(Boolean),
  ));
}

function buildApprovedPlanScopeRecoveryPrompt(input: {
  language: "zh" | "en";
  targets: string[];
  plannedTargets: string[];
}): string {
  const targets = input.targets.join(", ") || (input.language === "zh" ? "新的相关文件" : "a newly relevant file");
  const planned = input.plannedTargets.join(", ") || (input.language === "zh" ? "当前计划任务" : "the current Plan tasks");
  if (input.language === "en") {
    return [
      "The attempted write to " + targets + " was blocked because it is outside the approved Plan scope (" + planned + ").",
      "Do not pause merely to add a temporary verification helper. Continue the approved work using existing tests, an inline command, a temporary location outside the workspace, or read-only inspection.",
      "Only if the source change genuinely requires this additional workspace target, output a focused Plan revision for review; otherwise continue execution and validation now.",
    ].join("\n");
  }
  return [
    "对 " + targets + " 的写入已被拦截，因为它不在已批准 Plan 的修改范围内（当前范围：" + planned + "）。",
    "不要仅为添加临时验证脚本而暂停；请改用现有测试、内联命令、工作区外临时位置或只读检查，继续完成已批准任务。",
    "只有当源码修复确实必须修改这个额外目标时，才输出聚焦的 Plan revision 供审核；否则现在继续执行和验证。",
  ].join("\n");
}

export type ToolResultRecoveryPhaseResult =
  | {
      status: "continue" | "stopped" | "plan_completed" | "goal_completed";
      planRuntimeState: PlanLoopRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
      approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
      completionAudit?: ApprovedPlanCompletionAudit;
    }
  | {
      status: "completed";
      planRuntimeState: PlanLoopRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
      approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
      completionAudit?: ApprovedPlanCompletionAudit;
    };

export async function handleToolResultRecoveryPhase(input: {
  callbacks: OrchestratorCallbacks;
  workspace: string;
  activeProfile: string;
  toolFeedbackFormat: ToolFeedbackFormat;
  toolPermissionPolicy: ToolPermissionPolicy;
  workflowMode: WorkflowMode;
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  effectiveMaxIterations: number;
  effectiveToolCalls: ToolCallToExecute[];
  results: ToolExecutionResult[];
  toolArgsByCallId: Map<string, Record<string, unknown>>;
  toolFailureSignatures: Map<string, string>;
  hasPlanDecisionOutput: boolean;
  unityMcpFallbackPrompt: string | null;
  remainingTaskText: string | null;
  successfulReadOnlyExplorationResultCount: number;
  isUnapprovedPlanReadOnlyBatch: boolean;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  latestUserPromptText: string;
  availableToolNames: Set<string>;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  snapshotContextLimit?: number;
  repairExecutionRequestInChat: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  planRuntimeState: PlanLoopRuntimeState;
  loopGuardRuntimeState: AgentLoopGuardRuntimeState;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId" | "turnContext">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTurnFailedEvent: (message: string) => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
  activateExecuteRecovery: ActivateExecuteRecovery;
  activateChatFinalSynthesis: ActivateChatFinalSynthesis;
  continueApprovedPlanWithStrategySwitch: ApprovedPlanNoProgressRecoveryAction;
  pauseApprovedPlanNoProgressLoop: ApprovedPlanNoProgressAction;
  setPlanRuntimePhase: SetPlanRuntimePhase;
  pauseForReviewablePlanArtifact: (
    trigger: string,
    runtimeStateOverride?: Pick<PlanLoopRuntimeState, "planArtifactQualityRejected">,
  ) => Promise<"not_reviewable" | "stopped" | "approved_continue">;
}): Promise<ToolResultRecoveryPhaseResult> {
  let planRuntimeState = input.planRuntimeState;
  let loopGuardRuntimeState = input.loopGuardRuntimeState;
  let executeRecoveryState = input.executeRecoveryState;
  let recoveryPromptState = input.recoveryPromptState;
  let approvedPlanRecoveryState = input.approvedPlanRecoveryState;
  let completionAudit: ApprovedPlanCompletionAudit | undefined;
  const activateExecuteRecoveryAndSync: ActivateExecuteRecovery = (mode, reason, context) => {
    // The callback updates the outer loop immediately. Mirror the returned
    // state locally so this phase cannot fold an older `normal` state back over
    // the activation when it returns.
    executeRecoveryState = input.activateExecuteRecovery(mode, reason, context);
    return executeRecoveryState;
  };
  const setPlanRuntimePhaseAndSync: SetPlanRuntimePhase = (
    phase,
    reason,
    status,
    qualitySnapshot,
  ) => {
    input.setPlanRuntimePhase(phase, reason, status, qualitySnapshot);
    planRuntimeState = applyPlanRuntimePhase({
      ...planRuntimeState,
      ...(qualitySnapshot?.qualityRejectCount != null
        ? { planQualityRejectCount: qualitySnapshot.qualityRejectCount }
        : {}),
      ...(qualitySnapshot?.missingSections
        ? { planLastMissingSections: [...qualitySnapshot.missingSections] }
        : {}),
    }, { phase, reason }).state;
  };

  const ptyObservationDeferral = resolvePtyObservationPolicyDeferral(input.results);
  if (executeRecoveryState.mode === "normal" && ptyObservationDeferral) {
    // browser_evaluate was deferred before execution because the foreground
    // server has no ready evidence for its current PTY generation. Turn that
    // structured policy outcome into an active recovery transaction before
    // completion/no-progress gates run. The next iteration can then derive an
    // observe_pty-only surface from the retained dev-server ledger; once that
    // same generation is ready, the same contract derives browser-only.
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "validation_only",
      "browser_validation_deferred_for_pty_observation",
      {
        requestedUrl: ptyObservationDeferral.requestedUrl,
        nextCapability: "observe_pty",
      },
    );
    logAgentEvent("execute_recovery_activated_from_pty_observation_deferral", {
      iteration: input.iteration,
      requestedUrl: ptyObservationDeferral.requestedUrl,
      nextCapability: "observe_pty",
      executeRecoveryMode: executeRecoveryState.mode,
      executeRecoveryAttempts: executeRecoveryState.attempts,
    });
  }

  const planQualityRecovery = handlePlanQualityRecoveryAfterToolResults({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    iteration: input.iteration,
    results: input.results,
    ...planRuntimeState,
    recentPlanToolActivity: input.recentPlanToolActivity,
    attemptedPlanWriteTargets: input.attemptedPlanWriteTargets,
    latestUserPromptText: input.latestUserPromptText,
    setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
  });
  planRuntimeState = applyPlanQualityRuntimeState(
    planRuntimeState,
    planQualityRecovery,
  );
  const pendingPlanRuntimeRecoveryPrompt = planQualityRecovery.pendingPlanRuntimeRecoveryPrompt;
  const approvedPlanScopeBlockedTargets = getApprovedPlanScopeBlockedTargets(input.results);

  // Keep the reviewed mutation boundary intact without turning every omitted
  // implementation detail into a user checkpoint. A blocked helper/test-file
  // write can usually recover through existing tests, an inline command, or a
  // temporary path; only a genuinely necessary source expansion needs a new
  // reviewed revision.
  if (
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved() &&
    approvedPlanScopeBlockedTargets.length > 0
  ) {
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: input.results,
      toolArgsByCallId: input.toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    const plannedTargets = Array.from(new Set(
      input.callbacks.getPlanTasks().flatMap((task) =>
        (task.evidence || [])
          .filter((evidence) => evidence.kind === "file" || evidence.kind === "deliverable")
          .map((evidence) => String(evidence.value || "").trim())
          .filter(Boolean),
      ),
    ));
    const language = input.callbacks.getPreferredLanguage();
    const recoveryPrompt = buildApprovedPlanScopeRecoveryPrompt({
      language: MODEL_CONTROL_LANGUAGE,
      targets: approvedPlanScopeBlockedTargets,
      plannedTargets,
    });
    logAgentEvent("approved_plan_scope_block_recovering", {
      iteration: input.iteration,
      targets: approvedPlanScopeBlockedTargets,
      plannedTargets,
      resultCount: input.results.length,
    });
    input.emitPlanExecutionProgress("running", {
      currentTask: language === "zh" ? "在已批准范围内继续" : "continuing within approved Plan scope",
      currentTool: "",
      latestEvidence: approvedPlanScopeBlockedTargets.join(", "),
      recoveryReason: "approved_plan_scope_block_recovering",
      repeatedTargets: approvedPlanScopeBlockedTargets,
      nextStep: language === "zh"
        ? "改用计划内验证方式并继续执行"
        : "use an in-scope validation method and continue execution",
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: recoveryPrompt,
    });
    return finish("continue");
  }

  // Codex-style Plan execution is runtime-owned: once every task in the
  // approved revision has fresh trusted evidence, do not spend another model
  // turn asking it to narrate or declare completion.  Persist the current tool
  // results first, then close the execution lease deterministically.
  if (input.workflowMode === "plan" && input.callbacks.getIsPlanApproved()) {
    const baseAudit = buildPlanTaskEvidenceAudit({
      tasks: input.callbacks.getPlanTasks(),
      evidenceLedger: input.callbacks.getPlanExecutionEvidenceLedger(),
      highlightNext: true,
    });
    const validationBoundary = resolveApprovedPlanValidationBoundary({
      audit: baseAudit,
      availableToolNames: input.availableToolNames,
    });
    const audit = validationBoundary === "pause_external_validation"
      ? { ...baseAudit, acceptedCompletion: true }
      : baseAudit;
    const evidenceClosureAudit = buildExecuteEvidenceClosureAudit({
      ledger: input.callbacks.getPlanExecutionEvidenceLedger(),
      validationExpected: validationBoundary !== "pause_external_validation",
    });
    if (
      audit.totalCount > 0 &&
      audit.acceptedCompletion &&
      evidenceClosureAudit.completionAllowed &&
      executeRecoveryState.mode === "normal"
    ) {
      appendToolResultsToHistory({
        callbacks: input.callbacks,
        toolFeedbackFormat: input.toolFeedbackFormat,
        results: input.results,
        toolArgsByCallId: input.toolArgsByCallId,
        iterationContext: input.iterationContext,
        emitTurnEvent: input.emitTurnEvent,
      });
      input.emitTaskOrchestratorPhase("DONE", {
        reason: "plan_evidence_complete_after_tool",
        iteration: input.iteration,
        completed: audit.completedCount,
        total: audit.totalCount,
      });
      input.emitPlanExecutionProgress("completed", {
        currentTask: "",
        currentTool: "",
        nextStep: "",
      });
      input.callbacks.onPlanStageChanged("completed");
      logAgentEvent("plan_execution_completed_from_runtime_evidence", {
        iteration: input.iteration,
        completed: audit.completedCount,
        total: audit.totalCount,
        evidenceCount: input.callbacks.getPlanExecutionEvidenceLedger().length,
        modelCompletionClaimRequired: false,
        pendingUserValidation: audit.pendingUserValidationTasks.length,
        evidenceClosureGap: evidenceClosureAudit.gap,
        activeRecoveryMode: executeRecoveryState.mode,
      });
      completionAudit = {
        completedCount: audit.completedCount,
        totalCount: audit.totalCount,
        pendingUserValidationTasks: audit.pendingUserValidationTasks,
      };
      return finish("plan_completed");
    }
  }

  const noProgressRecovery = handleNoProgressRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    recentToolActivity: input.recentToolActivity,
    recentPlanToolActivity: input.recentPlanToolActivity,
    sawExecuteOperationEvidence:
      input.evidenceRuntimeState.sawExecuteOperationEvidence,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    repairExecutionRequestInChat: input.repairExecutionRequestInChat,
    latestUserPromptText: input.latestUserPromptText,
    isUnapprovedPlanReadOnlyBatch: input.isUnapprovedPlanReadOnlyBatch,
    planReadOnlyConvergenceBatches: planRuntimeState.planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools: planRuntimeState.planReadOnlyConvergenceTools,
    remainingTaskText: input.remainingTaskText,
    approvedPlanNoProgressRecoveryAttempts:
      input.approvedPlanRecoveryState.approvedPlanNoProgressRecoveryAttempts,
    tracking: getNoProgressTrackingRuntimeState(loopGuardRuntimeState),
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    activateChatFinalSynthesis: input.activateChatFinalSynthesis,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
  });
  loopGuardRuntimeState = applyNoProgressTrackingRuntimeState(
    loopGuardRuntimeState,
    noProgressRecovery.tracking,
  );
  if (noProgressRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (noProgressRecovery.status === "continue") {
    return finish("continue");
  }
  let pendingExecuteRecoveryPrompt = noProgressRecovery.pendingExecuteRecoveryPrompt;
  let pendingExecuteNoProgressPause = noProgressRecovery.pendingExecuteNoProgressPause;
  const approvedPlanNoProgressDecision = noProgressRecovery.approvedPlanNoProgressDecision;

  loopGuardRuntimeState = applyToolFailureSignatureRuntimeState(
    loopGuardRuntimeState,
    {
      results: input.results,
      toolFailureSignatures: input.toolFailureSignatures,
    },
  );

  appendToolResultsToHistory({
    callbacks: input.callbacks,
    toolFeedbackFormat: input.toolFeedbackFormat,
    results: input.results,
    toolArgsByCallId: input.toolArgsByCallId,
    iterationContext: input.iterationContext,
    emitTurnEvent: input.emitTurnEvent,
  });

  const failedFiniteValidation = input.results.find((result) => {
    if (
      result.name !== "run_command" ||
      result.internalFeedback ||
      !(result.isError || !commandResultLooksSuccessful(result.name, result.content || ""))
    ) {
      return false;
    }
    const args = input.toolArgsByCallId.get(result.toolCallId) || {};
    const command = String(args.command || args.cmd || result.target || "").trim();
    return shouldEnterFailedFiniteValidationRecovery(command);
  });
  const failedFiniteValidationCommand = failedFiniteValidation
    ? (() => {
        const args = input.toolArgsByCallId.get(failedFiniteValidation.toolCallId) || {};
        return String(
          args.command || args.cmd || failedFiniteValidation.target || "",
        ).trim();
      })()
    : "";
  const failedFiniteValidationOutcome = failedFiniteValidation
    ? classifyFailedFiniteValidationOutcome({
        result: failedFiniteValidation.content || failedFiniteValidation.displayContent || "",
        isToolError: failedFiniteValidation.isError,
        lifecycleState: failedFiniteValidation.lifecycleState,
      })
    : null;
  const remainingPlanTasksAfterFailedFiniteValidation = failedFiniteValidation &&
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved()
    ? buildPlanTaskEvidenceAudit({
        tasks: input.callbacks.getPlanTasks(),
        evidenceLedger: input.callbacks.getPlanExecutionEvidenceLedger(),
        preserveMissing: true,
        highlightNext: true,
      }).remainingTasks
    : [];
  if (
    failedFiniteValidation &&
    failedFiniteValidationOutcome === "invocation_error" &&
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved() &&
    hasPendingPlanCommandEvidence(remainingPlanTasksAfterFailedFiniteValidation)
  ) {
    const command = failedFiniteValidationCommand;
    const recoveryPolicy = resolveFailedFiniteValidationRecoveryPolicy({
      failedCommand: command,
      tasks: remainingPlanTasksAfterFailedFiniteValidation,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "finite_validation_only",
      "failed_finite_validation_command",
      { command, target: failedFiniteValidation.target || "run_command" },
    );
    const recoveryPrompt = buildFailedFiniteValidationRecoveryPrompt({
      command,
      result: failedFiniteValidation.content || failedFiniteValidation.displayContent || "",
      ...recoveryPolicy,
    });
    logAgentEvent("approved_plan_finite_validation_recovery", {
      iteration: input.iteration,
      command,
      target: failedFiniteValidation.target || "",
      executeRecoveryAttempts: executeRecoveryState.attempts,
    });
    input.emitPlanExecutionProgress("running", {
      currentTool: "run_command",
      recoveryReason: "failed_finite_validation_command",
      nextStep: recoveryPolicy.allowAlternativeCommand
        ? input.callbacks.getPreferredLanguage() === "zh"
          ? "改用与项目运行时匹配的一次性验证命令"
          : "run a different finite validation command compatible with the project runtime"
        : input.callbacks.getPreferredLanguage() === "zh"
          ? `修正调用前提后重新运行计划要求的命令：${recoveryPolicy.requiredCommand}`
          : `correct the invocation prerequisite and rerun the required command: ${recoveryPolicy.requiredCommand}`,
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({ role: "user", content: recoveryPrompt });
    return finish("continue");
  }

  const failedValidationMatchesPendingTask =
    failedFiniteValidation &&
    failedFiniteValidationOutcome === "validation_failure" &&
    failedFiniteValidationMatchesPendingPlanEvidence({
      failedCommand: failedFiniteValidationCommand,
      tasks: remainingPlanTasksAfterFailedFiniteValidation,
    });
  if (
    failedFiniteValidation &&
    failedValidationMatchesPendingTask &&
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved()
  ) {
    // A validation that actually ran has produced a source/test/config
    // diagnostic. Command-only recovery cannot fix it. Return the next turn to
    // the normal repair surface; the failed command remains negative evidence
    // until that same concrete command succeeds.
    executeRecoveryState = clearExecuteRecoveryRuntimeState(executeRecoveryState);
    const recoveryPrompt = [
      "FINITE_VALIDATION_REPAIR_REQUIRED: The finite validation command executed, but its validation failed.",
      `Failed command: ${failedFiniteValidationCommand}`,
      "MAIN restored the normal read/mutation/validation tool surface. Inspect the structured stdout/stderr/exitCode already returned, repair the implicated source, test, or configuration, then rerun this same command.",
      "Do not substitute an unrelated successful command: this failed validation remains pending Plan evidence until the same concrete command succeeds.",
    ].join("\n");
    logAgentEvent("approved_plan_finite_validation_requires_repair", {
      iteration: input.iteration,
      command: failedFiniteValidationCommand,
      target: failedFiniteValidation.target || "",
      previousRecoveryMode: input.executeRecoveryState.mode,
      nextRecoveryMode: executeRecoveryState.mode,
    });
    input.emitPlanExecutionProgress("running", {
      currentTool: "apply_patch",
      recoveryReason: "failed_finite_validation_requires_repair",
      nextStep: input.callbacks.getPreferredLanguage() === "zh"
        ? "根据命令诊断修复源码、测试或配置，然后重新运行同一验证命令"
        : "repair the diagnosed source, test, or configuration issue, then rerun the same validation command",
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({ role: "user", content: recoveryPrompt });
    return finish("continue");
  }

  const goalCheckpoint = input.callbacks.evaluateGoalToolResultCheckpoint?.(
    input.results,
  );
  if (goalCheckpoint?.complete) {
    logAgentEvent("goal_tool_result_checkpoint_completed", {
      iteration: input.iteration,
      resultCount: input.results.length,
      evidenceCount: goalCheckpoint.evidenceCount,
      supportingEvidenceIds: goalCheckpoint.supportingEvidenceIds,
    });
    return finish("goal_completed");
  }

  const readFileRepeatLimitRecovery = handleReadFileRepeatLimitRecovery({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    recentPlanToolActivity: input.recentPlanToolActivity,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
  });
  if (readFileRepeatLimitRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (readFileRepeatLimitRecovery.status === "pending_prompt") {
    pendingExecuteRecoveryPrompt = readFileRepeatLimitRecovery.prompt;
  }

  const crossIterationReadFileRecovery = handleCrossIterationReadFileLoopRecovery({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    snapshotContextLimit: input.snapshotContextLimit,
    crossIterationFileReads: loopGuardRuntimeState.crossIterationFileReads,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    consecutiveBlockedReadFileInRecoveryCount:
      executeRecoveryState.consecutiveBlockedReadFileCount,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  executeRecoveryState = applyCrossIterationReadFileRecoveryState(executeRecoveryState, {
    mode: crossIterationReadFileRecovery.executeRecoveryMode,
    reason: crossIterationReadFileRecovery.executeRecoveryReason,
    consecutiveBlockedReadFileCount:
      crossIterationReadFileRecovery.consecutiveBlockedReadFileInRecoveryCount,
  });

  if (input.unityMcpFallbackPrompt) {
    input.callbacks.appendMessage({
      role: "user",
      content: input.unityMcpFallbackPrompt,
    });
  }

  const repeatedEditValidationRecovery = handleRepeatedEditValidationRecovery({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    availableToolNames: input.availableToolNames,
    recentToolActivity: input.recentToolActivity,
    successfulEditTargetsSinceVerification:
      loopGuardRuntimeState.successfulEditTargetsSinceVerification,
    repeatedEditValidationRecoveryAttempts:
      executeRecoveryState.repeatedEditValidationAttempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    emitPlanExecutionProgress: input.emitPlanExecutionProgress,
  });
  executeRecoveryState = setRepeatedEditValidationRecoveryAttempts(
    executeRecoveryState,
    repeatedEditValidationRecovery.repeatedEditValidationRecoveryAttempts,
  );
  if (repeatedEditValidationRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (repeatedEditValidationRecovery.status === "pending_prompt") {
    input.callbacks.appendMessage({
      role: "user",
      content: repeatedEditValidationRecovery.prompt,
    });
    return finish("continue");
  }
  if (pendingExecuteRecoveryPrompt) {
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: pendingExecuteRecoveryPrompt,
    });
    return finish("continue");
  }
  if (pendingExecuteNoProgressPause) {
    input.callbacks.onNonActionableStop(
      pendingExecuteNoProgressPause.notice,
      "no_action",
      {
        progressSignature: pendingExecuteNoProgressPause.progressSignature,
        repeatedTargets: pendingExecuteNoProgressPause.repeatedTargets,
        recoveryReason: pendingExecuteNoProgressPause.reason,
        nextStep: input.callbacks.getPreferredLanguage() === "zh"
          ? "复用已读上下文，转向写入/命令/浏览器验证，或说明真实阻塞"
          : "reuse cached context and pivot to patch/run/browser validation, or state the real blocker",
      },
    );
    input.callbacks.onStatusChange("idle");
    return finish("stopped");
  }
  if (pendingPlanRuntimeRecoveryPrompt) {
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: pendingPlanRuntimeRecoveryPrompt,
    });
    return finish("continue");
  }

  if (approvedPlanNoProgressDecision) {
    if (approvedPlanNoProgressDecision.action === "recover") {
      approvedPlanRecoveryState = input.continueApprovedPlanWithStrategySwitch(
        approvedPlanNoProgressDecision,
      );
      return finish("continue");
    }
    input.pauseApprovedPlanNoProgressLoop(approvedPlanNoProgressDecision);
    return finish("stopped");
  }

  const planReadOnlyConvergence = handlePlanReadOnlyConvergence({
    callbacks: input.callbacks,
    iteration: input.iteration,
    isUnapprovedPlanReadOnlyBatch: input.isUnapprovedPlanReadOnlyBatch,
    hasPlanDecisionOutput: input.hasPlanDecisionOutput,
    successfulReadOnlyExplorationResultCount:
      input.successfulReadOnlyExplorationResultCount,
    planReadOnlyConvergenceBatches: planRuntimeState.planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools: planRuntimeState.planReadOnlyConvergenceTools,
    usedPlanReadOnlyConvergencePrompt:
      planRuntimeState.usedPlanReadOnlyConvergencePrompt,
    planEvidenceRecoveryObjective:
      planRuntimeState.planEvidenceRecoveryObjective,
    planRuntimePhase: planRuntimeState.planRuntimePhase,
    turnInputContextSignals: input.turnInputContextSignals,
    recentPlanToolActivity: input.recentPlanToolActivity,
    lastAssistantTextForCheckpoint:
      input.evidenceRuntimeState.lastAssistantTextForCheckpoint,
    setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
  });
  planRuntimeState = applyPlanReadOnlyConvergenceRuntimeState(
    planRuntimeState,
    planReadOnlyConvergence,
  );
  if (planReadOnlyConvergence.status === "continue") {
    return finish("continue");
  }

  if (shouldPauseForReviewablePlanArtifactAfterToolResults({
    workflowMode: input.workflowMode,
    isPlanApproved: input.callbacks.getIsPlanApproved(),
    planArtifactQualityRejected: planRuntimeState.planArtifactQualityRejected,
    results: input.results,
  })) {
    const currentStage = input.callbacks.getPlanStage();
    if (isReviewablePlanStage(currentStage)) {
      const reviewResult = await input.pauseForReviewablePlanArtifact(
        "post_tool_plan_artifact_write",
        {
          // The outer loop folds this phase only after it returns. Use the
          // current batch's already-folded quality state so an accepted
          // rewrite can enter review immediately instead of seeing stale true.
          planArtifactQualityRejected: planRuntimeState.planArtifactQualityRejected,
        },
      );
      if (reviewResult === "approved_continue") return finish("continue");
      if (reviewResult === "stopped") return finish("stopped");
    } else {
      logAgentEvent("plan_artifact_write_not_reviewable_after_tool", {
        iteration: input.iteration,
        planStage: currentStage,
        targets: input.results
          .filter(isSuccessfulPlanArtifactWriteResult)
          .map((result) => result.target)
          .slice(0, 6),
      });
    }
  }

  if (
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved() &&
    input.results.some((result) => !result.isError)
  ) {
    input.callbacks.onPlanStageChanged("executing");
  }

  if (input.workflowMode === "plan" && input.callbacks.getIsPlanApproved()) {
    if (input.results.some((result) => result.isError)) {
      input.emitPlanExecutionProgress("tool_error");
    } else if (input.results.some((result) => !result.isError)) {
      input.emitPlanExecutionProgress("tool_done");
    }
  }

  const strictRepeatGuardRecovery = handleStrictRepeatGuardRecovery({
    callbacks: input.callbacks,
    workspace: input.workspace,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    effectiveToolCalls: input.effectiveToolCalls,
    recentToolCalls: loopGuardRuntimeState.recentToolCalls,
    repeatGuardRecoveredSignatures:
      loopGuardRuntimeState.repeatGuardRecoveredSignatures,
    failedToolCallCounts: loopGuardRuntimeState.failedToolCallCounts,
    recentPlanToolActivity: input.recentPlanToolActivity,
    availableToolNames: input.availableToolNames,
    toolCapabilityRegistry: input.toolCapabilityRegistry,
    toolPermissionPolicy: input.toolPermissionPolicy,
    emitTurnFailedEvent: input.emitTurnFailedEvent,
  });
  if (strictRepeatGuardRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (strictRepeatGuardRecovery.status === "continue") {
    return finish("continue");
  }

  const targetProgressLoopRecovery = handleTargetProgressLoopRecovery({
    callbacks: input.callbacks,
    workspace: input.workspace,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    results: input.results,
    effectiveToolCalls: input.effectiveToolCalls,
    recentTargetToolCalls: loopGuardRuntimeState.recentTargetToolCalls,
    targetProgressGuardRecoveredSignatures:
      loopGuardRuntimeState.targetProgressGuardRecoveredSignatures,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  if (targetProgressLoopRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (targetProgressLoopRecovery.status === "continue") {
    return finish("continue");
  }

  const executeConvergencePrompt = handleExecuteConvergencePrompt({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    effectiveMaxIterations: input.effectiveMaxIterations,
    usedExecuteConvergencePrompt: recoveryPromptState.usedExecuteConvergencePrompt,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryMode: executeRecoveryState.mode,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  recoveryPromptState = applyExecuteConvergencePromptState(
    recoveryPromptState,
    executeConvergencePrompt,
  );

  logAgentEvent("post_tool_result_continuation", {
    stage: "loop_continue",
    iteration: input.iteration,
    nextIteration: input.iteration + 1,
    pendingExecuteRecovery: !!pendingExecuteRecoveryPrompt,
    pendingPlanRecovery: !!pendingPlanRuntimeRecoveryPrompt,
    usedExecuteConvergencePrompt: recoveryPromptState.usedExecuteConvergencePrompt,
    repeatedEditTargets: Array.from(
      loopGuardRuntimeState.successfulEditTargetsSinceVerification.entries(),
    ).slice(-6),
    runtimeIntent: input.runtimeIntent,
    workflowMode: input.workflowMode,
    planApproved: input.callbacks.getIsPlanApproved(),
  });

  return finish("completed");

  function finish(
    status: ToolResultRecoveryPhaseResult["status"],
  ): ToolResultRecoveryPhaseResult {
    return {
      status,
      planRuntimeState,
      loopGuardRuntimeState,
      executeRecoveryState,
      recoveryPromptState,
      approvedPlanRecoveryState,
      ...(completionAudit ? { completionAudit } : {}),
    };
  }
}
