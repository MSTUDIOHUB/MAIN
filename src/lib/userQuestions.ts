/** Questions describe user information. Answers never grant tool permission. */
export interface UserQuestionOption { readonly id: string; readonly label: string; readonly description?: string }
export interface UserQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly selectionMode: "single" | "multiple" | "text";
  readonly options: readonly UserQuestionOption[];
  readonly required?: boolean;
  readonly allowText?: boolean;
  readonly minSelections?: number;
  readonly maxSelections?: number;
}
export interface UserQuestionnaire {
  readonly revision: number;
  readonly purpose: "plan_confirmation" | "plan_interview" | "rules_interview";
  readonly title: string;
  readonly summary?: string;
  readonly questions: readonly UserQuestion[];
}
export interface UserQuestionAnswer {
  readonly questionId: string;
  readonly selectedValues: readonly string[];
  readonly text?: string;
}
export interface UserChoiceAnswer {
  readonly requestId: string;
  readonly revision: number;
  readonly answers: readonly UserQuestionAnswer[];
}
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export interface UserQuestionnaireDefinitionIssue {
  readonly path: string;
  readonly questionId?: string;
  readonly message: string;
}
export type UserQuestionnaireDefinitionValidation =
  | { readonly ok: true; readonly questionnaire: UserQuestionnaire }
  | { readonly ok: false; readonly issue: UserQuestionnaireDefinitionIssue };

/** One semantic definition gate for model repair, persisted requests and UI.
 * Diagnostics name the invalid field; they never manufacture answer choices. */
export function validateUserQuestionnaireDefinition(value: unknown): UserQuestionnaireDefinitionValidation {
  const invalid = (path: string, message: string, questionId?: string): UserQuestionnaireDefinitionValidation =>
    ({ ok: false, issue: { path, ...(questionId ? { questionId } : {}), message } });
  if (!record(value)) return invalid("$", "Expected a questionnaire object.");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return invalid("revision", "Expected a positive integer revision.");
  if (!text(value.title)) return invalid("title", "Provide a nonempty questionnaire title.");
  if (!["plan_confirmation", "plan_interview", "rules_interview"].includes(String(value.purpose))) return invalid("purpose", "Unknown questionnaire purpose.");
  if (!Array.isArray(value.questions) || !value.questions.length) return invalid("questions", "Provide at least one real question.");
  const ids = new Set<string>();
  const questions: UserQuestion[] = [];
  for (const [index, raw] of value.questions.entries()) {
    const path = `questions[${index}]`;
    if (!record(raw)) return invalid(path, "Expected a question object.");
    const id = text(raw.id);
    const fail = (field: string, message: string) => invalid(`${path}.${field}`, message, id);
    if (!id || ids.has(id)) return fail("id", "Provide a nonempty question ID unique within this questionnaire.");
    ids.add(id);
    if (!text(raw.prompt)) return fail("prompt", "Provide the complete user-facing question.");
    if (!["single", "multiple", "text"].includes(String(raw.selectionMode))) return fail("selectionMode", "Use single, multiple or text.");
    for (const field of ["required", "allowText"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "boolean") return fail(field, "Expected a boolean.");
    }
    for (const field of ["minSelections", "maxSelections"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "number") return fail(field, "Expected an integer selection count.");
    }
    if (raw.options !== undefined && !Array.isArray(raw.options)) return fail("options", "Provide an array of options with stable id and user-facing label; text uses [].");
    const options: UserQuestionOption[] = [];
    const optionIds = new Set<string>();
    for (const [optionIndex, option] of ((raw.options || []) as unknown[]).entries()) {
      const optionPath = `options[${optionIndex}]`;
      if (!record(option)) return fail(optionPath, "Expected an option object with id and label.");
      if (!text(option.id) || optionIds.has(text(option.id))) return fail(`${optionPath}.id`, "Provide a nonempty stable option ID unique within this question.");
      if (!text(option.label)) return fail(`${optionPath}.label`, "Provide a nonempty user-facing option label.");
      optionIds.add(text(option.id));
      options.push({ id: text(option.id), label: text(option.label), ...(text(option.description) ? { description: text(option.description) } : {}) });
    }
    if (raw.selectionMode !== "text" && !options.length) return fail("options", `${raw.selectionMode} questions require at least one explicit {id,label} option. Do not omit options or infer the user's answer.`);
    if (raw.selectionMode === "text" && options.length) return fail("options", "text questions require options: []; use single or multiple for selectable choices.");
    const maximum = raw.selectionMode === "single" ? 1 : raw.selectionMode === "text" ? 0 : options.length;
    const min = raw.minSelections === undefined ? (raw.required && raw.selectionMode !== "text" ? 1 : 0) : Number(raw.minSelections);
    const max = raw.maxSelections === undefined ? maximum : Number(raw.maxSelections);
    if (!Number.isSafeInteger(min) || min < 0 || min > maximum || min > max) return fail("minSelections", `Expected an integer between 0 and ${Math.min(maximum, max)}, consistent with the available options and maxSelections.`);
    if (!Number.isSafeInteger(max) || max < 0 || max > maximum) return fail("maxSelections", `Expected an integer between minSelections and ${maximum}.`);
    questions.push({ id, prompt: text(raw.prompt), selectionMode: raw.selectionMode as UserQuestion["selectionMode"], options,
      required: raw.required === true, allowText: raw.selectionMode === "text" || raw.allowText === true, minSelections: min, maxSelections: max });
  }
  return { ok: true, questionnaire: { revision: Number(value.revision), purpose: value.purpose as UserQuestionnaire["purpose"], title: text(value.title), ...(text(value.summary) ? { summary: text(value.summary) } : {}), questions } };
}

export function normalizeUserQuestionnaire(value: unknown): UserQuestionnaire | null {
  const checked = validateUserQuestionnaireDefinition(value);
  return checked.ok ? checked.questionnaire : null;
}

export function userQuestionnaireDefinitionFeedback(issue: UserQuestionnaireDefinitionIssue): string {
  return JSON.stringify({ code: "QUESTION_DEFINITION_INVALID", ...issue, effect: "none",
    instruction: "Correct this exact field in ask_plan_questions. Supply explicit stable option IDs and labels for single/multiple; use options:[] for text. No user answer or confirmation has been recorded." });
}

export type UserChoiceAnswerValidation = { readonly ok: true; readonly answer: UserChoiceAnswer } | { readonly ok: false; readonly reason: string };
export function validateUserChoiceAnswer(questionnaire: UserQuestionnaire, value: unknown, requestId: string): UserChoiceAnswerValidation {
  const spec = normalizeUserQuestionnaire(questionnaire);
  const invalid = (reason: string): UserChoiceAnswerValidation => ({ ok: false, reason });
  if (!spec || !record(value) || value.requestId !== requestId || value.revision !== spec.revision || !Array.isArray(value.answers)) return invalid("request_or_revision_mismatch");
  if (value.answers.length !== spec.questions.length) return invalid("question_count_mismatch");
  const seen = new Set<string>();
  const answers: UserQuestionAnswer[] = [];
  for (const raw of value.answers) {
    if (!record(raw) || !text(raw.questionId) || seen.has(text(raw.questionId)) || !Array.isArray(raw.selectedValues) || raw.selectedValues.some(item => typeof item !== "string" || !item.trim())) return invalid("invalid_answer");
    const question = spec.questions.find(item => item.id === raw.questionId);
    if (!question) return invalid("unknown_question");
    if (raw.text !== undefined && typeof raw.text !== "string") return invalid("invalid_text");
    seen.add(question.id);
    const selected = raw.selectedValues.map(item => (item as string).trim());
    if (new Set(selected).size !== selected.length || selected.some(id => !question.options.some(option => option.id === id))) return invalid("invalid_selection");
    const reply = text(raw.text);
    if (reply && !question.allowText) return invalid("text_not_allowed");
    if (selected.length < (question.minSelections || 0) || selected.length > (question.maxSelections || 0)) return invalid("selection_count_mismatch");
    if (question.required && !selected.length && !reply) return invalid("answer_required");
    selected.sort((a, b) => question.options.findIndex(option => option.id === a) - question.options.findIndex(option => option.id === b));
    answers.push({ questionId: question.id, selectedValues: selected, ...(reply ? { text: reply } : {}) });
  }
  answers.sort((a, b) => spec.questions.findIndex(question => question.id === a.questionId) - spec.questions.findIndex(question => question.id === b.questionId));
  if (!answers.some(answer => answer.selectedValues.length > 0 || !!answer.text)) return invalid("decision_required");
  return { ok: true, answer: { requestId, revision: spec.revision, answers } };
}

export function renderUserChoiceAnswer(questionnaire: UserQuestionnaire, answer: UserChoiceAnswer): string {
  const validated = validateUserChoiceAnswer(questionnaire, answer, answer.requestId);
  if (!validated.ok) throw new Error(`INVALID_USER_CHOICE_ANSWER: ${validated.reason}`);
  return validated.answer.answers.map(item => {
    const question = questionnaire.questions.find(question => question.id === item.questionId)!;
    const values = item.selectedValues.map(id => question.options.find(option => option.id === id)!.label);
    return `${question.prompt}: ${[...values, ...(item.text ? [item.text] : [])].join("; ")}`;
  }).join("\n");
}

export function sameUserQuestionnaire(left: UserQuestionnaire | undefined, right: UserQuestionnaire | undefined): boolean {
  const a = left ? normalizeUserQuestionnaire(left) : null;
  const b = right ? normalizeUserQuestionnaire(right) : null;
  return (!left || !!a) && (!right || !!b) && JSON.stringify(a) === JSON.stringify(b);
}
