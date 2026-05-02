// @ts-nocheck
import React, { useMemo } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import JobListCard from "./JobListCard";
import { MessageSegment } from "../lib/messageParser";
import { sanitizeAIOutput } from "../lib/sanitize";
import { useAppStore } from "../store/useAppStore";

interface TaskItem {
  text: string;
  done: boolean;
}

interface PlanReviewBlockProps {
  segments: MessageSegment[];
  onApprove: () => void;
  onReject: () => void;
}

const COPY = {
  zh: {
    proposedPlan: "方案预览",
    pendingReview: "待确认",
    waitingPlan: "等待 Agent 完成方案生成...",
    cancel: "取消",
    confirmStart: "确认并开始执行",
  },
  en: {
    proposedPlan: "Proposed Plan",
    pendingReview: "Pending Review",
    waitingPlan: "Waiting for the agent to finish the plan...",
    cancel: "Cancel",
    confirmStart: "Confirm & Start Execution",
  },
} as const;

/** Extract checkbox task items from the combined plan text. */
function extractTasks(segments: MessageSegment[]): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const seg of segments) {
    const raw = seg.type === 'plan' ? '' : seg.content; // skip JSON plan segments
    if (!raw) continue;
    // Match lines like: - [ ] Task description   OR   - [x] Task description
    const lines = raw.split('\n');
    for (const line of lines) {
      const m = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)/);
      if (m) {
        tasks.push({ done: m[1] !== ' ', text: m[2].trim() });
      }
    }
  }
  return tasks;
}

/** Strip checkbox lines from text so they aren't duplicated in the markdown body. */
function stripCheckboxLines(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^[-*]\s+\[[ xX]\]\s+/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default function PlanReviewBlock({ segments, onApprove, onReject }: PlanReviewBlockProps) {
  const language = useAppStore((s) => s.config.language) === "en" ? "en" : "zh";
  const copy = COPY[language];
  const tasks = useMemo(() => extractTasks(segments), [segments]);
  const doneCount = tasks.filter(t => t.done).length;
  const totalCount = tasks.length;
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const hasContent = segments.some(seg => {
    if (seg.type === 'thought') return sanitizeAIOutput(seg.content).length > 0;
    if (seg.type === 'plan') return true;
    if (seg.type === 'text') return sanitizeAIOutput(seg.content).length > 0;
    return false;
  });

  return (
    <div className="w-full max-w-3xl mx-auto my-3 rounded-xl border border-[rgba(124,58,237,0.35)] bg-[#0c0a1a] shadow-[0_0_24px_rgba(124,58,237,0.12)] overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[rgba(124,58,237,0.2)] bg-[rgba(124,58,237,0.06)]">
        <div className="flex items-center gap-2.5">
          <svg className="w-4 h-4 text-[#a78bfa]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <span className="text-[13px] font-semibold text-[#e4e4e7] tracking-wide">{copy.proposedPlan}</span>
        </div>
        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[rgba(234,179,8,0.12)] text-[#eab308] border border-[rgba(234,179,8,0.25)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#eab308] animate-pulse" />
          {copy.pendingReview}
        </span>
      </div>

      {/* ── Document Preview Body ── */}
      <div className="px-6 py-5 max-h-[55vh] overflow-y-auto">
        {hasContent ? (
          <div className="space-y-4">
            {/* ── Task Checklist ── */}
            {tasks.length > 0 && (
              <div className="space-y-3">
                {/* Progress bar */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-1.5 rounded-full bg-[#1e1b2e] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${progressPct}%`,
                        background: "linear-gradient(90deg, #7c3aed, #a78bfa)",
                      }}
                    />
                  </div>
                  <span className="text-[11px] text-[#a1a1aa] font-medium tabular-nums shrink-0">
                    {doneCount}/{totalCount}
                  </span>
                </div>

                {/* Task items */}
                <div className="space-y-1.5">
                  {tasks.map((task, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-[#0f0d1a] border border-[rgba(124,58,237,0.12)]"
                    >
                      <div className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center shrink-0 border transition-colors ${task.done ? 'bg-[#7c3aed] border-[#7c3aed]' : 'border-[#3f3f46] bg-transparent'}`}>
                        {task.done && (
                          <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                      <span className={`text-[12.5px] leading-snug ${task.done ? 'text-[#71717a] line-through' : 'text-[#d4d4d8]'}`}>
                        {task.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Plan Details (markdown without checkboxes) ── */}
            {segments.map((seg, i) => {
              if (seg.type === 'thought') {
                const cleanText = sanitizeAIOutput(seg.content);
                if (!cleanText) return null;
                const stripped = stripCheckboxLines(cleanText);
                if (!stripped) return null;
                return (
                  <div key={i} className="text-[#d4d4d8] leading-relaxed">
                    <MarkdownRenderer content={stripped} />
                  </div>
                );
              }
              if (seg.type === 'plan') {
                return <JobListCard key={i} jobs={seg.jobs} />;
              }
              const cleanText = sanitizeAIOutput(seg.content);
              if (!cleanText) return null;
              const stripped = stripCheckboxLines(cleanText);
              if (!stripped) return null;
              return (
                <div key={i} className="text-[#d4d4d8] leading-relaxed">
                  <MarkdownRenderer content={stripped} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-8 text-[#71717a] text-[13px]">
            <svg className="w-8 h-8 mx-auto mb-2 text-[#3f3f46]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            {copy.waitingPlan}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-end gap-3 px-5 py-3.5 border-t border-[rgba(124,58,237,0.2)] bg-[rgba(124,58,237,0.04)]">
        <button
          onClick={onReject}
          className="px-4 py-2 text-[12px] font-semibold rounded-lg border border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#e4e4e7] transition-colors"
        >
          {copy.cancel}
        </button>
        <button
          onClick={onApprove}
          className="flex items-center gap-2 px-5 py-2 text-[12px] font-bold rounded-lg text-white transition-all hover:scale-[1.03] shadow-[0_0_16px_rgba(124,58,237,0.35)]"
          style={{
            background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
          }}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          {copy.confirmStart}
        </button>
      </div>
    </div>
  );
}
