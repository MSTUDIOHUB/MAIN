import type { MainModeKey } from "../lib/mainModes";
import {
  isMainIntentShortcutAllowedInMainMode,
  parseMainDebugShortcut,
  parseMainIntentShortcutForMode,
  type MainIntentShortcut,
  type ResolvedRunIntent,
} from "../lib/runIntent";
import {
  buildLocalTurnTitle,
  buildRunIntentSummary,
} from "../lib/submit/turnSubmission";
import type { WorkspaceJsonObject } from "../lib/workspaceInstruction";

/**
 * Immutable UI facts captured by the exact Composer submit event. They must
 * not be reconstructed from mutable Zustand state after durable admission.
 */
export interface WorkspaceComposerIntentSnapshot {
  readonly mainModeKey: MainModeKey;
  readonly lockedComposerIntent: MainIntentShortcut | null;
}

export interface WorkspaceComposerIntentAdmissionInput {
  readonly text: string;
  readonly language: "zh" | "en";
  readonly snapshot: WorkspaceComposerIntentSnapshot;
}

/**
 * Converts an explicit shortcut or one-shot Composer capsule into JSON-only
 * dispatch candidates. The runtime still revalidates privileged Goal/Plan
 * capabilities; these fields only prevent an already accepted intent from
 * falling back to mutable-state inference while it waits in the FIFO.
 */
export function buildWorkspaceComposerIntentDispatchHints(
  input: WorkspaceComposerIntentAdmissionInput,
): WorkspaceJsonObject | undefined {
  const { mainModeKey } = input.snapshot;
  const mainDebugShortcut = mainModeKey === "main_mode"
    ? parseMainDebugShortcut(input.text)
    : null;
  const mainIntentShortcut = mainDebugShortcut
    ? null
    : parseMainIntentShortcutForMode(input.text, mainModeKey);
  const lockedComposerIntent =
    input.snapshot.lockedComposerIntent &&
    isMainIntentShortcutAllowedInMainMode(
      input.snapshot.lockedComposerIntent,
      mainModeKey,
    )
      ? input.snapshot.lockedComposerIntent
      : null;
  const modeIntent: ResolvedRunIntent | null = mainModeKey === "image_studio"
    ? "image_studio"
    : mainModeKey === "game_studio"
      ? "studio_workflow"
      : null;
  const resolvedIntent: ResolvedRunIntent | null = mainDebugShortcut
    ? "plan"
    : lockedComposerIntent || mainIntentShortcut?.intent || modeIntent;
  if (!resolvedIntent) return undefined;

  const semanticInput = mainDebugShortcut
    ? mainDebugShortcut.rest
    : mainIntentShortcut
      ? mainIntentShortcut.rest
      : input.text;
  const turnTitle = mainDebugShortcut
    ? "MDEBUG：用户反馈自修复"
    : buildLocalTurnTitle(semanticInput, resolvedIntent, input.language);
  const intentSummary = mainDebugShortcut
    ? "MDEBUG：用户反馈自修复"
    : buildRunIntentSummary({
        input: semanticInput,
        intent: resolvedIntent,
        language: input.language,
        reason: input.language === "en"
          ? "The user explicitly selected this Composer intent or workspace mode before submission."
          : "用户已在发送前明确选择本回合意图或工作区模式。",
      });

  return {
    resolvedIntent,
    runtimeIntentOverride: resolvedIntent,
    skipIntentResolution: true,
    turnTitle,
    intentSummary,
  };
}
