import {
  Lang,
} from "../useAppStore";
import {
  MainModeKey,
  mapMainModeToLegacyNexusMode,
  mapLegacyNexusModeToMainMode,
} from "../../lib/mainModes";
import {
  resolveLegacyNexusModeKey,
  normalizeStudioAgentKey,
  NexusModeKey,
  StudioAgentKey,
  PendingSlashCommand,
} from "../../lib/gameStudioCatalog";
import {
  setGameStudioActiveAgent,
} from "../../lib/gameStudioPack";
import {
  normalizeAttachedFile,
  AttachedFile,
} from "../../lib/attachments";
import {
  MainIntentShortcut,
} from "../../lib/runIntent";

export interface WorkspaceSlice {
  input: string;
  preferredResponseLanguage: Lang;
  contextMentions: string[];
  attachedFiles: AttachedFile[];
  selectedMainModeKey: MainModeKey;
  selectedNexusModeKey: NexusModeKey;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  workspaceContentVersion: number;

  setInput: (v: string, options?: { preserveLockedComposerIntent?: boolean }) => void;
  setPreferredResponseLanguage: (lang: Lang) => void;
  setContextMentions: (v: string[]) => void;
  addMention: (file: string) => void;
  removeMention: (file: string) => void;
  setAttachedFiles: (v: Array<AttachedFile | string>) => void;
  setSelectedMainModeKey: (key: MainModeKey) => void;
  setSelectedNexusModeKey: (key: NexusModeKey) => void;
  setActiveStudioAgentKey: (key: StudioAgentKey, options?: { persistToWorkspace?: boolean }) => Promise<void>;
  setGameStudioInitialized: (value: boolean) => void;
  setPendingSlashCommand: (command: PendingSlashCommand | null) => void;
  setLockedComposerIntent: (intent: MainIntentShortcut | null) => void;
  bumpWorkspaceContentVersion: () => void;
}

export function normalizePendingDecisionInputKey(input: string): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeStoredRightPanelTab(value: unknown): "diff" | "terminal" | "plan" | "goal" {
  if (value === "diff" || value === "terminal" || value === "plan" || value === "goal") {
    return value;
  }
  return "plan";
}

export const createWorkspaceSlice = (set: any, get: any) => ({
  input: "",
  preferredResponseLanguage: "zh" as Lang,
  contextMentions: [] as string[],
  attachedFiles: [] as AttachedFile[],
  selectedMainModeKey: "main_mode" as MainModeKey,
  selectedNexusModeKey: "nexus_general" as NexusModeKey,
  activeStudioAgentKey: "coder" as StudioAgentKey,
  gameStudioInitialized: false,
  workspaceContentVersion: 1,

  setInput: (v: string, options: any) => set((s: any) => {
    const currentInputKey = normalizePendingDecisionInputKey(s.input);
    const nextInputKey = normalizePendingDecisionInputKey(v);
    return {
      input: v,
      ...(v.trim().length === 0 && !options?.preserveLockedComposerIntent ? { lockedComposerIntent: null } : {}),
      ...(s.dismissedPendingDecisionInputKey && currentInputKey !== nextInputKey
        ? { dismissedPendingDecisionInputKey: null }
        : {}),
    };
  }),

  setPreferredResponseLanguage: (lang: Lang) => set({ preferredResponseLanguage: lang }),
  setContextMentions: (v: string[]) => set({ contextMentions: v }),
  addMention: (file: string) =>
    set((s: any) =>
      s.contextMentions.includes(file) ? {} : { contextMentions: [...s.contextMentions, file], showFilePicker: false }
    ),
  removeMention: (file: string) =>
    set((s: any) => ({ contextMentions: s.contextMentions.filter((f: string) => f !== file) })),
  setAttachedFiles: (v: any[]) => set({ attachedFiles: v.map((file) => normalizeAttachedFile(file)) }),
  setSelectedMainModeKey: (key: MainModeKey) => set((s: any) => ({
    selectedMainModeKey: key,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(key),
    lockedComposerIntent: null,
    rightPanelTab: normalizeStoredRightPanelTab(s.rightPanelTab),
  })),
  setSelectedNexusModeKey: (key: NexusModeKey) => {
    const resolved = resolveLegacyNexusModeKey(key);
    const selectedMainModeKey = mapLegacyNexusModeToMainMode(resolved);
    set({
      selectedMainModeKey,
      selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    });
  },
  setActiveStudioAgentKey: async (key: StudioAgentKey, options: any) => {
    const normalized = normalizeStudioAgentKey(key);
    set({ activeStudioAgentKey: normalized });
    if (options?.persistToWorkspace && get().gameStudioInitialized) {
      try {
        await setGameStudioActiveAgent(normalized);
      } catch {
        // Ignore workspace persistence failures here
      }
    }
  },
  setGameStudioInitialized: (value: boolean) => set({ gameStudioInitialized: value }),
  setPendingSlashCommand: (command: PendingSlashCommand | null) => set({ pendingSlashCommand: command }),
  setLockedComposerIntent: (intent: MainIntentShortcut | null) => set({ lockedComposerIntent: intent }),
  bumpWorkspaceContentVersion: () => set((s: any) => ({ workspaceContentVersion: s.workspaceContentVersion + 1 })),
});
