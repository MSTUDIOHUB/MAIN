import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  const native = createRequire(file);
  const requireModule = name => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(file), name);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return load(candidate);
    }
    return native(name);
  };
  new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file,
  }).outputText)(module.exports, module, requireModule);
  return module.exports;
}
const runtime = load("src/lib/runtime-v2/index.ts");
const owner = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", clientSubmissionId: "submission-1", turnId: "turn-1" };
const run = { sessionKey: owner.sessionKey, sessionEpoch: owner.sessionEpoch, turnId: owner.turnId, runId: "run-1", parentRunId: null, attemptId: "run-1" };
const questionnaire = { revision: 1, purpose: "plan_interview", title: "Constraints", questions: [{ id: "constraints", prompt: "Select constraints", selectionMode: "multiple", options: [{ id: "api", label: "Keep API" }, { id: "offline", label: "Offline" }], required: true }] };
function append(state, type, fields) {
  return runtime.tryTransition(state, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: state?.nextSequence || 0, eventId: `${type}:${state?.nextSequence || 0}`, at: (state?.updatedAt || 0) + 1, type, ...fields });
}
function paused() {
  let state = append(null, "turn.admitted", { turn: owner, strategy: "plan", objective: "Design a bounded change", constraints: [], acceptanceCriteria: [] }).state;
  state = append(state, "run.started", { run, phase: "planning" }).state;
  return append(state, "run.paused", { run, blocker: { requestId: "request-1", reasonCode: "user_questionnaire", evidenceSequence: state.nextSequence - 1, message: questionnaire.title, options: ["recheck", "stop"], questionnaire } }).state;
}
test("kernel rejects invalid selections and stale revisions, and preserves multi answers across ledger replay", () => {
  const state = paused();
  const answer = { requestId: "request-1", revision: 1, answers: [{ questionId: "constraints", selectedValues: ["api", "offline"] }] };
  for (const invalid of [{ ...answer, revision: 0 }, { ...answer, answers: [{ questionId: "constraints", selectedValues: ["foreign"] }] }]) {
    assert.equal(append(state, "run.decision_recorded", { run, requestId: "request-1", choice: "recheck", answer: invalid }).disposition, "rejected");
  }
  const decided = append(state, "run.decision_recorded", { run, requestId: "request-1", choice: "recheck", answer });
  assert.equal(decided.disposition, "applied");
  assert.deepEqual(decided.state.run.blocker.decisionAnswer, answer);
  assert.equal(decided.state.workPlan, null, "information confirmation is not execution approval");
  let replayed = null;
  for (const event of decided.state.events) replayed = runtime.transition(replayed, event);
  assert.deepEqual(replayed.run.blocker.decisionAnswer, answer);
  assert.equal(append(decided.state, "run.decision_recorded", { run, requestId: "request-1", choice: "recheck", answer }).disposition, "rejected", "double submit is rejected");
});

for (const purpose of ["plan_confirmation", "plan_interview", "rules_interview"]) test(`kernel rejects an all-empty optional ${purpose} answer and Stop cannot become confirmation`, () => {
  let state = append(null, "turn.admitted", { turn: owner, strategy: "plan", objective: "Confirm real user decisions", constraints: [], acceptanceCriteria: [] }).state;
  state = append(state, "run.started", { run, phase: "planning" }).state;
  const optional = { ...questionnaire, purpose, questions: questionnaire.questions.map(question => ({ ...question, required: false })) };
  state = append(state, "run.paused", { run, blocker: { requestId: "optional-request", reasonCode: "user_questionnaire", evidenceSequence: state.nextSequence - 1, message: optional.title, options: ["recheck", "stop"], questionnaire: optional } }).state;
  const answer = { requestId: "optional-request", revision: 1, answers: [{ questionId: "constraints", selectedValues: [] }] };
  assert.equal(append(state, "run.decision_recorded", { run, requestId: "optional-request", choice: "recheck", answer }).disposition, "rejected");
  const stopped = append(state, "run.decision_recorded", { run, requestId: "optional-request", choice: "stop" });
  assert.equal(stopped.disposition, "applied");
  assert.equal(stopped.state.events.some(event => event.type === "run.decision_recorded" && event.answer && event.choice !== "stop"), false);
  assert.equal(stopped.state.workPlan, null);
  assert.equal(append(stopped.state, "run.resumed", { run, requestId: "optional-request" }).disposition, "rejected");
});
