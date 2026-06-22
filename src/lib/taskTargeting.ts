import { getProtocolPackageEntryPath } from "./protocolPackages";
import { hasTurnProvidedContext, normalizeTurnInputContextSignals, type TurnInputContextLike } from "./turnIntake";
import type { PlanArtifact } from "./workflowModels";

export type TaskFacet =
  | "source_code"
  | "ui_design"
  | "tabular_data"
  | "explicit_path"
  | "symbol_target"
  | "protocol_design"
  | "provided_context"
  | "visual_context";

export type TaskOrchestratorPhase =
  | "INTAKE_PARSE"
  | "TARGET_DISCOVERY"
  | "SCOPED_EXPLORATION"
  | "PLAN_MATERIALIZE"
  | "APPROVAL"
  | "EXECUTE_STEP"
  | "EVIDENCE_RECONCILE"
  | "VERIFY"
  | "DONE"
  | "PAUSED";

export type ExecutionGateReason =
  | "tabular_raw_read"
  | "provided_context_broad_directory"
  | "root_skeleton_not_scoped"
  | "root_skeleton_too_deep"
  | "root_skeleton_already_read"
  | "design_protocol_required";

export interface TaskTargetingSkillLike {
  active?: boolean;
  type?: string;
  name?: string;
  content?: string;
  packagePath?: string | null;
  entryPoint?: string | null;
  workspaceScope?: string | null;
}

export interface TaskTargetingProfile {
  facets: TaskFacet[];
  explicitPaths: string[];
  symbols: string[];
  tabularPaths: string[];
  mentionedFilePaths: string[];
  attachedFilePaths: string[];
  imageParts: number;
  hasUserProvidedContext: boolean;
  hasOnlyVisualContext: boolean;
  rootDirectoryAlreadyListed: boolean;
  designProtocolPaths: string[];
  requiresDesignProtocol: boolean;
  designProtocolSatisfied: boolean;
  userStyleConfirmed: boolean;
  tabularAnalysisSatisfied: boolean;
  rootSkeletonAlreadyRead: boolean;
  allowRootSkeleton: boolean;
  preferredReadTools: string[];
  reasons: string[];
}

export interface BuildTaskTargetingProfileInput {
  userPrompt?: string;
  planArtifacts?: PlanArtifact[];
  planTaskTexts?: string[];
  associatedPaths?: string[];
  skills?: TaskTargetingSkillLike[];
  observedEvidence?: string[];
  userContext?: TurnInputContextLike;
}

export interface TaskTargetingToolGateInput {
  profile: TaskTargetingProfile;
  toolName: string;
  args: Record<string, unknown>;
  target?: string;
  availableToolNames?: Set<string>;
  language?: "zh" | "en";
  allowApprovedPlanDesignWrite?: boolean;
}

export interface TaskTargetingToolGateResult {
  blocked: boolean;
  reason?: ExecutionGateReason;
  message?: string;
  suggestedTools?: string[];
}

const PATH_REF_RE =
  /(?:^|[\s`"'(（])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?=$|[\s`"',，。；;:)）])/g;
const SYMBOL_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:[A-Z][A-Za-z0-9_$]*|Data|Store|View|Panel|Island|Chart|Table|Route|Hook)\b/g;
const TABULAR_EXT_RE = /\.(?:csv|tsv|xlsx|xls|xlsm)$/i;
const UI_SOURCE_RE = /\.(?:tsx|jsx|css|scss|sass|less)$/i;
const UI_PATH_RE = /(?:^|\/)(?:components?|pages?|views?|routes?|app|ui|styles?|theme|design)(?:\/|$)/i;
const DESIGN_PATH_RE = /(?:^|\/)(?:design\.md|design-md\/.+\.md|skill\.md)$/i;

function normalizeSlashPath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").trim();
}

function normalizeEvidence(value: string): string {
  return normalizeSlashPath(value).toLowerCase();
}

function pushUnique(list: string[], value: string): void {
  const normalized = normalizeSlashPath(value);
  if (!normalized) return;
  if (!list.some((item) => normalizeEvidence(item) === normalizeEvidence(normalized))) {
    list.push(normalized);
  }
}

function addFacet(facets: Set<TaskFacet>, facet: TaskFacet): void {
  facets.add(facet);
}

export function isTabularPath(path: string): boolean {
  return TABULAR_EXT_RE.test(normalizeSlashPath(path));
}

export function isUiSourcePath(path: string): boolean {
  const normalized = normalizeSlashPath(path);
  return UI_SOURCE_RE.test(normalized) || UI_PATH_RE.test(normalized);
}

function extractExplicitPaths(text: string): string[] {
  const paths: string[] = [];
  for (const matched of String(text || "").matchAll(PATH_REF_RE)) {
    pushUnique(paths, matched[1] || "");
  }
  return paths;
}

function extractSymbols(text: string): string[] {
  const symbols: string[] = [];
  for (const matched of String(text || "").matchAll(SYMBOL_RE)) {
    const value = matched[0] || "";
    if (value.length < 4) continue;
    if (/^(?:README|JSON|CSV|TSV|XLSX|HTML|CSS|HTTP|MAIN)$/i.test(value)) continue;
    pushUnique(symbols, value);
  }
  return symbols.slice(0, 12);
}

function hasUiDesignCue(text: string): boolean {
  return /(?:UI|界面|页面|组件|面板|仪表盘|看板|卡片|表格视图|样式|视觉|主题|布局|交互|设计|design|layout|style|theme|component|panel|dashboard|ExecutionCapsule)/i.test(text);
}

function hasExplicitStyleConfirmation(text: string): boolean {
  return /(?:风格|样式|设计|UI|theme|style|design).{0,24}(?:确认|已定|按照|按|使用|采用|沿用|选定|confirmed|use|follow|apply)/i.test(text);
}

function hasImplementationOrBugCue(text: string): boolean {
  return /(?:修复|修改|实现|改代码|源码|组件|页面|界面|面板|状态|store|hook|渲染|导入|上传|解析|显示|不能|无法|没有|报错|错误|异常|bug|fix|repair|implement|code|component|render|import|upload|parse|display|shown?|error|issue)/i.test(text);
}

function hasTabularAnalysisCue(text: string): boolean {
  return /(?:分析|统计|汇总|聚合|筛选|查询|透视|画像|趋势|环比|同比|指标|报表|图表分析|analy[sz]e|aggregate|summari[sz]e|query|filter|pivot|metric|report|trend|monthly compare)/i.test(text);
}

function hasUiBugContextCue(text: string): boolean {
  return /(?:修复|改代码|源码|代码|组件|页面|界面|面板|仪表盘|看板|状态|store|hook|渲染|报错|错误|异常|bug|fix|repair|code|component|page|panel|dashboard|render|state|error|issue)/i.test(text);
}

function isDesignProtocolSkill(skill: TaskTargetingSkillLike): boolean {
  if (!skill.active) return false;
  const probe = [
    skill.name || "",
    skill.content || "",
    skill.packagePath || "",
    skill.entryPoint || "",
  ].join("\n");
  return /(?:DESIGN|design-md|设计|UI|style|theme|awesome-design)/i.test(probe);
}

function collectDesignProtocolPaths(skills: TaskTargetingSkillLike[] = []): string[] {
  const paths: string[] = [];
  for (const skill of skills) {
    if (!isDesignProtocolSkill(skill)) continue;
    if (skill.packagePath || skill.entryPoint) {
      pushUnique(paths, getProtocolPackageEntryPath(skill));
    }
    if (skill.packagePath) pushUnique(paths, skill.packagePath);
    for (const matched of String(skill.content || "").matchAll(/((?:\.protocols\/[^\s`"')，。；]+\/)?(?:design-md\/)?DESIGN\.md)/gi)) {
      pushUnique(paths, matched[1] || "");
    }
    if (!skill.packagePath && !skill.entryPoint) {
      pushUnique(paths, "DESIGN.md");
    }
  }
  return paths;
}

function evidenceHasDesignProtocolRead(evidence: string[], designPaths: string[]): boolean {
  const normalizedDesignPaths = designPaths.map(normalizeEvidence).filter(Boolean);
  return evidence.some((item) => {
    const normalized = normalizeEvidence(item.replace(/^path:/i, ""));
    if (!normalized) return false;
    if (DESIGN_PATH_RE.test(normalized)) return true;
    return normalizedDesignPaths.some((designPath) =>
      normalized === designPath ||
      normalized.startsWith(`${designPath}/`) ||
      designPath.endsWith(normalized),
    );
  });
}

function hasWindowedReadArgs(args: Record<string, unknown>): boolean {
  return ["start_line", "end_line", "max_lines", "row_offset", "max_rows"].some((key) => {
    const value = args[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}

function getToolDepth(args: Record<string, unknown>): number | null {
  const value = args.depth;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function buildTaskTargetingProfile(input: BuildTaskTargetingProfileInput = {}): TaskTargetingProfile {
  const userContext = normalizeTurnInputContextSignals(input.userContext);
  const combinedText = [
    input.userPrompt || "",
    ...(input.planArtifacts || []).map((artifact) => artifact.content || ""),
    ...(input.planTaskTexts || []),
    ...(input.associatedPaths || []),
    ...userContext.mentionedFilePaths,
    ...userContext.attachedFilePaths,
  ].join("\n");
  const explicitPaths = extractExplicitPaths(combinedText);
  for (const path of input.associatedPaths || []) pushUnique(explicitPaths, path);
  for (const path of userContext.mentionedFilePaths) pushUnique(explicitPaths, path);
  for (const path of userContext.attachedFilePaths) pushUnique(explicitPaths, path);
  const symbols = extractSymbols(combinedText);
  const tabularPaths = explicitPaths.filter(isTabularPath);
  const designProtocolPaths = collectDesignProtocolPaths(input.skills);
  const facets = new Set<TaskFacet>();
  const hasProvidedContext = hasTurnProvidedContext(userContext);
  const hasOnlyVisualContext =
    userContext.imageParts > 0 &&
    userContext.mentionedFilePaths.length === 0 &&
    userContext.attachedFilePaths.length === 0;
  const implementationOrBugCue = hasImplementationOrBugCue(combinedText);
  const tabularKeywordCue =
    /(?:CSV|TSV|XLSX|Excel|表格|数据表|dataset|spreadsheet|导入数据|数据导入|趋势|图表|环比|同比|monthly compare|trend|chart)/i.test(combinedText);
  const shouldTreatAsTabularData =
    tabularPaths.length > 0 ||
    (tabularKeywordCue && hasTabularAnalysisCue(combinedText) && !(implementationOrBugCue && hasUiBugContextCue(combinedText)));

  if (explicitPaths.length > 0) addFacet(facets, "explicit_path");
  if (symbols.length > 0) addFacet(facets, "symbol_target");
  if (hasProvidedContext) addFacet(facets, "provided_context");
  if (userContext.imageParts > 0) addFacet(facets, "visual_context");
  if (shouldTreatAsTabularData) {
    addFacet(facets, "tabular_data");
  }
  if (hasUiDesignCue(combinedText)) addFacet(facets, "ui_design");
  if (designProtocolPaths.length > 0) addFacet(facets, "protocol_design");
  if (implementationOrBugCue || /\b(?:src|lib|components?|hooks?|store|class|function|接口|函数|源码|代码)\b/i.test(combinedText)) {
    addFacet(facets, "source_code");
  }

  const observedEvidence = (input.observedEvidence || []).map(normalizeEvidence);
  const tabularAnalysisSatisfied = observedEvidence.some((entry) =>
    entry.startsWith("tool:analyze_tabular_document") ||
    entry.startsWith("tool:query_tabular_document")
  );
  const userStyleConfirmed = hasExplicitStyleConfirmation(combinedText);
  const requiresDesignProtocol = facets.has("ui_design") && designProtocolPaths.length > 0;
  const designProtocolSatisfied =
    !requiresDesignProtocol ||
    userStyleConfirmed ||
    evidenceHasDesignProtocolRead(observedEvidence, designProtocolPaths);
  const rootSkeletonAlreadyRead = observedEvidence.includes("tool:get_project_skeleton");
  const rootDirectoryAlreadyListed = observedEvidence.includes("dir:.") || observedEvidence.includes("dir:");
  const hasScopedTarget = explicitPaths.length > 0 || symbols.length > 0 || tabularPaths.length > 0;
  const allowRootSkeleton =
    !rootSkeletonAlreadyRead &&
    (!hasProvidedContext || hasOnlyVisualContext) &&
    !hasScopedTarget &&
    !facets.has("tabular_data") &&
    !requiresDesignProtocol;

  const preferredReadTools = facets.has("tabular_data")
    ? ["analyze_tabular_document", "query_tabular_document", "read_document"]
    : hasScopedTarget
    ? ["repo_map_search", "repo_map_context", "grep_search", "glob_search", "list_directory", "get_file_outline", "read_file"]
    : hasProvidedContext
    ? ["repo_map_context", "repo_map_search", "grep_search", "glob_search", "list_directory", "read_file", "get_file_outline"]
    : ["repo_map_files", "repo_map_search", "get_project_skeleton", "list_directory", "grep_search"];

  const reasons: string[] = [];
  if (hasScopedTarget) reasons.push("explicit target cues detected; prefer scoped search/read");
  if (userContext.imageParts > 0) reasons.push("user provided image context; inspect screenshot observations before broad discovery");
  if (hasProvidedContext && rootDirectoryAlreadyListed) reasons.push("root directory was already listed despite provided context; converge to targeted evidence");
  if (userContext.mentionedFilePaths.length > 0 || userContext.attachedFilePaths.length > 0) {
    reasons.push("user provided file context; prefer exact file paths before broad discovery");
  }
  if (facets.has("tabular_data")) reasons.push("tabular data detected; prefer structured tabular tools");
  if (requiresDesignProtocol && !designProtocolSatisfied) reasons.push("design protocol must be read or style must be confirmed before UI writes");
  if (rootSkeletonAlreadyRead) reasons.push("root skeleton was already read in this session");

  return {
    facets: [...facets],
    explicitPaths,
    symbols,
    tabularPaths,
    mentionedFilePaths: userContext.mentionedFilePaths,
    attachedFilePaths: userContext.attachedFilePaths,
    imageParts: userContext.imageParts,
    hasUserProvidedContext: hasProvidedContext,
    hasOnlyVisualContext,
    rootDirectoryAlreadyListed,
    designProtocolPaths,
    requiresDesignProtocol,
    designProtocolSatisfied,
    userStyleConfirmed,
    tabularAnalysisSatisfied,
    rootSkeletonAlreadyRead,
    allowRootSkeleton,
    preferredReadTools,
    reasons,
  };
}

export function getTaskTargetingEvidenceKey(
  toolName: string,
  args: Record<string, unknown>,
  target?: string,
): string | null {
  if (toolName === "get_project_skeleton") return "tool:get_project_skeleton";
  if (toolName.startsWith("repo_map_")) return `tool:${toolName}`;
  if (toolName === "read_file" || toolName === "read_document" || toolName === "get_file_outline") {
    const path = String(args.path || args.file_path || target || "").trim();
    return path ? `path:${normalizeSlashPath(path)}` : null;
  }
  if (toolName === "list_directory") {
    const path = String(args.path || target || ".").trim();
    return `dir:${normalizeSlashPath(path) || "."}`;
  }
  if (toolName === "analyze_tabular_document" || toolName === "query_tabular_document") {
    const path = String(args.path || target || "").trim();
    return path ? `tool:${toolName}:${normalizeSlashPath(path)}` : `tool:${toolName}`;
  }
  return null;
}

function makeMessage(reason: ExecutionGateReason, language: "zh" | "en", target: string): string {
  if (language === "en") {
    switch (reason) {
      case "tabular_raw_read":
        return `TASK_TARGETING_BLOCKED: ${target} is tabular data. Use analyze_tabular_document or query_tabular_document first; use read_file only with a small window when raw rows are explicitly needed.`;
      case "provided_context_broad_directory":
        return "TASK_TARGETING_BLOCKED: the user already provided images, attachments, or @ files. First summarize that provided context and use targeted search/read based on the observed phenomenon instead of broad root directory discovery.";
      case "root_skeleton_not_scoped":
        return "TASK_TARGETING_BLOCKED: this task already has explicit paths or symbols. Use grep_search/glob_search/list_directory/read_file on the scoped target instead of reading the whole project skeleton.";
      case "root_skeleton_too_deep":
        return "TASK_TARGETING_BLOCKED: root skeleton is only allowed as a shallow discovery pass. Retry get_project_skeleton with depth 2 or use targeted search.";
      case "root_skeleton_already_read":
        return "TASK_TARGETING_BLOCKED: the root skeleton was already read in this session. Reuse existing structure and continue with targeted search/read tools.";
      case "design_protocol_required":
        return `TASK_TARGETING_BLOCKED: ${target} is a UI/design source target and an active DESIGN protocol is present. Read the relevant DESIGN.md/protocol entry or ask the user to confirm the style before writing UI source.`;
      default:
        return "TASK_TARGETING_BLOCKED: choose a more targeted tool before continuing.";
    }
  }

  switch (reason) {
    case "tabular_raw_read":
      return `TASK_TARGETING_BLOCKED: ${target} 是表格数据。请先使用 analyze_tabular_document 或 query_tabular_document；只有明确需要原始行时，才用带窗口参数的 read_file。`;
    case "provided_context_broad_directory":
      return "TASK_TARGETING_BLOCKED: 用户已经提供图片、附件或 @ 文件。请先概括这些上下文中观察到的现象，并基于该现象做定向搜索/读取，不要从根目录大范围发现开始。";
    case "root_skeleton_not_scoped":
      return "TASK_TARGETING_BLOCKED: 当前任务已有明确路径或符号线索。请改用 grep_search/glob_search/list_directory/read_file 定向定位，不要读取整个项目骨架。";
    case "root_skeleton_too_deep":
      return "TASK_TARGETING_BLOCKED: 根目录骨架只允许作为浅层发现步骤。请用 depth 2 重试 get_project_skeleton，或改用定向搜索。";
    case "root_skeleton_already_read":
      return "TASK_TARGETING_BLOCKED: 本会话已经读取过根目录骨架。请复用已有结构，继续使用定向搜索/读取工具。";
    case "design_protocol_required":
      return `TASK_TARGETING_BLOCKED: ${target} 是 UI/设计源码目标，且当前有生效的 DESIGN 协议。写 UI 源码前必须先读取对应 DESIGN.md/protocol entry，或先向用户确认设计风格。`;
    default:
      return "TASK_TARGETING_BLOCKED: 请先选择更定向的工具再继续。";
  }
}

export function shouldBlockToolCallForTargeting(input: TaskTargetingToolGateInput): TaskTargetingToolGateResult {
  const language = input.language === "en" ? "en" : "zh";
  const target = normalizeSlashPath(input.target || String(input.args.path || input.args.file_path || ""));

  if (
    input.toolName === "read_file" &&
    target &&
    isTabularPath(target) &&
    !hasWindowedReadArgs(input.args) &&
    !input.profile.tabularAnalysisSatisfied
  ) {
    return {
      blocked: true,
      reason: "tabular_raw_read",
      message: makeMessage("tabular_raw_read", language, target),
      suggestedTools: ["analyze_tabular_document", "query_tabular_document"],
    };
  }

  if (input.toolName === "get_project_skeleton") {
    if (input.profile.rootSkeletonAlreadyRead) {
      return {
        blocked: true,
        reason: "root_skeleton_already_read",
        message: makeMessage("root_skeleton_already_read", language, target),
        suggestedTools: input.profile.preferredReadTools,
      };
    }
    if (input.profile.hasUserProvidedContext && !input.profile.allowRootSkeleton) {
      return {
        blocked: true,
        reason: "provided_context_broad_directory",
        message: makeMessage("provided_context_broad_directory", language, target || "."),
        suggestedTools: input.profile.preferredReadTools,
      };
    }
    if (!input.profile.allowRootSkeleton) {
      return {
        blocked: true,
        reason: "root_skeleton_not_scoped",
        message: makeMessage("root_skeleton_not_scoped", language, target),
        suggestedTools: input.profile.preferredReadTools,
      };
    }
    const depth = getToolDepth(input.args);
    if (depth == null || depth > 2) {
      return {
        blocked: true,
        reason: "root_skeleton_too_deep",
        message: makeMessage("root_skeleton_too_deep", language, target),
        suggestedTools: ["get_project_skeleton"],
      };
    }
  }

  if (
    input.toolName === "list_directory" &&
    input.profile.hasUserProvidedContext &&
    (!target || target === "." || target === "./") &&
    !(
      input.profile.hasOnlyVisualContext &&
      !input.profile.rootDirectoryAlreadyListed &&
      !input.profile.rootSkeletonAlreadyRead &&
      input.profile.allowRootSkeleton
    )
  ) {
    return {
      blocked: true,
      reason: "provided_context_broad_directory",
      message: makeMessage("provided_context_broad_directory", language, target || "."),
      suggestedTools: input.profile.preferredReadTools,
    };
  }

  if (
    (input.toolName === "write_file" || input.toolName === "replace_in_file" || input.toolName === "apply_patch") &&
    target &&
    isUiSourcePath(target) &&
    input.profile.requiresDesignProtocol &&
    !input.profile.designProtocolSatisfied &&
    !input.allowApprovedPlanDesignWrite
  ) {
    return {
      blocked: true,
      reason: "design_protocol_required",
      message: makeMessage("design_protocol_required", language, target),
      suggestedTools: ["read_file"],
    };
  }

  return { blocked: false };
}
