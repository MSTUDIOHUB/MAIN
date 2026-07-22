import { buildCapsuleLiveGuidance } from "./assistantProgressPresentation";
import type { TaskBlock } from "./taskTypes";

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
    block.publicProgress.kind === "capsule_activity" &&
    block.publicProgress.source === "model_visible_content" &&
    block.publicProgress.sessionKey === input.sessionKey &&
    block.publicProgress.turnId === input.logicalTurnId &&
    block.publicProgress.displayTurnId === input.displayTurnId &&
    block.publicProgress.runId === input.runId &&
    block.visibility === "user_progress";
}

/**
 * Select the latest exact-Run provider-visible current-focus sentence for the
 * transient Capsule surface. Settled assistant commentary is intentionally
 * ineligible because it belongs to ChatArea as a durable checkpoint.
 *
 * `notOlderThan` lets a newer structured tool event invalidate an earlier
 * model preamble, preventing Capsule from freezing on stale prose while the
 * runtime has already moved from analysis to editing or validation.
 */
export function selectCapsuleLiveGuidance(input: {
  blocks: TaskBlock[];
  sessionKey: string;
  logicalTurnId: string;
  displayTurnId: string;
  runId: string;
  language?: "zh" | "en";
  notOlderThan?: number;
}): string {
  const sessionKey = String(input.sessionKey || "").trim();
  const logicalTurnId = String(input.logicalTurnId || "").trim();
  const displayTurnId = String(input.displayTurnId || "").trim();
  const runId = String(input.runId || "").trim();
  const notOlderThan = Number(input.notOlderThan || 0);
  if (!sessionKey || !logicalTurnId || !displayTurnId || !runId) return "";

  const candidates = [...(input.blocks || [])]
    .filter((block): block is Extract<TaskBlock, { type: "agent" }> =>
      block.type === "agent" &&
      isExactCapsuleProgressOwner({ block, sessionKey, logicalTurnId, displayTurnId, runId }) &&
      Number(block.publicProgress?.createdAt || 0) >= notOlderThan
    )
    .map((block) => ({
      block,
      guidance: buildCapsuleLiveGuidance(
        block.content,
        input.language === "en" ? "en" : "zh",
      ),
    }))
    .filter((entry) => entry.guidance)
    .sort((left, right) =>
      Number(left.block.publicProgress?.createdAt || 0) - Number(right.block.publicProgress?.createdAt || 0)
    );

  return candidates[candidates.length - 1]?.guidance || "";
}
