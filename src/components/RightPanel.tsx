import React, { useEffect, useMemo, useRef, useState } from "react";
import { IconClose, IconCode, IconColumns, IconTerminal, IconFileText } from "./Icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { save } from "@tauri-apps/plugin-dialog";
import PlanPanel from "./PlanPanel";
import { buildLineDiff, getDiffStats } from "../lib/diff";
import { getE2EResumeExecutionHandler, getE2ESavePlanDocumentHandler } from "../lib/e2e";
import { extractPlanDraftPreview, extractStructuredPlanProposal, hasPlanDraftPreview, hasStructuredPlanProposal } from "../lib/planProposal";
import MarkdownRenderer from "./MarkdownRenderer";
import { resolveGlobalChatSessionKey, useAppStore } from "../store/useAppStore";
import { deleteChatTempPath, exportTextFile, onPtyData, readPtyBuffer, resizePty, spawnPty, writePty } from "../lib/ipc";
import { isPlanConversationTurn } from "../lib/workflowModels";

const CODE_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";

function sanitizeSuggestedFileName(input: string): string {
  const trimmed = input.trim() || "plan";
  return trimmed
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

/** Map file extension → Prism language identifier */
const EXT_LANG_MAP: Record<string, string> = {
  // Web
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  vue: "html", svelte: "html",
  // Systems
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  rs: "rust", go: "go", zig: "zig",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala",
  // Scripting
  py: "python", pyw: "python", rb: "ruby", php: "php",
  swift: "swift", dart: "dart", lua: "lua",
  r: "r", R: "r",
  // Shell
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", psm1: "powershell",
  // Functional / JVM
  clj: "clojure", cljs: "clojure", hs: "haskell", ml: "ocaml", ex: "elixir", exs: "elixir", erl: "erlang",
  // Config / Data
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", cfg: "ini", conf: "ini", env: "bash",
  xml: "xml", svg: "xml", xsl: "xml", xslt: "xml",
  // Query
  sql: "sql", graphql: "graphql", gql: "graphql",
  prisma: "prisma",
  // Docs
  md: "markdown", mdx: "mdx",
  tex: "latex",
  // Build / Tooling
  cmake: "cmake", makefile: "makefile",
  dockerfile: "docker", gradle: "groovy",
  // Other
  proto: "protobuf", tf: "hcl", hcl: "hcl",
  gitignore: "bash", editorconfig: "ini",
  lock: "json",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const BINARY_EXTS = new Set([
  "exe", "dll", "so", "dylib", "bin", "dat",
  "zip", "tar", "gz", "rar", "7z", "bz2", "xz", "zst",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "mp4", "avi", "mov", "mkv", "wav", "flac", "ogg", "webm",
  "woff", "woff2", "ttf", "otf", "eot",
  "class", "jar", "war", "pyc", "o", "a",
]);

function getLanguageFromPath(path: string): string {
  const fileName = path.split("/").pop() || path;
  // Handle dotfiles like .gitignore, .env, .editorconfig
  if (fileName.startsWith(".") && !fileName.includes(".", 1)) {
    const name = fileName.slice(1).toLowerCase();
    if (EXT_LANG_MAP[name]) return EXT_LANG_MAP[name];
    return "text";
  }
  // Handle filenames without extensions like Dockerfile, Makefile
  const lowerName = fileName.toLowerCase();
  if (lowerName === "dockerfile" || lowerName.startsWith("dockerfile.")) return "docker";
  if (lowerName === "makefile" || lowerName === "gnumakefile") return "makefile";
  if (lowerName === "cmakelists.txt" || lowerName.endsWith(".cmake")) return "cmake";
  if (lowerName === "vite.config.ts" || lowerName === "vite.config.js") return "typescript";
  if (lowerName === "tsconfig.json" || lowerName === "tsconfig.node.json") return "json";
  if (lowerName === "package.json" || lowerName === "package-lock.json") return "json";

  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx === -1) return "text";
  const ext = fileName.slice(dotIdx + 1).toLowerCase();
  return EXT_LANG_MAP[ext] || "text";
}

function isImageFile(path: string): boolean {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return IMAGE_EXTS.has(ext);
}

function isBinaryFile(path: string): boolean {
  const fileName = path.split("/").pop() || path;
  const lowerName = fileName.toLowerCase();
  // Known binary filenames
  if (lowerName === "dockerfile" || lowerName === "makefile") return false;
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";
  return BINARY_EXTS.has(ext);
}

function getFileCategory(path: string): "markdown" | "image" | "binary" | "code" {
  if (/\.md$/i.test(path)) return "markdown";
  if (isImageFile(path)) return "image";
  if (isBinaryFile(path)) return "binary";
  return "code";
}

/** Convert file:// or absolute path to a Tauri-compatible asset URL for images */
function toAssetUrl(path: string): string {
  return `asset://localhost/${encodeURIComponent(path).replace(/%2F/g, "/").replace(/%3A/g, ":")}`;
}

/** Detect if content looks like binary (contains null bytes or high ratio of non-printable chars) */
function looksBinary(content: string): boolean {
  if (!content) return false;
  const sample = content.slice(0, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true; // null byte = definitely binary
    if (code < 8 || (code >= 14 && code < 32 && code !== 10 && code !== 13 && code !== 27)) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

function turnHasGeneratedPlan(blocks: any[]) {
  return blocks.some((block) => {
    if (block.type === "tool") {
      return /\.main\/plans\//i.test(String(block.target || ""));
    }

    if (block.type !== "agent") return false;
    const raw = String(block.content || "");
    return hasStructuredPlanProposal(raw) || hasPlanDraftPreview(raw);
  });
}

/** Integrated Terminal sub-component with xterm.js */
function IntegratedTerminal({ themeMode }: { themeMode: "light" | "dark" }) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyReadyRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
      scrollback: 5000,
      theme: themeMode === "light"
        ? {
            background: "#ffffff",
            foreground: "#18181b",
            cursor: "#18181b",
            cursorAccent: "#ffffff",
            selectionBackground: "#d4d4d8",
            black: "#18181b",
            red: "#dc2626",
            green: "#059669",
            yellow: "#ca8a04",
            blue: "#2563eb",
            magenta: "#9333ea",
            cyan: "#0891b2",
            white: "#52525b",
            brightBlack: "#71717a",
            brightRed: "#ef4444",
            brightGreen: "#10b981",
            brightYellow: "#eab308",
            brightBlue: "#3b82f6",
            brightMagenta: "#a855f7",
            brightCyan: "#06b6d4",
            brightWhite: "#09090b",
          }
        : {
            background: "#181818",
            foreground: "#d4d4d8",
            cursor: "#d4d4d8",
            cursorAccent: "#181818",
            selectionBackground: "#34343b",
            black: "#1d1d20",
            red: "#f48771",
            green: "#86d9a3",
            yellow: "#fbbf24",
            blue: "#6cb6ff",
            magenta: "#d2a8ff",
            cyan: "#56d4dd",
            white: "#d4d4d8",
            brightBlack: "#8c8c97",
            brightRed: "#f48771",
            brightGreen: "#86d9a3",
            brightYellow: "#fbbf24",
            brightBlue: "#6cb6ff",
            brightMagenta: "#d2a8ff",
            brightCyan: "#56d4dd",
            brightWhite: "#f4f4f5",
          },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const writeSystemLine = (message: string, color = "90") => {
      term.writeln(`\x1b[${color}m# ${message}\x1b[0m`);
    };

    const ensurePtyReady = (): Promise<void> => {
      if (ptyReadyRef.current) return ptyReadyRef.current;

      ptyReadyRef.current = (async () => {
        let existingBuffer = "";
        try {
          existingBuffer = await readPtyBuffer();
        } catch {
          await spawnPty(Math.max(term.cols, 120), Math.max(term.rows, 32));
          existingBuffer = await readPtyBuffer().catch(() => "");
        }

        if (disposed) return;

        unlisten = await onPtyData((chunk) => {
          if (!disposed) {
            term.write(chunk);
          }
        });

        if (disposed) {
          unlisten?.();
          unlisten = null;
          return;
        }

        if (existingBuffer) {
          term.write(existingBuffer);
        } else {
          writeSystemLine("PTY connected");
        }

        await resizePty(Math.max(term.cols, 20), Math.max(term.rows, 5)).catch(() => {});
      })().catch((error) => {
        ptyReadyRef.current = null;
        if (!disposed) {
          const message = error instanceof Error ? error.message : String(error);
          writeSystemLine(`PTY error: ${message}`, "31");
        }
        throw error;
      });

      return ptyReadyRef.current;
    };

    const syncTerminalSize = () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore transient fit errors while the panel is resizing/unmounting
      }

      void ensurePtyReady()
        .then(() => resizePty(Math.max(term.cols, 20), Math.max(term.rows, 5)))
        .catch(() => {});
    };

    void ensurePtyReady();

    const disposable = term.onData((data) => {
      void ensurePtyReady()
        .then(() => writePty(data))
        .catch((error) => {
          if (disposed) return;
          const message = error instanceof Error ? error.message : String(error);
          writeSystemLine(`write failed: ${message}`, "31");
        });
    });

    const resizeObserver = new ResizeObserver(() => {
      syncTerminalSize();
    });
    resizeObserver.observe(termRef.current);

    return () => {
      disposed = true;
      disposable.dispose();
      resizeObserver.disconnect();
      unlisten?.();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      ptyReadyRef.current = null;
    };
  }, [themeMode]);

  return <div ref={termRef} className="h-full w-full" />;
}

/** File Viewer Panel with syntax highlighting */
function FileViewerPanel({
  filePath,
  fileContent,
  fileError,
  fileLoading,
  fileCategory,
  fileLang,
  fileName,
  uiLanguage,
  onClose,
}: {
  filePath: string;
  fileContent: string;
  fileError: string | null;
  fileLoading: boolean;
  fileCategory: "markdown" | "image" | "binary" | "code";
  fileLang: string;
  fileName: string;
  uiLanguage: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  // Language badge styling per category
  const langBadge = useMemo(() => {
    if (fileCategory === "markdown") return { label: "Markdown", color: "#93c5fd", bg: "rgba(96,165,250,0.12)", border: "rgba(96,165,250,0.28)" };
    if (fileCategory === "image") return { label: "Image", color: "#86d9a3", bg: "rgba(134,217,163,0.12)", border: "rgba(134,217,163,0.28)" };
    if (fileCategory === "binary") return { label: "Binary", color: "#f48771", bg: "rgba(244,135,113,0.12)", border: "rgba(244,135,113,0.28)" };
    if (fileLang === "text" || fileLang === "plaintext") return { label: "Text", color: "#a1a1aa", bg: "rgba(161,161,170,0.12)", border: "rgba(161,161,170,0.28)" };
    return { label: fileLang, color: "#d2a8ff", bg: "rgba(210,168,255,0.12)", border: "rgba(210,168,255,0.28)" };
  }, [fileCategory, fileLang]);

  return (
    <div className="flex h-full flex-col bg-[#050505]">
      <div className="flex items-center justify-between gap-3 border-b border-[#18181b] px-4 py-3">
        <div className="min-w-0 flex items-center gap-2.5">
          <span
            className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ borderColor: langBadge.border, backgroundColor: langBadge.bg, color: langBadge.color }}
          >
            {langBadge.label}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-[#e4e4e7]">{fileName}</div>
            <div className="truncate font-mono text-[11px] text-[#71717a]">{filePath}</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md border border-[#27272a] bg-[#09090b] px-2 py-1 text-[11px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
        >
          {uiLanguage === "zh" ? "关闭" : "Close"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {fileLoading ? (
          <div className="text-[12px] text-[#71717a]">{uiLanguage === "zh" ? "加载中..." : "Loading..."}</div>
        ) : fileError ? (
          <div className="rounded-lg border border-[#7f1d1d] bg-[rgba(127,29,29,0.12)] p-4 text-[12px] text-[#f48771]">
            {fileError}
          </div>
        ) : fileCategory === "markdown" ? (
          <div className="rounded-2xl border border-[#18181b] bg-[#09090b] p-5 shadow-[0_20px_40px_rgba(0,0,0,0.2)]">
            <MarkdownRenderer content={fileContent} />
          </div>
        ) : fileCategory === "image" ? (
          <div className="flex items-center justify-center p-4">
            <img
              src={toAssetUrl(filePath)}
              alt={fileName}
              className="max-h-[70vh] max-w-full rounded-lg border border-[#27272a] bg-[#09090b] object-contain shadow-lg"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          </div>
        ) : fileCategory === "binary" ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#71717a]">
            <IconFileText className="h-12 w-12 opacity-30" />
            <div className="text-[13px]">{uiLanguage === "zh" ? "二进制文件，无法预览" : "Binary file — cannot preview"}</div>
            <div className="font-mono text-[11px] opacity-60">{fileName}</div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[#18181b] bg-[#09090b] shadow-[0_20px_40px_rgba(0,0,0,0.2)]">
            <div className="flex items-center justify-between border-b border-[#18181b] px-4 py-2">
              <span className="text-[12px] uppercase tracking-[0.18em] text-[#71717a]">
                {fileLang !== "text" ? fileLang : (uiLanguage === "zh" ? "文件内容" : "File Contents")}
              </span>
              <button
                onClick={handleCopy}
                className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
              >
                {copied ? (uiLanguage === "zh" ? "已复制" : "Copied") : (uiLanguage === "zh" ? "复制" : "Copy")}
              </button>
            </div>
            <SyntaxHighlighter
              style={vscDarkPlus}
              language={fileLang}
              PreTag="div"
              showLineNumbers
              lineNumberStyle={{ color: "#3f3f46", minWidth: "3em", paddingRight: "1em" }}
              customStyle={{
                margin: 0,
                padding: "1rem",
                background: "transparent",
                fontFamily: CODE_FONT_FAMILY,
                fontSize: "12px",
                lineHeight: 1.7,
              }}
              codeTagProps={{
                style: { fontFamily: CODE_FONT_FAMILY, fontSize: "inherit" },
              }}
            >
              {fileContent}
            </SyntaxHighlighter>
          </div>
        )}
      </div>
    </div>
  );
}

interface RightPanelProps {
  activeDiffTask?: any;
  rightPanelWidth: number;
  startResizing: (e: React.MouseEvent) => void;
}

export default function RightPanel({ activeDiffTask, rightPanelWidth, startResizing }: RightPanelProps) {
  const {
    showDiff,
    showPlanPanel,
    showTerminal,
    rightPanelTab,
    closeRightPanel,
    clearFileViewer,
    planArtifacts,
    planTasks,
    planStage,
    conversationTurns,
    taskFlow,
    approvePlan,
    rejectPlan,
    sendMessage,
    deletePersistedPlanFiles,
    agentStatus,
    config,
    isPlanApproved,
    currentWorkspace,
    currentSessionId,
    showFilePanel,
    fileViewerPath,
    fileViewerContent,
    fileViewerError,
    fileViewerLoading,
    selectedDiffTaskId,
  } = {
    showDiff: useAppStore((s) => s.showDiff),
    showPlanPanel: useAppStore((s) => s.showPlanPanel),
    showTerminal: useAppStore((s) => s.showTerminal),
    rightPanelTab: useAppStore((s) => s.rightPanelTab),
    closeRightPanel: useAppStore((s) => s.closeRightPanel),
    clearFileViewer: useAppStore((s) => s.clearFileViewer),
    planArtifacts: useAppStore((s) => s.planArtifacts),
    planTasks: useAppStore((s) => s.planTasks),
    planStage: useAppStore((s) => s.planStage),
    conversationTurns: useAppStore((s) => s.conversationTurns),
    taskFlow: useAppStore((s) => s.taskFlow),
    approvePlan: useAppStore((s) => s.approvePlan),
    rejectPlan: useAppStore((s) => s.rejectPlan),
    sendMessage: useAppStore((s) => s.sendMessage),
    deletePersistedPlanFiles: useAppStore((s) => s.deletePersistedPlanFiles),
    agentStatus: useAppStore((s) => s.agentStatus),
    config: useAppStore((s) => s.config),
    isPlanApproved: useAppStore((s) => s.isPlanApproved),
    currentWorkspace: useAppStore((s) => s.currentWorkspace),
    currentSessionId: useAppStore((s) => s.currentSessionId),
    showFilePanel: useAppStore((s) => s.showFilePanel),
    fileViewerPath: useAppStore((s) => s.fileViewerPath),
    fileViewerContent: useAppStore((s) => s.fileViewerContent),
    fileViewerError: useAppStore((s) => s.fileViewerError),
    fileViewerLoading: useAppStore((s) => s.fileViewerLoading),
    selectedDiffTaskId: useAppStore((s) => s.selectedDiffTaskId),
  };

  const selectedDiffTask = useMemo(() => {
    if (selectedDiffTaskId == null) return null;
    const task = taskFlow.find((block) => block.type === "tool" && block.id === selectedDiffTaskId && !!block.diff);
    return task?.type === "tool" ? task : null;
  }, [selectedDiffTaskId, taskFlow]);
  const viewedDiffTask = activeDiffTask ?? selectedDiffTask;
  const diffLines = useMemo(
    () => viewedDiffTask?.diff ? buildLineDiff(viewedDiffTask.diff.old, viewedDiffTask.diff.new) : [],
    [viewedDiffTask?.diff?.new, viewedDiffTask?.diff?.old],
  );
  const diffStats = useMemo(
    () => viewedDiffTask?.diff ? getDiffStats(viewedDiffTask.diff.old, viewedDiffTask.diff.new) : { added: 0, removed: 0 },
    [viewedDiffTask?.diff?.new, viewedDiffTask?.diff?.old],
  );
  const language = config.language === "en" ? "en" : "zh";
  const latestPlanEntry = useMemo(() => {
    const entries = conversationTurns.map((turn) => ({
      turn,
      blocks: taskFlow.filter((block) => block.turnId === turn.id),
    }));

    return [...entries].reverse().find((entry) => turnHasGeneratedPlan(entry.blocks)) || null;
  }, [conversationTurns, taskFlow]);
  const latestPlanTurn = useMemo(
    () => latestPlanEntry?.turn || [...conversationTurns].reverse().find((turn) => isPlanConversationTurn(turn)) || null,
    [conversationTurns, latestPlanEntry],
  );
  const fallbackPlanPreview = useMemo(() => {
    if (!latestPlanEntry) return "";

    for (const block of latestPlanEntry.blocks) {
      if (block.type !== "agent") continue;
      const proposal = extractStructuredPlanProposal(String(block.content || ""));
      if (proposal) return proposal.markdown;
      const draft = extractPlanDraftPreview(String(block.content || ""));
      if (draft) return draft;
    }

    return "";
  }, [latestPlanEntry]);
  const hasReviewablePlanDraft =
    fallbackPlanPreview.length > 0 &&
    planArtifacts.some((artifact) =>
      artifact.kind === "requirements" || artifact.kind === "design" || artifact.kind === "bugfix",
    );
  const hasActivePlanContext =
    !!latestPlanTurn ||
    planArtifacts.length > 0 ||
    fallbackPlanPreview.length > 0 ||
    planStage !== "idle";
  const canApproveExecution =
    hasActivePlanContext &&
    !isPlanApproved &&
    (
      planStage === "ready_to_execute" ||
      (latestPlanTurn?.status === "awaiting_approval" && hasReviewablePlanDraft) ||
      (agentStatus === "pending_review" && (hasReviewablePlanDraft || fallbackPlanPreview.length > 0))
    );
  const isAwaitingApproval =
    (hasActivePlanContext && agentStatus === "pending_review" && !isPlanApproved) || canApproveExecution;
  const isAwaitingInput =
    hasActivePlanContext &&
    !isPlanApproved &&
    latestPlanTurn?.status === "awaiting_input";
  const canContinuePlanning =
    hasActivePlanContext &&
    !isPlanApproved &&
    !isAwaitingInput &&
    !canApproveExecution &&
    (planArtifacts.length > 0 || fallbackPlanPreview.length > 0) &&
    agentStatus !== "running" &&
    agentStatus !== "pending_review";
  const canResumeExecution =
    hasActivePlanContext &&
    isPlanApproved &&
    planStage === "executing" &&
    (agentStatus === "idle" || agentStatus === "error") &&
    (
      planTasks.some((task) => task.status !== "completed") ||
      !planArtifacts.some((artifact) => artifact.kind === "tasks")
    );
  const handleContinuePlanning = () => {
    sendMessage(
      language === "zh"
        ? "请基于当前已经生成的计划草案继续收敛，不要重复前文。优先补齐关键分叉点，并在需要用户拍板时给出可点击选项；如果已经足够清晰，就输出正式 Proposal 供用户确认。未经明确批准，不要提前生成执行用的 tasks.md。"
        : "Continue refining the current plan draft without repeating earlier content. Use clickable options when a real decision is needed; once the plan is clear enough, produce the formal proposal for approval. Do not generate execution tasks.md before the user explicitly approves execution.",
      undefined,
      { hidden: true, reuseCurrentTurn: true, preservePlanState: true },
    );
  };
  const handleResumeExecution = () => {
    const e2eResumeHandler = getE2EResumeExecutionHandler();
    if (e2eResumeHandler) {
      void e2eResumeHandler();
      return;
    }

    const hasTasksArtifact =
      planArtifacts.some((artifact) => artifact.kind === "tasks") ||
      planTasks.length > 0;

    sendMessage(
      language === "zh"
        ? hasTasksArtifact
          ? "请继续执行 `.MAIN/plans/tasks.md` 中剩余未完成的任务，不要重复计划说明。先从第一个未完成 checkbox 对应的任务开始，完成后及时更新 tasks.md。"
          : "请先基于已批准的 requirements/design 或 bugfix 重新生成 `.MAIN/plans/tasks.md`，然后继续执行剩余任务，不要重复计划说明。"
        : hasTasksArtifact
        ? "Continue the remaining unfinished items in `.MAIN/plans/tasks.md` without repeating the plan. Start from the first unchecked task and update tasks.md as each item is completed."
        : "First regenerate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix, then continue the remaining execution without repeating the plan.",
      undefined,
      { hidden: true, reuseCurrentTurn: true, preservePlanState: true },
    );
  };
  const handleSavePlanDocument = async (document: { title: string; suggestedFileName: string; content: string; sourcePath?: string }) => {
    const e2eSaveHandler = getE2ESavePlanDocumentHandler();
    if (e2eSaveHandler) {
      return e2eSaveHandler(document);
    }

    const suggestedName = sanitizeSuggestedFileName(document.suggestedFileName || document.title || "plan");
    const filePath = await save({
      defaultPath: suggestedName.endsWith(".md") ? suggestedName : `${suggestedName}.md`,
      filters: [
        { name: "Markdown", extensions: ["md"] },
      ],
    });
    if (!filePath) return false;
    await exportTextFile(filePath, document.content);
    const globalChatSessionKey =
      !currentWorkspace.trim()
        ? resolveGlobalChatSessionKey(currentSessionId)
        : null;
    if (globalChatSessionKey && document.sourcePath) {
      await deleteChatTempPath(globalChatSessionKey, document.sourcePath).catch(() => {});
    }
    return true;
  };
  const hasPlanPanelContent = planArtifacts.length > 0 || fallbackPlanPreview.length > 0;
  const panelMeta = useMemo(() => {
    if (rightPanelTab === "diff") {
      return {
        icon: IconColumns,
        title: language === "zh" ? "变更对比" : "Diff Viewer",
        description: viewedDiffTask?.target || (language === "zh" ? "查看当前待审批或最近一次文件变更。" : "Inspect the current pending or latest file diff."),
      };
    }
    if (rightPanelTab === "terminal") {
      return {
        icon: IconTerminal,
        title: language === "zh" ? "集成终端" : "Terminal",
        description: language === "zh" ? "这里会同步显示当前线程中的终端输出。" : "Terminal output for the current thread appears here.",
      };
    }
    if (rightPanelTab === "file") {
      return {
        icon: IconFileText,
        title: language === "zh" ? "文件查看" : "File Viewer",
        description: fileViewerPath || (language === "zh" ? "在这里查看文件内容。" : "View file contents here."),
      };
    }
    return {
      icon: IconFileText,
      title: language === "zh" ? "计划工作区" : "Plan Workspace",
      description: latestPlanTurn?.title || (language === "zh" ? "在这里查看计划预览、审批状态和执行进度。" : "Review plan previews, approval state, and execution progress here."),
    };
  }, [fileViewerPath, language, latestPlanTurn?.title, rightPanelTab, viewedDiffTask?.target]);

  const isVisible = (showPlanPanel && hasPlanPanelContent) || showDiff || showTerminal || showFilePanel;

  if (!isVisible) return null;

  const HeaderIcon = panelMeta.icon;

  const fileCategory = getFileCategory(fileViewerPath);
  const fileLang = getLanguageFromPath(fileViewerPath);
  const fileName = fileViewerPath.split("/").pop() || fileViewerPath;
  const contentLooksBinary = fileCategory !== "image" && fileCategory !== "markdown" && looksBinary(fileViewerContent);
  const effectiveCategory = contentLooksBinary ? "binary" : fileCategory;

  return (
    <>
      <div className="w-1 cursor-col-resize hover:bg-[#3f3f46] active:bg-[#555] z-20 transition-colors" onMouseDown={startResizing} />
      <div className="bg-[#000000] flex min-w-0 flex-col shrink-0 border-l border-[#27272a] z-10" style={{ width: `${rightPanelWidth}px`, display: window.innerWidth < 1220 ? "none" : "flex" }}>
        <div className="min-h-[56px] shrink-0 border-b border-[#27272a] bg-[#09090b] px-3 py-2 flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#27272a] bg-[#050505] text-[#e4e4e7]">
              <HeaderIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="truncate text-[12px] font-semibold text-[#e4e4e7]">{panelMeta.title}</div>
                {rightPanelTab === "plan" && (
                  <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] ${(isAwaitingApproval || isAwaitingInput) ? "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]" : "border-[#27272a] bg-[#050505] text-[#a1a1aa]"}`}>
                    {isAwaitingApproval
                      ? language === "zh" ? "待审批" : "Awaiting Approval"
                      : isAwaitingInput
                      ? language === "zh" ? "待选择" : "Awaiting Choice"
                      : planArtifacts.length > 0
                      ? language === "zh" ? "已同步" : "Synced"
                      : fallbackPlanPreview
                      ? language === "zh" ? "预览" : "Preview"
                      : language === "zh" ? "空闲" : "Idle"}
                  </span>
                )}
              </div>
              <div className="truncate text-[11px] text-[#71717a]">{panelMeta.description}</div>
            </div>
          </div>

          <button onClick={closeRightPanel} className="text-[#a1a1aa] hover:text-white transition-colors p-1">
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {rightPanelTab === "plan" && hasPlanPanelContent && (
            <PlanPanel
              artifacts={planArtifacts}
              tasks={planTasks}
              stage={planStage}
              isAwaitingApproval={isAwaitingApproval}
              isAwaitingInput={isAwaitingInput}
              canApproveExecution={canApproveExecution}
              canContinuePlanning={canContinuePlanning}
              canResumeExecution={canResumeExecution}
              hideIslandOwnedSections
              isTemporaryWorkspace={!currentWorkspace.trim()}
              isApproved={isPlanApproved}
              language={language}
              turns={conversationTurns}
              fallbackPreview={fallbackPlanPreview}
              fallbackTitle={latestPlanTurn?.title}
              fallbackUpdatedAt={latestPlanTurn?.createdAt}
              onDeletePlanFiles={deletePersistedPlanFiles}
              onContinuePlanning={handleContinuePlanning}
              onResumeExecution={handleResumeExecution}
              onSaveDocument={handleSavePlanDocument}
              onApprove={approvePlan}
              onReject={rejectPlan}
            />
          )}

          {rightPanelTab === "diff" && (
            <div data-testid="diff-panel" className="flex h-full flex-col bg-[#050505]">
              <div data-testid="diff-panel-title" className="border-b border-[#18181b] px-4 py-3 text-[12px] text-[#a1a1aa]">
                {viewedDiffTask?.target
                  ? (language === "zh" ? `当前变更：${viewedDiffTask.target}` : `Current diff: ${viewedDiffTask.target}`)
                  : (language === "zh" ? "暂无待查看的 Diff" : "No diff is available right now.")}
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {viewedDiffTask?.diff ? (
                  <div className="border border-[#27272a] rounded-md overflow-hidden shadow-lg bg-[#09090b]">
                    <div className="bg-[#050505] px-3 py-2 text-xs font-mono border-b border-[#27272a] flex justify-between text-[#e4e4e7]">
                      <span className="truncate pr-2 flex items-center gap-1.5"><IconCode className="w-3.5 h-3.5 text-[#a1a1aa]" /> {viewedDiffTask.target}</span>
                      <span className="text-[#71717a]">
                        {language === "zh"
                          ? `${diffStats.removed} 行删除 · ${diffStats.added} 行新增`
                          : `${diffStats.removed} removed · ${diffStats.added} added`}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] leading-[18px] overflow-x-auto">
                      {diffLines.map((line, index) => (
                        <div
                          key={`${line.type}-${index}`}
                          className={`flex ${
                            line.type === "removed"
                              ? "bg-[#3e1e1e]/60 text-[#f48771]"
                              : line.type === "added"
                              ? "bg-[#1e3a29]/60 text-[#86d9a3]"
                              : "text-[#a1a1aa]"
                          }`}
                        >
                          <span className="w-8 shrink-0 text-right pr-2 select-none opacity-40">{line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}</span>
                          <span className="whitespace-pre flex-1 px-2">{line.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-[13px] text-[#71717a]">
                    {language === "zh" ? "暂无待审批的文件变更。" : "No pending file changes."}
                  </div>
                )}
              </div>
            </div>
          )}

          {rightPanelTab === "terminal" && (
            <div className="flex h-full flex-col bg-[#050505]">
              <div className="border-b border-[#18181b] px-4 py-3 text-[12px] text-[#a1a1aa]">{language === "zh" ? "终端输出" : "Terminal Output"}</div>
              <div className="flex-1 overflow-hidden bg-[#000000] p-1">
                <IntegratedTerminal themeMode={config.themeMode} />
              </div>
            </div>
          )}

          {rightPanelTab === "file" && showFilePanel && (
            <FileViewerPanel
              filePath={fileViewerPath}
              fileContent={fileViewerContent}
              fileError={fileViewerError}
              fileLoading={fileViewerLoading}
              fileCategory={effectiveCategory}
              fileLang={fileLang}
              fileName={fileName}
              uiLanguage={language}
              onClose={clearFileViewer}
            />
          )}
        </div>
      </div>
    </>
  );
}
