import {
  runtimeV2EvidenceVersion,
  type RuntimeV2Command,
  type RuntimeV2EvidenceReference,
  type RuntimeV2EventDraft,
  type RuntimeV2ToolPresentation,
  type RuntimeV2ExecutionValidationAuthority,
  deriveRuntimeV2ValidationBoundary,
} from "../../lib/runtime-v2";
import { parseBrowserInteractionEvidence } from "../../lib/planEvidence";
import {
  evaluateValidationSpec,
  type ValidationEvidence,
  type ValidationPrimitiveSpec,
} from "../../lib/validationContract";
import type { ToolDiffPreview } from "../../lib/toolDiff";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { authorizationFor } from "./executionAuthorization";
import { aggregateForCurrentTurn } from "./executionAggregate";
import { recordModelContext } from "./executionProviderContext";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2LiveExecutionState,
} from "./executionTypes";

type RuntimeV2ToolFailureKind = NonNullable<Extract<
  RuntimeV2EventDraft,
  { type: "tool.completed" }
>["failureKind"]>;
type RuntimeV2ValidationFailureKind = NonNullable<Extract<
  RuntimeV2EventDraft,
  { type: "validation.completed" }
>["failureKind"]>;
type RuntimeV2CompletionFailureKind =
  | RuntimeV2ToolFailureKind
  | RuntimeV2ValidationFailureKind;

export function nextEvidenceId(live: RuntimeV2LiveExecutionState): string {
  live.evidenceCounter += 1;
  return `E${live.evidenceCounter}`;
}

export function recordToolModelContext(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly target: string;
  readonly status: "succeeded" | "failed" | "blocked";
  readonly content: string;
}): void {
  recordModelContext(input.ports.live, {
    id: `tool-result:${String(input.command.payload.toolCallId || input.ports.nextId("tool-context"))}`,
    source: "tool",
    label: input.toolName || "unknown_tool",
    target: input.target || input.toolName || "workspace",
    status: input.status,
    content: input.content,
  });
}

export function toolDefinitionExists(
  input: RuntimeV2ExecutionPortsInput,
  name: string,
): boolean {
  const resolution = authorizationFor(input).toolCatalog.lookup(name);
  return resolution.status === "resolved" &&
    resolution.entry.source === "built_in";
}

function toolResultEvent(
  command: RuntimeV2Command,
  status: "succeeded" | "failed" | "blocked",
  evidence: RuntimeV2EvidenceReference[],
  failureKind?: RuntimeV2ToolFailureKind,
  presentation?: RuntimeV2ToolPresentation,
): RuntimeV2EventDraft {
  return {
    type: "tool.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    status,
    evidence,
    ...(presentation ? { presentation } : {}),
    ...(status !== "succeeded" && failureKind ? { failureKind } : {}),
  };
}

function validationResultEvent(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
  passed: boolean,
  evidence: Array<{
    id: string;
    kind: "validation";
    target: string;
    version: string | null;
  }>,
  failureKind?: RuntimeV2ValidationFailureKind,
  presentation?: RuntimeV2ToolPresentation,
): RuntimeV2EventDraft {
  const authority = command.payload.validationAuthority
    ? command.payload.validationAuthority as unknown as
      RuntimeV2ExecutionValidationAuthority
    : null;
  const aggregate = authority ? aggregateForCurrentTurn(input) : null;
  const validationBoundary = authority && aggregate
    ? deriveRuntimeV2ValidationBoundary(aggregate, authority.targetPaths)
    : null;
  return {
    type: "validation.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    passed,
    evidence,
    ...(authority ? { authority } : {}),
    ...(validationBoundary || {}),
    ...(presentation ? { presentation } : {}),
    ...(!passed && failureKind ? { failureKind } : {}),
  };
}

export function parseResultRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Decode structured command results before retaining them as model context.
 * Keeping JSON-escaped stdout/stderr as one line prevents the recovery layer
 * from seeing compiler and test `path:line` diagnostics. */
export function modelContextContentForToolOutput(output: unknown): string {
  const result = parseResultRecord(output);
  if (!result) return typeof output === "string" ? output : String(output ?? "");
  const exitCode = typeof result.exitCode === "number"
    ? result.exitCode
    : typeof result.exit_code === "number"
      ? result.exit_code
      : typeof result.exitCodeAfter === "number"
        ? result.exitCodeAfter
        : null;
  // Failed builds often emit a very large stdout preamble before putting the
  // actionable path:line diagnostics in stderr. Failure detail must lead the
  // bounded context so truncation cannot hide the source recovery authority.
  const failed = (exitCode !== null && exitCode !== 0) ||
    result.success === false ||
    result.ok === false ||
    result.error !== undefined;
  const textFields = failed
    ? ["stderr", "error", "message", "stdout"] as const
    : ["stdout", "stderr", "message", "error"] as const;
  const content = textFields
    .map((field) => typeof result[field] === "string"
      ? String(result[field]).trim()
      : "")
    .filter(Boolean);
  if (exitCode !== null) content.unshift(`exitCode: ${exitCode}`);
  if (result.timedOut === true || result.timeout === true) {
    content.unshift("timedOut: true");
  }
  return content.length > 0
    ? content.join("\n")
    : typeof output === "string"
      ? output
      : JSON.stringify(output);
}

export function isRuntimeV2ValidationPassed(
  toolName: string,
  output: unknown,
  primitive?: ValidationPrimitiveSpec,
): boolean {
  const result = parseResultRecord(output);
  if (!result) return false;
  if (result.timedOut === true || result.timeout === true || result.error) {
    return false;
  }
  if (primitive?.kind === "finite_command") {
    const exitCode =
      typeof result.exitCode === "number"
        ? result.exitCode
        : typeof result.exit_code === "number"
          ? result.exit_code
          : typeof result.exitCodeAfter === "number"
            ? result.exitCodeAfter
            : null;
    const evidence: ValidationEvidence = {
      kind: "finite_command_result",
      command: primitive.command,
      ...(primitive.cwd ? { cwd: primitive.cwd } : {}),
      completed: exitCode !== null,
      exitCode,
      ...(result.timedOut === true || result.timeout === true
        ? { timedOut: true }
        : {}),
    };
    return evaluateValidationSpec(primitive, [evidence])
      .acceptanceSatisfied;
  }
  if (
    primitive?.kind === "browser_interaction" ||
    primitive?.kind === "desktop_interaction"
  ) {
    const raw = typeof output === "string"
      ? output
      : JSON.stringify(output);
    const interaction = parseBrowserInteractionEvidence(raw);
    if (!interaction) return false;
    const evidence: ValidationEvidence = {
      kind: primitive.kind === "browser_interaction"
        ? "browser_interaction_result"
        : "desktop_interaction_result",
      actions: interaction.actions.map((action) => ({
        ...(action.id ? { id: action.id } : {}),
        kind: action.kind,
        target: action.target,
        succeeded: action.succeeded,
      })),
      assertions: interaction.assertions.map((assertion) => ({
        kind: assertion.kind,
        target: assertion.target,
        passed: assertion.passed,
        ...(assertion.afterActionId
          ? { afterActionId: assertion.afterActionId }
          : {}),
        ...(typeof assertion.beforePassed === "boolean"
          ? { beforePassed: assertion.beforePassed }
          : {}),
        ...(typeof assertion.changedAfterAction === "boolean"
          ? { changedAfterAction: assertion.changedAfterAction }
          : {}),
        ...(typeof assertion.causallyLinked === "boolean"
          ? { causallyLinked: assertion.causallyLinked }
          : {}),
        ...(assertion.actual !== undefined
          ? { actual: assertion.actual }
          : {}),
      })),
      ...(interaction.pageErrors.length > 0
        ? { pageErrors: interaction.pageErrors }
        : {}),
      ...(interaction.consoleErrors.length > 0
        ? { consoleErrors: interaction.consoleErrors }
        : {}),
    };
    return evaluateValidationSpec(primitive, [evidence])
      .acceptanceSatisfied;
  }
  if (
    toolName === "browser_evaluate" ||
    toolName === "computer_use"
  ) {
    const raw = typeof output === "string"
      ? output
      : JSON.stringify(output);
    const interaction = parseBrowserInteractionEvidence(raw);
    if (
      !interaction ||
      interaction.assertions.length === 0 ||
      interaction.assertions.some((assertion) => !assertion.passed) ||
      interaction.actions.some((action) => !action.succeeded) ||
      interaction.pageErrors.length > 0 ||
      interaction.consoleErrors.length > 0
    ) {
      return false;
    }
    return interaction.actions.length === 0 ||
      interaction.assertions.some((assertion) =>
        assertion.causallyLinked === true ||
        (
          assertion.changedAfterAction === true &&
          assertion.beforePassed === false
        )
      );
  }
  if (typeof result.exitCode === "number") return result.exitCode === 0;
  if (typeof result.exit_code === "number") return result.exit_code === 0;
  if (typeof result.exitCodeAfter === "number") {
    return result.exitCodeAfter === 0;
  }
  if (result.passed === true || result.success === true || result.ok === true) {
    return true;
  }
  // PTY dispatch only confirms that input was accepted; it does not establish
  // a completed validation process and must not close acceptance.
  if (/^(?:run_command|execute_command)$/i.test(toolName)) return false;
  return false;
}

function validationPrimitiveForCommand(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): ValidationPrimitiveSpec | undefined {
  const authority = command.payload.validationAuthority as
    RuntimeV2ExecutionValidationAuthority | undefined;
  const contract = aggregateForCurrentTurn(input)?.executionContract;
  if (
    authority?.kind !== "execution_contract" ||
    !contract ||
    contract.status !== "active" ||
    authority.id !== contract.id ||
    authority.revision !== contract.revision ||
    authority.digest !== contract.digest
  ) {
    return undefined;
  }
  return contract.validations.find((validation) =>
    validation.id === authority.validationId
  )?.primitive;
}

export function runtimeV2ValidationEvidenceVersion(output: unknown): string {
  const stableDiagnostic = modelContextContentForToolOutput(output)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/:\d+(?::\d+)?\b/g, ":<line>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?)\b/gi, "<duration>")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24)
    .join("\n");
  return runtimeV2EvidenceVersion(stableDiagnostic || output);
}

function boundedPresentationText(value: unknown, max: number): string {
  const text = modelContextContentForToolOutput(value)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
  if (!text) return "";
  return text.length <= max
    ? text
    : `${text.slice(0, max - 38).trim()}\n[Tool output truncated by Runtime v2.]`;
}

function compactDiffText(
  value: string,
  start: number,
  end: number,
): string {
  const prefixOmitted = start > 0;
  const suffixOmitted = end < value.length;
  return [
    prefixOmitted ? "[... earlier unchanged content omitted ...]\n" : "",
    value.slice(start, end),
    suffixOmitted ? "\n[... later unchanged content omitted ...]" : "",
  ].join("");
}

function boundedPresentationDiff(
  preview: ToolDiffPreview | undefined,
): RuntimeV2ToolPresentation["diff"] | undefined {
  if (!preview) return undefined;
  const oldText = String(preview.old || "");
  const newText = String(preview.new || "");
  const maxCombinedChars = 120_000;
  if (oldText.length + newText.length <= maxCombinedChars) {
    return {
      old: oldText,
      new: newText,
      ...(preview.path ? { path: preview.path } : {}),
      ...(typeof preview.existed === "boolean"
        ? { existed: preview.existed }
        : {}),
      ...(typeof preview.fullFile === "boolean"
        ? { fullFile: preview.fullFile }
        : {}),
    };
  }
  let commonPrefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (
    commonPrefix < maxPrefix &&
    oldText.charCodeAt(commonPrefix) === newText.charCodeAt(commonPrefix)
  ) {
    commonPrefix += 1;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < oldText.length - commonPrefix &&
    commonSuffix < newText.length - commonPrefix &&
    oldText.charCodeAt(oldText.length - 1 - commonSuffix) ===
      newText.charCodeAt(newText.length - 1 - commonSuffix)
  ) {
    commonSuffix += 1;
  }
  const contextChars = 24_000;
  const oldStart = Math.max(0, commonPrefix - contextChars);
  const newStart = Math.max(0, commonPrefix - contextChars);
  const oldEnd = Math.min(
    oldText.length,
    oldText.length - commonSuffix + contextChars,
  );
  const newEnd = Math.min(
    newText.length,
    newText.length - commonSuffix + contextChars,
  );
  return {
    old: compactDiffText(oldText, oldStart, oldEnd),
    new: compactDiffText(newText, newStart, newEnd),
    ...(preview.path ? { path: preview.path } : {}),
    ...(typeof preview.existed === "boolean"
      ? { existed: preview.existed }
      : {}),
    ...(typeof preview.fullFile === "boolean"
      ? { fullFile: preview.fullFile }
      : {}),
  };
}

function toolPresentation(input: {
  toolName: string;
  target: string;
  output: unknown;
  diffPreview?: ToolDiffPreview;
}): RuntimeV2ToolPresentation {
  const message = boundedPresentationText(input.output, 4_000);
  const observationSummary = boundedPresentationText(input.output, 1_200);
  const diff = boundedPresentationDiff(input.diffPreview);
  return {
    toolName: input.toolName,
    target: input.target || input.toolName,
    ...(message ? { message } : {}),
    ...(observationSummary ? { observationSummary } : {}),
    ...(diff ? { diff } : {}),
  };
}

export function toolCompletionFor(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
  toolName: string,
  args: Record<string, unknown>,
  target: string,
  output: unknown,
  status: "succeeded" | "failed" | "blocked",
  failureKind?: RuntimeV2CompletionFailureKind,
  sourceVersion?: string,
  diffPreview?: ToolDiffPreview,
): RuntimeV2EventDraft {
  const presentation = toolPresentation({
    toolName,
    target,
    output,
    diffPreview,
  });
  if (command.kind !== "execute_validation") {
    const targets = isWorkspaceMutationToolName(toolName)
      ? resolveWorkspaceMutationTargets(toolName, args, target)
      : [target || toolName];
    const evidenceKind = isWorkspaceMutationToolName(toolName)
      ? "mutation" as const
      : RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(toolName)
        ? "source" as const
        : "tool" as const;
    return toolResultEvent(
      command,
      status,
      status === "succeeded"
        ? targets.map((resolvedTarget) => ({
            id: nextEvidenceId(input.live),
            kind: evidenceKind,
            target: resolvedTarget,
            version: evidenceKind === "source"
              ? sourceVersion || runtimeV2EvidenceVersion(output)
              : null,
          }))
        : [],
      failureKind === "assertion_failed"
        ? "protocol_invalid"
        : failureKind,
      presentation,
    );
  }
  const passed = status === "succeeded" &&
    isRuntimeV2ValidationPassed(
      toolName,
      output,
      validationPrimitiveForCommand(input, command),
    );
  const validationFailureKind =
    failureKind === "source_mismatch" ||
      failureKind === "target_invalid" ||
      failureKind === "mutation_rejected"
      ? "protocol_invalid"
      : failureKind;
  return validationResultEvent(
    input,
    command,
    passed,
    [{
      id: nextEvidenceId(input.live),
      kind: "validation",
      target: target || toolName,
      version: runtimeV2ValidationEvidenceVersion(output),
    }],
    passed
      ? undefined
      : validationFailureKind ||
        (status === "succeeded"
          ? "assertion_failed"
          : "execution_failed"),
    presentation,
  );
}

/** Preserve semantic failure in the provider context even when the underlying
 * tool transport itself completed successfully. A finite validator with a
 * non-zero exit code is failed evidence, not a successful tool observation. */
export function modelContextStatusForCompletion(
  completion: RuntimeV2EventDraft,
): "succeeded" | "failed" | "blocked" {
  if (completion.type === "validation.completed") {
    return completion.passed ? "succeeded" : "failed";
  }
  if (completion.type === "tool.completed") return completion.status;
  return "succeeded";
}
