import { stripLeakedReasoning } from "./normalizedTurn";
import { sanitizeAssistantDisplayContent } from "./sanitize";
import type { TaskBlock } from "./taskTypes";
import { deriveThoughtDisplay } from "./thoughtDisplay";
import {
  isThinModelToolNarration,
  shouldRetainStageSummary,
} from "./modelFeedbackDedupe";

const MAX_CAPSULE_COMMENTARY_CHARS = 180;

function compactPublicCommentary(value: unknown): string {
  const sanitized = stripLeakedReasoning(
    sanitizeAssistantDisplayContent(String(value || "")),
  )
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?:\*\*|__)([^\n]+?)(?:\*\*|__)/g, "$1")
    .replace(/(?:\*|_)([^\n]+?)(?:\*|_)/g, "$1")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return "";
  return sanitized.length <= MAX_CAPSULE_COMMENTARY_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_CAPSULE_COMMENTARY_CHARS - 1).trim()}…`;
}

function compactCapsuleThoughtSummary(
  value: unknown,
  language: "zh" | "en",
  kind: "assistant_commentary" | "capsule_activity",
): string {
  const publicText = stripLeakedReasoning(
    sanitizeAssistantDisplayContent(String(value || "")),
  )
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!publicText) return "";
  if (isThinModelToolNarration(publicText)) {
    return kind === "capsule_activity" ? publicText : "";
  }
  if (!shouldRetainStageSummary(publicText)) return "";
  const display = deriveThoughtDisplay(publicText, {
    language,
    mode: "latest",
    density: "adaptive",
    maxSummaryLines: 3,
  });
  return String(display.summaryText || "").trim();
}

function isExactCapsuleProgressOwner(input: {
  block: Extract<TaskBlock, { type: "agent" }>;
  sessionKey: string;
  logicalTurnId: string;
  displayTurnId: string;
  runId: string;
}): boolean {
  const { block } = input;
  return block.turnId === input.displayTurnId &&
    block.hiddenProcess !== true &&
    (!Array.isArray(block.options) || block.options.length === 0) &&
    block.publicProgress?.schemaVersion === 1 &&
    block.publicProgress.source === "model_visible_content" &&
    block.publicProgress.sessionKey === input.sessionKey &&
    block.publicProgress.turnId === input.logicalTurnId &&
    block.publicProgress.displayTurnId === input.displayTurnId &&
    block.publicProgress.runId === input.runId;
}

/**
 * Builds one safe, extractive current-focus summary from provider-visible
 * analysis. The selected Markdown is left intact so the Capsule can render the
 * complete concise summary instead of a truncated gray status line. Raw hidden
 * reasoning is never eligible. A typed live Capsule preamble may be shown as
 * the current focus, while the same thin text is rejected from settled ChatArea
 * commentary.
 */
export function selectCapsuleThoughtSummary(input: {
  blocks: TaskBlock[];
  sessionKey: string;
  logicalTurnId: string;
  displayTurnId: string;
  runId: string;
  language?: "zh" | "en";
}): string {
  const sessionKey = String(input.sessionKey || "").trim();
  const logicalTurnId = String(input.logicalTurnId || "").trim();
  const displayTurnId = String(input.displayTurnId || "").trim();
  const runId = String(input.runId || "").trim();
  if (!sessionKey || !logicalTurnId || !displayTurnId || !runId) return "";

  const candidates = [...(input.blocks || [])]
    .filter((block): block is Extract<TaskBlock, { type: "agent" }> =>
      block.type === "agent" &&
      isExactCapsuleProgressOwner({ block, sessionKey, logicalTurnId, displayTurnId, runId }) &&
      (
        (
          block.publicProgress?.kind === "assistant_commentary" &&
          block.visibility === "assistant_update" &&
          block.streaming !== true
        ) ||
        (
          block.publicProgress?.kind === "capsule_activity" &&
          block.visibility === "user_progress"
        )
      )
    )
    .map((block) => ({
      block,
      summary: compactCapsuleThoughtSummary(
        block.content,
        input.language === "en" ? "en" : "zh",
        block.publicProgress?.kind === "capsule_activity"
          ? "capsule_activity"
          : "assistant_commentary",
      ),
    }))
    .filter((entry) => entry.summary)
    .sort((left, right) =>
      Number(left.block.publicProgress?.createdAt || 0) - Number(right.block.publicProgress?.createdAt || 0)
    );

  return candidates[candidates.length - 1]?.summary || "";
}

/**
 * Select the latest explicit provider-visible commentary for one exact live
 * owner. Settled stage summaries and provisional Capsule activity use
 * different typed channels; hidden thought, finals, legacy blocks, and
 * cross-Run content all fail closed.
 */
export function selectCapsulePublicCommentary(input: {
  blocks: TaskBlock[];
  sessionKey: string;
  logicalTurnId: string;
  displayTurnId: string;
  runId: string;
}): string {
  const sessionKey = String(input.sessionKey || "").trim();
  const logicalTurnId = String(input.logicalTurnId || "").trim();
  const displayTurnId = String(input.displayTurnId || "").trim();
  const runId = String(input.runId || "").trim();
  if (!sessionKey || !logicalTurnId || !displayTurnId || !runId) return "";

  const candidate = [...(input.blocks || [])]
    .filter((block): block is Extract<TaskBlock, { type: "agent" }> =>
      block.type === "agent" &&
      isExactCapsuleProgressOwner({
        block,
        sessionKey,
        logicalTurnId,
        displayTurnId,
        runId,
      }) &&
      (
        (
          block.publicProgress?.kind === "assistant_commentary" &&
          block.visibility === "assistant_update" &&
          block.streaming !== true
        ) ||
        (
          block.publicProgress?.kind === "capsule_activity" &&
          block.visibility === "user_progress"
        )
      )
    )
    .sort((left, right) =>
      Number(left.publicProgress?.createdAt || 0) - Number(right.publicProgress?.createdAt || 0)
    )
    .pop();

  return candidate ? compactPublicCommentary(candidate.content) : "";
}
