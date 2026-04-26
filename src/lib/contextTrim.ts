// lib/contextTrim.ts
// Trims conversation history to fit within the model's context window.
//
// Inspired by claude-code-haha's multi-layered context management:
//   - Snip: explicit marker-based truncation
//   - Middle-out: drop old messages but keep system + recent
//   - Compact: summarize old messages instead of just dropping them
// ────────────────────────────────────────────────────────────────────

export interface TrimMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | TrimContentPart[];
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface TrimTextPart {
  type: "text";
  text: string;
}

export interface TrimImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

export type TrimContentPart = TrimTextPart | TrimImageUrlPart;

export interface ContextBudgets {
  contextLimit: number;
  outputBudget: number;
  inputBudget: number;
  proactiveTriggerBudget: number;
  proactiveTargetBudget: number;
}

export interface ContextTrimResult {
  messages: TrimMessage[];
  droppedMessages: TrimMessage[];
  removedCount: number;
  markerSummary?: string;
  displaySummary?: string;
}

interface CompressionSummaryOptions {
  maxItems: number;
  maxCharsPerItem: number;
}

/**
 * Rough token estimate for mixed CJK/Latin text.
 * - English: ~4 chars per token
 * - Chinese: ~1.5 chars per token
 * - We use a conservative ~2.5 chars/token for mixed content.
 * - Overhead per message (~10 tokens for role, formatting, etc.)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

/** Estimate tokens for multimodal content (text + images). */
function estimateContentTokens(content: string | TrimContentPart[]): number {
  if (typeof content === "string") return estimateTokens(content);
  let total = 0;
  for (const part of content) {
    if (part.type === "text") {
      total += estimateTokens(part.text);
    } else if (part.type === "image_url") {
      // Image tokens depend on resolution — estimate conservatively
      total += 1000;
    }
  }
  return total;
}

/**
 * Estimate total tokens for a message (content + overhead).
 */
function estimateMessageTokens(msg: TrimMessage): number {
  let tokens = estimateContentTokens(msg.content);
  // Role + formatting overhead
  tokens += 10;
  // tool_calls add significant overhead
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    tokens += estimateTokens(JSON.stringify(msg.tool_calls));
  }
  return tokens;
}

export function estimateMessagesTokens(messages: TrimMessage[]): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
}

export function computeContextBudgets(
  contextLimit: number,
  outputBudgetOverride?: number,
): ContextBudgets {
  const outputBudget = outputBudgetOverride
    ?? Math.min(4096, Math.max(1024, Math.floor(contextLimit * 0.2)));
  const inputBudget = Math.max(0, contextLimit - outputBudget);
  return {
    contextLimit,
    outputBudget,
    inputBudget,
    proactiveTriggerBudget: Math.floor(inputBudget * 0.92),
    proactiveTargetBudget: Math.floor(inputBudget * 0.8),
  };
}

function contentEquals(a: string | TrimContentPart[], b: string | TrimContentPart[]): boolean {
  if (typeof a === "string" || typeof b === "string") {
    return a === b;
  }
  if (a.length !== b.length) return false;
  return a.every((part, index) => {
    const other = b[index];
    if (!other || part.type !== other.type) return false;
    if (part.type === "text" && other.type === "text") {
      return part.text === other.text;
    }
    if (part.type === "image_url" && other.type === "image_url") {
      return part.image_url.url === other.image_url.url;
    }
    return false;
  });
}

function toolCallsEqual(a?: unknown[], b?: unknown[]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function messagesEqual(a: TrimMessage[], b: TrimMessage[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((msg, index) => {
    const other = b[index];
    if (!other) return false;
    return (
      msg.role === other.role &&
      msg.tool_call_id === other.tool_call_id &&
      contentEquals(msg.content, other.content) &&
      toolCallsEqual(msg.tool_calls, other.tool_calls)
    );
  });
}

// region: 压缩摘要辅助

function isContextCompressionMarker(message: TrimMessage): boolean {
  if (message.role !== "user" || typeof message.content !== "string") return false;
  const text = message.content.trim();
  return (
    text.startsWith("[System: 较早对话已压缩。") ||
    (text.startsWith("[System:") && text.includes("Earlier context has been summarized"))
  );
}

function extractContextCompressionSummary(message: TrimMessage): string | undefined {
  if (!isContextCompressionMarker(message) || typeof message.content !== "string") return undefined;
  const lines = message.content
    .replace(/^\[System:\s*/, "")
    .replace(/\]$/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "较早对话已压缩。")
    .filter((line) => line !== "Earlier context has been summarized — you have all essential information to continue.")
    .filter((line) => line !== "请只把这些内容当作历史参考，优先依据当前最新消息继续。");

  if (lines.length === 0) return undefined;
  return lines.join(" ");
}

function messageContentToText(content: string | TrimContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => part.type === "text" ? part.text : "[image]")
    .join("\n");
}

function compactTextLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trim()}…`;
}

function summarizeDroppedMessage(message: TrimMessage): string | null {
  const text = compactTextLine(messageContentToText(message.content), 220);
  if (!text) return null;

  if (message.role === "tool") {
    return `工具结果：${text}`;
  }

  if (message.role === "assistant") {
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolNames = message.tool_calls
        .map((toolCall) => {
          const candidate = toolCall as { function?: { name?: unknown } };
          return typeof candidate.function?.name === "string" ? candidate.function.name : "tool_call";
        })
        .slice(0, 4)
        .join("、");
      return `助手调用工具：${toolNames || "tool_call"}`;
    }
    return `助手回复：${text}`;
  }

  return `用户请求：${text}`;
}

function buildCompactSummary(
  droppedMessages: TrimMessage[],
  carriedSummaries: string[],
  options: CompressionSummaryOptions,
): string | undefined {
  const carriedItems = carriedSummaries.map((summary) => `更早历史摘要：${compactTextLine(summary, options.maxCharsPerItem)}`);

  const summaries = droppedMessages
    .map(summarizeDroppedMessage)
    .filter((summary): summary is string => Boolean(summary));

  const combined = [...carriedItems, ...summaries];
  if (combined.length === 0) {
    return `已移除 ${droppedMessages.length} 条较早消息，以保留最近上下文。`;
  }

  const selected = combined.slice(-options.maxItems);
  const omitted = combined.length - selected.length;
  return [
    `已压缩 ${droppedMessages.length} 条较早消息，保留最近 ${selected.length} 条关键信息：`,
    ...selected.map((summary) => `- ${summary}`),
    ...(omitted > 0 ? [`- 另有 ${omitted} 条更早消息已省略。`] : []),
  ].join("\n");
}

function buildMicroCompactSummary(before: TrimMessage[], after: TrimMessage[], maxItems = 6): string[] {
  const summaries: string[] = [];

  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    const original = before[index];
    const compacted = after[index];
    if (original.role !== compacted.role) continue;
    if (typeof original.content !== "string" || typeof compacted.content !== "string") continue;
    if (original.content === compacted.content) continue;

    const omittedMatch = compacted.content.match(/\.\.\.\[compact: (\d+) chars omitted\]/);
    const omittedChars = omittedMatch?.[1] ?? "部分";
    const snippet = compactTextLine(original.content, 120);
    if (original.role === "tool") {
      summaries.push(`工具结果已截断：${snippet}（省略 ${omittedChars} 字符）`);
    } else if (original.role === "assistant") {
      summaries.push(`较长助手回复已截断：${snippet}（省略 ${omittedChars} 字符）`);
    }
  }

  if (summaries.length <= maxItems) return summaries;
  return [
    ...summaries.slice(0, maxItems),
    `另有 ${summaries.length - maxItems} 条长内容已截断。`,
  ];
}

function joinCompressionSummaries(microSummaries: string[], trimSummary?: string): string | undefined {
  const sections: string[] = [];
  if (trimSummary) sections.push(trimSummary);
  if (microSummaries.length > 0) {
    sections.push([
      "单条长内容压缩：",
      ...microSummaries.map((summary) => `- ${summary}`),
    ].join("\n"));
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

// endregion

/**
 * Trim messages to fit within the context window.
 *
 * Strategy (middle-out, inspired by claude-code-haha):
 * 1. Always keep the system message (first message, role === "system")
 * 2. Reserve `reservedForOutput` tokens for the model's response
 * 3. Keep the most recent messages (they have the most context)
 * 4. For dropped messages, insert a compact summary marker
 * 5. If still over budget, drop oldest messages first
 *
 * Returns the trimmed array (does NOT mutate the original).
 */
export function trimMessagesToContext(
  messages: TrimMessage[],
  contextLimit: number,
  reservedForOutput: number = 8192,
): TrimMessage[] {
  return trimMessagesToContextDetailed(messages, contextLimit, reservedForOutput).messages;
}

export function trimMessagesToContextDetailed(
  messages: TrimMessage[],
  contextLimit: number,
  reservedForOutput: number = 8192,
): ContextTrimResult {
  if (messages.length === 0) {
    return { messages, droppedMessages: [], removedCount: 0 };
  }

  const inputBudget = contextLimit - reservedForOutput;
  if (inputBudget <= 0) {
    return { messages, droppedMessages: [], removedCount: 0 };
  }

  // Always keep the system message
  const systemMsg = messages[0];
  const systemTokens = systemMsg.role === "system" ? estimateMessageTokens(systemMsg) : 0;
  let remaining = inputBudget - systemTokens;
  const originalRest = messages.slice(1);
  const carriedSummaries = originalRest
    .map(extractContextCompressionSummary)
    .filter((summary): summary is string => Boolean(summary));
  const rest = originalRest.filter((message) => !isContextCompressionMarker(message));

  if (remaining <= 0) {
    // Even the system message is too large — return just it
    const droppedMessages = rest;
    return {
      messages: [systemMsg],
      droppedMessages,
      removedCount: originalRest.length,
      markerSummary: buildCompactSummary(droppedMessages, carriedSummaries, { maxItems: 4, maxCharsPerItem: 110 }),
      displaySummary: buildCompactSummary(droppedMessages, carriedSummaries, { maxItems: 8, maxCharsPerItem: 220 }),
    };
  }

  // Build result starting with system message
  const result: TrimMessage[] = [systemMsg];

  // Iterate recent messages in reverse (newest first), accumulate until budget exhausted
  // ── Atomic message pairing ──────────────────────────────────────────
  // A tool result (role: "tool") must be kept together with its parent
  // assistant message (the one with tool_calls that triggered it). Splitting
  // them causes the AI to think a tool call was never answered, causing
  // it to retry indefinitely.
  const kept: TrimMessage[] = [];

  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i];
    const msgTokens = estimateMessageTokens(msg);
    if (msgTokens > remaining) {
      // Budget exceeded — but if this is an assistant message with
      // tool_calls, we must also drop any trailing tool results that
      // belong to it (they're now orphaned). Walk backwards and mark.
      if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // This assistant message has tool_calls. Any tool results after it
        // that reference these calls must also be dropped.
        // Since we're iterating reverse, tool results that were already
        // kept are at the END of `kept`. Remove them.
        const toolCallIds = new Set(
          (msg.tool_calls as Array<{ id?: string }>).map(tc => tc.id).filter(Boolean)
        );
        while (kept.length > 0) {
          const lastKept = kept[kept.length - 1];
          if (lastKept.role === "tool" && lastKept.tool_call_id && toolCallIds.has(lastKept.tool_call_id)) {
            // This tool result belongs to the dropped assistant — remove it
            const refundTokens = estimateMessageTokens(lastKept);
            remaining += refundTokens;
            kept.pop();
          } else {
            break;
          }
        }
      }
      break;
    }
    remaining -= msgTokens;
    kept.unshift(rest[i]);
  }

  const keptSet = new Set(kept);
  const droppedMessages = rest.filter((message) => !keptSet.has(message));
  const removedCount = originalRest.length - kept.length;
  const markerSummary = buildCompactSummary(droppedMessages, carriedSummaries, { maxItems: 4, maxCharsPerItem: 110 });
  const displaySummary = buildCompactSummary(droppedMessages, carriedSummaries, { maxItems: 8, maxCharsPerItem: 220 });

  // Insert a compact summary marker for dropped messages.
  if (markerSummary) {
    const compactMarker: TrimMessage = {
      role: "user",
      content: `[System: 较早对话已压缩。\n${markerSummary}\n请只把这些内容当作历史参考，优先依据当前最新消息继续。]`,
    };
    const markerTokens = estimateMessageTokens(compactMarker);

    if (markerTokens < remaining) {
      result.push(compactMarker);
      remaining -= markerTokens;
    }
  }

  result.push(...kept);

  const totalInputTokens = inputBudget - remaining;
  if (removedCount > 0) {
    console.log(
      `[contextTrim] Middle-out trim: dropped ${removedCount} message(s). ` +
      `Input: ~${totalInputTokens} tokens, Output budget: ${reservedForOutput}, ` +
      `Context limit: ${contextLimit}`
    );
  }

  return { messages: result, droppedMessages, removedCount, markerSummary, displaySummary };
}

/**
 * Compact messages by summarizing tool results that are excessively long.
 * From claude-code-haha's "microcompact" pattern: truncate individual
 * tool results that exceed a per-result token budget.
 *
 * This is applied BEFORE trimMessagesToContext to reduce the total size
 * of messages before they're sent to the model.
 */
export function compactToolResults(
  messages: TrimMessage[],
  maxToolResultTokens: number = 4000,
): TrimMessage[] {
  return messages.map((msg) => {
    // Only compact tool results (which are always string content)
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;

    const tokens = estimateTokens(msg.content);
    if (tokens <= maxToolResultTokens) return msg;

    // Truncate the content
    const maxChars = maxToolResultTokens * 2.5; // reverse of estimateTokens
    const truncated = msg.content.slice(0, Math.floor(maxChars));
    const omittedChars = msg.content.length - truncated.length;

    return {
      ...msg,
      content: truncated + `\n\n...[compact: ${omittedChars} chars omitted]`,
    };
  });
}

/**
 * Compact long assistant messages by truncating them.
 * Assistant messages that describe intent without using tools tend to be
 * verbose; truncating them saves significant context budget.
 */
export function compactAssistantMessages(
  messages: TrimMessage[],
  maxAssistantTokens: number = 1500,
): TrimMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant" || typeof msg.content !== "string") return msg;
    // Don't truncate assistant messages that have tool_calls — they contain
    // structured data the model needs to reference.
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return msg;

    const tokens = estimateTokens(msg.content);
    if (tokens <= maxAssistantTokens) return msg;

    const maxChars = maxAssistantTokens * 2.5;
    const truncated = msg.content.slice(0, Math.floor(maxChars));
    const omittedChars = msg.content.length - truncated.length;

    return {
      ...msg,
      content: truncated + `\n\n...[compact: ${omittedChars} chars omitted]`,
    };
  });
}

export interface ManageContextResult {
  messages: TrimMessage[];
  droppedCount: number;
  changed: boolean;
  tokenCountBefore: number;
  tokenCountAfter: number;
  tokenReduction: number;
  budgets: ContextBudgets;
  compressedContext?: string;
}

/**
 * Full context management pipeline.
 * Applies compaction then trimming, matching claude-code-haha's layered approach:
 *   1. Microcompact tool results (truncate individual large tool results)
 *   2. Microcompact assistant messages (truncate long prose-only responses)
 *   3. Middle-out trim (drop oldest messages, keep summary marker)
 */
export function manageContext(
  messages: TrimMessage[],
  contextLimit: number,
  reservedForOutput?: number,
  maxToolResultTokens: number = 4000,
  maxAssistantTokens: number = 1500,
  forceManage: boolean = false,
): ManageContextResult {
  const budgets = computeContextBudgets(contextLimit, reservedForOutput);
  const tokenCountBefore = estimateMessagesTokens(messages);
  const shouldManage = forceManage || tokenCountBefore > budgets.proactiveTriggerBudget;

  if (!shouldManage) {
    return {
      messages,
      droppedCount: 0,
      changed: false,
      tokenCountBefore,
      tokenCountAfter: tokenCountBefore,
      tokenReduction: 0,
      budgets,
    };
  }

  // Step 1: Compact oversized tool results
  const compacted = compactToolResults(messages, maxToolResultTokens);

  // Step 2: Compact verbose assistant messages
  const assistantCompacted = compactAssistantMessages(compacted, maxAssistantTokens);
  const microSummaries = buildMicroCompactSummary(messages, assistantCompacted);

  // Step 3: Trim with hysteresis. When we cross the proactive trigger,
  // compact down to a lower target budget so we don't re-trigger every turn.
  const compactedTokenCount = estimateMessagesTokens(assistantCompacted);
  const shouldTrim = compactedTokenCount > budgets.proactiveTriggerBudget;
  const trimContextLimit = shouldTrim
    ? budgets.proactiveTargetBudget + budgets.outputBudget
    : budgets.contextLimit;
  const trimResult = shouldTrim
    ? trimMessagesToContextDetailed(assistantCompacted, trimContextLimit, budgets.outputBudget)
    : { messages: assistantCompacted, droppedMessages: [], removedCount: 0 };
  const trimmed = trimResult.messages;

  const actualDropped = trimResult.removedCount;
  const tokenCountAfter = estimateMessagesTokens(trimmed);

  return {
    messages: trimmed,
    droppedCount: actualDropped,
    changed: !messagesEqual(messages, trimmed),
    tokenCountBefore,
    tokenCountAfter,
    tokenReduction: Math.max(0, tokenCountBefore - tokenCountAfter),
    budgets,
    compressedContext: joinCompressionSummaries(microSummaries, trimResult.displaySummary),
  };
}
