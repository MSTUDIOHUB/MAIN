// @ts-nocheck
import React, { useState, useEffect, useMemo } from "react";
import { IconSearch, IconFile, IconFolder, IconTerminal, IconCode, IconTool, IconCheck, IconChevronDown, IconChevronRight } from "./Icons";
import { getDiffStats } from "../lib/diff";
import { compactToolPresentationTarget, getToolPresentationLabel } from "../lib/toolPresentation";
import { buildToolResultPresentation } from "../lib/toolResultPresentation";
import {
  getRepeatedBrowserFailureCallsForUi,
  summarizeBrowserFailureForUi,
} from "../lib/toolUiGrouping";
import {
  classifyChatError,
  getChatFeedbackStatusCopy,
  normalizeChatFeedbackStatus,
} from "../lib/chatFeedback";
import { useAppStore } from "../store/useAppStore";

// Map tool names to human-readable action labels
const TOOL_LABELS: Record<string, { verb: { zh: string; en: string }; icon: React.FC<{ className?: string }> }> = {
  list_directory:   { verb: { zh: "扫描目录", en: "scan directory" }, icon: IconFolder },
  get_project_skeleton: { verb: { zh: "扫描项目", en: "scan project" }, icon: IconFolder },
  get_file_outline: { verb: { zh: "读取结构", en: "read outline" }, icon: IconFile },
  glob_search:      { verb: { zh: "搜索文件", en: "search files" }, icon: IconSearch },
  grep_search:      { verb: { zh: "搜索内容", en: "search content" }, icon: IconSearch },
  repo_map_status:  { verb: { zh: "检查代码图谱", en: "check repo map" }, icon: IconSearch },
  repo_map_search:  { verb: { zh: "搜索代码图谱", en: "search repo map" }, icon: IconSearch },
  repo_map_context: { verb: { zh: "读取代码图谱", en: "read repo map" }, icon: IconSearch },
  repo_map_files:   { verb: { zh: "查看图谱文件", en: "inspect repo-map files" }, icon: IconSearch },
  repo_map_impact:  { verb: { zh: "分析影响范围", en: "analyze impact" }, icon: IconSearch },
  read_file:        { verb: { zh: "读取文件", en: "read file" }, icon: IconFile },
  read_document:    { verb: { zh: "读取文档", en: "read document" }, icon: IconFile },
  analyze_tabular_document: { verb: { zh: "分析表格", en: "analyze table" }, icon: IconFile },
  query_tabular_document: { verb: { zh: "查询表格", en: "query table" }, icon: IconFile },
  index_workspace_documents: { verb: { zh: "索引文档", en: "index documents" }, icon: IconFolder },
  knowledge_search: { verb: { zh: "搜索知识库", en: "search knowledge base" }, icon: IconSearch },
  knowledge_get_excerpt: { verb: { zh: "读取知识库摘录", en: "read knowledge excerpt" }, icon: IconFile },
  replace_in_file:  { verb: { zh: "修改文件", en: "edit file" }, icon: IconCode },
  write_file:       { verb: { zh: "写入文件", en: "write file" }, icon: IconCode },
  apply_patch:      { verb: { zh: "应用补丁", en: "apply patch" }, icon: IconCode },
  execute_command:  { verb: { zh: "执行命令", en: "run command" }, icon: IconTerminal },
  send_pty_input:   { verb: { zh: "发送终端输入", en: "send terminal input" }, icon: IconTerminal },
  run_command:      { verb: { zh: "运行命令并等待", en: "run command and wait" }, icon: IconTerminal },
  browser_evaluate: { verb: { zh: "浏览器验证", en: "validate in browser" }, icon: IconTerminal },
  computer_use:     { verb: { zh: "桌面控制", en: "control desktop app" }, icon: IconTool },
  read_pty_buffer:  { verb: { zh: "读取终端", en: "read terminal" }, icon: IconTerminal },
  read_pty_tail:    { verb: { zh: "读取终端尾部", en: "read terminal tail" }, icon: IconTerminal },
  read_pty_since:   { verb: { zh: "读取新增终端输出", en: "read new terminal output" }, icon: IconTerminal },
  get_pty_status:   { verb: { zh: "检查终端状态", en: "check terminal status" }, icon: IconTerminal },
  clear_pty_buffer: { verb: { zh: "清空终端缓冲", en: "clear terminal buffer" }, icon: IconTerminal },
  Error:            { verb: { zh: "报告错误", en: "report error" }, icon: IconTool },
};

const COMPACT_DONE_TOOLS = new Set([
  "list_directory",
  "get_project_skeleton",
  "get_file_outline",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "knowledge_search",
  "knowledge_get_excerpt",
]);

interface ActionCardProps {
  blockId?: number;
  toolName: string;
  target: string;
  toolStatus: "pending" | "executed" | "rejected" | "running" | "failed";
  message?: string;
  diff?: { old: string; new: string; path?: string };
  shellPermissionDecision?: { requiresApproval?: boolean };
  intentSummary?: string;
  why?: string;
  evidence?: string;
  observationSummary?: string;
  onAllow?: () => void;
  onAllowForSession?: () => void;
  onReject?: () => void;
  autoApproveTools?: boolean;
  onToggleAutoApprove?: (v: boolean) => void;
  autoCollapse?: boolean;
}

function TerminalResultDetails({ presentation, language }) {
  const sectionToneClass = (tone) => {
    if (tone === "error") return "text-[#fda4af]";
    if (tone === "muted") return "text-[#a1a1aa]";
    return "text-[#d4d4d8]";
  };

  return (
    <div className="space-y-2.5">
      {presentation.command && (
        <div className="flex min-w-0 items-start gap-2 rounded-md border border-[#27272a] bg-[#050505] px-3 py-2 font-mono text-[11px] leading-5 text-[#e4e4e7]">
          <span className="shrink-0 select-none text-[#71717a]">$</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{presentation.command}</span>
        </div>
      )}

      {presentation.meta.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presentation.meta.map((item) => (
            <span
              key={item}
              className="rounded-md border border-[#27272a] bg-[#111113] px-2 py-0.5 font-mono text-[10px] text-[#a1a1aa]"
            >
              {item}
            </span>
          ))}
        </div>
      )}

      {presentation.sections.map((section, sectionIndex) => (
        <div key={`${section.label}-${sectionIndex}`} className="min-w-0">
          {section.label && (
            <div className="mb-1 text-[10px] font-semibold text-[#71717a]">
              {section.label}
            </div>
          )}
          <pre className={`max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[#27272a] bg-[#000000] p-3 font-mono text-[11px] leading-5 shadow-inner ${sectionToneClass(section.tone)}`}>
            {section.text || (language === "zh" ? "无输出" : "No output")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function compactExplanation(text?: string, maxChars = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3).trim()}...`;
}

export default function ActionCard({ blockId, toolName, target, toolStatus, message, diff, shellPermissionDecision, intentSummary, why, evidence, observationSummary, onAllow, onAllowForSession, onReject, autoApproveTools, onToggleAutoApprove, autoCollapse }: ActionCardProps) {
  const language = useAppStore((s) => s.config.language);
  const activeProfile = useAppStore((s) => s.config.activeProfile);
  const setIsSettingsOpen = useAppStore((s) => s.setIsSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const openDiffForTask = useAppStore((s) => s.openDiffForTask);
  const info = TOOL_LABELS[toolName] || { verb: { zh: "调用工具", en: "use tool" }, icon: IconTool };
  const uiLanguage = language === "en" ? "en" : "zh";
  const localizedVerb = getToolPresentationLabel(toolName, uiLanguage);
  const feedbackStatus = normalizeChatFeedbackStatus(toolStatus);
  const feedbackCopy = getChatFeedbackStatusCopy(feedbackStatus, uiLanguage);
  const IconComponent = info.icon;
  const isPending = toolStatus === "pending";
  const isRunning = toolStatus === "running";
  const isExecuted = toolStatus === "executed";
  const isRejected = toolStatus === "rejected";
  const isFailed = toolStatus === "failed";
  const isDone = isExecuted || isRejected || isFailed;
  const isSystemErrorCard = toolName === "Error";
  const isShellApprovalGated = !!shellPermissionDecision?.requiresApproval;

  // ── Collapsible state: expanded while pending/running, collapsed when done ──
  const [expanded, setExpanded] = useState(!isDone);

  // Auto-collapse when tool finishes executing
  useEffect(() => {
    if (isDone) {
      setExpanded(false);
    }
  }, [isDone]);

  // Auto-collapse when an agent conclusion follows (smart global awareness)
  useEffect(() => {
    if (autoCollapse && expanded) {
      setExpanded(false);
    }
  }, [autoCollapse]);

  const displayTarget = isSystemErrorCard
    ? (language === "zh" ? "请求失败" : "Request failed")
    : compactToolPresentationTarget(target, toolName, uiLanguage);
  const errorInfo = isSystemErrorCard
    ? classifyChatError(`${target || ""}\n${message || ""}`, {
        language: uiLanguage,
        activeProfile,
      })
    : null;
  const errorTitle = errorInfo?.title || displayTarget;
  const canOpenDiff = isExecuted && !!diff && blockId != null;
  const diffStats = useMemo(
    () => (diff ? getDiffStats(diff.old, diff.new) : null),
    [diff?.new, diff?.old],
  );
  const purposeText = compactExplanation(why || intentSummary);
  const evidenceText = compactExplanation(isDone ? observationSummary || evidence : evidence, 220);
  const browserFailureSummary = useMemo(
    () => toolName === "browser_evaluate" && isFailed
      ? summarizeBrowserFailureForUi({
          message,
          observationSummary,
          evidence,
          language: uiLanguage,
        })
      : null,
    [evidence, isFailed, message, observationSummary, toolName, uiLanguage],
  );
  const repeatedBrowserFailureCalls = useMemo(
    () => browserFailureSummary?.repeatCount > 1
      ? getRepeatedBrowserFailureCallsForUi(message)
      : [],
    [browserFailureSummary?.repeatCount, message],
  );

  // ── Collapsed summary row ──
  if (!expanded && isDone) {
    if (canOpenDiff && diffStats) {
      return (
        <div className="w-full ml-9 mt-1 mb-2 flex items-center gap-2">
          <button
            onClick={() => openDiffForTask(blockId)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[#1d4ed8]/25 bg-[#05070d] px-2.5 py-1.5 font-mono text-[11px] text-[#cbd5e1] shadow-sm transition-colors hover:border-[#2563eb]/45 hover:bg-[#09111f]"
          >
            <IconCode className="h-3.5 w-3.5 shrink-0 text-[#60a5fa]" />
            <span className="shrink-0 text-[#94a3b8]">{language === "zh" ? "已编辑" : "Edited"}</span>
            <span className="min-w-0 truncate font-semibold theme-text">{displayTarget}</span>
            <span className="ml-auto shrink-0 text-[#10b981]">+{diffStats.added}</span>
            <span className="shrink-0 text-[#f87171]">-{diffStats.removed}</span>
            <span className="shrink-0 rounded-full border border-[rgba(52,211,153,0.18)] bg-[rgba(52,211,153,0.08)] px-1.5 py-0.5 text-[9px] text-[#86efac]">
              {feedbackCopy.shortLabel}
            </span>
          </button>
          <button
            onClick={() => setExpanded(true)}
            className="rounded-md border border-[#27272a] bg-[#07070a] p-1.5 text-[#71717a] transition-colors hover:border-[#3f3f46] hover:text-[#e4e4e7]"
            title={language === "zh" ? "展开详情" : "Expand details"}
          >
            <IconChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      );
    }

    if (isExecuted && COMPACT_DONE_TOOLS.has(toolName)) {
      return (
        <div className="w-full ml-9 mt-1 mb-2">
          <button
            onClick={() => setExpanded(true)}
            className="flex w-full min-w-0 items-start gap-2 rounded-md border border-[#1f2937]/70 bg-[#05070a] px-2.5 py-1.5 text-left text-[11px] text-[#a1a1aa] shadow-sm transition-colors hover:border-[#3f3f46] hover:text-[#e4e4e7]"
          >
            <IconCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#10b981]" />
            <span className="min-w-0 flex-1">
              <span className="block min-w-0 truncate">
                <span className="text-[#d4d4d8]">{localizedVerb}</span>
                <span className="text-[#71717a]"> · </span>
                <span className="font-semibold theme-text">{displayTarget}</span>
              </span>
            </span>
            <IconChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#71717a]" />
          </button>
        </div>
      );
    }

    if (browserFailureSummary) {
      const actionDetail = [browserFailureSummary.action, browserFailureSummary.selector]
        .filter(Boolean)
        .join(" · ");
      return (
        <div className="w-full ml-9 mt-1 mb-2">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            data-testid="browser-validation-failure-summary"
            className="flex w-full min-w-0 items-start gap-2 rounded-md border border-[rgba(251,146,60,0.24)] bg-[color-mix(in_srgb,var(--surface-bg)_94%,#f97316_6%)] px-2.5 py-2 text-left shadow-sm transition-colors hover:border-[rgba(251,146,60,0.42)]"
          >
            <IconChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--surface-text-muted)]" />
            <IconComponent className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#fb923c]" />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
                <span className="shrink-0 font-semibold text-[var(--surface-text)]">{localizedVerb}</span>
                {actionDetail && (
                  <span
                    data-testid="browser-validation-failed-action"
                    className="min-w-0 truncate font-mono text-[#fdba74]"
                    title={actionDetail}
                  >
                    {actionDetail}
                  </span>
                )}
                {browserFailureSummary.repeatCount > 1 && (
                  <span
                    data-testid="browser-validation-repeat-count"
                    className="shrink-0 rounded-full border border-[rgba(251,146,60,0.3)] bg-[rgba(251,146,60,0.1)] px-1.5 py-0.5 text-[9px] font-semibold text-[#fdba74]"
                  >
                    ×{browserFailureSummary.repeatCount}
                  </span>
                )}
              </span>
              <span
                data-testid="browser-validation-failure-reason"
                className="mt-0.5 block truncate text-[10.5px] text-[var(--surface-text-subtle)]"
                title={browserFailureSummary.reason}
              >
                {browserFailureSummary.reason}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[9.5px] text-[var(--surface-text-muted)]" title={displayTarget}>
                {displayTarget}
              </span>
            </span>
            <span className="shrink-0 rounded-full border border-[rgba(251,146,60,0.22)] bg-[rgba(251,146,60,0.08)] px-1.5 py-0.5 text-[9px] text-[#fb923c]">
              {feedbackCopy.shortLabel}
            </span>
          </button>
        </div>
      );
    }

    return (
      <div className="w-full ml-9 mt-1 mb-2">
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-2 font-mono text-[11px] w-full rounded-md border border-[#27272a] px-2.5 py-1.5 shadow-sm transition-colors bg-[#07070a] text-[#a1a1aa] hover:text-[#e4e4e7] hover:border-[#3f3f46]"
        >
          <IconChevronRight className="w-3.5 h-3.5" />
          <IconComponent className="w-3.5 h-3.5" />
          <span className="text-[#e4e4e7]">
            {isSystemErrorCard
              ? errorTitle
              : language === "zh"
                ? `${localizedVerb}：`
                : `${localizedVerb}: `}
            {!isSystemErrorCard && <span className="font-semibold">{displayTarget}</span>}
          </span>
          <span
            className={`ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] ${
              isExecuted
                ? "border-[rgba(52,211,153,0.18)] bg-[rgba(52,211,153,0.08)] text-[#86efac]"
                : isRejected
                ? "border-[rgba(251,113,133,0.22)] bg-[rgba(251,113,133,0.08)] text-[#fb7185]"
                : "border-[rgba(251,146,60,0.22)] bg-[rgba(251,146,60,0.08)] text-[#fb923c]"
            }`}
          >
            {feedbackCopy.shortLabel}
          </span>
        </button>
      </div>
    );
  }

  // ── Expanded card ──
  return (
    <div className="w-full ml-9 mt-1 mb-2">
      <div className="bg-[#09090b] border border-[#27272a] rounded-lg p-4 shadow-sm">
        {/* Top row: icon + intent label + status badge + collapse toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              isExecuted ? "bg-[#059669]/15 text-[#10b981]" :
              isFailed ? "bg-[#f97316]/15 text-[#fb923c]" :
              isRejected ? "bg-[#e11d48]/15 text-[#fb7185]" :
              isRunning  ? "bg-amber-500/15 text-amber-400 animate-pulse" :
              "bg-[#27272a] text-[#a1a1aa]"
            }`}>
              <IconComponent className="w-4 h-4" />
            </div>
            <div className="flex flex-col">
              <span className="text-[13px] text-[#e4e4e7] leading-snug">
                {isSystemErrorCard
                  ? errorTitle
                  : language === "zh"
                    ? `AI 申请${localizedVerb}：`
                    : `AI requests to ${localizedVerb}: `}
                {!isSystemErrorCard && <span className="theme-text font-semibold">{displayTarget}</span>}
              </span>
              {isRunning && (
                <span data-testid="tool-status-label" className="text-[11px] text-amber-400 mt-0.5">{feedbackCopy.label}</span>
              )}
              {isPending && (
                <span data-testid="tool-status-label" className="text-[11px] text-[#a1a1aa] mt-0.5">{feedbackCopy.label}</span>
              )}
              {isExecuted && (
                <span data-testid="tool-status-label" className="text-[11px] text-[#10b981] mt-0.5 flex items-center gap-1">
                  <IconCheck className="w-3 h-3" /> {feedbackCopy.label}
                </span>
              )}
              {isRejected && (
                <span data-testid="tool-status-label" className="text-[11px] text-[#fb7185] mt-0.5">{feedbackCopy.label}</span>
              )}
              {isFailed && (
                <span data-testid="tool-status-label" className="text-[11px] text-[#fb923c] mt-0.5">{feedbackCopy.label}</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {canOpenDiff && (
              <button
                onClick={() => openDiffForTask(blockId)}
                className="flex items-center gap-1 rounded-md border border-[#1d4ed8]/25 bg-[#0a1020] px-2.5 py-1.5 text-[11px] font-medium text-[#93c5fd] transition-colors hover:border-[#2563eb]/40 hover:bg-[#111b34]"
              >
                <IconCode className="w-3.5 h-3.5" />
                {language === "zh" ? "查看 Diff" : "Open Diff"}
              </button>
            )}

            {/* Collapse toggle when done */}
            {isDone && (
              <button
                onClick={() => setExpanded(false)}
                className="text-[#71717a] hover:text-white p-1 transition-colors"
                title={language === "zh" ? "折叠" : "Collapse"}
              >
                <IconChevronDown className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Action buttons — only when pending */}
            {isPending && (
              <>
                <button
                  onClick={onReject}
                  className="px-3 py-1.5 text-[11px] font-medium rounded-md border border-[#27272a] bg-[#18181b] text-[#fb7185] hover:bg-[#e11d48]/20 hover:border-[#e11d48]/40 transition-colors"
                >
                  {language === "zh" ? "拒绝" : "Reject"}
                </button>
                {isShellApprovalGated && onAllowForSession && (
                  <button
                    onClick={onAllowForSession}
                    className="px-3 py-1.5 text-[11px] font-medium rounded-md border border-[rgba(124,58,237,0.35)] bg-[rgba(124,58,237,0.14)] text-[#ddd6fe] hover:bg-[rgba(124,58,237,0.22)] transition-colors"
                  >
                    {language === "zh" ? "本线程允许" : "Allow Thread"}
                  </button>
                )}
                <button
                  onClick={onAllow}
                  className="px-3 py-1.5 text-[11px] font-medium rounded-md theme-bg text-white hover:opacity-90 transition-opacity shadow-sm"
                >
                  {isShellApprovalGated
                    ? language === "zh" ? "允许一次" : "Allow Once"
                    : language === "zh" ? "允许执行" : "Allow & Run"}
                </button>
              </>
            )}
          </div>
        </div>

        {(purposeText || evidenceText) && (
          <div data-testid="tool-intent-summary" className="mt-3 rounded-lg border border-[rgba(96,165,250,0.18)] bg-[rgba(37,99,235,0.06)] px-3 py-2">
            {purposeText && (
              <div className="text-[12px] leading-5 text-[#dbeafe]">
                <span className="font-medium text-[#93c5fd]">{language === "zh" ? "目的：" : "Purpose: "}</span>
                {purposeText}
              </div>
            )}
            {evidenceText && (
              <div className={`${purposeText ? "mt-1" : ""} text-[11px] leading-5 text-[#a5b4fc]`}>
                <span className="font-medium text-[#818cf8]">{isDone ? language === "zh" ? "结果：" : "Result: " : language === "zh" ? "证据：" : "Evidence: "}</span>
                {evidenceText}
              </div>
            )}
          </div>
        )}

        {browserFailureSummary && (
          <div
            data-testid="browser-validation-failure-details"
            className="mt-3 rounded-lg border border-[rgba(251,146,60,0.22)] bg-[rgba(251,146,60,0.06)] px-3 py-2"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
              <span className="font-semibold text-[#fdba74]">
                {language === "zh" ? "失败动作" : "Failed action"}
              </span>
              {(browserFailureSummary.action || browserFailureSummary.selector) && (
                <span className="min-w-0 break-all font-mono text-[var(--surface-text)]">
                  {[browserFailureSummary.action, browserFailureSummary.selector].filter(Boolean).join(" · ")}
                </span>
              )}
              {browserFailureSummary.repeatCount > 1 && (
                <span className="shrink-0 rounded-full border border-[rgba(251,146,60,0.3)] px-1.5 py-0.5 text-[9px] text-[#fdba74]">
                  ×{browserFailureSummary.repeatCount}
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-[var(--surface-text-subtle)]">
              <span className="font-medium text-[#fb923c]">{language === "zh" ? "原因：" : "Reason: "}</span>
              {browserFailureSummary.reason}
            </div>
            {browserFailureSummary.repeatCount > 1 && (
              <div className="mt-1 text-[10px] text-[var(--surface-text-muted)]">
                {language === "zh"
                  ? "下方按调用保留了每次验证的完整证据。"
                  : "Each validation call and its complete evidence are retained below."}
              </div>
            )}
          </div>
        )}

        {repeatedBrowserFailureCalls.length > 0 && (
          <div data-testid="browser-validation-repeated-call-details" className="mt-3 space-y-1.5">
            {repeatedBrowserFailureCalls.map((call, callIndex) => {
              const callText = [
                call.message,
                call.evidence ? `${language === "zh" ? "证据" : "Evidence"}: ${call.evidence}` : "",
                call.observationSummary
                  ? `${language === "zh" ? "观察" : "Observation"}: ${call.observationSummary}`
                  : "",
              ].filter(Boolean).join("\n\n");
              return (
                <details
                  key={`${String(call.id ?? callIndex)}-${callIndex}`}
                  data-testid="browser-validation-repeated-call"
                  className="rounded-md border border-[var(--surface-border-soft)] bg-[color-mix(in_srgb,var(--surface-bg)_96%,transparent)] px-2.5 py-1.5"
                >
                  <summary className="cursor-pointer select-none text-[10.5px] text-[var(--surface-text-subtle)]">
                    {language === "zh" ? `第 ${callIndex + 1} 次调用` : `Call ${callIndex + 1}`}
                    {call.id != null ? ` · ${String(call.id)}` : ""}
                  </summary>
                  <pre className="mt-2 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words border-t border-[var(--surface-border-soft)] pt-2 font-mono text-[10px] leading-5 text-[var(--surface-text-muted)]">
                    {callText || (language === "zh" ? "无可用详情" : "No details available")}
                  </pre>
                </details>
              );
            })}
          </div>
        )}

        {isSystemErrorCard && errorInfo && (
          <div className="mt-3 rounded-lg border border-[rgba(251,113,133,0.22)] bg-[rgba(251,113,133,0.06)] px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-[#fecdd3]">{errorInfo.title}</div>
                <div className="mt-1 text-[11px] leading-5 text-[#fda4af]">{errorInfo.detail}</div>
              </div>
              {errorInfo.settingsTab && errorInfo.actionLabel && (
                <button
                  type="button"
                  onClick={() => {
                    setSettingsTab(errorInfo.settingsTab);
                    setIsSettingsOpen(true);
                  }}
                  className="shrink-0 rounded-md border border-[rgba(251,113,133,0.28)] bg-[rgba(127,29,29,0.22)] px-2.5 py-1.5 text-[11px] text-[#fecdd3] transition-colors hover:border-[rgba(251,113,133,0.5)] hover:bg-[rgba(127,29,29,0.34)]"
                >
                  {errorInfo.actionLabel}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Auto-approve toggle — only when pending */}
        {isPending && onToggleAutoApprove && !isShellApprovalGated && (
          <div className="mt-2.5 pt-2.5 border-t border-[#27272a] flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer select-none group">
              <input
                type="checkbox"
                checked={!!autoApproveTools}
                onChange={(e) => onToggleAutoApprove(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-[#3f3f46] bg-[#000000] accent-[var(--accent)] cursor-pointer"
              />
                <span className="text-[11px] text-[#71717a] group-hover:text-[#a1a1aa] transition-colors">
                  {language === "zh"
                    ? "开启自动审查并批准当前请求；本会话后续非破坏性工具会自动继续"
                    : "Turn on Auto Review and approve this request; later non-destructive tools continue automatically"}
                </span>
              </label>
            </div>
          )}

        {/* Expandable message area — pending cards may include permission preflight details. */}
        {message && repeatedBrowserFailureCalls.length === 0 && (() => {
          const presentation = buildToolResultPresentation({
            toolName: isSystemErrorCard ? "Error" : toolName,
            message,
            language: uiLanguage,
          });
          if (!presentation.text.trim() && presentation.sections.length === 0) return null;
          return (
            <div className="mt-3 pt-3 border-t border-[#27272a]">
              {presentation.kind === "terminal" ? (
                <TerminalResultDetails presentation={presentation} language={uiLanguage} />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#a1a1aa]">
                  {presentation.text}
                </pre>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
