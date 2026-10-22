import type { RuntimeV2Command, TurnAggregateV1 } from "../../lib/runtime-v2";
import { isRuntimeV2ValidationAttempt } from "../../lib/runtime-v2/validationAttempt";

export interface RuntimeV2ShellBatchInterruption {
  readonly predecessorToolCallId: string;
  readonly reasonCode:
    | "provider_batch_predecessor_failed"
    | "provider_batch_predecessor_unsettled";
}

/** Reconstruct sequencing from the canonical provider/command/receipt ledger.
 * A failed command invalidates the assumptions behind its pending siblings;
 * each sibling still receives an ordinary tool result, without running it or
 * inventing another process-local queue. */
export function runtimeV2SequentialShellBatchInterruption(
  aggregate: TurnAggregateV1 | null,
  command: RuntimeV2Command,
): RuntimeV2ShellBatchInterruption | null {
  const callId = String(command.payload.toolCallId || "");
  if (!aggregate || !callId || command.payload.toolName !== "run_command") return null;
  let batchIndex = -1;
  let predecessors: readonly string[] = [];
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (event.type !== "provider.responded" || event.run.runId !== command.run.runId) continue;
    const calls = event.result.toolCalls;
    const currentIndex = calls.findIndex((call) => call.id === callId);
    if (currentIndex < 0) continue;
    if (currentIndex === 0 || !calls.every((call) => call.name === "run_command")) return null;
    batchIndex = index;
    predecessors = calls.slice(0, currentIndex).map((call) => call.id);
    break;
  }
  if (batchIndex < 0) return null;
  const predecessorIds = new Set(predecessors);
  const commandCalls = new Map<string, string>();
  const succeeded = new Map<string, boolean>();
  for (const event of aggregate.events.slice(batchIndex + 1)) {
    if (!("run" in event) || event.run.runId !== command.run.runId) continue;
    if (event.type === "command.scheduled") {
      const id = String(event.command.payload.toolCallId || "");
      if (predecessorIds.has(id)) commandCalls.set(event.command.idempotencyKey, id);
    } else if (event.type === "tool.completed" || event.type === "validation.completed") {
      const id = commandCalls.get(event.idempotencyKey);
      if (id) succeeded.set(id, event.type === "validation.completed"
        ? isRuntimeV2ValidationAttempt(event) && event.passed
        : event.status === "succeeded");
    }
  }
  for (const id of predecessors) {
    if (succeeded.get(id) !== true) return {
      predecessorToolCallId: id,
      reasonCode: succeeded.has(id)
        ? "provider_batch_predecessor_failed"
        : "provider_batch_predecessor_unsettled",
    };
  }
  return null;
}
