import type { ExecuteRecoveryNextCapability, ExecuteRecoveryMode } from "../../executeRecoveryTools";
import {
  buildExecuteEvidenceClosureAudit,
  resolveLatestUnreconciledFailureSignal,
  scopeExecutionEvidenceLedger,
  type ExecuteEvidenceGap,
} from "../../verificationEvidence";
import type { PlanExecutionEvidenceEntry } from "../../workflowModels";
import { WORKSPACE_MUTATION_TOOL_NAMES } from "../../workspaceMutationTools";

export interface PreCompletionEvidenceRecoveryDecision {
  gap: Exclude<ExecuteEvidenceGap, "none">;
  mode: Exclude<ExecuteRecoveryMode, "normal">;
  reason: string;
  expectedTarget: string | null;
  nextRequiredCapability: ExecuteRecoveryNextCapability;
}

function reconcileWithActiveRecovery(
  decision: PreCompletionEvidenceRecoveryDecision,
  input: {
    currentRecoveryMode: ExecuteRecoveryMode;
    currentRequiredCapability?: ExecuteRecoveryNextCapability | null;
  },
): PreCompletionEvidenceRecoveryDecision | null {
  if (input.currentRecoveryMode === "normal") return decision;
  // Older callers/snapshots do not carry the active capability. Preserve the
  // existing transaction rather than guessing and resetting its progress.
  if (!input.currentRequiredCapability) return null;
  // Re-activating the same capability on every no-tool turn would reset the
  // phase budget. Only a changed ledger gap may replace an active contract.
  return input.currentRequiredCapability === decision.nextRequiredCapability
    ? null
    : decision;
}

function latestMutationTarget(ledger: PlanExecutionEvidenceEntry[]): string | null {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index];
    if (entry.kind !== "file" && entry.kind !== "deliverable") continue;
    return String(entry.target || entry.value || "").trim() || null;
  }
  return null;
}

function hasAnyTool(availableToolNames: Set<string>, toolNames: Iterable<string>): boolean {
  for (const toolName of toolNames) {
    if (availableToolNames.has(toolName)) return true;
  }
  return false;
}

/**
 * Convert a precise evidence-ledger gap into the next recovery capability.
 * This runs before final text is committed, so a model-authored completion
 * claim cannot end the turn while an automatable obligation is still open.
 */
export function resolvePreCompletionEvidenceRecoveryDecision(input: {
  ledger: PlanExecutionEvidenceEntry[];
  validationExpected: boolean;
  mutationExpected: boolean;
  transactionId?: string | null;
  requiredCommandEvidence?: string[];
  currentRecoveryMode: ExecuteRecoveryMode;
  currentRequiredCapability?: ExecuteRecoveryNextCapability | null;
  availableToolNames: Set<string>;
}): PreCompletionEvidenceRecoveryDecision | null {
  const audit = buildExecuteEvidenceClosureAudit({
    ledger: input.ledger,
    validationExpected: input.validationExpected,
    mutationExpected: input.mutationExpected,
    transactionId: input.transactionId,
    requiredCommandEvidence: input.requiredCommandEvidence,
  });
  if (audit.completionAllowed || audit.gap === "none") return null;
  const scopedLedger = scopeExecutionEvidenceLedger(input.ledger, input.transactionId);
  const expectedTarget = latestMutationTarget(scopedLedger);

  if (
    audit.gap === "mutation_required" &&
    hasAnyTool(input.availableToolNames, WORKSPACE_MUTATION_TOOL_NAMES)
  ) {
    return reconcileWithActiveRecovery({
      gap: audit.gap,
      mode: "mutation_first",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "mutation",
    }, input);
  }

  if (
    (audit.gap === "validation_required" || audit.gap === "validation_after_mutation_required") &&
    input.availableToolNames.has("run_command")
  ) {
    return reconcileWithActiveRecovery({
      gap: audit.gap,
      mode: "finite_validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "validation",
    }, input);
  }
  if (
    audit.gap === "pty_observation_required" &&
    hasAnyTool(input.availableToolNames, ["get_pty_status", "read_pty_since"])
  ) {
    return reconcileWithActiveRecovery({
      gap: audit.gap,
      mode: "validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "observe_pty",
    }, input);
  }
  if (
    audit.gap === "browser_validation_required" &&
    (audit.longRunningStatus === "ready" || audit.latestReadyAt !== null) &&
    input.availableToolNames.has("browser_evaluate")
  ) {
    return reconcileWithActiveRecovery({
      gap: audit.gap,
      mode: "validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "browser_validation",
    }, input);
  }
  if (
    audit.gap === "browser_validation_required" &&
    (audit.longRunningStatus === "pending" ||
      audit.longRunningStatus === "running" ||
      audit.longRunningStatus === "unknown") &&
    hasAnyTool(input.availableToolNames, ["get_pty_status", "read_pty_since"])
  ) {
    return reconcileWithActiveRecovery({
      gap: audit.gap,
      mode: "validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "observe_pty",
    }, input);
  }
  if (
    audit.gap === "browser_validation_required" &&
    input.availableToolNames.has("execute_command")
  ) {
    return reconcileWithActiveRecovery({
      gap: audit.gap,
      mode: "validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "launch_long_process",
    }, input);
  }
  if (audit.gap === "unreconciled_failure") {
    const failure = resolveLatestUnreconciledFailureSignal({
      ledger: scopedLedger,
    });
    const repairTarget = failure?.sourceTarget || expectedTarget;

    if (
      failure?.domain !== "process" &&
      repairTarget &&
      hasAnyTool(input.availableToolNames, WORKSPACE_MUTATION_TOOL_NAMES)
    ) {
      return reconcileWithActiveRecovery({
        gap: audit.gap,
        mode: "mutation_first",
        reason: `precompletion_evidence_gap:${audit.gap}:${failure?.domain || "source"}`,
        expectedTarget: repairTarget,
        nextRequiredCapability: "mutation",
      }, input);
    }

    if (failure?.domain === "process") {
      return reconcileWithActiveRecovery({
        gap: audit.gap,
        mode: "action_plus_targeting",
        reason: `precompletion_evidence_gap:${audit.gap}:process`,
        expectedTarget: repairTarget,
        nextRequiredCapability:
          audit.longRunningStatus === "failed" || audit.longRunningStatus === "stopped"
            ? "recover_process"
            : "reconcile_server",
      }, input);
    }

    if (failure?.domain === "browser" && input.availableToolNames.has("browser_evaluate")) {
      return reconcileWithActiveRecovery({
        gap: audit.gap,
        mode: "validation_only",
        reason: `precompletion_evidence_gap:${audit.gap}:browser`,
        expectedTarget: repairTarget,
        nextRequiredCapability: "browser_validation",
      }, input);
    }

    if (input.availableToolNames.has("run_command")) {
      return reconcileWithActiveRecovery({
        gap: audit.gap,
        mode: "finite_validation_only",
        reason: `precompletion_evidence_gap:${audit.gap}:${failure?.domain || "unknown"}`,
        expectedTarget: repairTarget,
        nextRequiredCapability: "validation",
      }, input);
    }

    return null;
  }
  return null;
}
