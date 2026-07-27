import { isThinModelToolNarration, isSubstantiveModelFeedback } from "../modelFeedbackDedupe";
import { parseMessageContent } from "../messageParser";
import {
  extractPlanDraftPreview,
  extractTieredPlanProposal,
  hasExplicitPlanProposal,
} from "../planProposal";
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
  const explicitFinal = [...blocks]
    .reverse()
    .find((block) =>
      block.type === "agent" &&
      block.visibility === "assistant_final" &&
      !block.hiddenProcess &&
      hasRenderableAgentBlock(block)
    );
  const agentBlock = explicitFinal || [...blocks]
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
  if (agentNormalized === toolNormalized) return true;
  if (agentNormalized.length >= 24 && toolNormalized.includes(agentNormalized)) return true;
  if (toolNormalized.length >= 24 && agentNormalized.includes(toolNormalized)) {
    const addedMeaningfulChars = agentNormalized.length - toolNormalized.length;
    if (!isSubstantiveModelFeedback(text) || addedMeaningfulChars < 40) return true;
  }
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
  return blocks.some(isReviewablePlanBlock);
}

function getPlanCandidatePreview(block: any): string {
  if (block?.type !== "agent") return "";
  const parseCandidate = (source: unknown) => {
    const raw = getAgentInspectableContent(String(source || ""));
    const proposal = extractTieredPlanProposal(raw);
    if (proposal && "markdown" in proposal && proposal.markdown.trim()) return proposal.markdown.trim();
    return extractPlanDraftPreview(raw)?.trim() || "";
  };
  const current = parseCandidate(block.content);
  if (current) return current;

  // Old snapshots replaced the final candidate with the stop message. Only
  // recover the latest saved attempt when it still carries an explicit Plan
  // protocol marker; current runs keep the candidate in block.content.
  const latestFailedAttempt = Array.isArray(block.failedAttempts)
    ? block.failedAttempts[block.failedAttempts.length - 1]
    : null;
  const legacySource = String(latestFailedAttempt?.content || "");
  if (!/(?:\[PROPOSAL START\]|<proposed_plan\b|<plan>|^\s*#\s*Proposed Plan\b|^\s*\[STAGE:)/im.test(legacySource)) {
    return "";
  }
  return parseCandidate(legacySource);
}

export function isPlanCandidateBlock(block: any): boolean {
  if (block?.type !== "agent") return false;
  const raw = getAgentInspectableContent(String(block.content || ""));
  return hasExplicitPlanProposal(raw) || getPlanCandidatePreview(block).length > 0;
}

export function shouldSuppressSupersededPlanCandidate(input: {
  block: any;
  hasReviewableArtifact: boolean;
  ownsReviewableArtifact: boolean;
}): boolean {
  if (!input.hasReviewableArtifact || !input.ownsReviewableArtifact) return false;
  // Explicit assistant channels are semantic runtime projections. A plan
  // milestone can legitimately summarize findings and ordered implementation
  // steps, which makes it look like a draft to the legacy Markdown classifier.
  // Never let that compatibility path override a committed public projection.
  if (
    input.block?.visibility === "assistant_update" ||
    input.block?.visibility === "assistant_final"
  ) {
    return false;
  }
  if (input.block?.archivedProposal) return false;
  return isPlanCandidateBlock(input.block) && !isReviewablePlanBlock(input.block);
}

export function selectLatestPlanCandidatePreview(blocks: any[]): string {
  for (const block of [...blocks].reverse()) {
    const preview = getPlanCandidatePreview(block);
    if (preview) return preview;
  }
  return "";
}

/**
 * A plan-shaped assistant message is only a draft. Review readiness belongs
 * to the materialized artifact/runtime lifecycle, never to Markdown wording.
 */
export function isReviewablePlanBlock(block: any): boolean {
  const runtimePhase = String(block?.turnPhase?.id || "").replace(/^plan_/, "");
  return runtimePhase === "review_ready";
}

/** Structured compatibility for old execution checkpoints and the canonical
 * planning quality-gate notice. */
export function isPlanGenerationFailureBlock(block: any): boolean {
  return block?.type === "system" && (
    block.variant === "plan_quality_gate" ||
    String(block.planExecutionProgress?.recoveryReason || "") === "plan_generation_failed"
  );
}

export function resolvePlanArtifactOwnerTurnId(input: {
  hasReviewableArtifact: boolean;
  actionOwnerTurnId?: string | null;
  progressOwnerTurnId?: string | null;
  reviewReadyTurnId?: string | null;
}): string | null {
  if (!input.hasReviewableArtifact) return null;
  return input.actionOwnerTurnId || input.progressOwnerTurnId || input.reviewReadyTurnId || null;
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
