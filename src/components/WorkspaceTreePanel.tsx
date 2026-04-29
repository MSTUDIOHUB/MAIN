// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFile,
  IconFileArchive,
  IconFileAudio,
  IconFileCode,
  IconFileConfig,
  IconFileJson,
  IconFileMarkdown,
  IconFileStyle,
  IconFileTable,
  IconFileText,
  IconFileVideo,
  IconFolder,
  IconFolderOpen,
  IconImageIcon,
  IconPackage,
  IconTerminal,
} from "./Icons";
import { listDirectory, type FileNode } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";
import { shouldHideWorkspaceEntry } from "../utils/fsUtils";

interface WorkspaceTreePanelProps {
  currentWorkspace: string;
  language: "zh" | "en";
  width?: number;
  embedded?: boolean;
  onClose?: () => void;
  onOpenFile?: (path: string) => void | Promise<void>;
  onStartResizing?: (e: React.MouseEvent) => void;
}

const treeIconClass = "h-3.5 w-3.5 shrink-0";
const defaultFileIcon = { icon: IconFile, className: "text-[#71717a]" };

const folderIconByName = {
  assets: "text-[#f59e0b]",
  components: "text-[#38bdf8]",
  docs: "text-[#86d9a3]",
  gamestudiopack: "text-[#a78bfa]",
  lib: "text-[#38bdf8]",
  public: "text-[#f59e0b]",
  scripts: "text-[#38bdf8]",
  src: "text-[#38bdf8]",
  "src-tauri": "text-[#f97316]",
  store: "text-[#38bdf8]",
  tests: "text-[#fbbf24]",
  utils: "text-[#38bdf8]",
};

const fileIconByName = {
  ".gitignore": { icon: IconFileConfig, className: "text-[#a1a1aa]" },
  "agent.md": { icon: IconFileMarkdown, className: "text-[#4ade80]" },
  "agents.md": { icon: IconFileMarkdown, className: "text-[#4ade80]" },
  "dockerfile": { icon: IconTerminal, className: "text-[#60a5fa]" },
  "makefile": { icon: IconTerminal, className: "text-[#fbbf24]" },
  "package-lock.json": { icon: IconPackage, className: "text-[#f59e0b]" },
  "package.json": { icon: IconPackage, className: "text-[#f59e0b]" },
  "playwright.config.ts": { icon: IconFileConfig, className: "text-[#22c55e]" },
  "readme.md": { icon: IconFileMarkdown, className: "text-[#86d9a3]" },
  "tsconfig.json": { icon: IconFileConfig, className: "text-[#3b82f6]" },
  "tsconfig.node.json": { icon: IconFileConfig, className: "text-[#3b82f6]" },
  "vite.config.ts": { icon: IconFileConfig, className: "text-[#a78bfa]" },
  "yarn.lock": { icon: IconPackage, className: "text-[#f59e0b]" },
};

const fileIconByExtension = {
  "7z": { icon: IconFileArchive, className: "text-[#a1a1aa]" },
  avi: { icon: IconFileVideo, className: "text-[#fb7185]" },
  bat: { icon: IconTerminal, className: "text-[#a1a1aa]" },
  c: { icon: IconFileCode, className: "text-[#60a5fa]" },
  cc: { icon: IconFileCode, className: "text-[#60a5fa]" },
  cmd: { icon: IconTerminal, className: "text-[#a1a1aa]" },
  compute: { icon: IconFileCode, className: "text-[#a78bfa]" },
  cpp: { icon: IconFileCode, className: "text-[#60a5fa]" },
  cs: { icon: IconFileCode, className: "text-[#a78bfa]" },
  css: { icon: IconFileStyle, className: "text-[#38bdf8]" },
  csv: { icon: IconFileTable, className: "text-[#22c55e]" },
  cxx: { icon: IconFileCode, className: "text-[#60a5fa]" },
  doc: { icon: IconFileText, className: "text-[#60a5fa]" },
  docx: { icon: IconFileText, className: "text-[#60a5fa]" },
  flac: { icon: IconFileAudio, className: "text-[#c084fc]" },
  gd: { icon: IconFileCode, className: "text-[#60a5fa]" },
  gif: { icon: IconImageIcon, className: "text-[#f472b6]" },
  glsl: { icon: IconFileCode, className: "text-[#a78bfa]" },
  go: { icon: IconFileCode, className: "text-[#38bdf8]" },
  gz: { icon: IconFileArchive, className: "text-[#a1a1aa]" },
  h: { icon: IconFileCode, className: "text-[#60a5fa]" },
  hlsl: { icon: IconFileCode, className: "text-[#a78bfa]" },
  hpp: { icon: IconFileCode, className: "text-[#60a5fa]" },
  html: { icon: IconFileCode, className: "text-[#f97316]" },
  ico: { icon: IconImageIcon, className: "text-[#f472b6]" },
  jpeg: { icon: IconImageIcon, className: "text-[#f472b6]" },
  jpg: { icon: IconImageIcon, className: "text-[#f472b6]" },
  js: { icon: IconFileCode, className: "text-[#facc15]" },
  json: { icon: IconFileJson, className: "text-[#f59e0b]" },
  jsx: { icon: IconFileCode, className: "text-[#38bdf8]" },
  lock: { icon: IconFileConfig, className: "text-[#a1a1aa]" },
  lua: { icon: IconFileCode, className: "text-[#60a5fa]" },
  m4a: { icon: IconFileAudio, className: "text-[#c084fc]" },
  md: { icon: IconFileMarkdown, className: "text-[#86d9a3]" },
  mdx: { icon: IconFileMarkdown, className: "text-[#86d9a3]" },
  mjs: { icon: IconFileCode, className: "text-[#facc15]" },
  mov: { icon: IconFileVideo, className: "text-[#fb7185]" },
  mp3: { icon: IconFileAudio, className: "text-[#c084fc]" },
  mp4: { icon: IconFileVideo, className: "text-[#fb7185]" },
  ogg: { icon: IconFileAudio, className: "text-[#c084fc]" },
  pdf: { icon: IconFileText, className: "text-[#f87171]" },
  png: { icon: IconImageIcon, className: "text-[#f472b6]" },
  ps1: { icon: IconTerminal, className: "text-[#60a5fa]" },
  py: { icon: IconFileCode, className: "text-[#facc15]" },
  rar: { icon: IconFileArchive, className: "text-[#a1a1aa]" },
  rs: { icon: IconFileCode, className: "text-[#f97316]" },
  sass: { icon: IconFileStyle, className: "text-[#f472b6]" },
  scss: { icon: IconFileStyle, className: "text-[#f472b6]" },
  sh: { icon: IconTerminal, className: "text-[#a1a1aa]" },
  shader: { icon: IconFileCode, className: "text-[#a78bfa]" },
  svg: { icon: IconImageIcon, className: "text-[#fb923c]" },
  swift: { icon: IconFileCode, className: "text-[#fb923c]" },
  tar: { icon: IconFileArchive, className: "text-[#a1a1aa]" },
  tgz: { icon: IconFileArchive, className: "text-[#a1a1aa]" },
  toml: { icon: IconFileConfig, className: "text-[#a78bfa]" },
  ts: { icon: IconFileCode, className: "text-[#3b82f6]" },
  tsx: { icon: IconFileCode, className: "text-[#38bdf8]" },
  tsv: { icon: IconFileTable, className: "text-[#22c55e]" },
  txt: { icon: IconFileText, className: "text-[#a1a1aa]" },
  wav: { icon: IconFileAudio, className: "text-[#c084fc]" },
  webm: { icon: IconFileVideo, className: "text-[#fb7185]" },
  webp: { icon: IconImageIcon, className: "text-[#f472b6]" },
  wgsl: { icon: IconFileCode, className: "text-[#a78bfa]" },
  xls: { icon: IconFileTable, className: "text-[#22c55e]" },
  xlsx: { icon: IconFileTable, className: "text-[#22c55e]" },
  xml: { icon: IconFileCode, className: "text-[#f97316]" },
  yaml: { icon: IconFileConfig, className: "text-[#a78bfa]" },
  yml: { icon: IconFileConfig, className: "text-[#a78bfa]" },
  zip: { icon: IconFileArchive, className: "text-[#a1a1aa]" },
  zsh: { icon: IconTerminal, className: "text-[#a1a1aa]" },
};

function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  return name.slice(dotIndex + 1);
}

function getWorkspaceTreeIcon(node: FileNode, isExpanded: boolean) {
  const lowerName = node.name.toLowerCase();

  if (node.is_dir) {
    return {
      icon: isExpanded ? IconFolderOpen : IconFolder,
      className: folderIconByName[lowerName] || "theme-text",
    };
  }

  if (fileIconByName[lowerName]) return fileIconByName[lowerName];
  if (lowerName.startsWith(".env") || lowerName.includes(".config.")) {
    return { icon: IconFileConfig, className: "text-[#a78bfa]" };
  }

  return fileIconByExtension[getFileExtension(lowerName)] || defaultFileIcon;
}

export default function WorkspaceTreePanel({
  currentWorkspace,
  language,
  width = 320,
  embedded = false,
  onClose,
  onOpenFile,
  onStartResizing,
}: WorkspaceTreePanelProps) {
  const storeOpenFileViewer = useAppStore((s) => s.openFileViewer);
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
      const nodes = await listDirectory(path, currentWorkspace);
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

  const openWorkspaceFile = useCallback(async (path: string) => {
    if (onOpenFile) {
      await onOpenFile(path);
      return;
    }
    await storeOpenFileViewer(path, currentWorkspace);
  }, [currentWorkspace, onOpenFile, storeOpenFileViewer]);

  const renderTree = useCallback((path: string, depth = 0) => {
    const nodes = treeNodesByPath[path] || [];
    return nodes.map((node) => {
      const isExpanded = !!expandedPaths[node.path];
      const isLoading = !!loadingPaths[node.path];
      const iconMeta = getWorkspaceTreeIcon(node, isExpanded);
      const TreeIcon = iconMeta.icon;

      return (
        <div key={node.path}>
          <button
            onClick={() => {
              if (node.is_dir) {
                void handleTogglePath(node);
                return;
              }
              void openWorkspaceFile(node.path);
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
            <TreeIcon className={`${treeIconClass} ${iconMeta.className}`} />
            <span className="min-w-0 truncate font-mono">{node.name}</span>
            {isLoading && <span className="ml-auto text-[10px] text-[#71717a]">{copy.loading}</span>}
          </button>
          {node.is_dir && isExpanded && renderTree(node.path, depth + 1)}
        </div>
      );
    });
  }, [copy.loading, expandedPaths, handleTogglePath, loadingPaths, openWorkspaceFile, treeNodesByPath]);

  return (
    <div
      className={embedded
        ? "relative flex h-full min-w-0 flex-col bg-[#050505]"
        : "relative z-10 flex shrink-0 flex-col border-r border-[#27272a] bg-[#09090b]"
      }
      style={embedded ? undefined : { width: `${width}px` }}
    >
      {!embedded && (
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
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-md border border-[#27272a] bg-[#000000] p-1.5 text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#e4e4e7]"
              title={copy.close}
            >
              <IconClose className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      )}

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

      {!embedded && onStartResizing && (
        <div
          onMouseDown={onStartResizing}
          className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize group"
          style={{ marginRight: "-0.5px" }}
        >
          <div className="h-full w-full bg-transparent transition-colors group-hover:bg-[#3f3f46]" />
        </div>
      )}
    </div>
  );
}
