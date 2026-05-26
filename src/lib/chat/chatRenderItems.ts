import { getDiffStats } from "../diff";
import { buildChatRenderSegments } from "../toolUiGrouping";
import { collectChangeEntries } from "../workflowModels";
import type { ChatLanguage } from "../../types/chat";
import { isCachedReadContextBlock } from "./chatBlockVisibility";
import {
  compactToolTarget,
  fullToolTarget,
  getReadContextToolLabel,
} from "./chatToolSummary";

export function collectTurnChangeEntries(blocks: any[]) {
  return collectChangeEntries(blocks, getDiffStats);
}

export function buildBlockRenderItems(
  blocks: any[],
  includeUser = true,
  enableCompletedToolGrouping: boolean | {
    enabled?: boolean;
    includeDiff?: boolean;
    includeReadContextTools?: boolean;
    minGroupSize?: number;
    splitProjectStructureExplore?: boolean;
  } = false,
  language: ChatLanguage = "zh",
) {
  const completedToolGroupingConfig =
    typeof enableCompletedToolGrouping === "object"
      ? enableCompletedToolGrouping
      : { enabled: enableCompletedToolGrouping };
  return buildChatRenderSegments({
    blocks,
    includeUser,
    language,
    completedToolGrouping: completedToolGroupingConfig,
  });
}

export function buildReadContextEntries(blocks: any[], language: ChatLanguage) {
  const entries: Array<{
    key: string;
    block: any;
    blocks: any[];
    count: number;
    cachedCount: number;
    label: string;
    displayTarget: string;
    target: string;
    summary: string;
  }> = [];
  const byKey = new Map<string, (typeof entries)[number]>();
  for (const block of blocks) {
    const toolName = String(block.toolName || "");
    const displayTarget = compactToolTarget(block.target, toolName, language);
    const target = fullToolTarget(block.target, toolName, language);
    const key = `${toolName}:${String(target || displayTarget).replace(/\\/g, "/").toLowerCase()}`;
    const cached = isCachedReadContextBlock(block) ? 1 : 0;
    const summary = String(block.observationSummary || block.intentSummary || block.why || "").trim();
    const existing = byKey.get(key);
    if (existing) {
      existing.blocks.push(block);
      existing.count += 1;
      existing.cachedCount += cached;
      if (summary && !existing.summary) existing.summary = summary;
      continue;
    }
    const entry = {
      key,
      block,
      blocks: [block],
      count: 1,
      cachedCount: cached,
      label: getReadContextToolLabel(toolName, language),
      displayTarget,
      target,
      summary,
    };
    byKey.set(key, entry);
    entries.push(entry);
  }
  return entries;
}
