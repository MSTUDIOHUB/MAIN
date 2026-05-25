import { createModelFeedbackDedupeState, dedupeModelFeedbackText, isThinModelToolNarration } from "./modelFeedbackDedupe";
import { compactToolPresentationTarget, getToolPresentationLabel } from "./toolPresentation";

export interface ToolUiGroupBlock {
  type?: string;
  toolName?: string;
  toolStatus?: string;
  diff?: unknown;
  id?: string | number;
  target?: string;
  message?: string;
  observationSummary?: string;
  intentSummary?: string;
  why?: string;
  content?: string;
  streaming?: boolean;
  hiddenProcess?: boolean;
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
  if (excludedToolNames.has(String(block.toolName || ""))) return false;
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
  toolName: string;
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
  "read_file",
  "read_document",
  "repo_map_context",
  "repo_map_impact",
  "index_workspace_documents",
]);

const SEARCH_OPERATION_TOOL_NAMES = new Set([
  "glob_search",
  "grep_search",
  "repo_map_search",
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
]);

function classifyOperationTool(toolName: string): ChatOperationKind {
  if (EXPLORE_OPERATION_TOOL_NAMES.has(toolName)) return "explore";
  if (SEARCH_OPERATION_TOOL_NAMES.has(toolName)) return "search";
  if (READ_OPERATION_TOOL_NAMES.has(toolName)) return "read";
  if (TABLE_OPERATION_TOOL_NAMES.has(toolName)) return "table";
  if (EDIT_OPERATION_TOOL_NAMES.has(toolName)) return "edit";
  if (COMMAND_OPERATION_TOOL_NAMES.has(toolName)) return toolName === "browser_evaluate" ? "verify" : "command";
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
  return /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped/i.test(text);
}

function getFullToolTarget(block: ToolUiGroupBlock, language: "zh" | "en"): string {
  const toolName = String(block.toolName || "");
  const target = String(block.target || "").trim();
  if (target) return target;
  if (toolName === "get_project_skeleton") return language === "en" ? "Project skeleton" : "项目骨架";
  return language === "en" ? "Current workspace" : "当前工作区";
}

function isContextOperationCandidate(block: ToolUiGroupBlock): boolean {
  if (block.type !== "tool") return false;
  if (String(block.toolStatus || "") !== "executed") return false;
  if (block.diff) return false;
  const kind = classifyOperationTool(String(block.toolName || ""));
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
  const kind = classifyOperationTool(String(block.toolName || ""));
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
    items[0]?.toolName === "get_project_skeleton";
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
    const kind = classifyOperationTool(toolName);
    const target = getFullToolTarget(block, language);
    const displayTarget = compactToolPresentationTarget(String(block.target || ""), toolName, language);
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
        String(block.toolName || "") === "get_project_skeleton";
      while (index < blocks.length) {
        const current = blocks[index];
        const currentMatchesFamily = groupFamily === "context"
          ? isContextOperationCandidate(current)
          : !isContextOperationCandidate(current) && isGenericCompletedOperationCandidate(current, input.completedToolGrouping);
        if (currentMatchesFamily) {
          if (
            groupStartsWithProjectSkeleton &&
            clusterBlocks.length > 0 &&
            String(current.toolName || "") !== "get_project_skeleton"
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
