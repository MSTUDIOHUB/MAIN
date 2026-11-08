import type { RuntimeV2Command } from "../../lib/runtime-v2";
import type { RuntimeV2ProviderActionWindow } from "./executionContext";
import type { RuntimeV2ExecutionContract } from "./executionContract";
function mergedVisibleLineRanges(
  windows: readonly {
    readonly startLine: number;
    readonly endLine: number;
  }[],
): string[] {
  const ordered = [...windows]
    .filter((window) =>
      window.startLine >= 0 && window.endLine >= window.startLine
    )
    .sort((left, right) =>
      left.startLine - right.startLine ||
      left.endLine - right.endLine
    );
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const window of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && window.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, window.endLine);
    } else {
      merged.push({
        startLine: window.startLine,
        endLine: window.endLine,
      });
    }
  }
  return merged.map((range) =>
    range.startLine === range.endLine
      ? String(range.startLine)
      : `${range.startLine}-${range.endLine}`
  );
}

export function runtimeV2EditableSourceAnchor(
  coverage: readonly {
    readonly target: string;
    readonly version: string;
    readonly complete: boolean;
    readonly windows: readonly {
      readonly startLine: number;
      readonly endLine: number;
    }[];
  }[],
): string {
  if (coverage.length === 0) return "";
  return [
    "[editable_source_v1]",
    JSON.stringify({
      existingTargets: coverage.map((entry) => ({
        target: entry.target,
        version: entry.version,
        visibleLineRanges: mergedVisibleLineRanges(entry.windows),
        complete: entry.complete,
        eligibleEditors: ["replace_in_file", "apply_patch"],
      })),
    }),
  ].join(" ");
}

export function providerModeInstruction(
  command: RuntimeV2Command,
  preferredValidationCommand = "",
  toolSurface: {
    readonly hasReadFile: boolean;
    readonly hasMutation: boolean;
    readonly hasCreateFile?: boolean;
    readonly hasSpawnSubagent: boolean;
    readonly hasWaitSubagents: boolean;
    readonly hasMaterializedSourceEvidence?: boolean;
    readonly sourceOnlyFrontier?: boolean;
    readonly materializedSourceCoverage?: readonly {
      readonly target: string;
      readonly version: string;
      readonly complete: boolean;
      readonly windows: readonly {
        readonly startLine: number;
        readonly endLine: number;
      }[];
    }[];
    readonly actionWindow?: RuntimeV2ProviderActionWindow | null;
    readonly executionContract?: RuntimeV2ExecutionContract | null;
    readonly executionContractAdvanceRequired?: boolean;
    readonly executionContractCommittedTargets?: readonly string[];
    readonly executionContractPendingTargets?: readonly string[];
    readonly executionContractSourceReviewAvailable?: boolean;
    readonly executionContractSourceReviewTargets?: readonly string[];
    readonly validationCorrectionActive?: boolean;
    readonly validationCommandUnavailable?: boolean;
    readonly failedValidationCommand?: string | null;
    readonly replacementValidationExhausted?: boolean;
  } = {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    hasMaterializedSourceEvidence: false,
    sourceOnlyFrontier: false,
    actionWindow: null,
    executionContract: null,
    executionContractAdvanceRequired: false,
    executionContractCommittedTargets: [],
    executionContractPendingTargets: [],
    executionContractSourceReviewAvailable: false,
    executionContractSourceReviewTargets: [],
    validationCorrectionActive: false,
    validationCommandUnavailable: false,
    failedValidationCommand: null,
    replacementValidationExhausted: false,
  },
): string {
  const mode = String(command.payload.mode || "").trim();
  const activeSubagents = Array.isArray(command.payload.activeSubagents)
    ? command.payload.activeSubagents
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const record = entry as Record<string, unknown>;
          const id = String(record.id || "").trim();
          const name = String(record.name || "").trim();
          const objective = String(record.objective || "").trim();
          return id
            ? `${name || id} (${id}): ${objective}`.slice(0, 600)
            : "";
        })
        .filter(Boolean)
    : [];
  const failedSubagents = Array.isArray(command.payload.failedSubagents)
    ? command.payload.failedSubagents
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const record = entry as Record<string, unknown>;
          const id = String(record.id || "").trim();
          const summary = String(record.summary || "").trim();
          return id
            ? `${id}: ${summary || "no structured report"}`.slice(0, 600)
            : "";
        })
        .filter(Boolean)
    : [];
  const remainingSubagentCapacity = Math.max(
    0,
    Math.floor(Number(command.payload.remainingSubagentCapacity) || 0),
  );
  const collaborationGuidance = [
    failedSubagents.length > 0
      ? `Previous child work did not complete (${failedSubagents.join("; ")}). Continue the objective directly; child failure is never a blocker.`
      : "",
    toolSurface.hasWaitSubagents
      ? `Child work is active (${activeSubagents.join("; ")}). Continue independent parent work and call wait_subagents only when its evidence or staged mutation becomes a dependency.`
      : "",
    toolSurface.hasSpawnSubagent
      ? [
          command.payload.collaborationPreferred === true
            ? `The user explicitly prefers collaboration; current child-request capacity is ${remainingSubagentCapacity}, and independent tasks may queue. Keep each child objective and success criteria within the user's requested deliverable and depth. Delegate an independent result only when its benefit justifies coordination, and continue non-dependent parent work in parallel. This preference applies at inspect, edit, or verify; it is not a mandatory lifecycle stage. For a simple or linear task, proceed directly without explaining why no child was used.`
            : "Delegation is optional.",
          "Use read-only children for parallel investigation. Use implement/write only after the parent has an evidence-backed solution: provide an explicit operation, implementation_plan, success criteria, and every exact non-overlapping file target; never grant a directory and let the child choose writes. The child stages one transaction and Runtime commits it at join; the parent still owns cross-file integration and final validation. Never delegate merely because a parent action failed or because the next action is difficult.",
        ].join(" ")
      : "",
  ].filter(Boolean).join(" ");
  const recoveryPressure =
    command.payload.recoveryPressure &&
      typeof command.payload.recoveryPressure === "object" &&
      !Array.isArray(command.payload.recoveryPressure)
      ? command.payload.recoveryPressure as Record<string, unknown>
      : null;
  const recoveryOccurrence = Math.max(
    0,
    Math.floor(Number(recoveryPressure?.occurrence) || 0),
  );
  const recoveryStage = String(recoveryPressure?.stage || "").trim();
  const recoveringCompleteReply = recoveryPressure?.reason === "non_actionable_response";
  const recoveryGuidance = recoveryPressure
    ? recoveringCompleteReply
      ? `Previous response had no tool call (${String(recoveryPressure.reason)}). Use the actual prior result: take the next authorized action if work remains, give a complete final report when successful receipts cover the full request, or ask a focused question if user input is required.`
      : mode === "validate" && !toolSurface.validationCorrectionActive
        ? ""
        : `Previous action made no progress (${String(recoveryPressure.reason || "non_actionable_response")}, attempt ${recoveryOccurrence}, stage ${recoveryStage || "retry"}). Check the latest tool error or file snippet and try a different approach or smaller edit.`
    : "";
  if (mode === "chat" || mode === "analyze" || (mode === "conclude" && command.payload.conclusionKind === "read_only")) {
    if (mode === "conclude") {
      return "Return a clear, complete Markdown answer based on the conversation and gathered evidence. Tools are closed for this final reply.";
    }
    return [
      mode === "chat"
        ? "Answer the user directly, using available read/search tools only when needed."
        : "Inspect the relevant files or sources with read-only tools, then provide a complete Markdown answer.",
      recoveryGuidance,
      mode === "analyze" ? collaborationGuidance : "",
    ].filter(Boolean).join(" ");
  }
  if (mode === "conclude") {
    return [
      "Summarize the completed changes, files modified, validations run, and any remaining caveats. Do not call more tools.",
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  const sourceGuidance = toolSurface.hasMutation
    ? [
        toolSurface.hasMaterializedSourceEvidence
          ? "For modifications to an existing file, use only its exact current source visible in this decision request. Each existing target needs its own versioned source lease; observing one file does not authorize edits to another."
          : command.payload.hasVersionedSourceEvidence === true
            ? "Existing-file source is cached but is not visible in this decision request; this does not authorize edits to those files. Request the exact missing target window so Runtime can replay it without another disk read."
            : "Read the exact current target before modifying an existing file.",
        runtimeV2EditableSourceAnchor(toolSurface.materializedSourceCoverage || []),
      ].filter(Boolean).join(" ")
    : "";
  const creationGuidance = toolSurface.hasCreateFile &&
      !toolSurface.actionWindow && !toolSurface.validationCorrectionActive &&
      !toolSurface.executionContractAdvanceRequired
    ? "New files within the user's authorized objective do not require existing-file source; use write_file when creation is needed. The preflight still checks whether the target already exists."
    : "";
  const objectiveGuidance = [
    "Choose the next authorized action to advance the user's complete objective. Make a workspace change only when the user's current request authorizes that effect.",
    toolSurface.sourceOnlyFrontier
      ? "Source evidence alone does not make its files mandatory edit targets. Safe reads remain available for a specific missing fact that blocks the next authorized action."
      : "",
    "Commands and external operations use their own authorization and result evidence, without an unrelated file-source lease or write obligation. For a command or external-operation task, a complete final report is appropriate when actual successful receipts cover the user's full request. A successful intermediate action does not require you to stop; file mutations still require subsequent matching validation.",
  ].filter(Boolean).join(" ");
  const validationGuidance = [
    toolSurface.validationCorrectionActive
      ? "[VALIDATION_CORRECTION] Use the actual failed validation diagnostics to identify the missing fact or smallest correction; safe reads remain available. Re-verify after the correction."
      : "",
    toolSurface.validationCommandUnavailable
      ? `The previous validation command is unavailable${toolSurface.failedValidationCommand ? `: ${JSON.stringify(toolSurface.failedValidationCommand)}` : ""}. Choose an available finite validator that tests the same required behavior; do not repeat the unavailable command.`
      : "",
  ].filter(Boolean).join(" ");
  const contractGuidance = toolSurface.executionContract
    ? `[execution_contract_v1] ${JSON.stringify(toolSurface.executionContract)} Follow the recorded exact operations and do not broaden into cleanup or redesign; revise it from new evidence when the solution changes. Safe reads and finite checks remain available; early checks cannot discharge pending contract targets or newer mutation debt.`
    : "";
  if (mode === "validate") {
    return [
      recoveryGuidance,
      "Verify the latest committed mutation by running a finite validation tool (such as run_command for build/test/lint/typecheck, or browser_evaluate/computer_use for UI verification) before returning your final summary; read_file or prose alone does not satisfy validation. Still-needed authorized external actions remain available. Ordinary shell actions produce tool results and do not discharge file validation debt attached to the newest committed mutation. If verification reveals an issue, fix the code and re-verify.",
      sourceGuidance,
      creationGuidance,
      validationGuidance,
      contractGuidance,
      preferredValidationCommand
        ? `Preferred validation command: ${JSON.stringify(preferredValidationCommand)}.`
        : "",
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  return [
    recoveryGuidance,
    objectiveGuidance,
    sourceGuidance,
    creationGuidance,
    validationGuidance,
    contractGuidance,
    preferredValidationCommand
      ? `Preferred validation command: ${JSON.stringify(preferredValidationCommand)}.`
      : "",
    collaborationGuidance,
  ].filter(Boolean).join(" ");
}
