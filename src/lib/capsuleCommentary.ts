import { stripLeakedReasoning } from "./normalizedTurn";
import { sanitizeAssistantDisplayContent } from "./sanitize";
import type { TaskBlock } from "./taskTypes";

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

/**
 * Select the latest explicit provider-visible commentary for one exact live
 * owner. Hidden thought, demoted finals, legacy assistant_update blocks, and
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
      block.turnId === displayTurnId &&
      block.visibility === "assistant_update" &&
      block.hiddenProcess !== true &&
      block.streaming !== true &&
      (!Array.isArray(block.options) || block.options.length === 0) &&
      block.publicProgress?.schemaVersion === 1 &&
      block.publicProgress.kind === "assistant_commentary" &&
      block.publicProgress.source === "model_visible_content" &&
      block.publicProgress.sessionKey === sessionKey &&
      block.publicProgress.turnId === logicalTurnId &&
      block.publicProgress.displayTurnId === displayTurnId &&
      block.publicProgress.runId === runId
    )
    .sort((left, right) =>
      Number(left.publicProgress?.createdAt || 0) - Number(right.publicProgress?.createdAt || 0)
    )
    .pop();

  return candidate ? compactPublicCommentary(candidate.content) : "";
}
