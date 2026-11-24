import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
const load = createTsModuleLoader();
const { PLAN_QUESTION_TOOL } = load("src/store/runtimeV2/planQuestionTool.ts");
const { runtimeV2ProviderToolArgumentViolation } = load("src/store/runtimeV2/executionProviderToolSchema.ts");
const questions = load("src/lib/userQuestions.ts");
const call = question => ({ id: "ask", name: "ask_plan_questions", arguments: { title: "Confirm scope", questions: [question] } });
const spec = question => ({ revision: 1, purpose: "rules_interview", title: "Confirm scope", questions: [question] });

test("the advertised question schema requires an explicit options array and points to an omitted field", () => {
  const bad = call({ id: "scope", prompt: "Choose scope", selectionMode: "single" });
  const violation = runtimeV2ProviderToolArgumentViolation([bad], [PLAN_QUESTION_TOOL]);
  assert.match(violation?.reason || "", /arguments\.questions\[0\]\.options is required/);
  assert.deepEqual(bad.arguments.questions[0], { id: "scope", prompt: "Choose scope", selectionMode: "single" });
  assert.match(PLAN_QUESTION_TOOL.function.parameters.properties.questions.items.properties.options.description, /single.*multiple.*text/s);
});

test("semantic question diagnostics identify the question and field while keeping validation strict", () => {
  for (const [question, path] of [
    [{ id: "scope", prompt: "Choose", selectionMode: "single", options: [] }, "questions[0].options"],
    [{ id: "scope", prompt: "Choose", selectionMode: "multiple", options: [{ id: "a", label: "A" }], minSelections: 2 }, "questions[0].minSelections"],
    [{ id: "scope", prompt: "Choose", selectionMode: "single", options: [{ id: "a", label: "A" }, { id: "a", label: "Duplicate" }] }, "questions[0].options[1].id"],
    [{ id: "scope", prompt: "Describe", selectionMode: "text", options: [{ id: "a", label: "Not text" }] }, "questions[0].options"],
  ]) {
    const result = questions.validateUserQuestionnaireDefinition(spec(question));
    assert.equal(result.ok, false);
    assert.equal(result.issue.path, path);
    assert.equal(result.issue.questionId, "scope");
    assert.ok(result.issue.message);
    assert.equal(questions.normalizeUserQuestionnaire(spec(question)), null);
  }
});

test("explicit text questions and optional extra text preserve required and selection-count semantics", () => {
  const text = { id: "details", prompt: "Required technical details", selectionMode: "text", options: [], required: true };
  assert.equal(runtimeV2ProviderToolArgumentViolation([call(text)], [PLAN_QUESTION_TOOL]), null);
  const questionnaire = questions.normalizeUserQuestionnaire(spec(text));
  assert.ok(questionnaire);
  const answer = value => ({ requestId: "request", revision: 1, answers: [{ questionId: "details", selectedValues: [], text: value }] });
  assert.equal(questions.validateUserChoiceAnswer(questionnaire, answer(""), "request").ok, false);
  assert.equal(questions.validateUserChoiceAnswer(questionnaire, answer("Keep npm test and the CSV compatibility"), "request").ok, true);
  const selection = questions.normalizeUserQuestionnaire(spec({ id: "details", prompt: "Choose", selectionMode: "single", options: [{ id: "scope", label: "Current scope" }], required: true, allowText: true }));
  assert.equal(questions.validateUserChoiceAnswer(selection, answer("Extra text cannot bypass minSelections"), "request").ok, false);
});

test("an all-optional questionnaire still requires one actual decision, not an empty confirmation envelope", () => {
  const questionnaire = questions.normalizeUserQuestionnaire({ revision: 1, purpose: "rules_interview", title: "Optional details", questions: [
    { id: "choice", prompt: "Scope", selectionMode: "single", options: [{ id: "current", label: "Current project" }] },
    { id: "text", prompt: "Any technical constraint", selectionMode: "text", options: [] },
  ] });
  const empty = { requestId: "request", revision: 1, answers: [{ questionId: "choice", selectedValues: [] }, { questionId: "text", selectedValues: [] }] };
  assert.deepEqual(questions.validateUserChoiceAnswer(questionnaire, empty, "request"), { ok: false, reason: "decision_required" });
  for (const answer of [
    { ...empty, answers: [{ questionId: "choice", selectedValues: ["current"] }, empty.answers[1]] },
    { ...empty, answers: [empty.answers[0], { questionId: "text", selectedValues: [], text: "Preserve the existing human rule." }] },
  ]) assert.equal(questions.validateUserChoiceAnswer(questionnaire, answer, "request").ok, true);
  assert.equal(questions.validateUserChoiceAnswer(questionnaire, { ...empty, answers: [{ questionId: "choice", selectedValues: ["stop"] }, empty.answers[1]] }, "request").ok, false);
});
