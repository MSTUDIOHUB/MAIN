import {
  buildPlanAutoScaffoldPrompt,
  buildPlanClosureEvidenceRecoveryPrompt,
  buildPlanEvidenceRecoveryBlockedPrompt,
  buildPlanEvidenceRecoveryClosurePrompt,
  buildPlanPostConvergenceToolRedirectPrompt,
} from "../../orchestrator/planOrchestration";
import { isPlanEvidenceBundleReady } from "../../planEvidence";
import { MAX_PLAN_EVIDENCE_RECOVERY_PASSES } from "../../planRuntime";
import {
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
  collectPlanClosureMaterializationInput,
  isSuccessfulPlanArtifactWriteResult,
  logAgentEvent,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  classifyPlanArtifactQualityResult,
  type PlanArtifactRecoveryAction,
  type PlanRuntimePhase,
} from "../../workflowModels";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import type { PlanRuntimePhaseQualitySnapshot } from "./planRuntimeState";

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

export type PlanQualityRejectionSource = "visible_candidate" | "persisted_artifact";

export type PlanQualityRejection = {
  source: PlanQualityRejectionSource;
  qualityGateReason: string;
  recoveryAction: PlanArtifactRecoveryAction;
  missingSections: string[];
};

type PlanQualityRecoveryInput = {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  iteration: number;
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
    qualitySnapshot?: PlanRuntimePhaseQualitySnapshot,
  ) => void;
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

function handlePlanQualityRejections(input: PlanQualityRecoveryInput & {
  rejections: PlanQualityRejection[];
  acceptedPersistedArtifact: boolean;
  evidenceRecoveryResults: ToolExecutionResult[];
}): PlanQualityRecoveryResult {
  const {
    callbacks,
    workflowMode,
    iteration,
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
  const setQualityPhase = (
    phase: PlanRuntimePhase,
    reason?: string,
    status?: "pending" | "running" | "done" | "failed",
  ) => setPlanRuntimePhase(phase, reason, status, {
    qualityRejectCount: planQualityRejectCount,
    missingSections: planLastMissingSections,
  });

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

  if (input.rejections.length > 0) {
    if (input.rejections.some((rejection) => rejection.source === "persisted_artifact")) {
      planArtifactQualityRejected = true;
    }
    planQualityRejectCount += input.rejections.length;
    const latestQualityResult = input.rejections[input.rejections.length - 1];
    planLastQualityGateReason = latestQualityResult.qualityGateReason || "quality_gate";
    planLastMissingSections = latestQualityResult.missingSections || [];
    logAgentEvent("plan_quality_recovery_action", {
      iteration,
      source: latestQualityResult.source,
      recoveryAction: latestQualityResult.recoveryAction,
      qualityRejectCount: planQualityRejectCount,
      qualityGateReason: planLastQualityGateReason,
      missingSections: planLastMissingSections,
      evidenceRecoveryPasses: planEvidenceRecoveryPasses,
    });

    if (latestQualityResult.recoveryAction === "targeted_evidence" && planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES) {
      setQualityPhase("needs_evidence", planLastQualityGateReason);
    } else if (
      latestQualityResult.recoveryAction === "auto_scaffold" ||
      planQualityRejectCount >= 2 ||
      (latestQualityResult.recoveryAction === "targeted_evidence" && planEvidenceRecoveryPasses >= MAX_PLAN_EVIDENCE_RECOVERY_PASSES)
    ) {
      if (!planAutoScaffoldPromptIssued) {
        planAutoScaffoldPromptIssued = true;
        setQualityPhase("needs_rewrite", "auto scaffold after quality gate");
        pendingPlanRuntimeRecoveryPrompt = buildPlanAutoScaffoldPrompt({
          language: callbacks.getPreferredLanguage(),
          latestUserPromptText,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      } else {
        setQualityPhase("needs_rewrite", planLastQualityGateReason);
      }
    } else {
      setQualityPhase("needs_rewrite", planLastQualityGateReason);
    }

    const qualityClosureEvidence = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
    );
    const hasQualityClosureEvidence = isPlanEvidenceBundleReady(
      qualityClosureEvidence.evidenceBundle,
    );
    const hasStructuredQualityClosureEvidence = qualityClosureEvidence.evidenceRecords.length > 0;
    const shouldRequestTargetedEvidenceAfterQualityGate =
      latestQualityResult.recoveryAction === "targeted_evidence" &&
      planQualityRejectCount >= 1 &&
      hasQualityClosureEvidence &&
      hasStructuredQualityClosureEvidence &&
      !planClosureEvidenceRecoveryIssued &&
      planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES;
    const deterministicEvidenceMaterializationCandidate =
      latestQualityResult.source === "visible_candidate" &&
      latestQualityResult.recoveryAction !== "ask_user" &&
      (
        planQualityRejectCount >= 2 ||
        /excessive_plan_code_dump|insufficient_actionable_plan_signals|missing_plan_required_sections/i.test(
          planLastQualityGateReason,
        )
      );
    logAgentEvent("plan_quality_gate_recovery_decision", {
      iteration,
      source: latestQualityResult.source,
      qualityGateReason: planLastQualityGateReason,
      qualityRejectCount: planQualityRejectCount,
      recoveryAction: latestQualityResult.recoveryAction || "",
      hasGroundedEvidence: hasQualityClosureEvidence,
      hasStructuredEvidence: hasStructuredQualityClosureEvidence,
      deterministicEvidenceMaterializationCandidate,
      targetedEvidenceRecovery: shouldRequestTargetedEvidenceAfterQualityGate,
      sanitizedEvidenceCount: qualityClosureEvidence.evidence.length,
      structuredEvidenceCount: qualityClosureEvidence.evidenceRecords.length,
      sanitizedFileCount: qualityClosureEvidence.files.length,
      sanitizerDropped: qualityClosureEvidence.sanitizer.dropped,
      sanitizerDropReasons: qualityClosureEvidence.sanitizer.dropReasons,
      evidenceBundleId: qualityClosureEvidence.evidenceBundle.bundleId,
      evidenceBundleHash: qualityClosureEvidence.evidenceBundle.hash,
      semanticFacts: qualityClosureEvidence.evidenceBundle.facts.length,
      changeTargets: qualityClosureEvidence.evidenceBundle.changeTargets.length,
    });
    if (shouldRequestTargetedEvidenceAfterQualityGate) {
      pendingPlanRuntimeRecoveryPrompt = null;
      planClosureEvidenceRecoveryIssued = true;
      setQualityPhase("needs_evidence", "quality gate needs model-authored plan evidence");
      pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
        callbacks.getPreferredLanguage(),
        planLastQualityGateReason || "quality gate rejected plan draft",
      );
    }
  } else if (input.acceptedPersistedArtifact) {
    // A rejected artifact remains non-reviewable across model iterations. Only
    // a later plan-artifact mutation that completes without quality feedback
    // proves that the persisted artifact has passed the gate.
    planArtifactQualityRejected = false;
    planLastQualityGateReason = "";
    planLastMissingSections = [];
  }

  const evidenceRecoveryBatchResults = wasPlanEvidenceRecoveryPhase
    ? input.evidenceRecoveryResults.filter((result) =>
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
      setQualityPhase("drafting", "evidence recovery complete");
      pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryClosurePrompt({
        language: callbacks.getPreferredLanguage(),
        recentToolActivity: recentPlanToolActivity,
        qualityGateReason: planLastQualityGateReason,
        missingSections: planLastMissingSections,
      });
    } else {
      setQualityPhase("blocked", "evidence recovery failed", "failed");
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

export function handlePlanQualityRecoveryAfterToolResults(
  input: PlanQualityRecoveryInput & { results: ToolExecutionResult[] },
): PlanQualityRecoveryResult {
  const qualityResults = input.results.filter(isPlanArtifactQualityRejectionResult);
  return handlePlanQualityRejections({
    ...input,
    rejections: qualityResults.map((result) => ({
      source: "persisted_artifact" as const,
      qualityGateReason: result.qualityGateReason || "quality_gate",
      recoveryAction: result.planRecoveryAction || "rewrite",
      missingSections: result.missingPlanSections || [],
    })),
    acceptedPersistedArtifact:
      qualityResults.length === 0 && input.results.some(isSuccessfulPlanArtifactWriteResult),
    evidenceRecoveryResults: input.results,
  });
}

export function handlePlanQualityRecoveryAfterVisibleMaterialization(
  input: PlanQualityRecoveryInput & {
    quality: ReturnType<typeof classifyPlanArtifactQualityResult>;
  },
): PlanQualityRecoveryResult {
  const quality = input.quality.ok
    ? classifyPlanArtifactQualityResult({ ok: false, reason: "quality_gate" })
    : input.quality;
  const recoveryAction = quality.recoveryAction || "rewrite";
  const result = handlePlanQualityRejections({
    ...input,
    rejections: [{
      source: "visible_candidate",
      qualityGateReason: quality.reason || "quality_gate",
      recoveryAction,
      missingSections: quality.missingSections || [],
    }],
    acceptedPersistedArtifact: false,
    evidenceRecoveryResults: [],
  });

  // Tool-written rejections are already visible to the model as tool
  // feedback. A visible candidate has no such channel, so the first rejection
  // needs one explicit recovery prompt. The second rejection is handled by the
  // shared auto-scaffold branch; a later failure is intentionally left without
  // another prompt so the caller can stop instead of looping forever.
  if (result.pendingPlanRuntimeRecoveryPrompt == null && result.planQualityRejectCount === 1) {
    if (
      recoveryAction === "targeted_evidence" &&
      result.planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES
    ) {
      result.planClosureEvidenceRecoveryIssued = true;
      result.pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
        input.callbacks.getPreferredLanguage(),
        result.planLastQualityGateReason,
      );
    } else if (recoveryAction === "ask_user") {
      result.pendingPlanRuntimeRecoveryPrompt = input.callbacks.getPreferredLanguage() === "zh"
        ? "PLAN_NEEDS_USER_DECISION: 当前草稿包含一个真实阻塞选择。不要继续读文件或猜测默认值；请用 `<user_options>` 向用户给出 2-4 个互斥选项，然后停止等待。"
        : "PLAN_NEEDS_USER_DECISION: The draft contains a real blocking choice. Do not read more files or guess a default; present 2-4 mutually exclusive `<user_options>` and stop for the user.";
    } else {
      result.pendingPlanRuntimeRecoveryPrompt = buildPlanPostConvergenceToolRedirectPrompt({
        language: input.callbacks.getPreferredLanguage(),
        toolNames: [],
        phase: "needs_rewrite",
        qualityGateReason: result.planLastQualityGateReason,
        missingSections: result.planLastMissingSections,
        rejectCount: result.planQualityRejectCount,
      });
    }
  }

  logAgentEvent("plan_visible_quality_recovery_decision", {
    iteration: input.iteration,
    qualityGateReason: result.planLastQualityGateReason,
    recoveryAction,
    qualityRejectCount: result.planQualityRejectCount,
    artifactQualityRejected: result.planArtifactQualityRejected,
    recoveryPromptIssued: result.pendingPlanRuntimeRecoveryPrompt != null,
  });
  return result;
}
