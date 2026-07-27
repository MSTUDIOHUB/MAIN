import type { RuntimeV2NormalizedToolCall } from "../../lib/runtime-v2";
import type { ToolDefinition } from "../../lib/toolSchemas";

export function unexpectedRuntimeV2ProviderToolNames(
  tools: readonly ToolDefinition[],
  calls: readonly RuntimeV2NormalizedToolCall[],
): string[] {
  const allowed = new Set(tools.map((tool) => tool.function.name));
  return [...new Set(
    calls
      .map((call) => call.name)
      .filter((name) => !allowed.has(name)),
  )];
}
