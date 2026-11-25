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
    readonly editorDiagnosticRepair?: boolean;
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
    readonly responseLanguage?: "zh" | "en";
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
          const allowedPaths = Array.isArray(record.allowedPaths)
            ? record.allowedPaths
                .map((value) => String(value || "").trim())
                .filter(Boolean)
            : [];
          const pathSuffix = allowedPaths.length > 0
            ? ` [paths: ${allowedPaths.join(", ")}]`
            : "";
          return id
            ? `${name || id} (${id})${pathSuffix}: ${objective}`.slice(0, 600)
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
  const allSubagentsSettled =
    command.payload.allSubagentsSettled === true &&
    activeSubagents.length === 0;
  const collaborationGuidance = [
    failedSubagents.length > 0
      ? `Previous child work did not complete (${failedSubagents.join("; ")}). Continue the objective directly; child failure is never a blocker.`
      : "",
    activeSubagents.length > 0
      ? `Child work is active (${activeSubagents.join("; ")}). Do not reread files already assigned to active children; continue independent non-overlapping parent work and call wait_subagents only when a child result or staged mutation becomes a dependency.`
      : "",
    allSubagentsSettled
      ? "All spawned subagents have finished and settled; no active subagents remain. Do NOT call wait_subagents again; continue directly from the delivered results or conclude."
      : "",
    toolSurface.hasSpawnSubagent && remainingSubagentCapacity > 0
      ? (() => {
          const requestMode = typeof command.payload.collaborationRequestMode === "string"
            ? command.payload.collaborationRequestMode
            : "";
          const serializedLane = remainingSubagentCapacity <= 1 || requestMode === "serialized";
          return [
            command.payload.collaborationPreferred === true
              ? serializedLane
                ? `The user explicitly prefers collaboration; current child-request capacity is ${remainingSubagentCapacity} (${requestMode || "serialized"}, sequential model lane), so child requests run sequentially rather than concurrently. Keep each child objective and success criteria within the user's requested deliverable and depth. Prefer one focused child or direct parent execution unless bounded context isolation justifies queuing.`
                : `The user explicitly prefers collaboration; current child-request capacity is ${remainingSubagentCapacity}, and independent tasks may queue. Keep each child objective and success criteria within the user's requested deliverable and depth. Delegate an independent result only when its benefit justifies coordination, and continue non-dependent parent work in parallel. This preference applies at inspect, edit, or verify; it is not a mandatory lifecycle stage. For a simple or linear task, proceed directly without explaining why no child was used.`
              : serializedLane
                ? `Delegation is optional. Current child-request capacity is ${remainingSubagentCapacity} (${requestMode || "serialized"}, sequential model lane), so child requests run sequentially rather than concurrently; prefer direct parent execution unless bounded context isolation justifies queuing.`
                : "Delegation is optional.",
            "Use read-only children for parallel investigation. Use implement/write only under an approved WorkPlan ready frontier (even during initial observing) or a recorded parent execution contract: provide an explicit operation, implementation_plan, success criteria, and exact non-overlapping file targets; never grant a directory and let the child choose writes. The child stages coherent write transactions within its exclusive targets and Runtime atomically validates and commits them at join; the parent still owns cross-file integration, dependency order, and final validation. Never delegate merely because a parent action failed or because the next action is difficult.",
          ].join(" ");
        })()
      : toolSurface.hasSpawnSubagent && remainingSubagentCapacity === 0
        ? "Child-request capacity is currently 0; continue directly without calling spawn_subagent."
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
  const responseLanguageHint = toolSurface.responseLanguage === "zh"
    ? "所有面向用户的阶段说明与最终回复必须使用简体中文（代码、文件路径、标识符和命令保持原样）。"
    : toolSurface.responseLanguage === "en"
      ? "Write all user-visible commentary and final replies in English, keeping code, file paths, identifiers, and commands unchanged."
      : "";
  if (mode === "chat" || mode === "analyze" || (mode === "conclude" && command.payload.conclusionKind === "read_only")) {
    if (mode === "conclude") {
      if (toolSurface.responseLanguage === "zh") {
        return "工具调用已结束。请基于当前对话和已收集的证据，直接用简体中文输出清晰、完整、结构化的 Markdown 答复（按问题复杂度自适应详略，重点给出结论、依据与必要细节）。";
      }
      if (toolSurface.responseLanguage === "en") {
        return "Tools are closed for this final reply. Return a clear, complete, well-structured Markdown answer in English based on the conversation and gathered evidence, adapting depth to the question.";
      }
      return "Return a clear, complete Markdown answer based on the conversation and gathered evidence. Tools are closed for this final reply.";
    }
    return [
      mode === "chat"
        ? "Answer the user directly, using available read/search tools only when needed."
        : "Inspect the relevant files or sources with read-only tools, then provide a complete Markdown answer.",
      recoveryGuidance,
      mode === "analyze" ? collaborationGuidance : "",
      responseLanguageHint,
    ].filter(Boolean).join(" ");
  }
  if (mode === "conclude") {
    const concludeGuidance = toolSurface.responseLanguage === "zh"
      ? "工具调用已结束，不要再调用工具。请使用简体中文输出自适应复杂度的结构化最终 Markdown 总结：简单任务简明给出结论、关键改动与验证结果；复杂或多文件任务分节说明（1）结果概览、（2）核心改动与原因（引用具体文件/符号）、（3）验证命令与真实结果、（4）确有必要的遗留风险或后续建议。"
      : toolSurface.responseLanguage === "en"
        ? "Do not call more tools. Deliver an adaptive structured Markdown summary in English: keep simple tasks concise (outcome, key change, and verification); for complex or multi-file work, organize into (1) Outcome overview, (2) Key changes & rationale with exact file/symbol references, (3) Verification commands & concrete results, and (4) Caveats or follow-ups only when present."
        : "Summarize the completed changes, files modified, validations run, and any remaining caveats. Do not call more tools.";
    return [
      concludeGuidance,
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  const sourceGuidance = toolSurface.hasMutation
    ? [
        toolSurface.hasMaterializedSourceEvidence
          ? "For modifications to an existing file, use only its exact current source visible in this decision request. Each existing target needs its own versioned source lease; observing one file does not authorize edits to another."
          : command.payload.hasVersionedSourceEvidence === true
            ? "Existing-file source is cached but is not visible in this decision request; this does not authorize edits to those files. Request the exact missing target window so Runtime can replay it without another disk read (unchanged carried-over source already supports execution contracts and child delegation)."
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
      toolSurface.editorDiagnosticRepair
        ? "Use the current Editor compiler and Shader import receipts to settle static Console diagnostics. Runtime exceptions require a reproduction or test in the project. Continue any remaining fixes or report the verified outcome."
        : "Verify the latest committed mutation by running a finite validation tool (such as run_command for build/test/lint/typecheck, or browser_evaluate/computer_use for UI verification) before returning your final summary; read_file or prose alone does not satisfy validation. Still-needed authorized external actions remain available. Ordinary shell actions produce tool results and do not discharge file validation debt attached to the newest committed mutation. If verification reveals an issue, fix the code and re-verify.",
      sourceGuidance,
      creationGuidance,
      validationGuidance,
      contractGuidance,
      preferredValidationCommand
        ? `Preferred validation command: ${JSON.stringify(preferredValidationCommand)}.`
        : "",
      collaborationGuidance,
      responseLanguageHint,
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
    responseLanguageHint,
  ].filter(Boolean).join(" ");
}
