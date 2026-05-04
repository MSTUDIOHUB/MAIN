// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import {
  IconBook,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconPlus,
  IconSettings,
  IconTrash,
} from "./Icons";
import { GLOBAL_CHAT_KEY, type WorkspaceEntry } from "../store/useAppStore";
import { looksLikeReasoningLeakTitle, normalizeConversationDisplayTitle } from "../lib/workflowModels";

const IconLogoM = ({ className, ...props }: { className?: string; [key: string]: any }) => (
  <svg
    {...props}
    className={className ? `shrink-0 ${className}` : "shrink-0 h-5 w-5"}
    viewBox="194 205 130 117"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M323.961 212.5V307L297.98 322V243.983L258.98 266.5L219.98 243.983V322L194 307V212.5L206.99 205L258.98 235.017L310.971 205L323.961 212.5Z" />
  </svg>
);

interface SidebarProps {
  config: Record<string, any> & { onOpenSettings: () => void; onOpenSkills: () => void };
  t: Record<string, string>;
  currentWorkspace: string;
  selectedWorkspace: string;
  workspaces?: WorkspaceEntry[];
  sessionsByWorkspace: Record<string, any[]>;
  globalSessions: any[];
  currentSessionId: number | null;
  activeSessionByWorkspace?: Record<string, number | null>;
  sidebarWidth: number;
  workspaceStatuses?: Record<string, string>;
  sessionStatuses?: Record<string, string>;
  isWorkspaceDropActive?: boolean;
  onSetSidebarWidth: (w: number) => void;
  onOpenGlobalChat: () => void;
  onAddWorkspace: () => void;
  onSelectWorkspace: () => void;
  onSelectWorkspaceRoot?: (path: string) => void;
  onRemoveWorkspaceEntry?: (path: string) => void;
  onCreateSession: (scopeKey: string) => void;
  onSelectSession: (scopeKey: string, id: number) => void;
  onDeleteSession: (scopeKey: string, id: number) => void;
  onStartResizing?: (e: React.MouseEvent) => void;
}

function getWorkspaceName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function sortSessions(sessions: any[]) {
  return [...(sessions || [])].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA;
  });
}

export default function Sidebar({
  config,
  t,
  currentWorkspace = "",
  selectedWorkspace = "",
  workspaces = [],
  sessionsByWorkspace = {},
  globalSessions = [],
  currentSessionId = null,
  activeSessionByWorkspace = {},
  sidebarWidth = 260,
  workspaceStatuses = {},
  sessionStatuses = {},
  isWorkspaceDropActive = false,
  onOpenGlobalChat,
  onAddWorkspace,
  onSelectWorkspace,
  onSelectWorkspaceRoot,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onRemoveWorkspaceEntry,
  onStartResizing,
}: SidebarProps) {
  const [chatExpanded, setChatExpanded] = useState(true);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const activeWorkspace = selectedWorkspace || currentWorkspace;

  const workspaceEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries = [...workspaces];
    return entries.filter((entry) => {
      if (!entry?.path || seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    });
  }, [workspaces]);

  useEffect(() => {
    if (!activeWorkspace) return;
    setExpandedWorkspaces((prev) => (
      activeWorkspace in prev ? prev : { ...prev, [activeWorkspace]: true }
    ));
  }, [activeWorkspace]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "";
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  const projectChatsLabel = config.language === "en" ? "Projects" : "项目";
  const chatLabel = config.language === "en" ? "Chat" : "聊天";
  const newLabel = config.language === "en" ? "New" : "新建";
  const addWorkspaceLabel = config.language === "en" ? "New Project" : "新项目";
  const missingLabel = config.language === "en" ? "Missing details" : "详情缺失";
  const dropHint = config.language === "en" ? "Drop folders here to add workspaces" : "拖拽文件夹到这里加入工作区";

  const resolveSessionDisplayTitle = (session: any) => {
    const fallback = config.language === "en" ? "New chat" : "新聊天";
    const currentTitle = normalizeConversationDisplayTitle(session?.title || "", 48, "");
    if (currentTitle && !looksLikeReasoningLeakTitle(currentTitle)) {
      return currentTitle;
    }

    const turns = Array.isArray(session?.runtimeSnapshot?.conversationTurns)
      ? session.runtimeSnapshot.conversationTurns
      : [];
    const seedTurn = turns[0] || turns[turns.length - 1] || null;
    return normalizeConversationDisplayTitle(
      seedTurn?.title || seedTurn?.intentSummary || session?.title || "",
      48,
      fallback,
    );
  };

  const renderSession = (workspacePath: string, session: any, activeSessionId: number | null) => {
    const isActive = activeWorkspace === workspacePath && session.id === activeSessionId;
    const sessionStatus = sessionStatuses[`${workspacePath}:${session.id}`] || "idle";
    const showSessionStatus = sessionStatus && sessionStatus !== "idle";
    return (
      <div
        key={session.id}
        onClick={() => onSelectSession?.(workspacePath, session.id)}
        className={`group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors ${
          isActive ? "bg-[#18181b] text-[#ffffff] shadow-sm" : "text-[#e4e4e7] hover:bg-[#18181b]"
        }`}
      >
        <IconChat className={isActive ? "h-3.5 w-3.5 shrink-0 theme-text" : "h-3.5 w-3.5 shrink-0 text-[#71717a]"} />
        {showSessionStatus && (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              sessionStatus === "error" ? "bg-[#f87171]" : sessionStatus === "pending_review" ? "bg-[#facc15]" : "bg-[var(--accent)]"
            }`}
            title={sessionStatus}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="sidebar-session-title truncate text-[13px]">{resolveSessionDisplayTitle(session)}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-[#71717a]">
            <span>{formatDate(session.date)}</span>
            {session.storageStatus === "missing" && (
              <span className="rounded border border-[#7f1d1d] bg-[#2a1010] px-1 text-[#fca5a5]">{missingLabel}</span>
            )}
            {session.recordingDisabled && (
              <span className="rounded border border-[#3f3f46] bg-[#18181b] px-1 text-[#a1a1aa]">
                {config.language === "en" ? "Temporary" : "临时"}
              </span>
            )}
          </span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDeleteSession?.(workspacePath, session.id);
          }}
          className="rounded p-1 text-[#71717a] opacity-0 transition-opacity hover:bg-[#27272a] hover:text-[#f48771] group-hover:opacity-100"
          title={config.language === "en" ? "Delete session" : "删除会话"}
        >
          <IconTrash className="h-3 w-3" />
        </button>
      </div>
    );
  };

  const sortedGlobalSessions = sortSessions(globalSessions);
  const isBlackTheme = config.themeMode === "black";

  return (
    <div
      className={`relative z-10 flex shrink-0 flex-col overflow-hidden border-r shadow-sm ${
        isBlackTheme ? "bg-[rgba(8,8,10,0.78)] backdrop-blur-xl backdrop-saturate-150" : "bg-[#09090b]"
      } ${
        isWorkspaceDropActive ? "border-[var(--accent)]" : "border-[#27272a]"
      }`}
      style={{ width: `${sidebarWidth}px` }}
      data-testid="workspace-sidebar"
    >
      <div
        className={`flex shrink-0 flex-col justify-center border-b border-[#27272a] px-4 pb-4 pt-10 select-none ${
          isBlackTheme ? "bg-[rgba(10,10,12,0.62)]" : "bg-[#09090b]"
        }`}
        data-tauri-drag-region
      >
        <div className="mb-4 flex items-center gap-[2px] select-none pointer-events-none">
          <IconLogoM className="h-[18px] w-[18px] theme-text drop-shadow-[0_0_8px_var(--accent-subtle)] pointer-events-none" />
          <span
            className="pointer-events-none text-[12px] font-black leading-none tracking-widest text-[#e4e4e7]"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            AIN
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-widest text-[#71717a]">
          <span className="pointer-events-none">{t.workspace || "WORKSPACE"}</span>
          <button
            onClick={onAddWorkspace || onSelectWorkspace}
            data-testid="sidebar-add-workspace"
            className={`pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold normal-case tracking-normal transition-colors ${
              isWorkspaceDropActive
                ? "border-[var(--accent)] bg-[var(--accent-subtle)] text-white"
                : "border-[#27272a] bg-[#000000] text-[#e4e4e7] hover:bg-[#18181b] hover:text-white"
            }`}
            title={dropHint}
          >
            <IconPlus className="h-3.5 w-3.5" />
            <span>{addWorkspaceLabel}</span>
          </button>
        </div>
        {isWorkspaceDropActive && (
          <div className="mt-3 rounded-md border border-[var(--accent)] bg-[var(--accent-subtle)] px-3 py-2 text-[11px] text-[#e4e4e7]">
            {dropHint}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-4 pt-3">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="text-[11px] font-bold uppercase tracking-wider text-[#71717a]">{projectChatsLabel}</div>
            </div>

            {workspaceEntries.length === 0 ? (
              <div className="mx-1 rounded-lg border border-dashed border-[#27272a] px-3 py-6 text-center text-[11px] leading-relaxed text-[#71717a]">
                {dropHint}
              </div>
            ) : (
              <div className="space-y-1">
                {workspaceEntries.map((workspace) => {
                  const workspacePath = workspace.path;
                  const sessions = sortSessions(sessionsByWorkspace[workspacePath] || []);
                  const workspaceName = workspace.name || getWorkspaceName(workspacePath);
                  const isExpanded = expandedWorkspaces[workspacePath] !== false;
                  const isActiveWorkspace = activeWorkspace === workspacePath;
                  const activeSessionId = isActiveWorkspace
                    ? currentSessionId
                    : activeSessionByWorkspace[workspacePath] ?? null;
                  const status = workspaceStatuses[workspacePath] || "idle";
                  const showStatus = status && status !== "idle";

                  return (
                    <div key={workspacePath} className="space-y-0.5">
                      <div
                        className={`group flex w-full items-center gap-2 rounded-md px-2 py-2 transition-colors ${
                          isActiveWorkspace ? "bg-[#18181b]" : "hover:bg-[#18181b]"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedWorkspaces((prev) => ({ ...prev, [workspacePath]: !isExpanded }))
                          }
                          className="shrink-0 rounded p-0.5 text-[#71717a] hover:text-[#e4e4e7]"
                          title={isExpanded ? (config.language === "en" ? "Collapse" : "折叠") : (config.language === "en" ? "Expand" : "展开")}
                        >
                          {isExpanded ? (
                            <IconChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <IconChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectWorkspaceRoot?.(workspacePath)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          title={workspacePath}
                        >
                          <IconFolder className={`h-4 w-4 shrink-0 ${isActiveWorkspace ? "theme-text" : "text-[#71717a]"}`} />
                          <span className="sidebar-label truncate text-[13px] font-medium text-[#e4e4e7]">
                            {workspaceName}
                          </span>
                        </button>
                        {showStatus && (
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" title={status} />
                        )}
                        <span className="text-[10px] text-[#71717a]">{sessions.length}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            workspacePath && onCreateSession?.(workspacePath);
                          }}
                          className="rounded p-1 text-[#71717a] opacity-60 transition-opacity hover:bg-[#27272a] hover:text-[#e4e4e7] group-hover:opacity-100"
                          title={config.language === "en" ? "New project conversation" : "新建项目会话"}
                        >
                          <IconPlus className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveWorkspaceEntry?.(workspacePath);
                          }}
                          className="rounded p-1 text-[#71717a] opacity-70 transition-opacity hover:bg-[#27272a] hover:text-[#f48771] group-hover:opacity-100"
                          title={config.language === "en" ? "Remove from sidebar" : "从侧边栏移除"}
                        >
                          <IconTrash className="h-3 w-3" />
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="ml-3 space-y-0.5 border-l border-[#27272a] pl-2">
                          {sessions.length === 0 ? (
                            <div className="py-3 text-center text-[11px] text-[#71717a]">
                              {t.noConversations || "No conversations yet"}
                            </div>
                          ) : (
                            sessions.map((session) => renderSession(workspacePath, session, activeSessionId))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 shrink-0 border-t border-[#18181b] pt-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="text-[11px] font-bold uppercase tracking-wider text-[#71717a]">{chatLabel}</div>
              <button
                onClick={() => onCreateSession?.(GLOBAL_CHAT_KEY)}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-[#e4e4e7] transition-colors hover:bg-[#18181b] hover:text-white"
                title={config.language === "en" ? "New chat" : "新建聊天"}
              >
                <IconPlus className="h-3.5 w-3.5" />
                {newLabel}
              </button>
            </div>

            <div className="max-h-52 overflow-y-auto pr-1">
              <div className="space-y-0.5">
                <button
                  onClick={() => {
                    onOpenGlobalChat?.();
                    setChatExpanded((value) => (currentWorkspace ? true : !value));
                  }}
                  className={`group flex w-full items-center gap-2 rounded-md px-2 py-2 transition-colors ${
                    !currentWorkspace ? "bg-[#18181b]" : "hover:bg-[#18181b]"
                  }`}
                >
                  {chatExpanded ? (
                    <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
                  ) : (
                    <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
                  )}
                  <IconChat className={`h-4 w-4 shrink-0 ${!currentWorkspace ? "theme-text" : "text-[#71717a]"}`} />
                  <span className="sidebar-label truncate text-[13px] font-medium text-[#e4e4e7]">
                    {chatLabel}
                  </span>
                  <span className="ml-auto text-[10px] text-[#71717a]">{sortedGlobalSessions.length}</span>
                </button>

                {chatExpanded && (
                  <div className="ml-3 space-y-0.5 border-l border-[#27272a] pl-2">
                    {sortedGlobalSessions.length === 0 ? (
                      <div className="py-4 text-center text-[11px] text-[#71717a]">
                        {t.noChats || "No chats yet"}
                      </div>
                    ) : (
                      sortedGlobalSessions.map((session) => renderSession(GLOBAL_CHAT_KEY, session, !currentWorkspace ? currentSessionId : null))
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`flex shrink-0 flex-col gap-1 border-t border-[#27272a] p-3 ${
        isBlackTheme ? "bg-[rgba(10,10,12,0.58)]" : "bg-[#09090b]"
      }`}>
        <button
          onClick={config.onOpenSkills}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#e4e4e7]"
        >
          <IconBook className="h-4 w-4" />
          {t.skills || "Skills"}
        </button>
        <button
          onClick={config.onOpenSettings}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#e4e4e7]"
        >
          <IconSettings className="h-4 w-4" />
          {t.settings || "Settings"}
        </button>
      </div>

      <div
        onMouseDown={onStartResizing}
        className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize group"
        style={{ marginRight: "-0.5px" }}
      >
        <div className="h-full w-full bg-transparent transition-colors group-hover:bg-[#3f3f46]" />
      </div>
    </div>
  );
}
