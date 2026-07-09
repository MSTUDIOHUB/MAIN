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
  reasoning_content?: string;
  reasoning?: string;
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
  if (msg.role === "assistant") {
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
      tokens += estimateTokens(msg.reasoning_content);
    }
    if (typeof msg.reasoning === "string" && msg.reasoning) {
      tokens += estimateTokens(msg.reasoning);
    }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: TrimMessage[]): number {
  return messages.filter(Boolean).reduce((total, msg) => total + estimateMessageTokens(msg), 0);
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

  const validMessages = messages.filter(Boolean);
  for (const message of validMessages) {
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
      if (typeof message.reasoning_content === "string" && message.reasoning_content) {
        breakdown.assistantVisible += estimateTokens(message.reasoning_content);
      }
      if (typeof message.reasoning === "string" && message.reasoning) {
        breakdown.assistantVisible += estimateTokens(message.reasoning);
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
    ?? Math.min(8192, Math.max(4096, Math.floor(contextLimit * 0.2)));
  const inputBudget = Math.max(0, contextLimit - outputBudget);
  return {
    contextLimit,
    outputBudget,
    inputBudget,
    proactiveTriggerBudget: Math.floor(inputBudget * 0.75),
    proactiveTargetBudget: Math.floor(inputBudget * 0.75),
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
      msg.reasoning_content === other.reasoning_content &&
      msg.reasoning === other.reasoning &&
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

  if (/read_file|get_file_outline|grep_search|glob_search|list_directory|repo_map_/i.test(name)) {
    return `${name}${baseTarget} (${content.length.toLocaleString()} chars, hash ${contentHash})`;
  }

  if (/write_file|replace_in_file|apply_patch|delete_workspace_path/i.test(name)) {
    const noOp = /"noOp"\s*:\s*true|No file change|matched the current file/i.test(content);
    const status = /error|failed|rejected/i.test(content) ? "failed" : noOp ? "no-op" : "changed";
    return `${name}${baseTarget} (${status}, result hash ${contentHash})`;
  }

  if (/execute_command|run_command|browser_evaluate|send_pty_input|read_pty_tail|read_pty_since|get_pty_status/i.test(name)) {
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

    const omittedMatch = compacted.content.match(/\.\.\.\[compact: (\d+) chars omitted[^\]]*\]/);
    const omittedChars = omittedMatch?.[1] ?? "部分";
    const omittedNumber = omittedMatch ? Number(omittedMatch[1]) : 0;
    const savedChars = original.content.length - compacted.content.length;
    if (omittedNumber > 0 && savedChars > 0 && omittedNumber < 256 && savedChars < original.content.length * 0.05) {
      continue;
    }
    if (original.role === "tool") {
      const readPath = compacted.content.match(/^path:\s*(.+)$/m)?.[1]
        || compacted.content.match(/^READ_FILE_SUMMARY\s+path:\s*(.+)$/m)?.[1]
        || "";
      const targetSuffix = readPath ? ` (${readPath.trim()})` : "";
      summaries.push(`Tool result compacted${targetSuffix}: original ${original.content.length.toLocaleString()} chars, omitted ${omittedChars} chars.`);
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

  const lastUserRestIdx = rest.map((m) => m.role).lastIndexOf("user");
  const mustKeepRestIdx = lastUserRestIdx !== -1 ? lastUserRestIdx : rest.length - 1;

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
    const isMustKeep = i >= mustKeepRestIdx;
    if (!isMustKeep && msgTokens > remaining) {
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

  const mustKeepCount = rest.length - mustKeepRestIdx;
  while (compactMarker && markerTokens >= remaining && keptForResult.length > mustKeepCount) {
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
  if (removedCount > 0 && typeof window !== "undefined") {
    console.log(
      `[contextTrim] Middle-out trim: dropped ${removedCount} message(s). ` +
      `Input: ~${totalInputTokens} tokens, Output budget: ${reservedForOutput}, ` +
      `Context limit: ${contextLimit}`
    );
  }

  return { messages: result, droppedMessages, removedCount, markerSummary, displaySummary };
}

function compactOneLine(text: string, maxChars = 180): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function collectReadFileSignalLines(body: string, maxChars: number): string {
  const signalRe = /\b(?:export|function|const|let|class|interface|type|return|if|for|while|useEffect|useMemo|rawOrders|filteredOrders|setOrders|load|csv|order|course|revenue|status|theme|dark|chart|echarts|paidAmount|completedTime|localStorage|ConfigProvider)\b/i;
  const lines = body.split(/\r?\n/);
  const picked: string[] = [];
  let chars = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] || "";
    if (!signalRe.test(rawLine)) continue;
    const line = `L${index + 1}: ${compactOneLine(rawLine, 180)}`;
    if (picked.includes(line)) continue;
    const nextChars = chars + line.length + 1;
    if (nextChars > maxChars && picked.length > 0) break;
    picked.push(line);
    chars = nextChars;
    if (picked.length >= 14) break;
  }
  return picked.join("\n");
}

function takeHead(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trimEnd();
}

function takeTail(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars).trimStart();
}

function compactReadFileToolResultContent(content: string, maxToolResultTokens: number): string | null {
  if (!/\bREAD_FILE_RESULT\b/.test(content) || !/---CONTENT START---/.test(content)) return null;

  const startMarker = "---CONTENT START---";
  const endMarker = "---CONTENT END---";
  const startIndex = content.indexOf(startMarker);
  if (startIndex < 0) return null;
  const bodyStart = startIndex + startMarker.length;
  const endIndex = content.indexOf(endMarker, bodyStart);
  const beforeContent = content.slice(0, startIndex).trimEnd();
  const body = (endIndex >= 0 ? content.slice(bodyStart, endIndex) : content.slice(bodyStart)).trim();
  if (!body) return null;

  const maxChars = Math.max(900, Math.floor(maxToolResultTokens * 2.5));
  const excerptBudget = Math.max(700, Math.min(2200, Math.floor(maxChars * 0.48)));
  const headBudget = Math.max(260, Math.floor(excerptBudget * 0.36));
  const signalBudget = Math.max(260, Math.floor(excerptBudget * 0.34));
  const tailBudget = Math.max(180, excerptBudget - headBudget - signalBudget);
  const path = beforeContent.match(/^path:\s*(.+)$/m)?.[1]?.trim() || "unknown";
  const metadataLines = beforeContent
    .split(/\r?\n/)
    .filter((line) =>
      /^(?:\[MAIN_TOOL_FEEDBACK_V1\]|READ_FILE_RESULT|path:|truncated:|totalLines:|totalChars:|returnedLines:|returnedChars:|nextStartLine:|nextRead:|note:)/.test(line)
    );
  const metadata = metadataLines.join("\n") || beforeContent.slice(0, 900);
  const head = takeHead(body, headBudget);
  const signals = collectReadFileSignalLines(body, signalBudget);
  const tail = takeTail(body, tailBudget);
  const sections = [
    metadata,
    `READ_FILE_SUMMARY path: ${path}`,
    "---COMPACTED CONTENT HEAD---",
    head,
    signals ? "---COMPACTED SIGNAL LINES---" : "",
    signals,
    tail && tail !== head ? "---COMPACTED CONTENT TAIL---" : "",
    tail && tail !== head ? tail : "",
  ].filter(Boolean);
  let compacted = sections.join("\n");
  const omittedChars = Math.max(0, content.length - compacted.length);
  compacted += `\n\n...[compact: ${omittedChars} chars omitted from read_file content]`;
  if (compacted.length >= content.length - 128) return null;
  return compacted;
}

/**
 * Compact messages by summarizing tool results that are excessively long.
 * Read-file results keep structured metadata and evidence excerpts; other
 * tool results fall back to bounded truncation.
 *
 * This is applied BEFORE trimMessagesToContext to reduce the total size
 * of messages before they're sent to the model.
 */
export function compactToolResults(
  messages: TrimMessage[],
  maxToolResultTokens: number = 4000,
  ephemeralItemIds?: Set<string>,
): TrimMessage[] {
  const totalMsgs = messages.length;
  return messages.map((msg, index) => {
    // Only compact tool results (which are always string content)
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;

    // Do NOT compact recent tool outputs (retained in recent conversation window)
    // to preserve exact file contents for code edits and prevent LLM re-read loops
    const isRecentTool = index >= totalMsgs - 8;
    if (isRecentTool) return msg;

    // Check if this tool message is marked ephemeral
    const isEphemeral = msg.tool_call_id && ephemeralItemIds && ephemeralItemIds.has(msg.tool_call_id);
    const targetLimit = isEphemeral ? Math.min(maxToolResultTokens, 800) : maxToolResultTokens;

    const tokens = estimateTokens(msg.content);
    if (tokens <= targetLimit) return msg;

    const compactedReadFile = compactReadFileToolResultContent(msg.content, targetLimit);
    if (compactedReadFile) {
      return {
        ...msg,
        content: compactedReadFile,
      };
    }

    // Truncate the content
    const maxChars = targetLimit * 2.5; // reverse of estimateTokens
    const truncated = msg.content.slice(0, Math.floor(maxChars));
    const omittedChars = msg.content.length - truncated.length;

    return {
      ...msg,
      content: truncated + `\n\n...[compact: ${omittedChars} chars omitted${isEphemeral ? " from ephemeral source" : ""}]`,
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

/**
 * Locate and replace obsolete read results with lightweight stubs once a file has been successfully mutated.
 */
export function activeMemoryReclamation(messages: TrimMessage[]): TrimMessage[] {
  const validMessages = messages.filter(Boolean);
  const toolCallMap = new Map<string, { name: string; path: string }>();
  const successfulMutations = new Set<string>();

  // 1. Build a map of tool call IDs to tool name and target path.
  for (const msg of validMessages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const call = tc as { id?: string; function?: { name?: string; arguments?: string } };
        if (call.id && call.function?.name && call.function.arguments) {
          try {
            const parsed = JSON.parse(call.function.arguments);
            const name = call.function.name;
            let path = "";
            if (typeof parsed.path === "string") {
              path = parsed.path.trim();
            } else if (typeof parsed.TargetFile === "string") {
              path = parsed.TargetFile.trim();
            }
            if (path) {
              toolCallMap.set(call.id, { name, path });
            }
          } catch {
            // Ignore JSON parsing issues
          }
        }
      }
    }
  }

  // 2. Identify successfully mutated paths.
  for (const msg of validMessages) {
    if (msg.role === "tool" && msg.tool_call_id && typeof msg.content === "string") {
      const callInfo = toolCallMap.get(msg.tool_call_id);
      if (callInfo && (callInfo.name === "write_file" || callInfo.name === "replace_in_file")) {
        const isSuccess = /success|written successfully|updated successfully|already matched/i.test(msg.content);
        if (isSuccess && callInfo.path) {
          successfulMutations.add(callInfo.path);
        }
      }
    }
  }

  if (successfulMutations.size === 0) {
    return validMessages;
  }

  // 3. Prune historical tool read contents for successfully mutated paths.
  return validMessages.map((msg) => {
    if (msg.role === "tool" && msg.tool_call_id && typeof msg.content === "string") {
      const callInfo = toolCallMap.get(msg.tool_call_id);
      if (callInfo && callInfo.name === "read_file" && callInfo.path && successfulMutations.has(callInfo.path)) {
        if (msg.content.length > 200) {
          return {
            ...msg,
            content: `[System: Historical read content of ${callInfo.path} removed; file was successfully mutated in a later turn]`,
          };
        }
      }
    }
    return msg;
  });
}

// ── System Message Compaction ──────────────────────────────────────────
// Prevents hook context messages (SessionStart, UserPromptSubmit, PostToolUse)
// from bloating the system role to 86k+ chars.

/** Compact a group of system messages sharing the same [HookContext:XXX] prefix. */
function compactSystemGroup(prefix: string, messages: TrimMessage[]): TrimMessage {
  const parts: string[] = [];
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : "";
    // Strip the [HookContext:XXX] prefix to get the raw content
    const raw = content.replace(/^\[HookContext:\S+\]\s*/, "");
    if (raw) parts.push(raw);
  }
  return {
    role: "system",
    content: `[HookContext:${prefix || "Unknown"}] ${parts.join("\n---\n")}`,
  };
}

function isTrimMessageLike(value: unknown): value is TrimMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<TrimMessage>;
  if (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") {
    return false;
  }
  return typeof message.content === "string" || Array.isArray(message.content);
}

function sanitizeTrimMessages(
  messages: TrimMessage[],
  source: string,
): { messages: TrimMessage[]; invalidDropped: number } {
  const sanitized: TrimMessage[] = [];
  let invalidDropped = 0;
  for (const message of messages as unknown[]) {
    if (isTrimMessageLike(message)) {
      sanitized.push(message);
    } else {
      invalidDropped += 1;
    }
  }
  if (invalidDropped > 0) {
    try {
      console.info("[agent.context_trim_invalid_message_dropped]", {
        source,
        invalidDropped,
        inputCount: Array.isArray(messages) ? messages.length : 0,
        outputCount: sanitized.length,
      });
    } catch {
      // Diagnostics must never affect context management.
    }
  }
  return { messages: sanitized, invalidDropped };
}

function getSystemMessageGroupKey(message: TrimMessage): string {
  const content = typeof message.content === "string" ? message.content : "";
  const match = content.match(/^\[HookContext:(\S+?)\]\s*/);
  return match ? match[1] : "SupplementalSystem";
}

function systemMessageChars(messages: TrimMessage[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== "system") return sum;
    return sum + (typeof message.content === "string" ? message.content.length : 0);
  }, 0);
}

export interface SystemCompactionResult {
  messages: TrimMessage[];
  systemCharsBefore: number;
  systemCharsAfter: number;
  systemDropped: number;
  invalidDropped: number;
  compactedSystemGroups: number;
}

/**
 * Compact excessive `role: "system"` messages (typically hook context injectors).
 * - Always preserves the first system message (main prompt) at index 0.
 * - Groups remaining system messages by their `[HookContext:XXX]` event name.
 * - Each group is collapsed into a single message, truncated to a per-group budget.
 * - If total system chars still exceed the budget, drops oldest groups first.
 *
 * Default maxTotalSystemChars: 24000 characters.
 */
export function compactSystemMessages(
  messages: TrimMessage[],
  maxTotalSystemChars: number = 24000,
): SystemCompactionResult {
  const sanitized = sanitizeTrimMessages(messages, "compactSystemMessages");
  const validMessages = sanitized.messages;
  if (validMessages.length === 0) {
    return {
      messages: validMessages,
      systemCharsBefore: 0,
      systemCharsAfter: 0,
      systemDropped: 0,
      invalidDropped: sanitized.invalidDropped,
      compactedSystemGroups: 0,
    };
  }

  const systemCharsBefore = systemMessageChars(validMessages);

  // Always keep the first system message (main prompt)
  const mainSystem = validMessages[0].role === "system" ? validMessages[0] : null;
  const systemGroups = new Map<string, TrimMessage[]>();
  const groupOrder: string[] = [];

  for (let i = 1; i < validMessages.length; i += 1) {
    const msg = validMessages[i];
    if (msg.role === "system") {
      const key = getSystemMessageGroupKey(msg);
      if (!systemGroups.has(key)) {
        systemGroups.set(key, []);
        groupOrder.push(key);
      }
      systemGroups.get(key)?.push(msg);
    }
  }

  if (systemGroups.size === 0) {
    return {
      messages: validMessages,
      systemCharsBefore,
      systemCharsAfter: systemCharsBefore,
      systemDropped: 0,
      invalidDropped: sanitized.invalidDropped,
      compactedSystemGroups: 0,
    };
  }

  const compactedByGroup = new Map<string, TrimMessage>();
  const perGroupBudget = Math.max(512, Math.floor(maxTotalSystemChars / Math.max(1, systemGroups.size)));
  for (const key of groupOrder) {
    const groupMsgs = systemGroups.get(key) || [];
    const compacted = compactSystemGroup(key, groupMsgs);
    // Truncate content to per-group budget
    if (typeof compacted.content === "string" && compacted.content.length > perGroupBudget) {
      compacted.content = compacted.content.slice(0, perGroupBudget) + "... [truncated]";
    }
    compactedByGroup.set(key, compacted);
  }

  const mainSystemChars = mainSystem && typeof mainSystem.content === "string" ? mainSystem.content.length : 0;
  let runningSystemChars = mainSystemChars;
  const keptGroups = new Set<string>();
  for (const key of groupOrder) {
    const compacted = compactedByGroup.get(key);
    if (!compacted) continue;
    const chars = typeof compacted.content === "string" ? compacted.content.length : 0;
    if (runningSystemChars + chars <= maxTotalSystemChars || keptGroups.size === 0 && !mainSystem) {
      keptGroups.add(key);
      runningSystemChars += chars;
    }
  }

  const resultMessages: TrimMessage[] = [];
  const emittedGroups = new Set<string>();
  for (const msg of validMessages) {
    if (msg.role === "system" && msg === mainSystem) {
      resultMessages.push(msg);
    } else if (msg.role === "system") {
      const key = getSystemMessageGroupKey(msg);
      if (keptGroups.has(key) && !emittedGroups.has(key)) {
        const compacted = compactedByGroup.get(key);
        if (compacted) resultMessages.push(compacted);
        emittedGroups.add(key);
      }
    } else {
      resultMessages.push(msg);
    }
  }

  const systemCharsAfter = systemMessageChars(resultMessages);

  return {
    messages: resultMessages,
    systemCharsBefore,
    systemCharsAfter,
    systemDropped: Math.max(0, groupOrder.length - keptGroups.size),
    invalidDropped: sanitized.invalidDropped,
    compactedSystemGroups: keptGroups.size,
  };
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
  invalidDropped: number;
  systemCompactedGroups: number;
}

export interface ManageContextOptions {
  previousMemoryState?: ContextMemoryState | null;
  turnId?: string | null;
  now?: number;
}

export interface ExecuteRecoveryContextCompactOptions extends ManageContextOptions {
  maxMessages?: number;
  maxToolResultMessages?: number;
  maxToolChars?: number;
  maxToolCallGroups?: number;
  maxToolResultTokens?: number;
  latestUserMessages?: number;
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
  options: ManageContextOptions & { ephemeralItemIds?: Set<string> } = {},
): ManageContextResult {
  const sanitized = sanitizeTrimMessages(messages, "manageContext");
  const validMessages = sanitized.messages;
  const reclaimedMessages = activeMemoryReclamation(validMessages);

  // Pre-compact excessive system messages (hook context injectors) before memory injection
  const systemCompacted = compactSystemMessages(reclaimedMessages);
  const preMemoryMessages = systemCompacted.messages;
  const budgets = computeContextBudgets(contextLimit, reservedForOutput);
  const memoryState = buildContextMemoryState(preMemoryMessages, {
    previous: options.previousMemoryState,
    turnId: options.turnId,
    now: options.now,
  });
  const memoryPacket = formatContextMemoryPacket(memoryState);
  const messagesWithMemory = injectContextMemoryMessage(preMemoryMessages, memoryState) as TrimMessage[];
  const tokenCountBefore = estimateMessagesTokens(messagesWithMemory);
  const tokenBreakdownBefore = computeContextTokenBreakdown(messagesWithMemory);
  const shouldManage = forceManage || tokenCountBefore > budgets.proactiveTriggerBudget;

  if (!shouldManage) {
    const changed = sanitized.invalidDropped > 0 || systemCompacted.invalidDropped > 0 || !messagesEqual(validMessages, messagesWithMemory);
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
      invalidDropped: sanitized.invalidDropped + systemCompacted.invalidDropped,
      systemCompactedGroups: systemCompacted.compactedSystemGroups,
    };
  }

  // Step 1: Compact oversized tool results
  const compacted = compactToolResults(messagesWithMemory, maxToolResultTokens, options.ephemeralItemIds);

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
    changed: sanitized.invalidDropped > 0 || systemCompacted.invalidDropped > 0 || !messagesEqual(validMessages, trimmed),
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
    invalidDropped: sanitized.invalidDropped + systemCompacted.invalidDropped,
    systemCompactedGroups: systemCompacted.compactedSystemGroups,
  };
}

function getToolCallIdsFromMessage(message: TrimMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls
    .map((toolCall) => {
      const candidate = toolCall as { id?: unknown };
      return typeof candidate.id === "string" ? candidate.id : "";
    })
    .filter(Boolean);
}

function sumToolContentChars(messages: TrimMessage[], indices: Iterable<number>): number {
  let total = 0;
  for (const index of indices) {
    const message = messages[index];
    if (message?.role !== "tool" || typeof message.content !== "string") continue;
    total += message.content.length;
  }
  return total;
}

function collectRecentCompleteToolGroupIndices(input: {
  messages: TrimMessage[];
  maxGroups: number;
  maxToolResults: number;
  maxToolChars: number;
}): Set<number> {
  const groups: Array<{ indices: number[]; toolCount: number; toolChars: number; lastIndex: number }> = [];

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    const toolCallIds = getToolCallIdsFromMessage(message);
    if (toolCallIds.length === 0) continue;

    const expected = new Set(toolCallIds);
    const groupIndices = [index];
    let toolCount = 0;
    let toolChars = 0;
    let lastIndex = index;
    for (let scan = index + 1; scan < input.messages.length; scan += 1) {
      const candidate = input.messages[scan];
      if (!candidate) continue;
      if (candidate.role === "assistant" && getToolCallIdsFromMessage(candidate).length > 0) break;
      if (candidate.role !== "tool" || !candidate.tool_call_id || !expected.has(candidate.tool_call_id)) continue;
      groupIndices.push(scan);
      toolCount += 1;
      toolChars += typeof candidate.content === "string" ? candidate.content.length : 0;
      lastIndex = scan;
    }

    if (toolCount === 0) continue;
    groups.push({ indices: groupIndices, toolCount, toolChars, lastIndex });
  }

  const keep = new Set<number>();
  let keptGroups = 0;
  let keptToolResults = 0;
  let keptToolChars = 0;
  for (const group of groups.sort((a, b) => b.lastIndex - a.lastIndex)) {
    if (keptGroups >= input.maxGroups) break;
    const wouldExceedResults = keptToolResults + group.toolCount > input.maxToolResults;
    const wouldExceedChars = keptToolChars + group.toolChars > input.maxToolChars;
    if (keptGroups > 0 && (wouldExceedResults || wouldExceedChars)) continue;
    for (const index of group.indices) keep.add(index);
    keptGroups += 1;
    keptToolResults += group.toolCount;
    keptToolChars += group.toolChars;
  }

  return keep;
}

function collectLatestUserMessageIndices(messages: TrimMessage[], maxItems: number): Set<number> {
  const keep = new Set<number>();
  for (let index = messages.length - 1; index >= 0 && keep.size < maxItems; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || isContextMemoryMessage(message)) continue;
    keep.add(index);
  }
  return keep;
}

function trimKeptIndicesToMessageLimit(indices: Set<number>, messages: TrimMessage[], maxMessages: number): Set<number> {
  if (indices.size <= maxMessages) return indices;
  const systemIndices = [...indices].filter((index) => messages[index]?.role === "system");
  const userIndices = [...indices].filter((index) => messages[index]?.role === "user").sort((a, b) => b - a);
  const remaining = [...indices]
    .filter((index) => messages[index]?.role !== "system" && messages[index]?.role !== "user")
    .sort((a, b) => b - a);
  const next = new Set<number>();
  for (const index of systemIndices) next.add(index);
  for (const index of userIndices) {
    if (next.size >= maxMessages) break;
    next.add(index);
  }
  for (const index of remaining) {
    if (next.size >= maxMessages) break;
    next.add(index);
  }
  return next;
}

function normalizeKeptToolPairs(indices: Set<number>, messages: TrimMessage[]): Set<number> {
  const next = new Set(indices);
  let changed = true;
  while (changed) {
    changed = false;
    for (const index of [...next]) {
      const message = messages[index];
      if (!message) {
        next.delete(index);
        changed = true;
        continue;
      }
      if (message.role === "assistant") {
        const ids = getToolCallIdsFromMessage(message);
        if (ids.length === 0) continue;
        const hasAllResults = ids.every((id) =>
          [...next].some((candidateIndex) => {
            const candidate = messages[candidateIndex];
            return candidate?.role === "tool" && candidate.tool_call_id === id;
          })
        );
        if (hasAllResults) continue;
        next.delete(index);
        for (const candidateIndex of [...next]) {
          const candidate = messages[candidateIndex];
          if (candidate?.role === "tool" && candidate.tool_call_id && ids.includes(candidate.tool_call_id)) {
            next.delete(candidateIndex);
          }
        }
        changed = true;
        continue;
      }
      if (message.role === "tool" && message.tool_call_id) {
        const hasParent = [...next].some((candidateIndex) =>
          getToolCallIdsFromMessage(messages[candidateIndex]).includes(message.tool_call_id || "")
        );
        if (!hasParent) {
          next.delete(index);
          changed = true;
        }
      }
    }
  }
  return next;
}

export function compactContextForExecuteRecovery(
  messages: TrimMessage[],
  options: ExecuteRecoveryContextCompactOptions = {},
): ManageContextResult {
  const maxMessages = Math.max(8, options.maxMessages ?? 36);
  const maxToolResultMessages = Math.max(1, options.maxToolResultMessages ?? 12);
  const maxToolChars = Math.max(1000, options.maxToolChars ?? 12_000);
  const maxToolCallGroups = Math.max(1, options.maxToolCallGroups ?? 6);
  const latestUserMessages = Math.max(1, options.latestUserMessages ?? 2);
  const maxToolResultTokens = Math.max(120, options.maxToolResultTokens ?? 360);

  const memoryState = buildContextMemoryState(messages, {
    previous: options.previousMemoryState,
    turnId: options.turnId,
    now: options.now,
  });
  const memoryPacket = formatContextMemoryPacket(memoryState);
  const withoutMemory = messages.filter((message) => !isContextMemoryMessage(message));
  const compacted = compactToolResults(withoutMemory, maxToolResultTokens);
  const tokenCountBefore = estimateMessagesTokens(messages);
  const tokenBreakdownBefore = computeContextTokenBreakdown(messages);

  const keepIndices = new Set<number>();
  if (compacted[0]?.role === "system") keepIndices.add(0);
  for (const index of collectLatestUserMessageIndices(compacted, latestUserMessages)) keepIndices.add(index);
  for (const index of collectRecentCompleteToolGroupIndices({
    messages: compacted,
    maxGroups: maxToolCallGroups,
    maxToolResults: maxToolResultMessages,
    maxToolChars,
  })) {
    keepIndices.add(index);
  }

  let boundedKeepIndices = normalizeKeptToolPairs(
    trimKeptIndicesToMessageLimit(keepIndices, compacted, Math.max(1, maxMessages - 1)),
    compacted,
  );
  while (sumToolContentChars(compacted, boundedKeepIndices) > maxToolChars && boundedKeepIndices.size > 1) {
    const oldestToolIndex = [...boundedKeepIndices]
      .filter((index) => compacted[index]?.role === "tool")
      .sort((a, b) => a - b)[0];
    if (oldestToolIndex == null) break;
    const toolCallId = compacted[oldestToolIndex]?.tool_call_id;
    boundedKeepIndices.delete(oldestToolIndex);
    if (toolCallId) {
      for (const index of [...boundedKeepIndices]) {
        const ids = getToolCallIdsFromMessage(compacted[index]);
        if (ids.includes(toolCallId)) boundedKeepIndices.delete(index);
      }
    }
    boundedKeepIndices = normalizeKeptToolPairs(boundedKeepIndices, compacted);
  }

  const keptMessages = [...boundedKeepIndices]
    .sort((a, b) => a - b)
    .map((index) => compacted[index])
    .filter(Boolean);
  const withMemory = injectContextMemoryMessage(keptMessages as TrimMessage[], memoryState) as TrimMessage[];
  const finalMessages = withMemory.length > maxMessages
    ? trimMessagesToContextDetailed(withMemory, estimateMessagesTokens(withMemory), 0).messages.slice(0, maxMessages)
    : withMemory;

  const tokenCountAfter = estimateMessagesTokens(finalMessages);
  const tokenBreakdownAfter = computeContextTokenBreakdown(finalMessages);
  const droppedMessageCount = Math.max(0, messages.length - finalMessages.length);
  const toolCharsAfter = sumToolContentChars(finalMessages, finalMessages.map((_message, index) => index));
  const displaySummary = [
    `Execute recovery context compacted: kept ${finalMessages.length}/${messages.length} messages.`,
    `Tool results retained: ${finalMessages.filter((message) => message.role === "tool").length}; tool chars retained: ${toolCharsAfter.toLocaleString()}.`,
    "Older transcript is represented by ContextState memory to prevent read-loop replay.",
  ].join("\n");

  let microCompactedCount = 0;
  for (let index = 0; index < Math.min(withoutMemory.length, compacted.length); index += 1) {
    const before = withoutMemory[index];
    const after = compacted[index];
    if (before?.role === "tool" && after?.role === "tool" && typeof before.content === "string" && typeof after.content === "string" && before.content !== after.content) {
      microCompactedCount += 1;
    }
  }

  return {
    messages: finalMessages,
    droppedCount: droppedMessageCount,
    droppedMessageCount,
    changed: !messagesEqual(messages, finalMessages),
    tokenCountBefore,
    tokenCountAfter,
    tokenReduction: Math.max(0, tokenCountBefore - tokenCountAfter),
    tokenBreakdownBefore,
    tokenBreakdownAfter,
    retainedTokenBreakdown: tokenBreakdownAfter,
    budgets: computeContextBudgets(Math.max(tokenCountBefore, tokenCountAfter), 0),
    compressedContext: displaySummary,
    displaySummary,
    memoryState,
    memoryPacket,
    microCompactionKind: microCompactedCount > 0 ? "tool_results" : "none",
    microCompactedCount,
    invalidDropped: 0,
    systemCompactedGroups: 0,
  };
}
