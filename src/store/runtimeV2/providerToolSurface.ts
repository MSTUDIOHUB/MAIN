import type { AgentMessage } from "../../lib/agentMessages";
import {
  extractReadFileWindowMetadata,
  planReadFileWindowCoverage,
  replayReadFileWindowFromResult,
} from "../../lib/readFileWindow";
import type { RuntimeV2NormalizedToolCall } from "../../lib/runtime-v2";
import { sha256Hex } from "../../lib/sha256";
import type { ToolDefinition } from "../../lib/toolSchemas";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";

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
  return `runtime-v2-provider-action-sha256-${sha256Hex(
    `${call.name}:${structuralIdentity(call.arguments)}`,
  )}`;
}

export function runtimeV2ProviderToolCallConstraint(
  call: Pick<RuntimeV2NormalizedToolCall, "name" | "arguments">,
): string {
  const argumentsText = structuralIdentity(call.arguments);
  const boundedArguments = argumentsText.length > 800
    ? `${argumentsText.slice(0, 800)}…`
    : argumentsText;
  return `${call.name}(${boundedArguments}) [${
    runtimeV2ProviderToolCallIdentity(call)
  }]`;
}

function parsedToolCallArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Only a standard assistant/tool pair proves that an action was actually
 * attempted. Provider siblings discarded by the one-effect scheduler have no
 * tool result and must remain eligible when the model proposes them again. */
export function completedRuntimeV2ProviderToolCallIdentities(
  messages: readonly AgentMessage[],
): ReadonlySet<string> {
  const completedCallIds = new Set(
    messages.flatMap((message) =>
      message.role === "tool" && message.tool_call_id
        ? [message.tool_call_id]
        : []
    ),
  );
  const identities = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (!completedCallIds.has(call.id)) continue;
      identities.add(runtimeV2ProviderToolCallIdentity({
        name: call.function.name,
        arguments: parsedToolCallArguments(call.function.arguments),
      }));
    }
  }
  return identities;
}

function normalizedReadPath(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/** Reconstruct versioned read coverage from completed standard transcript
 * pairs. A mutation result clears coverage because reads must reopen at the
 * new source boundary. Raw small-file reads have no range envelope and are
 * intentionally left to the exact-action guard. */
export function runtimeV2ProviderReadIsFullyCovered(
  candidate: RuntimeV2NormalizedToolCall,
  messages: readonly AgentMessage[],
): boolean {
  if (candidate.name !== "read_file") return false;
  const candidatePath = normalizedReadPath(candidate.arguments.path);
  if (!candidatePath) return false;
  const callsById = new Map<string, {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>();
  const coverage = new Map<string, {
    version: string;
    totalLines: number;
    ranges: Array<{ startLine: number; endLine: number }>;
  }>();
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        callsById.set(call.id, {
          name: call.function.name,
          arguments: parsedToolCallArguments(
            call.function.arguments,
          ),
        });
      }
      continue;
    }
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const call = callsById.get(message.tool_call_id);
    if (!call) continue;
    if (isWorkspaceMutationToolName(call.name)) {
      coverage.clear();
      continue;
    }
    if (call.name !== "read_file") continue;
    const content = typeof message.content === "string"
      ? message.content
      : "";
    const metadata = extractReadFileWindowMetadata(content);
    const path = normalizedReadPath(
      metadata?.path || call.arguments.path,
    );
    const version = String(metadata?.contentVersion || "").trim();
    if (
      !metadata ||
      !path ||
      !version ||
      metadata.returnedStartLine <= 0 ||
      metadata.returnedEndLine < metadata.returnedStartLine
    ) {
      continue;
    }
    const current = coverage.get(path);
    const entry = current?.version === version
      ? current
      : {
          version,
          totalLines: metadata.totalLines,
          ranges: [],
        };
    entry.totalLines = metadata.totalLines;
    entry.ranges.push({
      startLine: metadata.returnedStartLine,
      endLine: metadata.returnedEndLine,
    });
    coverage.set(path, entry);
  }
  const current = coverage.get(candidatePath);
  if (!current || current.totalLines <= 0) return false;
  return planReadFileWindowCoverage(
    candidate.arguments as Record<string, unknown>,
    current.totalLines,
    current.ranges,
  ).fullyCovered;
}

/** Return the exact focused source requested by the provider from a prior
 * same-version window when one cached receipt contains that range. */
export function runtimeV2ProviderCoveredReadReceipt(
  candidate: RuntimeV2NormalizedToolCall,
  messages: readonly AgentMessage[],
): string | null {
  if (
    candidate.name !== "read_file" ||
    !runtimeV2ProviderReadIsFullyCovered(candidate, messages)
  ) {
    return null;
  }
  const candidatePath = normalizedReadPath(candidate.arguments.path);
  const callsById = new Map<string, {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>();
  const receipts: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        callsById.set(call.id, {
          name: call.function.name,
          arguments: parsedToolCallArguments(
            call.function.arguments,
          ),
        });
      }
      continue;
    }
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const call = callsById.get(message.tool_call_id);
    if (!call) continue;
    if (isWorkspaceMutationToolName(call.name)) {
      receipts.length = 0;
      continue;
    }
    if (
      call.name !== "read_file" ||
      normalizedReadPath(call.arguments.path) !== candidatePath ||
      typeof message.content !== "string"
    ) {
      continue;
    }
    const replay = replayReadFileWindowFromResult(
      message.content,
      candidate.arguments,
    );
    if (replay) receipts.push(replay);
  }
  return receipts[receipts.length - 1] || null;
}

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

/** Runtime v2 schedules one provider-selected effect, commits its evidence,
 * then decides again. When a weak model repeats an already-attempted first
 * call and also proposes a novel later call, select that first novel action.
 * This preserves the one-effect fence without trapping the parent on the
 * stale head of every regenerated batch. */
export function boundRuntimeV2ProviderToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
  attemptedIdentities: ReadonlySet<string> = new Set(),
  rejectedIdentities: ReadonlySet<string> = new Set(),
): {
  readonly accepted: RuntimeV2NormalizedToolCall[];
  readonly discarded: RuntimeV2NormalizedToolCall[];
  readonly selection:
    | "empty"
    | "first"
    | "first_novel_after_attempt"
    | "first_novel_after_rejection"
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
