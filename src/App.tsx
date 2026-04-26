import { useRef, useEffect, useCallback, useState } from "react";
import { open } from '@tauri-apps/plugin-dialog';

import Sidebar from "./components/Sidebar";
import WorkspaceTreePanel from "./components/WorkspaceTreePanel";
import ChatArea from "./components/ChatArea";
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
  sanitizeAgentMessagesForPersist,
  sanitizeTaskBlocksForPersist,
  syncTaskIdCounterFromBlocks,
} from "./store/useAppStore";
import { getE2EQuickReplyHandler, initializeE2EScenarios } from "./lib/e2e";
import { setWorkspaceRoot as setWorkspaceRootIpc } from "./lib/ipc";
import { normalizeStudioAgentKey } from "./lib/gameStudioCatalog";
import { MAIN_MODE_KEYS, mapLegacyNexusModeToMainMode, mapMainModeToLegacyNexusMode } from "./lib/mainModes";
import { resolveConversationTurnIntent } from "./lib/runIntent";
import { runAfterNextPaint } from "./lib/uiScheduling";
import { normalizeConversationDisplayTitle } from "./lib/workflowModels";
import { appendDebugLog } from "./lib/debugLog";

// ==========================================
// MAIN APP COMPONENT
// ==========================================
export default function App() {
  const endOfFlowRef = useRef<HTMLDivElement>(null);

  const {
    sessionsByWorkspace, currentWorkspace, currentSessionId,
    setCurrentWorkspace, addSession, removeSession, updateSession, setCurrentSessionId,
    allowToolAction, rejectToolAction,
    autoApproveTools, setAutoApproveTools,
    mcpServers, setMcpServers, mcpDiscoveredTools, setMcpDiscoveredTools,
  } = useAppStore();

  // ── Config ────────────────────────────────────────────────────────────
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  const t = translations[config.language] || translations.en;
  const currentTheme = THEMES[config.theme] || THEMES.purple;

  // ── Agent State (from store, replaces all inline implementations) ─────
  const taskFlow = useAppStore((s) => s.taskFlow);
  const agentMessages = useAppStore((s) => s.agentMessages);
  const conversationTurns = useAppStore((s) => s.conversationTurns);
  const currentTurnId = useAppStore((s) => s.currentTurnId);
  const planArtifacts = useAppStore((s) => s.planArtifacts);
  const planTasks = useAppStore((s) => s.planTasks);
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
  const elapsedTime = useAppStore((s) => s.elapsedTime);

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
  const globalSessions = sessionsByWorkspace[GLOBAL_CHAT_KEY] || [];
  const sidebarWorkspace = selectedWorkspace || currentWorkspace;

  // ── Layout State ──────────────────────────────────────────────────────
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const showWorkspaceTreePanel = useAppStore((s) => s.showWorkspaceTreePanel);
  const workspaceTreePanelWidth = useAppStore((s) => s.workspaceTreePanelWidth);
  const setRightPanelWidth = useAppStore((s) => s.setRightPanelWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const setShowWorkspaceTreePanel = useAppStore((s) => s.setShowWorkspaceTreePanel);
  const toggleWorkspaceTreePanel = useAppStore((s) => s.toggleWorkspaceTreePanel);
  const setWorkspaceTreePanelWidth = useAppStore((s) => s.setWorkspaceTreePanelWidth);
  const closeRightPanel = useAppStore((s) => s.closeRightPanel);
  const isRightPanelVisible = showPlanPanel || showDiff || showTerminal || showFilePanel;
  // isResizing is local UI state (mouse drag), not in the store
  const [isResizing, setIsResizing] = useState(false);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isWorkspaceTreeResizing, setIsWorkspaceTreeResizing] = useState(false);

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

  // ── Skills ────────────────────────────────────────────────────────────
  const skills = useAppStore((s) => s.skills);
  const toggleSkill = useAppStore((s) => s.toggleSkill);
  const deleteSkill = useAppStore((s) => s.deleteSkill);
  const addSkill = useAppStore((s) => s.addSkill);
  const updateSkill = useAppStore((s) => s.updateSkill);

  useEffect(() => initializeE2EScenarios(), []);
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

    updateSession(activeSessionScope, currentSessionId, {
      messages: sanitizeTaskBlocksForPersist(taskFlow),
      runtimeSnapshot: {
        taskFlow: sanitizeTaskBlocksForPersist(taskFlow),
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
        planExecutionEvidenceCount,
        planStage,
        isPlanApproved,
        showPlanPanel,
        showDiff,
        showTerminal,
        showFilePanel,
        rightPanelTab,
        selectedDiffTaskId,
      },
    });
  }, [
    agentMessages,
    activeSessionScope,
    conversationTurns,
    currentSessionId,
    currentTurnId,
    gameStudioInitialized,
    isPlanApproved,
    pendingSlashCommand,
    planArtifacts,
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

  const handleQuickReply = useCallback((text: string, sourceTurnId?: string) => {
    const e2eQuickReplyHandler = getE2EQuickReplyHandler();
    if (e2eQuickReplyHandler?.(text, sourceTurnId)) {
      return;
    }

    const state = useAppStore.getState();
    const reuseCurrentTurn = !!sourceTurnId && sourceTurnId === state.currentTurnId;
    appendDebugLog("info", "ui.quickReply", {
      text,
      sourceTurnId,
      currentTurnId: state.currentTurnId,
      reuseCurrentTurn,
      currentTurnStatus: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.status
        : null,
      taskFlowBlocks: state.taskFlow.length,
      agentMessages: state.agentMessages.length,
    });
    const sendOptions = reuseCurrentTurn
      ? {
          reuseCurrentTurn: true,
          preservePlanState:
            resolveConversationTurnIntent(
              state.currentTurnId
                ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
                : null,
            ) === "plan",
        }
      : undefined;

    useAppStore.setState({
      input: "",
      contextMentions: [],
      attachedFiles: [],
    });

    runAfterNextPaint(() => {
      useAppStore.getState().sendMessage(text, undefined, sendOptions);
    });
  }, []);

  const handleStopGeneration = useCallback(() => {
    useAppStore.getState().stopGeneration();
  }, []);

  // --- Workspace & Session Management ---
  const restoreSessionState = (target: any, id: number) => {
    const startedAt = performance.now();
    if (target?.runtimeSnapshot) {
      const snapshot = target.runtimeSnapshot;
      const restoredTaskFlow = sanitizeTaskBlocksForPersist(snapshot.taskFlow || target.messages || []);
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
        conversationTurns: snapshot.conversationTurns || [],
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
        planArtifacts: snapshot.planArtifacts || [],
        planTasks: snapshot.planTasks || [],
        planExecutionEvidenceCount: snapshot.planExecutionEvidenceCount ?? 0,
        planStage: snapshot.planStage ?? 'idle',
        isPlanApproved: snapshot.isPlanApproved ?? false,
        showPlanPanel: snapshot.showPlanPanel ?? false,
        showDiff: snapshot.showDiff ?? false,
        showTerminal: snapshot.showTerminal ?? false,
        showFilePanel: snapshot.showFilePanel ?? false,
        rightPanelTab: snapshot.rightPanelTab ?? 'plan',
        elapsedTime: 0,
      });
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        mode: "runtimeSnapshot",
        elapsedMs: Math.round(performance.now() - startedAt),
        taskFlowBlocks: restoredTaskFlow.length,
        agentMessages: (snapshot.agentMessages || []).length,
        conversationTurns: (snapshot.conversationTurns || []).length,
      });
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
        rightPanelTab: 'plan',
      });
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        mode: "messages",
        elapsedMs: Math.round(performance.now() - startedAt),
        taskFlowBlocks: target.messages.length,
      });
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
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: 'plan',
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceCount: 0,
      planStage: 'idle',
      isPlanApproved: false,
    });
    appendDebugLog("info", "session.restore", {
      sessionId: id,
      mode: "empty",
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  };

  const openSessionScope = (scopeKey: string) => {
    setCurrentWorkspace(scopeKey === GLOBAL_CHAT_KEY ? "" : scopeKey);
    useAppStore.getState().resetForWorkspace();
  };

  const handleSelectWorkspace = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select Project Workspace' });
      if (selected) {
        const state = useAppStore.getState();
        const liveScope = resolveSessionWorkspaceKey(state.currentWorkspace);
        if (state.currentSessionId) {
          state.updateSession(liveScope, state.currentSessionId, { messages: sanitizeTaskBlocksForPersist(taskFlow) });
        }
        // Register workspace root in Rust backend BEFORE updating frontend state
        // to avoid race condition with file listing in Composer
        try { await setWorkspaceRootIpc(selected); } catch {}
        setCurrentWorkspace(selected);
        setCurrentSessionId(null);
        state.resetForWorkspace();
        const existing = useAppStore.getState().sessionsByWorkspace[selected] || [];
        if (existing.length === 0) handleCreateSessionForScope(selected);
        else handleSelectSession(selected, existing[0].id);
      }
    } catch (error) { console.error('Failed to select workspace:', error); }
  };

  const handleOpenGlobalChat = () => {
    const state = useAppStore.getState();
    if (!state.currentWorkspace && state.currentSessionId) return;
    const liveScope = resolveSessionWorkspaceKey(state.currentWorkspace);
    if (state.currentSessionId) {
      updateSession(liveScope, state.currentSessionId, {
        messages: sanitizeTaskBlocksForPersist(taskFlow),
        active: false,
      });
    }

    openSessionScope(GLOBAL_CHAT_KEY);
    const existing = useAppStore.getState().sessionsByWorkspace[GLOBAL_CHAT_KEY] || [];
    if (existing.length === 0) {
      setCurrentSessionId(null);
      return;
    }

    const targetSession = existing.find((session: any) => session.active) || existing[0];
    updateSession(GLOBAL_CHAT_KEY, targetSession.id, { active: true });
    setCurrentSessionId(targetSession.id);
    restoreSessionState(targetSession, targetSession.id);
  };

  const handleCreateSessionForScope = (scopeKey: string) => {
    if (!scopeKey) return;

    const state = useAppStore.getState();
    const liveScope = resolveSessionWorkspaceKey(state.currentWorkspace);
    if (state.currentSessionId) {
      updateSession(liveScope, state.currentSessionId, {
        messages: sanitizeTaskBlocksForPersist(taskFlow),
        active: false,
      });
    }

    const isGlobalChat = scopeKey === GLOBAL_CHAT_KEY;
    const ns = {
      id: Date.now(),
      title: isGlobalChat
        ? (config.language === "en" ? "New Chat" : "新聊天")
        : (config.language === "en" ? "New Conversation" : "新会话"),
      date: new Date().toISOString(),
      active: true,
      messages: [] as TaskBlock[],
    };
    const existing = useAppStore.getState().sessionsByWorkspace[scopeKey] || [];
    existing.forEach((ses: any) => { if (ses.active) updateSession(scopeKey, ses.id, { active: false }); });
    openSessionScope(scopeKey);
    addSession(scopeKey, { ...ns, active: true });
    setCurrentSessionId(ns.id);
  };

  const handleSelectSession = (scopeKey: string, id: number) => {
    const state = useAppStore.getState();
    const liveScope = resolveSessionWorkspaceKey(state.currentWorkspace);
    if (state.currentSessionId) {
      updateSession(liveScope, state.currentSessionId, {
        messages: sanitizeTaskBlocksForPersist(taskFlow),
        active: false,
      });
    }

    openSessionScope(scopeKey);
    updateSession(scopeKey, id, { active: true });
    setCurrentSessionId(id);
    const target = (useAppStore.getState().sessionsByWorkspace[scopeKey] || []).find((s: any) => s.id === id);
    restoreSessionState(target, id);
  };

  const handleDeleteSession = (scopeKey: string, id: number) => {
    const state = useAppStore.getState();
    const wasCurrent = scopeKey === resolveSessionWorkspaceKey(state.currentWorkspace) && id === state.currentSessionId;
    removeSession(scopeKey, id);
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
        planExecutionEvidenceCount: 0,
      });
    }
  };

  const startResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsResizing(true); };
  const startSidebarResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsSidebarResizing(true); };
  const startWorkspaceTreeResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsWorkspaceTreeResizing(true); };

  useEffect(() => {
    const MIN_SIDEBAR_WIDTH = 220;
    const MIN_WORKSPACE_TREE_WIDTH = 220;
    const MIN_RIGHT_PANEL_WIDTH = 340;
    const MIN_CHAT_INPUT_AREA_WIDTH = 368;

    const onMouseMove = (e: MouseEvent) => {
      if (isResizing) {
        let w = window.innerWidth - e.clientX;
        const workspaceTreeWidth = showWorkspaceTreePanel ? workspaceTreePanelWidth : 0;
        const maxRightPanelWidth = Math.max(
          MIN_RIGHT_PANEL_WIDTH,
          window.innerWidth - sidebarWidth - workspaceTreeWidth - MIN_CHAT_INPUT_AREA_WIDTH,
        );
        if (w < MIN_RIGHT_PANEL_WIDTH) w = MIN_RIGHT_PANEL_WIDTH;
        if (w > maxRightPanelWidth) w = maxRightPanelWidth;
        setRightPanelWidth(w);
      } else if (isWorkspaceTreeResizing) {
        let w = e.clientX - sidebarWidth;
        if (w < MIN_WORKSPACE_TREE_WIDTH) w = MIN_WORKSPACE_TREE_WIDTH;
        if (w > 520) w = 520;
        setWorkspaceTreePanelWidth(w);
      } else if (isSidebarResizing) {
        let w = e.clientX;
        if (w < MIN_SIDEBAR_WIDTH) w = MIN_SIDEBAR_WIDTH;
        if (w > 500) w = 500;
        setSidebarWidth(w);
      }
    };
    const onMouseUp = () => {
      setIsResizing(false);
      setIsSidebarResizing(false);
      setIsWorkspaceTreeResizing(false);
    };

    if (isResizing || isSidebarResizing || isWorkspaceTreeResizing) {
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [
    isResizing,
    isSidebarResizing,
    isWorkspaceTreeResizing,
    setRightPanelWidth,
    setSidebarWidth,
    setWorkspaceTreePanelWidth,
    showWorkspaceTreePanel,
    sidebarWidth,
    workspaceTreePanelWidth,
  ]);

  useEffect(() => {
    const MIN_CENTER_WIDTH = 368;
    const MIN_SIDEBAR_WIDTH = 220;
    const MIN_WORKSPACE_TREE_WIDTH = 220;
    const MIN_RIGHT_PANEL_WIDTH = 340;

    const clampLayout = () => {
      const totalWidth = window.innerWidth;
      let nextShowWorkspaceTreePanel = showWorkspaceTreePanel;
      const workspaceTreeWidth = nextShowWorkspaceTreePanel ? workspaceTreePanelWidth : 0;
      let rightWidth = isRightPanelVisible ? rightPanelWidth : 0;

      if (isRightPanelVisible) {
        const minWithRightAndTree = MIN_CENTER_WIDTH + MIN_SIDEBAR_WIDTH + workspaceTreeWidth + MIN_RIGHT_PANEL_WIDTH;
        const minWithRightOnly = MIN_CENTER_WIDTH + MIN_SIDEBAR_WIDTH + MIN_RIGHT_PANEL_WIDTH;

        if (nextShowWorkspaceTreePanel && totalWidth < minWithRightAndTree && totalWidth >= minWithRightOnly) {
          nextShowWorkspaceTreePanel = false;
          setShowWorkspaceTreePanel(false);
        } else if (totalWidth < minWithRightOnly) {
          closeRightPanel();
          rightWidth = 0;
        }
      }

      const availableForTree = totalWidth - MIN_CENTER_WIDTH - sidebarWidth - rightWidth;
      if (nextShowWorkspaceTreePanel) {
        if (availableForTree < MIN_WORKSPACE_TREE_WIDTH) {
          nextShowWorkspaceTreePanel = false;
          setShowWorkspaceTreePanel(false);
        } else if (workspaceTreePanelWidth > availableForTree) {
          setWorkspaceTreePanelWidth(availableForTree);
        }
      }

      const effectiveTreeWidth = nextShowWorkspaceTreePanel
        ? Math.min(workspaceTreePanelWidth, Math.max(MIN_WORKSPACE_TREE_WIDTH, availableForTree))
        : 0;
      const nextSidebarMax = Math.max(MIN_SIDEBAR_WIDTH, totalWidth - rightWidth - effectiveTreeWidth - MIN_CENTER_WIDTH);
      const nextSidebar = Math.min(sidebarWidth, nextSidebarMax);
      if (nextSidebar !== sidebarWidth) {
        setSidebarWidth(nextSidebar);
      }

      const nextRightMax = Math.max(MIN_RIGHT_PANEL_WIDTH, totalWidth - nextSidebar - effectiveTreeWidth - MIN_CENTER_WIDTH);
      if (isRightPanelVisible && rightPanelWidth > nextRightMax) {
        setRightPanelWidth(nextRightMax);
      }
    };

    clampLayout();
    window.addEventListener("resize", clampLayout);
    return () => window.removeEventListener("resize", clampLayout);
  }, [
    closeRightPanel,
    isRightPanelVisible,
    rightPanelWidth,
    setRightPanelWidth,
    setShowWorkspaceTreePanel,
    setSidebarWidth,
    setWorkspaceTreePanelWidth,
    showWorkspaceTreePanel,
    sidebarWidth,
    workspaceTreePanelWidth,
  ]);

  useEffect(() => {
    if (!currentSessionId || taskFlow.length > 0) return;
    const target = (useAppStore.getState().sessionsByWorkspace[activeSessionScope] || []).find((s: any) => s.id === currentSessionId);
    if (!target) return;
    if (target.runtimeSnapshot || target.messages?.length) {
      restoreSessionState(target, currentSessionId);
    }
  }, [activeSessionScope, currentSessionId, taskFlow.length]);

  return (
    <div className="flex h-screen w-full bg-[#000000] text-[#e4e4e7] font-sans text-sm overflow-hidden md:flex-row flex-col relative"
      style={{ '--accent': currentTheme.accent, '--accent-hover': currentTheme.hover, '--accent-light': currentTheme.light, '--accent-subtle': currentTheme.subtle, '--accent-subtle-border': currentTheme.subtleBorder } as React.CSSProperties}>
      <ThemeStyles />
      <Sidebar config={{ ...config, onOpenSettings: () => { setSettingsTab('general'); setIsSettingsOpen(true); }, onOpenSkills: () => setIsSkillsOpen(true) }} t={t} currentWorkspace={currentWorkspace} selectedWorkspace={sidebarWorkspace} sessionsByWorkspace={sessionsByWorkspace} globalSessions={globalSessions} currentSessionId={currentSessionId} sidebarWidth={sidebarWidth} showWorkspaceTreePanel={showWorkspaceTreePanel} onSetSidebarWidth={setSidebarWidth} onStartResizing={startSidebarResizing} onOpenGlobalChat={handleOpenGlobalChat} onSelectWorkspace={handleSelectWorkspace} onCreateSession={handleCreateSessionForScope} onSelectSession={handleSelectSession} onDeleteSession={handleDeleteSession} onToggleWorkspaceTree={toggleWorkspaceTreePanel} />
      {showWorkspaceTreePanel && sidebarWorkspace && (
        <WorkspaceTreePanel
          currentWorkspace={sidebarWorkspace}
          language={config.language}
          width={workspaceTreePanelWidth}
          onClose={() => setShowWorkspaceTreePanel(false)}
          onStartResizing={startWorkspaceTreeResizing}
        />
      )}
      <ChatArea taskFlow={taskFlow} t={t} config={config} setSettingsTab={setSettingsTab} setIsSettingsOpen={setIsSettingsOpen} activeDiffTask={activeDiffTask} endOfFlowRef={endOfFlowRef} isStreaming={isStreaming} elapsedTime={elapsedTime} onStopGeneration={handleStopGeneration} allowToolAction={allowToolAction} rejectToolAction={rejectToolAction} autoApproveTools={autoApproveTools} onToggleAutoApprove={setAutoApproveTools} input={input} setInput={setInput} contextMentions={contextMentions} setContextMentions={setContextMentions} attachedFiles={attachedFiles} setAttachedFiles={setAttachedFiles} onAttachFile={handleAttachFile} showAgentPicker={showAgentPicker} setShowAgentPicker={setShowAgentPicker} selectedMainModeKey={selectedMainModeKey} setSelectedMainModeKey={setSelectedMainModeKey} mainModes={mainModes} activeStudioAgentKey={activeStudioAgentKey} setActiveStudioAgentKey={setActiveStudioAgentKey} gameStudioInitialized={gameStudioInitialized} initializeGameStudioWorkspace={initializeGameStudioWorkspace} removeGameStudioWorkspace={removeGameStudioWorkspace} currentWorkspace={currentWorkspace} handleAcceptInline={handleAcceptInline} handleRejectInline={handleRejectInline} onSendMessage={handleSendMessage} onQuickReply={handleQuickReply} />
      <RightPanel activeDiffTask={activeDiffTask} rightPanelWidth={rightPanelWidth} startResizing={startResizing} />
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} config={config} setConfig={setConfig} t={t} THEMES={THEMES} settingsTab={settingsTab} setSettingsTab={setSettingsTab} mcpServers={mcpServers} setMcpServers={setMcpServers} mcpDiscoveredTools={mcpDiscoveredTools} setMcpDiscoveredTools={setMcpDiscoveredTools} />
      <SkillsModal isOpen={isSkillsOpen} onClose={() => setIsSkillsOpen(false)} t={t} skills={skills} currentWorkspace={currentWorkspace} toggleSkill={toggleSkill} deleteSkill={deleteSkill} addSkill={addSkill} updateSkill={updateSkill} isAddingSkill={isAddingSkill} setIsAddingSkill={setIsAddingSkill} />
    </div>
  );
}
