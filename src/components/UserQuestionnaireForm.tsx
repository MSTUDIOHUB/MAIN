import { useLayoutEffect, useRef, useState } from "react";
import type { UserChoiceActionRequest, UserChoiceResolutionIdentity } from "../lib/actionRequest";
import { toUserChoiceResolutionIdentity } from "../lib/actionRequest";
import { validateUserChoiceAnswer, type UserChoiceAnswer } from "../lib/userQuestions";
import "./UserQuestionnaireForm.css";

export interface UserQuestionnaireFormProps {
  request: UserChoiceActionRequest;
  language: "zh" | "en";
  disabled?: boolean;
  onSubmit: (answer: UserChoiceAnswer, identity: UserChoiceResolutionIdentity) => void | Promise<unknown>;
  onCancel?: () => void;
}

/** The UI sends stable IDs, never a composed prose answer or approval action. */
export function UserQuestionnaireForm({ request, language, disabled, onSubmit, onCancel }: UserQuestionnaireFormProps) {
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = request.questionnaire;
  const ownerKey = JSON.stringify(toUserChoiceResolutionIdentity(request));
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current += 1;
    setValues({}); setTexts({}); setPending(false); setError(null);
    return () => { generation.current += 1; };
  }, [ownerKey]);
  if (!spec) return null;
  const blocked = disabled || pending || request.status !== "pending";
  const submit = async () => {
    if (blocked) return;
    const answer: UserChoiceAnswer = { requestId: request.requestId, revision: spec.revision,
      answers: spec.questions.map(question => ({ questionId: question.id, selectedValues: values[question.id] || [], ...(texts[question.id]?.trim() ? { text: texts[question.id].trim() } : {}) })) };
    const checked = validateUserChoiceAnswer(spec, answer, request.requestId);
    if (!checked.ok) { setError(checked.reason); return; }
    const submittedGeneration = generation.current;
    setError(null); setPending(true);
    try {
      const result = await onSubmit(checked.answer, toUserChoiceResolutionIdentity(request));
      if (submittedGeneration === generation.current && result === false) setError("submission_failed");
    } catch { if (submittedGeneration === generation.current) setError("submission_failed"); }
    finally { if (submittedGeneration === generation.current) setPending(false); }
  };
  return <form data-testid="structured-user-questionnaire" className="user-questionnaire" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="user-questionnaire-introduction"><div className="user-questionnaire-title">{spec.title}</div>
      {spec.summary && <p className="user-questionnaire-summary">{spec.summary}</p>}</div>
    {spec.questions.map((question, index) => <fieldset key={question.id} disabled={blocked} className="user-questionnaire-question">
      <legend data-testid="structured-question-prompt" className="user-questionnaire-prompt">
        <span className="user-questionnaire-prompt-row"><span aria-hidden="true" className="user-questionnaire-number">{index + 1}</span>
          <span>{question.prompt}{question.required && <span aria-hidden="true" className="user-questionnaire-required"> *</span>}</span></span>
      </legend>
      <div data-testid="structured-question-options" className="user-questionnaire-options">
      {question.options.map(option => <label key={option.id} data-testid="structured-question-option" data-selected={(values[question.id] || []).includes(option.id)} className="user-questionnaire-option">
        <input type={question.selectionMode === "multiple" ? "checkbox" : "radio"} name={`${request.requestId}:${question.id}`} value={option.id}
          checked={(values[question.id] || []).includes(option.id)}
          onChange={() => setValues(current => ({ ...current, [question.id]: question.selectionMode === "multiple"
            ? (current[question.id] || []).includes(option.id) ? (current[question.id] || []).filter(id => id !== option.id) : [...(current[question.id] || []), option.id]
            : [option.id] }))} />
        <span className="user-questionnaire-option-copy"><span className="user-questionnaire-option-label">{option.label}</span>{option.description && <span className="user-questionnaire-option-description">{option.description}</span>}</span>
      </label>)}
      {(question.selectionMode === "text" || question.allowText) && <textarea aria-label={question.prompt} value={texts[question.id] || ""}
        onChange={event => setTexts(current => ({ ...current, [question.id]: event.target.value }))}
        className="user-questionnaire-textarea"
        placeholder={language === "zh" ? "补充你的要求" : "Add your requirements"} />}
      </div>
    </fieldset>)}
    {error && <p role="alert" className="text-[12px] text-[var(--surface-text-muted)]">{error === "decision_required"
      ? language === "zh" ? "请至少选择一项或填写一项有效回答。" : "Select at least one option or provide a nonempty answer."
      : language === "zh" ? "请完成必填问题，并检查选择数量；若提交未完成，请重试当前问题。" : "Complete the required questions and check the selections; retry the current question if submission did not complete."}</p>}
    <div className="flex justify-end gap-2">
      {onCancel && <button type="button" disabled={blocked} onClick={onCancel} className="rounded-lg border border-[var(--surface-border)] px-3 py-2 text-[12px] text-[var(--surface-text-muted)]">{language === "zh" ? "停止" : "Stop"}</button>}
      <button type="submit" disabled={blocked} className="theme-plan-primary rounded-lg px-4 py-2 text-[12px] disabled:opacity-50">{pending ? (language === "zh" ? "正在提交…" : "Submitting…") : (language === "zh" ? "确认并继续" : "Confirm and continue")}</button>
    </div>
  </form>;
}
