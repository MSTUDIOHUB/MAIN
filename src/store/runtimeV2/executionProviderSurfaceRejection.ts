import type {
  RuntimeV2Command,
  RuntimeV2NormalizedProviderResult,
} from "../../lib/runtime-v2";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  normalizeWorkspacePathIdentity,
  workspacePathsReferToSameFile,
} from "../../lib/workspacePaths";
import {
  appendRuntimeV2ProviderFeedbackHistory,
  appendRuntimeV2RejectedToolCallHistory,
  rememberRuntimeV2ProviderResult,
} from "./executionProviderHistory";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import {
  runtimeV2ProviderToolCallIdentity,
  scopeRuntimeV2ProviderToolCallIds,
  unexpectedRuntimeV2ProviderToolNames,
} from "./providerToolSurface";
import {
  correctiveFiniteValidationCommand,
  finiteValidationCommandRejection,
} from "./executionValidationCommand";
import {
  latestRuntimeV2CorrectiveMutationFailure,
  type RuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";
import { aggregateForCurrentTurn } from "./executionAggregate";
import { deriveRuntimeV2ValidationCorrectionWindow } from "./executionValidationCorrection";
import { preferredFiniteValidationCommand } from "./executionProviderContext";
import {
  runtimeV2ProviderToolArgumentViolation,
} from "./executionProviderTools";

function rejectedProviderResult(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly result: RuntimeV2NormalizedProviderResult;
  readonly rejectedCall: RuntimeV2NormalizedProviderResult["toolCalls"][number];
  readonly feedbackCode: string;
  readonly feedback: string;
  readonly reason: string;
  readonly actionIdentity?: string;
  readonly logData?: Readonly<Record<string, unknown>>;
}): RuntimeV2NormalizedProviderResult {
  const actionIdentity = input.actionIdentity ||
    runtimeV2ProviderToolCallIdentity(input.rejectedCall);
  const [historyCall] = scopeRuntimeV2ProviderToolCallIds(
    [input.rejectedCall],
    () => input.ports.nextId("provider-rejected-tool-call"),
  );
  appendRuntimeV2RejectedToolCallHistory(input.ports.live, {
    call: historyCall!,
    actionIdentity,
    feedback: input.feedback,
  });
  appendRuntimeV2ProviderFeedbackHistory(input.ports.live, {
    code: input.feedbackCode,
    feedback: input.feedback,
  });
  const rejectedResult: RuntimeV2NormalizedProviderResult = {
    ...input.result,
    visibleText: "",
    toolCalls: [],
    diagnostics: [
      ...input.result.diagnostics,
      {
        code: "repeated_action_rejected",
        message:
          `${input.reason}:${input.rejectedCall.name}:${actionIdentity}`,
        retryable: true,
      },
    ],
  };
  rememberRuntimeV2ProviderResult(input.ports, rejectedResult);
  input.ports.logStoreEvent("runtime_v2_provider_action_rejected", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    toolName: input.rejectedCall.name,
    reason: input.reason,
    actionIdentity,
    ...input.logData,
  });
  return rejectedResult;
}

/**
 * Once a tool is absent from the advertised surface, transport parameters no
 * longer make repeated requests materially different. In particular, changing
 * only read_file.start_line is still the same attempt to escape a closed
 * observation branch. Keep the resource identity when one exists so unrelated
 * files do not collapse into one diagnostic, but discard paging/query churn.
 */
export function runtimeV2UnavailableToolSemanticIdentity(
  call: RuntimeV2NormalizedProviderResult["toolCalls"][number],
): string {
  const rawResource = [
    call.arguments.path,
    call.arguments.file_path,
    call.arguments.target,
    call.arguments.directory,
    call.arguments.root,
  ].find((value) => typeof value === "string" && value.trim());
  const resource = normalizeWorkspacePathIdentity(
    typeof rawResource === "string" ? rawResource : "",
  );
  return runtimeV2ProviderToolCallIdentity({
    name: call.name,
    arguments: resource ? { resource } : {},
  });
}

/**
 * An unavailable tool name is a closed semantic action, not a transport
 * failure. Return it through the canonical provider-result ledger and retain
 * one assistant/tool rejection pair so a local model sees that its exact
 * action was attempted and will not be executed. Throwing here used to leave
 * only a coalesced system sentence, allowing deterministic native-tool replay.
 */
export function rejectRuntimeV2UnexpectedProviderTool(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly tools: readonly ToolDefinition[];
  readonly result: RuntimeV2NormalizedProviderResult;
}): RuntimeV2NormalizedProviderResult | null {
  const unexpected = unexpectedRuntimeV2ProviderToolNames(
    input.tools,
    input.result.toolCalls,
  );
  if (unexpected.length === 0) return null;
  const rejectedCall = input.result.toolCalls.find((call) =>
    unexpected.includes(call.name)
  );
  if (!rejectedCall) return null;
  const allowedToolNames = input.tools.map((tool) => tool.function.name);
  const exactActionIdentity = runtimeV2ProviderToolCallIdentity(rejectedCall);
  const actionIdentity = runtimeV2UnavailableToolSemanticIdentity(
    rejectedCall,
  );
  const feedback = [
    `TOOL_SURFACE_REJECTED: ${unexpected.join(", ")} is not available in this decision.`,
    `Allowed tools: ${allowedToolNames.join(", ")}.`,
    "The requested action was not executed and its branch is closed. Submit exactly one advertised structured action now; do not repeat, narrate, or request a hidden tool.",
  ].join("\n");
  return rejectedProviderResult({
    ...input,
    rejectedCall,
    feedbackCode: "tool_surface_rejected",
    feedback,
    reason: "tool_surface_rejected",
    actionIdentity,
    logData: {
      allowedToolNames,
      exactActionIdentity,
      semanticActionIdentity: actionIdentity,
    },
  });
}

/** OpenAI-compatible servers may return native tool arguments that violate
 * the exact schema they acknowledged. Reject those calls before scheduling;
 * path/command enums are a Runtime boundary, not a best-effort hint. */
export function rejectRuntimeV2InvalidProviderToolArguments(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly tools: readonly ToolDefinition[];
  readonly result: RuntimeV2NormalizedProviderResult;
}): RuntimeV2NormalizedProviderResult | null {
  const violation = runtimeV2ProviderToolArgumentViolation(
    input.result.toolCalls,
    input.tools,
  );
  if (!violation) return null;
  const feedback = [
    `TOOL_ARGUMENTS_REJECTED: ${violation.call.name} did not satisfy the exact advertised argument schema; no tool ran.`,
    violation.reason,
    "Use only the currently advertised enum values and required fields. Submit one corrected structured action; do not narrate or repeat the rejected arguments.",
  ].join("\n");
  return rejectedProviderResult({
    ...input,
    rejectedCall: violation.call,
    feedbackCode: "tool_arguments_rejected",
    feedback,
    reason: "tool_arguments_rejected",
    logData: {
      schemaViolation: violation.reason,
    },
  });
}

/** A validation-mode run_command is admitted by argument semantics, not by
 * its broad tool name. Source searches must not enter the ledger as ordinary
 * execute_tool effects while the phase is waiting for validation; otherwise
 * no validation.completed event exists to return a failed check to editing. */
export function rejectRuntimeV2InvalidValidationCommand(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly tools: readonly ToolDefinition[];
  readonly result: RuntimeV2NormalizedProviderResult;
}): RuntimeV2NormalizedProviderResult | null {
  if (String(input.command.payload.mode || "").trim() !== "validate") {
    return null;
  }
  const invalid = input.result.toolCalls.flatMap((call) => {
    if (call.name !== "run_command") return [];
    const command = String(
      call.arguments.command || call.arguments.cmd || "",
    ).trim();
    const rejection = finiteValidationCommandRejection(command);
    return rejection ? [{ call, command, rejection }] : [];
  })[0];
  if (!invalid) return null;
  const correctiveCommand =
    correctiveFiniteValidationCommand(invalid.command) ||
    input.ports.live.correctiveValidationCommand ||
    (typeof input.ports.get === "function"
      ? preferredFiniteValidationCommand(input.ports)
      : "");
  input.ports.live.correctiveValidationCommand = correctiveCommand;
  const feedback = [
    "VALIDATION_COMMAND_REJECTED: this run_command does not preserve one finite acceptance exit status; no command ran.",
    invalid.rejection.message,
    correctiveCommand
      ? `The workspace is already bound. Submit exactly ${JSON.stringify(correctiveCommand)} as command next, without cd, redirection, pipe, tail, semicolon, echo, or another wrapper.`
      : "Use one bounded build, test, lint, typecheck, check, or inline assertion command (for example npm test, npm run build, cargo test, or a bounded node assertion), or use browser_evaluate for observable UI behavior.",
    "Do not use grep/find/cat/sed to discharge validation debt and do not repeat the mutation while validation tools are the only advertised actions.",
  ].join("\n");
  return rejectedProviderResult({
    ...input,
    rejectedCall: invalid.call,
    feedbackCode: "validation_command_rejected",
    feedback,
    reason: "validation_command_not_finite",
    logData: {
      rejectionReason: invalid.rejection.rejectionReason,
      correctiveCommand: correctiveCommand || null,
    },
  });
}

/** A missing mutation source opens one target-locked recovery read. Native
 * tool schemas guide compliant models; this semantic boundary prevents a
 * provider from swapping in an unrelated unread file to escape the window. */
export function rejectRuntimeV2InvalidCorrectiveSourceRead(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly result: RuntimeV2NormalizedProviderResult;
  readonly effects: RuntimeV2ProviderEffectFacts;
}): RuntimeV2NormalizedProviderResult | null {
  if (input.ports.live.latestProviderActionWindow !== "corrective_source") {
    return null;
  }
  const allowedTargets = [...new Set(
    (latestRuntimeV2CorrectiveMutationFailure(input.effects)?.targets || [])
      .map((target) => String(target || "").trim())
      .filter(Boolean),
  )];
  const correction = deriveRuntimeV2ValidationCorrectionWindow(
    typeof input.ports.get === "function"
      ? aggregateForCurrentTurn(input.ports)
      : null,
  );
  const focusedHints = correction.diagnosticSourceHints.filter((hint) =>
    allowedTargets.some((target) =>
      workspacePathsReferToSameFile(hint.target, target)
    )
  );
  let rejection: {
    readonly call: RuntimeV2NormalizedProviderResult["toolCalls"][number];
    readonly reason: "target" | "range";
  } | null = null;
  for (const call of input.result.toolCalls) {
    if (call.name !== "read_file") {
      rejection = { call, reason: "target" };
      break;
    }
    const requested = String(call.arguments.path || "").trim();
    if (
      !requested ||
      !allowedTargets.some((target) =>
        workspacePathsReferToSameFile(requested, target)
      )
    ) {
      rejection = { call, reason: "target" };
      break;
    }
    const targetHints = focusedHints.filter((hint) =>
      workspacePathsReferToSameFile(hint.target, requested)
    );
    if (targetHints.length === 0) continue;
    const startLine = Math.floor(Number(call.arguments.start_line));
    const endLine = Math.floor(Number(call.arguments.end_line));
    const focused =
      Number.isFinite(startLine) &&
      Number.isFinite(endLine) &&
      startLine > 0 &&
      endLine >= startLine &&
      endLine - startLine + 1 <= 160 &&
      targetHints.some((hint) =>
        hint.line >= startLine && hint.line <= endLine
      );
    if (!focused) {
      rejection = { call, reason: "range" };
      break;
    }
  }
  if (!rejection) return null;
  const focusedRanges = focusedHints.map((hint) =>
    `${hint.target}:${hint.startLine}-${hint.endLine}`
  );
  const feedback = rejection.reason === "range"
    ? [
        "CORRECTIVE_SOURCE_RANGE_REJECTED: the failed acceptance receipt already named the causal source line; this broad or unrelated window did not run.",
        `Submit one exact focused read with both start_line and end_line: ${focusedRanges.join(", ")}.`,
        "Do not restart at line 1, page the file, or request the whole target. One successful batch closes reading and reopens a materially different mutation.",
      ].join("\n")
    : [
        "CORRECTIVE_SOURCE_REJECTED: this source is not the latest rejected mutation target; no read ran.",
        `Allowed exact target${allowedTargets.length === 1 ? "" : "s"}: ${allowedTargets.join(", ") || "none"}.`,
        focusedRanges.length > 0
          ? `Read the acceptance-diagnostic range now: ${focusedRanges.join(", ")}.`
          : "Read one smallest focused range on that target now.",
        "After one successful batch Runtime closes reading and reopens the corrective mutation tools.",
      ].join("\n");
  return rejectedProviderResult({
    ...input,
    rejectedCall: rejection.call,
    feedbackCode: rejection.reason === "range"
      ? "corrective_source_range_rejected"
      : "corrective_source_rejected",
    feedback,
    reason: rejection.reason === "range"
      ? "corrective_source_range_mismatch"
      : "corrective_source_target_mismatch",
    logData: { allowedTargets, focusedRanges },
  });
}
