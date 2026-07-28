import type { RuntimeV2NormalizedToolCall } from "../../lib/runtime-v2";
import type { ToolDefinition } from "../../lib/toolSchemas";

export function selectRuntimeV2ExecuteToolDefinitions(input: {
  readonly available: readonly ToolDefinition[];
  readonly sourceToolNames: ReadonlySet<string>;
  readonly isMutationToolName: (name: string) => boolean;
  readonly createOnlyMutationToolNames?: ReadonlySet<string>;
  readonly requiresFreshSourceReads: boolean;
  readonly requiresMutation: boolean;
}): ToolDefinition[] {
  return input.available.filter((definition) => {
    const name = definition.function.name;
    if (input.requiresMutation && !input.requiresFreshSourceReads) {
      return input.isMutationToolName(name) &&
        !input.createOnlyMutationToolNames?.has(name);
    }
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

/** Runtime v2 schedules one provider-selected effect, commits its evidence,
 * then decides again. Normalizing a multi-call model response at this
 * boundary prevents stale batches from bypassing phase and recovery policy. */
export function boundRuntimeV2ProviderToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
): {
  readonly accepted: RuntimeV2NormalizedToolCall[];
  readonly discarded: RuntimeV2NormalizedToolCall[];
} {
  return {
    accepted: calls.slice(0, 1),
    discarded: calls.slice(1),
  };
}
