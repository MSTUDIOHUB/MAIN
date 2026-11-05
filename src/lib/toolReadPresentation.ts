import { extractExactReadFileWindow } from "./readFileWindow";
import { parseToolFeedbackEnvelope } from "./toolFeedbackEnvelope";
import type { ToolResultPresentation, ToolResultPresentationLanguage } from "./toolResultPresentation";

const EMPTY_READ_TOOLS = new Set(["grep_search", "glob_search", "list_directory", "get_file_outline", "read_document", "knowledge_search", "knowledge_get_excerpt"]);
const EMPTY_RECEIPT = "TOOL_RESULT_EMPTY: the tool completed successfully and returned no content or matches.";

/** Format owned read protocols for humans. This function has no execution,
 * permission or outcome authority; literal source inside a window is exact. */
export function presentToolReadResult(toolName: string, message: string, language: ToolResultPresentationLanguage): ToolResultPresentation | null {
  const envelope = parseToolFeedbackEnvelope(message);
  const body = envelope?.body || message;
  const textResult = (text: string, summary: string, displayTarget?: string): ToolResultPresentation => ({
    kind: "text", sections: text ? [{ label: "", text }] : [], text, meta: [summary], parsed: true,
    ...(displayTarget ? { displayTarget } : {}),
  });
  if (toolName === "read_file") {
    const window = extractExactReadFileWindow(body);
    if (window) {
      const { returnedStartLine: start, returnedEndLine: end, truncated, totalLines } = window.metadata;
      const summary = language === "zh"
        ? totalLines === 0 ? "已读取空文件。" : `已读取文件第 ${start}–${end} 行${truncated ? "（部分内容）" : ""}。`
        : totalLines === 0 ? "Read an empty file." : `Read file lines ${start}–${end}${truncated ? " (partial content)" : ""}.`;
      return textResult(window.content, summary);
    }
  }
  if (toolName === "load_skill") {
    let skill: any;
    try { skill = JSON.parse(body); } catch { /* Unrecognized content stays unchanged. */ }
    if (skill?.type === "skill.loaded" && typeof skill.name === "string" && typeof skill.content === "string") {
      const summary = language === "zh" ? `已读取技能「${skill.name}」的请求范围。` : `Read the requested range of Skill “${skill.name}”.`;
      return textResult(skill.content, summary, skill.name);
    }
  }
  if (envelope?.envelope.status === "cached" && (toolName === "read_file" || EMPTY_READ_TOOLS.has(toolName))) {
    const summary = language === "zh" ? "复用了已有读取结果。" : "Reused an existing read result.";
    return textResult(summary, summary);
  }
  if (EMPTY_READ_TOOLS.has(toolName) && body.trim() === EMPTY_RECEIPT) {
    const summary = language === "zh" ? "没有返回内容或匹配项。" : "No content or matches were returned.";
    return textResult(summary, summary);
  }
  return null;
}
