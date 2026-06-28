import { isThinModelToolNarration, isSubstantiveModelFeedback } from "../modelFeedbackDedupe";
import { parseMessageContent } from "../messageParser";
import { hasPlanDraftPreview, hasTieredPlanProposal } from "../planProposal";
import { sanitizeAIOutput } from "../sanitize";
import {
  extractPathishTokens,
  getAgentInspectableContent,
  getAgentPreviewContent,
  normalizeTranscriptDedupeText,
} from "./chatContentPreview";
import {
  compactToolTarget,
  fullToolTarget,
  READ_CONTEXT_TOOL_NAMES,
} from "./chatToolSummary";

export function hasRenderableAgentContent(blocks: any[]) {
  return blocks.some((block) => hasRenderableAgentBlock(block));
}

export function hasRenderableAgentBlock(block: any) {
  if (block.type !== "agent") return false;
  if (Array.isArray(block.options) && block.options.length > 0) return true;
  const segments = parseMessageContent(getAgentPreviewContent(block.content));
  return segments.some((seg) => seg.type === "text" && sanitizeAIOutput(seg.content).length > 0);
}

export function getLastAgentSummaryText(blocks: any[]) {
  const agentBlock = [...blocks]
    .reverse()
    .find((block) => block.type === "agent" && !block.hiddenProcess && hasRenderableAgentBlock(block));
  if (!agentBlock) return "";
  const summaryText = parseMessageContent(getAgentPreviewContent(agentBlock.content))
    .filter((seg) => seg.type === "text")
    .map((seg) => sanitizeAIOutput(seg.content))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return summaryText.length > 700 ? `${summaryText.slice(0, 700).trim()}...` : summaryText;
}

export function getAgentVisibleMarkdownText(block: any): string {
  if (block?.type !== "agent") return "";
  return parseMessageContent(getAgentPreviewContent(block.content))
    .filter((seg) => seg.type === "text")
    .map((seg) => sanitizeAIOutput(seg.content))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function collectNearbyToolEchoText(blocks: any[], agentIndex: number): string {
  const parts: string[] = [];
  const collect = (start: number, step: number) => {
    for (let idx = start; idx >= 0 && idx < blocks.length; idx += step) {
      const block = blocks[idx];
      if (!block || block.type === "thought" || block.type === "progress") continue;
      if (block.type === "tool") {
        parts.push(
          String(block.observationSummary || ""),
          String(block.intentSummary || ""),
          String(block.why || ""),
          String(block.message || ""),
          compactToolTarget(block.target, String(block.toolName || ""), "zh"),
          compactToolTarget(block.target, String(block.toolName || ""), "en"),
          fullToolTarget(block.target, String(block.toolName || ""), "zh"),
        );
        continue;
      }
      break;
    }
  };
  collect(agentIndex - 1, -1);
  collect(agentIndex + 1, 1);
  return parts.filter(Boolean).join("\n");
}

export function isThinToolNarration(text: string): boolean {
  return isThinModelToolNarration(text);
}

export function shouldSuppressAgentToolEcho(blocks: any[], agentIndex: number): boolean {
  const block = blocks[agentIndex];
  if (!block || block.type !== "agent" || block.streaming || block.hiddenProcess) return false;
  const text = getAgentVisibleMarkdownText(block);
  if (!text || text.length > 700) return false;
  const nearbyToolText = collectNearbyToolEchoText(blocks, agentIndex);
  if (!nearbyToolText) return false;
  const agentNormalized = normalizeTranscriptDedupeText(text);
  const toolNormalized = normalizeTranscriptDedupeText(nearbyToolText);
  if (!agentNormalized || !toolNormalized) return false;
  if (agentNormalized.length >= 24 && toolNormalized.includes(agentNormalized)) return true;
  if (toolNormalized.length >= 24 && agentNormalized.includes(toolNormalized)) return true;
  if (!isThinToolNarration(text)) return false;
  const agentTokens = extractPathishTokens(text);
  if (agentTokens.length === 0) return false;
  const toolTextLower = nearbyToolText.toLowerCase();
  return agentTokens.some((token) => toolTextLower.includes(token));
}

export function isTransparentToolNarrationBlock(block: any): boolean {
  if (!block || block.type !== "agent" || block.hiddenProcess) return false;
  const text = getAgentVisibleMarkdownText(block);
  const normalized = String(text || "").replace(/\s+/g, "");
  if (/完成|已读取|已搜索|已执行|readcomplete|searchcomplete|commandcomplete/i.test(normalized)) return false;
  const futureToolNarration =
    /(?:^|[。,，；;！!？?：:])(?:我(?:会|将|先|现在|正在|继续)|让我|接下来|现在|继续|正在).{0,60}(?:读取|查看|检查|搜索|调查|执行|运行|调用|验证|整理)/.test(normalized);
  return futureToolNarration || isThinToolNarration(text);
}

export function shouldSuppressAgentAsExplanation(block: any, _index: number, _blocks: any[], turnIntent: string): boolean {
  if (!block || block.type !== "agent" || block.hiddenProcess) return false;

  const isToolIntent = turnIntent !== "respond" && turnIntent !== "discuss";
  if (!isToolIntent) return false;

  const text = getAgentVisibleMarkdownText(block);
  const content = String(text || "").trim();
  if (!content) return true;

  if (isThinModelToolNarration(content) || isThinToolNarration(text)) return true;
  if (isTransparentToolNarrationBlock(block)) return true;

  if (block.streaming) {
    const isSubstantive = isSubstantiveModelFeedback(content);
    if (!isSubstantive) {
      return true;
    }
  }

  return false;
}

export function hasGeneratedPlanContent(blocks: any[]) {
  return blocks.some((block) => {
    if (block.type === "tool") {
      return /\.main\/plans\//i.test(String(block.target || ""));
    }

    if (block.type !== "agent") return false;
    const raw = getAgentInspectableContent(block.content);
    return hasTieredPlanProposal(raw) || hasPlanDraftPreview(raw);
  });
}

export function isCompletedReadContextTool(block: any) {
  return (
    block?.type === "tool" &&
    block.toolStatus === "executed" &&
    !block.diff &&
    READ_CONTEXT_TOOL_NAMES.has(String(block.toolName || ""))
  );
}

export function isReadContextHardBoundary(block: any) {
  if (!block) return false;
  if (block.type === "user" || block.type === "jobList") return true;
  if (block.type === "progress") return true;
  if (block.type === "agent") {
    if (block.hiddenProcess && !block.streaming) return false;
    if (isTransparentToolNarrationBlock(block)) return false;
    return hasRenderableAgentBlock(block);
  }
  if (block.type === "tool") {
    if (block.toolStatus !== "pending") return !isCompletedReadContextTool(block);
    return block.toolName !== "write_file" && block.toolName !== "replace_in_file" && block.toolName !== "apply_patch";
  }
  return false;
}

export function isCachedReadContextBlock(block: any) {
  const text = [
    block?.message,
    block?.observationSummary,
    block?.evidence,
    block?.resultPreview,
    block?.content,
  ].map((value) => String(value || "")).join("\n");
  return /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped/i.test(text);
}
