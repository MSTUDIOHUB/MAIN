import { workspacePathsReferToSameFile } from "../workspacePaths";
import type {
  RuntimeV2EvidenceReference,
  RuntimeV2ExecutionValidationAuthority,
} from "./contracts";

export const RUNTIME_V2_SUBAGENT_VALIDATION_RECEIPT_SCHEMA_VERSION =
  "runtime-v2-subagent-validation-receipt.v1" as const;

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

export interface RuntimeV2SubagentValidationReceiptV1
  extends RuntimeV2ValidationBoundary {
  readonly schemaVersion:
    typeof RUNTIME_V2_SUBAGENT_VALIDATION_RECEIPT_SCHEMA_VERSION;
  readonly evidenceId: string;
  readonly passed: boolean;
  readonly authority: RuntimeV2ExecutionValidationAuthority;
  readonly startedAt: number;
  readonly completedAt: number;
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

export function validateRuntimeV2SubagentValidationReceipts(input: {
  readonly receipts:
    | readonly RuntimeV2SubagentValidationReceiptV1[]
    | undefined;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly taskKind: string | undefined;
  readonly eventAt: number;
}): boolean {
  const receipts = input.receipts || [];
  if (receipts.length === 0) return true;
  if (input.taskKind !== "validate") return false;
  const evidenceById = new Map(
    input.evidence.map((evidence) => [evidence.id, evidence]),
  );
  if (new Set(receipts.map((receipt) => receipt.evidenceId)).size !==
    receipts.length) {
    return false;
  }
  return receipts.every((receipt) => {
    const validationEvidence = evidenceById.get(receipt.evidenceId);
    const authority = receipt.authority;
    return receipt.schemaVersion ===
        RUNTIME_V2_SUBAGENT_VALIDATION_RECEIPT_SCHEMA_VERSION &&
      validationEvidence?.kind === "validation" &&
      !!authority &&
      (authority.kind === "execution_contract" ||
        authority.kind === "work_plan") &&
      !!authority.id &&
      Number.isInteger(authority.revision) &&
      authority.revision > 0 &&
      !!authority.digest &&
      !!authority.validationId &&
      authority.criterionIds.length > 0 &&
      authority.targetPaths.length > 0 &&
      Number.isInteger(receipt.mutationBoundarySequence) &&
      receipt.mutationBoundarySequence >= 0 &&
      receipt.validatedMutationVersions.length <=
        uniqueTargets(authority.targetPaths).length &&
      receipt.validatedMutationVersions.every((version) =>
        !!version.target &&
        !!version.mutationEvidenceId &&
        authority.targetPaths.some((target) =>
          workspacePathsReferToSameFile(target, version.target)
        ) &&
        Number.isInteger(version.mutationSequence) &&
        version.mutationSequence > 0
      ) &&
      Number.isFinite(receipt.startedAt) &&
      Number.isFinite(receipt.completedAt) &&
      receipt.startedAt <= receipt.completedAt &&
      receipt.completedAt <= input.eventAt;
  });
}
