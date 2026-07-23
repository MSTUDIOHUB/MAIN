import {
  isExecutePatchMismatchRecoveryActivity,
  type ExecutionDecisionCheckpoint,
  type ExecuteRecoveryMode,
  type PatchRecoveryMismatchEvidence,
} from "../../executeRecoveryTools";
import type { FileReadObservationIdentity } from "../fileReadCache";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import { workspacePathsReferToSameFile } from "../../workspacePaths";

export type MutationPreflightRecoveryReason =
  | "mutation_preflight_invalid_patch"
  | "mutation_preflight_search_text_mismatch"
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
 * structured mismatch evidence grants one target/range read lease. Without an
 * exact range the transaction stays mutation-only and must correct the call
 * from its retained observation instead of reopening broad diagnosis.
 *
 * A concrete mutation failure may replace any surrounding Execute phase
 * (including validation or objective audit). Only an already-active recovery
 * read owns the next transition and must not be reinitialized.
 */
export interface DirectMutationPreflightRecoveryDecision {
  mode: "mutation_first" | "patch_recovery_read";
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
    const readLease = requestedRange && mismatchEvidence?.mismatchFingerprint
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
      mode: readLease ? "patch_recovery_read" : "mutation_first",
      reason,
      target,
      readLease,
      sourceObservationKey,
      decisionCheckpoint: {
        expectedTarget: target,
        sourceObservationKey,
        nextRequiredCapability: readLease ? "targeted_read" : "mutation",
        evidenceVersion: observedVersion,
      },
    };
  }
  return null;
}
