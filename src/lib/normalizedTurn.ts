// lib/normalizedTurn.ts
// 将不同模型、不同输出格式统一整理成前端可消费的标准结构。

import { parseTextForTools } from "./textToolParser";
import { extractReplyOptions, normalizeReplyOptionLabel, normalizeReplyOptionValue } from "./replyOptions";
import { sanitizeVisibleAssistantText } from "./sanitize";
import type { StreamResult } from "./streaming";
import type { NormalizedStreamState, NormalizedToolCall, ReplyOption } from "./workflowModels";

// region: 推理文本提取

export const SYNTHETIC_VISIBLE_CONCLUSION =
  "后台思考已折叠，模型尚未生成可见回复或可执行动作。";

export function isSyntheticVisibleConclusion(text: string): boolean {
  return String(text || "").replace(/\s+/g, " ").trim() === SYNTHETIC_VISIBLE_CONCLUSION;
}

export const REASONING_TAG_RE = /<(?:analysis|thought|thinking|reasoning|think)(?:\s[^>]*)?>([\s\S]*?)<\/(?:analysis|thought|thinking|reasoning|think)>/gi;
const LEAKED_REASONING_MARKERS = [
  /^thinking\b/i,
  /^thought\b/i,
  /^analysis\b/i,
  /^reasoning\b/i,
  /^思考[:：]?/i,
  /^分析[:：]?/i,
  /^the user said\b/i,
  /^the user asked\b/i,
  /^the user is\b/i,
  /^user said\b/i,
  /^i should respond\b/i,
  /^i should answer\b/i,
  /^i should\b/i,
  /^i'll keep it\b/i,
  /^this is a simple\b/i,
  /^this is a standard\b/i,
  /^respond in (?:the )?same language\b/i,
  /^keep it friendly\b/i,
  /^match the tone\b/i,
  /^final output generation\b/i,
  /^draft response\b/i,
  /^identify language\b/i,
  /^determine response strategy\b/i,
  /\buser has provided\b/i,
  /\bmy plan is\b/i,
  /\bno tool calls are necessary\b/i,
  /\bi should respond\b/i,
  /\bi should answer\b/i,
  /\brespond in chinese\b/i,
  /\bkeep it friendly\b/i,
  /\bfinal output generation\b/i,
  /\bfalls under\b/i,
  /用户.*提供/i,
  /我的计划是/i,
  /不需要调用工具/i,
  /^用户要求我/i,
  /^The user asked me/i,
];

const STRONG_REASONING_PRELUDE_MARKERS = [
  /^thinking\b[:：]?/i,
  /^thought\b[:：]?/i,
  /^analysis\b[:：]?/i,
  /^reasoning\b[:：]?/i,
  /^思考[:：]?/i,
  /^分析[:：]?/i,
];

const CHOICE_CONTEXT_MARKERS = [
  /<user_options>/i,
  /需要用户(?:确认|选择|决定|拍板)/i,
  /关键(?:选择|分叉|决策)/i,
  /可点击选项/i,
  /请选择/i,
  /请确认/i,
  /请告诉我/i,
  /user choices/i,
  /please choose/i,
  /please confirm/i,
];

const LEAKED_REASONING_TAIL_MARKERS = [
  /^让我(?:输出|总结|这样做|重新理解|再仔细看|直接执行|开始执行|继续)/i,
  /^但是(?:等等|用户|之前|.*用户说)/i,
  /^不过(?:等等|用户|之前)/i,
  /^我认为(?:最合理|应该|这意味着|为)/i,
  /^实际上[,，]?/i,
  /^用户(?:说|要求|可能是在说)/i,
  /^这似乎意味着/i,
  /^之前的消息说/i,
  /^最合理的解释/i,
  /^but wait\b/i,
  /^the user says?\b/i,
  /^i think\b/i,
  /^actually\b/i,
  /^let me (?:summarize|output|reconsider|think|execute|continue)/i,
];

const USER_OPTIONS_TOOL_NAMES = new Set(["user_options", "user_option", "option", "options"]);

/**
 * 提取所有隐藏推理文本，供 ThoughtBlock 折叠展示。
 */
export function extractHiddenThought(text: string): string {
  if (!text.trim()) return "";

  const parts: string[] = [];
  let matched: RegExpExecArray | null;
  while ((matched = REASONING_TAG_RE.exec(text)) !== null) {
    const content = matched[1]?.trim();
    if (content) parts.push(content);
  }

  return parts.join("\n\n").trim();
}

function extractLeakedReasoningPrelude(text: string): { leakedThought: string; visibleText: string } {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return { leakedThought: "", visibleText: text };
  }

  const leaked: string[] = [];
  let firstVisibleIdx = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const isReasoning = LEAKED_REASONING_MARKERS.some((pattern) => pattern.test(paragraph));
    if (!isReasoning) {
      firstVisibleIdx = i;
      break;
    }
    leaked.push(paragraph);
    firstVisibleIdx = i + 1;
  }

  const firstLeakedIsStrongReasoningLabel = leaked.length > 0 &&
    STRONG_REASONING_PRELUDE_MARKERS.some((pattern) => pattern.test(leaked[0] || ""));
  if (leaked.length < 2 && !firstLeakedIsStrongReasoningLabel) {
    return { leakedThought: "", visibleText: text };
  }

  return {
    leakedThought: leaked.join("\n\n").trim(),
    visibleText: paragraphs.slice(firstVisibleIdx).join("\n\n").trim(),
  };
}

function extractLeakedReasoningTail(
  text: string,
  hasReplyOptions: boolean,
): { leakedThought: string; visibleText: string } {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length < 2) {
    return { leakedThought: "", visibleText: text };
  }

  let sawChoiceContext = hasReplyOptions;
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (CHOICE_CONTEXT_MARKERS.some((pattern) => pattern.test(paragraph))) {
      sawChoiceContext = true;
    }

    const isReasoningTail = LEAKED_REASONING_TAIL_MARKERS.some((pattern) => pattern.test(paragraph));
    if (i > 0 && sawChoiceContext && isReasoningTail) {
      return {
        leakedThought: paragraphs.slice(i).join("\n\n").trim(),
        visibleText: paragraphs.slice(0, i).join("\n\n").trim(),
      };
    }
  }

  return { leakedThought: "", visibleText: text };
}

/**
 * 剥离泄漏到可见正文中的推理段落。
 * 复用 LEAKED_REASONING_MARKERS 和 LEAKED_REASONING_TAIL_MARKERS 的模式，
 * 对 sanitizeAssistantDisplayContent 处理后的文本做二次过滤。
 */
export function stripLeakedReasoning(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return text;

  // 剥离前导泄漏推理
  const leakedPrefix: string[] = [];
  let firstVisibleIdx = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const isReasoning = LEAKED_REASONING_MARKERS.some((pattern) => pattern.test(paragraph));
    if (!isReasoning) {
      firstVisibleIdx = i;
      break;
    }
    leakedPrefix.push(paragraph);
    firstVisibleIdx = i + 1;
  }

  // 如果全部段落都是推理，直接返回空
  if (leakedPrefix.length >= paragraphs.length) return "";

  // 剥离尾部泄漏推理（类似 extractLeakedReasoningTail 的逻辑）
  const remaining = paragraphs.slice(firstVisibleIdx);
  let tailCutIdx = remaining.length;
  for (let i = 0; i < remaining.length; i++) {
    const isTailReasoning = LEAKED_REASONING_TAIL_MARKERS.some((pattern) => pattern.test(remaining[i]));
    if (i > 0 && isTailReasoning) {
      tailCutIdx = i;
      break;
    }
  }

  const visible = remaining.slice(0, tailCutIdx);
  return visible.join("\n\n").trim();
}

function normalizeParagraphForLoopDetection(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:、"'“”‘’`*_~\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameParagraphSequence(paragraphs: string[], a: number, b: number, length: number): boolean {
  for (let offset = 0; offset < length; offset++) {
    if (normalizeParagraphForLoopDetection(paragraphs[a + offset] || "") !== normalizeParagraphForLoopDetection(paragraphs[b + offset] || "")) {
      return false;
    }
  }
  return true;
}

function collapseRepeatedParagraphLoops(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length < 4) return text;

  const collapsed: string[] = [];
  let index = 0;
  const maxWindow = 6;

  while (index < paragraphs.length) {
    let matched = false;
    const remaining = paragraphs.length - index;
    const largestWindow = Math.min(maxWindow, Math.floor(remaining / 2));

    for (let windowSize = largestWindow; windowSize >= 1; windowSize--) {
      let repeats = 1;
      while (
        index + (repeats + 1) * windowSize <= paragraphs.length &&
        sameParagraphSequence(paragraphs, index, index + repeats * windowSize, windowSize)
      ) {
        repeats++;
      }

      if (repeats >= 2) {
        collapsed.push(...paragraphs.slice(index, index + windowSize));
        index += repeats * windowSize;
        matched = true;
        break;
      }
    }

    if (!matched) {
      collapsed.push(paragraphs[index]);
      index++;
    }
  }

  return collapsed.join("\n\n");
}

function collapseRepeatedLineLoops(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (lines.length < 6) return text;

  const collapsed: string[] = [];
  let index = 0;
  const maxWindow = 12;

  while (index < lines.length) {
    let matched = false;
    const remaining = lines.length - index;
    const largestWindow = Math.min(maxWindow, Math.floor(remaining / 2));

    for (let windowSize = largestWindow; windowSize >= 1; windowSize--) {
      let repeats = 1;
      while (
        index + (repeats + 1) * windowSize <= lines.length &&
        sameParagraphSequence(lines, index, index + repeats * windowSize, windowSize)
      ) {
        repeats++;
      }

      if (repeats >= 2) {
        collapsed.push(...lines.slice(index, index + windowSize));
        index += repeats * windowSize;
        matched = true;
        break;
      }
    }

    if (!matched) {
      collapsed.push(lines[index]);
      index++;
    }
  }

  return collapsed.join("\n");
}

function compactReasoningNoise(text: string): string {
  return text
    .replace(/(?:[，,。.\-_]\s*){32,}/g, " ... ")
    .replace(/([，,。.!！？?;；:：])(?:\s*\1){6,}/g, "$1...")
    .replace(/(?:\*\s*){16,}/g, "**")
    .replace(/[^\S\r\n]{3,}/g, " ");
}

function compactReasoningText(text: string, maxChars = Number.POSITIVE_INFINITY): string {
  const compacted = compactReasoningNoise(collapseRepeatedLineLoops(collapseRepeatedParagraphLoops(text)));
  if (!Number.isFinite(maxChars) || maxChars <= 0 || compacted.length <= maxChars) {
    return compacted;
  }
  const boundedMax = Math.max(160, Math.floor(maxChars));
  const marker = "\n\n[hidden reasoning compacted]\n\n";
  const retainedBudget = Math.max(80, boundedMax - marker.length);
  const headChars = Math.ceil(retainedBudget * 0.7);
  const tailChars = Math.max(0, retainedBudget - headChars);
  return `${compacted.slice(0, headChars).trimEnd()}${marker}${compacted.slice(-tailChars).trimStart()}`
    .slice(0, boundedMax);
}

// endregion

// region: Tool Call 归一化

function normalizeNativeToolCalls(result: StreamResult): NormalizedToolCall[] {
  return result.toolCalls
    .filter((call) => call.name && call.arguments != null)
    .map((call, index) => ({
      id: call.id?.trim() || `native_call_${index + 1}`,
      name: call.name,
      arguments: call.arguments,
      source: "native" as const,
    }));
}

function normalizeParsedTextToolCalls(parsed: ReturnType<typeof parseTextForTools>): NormalizedToolCall[] {
  return parsed.toolCalls.map((call, index) => ({
    id: call.id?.trim() || `text_call_${index + 1}`,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
    source: "text" as const,
  }));
}

const REVIEW_GATED_TEXT_TOOL_NAMES = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
  "run_command",
  "execute_command",
  "send_pty_input",
  "browser_evaluate",
]);

function looksLikeClarifyingOrPermissionQuestion(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /[?？]\s*$/.test(normalized) ||
    /(?:是否|要不要|可不可以|可以吗|可以么|需要(?:你|您)?确认|请(?:确认|选择|告诉我)|你(?:希望|想要|要不要)|您(?:希望|想要|要不要))/i.test(normalized) ||
    /\b(?:do you want|would you like|should i|shall i|please confirm|please choose|tell me whether)\b/i.test(normalized)
  );
}

function shouldTreatTextToolCallsAsUserQuestion(
  visibleText: string,
  toolCalls: NormalizedToolCall[],
): boolean {
  if (!toolCalls.length) return false;
  if (!looksLikeClarifyingOrPermissionQuestion(visibleText)) return false;
  return toolCalls.some((call) => REVIEW_GATED_TEXT_TOOL_NAMES.has(call.name));
}

function isUserOptionsToolName(name: string): boolean {
  return USER_OPTIONS_TOOL_NAMES.has(name.trim().toLowerCase());
}

function parseToolCallArgumentsObject(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeReplyOptionText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function extractReplyOptionsFromProtocolTool(call: NormalizedToolCall): ReplyOption[] {
  if (!isUserOptionsToolName(call.name)) return [];

  const args = parseToolCallArgumentsObject(call.arguments);
  const rawOptions = Array.isArray(args.options)
    ? args.options
    : Array.isArray(args.choices)
      ? args.choices
      : Array.isArray(args.items)
        ? args.items
        : [];

  return rawOptions
    .map((item): ReplyOption | null => {
      if (typeof item === "string") {
        const text = normalizeReplyOptionText(item);
        return text ? { label: text, value: text, source: "explicit_user_options" } : null;
      }

      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const label = normalizeReplyOptionText(record.label ?? record.title ?? record.text ?? record.value);
      const value = normalizeReplyOptionText(record.value ?? record.text ?? record.label ?? record.title);
      return label && value ? { label, value, source: "explicit_user_options" } : null;
    })
    .filter((option): option is ReplyOption => option != null);
}

function mergeReplyOptions(...groups: ReplyOption[][]): ReplyOption[] {
  const merged: ReplyOption[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const option of group) {
      const value = normalizeReplyOptionValue(option.value || option.label);
      const label = normalizeReplyOptionLabel(option.label || option.value);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      merged.push({ label, value, ...(option.action ? { action: option.action } : {}), ...(option.source ? { source: option.source } : {}) });
    }
  }
  return merged;
}

// endregion

// region: Turn 归一化

/**
 * 统一收敛可见正文 / 隐藏推理 / 工具调用，降低模型差异对 UI 的影响。
 */
export function normalizeAssistantTurn(
  result: StreamResult,
  options: { maxHiddenChars?: number } = {},
): NormalizedStreamState {
  const semanticContent = typeof result.actionableContent === "string"
    ? result.actionableContent
    : typeof result.semanticContent === "string"
    ? result.semanticContent
    : result.content;
  const initialOptions = extractReplyOptions(semanticContent);
  const taggedHiddenThought = extractHiddenThought(result.content);
  const parsed = parseTextForTools(initialOptions.cleanText || "");
  const nativeToolCalls = normalizeNativeToolCalls(result);
  const parsedTextToolCalls = normalizeParsedTextToolCalls(parsed);
  const shouldSuppressTextToolsAsQuestion =
    nativeToolCalls.length === 0 &&
    shouldTreatTextToolCallsAsUserQuestion(parsed.cleanText, parsedTextToolCalls);
  const rawToolCalls = nativeToolCalls.length > 0
    ? nativeToolCalls
    : shouldSuppressTextToolsAsQuestion
    ? []
    : parsedTextToolCalls;
  const protocolToolOptions = rawToolCalls.flatMap(extractReplyOptionsFromProtocolTool);
  const toolCalls = rawToolCalls.filter((call) => !isUserOptionsToolName(call.name));
  const parsedOptions = extractReplyOptions(parsed.cleanText || "");
  const hasExplicitOptions = initialOptions.replyOptions.length > 0 || protocolToolOptions.length > 0;
  const inferredOptions = hasExplicitOptions ? [] : parsedOptions.replyOptions;
  const replyOptions = mergeReplyOptions(initialOptions.replyOptions, inferredOptions, protocolToolOptions);
  const hasExplicitUserChoiceRequest =
    initialOptions.hasExplicitUserOptionsTag ||
    rawToolCalls.some((call) => isUserOptionsToolName(call.name));
  const textWithoutOptions = parsedOptions.cleanText;
  const preSanitizedVisible = collapseRepeatedParagraphLoops(sanitizeVisibleAssistantText(textWithoutOptions))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const leakedPrelude = extractLeakedReasoningPrelude(preSanitizedVisible);
  const leakedTail = extractLeakedReasoningTail(leakedPrelude.visibleText, replyOptions.length > 0);

  const visibleText = leakedTail.visibleText;
  const hiddenThought = compactReasoningText(
    [result.reasoningContent, taggedHiddenThought, leakedPrelude.leakedThought, leakedTail.leakedThought].filter(Boolean).join("\n\n").trim(),
    options.maxHiddenChars,
  );

  return {
    visibleText,
    hiddenThought,
    replyOptions,
    hasExplicitUserChoiceRequest,
    toolCalls,
    finishReason: result.finishReason,
  };
}

/**
 * 当模型把结论完全吃进 thought，或只留下空白正文时，
 * 用隐藏推理生成一个最小可见摘要，避免用户看到空回复。
 */
export function ensureVisibleConclusion(normalized: NormalizedStreamState): NormalizedStreamState {
  return ensureVisibleConclusionWithPolicy(normalized, true);
}

export function ensureVisibleConclusionWithPolicy(
  normalized: NormalizedStreamState,
  allowSyntheticVisibleConclusion: boolean,
): NormalizedStreamState {
  if (!allowSyntheticVisibleConclusion) return normalized;
  if (normalized.visibleText.trim()) return normalized;
  if (!normalized.hiddenThought.trim()) return normalized;

  return {
    ...normalized,
    visibleText: SYNTHETIC_VISIBLE_CONCLUSION,
  };
}

export function isAssistantTurnEmpty(normalized: Pick<NormalizedStreamState, "visibleText" | "hiddenThought" | "replyOptions" | "toolCalls">): boolean {
  return (
    !String(normalized.visibleText || "").trim() &&
    !String(normalized.hiddenThought || "").trim() &&
    (!Array.isArray(normalized.replyOptions) || normalized.replyOptions.length === 0) &&
    (!Array.isArray(normalized.toolCalls) || normalized.toolCalls.length === 0)
  );
}

export type AssistantCompletionClass =
  | "content"
  | "tool_calls"
  | "reasoning_only"
  | "protocol_only"
  | "true_empty";

/**
 * Classify a provider completion without guessing its cause. In particular,
 * an empty or protocol-only local completion is not evidence that the model's
 * context window was exceeded.
 */
export function classifyAssistantCompletion(result: StreamResult): AssistantCompletionClass {
  const normalized = normalizeAssistantTurn(result);
  if (normalized.toolCalls.length > 0) return "tool_calls";
  if (normalized.visibleText.trim() || normalized.replyOptions.length > 0) return "content";
  if (normalized.hiddenThought.trim()) return "reasoning_only";
  if (String(result.content || "").trim()) return "protocol_only";
  return "true_empty";
}

// endregion
