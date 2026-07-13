import {
  buildContextMemoryState,
  formatContextMemoryPacket,
  type ContextMemoryMessage,
} from "./contextMemory";
import { compactContextForExecuteRecovery, type TrimMessage } from "./contextTrim";
import { looksLikeSyntheticContinuationText } from "./syntheticContinuation";
import type {
  GoalContinuationMessage,
  GoalContinuationState,
  GoalContinuationToolCall,
} from "./goalState";

export const GOAL_CONTINUATION_CONTROL_PREFIX = "[goal_continuation";

const MAX_CONTINUATION_MESSAGES = 72;
const MAX_CONTINUATION_CHARS = 120_000;
const MAX_USER_MESSAGE_CHARS = 8_000;
const MAX_ASSISTANT_MESSAGE_CHARS = 16_000;
const MAX_TOOL_MESSAGE_CHARS = 20_000;
const MAX_TOOL_ARGUMENT_CHARS = 16_000;
const MAX_ASSISTANT_CONTEXT_CHARS = 4_000;
const MAX_CONTINUATION_MEMORY_CHARS = 6_000;
const MAX_MEMORY_CONCLUSIONS = 6;
const MEMORY_CONCLUSIONS_HEADING = "Retained model conclusions:";

interface ContinuationMessageLike {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

function compactMiddle(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= maxChars) return text;
  const marker = "\n...[continuation content compacted]...\n";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.floor(available * 0.65);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (available - head))}`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text") return String(candidate.text || "");
      return candidate.type === "image_url" || candidate.type === "input_image"
        ? "[image retained in the original Goal source context]"
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeToolCalls(value: unknown): GoalContinuationToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const id = String(candidate.id || "").trim();
    const name = String(candidate.function?.name || "").trim();
    if (!id || !name) return [];
    return [{
      id,
      type: "function" as const,
      function: {
        name,
        arguments: compactMiddle(candidate.function?.arguments || "{}", MAX_TOOL_ARGUMENT_CHARS),
      },
    }];
  });
  return calls.length > 0 ? calls : undefined;
}

export function isGoalContinuationControlText(value: unknown): boolean {
  const text = String(value || "").trim();
  return text.startsWith(GOAL_CONTINUATION_CONTROL_PREFIX)
    || /^(?:Execute bounded goal slice|执行有界目标切片)\s+\d+\/\d+/i.test(text);
}

function sanitizeContinuationMessages(messages: ContinuationMessageLike[]): GoalContinuationMessage[] {
  const normalized = messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") return [];
    const role = message.role;
    const rawContent = contentToText(message.content);
    if (role === "user" && (
      isGoalContinuationControlText(rawContent)
      || looksLikeSyntheticContinuationText(rawContent)
    )) return [];
    const maxChars = role === "user"
      ? MAX_USER_MESSAGE_CHARS
      : role === "assistant"
        ? MAX_ASSISTANT_MESSAGE_CHARS
        : MAX_TOOL_MESSAGE_CHARS;
    const content = compactMiddle(rawContent, maxChars);
    const toolCalls = role === "assistant" ? normalizeToolCalls(message.tool_calls) : undefined;
    const toolCallId = role === "tool" ? String(message.tool_call_id || "").trim() : "";
    if (!content && !toolCalls?.length) return [];
    if (role === "tool" && !toolCallId) return [];
    return [{
      role,
      content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    } satisfies GoalContinuationMessage];
  });

  const resultIds = new Set(
    normalized
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => message.tool_call_id as string),
  );
  const parentIds = new Set<string>();
  const withCompleteCalls = normalized.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return message;
    const completeCalls = message.tool_calls.filter((call) => resultIds.has(call.id));
    completeCalls.forEach((call) => parentIds.add(call.id));
    return {
      ...message,
      ...(completeCalls.length > 0 ? { tool_calls: completeCalls } : { tool_calls: undefined }),
    };
  });

  return withCompleteCalls.filter((message) =>
    message.role !== "tool" || !!message.tool_call_id && parentIds.has(message.tool_call_id)
  );
}

function continuationChars(messages: GoalContinuationMessage[]): number {
  return messages.reduce((total, message) =>
    total
      + message.content.length
      + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0), 0);
}

function readPriorMemoryConclusions(memoryPacket: string | undefined): string[] {
  const text = String(memoryPacket || "");
  const start = text.lastIndexOf(MEMORY_CONCLUSIONS_HEADING);
  if (start < 0) return [];
  return text
    .slice(start + MEMORY_CONCLUSIONS_HEADING.length)
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_MEMORY_CONCLUSIONS);
}

function buildContinuationMemoryPacket(input: {
  messages: GoalContinuationMessage[];
  previous?: GoalContinuationState | null;
}): string | undefined {
  const memoryMessages: ContextMemoryMessage[] = [
    ...(input.previous?.memoryPacket
      ? [{ role: "user" as const, content: input.previous.memoryPacket }]
      : []),
    ...input.messages,
  ];
  const structuredMemory = formatContextMemoryPacket(
    buildContextMemoryState(memoryMessages),
    4_200,
  );
  const conclusionCandidates = [
    ...readPriorMemoryConclusions(input.previous?.memoryPacket),
    ...input.messages
      .filter((message) => message.role === "assistant" && message.content.trim())
      .map((message) => extractGoalAssistantSummary(message.content, 360))
      .filter(Boolean),
  ];
  const seen = new Set<string>();
  const conclusions: string[] = [];
  for (let index = conclusionCandidates.length - 1; index >= 0; index -= 1) {
    const conclusion = conclusionCandidates[index].replace(/\s+/g, " ").trim();
    const key = conclusion.toLowerCase();
    if (!conclusion || seen.has(key)) continue;
    seen.add(key);
    conclusions.unshift(conclusion);
    if (conclusions.length >= MAX_MEMORY_CONCLUSIONS) break;
  }
  const conclusionSection = conclusions.length > 0
    ? `${MEMORY_CONCLUSIONS_HEADING}\n${conclusions.map((conclusion) => `- ${conclusion}`).join("\n")}`
    : "";
  const combined = [structuredMemory, conclusionSection].filter(Boolean).join("\n");
  return combined ? compactMiddle(combined, MAX_CONTINUATION_MEMORY_CHARS) : undefined;
}

function compactOversizedContinuation(messages: GoalContinuationMessage[]): GoalContinuationMessage[] {
  const latestPlainAssistantMessages = messages
    .filter((message) => message.role === "assistant" && !message.tool_calls?.length && message.content.trim())
    .slice(-3);
  const compacted = compactContextForExecuteRecovery(
    [{ role: "system", content: "Goal continuation transport" }, ...messages] as TrimMessage[],
    {
      maxMessages: MAX_CONTINUATION_MESSAGES,
      maxToolResultMessages: 24,
      maxToolChars: 72_000,
      maxToolCallGroups: 16,
      maxToolResultTokens: 2_000,
      latestUserMessages: 4,
    },
  ).messages;
  const sanitized = sanitizeContinuationMessages(compacted as ContinuationMessageLike[]);
  const fingerprints = new Set(sanitized.map((message) => `${message.role}:${message.content}`));
  for (const message of latestPlainAssistantMessages) {
    const fingerprint = `${message.role}:${message.content}`;
    if (!fingerprints.has(fingerprint)) sanitized.push(message);
  }
  let bounded = sanitizeContinuationMessages(sanitized.slice(-MAX_CONTINUATION_MESSAGES));
  while (
    bounded.length > 1
    && (bounded.length > MAX_CONTINUATION_MESSAGES || continuationChars(bounded) > MAX_CONTINUATION_CHARS)
  ) {
    bounded = sanitizeContinuationMessages(bounded.slice(1));
  }
  return bounded;
}

export function createGoalContinuationState(input: {
  messages: ContinuationMessageLike[];
  sourceIteration: number;
  previous?: GoalContinuationState | null;
  now?: number;
}): GoalContinuationState {
  const messageCountBefore = input.messages.length;
  const sanitized = sanitizeContinuationMessages(input.messages);
  const needsCompaction = sanitized.length > MAX_CONTINUATION_MESSAGES
    || continuationChars(sanitized) > MAX_CONTINUATION_CHARS;
  const messages = needsCompaction ? compactOversizedContinuation(sanitized) : sanitized;
  const memoryPacket = buildContinuationMemoryPacket({ messages, previous: input.previous });
  return {
    sourceIteration: Math.max(0, Math.floor(Number(input.sourceIteration) || 0)),
    updatedAt: input.now ?? Date.now(),
    messages,
    memoryPacket: memoryPacket || input.previous?.memoryPacket,
    messageCountBefore,
    compacted: needsCompaction || input.previous?.compacted === true,
    operationCount: messages.filter((message) => message.role === "tool").length,
  };
}

export function restoreGoalContinuationMessages(
  state: GoalContinuationState | null | undefined,
): GoalContinuationMessage[] {
  return sanitizeContinuationMessages(Array.isArray(state?.messages) ? state.messages : []);
}

export function buildGoalContinuationPrompt(input: {
  language: "zh" | "en";
  goalId: string;
  continuationIndex: number;
}): string {
  const index = Math.max(1, Math.floor(Number(input.continuationIndex) || 1));
  const body = input.language === "en"
    ? [
        "Continue the same persistent goal and logical task.",
        "Reuse the retained conversation, completed tool results, checkpoint, and evidence. Do not restart discovery or repeat an operation unless newer workspace evidence makes it necessary.",
        "Choose the next unfinished, verifiable action. The runtime will decide completion from evidence.",
      ]
    : [
        "继续同一个持续目标和同一个逻辑任务。",
        "复用已保留的对话、已完成工具结果、检查点和证据；除非工作区出现更新证据，不要重新开始探索或重复已经做过的操作。",
        "选择下一个尚未完成且可验证的行动；最终完成由运行时根据证据判定。",
      ];
  return [
    `[goal_continuation goal_id="${String(input.goalId || "goal").replace(/"/g, "")}" index="${index}"]`,
    ...body,
    "[/goal_continuation]",
  ].join("\n");
}

function assistantParagraphScore(value: string, index: number): number {
  const concreteReferences = (
    value.match(/(?:`[^`\n]{2,}`|(?:^|\s)[\w.-]+\/[\w./-]+|\bL?\d{1,5}(?:[-:]\d{1,5})?\b)/g) || []
  ).length;
  const structuralDetail = (value.match(/[:：=()[\]{}]/g) || []).length;
  return concreteReferences * 10 + Math.min(12, structuralDetail) + Math.min(12, value.length / 60) + index / 100;
}

export function extractGoalAssistantSummary(value: unknown, maxChars = 500): string {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const candidates = [...text.split(/\n{2,}/), ...text.split("\n")]
    .map((part) => part
      .replace(/^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/, "")
      .replace(/\b(?:GOAL_COMPLETION_CANDIDATE|GOAL_COMPLETED)\b/gi, "")
      .trim())
    .filter((part) =>
      part.length >= 12
      && !/^#{1,6}\s/.test(part)
      && !isGoalContinuationControlText(part)
    );
  if (candidates.length === 0) return compactMiddle(text, maxChars);
  const best = candidates
    .map((candidate, index) => ({ candidate, score: assistantParagraphScore(candidate, index) }))
    .sort((left, right) => right.score - left.score)[0]?.candidate || candidates[candidates.length - 1];
  return compactMiddle(best, maxChars);
}

export function compactGoalAssistantContext(value: unknown): string {
  const text = String(value || "")
    .replace(/\b(?:GOAL_COMPLETION_CANDIDATE|GOAL_COMPLETED)\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return compactMiddle(text, MAX_ASSISTANT_CONTEXT_CHARS);
}
