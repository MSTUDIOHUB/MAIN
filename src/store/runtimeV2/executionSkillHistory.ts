import type { AgentMessage } from "../../lib/agentMessages";
import type { RuntimeV2RunIdentity, TurnAggregateV1 } from "../../lib/runtime-v2";
import type { RuntimeV2LiveExecutionState } from "./executionTypes";
import { runtimeV2TranscriptSkillDocumentReads } from "./executionProviderSkillTranscript";
import { runtimeV2ProviderToolCallIdentity } from "./providerReadReceipts";

function sameSkillArguments(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return false;
  const identity = (arguments_: object) => runtimeV2ProviderToolCallIdentity({ name: "load_skill", arguments: arguments_ as Record<string, unknown> });
  return identity(left) === identity(right);
}

function sameRun(left: RuntimeV2RunIdentity, right: RuntimeV2RunIdentity): boolean {
  return left.sessionKey === right.sessionKey && left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId && left.runId === right.runId &&
    left.parentRunId === right.parentRunId && left.attemptId === right.attemptId;
}

/** Restore committed guidance and exact still-scheduled Skill parents.
 * No tool is run, no UI prefix is expanded, and no source/approval is restored. */
export function restoreRuntimeV2SkillHistory(
  live: RuntimeV2LiveExecutionState,
  aggregate: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
): void {
  if (aggregate.terminalOutcome || !aggregate.run || aggregate.run.status === "completed" ||
    !sameRun(aggregate.run.identity, run) || aggregate.turn.turnId !== run.turnId ||
    aggregate.turn.sessionKey !== run.sessionKey || aggregate.turn.sessionEpoch !== run.sessionEpoch ||
    aggregate.events.some((event) => event.type === "run.aborted" && sameRun(event.run, run))) return;
  const commands = new Map(aggregate.events.flatMap((event, index) =>
    event.type === "command.scheduled" && sameRun(event.run, run) && sameRun(event.command.run, run) &&
      event.command.kind === "execute_tool" && event.command.payload.toolName === "load_skill"
      ? [[event.command.idempotencyKey, { command: event.command, index }] as const] : []));
  const receipts = new Map(aggregate.events.flatMap((event, index) => {
    if (event.type !== "tool.completed" || !sameRun(event.run, run) ||
      event.status !== "succeeded" || typeof event.modelContent !== "string") return [];
    const scheduled = commands.get(event.idempotencyKey);
    const callId = scheduled?.command.payload.toolCallId;
    return scheduled && scheduled.index < index && typeof callId === "string"
      ? [[callId, { content: event.modelContent, scheduled }] as const] : [];
  }));
  const pending = new Map(aggregate.scheduledCommands.flatMap((command) => {
    const scheduled = commands.get(command.idempotencyKey);
    return command.kind === "execute_tool" && command.payload.toolName === "load_skill" && sameRun(command.run, run) &&
      scheduled && typeof command.payload.toolCallId === "string" &&
      scheduled.command.payload.toolCallId === command.payload.toolCallId &&
      sameSkillArguments(scheduled.command.payload.arguments, command.payload.arguments)
      ? [[command.payload.toolCallId, scheduled] as const] : [];
  }));
  const existingIds = new Set(live.messages.flatMap((message) => [
    ...(message.tool_calls?.map((call) => call.id) || []),
    ...(message.tool_call_id ? [message.tool_call_id] : []),
  ]));
  for (const [index, event] of aggregate.events.entries()) {
    if (event.type !== "provider.responded" || !sameRun(event.run, run)) continue;
    const calls = event.result.toolCalls.filter((call) => {
      if (call.name !== "load_skill" || existingIds.has(call.id)) return false;
      const scheduled = receipts.get(call.id)?.scheduled || pending.get(call.id);
      return Boolean(scheduled && scheduled.index > index &&
        sameSkillArguments(scheduled.command.payload.arguments, call.arguments));
    });
    if (!calls.length) continue;
    const assistant: AgentMessage = {
      role: "assistant", content: event.result.visibleText || "",
      tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
    };
    const results: AgentMessage[] = calls.flatMap((call) => {
      const receipt = receipts.get(call.id);
      return receipt ? [{ role: "tool", tool_call_id: call.id, content: receipt.content }] : [];
    });
    const validIds = new Set(runtimeV2TranscriptSkillDocumentReads([assistant, ...results]).map((window) => window.callId));
    for (const call of calls) if (pending.has(call.id) && !receipts.has(call.id)) validIds.add(call.id);
    if (!validIds.size) continue;
    live.messages.push({ ...assistant, tool_calls: assistant.tool_calls!.filter((call) => validIds.has(call.id)) },
      ...results.filter((result) => validIds.has(result.tool_call_id!)));
    for (const id of validIds) existingIds.add(id);
  }
}
