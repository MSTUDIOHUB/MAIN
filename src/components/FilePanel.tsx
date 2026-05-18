import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  IconClose,
  IconExternalLink,
  IconFileArchive,
  IconFileCode,
  IconFileConfig,
  IconFileJson,
  IconFileMarkdown,
  IconFileTable,
  IconFileText,
  IconFolder,
  IconImageIcon,
} from "./Icons";
import MarkdownRenderer from "./MarkdownRenderer";
import WorkspaceTreePanel from "./WorkspaceTreePanel";
import { useAppStore } from "../store/useAppStore";
import { getFilePreviewStrategy } from "../lib/filePreviewStrategy";
import { getFileMetadata } from "../lib/ipc";
import { useExternalFileOpen } from "../lib/useExternalFileOpen";

const CODE_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";
const MAX_TABLE_PREVIEW_ROWS = 80;
const MAX_TABLE_PREVIEW_COLUMNS = 24;
type FileCategory = "markdown" | "image" | "binary" | "json" | "table" | "config" | "unity" | "code";
type FileViewMode = "preview" | "raw";

const EXT_LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  vue: "html", svelte: "html",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", csx: "csharp", csproj: "xml",
  rs: "rust", go: "go", zig: "zig",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala",
  py: "python", pyw: "python", rb: "ruby", php: "php",
  swift: "swift", dart: "dart", lua: "lua",
  r: "r", R: "r",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", psm1: "powershell",
  clj: "clojure", cljs: "clojure", hs: "haskell", ml: "ocaml", ex: "elixir", exs: "elixir", erl: "erlang",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", cfg: "ini", conf: "ini", env: "bash",
  xml: "xml", svg: "xml", xsl: "xml", xslt: "xml",
  sql: "sql", graphql: "graphql", gql: "graphql",
  prisma: "prisma",
  shader: "hlsl", hlsl: "hlsl", compute: "hlsl", cginc: "hlsl",
  md: "markdown", mdx: "mdx",
  tex: "latex",
  cmake: "cmake", makefile: "makefile",
  dockerfile: "docker", gradle: "groovy",
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
  "zip", "tar", "gz", "rar", "7z", "bz2", "xz", "zst", "tgz",
  "pdf", "doc", "docx", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm",
  "mp3", "mp4", "avi", "mov", "mkv", "wav", "flac", "ogg", "webm", "m4a",
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
  if (fileName.startsWith(".") && !fileName.includes(".", 1)) {
    const name = fileName.slice(1).toLowerCase();
    if (EXT_LANG_MAP[name]) return EXT_LANG_MAP[name];
    return "text";
  }

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
  const lowerName = getFileName(path).toLowerCase();
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

function toAssetUrl(path: string): string {
  return `asset://localhost/${encodeURIComponent(path).replace(/%2F/g, "/").replace(/%3A/g, ":")}`;
}

function looksBinary(content: string): boolean {
  if (!content) return false;
  const sample = content.slice(0, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code < 8 || (code >= 14 && code < 32 && code !== 10 && code !== 13 && code !== 27)) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

function formatFileSize(bytes: number | undefined, language: "zh" | "en"): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  const formatted = `${value.toFixed(precision)} ${units[unitIndex]}`;
  return language === "zh" ? formatted : formatted;
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

function getFileViewerPalette(isLight: boolean, isBlack: boolean) {
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
        lineNumber: "#5f8d4e",
        dangerBg: "#fff1f2",
        dangerBorder: "#fecdd3",
        dangerText: "#be123c",
        tableHeaderBg: "#f0f1f4",
        tableRowAlt: "#fafafa",
      }
    : isBlack
    ? {
        rootBg: "#000000",
        headerBg: "#050506",
        headerBorder: "#141418",
        surfaceBg: "#070708",
        surfaceAltBg: "#0b0b0d",
        surfaceBorder: "#17171c",
        text: "#e7e7ea",
        muted: "#a5a5ae",
        subtle: "#74747e",
        buttonBg: "#030304",
        buttonBorder: "#202026",
        buttonActiveBg: "#f4f4f5",
        buttonActiveText: "#09090b",
        codeBg: "#000000",
        lineNumber: "#74747e",
        dangerBg: "rgba(127,29,29,0.14)",
        dangerBorder: "#7f1d1d",
        dangerText: "#f48771",
        tableHeaderBg: "#070708",
        tableRowAlt: "#030304",
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

function FileViewerPanel({
  filePath,
  workspace,
  fileContent,
  fileWindow,
  fileError,
  fileLoading,
  fileCategory,
  fileLang,
  fileName,
  themeMode,
  uiLanguage,
  onClose,
  onLoadNextWindow,
}: {
  filePath: string;
  workspace: string;
  fileContent: string;
  fileWindow: {
    startLine: number;
    endLine: number;
    totalLines: number;
    totalChars: number;
    truncated: boolean;
    nextStartLine?: number | null;
  } | null;
  fileError: string | null;
  fileLoading: boolean;
  fileCategory: FileCategory;
  fileLang: string;
  fileName: string;
  themeMode: "light" | "dark" | "black";
  uiLanguage: "zh" | "en";
  onClose: () => void;
  onLoadNextWindow: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [viewMode, setViewMode] = useState<FileViewMode>("preview");
  const [fileSizeBytes, setFileSizeBytes] = useState<number | undefined>(undefined);

  useEffect(() => {
    setCopied(false);
    setViewMode("preview");
    setWrapLines(false);
  }, [fileCategory, filePath]);

  useEffect(() => {
    let cancelled = false;
    setFileSizeBytes(undefined);
    if (!filePath) return () => {
      cancelled = true;
    };
    getFileMetadata(filePath, workspace)
      .then((metadata) => {
        if (!cancelled) setFileSizeBytes(metadata.sizeBytes);
      })
      .catch(() => {
        if (!cancelled) setFileSizeBytes(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, workspace]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard failures; the viewer remains usable.
    }
  };

  const isLight = themeMode === "light";
  const isBlack = themeMode === "black";
  const palette = useMemo(() => getFileViewerPalette(isLight, isBlack), [isBlack, isLight]);
  const langBadge = useMemo(() => getFileDisplayMeta(fileCategory, fileLang, filePath, isLight), [fileCategory, fileLang, filePath, isLight]);
  const jsonPreview = useMemo(() => fileCategory === "json" ? getJsonPreview(fileContent, filePath) : null, [fileCategory, fileContent, filePath]);
  const tablePreview = useMemo(() => fileCategory === "table" ? getTablePreview(fileContent, filePath) : null, [fileCategory, fileContent, filePath]);
  const syntaxTheme = isLight ? oneLight : vscDarkPlus;
  const hasPreviewToggle = fileCategory === "json" || fileCategory === "table";
  const showPreview = hasPreviewToggle && viewMode === "preview";
  const BadgeIcon = langBadge.Icon;
  const hasMoreFileContent = !!fileWindow?.truncated && !!fileWindow.nextStartLine;
  const previewSizeBytes = fileSizeBytes ?? fileWindow?.totalChars ?? (fileContent ? fileContent.length : undefined);
  const previewStrategy = useMemo(() => getFilePreviewStrategy({
    path: filePath,
    sizeBytes: previewSizeBytes,
    isBinary: fileCategory === "binary",
  }), [fileCategory, filePath, previewSizeBytes]);
  const externalOpen = useExternalFileOpen({ path: filePath, workspace, language: uiLanguage });

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

  const openButtonLabel = externalOpen.opening
    ? (uiLanguage === "zh" ? "打开中..." : "Opening...")
    : (uiLanguage === "zh" ? "默认应用打开" : "Open in Default App");

  const renderExternalOpenButton = (variant: "compact" | "primary" = "compact") => (
    <button
      type="button"
      onClick={() => void externalOpen.openExternalFile()}
      disabled={externalOpen.opening || !filePath}
      className={[
        "inline-flex shrink-0 items-center justify-center gap-1.5 border font-semibold transition-opacity hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary"
          ? "rounded-lg px-3.5 py-2 text-[12px]"
          : "rounded-md px-2.5 py-1 text-[11px]",
      ].join(" ")}
      style={variant === "primary" ? activeButtonStyle : buttonBaseStyle}
      title={uiLanguage === "zh" ? "使用系统默认应用打开文件" : "Open with the system default app"}
      aria-label={uiLanguage === "zh" ? "使用系统默认应用打开文件" : "Open with the system default app"}
    >
      <IconExternalLink className={variant === "primary" ? "h-4 w-4" : "h-3.5 w-3.5"} />
      <span>{openButtonLabel}</span>
    </button>
  );

  const externalOnlyText = previewStrategy.reason === "office"
    ? (uiLanguage === "zh"
      ? "Office 文件更适合使用系统默认应用查看和编辑。"
      : "Office files are best viewed and edited in the system default app.")
    : (uiLanguage === "zh"
      ? "此文件类型暂不支持内联预览，建议使用系统默认应用打开。"
      : "Inline preview is not available for this file type. Use the system default app instead.");

  const largeFileRecommendation = previewStrategy.reason === "largeFile"
    ? (uiLanguage === "zh"
      ? `文件较大（${formatFileSize(previewStrategy.sizeBytes, uiLanguage)}），建议使用系统默认应用打开；仍可继续分段预览。`
      : `This file is large (${formatFileSize(previewStrategy.sizeBytes, uiLanguage)}). Opening it in the system default app is recommended; segmented preview remains available.`)
    : "";

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
          color: palette.text,
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
        className="overflow-hidden rounded-2xl border"
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
        <div className="flex shrink-0 items-center gap-2">
          {renderExternalOpenButton("compact")}
          <button
            onClick={onClose}
            className="shrink-0 rounded-md border px-2 py-1 text-[11px] transition-opacity hover:opacity-75"
            style={buttonBaseStyle}
          >
            {uiLanguage === "zh" ? "返回" : "Back"}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {externalOpen.error && (
          <div
            role="alert"
            className="mb-3 rounded-lg border p-3 text-[12px]"
            style={{ borderColor: palette.dangerBorder, backgroundColor: palette.dangerBg, color: palette.dangerText }}
          >
            {externalOpen.error}
          </div>
        )}
        {largeFileRecommendation && !fileError && (
          <div
            className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[12px]"
            style={{ borderColor: langBadge.border, backgroundColor: langBadge.bg, color: langBadge.color }}
          >
            <span>{largeFileRecommendation}</span>
            {renderExternalOpenButton("compact")}
          </div>
        )}
        {fileWindow && !fileError && fileCategory !== "image" && fileCategory !== "binary" && (
          <div
            className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[11px]"
            style={{ borderColor: palette.surfaceBorder, backgroundColor: palette.surfaceAltBg, color: palette.subtle }}
          >
            <span>
              {uiLanguage === "zh"
                ? `当前窗口：第 ${fileWindow.startLine}-${fileWindow.endLine} 行 / 共 ${fileWindow.totalLines} 行`
                : `Window: lines ${fileWindow.startLine}-${fileWindow.endLine} of ${fileWindow.totalLines}`}
            </span>
            {hasMoreFileContent && (
              <button
                type="button"
                onClick={onLoadNextWindow}
                disabled={fileLoading}
                className="rounded-md border px-2.5 py-1 text-[10px] font-semibold transition-opacity hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-50"
                style={buttonBaseStyle}
              >
                {fileLoading
                  ? (uiLanguage === "zh" ? "加载中..." : "Loading...")
                  : (uiLanguage === "zh" ? "加载下一段" : "Load Next")}
              </button>
            )}
          </div>
        )}
        {fileLoading ? (
          <div className="text-[12px]" style={{ color: palette.subtle }}>{uiLanguage === "zh" ? "加载中..." : "Loading..."}</div>
        ) : fileCategory === "binary" ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20" style={{ color: palette.subtle }}>
            <IconFileText className="h-12 w-12 opacity-30" />
            <div className="max-w-[320px] text-center text-[13px]">{externalOnlyText}</div>
            <div className="font-mono text-[11px] opacity-60">{fileName}</div>
            {renderExternalOpenButton("primary")}
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
            className="overflow-hidden rounded-2xl border"
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
              className="max-h-[70vh] max-w-full rounded-lg border object-contain"
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

interface FilePanelProps {
  width: number;
  onStartResizing: (e: React.MouseEvent) => void;
}

export default function FilePanel({ width, onStartResizing }: FilePanelProps) {
  const showFilePanel = useAppStore((s) => s.showFilePanel);
  const fileViewerPath = useAppStore((s) => s.fileViewerPath);
  const fileViewerContent = useAppStore((s) => s.fileViewerContent);
  const fileViewerWindow = useAppStore((s) => s.fileViewerWindow);
  const fileViewerError = useAppStore((s) => s.fileViewerError);
  const fileViewerLoading = useAppStore((s) => s.fileViewerLoading);
  const clearFileViewer = useAppStore((s) => s.clearFileViewer);
  const closeFilePanel = useAppStore((s) => s.closeFilePanel);
  const openFileViewer = useAppStore((s) => s.openFileViewer);
  const loadNextFileViewerWindow = useAppStore((s) => s.loadNextFileViewerWindow);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const config = useAppStore((s) => s.config);
  const workspaceContentVersion = useAppStore((s) => s.workspaceContentVersion);

  const language = config.language === "en" ? "en" : "zh";
  const workspaceName = useMemo(() => {
    if (!currentWorkspace) return "";
    return currentWorkspace.split("/").filter(Boolean).pop() || currentWorkspace;
  }, [currentWorkspace]);
  const fileCategory = useMemo(() => getFileCategory(fileViewerPath), [fileViewerPath]);
  const fileLang = useMemo(() => getLanguageFromPath(fileViewerPath), [fileViewerPath]);
  const fileName = useMemo(() => getFileName(fileViewerPath), [fileViewerPath]);
  const contentLooksBinary = useMemo(
    () => fileCategory !== "image" && fileCategory !== "markdown" && looksBinary(fileViewerContent),
    [fileCategory, fileViewerContent],
  );
  const effectiveCategory = contentLooksBinary ? "binary" : fileCategory;
  const filePanelScopeRef = useRef({ workspace: currentWorkspace, sessionId: currentSessionId });
  const previousContentVersionRef = useRef(workspaceContentVersion);

  const handleOpenFile = useCallback((path: string) => openFileViewer(path, currentWorkspace), [currentWorkspace, openFileViewer]);

  useEffect(() => {
    const previous = filePanelScopeRef.current;
    const changed = previous.workspace !== currentWorkspace || previous.sessionId !== currentSessionId;
    filePanelScopeRef.current = { workspace: currentWorkspace, sessionId: currentSessionId };
    if (changed && showFilePanel) {
      clearFileViewer();
    }
  }, [clearFileViewer, currentSessionId, currentWorkspace, showFilePanel]);

  useEffect(() => {
    if (!showFilePanel) {
      previousContentVersionRef.current = workspaceContentVersion;
      return;
    }
    if (previousContentVersionRef.current === workspaceContentVersion) return;
    previousContentVersionRef.current = workspaceContentVersion;
    if (fileViewerPath && currentWorkspace) {
      void openFileViewer(fileViewerPath, currentWorkspace);
    }
  }, [currentWorkspace, fileViewerPath, openFileViewer, showFilePanel, workspaceContentVersion]);

  if (!showFilePanel) return null;

  const title = fileViewerPath ? (language === "zh" ? "文件查看" : "File Viewer") : (language === "zh" ? "文件" : "Files");
  const description = fileViewerPath || workspaceName || currentWorkspace || (language === "zh" ? "查看当前工作区文件。" : "Browse the current workspace files.");

  return (
    <>
      <div
        className="w-1 cursor-col-resize hover:bg-[#3f3f46] active:bg-[#555] z-20 transition-colors"
        onMouseDown={onStartResizing}
      />
      <aside
        data-testid="file-panel"
        className="bg-[#000000] flex min-w-0 shrink-0 flex-col border-l border-r border-[#27272a] z-10"
        style={{ width: `${width}px`, display: window.innerWidth < 1120 ? "none" : "flex" }}
      >
        <div className="min-h-[56px] shrink-0 border-b border-[#27272a] bg-[#09090b] px-3 py-2 flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#27272a] bg-[#050505] text-[#e4e4e7]">
              <IconFolder className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold text-[#e4e4e7]">{title}</div>
              <div className="truncate text-[11px] text-[#71717a]" title={description}>{description}</div>
            </div>
          </div>
          <button
            onClick={closeFilePanel}
            className="text-[#a1a1aa] hover:text-white transition-colors p-1"
            title={language === "zh" ? "关闭文件面板" : "Close file panel"}
            aria-label={language === "zh" ? "关闭文件面板" : "Close file panel"}
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {fileViewerPath ? (
            <MemoizedFileViewerPanel
              filePath={fileViewerPath}
              workspace={currentWorkspace}
              fileContent={fileViewerContent}
              fileWindow={fileViewerWindow}
              fileError={fileViewerError}
              fileLoading={fileViewerLoading}
              fileCategory={effectiveCategory}
              fileLang={fileLang}
              fileName={fileName}
              themeMode={config.themeMode}
              uiLanguage={language}
              onClose={clearFileViewer}
              onLoadNextWindow={loadNextFileViewerWindow}
            />
          ) : (
            <WorkspaceTreePanel
              currentWorkspace={currentWorkspace}
              language={language}
              embedded
              onOpenFile={handleOpenFile}
            />
          )}
        </div>
      </aside>
    </>
  );
}
