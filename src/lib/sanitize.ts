/**
 * sanitizeAIOutput — Stream-safe sanitization for LLM output.
 *
 * CRITICAL: All regex patterns must be stream-safe.
 * - NEVER use [\s\S]*? on streaming text — catastrophic backtracking.
 * - Only strip XML tags themselves, preserving inner content and markdown.
 * - tool_use blocks are fully removed via a state machine, not regex.
 */

const ANSI_RE =
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

const TOOL_TAG_NAME_SOURCE = [
  "analysis",
  "tool_use",
  "tool_call",
  "function_call",
  "tool_response",
  "tool_result",
  "tool",
  "parameter",
  "name",
  "thinking",
  "thought",
  "reasoning",
  "plan",
  "jobList",
  "get_project_skeleton",
  "get_file_outline",
  "list_directory",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "glob_search",
  "grep_search",
  "replace_in_file",
  "write_file",
  "execute_command",
  "send_pty_input",
  "run_command",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
].join("|");

// Stream-safe: matches individual tags only, no cross-line patterns
const XML_TAG_ONLY_RE =
  new RegExp(`</?(?:${TOOL_TAG_NAME_SOURCE})(?:\\s[^>]*)?/?>`, "gi");

const RAW_TOOL_BLOCK_RE =
  /<(?:tool_call|function_call)(?:\s[^>]*)?>[\s\S]*?<\/(?:tool_call|function_call)>/gi;

const RESIDUAL_TOOL_LINE_RE =
  new RegExp(`^\\s*</?(?:tool(?:[_\\s-]?(?:call|use))?|function(?:[_\\s-]?call)?|parameter|name|get_project_skeleton|get_file_outline|list_directory|read_file|read_document|analyze_tabular_document|query_tabular_document|index_workspace_documents|glob_search|grep_search|replace_in_file|write_file|execute_command|send_pty_input|run_command|read_pty_buffer|read_pty_tail|read_pty_since|get_pty_status|clear_pty_buffer)\\b[^>]*>?[\\s|]*$`, "i");

const RESIDUAL_SYMBOL_ONLY_RE = /^[|>]+$/;
const SPECIAL_STOP_TOKEN_LINE_RE =
  /^\s*(?:<eos>|<\/s>|<\|eot_id\|>|<\|endoftext\|>|<end_of_turn>|<\|im_end\|>|<\|end\|>|<\uff5cend\u2581of\u2581sentence\uff5c>)\s*$/i;
const MODEL_CONTROL_TOKEN_RE = /<\|"\|>|<\|[^|>]+?\|>/g;
const END_OF_DOCUMENT_LINE_RE = /^\s*\(End of [^)]+ document\)\s*$/i;
const PLAN_PATH_NOISE_LINE_RE = /^\s*(?:path\s*:?\s*)?\.MAIN\/plans\/[^\s]+\.md\}?\s*$/i;
const LATEX_ARROW_RE = /\$\\(?:right|Right)arrow\$/g;
const LATEX_DOUBLE_ARROW_RE = /\$\\(?:Right|left)arrow\$/g;

export interface ExtractedToolCall {
  toolName: string;
  parameters: Record<string, string>;
}

/**
 * Extract and remove <plan> and <jobList> blocks completely from text.
 * This prevents raw JSON from appearing in the UI bubbles.
 */
export function stripPlanBlocks(text: string): string {
  if (!text) return "";
  return text.replace(/<(?:plan|jobList)>[\s\S]*?<\/(?:plan|jobList)>/gi, "");
}

/**
 * 移除完整的 tool_call / function_call 块，避免原始 JSON 混进聊天正文。
 */
export function stripRawToolCallBlocks(text: string): string {
  if (!text) return "";
  return text.replace(RAW_TOOL_BLOCK_RE, "");
}

/**
 * Extract and remove tool_use blocks using indexOf state machine.
 * No cross-line regex — stream safe.
 */
export function extractToolCalls(text: string): {
  cleanText: string;
  toolCalls: ExtractedToolCall[];
} {
  const toolCalls: ExtractedToolCall[] = [];
  let result = "";
  let i = 0;

  while (i < text.length) {
    const openIdx = text.indexOf("<tool_use", i);
    if (openIdx === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, openIdx);

    const closeIdx = text.indexOf("</tool_use>", openIdx);
    if (closeIdx === -1) {
      // Closing tag not arrived yet — tag-only stripper will clean up
      result += text.slice(openIdx);
      break;
    }

    const block = text.slice(openIdx + 10, closeIdx);

    const nameM = block.match(/<tool>([\s\S]*?)<\/tool>/);
    const toolName = nameM ? nameM[1].trim() : "";

    const params: Record<string, string> = {};
    const pRe = /<parameter\s+name="([^"]*)">([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = pRe.exec(block)) !== null) {
      params[pm[1]] = pm[2].trim();
    }

    if (toolName) {
      toolCalls.push({ toolName, parameters: params });
    }

    i = closeIdx + 11; // len of </tool_use>
  }

  return { cleanText: result, toolCalls };
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function stripXmlTags(text: string): string {
  return text.replace(XML_TAG_ONLY_RE, "");
}

/**
 * 清理残留的半截工具标签，比如 `<tool_call`、`<tool call|` 这类碎片。
 */
export function stripResidualToolFragments(text: string): string {
  if (!text) return "";

  return text
    .replace(/<\/?\s*(?:tool(?:[_\s-]?(?:call|use))?|function(?:[_\s-]?call)?|parameter|name|get_project_skeleton|get_file_outline|list_directory|read_file|read_document|analyze_tabular_document|query_tabular_document|index_workspace_documents|glob_search|grep_search|replace_in_file|write_file|execute_command|send_pty_input|run_command|read_pty_buffer|read_pty_tail|read_pty_since|get_pty_status|clear_pty_buffer)\b[^>\n]*>/gi, "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (RESIDUAL_TOOL_LINE_RE.test(trimmed)) return false;
      if (RESIDUAL_SYMBOL_ONLY_RE.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

export function stripSpecialStopTokens(text: string): string {
  if (!text) return "";

  return text
    .split(/\r?\n/)
    .filter((line) => !SPECIAL_STOP_TOKEN_LINE_RE.test(line.trim()))
    .join("\n");
}

export function stripModelControlTokens(text: string): string {
  if (!text) return "";
  return text.replace(MODEL_CONTROL_TOKEN_RE, "");
}

export function normalizeModelNoise(text: string): string {
  if (!text) return "";

  return stripModelControlTokens(text)
    .replace(LATEX_DOUBLE_ARROW_RE, "⇒")
    .replace(LATEX_ARROW_RE, "→")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (END_OF_DOCUMENT_LINE_RE.test(trimmed)) return false;
      if (PLAN_PATH_NOISE_LINE_RE.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

export function sanitizePlanArtifactContent(text: string): string {
  if (!text) return "";
  return normalizeModelNoise(text).replace(/\n{4,}/g, "\n\n\n").trim();
}

export function sanitizeAIOutput(text: string): string {
  if (!text) return "";
  let out = stripPlanBlocks(text);
  out = stripRawToolCallBlocks(out);
  out = extractToolCalls(out).cleanText;
  out = stripAnsi(out);
  out = stripXmlTags(out);
  out = stripResidualToolFragments(out);
  out = stripSpecialStopTokens(out);
  out = normalizeModelNoise(out);
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
