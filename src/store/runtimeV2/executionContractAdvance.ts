import type { TurnAggregateV1 } from "../../lib/runtime-v2";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  deriveRuntimeV2ExecutionContract,
  runtimeV2ExecutionContractMutationTargets,
} from "./executionContract";

export interface RuntimeV2ExecutionContractAdvance {
  readonly required: boolean;
  readonly latestMutationSequence: number | null;
  readonly committedTargets: readonly string[];
  readonly pendingTargets: readonly string[];
  /** After every contracted target has received its implementation mutation,
   * one bounded read batch of the just-mutated targets remains available for
   * post-edit self-review. While targets are pending, exposing read_file beside
   * the required editor lets smaller models repeatedly inspect the wrong file
   * instead of advancing the already-recorded solution. */
  readonly sourceReviewAvailable: boolean;
  readonly sourceReviewTargets: readonly string[];
  readonly sourceReviewReceiptCount: number;
}

/**
 * A successful contract mutation is an implementation boundary, not an
 * invitation to restart repository discovery. Until a real assertion or
 * execution failure supplies a new causal fact, the next provider decision
 * must advance another contracted edit or validate the newest workspace.
 */
export function deriveRuntimeV2ExecutionContractAdvance(
  aggregate: TurnAggregateV1 | null,
): RuntimeV2ExecutionContractAdvance {
  const contract = deriveRuntimeV2ExecutionContract(aggregate);
  if (!aggregate || !contract) {
    return {
      required: false,
      latestMutationSequence: null,
      committedTargets: [],
      pendingTargets: [],
      sourceReviewAvailable: false,
      sourceReviewTargets: [],
      sourceReviewReceiptCount: 0,
    };
  }
  const mutationEvents = aggregate.events.filter(
    (event): event is Extract<
      TurnAggregateV1["events"][number],
      { type: "tool.completed" }
    > =>
      event.sequence > contract.recordedAtSequence &&
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.some((evidence) => evidence.kind === "mutation"),
  );
  const latestMutationSequence = mutationEvents.reduce(
    (latest, event) => Math.max(latest, event.sequence),
    0,
  ) || null;
  const committedTargets: string[] = [];
  for (const evidence of mutationEvents.flatMap((event) => event.evidence)) {
    if (
      evidence.kind === "mutation" &&
      !committedTargets.some((candidate) =>
        workspacePathsReferToSameFile(candidate, evidence.target)
      )
    ) {
      committedTargets.push(evidence.target);
    }
  }
  const pendingTargets = runtimeV2ExecutionContractMutationTargets(contract)
    .filter((target) => !committedTargets.some((candidate) =>
      workspacePathsReferToSameFile(candidate, target)
    ));
  const latestValidation = latestMutationSequence === null
    ? null
    : [...aggregate.events].reverse().find(
        (event): event is Extract<
          TurnAggregateV1["events"][number],
          { type: "validation.completed" }
        > =>
          event.type === "validation.completed" &&
          event.sequence > latestMutationSequence,
      ) || null;
  const suppliesCorrectionEvidence = !!latestValidation &&
    !latestValidation.passed &&
    (
      latestValidation.failureKind === "assertion_failed" ||
      latestValidation.failureKind === "execution_failed"
    );
  const required = latestMutationSequence !== null &&
    (
      latestValidation === null ||
      (!latestValidation.passed && !suppliesCorrectionEvidence)
    );
  const latestMutation = latestMutationSequence === null
    ? null
    : mutationEvents.find((event) =>
        event.sequence === latestMutationSequence
      ) || null;
  const sourceReviewTargets = latestMutation
    ? [...new Set(latestMutation.evidence
        .filter((evidence) => evidence.kind === "mutation")
        .map((evidence) => evidence.target)
        .filter(Boolean))]
    : [];
  const sourceReviewReceiptCount = latestMutationSequence === null
    ? 0
    : aggregate.events.filter((event) =>
        event.sequence > latestMutationSequence &&
        event.type === "tool.completed" &&
        event.status === "succeeded" &&
        event.evidence.some((evidence) => evidence.kind === "source")
      ).length;
  return {
    required,
    latestMutationSequence,
    committedTargets,
    pendingTargets,
    sourceReviewAvailable:
      required &&
      pendingTargets.length === 0 &&
      sourceReviewTargets.length > 0 &&
      sourceReviewReceiptCount === 0,
    sourceReviewTargets,
    sourceReviewReceiptCount,
  };
}
