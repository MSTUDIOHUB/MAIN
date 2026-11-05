import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
const { assessUnityConsole: assess } = createTsModuleLoader()("tests/e2e/unityConsoleAssessment.ts");

test("shared Editor Console excludes only recorded history from the same session", () => {
  const result = { session: "editor-A", entries: [{ seq: 4 }, { seq: 11 }], groundTruth: { compilationFailed: false } };
  assert.deepEqual(assess(result, { session: "editor-A", cursor: 10 }).errors, [{ seq: 11 }]);
  assert.equal(assess(result, { session: "editor-A", cursor: 10 }).retainedBaselineErrors, 1);
  assert.equal(assess(result, { session: "editor-B", cursor: 10 }).errors.length, 2, "a reset Console cannot hide new lower sequence errors");
});
test("current compilation failure and unverified entries cannot become a clean Console", () => {
  const result = { session: "A", entries: [{ seq: 1 }], groundTruth: { compilationFailed: true } };
  assert.equal(assess(result, { session: "A", cursor: 2 }).compilationFailed, true);
  assert.equal(assess({ ...result, entries: [{}] }, { session: "A", cursor: 2 }).errors.length, 1);
  assert.throws(() => assess({ entries: [] }), /could not be verified/);
});
