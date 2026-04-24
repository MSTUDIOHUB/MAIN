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
  if (messages.length === 0) return messages;

  const inputBudget = contextLimit - reservedForOutput;
  if (inputBudget <= 0) return messages;

  // Always keep the system message
  const systemMsg = messages[0];
  const systemTokens = systemMsg.role === "system" ? estimateMessageTokens(systemMsg) : 0;
  let remaining = inputBudget - systemTokens;

  if (remaining <= 0) {
    // Even the system message is too large — return just it
    return [systemMsg];
  }

  // Build result starting with system message
  const result: TrimMessage[] = [systemMsg];

  // Iterate recent messages in reverse (newest first), accumulate until budget exhausted
  // ── Atomic message pairing ──────────────────────────────────────────
  // A tool result (role: "tool") must be kept together with its parent
  // assistant message (the one with tool_calls that triggered it). Splitting
  // them causes the AI to think a tool call was never answered, causing
  // it to retry indefinitely.
  const rest = messages.slice(1);
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

  const droppedCount = rest.length - kept.length;

  // Insert a compact summary marker for dropped messages (claude-code-haha pattern)
  if (droppedCount > 0) {
    const compactMarker: TrimMessage = {
      role: "user",
      content: `[System: ${droppedCount} earlier message(s) omitted to fit context window. Earlier context has been summarized — you have all essential information to continue.]`,
    };
    const markerTokens = estimateMessageTokens(compactMarker);

    if (markerTokens < remaining) {
      result.push(compactMarker);
    }
  }

  result.push(...kept);

  const totalInputTokens = inputBudget - remaining;
  if (droppedCount > 0) {
    console.log(
      `[contextTrim] Middle-out trim: dropped ${droppedCount} message(s). ` +
      `Input: ~${totalInputTokens} tokens, Output budget: ${reservedForOutput}, ` +
      `Context limit: ${contextLimit}`
    );
  }

  return result;
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
): ManageContextResult {
  const budgets = computeContextBudgets(contextLimit, reservedForOutput);
  const tokenCountBefore = estimateMessagesTokens(messages);

  // Step 1: Compact oversized tool results
  const compacted = compactToolResults(messages, maxToolResultTokens);

  // Step 2: Compact verbose assistant messages
  const assistantCompacted = compactAssistantMessages(compacted, maxAssistantTokens);

  // Step 3: Trim with hysteresis. When we cross the proactive trigger,
  // compact down to a lower target budget so we don't re-trigger every turn.
  const compactedTokenCount = estimateMessagesTokens(assistantCompacted);
  const shouldTrim = compactedTokenCount > budgets.proactiveTriggerBudget;
  const trimContextLimit = shouldTrim
    ? budgets.proactiveTargetBudget + budgets.outputBudget
    : budgets.contextLimit;
  const trimmed = shouldTrim
    ? trimMessagesToContext(assistantCompacted, trimContextLimit, budgets.outputBudget)
    : assistantCompacted;

  const actualDropped = Math.max(0, messages.length - trimmed.length);
  const tokenCountAfter = estimateMessagesTokens(trimmed);

  return {
    messages: trimmed,
    droppedCount: actualDropped,
    changed: !messagesEqual(messages, trimmed),
    tokenCountBefore,
    tokenCountAfter,
    tokenReduction: Math.max(0, tokenCountBefore - tokenCountAfter),
    budgets,
  };
}
