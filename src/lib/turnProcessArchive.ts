import {
  compactToolPresentationTarget,
  deriveToolIntentSummary,
  deriveToolPhase,
  type ToolPresentationLanguage,
} from "./toolPresentation";
import type { ProgressNarrationPhase } from "./progressNarration";
import { normalizeTurnRuntimePhase, type TurnRuntimePhase } from "./turnPhase";
import { deriveThoughtDisplay } from "./thoughtDisplay";

export type TurnArchiveStepKind = "thinking" | "discover" | "inspect" | "edit" | "command" | "verify" | "blocked" | "message";
export type TurnArchiveStepStatus = "running" | "done" | "failed" | "rejected";

export interface TurnArchiveStep {
  id: string;
  kind: TurnArchiveStepKind;
  status: TurnArchiveStepStatus;
  intent: string;
  why: string;
  action: string;
  result: string;
  next: string;
  note: string;
  summary: string;
  phase?: TurnRuntimePhase;
  targets: string[];
  items: any[];
  activity?: ActivityCell;
  expandedByDefault: boolean;
  sourceIndex: number;
  sourceEndIndex: number;
}

export type ActivityCellKind =
  | "exploring"
  | "edit"
  | "command"
  | "browser"
  | "plan"
  | "approval"
  | "blocked"
  | "message"
  | "thinking";

export interface ActivityMetrics {
  tools: number;
  filesRead: number;
  directoriesListed: number;
  searches: number;
  outlinesRead: number;
  documentsRead: number;
  tablesAnalyzed: number;
  filesCreated: number;
  filesEdited: number;
  commandsRun: number;
  browserValidations: number;
  terminalReads: number;
  blocked: number;
  failed: number;
  cached: number;
}

export interface ActivityCell {
  kind: ActivityCellKind;
  status: TurnArchiveStepStatus;
  purposeKey: string;
  label: string;
  title: string;
  summary: string;
  targets: string[];
  metrics: ActivityMetrics;
  items: any[];
  latestEvidence: string;
  recoveryHint: string;
}

export interface TurnProcessArchiveCounts {
  discover: number;
  inspect: number;
  edit: number;
  command: number;
  verify: number;
  blocked: number;
  failed: number;
  rejected: number;
  message: number;
  thought: number;
  table: number;
}

export interface TurnProcessArchiveModel {
  blocks: any[];
  steps: TurnArchiveStep[];
  counts: TurnProcessArchiveCounts;
  totalCount: number;
  stepCount: number;
  summaryText: string;
  currentJudgment: string;
  previewTargets: string[];
}

function normalizeLanguage(language?: ToolPresentationLanguage): ToolPresentationLanguage {
  return language === "en" ? "en" : "zh";
}

function isToolBlock(block: any): boolean {
  return block?.type === "tool";
}

function isThoughtBlock(block: any): boolean {
  return block?.type === "thought" && String(block.content || "").trim().length > 0;
}

function isProgressBlock(block: any): boolean {
  return block?.type === "progress";
}

function getLatestThoughtBlock(blocks: any[]): any | null {
  return [...blocks].reverse().find(isThoughtBlock) || null;
}

function isFinalConclusionBlock(block: any, finalVisibleAgentIndex: number, blockIndex: number): boolean {
  return block?.type === "agent" && blockIndex === finalVisibleAgentIndex;
}

function isProcessArchiveCandidate(block: any, finalVisibleAgentIndex: number, blockIndex: number): boolean {
  if (!block || block.type === "user") return false;
  if (isFinalConclusionBlock(block, finalVisibleAgentIndex, blockIndex)) return false;
  if (block.type === "system") {
    return block.variant !== "context_compression" && block.variant !== "plan_execution_checkpoint";
  }
  return block.type === "tool" || block.type === "progress" || block.type === "thought" || block.type === "jobList" || block.type === "agent" || block.type === "system";
}

function isLiveProcessCandidate(block: any): boolean {
  if (!block || block.type === "user" || block.type === "thought") return false;
  if (block.type === "agent") return block.hiddenProcess === true;
  if (block.type === "progress") return true;
  if (block.type === "system") {
    return block.variant !== "context_compression" && block.variant !== "plan_execution_checkpoint";
  }
  return block.type === "tool" || block.type === "jobList" || block.type === "system";
}

function mapToolStatus(block: any): TurnArchiveStepStatus {
  const status = String(block?.toolStatus || block?.status || "").toLowerCase();
  if (status === "failed" || status === "error") return "failed";
  if (status === "rejected") return "rejected";
  if (status === "running" || status === "pending" || status === "pending_review") return "running";
  return "done";
}

function isContextPhase(kind: TurnArchiveStepKind): boolean {
  return kind === "discover" || kind === "inspect";
}

function getToolStepKind(block: any): TurnArchiveStepKind {
  const phase = deriveToolPhase({
    toolName: String(block?.toolName || ""),
    target: String(block?.target || ""),
    status: String(block?.status || ""),
    toolStatus: String(block?.toolStatus || ""),
  });
  if (phase === "blocked") return "blocked";
  return phase as TurnArchiveStepKind;
}

function getProgressStepKind(phase: ProgressNarrationPhase | string): TurnArchiveStepKind {
  if (phase === "blocked") return "blocked";
  if (phase === "editing") return "edit";
  if (phase === "verifying") return "verify";
  if (phase === "investigating") return "inspect";
  if (phase === "understanding" || phase === "summarizing") return "message";
  return "message";
}

function mapProgressStatus(block: any): TurnArchiveStepStatus {
  const status = String(block?.status || "").toLowerCase();
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "done";
}

function compactTarget(block: any, language: ToolPresentationLanguage): string {
  if (isProgressBlock(block)) {
    const targets = Array.isArray(block.targets) ? block.targets : [];
    return String(targets[0] || block.target || "").trim();
  }
  if (!isToolBlock(block)) return "";
  return compactToolPresentationTarget(
    String(block.target || ""),
    String(block.toolName || ""),
    language,
  );
}

function uniqueTargets(blocks: any[], language: ToolPresentationLanguage): string[] {
  const targets: string[] = [];
  for (const block of blocks) {
    const target = compactTarget(block, language);
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

function firstMeaningfulLine(text: string): string {
  return String(text || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .find(Boolean) || "";
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

const PROCESS_NOTE_TARGET_RE = /`?(?:(?:\.{1,2}\/|\/)?(?:[\w@()[\]. -]+[\\/])+)?[\w@()[\]. -]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|sass|html?|mdx?|json|ya?ml|toml|rs|lock|svg|png|jpe?g|gif|webp|ico|icns)`?/gi;

function stripProcessNoteTargetNoise(text: string): string {
  return String(text || "")
    .replace(PROCESS_NOTE_TARGET_RE, "<target>")
    .replace(/`[^`]{1,120}`/g, (match) => {
      return /[\\/]|\.tsx?|\.jsx?|\.css|\.html?|\.mdx?|\.json|\.ya?ml|\.toml|\.rs|npm|node|cargo|npx|pnpm|bun|yarn/i.test(match)
        ? "`<target>`"
        : match;
    });
}

function normalizeProcessNoteForCompare(text: string): string {
  return stripProcessNoteTargetNoise(text)
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:、"'“”‘’`*_~\-\s]+/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function processNotesOverlap(left: string, right: string): boolean {
  const a = normalizeProcessNoteForCompare(left);
  const b = normalizeProcessNoteForCompare(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 14 && b.length >= 14 && (a.includes(b) || b.includes(a));
}

function isLowValueProcessNote(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const normalizedWithoutTargets = stripProcessNoteTargetNoise(normalized).replace(/<target>/g, "目标文件");
  if (!normalized) return true;
  if (/^我会执行下一步工具动作[:：]/.test(normalized)) return true;
  if (/^I will run the next tool action:/i.test(normalized)) return true;
  if (/^(?:我(?:会|将|要|需要)?\s*)?(?:继续|先|再)?\s*(?:按(?:照)?|根据)?(?:同一)?(?:方案|计划|策略)?\s*(?:修改|编辑|更新|调整|处理|应用|落地)(?:目标|相关|当前|这些|上述|对应|项目)?(?:文件|代码|样式|内容|改动)?[。.!！]*$/i.test(normalizedWithoutTargets)) return true;
  if (/^(?:I(?:'ll| will| need to)?\s*)?(?:continue|first|next)?\s*(?:apply|make|perform|do|edit|update|change|modify)(?:\s+the)?(?:\s+planned|\s+target|\s+related|\s+current)?(?:\s+file|\s+files|\s+change|\s+changes|\s+edit|\s+edits)?\.?$/i.test(normalizedWithoutTargets)) return true;
  if (/^(?:让我|我(?:会|将|要|需要|继续|正在)|接下来|现在)?\s*(?:继续|再|先)?\s*(?:读取|检查|查看|分析|梳理|确认)(?:(?:剩余|更多|相关|关键|必要)\s*)*(?:的)?(?:文件|内容|上下文|实现|代码)?[。.!！]*$/i.test(normalized)) return true;
  if (/^(?:let me|i(?:'ll| will| need to| am going to)?|next)?\s*(?:continue|keep|first)?\s*(?:read|check|inspect|look at|analyze)\s+(?:the\s+)?(?:remaining|more|relevant|key)?\s*(?:files?|content|context|implementation|code)\.?$/i.test(normalized)) return true;
  if (/等待(?:可见回复|模型|下一步动作|工具结果)|waiting for (?:the )?(?:model|next step|tool result)/i.test(normalized)) return true;
  return false;
}

function extractReasoningNoteFromText(
  text: string,
  language: ToolPresentationLanguage,
  maxLines = 3,
): string {
  const display = deriveThoughtDisplay(String(text || ""), {
    language,
    mode: "latest",
    density: "adaptive",
    maxSummaryLines: maxLines,
  });
  const usefulLines = display.summaryLines
    .map((line) => line.trim())
    .filter((line) => line && !isLowValueProcessNote(line));
  if (usefulLines.length === 0) return "";
  return compactLine(usefulLines.join(language === "zh" ? " " : " "), 320);
}

function isReasoningSourceBlock(block: any, includeThoughts: boolean): boolean {
  if (!block) return false;
  if (block.type === "thought") return includeThoughts;
  if (block.type === "agent") return block.hiddenProcess === true && String(block.content || "").trim().length > 0;
  return false;
}

function findNearestReasoningNote(input: {
  sourceBlocks: any[];
  beforeIndex: number;
  kind: TurnArchiveStepKind;
  language: ToolPresentationLanguage;
  includeThoughts: boolean;
}): string {
  const maxLookback = 10;
  for (let index = Math.min(input.beforeIndex - 1, input.sourceBlocks.length - 1); index >= 0 && input.beforeIndex - index <= maxLookback; index -= 1) {
    const block = input.sourceBlocks[index];
    if (!isReasoningSourceBlock(block, input.includeThoughts)) continue;
    const note = extractReasoningNoteFromText(String(block.content || ""), input.language);
    if (note && noteMatchesStepKind(note, input.kind)) return note;
  }
  return "";
}

function noteMatchesStepKind(note: string, kind: TurnArchiveStepKind): boolean {
  const text = String(note || "").toLowerCase();
  if (!text) return false;
  if (kind === "message" || kind === "thinking" || kind === "blocked") return true;
  if (kind === "discover" || kind === "inspect") {
    return /定位|搜索|读取|检查|查看|确认|审计|日志|上下文|范围|实现|文件|代码|look|read|inspect|check|search|scope|context|log|implementation|file/.test(text) &&
      !/最终回复|整理验证结果|完成实现|final response|validation result/.test(text);
  }
  if (kind === "edit") {
    return /修改|修复|调整|实现|接入|补充|落到|改成|rewrite|change|fix|edit|implement|wire|update/.test(text);
  }
  if (kind === "verify") {
    return /验证|测试|回归|构建|build|test|verify|regression|check result/.test(text) &&
      !/准备验证|整理验证结果|prepare.*validat|organize.*validat/.test(text);
  }
  if (kind === "command") {
    return /命令|运行|执行|终端|command|run|terminal|shell/.test(text);
  }
  return true;
}

function getBlockResultLine(block: any): string {
  if (isProgressBlock(block)) return firstMeaningfulLine(String(block.evidence || block.action || block.why || block.title || ""));
  return firstMeaningfulLine(String(block?.observationSummary || block?.message || block?.summary || block?.resultPreview || block?.output || block?.content || ""));
}

function makeTargetSummary(targets: string[], language: ToolPresentationLanguage): string {
  const visible = targets.slice(0, 3).filter(Boolean);
  const hiddenCount = Math.max(0, targets.length - visible.length);
  const joined = visible.join(language === "zh" ? "、" : ", ");
  if (!joined) return "";
  return hiddenCount > 0 ? `${joined} +${hiddenCount}` : joined;
}

function countToolItems(step: Pick<TurnArchiveStep, "items">): number {
  return step.items.filter(isToolBlock).length;
}

function emptyActivityMetrics(): ActivityMetrics {
  return {
    tools: 0,
    filesRead: 0,
    directoriesListed: 0,
    searches: 0,
    outlinesRead: 0,
    documentsRead: 0,
    tablesAnalyzed: 0,
    filesCreated: 0,
    filesEdited: 0,
    commandsRun: 0,
    browserValidations: 0,
    terminalReads: 0,
    blocked: 0,
    failed: 0,
    cached: 0,
  };
}

const EXPLORING_TOOL_NAMES = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "get_file_outline",
]);

const TERMINAL_READ_TOOL_NAMES = new Set([
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

function isExploringToolName(toolName: string): boolean {
  return EXPLORING_TOOL_NAMES.has(toolName);
}

function isActivityCachedResult(block: any): boolean {
  const text = [
    block?.message,
    block?.observationSummary,
    block?.evidence,
    block?.resultPreview,
    block?.content,
  ].map((value) => String(value || "")).join("\n");
  return /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped/i.test(text);
}

function classifyToolActivityKind(toolName: string, status: TurnArchiveStepStatus): ActivityCellKind {
  if (status === "failed" || status === "rejected") {
    return isExploringToolName(toolName) ? "exploring" : "blocked";
  }
  if (isExploringToolName(toolName)) return "exploring";
  if (toolName === "browser_evaluate") return "browser";
  if (toolName === "replace_in_file" || toolName === "write_file") return "edit";
  if (toolName === "execute_command" || toolName === "run_command" || toolName === "send_pty_input" || TERMINAL_READ_TOOL_NAMES.has(toolName)) {
    return "command";
  }
  return "message";
}

function classifyBlockActivityKind(block: any): ActivityCellKind {
  if (isToolBlock(block)) {
    const status = mapToolStatus(block);
    return classifyToolActivityKind(String(block.toolName || ""), status);
  }
  if (isProgressBlock(block)) {
    const toolName = String(block.toolName || "");
    if (toolName) return classifyToolActivityKind(toolName, mapProgressStatus(block));
    const phase = String(block.phase || "");
    if (phase === "editing") return "edit";
    if (phase === "verifying") return "command";
    if (phase === "blocked") return "blocked";
    return phase === "investigating" ? "exploring" : "message";
  }
  if (block?.type === "thought") return "thinking";
  if (block?.type === "system") {
    const variant = String(block.variant || "");
    if (variant === "plan_execution_checkpoint" || variant === "execution_checkpoint") return "blocked";
    if (variant === "plan_quality_gate") return "plan";
    if (variant === "plan_execution_progress") return "message";
  }
  if (block?.type === "agent") {
    const content = String(block.content || "");
    if (/\[PROPOSAL START\]|#\s*Proposed Plan|<proposed_plan>|<plan[\s>]/i.test(content)) return "plan";
    if (Array.isArray(block.options) && block.options.length > 0) return "approval";
  }
  return "message";
}

function addActivityMetricsFromBlock(metrics: ActivityMetrics, block: any): void {
  if (!isToolBlock(block)) return;
  const toolName = String(block.toolName || "");
  metrics.tools += 1;
  const status = mapToolStatus(block);
  if (status === "failed") metrics.failed += 1;
  if (status === "rejected" || status === "failed" || getToolStepKind(block) === "blocked") metrics.blocked += 1;
  if (isActivityCachedResult(block)) metrics.cached += 1;

  if (toolName === "read_file") metrics.filesRead += 1;
  else if (toolName === "read_document") metrics.documentsRead += 1;
  else if (toolName === "get_file_outline") metrics.outlinesRead += 1;
  else if (toolName === "list_directory" || toolName === "get_project_skeleton" || toolName === "index_workspace_documents") metrics.directoriesListed += 1;
  else if (toolName === "glob_search" || toolName === "grep_search") metrics.searches += 1;
  else if (toolName === "analyze_tabular_document" || toolName === "query_tabular_document") metrics.tablesAnalyzed += 1;
  else if (toolName === "browser_evaluate") metrics.browserValidations += 1;
  else if (TERMINAL_READ_TOOL_NAMES.has(toolName)) metrics.terminalReads += 1;
  else if (toolName === "execute_command" || toolName === "run_command" || toolName === "send_pty_input") metrics.commandsRun += 1;
  else if (toolName === "write_file" || toolName === "replace_in_file") {
    const diff = block.diff || {};
    const existed = typeof diff.existed === "boolean" ? diff.existed : String(diff.old || "").length > 0;
    if (toolName === "write_file" && !existed) metrics.filesCreated += 1;
    else metrics.filesEdited += 1;
  }
}

function addActivityMetrics(left: ActivityMetrics, right: ActivityMetrics): ActivityMetrics {
  const next = emptyActivityMetrics();
  for (const key of Object.keys(next) as Array<keyof ActivityMetrics>) {
    next[key] = (left[key] || 0) + (right[key] || 0);
  }
  return next;
}

function mergeActivityStatus(left: TurnArchiveStepStatus, right: TurnArchiveStepStatus): TurnArchiveStepStatus {
  if (left === "failed" || right === "failed") return "failed";
  if (left === "rejected" || right === "rejected") return "rejected";
  if (left === "running" || right === "running") return "running";
  return "done";
}

function activityPurposeKey(kind: ActivityCellKind, block: any, language: ToolPresentationLanguage): string {
  if (kind === "exploring") return "exploring";
  if (kind === "browser") return "browser";
  if (kind === "edit") return "edit";
  if (kind === "command") {
    const phase = normalizeTurnRuntimePhase(block?.turnPhase, language);
    return `command:${phase?.domain || "general"}`;
  }
  if (kind === "plan") return "plan";
  if (kind === "approval") return "approval";
  if (kind === "blocked") return "blocked";
  if (kind === "thinking") return "thinking";
  return "message";
}

function countText(count: number, zhUnit: string, enSingular: string, enPlural: string, language: ToolPresentationLanguage): string {
  if (count <= 0) return "";
  return language === "zh"
    ? `${count} ${zhUnit}`
    : `${count} ${count === 1 ? enSingular : enPlural}`;
}

function makeActivityMetricParts(metrics: ActivityMetrics, language: ToolPresentationLanguage): string[] {
  const parts: string[] = [];
  const readCount = metrics.filesRead + metrics.documentsRead + metrics.outlinesRead + metrics.tablesAnalyzed;
  if (readCount > 0) parts.push(countText(readCount, language === "zh" ? "个文件" : "file", "file", "files", language));
  if (metrics.directoriesListed > 0) parts.push(countText(metrics.directoriesListed, language === "zh" ? "个目录" : "directory", "directory", "directories", language));
  if (metrics.searches > 0) parts.push(countText(metrics.searches, language === "zh" ? "次搜索" : "search", "search", "searches", language));
  if (metrics.filesCreated > 0) parts.push(language === "zh" ? `创建 ${metrics.filesCreated} 个文件` : countText(metrics.filesCreated, "", "created file", "created files", language));
  if (metrics.filesEdited > 0) parts.push(language === "zh" ? `编辑 ${metrics.filesEdited} 个文件` : countText(metrics.filesEdited, "", "edited file", "edited files", language));
  if (metrics.commandsRun > 0) parts.push(countText(metrics.commandsRun, language === "zh" ? "条命令" : "command", "command", "commands", language));
  if (metrics.browserValidations > 0) parts.push(countText(metrics.browserValidations, language === "zh" ? "次浏览器验证" : "browser validation", "browser validation", "browser validations", language));
  if (metrics.terminalReads > 0) parts.push(countText(metrics.terminalReads, language === "zh" ? "次终端读取" : "terminal read", "terminal read", "terminal reads", language));
  if (metrics.cached > 0) parts.push(language === "zh" ? `${metrics.cached} 次复用缓存` : `${metrics.cached} cached reuse${metrics.cached === 1 ? "" : "s"}`);
  return parts.filter(Boolean);
}

function activityVerb(kind: ActivityCellKind, status: TurnArchiveStepStatus, language: ToolPresentationLanguage): string {
  const running = status === "running";
  const failed = status === "failed" || status === "rejected";
  if (language === "en") {
    if (kind === "exploring") return failed ? "Exploration blocked" : running ? "Exploring" : "Explored";
    if (kind === "edit") return failed ? "Edit blocked" : running ? "Editing" : "Edited";
    if (kind === "browser") return failed ? "Browser validation blocked" : running ? "Validating in browser" : "Validated in browser";
    if (kind === "command") return failed ? "Command blocked" : running ? "Running command" : "Ran";
    if (kind === "plan") return running ? "Preparing plan" : "Proposed plan";
    if (kind === "approval") return "Awaiting approval";
    if (kind === "blocked") return "Paused";
    if (kind === "thinking") return "Thinking";
    return running ? "Working" : "Recorded";
  }
  if (kind === "exploring") return failed ? "探索受阻" : running ? "正在探索" : "已探索";
  if (kind === "edit") return failed ? "编辑受阻" : running ? "正在编辑" : "已编辑";
  if (kind === "browser") return failed ? "浏览器验证受阻" : running ? "正在浏览器验证" : "已执行浏览器验证";
  if (kind === "command") return failed ? "命令受阻" : running ? "正在运行命令" : "已运行";
  if (kind === "plan") return running ? "正在整理计划" : "已生成计划";
  if (kind === "approval") return "等待审批";
  if (kind === "blocked") return "已暂停";
  if (kind === "thinking") return "正在思考";
  return running ? "正在处理" : "已记录";
}

function makeActivitySummary(activity: Pick<ActivityCell, "kind" | "targets" | "metrics">, language: ToolPresentationLanguage): string {
  const metricParts = makeActivityMetricParts(activity.metrics, language);
  const targetSummary = makeTargetSummary(activity.targets, language);
  if (activity.kind === "exploring" && targetSummary) {
    const prefix = language === "zh" ? "目标：" : "Targets: ";
    return compactLine(`${metricParts.join(language === "zh" ? "，" : ", ")}${metricParts.length ? " · " : ""}${prefix}${targetSummary}`, 220);
  }
  if (targetSummary && metricParts.length > 0) return compactLine(`${metricParts.join(language === "zh" ? "，" : ", ")} · ${targetSummary}`, 220);
  if (metricParts.length > 0) return metricParts.join(language === "zh" ? "，" : ", ");
  return targetSummary;
}

function makeActivityTitle(activity: Pick<ActivityCell, "kind" | "status" | "metrics">, language: ToolPresentationLanguage): string {
  const verb = activityVerb(activity.kind, activity.status, language);
  const metrics = activity.metrics;
  if (activity.kind === "exploring") {
    const count = metrics.filesRead + metrics.documentsRead + metrics.outlinesRead + metrics.tablesAnalyzed + metrics.directoriesListed + metrics.searches;
    return count > 0 ? `${verb} ${makeActivityMetricParts(metrics, language).join(language === "zh" ? "，" : ", ")}` : verb;
  }
  if (activity.kind === "edit") {
    if (language === "zh") {
      if (metrics.filesCreated > 0 && metrics.filesEdited > 0) return `已创建 ${metrics.filesCreated} 个文件，已编辑 ${metrics.filesEdited} 个文件`;
      if (metrics.filesCreated > 0) return `${activity.status === "running" ? "正在创建" : "已创建"} ${metrics.filesCreated} 个文件`;
      if (metrics.filesEdited > 0) return `${activity.status === "running" ? "正在编辑" : "已编辑"} ${metrics.filesEdited} 个文件`;
    }
    const count = metrics.filesCreated + metrics.filesEdited;
    if (count > 0) return `${verb} ${count} ${count === 1 ? "file" : "files"}`;
  }
  if (activity.kind === "command") {
    const count = metrics.commandsRun + metrics.terminalReads;
    if (count > 0) return language === "zh"
      ? `${activity.status === "running" ? "正在运行" : "已运行"} ${count} 条命令/终端操作`
      : `${verb} ${count} command${count === 1 ? "" : "s"}`;
  }
  if (activity.kind === "browser" && metrics.browserValidations > 0) {
    return language === "zh"
      ? `${activity.status === "running" ? "正在执行" : "已执行"} ${metrics.browserValidations} 次浏览器验证`
      : `${verb} ${metrics.browserValidations} browser validation${metrics.browserValidations === 1 ? "" : "s"}`;
  }
  return verb;
}

function buildActivityCellFromItems(
  items: any[],
  language: ToolPresentationLanguage,
  fallbackKind?: TurnArchiveStepKind,
): ActivityCell {
  const metrics = emptyActivityMetrics();
  for (const item of items) addActivityMetricsFromBlock(metrics, item);
  const firstKind = items.map(classifyBlockActivityKind).find((kind) => kind !== "message") ||
    (fallbackKind === "thinking" ? "thinking" : fallbackKind === "blocked" ? "blocked" : "message");
  const status = items.reduce<TurnArchiveStepStatus>((current, item) => {
    if (isToolBlock(item)) return mergeActivityStatus(current, mapToolStatus(item));
    if (isProgressBlock(item)) return mergeActivityStatus(current, mapProgressStatus(item));
    return current;
  }, "done");
  const targets = uniqueTargets(items, language);
  const latestEvidence = compactLine([...items].reverse().map(getBlockResultLine).find(Boolean) || "", 180);
  const recoveryHint = compactLine(
    [...items].reverse().map((item) => {
      if (item?.type === "system" && /暂停|paused|Recovery|重复|no progress/i.test(String(item.content || ""))) return String(item.content || "");
      return "";
    }).find(Boolean) || "",
    220,
  );
  const provisional: Pick<ActivityCell, "kind" | "status" | "metrics" | "targets"> = {
    kind: firstKind,
    status,
    metrics,
    targets,
  };
  const summary = makeActivitySummary(provisional, language);
  return {
    kind: firstKind,
    status,
    purposeKey: activityPurposeKey(firstKind, items.find(isToolBlock) || items[0] || {}, language),
    label: activityVerb(firstKind, status, language),
    title: makeActivityTitle(provisional, language),
    summary,
    targets,
    metrics,
    items,
    latestEvidence,
    recoveryHint,
  };
}

function mergeActivityCells(left: ActivityCell, right: ActivityCell, language: ToolPresentationLanguage): ActivityCell {
  const items = [...left.items, ...right.items];
  const metrics = addActivityMetrics(left.metrics, right.metrics);
  const targets = uniqueTargets(items, language);
  const status = mergeActivityStatus(left.status, right.status);
  const base: Pick<ActivityCell, "kind" | "status" | "metrics" | "targets"> = {
    kind: left.kind,
    status,
    metrics,
    targets,
  };
  return {
    ...left,
    status,
    targets,
    metrics,
    items,
    title: makeActivityTitle(base, language),
    summary: makeActivitySummary(base, language),
    latestEvidence: right.latestEvidence || left.latestEvidence,
    recoveryHint: right.recoveryHint || left.recoveryHint,
  };
}

function canMergeActivityCells(current: ActivityCell | null, next: ActivityCell): boolean {
  if (!current) return false;
  if (current.kind === "thinking" || next.kind === "thinking") return false;
  if (current.kind === "message" || next.kind === "message") return false;
  if (current.kind === "blocked" || next.kind === "blocked") return false;
  if (current.kind === "exploring" && next.kind === "exploring") return true;
  if (current.status === "failed" || current.status === "rejected") return false;
  return current.purposeKey === next.purposeKey && current.kind === next.kind;
}

export function buildCodexActivityGroups(
  blocks: any[],
  language: ToolPresentationLanguage = "zh",
): ActivityCell[] {
  const groups: ActivityCell[] = [];
  for (const block of blocks) {
    if (!block || block.type === "user") continue;
    const activity = buildActivityCellFromItems([block], normalizeLanguage(language));
    const current = groups[groups.length - 1] || null;
    if (canMergeActivityCells(current, activity)) {
      groups[groups.length - 1] = mergeActivityCells(current!, activity, normalizeLanguage(language));
    } else {
      groups.push(activity);
    }
  }
  return groups;
}

function defaultIntentForStep(kind: TurnArchiveStepKind, language: ToolPresentationLanguage): string {
  if (language === "en") {
    if (kind === "thinking") return "Summarize the current judgment before the next action.";
    if (kind === "discover" || kind === "inspect") return "Collect and confirm the relevant context before changing anything.";
    if (kind === "edit") return "Apply the planned file changes.";
    if (kind === "verify") return "Verify that the changes behave as expected.";
    if (kind === "command") return "Run the command and inspect the result.";
    if (kind === "blocked") return "Keep the blocked step visible so it can be recovered.";
    return "Keep the model note that led into this step.";
  }
  if (kind === "thinking") return "整理当前判断，再进入下一步动作。";
  if (kind === "discover" || kind === "inspect") return "收集并确认相关上下文，再决定修改范围。";
  if (kind === "edit") return "按方案实施文件修改。";
  if (kind === "verify") return "验证改动是否达到预期。";
  if (kind === "command") return "运行命令并查看结果。";
  if (kind === "blocked") return "保留受阻步骤，方便恢复处理。";
  return "保留模型对下一步的说明，便于追溯。";
}

function defaultNarrativeForStep(
  step: Pick<TurnArchiveStep, "kind" | "status" | "items" | "targets" | "summary">,
  language: ToolPresentationLanguage,
): Pick<TurnArchiveStep, "why" | "action" | "result" | "next"> {
  const targets = step.targets.length > 0
    ? step.targets.slice(0, 3).join(language === "zh" ? "、" : ", ")
    : language === "zh" ? "当前工作区" : "current workspace";
  const resultLine = compactLine(step.items.map(getBlockResultLine).find(Boolean) || step.summary || "", 150);
  const failed = step.status === "failed" || step.status === "rejected" || step.kind === "blocked";

  if (language === "en") {
    if (step.kind === "thinking") {
      return {
        why: "Keep the latest model judgment visible without stacking older thoughts.",
        action: "Summarized the newest useful reasoning step.",
        result: resultLine || "Latest thought summary is available.",
        next: "Use this judgment to guide the next operation.",
      };
    }
    if (step.kind === "discover") {
      return {
        why: "Narrow the task to relevant files and symbols before reading more.",
        action: `Searched or scanned ${targets}.`,
        result: resultLine || `Relevant targets were narrowed to ${targets}.`,
        next: "Read the smallest useful context next.",
      };
    }
    if (step.kind === "inspect") {
      return {
        why: "Confirm the current implementation before deciding the change.",
        action: `Read or inspected ${targets}.`,
        result: resultLine || `Context from ${targets} was captured for the turn.`,
        next: "Apply only the change supported by this context.",
      };
    }
    if (step.kind === "edit") {
      return {
        why: "Apply the approved change to the concrete project files.",
        action: `Edited ${targets}.`,
        result: step.summary || resultLine || "File changes were recorded with diff evidence.",
        next: "Verify the touched behavior.",
      };
    }
    if (step.kind === "verify") {
      return {
        why: "Check whether the implementation now satisfies the requested behavior.",
        action: `Ran verification for ${targets}.`,
        result: resultLine || step.summary || "Verification evidence was recorded.",
        next: failed ? "Fix the failure before claiming completion." : "Use the result as completion evidence when it matches the task.",
      };
    }
    if (step.kind === "command") {
      return {
        why: "Use command output as concrete feedback for the next step.",
        action: `Ran ${targets}.`,
        result: resultLine || step.summary || "Command output was recorded.",
        next: failed ? "Diagnose the failed command before retrying." : "Continue from the command result.",
      };
    }
    if (failed) {
      return {
        why: "Keep the blocked operation visible so recovery starts from the real failure.",
        action: `Attempted ${targets}.`,
        result: resultLine || "The operation did not complete successfully.",
        next: "Adjust the target, permission, or approach before retrying.",
      };
    }
    return {
      why: "Show the model's short rationale as its own transcript item.",
      action: "Recorded the model note before the next operation.",
      result: resultLine || "Model note was kept in the turn history.",
      next: "Keep tool operations separate from this explanation.",
    };
  }

  if (step.kind === "thinking") {
    return {
      why: "保留最新判断，避免旧思考在时间线里堆叠。",
      action: "提取最新一段有效思考摘要。",
      result: resultLine || "已生成最新思考摘要。",
      next: "用这段判断指导下一步操作。",
    };
  }
  if (step.kind === "discover") {
    return {
      why: "先把任务定位到相关文件或符号，减少无关读取。",
      action: `搜索或扫描了 ${targets}。`,
      result: resultLine || `已把范围收敛到 ${targets}。`,
      next: "下一步读取最小必要上下文。",
    };
  }
  if (step.kind === "inspect") {
    return {
      why: "在修改前确认当前实现，避免凭猜测改动。",
      action: `读取或检查了 ${targets}。`,
      result: resultLine || `已记录 ${targets} 的上下文。`,
      next: "只基于已确认的上下文实施修改。",
    };
  }
  if (step.kind === "edit") {
    return {
      why: "把已确认的方案落到具体项目文件。",
      action: `编辑了 ${targets}。`,
      result: step.summary || resultLine || "已记录文件 diff 证据。",
      next: "继续验证被影响的行为。",
    };
  }
  if (step.kind === "verify") {
    return {
      why: "确认改动是否真正满足任务，而不是只看文字总结。",
      action: `运行验证：${targets}。`,
      result: resultLine || step.summary || "已记录验证证据。",
      next: failed ? "先修复失败原因，再重新验证。" : "若证据匹配任务，可用于完成审计。",
    };
  }
  if (step.kind === "command") {
    return {
      why: "用命令输出作为下一步判断的真实反馈。",
      action: `执行了 ${targets}。`,
      result: resultLine || step.summary || "已记录命令输出。",
      next: failed ? "先诊断失败命令，再调整重试。" : "根据命令结果继续推进。",
    };
  }
  if (failed) {
    return {
      why: "保留受阻操作，恢复时从真实失败点继续。",
      action: `尝试处理 ${targets}。`,
      result: resultLine || "该操作没有成功完成。",
      next: "调整目标、权限或方案后再继续。",
    };
  }
  return {
    why: "把模型的简短判断作为独立历史项展示。",
    action: "记录了下一步操作前的模型说明。",
    result: resultLine || "模型说明已保留在本轮历史中。",
    next: "工具操作会作为单独步骤继续展示。",
  };
}

function makeNarrativeIntent(step: TurnArchiveStep, language: ToolPresentationLanguage): string {
  const note = String(step.note || "").trim();
  if (note && !isLowValueProcessNote(note)) {
    return compactLine(note, 320);
  }

  const targets = makeTargetSummary(step.targets, language);
  const toolCount = countToolItems(step);
  const failed = step.status === "failed" || step.status === "rejected" || step.kind === "blocked";
  if (language === "en") {
    if (step.kind === "edit" && toolCount > 1) {
      return compactLine(`Apply one edit strategy across ${toolCount} file changes${targets ? `: ${targets}` : ""}.`, 220);
    }
    if ((step.kind === "discover" || step.kind === "inspect") && toolCount > 1) {
      return compactLine(`Use one context-gathering pass across ${toolCount} operations${targets ? `: ${targets}` : ""}.`, 220);
    }
    if ((step.kind === "command" || step.kind === "verify") && toolCount > 1) {
      return compactLine(`Run ${toolCount} related ${step.kind === "verify" ? "verification" : "command"} steps${targets ? `: ${targets}` : ""}.`, 220);
    }
    if (step.kind === "discover") return compactLine(`Narrow the relevant scope${targets ? ` around ${targets}` : ""}.`, 180);
    if (step.kind === "inspect") return compactLine(`Check the necessary context${targets ? ` in ${targets}` : ""}.`, 180);
    if (step.kind === "edit") return compactLine(`Apply the focused change${targets ? ` in ${targets}` : ""}.`, 180);
    if (step.kind === "verify") return compactLine(`Verify the changed behavior${targets ? ` with ${targets}` : ""}.`, 180);
    if (step.kind === "command") return compactLine(`Run the command${targets ? `: ${targets}` : ""}.`, 180);
    if (failed) return compactLine(`This step is blocked${targets ? ` at ${targets}` : ""}; keep the evidence available.`, 180);
    return compactLine(step.summary || step.action || step.why || "Keep this process step available.", 180);
  }
  if (step.kind === "edit" && toolCount > 1) {
    return compactLine(`按同一修改策略完成 ${toolCount} 次文件修改${targets ? `：${targets}` : ""}。`, 220);
  }
  if ((step.kind === "discover" || step.kind === "inspect") && toolCount > 1) {
    return compactLine(`按同一上下文策略完成 ${toolCount} 次读取/搜索${targets ? `：${targets}` : ""}。`, 220);
  }
  if ((step.kind === "command" || step.kind === "verify") && toolCount > 1) {
    return compactLine(`连续执行 ${toolCount} 个相关${step.kind === "verify" ? "验证" : "命令"}步骤${targets ? `：${targets}` : ""}。`, 220);
  }
  if (step.kind === "discover") return compactLine(`收敛相关范围${targets ? `：${targets}` : ""}。`, 180);
  if (step.kind === "inspect") return compactLine(`核对必要上下文${targets ? `：${targets}` : ""}。`, 180);
  if (step.kind === "edit") return compactLine(`实施聚焦修改${targets ? `：${targets}` : ""}。`, 180);
  if (step.kind === "verify") return compactLine(`验证受影响行为${targets ? `：${targets}` : ""}。`, 180);
  if (step.kind === "command") return compactLine(`执行命令${targets ? `：${targets}` : ""}。`, 180);
  if (failed) return compactLine(`该步骤受阻${targets ? `：${targets}` : ""}，保留证据便于恢复。`, 180);
  return compactLine(step.summary || step.action || step.why || "保留过程步骤。", 180);
}

function resolveToolIntent(block: any, kind: TurnArchiveStepKind, language: ToolPresentationLanguage): string {
  const persisted = compactMarkdownSnippet(String(block?.intentSummary || ""), 260);
  if (persisted) return persisted;
  if (!isToolBlock(block)) return defaultIntentForStep(kind, language);
  return deriveToolIntentSummary({
    toolName: String(block.toolName || ""),
    target: String(block.target || ""),
    language,
    status: String(block.status || ""),
    toolStatus: String(block.toolStatus || ""),
  });
}

function makeSummaryForStep(step: TurnArchiveStep, language: ToolPresentationLanguage): string {
  const blocks = step.items;
  const targets = uniqueTargets(blocks, language);
  const hiddenCount = Math.max(0, targets.length - 3);
  const targetText = targets.slice(0, 3).join(language === "zh" ? "、" : ", ");
  const toolCount = blocks.filter(isToolBlock).length;
  const progressBlock = blocks.find(isProgressBlock);

  if (progressBlock) {
    const action = firstMeaningfulLine(String(progressBlock.action || ""));
    const evidence = firstMeaningfulLine(String(progressBlock.evidence || ""));
    const base = action || evidence || String(progressBlock.title || "");
    return compactLine(base, 180);
  }

  if (step.kind === "thinking") {
    const first = firstMeaningfulLine(String(blocks[0]?.content || ""));
    return language === "en" ? first || "Latest thought summary" : first || "最新一步思考摘要";
  }
  if (step.kind === "edit") {
    return language === "en"
      ? `${toolCount} file edit${toolCount > 1 ? "s" : ""}${targetText ? `: ${targetText}${hiddenCount ? ` +${hiddenCount}` : ""}` : ""}`
      : `${toolCount} 次文件修改${targetText ? `：${targetText}${hiddenCount ? ` +${hiddenCount}` : ""}` : ""}`;
  }
  if (step.kind === "verify" || step.kind === "command") {
    return targetText || (language === "en" ? `${toolCount} command operation${toolCount > 1 ? "s" : ""}` : `${toolCount} 次命令操作`);
  }
  if (step.kind === "blocked") {
    return targetText || (language === "en" ? "Blocked step" : "步骤受阻");
  }
  if (step.kind === "message") {
    return language === "en" ? "Model note before the next operation" : "下一步操作前的模型说明";
  }
  return language === "en"
    ? `${toolCount} context operation${toolCount > 1 ? "s" : ""}${targetText ? `: ${targetText}${hiddenCount ? ` +${hiddenCount}` : ""}` : ""}`
    : `${toolCount} 次上下文操作${targetText ? `：${targetText}${hiddenCount ? ` +${hiddenCount}` : ""}` : ""}`;
}

function canMergeSteps(current: TurnArchiveStep | null, next: TurnArchiveStep, mergeAdjacent: boolean): boolean {
  if (!mergeAdjacent) return false;
  if (!current) return false;
  if (current.phase || next.phase) return false;
  if (current.status !== next.status) return false;
  if (current.status === "failed" || current.status === "rejected") return false;
  if (isContextPhase(current.kind) && isContextPhase(next.kind)) return true;
  return current.kind === next.kind && current.kind !== "thinking" && current.kind !== "message" && current.kind !== "blocked";
}

function isToolStrategyStep(step: TurnArchiveStep): boolean {
  return step.kind !== "thinking" && step.kind !== "message" && step.kind !== "blocked";
}

function canMergeStrategyStep(current: TurnArchiveStep | null, next: TurnArchiveStep, pendingNote: string): boolean {
  if (!current) return false;
  if (!isToolStrategyStep(current) || !isToolStrategyStep(next)) return false;
  if (current.status !== next.status) return false;
  if (current.status === "failed" || current.status === "rejected") return false;
  const samePhase = (isContextPhase(current.kind) && isContextPhase(next.kind)) || current.kind === next.kind;
  if (!samePhase) return false;
  if (!pendingNote || !current.note || processNotesOverlap(current.note, pendingNote)) return true;
  return false;
}

function mergeStrategySteps(steps: TurnArchiveStep[], language: ToolPresentationLanguage): TurnArchiveStep[] {
  const result: TurnArchiveStep[] = [];
  let current: TurnArchiveStep | null = null;
  let pendingMessageItems: any[] = [];
  let pendingNote = "";

  const flushCurrent = () => {
    if (!current) return;
    current.targets = uniqueTargets(current.items, language);
    result.push(current);
    current = null;
  };

  const flushPendingMessage = () => {
    if (!pendingNote && pendingMessageItems.length === 0) return;
    const first = pendingMessageItems[0];
    result.push({
      id: `turn-archive-step-message-${first?.id ?? result.length}`,
      kind: "message",
      status: "done",
      intent: defaultIntentForStep("message", language),
      why: "",
      action: "",
      result: "",
      next: "",
      note: pendingNote,
      summary: "",
      targets: [],
      items: pendingMessageItems,
      expandedByDefault: false,
      sourceIndex: steps.length > 0 ? Math.min(...pendingMessageItems.map((item) => Number(item?.sourceIndex ?? 0))) : 0,
      sourceEndIndex: steps.length > 0 ? Math.max(...pendingMessageItems.map((item) => Number(item?.sourceIndex ?? 0))) : 0,
    });
    pendingMessageItems = [];
    pendingNote = "";
  };

  for (const step of steps) {
    if (step.kind === "thinking") {
      flushCurrent();
      flushPendingMessage();
      result.push(step);
      continue;
    }

    if (step.kind === "message") {
      const note = String(step.note || "").trim();
      if (!note || isLowValueProcessNote(note)) {
        pendingMessageItems.push(...step.items);
        continue;
      }
      if (current && current.note && !processNotesOverlap(current.note, note)) {
        flushCurrent();
      }
      pendingMessageItems.push(...step.items);
      if (!pendingNote || !processNotesOverlap(pendingNote, note)) {
        pendingNote = pendingNote ? `${pendingNote} ${note}` : note;
        pendingNote = compactLine(pendingNote, 360);
      }
      continue;
    }

    if (!isToolStrategyStep(step)) {
      flushCurrent();
      flushPendingMessage();
      result.push(step);
      continue;
    }

    if (!canMergeStrategyStep(current, step, pendingNote)) {
      flushCurrent();
    }

    if (!current) {
      current = {
        ...step,
        id: `turn-archive-step-${step.kind}-${step.id}`,
        note: pendingNote || step.note,
        items: [...pendingMessageItems, ...step.items],
        sourceIndex: pendingMessageItems.length > 0 ? Math.min(step.sourceIndex, ...pendingMessageItems.map((item) => Number(item?.sourceIndex ?? step.sourceIndex))) : step.sourceIndex,
        sourceEndIndex: step.sourceEndIndex,
      };
    } else {
      current.items.push(...pendingMessageItems, ...step.items);
      current.targets = uniqueTargets(current.items, language);
      current.expandedByDefault = current.expandedByDefault || step.expandedByDefault;
      current.sourceEndIndex = step.sourceEndIndex;
      if (!current.note && pendingNote) current.note = pendingNote;
    }
    pendingMessageItems = [];
    pendingNote = "";
  }

  flushCurrent();
  flushPendingMessage();
  return result;
}

const MAX_PHASE_TOOL_ITEMS = Number.MAX_SAFE_INTEGER;

function getPhaseKey(step: TurnArchiveStep): string {
  const phase = step.phase;
  if (!phase) return "";
  if (isContextPhase(step.kind)) return [phase.id, "exploring", "exploring"].join(":");
  return [phase.id, phase.domain || "general", step.kind].join(":");
}

function mergeStepStatus(left: TurnArchiveStepStatus, right: TurnArchiveStepStatus): TurnArchiveStepStatus {
  if (left === "failed" || right === "failed") return "failed";
  if (left === "rejected" || right === "rejected") return "rejected";
  if (left === "running" || right === "running") return "running";
  return "done";
}

function canMergePhasedStep(current: TurnArchiveStep | null, next: TurnArchiveStep): boolean {
  if (!current || !current.phase || !next.phase) return false;
  if (getPhaseKey(current) !== getPhaseKey(next)) return false;
  if (current.status === "failed" || current.status === "rejected") return false;
  const nextToolCount = countToolItems(next);
  return nextToolCount === 0 || countToolItems(current) + nextToolCount <= MAX_PHASE_TOOL_ITEMS;
}

function attachPendingPhaseMessages(
  step: TurnArchiveStep,
  pendingMessages: TurnArchiveStep[],
): TurnArchiveStep {
  const matchingMessages = pendingMessages.filter((message) =>
    message.phase?.id === step.phase?.id &&
    (!message.phase?.domain || !step.phase?.domain || message.phase.domain === step.phase.domain)
  );
  if (matchingMessages.length === 0) return step;
  const messageItems = matchingMessages.flatMap((message) => message.items);
  return {
    ...step,
    items: [...messageItems, ...step.items],
    sourceIndex: Math.min(step.sourceIndex, ...matchingMessages.map((message) => message.sourceIndex)),
  };
}

function makeStandalonePhaseMessage(
  messages: TurnArchiveStep[],
  language: ToolPresentationLanguage,
): TurnArchiveStep | null {
  const first = messages[0];
  if (!first?.phase) return null;
  const phase = first.phase;
  const items = messages.flatMap((message) => message.items);
  return {
    id: `turn-phase-${phase.id}-message-${first.id}`,
    kind: "message",
    status: "done",
    intent: phase.title || defaultIntentForStep("message", language),
    why: "",
    action: "",
    result: "",
    next: "",
    note: "",
    summary: phase.summary || "",
    phase,
    targets: [],
    items,
    expandedByDefault: false,
    sourceIndex: Math.min(...messages.map((message) => message.sourceIndex)),
    sourceEndIndex: Math.max(...messages.map((message) => message.sourceEndIndex)),
  };
}

function mergePhasedSteps(steps: TurnArchiveStep[], language: ToolPresentationLanguage): TurnArchiveStep[] {
  const result: TurnArchiveStep[] = [];
  let current: TurnArchiveStep | null = null;
  let pendingMessages: TurnArchiveStep[] = [];

  const flushCurrent = () => {
    if (!current) return;
    current.targets = uniqueTargets(current.items, language);
    result.push(current);
    current = null;
  };

  const flushPendingMessages = () => {
    if (pendingMessages.length === 0) return;
    const standalone = makeStandalonePhaseMessage(pendingMessages, language);
    if (standalone) result.push(standalone);
    pendingMessages = [];
  };

  for (const rawStep of steps) {
    const step = rawStep.phase ? { ...rawStep, note: "" } : rawStep;
    if (!step.phase) {
      flushCurrent();
      flushPendingMessages();
      result.push(step);
      continue;
    }

    if (step.kind === "message") {
      pendingMessages.push(step);
      continue;
    }

    const next = attachPendingPhaseMessages(step, pendingMessages);
    const nextPhase = next.phase;
    if (!nextPhase) {
      flushCurrent();
      result.push(next);
      continue;
    }
    pendingMessages = pendingMessages.filter((message) =>
      message.phase?.id !== step.phase?.id ||
      (!!message.phase?.domain && !!step.phase?.domain && message.phase.domain !== step.phase.domain)
    );

    if (!canMergePhasedStep(current, next)) {
      flushCurrent();
    }

    if (!current) {
      current = {
        ...next,
        id: `turn-phase-${nextPhase.id}-${nextPhase.domain || "general"}-${next.kind}-${result.length + 1}`,
        intent: nextPhase.title || next.intent,
        summary: nextPhase.summary || next.summary,
      };
    } else {
      current.items.push(...next.items);
      current.targets = uniqueTargets(current.items, language);
      current.status = mergeStepStatus(current.status, next.status);
      current.expandedByDefault = current.expandedByDefault || next.expandedByDefault;
      current.sourceEndIndex = next.sourceEndIndex;
    }
  }

  flushCurrent();
  flushPendingMessages();
  return result;
}

function attachActivityToStep(step: TurnArchiveStep, language: ToolPresentationLanguage): TurnArchiveStep {
  return {
    ...step,
    activity: buildActivityCellFromItems(step.items, language, step.kind),
  };
}

function canMergeCodexActivityStep(current: TurnArchiveStep | null, next: TurnArchiveStep): boolean {
  if (!current?.activity || !next.activity) return false;
  if (current.kind === "thinking" || next.kind === "thinking") return false;
  if (current.kind === "message" || next.kind === "message") return false;
  if (current.activity.kind === "exploring" && next.activity.kind === "exploring") return true;
  if (current.status === "failed" || current.status === "rejected") return false;
  if (next.status === "failed" || next.status === "rejected") return false;
  return current.activity.kind === next.activity.kind && current.activity.purposeKey === next.activity.purposeKey;
}

function mergeCodexActivityStep(
  current: TurnArchiveStep,
  next: TurnArchiveStep,
  language: ToolPresentationLanguage,
): TurnArchiveStep {
  const items = [...current.items, ...next.items];
  const status = mergeStepStatus(current.status, next.status);
  const merged: TurnArchiveStep = {
    ...current,
    status,
    items,
    targets: uniqueTargets(items, language),
    expandedByDefault: current.expandedByDefault || next.expandedByDefault,
    sourceEndIndex: next.sourceEndIndex,
  };
  return attachActivityToStep(merged, language);
}

function makeStep(input: {
  block: any;
  index: number;
  language: ToolPresentationLanguage;
}): TurnArchiveStep {
  const { block, index, language } = input;
  const phase = normalizeTurnRuntimePhase(block?.turnPhase, language);
  if (block.type === "thought") {
    return {
      id: `turn-archive-step-thinking-${block.id ?? index}`,
      kind: "thinking",
      status: block.isStreaming ? "running" : "done",
      intent: defaultIntentForStep("thinking", language),
      why: "",
      action: "",
      result: "",
      next: "",
      note: extractReasoningNoteFromText(String(block.content || ""), language),
      summary: "",
      ...(phase ? { phase } : {}),
      targets: [],
      items: [block],
      expandedByDefault: true,
      sourceIndex: index,
      sourceEndIndex: index,
    };
  }

  if (isProgressBlock(block)) {
    const status = mapProgressStatus(block);
    const kind = status === "failed" ? "blocked" : getProgressStepKind(String(block.phase || ""));
    const targets = uniqueTargets([block], language);
    const sourceItem = block && typeof block === "object" ? { ...block, sourceIndex: index } : block;
    return {
      id: `turn-archive-step-progress-${block.id ?? index}`,
      kind,
      status,
      intent: compactLine(String(block.title || block.action || defaultIntentForStep(kind, language)), 220),
      why: String(block.why || ""),
      action: String(block.action || ""),
      result: String(block.evidence || ""),
      next: String(block.next || ""),
      note: String(block.why || block.action || ""),
      summary: String(block.action || block.evidence || ""),
      ...(phase ? { phase } : {}),
      targets,
      items: [sourceItem],
      expandedByDefault: status === "running" || status === "failed",
      sourceIndex: index,
      sourceEndIndex: index,
    };
  }

  if (isToolBlock(block)) {
    const status = mapToolStatus(block);
    const kind = status === "failed" || status === "rejected" ? "blocked" : getToolStepKind(block);
    const target = compactTarget(block, language);
    return {
      id: `turn-archive-step-${kind}-${block.id ?? index}`,
      kind,
      status,
      intent: resolveToolIntent(block, kind, language),
      why: "",
      action: "",
      result: "",
      next: "",
      note: "",
      summary: "",
      ...(phase ? { phase } : {}),
      targets: target ? [target] : [],
      items: [block],
      expandedByDefault: status === "failed" || status === "rejected",
      sourceIndex: index,
      sourceEndIndex: index,
    };
  }

  const note = block.type === "agent"
    ? extractReasoningNoteFromText(String(block.content || block.message || ""), language)
    : "";
  const sourceItem = block && typeof block === "object" ? { ...block, sourceIndex: index } : block;
  return {
    id: `turn-archive-step-message-${block.id ?? index}`,
    kind: "message",
    status: "done",
    intent: defaultIntentForStep("message", language),
    why: "",
    action: "",
    result: "",
    next: "",
    note,
    summary: "",
    ...(phase ? { phase } : {}),
    targets: [],
    items: [sourceItem],
    expandedByDefault: false,
    sourceIndex: index,
    sourceEndIndex: index,
  };
}

function finalizeStep(
  step: TurnArchiveStep,
  language: ToolPresentationLanguage,
  sourceBlocks: any[],
  includeThoughtNotes: boolean,
): TurnArchiveStep {
  const targets = uniqueTargets(step.items, language);
  const kind = step.kind;
  const phase = normalizeTurnRuntimePhase(step.phase, language);
  const progressBlock = step.items.find(isProgressBlock);
  const fallbackIntent = isContextPhase(kind) && step.items.length > 1
    ? defaultIntentForStep(kind, language)
    : step.intent || defaultIntentForStep(kind, language);
  const baseSummary = makeSummaryForStep({ ...step, targets }, language);
  const summary = phase?.summary
    ? `${phase.summary}${baseSummary ? `${language === "zh" ? " · " : " · "}${baseSummary}` : ""}`
    : baseSummary;
  if (progressBlock) {
    const progressTitle = compactLine(String(progressBlock.title || step.intent || ""), 160);
    const progressWhy = compactMarkdownSnippet(String(progressBlock.why || step.why || ""), 220);
    const progressAction = compactMarkdownSnippet(String(progressBlock.action || step.action || ""), 220);
    const progressEvidence = compactLine(String(progressBlock.evidence || step.result || ""), 220);
    const progressNext = compactLine(String(progressBlock.next || step.next || ""), 220);
    const intentParts = [
      progressAction || progressTitle,
      progressWhy,
    ].filter(Boolean);
    return {
      ...step,
      ...(phase ? { phase } : {}),
      targets,
      why: progressWhy,
      action: progressAction,
      result: progressEvidence,
      next: progressNext,
      note: progressWhy,
      intent: compactMarkdownSnippet(intentParts.join("\n"), 260),
      summary,
    };
  }
  const narrative = defaultNarrativeForStep({ ...step, targets, summary }, language);
  const hasPersistedIntent = step.items.length === 1 && String(step.items[0]?.intentSummary || "").trim().length > 0;
  const note = step.note || (step.kind === "message" || step.kind === "thinking"
    ? findNearestReasoningNote({
        sourceBlocks,
        beforeIndex: step.sourceIndex,
        kind: step.kind,
        language,
        includeThoughts: includeThoughtNotes,
      })
    : "");
  const intent = phase?.title || (hasPersistedIntent ? fallbackIntent : makeNarrativeIntent({ ...step, targets, ...narrative, note, summary }, language));
  return {
    ...step,
    ...(phase ? { phase } : {}),
    targets,
    ...narrative,
    note,
    intent,
    summary,
  };
}

function makeCounts(steps: TurnArchiveStep[]): TurnProcessArchiveCounts {
  const counts: TurnProcessArchiveCounts = {
    discover: 0,
    inspect: 0,
    edit: 0,
    command: 0,
    verify: 0,
    blocked: 0,
    failed: 0,
    rejected: 0,
    message: 0,
    thought: 0,
    table: 0,
  };
  for (const step of steps) {
    if (step.kind === "thinking") counts.thought += 1;
    else counts[step.kind] += 1;
    if (step.status === "failed") counts.failed += 1;
    if (step.status === "rejected") counts.rejected += 1;
    for (const item of step.items) {
      const toolName = String(item?.toolName || "");
      if (toolName === "analyze_tabular_document" || toolName === "query_tabular_document") {
        counts.table += 1;
      }
    }
  }
  return counts;
}

function makeSummaryText(steps: TurnArchiveStep[], counts: TurnProcessArchiveCounts, language: ToolPresentationLanguage): string {
  const parts: string[] = [];
  if (language === "en") {
    parts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
    const contextCount = counts.discover + counts.inspect;
    if (contextCount) parts.push(`${contextCount} context`);
    if (counts.edit) parts.push(`${counts.edit} edit`);
    if (counts.verify) parts.push(`${counts.verify} verify`);
    if (counts.command) parts.push(`${counts.command} command`);
    if (counts.blocked) parts.push(`${counts.blocked} blocked`);
    if (counts.thought) parts.push(`${counts.thought} thought`);
    return parts.join(" / ");
  }

  parts.push(`${steps.length} 步`);
  const contextCount = counts.discover + counts.inspect;
  if (contextCount) parts.push(`上下文 ${contextCount}`);
  if (counts.edit) parts.push(`编辑 ${counts.edit}`);
  if (counts.verify) parts.push(`验证 ${counts.verify}`);
  if (counts.command) parts.push(`命令 ${counts.command}`);
  if (counts.blocked) parts.push(`受阻 ${counts.blocked}`);
  if (counts.thought) parts.push(`思考 ${counts.thought}`);
  return parts.join(" / ");
}

function buildModelFromSteps(input: {
  blocks: any[];
  sourceBlocks?: any[];
  steps: TurnArchiveStep[];
  language: ToolPresentationLanguage;
  includeThoughtNotes?: boolean;
  mergeAdjacent?: boolean;
}): TurnProcessArchiveModel {
  const includeThoughtNotes = input.includeThoughtNotes !== false;
  const mergeAdjacent = input.mergeAdjacent !== false;
  const sourceBlocks = input.sourceBlocks || input.blocks;
  const hasPhaseSteps = input.steps.some((step) => !!step.phase);
  const strategySteps = hasPhaseSteps
    ? mergePhasedSteps(input.steps, input.language)
    : mergeStrategySteps(input.steps, input.language);
  const normalizedSteps: TurnArchiveStep[] = [];
  for (const next of strategySteps) {
    const current = normalizedSteps[normalizedSteps.length - 1] || null;
    if (canMergeSteps(current, next, mergeAdjacent)) {
      current!.items.push(...next.items);
      current!.targets = uniqueTargets(current!.items, input.language);
      current!.expandedByDefault = current!.expandedByDefault || next.expandedByDefault;
      current!.sourceEndIndex = next.sourceEndIndex;
      if (isContextPhase(current!.kind) && isContextPhase(next.kind)) {
        current!.intent = defaultIntentForStep(current!.kind, input.language);
      }
      continue;
    }
    normalizedSteps.push(next);
  }
  const finalizedStepsWithActivity = normalizedSteps
    .map((step) => attachActivityToStep(finalizeStep(step, input.language, sourceBlocks, includeThoughtNotes), input.language))
    .filter((step) => step.kind !== "message" || !!step.phase || String(step.note || "").trim().length > 0);
  const finalizedSteps: TurnArchiveStep[] = [];
  for (const step of finalizedStepsWithActivity) {
    const current = finalizedSteps[finalizedSteps.length - 1] || null;
    if (canMergeCodexActivityStep(current, step)) {
      finalizedSteps[finalizedSteps.length - 1] = mergeCodexActivityStep(current!, step, input.language);
      continue;
    }
    finalizedSteps.push(step);
  }
  const counts = makeCounts(finalizedSteps);
  const previewTargets: string[] = [];
  for (const step of finalizedSteps) {
    for (const target of step.targets) {
      if (target && previewTargets.length < 3 && !previewTargets.includes(target)) {
        previewTargets.push(target);
      }
    }
  }

  return {
    blocks: input.blocks,
    steps: finalizedSteps,
    counts,
    totalCount: input.blocks.length,
    stepCount: finalizedSteps.length,
    summaryText: makeSummaryText(finalizedSteps, counts, input.language),
    currentJudgment: "",
    previewTargets,
  };
}

export function buildTurnProcessArchiveModel(input: {
  blocks: any[];
  finalVisibleAgentIndex: number;
  language?: ToolPresentationLanguage;
  includeThoughts?: boolean;
  includeThoughtNotes?: boolean;
}): TurnProcessArchiveModel {
  const language = normalizeLanguage(input.language);
  const includeThoughts = input.includeThoughts !== false;
  const includeThoughtNotes = input.includeThoughtNotes !== false;
  const latestThoughtId = getLatestThoughtBlock(input.blocks)?.id ?? null;
  const archiveEntries = input.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block, index }) => {
    if (!isProcessArchiveCandidate(block, input.finalVisibleAgentIndex, index)) return false;
    if (block.type === "thought" && !includeThoughts) return false;
    if (block.type === "thought" && block.id !== latestThoughtId) return false;
    return true;
  });
  const archiveBlocks = archiveEntries.map((entry) => entry.block);

  const steps: TurnArchiveStep[] = [];
  archiveEntries.forEach(({ block, index }) => {
    const next = makeStep({ block, index, language });
    steps.push(next);
  });

  return buildModelFromSteps({
    blocks: archiveBlocks,
    sourceBlocks: input.blocks,
    steps,
    language,
    includeThoughtNotes,
  });
}

export function buildLiveTurnProcessTimelineModel(input: {
  blocks: any[];
  language?: ToolPresentationLanguage;
  includeThoughts?: boolean;
}): TurnProcessArchiveModel {
  const language = normalizeLanguage(input.language);
  const includeThoughts = input.includeThoughts !== false;
  const liveBlocks: any[] = [];
  const steps: TurnArchiveStep[] = [];
  input.blocks.forEach((block, index) => {
    if (!block || block.type === "user") return;
    if (block.type === "thought") {
      return;
    }
    if (!isLiveProcessCandidate(block)) {
      return;
    }

    liveBlocks.push(block);
    const next = makeStep({ block, index, language });
    steps.push(next);
  });

  return buildModelFromSteps({
    blocks: liveBlocks,
    sourceBlocks: input.blocks,
    steps,
    language,
    includeThoughtNotes: includeThoughts,
    mergeAdjacent: false,
  });
}
