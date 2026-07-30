import { RUNTIME_V2_SOURCE_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { withRuntimeV2HardDeadline } from "./hardDeadline";

export const RUNTIME_V2_SOURCE_TOOL_TIMEOUT_MS = 45_000;
export const RUNTIME_V2_VALIDATION_TOOL_TIMEOUT_MS = 120_000;

const RUNTIME_V2_BOUNDED_VALIDATION_TOOLS = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
]);

export function runtimeV2ToolDeadlineMs(toolName: string): number | null {
  if (RUNTIME_V2_SOURCE_READ_TOOL_NAMES.has(toolName)) {
    return RUNTIME_V2_SOURCE_TOOL_TIMEOUT_MS;
  }
  return RUNTIME_V2_BOUNDED_VALIDATION_TOOLS.has(toolName)
    ? RUNTIME_V2_VALIDATION_TOOL_TIMEOUT_MS
    : null;
}

export async function executeRuntimeV2ToolWithDeadline<T>(input: {
  readonly toolName: string;
  readonly task: () => Promise<T>;
  readonly lifecycleDeadlineAt?: number;
  readonly now?: () => number;
  readonly onTimeout?: (timeoutMs: number) => void;
}): Promise<T> {
  const now = input.now || Date.now;
  const configuredTimeoutMs = runtimeV2ToolDeadlineMs(input.toolName);
  const lifecycleRemainingMs = input.lifecycleDeadlineAt === undefined
    ? null
    : input.lifecycleDeadlineAt - now();
  if (lifecycleRemainingMs !== null && lifecycleRemainingMs <= 0) {
    throw new Error(`RUNTIME_V2_LIFECYCLE_DEADLINE:${input.toolName}`);
  }
  if (!configuredTimeoutMs) return input.task();
  const timeoutMs = Math.max(
    1,
    lifecycleRemainingMs === null
      ? configuredTimeoutMs
      : Math.min(configuredTimeoutMs, lifecycleRemainingMs),
  );
  return withRuntimeV2HardDeadline({
    timeoutMs,
    timeoutError: `RUNTIME_V2_TOOL_TIMEOUT:${input.toolName}`,
    onTimeout: () => input.onTimeout?.(timeoutMs),
    task: input.task,
  });
}
