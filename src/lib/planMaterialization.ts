import { sanitizePlanArtifactContent } from "./sanitize";
import {
  validateActionableDesignArtifact,
  type PlanStage,
} from "./workflowModels";

export type MaterializablePlanKind = "design";

export interface PlanMaterializationResult {
  ok: boolean;
  kind?: MaterializablePlanKind;
  path?: string;
  content?: string;
  reason?: string;
}

const PROTOCOL_NOISE_RE = /<\/?(?:tool_use|tool_call|function_call|tool|parameter|user_options|option)\b/i;
const PROPOSAL_MARKER_RE = /^\s*\[PROPOSAL START\]\s*$/gim;
const TOOL_LOG_NOISE_RE =
  /Repeated read-only tool call skipped|Duplicate skip count|FILE_UNCHANGED_STUB|already called with identical arguments|后台思考已折叠|thinking process|chain of thought|ContextMemoryState|ContextState|MAIN TOOL FEEDBACK|tool call id|PLAN_REPEAT_READ_LIMIT|上一条\s*Plan\s*回复是空的/i;

const TOOL_LABELS_ZH: Record<string, string> = {
  analyze_tabular_document: "已分析表格数据",
  query_tabular_document: "已查询表格数据",
  get_project_skeleton: "已查看项目结构",
  list_directory: "已查看目录",
  read_file: "已读取文件",
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
  read_document: "Read document",
  get_file_outline: "Inspected file outline",
  grep_search: "Searched text",
  glob_search: "Searched files",
  index_workspace_documents: "Indexed workspace documents",
};

function countPlanShapeSignals(content: string): number {
  const headingCount = (content.match(/^#{1,3}\s+\S+/gm) || []).length;
  const bulletCount = (content.match(/^\s*(?:[-*]|\d+[.)、])\s+\S+/gm) || []).length;
  const keywordCount = (content.match(/目标|约束|发现|方案|设计|执行|接口|文件|数据流|控制流|风险|验证|默认假设|后续增强|开放问题|Goal|Constraint|Finding|Approach|Design|Interface|File|Flow|Risk|Validation|Assumption|Default|Follow-up|Enhancement|Open question/gi) || []).length;
  return headingCount + Math.min(bulletCount, 6) + Math.min(keywordCount, 8);
}

function normalizePlanContent(rawText: string): string {
  const withoutProposalMarkers = rawText.replace(PROPOSAL_MARKER_RE, "").trim();
  const strippedPlanJson = withoutProposalMarkers.replace(/<plan>[\s\S]*?<\/plan>/gi, "").trim();
  const sanitized = sanitizePlanArtifactContent(strippedPlanJson);
  if (/^#\s+/m.test(sanitized)) return sanitized;
  return `# Design\n\n${sanitized}`;
}

function compactPlanLine(value: unknown, maxChars = 180): string {
  const text = sanitizePlanArtifactContent(String(value ?? ""))
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<tool_use[\s\S]*?(?:<\/tool_use>|$)/gi, " ")
    .replace(/<\/?(?:tool_use|tool_call|function_call|tool|parameter|user_options|option)\b[^>]*>/gi, " ")
    .replace(/[#>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || TOOL_LOG_NOISE_RE.test(text) || PROTOCOL_NOISE_RE.test(text)) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}...`;
}

function uniqueCompactLines(values: unknown[], maxItems: number, maxChars = 180): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const line = compactPlanLine(value, maxChars);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
    if (result.length >= maxItems) break;
  }
  return result;
}

function summarizeEvidenceLine(value: string, language: "zh" | "en"): string {
  const raw = String(value || "");
  const toolEvidence = raw.match(/^\s*([a-z_][a-z0-9_]*)\s+([^;\n]{1,160})(?:[\s\S]*?\bexcerpt=([^;\n]{1,180}))?/i);
  if (toolEvidence) {
    const toolName = toolEvidence[1] || "";
    const target = compactPlanLine(toolEvidence[2] || "", 96);
    const excerpt = compactPlanLine(toolEvidence[3] || "", 120);
    const labels = language === "zh" ? TOOL_LABELS_ZH : TOOL_LABELS_EN;
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

export function materializePlanArtifactFromVisibleText(input: {
  visibleText: string;
  planStage?: PlanStage | null;
  preferredKind?: MaterializablePlanKind | null;
}): PlanMaterializationResult {
  const raw = String(input.visibleText || "").trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (PROTOCOL_NOISE_RE.test(raw)) return { ok: false, reason: "protocol_noise" };
  if (raw.length < 280) return { ok: false, reason: "too_short" };

  const kind: MaterializablePlanKind = "design";
  const content = normalizePlanContent(raw);
  if (countPlanShapeSignals(content) < 5) return { ok: false, reason: "not_structured" };

  const validation = validateActionableDesignArtifact(content);
  if (!validation.ok) return { ok: false, reason: validation.reason || "quality_gate" };

  return {
    ok: true,
    kind,
    path: ".MAIN/plans/design.md",
    content,
  };
}

export function composeReviewableDesignFromEvidence(input: {
  userGoal: string;
  evidence: string[];
  files?: string[];
  constraints?: string[];
  language?: "zh" | "en";
}): string {
  const language = input.language === "en" ? "en" : "zh";
  const goal = compactPlanLine(input.userGoal, 420);
  const evidence = uniqueCompactLines(input.evidence.map((item) => summarizeEvidenceLine(item, language)), 10, 220);
  const files = uniqueCompactLines(input.files || [], 10, 160);
  const constraints = uniqueCompactLines(input.constraints || [], 6, 200);

  if (language === "en") {
    return [
      "You already have read-only evidence. Do not repeat directory scans or broad context reads.",
      "Generate a reviewable, actionable design now.",
      "",
      "Hard requirements:",
      "- Use English for all visible prose and `.MAIN/plans/design.md` content.",
      "- Prefer a single `write_file` tool call that writes `.MAIN/plans/design.md`.",
      "- Do not create `tasks.md`; do not modify source or deliverable files before approval.",
      "- Do not include tool logs, ContextMemoryState, XML, raw JSON envelopes, or recovery prompts in the plan.",
      "- If a critical business choice is genuinely missing, ask with `<user_options>` instead of writing a generic plan.",
      "",
      `User goal: ${goal}`,
      evidence.length ? `Evidence:\n${formatBullets(evidence, "Read-only evidence is available.")}` : "",
      files.length ? `Relevant paths:\n${formatBullets(files, "No path summary available.")}` : "",
      constraints.length ? `Constraints:\n${formatBullets(constraints, "No extra constraints.")}` : "",
      "",
      "The design must include: user goal, concrete findings, proposed architecture/workflow, affected files/interfaces, execution order, data/control flow, risks/tradeoffs, validation, and default assumptions/follow-up enhancements. If a critical choice blocks execution, ask with `<user_options>` before approval instead of burying it as an open question.",
    ].filter(Boolean).join("\n");
  }

  return [
    "你已经获得只读证据。不要重复扫描目录或泛读上下文。",
    "现在生成可审阅、可执行的正式设计方案。",
    "",
    "硬性要求：",
    "- 所有可见正文和 `.MAIN/plans/design.md` 内容必须使用简体中文。",
    "- 优先只调用一次 `write_file`，写入 `.MAIN/plans/design.md`。",
    "- 批准前不要生成 `tasks.md`，不要修改源码或最终交付文件。",
    "- 计划中禁止出现工具日志、ContextMemoryState、XML、原始 JSON envelope、恢复提示。",
    "- 如果确实缺少关键业务选择，用 `<user_options>` 提问，不要写泛化模板计划。",
    "",
    `用户目标：${goal}`,
    evidence.length ? `已获得证据：\n${formatBullets(evidence, "已有只读证据。")}` : "",
    files.length ? `相关路径：\n${formatBullets(files, "暂无路径摘要。")}` : "",
    constraints.length ? `约束：\n${formatBullets(constraints, "暂无额外约束。")}` : "",
    "",
    "design.md 必须包含：用户目标、当前真实发现、拟定架构/流程、影响文件/接口、执行顺序、数据流/控制流、风险取舍、验证方式、默认假设/后续增强。真正阻塞执行的选择必须在批准前用 `<user_options>` 提问，不要伪装成设计尾部的开放问题。",
  ].filter(Boolean).join("\n");
}
