import { hasStructuredPlanProposal, parsePlanJobs, type PlanJobItem } from "./planProposal";

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'thought'; content: string }
  | { type: 'plan'; jobs: PlanJobItem[] };

/**
 * Parses AI output into a sequence of renderable segments.
 * Extracts <thought>, <thinking>, <analysis>, <reasoning> and <plan> tags while preserving order.
 */
export function parseMessageContent(text: string): MessageSegment[] {
  if (!text) return [];

  const segments: MessageSegment[] = [];
  const shouldRenderPlan = hasStructuredPlanProposal(text);

  // Regex to find all common thinking and plan blocks
  const tagRegex = /<(thought|thinking|analysis|reasoning|plan)>([\s\S]*?)<\/\1>/g;

  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(text)) !== null) {
    const [, tagName, content] = match;
    const index = match.index;

    // 1. Push preceding text as a 'text' segment
    if (index > lastIndex) {
      const textPart = text.slice(lastIndex, index);
      if (textPart.trim()) {
        segments.push({ type: 'text', content: textPart });
      }
    }

    // 2. Push the tag content as a specific segment
    if (["thought", "thinking", "analysis", "reasoning"].includes(tagName)) {
      segments.push({ type: 'thought', content: content });
    } else if (tagName === 'plan') {
      if (shouldRenderPlan) {
        const parsed = parsePlanJobs(content.trim());
        if (parsed) {
          segments.push({ type: 'plan', jobs: parsed });
        }
      }
    }

    lastIndex = tagRegex.lastIndex;
  }

  // 3. Push remaining text
  if (lastIndex < text.length) {
    const remainingText = text.slice(lastIndex);
    if (remainingText) {
      segments.push({ type: 'text', content: remainingText });
    }
  }

  return segments;
}
