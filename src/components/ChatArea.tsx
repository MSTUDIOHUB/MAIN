// @ts-nocheck
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconAt, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconCloud, IconCode, IconColumns, IconFile, IconFileText, IconFolder, IconGoal, IconImageIcon, IconLogoM, IconSettings, IconStop, IconSubagent, IconSubagentClosed, IconTerminal, IconZap } from "./Icons";
import ActionCard from "./ActionCard";
import Composer from "./Composer";
import ImageGenerationCard from "./ImageGenerationCard";
import JobListCard from "./JobListCard";
import MarkdownRenderer from "./MarkdownRenderer";
import StreamingCursor from "./StreamingCursor";
import ExecutionCapsule from "./ExecutionCapsule";
import GoalPanel from "./GoalPanel";
import PlanReviewCapsule from "./PlanReviewCapsule";
import { resolveAutoScrollState } from "../lib/chatScroll";
import { parseMessageContent } from "../lib/messageParser";
import { sanitizeAIOutput, sanitizeAssistantDisplayContent, sanitizeVisibleAssistantText } from "../lib/sanitize";
import { stripLeakedReasoning } from "../lib/normalizedTurn";
import {
  deriveThoughtDisplay,
  normalizeThoughtSummaryForCompare,
} from "../lib/thoughtDisplay";
import { deriveTurnProgressItems } from "../lib/turnProgress";
import { useAppStore } from "../store/useAppStore";
import {
  buildPlanTaskEvidenceAudit,
  deriveVisibleConversationTurnStatus,
  hasLivePlanWorkspace,
  isConversationTurnRuntimeClosed,
  isGenericConversationTitle,
  isEphemeralPlanArtifactPath,
  normalizeConversationDisplayTitle,
  isPlanConversationTurn,
  looksLikeReasoningLeakTitle,
  resolveActiveConversationTurn,
  resolvePinnedConversationTurn,
  summarizePlanIntent,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  type ConversationTurn,
  type ReplyOption,
} from "../lib/workflowModels";
import { getIntentPolicy, resolveConversationTurnIntent } from "../lib/runIntent";
import { formatPlanExecutionProgressSnapshot, summarizePlanExecutionProgressSnapshot } from "../lib/planExecutionRecovery";
import {
  countCompletedToolCalls,
  type ChatOperationCluster,
} from "../lib/toolUiGrouping";
import { buildLiveTurnProcessTimelineModel, buildTurnProcessArchiveModel, type TurnArchiveStep } from "../lib/turnProcessArchive";
import {
  buildCapsuleGuidanceText,
  buildRuntimeProgressLedger,
  buildRunStatusProjection,
} from "../lib/runtimeProgressLedger";
import { getChatFeedbackStatusCopy, normalizeChatFeedbackStatus } from "../lib/chatFeedback";
import { appendDebugLog } from "../lib/debugLog";
import type { UserContextItem } from "../lib/userContextItems";
import {
  AGENT_CONTENT_PREVIEW_CHARS,
  STREAMING_AGENT_CONTENT_PREVIEW_CHARS,
  formatTokenCount,
  getDisplayAgentContent,
  normalizeTranscriptDedupeText,
} from "../lib/chat/chatContentPreview";
import { shouldRetainStageSummary } from "../lib/modelFeedbackDedupe";
import {
  getAgentVisibleMarkdownText,
  getLastAgentSummaryText,
  hasGeneratedPlanContent,
  hasRenderableAgentBlock,
  isPlanGenerationFailureBlock,
  isTransparentToolNarrationBlock,
  resolvePlanArtifactOwnerTurnId,
  selectLatestPlanCandidatePreview,
  shouldSuppressSupersededPlanCandidate,
  shouldSuppressAgentAsExplanation,
  shouldSuppressAgentToolEcho,
} from "../lib/chat/chatBlockVisibility";
import {
  buildBlockRenderItems,
  buildReadContextEntries,
  collectTurnChangeEntries,
} from "../lib/chat/chatRenderItems";
import {
  TOOL_SUMMARY_GROUPS,
  buildToolExecutionSummary,
  compactToolTarget,
  fullToolTarget,
  getCompletedToolGroupToolLabel,
  getOperationClusterTone,
  isCommandLikeToolName,
  shouldGroupPlanExecutionTools,
} from "../lib/chat/chatToolSummary";
import {
  getPendingToolReviewArgumentDisclosure,
  isExactPendingToolReviewOwner,
  resolveVisiblePendingToolReview,
} from "../lib/pendingToolReview";
import {
  getToolPermissionResolutionIdentity,
  shouldRenderPermissionCapsule,
} from "../lib/actionRequest";
import {
  buildCapsuleStatusProjection,
  buildPlanExecutionCapsuleProjection,
  buildTurnPresentationModel,
  isPlanReviewCapsulePresentationEligible,
  shouldRenderTurnBoundary,
} from "../lib/turnPresentation";
import { buildTypedPlanApprovalIdentity } from "../lib/planApprovalIdentity";
import { isSubagentActiveStatus, projectSubagentRuns } from "../lib/subagents";
import { getHarnessActionRunId } from "../lib/harnessCrashTelemetry";
import { shouldDetachGoalPresentationFromOwnerTurn } from "../lib/goalResumeBoundary";
import { selectCapsuleLiveGuidance } from "../lib/capsuleCommentary";
import { resolveSessionWorkspaceKey } from "../lib/sessionTypes";
import {
  resolveTurnStrategyFromIntent,
  selectTurnIngressAvailability,
} from "../lib/turnIngress";

const TURN_STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  awaiting_approval: "Awaiting Approval",
  awaiting_input: "Awaiting Choice",
  executing: "Executing",
  completed_with_changes: "Changed",
  stopped_no_action: "Stopped",
  stopped_no_output: "No visible reply",
  paused: "Paused",
  success: "Completed",
  partial: "Partially completed",
  blocked: "Blocked",
  canceled: "Canceled",
  done: "Done",
  error: "Error",
};

function resolveTurnProcessFontSize(chatFontSize: number): number {
  const size = Number(chatFontSize) || 13;
  return Math.min(18, Math.max(8, size - 2));
}

const TURN_PROCESS_FONT_REFERENCE_SIZE = 13;
const TURN_PROCESS_FONT_STEPS = [9, 10, 10.5, 11, 12, 12.5, 13] as const;
const EMPTY_CHAT_BLOCKS: any[] = [];

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
        const thumbnailDataUrl = item.thumbnailDataUrl || item.previewDataUrl;
        const fullPreviewDataUrl = item.previewDataUrl || item.thumbnailDataUrl;
        const canPreview = isImage && !!fullPreviewDataUrl;
        const label = item.label || (language === "en" ? `Image ${index + 1}` : `截图 ${index + 1}`);
        const displayLabel = isMention ? String(label).replace(/^@\s*/, "") : label;
        const statusTitle = item.status === "failed"
          ? language === "en" ? "Read failed" : "读取失败"
          : item.path || label;
        const content = (
          <>
            {isImage && thumbnailDataUrl ? (
              <img
                src={thumbnailDataUrl}
                alt={label}
                data-testid="user-context-image-thumbnail"
                className="h-8 w-10 rounded-md border border-[#3f3f46] object-cover"
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
          `inline-flex ${isImage && thumbnailDataUrl ? "h-10" : "h-7"} max-w-full items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-mono transition-colors`,
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
            onClick={() => onPreviewImage(
              item.previewDataUrl ? item : { ...item, previewDataUrl: fullPreviewDataUrl },
            )}
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

function VisualContextDeliveryBadge({
  progress,
  language,
}: {
  progress: any;
  language: "zh" | "en";
}) {
  const status = String(progress?.visualContext?.status || "queued");
  const recognition = String(progress?.visualContext?.recognition || (
    status === "delivered" || status === "queued" ? "pending" : "unverified"
  ));
  const observationSummary = String(progress?.visualContext?.observationSummary || "").trim();
  const terminalWithoutObservation = progress?.visualRunTerminal === true && recognition === "pending";
  const observed = status === "delivered" && recognition === "observed" && observationSummary.length > 0;
  const title = observed
    ? language === "zh" ? "模型已报告截图观察" : "Model reported a screenshot observation"
    : terminalWithoutObservation
    ? language === "zh" ? "未形成明确截图观察" : "No explicit screenshot observation"
    : status === "delivered" || status === "queued"
    ? language === "zh" ? "正在识别截图证据" : "Inspecting screenshot evidence"
    : String(progress?.title || (language === "zh" ? "截图未送达模型" : "Screenshot not delivered to model"));
  const summary = observationSummary || String(progress?.summary || "");
  const tone = observed
    ? "text-[#86efac]"
    : terminalWithoutObservation || status === "provider_unsupported" || status === "not_delivered" || status === "partially_delivered"
    ? "text-[#fbbf24]"
    : "text-[#93c5fd]";
  const dot = observed
    ? "bg-[#34d399]"
    : terminalWithoutObservation || status === "provider_unsupported" || status === "not_delivered" || status === "partially_delivered"
    ? "bg-[#f59e0b]"
    : "bg-[#60a5fa] animate-pulse";
  return (
    <div
      data-testid="visual-context-delivery-status"
      data-status={status}
      data-recognition={terminalWithoutObservation ? "unverified" : recognition}
      aria-live="polite"
      className={`mt-2 flex items-center justify-end gap-1.5 text-[10px] leading-4 ${tone}`}
      title={summary || title}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="max-w-[280px] truncate">
        {title}{observed ? ` · ${observationSummary}` : ""}
      </span>
    </div>
  );
}

function getStageLabel(stage: any, language: "zh" | "en"): string {
  const zh: any = {
    idle: "待生成",
    plan: "计划",
    requirements: "需求",
    design: "历史计划",
    tasks: "任务",
    bugfix: "修复",
    ready_to_execute: "待执行",
    executing: "执行中",
    completed: "已完成",
  };
  const en: any = {
    idle: "Idle",
    plan: "Plan",
    requirements: "Requirements",
    design: "Legacy Plan",
    tasks: "Tasks",
    bugfix: "Bugfix",
    ready_to_execute: "Ready",
    executing: "Executing",
    completed: "Completed",
  };
  return (language === "zh" ? zh : en)[stage] || String(stage);
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
    case "success":
      return "border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.12)] text-[#34d399]";
    case "stopped_no_action":
    case "stopped_no_output":
    case "partial":
    case "blocked":
      return "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]";
    case "paused":
      return "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]";
    case "done":
      return "border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.12)] text-[#34d399]";
    case "canceled":
      return "border-[rgba(161,161,170,0.28)] bg-[rgba(161,161,170,0.1)] text-[#a1a1aa]";
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
  chatFontSize = 13,
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
  chatFontSize?: number;
}) {
  const cleanTurnSummary = sanitizeAIOutput(turn.summary || "");
  const summaryText = (looksLikeReasoningLeakTitle(cleanTurnSummary) ? "" : cleanTurnSummary) || sanitizeAIOutput(fallbackSummary || "") || copy.collapsedSummary;
  const shellClass = embedded
    ? "rounded-none bg-transparent px-1 py-1"
    : "rounded-2xl border border-[#1f1f23] bg-[#09090b] px-4 py-3";

  return (
    <div data-testid="turn-summary-card" className={shellClass}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[#71717a] flex items-center gap-1.5">
            <IconFileText className="h-3.5 w-3.5 shrink-0" />
            {copy.summary}
          </div>
          <div className="mt-2 text-[13px] leading-relaxed text-[#e4e4e7]">
            <MarkdownRenderer
              content={summaryText}
              baseFontSize={chatFontSize}
              sourceId={`turn-summary-${turn.id}`}
            />
          </div>
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
  const isPlanGenerationFailure = isPlanGenerationFailureBlock(block);
  const isPlanCheckpoint = block.variant === "plan_execution_checkpoint";
  const isExecutionCheckpoint = block.variant === "execution_checkpoint";
  const isCheckpoint = isPlanCheckpoint || isExecutionCheckpoint;
  const progress = block.planExecutionProgress || null;
  const progressPhase = String(block.planExecutionProgress?.phase || "");
  const isPaused = progressPhase === "paused" || /已暂停|paused/i.test(String(block.content || ""));
  const title = isPlanGenerationFailure
    ? language === "zh" ? "计划草稿未通过校验" : "Plan Draft Needs Revision"
    : isExecutionCheckpoint
    ? language === "zh" ? "执行结果与恢复点" : "Execution Results & Recovery Point"
    : isCheckpoint
    ? language === "zh" ? "计划执行检查点" : "Plan Execution Checkpoint"
    : isPaused
    ? language === "zh" ? "计划执行已暂停" : "Plan Execution Paused"
    : language === "zh" ? "计划执行进度" : "Plan Execution Progress";
  const details = progress
    ? isPlanGenerationFailure
      ? [
          { label: language === "zh" ? "待补内容" : "Missing", value: progress.nextStep },
        ].filter((item) => String(item.value || "").trim())
      : [
        { label: language === "zh" ? "当前任务" : "Task", value: progress.currentTask },
        { label: language === "zh" ? "当前动作" : "Action", value: progress.currentTool },
        { label: language === "zh" ? "最新证据" : "Evidence", value: progress.latestEvidence },
        { label: language === "zh" ? "下一步" : "Next", value: progress.nextStep },
      ].filter((item) => String(item.value || "").trim())
    : [];
  const repeatedTargets = Array.isArray(progress?.repeatedTargets)
    ? progress.repeatedTargets.filter(Boolean).slice(0, 4)
    : [];
  const recoveryReason = isPlanGenerationFailure ? "" : String(progress?.recoveryReason || "").trim();

  return (
    <div className="flex w-full justify-center">
      <div
        data-testid={block.variant}
        data-plan-generation-failure={isPlanGenerationFailure || undefined}
        className="theme-plan-surface theme-plan-text max-w-[min(760px,92%)] rounded-lg border px-3 py-2 text-left"
      >
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#a1a1aa]">{title}</div>
        <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-[#e4e4e7]">{String(block.content || "")}</div>
        {details.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-[rgba(161,161,170,0.16)] pt-2 text-[11px] leading-4 text-[#a1a1aa]">
            {details.map((item) => (
              <div key={item.label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                <span className="shrink-0 text-[#71717a]">{item.label}</span>
                <span className="min-w-0 break-words text-[#d4d4d8]">{String(item.value || "")}</span>
              </div>
            ))}
            {(repeatedTargets.length > 0 || recoveryReason) && (
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                <span className="shrink-0 text-[#71717a]">{language === "zh" ? "恢复信息" : "Recovery"}</span>
                <span className="min-w-0 break-words text-[#d4d4d8]">
                  {[recoveryReason, repeatedTargets.length > 0 ? repeatedTargets.join(", ") : ""].filter(Boolean).join(" · ")}
                </span>
              </div>
            )}
          </div>
        )}
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

function isFinishedTurnStatus(status: string) {
  return status === "done" ||
    status === "completed" ||
    status === "completed_with_changes" ||
    status === "success" ||
    status === "partial" ||
    status === "blocked" ||
    status === "error" ||
    status === "canceled";
}

function getLatestThoughtBlock(blocks: any[]) {
  return [...blocks].reverse().find((block) => block?.type === "thought" && String(block.content || "").trim());
}

function TurnActivityNotice({
  thoughtSummaryText,
  isThinking,
  language,
  chatFontSize,
}: {
  thoughtSummaryText?: string;
  isThinking?: boolean;
  language: "zh" | "en";
  chatFontSize: number;
  text?: string;
}) {
  const resolvedThoughtSummaryText = String(thoughtSummaryText || "").trim();
  if (!resolvedThoughtSummaryText) return null;
  const thoughtTitle = language === "zh"
    ? isThinking ? "正在整理思路" : "思考摘要"
    : isThinking ? "Thinking" : "Thinking summary";
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
    </div>
  );
}

function SubagentActivityNotice({
  runs,
  language,
  onOpen,
}: {
  runs: ReturnType<typeof projectSubagentRuns>;
  language: "zh" | "en";
  onOpen: (id?: string) => void;
}) {
  if (runs.length === 0) return null;
  const activeRuns = runs.filter((run) => isSubagentActiveStatus(run.status));
  const closedRuns = runs.filter((run) => !!run.closedAt);
  const latestRun = runs[runs.length - 1];
  const rows = [
    {
      key: "created",
      icon: IconSubagent,
      text: language === "zh" ? `已创建 ${runs.length} 个智能体` : `Created ${runs.length} subagent${runs.length === 1 ? "" : "s"}`,
      id: latestRun?.id,
      active: false,
    },
    ...(closedRuns.length > 0 ? [{
      key: "closed",
      icon: IconSubagentClosed,
      text: language === "zh" ? `已关闭 ${closedRuns.length} 个智能体` : `Closed ${closedRuns.length} subagent${closedRuns.length === 1 ? "" : "s"}`,
      id: closedRuns[closedRuns.length - 1]?.id,
      active: false,
    }] : []),
    ...activeRuns.slice(-3).map((run) => ({
      key: run.id,
      icon: IconSubagent,
      text: `${run.name} · ${run.progress?.title || (language === "zh" ? "正在执行" : "Running")}${run.progress?.target ? `：${String(run.progress.target).split("/").pop()}` : ""}`,
      id: run.id,
      active: true,
    })),
  ];

  return (
    <div data-testid="subagent-activity-notice" className="ml-9 w-full max-w-[min(760px,calc(100%-2.25rem))] py-1">
      <div className="space-y-0.5">
        {rows.map((row) => {
          const RowIcon = row.icon;
          return (
            <button
              key={row.key}
              type="button"
              data-testid={`subagent-activity-${row.key}`}
              onClick={() => onOpen(row.id)}
              title={language === "zh" ? "查看子智能体执行详情" : "Inspect subagent activity"}
              aria-label={`${row.text}，${language === "zh" ? "打开子智能体面板" : "open subagents panel"}`}
              className="group flex min-h-8 w-full min-w-0 items-center gap-3 rounded-[6px] px-2 py-1 text-left text-[12px] text-[var(--surface-text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_7%,transparent)] hover:text-[var(--surface-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--surface-text-muted)] group-hover:text-[var(--accent-light)]">
                {row.active
                  ? <span className="h-2 w-2 rounded-full bg-[#60a5fa] shadow-[0_0_7px_rgba(96,165,250,0.75)] animate-pulse" />
                  : <RowIcon className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.text}</span>
              <IconChevronRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          );
        })}
      </div>
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
  const [isRawOpen, setIsRawOpen] = useState(false);
  const [renderLimit, setRenderLimit] = useState(20000);

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

  const hasMore = rawContent.length > renderLimit;
  const displayContent = hasMore
    ? rawContent.slice(0, renderLimit) + "\n\n...(truncated for performance)..."
    : rawContent;

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

        {/* Accordion for Raw Reasoning */}
        <div className="mt-3 pt-2 border-t border-[#27272a]/60">
          <button
            type="button"
            onClick={() => setIsRawOpen(prev => !prev)}
            className="flex items-center gap-1 font-mono text-[10px] text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
          >
            {isRawOpen ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
            <span>
              {language === "zh"
                ? `${isRawOpen ? "收起" : "查看"}原始推理 (${formatTokenCount(rawContent.length)} 字符)`
                : `${isRawOpen ? "Hide" : "Show"} Raw Reasoning (${formatTokenCount(rawContent.length)} chars)`}
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
                sourceId={`thought-raw-${block.id ?? "current"}`}
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
      </div>
    </div>
  );
}



function TurnPhaseDivider({ label }: { label: string }) {
  return (
    <div data-testid="turn-phase-divider" className="ml-9 flex items-center gap-3 py-1">
      <span className="shrink-0 rounded-full border border-[var(--surface-border-soft)] bg-[var(--surface-1)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--surface-text-muted)]">
        {label}
      </span>
      <span className="h-px min-w-0 flex-1 bg-[color-mix(in_srgb,var(--accent)_32%,transparent)]" />
    </div>
  );
}

function TurnProcessDisclosure({
  collapsed,
  count,
  toolCount,
  changedFileCount,
  elapsedSeconds,
  summary,
  language,
  onToggle,
}: {
  collapsed: boolean;
  count: number;
  toolCount: number;
  changedFileCount: number;
  elapsedSeconds: number;
  summary?: string;
  language: "zh" | "en";
  onToggle: () => void;
}) {
  if (count <= 0) return null;
  const details = [
    language === "zh" ? `${toolCount} 个工具` : `${toolCount} tool${toolCount === 1 ? "" : "s"}`,
    language === "zh" ? `${changedFileCount} 个文件` : `${changedFileCount} file${changedFileCount === 1 ? "" : "s"}`,
    elapsedSeconds > 0 ? `${Math.round(elapsedSeconds)}s` : "",
  ].filter(Boolean).join(" · ");
  const action = collapsed
    ? language === "zh" ? "展开过程" : "Show process"
    : language === "zh" ? "收起过程" : "Hide process";
  const label = `${action}（${count} · ${details}）`;
  return (
    <button
      type="button"
      data-testid="turn-process-disclosure"
      data-process-collapsed={collapsed ? "true" : "false"}
      onClick={onToggle}
      title={summary || label}
      className="turn-process-disclosure ml-9 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium transition-colors"
      aria-expanded={!collapsed}
    >
      {collapsed ? <IconChevronRight className="h-3 w-3" /> : <IconChevronDown className="h-3 w-3" />}
      <span>{label}</span>
    </button>
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
        className="flex w-full min-w-0 flex-wrap items-start gap-2 rounded-xl border border-[#1f2937] bg-[#07070a] px-3 py-2 text-left transition-colors hover:border-[#374151] hover:bg-[#09090b]"
      >
        {expanded ? (
          <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        )}
        <IconCheck className="h-3.5 w-3.5 shrink-0 text-[#10b981]" />
        <span className="min-w-0 max-w-full break-words text-[12px] font-medium text-[#d4d4d8]">{title}</span>
        {previewText && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#71717a]">
            · {previewText}{hiddenCount > 0 ? ` +${hiddenCount}` : ""}
          </span>
        )}
        {duplicateText && (
          <span data-testid="read-context-group-dedupe" className="max-w-full whitespace-normal break-words rounded-full border border-[rgba(96,165,250,0.22)] bg-[rgba(37,99,235,0.08)] px-2 py-0.5 text-[10px] text-[#93c5fd]">
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
        className="flex w-full min-w-0 flex-wrap items-start gap-2 rounded-xl border border-[#1f2937] bg-[#07070a] px-3 py-2 text-left transition-colors hover:border-[#374151] hover:bg-[#09090b]"
      >
        {expanded ? (
          <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[#71717a]" />
        )}
        <IconCheck className="h-3.5 w-3.5 shrink-0 text-[#10b981]" />
        <span className="min-w-0 max-w-full break-words text-[12px] font-medium text-[#d4d4d8]">{title}</span>
        {typeSummary && (
          <span data-testid="completed-tool-group-type-summary" className="min-w-0 max-w-full break-words text-[11px] text-[#94a3b8]">
            · {typeSummary}
          </span>
        )}
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
      className="ml-9 max-w-[calc(100%-2.25rem)] min-w-0 overflow-hidden"
    >
      <button
        type="button"
        data-testid={buttonLegacyTestId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full min-w-0 flex-wrap items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        {expanded ? (
          <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--surface-text-muted)]" />
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--surface-text-muted)]" />
        )}
        <IconCheck className={`h-3.5 w-3.5 shrink-0 ${toneClass}`} />
        <span className="min-w-0 max-w-full break-words text-[13px] font-semibold text-[var(--surface-text)]">{cluster.title}</span>
        {cluster.countSummary && (
          <span data-testid="chat-operation-count-summary" className="min-w-0 max-w-full break-words text-[12px] text-[var(--surface-text-subtle)]">
            · {language === "zh" ? `已探索 ${cluster.countSummary}` : cluster.countSummary}
          </span>
        )}
        {cluster.previewText && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--surface-text-muted)]">
            · {cluster.previewText}
          </span>
        )}
        {duplicateText && (
          <span data-testid="read-context-group-dedupe" className="max-w-full whitespace-normal break-words rounded-full border border-[rgba(96,165,250,0.22)] bg-[rgba(37,99,235,0.08)] px-2 py-0.5 text-[10px] text-[#93c5fd]">
            {duplicateText}
          </span>
        )}
        <span className="max-w-full whitespace-normal break-words rounded-full border border-[var(--surface-border-soft)] px-2 py-0.5 text-[10px] text-[var(--surface-text-muted)]">
          {toggleText}
        </span>
      </button>

      {expanded && (
        <div
          data-testid="chat-operation-cluster-details"
          className="ml-6 mt-1.5 min-w-0 max-w-full space-y-1 overflow-hidden border-l border-[var(--surface-border-soft)] pl-3"
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
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="shrink-0 font-semibold text-[var(--surface-text)]">{item.label}</span>
                      <span className="min-w-0 truncate font-mono text-[var(--surface-text-subtle)]" title={item.target}>
                        {item.displayTarget}
                      </span>
                      {item.count > 1 && (
                        <span data-testid="read-context-item-repeat" className="max-w-full whitespace-normal break-words rounded-full border border-[var(--surface-border-soft)] px-1.5 py-0.5 text-[9px] text-[#93c5fd]">
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
  const hasChangeSummary = !!archive && archive.steps.some((step) =>
    step.kind === "edit" && collectTurnChangeEntries(step.items).entries.length > 0
  );
  const [expanded, setExpanded] = useState(hasChangeSummary);
  useEffect(() => {
    if (hasChangeSummary) setExpanded(true);
  }, [hasChangeSummary]);
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
    ? "turn-process-font-scope ml-9 max-w-[calc(100%-2.25rem)] min-w-0 overflow-hidden rounded-xl px-1 py-2 ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent-light)_50%,transparent)] transition-all duration-150"
    : "turn-process-font-scope ml-9 max-w-[calc(100%-2.25rem)] min-w-0 overflow-hidden rounded-xl px-1 py-2 ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent-light)_32%,transparent)] transition-all duration-150 hover:ring-[color-mix(in_srgb,var(--accent-light)_44%,transparent)]";

  const thoughtSteps = archive.steps.filter((step) => step.kind === "thinking");
  const timelineSteps = archive.steps.filter((step) => step.kind !== "thinking");

  return (
    <div className={containerClassName} style={getTurnProcessFontStyle(chatFontSize)}>
      <button
        type="button"
        data-testid="turn-process-archive-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
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
        <span className="inline-flex max-w-full items-center gap-1.5 px-1 py-1 text-[10px] text-[var(--surface-text-muted)]">
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
        <code key={`${keyPrefix}-code-${index}`} className="max-w-full whitespace-normal break-all rounded border border-[var(--surface-border-soft)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-1 py-[1px] font-mono text-[0.92em] text-[var(--surface-text)]">
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
  return String(text || "").replace(/\r\n/g, "\n").split("\n").map((line, lineIndex) => {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = headerMatch[2];
      const sizeClass = level === 1 ? "text-lg font-bold" : level === 2 ? "text-base font-semibold" : "text-sm font-semibold";
      return (
        <span key={`compact-md-line-${lineIndex}`} className={`block ${sizeClass} text-[var(--surface-text-strong)] my-1`}>
          {renderCompactMarkdownInline(content, `compact-md-${lineIndex}`)}
        </span>
      );
    }
    return (
      <React.Fragment key={`compact-md-line-${lineIndex}`}>
        {lineIndex > 0 && <br />}
        {renderCompactMarkdownInline(line, `compact-md-${lineIndex}`)}
      </React.Fragment>
    );
  });
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
  const { entries, totalExecutedEdits } = collectTurnChangeEntries(step.items);
  const hasChangeSummary = step.kind === "edit" && entries.length > 0;
  const defaultExpanded = (!isLive && (step.expandedByDefault || hasChangeSummary)) || (isLive && hasChangeSummary);
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (isLive && hasChangeSummary) setExpanded(true);
  }, [isLive, hasChangeSummary]);
  const detailItems = buildBlockRenderItems(step.items, false, false, language);
  const isLiveRunningWithoutChanges = isLive && step.status === "running" && !hasChangeSummary;
  const canExpandDetails = !isLiveRunningWithoutChanges && (hasChangeSummary || detailItems.length > 0);
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
        {isLive && summaryText && summaryText !== primaryText && (
          <span className="mt-0.5 block whitespace-pre-wrap break-words text-[11px] leading-4 text-[var(--surface-text-muted)]">
            {renderCompactMarkdownText(summaryText)}
          </span>
        )}
      </span>
      {canExpandDetails && (
        <span className="inline-flex max-w-full items-center gap-1.5 px-1 py-1 text-[10px] text-[var(--surface-text-muted)] transition-colors group-hover:text-[var(--surface-text)]">
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
      className="min-w-0 overflow-hidden border-t border-[var(--surface-border-soft)] py-2 first:border-t-0"
    >
      {canExpandDetails ? (
        <button
          type="button"
          data-testid="turn-archive-step-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="group flex w-full min-w-0 flex-wrap items-start gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex w-full min-w-0 flex-wrap items-start gap-3 rounded-lg px-1 py-1 text-left">
          {headerContent}
        </div>
      )}

      {canExpandDetails && expanded && (
        <div data-testid="turn-archive-step-details" className="mt-2 min-w-0 max-w-full space-y-2 overflow-hidden pl-6 sm:pl-8">
          {hasChangeSummary ? (
            <TurnChangesCard
              entries={entries}
              totalExecutedEdits={totalExecutedEdits}
              language={language}
              onOpenDiff={onOpenDiff}
              embedded
              defaultExpanded={hasChangeSummary}
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
  const hasChangeSummary = !!model && model.steps.some((step) =>
    step.kind === "edit" && collectTurnChangeEntries(step.items).entries.length > 0
  );
  // The turn-level disclosure is the primary process collapse control. When
  // that disclosure is open, expose the step rows immediately instead of
  // requiring a second nested expansion just to inspect the same process.
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (hasChangeSummary) setExpanded(true);
  }, [hasChangeSummary]);
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
      className="turn-process-font-scope ml-9 max-w-[calc(100%-2.25rem)] min-w-0 overflow-hidden rounded-xl px-1 py-2 ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent-light)_32%,transparent)] transition-all duration-150"
      style={getTurnProcessFontStyle(chatFontSize)}
    >
      <button
        type="button"
        data-testid="live-turn-process-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
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
        <span className="inline-flex max-w-full items-center gap-1.5 px-1 py-1 text-[10px] text-[var(--surface-text-muted)] transition-colors group-hover:text-[var(--surface-text)]">
          {expanded ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
          {toggleText}
        </span>
      </button>
      {expanded && (
        <div data-testid="live-turn-process-details" className="min-w-0 max-w-full space-y-2 overflow-hidden px-2 pt-2">
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
  const showReasoningDebug = useAppStore((s) => s.config.reasoningDisplay !== "hidden");
  const lastFailedAttempt = block.failedAttempts && block.failedAttempts.length > 0
    ? block.failedAttempts[block.failedAttempts.length - 1]
    : null;
  const isEscalating = !!block.isEscalating;
  const isDisplayingEscalationSnapshot = isEscalating && !String(block.content || "").trim() && lastFailedAttempt;

  const rawContent = String(isDisplayingEscalationSnapshot ? lastFailedAttempt.content : (block.content || ""));
  const displaySourceContent = useMemo(() => stripLeakedReasoning(sanitizeAssistantDisplayContent(rawContent)), [rawContent]);
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
    isDisplayingEscalationSnapshot ||
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
  const isArchivedProposal = !!block.archivedProposal;
  const archivedTitle = isArchivedProposal
    ? language === "zh" ? "已批准方案" : "Approved Proposal"
    : language === "zh" ? "已保留上一步反馈" : "Previous reply kept";
  const archivedAction = language === "zh" ? "展开回看" : "Expand";
  const archivedCollapse = isArchivedProposal
    ? language === "zh" ? "收起方案" : "Collapse Proposal"
    : language === "zh" ? "收起反馈" : "Collapse";
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
    <div
      data-testid={block.visibility === "assistant_final" ? "assistant-final" : undefined}
      data-turn-id={block.turnId || undefined}
      className="mt-4 flex w-full min-w-0 items-start justify-start gap-3"
    >
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
        {isEscalating && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-[#eab308]/20 bg-[#eab308]/5 px-3 py-2 text-[11.5px] text-[#f59e0b]">
            <svg className="animate-spin h-3.5 w-3.5 text-current shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>
              {block.escalationReason === "escalation"
                ? (language === "zh" ? `已达单次生成上限，正在进行第 ${(block.failedAttempts?.length || 0) + 1} 次扩容重新生成...` : `Output limit reached, escalating and regenerating (Attempt ${(block.failedAttempts?.length || 0) + 1})...`)
                : block.escalationReason === "language_mismatch"
                ? (language === "zh" ? "🔄 检测到输出语言不符，正在自动重试..." : "🔄 Output language mismatch detected, retrying...")
                : block.escalationReason === "missing_tool"
                ? (language === "zh" ? "🔄 模型未返回工具指令，正在重新引导重试..." : "🔄 No tool instructions returned, retrying...")
                : (language === "zh" ? "🔄 正在自动重试并修正输出..." : "🔄 Retrying and correcting output...")
              }
            </span>
          </div>
        )}
        <div className={isDisplayingEscalationSnapshot ? "opacity-45 select-none pointer-events-none" : ""}>
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
        </div>
        {isLongContent && !isDisplayingEscalationSnapshot && (
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
        {showReasoningDebug && block.failedAttempts && block.failedAttempts.length > 0 && (
          <div className="mt-4 space-y-2 border-t border-[#1f1f23] pt-3">
            <div className="text-[10px] font-mono text-[#71717a] uppercase tracking-wider">
              {language === "zh" ? "历史尝试记录" : "Failed Attempts History"} ({block.failedAttempts.length})
            </div>
            {block.failedAttempts.map((attempt: any, attIdx: number) => {
              const attemptTitle = attempt.reason === "escalation"
                ? (language === "zh" ? `尝试 ${attIdx + 1} (长度超限扩容)` : `Attempt ${attIdx + 1} (Escalated)`)
                : attempt.reason === "language_mismatch"
                ? (language === "zh" ? `尝试 ${attIdx + 1} (语言不符纠错)` : `Attempt ${attIdx + 1} (Language Mismatch)`)
                : attempt.reason === "missing_tool"
                ? (language === "zh" ? `尝试 ${attIdx + 1} (缺失工具纠错)` : `Attempt ${attIdx + 1} (Missing Tool)`)
                : (language === "zh" ? `尝试 ${attIdx + 1} (${attempt.reason})` : `Attempt ${attIdx + 1} (${attempt.reason})`);
              
              return (
                <details key={attIdx} className="group rounded-xl border border-[#27272a]/50 bg-[#07070a] px-3 py-2">
                  <summary className="flex cursor-pointer items-center justify-between font-mono text-[10.5px] text-[#a1a1aa] hover:text-[#e4e4e7]">
                    <span>{attemptTitle}</span>
                    <span className="text-[10px] text-[#71717a] group-open:hidden">{language === "zh" ? "展开" : "Expand"}</span>
                    <span className="text-[10px] text-[#71717a] hidden group-open:inline">{language === "zh" ? "收起" : "Collapse"}</span>
                  </summary>
                  <div className="mt-2 text-xs text-[#71717a] leading-relaxed max-h-[300px] overflow-y-auto pr-1 space-y-2">
                    {attempt.reasoning && (
                      <div className="rounded border border-[#1f1f23] bg-[#050507] p-2">
                        <div className="mb-1 font-semibold text-[9.5px] text-amber-500/80 uppercase">{language === "zh" ? "思考过程：" : "Thinking Process:"}</div>
                        <pre className="whitespace-pre-wrap break-all text-[10.5px] font-mono text-[#a1a1aa] leading-normal">{attempt.reasoning}</pre>
                      </div>
                    )}
                    {attempt.content && (
                      <div className="rounded border border-[#1f1f23] bg-[#050507] p-2">
                        <div className="mb-1 font-semibold text-[9.5px] text-blue-400/80 uppercase">{language === "zh" ? "输出文本：" : "Output Content:"}</div>
                        <pre className="whitespace-pre-wrap break-all text-[11px] font-mono text-[#e4e4e7] leading-normal">{attempt.content}</pre>
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
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

const TurnTimer = memo(function TurnTimer({
  turnId,
  status,
  isStreaming,
  currentTurnId,
  savedElapsedTime,
  isLightThemeMode,
}: {
  turnId: string;
  status: string;
  isStreaming: boolean;
  currentTurnId: string | null;
  savedElapsedTime?: number;
  isLightThemeMode: boolean;
}) {
  const storeElapsedTime = useAppStore((s) => s.elapsedTime);
  const isActive = turnId === currentTurnId && (isStreaming || status === "executing" || status === "planning");
  const persistedElapsedTime = Math.max(0, Number(savedElapsedTime) || 0);
  const timeToShow = Math.floor(isActive
    ? Math.max(persistedElapsedTime, Number(storeElapsedTime) || 0)
    : persistedElapsedTime);

  const minutes = Math.floor(timeToShow / 60);
  const seconds = timeToShow % 60;
  const timeString = minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;

  return (
    <span data-testid="turn-elapsed-time" className={`rounded-full border px-2 py-0.5 text-[10px] flex items-center gap-1.5 ${
      isActive 
        ? "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]" 
        : isLightThemeMode
        ? "border-[#d4d4d8] bg-[#f4f4f5] text-[#71717a]"
        : "border-[#27272a] bg-[#09090b] text-[#a1a1aa]"
    }`}>
      {isActive && <span className="h-1.5 w-1.5 rounded-full bg-[#fbbf24] animate-pulse" />}
      {timeString}
    </span>
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
  preferSubagents,
  onTogglePreferSubagents,
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
  const isLightThemeMode = config.themeMode === "light";
  const isBlackThemeMode = config.themeMode === "black";
  const resolvedChatFontSize = Math.min(20, Math.max(10, Number(config.chatFontSize) || 13));
  const resolvedTurnProcessFontSize = resolveTurnProcessFontSize(resolvedChatFontSize);
  const copy = useMemo(() => ({
    planLabel: language === "zh" ? "计划" : "Plan",
    stopLabel: language === "zh" ? "停止" : "Stop",
    processingLabel: language === "zh" ? "处理中..." : "Processing...",
    turnDetails: language === "zh" ? "回合详情" : "Turn Details",
    openPlan: language === "zh" ? "打开计划" : "Open Plan",
    viewPlan: language === "zh" ? "查看计划" : "View Plan",
    summary: language === "zh" ? "总结" : "Summary",
    collapsedSummary: language === "zh" ? "本轮过程已折叠，结论会优先保留在这里。" : "This turn is collapsed. The conclusion is kept here first.",
    expandHistory: (count: number) => language === "zh" ? `展开 ${count} 条过程记录` : `Expand ${count} process item(s)`,
    turnStatusLabels: language === "zh"
      ? { planning: "规划中", awaiting_approval: "待批准", awaiting_input: "待选择", executing: "执行中", completed_with_changes: "已完成并写入", stopped_no_action: "已停止，未执行", stopped_no_output: "未生成可见回复", paused: "已暂停", success: "已完成", partial: "部分完成", blocked: "已受阻", canceled: "已取消", done: "完成", error: "错误" }
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
    taskTracking: language === "zh" ? "任务跟踪" : "Task Tracking",
    noTasks: language === "zh" ? "暂无任务跟踪" : "No tasks to track",
    autoValidation: language === "zh" ? "自动验证" : "Auto validation",
    userValidation: language === "zh" ? "待用户验证" : "User validation",
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
    harnessRunMarker,
    activeActionRequest,
    openRightPanelTab,
    openSubagentsPanel,
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
    clearedPlanTurnId,
    planExecutionProgressSnapshot,
    approvePlan,
    approvePendingReviewOnce,
    approvePendingReviewForSession,
    rejectPlan,
    agentStatus,
    pendingReviewTaskId,
    pendingToolCall,
    pendingRunDecision,
    resolvePendingRunDecision,
    dismissPendingRunDecision,
    imageStudio,
    setImageStudioSetupGuideOpen,
    checkImageStudioEngine,
    activeGoal,
    goalProgress,
    goalStatus,
    goalRuntime,
  } = {
    showDiff: useAppStore((s) => s.showDiff),
    showPlanPanel: useAppStore((s) => s.showPlanPanel),
    showTerminal: useAppStore((s) => s.showTerminal),
    showFilePanel: useAppStore((s) => s.showFilePanel),
    rightPanelTab: useAppStore((s) => s.rightPanelTab),
    runtimeEvents: useAppStore((s) => s.runtimeEvents),
    harnessRunMarker: useAppStore((s) => s.harnessRunMarker),
    activeActionRequest: useAppStore((s) => s.activeActionRequest),
    openRightPanelTab: useAppStore((s) => s.openRightPanelTab),
    openSubagentsPanel: useAppStore((s) => s.openSubagentsPanel),
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
    clearedPlanTurnId: useAppStore((s) => s.clearedPlanTurnId),
    planExecutionProgressSnapshot: useAppStore((s) => s.planExecutionProgressSnapshot),
    approvePlan: useAppStore((s) => s.approvePlan),
    approvePendingReviewOnce: useAppStore((s) => s.approvePendingReviewOnce),
    approvePendingReviewForSession: useAppStore((s) => s.approvePendingReviewForSession),
    rejectPlan: useAppStore((s) => s.rejectPlan),
    agentStatus: useAppStore((s) => s.agentStatus),
    pendingReviewTaskId: useAppStore((s) => s.pendingReviewTaskId),
    pendingToolCall: useAppStore((s) => s.pendingToolCall),
    pendingRunDecision: useAppStore((s) => s.pendingRunDecision),
    resolvePendingRunDecision: useAppStore((s) => s.resolvePendingRunDecision),
    dismissPendingRunDecision: useAppStore((s) => s.dismissPendingRunDecision),
    imageStudio: useAppStore((s) => s.imageStudio),
    setImageStudioSetupGuideOpen: useAppStore((s) => s.setImageStudioSetupGuideOpen),
    checkImageStudioEngine: useAppStore((s) => s.checkImageStudioEngine),
    activeGoal: useAppStore((s) => s.activeGoal),
    goalProgress: useAppStore((s) => s.goalProgress),
    goalStatus: useAppStore((s) => s.goalStatus),
    goalRuntime: useAppStore((s) => s.goalRuntime),
  };
  const subagentRuns = useMemo(() => projectSubagentRuns(runtimeEvents), [runtimeEvents]);
  const turnRuntimeCheckpoints = useAppStore((s) => s.turnRuntimeCheckpoints);
  const activeSessionEpoch = useAppStore((s) => {
    const workspaceKey = resolveSessionWorkspaceKey(currentWorkspace);
    const session = (s.sessionsByWorkspace[workspaceKey] || []).find(
      (candidate) => candidate.id === s.currentSessionId,
    );
    const persistedEpoch = String(session?.planLifecycleEpoch || "").trim();
    if (persistedEpoch) return persistedEpoch;
    return s.planLifecycle?.sessionKey === activeSessionKey
      ? String(s.planLifecycle.sessionEpoch || "").trim() || null
      : null;
  });
  const visualContextProgressByTurnId = useMemo(() => {
    const latestByTurnId = new Map<string, { timestampMs: number; progress: any }>();
    const terminalAtByTurnId = new Map<string, number>();
    for (const event of Array.isArray(runtimeEvents) ? runtimeEvents : []) {
      const turnId = String(event.turnId || "").trim();
      if (!turnId) continue;
      const timestampMs = Number(event.timestampMs) || 0;
      if (
        event?.type === "turn.completed" ||
        event?.type === "run.completed"
      ) {
        terminalAtByTurnId.set(turnId, Math.max(terminalAtByTurnId.get(turnId) || 0, timestampMs));
        continue;
      }
      if (event?.type !== "progress.updated" || event?.progress?.tool !== "visual_context") continue;
      if (!event.progress?.visualContext) continue;
      const previous = latestByTurnId.get(turnId);
      if (!previous || timestampMs >= previous.timestampMs) {
        latestByTurnId.set(turnId, { timestampMs, progress: event.progress });
      }
    }
    return new Map(
      [...latestByTurnId.entries()].map(([turnId, value]) => [
        turnId,
        {
          ...value.progress,
          visualRunTerminal: (terminalAtByTurnId.get(turnId) || 0) >= value.timestampMs,
        },
      ]),
    );
  }, [runtimeEvents]);
  const isImageStudioMode = selectedMainModeKey === "image_studio";
  const isWebFallbackImageEngine = imageStudio.config.provider === "web_fallback";
  const imageStudioLocalFamilyLabel = imageStudio.config.local.serviceFamily === "ollama"
    ? "Ollama"
    : imageStudio.config.local.serviceFamily === "omlx"
    ? "OMLX"
    : (language === "en" ? "OpenAI-compatible" : "OpenAI 兼容");
  const imageStudioProviderLabel = isWebFallbackImageEngine
    ? (language === "en" ? "HiDream Web" : "HiDream 网页")
    : (language === "en" ? "Local Image Service" : "本地图片服务");
  const imageStudioProviderDetail = isWebFallbackImageEngine
    ? (language === "en" ? "Hosted fallback" : "托管 fallback")
    : `${imageStudioLocalFamilyLabel} · ${imageStudio.status.activeModel || imageStudio.config.local.model || imageStudio.config.local.endpoint}`;
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
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [activeVisibleTurnId, setActiveVisibleTurnId] = useState<string | null>(null);
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false);
  // region: 输入区上方执行胶囊状态
  const [composerHeight, setComposerHeight] = useState(220);
  const [previewImageItem, setPreviewImageItem] = useState<UserContextItem | null>(null);
  const [chatAreaHeight, setChatAreaHeight] = useState(0);
  const [isCapsuleCollapsed, setIsCapsuleCollapsed] = useState(false);
  const [capsulePopover, setCapsulePopover] = useState<"progress" | "tasks" | "goal" | null>(null);
  const showProgressPopover = capsulePopover === "progress";
  const showTasksPopover = capsulePopover === "tasks";
  const showGoalPopover = capsulePopover === "goal";
  const popoverRef = useRef<HTMLDivElement>(null);
  const mButtonRef = useRef<HTMLButtonElement>(null);
  const runStatusCloseButtonRef = useRef<HTMLButtonElement>(null);
  const wasProgressPopoverOpenRef = useRef(false);
  const tasksPopoverRef = useRef<HTMLDivElement>(null);
  const tasksButtonRef = useRef<HTMLButtonElement>(null);
  const goalPopoverRef = useRef<HTMLDivElement>(null);
  const goalButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!capsulePopover) return;
    const handleDocumentClick = (event: MouseEvent) => {
      const popoverElement = capsulePopover === "progress"
        ? popoverRef.current
        : capsulePopover === "tasks"
        ? tasksPopoverRef.current
        : goalPopoverRef.current;
      const triggerElement = capsulePopover === "progress"
        ? mButtonRef.current
        : capsulePopover === "tasks"
        ? tasksButtonRef.current
        : goalButtonRef.current;
      const eventPath = event.composedPath();
      if (
        (!popoverElement || !eventPath.includes(popoverElement))
        && (!triggerElement || !eventPath.includes(triggerElement))
      ) {
        setCapsulePopover(null);
      }
    };
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCapsulePopover(null);
    };
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [capsulePopover]);

  useEffect(() => {
    if (showProgressPopover) {
      wasProgressPopoverOpenRef.current = true;
      const frame = window.requestAnimationFrame(() => {
        runStatusCloseButtonRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!wasProgressPopoverOpenRef.current) return;
    wasProgressPopoverOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      mButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showProgressPopover]);

  useEffect(() => {
    setCapsulePopover(null);
  }, [isCapsuleCollapsed, activeSessionKey]);

  // endregion

  useEffect(() => {
    if (!chatContainerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setChatAreaHeight(entry.contentRect.height);
      }
    });
    resizeObserver.observe(chatContainerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  const blocksByTurnId = useMemo(() => {
    const next = new Map<string, any[]>();
    const legacyBlocks: any[] = [];
    for (const block of taskFlow) {
      if (block?.audience === "internal") continue;
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
  const recentImageBlocks = useMemo(
    () =>
      taskFlow
        .filter((block) => block?.type === "imageGeneration")
        .slice()
        .reverse()
        .slice(0, 8),
    [taskFlow],
  );

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
  const composerHasLiveTurnOwner = Boolean(
    currentWorkspace &&
    pinnedTurn &&
    !isConversationTurnRuntimeClosed(pinnedTurn.runtimeOutcome) &&
    (
      (
        harnessRunMarker?.status === "running" &&
        harnessRunMarker.sessionKey === activeSessionKey &&
        harnessRunMarker.turnId === pinnedTurn.id
      ) ||
      (
        agentStatus === "running" &&
        (pinnedTurn.status === "planning" || pinnedTurn.status === "executing")
      )
    )
  );
  // Streaming is still a valid immediate signal. The durable Turn/Run owner
  // covers the gaps between model chunks where isGenerating may briefly drop.
  const composerRunActive = isStreaming || composerHasLiveTurnOwner;
  const composerRuntimeOwnerObserved = composerRunActive ||
    agentStatus === "pending_review" ||
    (
      activeActionRequest?.status === "pending" &&
      activeActionRequest.sessionKey === activeSessionKey &&
      activeActionRequest.turnId === pinnedTurn?.id
    );
  const composerTurnIngress = useMemo(() => selectTurnIngressAvailability({
    checkpoint: pinnedTurn ? turnRuntimeCheckpoints?.[pinnedTurn.id] : null,
    expectedOwner: pinnedTurn && activeSessionKey && activeSessionEpoch
      ? {
          workspaceKey: resolveSessionWorkspaceKey(currentWorkspace),
          sessionKey: activeSessionKey,
          sessionEpoch: activeSessionEpoch,
          turnId: pinnedTurn.id,
        }
      : null,
    strategy: resolveTurnStrategyFromIntent(pinnedTurn?.intent, pinnedTurn?.mode),
    runtimeOwnerObserved: composerRuntimeOwnerObserved,
  }), [
    activeSessionEpoch,
    activeSessionKey,
    composerRuntimeOwnerObserved,
    currentWorkspace,
    pinnedTurn,
    turnRuntimeCheckpoints,
  ]);
  const shouldKeepExecutionCapsuleResident =
    !!pinnedTurn &&
    !isConversationTurnRuntimeClosed(pinnedTurn.runtimeOutcome) &&
    (
      pinnedTurn.status === "executing" ||
      pinnedTurn.status === "awaiting_input" ||
      pinnedTurn.status === "awaiting_approval" ||
      agentStatus === "pending_review" ||
      agentStatus === "running" ||
      isStreaming
    );
  const capsuleControlTurn = shouldKeepExecutionCapsuleResident ? pinnedTurn : activeTurn;
  const capsuleControlTurnEntry = useMemo(() => {
    if (!capsuleControlTurn) return null;
    return groupedTurns.find((entry) => entry.turn?.id === capsuleControlTurn.id) || null;
  }, [groupedTurns, capsuleControlTurn]);
  const capsuleControlTurnBlocks = capsuleControlTurnEntry?.blocks || EMPTY_CHAT_BLOCKS;
  const pinnedPlanTurn = pinnedTurn && isPlanConversationTurn(pinnedTurn)
    ? pinnedTurn
    : null;
  const harnessActionRunId = getHarnessActionRunId(harnessRunMarker);
  const planReviewOwnerTurn = activeActionRequest?.kind === "plan_review"
    ? conversationTurns.find((turn) => turn.id === activeActionRequest.turnId) || null
    : null;
  const currentPlanApprovalIdentity = useMemo(
    () => buildTypedPlanApprovalIdentity(planArtifacts),
    [planArtifacts],
  );
  const hasReviewablePlanArtifact = !!currentPlanApprovalIdentity;
  const planReviewActionRequest =
    activeActionRequest?.kind === "plan_review" &&
    isPlanConversationTurn(planReviewOwnerTurn) &&
    isPlanReviewCapsulePresentationEligible({
      actionKind: activeActionRequest.kind,
      requestStatus: activeActionRequest.status,
      requestSessionKey: activeActionRequest.sessionKey,
      requestTurnId: activeActionRequest.turnId,
      requestRunId: activeActionRequest.runId,
      requestPlanRevision: activeActionRequest.planRevision,
      requestArtifactHash: activeActionRequest.artifactHash,
      markerStatus: harnessRunMarker?.status,
      markerSessionKey: harnessRunMarker?.sessionKey,
      markerTurnId: harnessRunMarker?.turnId,
      markerRunId: harnessActionRunId,
      expectedSessionKey: activeSessionKey,
      expectedTurnId: currentTurnId,
      currentPlanRevision: currentPlanApprovalIdentity?.revision,
      currentArtifactHash: currentPlanApprovalIdentity?.artifactHash,
    })
      ? activeActionRequest
      : null;
  const planProgressOwnerTurn = planExecutionProgressSnapshot?.turnId
    ? conversationTurns.find((turn) =>
        turn.id === planExecutionProgressSnapshot.turnId && isPlanConversationTurn(turn)
      ) || null
    : null;
  const reviewReadyPlanTurnId = [...groupedTurns].reverse().find((entry) =>
    isPlanConversationTurn(entry.turn) && hasGeneratedPlanContent(entry.blocks)
  )?.turn?.id || null;
  const planArtifactOwnerTurnId = resolvePlanArtifactOwnerTurnId({
    hasReviewableArtifact: hasReviewablePlanArtifact,
    actionOwnerTurnId: planReviewActionRequest?.turnId,
    progressOwnerTurnId: planProgressOwnerTurn?.id,
    reviewReadyTurnId: reviewReadyPlanTurnId,
  });
  const activePlanFallbackPreview = useMemo(() => {
    if (!pinnedPlanTurn) return "";
    if (pinnedPlanTurn.id === planArtifactOwnerTurnId) return "";
    if (clearedPlanTurnId && pinnedPlanTurn.id === clearedPlanTurnId) return "";
    const entry = groupedTurns.find((item) => item.turn?.id === pinnedPlanTurn.id);
    if (!entry) return "";
    return selectLatestPlanCandidatePreview(entry.blocks);
  }, [clearedPlanTurnId, groupedTurns, pinnedPlanTurn?.id, planArtifactOwnerTurnId]);
  const userChoiceActionRequest =
    activeActionRequest?.kind === "user_choice" &&
    activeActionRequest.status === "pending" &&
    !!activeSessionKey &&
    activeActionRequest.sessionKey === activeSessionKey &&
    activeActionRequest.turnId === currentTurnId &&
    harnessRunMarker?.status === "paused" &&
    harnessRunMarker.sessionKey === activeActionRequest.sessionKey &&
    harnessRunMarker.turnId === activeActionRequest.turnId &&
    harnessActionRunId === activeActionRequest.runId
      ? activeActionRequest
      : null;
  const userChoiceOwnerTurn = userChoiceActionRequest
    ? conversationTurns.find((turn) => turn.id === userChoiceActionRequest.turnId) || null
    : null;
  const userChoiceOwnerBlocks = userChoiceActionRequest
    ? blocksByTurnId.byTurnId.get(userChoiceActionRequest.turnId) || EMPTY_CHAT_BLOCKS
    : EMPTY_CHAT_BLOCKS;
  const userChoiceAgentBlock = userChoiceActionRequest
    ? [...userChoiceOwnerBlocks].reverse().find((block) =>
        block.type === "agent" &&
        block.choiceRequest?.requestId === userChoiceActionRequest.requestId &&
        Array.isArray(block.options)
      ) || null
    : null;
  const userChoiceReplyOptions = userChoiceActionRequest
    ? (() => {
        const blockOptions = Array.isArray(userChoiceAgentBlock?.options)
          ? userChoiceAgentBlock.options
          : [];
        const expectedValues = new Set(userChoiceActionRequest.optionValues.map((value) => String(value).trim()));
        const exactOptions = blockOptions.filter((option) =>
          expectedValues.has(String(option?.value || option?.label || "").trim())
        );
        return exactOptions.length === userChoiceActionRequest.optionValues.length
          ? exactOptions
          : userChoiceActionRequest.optionValues.map((value) => ({ label: value, value }));
      })()
    : [];
  useEffect(() => {
    if (!planReviewActionRequest && !userChoiceActionRequest) return;
    setIsCapsuleCollapsed(false);
    setCapsulePopover(null);
  }, [planReviewActionRequest?.requestId, userChoiceActionRequest?.requestId]);
  const capsuleControlTurnVisibleStatus = useMemo(() => {
    if (!capsuleControlTurn) return null;

    return deriveVisibleConversationTurnStatus({
      baseStatus: capsuleControlTurn.status,
      runtimeOutcome: capsuleControlTurn.runtimeOutcome,
      turnIntent: resolveConversationTurnIntent(capsuleControlTurn),
      isPinnedPlanTurnVisible: !!pinnedPlanTurn && capsuleControlTurn.id === pinnedPlanTurn.id,
      isPlanApproved,
      planStage,
      agentStatus,
      hasIncompletePlanTasks: !buildPlanTaskEvidenceAudit({ tasks: planTasks, evidenceLedger: planExecutionEvidenceLedger }).allTrustedComplete,
      hasTasksArtifact:
        planArtifacts.some((artifact) => artifact.kind === "tasks") ||
        planTasks.length > 0,
    });
  }, [agentStatus, isPlanApproved, pinnedPlanTurn, planArtifacts, planExecutionEvidenceLedger, planStage, planTasks, capsuleControlTurn]);
  const shouldShowPinnedPlanTasks =
    !!pinnedPlanTurn &&
    (isPlanApproved || planStage === "executing" || planStage === "completed");
  const capsuleControlExecutionSteps = useMemo(() => {
    if (!capsuleControlTurn) return [];
    if (isPlanConversationTurn(capsuleControlTurn)) return [];
    return deriveTurnProgressItems(capsuleControlTurnBlocks, language);
  }, [language, capsuleControlTurn, capsuleControlTurnBlocks]);
  const capsuleProgressMode = shouldShowPinnedPlanTasks ? "plan" : "execution";
  const auditedPlanTasks = useMemo(() => buildPlanTaskEvidenceAudit({ tasks: planTasks, evidenceLedger: planExecutionEvidenceLedger }).tasks, [planTasks, planExecutionEvidenceLedger]);
  const capsuleProgressItems = useMemo(() => {
    if (capsuleProgressMode === "plan") {
      return auditedPlanTasks
        .map((task) => ({
          id: task.id,
          text: task.text,
          complete: task.status === "completed" || task.status === "skipped",
          status: task.status,
          validationStatus: task.status === "completed"
            ? "none"
            : isPlanTaskAwaitingBrowserValidation(task, planExecutionEvidenceLedger)
            ? "browser"
            : isPlanTaskAwaitingExternalValidation(task, planExecutionEvidenceLedger)
            ? "user"
            : "none",
        }));
    }
    return (capsuleControlExecutionSteps || []).map((step, idx) => ({
      id: String(idx),
      text: step.text,
      complete: step.complete,
      status: step.complete ? "completed" : "in_progress",
      validationStatus: "none" as const,
    }));
  }, [capsuleProgressMode, auditedPlanTasks, planExecutionEvidenceLedger, capsuleControlExecutionSteps]);
  const capsuleHasTasks = capsuleProgressItems.length > 0;

  const capsulePlanExecutionSnapshot =
    pinnedPlanTurn &&
    !isConversationTurnRuntimeClosed(pinnedPlanTurn.runtimeOutcome) &&
    planExecutionProgressSnapshot?.turnId === pinnedPlanTurn.id &&
    isPlanApproved &&
    planStage !== "completed"
      ? planExecutionProgressSnapshot
      : null;
  const planExecutionCapsuleProjection = useMemo(
    () => buildPlanExecutionCapsuleProjection({
      snapshot: capsulePlanExecutionSnapshot,
      tasks: auditedPlanTasks,
      language,
    }),
    [auditedPlanTasks, capsulePlanExecutionSnapshot, language],
  );
  const currentPlanTaskId = capsuleProgressMode === "plan"
    ? planExecutionCapsuleProjection?.currentTaskId || null
    : null;

  const capsuleCompletedCount = capsuleProgressItems.filter((item) => item.complete).length;
  const capsuleProgress = capsuleProgressItems.length > 0 ? Math.round((capsuleCompletedCount / capsuleProgressItems.length) * 100) : 0;
  const composerPaddingBottom = composerHeight + 32;
  const capsuleTurn = capsuleControlTurn || activeTurn;
  const capsuleTurnBlocks = capsuleTurn
    ? blocksByTurnId.byTurnId.get(capsuleTurn.id) || EMPTY_CHAT_BLOCKS
    : EMPTY_CHAT_BLOCKS;
  const capsuleIsRunActive =
    !!capsuleTurn &&
    (
      isStreaming ||
      agentStatus === "running" ||
      agentStatus === "pending_review" ||
      capsuleTurn.status === "executing"
    );
  const capsuleHarnessRunId =
    capsuleTurn &&
    harnessRunMarker?.status === "running" &&
    harnessRunMarker.sessionKey === activeSessionKey &&
    harnessRunMarker.turnId === capsuleTurn.id
      ? harnessActionRunId
      : null;
  // A child execution checkpoint remains authoritative while a run is paused
  // for recovery or failure, when the harness marker is no longer `running`.
  // The approved child snapshot is installed before the old review lease has
  // fully closed, so it wins over a briefly still-running parent marker.
  const capsuleActiveRunId = capsulePlanExecutionSnapshot?.runId || capsuleHarnessRunId || null;
  const capsuleActiveLogicalTurnId =
    capsulePlanExecutionSnapshot?.runId === capsuleActiveRunId
      ? capsulePlanExecutionSnapshot.turnId
      : capsuleHarnessRunId === capsuleActiveRunId &&
        harnessRunMarker?.sessionKey === activeSessionKey
      ? harnessRunMarker.turnId
      : null;
  const capsuleProgressLedger = useMemo(() => {
    if (!capsuleTurn) return [];
    return buildRuntimeProgressLedger({
      blocks: capsuleTurnBlocks,
      events: runtimeEvents,
      turnId: capsuleTurn.id,
      language,
      maxItems: 12,
      activeRunId: capsuleActiveRunId,
      planExecutionSnapshot: capsulePlanExecutionSnapshot,
    });
  }, [
    capsuleActiveRunId,
    capsulePlanExecutionSnapshot,
    capsuleTurn,
    capsuleTurnBlocks,
    language,
    runtimeEvents,
  ]);
  const capsuleRunStatus = useMemo(
    () => buildRunStatusProjection(capsuleProgressLedger, language, 3),
    [capsuleProgressLedger, language],
  );

  const hasLivePlanWorkspaceContent = useMemo(() => hasLivePlanWorkspace({
    planArtifacts,
    planTasks,
    planStage,
    fallbackPlanPreview: activePlanFallbackPreview,
  }), [activePlanFallbackPreview, planArtifacts, planStage, planTasks]);
  const permissionActionRequest = activeActionRequest?.kind === "tool_permission" &&
    !!activeSessionKey &&
    activeActionRequest.sessionKey === activeSessionKey
    ? activeActionRequest
    : null;
  const permissionResolutionIdentity = permissionActionRequest
    ? getToolPermissionResolutionIdentity(permissionActionRequest)
    : null;
  const permissionRequestHasExactRuntimeOwner = shouldRenderPermissionCapsule({
    request: permissionActionRequest,
    sessionKey: activeSessionKey || "",
    turnId: harnessRunMarker?.status === "running" && harnessRunMarker.sessionKey === activeSessionKey
      ? harnessRunMarker.turnId
      : null,
    runId: harnessRunMarker?.status === "running" && harnessRunMarker.sessionKey === activeSessionKey
      ? harnessActionRunId
      : null,
    requestId: permissionResolutionIdentity?.requestId,
    taskId: pendingReviewTaskId,
  });
  const capsuleControlTurnStatusKey = capsuleControlTurnVisibleStatus || capsuleControlTurn?.status || null;
  const capsuleControlIsRunActive =
    agentStatus === "running" &&
    !!capsuleControlTurn &&
    capsuleControlTurnStatusKey === "executing";
  const pendingToolReviewForExecutionCapsule = useMemo(() => {
    if (
      !permissionRequestHasExactRuntimeOwner ||
      !permissionActionRequest ||
      permissionActionRequest.taskId !== pendingReviewTaskId
    ) {
      return null;
    }
    return resolveVisiblePendingToolReview({
      taskFlow,
      request: permissionActionRequest,
      pendingReviewTaskId,
      pendingToolCall,
      activeDiffTask,
    });
  }, [
    activeDiffTask,
    pendingReviewTaskId,
    pendingToolCall,
    permissionActionRequest,
    permissionRequestHasExactRuntimeOwner,
    taskFlow,
  ]);
  const pendingToolArgumentDisclosure = useMemo(() => {
    if (
      !permissionRequestHasExactRuntimeOwner ||
      !permissionActionRequest?.toolCallId ||
      pendingToolCall?.toolCallId !== permissionActionRequest.toolCallId ||
      pendingToolCall?.name !== permissionActionRequest.toolName
    ) {
      return null;
    }
    return getPendingToolReviewArgumentDisclosure(pendingToolCall);
  }, [
    pendingToolCall,
    permissionActionRequest,
    permissionRequestHasExactRuntimeOwner,
  ]);
  const capsuleControlHasChoiceContext =
    !!pendingToolReviewForExecutionCapsule;
  const shouldShowExecutionCapsuleNormally =
    !!capsuleControlTurn &&
    capsuleControlTurnStatusKey !== "done" &&
    capsuleControlTurnStatusKey !== "completed_with_changes" &&
    capsuleControlHasChoiceContext;
  const shouldShowExecutionCapsule =
    !!capsuleControlTurn &&
    capsuleControlTurn.id === permissionResolutionIdentity?.turnId &&
    !!pendingToolReviewForExecutionCapsule &&
    (capsuleControlHasChoiceContext || shouldShowExecutionCapsuleNormally);

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

  const togglePanelTab = useCallback((tab: "plan" | "diff" | "terminal" | "subagents" | "file") => {
    const isCurrentlyOpen =
      (tab === "plan" && showPlanPanel && rightPanelTab === "plan") ||
      (tab === "diff" && showDiff && rightPanelTab === "diff") ||
      (tab === "terminal" && showTerminal && rightPanelTab === "terminal") ||
      (tab === "subagents" && rightPanelTab === "subagents") ||
      (tab === "file" && showFilePanel);

    if (isCurrentlyOpen) {
      if (tab === "file") {
        closeFilePanel();
        return;
      }
      closeRightPanel();
      return;
    }

    if (tab === "file") {
      if (!currentWorkspace) return;
      openFileTreePanel();
      return;
    }
    if (tab === "subagents") {
      openSubagentsPanel();
      return;
    }
    openRightPanelTab(tab);
  }, [closeFilePanel, closeRightPanel, currentWorkspace, openFileTreePanel, openRightPanelTab, openSubagentsPanel, rightPanelTab, showDiff, showFilePanel, showPlanPanel, showTerminal]);

  const renderBlock = (block, index) => {
    if (block.type === "user") {
      const existingContextItems = Array.isArray(block.contextItems) ? block.contextItems : [];
      const blockImages = Array.isArray(block.images)
        ? block.images.filter((dataUrl: unknown): dataUrl is string => typeof dataUrl === "string" && dataUrl.length > 0)
        : [];
      let imageCursor = 0;
      const hydratedContextItems = existingContextItems.map((item: UserContextItem) => {
        if (item.kind !== "image") return item;
        const fallbackPreview = blockImages[imageCursor];
        imageCursor += 1;
        return !item.previewDataUrl && !item.thumbnailDataUrl && fallbackPreview
          ? { ...item, previewDataUrl: fallbackPreview }
          : item;
      });
      const legacyImageItems = blockImages.slice(imageCursor)
        .map((dataUrl: string, relativeIndex: number) => {
          const imgIdx = imageCursor + relativeIndex;
          return {
            id: `legacy-image:${block.id}:${imgIdx}`,
            kind: "image",
            label: language === "en" ? `Image ${imgIdx + 1}` : `截图 ${imgIdx + 1}`,
            status: "ready",
            previewDataUrl: dataUrl,
          };
        });
      const userContextItems = [...hydratedContextItems, ...legacyImageItems];
      const hasImageContext = userContextItems.some((item: UserContextItem) => item.kind === "image");
      const visualContextProgress = hasImageContext
        ? visualContextProgressByTurnId.get(String(block.turnId || ""))
        : null;
      return (
        <div key={`${block.id}-${index}`} className="flex w-full justify-end">
          <div className="theme-subtle-bg theme-subtle-border max-w-[85%] rounded-2xl rounded-tr-sm border p-4">
            {block.runtimeGuidance?.id && (
              <div
                data-testid="runtime-guidance-record"
                data-guidance-id={block.runtimeGuidance.id}
                className="mb-2 flex items-center justify-end gap-1.5 text-[10px] font-semibold text-emerald-400"
              >
                <IconZap className="h-3 w-3" />
                {language === "en" ? "Guided this Turn" : "已引导本回合"}
              </div>
            )}
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
            {visualContextProgress && (
              <VisualContextDeliveryBadge
                progress={visualContextProgress}
                language={language}
              />
            )}
          </div>
        </div>
      );
    }

    if (block.type === "system") {
      if (block.variant === "context_compression") {
        return <ContextCompressionNotice key={`${block.id}-${index}`} block={block} language={language} />;
      }
      if (block.variant === "plan_quality_gate") {
        return <PlanExecutionSystemNotice key={`${block.id}-${index}`} block={block} language={language} />;
      }
      if (block.variant === "plan_execution_progress") {
        return <PlanExecutionSystemNotice key={`${block.id}-${index}`} block={block} language={language} />;
      }
      if (block.variant === "plan_execution_checkpoint") {
        return <PlanExecutionSystemNotice key={`${block.id}-${index}`} block={block} language={language} />;
      }
      if (block.variant === "execution_checkpoint") {
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

    if (block.type === "imageGeneration") {
      return (
        <div key={`${block.id}-${index}`} className="flex w-full justify-start">
          <ImageGenerationCard
            block={block}
            language={language}
            onRegenerate={(prompt) => onSendMessage?.(prompt)}
          />
        </div>
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
        (block.toolName === "write_file" || block.toolName === "replace_in_file" || block.toolName === "apply_patch");
      if (shouldHidePendingTool) return null;
      if (
        (block.toolName === "write_file" || block.toolName === "replace_in_file" || block.toolName === "apply_patch") &&
        isEphemeralPlanArtifactPath(block.target)
      ) {
        return null;
      }
      const autoCollapse = index < taskFlow.length - 1 && taskFlow.findIndex((t, i) => i > index && t.type === "agent") !== -1;
      const blockPermissionIdentity = permissionRequestHasExactRuntimeOwner &&
        permissionResolutionIdentity &&
        permissionActionRequest &&
        isExactPendingToolReviewOwner(block, {
          taskId: permissionResolutionIdentity.taskId,
          turnIds: [permissionResolutionIdentity.turnId],
          toolCallId: permissionActionRequest.toolCallId,
          toolName: permissionActionRequest.toolName,
          target: permissionActionRequest.target,
        })
        ? permissionResolutionIdentity
        : null;
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
            permissionRisk={blockPermissionIdentity ? permissionActionRequest?.risk : undefined}
            intentSummary={block.intentSummary}
            why={block.why}
            evidence={block.evidence}
            observationSummary={block.observationSummary}
            onAllow={blockPermissionIdentity
              ? () => allowToolAction?.(block.id, blockPermissionIdentity)
              : undefined}
            onAllowForSession={blockPermissionIdentity
              ? () => approvePendingReviewForSession?.(blockPermissionIdentity)
              : undefined}
            onReject={blockPermissionIdentity
              ? () => rejectToolAction?.(block.id, blockPermissionIdentity)
              : undefined}
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
    const isChatIntent = turnIntent === "respond" || turnIntent === "discuss";
    const turnIntentPolicy = getIntentPolicy(displayTurnIntent);
    const turnIntentLabel = turnIntentPolicy.intent === displayTurnIntent
      ? (language === "en" ? turnIntentPolicy.label.en : turnIntentPolicy.label.zh)
      : (language === "zh" ? "任务" : "Task");
    const shouldShowIntentBadge = displayTurnIntent === "plan" || displayTurnIntent === "studio_workflow";
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
    const turnPresentation = buildTurnPresentationModel({
      turn,
      language,
      statusLabel: copy.turnStatusLabels[turn.status] || turn.status,
      // A workspace submission is always a durable Turn. Keep its title,
      // lifecycle, and timer visible even when intent resolution says respond.
      // Only global chat uses the anchorless continuous transcript.
      showStateAnchorOverride: !isGlobalChat,
    });
    // Compatibility: persisted `collapsed` now projects to process-only collapse.
    // The user request and final assistant response remain part of the continuous flow.
    const isTurnExpanded = !turnPresentation.processCollapsed;
    const userBlock = blocks.find((block) => block.type === "user");
    const additionalVisibleUserBlocks = userBlock
      ? blocks
          .map((block, blockIndex) => ({ block, blockIndex }))
          .filter(({ block }) => block.type === "user" && block.id !== userBlock.id)
      : [];
    const hiddenCount = blocks.filter((block) => block.type !== "user").length;
    const { entries: turnChangeEntries, totalExecutedEdits } = collectTurnChangeEntries(blocks);
    const shouldShowTurnChanges = turnChangeEntries.length > 0 || totalExecutedEdits > 0;
    const explicitFinalAgentIndex = [...blocks]
      .map((block, idx) => ({ block, idx }))
      .reverse()
      .find(({ block }) =>
        block.type === "agent" &&
        block.visibility === "assistant_final" &&
        !block.hiddenProcess &&
        hasRenderableAgentBlock(block)
      )?.idx ?? -1;
    const legacyFinalVisibleAgentIndex = [...blocks]
      .map((block, idx) => ({ block, idx }))
      .reverse()
      .find(({ block }) =>
        !block.hiddenProcess &&
        block.visibility !== "user_progress" &&
        hasRenderableAgentBlock(block)
      )?.idx ?? -1;
    // New completed turns carry an explicit semantic final. The legacy
    // fallback is retained only for sessions persisted before that contract.
    const finalVisibleAgentIndex = explicitFinalAgentIndex >= 0
      ? explicitFinalAgentIndex
      : legacyFinalVisibleAgentIndex;
    const finalVisibleAgentBlock = finalVisibleAgentIndex >= 0 ? blocks[finalVisibleAgentIndex] : null;
    // A runtime-owned assistant_final makes a recovery pause terminal for
    // presentation purposes without claiming successful completion.
    const isPausedWithFinalConclusion = turnPresentation.lifecycle === "resumable" && explicitFinalAgentIndex >= 0;
    const isFinishedTurn = isFinishedTurnStatus(turnPresentation.status) || isPausedWithFinalConclusion;
    const showReasoningDebug = config.reasoningDisplay !== "hidden";
    const substantiveIntermediateAgentBlockIds = new Set(blocks
      .map((block, idx) => ({ block, idx }))
      .filter(({ block, idx }) => {
        if (idx === finalVisibleAgentIndex) return false;
        if (!block || block.type !== "agent" || block.hiddenProcess || block.streaming) return false;
        if (Array.isArray(block.options) && block.options.length > 0) return false;
        // Reviewed Plan text and model-authored assistant updates have an
        // explicit semantic identity. Runtime narration remains process-only;
        // wording heuristics do not decide whether an update is public.
        const isAssistantUpdate = block.visibility === "assistant_update";
        if (
          block.visibility !== "substantive_plan_text" &&
          !isAssistantUpdate &&
          block.visibility !== "stage_summary"
        ) return false;
        const text = getAgentVisibleMarkdownText(block);
        const content = String(text || "").trim();
        if (!content) return false;
        // `stage_summary` is retained only for sessions persisted by the
        // previous lexical classifier. New assistant updates bypass content
        // guessing because their identity was assigned by the model/runtime
        // channel before persistence.
        if (!isAssistantUpdate && !shouldRetainStageSummary(content)) return false;
        if (!isAssistantUpdate && shouldSuppressAgentToolEcho(blocks, idx)) return false;
        return true;
      })
      .map(({ block }) => block.id));
    const hasSubstantiveIntermediateAgentText = substantiveIntermediateAgentBlockIds.size > 0;
    const publicAssistantUpdates = blocks
      .map((block, blockIndex) => ({ block, blockIndex }))
      .filter(({ block }) =>
        block?.type === "agent" &&
        block.visibility === "assistant_update" &&
        substantiveIntermediateAgentBlockIds.has(block.id)
      );
    const hasFoldableProcessBlocks = blocks.some((block) => {
      if (!block || block.type === "user" || block.type === "thought") return false;
      if (block.type === "agent") return block.hiddenProcess === true;
      if (block.type === "progress" || block.type === "jobList") return true;
      if (block.type === "system") {
        return block.variant !== "context_compression" &&
          block.variant !== "plan_quality_gate" &&
          block.variant !== "plan_execution_checkpoint" &&
          block.variant !== "execution_checkpoint" &&
          block.variant !== "game_studio_local_markdown";
      }
      if (block.type === "tool") {
        const status = String(block.toolStatus || block.status || "").toLowerCase();
        return status === "executed" || status === "running";
      }
      return false;
    });
    // A response-style turn can still execute real tools. Process visibility is
    // driven by those durable process blocks, not by the conversational intent
    // label; pure chat without tool/progress blocks remains unaffected.
    const shouldRenderLiveProcessTimeline = hasFoldableProcessBlocks;
    const shouldRenderCompletedProcessArchive = shouldRenderLiveProcessTimeline;
    const shouldKeepContinuousProcessTimeline =
      !turnPresentation.showStateAnchor &&
      !hasSubstantiveIntermediateAgentText;
    const shouldArchiveCompletedProcess =
      shouldRenderCompletedProcessArchive &&
      isFinishedTurn &&
      finalVisibleAgentIndex >= 0 &&
      !hasSubstantiveIntermediateAgentText &&
      !shouldKeepContinuousProcessTimeline;
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
    const hasPlanContent = isPlanTurn && (
      (hasReviewablePlanArtifact && turn.id === planArtifactOwnerTurnId) ||
      hasGeneratedPlanContent(blocks)
    );
    // Only show the PlanShortcutCard when the plan is truly complete — not
    // while it's still being generated. The card replaces all detailed blocks,
    // so it must only appear once the model has finished working on this turn.
    const planTurnFinished =
      turnPresentation.lifecycle === "success" ||
      turnPresentation.lifecycle === "partial" ||
      turnPresentation.lifecycle === "blocked" ||
      turnPresentation.lifecycle === "error" ||
      turnPresentation.lifecycle === "canceled" ||
      turnPresentation.lifecycle === "action_required" ||
      isPlanApproved;
    const hasCompletePlan = hasPlanContent && planTurnFinished;
    const finalAgentSummaryText = getLastAgentSummaryText(blocks);
    const planProgressSummary = turnProgressSnapshot
      ? summarizePlanExecutionProgressSnapshot(turnProgressSnapshot, language)
      : "";
    const planProgressBody = turnProgressSnapshot
      ? formatPlanExecutionProgressSnapshot(turnProgressSnapshot, language)
      : "";
    const hasInlinePlanProgressBlock = blocks.some((block) =>
      block.type === "system" && block.variant === "plan_execution_progress"
    );
    const livePlanProgressBlock =
      isTurnExpanded && isPlanExecutionVisible && turnProgressSnapshot && planProgressBody && !hasInlinePlanProgressBlock
        ? {
            id: `${turn.id}-live-plan-progress`,
            type: "system",
            variant: "plan_execution_progress",
            content: planProgressBody,
            planExecutionProgress: turnProgressSnapshot,
          }
        : null;
    const toolExecutionSummary = buildToolExecutionSummary(blocks, language);
    const turnToolCount = blocks.filter((block) =>
      block.type === "tool" && ["executed", "running", "failed"].includes(String(block.toolStatus || ""))
    ).length;
    const turnSubagentRuns = subagentRuns.filter((run) => run.parentTurnId === turn.id);
    const liveProcessTimeline = !shouldArchiveCompletedProcess && shouldRenderLiveProcessTimeline
      ? buildLiveTurnProcessTimelineModel({ blocks, language, includeThoughts: showReasoningDebug })
      : null;
    const liveProcessHasChangeSummary = !!liveProcessTimeline && liveProcessTimeline.steps.some((step) =>
      step.kind === "edit" && collectTurnChangeEntries(step.items).entries.length > 0
    );
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
      showReasoningDebug && turnPresentation.lifecycle !== "error" && turnPresentation.lifecycle !== "failed" && latestThoughtBlock
        ? (() => {
            const summary = getThoughtSummaryText(latestThoughtBlock);
            const shouldKeepSummary = latestThoughtBlock.isStreaming || shouldRetainStageSummary(summary);
            if (!shouldKeepSummary) return "";
            if (liveTimelineContainsProcessText(liveProcessTimeline, summary)) return "";
            if (processTextsOverlap(finalAgentSummaryText, summary)) return "";
            return summary;
          })()
        : "";
    const isBottomThoughtStreaming = !!latestThoughtBlock?.isStreaming;
    const isActiveRunningTurn = capsuleTurn?.id === turn.id && capsuleIsRunActive;
    // Active runtime metadata already has durable homes in the process
    // timeline and Run Status popover. Keep it out of both the public
    // assistant-update channel and the high-level Capsule status line.
    const shouldSuppressActiveRuntimeNotice = isActiveRunningTurn;
    const shouldShowTurnActivityNotice =
      turnPresentation.lifecycle !== "error" &&
      turnPresentation.lifecycle !== "failed" &&
      !shouldSuppressActiveRuntimeNotice &&
      Boolean(bottomThoughtSummary);
    const isTurnCompletedOrStopped =
      turnPresentation.lifecycle !== "active" ||
      isPausedWithFinalConclusion;


    const renderTurnBlockItem = (item) => {
      if (item.kind !== "readContextGroup" && item.kind !== "operationCluster" && item.block?.type === "thought") return null;
      if (item.kind === "block") {
        if (shouldSuppressSupersededPlanCandidate({
          block: item.block,
          hasReviewableArtifact: hasReviewablePlanArtifact,
          ownsReviewableArtifact: turn.id === planArtifactOwnerTurnId,
        })) return null;
        // `user_progress` is runtime/process narration, including legacy
        // persisted model prose that used to be promoted from tool-call text.
        // Its structured tool evidence is rendered by the process timeline and
        // capsule; repeating the prose in ChatArea creates a false checkpoint.
        if (item.block?.type === "agent" && item.block.visibility === "user_progress") return null;
        // A completed turn's exact final assistant answer is canonical visible
        // context. Never let process-narration heuristics consume it merely
        // because it mentions the tool result that immediately preceded it.
        if (item.index === finalVisibleAgentIndex && item.block?.type === "agent") {
          return renderBlockItem(item);
        }
        if (isActiveRunningTurn) {
          // Active running turn routes intermediate explanations into the capsule.
          if (!(item.block?.type === "agent" && substantiveIntermediateAgentBlockIds.has(item.block.id))) {
            const isExplanation = shouldSuppressAgentAsExplanation(item.block, item.index, blocks, turnIntent);
            if (isExplanation) return null;
          }
          if (item.block?.type === "tool" && item.block?.toolStatus === "running") return null;
        } else {
          if (
            isTransparentToolNarrationBlock(item.block) &&
            !(item.block?.type === "agent" && substantiveIntermediateAgentBlockIds.has(item.block.id))
          ) return null;
        }

        // Hide only thin/transparent tool narration blocks in completed turns
        if (isTurnCompletedOrStopped && item.block?.type === "agent" && !isChatIntent) {
          if (
            isTransparentToolNarrationBlock(item.block) &&
            !(item.block?.type === "agent" && substantiveIntermediateAgentBlockIds.has(item.block.id))
          ) {
            return null;
          }
        }
      }
      if (item.kind === "block" && shouldSuppressAgentToolEcho(blocks, item.index)) return null;

      return renderBlockItem(item);
    };
    const renderArchivedBlockItem = (item) => {
      if (item.kind !== "readContextGroup" && item.kind !== "operationCluster" && item.block?.type === "thought") return null;
      if (item.kind === "block") {
        if (
          isTransparentToolNarrationBlock(item.block) &&
          !(item.block?.type === "agent" && substantiveIntermediateAgentBlockIds.has(item.block.id))
        ) return null;

        // Hide only thin/transparent tool narration blocks in completed turns
        if (isTurnCompletedOrStopped && item.block?.type === "agent" && !isChatIntent) {
          if (
            isTransparentToolNarrationBlock(item.block) &&
            !(item.block?.type === "agent" && substantiveIntermediateAgentBlockIds.has(item.block.id))
          ) {
            return null;
          }
        }
      }
      return renderBlockItem(item);
    };
    const isLiveProcessRenderItem = (item) => {
      if (item.kind === "operationCluster") {
        return item.cluster.blocks.every((block: any) => liveProcessBlockIds.has(block?.id));
      }
      if (item.kind === "readContextGroup") {
        return shouldKeepContinuousProcessTimeline &&
          item.blocks.every((block: any) => liveProcessBlockIds.has(block?.id));
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
    const isExecutionPhaseBlock = (block: any) => {
      if (!block || block.type === "user") return false;
      if (block.type === "agent") {
        return block.hiddenProcess === true ||
          block.visibility === "user_progress" ||
          block.turnPhase?.domain === "tool";
      }
      return block.type === "tool" ||
        block.type === "progress" ||
        block.type === "jobList" ||
        (block.type === "system" &&
          block.variant !== "context_compression" &&
          block.variant !== "plan_quality_gate" &&
          block.variant !== "plan_execution_checkpoint" &&
          block.variant !== "execution_checkpoint" &&
          block.variant !== "game_studio_local_markdown");
    };
    const phaseLabels = {
      analysis: language === "zh" ? "分析与方案" : "Analysis & Proposal",
      approval: language === "zh" ? "用户批准" : "User Approval",
      execution: language === "zh" ? "执行与验证" : "Execution & Validation",
    };
    const proposalBlockIndex = blocks.findIndex((block) => block.type === "agent" && block.archivedProposal);
    const hasProposalCheckpoint = proposalBlockIndex >= 0;
    const approvalBlockIndex = hasProposalCheckpoint
      ? blocks.findIndex((block, blockIndex) => blockIndex > proposalBlockIndex && block.type === "user")
      : -1;
    const executionBlockIndex = hasProposalCheckpoint
      ? blocks.findIndex((block, blockIndex) =>
          blockIndex > Math.max(proposalBlockIndex, approvalBlockIndex) &&
          isExecutionPhaseBlock(block)
        )
      : -1;
    const renderTurnPhaseDividersBeforeItem = (() => {
      const inserted = new Set<string>();
      return (item: any) => {
        if (!hasProposalCheckpoint) return [];
        const indexForPhase = item.kind === "operationCluster"
          ? item.index
          : item.kind === "completedToolGroup" || item.kind === "readContextGroup"
          ? item.index ?? blocks.findIndex((block) => block.id === item.blocks?.[0]?.id)
          : item.index;
        const keys: string[] = [];
        if (!inserted.has("analysis") && indexForPhase >= proposalBlockIndex) keys.push("analysis");
        if (approvalBlockIndex >= 0 && !inserted.has("approval") && indexForPhase >= approvalBlockIndex) keys.push("approval");
        if (executionBlockIndex >= 0 && !inserted.has("execution") && indexForPhase >= executionBlockIndex) keys.push("execution");
        keys.forEach((key) => inserted.add(key));
        return keys.map((key) => (
          <TurnPhaseDivider key={`${turn.id}-phase-${key}`} label={phaseLabels[key]} />
        ));
      };
    })();
    const renderTurnRemainderWithPhases = (item) => {
      if (item.kind === "block" && userBlock && item.block?.id === userBlock.id) return null;
      const rendered = renderLiveRemainderItem(item);
      if (!rendered) return null;
      const dividers = renderTurnPhaseDividersBeforeItem(item);
      if (dividers.length === 0) return rendered;
      const renderedKey = React.isValidElement(rendered)
        ? rendered.key ?? `item-${item.index}`
        : `item-${item.index}`;
      return (
        <React.Fragment key={`phase-wrap-${turn.id}-${renderedKey}`}>
          {dividers}
          {rendered}
        </React.Fragment>
      );
    };
    const proposalCheckpointBlock = hasProposalCheckpoint ? blocks[proposalBlockIndex] : null;
    const proposalApprovalBlock = approvalBlockIndex >= 0 ? blocks[approvalBlockIndex] : null;
    const displayTurnTitle = turnPresentation.title;
    const isLightThemeMode = config.themeMode === "light";
    const processItemCount = Math.max(0, collapsedProcessCount);
    const canToggleProcess = processItemCount > 0;
    const turnHeaderClass = "turn-state-anchor flex w-full items-center justify-between gap-4 rounded-xl border px-3 py-2 text-left transition-colors";
    const turnTitleClass = "text-[var(--surface-text-strong)]";
    const turnChevronClass = "text-[var(--surface-text-subtle)]";
    const latestTurnChoiceBlock = [...blocks].reverse().find((block) =>
      block.type === "agent" &&
      block.archivedAfterChoice !== true &&
      Array.isArray(block.options) &&
      block.options.length > 0
    );
    const turnReplyOptions = latestTurnChoiceBlock?.type === "agent"
      ? latestTurnChoiceBlock.options || []
      : [];
    const candidateChoiceRequest = latestTurnChoiceBlock?.type === "agent"
      ? latestTurnChoiceBlock.choiceRequest
      : undefined;
    const turnOptionValues = turnReplyOptions.map((option) => String(option.value || option.label || "").trim()).filter(Boolean);
    // The global Capsule is owned by the one currently active ActionRequest.
    // An older logical turn can still retain its own durable pending choice
    // after an ordinary command starts a newer turn. That checkpoint is
    // intentionally block-owned: the click path revalidates the complete
    // serialized identity and refuses it while another runtime owner is busy.
    const inlineChoiceRequest = candidateChoiceRequest?.status === "pending" &&
      !!candidateChoiceRequest.requestId &&
      !!candidateChoiceRequest.runId &&
      candidateChoiceRequest.sessionKey === activeSessionKey &&
      candidateChoiceRequest.turnId === turn.id &&
      candidateChoiceRequest.optionValues.length === turnOptionValues.length &&
      candidateChoiceRequest.optionValues.every((value) => turnOptionValues.includes(String(value).trim()))
      ? candidateChoiceRequest
      : null;
    const showInlineChoiceCheckpoint =
      turnPresentation.lifecycle === "action_required" &&
      (turnPresentation.status === "awaiting_input" || (turnPresentation.status === "awaiting_approval" && turnIntent !== "plan")) &&
      turnReplyOptions.length > 0 &&
      !!inlineChoiceRequest &&
      inlineChoiceRequest.requestId !== userChoiceActionRequest?.requestId;
    const inlineChoiceTitle = normalizeConversationDisplayTitle(
      !isGenericConversationTitle(turn.title) ? turn.title : turn.intentSummary || turn.userPrompt,
      language === "en" ? 52 : 42,
      language === "en" ? "Turn choice" : "本轮选择",
    );

    return (
      <section
        key={turn.id}
        ref={(node) => {
          turnRefs.current[turn.id] = node;
        }}
        data-turn-id={turn.id}
        data-turn-presentation={turnPresentation.kind}
        className="py-3"
      >
        {turnPresentation.showStateAnchor && (
          <div
            data-testid="turn-state-anchor"
            role={canToggleProcess ? "button" : undefined}
            tabIndex={canToggleProcess ? 0 : undefined}
            onClick={canToggleProcess ? () => toggleConversationTurnCollapsed(turn.id) : undefined}
            onKeyDown={(event) => {
              if (canToggleProcess && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                toggleConversationTurnCollapsed(turn.id);
              }
            }}
            className={turnHeaderClass}
          >
            <div className="min-w-0 flex flex-wrap items-center gap-2">
              {shouldShowIntentBadge && turnIntentLabel && (
                <span data-testid={`turn-intent-badge-${displayTurnIntent}`} className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${displayTurnIntent === "plan" ? "theme-plan-pill" : "border-[rgba(52,211,153,0.22)] bg-[rgba(52,211,153,0.1)] text-[#86efac]"}`}>
                  {turnIntentLabel}
                </span>
              )}
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${getTurnStatusTone(turnPresentation.status)}`}>
                {turnPresentation.statusLabel}
              </span>
              <TurnTimer
                turnId={turn.id}
                status={turnPresentation.status}
                isStreaming={isStreaming}
                currentTurnId={currentTurnId}
                savedElapsedTime={turn.elapsedTime}
                isLightThemeMode={isLightThemeMode}
              />
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
              {canToggleProcess && (
                <div className={`shrink-0 ${turnChevronClass}`}>
                  {isTurnExpanded ? <IconChevronDown className="h-4 w-4" /> : <IconChevronRight className="h-4 w-4" />}
                </div>
              )}
            </div>
          </div>
        )}

        <div className={`${turnPresentation.showStateAnchor ? "mt-4 " : ""}space-y-4`}>
          {userBlock ? renderBlock(userBlock, blocks.indexOf(userBlock)) : null}
          {!turnPresentation.showStateAnchor && canToggleProcess && (
            <TurnProcessDisclosure
              collapsed={!isTurnExpanded}
              count={processItemCount}
              toolCount={turnToolCount}
              changedFileCount={turnChangeEntries.length}
              elapsedSeconds={Math.max(0, Number(turn.elapsedTime) || 0)}
              summary={toolExecutionSummary}
              language={language}
              onToggle={() => toggleConversationTurnCollapsed(turn.id)}
            />
          )}
          {false && livePlanProgressBlock ? (
            <PlanExecutionSystemNotice
              key={`${turn.id}-live-plan-progress`}
              block={livePlanProgressBlock}
              language={language}
            />
          ) : null}
          {isTurnExpanded && shouldShowTurnChanges && !shouldArchiveCompletedProcess && !liveProcessHasChangeSummary && (
            <TurnChangesCard
              key="turn-changes-card"
              entries={turnChangeEntries}
              totalExecutedEdits={totalExecutedEdits}
              language={language}
              onOpenDiff={openDiffForTask}
              chatFontSize={resolvedTurnProcessFontSize}
            />
          )}

          {!isTurnExpanded ? (
            <React.Fragment key="collapsed-process-visible-messages">
              {additionalVisibleUserBlocks.map(({ block, blockIndex }) => renderBlock(block, blockIndex))}
              {publicAssistantUpdates.map(({ block, blockIndex }) => renderBlock(block, blockIndex))}
              {finalVisibleAgentBlock
                ? renderBlock(finalVisibleAgentBlock, finalVisibleAgentIndex)
                : null}
            </React.Fragment>
          ) : (
            <React.Fragment key="turn-details">
              {shouldArchiveCompletedProcess ? (
                <React.Fragment key="archived-process">
                  {hasProposalCheckpoint && proposalCheckpointBlock && (
                    <>
                      <TurnPhaseDivider key={`${turn.id}-archived-phase-analysis`} label={phaseLabels.analysis} />
                      <AgentContentBlock
                        key={`${proposalCheckpointBlock.id}-${proposalBlockIndex}-archived-proposal`}
                        block={{ ...proposalCheckpointBlock, archivedAfterChoice: false }}
                        language={language}
                        chatFontSize={resolvedChatFontSize}
                      />
                    </>
                  )}
                  {hasProposalCheckpoint && proposalApprovalBlock && (
                    <>
                      <TurnPhaseDivider key={`${turn.id}-archived-phase-approval`} label={phaseLabels.approval} />
                      {renderBlock(proposalApprovalBlock, approvalBlockIndex)}
                    </>
                  )}
                  {hasProposalCheckpoint && processArchive && processArchive.totalCount > 0 && (
                    <TurnPhaseDivider key={`${turn.id}-archived-phase-execution`} label={phaseLabels.execution} />
                  )}
                  {processArchive && processArchive.totalCount > 0 && (
                    <TurnProcessArchive
                      key="turn-process-archive"
                      archive={processArchive}
                      language={language}
                      chatFontSize={resolvedTurnProcessFontSize}
                      renderArchivedItem={renderArchivedBlockItem}
                      onOpenDiff={openDiffForTask}
                    />
                  )}
                  {finalVisibleAgentBlock
                    ? renderBlock(finalVisibleAgentBlock, finalVisibleAgentIndex)
                    : null}
                </React.Fragment>
              ) : (
                <React.Fragment key="live-process">
                  {liveProcessTimeline && liveProcessTimeline.totalCount > 0 && (
                    <LiveTurnProcessTimeline
                      key="live-turn-timeline"
                      model={liveProcessTimeline}
                      language={language}
                      chatFontSize={resolvedTurnProcessFontSize}
                      renderLiveItem={renderBlockItem}
                      onOpenDiff={openDiffForTask}
                    />
                  )}
                  {buildBlockRenderItems(blocks, true, enableCompletedToolGrouping, language).map(renderTurnRemainderWithPhases)}
                </React.Fragment>
              )}
            </React.Fragment>
          )}
          {isTurnExpanded && turnSubagentRuns.length > 0 && (
            <SubagentActivityNotice
              key="subagent-activity-notice"
              runs={turnSubagentRuns}
              language={language}
              onOpen={openSubagentsPanel}
            />
          )}
          {isTurnExpanded && shouldShowTurnActivityNotice && (
            <TurnActivityNotice
              key="turn-activity-notice"
              thoughtSummaryText={bottomThoughtSummary}
              isThinking={isBottomThoughtStreaming}
              language={language}
              chatFontSize={resolvedChatFontSize}
            />
          )}
          {showInlineChoiceCheckpoint && (
            <div
              data-testid="turn-choice-checkpoint"
              data-session-key={inlineChoiceRequest?.sessionKey || undefined}
              data-turn-id={turn.id}
              data-run-id={inlineChoiceRequest?.runId || undefined}
              data-request-id={inlineChoiceRequest?.requestId || undefined}
              className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface-elevated)] p-3"
            >
              <ExecutionCapsule
                isRunActive={false}
                title={inlineChoiceTitle}
                presentation={turnPresentation}
                turnId={turn.id}
                runId={inlineChoiceRequest?.runId}
                requestId={inlineChoiceRequest?.requestId}
                status={turnPresentation.statusLabel}
                statusToneClass={getTurnStatusTone(turnPresentation.status)}
                language={language}
                themeMode={config.themeMode}
                chatFontSize={resolvedChatFontSize}
                planTasks={[]}
                planStage="idle"
                executionSteps={[]}
                progressMode="execution"
                isAwaitingChoice
                replyOptions={turnReplyOptions}
                allowCustomReply={inlineChoiceRequest.allowCustomReply}
                pendingRunDecision={null}
                canApprovePlan={false}
                autoApproveTools={autoApproveTools}
                onSelectReplyOption={(option) => onQuickReply?.(option, turn.id, inlineChoiceRequest)}
                onRequestPlanAdjustment={(text) => onQuickReply?.({ label: text, value: text, action: "adjust_plan", source: "custom_reply" }, turn.id, inlineChoiceRequest)}
                onCancelTurn={turn.id === currentTurnId ? onStopGeneration : undefined}
                onApprovePlan={approvePlan}
                onRejectPlan={rejectPlan}
                onOpenDiff={() => openRightPanelTab("diff")}
              />
            </div>
          )}

        </div>
        {shouldRenderTurnBoundary(index, groupedTurns.length) && (
          <div
            data-testid="turn-boundary-divider"
            data-after-turn-id={turn.id}
            className="turn-boundary-divider mt-4 h-px w-full"
            aria-hidden="true"
          />
        )}
      </section>
    );
  };

  const capsuleTitle = permissionActionRequest?.title || (pendingRunDecision?.kind === "intent_confirmation"
    ? pendingRunDecision.title || (language === "zh" ? "意图待确认" : "Intent Confirmation")
    : normalizeConversationDisplayTitle(
        capsuleControlTurn && !isGenericConversationTitle(capsuleControlTurn.title)
          ? capsuleControlTurn.title
          : capsuleControlTurn?.intentSummary || "",
        language === "en" ? 52 : 42,
        capsuleControlTurn?.userPrompt
          ? normalizeConversationDisplayTitle(
              capsuleControlTurn.userPrompt,
              language === "en" ? 52 : 42,
              language === "en" ? "Turn Decision" : "本轮决策",
            )
          : language === "en" ? "Turn Decision" : "本轮决策",
      ));
  const capsuleStatusLabel = copy.turnStatusLabels[capsuleControlTurnStatusKey || "awaiting_input"] ||
    capsuleControlTurnStatusKey ||
    (language === "zh" ? "待选择" : "Awaiting Choice");
  const capsuleHarnessIdentity =
    capsuleControlTurn && harnessRunMarker?.turnId === capsuleControlTurn.id
      ? harnessRunMarker
      : null;
  const capsulePresentation = buildTurnPresentationModel({
    turn: capsuleControlTurn,
    language,
    fallbackTitle: capsuleTitle,
    statusOverride: capsuleControlTurnStatusKey || "awaiting_input",
    statusLabel: capsuleStatusLabel,
    kindOverride: !capsuleControlTurn && pendingRunDecision ? "awaiting" : undefined,
    runId: permissionActionRequest?.runId || capsuleHarnessIdentity?.runId || undefined,
    requestId: permissionActionRequest?.requestId || undefined,
  });
  const goalOwnerTurn = activeGoal
    ? conversationTurns.find((turn) => turn.id === activeGoal.ownerTurnId) ||
      (capsuleTurn?.intent === "goal" ? capsuleTurn : null)
    : null;
  const goalBlockingActionRequest = activeGoal && activeActionRequest?.status === "pending" &&
    activeActionRequest.sessionKey === activeSessionKey &&
    harnessRunMarker?.status === "paused" &&
    harnessRunMarker.sessionKey === activeActionRequest.sessionKey &&
    harnessRunMarker.turnId === activeActionRequest.turnId &&
    harnessActionRunId === activeActionRequest.runId
    ? activeActionRequest
    : null;
  const goalActionRequest = goalBlockingActionRequest?.kind === "goal_confirmation" &&
    goalBlockingActionRequest.goalId === activeGoal?.id &&
    goalBlockingActionRequest.goalRevision === (activeGoal?.revision || 1) &&
    (!activeGoal?.ownerTurnId || goalBlockingActionRequest.turnId === activeGoal.ownerTurnId)
    ? goalBlockingActionRequest
    : null;
  const goalControlIdentity = activeGoal
    ? {
        goalId: activeGoal.id,
        goalRevision: activeGoal.revision || 1,
        ...(goalActionRequest ? { requestId: goalActionRequest.requestId } : {}),
      }
    : null;
  const goalPresentationOwnerTurn = activeGoal && shouldDetachGoalPresentationFromOwnerTurn({
    goalStatus,
    ownerTurn: goalOwnerTurn,
    ownerTurnId: activeGoal.ownerTurnId,
    sessionKey: activeSessionKey || "",
    runtimeEvents,
  })
    ? null
    : goalOwnerTurn;
  const goalPresentation = activeGoal
    ? buildTurnPresentationModel({
        turn: goalPresentationOwnerTurn,
        language,
        fallbackTitle: activeGoal.objective,
        statusOverride: goalStatus,
        statusLabel: goalStatus,
        kindOverride: "goal",
        hasActionRequest: !!goalBlockingActionRequest,
        actionKind: goalBlockingActionRequest?.kind,
        turnId: activeGoal.ownerTurnId || goalOwnerTurn?.id,
        runId: goalBlockingActionRequest?.runId || (
          harnessRunMarker?.turnId === (activeGoal.ownerTurnId || goalOwnerTurn?.id)
            ? harnessActionRunId || undefined
            : undefined
        ),
        requestId: goalBlockingActionRequest?.requestId,
      })
    : null;
  const capsuleActionKind = planReviewActionRequest?.kind ||
    userChoiceActionRequest?.kind ||
    (shouldShowExecutionCapsule ? permissionActionRequest?.kind : undefined) ||
    (pendingRunDecision ? "user_choice" : undefined);
  const currentPlanTaskExecutionKind = currentPlanTaskId
    ? auditedPlanTasks.find((task) => task.id === currentPlanTaskId)?.executionKind || null
    : null;
  const capsuleStatusProjection = buildCapsuleStatusProjection({
    language,
    presentation: activeGoal ? goalPresentation : capsulePresentation,
    actionKind: capsuleActionKind,
    planStage,
    planExecutionPhase: capsulePlanExecutionSnapshot?.phase,
    currentTaskExecutionKind: currentPlanTaskExecutionKind,
    agentStatus,
    isRunActive: capsuleIsRunActive,
  });
  const capsuleStructuredGuidanceText = capsuleIsRunActive &&
    !capsuleActionKind &&
    ["analyzing", "planning", "executing", "validating", "recovering"].includes(
      capsuleStatusProjection.kind,
    )
      ? buildCapsuleGuidanceText(
          capsuleRunStatus,
          language,
        )
      : "";
  const capsuleLiveGuidanceText = capsuleIsRunActive &&
    !capsuleActionKind &&
    activeSessionKey &&
    capsuleTurn?.id &&
    capsuleActiveRunId &&
    capsuleActiveLogicalTurnId &&
    ["analyzing", "planning", "executing", "validating", "recovering"].includes(
      capsuleStatusProjection.kind,
    )
      ? selectCapsuleLiveGuidance({
          blocks: capsuleTurnBlocks,
          sessionKey: activeSessionKey,
          logicalTurnId: capsuleActiveLogicalTurnId,
          displayTurnId: capsuleTurn.id,
          runId: capsuleActiveRunId,
          language,
          // Only a newer renderable progress item or health signal retires an
          // older model-visible line. Non-display telemetry must not replace
          // the last useful Capsule content with a generic lifecycle sentence.
          notOlderThan: Math.max(
            0,
            capsuleRunStatus.lastGuidanceActivity?.lastSeenAt || 0,
            ...capsuleRunStatus.healthSignals.map((signal) => signal.lastSeenAt),
          ),
        })
      : "";
  const capsuleGuidanceText = capsuleLiveGuidanceText || capsuleStructuredGuidanceText;

  useEffect(() => {
    setIsCapsuleCollapsed(false);
  }, [capsuleTurn?.id]);

  const planReviewCapsuleControls = planReviewActionRequest ? (
    <PlanReviewCapsule
      request={planReviewActionRequest}
      language={language}
      themeMode={config.themeMode}
      onOpenPlan={() => openRightPanelTab("plan")}
      onApprove={() => approvePlan(undefined, planReviewActionRequest)}
    />
  ) : null;

  const userChoiceCapsuleControls = userChoiceActionRequest && userChoiceOwnerTurn ? (
    <ExecutionCapsule
      isRunActive={false}
      title={userChoiceActionRequest.title}
      presentation={buildTurnPresentationModel({
        turn: userChoiceOwnerTurn,
        language,
        statusOverride: "awaiting_input",
        statusLabel: copy.turnStatusLabels.awaiting_input || (language === "zh" ? "待选择" : "Awaiting choice"),
        kindOverride: "awaiting",
        hasActionRequest: true,
        actionKind: "user_choice",
        turnId: userChoiceActionRequest.turnId,
        runId: userChoiceActionRequest.runId,
        requestId: userChoiceActionRequest.requestId,
      })}
      turnId={userChoiceActionRequest.turnId}
      runId={userChoiceActionRequest.runId}
      requestId={userChoiceActionRequest.requestId}
      status={copy.turnStatusLabels.awaiting_input || (language === "zh" ? "待选择" : "Awaiting choice")}
      statusToneClass={getTurnStatusTone("awaiting_input")}
      language={language}
      themeMode={config.themeMode}
      chatFontSize={resolvedChatFontSize}
      planTasks={[]}
      planStage="idle"
      executionSteps={[]}
      progressMode="execution"
      isAwaitingChoice
      replyOptions={userChoiceReplyOptions}
      allowCustomReply={userChoiceActionRequest.allowCustomReply}
      pendingRunDecision={null}
      canApprovePlan={false}
      autoApproveTools={autoApproveTools}
      onSelectReplyOption={(option) => onQuickReply?.(option, userChoiceActionRequest.turnId, userChoiceActionRequest)}
      onRequestPlanAdjustment={(text) => onQuickReply?.(
        { label: text, value: text, action: "adjust_plan", source: "custom_reply" },
        userChoiceActionRequest.turnId,
        userChoiceActionRequest,
      )}
      onCancelTurn={userChoiceActionRequest.turnId === currentTurnId ? onStopGeneration : undefined}
      onApprovePlan={approvePlan}
      onRejectPlan={rejectPlan}
      onOpenDiff={() => openRightPanelTab("diff")}
    />
  ) : null;

  const executionCapsuleControls = shouldShowExecutionCapsule && capsuleControlTurn ? (
    <ExecutionCapsule
      isRunActive={capsuleControlIsRunActive}
      title={capsuleTitle}
      presentation={capsulePresentation}
      turnId={permissionActionRequest?.turnId || capsuleControlTurn?.id}
      runId={permissionActionRequest?.runId || capsuleHarnessIdentity?.runId || undefined}
      requestId={permissionActionRequest?.requestId || undefined}
      permissionIdentity={permissionResolutionIdentity || undefined}
      permissionRisk={permissionActionRequest?.risk}
      permissionToolName={permissionActionRequest?.toolName}
      permissionTarget={permissionActionRequest?.target}
      permissionArgumentDisclosure={pendingToolArgumentDisclosure}
      status={capsuleStatusLabel}
      statusToneClass={getTurnStatusTone(capsuleControlTurnStatusKey || "awaiting_input")}
      language={language}
      themeMode={config.themeMode}
      chatFontSize={resolvedChatFontSize}
      planTasks={shouldShowPinnedPlanTasks ? planTasks : []}
      planExecutionEvidenceLedger={shouldShowPinnedPlanTasks ? planExecutionEvidenceLedger : []}
      planStage={pinnedPlanTurn ? planStage : "idle"}
      executionSteps={shouldShowPinnedPlanTasks ? [] : capsuleControlExecutionSteps}
      progressMode={shouldShowPinnedPlanTasks ? "plan" : "execution"}
      isAwaitingChoice={false}
      replyOptions={[]}
      pendingRunDecision={null}
      activeDiffTask={pendingToolReviewForExecutionCapsule}
      pendingToolReview={pendingToolReviewForExecutionCapsule}
      canApprovePlan={false}
      autoApproveTools={autoApproveTools}
      onCancelTurn={onStopGeneration}
      onApprovePlan={approvePlan}
      onRejectPlan={rejectPlan}
      onRejectDiff={(identity) => rejectToolAction?.(identity.taskId, identity)}
      onApproveDiffOnce={(identity) => approvePendingReviewOnce(identity)}
      onApproveDiffSession={(identity) => approvePendingReviewForSession(identity)}
      onOpenDiff={() => openRightPanelTab("diff")}
    />
  ) : null;
  const intentDecisionControls = pendingRunDecision ? (
    <div
      data-testid="intent-decision-checkpoint"
      className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-elevated)] p-4 shadow-2xl"
    >
      <ExecutionCapsule
        isRunActive={false}
        title={pendingRunDecision.kind === "intent_confirmation"
          ? pendingRunDecision.title || (language === "zh" ? "意图待确认" : "Intent Confirmation")
          : language === "zh" ? "请选择下一步" : "Choose the next step"}
        status={language === "zh" ? "待选择" : "Awaiting choice"}
        statusToneClass={getTurnStatusTone("awaiting_input")}
        language={language}
        themeMode={config.themeMode}
        chatFontSize={resolvedChatFontSize}
        planTasks={[]}
        planStage="idle"
        executionSteps={[]}
        progressMode="execution"
        isAwaitingChoice
        replyOptions={[]}
        pendingRunDecision={pendingRunDecision}
        canApprovePlan={false}
        autoApproveTools={autoApproveTools}
        onCancelTurn={onStopGeneration}
        onResolvePendingRunDecision={resolvePendingRunDecision}
        onDismissPendingRunDecision={dismissPendingRunDecision}
        onApprovePlan={approvePlan}
        onRejectPlan={rejectPlan}
        onOpenDiff={() => openRightPanelTab("diff")}
      />
    </div>
  ) : null;
  const hasExecutionCapsuleControls = !!executionCapsuleControls;
  const shouldShowMainCapsule =
    capsuleIsRunActive ||
    hasExecutionCapsuleControls ||
    !!planReviewCapsuleControls ||
    !!userChoiceCapsuleControls ||
    !!planExecutionCapsuleProjection ||
    !!activeGoal;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-[#000000]">
      <div className="h-[48px] shrink-0 border-b border-[#27272a] bg-[#000000] px-4 flex items-center justify-between select-none" data-tauri-drag-region>
        <button data-testid={isImageStudioMode ? "image-studio-settings-button" : "model-settings-button"} onClick={() => {
          if (isImageStudioMode) {
            setImageStudioSetupGuideOpen(true);
            return;
          }
          setSettingsTab(config.activeProfile === "cloud" ? "cloud" : "local");
          setIsSettingsOpen(true);
        }} className="flex min-w-0 items-center gap-2 rounded-md border border-[#27272a] bg-[#09090b] px-2.5 py-1.5 text-xs font-medium text-[#e4e4e7] transition-colors hover:bg-[#18181b]" style={{ height: 28 }}>
          {isImageStudioMode ? (
            <>
              <span className={`h-1.5 w-1.5 rounded-full ${imageStudio.status.state === "ready" ? "bg-green-500 shadow-[0_0_5px_#22c55e]" : isStreaming ? "bg-amber-400 shadow-[0_0_5px_#fbbf24] animate-pulse" : "bg-zinc-500"}`} />
              {language === "en" ? "Image Studio" : "图像工作室"}: <span className="max-w-[200px] truncate font-normal text-[#a1a1aa]">{imageStudioProviderLabel} · {imageStudioProviderDetail}</span>
            </>
          ) : config.activeProfile === "local" ? (
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




          {hasLivePlanWorkspaceContent && (
            <button
              data-testid="top-plan-panel-button"
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

          {subagentRuns.length > 0 && (
            <button
              data-testid="top-subagents-panel-button"
              onClick={() => togglePanelTab("subagents")}
              className={`panel-tab-icon-button relative flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] transition-all duration-150 ${rightPanelTab === "subagents" ? "is-active" : ""}`}
              title={language === "zh" ? "子智能体" : "Subagents"}
              aria-label={language === "zh" ? "子智能体" : "Subagents"}
            >
              <IconSubagent className="h-3.5 w-3.5" />
              {subagentRuns.some((run) => isSubagentActiveStatus(run.status)) && rightPanelTab !== "subagents" && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#60a5fa] shadow-[0_0_6px_rgba(96,165,250,0.8)]" />
              )}
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

      <div
        ref={chatContainerRef}
        onScroll={handleScroll}
        data-testid="chat-scroll-container"
        className="flex-1 overflow-y-auto px-5 pt-5 transition-[padding-bottom] duration-250 ease-out"
        style={{ paddingBottom: `max(50vh, ${composerPaddingBottom}px)` }}
      >

        {groupedTurns.length === 0 ? (
          isImageStudioMode ? (
            <div
              data-testid="image-studio-empty-state"
              className="flex min-h-full items-center justify-center pb-12"
            >
              <div className="w-full max-w-5xl">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[16px] font-semibold text-[#f4f4f5]">
                      <IconImageIcon className="h-4 w-4 text-[var(--accent-light)]" />
                      {language === "en" ? "Image Studio" : "图像工作室"}
                    </div>
                    <div className="mt-1 text-[12px] text-[#a1a1aa]">
                      {language === "en"
                        ? "A dedicated image conversation workspace. Local image services stay primary, and HiDream Web remains available as a lighter browser fallback."
                        : "一个独立的图像对话工作区。本地图片服务是主路径，HiDream Web 保留为更轻量的网页 fallback。"}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="image-studio-empty-check-engine"
                      onClick={() => void checkImageStudioEngine()}
                      className="inline-flex h-8 items-center gap-2 rounded-md border border-[#27272a] bg-[#09090b] px-3 text-[11px] text-[#d4d4d8] transition-colors hover:bg-[#18181b] hover:text-white"
                    >
                      <IconZap className="h-3.5 w-3.5 text-[var(--accent-light)]" />
                      {language === "en" ? "Check Provider" : "检测 provider"}
                    </button>
                    <button
                      type="button"
                      data-testid="image-studio-empty-open-setup"
                      onClick={() => setImageStudioSetupGuideOpen(true)}
                      className="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] px-3 text-[11px] font-semibold text-[var(--accent-light)] transition-colors hover:border-[var(--accent)]"
                    >
                      <IconSettings className="h-3.5 w-3.5" />
                      {language === "en" ? "Setup" : "设置"}
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(260px,0.8fr)_minmax(300px,1.2fr)]">
                  <div className="rounded-lg border border-[#27272a] bg-[#09090b] p-4">
                    <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#71717a]">
                      {language === "en" ? "Provider" : "Provider 状态"}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${imageStudio.status.state === "ready" ? "bg-emerald-400" : imageStudio.status.state === "error" ? "bg-red-400" : "bg-zinc-500"}`} />
                      <span className="text-[13px] font-semibold text-[#e4e4e7]">
                        {imageStudio.status.state === "ready"
                          ? (language === "en" ? "Ready" : "已就绪")
                          : (language === "en" ? "Not connected" : "未连接")}
                      </span>
                    </div>
                    <div className="mt-2 break-words text-[12px] leading-relaxed text-[#a1a1aa]">
                      {imageStudio.status.message}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] text-[#a1a1aa]">
                      <span className="rounded-md border border-[#27272a] bg-[#050507] px-2 py-1">{imageStudioProviderLabel}</span>
                      <span className="rounded-md border border-[#27272a] bg-[#050507] px-2 py-1">{imageStudio.config.aspectRatio}</span>
                      <span className="rounded-md border border-[#27272a] bg-[#050507] px-2 py-1">
                        {isWebFallbackImageEngine
                          ? `Refine ${imageStudio.config.web.promptRefine ? "On" : "Off"}`
                          : `${imageStudio.config.steps} steps`}
                      </span>
                      <span className="rounded-md border border-[#27272a] bg-[#050507] px-2 py-1">
                        {isWebFallbackImageEngine
                          ? "Hosted"
                          : `CFG ${imageStudio.config.guidanceScale}`}
                      </span>
                      <span className="truncate rounded-md border border-[#27272a] bg-[#050507] px-2 py-1">
                        {isWebFallbackImageEngine ? imageStudio.config.web.endpoint : imageStudio.config.local.endpoint}
                      </span>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {[
                      language === "en"
                        ? "A quiet product photo of a titanium desk lamp on smoked glass, softbox lighting"
                        : "钛金属桌灯放在烟灰玻璃桌面上的安静产品照，柔和棚拍光",
                      language === "en"
                        ? "A cinematic mountain observatory above a sea of clouds, dawn, ultra detailed"
                        : "云海之上的电影感山顶天文台，黎明，超细节",
                      language === "en"
                        ? "A minimalist interface concept for a future music workstation, precise panels"
                        : "未来音乐工作站的极简界面概念图，精密面板",
                      language === "en"
                        ? "A hand-painted botanical study of luminous glass flowers, ink and watercolor"
                        : "发光玻璃花朵的手绘植物学研究，墨线与水彩",
                    ].map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => onSendMessage?.(prompt)}
                        className="min-h-[92px] rounded-lg border border-[#27272a] bg-[#09090b] p-3 text-left text-[12px] leading-relaxed text-[#d4d4d8] transition-colors hover:border-[var(--accent-subtle-border)] hover:bg-[#131316]"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
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
          )
        ) : isImageStudioMode ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
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

            <aside className="hidden xl:block">
              <div className="sticky top-5 rounded-xl border border-[#27272a] bg-[#09090b] p-3">
                <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold text-[#f4f4f5]">
                  <IconImageIcon className="h-3.5 w-3.5 text-[var(--accent-light)]" />
                  {language === "en" ? "Recent Results" : "最近结果"}
                </div>
                <div className="space-y-3">
                  {recentImageBlocks.length > 0 ? recentImageBlocks.map((block: any) => {
                    const imageUrl = block.imageUrl || block.previewUrl || "";
                    return (
                      <button
                        key={String(block.id)}
                        type="button"
                        onClick={() => onSendMessage?.(block.prompt || "")}
                        className="w-full rounded-lg border border-[#27272a] bg-[#050507] p-2 text-left transition-colors hover:border-[var(--accent-subtle-border)] hover:bg-[#131316]"
                      >
                        <div className="mb-2 aspect-square overflow-hidden rounded-md border border-[#27272a] bg-[#09090b]">
                          {imageUrl ? (
                            <img src={imageUrl} alt={block.prompt || "generated image"} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[10px] text-[#71717a]">
                              {block.status === "completed"
                                ? (language === "en" ? "Saved result" : "已保存结果")
                                : (language === "en" ? "Generating" : "生成中")}
                            </div>
                          )}
                        </div>
                        <div className="line-clamp-3 text-[11px] leading-relaxed text-[#d4d4d8]">{block.prompt}</div>
                      </button>
                    );
                  }) : (
                    <div className="rounded-lg border border-dashed border-[#27272a] px-3 py-4 text-[11px] leading-relaxed text-[#71717a]">
                      {language === "en"
                        ? "Your finished images will collect here for quick variants and reruns."
                        : "完成后的图片会收集到这里，方便快速做变体和重跑。"}
                    </div>
                  )}
                </div>
              </div>
            </aside>
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

      {/* Execution capsule */}
      {intentDecisionControls && (
        <div
          className="absolute left-6 right-6 z-40 flex justify-center"
          style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + 1.5rem + ${composerHeight}px + 12px)` }}
        >
          {intentDecisionControls}
        </div>
      )}
      {shouldShowMainCapsule && (
        <div
          className="absolute left-6 right-6 z-30 pointer-events-none flex flex-col transition-all duration-300 ease-out"
          style={{
            bottom: `calc(env(safe-area-inset-bottom, 0px) + 1.5rem + ${composerHeight}px + 12px)`,
            opacity: shouldShowMainCapsule ? 1 : 0,
            transform: shouldShowMainCapsule ? "translateY(0)" : "translateY(8px)",
            alignItems: isCapsuleCollapsed ? "flex-start" : "center",
          }}
        >
          {showProgressPopover && !isCapsuleCollapsed && (
            <div
              ref={popoverRef}
              id="run-status-popover"
              data-testid="effective-progress-popover"
              data-runtime-surface="run-status"
              role="dialog"
              aria-modal="false"
              aria-labelledby="run-status-popover-title"
              className={`pointer-events-auto mb-3 w-full max-w-xl rounded-2xl border p-4 backdrop-blur-md text-left transition-all duration-200 ${
                isLightThemeMode
                  ? "border-[#d4d4d8] bg-white/95 shadow-[0_12px_40px_rgba(0,0,0,0.12)] text-[#18181b]"
                  : isBlackThemeMode
                  ? "border-[#202026] bg-[#030304]/95 shadow-[0_12px_40px_rgba(0,0,0,0.95)] text-[#e7e7ea]"
                  : "border-[var(--accent-subtle-border)] bg-[rgba(9,9,11,0.95)] shadow-[0_12px_40px_rgba(0,0,0,0.85)] text-[#e4e4e7]"
              }`}
              style={{
                fontSize: `${Math.max(11, resolvedChatFontSize - 1)}px`,
              }}
            >
              <div className={`flex items-center justify-between border-b pb-2 mb-2 ${
                isLightThemeMode ? "border-[#e4e4e7]" : "border-[rgba(255,255,255,0.08)]"
              }`}>
                <span id="run-status-popover-title" className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--accent-light)] font-semibold">
                  {language === "zh" ? "运行状态" : "Run Status"}
                </span>
                <button
                  ref={runStatusCloseButtonRef}
                  type="button"
                  onClick={() => setCapsulePopover(null)}
                  aria-label={language === "zh" ? "关闭运行状态" : "Close run status"}
                  className={`rounded p-1 transition-colors ${
                    isLightThemeMode
                      ? "text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#18181b]"
                      : "text-[#71717a] hover:bg-[rgba(255,255,255,0.06)] hover:text-white"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {!capsuleRunStatus.currentActivity &&
              capsuleRunStatus.milestones.length === 0 &&
              capsuleRunStatus.healthSignals.length === 0 ? (
                <div className={`py-6 text-center italic ${
                  isLightThemeMode ? "text-[#71717a]" : "text-[#a1a1aa]"
                }`}>
                  {language === "zh" ? "暂无运行状态" : "No run status yet"}
                </div>
              ) : (
                <div className="max-h-[260px] overflow-y-auto space-y-3 pr-1">
                  {capsuleRunStatus.currentActivity && (
                    <section data-testid="run-status-current-activity">
                      <div className={`mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] ${
                        isLightThemeMode ? "text-[#71717a]" : "text-[#a1a1aa]"
                      }`}>
                        {language === "zh" ? "当前活动" : "Current activity"}
                      </div>
                      <div
                        className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg px-2 py-1.5 border text-[11px] ${
                          isLightThemeMode
                            ? "border-[#e4e4e7] bg-[#f8fafc]"
                            : isBlackThemeMode
                            ? "border-[#202026] bg-[#030304]"
                            : "border-[#202026] bg-[#09090b]"
                        }`}
                      >
                        <span className={`mt-1.5 h-2 w-2 rounded-full ${
                          capsuleRunStatus.currentActivity.status === "running"
                            ? "bg-[var(--accent-light)] shadow-[0_0_8px_var(--accent)]"
                            : "bg-[#10b981]"
                        }`} />
                        <span className="min-w-0 flex-1">
                          <span className={`block font-medium truncate ${
                            isLightThemeMode ? "text-[#18181b]" : "text-white"
                          }`}>{capsuleRunStatus.currentActivity.title}</span>
                          {capsuleRunStatus.currentActivity.summary && (
                            <span className={`mt-0.5 block truncate ${
                              isLightThemeMode ? "text-[#71717a]" : "text-[#a1a1aa]"
                            }`}>{capsuleRunStatus.currentActivity.summary}</span>
                          )}
                        </span>
                        {(capsuleRunStatus.currentActivity.repeatCount > 1 || capsuleRunStatus.currentActivity.cacheHits > 0) && (
                          <span className="shrink-0 rounded-full border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] px-1.5 py-0.5 text-[9px] text-[var(--accent-light)]">
                            ×{capsuleRunStatus.currentActivity.repeatCount}
                          </span>
                        )}
                      </div>
                    </section>
                  )}

                  {capsuleRunStatus.milestones.length > 0 && (
                    <section data-testid="run-status-milestones">
                      <div className={`mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] ${
                        isLightThemeMode ? "text-[#71717a]" : "text-[#a1a1aa]"
                      }`}>
                        {language === "zh" ? "最近里程碑" : "Recent milestones"}
                      </div>
                      <div className="space-y-1.5">
                        {capsuleRunStatus.milestones.map((item) => (
                          <div
                            key={item.key}
                            data-testid="run-status-milestone"
                            className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg px-2 py-1.5 border text-[11px] ${
                              isLightThemeMode
                                ? "border-[#e4e4e7] bg-[#f8fafc]"
                                : isBlackThemeMode
                                ? "border-[#202026] bg-[#030304]"
                                : "border-[#202026] bg-[#09090b]"
                            }`}
                          >
                            <span className="mt-1.5 h-2 w-2 rounded-full bg-[#10b981]" />
                            <span className="min-w-0 flex-1">
                              <span className={`block font-medium truncate ${
                                isLightThemeMode ? "text-[#18181b]" : "text-white"
                              }`}>{item.title}</span>
                              {item.summary && (
                                <span className={`mt-0.5 block truncate ${
                                  isLightThemeMode ? "text-[#71717a]" : "text-[#a1a1aa]"
                                }`}>{item.summary}</span>
                              )}
                            </span>
                            {item.repeatCount > 1 && (
                              <span className="shrink-0 rounded-full border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] px-1.5 py-0.5 text-[9px] text-[var(--accent-light)]">
                                ×{item.repeatCount}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {capsuleRunStatus.healthSignals.length > 0 && (
                    <section data-testid="run-status-health-signals">
                      <div className={`mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] ${
                        isLightThemeMode ? "text-[#71717a]" : "text-[#a1a1aa]"
                      }`}>
                        {language === "zh" ? "运行健康" : "Run health"}
                      </div>
                      <div className="space-y-1.5">
                        {capsuleRunStatus.healthSignals.map((signal) => (
                          <div
                            key={signal.key}
                            data-testid="run-status-health-signal"
                            className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 rounded-lg border px-2 py-1.5 text-[11px] ${
                              isLightThemeMode
                                ? "border-[#e4e4e7] bg-[#f8fafc]"
                                : isBlackThemeMode
                                ? "border-[#202026] bg-[#030304]"
                                : "border-[#202026] bg-[#09090b]"
                            }`}
                          >
                            <span className={`mt-1.5 h-2 w-2 rounded-full ${
                              signal.kind === "failure" || signal.kind === "pause"
                                ? "bg-[#f87171]"
                                : "bg-[#f59e0b]"
                            }`} />
                            <span className="min-w-0">
                              <span className={`block font-medium truncate ${
                                isLightThemeMode ? "text-[#18181b]" : "text-white"
                              }`}>{signal.title}</span>
                              {signal.summary && (
                                <span className={`mt-0.5 block truncate ${
                                  isLightThemeMode ? "text-[#71717a]" : "text-[#a1a1aa]"
                                }`}>{signal.summary}</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
          )}
          {showTasksPopover && !isCapsuleCollapsed && (
            <div
              ref={tasksPopoverRef}
              data-testid="tasks-progress-popover"
              className={`pointer-events-auto mb-3 w-full max-w-xl rounded-2xl border p-4 backdrop-blur-md text-left transition-all duration-200 ${
                isLightThemeMode
                  ? "border-[#d4d4d8] bg-white/95 shadow-[0_12px_40px_rgba(0,0,0,0.12)] text-[#18181b]"
                  : isBlackThemeMode
                  ? "border-[#202026] bg-[#030304]/95 shadow-[0_12px_40px_rgba(0,0,0,0.95)] text-[#e7e7ea]"
                  : "border-[var(--accent-subtle-border)] bg-[rgba(9,9,11,0.95)] shadow-[0_12px_40px_rgba(0,0,0,0.85)] text-[#e4e4e7]"
              }`}
              style={{
                fontSize: `${Math.max(11, resolvedChatFontSize - 1)}px`,
              }}
            >
              <div className={`flex items-center justify-between border-b pb-2 mb-2 ${
                isLightThemeMode ? "border-[#e4e4e7]" : "border-[rgba(255,255,255,0.08)]"
              }`}>
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--accent-light)] font-semibold">
                  {copy.taskTracking}
                </span>
                <button
                  type="button"
                  onClick={() => setCapsulePopover(null)}
                  className={`rounded p-1 transition-colors ${
                    isLightThemeMode
                      ? "text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#18181b]"
                      : "text-[#71717a] hover:bg-[rgba(255,255,255,0.06)] hover:text-white"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {!capsuleHasTasks ? (
                <div className="py-6 text-center text-[#71717a] italic">
                  {copy.noTasks}
                </div>
              ) : (
                <div className="max-h-[220px] overflow-y-auto space-y-2 pr-1">
                  {(() => {
                    const taskRowClass = isLightThemeMode
                      ? "border-[rgba(15,23,42,0.10)] bg-[rgba(255,255,255,0.68)]"
                      : isBlackThemeMode
                      ? "border-[#202026] bg-[#030304]"
                      : "border-[#202026] bg-[#09090b]";
                    const currentTaskRowClass = `${taskRowClass} ring-2 ring-inset ring-[color-mix(in_srgb,var(--accent)_72%,transparent)]`;
                    
                    return capsuleProgressItems.map((task, index) => {
                      const isCurrentPlanTask = capsuleProgressMode === "plan" && task.id === currentPlanTaskId && !task.complete;
                      return (
                        <div
                          key={`${task.id}-${index}`}
                          data-task-id={task.id}
                          data-testid={isCurrentPlanTask ? "execution-capsule-current-plan-task" : undefined}
                          className={`flex items-start gap-3 rounded-xl border px-3 py-2 transition-colors ${
                            isCurrentPlanTask ? currentTaskRowClass : taskRowClass
                          }`}
                        >
                          <span
                            className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center ${
                              task.complete
                                ? "border-[#34d399] bg-[#34d399] text-[#050507]"
                              : task.status === "in_progress"
                              ? "border-[#60a5fa] bg-[#60a5fa]"
                              : task.status === "failed"
                              ? "border-[#f87171] bg-[#f87171]"
                              : "border-[#3f3f46] bg-transparent"
                            }`}
                          >
                            {task.complete && (
                              <svg className="h-2 w-2" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2.5 6L5 8.5L9.5 3.5" />
                              </svg>
                            )}
                          </span>
                          <div className={`min-w-0 text-[12px] leading-6 ${isLightThemeMode ? "text-[#18181b]" : "text-[#f5f5f5]"}`}>
                            <div className="flex items-start gap-2">
                              <span className="mt-[2px] shrink-0 text-[12px] font-medium">{index + 1}.</span>
                              <div className="min-w-0 flex-1 [&_.markdown-body]:text-[12px] [&_.markdown-body]:leading-6 [&_.markdown-body_p]:mb-0 [&_.markdown-body_p]:text-inherit [&_.markdown-body_strong]:text-inherit [&_.markdown-body_code]:align-baseline">
                                <MarkdownRenderer content={task.text} baseFontSize={12} />
                                {capsuleProgressMode === "plan" && task.validationStatus !== "none" && !task.complete && (
                                  <div className={`mt-1 text-[10px] leading-4 ${
                                    task.validationStatus === "user" ? "text-[#fbbf24]" : "text-[#93c5fd]"
                                  }`}>
                                    {task.validationStatus === "user" ? copy.userValidation : copy.autoValidation}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          )}
          {showGoalPopover && !isCapsuleCollapsed && activeGoal && (
            <div
              ref={goalPopoverRef}
              data-testid="goal-progress-popover"
              className="pointer-events-auto mb-3 w-full max-w-xl text-left transition-all duration-200"
            >
              <GoalPanel
                presentation={goalPresentation || undefined}
                goal={activeGoal}
                progress={goalProgress}
                status={goalStatus}
                runtime={goalRuntime}
                language={language}
                themeMode={config.themeMode}
                onPause={() => goalControlIdentity && useAppStore.getState().pauseGoal(goalControlIdentity)}
                onResume={() => goalControlIdentity && useAppStore.getState().resumeGoal(goalControlIdentity)}
                onEdit={(objective) => goalControlIdentity && useAppStore.getState().updateGoalText(objective, goalControlIdentity)}
                onStop={() => goalControlIdentity
                  ? useAppStore.getState().clearGoal(goalControlIdentity)
                  : false}
                onClose={() => setCapsulePopover(null)}
              />
            </div>
          )}
          {(() => {
            const headerLabel = capsuleStatusProjection.label;
            const hasTypedCapsuleControls = hasExecutionCapsuleControls || !!planReviewCapsuleControls || !!userChoiceCapsuleControls;
            return (
              <div
                data-testid="agent-explanation-capsule"
                data-capsule-status={capsuleStatusProjection.kind}
                data-action-kind={planReviewActionRequest?.kind || userChoiceActionRequest?.kind || permissionActionRequest?.kind || undefined}
                data-session-key={planReviewActionRequest?.sessionKey || userChoiceActionRequest?.sessionKey || permissionActionRequest?.sessionKey || undefined}
                data-turn-id={planReviewActionRequest?.turnId || userChoiceActionRequest?.turnId || permissionActionRequest?.turnId || undefined}
                data-run-id={planReviewActionRequest?.runId || userChoiceActionRequest?.runId || permissionActionRequest?.runId || undefined}
                data-request-id={planReviewActionRequest?.requestId || userChoiceActionRequest?.requestId || permissionActionRequest?.requestId || undefined}
                data-plan-revision={planReviewActionRequest ? String(planReviewActionRequest.planRevision) : undefined}
                data-artifact-hash={planReviewActionRequest?.artifactHash || undefined}
                className={`agent-explanation-capsule ${isCapsuleCollapsed ? "collapsed-ring cursor-pointer" : `w-full max-w-3xl flex flex-col !items-start !justify-start !rounded-2xl ${hasTypedCapsuleControls ? "!p-4" : "!p-5"}`}`}
                style={{
                  fontSize: `${Math.max(11, resolvedChatFontSize - 1)}px`,
                  lineHeight: `${Math.max(16, Math.round((resolvedChatFontSize - 1) * 1.5))}px`,
                  maxHeight: !isCapsuleCollapsed && chatAreaHeight
                    ? `${chatAreaHeight * (hasTypedCapsuleControls ? 1 : 0.58)}px`
                    : undefined,
                  overflowY: "hidden",
                }}
                onClick={isCapsuleCollapsed ? () => setIsCapsuleCollapsed(false) : undefined}
                title={isCapsuleCollapsed ? (language === "zh" ? "点击展开" : "Click to expand") : undefined}
              >
                <div
                  aria-hidden="true"
                  className="capsule-rotate-beam"
                  data-testid="capsule-rotate-beam"
                />
                {isCapsuleCollapsed ? (
                  <div
                    className={`flex items-center justify-center w-full h-full ${activeGoal ? `capsule-goal-icon is-${goalStatus}` : "animate-pulse"}`}
                    data-goal-status={activeGoal ? goalStatus : undefined}
                  >
                    {activeGoal
                      ? <IconGoal className="h-5 w-5 pointer-events-none" />
                      : <IconLogoM className="h-5 w-5 theme-text pointer-events-none" />}
                  </div>
                ) : (
                  <div className="agent-explanation-scroll-container">
                    <div className="relative z-10 flex w-full flex-col items-start gap-3">
                      <div className="flex items-start w-full justify-between">
                        <div className="flex items-start min-w-0 flex-1">
                          <button
                            ref={mButtonRef}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCapsulePopover(showProgressPopover ? null : "progress");
                            }}
                            aria-expanded={showProgressPopover}
                            aria-controls="run-status-popover"
                            className="mt-0.5 shrink-0 mr-2.5 flex items-center justify-center h-6 w-6 rounded-full border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] group hover:bg-[var(--accent)] hover:border-transparent hover:scale-105 active:scale-95 transition-all cursor-pointer"
                            title={language === "zh" ? "查看运行状态" : "View Run Status"}
                          >
                            <IconLogoM className="h-3.5 w-3.5 text-[var(--accent-light)] group-hover:text-[var(--accent-contrast)] pointer-events-none transition-colors" />
                          </button>
                          <div className="min-w-0 flex-1 text-left">
                            {capsuleGuidanceText ? (
                              <div
                                data-testid="capsule-guidance-label"
                                aria-live="polite"
                                aria-atomic="true"
                                className="capsule-guidance-markdown block min-w-0 font-medium"
                              >
                                <MarkdownRenderer
                                  content={capsuleGuidanceText}
                                  baseFontSize={Math.max(12, resolvedChatFontSize - 1)}
                                  sourceId={`capsule-guidance-${capsuleTurn?.id || "active"}`}
                                />
                              </div>
                            ) : (
                              <span
                                data-testid="capsule-status-label"
                                aria-live="polite"
                                aria-atomic="true"
                                className={`block whitespace-normal break-words font-semibold ${
                                  isLightThemeMode ? "text-[#18181b]" : "text-white"
                                }`}
                              >
                                {headerLabel}
                              </span>
                            )}
                          </div>
                        </div>

                        {capsuleHasTasks && (
                          <button
                            ref={tasksButtonRef}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCapsulePopover(showTasksPopover ? null : "tasks");
                            }}
                            title={language === "zh" ? "任务跟踪" : "Task Tracking"}
                            className="shrink-0 ml-3 flex items-center justify-center p-1.5 rounded-md border border-[var(--accent-subtle-border)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent-light)] transition-all hover:bg-[var(--accent)] hover:text-[#ffffff] hover:border-transparent active:scale-95 cursor-pointer"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                            </svg>
                          </button>
                        )}
                        
                        {activeGoal && (
                          <button
                            ref={goalButtonRef}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCapsulePopover(showGoalPopover ? null : "goal");
                            }}
                            title={language === "zh" ? "目标进度" : "Goal Progress"}
                            aria-label={language === "zh" ? "目标进度" : "Goal Progress"}
                            aria-expanded={showGoalPopover}
                            data-testid="goal-capsule-trigger"
                            data-goal-status={goalStatus}
                            className={`capsule-goal-trigger is-${goalStatus} ${showGoalPopover ? "is-open" : ""}`}
                          >
                            <IconGoal className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {!planReviewActionRequest && !userChoiceActionRequest && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setIsCapsuleCollapsed(true);
                            }}
                            title={language === "zh" ? "隐藏" : "Hide"}
                            className="shrink-0 ml-3 flex items-center justify-center p-1.5 rounded-md border border-[var(--accent-subtle-border)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent-light)] transition-all hover:bg-[var(--accent)] hover:text-[#ffffff] hover:border-transparent active:scale-95 cursor-pointer"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 01-1.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {planReviewCapsuleControls && (
                        <div className={`w-full border-t pt-3 ${
                          isLightThemeMode ? "border-[#e4e4e7]" : "border-[#27272a]/60"
                        }`}>
                          {planReviewCapsuleControls}
                        </div>
                      )}

                      {userChoiceCapsuleControls && (
                        <div className={`w-full border-t pt-3 ${
                          isLightThemeMode ? "border-[#e4e4e7]" : "border-[#27272a]/60"
                        }`}>
                          {userChoiceCapsuleControls}
                        </div>
                      )}

                      {hasExecutionCapsuleControls && (
                        <div className={`w-full border-t pt-3 ${
                          isLightThemeMode ? "border-[#e4e4e7]" : "border-[#27272a]/60"
                        }`}>
                          {executionCapsuleControls}
                        </div>
                      )}

                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

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
        isRunActive={composerRunActive}
        turnIngressMode={composerTurnIngress.mode}
        guidanceTarget={composerTurnIngress.guidanceTarget}
        onStopGeneration={onStopGeneration}
        autoApproveTools={autoApproveTools}
        onToggleAutoApprove={onToggleAutoApprove}
        preferSubagents={preferSubagents}
        onTogglePreferSubagents={onTogglePreferSubagents}
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
