import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClose,
  IconColumns,
  IconFileArchive,
  IconFileCode,
  IconFileConfig,
  IconFileJson,
  IconFileMarkdown,
  IconFileTable,
  IconFileText,
  IconImageIcon,
  IconTerminal,
} from "./Icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { save } from "@tauri-apps/plugin-dialog";
import PlanPanel from "./PlanPanel";
import { buildLineDiff, getDiffStats } from "../lib/diff";
import { getE2EResumeExecutionHandler, getE2ESavePlanDocumentHandler } from "../lib/e2e";
import { extractPlanDraftPreview, extractStructuredPlanProposal, hasPlanDraftPreview, hasStructuredPlanProposal } from "../lib/planProposal";
import MarkdownRenderer from "./MarkdownRenderer";
import { resolveGlobalChatSessionKey, resolveSessionRuntimeKey, resolveSessionWorkspaceKey, type TaskBlock, useAppStore } from "../store/useAppStore";
import { deleteChatTempPath, exportTextFile, onPtyData, readPtyBuffer, resizePty, spawnPty, writePty } from "../lib/ipc";
import { collectChangeEntries, isPlanConversationTurn } from "../lib/workflowModels";

const CODE_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";
const TERMINAL_FONT_FAMILY = [
  "'JetBrains Mono'",
  "'Fira Code'",
  "'SF Mono'",
  "Menlo",
  "Monaco",
  "Consolas",
  "'Liberation Mono'",
  "'Noto Sans Mono CJK SC'",
  "'Noto Sans CJK SC'",
  "'PingFang SC'",
  "'Microsoft YaHei UI'",
  "'Microsoft YaHei'",
  "'WenQuanYi Micro Hei'",
  "monospace",
].join(", ");
const MAX_TABLE_PREVIEW_ROWS = 80;
const MAX_TABLE_PREVIEW_COLUMNS = 24;

type FileCategory = "markdown" | "image" | "binary" | "json" | "table" | "config" | "unity" | "code";
type FileViewMode = "preview" | "raw";

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
  cs: "csharp", csx: "csharp", csproj: "xml",
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
  shader: "hlsl", hlsl: "hlsl", compute: "hlsl", cginc: "hlsl",
  // Docs
  md: "markdown", mdx: "mdx",
  tex: "latex",
  // Build / Tooling
  cmake: "cmake", makefile: "makefile",
  dockerfile: "docker", gradle: "groovy",
  // Other
  proto: "protobuf", tf: "hcl", hcl: "hcl",
  asset: "yaml", prefab: "yaml", meta: "yaml", unity: "yaml",
  gitignore: "bash", editorconfig: "ini",
  lock: "json",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const JSON_EXTS = new Set(["json", "jsonc"]);
const TABLE_EXTS = new Set(["csv", "tsv"]);
const UNITY_EXTS = new Set(["asset", "prefab", "meta", "unity"]);
const CONFIG_EXTS = new Set(["yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "svg", "editorconfig"]);
const BINARY_EXTS = new Set([
  "exe", "dll", "so", "dylib", "bin", "dat",
  "zip", "tar", "gz", "rar", "7z", "bz2", "xz", "zst",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "mp4", "avi", "mov", "mkv", "wav", "flac", "ogg", "webm",
  "woff", "woff2", "ttf", "otf", "eot",
  "class", "jar", "war", "pyc", "o", "a",
]);

function getFileName(path: string): string {
  return path.split("/").pop() || path;
}

function getFileExtension(path: string): string {
  const fileName = getFileName(path);
  const lowerName = fileName.toLowerCase();
  if (lowerName.startsWith(".") && !lowerName.includes(".", 1)) return lowerName.slice(1);
  const dotIdx = lowerName.lastIndexOf(".");
  return dotIdx === -1 ? "" : lowerName.slice(dotIdx + 1);
}

function getLanguageFromPath(path: string): string {
  const fileName = getFileName(path);
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

  const ext = getFileExtension(path);
  if (!ext) return "text";
  return EXT_LANG_MAP[ext] || "text";
}

function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(getFileExtension(path));
}

function isBinaryFile(path: string): boolean {
  const fileName = getFileName(path);
  const lowerName = fileName.toLowerCase();
  // Known binary filenames
  if (lowerName === "dockerfile" || lowerName === "makefile") return false;
  return BINARY_EXTS.has(getFileExtension(path));
}

function getFileCategory(path: string): FileCategory {
  if (/\.(md|mdx)$/i.test(path)) return "markdown";
  if (isImageFile(path)) return "image";
  if (isBinaryFile(path)) return "binary";
  const ext = getFileExtension(path);
  if (JSON_EXTS.has(ext)) return "json";
  if (TABLE_EXTS.has(ext)) return "table";
  if (UNITY_EXTS.has(ext)) return "unity";
  if (CONFIG_EXTS.has(ext)) return "config";
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

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      output += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }

    if (ch === "\"") {
      inString = true;
      output += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n" && input[i] !== "\r") i++;
      if (i < input.length) output += input[i];
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 1;
      continue;
    }

    output += ch;
  }

  return output;
}

function stripJsonTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      output += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }

    if (ch === "\"") {
      inString = true;
      output += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "}" || input[j] === "]") continue;
    }

    output += ch;
  }

  return output;
}

function getJsonPreview(content: string, path: string): { text: string; error: string | null } {
  if (!content.trim()) return { text: "", error: null };

  const candidates = getFileExtension(path) === "jsonc"
    ? [stripJsonTrailingCommas(stripJsonComments(content)), content]
    : [content, stripJsonTrailingCommas(stripJsonComments(content))];

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return { text: JSON.stringify(JSON.parse(candidate), null, 2), error: null };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    text: content,
    error: lastError instanceof Error ? lastError.message : String(lastError || "Invalid JSON"),
  };
}

function parseDelimitedRows(content: string, delimiter: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const pushRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (ch === "\"" && next === "\"") {
        cell += "\"";
        i += 1;
      } else if (ch === "\"") {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === "\"" && cell.length === 0) {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      pushRow();
      if (ch === "\r" && next === "\n") i += 1;
      if (rows.length >= maxRows) return { rows, truncated: i < content.length - 1 };
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) pushRow();
  return { rows, truncated: false };
}

function getTablePreview(content: string, path: string) {
  const delimiter = getFileExtension(path) === "tsv" ? "\t" : ",";
  const parsed = parseDelimitedRows(content, delimiter, MAX_TABLE_PREVIEW_ROWS + 1);
  const meaningfulRows = parsed.rows.filter((row) => row.some((cell) => cell.length > 0));
  if (meaningfulRows.length === 0) {
    return { headers: [], rows: [], hiddenColumns: 0, truncated: false, delimiterLabel: delimiter === "\t" ? "TSV" : "CSV" };
  }

  const columnCount = Math.min(
    MAX_TABLE_PREVIEW_COLUMNS,
    Math.max(...meaningfulRows.map((row) => row.length)),
  );
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const value = meaningfulRows[0]?.[index]?.trim();
    return value || `Column ${index + 1}`;
  });
  const rows = meaningfulRows.slice(1, MAX_TABLE_PREVIEW_ROWS + 1).map((sourceRow) =>
    Array.from({ length: columnCount }, (_, index) => sourceRow[index] ?? ""),
  );

  return {
    headers,
    rows,
    hiddenColumns: Math.max(0, Math.max(...meaningfulRows.map((row) => row.length)) - columnCount),
    truncated: parsed.truncated || meaningfulRows.length > MAX_TABLE_PREVIEW_ROWS + 1,
    delimiterLabel: delimiter === "\t" ? "TSV" : "CSV",
  };
}

function getFileViewerPalette(isLight: boolean) {
  return isLight
    ? {
        rootBg: "#f7f7f8",
        headerBg: "#ffffff",
        headerBorder: "#d8d8dd",
        surfaceBg: "#ffffff",
        surfaceAltBg: "#f5f5f6",
        surfaceBorder: "#d9d9df",
        text: "#18181b",
        muted: "#5f636d",
        subtle: "#7a7f8b",
        buttonBg: "#ffffff",
        buttonBorder: "#d4d4dc",
        buttonActiveBg: "#18181b",
        buttonActiveText: "#ffffff",
        codeBg: "#fbfbfc",
        codeBorder: "#e0e0e5",
        codeText: "#24262d",
        lineNumber: "#5f8d4e",
        dangerBg: "#fff1f2",
        dangerBorder: "#fecdd3",
        dangerText: "#be123c",
        tableHeaderBg: "#f0f1f4",
        tableRowAlt: "#fafafa",
      }
    : {
        rootBg: "#050505",
        headerBg: "#09090b",
        headerBorder: "#18181b",
        surfaceBg: "#09090b",
        surfaceAltBg: "#101014",
        surfaceBorder: "#18181b",
        text: "#e4e4e7",
        muted: "#a1a1aa",
        subtle: "#71717a",
        buttonBg: "#09090b",
        buttonBorder: "#27272a",
        buttonActiveBg: "#f4f4f5",
        buttonActiveText: "#09090b",
        codeBg: "#09090b",
        codeBorder: "#18181b",
        codeText: "#d4d4d8",
        lineNumber: "#71717a",
        dangerBg: "rgba(127,29,29,0.16)",
        dangerBorder: "#7f1d1d",
        dangerText: "#f48771",
        tableHeaderBg: "#111118",
        tableRowAlt: "#0d0d11",
      };
}

function getFileDisplayMeta(category: FileCategory, fileLang: string, filePath: string, isLight: boolean) {
  const ext = getFileExtension(filePath);
  const palettes = {
    markdown: isLight
      ? { color: "#1d4ed8", bg: "rgba(37,99,235,0.09)", border: "rgba(37,99,235,0.28)" }
      : { color: "#93c5fd", bg: "rgba(96,165,250,0.12)", border: "rgba(96,165,250,0.28)" },
    image: isLight
      ? { color: "#047857", bg: "rgba(5,150,105,0.09)", border: "rgba(5,150,105,0.28)" }
      : { color: "#86d9a3", bg: "rgba(134,217,163,0.12)", border: "rgba(134,217,163,0.28)" },
    binary: isLight
      ? { color: "#b91c1c", bg: "rgba(220,38,38,0.08)", border: "rgba(220,38,38,0.24)" }
      : { color: "#f48771", bg: "rgba(244,135,113,0.12)", border: "rgba(244,135,113,0.28)" },
    json: isLight
      ? { color: "#92400e", bg: "rgba(217,119,6,0.09)", border: "rgba(217,119,6,0.26)" }
      : { color: "#fbbf24", bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.28)" },
    table: isLight
      ? { color: "#0f766e", bg: "rgba(13,148,136,0.09)", border: "rgba(13,148,136,0.26)" }
      : { color: "#2dd4bf", bg: "rgba(45,212,191,0.12)", border: "rgba(45,212,191,0.28)" },
    config: isLight
      ? { color: "#4338ca", bg: "rgba(79,70,229,0.09)", border: "rgba(79,70,229,0.26)" }
      : { color: "#a5b4fc", bg: "rgba(165,180,252,0.12)", border: "rgba(165,180,252,0.28)" },
    unity: isLight
      ? { color: "#7c3aed", bg: "rgba(124,58,237,0.09)", border: "rgba(124,58,237,0.26)" }
      : { color: "#d2a8ff", bg: "rgba(210,168,255,0.12)", border: "rgba(210,168,255,0.28)" },
    code: isLight
      ? { color: "#334155", bg: "rgba(51,65,85,0.08)", border: "rgba(51,65,85,0.22)" }
      : { color: "#d2a8ff", bg: "rgba(210,168,255,0.12)", border: "rgba(210,168,255,0.28)" },
  };

  if (category === "markdown") return { label: "Markdown", Icon: IconFileMarkdown, ...palettes.markdown };
  if (category === "image") return { label: "Image", Icon: IconImageIcon, ...palettes.image };
  if (category === "binary") return { label: "Binary", Icon: IconFileArchive, ...palettes.binary };
  if (category === "json") return { label: ext === "jsonc" ? "JSONC" : "JSON", Icon: IconFileJson, ...palettes.json };
  if (category === "table") return { label: ext === "tsv" ? "TSV" : "CSV", Icon: IconFileTable, ...palettes.table };
  if (category === "config") return { label: ext ? ext.toUpperCase() : "Config", Icon: IconFileConfig, ...palettes.config };
  if (category === "unity") return { label: "Unity YAML", Icon: IconFileConfig, ...palettes.unity };
  if (fileLang === "text" || fileLang === "plaintext") return { label: "Text", Icon: IconFileText, ...palettes.code };
  return { label: fileLang, Icon: IconFileCode, ...palettes.code };
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
function IntegratedTerminal({
  themeMode,
  workspace,
  sessionKey,
}: {
  themeMode: "light" | "dark";
  workspace: string;
  sessionKey?: string;
}) {
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
      fontFamily: TERMINAL_FONT_FAMILY,
      lineHeight: 1.25,
      letterSpacing: 0,
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
          existingBuffer = await readPtyBuffer(undefined, sessionKey);
        } catch {
          await spawnPty(Math.max(term.cols, 120), Math.max(term.rows, 32), sessionKey, workspace);
          existingBuffer = await readPtyBuffer(undefined, sessionKey).catch(() => "");
        }

        if (disposed) return;

        unlisten = await onPtyData((chunk) => {
          if (!disposed) {
            term.write(chunk);
          }
        }, sessionKey);

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

        await resizePty(Math.max(term.cols, 20), Math.max(term.rows, 5), sessionKey).catch(() => {});
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
        .then(() => resizePty(Math.max(term.cols, 20), Math.max(term.rows, 5), sessionKey))
        .catch(() => {});
    };

    void ensurePtyReady();

    const disposable = term.onData((data) => {
      void ensurePtyReady()
        .then(() => writePty(data, sessionKey))
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
  }, [sessionKey, themeMode, workspace]);

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
  themeMode,
  uiLanguage,
  onClose,
}: {
  filePath: string;
  fileContent: string;
  fileError: string | null;
  fileLoading: boolean;
  fileCategory: FileCategory;
  fileLang: string;
  fileName: string;
  themeMode: "light" | "dark";
  uiLanguage: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [viewMode, setViewMode] = useState<FileViewMode>("preview");

  useEffect(() => {
    setCopied(false);
    setViewMode("preview");
    setWrapLines(false);
  }, [fileCategory, filePath]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const isLight = themeMode === "light";
  const palette = useMemo(() => getFileViewerPalette(isLight), [isLight]);
  const langBadge = useMemo(() => getFileDisplayMeta(fileCategory, fileLang, filePath, isLight), [fileCategory, fileLang, filePath, isLight]);
  const jsonPreview = useMemo(() => fileCategory === "json" ? getJsonPreview(fileContent, filePath) : null, [fileCategory, fileContent, filePath]);
  const tablePreview = useMemo(() => fileCategory === "table" ? getTablePreview(fileContent, filePath) : null, [fileCategory, fileContent, filePath]);
  const syntaxTheme = isLight ? oneLight : vscDarkPlus;
  const hasPreviewToggle = fileCategory === "json" || fileCategory === "table";
  const showPreview = hasPreviewToggle && viewMode === "preview";
  const BadgeIcon = langBadge.Icon;

  const buttonBaseStyle = {
    borderColor: palette.buttonBorder,
    backgroundColor: palette.buttonBg,
    color: palette.muted,
  };

  const activeButtonStyle = {
    borderColor: palette.buttonActiveBg,
    backgroundColor: palette.buttonActiveBg,
    color: palette.buttonActiveText,
  };

  const renderSyntaxBlock = (content: string, language: string) => (
    <div className={wrapLines ? "overflow-hidden" : "overflow-x-auto"} style={{ backgroundColor: palette.codeBg }}>
      <SyntaxHighlighter
        style={syntaxTheme}
        language={language}
        PreTag="div"
        showLineNumbers
        wrapLongLines={wrapLines}
        lineNumberStyle={{ color: palette.lineNumber, minWidth: "3em", paddingRight: "1em" }}
        customStyle={{
          margin: 0,
          padding: "1rem",
          background: "transparent",
          color: palette.codeText,
          fontFamily: CODE_FONT_FAMILY,
          fontSize: "12px",
          lineHeight: 1.7,
          overflowX: wrapLines ? "hidden" : "auto",
          whiteSpace: wrapLines ? "pre-wrap" : "pre",
        }}
        codeTagProps={{
          style: {
            fontFamily: CODE_FONT_FAMILY,
            fontSize: "inherit",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
            wordBreak: wrapLines ? "break-word" : "normal",
          },
        }}
      >
        {content || " "}
      </SyntaxHighlighter>
    </div>
  );

  const renderToolbar = (title: string) => (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2"
      style={{ borderColor: palette.surfaceBorder, backgroundColor: palette.surfaceAltBg }}
    >
      <span className="text-[12px] uppercase tracking-[0.16em]" style={{ color: palette.subtle }}>
        {title}
      </span>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hasPreviewToggle && (
          <div
            className="flex rounded-full border p-0.5"
            style={{ borderColor: palette.buttonBorder, backgroundColor: palette.surfaceBg }}
          >
            <button
              type="button"
              onClick={() => setViewMode("preview")}
              className="rounded-full px-2.5 py-1 text-[10px] font-semibold transition-opacity hover:opacity-75"
              style={viewMode === "preview" ? activeButtonStyle : { color: palette.muted }}
            >
              {uiLanguage === "zh" ? "预览" : "Preview"}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("raw")}
              className="rounded-full px-2.5 py-1 text-[10px] font-semibold transition-opacity hover:opacity-75"
              style={viewMode === "raw" ? activeButtonStyle : { color: palette.muted }}
            >
              {uiLanguage === "zh" ? "原文" : "Raw"}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setWrapLines((value) => !value)}
          className="rounded-full border px-3 py-1 text-[10px] font-semibold transition-opacity hover:opacity-75"
          style={wrapLines ? activeButtonStyle : buttonBaseStyle}
        >
          {uiLanguage === "zh" ? "自动换行" : "Wrap"}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-full border px-3 py-1 text-[10px] font-semibold transition-opacity hover:opacity-75"
          style={buttonBaseStyle}
        >
          {copied ? (uiLanguage === "zh" ? "已复制" : "Copied") : (uiLanguage === "zh" ? "复制" : "Copy")}
        </button>
      </div>
    </div>
  );

  const renderJsonViewer = () => {
    const preview = jsonPreview || { text: fileContent, error: null };
    const content = showPreview ? preview.text : fileContent;
    return (
      <>
        {showPreview && preview.error && (
          <div
            className="border-b px-4 py-2 text-[12px]"
            style={{ borderColor: palette.dangerBorder, backgroundColor: palette.dangerBg, color: palette.dangerText }}
          >
            {uiLanguage === "zh" ? "JSON 解析失败，已显示原文：" : "JSON parse failed, showing raw text: "}
            {preview.error}
          </div>
        )}
        {renderSyntaxBlock(content, "json")}
      </>
    );
  };

  const renderTableViewer = () => {
    if (!showPreview) return renderSyntaxBlock(fileContent, fileLang === "text" ? "csv" : fileLang);
    if (!tablePreview || tablePreview.headers.length === 0) {
      return (
        <div className="px-4 py-12 text-center text-[13px]" style={{ color: palette.subtle }}>
          {uiLanguage === "zh" ? "表格为空，暂无可预览内容。" : "The table is empty."}
        </div>
      );
    }

    return (
      <div className="overflow-auto" style={{ backgroundColor: palette.surfaceBg }}>
        <table className="w-full min-w-max border-separate border-spacing-0 text-left text-[12px]">
          <thead>
            <tr>
              {tablePreview.headers.map((header, index) => (
                <th
                  key={`${header}-${index}`}
                  className="sticky top-0 border-b border-r px-3 py-2 font-semibold"
                  style={{ borderColor: palette.surfaceBorder, backgroundColor: palette.tableHeaderBg, color: palette.text }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tablePreview.rows.map((row, rowIndex) => (
              <tr key={rowIndex} style={{ backgroundColor: rowIndex % 2 === 0 ? palette.surfaceBg : palette.tableRowAlt }}>
                {row.map((cell, columnIndex) => (
                  <td
                    key={`${rowIndex}-${columnIndex}`}
                    className="max-w-[320px] border-b border-r px-3 py-2 font-mono"
                    style={{ borderColor: palette.surfaceBorder, color: palette.text }}
                    title={cell}
                  >
                    <span className="block truncate">{cell || " "}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {(tablePreview.truncated || tablePreview.hiddenColumns > 0) && (
          <div className="border-t px-4 py-2 text-[12px]" style={{ borderColor: palette.surfaceBorder, color: palette.subtle }}>
            {uiLanguage === "zh"
              ? `仅显示前 ${MAX_TABLE_PREVIEW_ROWS} 行${tablePreview.hiddenColumns > 0 ? `，另有 ${tablePreview.hiddenColumns} 列未显示` : ""}。`
              : `Showing the first ${MAX_TABLE_PREVIEW_ROWS} rows${tablePreview.hiddenColumns > 0 ? ` with ${tablePreview.hiddenColumns} hidden columns` : ""}.`}
          </div>
        )}
      </div>
    );
  };

  const renderTextViewer = () => {
    const title =
      fileCategory === "json"
        ? (showPreview ? (uiLanguage === "zh" ? "格式化预览" : "Formatted Preview") : "JSON")
        : fileCategory === "table"
        ? (showPreview ? `${tablePreview?.delimiterLabel || "CSV"} ${uiLanguage === "zh" ? "表格预览" : "Table Preview"}` : (tablePreview?.delimiterLabel || "CSV"))
        : fileCategory === "unity"
        ? "Unity YAML"
        : fileCategory === "config"
        ? langBadge.label
        : fileLang !== "text"
        ? fileLang
        : (uiLanguage === "zh" ? "文件内容" : "File Contents");

    return (
      <div
        className="overflow-hidden rounded-2xl border shadow-[0_20px_40px_rgba(0,0,0,0.08)]"
        style={{ borderColor: palette.surfaceBorder, backgroundColor: palette.surfaceBg }}
      >
        {renderToolbar(title)}
        {fileCategory === "json"
          ? renderJsonViewer()
          : fileCategory === "table"
          ? renderTableViewer()
          : renderSyntaxBlock(fileContent, fileCategory === "unity" ? "yaml" : fileLang)}
      </div>
    );
  };

  return (
    <div
      className="flex h-full flex-col"
      style={{ backgroundColor: palette.rootBg, color: palette.text, contain: "layout paint style" }}
    >
      <div
        className="flex items-center justify-between gap-3 border-b px-4 py-3"
        style={{ borderColor: palette.headerBorder, backgroundColor: palette.headerBg }}
      >
        <div className="min-w-0 flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
            style={{ borderColor: langBadge.border, backgroundColor: langBadge.bg, color: langBadge.color }}
          >
            <BadgeIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-[13px] font-semibold" style={{ color: palette.text }}>{fileName}</div>
              <span
                className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ borderColor: langBadge.border, backgroundColor: langBadge.bg, color: langBadge.color }}
              >
                {langBadge.label}
              </span>
            </div>
            <div className="truncate font-mono text-[11px]" style={{ color: palette.subtle }}>{filePath}</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md border px-2 py-1 text-[11px] transition-opacity hover:opacity-75"
          style={buttonBaseStyle}
        >
          {uiLanguage === "zh" ? "关闭" : "Close"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {fileLoading ? (
          <div className="text-[12px]" style={{ color: palette.subtle }}>{uiLanguage === "zh" ? "加载中..." : "Loading..."}</div>
        ) : fileCategory === "binary" ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20" style={{ color: palette.subtle }}>
            <IconFileText className="h-12 w-12 opacity-30" />
            <div className="text-[13px]">{uiLanguage === "zh" ? "此文件类型暂不支持预览" : "Preview is not available for this file type"}</div>
            <div className="font-mono text-[11px] opacity-60">{fileName}</div>
          </div>
        ) : fileError ? (
          <div
            className="rounded-lg border p-4 text-[12px]"
            style={{ borderColor: palette.dangerBorder, backgroundColor: palette.dangerBg, color: palette.dangerText }}
          >
            {fileError}
          </div>
        ) : fileCategory === "markdown" ? (
          <div
            className="overflow-hidden rounded-2xl border shadow-[0_20px_40px_rgba(0,0,0,0.08)]"
            style={{ borderColor: palette.surfaceBorder, backgroundColor: palette.surfaceBg }}
          >
            {renderToolbar("Markdown")}
            <div className="p-5">
              <MarkdownRenderer content={fileContent} />
            </div>
          </div>
        ) : fileCategory === "image" ? (
          <div className="flex items-center justify-center p-4">
            <img
              src={toAssetUrl(filePath)}
              alt={fileName}
              className="max-h-[70vh] max-w-full rounded-lg border object-contain shadow-lg"
              style={{ borderColor: palette.surfaceBorder, backgroundColor: palette.surfaceBg }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          </div>
        ) : (
          renderTextViewer()
        )}
      </div>
    </div>
  );
}

const MemoizedFileViewerPanel = React.memo(FileViewerPanel);

type ToolDiffBlock = Extract<TaskBlock, { type: "tool" }>;

interface ReviewFileDiff {
  key: string;
  path: string;
  displayPath: string;
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  taskIds: number[];
  isBinaryLike: boolean;
  isPlanFile: boolean;
}

type ReviewRow =
  | { kind: "fold"; id: string; count: number }
  | { kind: "line"; id: string; type: "unchanged" | "removed" | "added"; oldLine?: number; newLine?: number; text: string };

function collectReviewFileDiffs(taskFlow: TaskBlock[], activeDiffTask?: ToolDiffBlock | null): ReviewFileDiff[] {
  const diffBlocks = taskFlow.filter((block): block is ToolDiffBlock => block.type === "tool" && !!block.diff);
  const activeBlock = activeDiffTask?.diff ? activeDiffTask : null;
  const blocks = activeBlock && !diffBlocks.some((block) => block.id === activeBlock.id)
    ? [...diffBlocks, activeBlock]
    : diffBlocks;
  const byPath = new Map<string, ToolDiffBlock[]>();

  for (const block of blocks) {
    const path = block.diff?.path || block.target || (block.toolName ? `${block.toolName}-${block.id}` : `change-${block.id}`);
    byPath.set(path, [...(byPath.get(path) || []), block]);
  }

  return Array.from(byPath.entries()).map(([path, blocksForPath]) => {
    const first = blocksForPath[0];
    const last = blocksForPath[blocksForPath.length - 1];
    const oldText = first.diff?.old || "";
    const newText = last.diff?.new || "";
    const stats = getDiffStats(oldText, newText);
    const isBinaryLike = isBinaryFile(path) || looksBinary(oldText) || looksBinary(newText);

    return {
      key: path,
      path,
      displayPath: path,
      oldText,
      newText,
      added: stats.added,
      removed: stats.removed,
      taskIds: blocksForPath.map((block) => block.id),
      isBinaryLike,
      isPlanFile: path.replace(/\\/g, "/").toLowerCase().includes(".main/plans/"),
    };
  }).sort((a, b) => {
    if (a.isPlanFile !== b.isPlanFile) return a.isPlanFile ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}

function buildReviewRows(oldText: string, newText: string, contextSize = 3): ReviewRow[] {
  const diffLines = buildLineDiff(oldText, newText);
  const rows: ReviewRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let unchangedBuffer: ReviewRow[] = [];
  let foldIndex = 0;

  const flushUnchanged = (atEdge: boolean) => {
    if (unchangedBuffer.length === 0) return;
    if (unchangedBuffer.length > contextSize * 2 + 2) {
      const headCount = atEdge && rows.length === 0 ? 0 : contextSize;
      const tailCount = atEdge ? 0 : contextSize;
      rows.push(...unchangedBuffer.slice(0, headCount));
      rows.push({
        kind: "fold",
        id: `fold-${foldIndex++}`,
        count: unchangedBuffer.length - headCount - tailCount,
      });
      if (tailCount > 0) rows.push(...unchangedBuffer.slice(-tailCount));
    } else {
      rows.push(...unchangedBuffer);
    }
    unchangedBuffer = [];
  };

  for (const line of diffLines) {
    if (line.type === "unchanged") {
      unchangedBuffer.push({
        kind: "line",
        id: `u-${oldLine}-${newLine}`,
        type: "unchanged",
        oldLine,
        newLine,
        text: line.text,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    flushUnchanged(false);
    if (line.type === "removed") {
      rows.push({ kind: "line", id: `r-${oldLine}-${rows.length}`, type: "removed", oldLine, text: line.text });
      oldLine += 1;
    } else {
      rows.push({ kind: "line", id: `a-${newLine}-${rows.length}`, type: "added", newLine, text: line.text });
      newLine += 1;
    }
  }

  flushUnchanged(true);
  return rows;
}

function DiffReviewPanel({ taskFlow, activeDiffTask, language }: { taskFlow: TaskBlock[]; activeDiffTask?: ToolDiffBlock | null; language: "zh" | "en" }) {
  const files = useMemo(() => collectReviewFileDiffs(taskFlow, activeDiffTask), [activeDiffTask, taskFlow]);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setCollapsedFiles((prev) => {
      const validKeys = new Set(files.map((file) => file.key));
      const next = new Set(Array.from(prev).filter((key) => validKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [files]);

  const totals = useMemo(
    () => files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 }),
    [files],
  );
  const allCollapsed = files.length > 0 && files.every((file) => collapsedFiles.has(file.key));
  const toggleAll = () => setCollapsedFiles(allCollapsed ? new Set() : new Set(files.map((file) => file.key)));

  if (files.length === 0) {
    return (
      <div data-testid="diff-panel" className="flex h-full items-center justify-center bg-[#101010] px-6 text-center text-[13px] text-[#8f8f98]">
        {language === "zh" ? "当前会话暂无可查看的文件修改。" : "No file changes are available in this session."}
      </div>
    );
  }

  return (
    <div data-testid="diff-panel" className="flex h-full flex-col bg-[#101010] text-[#d4d4d8]">
      <div data-testid="diff-panel-title" className="flex shrink-0 items-center justify-between border-b border-[#252525] px-4 py-3">
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-[18px] font-bold text-[#f4f4f5]">{language === "zh" ? "未暂存" : "Changes"}</span>
          <span className="rounded-full bg-[#2b2b2d] px-2.5 py-1 text-[12px] font-bold text-[#d4d4d8]">{files.length}</span>
          <span className="truncate font-mono text-[12px] text-[#34d399]">+{totals.added}</span>
          <span className="font-mono text-[12px] text-[#ff5c5c]">-{totals.removed}</span>
        </div>
        <button
          type="button"
          onClick={toggleAll}
          className="rounded-md border border-[#2f2f32] bg-[#181818] px-2.5 py-1 text-[11px] text-[#a1a1aa] transition-colors hover:bg-[#242428] hover:text-[#f4f4f5]"
        >
          {allCollapsed ? (language === "zh" ? "展开全部" : "Expand all") : (language === "zh" ? "折叠全部" : "Collapse all")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {files.map((file) => {
          const collapsed = collapsedFiles.has(file.key);
          const rows = file.isBinaryLike ? [] : buildReviewRows(file.oldText, file.newText);
          return (
            <section key={file.key} className="border-b border-[#202020]">
              <button
                type="button"
                onClick={() => setCollapsedFiles((prev) => {
                  const next = new Set(prev);
                  if (next.has(file.key)) next.delete(file.key);
                  else next.add(file.key);
                  return next;
                })}
                className="flex w-full items-center justify-between gap-3 bg-[#101010] px-4 py-3 text-left transition-colors hover:bg-[#181818]"
              >
                <span className="min-w-0 flex items-center gap-2">
                  {collapsed ? <IconChevronRight className="h-4 w-4 text-[#a1a1aa]" /> : <IconChevronUp className="h-4 w-4 text-[#a1a1aa]" />}
                  <span className="truncate font-mono text-[14px] font-bold text-[#f4f4f5]">{file.displayPath}</span>
                </span>
                <span className="shrink-0 font-mono text-[14px] font-bold">
                  <span className="text-[#34d399]">+{file.added}</span>
                  <span className="mx-1 text-[#52525b]"> </span>
                  <span className="text-[#ff5c5c]">-{file.removed}</span>
                </span>
              </button>

              {!collapsed && (
                file.isBinaryLike ? (
                  <div className="flex h-20 items-center justify-center border-t border-[#252525] bg-[#242424] text-[13px] font-semibold text-[#a1a1aa]">
                    {language === "zh" ? "无内容" : "No content"}
                  </div>
                ) : (
                  <div className="overflow-x-auto bg-[#121212] font-mono text-[13px] leading-[22px]" style={{ fontFamily: CODE_FONT_FAMILY }}>
                    {rows.map((row) => (
                      row.kind === "fold" ? (
                        <div key={row.id} className="flex min-w-max border-y border-[#20242a] bg-[#1b1f26] text-[#a1a1aa]">
                          <div className="flex w-[72px] shrink-0 items-center justify-center border-r border-[#252a31] text-[#a1a1aa]">
                            <IconChevronDown className="h-3.5 w-3.5" />
                          </div>
                          <div className="px-4 py-1.5 text-[13px] font-semibold">
                            {language === "zh" ? `${row.count} 行未修改` : `${row.count} unmodified lines`}
                          </div>
                        </div>
                      ) : (
                        <div
                          key={row.id}
                          className={`flex min-w-max ${
                            row.type === "added"
                              ? "bg-[#173522] text-[#86d9a3]"
                              : row.type === "removed"
                              ? "bg-[#3a1d1f] text-[#ff6464]"
                              : "text-[#a6a6ad]"
                          }`}
                        >
                          <div className={`w-[48px] shrink-0 select-none border-r border-[#252525] pr-2 text-right ${row.type === "added" ? "text-[#34d399]" : row.type === "removed" ? "text-[#ff4d4d]" : "text-[#8f8f98]"}`}>
                            {row.type === "added" ? row.newLine : row.oldLine}
                          </div>
                          <div className={`w-[24px] shrink-0 select-none text-center ${row.type === "added" ? "text-[#34d399]" : row.type === "removed" ? "text-[#ff4d4d]" : "text-[#52525b]"}`}>
                            {row.type === "added" ? "+" : row.type === "removed" ? "-" : ""}
                          </div>
                          <pre className="m-0 flex-1 whitespace-pre px-2 text-inherit">{row.text || " "}</pre>
                        </div>
                      )
                    ))}
                  </div>
                )
              )}
            </section>
          );
        })}
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
    openDiffForTask,
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
    openDiffForTask: useAppStore((s) => s.openDiffForTask),
  };

  const selectedDiffTask = useMemo(() => {
    if (selectedDiffTaskId == null) return null;
    const task = taskFlow.find((block) => block.type === "tool" && block.id === selectedDiffTaskId && !!block.diff);
    return task?.type === "tool" ? task : null;
  }, [selectedDiffTaskId, taskFlow]);
  const viewedDiffTask = activeDiffTask ?? selectedDiffTask;
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
  const changeSummary = useMemo(() => {
    const scopedTaskFlow = latestPlanTurn
      ? taskFlow.filter((block) => block.turnId === latestPlanTurn.id)
      : taskFlow;
    return collectChangeEntries(scopedTaskFlow, getDiffStats);
  }, [latestPlanTurn, taskFlow]);
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
    const isRequirementsStage = planStage === "requirements";
    sendMessage(
      language === "zh"
        ? isRequirementsStage
          ? "已生成 requirements.md。请不要重复读取已读文件，直接基于 requirements 和已有上下文生成 `.MAIN/plans/design.md`；如果设计方向不明确，用 `<user_options>` 给出用户可点击选择并停止。不要生成 tasks.md 或修改源码。"
          : "请基于当前已经生成的计划草案继续收敛，不要重复前文。优先补齐关键分叉点，并在需要用户确认时用面向用户的口吻给出可点击选项；如果已经足够清晰，就输出正式 Proposal 供用户确认。未经明确批准，不要提前生成执行用的 tasks.md。"
        : isRequirementsStage
        ? "requirements.md has been generated. Do not reread files already in context; generate `.MAIN/plans/design.md` directly from requirements and existing context. If the design direction is unclear, offer `<user_options>` and stop. Do not generate tasks.md or edit source files."
        : "Continue refining the current plan draft without repeating earlier content. Use clickable options when a real decision is needed; once the plan is clear enough, produce the formal proposal for approval. Do not generate execution tasks.md before the user explicitly approves execution.",
      undefined,
      { hidden: true, reuseCurrentTurn: true, preservePlanState: true, resolvedIntent: "plan", skipIntentResolution: true },
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
          ? "请继续执行 `.MAIN/plans/tasks.md` 中剩余未完成的任务，不要重复计划说明。先从第一个未完成 checkbox 对应的任务开始，完成后及时更新 tasks.md。不要删除已完成或旧任务记录。"
          : "请先基于已批准的 requirements/design 或 bugfix 重新生成 `.MAIN/plans/tasks.md`，然后继续执行剩余任务，不要重复计划说明。"
        : hasTasksArtifact
        ? "Continue the remaining unfinished items in `.MAIN/plans/tasks.md` without repeating the plan. Start from the first unchecked task and update tasks.md as each item is completed. Do not delete completed or previous task records."
        : "First regenerate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix, then continue the remaining execution without repeating the plan.",
      undefined,
      { hidden: true, reuseCurrentTurn: true, preservePlanState: true, resolvedIntent: "plan", skipIntentResolution: true },
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
        description: viewedDiffTask?.target || (
          changeSummary.entries.length > 0
            ? language === "zh"
              ? `${changeSummary.entries.length} 个文件改动`
              : `${changeSummary.entries.length} changed file${changeSummary.entries.length > 1 ? "s" : ""}`
            : language === "zh" ? "查看当前待审批或最近一次文件变更。" : "Inspect the current pending or latest file diff."
        ),
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
  }, [changeSummary.entries.length, fileViewerPath, language, latestPlanTurn?.title, rightPanelTab, viewedDiffTask?.target]);

  const isVisible = (showPlanPanel && hasPlanPanelContent) || showDiff || showTerminal || showFilePanel;
  const terminalSessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(currentWorkspace), currentSessionId) || undefined;

  const fileCategory = useMemo(() => getFileCategory(fileViewerPath), [fileViewerPath]);
  const fileLang = useMemo(() => getLanguageFromPath(fileViewerPath), [fileViewerPath]);
  const fileName = useMemo(() => getFileName(fileViewerPath), [fileViewerPath]);
  const contentLooksBinary = useMemo(
    () => fileCategory !== "image" && fileCategory !== "markdown" && looksBinary(fileViewerContent),
    [fileCategory, fileViewerContent],
  );
  const effectiveCategory = contentLooksBinary ? "binary" : fileCategory;

  if (!isVisible) return null;

  const HeaderIcon = panelMeta.icon;

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
              changeEntries={changeSummary.entries}
              onDeletePlanFiles={deletePersistedPlanFiles}
              onContinuePlanning={handleContinuePlanning}
              onResumeExecution={handleResumeExecution}
              onOpenChangeDiff={openDiffForTask}
              onSaveDocument={handleSavePlanDocument}
              onApprove={approvePlan}
              onReject={rejectPlan}
            />
          )}

          {rightPanelTab === "diff" && (
            <DiffReviewPanel taskFlow={taskFlow} activeDiffTask={viewedDiffTask} language={language} />
          )}

          {rightPanelTab === "terminal" && (
            <div className="flex h-full flex-col bg-[#050505]">
              <div className="border-b border-[#18181b] px-4 py-3 text-[12px] text-[#a1a1aa]">{language === "zh" ? "终端输出" : "Terminal Output"}</div>
              <div className="flex-1 overflow-hidden bg-[#000000] p-1">
                <IntegratedTerminal
                  themeMode={config.themeMode}
                  workspace={currentWorkspace}
                  sessionKey={terminalSessionKey}
                />
              </div>
            </div>
          )}

          {rightPanelTab === "file" && showFilePanel && (
            <MemoizedFileViewerPanel
              filePath={fileViewerPath}
              fileContent={fileViewerContent}
              fileError={fileViewerError}
              fileLoading={fileViewerLoading}
              fileCategory={effectiveCategory}
              fileLang={fileLang}
              fileName={fileName}
              themeMode={config.themeMode}
              uiLanguage={language}
              onClose={clearFileViewer}
            />
          )}
        </div>
      </div>
    </>
  );
}
