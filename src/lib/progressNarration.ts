import {
  compactToolPresentationTarget,
  deriveToolPhase,
  formatToolPresentation,
  type ToolExecutionPhase,
  type ToolPresentationLanguage,
} from "./toolPresentation";
import type { ResolvedUserIntent } from "./runIntent";

export type ProgressNarrationPhase =
  | "understanding"
  | "investigating"
  | "editing"
  | "verifying"
  | "blocked"
  | "summarizing";

export type ProgressNarrationStatus = "running" | "done" | "failed";
export type ProgressNarrationSource = "runtime" | "model" | "tool_result";

export interface ProgressNarration {
  phase: ProgressNarrationPhase;
  title: string;
  why: string;
  action: string;
  evidence: string;
  next: string;
  targets: string[];
  /** Structured runtime identity; presentation consumers should not infer it from title/action. */
  tool?: string;
  target?: string;
  canonicalTarget?: string;
  status: ProgressNarrationStatus;
  source: ProgressNarrationSource;
  evidenceExcerpt?: string;
  observedFact?: string;
  hypothesisStatus?: "confirmed" | "unverified" | "blocked";
  sourceToolCallIds?: string[];
}

export interface ToolProgressNarrationInput {
  toolName: string;
  target?: string;
  language?: ToolPresentationLanguage;
  status?: ProgressNarrationStatus;
  source?: ProgressNarrationSource;
  userGoal?: string;
  turnIntent?: ResolvedUserIntent | string;
  workflowMode?: "chat" | "edit" | "plan" | string;
  currentHypothesis?: string;
  previousObservation?: string;
  targetRole?: string;
  result?: string;
  noOp?: boolean;
  evidenceExcerpt?: string;
  observedFact?: string;
  hypothesisStatus?: "confirmed" | "unverified" | "blocked";
  sourceToolCallIds?: string[];
}

const VERIFY_COMMAND_RE = /\b(?:test|build|lint|check|typecheck|tsc|playwright|vitest|jest|pytest|cargo\s+(?:test|check)|go\s+test|npm\s+(?:run\s+)?(?:build|test|lint|check)|pnpm\s+(?:run\s+)?(?:build|test|lint|check)|yarn\s+(?:build|test|lint|check))\b/i;

function normalizeLanguage(language?: ToolPresentationLanguage): ToolPresentationLanguage {
  return language === "en" ? "en" : "zh";
}

function compactLine(text: string, maxChars = 180): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function compactMarkdownSnippet(text: string, maxChars = 180): string {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/\b(?:thought|analysis|thinking|reasoning)\b[:：]?/gi, " ")
    .replace(/^(?:因为|原因|下一步|正在做|证据)\s*[:：]\s*/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function looksLikeProgressEcho(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:正在|等待|已读取|已搜索|已记录|已确认|下一步|根据证据|用.*作为成功标准)/.test(normalized) &&
    /(?:读取|搜索|修改|运行|验证|工具|返回|结果|证据)/.test(normalized)
  );
}

function compactContextSnippet(text: string, maxChars = 180): string {
  const normalized = compactMarkdownSnippet(text, maxChars);
  return looksLikeProgressEcho(normalized) ? "" : normalized;
}

function compactEvidenceExcerpt(text: string, maxChars = 220): string {
  return compactMarkdownSnippet(text, maxChars)
    .replace(/\b(?:exitCode|exit_code)\b["':\s]*/gi, "exit ")
    .trim();
}

function compactGoal(goal: string, language: ToolPresentationLanguage): string {
  const normalized = compactLine(goal, language === "zh" ? 42 : 54);
  if (!normalized) return "";
  return language === "zh" ? `“${normalized}”` : `"${normalized}"`;
}

function basenameLike(target: string): string {
  const normalized = String(target || "").replace(/[\\/]+$/g, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function stripExtension(name: string): string {
  return name.replace(/\.(?:tsx?|jsx?|mjs|cjs|css|scss|sass|html?|mdx?|md|json|ya?ml|toml|rs|vue|svelte)$/i, "");
}

export function deriveToolTargetRole(input: {
  toolName: string;
  target?: string;
  language?: ToolPresentationLanguage;
  targetRole?: string;
}): string {
  const language = normalizeLanguage(input.language);
  const explicit = String(input.targetRole || "").replace(/\s+/g, " ").trim();
  if (explicit) return explicit;

  const toolName = String(input.toolName || "");
  const target = String(input.target || "").trim();
  const lowerTarget = target.toLowerCase();
  const base = stripExtension(basenameLike(target));

  if (!target) {
    if (toolName === "get_project_skeleton") return language === "zh" ? "项目结构" : "project structure";
    if (toolName.startsWith("repo_map_")) return language === "zh" ? "代码图谱" : "repo map";
    if (toolName.includes("pty")) return language === "zh" ? "终端状态" : "terminal state";
    return language === "zh" ? "当前工作区" : "current workspace";
  }

  if (toolName === "browser_evaluate") {
    return language === "zh" ? `浏览器页面 \`${compactLine(target, 72)}\`` : `browser page \`${compactLine(target, 72)}\``;
  }

  if (toolName === "run_command" || toolName === "execute_command") {
    if (VERIFY_COMMAND_RE.test(target)) {
      return language === "zh" ? `验证命令 \`${compactLine(target, 72)}\`` : `verification command \`${compactLine(target, 72)}\``;
    }
    return language === "zh" ? `命令 \`${compactLine(target, 72)}\`` : `command \`${compactLine(target, 72)}\``;
  }

  if (/chatarea/i.test(target)) return language === "zh" ? "ChatArea 渲染逻辑" : "ChatArea rendering path";
  if (/actioncard/i.test(target)) return language === "zh" ? "ActionCard 工具卡展示" : "ActionCard tool-card presentation";
  if (/useappstore/i.test(target)) return language === "zh" ? "消息状态与可见性逻辑" : "message state and visibility logic";
  if (/orchestrator/i.test(target)) return language === "zh" ? "agent 编排逻辑" : "agent orchestration logic";
  if (/toolpresentation/i.test(target)) return language === "zh" ? "工具意图说明逻辑" : "tool-intent presentation logic";
  if (/systemprompt/i.test(target)) return language === "zh" ? "系统提示规则" : "system prompt rules";
  if (/turn-process-archive|turnprocessarchive/i.test(target)) return language === "zh" ? "过程归档时间线" : "process archive timeline";
  if (/progress/i.test(target)) return language === "zh" ? "进度展示逻辑" : "progress presentation logic";
  if (/hiddenprocess/i.test(target)) return language === "zh" ? "hiddenProcess 可见性链路" : "hiddenProcess visibility path";
  if (/usecsvparser/i.test(target)) return language === "zh" ? "CSV 解析逻辑" : "CSV parsing path";
  if (/dashboardstore/i.test(target)) return language === "zh" ? "Dashboard Store 聚合逻辑" : "dashboard store aggregation";
  if (/usechartdata/i.test(target)) return language === "zh" ? "图表数据 Hook" : "chart data hook";
  if (/types[\\/]order/i.test(target)) return language === "zh" ? "订单字段模型" : "order field model";
  if (/fileuploader|dragupload/i.test(target)) return language === "zh" ? "CSV 导入入口" : "CSV upload entry";
  if (/coursecleaner/i.test(target)) return language === "zh" ? "课程名称清洗逻辑" : "course-name cleanup logic";
  if (/dateutils/i.test(target)) return language === "zh" ? "日期归一化逻辑" : "date normalization logic";
  if (/overviewcards/i.test(target)) return language === "zh" ? "概览指标组件" : "overview metrics component";
  if (/coursebarchart/i.test(target)) return language === "zh" ? "课程销售排行图表" : "course ranking chart";
  if (/trendlinechart/i.test(target)) return language === "zh" ? "销售趋势图表" : "sales trend chart";
  if (/monthlycomparechart/i.test(target)) return language === "zh" ? "月度环比图表" : "monthly comparison chart";
  if (/statuspiechart/i.test(target)) return language === "zh" ? "订单状态图表" : "order status chart";
  if (/index\.css|theme|dark|app\.tsx/i.test(target)) return language === "zh" ? "主题与布局入口" : "theme and layout entry";
  if (/tests?\//i.test(target) || /\.test\./i.test(target) || /\.spec\./i.test(target)) return language === "zh" ? `${base || "测试"} 回归测试` : `${base || "test"} regression test`;
  if (lowerTarget === "." || lowerTarget === "./") return language === "zh" ? "项目根目录" : "project root";

  if (!/[\\/]/.test(target) && !/\.[a-z0-9]{1,8}$/i.test(target)) {
    return language === "zh" ? `${compactLine(target, 56)} 相关线索` : `signals for ${compactLine(target, 56)}`;
  }

  return compactToolPresentationTarget(target, toolName, language);
}

function progressPhaseForTool(phase: ToolExecutionPhase, target: string): ProgressNarrationPhase {
  if (phase === "blocked") return "blocked";
  if (phase === "edit") return "editing";
  if (phase === "verify") return "verifying";
  if (phase === "command") return VERIFY_COMMAND_RE.test(target) ? "verifying" : "investigating";
  if (phase === "discover" || phase === "inspect") return "investigating";
  return "understanding";
}

function localizedActionVerb(toolName: string, phase: ToolExecutionPhase, language: ToolPresentationLanguage): string {
  if (language === "en") {
    if (toolName === "grep_search" || toolName === "glob_search" || toolName.startsWith("repo_map_")) return "search";
    if (phase === "discover") return "scan";
    if (phase === "inspect") return "read";
    if (phase === "edit") return "edit";
    if (phase === "verify") return "verify";
    if (phase === "command") return "run";
    if (phase === "blocked") return "preserve";
    return "process";
  }
  if (toolName === "grep_search" || toolName === "glob_search" || toolName.startsWith("repo_map_")) return "搜索";
  if (phase === "discover") return "扫描";
  if (phase === "inspect") return "读取";
  if (phase === "edit") return "修改";
  if (phase === "verify") return "验证";
  if (phase === "command") return "执行";
  if (phase === "blocked") return "保留";
  return "处理";
}

function joinZhVerbObject(verb: string, object: string): string {
  return /^[A-Za-z0-9_`]/.test(object) ? `${verb} ${object}` : `${verb}${object}`;
}

function englishPastVerb(verb: string): string {
  if (verb === "read") return "Read";
  if (verb === "run") return "Ran";
  if (verb === "process") return "Processed";
  if (verb.endsWith("e")) return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}d`;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}ed`;
}

function englishRunningVerb(verb: string): string {
  if (verb === "run") return "Running";
  if (verb === "scan") return "Scanning";
  if (verb.endsWith("y")) return `${verb.charAt(0).toUpperCase()}${verb.slice(1, -1)}ying`;
  if (verb.endsWith("e")) return `${verb.charAt(0).toUpperCase()}${verb.slice(1, -1)}ing`;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}ing`;
}

function buildWhy(input: ToolProgressNarrationInput & {
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  language: ToolPresentationLanguage;
  role: string;
}): string {
  const { language, phase, progressPhase } = input;
  const goal = compactGoal(String(input.userGoal || ""), language);
  const hypothesis = compactContextSnippet(String(input.currentHypothesis || ""), 150);
  const observation = compactContextSnippet(String(input.previousObservation || ""), 150);
  const target = String(input.target || "");

  if (language === "en") {
    if (progressPhase === "blocked") return "Keep the real blocker visible so recovery starts from the failed step.";
    if (phase === "edit") {
      if (observation) return `Observed: ${observation}`;
      if (hypothesis) return `Checking: ${hypothesis}`;
      return "";
    }
    if (progressPhase === "verifying") {
      if (/npm\s+(?:run\s+)?build/i.test(target)) return "Use the build result as the success signal: exit code 0 and no blocking TypeScript/Vite errors.";
      if (/\btest|vitest|jest|playwright|pytest|go\s+test|cargo\s+test\b/i.test(target)) return "Use the test output as evidence that the affected behavior still passes.";
      return "Use command output as concrete evidence before claiming the work is complete.";
    }
    if (hypothesis) return `Checking: ${hypothesis}`;
    if (observation) return `Observed: ${observation}`;
    return goal ? `Goal: ${goal}` : "";
  }

  if (progressPhase === "blocked") return "保留真实受阻点，方便从失败步骤继续恢复。";
  if (phase === "edit") {
    if (observation) return `已观察：${observation}`;
    if (hypothesis) return `待验证判断：${hypothesis}`;
    return "";
  }
  if (progressPhase === "verifying") {
    if (/npm\s+(?:run\s+)?build/i.test(target)) return "用构建结果作为成功标准：命令退出码为 0，且没有阻塞性的 TypeScript/Vite 错误。";
    if (/\btest|vitest|jest|playwright|pytest|go\s+test|cargo\s+test\b/i.test(target)) return "用测试输出确认受影响行为仍然通过，而不是只依赖文字判断。";
    return "用命令输出作为真实反馈，确认是否可以继续总结或需要修复。";
  }
  if (hypothesis) return `待验证判断：${hypothesis}`;
  if (observation) return `已观察：${observation}`;
  return goal ? `目标：${goal}` : "";
}

function buildEvidence(input: {
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  status: ProgressNarrationStatus;
  language: ToolPresentationLanguage;
  role: string;
  result?: string;
  noOp?: boolean;
}): string {
  const { language, phase, progressPhase, status, role } = input;
  if (status === "failed") {
    return language === "zh" ? "工具返回了失败信息，失败原因会作为恢复依据。" : "The tool returned a failure; the error is kept as recovery evidence.";
  }
  if (status === "done") {
    return summarizeToolObservation({
      toolName: phase === "edit" ? "replace_in_file" : progressPhase === "verifying" ? "run_command" : "read_file",
      target: role,
      result: input.result || "",
      language,
      noOp: input.noOp,
    });
  }
  return "";
}

function buildNext(input: {
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  status: ProgressNarrationStatus;
  language: ToolPresentationLanguage;
}): string {
  const { language, phase, progressPhase, status } = input;
  if (status === "failed") {
    return language === "zh" ? "先根据失败原因调整目标、参数或方案，再继续。" : "Adjust the target, parameters, or approach before continuing.";
  }
  void language;
  void phase;
  void progressPhase;
  return "";
}

function resolveHypothesisStatus(input: {
  status: ProgressNarrationStatus;
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  explicit?: "confirmed" | "unverified" | "blocked";
}): "confirmed" | "unverified" | "blocked" {
  if (input.explicit) return input.explicit;
  if (input.status === "failed" || input.progressPhase === "blocked") return "blocked";
  if (input.status === "done") return "confirmed";
  return "unverified";
}

function titleForTool(input: {
  toolName: string;
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  role: string;
  language: ToolPresentationLanguage;
}): string {
  const verb = localizedActionVerb(input.toolName, input.phase, input.language);
  if (input.language === "en") {
    if (input.progressPhase === "blocked") return `Blocked at ${input.role}`;
    return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${input.role}`;
  }
  if (input.progressPhase === "blocked") return `${input.role} 受阻`;
  return joinZhVerbObject(verb, input.role);
}

export function buildToolProgressNarration(input: ToolProgressNarrationInput): ProgressNarration {
  const language = normalizeLanguage(input.language);
  const target = String(input.target || "");
  const toolPhase = deriveToolPhase({
    toolName: input.toolName,
    target,
    status: input.status === "failed" ? "failed" : input.status,
    toolStatus: input.status === "failed" ? "failed" : input.status,
  });
  const progressPhase = progressPhaseForTool(toolPhase, target);
  const status = input.status || "running";
  const role = deriveToolTargetRole({
    toolName: input.toolName,
    target,
    language,
    targetRole: input.targetRole,
  });
  const verb = localizedActionVerb(input.toolName, toolPhase, language);
  const action = language === "en"
    ? status === "done"
      ? `${englishPastVerb(verb)} ${role}.`
      : `${englishRunningVerb(verb)} ${role}.`
    : status === "done"
    ? `已${joinZhVerbObject(verb, role)}。`
    : `正在${joinZhVerbObject(verb, role)}。`;

  return normalizeProgressNarration({
    phase: progressPhase,
    title: titleForTool({ toolName: input.toolName, phase: toolPhase, progressPhase, role, language }),
    why: buildWhy({ ...input, phase: toolPhase, progressPhase, language, role }),
    action,
    evidence: buildEvidence({ phase: toolPhase, progressPhase, status, language, role, result: input.result, noOp: input.noOp }),
    next: buildNext({ phase: toolPhase, progressPhase, status, language }),
    targets: [compactToolPresentationTarget(target, input.toolName, language)].filter(Boolean),
    tool: String(input.toolName || "").trim(),
    target,
    canonicalTarget: target,
    status,
    source: input.source || "runtime",
    evidenceExcerpt: input.evidenceExcerpt || (input.result ? compactEvidenceExcerpt(input.result) : ""),
    observedFact: input.observedFact || (status === "done"
      ? summarizeToolObservation({
          toolName: input.toolName,
          target,
          result: input.result || "",
          language,
          noOp: input.noOp,
        })
      : compactContextSnippet(String(input.previousObservation || input.currentHypothesis || ""), 180)),
    hypothesisStatus: resolveHypothesisStatus({
      status,
      phase: toolPhase,
      progressPhase,
      explicit: input.hypothesisStatus,
    }),
    sourceToolCallIds: (input.sourceToolCallIds || []).map(String).filter(Boolean).slice(0, 12),
  });
}

export function buildToolCallsProgressNarration(input: {
  calls: Array<{ name: string; target?: string }>;
  language?: ToolPresentationLanguage;
  userGoal?: string;
  turnIntent?: ResolvedUserIntent | string;
  workflowMode?: "chat" | "edit" | "plan" | string;
  currentHypothesis?: string;
  previousObservation?: string;
  status?: ProgressNarrationStatus;
  source?: ProgressNarrationSource;
}): ProgressNarration | null {
  const calls = input.calls.filter((call) => call?.name).slice(0, 3);
  if (calls.length === 0) return null;
  const language = normalizeLanguage(input.language);
  if (calls.length === 1) {
    return buildToolProgressNarration({
      toolName: calls[0].name,
      target: calls[0].target,
      language,
      userGoal: input.userGoal,
      turnIntent: input.turnIntent,
      workflowMode: input.workflowMode,
      currentHypothesis: input.currentHypothesis,
      previousObservation: input.previousObservation,
      status: input.status || "running",
      source: input.source || "runtime",
    });
  }

  const first = buildToolProgressNarration({
    toolName: calls[0].name,
    target: calls[0].target,
    language,
    userGoal: input.userGoal,
    turnIntent: input.turnIntent,
    workflowMode: input.workflowMode,
    currentHypothesis: input.currentHypothesis,
    previousObservation: input.previousObservation,
    status: input.status || "running",
    source: input.source || "runtime",
  });
  const presentations = calls.map((call) =>
    formatToolPresentation({ toolName: call.name, target: call.target, language }).summary
  );
  const extra = input.calls.length - calls.length;
  const targets = calls
    .map((call) => compactToolPresentationTarget(call.target || "", call.name, language))
    .filter(Boolean);
  return normalizeProgressNarration({
    ...first,
    title: language === "zh"
      ? `准备执行 ${input.calls.length} 个相关步骤`
      : `Prepare ${input.calls.length} related steps`,
    action: language === "zh"
      ? `正在安排：${presentations.join("；")}${extra > 0 ? `，另有 ${extra} 个步骤` : ""}。`
      : `Preparing: ${presentations.join("; ")}${extra > 0 ? `, plus ${extra} more` : ""}.`,
    targets,
  });
}

function inferPlanGroundingDomain(calls: Array<{ name: string; target?: string }>): "scope" | "data" | "chart" | "theme" | "mixed" | "source" {
  const joined = calls.map((call) => `${call.name} ${call.target || ""}`).join(" ").toLowerCase();
  const hasData = /csv|import|upload|usecsvparser|dashboardstore|order|coursecleaner|dateutils|raworders|filteredorders|paidamount|completedtime/.test(joined);
  const hasChart = /overviewcards|coursebarchart|trendlinechart|monthlycomparechart|statuspiechart|timeheatmap|heatmap|echarts|buyeranalysis|components\/dashboard/.test(joined);
  const hasTheme = /theme|dark|深色|index\.css|app\.tsx|configprovider|antd|color-|background/.test(joined);
  const hasBroadScope = calls.some((call) => ["get_project_skeleton", "list_directory", "glob_search", "grep_search"].includes(call.name));
  const domains = [hasData, hasChart, hasTheme].filter(Boolean).length;
  if (domains > 1) return hasBroadScope ? "scope" : "mixed";
  if (hasData) return "data";
  if (hasChart) return "chart";
  if (hasTheme) return "theme";
  if (hasBroadScope) return "scope";
  return "source";
}

function planGroundingTitle(domain: ReturnType<typeof inferPlanGroundingDomain>, language: ToolPresentationLanguage): string {
  if (language === "en") {
    if (domain === "data") return "Validate CSV to dashboard data flow";
    if (domain === "chart") return "Validate chart rendering path";
    if (domain === "theme") return "Validate dark-theme path";
    if (domain === "mixed") return "Validate intersecting evidence";
    if (domain === "scope") return "Locate data and UI entry points";
    return "Read targeted planning evidence";
  }
  if (domain === "data") return "验证 CSV 到面板的数据链路";
  if (domain === "chart") return "验证图表渲染链路";
  if (domain === "theme") return "验证深色主题链路";
  if (domain === "mixed") return "验证数据、图表与主题交界";
  if (domain === "scope") return "定位数据与界面入口";
  return "读取计划所需证据";
}

function planGroundingObject(domain: ReturnType<typeof inferPlanGroundingDomain>, language: ToolPresentationLanguage): string {
  if (language === "en") {
    if (domain === "data") return "the CSV parsing, store, and aggregation path";
    if (domain === "chart") return "the chart components and data props";
    if (domain === "theme") return "the theme variables and component styling path";
    if (domain === "mixed") return "the boundary between data, chart rendering, and theme styling";
    if (domain === "scope") return "the concrete files that match the visible symptoms";
    return "the targeted implementation evidence";
  }
  if (domain === "data") return "CSV 解析、Store 写入和聚合计算";
  if (domain === "chart") return "图表组件和数据入参";
  if (domain === "theme") return "主题变量与组件样式覆盖";
  if (domain === "mixed") return "数据、图表渲染和主题样式的交界处";
  if (domain === "scope") return "与可见现象对应的具体入口文件";
  return "当前实现证据";
}

export function buildPlanReadOnlyProgressNarration(input: {
  calls: Array<{ name: string; target?: string }>;
  language?: ToolPresentationLanguage;
  userGoal?: string;
  status?: ProgressNarrationStatus;
  source?: ProgressNarrationSource;
  userContext?: {
    imageParts?: number;
    mentionedFilePaths?: string[];
    attachedFilePaths?: string[];
  };
}): ProgressNarration | null {
  const calls = input.calls.filter((call) => call?.name).slice(0, 3);
  if (calls.length === 0) return null;
  const language = normalizeLanguage(input.language);
  const domain = inferPlanGroundingDomain(calls);
  const presentations = calls.map((call) =>
    formatToolPresentation({ toolName: call.name, target: call.target, language }).summary
  );
  const extra = Math.max(0, input.calls.length - calls.length);
  const targets = calls
    .map((call) => compactToolPresentationTarget(call.target || "", call.name, language))
    .filter(Boolean);
  const imageParts = Math.max(0, Number(input.userContext?.imageParts || 0));
  const mentioned = input.userContext?.mentionedFilePaths?.length || 0;
  const attached = input.userContext?.attachedFilePaths?.length || 0;
  const groundedObject = planGroundingObject(domain, language);
  const title = planGroundingTitle(domain, language);
  const status = input.status || "running";
  const hasProvidedContext = imageParts > 0 || mentioned > 0 || attached > 0;
  const contextWhy = language === "en"
    ? hasProvidedContext
      ? `Use the provided visual/file evidence as the starting point, then verify ${groundedObject} before drafting plan.md.`
      : `Verify ${groundedObject} before drafting plan.md, so the plan is based on code evidence rather than guesses.`
    : hasProvidedContext
      ? `先以用户给出的图片/文件证据为起点，再核对${groundedObject}，避免 plan.md 变成猜测。`
      : `先核对${groundedObject}，让 plan.md 基于代码证据而不是猜测。`;
  const action = language === "en"
    ? `Checking: ${presentations.join("; ")}${extra > 0 ? `, plus ${extra} more` : ""}.`
    : `正在核对：${presentations.join("；")}${extra > 0 ? `，另有 ${extra} 个动作` : ""}。`;
  return normalizeProgressNarration({
    phase: domain === "scope" ? "understanding" : "investigating",
    title,
    why: contextWhy,
    action,
    evidence: "",
    next: "",
    targets,
    status,
    source: input.source || "runtime",
    observedFact: hasProvidedContext
      ? language === "en"
        ? "Provided screenshots/files are treated as primary evidence for this planning turn."
        : "本轮图片/文件上下文已作为计划的一等证据。"
      : "",
    hypothesisStatus: status === "done" ? "confirmed" : "unverified",
  });
}

export function normalizeProgressNarration(progress: ProgressNarration): ProgressNarration {
  const phase: ProgressNarrationPhase = [
    "understanding",
    "investigating",
    "editing",
    "verifying",
    "blocked",
    "summarizing",
  ].includes(progress.phase)
    ? progress.phase
    : "investigating";
  const status: ProgressNarrationStatus = progress.status === "done" || progress.status === "failed" ? progress.status : "running";
  const source: ProgressNarrationSource = progress.source === "model" || progress.source === "tool_result" ? progress.source : "runtime";
  const tool = String(progress.tool || "").trim();
  const canonicalTarget = String(progress.canonicalTarget || progress.target || "").trim();
  return {
    phase,
    title: compactLine(progress.title, 120),
    why: compactMarkdownSnippet(progress.why, 240),
    action: compactMarkdownSnippet(progress.action, 220),
    evidence: compactLine(progress.evidence, 220),
    next: compactLine(progress.next, 220),
    targets: Array.from(new Set((progress.targets || []).map((target) => compactLine(target, 80)).filter(Boolean))).slice(0, 6),
    ...(tool ? { tool } : {}),
    ...(canonicalTarget ? { target: canonicalTarget, canonicalTarget } : {}),
    status,
    source,
    evidenceExcerpt: compactMarkdownSnippet(progress.evidenceExcerpt || "", 220),
    observedFact: compactMarkdownSnippet(progress.observedFact || "", 220),
    hypothesisStatus: progress.hypothesisStatus === "confirmed" || progress.hypothesisStatus === "blocked"
      ? progress.hypothesisStatus
      : "unverified",
    sourceToolCallIds: Array.from(new Set((progress.sourceToolCallIds || []).map((id) => String(id).trim()).filter(Boolean))).slice(0, 12),
  };
}

export function progressNarrationToText(progress: ProgressNarration, language: ToolPresentationLanguage = "zh"): string {
  const normalized = normalizeProgressNarration(progress);
  const lines = [
    normalized.action,
    normalized.observedFact,
    normalized.evidenceExcerpt,
    normalized.why,
    normalized.status === "running" ? "" : normalized.evidence,
    normalized.status === "failed" ? normalized.next : "",
  ].filter((line): line is string => typeof line === "string" && line.trim().length > 0);
  const distinctLines: string[] = [];
  for (const line of lines) {
    const normalizedLine = compactMarkdownSnippet(line, 240);
    if (!normalizedLine) continue;
    const key = normalizedLine.replace(/\s+/g, " ").toLowerCase();
    if (distinctLines.some((existing) => {
      const existingKey = existing.replace(/\s+/g, " ").toLowerCase();
      return existingKey.includes(key) || key.includes(existingKey);
    })) {
      continue;
    }
    distinctLines.push(normalizedLine);
  }
  return compactMarkdownSnippet(distinctLines.join(language === "en" ? " " : " "), 420);
}

export function summarizeToolObservation(input: {
  toolName: string;
  target?: string;
  result?: string;
  language?: ToolPresentationLanguage;
  noOp?: boolean;
}): string {
  const language = normalizeLanguage(input.language);
  const result = String(input.result || "");
  const role = deriveToolTargetRole({
    toolName: input.toolName,
    target: input.target,
    language,
  });
  const lower = result.toLowerCase();
  const hasHiddenProcess = /hiddenprocess/i.test(result);
  const exitZero = /(?:exitCode|exit_code|code)["':\s]+0\b/i.test(result) || /\bexit(?:ed)?\s+(?:with\s+)?0\b/i.test(lower);
  const failed = /\b(?:error|failed|failure|timed out|exitCode["':\s]+[1-9]|exit_code["':\s]+[1-9])\b/i.test(result);

  if (language === "en") {
    if (input.noOp) return "No file change was needed because the target already matched the requested content.";
    if (hasHiddenProcess) return `Confirmed ${role} contains hiddenProcess-related visibility logic.`;
    if (input.toolName === "replace_in_file" || input.toolName === "write_file" || input.toolName === "apply_patch") return `Recorded the file change for ${role}; the diff is available as evidence.`;
    if (input.toolName === "run_command" || input.toolName === "execute_command") {
      if (exitZero && !failed) return `Verification command for ${role} exited successfully.`;
      if (failed) return `Command output for ${role} contains a failure signal that needs follow-up.`;
      return `Command output for ${role} was captured for the next decision.`;
    }
    if (input.toolName === "browser_evaluate") {
      if (/"ok"\s*:\s*true/i.test(result) && !failed) return `Browser validation for ${role} passed.`;
      if (failed || /"ok"\s*:\s*false/i.test(result)) return `Browser validation for ${role} reported a failure that needs follow-up.`;
      return `Browser validation output for ${role} was captured for the next decision.`;
    }
    if (input.toolName === "grep_search" || input.toolName === "glob_search" || input.toolName.startsWith("repo_map_")) return `Search results narrowed the relevant evidence around ${role}.`;
    return `Read ${role} and captured the relevant context.`;
  }

  if (input.noOp) return "目标内容已经匹配，本次没有产生文件改动。";
  if (hasHiddenProcess) return `已确认 ${role} 包含 hiddenProcess 相关可见性逻辑。`;
  if (input.toolName === "replace_in_file" || input.toolName === "write_file" || input.toolName === "apply_patch") return `已记录 ${role} 的文件改动，diff 可作为证据。`;
  if (input.toolName === "run_command" || input.toolName === "execute_command") {
    if (exitZero && !failed) return `${role}已成功退出，可作为验证通过证据。`;
    if (failed) return `${role}输出里包含失败信号，需要继续处理。`;
    return `已记录${role}的命令输出，用于判断下一步。`;
  }
  if (input.toolName === "browser_evaluate") {
    if (/"ok"\s*:\s*true/i.test(result) && !failed) return `${role}的浏览器验证已通过。`;
    if (failed || /"ok"\s*:\s*false/i.test(result)) return `${role}的浏览器验证返回失败信号，需要继续处理。`;
    return `已记录${role}的浏览器验证结果，用于判断下一步。`;
  }
  if (input.toolName === "grep_search" || input.toolName === "glob_search" || input.toolName.startsWith("repo_map_")) return `搜索结果已收窄 ${role} 的相关证据。`;
  return `已读取 ${role}，捕获了后续判断所需上下文。`;
}
