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
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  buildPlanTargetedEvidenceRecoveryPrompt,
  MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES,
} from "../../planRuntime";
import { isReadOnlyNoProgressDetail } from "../../executeRecoveryTools";
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
import type {
  PlanEvidenceRecoveryObjective,
  PlanRuntimePhaseQualitySnapshot,
} from "./planRuntimeState";

export type PlanQualityRecoveryResult = {
  planQualityRejectCount: number;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
  planAutoScaffoldPromptIssued: boolean;
  planClosureEvidenceRecoveryIssued: boolean;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planEvidenceRecoveryPasses: number;
  planEvidenceNoProgressPasses: number;
  planEvidenceProgressFingerprint: string;
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
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planEvidenceRecoveryPasses: number;
  planEvidenceNoProgressPasses?: number;
  planEvidenceProgressFingerprint?: string;
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

function evidenceRecoveryResultProvidesNewEvidence(result: ToolExecutionResult): boolean {
  if (result.isError) return false;
  return !isReadOnlyNoProgressDetail(result.displayContent || result.content || "");
}

type PlanEvidenceProgressState = {
  bundleHash: string;
  coverageKeys: Set<string>;
};

function parsePlanEvidenceProgressFingerprint(value: string): PlanEvidenceProgressState {
  if (!value) return { bundleHash: "", coverageKeys: new Set() };
  try {
    const parsed = JSON.parse(value) as { bundleHash?: unknown; coverageKeys?: unknown };
    return {
      bundleHash: typeof parsed.bundleHash === "string" ? parsed.bundleHash : "",
      coverageKeys: new Set(
        Array.isArray(parsed.coverageKeys)
          ? parsed.coverageKeys.filter((item): item is string => typeof item === "string" && !!item)
          : [],
      ),
    };
  } catch {
    // Old snapshots stored only a bundle hash. Treat it as the semantic
    // baseline and rebuild structured coverage from later fresh reads.
    return { bundleHash: value, coverageKeys: new Set() };
  }
}

function buildPlanEvidenceProgressFingerprint(input: PlanEvidenceProgressState): string {
  return JSON.stringify({
    bundleHash: input.bundleHash,
    // Set preserves insertion order; retain the most recent identities so a
    // newly observed window cannot be discarded merely by lexical sorting.
    coverageKeys: Array.from(input.coverageKeys).slice(-64),
  });
}

function collectFreshPlanReadCoverageKeys(results: ToolExecutionResult[]): string[] {
  return Array.from(new Set(results.flatMap((result) => {
    if (result.name !== "read_file" || result.isError) return [];
    const detail = String(result.displayContent || result.content || "");
    if (isReadOnlyNoProgressDetail(detail)) return [];
    const observation = result.readFileObservation;
    if (!observation || observation.source !== "fresh") return [];
    return [
      observation.key || [
        observation.path,
        observation.versionToken,
        observation.requestSignature,
      ].join("::"),
    ];
  })));
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
  let planEvidenceRecoveryObjective = input.planEvidenceRecoveryObjective ?? "none";
  let planEvidenceRecoveryPasses = input.planEvidenceRecoveryPasses;
  let planEvidenceNoProgressPasses = input.planEvidenceNoProgressPasses ?? 0;
  let planEvidenceProgressFingerprint = input.planEvidenceProgressFingerprint ?? "";
  let planArtifactQualityRejected = input.planArtifactQualityRejected === true;
  let pendingPlanRuntimeRecoveryPrompt: string | null = null;
  const hasOutstandingEvidenceRecoveryRead =
    planClosureEvidenceRecoveryIssued &&
    input.evidenceRecoveryResults.some((result) =>
      !result.internalFeedback && PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
    );
  const hasObjectiveRecoveryRead =
    (input.planEvidenceRecoveryObjective ?? "none") !== "none" &&
    input.evidenceRecoveryResults.some((result) =>
      !result.internalFeedback && PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
    );
  // Tool-result reconciliation may advance needs_evidence -> drafting as soon
  // as a new bundle becomes closure-ready. The outstanding recovery request
  // still belongs to that read batch and must be consumed here; otherwise the
  // next uncovered facet is incorrectly suppressed as a duplicate request.
  const wasPlanEvidenceRecoveryPhase =
    String(planRuntimePhase) === "needs_evidence" ||
    hasOutstandingEvidenceRecoveryRead ||
    hasObjectiveRecoveryRead;
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
    planEvidenceRecoveryObjective,
    planEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint,
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
      planEvidenceNoProgressPasses < MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES;
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
      const baselineFingerprint = qualityClosureEvidence.evidenceBundle.hash;
      const progressState = parsePlanEvidenceProgressFingerprint(
        planEvidenceProgressFingerprint,
      );
      if (progressState.bundleHash !== baselineFingerprint) {
        progressState.bundleHash = baselineFingerprint;
        planEvidenceProgressFingerprint = buildPlanEvidenceProgressFingerprint(progressState);
        planEvidenceNoProgressPasses = 0;
      }
      planClosureEvidenceRecoveryIssued = true;
      planEvidenceRecoveryObjective = "deterministic_closure";
      setQualityPhase(
        "needs_evidence",
        closureEvidenceAssessment.ready
          ? "quality gate needs model-authored plan evidence"
          : closureEvidenceAssessment.reason,
      );
      pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
        MODEL_CONTROL_LANGUAGE,
        planLastQualityGateReason || "quality gate rejected plan draft",
        latestUserPromptText,
        {
          unresolvedContractKinds: closureEvidenceAssessment.unresolvedContractKinds,
          confirmedChangeTargets: qualityClosureEvidence.evidenceBundle.changeTargets,
        },
      );
    } else if (
      planClosureEvidenceRecoveryIssued &&
      planEvidenceRecoveryObjective !== "none" &&
      !closureEvidenceAssessment.ready
    ) {
      // A typed recovery objective represents a real outstanding read
      // transaction. Do not replace it with a scaffold merely because another
      // weak draft arrived before the requested evidence result.
      setQualityPhase("needs_evidence", closureEvidenceAssessment.reason);
    } else if (
      latestQualityResult.recoveryAction === "auto_scaffold" ||
      planQualityRejectCount >= 2
    ) {
      if (!planAutoScaffoldPromptIssued) {
        planAutoScaffoldPromptIssued = true;
        planEvidenceRecoveryObjective = "none";
        setQualityPhase("needs_rewrite", "auto scaffold after quality gate");
        pendingPlanRuntimeRecoveryPrompt = buildPlanAutoScaffoldPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          latestUserPromptText,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      } else {
        planEvidenceRecoveryObjective = "none";
        setQualityPhase("needs_rewrite", planLastQualityGateReason);
      }
    } else if (
      planClosureEvidenceRecoveryIssued &&
      !closureEvidenceAssessment.ready
    ) {
      setQualityPhase("needs_evidence", closureEvidenceAssessment.reason);
    } else if (
      latestQualityResult.recoveryAction === "targeted_evidence"
    ) {
      setQualityPhase("needs_evidence", planLastQualityGateReason);
    } else {
      planEvidenceRecoveryObjective = "none";
      setQualityPhase("needs_rewrite", planLastQualityGateReason);
    }
  } else if (input.acceptedPersistedArtifact) {
    // A rejected artifact remains non-reviewable across model iterations. Only
    // a later plan-artifact mutation that completes without quality feedback
    // proves that the persisted artifact has passed the gate.
    planArtifactQualityRejected = false;
    planEvidenceRecoveryObjective = "none";
    planEvidenceNoProgressPasses = 0;
    planEvidenceProgressFingerprint = "";
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
    // still-uncovered facet may open another targeted transaction; without a
    // read, the flag remains set and duplicate prompts stay suppressed.
    planClosureEvidenceRecoveryIssued = false;
    const successfulEvidenceResults = evidenceRecoveryBatchResults.filter(
      evidenceRecoveryResultProvidesNewEvidence,
    );
    const hasSuccessfulEvidence = successfulEvidenceResults.length > 0;
    const recoveryObjectiveForBatch = planEvidenceRecoveryObjective;
    const recoveredModelDraftInput = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
    );
    const recoveredModelDraftReady = isPlanEvidenceBundleReady(
      recoveredModelDraftInput.evidenceBundle,
    );
    const recoveredEvidenceBundleHash = recoveredModelDraftInput.evidenceBundle.hash;
    const previousProgressState = parsePlanEvidenceProgressFingerprint(
      planEvidenceProgressFingerprint,
    );
    const freshCoverageKeys = collectFreshPlanReadCoverageKeys(
      evidenceRecoveryBatchResults,
    );
    const newCoverageKeys = freshCoverageKeys.filter(
      (key) => !previousProgressState.coverageKeys.has(key),
    );
    const semanticEvidenceAdvanced =
      hasSuccessfulEvidence &&
      (
        !previousProgressState.bundleHash ||
        previousProgressState.bundleHash !== recoveredEvidenceBundleHash
      );
    const readCoverageAdvanced = newCoverageKeys.length > 0;
    const decisionEvidenceAdvanced =
      hasSuccessfulEvidence &&
      (semanticEvidenceAdvanced || readCoverageAdvanced);
    const nextProgressState: PlanEvidenceProgressState = {
      bundleHash: recoveredEvidenceBundleHash,
      coverageKeys: new Set(previousProgressState.coverageKeys),
    };
    freshCoverageKeys.forEach((key) => nextProgressState.coverageKeys.add(key));
    const nextProgressFingerprint = buildPlanEvidenceProgressFingerprint(nextProgressState);
    if (planEvidenceRecoveryObjective === "model_draft" && decisionEvidenceAdvanced) {
      // The finalization surface was reopened for one model-requested read.
      // Completing that transaction must use the same model-draft threshold
      // that originally closed the surface. Requiring deterministic closure
      // here changes the contract mid-flight and turns valid file windows into
      // a false evidence-exhaustion loop.
      const recoveredClosureAssessment = assessPlanClosureEvidence(
        recoveredModelDraftInput.evidenceBundle,
      );
      planEvidenceProgressFingerprint = nextProgressFingerprint;
      planEvidenceNoProgressPasses = 0;
      logAgentEvent("plan_evidence_recovery_assessed", {
        iteration,
        recoveryPass: planEvidenceRecoveryPasses,
        recoveryObjective: "model_draft",
        modelAuthoredDraftReady: recoveredModelDraftReady,
        closureReady: recoveredClosureAssessment.ready,
        closureReason: recoveredClosureAssessment.reason,
        resultProvidedNewEvidence: hasSuccessfulEvidence,
        semanticEvidenceAdvanced,
        readCoverageAdvanced,
        newCoverageKeys,
        evidenceBundleHash: recoveredEvidenceBundleHash,
        recoveryBudgetRemaining: true,
        semanticFacts: recoveredModelDraftInput.evidenceBundle.facts.length,
        changeTargets: recoveredModelDraftInput.evidenceBundle.changeTargets.length,
      });
      if (recoveredModelDraftReady) {
        planEvidenceRecoveryObjective = "none";
        setQualityPhase("drafting", "model-authored evidence recovery complete");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryClosurePrompt({
          language: MODEL_CONTROL_LANGUAGE,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      } else {
        // New source is progress, but it has not yet produced a minimally
        // grounded model-authored draft bundle. Preserve the original
        // objective instead of silently escalating to deterministic closure.
        planClosureEvidenceRecoveryIssued = true;
        planEvidenceRecoveryObjective = "model_draft";
        setQualityPhase("needs_evidence", "model draft evidence incomplete");
        pendingPlanRuntimeRecoveryPrompt = buildPlanTargetedEvidenceRecoveryPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          reason: "model draft evidence incomplete",
          trigger: "closed_read_request",
        });
      }
    } else if (decisionEvidenceAdvanced) {
      planEvidenceRecoveryPasses += 1;
      planEvidenceProgressFingerprint = nextProgressFingerprint;
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
      // Successful distinct evidence is progress regardless of how many
      // earlier windows were needed. Global loop/context limits remain the
      // safety boundary; only unchanged/no-progress reads are locally bounded.
      const recoveryBudgetRemaining = true;
      logAgentEvent("plan_evidence_recovery_assessed", {
        iteration,
        recoveryPass: planEvidenceRecoveryPasses,
        recoveryObjective: planEvidenceRecoveryObjective || "deterministic_closure",
        modelAuthoredDraftReady: isPlanEvidenceBundleReady(
          recoveredClosureInput.evidenceBundle,
        ),
        closureReady: recoveredClosureAssessment.ready,
        closureReason: recoveredClosureAssessment.reason,
        objectiveTargetMatches: recoveredClosureAssessment.objectiveTargetMatches,
        defectSignalMatches: recoveredClosureAssessment.defectSignalMatches,
        contractMismatchMatches: recoveredClosureAssessment.contractMismatchMatches,
        contractMismatchKinds: recoveredClosureAssessment.contractMismatchKinds,
        unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
        semanticEvidenceAdvanced,
        readCoverageAdvanced,
        newCoverageKeys,
        evidenceBundleHash: recoveredEvidenceBundleHash,
        recoveryBudgetRemaining,
        semanticFacts: recoveredClosureInput.evidenceBundle.facts.length,
        changeTargets: recoveredClosureInput.evidenceBundle.changeTargets.length,
      });
      if (!recoveredClosureAssessment.ready && recoveryBudgetRemaining) {
        planClosureEvidenceRecoveryIssued = true;
        planEvidenceRecoveryObjective = "deterministic_closure";
        setQualityPhase("needs_evidence", recoveredClosureAssessment.reason);
        pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
          MODEL_CONTROL_LANGUAGE,
          recoveredClosureAssessment.reason,
          latestUserPromptText,
          {
            unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
            confirmedChangeTargets: recoveredClosureInput.evidenceBundle.changeTargets,
          },
        );
      } else if (recoveredClosureAssessment.ready) {
        planEvidenceRecoveryObjective = "none";
        setQualityPhase(
          "drafting",
          "evidence recovery complete",
        );
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryClosurePrompt({
          language: MODEL_CONTROL_LANGUAGE,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      }
    } else if (evidenceRecoveryBatchResults.some((result) => !result.isError)) {
      // Persist the current semantic/coverage baseline even when this batch did
      // not advance it. Some recovery entry points can begin without a prior
      // fingerprint; leaving it empty would let a later unchanged read claim
      // the same bundle as first-time progress.
      planEvidenceProgressFingerprint = nextProgressFingerprint;
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
        planEvidenceNoProgressPasses < MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES;
      logAgentEvent("plan_evidence_recovery_no_progress", {
        iteration,
        noProgressPass: planEvidenceNoProgressPasses,
        maxNoProgressPasses: MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES,
        evidenceRecoveryPasses: planEvidenceRecoveryPasses,
        rawReadProvidedContent: hasSuccessfulEvidence,
        semanticEvidenceAdvanced,
        readCoverageAdvanced,
        newCoverageKeys,
        evidenceBundleHash: recoveredEvidenceBundleHash,
        closureReason: recoveredClosureAssessment.reason,
        unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
        repeatedTargets: avoidTargets,
        canRetry: canRetryWithoutProgress,
        recoveryObjective: planEvidenceRecoveryObjective || "deterministic_closure",
      });
      if (canRetryWithoutProgress) {
        planClosureEvidenceRecoveryIssued = true;
        planEvidenceRecoveryObjective = recoveryObjectiveForBatch === "model_draft"
          ? "model_draft"
          : "deterministic_closure";
        setQualityPhase("needs_evidence", recoveredClosureAssessment.reason);
        pendingPlanRuntimeRecoveryPrompt = recoveryObjectiveForBatch === "model_draft"
          ? [
              buildPlanTargetedEvidenceRecoveryPrompt({
                language: MODEL_CONTROL_LANGUAGE,
                reason: "requested window produced no new evidence",
                trigger: "closed_read_request",
              }),
              avoidTargets.length > 0
                ? `Do not repeat unchanged target/window(s): ${avoidTargets.join(", ")}. Request a missing range or a different evidence owner.`
                : "Request a missing range or a different evidence owner.",
            ].join("\n")
          : buildPlanClosureEvidenceRecoveryPrompt(
              MODEL_CONTROL_LANGUAGE,
              recoveredClosureAssessment.reason,
              latestUserPromptText,
              {
                unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
                confirmedChangeTargets: recoveredClosureInput.evidenceBundle.changeTargets,
                avoidTargets,
              },
            );
      } else {
        planEvidenceRecoveryObjective = "none";
        setQualityPhase("blocked", "evidence recovery repeated without progress", "failed");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryBlockedPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: recoveredClosureAssessment.reason,
          missingSections: planLastMissingSections,
          requireResolvedEvidence: true,
        });
      }
    } else {
      // Failed reads still observe the current semantic baseline. Preserve it
      // so changing only the tool result shape cannot reset the progress gate.
      planEvidenceProgressFingerprint = nextProgressFingerprint;
      // A wrong path or transient read failure is not proof that the Plan is
      // impossible. Treat it as a no-progress transaction, allow one different
      // target/owner, and only block after the bounded retry also fails.
      planEvidenceNoProgressPasses += 1;
      const avoidTargets = [...new Set(
        evidenceRecoveryBatchResults
          .map((result) => String(result.target || "").trim())
          .filter(Boolean),
      )];
      const canRetryAfterError =
        planEvidenceNoProgressPasses < MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES;
      logAgentEvent("plan_evidence_recovery_error", {
        iteration,
        noProgressPass: planEvidenceNoProgressPasses,
        maxNoProgressPasses: MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES,
        repeatedTargets: avoidTargets,
        canRetry: canRetryAfterError,
        recoveryObjective: recoveryObjectiveForBatch || "deterministic_closure",
      });
      if (canRetryAfterError) {
        planClosureEvidenceRecoveryIssued = true;
        planEvidenceRecoveryObjective = recoveryObjectiveForBatch === "model_draft"
          ? "model_draft"
          : "deterministic_closure";
        setQualityPhase("needs_evidence", "evidence read failed; choose another target");
        pendingPlanRuntimeRecoveryPrompt = recoveryObjectiveForBatch === "model_draft"
          ? [
              buildPlanTargetedEvidenceRecoveryPrompt({
                language: MODEL_CONTROL_LANGUAGE,
                reason: "evidence read failed; choose another target",
                trigger: "closed_read_request",
              }),
              avoidTargets.length > 0
                ? `Do not retry failed target(s): ${avoidTargets.join(", ")}. Use a different path, range, or evidence owner.`
                : "Use a different path, range, or evidence owner.",
            ].join("\n")
          : buildPlanClosureEvidenceRecoveryPrompt(
              MODEL_CONTROL_LANGUAGE,
              "evidence read failed; choose another target",
              latestUserPromptText,
              { avoidTargets },
            );
      } else {
        planEvidenceRecoveryObjective = "none";
        setQualityPhase("blocked", "evidence recovery repeatedly failed", "failed");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryBlockedPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      }
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
      recoveryAction === "targeted_evidence"
    ) {
      result.planClosureEvidenceRecoveryIssued = true;
      result.planEvidenceRecoveryObjective = "deterministic_closure";
      result.pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
        MODEL_CONTROL_LANGUAGE,
        result.planLastQualityGateReason,
        input.latestUserPromptText,
      );
    } else if (recoveryAction === "ask_user") {
      result.planEvidenceRecoveryObjective = "none";
      result.pendingPlanRuntimeRecoveryPrompt = "PLAN_NEEDS_USER_DECISION: The draft contains a real blocking choice. Do not read more files or guess a default; present 2-4 mutually exclusive `<user_options>` and stop for the user. Keep the option labels in MAIN's configured response language.";
    } else {
      result.planEvidenceRecoveryObjective = "none";
      result.pendingPlanRuntimeRecoveryPrompt = buildPlanPostConvergenceToolRedirectPrompt({
        language: MODEL_CONTROL_LANGUAGE,
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
