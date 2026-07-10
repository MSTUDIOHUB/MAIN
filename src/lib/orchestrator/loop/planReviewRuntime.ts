import {
  buildApprovedPlanContinuationPrompt,
  buildPlanReviewReadyMessage,
  collectPlanClosureMaterializationInput,
  compactDiagnosticText,
  isReviewablePlanStage,
  logAgentEvent,
  shouldAttemptPlanClosureGuard,
} from "../../orchestrator";
import { resolvePlanClosureArtifactKind } from "../../orchestrator/planOrchestration";
import { composeReviewablePlanFromEvidence } from "../../planMaterialization";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { PlanRuntimePhase } from "../../workflowModels";
import type { OrchestratorCallbacks } from "../types";
import {
  resetApprovedPlanHandoffRecoveryState,
  type ApprovedPlanRecoveryRuntimeState,
} from "./approvedPlanRecoveryRuntime";
import {
  markPlanClosurePromptIssued,
  type PlanLoopRuntimeState,
} from "./planRuntimeState";

export type PlanReviewPauseResult =
  | "not_reviewable"
  | "stopped"
  | "approved_continue";

export type PlanClosureAttemptResult =
  | "not_attempted"
  | "failed"
  | "stopped"
  | "approved_continue";

export type SetPlanRuntimePhase = (
  phase: PlanRuntimePhase,
  reason?: string,
  status?: "pending" | "running" | "done" | "failed",
) => void;

export interface PlanReviewRuntimeHandlers {
  waitForPlanApprovalIfNeeded: () => Promise<boolean>;
  pauseForReviewablePlanArtifact: (
    trigger: string,
    runtimeStateOverride?: Pick<PlanLoopRuntimeState, "planArtifactQualityRejected">,
  ) => Promise<PlanReviewPauseResult>;
  tryClosePlanWithEvidence: (
    trigger: string,
    details?: {
      consecutiveEmptyResponseCount?: number;
      rejectedVisibleChars?: number;
      toolCallCount?: number;
      replyOptionCount?: number;
    },
  ) => Promise<PlanClosureAttemptResult>;
}

export function createPlanReviewRuntimeHandlers(input: {
  callbacks: OrchestratorCallbacks;
  abortController: AbortController;
  workflowMode: "chat" | "edit" | "plan";
  latestUserPromptText: string;
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  getIteration: () => number;
  getPlanRuntimeState: () => PlanLoopRuntimeState;
  setPlanRuntimeState: (state: PlanLoopRuntimeState) => void;
  getApprovedPlanRecoveryState: () => ApprovedPlanRecoveryRuntimeState;
  setApprovedPlanRecoveryState: (state: ApprovedPlanRecoveryRuntimeState) => void;
  setPlanRuntimePhase: SetPlanRuntimePhase;
}): PlanReviewRuntimeHandlers {
  const {
    callbacks,
    abortController,
    workflowMode,
    latestUserPromptText,
    recentPlanToolActivity,
    attemptedPlanWriteTargets,
    getIteration,
    getPlanRuntimeState,
    setPlanRuntimeState,
    getApprovedPlanRecoveryState,
    setApprovedPlanRecoveryState,
    setPlanRuntimePhase,
  } = input;

  const waitForPlanApprovalIfNeeded = async (): Promise<boolean> => {
    if (workflowMode !== "plan") return true;
    if (callbacks.getIsPlanApproved()) return true;
    if (callbacks.getStatus() !== "pending_review") {
      callbacks.onStatusChange("pending_review");
    }
    return new Promise<boolean>((resolve) => {
      const checkInterval = setInterval(() => {
        if (abortController.signal.aborted) {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }
        if (callbacks.getIsPlanApproved()) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }, 300);
    });
  };

  const pauseForReviewablePlanArtifact = async (
    trigger: string,
    runtimeStateOverride?: Pick<PlanLoopRuntimeState, "planArtifactQualityRejected">,
  ): Promise<PlanReviewPauseResult> => {
    if (workflowMode !== "plan" || callbacks.getIsPlanApproved()) return "not_reviewable";
    const stage = callbacks.getPlanStage();
    if (!isReviewablePlanStage(stage)) return "not_reviewable";
    const planArtifactQualityRejected = runtimeStateOverride?.planArtifactQualityRejected ??
      getPlanRuntimeState().planArtifactQualityRejected;
    if (planArtifactQualityRejected) {
      logAgentEvent("plan_review_blocked_by_quality_rejection", {
        trigger,
        iteration: getIteration(),
        planStage: stage,
      });
      return "not_reviewable";
    }
    const language = callbacks.getPreferredLanguage();
    logAgentEvent("plan_review_ready_after_tool", {
      trigger,
      iteration: getIteration(),
      planStage: stage,
      isPlanApproved: callbacks.getIsPlanApproved(),
      statusBeforeReview: callbacks.getStatus(),
    });
    if (stage === "design") {
      logAgentEvent("plan_design_review_ready_after_tool", {
        trigger,
        iteration: getIteration(),
        planStage: stage,
        isPlanApproved: callbacks.getIsPlanApproved(),
        statusBeforeReview: callbacks.getStatus(),
      });
    }

    setPlanRuntimePhase("review_ready", "quality gate accepted", "done");
    // Acquire the review pause before rendering the final plan. The UI finalizer
    // may otherwise observe `running` and release the active abort controller,
    // making approval race into a second loop.
    if (callbacks.getStatus() !== "pending_review") {
      callbacks.onStatusChange("pending_review");
    }
    callbacks.onAssistantFinalText(buildPlanReviewReadyMessage(language, stage));
    const approved = await waitForPlanApprovalIfNeeded();
    if (!approved) {
      if (callbacks.getStatus() !== "pending_review") {
        callbacks.onStatusChange("idle");
      }
      return "stopped";
    }

    callbacks.onPlanStageChanged("executing");
    setApprovedPlanRecoveryState(
      resetApprovedPlanHandoffRecoveryState(getApprovedPlanRecoveryState()),
    );
    // Planning reads/writes are evidence for drafting, not execution history.
    // Start the approved execution phase with a fresh activity window so its
    // first model iteration can read the exact source it is about to edit.
    recentPlanToolActivity.length = 0;
    attemptedPlanWriteTargets.length = 0;
    const continuationPrompt = buildApprovedPlanContinuationPrompt(callbacks);
    callbacks.onApprovedPlanExecutionStarted?.();
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: continuationPrompt,
    });
    return "approved_continue";
  };

  const tryClosePlanWithEvidence = async (
    trigger: string,
    details: {
      consecutiveEmptyResponseCount?: number;
      rejectedVisibleChars?: number;
      toolCallCount?: number;
      replyOptionCount?: number;
    } = {},
  ): Promise<PlanClosureAttemptResult> => {
    const closureInput = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
    );
    const evidenceCount = closureInput.evidence.length;
    const currentStage = callbacks.getPlanStage();
    const hasReviewablePlanArtifacts = isReviewablePlanStage(currentStage);
    const closureKind = resolvePlanClosureArtifactKind(
      closureInput,
      currentStage,
      recentPlanToolActivity,
    );
    const targetPath = closureKind === "design" ? ".MAIN/plans/design.md" : ".MAIN/plans/plan.md";
    const planRuntimeState = getPlanRuntimeState();
    const shouldAttempt = shouldAttemptPlanClosureGuard({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      hasReviewablePlanArtifacts,
      evidenceCount,
      usedPlanRecoveryPrompt: planRuntimeState.usedPlanRecoveryPrompt,
      ...details,
    });
    if (!shouldAttempt) return "not_attempted";
    if (planRuntimeState.usedPlanClosureGuard) {
      logAgentEvent("plan_closure_artifact_rejected", {
        trigger,
        iteration: getIteration(),
        reason: "closure_prompt_already_used_fallback_disabled",
        evidenceCount,
        targetPath,
      });
      return "failed";
    }

    logAgentEvent("plan_closure_guard_start", {
      trigger,
      iteration: getIteration(),
      evidenceCount,
      structuredEvidenceCount: closureInput.evidenceRecords.length,
      fileCount: closureInput.files.length,
      constraintCount: closureInput.constraints.length,
      targetPath,
      closureKind,
      userGoalPreview: compactDiagnosticText(closureInput.userGoal, 160),
      planStage: currentStage,
    });
    if (!planRuntimeState.usedPlanClosurePrompt) {
      setPlanRuntimeState(markPlanClosurePromptIssued(planRuntimeState));
      setPlanRuntimePhase("drafting", `${closureKind} closure prompt ready`);
      const prompt = composeReviewablePlanFromEvidence({
        ...closureInput,
        kind: closureKind,
        language: callbacks.getPreferredLanguage(),
      });
      logAgentEvent("plan_closure_prompt", {
        trigger,
        iteration: getIteration(),
        evidenceCount,
        structuredEvidenceCount: closureInput.evidenceRecords.length,
        fileCount: closureInput.files.length,
        targetPath,
      });
      if (closureKind === "design") {
        logAgentEvent("plan_design_closure_prompt", {
          trigger,
          iteration: getIteration(),
          evidenceCount,
          fileCount: closureInput.files.length,
          targetPath,
        });
      }
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: prompt,
      });
      return "approved_continue";
    }

    return "failed";
  };

  return {
    waitForPlanApprovalIfNeeded,
    pauseForReviewablePlanArtifact,
    tryClosePlanWithEvidence,
  };
}
