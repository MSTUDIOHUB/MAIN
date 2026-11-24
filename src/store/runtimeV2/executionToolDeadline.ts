import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { RuntimeV2LifecycleDeadlineError, type RuntimeV2Command } from "../../lib/runtime-v2";
import { beginCapsuleToolActivity } from "../../lib/capsuleLiveActivity";
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
  if (toolName === "unity_create_scene") return 180_000;
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
  readonly activity?: Parameters<typeof beginCapsuleToolActivity>[0];
  readonly lifecycleDeadlineAt?: number;
  readonly toolTimeoutMs?: number;
  readonly now?: () => number;
  readonly onTimeout?: (
    timeoutMs: number,
    boundary: RuntimeV2ToolDeadlineBoundary,
  ) => void;
}): Promise<T> {
  const now = input.now || Date.now;
  const configuredTimeoutMs = input.toolTimeoutMs ?? runtimeV2ToolDeadlineMs(input.toolName);
  const lifecycleRemainingMs = input.lifecycleDeadlineAt === undefined
    ? null
    : input.lifecycleDeadlineAt - now();
  if (lifecycleRemainingMs !== null && lifecycleRemainingMs <= 0) {
    input.onTimeout?.(0, "lifecycle");
    throw new RuntimeV2LifecycleDeadlineError();
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
  let finishActivity: (() => void) | undefined;
  const activity = input.activity;
  const task = activity ? () => {
    finishActivity = beginCapsuleToolActivity(activity);
    return input.task();
  } : input.task;
  try {
    if (!configuredTimeoutMs && lifecycleRemainingMs === null) {
      return await task();
    }
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
      task,
    });
  } catch (error) {
    if (timedOut && lifecycleOwnsDeadline) {
      throw new RuntimeV2LifecycleDeadlineError();
    }
    throw error;
  } finally {
    finishActivity?.();
  }
}

export function logRuntimeV2ToolDeadline(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly target: string | null;
  readonly timeoutMs: number;
  readonly boundary: RuntimeV2ToolDeadlineBoundary;
}): void {
  input.ports.logStoreEvent(
    input.boundary === "lifecycle"
      ? "runtime_v2_lifecycle_deadline_reached"
      : "runtime_v2_tool_deadline_exceeded",
    {
      turnId: input.command.run.turnId,
      runId: input.command.run.runId,
      commandKind: input.command.kind,
      toolName: input.toolName,
      target: /^(?:run_command|knowledge_search|web_search|web_fetch)$/.test(input.toolName) ? null : input.target,
      timeoutMs: input.timeoutMs,
      lifecycleDeadlineAt: input.boundary === "lifecycle"
        ? input.ports.lifecycleDeadlineAt
        : null,
    },
  );
}
