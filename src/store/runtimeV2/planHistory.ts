import type { AgentMessage } from "../../lib/agentMessages";
import type { RuntimeV2RunIdentity, TurnAggregateV1, WorkPlanRuntimeEvidence } from "../../lib/runtime-v2";

/** Rebuild the Plan transcript and its evidence index from the sole ledger.
 * Missing legacy bodies are explicit gaps, never invented source context. */
export function restorePlanHistory(input: {
  readonly aggregate: TurnAggregateV1;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
}): void {
  const events = input.aggregate.events.filter((event) => "run" in event && event.run.runId === input.run.runId);
  const commands = events.flatMap((event) => event.type === "command.scheduled" ? [event] : []);
  const receipts = new Map(events.flatMap((event) => event.type === "tool.completed" || event.type === "command.completed" ? [[event.idempotencyKey, event] as const] : []));
  const responses = events.filter((event) => event.type === "provider.responded");
  const nextResponseSequence = new Map(responses.map((event, index) => [event.sequence, responses[index + 1]?.sequence ?? Infinity]));
  for (const event of events) {
    if (event.type === "provider.responded") {
      const calls = event.result.toolCalls;
      input.messages.push({ role: "assistant", content: event.result.visibleText || "",
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
      });
      for (const call of calls) {
        const scheduled = commands.find((entry) => entry.sequence > event.sequence && entry.sequence < nextResponseSequence.get(event.sequence)! && entry.command.payload.toolCallId === call.id);
        const receipt = scheduled ? receipts.get(scheduled.command.idempotencyKey) : undefined;
        const content = receipt?.type === "tool.completed" ? receipt.modelContent ?? receipt.presentation?.message : undefined;
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
      if (content) {
        const previous = input.evidenceContents.get(item.id) || "";
        if (!previous.includes(content)) input.evidenceContents.set(item.id, [previous, content].filter(Boolean).join("\n\n"));
      }
    }
  }
}
