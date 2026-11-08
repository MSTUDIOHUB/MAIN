import type { AgentMessage } from "../../lib/agentMessages";
import { runtimeV2ClarificationMessage } from "./clarificationHistory";
import type { RuntimeV2RunIdentity, TurnAggregateV1, WorkPlanRuntimeEvidence } from "../../lib/runtime-v2";
import { planSkillReceipt } from "./planSkillGuidance";

/** Keep a tool reply with its latest invocation, even when recovery has
 * appended context or diagnostics after the unfinished exchange. */
export function appendPlanToolResult(messages: AgentMessage[], callId: string, content: string): void {
  const result: AgentMessage = { role: "tool", tool_call_id: callId, content };
  for (let i = messages.length - 1; i >= 0; i--) {
    const parent = messages[i]!;
    if (parent.role !== "assistant" || !parent.tool_calls?.some(call => call.id === callId)) continue;
    const groupIds = new Set(parent.tool_calls.map(call => call.id));
    let end = i + 1;
    while (messages[end]?.role === "tool" && groupIds.has(messages[end]!.tool_call_id!)) {
      if (messages[end]!.tool_call_id === callId) {
        messages[end] = result;
        return;
      }
      end++;
    }
    messages.splice(end, 0, result);
    return;
  }
  messages.push(result);
}

/** Rebuild the Plan transcript and its evidence index from the sole ledger.
 * Missing legacy bodies are explicit gaps, never invented source context. */
export function restorePlanHistory(input: {
  readonly aggregate: TurnAggregateV1;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
  readonly omitUnsettledCalls?: boolean;
}): void {
  const events = input.aggregate.events.filter((event) => "run" in event && event.run.runId === input.run.runId);
  const commands = events.flatMap((event) => event.type === "command.scheduled" ? [event] : []);
  const skillCommands = new Map(commands.flatMap(({ command }) => {
    const { toolCallId, toolName, arguments: args } = command.payload;
    return toolName === "load_skill" && typeof toolCallId === "string" && args && typeof args === "object" && !Array.isArray(args)
      ? [[command.idempotencyKey, { id: toolCallId, name: toolName, arguments: args as Record<string, unknown> }] as const] : [];
  }));
  const receipts = new Map(events.flatMap((event) => event.type === "tool.completed" || event.type === "command.completed" ? [[event.idempotencyKey, event] as const] : []));
  const responses = events.filter((event) => event.type === "provider.responded");
  const nextResponseSequence = new Map(responses.map((event, index) => [event.sequence, responses[index + 1]?.sequence ?? Infinity]));
  for (const event of events) {
    const reply = runtimeV2ClarificationMessage(event);
    if (reply) input.messages.push(reply);
    if (event.type === "provider.responded") {
      const calls = event.result.toolCalls;
      input.messages.push({ role: "assistant", content: event.result.visibleText || "",
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
      });
      for (const call of calls) {
        const scheduled = commands.find((entry) => entry.sequence > event.sequence && entry.sequence < nextResponseSequence.get(event.sequence)! && entry.command.payload.toolCallId === call.id);
        const receipt = scheduled ? receipts.get(scheduled.command.idempotencyKey) : undefined;
        const content = receipt?.type === "tool.completed" ? receipt.modelContent ?? receipt.presentation?.message : undefined;
        if (!receipt && input.omitUnsettledCalls && event === responses[responses.length - 1] && input.aggregate.pendingToolCalls.some(pending => pending.id === call.id)) continue;
        input.messages.push({ role: "tool", tool_call_id: call.id, content: content ?? JSON.stringify({
          status: receipt?.status || "interrupted", historicalContentUnavailable: true,
          instruction: "The old checkpoint did not retain this receipt body. Read the source again if needed; do not infer missing facts.",
        }) });
      }
      if (event.result.diagnostics.length) input.messages.push({ role: "system", content: JSON.stringify({ planProviderFeedback: event.result.diagnostics }) });
    }
    const source = event.type === "observation.recorded" ? [event.evidence]
      : event.type === "tool.completed" && event.status === "succeeded" ? event.evidence : [];
    for (const item of source.filter((item) => /^E\d+$/.test(item.id))) {
      const content = "modelContent" in event ? event.modelContent : undefined;
      const prior = input.evidence.find((entry) => entry.id === item.id);
      if (!prior) input.evidence.push({ id: item.id, target: item.target, version: content ? item.version || null : null,
        statement: content ? `Retained ${item.target} observation.` : `Historical ${item.target} content is unavailable; read again before relying on it.`,
      });
      const skillCall = event.type === "tool.completed" ? skillCommands.get(event.idempotencyKey) : undefined;
      // The restored call/result transcript already retains verified Skill
      // windows for outbound range projection. Do not duplicate them here.
      if (content && !(skillCall && planSkillReceipt(skillCall, content))) {
        const previous = input.evidenceContents.get(item.id) || "";
        if (!previous.includes(content)) input.evidenceContents.set(item.id, [previous, content].filter(Boolean).join("\n\n"));
      }
    }
  }
}
