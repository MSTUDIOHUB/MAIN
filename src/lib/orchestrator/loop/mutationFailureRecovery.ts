import {
  buildExecutePatchMismatchFingerprint,
  isExecutePatchMismatchRecoveryActivity,
  requestedRangeFromReadObservationSignature,
  type ExecutionDecisionCheckpoint,
  type ExecuteRecoveryMode,
  type PatchRecoveryMismatchEvidence,
  type RecoveryReadLease,
} from "../../executeRecoveryTools";
import type { FileReadObservationIdentity } from "../fileReadCache";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import { workspacePathsReferToSameFile } from "../../workspacePaths";

export type MutationPreflightRecoveryReason =
  | "mutation_preflight_invalid_patch"
  | "mutation_preflight_search_text_mismatch";

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
}

/**
 * Complete recovery action for one mutation preflight mismatch.
 *
 * The caller must not independently choose a mode, lease, or checkpoint. A
 * failed patch/search mutation always rebinds one exact source observation
 * before another mutation attempt. Repeating the same target/range/version is
 * bounded later by the lease identity and protocol no-progress counter.
 */
export interface DirectMutationPreflightRecoveryDecision {
  mode: "patch_recovery_read";
  reason: MutationPreflightRecoveryReason;
  target: string;
  readLease: RecoveryReadLease;
  sourceObservationKey: null;
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
  isPlanApproved: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  retainedSourceObservation?: FileReadObservationIdentity | null;
  results: MutationFailureResultLike[];
}): DirectMutationPreflightRecoveryDecision | null {
  const eligibleWorkflow =
    input.workflowMode === "edit" ||
    (input.workflowMode === "plan" && input.isPlanApproved);
  if (
    !eligibleWorkflow ||
    !isMutationRuntimeIntent(input.runtimeIntent) ||
    !["normal", "mutation_first", "action_plus_targeting"].includes(input.executeRecoveryMode)
  ) {
    return null;
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
    const requestedRange = mismatchEvidence?.requestedRange ||
      requestedRangeFromReadObservationSignature(
        retainedObservation?.requestSignature || "",
      ) ||
      { startLine: 1, maxLines: 180 };
    const observedVersion = mismatchEvidence?.observedVersion ||
      retainedObservation?.versionToken ||
      null;
    const mismatchFingerprint = mismatchEvidence?.mismatchFingerprint ||
      buildExecutePatchMismatchFingerprint({ reason, target });
    const readLease: RecoveryReadLease = {
      purpose: "patch_recovery",
      target,
      requestedRange,
      observedVersion,
      mismatchFingerprint,
      state: "available",
    };
    return {
      mode: "patch_recovery_read",
      reason,
      target,
      readLease,
      sourceObservationKey: null,
      decisionCheckpoint: {
        expectedTarget: target,
        sourceObservationKey: null,
        nextRequiredCapability: "targeted_read",
        evidenceVersion: observedVersion,
      },
    };
  }
  return null;
}
