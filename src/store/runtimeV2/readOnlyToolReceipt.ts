import { boundKnowledgeToolResult } from "../../lib/knowledgeReferences";
import type { ToolPort } from "../../lib/runtime-v2/ports";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { isChatContext, isReadOnlyContext } from "./readOnlyPolicy";
import { boundedRuntimeV2ToolContent, runtimeV2SourceToolContent } from "./executionText";
import { toolResultContentForModel } from "./executionEvidence";

export function runtimeV2ToolModelContent(input: RuntimeV2ExecutionPortsInput, toolName: string, output: unknown, options: { readonly parallelReadCount?: number } = {}): string {
  if (["knowledge_search", "knowledge_get_excerpt"].includes(toolName)) {
    const count = Math.max(1, Math.floor(Number(options.parallelReadCount) || 1));
    return boundKnowledgeToolResult(output, input.context.knowledgeContext?.references || [],
      Math.floor((input.context.runtimeContextBudget?.readWindowChars ?? 12_000) / count));
  }
  // Rust already bounds these structured receipts. Cutting the JSON string a
  // second time loses finalUrl/truncated metadata and breaks novelty on replay.
  if (isReadOnlyContext(input) && ["web_search", "web_fetch"].includes(toolName)) {
    return runtimeV2SourceToolContent(output);
  }
  return boundedRuntimeV2ToolContent(toolName, toolName === "read_file"
    ? runtimeV2SourceToolContent(output) : toolResultContentForModel(output), input.context.runtimeContextBudget, options);
}

/** Persist the exact bounded receipt seen by the model, including failures. */
export function withRuntimeV2ModelReceipt(input: RuntimeV2ExecutionPortsInput, port: ToolPort): ToolPort {
  return { async execute(request) {
    const name = String(request.command.payload.toolName);
    const knowledgeAllowed = ["knowledge_search", "knowledge_get_excerpt"].includes(name) &&
      !!input.context.knowledgeContext?.references.length && !["stale", "error"].includes(input.context.knowledgeContext.state);
    if (isChatContext(input) && (request.command.kind !== "execute_tool" ||
      (!["load_skill", "web_search", "web_fetch"].includes(name) && !knowledgeAllowed))) {
      throw new Error("RUNTIME_V2_CHAT_EFFECT_SURFACE_DENIED");
    }
    const event = await port.execute(request);
    if (event.type !== "tool.completed") return event;
    const callId = String(request.command.payload.toolCallId || "");
    const message = [...input.live.messages].reverse().find((item) => item.role === "tool" && item.tool_call_id === callId);
    return { ...event, modelContent: typeof message?.content === "string" ? message.content : JSON.stringify({ status: event.status, presentation: event.presentation }) };
  } };
}
