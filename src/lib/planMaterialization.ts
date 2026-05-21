import { sanitizePlanArtifactContent } from "./sanitize";
import {
  repairActionablePlanArtifactContent,
  validateActionablePlanArtifact,
  type PlanStage,
} from "./workflowModels";
import { normalizeTurnInputContextSignals, type TurnInputContextLike } from "./turnIntake";

export type MaterializablePlanKind = "plan";

export interface PlanMaterializationResult {
  ok: boolean;
  kind?: MaterializablePlanKind;
  path?: string;
  content?: string;
  reason?: string;
}

interface PlanMaterializationToolActivityLike {
  name?: string;
  target?: string;
  status?: string;
  detail?: string;
}

const PROTOCOL_NOISE_RE = /<\/?(?:tool_use|tool_call|function_call|tool|parameter)\b/i;
const PROPOSAL_MARKER_RE = /^\s*\[PROPOSAL START\]\s*$/gim;
const USER_OPTIONS_BLOCK_RE = /^\s*<user_options>\s*$[\s\S]*?^\s*<\/user_options>\s*$/gim;
const OPTION_BLOCK_RE = /<option\b[^>]*>[\s\S]*?<\/option>/gi;
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
  const keywordCount = (content.match(/目标|约束|截图|附件|观察|已确认|事实|证据|发现|方案|计划|设计|执行|实施|步骤|接口|文件|数据流|控制流|风险|验证|验证标准|注意事项|边界|默认假设|未验证假设|后续增强|开放问题|Goal|Constraint|Screenshot|Attachment|Observation|Confirmed|Evidence|Finding|Approach|Plan|Design|Interface|File|Flow|Risk|Validation|Caveat|Boundary|Assumption|Default|Follow-up|Enhancement|Open question/gi) || []).length;
  return headingCount + Math.min(bulletCount, 6) + Math.min(keywordCount, 8);
}

function detectMaterializationLanguage(input: {
  content: string;
  userGoal?: string;
  language?: "zh" | "en";
}): "zh" | "en" {
  if (input.language === "en" || input.language === "zh") return input.language;
  return /[\u4e00-\u9fff]/.test(`${input.content}\n${input.userGoal || ""}`) ? "zh" : "en";
}

function stripPlanChoiceMarkup(rawText: string): string {
  return rawText
    .replace(USER_OPTIONS_BLOCK_RE, "")
    .replace(OPTION_BLOCK_RE, "")
    .replace(/<\/?\s*user_options\s*>/gi, "user options")
    .replace(/<\/?\s*option\b[^>]*>/gi, "")
    .trim();
}

function normalizePlanContent(rawText: string): string {
  const withoutChoices = stripPlanChoiceMarkup(rawText);
  const withoutProposalMarkers = withoutChoices.replace(PROPOSAL_MARKER_RE, "").trim();
  const strippedPlanJson = withoutProposalMarkers.replace(/<plan>[\s\S]*?<\/plan>/gi, "").trim();
  const sanitized = sanitizePlanArtifactContent(strippedPlanJson);
  if (/^#\s+/m.test(sanitized)) return sanitized;
  return `# Plan\n\n${sanitized}`;
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

function stripPlanListMarker(line: string): string {
  return String(line || "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)、]\s+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .trim();
}

function cleanPlanItem(value: unknown, maxChars = 220): string {
  const text = compactPlanLine(stripPlanListMarker(String(value ?? "")), maxChars);
  if (!text) return "";
  if (/^(?:批准|取消|继续调整|开始调查|Approve|Cancel|Continue|Adjust)\b/i.test(text)) return "";
  return text;
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

function uniquePlanItems(values: unknown[], maxItems: number, maxChars = 220): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const line = cleanPlanItem(value, maxChars);
    if (!line) continue;
    const key = line.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
    if (result.length >= maxItems) break;
  }
  return result;
}

interface ParsedPlanSection {
  title: string;
  body: string;
}

function parsePlanSections(content: string): ParsedPlanSection[] {
  const sections: ParsedPlanSection[] = [];
  let title = "";
  let body: string[] = [];
  for (const line of String(content || "").split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      if (title || body.join("\n").trim()) {
        sections.push({ title, body: body.join("\n") });
      }
      title = heading[1] || "";
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

function collectLinesFromSections(
  sections: ParsedPlanSection[],
  patterns: RegExp[],
  maxItems: number,
): string[] {
  const values: string[] = [];
  for (const section of sections) {
    if (!patterns.some((pattern) => pattern.test(section.title))) continue;
    values.push(...section.body.split(/\r?\n/));
  }
  return uniquePlanItems(values, maxItems);
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
  const detail = cleanPlanItem(activity.detail, 160);
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

function formatCanonicalSection(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines.map((line) => `- ${line}`)].join("\n");
}

function formatCanonicalSteps(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines.map((line, index) => `${index + 1}. ${line}`)].join("\n");
}

export function canonicalizePlanArtifactContent(input: {
  content: string;
  userGoal?: string;
  evidence?: string[];
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

  const goalLines = uniquePlanItems([
    input.userGoal,
    ...collectLinesFromSections(sections, [
      /(?:用户目标|目标|需求|问题|Goal|Objective|User Request|Problem)/i,
    ], 3),
    !/^(?:Plan|Proposed Plan|计划|计划草稿|修复方案)$/i.test(title) ? title : "",
  ], 3);
  const screenshotLines = collectLinesFromSections(sections, [
    /(?:截图|附件|图片|视觉|观察|Screenshot|Attachment|Visual|Provided Context|Observation)/i,
  ], 4);
  const visibleEvidenceLines = collectLinesFromSections(sections, [
    /(?:已读证据|证据引用|证据|读取|调查|Evidence|References|Read Evidence|Context Read)/i,
  ], 6);
  const activityEvidence = uniquePlanItems(
    (input.recentToolActivity || [])
      .map(summarizeToolActivityForEvidence)
      .map((item) => summarizeEvidenceLine(item, language)),
    8,
  );
  const externalEvidence = uniquePlanItems(
    (input.evidence || []).map((item) => summarizeEvidenceLine(item, language)),
    8,
  );
  const evidenceLines = uniquePlanItems([
    ...externalEvidence,
    ...activityEvidence,
    ...visibleEvidenceLines,
    providedContextCount > 0
      ? buildProvidedContextObservation({ turnContext: input.turnContext, language })
      : "",
  ], 10);

  const visibleFindingLines = collectLinesFromSections(sections, [
    /(?:已确认|真实发现|当前发现|发现|调查摘要|分析|Investigation Summary|Analysis|Confirmed|Findings|Current State|Observation)/i,
  ], 8);
  const confirmedLines = uniquePlanItems([
    ...visibleFindingLines.filter((line) => !isSpeculativePlanLine(line)),
    ...evidenceLines.slice(0, 4).map((line) =>
      language === "zh" ? `已确认存在相关证据：${line}` : `Confirmed relevant evidence exists: ${line}`
    ),
  ], 6);
  const hypothesisLines = uniquePlanItems([
    ...collectLinesFromSections(sections, [
      /(?:未验证|假设|待确认|风险|注意|边界|Unverified|Hypotheses|Assumptions|Unknowns|Risks|Caveats)/i,
    ], 6),
    ...visibleFindingLines.filter(isSpeculativePlanLine),
  ], 5);
  const fileLines = uniquePlanItems([
    ...(input.files || []),
    ...(input.recentToolActivity || []).map((activity) => activity.target || ""),
    ...collectLinesFromSections(sections, [
      /(?:影响文件|相关文件|文件|接口|组件|Affected|Files|Interfaces|Components|Paths)/i,
    ], 8),
    ...collectPathLikePlanItems(raw),
  ], 10, 160);
  const stepLines = uniquePlanItems([
    ...collectLinesFromSections(sections, [
      /(?:执行|实施|方案|计划|步骤|修复|落地|Approach|Implementation|Plan of Work|Plan|Steps|Fix)/i,
    ], 8),
  ], 8);
  const riskLines = uniquePlanItems([
    ...collectLinesFromSections(sections, [
      /(?:风险|取舍|注意|边界|默认|后续|Risks|Tradeoffs|Caveats|Boundary|Default|Follow-up)/i,
    ], 5),
  ], 5);
  const validationLines = collectLinesFromSections(sections, [
    /(?:验证|测试|构建|验收|Validation|Testing|Acceptance|Build|Checks)/i,
  ], 5);

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

  if (language === "en") {
    return [
      "# Plan",
      formatCanonicalSection("User Goal", goalLines),
      formatCanonicalSection("Screenshot / Attachment Observations", screenshotLines.length > 0
        ? screenshotLines
        : [buildProvidedContextObservation({ turnContext: input.turnContext, language })]),
      formatCanonicalSection("Read Evidence", evidenceLines),
      formatCanonicalSection("Confirmed Facts", confirmedLines.length > 0
        ? confirmedLines
        : evidenceLines.slice(0, 3).map((line) => `Confirmed evidence: ${line}`)),
      formatCanonicalSection("Unverified Hypotheses", hypothesisLines.length > 0
        ? hypothesisLines
        : ["No additional execution assumption is trusted until validated during implementation."]),
      formatCanonicalSection("Affected Files", fileLines.length > 0
        ? fileLines
        : ["To be confirmed by targeted implementation reads before source changes."]),
      formatCanonicalSteps("Execution Steps", stepLines),
      formatCanonicalSection("Risks / Tradeoffs", riskLines.length > 0
        ? riskLines
        : ["Do not treat unverified assumptions as implementation facts."]),
      formatCanonicalSection("Validation Standards", validationLines),
    ].join("\n\n");
  }

  return [
    "# 计划",
    formatCanonicalSection("用户目标", goalLines),
    formatCanonicalSection("截图/附件观察", screenshotLines.length > 0
      ? screenshotLines
      : [buildProvidedContextObservation({ turnContext: input.turnContext, language })]),
    formatCanonicalSection("已读证据", evidenceLines),
    formatCanonicalSection("已确认事实", confirmedLines.length > 0
      ? confirmedLines
      : evidenceLines.slice(0, 3).map((line) => `已确认存在相关证据：${line}`)),
    formatCanonicalSection("未验证假设", hypothesisLines.length > 0
      ? hypothesisLines
      : ["未验证：暂无可直接信任的额外执行假设；实施中出现的新推断必须先验证。"]),
    formatCanonicalSection("影响文件", fileLines.length > 0
      ? fileLines
      : ["待执行前通过定向读取确认具体源码路径；批准前不修改未确认文件。"]),
    formatCanonicalSteps("执行步骤", stepLines),
    formatCanonicalSection("风险取舍", riskLines.length > 0
      ? riskLines
      : ["不要把未验证假设当成已确认事实执行。"]),
    formatCanonicalSection("验证标准", validationLines),
  ].join("\n\n");
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
  userGoal?: string;
  evidence?: string[];
  files?: string[];
  recentToolActivity?: PlanMaterializationToolActivityLike[];
  turnContext?: TurnInputContextLike | null;
  language?: "zh" | "en";
}): PlanMaterializationResult {
  const raw = stripPlanChoiceMarkup(String(input.visibleText || "").trim());
  if (!raw) return { ok: false, reason: "empty" };
  if (PROTOCOL_NOISE_RE.test(raw)) return { ok: false, reason: "protocol_noise" };
  if (TOOL_LOG_NOISE_RE.test(raw)) return { ok: false, reason: "tool_log_noise" };
  if (raw.length < 280) return { ok: false, reason: "too_short" };

  const kind: MaterializablePlanKind = "plan";
  let content = normalizePlanContent(raw);
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
    }
  }
  if (
    !validation.ok &&
    !/generic_fallback_plan|unsupported_debug_log_advice/i.test(validation.reason || "")
  ) {
    const canonical = canonicalizePlanArtifactContent({
      content,
      userGoal: input.userGoal,
      evidence: input.evidence,
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
      }
    }
  }
  if (!validation.ok) return { ok: false, reason: validation.reason || "quality_gate" };

  return {
    ok: true,
    kind,
    path: ".MAIN/plans/plan.md",
    content,
  };
}

export function isMaterializablePlanLikeText(text: string): boolean {
  return materializePlanArtifactFromVisibleText({ visibleText: text }).ok;
}

export function composeReviewablePlanFromEvidence(input: {
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
      "Generate a reviewable, actionable plan now.",
      "",
      "Hard requirements:",
      "- Use English for all visible prose and `.MAIN/plans/plan.md` content.",
      "- Prefer a single `write_file` tool call that writes `.MAIN/plans/plan.md`.",
      "- Do not create `tasks.md`; do not modify source or deliverable files before approval.",
      "- Do not include tool logs, ContextMemoryState, XML, raw JSON envelopes, or recovery prompts in the plan.",
      "- Separate confirmed facts from unverified hypotheses. Do not write probability guesses as execution steps unless an evidence line supports them.",
      "- If a critical business choice is genuinely missing, ask with `<user_options>` instead of writing a generic plan.",
      "",
      `User goal: ${goal}`,
      evidence.length ? `Evidence:\n${formatBullets(evidence, "Read-only evidence is available.")}` : "",
      files.length ? `Relevant paths:\n${formatBullets(files, "No path summary available.")}` : "",
      constraints.length ? `Constraints:\n${formatBullets(constraints, "No extra constraints.")}` : "",
      "",
      "The plan must include: user goal, screenshot/attachment observations when present, confirmed facts, evidence references, unverified hypotheses, affected files/interfaces, execution steps, risks/tradeoffs, and validation standards. If a critical choice blocks execution, ask with `<user_options>` before approval instead of burying it as an open question.",
    ].filter(Boolean).join("\n");
  }

  return [
    "你已经获得只读证据。不要重复扫描目录或泛读上下文。",
    "现在生成可审阅、可执行的正式计划。",
    "",
    "硬性要求：",
    "- 所有可见正文和 `.MAIN/plans/plan.md` 内容必须使用简体中文。",
    "- 优先只调用一次 `write_file`，写入 `.MAIN/plans/plan.md`。",
    "- 批准前不要生成 `tasks.md`，不要修改源码或最终交付文件。",
    "- 计划中禁止出现工具日志、ContextMemoryState、XML、原始 JSON envelope、恢复提示。",
    "- 必须区分已确认事实和未验证假设。没有证据支撑的概率判断不能写成执行步骤。",
    "- 如果确实缺少关键业务选择，用 `<user_options>` 提问，不要写泛化模板计划。",
    "",
    `用户目标：${goal}`,
    evidence.length ? `已获得证据：\n${formatBullets(evidence, "已有只读证据。")}` : "",
    files.length ? `相关路径：\n${formatBullets(files, "暂无路径摘要。")}` : "",
    constraints.length ? `约束：\n${formatBullets(constraints, "暂无额外约束。")}` : "",
    "",
    "plan.md 必须包含：用户目标、截图/附件观察、已确认事实、证据引用、未验证假设、影响文件/接口、执行步骤、风险取舍和验证标准。真正阻塞执行的选择必须在批准前用 `<user_options>` 提问，不要伪装成计划尾部的开放问题。",
  ].filter(Boolean).join("\n");
}
