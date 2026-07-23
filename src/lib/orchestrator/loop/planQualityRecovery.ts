import {
  buildPlanAutoScaffoldPrompt,
  buildPlanClosureEvidenceRecoveryPrompt,
  buildPlanEvidenceRecoveryBlockedPrompt,
  buildPlanEvidenceRecoveryClosurePrompt,
  buildPlanPostConvergenceToolRedirectPrompt,
} from "../../orchestrator/planOrchestration";
import {
  assessPlanClosureEvidence,
  buildPlanEvidenceEpochHash,
  hasDeterministicPlanMaterializationEvidence,
  isPlanEvidenceBundleReady,
  isPlanEvidenceReadyForModelDraft,
} from "../../planEvidence";
import { assessPlanEvidenceReadiness } from "../../planReadOnlyConvergence";
import {
  derivePlanEvidenceObligations,
  getPlanEvidenceObligationKey,
} from "../../planEvidenceObligations";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import { MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES } from "../../planRuntime";
import { isReadOnlyNoProgressDetail } from "../../executeRecoveryTools";
import {
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
  collectPlanClosureMaterializationInput,
  hasPlanVisualContextGrounding,
  isSuccessfulPlanArtifactWriteResult,
  logAgentEvent,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { TurnInputContextSignals } from "../../turnIntake";
import { hasCompletedToolExecution } from "../../toolResultEffect";
import {
  canDeterministicallyMaterializePlan,
  classifyPlanArtifactQualityResult,
  type PlanArtifactRecoveryAction,
  type PlanRuntimePhase,
} from "../../workflowModels";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import type {
  PlanEvidenceRecoveryObjective,
  PlanRuntimePhaseQualitySnapshot,
  PlanVisibleQualityPromptBudgetState,
} from "./planRuntimeState";
import {
  buildPlanEvidenceProgressFingerprint,
  getPlanVisibleQualityPromptCount,
  parsePlanEvidenceProgressFingerprint,
  recordPlanVisibleQualityPrompt,
  type PlanEvidenceProgressState,
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
  planVisibleQualityPromptBudget: PlanVisibleQualityPromptBudgetState;
  planArtifactQualityRejected: boolean;
  pendingPlanRuntimeRecoveryPrompt: string | null;
  deterministicEvidenceMaterializationCandidate: boolean;
  effectiveRecoveryAction: PlanArtifactRecoveryAction;
  awaitingPlanEvidenceResult: boolean;
  qualityEvidenceBundleHash: string;
  qualityEvidenceEpochHash: string;
};

export type PlanQualityRejectionSource = "visible_candidate" | "persisted_artifact";

export type PlanQualityRejection = {
  source: PlanQualityRejectionSource;
  qualityGateReason: string;
  recoveryAction: PlanArtifactRecoveryAction;
  missingSections: string[];
};

const MAX_VISIBLE_PLAN_QUALITY_REJECTIONS = 6;
const MAX_VISIBLE_PLAN_QUALITY_PROMPTS_PER_SIGNATURE_EPOCH = 2;

export type PlanQualityRecoveryClassification = {
  recoveryAction: PlanArtifactRecoveryAction;
  reasonType: string;
  signature: string;
};

export type PlanQualityEvidenceState =
  | "absent"
  | "present"
  | "counterpart_missing";

export type PlanQualityRecoveryTransition = {
  effectiveAction: PlanArtifactRecoveryAction;
  evidenceObjective: PlanEvidenceRecoveryObjective;
  holdActiveEvidenceTransaction: boolean;
  openEvidenceTransaction: boolean;
  clearStaleEvidenceTransaction: boolean;
  reason: string;
};

export function assessPlanEvidenceTransactionProgress(input: {
  previousObligationKeys: Iterable<string>;
  nextObligationKeys: Iterable<string>;
  hasSuccessfulEvidence: boolean;
  semanticEvidenceAdvanced: boolean;
  readCoverageAdvanced: boolean;
}): {
  advanced: boolean;
  firstOpenObligationKey: string | null;
  firstExactObligationClosed: boolean;
} {
  const previous = [...input.previousObligationKeys];
  const next = new Set(input.nextObligationKeys);
  const firstOpenObligationKey = previous[0] || null;
  const firstExactObligationClosed = !!firstOpenObligationKey &&
    !next.has(firstOpenObligationKey);
  return {
    advanced: input.hasSuccessfulEvidence && (
      firstOpenObligationKey
        ? firstExactObligationClosed
        : input.semanticEvidenceAdvanced || input.readCoverageAdvanced
    ),
    firstOpenObligationKey,
    firstExactObligationClosed,
  };
}

const PLAN_QUALITY_REASON_TYPES_REQUIRING_GROUNDED_EVIDENCE = new Set([
  "insufficient_actionable_plan_signals",
  "unverified_diagnostic_claim_as_confirmed",
  "unsupported_hypothesis_as_plan",
  "generic_fallback_plan",
]);

/**
 * Resolve the runtime transition separately from the textual quality
 * classification. A validator describes what is wrong with a candidate;
 * this resolver decides whether the runtime may rewrite it yet.
 *
 * An active evidence transaction is owned by the `needs_evidence` phase and
 * can only be consumed by tool-result reconciliation. A later model draft is
 * therefore not allowed to cancel it. Conversely, an objective left behind
 * in any other phase is stale and may be replaced by the new typed decision.
 */
export function resolvePlanQualityRecoveryTransition(input: {
  intrinsicAction: PlanArtifactRecoveryAction;
  rejectionSource: PlanQualityRejectionSource;
  reasonType: string;
  evidenceState: PlanQualityEvidenceState;
  planRuntimePhase: PlanRuntimePhase;
  evidenceRecoveryIssued: boolean;
  evidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  hasRecoveryReadBatch: boolean;
  evidenceBudgetAvailable: boolean;
}): PlanQualityRecoveryTransition {
  if (input.intrinsicAction === "ask_user") {
    return {
      effectiveAction: "ask_user",
      evidenceObjective: "none",
      holdActiveEvidenceTransaction: false,
      openEvidenceTransaction: false,
      clearStaleEvidenceTransaction:
        input.evidenceRecoveryIssued || input.evidenceRecoveryObjective !== "none",
      reason: "user_decision_required",
    };
  }

  const hasActiveEvidenceTransaction =
    input.evidenceRecoveryObjective !== "none" &&
    (
      input.planRuntimePhase === "needs_evidence" ||
      input.hasRecoveryReadBatch
    );
  if (hasActiveEvidenceTransaction) {
    return {
      effectiveAction: "targeted_evidence",
      evidenceObjective: input.evidenceRecoveryObjective,
      holdActiveEvidenceTransaction: true,
      openEvidenceTransaction: false,
      clearStaleEvidenceTransaction: false,
      reason: "active_evidence_transaction",
    };
  }

  const requiresCounterpartEvidence = input.evidenceState === "counterpart_missing";
  const requiresInitialModelDraftEvidence =
    input.rejectionSource === "visible_candidate" &&
    input.evidenceState === "absent" &&
    PLAN_QUALITY_REASON_TYPES_REQUIRING_GROUNDED_EVIDENCE.has(input.reasonType);
  const requiresEvidence =
    input.intrinsicAction === "targeted_evidence" ||
    requiresCounterpartEvidence ||
    requiresInitialModelDraftEvidence;
  const openEvidenceTransaction = requiresEvidence && input.evidenceBudgetAvailable;

  return {
    effectiveAction: requiresEvidence ? "targeted_evidence" : input.intrinsicAction,
    evidenceObjective: openEvidenceTransaction
      ? (input.rejectionSource === "visible_candidate"
          ? "model_draft"
          : "deterministic_closure")
      : "none",
    holdActiveEvidenceTransaction: false,
    openEvidenceTransaction,
    clearStaleEvidenceTransaction:
      input.evidenceRecoveryIssued || input.evidenceRecoveryObjective !== "none",
    reason: requiresInitialModelDraftEvidence
      ? "initial_model_draft_evidence"
      : requiresCounterpartEvidence
        ? "contract_counterpart_evidence"
        : input.intrinsicAction === "targeted_evidence"
          ? "validator_targeted_evidence"
          : requiresEvidence
            ? "evidence_budget_exhausted"
            : "intrinsic_quality_action",
  };
}

/**
 * Convert a quality rejection into a stable recovery identity. The reason
 * type prevents cosmetic message changes from looking like progress, while
 * normalized details preserve genuinely new validator findings such as a new
 * missing section or uncovered goal facet.
 */
export function classifyPlanQualityRecovery(input: {
  reason?: string | null;
  missingSections?: string[];
  recoveryAction?: PlanArtifactRecoveryAction | null;
}): PlanQualityRecoveryClassification {
  const rawReason = String(input.reason || "quality_gate").trim() || "quality_gate";
  const reasonSeparator = rawReason.indexOf(":");
  const reasonType = (reasonSeparator >= 0
    ? rawReason.slice(0, reasonSeparator)
    : rawReason
  ).trim().toLowerCase().replace(/\s+/g, "_");
  const classified = classifyPlanArtifactQualityResult({
    ok: false,
    reason: rawReason,
    ...(input.missingSections?.length
      ? { missingSections: input.missingSections }
      : {}),
  });
  // This reason describes an epistemic labeling error in the candidate, not a
  // missing source observation. Keep this defensive normalization here as
  // well as in the artifact classifier so restored/stale quality envelopes
  // cannot reopen discovery with the old action.
  const recoveryAction = reasonType === "unverified_diagnostic_claim_as_confirmed"
    ? "rewrite"
    : input.recoveryAction || classified.recoveryAction || "rewrite";
  const missingSections = [...new Set(
    (input.missingSections?.length
      ? input.missingSections
      : classified.missingSections || [])
      .map((section) => String(section || "").trim().toLowerCase())
      .filter(Boolean),
  )].sort();
  const rawDetails = reasonSeparator >= 0
    ? rawReason.slice(reasonSeparator + 1).trim().toLowerCase().replace(/\s+/g, "_")
    : "";
  const details = missingSections.length > 0
    ? `sections=${missingSections.join(",")}`
    : rawDetails;
  return {
    recoveryAction,
    reasonType,
    signature: [recoveryAction, reasonType, details].filter(Boolean).join("|"),
  };
}

type PlanQualityRecoveryInput = {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  iteration: number;
  planRuntimePhase: PlanRuntimePhase;
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  latestUserPromptText: string;
  turnInputContextSignals: TurnInputContextSignals;
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
  planVisibleQualityPromptBudget?: PlanVisibleQualityPromptBudgetState;
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
  let planVisibleQualityPromptBudget = input.planVisibleQualityPromptBudget ?? [];
  let planArtifactQualityRejected = input.planArtifactQualityRejected === true;
  let pendingPlanRuntimeRecoveryPrompt: string | null = null;
  let deterministicEvidenceMaterializationCandidate = false;
  let effectiveRecoveryAction: PlanArtifactRecoveryAction = "accept";
  let awaitingPlanEvidenceResult = false;
  let qualityEvidenceBundleHash = "";
  let qualityEvidenceEpochHash = "";
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
    planVisibleQualityPromptBudget,
    planArtifactQualityRejected,
    pendingPlanRuntimeRecoveryPrompt,
    deterministicEvidenceMaterializationCandidate,
    effectiveRecoveryAction,
    awaitingPlanEvidenceResult,
    qualityEvidenceBundleHash,
    qualityEvidenceEpochHash,
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
    const latestQualityClassification = classifyPlanQualityRecovery({
      reason: planLastQualityGateReason,
      missingSections: planLastMissingSections,
      recoveryAction: latestQualityResult.recoveryAction,
    });

    const qualityClosureEvidence = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
    );
    qualityEvidenceBundleHash = qualityClosureEvidence.evidenceBundle.hash;
    qualityEvidenceEpochHash = buildPlanEvidenceEpochHash(
      qualityClosureEvidence.evidenceBundle,
    );
    const hasQualityClosureEvidence = isPlanEvidenceBundleReady(
      qualityClosureEvidence.evidenceBundle,
    );
    const closureEvidenceAssessment = assessPlanClosureEvidence(
      qualityClosureEvidence.evidenceBundle,
    );
    const qualityEvidenceReadiness = assessPlanEvidenceReadiness({
      userGoal: latestUserPromptText,
      userContext: input.turnInputContextSignals,
      recentToolActivity: recentPlanToolActivity,
      hasGroundedVisualContext: hasPlanVisualContextGrounding(
        callbacks.getMessages(),
        callbacks.getCurrentTurnId?.(),
      ),
    });
    const qualityEvidenceObligations = derivePlanEvidenceObligations({
      objective: latestUserPromptText,
      activities: recentPlanToolActivity,
    });
    const deterministicClosureReady =
      qualityEvidenceReadiness.status === "ready_for_plan" &&
      hasDeterministicPlanMaterializationEvidence(
        qualityClosureEvidence.evidenceBundle,
      );
    const hasStructuredQualityClosureEvidence = qualityClosureEvidence.evidenceRecords.length > 0;
    const qualityEvidenceState: PlanQualityEvidenceState =
      qualityEvidenceObligations.length > 0 ||
      closureEvidenceAssessment.reason === "contract_counterpart_unverified"
        ? "counterpart_missing"
        : qualityClosureEvidence.evidenceBundle.facts.length > 0
          ? "present"
          : "absent";
    const recoveryTransition = resolvePlanQualityRecoveryTransition({
      intrinsicAction: latestQualityClassification.recoveryAction,
      rejectionSource: latestQualityResult.source,
      reasonType: latestQualityClassification.reasonType,
      evidenceState: qualityEvidenceState,
      planRuntimePhase,
      evidenceRecoveryIssued: planClosureEvidenceRecoveryIssued,
      evidenceRecoveryObjective: planEvidenceRecoveryObjective,
      hasRecoveryReadBatch:
        hasOutstandingEvidenceRecoveryRead || hasObjectiveRecoveryRead,
      evidenceBudgetAvailable:
        planEvidenceNoProgressPasses < MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES,
    });
    if (recoveryTransition.clearStaleEvidenceTransaction) {
      planClosureEvidenceRecoveryIssued = false;
      planEvidenceRecoveryObjective = "none";
    }
    const shouldRequestTargetedEvidenceAfterQualityGate =
      recoveryTransition.openEvidenceTransaction;
    effectiveRecoveryAction = recoveryTransition.effectiveAction;
    const needsInitialModelDraftEvidence =
      recoveryTransition.reason === "initial_model_draft_evidence";
    const explicitSourceEvidenceGap = qualityEvidenceState === "counterpart_missing";
    logAgentEvent("plan_quality_recovery_action", {
      iteration,
      source: latestQualityResult.source,
      recoveryAction: latestQualityResult.recoveryAction,
      effectiveRecoveryAction,
      qualityRejectCount: planQualityRejectCount,
      qualityGateReason: planLastQualityGateReason,
      missingSections: planLastMissingSections,
      evidenceRecoveryPasses: planEvidenceRecoveryPasses,
      evidenceState: qualityEvidenceState,
      transitionReason: recoveryTransition.reason,
      heldActiveEvidenceTransaction: recoveryTransition.holdActiveEvidenceTransaction,
      clearedStaleEvidenceTransaction: recoveryTransition.clearStaleEvidenceTransaction,
    });
    deterministicEvidenceMaterializationCandidate =
      latestQualityResult.source === "visible_candidate" &&
      !recoveryTransition.holdActiveEvidenceTransaction &&
      qualityEvidenceReadiness.status === "ready_for_plan" &&
      canDeterministicallyMaterializePlan({
        recoveryAction: latestQualityResult.recoveryAction,
        closureReady: deterministicClosureReady,
      });
    logAgentEvent("plan_quality_gate_recovery_decision", {
      iteration,
      source: latestQualityResult.source,
      qualityGateReason: planLastQualityGateReason,
      qualityRejectCount: planQualityRejectCount,
      requestedRecoveryAction: latestQualityResult.recoveryAction || "",
      effectiveRecoveryAction,
      hasGroundedEvidence: hasQualityClosureEvidence,
      hasStructuredEvidence: hasStructuredQualityClosureEvidence,
      explicitSourceEvidenceGap,
      needsInitialModelDraftEvidence,
      closureEvidenceReady: deterministicClosureReady,
      rationaleReady: closureEvidenceAssessment.ready,
      closureEvidenceReason: closureEvidenceAssessment.reason,
      evidenceReadiness: qualityEvidenceReadiness.status,
      evidenceReadinessReason: qualityEvidenceReadiness.reason,
      evidenceObligations: qualityEvidenceObligations.length,
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
        planEvidenceNoProgressPasses = 0;
      }
      progressState.obligationKeys = new Set(
        qualityEvidenceObligations.map(getPlanEvidenceObligationKey),
      );
      planEvidenceProgressFingerprint = buildPlanEvidenceProgressFingerprint(progressState);
      planClosureEvidenceRecoveryIssued = true;
      planEvidenceRecoveryObjective = recoveryTransition.evidenceObjective;
      setQualityPhase(
        "needs_evidence",
        qualityEvidenceReadiness.status !== "ready_for_plan"
          ? qualityEvidenceReadiness.reason
          : closureEvidenceAssessment.ready
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
          evidenceObligations: qualityEvidenceObligations,
        },
      );
    } else if (recoveryTransition.holdActiveEvidenceTransaction) {
      // A typed recovery objective represents a real outstanding read
      // transaction. Do not replace it with a scaffold merely because another
      // weak draft arrived before the requested evidence result.
      awaitingPlanEvidenceResult = true;
      setQualityPhase("needs_evidence", closureEvidenceAssessment.reason);
    } else if (effectiveRecoveryAction === "auto_scaffold") {
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
    } else if (effectiveRecoveryAction === "targeted_evidence") {
      if (planEvidenceNoProgressPasses >= MAX_PLAN_EVIDENCE_NO_PROGRESS_PASSES) {
        planEvidenceRecoveryObjective = "none";
        setQualityPhase("blocked", "evidence recovery budget exhausted", "failed");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryBlockedPrompt({
          language: MODEL_CONTROL_LANGUAGE,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
          requireResolvedEvidence: true,
        });
      } else {
        setQualityPhase("needs_evidence", planLastQualityGateReason);
      }
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
    planVisibleQualityPromptBudget = [];
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
    awaitingPlanEvidenceResult = false;
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
    const recoveredClosureAssessment = assessPlanClosureEvidence(
      recoveredModelDraftInput.evidenceBundle,
    );
    const recoveredEvidenceReadiness = assessPlanEvidenceReadiness({
      userGoal: latestUserPromptText,
      userContext: input.turnInputContextSignals,
      recentToolActivity: recentPlanToolActivity,
      hasGroundedVisualContext: hasPlanVisualContextGrounding(
        callbacks.getMessages(),
        callbacks.getCurrentTurnId?.(),
      ),
    });
    const recoveredEvidenceObligations = derivePlanEvidenceObligations({
      objective: latestUserPromptText,
      activities: recentPlanToolActivity,
    });
    const recoveredModelDraftReady =
      recoveredEvidenceReadiness.status === "ready_for_plan" &&
      isPlanEvidenceReadyForModelDraft(
        recoveredModelDraftInput.evidenceBundle,
        recoveredClosureAssessment,
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
      !!previousProgressState.bundleHash &&
      previousProgressState.bundleHash !== recoveredEvidenceBundleHash;
    const readCoverageAdvanced = newCoverageKeys.length > 0;
    const recoveredObligationKeys = new Set(
      recoveredEvidenceObligations.map(getPlanEvidenceObligationKey),
    );
    // While an exact runtime obligation is open, unrelated bundle growth or a
    // fresh window cannot advance the evidence transaction. This keeps a read
    // of an arbitrary new file from resetting no-progress while the required
    // symbol/path remains unresolved.
    const transactionProgress = assessPlanEvidenceTransactionProgress({
      previousObligationKeys: previousProgressState.obligationKeys,
      nextObligationKeys: recoveredObligationKeys,
      hasSuccessfulEvidence,
      semanticEvidenceAdvanced,
      readCoverageAdvanced,
    });
    const decisionEvidenceAdvanced = transactionProgress.advanced;
    const nextProgressState: PlanEvidenceProgressState = {
      bundleHash: recoveredEvidenceBundleHash,
      coverageKeys: new Set(previousProgressState.coverageKeys),
      obligationKeys: recoveredObligationKeys,
    };
    freshCoverageKeys.forEach((key) => nextProgressState.coverageKeys.add(key));
    const nextProgressFingerprint = buildPlanEvidenceProgressFingerprint(nextProgressState);
    if (
      planEvidenceRecoveryObjective === "model_draft" &&
      (decisionEvidenceAdvanced || recoveredModelDraftReady)
    ) {
      // The finalization surface was reopened for one model-requested read.
      // Resume model drafting once its frozen evidence contract is complete.
      // A mechanically confirmed diagnosis is required only by deterministic
      // fallback materialization, not by a reviewable model-authored candidate.
      planEvidenceProgressFingerprint = nextProgressFingerprint;
      planEvidenceNoProgressPasses = 0;
      logAgentEvent("plan_evidence_recovery_assessed", {
        iteration,
        recoveryPass: planEvidenceRecoveryPasses,
        recoveryObjective: "model_draft",
        modelAuthoredDraftReady: recoveredModelDraftReady,
        closureReady: recoveredClosureAssessment.ready,
        closureReason: recoveredClosureAssessment.reason,
        evidenceReadiness: recoveredEvidenceReadiness.status,
        evidenceReadinessReason: recoveredEvidenceReadiness.reason,
        evidenceObligations: recoveredEvidenceObligations.length,
        resultProvidedNewEvidence: hasSuccessfulEvidence,
        semanticEvidenceAdvanced,
        readCoverageAdvanced,
        firstOpenObligationKey: transactionProgress.firstOpenObligationKey,
        firstExactObligationClosed: transactionProgress.firstExactObligationClosed,
        newCoverageKeys,
        evidenceBundleHash: recoveredEvidenceBundleHash,
        semanticFacts: recoveredModelDraftInput.evidenceBundle.facts.length,
        changeTargets: recoveredModelDraftInput.evidenceBundle.changeTargets.length,
      });
      if (recoveredModelDraftReady) {
        planEvidenceRecoveryObjective = "none";
        setQualityPhase("drafting", "model-authored Plan evidence recovery complete");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryClosurePrompt({
          language: MODEL_CONTROL_LANGUAGE,
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      } else {
        // A missing evidence owner is still a real open contract. Preserve the
        // targeted transaction until that counterpart is observed.
        planClosureEvidenceRecoveryIssued = true;
        planEvidenceRecoveryObjective = "model_draft";
        setQualityPhase("needs_evidence", recoveredEvidenceReadiness.reason);
        pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
          MODEL_CONTROL_LANGUAGE,
          recoveredEvidenceReadiness.reason,
          latestUserPromptText,
          {
            unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
            confirmedChangeTargets: recoveredModelDraftInput.evidenceBundle.changeTargets,
            evidenceObligations: recoveredEvidenceObligations,
          },
        );
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
      const recoveredModelDraftReady = isPlanEvidenceReadyForModelDraft(
        recoveredClosureInput.evidenceBundle,
        recoveredClosureAssessment,
      ) && recoveredEvidenceReadiness.status === "ready_for_plan";
      const recoveredDeterministicReady =
        recoveredEvidenceReadiness.status === "ready_for_plan" &&
        hasDeterministicPlanMaterializationEvidence(
          recoveredClosureInput.evidenceBundle,
        );
      const recoveredClosureReason = recoveredEvidenceReadiness.status !== "ready_for_plan"
        ? recoveredEvidenceReadiness.reason
        : recoveredClosureAssessment.ready && !recoveredDeterministicReady
        ? "insufficient_facet_specific_diagnostic_evidence"
        : recoveredClosureAssessment.reason;
      logAgentEvent("plan_evidence_recovery_assessed", {
        iteration,
        recoveryPass: planEvidenceRecoveryPasses,
        recoveryObjective: planEvidenceRecoveryObjective || "deterministic_closure",
        modelAuthoredDraftReady: recoveredModelDraftReady,
        closureReady: recoveredDeterministicReady,
        rationaleReady: recoveredClosureAssessment.ready,
        closureReason: recoveredClosureReason,
        objectiveTargetMatches: recoveredClosureAssessment.objectiveTargetMatches,
        defectSignalMatches: recoveredClosureAssessment.defectSignalMatches,
        contractMismatchMatches: recoveredClosureAssessment.contractMismatchMatches,
        contractMismatchKinds: recoveredClosureAssessment.contractMismatchKinds,
        unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
        evidenceReadiness: recoveredEvidenceReadiness.status,
        evidenceReadinessReason: recoveredEvidenceReadiness.reason,
        evidenceObligations: recoveredEvidenceObligations.length,
        semanticEvidenceAdvanced,
        readCoverageAdvanced,
        newCoverageKeys,
        evidenceBundleHash: recoveredEvidenceBundleHash,
        semanticFacts: recoveredClosureInput.evidenceBundle.facts.length,
        changeTargets: recoveredClosureInput.evidenceBundle.changeTargets.length,
      });
      if (!recoveredDeterministicReady) {
        planClosureEvidenceRecoveryIssued = true;
        planEvidenceRecoveryObjective = "deterministic_closure";
        setQualityPhase("needs_evidence", recoveredClosureReason);
        pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
          MODEL_CONTROL_LANGUAGE,
          recoveredClosureReason,
          latestUserPromptText,
          {
            unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
            confirmedChangeTargets: recoveredClosureInput.evidenceBundle.changeTargets,
            evidenceObligations: recoveredEvidenceObligations,
          },
        );
      } else {
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
    } else if (evidenceRecoveryBatchResults.some(hasCompletedToolExecution)) {
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
              buildPlanClosureEvidenceRecoveryPrompt(
                MODEL_CONTROL_LANGUAGE,
                recoveredEvidenceReadiness.reason,
                latestUserPromptText,
                {
                  unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
                  confirmedChangeTargets: recoveredClosureInput.evidenceBundle.changeTargets,
                  avoidTargets,
                  evidenceObligations: recoveredEvidenceObligations,
                },
              ),
            ].join("\n")
          : buildPlanClosureEvidenceRecoveryPrompt(
              MODEL_CONTROL_LANGUAGE,
              recoveredClosureAssessment.reason,
              latestUserPromptText,
              {
                unresolvedContractKinds: recoveredClosureAssessment.unresolvedContractKinds,
                confirmedChangeTargets: recoveredClosureInput.evidenceBundle.changeTargets,
                avoidTargets,
                evidenceObligations: recoveredEvidenceObligations,
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
          ? buildPlanClosureEvidenceRecoveryPrompt(
              MODEL_CONTROL_LANGUAGE,
              recoveredEvidenceReadiness.reason,
              latestUserPromptText,
              {
                avoidTargets,
                evidenceObligations: recoveredEvidenceObligations,
              },
            )
          : buildPlanClosureEvidenceRecoveryPrompt(
              MODEL_CONTROL_LANGUAGE,
              "evidence read failed; choose another target",
              latestUserPromptText,
              { avoidTargets, evidenceObligations: recoveredEvidenceObligations },
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
  const previousRecovery = classifyPlanQualityRecovery({
    reason: input.planLastQualityGateReason,
    missingSections: input.planLastMissingSections,
  });
  const currentRecovery = classifyPlanQualityRecovery({
    reason: quality.reason,
    missingSections: quality.missingSections,
    recoveryAction: quality.recoveryAction,
  });
  const intrinsicRecoveryAction = currentRecovery.recoveryAction;
  const result = handlePlanQualityRejections({
    ...input,
    rejections: [{
      source: "visible_candidate",
      qualityGateReason: quality.reason || "quality_gate",
      recoveryAction: intrinsicRecoveryAction,
      missingSections: quality.missingSections || [],
    }],
    acceptedPersistedArtifact: false,
    evidenceRecoveryResults: [],
  });

  // Tool-written rejections are already visible as tool feedback. Visible
  // candidates need an explicit channel, but the budget belongs to the exact
  // quality signature and frozen evidence epoch—not to unrelated defects that
  // happened earlier in the same Plan run.
  const isNewQualityIssue = !input.planLastQualityGateReason ||
    previousRecovery.signature !== currentRecovery.signature;
  const qualityEpochIdentity = {
    signature: currentRecovery.signature,
    evidenceEpochHash: result.qualityEvidenceEpochHash,
  };
  const promptsIssuedForQualityEpoch = getPlanVisibleQualityPromptCount(
    input.planVisibleQualityPromptBudget,
    qualityEpochIdentity,
  );
  const withinQualityEpochPromptBudget =
    promptsIssuedForQualityEpoch < MAX_VISIBLE_PLAN_QUALITY_PROMPTS_PER_SIGNATURE_EPOCH;
  const withinGlobalRejectionLimit =
    result.planQualityRejectCount <= MAX_VISIBLE_PLAN_QUALITY_REJECTIONS;
  const recoveryAction = result.effectiveRecoveryAction === "accept"
    ? intrinsicRecoveryAction
    : result.effectiveRecoveryAction;
  const hasOutstandingEvidenceTransaction =
    result.awaitingPlanEvidenceResult ||
    (
      result.planClosureEvidenceRecoveryIssued &&
      result.planEvidenceRecoveryObjective !== "none"
    );
  const shouldIssueVisibleRecoveryPrompt =
    result.pendingPlanRuntimeRecoveryPrompt == null &&
    !hasOutstandingEvidenceTransaction &&
    withinGlobalRejectionLimit &&
    withinQualityEpochPromptBudget;
  if (shouldIssueVisibleRecoveryPrompt) {
    result.planVisibleQualityPromptBudget = recordPlanVisibleQualityPrompt(
      input.planVisibleQualityPromptBudget,
      qualityEpochIdentity,
    );
    if (
      recoveryAction === "targeted_evidence"
    ) {
      result.planClosureEvidenceRecoveryIssued = true;
      result.planEvidenceRecoveryObjective = "model_draft";
      result.pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
        MODEL_CONTROL_LANGUAGE,
        result.planLastQualityGateReason,
        input.latestUserPromptText,
        {
          evidenceObligations: derivePlanEvidenceObligations({
            objective: input.latestUserPromptText,
            activities: input.recentPlanToolActivity,
          }),
        },
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
        failurePreview: quality.failurePreview,
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
    outstandingEvidenceTransaction: hasOutstandingEvidenceTransaction,
    recoveryReasonType: currentRecovery.reasonType,
    recoverySignature: currentRecovery.signature,
    previousRecoverySignature: previousRecovery.signature,
    isNewQualityIssue,
    evidenceBundleHash: result.qualityEvidenceBundleHash,
    evidenceEpochHash: result.qualityEvidenceEpochHash,
    promptsIssuedForQualityEpoch:
      promptsIssuedForQualityEpoch + (shouldIssueVisibleRecoveryPrompt ? 1 : 0),
    withinQualityEpochPromptBudget,
    maxPromptsPerQualityEpoch: MAX_VISIBLE_PLAN_QUALITY_PROMPTS_PER_SIGNATURE_EPOCH,
    withinGlobalRejectionLimit,
    maxVisibleQualityRejections: MAX_VISIBLE_PLAN_QUALITY_REJECTIONS,
  });
  return result;
}
