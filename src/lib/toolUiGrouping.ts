import { createModelFeedbackDedupeState, dedupeModelFeedbackText, isThinModelToolNarration } from "./modelFeedbackDedupe";
import { parseBrowserValidationRecord } from "./browserValidation";
import { compactToolPresentationTarget, getToolPresentationLabel } from "./toolPresentation";

export interface ToolUiGroupBlock {
  type?: string;
  toolName?: string;
  executionName?: string;
  toolStatus?: string;
  diff?: unknown;
  workspaceEffect?: "verified" | "partial";
  id?: string | number;
  target?: string;
  message?: string;
  observationSummary?: string;
  intentSummary?: string;
  why?: string;
  content?: string;
  streaming?: boolean;
  hiddenProcess?: boolean;
  evidence?: string;
}

function getSemanticToolName(block: ToolUiGroupBlock): string {
  return String(block.executionName || block.toolName || "");
}

const REPEATED_BROWSER_FAILURE_GROUP_TYPE = "MAIN_REPEATED_BROWSER_FAILURE";

export interface RepeatedBrowserFailureCall {
  id?: string | number;
  target?: string;
  message?: string;
  evidence?: string;
  observationSummary?: string;
  intentSummary?: string;
  why?: string;
}

interface RepeatedBrowserFailurePayload {
  type: typeof REPEATED_BROWSER_FAILURE_GROUP_TYPE;
  repeatCount: number;
  calls: RepeatedBrowserFailureCall[];
}

export interface BrowserFailureUiSummary {
  action: string;
  selector: string;
  reason: string;
  repeatCount: number;
  failureCodes: string[];
}

function normalizeUiText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidates = [raw];
  if (raw.startsWith("BROWSER_VALIDATION_FAILED:") && raw.includes("\n")) {
    candidates.unshift(raw.slice(raw.indexOf("\n") + 1).trim());
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Browser errors may carry a human-readable prefix before the JSON payload.
    }
  }
  return null;
}

function parseRepeatedBrowserFailurePayload(value: unknown): RepeatedBrowserFailurePayload | null {
  const parsed = parseJsonRecord(value);
  if (
    parsed?.type !== REPEATED_BROWSER_FAILURE_GROUP_TYPE ||
    !Array.isArray(parsed.calls)
  ) {
    return null;
  }
  const calls = parsed.calls.filter((call) => call && typeof call === "object") as RepeatedBrowserFailureCall[];
  if (calls.length === 0) return null;
  return {
    type: REPEATED_BROWSER_FAILURE_GROUP_TYPE,
    repeatCount: Math.max(calls.length, Number(parsed.repeatCount) || 0),
    calls,
  };
}

export function getRepeatedBrowserFailureCallsForUi(value: unknown): RepeatedBrowserFailureCall[] {
  return parseRepeatedBrowserFailurePayload(value)?.calls || [];
}

function unwrapBrowserFailureMessage(value: unknown): {
  message: string;
  repeatCount: number;
} {
  const grouped = parseRepeatedBrowserFailurePayload(value);
  if (!grouped) {
    return { message: String(value || ""), repeatCount: 1 };
  }
  return {
    message: String(grouped.calls[0]?.message || ""),
    repeatCount: grouped.repeatCount,
  };
}

function getBrowserFailureRecord(message: string): Record<string, unknown> | null {
  return parseBrowserValidationRecord(message) || parseJsonRecord(message);
}

function getFailedBrowserAction(record: Record<string, unknown> | null): {
  kind: string;
  value: string;
} | null {
  if (!record || !Array.isArray(record.actions)) return null;
  const actions = record.actions.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
  const selected = actions.find((item) => item.ok === false) || actions[actions.length - 1];
  if (!selected) return null;
  const kind = normalizeUiText(selected.kind);
  const value = normalizeUiText(selected.value);
  return kind || value ? { kind, value } : null;
}

function getActionSelector(kind: string, value: string): string {
  if (!value) return "";
  if (["fill", "press", "select_file", "set_input_files", "upload"].includes(kind)) {
    return normalizeUiText(value.split(/\s*=>\s*/, 1)[0]);
  }
  if (["click", "wait_for_selector", "wait_selector", "wait_for_text", "wait_text"].includes(kind)) return value;
  return "";
}

function getFailureCodes(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  const value = record.failureReasons ?? record.failure_reasons;
  if (!Array.isArray(value)) return [];
  return value.map(normalizeUiText).filter(Boolean);
}

function extractRawBrowserFailureReason(
  message: string,
  record: Record<string, unknown> | null,
  fallback: unknown,
): string {
  const structured = normalizeUiText(
    record?.failureSummary || record?.failure_summary || record?.error,
  );
  if (structured) return structured;
  const prefixMatch = message.match(/BROWSER_VALIDATION_FAILED:\s*([^\n]+)/i);
  return normalizeUiText(prefixMatch?.[1] || fallback);
}

function compactBrowserFailureReason(rawReason: string, language: "zh" | "en"): string {
  const raw = normalizeUiText(rawReason);
  if (!raw) return language === "zh" ? "浏览器验证未通过" : "Browser validation did not pass";
  if (/wait_for_text only searches document\.body text/i.test(raw)) {
    return language === "zh"
      ? "正文未出现目标文本；该文本仅匹配页面标题"
      : "Target text was absent from the page body and only matched the page title";
  }
  if (/waiting for locator\(['\"]?([^)'\"]+)/i.test(raw) && /Timeout/i.test(raw)) {
    return language === "zh"
      ? "目标元素不存在或不可交互，等待选择器超时"
      : "The target element was missing or not interactive before the selector timed out";
  }
  if (/validation_spec_error/i.test(raw)) {
    return language === "zh" ? "浏览器验证参数无效" : "The browser validation specification is invalid";
  }
  if (/assertion_failed/i.test(raw)) {
    return language === "zh" ? "页面断言未通过" : "A page assertion failed";
  }
  if (/blank_page/i.test(raw)) {
    return language === "zh" ? "页面没有可识别的渲染内容" : "The page had no meaningful rendered content";
  }
  const withoutPlaywrightLog = raw
    .replace(/\s*\|\s*action_failed:[\s\S]*$/i, "")
    .replace(/\s*Call log:[\s\S]*$/i, "")
    .replace(/^runtime_error:\s*/i, "");
  const maxChars = 150;
  return withoutPlaywrightLog.length <= maxChars
    ? withoutPlaywrightLog
    : `${withoutPlaywrightLog.slice(0, maxChars - 3).trim()}...`;
}

/**
 * Derive a concise browser failure label from the structured validator result.
 * The complete raw result remains available in the expanded ActionCard.
 */
export function summarizeBrowserFailureForUi(input: {
  message?: string;
  observationSummary?: string;
  evidence?: string;
  language?: "zh" | "en";
}): BrowserFailureUiSummary {
  const language = input.language === "en" ? "en" : "zh";
  const unwrapped = unwrapBrowserFailureMessage(input.message);
  const record = getBrowserFailureRecord(unwrapped.message);
  const failedAction = getFailedBrowserAction(record);
  const rawReason = extractRawBrowserFailureReason(
    unwrapped.message,
    record,
    input.observationSummary || input.evidence,
  );
  return {
    action: failedAction?.kind || "",
    selector: failedAction ? getActionSelector(failedAction.kind, failedAction.value) : "",
    reason: compactBrowserFailureReason(rawReason, language),
    repeatCount: unwrapped.repeatCount,
    failureCodes: getFailureCodes(record),
  };
}

function normalizeBrowserFailureFingerprintText(value: unknown): string {
  return normalizeUiText(value)
    .replace(/browser-\d+-\d+\.png/gi, "browser-<screenshot>.png")
    .replace(/\b\d{4,}ms\b/gi, "<duration>")
    .toLowerCase();
}

/** Returns null when the block lacks enough structured evidence to group safely. */
export function buildRepeatedBrowserFailureSignature(block: ToolUiGroupBlock): string | null {
  if (
    block.type !== "tool" ||
    getSemanticToolName(block) !== "browser_evaluate" ||
    String(block.toolStatus || "") !== "failed"
  ) {
    return null;
  }
  const unwrapped = unwrapBrowserFailureMessage(block.message);
  const record = getBrowserFailureRecord(unwrapped.message);
  const failedAction = getFailedBrowserAction(record);
  const failureCodes = getFailureCodes(record);
  const reason = extractRawBrowserFailureReason(
    unwrapped.message,
    record,
    block.observationSummary || block.evidence,
  );
  if ((!failedAction?.kind && !failedAction?.value) || (!reason && failureCodes.length === 0)) return null;

  const requestedSpec = record
    ? record.validationSpec || record.validation_spec || record.request || record.spec || {
        requestedActions: record.requestedActions || record.requested_actions,
        requestedChecks: record.requestedChecks || record.requested_checks || record.checks,
      }
    : null;
  return JSON.stringify({
    tool: "browser_evaluate",
    target: normalizeBrowserFailureFingerprintText(block.target),
    action: normalizeBrowserFailureFingerprintText(failedAction?.kind),
    value: normalizeBrowserFailureFingerprintText(failedAction?.value),
    failureCodes: [...failureCodes].sort(),
    reason: normalizeBrowserFailureFingerprintText(reason),
    requestedSpec,
    intent: normalizeBrowserFailureFingerprintText(block.intentSummary || block.why),
  });
}

function buildRepeatedBrowserFailureBlock(blocks: ToolUiGroupBlock[]): ToolUiGroupBlock {
  const first = blocks[0];
  const payload: RepeatedBrowserFailurePayload = {
    type: REPEATED_BROWSER_FAILURE_GROUP_TYPE,
    repeatCount: blocks.length,
    calls: blocks.map((block) => ({
      id: block.id,
      target: block.target,
      message: block.message,
      evidence: block.evidence,
      observationSummary: block.observationSummary,
      intentSummary: block.intentSummary,
      why: block.why,
    })),
  };
  return {
    ...first,
    message: JSON.stringify(payload, null, 2),
  };
}

export interface CompletedToolGroupRange {
  startIndex: number;
  endIndex: number;
}

interface BuildCompletedToolGroupRangesInput {
  blocks: ToolUiGroupBlock[];
  excludedToolNames?: Set<string>;
  includeDiff?: boolean;
  minGroupSize?: number;
}

function isCompletedToolGroupCandidate(
  block: ToolUiGroupBlock,
  excludedToolNames: Set<string>,
  includeDiff: boolean,
): boolean {
  if (block.type !== "tool") return false;
  if (String(block.toolStatus || "") !== "executed") return false;
  if (block.diff && !includeDiff) return false;
  if (excludedToolNames.has(getSemanticToolName(block))) return false;
  return true;
}

export function buildCompletedToolGroupRanges(
  input: BuildCompletedToolGroupRangesInput,
): CompletedToolGroupRange[] {
  const ranges: CompletedToolGroupRange[] = [];
  const excludedToolNames = input.excludedToolNames || new Set<string>();
  const includeDiff = input.includeDiff === true;
  const minGroupSize = Math.max(1, Math.floor(input.minGroupSize || 2));
  let startIndex = -1;

  for (let index = 0; index < input.blocks.length; index += 1) {
    const block = input.blocks[index];
    const candidate = isCompletedToolGroupCandidate(block, excludedToolNames, includeDiff);

    if (candidate) {
      if (startIndex < 0) startIndex = index;
      continue;
    }

    if (startIndex >= 0 && index - startIndex >= minGroupSize) {
      ranges.push({ startIndex, endIndex: index - 1 });
    }
    startIndex = -1;
  }

  if (startIndex >= 0 && input.blocks.length - startIndex >= minGroupSize) {
    ranges.push({ startIndex, endIndex: input.blocks.length - 1 });
  }

  return ranges;
}

export function countCompletedToolCalls(blocks: ToolUiGroupBlock[]): number {
  return blocks.filter((block) => block.type === "tool" && String(block.toolStatus || "") === "executed").length;
}

export type ChatOperationKind =
  | "explore"
  | "read"
  | "search"
  | "table"
  | "edit"
  | "command"
  | "verify"
  | "other";

export interface ChatOperationItem {
  key: string;
  block: ToolUiGroupBlock;
  blocks: ToolUiGroupBlock[];
  kind: ChatOperationKind;
  /** Provider-facing display name. */
  toolName: string;
  /** Canonical capability used only for semantic classification. */
  executionName: string;
  label: string;
  target: string;
  displayTarget: string;
  summary: string;
  status: string;
  count: number;
  cachedCount: number;
  diff?: unknown;
}

export interface ChatOperationCluster {
  id: string;
  kind: ChatOperationKind;
  title: string;
  countSummary: string;
  previewText: string;
  purposeSummary: string;
  totalCount: number;
  uniqueCount: number;
  duplicateCount: number;
  cachedCount: number;
  items: ChatOperationItem[];
  blocks: ToolUiGroupBlock[];
  legacyTestId?: "read-context-group" | "completed-tool-group";
}

export type ChatRenderSegment =
  | { kind: "block"; block: ToolUiGroupBlock; index: number }
  | { kind: "operationCluster"; cluster: ChatOperationCluster; index: number };

interface BuildChatRenderSegmentsInput {
  blocks: ToolUiGroupBlock[];
  includeUser?: boolean;
  language?: "zh" | "en";
  completedToolGrouping?: {
    enabled?: boolean;
    includeDiff?: boolean;
    includeReadContextTools?: boolean;
    minGroupSize?: number;
    splitProjectStructureExplore?: boolean;
  };
}

const READ_OPERATION_TOOL_NAMES = new Set([
  "get_file_outline",
  "code_ast_query",
  "git_status",
  "git_diff",
  "read_file",
  "read_document",
  "web_fetch",
  "repo_map_context",
  "repo_map_impact",
  "index_workspace_documents",
  "knowledge_get_excerpt",
]);

const SEARCH_OPERATION_TOOL_NAMES = new Set([
  "glob_search",
  "grep_search",
  "web_search",
  "repo_map_search",
  "find_symbol_references",
  "knowledge_search",
]);

const EXPLORE_OPERATION_TOOL_NAMES = new Set([
  "get_project_skeleton",
  "list_directory",
  "repo_map_status",
  "repo_map_files",
]);

const TABLE_OPERATION_TOOL_NAMES = new Set([
  "analyze_tabular_document",
  "query_tabular_document",
]);

const EDIT_OPERATION_TOOL_NAMES = new Set([
  "replace_in_file",
  "write_file",
  "apply_patch",
  "script_apply_edits",
  "apply_text_edits",
  "manage_script",
  "create_script",
  "delete_script",
]);

const COMMAND_OPERATION_TOOL_NAMES = new Set([
  "execute_command",
  "run_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
  "browser_evaluate",
  "computer_use",
]);

function classifyOperationTool(toolName: string): ChatOperationKind {
  if (EXPLORE_OPERATION_TOOL_NAMES.has(toolName)) return "explore";
  if (SEARCH_OPERATION_TOOL_NAMES.has(toolName)) return "search";
  if (READ_OPERATION_TOOL_NAMES.has(toolName)) return "read";
  if (TABLE_OPERATION_TOOL_NAMES.has(toolName)) return "table";
  if (EDIT_OPERATION_TOOL_NAMES.has(toolName)) return "edit";
  if (COMMAND_OPERATION_TOOL_NAMES.has(toolName)) {
    return toolName === "browser_evaluate" || toolName === "computer_use" ? "verify" : "command";
  }
  return "other";
}

function isCachedToolBlock(block: ToolUiGroupBlock): boolean {
  const text = [
    block.message,
    block.observationSummary,
    block.intentSummary,
    block.why,
    block.content,
  ].map((value) => String(value || "")).join("\n");
  return /FILE_UNCHANGED_STUB|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT|Repeated read-only tool call skipped/i.test(text);
}

function getFullToolTarget(block: ToolUiGroupBlock, language: "zh" | "en"): string {
  const toolName = getSemanticToolName(block);
  const target = String(block.target || "").trim();
  if (target) return target;
  if (toolName === "get_project_skeleton") return language === "en" ? "Project skeleton" : "项目骨架";
  return language === "en" ? "Current workspace" : "当前工作区";
}

function isContextOperationCandidate(block: ToolUiGroupBlock): boolean {
  if (block.type !== "tool") return false;
  if (String(block.toolStatus || "") !== "executed") return false;
  if (block.diff) return false;
  const kind = classifyOperationTool(getSemanticToolName(block));
  return kind === "explore" || kind === "search" || kind === "read" || kind === "table";
}

function isGenericCompletedOperationCandidate(
  block: ToolUiGroupBlock,
  config: BuildChatRenderSegmentsInput["completedToolGrouping"],
): boolean {
  if (!config?.enabled) return false;
  if (block.type !== "tool") return false;
  if (String(block.toolStatus || "") !== "executed") return false;
  if (block.diff && !config.includeDiff) return false;
  const kind = classifyOperationTool(getSemanticToolName(block));
  if (!config.includeReadContextTools && (kind === "explore" || kind === "search" || kind === "read" || kind === "table")) {
    return false;
  }
  return true;
}

function isOperationCandidate(
  block: ToolUiGroupBlock,
  config: BuildChatRenderSegmentsInput["completedToolGrouping"],
): boolean {
  return isContextOperationCandidate(block) || isGenericCompletedOperationCandidate(block, config);
}

function isTransparentOperationNarration(block: ToolUiGroupBlock): boolean {
  if (block.type !== "agent" || block.streaming || block.hiddenProcess) return false;
  return isThinModelToolNarration(String(block.content || ""));
}

function getDominantClusterKind(items: ChatOperationItem[]): ChatOperationKind {
  if (items.some((item) => item.kind === "edit")) return "edit";
  if (items.some((item) => item.kind === "command")) return "command";
  if (items.some((item) => item.kind === "verify")) return "verify";
  if (items.some((item) => item.kind === "explore")) return "explore";
  if (items.some((item) => item.kind === "search")) return "search";
  if (items.some((item) => item.kind === "table")) return "table";
  if (items.some((item) => item.kind === "read")) return "read";
  return "other";
}

function pushCountPart(parts: string[], count: number, label: string) {
  if (count > 0) parts.push(`${count} ${label}`);
}

function buildOperationCountSummary(items: ChatOperationItem[], language: "zh" | "en"): string {
  const counts = {
    explore: items.filter((item) => item.kind === "explore").reduce((sum, item) => sum + item.count, 0),
    read: items.filter((item) => item.kind === "read").reduce((sum, item) => sum + item.count, 0),
    search: items.filter((item) => item.kind === "search").reduce((sum, item) => sum + item.count, 0),
    table: items.filter((item) => item.kind === "table").reduce((sum, item) => sum + item.count, 0),
    edit: items.filter((item) => item.kind === "edit").reduce((sum, item) => sum + item.count, 0),
    command: items.filter((item) => item.kind === "command").reduce((sum, item) => sum + item.count, 0),
    verify: items.filter((item) => item.kind === "verify").reduce((sum, item) => sum + item.count, 0),
    other: items.filter((item) => item.kind === "other").reduce((sum, item) => sum + item.count, 0),
  };
  const parts: string[] = [];
  if (language === "en") {
    pushCountPart(parts, counts.explore, counts.explore === 1 ? "structure scan" : "structure scans");
    pushCountPart(parts, counts.read, counts.read === 1 ? "read" : "reads");
    pushCountPart(parts, counts.search, counts.search === 1 ? "search" : "searches");
    pushCountPart(parts, counts.table, counts.table === 1 ? "table operation" : "table operations");
    pushCountPart(parts, counts.edit, counts.edit === 1 ? "edit" : "edits");
    pushCountPart(parts, counts.command, counts.command === 1 ? "command" : "commands");
    pushCountPart(parts, counts.verify, counts.verify === 1 ? "verification" : "verifications");
    pushCountPart(parts, counts.other, counts.other === 1 ? "tool call" : "tool calls");
    return parts.join(", ");
  }
  pushCountPart(parts, counts.explore, "次结构");
  pushCountPart(parts, counts.read, "次读取");
  pushCountPart(parts, counts.search, "次搜索");
  pushCountPart(parts, counts.table, "次表格");
  pushCountPart(parts, counts.edit, "次修改");
  pushCountPart(parts, counts.command, "次命令");
  pushCountPart(parts, counts.verify, "次验证");
  pushCountPart(parts, counts.other, "次工具");
  return parts.join("，");
}

function buildClusterTitle(input: {
  kind: ChatOperationKind;
  totalCount: number;
  uniqueCount: number;
  duplicateCount: number;
  countSummary: string;
  language: "zh" | "en";
  items: ChatOperationItem[];
}): string {
  const { kind, totalCount, uniqueCount, duplicateCount, language, items } = input;
  const onlyProjectSkeleton =
    totalCount === 1 &&
    items.length === 1 &&
    items[0]?.executionName === "get_project_skeleton";
  if (onlyProjectSkeleton) {
    return language === "en" ? "Explore project structure" : "Explore · 探索项目结构";
  }
  if (kind === "read" || kind === "search" || kind === "explore" || kind === "table") {
    const countText = duplicateCount > 0
      ? language === "en"
        ? `${uniqueCount} effective context item${uniqueCount > 1 ? "s" : ""} (${totalCount} total)`
        : `${uniqueCount} 项有效上下文（共 ${totalCount} 次）`
      : language === "en"
      ? `${totalCount} context item${totalCount > 1 ? "s" : ""}`
      : `${totalCount} 项上下文`;
    return language === "en" ? `Explored ${countText}` : `已读取 ${countText}`;
  }
  if (language === "en") {
    return `${totalCount} completed tool call${totalCount > 1 ? "s" : ""}`;
  }
  return `已完成 ${totalCount} 次工具调用`;
}

function buildOperationCluster(
  blocks: ToolUiGroupBlock[],
  index: number,
  language: "zh" | "en",
): ChatOperationCluster {
  const entries: ChatOperationItem[] = [];
  const byKey = new Map<string, ChatOperationItem>();
  for (const block of blocks) {
    const toolName = String(block.toolName || "");
    const executionName = getSemanticToolName(block);
    const kind = classifyOperationTool(executionName);
    const target = getFullToolTarget(block, language);
    const displayTarget = compactToolPresentationTarget(String(block.target || ""), executionName, language);
    const key = `${toolName}:${target.replace(/\\/g, "/").toLowerCase()}`;
    const summary = String(block.observationSummary || block.intentSummary || block.why || "").trim();
    const cached = isCachedToolBlock(block) ? 1 : 0;
    const existing = byKey.get(key);
    if (existing) {
      existing.blocks.push(block);
      existing.count += 1;
      existing.cachedCount += cached;
      if (summary && !existing.summary) existing.summary = summary;
      if (block.diff && !existing.diff) existing.diff = block.diff;
      continue;
    }
    const entry: ChatOperationItem = {
      key,
      block,
      blocks: [block],
      kind,
      toolName,
      executionName,
      label: getToolPresentationLabel(toolName, language),
      target,
      displayTarget,
      summary,
      status: String(block.toolStatus || "executed"),
      count: 1,
      cachedCount: cached,
      diff: block.diff,
    };
    byKey.set(key, entry);
    entries.push(entry);
  }
  const totalCount = blocks.length;
  const uniqueCount = entries.length;
  const duplicateCount = Math.max(0, totalCount - uniqueCount);
  const cachedCount = entries.reduce((sum, entry) => sum + entry.cachedCount, 0);
  const kind = getDominantClusterKind(entries);
  const countSummary = buildOperationCountSummary(entries, language);
  const formatPreviewTarget = (entry: ChatOperationItem) =>
    entry.count > 1 ? `${entry.displayTarget} x${entry.count}` : entry.displayTarget;
  const previewEntries =
    kind === "edit" || kind === "command" || kind === "verify"
      ? [
          ...entries.filter((entry) => entry.kind !== "command" && entry.kind !== "verify").slice(0, 2),
          ...entries.filter((entry) => entry.kind === "command" || entry.kind === "verify").slice(0, 1),
        ]
      : entries.slice(0, 3);
  const previewTargets = previewEntries
    .map(formatPreviewTarget)
    .filter(Boolean);
  const hiddenCount = Math.max(0, entries.length - previewTargets.length);
  const previewText = `${previewTargets.join(language === "zh" ? "、" : ", ")}${hiddenCount > 0 ? ` +${hiddenCount}` : ""}`;
  const title = buildClusterTitle({ kind, totalCount, uniqueCount, duplicateCount, countSummary, language, items: entries });
  const firstId = blocks[0]?.id ?? index;
  const lastId = blocks[blocks.length - 1]?.id ?? index;
  return {
    id: `operation-${firstId}-${lastId}`,
    kind,
    title,
    countSummary,
    previewText,
    purposeSummary: entries.map((entry) => entry.summary).find(Boolean) || "",
    totalCount,
    uniqueCount,
    duplicateCount,
    cachedCount,
    items: entries,
    blocks,
    legacyTestId: kind === "read" || kind === "search" || kind === "explore" || kind === "table"
      ? "read-context-group"
      : "completed-tool-group",
  };
}

function shouldFlushGenericGroup(
  blocks: ToolUiGroupBlock[],
  config: BuildChatRenderSegmentsInput["completedToolGrouping"],
): boolean {
  if (blocks.length === 0) return false;
  if (blocks.some(isContextOperationCandidate)) return true;
  const minGroupSize = Math.max(1, Math.floor(config?.minGroupSize || 2));
  return blocks.length >= minGroupSize;
}

export function buildChatRenderSegments(input: BuildChatRenderSegmentsInput): ChatRenderSegment[] {
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  const includeUser = input.includeUser !== false;
  const language = input.language === "en" ? "en" : "zh";
  const items: ChatRenderSegment[] = [];
  const feedbackState = createModelFeedbackDedupeState();
  let visibleNarrativeCount = 0;
  let index = 0;

  const pushOperationCluster = (clusterBlocks: ToolUiGroupBlock[], startIndex: number) => {
    if (!shouldFlushGenericGroup(clusterBlocks, input.completedToolGrouping)) {
      clusterBlocks.forEach((block, offset) => {
        items.push({ kind: "block", block, index: startIndex + offset });
      });
      return;
    }
    items.push({
      kind: "operationCluster",
      cluster: buildOperationCluster(clusterBlocks, startIndex, language),
      index: startIndex,
    });
  };

  while (index < blocks.length) {
    const block = blocks[index];
    if (!includeUser && block?.type === "user") {
      index += 1;
      continue;
    }

    const repeatedBrowserFailureSignature = buildRepeatedBrowserFailureSignature(block);
    if (repeatedBrowserFailureSignature) {
      const startIndex = index;
      const repeatedBlocks = [block];
      let nextIndex = index + 1;
      while (
        nextIndex < blocks.length &&
        buildRepeatedBrowserFailureSignature(blocks[nextIndex]) === repeatedBrowserFailureSignature
      ) {
        repeatedBlocks.push(blocks[nextIndex]);
        nextIndex += 1;
      }
      if (repeatedBlocks.length > 1) {
        items.push({
          kind: "block",
          block: buildRepeatedBrowserFailureBlock(repeatedBlocks),
          index: startIndex,
        });
        index = nextIndex;
        continue;
      }
    }

    if (block?.type === "agent" && !block.streaming && !block.hiddenProcess) {
      const decision = dedupeModelFeedbackText(String(block.content || ""), feedbackState);
      const nextIsOperation = index + 1 < blocks.length && isOperationCandidate(blocks[index + 1], input.completedToolGrouping);
      if (decision.shouldSuppress || (decision.thinToolNarration && nextIsOperation && visibleNarrativeCount > 0)) {
        index += 1;
        continue;
      }
      visibleNarrativeCount += 1;
    }

    if (isOperationCandidate(block, input.completedToolGrouping)) {
      const startIndex = index;
      const clusterBlocks: ToolUiGroupBlock[] = [];
      const groupFamily = isContextOperationCandidate(block) ? "context" : "generic";
      const groupStartsWithProjectSkeleton =
        input.completedToolGrouping?.splitProjectStructureExplore === true &&
        getSemanticToolName(block) === "get_project_skeleton";
      while (index < blocks.length) {
        const current = blocks[index];
        const currentMatchesFamily = groupFamily === "context"
          ? isContextOperationCandidate(current)
          : !isContextOperationCandidate(current) && isGenericCompletedOperationCandidate(current, input.completedToolGrouping);
        if (currentMatchesFamily) {
          if (
            groupStartsWithProjectSkeleton &&
            clusterBlocks.length > 0 &&
            getSemanticToolName(current) !== "get_project_skeleton"
          ) {
            break;
          }
          clusterBlocks.push(current);
          index += 1;
          continue;
        }
        if (current?.type === "thought") {
          index += 1;
          continue;
        }
        if (
          isTransparentOperationNarration(current) &&
          !groupStartsWithProjectSkeleton &&
          index + 1 < blocks.length &&
          (
            groupFamily === "context"
              ? isContextOperationCandidate(blocks[index + 1])
              : !isContextOperationCandidate(blocks[index + 1]) && isGenericCompletedOperationCandidate(blocks[index + 1], input.completedToolGrouping)
          )
        ) {
          index += 1;
          continue;
        }
        break;
      }
      pushOperationCluster(clusterBlocks, startIndex);
      continue;
    }

    items.push({ kind: "block", block, index });
    index += 1;
  }

  return items;
}
