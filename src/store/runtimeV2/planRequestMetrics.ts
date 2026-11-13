import type { AgentMessage } from "../../lib/agentMessages";
import { estimateMessagesTokens, estimateTokens } from "../../lib/contextTrim";

/** Measures the exact outbound message view without logging its contents.
 * Native submission arguments are often much larger than visible prose. */
export function planRequestMetrics(input: {
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly unknown[];
  readonly responseFormat?: unknown;
}) {
  const toolSchema = input.tools.length ? JSON.stringify(input.tools) : "";
  const responseSchema = input.responseFormat ? JSON.stringify(input.responseFormat) : "";
  return {
    // Kept for old diagnostics consumers; never interpret this as total size.
    promptChars: input.messages.reduce((sum, message) => sum + String(message.content || "").length, 0),
    promptCharsScope: "message_content_only" as const,
    promptToolCallChars: input.messages.reduce((sum, message) => sum + (message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0), 0),
    promptToolArgumentChars: input.messages.reduce((sum, message) => sum + (message.tool_calls || []).reduce((total, call) => total + call.function.arguments.length, 0), 0),
    promptSerializedMessageChars: JSON.stringify(input.messages).length,
    toolSchemaChars: toolSchema.length,
    responseSchemaChars: responseSchema.length,
    estimatedInputTokens: estimateMessagesTokens([...input.messages]) + estimateTokens(toolSchema) + estimateTokens(responseSchema),
  };
}
