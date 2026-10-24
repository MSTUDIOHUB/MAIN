import type { RuntimeV2Command, RuntimeV2EventDraft } from "../../lib/runtime-v2";
import { aggregateForCurrentTurn } from "./executionAggregate";
import { recordToolResultHistory, toolCompletionFor } from "./executionEvidence";
import { runtimeV2SequentialShellBatchInterruption } from "./executionSequentialShellBatch";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

/** Close an interrupted batch's remaining transport pairs without crossing
 * authorization or execution boundaries. Receipt projection is separate from
 * the pure ledger rule used by both scheduling and effect reconstruction. */
export function interruptedRuntimeV2ShellBatchReceipt(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): RuntimeV2EventDraft | null {
  const { ports, command, toolName, args, target } = input;
  const interruption = runtimeV2SequentialShellBatchInterruption(
    aggregateForCurrentTurn(ports),
    command,
  );
  if (!interruption) return null;
  const content = `TOOL_NOT_EXECUTED: ${toolName} was not executed because predecessor ${interruption.predecessorToolCallId} in the same shell batch did not succeed. Reassess the remaining commands from the actual receipts.`;
  recordToolResultHistory({ ports, command, toolName, target, status: "blocked", content });
  ports.logStoreEvent("runtime_v2_tool_execution_blocked", {
    turnId: command.run.turnId,
    runId: command.run.runId,
    commandKind: command.kind,
    toolName,
    target: target || null,
    reason: interruption.reasonCode,
    predecessorToolCallId: interruption.predecessorToolCallId,
  });
  const receipt = toolCompletionFor(
    ports, command, toolName, args, target, content, "blocked",
    "execution_failed", undefined, undefined, interruption.reasonCode,
  );
  return receipt.type === "validation.completed"
    ? {
        ...receipt,
        evidence: [],
        failureKind: "not_executed",
        failureReasonCode: interruption.reasonCode,
      }
    : receipt;
}
