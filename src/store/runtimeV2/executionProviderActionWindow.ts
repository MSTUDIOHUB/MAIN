import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import type { RuntimeV2Command } from "../../lib/runtime-v2";
import {
  latestRuntimeV2CorrectiveMutationFailure,
  type RuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";
import type {
  RuntimeV2MaterializedSourceCoverage,
  RuntimeV2ProviderActionWindow,
} from "./executionTypes";

export const RUNTIME_V2_CORRECTIVE_MUTATION_MAX_FAILURES = 3;

export function runtimeV2CorrectiveMutationFailureLimitReached(
  effects: RuntimeV2ProviderEffectFacts,
): boolean {
  return (effects.correctiveMutationFailureToolCallIds?.size || 0) >=
    RUNTIME_V2_CORRECTIVE_MUTATION_MAX_FAILURES;
}

/**
 * Close only a causally exhausted provider decision, never the Run itself.
 *
 * A rejected mutation reuses exact source already materialized in the current
 * provider request when that source covers the failed editor. Otherwise it
 * receives one target-locked source decision. Any subsequent editor is
 * authorized independently by the ordinary mutation preflight; Runtime never
 * asks the model to reconstruct the rejected patch merely to make progress.
 * A repeated-action recovery enters after the first proven closed decision
 * while a source-only frontier is still waiting for its next real workspace
 * effect. One cached source replay is itself the permitted context restore;
 * the following decision sees that exact source and must not reopen reads.
 * Cold resume or evicted source therefore reopens inspection automatically.
 */
export function runtimeV2ProviderActionWindowFor(input: {
  readonly command: Pick<RuntimeV2Command, "payload">;
  readonly effects: RuntimeV2ProviderEffectFacts;
  readonly sourceCoverage:
    readonly RuntimeV2MaterializedSourceCoverage[];
  readonly workspace?: string;
  /** Every contracted target has a committed mutation and no acceptance
   * validation has run against the newest boundary yet. An optional extra
   * editor that fails here must not indefinitely outrank the test which can
   * prove whether more implementation is actually required. */
  readonly completedContractAwaitingValidation?: boolean;
  /** A real failed validation is a newer causal boundary than an older
   * rejected editor. The old editor must not narrow the corrective evidence
   * surface opened by that validation. A rejected editor produced after the
   * validation still owns its normal target-locked recovery. */
  readonly newerValidationFailureSequence?: number | null;
}): RuntimeV2ProviderActionWindow | null {
  const latestCorrectiveFailure =
    latestRuntimeV2CorrectiveMutationFailure(input.effects);
  const correctiveFailureSequence = Number(
    latestCorrectiveFailure?.requirement?.sequence,
  );
  const validationFailureSequence = Number(
    input.newerValidationFailureSequence,
  );
  const correctiveFailureSuperseded = !!latestCorrectiveFailure &&
    Number.isFinite(correctiveFailureSequence) &&
    Number.isFinite(validationFailureSequence) &&
    validationFailureSequence >= correctiveFailureSequence;
  const correctiveTargets = latestCorrectiveFailure?.targets || [];
  const targetSourceVisible = correctiveTargets.length > 0 &&
    correctiveTargets.every((target) =>
      input.sourceCoverage.some((coverage) =>
        workspacePathsReferToSameFile(coverage.target, target)
      )
    );
  if (latestCorrectiveFailure && !correctiveFailureSuperseded) {
    if (input.completedContractAwaitingValidation) {
      return "validation_handoff";
    }
    // Recovery is for deriving a new, smaller action, not reconstructing the
    // rejected patch. Once fresh source for every failed target is visible,
    // close reading. The ordinary mutation lease still proves that the new
    // replacement or patch text is present before any write can execute.
    return targetSourceVisible
      ? "corrective_mutation"
      : "corrective_source";
  }

  const recovery = input.command.payload.recoveryPressure;
  const recoveryRecord = recovery &&
      typeof recovery === "object" &&
      !Array.isArray(recovery)
    ? recovery as Record<string, unknown>
    : null;
  const pressure = input.command.payload.effectPressure;
  const pressureRecord = pressure &&
      typeof pressure === "object" &&
      !Array.isArray(pressure)
      ? pressure as Record<string, unknown>
      : null;
  const repeatedObservation =
    (input.effects.repeatedObservationToolNames?.size || 0) > 0 ||
    (input.effects.replayedSourceReceiptCountSinceMutation || 0) >= 1;
  const mode = String(input.command.payload.mode || "").trim();
  if (
    mode === "validate" &&
    (
      repeatedObservation ||
      Number(recoveryRecord?.occurrence) >= 1
    )
  ) {
    // Validation already has a durable mutation boundary to verify. One
    // non-actionable provider decision is enough to close further inspection:
    // another read cannot discharge validation debt, while a finite failed
    // validation safely returns the reducer to editing. This also covers an
    // attempted mutation that was rejected at the advertised tool surface;
    // protocol failures are projected into recoveryPressure by the ledger.
    return "closed_recovery";
  }
  if (
    input.sourceCoverage.length > 0 &&
    pressureRecord?.reason === "source_only_frontier" &&
    (
      repeatedObservation ||
      (
        recoveryRecord?.reason === "repeated_action_rejected" &&
        Number(recoveryRecord.occurrence) >= 1
      )
    )
  ) {
    return "closed_recovery";
  }
  return null;
}
