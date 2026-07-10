import {
  buildPlanAutoScaffoldPrompt,
  buildPlanEvidenceRecoveryBlockedPrompt,
  buildPlanEvidenceRecoveryClosurePrompt,
  hasGroundedPlanClosureEvidence,
} from "../../orchestrator/planOrchestration";
import { MAX_PLAN_EVIDENCE_RECOVERY_PASSES } from "../../planRuntime";
import {
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
  collectPlanClosureMaterializationInput,
  isSuccessfulPlanArtifactWriteResult,
  logAgentEvent,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { PlanRuntimePhase } from "../../workflowModels";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import { buildPlanClosureEvidenceRecoveryPrompt } from "./planNoToolRecovery";

export type PlanQualityRecoveryResult = {
  planQualityRejectCount: number;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
  planAutoScaffoldPromptIssued: boolean;
  planClosureEvidenceRecoveryIssued: boolean;
  planEvidenceRecoveryPasses: number;
  planArtifactQualityRejected: boolean;
  pendingPlanRuntimeRecoveryPrompt: string | null;
};

function isPlanArtifactQualityRejectionResult(
  result: ToolExecutionResult,
): boolean {
  return (
    result.internalFeedback === true &&
    !!result.planRecoveryAction &&
    result.planRecoveryAction !== "accept"
  );
}

export function shouldPauseForReviewablePlanArtifactAfterToolResults(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planArtifactQualityRejected?: boolean;
  results: ToolExecutionResult[];
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved) return false;
  if (
    input.planArtifactQualityRejected === true ||
    input.results.some(isPlanArtifactQualityRejectionResult)
  ) {
    return false;
  }
  return input.results.some(isSuccessfulPlanArtifactWriteResult);
}

export function handlePlanQualityRecoveryAfterToolResults(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  iteration: number;
  results: ToolExecutionResult[];
  planRuntimePhase: PlanRuntimePhase;
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  latestUserPromptText: string;
  planQualityRejectCount: number;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
  planArtifactQualityRejected?: boolean;
  planAutoScaffoldPromptIssued: boolean;
  planClosureEvidenceRecoveryIssued: boolean;
  planEvidenceRecoveryPasses: number;
  setPlanRuntimePhase: (
    phase: PlanRuntimePhase,
    reason?: string,
    status?: "pending" | "running" | "done" | "failed",
  ) => void;
}): PlanQualityRecoveryResult {
  const {
    callbacks,
    workflowMode,
    iteration,
    results,
    planRuntimePhase,
    recentPlanToolActivity,
    attemptedPlanWriteTargets,
    latestUserPromptText,
    setPlanRuntimePhase,
  } = input;

  let planQualityRejectCount = input.planQualityRejectCount;
  let planLastQualityGateReason = input.planLastQualityGateReason;
  let planLastMissingSections = input.planLastMissingSections;
  let planAutoScaffoldPromptIssued = input.planAutoScaffoldPromptIssued;
  let planClosureEvidenceRecoveryIssued = input.planClosureEvidenceRecoveryIssued;
  let planEvidenceRecoveryPasses = input.planEvidenceRecoveryPasses;
  let planArtifactQualityRejected = input.planArtifactQualityRejected === true;
  let pendingPlanRuntimeRecoveryPrompt: string | null = null;
  const wasPlanEvidenceRecoveryPhase = String(planRuntimePhase) === "needs_evidence";

  const finish = (): PlanQualityRecoveryResult => ({
    planQualityRejectCount,
    planLastQualityGateReason,
    planLastMissingSections,
    planAutoScaffoldPromptIssued,
    planClosureEvidenceRecoveryIssued,
    planEvidenceRecoveryPasses,
    planArtifactQualityRejected,
    pendingPlanRuntimeRecoveryPrompt,
  });

  if (workflowMode !== "plan" || callbacks.getIsPlanApproved()) {
    return finish();
  }

  const planQualityRecoveryResults = results.filter(
    isPlanArtifactQualityRejectionResult,
  );
  if (planQualityRecoveryResults.length > 0) {
    planArtifactQualityRejected = true;
    planQualityRejectCount += planQualityRecoveryResults.length;
    const latestQualityResult = planQualityRecoveryResults[planQualityRecoveryResults.length - 1];
    planLastQualityGateReason = latestQualityResult.qualityGateReason || "quality_gate";
    planLastMissingSections = latestQualityResult.missingPlanSections || [];
    logAgentEvent("plan_quality_recovery_action", {
      iteration,
      recoveryAction: latestQualityResult.planRecoveryAction,
      qualityRejectCount: planQualityRejectCount,
      qualityGateReason: planLastQualityGateReason,
      missingSections: planLastMissingSections,
      evidenceRecoveryPasses: planEvidenceRecoveryPasses,
    });

    if (latestQualityResult.planRecoveryAction === "targeted_evidence" && planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES) {
      setPlanRuntimePhase("needs_evidence", planLastQualityGateReason);
    } else if (
      latestQualityResult.planRecoveryAction === "auto_scaffold" ||
      planQualityRejectCount >= 2 ||
      (latestQualityResult.planRecoveryAction === "targeted_evidence" && planEvidenceRecoveryPasses >= MAX_PLAN_EVIDENCE_RECOVERY_PASSES)
    ) {
      if (!planAutoScaffoldPromptIssued) {
        planAutoScaffoldPromptIssued = true;
        setPlanRuntimePhase("needs_rewrite", "auto scaffold after quality gate");
        pendingPlanRuntimeRecoveryPrompt = buildPlanAutoScaffoldPrompt({
          language: callbacks.getPreferredLanguage(),
          latestUserPromptText,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      } else {
        setPlanRuntimePhase("needs_rewrite", planLastQualityGateReason);
      }
    } else {
      setPlanRuntimePhase("needs_rewrite", planLastQualityGateReason);
    }

    const qualityClosureEvidence = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
    );
    const hasQualityClosureEvidence = hasGroundedPlanClosureEvidence(
      qualityClosureEvidence,
      recentPlanToolActivity,
    );
    const hasStructuredQualityClosureEvidence = qualityClosureEvidence.evidenceRecords.length > 0;
    const shouldRequestTargetedEvidenceAfterQualityGate =
      latestQualityResult.planRecoveryAction === "targeted_evidence" &&
      planQualityRejectCount >= 1 &&
      hasQualityClosureEvidence &&
      hasStructuredQualityClosureEvidence &&
      !planClosureEvidenceRecoveryIssued &&
      planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES;
    logAgentEvent("plan_quality_gate_recovery_decision", {
      iteration,
      qualityGateReason: planLastQualityGateReason,
      qualityRejectCount: planQualityRejectCount,
      recoveryAction: latestQualityResult.planRecoveryAction || "",
      hasGroundedEvidence: hasQualityClosureEvidence,
      hasStructuredEvidence: hasStructuredQualityClosureEvidence,
      deterministicClosure: false,
      fallbackPlanMaterializationDisabled: true,
      targetedEvidenceRecovery: shouldRequestTargetedEvidenceAfterQualityGate,
      sanitizedEvidenceCount: qualityClosureEvidence.evidence.length,
      structuredEvidenceCount: qualityClosureEvidence.evidenceRecords.length,
      sanitizedFileCount: qualityClosureEvidence.files.length,
      sanitizerDropped: qualityClosureEvidence.sanitizer.dropped,
      sanitizerDropReasons: qualityClosureEvidence.sanitizer.dropReasons,
    });
    if (shouldRequestTargetedEvidenceAfterQualityGate) {
      pendingPlanRuntimeRecoveryPrompt = null;
      planClosureEvidenceRecoveryIssued = true;
      setPlanRuntimePhase("needs_evidence", "quality gate needs model-authored plan evidence");
      pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
        callbacks.getPreferredLanguage(),
        planLastQualityGateReason || "quality gate rejected plan draft",
      );
    }
  } else if (results.some(isSuccessfulPlanArtifactWriteResult)) {
    // A rejected artifact remains non-reviewable across model iterations. Only
    // a later plan-artifact mutation that completes without quality feedback
    // proves that the persisted artifact has passed the gate.
    planArtifactQualityRejected = false;
  }

  const evidenceRecoveryBatchResults = wasPlanEvidenceRecoveryPhase
    ? results.filter((result) =>
        !result.internalFeedback &&
        PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
      )
    : [];
  if (
    evidenceRecoveryBatchResults.length > 0 &&
    pendingPlanRuntimeRecoveryPrompt == null
  ) {
    planEvidenceRecoveryPasses += 1;
    const hasSuccessfulEvidence = evidenceRecoveryBatchResults.some((result) => !result.isError);
    if (hasSuccessfulEvidence) {
      setPlanRuntimePhase("drafting", "evidence recovery complete");
      pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryClosurePrompt({
        language: callbacks.getPreferredLanguage(),
        recentToolActivity: recentPlanToolActivity,
        qualityGateReason: planLastQualityGateReason,
        missingSections: planLastMissingSections,
      });
    } else {
      setPlanRuntimePhase("blocked", "evidence recovery failed", "failed");
      pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryBlockedPrompt({
        language: callbacks.getPreferredLanguage(),
        recentToolActivity: recentPlanToolActivity,
        qualityGateReason: planLastQualityGateReason,
        missingSections: planLastMissingSections,
      });
    }
  }

  return finish();
}
