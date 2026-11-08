import type { PlanSubmissionDiagnostic } from "../../lib/planDrafts";
import {
  sealWorkPlanV1,
  validateWorkPlanDraftV1,
  type SealedWorkPlanV1,
  type TurnAggregateV1,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import { admittedPlanCriteriaDiagnostics, assertCompletedPlanChildrenAdopted } from "./planSubmissionPolicy";
import { workPlanDraftFromSubmission, type WorkPlanValidationOrigin } from "./workPlanSubmission";
import { SUBMIT_WORK_PLAN_TOOL } from "./planModelProtocol";
import { runtimeV2ProviderToolArgumentViolation } from "./executionProviderToolSchema";

export type PlanSubmissionAssessment =
  | { readonly kind: "reviewable"; readonly sealedPlan: SealedWorkPlanV1; readonly normalizationReasons: readonly string[] }
  | { readonly kind: "draft"; readonly diagnostics: readonly PlanSubmissionDiagnostic[]; readonly normalizationReasons: readonly string[] };

const COMMAND_REPAIR: Record<NonNullable<WorkPlanValidationOrigin["commandRejectionReason"]>, string> = {
  empty_command: "Supply the finite command for the required check.",
  unsafe_shell_syntax: "Use a direct finite check without unsupported shell syntax.",
  background_process: "Run the check in the foreground and let it exit.",
  pipeline_exit_status_ambiguous: "Run the check directly so its failing exit status is observable.",
  non_fail_fast_connector: "Run checks separately or use a fail-fast chain that preserves the failing exit status.",
  mixed_service_and_acceptance: "Separate service setup from the finite check. Only the check can supply required acceptance.",
  unbounded_command_segment: "This command segment is not recognized as a finite check. Editor operations and value-printing probes do not supply a verdict. Use a runnable test with a pass/fail result.",
  inline_assertion_missing_failure_semantics: "Make a failed assertion produce a non-zero exit status. Printing the value does not verify it.",
  no_validation_segment: "Include a command that actually performs the required check.",
  service_observation: "A service startup is advisory. Use a separate finite check that exits with a pass/fail result.",
};

/** Assess executable readiness without interpreting error prose or discarding
 * the user's reviewable document when that readiness is incomplete. */
export function assessPlanSubmission(input: {
  readonly candidate: Record<string, unknown>;
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly objective: string;
  readonly criterionIds: readonly string[];
  readonly aggregate: TurnAggregateV1 | null;
  readonly collaborationRequired?: boolean;
  readonly requireBehavioralValidation?: boolean;
  readonly decisionJournal?: string;
  readonly createdAt?: number;
}): PlanSubmissionAssessment {
  let compiled: ReturnType<typeof workPlanDraftFromSubmission>;
  try {
    compiled = workPlanDraftFromSubmission(input.candidate, input.evidence, input.objective, input.criterionIds);
  } catch (error) {
    return { kind: "draft", normalizationReasons: [], diagnostics: [{ code: "plan_submission_compile_invalid", fieldPath: "$",
      criterionIds: [...input.criterionIds], message: error instanceof Error ? error.message : String(error) }] };
  }
  const { draft, normalizationReasons, validationOrigins } = compiled;
  const origins = new Map(validationOrigins.map(origin => [origin.fieldPath, origin]));
  const evidenceRequirements = input.requireBehavioralValidation
    ? input.criterionIds.map((_, index) => input.aggregate?.objective.acceptanceEvidenceRequirements?.[index] ?? "behavioral")
    : undefined;
  const diagnostics: PlanSubmissionDiagnostic[] = admittedPlanCriteriaDiagnostics({ draft, criterionIds: input.criterionIds, evidenceRequirements })
    .map(diagnostic => {
      const validationOrigin = origins.get(diagnostic.fieldPath);
      if (!validationOrigin) return diagnostic;
      const { commandRepairHint, ...origin } = validationOrigin;
      const reason = origin.commandRejectionReason;
      if (!reason) return { ...diagnostic, ...origin };
      const fieldPath = `${diagnostic.fieldPath}.command`;
      const needsInteraction = input.criterionIds.some((id, index) =>
        evidenceRequirements?.[index] === "interaction" && diagnostic.criterionIds.includes(id));
      const message = needsInteraction ? `Command rejected (${reason}). ${diagnostic.message}` : commandRepairHint ?? COMMAND_REPAIR[reason];
      return { ...diagnostic, ...origin, fieldPath, message: `${fieldPath}: ${message}` };
    });
  // Keep the original ingress contract as a readiness requirement. The
  // effect-free ingress preserves prose; compiler defaults do not cure a
  // missing required field or turn an incomplete candidate into approval.
  const shape = runtimeV2ProviderToolArgumentViolation([{ id: "plan-assessment", name: SUBMIT_WORK_PLAN_TOOL.function.name, arguments: input.candidate }], [SUBMIT_WORK_PLAN_TOOL]);
  if (shape) diagnostics.push({ code: "plan_structure_invalid", fieldPath: shape.fieldPath.replace(/^arguments\.?/, "") || "$",
    criterionIds: [...input.criterionIds], message: shape.reason });
  try {
    assertCompletedPlanChildrenAdopted({ aggregate: input.aggregate, draft, collaborationRequired: input.collaborationRequired });
  } catch (error) {
    diagnostics.push({ code: "plan_collaboration_incomplete", fieldPath: "changes[].basis", criterionIds: [...input.criterionIds],
      message: error instanceof Error ? error.message : String(error) });
  }
  try {
    diagnostics.push(...validateWorkPlanDraftV1(draft, input.evidence.map(item => item.id), input.evidence).map(issue => ({
      code: "plan_structure_invalid", fieldPath: issue.path, criterionIds: [...input.criterionIds],
      message: /^validations\[\d+\]\.stepIndexes$/.test(issue.path) && draft.steps.length > 0
        ? `${issue.message} Reference changes[] using zero-based indexes from 0 to ${draft.steps.length - 1}.`
        : issue.message,
    })));
  } catch (error) {
    diagnostics.push({ code: "plan_structure_invalid", fieldPath: "$", criterionIds: [...input.criterionIds],
      message: error instanceof Error ? error.message : String(error) });
  }
  if (diagnostics.length) return { kind: "draft", diagnostics, normalizationReasons };
  try {
    return { kind: "reviewable", normalizationReasons, sealedPlan: sealWorkPlanV1({ draft, evidence: input.evidence,
      createdAt: input.createdAt ?? Date.now(), ...(input.decisionJournal !== undefined ? { decisionJournal: input.decisionJournal } : {}) }) };
  } catch (error) {
    return { kind: "draft", normalizationReasons, diagnostics: [{ code: "plan_structure_invalid", fieldPath: "$",
      criterionIds: [...input.criterionIds], message: error instanceof Error ? error.message : String(error) }] };
  }
}
