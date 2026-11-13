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
  const module = { exports: {} };
  cache.set(file, module.exports);
  const native = createRequire(file);
  const requireModule = name => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(file), name);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return load(candidate);
      }
    }
    return native(name);
  };
  new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file,
  }).outputText)(module.exports, module, requireModule);
  return module.exports;
}

const { buildUserQuestionHistory } = load("src/lib/userQuestionHistory.ts");
const runtime = load("src/lib/runtime-v2/index.ts");
const owner = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", clientSubmissionId: "submission-1", turnId: "turn-1" };
const run = { sessionKey: owner.sessionKey, sessionEpoch: owner.sessionEpoch, turnId: owner.turnId, runId: "run-1", parentRunId: null, attemptId: "attempt-1" };
const spec = { revision: 1, purpose: "plan_interview", title: "确认方案", questions: [
  { id: "platform", prompt: "交付平台", selectionMode: "single", options: [{ id: "desktop", label: "桌面应用" }, { id: "web", label: "网页应用" }], required: true },
  { id: "checks", prompt: "验收项目", selectionMode: "multiple", options: [{ id: "unit", label: "单元验证" }, { id: "ui", label: "界面验证" }], required: true, allowText: true },
  { id: "details", prompt: "补充要求", selectionMode: "text", options: [] },
] };
const answer = { requestId: "request-1", revision: 1, answers: [
  { questionId: "checks", selectedValues: ["ui", "unit"], text: "保留接口\n离线运行" },
  { questionId: "platform", selectedValues: ["desktop"] },
  { questionId: "details", selectedValues: [] },
] };
const paused = (requestId = "request-1", questionnaire = spec) => ({ type: "run.paused", run, blocker: { requestId, questionnaire } });
const decided = (patch = {}) => ({ type: "run.decision_recorded", run, requestId: "request-1", choice: "recheck", answer, ...patch });
const aggregate = events => ({ turn: owner, events });

test("history pairs user-facing prompts and choices, preserves text and optional empty answers", () => {
  const history = buildUserQuestionHistory(aggregate([paused(), decided()]));
  assert.deepEqual(history, [{ requestId: "request-1", runId: "run-1", title: "确认方案", revision: 1, questions: [
    { id: "platform", prompt: "交付平台", selectedLabels: ["桌面应用"] },
    { id: "checks", prompt: "验收项目", selectedLabels: ["单元验证", "界面验证"], text: "保留接口\n离线运行" },
    { id: "details", prompt: "补充要求", selectedLabels: [] },
  ] }]);
  assert.deepEqual(answer.answers[0].selectedValues, ["ui", "unit"], "presentation does not mutate canonical answers");
});

test("multiple rounds remain chronological and repeated decision delivery renders one card", () => {
  const secondSpec = { ...spec, revision: 2, title: "确认补充方案" };
  const secondAnswer = { ...answer, requestId: "request-2", revision: 2 };
  const secondDecision = decided({ requestId: "request-2", answer: secondAnswer });
  const history = buildUserQuestionHistory(aggregate([paused(), decided(), paused("request-2", secondSpec), secondDecision, secondDecision]));
  assert.deepEqual(history.map(item => [item.requestId, item.title, item.revision]), [["request-1", "确认方案", 1], ["request-2", "确认补充方案", 2]]);
});

test("unconfirmed, canceled, unknown, stale and malformed answers cannot appear as confirmation", () => {
  assert.deepEqual(buildUserQuestionHistory(null), []);
  assert.deepEqual(buildUserQuestionHistory(aggregate([paused()])), []);
  for (const decision of [decided({ choice: "stop" }), decided({ answer: undefined }), decided({ requestId: "other" }),
    decided({ answer: { ...answer, revision: 2 } }), decided({ answer: { ...answer, answers: [] } }),
    decided({ answer: { ...answer, answers: answer.answers.map(item => ({ ...item, selectedValues: ["foreign"] })) } })]) {
    assert.deepEqual(buildUserQuestionHistory(aggregate([paused(), decision])), []);
  }
  assert.deepEqual(buildUserQuestionHistory(aggregate([decided(), paused()])), [], "later questions cannot authorize an earlier reply");
  assert.deepEqual(buildUserQuestionHistory(aggregate([paused("request-1", { ...spec, questions: [] }), decided()])), []);
});

test("the exact Run owner and current Turn scope must match before a decision is displayed", () => {
  for (const [field, value] of Object.entries({ sessionKey: "other-session", sessionEpoch: "other-epoch", turnId: "other-turn", runId: "other-run", parentRunId: "other-parent", attemptId: "other-attempt" })) {
    const foreignRun = { ...run, [field]: value };
    assert.deepEqual(buildUserQuestionHistory(aggregate([paused(), decided({ run: foreignRun })])), [], field);
    if (["sessionKey", "sessionEpoch", "turnId"].includes(field)) {
      assert.deepEqual(buildUserQuestionHistory(aggregate([{ ...paused(), run: foreignRun }, decided({ run: foreignRun })])), [], `${field} scope`);
    }
  }
});

test("confirmed history survives canonical checkpoint serialization and cold ledger replay", () => {
  const append = (state, type, fields) => {
    const result = runtime.tryTransition(state, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: state?.nextSequence || 0,
      eventId: `${type}:${state?.nextSequence || 0}`, at: (state?.updatedAt || 0) + 1, type, ...fields });
    assert.equal(result.disposition, "applied", result.reason);
    return result.state;
  };
  let state = append(null, "turn.admitted", { turn: owner, strategy: "plan", objective: "Design the application", constraints: [], acceptanceCriteria: [] });
  state = append(state, "run.started", { run, phase: "planning" });
  for (const revision of [1, 2]) {
    const requestId = `request-${revision}`;
    state = append(state, "run.paused", { run, blocker: { requestId, reasonCode: "user_questionnaire", evidenceSequence: state.nextSequence - 1,
      message: spec.title, options: ["recheck", "stop"], questionnaire: { ...spec, revision } } });
    state = append(state, "run.decision_recorded", { run, requestId, choice: "recheck", answer: { ...answer, requestId, revision } });
    state = append(state, "run.resumed", { run, requestId });
  }
  const checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt });
  const raw = runtime.serializeRuntimeV2CheckpointMap({ [owner.turnId]: checkpoint })[owner.turnId];
  assert.equal(raw.aggregate, undefined, "persist only the canonical ledger");
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(raw)));
  assert.ok(restored);
  assert.deepEqual(buildUserQuestionHistory(restored.aggregate), buildUserQuestionHistory(state));
  assert.equal(buildUserQuestionHistory(restored.aggregate).length, 2);
});
