import type {
  RuntimeV2AcceptanceEvidenceRequirementSlot,
  TurnAggregateV1,
  WorkPlanDraftV1,
} from "../../lib/runtime-v2";
import type { PlanSubmissionDiagnostic } from "../../lib/planDrafts";
import { analyzeValidationCommand } from "../../lib/validationContract";

/**
 * A planning child is useful only when the parent explicitly assesses its
 * returned evidence. Merely joining the child must not satisfy the user's
 * collaboration request or silently promote its report into the WorkPlan.
 */
export function assertCompletedPlanChildrenAdopted(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly draft: WorkPlanDraftV1;
  readonly collaborationRequired?: boolean;
}): void {
  if (!input.aggregate) {
    if (input.collaborationRequired) {
      throw new Error("Required planning collaboration was not admitted.");
    }
    return;
  }
  const currentRunId = input.aggregate.run?.identity.runId;
  const admittedChildren = input.aggregate.subagents.filter((job) =>
    !currentRunId || job.parentRunId === currentRunId
  );
  if (input.collaborationRequired && admittedChildren.length === 0) {
    throw new Error(
      "Required planning collaboration was not admitted. Call spawn_subagent before submitting the WorkPlan.",
    );
  }
  const structuredBasis = new Set([
    ...input.draft.findings.flatMap((finding) => [...finding.basis]),
    ...input.draft.steps.flatMap((step) => [...step.basis]),
  ]);
  const missing = input.aggregate.events.flatMap((event) => {
    if (
      event.type !== "subagent.completed" ||
      event.status !== "completed" ||
      event.evidence.length === 0
    ) {
      return [];
    }
    const evidenceIds = event.evidence.map((evidence) => evidence.id);
    return evidenceIds.some((evidenceId) => structuredBasis.has(evidenceId))
      ? []
      : [{ jobId: event.jobId, evidenceIds }];
  });
  if (missing.length === 0) return;
  throw new Error([
    "Completed planning child evidence must be explicitly assessed before review.",
    ...missing.map((entry) =>
      `Child ${entry.jobId} needs at least one exact ID in changes[].basis: ${entry.evidenceIds.join(", ")}.`
    ),
    "If a child finding is not used, add a preserve finding/change that cites the evidence ID and explains why it does not alter the implementation scope.",
  ].join(" "));
}

function admittedPlanCriteriaGaps(input: {
  readonly draft: WorkPlanDraftV1;
  readonly criterionIds: readonly string[];
  readonly evidenceRequirements?: readonly RuntimeV2AcceptanceEvidenceRequirementSlot[];
}) {
  const missingChanges = input.criterionIds.filter((criterionId) =>
    !input.draft.steps.some((step) =>
      step.criterionIds?.includes(criterionId)
    )
  );
  const executableChecks = input.draft.validations.map(validation => {
    if (!validation.required) return null;
    if (validation.kind === "browser" || validation.kind === "desktop") return "interaction";
    if (validation.kind !== "finite_command") return null;
    const spec = analyzeValidationCommand(validation.command || "", { cwd: validation.cwd }).spec;
    if (spec?.kind !== "finite_command") return null;
    return spec.segments.some(segment => segment.capability === "test" || segment.capability === "inline_assertion")
      ? "behavioral" : "static";
  });
  const covers = (check: typeof executableChecks[number], requirement: RuntimeV2AcceptanceEvidenceRequirementSlot | undefined) =>
    check !== null && (requirement !== "behavioral" || check !== "static") &&
    (requirement !== "interaction" || check === "interaction");
  const requirementByCriterion = new Map(input.criterionIds.map((id, index) => [id, input.evidenceRequirements?.[index]]));
  const missingValidations = input.criterionIds.filter(criterionId => !input.draft.validations.some((validation, index) =>
    validation.criterionIds?.includes(criterionId) && covers(executableChecks[index] ?? null, requirementByCriterion.get(criterionId))));
  const mismatchedValidations = input.draft.validations.flatMap((validation, index) => {
    const criterionIds = validation.criterionIds?.filter(id => missingValidations.includes(id) &&
      !!requirementByCriterion.get(id) && !covers(executableChecks[index] ?? null, requirementByCriterion.get(id))) || [];
    return validation.required && criterionIds.length ? [{ index, kind: validation.kind, criterionIds,
      message: criterionIds.some(id => requirementByCriterion.get(id) === "interaction")
        ? `validations[${index}] needs a required browser or desktop interaction with the expected observable result.`
        : `validations[${index}] needs a runnable test with a pass/fail result or an interaction that demonstrates the required behavior. Build, lint and typecheck can supplement it.` }] : [];
  });
  const nonRequiredValidations = input.draft.validations.flatMap((validation, index) => {
    const criterionIds = validation.criterionIds?.filter((id) => missingValidations.includes(id)) || [];
    const repair = criterionIds.some(id => requirementByCriterion.get(id) === "interaction")
      ? "Provide a required browser or desktop interaction with the expected observable result."
      : criterionIds.some(id => requirementByCriterion.get(id) === "behavioral")
        ? "Provide a required runnable test with a pass/fail result or an interaction that demonstrates the behavior."
        : "Provide a required finite command or interaction for these criteria.";
    return !validation.required && criterionIds.length
      ? [{ index, kind: validation.kind, criterionIds, message: `validations[${index}] (${validation.kind}) ${validation.kind === "assertion" || validation.kind === "advisory"
        ? "is advisory and cannot provide required validation coverage, even when submitted with required=true"
        : "has required=false and cannot provide required validation coverage"}. ${repair}` }]
      : [];
  });
  return { missingChanges, missingValidations, nonRequiredValidations, mismatchedValidations };
}

/** Typed coverage gaps feed draft readiness; prose is presentation only. */
export function admittedPlanCriteriaDiagnostics(input: {
  readonly draft: WorkPlanDraftV1;
  readonly criterionIds: readonly string[];
  readonly evidenceRequirements?: readonly RuntimeV2AcceptanceEvidenceRequirementSlot[];
}): PlanSubmissionDiagnostic[] {
  const { missingChanges, missingValidations, nonRequiredValidations, mismatchedValidations } = admittedPlanCriteriaGaps(input);
  const unrepresented = missingValidations.filter(id => ![...nonRequiredValidations, ...mismatchedValidations].some(validation => validation.criterionIds.includes(id)));
  return [
    ...(missingChanges.length ? [{ code: "plan_change_criterion_missing", fieldPath: "changes[].criterionIds", criterionIds: missingChanges,
      message: `Admitted criteria missing from changes[].criterionIds: ${missingChanges.join(", ")}.` }] : []),
    ...nonRequiredValidations.map(validation => ({ code: "plan_validation_not_required", fieldPath: `validations[${validation.index}]`,
      criterionIds: validation.criterionIds, compiledKind: validation.kind, message: validation.message })),
    ...mismatchedValidations.map(validation => ({ code: "plan_validation_evidence_mismatch", fieldPath: `validations[${validation.index}]`,
      criterionIds: validation.criterionIds, compiledKind: validation.kind, message: validation.message })),
    ...(unrepresented.length ? [{ code: "plan_validation_missing", fieldPath: "validations", criterionIds: unrepresented,
      message: `Admitted criteria missing from required validations[].criterionIds: ${unrepresented.join(", ")}.` }] : []),
  ];
}

export function assertAdmittedPlanCriteriaMapped(input: {
  readonly draft: WorkPlanDraftV1;
  readonly criterionIds: readonly string[];
}): void {
  const { missingChanges, missingValidations, nonRequiredValidations } = admittedPlanCriteriaGaps(input);
  if (missingChanges.length === 0 && missingValidations.length === 0) return;
  throw new Error([
    missingChanges.length > 0
      ? `Admitted criteria missing from changes[].criterionIds: ${missingChanges.join(", ")}.`
      : "",
    missingValidations.length > 0
      ? nonRequiredValidations.length > 0
        ? `Admitted criteria lack required validation coverage: ${missingValidations.join(", ")}. ${nonRequiredValidations.map(validation => validation.message).join(" ")} Provide an authorized finite_command, browser, or desktop validation specification for the missing criteria; planning describes the check without executing it.`
        : `Admitted criteria missing from required validations[].criterionIds: ${missingValidations.join(", ")}.`
      : "",
  ].filter(Boolean).join(" "));
}
