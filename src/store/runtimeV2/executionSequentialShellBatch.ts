import type { RuntimeV2Command, RuntimeV2NormalizedToolCall, TurnAggregateV1 } from "../../lib/runtime-v2";
import { isRuntimeV2ValidationAttempt } from "../../lib/runtime-v2/validationAttempt";
import { isRuntimeV2ReadOnlyToolCall, RUNTIME_V2_EDITOR_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { isReadOnlyShellInspectionToolCall } from "../../lib/repetitionGuard";
import { normalizeValidationWorkspaceCwd } from "../../lib/validationContract";

const independentRead = new Set(["knowledge_search", "knowledge_get_excerpt", "load_skill"]);

export interface RuntimeV2ShellBatchInterruption {
  readonly predecessorToolCallId: string;
  readonly reasonCode:
    | "provider_batch_predecessor_failed"
    | "provider_batch_predecessor_unsettled";
}

/** Reconstruct sequencing from the canonical provider/command/receipt ledger.
 * Reads may accompany shell actions in one ordered observation batch.
 * A failed predecessor fences dependent siblings. A bound Editor observation
 * queries current state independently and still goes through its own authorization. */
export function runtimeV2SequentialShellBatchInterruption(
  aggregate: TurnAggregateV1 | null,
  command: RuntimeV2Command,
): RuntimeV2ShellBatchInterruption | null {
  const callId = String(command.payload.toolCallId || "");
  if (!aggregate || !callId) return null;
  let batchIndex = -1;
  let predecessors: readonly RuntimeV2NormalizedToolCall[] = [];
  let sourceReadWithPriorVersion = false;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (event.type !== "provider.responded" || event.run.runId !== command.run.runId) continue;
    const calls = event.result.toolCalls;
    const currentIndex = calls.findIndex((call) => call.id === callId);
    if (currentIndex < 0) continue;
    const sequentialObservation = calls.some((call) => call.name === "run_command") &&
      calls.every((call) => call.name === "run_command" || isRuntimeV2ReadOnlyToolCall(call));
    if (currentIndex === 0 || !sequentialObservation) return null;
    if (calls[currentIndex]!.boundEditorObservation || RUNTIME_V2_EDITOR_READ_TOOL_NAMES.has(calls[currentIndex]!.name)) return null;
    batchIndex = index;
    const current = calls[currentIndex]!;
    const currentReadIsIndependent = independentRead.has(current.name);
    const workspace = aggregate.turn.workspaceKey;
    const readPath = current.name === "read_file" &&
      normalizeValidationWorkspaceCwd(String(current.arguments.path || ""), workspace);
    sourceReadWithPriorVersion = Boolean(readPath && aggregate.events.slice(0, index).some(event => {
      const evidence = event.type === "observation.recorded" ? [event.evidence]
        : event.type === "tool.completed" && event.status === "succeeded" ? event.evidence : [];
      return evidence.some(item => item.kind === "source" && item.version &&
        normalizeValidationWorkspaceCwd(item.target, workspace) === readPath);
    }));
    predecessors = calls.slice(0, currentIndex)
      .filter(call => !currentReadIsIndependent || call.name !== "run_command");
    break;
  }
  if (batchIndex < 0) return null;
  const predecessorIds = new Set(predecessors.map(call => call.id));
  const commandCalls = new Map<string, string>();
  const succeeded = new Map<string, boolean>();
  const shellDeniedBeforeDispatch = new Set<string>();
  for (const event of aggregate.events.slice(batchIndex + 1)) {
    if (!("run" in event) || event.run.runId !== command.run.runId) continue;
    if (event.type === "command.scheduled") {
      const id = String(event.command.payload.toolCallId || "");
      if (predecessorIds.has(id)) commandCalls.set(event.command.idempotencyKey, id);
    } else if (event.type === "tool.completed" || event.type === "validation.completed") {
      const id = commandCalls.get(event.idempotencyKey);
      if (!id) continue;
      succeeded.set(id, event.type === "validation.completed"
        ? isRuntimeV2ValidationAttempt(event) && event.passed : event.status === "succeeded");
      if (event.type === "tool.completed" && event.status === "blocked" &&
          event.failureReasonCode === "shell_workspace_path_escape") shellDeniedBeforeDispatch.add(id);
    }
  }
  for (const predecessor of predecessors) {
    const { id } = predecessor;
    // A fresh exact read of a previously observed file can stand on its own
    // after a non-mutating shell probe was denied before dispatch.
    if (sourceReadWithPriorVersion && shellDeniedBeforeDispatch.has(id) &&
        isReadOnlyShellInspectionToolCall(predecessor.name, predecessor.arguments)) continue;
    if (succeeded.get(id) !== true) return {
      predecessorToolCallId: id,
      reasonCode: succeeded.has(id)
        ? "provider_batch_predecessor_failed"
        : "provider_batch_predecessor_unsettled",
    };
  }
  return null;
}
