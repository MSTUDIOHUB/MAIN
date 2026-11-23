import { useEffect, useState } from "react";
import type { TurnAggregateV1 } from "../lib/runtime-v2/aggregate";
import { buildUserQuestionHistory, type UserQuestionHistoryEntry, type UserQuestionHistoryItem } from "../lib/userQuestionHistory";
import { IconCheck, IconChevronDown, IconChevronRight } from "./Icons";
import "./UserQuestionAnswerHistory.css";

export interface UserQuestionAnswerCardProps {
  entry: UserQuestionHistoryEntry;
  language: "zh" | "en";
  chatFontSize?: number;
}

export interface UserQuestionAnswerHistoryProps {
  aggregate?: TurnAggregateV1 | null | undefined;
  entries?: readonly UserQuestionHistoryEntry[];
  language: "zh" | "en";
  chatFontSize?: number;
}

function summarizeAnswer(item: UserQuestionHistoryItem, language: "zh" | "en"): string {
  const parts = [
    ...item.selectedLabels,
    ...(item.text ? [item.text.replace(/\s+/g, " ").trim()] : []),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : (language === "zh" ? "未补充" : "Not provided");
}

export function UserQuestionAnswerCard({ entry, language, chatFontSize = 13 }: UserQuestionAnswerCardProps) {
  const zh = language === "zh";
  const defaultExpanded = entry.questions.length <= 3;
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    setExpanded(entry.questions.length <= 3);
  }, [entry.requestId, entry.revision, entry.questions.length]);

  const previewItems = entry.questions.slice(0, 2);
  const remainingCount = Math.max(0, entry.questions.length - previewItems.length);
  const countLabel = zh ? `已确认 · ${entry.questions.length} 题` : `Confirmed · ${entry.questions.length}`;

  return (
    <section
      data-testid="user-question-answer-card"
      data-request-id={entry.requestId}
      aria-label={zh ? `已确认回答：${entry.title}` : `Confirmed answers: ${entry.title}`}
      className="qa-history-card"
      style={{ fontSize: chatFontSize, lineHeight: 1.6 }}
    >
      <button
        type="button"
        data-testid="user-question-answer-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(current => !current)}
        className={`qa-history-header${expanded ? " is-expanded" : ""}`}
      >
        <span className="qa-history-check" aria-hidden="true">
          <IconCheck className="h-3 w-3" />
        </span>
        <span className="qa-history-title">{entry.title}</span>
        <span className="qa-history-meta">
          <span>{countLabel}</span>
          {expanded
            ? <IconChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            : <IconChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        </span>
      </button>

      {!expanded && previewItems.length > 0 && (
        <button
          type="button"
          data-testid="user-question-answer-preview"
          onClick={() => setExpanded(true)}
          className="qa-history-preview"
        >
          {previewItems.map((question, index) => (
            <div key={question.id} className="qa-history-preview-row">
              <span className="qa-history-preview-q">{index + 1}. {question.prompt}</span>
              <span className="qa-history-preview-arrow" aria-hidden="true">→</span>
              <span className="qa-history-preview-a">{summarizeAnswer(question, language)}</span>
            </div>
          ))}
          {remainingCount > 0 && (
            <div className="qa-history-preview-more">
              {zh ? `+ 其余 ${remainingCount} 项已确认决策，点击展开` : `+ ${remainingCount} more confirmed decisions, click to expand`}
            </div>
          )}
        </button>
      )}

      {expanded && (
        <dl className="qa-history-list">
          {entry.questions.map((question, index) => (
            <div key={question.id} data-testid="user-question-answer-row" className="qa-history-row">
              <dt className="qa-history-row-dt">
                <span aria-hidden="true" className="qa-history-idx">{index + 1}</span>
                <span className="qa-history-prompt">{question.prompt}</span>
              </dt>
              <dd className="qa-history-dd">
                {!!question.selectedLabels.length && (
                  <div className="qa-history-chips">
                    {question.selectedLabels.map((label, optionIndex) => (
                      <span key={optionIndex} className="qa-history-chip">{label}</span>
                    ))}
                  </div>
                )}
                {question.text && <p className="qa-history-text">{question.text}</p>}
                {!question.selectedLabels.length && !question.text && (
                  <p className="qa-history-empty">{zh ? "未补充" : "Not provided"}</p>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export default function UserQuestionAnswerHistory({ aggregate, entries: explicitEntries, language, chatFontSize = 13 }: UserQuestionAnswerHistoryProps) {
  const entries = explicitEntries ?? buildUserQuestionHistory(aggregate);
  if (!entries.length) return null;
  return (
    <div
      data-testid="user-question-answer-history"
      className="qa-history-group"
      style={{ fontSize: chatFontSize, lineHeight: 1.6 }}
    >
      {entries.map(entry => (
        <UserQuestionAnswerCard
          key={`${entry.runId}:${entry.requestId}:${entry.revision}`}
          entry={entry}
          language={language}
          chatFontSize={chatFontSize}
        />
      ))}
    </div>
  );
}
