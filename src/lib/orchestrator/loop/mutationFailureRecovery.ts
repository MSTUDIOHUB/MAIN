import {
  isExecutePatchMismatchRecoveryActivity,
  type ExecutionDecisionCheckpoint,
  type ExecuteRecoveryMode,
  type PatchRecoveryMismatchEvidence,
} from "../../executeRecoveryTools";
import type { FileReadObservationIdentity } from "../fileReadCache";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import {
  normalizeWorkspacePathIdentity,
  workspacePathsReferToSameFile,
} from "../../workspacePaths";
import {
  directEditTransactionHasCurrentClosureEvidence,
  resolveDirectEditTransaction,
  setDirectEditTransactionPhase,
} from "../../directEditTransaction";

export type MutationPreflightRecoveryReason =
  | "mutation_preflight_invalid_patch"
  | "mutation_preflight_search_text_mismatch"
  | "mutation_preflight_no_effect"
  | "mutation_partial_effect_requires_reread";

interface MutationFailureResultLike {
  toolCallId?: string;
  name?: string;
  target?: string;
  content?: string;
  displayContent?: string;
  isError?: boolean;
  lifecycleState?: string;
  qualityGateReason?: string;
  mutationPreflightReason?: string;
  patchRecoveryMismatch?: PatchRecoveryMismatchEvidence;
  workspaceEffect?: string;
  workspaceMutationEvidence?: {
    changedPaths?: string[];
  };
}

/**
 * Complete recovery action for one mutation preflight mismatch. Exact
 * structured mismatch evidence grants one target/range read lease. A malformed
 * patch without a range stays mutation-only; a proven no-effect mutation
 * releases its unconfirmed target and returns to bounded targeting.
 *
 * A concrete mutation failure may replace any surrounding Execute phase
 * (including validation or objective audit). Only an already-active recovery
 * read owns the next transition and must not be reinitialized.
 */
export interface DirectMutationPreflightRecoveryDecision {
  mode: Exclude<ExecuteRecoveryMode, "normal">;
  reason: MutationPreflightRecoveryReason;
  target: string;
  readLease: {
    purpose: "patch_recovery";
    target: string;
    requestedRange?: NonNullable<PatchRecoveryMismatchEvidence["requestedRange"]>;
    observedVersion: string | null;
    mismatchFingerprint: string;
    state: "available";
  } | null;
  sourceObservationKey: string | null;
  protocolNoProgressFingerprint: string | null;
  decisionCheckpoint: ExecutionDecisionCheckpoint;
}

function resolveStructuredMismatchReason(
  result: MutationFailureResultLike,
): MutationPreflightRecoveryReason | null {
  if (result.mutationPreflightReason === "invalid_patch") {
    return "mutation_preflight_invalid_patch";
  }
  if (result.mutationPreflightReason === "search_text_mismatch") {
    return "mutation_preflight_search_text_mismatch";
  }
  if (
    result.mutationPreflightReason === "empty_change" ||
    result.mutationPreflightReason === "identical_content"
  ) {
    return "mutation_preflight_no_effect";
  }
  if (result.mutationPreflightReason) {
    // Structured preflight truth is authoritative. An unrelated stable reason
    // such as read_failed or missing_content must not be reinterpreted from the
    // generic MUTATION_PREFLIGHT_BLOCKED marker as a patch mismatch.
    return null;
  }
  const mismatchIdentity = String(
    result.patchRecoveryMismatch?.mismatchFingerprint || "",
  ).toLowerCase();
  if (mismatchIdentity.includes("invalid_patch")) {
    return "mutation_preflight_invalid_patch";
  }
  if (mismatchIdentity.includes("search_text_mismatch")) {
    return "mutation_preflight_search_text_mismatch";
  }
  if (!isExecutePatchMismatchRecoveryActivity({
    name: result.name,
    status: result.isError ? "failed" : "succeeded",
    target: result.target,
    detail: [
      result.content,
      result.displayContent,
      result.qualityGateReason,
      result.lifecycleState,
    ].filter(Boolean).join("\n"),
  })) {
    return null;
  }
  // Compatibility for old persisted results that predate the structured
  // mutationPreflightReason field. Tool identity is stable and language-free.
  return result.name === "apply_patch"
    ? "mutation_preflight_invalid_patch"
    : "mutation_preflight_search_text_mismatch";
}

function retainedObservationForTarget(
  observation: FileReadObservationIdentity | null | undefined,
  target: string,
): FileReadObservationIdentity | null {
  return observation && workspacePathsReferToSameFile(observation.path, target)
    ? observation
    : null;
}

export function resolveDirectMutationPreflightRecovery(input: {
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  executeRecoveryMode: ExecuteRecoveryMode;
  decisionCheckpoint?: ExecutionDecisionCheckpoint | null;
  retainedSourceObservation?: FileReadObservationIdentity | null;
  results: MutationFailureResultLike[];
}): DirectMutationPreflightRecoveryDecision | null {
  const eligibleWorkflow = input.workflowMode === "edit";
  if (
    !eligibleWorkflow ||
    !isMutationRuntimeIntent(input.runtimeIntent) ||
    input.executeRecoveryMode === "patch_recovery_read"
  ) {
    return null;
  }

  // Execution failure and workspace mutation are orthogonal. If the runtime
  // observed a changed path before the tool failed, every pre-call source
  // window is stale. Grant one fresh read and prohibit an immediate retry
  // from the old content; the failed call remains failed evidence.
  for (const result of input.results) {
    const changedPaths = [...new Set(
      (result.workspaceMutationEvidence?.changedPaths || [])
        .map((path) => String(path || "").trim())
        .filter(Boolean),
    )];
    if (
      !result.isError ||
      result.workspaceEffect !== "partial" ||
      changedPaths.length === 0
    ) {
      continue;
    }
    const target = changedPaths[0];
    const mismatchFingerprint = [
      "partial_mutation",
      String(result.toolCallId || result.name || "tool"),
      target,
    ].join("::");
    return {
      mode: "patch_recovery_read",
      reason: "mutation_partial_effect_requires_reread",
      target,
      readLease: {
        purpose: "patch_recovery",
        target,
        observedVersion: null,
        mismatchFingerprint,
        state: "available",
      },
      sourceObservationKey: null,
      protocolNoProgressFingerprint: null,
      decisionCheckpoint: {
        expectedTarget: target,
        sourceObservationKey: null,
        nextRequiredCapability: "targeted_read",
      },
    };
  }

  for (const result of input.results) {
    const reason = resolveStructuredMismatchReason(result);
    if (!reason) continue;
    const target = String(result.target || "").trim();
    if (!target) continue;
    const mismatchEvidence = result.patchRecoveryMismatch &&
      workspacePathsReferToSameFile(result.patchRecoveryMismatch.target, target)
        ? result.patchRecoveryMismatch
        : null;
    const retainedObservation = retainedObservationForTarget(
      input.retainedSourceObservation,
      target,
    );
    const observedVersion = mismatchEvidence?.observedVersion ||
      retainedObservation?.versionToken ||
      null;
    const sourceObservationKey = retainedObservation?.key || null;
    const requestedRange = mismatchEvidence?.requestedRange || null;
    const noEffect = reason === "mutation_preflight_no_effect";
    const pendingValidationOwnsTarget = Boolean(
      noEffect &&
      input.decisionCheckpoint?.pendingFiniteValidation &&
      input.decisionCheckpoint.finiteValidationDiagnosticTargets?.some(
        (candidate) => workspacePathsReferToSameFile(candidate, target),
      ),
    );
    const directEditTransaction = resolveDirectEditTransaction(
      input.decisionCheckpoint,
    );
    const resumedAuditTransaction =
      noEffect &&
      directEditTransaction?.phase === "mutate"
        ? setDirectEditTransactionPhase(directEditTransaction, "audit")
        : null;
    const resumeValidatedAudit = Boolean(
      resumedAuditTransaction &&
      directEditTransactionHasCurrentClosureEvidence(
        resumedAuditTransaction,
        target,
      ),
    );
    const readLease = !noEffect &&
      requestedRange &&
      mismatchEvidence?.mismatchFingerprint
      ? {
          purpose: "patch_recovery" as const,
          target,
          requestedRange,
          observedVersion,
          mismatchFingerprint: mismatchEvidence.mismatchFingerprint,
          state: "available" as const,
        }
      : null;
    return {
      mode: resumeValidatedAudit
        ? "objective_audit"
        : pendingValidationOwnsTarget
        ? "mutation_first"
        : noEffect
        ? "action_plus_targeting"
        : readLease
        ? "patch_recovery_read"
        : "mutation_first",
      reason,
      target,
      readLease,
      sourceObservationKey: resumeValidatedAudit
        ? sourceObservationKey
        : pendingValidationOwnsTarget
        ? sourceObservationKey
        : noEffect
        ? null
        : sourceObservationKey,
      protocolNoProgressFingerprint: resumeValidatedAudit
        ? null
        : noEffect
        ? `mutation_no_effect::${normalizeWorkspacePathIdentity(target)}`
        : null,
      decisionCheckpoint: resumeValidatedAudit
        ? {
            ...(input.decisionCheckpoint || {}),
            expectedTarget: target,
            sourceObservationKey,
            nextRequiredCapability: "any",
            ...(observedVersion ? { evidenceVersion: observedVersion } : {}),
            directEditTransaction: resumedAuditTransaction!,
          }
        : {
            // A patch mismatch is a failed attempt inside the current
            // transaction, not a new transaction. Keep the validation
            // command, diagnostic, ownership, and mutation receipts that
            // explain what still needs repair.
            ...(input.decisionCheckpoint || {}),
            expectedTarget: noEffect && !pendingValidationOwnsTarget ? null : target,
            sourceObservationKey:
              noEffect && !pendingValidationOwnsTarget ? null : sourceObservationKey,
            nextRequiredCapability: pendingValidationOwnsTarget
              ? "mutation"
              : noEffect
              ? "targeting"
              : readLease
              ? "targeted_read"
              : "mutation",
            evidenceVersion: observedVersion,
          },
    };
  }
  return null;
}
