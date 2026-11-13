import { parseProjectInitCommand } from "../lib/projectInit";
import { parseMainDebugShortcut, parseMainIntentShortcutForMode } from "../lib/runIntent";
import type { WorkspaceTurnQueueEntry } from "../lib/workspaceInstruction";

export function isWorkspaceGuidanceText(text: string): boolean {
  return !!text.trim() && !parseProjectInitCommand(text) && !parseMainDebugShortcut(text) &&
    !parseMainIntentShortcutForMode(text, "main_mode");
}

export function isQueuedWorkspaceGuidanceEligible(entry: WorkspaceTurnQueueEntry): boolean {
  const { payload } = entry.instruction;
  return entry.status === "queued" && !entry.claim && entry.instruction.source === "composer" &&
    isWorkspaceGuidanceText(payload.text) && !payload.images?.length && !payload.contextMentions?.length &&
    !payload.attachedFiles?.length && !payload.knowledgeReferences?.length &&
    Object.keys(payload.dispatchHints || {}).every(key => key === "subagentPreference");
}
