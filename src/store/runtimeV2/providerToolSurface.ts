import type { RuntimeV2NormalizedToolCall } from "../../lib/runtime-v2";
import type { ToolDefinition } from "../../lib/toolSchemas";
import { isRuntimeV2ReadOnlyToolName } from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  runtimeV2ProviderToolCallIdentity,
} from "./providerReadReceipts";

export {
  completedRuntimeV2ProviderToolCallIdentities,
  runtimeV2ProviderCachedReadCanReplay,
  runtimeV2ProviderCoveredSourceReplayIsClosed,
  runtimeV2ProviderCoveredReadReceipt,
  runtimeV2ProviderExactReadReceipt,
  runtimeV2ProviderReadIsMaterialized,
  runtimeV2ProviderReadIsFullyCovered,
  runtimeV2ProviderReusableReadReceipt,
  runtimeV2ProviderToolCallIdentity,
} from "./providerReadReceipts";

/** Provider ids are request-local transport correlation values. Re-scope them
 * at the Runtime boundary so a provider that emits `stream_call_1` for every
 * request cannot attach a new result to an older transcript exchange. */
export function scopeRuntimeV2ProviderToolCallIds(
  calls: readonly RuntimeV2NormalizedToolCall[],
  allocateId: () => string,
): RuntimeV2NormalizedToolCall[] {
  return calls.map((call) => {
    const id = String(allocateId() || "").trim();
    if (!id) {
      throw new Error("Runtime v2 tool-call id allocation returned empty.");
    }
    return { ...call, id };
  });
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

/** Runtime v2 preserves a bounded provider-selected batch when every call is
 * side-effect-free. Effects remain fenced one at a time, so a mutation,
 * command, validation, or collaboration action can never share a committed
 * batch with reads. */
export function boundRuntimeV2ProviderToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
  attemptedIdentities: ReadonlySet<string> = new Set(),
  rejectedIdentities: ReadonlySet<string> = new Set(),
  options: {
    readonly maxSpawnSubagents?: number;
  } = {},
): {
  readonly accepted: RuntimeV2NormalizedToolCall[];
  readonly discarded: RuntimeV2NormalizedToolCall[];
  readonly selection:
    | "empty"
    | "first"
    | "safe_batch"
    | "collaboration_batch"
    | "first_novel_after_attempt"
    | "first_novel_after_rejection"
    | "all_attempted"
    | "all_rejected";
} {
  if (calls.length === 0) {
    return {
      accepted: [],
      discarded: [],
      selection: "empty",
    };
  }
  const eligibleIndices = calls.flatMap((call, index) =>
    rejectedIdentities.has(runtimeV2ProviderToolCallIdentity(call))
      ? []
      : [index]
  );
  if (eligibleIndices.length === 0) {
    return {
      accepted: [],
      discarded: [...calls],
      selection: "all_rejected",
    };
  }
  if (calls.every((call) => isRuntimeV2ReadOnlyToolName(call.name))) {
    const novelEligibleIndices = eligibleIndices.filter((index) =>
      !attemptedIdentities.has(
        runtimeV2ProviderToolCallIdentity(calls[index]!),
      )
    );
    if (novelEligibleIndices.length === 0) {
      return {
        accepted: [],
        discarded: [...calls],
        selection: "all_attempted",
      };
    }
    // A provider-selected safe read batch is one causal observation. If at
    // least one member advances the frontier, retain its already-completed
    // read companions as cache replays so the next decision sees the exact
    // cross-file set the provider requested. An entirely repeated batch still
    // returns all_attempted and cannot loop.
    const acceptedIndices = eligibleIndices;
    const acceptedSet = new Set(acceptedIndices);
    const firstAcceptedIndex = acceptedIndices[0]!;
    const skippedRejected = calls
      .slice(0, firstAcceptedIndex)
      .some((call) =>
        rejectedIdentities.has(runtimeV2ProviderToolCallIdentity(call))
      );
    return {
      accepted: calls.filter((_, index) => acceptedSet.has(index)),
      discarded: calls.filter((_, index) => !acceptedSet.has(index)),
      selection: acceptedIndices.length > 1
        ? "safe_batch"
        : firstAcceptedIndex > 0
          ? skippedRejected
            ? "first_novel_after_rejection"
            : "first_novel_after_attempt"
          : "first",
    };
  }
  if (calls.every((call) => call.name === "spawn_subagent")) {
    const maxSpawnSubagents = Math.max(
      0,
      Math.floor(
        options.maxSpawnSubagents === undefined
          ? 1
          : Number(options.maxSpawnSubagents) || 0,
      ),
    );
    const novelEligibleIndices = eligibleIndices.filter((index) =>
      !attemptedIdentities.has(
        runtimeV2ProviderToolCallIdentity(calls[index]!),
      )
    );
    if (novelEligibleIndices.length === 0) {
      return {
        accepted: [],
        discarded: [...calls],
        selection: "all_attempted",
      };
    }
    const acceptedIndices = novelEligibleIndices.slice(
      0,
      maxSpawnSubagents,
    );
    if (acceptedIndices.length === 0) {
      return {
        accepted: [],
        discarded: [...calls],
        selection: "all_rejected",
      };
    }
    const acceptedSet = new Set(acceptedIndices);
    return {
      accepted: calls.filter((_, index) => acceptedSet.has(index)),
      discarded: calls.filter((_, index) => !acceptedSet.has(index)),
      selection: acceptedIndices.length > 1
        ? "collaboration_batch"
        : acceptedIndices[0]! > 0
          ? "first_novel_after_attempt"
          : "first",
    };
  }
  const firstNovelIndex = eligibleIndices.find((index) =>
    !attemptedIdentities.has(
      runtimeV2ProviderToolCallIdentity(calls[index]!),
    )
  );
  const selectedIndex = firstNovelIndex ?? eligibleIndices[0]!;
  const skippedRejected = calls
    .slice(0, selectedIndex)
    .some((call) =>
      rejectedIdentities.has(runtimeV2ProviderToolCallIdentity(call))
    );
  return {
    accepted: [calls[selectedIndex]!],
    discarded: calls.filter((_, index) => index !== selectedIndex),
    selection:
      selectedIndex > 0
        ? skippedRejected
          ? "first_novel_after_rejection"
          : "first_novel_after_attempt"
        : "first",
  };
}
