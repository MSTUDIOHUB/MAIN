import {
  runtimeV2SubagentStartHasRunway,
  type RuntimeV2Command,
} from "../../lib/runtime-v2";
import { appendRuntimeV2ToolResultHistory } from "./executionProviderHistory";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

function boundedArgument(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function closeCollaborationToolCall(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
  content: string,
): void {
  appendRuntimeV2ToolResultHistory(
    input.live,
    boundedArgument(command.payload.toolCallId, 256),
    content.trim().slice(0, 8_000),
  );
}

export function assertRuntimeV2SubagentScheduleRunway(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): void {
  if (runtimeV2SubagentStartHasRunway({
    now: input.now(),
    lifecycleDeadlineAt: input.lifecycleDeadlineAt,
  })) return;

  const detail =
    "The shared lifecycle has less than two minutes remaining, so a new child cannot be admitted safely. Continue the parent task directly.";
  closeCollaborationToolCall(
    input,
    command,
    `SUBAGENT_SCHEDULE_REJECTED: ${detail}`,
  );
  input.logStoreEvent("runtime_v2_subagent_schedule_rejected", {
    turnId: command.run.turnId,
    runId: command.run.runId,
    reason: "insufficient_lifecycle_runway",
    lifecycleDeadlineAt: input.lifecycleDeadlineAt ?? null,
  });
  throw new Error(detail);
}
