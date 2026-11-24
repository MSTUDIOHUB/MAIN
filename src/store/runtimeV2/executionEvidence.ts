import { readOnlyEvidenceVersion, webEvidenceVersions } from "../../lib/runtime-v2/readOnlyProgress";
import { RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  runtimeV2EvidenceVersion,
  type RuntimeV2Command,
  type RuntimeV2EvidenceReference,
  type RuntimeV2EventDraft,
  type RuntimeV2ToolEffectKind,
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
import { boundedPresentationDiff } from "./toolOutcomePresentation";
import { authorizationFor } from "./executionAuthorizationContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import { appendRuntimeV2ToolResultHistory } from "./executionProviderHistory";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2LiveExecutionState,
} from "./executionTypes";
import {
  runtimeV2ToolEvidenceProjection,
  runtimeV2ToolHasStructuredValidatorContract,
} from "./executionEffectEvidence";
import { runtimeV2ProviderToolCallIdentity } from "./providerReadReceipts";

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

export function recordToolResultHistory(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly target: string;
  readonly status: "succeeded" | "failed" | "blocked";
  readonly content: string;
}): void {
  const toolCallId = String(input.command.payload.toolCallId || "");
  appendRuntimeV2ToolResultHistory(
    input.ports.live,
    toolCallId,
    input.status === "succeeded" ? input.content : `[runtime-v2 failed action: ${runtimeV2ProviderToolCallIdentity({ name: input.toolName, arguments: input.command.payload.arguments as Record<string, unknown> || {} })}]\n${input.content}`,
  );
}

export function toolDefinitionExists(
  input: RuntimeV2ExecutionPortsInput,
  name: string,
): boolean {
  const resolution = authorizationFor(input).toolCatalog.lookup(name);
  return resolution.status === "resolved" &&
    (
      resolution.entry.source === "built_in" ||
      resolution.entry.source === "mcp"
    );
}

function toolResultEvent(
  command: RuntimeV2Command,
  status: "succeeded" | "failed" | "blocked",
  evidence: RuntimeV2EvidenceReference[],
  failureKind?: RuntimeV2ToolFailureKind,
  presentation?: RuntimeV2ToolPresentation,
  failureReasonCode?: string,
  effectKind?: RuntimeV2ToolEffectKind,
  operationName?: string,
): Extract<RuntimeV2EventDraft, { type: "tool.completed" }> {
  return {
    type: "tool.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    status,
    evidence,
    ...(effectKind ? { effectKind } : {}),
    ...(operationName ? { operationName } : {}),
    ...(presentation ? { presentation } : {}),
    ...(status !== "succeeded" && failureKind ? { failureKind } : {}),
    ...(status !== "succeeded" && failureReasonCode ? { failureReasonCode } : {}),
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
  failureReasonCode?: string,
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
    ...(!passed && failureReasonCode ? { failureReasonCode } : {}),
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
export function toolResultContentForModel(output: unknown): string {
  const result = parseResultRecord(output);
  if (!result) {
    const text = typeof output === "string"
      ? output
      : String(output ?? "");
    return text.length > 0
      ? text
      : "TOOL_RESULT_EMPTY: the tool completed successfully and returned no content or matches.";
  }
  const exitCode = typeof result.exitCode === "number"
    ? result.exitCode
    : typeof result.exit_code === "number"
      ? result.exit_code
      : typeof result.exitCodeAfter === "number"
        ? result.exitCodeAfter
        : null;
  // MCP diagnostics carry a display summary and a separate data payload.
  // The summary alone omits the actual evidence delivered to the model.
  if (exitCode === null && result.stdout === undefined && result.stderr === undefined && result.data !== undefined) {
    return typeof output === "string" ? output : JSON.stringify(result);
  }
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
      ? output ||
        "TOOL_RESULT_EMPTY: the tool completed successfully and returned no content or matches."
      : JSON.stringify(output) ||
        "TOOL_RESULT_EMPTY: the tool completed successfully and returned no content or matches.";
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

export function runtimeV2ValidationEvidenceVersion(output: unknown): string {
  const result = parseResultRecord(output);
  const exitCode = result && (
      typeof result.exitCode === "number" ||
      typeof result.exit_code === "number" ||
      typeof result.exitCodeAfter === "number"
    )
    ? Number(result.exitCode ?? result.exit_code ?? result.exitCodeAfter)
    : null;
  const failed = Boolean(
    result && (
      result.error ||
      result.timedOut === true ||
      result.timeout === true ||
      result.success === false ||
      result.passed === false ||
      (exitCode !== null && exitCode !== 0)
    ),
  );
  const failureDiagnostic = failed && result
    ? ["error", "message", "stderr"]
        .map((field) => typeof result[field] === "string"
          ? String(result[field]).trim()
          : "")
        .filter(Boolean)
        .join("\n")
    : "";
  const stableDiagnostic = (failureDiagnostic ||
    toolResultContentForModel(output))
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/:\d+(?::\d+)?\b/g, ":<line>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?)\b/gi, "<duration>")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24)
    .join("\n");
  return runtimeV2EvidenceVersion([
    exitCode === null ? "" : `exitCode:${exitCode}`,
    stableDiagnostic,
  ].filter(Boolean).join("\n") || output);
}

function boundedPresentationText(value: unknown, max: number): string {
  const text = toolResultContentForModel(value)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
  if (!text) return "";
  return text.length <= max
    ? text
    : `${text.slice(0, max - 38).trim()}\n[Tool output truncated by Runtime v2.]`;
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
  failureReasonCode?: string,
): RuntimeV2EventDraft {
  const presentation = toolPresentation({
    toolName,
    target,
    output,
    diffPreview,
  });
  if (command.kind !== "execute_validation") {
    const toolFailureKind = failureKind === "assertion_failed" || failureKind === "not_executed"
      ? "protocol_invalid"
      : failureKind;
    if (status !== "succeeded") {
      const failure = toolResultEvent(command, status, [], toolFailureKind, presentation, failureReasonCode);
      return toolName === "run_command" && failureReasonCode === "command_exit_nonzero"
        ? { ...failure, diagnosticVersion: runtimeV2ValidationEvidenceVersion(output) }
        : failure;
    }
    const projection = runtimeV2ToolEvidenceProjection({
      ports: input,
      toolName,
      args,
      target,
      result: parseResultRecord(output),
    });
    return toolResultEvent(
      command,
      status,
      !RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(toolName) || (webEvidenceVersions(toolName, output)?.length || 0) > 0
        ? projection.targets.map(({ target: resolvedTarget, version }) => ({
            id: nextEvidenceId(input.live),
            kind: projection.kind,
            target: resolvedTarget,
            version: version || (projection.kind === "source"
              ? sourceVersion || runtimeV2EvidenceVersion(output)
              : projection.kind === "tool"
                ? readOnlyEvidenceVersion(toolName, output) || runtimeV2ValidationEvidenceVersion(output)
                : null),
          }))
        : [],
      undefined,
      presentation,
      failureReasonCode,
      projection.effectKind,
      projection.operationName,
    );
  }
  const passed = status === "succeeded" &&
    runtimeV2ToolHasStructuredValidatorContract(input, toolName) &&
    isRuntimeV2ValidationPassed(toolName, output, undefined);
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
    failureReasonCode,
  );
}

/** Preserve semantic failure in the provider context even when the underlying
 * tool transport itself completed successfully. A finite validator with a
 * non-zero exit code is failed evidence, not a successful tool observation. */
export function toolResultStatusForCompletion(
  completion: RuntimeV2EventDraft,
): "succeeded" | "failed" | "blocked" {
  if (completion.type === "validation.completed") {
    return completion.passed ? "succeeded" : "failed";
  }
  if (completion.type === "tool.completed") return completion.status;
  return "succeeded";
}
