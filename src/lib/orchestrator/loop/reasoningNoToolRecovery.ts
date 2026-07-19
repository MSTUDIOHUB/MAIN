import {
  hasPendingApprovedPlanSourceMutation,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import { assessPlanEvidenceReadiness } from "../../planReadOnlyConvergence";
import {
  buildPlanEvidenceBlockedPauseMessage,
  buildPlanTargetedEvidenceRecoveryPrompt,
  resolvePlanNoActionRecovery,
} from "../../planRuntime";
import {
  buildReasoningDominatedPauseMessage,
  buildReasoningDominatedRecoveryPrompt,
  isReasoningDominatedNoActionResult,
} from "../../orchestrator/agentRecovery";
import {
  getOriginalUserPromptForPlanFallback,
  hasPlanVisualContextGrounding,
  logAgentEvent,
} from "../../orchestrator";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import type { StreamResult } from "../../streaming";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { ExecuteRecoveryMode } from "../../executeRecoveryTools";
import type { PlanRuntimePhase } from "../../workflowModels";
import type { AgentMessage, OrchestratorCallbacks } from "../types";
import type { PlanEvidenceRecoveryObjective } from "./planRuntimeState";
import {
  applyExecuteNoToolStrategyPivot,
  isExecuteRuntimeRequiringEvidence,
  resolveExecuteNoToolStrategyAtBoundary,
} from "./executeNoToolRecovery";

type WorkflowMode = "chat" | "edit" | "plan";

type SetPlanRuntimePhase = (
  phase: PlanRuntimePhase,
  reason?: string,
  status?: "pending" | "running" | "done" | "failed",
) => void;

type ActivateExecuteRecovery = (
  mode: Exclude<ExecuteRecoveryMode, "normal">,
  reason: string,
  details?: Record<string, unknown>,
) => void;

export type ReasoningDominatedNoToolRecoveryResult = {
  status: "none" | "continue" | "stopped";
  consecutiveReasoningDominatedCount: number;
  planReasoningOnlyRecoveryPasses: number;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
};

export function handleReasoningDominatedNoToolRecovery(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  streamResult: StreamResult;
  normalizedToolCallCount: number;
  normalizedReplyOptionCount: number;
  assistantMsgId: string;
  turnInputContextSignals: TurnInputContextSignals;
  recentPlanToolActivity: PlanToolActivitySummary[];
  lastAssistantTextForCheckpoint: string | null;
  planEvidenceRecoveryPasses: number;
  planReasoningOnlyRecoveryPasses: number;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  consecutiveReasoningDominatedCount: number;
  forceXmlTools?: boolean;
  availableToolNames?: Set<string>;
  setPlanRuntimePhase: SetPlanRuntimePhase;
  activateExecuteRecovery: ActivateExecuteRecovery;
}): ReasoningDominatedNoToolRecoveryResult {
  const {
    callbacks,
    workflowMode,
    turnIntent,
    runtimeIntent,
    iteration,
    streamResult,
    normalizedToolCallCount,
    normalizedReplyOptionCount,
    assistantMsgId,
    turnInputContextSignals,
    recentPlanToolActivity,
    planEvidenceRecoveryPasses,
    setPlanRuntimePhase,
    activateExecuteRecovery,
  } = input;

  let planReasoningOnlyRecoveryPasses = input.planReasoningOnlyRecoveryPasses;
  let planEvidenceRecoveryObjective = input.planEvidenceRecoveryObjective ?? "none";
  let consecutiveReasoningDominatedCount = input.consecutiveReasoningDominatedCount;

  const finish = (
    status: ReasoningDominatedNoToolRecoveryResult["status"],
  ): ReasoningDominatedNoToolRecoveryResult => ({
    status,
    consecutiveReasoningDominatedCount,
    planReasoningOnlyRecoveryPasses,
    planEvidenceRecoveryObjective,
  });

  if (
    !isReasoningDominatedNoActionResult(streamResult) ||
    normalizedToolCallCount > 0 ||
    normalizedReplyOptionCount > 0
  ) {
    return finish("none");
  }

  if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
    const readiness = assessPlanEvidenceReadiness({
      userGoal: getOriginalUserPromptForPlanFallback(callbacks),
      userContext: turnInputContextSignals,
      recentToolActivity: recentPlanToolActivity,
      hasGroundedVisualContext: hasPlanVisualContextGrounding(
        callbacks.getMessages() as AgentMessage[],
        callbacks.getCurrentTurnId?.(),
      ),
    });
    const targetedRecoveryPasses = Math.max(
      planEvidenceRecoveryPasses,
      planReasoningOnlyRecoveryPasses,
    );
    const recoveryDecision = resolvePlanNoActionRecovery({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      reasoningOnly: true,
      evidenceReadiness: readiness.status,
      targetedRecoveryPasses,
    });
    logAgentEvent("plan_reasoning_only_recovery_decision", {
      iteration,
      action: recoveryDecision.action,
      reason: recoveryDecision.reason,
      finishReason: streamResult.finishReason || "unknown",
      evidenceReadiness: readiness.status,
      evidenceReadinessReason: readiness.reason,
      successfulTargetedReads: readiness.successfulTargetedReads,
      successfulSearches: readiness.successfulSearches,
      targetedRecoveryPasses,
      contentChars: streamResult.content.length,
      reasoningChars: String(streamResult.reasoningContent || "").length,
    });

    if (recoveryDecision.action === "targeted_evidence") {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      planReasoningOnlyRecoveryPasses += 1;
      planEvidenceRecoveryObjective = "model_draft";
      setPlanRuntimePhase("needs_evidence", readiness.reason);
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: buildPlanTargetedEvidenceRecoveryPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          reason: readiness.reason,
        }),
      });
      return finish("continue");
    }

    if (recoveryDecision.action === "pause_blocked") {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      planEvidenceRecoveryObjective = "none";
      setPlanRuntimePhase("blocked", readiness.reason, "failed");
      callbacks.onNonActionableStop(
        buildPlanEvidenceBlockedPauseMessage({
          language: callbacks.getPreferredLanguage(),
          reason: readiness.reason,
        }),
        "incomplete_plan",
        {
          recoveryReason: "plan_reasoning_only_evidence_blocked",
          nextStep: callbacks.getPreferredLanguage() === "zh"
            ? "补充一个具体缺失事实或关键选择后继续"
            : "provide the concrete missing fact or key decision, then resume",
        },
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }
  }

  consecutiveReasoningDominatedCount += 1;
  callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
  logAgentEvent(
    consecutiveReasoningDominatedCount >= 2
      ? "reasoning_dominated_pause"
      : "reasoning_dominated_recovery",
    {
      iteration,
      consecutiveReasoningDominatedCount,
      contentChars: streamResult.content.length,
      reasoningChars: String(streamResult.reasoningContent || "").length,
      workflowMode,
      turnIntent,
      planStage: callbacks.getPlanStage(),
      isPlanApproved: callbacks.getIsPlanApproved(),
    },
  );
  const reasoningCheckpointLimit = 2;
  const isExecuteRuntime = isExecuteRuntimeRequiringEvidence({
    workflowMode,
    turnIntent,
    runtimeIntent,
  });
  if (consecutiveReasoningDominatedCount >= reasoningCheckpointLimit) {
    if (isExecuteRuntime) {
      const strategyDecision = resolveExecuteNoToolStrategyAtBoundary({
        callbacks,
        consecutiveNoToolCount: consecutiveReasoningDominatedCount,
        checkpointLimit: reasoningCheckpointLimit,
        availableToolNames: input.availableToolNames,
        cause: "reasoning_dominated_no_action",
      });
      if (strategyDecision.action === "continue_with_pivot") {
        applyExecuteNoToolStrategyPivot({
          callbacks,
          decision: strategyDecision,
          forceXmlTools: input.forceXmlTools ?? Boolean(
            callbacks.shouldForceXmlForProviderCompatibility?.(),
          ),
          assistantMsgId,
          iteration,
          cause: "reasoning_dominated_no_action",
          runtimeAlreadyPrepared: true,
        });
        return finish("continue");
      }
    }
    callbacks.onNonActionableStop(
      buildReasoningDominatedPauseMessage(callbacks.getPreferredLanguage(), workflowMode),
      callbacks.getIsPlanApproved() || workflowMode === "plan"
        ? "incomplete_plan"
        : "no_output",
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  }

  const shouldActivateMutationRecovery =
    workflowMode === "edit" &&
    isMutationRuntimeIntent(runtimeIntent) &&
    (!callbacks.getIsPlanApproved() || hasPendingApprovedPlanSourceMutation(
      callbacks.getPlanTasks(),
      callbacks.getPlanExecutionEvidenceLedger(),
    ));
  if (shouldActivateMutationRecovery) {
    activateExecuteRecovery("mutation_first", "reasoning_dominated_recovery", {
      consecutiveReasoningDominatedCount,
      contentChars: streamResult.content.length,
      reasoningChars: String(streamResult.reasoningContent || "").length,
    });
  }

  callbacks.onStatusChange("running");
  callbacks.appendMessage({
    role: "user",
    content: buildReasoningDominatedRecoveryPrompt(MODEL_CONTROL_LANGUAGE, workflowMode),
  });
  return finish("continue");
}
