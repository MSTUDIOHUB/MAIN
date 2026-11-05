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
            ? `The user explicitly prefers collaboration and ${remainingSubagentCapacity} new child slot(s) are available. Keep each child objective and success criteria within the user's requested deliverable and depth. Delegate an independent result only when its benefit justifies coordination, and continue non-dependent parent work in parallel. This preference applies at inspect, edit, or verify; it is not a mandatory lifecycle stage. For a simple or linear task, proceed directly without explaining why no child was used.`
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
      ? `Previous response had no tool call (${String(recoveryPressure.reason)}). Take the next tool action if work remains, or ask a focused question if user input is required.`
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
  if (mode === "validate") {
    return [
      recoveryGuidance,
      "Verify the latest workspace changes by running a finite validation tool (such as run_command for build/test/lint/typecheck, or browser_evaluate/computer_use for UI verification) before returning your final summary; read_file or prose alone does not satisfy validation. If verification reveals an issue, fix the code and re-verify.",
      preferredValidationCommand
        ? `Preferred validation command: ${JSON.stringify(preferredValidationCommand)}.`
        : "",
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  return [
    recoveryGuidance,
    "Inspect relevant files, make targeted edits using replace_in_file or write_file, and verify your changes.",
    preferredValidationCommand
      ? `Preferred validation command: ${JSON.stringify(preferredValidationCommand)}.`
      : "",
    collaborationGuidance,
  ].filter(Boolean).join(" ");
}
