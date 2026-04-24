// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconChevronRight, IconClose, IconFile, IconFolder } from "./Icons";
import { listDirectory, type FileNode } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";
import { shouldHideWorkspaceEntry } from "../utils/fsUtils";

interface WorkspaceTreePanelProps {
  currentWorkspace: string;
  language: "zh" | "en";
  width: number;
  onClose: () => void;
  onStartResizing?: (e: React.MouseEvent) => void;
}

export default function WorkspaceTreePanel({
  currentWorkspace,
  language,
  width,
  onClose,
  onStartResizing,
}: WorkspaceTreePanelProps) {
  const openFileViewer = useAppStore((s) => s.openFileViewer);
  const deletePersistedPlanFiles = useAppStore((s) => s.deletePersistedPlanFiles);
  const workspaceContentVersion = useAppStore((s) => s.workspaceContentVersion);
  const [treeNodesByPath, setTreeNodesByPath] = useState<Record<string, FileNode[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [fileTreeError, setFileTreeError] = useState("");
  const treeNodesRef = useRef<Record<string, FileNode[]>>({});
  const loadingPathsRef = useRef<Record<string, boolean>>({});
  const loadDirectoryNodesRef = useRef<(path: string, options?: { force?: boolean }) => Promise<void>>(async () => {});
  const previousWorkspaceContentVersionRef = useRef<number | null>(null);

  const workspaceName = useMemo(() => {
    if (!currentWorkspace) return "";
    return currentWorkspace.split("/").filter(Boolean).pop() || currentWorkspace;
  }, [currentWorkspace]);

  const copy = useMemo(() => ({
    title: language === "en" ? "Files" : "文件",
    subtitle: language === "en" ? "Workspace tree" : "工作区文件树",
    loading: language === "en" ? "Loading..." : "加载中...",
    error: language === "en" ? "Failed to load file tree." : "加载文件树失败。",
    empty: language === "en" ? "No files to display." : "暂无可显示文件。",
    refresh: language === "en" ? "Refresh" : "刷新",
    clearPlans: language === "en" ? "Clear Plans" : "清理计划文件",
    close: language === "en" ? "Close file tree" : "关闭文件树",
  }), [language]);

  useEffect(() => {
    treeNodesRef.current = treeNodesByPath;
  }, [treeNodesByPath]);

  useEffect(() => {
    loadingPathsRef.current = loadingPaths;
  }, [loadingPaths]);

  const loadDirectoryNodes = useCallback(async (path: string, options?: { force?: boolean }) => {
    if (!path) return;
    if (loadingPathsRef.current[path]) return;
    if (!options?.force && treeNodesRef.current[path]) return;

    setLoadingPaths((prev) => ({ ...prev, [path]: true }));
    setFileTreeError("");

    try {
      const nodes = await listDirectory(path);
      const visibleNodes = nodes.filter((node) => !shouldHideWorkspaceEntry(node.name, node.is_dir));
      const sorted = [...visibleNodes].sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        return a.name.localeCompare(b.name);
      });
      setTreeNodesByPath((prev) => ({ ...prev, [path]: sorted }));
    } catch {
      setTreeNodesByPath((prev) => {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
      setExpandedPaths((prev) => {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
      if (path === currentWorkspace) {
        setFileTreeError(copy.error);
      }
    } finally {
      setLoadingPaths((prev) => ({ ...prev, [path]: false }));
    }
  }, [copy.error, currentWorkspace]);

  useEffect(() => {
    loadDirectoryNodesRef.current = loadDirectoryNodes;
  }, [loadDirectoryNodes]);

  const refreshLoadedDirectories = useCallback(async () => {
    if (!currentWorkspace) return;
    const loadedPaths = Object.keys(treeNodesRef.current);
    const pathsToReload = loadedPaths.length > 0 ? loadedPaths : [currentWorkspace];
    await Promise.all(pathsToReload.map((path) => loadDirectoryNodesRef.current(path, { force: true })));
  }, [currentWorkspace]);

  useEffect(() => {
    treeNodesRef.current = {};
    setTreeNodesByPath({});
    setExpandedPaths(currentWorkspace ? { [currentWorkspace]: true } : {});
    setLoadingPaths({});
    setFileTreeError("");
    previousWorkspaceContentVersionRef.current = workspaceContentVersion;
  }, [currentWorkspace]);

  useEffect(() => {
    if (!currentWorkspace) return;
    void loadDirectoryNodesRef.current(currentWorkspace, { force: true });
  }, [currentWorkspace]);

  useEffect(() => {
    if (!currentWorkspace) return;
    if (previousWorkspaceContentVersionRef.current === workspaceContentVersion) return;
    previousWorkspaceContentVersionRef.current = workspaceContentVersion;
    const timer = window.setTimeout(() => {
      void refreshLoadedDirectories();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [currentWorkspace, refreshLoadedDirectories, workspaceContentVersion]);

  const handleTogglePath = useCallback(async (node: FileNode) => {
    if (!node.is_dir) return;
    const next = !expandedPaths[node.path];
    setExpandedPaths((prev) => ({ ...prev, [node.path]: next }));
    if (next && !treeNodesRef.current[node.path]) {
      await loadDirectoryNodes(node.path);
    }
  }, [expandedPaths, loadDirectoryNodes]);

  const renderTree = useCallback((path: string, depth = 0) => {
    const nodes = treeNodesByPath[path] || [];
    return nodes.map((node) => {
      const isExpanded = !!expandedPaths[node.path];
      const isLoading = !!loadingPaths[node.path];

      return (
        <div key={node.path}>
          <button
            onClick={() => {
              if (node.is_dir) {
                void handleTogglePath(node);
                return;
              }
              void openFileViewer(node.path);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[#d4d4d8] transition-colors hover:bg-[#18181b]"
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            title={node.path}
          >
            {node.is_dir ? (
              isExpanded ? (
                <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
              ) : (
                <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
              )
            ) : (
              <span className="h-3.5 w-3.5 shrink-0" />
            )}
            {node.is_dir ? (
              <IconFolder className="h-3.5 w-3.5 shrink-0 theme-text" />
            ) : (
              <IconFile className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
            )}
            <span className="min-w-0 truncate font-mono">{node.name}</span>
            {isLoading && <span className="ml-auto text-[10px] text-[#71717a]">{copy.loading}</span>}
          </button>
          {node.is_dir && isExpanded && renderTree(node.path, depth + 1)}
        </div>
      );
    });
  }, [copy.loading, expandedPaths, handleTogglePath, loadingPaths, openFileViewer, treeNodesByPath]);

  return (
    <div
      className="relative z-10 flex shrink-0 flex-col border-r border-[#27272a] bg-[#09090b]"
      style={{ width: `${width}px` }}
    >
      <div className="min-h-[72px] shrink-0 border-b border-[#27272a] bg-[#09090b] px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#27272a] bg-[#000000] text-[#e4e4e7]">
              <IconFolder className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-[#e4e4e7]">{copy.title}</div>
              <div className="truncate text-[11px] text-[#71717a]" title={currentWorkspace || copy.subtitle}>
                {workspaceName || copy.subtitle}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-[#27272a] bg-[#000000] p-1.5 text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#e4e4e7]"
            title={copy.close}
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[#27272a] px-3 py-2">
        <button
          onClick={() => void refreshLoadedDirectories()}
          className="rounded-md border border-[#27272a] bg-[#000000] px-2.5 py-1 text-[11px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#e4e4e7]"
        >
          {copy.refresh}
        </button>
        <button
          onClick={() => void deletePersistedPlanFiles()}
          className="rounded-md border border-[#27272a] bg-[#000000] px-2.5 py-1 text-[11px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#e4e4e7]"
        >
          {copy.clearPlans}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!currentWorkspace ? (
          <div className="px-3 py-3 text-[11px] text-[#71717a]">{copy.empty}</div>
        ) : fileTreeError ? (
          <div className="px-3 py-3 text-[11px] text-[#f48771]">{fileTreeError}</div>
        ) : loadingPaths[currentWorkspace] && !treeNodesByPath[currentWorkspace] ? (
          <div className="px-3 py-3 text-[11px] text-[#71717a]">{copy.loading}</div>
        ) : (
          renderTree(currentWorkspace)
        )}
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
