// @ts-nocheck
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconAt, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconCloud, IconCode, IconColumns, IconFile, IconFileText, IconFolder, IconImageIcon, IconLogoM, IconStop, IconTerminal } from "./Icons";
import ActionCard from "./ActionCard";
import Composer from "./Composer";
import JobListCard from "./JobListCard";
import MarkdownRenderer from "./MarkdownRenderer";
import StreamingCursor from "./StreamingCursor";
import TopIsland from "./TopIsland";
import { resolveAutoScrollState } from "../lib/chatScroll";
import { getDiffStats } from "../lib/diff";
import { parseMessageContent } from "../lib/messageParser";
import { hasPlanDraftPreview, hasStructuredPlanProposal } from "../lib/planProposal";
import { sanitizeAIOutput, sanitizeAssistantDisplayContent, sanitizeVisibleAssistantText } from "../lib/sanitize";
import {
  deriveThoughtDisplay,
  normalizeThoughtSummaryForCompare,
} from "../lib/thoughtDisplay";
import { deriveTurnProgressItems } from "../lib/turnProgress";
import { useAppStore } from "../store/useAppStore";
import {
  collectChangeEntries,
  buildPlanTaskEvidenceAudit,
  deriveVisibleConversationTurnStatus,
  isGenericConversationTitle,
  isEphemeralPlanArtifactPath,
  normalizeConversationDisplayTitle,
  isPlanConversationTurn,
  looksLikeReasoningLeakTitle,
  resolveActiveConversationTurn,
  resolvePinnedConversationTurn,
  shouldPlanShortcutReplaceTurn,
  summarizePlanIntent,
  type ConversationTurn,
  type ReplyOption,
} from "../lib/workflowModels";
import { getIntentPolicy, resolveConversationTurnIntent } from "../lib/runIntent";
import { summarizePlanExecutionProgressSnapshot } from "../lib/planExecutionRecovery";
import {
  buildChatRenderSegments,
  countCompletedToolCalls,
  type ChatOperationCluster,
} from "../lib/toolUiGrouping";
import { isThinModelToolNarration } from "../lib/modelFeedbackDedupe";
import { compactToolPresentationTarget, getToolPresentationLabel } from "../lib/toolPresentation";
import { buildLiveTurnProcessTimelineModel, buildTurnProcessArchiveModel, type TurnArchiveStep } from "../lib/turnProcessArchive";
import {
  buildRuntimeProgressLedger,
  buildRuntimeProgressProjection,
  summarizeRuntimeProgressLedger,
  type RuntimeProgressLedgerItem,
} from "../lib/runtimeProgressLedger";
import { getChatFeedbackStatusCopy, normalizeChatFeedbackStatus } from "../lib/chatFeedback";
import { appendDebugLog } from "../lib/debugLog";
import type { UserContextItem } from "../lib/userContextItems";

const TURN_STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  awaiting_approval: "Awaiting Approval",
  awaiting_input: "Awaiting Choice",
  executing: "Executing",
  completed_with_changes: "Changed",
  stopped_no_action: "Stopped",
  stopped_no_output: "No visible reply",
  paused: "Paused",
  done: "Done",
  error: "Error",
};

const AGENT_CONTENT_PREVIEW_CHARS = 60_000;
const STREAMING_AGENT_CONTENT_PREVIEW_CHARS = 16_000;

function resolveTurnProcessFontSize(chatFontSize: number): number {
  const size = Number(chatFontSize) || 13;
  return Math.min(18, Math.max(8, size - 2));
}

const TURN_PROCESS_FONT_REFERENCE_SIZE = 13;
const TURN_PROCESS_FONT_STEPS = [9, 10, 10.5, 11, 12, 12.5, 13] as const;

function getTurnProcessFontStyle(fontSize: number): React.CSSProperties {
  const style = {
    fontSize: `${fontSize}px`,
    "--turn-process-font-size": `${fontSize}px`,
  } as React.CSSProperties;

  TURN_PROCESS_FONT_STEPS.forEach((step) => {
    style[`--turn-process-font-${String(step).replace(".", "-")}px`] =
      `${((fontSize * step) / TURN_PROCESS_FONT_REFERENCE_SIZE).toFixed(2)}px`;
  });

  return style;
}

function UserContextPillRow({
  items,
  language,
  onPreviewImage,
}: {
  items?: UserContextItem[];
  language: "zh" | "en";
  onPreviewImage: (item: UserContextItem) => void;
}) {
  const visibleItems = Array.isArray(items) ? items.filter((item) => item?.label) : [];
  if (visibleItems.length === 0) return null;

  return (
    <div data-testid="user-context-pill-row" className="mt-2 flex flex-wrap justify-end gap-1.5">
      {visibleItems.map((item, index) => {
        const isImage = item.kind === "image";
        const isMention = item.kind === "mention";
        const canPreview = isImage && !!item.previewDataUrl;
        const label = item.label || (language === "en" ? `Image ${index + 1}` : `截图 ${index + 1}`);
        const displayLabel = isMention ? String(label).replace(/^@\s*/, "") : label;
        const statusTitle = item.status === "failed"
          ? language === "en" ? "Read failed" : "读取失败"
          : item.path || label;
        const content = (
          <>
            {isImage && item.previewDataUrl ? (
              <img
                src={item.previewDataUrl}
                alt=""
                className="h-5 w-5 rounded-[5px] border border-[#3f3f46] object-cover"
              />
            ) : isImage ? (
              <IconImageIcon className="h-3.5 w-3.5" />
            ) : isMention ? (
              <IconAt className="h-3.5 w-3.5" />
            ) : (
              <IconFile className="h-3.5 w-3.5" />
            )}
            <span className="max-w-[180px] truncate">{displayLabel}</span>
            {item.status === "failed" && (
              <span className="text-[#fbbf24]">{language === "en" ? "failed" : "失败"}</span>
            )}
          </>
        );
        const className = [
          "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-mono transition-colors",
          item.status === "failed"
            ? "border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.10)] text-[#fbbf24]"
            : "border-[#27272a] bg-[#09090b] text-[#d4d4d8]",
          canPreview ? "cursor-pointer hover:border-[#3f3f46] hover:bg-[#18181b] hover:text-white" : "cursor-default",
        ].join(" ");

        return canPreview ? (
          <button
            key={item.id || `${item.kind}-${index}`}
            type="button"
            data-testid="user-context-pill"
            className={className}
            title={statusTitle}
            onClick={() => onPreviewImage(item)}
          >
            {content}
          </button>
        ) : (
          <span
            key={item.id || `${item.kind}-${index}`}
            data-testid="user-context-pill"
            className={className}
            title={statusTitle}
          >
            {content}
          </span>
        );
      })}
    </div>
  );
}

function UserImagePreviewModal({
  item,
  onClose,
}: {
  item: UserContextItem | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!item?.previewDataUrl) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [item?.previewDataUrl, onClose]);

  if (!item?.previewDataUrl || typeof document === "undefined") return null;
  return createPortal(
    <div
      data-testid="user-image-preview-modal"
      className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(0,0,0,0.78)] p-6"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[92vw] overflow-hidden rounded-2xl border border-[#34343b] bg-[#09090b] p-3 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="absolute right-4 top-4 rounded-full border border-[#34343b] bg-[#18181b] p-2 text-[#c4c4cc] transition-colors hover:bg-[#232327] hover:text-white"
          onClick={onClose}
          title="Close"
        >
          <IconClose className="h-4 w-4" />
        </button>
        <img
          data-testid="user-image-preview"
          src={item.previewDataUrl}
          alt={item.label || "preview"}
          className="max-h-[84vh] max-w-[88vw] rounded-xl object-contain"
        />
      </div>
    </div>,
    document.body,
  );
}

function getDisplayAgentContent(content: string, showFull: boolean, previewChars = AGENT_CONTENT_PREVIEW_CHARS) {
  const raw = String(content || "");
  if (showFull || raw.length <= previewChars) {
    return { content: raw, truncated: false, hiddenChars: 0 };
  }

  return {
    content: raw.slice(0, previewChars),
    truncated: true,
    hiddenChars: raw.length - previewChars,
  };
}

function getAgentPreviewContent(content: string) {
  return getDisplayAgentContent(sanitizeAssistantDisplayContent(content), false).content;
}

function getAgentInspectableContent(content: string) {
  const raw = String(content || "");
  if (raw.length <= AGENT_CONTENT_PREVIEW_CHARS) return raw;
  return `${raw.slice(0, AGENT_CONTENT_PREVIEW_CHARS)}\n\n${raw.slice(-20_000)}`;
}

function getTurnStatusTone(status: string): string {
  switch (status) {
    case "planning":
      return "theme-plan-pill";
    case "awaiting_approval":
    case "awaiting_input":
      return "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]";
    case "executing":
      return "border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] text-[#60a5fa]";
    case "completed_with_changes":
      return "border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.12)] text-[#34d399]";
    case "stopped_no_action":
    case "stopped_no_output":
      return "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]";
    case "paused":
      return "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]";
    case "done":
      return "border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.12)] text-[#34d399]";
    case "error":
      return "border-[rgba(251,113,133,0.25)] bg-[rgba(251,113,133,0.12)] text-[#fb7185]";
    default:
      return "border-[#27272a] bg-[#09090b] text-[#a1a1aa]";
  }
}

function TurnSummaryCard({
  turn,
  hiddenCount,
  fallbackSummary,
  onOpenPlan,
  onExpand,
  embedded = false,
  copy,
}: {
  turn: ConversationTurn;
  hiddenCount: number;
  fallbackSummary?: string;
  onOpenPlan?: () => void;
  onExpand?: () => void;
  embedded?: boolean;
  copy: {
    summary: string;
    collapsedSummary: string;
    expandHistory: (count: number) => string;
    openPlan: string;
  };
}) {
  const cleanTurnSummary = sanitizeAIOutput(turn.summary || "");
  const summaryText = (looksLikeReasoningLeakTitle(cleanTurnSummary) ? "" : cleanTurnSummary) || sanitizeAIOutput(fallbackSummary || "") || copy.collapsedSummary;
  const shellClass = embedded
    ? "px-1 py-1"
    : "rounded-2xl border border-[#1f1f23] bg-[#09090b] px-4 py-3";

  return (
    <div data-testid="turn-summary-card" className={shellClass}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[#71717a]">{copy.summary}</div>
          <div className="mt-1 text-[13px] leading-relaxed text-[#e4e4e7]">{summaryText}</div>
          {hiddenCount > 0 && (
            <button
              onClick={onExpand}
              className="mt-3 inline-flex items-center rounded-full border border-[#27272a] bg-[#050507] px-3 py-1 text-[11px] text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#f4f4f5]"
            >
              {copy.expandHistory(hiddenCount)}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isPlanConversationTurn(turn) && onOpenPlan && (
            <button
              onClick={onOpenPlan}
              className="theme-plan-button rounded-full border px-3 py-1.5 text-[11px] transition-colors"
            >
              {copy.openPlan}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTokenCount(value: number | undefined) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString();
}

function ContextCompressionNotice({ block, language }: { block: any; language: "zh" | "en" }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const themeMode = useAppStore((s) => s.config.themeMode);
  const isLightTheme = themeMode === "light";
  const isBlackTheme = themeMode === "black";
  const stats = block.contextCompression || {};
  const isReactive = stats.reason === "reactive";
  const isExecuteRecovery = stats.reason === "execute_recovery";
  const droppedMessageCount = Number(stats.droppedMessageCount ?? stats.droppedCount ?? 0);
  const microCompactedCount = Number(stats.microCompactedCount || 0);
  const microKind = String(stats.microCompactionKind || "none");
  const isMicroOnly = !isReactive && droppedMessageCount === 0 && microCompactedCount > 0;
  const topSourceLabel = String(stats.topTokenSource?.label || "").trim();
  const topSourceTokens = Number(stats.topTokenSource?.tokens || 0);
  const title = language === "zh"
    ? isExecuteRecovery ? "执行恢复上下文已收束" : isReactive ? "上下文溢出保护" : isMicroOnly ? "上下文已整理" : "历史上下文已压缩"
    : isExecuteRecovery ? "Execution recovery context compacted" : isReactive ? "Context overflow guard" : isMicroOnly ? "Context organized" : "History context compressed";
  const compactLabel = language === "zh" ? "查看" : "View";
  const toolResultExplanation = language === "zh"
    ? "这不是工具失败。MAIN 在请求模型前整理历史工具结果；原始工具卡片仍保留在对话里，模型侧只接收必要摘要和最新结果。"
    : "This is not a tool failure. MAIN organized historical tool results before the model request; original tool cards remain in the conversation while the model receives the necessary summary and newest results.";
  const defaultBodyText = language === "zh"
    ? microKind === "tool_results"
      ? toolResultExplanation
      : "当前只保存了压缩统计，暂无可展示的压缩摘要。"
    : microKind === "tool_results"
      ? toolResultExplanation
      : "Only compression stats are available for this event.";
  const rawBodyText = String(stats.displaySummary || stats.compressedContext || "").trim();
  const bodyText = rawBodyText
    ? microKind === "tool_results"
      ? `${toolResultExplanation}\n\n${rawBodyText}`
      : rawBodyText
    : defaultBodyText;
  const debugPacket = String(stats.memoryPacket || "").trim();
  const showDebugPacket = !!debugPacket && debugPacket !== bodyText;
  const tone = isLightTheme
    ? {
        pillBorder: "#cbd5e1",
        pillBackground: "#f8fafc",
        titleText: "#1e293b",
        mutedText: "#64748b",
        actionText: "#1d4ed8",
        overlay: "rgba(15,23,42,0.24)",
        modalBorder: "#cbd5e1",
        modalBackground: "#ffffff",
        headerBorder: "#e2e8f0",
        headerBackground: "linear-gradient(90deg, rgba(219,234,254,0.9), rgba(240,249,255,0.72))",
        closeBorder: "#cbd5e1",
        closeBackground: "#f8fafc",
        closeText: "#475569",
        bodyBackground: "#f8fafc",
        preBorder: "#cbd5e1",
        preBackground: "#ffffff",
        preText: "#334155",
      }
    : isBlackTheme
      ? {
        pillBorder: "#202026",
        pillBackground: "#070708",
        titleText: "#dedee3",
        mutedText: "#74747e",
        actionText: "#93c5fd",
        overlay: "rgba(0,0,0,0.78)",
        modalBorder: "#202026",
        modalBackground: "#030304",
        headerBorder: "#141418",
        headerBackground: "linear-gradient(90deg, rgba(37,99,235,0.12), rgba(14,165,233,0.05))",
        closeBorder: "#202026",
        closeBackground: "#070708",
        closeText: "#c4c4cc",
        bodyBackground: "#000000",
        preBorder: "#17171c",
        preBackground: "#030304",
        preText: "#dedee3",
      }
    : {
        pillBorder: "#34343b",
        pillBackground: "#232327",
        titleText: "#d4d4d8",
        mutedText: "#71717a",
        actionText: "#93c5fd",
        overlay: "rgba(0,0,0,0.68)",
        modalBorder: "#34343b",
        modalBackground: "#1d1d20",
        headerBorder: "#2c2c32",
        headerBackground: "linear-gradient(90deg, rgba(37,99,235,0.16), rgba(14,165,233,0.08))",
        closeBorder: "#34343b",
        closeBackground: "#181818",
        closeText: "#c4c4cc",
        bodyBackground: "#181818",
        preBorder: "#2c2c32",
        preBackground: "#111113",
        preText: "#d4d4d8",
      };

  useEffect(() => {
    if (!isExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsExpanded(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isExpanded]);

  return (
    <div key={block.id} className="flex w-full justify-center">
      <button
        onClick={() => setIsExpanded(true)}
        className="inline-flex max-w-[min(720px,90%)] items-center gap-2 rounded-full border border-[#34343b] bg-[#232327] px-4 py-1.5 text-[11px] text-[#a1a1aa] transition-colors hover:border-[#4b5563] hover:text-[#f4f4f5]"
        style={{
          borderColor: tone.pillBorder,
          backgroundColor: tone.pillBackground,
          color: tone.mutedText,
        }}
      >
        <span className="font-medium text-[#d4d4d8]" style={{ color: tone.titleText }}>{title}</span>
        <span className="text-[#71717a]" style={{ color: tone.mutedText }}>{formatTokenCount(stats.tokenCountBefore)} → {formatTokenCount(stats.tokenCountAfter)} tokens</span>
        {topSourceLabel && topSourceTokens > 0 && (
          <span className="hidden max-w-[220px] truncate text-[#71717a] sm:inline" style={{ color: tone.mutedText }}>
            {language === "zh"
              ? `最大来源：${topSourceLabel} ${formatTokenCount(topSourceTokens)}`
              : `Top source: ${topSourceLabel} ${formatTokenCount(topSourceTokens)}`}
          </span>
        )}
        <span className="text-[#93c5fd]" style={{ color: tone.actionText }}>{compactLabel}</span>
      </button>

      {isExpanded && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-[rgba(0,0,0,0.68)] p-6" style={{ backgroundColor: tone.overlay }} onClick={() => setIsExpanded(false)}>
          <div
            className="flex h-[min(86vh,960px)] w-[min(96vw,1320px)] flex-col overflow-hidden rounded-[28px] border border-[#34343b] bg-[#1d1d20]"
            style={{
              borderColor: tone.modalBorder,
              backgroundColor: tone.modalBackground,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#2c2c32] px-5 py-3" style={{ borderColor: tone.headerBorder, background: tone.headerBackground }}>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[#e4e4e7]" style={{ color: tone.titleText }}>{title}</div>
                <div className="mt-1 text-[11px] text-[#a1a1aa]" style={{ color: tone.mutedText }}>
                  {language === "zh"
                    ? `约 ${formatTokenCount(stats.tokenCountBefore)} → ${formatTokenCount(stats.tokenCountAfter)} tokens，释放 ${formatTokenCount(stats.tokenReduction)}，折叠 ${formatTokenCount(stats.droppedCount)} 条历史消息`
                    : `About ${formatTokenCount(stats.tokenCountBefore)} → ${formatTokenCount(stats.tokenCountAfter)} tokens, saved ${formatTokenCount(stats.tokenReduction)}, folded ${formatTokenCount(stats.droppedCount)} history message(s)`}
                  {topSourceLabel && topSourceTokens > 0
                    ? language === "zh"
                      ? `；最大来源：${topSourceLabel} ${formatTokenCount(topSourceTokens)} tokens`
                      : `; top source: ${topSourceLabel} ${formatTokenCount(topSourceTokens)} tokens`
                    : ""}
                </div>
              </div>
              <button
                onClick={() => setIsExpanded(false)}
                className="rounded-full border border-[#34343b] bg-[#181818] p-2 text-[#c4c4cc] transition-colors hover:bg-[#232327] hover:text-[#fafafa]"
                style={{
                  borderColor: tone.closeBorder,
                  backgroundColor: tone.closeBackground,
                  color: tone.closeText,
                }}
                aria-label={language === "zh" ? "关闭压缩背景" : "Close compressed context"}
              >
                <IconClose className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-[#181818] p-5" style={{ backgroundColor: tone.bodyBackground }}>
              <pre
                className="m-0 whitespace-pre-wrap break-words rounded-2xl border border-[#2c2c32] bg-[#111113] p-4 font-mono text-[12px] leading-6 text-[#d4d4d8]"
                style={{
                  borderColor: tone.preBorder,
                  backgroundColor: tone.preBackground,
                  color: tone.preText,
                }}
              >
                {bodyText}
              </pre>
              {showDebugPacket && (
                <details className="mt-4 rounded-2xl border border-[#2c2c32] bg-[#111113] p-3" style={{ borderColor: tone.preBorder, backgroundColor: tone.preBackground }}>
                  <summary className="cursor-pointer select-none text-[11px] font-medium text-[#a1a1aa]">
                    {language === "zh" ? "调试信息（Context Memory Packet）" : "Debug Info (Context Memory Packet)"}
                  </summary>
                  <pre
                    className="mt-3 m-0 whitespace-pre-wrap break-words rounded-xl border border-[#2c2c32] bg-[#0b0b0d] p-3 font-mono text-[11px] leading-6 text-[#a1a1aa]"
                    style={{
                      borderColor: tone.preBorder,
                      backgroundColor: tone.preBackground,
                      color: tone.mutedText,
                    }}
                  >
                    {debugPacket}
                  </pre>
                </details>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function PlanExecutionSystemNotice({ block, language }: { block: any; language: "zh" | "en" }) {
  const isCheckpoint = block.variant === "plan_execution_checkpoint";
  const progressPhase = String(block.planExecutionProgress?.phase || "");
  const isPaused = progressPhase === "paused" || /已暂停|paused/i.test(String(block.content || ""));
  const title = isCheckpoint
    ? language === "zh" ? "计划执行检查点" : "Plan Execution Checkpoint"
    : isPaused
    ? language === "zh" ? "计划执行已暂停" : "Plan Execution Paused"
    : language === "zh" ? "计划执行进度" : "Plan Execution Progress";
  const tone = isCheckpoint
    ? "theme-plan-surface theme-plan-text"
    : "theme-plan-surface theme-plan-text";

  return (
    <div className="flex w-full justify-center">
      <div data-testid={block.variant} className={`max-w-[min(760px,92%)] rounded-lg border px-3 py-2 text-left ${tone}`}>
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#a1a1aa]">{title}</div>
        <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-[#e4e4e7]">{String(block.content || "")}</div>
      </div>
    </div>
  );
}

function ProgressBlock({
  block,
  language,
}: {
  block: any;
  language: "zh" | "en";
}) {
  const phase = String(block.phase || "investigating");
  const status = String(block.status || "running");
  const title = String(block.title || (language === "zh" ? "正在推进" : "Working"));
  const why = String(block.why || "");
  const action = String(block.action || "");
  const evidence = String(block.evidence || "");
  const evidenceExcerpt = String(block.evidenceExcerpt || "");
  const observedFact = String(block.observedFact || "");
  const hypothesisStatus = String(block.hypothesisStatus || "");
  const next = String(block.next || "");
  const targets = Array.isArray(block.targets) ? block.targets.filter(Boolean).slice(0, 3) : [];
  const phaseLabel = language === "zh"
    ? phase === "understanding" ? "理解目标"
      : phase === "editing" ? "修改中"
      : phase === "verifying" ? "验证中"
      : phase === "blocked" ? "受阻"
      : phase === "summarizing" ? "整理中"
      : "调查中"
    : phase === "understanding" ? "Understanding"
      : phase === "editing" ? "Editing"
      : phase === "verifying" ? "Verifying"
      : phase === "blocked" ? "Blocked"
      : phase === "summarizing" ? "Summarizing"
      : "Investigating";
  const statusLabel = language === "zh"
    ? status === "done" ? "完成" : status === "failed" ? "失败" : "进行中"
    : status === "done" ? "Done" : status === "failed" ? "Failed" : "Running";
  const Icon = phase === "editing"
    ? IconCode
    : phase === "verifying"
    ? IconTerminal
    : phase === "blocked"
    ? IconClose
    : phase === "summarizing"
    ? IconColumns
    : IconFileText;
  const statusClass = status === "failed"
    ? "text-[#fb7185] border-[rgba(251,113,133,0.28)] bg-[rgba(251,113,133,0.08)]"
    : status === "done"
    ? "text-[#86efac] border-[rgba(52,211,153,0.22)] bg-[rgba(52,211,153,0.08)]"
    : "text-[#93c5fd] border-[rgba(96,165,250,0.28)] bg-[rgba(96,165,250,0.1)]";

  return (
    <div data-testid="progress-block" data-phase={phase} data-status={status} className="ml-9 w-full max-w-[min(820px,calc(100%-2.25rem))]">
      <div className="rounded-xl border border-[color-mix(in_srgb,var(--accent-light)_28%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,#050505)] px-3.5 py-3 shadow-sm">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[rgba(96,165,250,0.18)] bg-[rgba(96,165,250,0.08)] text-[#93c5fd]">
            {status === "running" ? (
              <span className="h-2.5 w-2.5 rounded-full bg-[#60a5fa] shadow-[0_0_10px_rgba(96,165,250,0.75)] animate-pulse" />
            ) : (
              <Icon className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#93c5fd]">{phaseLabel}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${statusClass}`}>{statusLabel}</span>
              {targets.length > 0 && (
                <span className="min-w-0 truncate text-[10px] text-[var(--surface-text-muted)]">
                  {targets.join(language === "zh" ? "、" : ", ")}
                </span>
              )}
            </div>
            <div className="mt-1 text-[13px] font-semibold leading-5 text-[var(--surface-text)]">{title}</div>
            {why && (
              <div data-testid="progress-why" className="mt-1 text-[12px] leading-5 text-[var(--surface-text-subtle)]">{why}</div>
            )}
            {(action || observedFact || evidenceExcerpt || evidence || next) && (
              <div className="mt-2 grid gap-1.5 text-[11px] leading-5 text-[var(--surface-text-subtle)]">
                {action && <div><span className="text-[#93c5fd]">{language === "zh" ? "动作：" : "Action: "}</span>{action}</div>}
                {observedFact && <div><span className="text-[#a5b4fc]">{language === "zh" ? "观察：" : "Observed: "}</span>{observedFact}</div>}
                {evidenceExcerpt && <div><span className="text-[#c4b5fd]">{language === "zh" ? "证据摘录：" : "Evidence excerpt: "}</span>{evidenceExcerpt}</div>}
                {evidence && <div><span className="text-[#a5b4fc]">{language === "zh" ? "证据：" : "Evidence: "}</span>{evidence}</div>}
                {hypothesisStatus && <div><span className="text-[#fbbf24]">{language === "zh" ? "状态：" : "Status: "}</span>{hypothesisStatus}</div>}
                {next && <div><span className="text-[#86efac]">{language === "zh" ? "下一步：" : "Next: "}</span>{next}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function hasRenderableAgentContent(blocks: any[]) {
  return blocks.some((block) => hasRenderableAgentBlock(block));
}

function hasRenderableAgentBlock(block: any) {
  if (block.type !== "agent") return false;
  if (Array.isArray(block.options) && block.options.length > 0) return true;
  const segments = parseMessageContent(getAgentPreviewContent(block.content));
  return segments.some((seg) => seg.type === "text" && sanitizeAIOutput(seg.content).length > 0);
}

function getLastAgentSummaryText(blocks: any[]) {
  const agentBlock = [...blocks]
    .reverse()
    .find((block) => block.type === "agent" && !block.hiddenProcess && hasRenderableAgentBlock(block));
  if (!agentBlock) return "";
  const summaryText = parseMessageContent(getAgentPreviewContent(agentBlock.content))
    .filter((seg) => seg.type === "text")
    .map((seg) => sanitizeAIOutput(seg.content))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return summaryText.length > 700 ? `${summaryText.slice(0, 700).trim()}...` : summaryText;
}

function getAgentVisibleMarkdownText(block: any): string {
  if (block?.type !== "agent") return "";
  return parseMessageContent(getAgentPreviewContent(block.content))
    .filter((seg) => seg.type === "text")
    .map((seg) => sanitizeAIOutput(seg.content))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeTranscriptDedupeText(text: string): string {
  return normalizeThoughtSummaryForCompare(
    String(text || "")
      .replace(/[`*_#[\]()]/g, " ")
      .replace(/[。！？；，、,.!?;:：]/g, " ")
  ).replace(/\s+/g, "");
}

function collectNearbyToolEchoText(blocks: any[], agentIndex: number): string {
  const parts: string[] = [];
  const collect = (start: number, step: number) => {
    for (let idx = start; idx >= 0 && idx < blocks.length; idx += step) {
      const block = blocks[idx];
      if (!block || block.type === "thought" || block.type === "progress") continue;
      if (block.type === "tool") {
        parts.push(
          String(block.observationSummary || ""),
          String(block.intentSummary || ""),
          String(block.why || ""),
          String(block.message || ""),
          compactToolTarget(block.target, String(block.toolName || ""), "zh"),
          compactToolTarget(block.target, String(block.toolName || ""), "en"),
          fullToolTarget(block.target, String(block.toolName || ""), "zh"),
        );
        continue;
      }
      break;
    }
  };
  collect(agentIndex - 1, -1);
  collect(agentIndex + 1, 1);
  return parts.filter(Boolean).join("\n");
}

function extractPathishTokens(text: string): string[] {
  const source = String(text || "");
  const tokens = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z0-9_.@/-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_.@/-]*\/[A-Za-z0-9_.@/-]+/g)) {
    const raw = String(match[0] || "").trim();
    if (!raw || raw.length < 4) continue;
    tokens.add(raw.toLowerCase());
    const basename = raw.split(/[\\/]/).pop();
    if (basename && basename.length >= 4) tokens.add(basename.toLowerCase());
  }
  return [...tokens];
}

function isThinToolNarration(text: string): boolean {
  return isThinModelToolNarration(text);
}

function shouldSuppressAgentToolEcho(blocks: any[], agentIndex: number): boolean {
  const block = blocks[agentIndex];
  if (!block || block.type !== "agent" || block.streaming || block.hiddenProcess) return false;
  const text = getAgentVisibleMarkdownText(block);
  if (!text || text.length > 700) return false;
  const nearbyToolText = collectNearbyToolEchoText(blocks, agentIndex);
  if (!nearbyToolText) return false;
  const agentNormalized = normalizeTranscriptDedupeText(text);
  const toolNormalized = normalizeTranscriptDedupeText(nearbyToolText);
  if (!agentNormalized || !toolNormalized) return false;
  if (agentNormalized.length >= 24 && toolNormalized.includes(agentNormalized)) return true;
  if (toolNormalized.length >= 24 && agentNormalized.includes(toolNormalized)) return true;
  if (!isThinToolNarration(text)) return false;
  const agentTokens = extractPathishTokens(text);
  if (agentTokens.length === 0) return false;
  const toolTextLower = nearbyToolText.toLowerCase();
  return agentTokens.some((token) => toolTextLower.includes(token));
}

function isTransparentToolNarrationBlock(block: any): boolean {
  if (!block || block.type !== "agent" || block.streaming || block.hiddenProcess) return false;
  const text = getAgentVisibleMarkdownText(block);
  const normalized = String(text || "").replace(/\s+/g, "");
  if (/完成|已读取|已搜索|已执行|readcomplete|searchcomplete|commandcomplete/i.test(normalized)) return false;
  const futureToolNarration =
    /^(?:我(?:会|将|先|现在|正在|继续)|让我|接下来|现在|继续|正在).{0,60}(?:读取|查看|搜索|调查|执行|运行|调用|验证|整理)/.test(normalized);
  return futureToolNarration || isThinToolNarration(text);
}

function hasGeneratedPlanContent(blocks: any[]) {
  return blocks.some((block) => {
    if (block.type === "tool") {
      return /\.main\/plans\//i.test(String(block.target || ""));
    }

    if (block.type !== "agent") return false;
    const raw = getAgentInspectableContent(block.content);
    return hasStructuredPlanProposal(raw) || hasPlanDraftPreview(raw);
  });
}

function PlanShortcutCard({
  turn,
  hasPlanContent,
  canOpenPlan,
  onOpenPlan,
  copy,
}: {
  turn: ConversationTurn;
  hasPlanContent: boolean;
  canOpenPlan: boolean;
  onOpenPlan: () => void;
  copy: {
    planLabel: string;
    describePlan: (prompt: string, maxLength?: number) => string;
    planGenerating: (prompt: string) => string;
    planReady: string;
    openPlan: string;
    generating: string;
    turnStatusLabels: Record<string, string>;
  };
}) {
  const description = hasPlanContent
    ? copy.describePlan(turn.userPrompt)
    : turn.status === "planning"
    ? copy.planGenerating(turn.userPrompt)
    : copy.planReady;

  return (
    <div className="theme-plan-surface ml-9 rounded-2xl border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="theme-plan-pill rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]">
              {copy.planLabel}
            </span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] ${getTurnStatusTone(turn.status)}`}>
              {copy.turnStatusLabels[turn.status] || turn.status}
            </span>
          </div>
          <div className="theme-plan-text mt-2 text-[13px] leading-relaxed">{description}</div>
        </div>
        {canOpenPlan ? (
          <button
            onClick={onOpenPlan}
            className="theme-plan-button shrink-0 rounded-full border px-3 py-1.5 text-[11px] transition-colors"
          >
            {copy.openPlan}
          </button>
        ) : (
          <span className="shrink-0 rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1.5 text-[11px] text-[#a1a1aa]">
            {copy.generating}
          </span>
        )}
      </div>
    </div>
  );
}

function collectTurnChangeEntries(blocks: any[]) {
  return collectChangeEntries(blocks, getDiffStats);
}

const TOOL_SUMMARY_GROUPS = {
  read: new Set(["get_project_skeleton", "get_file_outline", "read_file", "read_document", "list_directory", "glob_search", "grep_search", "repo_map_status", "repo_map_search", "repo_map_context", "repo_map_files", "repo_map_impact", "index_workspace_documents"]),
  table: new Set(["analyze_tabular_document", "query_tabular_document"]),
  edit: new Set(["replace_in_file", "write_file", "apply_patch"]),
  command: new Set(["execute_command", "send_pty_input", "run_command", "browser_evaluate", "read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status", "clear_pty_buffer"]),
};

const READ_CONTEXT_TOOL_NAMES = new Set([
  "get_project_skeleton",
  "get_file_outline",
  "read_file",
  "read_document",
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "index_workspace_documents",
]);

const READ_CONTEXT_TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  get_project_skeleton: { zh: "扫描项目", en: "Scan project" },
  get_file_outline: { zh: "读取结构", en: "Read outline" },
  read_file: { zh: "读取文件", en: "Read file" },
  read_document: { zh: "读取文档", en: "Read document" },
  list_directory: { zh: "扫描目录", en: "Scan directory" },
  glob_search: { zh: "搜索文件", en: "Search files" },
  grep_search: { zh: "搜索内容", en: "Search content" },
  repo_map_status: { zh: "检查代码图谱", en: "Check repo map" },
  repo_map_search: { zh: "搜索代码图谱", en: "Search repo map" },
  repo_map_context: { zh: "读取代码图谱", en: "Read repo map" },
  repo_map_files: { zh: "查看代码图谱文件", en: "Inspect repo-map files" },
  repo_map_impact: { zh: "分析影响范围", en: "Analyze impact" },
  index_workspace_documents: { zh: "索引文档", en: "Index documents" },
};

const COMPLETED_TOOL_GROUP_LABELS: Record<string, { zh: string; en: string }> = {
  find_gameobjects: { zh: "查找对象", en: "Find objects" },
  find_in_file: { zh: "文件搜索", en: "Search file" },
  execute_code: { zh: "执行代码", en: "Execute code" },
  script_apply_edits: { zh: "脚本编辑", en: "Script edits" },
  manage_camera: { zh: "相机管理", en: "Manage camera" },
  manage_gameobject: { zh: "对象管理", en: "Manage object" },
  manage_components: { zh: "组件管理", en: "Manage components" },
  manage_scene: { zh: "场景管理", en: "Manage scene" },
  refresh_unity: { zh: "刷新 Unity", en: "Refresh Unity" },
};

function isCommandLikeToolName(toolName: string) {
  return TOOL_SUMMARY_GROUPS.command.has(toolName);
}

function isCompletedReadContextTool(block: any) {
  return (
    block?.type === "tool" &&
    block.toolStatus === "executed" &&
    !block.diff &&
    READ_CONTEXT_TOOL_NAMES.has(String(block.toolName || ""))
  );
}

function isReadContextHardBoundary(block: any) {
  if (!block) return false;
  if (block.type === "user" || block.type === "jobList") return true;
  if (block.type === "progress") return true;
  if (block.type === "agent") {
    if (block.hiddenProcess && !block.streaming) return false;
    if (isTransparentToolNarrationBlock(block)) return false;
    return hasRenderableAgentBlock(block);
  }
  if (block.type === "tool") {
    if (block.toolStatus !== "pending") return !isCompletedReadContextTool(block);
    return block.toolName !== "write_file" && block.toolName !== "replace_in_file" && block.toolName !== "apply_patch";
  }
  return false;
}

function compactToolTarget(rawTarget: string, toolName: string, language: "zh" | "en") {
  return compactToolPresentationTarget(rawTarget, toolName, language);
}

function fullToolTarget(rawTarget: string, toolName: string, language: "zh" | "en") {
  const target = String(rawTarget || "").trim();
  if (target) return target;
  if (toolName === "get_project_skeleton") return language === "zh" ? "项目骨架" : "Project skeleton";
  return language === "zh" ? "当前工作区" : "Current workspace";
}

function getReadContextToolLabel(toolName: string, language: "zh" | "en") {
  const labels = READ_CONTEXT_TOOL_LABELS[toolName];
  if (labels) return labels[language === "zh" ? "zh" : "en"];
  return getToolPresentationLabel(toolName, language);
}

function isFinishedTurnStatus(status: string) {
  return status === "done" || status === "completed_with_changes";
}

function getLatestThoughtBlock(blocks: any[]) {
  return [...blocks].reverse().find((block) => block?.type === "thought" && String(block.content || "").trim());
}

function buildBlockRenderItems(
  blocks: any[],
  includeUser = true,
  enableCompletedToolGrouping: boolean | {
    enabled?: boolean;
    includeDiff?: boolean;
    includeReadContextTools?: boolean;
    minGroupSize?: number;
    splitProjectStructureExplore?: boolean;
  } = false,
  language: "zh" | "en" = "zh",
) {
  const completedToolGroupingConfig =
    typeof enableCompletedToolGrouping === "object"
      ? enableCompletedToolGrouping
      : { enabled: enableCompletedToolGrouping };
  return buildChatRenderSegments({
    blocks,
    includeUser,
    language,
    completedToolGrouping: completedToolGroupingConfig,
  });
}

function buildToolExecutionSummary(blocks: any[], language: "zh" | "en") {
  const counts = { read: 0, table: 0, edit: 0, command: 0, failed: 0, other: 0 };

  blocks.forEach((block) => {
    if (block.type !== "tool") return;
    if (block.toolStatus === "failed") {
      counts.failed += 1;
      return;
    }
    if (block.toolStatus !== "executed" && block.toolStatus !== "running") return;
    const toolName = String(block.toolName || "");
    if (TOOL_SUMMARY_GROUPS.read.has(toolName)) counts.read += 1;
    else if (TOOL_SUMMARY_GROUPS.table.has(toolName)) counts.table += 1;
    else if (TOOL_SUMMARY_GROUPS.edit.has(toolName)) counts.edit += 1;
    else if (TOOL_SUMMARY_GROUPS.command.has(toolName)) counts.command += 1;
    else counts.other += 1;
  });

  const parts: string[] = [];
  if (language === "zh") {
    if (counts.table) parts.push(`分析/查询 ${counts.table} 次表格`);
    if (counts.read) parts.push(`读取/搜索 ${counts.read} 次资料`);
    if (counts.edit) parts.push(`修改 ${counts.edit} 次文件`);
    if (counts.command) parts.push(`执行 ${counts.command} 次命令`);
    if (counts.other) parts.push(`调用 ${counts.other} 次工具`);
    if (counts.failed) parts.push(`${counts.failed} 次请求失败`);
    return parts.length > 0 ? `本轮已${parts.join("，")}。` : "本轮过程已折叠，结论会优先保留在这里。";
  }

  if (counts.table) parts.push(`${counts.table} table operation(s)`);
  if (counts.read) parts.push(`${counts.read} read/search operation(s)`);
  if (counts.edit) parts.push(`${counts.edit} file edit(s)`);
  if (counts.command) parts.push(`${counts.command} command operation(s)`);
  if (counts.other) parts.push(`${counts.other} tool call(s)`);
  if (counts.failed) parts.push(`${counts.failed} failed request(s)`);
  return parts.length > 0 ? `This turn completed ${parts.join(", ")}.` : "This turn is collapsed. The conclusion is kept here first.";
}

function shouldGroupPlanExecutionTools(input: {
  turnIntent: string;
  isPlanTurn: boolean;
  isPlanApproved: boolean;
  planStage: string;
  turnStatus?: string;
  isPlanExecutionVisible: boolean;
}) {
  if (input.turnIntent === "studio_workflow") {
    return {
      enabled: true,
      includeDiff: false,
      includeReadContextTools: false,
      minGroupSize: 2,
    };
  }
  const isApprovedPlanExecution =
    input.isPlanTurn &&
    (
      input.isPlanApproved ||
      input.planStage === "executing" ||
      input.isPlanExecutionVisible ||
      input.turnStatus === "executing" ||
      input.turnStatus === "stopped_no_action" ||
      input.turnStatus === "error"
    );
  return {
    enabled: input.turnIntent === "execute" || isApprovedPlanExecution,
    includeDiff: input.turnIntent === "execute" || isApprovedPlanExecution,
    includeReadContextTools: isApprovedPlanExecution,
    minGroupSize: isApprovedPlanExecution ? 1 : 2,
    splitProjectStructureExplore: input.isPlanTurn && !input.isPlanApproved,
  };
}

function getActiveTurnActivity(blocks: any[], turnStatus: string, language: "zh" | "en") {
  const completedToolCallCount = countCompletedToolCalls(blocks);
  const runningTool = [...blocks].reverse().find((block) => block.type === "tool" && block.toolStatus === "running");
  if (runningTool) {
    const target = String(runningTool.target || runningTool.toolName || "").split("/").pop() || runningTool.toolName;
    const tableTools = new Set(["analyze_tabular_document", "query_tabular_document"]);
    const readTools = new Set(["read_file", "read_document", "list_directory", "glob_search", "grep_search", "repo_map_status", "repo_map_search", "repo_map_context", "repo_map_files", "repo_map_impact", "index_workspace_documents", "get_project_skeleton"]);
    const commandTools = new Set(["execute_command", "run_command", "browser_evaluate", "send_pty_input"]);
    const toolName = String(runningTool.toolName || "");
    const prefix = language === "zh"
      ? completedToolCallCount > 0 ? `已完成 ${completedToolCallCount} 次，` : ""
      : completedToolCallCount > 0 ? `${completedToolCallCount} completed, ` : "";
    if (language === "zh") {
      if (tableTools.has(toolName)) return `${prefix}当前分析表格：${target}`;
      if (readTools.has(toolName)) return `${prefix}当前读取资料：${target}`;
      if (commandTools.has(toolName)) return `${prefix}当前执行命令：${target}`;
      return `${prefix}当前调用工具：${target}`;
    }
    if (tableTools.has(toolName)) return `${prefix}analyzing table: ${target}`;
    if (readTools.has(toolName)) return `${prefix}reading context: ${target}`;
    if (commandTools.has(toolName)) return `${prefix}running command: ${target}`;
    return `${prefix}using tool: ${target}`;
  }

  const streamingThought = [...blocks].reverse().find((block) => block.type === "thought" && block.isStreaming);
  if (streamingThought) {
    const thoughtChars = String(streamingThought.content || "").length;
    if (thoughtChars > 4_000) {
      return language === "zh"
        ? "正在整理较长上下文，等待可见回复或下一步动作..."
        : "Working through a longer context while waiting for the visible reply or next action...";
    }
    return language === "zh" ? "正在整理下一步..." : "Thinking through the next step...";
  }

  const hasStreamingAgent = blocks.some((block) => block.type === "agent" && block.streaming);
  if (hasStreamingAgent) return language === "zh" ? "正在生成回复..." : "Writing the response...";

  if (turnStatus === "planning") return language === "zh" ? "正在整理计划..." : "Building the plan...";
  if (turnStatus === "executing") {
    if (completedToolCallCount > 0) {
      return language === "zh"
        ? `已完成 ${completedToolCallCount} 次，正在等待模型规划下一步...`
        : `${completedToolCallCount} completed, waiting for the model to plan the next step...`;
    }
    return language === "zh" ? "正在等待模型规划下一步..." : "Waiting for the model to plan the next step...";
  }
  return "";
}

function TurnActivityNotice({
  activityText,
  thoughtSummaryText,
  isThinking,
  language,
  chatFontSize,
  progressItems = [],
  text,
}: {
  activityText?: string;
  thoughtSummaryText?: string;
  isThinking?: boolean;
  language: "zh" | "en";
  chatFontSize: number;
  progressItems?: RuntimeProgressLedgerItem[];
  text?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const progressProjection = buildRuntimeProgressProjection(progressItems, language, 4);
  const latestProgressLogKey = progressProjection.latest
    ? `${progressProjection.latest.key}:${progressProjection.latest.status}:${progressProjection.latest.repeatCount}:${progressProjection.latest.lastSeenAt}`
    : "";
  const lastLoggedProgressKeyRef = useRef("");
  useEffect(() => {
    if (!latestProgressLogKey || lastLoggedProgressKeyRef.current === latestProgressLogKey) return;
    lastLoggedProgressKeyRef.current = latestProgressLogKey;
    appendDebugLog("info", "ui.progress_projection_updated", {
      latestKey: progressProjection.latest?.key || "",
      latestTitle: progressProjection.latest?.title || "",
      latestStatus: progressProjection.latest?.status || "",
      recentCount: progressProjection.recent.length,
      summary: progressProjection.summary,
    });
  }, [latestProgressLogKey, progressProjection.latest, progressProjection.recent.length, progressProjection.summary]);
  const resolvedActivityText = String(progressProjection.activityText || activityText || text || "").trim();
  const resolvedThoughtSummaryText = String(thoughtSummaryText || "").trim();
  if (!resolvedActivityText && !resolvedThoughtSummaryText) return null;
  const thoughtTitle = language === "zh"
    ? isThinking ? "正在整理思路" : "思考摘要"
    : isThinking ? "Thinking" : "Thinking summary";
  const progressTitle = progressProjection.latest?.status === "paused"
    ? language === "zh" ? "已暂停" : "Paused"
    : language === "zh" ? "有效进展" : "Effective Progress";
  const canExpandProgress = progressProjection.recent.length > 1;
  const toggleText = expanded
    ? language === "zh" ? "收起" : "Hide"
    : language === "zh" ? "最近 4 条" : "Recent 4";
  return (
    <div
      data-testid="turn-activity-notice"
      className="ml-9 rounded-2xl border border-[rgba(96,165,250,0.2)] bg-[rgba(37,99,235,0.08)] px-4 py-3 text-[12px] text-[#bfdbfe]"
    >
      {resolvedThoughtSummaryText && (
        <div data-testid="turn-activity-thought-summary" className="max-h-[42vh] overflow-y-auto pr-1" style={{ fontSize: `${chatFontSize}px` }}>
          <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] text-[#93c5fd]">
            <span className={`h-1.5 w-1.5 rounded-full ${isThinking ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.75)] animate-pulse" : "bg-[#34d399]"}`} />
            <span>{thoughtTitle}</span>
          </div>
          <MarkdownRenderer
            content={resolvedThoughtSummaryText}
            baseFontSize={chatFontSize}
            sourceId="turn-activity-thought-summary"
          />
        </div>
      )}
      {resolvedActivityText && (
        <div
          data-testid="effective-progress-ledger"
          className={`${resolvedThoughtSummaryText ? "mt-2 border-t border-[rgba(147,197,253,0.14)] pt-2" : ""}`}
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#60a5fa] shadow-[0_0_8px_rgba(96,165,250,0.8)] animate-pulse" />
            <span className="min-w-0 flex-1">
              <span className="mb-0.5 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#93c5fd]">{progressTitle}</span>
              <span className="block whitespace-pre-wrap break-words text-[12px] leading-5 text-[#bfdbfe]">{resolvedActivityText}</span>
            </span>
            {canExpandProgress && (
              <button
                type="button"
                data-testid="effective-progress-ledger-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-[#93c5fd] transition-colors hover:bg-[rgba(96,165,250,0.12)]"
              >
                {expanded ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
                {toggleText}
              </button>
            )}
          </div>
          {expanded && progressProjection.recent.length > 0 && (
            <div className="mt-2 border-t border-[rgba(147,197,253,0.14)] pt-2">
              <EffectiveProgressLedgerDetails items={progressProjection.recent} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EffectiveProgressLedgerDetails({
  items,
}: {
  items: RuntimeProgressLedgerItem[];
}) {
  const latestItems = items.filter(Boolean).slice(-4);
  if (latestItems.length === 0) return null;
  return (
    <div data-testid="effective-progress-ledger-details" className="space-y-1">
      {latestItems.map((item) => (
        <div
          key={item.key}
          data-testid="effective-progress-ledger-item"
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-lg px-1.5 py-1 text-[11px]"
        >
          <span className={`mt-1 h-2 w-2 rounded-full ${
            item.status === "failed" || item.status === "paused"
              ? "bg-[#f87171]"
              : item.status === "running"
              ? "bg-[#60a5fa] shadow-[0_0_8px_rgba(96,165,250,0.8)]"
              : "bg-[#10b981]"
          }`} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-[var(--surface-text)]">{item.title}</span>
            {item.summary && (
              <span className="mt-0.5 block truncate text-[var(--surface-text-subtle)]">{item.summary}</span>
            )}
          </span>
          {(item.repeatCount > 1 || item.cacheHits > 0) && (
            <span className="shrink-0 rounded-full border border-[#334155] bg-[#0f172a] px-1.5 py-0.5 text-[9px] text-[#93c5fd]">
              x{item.repeatCount}{item.cacheHits ? ` / ${item.cacheHits} cached` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function formatThoughtDuration(duration: unknown, language: "zh" | "en"): string {
  const ms = Number(duration);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = ms > 600 ? ms / 1000 : ms;
  const formatted = seconds >= 10 ? Math.round(seconds).toString() : seconds.toFixed(1).replace(/\.0$/, "");
  return language === "zh" ? `用时 ${formatted}s` : `${formatted}s`;
}

function ThoughtBlock({
  block,
  language,
  chatFontSize,
  summaryText,
  compact = false,
}: {
  block: any;
  language: "zh" | "en";
  chatFontSize: number;
  summaryText?: string;
  compact?: boolean;
}) {
  const rawContent = String(block.content || "").trim();
  if (!rawContent) return null;
  const computedSummaryText = useMemo(() => {
    const display = deriveThoughtDisplay(rawContent, {
      language,
      density: compact ? "adaptive" : "compact",
      mode: compact ? "latest" : "first",
    });
    return display.summaryText;
  }, [compact, language, rawContent]);
  const resolvedSummaryText = String(summaryText || "").trim() || computedSummaryText;
  if (!resolvedSummaryText) return null;
  const isStreamingThought = !!block.isStreaming;
  const durationLabel = formatThoughtDuration(block.duration, language);
  const title = language === "zh"
    ? isStreamingThought ? "正在整理思路" : "思考摘要"
    : isStreamingThought ? "Thinking" : "Thinking summary";
  const statusLabel = language === "zh"
    ? isStreamingThought ? "摘要会持续更新" : "原始推理已折叠"
    : isStreamingThought ? "Summary updates live" : "Raw reasoning is folded";
  const wrapperClass = compact
    ? "mt-2 flex w-full min-w-0 items-start justify-start gap-3"
    : "mt-4 flex w-full min-w-0 items-start justify-start gap-3";

  return (
    <div data-testid="thought-block" className={wrapperClass}>
      <div className="mt-1 flex-shrink-0">
        <IconLogoM className={`theme-text drop-shadow-[0_0_8px_var(--accent-subtle)] ${compact ? "h-5 w-5" : "h-6 w-6"}`} />
      </div>
      <div
        data-testid="thought-summary-lines"
        className={`${compact ? "my-0" : "my-1"} min-w-0 flex-1 rounded-xl border border-[#27272a] bg-[#07070a] px-3 py-2 text-[#e4e4e7]`}
        style={{ fontSize: `${chatFontSize}px` }}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-[#a1a1aa]">
          <span className="inline-flex items-center gap-1.5 text-[#d4d4d8]">
            <span className={`h-1.5 w-1.5 rounded-full ${isStreamingThought ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.75)] animate-pulse" : "bg-[#34d399]"}`} />
            {title}
          </span>
          <span className="rounded-full border border-[#27272a] bg-[#050507] px-2 py-0.5">{statusLabel}</span>
          {durationLabel && (
            <span className="rounded-full border border-[rgba(96,165,250,0.22)] bg-[rgba(37,99,235,0.08)] px-2 py-0.5 text-[#bfdbfe]">
              {durationLabel}
            </span>
          )}
        </div>
        <MarkdownRenderer
          content={resolvedSummaryText}
          baseFontSize={chatFontSize}
          sourceId={`thought-${block.id ?? "current"}`}
        />
      </div>
    </div>
  );
}

function TurnChangesCard({
  entries,
  totalExecutedEdits,
  language,
  onOpenDiff,
  defaultExpanded = false,
  embedded = false,
  chatFontSize,
}: {
  entries: Array<{
    taskId: number;
    target: string;
    displayTarget: string;
    added: number;
    removed: number;
    editCount: number;
  }>;
  totalExecutedEdits: number;
  language: "zh" | "en";
  onOpenDiff: (taskId: number) => void;
  defaultExpanded?: boolean;
  embedded?: boolean;
  chatFontSize?: number;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (entries.length === 0) return null;

  const headerText = language === "zh"
    ? `本轮改动 · ${entries.length} 个文件`
    : `Turn Changes · ${entries.length} file${entries.length > 1 ? "s" : ""}`;
  const subText = language === "zh"
    ? `${totalExecutedEdits} 次已执行修改`
    : `${totalExecutedEdits} executed edit${totalExecutedEdits > 1 ? "s" : ""}`;
  const toggleText = expanded
    ? language === "zh" ? "收起" : "Collapse"
    : language === "zh" ? "展开" : "Expand";

  return (
    <div
      className={`${embedded ? "" : "turn-process-font-scope ml-9"} rounded-2xl border border-[#1d4ed8]/18 bg-[#060b14] px-4 py-3`}
      style={chatFontSize ? getTurnProcessFontStyle(chatFontSize) : undefined}
    >
      <button
        type="button"
        data-testid="turn-changes-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[#93c5fd]">
            <IconCode className="h-3.5 w-3.5" />
            <span>{headerText}</span>
          </div>
          <div className="mt-1 text-[12px] text-[#64748b]">{subText}</div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#1e293b] bg-[#05070d] px-2.5 py-1 text-[10px] text-[#93c5fd]">
          {expanded ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
          {toggleText}
        </span>
      </button>
      {expanded && <div data-testid="turn-changes-details" className="mt-3 space-y-2">
        {entries.map((entry) => (
          <button
            key={`${entry.target}-${entry.taskId}`}
            onClick={() => onOpenDiff(entry.taskId)}
            data-testid="turn-change-entry"
            data-target={entry.target}
            className="flex w-full items-center gap-3 rounded-xl border border-[#1e293b] bg-[#05070d] px-3 py-2 text-left transition-colors hover:border-[#2563eb]/35 hover:bg-[#09111f]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-[#dbeafe]">{entry.displayTarget}</span>
              <span className="block truncate text-[11px] text-[#64748b]">{entry.target}</span>
            </span>
            {entry.editCount > 1 && (
              <span className="shrink-0 rounded-full border border-[#334155] bg-[#0f172a] px-2 py-0.5 text-[10px] text-[#cbd5e1]">
                {language === "zh" ? `${entry.editCount} 次编辑` : `${entry.editCount} edits`}
              </span>
            )}
            <span className="shrink-0 text-[11px] font-medium text-[#10b981]">+{entry.added}</span>
            <span className="shrink-0 text-[11px] font-medium text-[#f87171]">-{entry.removed}</span>
          </button>
        ))}
      </div>}
    </div>
  );
}

function ReadContextGroupCard({
  blocks,
  language,
}: {
  blocks: any[];
  language: "zh" | "en";
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = buildReadContextEntries(blocks, language);
  const totalCount = blocks.length;
  const uniqueCount = entries.length;
  const duplicateCount = Math.max(0, totalCount - uniqueCount);
  const cachedCount = entries.reduce((sum, entry) => sum + entry.cachedCount, 0);
  const previewTargets = entries.map((entry) =>
    entry.count > 1 ? `${entry.displayTarget} x${entry.count}` : entry.displayTarget
  ).slice(0, 3).filter(Boolean);
  const hiddenCount = Math.max(0, entries.length - previewTargets.length);
  const previewText = previewTargets.join(language === "zh" ? "、" : ", ");
  const previewPurpose = entries
    .map((entry) => entry.summary)
    .find(Boolean);
  const title = duplicateCount > 0
    ? language === "zh"
      ? `已读取 ${uniqueCount} 项有效上下文（共 ${totalCount} 次）`
      : `Read ${uniqueCount} effective context item${uniqueCount > 1 ? "s" : ""} (${totalCount} total)`
    : language === "zh"
    ? `已读取 ${totalCount} 项上下文`
    : `Read ${totalCount} context item${totalCount > 1 ? "s" : ""}`;
  const duplicateText = duplicateCount > 0
    ? language === "zh"
      ? `去重 ${duplicateCount} 次重复读取${cachedCount ? `，其中 ${cachedCount} 次为缓存复用` : ""}`
      : `Deduped ${duplicateCount} repeated read${duplicateCount > 1 ? "s" : ""}${cachedCount ? `, ${cachedCount} cached` : ""}`
    : "";
  const toggleText = expanded
    ? language === "zh" ? "收起" : "Collapse"
    : language === "zh" ? "展开" : "Expand";

  return (
    <div className="ml-9 max-w-[calc(100%-2.25rem)] min-w-0">
      <button
        type="button"
        data-testid="read-context-group"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-[#1f2937] bg-[#07070a] px-3 py-2 text-left transition-colors hover:border-[#374151] hover:bg-[#09090b]"
      >
        {expanded ? (
          <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        )}
        <IconCheck className="h-3.5 w-3.5 shrink-0 text-[#10b981]" />
        <span className="shrink-0 text-[12px] font-medium text-[#d4d4d8]">{title}</span>
        {previewText && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#71717a]">
            · {previewText}{hiddenCount > 0 ? ` +${hiddenCount}` : ""}
          </span>
        )}
        {previewPurpose && (
          <span data-testid="read-context-group-summary" className="min-w-0 flex-1 truncate text-[11px] text-[#94a3b8]">
            {previewPurpose}
          </span>
        )}
        {duplicateText && (
          <span data-testid="read-context-group-dedupe" className="shrink-0 rounded-full border border-[rgba(96,165,250,0.22)] bg-[rgba(37,99,235,0.08)] px-2 py-0.5 text-[10px] text-[#93c5fd]">
            {duplicateText}
          </span>
        )}
        <span className="shrink-0 rounded-full border border-[#27272a] bg-[#050507] px-2 py-0.5 text-[10px] text-[#a1a1aa]">
          {toggleText}
        </span>
      </button>

      {expanded && (
        <div
          data-testid="read-context-group-details"
          className="mt-2 space-y-1 rounded-xl border border-[#1f1f23] bg-[#050507] p-2"
        >
          {entries.map((entry) => {
            return (
              <div
                key={entry.key}
                data-testid="read-context-item"
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] text-[#a1a1aa]"
              >
                <IconCheck className="h-3 w-3 text-[#10b981]" />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-[#71717a]">{entry.label}</span>
                    <span className="min-w-0 truncate font-mono text-[#d4d4d8]" title={entry.target}>
                      {entry.displayTarget}
                    </span>
                    {entry.count > 1 && (
                      <span data-testid="read-context-item-repeat" className="shrink-0 rounded-full border border-[#334155] bg-[#0f172a] px-1.5 py-0.5 text-[9px] text-[#93c5fd]">
                        x{entry.count}{entry.cachedCount ? ` / ${entry.cachedCount} cached` : ""}
                      </span>
                    )}
                  </div>
                  {entry.target !== entry.displayTarget && (
                    <div className="truncate font-mono text-[10px] text-[#52525b]" title={entry.target}>
                      {entry.target}
                    </div>
                  )}
                  {entry.summary && (
                    <div data-testid="read-context-item-summary" className="truncate text-[10.5px] text-[#94a3b8]">
                      {entry.summary}
                    </div>
                  )}
                </div>
                <span className="shrink-0 rounded-full border border-[rgba(52,211,153,0.18)] bg-[rgba(52,211,153,0.08)] px-1.5 py-0.5 text-[9px] text-[#86efac]">
                  {language === "zh" ? "完成" : "Done"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getCompletedToolGroupToolLabel(toolName: string, language: "zh" | "en") {
  const labels = COMPLETED_TOOL_GROUP_LABELS[toolName];
  if (labels) return labels[language === "zh" ? "zh" : "en"];
  return getToolPresentationLabel(toolName, language);
}

function isCachedReadContextBlock(block: any) {
  const text = [
    block?.message,
    block?.observationSummary,
    block?.evidence,
    block?.resultPreview,
    block?.content,
  ].map((value) => String(value || "")).join("\n");
  return /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped/i.test(text);
}

function buildReadContextEntries(blocks: any[], language: "zh" | "en") {
  const entries: Array<{
    key: string;
    block: any;
    blocks: any[];
    count: number;
    cachedCount: number;
    label: string;
    displayTarget: string;
    target: string;
    summary: string;
  }> = [];
  const byKey = new Map<string, (typeof entries)[number]>();
  for (const block of blocks) {
    const toolName = String(block.toolName || "");
    const displayTarget = compactToolTarget(block.target, toolName, language);
    const target = fullToolTarget(block.target, toolName, language);
    const key = `${toolName}:${String(target || displayTarget).replace(/\\/g, "/").toLowerCase()}`;
    const cached = isCachedReadContextBlock(block) ? 1 : 0;
    const summary = String(block.observationSummary || block.intentSummary || block.why || "").trim();
    const existing = byKey.get(key);
    if (existing) {
      existing.blocks.push(block);
      existing.count += 1;
      existing.cachedCount += cached;
      if (summary && !existing.summary) existing.summary = summary;
      continue;
    }
    const entry = {
      key,
      block,
      blocks: [block],
      count: 1,
      cachedCount: cached,
      label: getReadContextToolLabel(toolName, language),
      displayTarget,
      target,
      summary,
    };
    byKey.set(key, entry);
    entries.push(entry);
  }
  return entries;
}

function CompletedToolGroupCard({
  blocks,
  language,
}: {
  blocks: any[];
  language: "zh" | "en";
}) {
  const [expanded, setExpanded] = useState(false);
  // Only consider tool blocks; thought blocks in the range are transparent.
  const toolBlocks = blocks.filter((block) => block.type === "tool");
  const commandBlocks = toolBlocks.filter((block) => isCommandLikeToolName(String(block.toolName || "")));
  const nonCommandBlocks = toolBlocks.filter((block) => !isCommandLikeToolName(String(block.toolName || "")));
  const previewNames = [
    ...nonCommandBlocks.slice(0, 2).map((block) => compactToolTarget(block.target, String(block.toolName || ""), language)),
    ...commandBlocks.slice(0, 1).map((block) => compactToolTarget(block.target, String(block.toolName || ""), language)),
  ].filter(Boolean);
  const hiddenCount = Math.max(0, toolBlocks.length - previewNames.length);
  const editCount = toolBlocks.filter((block) => TOOL_SUMMARY_GROUPS.edit.has(String(block.toolName || ""))).length;
  const readCount = toolBlocks.filter((block) => TOOL_SUMMARY_GROUPS.read.has(String(block.toolName || ""))).length;
  const tableCount = toolBlocks.filter((block) => TOOL_SUMMARY_GROUPS.table.has(String(block.toolName || ""))).length;
  const commandCount = commandBlocks.length;
  const typeSummaryParts: string[] = [];
  if (language === "zh") {
    if (editCount) typeSummaryParts.push(`修改 ${editCount} 个文件`);
    if (readCount) typeSummaryParts.push(`读取/搜索 ${readCount} 项`);
    if (tableCount) typeSummaryParts.push(`分析 ${tableCount} 次表格`);
    if (commandCount) typeSummaryParts.push(`运行 ${commandCount} 条命令`);
  } else {
    if (editCount) typeSummaryParts.push(`${editCount} file edit${editCount > 1 ? "s" : ""}`);
    if (readCount) typeSummaryParts.push(`${readCount} read/search operation${readCount > 1 ? "s" : ""}`);
    if (tableCount) typeSummaryParts.push(`${tableCount} table operation${tableCount > 1 ? "s" : ""}`);
    if (commandCount) typeSummaryParts.push(`${commandCount} command${commandCount > 1 ? "s" : ""}`);
  }
  const typeSummary = typeSummaryParts.join(language === "zh" ? "，" : ", ");
  const previewPurpose = toolBlocks
    .map((block) => String(block.observationSummary || block.intentSummary || block.why || ""))
    .find(Boolean);
  const title = language === "zh"
    ? `已完成 ${toolBlocks.length} 次工具调用`
    : `${toolBlocks.length} completed tool call${toolBlocks.length > 1 ? "s" : ""}`;
  const toggleText = expanded
    ? language === "zh" ? "收起" : "Collapse"
    : language === "zh" ? "展开" : "Expand";

  return (
    <div className="ml-9 max-w-[calc(100%-2.25rem)] min-w-0">
      <button
        type="button"
        data-testid="completed-tool-group"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-[#1f2937] bg-[#07070a] px-3 py-2 text-left transition-colors hover:border-[#374151] hover:bg-[#09090b]"
      >
        {expanded ? (
          <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        )}
        <IconCheck className="h-3.5 w-3.5 shrink-0 text-[#10b981]" />
        <span className="shrink-0 text-[12px] font-medium text-[#d4d4d8]">{title}</span>
        {typeSummary && (
          <span data-testid="completed-tool-group-type-summary" className="shrink-0 text-[11px] text-[#94a3b8]">
            · {typeSummary}
          </span>
        )}
        {previewNames.length > 0 && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#71717a]">
            · {previewNames.join(language === "zh" ? "、" : ", ")}{hiddenCount > 0 ? ` +${hiddenCount}` : ""}
          </span>
        )}
        {previewPurpose && (
          <span data-testid="completed-tool-group-summary" className="min-w-0 flex-1 truncate text-[11px] text-[#94a3b8]">
            {previewPurpose}
          </span>
        )}
        <span className="shrink-0 rounded-full border border-[#27272a] bg-[#050507] px-2 py-0.5 text-[10px] text-[#a1a1aa]">
          {toggleText}
        </span>
      </button>

      {expanded && (
        <div
          data-testid="completed-tool-group-details"
          className="mt-2 space-y-1 rounded-xl border border-[#1f1f23] bg-[#050507] p-2"
        >
          {toolBlocks.map((block) => {
            const toolName = String(block.toolName || "");
            const label = getCompletedToolGroupToolLabel(toolName, language);
            const displayTarget = compactToolTarget(block.target, toolName, language);
            const target = fullToolTarget(block.target, toolName, language);
            const statusCopy = getChatFeedbackStatusCopy(
              normalizeChatFeedbackStatus(block.toolStatus || "executed"),
              language,
            );

            return (
              <div
                key={block.id}
                data-testid="completed-tool-group-item"
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] text-[#a1a1aa]"
              >
                <IconCheck className="h-3 w-3 text-[#10b981]" />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-[#71717a]">{label}</span>
                    <span className="min-w-0 truncate font-mono text-[#d4d4d8]" title={target}>
                      {displayTarget}
                    </span>
                  </div>
                  {target !== displayTarget && (
                    <div className="truncate font-mono text-[10px] text-[#52525b]" title={target}>
                      {target}
                    </div>
                  )}
                  {(block.observationSummary || block.intentSummary || block.why) && (
                    <div data-testid="completed-tool-item-summary" className="truncate text-[10.5px] text-[#94a3b8]">
                      {block.observationSummary || block.intentSummary || block.why}
                    </div>
                  )}
                </div>
                <span className="shrink-0 rounded-full border border-[rgba(52,211,153,0.18)] bg-[rgba(52,211,153,0.08)] px-1.5 py-0.5 text-[9px] text-[#86efac]">
                  {statusCopy.shortLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getOperationClusterTone(kind: ChatOperationCluster["kind"]) {
  if (kind === "edit") return "text-[#93c5fd]";
  if (kind === "command" || kind === "verify") return "text-[#c4b5fd]";
  if (kind === "explore") return "text-[#fbbf24]";
  return "text-[#34d399]";
}

function ChatOperationClusterBlock({
  cluster,
  language,
}: {
  cluster: ChatOperationCluster;
  language: "zh" | "en";
}) {
  const [expanded, setExpanded] = useState(false);
  const toneClass = getOperationClusterTone(cluster.kind);
  const toggleText = expanded
    ? language === "zh" ? "收起" : "Collapse"
    : language === "zh" ? "展开" : "Expand";
  const duplicateText = cluster.duplicateCount > 0
    ? language === "zh"
      ? `去重 ${cluster.duplicateCount} 次重复读取${cluster.cachedCount ? `，其中 ${cluster.cachedCount} 次为缓存复用` : ""}`
      : `Deduped ${cluster.duplicateCount} repeated read${cluster.duplicateCount > 1 ? "s" : ""}${cluster.cachedCount ? `, ${cluster.cachedCount} cached` : ""}`
    : "";
  const buttonLegacyTestId = cluster.legacyTestId;
  const detailsLegacyTestId = cluster.legacyTestId === "read-context-group"
    ? "read-context-group-details"
    : cluster.legacyTestId === "completed-tool-group"
    ? "completed-tool-group-details"
    : undefined;
  const itemLegacyTestId = cluster.legacyTestId === "read-context-group"
    ? "read-context-item"
    : cluster.legacyTestId === "completed-tool-group"
    ? "completed-tool-group-item"
    : undefined;

  return (
    <div
      data-testid="chat-operation-cluster"
      data-kind={cluster.kind}
      className="ml-9 max-w-[calc(100%-2.25rem)] min-w-0"
    >
      <button
        type="button"
        data-testid={buttonLegacyTestId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        {expanded ? (
          <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--surface-text-muted)]" />
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--surface-text-muted)]" />
        )}
        <IconCheck className={`h-3.5 w-3.5 shrink-0 ${toneClass}`} />
        <span className="shrink-0 text-[13px] font-semibold text-[var(--surface-text)]">{cluster.title}</span>
        {cluster.countSummary && (
          <span data-testid="chat-operation-count-summary" className="shrink-0 text-[12px] text-[var(--surface-text-subtle)]">
            · {language === "zh" ? `已探索 ${cluster.countSummary}` : cluster.countSummary}
          </span>
        )}
        {cluster.previewText && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--surface-text-muted)]">
            · {cluster.previewText}
          </span>
        )}
        {cluster.purposeSummary && (
          <span data-testid="chat-operation-summary" className="hidden min-w-0 flex-1 truncate text-[11px] text-[var(--surface-text-subtle)] lg:block">
            {cluster.purposeSummary}
          </span>
        )}
        {duplicateText && (
          <span data-testid="read-context-group-dedupe" className="shrink-0 rounded-full border border-[rgba(96,165,250,0.22)] bg-[rgba(37,99,235,0.08)] px-2 py-0.5 text-[10px] text-[#93c5fd]">
            {duplicateText}
          </span>
        )}
        <span className="shrink-0 rounded-full border border-[var(--surface-border-soft)] px-2 py-0.5 text-[10px] text-[var(--surface-text-muted)]">
          {toggleText}
        </span>
      </button>

      {expanded && (
        <div
          data-testid="chat-operation-cluster-details"
          className="ml-6 mt-1.5 space-y-1 border-l border-[var(--surface-border-soft)] pl-3"
        >
          {detailsLegacyTestId && (
            <div data-testid={detailsLegacyTestId} className="space-y-1">
              {cluster.items.map((item) => (
                <div
                  key={item.key}
                  data-testid={itemLegacyTestId}
                  data-kind={item.kind}
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-[12px] text-[var(--surface-text-subtle)]"
                >
                  <IconCheck className={`h-3 w-3 ${getOperationClusterTone(item.kind)}`} />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-semibold text-[var(--surface-text)]">{item.label}</span>
                      <span className="min-w-0 truncate font-mono text-[var(--surface-text-subtle)]" title={item.target}>
                        {item.displayTarget}
                      </span>
                      {item.count > 1 && (
                        <span data-testid="read-context-item-repeat" className="shrink-0 rounded-full border border-[var(--surface-border-soft)] px-1.5 py-0.5 text-[9px] text-[#93c5fd]">
                          x{item.count}{item.cachedCount ? ` / ${item.cachedCount} cached` : ""}
                        </span>
                      )}
                    </div>
                    {item.target !== item.displayTarget && (
                      <div className="truncate font-mono text-[10px] text-[var(--surface-text-muted)]" title={item.target}>
                        {item.target}
                      </div>
                    )}
                    {item.summary && (
                      <div data-testid={cluster.legacyTestId === "read-context-group" ? "read-context-item-summary" : "completed-tool-item-summary"} className="truncate text-[10.5px] text-[var(--surface-text-muted)]">
                        {item.summary}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full border border-[rgba(52,211,153,0.18)] bg-[rgba(52,211,153,0.08)] px-1.5 py-0.5 text-[9px] text-[#86efac]">
                    {language === "zh" ? "完成" : "Done"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TurnProcessArchive({
  archive,
  language,
  chatFontSize,
  renderArchivedItem,
  onOpenDiff,
}: {
  archive: ReturnType<typeof buildTurnProcessArchiveModel>;
  language: "zh" | "en";
  chatFontSize: number;
  renderArchivedItem: (item: any) => React.ReactNode;
  onOpenDiff: (taskId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (archive.totalCount === 0) return null;

  const title = language === "zh" ? "本轮过程归档" : "Turn Process Archive";
  const fallbackSummary = language === "zh" ? "过程记录已折叠保留，可展开追溯。" : "Process records are folded and kept for review.";
  const previewText = archive.previewTargets.length > 0
    ? archive.previewTargets.join(language === "zh" ? "、" : ", ")
    : "";
  const toggleText = expanded
    ? language === "zh" ? "收起过程" : "Collapse"
    : language === "zh" ? "展开过程" : "Expand";
  const containerClassName = expanded
    ? "turn-process-font-scope ml-9 rounded-xl px-1 py-2 ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent-light)_50%,transparent)] transition-all duration-150"
    : "turn-process-font-scope ml-9 rounded-xl px-1 py-2 ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent-light)_32%,transparent)] transition-all duration-150 hover:ring-[color-mix(in_srgb,var(--accent-light)_44%,transparent)]";

  const thoughtSteps = archive.steps.filter((step) => step.kind === "thinking");
  const timelineSteps = archive.steps.filter((step) => step.kind !== "thinking");

  return (
    <div className={containerClassName} style={getTurnProcessFontStyle(chatFontSize)}>
      <button
        type="button"
        data-testid="turn-process-archive-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[#93c5fd]">
              <IconColumns className="h-3.5 w-3.5" />
              {title}
            </span>
            <span className="text-[10px] text-[var(--surface-text-muted)]">
              {language === "zh" ? `${archive.stepCount} 步` : `${archive.stepCount} step${archive.stepCount > 1 ? "s" : ""}`}
            </span>
          </span>
          <span className="mt-1 block whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--surface-text-subtle)]">
            {archive.summaryText || fallbackSummary}{previewText ? ` · ${previewText}` : ""}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 px-1 py-1 text-[10px] text-[var(--surface-text-muted)]">
          {expanded ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
          {toggleText}
        </span>
      </button>

      {expanded && (
        <div data-testid="turn-process-archive-details" className="mt-2 space-y-3 px-2">
          {thoughtSteps.map((step) => (
            <div key={step.id} data-testid="turn-archive-thought-step">
              {buildBlockRenderItems(step.items, false, false, language).map((item: any, index: number) => (
                <React.Fragment key={`archived-thought-${item.block?.id ?? item.blocks?.[0]?.id ?? index}-${index}`}>
                  {renderArchivedItem(item)}
                </React.Fragment>
              ))}
            </div>
          ))}
          {timelineSteps.length > 0 && (
            <div data-testid="turn-archive-timeline" className="space-y-2">
              {timelineSteps.map((step) => (
                <TurnArchiveStepCard
                  key={step.id}
                  step={step}
                  language={language}
                  chatFontSize={chatFontSize}
                  renderArchivedItem={renderArchivedItem}
                  onOpenDiff={onOpenDiff}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getArchiveStepLabel(step: TurnArchiveStep, language: "zh" | "en") {
  if (step.activity?.label) return step.activity.label;
  if (step.phase?.title) return step.phase.title;
  if (language === "en") {
    if (step.kind === "message") return "Model note";
    if (step.kind === "discover") return "Scope";
    if (step.kind === "inspect") return "Context";
    if (step.kind === "edit") return "Edit";
    if (step.kind === "verify") return "Verify";
    if (step.kind === "command") return "Command";
    if (step.kind === "blocked") return step.status === "rejected" ? "Rejected" : "Blocked";
    return "Process";
  }
  if (step.kind === "message") return "模型说明";
  if (step.kind === "discover") return "定位范围";
  if (step.kind === "inspect") return "收集上下文";
  if (step.kind === "edit") return "实施修改";
  if (step.kind === "verify") return "运行验证";
  if (step.kind === "command") return "执行命令";
  if (step.kind === "blocked") return step.status === "rejected" ? "已拒绝" : "受阻";
  return "过程记录";
}

function normalizeProcessTextForCompare(text: string): string {
  return normalizeThoughtSummaryForCompare(text).replace(/\s+/g, "");
}

function processTextsOverlap(left: string, right: string): boolean {
  const a = normalizeProcessTextForCompare(left);
  const b = normalizeProcessTextForCompare(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

function liveTimelineContainsProcessText(model: ReturnType<typeof buildLiveTurnProcessTimelineModel> | null, text: string): boolean {
  const value = String(text || "").trim();
  if (!model || !value) return false;
  return model.steps.some((step) => {
    if (processTextsOverlap(step.intent, value)) return true;
    if (processTextsOverlap(step.note, value)) return true;
    return step.items.some((item: any) => item?.type === "agent" && item?.hiddenProcess && processTextsOverlap(String(item.content || ""), value));
  });
}

function getArchiveStepStatusLabel(step: TurnArchiveStep, language: "zh" | "en") {
  if (language === "en") {
    if (step.status === "running") return "Running";
    if (step.status === "failed") return "Failed";
    if (step.status === "rejected") return "Rejected";
    return "Done";
  }
  if (step.status === "running") return "进行中";
  if (step.status === "failed") return "失败";
  if (step.status === "rejected") return "拒绝";
  return "完成";
}

function ArchiveStepIcon({ step }: { step: TurnArchiveStep }) {
  const className = "h-3.5 w-3.5";
  if (step.status === "failed" || step.status === "rejected" || step.kind === "blocked") {
    return <IconClose className={`${className} text-[#f87171]`} />;
  }
  if (step.status === "running") {
    return <span className="h-2 w-2 rounded-full bg-[#60a5fa] shadow-[0_0_8px_rgba(96,165,250,0.8)] animate-pulse" />;
  }
  if (step.kind === "edit") return <IconCode className={`${className} text-[#93c5fd]`} />;
  if (step.kind === "verify" || step.kind === "command") return <IconTerminal className={`${className} text-[#c4b5fd]`} />;
  if (step.kind === "discover") return <IconFolder className={`${className} text-[#fbbf24]`} />;
  if (step.kind === "inspect") return <IconFileText className={`${className} text-[#34d399]`} />;
  return <IconCheck className={`${className} text-[#10b981]`} />;
}

function renderCompactMarkdownInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe = /(\*\*[^*\n]+?\*\*|`[^`\n]+?`)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0] || "";
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-strong-${index}`} className="font-semibold text-[var(--surface-text)]">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={`${keyPrefix}-code-${index}`} className="rounded border border-[var(--surface-border-soft)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-1 py-[1px] font-mono text-[0.92em] text-[var(--surface-text)]">
          {token.slice(1, -1)}
        </code>,
      );
    }
    cursor = match.index + token.length;
    index += 1;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length > 0 ? nodes : [text];
}

function renderCompactMarkdownText(text: string): React.ReactNode {
  return String(text || "").replace(/\r\n/g, "\n").split("\n").map((line, lineIndex) => (
    <React.Fragment key={`compact-md-line-${lineIndex}`}>
      {lineIndex > 0 && <br />}
      {renderCompactMarkdownInline(line, `compact-md-${lineIndex}`)}
    </React.Fragment>
  ));
}

function TurnArchiveStepCard({
  step,
  language,
  chatFontSize,
  renderArchivedItem,
  onOpenDiff,
  variant = "archive",
}: {
  step: TurnArchiveStep;
  language: "zh" | "en";
  chatFontSize: number;
  renderArchivedItem: (item: any) => React.ReactNode;
  onOpenDiff: (taskId: number) => void;
  variant?: "archive" | "live";
}) {
  const isLive = variant === "live";
  const [expanded, setExpanded] = useState(!isLive && step.expandedByDefault);
  const { entries, totalExecutedEdits } = collectTurnChangeEntries(step.items);
  const hasChangeSummary = step.kind === "edit" && entries.length > 0;
  const detailItems = buildBlockRenderItems(step.items, false, false, language);
  const canExpandDetails = !isLive && (hasChangeSummary || detailItems.length > 0);
  const toggleText = expanded
    ? isLive
      ? language === "zh" ? "收起操作" : "Hide actions"
      : language === "zh" ? "收起证据" : "Hide evidence"
    : isLive
      ? language === "zh" ? "展开操作" : "Show actions"
      : language === "zh" ? "查看证据" : "Show evidence";
  const targetText = step.targets.slice(0, 3).join(language === "zh" ? "、" : ", ");
  const hiddenTargetCount = Math.max(0, step.targets.length - 3);
  const primaryText = (isLive && step.intent) ? step.intent : step.activity?.title || step.intent;
  const activitySummary = step.activity?.summary || "";
  const shouldShowTargetSummary = targetText && !primaryText.includes(targetText) && !activitySummary.includes(targetText);
  const summaryText = activitySummary || (step.summary
    ? `${step.summary}${shouldShowTargetSummary ? ` · ${targetText}${hiddenTargetCount ? ` +${hiddenTargetCount}` : ""}` : ""}`
    : "");
  const latestEvidenceText = step.activity?.recoveryHint || "";
  const headerContent = (
    <>
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        <ArchiveStepIcon step={step} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] font-medium text-[var(--surface-text-subtle)]">
          <span data-testid="turn-archive-step-label" className="uppercase tracking-[0.12em]">
            {getArchiveStepLabel(step, language)}
          </span>
          <span className="text-[var(--surface-text-subtle)]">·</span>
          <span>
            {getArchiveStepStatusLabel(step, language)}
          </span>
        </span>
        <span data-testid="turn-archive-step-intent" className="mt-1 block whitespace-pre-wrap break-words text-[12.5px] font-medium leading-5 text-[var(--surface-text)]">
          {renderCompactMarkdownText(primaryText)}
        </span>
        {summaryText && (
          <span data-testid="turn-archive-step-summary" className="mt-0.5 block whitespace-pre-wrap break-words text-[11px] leading-4 text-[var(--surface-text-subtle)]">
            {renderCompactMarkdownText(summaryText)}
          </span>
        )}
        {latestEvidenceText && (
          <span data-testid="turn-archive-step-evidence" className="mt-0.5 block whitespace-pre-wrap break-words text-[10.5px] leading-4 text-[var(--surface-text-muted)]">
            {renderCompactMarkdownText(latestEvidenceText)}
          </span>
        )}
      </span>
      {canExpandDetails && (
        <span className="inline-flex shrink-0 items-center gap-1.5 px-1 py-1 text-[10px] text-[var(--surface-text-muted)] transition-colors group-hover:text-[var(--surface-text)]">
          {expanded ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
          {toggleText}
        </span>
      )}
    </>
  );

  return (
    <div
      data-testid={isLive ? "live-turn-step" : "turn-archive-step"}
      data-kind={step.kind}
      data-status={step.status}
      className="border-t border-[var(--surface-border-soft)] py-2 first:border-t-0"
    >
      {canExpandDetails ? (
        <button
          type="button"
          data-testid="turn-archive-step-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="group flex w-full min-w-0 items-start gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-start gap-3 rounded-lg px-1 py-1 text-left">
          {headerContent}
        </div>
      )}

      {canExpandDetails && expanded && (
        <div data-testid="turn-archive-step-details" className="mt-2 space-y-2 pl-8">
          {hasChangeSummary ? (
            <TurnChangesCard
              entries={entries}
              totalExecutedEdits={totalExecutedEdits}
              language={language}
              onOpenDiff={onOpenDiff}
              embedded
              chatFontSize={chatFontSize}
            />
          ) : (
            detailItems.map((item: any, index: number) => (
              <React.Fragment key={`archived-step-${step.id}-${item.block?.id ?? item.blocks?.[0]?.id ?? index}-${index}`}>
                {renderArchivedItem(item)}
              </React.Fragment>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function LiveTurnProcessTimeline({
  model,
  language,
  chatFontSize,
  renderLiveItem,
  onOpenDiff,
}: {
  model: ReturnType<typeof buildLiveTurnProcessTimelineModel> | null;
  language: "zh" | "en";
  chatFontSize: number;
  renderLiveItem: (item: any) => React.ReactNode;
  onOpenDiff: (taskId: number) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (!model || model.totalCount === 0) return null;
  const title = language === "zh" ? "本轮步骤" : "Turn steps";
  const stepCount = model.stepCount;
  const summary = model.summaryText || (language === "zh" ? "操作已按步骤折叠。" : "Actions are folded by step.");
  const toggleText = expanded
    ? language === "zh" ? "收起步骤" : "Collapse steps"
    : language === "zh" ? "展开步骤" : "Expand steps";

  return (
    <div
      data-testid="live-turn-process-timeline"
      className="turn-process-font-scope ml-9 rounded-xl px-1 py-2 ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent-light)_32%,transparent)] transition-all duration-150"
      style={getTurnProcessFontStyle(chatFontSize)}
    >
      <button
        type="button"
        data-testid="live-turn-process-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full min-w-0 items-start justify-between gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[#93c5fd]">
              <IconColumns className="h-3.5 w-3.5" />
              {title}
            </span>
            <span className="text-[10px] text-[var(--surface-text-muted)]">
              {language === "zh" ? `${stepCount} 步` : `${stepCount} step${stepCount > 1 ? "s" : ""}`}
            </span>
          </span>
          <span className="mt-1 block whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--surface-text-subtle)]">{summary}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 px-1 py-1 text-[10px] text-[var(--surface-text-muted)] transition-colors group-hover:text-[var(--surface-text)]">
          {expanded ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
          {toggleText}
        </span>
      </button>
      {expanded && (
        <div data-testid="live-turn-process-details" className="space-y-2 px-2 pt-2">
          {model.steps.map((step) => (
            <TurnArchiveStepCard
              key={step.id}
              step={step}
              language={language}
              chatFontSize={chatFontSize}
              renderArchivedItem={renderLiveItem}
              onOpenDiff={onOpenDiff}
              variant="live"
            />
          ))}
          <button
            type="button"
            data-testid="live-turn-process-collapse-bottom"
            aria-expanded={expanded}
            onClick={() => setExpanded(false)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] text-[var(--surface-text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] hover:text-[var(--surface-text)]"
          >
            <IconChevronDown className="h-3.5 w-3.5" />
            {language === "zh" ? "收起步骤" : "Collapse steps"}
          </button>
        </div>
      )}
    </div>
  );
}

function AgentContentBlock({
  block,
  language,
  chatFontSize,
}: {
  block: any;
  language: "zh" | "en";
  chatFontSize: number;
}) {
  const rawContent = String(block.content || "");
  const displaySourceContent = useMemo(() => sanitizeAssistantDisplayContent(rawContent), [rawContent]);
  const previewLimit = block.streaming ? STREAMING_AGENT_CONTENT_PREVIEW_CHARS : AGENT_CONTENT_PREVIEW_CHARS;
  const isLongContent = displaySourceContent.length > previewLimit;
  const [showFullLongContent, setShowFullLongContent] = useState(false);
  const [isArchivedExpanded, setIsArchivedExpanded] = useState(false);
  const displayContent = getDisplayAgentContent(displaySourceContent, isLongContent && showFullLongContent && !block.streaming, previewLimit);
  const streamingText = block.streaming ? sanitizeVisibleAssistantText(displayContent.content) : "";
  const segments = useMemo(
    () => block.streaming ? [] : parseMessageContent(displayContent.content),
    [block.streaming, displayContent.content],
  );
  const hasVisibleContent =
    (block.streaming && streamingText.length > 0) ||
    segments.some((seg) => (seg.type === "text" ? sanitizeVisibleAssistantText(seg.content).length > 0 : true)) ||
    isLongContent;
  const archivedPreviewText = useMemo(() => segments
      .filter((seg) => seg.type === "text")
      .map((seg) => sanitizeVisibleAssistantText(seg.content))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    [segments],
  );

  if (!hasVisibleContent) return null;

  const previewCharCount = Math.min(displaySourceContent.length, previewLimit).toLocaleString();
  const totalCharCount = displaySourceContent.length.toLocaleString();
  const isArchivedAfterChoice = block.archivedAfterChoice && !block.streaming;
  const archivedTitle = language === "zh" ? "已保留上一步反馈" : "Previous reply kept";
  const archivedAction = language === "zh" ? "展开回看" : "Expand";
  const archivedCollapse = language === "zh" ? "收起反馈" : "Collapse";
  const selectedOptionText = String(block.selectedOption || "").trim();
  const archivedPreview = archivedPreviewText.length > 150
    ? `${archivedPreviewText.slice(0, 150).trim()}...`
    : archivedPreviewText;

  if (isArchivedAfterChoice && !isArchivedExpanded) {
    return (
      <div className="mt-4 flex w-full min-w-0 items-start justify-start gap-3">
        <div className="mt-1 flex-shrink-0">
          <IconLogoM className="theme-text h-6 w-6 drop-shadow-[0_0_8px_var(--accent-subtle)]" />
        </div>
        <button
          type="button"
          data-testid="archived-choice-feedback"
          onClick={() => setIsArchivedExpanded(true)}
          className="my-2 flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-[#1f1f23] bg-[#07070a] px-4 py-3 text-left transition-colors hover:border-[#34343b] hover:bg-[#09090b]"
        >
          <IconChevronRight className="h-4 w-4 shrink-0 text-[#71717a]" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-[#d4d4d8]">{archivedTitle}</span>
              {selectedOptionText && (
                <span className="max-w-full truncate rounded-full border border-[rgba(52,211,153,0.22)] bg-[rgba(52,211,153,0.08)] px-2 py-0.5 text-[10px] text-[#86efac] sm:max-w-[70%]">
                  {language === "zh" ? `已选择：${selectedOptionText}` : `Selected: ${selectedOptionText}`}
                </span>
              )}
            </span>
            {archivedPreview && (
              <span className="mt-1 block truncate text-[12px] leading-5 text-[#71717a]">{archivedPreview}</span>
            )}
          </span>
          <span data-testid="archived-choice-feedback-toggle" className="shrink-0 rounded-full border border-[#27272a] px-3 py-1 text-[11px] text-[#a1a1aa]">
            {archivedAction}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 flex w-full min-w-0 items-start justify-start gap-3">
      <div className="mt-1 flex-shrink-0">
        <IconLogoM className="theme-text h-6 w-6 drop-shadow-[0_0_8px_var(--accent-subtle)]" />
      </div>
      <div className="chat-agent-content my-1 min-w-0 flex-1 px-2 py-1 text-[#e4e4e7]" style={{ fontSize: `${chatFontSize}px` }}>
        {isArchivedAfterChoice && (
          <div data-testid="archived-choice-feedback-expanded" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#27272a] bg-[#050507] px-3 py-2">
            <div className="min-w-0 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-[#d4d4d8]">{archivedTitle}</span>
              {selectedOptionText && (
                <span className="max-w-full truncate rounded-full border border-[rgba(52,211,153,0.22)] bg-[rgba(52,211,153,0.08)] px-2 py-0.5 text-[10px] text-[#86efac]">
                  {language === "zh" ? `已选择：${selectedOptionText}` : `Selected: ${selectedOptionText}`}
                </span>
              )}
            </div>
            <button
              type="button"
              data-testid="archived-choice-feedback-toggle"
              onClick={() => setIsArchivedExpanded(false)}
              className="rounded-full border border-[#34343b] bg-[#09090b] px-3 py-1 text-[11px] text-[#d4d4d8] transition-colors hover:border-[var(--accent)] hover:text-white"
            >
              {archivedCollapse}
            </button>
          </div>
        )}
        {block.streaming ? (
          <div className="whitespace-pre-wrap break-words leading-relaxed text-[#e4e4e7]">
            {streamingText}
          </div>
        ) : (
          segments.map((seg, segIdx) => {
            if (seg.type === "thought") {
              return null;
            }
            if (seg.type === "plan") {
              return <JobListCard key={`${block.id}-plan-${segIdx}`} jobs={seg.jobs} />;
            }
            const cleanText = sanitizeVisibleAssistantText(seg.content);
            if (!cleanText) return null;
            return (
              <MarkdownRenderer
                key={`${block.id}-text-${segIdx}`}
                content={cleanText}
                baseFontSize={chatFontSize}
                sourceId={`agent-${block.id}-${segIdx}`}
              />
            );
          })
        )}
        {isLongContent && (
          <div className="mt-4 rounded-md border border-[#27272a] bg-[#050507] px-3 py-2 text-[12px] leading-5 text-[#a1a1aa]">
            <div>
              {language === "zh"
                ? showFullLongContent && !block.streaming
                  ? `已展开完整长内容，约 ${totalCharCount} 个字符。`
                  : `这条回复很长，聊天区先显示前 ${previewCharCount} 个字符；完整内容已保留，可在输出结束后展开查看，整轮也可以从标题处折叠收起。`
                : showFullLongContent && !block.streaming
                ? `Showing the full long reply, about ${totalCharCount} characters.`
                : `This reply is long, so the chat view is showing the first ${previewCharCount} characters. The full content is kept and can be expanded after streaming finishes; the whole turn can also be collapsed from its header.`}
            </div>
            <button
              type="button"
              onClick={() => setShowFullLongContent((value) => !value)}
              disabled={block.streaming}
              className="mt-2 rounded-full border border-[#34343b] bg-[#09090b] px-3 py-1 text-[11px] text-[#d4d4d8] transition-colors hover:border-[var(--accent)] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
            >
              {language === "zh"
                ? block.streaming
                  ? "输出结束后可展开"
                  : showFullLongContent
                  ? "收起为预览"
                  : "展开完整内容"
                : block.streaming
                ? "Available after streaming"
                : showFullLongContent
                ? "Collapse to preview"
                : "Expand full content"}
            </button>
          </div>
        )}
        {block.streaming && <StreamingCursor />}
      </div>
    </div>
  );
}

const RunStatusTimer = memo(function RunStatusTimer({
  activeSessionKey,
  isStreaming,
  label,
}: {
  activeSessionKey?: string | null;
  isStreaming: boolean;
  label: string;
}) {
  const storedElapsedTime = useAppStore((s) => {
    const runtimeElapsed = activeSessionKey
      ? s.runtimeBySessionKey?.[activeSessionKey]?.elapsedTime
      : undefined;
    return Math.max(0, Number(runtimeElapsed ?? s.elapsedTime ?? 0) || 0);
  });
  const [displayElapsedTime, setDisplayElapsedTime] = useState(storedElapsedTime);
  const elapsedBaseRef = useRef(storedElapsedTime);
  const elapsedSessionKeyRef = useRef(activeSessionKey ?? null);
  const wasStreamingRef = useRef(false);

  useEffect(() => {
    const nextSessionKey = activeSessionKey ?? null;
    if (elapsedSessionKeyRef.current === nextSessionKey) return;
    elapsedSessionKeyRef.current = nextSessionKey;
    elapsedBaseRef.current = storedElapsedTime;
    wasStreamingRef.current = false;
    setDisplayElapsedTime(storedElapsedTime);
  }, [activeSessionKey, storedElapsedTime]);

  useEffect(() => {
    elapsedBaseRef.current = Math.max(elapsedBaseRef.current, storedElapsedTime);
    setDisplayElapsedTime((current) => Math.max(current, storedElapsedTime));
  }, [storedElapsedTime]);

  useEffect(() => {
    if (!isStreaming) {
      wasStreamingRef.current = false;
      return;
    }

    const isNewRun = !wasStreamingRef.current && storedElapsedTime === 0;
    const baseElapsed = isNewRun ? 0 : Math.max(elapsedBaseRef.current, storedElapsedTime);
    wasStreamingRef.current = true;
    if (isNewRun) {
      elapsedBaseRef.current = 0;
      setDisplayElapsedTime(0);
    }
    const startedAt = Date.now();

    const tick = () => {
      const derivedElapsed = baseElapsed + Math.floor((Date.now() - startedAt) / 1000);
      elapsedBaseRef.current = Math.max(elapsedBaseRef.current, derivedElapsed);
      setDisplayElapsedTime((current) => Math.max(current, storedElapsedTime, derivedElapsed));
    };

    tick();
    const timerId = window.setInterval(tick, 250);
    return () => {
      window.clearInterval(timerId);
      tick();
    };
  }, [activeSessionKey, storedElapsedTime, isStreaming]);

  return (
    <div className="pointer-events-none flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[4px] border border-[#27272a] bg-[#09090b] px-2.5 py-1 text-[10px] font-medium text-[#a1a1aa]" style={{ height: 28 }}>
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_5px_#fbbf24] animate-pulse" />
      {label} {Math.floor(displayElapsedTime / 60)}m{displayElapsedTime % 60}s
    </div>
  );
});

export default function ChatArea({
  taskFlow,
  t,
  config,
  setSettingsTab,
  setIsSettingsOpen,
  activeDiffTask,
  endOfFlowRef,
  isStreaming,
  activeSessionKey,
  onStopGeneration,
  onLoadOlderSessionHistory,
  allowToolAction,
  rejectToolAction,
  autoApproveTools,
  onToggleAutoApprove,
  contextMentions,
  setContextMentions,
  attachedFiles,
  setAttachedFiles,
  onAttachFile,
  showAgentPicker,
  setShowAgentPicker,
  selectedMainModeKey,
  setSelectedMainModeKey,
  mainModes,
  activeStudioAgentKey,
  setActiveStudioAgentKey,
  gameStudioInitialized,
  initializeGameStudioWorkspace,
  removeGameStudioWorkspace,
  currentWorkspace,
  handleAcceptInline,
  handleRejectInline,
  onSendMessage,
  onQuickReply,
}) {
  const language = config.language === "en" ? "en" : "zh";
  const resolvedChatFontSize = Math.min(20, Math.max(10, Number(config.chatFontSize) || 13));
  const resolvedTurnProcessFontSize = resolveTurnProcessFontSize(resolvedChatFontSize);
  const copy = useMemo(() => ({
    planLabel: language === "zh" ? "计划" : "Plan",
    stopLabel: language === "zh" ? "停止" : "Stop",
    processingLabel: language === "zh" ? "处理中..." : "Processing...",
    currentView: language === "zh" ? "当前查看" : "Viewing",
    turnDetails: language === "zh" ? "回合详情" : "Turn Details",
    openPlan: language === "zh" ? "打开计划" : "Open Plan",
    viewPlan: language === "zh" ? "查看计划" : "View Plan",
    summary: language === "zh" ? "总结" : "Summary",
    collapsedSummary: language === "zh" ? "本轮过程已折叠，结论会优先保留在这里。" : "This turn is collapsed. The conclusion is kept here first.",
    expandHistory: (count: number) => language === "zh" ? `展开 ${count} 条过程记录` : `Expand ${count} process item(s)`,
    turnStatusLabels: language === "zh"
      ? { planning: "规划中", awaiting_approval: "待批准", awaiting_input: "待选择", executing: "执行中", completed_with_changes: "已完成并写入", stopped_no_action: "已停止，未执行", stopped_no_output: "未生成可见回复", paused: "已暂停", done: "完成", error: "错误" }
      : TURN_STATUS_LABELS,
    describePlan: (prompt: string, maxLength = 40) =>
      summarizePlanIntent(prompt, maxLength, language),
    planGenerating: (prompt: string) =>
      language === "zh"
        ? `正在根据你的需求整理计划：${summarizePlanIntent(prompt, 28)}`
        : `Building the plan for: ${prompt.replace(/\s+/g, " ").trim().slice(0, 28)}`,
    planReady: language === "zh" ? "计划已进入当前回合，可点击查看。" : "The plan is attached to this turn and ready to open.",
    generating: language === "zh" ? "生成中" : "Generating",
    modelUnselected: language === "zh" ? "未选择模型" : "No model selected",
    cloudLabel: language === "zh" ? "云端" : "Cloud",
  }), [language]);
  const activeCloudServer = useMemo(() => {
    const servers = Array.isArray(config.cloudServers) ? config.cloudServers : [];
    return servers.find((server: any) => server.id === config.activeCloudServerId) || servers[0] || null;
  }, [config.activeCloudServerId, config.cloudServers]);
  const activeCloudServerName = typeof activeCloudServer?.name === "string" ? activeCloudServer.name.trim() : "";
  const activeCloudModel = (
    typeof activeCloudServer?.model === "string" && activeCloudServer.model.trim()
      ? activeCloudServer.model
      : config.cloud.model
  ) || "";
  const {
    showDiff,
    showPlanPanel,
    showTerminal,
    showFilePanel,
    rightPanelTab,
    runtimeEvents,
    openRightPanelTab,
    openFileTreePanel,
    openDiffForTask,
    closeRightPanel,
    closeFilePanel,
    setShowDiff,
    setShowTerminal,
    conversationTurns,
    currentTurnId,
    toggleConversationTurnCollapsed,
    planArtifacts,
    planTasks,
    planExecutionEvidenceLedger,
    isPlanApproved,
    planStage,
    planExecutionProgressSnapshot,
    approvePlan,
    approvePendingReviewOnce,
    approvePendingReviewForSession,
    rejectPlan,
    rejectPlanAndDeleteFiles,
    agentStatus,
    pendingRunDecision,
    resolvePendingRunDecision,
    dismissPendingRunDecision,
  } = {
    showDiff: useAppStore((s) => s.showDiff),
    showPlanPanel: useAppStore((s) => s.showPlanPanel),
    showTerminal: useAppStore((s) => s.showTerminal),
    showFilePanel: useAppStore((s) => s.showFilePanel),
    rightPanelTab: useAppStore((s) => s.rightPanelTab),
    runtimeEvents: useAppStore((s) => s.runtimeEvents),
    openRightPanelTab: useAppStore((s) => s.openRightPanelTab),
    openFileTreePanel: useAppStore((s) => s.openFileTreePanel),
    openDiffForTask: useAppStore((s) => s.openDiffForTask),
    closeRightPanel: useAppStore((s) => s.closeRightPanel),
    closeFilePanel: useAppStore((s) => s.closeFilePanel),
    setShowDiff: useAppStore((s) => s.setShowDiff),
    setShowTerminal: useAppStore((s) => s.setShowTerminal),
    conversationTurns: useAppStore((s) => s.conversationTurns),
    currentTurnId: useAppStore((s) => s.currentTurnId),
    toggleConversationTurnCollapsed: useAppStore((s) => s.toggleConversationTurnCollapsed),
    planArtifacts: useAppStore((s) => s.planArtifacts),
    planTasks: useAppStore((s) => s.planTasks),
    planExecutionEvidenceLedger: useAppStore((s) => s.planExecutionEvidenceLedger),
    isPlanApproved: useAppStore((s) => s.isPlanApproved),
    planStage: useAppStore((s) => s.planStage),
    planExecutionProgressSnapshot: useAppStore((s) => s.planExecutionProgressSnapshot),
    approvePlan: useAppStore((s) => s.approvePlan),
    approvePendingReviewOnce: useAppStore((s) => s.approvePendingReviewOnce),
    approvePendingReviewForSession: useAppStore((s) => s.approvePendingReviewForSession),
    rejectPlan: useAppStore((s) => s.rejectPlan),
    rejectPlanAndDeleteFiles: useAppStore((s) => s.rejectPlanAndDeleteFiles),
    agentStatus: useAppStore((s) => s.agentStatus),
    pendingRunDecision: useAppStore((s) => s.pendingRunDecision),
    resolvePendingRunDecision: useAppStore((s) => s.resolvePendingRunDecision),
    dismissPendingRunDecision: useAppStore((s) => s.dismissPendingRunDecision),
  };
  const isGlobalChat = !currentWorkspace;
  const emptyStatePrompts = language === "zh"
    ? [
        "总结这个文件夹里的内容",
        "分析这些表格并生成报告",
        "提炼这批资料的关键结论",
        "先给我一个计划再执行",
      ]
    : [
        "Summarize the contents of this folder",
        "Analyze these tables and generate a report",
        "Extract the key conclusions from these materials",
        "Give me a plan first before execution",
      ];

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const turnRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const lastScrollTopRef = useRef(0);
  const previousSessionKeyRef = useRef(activeSessionKey ?? null);
  const previousFirstTurnIdRef = useRef<string | null>(null);
  const historyPeekHideTimerRef = useRef<number | null>(null);
  const topIslandHideTimerRef = useRef<number | null>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [activeVisibleTurnId, setActiveVisibleTurnId] = useState<string | null>(null);
  const [showTopIslandDuringHistoryPeek, setShowTopIslandDuringHistoryPeek] = useState(false);
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false);
  // region: 浮层显隐状态
  const [composerHeight, setComposerHeight] = useState(220);
  const [shouldRenderTopIsland, setShouldRenderTopIsland] = useState(false);
  const [isTopIslandVisible, setIsTopIslandVisible] = useState(false);
  const [previewImageItem, setPreviewImageItem] = useState<UserContextItem | null>(null);
  // endregion

  useEffect(() => {
    return () => {
      if (historyPeekHideTimerRef.current !== null) {
        window.clearTimeout(historyPeekHideTimerRef.current);
      }
    };
  }, []);

  const blocksByTurnId = useMemo(() => {
    const next = new Map<string, any[]>();
    const legacyBlocks: any[] = [];
    for (const block of taskFlow) {
      const turnId = block?.turnId;
      if (!turnId) {
        legacyBlocks.push(block);
        continue;
      }
      const existing = next.get(turnId);
      if (existing) {
        existing.push(block);
      } else {
        next.set(turnId, [block]);
      }
    }
    return { byTurnId: next, legacyBlocks };
  }, [taskFlow]);
  const visibleConversationTurns = useMemo(
    () => conversationTurns.filter((turn) => turn?.uiVisibility !== "internal"),
    [conversationTurns],
  );

  const groupedTurns = useMemo(() => {
    if (visibleConversationTurns.length === 0) {
      return blocksByTurnId.legacyBlocks.length > 0
        ? [{ turn: null, blocks: blocksByTurnId.legacyBlocks }]
        : [];
    }

    return visibleConversationTurns.map((turn) => ({
      turn,
      blocks: blocksByTurnId.byTurnId.get(turn.id) || [],
    }));
  }, [blocksByTurnId, visibleConversationTurns]);

  useEffect(() => {
    const nextSessionKey = activeSessionKey ?? null;
    const firstTurnId = visibleConversationTurns[0]?.id ?? null;
    const sessionChanged = previousSessionKeyRef.current !== nextSessionKey;
    const replacedHistory = previousFirstTurnIdRef.current !== firstTurnId;
    previousSessionKeyRef.current = nextSessionKey;
    previousFirstTurnIdRef.current = firstTurnId;
    if (!sessionChanged && !replacedHistory) return;

    setIsAutoScroll(true);
    setActiveVisibleTurnId(visibleConversationTurns[visibleConversationTurns.length - 1]?.id ?? null);
    setShowTopIslandDuringHistoryPeek(false);
    const rafId = window.requestAnimationFrame(() => {
      const el = chatContainerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [activeSessionKey, visibleConversationTurns]);

  const activeTurn = useMemo(() => {
    return resolveActiveConversationTurn(visibleConversationTurns, activeVisibleTurnId, isAutoScroll);
  }, [activeVisibleTurnId, visibleConversationTurns, isAutoScroll]);
  const pinnedTurn = useMemo(() => {
    return resolvePinnedConversationTurn(visibleConversationTurns, currentTurnId);
  }, [visibleConversationTurns, currentTurnId]);
  const shouldKeepTopIslandResident =
    !!pinnedTurn &&
    (
      pinnedTurn.status === "executing" ||
      pinnedTurn.status === "awaiting_input" ||
      pinnedTurn.status === "awaiting_approval" ||
      agentStatus === "pending_review"
    );
  const topIslandTurn = shouldKeepTopIslandResident ? pinnedTurn : activeTurn;
  const topIslandTurnEntry = useMemo(() => {
    if (!topIslandTurn) return null;
    return groupedTurns.find((entry) => entry.turn?.id === topIslandTurn.id) || null;
  }, [groupedTurns, topIslandTurn]);
  const topIslandTurnBlocks = topIslandTurnEntry?.blocks || [];
  const pinnedPlanTurn = pinnedTurn && isPlanConversationTurn(pinnedTurn)
    ? pinnedTurn
    : null;
  const topIslandTurnVisibleStatus = useMemo(() => {
    if (!topIslandTurn) return null;

    return deriveVisibleConversationTurnStatus({
      baseStatus: topIslandTurn.status,
      turnIntent: resolveConversationTurnIntent(topIslandTurn),
      isPinnedPlanTurnVisible: !!pinnedPlanTurn && topIslandTurn.id === pinnedPlanTurn.id,
      isPlanApproved,
      planStage,
      agentStatus,
      hasIncompletePlanTasks: !buildPlanTaskEvidenceAudit({ tasks: planTasks, evidenceLedger: planExecutionEvidenceLedger }).allTrustedComplete,
      hasTasksArtifact:
        planArtifacts.some((artifact) => artifact.kind === "tasks") ||
        planTasks.length > 0,
    });
  }, [agentStatus, isPlanApproved, pinnedPlanTurn, planArtifacts, planExecutionEvidenceLedger, planStage, planTasks, topIslandTurn]);
  const shouldShowPinnedPlanTasks =
    !!pinnedPlanTurn &&
    (isPlanApproved || planStage === "executing" || planStage === "completed");
  const topIslandExecutionSteps = useMemo(() => {
    if (!topIslandTurn) return [];
    if (isPlanConversationTurn(topIslandTurn)) return [];
    return deriveTurnProgressItems(topIslandTurnBlocks, language);
  }, [language, topIslandTurn, topIslandTurnBlocks]);
  const composerPaddingBottom = composerHeight + 32;
  const hasPlanPanelContent = useMemo(() => {
    if (planArtifacts.length > 0) return true;

    return groupedTurns.some((entry) => {
      if (!entry.turn || !isPlanConversationTurn(entry.turn)) return false;
      return hasGeneratedPlanContent(entry.blocks);
    });
  }, [groupedTurns, planArtifacts]);
  const canApprovePlan =
    !!pinnedPlanTurn &&
    !isPlanApproved &&
    hasPlanPanelContent &&
    (
      agentStatus === "pending_review" ||
      pinnedPlanTurn?.status === "awaiting_approval" ||
      planStage === "ready_to_execute"
    );
  const topIslandReplyOptions = useMemo(() => {
    const latestOptionBlock = [...topIslandTurnBlocks].reverse().find((block) =>
      block.type === "agent" &&
      Array.isArray(block.options) &&
      block.options.length > 0,
    );
    return latestOptionBlock?.options || [];
  }, [topIslandTurnBlocks]);
  const topIslandTurnStatusKey = topIslandTurnVisibleStatus || topIslandTurn?.status || null;
  const topIslandIsRunActive =
    agentStatus === "running" &&
    !!topIslandTurn &&
    topIslandTurnStatusKey === "executing";
  const isAwaitingInteractiveChoice =
    (topIslandTurnStatusKey === "awaiting_input" || topIslandTurnStatusKey === "awaiting_approval") &&
    topIslandReplyOptions.length > 0;
  const shouldShowRunStatus = isStreaming || isAwaitingInteractiveChoice;
  const runStatusLabel = isStreaming
    ? copy.processingLabel
    : language === "zh" ? "等待选择..." : "Awaiting choice...";
  const topIslandHasChoiceContext =
    topIslandReplyOptions.length > 0 ||
    !!pendingRunDecision ||
    topIslandTurnStatusKey === "awaiting_input" ||
    topIslandTurnStatusKey === "awaiting_approval" ||
    !!activeDiffTask ||
    canApprovePlan;
  const topIslandHasProgressContext =
    planTasks.length > 0 ||
    topIslandExecutionSteps.length > 0;
  const shouldShowTopIslandNormally =
    !!topIslandTurn &&
    topIslandTurnStatusKey !== "done" &&
    topIslandTurnStatusKey !== "completed_with_changes" &&
    (topIslandHasChoiceContext || topIslandHasProgressContext);
  const shouldShowTopIslandForHistoryPeek =
    showTopIslandDuringHistoryPeek && shouldShowTopIslandNormally;
  const shouldShowTopIsland =
    (!!topIslandTurn || !!pendingRunDecision) &&
    (
      topIslandHasChoiceContext ||
      (topIslandHasProgressContext && shouldKeepTopIslandResident) ||
      (isAutoScroll
        ? shouldShowTopIslandNormally
        : shouldShowTopIslandForHistoryPeek)
    );
  useEffect(() => {
    if (topIslandHideTimerRef.current !== null) {
      window.clearTimeout(topIslandHideTimerRef.current);
      topIslandHideTimerRef.current = null;
    }

    if (shouldShowTopIsland) {
      setShouldRenderTopIsland(true);
      const rafId = window.requestAnimationFrame(() => {
        setIsTopIslandVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    setIsTopIslandVisible(false);
    topIslandHideTimerRef.current = window.setTimeout(() => {
      topIslandHideTimerRef.current = null;
      setShouldRenderTopIsland(false);
    }, 240);

    return () => {
      if (topIslandHideTimerRef.current !== null) {
        window.clearTimeout(topIslandHideTimerRef.current);
        topIslandHideTimerRef.current = null;
      }
    };
  }, [shouldShowTopIsland]);

  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current;
    if (!el) return;

    const currentScrollTop = el.scrollTop;
    const nextAutoScroll = resolveAutoScrollState({
      scrollTop: currentScrollTop,
      previousScrollTop: lastScrollTopRef.current,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });

    if (nextAutoScroll) {
      if (historyPeekHideTimerRef.current !== null) {
        window.clearTimeout(historyPeekHideTimerRef.current);
        historyPeekHideTimerRef.current = null;
      }
      setShowTopIslandDuringHistoryPeek(false);
    } else {
      setShowTopIslandDuringHistoryPeek(true);
      if (historyPeekHideTimerRef.current !== null) {
        window.clearTimeout(historyPeekHideTimerRef.current);
      }
      historyPeekHideTimerRef.current = window.setTimeout(() => {
        historyPeekHideTimerRef.current = null;
        setShowTopIslandDuringHistoryPeek(false);
      }, 3000);
    }

    setIsAutoScroll((value) => (value === nextAutoScroll ? value : nextAutoScroll));
    lastScrollTopRef.current = currentScrollTop;

    const turnEntries = groupedTurns
      .map((entry) => {
        const turnId = entry.turn?.id;
        if (!turnId) return null;
        const node = turnRefs.current[turnId];
        if (!node) return null;
        return { turnId, offset: node.offsetTop };
      })
      .filter(Boolean) as Array<{ turnId: string; offset: number }>;

    const current = [...turnEntries].reverse().find((entry) => entry.offset <= el.scrollTop + 120);
    setActiveVisibleTurnId(current?.turnId || visibleConversationTurns[visibleConversationTurns.length - 1]?.id || null);
  }, [groupedTurns, visibleConversationTurns]);

  useEffect(() => {
    if (!isAutoScroll) return;

    const el = chatContainerRef.current;
    if (!el) return;

    el.scrollTo({
      top: el.scrollHeight,
      behavior: isStreaming ? "auto" : "smooth",
    });

    const rafId = window.requestAnimationFrame(() => {
      lastScrollTopRef.current = el.scrollTop;
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [taskFlow, isAutoScroll, isStreaming]);

  const togglePanelTab = useCallback((tab: "plan" | "diff" | "terminal" | "file") => {
    const isCurrentlyOpen =
      (tab === "plan" && showPlanPanel && rightPanelTab === "plan") ||
      (tab === "diff" && showDiff && rightPanelTab === "diff") ||
      (tab === "terminal" && showTerminal && rightPanelTab === "terminal") ||
      (tab === "file" && showFilePanel);

    if (isCurrentlyOpen) {
      if (tab === "file") {
        closeFilePanel();
        return;
      }
      closeRightPanel();
      return;
    }

    if (tab === "plan" && !hasPlanPanelContent) return;
    if (tab === "file") {
      if (!currentWorkspace) return;
      openFileTreePanel();
      return;
    }
    openRightPanelTab(tab);
  }, [closeFilePanel, closeRightPanel, currentWorkspace, hasPlanPanelContent, openFileTreePanel, openRightPanelTab, rightPanelTab, showDiff, showFilePanel, showPlanPanel, showTerminal]);

  const renderBlock = (block, index) => {
    if (block.type === "user") {
      const existingContextItems = Array.isArray(block.contextItems) ? block.contextItems : [];
      const hasImageContextItem = existingContextItems.some((item: UserContextItem) => item.kind === "image");
      const legacyImageItems = !hasImageContextItem && Array.isArray(block.images)
        ? block.images.map((dataUrl: string, imgIdx: number) => ({
            id: `legacy-image:${block.id}:${imgIdx}`,
            kind: "image",
            label: language === "en" ? `Image ${imgIdx + 1}` : `截图 ${imgIdx + 1}`,
            status: "ready",
            previewDataUrl: dataUrl,
          }))
        : [];
      const userContextItems = [...existingContextItems, ...legacyImageItems];
      return (
        <div key={`${block.id}-${index}`} className="flex w-full justify-end">
          <div className="theme-subtle-bg theme-subtle-border max-w-[85%] rounded-2xl rounded-tr-sm border p-4">
            {block.content && (
              <div
                data-testid="user-message-content"
                className="whitespace-pre-wrap break-words leading-relaxed text-[#e4e4e7]"
                style={{
                  fontSize: `${resolvedChatFontSize}px`,
                  lineHeight: `${Math.max(22, Math.round(resolvedChatFontSize * 1.7))}px`,
                }}
              >
                {block.content}
              </div>
            )}
            <UserContextPillRow
              items={userContextItems}
              language={language}
              onPreviewImage={setPreviewImageItem}
            />
          </div>
        </div>
      );
    }

    if (block.type === "system") {
      if (block.variant === "context_compression") {
        return <ContextCompressionNotice key={`${block.id}-${index}`} block={block} language={language} />;
      }
      if (block.variant === "plan_execution_progress") {
        return null;
      }
      if (block.variant === "plan_execution_checkpoint") {
        return <PlanExecutionSystemNotice key={`${block.id}-${index}`} block={block} language={language} />;
      }
      if (block.variant === "game_studio_local_markdown") {
        return (
          <div key={`${block.id}-${index}`} className="mt-4 flex w-full min-w-0 items-start justify-start gap-3">
            <div className="mt-1 flex-shrink-0">
              <IconLogoM className="theme-text h-6 w-6 drop-shadow-[0_0_8px_var(--accent-subtle)]" />
            </div>
            <div
              data-testid="game-studio-local-markdown"
              className="min-w-0 flex-1 rounded-lg border border-[#1f1f23] bg-[#09090b] px-4 py-4 text-[#e4e4e7]"
            >
              <MarkdownRenderer
                content={block.content}
                baseFontSize={resolvedChatFontSize}
                sourceId={`system-${block.id}`}
              />
            </div>
          </div>
        );
      }
      return (
        <div key={`${block.id}-${index}`} className="flex w-full justify-center">
          <div className="rounded-full border border-[#27272a] bg-[#18181b] px-4 py-1.5 text-[11px] text-[#a1a1aa]">{block.content}</div>
        </div>
      );
    }

    if (block.type === "thought") {
      return (
        <ThoughtBlock
          key={`${block.id}-${index}`}
          block={block}
          language={language}
          chatFontSize={resolvedChatFontSize}
        />
      );
    }

    if (block.type === "progress") {
      return null;
    }

    if (block.type === "jobList") {
      return (
        <div key={`${block.id}-${index}`} className="flex w-full justify-start">
          <JobListCard jobs={block.jobs} />
        </div>
      );
    }

    if (block.type === "tool") {
      const shouldHidePendingTool =
        block.toolStatus === "pending" &&
        (block.toolName === "write_file" || block.toolName === "replace_in_file" || block.toolName === "apply_patch");
      if (shouldHidePendingTool) return null;
      if (
        (block.toolName === "write_file" || block.toolName === "replace_in_file" || block.toolName === "apply_patch") &&
        isEphemeralPlanArtifactPath(block.target)
      ) {
        return null;
      }
      const autoCollapse = index < taskFlow.length - 1 && taskFlow.findIndex((t, i) => i > index && t.type === "agent") !== -1;
      return (
        <div key={`${block.id}-${index}`} className="flex w-full justify-start">
          <ActionCard
            blockId={block.id}
            toolName={block.toolName}
            target={block.target}
            toolStatus={block.toolStatus}
            message={block.message}
            diff={block.diff}
            shellPermissionDecision={block.shellPermissionDecision}
            intentSummary={block.intentSummary}
            why={block.why}
            evidence={block.evidence}
            observationSummary={block.observationSummary}
            onAllow={() => allowToolAction?.(block.id)}
            onAllowForSession={() => approvePendingReviewForSession?.()}
            onReject={() => rejectToolAction?.(block.id)}
            autoApproveTools={autoApproveTools}
            onToggleAutoApprove={onToggleAutoApprove}
            autoCollapse={autoCollapse}
          />
        </div>
      );
    }

    if (block.type === "agent") {
      if (block.hiddenProcess && !block.streaming) return null;
      return (
          <AgentContentBlock
          key={`${block.id}-${index}`}
          block={block}
          language={language}
          chatFontSize={resolvedChatFontSize}
        />
      );
    }

    return null;
  };

  const renderBlockItem = (item) => {
    if (item.kind === "operationCluster") {
      return (
        <ChatOperationClusterBlock
          key={item.cluster.id}
          cluster={item.cluster}
          language={language}
        />
      );
    }
    if (item.kind === "readContextGroup") {
      const firstId = item.blocks[0]?.id ?? item.index;
      const lastId = item.blocks[item.blocks.length - 1]?.id ?? item.index;
      return (
        <ReadContextGroupCard
          key={`read-context-${firstId}-${lastId}`}
          blocks={item.blocks}
          language={language}
        />
      );
    }
    if (item.kind === "completedToolGroup") {
      const firstId = item.blocks[0]?.id ?? item.index;
      const lastId = item.blocks[item.blocks.length - 1]?.id ?? item.index;
      return (
        <CompletedToolGroupCard
          key={`completed-tool-group-${firstId}-${lastId}`}
          blocks={item.blocks}
          language={language}
        />
      );
    }

    return renderBlock(item.block, item.index);
  };

  const renderTurn = (entry, index: number) => {
    if (!entry.turn) {
      return (
        <div key={`legacy-${index}`} className="space-y-4">
          {buildBlockRenderItems(entry.blocks, true, false, language).map(renderBlockItem)}
        </div>
      );
    }

    const turn: ConversationTurn = entry.turn;
    const blocks = entry.blocks;
    const turnIntent = resolveConversationTurnIntent(turn);
    const displayTurnIntent = turn.displayIntent || turnIntent;
    const turnIntentPolicy = getIntentPolicy(displayTurnIntent);
    const turnIntentLabel = turnIntentPolicy.intent === displayTurnIntent
      ? (language === "en" ? turnIntentPolicy.label.en : turnIntentPolicy.label.zh)
      : (language === "zh" ? "任务" : "Task");
    const isPlanTurn = turnIntent === "plan";
    const turnProgressSnapshot =
      planExecutionProgressSnapshot?.turnId === turn.id
        ? planExecutionProgressSnapshot
        : blocks
            .map((block) => block.type === "system" ? block.planExecutionProgress : null)
            .filter(Boolean)
            .slice(-1)[0] || null;
    const isPlanExecutionVisible =
      isPlanTurn &&
      !!turnProgressSnapshot &&
      (
        isPlanApproved ||
        planStage === "executing" ||
        turn.status === "executing" ||
        turn.status === "stopped_no_action" ||
        turn.status === "error"
      );
    const enableCompletedToolGrouping = shouldGroupPlanExecutionTools({
      turnIntent,
      isPlanTurn,
      isPlanApproved,
      planStage,
      turnStatus: turn.status,
      isPlanExecutionVisible,
    });
    const forceExpandedTurn =
      turn.status === "awaiting_input" ||
      turn.status === "awaiting_approval";
    const isTurnExpanded = !turn.collapsed || forceExpandedTurn;
    const userBlock = blocks.find((block) => block.type === "user");
    const hiddenCount = blocks.filter((block) => block.type !== "user").length;
    const { entries: turnChangeEntries, totalExecutedEdits } = collectTurnChangeEntries(blocks);
    const shouldShowTurnChanges = turnChangeEntries.length > 0 || totalExecutedEdits > 0;
    const shouldPreservePlanExecutionAgentText = isPlanTurn && isPlanExecutionVisible;
    const finalVisibleAgentIndex = isPlanTurn && !shouldPreservePlanExecutionAgentText
      ? -1
      : [...blocks]
          .map((block, idx) => ({ block, idx }))
          .reverse()
          .find(({ block }) => !block.hiddenProcess && hasRenderableAgentBlock(block))?.idx ?? -1;
    const finalVisibleAgentBlock = finalVisibleAgentIndex >= 0 ? blocks[finalVisibleAgentIndex] : null;
    const isFinishedTurn = isFinishedTurnStatus(turn.status);
    const showReasoningDebug = config.reasoningDisplay !== "hidden";
    const shouldRenderLiveProcessTimeline =
      turnIntent === "studio_workflow" ||
      selectedMainModeKey === "game_studio";
    const shouldRenderCompletedProcessArchive = shouldRenderLiveProcessTimeline;
    const shouldArchiveCompletedProcess =
      shouldRenderCompletedProcessArchive &&
      isFinishedTurn &&
      finalVisibleAgentIndex >= 0;
    const processArchive = shouldArchiveCompletedProcess
      ? buildTurnProcessArchiveModel({
          blocks,
          finalVisibleAgentIndex,
          language,
          includeThoughts: false,
          includeThoughtNotes: true,
        })
      : null;
    const collapsedProcessCount = finalVisibleAgentBlock
      ? processArchive?.stepCount ?? blocks.filter((block, idx) => block.type !== "user" && idx !== finalVisibleAgentIndex).length
      : hiddenCount + (shouldShowTurnChanges ? 1 : 0);
    const hasPlanContent = isPlanTurn && hasGeneratedPlanContent(blocks);
    // Only show the PlanShortcutCard when the plan is truly complete — not
    // while it's still being generated. The card replaces all detailed blocks,
    // so it must only appear once the model has finished working on this turn.
    const planTurnFinished =
      turn.status === "done" ||
      turn.status === "completed_with_changes" ||
      turn.status === "awaiting_approval" ||
      isPlanApproved;
    const hasCompletePlan = hasPlanContent && planTurnFinished;
    const planShortcutVisible = shouldPlanShortcutReplaceTurn({ isPlanTurn, hasCompletePlan, isPlanExecutionVisible }) ||
      (isPlanExecutionVisible && hasCompletePlan);
    const finalAgentSummaryText = getLastAgentSummaryText(blocks);
    const planProgressSummary = turnProgressSnapshot
      ? summarizePlanExecutionProgressSnapshot(turnProgressSnapshot, language)
      : "";
    const toolExecutionSummary = buildToolExecutionSummary(blocks, language);
    const effectiveProgressLedger = buildRuntimeProgressLedger({
      blocks,
      events: runtimeEvents,
      turnId: turn.id,
      language,
      maxItems: 12,
    });
    const effectiveProgressSummary = summarizeRuntimeProgressLedger(effectiveProgressLedger, language);
    const activeTurnActivity = getActiveTurnActivity(blocks, turn.status, language);
    const liveProcessTimeline = !shouldArchiveCompletedProcess && shouldRenderLiveProcessTimeline
      ? buildLiveTurnProcessTimelineModel({ blocks, language, includeThoughts: showReasoningDebug })
      : null;
    const liveProcessBlockIds = new Set(
      (liveProcessTimeline?.blocks || [])
        .map((block: any) => block?.id)
        .filter((id: any) => id !== undefined && id !== null),
    );
    const thoughtSummaryCache = new Map<string, string>();
    const getThoughtSummaryText = (thoughtBlock: any) => {
      const cacheKey = String(thoughtBlock?.id ?? "");
      if (thoughtSummaryCache.has(cacheKey)) {
        return thoughtSummaryCache.get(cacheKey) || "";
      }
      const summary = deriveThoughtDisplay(String(thoughtBlock?.content || ""), {
        language,
        mode: "latest",
        density: "adaptive",
      }).summaryText;
      thoughtSummaryCache.set(cacheKey, summary);
      return summary;
    };
    const latestThoughtBlock = getLatestThoughtBlock(blocks);
    const bottomThoughtSummary =
      showReasoningDebug && turn.status !== "error" && latestThoughtBlock?.isStreaming
        ? (() => {
            const summary = getThoughtSummaryText(latestThoughtBlock);
            return liveTimelineContainsProcessText(liveProcessTimeline, summary) ? "" : summary;
          })()
        : "";
    const isBottomThoughtStreaming = !!latestThoughtBlock?.isStreaming;
    const renderTurnBlockItem = (item) => {
      if (item.kind !== "readContextGroup" && item.kind !== "operationCluster" && item.block?.type === "thought") return null;
      if (item.kind === "block" && isTransparentToolNarrationBlock(item.block)) {
        const hasPriorVisibleAgentNarrative = blocks.some((candidate, candidateIndex) =>
          candidateIndex < item.index &&
          candidate?.type === "agent" &&
          !candidate.hiddenProcess &&
          hasRenderableAgentBlock(candidate)
        );
        if (hasPriorVisibleAgentNarrative) return null;
      }
      if (item.kind === "block" && shouldSuppressAgentToolEcho(blocks, item.index)) return null;

      return renderBlockItem(item);
    };
    const renderArchivedBlockItem = (item) => {
      if (item.kind !== "readContextGroup" && item.kind !== "operationCluster" && item.block?.type === "thought") return null;
      if (item.kind === "block" && isTransparentToolNarrationBlock(item.block)) return null;
      return renderBlockItem(item);
    };
    const isLiveProcessRenderItem = (item) => {
      if (item.kind === "operationCluster") {
        return item.cluster.blocks.every((block: any) => liveProcessBlockIds.has(block?.id));
      }
      if (item.kind === "readContextGroup") {
        return false;
      }
      if (item.kind === "completedToolGroup") {
        return item.blocks.every((block: any) => liveProcessBlockIds.has(block?.id));
      }
      return liveProcessBlockIds.has(item.block?.id);
    };
    const renderLiveRemainderItem = (item) => {
      if (isLiveProcessRenderItem(item)) return null;
      return renderTurnBlockItem(item);
    };
    const displayTitleFallback = turn.userPrompt
      ? normalizeConversationDisplayTitle(
          turn.userPrompt,
          language === "en" ? 48 : 40,
          language === "en" ? "New task" : "新的任务",
        )
      : language === "en" ? "New task" : "新的任务";
    const intentSummaryTitle = String(turn.intentSummary || "").trim();
    const explicitTurnTitle = !isGenericConversationTitle(turn.title) ? turn.title : "";
    const displayTurnTitle = normalizeConversationDisplayTitle(
      intentSummaryTitle || explicitTurnTitle,
      language === "en" ? 48 : 40,
      displayTitleFallback,
    );
    const isLightThemeMode = config.themeMode === "light";
    const isBlackThemeMode = config.themeMode === "black";
    const turnShellClass = isTurnExpanded
      ? ""
      : isLightThemeMode
      ? "rounded-2xl border border-[#d4d4d8] bg-[#ffffff]"
      : "rounded-2xl border border-[#1f1f23] bg-[#09090b]";
    const turnHeaderClass = isTurnExpanded
      ? isLightThemeMode
        ? "rounded-xl border border-[#d4d4d8] bg-transparent hover:border-[#cbd5e1] hover:bg-[#f5f5f6]"
        : "rounded-xl border border-[#1f1f23] bg-transparent hover:border-[#2f2f36] hover:bg-[#070709]/35"
      : isLightThemeMode
      ? "rounded-t-2xl border-b border-[#e4e4e7] hover:bg-[color-mix(in_srgb,var(--accent)_16%,#ffffff_84%)]"
      : "rounded-t-2xl border-b border-[#1f1f23] hover:bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]";
    const collapsedTurnHeaderStyle = !isTurnExpanded
      ? isLightThemeMode
        ? {
            backgroundColor: "color-mix(in srgb, var(--accent) 12%, #ffffff 88%)",
            borderBottomColor: "color-mix(in srgb, var(--accent) 28%, #e5e7eb 72%)",
          }
        : isBlackThemeMode
        ? {
            backgroundColor: "color-mix(in srgb, var(--accent) 14%, #000000 86%)",
            borderBottomColor: "color-mix(in srgb, var(--accent-light) 30%, #202026 70%)",
          }
        : {
            backgroundColor: "color-mix(in srgb, var(--accent) 14%, #09090b 86%)",
            borderBottomColor: "color-mix(in srgb, var(--accent-light) 28%, #27272a 72%)",
          }
      : undefined;
    const turnTitleClass = isLightThemeMode ? "text-[#111827]" : "text-[#f5f5f5]";
    const turnChevronClass = isLightThemeMode ? "text-[#6b7280]" : "text-[#71717a]";

    return (
      <section
        key={turn.id}
        ref={(node) => {
          turnRefs.current[turn.id] = node;
        }}
        className="py-3"
      >
        <div className={turnShellClass}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => toggleConversationTurnCollapsed(turn.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleConversationTurnCollapsed(turn.id);
              }
            }}
            className={`flex w-full items-center justify-between gap-4 px-3 py-2 text-left transition-colors ${turnHeaderClass}`}
            style={collapsedTurnHeaderStyle}
          >
            <div className="min-w-0 flex flex-wrap items-center gap-2">
              {turnIntentLabel && (
                <span data-testid={`turn-intent-badge-${displayTurnIntent}`} className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${displayTurnIntent === "plan" ? "theme-plan-pill" : displayTurnIntent === "execute" ? "border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] text-[#93c5fd]" : "border-[rgba(52,211,153,0.22)] bg-[rgba(52,211,153,0.1)] text-[#86efac]"}`}>
                  {turnIntentLabel}
                </span>
              )}
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${getTurnStatusTone(turn.status)}`}>
                {copy.turnStatusLabels[turn.status] || turn.status}
              </span>
              {shouldShowTurnChanges && (
                <span className="rounded-full border border-[rgba(37,99,235,0.25)] bg-[rgba(37,99,235,0.12)] px-2 py-0.5 text-[10px] text-[#93c5fd]">
                  {language === "zh" ? `${turnChangeEntries.length} 个变更文件` : `${turnChangeEntries.length} changed file${turnChangeEntries.length > 1 ? "s" : ""}`}
                </span>
              )}
            </div>
            <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-3">
              <span className={`min-w-0 flex-1 break-words text-right text-[13px] font-semibold leading-5 ${turnTitleClass}`}>
                {displayTurnTitle}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {isTurnExpanded && isPlanTurn && hasCompletePlan && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      openRightPanelTab("plan");
                    }}
                    className="theme-plan-button rounded-full border px-3 py-1 text-[11px] transition-colors"
                  >
                    {copy.viewPlan}
                  </button>
                )}
              </div>
              <div className={`shrink-0 ${turnChevronClass}`}>{isTurnExpanded ? <IconChevronDown className="h-4 w-4" /> : <IconChevronRight className="h-4 w-4" />}</div>
            </div>
          </div>
          {!isTurnExpanded && (
            <div className="px-3 pb-3 pt-2">
              <TurnSummaryCard
                turn={turn}
                hiddenCount={(turn.status === "done" || turn.status === "completed_with_changes") ? collapsedProcessCount : hiddenCount}
                fallbackSummary={planProgressSummary || finalAgentSummaryText || effectiveProgressSummary || toolExecutionSummary}
                onOpenPlan={isPlanTurn && hasPlanPanelContent && hasPlanContent ? () => openRightPanelTab("plan") : undefined}
                onExpand={() => toggleConversationTurnCollapsed(turn.id)}
                embedded
                copy={copy}
              />
            </div>
          )}
        </div>

        <div className={`${isTurnExpanded ? "mt-4 " : ""}space-y-4`}>
          {isTurnExpanded && userBlock ? renderBlock(userBlock, 0) : null}
          {isTurnExpanded && shouldShowTurnChanges && !shouldArchiveCompletedProcess && (
            <TurnChangesCard
              entries={turnChangeEntries}
              totalExecutedEdits={totalExecutedEdits}
              language={language}
              onOpenDiff={openDiffForTask}
              chatFontSize={resolvedTurnProcessFontSize}
            />
          )}

          {!isTurnExpanded ? (
            null
          ) : (
            <>
              {planShortcutVisible && (
                <PlanShortcutCard
                  turn={turn}
                  hasPlanContent={hasPlanContent}
                  canOpenPlan={hasPlanPanelContent && hasPlanContent}
                  onOpenPlan={() => openRightPanelTab("plan")}
                  copy={copy}
                />
              )}
              {shouldArchiveCompletedProcess ? (
                <>
                  {processArchive && processArchive.totalCount > 0 && (
                    <TurnProcessArchive
                      archive={processArchive}
                      language={language}
                      chatFontSize={resolvedTurnProcessFontSize}
                      renderArchivedItem={renderArchivedBlockItem}
                      onOpenDiff={openDiffForTask}
                    />
                  )}
                  {finalVisibleAgentBlock && renderBlock(finalVisibleAgentBlock, finalVisibleAgentIndex)}
                </>
              ) : (
                <>
                  {liveProcessTimeline && liveProcessTimeline.totalCount > 0 && (
                    <LiveTurnProcessTimeline
                      model={liveProcessTimeline}
                      language={language}
                      chatFontSize={resolvedTurnProcessFontSize}
                      renderLiveItem={renderBlockItem}
                      onOpenDiff={openDiffForTask}
                    />
                  )}
                  {buildBlockRenderItems(blocks, false, enableCompletedToolGrouping, language).map(renderLiveRemainderItem)}
                </>
              )}
            </>
          )}
          {(activeTurnActivity || bottomThoughtSummary || effectiveProgressLedger.length > 0) && (
            <TurnActivityNotice
              activityText={activeTurnActivity}
              thoughtSummaryText={bottomThoughtSummary}
              isThinking={isBottomThoughtStreaming}
              language={language}
              chatFontSize={resolvedChatFontSize}
              progressItems={effectiveProgressLedger}
            />
          )}
        </div>
        <div
          className="mt-4 h-px w-full rounded-full"
          style={{ backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)" }}
        />
      </section>
    );
  };

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-[#000000]">
      <div className="h-[48px] shrink-0 border-b border-[#27272a] bg-[#000000] px-4 flex items-center justify-between select-none" data-tauri-drag-region>
        <button data-testid="model-settings-button" onClick={() => { setSettingsTab(config.activeProfile === "cloud" ? "cloud" : "local"); setIsSettingsOpen(true); }} className="flex min-w-0 items-center gap-2 rounded-md border border-[#27272a] bg-[#09090b] px-2.5 py-1.5 text-xs font-medium text-[#e4e4e7] transition-colors hover:bg-[#18181b]" style={{ height: 28 }}>
          {config.activeProfile === "local" ? (
            <>
              <span className={`h-1.5 w-1.5 rounded-full ${isStreaming ? "bg-amber-400 shadow-[0_0_5px_#fbbf24] animate-pulse" : "bg-green-500 shadow-[0_0_5px_#22c55e]"}`} />
              {config.local.provider}: <span className="max-w-[150px] truncate font-normal text-[#a1a1aa]">{config.local.model || copy.modelUnselected}</span>
            </>
          ) : (
            <>
              <IconCloud className="theme-text h-3 w-3" />{activeCloudServerName ? `${copy.cloudLabel} · ${activeCloudServerName}` : copy.cloudLabel}: <span className="max-w-[150px] truncate font-normal text-[#a1a1aa]">{activeCloudModel || copy.modelUnselected}</span>
            </>
          )}
        </button>

        <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
          {shouldShowRunStatus && (
            <RunStatusTimer
              activeSessionKey={activeSessionKey}
              isStreaming={isStreaming}
              label={runStatusLabel}
            />
          )}

          {shouldShowRunStatus && (
            <button onClick={onStopGeneration} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[4px] border border-[#27272a] bg-[#09090b] px-3 py-1 text-[10px] font-medium text-[#f48771] transition-colors hover:bg-[#18181b] hover:text-red-400" style={{ height: 28 }}>
              <IconStop className="h-3.5 w-3.5" />
              {copy.stopLabel}
            </button>
          )}

          {hasPlanPanelContent && (
            <button
              onClick={() => togglePanelTab("plan")}
              className={`flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border border-[#27272a] bg-[#09090b] px-3 text-[10px] font-medium transition-colors ${showPlanPanel && rightPanelTab === "plan" ? "theme-subtle-bg" : "text-[#d4d4d8] hover:bg-[#18181b] hover:text-white"}`}
              title={copy.planLabel}
              aria-label={copy.planLabel}
            >
              <IconFileText className="h-3.5 w-3.5" />
              {copy.planLabel}
              {!showPlanPanel && <span className="theme-bg theme-glow ml-0.5 h-1.5 w-1.5 rounded-full" />}
            </button>
          )}

          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => togglePanelTab("terminal")}
              className={`panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] transition-all duration-150 ${showTerminal && rightPanelTab === "terminal" ? "is-active" : ""}`}
              title={t.terminal}
              aria-label={t.terminal}
            >
              <IconTerminal className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => togglePanelTab("file")}
              disabled={!currentWorkspace}
              className={`panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${showFilePanel ? "is-active" : ""}`}
              title={language === "zh" ? "文件" : "Files"}
              aria-label={language === "zh" ? "文件" : "Files"}
            >
              <IconFolder className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => togglePanelTab("diff")}
              className={`panel-tab-icon-button relative flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] transition-all duration-150 ${showDiff && rightPanelTab === "diff" ? "is-active" : ""}`}
              title={t.diff}
              aria-label={t.diff}
            >
              <IconColumns className="h-3.5 w-3.5" />
              {activeDiffTask && !showDiff && <span className="theme-bg absolute right-1 top-1 h-1.5 w-1.5 rounded-full" />}
            </button>
          </div>
        </div>
      </div>

      {shouldRenderTopIsland && (topIslandTurn || pendingRunDecision) && (
        <TopIsland
          isVisible={isTopIslandVisible}
          isRunActive={topIslandIsRunActive}
          title={
            pendingRunDecision?.kind === "intent_confirmation"
              ? pendingRunDecision.title || (language === "zh" ? "意图待确认" : "Intent Confirmation")
              : normalizeConversationDisplayTitle(
                  topIslandTurn && !isGenericConversationTitle(topIslandTurn.title)
                    ? topIslandTurn.title
                    : topIslandTurn?.intentSummary || "",
                  language === "en" ? 52 : 42,
                  topIslandTurn?.userPrompt
                    ? normalizeConversationDisplayTitle(
                        topIslandTurn.userPrompt,
                        language === "en" ? 52 : 42,
                        language === "en" ? "Turn Decision" : "本轮决策",
                      )
                    : language === "en" ? "Turn Decision" : "本轮决策",
                )
          }
          status={copy.turnStatusLabels[topIslandTurnStatusKey || "awaiting_input"] || topIslandTurnStatusKey || "Awaiting Choice"}
          statusToneClass={getTurnStatusTone(topIslandTurnStatusKey || "awaiting_input")}
          language={language}
          themeMode={config.themeMode}
          chatFontSize={resolvedChatFontSize}
          planTasks={shouldShowPinnedPlanTasks ? planTasks : []}
          planExecutionEvidenceLedger={shouldShowPinnedPlanTasks ? planExecutionEvidenceLedger : []}
          planStage={pinnedPlanTurn ? planStage : "idle"}
          executionSteps={shouldShowPinnedPlanTasks ? [] : topIslandExecutionSteps}
          progressMode={shouldShowPinnedPlanTasks ? "plan" : "execution"}
          isAwaitingChoice={isAwaitingInteractiveChoice}
          replyOptions={topIslandReplyOptions}
          pendingRunDecision={pendingRunDecision}
          activeDiffTask={activeDiffTask}
          pendingToolReview={activeDiffTask}
          canApprovePlan={canApprovePlan}
          autoApproveTools={autoApproveTools}
          onSelectReplyOption={(option) => topIslandTurn && onQuickReply?.(option, topIslandTurn.id)}
          onRequestPlanAdjustment={(text) => topIslandTurn && onQuickReply?.({ label: text, value: text, action: "adjust_plan" }, topIslandTurn.id)}
          onCancelTurn={onStopGeneration}
          onResolvePendingRunDecision={resolvePendingRunDecision}
          onDismissPendingRunDecision={dismissPendingRunDecision}
          onApprovePlan={approvePlan}
          onRejectPlan={rejectPlan}
          onRejectAndDeletePlan={planArtifacts.length > 0 ? () => void rejectPlanAndDeleteFiles() : undefined}
          onRejectDiff={handleRejectInline}
          onApproveDiffOnce={() => approvePendingReviewOnce()}
          onApproveDiffSession={() => approvePendingReviewForSession()}
          onOpenPlan={() => openRightPanelTab("plan")}
          onOpenDiff={() => openRightPanelTab("diff")}
        />
      )}

      <div
        ref={chatContainerRef}
        onScroll={handleScroll}
        data-testid="chat-scroll-container"
        className="flex-1 overflow-y-auto px-5 pt-5 transition-[padding-bottom] duration-250 ease-out"
        style={{ paddingBottom: `${composerPaddingBottom}px` }}
      >

        {groupedTurns.length === 0 ? (
          <div
            data-testid="chat-empty-state"
            className="flex h-full items-center justify-center select-none pointer-events-none"
          >
            <div className="flex items-center gap-[4px] opacity-20">
              <IconLogoM className="w-[72px] h-[72px] theme-text drop-shadow-[0_0_24px_var(--accent-subtle)]" />
              <span className="text-[#e4e4e7] text-[48px] font-black tracking-[0.3em] leading-none" style={{ fontFamily: 'var(--font-sans)' }}>
                AIN
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {onLoadOlderSessionHistory && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    if (olderHistoryLoading) return;
                    const el = chatContainerRef.current;
                    const previousScrollHeight = el?.scrollHeight ?? 0;
                    const previousScrollTop = el?.scrollTop ?? 0;
                    setOlderHistoryLoading(true);
                    Promise.resolve(onLoadOlderSessionHistory()).finally(() => {
                      window.requestAnimationFrame(() => {
                        const latestEl = chatContainerRef.current;
                        if (latestEl && previousScrollHeight > 0) {
                          latestEl.scrollTop = latestEl.scrollHeight - previousScrollHeight + previousScrollTop;
                          lastScrollTopRef.current = latestEl.scrollTop;
                        }
                        setOlderHistoryLoading(false);
                      });
                    });
                  }}
                  className="rounded-full border border-[#27272a] bg-[#09090b] px-3 py-1.5 text-[11px] text-[#a1a1aa] transition-colors hover:border-[var(--accent)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={olderHistoryLoading}
                >
                  {olderHistoryLoading
                    ? (language === "zh" ? "加载中..." : "Loading...")
                    : (language === "zh" ? "加载更早历史" : "Load Older History")}
                </button>
              </div>
            )}
            {groupedTurns.map((entry, index) => renderTurn(entry, index))}
          </div>
        )}
        <div ref={endOfFlowRef} />
      </div>

      <Composer
        contextMentions={contextMentions}
        setContextMentions={setContextMentions}
        attachedFiles={attachedFiles}
        setAttachedFiles={setAttachedFiles}
        onAttachFile={onAttachFile}
        showAgentPicker={showAgentPicker}
        setShowAgentPicker={setShowAgentPicker}
        selectedMainModeKey={selectedMainModeKey}
        setSelectedMainModeKey={setSelectedMainModeKey}
        mainModes={mainModes}
        activeStudioAgentKey={activeStudioAgentKey}
        setActiveStudioAgentKey={setActiveStudioAgentKey}
        gameStudioInitialized={gameStudioInitialized}
        initializeGameStudioWorkspace={initializeGameStudioWorkspace}
        removeGameStudioWorkspace={removeGameStudioWorkspace}
        currentWorkspace={currentWorkspace}
        t={t}
        activeDiffTask={activeDiffTask}
        handleAcceptInline={handleAcceptInline}
        handleRejectInline={handleRejectInline}
        setShowDiff={setShowDiff}
        onSendMessage={onSendMessage}
        isStreaming={isStreaming}
        onStopGeneration={onStopGeneration}
        autoApproveTools={autoApproveTools}
        onToggleAutoApprove={onToggleAutoApprove}
        activeSessionKey={activeSessionKey}
        onHeightChange={setComposerHeight}
        chatFontSize={resolvedChatFontSize}
      />
      <UserImagePreviewModal
        item={previewImageItem}
        onClose={() => setPreviewImageItem(null)}
      />
    </div>
  );
}
