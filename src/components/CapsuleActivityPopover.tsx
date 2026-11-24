import { useEffect, useState, type Ref } from "react";
import type { CapsuleActivityHistoryRow } from "../lib/capsuleActivityHistory";
import { IconClose } from "./Icons";

type Language = "zh" | "en";

export interface CapsuleActivityLine {
  title: string;
  target?: string;
  waitingSince?: number;
  count?: number;
  live?: boolean;
}

function WaitingTime({ since, language }: { since: number; language: Language }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="shrink-0 tabular-nums" aria-hidden="true">· {language === "zh" ? `${elapsed} 秒` : `${elapsed}s`}</span>;
}

export function CapsuleActivityText({ line, language, announce }: { line: CapsuleActivityLine; language: Language; announce?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-x-2 gap-y-0.5 flex-wrap text-left">
      <span aria-live={announce ? "polite" : undefined} aria-atomic={announce || undefined} className="min-w-0 font-medium [overflow-wrap:anywhere]">
        {line.title}{line.target && <> <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-[0.92em]">{line.target}</code></>}
      </span>
      {(line.waitingSince !== undefined || (line.count || 0) > 1) && (
        <span className="text-[0.85em] text-[var(--surface-text-muted)]">
          {line.waitingSince !== undefined
            ? <WaitingTime since={line.waitingSince} language={language} />
            : language === "zh" ? `${line.count} 项活动进行中` : `${line.count} activities in progress`}
        </span>
      )}
    </div>
  );
}

const OUTCOMES = {
  succeeded: { zh: "已完成", en: "Done", tone: "text-[var(--surface-text)]" },
  failed: { zh: "失败", en: "Failed", tone: "text-[var(--surface-text-strong)]" },
  blocked: { zh: "受阻", en: "Blocked", tone: "text-[var(--surface-text-strong)]" },
  not_executed: { zh: "未执行", en: "Not run", tone: "text-[var(--surface-text-muted)]" },
  waiting: { zh: "等待确认", en: "Awaiting input", tone: "theme-plan-text" },
  resumed: { zh: "已继续", en: "Resumed", tone: "theme-plan-text" },
  partial: { zh: "部分完成", en: "Partial", tone: "text-[var(--surface-text-muted)]" },
  canceled: { zh: "已取消", en: "Canceled", tone: "text-[var(--surface-text-muted)]" },
} satisfies Record<CapsuleActivityHistoryRow["outcome"], { zh: string; en: string; tone: string }>;

export default function CapsuleActivityPopover({ dialogRef, closeRef, onClose, language, current, history }: {
  dialogRef: Ref<HTMLDivElement>;
  closeRef: Ref<HTMLButtonElement>;
  onClose: () => void;
  language: Language;
  current: CapsuleActivityLine;
  history: readonly CapsuleActivityHistoryRow[];
}) {
  const timeFormat = new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  return (
    <div ref={dialogRef} id="run-status-popover" data-testid="effective-progress-popover" data-runtime-surface="run-status"
      role="dialog" aria-modal="false" aria-labelledby="run-status-popover-title"
      className="pointer-events-auto mb-3 w-full min-w-0 max-w-xl rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-1)] p-3.5 text-left text-xs text-[var(--surface-text)] shadow-xl">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="run-status-popover-title" className="text-[13px] font-semibold text-[var(--surface-text-strong)]">
          {language === "zh" ? "本轮活动" : "Turn activity"}
        </h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label={language === "zh" ? "关闭本轮活动" : "Close turn activity"}
          className="rounded-md p-1.5 text-[var(--surface-text-muted)] hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          <IconClose className="h-4 w-4" />
        </button>
      </div>
      <div data-testid="run-status-current-activity" className="mb-2.5 flex min-w-0 items-start gap-2.5 rounded-xl border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] px-3 py-2.5">
        <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${current.live ? "bg-[var(--accent)]" : "bg-[var(--surface-text-subtle)]"}`} />
        <div className="min-w-0">
          <p className="mb-0.5 text-[10px] text-[var(--surface-text-muted)]">{language === "zh" ? "当前状态" : "Current status"}</p>
          <CapsuleActivityText line={current} language={language} />
        </div>
      </div>
      {history.length ? (
        <ol data-testid="turn-activity-history" className="max-h-[min(16rem,42dvh)] overflow-y-auto overscroll-contain divide-y divide-[var(--surface-border-soft)] pr-1">
          {history.map(row => {
            const outcome = OUTCOMES[row.outcome];
            return (
              <li key={row.key} data-testid="turn-activity-row" data-outcome={row.outcome} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 px-1 py-2">
                {row.at !== null && <time dateTime={new Date(row.at).toISOString()} className="shrink-0 text-[10px] tabular-nums text-[var(--surface-text-muted)]">{timeFormat.format(row.at)}</time>}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {row.title}{row.target && <> <code className="text-[0.92em] text-[var(--surface-text-muted)]">{row.target}</code></>}
                </span>
                <span className={`shrink-0 rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] ${outcome.tone}`}>{outcome[language]}</span>
              </li>
            );
          })}
        </ol>
      ) : <p data-testid="turn-activity-empty" className="px-1 py-3 text-[var(--surface-text-muted)]">{language === "zh" ? "本轮活动将在这里更新" : "Activity for this turn will appear here"}</p>}
    </div>
  );
}
