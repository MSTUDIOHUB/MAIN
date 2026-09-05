import type { Lang } from "../../lib/appTypes";
import {
  normalizeAttachedFile,
  type AttachedFile,
} from "../../lib/attachments";
import type { MainModeKey } from "../../lib/mainModes";
import type { MainIntentShortcut } from "../../lib/runIntent";

export interface WorkspaceSlice {
  input: string;
  preferredResponseLanguage: Lang;
  contextMentions: string[];
  attachedFiles: AttachedFile[];
  selectedMainModeKey: MainModeKey;
  workspaceContentVersion: number;

  setInput: (value: string, options?: { preserveLockedComposerIntent?: boolean }) => void;
  setPreferredResponseLanguage: (language: Lang) => void;
  setContextMentions: (mentions: string[]) => void;
  addMention: (file: string) => void;
  removeMention: (file: string) => void;
  setAttachedFiles: (files: Array<AttachedFile | string>) => void;
  setSelectedMainModeKey: (key: MainModeKey) => void;
  setLockedComposerIntent: (intent: MainIntentShortcut | null) => void;
  bumpWorkspaceContentVersion: () => void;
}

export function normalizePendingDecisionInputKey(input: string): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeStoredRightPanelTab(
  value: unknown,
): "diff" | "terminal" | "plan" | "goal" | "subagents" {
  if (
    value === "diff" ||
    value === "terminal" ||
    value === "plan" ||
    value === "goal" ||
    value === "subagents"
  ) {
    return value;
  }
  return "plan";
}

export const createWorkspaceSlice = (set: any): WorkspaceSlice => ({
  input: "",
  preferredResponseLanguage: "zh",
  contextMentions: [],
  attachedFiles: [],
  selectedMainModeKey: "main_mode",
  workspaceContentVersion: 1,

  setInput: (value, options) => set((state: any) => {
    const currentInputKey = normalizePendingDecisionInputKey(state.input);
    const nextInputKey = normalizePendingDecisionInputKey(value);
    return {
      input: value,
      ...(value.trim().length === 0 && !options?.preserveLockedComposerIntent
        ? { lockedComposerIntent: null }
        : {}),
      ...(state.dismissedPendingDecisionInputKey && currentInputKey !== nextInputKey
        ? { dismissedPendingDecisionInputKey: null }
        : {}),
    };
  }),
  setPreferredResponseLanguage: (language) => set({
    preferredResponseLanguage: language,
  }),
  setContextMentions: (mentions) => set({ contextMentions: mentions }),
  addMention: (file) => set((state: any) =>
    state.contextMentions.includes(file)
      ? {}
      : {
          contextMentions: [...state.contextMentions, file],
          showFilePicker: false,
        }),
  removeMention: (file) => set((state: any) => ({
    contextMentions: state.contextMentions.filter(
      (candidate: string) => candidate !== file,
    ),
  })),
  setAttachedFiles: (files) => set({
    attachedFiles: files.map((file) => normalizeAttachedFile(file)),
  }),
  setSelectedMainModeKey: (key) => set((state: any) => ({
    selectedMainModeKey: key,
    lockedComposerIntent: null,
    rightPanelTab: normalizeStoredRightPanelTab(state.rightPanelTab),
  })),
  setLockedComposerIntent: (intent) => set({ lockedComposerIntent: intent }),
  bumpWorkspaceContentVersion: () => set((state: any) => ({
    workspaceContentVersion: state.workspaceContentVersion + 1,
  })),
});
