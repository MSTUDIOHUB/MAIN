import type { RuntimeV2NormalizedToolCall } from "../../lib/runtime-v2";
import type { ToolDefinition } from "../../lib/toolSchemas";

export function selectRuntimeV2ExecuteToolDefinitions(input: {
  readonly available: readonly ToolDefinition[];
  readonly sourceToolNames: ReadonlySet<string>;
  readonly isMutationToolName: (name: string) => boolean;
  readonly requiresFreshSourceReads: boolean;
}): ToolDefinition[] {
  return input.available.filter((definition) => {
    const name = definition.function.name;
    if (input.sourceToolNames.has(name)) return true;
    return !input.requiresFreshSourceReads &&
      input.isMutationToolName(name);
  });
}

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
