import {
  runtimeV2EvidenceVersion,
  type RuntimeV2Command,
  type RuntimeV2EvidenceReference,
  type RuntimeV2EventDraft,
} from "../../lib/runtime-v2";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { authorizationFor } from "./executionAuthorization";
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
): RuntimeV2EventDraft {
  return {
    type: "tool.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    status,
    evidence,
    ...(status !== "succeeded" && failureKind ? { failureKind } : {}),
  };
}

function validationResultEvent(
  command: RuntimeV2Command,
  passed: boolean,
  evidence: Array<{
    id: string;
    kind: "validation";
    target: string;
    version: string | null;
  }>,
  failureKind?: RuntimeV2ValidationFailureKind,
): RuntimeV2EventDraft {
  return {
    type: "validation.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    passed,
    evidence,
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

function isValidationPassed(toolName: string, output: unknown): boolean {
  const result = parseResultRecord(output);
  if (!result) return false;
  if (result.timedOut === true || result.timeout === true || result.error) {
    return false;
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

function validationEvidenceVersion(output: unknown): string {
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
): RuntimeV2EventDraft {
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
    );
  }
  const passed = status === "succeeded" &&
    isValidationPassed(toolName, output);
  const validationFailureKind =
    failureKind === "source_mismatch" ||
      failureKind === "target_invalid" ||
      failureKind === "mutation_rejected"
      ? "protocol_invalid"
      : failureKind;
  return validationResultEvent(
    command,
    passed,
    [{
      id: nextEvidenceId(input.live),
      kind: "validation",
      target: target || toolName,
      version: passed ? null : validationEvidenceVersion(output),
    }],
    passed
      ? undefined
      : validationFailureKind ||
        (status === "succeeded"
          ? "assertion_failed"
          : "execution_failed"),
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
