import { sanitizeAssistantDisplayContent } from "./sanitize";

export type StreamingAssistantDisplayAction = "show" | "buffer" | "suppress";

export interface StreamingAssistantDisplayDecision {
  action: StreamingAssistantDisplayAction;
  text: string;
  bufferText?: string;
  reason?: string;
}

export interface StreamingAssistantDisplayInput {
  text: string;
  language?: "zh" | "en";
  workflowMode?: "chat" | "edit" | "plan";
  runIntent?: string;
  hasVisibleAgentBlock?: boolean;
}

const PARTIAL_PROTOCOL_RE =
  /(?:<\s*\/?\s*(?:tool_use|tool_call|function_call|tool|parameter|user_options|option|proposed_plan)\b|^\s*\[\s*(?:PROPOSAL|START[_\s-]*PROPOSAL|END[_\s-]*PROPOSAL)\b)/i;
const MARKDOWN_STRUCTURE_RE = /(?:^|\n)\s*(?:#{1,6}\s+\S+|[-*]\s+\S+|\d+[.)、]\s+\S+|\|.+\|)\s*/;
const LATIN_OR_CJK_RE = /[A-Za-z\u4e00-\u9fff]/;
const UNEXPECTED_SHORT_SCRIPT_RE =
  /[\u0900-\u097F\u0590-\u05FF\u0600-\u06FF\u0E00-\u0E7F\u3040-\u30FF\uAC00-\uD7AF]/;

function shouldGateStreamingText(input: StreamingAssistantDisplayInput): boolean {
  if (input.workflowMode === "plan") return true;
  const intent = String(input.runIntent || "");
  return intent === "execute" || intent === "studio_workflow" || intent === "plan";
}

function hasStableMarkdownShape(text: string): boolean {
  return MARKDOWN_STRUCTURE_RE.test(text);
}

export function resolveStreamingAssistantDisplay(
  input: StreamingAssistantDisplayInput,
): StreamingAssistantDisplayDecision {
  const raw = String(input.text || "");
  if (!raw) return { action: "suppress", text: "", reason: "empty" };

  if (input.hasVisibleAgentBlock && !PARTIAL_PROTOCOL_RE.test(raw)) {
    return { action: "show", text: raw };
  }

  const sanitized = sanitizeAssistantDisplayContent(raw);
  if (!sanitized) {
    return PARTIAL_PROTOCOL_RE.test(raw)
      ? { action: "buffer", text: "", bufferText: raw, reason: "protocol_fragment" }
      : { action: "suppress", text: "", reason: "sanitized_empty" };
  }

  const gate = shouldGateStreamingText(input);
  if (!gate) {
    return { action: "show", text: sanitized };
  }

  if (PARTIAL_PROTOCOL_RE.test(raw) && !hasStableMarkdownShape(sanitized)) {
    return { action: "buffer", text: "", bufferText: raw, reason: "protocol_fragment" };
  }

  const compact = sanitized.replace(/\s+/g, "");
  if (
    !input.hasVisibleAgentBlock &&
    compact.length < 24 &&
    UNEXPECTED_SHORT_SCRIPT_RE.test(compact) &&
    !LATIN_OR_CJK_RE.test(compact)
  ) {
    return { action: "buffer", text: "", bufferText: raw, reason: "unexpected_short_script" };
  }

  if (
    !input.hasVisibleAgentBlock &&
    compact.length < 12 &&
    !hasStableMarkdownShape(sanitized)
  ) {
    return { action: "buffer", text: "", bufferText: raw, reason: "unstable_short_text" };
  }

  return { action: "show", text: sanitized };
}
