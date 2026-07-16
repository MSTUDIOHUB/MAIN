import {
  buildPlanTaskEvidenceAudit,
  findUnsatisfiedPlanTaskEvidence,
  planTaskHasUnsatisfiedSourceMutationEvidence,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
} from "../../workflowModels";

const AUTOMATIC_VALIDATION_EVIDENCE_KINDS = new Set([
  "cmd",
  "browser_dom",
  "browser_screenshot",
  "dev_server_url",
]);

export interface ApprovedPlanTurnExpectations {
  workspaceMutationExpected?: boolean;
  workspaceValidationExpected?: boolean;
}

/**
 * Project an approved Plan's current evidence gaps into the turn contract.
 * Approval provenance survives the Plan -> execute intent transition, while
 * manual or external review items remain advisory instead of becoming an
 * automatic validation gate.
 */
export function resolveApprovedPlanTurnExpectations(input: {
  planApproved: boolean;
  tasks: PlanTask[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
}): ApprovedPlanTurnExpectations {
  if (!input.planApproved) return {};

  const evidenceLedger = Array.isArray(input.evidenceLedger)
    ? input.evidenceLedger
    : [];
  const audit = buildPlanTaskEvidenceAudit({
    tasks: Array.isArray(input.tasks) ? input.tasks : [],
    evidenceLedger,
    preserveMissing: true,
  });
  const hasKnownPlanTasks = audit.totalCount > 0;

  return {
    workspaceMutationExpected: audit.remainingTasks.some((task) =>
      planTaskHasUnsatisfiedSourceMutationEvidence(task, evidenceLedger)
    ),
    workspaceValidationExpected: !hasKnownPlanTasks || audit.remainingTasks.some((task) =>
      task.executionKind === "validation" ||
      findUnsatisfiedPlanTaskEvidence(task, evidenceLedger).some((item) =>
        AUTOMATIC_VALIDATION_EVIDENCE_KINDS.has(item.kind)
      )
    ),
  };
}
