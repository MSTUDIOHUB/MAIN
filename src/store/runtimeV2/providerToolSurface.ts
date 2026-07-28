import type { RuntimeV2NormalizedToolCall } from "../../lib/runtime-v2";
import type { ToolDefinition } from "../../lib/toolSchemas";

function structuralIdentity(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(structuralIdentity).join(",")}]`;
  }
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${structuralIdentity(entry)}`
    )
    .join(",")}}`;
}

/** Provider call ids are transport ephemera. The name and normalized
 * arguments identify the semantic action across model retries. */
export function runtimeV2ProviderToolCallIdentity(
  call: Pick<RuntimeV2NormalizedToolCall, "name" | "arguments">,
): string {
  return `${call.name}:${structuralIdentity(call.arguments)}`.slice(0, 4_096);
}

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
    // Safe workspace reads remain available throughout Acting. Removing them
    // after an arbitrary read count turns an ordinary model request into a
    // protocol error and was the direct cause of the second incident replay
    // stopping without a terminal explanation.
    if (input.sourceToolNames.has(name)) return true;
    return !input.requiresFreshSourceReads &&
      input.isMutationToolName(name) &&
      !input.createOnlyMutationToolNames?.has(name);
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
 * then decides again. When a weak model repeats an already-attempted first
 * call and also proposes a novel later call, select that first novel action.
 * This preserves the one-effect fence without trapping the parent on the
 * stale head of every regenerated batch. */
export function boundRuntimeV2ProviderToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
  attemptedIdentities: ReadonlySet<string> = new Set(),
): {
  readonly accepted: RuntimeV2NormalizedToolCall[];
  readonly discarded: RuntimeV2NormalizedToolCall[];
  readonly selection:
    | "empty"
    | "first"
    | "first_novel_after_attempt";
} {
  if (calls.length === 0) {
    return {
      accepted: [],
      discarded: [],
      selection: "empty",
    };
  }
  const firstNovelIndex = calls.findIndex((call) =>
    !attemptedIdentities.has(runtimeV2ProviderToolCallIdentity(call))
  );
  const selectedIndex = firstNovelIndex > 0 ? firstNovelIndex : 0;
  return {
    accepted: [calls[selectedIndex]!],
    discarded: calls.filter((_, index) => index !== selectedIndex),
    selection:
      selectedIndex > 0
        ? "first_novel_after_attempt"
        : "first",
  };
}
