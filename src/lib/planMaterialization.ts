import { sanitizePlanArtifactContent, stripUserOptionsProtocol } from "./sanitize";
import { parseToolFeedbackEnvelope } from "./toolFeedbackEnvelope";
import {
  repairActionablePlanArtifactContent,
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
  type PlanStage,
} from "./workflowModels";
import { extractPrimaryUserRequestText, normalizeTurnInputContextSignals, type TurnInputContextLike } from "./turnIntake";

export type MaterializablePlanKind = "plan" | "design";
export type PlanMaterializationSource =
  | "visible_plan"
  | "canonicalized_visible_plan"
  | "deterministic_evidence";

export interface PlanMaterializationResult {
  ok: boolean;
  kind?: MaterializablePlanKind;
  path?: string;
  content?: string;
  reason?: string;
  source?: PlanMaterializationSource;
  /** Extracted <user_options> blocks for post-validation routing. */
  replyOptions?: string[];
}

interface PlanMaterializationToolActivityLike {
  name?: string;
  target?: string;
  status?: string;
  detail?: string;
}

export interface PlanEvidenceRecord {
  tool: string;
  target: string;
  status: string;
  summary?: string;
  hash?: string;
}

export interface PlanEvidenceSanitizerDrop {
  bucket: "evidence" | "files" | "constraints";
  reason: string;
  preview: string;
}

export interface SanitizedPlanEvidenceInput {
  userGoal: string;
  evidence: string[];
  files: string[];
  constraints: string[];
  dropped: PlanEvidenceSanitizerDrop[];
  stats: {
    inputEvidence: number;
    keptEvidence: number;
    inputStructuredEvidence: number;
    keptStructuredEvidence: number;
    inputFiles: number;
    keptFiles: number;
    inputConstraints: number;
    keptConstraints: number;
    dropped: number;
    dropReasons: Record<string, number>;
  };
}

const PROTOCOL_NOISE_RE = /<\/?(?:tool_use|tool_call|function_call|tool|parameter)\b/i;
const PROPOSAL_MARKER_RE = /^\s*\[\s*(?:PROPOSAL(?:[_\s-]*(?:START|BEGIN|END|STOP))?|START[_\s-]*PROPOSAL|END[_\s-]*PROPOSAL)\s*\]?\s*$/gim;
const PROPOSED_PLAN_BLOCK_RE = /<proposed_plan(?:\s[^>]*)?>([\s\S]*?)<\/proposed_plan>/i;
const PROPOSED_PLAN_TAG_RE = /<\/?proposed_plan(?:\s[^>]*)?>/gi;
const USER_OPTIONS_BLOCK_RE = /^\s*<user_options>\s*$[\s\S]*?^\s*<\/user_options>\s*$/gim;
const OPTION_BLOCK_RE = /<option\b[^>]*>[\s\S]*?<\/option>/gi;
const TOOL_LOG_NOISE_RE =
  /Repeated read-only tool call skipped|Duplicate skip count|FILE_UNCHANGED_STUB|already called with identical arguments|后台思考已折叠|thinking process|chain of thought|ContextMemoryState|ContextState|MAIN TOOL FEEDBACK|tool call id|PLAN_REPEAT_READ_LIMIT|上一条\s*Plan\s*回复是空的/i;
const PLAN_ARTIFACT_PATH_RE = /(?:^|[\\/\s`"'(:=])\.?MAIN[\\/]plans[\\/]/i;
const RAW_TOOL_RESULT_NOISE_RE =
  /\bREAD_FILE_RESULT\b|\bContextMemory(?:State)?\b|\bContextState\b|\breturnedLines\b|\btotalLines\b|\btotalChars\b|\bPLAN NOT READY\b|\bTASK_TARGETING_BLOCKED\b|\bstatus\s*[:=]\s*(?:failed|blocked|rejected)\b/i;
const PLAN_PROMPT_INSTRUCTION_RE =
  /(?:本轮处于\s*PLAN\s*模式|This turn is in PLAN mode|上一条\s*Plan\s*回复|previous Plan reply|PLAN_REPEAT_READ_LIMIT|PLAN_QUALITY_GATE|如果确实缺少关键业务选择|critical business choice|真正阻塞执行的选择|plan direction is unclear|用\s*`?\s*<?user_options>?\s*`?\s*提问|ask with\s*`?\s*<?user_options>?|可见计划必须|visible\s+`?<proposed_plan>`|创建\s*\/?更新?\s*(?:staged\s+ledger|requirements\.md|design\.md|tasks\.md)|创建\s*plan\.md\s*是\s*runtime|MAIN\s+runtime\s+会物化|物化为\s*`?\.MAIN\/plans\/plan\.md|Codex app\s*计划结构|Codex app plan shape|tsx\s*约束|imageParts\s*[0-9]|turn_intake|不要重复扫描目录|Do not repeat directory scans|不要为了完成规划而调用|Do not call\s+`?(?:write_file|replace_in_file)`?\s+just to finish planning)/i;
const TOOL_META_FIELD_RE =
  /\b(?:status|hash|exit|tool_call_id|toolCallId|returnedLines|totalLines|totalChars|truncated)\s*[:=]\s*[^\s;\n,}]+/gi;
const FORMAL_PLAN_OUTLINE_HEADING_RE =
  /^(?:正式计划|修复计划|根因分析|原因分析|问题\s*[0-9一二三四五六七八九十]+|可能根因|根因|原因|修复方案|实施方案|落地方案|影响文件|相关文件|验证方式|验证标准|测试方案|公共\s*API|接口|类型|假设与默认值|默认假设|未验证假设|风险|注意事项|摘要|总结|Formal Plan|Repair Plan|Root Cause|Likely Root Cause|Issue\s*\d+|Fix Plan|Implementation Plan|Affected Files|Validation|Test Plan|Assumptions|Defaults)(?:\s*[：:].*)?$/i;
const SEMANTIC_EVIDENCE_TOOLS = new Set([
  "analyze_tabular_document",
  "query_tabular_document",
  "get_project_skeleton",
  "list_directory",
  "read_file",
  "read_file_window",
  "read_document",
  "get_file_outline",
  "grep_search",
  "glob_search",
  "index_workspace_documents",
]);
const PATH_LIKE_RE = /\b(?:src|app|lib|components|tests|pages|hooks|store|styles|assets|public|server|client|packages|apps|docs|scripts|config|\.?MAIN)\/[A-Za-z0-9_./@-]+\b/g;
const ACTIONABLE_PLAN_FILE_RE =
  /^(?:\.?\/)?[A-Za-z0-9_@./-]+\.(?:tsx?|jsx?|swift|py|rs|go|json|csv|tsv|xlsx|md|css|scss|html|toml|yaml|yml)$/i;
const PLAN_EVIDENCE_REFERENCE_RE =
  /(?:^|[\s`"'(:=])\.?MAIN[\\/]plans[\\/](?:plan|requirements|tasks|design)\.md\b/i;

const TOOL_LABELS_ZH: Record<string, string> = {
  analyze_tabular_document: "已分析表格数据",
  query_tabular_document: "已查询表格数据",
  get_project_skeleton: "已查看项目结构",
  list_directory: "已查看目录",
  read_file: "已读取文件",
  read_file_window: "已读取文件窗口",
  read_document: "已读取文档",
  get_file_outline: "已查看文件结构",
  grep_search: "已搜索文本",
  glob_search: "已搜索文件",
  index_workspace_documents: "已索引工作区文档",
};

const TOOL_LABELS_EN: Record<string, string> = {
  analyze_tabular_document: "Analyzed tabular data",
  query_tabular_document: "Queried tabular data",
  get_project_skeleton: "Inspected project structure",
  list_directory: "Listed directory",
  read_file: "Read file",
  read_file_window: "Read file window",
  read_document: "Read document",
  get_file_outline: "Inspected file outline",
  grep_search: "Searched text",
  glob_search: "Searched files",
  index_workspace_documents: "Indexed workspace documents",
};

const BROAD_DISCOVERY_EVIDENCE_RE =
  /^(?:(?:glob_search|list_directory|get_project_skeleton|index_workspace_documents)\b|(?:已搜索文件|已查看目录|已查看项目结构|已索引工作区文档)(?:[:：\s]|$)|(?:Searched files|Listed directory|Inspected project structure|Indexed workspace documents)\b)/i;
const CONCRETE_PLAN_EVIDENCE_RE =
  /^(?:(?:read_file|read_file_window|read_document|get_file_outline|grep_search|analyze_tabular_document|query_tabular_document)\b|(?:已读取文件|已读取文件窗口|已读取文档|已查看文件结构|已搜索文本|已分析表格数据|已查询表格数据)(?:[:：\s]|$)|(?:Read file|Read file window|Read document|Inspected file outline|Searched text|Analyzed tabular data|Queried tabular data)\b)/i;
const CSV_DASHBOARD_GOAL_RE =
  /(?:CSV|导入|creator|course|课程|销售|排行|趋势|环比|订单|状态|Dashboard|面板|图表|指标|数据|field|column|chart|metric|order|status)/i;
const DARK_THEME_GOAL_RE =
  /(?:深色|暗色|dark\s*mode|theme|主题|白色底|background|contrast|palette)/i;
const BROAD_OR_NOISY_SEARCH_TARGET_RE =
  /^(?:\.|\.\/|\/|\*+|\*\*\/\*\.[A-Za-z0-9_*{}.,-]+|\*\.[A-Za-z0-9_*{}.,-]+|get_project_skeleton|[\s.*{}()[\]|,+-]+)$/i;
const TOOL_DETAIL_NON_EVIDENCE_RE =
  /(?:package-lock\.json|package\.json|node_modules|dist\/|build\/|<title\b|index\.html:\d+:\s*<title)/i;
const TOOL_DETAIL_HAS_SOURCE_SIGNAL_RE =
  /\b(?:src|app|lib|components|hooks|store|styles|utils|tests|pages|server|client|packages|apps)\/[A-Za-z0-9_./@-]+|\b(?:function|const|let|class|interface|type|export|import|use[A-Z][A-Za-z0-9_]*|loadOrders|parse|map|chart|dashboard|theme|dark|CSV|字段|列|指标|订单|图表|状态|趋势|环比)\b/i;
const PATH_ECHO_EVIDENCE_RE =
  /(?:已读取文件|Read file)\s*[:：]\s*([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)(?:\s*[;；]\s*(?:发现|found)\s*[:：]\s*\1)?\s*$/i;
const READ_FILE_RESULT_RE = /\bREAD_FILE_RESULT\b/i;
const READ_FILE_CONTENT_START = "---CONTENT START---";
const READ_FILE_CONTENT_END = "---CONTENT END---";
const READ_FILE_METADATA_LINE_RE =
  /^(?:\[MAIN_TOOL_FEEDBACK_V1\].*|READ_FILE_RESULT|path\s*:.*|truncated\s*:.*|totalLines\s*:.*|totalChars\s*:.*|returnedLines\s*:.*|returnedChars\s*:.*|nextStartLine\s*:.*|nextRead\s*:.*|note\s*:.*|---CONTENT (?:START|END)---|\.\.\.\[compact:.*)$/i;
const PLAN_EVIDENCE_SOURCE_SIGNAL_RE =
  /\b(?:import|export|function|const|let|class|interface|type|return|if|else|for|while|switch|case|try|catch|useEffect|useMemo|useState|props|state|set[A-Z][A-Za-z0-9_]*|load[A-Z]?[A-Za-z0-9_]*|parse[A-Z]?[A-Za-z0-9_]*|map|filter|reduce|render|csv|order|course|creator|amount|status|trend|metric|dashboard|chart|theme|dark|background|token|localStorage)\b|(?:字段|列名|订单|课程|销售|金额|状态|图表|趋势|环比|主题|深色|暗色|背景|指标)/i;

function countPlanShapeSignals(content: string): number {
  const headingCount = (content.match(/^#{1,3}\s+\S+/gm) || []).length;
  const bulletCount = (content.match(/^\s*(?:[-*]|\d+[.)、])\s+\S+/gm) || []).length;
  const outlineHeadingCount = countFormalPlanOutlineHeadings(content);
  const keywordCount = (content.match(/目标|约束|截图|附件|观察|已确认|事实|证据|发现|根因|原因|问题|修复计划|修复方案|方案|计划|设计|执行|实施|步骤|接口|文件|数据流|控制流|风险|验证|验证标准|注意事项|边界|默认假设|未验证假设|后续增强|开放问题|Goal|Constraint|Screenshot|Attachment|Observation|Confirmed|Evidence|Finding|Root Cause|Issue|Approach|Plan|Design|Interface|File|Flow|Risk|Validation|Caveat|Boundary|Assumption|Default|Follow-up|Enhancement|Open question/gi) || []).length;
  return headingCount + Math.min(outlineHeadingCount, 4) + Math.min(bulletCount, 6) + Math.min(keywordCount, 8);
}

function detectMaterializationLanguage(input: {
  content: string;
  userGoal?: string;
  language?: "zh" | "en";
}): "zh" | "en" {
  if (input.language === "en" || input.language === "zh") return input.language;
  return /[\u4e00-\u9fff]/.test(`${input.content}\n${input.userGoal || ""}`) ? "zh" : "en";
}

/**
 * Extract <user_options> reply options from raw text before validation.
 * Returns the extracted option texts and the content with options removed.
 * This allows validation to proceed on clean plan content while preserving
 * reply options for the user even when validation is deferred.
 */
function extractReplyOptionsFromContent(rawText: string): {
  content: string;
  replyOptions: string[];
} {
  const original = String(rawText || "").trim();
  const options: string[] = [];
  let content = original;

  // Extract <user_options> ... </user_options> blocks
  const userOptionsMatch = original.match(/<user_options>[\s\S]*?<\/user_options>/gi);
  if (userOptionsMatch) {
    for (const block of userOptionsMatch) {
      // Extract individual <option> elements
      const optionMatches = block.match(/<option[^>]*>([\s\S]*?)<\/option>/gi);
      if (optionMatches) {
        for (const opt of optionMatches) {
          const optText = opt.replace(/<option[^>]*>/i, "").replace(/<\/option>/i, "").trim();
          if (optText) {
            options.push(optText);
          }
        }
      } else {
        // Fallback: keep the whole block as an option label
        const blockText = block.replace(/<user_options[^>]*>/i, "").replace(/<\/user_options>/i, "").trim();
        if (blockText) {
          options.push(blockText);
        }
      }
    }
    // Remove <user_options> blocks from content
    content = content.replace(/<user_options>[\s\S]*?<\/user_options>/gi, "");
  }

  // Also extract standalone <option> tags outside of <user_options>
  const standaloneOptionMatch = content.match(/<option[^>]*>([\s\S]*?)<\/option>/gi);
  if (standaloneOptionMatch) {
    for (const opt of standaloneOptionMatch) {
      const optText = opt.replace(/<option[^>]*>/i, "").replace(/<\/option>/i, "").trim();
      if (optText && !options.includes(optText)) {
        options.push(optText);
      }
    }
    content = content.replace(/<option[^>]*>([\s\S]*?)<\/option>/gi, "");
  }

  // Clean up whitespace
  content = content.replace(/\n{3,}/g, "\n\n").trim();

  return { content, replyOptions: options };
}

function stripPlanChoiceMarkup(rawText: string): string {
  return stripUserOptionsProtocol(rawText)
    .replace(USER_OPTIONS_BLOCK_RE, "")
    .replace(OPTION_BLOCK_RE, "")
    .replace(/<\/?\s*user_options\s*>/gi, "")
    .replace(/<\/?\s*option\b[^>]*>/gi, "")
    .trim();
}

function unwrapProposedPlanMarkup(rawText: string): string {
  const match = rawText.match(PROPOSED_PLAN_BLOCK_RE);
  if (match?.[1]?.trim()) return match[1].trim();
  return rawText.replace(PROPOSED_PLAN_TAG_RE, "").trim();
}

function normalizePlanContent(rawText: string): string {
  const withoutChoices = unwrapProposedPlanMarkup(stripPlanChoiceMarkup(rawText));
  const withoutProposalMarkers = withoutChoices.replace(PROPOSAL_MARKER_RE, "").trim();
  const strippedPlanJson = withoutProposalMarkers.replace(/<plan>[\s\S]*?<\/plan>/gi, "").trim();
  const sanitized = sanitizePlanArtifactContent(strippedPlanJson);
  if (/^#\s+/m.test(sanitized)) return sanitized;
  return `# Plan\n\n${sanitized}`;
}

function compactPlanLine(value: unknown, maxChars = 180, preserveFormatting = false): string {
  let text = sanitizePlanArtifactContent(String(value ?? ""))
    .replace(/<tool_use[\s\S]*?(?:<\/tool_use>|$)/gi, " ")
    .replace(/<\/?(?:tool_use|tool_call|function_call|tool|parameter|user_options|option)\b[^>]*>/gi, " ");
  if (!preserveFormatting) {
    text = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#>*_`~]/g, " ");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text || TOOL_LOG_NOISE_RE.test(text) || PROTOCOL_NOISE_RE.test(text)) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}...`;
}

function stripPlanListMarker(line: string): string {
  return String(line || "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)、]\s+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .trim();
}

function cleanPlanItem(value: unknown, maxChars = 220, preserveFormatting = false): string {
  const stripped = stripPlanListMarker(String(value ?? ""));
  if (/^\s*-{3,}\s*$/.test(stripped)) return "";
  const text = compactPlanLine(stripped, maxChars, preserveFormatting);
  if (!text) return "";
  if (/^(?:批准|取消|继续调整|开始调查|Approve|Cancel|Continue|Adjust)\b/i.test(text)) return "";
  return text;
}

function uniqueCompactLines(values: unknown[], maxItems: number, maxChars = 180, preserveFormatting = false): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const line = compactPlanLine(value, maxChars, preserveFormatting);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
    if (result.length >= maxItems) break;
  }
  return result;
}

function uniquePlanItems(values: unknown[], maxItems: number, maxChars = 220, preserveFormatting = false): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const line = cleanPlanItem(value, maxChars, preserveFormatting);
    if (!line) continue;
    const key = line.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
    if (result.length >= maxItems) break;
  }
  return result;
}

function compactSanitizerPreview(value: unknown, maxChars = 180): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}...`;
}

function noteSanitizerDrop(
  dropped: PlanEvidenceSanitizerDrop[],
  bucket: PlanEvidenceSanitizerDrop["bucket"],
  reason: string,
  value: unknown,
): void {
  dropped.push({
    bucket,
    reason,
    preview: compactSanitizerPreview(value),
  });
}

function isPlanArtifactPath(value: unknown): boolean {
  return PLAN_ARTIFACT_PATH_RE.test(String(value || "").replace(/\\/g, "/"));
}

function isInternalPlanEvidenceText(value: unknown): boolean {
  return PLAN_EVIDENCE_REFERENCE_RE.test(String(value || "").replace(/\\/g, "/"));
}

function isPlanPromptInstructionText(value: unknown): boolean {
  return PLAN_PROMPT_INSTRUCTION_RE.test(String(value || "").replace(/\\/g, "/"));
}

function isActionablePlanFile(value: unknown): boolean {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  if (!normalized || isPlanArtifactPath(normalized)) return false;
  return ACTIONABLE_PLAN_FILE_RE.test(normalized);
}

function baseNameForPlanPath(value: string): string {
  return String(value || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

function isBroadDiscoveryEvidence(value: string): boolean {
  return BROAD_DISCOVERY_EVIDENCE_RE.test(String(value || "").trim());
}

function isConcretePlanEvidence(value: string): boolean {
  const text = String(value || "").trim();
  return CONCRETE_PLAN_EVIDENCE_RE.test(text) && !isBroadDiscoveryEvidence(text);
}

function isPathEchoEvidence(value: string): boolean {
  const text = String(value || "").replace(/`/g, "").trim();
  const rawTool = text.match(/^(?:read_file|read_file_window|read_document|get_file_outline)\s+([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)(?:\s*;\s*excerpt\s*=\s*\1)?$/i);
  if (rawTool) return true;
  const rawToolWithEchoDetail = text.match(/^(?:read_file|read_file_window|read_document|get_file_outline)\s+([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)\s*;\s*(?:excerpt|summary)\s*=\s*([^\n]+)$/i);
  if (rawToolWithEchoDetail && evidenceDetailLooksLikePathEcho(rawToolWithEchoDetail[2] || "", rawToolWithEchoDetail[1] || "")) return true;
  const localized = text.match(PATH_ECHO_EVIDENCE_RE);
  if (localized) return true;
  const excerptEcho = text.match(/^(?:已读取文件|Read file)\s*[:：]\s*([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)\s*[;；]\s*(?:发现|found)\s*[:：]\s*([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)\.?$/i);
  if (excerptEcho && excerptEcho[1] === excerptEcho[2]) return true;
  const localizedWithEchoDetail = text.match(/^(?:已读取文件|Read file)\s*[:：]\s*([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)\s*[;；]\s*(?:发现|found)\s*[:：]\s*([^\n]+)$/i);
  return Boolean(localizedWithEchoDetail && evidenceDetailLooksLikePathEcho(localizedWithEchoDetail[2] || "", localizedWithEchoDetail[1] || ""));
}

function isMeaningfulConcretePlanEvidence(value: string): boolean {
  const text = String(value || "").trim();
  if (!isConcretePlanEvidence(text)) return false;
  if (isPathEchoEvidence(text)) return false;
  if (TOOL_DETAIL_NON_EVIDENCE_RE.test(text) && !TOOL_DETAIL_HAS_SOURCE_SIGNAL_RE.test(text)) return false;
  return true;
}

function evidenceMentionsFile(evidence: string, file: string): boolean {
  const normalizedEvidence = String(evidence || "").replace(/\\/g, "/").toLowerCase();
  const normalizedFile = String(file || "").replace(/\\/g, "/").toLowerCase();
  const basename = baseNameForPlanPath(normalizedFile).toLowerCase();
  return Boolean(
    normalizedFile &&
    (
      normalizedEvidence.includes(normalizedFile) ||
      (basename.length > 4 && normalizedEvidence.includes(basename))
    )
  );
}

function pickEvidenceForFile(evidence: string[], file: string): string {
  return evidence.find((item) => evidenceMentionsFile(item, file)) || evidence[0] || "";
}

function extractDelimitedReadFileBody(value: string): string {
  const raw = String(value || "");
  const startIndex = raw.indexOf(READ_FILE_CONTENT_START);
  if (startIndex >= 0) {
    const bodyStart = startIndex + READ_FILE_CONTENT_START.length;
    const endIndex = raw.indexOf(READ_FILE_CONTENT_END, bodyStart);
    return (endIndex >= 0 ? raw.slice(bodyStart, endIndex) : raw.slice(bodyStart)).trim();
  }
  if (!READ_FILE_RESULT_RE.test(raw)) return "";
  const lines = raw.split(/\r?\n/);
  const contentLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return !READ_FILE_METADATA_LINE_RE.test(trimmed);
  });
  if (contentLines.length === lines.length) return "";
  return contentLines.join("\n").trim();
}

function compactPlanEvidenceSourceLine(line: string, index: number): string {
  const compacted = compactPlanLine(line, 150, true)
    .replace(/^\s*(?:\d+[:|]\s*)?/, "")
    .trim();
  if (!compacted) return "";
  return `L${index + 1}: ${compacted}`;
}

function collectPlanEvidenceSourceSignals(body: string, maxChars: number): string {
  const lines = String(body || "").split(/\r?\n/);
  const picked: string[] = [];
  let chars = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    if (!PLAN_EVIDENCE_SOURCE_SIGNAL_RE.test(line)) continue;
    const compacted = compactPlanEvidenceSourceLine(line, index);
    if (!compacted || picked.includes(compacted)) continue;
    const nextChars = chars + compacted.length + 1;
    if (nextChars > maxChars && picked.length > 0) break;
    picked.push(compacted);
    chars = nextChars;
    if (picked.length >= 6) break;
  }
  if (picked.length > 0) return picked.join(" ");

  const fallback = lines
    .map((line, index) => compactPlanEvidenceSourceLine(line, index))
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  return compactPlanLine(fallback, maxChars, true);
}

function stripReadFileMetadataText(value: string): string {
  if (!READ_FILE_RESULT_RE.test(value)) return value;
  const body = extractDelimitedReadFileBody(value);
  if (!body) return "";
  return collectPlanEvidenceSourceSignals(body, 220);
}

function evidenceDetailLooksLikePathEcho(detail: string, target: string): boolean {
  const normalizedDetail = String(detail || "")
    .replace(/[`"'，。；;:：|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const normalizedTarget = String(target || "")
    .replace(/\\/g, "/")
    .replace(/[`"'，。；;:：|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalizedDetail || !normalizedTarget) return false;
  if (normalizedDetail === normalizedTarget) return true;
  return normalizedDetail.startsWith(`${normalizedTarget} `);
}

export function summarizePlanEvidenceDetail(input: {
  tool?: string;
  target?: string;
  content?: string;
  maxChars?: number;
}): string {
  const maxChars = Math.max(80, input.maxChars || 180);
  const raw = String(input.content || "").trim();
  if (!raw) return "";
  const parsedFeedback = parseToolFeedbackEnvelope(raw);
  const source = parsedFeedback ? (parsedFeedback.body || parsedFeedback.envelope.summary || "") : raw;
  const target = normalizePathLikeCandidate(input.target || parsedFeedback?.envelope.target || "");

  const withoutReadMetadata = stripReadFileMetadataText(source);
  const stripped = withoutReadMetadata || (!READ_FILE_RESULT_RE.test(source) ? source : "");
  if (!stripped) return "";

  const detail = stripToolMetaFields(stripped)
    .replace(/\b(?:node_modules|dist|build)\/[A-Za-z0-9_./@-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleanDetail = compactPlanLine(detail, maxChars, true);
  if (!cleanDetail) return "";
  if (evidenceDetailLooksLikePathEcho(cleanDetail, target)) return "";
  return cleanDetail;
}

function stripToolMetaFields(value: string): string {
  return value
    .replace(TOOL_META_FIELD_RE, " ")
    .replace(/\bREAD_FILE_RESULT\b/gi, " ")
    .replace(/\bpath\s*:\s*/gi, " ")
    .replace(/\b\d[\d,]*\s+chars\b/gi, " ")
    .replace(/\b(?:summary|excerpt)\s*[:=]\s*;?\s*/gi, " ")
    .replace(/(?:^|[\s;])(?:true|false|null)(?=$|[\s;])/gi, " ")
    .replace(/^[\s;:,.|]+/, "")
    .replace(/[{}[\]"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePathLikeCandidate(value: unknown): string {
  const raw = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .trim();
  if (!raw || isPlanArtifactPath(raw) || isInternalPlanEvidenceText(raw)) return "";
  if (/ContextMemory|ContextState|\[ContextMemory|^\.\.\.\[/i.test(raw)) return "";

  const direct = raw
    .split(/\s+via\s+|\s*;\s*|\s+hash\s*[:=]|\s+status\s*[:=]/i)[0]
    .replace(/^\s*(?:path|target)\s*[:=]\s*/i, "")
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .trim();
  if (
    direct &&
    !isPlanArtifactPath(direct) &&
    !isInternalPlanEvidenceText(direct) &&
    ACTIONABLE_PLAN_FILE_RE.test(direct)
  ) {
    return direct.replace(/^\.\//, "");
  }

  const pathMatch = raw.match(PATH_LIKE_RE);
  const candidate = pathMatch?.find((item) => !isPlanArtifactPath(item) && !isInternalPlanEvidenceText(item)) || "";
  return candidate.replace(/^\.\//, "");
}

function normalizeSemanticToolEvidence(input: {
  tool: string;
  target: string;
  detail?: string;
  status?: string;
}): string {
  const tool = String(input.tool || "").trim();
  if (!SEMANTIC_EVIDENCE_TOOLS.has(tool)) return "";
  const status = String(input.status || "").trim().toLowerCase();
  if (/failed|blocked|rejected|declined/.test(status)) return "";
  const rawTarget = String(input.target || "").trim();
  if (/^\*\*\/\*\.(?:tsx?|jsx?)$/i.test(rawTarget)) return "";
  if (BROAD_OR_NOISY_SEARCH_TARGET_RE.test(rawTarget)) return "";
  const target = normalizePathLikeCandidate(rawTarget) || compactPlanLine(rawTarget, 120);
  if (!target || isPlanArtifactPath(target)) return "";
  if (BROAD_OR_NOISY_SEARCH_TARGET_RE.test(target)) return "";
  if (/^\*\*\/\*\.(?:tsx?|jsx?)$/i.test(target) || (/^\*\*\//.test(rawTarget) && /node_modules/i.test(String(input.detail || "")))) {
    return "";
  }
  const detail = summarizePlanEvidenceDetail({
    tool,
    target,
    content: String(input.detail || ""),
    maxChars: 180,
  });
  if (isInternalPlanEvidenceText(detail)) return "";
  const cleanDetail = compactPlanLine(detail, 160);
  if (/^(?:read_file|read_file_window|read_document|get_file_outline)$/i.test(tool) && !cleanDetail) {
    return "";
  }
  if (tool === "grep_search" && cleanDetail && TOOL_DETAIL_NON_EVIDENCE_RE.test(cleanDetail) && !TOOL_DETAIL_HAS_SOURCE_SIGNAL_RE.test(cleanDetail)) {
    return "";
  }
  return [tool, target].filter(Boolean).join(" ") + (cleanDetail ? `; excerpt=${cleanDetail}` : "");
}

export function formatPlanEvidenceRecord(record: PlanEvidenceRecord, language: "zh" | "en" = "zh"): string {
  const normalized = normalizeSemanticToolEvidence({
    tool: record.tool,
    target: record.target,
    status: record.status,
    detail: record.summary,
  });
  if (!normalized) return "";
  return summarizeEvidenceLine(normalized, language);
}

function sanitizeEvidenceLine(value: unknown, language: "zh" | "en"): { value: string; reason?: string } {
  const raw = String(value || "").trim();
  if (!raw) return { value: "", reason: "empty" };
  if (PROTOCOL_NOISE_RE.test(raw)) return { value: "", reason: "protocol_noise" };
  if (/ContextMemory|ContextState|\[ContextMemory/i.test(raw)) return { value: "", reason: "context_memory" };
  if (isInternalPlanEvidenceText(raw)) return { value: "", reason: "plan_artifact_evidence" };
  if (isPlanPromptInstructionText(raw)) return { value: "", reason: "control_prompt" };

  const envelope = parseToolFeedbackEnvelope(raw);
  if (envelope) {
    const status = envelope.envelope.status;
    if (status !== "completed" && status !== "cached" && status !== "no_op") {
      return { value: "", reason: "tool_failed" };
    }
    const normalized = normalizeSemanticToolEvidence({
      tool: envelope.envelope.tool,
      target: envelope.envelope.target,
      detail: envelope.envelope.summary,
      status,
    });
    return normalized ? { value: normalized } : { value: "", reason: "non_semantic_tool" };
  }

  if (
    isPlanArtifactPath(raw) &&
    /(?:write_file|replace_in_file|PLAN NOT READY|status\s*[:=]\s*(?:failed|blocked|rejected))/i.test(raw)
  ) {
    return { value: "", reason: "plan_artifact_tool_log" };
  }
  if (/Repeated read-only tool call skipped|Duplicate skip count|FILE_UNCHANGED_STUB|already called with identical arguments/i.test(raw)) {
    return { value: "", reason: "repeated_read_noise" };
  }

  const statusMatch = raw.match(/\bstatus\s*[:=]\s*([a-z_]+)/i);
  const semicolonToolEvidence = raw.match(/^\s*([a-z_][a-z0-9_]*)\s*(?:;|\s+)\s*([^;\n]{1,220})(?:\s*;\s*([\s\S]{1,420}))?/i);
  if (semicolonToolEvidence) {
    const normalized = normalizeSemanticToolEvidence({
      tool: semicolonToolEvidence[1] || "",
      target: semicolonToolEvidence[2] || "",
      detail: semicolonToolEvidence[3] || "",
      status: statusMatch?.[1] || "",
    });
    if (normalized) return { value: normalized };
    if (SEMANTIC_EVIDENCE_TOOLS.has(semicolonToolEvidence[1] || "")) {
      if (READ_FILE_RESULT_RE.test(semicolonToolEvidence[3] || raw)) {
        return { value: "", reason: "raw_read_file_metadata" };
      }
      return { value: "", reason: /failed|blocked|rejected/i.test(statusMatch?.[1] || "") ? "tool_failed" : "non_semantic_tool" };
    }
  }

  const keyedToolName =
    raw.match(/\btool\s*[:=]\s*([a-z_][a-z0-9_]*)/i)?.[1] ||
    raw.match(/\bname\s*[:=]\s*([a-z_][a-z0-9_]*)/i)?.[1] ||
    "";
  const keyedTarget =
    raw.match(/\btarget\s*[:=]\s*([^;\n,}]{1,220})/i)?.[1] ||
    raw.match(/\bpath\s*[:=]\s*([^;\n,}]{1,220})/i)?.[1] ||
    "";
  if (keyedToolName && keyedTarget) {
    const normalized = normalizeSemanticToolEvidence({
      tool: keyedToolName,
      target: keyedTarget,
      detail: raw.match(/\b(?:summary|excerpt)\s*[:=]\s*([^;\n}]{1,260})/i)?.[1] || "",
      status: statusMatch?.[1] || "",
    });
    if (!normalized && READ_FILE_RESULT_RE.test(raw)) return { value: "", reason: "raw_read_file_metadata" };
    return normalized ? { value: normalized } : { value: "", reason: "non_semantic_tool" };
  }

  if (READ_FILE_RESULT_RE.test(raw)) {
    const path = normalizePathLikeCandidate(raw);
    const detail = summarizePlanEvidenceDetail({
      tool: "read_file",
      target: path,
      content: raw,
      maxChars: 180,
    });
    if (path && detail && !/status\s*[:=]\s*(?:failed|blocked|rejected)/i.test(raw)) {
      return { value: `read_file ${path}; excerpt=${detail}` };
    }
    return { value: "", reason: "raw_read_file_metadata" };
  }

  if (RAW_TOOL_RESULT_NOISE_RE.test(raw)) {
    const path = normalizePathLikeCandidate(raw);
    if (path && !/status\s*[:=]\s*(?:failed|blocked|rejected)/i.test(raw)) {
      return { value: language === "zh" ? `已读取文件：${path}` : `Read file: ${path}` };
    }
    return { value: "", reason: "raw_tool_result" };
  }

  const clean = compactPlanLine(stripToolMetaFields(raw), 200);
  if (!clean) return { value: "", reason: "tool_log_noise" };
  if (/^(?:\]|\.\.\.|\[|\{|\})$/.test(clean)) return { value: "", reason: "syntax_fragment" };
  if (isPathEchoEvidence(clean)) return { value: "", reason: "path_echo_evidence" };
  return { value: clean };
}

export function sanitizePlanEvidenceInput(input: {
  userGoal?: string;
  evidence?: unknown[];
  evidenceRecords?: PlanEvidenceRecord[];
  files?: unknown[];
  constraints?: unknown[];
  language?: "zh" | "en";
  maxEvidence?: number;
  maxFiles?: number;
  maxConstraints?: number;
}): SanitizedPlanEvidenceInput {
  const language = input.language === "en" ? "en" : "zh";
  const dropped: PlanEvidenceSanitizerDrop[] = [];
  const dropReasons: Record<string, number> = {};
  const addDrop = (bucket: PlanEvidenceSanitizerDrop["bucket"], reason: string, value: unknown) => {
    noteSanitizerDrop(dropped, bucket, reason, value);
    dropReasons[reason] = (dropReasons[reason] || 0) + 1;
  };
  const unique = (values: string[], maxItems: number, maxChars: number) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const normalized = sanitizePlanArtifactContent(String(value || ""))
        .replace(/\s+/g, " ")
        .trim();
      const compacted = normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars).trim()}...`;
      if (!compacted) continue;
      const key = compacted.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(compacted);
      if (result.length >= maxItems) break;
    }
    return result;
  };

  const evidence: string[] = [];
  let keptStructuredEvidence = 0;
  for (const record of input.evidenceRecords || []) {
    const formatted = formatPlanEvidenceRecord(record, language);
    if (formatted) {
      keptStructuredEvidence += 1;
      evidence.push(formatted);
    } else {
      addDrop("evidence", "non_semantic_structured_tool", record);
    }
  }
  for (const item of input.evidence || []) {
    const sanitized = sanitizeEvidenceLine(item, language);
    if (sanitized.value) {
      evidence.push(sanitized.value);
    } else {
      addDrop("evidence", sanitized.reason || "empty", item);
    }
  }

  const files: string[] = [];
  for (const item of input.files || []) {
    const path = normalizePathLikeCandidate(item);
    if (path) {
      files.push(path);
    } else {
      addDrop("files", isPlanArtifactPath(item) ? "plan_artifact_path" : "non_path", item);
    }
  }
  for (const item of evidence) {
    const path = normalizePathLikeCandidate(item);
    if (path) files.push(path);
  }

  const constraints: string[] = [];
  for (const item of input.constraints || []) {
    const clean = cleanPlanItem(item, 220);
    if (
      clean &&
      !RAW_TOOL_RESULT_NOISE_RE.test(clean) &&
      !PROTOCOL_NOISE_RE.test(clean) &&
      !isPlanPromptInstructionText(clean)
    ) {
      constraints.push(clean);
    } else {
      addDrop("constraints", isPlanPromptInstructionText(item) ? "control_prompt" : "constraint_noise", item);
    }
  }

  const primaryUserGoal = extractPrimaryUserRequestText(String(input.userGoal || ""));
  const cleanUserGoal = compactPlanLine(primaryUserGoal || input.userGoal || "", 600);
  const cleanEvidence = unique(evidence, Math.max(1, Number(input.maxEvidence) || 12), 220);
  const cleanFiles = unique(files, Math.max(1, Number(input.maxFiles) || 12), 180);
  const cleanConstraints = unique(constraints, Math.max(1, Number(input.maxConstraints) || 6), 220);

  return {
    userGoal: cleanUserGoal,
    evidence: cleanEvidence,
    files: cleanFiles,
    constraints: cleanConstraints,
    dropped,
    stats: {
      inputEvidence: (input.evidence || []).length + (input.evidenceRecords || []).length,
      keptEvidence: cleanEvidence.length,
      inputStructuredEvidence: (input.evidenceRecords || []).length,
      keptStructuredEvidence,
      inputFiles: (input.files || []).length,
      keptFiles: cleanFiles.length,
      inputConstraints: (input.constraints || []).length,
      keptConstraints: cleanConstraints.length,
      dropped: dropped.length,
      dropReasons,
    },
  };
}

interface ParsedPlanSection {
  title: string;
  body: string;
}

function matchPlanOutlineHeading(line: string): string {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.length > 120) return "";
  if (/^\s*(?:[-*+]|\d+[.)、])\s+/.test(trimmed)) return "";
  const colonDetail = trimmed.match(/^(.+?)[：:]\s*(.+)$/);
  if (colonDetail && (colonDetail[2] || "").trim().length > 36) return "";
  return FORMAL_PLAN_OUTLINE_HEADING_RE.test(trimmed) ? trimmed : "";
}

function countFormalPlanOutlineHeadings(content: string): number {
  return String(content || "")
    .split(/\r?\n/)
    .filter((line) => matchPlanOutlineHeading(line))
    .length;
}

function parsePlanSections(content: string): ParsedPlanSection[] {
  const sections: ParsedPlanSection[] = [];
  let title = "";
  let body: string[] = [];
  for (const line of String(content || "").split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    const outlineHeading = heading ? "" : matchPlanOutlineHeading(line);
    if (heading || outlineHeading) {
      if (title || body.join("\n").trim()) {
        sections.push({ title, body: body.join("\n") });
      }
      title = heading?.[1] || outlineHeading;
      body = [];
    } else {
      body.push(line);
    }
  }
  if (title || body.join("\n").trim()) {
    sections.push({ title, body: body.join("\n") });
  }
  return sections;
}

function collectSectionTitles(
  sections: ParsedPlanSection[],
  patterns: RegExp[],
  maxItems: number,
): string[] {
  return uniquePlanItems(
    sections
      .map((section) => section.title)
      .filter((title) => patterns.some((pattern) => pattern.test(title))),
    maxItems,
    1000,
    true,
  );
}

function collectLinesFromSections(
  sections: ParsedPlanSection[],
  patterns: RegExp[],
  maxItems: number,
  maxChars = 220,
  preserveFormatting = false,
): string[] {
  const values: string[] = [];
  for (const section of sections) {
    if (!patterns.some((pattern) => pattern.test(section.title))) continue;
    values.push(...section.body.split(/\r?\n/));
  }
  return uniquePlanItems(values, maxItems, maxChars, preserveFormatting);
}

function collectPathLikePlanItems(content: string, maxItems = 8): string[] {
  const values: string[] = [];
  for (const match of String(content || "").matchAll(/`([^`\n]+\.(?:tsx?|jsx?|swift|py|rs|go|json|csv|tsv|xlsx|md|css|scss|html))`/gi)) {
    values.push(match[1] || "");
  }
  for (const match of String(content || "").matchAll(/\b(?:src|app|lib|components|tests|pages|hooks|store|styles|assets)\/[A-Za-z0-9_./-]+\b/g)) {
    values.push(match[0] || "");
  }
  return uniquePlanItems(values, maxItems, 160);
}

function isSpeculativePlanLine(line: string): boolean {
  return /(?:可能|也许|大概|概率|疑似|推测|假设|probably|possibly|likely|hypothesis|assumption)/i.test(line);
}

function summarizeToolActivityForEvidence(activity: PlanMaterializationToolActivityLike): string {
  if (!activity || activity.status === "failed") return "";
  const rawTool = String(activity.name || "").trim();
  const tool = /^[a-z_][a-z0-9_]*$/i.test(rawTool)
    ? rawTool
    : cleanPlanItem(rawTool, 40).replace(/\s+/g, "_");
  const target = cleanPlanItem(activity.target, 120);
  const detail = summarizePlanEvidenceDetail({
    tool,
    target,
    content: activity.detail || "",
    maxChars: 180,
  }) || (READ_FILE_RESULT_RE.test(String(activity.detail || "")) ? "" : cleanPlanItem(activity.detail, 160));
  if (!tool && !target && !detail) return "";
  return [tool, target].filter(Boolean).join(" ") + (detail ? `; excerpt=${detail}` : "");
}

function buildProvidedContextObservation(input: {
  turnContext?: TurnInputContextLike | null;
  language: "zh" | "en";
}): string {
  const context = normalizeTurnInputContextSignals(input.turnContext || {});
  const parts: string[] = [];
  if (context.imageParts > 0) {
    parts.push(input.language === "zh"
      ? `用户提供了 ${context.imageParts} 张图片；当前规范化只记录图片存在这一事实，未凭空补充无法验证的视觉细节。`
      : `The user provided ${context.imageParts} image(s); canonicalization records that fact without inventing unverifiable visual details.`);
  }
  if (context.mentionedFilePaths.length > 0) {
    parts.push(input.language === "zh"
      ? `用户提到了 ${context.mentionedFilePaths.length} 个 @ 文件：${context.mentionedFilePaths.slice(0, 4).join(", ")}。`
      : `The user mentioned ${context.mentionedFilePaths.length} @ file(s): ${context.mentionedFilePaths.slice(0, 4).join(", ")}.`);
  }
  if (context.attachedFilePaths.length > 0) {
    parts.push(input.language === "zh"
      ? `用户附加了 ${context.attachedFilePaths.length} 个文件：${context.attachedFilePaths.slice(0, 4).join(", ")}。`
      : `The user attached ${context.attachedFilePaths.length} file(s): ${context.attachedFilePaths.slice(0, 4).join(", ")}.`);
  }
  if (parts.length > 0) return parts.join(" ");
  return input.language === "zh"
    ? "未提供截图/附件；计划基于用户目标和已读证据。"
    : "No screenshot or attachment was provided; the plan is based on the user goal and read evidence.";
}

function isMarkdownTableRowLine(line: string): boolean {
  const text = String(line || "").trim();
  return text.startsWith("|") && text.endsWith("|") && text.slice(1, -1).includes("|");
}

function isMarkdownTableSeparatorLine(line: string): boolean {
  const text = String(line || "").trim();
  if (!isMarkdownTableRowLine(text)) return false;
  const cells = text
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function formatCodexPlanSection(title: string, lines: string[]): string {
  const output = [`## ${title}`];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!isMarkdownTableRowLine(line)) {
      output.push(`- ${line}`);
      index += 1;
      continue;
    }

    const tableLines: string[] = [];
    while (index < lines.length && isMarkdownTableRowLine(lines[index])) {
      tableLines.push(lines[index].trim());
      index += 1;
    }

    if (tableLines.length >= 2 && tableLines.some(isMarkdownTableSeparatorLine)) {
      if (output.length > 1 && output[output.length - 1] !== "") output.push("");
      output.push(...tableLines);
      if (index < lines.length) output.push("");
    } else {
      output.push(...tableLines.map((tableLine) => `- ${tableLine}`));
    }
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function extractInlineCommands(values: string[], maxItems = 4): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const value of values) {
    for (const match of String(value || "").matchAll(/`([^`\n]{2,160})`/g)) {
      const command = String(match[1] || "").trim();
      if (!command || seen.has(command.toLowerCase())) continue;
      if (!/(?:npm|pnpm|yarn|node|cargo|pytest|python|go test|bun|vitest|playwright|tsc|build|test|lint)/i.test(command)) continue;
      seen.add(command.toLowerCase());
      commands.push(command);
      if (commands.length >= maxItems) return commands;
    }
  }
  return commands;
}

function buildInsufficientEvidencePlan(input: { goal: string; language: "zh" | "en" }): string {
  if (input.language === "en") {
    const summary = input.goal
      ? [`User goal: ${input.goal}`, "Insufficient targeted evidence exists to produce a decision-complete Codex-style plan."]
      : ["Blocked: the user goal is empty, so a reviewable implementation target cannot be derived."];
    return [
      "# Plan",
      formatCodexPlanSection("Summary", summary),
      formatCodexPlanSection("Key Changes", [
        "Blocked: collect concrete source, data, command, or interface evidence before writing an approved plan.",
      ]),
    ].join("\n\n");
  }

  const summary = input.goal
    ? [`用户目标：${input.goal}`, "当前定向证据不足，不能生成 decision-complete 的 Codex-style Plan.md。"]
    : ["阻塞：用户目标为空，无法派生可审批的具体修复目标。"];
  return [
    "# 计划",
    formatCodexPlanSection("摘要", summary),
    formatCodexPlanSection("关键改动", [
      "阻塞：需要先补充具体源码、数据、命令或接口证据，再写入可审批计划。",
    ]),
  ].join("\n\n");
}

function summarizeGoalForPlanChange(goal: string, language: "zh" | "en"): string {
  const compact = compactPlanLine(goal, language === "zh" ? 42 : 56);
  if (!compact) return language === "zh" ? "用户请求" : "the user request";
  return compact.replace(/[。.!?？；;:：]\s*$/, "");
}

function buildDeterministicChangeLine(input: {
  file: string;
  goal: string;
  evidence: string;
  language: "zh" | "en";
}): string {
  const file = input.file;
  const lowerFile = file.toLowerCase();
  const goalAndFile = `${input.goal}\n${file}`;
  const evidence = input.evidence || (
    input.language === "zh" ? "已读项目证据确认该文件在影响范围内" : "read project evidence confirms this file is in scope"
  );
  if (input.language === "en") {
    if (CSV_DASHBOARD_GOAL_RE.test(goalAndFile) && /usecsvparser/.test(lowerFile)) {
      return `Fix CSV column-to-order-field mapping in \`${file}\` so Dashboard-required fields such as creator/course/date/status/amount are not dropped. Grounding evidence: ${evidence}.`;
    }
    if (CSV_DASHBOARD_GOAL_RE.test(goalAndFile) && /dashboardstore/.test(lowerFile)) {
      return `Fix the imported-data path in \`${file}\` so Dashboard metrics and charts consume the uploaded CSV data instead of stale/default state. Grounding evidence: ${evidence}.`;
    }
    if (CSV_DASHBOARD_GOAL_RE.test(goalAndFile) && /usechartdata|dashboard|chart/.test(lowerFile)) {
      return `Align chart data derivation in \`${file}\` with the imported order records for rankings, trends, month-over-month metrics, and order status. Grounding evidence: ${evidence}.`;
    }
    if (DARK_THEME_GOAL_RE.test(goalAndFile) && /app\.tsx|index\.css|theme|style|dashboard|component/.test(lowerFile)) {
      return `Update \`${file}\` to use coherent dark-theme surfaces, tokens, and chart/container contrast instead of light backgrounds with isolated dark boxes. Grounding evidence: ${evidence}.`;
    }
    return `Update \`${file}\` at the confirmed implementation boundary for the user goal, then verify the affected behavior with the focused check. Grounding evidence: ${evidence}.`;
  }

  if (CSV_DASHBOARD_GOAL_RE.test(goalAndFile) && /usecsvparser/.test(lowerFile)) {
    return `修复 \`${file}\` 的 CSV 列名到订单字段映射，确保 creator、course、date、status、amount 等 Dashboard 所需字段不会在导入时丢失。依据证据：${evidence}。`;
  }
  if (CSV_DASHBOARD_GOAL_RE.test(goalAndFile) && /dashboardstore/.test(lowerFile)) {
    return `修复 \`${file}\` 中导入数据进入 Dashboard 状态与统计源的链路，确保课程排行、销售趋势、月度环比和订单状态读取上传后的真实数据。依据证据：${evidence}。`;
  }
  if (CSV_DASHBOARD_GOAL_RE.test(goalAndFile) && /usechartdata|dashboard|chart/.test(lowerFile)) {
    return `调整 \`${file}\` 的图表数据派生，让排行、趋势、环比和状态图表与导入后的订单记录保持一致。依据证据：${evidence}。`;
  }
  if (DARK_THEME_GOAL_RE.test(goalAndFile) && /app\.tsx|index\.css|theme|style|dashboard|component/.test(lowerFile)) {
    return `更新 \`${file}\` 的深色模式表面、主题 token、图表/容器对比度，避免白底页面上局部套深色框的割裂显示。依据证据：${evidence}。`;
  }
  return `更新 \`${file}\` 中已确认影响用户目标的字段、状态或界面处理，并用聚焦验证确认行为变化。依据证据：${evidence}。`;
}

function buildCodexStylePlanArtifact(input: {
  userGoal: string;
  evidence: string[];
  files: string[];
  constraints: string[];
  language: "zh" | "en";
}): string {
  const goal = compactPlanLine(input.userGoal, 420);
  const rawEvidence = uniqueCompactLines(input.evidence, 10, 220);
  const concreteEvidence = rawEvidence.filter(isConcretePlanEvidence);
  const meaningfulConcreteEvidence = concreteEvidence.filter(isMeaningfulConcretePlanEvidence);
  const evidence = (meaningfulConcreteEvidence.length > 0
    ? meaningfulConcreteEvidence
    : rawEvidence.filter((item) => !isBroadDiscoveryEvidence(item))
  ).slice(0, 8);
  const rawFiles = uniqueCompactLines(input.files, 10, 160).filter(isActionablePlanFile);
  const filesWithConcreteEvidence = rawFiles.filter((file) =>
    evidence.some((item) => evidenceMentionsFile(item, file))
  );
  const files = (filesWithConcreteEvidence.length > 0 ? filesWithConcreteEvidence : rawFiles).slice(0, 8);
  const constraints = uniqueCompactLines(input.constraints, 5, 200);
  const commands = extractInlineCommands([...evidence, ...constraints]);
  const hasGroundedEvidence = Boolean(goal) &&
    evidence.length > 0 &&
    meaningfulConcreteEvidence.length > 0 &&
    (files.length > 0 || /CSV|TSV|XLSX|字段|列|指标|数据|表格|dataset|table|metric|column/i.test(`${goal}\n${evidence.join("\n")}`));

  if (!hasGroundedEvidence) {
    return buildInsufficientEvidencePlan({ goal, language: input.language });
  }
  const goalSummary = summarizeGoalForPlanChange(goal, input.language);

  if (input.language === "en") {
    const scope = files.length > 0 ? files.map((file) => `\`${file}\``).join(", ") : "the confirmed data/reporting surface";
    const changes = files.length > 0
      ? files.slice(0, 6).map((file) => buildDeterministicChangeLine({
          file,
          goal,
          evidence: pickEvidenceForFile(evidence, file),
          language: "en",
        }))
      : [`Implement the confirmed data/reporting change for ${goalSummary} using the inspected evidence: ${evidence[0]}.`];
    return [
      "# Plan",
      formatCodexPlanSection("Summary", [
        `User goal: ${goal}`,
        `Grounding evidence covers ${scope}.`,
        evidence[0] ? `Most relevant evidence: ${evidence[0]}.` : "No additional evidence summary is trusted.",
      ]),
      formatCodexPlanSection("Key Changes", changes),
      formatCodexPlanSection("Public APIs / Interfaces / Types", [
        "No public API, interface, or type change is planned by default; if implementation proves one is required, pause before widening scope.",
      ]),
      formatCodexPlanSection("Test Plan", commands.length > 0
        ? commands.map((command) => `Run \`${command}\` and inspect exit status/output.`)
        : [
            "Run the focused test, build, or browser/desktop validation for the touched subsystem and record the result.",
          ]),
      formatCodexPlanSection("Assumptions / Defaults", constraints.length > 0
      ? constraints
      : [
          "Default to the smallest implementation that satisfies the user goal.",
          "Do not trust new assumptions discovered during implementation until a targeted read or validation confirms them.",
        ]),
    ].join("\n\n");
  }

  const scope = files.length > 0 ? files.map((file) => `\`${file}\``).join("、") : "已确认的数据/报表链路";
  const changes = files.length > 0
    ? files.slice(0, 6).map((file) => buildDeterministicChangeLine({
        file,
        goal,
        evidence: pickEvidenceForFile(evidence, file),
        language: "zh",
      }))
    : [`基于已确认的证据实施与“${goalSummary}”相关的数据/报表改动：${evidence[0]}。`];
  return [
    "# 计划",
    formatCodexPlanSection("摘要", [
      `用户目标：${goal}`,
      `定向证据已覆盖：${scope}。`,
      evidence[0] ? `最相关证据：${evidence[0]}。` : "暂无可额外信任的证据摘要。",
    ]),
    formatCodexPlanSection("关键改动", changes),
    formatCodexPlanSection("公共 API / 接口 / 类型", [
      "默认不新增或修改公共 API、接口或类型；如果执行中证明必须扩大接口范围，先暂停确认。",
    ]),
    formatCodexPlanSection("测试方案", commands.length > 0
      ? commands.map((command) => `运行 \`${command}\` 并检查退出码与输出。`)
      : [
          "运行受影响子系统的聚焦测试、构建检查或浏览器/桌面验证，并记录结果。",
        ]),
    formatCodexPlanSection("假设与默认值", constraints.length > 0
      ? constraints
      : [
          "默认实施满足已批准目标的最小变更。",
          "执行中新发现的假设必须先通过定向读取或验证确认，不能直接当成事实。",
        ]),
  ].join("\n\n");
}

export function canonicalizePlanArtifactContent(input: {
  content: string;
  userGoal?: string;
  evidence?: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  files?: string[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
  turnContext?: TurnInputContextLike | null;
  language?: "zh" | "en";
}): string | null {
  const raw = String(input.content || "").trim();
  if (!raw || TOOL_LOG_NOISE_RE.test(raw) || PROTOCOL_NOISE_RE.test(raw)) return null;
  const language = detectMaterializationLanguage({
    content: raw,
    userGoal: input.userGoal,
    language: input.language,
  });
  const sections = parsePlanSections(raw);
  const title = sections.find((section) => section.title)?.title || "";
  const context = normalizeTurnInputContextSignals(input.turnContext || {});
  const providedContextCount =
    context.imageParts + context.mentionedFilePaths.length + context.attachedFilePaths.length;

  const explicitInputGoal = compactPlanLine(input.userGoal, 420, true);
  const goalSectionTitles = explicitInputGoal ? [] : collectSectionTitles(sections, [
    /(?:正式计划|修复计划|用户目标|目标|需求|问题|Goal|Objective|User Request|Problem|Issue)/i,
  ], 3).filter((line) =>
    !/^(?:用户目标(?:与约束)?|目标|需求|问题|Goal|Objective|User Request|Problem|Issue)$/i.test(line.trim())
  );
  const goalLines = uniquePlanItems([
    explicitInputGoal,
    ...(explicitInputGoal ? [] : collectLinesFromSections(sections, [
      /(?:正式计划|修复计划|用户目标|目标|需求|问题|Goal|Objective|User Request|Problem|Issue)/i,
    ], 3, 2000, true)),
    ...(explicitInputGoal ? [] : goalSectionTitles),
    !explicitInputGoal && !/^(?:Plan|Proposed Plan|计划|计划草稿|修复方案)$/i.test(title) ? title : "",
  ], 3, 2000, true);
  const screenshotLines = collectLinesFromSections(sections, [
    /(?:截图|附件|图片|视觉|观察|Screenshot|Attachment|Visual|Provided Context|Observation)/i,
  ], 4, 2000, true);
  const visibleEvidenceLines = collectLinesFromSections(sections, [
    /(?:已读证据|证据引用|证据|读取|调查|Evidence|References|Read Evidence|Context Read)/i,
  ], 6, 2000, true);
  const inlineEvidenceLines = uniquePlanItems(raw.split(/\r?\n/).filter((line) => {
    const cleaned = cleanPlanItem(line, 2000, true);
    return isConcretePlanEvidence(cleaned) || isBroadDiscoveryEvidence(cleaned);
  }), 8, 2000, true);
  const activityEvidence = uniquePlanItems(
    (input.recentToolActivity || [])
      .map(summarizeToolActivityForEvidence)
      .map((item) => summarizeEvidenceLine(item, language)),
    8,
    2000,
    true
  );
  const structuredEvidence = uniquePlanItems(
    (input.evidenceRecords || [])
      .map((record) => formatPlanEvidenceRecord(record, language)),
    8,
    2000,
    true
  );
  const externalEvidence = uniquePlanItems(
    (input.evidence || []).map((item) => summarizeEvidenceLine(item, language)),
    8,
    2000,
    true
  );
  const evidenceLines = uniquePlanItems([
    ...structuredEvidence,
    ...externalEvidence,
    ...activityEvidence,
    ...visibleEvidenceLines,
    ...inlineEvidenceLines,
    providedContextCount > 0
      ? buildProvidedContextObservation({ turnContext: input.turnContext, language })
      : "",
  ], 10, 2000, true);
  const concreteEvidenceLines = evidenceLines.filter(isConcretePlanEvidence);

  const visibleFindingLines = uniquePlanItems([
    ...collectSectionTitles(sections, [
      /(?:已确认|真实发现|当前发现|发现|调查摘要|分析|根因|原因|问题|Investigation Summary|Analysis|Root Cause|Confirmed|Findings|Current State|Observation|Issue)/i,
    ], 6),
    ...collectLinesFromSections(sections, [
      /(?:已确认|真实发现|当前发现|发现|调查摘要|分析|根因|原因|问题|Investigation Summary|Analysis|Root Cause|Confirmed|Findings|Current State|Observation|Issue)/i,
    ], 8, 2000, true),
  ], 8, 2000, true);
  const hypothesisLines = uniquePlanItems([
    ...collectLinesFromSections(sections, [
      /(?:未验证|假设|待确认|可能|根因|原因|问题|风险|注意|边界|Unverified|Hypotheses|Assumptions|Unknowns|Risks|Caveats|Root Cause|Likely|Issue)/i,
    ], 8, 2000, true),
    ...visibleFindingLines.filter(isSpeculativePlanLine),
  ], 6, 2000, true);
  const fileLines = uniquePlanItems([
    ...(input.files || []),
    ...(input.recentToolActivity || []).map((activity) => activity.target || ""),
    ...collectLinesFromSections(sections, [
      /(?:影响文件|相关文件|文件|接口|组件|Affected|Files|Interfaces|Components|Paths)/i,
    ], 8, 1000, true),
    ...collectPathLikePlanItems(raw),
  ], 10, 1000, true);
  if (
    fileLines.some(isActionablePlanFile) &&
    concreteEvidenceLines.length === 0 &&
    evidenceLines.some(isBroadDiscoveryEvidence)
  ) {
    return null;
  }
  const stepLines = uniquePlanItems([
    ...collectLinesFromSections(sections, [
      /(?:执行|实施|方案|计划|步骤|修复|落地|Approach|Implementation|Plan of Work|Plan|Steps|Fix)/i,
    ], 8, 4000, true),
  ], 8, 4000, true).filter((line) =>
    !/(?:与用户目标直接相关的最小改动|smallest user-goal-specific change|落实已批准目标|approved goal)/i.test(line)
  );
  const riskLines = uniquePlanItems([
    ...collectLinesFromSections(sections, [
      /(?:风险|取舍|注意|边界|默认|后续|Risks|Tradeoffs|Caveats|Boundary|Default|Follow-up)/i,
    ], 5, 2000, true),
  ], 5, 2000, true);
  const validationLines = collectLinesFromSections(sections, [
    /(?:验证|测试|构建|验收|Validation|Testing|Acceptance|Build|Checks)/i,
  ], 5, 4000, true);

  const hasRequiredSignals = [
    goalLines.length > 0,
    evidenceLines.length > 0,
    stepLines.length > 0,
    validationLines.length > 0,
    fileLines.length > 0 || collectPathLikePlanItems(raw, 1).length > 0,
  ].filter(Boolean).length;
  if (hasRequiredSignals < 4 || goalLines.length === 0 || stepLines.length === 0 || validationLines.length === 0) {
    return null;
  }
  if (evidenceLines.length === 0 && providedContextCount === 0) return null;

  const summaryLines = uniquePlanItems([
    ...goalLines.map((line) => language === "zh" ? `用户目标：${line}` : `User goal: ${line}`),
    ...evidenceLines.slice(0, 3),
    ...(screenshotLines.length > 0
      ? screenshotLines.slice(0, 2)
      : [buildProvidedContextObservation({ turnContext: input.turnContext, language })]),
  ], 6, 2000, true);
  const goalForChanges = goalLines[0] || explicitInputGoal || input.userGoal || "";
  const fileChangeEvidence = concreteEvidenceLines.length > 0
    ? concreteEvidenceLines
    : evidenceLines.filter((line) => !isBroadDiscoveryEvidence(line));
  const fileDerivedChangeLines = fileLines.slice(0, 4).flatMap((file) => {
    const grounding = pickEvidenceForFile(fileChangeEvidence, file);
    if (!grounding) return [];
    return [buildDeterministicChangeLine({
      file,
      goal: goalForChanges,
      evidence: grounding,
      language,
    })];
  });
  const keyChangeLines = uniquePlanItems([
    ...stepLines,
    ...fileDerivedChangeLines,
  ], 8, 4000, true);
  if (keyChangeLines.length === 0) return null;
  const assumptionLines = uniquePlanItems([
    ...hypothesisLines,
    ...riskLines,
    language === "zh"
      ? "默认保持未点名的公共 API、接口和类型不变。"
      : "Default to preserving public APIs, interfaces, and types that are not explicitly named.",
  ], 6, 2000, true);
  const apiLines = collectLinesFromSections(sections, [
    /(?:公共\s*API|接口(?:变化|变更)?|类型(?:变化|变更)?|API|Public|Interface|Types?)/i,
  ], 4, 2000, true).filter((line) =>
    /(?:无|不|保持|新增|修改|变化|变更|No|unchanged|changed|added|modified|preserved)/i.test(line) &&
    !/`[^`]+\.(?:tsx?|jsx?|rs|py|go|json|md|css|scss|html)`/.test(line)
  );
  const resolvedApiLines = apiLines.length > 0
    ? apiLines
    : [language === "zh"
      ? "无公共 API、接口或类型变化；如果执行中证明必须改变，先暂停确认。"
      : "No public API, interface, or type change is planned; pause if implementation proves one is required."];

  if (language === "en") {
    return [
      "# Plan",
      formatCodexPlanSection("Summary", summaryLines),
      formatCodexPlanSection("Key Changes", keyChangeLines),
      formatCodexPlanSection("Public APIs / Interfaces / Types", resolvedApiLines),
      formatCodexPlanSection("Test Plan", validationLines),
      formatCodexPlanSection("Assumptions / Defaults", assumptionLines),
    ].join("\n\n");
  }

  return [
    "# 计划",
    formatCodexPlanSection("摘要", summaryLines),
    formatCodexPlanSection("关键改动", keyChangeLines),
    formatCodexPlanSection("公共 API / 接口 / 类型", resolvedApiLines),
    formatCodexPlanSection("测试方案", validationLines),
    formatCodexPlanSection("假设与默认值", assumptionLines),
  ].join("\n\n");
}

function summarizeEvidenceLine(value: string, language: "zh" | "en"): string {
  const raw = String(value || "");
  const labels = language === "zh" ? TOOL_LABELS_ZH : TOOL_LABELS_EN;
  const extractFeedbackField = (field: string, maxChars: number): string => {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = raw.match(new RegExp(`\\b${escapedField}["']?\\s*[:=]\\s*(?:"([^"]{1,${maxChars}})"|'([^']{1,${maxChars}})')`, "i"));
    if (quoted) return quoted[1] || quoted[2] || "";
    const unquoted = raw.match(new RegExp(`\\b${escapedField}["']?\\s*[:=]\\s*([^\\s,;}]{1,${maxChars}})`, "i"));
    return unquoted?.[1] || "";
  };
  const extractFeedbackTextField = (field: string, maxChars: number): string => {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = raw.match(new RegExp(`\\b${escapedField}["']?\\s*[:=]\\s*(?:"([^"]{1,${maxChars}})"|'([^']{1,${maxChars}})')`, "i"));
    if (quoted) return quoted[1] || quoted[2] || "";
    const unquoted = raw.match(new RegExp(`\\b${escapedField}["']?\\s*[:=]\\s*([^\\n}]{1,${maxChars}})`, "i"))?.[1] || "";
    return unquoted
      .replace(/\s+\b(?:status|hash|tool_call_id|toolCallId|target|path|tool|name)\s*[:=][\s\S]*$/i, "")
      .replace(/[;,]\s*$/, "")
      .trim();
  };
  const formatToolEvidence = (toolName: string, targetValue: string, detailValue = "") => {
    const label = labels[toolName];
    const target = compactPlanLine(targetValue, 96);
    if (!label || !target) return "";
    const explicitDetail =
      detailValue.match(/\bexcerpt\s*[:=]\s*([^;\n,}]{1,180})/i)?.[1] ||
      detailValue.match(/\bsummary\s*[:=]\s*([^;\n,}]{1,180})/i)?.[1] ||
      "";
    const detail = compactPlanLine(
      (explicitDetail || detailValue)
        .replace(/\b(?:status|hash|tool_call_id|toolCallId)\s*[:=]\s*[^;\n,}]+/gi, " ")
        .replace(/\bexcerpt\s*[:=]\s*/gi, language === "zh" ? "片段：" : "excerpt: ")
        .replace(/\bsummary\s*[:=]\s*/gi, language === "zh" ? "摘要：" : "summary: "),
      120,
    );
    const connector = language === "zh" ? "；发现：" : "; found: ";
    return `${label}${language === "zh" ? "：" : ": "}${target}${detail ? `${connector}${detail}` : ""}`;
  };

  const envelope = parseToolFeedbackEnvelope(raw);
  if (envelope) {
    const summarized = formatToolEvidence(
      envelope.envelope.tool || "",
      envelope.envelope.target || "",
      envelope.envelope.summary || "",
    );
    if (summarized) return summarized;
  }

  const semicolonToolEvidence = raw.match(/^\s*([a-z_][a-z0-9_]*)\s*;\s*([^;\n]{1,160})(?:\s*;\s*([\s\S]{1,240}))?/i);
  if (semicolonToolEvidence) {
    const summarized = formatToolEvidence(
      semicolonToolEvidence[1] || "",
      semicolonToolEvidence[2] || "",
      semicolonToolEvidence[3] || "",
    );
    if (summarized) return summarized;
  }

  const keyedToolName =
    extractFeedbackField("tool", 80).match(/^[a-z_][a-z0-9_]*$/i)?.[0] ||
    extractFeedbackField("name", 80).match(/^[a-z_][a-z0-9_]*$/i)?.[0] ||
    "";
  const keyedTarget =
    extractFeedbackField("target", 180) ||
    extractFeedbackField("path", 180) ||
    "";
  if (keyedToolName && keyedTarget) {
    const keyedDetail =
      extractFeedbackTextField("excerpt", 180) ||
      extractFeedbackTextField("summary", 180) ||
      "";
    const summarized = formatToolEvidence(keyedToolName, keyedTarget, keyedDetail);
    if (summarized) return summarized;
  }

  const toolEvidence = raw.match(/^\s*([a-z_][a-z0-9_]*)\s+([^;\n]{1,160})(?:[\s\S]*?\bexcerpt=([^;\n]{1,180}))?/i);
  if (toolEvidence) {
    const toolName = toolEvidence[1] || "";
    const target = compactPlanLine(toolEvidence[2] || "", 96);
    const excerpt = compactPlanLine(toolEvidence[3] || "", 120);
    const label = labels[toolName];
    if (label && target) {
      const connector = language === "zh" ? "；发现：" : "; found: ";
      return `${label}${language === "zh" ? "：" : ": "}${target}${excerpt ? `${connector}${excerpt}` : ""}`;
    }
  }

  const clean = compactPlanLine(value, 180);
  if (!clean) return "";

  const toolMatch = clean.match(/^([a-z_][a-z0-9_]*)(?:\s+([^;]{1,120}))?/i);
  if (toolMatch) {
    const toolName = toolMatch[1] || "";
    const target = compactPlanLine(toolMatch[2] || "", 96);
    const labels = language === "zh" ? TOOL_LABELS_ZH : TOOL_LABELS_EN;
    const label = labels[toolName];
    if (label) {
      const suffix = target ? (language === "zh" ? `：${target}` : `: ${target}`) : "";
      return `${label}${suffix}`;
    }
  }

  return clean;
}

function formatBullets(values: string[], fallback: string): string {
  return values.length > 0
    ? values.map((item) => `- ${item}`).join("\n")
    : `- ${fallback}`;
}

function resolveMaterializationKind(input: {
  raw: string;
  planStage?: PlanStage | null;
  preferredKind?: MaterializablePlanKind | null;
}): MaterializablePlanKind {
  if (input.preferredKind === "design") return "design";
  if (input.preferredKind === "plan") return "plan";
  if (input.planStage === "design") return "design";
  if (
    /^\s*#\s*(?:Design\b|设计)/im.test(input.raw) ||
    /\.MAIN\/plans\/design\.md/i.test(input.raw) ||
    /(?:正式设计方案|设计文档|reviewable,\s*actionable\s*design)/i.test(input.raw) ||
    /(?:框架设计|架构设计|接口设计|代码框架|类图|游戏开发|game\s*dev|architecture|framework|class\s*structure|class\s*diagram)/i.test(input.raw)
  ) {
    return "design";
  }
  return "plan";
}

function normalizeDesignContent(rawText: string, language: "zh" | "en"): string {
  const withoutChoices = unwrapProposedPlanMarkup(stripPlanChoiceMarkup(rawText));
  const withoutProposalMarkers = withoutChoices.replace(PROPOSAL_MARKER_RE, "").trim();
  const strippedPlanJson = withoutProposalMarkers.replace(/<plan>[\s\S]*?<\/plan>/gi, "").trim();
  const sanitized = sanitizePlanArtifactContent(strippedPlanJson);
  if (/^#\s+/m.test(sanitized)) return sanitized;
  return `${language === "zh" ? "# 设计方案" : "# Design"}\n\n${sanitized}`;
}

export function materializePlanArtifactFromVisibleText(input: {
  visibleText: string;
  planStage?: PlanStage | null;
  preferredKind?: MaterializablePlanKind | null;
  sourceHint?: PlanMaterializationSource;
  userGoal?: string;
  evidence?: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  files?: string[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
  turnContext?: TurnInputContextLike | null;
  language?: "zh" | "en";
}): PlanMaterializationResult {
  // Extract reply options BEFORE stripping them, so validation sees clean plan content
  // but we preserve the options for post-validation routing.
  // We use extracted.content directly since extractReplyOptionsFromContent already
  // handles <user_options> removal without corrupting the content.
  const extracted = extractReplyOptionsFromContent(input.visibleText);
  // Apply stripPlanChoiceMarkup to handle any remaining protocol markers
  // but only if there are actual options to extract (to avoid corrupting clean content)
  const raw = extracted.replyOptions.length > 0
    ? stripPlanChoiceMarkup(extracted.content)
    : extracted.content.trim();
  if (!raw) return { ok: false, reason: "empty", replyOptions: extracted.replyOptions };
  if (PROTOCOL_NOISE_RE.test(raw)) return { ok: false, reason: "protocol_noise" };
  if (TOOL_LOG_NOISE_RE.test(raw)) return { ok: false, reason: "tool_log_noise" };
  if (raw.length < 280) return { ok: false, reason: "too_short" };

  const language = detectMaterializationLanguage({
    content: raw,
    userGoal: input.userGoal,
    language: input.language,
  });
  const kind = resolveMaterializationKind({
    raw,
    planStage: input.planStage,
    preferredKind: input.preferredKind,
  });
  if (kind === "design") {
    const content = normalizeDesignContent(raw, language);
    if (countPlanShapeSignals(content) < 4) return { ok: false, reason: "not_structured" };
    const validation = validatePlanArtifactContent(content, "design");
    if (!validation.ok) return { ok: false, reason: validation.reason || "quality_gate" };
    return {
      ok: true,
      kind,
      path: ".MAIN/plans/design.md",
      content,
      source: input.sourceHint || "visible_plan",
    };
  }

  let content = normalizePlanContent(raw);
  let source: PlanMaterializationSource = input.sourceHint || "visible_plan";
  if (countPlanShapeSignals(content) < 5) return { ok: false, reason: "not_structured" };

  let validation = validateActionablePlanArtifact(content);
  if (!validation.ok && validation.canAutoRepair) {
    const repaired = repairActionablePlanArtifactContent({
      content,
      userGoal: input.userGoal,
      quality: validation,
    });
    if (repaired.repairedSections.length > 0) {
      const repairedValidation = validateActionablePlanArtifact(repaired.content);
      if (repairedValidation.ok) {
        content = repaired.content;
        validation = repairedValidation;
      }
      // If repair didn't fix the issues, fall through to canonicalization
    }
  }
  // Final validation: if still not ok and canonicalization can help, try it
  if (
    !validation.ok &&
    !/generic_fallback_plan|unsupported_debug_log_advice|weak_path_echo_evidence|import_only_evidence|generic_theme_token_plan|placeholder_validation_plan/i.test(validation.reason || "")
  ) {
    const canonical = canonicalizePlanArtifactContent({
      content,
      userGoal: input.userGoal,
      evidence: input.evidence,
      evidenceRecords: input.evidenceRecords,
      files: input.files,
      recentToolActivity: input.recentToolActivity,
      turnContext: input.turnContext,
      language: input.language,
    });
    if (canonical) {
      const canonicalValidation = validateActionablePlanArtifact(canonical);
      if (canonicalValidation.ok) {
        content = canonical;
        validation = canonicalValidation;
        source = input.sourceHint === "deterministic_evidence"
          ? "deterministic_evidence"
          : "canonicalized_visible_plan";
      }
    }
  }
  if (!validation.ok) return { ok: false, reason: validation.reason || "quality_gate" };

  return {
    ok: true,
    kind,
    path: ".MAIN/plans/plan.md",
    content,
    source,
    replyOptions: extracted.replyOptions,
  };
}

export function isMaterializablePlanLikeText(text: string): boolean {
  return materializePlanArtifactFromVisibleText({ visibleText: text }).ok;
}

export function composeReviewablePlanFromEvidence(input: {
  userGoal: string;
  evidence: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  files?: string[];
  constraints?: string[];
  kind?: MaterializablePlanKind;
  language?: "zh" | "en";
}): string {
  const language = input.language === "en" ? "en" : "zh";
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: input.userGoal,
    evidence: input.evidence,
    evidenceRecords: input.evidenceRecords,
    files: input.files,
    constraints: input.constraints,
    language,
  });
  const kind = input.kind === "design" ? "design" : "plan";
  const targetPath = kind === "design" ? ".MAIN/plans/design.md" : ".MAIN/plans/plan.md";
  const goal = compactPlanLine(sanitized.userGoal || input.userGoal, 420);
  const evidence = uniqueCompactLines(sanitized.evidence.map((item) => summarizeEvidenceLine(item, language)), 10, 220);
  const files = uniqueCompactLines(sanitized.files, 10, 160);
  const constraints = uniqueCompactLines(sanitized.constraints, 6, 200);

  if (language === "en") {
    return [
      "You already have read-only evidence. Do not repeat directory scans or broad context reads.",
      kind === "design"
        ? "Generate a reviewable, actionable design now."
        : "Generate a reviewable, actionable plan now.",
      "",
      "Hard requirements:",
      `- Use English for all visible prose and \`${targetPath}\` content.`,
      `- Output visible Markdown, preferably wrapped in \`<proposed_plan>\`; MAIN will materialize it into \`${targetPath}\`.`,
      "- Do not call `write_file` or `replace_in_file` just to finish planning. Do not create `tasks.md`; do not modify source or deliverable files before approval.",
      "- Do not include tool logs, ContextMemoryState, XML, raw JSON envelopes, or recovery prompts in the artifact.",
      "- Separate confirmed facts from unverified hypotheses. Do not write probability guesses as execution steps unless an evidence line supports them.",
      `- If a critical business choice is genuinely missing, ask with \`<user_options>\` instead of writing a generic ${kind}.`,
      "",
      `User goal: ${goal}`,
      evidence.length ? `Evidence:\n${formatBullets(evidence, "Read-only evidence is available.")}` : "",
      files.length ? `Relevant paths:\n${formatBullets(files, "No path summary available.")}` : "",
      constraints.length ? `Constraints:\n${formatBullets(constraints, "No extra constraints.")}` : "",
      "",
      `${targetPath} must use the Codex app plan shape: title, Summary, Key Changes or Implementation Changes, Public APIs / Interfaces / Types, Test Plan, and Assumptions / Defaults. Mention screenshot/attachment observations, read evidence, and confirmed facts inside the concise summary only when they are real. If a critical choice blocks execution, ask with \`<user_options>\` before approval instead of burying it as an open question.`,
    ].filter(Boolean).join("\n");
  }

  return [
    "你已经获得只读证据。不要重复扫描目录或泛读上下文。",
    kind === "design"
      ? "现在生成可审阅、可执行的正式设计方案。"
      : "现在生成可审阅、可执行的正式计划。",
    "",
    "硬性要求：",
    `- 所有可见正文和 \`${targetPath}\` 内容必须使用简体中文。`,
    `- 输出可见 Markdown，优先包在 \`<proposed_plan>\` 中；MAIN 会把它物化为 \`${targetPath}\`。`,
    "- 不要为了完成规划而调用 `write_file` 或 `replace_in_file`。批准前不要生成 `tasks.md`，不要修改源码或最终交付文件。",
    "- 文档中禁止出现工具日志、ContextMemoryState、XML、原始 JSON envelope、恢复提示。",
    "- 必须区分已确认事实和未验证假设。没有证据支撑的概率判断不能写成执行步骤。",
    `- 如果确实缺少关键业务选择，用 \`<user_options>\` 提问，不要写泛化模板${kind === "design" ? "设计" : "计划"}。`,
    "",
    `用户目标：${goal}`,
    evidence.length ? `已获得证据：\n${formatBullets(evidence, "已有只读证据。")}` : "",
    files.length ? `相关路径：\n${formatBullets(files, "暂无路径摘要。")}` : "",
    constraints.length ? `约束：\n${formatBullets(constraints, "暂无额外约束。")}` : "",
    "",
    `${targetPath} 必须使用 Codex app 计划结构：标题、摘要、关键实现改动、公共 API/接口/类型、测试方案、假设与默认值。截图/附件观察、已读证据和已确认事实只在确有内容时放进精简摘要，不要撑成空洞章节。真正阻塞执行的选择必须在批准前用 \`<user_options>\` 提问，不要伪装成计划尾部的开放问题。`,
  ].filter(Boolean).join("\n");
}

export function composePlanArtifactFromEvidence(input: {
  userGoal: string;
  evidence: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  files?: string[];
  constraints?: string[];
  language?: "zh" | "en";
}): string {
  const language = input.language === "en" ? "en" : "zh";
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: input.userGoal,
    evidence: input.evidence,
    evidenceRecords: input.evidenceRecords,
    files: input.files,
    constraints: input.constraints,
    language,
  });
  return buildCodexStylePlanArtifact({
    userGoal: sanitized.userGoal || input.userGoal,
    evidence: sanitized.evidence.map((item) => summarizeEvidenceLine(item, language)),
    files: sanitized.files,
    constraints: sanitized.constraints,
    language,
  });
}
