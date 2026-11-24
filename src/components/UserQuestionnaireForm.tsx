import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UserChoiceActionRequest, UserChoiceResolutionIdentity } from "../lib/actionRequest";
import { toUserChoiceResolutionIdentity } from "../lib/actionRequest";
import { validateUserChoiceAnswer, type UserChoiceAnswer, type UserQuestion } from "../lib/userQuestions";
import "./UserQuestionnaireForm.css";

export interface UserQuestionnaireFormProps {
  request: UserChoiceActionRequest;
  language: "zh" | "en";
  disabled?: boolean;
  hideTitle?: boolean;
  onSubmit: (answer: UserChoiceAnswer, identity: UserChoiceResolutionIdentity) => void | Promise<unknown>;
  onCancel?: () => void;
}

function isQuestionAnswered(
  question: UserQuestion,
  values: Record<string, string[]>,
  texts: Record<string, string>,
): boolean {
  const selectedCount = (values[question.id] || []).length;
  const hasText = Boolean(texts[question.id]?.trim());
  if (question.selectionMode === "text") return hasText;
  if (selectedCount < (question.minSelections || 0) || selectedCount > (question.maxSelections || 0)) return false;
  if (question.required && selectedCount === 0 && !hasText) return false;
  return selectedCount > 0 || hasText;
}

/** The UI sends stable IDs, never a composed prose answer or approval action. */
export function UserQuestionnaireForm({ request, language, disabled, hideTitle = false, onSubmit, onCancel }: UserQuestionnaireFormProps) {
  const zh = language === "zh";
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = request.questionnaire;
  const ownerKey = JSON.stringify(toUserChoiceResolutionIdentity(request));
  const generation = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const otherInputRef = useRef<HTMLTextAreaElement>(null);
  const shouldFocusOther = useRef(false);

  useLayoutEffect(() => {
    generation.current += 1;
    setValues({});
    setTexts({});
    setOtherActive({});
    setActiveIndex(0);
    setPending(false);
    setError(null);
    return () => { generation.current += 1; };
  }, [ownerKey]);

  const totalQuestions = spec?.questions.length ?? 0;
  const clampedActiveIndex = totalQuestions > 0 ? Math.min(activeIndex, totalQuestions - 1) : 0;
  const currentQuestion = spec?.questions[clampedActiveIndex];
  const blocked = disabled || pending || request.status !== "pending";
  const showInlineOtherRow = !!currentQuestion &&
    currentQuestion.selectionMode !== "text" &&
    currentQuestion.allowText === true &&
    (currentQuestion.minSelections ?? 0) === 0;

  useEffect(() => {
    if (shouldFocusOther.current && otherInputRef.current) {
      shouldFocusOther.current = false;
      otherInputRef.current.focus();
    }
  });

  const selectPredefinedOption = (question: UserQuestion, optionId: string) => {
    setError(null);
    setValues(current => ({
      ...current,
      [question.id]: question.selectionMode === "multiple"
        ? (current[question.id] || []).includes(optionId)
          ? (current[question.id] || []).filter(id => id !== optionId)
          : [...(current[question.id] || []), optionId]
        : [optionId],
    }));
    if (question.selectionMode === "single") {
      setOtherActive(current => ({ ...current, [question.id]: false }));
      setTexts(current => ({ ...current, [question.id]: "" }));
    }
  };

  const activateOtherOption = (question: UserQuestion) => {
    setError(null);
    if (question.selectionMode === "single") {
      setValues(current => ({ ...current, [question.id]: [] }));
      setOtherActive(current => ({ ...current, [question.id]: true }));
      shouldFocusOther.current = true;
      return;
    }
    const nextActive = !(otherActive[question.id] || Boolean(texts[question.id]?.trim()));
    setOtherActive(current => ({ ...current, [question.id]: nextActive }));
    if (!nextActive) {
      setTexts(current => ({ ...current, [question.id]: "" }));
    } else {
      shouldFocusOther.current = true;
    }
  };

  useEffect(() => {
    if (!currentQuestion || blocked || currentQuestion.selectionMode === "text") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const target = document.activeElement as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const index = Number(event.key) - 1;
      if (index < currentQuestion.options.length) {
        event.preventDefault();
        selectPredefinedOption(currentQuestion, currentQuestion.options[index]!.id);
      } else if (showInlineOtherRow && index === currentQuestion.options.length) {
        event.preventDefault();
        activateOtherOption(currentQuestion);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [blocked, currentQuestion, showInlineOtherRow, otherActive, texts]);

  if (!spec || !currentQuestion) return null;

  const isVerificationPolicy = spec.purpose === "plan_verification_confirmation";
  const answeredCount = spec.questions.filter(question => isQuestionAnswered(question, values, texts)).length;
  const maxKeyShortcut = Math.min(9, currentQuestion.options.length + (showInlineOtherRow ? 1 : 0));
  const modeHint = currentQuestion.selectionMode === "text"
    ? (zh ? "文本输入" : "Text")
    : currentQuestion.selectionMode === "multiple"
      ? (currentQuestion.minSelections && currentQuestion.minSelections > 1
          ? (zh ? `多选 · 至少选 ${currentQuestion.minSelections} 项` : `Multi · min ${currentQuestion.minSelections}`)
          : (zh ? "多选" : "Multi-select"))
      : (maxKeyShortcut >= 1
          ? (zh ? `单选 · 按 1-${maxKeyShortcut} 快选` : `Single · Keys 1-${maxKeyShortcut}`)
          : (zh ? "单选" : "Single"));

  const isOtherSelected = showInlineOtherRow && (
    !!otherActive[currentQuestion.id] || Boolean(texts[currentQuestion.id]?.trim())
  );

  const submit = async () => {
    if (blocked) return;
    const answer: UserChoiceAnswer = {
      requestId: request.requestId,
      revision: spec.revision,
      answers: spec.questions.map(question => ({
        questionId: question.id,
        selectedValues: values[question.id] || [],
        ...(texts[question.id]?.trim() ? { text: texts[question.id].trim() } : {}),
      })),
    };
    const checked = validateUserChoiceAnswer(spec, answer, request.requestId);
    if (!checked.ok) {
      const firstInvalidIndex = spec.questions.findIndex(question => {
        const item = answer.answers.find(entry => entry.questionId === question.id);
        if (!item) return true;
        const singleCheck = validateUserChoiceAnswer(
          { ...spec, questions: [question] },
          { requestId: request.requestId, revision: spec.revision, answers: [item] },
          request.requestId,
        );
        return !singleCheck.ok && singleCheck.reason !== "decision_required";
      });
      if (firstInvalidIndex >= 0) {
        setActiveIndex(firstInvalidIndex);
      }
      setError(checked.reason);
      return;
    }
    const submittedGeneration = generation.current;
    setError(null);
    setPending(true);
    try {
      const result = await onSubmit(checked.answer, toUserChoiceResolutionIdentity(request));
      if (submittedGeneration === generation.current && result === false) setError("submission_failed");
    } catch {
      if (submittedGeneration === generation.current) setError("submission_failed");
    } finally {
      if (submittedGeneration === generation.current) setPending(false);
    }
  };

  const hasMultipleQuestions = spec.questions.length > 1;
  const isLastStep = !hasMultipleQuestions || clampedActiveIndex === spec.questions.length - 1;

  return (
    <form
      ref={formRef}
      data-testid="structured-user-questionnaire"
      className="user-questionnaire"
      onSubmit={event => {
        event.preventDefault();
        if (!isLastStep) {
          setError(null);
          setActiveIndex(current => Math.min(spec.questions.length - 1, current + 1));
          return;
        }
        void submit();
      }}
    >
      {(!hideTitle || spec.questions.length > 1 || !!spec.summary) && (
        <div className="user-questionnaire-introduction">
          {(!hideTitle || spec.questions.length > 1) && (
            <div className="user-questionnaire-header-row">
              {!hideTitle && <div className="user-questionnaire-title">{spec.title}</div>}
              {spec.questions.length > 1 && (
                <div className="user-questionnaire-stepper-wrap">
                  <span className="user-questionnaire-step-pill">
                    {zh ? `第 ${clampedActiveIndex + 1} / ${spec.questions.length} 题` : `${clampedActiveIndex + 1} / ${spec.questions.length}`}
                  </span>
                  <div data-testid="structured-question-stepper" className="user-questionnaire-stepper" role="tablist" aria-label={zh ? "问题列表" : "Questions"}>
                    {spec.questions.map((question, index) => {
                      const active = index === clampedActiveIndex;
                      const complete = isQuestionAnswered(question, values, texts);
                      return (
                        <button
                          key={question.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          aria-current={active ? "step" : undefined}
                          aria-label={zh ? `第 ${index + 1} 题：${question.prompt}` : `Question ${index + 1}: ${question.prompt}`}
                          data-testid="structured-question-step"
                          data-step-index={index}
                          data-answered={complete}
                          onClick={() => setActiveIndex(index)}
                          className={`user-questionnaire-step${active ? " is-active" : complete ? " is-answered" : ""}`}
                        >
                          {complete && !active ? "✓" : index + 1}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          {spec.summary && (
            <p className={`user-questionnaire-summary${isVerificationPolicy ? " is-policy-banner" : ""}`}>
              {spec.summary}
            </p>
          )}
        </div>
      )}

      <fieldset key={currentQuestion.id} disabled={blocked} className="user-questionnaire-question">
        <legend data-testid="structured-question-prompt" className="user-questionnaire-prompt">
          <span className="user-questionnaire-prompt-bar">
            <span className="user-questionnaire-prompt-row">
              <span aria-hidden="true" className="user-questionnaire-number">{clampedActiveIndex + 1}</span>
              <span>
                {currentQuestion.prompt}
                {currentQuestion.required && <span aria-hidden="true" className="user-questionnaire-required"> *</span>}
              </span>
            </span>
            <span className="user-questionnaire-mode-hint">{modeHint}</span>
          </span>
        </legend>

        <div data-testid="structured-question-options" className="user-questionnaire-options">
          {currentQuestion.options.map((option, optionIndex) => {
            const isSelected = (values[currentQuestion.id] || []).includes(option.id);
            return (
              <label
                key={option.id}
                data-testid="structured-question-option"
                data-selected={isSelected}
                className="user-questionnaire-option"
              >
                <span aria-hidden="true" className="user-questionnaire-keycap">{optionIndex + 1}</span>
                <span className="user-questionnaire-option-copy">
                  <span className="user-questionnaire-option-label">{option.label}</span>
                  {option.description && (
                    <span className="user-questionnaire-option-description">{option.description}</span>
                  )}
                </span>
                <input
                  type={currentQuestion.selectionMode === "multiple" ? "checkbox" : "radio"}
                  name={`${request.requestId}:${currentQuestion.id}`}
                  value={option.id}
                  checked={isSelected}
                  onChange={() => selectPredefinedOption(currentQuestion, option.id)}
                />
              </label>
            );
          })}

          {showInlineOtherRow && (
            <div
              data-testid="structured-question-other-option"
              data-selected={isOtherSelected}
              className="user-questionnaire-other-container"
            >
              <button
                type="button"
                disabled={blocked}
                aria-pressed={isOtherSelected}
                onClick={() => activateOtherOption(currentQuestion)}
                className="user-questionnaire-option user-questionnaire-other-trigger"
                data-selected={isOtherSelected}
              >
                <span aria-hidden="true" className="user-questionnaire-keycap">{currentQuestion.options.length + 1}</span>
                <span className="user-questionnaire-option-copy">
                  <span className="user-questionnaire-option-label">
                    {zh ? "其他（自定义输入）" : "Other (custom input)"}
                  </span>
                  <span className="user-questionnaire-option-description">
                    {zh ? "以上选项不完全符合？直接输入你的偏好或额外约束" : "Enter a custom option or requirement"}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={`user-questionnaire-other-indicator${currentQuestion.selectionMode === "multiple" ? " is-checkbox" : ""}${isOtherSelected ? " is-checked" : ""}`}
                />
              </button>
              {isOtherSelected && (
                <div className="user-questionnaire-other-editor">
                  <textarea
                    ref={otherInputRef}
                    aria-label={zh ? `${currentQuestion.prompt} - 其他（自定义输入）` : `${currentQuestion.prompt} - Other`}
                    value={texts[currentQuestion.id] || ""}
                    onChange={event => {
                      setError(null);
                      const nextValue = event.target.value;
                      setTexts(current => ({ ...current, [currentQuestion.id]: nextValue }));
                    }}
                    className="user-questionnaire-textarea"
                    placeholder={zh ? "输入你的自定义选择或要求…" : "Enter your custom choice or requirement…"}
                  />
                </div>
              )}
            </div>
          )}

          {currentQuestion.selectionMode !== "text" && currentQuestion.allowText && !showInlineOtherRow && (
            <textarea
              aria-label={currentQuestion.prompt}
              value={texts[currentQuestion.id] || ""}
              onChange={event => {
                setError(null);
                setTexts(current => ({ ...current, [currentQuestion.id]: event.target.value }));
              }}
              className="user-questionnaire-textarea"
              placeholder={zh ? "补充你的要求（可选）" : "Additional notes (optional)"}
            />
          )}

          {currentQuestion.selectionMode === "text" && (
            <textarea
              aria-label={currentQuestion.prompt}
              value={texts[currentQuestion.id] || ""}
              onChange={event => {
                setError(null);
                setTexts(current => ({ ...current, [currentQuestion.id]: event.target.value }));
              }}
              className="user-questionnaire-textarea"
              placeholder={zh ? "补充你的要求" : "Add your requirements"}
            />
          )}
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="text-[12px] text-[var(--surface-text-muted)]">
          {error === "decision_required"
            ? zh ? "请至少选择一项或填写一项有效回答。" : "Select at least one option or provide a nonempty answer."
            : zh ? "请完成必填问题，并检查选择数量；若提交未完成，请重试当前问题。" : "Complete the required questions and check the selections; retry the current question if submission did not complete."}
        </p>
      )}

      <div className="user-questionnaire-footer">
        <div className="user-questionnaire-footer-left">
          {onCancel && (
            <button
              type="button"
              disabled={blocked}
              onClick={onCancel}
              className="user-questionnaire-btn-ghost"
            >
              {zh ? "停止" : "Stop"}
            </button>
          )}
          {spec.questions.length > 1 && (
            <span className="user-questionnaire-progress">
              {zh ? `已答 ${answeredCount} / ${spec.questions.length} 题` : `${answeredCount} / ${spec.questions.length} answered`}
            </span>
          )}
        </div>
        <div className="user-questionnaire-footer-right">
          {hasMultipleQuestions && (
            <button
              type="button"
              disabled={blocked || clampedActiveIndex === 0}
              onClick={() => setActiveIndex(current => Math.max(0, current - 1))}
              className="user-questionnaire-btn-ghost"
            >
              {zh ? "← 上一题" : "← Previous"}
            </button>
          )}
          {!isLastStep ? (
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                setError(null);
                setActiveIndex(current => Math.min(spec.questions.length - 1, current + 1));
              }}
              className="theme-plan-primary user-questionnaire-btn-primary"
            >
              {zh ? "下一题 →" : "Next →"}
            </button>
          ) : (
            <button
              type="submit"
              disabled={blocked}
              className="theme-plan-primary user-questionnaire-btn-primary"
            >
              {pending ? (zh ? "正在提交…" : "Submitting…") : (zh ? "确认并继续" : "Confirm and continue")}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
