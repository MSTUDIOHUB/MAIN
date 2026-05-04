import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { IconClose, IconExpand } from "./Icons";
import MermaidBlock from "./MermaidBlock";
import { useAppStore } from "../store/useAppStore";

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
};

const DIAGRAM_LANGS = new Set(["mermaid", "plantuml", "puml", "uml", "dot", "graphviz"]);
const CODE_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";

function resolveLanguage(lang?: string): string {
  if (!lang) return "text";
  const lower = lang.toLowerCase();
  return LANG_MAP[lower] || lower;
}

function normalizeMarkdownForDisplay(content: string): string {
  return content
    .replace(/\n```(?:text|plaintext|markdown)?\n([^\n`]{1,80})\n```\n/g, (_match, shortText: string) => ` \`${shortText.trim()}\` `)
    .replace(/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gim, (_, level: string) => `> **${level}**`)
    .replace(/\n{4,}/g, "\n\n\n");
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
    case "markdown":
      return {
        badgeBorder: "rgba(161,161,170,0.28)",
        badgeBackground: "rgba(161,161,170,0.1)",
        badgeText: "#d4d4d8",
        headerBackground: "linear-gradient(90deg, rgba(113,113,122,0.16), rgba(82,82,91,0.06))",
      };
    default:
      return {
        badgeBorder: "rgba(161,161,170,0.28)",
        badgeBackground: "rgba(161,161,170,0.1)",
        badgeText: "#d4d4d8",
        headerBackground: "linear-gradient(90deg, rgba(124,58,237,0.12), rgba(37,99,235,0.04))",
      };
  }
}

function CodeBlock({ inline, className, children, baseFontSize = 13, ...rest }: any) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const themeMode = useAppStore((s) => s.config.themeMode);
  const uiLanguage = useAppStore((s) => s.config.language) === "en" ? "en" : "zh";
  const copy = uiLanguage === "zh"
    ? { diagram: "图表", expand: "展开", copied: "已复制", copy: "复制", expandedDiagram: "展开图表视图", copySource: "复制源码", closeExpanded: "关闭展开图表" }
    : { diagram: "Diagram", expand: "Expand", copied: "Copied", copy: "Copy", expandedDiagram: "Expanded Diagram View", copySource: "Copy Source", closeExpanded: "Close expanded diagram" };
  const isLightTheme = themeMode === "light";
  const isBlackTheme = themeMode === "black";
  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1].toLowerCase() : "";
  const codeStr = String(children).replace(/\n$/, "");
  const resolvedLang = resolveLanguage(language);
  const isDiagram = DIAGRAM_LANGS.has(resolvedLang);
  const isMermaid = resolvedLang === "mermaid";
  const isPlainText = !language || resolvedLang === "text" || resolvedLang === "plaintext";
  const plainTextDisplay = codeStr.trim().replace(/\s+/g, " ");
  const isCompactPlainText = isPlainText && !codeStr.includes("\n") && plainTextDisplay.length <= 80;
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
    if (!isExpanded) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsExpanded(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isExpanded]);

  if (inline) {
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
      <div className="my-4 overflow-x-auto rounded-2xl border border-[#1f1f23] bg-[#09090b] px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
        <pre
          className="m-0 whitespace-pre font-mono text-[#d4d4d8]"
          style={{
            fontFamily: CODE_FONT_FAMILY,
            fontSize: `${baseFontSize}px`,
            lineHeight: `${Math.max(22, Math.round(baseFontSize * 1.7))}px`,
          }}
        >
          {codeStr}
        </pre>
      </div>
    );
  }

  return (
    <>
      <div className="my-4 overflow-hidden rounded-2xl border border-[#1f1f23] bg-[#09090b] shadow-[0_12px_40px_rgba(0,0,0,0.22)]">
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
          <div className="flex items-center gap-2">
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
            style={vscDarkPlus}
            language={resolvedLang}
            PreTag="div"
            customStyle={{
              margin: 0,
              padding: "1rem",
              background: "var(--surface-2, #232327)",
              fontFamily: CODE_FONT_FAMILY,
              fontSize: `${baseFontSize}px`,
              lineHeight: 1.7,
            }}
            codeTagProps={{
              style: {
                fontFamily: CODE_FONT_FAMILY,
                fontSize: "inherit",
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
    </>
  );
}

function PreBlock({ children }: any) {
  return <>{children}</>;
}

function Heading({ level, children, baseFontSize = 13 }: { level: number; children: React.ReactNode; baseFontSize?: number }) {
  const sizes: Record<number, number> = {
    1: baseFontSize * 1.85,
    2: baseFontSize * 1.45,
    3: baseFontSize * 1.25,
    4: baseFontSize * 1.12,
    5: baseFontSize * 1.02,
    6: baseFontSize * 0.94,
  };

  return (
    <div
      className="mt-6 mb-3 first:mt-0 font-semibold text-[#f5f5f5]"
      style={{ fontSize: `${Math.round((sizes[level] || sizes[3]) * 10) / 10}px` }}
    >
      {children}
    </div>
  );
}

export default function MarkdownRenderer({ content, baseFontSize = 13 }: { content: string; baseFontSize?: number }) {
  const normalized = useMemo(() => normalizeMarkdownForDisplay(content), [content]);

  const components = useMemo(() => ({
    code: (props: any) => <CodeBlock {...props} baseFontSize={baseFontSize} />,
    pre: PreBlock,
    h1: ({ children }: any) => <Heading level={1} baseFontSize={baseFontSize}>{children}</Heading>,
    h2: ({ children }: any) => <Heading level={2} baseFontSize={baseFontSize}>{children}</Heading>,
    h3: ({ children }: any) => <Heading level={3} baseFontSize={baseFontSize}>{children}</Heading>,
    h4: ({ children }: any) => <Heading level={4} baseFontSize={baseFontSize}>{children}</Heading>,
    h5: ({ children }: any) => <Heading level={5} baseFontSize={baseFontSize}>{children}</Heading>,
    h6: ({ children }: any) => <Heading level={6} baseFontSize={baseFontSize}>{children}</Heading>,
    p: ({ children }: any) => <p className="mb-3 last:mb-0 text-[#d4d4d8]">{children}</p>,
    a: ({ href, children }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="theme-text underline decoration-[rgba(167,139,250,0.45)] underline-offset-4 transition-opacity hover:opacity-80">
        {children}
      </a>
    ),
    ul: ({ children }: any) => <ul className="mb-3 ml-5 list-disc space-y-1.5">{children}</ul>,
    ol: ({ children }: any) => <ol className="mb-3 ml-5 list-decimal space-y-1.5">{children}</ol>,
    li: ({ children }: any) => <li className="text-[#d4d4d8]">{children}</li>,
    blockquote: ({ children }: any) => (
      <blockquote className="my-4 rounded-r-2xl border-l-2 border-[rgba(124,58,237,0.45)] bg-[rgba(124,58,237,0.08)] px-4 py-3 text-[#ddd6fe]">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-5 border-t border-[#27272a]" />,
    table: ({ children }: any) => (
      <div className="my-4 overflow-x-auto rounded-2xl border border-[#1f1f23] bg-[#09090b]">
        <table className="min-w-full" style={{ fontSize: `${Math.max(12, baseFontSize - 1)}px` }}>{children}</table>
      </div>
    ),
    thead: ({ children }: any) => <thead className="bg-[#121216] text-[#f5f5f5]">{children}</thead>,
    th: ({ children }: any) => <th className="border-b border-[#1f1f23] px-4 py-3 text-left font-semibold">{children}</th>,
    td: ({ children }: any) => <td className="border-b border-[#1f1f23] px-4 py-3 align-top text-[#d4d4d8]">{children}</td>,
    strong: ({ children }: any) => <strong className="font-semibold text-white">{children}</strong>,
    em: ({ children }: any) => <em className="italic text-[#ddd6fe]">{children}</em>,
    input: ({ checked, type }: any) => {
      if (type !== "checkbox") return null;
      return (
        <span className={`mr-2 inline-flex h-4 w-4 items-center justify-center rounded border text-[11px] ${checked ? "border-[#34d399] bg-[#34d399] text-[#04130c]" : "border-[#3f3f46] bg-transparent text-transparent"}`}>
          ✓
        </span>
      );
    },
  }), [baseFontSize]);

  if (!normalized) return null;

  return (
    <div
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
}
