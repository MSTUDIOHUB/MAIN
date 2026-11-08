import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const source = "src/lib/userQuestions.ts";
const module = { exports: {} };
new Function("exports", "module", ts.transpileModule(fs.readFileSync(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText)(module.exports, module);
const { normalizeUserQuestionnaire, validateUserChoiceAnswer, renderUserChoiceAnswer } = module.exports;
const questionnaire = { revision: 2, purpose: "plan_confirmation", title: "Confirm scope", questions: [
  { id: "mode", prompt: "Deliverable", selectionMode: "single", options: [{ id: "document", label: "Plan document" }, { id: "executable", label: "Implementation plan" }], required: true },
  { id: "constraints", prompt: "Constraints", selectionMode: "multiple", options: [{ id: "offline", label: "Offline" }, { id: "small", label: "Small change" }], minSelections: 1, allowText: true },
  { id: "details", prompt: "Details", selectionMode: "text", required: true },
] };
const answer = { requestId: "request-1", revision: 2, answers: [
  { questionId: "mode", selectedValues: ["document"] },
  { questionId: "constraints", selectedValues: ["offline", "small"], text: "Preserve public API" },
  { questionId: "details", selectedValues: [], text: "Review design first" },
] };
test("structured single/multiple/text answers validate and retain each stable ID", () => {
  const normalized = normalizeUserQuestionnaire(questionnaire);
  assert.ok(normalized);
  const result = validateUserChoiceAnswer(normalized, answer, "request-1");
  assert.equal(result.ok, true);
  assert.deepEqual(result.answer, answer);
  assert.match(renderUserChoiceAnswer(normalized, result.answer), /Offline.*Small change/);
  assert.deepEqual(answer.answers[1].selectedValues, ["offline", "small"]);
});
test("stale revisions, request drift, foreign IDs, duplicates and cardinality fail closed", () => {
  const mutations = [
    { ...answer, requestId: "old" }, { ...answer, revision: 1 },
    { ...answer, answers: answer.answers.slice(1) },
    { ...answer, answers: [...answer.answers, answer.answers[0]] },
    { ...answer, answers: answer.answers.map((value, i) => i === 0 ? { ...value, selectedValues: ["document", "executable"] } : value) },
    { ...answer, answers: answer.answers.map((value, i) => i === 1 ? { ...value, selectedValues: ["foreign"] } : value) },
    { ...answer, answers: answer.answers.map((value, i) => i === 1 ? { ...value, selectedValues: ["offline", "offline"] } : value) },
    { ...answer, answers: answer.answers.map((value, i) => i === 2 ? { ...value, text: "" } : value) },
    { ...answer, answers: answer.answers.map((value, i) => i === 0 ? { ...value, text: "approve execution" } : value) },
  ];
  for (const value of mutations) assert.equal(validateUserChoiceAnswer(questionnaire, value, "request-1").ok, false);
});
test("question definitions reject duplicate IDs and impossible constraints", () => {
  for (const value of [
    { ...questionnaire, questions: [...questionnaire.questions, questionnaire.questions[0]] },
    { ...questionnaire, questions: [{ ...questionnaire.questions[0], options: [{ id: "x", label: "X" }, { id: "x", label: "Y" }] }] },
    { ...questionnaire, questions: [{ ...questionnaire.questions[1], minSelections: 3 }] },
  ]) assert.equal(normalizeUserQuestionnaire(value), null);
});
