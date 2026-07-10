// src/lib/orchestrator/state/EphemeralPruner.ts
// "Burn After Reading" — prunes ephemeral tool outputs and replaces
// them with compact placeholders before the next turn's prompt is built.
// Provides both class-based (backward compat) and functional APIs.
// ────────────────────────────────────────────────────────────────────

import type { AgentMessage } from "../types";
import type { TurnContext } from "./TurnContext";

// ── Functional API (new) ──────────────────────────────────────────────

export interface PruneOptions {
  maxToolChars?: number;
  maxReasoningChars?: number;
  purgeReasoningFromPriorTurns?: boolean;
  preserveLatestUnconsumedToolResults?: boolean;
}

export interface PrunedResult {
  messages: AgentMessage[];
  burnedToolResults: number;
  burnedToolChars: number;
  preservedToolResults: number;
  preservedToolChars: number;
  toolCharsBefore: number;
  toolCharsAfter: number;
  purgedReasoning: number;
  replacedAssistantReasoning: number;
}

export interface UnconsumedToolResultBatch {
  batchToken: string;
  assistantMessageIndex: number;
  assistantMessage: AgentMessage;
  toolCallIds: string[];
  toolResultMessageIndices: number[];
  toolResults: AgentMessage[];
  anchorMessages: Array<{
    sourceIndex: number;
    message: AgentMessage;
    anchorToken: string;
  }>;
  hasPriorEquivalentAssistantSinceAnchor: boolean;
  toolChars: number;
}

export interface RestoredToolResultBatch {
  messages: AgentMessage[];
  restoredToolResults: number;
  reinsertedToolResults: number;
  restoredToolChars: number;
}

const DEFAULTS = {
  maxToolChars: 2000,
  maxReasoningChars: 500,
  purgeReasoningFromPriorTurns: true,
};

const UNCONSUMED_TOOL_BATCH_MARKER = Symbol("unconsumed-tool-batch");
const TOOL_BATCH_ANCHOR_MARKER = Symbol("tool-batch-anchor");
const batchTokenByAssistant = new WeakMap<AgentMessage, string>();
const anchorTokenByMessage = new WeakMap<AgentMessage, string>();
let nextBatchToken = 0;
let nextAnchorToken = 0;

type BatchMarkedAgentMessage = AgentMessage & {
  [UNCONSUMED_TOOL_BATCH_MARKER]?: string;
  [TOOL_BATCH_ANCHOR_MARKER]?: string;
};

function getBatchToken(message: AgentMessage): string | null {
  return (message as BatchMarkedAgentMessage)[UNCONSUMED_TOOL_BATCH_MARKER] ||
    batchTokenByAssistant.get(message) ||
    null;
}

function getOrCreateBatchToken(assistantMessage: AgentMessage): string {
  const existing = getBatchToken(assistantMessage);
  if (existing) return existing;
  nextBatchToken += 1;
  const token = `unconsumed-batch-${nextBatchToken}`;
  batchTokenByAssistant.set(assistantMessage, token);
  return token;
}

function setBatchToken(message: AgentMessage, batchToken: string): void {
  (message as BatchMarkedAgentMessage)[UNCONSUMED_TOOL_BATCH_MARKER] = batchToken;
}

function getAnchorToken(message: AgentMessage): string | null {
  return (message as BatchMarkedAgentMessage)[TOOL_BATCH_ANCHOR_MARKER] ||
    anchorTokenByMessage.get(message) ||
    null;
}

function getOrCreateAnchorToken(message: AgentMessage): string {
  const existing = getAnchorToken(message);
  if (existing) return existing;
  nextAnchorToken += 1;
  const token = `batch-anchor-${nextAnchorToken}`;
  anchorTokenByMessage.set(message, token);
  return token;
}

function setAnchorToken(message: AgentMessage, anchorToken: string): void {
  (message as BatchMarkedAgentMessage)[TOOL_BATCH_ANCHOR_MARKER] = anchorToken;
}

function stripInternalBatchMarkers(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (
      !(UNCONSUMED_TOOL_BATCH_MARKER in (message as BatchMarkedAgentMessage)) &&
      !(TOOL_BATCH_ANCHOR_MARKER in (message as BatchMarkedAgentMessage))
    ) {
      return message;
    }
    const clean = { ...message } as BatchMarkedAgentMessage;
    delete clean[UNCONSUMED_TOOL_BATCH_MARKER];
    delete clean[TOOL_BATCH_ANCHOR_MARKER];
    return clean;
  });
}

function estimateContentChars(msg: AgentMessage): number {
  if (typeof msg.content === "string") return msg.content.length;
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, p) => {
      if (p.type === "text" && typeof p.text === "string") return sum + p.text.length;
      return sum;
    }, 0);
  }
  return 0;
}

export function countToolResultChars(messages: AgentMessage[]): number {
  return messages.reduce(
    (sum, message) => message.role === "tool" ? sum + estimateContentChars(message) : sum,
    0,
  );
}

function getAssistantToolCallIds(message: AgentMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  return [...new Set(message.tool_calls.map((toolCall) => toolCall.id).filter(Boolean))];
}

function isStableBatchAnchor(message: AgentMessage): boolean {
  // Tool protocol ids are not globally unique: some local/native providers
  // synthesize `native_call_1` on every model iteration. Anchor restoration to
  // ordinary conversation messages instead of another assistant/tool pair.
  return message.role !== "tool" && getAssistantToolCallIds(message).length === 0;
}

/**
 * A tool result is unconsumed while its assistant tool-call batch is the
 * latest assistant message in history. Once another assistant message exists,
 * the preceding results have been included in a completed model request and
 * become eligible for normal pruning.
 */
export function captureLatestUnconsumedToolResultBatch(
  messages: AgentMessage[],
): UnconsumedToolResultBatch | null {
  let assistantMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistantMessageIndex = index;
      break;
    }
  }
  if (assistantMessageIndex < 0) return null;

  const assistantMessage = messages[assistantMessageIndex];
  const requestedToolCallIds = getAssistantToolCallIds(assistantMessage);
  if (requestedToolCallIds.length === 0) return null;

  const requested = new Set(requestedToolCallIds);
  const toolResultMessageIndices: number[] = [];
  const toolResults: AgentMessage[] = [];
  for (let index = assistantMessageIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message?.role === "tool" &&
      message.tool_call_id &&
      requested.has(message.tool_call_id)
    ) {
      toolResultMessageIndices.push(index);
      toolResults.push(message);
    }
  }
  if (toolResults.length === 0) return null;

  const returnedToolCallIds = new Set(
    toolResults.map((message) => message.tool_call_id).filter(Boolean) as string[],
  );
  let previousStableAnchorIndex = -1;
  for (let index = assistantMessageIndex - 1; index >= 0; index -= 1) {
    if (isStableBatchAnchor(messages[index])) {
      previousStableAnchorIndex = index;
      break;
    }
  }
  return {
    batchToken: getOrCreateBatchToken(assistantMessage),
    assistantMessageIndex,
    assistantMessage,
    toolCallIds: requestedToolCallIds.filter((toolCallId) => returnedToolCallIds.has(toolCallId)),
    toolResultMessageIndices,
    toolResults,
    anchorMessages: messages.flatMap((message, sourceIndex) =>
      isStableBatchAnchor(message)
        ? [{ sourceIndex, message, anchorToken: getOrCreateAnchorToken(message) }]
        : []
    ),
    hasPriorEquivalentAssistantSinceAnchor: messages
      .slice(previousStableAnchorIndex + 1, assistantMessageIndex)
      .some((message) => messagesMatch(message, assistantMessage)),
    toolChars: toolResults.reduce((sum, message) => sum + estimateContentChars(message), 0),
  };
}

export function markLatestUnconsumedToolResultBatch(
  messages: AgentMessage[],
  batch: UnconsumedToolResultBatch | null,
): AgentMessage[] {
  if (!batch) return messages;
  const protectedIndices = new Set([
    batch.assistantMessageIndex,
    ...batch.toolResultMessageIndices,
  ]);
  const anchorByIndex = new Map(
    batch.anchorMessages.map((anchor) => [anchor.sourceIndex, anchor]),
  );
  return messages.map((message, index) => {
    const anchor = anchorByIndex.get(index);
    if (!protectedIndices.has(index) && !anchor) return message;
    const marked = { ...message } as AgentMessage;
    if (protectedIndices.has(index)) setBatchToken(marked, batch.batchToken);
    if (anchor) setAnchorToken(marked, anchor.anchorToken);
    return marked;
  });
}

function contentMatches(left: AgentMessage["content"], right: AgentMessage["content"]): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function toolCallsMatch(left: AgentMessage, right: AgentMessage): boolean {
  return JSON.stringify(left.tool_calls || []) === JSON.stringify(right.tool_calls || []);
}

function messagesMatch(left: AgentMessage, right: AgentMessage): boolean {
  return left.role === right.role &&
    left.tool_call_id === right.tool_call_id &&
    contentMatches(left.content, right.content) &&
    toolCallsMatch(left, right);
}

function alignBatchAnchors(
  anchors: UnconsumedToolResultBatch["anchorMessages"],
  messages: AgentMessage[],
): Array<{ sourceIndex: number; messageIndex: number }> {
  const anchorMatches = (
    anchor: UnconsumedToolResultBatch["anchorMessages"][number],
    message: AgentMessage,
  ) => {
    const messageAnchorToken = getAnchorToken(message);
    return messageAnchorToken
      ? messageAnchorToken === anchor.anchorToken
      : messagesMatch(anchor.message, message);
  };
  const rows = anchors.length;
  const columns = messages.length;
  const lengths = Array.from(
    { length: rows + 1 },
    () => new Uint16Array(columns + 1),
  );

  for (let anchorIndex = rows - 1; anchorIndex >= 0; anchorIndex -= 1) {
    for (let messageIndex = columns - 1; messageIndex >= 0; messageIndex -= 1) {
      lengths[anchorIndex][messageIndex] = anchorMatches(
        anchors[anchorIndex],
        messages[messageIndex],
      )
        ? lengths[anchorIndex + 1][messageIndex + 1] + 1
        : Math.max(
            lengths[anchorIndex + 1][messageIndex],
            lengths[anchorIndex][messageIndex + 1],
          );
    }
  }

  const matches: Array<{ sourceIndex: number; messageIndex: number }> = [];
  let anchorIndex = 0;
  let messageIndex = 0;
  while (anchorIndex < rows && messageIndex < columns) {
    if (
      anchorMatches(anchors[anchorIndex], messages[messageIndex]) &&
      lengths[anchorIndex][messageIndex] === lengths[anchorIndex + 1][messageIndex + 1] + 1
    ) {
      matches.push({
        sourceIndex: anchors[anchorIndex].sourceIndex,
        messageIndex,
      });
      anchorIndex += 1;
      messageIndex += 1;
    } else if (lengths[anchorIndex + 1][messageIndex] >= lengths[anchorIndex][messageIndex + 1]) {
      anchorIndex += 1;
    } else {
      messageIndex += 1;
    }
  }
  return matches;
}

function resolveBatchRestoreWindow(
  messages: AgentMessage[],
  batch: UnconsumedToolResultBatch,
): { start: number; end: number; anchored: boolean } {
  const precedingAnchors = batch.anchorMessages.filter(
    (anchor) => anchor.sourceIndex < batch.assistantMessageIndex,
  );
  const followingAnchors = batch.anchorMessages.filter(
    (anchor) => anchor.sourceIndex > batch.assistantMessageIndex,
  );

  // Resolve suffix anchors from the tail first. Identical recovery/hook text
  // can occur on both sides of a batch; a single forward LCS would otherwise
  // prefer the earlier source occurrence and append the restored batch after
  // the surviving recovery message.
  const reversedFollowingMatches = alignBatchAnchors(
    [...followingAnchors].reverse(),
    [...messages].reverse(),
  );
  let followingAnchorIndex = messages.length;
  for (const match of reversedFollowingMatches) {
    followingAnchorIndex = Math.min(
      followingAnchorIndex,
      messages.length - 1 - match.messageIndex,
    );
  }

  // A message claimed by the suffix cannot also serve as the prefix anchor.
  // Match preceding context only inside the window before that suffix.
  const precedingMatches = alignBatchAnchors(
    precedingAnchors,
    messages.slice(0, followingAnchorIndex),
  );
  let previousAnchorIndex = -1;
  for (const match of precedingMatches) {
    previousAnchorIndex = Math.max(previousAnchorIndex, match.messageIndex);
  }
  return {
    start: previousAnchorIndex + 1,
    end: followingAnchorIndex,
    anchored: previousAnchorIndex >= 0 || followingAnchorIndex < messages.length,
  };
}

/**
 * Context compaction is allowed to rewrite old tool results, but the latest
 * unconsumed batch must reach the model verbatim. Reinsert its assistant/tool
 * protocol group if a broader compactor removed it, or restore exact content
 * if it was shortened.
 */
export function restoreLatestUnconsumedToolResultBatch(
  messages: AgentMessage[],
  batch: UnconsumedToolResultBatch | null,
): RestoredToolResultBatch {
  if (!batch || batch.toolResults.length === 0) {
    return {
      messages,
      restoredToolResults: 0,
      reinsertedToolResults: 0,
      restoredToolChars: 0,
    };
  }

  const protectedIds = new Set(batch.toolCallIds);
  const restoreWindow = resolveBatchRestoreWindow(messages, batch);
  const markedParentCandidates: number[] = [];
  const parentCandidates: number[] = [];
  if (restoreWindow.anchored) {
    for (let index = restoreWindow.start; index < restoreWindow.end; index += 1) {
      if (
        messages[index].role === "assistant" &&
        getBatchToken(messages[index]) === batch.batchToken
      ) {
        markedParentCandidates.push(index);
      }
      if (messagesMatch(messages[index], batch.assistantMessage)) {
        parentCandidates.push(index);
      }
    }
  }
  const parentIndex = markedParentCandidates.length > 0
    ? markedParentCandidates[markedParentCandidates.length - 1]
    : batch.hasPriorEquivalentAssistantSinceAnchor
      ? -1
      : parentCandidates.length > 0
        ? parentCandidates[parentCandidates.length - 1]
        : -1;
  let resultScanStart = parentIndex >= 0 ? parentIndex + 1 : restoreWindow.start;
  let resultScanEnd = restoreWindow.end;
  if (parentIndex >= 0) {
    // Hook/recovery messages may be interleaved between results. Once the
    // exact parent is known, the batch scope lasts until the next assistant,
    // not merely until the first stable anchor.
    resultScanEnd = messages.length;
    const nextAssistantOffset = messages
      .slice(resultScanStart, resultScanEnd)
      .findIndex((message) => message.role === "assistant");
    if (nextAssistantOffset >= 0) {
      resultScanEnd = resultScanStart + nextAssistantOffset;
    }
  } else {
    // Without an exact marked parent, matching ids may belong to an older
    // fallback-id batch. Never remove or rewrite those historical results.
    resultScanStart = messages.length;
    resultScanEnd = messages.length;
  }

  const scopedResults: Array<{ index: number; message: AgentMessage }> = [];
  for (let index = resultScanStart; index < resultScanEnd; index += 1) {
    const message = messages[index];
    if (message.role === "tool" && message.tool_call_id && protectedIds.has(message.tool_call_id)) {
      scopedResults.push({ index, message });
    }
  }
  const existingQueues = new Map<string, Array<{ index: number; message: AgentMessage }>>();
  for (const entry of scopedResults) {
    const toolCallId = entry.message.tool_call_id || "";
    const queue = existingQueues.get(toolCallId) || [];
    queue.push(entry);
    existingQueues.set(toolCallId, queue);
  }

  let restoredToolResults = 0;
  let reinsertedToolResults = 0;
  let restoredToolChars = 0;
  const matchedResults: Array<{ index: number; message: AgentMessage } | null> = [];
  for (const sourceResult of batch.toolResults) {
    const toolCallId = sourceResult.tool_call_id || "";
    const existing = existingQueues.get(toolCallId)?.shift() || null;
    matchedResults.push(existing);
    const sourceChars = estimateContentChars(sourceResult);
    if (!existing) {
      restoredToolResults += 1;
      reinsertedToolResults += 1;
      restoredToolChars += sourceChars;
    } else if (!contentMatches(existing.message.content, sourceResult.content)) {
      restoredToolResults += 1;
      restoredToolChars += sourceChars;
    }
  }

  const hasExtraScopedResults = [...existingQueues.values()].some((queue) => queue.length > 0);
  const batchIsAlreadyExact =
    parentIndex >= 0 &&
    !hasExtraScopedResults &&
    matchedResults.every((entry, index) =>
      !!entry && contentMatches(entry.message.content, batch.toolResults[index].content)
    );
  if (batchIsAlreadyExact) {
    return {
      messages: stripInternalBatchMarkers(messages),
      restoredToolResults,
      reinsertedToolResults,
      restoredToolChars,
    };
  }

  const indicesToRemove = new Set(scopedResults.map((entry) => entry.index));
  if (parentIndex >= 0) indicesToRemove.add(parentIndex);
  const insertionIndex = parentIndex >= 0
    ? parentIndex
    : restoreWindow.end < messages.length
      ? restoreWindow.end
      : messages.length;
  const restored: AgentMessage[] = [];
  let inserted = false;
  for (let index = 0; index < messages.length; index += 1) {
    if (index === insertionIndex) {
      restored.push(batch.assistantMessage, ...batch.toolResults);
      inserted = true;
    }
    if (!indicesToRemove.has(index)) restored.push(messages[index]);
  }
  if (!inserted) {
    restored.push(batch.assistantMessage, ...batch.toolResults);
  }

  return {
    messages: stripInternalBatchMarkers(restored),
    restoredToolResults,
    reinsertedToolResults,
    restoredToolChars,
  };
}

function buildBurnedToolStub(msg: AgentMessage, originalChars: number): string {
  const toolCallId = msg.tool_call_id || "unknown";
  return `[Burned: tool result for ${toolCallId} (${originalChars.toLocaleString()} chars → replaced with compact summary in context memory)]`;
}

function buildBurnedReasoningStub(originalReasoningChars: number): string {
  return `[Burned: ${originalReasoningChars.toLocaleString()} chars of internal reasoning → summarized in context memory]`;
}

function compactReasoningSummary(reasoning: string): string {
  const lines = reasoning.split(/\n/).map(l => l.trim()).filter(Boolean);
  const paths = lines.filter(l => /\.(ts|tsx|js|jsx|py|rs|go|json|toml|yaml|yml|md|css|html|sql)/.test(l));
  const actions = lines.filter(l => /^(read|write|edit|apply|run|execute|check|verify|analyze|explore|search)/i.test(l));
  const parts: string[] = [];
  if (actions.length > 0) parts.push(actions[0].slice(0, 120));
  if (paths.length > 0) parts.push(`files: ${paths[0].slice(0, 80)}`);
  return parts.join(" — ") || "Processed internal reasoning";
}

export function pruneEphemeralItems(
  messages: AgentMessage[],
  turnContext: TurnContext | null,
  options: PruneOptions = {},
): PrunedResult {
  const cfg = { ...DEFAULTS, ...options };
  const result: PrunedResult = {
    messages,
    burnedToolResults: 0,
    burnedToolChars: 0,
    preservedToolResults: 0,
    preservedToolChars: 0,
    toolCharsBefore: countToolResultChars(messages),
    toolCharsAfter: 0,
    purgedReasoning: 0,
    replacedAssistantReasoning: 0,
  };
  const preservedToolResultIndices = new Set<number>();
  let latestUnconsumedBatchForPrune: UnconsumedToolResultBatch | null = null;
  let anchorTokenByIndex = new Map<number, string>();
  if (options.preserveLatestUnconsumedToolResults !== false) {
    latestUnconsumedBatchForPrune = captureLatestUnconsumedToolResultBatch(messages);
    for (const index of latestUnconsumedBatchForPrune?.toolResultMessageIndices || []) {
      preservedToolResultIndices.add(index);
    }
    anchorTokenByIndex = new Map(
      (latestUnconsumedBatchForPrune?.anchorMessages || []).map((anchor) => [
        anchor.sourceIndex,
        anchor.anchorToken,
      ]),
    );
  }

  let latestAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") { latestAssistantIdx = i; break; }
  }

  const newMessages: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = { ...messages[i] } as AgentMessage;
    if (
      latestUnconsumedBatchForPrune &&
      (
        i === latestUnconsumedBatchForPrune.assistantMessageIndex ||
        preservedToolResultIndices.has(i)
      )
    ) {
      setBatchToken(msg, latestUnconsumedBatchForPrune.batchToken);
    }
    const anchorToken = anchorTokenByIndex.get(i);
    if (anchorToken) setAnchorToken(msg, anchorToken);
    const isPriorAssistant = msg.role === "assistant" && i !== latestAssistantIdx;

    if (msg.role === "tool") {
      const contentChars = estimateContentChars(msg);
      const mustPreserve = preservedToolResultIndices.has(i);
      if (mustPreserve) {
        result.preservedToolResults++;
        result.preservedToolChars += contentChars;
      } else if (contentChars > cfg.maxToolChars) {
        msg.content = buildBurnedToolStub(msg, contentChars);
        result.burnedToolResults++;
        result.burnedToolChars += contentChars;
        if (turnContext) {
          turnContext.recordBurnedReplacement({ replacementText: msg.content as string, originalLength: contentChars });
        }
      }
    }

    if (isPriorAssistant) {
      if (cfg.purgeReasoningFromPriorTurns) {
        if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > cfg.maxReasoningChars) {
          const summary = compactReasoningSummary(msg.reasoning_content);
          if (typeof msg.content === "string") msg.content += "\n\n" + buildBurnedReasoningStub(msg.reasoning_content.length);
          else if (Array.isArray(msg.content)) msg.content = [...msg.content, { type: "text", text: "\n\n" + buildBurnedReasoningStub(msg.reasoning_content.length) }];
          msg.reasoning_content = summary;
          result.purgedReasoning++;
          if (turnContext) turnContext.accumulateReasoning(msg.reasoning_content.length);
        } else if (msg.reasoning_content && typeof msg.reasoning_content === "string") {
          msg.reasoning_content = "";
        }
        if (typeof msg.reasoning === "string") msg.reasoning = "";
      }
    }

    if (msg.role === "assistant" && i === latestAssistantIdx) {
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > cfg.maxReasoningChars) {
        if (turnContext) turnContext.accumulateReasoning(msg.reasoning_content.length);
        result.replacedAssistantReasoning++;
      }
    }

    newMessages.push(msg);
  }

  result.messages = newMessages;
  result.toolCharsAfter = countToolResultChars(newMessages);
  return result;
}

// ── Class-based API (backward compat) ────────────────────────────────

export interface EphemeralPrunerOptions {
  maxToolChars?: number;
  maxReasoningChars?: number;
  language?: "zh" | "en";
}

export class EphemeralPruner {
  private maxToolChars: number;
  private maxReasoningChars: number;
  private language: "zh" | "en";

  constructor(options: EphemeralPrunerOptions = {}) {
    this.maxToolChars = options.maxToolChars ?? 2000;
    this.maxReasoningChars = options.maxReasoningChars ?? 500;
    this.language = options.language ?? "zh";
  }

  /**
   * Legacy: prune ephemeral tool results and reasoning from messages.
   * Uses ephemeralItemIds set to identify which tool results to prune.
   */
  prune(messages: AgentMessage[], ephemeralItemIds: Set<string>, contextMemoryText?: string): AgentMessage[] {
    const isZh = this.language === "zh";
    const protectedToolResultIndices = new Set(
      captureLatestUnconsumedToolResultBatch(messages)?.toolResultMessageIndices || [],
    );
    const pruned = messages.map((msg, index) => {
      // Prune ephemeral tool results
      if (
        msg.role === "tool" &&
        msg.tool_call_id &&
        ephemeralItemIds.has(msg.tool_call_id) &&
        !protectedToolResultIndices.has(index)
      ) {
        const textContent = typeof msg.content === "string" ? msg.content : "";
        if (textContent.length > this.maxToolChars) {
          const lines = textContent.split("\n").length;
          const replacement = isZh
            ? `[已剪枝：暂态工具输出已隐藏，共读取了 ${lines} 行，结果摘要已保存在上下文记忆中]`
            : `[Pruned: Ephemeral tool output hidden, read ${lines} lines, result summarized in context memory]`;
          return { ...msg, content: replacement };
        }
      }
      // Prune long reasoning from prior assistant messages
      const isLastAssistant = msg.role === "assistant" && index === messages.length - 1;
      if (msg.role === "assistant" && !isLastAssistant) {
        let updated = { ...msg };
        let hasChanges = false;
        if (typeof msg.reasoning === "string" && msg.reasoning.length > this.maxReasoningChars) {
          updated.reasoning = isZh ? "[推理内容已修剪]" : "[Reasoning pruned]";
          hasChanges = true;
        }
        if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > this.maxReasoningChars) {
          updated.reasoning_content = isZh ? "[推理内容已修剪]" : "[Reasoning content pruned]";
          hasChanges = true;
        }
        if (hasChanges) return updated;
      }
      return msg;
    });

    // Inject context memory if provided
    if (contextMemoryText && contextMemoryText.trim()) {
      const hasMemory = pruned.some(m =>
        m.role === "user" && typeof m.content === "string" && m.content.includes("[System: ContextState")
      );
      if (!hasMemory) {
        pruned.push({ role: "user", content: contextMemoryText });
      }
    }

    return pruned;
  }
}
