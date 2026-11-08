import type { TurnAggregateV1 } from "../lib/runtime-v2/aggregate";
import { buildUserQuestionHistory } from "../lib/userQuestionHistory";
import { IconCheck } from "./Icons";

export interface UserQuestionAnswerHistoryProps {
  aggregate: TurnAggregateV1 | null | undefined;
  language: "zh" | "en";
  chatFontSize?: number;
}

export default function UserQuestionAnswerHistory({ aggregate, language, chatFontSize = 13 }: UserQuestionAnswerHistoryProps) {
  const entries = buildUserQuestionHistory(aggregate);
  if (!entries.length) return null;
  return <div data-testid="user-question-answer-history" className="flex w-full min-w-0 flex-col items-end gap-3 text-left"
    style={{ fontSize: chatFontSize, lineHeight: 1.6 }}>
    {entries.map(entry => <section key={`${entry.runId}:${entry.requestId}:${entry.revision}`}
      data-testid="user-question-answer-card" data-request-id={entry.requestId}
      aria-label={language === "zh" ? `已确认回答：${entry.title}` : `Confirmed answers: ${entry.title}`}
      className="w-[85%] min-w-0 rounded-2xl rounded-tr-sm border px-4 py-3 max-sm:w-full"
      style={{ borderColor: "color-mix(in srgb, var(--accent) 32%, var(--surface-border))", background: "color-mix(in srgb, var(--accent) 5%, var(--surface-1))", color: "var(--surface-text)" }}>
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b pb-3" style={{ borderColor: "color-mix(in srgb, var(--accent) 14%, var(--surface-border-soft))" }}>
        <h3 className="min-w-0 flex-1 break-words font-semibold text-[var(--surface-text-strong)]">{entry.title}</h3>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium"
          style={{ fontSize: "0.82em", background: "color-mix(in srgb, var(--accent) 12%, transparent)", color: "var(--surface-text)" }}>
          <IconCheck className="h-3 w-3" aria-hidden="true" />{language === "zh" ? "已确认" : "Confirmed"}
        </span>
      </header>
      <dl className="space-y-4 pt-3">
        {entry.questions.map((question, index) => <div key={question.id} data-testid="user-question-answer-row" className="grid min-w-0 grid-cols-[1.5em_minmax(0,1fr)] gap-x-2">
          <dt className="col-span-2 grid grid-cols-subgrid items-start gap-x-2">
            <span aria-hidden="true" className="mt-0.5 flex h-[1.5em] w-[1.5em] items-center justify-center rounded-full font-medium"
              style={{ fontSize: "0.8em", color: "var(--surface-text-muted)", background: "color-mix(in srgb, var(--accent) 8%, var(--surface-2))" }}>{index + 1}</span>
            <span className="min-w-0 break-words font-medium text-[var(--surface-text-muted)]" style={{ fontSize: "0.9em" }}>{question.prompt}</span>
          </dt>
          <dd className="col-start-2 mt-1.5 min-w-0 space-y-2">
            {!!question.selectedLabels.length && <div className="flex min-w-0 flex-wrap gap-1.5">
              {question.selectedLabels.map((label, optionIndex) => <span key={optionIndex} className="max-w-full whitespace-pre-wrap break-words rounded-lg border px-2.5 py-1 font-medium text-[var(--surface-text-strong)]"
                style={{ borderColor: "color-mix(in srgb, var(--accent) 20%, transparent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)" }}>{label}</span>)}
            </div>}
            {question.text && <p className="whitespace-pre-wrap break-words text-[var(--surface-text-strong)]">{question.text}</p>}
            {!question.selectedLabels.length && !question.text && <p className="text-[var(--surface-text-subtle)]" style={{ fontSize: "0.9em" }}>{language === "zh" ? "未补充" : "Not provided"}</p>}
          </dd>
        </div>)}
      </dl>
    </section>)}
  </div>;
}
