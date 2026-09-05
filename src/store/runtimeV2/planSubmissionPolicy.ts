import type {
  TurnAggregateV1,
  WorkPlanDraftV1,
} from "../../lib/runtime-v2";

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

export function assertAdmittedPlanCriteriaMapped(input: {
  readonly draft: WorkPlanDraftV1;
  readonly criterionIds: readonly string[];
}): void {
  const missingChanges = input.criterionIds.filter((criterionId) =>
    !input.draft.steps.some((step) =>
      step.criterionIds?.includes(criterionId)
    )
  );
  const missingValidations = input.criterionIds.filter((criterionId) =>
    !input.draft.validations.some((validation) =>
      validation.required && validation.criterionIds?.includes(criterionId)
    )
  );
  if (missingChanges.length === 0 && missingValidations.length === 0) return;
  throw new Error([
    missingChanges.length > 0
      ? `Admitted criteria missing from changes[].criterionIds: ${missingChanges.join(", ")}.`
      : "",
    missingValidations.length > 0
      ? `Admitted criteria missing from required validations[].criterionIds: ${missingValidations.join(", ")}.`
      : "",
  ].filter(Boolean).join(" "));
}
