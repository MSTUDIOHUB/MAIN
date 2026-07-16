import type { ExecuteRecoveryNextCapability, ExecuteRecoveryMode } from "../../executeRecoveryTools";
import { buildExecuteEvidenceClosureAudit, type ExecuteEvidenceGap } from "../../verificationEvidence";
import type { PlanExecutionEvidenceEntry } from "../../workflowModels";
import { WORKSPACE_MUTATION_TOOL_NAMES } from "../../workspaceMutationTools";

export interface PreCompletionEvidenceRecoveryDecision {
  gap: Exclude<ExecuteEvidenceGap, "none">;
  mode: Exclude<ExecuteRecoveryMode, "normal">;
  reason: string;
  expectedTarget: string | null;
  nextRequiredCapability: ExecuteRecoveryNextCapability;
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
  currentRecoveryMode: ExecuteRecoveryMode;
  availableToolNames: Set<string>;
}): PreCompletionEvidenceRecoveryDecision | null {
  if (input.currentRecoveryMode !== "normal") return null;
  const audit = buildExecuteEvidenceClosureAudit({
    ledger: input.ledger,
    validationExpected: input.validationExpected,
  });
  if (audit.completionAllowed || audit.gap === "none") return null;
  const expectedTarget = latestMutationTarget(input.ledger);

  if (
    audit.gap === "validation_after_mutation_required" &&
    input.availableToolNames.has("run_command")
  ) {
    return {
      gap: audit.gap,
      mode: "finite_validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "validation",
    };
  }
  if (
    audit.gap === "pty_observation_required" &&
    hasAnyTool(input.availableToolNames, ["get_pty_status", "read_pty_since"])
  ) {
    return {
      gap: audit.gap,
      mode: "validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "observe_pty",
    };
  }
  if (
    audit.gap === "browser_validation_required" &&
    (audit.longRunningStatus === "ready" || audit.latestReadyAt !== null) &&
    input.availableToolNames.has("browser_evaluate")
  ) {
    return {
      gap: audit.gap,
      mode: "validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "browser_validation",
    };
  }
  if (
    audit.gap === "browser_validation_required" &&
    (audit.longRunningStatus === "pending" ||
      audit.longRunningStatus === "running" ||
      audit.longRunningStatus === "unknown") &&
    hasAnyTool(input.availableToolNames, ["get_pty_status", "read_pty_since"])
  ) {
    return {
      gap: audit.gap,
      mode: "validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "observe_pty",
    };
  }
  if (
    audit.gap === "browser_validation_required" &&
    input.availableToolNames.has("execute_command")
  ) {
    return {
      gap: audit.gap,
      mode: "validation_only",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability: "launch_long_process",
    };
  }
  if (
    audit.gap === "unreconciled_failure" &&
    (
      input.availableToolNames.has("run_command") ||
      input.availableToolNames.has("browser_evaluate") ||
      hasAnyTool(input.availableToolNames, WORKSPACE_MUTATION_TOOL_NAMES)
    )
  ) {
    return {
      gap: audit.gap,
      mode: "action_plus_targeting",
      reason: `precompletion_evidence_gap:${audit.gap}`,
      expectedTarget,
      nextRequiredCapability:
        audit.longRunningStatus === "failed" || audit.longRunningStatus === "stopped"
          ? "recover_process"
          : "reconcile_server",
    };
  }
  return null;
}
