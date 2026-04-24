// @ts-nocheck
import React, { useState, useEffect, useMemo } from "react";
import { IconSearch, IconFile, IconFolder, IconTerminal, IconCode, IconTool, IconCheck, IconChevronDown, IconChevronRight } from "./Icons";
import { getDiffStats } from "../lib/diff";
import { stripAnsi } from "../lib/sanitize";
import { useAppStore } from "../store/useAppStore";

// Map tool names to human-readable action labels
const TOOL_LABELS: Record<string, { verb: { zh: string; en: string }; icon: React.FC<{ className?: string }> }> = {
  list_directory:   { verb: { zh: "扫描目录", en: "scan directory" }, icon: IconFolder },
  glob_search:      { verb: { zh: "搜索文件", en: "search files" }, icon: IconSearch },
  grep_search:      { verb: { zh: "搜索内容", en: "search content" }, icon: IconSearch },
  read_file:        { verb: { zh: "读取文件", en: "read file" }, icon: IconFile },
  read_document:    { verb: { zh: "读取文档", en: "read document" }, icon: IconFile },
  analyze_tabular_document: { verb: { zh: "分析表格", en: "analyze table" }, icon: IconFile },
  query_tabular_document: { verb: { zh: "查询表格", en: "query table" }, icon: IconFile },
  index_workspace_documents: { verb: { zh: "索引文档", en: "index documents" }, icon: IconFolder },
  replace_in_file:  { verb: { zh: "修改文件", en: "edit file" }, icon: IconCode },
  write_file:       { verb: { zh: "写入文件", en: "write file" }, icon: IconCode },
  execute_command:  { verb: { zh: "执行命令", en: "run command" }, icon: IconTerminal },
  send_pty_input:   { verb: { zh: "发送终端输入", en: "send terminal input" }, icon: IconTerminal },
  run_command:      { verb: { zh: "运行命令并等待", en: "run command and wait" }, icon: IconTerminal },
  read_pty_buffer:  { verb: { zh: "读取终端", en: "read terminal" }, icon: IconTerminal },
  read_pty_tail:    { verb: { zh: "读取终端尾部", en: "read terminal tail" }, icon: IconTerminal },
  read_pty_since:   { verb: { zh: "读取新增终端输出", en: "read new terminal output" }, icon: IconTerminal },
  get_pty_status:   { verb: { zh: "检查终端状态", en: "check terminal status" }, icon: IconTerminal },
  clear_pty_buffer: { verb: { zh: "清空终端缓冲", en: "clear terminal buffer" }, icon: IconTerminal },
  Error:            { verb: { zh: "报告错误", en: "report error" }, icon: IconTool },
};

const COMPACT_DONE_TOOLS = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
]);

interface ActionCardProps {
  blockId?: number;
  toolName: string;
  target: string;
  toolStatus: "pending" | "executed" | "rejected" | "running" | "failed";
  message?: string;
  diff?: { old: string; new: string; path?: string };
  onAllow?: () => void;
  onReject?: () => void;
  autoApproveTools?: boolean;
  onToggleAutoApprove?: (v: boolean) => void;
  autoCollapse?: boolean;
}

export default function ActionCard({ blockId, toolName, target, toolStatus, message, diff, onAllow, onReject, autoApproveTools, onToggleAutoApprove, autoCollapse }: ActionCardProps) {
  const language = useAppStore((s) => s.config.language);
  const openDiffForTask = useAppStore((s) => s.openDiffForTask);
  const info = TOOL_LABELS[toolName] || { verb: { zh: "调用工具", en: "use tool" }, icon: IconTool };
  const localizedVerb = info.verb[language === "en" ? "en" : "zh"];
  const IconComponent = info.icon;
  const isPending = toolStatus === "pending";
  const isRunning = toolStatus === "running";
  const isExecuted = toolStatus === "executed";
  const isRejected = toolStatus === "rejected";
  const isFailed = toolStatus === "failed";
  const isDone = isExecuted || isRejected || isFailed;
  const isSystemErrorCard = toolName === "Error";

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
    ? (language === "zh" ? "系统请求失败" : "System request failed")
    : target
      ? target.split("/").pop() || target
      : toolName;
  const canOpenDiff = isExecuted && !!diff && blockId != null;
  const diffStats = useMemo(
    () => (diff ? getDiffStats(diff.old, diff.new) : null),
    [diff?.new, diff?.old],
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
        <div className="w-full ml-9 mt-1 mb-1 flex items-center gap-2 font-mono text-[10.5px] text-[#71717a]">
          <IconCheck className="h-3 w-3 text-[#10b981]" />
          <span className="shrink-0">{language === "zh" ? localizedVerb : localizedVerb}</span>
          <span className="min-w-0 truncate text-[#a1a1aa]">{displayTarget}</span>
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
              ? displayTarget
              : language === "zh"
                ? `${localizedVerb}：`
                : `${localizedVerb}: `}
            {!isSystemErrorCard && <span className="font-semibold">{displayTarget}</span>}
          </span>
          {isExecuted && <IconCheck className="w-3 h-3 ml-1 text-[#10b981]" />}
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
                  ? displayTarget
                  : language === "zh"
                    ? `AI 申请${localizedVerb}：`
                    : `AI requests to ${localizedVerb}: `}
                {!isSystemErrorCard && <span className="theme-text font-semibold">{displayTarget}</span>}
              </span>
              {isRunning && (
                <span className="text-[11px] text-amber-400 mt-0.5">{language === "zh" ? "执行中..." : "Running..."}</span>
              )}
              {isExecuted && (
                <span className="text-[11px] text-[#10b981] mt-0.5 flex items-center gap-1">
                  <IconCheck className="w-3 h-3" /> {language === "zh" ? "已完成" : "Done"}
                </span>
              )}
              {isRejected && (
                <span className="text-[11px] text-[#fb7185] mt-0.5">{language === "zh" ? "已拒绝" : "Rejected"}</span>
              )}
              {isFailed && (
                <span className="text-[11px] text-[#fb923c] mt-0.5">{language === "zh" ? "执行失败" : "Failed"}</span>
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
                <button
                  onClick={onAllow}
                  className="px-3 py-1.5 text-[11px] font-medium rounded-md theme-bg text-white hover:opacity-90 transition-opacity shadow-sm"
                >
                  {language === "zh" ? "允许执行" : "Allow & Run"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Auto-approve toggle — only when pending */}
        {isPending && onToggleAutoApprove && (
          <div className="mt-2.5 pt-2.5 border-t border-[#27272a] flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer select-none group">
              <input
                type="checkbox"
                checked={!!autoApproveTools}
                onChange={(e) => onToggleAutoApprove(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-[#3f3f46] bg-[#000000] accent-[var(--accent)] cursor-pointer"
              />
              <span className="text-[11px] text-[#71717a] group-hover:text-[#a1a1aa] transition-colors">
                {language === "zh" ? "本次会话内自动允许后续所有命令" : "Auto-approve all commands in this session"}
              </span>
            </label>
          </div>
        )}

        {/* Expandable message area for executed/rejected — terminal styling for commands */}
        {message && !isPending && (() => {
          const isTerminal = toolName === 'execute_command' || toolName === 'send_pty_input' || toolName === 'run_command' || toolName === 'read_pty_buffer' || toolName === 'read_pty_tail' || toolName === 'read_pty_since' || toolName === 'get_pty_status' || toolName === 'clear_pty_buffer';
          const cleanMessage = isTerminal ? stripAnsi(message) : message;
          return (
            <div className="mt-3 pt-3 border-t border-[#27272a]">
              <pre className={`whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto ${
                isTerminal
                  ? 'bg-[#000000] border border-[#27272a] rounded-md p-3 font-mono text-[11px] text-[#d4d4d8]'
                  : 'font-mono text-[11px] text-[#a1a1aa]'
              }`}>
                {cleanMessage}
              </pre>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
