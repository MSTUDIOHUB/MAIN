import type { RuntimeV2Command, RuntimeV2EventDraft } from "../../lib/runtime-v2";
import { runtimeV2ToolApprovalCapability, runtimeV2ToolCapabilityRestriction } from "./executionAuthorizationContext";
import { recordToolResultHistory, toolCompletionFor } from "./executionEvidence";
import { interruptedRuntimeV2ShellBatchReceipt } from "./executionSequentialShellBatchReceipt";
import type { RuntimeV2PlanToolAuthorizationResult } from "./executionPlanAuthorization";
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

/** Automatic preparation requires a real project scope and cannot exercise a
 * capability requiring an explicit proposal. Settle preparation without claiming
 * an observation; model-proposed reads keep the ordinary deny/review gate. */
export function runtimeV2AutomaticObservationDeferredReceipt(
  ports: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): RuntimeV2EventDraft | null {
  const hasWorkspace = !!String(ports.context.runWorkspace || "").trim();
  const restriction = runtimeV2ToolCapabilityRestriction(ports, "get_project_skeleton");
  const requiredReview = runtimeV2ToolApprovalCapability(ports, "get_project_skeleton");
  if (hasWorkspace && !restriction && !requiredReview) return null;
  ports.logStoreEvent("runtime_v2_automatic_observation_deferred", {
    turnId: command.run.turnId, runId: command.run.runId,
    reason: !hasWorkspace ? "no_workspace" : restriction ? "turn_capability_restricted" : "turn_requires_human_review",
    capability: restriction || requiredReview,
  });
  return { type: "command.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded" };
}


/** The same causal rejection receipt is used before approval and after
 * trusted mutation preparation has resolved the actual file operation. */
export function runtimeV2ToolAuthorizationRejectionReceipt(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly failureContextTarget: string;
  readonly rejection: RuntimeV2PlanToolAuthorizationResult;
}): RuntimeV2EventDraft {
  const { ports, command, toolName, args, target, failureContextTarget, rejection } = input;
  const content = `TOOL_BLOCKED: ${rejection.reason}`;
  recordToolResultHistory({ ports, command, toolName, target: failureContextTarget, status: "blocked", content });
  ports.logStoreEvent("runtime_v2_tool_execution_blocked", {
    turnId: command.run.turnId,
    runId: command.run.runId,
    commandKind: command.kind,
    toolName,
    target: target || null,
    reason: rejection.reasonCode,
  });
  return toolCompletionFor(ports, command, toolName, args, failureContextTarget, content,
    "blocked", rejection.failureKind || "not_authorized", undefined, undefined, rejection.reasonCode || undefined);
}
