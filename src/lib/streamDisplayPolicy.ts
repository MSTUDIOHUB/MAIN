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
const VISUAL_OBSERVATION_START_RE = /<!--\s*MAIN_VISUAL_OBSERVATION\b/i;
const VISUAL_OBSERVATION_COMPLETE_RE = /<!--\s*MAIN_VISUAL_OBSERVATION\b[\s\S]*?-->/i;
const MARKDOWN_STRUCTURE_RE = /(?:^|\n)\s*(?:#{1,6}\s+\S+|[-*]\s+\S+|\d+[.)、]\s+\S+|\|.+\|)\s*/;
const LATIN_OR_CJK_RE = /[A-Za-z\u4e00-\u9fff]/;
const UNEXPECTED_SHORT_SCRIPT_RE =
  /[\u0900-\u097F\u0590-\u05FF\u0600-\u06FF\u0E00-\u0E7F\u3040-\u30FF\uAC00-\uD7AF]/;

export function shouldProjectStreamingAssistantToCapsule(input: Pick<
  StreamingAssistantDisplayInput,
  "workflowMode" | "runIntent"
>): boolean {
  if (input.workflowMode === "plan") return true;
  const intent = String(input.runIntent || "");
  return intent === "execute" || intent === "studio_workflow" || intent === "plan";
}

function shouldGateStreamingText(input: StreamingAssistantDisplayInput): boolean {
  // Plan mode: gate on protocol fragments and unstable short text only.
  // Previously: plan mode gated all output, causing short structured plans
  // to be hidden behind buffering. Now we allow stable markdown content to
  // show immediately while still filtering out noise and partial output.
  return shouldProjectStreamingAssistantToCapsule(input);
}

function hasStableMarkdownShape(text: string): boolean {
  return MARKDOWN_STRUCTURE_RE.test(text);
}

function hasPartialProtocol(text: string): boolean {
  return PARTIAL_PROTOCOL_RE.test(text) || (
    VISUAL_OBSERVATION_START_RE.test(text) &&
    !VISUAL_OBSERVATION_COMPLETE_RE.test(text)
  );
}

export function resolveStreamingAssistantDisplay(
  input: StreamingAssistantDisplayInput,
): StreamingAssistantDisplayDecision {
  const raw = String(input.text || "");
  if (!raw) return { action: "suppress", text: "", reason: "empty" };

  const partialProtocol = hasPartialProtocol(raw);
  if (input.hasVisibleAgentBlock && !partialProtocol && !VISUAL_OBSERVATION_START_RE.test(raw)) {
    return { action: "show", text: raw };
  }

  const sanitized = sanitizeAssistantDisplayContent(raw);
  if (!sanitized) {
    return partialProtocol
      ? { action: "buffer", text: "", bufferText: raw, reason: "protocol_fragment" }
      : { action: "suppress", text: "", reason: "sanitized_empty" };
  }

  const gate = shouldGateStreamingText(input);
  // Protocol fragments are always buffered regardless of gating mode
  if (partialProtocol && !hasStableMarkdownShape(sanitized)) {
    return { action: "buffer", text: "", bufferText: raw, reason: "protocol_fragment" };
  }

  if (!gate) {
    return { action: "show", text: sanitized };
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

  // Plan mode: show content immediately if it has stable markdown shape or is long enough.
  // This prevents the "content appears then disappears" effect from unnecessary buffering.
  if (input.workflowMode === "plan" && (hasStableMarkdownShape(sanitized) || compact.length >= 24)) {
    return { action: "show", text: sanitized, reason: "plan_mode_stable_content" };
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
