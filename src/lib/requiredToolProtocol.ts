import type { OpenAiToolChoice, StreamResult } from "./streaming";

/**
 * OpenAI-compatible providers do not all enforce tool_choice=required. Preserve
 * that provider response for diagnostics, but mark it as a protocol violation
 * so the execution loop can recover instead of accepting a text stop as task
 * completion.
 */
export function annotateRequiredToolCallProtocolResult(
  result: StreamResult,
  toolChoice: OpenAiToolChoice | undefined,
): StreamResult {
  const toolRequired = toolChoice === "required" ||
    (typeof toolChoice === "object" && toolChoice?.type === "function");
  if (!toolRequired || (result.toolCalls?.length || 0) > 0) return result;
  return { ...result, protocolViolation: "required_tool_call_missing" };
}
