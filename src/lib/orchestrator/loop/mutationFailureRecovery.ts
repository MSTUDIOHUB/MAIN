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
 * Complete recovery action for one mutation preflight mismatch. A failed
 * patch stays in the same execution transaction and reuses the versioned
 * source observation already in context. read_file remains available through
 * the stable execution surface; its cache decides whether a later request is
 * a changed/missing window or an unchanged stub. No forced cache bypass is
 * created here.
 */
export interface DirectMutationPreflightRecoveryDecision {
  mode: "mutation_first";
  reason: MutationPreflightRecoveryReason;
  target: string;
  readLease: null;
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
    const observedVersion = mismatchEvidence?.observedVersion ||
      retainedObservation?.versionToken ||
      null;
    const sourceObservationKey = retainedObservation?.key || null;
    return {
      mode: "mutation_first",
      reason,
      target,
      readLease: null,
      sourceObservationKey,
      decisionCheckpoint: {
        expectedTarget: target,
        sourceObservationKey,
        nextRequiredCapability: "mutation",
        evidenceVersion: observedVersion,
      },
    };
  }
  return null;
}
