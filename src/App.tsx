import { useRef, useEffect, useCallback, useMemo, useState } from "react";
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import Sidebar from "./components/Sidebar";
import ChatArea from "./components/ChatArea";
import FilePanel from "./components/FilePanel";
import RightPanel from "./components/RightPanel";
import SettingsModal from "./components/SettingsModal";
import SkillsModal from "./components/SkillsModal";
import ThemeStyles from "./components/ThemeStyles";
import {
  useAppStore,
  translations,
  THEMES,
  GLOBAL_CHAT_KEY,
  type TaskBlock,
  resolveSessionWorkspaceKey,
  resolveSessionRuntimeKey,
  sanitizeAgentMessagesForPersist,
  sanitizeTaskBlocksForPersist,
  syncTaskIdCounterFromBlocks,
  normalizeInterruptedConversationTurnsForRestore,
} from "./store/useAppStore";
import { getE2EQuickReplyHandler, initializeE2EScenarios } from "./lib/e2e";
import {
  deleteChatSessionTempFiles,
  deleteProjectSession,
  listProjectSessions,
  loadProjectSession,
  rebuildProjectSessionsIndex,
  saveProjectSession,
  setWorkspaceRoot as setWorkspaceRootIpc,
  canonicalizeWorkspacePath,
} from "./lib/ipc";
import { normalizeStudioAgentKey } from "./lib/gameStudioCatalog";
import { MAIN_MODE_KEYS, mapLegacyNexusModeToMainMode, mapMainModeToLegacyNexusMode } from "./lib/mainModes";
import { resolveConversationTurnIntent } from "./lib/runIntent";
import { runAfterNextPaint } from "./lib/uiScheduling";
import { normalizeConversationDisplayTitle, type ReplyOption, type RightPanelTab } from "./lib/workflowModels";
import { appendDebugLog } from "./lib/debugLog";
import {
  createFeishuPairedUserFromMessage,
  createFeishuPairingRequest,
  createFeishuRemoteSessionTitle,
  findFeishuPairedUser,
  normalizeImAdaptersConfig,
  parseFeishuTextCommand,
  resolveFeishuRemoteIntentOverride,
  upsertFeishuPairedUser,
  type FeishuAdapterEvent,
  type FeishuInboundMessage,
} from "./lib/imAdapters";

function normalizeStoredRightPanelTab(value: unknown): RightPanelTab {
  return value === "diff" || value === "terminal" || value === "plan"
    ? value
    : "plan";
}

function buildSessionRuntimeSnapshotFromState(state: any) {
  const taskFlow = sanitizeTaskBlocksForPersist(state.taskFlow || []);
  return {
    taskFlow,
    agentMessages: sanitizeAgentMessagesForPersist(state.agentMessages || []),
    conversationTurns: normalizeInterruptedConversationTurnsForRestore(state.conversationTurns, taskFlow),
    currentTurnId: state.currentTurnId ?? null,
    selectedMainModeKey: state.selectedMainModeKey,
    selectedNexusModeKey: state.selectedNexusModeKey,
    activeStudioAgentKey: state.activeStudioAgentKey,
    gameStudioInitialized: state.gameStudioInitialized,
    pendingSlashCommand: state.pendingSlashCommand ?? null,
    planArtifacts: state.planArtifacts || [],
    planTasks: state.planTasks || [],
    planExecutionEvidenceLedger: state.planExecutionEvidenceLedger || [],
    planExecutionEvidenceCount: state.planExecutionEvidenceCount ?? 0,
    planStage: state.planStage ?? "idle",
    isPlanApproved: state.isPlanApproved === true,
    showPlanPanel: state.showPlanPanel === true,
    showDiff: state.showDiff === true,
    showTerminal: state.showTerminal === true,
    showFilePanel: state.showFilePanel === true,
    rightPanelTab: normalizeStoredRightPanelTab(state.rightPanelTab),
    selectedDiffTaskId: state.selectedDiffTaskId ?? null,
  };
}

function buildStoredSessionSnapshot(state: any, scopeKey: string, sessionId: number) {
  const session = (state.sessionsByWorkspace[scopeKey] || []).find((item: any) => item.id === sessionId);
  if (!session) return null;
  return {
    ...session,
    messages: sanitizeTaskBlocksForPersist(state.taskFlow || []),
    runtimeSnapshot: buildSessionRuntimeSnapshotFromState(state),
  };
}

// ==========================================
// MAIN APP COMPONENT
// ==========================================
export default function App() {
  const endOfFlowRef = useRef<HTMLDivElement>(null);

  const {
    sessionsByWorkspace, workspaces, activeSessionByWorkspace, currentWorkspace, currentSessionId,
    setCurrentWorkspace, addWorkspaceEntry, removeWorkspaceEntry, addSession, removeSession, updateSession, setCurrentSessionId,
    allowToolAction, rejectToolAction,
    autoApproveTools, setAutoApproveTools,
    mcpServers, setMcpServers, mcpDiscoveredTools, setMcpDiscoveredTools,
  } = useAppStore();

  // ── Config ────────────────────────────────────────────────────────────
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  const t = translations[config.language] || translations.en;
  const currentTheme = THEMES[config.theme] || THEMES.purple;
  const remoteFeishuQueueRef = useRef<FeishuInboundMessage[]>([]);
  const feishuStartingRef = useRef(false);
  const sessionSaveTimerRef = useRef<number | null>(null);
  const [sessionMigrationReady, setSessionMigrationReady] = useState(false);

  // ── Agent State (from store, replaces all inline implementations) ─────
  const taskFlow = useAppStore((s) => s.taskFlow);
  const agentMessages = useAppStore((s) => s.agentMessages);
  const conversationTurns = useAppStore((s) => s.conversationTurns);
  const currentTurnId = useAppStore((s) => s.currentTurnId);
  const planArtifacts = useAppStore((s) => s.planArtifacts);
  const planTasks = useAppStore((s) => s.planTasks);
  const planExecutionEvidenceLedger = useAppStore((s) => s.planExecutionEvidenceLedger);
  const planExecutionEvidenceCount = useAppStore((s) => s.planExecutionEvidenceCount);
  const planStage = useAppStore((s) => s.planStage);
  const isPlanApproved = useAppStore((s) => s.isPlanApproved);
  const showPlanPanel = useAppStore((s) => s.showPlanPanel);
  const showDiff = useAppStore((s) => s.showDiff);
  const showTerminal = useAppStore((s) => s.showTerminal);
  const showFilePanel = useAppStore((s) => s.showFilePanel);
  const rightPanelTab = useAppStore((s) => s.rightPanelTab);
  const selectedDiffTaskId = useAppStore((s) => s.selectedDiffTaskId);
  const pendingSlashCommand = useAppStore((s) => s.pendingSlashCommand);
  const isStreaming = useAppStore((s) => s.isGenerating);
  const agentStatus = useAppStore((s) => s.agentStatus);
  const elapsedTime = useAppStore((s) => s.elapsedTime);
  const runtimeBySessionKey = useAppStore((s) => s.runtimeBySessionKey);

  // ── Composer State ────────────────────────────────────────────────────
  const input = useAppStore((s) => s.input);
  const setInput = useAppStore((s) => s.setInput);
  const contextMentions = useAppStore((s) => s.contextMentions);
  const setContextMentions = useAppStore((s) => s.setContextMentions);
  const attachedFiles = useAppStore((s) => s.attachedFiles);
  const setAttachedFiles = useAppStore((s) => s.setAttachedFiles);
  const selectedMainModeKey = useAppStore((s) => s.selectedMainModeKey);
  const setSelectedMainModeKey = useAppStore((s) => s.setSelectedMainModeKey);
  const selectedNexusModeKey = useAppStore((s) => s.selectedNexusModeKey);
  const activeStudioAgentKey = useAppStore((s) => s.activeStudioAgentKey);
  const setActiveStudioAgentKey = useAppStore((s) => s.setActiveStudioAgentKey);
  const gameStudioInitialized = useAppStore((s) => s.gameStudioInitialized);
  const initializeGameStudioWorkspace = useAppStore((s) => s.initializeGameStudioWorkspace);
  const removeGameStudioWorkspace = useAppStore((s) => s.removeGameStudioWorkspace);
  const refreshGameStudioWorkspaceState = useAppStore((s) => s.refreshGameStudioWorkspaceState);
  const selectedWorkspace = useAppStore((s) => s.selectedWorkspace);
  const mainModes = [...MAIN_MODE_KEYS];
  const activeSessionScope = resolveSessionWorkspaceKey(currentWorkspace);
  const activeSessionKey = useMemo(
    () => resolveSessionRuntimeKey(activeSessionScope, currentSessionId),
    [activeSessionScope, currentSessionId],
  );
  const globalSessions = sessionsByWorkspace[GLOBAL_CHAT_KEY] || [];
  const sidebarWorkspace = selectedWorkspace || currentWorkspace;
  const sessionStatuses = useMemo(() => {
    const statuses: Record<string, string> = {};
    Object.entries(runtimeBySessionKey || {}).forEach(([sessionKey, runtime]: any) => {
      const status = runtime?.agentStatus || (runtime?.isGenerating ? "running" : "idle");
      if (status && status !== "idle") statuses[sessionKey] = status;
    });
    if (activeSessionKey && (agentStatus !== "idle" || isStreaming)) {
      statuses[activeSessionKey] = agentStatus || (isStreaming ? "running" : "idle");
    }
    return statuses;
  }, [activeSessionKey, agentStatus, isStreaming, runtimeBySessionKey]);
  const workspaceStatuses = useMemo(() => {
    const rank: Record<string, number> = { error: 4, pending_review: 3, running: 2, idle: 1 };
    const next: Record<string, string> = {};
    const promote = (workspacePath: string, status: string) => {
      if (!workspacePath || status === "idle") return;
      const current = next[workspacePath] || "idle";
      if ((rank[status] || 0) > (rank[current] || 0)) next[workspacePath] = status;
    };
    workspaces.forEach((workspace) => {
      const activeSessionId = activeSessionByWorkspace[workspace.path] ?? null;
      const activeKey = resolveSessionRuntimeKey(workspace.path, activeSessionId);
      if (activeKey && sessionStatuses[activeKey]) {
        promote(workspace.path, sessionStatuses[activeKey]);
      }
      const prefix = `${workspace.path}:`;
      Object.entries(sessionStatuses).forEach(([sessionKey, status]) => {
        if (sessionKey.startsWith(prefix)) promote(workspace.path, status);
      });
    });
    if (currentWorkspace && (agentStatus !== "idle" || isStreaming)) {
      promote(currentWorkspace, agentStatus || "running");
    }
    return next;
  }, [activeSessionByWorkspace, agentStatus, currentWorkspace, isStreaming, sessionStatuses, workspaces]);

  // ── Layout State ──────────────────────────────────────────────────────
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const filePanelWidth = useAppStore((s) => s.workspaceTreePanelWidth);
  const setRightPanelWidth = useAppStore((s) => s.setRightPanelWidth);
  const setFilePanelWidth = useAppStore((s) => s.setWorkspaceTreePanelWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const closeRightPanel = useAppStore((s) => s.closeRightPanel);
  const closeFilePanel = useAppStore((s) => s.closeFilePanel);
  const isRightPanelVisible = showPlanPanel || showDiff || showTerminal;
  const isFilePanelVisible = showFilePanel;
  // isResizing is local UI state (mouse drag), not in the store
  const [isResizing, setIsResizing] = useState(false);
  const [isFilePanelResizing, setIsFilePanelResizing] = useState(false);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isWorkspaceDropActive, setIsWorkspaceDropActive] = useState(false);
  const pendingRightPanelWidthRef = useRef<number | null>(null);
  const rightPanelResizeFrameRef = useRef<number | null>(null);

  // ── Modal State ───────────────────────────────────────────────────────
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);
  const settingsTab = useAppStore((s) => s.settingsTab);
  const isSkillsOpen = useAppStore((s) => s.isSkillsOpen);
  const isAddingSkill = useAppStore((s) => s.isAddingSkill);
  const showAgentPicker = useAppStore((s) => s.showAgentPicker);
  const setIsSettingsOpen = useAppStore((s) => s.setIsSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setIsSkillsOpen = useAppStore((s) => s.setIsSkillsOpen);
  const setIsAddingSkill = useAppStore((s) => s.setIsAddingSkill);
  const setShowAgentPicker = useAppStore((s) => s.setShowAgentPicker);

  const refreshSessionsForScope = useCallback(async (
    scopeKey: string,
    options: { rebuildIndex?: boolean } = {},
  ) => {
    try {
      const diskSessions = options.rebuildIndex
        ? await rebuildProjectSessionsIndex(scopeKey)
        : await listProjectSessions(scopeKey);
      let mergedSessions = diskSessions;
      useAppStore.setState((state: any) => {
        const existing = state.sessionsByWorkspace[scopeKey] || [];
        const diskIds = new Set(diskSessions.map((session: any) => String(session.id)));
        const localOnlySessions = existing.filter((session: any) =>
          !diskIds.has(String(session.id)) &&
          (
            session.active ||
            session.recordingDisabled ||
            session.storageStatus === "missing" ||
            session.storageStatus === "temporary" ||
            (Array.isArray(session.messages) && session.messages.length > 0) ||
            !!session.runtimeSnapshot
          )
        );
        const shouldPreferLocalActive = localOnlySessions.some((session: any) => session.active);
        const normalizedDiskSessions = shouldPreferLocalActive
          ? diskSessions.map((session: any) => ({ ...session, active: false }))
          : diskSessions;
        mergedSessions = [...localOnlySessions, ...normalizedDiskSessions];
        return {
          sessionsByWorkspace: {
            ...state.sessionsByWorkspace,
            [scopeKey]: mergedSessions,
          },
        };
      });
      return mergedSessions;
    } catch (error) {
      appendDebugLog("warn", "session.storage", {
        phase: options.rebuildIndex ? "rebuild_failed" : "list_failed",
        scopeKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return useAppStore.getState().sessionsByWorkspace[scopeKey] || [];
    }
  }, []);

  const persistCurrentSessionNow = useCallback(async () => {
    const state = useAppStore.getState();
    if (!state.currentSessionId) return;
    const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    const snapshot = buildStoredSessionSnapshot(state, scopeKey, state.currentSessionId);
    if (!snapshot) return;

    state.updateSession(scopeKey, state.currentSessionId, {
      messages: snapshot.messages,
      runtimeSnapshot: snapshot.runtimeSnapshot,
    });

    if (!state.config.sessionRecordingEnabled || snapshot.recordingDisabled) return;
    try {
      await saveProjectSession(scopeKey, snapshot);
    } catch (error) {
      appendDebugLog("warn", "session.storage", {
        phase: "save_failed",
        scopeKey,
        sessionId: state.currentSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const settleCurrentSessionBeforeNavigation = useCallback(async () => {
    const state = useAppStore.getState();
    state.saveCurrentRuntimeToSession();
    await persistCurrentSessionNow();
  }, [persistCurrentSessionNow]);

  // ── Skills ────────────────────────────────────────────────────────────
  const skills = useAppStore((s) => s.skills);
  const toggleSkill = useAppStore((s) => s.toggleSkill);
  const deleteSkill = useAppStore((s) => s.deleteSkill);
  const addSkill = useAppStore((s) => s.addSkill);
  const updateSkill = useAppStore((s) => s.updateSkill);

  useEffect(() => initializeE2EScenarios(), []);
  useEffect(() => () => {
    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    appendDebugLog("info", "app.lifecycle", {
      phase: "app_mounted",
      currentWorkspace: currentWorkspace || "global",
      currentSessionId,
      taskFlowBlocks: taskFlow.length,
      agentMessages: agentMessages.length,
      conversationTurns: conversationTurns.length,
    });
  // Log only the initial mount snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let cancelled = false;
    const migrateLegacySessions = async () => {
      const markerKey = "main.sessions.appDataMigrated.v1";
      const state = useAppStore.getState();
      const nextSessionsByWorkspace: Record<string, any[]> = {};
      let touched = false;

      for (const [scopeKey, sessions] of Object.entries(state.sessionsByWorkspace || {})) {
        nextSessionsByWorkspace[scopeKey] = await Promise.all((sessions as any[]).map(async (session) => {
          const hasRuntime = Boolean(session.runtimeSnapshot);
          const hasMessages = Array.isArray(session.messages) && session.messages.length > 0;
          if (session.recordingDisabled) return session;
          if (hasRuntime || hasMessages) {
            try {
              const saved = await saveProjectSession(scopeKey, session);
              touched = true;
              return { ...session, ...saved };
            } catch (error) {
              appendDebugLog("warn", "session.storage", {
                phase: "legacy_migration_save_failed",
                scopeKey,
                sessionId: session.id,
                error: error instanceof Error ? error.message : String(error),
              });
              return session;
            }
          }
          if (!session.storageStatus) {
            touched = true;
            return { ...session, storageStatus: "missing" };
          }
          return session;
        }));
      }

      if (!cancelled && touched) {
        useAppStore.setState({ sessionsByWorkspace: nextSessionsByWorkspace });
      }
      try {
        window.localStorage.setItem(markerKey, "1");
      } catch {}
      if (!cancelled) setSessionMigrationReady(true);
    };

    void migrateLegacySessions();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!sessionMigrationReady) return;
    void refreshSessionsForScope(activeSessionScope);
  }, [activeSessionScope, refreshSessionsForScope, sessionMigrationReady]);
  useEffect(() => {
    if (!currentWorkspace) return;
    const startedAt = performance.now();
    appendDebugLog("info", "workspace.root", { phase: "set_start", currentWorkspace });
    void setWorkspaceRootIpc(currentWorkspace)
      .catch((error) => {
        appendDebugLog("warn", "workspace.root", {
          phase: "set_failed",
          currentWorkspace,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => refreshGameStudioWorkspaceState())
      .finally(() => {
        appendDebugLog("info", "workspace.root", {
          phase: "set_done",
          currentWorkspace,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      });
  }, [currentWorkspace, refreshGameStudioWorkspaceState]);

  useEffect(() => {
    if (!currentSessionId) return;

    const messages = sanitizeTaskBlocksForPersist(taskFlow);
    const runtimeSnapshot = {
      taskFlow: messages,
      agentMessages: sanitizeAgentMessagesForPersist(agentMessages),
      conversationTurns,
      currentTurnId,
      selectedMainModeKey,
      selectedNexusModeKey,
      activeStudioAgentKey,
      gameStudioInitialized,
      pendingSlashCommand,
      planArtifacts,
      planTasks,
      planExecutionEvidenceLedger,
      planExecutionEvidenceCount,
      planStage,
      isPlanApproved,
      showPlanPanel,
      showDiff,
      showTerminal,
      showFilePanel,
      rightPanelTab: normalizeStoredRightPanelTab(rightPanelTab),
      selectedDiffTaskId,
    };

    updateSession(activeSessionScope, currentSessionId, {
      messages,
      runtimeSnapshot,
    });

    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }

    if (config.sessionRecordingEnabled) {
      sessionSaveTimerRef.current = window.setTimeout(() => {
        sessionSaveTimerRef.current = null;
        const state = useAppStore.getState();
        const session = (state.sessionsByWorkspace[activeSessionScope] || []).find((item: any) => item.id === currentSessionId);
        if (!session || session.recordingDisabled) return;
        void saveProjectSession(activeSessionScope, {
          ...session,
          messages,
          runtimeSnapshot,
        }).catch((error) => {
          appendDebugLog("warn", "session.storage", {
            phase: "debounced_save_failed",
            scopeKey: activeSessionScope,
            sessionId: currentSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 350);
    }
  }, [
    agentMessages,
    activeSessionScope,
    conversationTurns,
    config.sessionRecordingEnabled,
    currentSessionId,
    currentTurnId,
    gameStudioInitialized,
    isPlanApproved,
    pendingSlashCommand,
    planArtifacts,
    planExecutionEvidenceLedger,
    planExecutionEvidenceCount,
    planStage,
    planTasks,
    activeStudioAgentKey,
    rightPanelTab,
    selectedMainModeKey,
    selectedNexusModeKey,
    selectedDiffTaskId,
    showDiff,
    showFilePanel,
    showPlanPanel,
    showTerminal,
    taskFlow,
    updateSession,
  ]);

  const activeDiffTask = taskFlow.find(task => task.type === "tool" && task.status === "pending_review");

  const handleAttachFile = async () => {
    try {
      const selected = await open({
        multiple: true, title: 'Attach files',
        filters: [{ name: 'Text & Code & Images', extensions: [
          'txt', 'md', 'js', 'ts', 'tsx', 'jsx', 'py', 'cs', 'java', 'c', 'cpp', 'h', 'hpp',
          'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'scss', 'less',
          'sh', 'bash', 'zsh', 'fish', 'rs', 'go', 'rb', 'php', 'swift', 'kt', 'dart', 'lua',
          'sql', 'graphql', 'png', 'jpg', 'jpeg',
        ]}],
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        const current = useAppStore.getState().attachedFiles;
        useAppStore.setState({ attachedFiles: [...new Set([...current, ...paths])] });
      }
    } catch (error) { console.error('Failed to attach file:', error); }
  };

  const handleAcceptInline = (id: number) => {
    allowToolAction(id);
  };

  const handleRejectInline = (id: number) => {
    rejectToolAction(id);
  };

  // ── Send Message: delegates to store's sendMessage ─────────────────────
  // This replaces the old inline handleSendMessage + runAgentLoop + 
  // executeToolCall + parseFullText + SSE parsing monolith.
  const handleSendMessage = useCallback((images?: string[]) => {
    const state = useAppStore.getState();
    const text = input;
    const contextMentionsSnapshot = [...state.contextMentions];
    const attachedFilesSnapshot = [...state.attachedFiles];
    const hasPayload =
      text.trim().length > 0 ||
      contextMentionsSnapshot.length > 0 ||
      attachedFilesSnapshot.length > 0 ||
      (images?.length ?? 0) > 0;

    if (!hasPayload) {
      return false;
    }

    if (state.isGenerating || state.agentStatus === "running" || state.agentStatus === "pending_review") {
      appendDebugLog("warn", "ui.sendMessage", {
        phase: "blocked_busy",
        agentStatus: state.agentStatus,
        isGenerating: state.isGenerating,
      });
      return false;
    }

    appendDebugLog("info", "ui.sendMessage", {
      phase: "accepted",
      textChars: text.length,
      images: images?.length ?? 0,
      contextMentions: contextMentionsSnapshot.length,
      attachedFiles: attachedFilesSnapshot.length,
      currentTurnId: state.currentTurnId,
      taskFlowBlocks: state.taskFlow.length,
      agentMessages: state.agentMessages.length,
    });

    runAfterNextPaint(() => {
      useAppStore.getState().sendMessage(text, images, {
        contextMentionsSnapshot,
        attachedFilesSnapshot,
      });
    });

    return true;
  }, [input]);

  const handleQuickReply = useCallback((choice: string | ReplyOption, sourceTurnId?: string) => {
    const text = typeof choice === "string" ? choice : choice.value;
    const optionAction = typeof choice === "string" ? undefined : choice.action;
    const e2eQuickReplyHandler = getE2EQuickReplyHandler();
    if (e2eQuickReplyHandler?.(text, sourceTurnId)) {
      return;
    }

    const state = useAppStore.getState();
    const reuseCurrentTurn = !!sourceTurnId && sourceTurnId === state.currentTurnId;
    const sourceTurnForLog = sourceTurnId
      ? state.conversationTurns.find((turn) => turn.id === sourceTurnId) || null
      : null;
    appendDebugLog("info", "ui.quickReply", {
      text,
      sourceTurnId,
      currentTurnId: state.currentTurnId,
      reuseCurrentTurn,
      sourceTurnFound: !!sourceTurnForLog,
      currentTurnStatus: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.status
        : null,
      taskFlowBlocks: state.taskFlow.length,
      agentMessages: state.agentMessages.length,
      optionAction: optionAction ?? null,
    });
    const sourceTurn = sourceTurnId
      ? state.conversationTurns.find((turn) => turn.id === sourceTurnId) || null
      : state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const sourceIntent = resolveConversationTurnIntent(sourceTurn);
    const shouldReuseSourceTurn = !!sourceTurnId && !!sourceTurn;
    const sendOptions = shouldReuseSourceTurn
      ? {
          reuseCurrentTurn: true,
          preservePlanState: sourceIntent === "plan",
          resolvedIntent: sourceIntent,
          skipIntentResolution: true,
        }
      : undefined;

    useAppStore.setState({
      ...(shouldReuseSourceTurn ? { currentTurnId: sourceTurnId } : {}),
      input: "",
      contextMentions: [],
      attachedFiles: [],
      ...(optionAction === "allow_readonly_session" ? { readOnlyAutoApproveForSession: true } : {}),
    });

    runAfterNextPaint(() => {
      useAppStore.getState().sendMessage(text, undefined, sendOptions);
    });
  }, []);

  const handleStopGeneration = useCallback(() => {
    useAppStore.getState().stopGeneration();
  }, []);

  // --- Workspace & Session Management ---
  const restoreSessionState = async (target: any, id: number, scopeKey = activeSessionScope) => {
    const startedAt = performance.now();
    const liveSessionKey = resolveSessionRuntimeKey(scopeKey, id);
    if (useAppStore.getState().restoreRuntimeForSession(liveSessionKey)) {
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        scopeKey,
        mode: "live_runtime",
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return;
    }
    let hydratedTarget = target;

    if (
      hydratedTarget?.storageStatus === "ok" &&
      !hydratedTarget?.runtimeSnapshot &&
      !(Array.isArray(hydratedTarget?.messages) && hydratedTarget.messages.length > 0) &&
      !hydratedTarget?.recordingDisabled
    ) {
      try {
        hydratedTarget = await loadProjectSession(scopeKey, id);
        updateSession(scopeKey, id, hydratedTarget);
      } catch (error) {
        appendDebugLog("warn", "session.restore", {
          sessionId: id,
          scopeKey,
          mode: "load_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        hydratedTarget = { ...hydratedTarget, storageStatus: "missing" };
      }
    }

    if (
      hydratedTarget?.storageStatus === "missing" &&
      !hydratedTarget?.runtimeSnapshot &&
      !(Array.isArray(hydratedTarget?.messages) && hydratedTarget.messages.length > 0)
    ) {
      const blockId = Date.now();
      const title = normalizeConversationDisplayTitle(
        hydratedTarget?.title || "",
        48,
        useAppStore.getState().config.language === "en" ? "Missing session" : "记录详情缺失",
      );
      const content = useAppStore.getState().config.language === "en"
        ? "This session title still exists, but its transcript/runtime files are missing. Re-adding the workspace refreshes the index, or you can delete this orphan record."
        : "这个会话标题还在，但完整对话与运行快照文件已经缺失。重新添加工作区会刷新索引，也可以删除这条孤立记录。";
      useAppStore.setState({
        taskFlow: [{ id: blockId, type: "system" as const, content }],
        agentMessages: [],
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        selectedDiffTaskId: null,
        conversationTurns: [{
          id: `missing-${id}-${Date.now()}`,
          userPrompt: title,
          title,
          mode: 'chat' as const,
          status: 'error' as const,
          summary: content,
          blockIds: [blockId],
          collapsed: false,
          createdAt: Date.now(),
        }],
        currentTurnId: null,
        showPlanPanel: false,
        showDiff: false,
        showTerminal: false,
        showFilePanel: false,
        rightPanelTab: 'plan',
      });
      appendDebugLog("warn", "session.restore", {
        sessionId: id,
        mode: "missing",
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      useAppStore.getState().saveCurrentRuntimeToSession();
      return;
    }

    target = hydratedTarget;
    if (target?.runtimeSnapshot) {
      const snapshot = target.runtimeSnapshot;
      const restoredTaskFlow = sanitizeTaskBlocksForPersist(snapshot.taskFlow || target.messages || []);
      const restoredConversationTurns = normalizeInterruptedConversationTurnsForRestore(
        snapshot.conversationTurns || [],
        restoredTaskFlow,
      );
      syncTaskIdCounterFromBlocks(restoredTaskFlow);
      useAppStore.setState({
        taskFlow: restoredTaskFlow,
        agentMessages: sanitizeAgentMessagesForPersist(snapshot.agentMessages || []),
        selectedMainModeKey: mapLegacyNexusModeToMainMode(
          (snapshot as any).selectedMainModeKey ||
            (snapshot as any).selectedNexusModeKey ||
            (snapshot as any).selectedAgentKey,
        ),
        selectedNexusModeKey: mapMainModeToLegacyNexusMode(
          mapLegacyNexusModeToMainMode(
            (snapshot as any).selectedMainModeKey ||
              (snapshot as any).selectedNexusModeKey ||
              (snapshot as any).selectedAgentKey,
          ),
        ),
        activeStudioAgentKey: normalizeStudioAgentKey(snapshot.activeStudioAgentKey ?? useAppStore.getState().activeStudioAgentKey),
        gameStudioInitialized: snapshot.gameStudioInitialized === true || useAppStore.getState().gameStudioInitialized,
        pendingSlashCommand: snapshot.pendingSlashCommand ?? null,
        selectedDiffTaskId: snapshot.selectedDiffTaskId ?? null,
        conversationTurns: restoredConversationTurns,
        currentTurnId: snapshot.currentTurnId ?? null,
        currentTurnState: {
          interceptorHandled: false,
          interceptorThought: "",
          lastReportedThought: "",
          lastReportedAssistantText: "",
          turnId: "",
        },
        agentStatus: 'idle',
        isGenerating: false,
        abortController: null,
        pendingReviewResolve: null,
        pendingReviewTaskId: null,
        pendingToolCall: null,
        autoApproveTools: false,
        readOnlyAutoApproveForSession: false,
        planArtifacts: snapshot.planArtifacts || [],
        planTasks: snapshot.planTasks || [],
        planExecutionEvidenceLedger: snapshot.planExecutionEvidenceLedger || [],
        planExecutionEvidenceCount: snapshot.planExecutionEvidenceCount ?? 0,
        planStage: snapshot.planStage ?? 'idle',
        isPlanApproved: snapshot.isPlanApproved ?? false,
        showPlanPanel: snapshot.showPlanPanel ?? false,
        showDiff: snapshot.showDiff ?? false,
        showTerminal: snapshot.showTerminal ?? false,
        showFilePanel: false,
        fileViewerPath: "",
        fileViewerContent: "",
        fileViewerError: "",
        fileViewerLoading: false,
        rightPanelTab: normalizeStoredRightPanelTab((snapshot as any).rightPanelTab),
        elapsedTime: 0,
      });
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        mode: "runtimeSnapshot",
        elapsedMs: Math.round(performance.now() - startedAt),
        taskFlowBlocks: restoredTaskFlow.length,
        agentMessages: (snapshot.agentMessages || []).length,
        conversationTurns: restoredConversationTurns.length,
      });
      useAppStore.getState().saveCurrentRuntimeToSession();
      return;
    }

    if (target?.messages?.length) {
      syncTaskIdCounterFromBlocks(target.messages);
      const turnId = `loaded-${id}-${Date.now()}`;
      const restoredTitle = normalizeConversationDisplayTitle(
        target.title || "",
        48,
        useAppStore.getState().config.language === "en" ? "New task" : "新的任务",
      );
      useAppStore.setState({
        taskFlow: target.messages,
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: useAppStore.getState().activeStudioAgentKey,
        gameStudioInitialized: useAppStore.getState().gameStudioInitialized,
        pendingSlashCommand: null,
        selectedDiffTaskId: null,
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        conversationTurns: [{
          id: turnId,
          userPrompt: target.title || '',
          title: restoredTitle,
          mode: 'chat' as const,
          status: 'done' as const,
          summary: restoredTitle,
          blockIds: target.messages.map((m: any) => m.id),
          collapsed: true,
          createdAt: Date.now(),
        }],
        currentTurnId: turnId,
        currentTurnState: {
          interceptorHandled: false,
          interceptorThought: "",
          lastReportedThought: "",
          lastReportedAssistantText: "",
          turnId: "",
        },
        showPlanPanel: false,
        showDiff: false,
        showTerminal: false,
        showFilePanel: false,
        fileViewerPath: "",
        fileViewerContent: "",
        fileViewerError: "",
        fileViewerLoading: false,
        rightPanelTab: 'plan',
      });
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        mode: "messages",
        elapsedMs: Math.round(performance.now() - startedAt),
        taskFlowBlocks: target.messages.length,
      });
      useAppStore.getState().saveCurrentRuntimeToSession();
      return;
    }

    useAppStore.setState({
      taskFlow: [],
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      activeStudioAgentKey: useAppStore.getState().activeStudioAgentKey,
      gameStudioInitialized: useAppStore.getState().gameStudioInitialized,
      pendingSlashCommand: null,
      selectedDiffTaskId: null,
      conversationTurns: [],
      currentTurnId: null,
      currentTurnState: {
        interceptorHandled: false,
        interceptorThought: "",
        lastReportedThought: "",
        lastReportedAssistantText: "",
        turnId: "",
      },
      agentMessages: [],
      agentStatus: 'idle',
      isGenerating: false,
      abortController: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
      autoApproveTools: false,
      readOnlyAutoApproveForSession: false,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      fileViewerPath: "",
      fileViewerContent: "",
      fileViewerError: "",
      fileViewerLoading: false,
      rightPanelTab: 'plan',
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: 'idle',
      isPlanApproved: false,
    });
    appendDebugLog("info", "session.restore", {
      sessionId: id,
      mode: "empty",
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    useAppStore.getState().saveCurrentRuntimeToSession();
  };

  const openSessionScope = (scopeKey: string) => {
    setCurrentWorkspace(scopeKey === GLOBAL_CHAT_KEY ? "" : scopeKey);
  };

  const handleOpenWorkspacePath = async (
    path: string,
    options: { selectFirstSession?: boolean; rebuildIndex?: boolean } = {},
  ) => {
    const rawPath = String(path || "").trim();
    if (!rawPath) return;
    try {
      await settleCurrentSessionBeforeNavigation();
      let stablePath = rawPath;
      try {
        stablePath = await canonicalizeWorkspacePath(rawPath);
      } catch {
        stablePath = await setWorkspaceRootIpc(rawPath);
      }
      const wasKnownWorkspace = useAppStore.getState().workspaces.some((entry: any) => entry.path === stablePath);
      const shouldRebuildIndex = options.rebuildIndex ?? !wasKnownWorkspace;
      addWorkspaceEntry(stablePath);
      const rememberedSessionId = useAppStore.getState().activeSessionByWorkspace[stablePath] ?? null;
      const existing = await refreshSessionsForScope(stablePath, { rebuildIndex: shouldRebuildIndex });
      const targetSession =
        existing.find((session: any) => rememberedSessionId != null && session.id === rememberedSessionId) ||
        existing.find((session: any) => session.active) ||
        (options.selectFirstSession ? existing[0] : null);
      if (targetSession) {
        await handleSelectSession(stablePath, targetSession.id);
      } else {
        setCurrentWorkspace(stablePath);
        setCurrentSessionId(null);
        useAppStore.setState({
          taskFlow: [],
          agentMessages: [],
          conversationTurns: [],
          currentTurnId: null,
          selectedDiffTaskId: null,
          pendingSlashCommand: null,
          planArtifacts: [],
          planTasks: [],
          planExecutionEvidenceLedger: [],
          planExecutionEvidenceCount: 0,
          planStage: "idle",
          isPlanApproved: false,
          agentStatus: "idle",
          isGenerating: false,
          abortController: null,
          pendingReviewResolve: null,
          pendingReviewTaskId: null,
          pendingToolCall: null,
          showPlanPanel: false,
          showDiff: false,
          showTerminal: false,
          showFilePanel: false,
          rightPanelTab: "plan",
        });
      }
    } catch (error) {
      console.error("Failed to open workspace path:", error);
    }
  };

  const handleSelectWorkspace = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select Project Workspace' });
      if (selected) {
        const selectedPath = Array.isArray(selected) ? selected[0] : selected;
        await handleOpenWorkspacePath(selectedPath, { selectFirstSession: true });
      }
    } catch (error) { console.error('Failed to select workspace:', error); }
  };

  const handleOpenGlobalChat = async () => {
    const state = useAppStore.getState();
    if (!state.currentWorkspace && state.currentSessionId) return;
    await settleCurrentSessionBeforeNavigation();

    openSessionScope(GLOBAL_CHAT_KEY);
    const existing = await refreshSessionsForScope(GLOBAL_CHAT_KEY);
    if (existing.length === 0) {
      setCurrentSessionId(null);
      return;
    }

    const targetSession = existing.find((session: any) => session.active) || existing[0];
    updateSession(GLOBAL_CHAT_KEY, targetSession.id, { active: true });
    setCurrentSessionId(targetSession.id);
    await restoreSessionState(targetSession, targetSession.id, GLOBAL_CHAT_KEY);
  };

  const handleRemoveWorkspaceEntry = async (path: string) => {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return;

    const state = useAppStore.getState();
    const wasActive = resolveSessionWorkspaceKey(state.currentWorkspace) === normalizedPath;
    const remainingWorkspaces = state.workspaces.filter((entry: any) => entry.path !== normalizedPath);

    state.saveCurrentRuntimeToSession();
    removeWorkspaceEntry(normalizedPath);

    if (!wasActive) return;

    const nextWorkspace = remainingWorkspaces[0]?.path;
    if (nextWorkspace) {
      await handleOpenWorkspacePath(nextWorkspace, { selectFirstSession: true });
    } else {
      await handleOpenGlobalChat();
    }
  };

  const handleCreateSessionForScope = async (scopeKey: string) => {
    if (!scopeKey) return;

    const state = useAppStore.getState();
    const liveScope = resolveSessionWorkspaceKey(state.currentWorkspace);
    if (state.currentSessionId) {
      await settleCurrentSessionBeforeNavigation();
      updateSession(liveScope, state.currentSessionId, {
        messages: sanitizeTaskBlocksForPersist(useAppStore.getState().taskFlow),
        active: false,
      });
    }

    const isGlobalChat = scopeKey === GLOBAL_CHAT_KEY;
    const storageStatus: "ok" | "temporary" = config.sessionRecordingEnabled ? "ok" : "temporary";
    const emptyRuntimeSnapshot = buildSessionRuntimeSnapshotFromState({
      taskFlow: [],
      agentMessages: [],
      conversationTurns: [],
      currentTurnId: null,
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      activeStudioAgentKey: useAppStore.getState().activeStudioAgentKey,
      gameStudioInitialized: useAppStore.getState().gameStudioInitialized,
      pendingSlashCommand: null,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      isPlanApproved: false,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
      selectedDiffTaskId: null,
    });
    const ns = {
      id: Date.now(),
      title: isGlobalChat
        ? (config.language === "en" ? "New Chat" : "新聊天")
        : (config.language === "en" ? "New Conversation" : "新会话"),
      date: new Date().toISOString(),
      active: true,
      storageStatus,
      recordingDisabled: !config.sessionRecordingEnabled,
      messages: [] as TaskBlock[],
      runtimeSnapshot: emptyRuntimeSnapshot,
    };
    const existing = useAppStore.getState().sessionsByWorkspace[scopeKey] || [];
    existing.forEach((ses: any) => { if (ses.active) updateSession(scopeKey, ses.id, { active: false }); });
    if (!isGlobalChat) addWorkspaceEntry(scopeKey);
    openSessionScope(scopeKey);
    addSession(scopeKey, { ...ns, active: true });
    setCurrentSessionId(ns.id);
    await restoreSessionState(ns, ns.id, scopeKey);
  };

  const handleSelectSession = async (scopeKey: string, id: number) => {
    const state = useAppStore.getState();
    const currentScopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    if (state.currentSessionId && (currentScopeKey !== scopeKey || state.currentSessionId !== id)) {
      await settleCurrentSessionBeforeNavigation();
    }

    if (scopeKey !== GLOBAL_CHAT_KEY) addWorkspaceEntry(scopeKey);
    openSessionScope(scopeKey);
    updateSession(scopeKey, id, { active: true });
    setCurrentSessionId(id);
    if (useAppStore.getState().restoreRuntimeForSession(resolveSessionRuntimeKey(scopeKey, id))) {
      return;
    }
    const target = (useAppStore.getState().sessionsByWorkspace[scopeKey] || []).find((s: any) => s.id === id);
    await restoreSessionState(target, id, scopeKey);
  };

  const handleDeleteSession = (scopeKey: string, id: number) => {
    const confirmed = window.confirm(
      config.language === "en"
        ? "Delete this session? Any temporary .tmp files generated by this session will also be removed. This can't be undone."
        : "确定删除这个会话吗？该会话中生成的临时 .tmp 文件也会一起清除，此操作不可撤销。",
    );
    if (!confirmed) return;

    const state = useAppStore.getState();
    const wasCurrent = scopeKey === resolveSessionWorkspaceKey(state.currentWorkspace) && id === state.currentSessionId;
    const sessionTempKey = resolveSessionRuntimeKey(scopeKey, id);
    removeSession(scopeKey, id);
    void deleteProjectSession(scopeKey, id).then((sessions) => {
      useAppStore.setState((latest: any) => ({
        sessionsByWorkspace: {
          ...latest.sessionsByWorkspace,
          [scopeKey]: [
            ...(latest.sessionsByWorkspace[scopeKey] || []).filter((session: any) =>
              session.id !== id && (session.recordingDisabled || session.storageStatus === "missing")
            ),
            ...sessions,
          ],
        },
      }));
    }).catch((error) => {
      appendDebugLog("warn", "session.storage", {
        phase: "delete_failed",
        scopeKey,
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (sessionTempKey) {
      void deleteChatSessionTempFiles(sessionTempKey).catch((error) => {
        appendDebugLog("warn", "session.temp", {
          phase: "delete_failed",
          scopeKey,
          sessionId: id,
          sessionTempKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (wasCurrent) {
      useAppStore.setState({
        taskFlow: [],
        selectedDiffTaskId: null,
        conversationTurns: [],
        currentTurnId: null,
        agentMessages: [],
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        pendingSlashCommand: null,
        planArtifacts: [],
        planTasks: [],
        planStage: "idle",
        isPlanApproved: false,
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        showPlanPanel: false,
        showDiff: false,
        showTerminal: false,
        showFilePanel: false,
        rightPanelTab: "plan",
        fileViewerPath: "",
        fileViewerContent: "",
        fileViewerError: "",
        fileViewerLoading: false,
      });
    }
  };

  const sendFeishuText = useCallback(async (
    target: string | Pick<FeishuInboundMessage, "chatId" | "userId" | "messageId">,
    text: string,
  ) => {
    const payload = typeof target === "string"
      ? { chatId: target }
      : {
          chatId: target.chatId,
          userId: target.userId,
          openId: target.userId,
          messageId: target.messageId,
        };
    const chatId = payload.chatId;
    if (!chatId || !text.trim()) return;
    try {
      await invoke("send_feishu_message", { ...payload, text });
    } catch (error) {
      appendDebugLog("warn", "feishu.remote", {
        phase: "send_failed",
        chatId,
        hasUserId: typeof target !== "string" && !!target.userId,
        hasMessageId: typeof target !== "string" && !!target.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const updateFeishuPairingConfig = useCallback((message: FeishuInboundMessage) => {
    const pairedUser = createFeishuPairedUserFromMessage(message);
    setConfig((prev: any) => {
      const imAdapters = normalizeImAdaptersConfig(prev.imAdapters);
      return {
        ...prev,
        imAdapters: {
          ...imAdapters,
          feishu: {
            ...imAdapters.feishu,
            pairedUsers: upsertFeishuPairedUser(imAdapters.feishu.pairedUsers, pairedUser),
          },
        },
      };
    });
    useAppStore.getState().removeFeishuPairingRequest(message.userId);
    return pairedUser;
  }, [setConfig]);

  const ensureFeishuRemoteSession = useCallback((message: FeishuInboundMessage) => {
    const state = useAppStore.getState();
    const workspace = state.currentWorkspace;
    if (!workspace) return null;

    const scopeKey = resolveSessionWorkspaceKey(workspace);
    const title = createFeishuRemoteSessionTitle(message);
    const sessions = state.sessionsByWorkspace[scopeKey] || [];
    let target = sessions.find((session: any) => session.title === title) || null;

    if (state.currentSessionId) {
      state.updateSession(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId, {
        messages: sanitizeTaskBlocksForPersist(state.taskFlow),
        active: false,
      });
    }

    for (const session of sessions) {
      if (session.active) state.updateSession(scopeKey, session.id, { active: false });
    }

    if (!target) {
      target = {
        id: Date.now(),
        title,
        date: new Date().toISOString(),
        active: true,
        storageStatus: state.config.sessionRecordingEnabled ? "ok" : "temporary",
        recordingDisabled: !state.config.sessionRecordingEnabled,
        messages: [] as TaskBlock[],
      };
      state.addSession(scopeKey, target);
    } else {
      state.updateSession(scopeKey, target.id, { active: true });
    }

    state.setCurrentSessionId(target.id);
    void restoreSessionState(target, target.id, scopeKey);
    return target.id;
  }, []);

  const runFeishuRemoteMessage = useCallback((message: FeishuInboundMessage, fromQueue = false) => {
    const state = useAppStore.getState();
    const feishuConfig = normalizeImAdaptersConfig(state.config.imAdapters).feishu;
    const pairedUser = findFeishuPairedUser(feishuConfig, message.userId);
    if (!pairedUser) {
      state.upsertFeishuPairingRequest(createFeishuPairingRequest(message));
      const pairText = state.config.language === "en"
        ? `This Feishu user is not paired yet. Open MAIN Settings > IM Adapters, or reply /pair ${feishuConfig.pairingCode} in this private chat.`
        : `当前飞书用户尚未配对。请在 MAIN 的「系统设置 > 即时通讯适配器」中通过配对请求，或在飞书私聊里回复 /pair ${feishuConfig.pairingCode}。`;
      void sendFeishuText(message, pairText);
      return false;
    }

    if (!state.currentWorkspace) {
      void sendFeishuText(
        message,
        state.config.language === "en"
          ? "MAIN has no workspace open. Please open a project folder in the desktop app first."
          : "MAIN 当前没有打开工作区。请先在桌面端打开项目文件夹。",
      );
      return false;
    }

    const busy = state.isGenerating || state.agentStatus === "running" || state.agentStatus === "pending_review";
    if (busy) {
      if (!fromQueue) {
        remoteFeishuQueueRef.current.push(message);
        void sendFeishuText(
          message,
          state.config.language === "en"
            ? `MAIN is busy. Your message has been queued at position ${remoteFeishuQueueRef.current.length}.`
            : `MAIN 正在处理上一条任务，已将这条消息加入队列（第 ${remoteFeishuQueueRef.current.length} 位）。`,
        );
      }
      return false;
    }

    ensureFeishuRemoteSession(message);
    void sendFeishuText(
      message,
      state.config.language === "en" ? "MAIN received the remote task and started processing." : "MAIN 已收到远程任务，开始处理。",
    );
    runAfterNextPaint(() => {
      const intentOverride = resolveFeishuRemoteIntentOverride(message.text);
      useAppStore.getState().sendMessage(message.text, undefined, {
        ...intentOverride,
        ...(intentOverride.resolvedIntent === "analyze"
          ? {
              turnTitle: state.config.language === "en" ? "Feishu remote analysis" : "飞书远程分析",
              intentSummary: state.config.language === "en"
                ? "Feishu remote private-chat message defaults to read-only analysis in the current workspace."
                : "飞书私聊远程消息默认按当前工作区的只读分析处理。",
            }
          : {}),
        remoteFeishu: {
          adapter: "feishu",
          chatId: message.chatId,
          userId: message.userId,
          userName: message.userName,
          messageId: message.messageId,
        },
      });
    });
    return true;
  }, [ensureFeishuRemoteSession, sendFeishuText]);

  const handleFeishuInboundMessage = useCallback((message: FeishuInboundMessage) => {
    const state = useAppStore.getState();
    const command = parseFeishuTextCommand(message.text);
    const feishuConfig = normalizeImAdaptersConfig(state.config.imAdapters).feishu;

    if (command.kind === "pair") {
      if (command.code === feishuConfig.pairingCode) {
        updateFeishuPairingConfig(message);
        void sendFeishuText(
          message,
          state.config.language === "en"
            ? "Pairing complete. You can now send MAIN tasks from this private chat."
            : "配对完成。现在可以在这个飞书私聊里向 MAIN 发送任务了。",
        );
      } else {
        void sendFeishuText(
          message,
          state.config.language === "en" ? "Pairing code is incorrect." : "配对码不正确。",
        );
      }
      return;
    }

    if (command.kind === "approve" || command.kind === "reject") {
      const approval = state.resolvePendingFeishuApproval(message.userId, command.code);
      if (!approval) {
        void sendFeishuText(
          message,
          state.config.language === "en" ? "No matching pending approval was found." : "没有找到匹配的待审批操作。",
        );
        return;
      }
      if (command.kind === "approve") {
        state.allowToolAction(approval.taskId);
        void sendFeishuText(message, state.config.language === "en" ? "Approved." : "已允许执行。");
      } else {
        state.rejectToolAction(approval.taskId);
        void sendFeishuText(message, state.config.language === "en" ? "Rejected." : "已拒绝执行。");
      }
      return;
    }

    if (command.kind === "status") {
      const status = state.feishuAdapterStatus;
      const workspaceLabel = state.currentWorkspace || (state.config.language === "en" ? "No workspace" : "未打开工作区");
      const text = state.config.language === "en"
        ? `Feishu adapter: ${status.status}\nMAIN: ${state.agentStatus}\nWorkspace: ${workspaceLabel}\nQueue: ${remoteFeishuQueueRef.current.length}`
        : `飞书适配器：${status.status}\nMAIN 状态：${state.agentStatus}\n工作区：${workspaceLabel}\n队列：${remoteFeishuQueueRef.current.length}`;
      void sendFeishuText(message, text);
      return;
    }

    if (command.kind === "stop") {
      state.stopGeneration();
      remoteFeishuQueueRef.current = [];
      void sendFeishuText(message, state.config.language === "en" ? "Stopped current generation and cleared the remote queue." : "已停止当前生成，并清空远程队列。");
      return;
    }

    if (!findFeishuPairedUser(feishuConfig, message.userId)) {
      state.upsertFeishuPairingRequest(createFeishuPairingRequest(message));
      void sendFeishuText(
        message,
        state.config.language === "en"
          ? `This Feishu user is not paired yet. Reply /pair ${feishuConfig.pairingCode} to pair.`
          : `当前飞书用户尚未配对。请回复 /pair ${feishuConfig.pairingCode} 完成配对。`,
      );
      return;
    }

    runFeishuRemoteMessage({ ...message, text: command.text });
  }, [runFeishuRemoteMessage, sendFeishuText, updateFeishuPairingConfig]);

  useEffect(() => {
    const feishuConfig = normalizeImAdaptersConfig(config.imAdapters).feishu;
    if (!feishuConfig.enabled) {
      void invoke("stop_feishu_adapter").catch(() => {});
      useAppStore.getState().setFeishuAdapterStatus({
        status: "stopped",
        running: false,
        message: config.language === "en" ? "Feishu adapter is disabled." : "飞书适配器未启用。",
      });
      return;
    }
    if (!feishuConfig.appId.trim() || !feishuConfig.appSecret.trim()) {
      useAppStore.getState().setFeishuAdapterStatus({
        status: "idle",
        running: false,
        message: config.language === "en" ? "Waiting for Feishu App ID and App Secret." : "等待填写飞书 App ID 和 App Secret。",
      });
      return;
    }
    if (feishuStartingRef.current) return;
    feishuStartingRef.current = true;
    void invoke("start_feishu_adapter", {
      config: {
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        domain: feishuConfig.domain,
      },
    })
      .then((status: any) => {
        useAppStore.getState().setFeishuAdapterStatus(status);
      })
      .catch((error) => {
        useAppStore.getState().setFeishuAdapterStatus({
          status: "error",
          running: false,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        feishuStartingRef.current = false;
      });
  }, [
    config.imAdapters?.feishu?.appId,
    config.imAdapters?.feishu?.appSecret,
    config.imAdapters?.feishu?.domain,
    config.imAdapters?.feishu?.enabled,
    config.language,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<FeishuAdapterEvent>("feishu-adapter-event", (event) => {
      const payload = event.payload;
      if (payload.type === "status" || payload.type === "error") {
        useAppStore.getState().setFeishuAdapterStatus({
          status: payload.status || (payload.type === "error" ? "error" : "idle"),
          running: payload.running === true,
          message: payload.message || "",
          pid: payload.pid ?? null,
          updatedAt: payload.timestamp || Date.now(),
        });
        return;
      }
      if (payload.type === "message") {
        handleFeishuInboundMessage(payload);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      unlisten?.();
    };
  }, [handleFeishuInboundMessage]);

  useEffect(() => {
    const state = useAppStore.getState();
    const busy = state.isGenerating || state.agentStatus === "running" || state.agentStatus === "pending_review";
    if (busy || remoteFeishuQueueRef.current.length === 0) return;
    const next = remoteFeishuQueueRef.current.shift();
    if (next) runFeishuRemoteMessage(next, true);
  }, [agentStatus, isStreaming, runFeishuRemoteMessage]);

  const startResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsResizing(true); };
  const startFilePanelResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsFilePanelResizing(true); };
  const startSidebarResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsSidebarResizing(true); };

  const sidebarWidthRef = useRef(sidebarWidth);
  const languageRef = useRef(config.language);
  const handleOpenWorkspacePathRef = useRef(handleOpenWorkspacePath);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    languageRef.current = config.language;
  }, [config.language]);

  useEffect(() => {
    handleOpenWorkspacePathRef.current = handleOpenWorkspacePath;
  }, [handleOpenWorkspacePath]);

  useEffect(() => {
    const MIN_SIDEBAR_WIDTH = 220;
    const MIN_RIGHT_PANEL_WIDTH = 340;
    const MIN_FILE_PANEL_WIDTH = 260;
    const MAX_FILE_PANEL_WIDTH = 520;
    const MIN_CHAT_INPUT_AREA_WIDTH = 368;

    const flushRightPanelWidth = () => {
      if (rightPanelResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(rightPanelResizeFrameRef.current);
        rightPanelResizeFrameRef.current = null;
      }
      const nextWidth = pendingRightPanelWidthRef.current;
      pendingRightPanelWidthRef.current = null;
      if (typeof nextWidth === "number") {
        setRightPanelWidth(nextWidth);
      }
    };

    const scheduleRightPanelWidth = (nextWidth: number) => {
      pendingRightPanelWidthRef.current = nextWidth;
      if (rightPanelResizeFrameRef.current !== null) return;
      rightPanelResizeFrameRef.current = window.requestAnimationFrame(() => {
        rightPanelResizeFrameRef.current = null;
        const width = pendingRightPanelWidthRef.current;
        pendingRightPanelWidthRef.current = null;
        if (typeof width === "number") {
          setRightPanelWidth(width);
        }
      });
    };

    const onMouseMove = (e: MouseEvent) => {
      if (isResizing) {
        let w = window.innerWidth - e.clientX;
        const reservedFileWidth = isFilePanelVisible ? filePanelWidth : 0;
        const maxRightPanelWidth = Math.max(
          MIN_RIGHT_PANEL_WIDTH,
          window.innerWidth - sidebarWidth - reservedFileWidth - MIN_CHAT_INPUT_AREA_WIDTH,
        );
        if (w < MIN_RIGHT_PANEL_WIDTH) w = MIN_RIGHT_PANEL_WIDTH;
        if (w > maxRightPanelWidth) w = maxRightPanelWidth;
        scheduleRightPanelWidth(w);
      } else if (isFilePanelResizing) {
        const reservedRightWidth = isRightPanelVisible ? rightPanelWidth : 0;
        let w = window.innerWidth - reservedRightWidth - e.clientX;
        const maxFilePanelWidth = Math.min(
          MAX_FILE_PANEL_WIDTH,
          Math.max(
            MIN_FILE_PANEL_WIDTH,
            window.innerWidth - sidebarWidth - reservedRightWidth - MIN_CHAT_INPUT_AREA_WIDTH,
          ),
        );
        if (w < MIN_FILE_PANEL_WIDTH) w = MIN_FILE_PANEL_WIDTH;
        if (w > maxFilePanelWidth) w = maxFilePanelWidth;
        setFilePanelWidth(w);
      } else if (isSidebarResizing) {
        let w = e.clientX;
        if (w < MIN_SIDEBAR_WIDTH) w = MIN_SIDEBAR_WIDTH;
        if (w > 500) w = 500;
        setSidebarWidth(w);
      }
    };
    const onMouseUp = () => {
      flushRightPanelWidth();
      setIsResizing(false);
      setIsFilePanelResizing(false);
      setIsSidebarResizing(false);
    };

    if (isResizing || isFilePanelResizing || isSidebarResizing) {
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (rightPanelResizeFrameRef.current !== null && !isResizing) {
        window.cancelAnimationFrame(rightPanelResizeFrameRef.current);
        rightPanelResizeFrameRef.current = null;
        pendingRightPanelWidthRef.current = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [
    filePanelWidth,
    isFilePanelResizing,
    isFilePanelVisible,
    isRightPanelVisible,
    isResizing,
    isSidebarResizing,
    rightPanelWidth,
    setFilePanelWidth,
    setRightPanelWidth,
    setSidebarWidth,
    sidebarWidth,
  ]);

  useEffect(() => {
    const MIN_CENTER_WIDTH = 368;
    const MIN_SIDEBAR_WIDTH = 220;
    const MIN_RIGHT_PANEL_WIDTH = 340;
    const MIN_FILE_PANEL_WIDTH = 260;
    const MAX_FILE_PANEL_WIDTH = 520;

    const clampLayout = () => {
      const totalWidth = window.innerWidth;
      let rightWidth = isRightPanelVisible ? rightPanelWidth : 0;
      let fileWidth = isFilePanelVisible ? filePanelWidth : 0;

      if (isRightPanelVisible) {
        const minWithRightOnly = MIN_CENTER_WIDTH + MIN_SIDEBAR_WIDTH + MIN_RIGHT_PANEL_WIDTH + fileWidth;

        if (totalWidth < minWithRightOnly) {
          closeRightPanel();
          rightWidth = 0;
        }
      }

      if (isFilePanelVisible) {
        const minWithFile = MIN_CENTER_WIDTH + MIN_SIDEBAR_WIDTH + MIN_FILE_PANEL_WIDTH + rightWidth;

        if (totalWidth < minWithFile) {
          closeFilePanel();
          fileWidth = 0;
        }
      }

      const nextSidebarMax = Math.max(MIN_SIDEBAR_WIDTH, totalWidth - rightWidth - fileWidth - MIN_CENTER_WIDTH);
      const nextSidebar = Math.min(sidebarWidth, nextSidebarMax);
      if (nextSidebar !== sidebarWidth) {
        setSidebarWidth(nextSidebar);
      }

      const nextFileMax = Math.min(
        MAX_FILE_PANEL_WIDTH,
        Math.max(MIN_FILE_PANEL_WIDTH, totalWidth - nextSidebar - rightWidth - MIN_CENTER_WIDTH),
      );
      if (isFilePanelVisible && filePanelWidth > nextFileMax) {
        setFilePanelWidth(nextFileMax);
        fileWidth = nextFileMax;
      }

      const nextRightMax = Math.max(MIN_RIGHT_PANEL_WIDTH, totalWidth - nextSidebar - fileWidth - MIN_CENTER_WIDTH);
      if (isRightPanelVisible && rightPanelWidth > nextRightMax) {
        setRightPanelWidth(nextRightMax);
      }
    };

    clampLayout();
    window.addEventListener("resize", clampLayout);
    return () => window.removeEventListener("resize", clampLayout);
  }, [
    closeFilePanel,
    closeRightPanel,
    filePanelWidth,
    isFilePanelVisible,
    isRightPanelVisible,
    rightPanelWidth,
    setFilePanelWidth,
    setRightPanelWidth,
    setSidebarWidth,
    sidebarWidth,
  ]);

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    window.addEventListener("contextmenu", preventNativeContextMenu, true);
    return () => {
      window.removeEventListener("contextmenu", preventNativeContextMenu, true);
    };
  }, []);

  useEffect(() => {
    if (!currentSessionId || taskFlow.length > 0) return;
    const target = (useAppStore.getState().sessionsByWorkspace[activeSessionScope] || []).find((s: any) => s.id === currentSessionId);
    if (!target) return;
    if (target.runtimeSnapshot || target.messages?.length || target.storageStatus === "ok" || target.storageStatus === "missing") {
      void restoreSessionState(target, currentSessionId, activeSessionScope);
    }
  }, [activeSessionScope, currentSessionId, taskFlow.length]);

  useEffect(() => {
    let unlisten: (() => void | Promise<void>) | null = null;
    let disposed = false;
    const safelyDispose = (dispose: (() => void | Promise<void>) | null) => {
      if (!dispose) return;
      try {
        const result = dispose();
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch(() => {});
        }
      } catch {
        // Listener cleanup can race during hot reload or rapid webview navigation.
      }
    };

    void (async () => {
      try {
        const dispose = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setIsWorkspaceDropActive(payload.position.x <= sidebarWidthRef.current);
            return;
          }
          if (payload.type === "leave") {
            setIsWorkspaceDropActive(false);
            return;
          }
          if (payload.type !== "drop") return;

          const isSidebarDrop = payload.position.x <= sidebarWidthRef.current;
          setIsWorkspaceDropActive(false);
          if (!isSidebarDrop) return;

          void (async () => {
            const added: Array<{ path: string; rebuildIndex: boolean }> = [];
            let ignoredFiles = 0;
            for (const path of payload.paths || []) {
              try {
                const stablePath = await canonicalizeWorkspacePath(path);
                const wasKnownWorkspace = useAppStore.getState().workspaces.some((entry: any) => entry.path === stablePath);
                addWorkspaceEntry(stablePath);
                added.push({ path: stablePath, rebuildIndex: !wasKnownWorkspace });
              } catch {
                ignoredFiles += 1;
                // Dragging files is intentionally ignored here; only folders become workspaces.
              }
            }
            if (added.length > 0) {
              const [firstWorkspace, ...backgroundWorkspaces] = added;
              await handleOpenWorkspacePathRef.current(firstWorkspace.path, {
                selectFirstSession: true,
                rebuildIndex: firstWorkspace.rebuildIndex,
              });
              backgroundWorkspaces.forEach(({ path, rebuildIndex }) => {
                if (rebuildIndex) void refreshSessionsForScope(path, { rebuildIndex: true });
              });
            } else if (ignoredFiles > 0) {
              window.alert(languageRef.current === "en" ? "Drop folders to add workspaces." : "请拖拽文件夹来加入工作区。");
            }
          })();
        });

        if (disposed) {
          safelyDispose(dispose);
          return;
        }
        unlisten = dispose;
      } catch {
        // Browser/e2e environments without Tauri simply skip native folder drop.
      }
    })();

    return () => {
      disposed = true;
      safelyDispose(unlisten);
    };
  }, [addWorkspaceEntry, refreshSessionsForScope]);

  return (
    <div className="flex h-screen w-full bg-[#000000] text-[#e4e4e7] font-sans text-sm overflow-hidden md:flex-row flex-col relative"
      style={{ '--accent': currentTheme.accent, '--accent-hover': currentTheme.hover, '--accent-light': currentTheme.light, '--accent-subtle': currentTheme.subtle, '--accent-subtle-border': currentTheme.subtleBorder } as React.CSSProperties}>
      <ThemeStyles />
      <Sidebar
        config={{ ...config, onOpenSettings: () => { setSettingsTab('general'); setIsSettingsOpen(true); }, onOpenSkills: () => setIsSkillsOpen(true) }}
        t={t}
        currentWorkspace={currentWorkspace}
        selectedWorkspace={sidebarWorkspace}
        workspaces={workspaces}
        sessionsByWorkspace={sessionsByWorkspace}
        globalSessions={globalSessions}
        currentSessionId={currentSessionId}
        activeSessionByWorkspace={activeSessionByWorkspace}
        sidebarWidth={sidebarWidth}
        workspaceStatuses={workspaceStatuses}
        sessionStatuses={sessionStatuses}
        isWorkspaceDropActive={isWorkspaceDropActive}
        onSetSidebarWidth={setSidebarWidth}
        onStartResizing={startSidebarResizing}
        onOpenGlobalChat={handleOpenGlobalChat}
        onAddWorkspace={handleSelectWorkspace}
        onSelectWorkspace={handleSelectWorkspace}
        onSelectWorkspaceRoot={(path) => void handleOpenWorkspacePath(path, { selectFirstSession: true })}
        onRemoveWorkspaceEntry={handleRemoveWorkspaceEntry}
        onCreateSession={handleCreateSessionForScope}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
      />
      <ChatArea taskFlow={taskFlow} t={t} config={config} setSettingsTab={setSettingsTab} setIsSettingsOpen={setIsSettingsOpen} activeDiffTask={activeDiffTask} endOfFlowRef={endOfFlowRef} isStreaming={isStreaming} elapsedTime={elapsedTime} activeSessionKey={activeSessionKey} onStopGeneration={handleStopGeneration} allowToolAction={allowToolAction} rejectToolAction={rejectToolAction} autoApproveTools={autoApproveTools} onToggleAutoApprove={setAutoApproveTools} input={input} setInput={setInput} contextMentions={contextMentions} setContextMentions={setContextMentions} attachedFiles={attachedFiles} setAttachedFiles={setAttachedFiles} onAttachFile={handleAttachFile} showAgentPicker={showAgentPicker} setShowAgentPicker={setShowAgentPicker} selectedMainModeKey={selectedMainModeKey} setSelectedMainModeKey={setSelectedMainModeKey} mainModes={mainModes} activeStudioAgentKey={activeStudioAgentKey} setActiveStudioAgentKey={setActiveStudioAgentKey} gameStudioInitialized={gameStudioInitialized} initializeGameStudioWorkspace={initializeGameStudioWorkspace} removeGameStudioWorkspace={removeGameStudioWorkspace} currentWorkspace={currentWorkspace} handleAcceptInline={handleAcceptInline} handleRejectInline={handleRejectInline} onSendMessage={handleSendMessage} onQuickReply={handleQuickReply} />
      <FilePanel width={filePanelWidth} onStartResizing={startFilePanelResizing} />
      <RightPanel activeDiffTask={activeDiffTask} rightPanelWidth={rightPanelWidth} startResizing={startResizing} />
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} config={config} setConfig={setConfig} t={t} THEMES={THEMES} settingsTab={settingsTab} setSettingsTab={setSettingsTab} mcpServers={mcpServers} setMcpServers={setMcpServers} mcpDiscoveredTools={mcpDiscoveredTools} setMcpDiscoveredTools={setMcpDiscoveredTools} />
      <SkillsModal isOpen={isSkillsOpen} onClose={() => setIsSkillsOpen(false)} t={t} skills={skills} currentWorkspace={currentWorkspace} toggleSkill={toggleSkill} deleteSkill={deleteSkill} addSkill={addSkill} updateSkill={updateSkill} isAddingSkill={isAddingSkill} setIsAddingSkill={setIsAddingSkill} />
    </div>
  );
}
