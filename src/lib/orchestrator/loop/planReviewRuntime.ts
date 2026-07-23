import {
  buildPlanReviewReadyMessage,
  collectPlanClosureMaterializationInput,
  compactDiagnosticText,
  isReviewablePlanStage,
  logAgentEvent,
  shouldAttemptPlanClosureGuard,
} from "../../orchestrator";
import { resolvePlanClosureArtifactKind } from "../../orchestrator/planOrchestration";
import { composeReviewablePlanFromEvidence } from "../../planMaterialization";
import { assessPlanExecutableValidation } from "../../planExecutableValidation";
import {
  buildTypedPlanApprovalIdentity,
  resolveTypedPlanReviewAuthority,
  type TypedPlanReviewAuthorityResolution,
} from "../../planApprovalIdentity";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  deriveRuntimePlanTasksFromArtifacts,
  type PlanRuntimePhase,
} from "../../workflowModels";
import { derivePlanTasksFromCandidate } from "../../planContract";
import type { OrchestratorCallbacks } from "../types";
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
      rejectedVisibleCandidate?: boolean;
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
  setPlanRuntimePhase: SetPlanRuntimePhase;
  prepareReviewablePlanArtifact?: () => Promise<{
    ok: boolean;
    repaired: boolean;
    reason?: string;
  }>;
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
    setPlanRuntimePhase,
    prepareReviewablePlanArtifact,
  } = input;

  const resolveReviewAuthority = (): TypedPlanReviewAuthorityResolution =>
    resolveTypedPlanReviewAuthority(callbacks.getPlanArtifacts?.() || []);

  const authorityFailureDetail = (
    resolution: Extract<TypedPlanReviewAuthorityResolution, { ok: false }>,
  ) => ({
    path: resolution.path || ".MAIN/plans/plan.md",
    reason: resolution.reason.startsWith("primary_plan_integrity:")
      ? resolution.reason.slice("primary_plan_integrity:".length)
      : resolution.reason,
  });

  const blockReviewForCandidateIntegrity = (
    trigger: string,
    stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>,
    failure: { path: string; reason: string },
  ): PlanReviewPauseResult => {
    const state = getPlanRuntimeState();
    setPlanRuntimeState({
      ...state,
      planRuntimePhase: "needs_rewrite",
      planQualityRejectCount: state.planQualityRejectCount + 1,
      planLastQualityGateReason: failure.reason,
      planArtifactQualityRejected: true,
    });
    setPlanRuntimePhase("needs_rewrite", failure.reason, "failed");
    logAgentEvent("plan_review_blocked_typed_contract", {
      trigger,
      iteration: getIteration(),
      planStage: stage,
      path: failure.path,
      reason: failure.reason,
    });
    return "not_reviewable";
  };

  const waitForPlanApprovalIfNeeded = async (): Promise<boolean> => {
    if (workflowMode !== "plan") return true;
    if (callbacks.getIsPlanApproved()) {
      const authority = resolveReviewAuthority();
      if (authority.ok) return true;
      const failure = authorityFailureDetail(authority);
      callbacks.onPlanApprovalInvalidated?.(`typed_plan_review_authority:${authority.reason}`);
      logAgentEvent("plan_approval_readiness_blocked_typed_authority", failure);
      return false;
    }
    const authority = resolveReviewAuthority();
    if (!authority.ok) {
      logAgentEvent("plan_review_wait_blocked_typed_authority", {
        ...authorityFailureDetail(authority),
      });
      return false;
    }
    const reviewIdentity = buildTypedPlanApprovalIdentity([authority.artifact]);
    if (!reviewIdentity) return false;
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
          const currentAuthority = resolveReviewAuthority();
          if (currentAuthority.ok) {
            const currentIdentity = buildTypedPlanApprovalIdentity([currentAuthority.artifact]);
            if (
              currentIdentity?.revision === reviewIdentity.revision &&
              currentIdentity.artifactHash === reviewIdentity.artifactHash
            ) {
              resolve(true);
              return;
            }
            callbacks.onPlanApprovalInvalidated?.("typed_plan_review_identity_changed");
            logAgentEvent("plan_approval_readiness_blocked_identity_changed", {
              expectedRevision: reviewIdentity.revision,
              expectedArtifactHash: reviewIdentity.artifactHash,
              currentRevision: currentIdentity?.revision ?? null,
              currentArtifactHash: currentIdentity?.artifactHash ?? null,
            });
            resolve(false);
            return;
          }
          const failure = authorityFailureDetail(currentAuthority);
          callbacks.onPlanApprovalInvalidated?.(
            `typed_plan_review_authority:${currentAuthority.reason}`,
          );
          logAgentEvent("plan_approval_readiness_blocked_typed_authority", failure);
          resolve(false);
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
    const initialAuthority = resolveReviewAuthority();
    if (!initialAuthority.ok) {
      if (initialAuthority.reason === "primary_plan_missing") return "not_reviewable";
      return blockReviewForCandidateIntegrity(
        trigger,
        stage,
        authorityFailureDetail(initialAuthority),
      );
    }
    if (prepareReviewablePlanArtifact) {
      const preparation = await prepareReviewablePlanArtifact();
      if (!preparation.ok) {
        const reason = preparation.reason || "executable_validation_task_missing";
        const state = getPlanRuntimeState();
        setPlanRuntimeState({
          ...state,
          planRuntimePhase: "needs_rewrite",
          planQualityRejectCount: state.planQualityRejectCount + 1,
          planLastQualityGateReason: reason,
          planArtifactQualityRejected: true,
        });
        setPlanRuntimePhase("needs_rewrite", reason, "failed");
        logAgentEvent("plan_review_blocked_execution_materialization", {
          trigger,
          iteration: getIteration(),
          planStage: stage,
          reason,
        });
        return "not_reviewable";
      }
    }
    const preparedAuthority = resolveReviewAuthority();
    if (!preparedAuthority.ok) {
      return blockReviewForCandidateIntegrity(
        trigger,
        stage,
        authorityFailureDetail(preparedAuthority),
      );
    }
    if (callbacks.getPlanArtifacts) {
      const artifacts = callbacks.getPlanArtifacts();
      const typedTasks = derivePlanTasksFromCandidate(preparedAuthority.artifact.candidate);
      const tasks = typedTasks.length > 0
        ? typedTasks
        : deriveRuntimePlanTasksFromArtifacts(artifacts, {
            language: callbacks.getPreferredLanguage(),
          });
      const executableValidation = assessPlanExecutableValidation({
        planArtifacts: artifacts,
        executionPlanTasks: tasks,
      });
      if (executableValidation.missing) {
        const reason = executableValidation.reason || "executable_validation_task_missing";
        const state = getPlanRuntimeState();
        setPlanRuntimeState({
          ...state,
          planRuntimePhase: "needs_rewrite",
          planQualityRejectCount: state.planQualityRejectCount + 1,
          planLastQualityGateReason: reason,
          planArtifactQualityRejected: true,
        });
        setPlanRuntimePhase("needs_rewrite", reason, "failed");
        logAgentEvent("plan_review_blocked_execution_materialization", {
          trigger,
          iteration: getIteration(),
          planStage: stage,
          reason,
          requiresExecutableValidation: executableValidation.requiresExecutableValidation,
          executableValidationTaskCount: executableValidation.executableValidationTaskCount,
        });
        return "not_reviewable";
      }
    }
    const reviewIdentity = buildTypedPlanApprovalIdentity(callbacks.getPlanArtifacts?.() || []);
    if (!reviewIdentity) {
      logAgentEvent("plan_review_blocked_missing_artifact", {
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
      planRevision: reviewIdentity?.revision ?? null,
      artifactHash: reviewIdentity?.artifactHash ?? null,
      artifactPaths: reviewIdentity?.artifactPaths ?? [],
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
    logAgentEvent("plan_review_run_paused", {
      trigger,
      iteration: getIteration(),
      planRevision: reviewIdentity?.revision ?? null,
      artifactHash: reviewIdentity?.artifactHash ?? null,
    });
    // Approval belongs to a fresh child run. The store validates the current
    // revision/hash and starts that run with the same logical turnId.
    return "stopped";
  };

  const tryClosePlanWithEvidence = async (
    trigger: string,
    details: {
      consecutiveEmptyResponseCount?: number;
      rejectedVisibleCandidate?: boolean;
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
    const evidenceCount = closureInput.evidenceBundle.facts.length;
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
      evidenceBundleId: closureInput.evidenceBundle.bundleId,
      evidenceBundleHash: closureInput.evidenceBundle.hash,
      changeTargets: closureInput.evidenceBundle.changeTargets.length,
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
        evidenceBundleId: closureInput.evidenceBundle.bundleId,
        evidenceBundleHash: closureInput.evidenceBundle.hash,
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
