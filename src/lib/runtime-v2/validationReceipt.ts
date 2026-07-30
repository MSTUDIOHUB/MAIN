import { workspacePathsReferToSameFile } from "../workspacePaths";
import { sha256Hex } from "../sha256";
import type {
  RuntimeV2EvidenceReference,
  RuntimeV2ExecutionValidationAuthority,
  RuntimeV2Objective,
} from "./contracts";

/**
 * A mutation evidence id and ledger sequence together identify one durable
 * workspace version even when the editor cannot cheaply hash the final file.
 */
export interface RuntimeV2ValidatedMutationVersion {
  readonly target: string;
  readonly mutationEvidenceId: string;
  readonly mutationSequence: number;
  readonly version: string | null;
}

export interface RuntimeV2ValidationBoundary {
  /** Latest mutation anywhere in the Turn when validation began. */
  readonly mutationBoundarySequence: number;
  /** Latest mutation for every target claimed by this validator. */
  readonly validatedMutationVersions:
    readonly RuntimeV2ValidatedMutationVersion[];
}

interface RuntimeV2ValidationBoundaryEvent {
  readonly sequence: number;
  readonly type: string;
  readonly status?: string;
  readonly evidence?:
    | RuntimeV2EvidenceReference
    | readonly RuntimeV2EvidenceReference[];
}

interface RuntimeV2ValidationBoundaryAggregate {
  readonly events: readonly RuntimeV2ValidationBoundaryEvent[];
}

function eventEvidence(
  event: RuntimeV2ValidationBoundaryEvent,
): readonly RuntimeV2EvidenceReference[] {
  if (Array.isArray(event.evidence)) {
    return event.evidence as readonly RuntimeV2EvidenceReference[];
  }
  return event.evidence ? [event.evidence as RuntimeV2EvidenceReference] : [];
}

function mutationEvents(
  aggregate: RuntimeV2ValidationBoundaryAggregate,
): readonly RuntimeV2ValidationBoundaryEvent[] {
  return aggregate.events.filter((event) =>
    event.type === "tool.completed" &&
    event.status === "succeeded" &&
    eventEvidence(event).some((evidence) => evidence.kind === "mutation")
  );
}

function uniqueTargets(targets: readonly string[]): readonly string[] {
  const unique: string[] = [];
  for (const target of targets) {
    const candidate = String(target || "").trim();
    if (
      candidate &&
      !unique.some((existing) =>
        workspacePathsReferToSameFile(existing, candidate)
      )
    ) {
      unique.push(candidate);
    }
  }
  return unique;
}

export function runtimeV2DirectExecuteCriterionIds(
  objective: RuntimeV2Objective,
): readonly string[] {
  const supplied = objective.acceptanceCriterionIds || [];
  return objective.acceptanceCriteria.map((_, index) =>
    String(supplied[index] || "").trim() || `criterion-${index + 1}`
  );
}

export function runtimeV2DirectExecuteMutationTargets(
  aggregate: RuntimeV2ValidationBoundaryAggregate,
): readonly string[] {
  return uniqueTargets(
    mutationEvents(aggregate).flatMap((event) =>
      eventEvidence(event)
        .filter((evidence) => evidence.kind === "mutation")
        .map((evidence) => evidence.target)
    ),
  );
}

export function runtimeV2DirectExecuteAuthorityDigest(input: {
  readonly turnId: string;
  readonly objective: RuntimeV2Objective;
}): string {
  return sha256Hex(JSON.stringify({
    turnId: input.turnId,
    objective: input.objective.text,
    criteria: input.objective.acceptanceCriteria.map((text, index) => ({
      id: runtimeV2DirectExecuteCriterionIds(input.objective)[index],
      text,
      evidenceRequirement:
        input.objective.acceptanceEvidenceRequirements?.[index] || null,
    })),
  }));
}

/**
 * Bind a direct Execute validator to the complete runtime-owned acceptance
 * scope at the current mutation boundary. The provider chooses the validator,
 * but it cannot omit a criterion or mutation target from the resulting
 * receipt.
 */
export function resolveRuntimeV2DirectExecuteValidationAuthority(input: {
  readonly aggregate: RuntimeV2ValidationBoundaryAggregate;
  readonly turnId: string;
  readonly objective: RuntimeV2Objective;
  readonly validationId: string;
}): RuntimeV2ExecutionValidationAuthority | null {
  const admittedCriteria = runtimeV2DirectExecuteCriterionIds(
    input.objective,
  );
  const mutationTargets = runtimeV2DirectExecuteMutationTargets(
    input.aggregate,
  );
  if (
    !input.validationId.trim() ||
    admittedCriteria.length === 0 ||
    mutationTargets.length === 0
  ) {
    return null;
  }
  return {
    kind: "direct_execute",
    id: input.turnId,
    revision: 1,
    digest: runtimeV2DirectExecuteAuthorityDigest({
      turnId: input.turnId,
      objective: input.objective,
    }),
    validationId: input.validationId,
    criterionIds: admittedCriteria,
    targetPaths: mutationTargets,
  };
}

export function deriveRuntimeV2ValidationBoundary(
  aggregate: RuntimeV2ValidationBoundaryAggregate,
  targetPaths: readonly string[],
): RuntimeV2ValidationBoundary {
  const mutations = mutationEvents(aggregate);
  const validatedMutationVersions = uniqueTargets(targetPaths)
    .map((target): RuntimeV2ValidatedMutationVersion | null => {
      for (let index = mutations.length - 1; index >= 0; index -= 1) {
        const event = mutations[index]!;
        const evidence = [...eventEvidence(event)].reverse().find((entry) =>
          entry.kind === "mutation" &&
          workspacePathsReferToSameFile(entry.target, target)
        );
        if (evidence) {
          return {
            target,
            mutationEvidenceId: evidence.id,
            mutationSequence: event.sequence,
            version: evidence.version,
          };
        }
      }
      return null;
    })
    .filter(
      (entry): entry is RuntimeV2ValidatedMutationVersion => entry !== null,
    );
  return {
    mutationBoundarySequence: mutations.reduce(
      (latest, event) => Math.max(latest, event.sequence),
      0,
    ),
    validatedMutationVersions,
  };
}

export function runtimeV2ValidationBoundaryMatchesCurrent(input: {
  readonly aggregate: RuntimeV2ValidationBoundaryAggregate;
  readonly targetPaths: readonly string[];
  readonly mutationBoundarySequence: number | undefined;
  readonly validatedMutationVersions:
    | readonly RuntimeV2ValidatedMutationVersion[]
    | undefined;
}): boolean {
  const expected = deriveRuntimeV2ValidationBoundary(
    input.aggregate,
    input.targetPaths,
  );
  const supplied = input.validatedMutationVersions || [];
  const targets = uniqueTargets(input.targetPaths);
  if (
    !Number.isInteger(input.mutationBoundarySequence) ||
    input.mutationBoundarySequence !== expected.mutationBoundarySequence ||
    expected.validatedMutationVersions.length !== targets.length ||
    supplied.length !== expected.validatedMutationVersions.length
  ) {
    return false;
  }
  return expected.validatedMutationVersions.every((current) =>
    supplied.some((candidate) =>
      workspacePathsReferToSameFile(candidate.target, current.target) &&
      candidate.mutationEvidenceId === current.mutationEvidenceId &&
      candidate.mutationSequence === current.mutationSequence &&
      candidate.version === current.version
    )
  );
}
