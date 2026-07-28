import { workspacePathsReferToSameFile } from "../workspacePaths";
import type {
  RuntimeV2EvidenceReference,
  RuntimeV2ExecutionValidationAuthority,
  RuntimeV2Strategy,
} from "./contracts";
import type {
  RuntimeV2ExecutionContractCoverage,
  RuntimeV2ExecutionContractV1,
} from "./executionContract";
import type { RuntimeV2SubagentReportV1 } from "./subagentReport";
import {
  runtimeV2ValidationBoundaryMatchesCurrent,
  type RuntimeV2SubagentValidationReceiptV1,
  type RuntimeV2ValidatedMutationVersion,
} from "./validationReceipt";

interface RuntimeV2ExecutionContractEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly at: number;
  readonly type: string;
  readonly status?: string;
  readonly evidence?:
    | RuntimeV2EvidenceReference
    | readonly RuntimeV2EvidenceReference[];
  readonly passed?: boolean;
  readonly authority?: RuntimeV2ExecutionValidationAuthority;
  readonly mutationBoundarySequence?: number;
  readonly validatedMutationVersions?:
    readonly RuntimeV2ValidatedMutationVersion[];
  readonly report?: RuntimeV2SubagentReportV1;
  readonly validationReceipts?:
    readonly RuntimeV2SubagentValidationReceiptV1[];
}

interface RuntimeV2ExecutionContractAggregate {
  readonly strategy: RuntimeV2Strategy;
  readonly executionContract: RuntimeV2ExecutionContractV1 | null;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly events: readonly RuntimeV2ExecutionContractEvent[];
}

function eventIndex(
  aggregate: RuntimeV2ExecutionContractAggregate,
  event: RuntimeV2ExecutionContractEvent,
): number {
  return aggregate.events.findIndex((candidate) =>
    candidate.sequence === event.sequence &&
    candidate.eventId === event.eventId
  );
}

function eventEvidence(
  event: RuntimeV2ExecutionContractEvent,
): readonly RuntimeV2EvidenceReference[] {
  return Array.isArray(event.evidence)
    ? event.evidence as readonly RuntimeV2EvidenceReference[]
    : [];
}

function sameIdentityList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value) => right.includes(value));
}

function sameTargetList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((target) =>
      right.some((candidate) =>
        workspacePathsReferToSameFile(target, candidate)
      )
    );
}

function authorityMatchesContract(
  authority: RuntimeV2ExecutionValidationAuthority | undefined,
  contract: RuntimeV2ExecutionContractV1,
): authority is RuntimeV2ExecutionValidationAuthority {
  if (
    authority?.kind !== "execution_contract" ||
    authority.id !== contract.id ||
    authority.revision !== contract.revision ||
    authority.digest !== contract.digest
  ) {
    return false;
  }
  const validation = contract.validations.find(
    (candidate) => candidate.id === authority.validationId,
  );
  return !!validation &&
    sameIdentityList(authority.criterionIds, validation.criterionIds) &&
    sameTargetList(authority.targetPaths, validation.targetPaths);
}

export function deriveRuntimeV2ExecutionContractCoverage(
  aggregate: RuntimeV2ExecutionContractAggregate,
): RuntimeV2ExecutionContractCoverage | null {
  const contract = aggregate.executionContract;
  if (
    aggregate.strategy !== "execute" ||
    !contract ||
    contract.status !== "active"
  ) {
    return null;
  }
  const plannedMutationTargets = contract.changes.map(
    (change) => change.target,
  );
  const committedMutationTargets = [...new Set(
    aggregate.evidence
      .filter((evidence) => evidence.kind === "mutation")
      .map((evidence) => evidence.target),
  )];
  const missingMutationTargets = plannedMutationTargets.filter((planned) =>
    !committedMutationTargets.some((committed) =>
      workspacePathsReferToSameFile(planned, committed)
    )
  );
  const latestMutationIndex = aggregate.events.reduce((latest, event) =>
    event.type === "tool.completed" &&
      event.status === "succeeded" &&
      eventEvidence(event).some((evidence) =>
        evidence.kind === "mutation"
      )
      ? Math.max(latest, eventIndex(aggregate, event))
      : latest
  , -1);
  const parentAuthorities = aggregate.events.flatMap((event) =>
    event.type === "validation.completed" &&
      event.passed &&
      eventIndex(aggregate, event) > latestMutationIndex &&
      authorityMatchesContract(event.authority, contract) &&
      runtimeV2ValidationBoundaryMatchesCurrent({
        aggregate,
        targetPaths: event.authority.targetPaths,
        mutationBoundarySequence: event.mutationBoundarySequence,
        validatedMutationVersions: event.validatedMutationVersions,
      })
      ? [event.authority]
      : []
  );
  const childAuthorities = aggregate.events.flatMap((event) => {
    if (
      event.type !== "subagent.completed" ||
      event.status !== "completed" ||
      !event.report
    ) {
      return [];
    }
    const citedEvidenceIds = new Set(
      event.report.findings.flatMap((finding) => finding.evidenceIds),
    );
    return (event.validationReceipts || []).flatMap((receipt) =>
      receipt.passed &&
        citedEvidenceIds.has(receipt.evidenceId) &&
        eventEvidence(event).some((evidence) =>
          evidence.id === receipt.evidenceId &&
          evidence.kind === "validation"
        ) &&
        authorityMatchesContract(receipt.authority, contract) &&
        runtimeV2ValidationBoundaryMatchesCurrent({
          aggregate,
          targetPaths: receipt.authority.targetPaths,
          mutationBoundarySequence: receipt.mutationBoundarySequence,
          validatedMutationVersions: receipt.validatedMutationVersions,
        })
        ? [receipt.authority]
        : []
    );
  });
  const passedAuthorities = [...parentAuthorities, ...childAuthorities];
  const passedValidationIds = [...new Set(
    passedAuthorities.map((authority) => authority.validationId),
  )];
  const passedCriterionIds = [...new Set(
    passedAuthorities.flatMap((authority) => authority.criterionIds),
  )];
  const requiredValidationIds = contract.validations
    .filter((validation) => validation.required)
    .map((validation) => validation.id);
  const requiredCriterionIds = contract.criteria
    .filter((criterion) => criterion.required)
    .map((criterion) => criterion.id);
  const missingValidationIds = requiredValidationIds.filter(
    (id) => !passedValidationIds.includes(id),
  );
  const missingCriterionIds = requiredCriterionIds.filter(
    (id) => !passedCriterionIds.includes(id),
  );
  return {
    contractId: contract.id,
    contractRevision: contract.revision,
    plannedMutationTargets,
    committedMutationTargets,
    missingMutationTargets,
    requiredCriterionIds,
    passedCriterionIds,
    missingCriterionIds,
    requiredValidationIds,
    passedValidationIds,
    missingValidationIds,
    complete:
      missingMutationTargets.length === 0 &&
      missingCriterionIds.length === 0 &&
      missingValidationIds.length === 0,
  };
}
