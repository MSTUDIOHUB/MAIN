import type { AgentMessage } from "../../lib/agentMessages";
import { estimateMessagesTokens, estimateTokens } from "../../lib/contextTrim";
import type { TurnAggregateV1 } from "../../lib/runtime-v2/aggregate";
import { appendRuntimeV2AssistantToolCallHistory, appendRuntimeV2ProviderFeedbackHistory, appendRuntimeV2ToolResultHistory, upsertRuntimeV2ContextAnchor } from "./executionProviderHistory";
import type { RuntimeV2LiveExecutionState } from "./executionTypes";

/** A replay adapter, not another history owner. No new evidence is minted. */
export function restoreReadOnlyHistory(live: RuntimeV2LiveExecutionState, aggregate: TurnAggregateV1): void {
  const commands = new Map(aggregate.events.flatMap((event) => event.type === "command.scheduled" ? [[event.command.idempotencyKey, event.command] as const] : []));
  for (const event of aggregate.events) {
    if (event.type === "provider.responded") {
      if (event.result.toolCalls.length) appendRuntimeV2AssistantToolCallHistory(live, event.result);
      else if (event.result.diagnostics.length) appendRuntimeV2ProviderFeedbackHistory(live, { visibleText: event.result.visibleText, code: event.result.diagnostics.map((item) => item.code).join(","), feedback: event.result.diagnostics.map((item) => item.message).join("\n") });
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

/** Lossless references inside one outbound transcript. Recompute after every
 * eviction so no replay can refer to a body that is no longer on the wire. */
function referenceDuplicateWebReceipts(messages: readonly AgentMessage[]): AgentMessage[] {
  const calls = new Map(messages.flatMap((item) => item.tool_calls?.map((call) => [call.id, call.function.name] as const) || []));
  const seen = new Map<string, string>();
  return messages.map((item) => {
    const name = calls.get(item.tool_call_id || "");
    if (item.role !== "tool" || !["web_search", "web_fetch"].includes(name || "") || typeof item.content !== "string" || !item.tool_call_id) return item;
    const key = JSON.stringify([name, item.content]);
    const original = seen.get(key);
    if (!original) { seen.set(key, item.tool_call_id); return item; }
    const reference = JSON.stringify({ receiptReplayOf: original, newEvidence: false, instruction: "Identical receipt body already present above at this tool_call_id. Use that body; this replay adds no facts." });
    return reference.length < item.content.length ? { ...item, content: reference } : item;
  });
}

/** Budgeted projection. Complete call/result groups remain atomic. */
export function boundReadOnlyHistory(messages: readonly AgentMessage[], input: {
  contextLimit: number; reservedOutputTokens: number; tools?: readonly unknown[];
  preserveUserMessages?: boolean;
}): AgentMessage[] {
  const budget = Math.max(0, input.contextLimit - input.reservedOutputTokens - estimateTokens(JSON.stringify(input.tools || [])));
  let result = messages.map((message) => ({ ...message }));
  const projection = () => referenceDuplicateWebReceipts(result);
  const fits = () => estimateMessagesTokens(projection()) <= budget;
  if (fits()) return projection();
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
    const key = JSON.stringify([group[0].tool_calls.map((call) => call.function), group.slice(1).map((item) => item.content)]);
    if (seen.has(key)) {
      result = result.filter((item) => !group.includes(item));
      if (fits()) return projection();
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
  return projection();
}
