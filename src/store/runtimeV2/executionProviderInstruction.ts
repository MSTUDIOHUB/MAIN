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
    readonly executionContractRequired?: boolean;
    readonly executionContractReadWindowClosed?: boolean;
    readonly executionContractRepairAttempts?: number;
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
    executionContractRequired: false,
    executionContractReadWindowClosed: false,
    executionContractRepairAttempts: 0,
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
              ? "The user enabled collaboration for this Run. Decide adaptively whether a genuinely independent investigation, review, validation, or planned implementation child would create real overlap at the current inspect, edit, or verify stage. Delegation is available but never mandatory and is not a prerequisite for mutation or completion."
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
  const recoveryGuidance = recoveryPressure
    ? [
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
  const executionContractGuidance = toolSurface.executionContractRequired
    ? [
        "EXECUTION_CONTRACT_REQUIRED: multiple exact versioned source owners are now available before the first workspace mutation.",
        toolSurface.executionContractReadWindowClosed
          ? "The two bounded supplemental evidence batches have been consumed. The observation branch is closed: call record_execution_contract now. Do not request another file, search, network read, or unrelated presentation/style entry point."
          : "You may use at most two bounded supplemental provider decisions for specifically missing causal edges, and should issue all independent necessary source reads together. Every later batch must request a genuinely new exact owner or missing source window; repeated reads remain closed. Prefer exact behavior owners: for cross-process or public-API symptoms compare the caller and handler argument names instead of inferring one side. Do not tour presentation, style, or entry-point files unless they own a stated symptom. Otherwise call record_execution_contract now.",
          "Connect every user-visible symptom to an evidence-backed root cause; list the smallest coherent exact file operations, investigated preserve boundaries, expected outcomes, and finite or observable acceptance checks. Mutation and validation tools intentionally reopen only after this contract is recorded.",
          "A finite_command must exit by itself and be a build, test, lint, typecheck, check, or failing inline assertion; never use a dev server, watcher, tail, or other long-running observer. For user-visible behavior, include a real test/inline assertion or browser/desktop check—static build success alone is not behavioral proof.",
        "This is the parent solution boundary that makes implementation delegation meaningful; do not spawn an implement child before it exists.",
      ].join(" ")
    : toolSurface.executionContract
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
  const executionContractRepairGuidance =
    (toolSurface.executionContractRepairAttempts || 0) > 0
      ? [
          `EXECUTION_CONTRACT_REPAIR_REQUIRED: the previous contract submission was rejected and changed no files (attempt ${toolSurface.executionContractRepairAttempts}).`,
          toolSurface.executionContract
            ? "Submit exactly one complete replacement object with summary, root_causes, changes, validations, and revision_reason. Retain still-valid entries from the active contract and name the newer evidence that requires the revision."
            : "Submit exactly one complete initial object with summary, root_causes, changes, and validations; revision_reason is not needed until a contract exists.",
          "Every changes item must include operation, non-empty exact targets, a concrete change, and expected_outcome. Every validations item must include kind and expected_outcome; finite_command also requires one bounded command. Use the latest EXECUTION_CONTRACT_REJECTED reason as the exact correction target instead of reanalyzing the repository.",
          "Do not submit a partial delta, request another read, narrate, or mutate until the complete contract is accepted.",
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
  if (mode === "analyze") {
    return [
      "Perform a bounded read-only analysis of the admitted file context. Use a focused read or search only when a concrete fact is missing, then return one complete evidence-backed Markdown answer.",
      collaborationGuidance,
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
        executionContractRepairGuidance,
        executionContractAdvanceGuidance,
        "Submit the bounded corrective mutation now. Validation debt remains attached to the newest committed workspace version.",
      ].filter(Boolean).join(" ");
    }
    if (toolSurface.validationCorrectionActive) {
      return [
        recoveryGuidance,
        executionContractGuidance,
        executionContractRepairGuidance,
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
        executionContractRepairGuidance,
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
      executionContractRepairGuidance,
      executionContractAdvanceGuidance,
      validationCorrectionGuidance,
      toolSurface.actionWindow === "validation_handoff"
        ? actionWindowGuidance
        : toolSurface.actionWindow
        ? "VALIDATION_ACTION_WINDOW: repeated inspection or a no-effect attempt has closed the observation branch. Submit one advertised finite validation, or—only when the visible current source proves the implementation is incomplete—one bounded workspace mutation against that source. Collaboration and more inspection cannot replace this parent action."
        : "",
      "Validate the latest committed mutation now with a finite test, assertion, build, lint, typecheck, browser, or desktop interaction appropriate to the user's observable acceptance criteria.",
      toolSurface.executionContractAdvanceRequired
        ? "If the repair spans more files, continue with one contracted mutation now; otherwise validate. Runtime keeps validation debt attached to the newest commit."
        : "If the repair spans more files or the visible post-edit source proves work remains, continue with one exact source-backed mutation; Runtime returns to editing and keeps validation debt attached to the newest commit. Do not mutate merely to avoid a failing check. Safe reads remain available when a genuinely missing post-edit fact is required; a read or diff alone is not validation.",
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
    executionContractRepairGuidance,
    executionContractAdvanceGuidance,
    validationCorrectionGuidance,
    actionWindowGuidance,
    toolSurface.sourceOnlyFrontier
      ? toolSurface.actionWindow
        ? toolSurface.actionWindow === "corrective_source"
          ? "The next decision must materialize the one exact target named by the mutation-source failure."
          : "The current mutation boundary already has exact versioned source but no committed workspace effect. The next decision must resolve that effect debt rather than open another observation."
        : "The current mutation boundary already has exact versioned source but no committed workspace effect. If the visible source supports a safe coherent repair, submit the mutation now. Continue reading only when you can name one missing path, range, or fact required to edit safely; broad exploration does not advance the objective."
      : "",
    toolSurface.hasReadFile
      ? toolSurface.actionWindow === "corrective_source"
        ? "Only the advertised single target-locked corrective read is available; general safe-reading guidance does not reopen repository inspection at this boundary."
        : toolSurface.hasMaterializedSourceEvidence
        ? "Exact versioned source is visible in this decision request. Use only that visible source for a mutation or validation; request a different target or missing range when needed. Safe reads remain available after every edit and failed validation."
        : command.payload.hasVersionedSourceEvidence === true
          ? "Versioned source exists in the runtime cache but is not visible in this decision request, so it is not write authority. Request the exact intended path or range again; MAIN may replay it without another disk read."
          : "No versioned source evidence is committed yet. Read the exact existing file before changing it. Safe reads remain available after every edit and failed validation."
      : "",
    toolSurface.hasMutation
      ? "Make the smallest coherent change that addresses all currently supported gaps, preserving unrelated behavior."
      : "",
    editableSourceGuidance,
    toolSurface.validationCorrectionActive
      ? "The failed acceptance boundary requires a source-backed workspace mutation before another validation."
      : "After the latest mutation, run a finite test, build, lint, typecheck, browser, or desktop validation appropriate to the observable claim. Text inspection alone is not validation.",
    preferredValidationCommand
      ? `A suitable finite workspace validation is ${JSON.stringify(preferredValidationCommand)}.`
      : "",
    "If work remains, choose one real structured tool action. A response without a tool call ends the Run and will be judged only by committed mutation and validation evidence; return prose only when you are done.",
    collaborationGuidance,
  ].filter(Boolean).join(" ");
}
