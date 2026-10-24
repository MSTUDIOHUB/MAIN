import type { RuntimeV2Command } from "../../lib/runtime-v2";
import type { RuntimeV2ProviderActionWindow } from "./executionContext";
import {
  runtimeV2ExecutionContractAnchor,
  type RuntimeV2ExecutionContract,
} from "./executionContract";
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
      ? [
          `RECOVERY_PIVOT ${recoveryOccurrence}: the previous decision returned a complete no-tool reply, with no executable effect (${recoveryPressure.reason}).`,
          "Continue from the actual reply and its adjacent Runtime feedback. Advance the user's currently authorized effect when supported by the evidence; if an essential decision or authority is missing, explain that exact gap and ask a focused clarification. Do not repeat the same reply or manufacture a workspace mutation.",
        ].join(" ")
      : [
        `RECOVERY_PIVOT ${recoveryOccurrence}: the previous provider decision produced no executable progress (${String(recoveryPressure.reason || "non_actionable_response")}).`,
        recoveryStage === "reconsider"
          ? "Re-read the latest structured failure feedback and submit an action whose normalized tool arguments are materially different from the closed action."
          : recoveryStage === "reframe"
            ? "Change strategy now and use one materially different action from CURRENT_TOOL_SURFACE. Do not resubmit the same patch or read."
            : "The current approach is stalled. Use one genuinely different action from CURRENT_TOOL_SURFACE; the closed action will not execute.",
      ].join(" ")
    : "";
  const editableSourceGuidance =
    toolSurface.hasMutation &&
      toolSurface.hasMaterializedSourceEvidence
      ? runtimeV2EditableSourceAnchor(
          toolSurface.materializedSourceCoverage || [],
        )
      : "";
  const executionContractGuidance = toolSurface.executionContract
    ? [
        runtimeV2ExecutionContractAnchor(toolSurface.executionContract),
        "The active execution contract is the current parent solution boundary. Advance one listed change or validation at a time, preserve its stated boundaries, and do not broaden into cleanup or redesign. To add or change a target, first obtain the missing exact evidence and explicitly revise record_execution_contract with revision_reason; a parent or implementation child mutation outside the contract will be rejected.",
      ].join(" ")
    : "";
  const executionContractAdvanceGuidance =
    toolSurface.executionContractAdvanceRequired
      ? [
          "EXECUTION_CONTRACT_ADVANCE_REQUIRED: a contracted workspace mutation has committed, so open-ended investigation is closed until the newest implementation is advanced or checked.",
          `Already mutated targets: ${JSON.stringify(toolSurface.executionContractCommittedTargets || [])}. Contract targets not yet mutated: ${JSON.stringify(toolSurface.executionContractPendingTargets || [])}.`,
          toolSurface.executionContractSourceReviewAvailable
            ? `One bounded post-mutation self-review read batch is available only for the just-mutated targets ${JSON.stringify(toolSurface.executionContractSourceReviewTargets || [])}. Use it now only if an exact changed range must be confirmed; issue every independent changed-target read together. After this batch, reading closes and you must mutate or validate.`
            : "The bounded post-mutation self-review batch is already consumed or was not requested; reading remains closed for this mutation boundary.",
          toolSurface.executionContractSourceReviewAvailable
            ? (toolSurface.executionContractPendingTargets || []).length > 0
              ? "Use only the advertised target-locked read_file for an exact post-edit self-check, or skip it and submit one remaining concrete contracted mutation. Validation is intentionally unavailable until every contracted target has a committed mutation."
              : "Use only the advertised target-locked read_file for an exact post-edit self-check, or skip it and submit the finite/behavioral validation. Search, manifests, presentation files, and collaboration are not part of this review."
            : (toolSurface.executionContractPendingTargets || []).length > 0
              ? "Submit one concrete mutation for a not-yet-mutated contract target now. Validation and further reading are intentionally unavailable until every contracted target has a committed mutation. If current evidence changes the solution, revise the contract instead of skipping the target."
              : "Run the advertised finite/behavioral validation against the newest workspace. Do not read, search, inspect manifests/presentation files, or spawn another child merely to reconsider the completed edit. A real failed validation will reopen evidence-backed correction.",
        ].join(" ")
      : "";
  const validationCorrectionGuidance = toolSurface.validationCommandUnavailable
    ? toolSurface.replacementValidationExhausted
      ? [
          "VALIDATION_REPLACEMENT_EXHAUSTED: the sealed validator and one materially different bounded replacement both failed before yielding a source diagnostic.",
          "Do not retry either command, inspect unrelated source, or change code merely to make the environment executable. Return a concise incomplete report with the actual edits and manual verification steps.",
        ].join(" ")
      : [
          "VALIDATION_COMMAND_UNAVAILABLE: the sealed finite validator failed operationally without identifying a source location.",
          toolSurface.failedValidationCommand
            ? `Do not repeat ${JSON.stringify(toolSurface.failedValidationCommand)}. Choose one materially different finite build, test, lint, typecheck, check, inline assertion, browser, or desktop validation now.`
            : "Choose one materially different finite build, test, lint, typecheck, check, inline assertion, browser, or desktop validation now.",
          "This is a validation-authority fallback, not a source-correction window: do not read or mutate the workspace in this decision.",
        ].join(" ")
    : toolSurface.validationCorrectionActive
    ? "VALIDATION_CORRECTION: a real acceptance check failed on the newest mutation. This receipt is newer evidence than the pre-edit implementation outline. Treat its diagnostic paths and lines as the causal starting evidence, use ordinary focused source reads only where exact current text is missing, then repair every supported owner directly with source-backed mutations. Do not rerun the same validation on an unchanged workspace; general no-effect recovery will stop repeated reads or rejected actions."
    : "";
  const actionWindowGuidance = toolSurface.actionWindow
    ? toolSurface.actionWindow === "corrective_source"
      ? [
          "CORRECTIVE_SOURCE_WINDOW: the previous workspace mutation changed no files because its exact target source was not visible.",
          "Use read_file only for the newest failed target. When an acceptance receipt supplied a file and line, choose that nearby range; otherwise choose the smallest range needed for a materially different mutation. Do not start at line 1, request the whole file, or page through successive/overlapping windows.",
          "As soon as the exact current source needed by a safe alternative is visible, Runtime closes reading and requires the new mutation; it never waits for the rejected patch to be reconstructed.",
        ].join(" ")
      : toolSurface.actionWindow === "corrective_mutation"
      ? [
          "CORRECTIVE_ACTION_WINDOW: the previous workspace mutation changed no files, and its exact source plus bounded failure diagnostic are already visible.",
          "The observation branch is closed for this mutation boundary. Submit one materially different, smaller workspace mutation now, or return a concise incomplete report without a tool call. Inspection and validation reopen immediately after a mutation commits.",
        ].join(" ")
      : toolSurface.actionWindow === "validation_handoff"
      ? [
          "CONTRACT_VALIDATION_HANDOFF: every contracted target already has a committed mutation, and a later optional editor changed no files.",
          "Do not repair that uncommitted attempt or inspect another range now. Validate the newest committed workspace; a real failed acceptance receipt will reopen an evidence-bounded correction.",
        ].join(" ")
      : [
          "RECOVERY_ACTION_WINDOW: a repeated no-effect action, materially different reads returning the same non-empty observation, or one same-version cache re-materialization has closed the current observation branch while exact source remains visible.",
          "Submit one workspace mutation against an exact source target already visible in this request, or return a concise incomplete report without a tool call. Collaboration cannot replace this parent action, and creating an unrelated file cannot discharge this existing-source effect debt. If a mutation is rejected because one exact target source is missing, Runtime opens a target-locked source recovery window. Inspection and validation reopen immediately after a mutation commits.",
        ].join(" ")
    : "";
  const ordinaryEffectGuidance = !toolSurface.actionWindow &&
    !toolSurface.executionContractAdvanceRequired && !toolSurface.validationCorrectionActive &&
    !toolSurface.validationCommandUnavailable
    ? [
        toolSurface.hasCreateFile
          ? "New files within the authorized target scope may be created with the advertised write_file tool; they do not require reading nonexistent existing-file source or an existing-source lease. Normal creation preflight and permission checks still apply."
          : "",
        "Commands and external operations do not require a file-source lease; use their advertised tools under their own authorization, target scope and verification contracts. A source read neither authorizes those effects nor creates a requirement to modify that file.",
      ].filter(Boolean).join(" ")
    : "";
  if (mode === "chat" || mode === "analyze" || (mode === "conclude" && command.payload.conclusionKind === "read_only")) {
    if (mode === "conclude") return "Return one complete Markdown answer now from the conversation and available evidence. Tools are closed. Deliver the answer itself, not a promise of future work or a replay of tool commentary. Address the user's requested points, distinguishing supported findings from information gaps; never invent facts or claim that unavailable checks succeeded.";
    return [
      mode === "chat" ? "Answer the user using the supplied conversation. Only exposed Skill and Web context reads are available." : "Analyze the admitted sources with read-only authority.",
      command.payload.recoveryPressure ? "The last decision added no new evidence. Read again only for a concrete remaining information gap using a materially different source or reading method; otherwise answer now." : "Use a focused read only when a concrete fact is missing, then return a complete Markdown answer.",
      "Search hits are discovery leads: check their subject, date and source before using them. Rewording searches alone does not establish source progress. Unrelated results, error pages and retrieval.usable=false receipts do not resolve an information gap. Fetch a relevant direct source or state what could not be verified.",
      mode === "analyze" ? collaborationGuidance : "",
    ].filter(Boolean).join(" ");
  }
  if (mode === "conclude") {
    return [
      "Return the final evidence report now. State only the confirmed cause, files actually changed, validations actually run, and any remaining limitation. Do not request another workspace action.",
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  if (mode === "validate") {
    if (toolSurface.validationCommandUnavailable) {
      return [
        recoveryGuidance,
        executionContractGuidance,
        validationCorrectionGuidance,
      ].filter(Boolean).join(" ");
    }
    if (toolSurface.actionWindow === "corrective_source") {
      return [
        recoveryGuidance,
        actionWindowGuidance,
        "The attempted implementation continuation changed no files. Materialize only the exact failed target now; Runtime will reopen its corrective mutation before returning to validation.",
      ].filter(Boolean).join(" ");
    }
    if (toolSurface.actionWindow === "corrective_mutation") {
      return [
        recoveryGuidance,
        actionWindowGuidance,
        editableSourceGuidance,
        executionContractGuidance,
        executionContractAdvanceGuidance,
        "Submit the bounded corrective mutation now. Validation debt remains attached to the newest committed workspace version.",
      ].filter(Boolean).join(" ");
    }
    if (toolSurface.validationCorrectionActive) {
      return [
        recoveryGuidance,
        executionContractGuidance,
        executionContractAdvanceGuidance,
        validationCorrectionGuidance,
        actionWindowGuidance,
        editableSourceGuidance,
        "Correct the failed acceptance condition now. Validation remains withheld until a workspace mutation establishes a newer boundary.",
        collaborationGuidance,
      ].filter(Boolean).join(" ");
    }
    if (
      toolSurface.executionContractAdvanceRequired &&
      (toolSurface.executionContractPendingTargets || []).length > 0
    ) {
      return [
        recoveryGuidance,
        executionContractGuidance,
        executionContractAdvanceGuidance,
        actionWindowGuidance,
        editableSourceGuidance,
        "Complete one advertised contracted workspace mutation now. Validation remains unavailable until every pending contract target has a committed mutation.",
        collaborationGuidance,
      ].filter(Boolean).join(" ");
    }
    return [
      recoveryGuidance,
      executionContractGuidance,
      executionContractAdvanceGuidance,
      validationCorrectionGuidance,
      toolSurface.actionWindow === "validation_handoff"
        ? actionWindowGuidance
        : toolSurface.actionWindow
        ? "VALIDATION_ACTION_WINDOW: repeated inspection or a no-effect attempt has closed the observation branch. Submit one advertised finite validation, or—only when the visible current source proves the implementation is incomplete—one bounded workspace mutation against that source. Collaboration and more inspection cannot replace this parent action."
        : "",
      "Validate the latest committed mutation now with a finite test, assertion, build, lint, typecheck, browser, or desktop interaction appropriate to the user's observable acceptance criteria.",
      "Continue any still-needed authorized external actions through their advertised tools before the final check. Ordinary shell actions produce tool results and do not discharge the latest file mutation's validation debt.",
      ordinaryEffectGuidance,
      toolSurface.executionContractAdvanceRequired
        ? "If the repair spans more files, continue with one contracted mutation now; otherwise validate. Runtime keeps validation debt attached to the newest commit."
        : "If authorized implementation work remains, continue it with the advertised tools within the current target scope. Existing-file edits require their exact current visible source. Runtime returns to editing and keeps validation debt attached to the newest mutation. Do not mutate merely to avoid a failing check. Safe reads remain available for a specific missing fact; a read or diff alone is not validation.",
      "Static checks prove only static properties. User-visible behavior requires a test, browser interaction, or desktop interaction that observes that behavior.",
      preferredValidationCommand
        ? `A suitable finite workspace validation is ${JSON.stringify(preferredValidationCommand)}.`
        : "",
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  return [
    recoveryGuidance,
    "Continue one inspect-edit-verify loop for the user's complete objective.",
    executionContractGuidance,
    executionContractAdvanceGuidance,
    validationCorrectionGuidance,
    actionWindowGuidance,
    toolSurface.sourceOnlyFrontier && !recoveringCompleteReply
      ? toolSurface.actionWindow
        ? toolSurface.actionWindow === "corrective_source"
          ? "The next decision must materialize the one exact target named by the mutation-source failure."
          : "The current mutation boundary already has exact versioned source but no committed workspace effect. The next decision must resolve that effect debt rather than open another observation."
        : "This boundary has versioned evidence about existing files but no recorded file mutation. Those reads do not select the implementation targets or require a repair to the files already read. Reuse the available facts to advance the user's complete objective; read again only for a specific missing fact that blocks the next authorized action."
      : "",
    toolSurface.hasReadFile
      ? toolSurface.actionWindow === "corrective_source"
        ? "Only the advertised single target-locked corrective read is available; general safe-reading guidance does not reopen repository inspection at this boundary."
        : toolSurface.hasMaterializedSourceEvidence
        ? "For modifications to an existing file, use only its exact current source visible in this decision request. Read a missing target or range before changing it. Safe reads remain available after edits and failed validation unless the current recovery or sealed contract explicitly narrows them."
        : command.payload.hasVersionedSourceEvidence === true
          ? "Versioned existing-file source is cached but is not visible in this decision request, so it does not authorize edits to those files. Request the exact existing target or range again; MAIN may replay it without another disk read."
          : "No existing-file source is visible yet. Read the exact current target before modifying an existing file. Safe reads remain available after every edit and failed validation."
      : "",
    toolSurface.hasMutation
      ? "Source visibility is editing authority, not an obligation to write. Make a workspace change only when the user's current request authorizes that effect; keep any authorized change as small and coherent as the full objective permits, preserving unrelated behavior."
      : "",
    ordinaryEffectGuidance,
    editableSourceGuidance,
    toolSurface.validationCorrectionActive
      ? "The failed acceptance boundary requires a source-backed workspace mutation before another validation."
      : "After the latest mutation, run a finite test, build, lint, typecheck, browser, or desktop validation appropriate to the observable claim. Text inspection alone is not validation.",
    preferredValidationCommand
      ? `A suitable finite workspace validation is ${JSON.stringify(preferredValidationCommand)}.`
      : "",
    "If an authorized effect remains, use a real structured tool action when the necessary evidence is available. For a command or external-operation task without required artifact changes or acceptance debt, return a complete final report when actual successful receipts cover the user's full request. A successful intermediate action does not require you to stop; continue using tools while work remains. File mutations still require subsequent matching validation. If essential user input or authority is missing, state the exact unfinished work and needed clarification; never invent an effect to claim progress.",
    collaborationGuidance,
  ].filter(Boolean).join(" ");
}
