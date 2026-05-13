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
import { sanitizeAIOutput } from "../lib/sanitize";
import {
  deriveThoughtDisplay,
  normalizeThinkingPolicy,
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
  type PlanExecutionProgressSnapshot,
  type ReplyOption,
} from "../lib/workflowModels";
import { getIntentPolicy, resolveConversationTurnIntent } from "../lib/runIntent";
import { summarizePlanExecutionProgressSnapshot } from "../lib/planExecutionRecovery";
import { buildCompletedToolGroupRanges, countCompletedToolCalls } from "../lib/toolUiGrouping";
import { compactToolPresentationTarget, getToolPresentationLabel } from "../lib/toolPresentation";
import type { UserContextItem } from "../lib/userContextItems";

const TURN_STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  awaiting_approval: "Awaiting Approval",
  awaiting_input: "Awaiting Choice",
  executing: "Executing",
  completed_with_changes: "Changed",
  stopped_no_action: "Stopped",
  stopped_no_output: "No Output",
  paused: "Paused",
  done: "Done",
  error: "Error",
};

const AGENT_CONTENT_PREVIEW_CHARS = 60_000;
const STREAMING_AGENT_CONTENT_PREVIEW_CHARS = 16_000;

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
            <span className="max-w-[180px] truncate">{isMention ? `@ ${label}` : label}</span>
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
  return getDisplayAgentContent(content, false).content;
}

function getAgentInspectableContent(content: string) {
  const raw = String(content || "");
  if (raw.length <= AGENT_CONTENT_PREVIEW_CHARS) return raw;
  return `${raw.slice(0, AGENT_CONTENT_PREVIEW_CHARS)}\n\n${raw.slice(-20_000)}`;
}

function getTurnStatusTone(status: string): string {
  switch (status) {
    case "planning":
      return "border-[rgba(124,58,237,0.25)] bg-[rgba(124,58,237,0.12)] text-[#c4b5fd]";
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
              className="rounded-full border border-[rgba(124,58,237,0.25)] bg-[rgba(124,58,237,0.12)] px-3 py-1.5 text-[11px] text-[#c4b5fd] transition-colors hover:bg-[rgba(124,58,237,0.2)]"
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
  const droppedMessageCount = Number(stats.droppedMessageCount ?? stats.droppedCount ?? 0);
  const microCompactedCount = Number(stats.microCompactedCount || 0);
  const microKind = String(stats.microCompactionKind || "none");
  const isMicroOnly = !isReactive && droppedMessageCount === 0 && microCompactedCount > 0;
  const topSourceLabel = String(stats.topTokenSource?.label || "").trim();
  const topSourceTokens = Number(stats.topTokenSource?.tokens || 0);
  const title = language === "zh"
    ? isReactive ? "上下文溢出保护" : isMicroOnly ? (microKind === "tool_results" ? "长工具输出已截断" : "长内容已整理") : "历史上下文已压缩"
    : isReactive ? "Context overflow guard" : isMicroOnly ? (microKind === "tool_results" ? "Long tool output truncated" : "Long content compacted") : "History context compressed";
  const compactLabel = language === "zh" ? "查看" : "View";
  const bodyText = String(stats.displaySummary || stats.compressedContext || "").trim() || (language === "zh"
    ? "当前只保存了压缩统计，暂无可展示的压缩摘要。"
    : "Only compression stats are available for this event.");
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
  const title = isCheckpoint
    ? language === "zh" ? "计划执行检查点" : "Plan Execution Checkpoint"
    : language === "zh" ? "计划执行进度" : "Plan Execution Progress";
  const tone = isCheckpoint
    ? "border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.08)] text-[#fde68a]"
    : "border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.08)] text-[#bfdbfe]";

  return (
    <div className="flex w-full justify-center">
      <div data-testid={block.variant} className={`max-w-[min(760px,92%)] rounded-lg border px-3 py-2 text-left ${tone}`}>
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#a1a1aa]">{title}</div>
        <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-[#e4e4e7]">{String(block.content || "")}</div>
      </div>
    </div>
  );
}

function getPlanProgressPhaseLabel(phase: string, language: "zh" | "en") {
  if (language === "zh") {
    switch (phase) {
      case "starting": return "准备执行";
      case "tool_start": return "工具执行中";
      case "tool_done": return "工具已完成";
      case "tool_error": return "工具出错";
      case "waiting_review": return "等待审批";
      case "context_compression": return "背景已压缩";
      case "checkpoint": return "检查点";
      case "auto_resume": return "自动续跑";
      case "paused": return "已暂停";
      case "completed": return "已完成";
      default: return "执行中";
    }
  }

  switch (phase) {
    case "starting": return "Starting";
    case "tool_start": return "Tool running";
    case "tool_done": return "Tool done";
    case "tool_error": return "Tool error";
    case "waiting_review": return "Waiting for approval";
    case "context_compression": return "Context compressed";
    case "checkpoint": return "Checkpoint";
    case "auto_resume": return "Auto-resuming";
    case "paused": return "Paused";
    case "completed": return "Completed";
    default: return "Running";
  }
}

function PlanExecutionLiveCard({
  snapshot,
  language,
}: {
  snapshot: PlanExecutionProgressSnapshot;
  language: "zh" | "en";
  compact?: boolean;
}) {
  if (!snapshot) return null;
  const title = language === "zh" ? "计划执行" : "Plan Execution";
  const phaseLabel = getPlanProgressPhaseLabel(snapshot.phase, language);
  const iterationText = snapshot.maxIterations > 0
    ? `${snapshot.iteration}/${snapshot.maxIterations}`
    : String(snapshot.iteration || 0);
  const labels = language === "zh"
    ? { turn: "轮次", auto: "自动恢复" }
    : { turn: "Turn", auto: "Auto-resume" };
  const statusText = language === "zh"
    ? snapshot.phase === "auto_resume"
      ? "计划自动恢复中"
      : snapshot.phase === "paused"
      ? "计划已暂停，等待继续执行"
      : snapshot.phase === "completed"
      ? "计划执行已完成"
      : snapshot.phase === "tool_error"
      ? "计划执行遇到工具错误"
      : "计划继续执行中"
    : snapshot.phase === "auto_resume"
    ? "Plan auto-resume in progress"
    : snapshot.phase === "paused"
    ? "Plan paused, waiting to continue"
    : snapshot.phase === "completed"
    ? "Plan execution completed"
    : snapshot.phase === "tool_error"
    ? "Plan execution hit a tool error"
    : "Plan execution continuing";

  return (
    <div data-testid="plan-execution-live-card" className="ml-9 rounded-2xl border border-[rgba(96,165,250,0.24)] bg-[rgba(37,99,235,0.08)] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[#bfdbfe]">
          {title}
        </span>
        <span className="rounded-full border border-[rgba(52,211,153,0.22)] bg-[rgba(52,211,153,0.1)] px-2 py-0.5 text-[10px] text-[#86efac]">
          {phaseLabel}
        </span>
        <span className="text-[11px] text-[#93c5fd]">
          {labels.turn} {iterationText} · {labels.auto} {snapshot.autoResumeCount}/1
        </span>
      </div>
      <div className="mt-3 text-[12px] leading-5 text-[#d4d4d8]">
        {statusText}
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
    <div className="ml-9 rounded-2xl border border-[rgba(124,58,237,0.22)] bg-[rgba(124,58,237,0.08)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-[rgba(124,58,237,0.25)] bg-[rgba(124,58,237,0.14)] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[#c4b5fd]">
              {copy.planLabel}
            </span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] ${getTurnStatusTone(turn.status)}`}>
              {copy.turnStatusLabels[turn.status] || turn.status}
            </span>
          </div>
          <div className="mt-2 text-[13px] leading-relaxed text-[#e9d5ff]">{description}</div>
        </div>
        {canOpenPlan ? (
          <button
            onClick={onOpenPlan}
            className="shrink-0 rounded-full border border-[rgba(124,58,237,0.25)] bg-[rgba(124,58,237,0.16)] px-3 py-1.5 text-[11px] text-[#f5f3ff] transition-colors hover:bg-[rgba(124,58,237,0.22)]"
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
  read: new Set(["get_project_skeleton", "get_file_outline", "read_file", "read_document", "list_directory", "glob_search", "grep_search", "index_workspace_documents"]),
  table: new Set(["analyze_tabular_document", "query_tabular_document"]),
  edit: new Set(["replace_in_file", "write_file"]),
  command: new Set(["execute_command", "send_pty_input", "run_command", "read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status", "clear_pty_buffer"]),
};

const READ_CONTEXT_TOOL_NAMES = new Set([
  "get_project_skeleton",
  "get_file_outline",
  "read_file",
  "read_document",
  "list_directory",
  "glob_search",
  "grep_search",
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
  if (block.type === "agent") {
    if (block.hiddenProcess && !block.streaming) return false;
    return hasRenderableAgentBlock(block);
  }
  if (block.type === "tool") {
    if (block.toolStatus !== "pending") return false;
    return block.toolName !== "write_file" && block.toolName !== "replace_in_file";
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

function buildBlockRenderItems(blocks: any[], includeUser = true, enableCompletedToolGrouping = false) {
  const items: Array<
    | { kind: "block"; block: any; index: number }
    | { kind: "readContextGroup"; blocks: any[]; index: number }
    | { kind: "completedToolGroup"; blocks: any[]; index: number }
  > = [];
  let activeReadContextGroup: { kind: "readContextGroup"; blocks: any[]; index: number } | null = null;
  const completedToolGroupRangesByStart = new Map(
    enableCompletedToolGrouping
      ? buildCompletedToolGroupRanges({
          blocks,
          excludedToolNames: READ_CONTEXT_TOOL_NAMES,
        }).map((range) => [range.startIndex, range])
      : [],
  );

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const completedToolGroupRange = completedToolGroupRangesByStart.get(index);
    if (completedToolGroupRange) {
      activeReadContextGroup = null;
      items.push({
        kind: "completedToolGroup",
        blocks: blocks.slice(completedToolGroupRange.startIndex, completedToolGroupRange.endIndex + 1),
        index,
      });
      index = completedToolGroupRange.endIndex;
      continue;
    }

    if (isCompletedReadContextTool(block)) {
      if (!activeReadContextGroup) {
        activeReadContextGroup = { kind: "readContextGroup", blocks: [block], index };
        items.push(activeReadContextGroup);
      } else {
        activeReadContextGroup.blocks.push(block);
      }
      continue;
    }

    if (!includeUser && block?.type === "user") {
      activeReadContextGroup = null;
      continue;
    }

    if (isReadContextHardBoundary(block)) {
      activeReadContextGroup = null;
    }

    items.push({ kind: "block", block, index });
  }

  return items;
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

function getActiveTurnActivity(blocks: any[], turnStatus: string, language: "zh" | "en") {
  const completedToolCallCount = countCompletedToolCalls(blocks);
  const runningTool = [...blocks].reverse().find((block) => block.type === "tool" && block.toolStatus === "running");
  if (runningTool) {
    const target = String(runningTool.target || runningTool.toolName || "").split("/").pop() || runningTool.toolName;
    const tableTools = new Set(["analyze_tabular_document", "query_tabular_document"]);
    const readTools = new Set(["read_file", "read_document", "list_directory", "glob_search", "grep_search", "index_workspace_documents", "get_project_skeleton"]);
    const commandTools = new Set(["execute_command", "run_command", "send_pty_input"]);
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

function TurnActivityNotice({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div
      data-testid="turn-activity-notice"
      className="ml-9 flex items-center gap-2 rounded-2xl border border-[rgba(96,165,250,0.2)] bg-[rgba(37,99,235,0.08)] px-4 py-3 text-[12px] text-[#bfdbfe]"
    >
      <span className="h-2 w-2 rounded-full bg-[#60a5fa] shadow-[0_0_8px_rgba(96,165,250,0.8)] animate-pulse" />
      <span>{text}</span>
    </div>
  );
}

function ThoughtBlock({
  block,
  language,
  chatFontSize,
  summaryText,
}: {
  block: any;
  language: "zh" | "en";
  chatFontSize: number;
  summaryText?: string;
}) {
  const rawContent = String(block.content || "").trim();
  if (!rawContent) return null;
  const computedSummaryText = useMemo(() => {
    const display = deriveThoughtDisplay(rawContent, {
      language,
    });
    return display.summaryText;
  }, [language, rawContent]);
  const resolvedSummaryText = String(summaryText || "").trim() || computedSummaryText;
  if (!resolvedSummaryText) return null;

  return (
    <div data-testid="thought-block" className="mt-4 flex w-full min-w-0 items-start justify-start gap-3">
      <div className="mt-1 flex-shrink-0">
        <IconLogoM className="theme-text h-6 w-6 drop-shadow-[0_0_8px_var(--accent-subtle)]" />
      </div>
      <div
        data-testid="thought-summary-lines"
        className="chat-agent-content my-1 min-w-0 flex-1 px-2 py-1 text-[#e4e4e7]"
        style={{ fontSize: `${chatFontSize}px` }}
      >
        <MarkdownRenderer content={resolvedSummaryText} baseFontSize={chatFontSize} />
      </div>
    </div>
  );
}

function TurnChangesCard({
  entries,
  totalExecutedEdits,
  language,
  onOpenDiff,
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
}) {
  if (entries.length === 0) return null;

  const headerText = language === "zh"
    ? `本轮改动 · ${entries.length} 个文件`
    : `Turn Changes · ${entries.length} file${entries.length > 1 ? "s" : ""}`;
  const subText = language === "zh"
    ? `${totalExecutedEdits} 次已执行修改`
    : `${totalExecutedEdits} executed edit${totalExecutedEdits > 1 ? "s" : ""}`;

  return (
    <div className="ml-9 rounded-2xl border border-[#1d4ed8]/18 bg-[#060b14] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[#93c5fd]">
            <IconCode className="h-3.5 w-3.5" />
            <span>{headerText}</span>
          </div>
          <div className="mt-1 text-[12px] text-[#64748b]">{subText}</div>
        </div>
      </div>
      <div className="mt-3 space-y-2">
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
      </div>
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
  const targets = blocks.map((block) =>
    compactToolTarget(block.target, String(block.toolName || ""), language),
  );
  const previewTargets = targets.slice(0, 3).filter(Boolean);
  const hiddenCount = Math.max(0, targets.length - previewTargets.length);
  const previewText = previewTargets.join(language === "zh" ? "、" : ", ");
  const title = language === "zh"
    ? `已读取 ${blocks.length} 项上下文`
    : `Read ${blocks.length} context item${blocks.length > 1 ? "s" : ""}`;
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
        <span className="shrink-0 rounded-full border border-[#27272a] bg-[#050507] px-2 py-0.5 text-[10px] text-[#a1a1aa]">
          {toggleText}
        </span>
      </button>

      {expanded && (
        <div
          data-testid="read-context-group-details"
          className="mt-2 space-y-1 rounded-xl border border-[#1f1f23] bg-[#050507] p-2"
        >
          {blocks.map((block) => {
            const toolName = String(block.toolName || "");
            const label = getReadContextToolLabel(toolName, language);
            const displayTarget = compactToolTarget(block.target, toolName, language);
            const target = fullToolTarget(block.target, toolName, language);

            return (
              <div
                key={block.id}
                data-testid="read-context-item"
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

function CompletedToolGroupCard({
  blocks,
  language,
}: {
  blocks: any[];
  language: "zh" | "en";
}) {
  const [expanded, setExpanded] = useState(false);
  const previewNames = blocks
    .slice(0, 3)
    .map((block) => compactToolTarget(block.target, String(block.toolName || ""), language))
    .filter(Boolean);
  const hiddenCount = Math.max(0, blocks.length - previewNames.length);
  const title = language === "zh"
    ? `已完成 ${blocks.length} 次工具调用`
    : `${blocks.length} completed tool call${blocks.length > 1 ? "s" : ""}`;
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
        {previewNames.length > 0 && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#71717a]">
            · {previewNames.join(language === "zh" ? "、" : ", ")}{hiddenCount > 0 ? ` +${hiddenCount}` : ""}
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
          {blocks.map((block) => {
            const toolName = String(block.toolName || "");
            const label = getCompletedToolGroupToolLabel(toolName, language);
            const displayTarget = compactToolTarget(block.target, toolName, language);
            const target = fullToolTarget(block.target, toolName, language);

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
  const previewLimit = block.streaming ? STREAMING_AGENT_CONTENT_PREVIEW_CHARS : AGENT_CONTENT_PREVIEW_CHARS;
  const isLongContent = rawContent.length > previewLimit;
  const [showFullLongContent, setShowFullLongContent] = useState(false);
  const [isArchivedExpanded, setIsArchivedExpanded] = useState(false);
  const displayContent = getDisplayAgentContent(rawContent, isLongContent && showFullLongContent && !block.streaming, previewLimit);
  const streamingText = block.streaming ? sanitizeAIOutput(displayContent.content) : "";
  const segments = useMemo(
    () => block.streaming ? [] : parseMessageContent(displayContent.content),
    [block.streaming, displayContent.content],
  );
  const hasVisibleContent =
    (block.streaming && streamingText.length > 0) ||
    segments.some((seg) => (seg.type === "text" ? sanitizeAIOutput(seg.content).length > 0 : true)) ||
    isLongContent;
  const archivedPreviewText = useMemo(() => segments
      .filter((seg) => seg.type === "text")
      .map((seg) => sanitizeAIOutput(seg.content))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    [segments],
  );

  if (!hasVisibleContent) return null;

  const previewCharCount = Math.min(rawContent.length, previewLimit).toLocaleString();
  const totalCharCount = rawContent.length.toLocaleString();
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
            const cleanText = sanitizeAIOutput(seg.content);
            if (!cleanText) return null;
            return <MarkdownRenderer key={`${block.id}-text-${segIdx}`} content={cleanText} baseFontSize={chatFontSize} />;
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
  const thinkingPolicy = normalizeThinkingPolicy(config.thinkingPolicy);
  const shouldSuppressThoughtBlocks = thinkingPolicy === "action_only";
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
      ? { planning: "规划中", awaiting_approval: "待审批", awaiting_input: "待选择", executing: "执行中", completed_with_changes: "已完成并写入", stopped_no_action: "已停止无产物", stopped_no_output: "无输出", paused: "已暂停", done: "完成", error: "错误" }
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

  const groupedTurns = useMemo(() => {
    if (conversationTurns.length === 0) {
      return blocksByTurnId.legacyBlocks.length > 0
        ? [{ turn: null, blocks: blocksByTurnId.legacyBlocks }]
        : [];
    }

    return conversationTurns.map((turn) => ({
      turn,
      blocks: blocksByTurnId.byTurnId.get(turn.id) || [],
    }));
  }, [blocksByTurnId, conversationTurns]);

  useEffect(() => {
    const nextSessionKey = activeSessionKey ?? null;
    const firstTurnId = conversationTurns[0]?.id ?? null;
    const sessionChanged = previousSessionKeyRef.current !== nextSessionKey;
    const replacedHistory = previousFirstTurnIdRef.current !== firstTurnId;
    previousSessionKeyRef.current = nextSessionKey;
    previousFirstTurnIdRef.current = firstTurnId;
    if (!sessionChanged && !replacedHistory) return;

    setIsAutoScroll(true);
    setActiveVisibleTurnId(conversationTurns[conversationTurns.length - 1]?.id ?? null);
    setShowTopIslandDuringHistoryPeek(false);
    const rafId = window.requestAnimationFrame(() => {
      const el = chatContainerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [activeSessionKey, conversationTurns]);

  const activeTurn = useMemo(() => {
    return resolveActiveConversationTurn(conversationTurns, activeVisibleTurnId, isAutoScroll);
  }, [activeVisibleTurnId, conversationTurns, isAutoScroll]);
  const pinnedTurn = useMemo(() => {
    return resolvePinnedConversationTurn(conversationTurns, currentTurnId);
  }, [conversationTurns, currentTurnId]);
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
      hasIncompletePlanTasks: !buildPlanTaskEvidenceAudit({ tasks: planTasks, evidenceLedger: planExecutionEvidenceLedger }).acceptedCompletion,
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
  const isAwaitingInteractiveChoice =
    topIslandTurnStatusKey === "awaiting_input" && topIslandReplyOptions.length > 0;
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
    setActiveVisibleTurnId(current?.turnId || conversationTurns[conversationTurns.length - 1]?.id || null);
  }, [groupedTurns, conversationTurns]);

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
                  fontSize: `${config.chatFontSize ?? 13}px`,
                  lineHeight: `${Math.max(22, Math.round((config.chatFontSize ?? 13) * 1.7))}px`,
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
      if (block.variant === "plan_execution_progress" || block.variant === "plan_execution_checkpoint") {
        if (
          block.variant === "plan_execution_progress" &&
          planExecutionProgressSnapshot?.turnId &&
          planExecutionProgressSnapshot.turnId === block.turnId
        ) {
          return null;
        }
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
              <MarkdownRenderer content={block.content} baseFontSize={config.chatFontSize ?? 13} />
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
      if (shouldSuppressThoughtBlocks) return null;
      return (
        <ThoughtBlock
          key={`${block.id}-${index}`}
          block={block}
          language={language}
          chatFontSize={config.chatFontSize ?? 13}
        />
      );
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
        (block.toolName === "write_file" || block.toolName === "replace_in_file");
      if (shouldHidePendingTool) return null;
      if (
        (block.toolName === "write_file" || block.toolName === "replace_in_file") &&
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
            onAllow={() => allowToolAction?.(block.id)}
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
          chatFontSize={config.chatFontSize ?? 13}
        />
      );
    }

    return null;
  };

  const renderBlockItem = (item) => {
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
          {buildBlockRenderItems(entry.blocks).map(renderBlockItem)}
        </div>
      );
    }

    const turn: ConversationTurn = entry.turn;
    const blocks = entry.blocks;
    const turnIntent = resolveConversationTurnIntent(turn);
    const turnIntentPolicy = getIntentPolicy(turnIntent);
    const turnIntentLabel = turnIntentPolicy.intent === turnIntent
      ? (language === "en" ? turnIntentPolicy.label.en : turnIntentPolicy.label.zh)
      : (language === "zh" ? "任务" : "Task");
    const isPlanTurn = turnIntent === "plan";
    const enableCompletedToolGrouping = turnIntent === "studio_workflow";
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
    const forceExpandedTurn =
      turn.status === "awaiting_input" ||
      turn.status === "awaiting_approval";
    const isTurnExpanded = !turn.collapsed || forceExpandedTurn;
    const userBlock = blocks.find((block) => block.type === "user");
    const hiddenCount = blocks.filter((block) => block.type !== "user").length;
    const { entries: turnChangeEntries, totalExecutedEdits } = collectTurnChangeEntries(blocks);
    const shouldShowTurnChanges = turnChangeEntries.length > 1 || totalExecutedEdits > 1;
    const shouldPreservePlanExecutionAgentText = isPlanTurn && isPlanExecutionVisible;
    const finalVisibleAgentIndex = isPlanTurn && !shouldPreservePlanExecutionAgentText
      ? -1
      : [...blocks]
          .map((block, idx) => ({ block, idx }))
          .reverse()
          .find(({ block }) => hasRenderableAgentBlock(block))?.idx ?? -1;
    const finalVisibleAgentBlock = finalVisibleAgentIndex >= 0 ? blocks[finalVisibleAgentIndex] : null;
    const collapsedProcessCount = finalVisibleAgentBlock
      ? blocks.filter((block, idx) => block.type !== "user" && idx !== finalVisibleAgentIndex).length + (shouldShowTurnChanges ? 1 : 0)
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
    const finalAgentSummaryText = getLastAgentSummaryText(blocks);
    const planProgressSummary = turnProgressSnapshot
      ? summarizePlanExecutionProgressSnapshot(turnProgressSnapshot, language)
      : "";
    const toolExecutionSummary = buildToolExecutionSummary(blocks, language);
    const activeTurnActivity = getActiveTurnActivity(blocks, turn.status, language);
    const seenThoughtSummaryDedupeKeys = new Set<string>();
    const thoughtSummaryCache = new Map<string, string>();
    const getThoughtSummaryText = (thoughtBlock: any) => {
      const cacheKey = String(thoughtBlock?.id ?? "");
      if (thoughtSummaryCache.has(cacheKey)) {
        return thoughtSummaryCache.get(cacheKey) || "";
      }
      const summary = deriveThoughtDisplay(String(thoughtBlock?.content || ""), {
        language,
      }).summaryText;
      thoughtSummaryCache.set(cacheKey, summary);
      return summary;
    };
    const renderTurnBlockItem = (item) => {
      if (shouldSuppressThoughtBlocks && item.kind !== "readContextGroup" && item.block?.type === "thought") {
        return null;
      }
      if (
        !shouldSuppressThoughtBlocks &&
        item.kind !== "readContextGroup" &&
        item.block?.type === "thought"
      ) {
        const summaryText = getThoughtSummaryText(item.block);
        const summaryDedupeKey = normalizeThoughtSummaryForCompare(summaryText);
        if (!summaryText) return null;
        if (summaryDedupeKey) {
          if (seenThoughtSummaryDedupeKeys.has(summaryDedupeKey)) return null;
          seenThoughtSummaryDedupeKeys.add(summaryDedupeKey);
        }
        return (
          <ThoughtBlock
            key={`${item.block.id}-${item.index}`}
            block={item.block}
            language={language}
            chatFontSize={config.chatFontSize ?? 13}
            summaryText={summaryText}
          />
        );
      }

      return renderBlockItem(item);
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
            backgroundColor: "color-mix(in srgb, var(--accent, #7c3aed) 12%, #ffffff 88%)",
            borderBottomColor: "color-mix(in srgb, var(--accent, #7c3aed) 28%, #e5e7eb 72%)",
          }
        : isBlackThemeMode
        ? {
            backgroundColor: "color-mix(in srgb, var(--accent, #7c3aed) 14%, #000000 86%)",
            borderBottomColor: "color-mix(in srgb, var(--accent-light, #a855f7) 30%, #202026 70%)",
          }
        : {
            backgroundColor: "color-mix(in srgb, var(--accent, #7c3aed) 14%, #09090b 86%)",
            borderBottomColor: "color-mix(in srgb, var(--accent-light, #a855f7) 28%, #27272a 72%)",
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
                <span data-testid={`turn-intent-badge-${turnIntent}`} className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${isPlanTurn ? "border-[rgba(124,58,237,0.25)] bg-[rgba(124,58,237,0.12)] text-[#c4b5fd]" : turnIntent === "execute" ? "border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] text-[#93c5fd]" : "border-[rgba(52,211,153,0.22)] bg-[rgba(52,211,153,0.1)] text-[#86efac]"}`}>
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
                    className="rounded-full border border-[rgba(124,58,237,0.25)] bg-[rgba(124,58,237,0.1)] px-3 py-1 text-[11px] text-[#c4b5fd] transition-colors hover:bg-[rgba(124,58,237,0.18)]"
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
                fallbackSummary={planProgressSummary || finalAgentSummaryText || toolExecutionSummary}
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
          {isTurnExpanded && shouldShowTurnChanges && (
            <TurnChangesCard
              entries={turnChangeEntries}
              totalExecutedEdits={totalExecutedEdits}
              language={language}
              onOpenDiff={openDiffForTask}
            />
          )}

          {!isTurnExpanded ? (
            <>
              {isPlanExecutionVisible && turnProgressSnapshot && (
                <PlanExecutionLiveCard snapshot={turnProgressSnapshot} language={language} compact />
              )}
              {blocks
                .filter((block) => block.type === "system" && block.variant === "plan_execution_checkpoint")
                .map((block, blockIndex) => renderBlock(block, blockIndex))}
            </>
          ) : shouldPlanShortcutReplaceTurn({ isPlanTurn, hasCompletePlan, isPlanExecutionVisible }) ? (
            <PlanShortcutCard
              turn={turn}
              hasPlanContent={hasPlanContent}
              canOpenPlan={hasPlanPanelContent && hasPlanContent}
              onOpenPlan={() => openRightPanelTab("plan")}
              copy={copy}
            />
          ) : (
            <>
              {isPlanExecutionVisible && turnProgressSnapshot && (
                <PlanExecutionLiveCard snapshot={turnProgressSnapshot} language={language} />
              )}
              {isPlanExecutionVisible && hasCompletePlan && (
                <PlanShortcutCard
                  turn={turn}
                  hasPlanContent={hasPlanContent}
                  canOpenPlan={hasPlanPanelContent && hasPlanContent}
                  onOpenPlan={() => openRightPanelTab("plan")}
                  copy={copy}
                />
              )}
              {buildBlockRenderItems(blocks, false, enableCompletedToolGrouping).map(renderTurnBlockItem)}
            </>
          )}
          {activeTurnActivity && <TurnActivityNotice text={activeTurnActivity} />}
        </div>
        <div
          className="mt-4 h-px w-full rounded-full"
          style={{ backgroundColor: "color-mix(in srgb, var(--accent, #7c3aed) 50%, transparent)" }}
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
              <IconCloud className="h-3 w-3 text-[#a855f7]" />{activeCloudServerName ? `${copy.cloudLabel} · ${activeCloudServerName}` : copy.cloudLabel}: <span className="max-w-[150px] truncate font-normal text-[#a1a1aa]">{activeCloudModel || copy.modelUnselected}</span>
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
          chatFontSize={config.chatFontSize ?? 13}
          planTasks={shouldShowPinnedPlanTasks ? planTasks : []}
          planExecutionEvidenceLedger={shouldShowPinnedPlanTasks ? planExecutionEvidenceLedger : []}
          planStage={pinnedPlanTurn ? planStage : "idle"}
          executionSteps={shouldShowPinnedPlanTasks ? [] : topIslandExecutionSteps}
          progressMode={shouldShowPinnedPlanTasks ? "plan" : "execution"}
          isAwaitingChoice={topIslandTurnStatusKey === "awaiting_input"}
          replyOptions={topIslandReplyOptions}
          pendingRunDecision={pendingRunDecision}
          activeDiffTask={activeDiffTask}
          canApprovePlan={canApprovePlan}
          autoApproveTools={autoApproveTools}
          onSelectReplyOption={(option) => topIslandTurn && onQuickReply?.(option, topIslandTurn.id)}
          onCancelTurn={onStopGeneration}
          onResolvePendingRunDecision={resolvePendingRunDecision}
          onDismissPendingRunDecision={dismissPendingRunDecision}
          onApprovePlan={approvePlan}
          onRejectPlan={rejectPlan}
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
      />
      <UserImagePreviewModal
        item={previewImageItem}
        onClose={() => setPreviewImageItem(null)}
      />
    </div>
  );
}
