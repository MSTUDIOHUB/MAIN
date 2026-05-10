// lib/contextTrim.ts
// Trims conversation history to fit within the model's context window.
//
// Inspired by claude-code-haha's multi-layered context management:
//   - Snip: explicit marker-based truncation
//   - Middle-out: drop old messages but keep system + recent
//   - Compact: summarize old messages instead of just dropping them
// ────────────────────────────────────────────────────────────────────

import {
  buildContextMemoryState,
  contextMemoryContentToText,
  formatContextMemoryPacket,
  injectContextMemoryMessage,
  isContextMemoryMessage,
  type ContextMemoryState,
} from "./contextMemory";
import { looksLikeSyntheticContinuationText } from "./syntheticContinuation";

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

export type ContextTokenSource =
  | "system"
  | "user"
  | "assistantVisible"
  | "assistantToolCalls"
  | "toolResult"
  | "compressionMarker"
  | "multimodal"
  | "toolSchema"
  | "thoughtUi";

export interface ContextTokenBreakdown {
  system: number;
  user: number;
  assistantVisible: number;
  assistantToolCalls: number;
  toolResult: number;
  compressionMarker: number;
  multimodal: number;
  toolSchema: number;
  thoughtUi: number;
  total: number;
  topSource: ContextTokenSource;
  topSourceTokens: number;
  topSourceLabel: string;
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

const TOKEN_SOURCE_LABELS: Record<ContextTokenSource, string> = {
  system: "system prompt",
  user: "user/context messages",
  assistantVisible: "assistant visible replies",
  assistantToolCalls: "assistant tool calls",
  toolResult: "tool results",
  compressionMarker: "compression memory",
  multimodal: "images/multimodal parts",
  toolSchema: "tool schema reserve",
  thoughtUi: "thought UI only",
};

function estimateTextAndImageTokens(content: string | TrimContentPart[]): { text: number; image: number } {
  if (typeof content === "string") return { text: estimateTokens(content), image: 0 };
  let text = 0;
  let image = 0;
  for (const part of content) {
    if (part.type === "text") {
      text += estimateTokens(part.text);
    } else if (part.type === "image_url") {
      image += 1000;
    }
  }
  return { text, image };
}

export function computeContextTokenBreakdown(messages: TrimMessage[]): ContextTokenBreakdown {
  const breakdown: Record<ContextTokenSource, number> = {
    system: 0,
    user: 0,
    assistantVisible: 0,
    assistantToolCalls: 0,
    toolResult: 0,
    compressionMarker: 0,
    multimodal: 0,
    toolSchema: 0,
    thoughtUi: 0,
  };

  for (const message of messages) {
    const { text, image } = estimateTextAndImageTokens(message.content);
    const overhead = 10;
    breakdown.multimodal += image;

    if (message.role === "system") {
      breakdown.system += text + overhead;
    } else if (message.role === "tool") {
      breakdown.toolResult += text + overhead;
    } else if (message.role === "assistant") {
      breakdown.assistantVisible += text + overhead;
      if (message.tool_calls && Array.isArray(message.tool_calls)) {
        breakdown.assistantToolCalls += estimateTokens(JSON.stringify(message.tool_calls));
      }
    } else if (isContextCompressionMarker(message)) {
      breakdown.compressionMarker += text + overhead;
    } else {
      breakdown.user += text + overhead;
    }
  }

  const entries = Object.entries(breakdown) as Array<[ContextTokenSource, number]>;
  const [topSource, topSourceTokens] = entries.reduce(
    (best, current) => current[1] > best[1] ? current : best,
    ["user", 0] as [ContextTokenSource, number],
  );
  const total = entries.reduce((sum, [, tokens]) => sum + tokens, 0);

  return {
    ...breakdown,
    total,
    topSource,
    topSourceTokens,
    topSourceLabel: TOKEN_SOURCE_LABELS[topSource],
  };
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
  return isContextMemoryMessage(message);
}

function extractContextCompressionSummary(message: TrimMessage): string | undefined {
  if (!isContextCompressionMarker(message)) return undefined;
  const lines = contextMemoryContentToText(message.content)
    .replace(/^\[System:\s*/, "")
    .replace(/\]$/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "ContextState")
    .filter((line) => line !== "较早对话已压缩。")
    .filter((line) => line !== "Earlier context has been summarized — you have all essential information to continue.")
    .filter((line) => line !== "请只把这些内容当作历史参考，优先依据当前最新消息继续。")
    .filter((line) => !/^Use this as compact historical state only/i.test(line));

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

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeStateLine(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:、"'“”‘’`*_~\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUnique(lines: string[], value: string | null | undefined, maxItems: number, maxChars: number): void {
  const compacted = compactTextLine(String(value || ""), maxChars);
  if (!compacted) return;
  const key = normalizeStateLine(compacted);
  if (!key || lines.some((line) => normalizeStateLine(line) === key)) return;
  if (lines.length < maxItems) lines.push(compacted);
}

function parseJsonObject(text: unknown): Record<string, unknown> {
  if (!text || typeof text !== "string") return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readRecordString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

interface ToolCallSummary {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function extractToolCallSummary(toolCall: unknown): ToolCallSummary | null {
  const candidate = toolCall as {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const name =
    typeof candidate.function?.name === "string"
      ? candidate.function.name
      : typeof candidate.name === "string"
      ? candidate.name
      : "";
  const rawArgs =
    typeof candidate.function?.arguments === "string"
      ? candidate.function.arguments
      : typeof candidate.arguments === "string"
      ? candidate.arguments
      : "";
  if (!id && !name) return null;
  return { id, name: name || "tool_call", args: parseJsonObject(rawArgs) };
}

function buildToolCallLookup(messages: TrimMessage[]): Map<string, ToolCallSummary> {
  const lookup = new Map<string, ToolCallSummary>();
  for (const message of messages) {
    if (!message.tool_calls || !Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      const summary = extractToolCallSummary(toolCall);
      if (!summary || !summary.id) continue;
      lookup.set(summary.id, summary);
    }
  }
  return lookup;
}

function stripReasoningAndMarkup(text: string): string {
  return String(text || "")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning|tool_use|tool_call|function_call|tool|parameter|tool_response)(?:\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitUsefulSentences(text: string): string[] {
  const source = stripReasoningAndMarkup(text);
  return (source.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [source])
    .map((part) => part.trim())
    .filter(Boolean);
}

function isSystemContinuationNoise(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("[System:") ||
    /^PLAN_[A-Z_]+:/i.test(trimmed) ||
    /^RecoveryDetails:/i.test(trimmed) ||
    /^Repeated read-only tool call skipped:/i.test(trimmed) ||
    looksLikeSyntheticContinuationText(trimmed);
}

function extractConstraintCandidates(text: string): string[] {
  return splitUsefulSentences(text).filter((sentence) =>
    /(?:必须|不要|不能|禁止|只(?:能|保存)|保留|避免|优先|假设|约束|must|never|do not|don't|only|preserve|avoid|assumption|constraint|requirement)/i.test(sentence)
  );
}

function extractDecisionCandidates(text: string): string[] {
  return splitUsefulSentences(text).filter((sentence) =>
    /(?:批准|确认|选择|决定|已批准|已确认|approved|confirmed|selected|decided|plan approved)/i.test(sentence)
  );
}

function extractCheckboxTasks(text: string): { total: number; completed: number; next: string[] } {
  const matches = Array.from(String(text || "").matchAll(/^\s*[-*]\s+\[([ xX-])\]\s+(.+)$/gm));
  let completed = 0;
  const next: string[] = [];
  for (const match of matches) {
    const status = match[1] || " ";
    const taskText = compactTextLine(match[2] || "", 180);
    if (/x/i.test(status)) {
      completed += 1;
    } else if (next.length < 4) {
      next.push(taskText);
    }
  }
  return { total: matches.length, completed, next };
}

function extractRecoveryDetails(text: string): { failure?: string; next?: string } {
  if (!/RecoveryDetails:|Detected a repetition loop/i.test(text)) return {};
  const duplicateTool = text.match(/duplicateTool:\s*([^\n]+)/i)?.[1]?.trim();
  const target = text.match(/target:\s*([^\n]+)/i)?.[1]?.trim();
  const duplicateCount = text.match(/duplicateCount:\s*([^\n]+)/i)?.[1]?.trim();
  const suggestedNextTask = text.match(/suggestedNextTask:\s*([^\n]+)/i)?.[1]?.trim();
  const failure = [
    duplicateTool ? `duplicateTool=${duplicateTool}` : "",
    target ? `target=${target}` : "",
    duplicateCount ? `duplicateCount=${duplicateCount}` : "",
  ].filter(Boolean).join(", ");
  return {
    failure: failure ? `repeat loop: ${failure}` : compactTextLine(text, 180),
    next: suggestedNextTask,
  };
}

function summarizeToolResult(message: TrimMessage, lookup: Map<string, ToolCallSummary>): string | null {
  if (message.role !== "tool" || typeof message.content !== "string") return null;
  const tool = message.tool_call_id ? lookup.get(message.tool_call_id) : undefined;
  const name = tool?.name || "tool";
  const args = tool?.args || {};
  const target = readRecordString(args, ["path", "target", "file", "cwd", "workspace"]) ||
    readRecordString(args, ["command", "cmd", "query", "pattern"]);
  const content = message.content;
  const contentHash = stableHash(content).slice(0, 8);
  const baseTarget = target ? ` ${compactTextLine(target, 120)}` : "";

  if (/read_file|get_file_outline|grep_search|glob_search|list_directory/i.test(name)) {
    return `${name}${baseTarget} (${content.length.toLocaleString()} chars, hash ${contentHash})`;
  }

  if (/write_file|replace_in_file|delete_workspace_path/i.test(name)) {
    const noOp = /"noOp"\s*:\s*true|No file change|matched the current file/i.test(content);
    const status = /error|failed|rejected/i.test(content) ? "failed" : noOp ? "no-op" : "changed";
    return `${name}${baseTarget} (${status}, result hash ${contentHash})`;
  }

  if (/execute_command|run_command|send_pty_input|read_pty_tail|read_pty_since|get_pty_status/i.test(name)) {
    const exitCode = content.match(/(?:exitCode|exit code|code)\D+(-?\d+)/i)?.[1];
    const command = readRecordString(args, ["command", "cmd"]);
    return `${name}${command ? ` ${compactTextLine(command, 120)}` : baseTarget}${exitCode ? ` (exit ${exitCode})` : ` (${content.length.toLocaleString()} chars, hash ${contentHash})`}`;
  }

  return `${name}${baseTarget} (${content.length.toLocaleString()} chars, hash ${contentHash})`;
}

function extractCarriedStateLines(carriedSummaries: string[], maxItems: number, maxChars: number): string[] {
  const lines: string[] = [];
  for (const summary of carriedSummaries) {
    const cleaned = String(summary || "")
      .replace(/^\[?System:\s*/i, "")
      .replace(/^ContextState[^\n]*\n?/i, "")
      .replace(/请只把这些内容当作历史参考[\s\S]*$/i, "")
      .replace(/Use this as compact historical state only[\s\S]*$/i, "");
    for (const line of cleaned.split(/\r?\n/)) {
      const trimmed = line.replace(/^\s*[-*]\s*/, "").trim();
      if (!trimmed) continue;
      if (/^(Dropped|Token pressure|已压缩|单条长内容压缩|另有)/i.test(trimmed)) continue;
      if (looksLikeSyntheticContinuationText(trimmed)) continue;
      pushUnique(lines, trimmed, maxItems, maxChars);
    }
  }
  return lines;
}

function buildCompactSummary(
  droppedMessages: TrimMessage[],
  carriedSummaries: string[],
  options: CompressionSummaryOptions,
): string | undefined {
  const sourceMessages = droppedMessages.filter((message) => !isContextCompressionMarker(message));
  const lookup = buildToolCallLookup(sourceMessages);
  const goals: string[] = [];
  const constraints: string[] = [];
  const decisions: string[] = [];
  const tasks: string[] = [];
  const evidence: string[] = [];
  const failures: string[] = [];
  const nextSteps: string[] = [];
  const carryover = extractCarriedStateLines(carriedSummaries, Math.min(3, options.maxItems), options.maxCharsPerItem);
  let taskTotal = 0;
  let taskCompleted = 0;

  for (const message of sourceMessages) {
    const text = messageContentToText(message.content);
    if (!text.trim()) continue;

    const recovery = extractRecoveryDetails(text);
    pushUnique(failures, recovery.failure, Math.min(4, options.maxItems), options.maxCharsPerItem);
    pushUnique(nextSteps, recovery.next, Math.min(4, options.maxItems), options.maxCharsPerItem);

    const taskSnapshot = extractCheckboxTasks(text);
    if (taskSnapshot.total > taskTotal) {
      taskTotal = taskSnapshot.total;
      taskCompleted = taskSnapshot.completed;
      tasks.length = 0;
      taskSnapshot.next.forEach((task) => pushUnique(tasks, task, Math.min(4, options.maxItems), options.maxCharsPerItem));
    }

    if (message.role === "user" && !isSystemContinuationNoise(text) && !looksLikeSyntheticContinuationText(text)) {
      pushUnique(goals, text, Math.min(3, options.maxItems), options.maxCharsPerItem);
      extractConstraintCandidates(text).forEach((item) => pushUnique(constraints, item, Math.min(5, options.maxItems), options.maxCharsPerItem));
      extractDecisionCandidates(text).forEach((item) => pushUnique(decisions, item, Math.min(4, options.maxItems), options.maxCharsPerItem));
    } else if (message.role === "tool") {
      pushUnique(evidence, summarizeToolResult(message, lookup), Math.min(8, options.maxItems + 2), options.maxCharsPerItem);
      if (/error|failed|rejected|Detected a repetition loop/i.test(text)) {
        pushUnique(failures, text, Math.min(4, options.maxItems), options.maxCharsPerItem);
      }
    }
  }

  const lines = [
    `ContextState: compressed ${droppedMessages.length} older message(s) into state-first memory; recent messages remain verbatim.`,
  ];
  if (goals.length) lines.push(`- Goal: ${goals.slice(-2).join(" | ")}`);
  if (constraints.length) lines.push(`- Constraints: ${constraints.join(" | ")}`);
  if (decisions.length) lines.push(`- Decisions: ${decisions.join(" | ")}`);
  if (taskTotal > 0) {
    lines.push(`- Plan tasks: ${taskCompleted}/${taskTotal} completed${tasks.length ? `; next ${tasks.join(" | ")}` : ""}`);
  } else if (tasks.length) {
    lines.push(`- Plan tasks: ${tasks.join(" | ")}`);
  }
  if (evidence.length) lines.push(`- Evidence: ${evidence.join(" | ")}`);
  if (failures.length) lines.push(`- Recent failures/blockers: ${failures.join(" | ")}`);
  if (nextSteps.length) lines.push(`- Next: ${nextSteps.join(" | ")}`);
  if (carryover.length) lines.push(`- Earlier state carried forward: ${carryover.join(" | ")}`);
  if (lines.length === 1) {
    lines.push("- Preserved: no durable goal/evidence was found in the removed span; continue from the latest visible messages.");
  }
  return lines.join("\n");
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
    if (original.role === "tool") {
      summaries.push(`Tool result compacted: original ${original.content.length.toLocaleString()} chars, omitted ${omittedChars} chars.`);
    } else if (original.role === "assistant") {
      summaries.push(`Assistant reply compacted: original ${original.content.length.toLocaleString()} chars, omitted ${omittedChars} chars.`);
    }
  }

  if (summaries.length <= maxItems) return summaries;
  return [
    ...summaries.slice(0, maxItems),
    `另有 ${summaries.length - maxItems} 条长内容已截断。`,
  ];
}

function formatTokenPressureSummary(breakdown: ContextTokenBreakdown): string {
  if (breakdown.total <= 0) return "";
  return `Token pressure: ${breakdown.topSourceLabel} ~${breakdown.topSourceTokens.toLocaleString()} tokens (largest source).`;
}

function joinCompressionSummaries(
  microSummaries: string[],
  trimSummary?: string,
  tokenBreakdown?: ContextTokenBreakdown,
): string | undefined {
  const sections: string[] = [];
  if (trimSummary) sections.push(trimSummary);
  const pressureSummary = tokenBreakdown ? formatTokenPressureSummary(tokenBreakdown) : "";
  if (pressureSummary) sections.push(pressureSummary);
  if (microSummaries.length > 0) {
    sections.push([
      "Single-message compaction:",
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
  const contextMarkers = originalRest.filter(isContextCompressionMarker);
  const pinnedContextMarker = contextMarkers[contextMarkers.length - 1] || null;
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
  let pinnedMarkerKept = false;
  if (pinnedContextMarker) {
    const markerTokens = estimateMessageTokens(pinnedContextMarker);
    if (markerTokens < remaining) {
      result.push(pinnedContextMarker);
      remaining -= markerTokens;
      pinnedMarkerKept = true;
    }
  }

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

  let keptForResult = [...kept];
  let keptSet = new Set(keptForResult);
  let droppedMessages = rest.filter((message) => !keptSet.has(message));
  let markerSummary = buildCompactSummary(droppedMessages, carriedSummaries, { maxItems: 4, maxCharsPerItem: 110 });
  let displaySummary = buildCompactSummary(droppedMessages, carriedSummaries, { maxItems: 8, maxCharsPerItem: 220 });
  let compactMarker: TrimMessage | null = !pinnedMarkerKept && markerSummary
    ? {
        role: "user",
        content: `[System: ContextState\n${markerSummary}\nUse this as compact historical state only; prioritize the latest messages and current workspace evidence.]`,
      }
    : null;
  let markerTokens = compactMarker ? estimateMessageTokens(compactMarker) : 0;

  // Prefer keeping a compact state marker over one more older raw message; the
  // marker is what lets future turns recover goals, constraints, and evidence.
  while (compactMarker && markerTokens >= remaining && keptForResult.length > 0) {
    const removed = keptForResult.shift();
    if (!removed) break;
    remaining += estimateMessageTokens(removed);
    if (removed.role === "assistant" && removed.tool_calls && Array.isArray(removed.tool_calls)) {
      const removedToolCallIds = new Set(
        (removed.tool_calls as Array<{ id?: string }>).map((toolCall) => toolCall.id).filter(Boolean),
      );
      while (
        keptForResult.length > 0 &&
        keptForResult[0]?.role === "tool" &&
        keptForResult[0]?.tool_call_id &&
        removedToolCallIds.has(keptForResult[0].tool_call_id)
      ) {
        const orphanedToolResult = keptForResult.shift();
        if (!orphanedToolResult) break;
        remaining += estimateMessageTokens(orphanedToolResult);
      }
    }
    keptSet = new Set(keptForResult);
    droppedMessages = rest.filter((message) => !keptSet.has(message));
    markerSummary = buildCompactSummary(droppedMessages, carriedSummaries, { maxItems: 4, maxCharsPerItem: 110 });
    displaySummary = buildCompactSummary(droppedMessages, carriedSummaries, { maxItems: 8, maxCharsPerItem: 220 });
    compactMarker = !pinnedMarkerKept && markerSummary
      ? {
          role: "user",
          content: `[System: ContextState\n${markerSummary}\nUse this as compact historical state only; prioritize the latest messages and current workspace evidence.]`,
        }
      : null;
    markerTokens = compactMarker ? estimateMessageTokens(compactMarker) : 0;
  }

  if (compactMarker && markerTokens < remaining) {
    result.push(compactMarker);
    remaining -= markerTokens;
  }

  result.push(...keptForResult);
  const removedCount = droppedMessages.length;

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
  droppedMessageCount: number;
  changed: boolean;
  tokenCountBefore: number;
  tokenCountAfter: number;
  tokenReduction: number;
  tokenBreakdownBefore: ContextTokenBreakdown;
  tokenBreakdownAfter: ContextTokenBreakdown;
  retainedTokenBreakdown: ContextTokenBreakdown;
  budgets: ContextBudgets;
  compressedContext?: string;
  displaySummary?: string;
  memoryState: ContextMemoryState;
  memoryPacket: string;
  microCompactionKind: "none" | "tool_results" | "assistant_messages" | "mixed";
  microCompactedCount: number;
}

export interface ManageContextOptions {
  previousMemoryState?: ContextMemoryState | null;
  turnId?: string | null;
  now?: number;
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
  options: ManageContextOptions = {},
): ManageContextResult {
  const budgets = computeContextBudgets(contextLimit, reservedForOutput);
  const memoryState = buildContextMemoryState(messages, {
    previous: options.previousMemoryState,
    turnId: options.turnId,
    now: options.now,
  });
  const memoryPacket = formatContextMemoryPacket(memoryState);
  const messagesWithMemory = injectContextMemoryMessage(messages, memoryState) as TrimMessage[];
  const tokenCountBefore = estimateMessagesTokens(messagesWithMemory);
  const tokenBreakdownBefore = computeContextTokenBreakdown(messagesWithMemory);
  const shouldManage = forceManage || tokenCountBefore > budgets.proactiveTriggerBudget;

  if (!shouldManage) {
    const changed = !messagesEqual(messages, messagesWithMemory);
    return {
      messages: messagesWithMemory,
      droppedCount: 0,
      droppedMessageCount: 0,
      changed,
      tokenCountBefore,
      tokenCountAfter: tokenCountBefore,
      tokenReduction: 0,
      tokenBreakdownBefore,
      tokenBreakdownAfter: tokenBreakdownBefore,
      retainedTokenBreakdown: tokenBreakdownBefore,
      budgets,
      compressedContext: memoryPacket,
      displaySummary: undefined,
      memoryState,
      memoryPacket,
      microCompactionKind: "none",
      microCompactedCount: 0,
    };
  }

  // Step 1: Compact oversized tool results
  const compacted = compactToolResults(messagesWithMemory, maxToolResultTokens);

  // Step 2: Compact verbose assistant messages
  const assistantCompacted = compactAssistantMessages(compacted, maxAssistantTokens);
  const microSummaries = buildMicroCompactSummary(messagesWithMemory, assistantCompacted);
  let toolMicroCompacted = 0;
  let assistantMicroCompacted = 0;
  for (let index = 0; index < Math.min(messagesWithMemory.length, assistantCompacted.length); index += 1) {
    const before = messagesWithMemory[index];
    const after = assistantCompacted[index];
    if (before.role !== after.role) continue;
    if (typeof before.content !== "string" || typeof after.content !== "string") continue;
    if (before.content === after.content) continue;
    if (before.role === "tool") toolMicroCompacted += 1;
    if (before.role === "assistant") assistantMicroCompacted += 1;
  }
  const microCompactedCount = toolMicroCompacted + assistantMicroCompacted;
  const microCompactionKind =
    toolMicroCompacted > 0 && assistantMicroCompacted > 0
      ? "mixed"
      : toolMicroCompacted > 0
        ? "tool_results"
        : assistantMicroCompacted > 0
          ? "assistant_messages"
          : "none";

  // Step 3: Trim with hysteresis. When we cross the proactive trigger,
  // compact down to a lower target budget so we don't re-trigger every turn.
  const compactedTokenCount = estimateMessagesTokens(assistantCompacted);
  const shouldTrim = forceManage || compactedTokenCount > budgets.proactiveTriggerBudget;
  const trimContextLimit = shouldTrim
    ? budgets.proactiveTargetBudget + budgets.outputBudget
    : budgets.contextLimit;
  const trimResult = shouldTrim
    ? trimMessagesToContextDetailed(assistantCompacted, trimContextLimit, budgets.outputBudget)
    : { messages: assistantCompacted, droppedMessages: [], removedCount: 0 };
  const trimmed = trimResult.messages;

  const actualDropped = trimResult.removedCount;
  const tokenCountAfter = estimateMessagesTokens(trimmed);
  const tokenBreakdownAfter = computeContextTokenBreakdown(trimmed);
  const displaySummary = joinCompressionSummaries(microSummaries, trimResult.displaySummary, tokenBreakdownBefore);

  return {
    messages: trimmed,
    droppedCount: actualDropped,
    droppedMessageCount: actualDropped,
    changed: !messagesEqual(messages, trimmed),
    tokenCountBefore,
    tokenCountAfter,
    tokenReduction: Math.max(0, tokenCountBefore - tokenCountAfter),
    tokenBreakdownBefore,
    tokenBreakdownAfter,
    retainedTokenBreakdown: tokenBreakdownAfter,
    budgets,
    compressedContext: displaySummary || memoryPacket,
    displaySummary,
    memoryState,
    memoryPacket,
    microCompactionKind,
    microCompactedCount,
  };
}
