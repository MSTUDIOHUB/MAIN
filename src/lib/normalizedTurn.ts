// lib/normalizedTurn.ts
// 将不同模型、不同输出格式统一整理成前端可消费的标准结构。

import { parseTextForTools } from "./textToolParser";
import { extractReplyOptions } from "./replyOptions";
import { sanitizeAIOutput } from "./sanitize";
import type { StreamResult } from "./streaming";
import type { NormalizedStreamState, NormalizedToolCall } from "./workflowModels";

// region: 推理文本提取

const REASONING_TAG_RE = /<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>([\s\S]*?)<\/(?:analysis|thought|thinking|reasoning)>/gi;
const LEAKED_REASONING_MARKERS = [
  /^thinking\b/i,
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
  /^i need to\b/i,
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
  /\bi will proceed\b/i,
  /\bi should respond\b/i,
  /\bi should answer\b/i,
  /\brespond in chinese\b/i,
  /\bkeep it friendly\b/i,
  /\bfinal output generation\b/i,
  /\bfalls under\b/i,
  /用户.*提供/i,
  /我的计划是/i,
  /不需要调用工具/i,
  /我将继续/i,
  /^用户要求我/i,
  /^让我先/i,
  /^我先调用/i,
  /^我需要先/i,
  /^继续执行计划/i,
  /^请继续执行/i,
  /^The user asked me/i,
  /^Let me first/i,
  /^I need to/i,
  /^Continue executing/i,
];

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

  if (leaked.length < 2) {
    return { leakedThought: "", visibleText: text };
  }

  return {
    leakedThought: leaked.join("\n\n").trim(),
    visibleText: paragraphs.slice(firstVisibleIdx).join("\n\n").trim(),
  };
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

function normalizeTextToolCalls(text: string): NormalizedToolCall[] {
  const parsed = parseTextForTools(text);
  return parsed.toolCalls.map((call, index) => ({
    id: call.id?.trim() || `text_call_${index + 1}`,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
    source: "text" as const,
  }));
}

// endregion

// region: Turn 归一化

/**
 * 统一收敛可见正文 / 隐藏推理 / 工具调用，降低模型差异对 UI 的影响。
 */
export function normalizeAssistantTurn(result: StreamResult): NormalizedStreamState {
  const taggedHiddenThought = extractHiddenThought(result.content);
  const parsed = parseTextForTools(result.content);
  const nativeToolCalls = normalizeNativeToolCalls(result);
  const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : normalizeTextToolCalls(result.content);
  const { cleanText: textWithoutOptions, replyOptions } = extractReplyOptions(parsed.cleanText || "");
  const preSanitizedVisible = collapseRepeatedParagraphLoops(sanitizeAIOutput(textWithoutOptions))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const leakedPrelude = extractLeakedReasoningPrelude(preSanitizedVisible);

  const visibleText = leakedPrelude.visibleText;
  const hiddenThought = [taggedHiddenThought, leakedPrelude.leakedThought].filter(Boolean).join("\n\n").trim();

  return {
    visibleText,
    hiddenThought,
    replyOptions,
    toolCalls,
    finishReason: result.finishReason,
  };
}

/**
 * 当模型把结论完全吃进 thought，或只留下空白正文时，
 * 用隐藏推理生成一个最小可见摘要，避免用户看到空回复。
 */
export function ensureVisibleConclusion(normalized: NormalizedStreamState): NormalizedStreamState {
  if (normalized.visibleText.trim()) return normalized;
  if (!normalized.hiddenThought.trim()) return normalized;

  const firstSentence = normalized.hiddenThought
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？.!?])\s+/)
    .find(Boolean)
    ?.trim();

  return {
    ...normalized,
    visibleText: firstSentence || "本轮处理已完成，详细过程已折叠到操作记录中。",
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

// endregion
