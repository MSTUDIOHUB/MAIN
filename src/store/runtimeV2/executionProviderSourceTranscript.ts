import type { AgentMessage } from "../../lib/agentMessages";
import {
  extractExactReadFileWindow,
  READ_FILE_RESULT_MARKER,
} from "../../lib/readFileWindow";
import type {
  RuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";

export interface RuntimeV2TranscriptToolGroup {
  readonly order: number;
  readonly assistant: AgentMessage;
  readonly calls: NonNullable<AgentMessage["tool_calls"]>;
  readonly resultsByCallId: ReadonlyMap<string, AgentMessage>;
}

export interface RuntimeV2TranscriptSourceWindow {
  readonly callId: string;
  readonly order: number;
  readonly replayed: boolean;
  readonly path: string;
  readonly version: string;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

function normalizedTranscriptPath(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function parsedTranscriptToolArguments(
  value: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" &&
        !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function collectTranscriptToolGroups(
  messages: readonly AgentMessage[],
): RuntimeV2TranscriptToolGroup[] {
  const results = new Map<string, {
    readonly index: number;
    readonly message: AgentMessage;
  }>();
  messages.forEach((message, index) => {
    if (message.role === "tool" && message.tool_call_id) {
      results.set(message.tool_call_id, { index, message });
    }
  });
  const groups: RuntimeV2TranscriptToolGroup[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return;
    const resultsByCallId = new Map<string, AgentMessage>();
    const calls = message.tool_calls.filter((call) => {
      const result = results.get(call.id);
      if (!result || result.index <= index) return false;
      resultsByCallId.set(call.id, result.message);
      return true;
    });
    if (calls.length > 0) {
      groups.push({
        order: index,
        assistant: message,
        calls,
        resultsByCallId,
      });
    }
  });
  return groups;
}

export function sourceTargetsOverlap(
  left: string,
  right: string,
): boolean {
  const normalizedLeft = normalizedTranscriptPath(left);
  const normalizedRight = normalizedTranscriptPath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`) ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`);
}

function hasExplicitReadWindow(
  args: Readonly<Record<string, unknown>>,
): boolean {
  return [
    "start_line",
    "startLine",
    "end_line",
    "endLine",
    "max_chars",
    "maxChars",
  ].some((key) => args[key] !== undefined && args[key] !== null);
}

/**
 * Source authority comes from a complete standard read envelope, or a raw
 * unwindowed small-file result backed by a durable source receipt.
 */
export function transcriptSourceWindow(
  group: RuntimeV2TranscriptToolGroup,
  call: RuntimeV2TranscriptToolGroup["calls"][number],
  effects?: RuntimeV2ProviderEffectFacts,
): RuntimeV2TranscriptSourceWindow | null {
  if (call.function.name !== "read_file") return null;
  const result = group.resultsByCallId.get(call.id);
  if (!result || typeof result.content !== "string") return null;
  const fact = effects?.sourceReadVersionsByToolCallId.get(call.id);
  const replayed = effects?.replayedToolCallIds.has(call.id) === true;
  if (effects && !fact && !replayed) return null;

  const exact = extractExactReadFileWindow(result.content);
  if (exact) {
    const path = normalizedTranscriptPath(
      fact?.target || exact.metadata.path,
    );
    const version = String(
      fact?.version || exact.metadata.contentVersion || "",
    ).trim();
    if (!path || !version) return null;
    if (
      fact &&
      (
        !sourceTargetsOverlap(fact.target, exact.metadata.path) ||
        (
          exact.metadata.contentVersion &&
          fact.version !== exact.metadata.contentVersion
        )
      )
    ) {
      return null;
    }
    return {
      callId: call.id,
      order: group.order,
      replayed,
      path,
      version,
      totalLines: exact.metadata.totalLines,
      startLine: exact.metadata.returnedStartLine,
      endLine: exact.metadata.returnedEndLine,
      content: exact.content,
    };
  }

  if (result.content.startsWith(READ_FILE_RESULT_MARKER)) return null;
  const args = parsedTranscriptToolArguments(call.function.arguments);
  if (!fact || hasExplicitReadWindow(args)) return null;
  const content = result.content;
  const totalLines = content.length === 0
    ? 0
    : content.split(/\r\n|\n|\r/).length;
  return {
    callId: call.id,
    order: group.order,
    replayed,
    path: normalizedTranscriptPath(fact.target),
    version: String(fact.version || "").trim(),
    totalLines,
    startLine: totalLines === 0 ? 0 : 1,
    endLine: totalLines,
    content,
  };
}
