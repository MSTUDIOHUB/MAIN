import type { AgentMessage } from "../../lib/agentMessages";
import {
  extractReadFileWindowMetadata,
  planReadFileWindowCoverage,
  replayReadFileWindowFromResult,
} from "../../lib/readFileWindow";
import type { RuntimeV2NormalizedToolCall } from "../../lib/runtime-v2";
import { sha256Hex } from "../../lib/sha256";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { isRuntimeV2WorkspaceReadToolName } from "../../lib/runtime-v2/workspaceReadPolicy";
import type {
  RuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";
import type {
  RuntimeV2MaterializedSourceCoverage,
} from "./executionTypes";

const RUNTIME_V2_REJECTED_ACTION_RESULT_PREFIXES = [
  "REPEATED_ACTION_REJECTED:",
  "UNCHANGED_SOURCE_COVERAGE_REUSED:",
  "UNCHANGED_SOURCE_REPEAT_REJECTED:",
  "UNCHANGED_OBSERVATION_REPEAT_REJECTED:",
] as const;

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

function committedMutationTargets(
  toolCallId: string,
  effects?: RuntimeV2ProviderEffectFacts,
): readonly string[] | null {
  // Transcript-only callers predate the durable effect projection and retain
  // their historical all-target interpretation. Production always supplies
  // the projection; an absent entry there cannot manufacture a mutation.
  if (effects === undefined) return ["*"];
  return effects.committedMutationTargetsByToolCallId.get(toolCallId) ||
    null;
}

/** Only a standard assistant/tool pair proves that an action was actually
 * attempted. Provider siblings discarded by the one-effect scheduler have no
 * tool result and must remain eligible when the model proposes them again. */
export function completedRuntimeV2ProviderToolCallIdentities(
  messages: readonly AgentMessage[],
  effects?: RuntimeV2ProviderEffectFacts,
): ReadonlySet<string> {
  const callsById = new Map<string, {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>();
  const identities = new Set<string>();
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
    const mutationTargets = isWorkspaceMutationToolName(call.name)
      ? committedMutationTargets(message.tool_call_id, effects)
      : null;
    if (mutationTargets) {
      identities.clear();
    }
    identities.add(runtimeV2ProviderToolCallIdentity(call));
  }
  return identities;
}

function normalizedReadPath(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * A cached successful observation is itself the idempotent result. Replay the
 * original standard tool receipt for every safe workspace read instead of
 * replacing it with a synthetic rejection that hides the answer.
 */
export function runtimeV2ProviderCachedReadCanReplay(
  candidate: RuntimeV2NormalizedToolCall,
): boolean {
  return isRuntimeV2WorkspaceReadToolName(candidate.name);
}

function isRuntimeV2ReusableReadResult(content: string): boolean {
  const normalized = content.trim();
  return ![
    ...RUNTIME_V2_REJECTED_ACTION_RESULT_PREFIXES,
    "MUTATION_PREFLIGHT_BLOCKED:",
    "TOOL_FAILED",
    "TOOL_ERROR",
    "TOOL_BLOCKED",
    "ERROR:",
  ].some((prefix) => normalized.startsWith(prefix));
}

/** Reconstruct versioned read coverage from completed standard transcript
 * pairs. Any mutation result clears all coverage because the parent must
 * observe a fresh global source boundary before another write. Raw small-file
 * reads have no range envelope and are intentionally left to the exact-action
 * guard. */
export function runtimeV2ProviderReadIsFullyCovered(
  candidate: RuntimeV2NormalizedToolCall,
  messages: readonly AgentMessage[],
  effects?: RuntimeV2ProviderEffectFacts,
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
    const mutationTargets = isWorkspaceMutationToolName(call.name)
      ? committedMutationTargets(message.tool_call_id, effects)
      : null;
    if (mutationTargets) {
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

/**
 * Reconstruct the path/version replay closure from the durable transcript and
 * effect ledger. The live rejection map is only an optimization; restoring a
 * Run must not grant another large replay for alternate ranges of a source
 * that was already replayed at the same mutation boundary.
 */
export function runtimeV2ProviderCoveredSourceReplayIsClosed(
  candidate: RuntimeV2NormalizedToolCall,
  messages: readonly AgentMessage[],
  effects?: RuntimeV2ProviderEffectFacts,
): boolean {
  if (
    candidate.name !== "read_file" ||
    !effects ||
    !runtimeV2ProviderReadIsFullyCovered(candidate, messages, effects)
  ) {
    return false;
  }
  const candidatePath = normalizedReadPath(candidate.arguments.path);
  if (!candidatePath) return false;
  const callsById = new Map<string, {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>();
  let currentVersion = "";
  let replayedVersion = "";
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
    const mutationTargets = isWorkspaceMutationToolName(call.name)
      ? committedMutationTargets(message.tool_call_id, effects)
      : null;
    if (mutationTargets) {
      currentVersion = "";
      replayedVersion = "";
      continue;
    }
    if (
      call.name !== "read_file" ||
      normalizedReadPath(call.arguments.path) !== candidatePath ||
      typeof message.content !== "string"
    ) {
      continue;
    }
    const metadata = extractReadFileWindowMetadata(message.content);
    const version = String(metadata?.contentVersion || "").trim();
    if (!version) continue;
    if (currentVersion && currentVersion !== version) {
      replayedVersion = "";
    }
    currentVersion = version;
    if (effects.replayedToolCallIds.has(message.tool_call_id)) {
      replayedVersion = version;
    }
  }
  return !!currentVersion && replayedVersion === currentVersion;
}

/**
 * A replay closure is actionable only while the requested range is still
 * present in the exact outbound decision view. Canonical transcript coverage
 * alone is not model visibility: the bounded workset may have moved to other
 * files, in which case a cache replay must be allowed again.
 */
export function runtimeV2ProviderReadIsMaterialized(
  candidate: RuntimeV2NormalizedToolCall,
  materialized: readonly RuntimeV2MaterializedSourceCoverage[],
): boolean {
  if (candidate.name !== "read_file") return false;
  const candidatePath = normalizedReadPath(candidate.arguments.path);
  if (!candidatePath) return false;
  const current = materialized.find((entry) =>
    normalizedReadPath(entry.target) === candidatePath
  );
  if (!current) return false;
  if (current.totalLines === 0) return current.complete;
  return planReadFileWindowCoverage(
    candidate.arguments as Record<string, unknown>,
    current.totalLines,
    [...current.windows],
  ).fullyCovered;
}

/** Return the exact focused source requested by the provider from a prior
 * same-version window when one cached receipt contains that range. */
export function runtimeV2ProviderCoveredReadReceipt(
  candidate: RuntimeV2NormalizedToolCall,
  messages: readonly AgentMessage[],
  effects?: RuntimeV2ProviderEffectFacts,
): string | null {
  if (
    candidate.name !== "read_file" ||
    !runtimeV2ProviderReadIsFullyCovered(candidate, messages, effects)
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
    const mutationTargets = isWorkspaceMutationToolName(call.name)
      ? committedMutationTargets(message.tool_call_id, effects)
      : null;
    if (mutationTargets) {
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

/** Reuse an exact successful read receipt at the same mutation boundary.
 * This covers small/raw reads and non-file source tools that have no ranged
 * coverage envelope. A committed mutation invalidates every earlier receipt. */
export function runtimeV2ProviderExactReadReceipt(
  candidate: RuntimeV2NormalizedToolCall,
  messages: readonly AgentMessage[],
  effects?: RuntimeV2ProviderEffectFacts,
): string | null {
  if (!isRuntimeV2WorkspaceReadToolName(candidate.name)) return null;
  const candidateIdentity =
    runtimeV2ProviderToolCallIdentity(candidate);
  const callsById = new Map<string, {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>();
  let receipt: string | null = null;
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
    const mutationTargets = isWorkspaceMutationToolName(call.name)
      ? committedMutationTargets(message.tool_call_id, effects)
      : null;
    if (mutationTargets) {
      receipt = null;
      continue;
    }
    if (
      runtimeV2ProviderToolCallIdentity(call) !== candidateIdentity ||
      typeof message.content !== "string" ||
      !isRuntimeV2ReusableReadResult(message.content)
    ) {
      continue;
    }
    receipt = message.content;
  }
  return receipt;
}

export function runtimeV2ProviderReusableReadReceipt(
  candidate: RuntimeV2NormalizedToolCall,
  messages: readonly AgentMessage[],
  effects?: RuntimeV2ProviderEffectFacts,
): string | null {
  return runtimeV2ProviderCoveredReadReceipt(
    candidate,
    messages,
    effects,
  ) ||
    runtimeV2ProviderExactReadReceipt(candidate, messages, effects);
}
