import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import type {
  RuntimeV2NormalizedToolCall,
  RuntimeV2SubagentJob,
} from "../../lib/runtime-v2";
import { boundedRuntimeV2ToolContent } from "./executionText";
import { normalizeRuntimeV2ProviderToolCalls } from "./executionProviderTools";
import {
  boundRuntimeV2ProviderToolCalls,
  runtimeV2ProviderToolCallIdentity,
} from "./providerToolSurface";

const CHILD_STEP_MAX_OUTPUT_TOKENS = 8_192;
const CHILD_STEP_FALLBACK_OUTPUT_TOKENS = 4_096;

export class RuntimeV2ChildDeadlineError extends Error {
  constructor(message = "Runtime v2 child deadline exceeded.") {
    super(message);
    this.name = "RuntimeV2ChildDeadlineError";
  }
}

export const READ_ONLY_CHILD_TOOL_NAMES = new Set([
  "list_directory",
  "read_file",
  "grep_search",
  "get_file_outline",
  "code_ast_query",
  "find_symbol_references",
]);

export const VALIDATION_CHILD_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
]);

export const MUTATION_CHILD_TOOL_NAMES = new Set([
  "replace_in_file",
  "write_file",
  "apply_patch",
  "delete_workspace_path",
]);

const CHILD_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((definition) =>
  READ_ONLY_CHILD_TOOL_NAMES.has(definition.function.name) ||
  VALIDATION_CHILD_TOOL_NAMES.has(definition.function.name) ||
  MUTATION_CHILD_TOOL_NAMES.has(definition.function.name)
);

export function runtimeV2ChildDeadlineAt(
  parentLifecycleDeadlineAt?: number,
): number {
  return Number.isFinite(parentLifecycleDeadlineAt)
    ? Number(parentLifecycleDeadlineAt)
    : Number.POSITIVE_INFINITY;
}

export function runtimeV2ChildDeadlineExceeded(input: {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly now?: number;
}): boolean {
  return input.signal.reason instanceof RuntimeV2ChildDeadlineError ||
    (
      Number.isFinite(input.deadlineAt) &&
      (input.now ?? Date.now()) >= input.deadlineAt
    );
}

export function boundRuntimeV2ChildToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
  attemptedIdentities: ReadonlySet<string> = new Set(),
): RuntimeV2NormalizedToolCall[] {
  return boundRuntimeV2ProviderToolCalls(
    calls,
    attemptedIdentities,
  ).accepted;
}

/** Degrade only after a child repeats identities that were already closed. */
export function runtimeV2ChildClosedActionLoopDetected(input: {
  readonly calls: readonly RuntimeV2NormalizedToolCall[];
  readonly acceptedCallIds: ReadonlySet<string>;
  readonly previouslyRejectedIdentities: ReadonlySet<string>;
}): boolean {
  return input.calls.length > 0 &&
    input.calls.every((call) =>
      !input.acceptedCallIds.has(call.id) &&
      input.previouslyRejectedIdentities.has(
        runtimeV2ProviderToolCallIdentity(call),
      )
    );
}

/** Close argument churn once it reproduces an already-rejected observation. */
export function runtimeV2ChildClosedObservationLoopDetected(input: {
  readonly fingerprint: string;
  readonly isNewEvidence: boolean;
  readonly previouslyRejectedFingerprints: ReadonlySet<string>;
}): boolean {
  return !input.isNewEvidence &&
    input.previouslyRejectedFingerprints.has(input.fingerprint);
}

export function normalizeRuntimeV2ChildToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
  tools: readonly ToolDefinition[],
  workspace?: string | null,
): RuntimeV2NormalizedToolCall[] {
  return normalizeRuntimeV2ProviderToolCalls(calls, tools, workspace);
}

export function runtimeV2ChildToolOutputContent(
  toolName: string,
  value: unknown,
  budget?: RuntimeContextBudget | null,
): string {
  return boundedRuntimeV2ToolContent(toolName, value, budget);
}

export function runtimeV2ChildOutputTokenLimit(
  budget?: Pick<RuntimeContextBudget, "outputBudget"> | null,
): number {
  const admitted = Math.floor(Number(budget?.outputBudget));
  return Number.isFinite(admitted) && admitted > 0
    ? Math.min(admitted, CHILD_STEP_MAX_OUTPUT_TOKENS)
    : CHILD_STEP_FALLBACK_OUTPUT_TOKENS;
}

export function runtimeV2ChildTools(
  job: RuntimeV2SubagentJob,
): ToolDefinition[] {
  return CHILD_TOOL_DEFINITIONS.filter((definition) =>
    READ_ONLY_CHILD_TOOL_NAMES.has(definition.function.name) ||
    (job.taskKind === "validate" &&
      VALIDATION_CHILD_TOOL_NAMES.has(definition.function.name)) ||
    (job.taskKind === "implement" && job.accessMode === "write" &&
      MUTATION_CHILD_TOOL_NAMES.has(definition.function.name))
  );
}
