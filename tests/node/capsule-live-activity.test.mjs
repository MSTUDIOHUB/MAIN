import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../../src/lib/capsuleLiveActivity.ts", import.meta.url), "utf8");
const module = { exports: {} };
new Function("exports", ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText)(module.exports);
const {
  beginCapsuleModelActivity,
  beginCapsuleToolActivity,
  getCapsuleLiveActivitySnapshot,
  subscribeCapsuleLiveActivity,
} = module.exports;

const run = {
  sessionKey: "workspace:session",
  sessionEpoch: "session-generation",
  turnId: "turn-a",
  runId: "run-a",
  parentRunId: null,
  attemptId: "attempt-a",
};

test("each transport dispatch restarts waiting and only its first decoded output changes the snapshot", (t) => {
  const controller = new AbortController();
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const stages = [];
  const unsubscribe = subscribeCapsuleLiveActivity(() => {
    stages.push(getCapsuleLiveActivitySnapshot()[0]?.stage);
  });
  t.after(() => { controller.abort(); unsubscribe(); });

  const activity = beginCapsuleModelActivity(run, "model-command", controller.signal);
  activity.acquiringLane();
  const firstOutput = activity.requestDispatched();
  const firstWaiting = getCapsuleLiveActivitySnapshot()[0];
  assert.equal(firstWaiting.startedAt, 100);
  now = 500;
  const secondOutput = activity.requestDispatched();
  const waitingSnapshot = getCapsuleLiveActivitySnapshot();
  assert.equal(waitingSnapshot[0].startedAt, 500);
  assert.notEqual(waitingSnapshot[0].key, firstWaiting.key);

  firstOutput();
  assert.equal(getCapsuleLiveActivitySnapshot(), waitingSnapshot);
  secondOutput();
  const receivingSnapshot = getCapsuleLiveActivitySnapshot();
  assert.equal(receivingSnapshot[0].stage, "receiving");
  secondOutput();
  assert.equal(getCapsuleLiveActivitySnapshot(), receivingSnapshot);

  activity.finish();
  assert.deepEqual(stages, ["preparing", "acquiring_lane", "waiting", "waiting", "receiving", undefined]);
});

test("stale finishes and aborts cannot clear the replacement request or another Run's parallel tools", (t) => {
  const originalController = new AbortController();
  const replacementController = new AbortController();
  const unrelatedController = new AbortController();
  const controllers = [originalController, replacementController, unrelatedController];
  t.after(() => controllers.forEach((controller) => controller.abort()));

  const original = beginCapsuleModelActivity(run, "model-command", originalController.signal);
  const staleOutput = original.requestDispatched();
  const replacement = beginCapsuleModelActivity(run, "model-command", replacementController.signal);
  const currentOutput = replacement.requestDispatched();
  const unrelatedRun = { ...run, sessionEpoch: "replacement-session-generation" };
  const firstTool = beginCapsuleToolActivity({
    run: unrelatedRun,
    commandKey: "read-one",
    signal: unrelatedController.signal,
    toolName: "read_file",
    target: "one.ts",
  });
  beginCapsuleToolActivity({
    run: unrelatedRun,
    commandKey: "read-two",
    signal: unrelatedController.signal,
    toolName: "read_file",
    target: "two.ts",
  });

  originalController.abort();
  staleOutput();
  original.finish();
  assert.deepEqual(getCapsuleLiveActivitySnapshot().map(({ commandKey }) => commandKey), [
    "model-command", "read-one", "read-two",
  ]);
  assert.equal(getCapsuleLiveActivitySnapshot()[0].stage, "waiting");
  firstTool();
  replacementController.abort();
  currentOutput();
  assert.deepEqual(getCapsuleLiveActivitySnapshot().map(({ commandKey }) => commandKey), ["read-two"]);
  unrelatedController.abort();
  assert.deepEqual(getCapsuleLiveActivitySnapshot(), []);
});
