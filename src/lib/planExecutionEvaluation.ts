import type { CommandDirective } from "./runIntent";
import {
  buildPlanTaskEvidenceAudit,
  canDowngradeUnavailableBrowserValidationToAdvisory,
  hasBrowserValidationCapability,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
  type PlanTaskEvidenceAudit,
} from "./workflowModels";
import {
  buildExecuteEvidenceClosureAudit,
  resolveCommandEvidenceRequirements,
  type ExecuteEvidenceClosureAudit,
  type ExecuteEvidenceGap,
} from "./verificationEvidence";

export type ApprovedPlanValidationBoundary = ReturnType<
  typeof resolveApprovedPlanValidationBoundary
>;

export type ApprovedPlanCompletionGapKind =
  | "none"
  | "task_set_empty"
  | "task_evidence_incomplete"
  | "evidence_closure_incomplete"
  | "active_recovery";

export type ApprovedPlanCompletionGapCode =
  | "none"
  | "plan_tasks_missing"
  | "plan_task_evidence_incomplete"
  | `execute_evidence:${ExecuteEvidenceGap}`
  | `active_recovery:${string}`;

export interface ApprovedPlanCompletionGap {
  kind: ApprovedPlanCompletionGapKind;
  code: ApprovedPlanCompletionGapCode;
  remainingTaskIds: string[];
  evidenceGap: ExecuteEvidenceGap;
  activeRecoveryMode: string | null;
}

export interface ApprovedPlanExecutionEvaluation {
  taskAudit: PlanTaskEvidenceAudit;
  evidenceClosure: ExecuteEvidenceClosureAudit;
  validationBoundary: ApprovedPlanValidationBoundary;
  activeRecoveryPending: boolean;
  completionAllowed: boolean;
  gap: ApprovedPlanCompletionGap;
}

export interface ApprovedPlanExecutionEvaluationInput {
  tasks: PlanTask[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
  availableToolNames?: Set<string>;
  activeRecovery?: { mode: string } | null;
  turnId?: string | null;
  commandDirective?: CommandDirective | null;
}

/**
 * Derive the remaining validation boundary from typed task evidence and the
 * capabilities actually exposed to this Turn. This completion rule belongs to
 * the evidence evaluator, not to a prompt or model-response parser.
 */
export function resolveApprovedPlanValidationBoundary(input: {
  audit: PlanTaskEvidenceAudit | null;
  availableToolNames: Set<string>;
}): "none" | "browser_prompt" | "pause_browser_unavailable" | "pause_external_validation" {
  const audit = input.audit;
  if (!audit) return "none";
  const browserAvailable = hasBrowserValidationCapability(input.availableToolNames);
  if (audit.pendingExternalValidation && audit.automationComplete) {
    return "pause_external_validation";
  }
  if (audit.allTrustedComplete) return "none";
  const remaining = audit.remainingTasks;
  if (remaining.length === 0) return "none";
  const allBrowser = remaining.every(isPlanTaskAwaitingBrowserValidation);
  const allExternal = remaining.every(isPlanTaskAwaitingExternalValidation);
  if (allBrowser && browserAvailable) return "browser_prompt";
  if (allBrowser) {
    return canDowngradeUnavailableBrowserValidationToAdvisory(audit)
      ? "pause_external_validation"
      : "pause_browser_unavailable";
  }
  if (allExternal) return "pause_external_validation";
  return "none";
}

function buildCompletionGap(input: {
  taskAudit: PlanTaskEvidenceAudit;
  evidenceClosure: ExecuteEvidenceClosureAudit;
  activeRecoveryMode: string | null;
}): ApprovedPlanCompletionGap {
  const remainingTaskIds = input.taskAudit.remainingTasks.map((task) => task.id);
  const common = {
    remainingTaskIds,
    evidenceGap: input.evidenceClosure.gap,
    activeRecoveryMode: input.activeRecoveryMode,
  };
  if (input.activeRecoveryMode) {
    return {
      ...common,
      kind: "active_recovery",
      code: `active_recovery:${input.activeRecoveryMode}`,
    };
  }
  if (input.taskAudit.totalCount === 0) {
    return { ...common, kind: "task_set_empty", code: "plan_tasks_missing" };
  }
  if (!input.taskAudit.acceptedCompletion) {
    return {
      ...common,
      kind: "task_evidence_incomplete",
      code: "plan_task_evidence_incomplete",
    };
  }
  if (!input.evidenceClosure.completionAllowed) {
    return {
      ...common,
      kind: "evidence_closure_incomplete",
      code: `execute_evidence:${input.evidenceClosure.gap}`,
    };
  }
  return { ...common, kind: "none", code: "none" };
}

/**
 * Provider-neutral completion truth for an approved Plan.
 *
 * Model prose, persisted Plan stage, and caller-local booleans are deliberately
 * excluded. Completion is projected only from the reviewed task contract, the
 * transaction-scoped evidence ledger, the available validation boundary, and
 * the runtime recovery state.
 */
export function evaluateApprovedPlanExecution(
  input: ApprovedPlanExecutionEvaluationInput,
): ApprovedPlanExecutionEvaluation {
  const baseTaskAudit = buildPlanTaskEvidenceAudit({
    tasks: input.tasks,
    evidenceLedger: input.evidenceLedger,
    highlightNext: true,
  });
  const validationBoundary = resolveApprovedPlanValidationBoundary({
    audit: baseTaskAudit,
    availableToolNames: input.availableToolNames || new Set<string>(),
  });
  const taskAudit = validationBoundary === "pause_external_validation"
    ? { ...baseTaskAudit, acceptedCompletion: true }
    : baseTaskAudit;
  const evidenceClosure = buildExecuteEvidenceClosureAudit({
    ledger: input.evidenceLedger,
    validationExpected: true,
    transactionId: input.turnId || null,
    requiredCommandEvidence: resolveCommandEvidenceRequirements({
      tasks: input.tasks,
      commandDirective: input.commandDirective || null,
    }),
  });
  const activeRecoveryMode = input.activeRecovery && input.activeRecovery.mode !== "normal"
    ? input.activeRecovery.mode
    : null;
  const activeRecoveryPending = activeRecoveryMode !== null;
  const completionAllowed =
    taskAudit.totalCount > 0 &&
    taskAudit.acceptedCompletion &&
    evidenceClosure.completionAllowed &&
    !activeRecoveryPending;
  const gap = buildCompletionGap({
    taskAudit,
    evidenceClosure,
    activeRecoveryMode,
  });

  return {
    taskAudit,
    evidenceClosure,
    validationBoundary,
    activeRecoveryPending,
    completionAllowed,
    gap,
  };
}
