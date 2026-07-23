import { workspacePathsReferToSameFile } from "./workspacePaths";
import type { ValidationPrimitiveSpec } from "./validationContract";

export const PLAN_COVERAGE_CONTRACT_VERSION = 1 as const;

export type PlanCoverageObligationKind =
  | "confirmed_change_rationale"
  | "contract_mismatch"
  | "causal_relation";

/**
 * Runtime-owned evidence relationship that must remain closed in a reviewed
 * Plan. The model never authors these records; it only supplies E/R/C/D/V
 * edges that the runtime can prove cover them.
 */
export interface PlanCoverageObligation {
  id: string;
  kind: PlanCoverageObligationKind;
  relationKey: string;
  evidenceRefs: string[];
  targetRefs: string[];
}

interface CoverageEvidenceNode {
  id: string;
  target: string;
}

interface CoverageDiagnosisNode {
  id: string;
  certainty: "observed" | "inferred" | "hypothesis";
  evidenceRefs: string[];
  chainRefs: string[];
  goalRefs: string[];
}

interface CoverageChangeNode {
  id: string;
  targetRef: string;
  operation: "modify" | "create" | "delete" | "preserve";
  evidenceRefs: string[];
  diagnosisRefs: string[];
  goalRefs: string[];
}

interface CoverageDecisionNode {
  id: string;
  disposition: "change" | "preserve";
  evidenceRefs: string[];
  diagnosisRefs: string[];
  goalRefs: string[];
}

interface CoverageValidationNode {
  id: string;
  goalRefs: string[];
  changeRefs: string[];
  primitive: ValidationPrimitiveSpec;
  blocking: boolean;
}

export interface PlanCoverageCandidateGraph {
  diagnosisRequired: boolean;
  evidence: CoverageEvidenceNode[];
  diagnoses: CoverageDiagnosisNode[];
  changes: CoverageChangeNode[];
  decisions: CoverageDecisionNode[];
  validations: CoverageValidationNode[];
  coverageObligations?: PlanCoverageObligation[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function diagnosisCoversObligation(
  diagnosis: CoverageDiagnosisNode,
  obligation: PlanCoverageObligation,
): boolean {
  if (diagnosis.certainty === "hypothesis") return false;
  if (!obligation.evidenceRefs.every((reference) => diagnosis.evidenceRefs.includes(reference))) {
    return false;
  }
  return diagnosis.certainty !== "inferred" ||
    obligation.evidenceRefs.every((reference) => diagnosis.chainRefs.includes(reference));
}

function changeOwnsEvidence(
  change: CoverageChangeNode,
  evidence: CoverageEvidenceNode,
): boolean {
  return change.evidenceRefs.includes(evidence.id) &&
    workspacePathsReferToSameFile(change.targetRef, evidence.target);
}

/**
 * Validate the evidence-to-action closure without consulting display prose.
 * This is intentionally a graph invariant: provider wording, language and
 * project-specific identifiers cannot make an uncovered relationship pass.
 */
export function validatePlanCoverageClosure(
  candidate: PlanCoverageCandidateGraph,
): string[] {
  const failures: string[] = [];
  const obligations = Array.isArray(candidate.coverageObligations)
    ? candidate.coverageObligations
    : [];
  if (obligations.length === 0) return failures;

  const evidenceById = new Map(candidate.evidence.map((item) => [item.id, item]));
  const seenIds = new Set<string>();
  for (const obligation of obligations) {
    if (!/^Q\d+$/.test(String(obligation?.id || ""))) {
      failures.push(`candidate_coverage_obligation_id_invalid:${obligation?.id || "missing"}`);
      continue;
    }
    if (seenIds.has(obligation.id)) {
      failures.push(`candidate_coverage_obligation_id_duplicate:${obligation.id}`);
    }
    seenIds.add(obligation.id);
    if (![
      "confirmed_change_rationale",
      "contract_mismatch",
      "causal_relation",
    ].includes(obligation.kind)) {
      failures.push(`candidate_coverage_obligation_kind_invalid:${obligation.id}`);
    }
    if (!String(obligation.relationKey || "").trim()) {
      failures.push(`candidate_coverage_relation_missing:${obligation.id}`);
    }
    const evidenceRefs = unique(Array.isArray(obligation.evidenceRefs)
      ? obligation.evidenceRefs
      : []);
    const targetRefs = unique(Array.isArray(obligation.targetRefs)
      ? obligation.targetRefs
      : []);
    if (evidenceRefs.length === 0) {
      failures.push(`candidate_coverage_evidence_missing:${obligation.id}`);
      continue;
    }
    const missingEvidence = evidenceRefs.filter((reference) => !evidenceById.has(reference));
    if (missingEvidence.length > 0) {
      failures.push(`candidate_coverage_evidence_invalid:${obligation.id}:${missingEvidence.join("+")}`);
      continue;
    }
    if (targetRefs.length === 0 || evidenceRefs.some((reference) => {
      const evidence = evidenceById.get(reference);
      return !evidence || !targetRefs.some((target) =>
        workspacePathsReferToSameFile(target, evidence.target)
      );
    })) {
      failures.push(`candidate_coverage_target_binding_invalid:${obligation.id}`);
    }

    // Feature work may bind a runtime-selected change target directly to C/V,
    // but an observed mismatch or causal relationship is diagnostic evidence
    // regardless of the original request wording. Such relationships always
    // require an R chain before they can authorize an action.
    const requiresDiagnosis = candidate.diagnosisRequired ||
      obligation.kind !== "confirmed_change_rationale";
    const coveringDiagnoses = requiresDiagnosis
      ? candidate.diagnoses.filter((diagnosis) =>
          diagnosisCoversObligation(diagnosis, obligation)
        )
      : [];
    if (requiresDiagnosis && coveringDiagnoses.length === 0) {
      failures.push(`candidate_coverage_diagnosis_missing:${obligation.id}`);
      continue;
    }
    const coveringDiagnosisIds = new Set(coveringDiagnoses.map((diagnosis) => diagnosis.id));
    const directActions = requiresDiagnosis
      ? []
      : [
          ...candidate.changes.filter((change) => evidenceRefs.some((evidenceRef) => {
            const evidence = evidenceById.get(evidenceRef);
            return !!evidence && changeOwnsEvidence(change, evidence);
          })),
          ...candidate.decisions.filter((decision) =>
            decision.evidenceRefs.some((reference) => evidenceRefs.includes(reference))
          ),
        ];
    const coverageGoalRefs = unique(
      (requiresDiagnosis ? coveringDiagnoses : directActions)
        .flatMap((item) => item.goalRefs),
    );
    const changingRefs = new Set<string>();

    for (const evidenceRef of evidenceRefs) {
      const evidence = evidenceById.get(evidenceRef)!;
      const owningChanges = candidate.changes.filter((change) =>
        changeOwnsEvidence(change, evidence) &&
        (!requiresDiagnosis || (
          change.diagnosisRefs.some((reference) => coveringDiagnosisIds.has(reference)) &&
          intersects(change.goalRefs, coverageGoalRefs)
        ))
      );
      const preservedByChange = owningChanges.some((change) => change.operation === "preserve");
      const preservedByDecision = candidate.decisions.some((decision) =>
        decision.disposition === "preserve" &&
        decision.evidenceRefs.includes(evidenceRef) &&
        (!requiresDiagnosis || (
          decision.diagnosisRefs.some((reference) => coveringDiagnosisIds.has(reference)) &&
          intersects(decision.goalRefs, coverageGoalRefs)
        ))
      );
      const changing = owningChanges.filter((change) => change.operation !== "preserve");
      changing.forEach((change) => changingRefs.add(change.id));
      if (changing.length === 0 && !preservedByChange && !preservedByDecision) {
        failures.push(`candidate_coverage_disposition_missing:${obligation.id}:${evidenceRef}`);
      }
    }

    // Every runtime-authored Q denotes work that still needs disposition. A
    // model-authored preserve statement is not proof that the relationship or
    // selected change target is already resolved. Until the runtime owns a
    // separate resolved/no-change proof type, fail closed unless Q reaches at
    // least one concrete non-preserve C (counterpart owners may still use D).
    if (changingRefs.size === 0) {
      failures.push(`candidate_coverage_change_missing:${obligation.id}`);
    }

    for (const changeRef of changingRefs) {
      const validationCovered = candidate.validations.some((validation) =>
        validation.blocking === true &&
        validation.changeRefs.includes(changeRef) &&
        intersects(validation.goalRefs, coverageGoalRefs)
      );
      if (!validationCovered) {
        failures.push(`candidate_coverage_validation_missing:${obligation.id}:${changeRef}`);
      }
    }
  }

  // Additional diagnoses may be grounded by an exact source observation that
  // does not match one of the finite runtime relationship detectors. Do not
  // equate detector absence with falsehood. The hard invariant is one-way:
  // every runtime-authored obligation must close; unrelated diagnoses remain
  // subject to their ordinary E/goal/certainty grounding checks.
  return unique(failures);
}
