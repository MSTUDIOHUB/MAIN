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
  allowedToolNames?: Iterable<string>,
): StreamResult {
  const toolRequired = toolChoice === "required" ||
    (typeof toolChoice === "object" && toolChoice?.type === "function");
  if (!toolRequired) return result;
  const calls = result.toolCalls || [];
  if (calls.length === 0) {
    return { ...result, protocolViolation: "required_tool_call_missing" };
  }
  const allowed = allowedToolNames
    ? new Set([...allowedToolNames].map((name) => String(name || "").trim()).filter(Boolean))
    : null;
  const surfaceCalls = allowed && allowed.size > 0
    ? calls.filter((call) => allowed.has(call.name))
    : calls;
  if (surfaceCalls.length === 0) {
    return {
      ...result,
      toolCalls: [],
      protocolViolation: "required_tool_call_not_available",
      protocolAllowedTools: allowed ? [...allowed] : [],
      protocolActualTools: calls.map((call) => call.name),
      protocolActualToolCalls: calls.map((call) => ({ ...call })),
    };
  }
  if (typeof toolChoice !== "object" || toolChoice.type !== "function") {
    return surfaceCalls.length === calls.length
      ? result
      : { ...result, toolCalls: surfaceCalls };
  }

  const expectedTool = String(toolChoice.function?.name || "").trim();
  if (!expectedTool) return result;
  const matchingCalls = surfaceCalls.filter((call) => call.name === expectedTool);
  if (matchingCalls.length > 0) {
    // Quarantine any extra provider call instead of letting a named function
    // choice execute unrelated work in the same transaction.
    return matchingCalls.length === calls.length
      ? result
      : { ...result, toolCalls: matchingCalls };
  }
  return {
    ...result,
    toolCalls: [],
    protocolViolation: "required_function_call_mismatch",
    protocolExpectedTool: expectedTool,
    protocolActualTools: calls.map((call) => call.name),
    protocolActualToolCalls: calls.map((call) => ({ ...call })),
  };
}
