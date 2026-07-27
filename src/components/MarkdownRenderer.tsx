import React, { memo, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { IconClose, IconExpand } from "./Icons";
import MermaidBlock from "./MermaidBlock";
import { useAppStore } from "../store/useAppStore";
import {
  decodeInlineMathCode,
  extractMarkdownNodeSource,
  isInlineMathCode,
  markdownTableToTsv,
  normalizeMarkdownForDisplay,
} from "../lib/markdownDisplay";

const LANG_MAP: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  cs: "csharp",
  rs: "rust",
  sh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "html",
};

const DIAGRAM_LANGS = new Set(["mermaid", "plantuml", "puml", "uml", "dot", "graphviz"]);
const CODE_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";

function resolveLanguage(lang?: string): string {
  if (!lang) return "text";
  const lower = lang.toLowerCase();
  return LANG_MAP[lower] || lower;
}

function collectText(children: React.ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(collectText).join("");
  if (React.isValidElement(children)) {
    return collectText((children.props as { children?: React.ReactNode }).children);
  }
  return "";
}

function slugify(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`~!@#$%^&*()+=[\]{};:'",.<>/?\\|]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function getLanguageTone(language: string, isDiagram: boolean, themeMode: "light" | "dark" | "black" = "dark") {
  const normalized = language.toLowerCase();
  const isLightTheme = themeMode === "light";

  if (isDiagram || normalized === "mermaid") {
    return isLightTheme
      ? {
          badgeBorder: "rgba(37,99,235,0.28)",
          badgeBackground: "rgba(219,234,254,0.82)",
          badgeText: "#1d4ed8",
          headerBackground: "linear-gradient(90deg, rgba(219,234,254,0.9), rgba(240,249,255,0.72))",
        }
      : {
          badgeBorder: "rgba(96,165,250,0.28)",
          badgeBackground: "rgba(96,165,250,0.12)",
          badgeText: "#93c5fd",
          headerBackground: "linear-gradient(90deg, rgba(37,99,235,0.16), rgba(14,165,233,0.08))",
        };
  }

  switch (normalized) {
    case "typescript":
    case "tsx":
      return {
        badgeBorder: "rgba(59,130,246,0.28)",
        badgeBackground: "rgba(59,130,246,0.12)",
        badgeText: "#93c5fd",
        headerBackground: "linear-gradient(90deg, rgba(59,130,246,0.16), rgba(14,165,233,0.06))",
      };
    case "javascript":
    case "jsx":
      return {
        badgeBorder: "rgba(251,191,36,0.28)",
        badgeBackground: "rgba(251,191,36,0.12)",
        badgeText: "#fcd34d",
        headerBackground: "linear-gradient(90deg, rgba(245,158,11,0.14), rgba(234,179,8,0.06))",
      };
    case "python":
      return {
        badgeBorder: "rgba(250,204,21,0.28)",
        badgeBackground: "rgba(37,99,235,0.12)",
        badgeText: "#fde68a",
        headerBackground: "linear-gradient(90deg, rgba(37,99,235,0.16), rgba(250,204,21,0.06))",
      };
    case "csharp":
      return {
        badgeBorder: "rgba(168,85,247,0.28)",
        badgeBackground: "rgba(168,85,247,0.12)",
        badgeText: "#d8b4fe",
        headerBackground: "linear-gradient(90deg, rgba(124,58,237,0.16), rgba(139,92,246,0.06))",
      };
    case "rust":
      return {
        badgeBorder: "rgba(251,146,60,0.28)",
        badgeBackground: "rgba(251,146,60,0.12)",
        badgeText: "#fdba74",
        headerBackground: "linear-gradient(90deg, rgba(234,88,12,0.14), rgba(251,146,60,0.06))",
      };
    case "bash":
    case "shell":
      return {
        badgeBorder: "rgba(52,211,153,0.28)",
        badgeBackground: "rgba(52,211,153,0.12)",
        badgeText: "#86efac",
        headerBackground: "linear-gradient(90deg, rgba(16,185,129,0.14), rgba(34,197,94,0.06))",
      };
    case "json":
    case "yaml":
    case "toml":
      return {
        badgeBorder: "rgba(45,212,191,0.28)",
        badgeBackground: "rgba(45,212,191,0.12)",
        badgeText: "#99f6e4",
        headerBackground: "linear-gradient(90deg, rgba(20,184,166,0.14), rgba(45,212,191,0.06))",
      };
    case "css":
    case "scss":
      return {
        badgeBorder: "rgba(244,114,182,0.28)",
        badgeBackground: "rgba(244,114,182,0.12)",
        badgeText: "#f9a8d4",
        headerBackground: "linear-gradient(90deg, rgba(236,72,153,0.14), rgba(244,114,182,0.06))",
      };
    case "html":
    case "svg":
      return {
        badgeBorder: "rgba(45,212,191,0.28)",
        badgeBackground: "rgba(45,212,191,0.12)",
        badgeText: "#99f6e4",
        headerBackground: "linear-gradient(90deg, rgba(20,184,166,0.14), rgba(59,130,246,0.06))",
      };
    case "math":
      return {
        badgeBorder: "rgba(251,191,36,0.28)",
        badgeBackground: "rgba(251,191,36,0.12)",
        badgeText: "#fde68a",
        headerBackground: "linear-gradient(90deg, rgba(245,158,11,0.14), rgba(251,191,36,0.05))",
      };
    case "markdown":
      return {
        badgeBorder: "rgba(161,161,170,0.28)",
        badgeBackground: "rgba(161,161,170,0.1)",
        badgeText: "#d4d4d8",
        headerBackground: "linear-gradient(90deg, rgba(113,113,122,0.16), rgba(82,82,91,0.06))",
      };
    default:
      return {
        badgeBorder: "color-mix(in srgb, var(--accent-light) 30%, transparent)",
        badgeBackground: "var(--accent-subtle)",
        badgeText: "var(--accent-light)",
        headerBackground: "linear-gradient(90deg, color-mix(in srgb, var(--accent) 12%, transparent), color-mix(in srgb, var(--accent-light) 4%, transparent))",
      };
  }
}

function MathInline({ value, baseFontSize }: { value: string; baseFontSize: number }) {
  return (
    <span
      className="mx-0.5 inline-flex max-w-full items-center rounded-md border px-1.5 py-[1px] font-mono align-baseline"
      style={{
        borderColor: "rgba(251,191,36,0.28)",
        backgroundColor: "rgba(251,191,36,0.1)",
        color: "var(--inline-chip-text, #fef3c7)",
        fontSize: `${Math.max(11, baseFontSize - 1)}px`,
        lineHeight: `${Math.max(16, baseFontSize + 3)}px`,
      }}
    >
      {value}
    </span>
  );
}

function MathBlock({ value, baseFontSize }: { value: string; baseFontSize: number }) {
  return (
    <div className="my-4 overflow-x-auto rounded-xl border border-[rgba(251,191,36,0.24)] bg-[rgba(251,191,36,0.07)] px-4 py-3">
      <pre
        className="m-0 whitespace-pre-wrap break-words font-mono text-[#fde68a]"
        style={{
          fontSize: `${baseFontSize}px`,
          lineHeight: `${Math.max(22, Math.round(baseFontSize * 1.7))}px`,
        }}
      >
        {value}
      </pre>
    </div>
  );
}

function CodeBlock({ inline = true, className, children, baseFontSize = 13, ...rest }: any) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCodeExpanded, setIsCodeExpanded] = useState(false);
  const [isWrapped, setIsWrapped] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const themeMode = useAppStore((s) => s.config.themeMode);
  const uiLanguage = useAppStore((s) => s.config.language) === "en" ? "en" : "zh";
  const copy = uiLanguage === "zh"
    ? {
        diagram: "图表",
        expand: "展开",
        collapse: "收起",
        copied: "已复制",
        copy: "复制",
        wrap: "换行",
        unwrap: "不换行",
        preview: "预览",
        htmlPreview: "沙盒预览",
        expandedDiagram: "展开图表视图",
        copySource: "复制源码",
        closeExpanded: "关闭展开视图",
      }
    : {
        diagram: "Diagram",
        expand: "Expand",
        collapse: "Collapse",
        copied: "Copied",
        copy: "Copy",
        wrap: "Wrap",
        unwrap: "No wrap",
        preview: "Preview",
        htmlPreview: "Sandbox Preview",
        expandedDiagram: "Expanded Diagram View",
        copySource: "Copy Source",
        closeExpanded: "Close expanded view",
      };
  const isLightTheme = themeMode === "light";
  const isBlackTheme = themeMode === "black";
  const syntaxTheme = isLightTheme ? oneLight : vscDarkPlus;
  const codeSurfaceTone = isLightTheme
    ? { border: "#d4d4d8", background: "#fafafa", text: "#1f2937" }
    : isBlackTheme
    ? { border: "#202026", background: "#000000", text: "#dedee3" }
    : { border: "#1f1f23", background: "#09090b", text: "#d4d4d8" };
  const match = /language-([\w-]+)/.exec(className || "");
  const language = match ? match[1].toLowerCase() : "";
  const codeStr = String(children).replace(/\n$/, "");
  const resolvedLang = resolveLanguage(language);
  const isDiagram = DIAGRAM_LANGS.has(resolvedLang);
  const isMermaid = resolvedLang === "mermaid";
  const isMath = resolvedLang === "math";
  const isHtmlPreviewable = resolvedLang === "html" || resolvedLang === "svg";
  const isPlainText = !language || resolvedLang === "text" || resolvedLang === "plaintext";
  const plainTextDisplay = codeStr.trim().replace(/\s+/g, " ");
  const isCompactPlainText = isPlainText && !codeStr.includes("\n") && plainTextDisplay.length <= 80;
  const lineCount = codeStr.split(/\r?\n/).length;
  const canCollapseCode = lineCount > 18 || codeStr.length > 2400;
  const tone = getLanguageTone(resolvedLang || "text", isDiagram, themeMode);
  const expandedTone = isLightTheme
    ? {
        overlay: "rgba(15,23,42,0.24)",
        modalBorder: "#cbd5e1",
        modalBackground: "#ffffff",
        modalShadow: "0 28px 80px rgba(15,23,42,0.18)",
        headerBorder: "#e2e8f0",
        titleText: "#1e293b",
        buttonBorder: "#cbd5e1",
        buttonBackground: "#f8fafc",
        buttonText: "#475569",
        bodyBackground: "#f8fafc",
      }
    : {
        overlay: "rgba(0,0,0,0.68)",
        modalBorder: isBlackTheme ? "#202026" : "#34343b",
        modalBackground: isBlackTheme ? "#030304" : "#1d1d20",
        modalShadow: "0 28px 80px rgba(0,0,0,0.45)",
        headerBorder: isBlackTheme ? "#141418" : "#2c2c32",
        titleText: "#d4d4d8",
        buttonBorder: isBlackTheme ? "#202026" : "#34343b",
        buttonBackground: isBlackTheme ? "#070708" : "#181818",
        buttonText: "#c4c4cc",
        bodyBackground: isBlackTheme ? "#000000" : "#181818",
      };

  useEffect(() => {
    if (!isExpanded && !isPreviewOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsExpanded(false);
        setIsPreviewOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isExpanded, isPreviewOpen]);

  if (inline) {
    if (isInlineMathCode(codeStr)) {
      return <MathInline value={decodeInlineMathCode(codeStr)} baseFontSize={baseFontSize} />;
    }

    return (
      <code
        className="rounded-md border px-2 py-[1px] font-mono align-baseline"
        style={{
          borderColor: "var(--accent-subtle-border, rgba(147, 51, 234, 0.3))",
          backgroundColor: "var(--accent-subtle, rgba(147, 51, 234, 0.15))",
          color: "var(--inline-chip-text, #f5f5f5)",
          fontSize: `${Math.max(11, baseFontSize - 1)}px`,
          lineHeight: `${Math.max(16, baseFontSize + 3)}px`,
        }}
      >
        {codeStr}
      </code>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeStr);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  if (isMath) {
    return <MathBlock value={codeStr} baseFontSize={baseFontSize} />;
  }

  if (isCompactPlainText) {
    return (
      <span
        className="inline-block max-w-full break-all rounded-md px-2 py-[1px] font-mono align-middle"
        style={{
          backgroundColor: "var(--accent-subtle, rgba(147, 51, 234, 0.15))",
          color: "var(--inline-chip-text, #f5f5f5)",
          fontSize: `${Math.max(11, baseFontSize - 1)}px`,
          lineHeight: `${Math.max(16, baseFontSize + 3)}px`,
        }}
      >
        {plainTextDisplay || codeStr.trim()}
      </span>
    );
  }

  if (isPlainText) {
    return (
      <div
        className="my-4 overflow-hidden rounded-2xl border"
        style={{ borderColor: codeSurfaceTone.border, backgroundColor: codeSurfaceTone.background }}
      >
        <div className="flex items-center justify-end gap-2 border-b border-[#1f1f23] px-4 py-2">
          {canCollapseCode && (
            <button onClick={() => setIsCodeExpanded((value) => !value)} className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]">
              {isCodeExpanded ? copy.collapse : copy.expand}
            </button>
          )}
          <button onClick={() => setIsWrapped((value) => !value)} className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]">
            {isWrapped ? copy.unwrap : copy.wrap}
          </button>
          <button onClick={handleCopy} className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]">
            {copied ? copy.copied : copy.copy}
          </button>
        </div>
        <pre
          className="m-0 overflow-auto p-4 font-mono"
          style={{
            maxHeight: canCollapseCode && !isCodeExpanded ? 360 : undefined,
            whiteSpace: isWrapped ? "pre-wrap" : "pre",
            overflowWrap: isWrapped ? "anywhere" : "normal",
            fontFamily: CODE_FONT_FAMILY,
            fontSize: `${baseFontSize}px`,
            lineHeight: `${Math.max(22, Math.round(baseFontSize * 1.7))}px`,
            color: codeSurfaceTone.text,
          }}
        >
          {codeStr}
        </pre>
      </div>
    );
  }

  const syntaxCustomStyle: React.CSSProperties = {
    margin: 0,
    padding: "1rem",
    maxHeight: canCollapseCode && !isCodeExpanded ? 420 : undefined,
    overflow: "auto",
    background: "transparent",
    color: codeSurfaceTone.text,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: `${baseFontSize}px`,
    lineHeight: 1.7,
    whiteSpace: isWrapped ? "pre-wrap" : "pre",
    overflowWrap: isWrapped ? "anywhere" : "normal",
  };

  return (
    <>
      <div
        className="my-4 overflow-hidden rounded-2xl border"
        style={{
          borderColor: codeSurfaceTone.border,
          backgroundColor: codeSurfaceTone.background,
        }}
      >
        <div className="flex items-center justify-between border-b border-[#1f1f23] px-4 py-2" style={{ background: tone.headerBackground }}>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]"
              style={{
                borderColor: tone.badgeBorder,
                backgroundColor: tone.badgeBackground,
                color: tone.badgeText,
              }}
            >
              {resolvedLang || "text"}
            </span>
            {isMermaid && (
              <span className="text-[10px] uppercase tracking-[0.18em] text-[#cbd5e1]">{copy.diagram}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isHtmlPreviewable && (
              <button
                onClick={() => setIsPreviewOpen(true)}
                className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
              >
                {copy.preview}
              </button>
            )}
            {canCollapseCode && (
              <button
                onClick={() => setIsCodeExpanded((value) => !value)}
                className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
              >
                {isCodeExpanded ? copy.collapse : copy.expand}
              </button>
            )}
            <button
              onClick={() => setIsWrapped((value) => !value)}
              className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
            >
              {isWrapped ? copy.unwrap : copy.wrap}
            </button>
            {isMermaid && (
              <button
                onClick={() => setIsExpanded(true)}
                className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
              >
                <span className="inline-flex items-center gap-1.5">
                  <IconExpand className="h-3.5 w-3.5" />
                  {copy.expand}
                </span>
              </button>
            )}
            <button onClick={handleCopy} className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]">
              {copied ? copy.copied : copy.copy}
            </button>
          </div>
        </div>

        {isMermaid ? (
          <MermaidBlock code={codeStr} />
        ) : (
          <SyntaxHighlighter
            {...rest}
            style={syntaxTheme}
            language={resolvedLang}
            PreTag="div"
            wrapLongLines={isWrapped}
            customStyle={syntaxCustomStyle}
            codeTagProps={{
              style: {
                fontFamily: CODE_FONT_FAMILY,
                fontSize: "inherit",
                whiteSpace: "inherit",
              },
            }}
          >
            {codeStr}
          </SyntaxHighlighter>
        )}
      </div>

      {isMermaid && isExpanded && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-[rgba(0,0,0,0.68)] p-6" style={{ backgroundColor: expandedTone.overlay }} onClick={() => setIsExpanded(false)}>
          <div
            className="flex h-[min(86vh,960px)] w-[min(96vw,1320px)] flex-col overflow-hidden rounded-[28px] border border-[#34343b] bg-[#1d1d20] shadow-[0_28px_80px_rgba(0,0,0,0.45)]"
            style={{
              borderColor: expandedTone.modalBorder,
              backgroundColor: expandedTone.modalBackground,
              boxShadow: expandedTone.modalShadow,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#2c2c32] px-5 py-3" style={{ borderColor: expandedTone.headerBorder, background: tone.headerBackground }}>
              <div className="flex items-center gap-3">
                <span
                  className="rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]"
                  style={{
                    borderColor: tone.badgeBorder,
                    backgroundColor: tone.badgeBackground,
                    color: tone.badgeText,
                  }}
                >
                  {resolvedLang || "text"}
                </span>
                <span className="text-[12px] text-[#d4d4d8]" style={{ color: expandedTone.titleText }}>{copy.expandedDiagram}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopy}
                  className="rounded-full border border-[#34343b] bg-[#181818] px-3 py-1 text-[10px] text-[#c4c4cc] transition-colors hover:bg-[#232327] hover:text-[#fafafa]"
                  style={{
                    borderColor: expandedTone.buttonBorder,
                    backgroundColor: expandedTone.buttonBackground,
                    color: expandedTone.buttonText,
                  }}
                >
                  {copied ? copy.copied : copy.copySource}
                </button>
                <button
                  onClick={() => setIsExpanded(false)}
                  className="rounded-full border border-[#34343b] bg-[#181818] p-2 text-[#c4c4cc] transition-colors hover:bg-[#232327] hover:text-[#fafafa]"
                  style={{
                    borderColor: expandedTone.buttonBorder,
                    backgroundColor: expandedTone.buttonBackground,
                    color: expandedTone.buttonText,
                  }}
                  aria-label={copy.closeExpanded}
                >
                  <IconClose className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden bg-[#181818]" style={{ backgroundColor: expandedTone.bodyBackground }}>
              <MermaidBlock code={codeStr} expanded />
            </div>
          </div>
        </div>,
        document.body,
      )}

      {isHtmlPreviewable && isPreviewOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[140] flex items-center justify-center p-6" style={{ backgroundColor: expandedTone.overlay }} onClick={() => setIsPreviewOpen(false)}>
          <div
            className="flex h-[min(86vh,960px)] w-[min(96vw,1320px)] flex-col overflow-hidden rounded-[28px] border"
            style={{
              borderColor: expandedTone.modalBorder,
              backgroundColor: expandedTone.modalBackground,
              boxShadow: expandedTone.modalShadow,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: expandedTone.headerBorder, background: tone.headerBackground }}>
              <div className="flex items-center gap-3">
                <span
                  className="rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]"
                  style={{ borderColor: tone.badgeBorder, backgroundColor: tone.badgeBackground, color: tone.badgeText }}
                >
                  {resolvedLang}
                </span>
                <span className="text-[12px]" style={{ color: expandedTone.titleText }}>{copy.htmlPreview}</span>
              </div>
              <button
                onClick={() => setIsPreviewOpen(false)}
                className="rounded-full border p-2 transition-colors"
                style={{ borderColor: expandedTone.buttonBorder, backgroundColor: expandedTone.buttonBackground, color: expandedTone.buttonText }}
                aria-label={copy.closeExpanded}
              >
                <IconClose className="h-4 w-4" />
              </button>
            </div>
            <iframe
              title={copy.htmlPreview}
              sandbox=""
              srcDoc={codeStr}
              className="min-h-0 flex-1 border-0 bg-white"
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function PreBlock({ children }: any) {
  return (
    <>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<any>, { inline: false })
          : child
      )}
    </>
  );
}

function Heading({
  level,
  children,
  baseFontSize = 13,
  sourceId,
  compact = false,
}: {
  level: number;
  children: React.ReactNode;
  baseFontSize?: number;
  sourceId?: string;
  compact?: boolean;
}) {
  const sizes: Record<number, number> = compact
    ? {
        1: baseFontSize * 1.28,
        2: baseFontSize * 1.18,
        3: baseFontSize * 1.08,
        4: baseFontSize * 1.04,
        5: baseFontSize,
        6: baseFontSize * 0.96,
      }
    : {
        1: baseFontSize * 1.85,
        2: baseFontSize * 1.45,
        3: baseFontSize * 1.25,
        4: baseFontSize * 1.12,
        5: baseFontSize * 1.02,
        6: baseFontSize * 0.94,
      };
  const text = collectText(children);
  const id = sourceId && text ? `md-${sourceId}-${slugify(text)}` : undefined;

  return (
    <div
      id={id}
      data-markdown-heading-level={level}
      className={`group first:mt-0 text-[#f5f5f5] ${
        compact ? "mt-4 mb-2 font-medium" : "mt-6 mb-3 font-semibold"
      }`}
      style={{ fontSize: `${Math.round((sizes[level] || sizes[3]) * 10) / 10}px` }}
    >
      {children}
      {id && (
        <a href={`#${id}`} className="ml-2 opacity-0 text-[0.72em] text-[#71717a] no-underline transition-opacity group-hover:opacity-100">
          #
        </a>
      )}
    </div>
  );
}

function Blockquote({ children }: { children: React.ReactNode }) {
  const text = collectText(children).trim();
  const level = (text.match(/^(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\b/i)?.[1] || "").toUpperCase();
  const tone = level === "WARNING" || level === "CAUTION"
    ? "border-[rgba(251,191,36,0.55)] bg-[rgba(251,191,36,0.08)] text-[#fde68a]"
    : level === "IMPORTANT"
    ? "border-[rgba(244,114,182,0.48)] bg-[rgba(244,114,182,0.08)] text-[#fbcfe8]"
    : level === "TIP"
    ? "border-[rgba(52,211,153,0.48)] bg-[rgba(52,211,153,0.08)] text-[#bbf7d0]"
    : "theme-plan-surface theme-plan-text";

  return (
    <blockquote className={`my-4 rounded-r-2xl border-l-2 px-4 py-3 ${tone}`}>
      {children}
    </blockquote>
  );
}

function TableBlock({
  children,
  node,
  source,
  baseFontSize,
}: {
  children: React.ReactNode;
  node?: any;
  source: string;
  baseFontSize: number;
}) {
  const [copied, setCopied] = useState(false);
  const uiLanguage = useAppStore((s) => s.config.language) === "en" ? "en" : "zh";
  const tableMarkdown = useMemo(() => extractMarkdownNodeSource(source, node?.position), [node?.position, source]);
  const copyLabel = copied
    ? uiLanguage === "zh" ? "已复制" : "Copied"
    : uiLanguage === "zh" ? "复制" : "Copy";

  const copyTable = async () => {
    try {
      const content = tableMarkdown || markdownTableToTsv(collectText(children));
      await navigator.clipboard.writeText(markdownTableToTsv(content) || content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      data-testid="markdown-table"
      className="group/table relative my-4 overflow-x-auto rounded-lg border"
      style={{ borderColor: "var(--surface-border)", backgroundColor: "var(--surface-2)", color: "var(--surface-text)" }}
    >
      <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-hover/table:opacity-100">
        <button
          type="button"
          onClick={copyTable}
          data-testid="markdown-table-copy"
          className="rounded-md border px-2 py-1 text-[10px] shadow-sm transition-colors"
          style={{
            borderColor: "var(--surface-border)",
            backgroundColor: "var(--surface-2)",
            color: "var(--surface-text-muted)",
          }}
        >
          {copyLabel}
        </button>
      </div>
      <table className="min-w-full" style={{ fontSize: `${Math.max(12, baseFontSize - 1)}px` }}>{children}</table>
    </div>
  );
}

const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  baseFontSize = 13,
  sourceId,
  presentation = "document",
}: {
  content: string;
  baseFontSize?: number;
  sourceId?: string;
  presentation?: "document" | "assistant_update";
}) {
  const normalized = useMemo(() => normalizeMarkdownForDisplay(content), [content]);
  const compact = presentation === "assistant_update";

  const components = useMemo(() => ({
    code: (props: any) => <CodeBlock {...props} baseFontSize={baseFontSize} />,
    pre: PreBlock,
    h1: ({ children }: any) => <Heading level={1} baseFontSize={baseFontSize} sourceId={sourceId} compact={compact}>{children}</Heading>,
    h2: ({ children }: any) => <Heading level={2} baseFontSize={baseFontSize} sourceId={sourceId} compact={compact}>{children}</Heading>,
    h3: ({ children }: any) => <Heading level={3} baseFontSize={baseFontSize} sourceId={sourceId} compact={compact}>{children}</Heading>,
    h4: ({ children }: any) => <Heading level={4} baseFontSize={baseFontSize} sourceId={sourceId} compact={compact}>{children}</Heading>,
    h5: ({ children }: any) => <Heading level={5} baseFontSize={baseFontSize} sourceId={sourceId} compact={compact}>{children}</Heading>,
    h6: ({ children }: any) => <Heading level={6} baseFontSize={baseFontSize} sourceId={sourceId} compact={compact}>{children}</Heading>,
    p: ({ children }: any) => <p className="mb-3 whitespace-pre-wrap last:mb-0 text-[#d4d4d8]">{children}</p>,
    a: ({ href, children }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="theme-text underline underline-offset-4 transition-opacity hover:opacity-80" style={{ textDecorationColor: "var(--accent-subtle-border)" }}>
        {children}
      </a>
    ),
    ul: ({ children }: any) => <ul className="mb-3 ml-5 list-disc space-y-1.5">{children}</ul>,
    ol: ({ children }: any) => <ol className="mb-3 ml-5 list-decimal space-y-1.5">{children}</ol>,
    li: ({ children }: any) => <li className="text-[#d4d4d8] marker:text-[#71717a]">{children}</li>,
    blockquote: ({ children }: any) => <Blockquote>{children}</Blockquote>,
    hr: () => <hr className="my-5 border-t border-[#27272a]" />,
    table: ({ children, node }: any) => (
      <TableBlock node={node} source={normalized} baseFontSize={baseFontSize}>{children}</TableBlock>
    ),
    thead: ({ children }: any) => (
      <thead style={{ backgroundColor: "var(--surface-3)", color: "var(--surface-text-strong)" }}>{children}</thead>
    ),
    th: ({ children }: any) => (
      <th className="border-b px-4 py-3 text-left font-semibold" style={{ borderColor: "var(--surface-border)" }}>{children}</th>
    ),
    td: ({ children }: any) => (
      <td className="border-b px-4 py-3 align-top" style={{ borderColor: "var(--surface-border-soft)", color: "var(--surface-text)" }}>{children}</td>
    ),
    strong: ({ children }: any) => (
      <strong className={compact ? "font-medium text-[var(--surface-text-strong)]" : "font-semibold text-white"}>
        {children}
      </strong>
    ),
    em: ({ children }: any) => <em className="theme-plan-text italic">{children}</em>,
    sup: ({ children }: any) => <sup className="rounded-full bg-[var(--accent-subtle)] px-1 text-[0.75em] theme-text">{children}</sup>,
    section: ({ children, className }: any) => (
      <section className={`${className || ""} mt-4 rounded-xl border border-[#27272a] bg-[#050507] px-4 py-3 text-[#d4d4d8]`}>
        {children}
      </section>
    ),
    input: ({ checked, type }: any) => {
      if (type !== "checkbox") return null;
      return (
        <span className={`mr-2 inline-flex h-4 w-4 items-center justify-center rounded border text-[11px] ${checked ? "border-[#34d399] bg-[#34d399] text-[#04130c]" : "border-[#3f3f46] bg-transparent text-transparent"}`}>
          ✓
        </span>
      );
    },
  }), [baseFontSize, compact, normalized, sourceId]);

  if (!normalized) return null;

  return (
    <div
      data-markdown-presentation={presentation}
      className="markdown-body break-words text-[#e4e4e7] [overflow-wrap:anywhere]"
      style={{
        fontSize: `${baseFontSize}px`,
        lineHeight: `${Math.max(22, Math.round(baseFontSize * 1.7))}px`,
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
