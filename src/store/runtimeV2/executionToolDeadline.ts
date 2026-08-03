import { RuntimeV2LifecycleDeadlineError } from "../../lib/runtime-v2";
import { RUNTIME_V2_SOURCE_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { withRuntimeV2HardDeadline } from "./hardDeadline";

export const RUNTIME_V2_SOURCE_TOOL_TIMEOUT_MS = 45_000;
export const RUNTIME_V2_VALIDATION_TOOL_TIMEOUT_MS = 120_000;

const RUNTIME_V2_BOUNDED_VALIDATION_TOOLS = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
]);

export type RuntimeV2ToolDeadlineBoundary = "tool" | "lifecycle";

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
  readonly onTimeout?: (
    timeoutMs: number,
    boundary: RuntimeV2ToolDeadlineBoundary,
  ) => void;
}): Promise<T> {
  const now = input.now || Date.now;
  const configuredTimeoutMs = runtimeV2ToolDeadlineMs(input.toolName);
  const lifecycleRemainingMs = input.lifecycleDeadlineAt === undefined
    ? null
    : input.lifecycleDeadlineAt - now();
  if (lifecycleRemainingMs !== null && lifecycleRemainingMs <= 0) {
    input.onTimeout?.(0, "lifecycle");
    throw new RuntimeV2LifecycleDeadlineError();
  }
  if (!configuredTimeoutMs && lifecycleRemainingMs === null) {
    return input.task();
  }
  const lifecycleOwnsDeadline =
    lifecycleRemainingMs !== null &&
    (
      configuredTimeoutMs === null ||
      lifecycleRemainingMs <= configuredTimeoutMs
    );
  const timeoutMs = Math.max(
    1,
    lifecycleOwnsDeadline
      ? lifecycleRemainingMs
      : configuredTimeoutMs!,
  );
  let timedOut = false;
  try {
    return await withRuntimeV2HardDeadline({
      timeoutMs,
      timeoutError: `RUNTIME_V2_TOOL_TIMEOUT:${input.toolName}`,
      onTimeout: () => {
        timedOut = true;
        input.onTimeout?.(
          timeoutMs,
          lifecycleOwnsDeadline ? "lifecycle" : "tool",
        );
      },
      task: input.task,
    });
  } catch (error) {
    if (timedOut && lifecycleOwnsDeadline) {
      throw new RuntimeV2LifecycleDeadlineError();
    }
    throw error;
  }
}
