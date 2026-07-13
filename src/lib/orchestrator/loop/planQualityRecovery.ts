import {
  buildPlanAutoScaffoldPrompt,
  buildPlanClosureEvidenceRecoveryPrompt,
  buildPlanEvidenceRecoveryBlockedPrompt,
  buildPlanEvidenceRecoveryClosurePrompt,
  buildPlanPostConvergenceToolRedirectPrompt,
} from "../../orchestrator/planOrchestration";
import {
  assessPlanClosureEvidence,
  isPlanEvidenceBundleReady,
} from "../../planEvidence";
import {
  MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES,
  MAX_PLAN_EVIDENCE_RECOVERY_PASSES,
} from "../../planRuntime";
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
  planEvidenceNoProgressPasses: number;
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
  planEvidenceNoProgressPasses?: number;
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

const PLAN_EVIDENCE_NO_PROGRESS_RESULT_RE =
  /Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT|FILE_UNCHANGED_STUB|already called with identical arguments/i;

function evidenceRecoveryResultProvidesNewEvidence(result: ToolExecutionResult): boolean {
  if (result.isError) return false;
  return !PLAN_EVIDENCE_NO_PROGRESS_RESULT_RE.test(
    `${result.displayContent || ""}\n${result.content || ""}`,
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
  let planEvidenceNoProgressPasses = input.planEvidenceNoProgressPasses ?? 0;
  let planArtifactQualityRejected = input.planArtifactQualityRejected === true;
  let pendingPlanRuntimeRecoveryPrompt: string | null = null;
  const hasOutstandingEvidenceRecoveryRead =
    planClosureEvidenceRecoveryIssued &&
    input.evidenceRecoveryResults.some((result) =>
      !result.internalFeedback && PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
    );
  // Tool-result reconciliation may advance needs_evidence -> drafting as soon
  // as a new bundle becomes closure-ready. The outstanding recovery request
  // still belongs to that read batch and must be consumed here; otherwise the
  // next uncovered facet is incorrectly suppressed as a duplicate request.
  const wasPlanEvidenceRecoveryPhase =
    String(planRuntimePhase) === "needs_evidence" || hasOutstandingEvidenceRecoveryRead;
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
    planEvidenceNoProgressPasses,
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

    const qualityClosureEvidence = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
    );
    const hasQualityClosureEvidence = isPlanEvidenceBundleReady(
      qualityClosureEvidence.evidenceBundle,
    );
    const closureEvidenceAssessment = assessPlanClosureEvidence(
      qualityClosureEvidence.evidenceBundle,
    );
    const hasStructuredQualityClosureEvidence = qualityClosureEvidence.evidenceRecords.length > 0;
    const closureGapNeedsTargetedEvidence =
      latestQualityResult.recoveryAction !== "ask_user" &&
      hasQualityClosureEvidence &&
      hasStructuredQualityClosureEvidence &&
      !closureEvidenceAssessment.ready;
    const shouldRequestTargetedEvidenceAfterQualityGate =
      (
        latestQualityResult.recoveryAction === "targeted_evidence" ||
        closureGapNeedsTargetedEvidence
      ) &&
      planQualityRejectCount >= 1 &&
      hasQualityClosureEvidence &&
      hasStructuredQualityClosureEvidence &&
      !planClosureEvidenceRecoveryIssued &&
      planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES;
    const effectiveRecoveryAction = shouldRequestTargetedEvidenceAfterQualityGate
      ? "targeted_evidence"
      : latestQualityResult.recoveryAction;
    const deterministicEvidenceMaterializationCandidate =
      latestQualityResult.source === "visible_candidate" &&
      latestQualityResult.recoveryAction !== "ask_user" &&
      closureEvidenceAssessment.ready &&
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
      requestedRecoveryAction: latestQualityResult.recoveryAction || "",
      effectiveRecoveryAction,
      hasGroundedEvidence: hasQualityClosureEvidence,
      hasStructuredEvidence: hasStructuredQualityClosureEvidence,
      closureEvidenceReady: closureEvidenceAssessment.ready,
      closureEvidenceReason: closureEvidenceAssessment.reason,
      objectiveTargetMatches: closureEvidenceAssessment.objectiveTargetMatches,
      defectSignalMatches: closureEvidenceAssessment.defectSignalMatches,
      contractMismatchMatches: closureEvidenceAssessment.contractMismatchMatches,
      contractMismatchKinds: closureEvidenceAssessment.contractMismatchKinds,
      unresolvedContractKinds: closureEvidenceAssessment.unresolvedContractKinds,
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
      planClosureEvidenceRecoveryIssued = true;
      setQualityPhase(
        "needs_evidence",
        closureEvidenceAssessment.ready
          ? "quality gate needs model-authored plan evidence"
          : closureEvidenceAssessment.reason,
      );
      pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
        callbacks.getPreferredLanguage(),
        planLastQualityGateReason || "quality gate rejected plan draft",
        latestUserPromptText,
        {
          unresolvedContractKinds: closureEvidenceAssessment.unresolvedContractKinds,
          confirmedChangeTargets: qualityClosureEvidence.evidenceBundle.changeTargets,
        },
      );
    } else if (
      planClosureEvidenceRecoveryIssued &&
      !closureEvidenceAssessment.ready &&
      planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES
    ) {
      setQualityPhase("needs_evidence", closureEvidenceAssessment.reason);
    } else if (
      latestQualityResult.recoveryAction === "targeted_evidence" &&
      planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES
    ) {
      setQualityPhase("needs_evidence", planLastQualityGateReason);
    } else if (
      latestQualityResult.recoveryAction === "auto_scaffold" ||
      planQualityRejectCount >= 2 ||
      (
        latestQualityResult.recoveryAction === "targeted_evidence" &&
        planEvidenceRecoveryPasses >= MAX_PLAN_EVIDENCE_RECOVERY_PASSES
      )
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
    // A completed read consumes the outstanding recovery request. A later,
    // still-uncovered facet may use the next bounded pass; without a read,
    // the flag remains set and duplicate prompts stay suppressed.
    planClosureEvidenceRecoveryIssued = false;
    const successfulEvidenceResults = evidenceRecoveryBatchResults.filter(
      evidenceRecoveryResultProvidesNewEvidence,
    );
    const hasSuccessfulEvidence = successfulEvidenceResults.length > 0;
    if (hasSuccessfulEvidence) {
      planEvidenceRecoveryPasses += 1;
      planEvidenceNoProgressPasses = 0;
      const recoveredClosureInput = collectPlanClosureMaterializationInput(
        callbacks,
        recentPlanToolActivity,
        attemptedPlanWriteTargets,
        latestUserPromptText,
      );
      const recoveredClosureAssessment = assessPlanClosureEvidence(
        recoveredClosureInput.evidenceBundle,
      );
      const recoveryBudgetRemaining =
        planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES;
      logAgentEvent("plan_evidence_recovery_assessed", {
        iteration,
        recoveryPass: planEvidenceRecoveryPasses,
        maxRecoveryPasses: MAX_PLAN_EVIDENCE_RECOVERY_PASSES,
        closureReady: recoveredClosureAssessment.ready,
        closureReason: recoveredClosureAssessment.reason,
        objectiveTargetMatches: recoveredClosureAssessment.objectiveTargetMatches,
        defectSignalMatches: recoveredClosureAssessment.defectSignalMatches,
        contractMismatchMatches: recoveredClosureAssessment.contractMismatchMatches,
        contractMismatchKinds: recoveredClosureAssessment.contractMismatchKinds,
        unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
        recoveryBudgetRemaining,
        semanticFacts: recoveredClosureInput.evidenceBundle.facts.length,
        changeTargets: recoveredClosureInput.evidenceBundle.changeTargets.length,
      });
      if (!recoveredClosureAssessment.ready && recoveryBudgetRemaining) {
        planClosureEvidenceRecoveryIssued = true;
        setQualityPhase("needs_evidence", recoveredClosureAssessment.reason);
        pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
          callbacks.getPreferredLanguage(),
          recoveredClosureAssessment.reason,
          latestUserPromptText,
          {
            unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
            confirmedChangeTargets: recoveredClosureInput.evidenceBundle.changeTargets,
          },
        );
      } else if (recoveredClosureAssessment.ready) {
        setQualityPhase(
          "drafting",
          "evidence recovery complete",
        );
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryClosurePrompt({
          language: callbacks.getPreferredLanguage(),
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      } else {
        setQualityPhase("blocked", "evidence recovery budget exhausted", "failed");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryBlockedPrompt({
          language: callbacks.getPreferredLanguage(),
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: recoveredClosureAssessment.reason,
          missingSections: planLastMissingSections,
          requireResolvedEvidence: true,
        });
      }
    } else if (evidenceRecoveryBatchResults.some((result) => !result.isError)) {
      planEvidenceNoProgressPasses += 1;
      const recoveredClosureInput = collectPlanClosureMaterializationInput(
        callbacks,
        recentPlanToolActivity,
        attemptedPlanWriteTargets,
        latestUserPromptText,
      );
      const recoveredClosureAssessment = assessPlanClosureEvidence(
        recoveredClosureInput.evidenceBundle,
      );
      const avoidTargets = [...new Set(
        evidenceRecoveryBatchResults.map((result) => String(result.target || "").trim()).filter(Boolean),
      )];
      const canRetryWithoutProgress =
        planEvidenceNoProgressPasses < MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES &&
        planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES;
      logAgentEvent("plan_evidence_recovery_no_progress", {
        iteration,
        noProgressPass: planEvidenceNoProgressPasses,
        maxNoProgressPasses: MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES,
        evidenceRecoveryPasses: planEvidenceRecoveryPasses,
        closureReason: recoveredClosureAssessment.reason,
        unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
        repeatedTargets: avoidTargets,
        canRetry: canRetryWithoutProgress,
      });
      if (canRetryWithoutProgress) {
        planClosureEvidenceRecoveryIssued = true;
        setQualityPhase("needs_evidence", recoveredClosureAssessment.reason);
        pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
          callbacks.getPreferredLanguage(),
          recoveredClosureAssessment.reason,
          latestUserPromptText,
          {
            unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
            confirmedChangeTargets: recoveredClosureInput.evidenceBundle.changeTargets,
            avoidTargets,
          },
        );
      } else {
        setQualityPhase("blocked", "evidence recovery repeated without progress", "failed");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryBlockedPrompt({
          language: callbacks.getPreferredLanguage(),
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: recoveredClosureAssessment.reason,
          missingSections: planLastMissingSections,
          requireResolvedEvidence: true,
        });
      }
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
        input.latestUserPromptText,
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
