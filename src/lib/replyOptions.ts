import type { ReplyOption } from "./workflowModels";

const USER_OPTIONS_BLOCK_RE = /<user_options>([\s\S]*?)<\/user_options>/gi;
const OPTION_RE = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
const OPTION_ATTR_RE = /\b(label|value|text|title|action)\s*=\s*"([^"]*)"/gi;
const DECISION_CUE_RE = /(?:请选择|请确认|请告诉我|请说明|你可以选择|可选方案|备选方案|选项|选择下一步|下一步可以|选一个|选一项|任选其一|从下面.*选|options?|choices?|would you like|do you want|please choose|please confirm|choose one|pick one|select one)/i;
const ENUMERATED_DECISION_CUE_RE = /(?:请选择|请确认|选一个|选一项|任选其一|从下面.*选|please choose|please confirm|choose one|pick one|select one)/i;
const ENUM_OPTION_RE = /^\s*(?:[-*]|(?:\d+|[A-Za-z])[\.\)、:：])\s+(.+?)\s*$/;
const BINARY_SEPARATOR_RE = /\s*(?:，|,)?\s*(或者|还是|或是|\bor\b)\s*/i;
const ENUMERATED_LINE_RE = /^\s*(?:[-*]|(?:\d+|[A-Za-z])[\.\)、:：])\s+/;
const READONLY_PERMISSION_CUE_RE = /(?:是否|能否|可否|要不要|是否同意|是否允许|是否批准|请问|would you like|do you want|may i|shall i|should i|allow|permission|do you approve)/i;
const READONLY_ACTION_RE = /(?:读取|查看|分析|检查|扫描|搜索|查询|浏览|梳理|提取|汇总|read|open|view|inspect|analy[sz]e|scan|search|query|review|summari[sz]e)/i;
const READONLY_WRITE_EXCLUSION_RE = /(?:写入|修改|删除|创建|执行命令|运行命令|改动|更改|write|modify|delete|create|edit|run command|execute command)/i;
const READONLY_TARGET_RE = /[`"“']([^`"“”']{2,160})[`"”']|([A-Za-z0-9_.\-\/\\]+\.[A-Za-z0-9]{1,12})/;
const EXECUTE_REPLY_NEGATION_RE = /(?:不(?:要|用|进入|开始|继续)?执行|不运行|不部署|暂不执行|暂不运行|继续讨论|先确认|我来确认|don't execute|do not execute|do not run|don't run|not execute|not run|discuss first|confirm first)/i;
const EXECUTE_REPLY_ACTION_RE = /(?:直接|开始|继续|立即|马上|现在)?(?:执行|运行|部署|发布|同步|上传|实现|处理|重构|完善|改造|开发|接入|集成)(?:部署脚本|脚本|命令|deploy(?:\.sh)?|deployment script|command|控制器|系统|逻辑|功能|模块)?|(?:deploy(?:\.sh)?|部署脚本|执行命令|运行命令)|\b(?:run|execute|deploy|ship|implement|refactor|complete|continue|integrate|build|fix)(?:\s+(?:the\s+)?)?(?:deploy(?:\.sh)?|deployment script|script|command|controller|system|logic|feature|module)?\b/i;
const PLAN_ARTIFACT_PATH_RE = /\.MAIN[\/\\]plans[\/\\](?:requirements|design|bugfix|tasks)\.md/i;
const PLAN_ARTIFACT_FILE_RE = /\b(?:requirements|design|bugfix|tasks)\.md\b/i;
const PLAN_ARTIFACT_DOC_RE = /(?:计划文档|计划文件|规划文档|规划文件|plan documents?|plan files?|planning documents?|planning files?)/i;
const INTERNAL_PLAN_ARTIFACT_STEP_RE = /(?:创建|生成|写入|更新|保存|落盘|create|generate|write|update|save)/i;
const PLAN_SUMMARY_HEADING_RE = /(?:方案总结|需求规格|设计方案|关键设计决策|设计决策|方案正文|计划摘要|方案摘要|requirements?|design|proposal|plan summary|design decisions?)/i;
const PLAN_SUMMARY_ITEM_RE = /^(?:\*\*)?(?:技术栈|核心玩法|交互控制|交付物|架构|游戏循环|渲染|碰撞检测|执行顺序|关键设计决策|需求规格|设计方案|文件|模块|验证方式|测试方案|范围|目标|验收标准)(?:\*\*)?\s*[:：]/i;

function normalizeOptionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const OPTION_FILLER_PREFIX_RE = /^(?:下一步行动计划[:：]?\s*|请稍候[,，]?\s*|接下来(?:我)?(?:将|会)?\s*|我(?:将|会|先|现在|接下来)(?:继续)?\s*|I(?:'ll| will)\s+|Next action plan:?\s*|Please wait[, ]*\s*)/i;

function normalizeReplyOptionLabel(text: string): string {
  const cleaned = normalizeOptionText(text)
    .replace(OPTION_FILLER_PREFIX_RE, "")
    .replace(/[。.!！？?]+$/, "");
  const converted = convertAssistantClauseToUserChoice(cleaned);
  return normalizeOptionText(converted.replace(/^请\s*/, ""));
}

function normalizeReplyOptionValue(text: string): string {
  const cleaned = normalizeOptionText(text)
    .replace(OPTION_FILLER_PREFIX_RE, "")
    .replace(/^请选择[:：]?\s*/i, "");
  const converted = normalizeOptionText(convertAssistantClauseToUserChoice(cleaned));
  if (/^请(?:先|直接|继续|进入|输出|总结|报告|按|使用|切换|选择|讨论|生成)/.test(converted)) {
    return converted.replace(/^请/, "");
  }
  return converted;
}

function looksLikeInternalPlanArtifactStep(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (!INTERNAL_PLAN_ARTIFACT_STEP_RE.test(normalized)) return false;
  return (
    PLAN_ARTIFACT_PATH_RE.test(normalized) ||
    PLAN_ARTIFACT_FILE_RE.test(normalized) ||
    PLAN_ARTIFACT_DOC_RE.test(normalized)
  );
}

function looksLikePlanSummaryItem(text: string): boolean {
  return PLAN_SUMMARY_ITEM_RE.test(normalizeOptionText(text));
}

function addReplyOption(
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
  rawLabel: string,
  rawValue?: string,
  action?: ReplyOption["action"],
) {
  const label = normalizeReplyOptionLabel(rawLabel || rawValue || "");
  const value = normalizeReplyOptionValue(rawValue || rawLabel);
  if (!label || !value || seenValues.has(value)) return;
  if (looksLikeInternalPlanArtifactStep(label) || looksLikeInternalPlanArtifactStep(value)) return;
  if (looksLikePlanSummaryItem(label) || looksLikePlanSummaryItem(value)) return;
  seenValues.add(value);
  const resolvedAction = action ?? inferReplyOptionAction(label, value);
  replyOptions.push({ label, value, ...(resolvedAction ? { action: resolvedAction } : {}) });
}

function parseOptionAttributes(rawAttributes: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  OPTION_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPTION_ATTR_RE.exec(rawAttributes || "")) !== null) {
    const key = String(match[1] || "").toLowerCase();
    const value = normalizeOptionText(match[2] || "");
    if (key && value) attrs[key] = value;
  }
  return attrs;
}

function normalizeReplyOptionAction(value: string | undefined): ReplyOption["action"] | undefined {
  const normalized = String(value || "").trim();
  if (
    normalized === "continue_readonly_once" ||
    normalized === "allow_readonly_session" ||
    normalized === "execute_once"
  ) {
    return normalized;
  }
  return undefined;
}

function looksLikeExecuteReplyOption(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (!normalized || EXECUTE_REPLY_NEGATION_RE.test(normalized)) return false;
  return EXECUTE_REPLY_ACTION_RE.test(normalized);
}

function inferReplyOptionAction(label: string, value: string): ReplyOption["action"] | undefined {
  const combined = `${label}\n${value}`;
  return looksLikeExecuteReplyOption(combined) ? "execute_once" : undefined;
}

function convertAssistantClauseToUserChoice(clause: string): string {
  let normalized = normalizeOptionText(clause)
    .replace(/^[,，:：;；\-]+/, "")
    .replace(/[。.!！？?]+$/, "")
    .trim();

  if (!normalized) return "";

  const opinionMatch = normalized.match(/(?:请)?(?:告诉我|说明)?(?:您|你)?对(.+?)的看法/i);
  if (opinionMatch?.[1]) {
    return `我来确认${normalizeOptionText(opinionMatch[1])}`;
  }

  const confirmMatch = normalized.match(/(?:请)?(?:您|你)?确认(.+)/i);
  if (confirmMatch?.[1]) {
    return `我来确认${normalizeOptionText(confirmMatch[1])}`;
  }

  normalized = normalized
    .replace(/^(?:您|你)?(?:想|希望|要)?(?:让我|要我|叫我)/, "")
    .replace(/^(?:您|你)?是否希望我/, "")
    .replace(/^(?:是否需要|是否要|要不要|是否)/, "")
    .replace(/^(?:Would you like me to|Do you want me to)\s+/i, "")
    .replace(/^(?:Please let me know whether you want me to)\s+/i, "")
    .replace(/^根据我的经验/, "根据你的经验")
    .replace(/我的经验/g, "你的经验")
    .replace(/\bmy experience\b/gi, "your experience")
    .replace(/\bmy\b/gi, "your")
    .replace(/\bme\b/gi, "you")
    .trim();

  if (!normalized) return "";

  if (/^(?:根据你的经验|根据经验|先|直接|继续|假设|开始|构建|执行|proceed|continue|start|assume|build|use your)/i.test(normalized)) {
    return normalizeOptionText(`请${normalized}`.replace(/^请\s*/, "请"));
  }

  return normalized;
}

function hasMultipleEnumeratedLines(text: string): boolean {
  return text
    .split(/\r?\n/)
    .filter((line) => ENUMERATED_LINE_RE.test(line))
    .length > 1;
}

function inferReplyOptionsFromEnumeratedChoices(
  text: string,
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const cueLine = lines[i] || "";
    if (!ENUMERATED_DECISION_CUE_RE.test(cueLine)) continue;
    if (PLAN_SUMMARY_HEADING_RE.test(cueLine) && !/(?:请选择|请确认|请告诉我|选一个|选一项|任选其一|从下面.*选|please choose|choose one|pick one|select one)/i.test(cueLine)) {
      continue;
    }

    const inferred: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const matched = lines[j].match(ENUM_OPTION_RE);
      if (!matched) {
        if (inferred.length > 0) break;
        continue;
      }
      const body = normalizeOptionText(matched[1] || "");
      if (!body || /[？?]$/.test(body) || /是否/.test(body)) {
        inferred.length = 0;
        break;
      }
      if (looksLikeInternalPlanArtifactStep(body) || looksLikePlanSummaryItem(body)) {
        inferred.length = 0;
        break;
      }
      inferred.push(body);
      if (inferred.length >= 4) break;
    }

    if (inferred.length >= 2) {
      inferred.forEach((option) => addReplyOption(replyOptions, seenValues, option));
      return;
    }
  }
}

function inferReplyOptionsFromBinaryChoice(
  text: string,
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const paragraph = paragraphs[i];
    if (!BINARY_SEPARATOR_RE.test(paragraph)) continue;
    if (hasMultipleEnumeratedLines(paragraph)) continue;
    if (!/[？?]$/.test(paragraph) && !DECISION_CUE_RE.test(paragraph)) continue;

    BINARY_SEPARATOR_RE.lastIndex = 0;
    const parts = paragraph.split(BINARY_SEPARATOR_RE).filter(Boolean);
    if (parts.length < 3) continue;

    const firstClause = convertAssistantClauseToUserChoice(parts[0] || "");
    const secondClause = convertAssistantClauseToUserChoice(parts[2] || "");
    if (!firstClause || !secondClause) continue;

    addReplyOption(replyOptions, seenValues, firstClause);
    addReplyOption(replyOptions, seenValues, secondClause);
    if (replyOptions.length >= 2) return;
  }
}

function looksLikeReadOnlyPermissionPrompt(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (!normalized) return false;
  if (READONLY_WRITE_EXCLUSION_RE.test(normalized)) return false;
  return READONLY_PERMISSION_CUE_RE.test(normalized) && READONLY_ACTION_RE.test(normalized);
}

function extractReadOnlyActionLabel(text: string): string {
  const normalized = normalizeOptionText(text);
  const targetMatch = normalized.match(READONLY_TARGET_RE);
  const target = normalizeOptionText(targetMatch?.[1] || targetMatch?.[2] || "");
  const isAnalysis = /(?:分析|检查|扫描|搜索|查询|梳理|提取|汇总|inspect|analy[sz]e|scan|search|query|review|summari[sz]e)/i.test(normalized);
  const verb = isAnalysis ? "分析" : "读取";
  return target ? `继续${verb} ${target}` : `继续当前只读${verb}`;
}

function inferReadOnlyPermissionOptions(
  text: string,
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = [...paragraphs].reverse().find(looksLikeReadOnlyPermissionPrompt) || "";
  if (!candidate) return;

  const actionLabel = extractReadOnlyActionLabel(candidate);
  addReplyOption(
    replyOptions,
    seenValues,
    actionLabel,
    `请${actionLabel}。`,
    "continue_readonly_once",
  );
  addReplyOption(
    replyOptions,
    seenValues,
    "当前会话只读步骤全部批准",
    `本会话只读读取、搜索和分析步骤全部允许，请${actionLabel}。`,
    "allow_readonly_session",
  );
}

export function hasReadOnlyPermissionReplyOptions(replyOptions: ReplyOption[]): boolean {
  return Array.isArray(replyOptions) && replyOptions.some((option) =>
    option.action === "continue_readonly_once" || option.action === "allow_readonly_session"
  );
}

export function shouldAutoContinueReadOnlyPermission(params: {
  replyOptions: ReplyOption[];
  readOnlyAutoApproveForSession: boolean;
}): boolean {
  return params.readOnlyAutoApproveForSession && hasReadOnlyPermissionReplyOptions(params.replyOptions);
}

export function stripReadOnlyPermissionPrompt(text: string): string {
  const original = String(text || "");
  if (!original.trim()) return "";

  const paragraphs = original.split(/\n{2,}/);
  const trimmedParagraphs = paragraphs.map((part) => part.trim()).filter(Boolean);
  if (trimmedParagraphs.length === 0) return original.trim();

  const lastParagraph = trimmedParagraphs[trimmedParagraphs.length - 1];
  const lines = lastParagraph.split(/\r?\n/);
  const lastLine = lines[lines.length - 1]?.trim() || "";
  if (lastLine && looksLikeReadOnlyPermissionPrompt(lastLine)) {
    const remainingLastParagraph = lines.slice(0, -1).join("\n").trim();
    const remaining = trimmedParagraphs.slice(0, -1);
    if (remainingLastParagraph) remaining.push(remainingLastParagraph);
    return remaining.join("\n\n").trim();
  }

  if (looksLikeReadOnlyPermissionPrompt(lastParagraph)) {
    return trimmedParagraphs.slice(0, -1).join("\n\n").trim();
  }

  return original.trim();
}

export function buildReadOnlyPermissionContinuationPrompt(language: "zh" | "en"): string {
  return language === "zh"
    ? "用户已允许本会话内后续只读读取、搜索、查看、查询和分析步骤。不要再询问是否同意，也不要输出过渡台词；请立即调用合适的只读工具继续当前任务，例如 `read_file`、`get_file_outline`、`grep_search`、`glob_search`、`read_document`、`analyze_tabular_document` 或 `query_tabular_document`。"
    : "The user has allowed read-only reading, searching, inspecting, querying, and analysis steps for this session. Do not ask for permission again or output process filler; immediately call the appropriate read-only tool such as `read_file`, `get_file_outline`, `grep_search`, `glob_search`, `read_document`, `analyze_tabular_document`, or `query_tabular_document`.";
}

export function extractReplyOptions(text: string): {
  cleanText: string;
  replyOptions: ReplyOption[];
} {
  if (!text) {
    return {
      cleanText: "",
      replyOptions: [],
    };
  }

  const replyOptions: ReplyOption[] = [];
  const seenValues = new Set<string>();

  const cleanText = text
    .replace(USER_OPTIONS_BLOCK_RE, (_fullMatch, blockContent: string) => {
      OPTION_RE.lastIndex = 0;

      let optionMatch: RegExpExecArray | null;
      while ((optionMatch = OPTION_RE.exec(blockContent)) !== null) {
        const attrs = parseOptionAttributes(optionMatch[1] || "");
        const attrLabel = attrs.label || attrs.title || "";
        const attrValue = attrs.value || attrs.text || "";
        const bodyValue = normalizeOptionText(optionMatch[2] || "");
        const value = attrValue || bodyValue || attrLabel;
        const label = attrLabel || bodyValue || attrValue;
        const action = normalizeReplyOptionAction(attrs.action);

        addReplyOption(replyOptions, seenValues, label, value, action);
      }

      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (replyOptions.length === 0) {
    inferReplyOptionsFromEnumeratedChoices(cleanText, replyOptions, seenValues);
  }

  if (replyOptions.length === 0) {
    inferReplyOptionsFromBinaryChoice(cleanText, replyOptions, seenValues);
  }

  if (replyOptions.length === 0) {
    inferReadOnlyPermissionOptions(cleanText, replyOptions, seenValues);
  }

  return {
    cleanText,
    replyOptions,
  };
}

export function shouldPauseForReplyOptions(params: {
  replyOptions: ReplyOption[];
  toolCallCount: number;
  workflowMode: "chat" | "edit" | "plan";
  hasStructuredProposal?: boolean;
  hasReadyPlanArtifacts?: boolean;
  isPlanApproved?: boolean;
}): boolean {
  const {
    replyOptions,
    toolCallCount,
    workflowMode,
    hasStructuredProposal = false,
    hasReadyPlanArtifacts = false,
    isPlanApproved = false,
  } = params;

  if (!Array.isArray(replyOptions) || replyOptions.length === 0) return false;
  if (toolCallCount > 0 && workflowMode === "edit") return false;

  if (workflowMode === "plan" && !isPlanApproved && (hasStructuredProposal || hasReadyPlanArtifacts)) {
    return false;
  }

  return true;
}

export function serializeAssistantReplyForHistory(text: string, replyOptions: ReplyOption[]): string {
  const cleanText = String(text || "").trim();
  if (!Array.isArray(replyOptions) || replyOptions.length === 0) {
    return cleanText;
  }

  const optionLines = replyOptions
    .map((option, index) => {
      const label = normalizeOptionText(option.label || option.value || "");
      return label ? `${index + 1}. ${label}` : "";
    })
    .filter(Boolean);

  if (optionLines.length === 0) {
    return cleanText;
  }

  return [cleanText, "User choices:", optionLines.join("\n")]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
