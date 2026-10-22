import type { RuntimeV2Command, RuntimeV2EventDraft } from "../../lib/runtime-v2";
import { runtimeV2ToolCapabilityRestriction } from "./executionAuthorizationContext";
import { recordToolResultHistory, toolCompletionFor } from "./executionEvidence";
import { interruptedRuntimeV2ShellBatchReceipt } from "./executionSequentialShellBatchReceipt";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

/** Gate before cached observations, approval and execution. A prior approval
 * cannot override the current Turn's durable capability restrictions. */
export function runtimeV2ToolPreExecutionReceipt(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): RuntimeV2EventDraft | null {
  const { ports, command, toolName, args, target } = input;
  ports.logStoreEvent("runtime_v2_tool_execution_started", {
    turnId: command.run.turnId, runId: command.run.runId,
    commandKind: command.kind, toolName, target: target || null,
  });
  const interrupted = interruptedRuntimeV2ShellBatchReceipt(input);
  if (interrupted) return interrupted;
  const restriction = runtimeV2ToolCapabilityRestriction(ports, toolName, args);
  if (!restriction) return null;
  const content = `TURN_CAPABILITY_RESTRICTED: ${restriction}`;
  recordToolResultHistory({ ports, command, toolName, target, status: "blocked", content });
  const receipt = toolCompletionFor(ports, command, toolName, args, target, content,
    "blocked", "not_authorized", undefined, undefined, "turn_capability_restricted");
  return receipt.type === "validation.completed"
    ? { ...receipt, evidence: [], failureKind: "not_executed", failureReasonCode: "turn_capability_restricted" }
    : receipt;
}
