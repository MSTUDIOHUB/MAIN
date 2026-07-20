import { sanitizePlanArtifactContent, stripUserOptionsProtocol } from "./sanitize";
import { parseToolFeedbackEnvelope } from "./toolFeedbackEnvelope";
import {
  analyzePlanDecisionFork,
  classifyPlanArtifactQualityResult,
  isFinitePlanValidationCommand,
  isRuntimeTaskMutationSectionHeading,
  repairActionablePlanArtifactContent,
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
  type PlanDecisionForkAnalysis,
  type PlanArtifactQualityResult,
  type PlanStage,
} from "./workflowModels";
import { findPlanValidationSectionHeadingLineIndex } from "./planExecutableValidation";
import { extractPrimaryUserRequestText, normalizeTurnInputContextSignals, type TurnInputContextLike } from "./turnIntake";
import {
  assessPlanConfigurationContracts,
  assessPlanClosureEvidence,
  buildPlanCandidate,
  isPlanEvidenceBundleReady,
  validatePlanCandidate,
  type PlanCandidate,
  type PlanConfigurationContractAssessment,
  type PlanEvidenceBundle,
} from "./planEvidence";
import { workspacePathsReferToSameFile } from "./workspacePaths";
import {
  extractNumberedUserGoalFacets,
  preserveNumberedUserGoalLines,
} from "./numberedGoalFacets";

export { extractNumberedUserGoalFacets } from "./numberedGoalFacets";

export type MaterializablePlanKind = "plan" | "design";
export type PlanMaterializationSource =
  | "visible_plan"
  | "deterministically_compacted_visible_plan"
  | "canonicalized_visible_plan"
  | "grounding_repaired_visible_plan"
  | "evidence_section_repaired_visible_plan"
  | "manifest_validation_repaired_plan"
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
  decisionFork?: PlanDecisionForkAnalysis;
  /** Typed quality outcome used by both persisted and visible-plan recovery. */
  quality?: PlanArtifactQualityResult;
  evidenceBundleHash?: string;
  candidate?: PlanCandidate;
}

export interface PlanMaterializationToolActivityLike {
  name?: string;
  target?: string;
  status?: string;
  detail?: string;
  facts?: string[];
}

export interface PlanEvidenceRecord {
  tool: string;
  target: string;
  status: string;
  summary?: string;
  facts?: string[];
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
  "code_ast_query",
  "find_symbol_references",
  "git_diff",
  "grep_search",
  "glob_search",
  "index_workspace_documents",
]);
// Preserve the entire workspace-relative path. The previous root-only matcher
// could restart after the hyphen in a nested workspace directory and extract
// a different relative file.
const PATH_LIKE_RE =
  /(?:^|[\s\x60"'(（:=])((?:(?:\.{1,2}\/|[A-Za-z0-9_.@-]+\/)+)[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,10})(?=$|[\s\x60"',，。；;:)）\]}])/g;
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
  code_ast_query: "已解析语法树",
  find_symbol_references: "已查找符号引用",
  git_diff: "已检查 Git 差异",
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
  code_ast_query: "Parsed syntax tree",
  find_symbol_references: "Found symbol references",
  git_diff: "Inspected Git diff",
  grep_search: "Searched text",
  glob_search: "Searched files",
  index_workspace_documents: "Indexed workspace documents",
};

const BROAD_DISCOVERY_EVIDENCE_RE =
  /^(?:(?:glob_search|list_directory|get_project_skeleton|index_workspace_documents)\b|(?:已搜索文件|已查看目录|已查看项目结构|已索引工作区文档)(?:[:：\s]|$)|(?:Searched files|Listed directory|Inspected project structure|Indexed workspace documents)\b)/i;
const CONCRETE_PLAN_EVIDENCE_RE =
  /^(?:(?:read_file|read_file_window|read_document|get_file_outline|code_ast_query|find_symbol_references|git_diff|grep_search|analyze_tabular_document|query_tabular_document)\b|(?:已读取文件|已读取文件窗口|已读取文档|已查看文件结构|已解析语法树|已查找符号引用|已检查 Git 差异|已搜索文本|已分析表格数据|已查询表格数据)(?:[:：\s]|$)|(?:Read file|Read file window|Read document|Inspected file outline|Parsed syntax tree|Found symbol references|Inspected Git diff|Searched text|Analyzed tabular data|Queried tabular data)\b)/i;
const BROAD_OR_NOISY_SEARCH_TARGET_RE =
  /^(?:\.|\.\/|\/|\*+|\*\*\/\*\.[A-Za-z0-9_*{}.,-]+|\*\.[A-Za-z0-9_*{}.,-]+|get_project_skeleton|[\s.*{}()[\]|,+-]+)$/i;
const TOOL_DETAIL_NON_EVIDENCE_RE =
  /(?:package-lock\.json|package\.json|node_modules|dist\/|build\/|<title\b|index\.html:\d+:\s*<title)/i;
const TOOL_DETAIL_HAS_SOURCE_SIGNAL_RE =
  /\b(?:src|app|lib|components|hooks|store|styles|utils|tests|pages|server|client|packages|apps)\/[A-Za-z0-9_./@-]+|\b(?:async|await|function|fn|const|let|class|struct|enum|interface|type|export|import|return|throw|match|impl|use[A-Z][A-Za-z0-9_]*|[A-Za-z_$][A-Za-z0-9_$]{2,}\s*(?:\(|=|:))|(?:字段|配置|接口|状态|事件|命令|权限|插件|数据流|样式)/i;
const PATH_ECHO_EVIDENCE_RE =
  /(?:已读取文件|Read file)\s*[:：]\s*([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)(?:\s*[;；]\s*(?:发现|found)\s*[:：]\s*\1)?\s*$/i;
const READ_FILE_RESULT_RE = /\bREAD_FILE_RESULT\b/i;
const READ_FILE_CONTENT_START = "---CONTENT START---";
const READ_FILE_CONTENT_END = "---CONTENT END---";
const READ_FILE_METADATA_LINE_RE =
  /^(?:\[MAIN_TOOL_FEEDBACK_V1\].*|READ_FILE_RESULT|path\s*:.*|truncated\s*:.*|totalLines\s*:.*|totalChars\s*:.*|returnedLines\s*:.*|returnedChars\s*:.*|nextStartLine\s*:.*|nextRead\s*:.*|note\s*:.*|---CONTENT (?:START|END)---|\.\.\.\[compact:.*)$/i;
const PLAN_EVIDENCE_SOURCE_SIGNAL_RE =
  /\b(?:import|export|async|await|function|fn|const|let|class|struct|enum|interface|type|return|if|else|for|while|switch|case|match|try|catch|throw|impl|props|state|set[A-Z][A-Za-z0-9_]*|load[A-Z]?[A-Za-z0-9_]*|parse[A-Z]?[A-Za-z0-9_]*|map|filter|reduce|render|localStorage|permissions?|capabilit(?:y|ies)|dependencies|plugins?|[A-Za-z_$][A-Za-z0-9_$]{2,}\s*(?:\(|=|:))\b|(?:字段|配置|接口|状态|事件|命令|权限|插件|数据流|样式)/i;
const PLAN_EVIDENCE_SOURCE_CONTRACT_RE =
  /(?:\b(?:invoke|emit|listen|addEventListener|removeEventListener|generate_handler|invoke_handler|register|plugin|permissions?|capabilit(?:y|ies)|fileAssociations?|dialog)[A-Za-z0-9_:.!-]*\s*(?:[(![.:]|$)|@[A-Za-z0-9_./-]+\/plugin-[A-Za-z0-9_-]+)/i;

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

function hasSummaryRoleDocumentTitle(content: string): boolean {
  const firstDocumentHeading = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^#\s+(.+?)\s*$/)?.[1] || "")
    .find(Boolean) || "";
  return /^(?:摘要|Summary)$/i.test(normalizePlanSectionRoleTitle(firstDocumentHeading));
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

function planEvidenceSourceSignalScore(line: string): number {
  let score = 0;
  if (PLAN_EVIDENCE_SOURCE_SIGNAL_RE.test(line)) score += 1;
  if (PLAN_EVIDENCE_SOURCE_CONTRACT_RE.test(line)) score += 12;
  if (/\b(?:invoke|emit|listen|addEventListener|invoke_handler)\s*\(/i.test(line)) score += 8;
  if (/\b(?:open|read|write|save|load|handle)[A-Za-z0-9_]*\s*\(/i.test(line)) score += 3;
  if (/DOMContentLoaded|beforeunload|load\s*["']/i.test(line)) score -= 4;
  if (/(?:generate_handler!\s*\[|["']permissions["']\s*:\s*\[)/i.test(line)) score += 8;
  if (/\b(?:devUrl|dev[_-]?server|beforeDevCommand|port)\b\s*["']?\s*[:=]|--port(?:=|\s+)|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])\s*:\s*\d{2,5}/i.test(line)) score += 10;
  if (/\b(?:throw|panic|error|failed|missing|invalid|unsupported)\b|失败|缺少|错误|无效/i.test(line)) score += 6;
  if (/\b(?:export\s+)?(?:async\s+)?(?:function|fn|class|interface|type)\b/i.test(line)) score += 4;
  if (/\b(?:import|use)\b/i.test(line)) score += 2;
  if (/^\s*(?:\/\/|#)/.test(line)) score -= 2;
  return score;
}

function buildSourceCodeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let quote: "" | "'" | '"' | "`" = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] || "";
    const next = source[index + 1] || "";
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        mask[index] = 1;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    mask[index] = 1;
  }
  return mask;
}

function findMatchingSourceDelimiter(
  source: string,
  mask: Uint8Array,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (!mask[index]) continue;
    const char = source[index] || "";
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char !== closeChar) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function findListenerCallbackBodyOpen(
  source: string,
  mask: Uint8Array,
  callOpenIndex: number,
  callCloseIndex: number,
): number {
  let arrowBodyOpen = -1;
  for (let index = callOpenIndex + 1; index < callCloseIndex - 1; index += 1) {
    if (!mask[index] || !mask[index + 1]) continue;
    if (source[index] !== "=" || source[index + 1] !== ">") continue;
    let bodyOpen = index + 2;
    while (bodyOpen < callCloseIndex && /\s/.test(source[bodyOpen] || "")) bodyOpen += 1;
    if (source[bodyOpen] === "{" && mask[bodyOpen]) {
      arrowBodyOpen = bodyOpen;
      break;
    }
  }

  let functionBodyOpen = -1;
  const functionPattern = /\b(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\([^)]*\)\s*\{/g;
  for (const match of source.matchAll(functionPattern)) {
    const matchIndex = match.index ?? -1;
    if (matchIndex <= callOpenIndex || matchIndex >= callCloseIndex || !mask[matchIndex]) continue;
    const braceOffset = (match[0] || "").lastIndexOf("{");
    const bodyOpen = matchIndex + braceOffset;
    if (braceOffset >= 0 && bodyOpen < callCloseIndex && mask[bodyOpen]) {
      functionBodyOpen = bodyOpen;
      break;
    }
  }

  if (arrowBodyOpen < 0) return functionBodyOpen;
  if (functionBodyOpen < 0) return arrowBodyOpen;
  return Math.min(arrowBodyOpen, functionBodyOpen);
}

const NON_LISTENER_BODY_CALL_IDENTIFIERS = new Set([
  "addEventListener",
  "catch",
  "for",
  "function",
  "if",
  "switch",
  "while",
  "with",
]);

function extractTopLevelListenerBodyCalls(
  source: string,
  mask: Uint8Array,
  bodyOpenIndex: number,
  bodyCloseIndex: number,
): string[] {
  const calls: string[] = [];
  let braceDepth = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let index = bodyOpenIndex + 1; index < bodyCloseIndex; index += 1) {
    if (!mask[index]) continue;
    const char = source[index] || "";
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === "(") {
      parenthesisDepth += 1;
      continue;
    }
    if (char === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (braceDepth !== 0 || parenthesisDepth !== 0 || bracketDepth !== 0) continue;
    if (!/[A-Za-z_$]/.test(char)) continue;

    let identifierEnd = index + 1;
    while (
      identifierEnd < bodyCloseIndex &&
      mask[identifierEnd] &&
      /[A-Za-z0-9_$]/.test(source[identifierEnd] || "")
    ) {
      identifierEnd += 1;
    }
    const identifier = source.slice(index, identifierEnd);
    let nextCodeIndex = identifierEnd;
    while (
      nextCodeIndex < bodyCloseIndex &&
      (!mask[nextCodeIndex] || /\s/.test(source[nextCodeIndex] || ""))
    ) {
      nextCodeIndex += 1;
    }
    if (source[nextCodeIndex] !== "(" || !mask[nextCodeIndex]) {
      index = identifierEnd - 1;
      continue;
    }

    let previousCodeIndex = index - 1;
    while (
      previousCodeIndex > bodyOpenIndex &&
      (!mask[previousCodeIndex] || /\s/.test(source[previousCodeIndex] || ""))
    ) {
      previousCodeIndex -= 1;
    }
    const previousChar = source[previousCodeIndex] || "";
    let previousWordStart = previousCodeIndex;
    while (
      previousWordStart > bodyOpenIndex &&
      mask[previousWordStart - 1] &&
      /[A-Za-z0-9_$]/.test(source[previousWordStart - 1] || "")
    ) {
      previousWordStart -= 1;
    }
    const previousWord = source.slice(previousWordStart, previousCodeIndex + 1);
    const isDefinition = previousWord === "function";
    const isMemberCall = previousChar === "." || previousChar === "?" || previousChar === "#";
    if (
      !isDefinition &&
      !isMemberCall &&
      !NON_LISTENER_BODY_CALL_IDENTIFIERS.has(identifier) &&
      !calls.includes(identifier)
    ) {
      calls.push(identifier);
      if (calls.length >= 8) break;
    }
    index = identifierEnd - 1;
  }
  return calls;
}

function collectDomListenerSourceCandidate(
  lines: string[],
  index: number,
): { event: string; listenerCalls: string[] } | null {
  if (!/\baddEventListener\s*\(/i.test(lines[index] || "")) return null;
  const boundedSource = lines.slice(index, Math.min(lines.length, index + 80)).join("\n");
  const listenerMatch = boundedSource.match(/\baddEventListener\s*\(\s*[`'"]?([A-Za-z0-9_.:-]+)[`'"]?/i);
  const event = listenerMatch?.[1] || "";
  const listenerStart = listenerMatch?.index ?? -1;
  if (!event || listenerStart < 0) return null;

  const mask = buildSourceCodeMask(boundedSource);
  const callOpenIndex = boundedSource.indexOf("(", listenerStart);
  if (callOpenIndex < 0 || !mask[callOpenIndex]) return { event, listenerCalls: [] };
  const callCloseIndex = findMatchingSourceDelimiter(boundedSource, mask, callOpenIndex, "(", ")");
  if (callCloseIndex < 0) return { event, listenerCalls: [] };
  const bodyOpenIndex = findListenerCallbackBodyOpen(
    boundedSource,
    mask,
    callOpenIndex,
    callCloseIndex,
  );
  if (bodyOpenIndex < 0) return { event, listenerCalls: [] };
  const bodyCloseIndex = findMatchingSourceDelimiter(boundedSource, mask, bodyOpenIndex, "{", "}");
  if (bodyCloseIndex < 0 || bodyCloseIndex > callCloseIndex) return { event, listenerCalls: [] };
  return {
    event,
    listenerCalls: extractTopLevelListenerBodyCalls(
      boundedSource,
      mask,
      bodyOpenIndex,
      bodyCloseIndex,
    ),
  };
}

function compactPlanEvidenceSourceCandidate(
  lines: string[],
  index: number,
): { text: string; endIndex: number } {
  const line = lines[index] || "";
  const domListener = collectDomListenerSourceCandidate(lines, index);
  if (domListener) {
    return {
      text: [
        `L${index + 1}: event_dom_listener_contract(${domListener.event})`,
        domListener.listenerCalls.length > 0
          ? `listener_calls(${domListener.listenerCalls.join(",")})`
          : "",
      ].filter(Boolean).join(" "),
      // Keep scanning the body so nested event contracts remain available as
      // independent facts. The lookahead above is only for this listener.
      endIndex: index,
    };
  }
  const multilineContract = /(?:generate_handler!\s*\[|["']permissions["']\s*:\s*\[)/i.test(line);
  let endIndex = index;
  if (multilineContract) {
    const closingPattern = /(?:\]\)|\]\s*[,;]?)\s*$/;
    while (endIndex + 1 < lines.length && endIndex - index < 12) {
      endIndex += 1;
      if (closingPattern.test((lines[endIndex] || "").trim())) break;
    }
  }
  const joined = lines.slice(index, endIndex + 1).join(" ");
  if (/generate_handler!\s*\[/i.test(joined)) {
    const body = joined.match(/generate_handler!\s*\[([\s\S]*?)\]/i)?.[1] || "";
    const handlers = [...new Set(body.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])].slice(0, 12);
    if (handlers.length > 0) {
      return {
        text: `L${index + 1}: handler_contract(${handlers.join(",")})`,
        endIndex,
      };
    }
  }
  if (/["']permissions["']\s*:\s*\[/i.test(joined)) {
    const body = joined.match(/["']permissions["']\s*:\s*\[([\s\S]*?)\]/i)?.[1] || "";
    const permissions = [...body.matchAll(/["']([^"']+)["']/g)]
      .map((match) => match[1] || "")
      .filter(Boolean)
      .slice(0, 16);
    if (permissions.length > 0) {
      return {
        text: `L${index + 1}: permission_contract(${permissions.join(",")})`,
        endIndex,
      };
    }
  }
  const emittedEvent = joined.match(/\.emit\s*\(\s*[`'"]?([A-Za-z0-9_.:-]+)[`'"]?/i)?.[1] || "";
  if (emittedEvent) {
    return {
      text: `L${index + 1}: event_emit_contract(${emittedEvent})`,
      endIndex,
    };
  }
  const tauriListenedEvent = joined.match(/(?:^|[^A-Za-z0-9_])listen\s*\(\s*[`'"]?([A-Za-z0-9_.:-]+)[`'"]?/i)?.[1] || "";
  if (tauriListenedEvent) {
    return {
      text: `L${index + 1}: event_tauri_listener_contract(${tauriListenedEvent})`,
      endIndex,
    };
  }
  const invokedCommand = joined.match(/\binvoke\s*\(\s*[`'"]?([A-Za-z0-9_.:-]+)[`'"]?/i)?.[1] || "";
  if (invokedCommand) {
    return {
      text: `L${index + 1}: command_invoke_contract(${invokedCommand})`,
      endIndex,
    };
  }
  return {
    text: compactPlanEvidenceSourceLine(joined, index),
    endIndex,
  };
}

function collectPlanEvidenceSourceSignals(body: string, maxChars: number): string {
  const lines = String(body || "").split(/\r?\n/);
  const candidates: Array<{ text: string; score: number; index: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    const score = planEvidenceSourceSignalScore(line);
    if (score <= 0) continue;
    const candidate = compactPlanEvidenceSourceCandidate(lines, index);
    if (candidate.text) candidates.push({ text: candidate.text, score, index });
    index = candidate.endIndex;
  }
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);

  const picked: string[] = [];
  const pickedContracts = new Set<string>();
  let chars = 0;
  for (const candidate of candidates) {
    const compacted = candidate.text;
    const contractKey = compacted.replace(/^L\d+:\s*/i, "").toLowerCase();
    if (!compacted || pickedContracts.has(contractKey)) continue;
    const nextChars = chars + compacted.length + 1;
    if (nextChars > maxChars && picked.length > 0) break;
    picked.push(compacted);
    pickedContracts.add(contractKey);
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

function stripReadFileMetadataText(value: string, maxChars: number): string {
  if (!READ_FILE_RESULT_RE.test(value)) return value;
  const body = extractDelimitedReadFileBody(value);
  if (!body) return "";
  return collectPlanEvidenceSourceSignals(body, maxChars);
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

  const withoutReadMetadata = stripReadFileMetadataText(source, maxChars);
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

const STRUCTURED_PLAN_EVIDENCE_FACT_RE =
  /\b(?:(?:handler|permission|event_(?:emit|dom_listener|tauri_listener)|command_invoke)_contract|listener_calls)\([^\n)]{1,240}\)/gi;
const STRUCTURED_PLAN_CONFIG_FACT_RE =
  /\b(?:devUrl\s*["']?\s*[:=]\s*["']?[^\s"']{1,160}|port\s*["']?\s*[:=]\s*\d{1,5}|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5})/gi;

function planEvidenceFactPriority(value: string): number {
  if (/event_dom_listener_contract\(DOMContentLoaded\)/i.test(value)) return 120;
  if (/\blistener_calls\(/i.test(value)) return 118;
  if (/\b(?:devUrl|port)\b|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):/i.test(value)) return 115;
  if (/\b(?:handler|permission)_contract\(/i.test(value)) return 105;
  if (/\bevent_(?:emit|dom_listener|tauri_listener)_contract\(/i.test(value)) return 100;
  if (/\bcommand_invoke_contract\(/i.test(value)) return 90;
  return 50;
}

/**
 * Keep source contracts as bounded structured facts alongside human-readable
 * excerpts. Repeated character slicing can otherwise delete a middle fact
 * (for example DOMContentLoaded) when several windows of one file are merged.
 */
export function extractPlanEvidenceFacts(value: unknown): string[] {
  const text = String(value || "");
  const candidates = [
    ...Array.from(text.matchAll(STRUCTURED_PLAN_EVIDENCE_FACT_RE), (match) => match[0] || ""),
    ...Array.from(text.matchAll(STRUCTURED_PLAN_CONFIG_FACT_RE), (match) => match[0] || ""),
  ];
  return mergePlanEvidenceFacts(candidates);
}

export function mergePlanEvidenceFacts(...groups: Array<Iterable<string> | null | undefined>): string[] {
  const unique = new Map<string, { value: string; order: number }>();
  let order = 0;
  for (const group of groups) {
    if (!group) continue;
    for (const raw of group) {
      const value = compactPlanLine(String(raw || ""), 240, true);
      if (!value) continue;
      const key = value.toLowerCase().replace(/\s+/g, " ");
      if (!unique.has(key)) unique.set(key, { value, order: order++ });
    }
  }
  return [...unique.values()]
    .sort((left, right) =>
      planEvidenceFactPriority(right.value) - planEvidenceFactPriority(left.value) ||
      left.order - right.order
    )
    .slice(0, 24)
    .map((entry) => entry.value);
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

  const candidate = [...raw.matchAll(PATH_LIKE_RE)]
    .map((match) => match[1] || "")
    .find((item) => !isPlanArtifactPath(item) && !isInternalPlanEvidenceText(item)) || "";
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
    detail: [record.summary, ...(record.facts || [])].filter(Boolean).join(" "),
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
  const rawUserGoal = sanitizePlanArtifactContent(String(primaryUserGoal || input.userGoal || "")).trim();
  const cleanUserGoal = preserveNumberedUserGoalLines(rawUserGoal, 600) || compactPlanLine(rawUserGoal, 600);
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
  level: number;
  ancestors: string[];
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
  let level = 0;
  let ancestors: string[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  const flush = () => {
    if (title || body.join("\n").trim()) {
      sections.push({ title, body: body.join("\n"), level, ancestors });
    }
  };
  for (const line of String(content || "").split(/\r?\n/)) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    const outlineHeading = heading ? "" : matchPlanOutlineHeading(line);
    if (heading || outlineHeading) {
      flush();
      const nextLevel = heading ? (heading[1] || "#").length : 2;
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1]?.level || 0) >= nextLevel
      ) {
        headingStack.pop();
      }
      ancestors = headingStack.map((entry) => entry.title);
      title = heading?.[2] || outlineHeading;
      level = nextLevel;
      body = [];
      headingStack.push({ level: nextLevel, title });
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function planSectionMatchesRole(
  section: ParsedPlanSection,
  patterns: RegExp[],
): boolean {
  return [section.title, ...section.ancestors]
    .map(normalizePlanSectionRoleTitle)
    .some((title) => patterns.some((pattern) => pattern.test(title)));
}

function normalizePlanSectionRoleTitle(title: string): string {
  return String(title || "")
    .trim()
    .replace(/^(?:(?:第\s*)?[一二三四五六七八九十百]+|\d{1,3})\s*[、.．):：-]\s*/, "")
    .trim();
}

function formatPlanSectionContext(section: ParsedPlanSection): string {
  const titles = [...section.ancestors, section.title]
    .map(normalizePlanSectionRoleTitle)
    .filter((title) => title && !/^(?:Proposed Plan|Plan|计划|整改计划|修复计划)$/i.test(title));
  return uniquePlanItems(titles, 3, 180, true).slice(-2).join(" / ");
}

const PLAN_FACET_STOP_TERMS = new Set([
  "现在", "当前", "软件", "用户", "目标", "问题", "功能", "需要", "要求", "进行", "以及", "这个", "一个", "无法", "已经",
  "修复", "实现", "改动", "验证", "确认", "执行", "操作", "检查", "结果", "通过", "相关", "对应", "原始", "涉及", "不一", "一致",
  "the", "and", "with", "that", "this", "from", "issue", "problem", "should", "must", "user", "goal", "current", "implement", "change", "validate", "verify", "confirm", "execute", "result",
]);

function semanticFacetTerms(value: string): Set<string> {
  const terms = new Set<string>();
  const normalized = String(value || "").toLowerCase();
  for (const token of normalized.match(/[a-z0-9_./-]{3,}/g) || []) {
    if (!PLAN_FACET_STOP_TERMS.has(token)) terms.add(token);
  }
  for (const chunk of normalized.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (!PLAN_FACET_STOP_TERMS.has(chunk) && chunk.length <= 8) terms.add(chunk);
    for (let index = 0; index <= chunk.length - 2; index++) {
      const pair = chunk.slice(index, index + 2);
      if (!PLAN_FACET_STOP_TERMS.has(pair)) terms.add(pair);
    }
  }
  return terms;
}

function facetSectionCovered(facetTerms: Set<string>, sectionBody: string): boolean {
  const sectionTerms = semanticFacetTerms(sectionBody);
  let matches = 0;
  for (const term of facetTerms) {
    if (sectionTerms.has(term)) matches += term.length >= 4 ? 2 : 1;
  }
  return matches >= 2;
}

function facetLineStronglyCovered(facetTerms: Set<string>, line: string): boolean {
  const lineTerms = semanticFacetTerms(line);
  let distinctMatches = 0;
  for (const term of facetTerms) {
    if (lineTerms.has(term)) distinctMatches += 1;
  }
  return distinctMatches >= 2;
}

function distinctSemanticFacetTerms(
  facetText: string,
  allFacetTexts: string[],
): Set<string> {
  const ownTerms = semanticFacetTerms(facetText);
  const sharedTerms = new Set<string>();
  for (const other of allFacetTexts) {
    if (other === facetText) continue;
    for (const term of semanticFacetTerms(other)) sharedTerms.add(term);
  }
  return new Set([...ownTerms].filter((term) => !sharedTerms.has(term)));
}

type PlanFacetReferencePrefix = "E" | "C" | "D" | "V";

interface PlanFacetTraceabilityRow {
  index: number;
  body: string;
  changeRefs: string[];
  decisionRefs: string[];
  validationRefs: string[];
}

function collectPlanReferenceIds(value: string, prefix: PlanFacetReferencePrefix): string[] {
  const ids = new Set<string>();
  const pattern = new RegExp(`\\b${prefix}(\\d{1,3})\\b`, "gi");
  for (const match of String(value || "").matchAll(pattern)) {
    ids.add(`${prefix}${Number(match[1])}`);
  }
  return [...ids];
}

function parsePlanFacetTraceabilityRows(sections: ParsedPlanSection[]): PlanFacetTraceabilityRow[] {
  const rows: PlanFacetTraceabilityRow[] = [];
  for (const section of sections) {
    if (!/^(?:(?:需求|目标|用户目标|问题)?分面(?:追踪|映射|覆盖)|(?:Requirement|Goal|Issue) Facet (?:Traceability|Mapping|Coverage))$/i.test(
      normalizePlanSectionRoleTitle(section.title),
    )) continue;
    for (const rawLine of section.body.split(/\r?\n/)) {
      const body = stripPlanListMarker(rawLine);
      const match = body.match(/^(?:分面|需求|目标|问题|Facet|Requirement|Goal|Issue)\s*#?\s*(\d{1,2})\b/i);
      if (!match) continue;
      rows.push({
        index: Number(match[1]),
        body,
        changeRefs: collectPlanReferenceIds(body, "C"),
        decisionRefs: collectPlanReferenceIds(body, "D"),
        validationRefs: collectPlanReferenceIds(body, "V"),
      });
    }
  }
  return rows;
}

function planFacetTraceabilityRowCoversActionAndValidation(input: {
  row?: PlanFacetTraceabilityRow;
  facetTerms: Set<string>;
  changesBody: string;
  decisionsBody: string;
  validationBody: string;
}): boolean {
  const row = input.row;
  if (!row || !facetSectionCovered(input.facetTerms, row.body)) return false;
  const referencesExist = (refs: string[], body: string) =>
    refs.length > 0 && refs.every((ref) => new RegExp(`\\[${ref}\\]`, "i").test(body));
  const groundedAction = referencesExist(row.changeRefs, input.changesBody) ||
    referencesExist(row.decisionRefs, input.decisionsBody);
  return groundedAction &&
    referencesExist(row.validationRefs, input.validationBody);
}

export function validateNumberedUserGoalFacetCoverage(input: {
  userGoal?: string;
  content: string;
}): PlanArtifactQualityResult {
  const facets = extractNumberedUserGoalFacets(input.userGoal || "");
  if (facets.length < 2) return classifyPlanArtifactQualityResult({ ok: true });
  const sections = parsePlanSections(input.content);
  const collectRoleText = (patterns: RegExp[]) => sections
    .filter((section) => planSectionMatchesRole(section, patterns))
    .map((section) => `${section.ancestors.join("\n")}\n${section.title}\n${section.body}`)
    .join("\n");
  const changesBody = collectRoleText([
    /关键改动|实现改动|具体改动|改动|变更|修复方案|实现方案|实施方案|执行方案|架构|设计|组件|数据流|落地方案|key changes|changes?|implementation|fix plan|approach|architecture|design|components?|data flow|plan of work/i,
  ]);
  const decisionsBody = collectRoleText([
    /决策|结论|取舍|约束|保持不变|无需改动|不修改|decision|conclusion|trade-?off|constraint|no changes?|unchanged/i,
  ]);
  const validationBody = collectRoleText([/测试|验证|验收|成功标准|完成标准|test|validation|acceptance|success criteria|definition of done/i]);
  const traceabilityRows = parsePlanFacetTraceabilityRows(sections);
  const uncovered = facets.filter((facet) => {
    const terms = semanticFacetTerms(facet.text);
    const semanticCoverage =
      (facetSectionCovered(terms, changesBody) || facetSectionCovered(terms, decisionsBody)) &&
      facetSectionCovered(terms, validationBody);
    const referenceCoverage = planFacetTraceabilityRowCoversActionAndValidation({
      row: traceabilityRows.find((row) => row.index === facet.index),
      facetTerms: terms,
      changesBody,
      decisionsBody,
      validationBody,
    });
    return !semanticCoverage && !referenceCoverage;
  });
  return uncovered.length === 0
    ? classifyPlanArtifactQualityResult({ ok: true })
    : classifyPlanArtifactQualityResult({
        ok: false,
        reason: `uncovered_user_goal_facets:${uncovered.map((facet) => facet.index).join(",")}`,
      });
}

function collectSectionTitles(
  sections: ParsedPlanSection[],
  patterns: RegExp[],
  maxItems: number,
): string[] {
  return uniquePlanItems(
    sections
      .filter((section) => patterns.some((pattern) =>
        pattern.test(normalizePlanSectionRoleTitle(section.title))
      ))
      .map((section) => section.title),
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
  includeDescendants = false,
  includeSectionContext = false,
): string[] {
  const values: string[] = [];
  for (const section of sections) {
    const matches = includeDescendants
      ? planSectionMatchesRole(section, patterns)
      : patterns.some((pattern) => pattern.test(normalizePlanSectionRoleTitle(section.title)));
    if (!matches) continue;
    const context = includeSectionContext ? formatPlanSectionContext(section) : "";
    if (context) values.push(context);
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

const PLAN_GROUNDING_READ_TOOLS = new Set([
  "read_file",
  "read_file_window",
  "read_document",
  "get_file_outline",
]);
const PLAN_CHANGE_TARGET_FILE_RE = /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:tsx?|jsx?|mjs|cjs|swift|py|rs|go|json|toml|ya?ml|css|scss|html|md)\b/gi;
const PLAN_DIAGNOSTIC_CLAIM_TARGET_FILE_RE = /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:tsx?|jsx?|mjs|cjs|swift|py|rs|go|json|toml|ya?ml|css|scss|html|md|csv|tsv|xls|xlsx)\b/gi;
const PLAN_EXPLICIT_MUTATION_RE = /(?:修改|更新|改动|改为|新增|添加|增加|实现|生成|创建|删除|重构|修复|替换|移除|接入|迁移|写入|持久化|归一化|统一|配置|扩展|支持|引入|拆分|合并|modify|update|change|add|implement|generate|create|delete|refactor|fix|replace|remove|wire|migrate|write|persist|normalize|configure|extend|support|introduce|split|merge)/i;
const PLAN_NEW_FILE_LINE_RE = /(?:新增文件|新建文件|创建新文件|add\s+(?:a\s+)?new\s+file|create\s+(?:a\s+)?new\s+file)/i;
const PLAN_CONFIRMED_EVIDENCE_HEADING_RE = /(?:^|\n)\s*#{1,6}\s*(?:\d+\s*[.)、:：-]?\s*)?(?:已确认(?:事实|发现|证据)|已读证据|证据依据|证据归因|当前状态|当前实现|现有架构|项目背景|实现约束|Confirmed (?:Facts|Findings|Evidence)|Read Evidence|Evidence(?: Mapping)?|Current State|Current Implementation|Existing Architecture|Project Context|Implementation Constraints)(?:\s*(?:[（(][^()（）\r\n]{1,60}[）)]|[:：—-]\s*[^#\r\n]{1,60}))?\s*$/im;
const PLAN_KEY_CHANGES_HEADING_RE = /^(?:关键改动|关键实现改动|实现改动|实现方案|实施方案|执行方案|架构改动|设计方案|落地方案|Key Changes|Implementation Changes|Implementation Plan|Implementation|Approach|Architecture Changes|Design Changes|Plan of Work)$/i;

function isPlanGroundingMutationSectionHeading(heading: string): boolean {
  const normalized = normalizePlanSectionRoleTitle(heading);
  return PLAN_KEY_CHANGES_HEADING_RE.test(normalized) ||
    isRuntimeTaskMutationSectionHeading(normalized);
}

function normalizePlanGroundingPath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^[`'"\s]+|[`'"\s.,;:：)\]}]+$/g, "")
    .trim()
    .toLowerCase();
}

function planGroundingPathsMatch(left: string, right: string): boolean {
  return workspacePathsReferToSameFile(
    normalizePlanGroundingPath(left),
    normalizePlanGroundingPath(right),
  );
}

function isPlanMutationLine(value: string): boolean {
  const line = String(value || "")
    .replace(/^\s*(?:[-*]|\d+[.)、])\s+/, "")
    .trim();
  if (!line) return false;

  // Validation and investigation prose often mentions mutation nouns (for
  // example, “检查结果是否包含关键实现改动”). The leading intent owns the
  // sentence unless it explicitly pivots to a write action.
  const hasLeadingReadOrValidationIntent = /^(?:(?:需要|需|先|请|继续|首先|最后|下一步)\s*)?(?:读取|查看|检查|确认|定位|分析|排查|梳理|调研|审查|理解|验证|测试|运行|执行)|^(?:(?:need(?:s)?\s+to|first|please|finally|next)\s+)?(?:read|inspect|review|analy[sz]e|identify|investigate|check|confirm|understand|verify|test|run|execute)\b/i.test(line);
  const hasMutationAfterIntent = /(?:然后|随后|之后|再|并(?:且)?).{0,120}(?:修改|更新|改为|重构|修复|替换|移除|接入|迁移)|(?:then|after(?:wards)?|and then).{0,120}(?:modify|update|change|refactor|fix|replace|remove|wire|migrate)/i.test(line);
  if (hasLeadingReadOrValidationIntent && !hasMutationAfterIntent) return false;

  // A verification-only plan may explicitly state that source code remains
  // unchanged. That is a scope constraint, not a mutation target.
  if (/^(?:不(?:会|需|需要|计划)?修改|无需修改|不改变|保持.+不变|no\s+(?:source\s+)?changes?|do\s+not\s+modify|keep.+unchanged)/i.test(line)) {
    return false;
  }
  return PLAN_EXPLICIT_MUTATION_RE.test(line);
}

function collectReadEvidenceTargets(input: {
  evidence?: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
}): string[] {
  const targets: string[] = [];
  for (const record of input.evidenceRecords || []) {
    if (
      PLAN_GROUNDING_READ_TOOLS.has(String(record.tool || "")) &&
      !/failed|blocked|rejected|declined/i.test(String(record.status || ""))
    ) {
      targets.push(record.target || "");
    }
  }
  for (const activity of input.recentToolActivity || []) {
    if (
      PLAN_GROUNDING_READ_TOOLS.has(String(activity.name || "")) &&
      !/failed|blocked|rejected|declined/i.test(String(activity.status || ""))
    ) {
      targets.push(activity.target || "");
    }
  }
  for (const line of input.evidence || []) {
    const match = String(line || "").match(/(?:read_file(?:_window)?|read_document|get_file_outline|已读取(?:文件|文件窗口|文档)|已查看文件结构|Read (?:file|file window|document)|Inspected file outline)\s*[:：;]?\s*([^;\n]{1,180})/i);
    if (match?.[1]) targets.push(match[1]);
  }
  return [...new Set(targets.map(normalizePlanGroundingPath).filter(Boolean))];
}

function collectPlanChangeTargets(content: string): string[] {
  const targets: string[] = [];
  const keyChangesBody = extractPlanGroundingSectionBody(
    content,
    isPlanGroundingMutationSectionHeading,
  );
  for (const rawLine of keyChangesBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !isPlanMutationLine(line) || PLAN_NEW_FILE_LINE_RE.test(line)) continue;
    for (const match of line.matchAll(PLAN_CHANGE_TARGET_FILE_RE)) {
      const target = normalizePlanGroundingPath(match[0] || "");
      if (
        target &&
        !/\.main\/plans\//i.test(target) &&
        !/(?:^|\/)(?:plan|tasks|requirements|design)\.md$/i.test(target)
      ) {
        targets.push(target);
      }
    }
  }
  return [...new Set(targets)];
}

interface ExplicitPlanCodeChange {
  target: string;
  before: string;
  after: string;
}

function normalizeExplicitPlanCode(value: string): string {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function extractLabeledPlanCode(block: string, label: "before" | "after"): string {
  const pattern = label === "before"
    ? /(?:\*\*)?(?:修改前|变更前|当前代码|Before|Current)(?:\*\*)?\s*[:：]?\s*\n\s*```[^\n]*\n([\s\S]*?)```/i
    : /(?:\*\*)?(?:修改后|变更后|目标代码|After|Proposed)(?:\*\*)?\s*[:：]?\s*\n\s*```[^\n]*\n([\s\S]*?)```/i;
  return normalizeExplicitPlanCode(block.match(pattern)?.[1] || "");
}

function collectExplicitPlanCodeChanges(content: string): ExplicitPlanCodeChange[] {
  const raw = String(content || "");
  const fileLabel = /(?:\*\*)?(?:文件|File)(?:\*\*)?\s*[:：]\s*`?([A-Za-z0-9_@./\\-]+\.[A-Za-z0-9]+)`?/gi;
  const matches = [...raw.matchAll(fileLabel)];
  const changes: ExplicitPlanCodeChange[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? raw.length;
    const block = raw.slice(start, end);
    const before = extractLabeledPlanCode(block, "before");
    const after = extractLabeledPlanCode(block, "after");
    if (!before || !after) continue;
    changes.push({
      target: normalizePlanGroundingPath(match[1] || ""),
      before,
      after,
    });
  }
  return changes;
}

/**
 * Explicit before/after snippets are an executable contract, not illustrative
 * prose. Validate that the contract changes something and, when the target was
 * read, that its claimed before-state actually came from that read result.
 */
export function validateExplicitPlanCodeChangeGrounding(input: {
  content: string;
  recentToolActivity?: PlanMaterializationToolActivityLike[];
}): PlanArtifactQualityResult {
  const changes = collectExplicitPlanCodeChanges(input.content);
  for (const change of changes) {
    if (change.before === change.after) {
      return classifyPlanArtifactQualityResult({
        ok: false,
        reason: `plan_change_noop:${change.target || "unknown"}`,
      });
    }

    const matchingReads = (input.recentToolActivity || []).filter((activity) =>
      /^(?:read_file|read_file_window|read_document)$/i.test(String(activity.name || "")) &&
      !/failed|blocked|rejected|declined/i.test(String(activity.status || "")) &&
      planGroundingPathsMatch(change.target, String(activity.target || ""))
    );
    if (matchingReads.length === 0) continue;
    const beforeWasObserved = matchingReads.some((activity) =>
      normalizeExplicitPlanCode(String(activity.detail || "")).includes(change.before)
    );
    if (!beforeWasObserved) {
      return classifyPlanArtifactQualityResult({
        ok: false,
        reason: `plan_before_state_not_observed:${change.target || "unknown"}`,
      });
    }
  }
  return classifyPlanArtifactQualityResult({ ok: true });
}

function extractPlanGroundingSectionBody(
  content: string,
  headingMatcher: RegExp | ((heading: string) => boolean),
): string {
  const body: string[] = [];
  let sectionLevel = 0;
  const matchesHeading = (heading: string): boolean => {
    if (typeof headingMatcher === "function") return headingMatcher(heading);
    headingMatcher.lastIndex = 0;
    return headingMatcher.test(heading);
  };
  for (const line of String(content || "").split(/\r?\n/)) {
    const heading = line.trim().match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1]?.length || 0;
      const title = heading[2] || "";
      if (sectionLevel > 0 && level > sectionLevel) {
        // Descendant headings are part of the owning mutation section. Keep
        // their text so a file-bearing child heading is audited as a change.
        body.push(title);
        continue;
      }
      if (sectionLevel > 0 && level <= sectionLevel) sectionLevel = 0;
      if (matchesHeading(title)) sectionLevel = level;
      continue;
    }
    if (sectionLevel > 0) body.push(line);
  }
  return body.join("\n").trim();
}

const PLAN_VALIDATION_TARGET_HEADING_RE =
  /^(?:\d+\s*[.)、:：-]?\s*)?(?:验证(?:方式|标准|方案|步骤)?|测试(?:方案|计划|场景|步骤)?|构建(?:检查)?|验收(?:标准|方案|步骤)?|Validation(?:\s+(?:Plan|Steps|Standards?|Strategy))?|Verification(?:\s+(?:Plan|Steps|Standards?|Strategy))?|Testing|Tests?|Test Plan|Acceptance(?:\s+(?:Criteria|Plan|Steps))?|Build(?: Checks?)?|Checks?)(?:\s*(?:[（(][^()（）\r\n]{1,60}[）)]|[:：—-]\s*[^#\r\n]{1,60}))?$/i;
const LOCALHOST_WITH_PORT_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):)(\d{1,5})/gi;
const DEV_SERVER_CONFIG_TARGET_RE =
  /(?:^|\/)(?:package\.json|angular\.json|tauri\.conf\.json|(?:electron\.)?vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|rspack\.config\.[cm]?[jt]s|rsbuild\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|nuxt\.config\.[cm]?[jt]s|astro\.config\.[cm]?[jt]s|svelte\.config\.[cm]?[jt]s|wxt\.config\.[cm]?[jt]s)$/i;

function extractDevServerPortsFromConfigEvidence(value: string): number[] {
  const ports = new Set<number>();
  const add = (raw: string | undefined) => {
    const port = Number(raw);
    if (port > 0 && port <= 65_535) ports.add(port);
  };
  for (const match of String(value || "").matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})/gi)) {
    add(match[1]);
  }
  for (const match of String(value || "").matchAll(/\bdevUrl\b\s*["']?\s*[:=]\s*["']?[^\s"']*?:(\d{1,5})\b/gi)) {
    add(match[1]);
  }
  for (const match of String(value || "").matchAll(/\b(?:devServer|server)\b[^\n]{0,120}?\bport\b\s*["']?\s*[:=]\s*(\d{1,5})\b/gi)) {
    add(match[1]);
  }
  // The caller has already restricted this evidence to a known frontend
  // dev-server configuration owner. Evidence summarization commonly reduces
  // a multiline Vite block to `L4: port: 1420`, so accept the owned bare
  // assignment here instead of requiring the surrounding `server` token to
  // survive compaction.
  for (const match of String(value || "").matchAll(/\bport\b\s*["']?\s*[:=]\s*(\d{1,5})\b/gi)) {
    add(match[1]);
  }
  for (const match of String(value || "").matchAll(/--port(?:=|\s+)(\d{1,5})\b/gi)) {
    add(match[1]);
  }
  return [...ports];
}

function collectObservedDevServerPorts(input: {
  evidenceRecords?: PlanEvidenceRecord[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
}): { ports: number[]; targets: string[] } {
  const observations = [
    ...(input.evidenceRecords || [])
      .filter((record) =>
        PLAN_GROUNDING_READ_TOOLS.has(String(record.tool || "")) &&
        !/failed|blocked|rejected|declined/i.test(String(record.status || ""))
      )
      .map((record) => ({
        target: String(record.target || ""),
        detail: [record.summary, ...(record.facts || [])].filter(Boolean).join(" "),
      })),
    ...(input.recentToolActivity || [])
      .filter((activity) =>
        PLAN_GROUNDING_READ_TOOLS.has(String(activity.name || "")) &&
        !/failed|blocked|rejected|declined/i.test(String(activity.status || ""))
      )
      .map((activity) => ({
        target: String(activity.target || ""),
        detail: [activity.detail, ...(activity.facts || [])].filter(Boolean).join(" "),
      })),
  ];
  const ports = new Set<number>();
  const targets = new Set<string>();
  for (const observation of observations) {
    const target = normalizePlanGroundingPath(observation.target);
    // A generic `src/server.ts` or API configuration can also contain a
    // `port` field. Only configuration owners that actually define frontend
    // dev-server startup are eligible to repair a browser validation origin.
    if (!DEV_SERVER_CONFIG_TARGET_RE.test(target)) continue;
    const observed = extractDevServerPortsFromConfigEvidence(observation.detail);
    if (observed.length === 0) continue;
    targets.add(target);
    observed.forEach((port) => ports.add(port));
  }
  return { ports: [...ports], targets: [...targets] };
}

/**
 * A validation URL is executable Plan data. When a single port has already
 * been observed from project reads, keep localhost checks on that port rather
 * than allowing a model-default value (commonly 5173) into approval.
 */
export function repairPlanValidationTargetFromEvidence(input: {
  content: string;
  evidenceRecords?: PlanEvidenceRecord[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
}): { content: string; repaired: boolean; expectedPort?: number } {
  const observed = collectObservedDevServerPorts(input);
  const observedPorts = observed.ports;
  if (observedPorts.length !== 1) return { content: input.content, repaired: false };

  const keyChanges = extractPlanGroundingSectionBody(
    input.content,
    isPlanGroundingMutationSectionHeading,
  );
  const normalizedKeyChanges = normalizePlanGroundingPath(keyChanges);
  const explicitlyProposedPorts = extractDevServerPortsFromConfigEvidence(keyChanges);
  const mentionsObservedConfig = observed.targets.some((target) => {
    const basename = target.split("/").pop() || target;
    return normalizedKeyChanges.includes(target) || normalizedKeyChanges.includes(basename);
  });
  const changesPortConfiguration = mentionsObservedConfig &&
    explicitlyProposedPorts.some((port) => port !== observedPorts[0]);
  if (changesPortConfiguration) return { content: input.content, repaired: false };

  const expectedPort = observedPorts[0];
  let inValidationSection = false;
  let validationHeadingLevel = 0;
  let repaired = false;
  const lines = String(input.content || "").split(/\r?\n/).map((line) => {
    const heading = line.trim().match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1]?.length || 0;
      if (inValidationSection && level <= validationHeadingLevel) inValidationSection = false;
      if (PLAN_VALIDATION_TARGET_HEADING_RE.test(heading[2] || "")) {
        inValidationSection = true;
        validationHeadingLevel = level;
      }
      return line;
    }
    if (!inValidationSection) return line;
    return line.replace(LOCALHOST_WITH_PORT_RE, (match, prefix: string, rawPort: string) => {
      if (Number(rawPort) === expectedPort) return match;
      repaired = true;
      return `${prefix}${expectedPort}`;
    });
  });
  return {
    content: lines.join("\n"),
    repaired,
    expectedPort,
  };
}

const PLAN_ABSENCE_CLAIM_RE =
  /(?:缺少|不存在|没有|未(?:注册|添加|实现|调用|使用|定义|监听)|\bmissing\b|\babsent\b|\bwithout\b|\bnot\s+(?:present|registered|implemented|called|used|defined)\b)/i;
const PLAN_TABULAR_CLAIM_RE =
  /(?:\b(?:csv|tsv|xls|xlsx|spreadsheet)\b|表格|数据源|物理层)/i;
const PLAN_TABULAR_EVIDENCE_TARGET_RE = /\.(?:csv|tsv|xls|xlsx)$/i;

function collectReadEvidenceForClaimGrounding(input: {
  evidenceRecords?: PlanEvidenceRecord[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
}): Array<{ target: string; detail: string }> {
  return [
    ...(input.evidenceRecords || [])
      .filter((record) =>
        PLAN_GROUNDING_READ_TOOLS.has(String(record.tool || "")) &&
        !/failed|blocked|rejected|declined/i.test(String(record.status || ""))
      )
      .map((record) => ({
        target: String(record.target || ""),
        detail: [record.summary, ...(record.facts || [])].filter(Boolean).join(" "),
      })),
    ...(input.recentToolActivity || [])
      .filter((activity) =>
        PLAN_GROUNDING_READ_TOOLS.has(String(activity.name || "")) &&
        !/failed|blocked|rejected|declined/i.test(String(activity.status || ""))
      )
      .map((activity) => ({
        target: String(activity.target || ""),
        detail: [activity.detail, ...(activity.facts || [])].filter(Boolean).join(" "),
      })),
  ];
}

function escapePlanEvidenceRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findContradictedDomReadyOrderingClaim(
  content: string,
  evidence: Array<{ target: string; detail: string }>,
): string | null {
  const patterns = [
    /`?([A-Za-z_$][A-Za-z0-9_$]{3,})`?\s*(?:\(\))?.{0,100}(?:DOM|document|文档).{0,50}(?:就绪|加载|ready).{0,20}(?:前|之前|before)/i,
    /`?([A-Za-z_$][A-Za-z0-9_$]{3,})`?\s*(?:\(\))?.{0,100}(?:before|早于).{0,50}(?:DOM|document|文档).{0,30}(?:就绪|加载|ready)/i,
    /(?:DOM|document|文档).{0,50}(?:就绪|加载|ready).{0,20}(?:前|之前|before).{0,100}`?([A-Za-z_$][A-Za-z0-9_$]{3,})`?\s*(?:\(\))?/i,
  ];
  for (const line of String(content || "").split(/\r?\n/)) {
    const lineTargets = [...line.matchAll(PLAN_CHANGE_TARGET_FILE_RE)]
      .map((targetMatch) => normalizePlanGroundingPath(targetMatch[0] || ""));
    const relevantEvidence = lineTargets.length > 0
      ? evidence.filter((item) => lineTargets.some((target) => planGroundingPathsMatch(target, item.target)))
      : evidence;
    const hasDomReadyBeforeClaim =
      /(?:DOM|document|文档).{0,50}(?:就绪|加载|ready).{0,20}(?:前|之前|before)/i.test(line) ||
      /(?:before|早于).{0,50}(?:DOM|document|文档).{0,30}(?:就绪|加载|ready)/i.test(line);
    if (hasDomReadyBeforeClaim) {
      for (const item of relevantEvidence) {
        if (!/event_dom_listener_contract\(DOMContentLoaded\)/i.test(item.detail)) continue;
        for (const callsMatch of item.detail.matchAll(/listener_calls\(([^)]*)\)/gi)) {
          const listenerIdentifiers = String(callsMatch[1] || "")
            .split(",")
            .map((value) => value.trim())
            .filter((value) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value));
          const observedIdentifier = listenerIdentifiers.find((identifier) => {
            return new RegExp(`\\b${escapePlanEvidenceRegExp(identifier)}\\b`).test(line);
          });
          if (observedIdentifier) return observedIdentifier;
        }
      }
    }
    const match = patterns.map((pattern) => line.match(pattern)).find(Boolean);
    const identifier = match?.[1] || "";
    if (!identifier) continue;
    const escapedIdentifier = escapePlanEvidenceRegExp(identifier);
    const listenerCall = new RegExp(`listener_calls\\([^)]*\\b${escapedIdentifier}\\b`, "i");
    if (relevantEvidence.some((item) =>
      /event_dom_listener_contract\(DOMContentLoaded\)/i.test(item.detail) &&
      listenerCall.test(item.detail)
    )) {
      return identifier;
    }
  }
  return null;
}

function evidenceContainsPositiveIdentifierObservation(
  detail: string,
  identifier: string,
  claimLine: string,
): boolean {
  const lowerIdentifier = identifier.toLowerCase();
  const callAbsenceClaim =
    /(?:没有|未|从未).{0,12}(?:调用|执行)|(?:not|never).{0,16}(?:called|invoked|executed)|without\s+(?:calling|invoking|executing)/i.test(claimLine);
  if (callAbsenceClaim) {
    const escapedIdentifier = escapePlanEvidenceRegExp(identifier);
    const listenerCall = new RegExp(`listener_calls\\([^)]*\\b${escapedIdentifier}\\b`, "i");
    if (listenerCall.test(detail)) return true;
    const callPattern = new RegExp(`\\b${escapedIdentifier}\\s*\\(`, "gi");
    for (const match of detail.matchAll(callPattern)) {
      const preceding = detail.slice(Math.max(0, (match.index || 0) - 48), match.index || 0);
      if (!/(?:function|fn|def|class|interface|type|const|let|var)\s+$/i.test(preceding)) {
        return true;
      }
    }
    return false;
  }

  const lowerDetail = detail.toLowerCase();
  let index = lowerDetail.indexOf(lowerIdentifier);
  while (index >= 0) {
    // Evidence that repeats the same negative statement supports the
    // diagnosis; it is not a contradiction. Require a source-like positive
    // occurrence outside an absence window.
    const preceding = detail.slice(Math.max(0, index - 100), index);
    if (!PLAN_ABSENCE_CLAIM_RE.test(preceding)) return true;
    index = lowerDetail.indexOf(lowerIdentifier, index + lowerIdentifier.length);
  }
  return false;
}

/**
 * Return only identifiers that are the grammatical subject/object of a
 * source-absence assertion. A diagnostic line can legitimately say that one
 * function uses the wrong identifier or fails to bind an event while naming
 * several existing functions. Treating every identifier after words such as
 * "没有" as absent turns those relationship diagnoses into false
 * contradictions.
 */
function collectDirectAbsenceClaimIdentifiers(line: string): string[] {
  const identifiers = new Set<string>();
  const addMatches = (pattern: RegExp, group = 1) => {
    for (const match of line.matchAll(pattern)) {
      const identifier = String(match[group] || "").trim();
      if (identifier) identifiers.add(identifier);
    }
  };

  // Explicit call assertions are safe to check against structured call
  // observations. Keep the called identifier close to the assertion verb so
  // contextual function names later in the sentence are not captured.
  addMatches(/(?:没有|未|从未)\s*(?:实际)?(?:调用|执行)\s*[`'"“‘]?([A-Za-z_$][A-Za-z0-9_$]{3,})/gi);
  addMatches(/(?:not|never)\s+(?:called|invoked|executed)\s*[`'"“‘]?([A-Za-z_$][A-Za-z0-9_$]{3,})/gi);
  addMatches(/without\s+(?:calling|invoking|executing)\s*[`'"“‘]?([A-Za-z_$][A-Za-z0-9_$]{3,})/gi);

  // Source-presence assertions. Deliberately exclude relational verbs such as
  // 未使用、未实现、未注册 and phrases such as 没有在 ...; seeing an identifier
  // elsewhere in source is not evidence that those relationships exist.
  addMatches(/(?:缺少|没有|不存在|未定义)\s*(?:必要的|对应的|任何)?\s*[`'"“‘]?([A-Za-z_$][A-Za-z0-9_$]{3,})/gi);
  addMatches(/(?:missing|absent)\s+(?:an?\s+|the\s+)?[`'"“‘]?([A-Za-z_$][A-Za-z0-9_$]{3,})/gi);
  addMatches(/\b([A-Za-z_$][A-Za-z0-9_$]{3,})\b\s*(?:\(\))?\s*(?:函数|方法|变量|监听器|保护)?\s*(?:不存在|未定义)/gi);
  addMatches(/\b([A-Za-z_$][A-Za-z0-9_$]{3,})\b\s*(?:\(\))?\s+is\s+(?:missing|absent|not\s+(?:present|defined))/gi);

  return [...identifiers];
}

/** Reject an absence claim when the cited source observation contains it. */
export function findContradictedPlanDiagnosticClaim(input: {
  content: string;
  evidenceRecords?: PlanEvidenceRecord[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
}): string | null {
  const evidence = collectReadEvidenceForClaimGrounding(input);
  if (evidence.length === 0) return null;
  const orderingContradiction = findContradictedDomReadyOrderingClaim(input.content, evidence);
  if (orderingContradiction) return orderingContradiction;
  for (const line of String(input.content || "").split(/\r?\n/)) {
    const claim = line.match(PLAN_ABSENCE_CLAIM_RE);
    if (!claim) continue;
    const identifiers = collectDirectAbsenceClaimIdentifiers(line);
    if (identifiers.length === 0) continue;
    const lineTargets = [...line.matchAll(PLAN_DIAGNOSTIC_CLAIM_TARGET_FILE_RE)]
      .map((match) => normalizePlanGroundingPath(match[0] || ""));
    const targetMatchedEvidence = lineTargets.length > 0
      ? evidence.filter((item) => lineTargets.some((target) => planGroundingPathsMatch(target, item.target)))
      : [];
    const tabularEvidence = PLAN_TABULAR_CLAIM_RE.test(line)
      ? evidence.filter((item) => PLAN_TABULAR_EVIDENCE_TARGET_RE.test(item.target))
      : [];
    // Absence is always relative to a source. A statement such as "the CSV
    // has no creatorName column" is not contradicted by a TypeScript interface
    // that defines creatorName. Prefer an exact line target, then a clearly
    // named source family, and only fall back to all evidence when the claim
    // itself has no usable scope.
    const relevantEvidence = lineTargets.length > 0
      ? targetMatchedEvidence
      : tabularEvidence.length > 0
        ? tabularEvidence
        : evidence;
    for (const identifier of identifiers) {
      const hasPositiveObservation = relevantEvidence.some((item) => {
        return evidenceContainsPositiveIdentifierObservation(item.detail, identifier, line);
      });
      if (hasPositiveObservation) {
        return identifier;
      }
    }
  }
  return null;
}

export function validatePlanEvidenceGrounding(input: {
  content: string;
  evidence?: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
  evidenceBundle?: PlanEvidenceBundle;
}): PlanArtifactQualityResult {
  const contradictedClaim = findContradictedPlanDiagnosticClaim(input);
  if (contradictedClaim) {
    return classifyPlanArtifactQualityResult({
      ok: false,
      reason: `plan_diagnostic_claim_contradicted:${contradictedClaim}`,
    });
  }
  const readTargets = [
    ...collectReadEvidenceTargets(input),
    ...(input.evidenceBundle?.facts.map((fact) => fact.target) || []),
  ];
  const changeTargets = collectPlanChangeTargets(input.content);
  if (readTargets.length === 0) {
    return classifyPlanArtifactQualityResult({ ok: true });
  }

  const keyChangesBody = extractPlanGroundingSectionBody(
    input.content,
    isPlanGroundingMutationSectionHeading,
  );
  const hasSourceBackedMutationPlan =
    readTargets.some((target) => /\.(?:tsx?|jsx?|mjs|cjs|swift|py|rs|go|json|toml|ya?ml|css|scss|html)$/i.test(target)) &&
    keyChangesBody.split(/\r?\n/).some(isPlanMutationLine);
  if (changeTargets.length === 0) {
    if (!hasSourceBackedMutationPlan) return classifyPlanArtifactQualityResult({ ok: true });
    if (input.evidenceBundle) {
      const candidate = buildPlanCandidate({ content: input.content, bundle: input.evidenceBundle });
      const groundedCandidateChanges = candidate.changes.length > 0 && candidate.changes.every((change) =>
        !!change.targetRef && change.evidenceRefs.length > 0
      );
      if (groundedCandidateChanges) return classifyPlanArtifactQualityResult({ ok: true });
    }
    return classifyPlanArtifactQualityResult({ ok: false, reason: "missing_grounded_plan_change_target" });
  }

  const ungroundedTargets = changeTargets.filter((target) =>
    !readTargets.some((readTarget) => planGroundingPathsMatch(target, readTarget))
  );
  if (ungroundedTargets.length > 0) {
    return classifyPlanArtifactQualityResult({
      ok: false,
      reason: `ungrounded_plan_change_targets:${ungroundedTargets.slice(0, 4).join(",")}`,
    });
  }
  if (!PLAN_CONFIRMED_EVIDENCE_HEADING_RE.test(String(input.content || ""))) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "missing_plan_evidence_section" });
  }
  return classifyPlanArtifactQualityResult({ ok: true });
}

export function validateGroundedActionablePlanArtifact(input: {
  content: string;
  evidence?: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
  evidenceBundle?: PlanEvidenceBundle;
}): PlanArtifactQualityResult {
  const structural = validateActionablePlanArtifact(input.content);
  if (!structural.ok) return structural;
  return validatePlanEvidenceGrounding(input);
}

function repairMissingPlanEvidenceSection(input: {
  content: string;
  evidence?: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
  language: "zh" | "en";
}): string | null {
  const changeTargets = collectPlanChangeTargets(input.content);
  if (changeTargets.length === 0) return null;

  const matchesChangedTarget = (value: string): boolean => {
    const normalized = normalizePlanGroundingPath(value);
    return changeTargets.some((target) => planGroundingPathsMatch(target, normalized));
  };
  const evidenceLines = uniquePlanItems([
    ...(input.evidence || [])
      .map((item) => summarizeEvidenceLine(item, input.language))
      .filter((item) => changeTargets.some((target) => evidenceMentionsFile(item, target))),
    ...(input.evidenceRecords || [])
      .filter((record) =>
        PLAN_GROUNDING_READ_TOOLS.has(String(record.tool || "")) &&
        !/failed|blocked|rejected|declined/i.test(String(record.status || "")) &&
        matchesChangedTarget(record.target || "")
      )
      .map((record) => formatPlanEvidenceRecord(record, input.language)),
    ...(input.recentToolActivity || [])
      .filter((activity) =>
        PLAN_GROUNDING_READ_TOOLS.has(String(activity.name || "")) &&
        !/failed|blocked|rejected|declined/i.test(String(activity.status || "")) &&
        matchesChangedTarget(activity.target || "")
      )
      .map((activity) => summarizeEvidenceLine(
        summarizeToolActivityForEvidence(activity),
        input.language,
      )),
  ], 6, 1200, true).filter(isConcretePlanEvidence);
  if (evidenceLines.length === 0) return null;

  const section = [
    input.language === "zh" ? "## 已确认证据" : "## Confirmed Evidence",
    ...evidenceLines.map((line) => `- ${line}`),
  ];
  const lines = input.content.trim().split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line.trim()));
  const nextTitleIndex = lines.findIndex((line, index) =>
    index > titleIndex && /^#\s+\S/.test(line.trim())
  );
  const formalPlanEnd = nextTitleIndex >= 0 ? nextTitleIndex : lines.length;
  const summaryIndex = lines.findIndex((line, index) =>
    index > titleIndex &&
    index < formalPlanEnd &&
    /^#{1,6}\s+(?:摘要|Summary)\s*$/i.test(line.trim())
  );
  let insertAt = lines.findIndex((line, index) =>
    index > Math.max(summaryIndex, titleIndex) &&
    index <= formalPlanEnd &&
    /^#{1,6}\s+\S/.test(line.trim())
  );
  if (insertAt < 0) insertAt = formalPlanEnd;
  if (summaryIndex < 0) {
    insertAt = titleIndex >= 0 ? titleIndex + 1 : 0;
  }

  lines.splice(insertAt, 0, "", ...section, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function appendItemsToPlanRoleSection(input: {
  content: string;
  heading: RegExp;
  items: string[];
}): string | null {
  const items = uniquePlanItems(input.items, 6, 4000, true);
  if (items.length === 0) return null;
  const lines = String(input.content || "").trim().split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => {
    const match = line.trim().match(/^#{1,6}\s+(.+?)\s*$/);
    return Boolean(match && input.heading.test(normalizePlanSectionRoleTitle(match[1] || "")));
  });
  if (headingIndex < 0) return null;

  let sectionEnd = lines.findIndex((line, index) =>
    index > headingIndex && /^#{1,6}\s+\S/.test(line.trim())
  );
  if (sectionEnd < 0) sectionEnd = lines.length;
  while (sectionEnd > headingIndex + 1 && !lines[sectionEnd - 1]?.trim()) {
    sectionEnd -= 1;
  }
  lines.splice(sectionEnd, 0, ...items.map((item) => `- ${item}`));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function repairMissingGroundedPlanChangeTargets(input: {
  content: string;
  userGoal?: string;
  evidence?: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  files?: string[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
  language: "zh" | "en";
}): string | null {
  const readTargets = collectReadEvidenceTargets(input);
  if (readTargets.length === 0) return null;

  const evidenceLines = uniquePlanItems([
    ...(input.evidence || []).map((item) => summarizeEvidenceLine(item, input.language)),
    ...(input.evidenceRecords || [])
      .filter((record) =>
        PLAN_GROUNDING_READ_TOOLS.has(String(record.tool || "")) &&
        !/failed|blocked|rejected|declined/i.test(String(record.status || ""))
      )
      .map((record) => formatPlanEvidenceRecord(record, input.language)),
    ...(input.recentToolActivity || [])
      .filter((activity) =>
        PLAN_GROUNDING_READ_TOOLS.has(String(activity.name || "")) &&
        !/failed|blocked|rejected|declined/i.test(String(activity.status || ""))
      )
      .map((activity) => summarizeEvidenceLine(
        summarizeToolActivityForEvidence(activity),
        input.language,
      )),
  ], 12, 1600, true).filter(isMeaningfulConcretePlanEvidence);
  if (evidenceLines.length === 0) return null;

  const sections = parsePlanSections(input.content);
  const inferredGoal = compactPlanLine(
    input.userGoal || collectLinesFromSections(sections, [
      /^(?:用户目标|目标|需求|Goal|Objective|User Request)$/i,
    ], 1, 420, true)[0] || "",
    420,
    true,
  );
  const files = uniquePlanItems([
    ...(input.files || []),
    ...collectPathLikePlanItems(input.content, 12),
  ], 12, 180).filter(isActionablePlanFile);
  const repairLines = files.flatMap((file) => {
    const isRead = readTargets.some((target) => planGroundingPathsMatch(file, target));
    if (!isRead) return [];
    const grounding = evidenceLines.find((item) => evidenceMentionsFile(item, file));
    if (!grounding) return [];
    return [buildDeterministicChangeLine({
      file,
      goal: inferredGoal,
      evidence: grounding,
      language: input.language,
    })];
  });
  if (repairLines.length === 0) return null;

  return appendItemsToPlanRoleSection({
    content: input.content,
    heading: PLAN_KEY_CHANGES_HEADING_RE,
    items: repairLines,
  });
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

// The user commonly describes a broken startup command in ordinary prose
// (for example, "npm run tauri dev 无法启动") rather than in a Markdown code
// span.  Deterministic plan recovery used to look only at backticks in tool
// evidence/constraints, silently replacing that acceptance criterion with a
// generic `cargo check`.  Preserve explicit interactive startup commands as
// first-class validation work even when the model's plan draft is too short.
const EXPLICIT_INTERACTIVE_STARTUP_COMMAND_RE =
  /\b((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:tauri\s+dev|dev|start|serve|preview|storybook)|(?:cargo\s+)?tauri\s+dev|(?:vite|next|nuxt|nuxi|astro)\s+(?:dev|start|serve|preview)|webpack-dev-server)\b/gi;
const INTERACTIVE_STARTUP_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:tauri\s+dev|dev|start|serve|preview|storybook)\b|\b(?:cargo\s+)?tauri\s+dev\b|\b(?:vite|next|nuxt|nuxi|astro)\s+(?:dev|start|serve|preview)\b|\bwebpack-dev-server\b/i;

function extractExplicitInteractiveStartupCommands(value: string, maxItems = 3): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const match of String(value || "").matchAll(EXPLICIT_INTERACTIVE_STARTUP_COMMAND_RE)) {
    const command = String(match[1] || "").replace(/\s+/g, " ").trim();
    const key = command.toLowerCase();
    if (!command || seen.has(key)) continue;
    seen.add(key);
    commands.push(command);
    if (commands.length >= maxItems) break;
  }
  return commands;
}

function uniqueValidationCommands(values: string[], maxItems = 4): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const raw of values) {
    const command = String(raw || "").replace(/\s+/g, " ").trim();
    const key = command.toLowerCase();
    if (!command || seen.has(key)) continue;
    seen.add(key);
    commands.push(command);
    if (commands.length >= maxItems) break;
  }
  return commands;
}

function isInteractiveStartupCommand(command: string): boolean {
  return INTERACTIVE_STARTUP_COMMAND_RE.test(String(command || ""));
}

function isTauriDesktopStartupCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?tauri\s+dev\b|\b(?:cargo\s+)?tauri\s+dev\b/i.test(
    String(command || ""),
  );
}

function buildDeterministicValidationPlanLines(input: {
  commands: string[];
  language: "zh" | "en";
  desktopRuntimeRequired?: boolean;
}): string[] {
  const lines = input.commands.map((command) => {
    if (!isInteractiveStartupCommand(command)) {
      return input.language === "zh"
        ? `运行 \`${command}\` 并检查退出码与输出。`
        : `Run \`${command}\` and inspect exit status/output.`;
    }
    return input.language === "zh"
      ? `使用 \`execute_command\` 启动 \`${command}\`，随后使用 \`read_pty_since\`、\`read_pty_tail\` 或 \`get_pty_status\` 检查新增启动输出和错误；在 PTY 观察完成前不得将该启动验证标记通过。 （证据：cmd:${command}）`
      : `Use \`execute_command\` to start \`${command}\`, then use \`read_pty_since\`, \`read_pty_tail\`, or \`get_pty_status\` to inspect new startup output/errors; do not mark startup validation passed before that PTY observation. (evidence: cmd:${command})`;
  });

  if (input.desktopRuntimeRequired || input.commands.some(isTauriDesktopStartupCommand)) {
    lines.push(input.language === "zh"
      ? "在实际启动的桌面窗口中逐项验证用户目标涉及的交互场景；此项保留待桌面运行时/用户确认，不能用静态检查、构建或 HTTP 探测代替。 （证据：tauri_required:desktop runtime interaction）"
      : "In the actually launched desktop window, verify each interactive scenario in the user goal; keep this pending desktop-runtime/user confirmation and do not substitute a static check, build, or HTTP probe. (evidence: tauri_required:desktop runtime interaction)");
  }

  return lines;
}

export type TrustedValidationPlanRepairReason =
  | "missing_trusted_validation_command"
  | "missing_plan_validation_section";

export type TrustedValidationPlanRepairResult =
  | { ok: true; repaired: boolean; content: string; commands: string[]; reason: null }
  | { ok: false; repaired: false; content: string; commands: []; reason: TrustedValidationPlanRepairReason };

/**
 * Add only runtime-supplied, finite commands to the existing validation
 * section. Command discovery belongs to the trusted workspace-manifest layer;
 * this pure representation repair never infers a command from file names.
 */
export function appendTrustedValidationCommandsToPlan(input: {
  content: string;
  commands: string[];
  language?: "zh" | "en";
}): TrustedValidationPlanRepairResult {
  const content = String(input.content || "");
  const commands = uniqueValidationCommands(input.commands)
    .filter(isFinitePlanValidationCommand)
    .filter((command) => !content.includes(`\`${command}\``));
  if (commands.length === 0) {
    return {
      ok: false,
      repaired: false,
      content,
      commands: [],
      reason: "missing_trusted_validation_command",
    };
  }
  const headingIndex = findPlanValidationSectionHeadingLineIndex(content);
  if (headingIndex < 0) {
    return {
      ok: false,
      repaired: false,
      content,
      commands: [],
      reason: "missing_plan_validation_section",
    };
  }

  const language = input.language === "en" ? "en" : "zh";
  const lines = content.split(/\r?\n/);
  let insertIndex = headingIndex + 1;
  while (insertIndex < lines.length && !lines[insertIndex]?.trim()) insertIndex += 1;
  const validationLines = buildDeterministicValidationPlanLines({ commands, language })
    .map((line) => `- ${line}`);
  lines.splice(insertIndex, 0, ...validationLines, "");
  return {
    ok: true,
    repaired: true,
    content: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    commands,
    reason: null,
  };
}

function labelPlanReferenceLines(
  lines: string[],
  prefix: PlanFacetReferencePrefix,
  enabled: boolean,
): string[] {
  if (!enabled) return lines;
  return lines.map((line, index) => `[${prefix}${index + 1}] ${line}`);
}

function selectFacetReferenceIds(input: {
  facetText: string;
  facetTerms?: Set<string>;
  lines: string[];
  prefix: PlanFacetReferencePrefix;
  mappingContext?: string;
}): string[] {
  const facetTerms = input.facetTerms || semanticFacetTerms(input.facetText);
  const context = String(input.mappingContext || "");
  const contextPaths = [...context.matchAll(PLAN_CHANGE_TARGET_FILE_RE)]
    .map((match) => normalizePlanGroundingPath(match[0] || ""))
    .filter(Boolean);
  const contextAnchors = new Set<string>();
  for (const match of context.matchAll(/`([^`\n]{3,120})`/g)) {
    const anchor = String(match[1] || "").trim().toLowerCase();
    if (/^[A-Za-z0-9_@./:-]+$/.test(anchor)) contextAnchors.add(anchor);
  }
  for (const match of context.matchAll(/\b[A-Za-z][A-Za-z0-9_./:-]{3,}\b/g)) {
    const anchor = String(match[0] || "").toLowerCase();
    if (!/^(?:this|that|with|from|into|plan|issue|problem|change|changes|evidence|validation|source|target|file|read_file|function|const|return)$/.test(anchor)) {
      contextAnchors.add(anchor);
    }
  }
  const matchingIndexes = input.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const comparableLine = input.prefix === "C"
        ? line.split(/(?:依据证据|Grounding evidence)\s*[:：]/i)[0]
        : line;
      const normalizedLine = comparableLine.toLowerCase().replace(/\\/g, "/");
      const hasMappedPath = contextPaths.some((path) =>
        planGroundingPathsMatch(path, comparableLine) || normalizedLine.includes(path)
      );
      // A model-authored facet section with concrete paths is a stronger
      // relation than a shared framework or subsystem token. Requiring that
      // path prevents, for example, every Tauri change from being assigned to
      // an unrelated Tauri startup facet.
      if (contextPaths.length > 0) return hasMappedPath;
      if (facetLineStronglyCovered(facetTerms, line)) return true;
      if (!context) return false;
      return [...contextAnchors].some((anchor) =>
        anchor.length >= 4 && normalizedLine.includes(anchor)
      );
    })
    .map(({ index }) => index);
  return matchingIndexes.map((index) => `${input.prefix}${index + 1}`);
}

function buildFacetMappingContext(input: {
  facetIndex: number;
  facetText: string;
  facetTerms: Set<string>;
  source?: string;
}): string {
  const source = String(input.source || "").trim();
  if (!source) return "";
  const ordinalPattern = new RegExp(
    `^(?:(?:分面|需求|目标|问题|Facet|Requirement|Goal|Issue)\\s*#?\\s*)?${input.facetIndex}\\s*(?:[\u3001.\uff0e):：-]|的)`,
    "i",
  );
  const sections = parsePlanSections(source);
  const sectionContexts = sections
    .filter((section) =>
      ordinalPattern.test(section.title.trim()) ||
      facetSectionCovered(
        input.facetTerms,
        `${section.ancestors.join("\n")}\n${section.title}\n${section.body}`,
      )
    )
    .map((section) => `${section.ancestors.join("\n")}\n${section.title}\n${section.body}`);
  if (sectionContexts.length > 0) return sectionContexts.join("\n");

  const lines = source.split(/\r?\n/);
  const windows: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (
      !ordinalPattern.test((lines[index] || "").trim()) &&
      !facetSectionCovered(input.facetTerms, lines[index] || "")
    ) continue;
    windows.push(lines.slice(index, Math.min(lines.length, index + 10)).join("\n"));
  }
  return windows.join("\n");
}

function buildFacetValidationPlanLines(input: {
  facets: Array<{ index: number; text: string }>;
  language: "zh" | "en";
}): string[] {
  if (input.facets.length < 2) return [];
  return input.facets.map((facet) => input.language === "zh"
    ? `按分面 ${facet.index} 的原始约束“${facet.text}”执行其涉及的输入、操作或检查，记录实际结果，并确认该分面单独通过；不得用其他分面的结果或仅用构建成功代替。`
    : `Exercise the inputs, actions, or checks in facet ${facet.index} ("${facet.text}"), record the observed result, and confirm this facet passes independently; do not substitute another facet or a successful build.`);
}

function buildFacetTraceabilityPlanLines(input: {
  facets: Array<{ index: number; text: string }>;
  evidenceLines: string[];
  changeLines: string[];
  decisionLines?: string[];
  language: "zh" | "en";
  mappingSource?: string;
}): string[] {
  if (
    input.facets.length < 2 ||
    input.evidenceLines.length === 0 ||
    (input.changeLines.length === 0 && (input.decisionLines?.length || 0) === 0)
  ) return [];
  const allFacetTexts = input.facets.map((facet) => facet.text);
  return input.facets.flatMap((facet, position) => {
    const facetTerms = distinctSemanticFacetTerms(facet.text, allFacetTexts);
    const mappingContext = buildFacetMappingContext({
      facetIndex: facet.index,
      facetText: facet.text,
      facetTerms,
      source: input.mappingSource,
    });
    const evidenceRefs = selectFacetReferenceIds({
      facetText: facet.text,
      facetTerms,
      lines: input.evidenceLines,
      prefix: "E",
      mappingContext,
    });
    const changeRefs = selectFacetReferenceIds({
      facetText: facet.text,
      facetTerms,
      lines: input.changeLines,
      prefix: "C",
      mappingContext,
    });
    const decisionRefs = selectFacetReferenceIds({
      facetText: facet.text,
      facetTerms,
      lines: input.decisionLines || [],
      prefix: "D",
      mappingContext,
    });
    if (evidenceRefs.length === 0 || (changeRefs.length === 0 && decisionRefs.length === 0)) return [];
    const evidence = evidenceRefs.join(input.language === "zh" ? "、" : ", ");
    const actionRefs = changeRefs.length > 0 ? changeRefs : decisionRefs;
    const actions = actionRefs.join(input.language === "zh" ? "、" : ", ");
    const actionLabel = changeRefs.length > 0
      ? input.language === "zh" ? "改动目标" : "change targets"
      : input.language === "zh" ? "已确认决策" : "confirmed decisions";
    const validation = `V${position + 1}`;
    return [input.language === "zh"
      ? `分面 ${facet.index}（${facet.text}）：由已确认事实 ${evidence} 共同约束，对应${actionLabel} ${actions}，并由 ${validation} 独立验收。`
      : `Facet ${facet.index} (${facet.text}): jointly grounded by confirmed evidence ${evidence}, mapped to ${actionLabel} ${actions}, and independently accepted by ${validation}.`];
  });
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

function buildDeterministicContractFindings(
  contractMismatchKinds: string[] = [],
  language: "zh" | "en",
): string[] {
  const findings: string[] = [];
  for (const kind of contractMismatchKinds) {
    if (kind.startsWith("unregistered_command:")) {
      const command = kind.slice("unregistered_command:".length);
      findings.push(language === "zh"
        ? `已确认调用方使用命令 \`${command}\`，但后端 \`generate_handler!\` 注册表中没有对应处理器。`
        : `The caller invokes command \`${command}\`, but the backend \`generate_handler!\` registry has no matching handler.`);
    } else if (kind.startsWith("event_listener_api:")) {
      const eventName = kind.slice("event_listener_api:".length);
      findings.push(language === "zh"
        ? `已确认生产方通过 Tauri event transport 发出 \`${eventName}\`，消费方却使用 DOM \`addEventListener\`，两端事件 API 契约不一致。`
        : `The producer emits \`${eventName}\` through the Tauri event transport while the consumer uses DOM \`addEventListener\`; the event API contracts do not match.`);
    } else if (kind.startsWith("missing_permission:")) {
      const plugin = kind.slice("missing_permission:".length);
      findings.push(language === "zh"
        ? `已确认应用配置了 \`${plugin}\` 插件，但 capability 证据中没有对应的 \`${plugin}:*\` 权限。`
        : `The app configures the \`${plugin}\` plugin, but the capability evidence contains no matching \`${plugin}:*\` permission.`);
    } else if (kind.startsWith("config_value_mismatch:")) {
      const key = kind.slice("config_value_mismatch:".length);
      findings.push(language === "zh"
        ? `已确认同一启动链路的多个配置对 \`${key}\` 给出了不同值。`
        : `Multiple configurations in the same startup path define conflicting values for \`${key}\`.`);
    }
  }
  return findings;
}

function buildDeterministicConfigurationDecisionLines(
  contracts: PlanConfigurationContractAssessment[] = [],
  language: "zh" | "en",
): string[] {
  return contracts
    .filter((contract) => contract.status === "consistent")
    .map((contract) => {
      const targets = contract.targets.map((target) => `\`${target}\``).join(language === "zh" ? "、" : ", ");
      const values = contract.values.map((value) => `\`${value}\``).join(language === "zh" ? "、" : ", ");
      return language === "zh"
        ? `保持 ${targets} 中已确认一致的 \`${contract.key}\` 值 ${values}，不把该配置列为修复改动；通过实际启动输出验证结论，若失败原因指向其他边界，再生成最小计划修订。`
        : `Keep the confirmed matching \`${contract.key}\` value ${values} in ${targets} unchanged rather than inventing a configuration fix; validate the conclusion from actual startup output and create a minimal plan revision only if it identifies another boundary.`;
    });
}

function escapePlanRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceSupportsContractMismatch(evidence: string, kind: string): boolean {
  const value = String(evidence || "");
  if (kind.startsWith("unregistered_command:")) {
    const command = kind.slice("unregistered_command:".length);
    return new RegExp(`(?:command_invoke_contract\\s*\\(${escapePlanRegExp(command)}\\)|handler_contract\\s*\\()`, "i")
      .test(value);
  }
  if (kind.startsWith("event_listener_api:")) {
    const eventName = kind.slice("event_listener_api:".length);
    return new RegExp(
      `event_(?:emit|dom_listener|tauri_listener)_contract\\s*\\(${escapePlanRegExp(eventName)}\\)`,
      "i",
    ).test(value);
  }
  if (kind.startsWith("missing_permission:")) {
    const plugin = kind.slice("missing_permission:".length);
    const pluginPattern = escapePlanRegExp(plugin).replace(/\\-/g, "[-_]");
    return (
      /(?:^|[\\/])capabilit(?:y|ies)[\\/]/i.test(value) &&
        /permission_contract\s*\(/i.test(value)
    ) ||
      new RegExp(`(?:@tauri-apps/plugin-|tauri_plugin_)${pluginPattern}`, "i").test(value);
  }
  if (kind.startsWith("config_value_mismatch:")) {
    return /\b(?:devUrl|dev[_-]?server|development server|port)\b\s*["']?\s*[:=]|--port(?:=|\s+)|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])\s*:\s*\d{2,5}/i
      .test(value);
  }
  return false;
}

function prioritizeContractEvidence(
  evidence: string[],
  contractMismatchKinds: string[] = [],
): string[] {
  if (contractMismatchKinds.length === 0) return evidence;
  const contractEvidence = evidence.filter((item) =>
    contractMismatchKinds.some((kind) => evidenceSupportsContractMismatch(item, kind))
  );
  return uniquePlanItems([...contractEvidence, ...evidence], evidence.length, 320, true);
}

function buildDeterministicChangeLine(input: {
  file: string;
  goal: string;
  evidence: string;
  language: "zh" | "en";
  contractMismatchKinds?: string[];
}): string {
  const file = input.file;
  const lowerFile = file.toLowerCase();
  const evidence = input.evidence || (
    input.language === "zh" ? "已读项目证据确认该文件在影响范围内" : "read project evidence confirms this file is in scope"
  );
  const localContractMismatchKinds = (input.contractMismatchKinds || []).filter((kind) => {
    if (kind.startsWith("unregistered_command:")) {
      return /\.rs$/i.test(lowerFile) && /handler_contract\s*\(/i.test(evidence);
    }
    if (kind.startsWith("event_listener_api:")) {
      const eventName = kind.slice("event_listener_api:".length);
      return evidence.includes(`event_dom_listener_contract(${eventName})`);
    }
    if (kind.startsWith("missing_permission:")) {
      return /(?:^|\/)capabilit(?:y|ies)\//i.test(lowerFile) && /permission_contract\s*\(/i.test(evidence);
    }
    if (kind.startsWith("config_value_mismatch:")) {
      return /\b(?:devUrl|dev[_-]?server|development server|port)\b\s*["']?\s*[:=]|--port(?:=|\s+)|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])\s*:\s*\d{2,5}/i.test(evidence);
    }
    return false;
  });
  const missingCommands = localContractMismatchKinds
    .filter((kind) => kind.startsWith("unregistered_command:"))
    .map((kind) => kind.slice("unregistered_command:".length))
    .filter(Boolean);
  const mismatchedEvents = localContractMismatchKinds
    .filter((kind) => kind.startsWith("event_listener_api:"))
    .map((kind) => kind.slice("event_listener_api:".length))
    .filter(Boolean);
  const missingPluginPermissions = localContractMismatchKinds
    .filter((kind) => kind.startsWith("missing_permission:"))
    .map((kind) => kind.slice("missing_permission:".length))
    .filter(Boolean);
  const mismatchedConfigurationKeys = localContractMismatchKinds
    .filter((kind) => kind.startsWith("config_value_mismatch:"))
    .map((kind) => kind.slice("config_value_mismatch:".length))
    .filter(Boolean);
  const pluginPermissionList = missingPluginPermissions
    .map((plugin) => `\`${plugin}:default\``)
    .join(", ");
  const commandList = missingCommands.map((command) => `\`${command}\``).join(", ");
  const eventList = mismatchedEvents.map((eventName) => `\`${eventName}\``).join(", ");
  if (input.language === "en") {
    if (/\.rs$/i.test(lowerFile) && missingCommands.length > 0) {
      return `Implement the missing Tauri command${missingCommands.length > 1 ? "s" : ""} ${commandList} in \`${file}\` and add ${missingCommands.length > 1 ? "them" : "it"} to the existing \`generate_handler!\` registration with an argument, return, and error contract that matches the caller. Grounding evidence: ${evidence}.`;
    }
    if (/\.(?:[cm]?js|jsx|tsx?)$/i.test(lowerFile) && (missingCommands.length > 0 || mismatchedEvents.length > 0)) {
      const actions = [
        missingCommands.length > 0
          ? `keep the ${commandList} invocation aligned with the registered Rust argument and return contract`
          : "",
        mismatchedEvents.length > 0
          ? `replace the DOM listener for ${eventList} with the Tauri event API, consume its payload, and dispose the listener during teardown`
          : "",
      ].filter(Boolean).join("; ");
      return `Update \`${file}\` to ${actions}. Grounding evidence: ${evidence}.`;
    }
    if (/capabilit(?:y|ies).+\.json$/i.test(lowerFile) && missingPluginPermissions.length > 0) {
      return `Add the minimum permissions required by the configured Tauri plugins to \`${file}\` (${pluginPermissionList}), without widening unrelated capabilities. Grounding evidence: ${evidence}.`;
    }
    if (mismatchedConfigurationKeys.length > 0) {
      return `Align \`${mismatchedConfigurationKeys.join("`, `")}\` in \`${file}\` with the other read-backed configuration owner in the same startup path, changing only the side that differs from the canonical development command. Grounding evidence: ${evidence}.`;
    }
    return `Repair the concrete implementation mismatch recorded for \`${file}\` (${evidence}) so it satisfies the reviewed objective: ${summarizeGoalForPlanChange(input.goal, "en")}. Preserve unrelated behavior and verify that exact path.`;
  }

  if (/\.rs$/i.test(lowerFile) && missingCommands.length > 0) {
    return `在 \`${file}\` 中实现缺失的 Tauri 命令 ${commandList}，并加入现有 \`generate_handler!\` 注册；命令参数、返回值和错误传播必须与调用方契约一致。依据证据：${evidence}。`;
  }
  if (/\.(?:[cm]?js|jsx|tsx?)$/i.test(lowerFile) && (missingCommands.length > 0 || mismatchedEvents.length > 0)) {
    const actions = [
      missingCommands.length > 0
        ? `让 ${commandList} 调用的参数与 Rust 命令注册契约一致`
        : "",
      mismatchedEvents.length > 0
        ? `把 ${eventList} 的 DOM 监听改为 Tauri event API，读取其 payload，并在卸载时释放监听器`
        : "",
    ].filter(Boolean).join("；");
    return `修改 \`${file}\`：${actions}。依据证据：${evidence}。`;
  }
  if (/capabilit(?:y|ies).+\.json$/i.test(lowerFile) && missingPluginPermissions.length > 0) {
    return `在 \`${file}\` 中加入已配置 Tauri 插件所需的最小权限（${pluginPermissionList}），并保持其他 capability 不变。依据证据：${evidence}。`;
  }
  if (mismatchedConfigurationKeys.length > 0) {
    return `将 \`${file}\` 中的 \`${mismatchedConfigurationKeys.join("`、`")}\` 与同一启动链路的另一已读配置所有者对齐，只修改偏离规范开发命令的一侧。依据证据：${evidence}。`;
  }
  return `修复 \`${file}\` 中已读证据明确记录的实现不一致（${evidence}），使其满足已审核目标“${summarizeGoalForPlanChange(input.goal, "zh")}”；保持无关行为不变，并验证这条精确链路。`;
}

function buildCodexStylePlanArtifact(input: {
  userGoal: string;
  evidence: string[];
  files: string[];
  constraints: string[];
  language: "zh" | "en";
  contractMismatchKinds?: string[];
  configurationContracts?: PlanConfigurationContractAssessment[];
  facetMappingSource?: string;
}): string {
  const facets = extractNumberedUserGoalFacets(input.userGoal);
  const facetTraceabilityEnabled = facets.length >= 2;
  const goal = compactPlanLine(input.userGoal, 420);
  const rawEvidence = prioritizeContractEvidence(
    uniqueCompactLines(input.evidence, 24, 320, true),
    input.contractMismatchKinds,
  );
  const concreteEvidence = rawEvidence.filter(isConcretePlanEvidence);
  const meaningfulConcreteEvidence = concreteEvidence.filter(isMeaningfulConcretePlanEvidence);
  const evidenceCandidates = meaningfulConcreteEvidence.length > 0
    ? meaningfulConcreteEvidence
    : rawEvidence.filter((item) => !isBroadDiscoveryEvidence(item))
  ;
  const evidence = prioritizeContractEvidence(
    evidenceCandidates,
    input.contractMismatchKinds,
  ).slice(0, 12);
  const rawFiles = uniqueCompactLines(input.files, 10, 160).filter(isActionablePlanFile);
  const filesWithConcreteEvidence = rawFiles.filter((file) =>
    evidence.some((item) => evidenceMentionsFile(item, file))
  );
  const files = (filesWithConcreteEvidence.length > 0 ? filesWithConcreteEvidence : rawFiles).slice(0, 8);
  const constraints = uniqueCompactLines(input.constraints, 5, 200);
  const explicitCommands = uniqueValidationCommands([
    // Explicit user-reported startup failures are acceptance criteria, not
    // incidental prose. Put them first so a generic compiler fallback cannot
    // displace the requested launch check.
    ...extractExplicitInteractiveStartupCommands(goal),
    ...extractInlineCommands([...evidence, ...constraints]),
  ]);
  // A source extension proves neither that a toolchain is installed nor that
  // the corresponding project command exists. Keep explicit user/evidence
  // commands here; workspace-manifest command discovery runs before review.
  const commands = explicitCommands;
  const desktopRuntimeRequired =
    /(?:mac(?:os)?|windows|linux|desktop|桌面|窗口|原生|native|dialog|button|click|select|drag|drop|keyboard|shortcut|鼠标|按钮|操作|交互|行为|功能|显示|无反应|失效|无法|启动|点击|选择|拖拽|键盘|快捷键)/i.test(goal) &&
    /(?:tauri|src-tauri|electron|wails|desktop)/i.test(evidence.join("\n"));
  const contractFindings = buildDeterministicContractFindings(
    input.contractMismatchKinds,
    input.language,
  );
  const configurationDecisions = buildDeterministicConfigurationDecisionLines(
    input.configurationContracts,
    input.language,
  );
  const confirmedEvidence = uniqueCompactLines(
    [...contractFindings, ...evidence],
    16,
    320,
    true,
  );
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
          contractMismatchKinds: input.contractMismatchKinds,
        }))
      : [`Implement the confirmed data/reporting change for ${goalSummary} using the inspected evidence: ${evidence[0]}.`];
    const validation = [
      ...buildFacetValidationPlanLines({ facets, language: "en" }),
      ...(commands.length > 0 || desktopRuntimeRequired
        ? buildDeterministicValidationPlanLines({ commands, language: "en", desktopRuntimeRequired })
        : ["Run the focused test, build, or browser/desktop validation for the touched subsystem and record the result."]),
    ];
    const traceability = buildFacetTraceabilityPlanLines({
      facets,
      evidenceLines: confirmedEvidence,
      changeLines: changes,
      decisionLines: configurationDecisions,
      language: "en",
      mappingSource: input.facetMappingSource,
    });
    return [
      "# Plan",
      formatCodexPlanSection("Summary", [
        `User goal: ${goal}`,
        `Grounding evidence covers ${scope}.`,
      ]),
      formatCodexPlanSection("Confirmed Evidence", labelPlanReferenceLines(confirmedEvidence, "E", facetTraceabilityEnabled)),
      formatCodexPlanSection("Key Changes", labelPlanReferenceLines(changes, "C", facetTraceabilityEnabled)),
      ...(configurationDecisions.length > 0
        ? [formatCodexPlanSection("Decisions / Constraints", labelPlanReferenceLines(configurationDecisions, "D", facetTraceabilityEnabled))]
        : []),
      formatCodexPlanSection("Public APIs / Interfaces / Types", input.contractMismatchKinds?.length
        ? [
            "Keep the repair inside the app's internal command, event-payload, and capability contracts; do not expose a new external API.",
          ]
        : [
            "No public API, interface, or type change is planned by default; if implementation proves one is required, pause before widening scope.",
          ]),
      formatCodexPlanSection("Test Plan", labelPlanReferenceLines(validation, "V", facetTraceabilityEnabled)),
      ...(traceability.length > 0
        ? [formatCodexPlanSection("Requirement Facet Traceability", traceability)]
        : []),
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
        contractMismatchKinds: input.contractMismatchKinds,
      }))
    : [`基于已确认的证据实施与“${goalSummary}”相关的数据/报表改动：${evidence[0]}。`];
  const validation = [
    ...buildFacetValidationPlanLines({ facets, language: "zh" }),
    ...(commands.length > 0 || desktopRuntimeRequired
      ? buildDeterministicValidationPlanLines({ commands, language: "zh", desktopRuntimeRequired })
      : ["运行受影响子系统的聚焦测试、构建检查或浏览器/桌面验证，并记录结果。"]),
  ];
  const traceability = buildFacetTraceabilityPlanLines({
    facets,
    evidenceLines: confirmedEvidence,
    changeLines: changes,
    decisionLines: configurationDecisions,
    language: "zh",
    mappingSource: input.facetMappingSource,
  });
  return [
    "# 计划",
    formatCodexPlanSection("摘要", [
      `用户目标：${goal}`,
      `定向证据已覆盖：${scope}。`,
    ]),
    formatCodexPlanSection("已确认证据", labelPlanReferenceLines(confirmedEvidence, "E", facetTraceabilityEnabled)),
    formatCodexPlanSection("关键改动", labelPlanReferenceLines(changes, "C", facetTraceabilityEnabled)),
    ...(configurationDecisions.length > 0
      ? [formatCodexPlanSection("决策与约束", labelPlanReferenceLines(configurationDecisions, "D", facetTraceabilityEnabled))]
      : []),
    formatCodexPlanSection("公共 API / 接口 / 类型", input.contractMismatchKinds?.length
      ? ["修复限定在应用内部的命令、事件 payload 与 capability 契约内，不新增对外 API。"]
      : ["默认不新增或修改公共 API、接口或类型；如果执行中证明必须扩大接口范围，先暂停确认。"]),
    formatCodexPlanSection("测试方案", labelPlanReferenceLines(validation, "V", facetTraceabilityEnabled)),
    ...(traceability.length > 0
      ? [formatCodexPlanSection("需求分面追踪", traceability)]
      : []),
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
  ], 6, 2000, true, false, true);
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
    ...structuredEvidence.slice(0, 6),
    ...visibleEvidenceLines.slice(0, 4),
    ...structuredEvidence.slice(6),
    ...externalEvidence,
    ...activityEvidence,
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
      /(?:执行|实施|方案|计划|步骤|修复|改动|变更|落地|Approach|Implementation|Changes?|Plan of Work|Plan|Steps|Fix)/i,
    ], 8, 4000, true, false, true),
    ...collectLinesFromSections(sections, [
      /(?:整改|执行|实施|步骤|修复|改动|变更|落地|Approach|Implementation|Changes?|Plan of Work|Steps|Fix)/i,
    ], 8, 4000, true, true, true),
  ], 8, 4000, true).filter((line) =>
    !/(?:与用户目标直接相关的最小改动|smallest user-goal-specific change|落实已批准目标|approved goal)/i.test(line)
  );
  const riskLines = uniquePlanItems([
    ...collectLinesFromSections(sections, [
      /(?:风险|取舍|注意|边界|默认|后续|Risks|Tradeoffs|Caveats|Boundary|Default|Follow-up)/i,
    ], 5, 2000, true),
  ], 5, 2000, true);
  const validationLines = collectLinesFromSections(sections, [
    // Match the validation role instead of loose substrings such as
    // unverified assumptions. Descendants of a validation heading are kept.
    // Numbered bilingual headings such as `3. 测试方案 (Validation)` are one
    // semantic role, not a different plan dialect.
    PLAN_VALIDATION_TARGET_HEADING_RE,
  ], 8, 4000, true, true, true);

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
    ...goalLines.slice(0, 1).map((line) => language === "zh" ? `用户目标：${line}` : `User goal: ${line}`),
    evidenceLines.length > 0
      ? language === "zh"
        ? `已基于 ${evidenceLines.length} 项定向证据收敛范围；具体观察见“已确认证据”。`
        : `Scope was narrowed from ${evidenceLines.length} targeted evidence item(s); see Confirmed Evidence for observations.`
      : "",
    ...(screenshotLines.length > 0
      ? screenshotLines.slice(0, 2)
      : [buildProvidedContextObservation({ turnContext: input.turnContext, language })]),
  ], 6, 2000, true);
  const goalForChanges = goalLines[0] || explicitInputGoal || input.userGoal || "";
  const fileChangeEvidence = concreteEvidenceLines.length > 0
    ? concreteEvidenceLines
    : evidenceLines.filter((line) => !isBroadDiscoveryEvidence(line));
  const fileDerivedChangeLines = fileLines.slice(0, 4).flatMap((file) => {
    const grounding = fileChangeEvidence.find((item) => evidenceMentionsFile(item, file)) || "";
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
      formatCodexPlanSection("Confirmed Evidence", evidenceLines.slice(0, 10)),
      formatCodexPlanSection("Key Changes", keyChangeLines),
      formatCodexPlanSection("Public APIs / Interfaces / Types", resolvedApiLines),
      formatCodexPlanSection("Test Plan", validationLines),
      formatCodexPlanSection("Assumptions / Defaults", assumptionLines),
    ].join("\n\n");
  }

  return [
    "# 计划",
    formatCodexPlanSection("摘要", summaryLines),
    formatCodexPlanSection("已确认证据", evidenceLines.slice(0, 10)),
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

function compactImplementationCodeBlocks(content: string): string {
  // The surrounding change bullets are the plan contract. Embedded
  // implementations are redundant and can accidentally become ungrounded
  // candidate changes, so remove the fenced bodies instead of asking for a
  // second lossy rewrite.
  return content
    .replace(/```[^\n]*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function rejectPlanMaterialization(input: {
  reason: string;
  replyOptions?: string[];
  decisionFork?: PlanDecisionForkAnalysis;
  quality?: PlanArtifactQualityResult;
}): PlanMaterializationResult {
  const quality = input.quality || classifyPlanArtifactQualityResult({
    ok: false,
    reason: input.reason,
  });
  return {
    ok: false,
    reason: quality.reason || input.reason,
    quality,
    ...(input.replyOptions ? { replyOptions: input.replyOptions } : {}),
    ...(input.decisionFork ? { decisionFork: input.decisionFork } : {}),
  };
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
  evidenceBundle?: PlanEvidenceBundle;
  expectedEvidenceBundleHash?: string;
}): PlanMaterializationResult {
  if (
    input.expectedEvidenceBundleHash &&
    input.evidenceBundle?.hash !== input.expectedEvidenceBundleHash
  ) {
    return rejectPlanMaterialization({ reason: "evidence_bundle_hash_mismatch" });
  }
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
  if (!raw) return rejectPlanMaterialization({ reason: "empty", replyOptions: extracted.replyOptions });
  if (PROTOCOL_NOISE_RE.test(raw)) return rejectPlanMaterialization({ reason: "protocol_noise" });
  if (TOOL_LOG_NOISE_RE.test(raw)) return rejectPlanMaterialization({ reason: "tool_log_noise" });

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
    if (countPlanShapeSignals(content) < 4) return rejectPlanMaterialization({ reason: "not_structured" });
    const validation = validatePlanArtifactContent(content, "design");
    if (!validation.ok) {
      return rejectPlanMaterialization({
        reason: validation.reason || "quality_gate",
        quality: classifyPlanArtifactQualityResult(validation),
      });
    }
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
  const validationTargetRepair = repairPlanValidationTargetFromEvidence({
    content,
    evidenceRecords: input.evidenceRecords,
    recentToolActivity: input.recentToolActivity,
  });
  if (validationTargetRepair.repaired) {
    content = validationTargetRepair.content;
    source = input.sourceHint === "deterministic_evidence"
      ? "deterministic_evidence"
      : "grounding_repaired_visible_plan";
  }
  if (countPlanShapeSignals(content) < 5) return rejectPlanMaterialization({ reason: "not_structured" });
  const decisionFork = analyzePlanDecisionFork(content);

  const explicitCodeGrounding = validateExplicitPlanCodeChangeGrounding({
    content,
    recentToolActivity: input.recentToolActivity,
  });
  if (!explicitCodeGrounding.ok) {
    return rejectPlanMaterialization({
      reason: explicitCodeGrounding.reason || "explicit_plan_code_grounding",
      decisionFork,
      quality: explicitCodeGrounding,
    });
  }

  let validation = validateActionablePlanArtifact(content);
  if (!validation.ok && validation.reason === "excessive_plan_code_dump") {
    const compacted = compactImplementationCodeBlocks(content);
    const compactedValidation = validateActionablePlanArtifact(compacted);
    if (compacted !== content) {
      content = compacted;
      validation = compactedValidation;
      source = "deterministically_compacted_visible_plan";
    }
  }
  if (
    !validation.ok &&
    hasSummaryRoleDocumentTitle(content) &&
    /^(?:raw_evidence_in_plan_summary|missing_plan_required_sections:)/i.test(validation.reason || "")
  ) {
    // `# 摘要` followed by numbered H2/H3 evidence/change/test sections is a
    // recoverable hierarchy error. Canonicalize the already-visible facts and
    // roles before inserting isolated scaffold sections, so the review artifact
    // gets a document title and sibling sections without dropping evidence.
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
    !/insufficient_grounded_evidence|generic_fallback_plan|unsupported_debug_log_advice|weak_path_echo_evidence|import_only_evidence|placeholder_validation_plan|non_executable_test_plan|excessive_plan_code_dump|empty_plan_implementation_detail|conflicting_plan_acceptance_assertions/i.test(validation.reason || "")
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
  if (!validation.ok) {
    return rejectPlanMaterialization({
      reason: validation.reason || "quality_gate",
      decisionFork,
      quality: validation,
    });
  }

  let grounding = validatePlanEvidenceGrounding({
    content,
    evidence: input.evidence,
    evidenceRecords: input.evidenceRecords,
    recentToolActivity: input.recentToolActivity,
    evidenceBundle: input.evidenceBundle,
  });
  let changeGroundingRepaired = false;
  if (!grounding.ok && grounding.reason === "missing_grounded_plan_change_target") {
    const repaired = repairMissingGroundedPlanChangeTargets({
      content,
      userGoal: input.userGoal,
      evidence: input.evidence,
      evidenceRecords: input.evidenceRecords,
      files: input.files,
      recentToolActivity: input.recentToolActivity,
      language,
    });
    if (repaired) {
      const repairedStructural = validateActionablePlanArtifact(repaired);
      if (repairedStructural.ok) {
        content = repaired;
        changeGroundingRepaired = true;
        source = input.sourceHint === "deterministic_evidence"
          ? "deterministic_evidence"
          : "grounding_repaired_visible_plan";
        grounding = validatePlanEvidenceGrounding({
          content,
          evidence: input.evidence,
          evidenceRecords: input.evidenceRecords,
          recentToolActivity: input.recentToolActivity,
          evidenceBundle: input.evidenceBundle,
        });
      }
    }
  }
  if (!grounding.ok) {
    if (grounding.reason === "missing_plan_evidence_section") {
      const repaired = repairMissingPlanEvidenceSection({
        content,
        evidence: input.evidence,
        evidenceRecords: input.evidenceRecords,
        recentToolActivity: input.recentToolActivity,
        language,
      });
      if (repaired) {
        const repairedQuality = validateGroundedActionablePlanArtifact({
          content: repaired,
          evidence: input.evidence,
          evidenceRecords: input.evidenceRecords,
          recentToolActivity: input.recentToolActivity,
          evidenceBundle: input.evidenceBundle,
        });
        if (repairedQuality.ok) {
          content = repaired;
          source = input.sourceHint === "deterministic_evidence"
            ? "deterministic_evidence"
            : changeGroundingRepaired
              ? "grounding_repaired_visible_plan"
              : "evidence_section_repaired_visible_plan";
        } else {
          return rejectPlanMaterialization({
            reason: repairedQuality.reason || grounding.reason || "evidence_grounding",
            decisionFork,
            quality: repairedQuality,
          });
        }
      } else {
        return rejectPlanMaterialization({
          reason: grounding.reason || "evidence_grounding",
          decisionFork,
          quality: grounding,
        });
      }
    } else {
      return rejectPlanMaterialization({
        reason: grounding.reason || "evidence_grounding",
        decisionFork,
        quality: grounding,
      });
    }
  }

  const facetCoverage = validateNumberedUserGoalFacetCoverage({
    userGoal: input.userGoal,
    content,
  });
  if (!facetCoverage.ok) {
    return rejectPlanMaterialization({
      reason: facetCoverage.reason || "uncovered_user_goal_facets",
      decisionFork,
      quality: facetCoverage,
    });
  }

  const candidate = input.evidenceBundle
    ? buildPlanCandidate({ content, bundle: input.evidenceBundle })
    : undefined;
  if (candidate) {
    const candidateFailures = validatePlanCandidate(candidate, input.evidenceBundle!.hash);
    if (candidateFailures.length > 0) {
      return rejectPlanMaterialization({ reason: `plan_candidate_invalid:${candidateFailures.join(",")}` });
    }
  }
  if (input.evidenceBundle && input.sourceHint === "deterministic_evidence") {
    const closure = assessPlanClosureEvidence(input.evidenceBundle);
    if (!closure.ready) {
      // The frozen evidence bundle is the approval boundary for both runtime-
      // generated and model-authored plans. Run this after the candidate's
      // own grounding/facet checks so a more precise missing target/facet is
      // preserved, but never publish plan.md from an open evidence closure.
      const reason = closure.unresolvedContractKinds.length > 0
        ? `unverified_plan_contract_counterpart:${closure.unresolvedContractKinds.join(",")}`
        : `insufficient_grounded_evidence:${closure.reason}`;
      return rejectPlanMaterialization({
        reason,
        quality: classifyPlanArtifactQualityResult({ ok: false, reason }),
      });
    }
  } else if (input.evidenceBundle && !isPlanEvidenceBundleReady(input.evidenceBundle)) {
    // A model-authored plan may infer a repair from trusted observations, but
    // it still needs a non-empty frozen bundle and grounded change targets.
    // The inference remains a review candidate; it is never promoted back
    // into runtime facts or accepted as execution/validation evidence.
    return rejectPlanMaterialization({
      reason: "insufficient_grounded_evidence:bundle_not_ready",
      quality: classifyPlanArtifactQualityResult({
        ok: false,
        reason: "insufficient_grounded_evidence:bundle_not_ready",
      }),
    });
  }
  return {
    ok: true,
    kind,
    path: ".MAIN/plans/plan.md",
    content,
    source,
    replyOptions: extracted.replyOptions,
    decisionFork,
    ...(input.evidenceBundle ? { evidenceBundleHash: input.evidenceBundle.hash } : {}),
    ...(candidate ? { candidate } : {}),
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
      `${targetPath} must make the objective, grounded implementation or design decisions, affected boundaries, and executable acceptance checks clear. Adapt headings to the work: bug fixes may include root cause, features may use architecture/components/data flow, and research or verification plans may use decisions/constraints instead of source edits. Include API/type changes and assumptions only when relevant. If a critical choice blocks execution, ask with \`<user_options>\` before approval instead of burying it as an open question.`,
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
    `${targetPath} 必须清楚表达目标、已有依据、实现或设计决策、受影响边界与可执行验收，但标题和章节应随任务类型调整：修复类可写根因，新增功能可写架构/组件/数据流，调研或验证类可写决策/约束而不强行虚构源码改动。公共 API/类型变化和假设只在相关时写入。真正阻塞执行的选择必须在批准前用 \`<user_options>\` 提问，不要伪装成计划尾部的开放问题。`,
  ].filter(Boolean).join("\n");
}

export function composePlanArtifactFromEvidence(input: {
  userGoal: string;
  evidence: string[];
  evidenceRecords?: PlanEvidenceRecord[];
  files?: string[];
  constraints?: string[];
  language?: "zh" | "en";
  evidenceBundle?: PlanEvidenceBundle;
  facetMappingSource?: string;
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
    evidence: input.evidenceBundle
      ? input.evidenceBundle.facts.map((fact) => `${fact.tool} ${fact.target}: ${fact.summary}`)
      : sanitized.evidence.map((item) => summarizeEvidenceLine(item, language)),
    files: input.evidenceBundle?.changeTargets.length
      ? input.evidenceBundle.changeTargets
      : sanitized.files,
    constraints: input.evidenceBundle
      ? input.evidenceBundle.constraints
      : sanitized.constraints,
    language,
    contractMismatchKinds: input.evidenceBundle
      ? assessPlanClosureEvidence(input.evidenceBundle).contractMismatchKinds
      : [],
    configurationContracts: input.evidenceBundle
      ? assessPlanConfigurationContracts(input.evidenceBundle)
      : [],
    facetMappingSource: input.facetMappingSource,
  });
}
