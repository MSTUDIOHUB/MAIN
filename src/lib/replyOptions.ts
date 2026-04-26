import type { ReplyOption } from "./workflowModels";

const USER_OPTIONS_BLOCK_RE = /<user_options>([\s\S]*?)<\/user_options>/gi;
const OPTION_RE = /<option(?:\s+label="([^"]*)")?>([\s\S]*?)<\/option>/gi;
const DECISION_CUE_RE = /(?:请选择|请确认|请告诉我|请说明|你可以选择|可选方案|下一步可以|选一个|选一项|任选其一|从下面.*选|would you like|do you want|please choose|please confirm|choose one|pick one|select one)/i;
const ENUM_OPTION_RE = /^\s*(?:[-*]|(?:\d+|[A-Za-z])[\.\)、:：])\s+(.+?)\s*$/;
const BINARY_SEPARATOR_RE = /\s*(?:，|,)?\s*(或者|还是|或是|\bor\b)\s*/i;
const ENUMERATED_LINE_RE = /^\s*(?:[-*]|(?:\d+|[A-Za-z])[\.\)、:：])\s+/;

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

function addReplyOption(
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
  rawLabel: string,
  rawValue?: string,
) {
  const label = normalizeReplyOptionLabel(rawLabel || rawValue || "");
  const value = normalizeReplyOptionValue(rawValue || rawLabel);
  if (!label || !value || seenValues.has(value)) return;
  seenValues.add(value);
  replyOptions.push({ label, value });
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
    if (!DECISION_CUE_RE.test(lines[i] || "")) continue;

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
        const attrLabel = normalizeOptionText(optionMatch[1] || "");
        const bodyValue = normalizeOptionText(optionMatch[2] || "");
        const value = bodyValue || attrLabel;
        const label = attrLabel || bodyValue;

        addReplyOption(replyOptions, seenValues, label, value);
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
  if (toolCallCount > 0) return false;

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
