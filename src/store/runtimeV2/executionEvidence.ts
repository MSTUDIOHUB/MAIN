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
): RuntimeV2EventDraft {
  return {
    type: "tool.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    status,
    evidence,
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
  failureKind?: Extract<
    RuntimeV2EventDraft,
    { type: "validation.completed" }
  >["failureKind"],
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

function parseResultRecord(value: unknown): Record<string, unknown> | null {
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

export function toolCompletionFor(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
  toolName: string,
  args: Record<string, unknown>,
  target: string,
  output: unknown,
  status: "succeeded" | "failed" | "blocked",
  failureKind?: Extract<
    RuntimeV2EventDraft,
    { type: "validation.completed" }
  >["failureKind"],
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
    );
  }
  const passed = status === "succeeded" &&
    isValidationPassed(toolName, output);
  return validationResultEvent(
    command,
    passed,
    passed
      ? [{
          id: nextEvidenceId(input.live),
          kind: "validation",
          target: target || toolName,
          version: null,
        }]
      : [],
    passed
      ? undefined
      : failureKind ||
        (status === "succeeded" ? "assertion_failed" : "execution_failed"),
  );
}
