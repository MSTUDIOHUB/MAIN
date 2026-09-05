import type { AgentMessage } from "../../lib/agentMessages";
import { estimateMessagesTokens, estimateTokens } from "../../lib/contextTrim";
import type { TurnAggregateV1 } from "../../lib/runtime-v2/aggregate";
import { appendRuntimeV2AssistantToolCallHistory, appendRuntimeV2ToolResultHistory, upsertRuntimeV2ContextAnchor } from "./executionProviderHistory";
import type { RuntimeV2LiveExecutionState } from "./executionTypes";

/** A replay adapter, not another history owner. No new evidence is minted. */
export function restoreReadOnlyHistory(live: RuntimeV2LiveExecutionState, aggregate: TurnAggregateV1): void {
  const commands = new Map(aggregate.events.flatMap((event) => event.type === "command.scheduled" ? [[event.command.idempotencyKey, event.command] as const] : []));
  for (const event of aggregate.events) {
    if (event.type === "provider.responded") {
      if (event.result.toolCalls.length) appendRuntimeV2AssistantToolCallHistory(live, event.result);
      else if (event.result.visibleText && !event.result.diagnostics.length) live.messages.push({ role: "assistant", content: event.result.visibleText });
      live.latestProviderResult = event.result;
    } else if (event.type === "tool.completed") {
      const callId = String(commands.get(event.idempotencyKey)?.payload.toolCallId || "");
      appendRuntimeV2ToolResultHistory(live, callId, event.modelContent ?? JSON.stringify({ status: event.status, evidence: event.evidence, historicalContentUnavailable: true, instruction: "This old checkpoint did not retain the receipt body. Re-read if its content is needed; metadata alone does not support an answer." }));
    } else if (event.type === "observation.recorded" && event.modelContent) {
      upsertRuntimeV2ContextAnchor(live, { key: "workspace-overview", content: event.modelContent });
    }
  }
  live.evidenceCounter = aggregate.evidence.reduce((max, item) => Math.max(max, /^E\d+$/.test(item.id) ? Number(item.id.slice(1)) : 0), 0);
}

/** Budget-only projection. Complete call/result groups remain atomic. */
export function boundReadOnlyHistory(messages: readonly AgentMessage[], input: {
  contextLimit: number; reservedOutputTokens: number; tools?: readonly unknown[];
  preserveUserMessages?: boolean;
}): AgentMessage[] {
  const budget = Math.max(0, input.contextLimit - input.reservedOutputTokens - estimateTokens(JSON.stringify(input.tools || [])));
  let result = messages.map((message) => ({ ...message }));
  const fits = () => estimateMessagesTokens(result) <= budget;
  if (fits()) return result;
  const groups: AgentMessage[][] = [];
  for (let i = 0; i < result.length; i += 1) {
    const item = result[i]!;
    const group = [item];
    if (item.role === "assistant" && item.tool_calls?.length) {
      const ids = new Set(item.tool_calls.map((call) => call.id));
      while (result[i + 1]?.role === "tool" && ids.has(result[i + 1]!.tool_call_id!)) group.push(result[++i]!);
    }
    groups.push(group);
  }
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group[0]?.tool_calls?.length || group.length !== group[0].tool_calls.length + 1) continue;
    const key = JSON.stringify(group.slice(1).map((item) => item.content));
    if (seen.has(key)) {
      result = result.filter((item) => !group.includes(item));
      if (fits()) return result;
    }
    seen.add(key);
  }
  if (input.preserveUserMessages) {
    const toolGroups = groups.filter((group) => group[0]?.tool_calls?.length && group.length === group[0].tool_calls.length + 1);
    for (const group of toolGroups.slice(0, -1)) {
      if (fits()) break;
      result = result.filter((item) => !group.includes(item));
    }
  }
  while (!input.preserveUserMessages && !fits()) {
    const first = result.findIndex((item) => item.role === "user");
    const next = result.findIndex((item, index) => index > first && item.role === "user");
    if (first < 0 || next < 0) break;
    result.splice(first, next - first);
  }
  // A single source may itself exceed the model window. Keep its pair and an
  // explicit omission marker, never pretend the removed body is still visible.
  while (!fits()) {
    const largest = result.filter((item) => item.role === "tool" && typeof item.content === "string" && item.content.length > 512)
      .sort((a, b) => String(b.content).length - String(a.content).length)[0];
    if (!largest) throw new Error("READ_ONLY_CONTEXT_BUDGET_EXCEEDED");
    largest.content = String(largest.content).slice(0, Math.max(256, Math.floor(String(largest.content).length / 2))) + "\n[Receipt body omitted to fit context; do not infer omitted facts.]";
  }
  return result;
}
