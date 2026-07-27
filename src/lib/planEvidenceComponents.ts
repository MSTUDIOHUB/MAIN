import type { PlanGoalFacetContract } from "./planAuthoringContract";
import type { PlanCoverageObligation } from "./planCoverageContract";

export interface PlanEvidenceComponent {
  id: string;
  evidenceRefs: string[];
  ownerRefs: string[];
  relationRefs: string[];
  /** Q-backed components must be assigned; exact orphan observations are optional. */
  requiredForClosure: boolean;
  /** True only when runtime-owned Q edges expose a causal or mismatch relation. */
  supportsDiagnosis: boolean;
}

export interface PlanEvidenceComponentFactLike {
  id: string;
  target: string;
  sourceObservations?: readonly unknown[];
}

export interface PlanGoalEvidenceBasis {
  goalRef: string;
  componentRef: string;
  evidenceRefs: string[];
  ownerRefs: string[];
  relationRefs: string[];
  diagnosisRefs: string[];
}

export interface PlanGoalEvidenceDiagnosisLike {
  id: string;
  certainty: "observed" | "inferred" | "hypothesis";
  evidenceRefs: string[];
  goalRefs: string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function setsEqual(left: readonly string[], right: readonly string[]): boolean {
  const a = unique(left).sort();
  const b = unique(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Keep each causal/mismatch relationship independent. A target-rationale Q is
 * attached to one matching relationship instead of becoming a duplicate
 * capacity unit. Exact source observations that are not part of any Q remain
 * optional singleton components, so a symptom owner can be mapped without the
 * runtime claiming that the observation is already a proven defect.
 */
export function derivePlanEvidenceComponents(
  obligations: readonly PlanCoverageObligation[] | undefined,
  facts: readonly PlanEvidenceComponentFactLike[] = [],
): PlanEvidenceComponent[] {
  const valid = (obligations || []).filter((item) =>
    !!item?.id && item.evidenceRefs.length > 0 && item.targetRefs.length > 0
  );
  const relational = valid.filter((item) => item.kind !== "confirmed_change_rationale");
  const groups = relational.map((item) => [item]);
  for (const rationale of valid.filter((item) => item.kind === "confirmed_change_rationale")) {
    const matchingIndex = groups.findIndex((items) => items.some((item) =>
      item.evidenceRefs.some((reference) => rationale.evidenceRefs.includes(reference))
    ));
    if (matchingIndex >= 0) groups[matchingIndex]!.push(rationale);
    else groups.push([rationale]);
  }
  const components: Array<Omit<PlanEvidenceComponent, "id">> = groups
    .map((items) => ({
      evidenceRefs: unique(items.flatMap((item) => item.evidenceRefs)).sort(),
      ownerRefs: unique(items.flatMap((item) => item.targetRefs)).sort(),
      relationRefs: unique(items.map((item) => item.id)).sort((left, right) =>
        Number(left.slice(1)) - Number(right.slice(1))
      ),
      supportsDiagnosis: items.some((item) =>
        item.kind === "contract_mismatch" || item.kind === "causal_relation"
      ),
      requiredForClosure: true,
    }))
    .sort((left, right) => {
      const leftIndex = Number(left.relationRefs[0]?.slice(1) || Number.MAX_SAFE_INTEGER);
      const rightIndex = Number(right.relationRefs[0]?.slice(1) || Number.MAX_SAFE_INTEGER);
      return leftIndex - rightIndex;
    });
  const qEvidence = new Set(components.flatMap((component) => component.evidenceRefs));
  for (const fact of facts) {
    if (
      qEvidence.has(fact.id) ||
      !Array.isArray(fact.sourceObservations) ||
      fact.sourceObservations.length === 0 ||
      !String(fact.target || "").trim()
    ) continue;
    components.push({
      evidenceRefs: [fact.id],
      ownerRefs: [fact.target],
      relationRefs: [],
      supportsDiagnosis: false,
      requiredForClosure: false,
    });
  }
  return components.map((component, index) => ({ id: `B${index + 1}`, ...component }));
}

export function assessPlanEvidenceComponentCapacity(input: {
  facets: readonly PlanGoalFacetContract[];
  components: readonly PlanEvidenceComponent[];
  diagnosisRequired: boolean;
}): { ready: boolean; reason: string; required: number; available: number; diagnosticAvailable: number } {
  const required = input.facets.length;
  const available = input.components.filter((component) =>
    component.evidenceRefs.length > 0 &&
    component.ownerRefs.length > 0 &&
    (component.relationRefs.length > 0 || !component.requiredForClosure)
  ).length;
  const diagnosticAvailable = input.components.filter((component) => component.supportsDiagnosis).length;
  if (available < required) {
    return {
      ready: false,
      reason: `independent_goal_evidence_components_missing:${available}/${required}`,
      required,
      available,
      diagnosticAvailable,
    };
  }
  return {
    ready: true,
    reason: "independent_goal_evidence_components_available",
    required,
    available,
    diagnosticAvailable,
  };
}

/**
 * Validate the model-authored semantic G -> B mapping against runtime-owned B
 * components. Runtime verifies identities and independence, but never guesses
 * which component semantically belongs to a user's goal.
 */
export function validatePlanGoalEvidenceBases(input: {
  facets: readonly PlanGoalFacetContract[];
  components: readonly PlanEvidenceComponent[];
  mappings: readonly PlanGoalEvidenceBasis[];
  diagnoses: readonly PlanGoalEvidenceDiagnosisLike[];
  diagnosisRequired: boolean;
}): string[] {
  const failures: string[] = [];
  const goalIds = new Set(input.facets.map((goal) => goal.id));
  const componentById = new Map(input.components.map((component) => [component.id, component]));
  const diagnosisById = new Map(input.diagnoses.map((diagnosis) => [diagnosis.id, diagnosis]));
  const componentOwners = new Map<string, string>();

  for (const [index, mapping] of input.mappings.entries()) {
    const label = mapping.componentRef || String(index + 1);
    if (!goalIds.has(mapping.goalRef)) failures.push(`typed_goal_evidence_goal_invalid:${label}`);
    const component = componentById.get(mapping.componentRef);
    if (!component) {
      failures.push(`typed_goal_evidence_component_invalid:${label}`);
      continue;
    }
    const previousGoal = componentOwners.get(component.id);
    if (previousGoal && previousGoal !== mapping.goalRef) {
      failures.push(`typed_goal_evidence_component_reused:${component.id}:${previousGoal},${mapping.goalRef}`);
    } else if (previousGoal) {
      failures.push(`typed_goal_evidence_component_duplicate:${component.id}`);
    } else {
      componentOwners.set(component.id, mapping.goalRef);
    }
    if (!setsEqual(mapping.evidenceRefs, component.evidenceRefs)) {
      failures.push(`typed_goal_evidence_refs_mismatch:${component.id}`);
    }
    if (!setsEqual(mapping.ownerRefs, component.ownerRefs)) {
      failures.push(`typed_goal_evidence_owners_mismatch:${component.id}`);
    }
    if (!setsEqual(mapping.relationRefs, component.relationRefs)) {
      failures.push(`typed_goal_evidence_relations_mismatch:${component.id}`);
    }
    const mappedDiagnoses = unique(mapping.diagnosisRefs)
      .map((reference) => diagnosisById.get(reference));
    if (mappedDiagnoses.some((diagnosis) => !diagnosis)) {
      failures.push(`typed_goal_evidence_diagnosis_invalid:${component.id}`);
    }
    for (const diagnosis of mappedDiagnoses) {
      if (!diagnosis) continue;
      if (!diagnosis.goalRefs.includes(mapping.goalRef)) {
        failures.push(`typed_goal_evidence_diagnosis_goal_mismatch:${component.id}:${diagnosis.id}`);
      }
      if (!component.evidenceRefs.every((reference) => diagnosis.evidenceRefs.includes(reference))) {
        failures.push(`typed_goal_evidence_diagnosis_evidence_mismatch:${component.id}:${diagnosis.id}`);
      }
    }
    if (component.supportsDiagnosis || input.diagnosisRequired) {
      const confirmed = mappedDiagnoses.some((diagnosis) =>
        !!diagnosis && diagnosis.certainty !== "hypothesis" &&
        component.evidenceRefs.every((reference) => diagnosis.evidenceRefs.includes(reference))
      );
      if (!confirmed) failures.push(`typed_goal_evidence_diagnosis_missing:${component.id}`);
    }
  }

  for (const component of input.components) {
    if (component.requiredForClosure && !componentOwners.has(component.id)) {
      failures.push(`typed_goal_evidence_component_unmapped:${component.id}`);
    }
  }
  for (const goal of input.facets) {
    if (!input.mappings.some((mapping) => mapping.goalRef === goal.id)) {
      failures.push(`typed_goal_evidence_basis_missing:${goal.id}`);
    }
  }
  return unique(failures);
}
