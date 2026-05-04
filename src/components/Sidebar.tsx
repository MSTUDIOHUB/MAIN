// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconBook,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconGitBranch,
  IconGitCommit,
  IconGitPush,
  IconPlus,
  IconSettings,
  IconTrash,
} from "./Icons";
import { GLOBAL_CHAT_KEY, type WorkspaceEntry } from "../store/useAppStore";
import { looksLikeReasoningLeakTitle, normalizeConversationDisplayTitle } from "../lib/workflowModels";
import { getGitStatus, gitCommitAll, gitCreateBranch, gitPushCurrentBranch, type GitStatus } from "../lib/ipc";

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

function createEmptyGitStatus(patch: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: false,
    gitAvailable: true,
    repoRoot: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    untrackedFiles: 0,
    stagedFiles: 0,
    unstagedFiles: 0,
    conflictedFiles: 0,
    clean: true,
    hasOrigin: false,
    error: null,
    ...patch,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
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
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const gitMenuRef = useRef<HTMLDivElement | null>(null);
  const [chatExpanded, setChatExpanded] = useState(true);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitStatus>>({});
  const [gitLoading, setGitLoading] = useState<Record<string, boolean>>({});
  const [gitActionBusy, setGitActionBusy] = useState(false);
  const [gitMenu, setGitMenu] = useState<{ workspacePath: string; top: number } | null>(null);
  const [gitActionMode, setGitActionMode] = useState<"commit" | "branch" | null>(null);
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [gitBranchName, setGitBranchName] = useState("");
  const [gitFeedback, setGitFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
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
  const workspacePathsKey = useMemo(() => workspaceEntries.map((entry) => entry.path).join("\n"), [workspaceEntries]);

  const refreshGitStatus = useCallback(async (workspacePath: string, includeStats = false) => {
    if (!workspacePath) return null;
    setGitLoading((prev) => ({ ...prev, [workspacePath]: true }));
    try {
      const status = await getGitStatus(workspacePath, includeStats);
      setGitStatuses((prev) => ({ ...prev, [workspacePath]: status }));
      return status;
    } catch (error) {
      const status = createEmptyGitStatus({
        gitAvailable: false,
        isRepo: false,
        error: getErrorMessage(error),
      });
      setGitStatuses((prev) => ({ ...prev, [workspacePath]: status }));
      return status;
    } finally {
      setGitLoading((prev) => ({ ...prev, [workspacePath]: false }));
    }
  }, []);

  useEffect(() => {
    if (!activeWorkspace) return;
    setExpandedWorkspaces((prev) => (
      activeWorkspace in prev ? prev : { ...prev, [activeWorkspace]: true }
    ));
  }, [activeWorkspace]);

  useEffect(() => {
    const paths = workspacePathsKey.split("\n").filter(Boolean);
    let cancelled = false;
    setGitStatuses((prev) => {
      const next: Record<string, GitStatus> = {};
      paths.forEach((path) => {
        if (prev[path]) next[path] = prev[path];
      });
      return next;
    });
    paths.forEach((path) => {
      void getGitStatus(path, false)
        .then((status) => {
          if (cancelled) return;
          setGitStatuses((prev) => ({ ...prev, [path]: status }));
        })
        .catch((error) => {
          if (cancelled) return;
          setGitStatuses((prev) => ({
            ...prev,
            [path]: createEmptyGitStatus({
              gitAvailable: false,
              isRepo: false,
              error: getErrorMessage(error),
            }),
          }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [workspacePathsKey]);

  useEffect(() => {
    if (!gitMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-sidebar-git-trigger='true']")) return;
      if (gitMenuRef.current?.contains(target as Node)) return;
      setGitMenu(null);
      setGitActionMode(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setGitMenu(null);
        setGitActionMode(null);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [gitMenu]);

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
  const gitCopy = config.language === "en"
    ? {
        title: "Git",
        branch: "Branch",
        upstream: "Upstream",
        noUpstream: "No upstream",
        changed: "Changed",
        staged: "Staged",
        unstaged: "Unstaged",
        conflicts: "Conflicts",
        untracked: "Untracked",
        clean: "Clean",
        commit: "Commit",
        push: "Push",
        createBranch: "Create branch",
        commitPlaceholder: "Commit message",
        branchPlaceholder: "new-branch-name",
        cancel: "Cancel",
        confirm: "Confirm",
        refreshFailed: "Failed to refresh Git status.",
        commitDone: "Committed all changes.",
        pushDone: "Pushed current branch.",
        branchDone: "Created and switched branch.",
        missingMessage: "Enter a commit message.",
        missingBranch: "Enter a branch name.",
        installGit: "Git was not found. Install Git and restart MAIN.",
        noRepo: "This folder is not a Git repository.",
        noOriginPush: "This branch has no upstream. Push and set upstream to origin?",
      }
    : {
        title: "Git",
        branch: "分支",
        upstream: "上游",
        noUpstream: "无上游",
        changed: "更改",
        staged: "已暂存",
        unstaged: "未暂存",
        conflicts: "冲突",
        untracked: "未跟踪",
        clean: "干净",
        commit: "提交",
        push: "推送",
        createBranch: "创建分支",
        commitPlaceholder: "提交信息",
        branchPlaceholder: "new-branch-name",
        cancel: "取消",
        confirm: "确认",
        refreshFailed: "刷新 Git 状态失败。",
        commitDone: "已提交全部更改。",
        pushDone: "已推送当前分支。",
        branchDone: "已创建并切换分支。",
        missingMessage: "请输入提交信息。",
        missingBranch: "请输入分支名。",
        installGit: "未找到 Git。请安装 Git 后重启 MAIN。",
        noRepo: "当前文件夹不是 Git 仓库。",
        noOriginPush: "当前分支没有上游。要推送并把 origin 设置为上游吗？",
      };

  const activeGitStatus = gitMenu ? gitStatuses[gitMenu.workspacePath] : null;
  const activeGitLoading = gitMenu ? !!gitLoading[gitMenu.workspacePath] : false;
  const gitOperationsDisabled = !activeGitStatus?.gitAvailable || !activeGitStatus?.isRepo || gitActionBusy || activeGitLoading;

  const openGitMenu = (event: React.MouseEvent<HTMLButtonElement>, workspacePath: string) => {
    event.stopPropagation();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const sidebarRect = sidebarRef.current?.getBoundingClientRect();
    const top = sidebarRect
      ? Math.max(74, Math.min(buttonRect.bottom - sidebarRect.top + 6, Math.max(74, sidebarRect.height - 340)))
      : buttonRect.bottom + 6;
    setGitMenu((prev) => prev?.workspacePath === workspacePath ? null : { workspacePath, top });
    setGitActionMode(null);
    setGitFeedback(null);
    setGitCommitMessage("");
    setGitBranchName("");
    void refreshGitStatus(workspacePath, true);
  };

  const runGitAction = async (operation: () => Promise<GitStatus>, successText: string) => {
    if (!gitMenu?.workspacePath) return;
    setGitActionBusy(true);
    setGitFeedback(null);
    try {
      const status = await operation();
      setGitStatuses((prev) => ({ ...prev, [gitMenu.workspacePath]: status }));
      setGitFeedback({ type: "success", text: successText });
      setGitActionMode(null);
      setGitCommitMessage("");
      setGitBranchName("");
    } catch (error) {
      setGitFeedback({ type: "error", text: getErrorMessage(error) || gitCopy.refreshFailed });
      void refreshGitStatus(gitMenu.workspacePath, true);
    } finally {
      setGitActionBusy(false);
    }
  };

  const handleGitCommit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!gitMenu?.workspacePath) return;
    const message = gitCommitMessage.trim();
    if (!message) {
      setGitFeedback({ type: "error", text: gitCopy.missingMessage });
      return;
    }
    await runGitAction(() => gitCommitAll(gitMenu.workspacePath, message), gitCopy.commitDone);
  };

  const handleGitPush = async () => {
    if (!gitMenu?.workspacePath || !activeGitStatus) return;
    if (!activeGitStatus.upstream && activeGitStatus.hasOrigin && !window.confirm(gitCopy.noOriginPush)) {
      return;
    }
    await runGitAction(() => gitPushCurrentBranch(gitMenu.workspacePath), gitCopy.pushDone);
  };

  const handleGitCreateBranch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!gitMenu?.workspacePath) return;
    const branch = gitBranchName.trim();
    if (!branch) {
      setGitFeedback({ type: "error", text: gitCopy.missingBranch });
      return;
    }
    await runGitAction(() => gitCreateBranch(gitMenu.workspacePath, branch), gitCopy.branchDone);
  };

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
      ref={sidebarRef}
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
                  const gitStatus = gitStatuses[workspacePath];
                  const showGitIcon = gitStatus?.isRepo;
                  const gitIconDisabled = showGitIcon && !gitStatus?.gitAvailable;

                  return (
                    <div key={workspacePath} className="space-y-0.5">
                      <div
                        data-testid="sidebar-workspace-row"
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
                        {showGitIcon && (
                          <button
                            type="button"
                            data-sidebar-git-trigger="true"
                            data-testid="sidebar-git-button"
                            onClick={(event) => openGitMenu(event, workspacePath)}
                            className={`rounded p-1 transition-colors ${
                              gitIconDisabled
                                ? "text-[#52525b] hover:bg-[#27272a]"
                                : gitMenu?.workspacePath === workspacePath
                                  ? "bg-[#27272a] theme-text"
                                  : "text-[#71717a] opacity-80 hover:bg-[#27272a] hover:text-[#e4e4e7] group-hover:opacity-100"
                            }`}
                            title={gitIconDisabled ? gitCopy.installGit : gitCopy.title}
                          >
                            <IconGitBranch className="h-3.5 w-3.5" />
                          </button>
                        )}
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

      {gitMenu && (
        <div
          ref={gitMenuRef}
          data-testid="sidebar-git-menu"
          className="absolute right-3 z-40 w-[236px] overflow-hidden rounded-md border border-[#3f3f46] bg-[#202022] text-[#e4e4e7] shadow-2xl"
          style={{ top: `${gitMenu.top}px`, maxHeight: `calc(100% - ${gitMenu.top + 12}px)` }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="max-h-full overflow-y-auto">
            <div className="border-b border-[#3f3f46] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <IconGitBranch className="h-4 w-4 shrink-0 theme-text" />
                  <span className="truncate text-[12px] font-bold">{gitCopy.title}</span>
                </div>
                {activeGitLoading && (
                  <span className="text-[10px] text-[#a1a1aa]">{config.language === "en" ? "Loading" : "加载中"}</span>
                )}
              </div>
              <div className="mt-2 space-y-1 text-[11px] text-[#a1a1aa]">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="text-[#71717a]">{gitCopy.branch}</span>
                  <span className="truncate text-[#e4e4e7]" title={activeGitStatus?.branch || ""}>
                    {activeGitStatus?.branch || "HEAD"}
                  </span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="text-[#71717a]">{gitCopy.upstream}</span>
                  <span className="truncate" title={activeGitStatus?.upstream || ""}>
                    {activeGitStatus?.upstream || gitCopy.noUpstream}
                  </span>
                </div>
                {(activeGitStatus?.ahead || activeGitStatus?.behind) ? (
                  <div className="flex items-center justify-end gap-1.5">
                    {activeGitStatus?.ahead > 0 && <span className="rounded bg-[#123524] px-1.5 py-0.5 text-[#86d9a3]">ahead {activeGitStatus.ahead}</span>}
                    {activeGitStatus?.behind > 0 && <span className="rounded bg-[#3a2412] px-1.5 py-0.5 text-[#facc15]">behind {activeGitStatus.behind}</span>}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1 border-b border-[#3f3f46] px-3 py-2 text-center">
              <div className="rounded bg-[#18181b] px-2 py-1.5">
                <div className="text-[13px] font-bold">{activeGitStatus?.changedFiles ?? 0}</div>
                <div className="text-[9px] uppercase tracking-wider text-[#71717a]">{gitCopy.changed}</div>
              </div>
              <div className="rounded bg-[#112018] px-2 py-1.5">
                <div className="text-[13px] font-bold text-[#86d9a3]">+{activeGitStatus?.insertions ?? 0}</div>
                <div className="text-[9px] uppercase tracking-wider text-[#5f9f78]">+</div>
              </div>
              <div className="rounded bg-[#241515] px-2 py-1.5">
                <div className="text-[13px] font-bold text-[#fca5a5]">-{activeGitStatus?.deletions ?? 0}</div>
                <div className="text-[9px] uppercase tracking-wider text-[#b96c6c]">-</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-b border-[#3f3f46] px-3 py-2 text-[11px] text-[#a1a1aa]">
              <div className="flex justify-between gap-2"><span>{gitCopy.staged}</span><span>{activeGitStatus?.stagedFiles ?? 0}</span></div>
              <div className="flex justify-between gap-2"><span>{gitCopy.unstaged}</span><span>{activeGitStatus?.unstagedFiles ?? 0}</span></div>
              <div className="flex justify-between gap-2"><span>{gitCopy.untracked}</span><span>{activeGitStatus?.untrackedFiles ?? 0}</span></div>
              <div className="flex justify-between gap-2"><span>{gitCopy.conflicts}</span><span className={activeGitStatus?.conflictedFiles ? "text-[#fca5a5]" : ""}>{activeGitStatus?.conflictedFiles ?? 0}</span></div>
            </div>

            {(activeGitStatus?.error || !activeGitStatus?.gitAvailable || !activeGitStatus?.isRepo) && (
              <div className="border-b border-[#3f3f46] bg-[#2a1010] px-3 py-2 text-[11px] leading-relaxed text-[#fca5a5]">
                {activeGitStatus?.error || (!activeGitStatus?.gitAvailable ? gitCopy.installGit : gitCopy.noRepo)}
              </div>
            )}

            {gitFeedback && (
              <div className={`border-b border-[#3f3f46] px-3 py-2 text-[11px] leading-relaxed ${
                gitFeedback.type === "success" ? "bg-[#112018] text-[#86d9a3]" : "bg-[#2a1010] text-[#fca5a5]"
              }`}>
                {gitFeedback.text}
              </div>
            )}

            <div className="space-y-1 px-2 py-2">
              <button
                type="button"
                disabled={gitOperationsDisabled || activeGitStatus?.clean || activeGitStatus?.conflictedFiles > 0}
                onClick={() => {
                  setGitActionMode((mode) => mode === "commit" ? null : "commit");
                  setGitFeedback(null);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[13px] transition-colors hover:bg-[#2f2f32] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <IconGitCommit className="h-4 w-4" />
                {gitCopy.commit}
              </button>
              {gitActionMode === "commit" && (
                <form onSubmit={handleGitCommit} className="space-y-2 px-2 pb-2">
                  <input
                    autoFocus
                    value={gitCommitMessage}
                    onChange={(event) => setGitCommitMessage(event.target.value)}
                    className="h-8 w-full rounded border border-[#3f3f46] bg-[#111113] px-2 text-[12px] text-[#e4e4e7] outline-none focus:border-[var(--accent)]"
                    placeholder={gitCopy.commitPlaceholder}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button type="button" onClick={() => setGitActionMode(null)} className="rounded px-2 py-1 text-[11px] text-[#a1a1aa] hover:bg-[#2f2f32]">{gitCopy.cancel}</button>
                    <button disabled={gitActionBusy} className="rounded bg-[var(--accent)] px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">{gitCopy.confirm}</button>
                  </div>
                </form>
              )}

              <button
                type="button"
                disabled={gitOperationsDisabled}
                onClick={handleGitPush}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[13px] transition-colors hover:bg-[#2f2f32] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <IconGitPush className="h-4 w-4" />
                {gitCopy.push}
              </button>

              <button
                type="button"
                disabled={gitOperationsDisabled}
                onClick={() => {
                  setGitActionMode((mode) => mode === "branch" ? null : "branch");
                  setGitFeedback(null);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[13px] transition-colors hover:bg-[#2f2f32] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <IconGitBranch className="h-4 w-4" />
                {gitCopy.createBranch}
              </button>
              {gitActionMode === "branch" && (
                <form onSubmit={handleGitCreateBranch} className="space-y-2 px-2 pb-2">
                  <input
                    autoFocus
                    value={gitBranchName}
                    onChange={(event) => setGitBranchName(event.target.value)}
                    className="h-8 w-full rounded border border-[#3f3f46] bg-[#111113] px-2 text-[12px] text-[#e4e4e7] outline-none focus:border-[var(--accent)]"
                    placeholder={gitCopy.branchPlaceholder}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button type="button" onClick={() => setGitActionMode(null)} className="rounded px-2 py-1 text-[11px] text-[#a1a1aa] hover:bg-[#2f2f32]">{gitCopy.cancel}</button>
                    <button disabled={gitActionBusy} className="rounded bg-[var(--accent)] px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">{gitCopy.confirm}</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

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
