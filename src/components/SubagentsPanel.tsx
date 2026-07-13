import { useMemo } from "react";
import {
  IconCheck,
  IconClose,
  IconStop,
  IconSubagent,
  IconSubagentClosed,
} from "./Icons";
import {
  isSubagentActiveStatus,
  type SubagentCapacityPolicy,
  type SubagentRunRecord,
  type SubagentStatus,
} from "../lib/subagents";
import type { ThemeMode } from "../lib/appTypes";

interface SubagentsPanelProps {
  runs: SubagentRunRecord[];
  selectedId: string | null;
  capacityPolicy: SubagentCapacityPolicy;
  language: "zh" | "en";
  themeMode: ThemeMode;
  onSelect: (id: string) => void;
  onStop: (id: string) => void;
}

function statusLabel(status: SubagentStatus, language: "zh" | "en"): string {
  const labels: Record<SubagentStatus, { zh: string; en: string }> = {
    queued: { zh: "排队中", en: "Queued" },
    starting: { zh: "启动中", en: "Starting" },
    running: { zh: "执行中", en: "Running" },
    summarizing: { zh: "整理中", en: "Summarizing" },
    completed: { zh: "已完成", en: "Completed" },
    blocked: { zh: "已受阻", en: "Blocked" },
    degraded: { zh: "已降级由主体接管", en: "Handed back to main" },
    failed: { zh: "失败", en: "Failed" },
    canceled: { zh: "已取消", en: "Canceled" },
  };
  return labels[status][language];
}

function statusTone(status: SubagentStatus, light: boolean): string {
  if (status === "completed") {
    return light
      ? "border-[#b7dfc5] bg-[#edf8f1] text-[#137333]"
      : "border-[rgba(52,211,153,0.28)] bg-[rgba(52,211,153,0.08)] text-[#86efac]";
  }
  if (status === "failed" || status === "blocked") {
    return light
      ? "border-[#f3c5c5] bg-[#fff1f1] text-[#b3261e]"
      : "border-[rgba(248,113,113,0.28)] bg-[rgba(248,113,113,0.08)] text-[#fca5a5]";
  }
  if (status === "degraded") {
    return light
      ? "border-[#e2c56f] bg-[#fff8df] text-[#765700]"
      : "border-[rgba(250,204,21,0.3)] bg-[rgba(250,204,21,0.08)] text-[#fde047]";
  }
  if (status === "canceled") {
    return light
      ? "border-[#dedede] bg-[#f5f5f5] text-[#5f6368]"
      : "border-[#3f3f46] bg-[#18181b] text-[#a1a1aa]";
  }
  return light
    ? "border-[#c8d8f4] bg-[#eef4ff] text-[#2855a6]"
    : "border-[rgba(96,165,250,0.28)] bg-[rgba(96,165,250,0.08)] text-[#93c5fd]";
}

function formatTime(timestamp: number | undefined, language: "zh" | "en"): string {
  if (!timestamp) return language === "zh" ? "尚未开始" : "Not started";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatDuration(run: SubagentRunRecord, language: "zh" | "en"): string {
  const start = run.startedAt || run.createdAt;
  const end = run.completedAt || run.closedAt || Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return language === "zh" ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return language === "zh" ? `${minutes} 分 ${remainder} 秒` : `${minutes}m ${remainder}s`;
}

function ActivityIcon({ run, className }: { run: SubagentRunRecord; className?: string }) {
  if (isSubagentActiveStatus(run.status)) {
    return <span className={`h-2.5 w-2.5 rounded-full bg-[#60a5fa] shadow-[0_0_8px_rgba(96,165,250,0.7)] animate-pulse ${className || ""}`} />;
  }
  if (run.status === "completed") return <IconCheck className={`text-[#34d399] ${className || ""}`} />;
  if (run.status === "degraded") return <IconSubagentClosed className={`text-[#fde047] ${className || ""}`} />;
  if (run.status === "canceled") return <IconSubagentClosed className={`text-[#a1a1aa] ${className || ""}`} />;
  return <IconClose className={`text-[#f87171] ${className || ""}`} />;
}

export default function SubagentsPanel({
  runs,
  selectedId,
  capacityPolicy,
  language,
  themeMode,
  onSelect,
  onStop,
}: SubagentsPanelProps) {
  const isLight = themeMode === "light";
  const selected = useMemo(
    () => runs.find((run) => run.id === selectedId) || [...runs].reverse()[0] || null,
    [runs, selectedId],
  );
  const activeCount = runs.filter((run) => isSubagentActiveStatus(run.status)).length;
  const completedCount = runs.filter((run) => run.status === "completed").length;

  return (
    <div data-testid="subagents-panel" className={`flex h-full min-h-0 flex-col ${isLight ? "bg-[#ffffff] text-[#202124]" : "bg-[#050505] text-[#e4e4e7]"}`}>
      <div className={`shrink-0 border-b px-4 py-3 ${isLight ? "border-[#e4e4e7] bg-[#fafafa]" : "border-[#18181b] bg-[#09090b]"}`}>
        <div className="grid grid-cols-3 gap-3 text-[11px]">
          <div>
            <div className={isLight ? "text-[#5f6368]" : "text-[#71717a]"}>{language === "zh" ? "活跃" : "Active"}</div>
            <div className="mt-0.5 text-[14px] font-semibold">{activeCount} / {capacityPolicy.maxActiveRequests}</div>
          </div>
          <div>
            <div className={isLight ? "text-[#5f6368]" : "text-[#71717a]"}>{language === "zh" ? "已完成" : "Completed"}</div>
            <div className="mt-0.5 text-[14px] font-semibold">{completedCount}</div>
          </div>
          <div>
            <div className={isLight ? "text-[#5f6368]" : "text-[#71717a]"}>{language === "zh" ? "本轮上限" : "Turn cap"}</div>
            <div className="mt-0.5 text-[14px] font-semibold">{capacityPolicy.maxCreatedPerTurn}</div>
          </div>
        </div>
        <div className={`mt-2 truncate text-[10px] ${isLight ? "text-[#80868b]" : "text-[#71717a]"}`} title={`${capacityPolicy.provider} · ${capacityPolicy.model}`}>
          {capacityPolicy.profile === "local"
            ? language === "zh" ? "本地主体 + 最多 2 个子流" : "Local parent + up to 2 child streams"
            : language === "zh" ? "云端受控并行" : "Controlled cloud parallelism"}
          {` · ${capacityPolicy.provider} · ${capacityPolicy.model}`}
        </div>
      </div>

      <div className={`max-h-[38%] shrink-0 overflow-y-auto border-b p-2 ${isLight ? "border-[#e4e4e7]" : "border-[#18181b]"}`}>
        {runs.length === 0 ? (
          <div className={`px-3 py-6 text-center text-[12px] ${isLight ? "text-[#80868b]" : "text-[#71717a]"}`}>
            {language === "zh" ? "当前任务尚未创建子智能体。" : "No subagents have been created for this task."}
          </div>
        ) : [...runs].reverse().map((run) => {
          const isSelected = selected?.id === run.id;
          return (
            <button
              key={run.id}
              type="button"
              data-testid={`subagent-list-item-${run.id}`}
              aria-pressed={isSelected}
              onClick={() => onSelect(run.id)}
              className={`mb-1 flex w-full min-w-0 items-center gap-3 rounded-[6px] border px-3 py-2 text-left transition-colors last:mb-0 ${
                isSelected
                  ? isLight ? "border-[#9bbbf2] bg-[#eef4ff]" : "border-[rgba(96,165,250,0.4)] bg-[rgba(37,99,235,0.12)]"
                  : isLight ? "border-transparent hover:border-[#e4e4e7] hover:bg-[#f8f9fa]" : "border-transparent hover:border-[#27272a] hover:bg-[#111113]"
              }`}
            >
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border ${isLight ? "border-[#dadce0] bg-white" : "border-[#27272a] bg-[#050505]"}`}>
                <ActivityIcon run={run} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[12px] font-semibold">{run.name}</span>
                  <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] ${statusTone(run.status, isLight)}`}>
                    {statusLabel(run.status, language)}
                  </span>
                </span>
                <span className={`mt-0.5 block truncate text-[10px] ${isLight ? "text-[#5f6368]" : "text-[#8f8f98]"}`}>
                  {run.progress?.title || run.objective}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div data-testid="subagent-detail" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <IconSubagent className="h-4 w-4 shrink-0 text-[#7c3aed]" />
                <h3 className="truncate text-[14px] font-semibold">{selected.name}</h3>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${statusTone(selected.status, isLight)}`}>
                  {statusLabel(selected.status, language)}
                </span>
              </div>
              <div className={`mt-1 text-[10px] ${isLight ? "text-[#5f6368]" : "text-[#71717a]"}`}>
                {selected.role} · {formatTime(selected.startedAt || selected.createdAt, language)} · {formatDuration(selected, language)}
              </div>
            </div>
            {isSubagentActiveStatus(selected.status) && (
              <button
                type="button"
                data-testid="stop-subagent-button"
                onClick={() => onStop(selected.id)}
                title={language === "zh" ? "停止子智能体" : "Stop subagent"}
                aria-label={language === "zh" ? "停止子智能体" : "Stop subagent"}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border transition-colors ${
                  isLight ? "border-[#dadce0] text-[#5f6368] hover:bg-[#fce8e6] hover:text-[#c5221f]" : "border-[#27272a] text-[#a1a1aa] hover:bg-[rgba(248,113,113,0.1)] hover:text-[#f87171]"
                }`}
              >
                <IconStop className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <section className={`mt-4 border-t pt-3 ${isLight ? "border-[#e4e4e7]" : "border-[#27272a]"}`}>
            <div className={`text-[10px] font-medium uppercase ${isLight ? "text-[#5f6368]" : "text-[#8f8f98]"}`}>{language === "zh" ? "目标" : "Objective"}</div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5">{selected.objective}</p>
          </section>

          {selected.progress && (
            <section className={`mt-4 border-t pt-3 ${isLight ? "border-[#e4e4e7]" : "border-[#27272a]"}`}>
              <div className={`text-[10px] font-medium uppercase ${isLight ? "text-[#5f6368]" : "text-[#8f8f98]"}`}>{language === "zh" ? "当前状态" : "Current status"}</div>
              <div className="mt-2 flex items-start gap-2 text-[12px] leading-5">
                <ActivityIcon run={selected} className="mt-1 h-3 w-3 shrink-0" />
                <div className="min-w-0">
                  <div>{selected.progress.title}</div>
                  {(selected.progress.tool || selected.progress.target) && (
                    <div className={`mt-0.5 break-all font-mono text-[10px] ${isLight ? "text-[#5f6368]" : "text-[#8f8f98]"}`}>
                      {[selected.progress.tool, selected.progress.target].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {selected.activities.length > 0 && (
            <section className={`mt-4 border-t pt-3 ${isLight ? "border-[#e4e4e7]" : "border-[#27272a]"}`}>
              <div className={`text-[10px] font-medium uppercase ${isLight ? "text-[#5f6368]" : "text-[#8f8f98]"}`}>{language === "zh" ? "执行记录" : "Activity"}</div>
              <div className="mt-2 space-y-2">
                {selected.activities.map((activity) => (
                  <div key={activity.id} className="grid grid-cols-[14px_minmax(0,1fr)] gap-2 text-[11px] leading-4">
                    <span className={`mt-1 h-1.5 w-1.5 rounded-full ${
                      activity.status === "completed" ? "bg-[#34d399]" : activity.status === "running" ? "bg-[#60a5fa]" : activity.status === "canceled" ? "bg-[#a1a1aa]" : "bg-[#f87171]"
                    }`} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="truncate">{activity.title}</span>
                        <span className={`shrink-0 text-[9px] ${isLight ? "text-[#80868b]" : "text-[#71717a]"}`}>{formatTime(activity.timestampMs, language)}</span>
                      </div>
                      {(activity.tool || activity.target) && (
                        <div className={`mt-0.5 truncate font-mono text-[9px] ${isLight ? "text-[#5f6368]" : "text-[#8f8f98]"}`} title={[activity.tool, activity.target].filter(Boolean).join(" · ")}>
                          {[activity.tool, activity.target].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {selected.summary && (
            <section className={`mt-4 border-t pt-3 ${isLight ? "border-[#e4e4e7]" : "border-[#27272a]"}`}>
              <div className={`text-[10px] font-medium uppercase ${isLight ? "text-[#5f6368]" : "text-[#8f8f98]"}`}>
                {language === "zh" ? "返回摘要" : "Returned summary"}
              </div>
              <div className={`mt-2 whitespace-pre-wrap break-words rounded-[6px] border px-3 py-2 text-[11px] leading-5 ${isLight ? "border-[#e4e4e7] bg-[#f8f9fa] text-[#3c4043]" : "border-[#27272a] bg-[#09090b] text-[#d4d4d8]"}`}>
                {selected.summary}
              </div>
            </section>
          )}

          {selected.error && selected.status !== "completed" && (
            <section className={`mt-4 border-t pt-3 ${isLight ? "border-[#e4e4e7]" : "border-[#27272a]"}`}>
              <div className="text-[10px] font-medium uppercase text-[#f87171]">
                {selected.status === "degraded"
                  ? language === "zh" ? "接管原因" : "Handoff reason"
                  : language === "zh" ? "阻塞原因" : "Blocker"}
              </div>
              <div className={`mt-2 whitespace-pre-wrap break-words rounded-[6px] border px-3 py-2 text-[11px] leading-5 ${isLight ? "border-[#f3c5c5] bg-[#fff7f7] text-[#b3261e]" : "border-[rgba(248,113,113,0.24)] bg-[rgba(248,113,113,0.06)] text-[#fca5a5]"}`}>
                {selected.error}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
