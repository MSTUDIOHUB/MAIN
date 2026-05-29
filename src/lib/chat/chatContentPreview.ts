import { isConversationalFirstPersonNarration, isIdleCapsuleNarration } from "../capsuleStagingHelper";
import { sanitizeAssistantDisplayContent } from "../sanitize";
import { normalizeThoughtSummaryForCompare } from "../thoughtDisplay";

export const AGENT_CONTENT_PREVIEW_CHARS = 60_000;
export const STREAMING_AGENT_CONTENT_PREVIEW_CHARS = 16_000;

export function getDisplayAgentContent(
  content: string,
  showFull: boolean,
  previewChars = AGENT_CONTENT_PREVIEW_CHARS,
) {
  const raw = String(content || "");
  if (showFull || raw.length <= previewChars) {
    return { content: raw, truncated: false, hiddenChars: 0 };
  }

  return {
    content: raw.slice(0, previewChars),
    truncated: true,
    hiddenChars: raw.length - previewChars,
  };
}

export function getAgentPreviewContent(content: string) {
  return getDisplayAgentContent(sanitizeAssistantDisplayContent(content), false).content;
}

export function getAgentInspectableContent(content: string) {
  const raw = String(content || "");
  if (raw.length <= AGENT_CONTENT_PREVIEW_CHARS) return raw;
  return `${raw.slice(0, AGENT_CONTENT_PREVIEW_CHARS)}\n\n${raw.slice(-20_000)}`;
}

export function formatTokenCount(value: number | undefined) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString();
}

export function normalizeCapsuleExplanationText(text: string): string {
  const content = String(text || "").trim();
  if (!content || isIdleCapsuleNarration(content)) return "";
  if (!isConversationalFirstPersonNarration(content)) return "";

  // 消除流式输出中可能出现的尾部不完整列表标志（如换行符加数字或减号等，例如 \n1 或 \n-），
  // 避免在胶囊中显示被截断的残余部分，确保每次渲染在视觉上都是一个完整的句子。
  return content.replace(/\n\s*(?:\d+\.?|\*|-)?\s*$/, "");
}

export function normalizeCapsuleProgressText(text: string): string {
  const content = String(text || "").trim();
  if (!content || isIdleCapsuleNarration(content)) return "";
  return content;
}

export function normalizeTranscriptDedupeText(text: string): string {
  return normalizeThoughtSummaryForCompare(
    String(text || "")
      .replace(/[`*_#[\]()]/g, " ")
      .replace(/[。！？；，、,.!?;:：]/g, " ")
  ).replace(/\s+/g, "");
}

export function extractPathishTokens(text: string): string[] {
  const source = String(text || "");
  const tokens = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z0-9_.@/-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_.@/-]*\/[A-Za-z0-9_.@/-]+/g)) {
    const raw = String(match[0] || "").trim();
    if (!raw || raw.length < 4) continue;
    tokens.add(raw.toLowerCase());
    const basename = raw.split(/[\\/]/).pop();
    if (basename && basename.length >= 4) tokens.add(basename.toLowerCase());
  }
  return [...tokens];
}
