import { useState } from "react";
import { useAppStore, useTheme } from "../store/useAppStore";
import { IconChevronDown, IconChevronRight } from "./Icons";
import MarkdownRenderer from "./MarkdownRenderer";

interface ThoughtBlockProps {
  content?: string;
  isStreaming?: boolean;
  duration?: number;
}

function formatThoughtDuration(duration: unknown, language: "zh" | "en"): string {
  const ms = Number(duration);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = ms > 600 ? ms / 1000 : ms;
  const formatted = seconds >= 10 ? Math.round(seconds).toString() : seconds.toFixed(1).replace(/\.0$/, "");
  return language === "zh" ? `用时 ${formatted}s` : `${formatted}s`;
}

export default function ThoughtBlock({
  content = "",
  isStreaming = false,
  duration,
}: ThoughtBlockProps) {
  const theme = useTheme();
  const language = useAppStore((s) => s.config.language);
  const themeMode = useAppStore((s) => s.config.themeMode);
  const chatFontSize = useAppStore((s) => s.config.chatFontSize || 13);
  const isLightTheme = themeMode === "light";
  const isBlackTheme = themeMode === "black";

  const [isRawOpen, setIsRawOpen] = useState(false);
  const [renderLimit, setRenderLimit] = useState(20000);

  const rawContent = String(content || "").trim();
  const durationLabel = formatThoughtDuration(duration, language);

  const label = language === "zh" 
    ? isStreaming ? "思考中..." : "思考完毕" 
    : isStreaming ? "Thinking..." : "Thinking completed";

  const hasMore = rawContent.length > renderLimit;
  const displayContent = hasMore
    ? rawContent.slice(0, renderLimit) + "\n\n...(truncated for performance)..."
    : rawContent;

  const charCountStr = rawContent.length.toLocaleString();

  return (
    <div className="w-full ml-9 mt-1 mb-2 max-w-[calc(100%-2.25rem)]">
      <div
        className="inline-flex flex-col rounded-xl border p-3 font-mono text-[11px] shadow-sm w-full"
        style={{
          backgroundColor: isLightTheme ? "#ffffff" : isBlackTheme ? "#030304" : "#07070a",
          borderColor: isStreaming ? theme.subtleBorder : isLightTheme ? "#d4d4d8" : isBlackTheme ? "#202026" : "#27272a",
        }}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{
              backgroundColor: theme.accent,
              boxShadow: isStreaming ? `0 0 8px ${theme.light}` : undefined,
              animation: isStreaming ? "pulse 1.5s ease-in-out infinite" : undefined,
            }}
          />
          <span 
            className="italic font-semibold"
            style={{
              color: isStreaming ? theme.light : isLightTheme ? "#52525b" : isBlackTheme ? "#a5a5ae" : "#a1a1aa",
            }}
          >
            {label}
          </span>
          {durationLabel && (
            <span className="rounded-full border border-[rgba(96,165,250,0.22)] bg-[rgba(37,99,235,0.08)] px-2 py-0.5 text-[#bfdbfe] text-[10px]">
              {durationLabel}
            </span>
          )}
        </div>

        {rawContent && (
          <div className="mt-2 pt-2 border-t border-[#27272a]/60">
            <button
              type="button"
              onClick={() => setIsRawOpen(prev => !prev)}
              className="flex items-center gap-1 text-[10px] text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
            >
              {isRawOpen ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
              <span>
                {language === "zh"
                  ? `${isRawOpen ? "收起" : "查看"}原始推理 (${charCountStr} 字符)`
                  : `${isRawOpen ? "Hide" : "Show"} Raw Reasoning (${charCountStr} chars)`}
              </span>
            </button>

            {isRawOpen && (
              <div 
                className="mt-2 max-h-[300px] overflow-y-auto rounded-lg border border-[#202023] bg-[#030304] p-2.5 text-[#d4d4d8] scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent"
                style={{ contentVisibility: "auto" }}
              >
                <MarkdownRenderer
                  content={displayContent}
                  baseFontSize={chatFontSize - 1}
                  sourceId="thought-standalone-raw"
                />
                {hasMore && (
                  <div className="mt-3 border-t border-[#27272a]/40 pt-2 flex justify-between items-center">
                    <span className="text-[10px] text-[#71717a]">
                      {language === "zh" 
                        ? `已加载 ${renderLimit} / ${rawContent.length} 字符` 
                        : `Loaded ${renderLimit} / ${rawContent.length} chars`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRenderLimit(prev => prev + 50000)}
                      className="text-[10.5px] text-[#38bdf8] hover:text-[#7dd3fc] font-medium transition-colors"
                    >
                      {language === "zh" ? "加载更多..." : "Load more..."}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
