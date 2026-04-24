// @ts-nocheck
import { useMemo, useState } from "react";
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
import { GLOBAL_CHAT_KEY } from "../store/useAppStore";
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
  sessionsByWorkspace: Record<string, any[]>;
  globalSessions: any[];
  currentSessionId: number | null;
  sidebarWidth: number;
  showWorkspaceTreePanel: boolean;
  onSetSidebarWidth: (w: number) => void;
  onOpenGlobalChat: () => void;
  onSelectWorkspace: () => void;
  onCreateSession: (scopeKey: string) => void;
  onSelectSession: (scopeKey: string, id: number) => void;
  onDeleteSession: (scopeKey: string, id: number) => void;
  onToggleWorkspaceTree: () => void;
  onStartResizing?: (e: React.MouseEvent) => void;
}

export default function Sidebar({
  config,
  t,
  currentWorkspace = "",
  selectedWorkspace = "",
  sessionsByWorkspace = {},
  globalSessions = [],
  currentSessionId = null,
  sidebarWidth = 260,
  showWorkspaceTreePanel = false,
  onOpenGlobalChat,
  onSelectWorkspace,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onToggleWorkspaceTree,
  onStartResizing,
}: SidebarProps) {
  const [chatExpanded, setChatExpanded] = useState(true);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true);
  const workspacePath = selectedWorkspace || currentWorkspace;

  const workspaceName = useMemo(() => {
    if (!workspacePath) return "";
    return workspacePath.split("/").filter(Boolean).pop() || workspacePath;
  }, [workspacePath]);

  const currentSessions = workspacePath ? sessionsByWorkspace[workspacePath] || [] : [];
  const sortedGlobalSessions = [...globalSessions].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA;
  });
  const sortedSessions = [...currentSessions].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA;
  });

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "";
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  const workspaceButtonLabel =
    workspaceName || (config.language === "en" ? "Click to select workspace" : "点击选择工作区");
  const workspaceButtonHint = workspacePath
    ? config.language === "en"
      ? "Change workspace"
      : "切换工作区"
    : config.language === "en"
    ? "Select workspace"
    : "选择工作区";
  const workspaceTreeTitle = showWorkspaceTreePanel
    ? config.language === "en"
      ? "Hide file tree"
      : "隐藏文件树"
    : config.language === "en"
    ? "Show file tree"
    : "显示文件树";
  const projectChatsLabel = config.language === "en" ? "Project Chats" : "项目会话";
  const chatLabel = config.language === "en" ? "Chat" : "聊天";
  const newLabel = config.language === "en" ? "New" : "新建";

  // 旧数据里可能残留“思考过程”一类标题，这里优先回退到首个 turn 的标题，
  // 让 sidebar 至少展示真实任务，而不是模型的过程文本。
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

  return (
    <div
      className="relative z-10 flex shrink-0 flex-col overflow-hidden border-r border-[#27272a] bg-[#09090b] shadow-sm"
      style={{ width: `${sidebarWidth}px` }}
    >
      <div
        className="flex shrink-0 flex-col justify-center border-b border-[#27272a] bg-[#09090b] px-4 pb-4 pt-10 select-none"
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

        <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-[#71717a]">
          <span className="pointer-events-none">{t.workspace || "WORKSPACE"}</span>
          <button
            onClick={onToggleWorkspaceTree}
            disabled={!workspacePath}
            className={`pointer-events-auto flex h-7 items-center justify-center gap-1 rounded-md border px-2 text-[10px] font-medium normal-case tracking-normal transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
              showWorkspaceTreePanel
                ? "theme-subtle-border theme-subtle-bg"
                : "border-[#27272a] bg-[#000000] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#e4e4e7]"
            }`}
            title={workspaceTreeTitle}
          >
            <IconFolder className="h-3.5 w-3.5" />
            <span>{config.language === "en" ? "Files" : "文件"}</span>
          </button>
        </div>

        <button
          onClick={onSelectWorkspace}
          className="flex w-full items-center gap-2 rounded-md border border-[#27272a] bg-[#000000] px-2.5 py-1.5 text-left shadow-sm transition-colors hover:border-[#3f3f46] hover:text-white"
          title={workspacePath || (config.language === "en" ? "Click to select workspace" : "点击选择工作区")}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#a1a1aa]">{workspaceButtonLabel}</span>
          <span className="shrink-0 text-[10px] text-[#71717a]">{workspaceButtonHint}</span>
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        </button>
      </div>

      <div className="shrink-0 px-3 pb-1 pt-3">
        <div className="mb-2 mt-1 px-1">
          <h2 className="sidebar-section-header text-[11px] font-bold uppercase tracking-wider text-[#a1a1aa]">
            {t.conversations || "CONVERSATIONS"}
          </h2>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-4">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="text-[11px] font-bold uppercase tracking-wider text-[#71717a]">{projectChatsLabel}</div>
              <button
                onClick={() => workspacePath && onCreateSession?.(workspacePath)}
                disabled={!workspacePath}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-[#e4e4e7] transition-colors hover:bg-[#18181b] hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#e4e4e7]"
                title={config.language === "en" ? "New project conversation" : "新建项目会话"}
              >
                <IconPlus className="h-3.5 w-3.5" />
                {newLabel}
              </button>
            </div>

            {!workspacePath ? (
              <div className="mx-1 rounded-lg border border-dashed border-[#27272a] py-6 text-center text-[11px] text-[#71717a]">
                {t.noWorkspace || "No project selected"}
              </div>
            ) : (
              <div className="space-y-0.5">
                <button
                  onClick={() => setWorkspaceExpanded((value) => !value)}
                  className="group flex w-full items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-[#18181b]"
                >
                  {workspaceExpanded ? (
                    <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
                  ) : (
                    <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
                  )}
                  <IconFolder className="h-4 w-4 shrink-0 theme-text" />
                  <span className="sidebar-label truncate text-[13px] font-medium text-[#e4e4e7]">
                    {workspaceName}
                  </span>
                  <span className="ml-auto text-[10px] text-[#71717a]">{sortedSessions.length}</span>
                </button>

                {workspaceExpanded && (
                  <div className="ml-3 space-y-0.5 border-l border-[#27272a] pl-2">
                    {sortedSessions.length === 0 ? (
                      <div className="py-4 text-center text-[11px] text-[#71717a]">
                        {t.noConversations || "No conversations yet"}
                      </div>
                    ) : (
                      sortedSessions.map((session) => (
                        <div
                          key={session.id}
                          onClick={() => onSelectSession && onSelectSession(workspacePath, session.id)}
                          className={`group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors ${
                            currentWorkspace && session.id === currentSessionId
                              ? "bg-[#18181b] text-[#ffffff] shadow-sm"
                              : "text-[#e4e4e7] hover:bg-[#18181b]"
                          }`}
                        >
                          <IconChat
                            className={
                              currentWorkspace && session.id === currentSessionId
                                ? "h-3.5 w-3.5 shrink-0 theme-text"
                                : "h-3.5 w-3.5 shrink-0 text-[#71717a]"
                            }
                          />
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="sidebar-session-title truncate text-[13px]">{resolveSessionDisplayTitle(session)}</span>
                            <span className="mt-0.5 text-[10px] text-[#71717a]">{formatDate(session.date)}</span>
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
                      ))
                    )}
                  </div>
                )}
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
                      sortedGlobalSessions.map((session) => (
                        <div
                          key={session.id}
                          onClick={() => onSelectSession && onSelectSession(GLOBAL_CHAT_KEY, session.id)}
                          className={`group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors ${
                            !currentWorkspace && session.id === currentSessionId
                              ? "bg-[#18181b] text-[#ffffff] shadow-sm"
                              : "text-[#e4e4e7] hover:bg-[#18181b]"
                          }`}
                        >
                          <IconChat
                            className={
                              !currentWorkspace && session.id === currentSessionId
                                ? "h-3.5 w-3.5 shrink-0 theme-text"
                                : "h-3.5 w-3.5 shrink-0 text-[#71717a]"
                            }
                          />
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="sidebar-session-title truncate text-[13px]">{resolveSessionDisplayTitle(session)}</span>
                            <span className="mt-0.5 text-[10px] text-[#71717a]">{formatDate(session.date)}</span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteSession?.(GLOBAL_CHAT_KEY, session.id);
                            }}
                            className="rounded p-1 text-[#71717a] opacity-0 transition-opacity hover:bg-[#27272a] hover:text-[#f48771] group-hover:opacity-100"
                            title={config.language === "en" ? "Delete session" : "删除会话"}
                          >
                            <IconTrash className="h-3 w-3" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-1 border-t border-[#27272a] bg-[#09090b] p-3">
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
