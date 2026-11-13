import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const js = ts.transpileModule(fs.readFileSync(new URL("../../src/lib/retiredFeatureMigration.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function("module", "exports", js)(module, module.exports);
const { shareSessionStartupMigration, mergeCommittedStartupSessions } = module.exports;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("StrictMode cleanup and resubscribe share local-save through native completion", async () => {
  const ref = { current: null }, localSave = deferred(), native = deferred(), trace = [];
  const task = shareSessionStartupMigration(ref, async () => {
    trace.push("local-save"); await localSave.promise;
    trace.push("native-cas-and-cleanup"); await native.promise;
    trace.push("marker"); return { committed: true };
  });
  let firstActive = true, firstPublished = 0, secondPublished = 0;
  const firstSubscription = task.then(() => { if (firstActive) firstPublished++; });
  firstActive = false;
  const remountedTask = shareSessionStartupMigration(ref, () => assert.fail("StrictMode cannot launch a second local save"));
  assert.equal(remountedTask, task);
  const secondSubscription = remountedTask.then(() => secondPublished++);
  await Promise.resolve(); assert.deepEqual(trace, ["local-save"]);
  localSave.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(trace, ["local-save", "native-cas-and-cleanup"]);
  assert.equal(secondPublished, 0);
  native.resolve(); await Promise.all([firstSubscription, secondSubscription]);
  assert.deepEqual(trace, ["local-save", "native-cas-and-cleanup", "marker"]);
  assert.equal(firstPublished, 0); assert.equal(secondPublished, 1);
});

test("failed startup can retry and an older rejection cannot release a replacement task", async () => {
  const ref = { current: null }, save = deferred();
  const failed = shareSessionStartupMigration(ref, async () => { await save.promise; });
  save.reject(new Error("CAS_CONFLICT")); await assert.rejects(failed, /CAS_CONFLICT/);
  assert.equal(ref.current, null);
  assert.equal(await shareSessionStartupMigration(ref, async () => "retried-current-state"), "retried-current-state");
  const staleRef = { current: null }, late = deferred();
  const stale = shareSessionStartupMigration(staleRef, async () => { await late.promise; });
  const replacement = Promise.resolve("replacement"); staleRef.current = replacement;
  late.reject(new Error("old owner failed")); await assert.rejects(stale, /old owner failed/);
  assert.equal(staleRef.current, replacement);
});

test("late startup imports preserve replacements, new chats and deletions", () => {
  const original = { id: 1, messages: ["original"] }, removed = { id: 2 }, unchanged = { id: 3 };
  const changed = { id: 1, messages: ["new ordinary message"] }, added = { id: 4 };
  const current = { w: [changed, unchanged, added], another: [{ id: 5 }] };
  const saved = { ...unchanged, storageRevision: 7 };
  const result = mergeCommittedStartupSessions(current, [
    { workspace: "w", original, saved: { ...original, storageRevision: 8 } },
    { workspace: "w", original: removed, saved: { ...removed, storageRevision: 9 } },
    { workspace: "w", original: unchanged, saved },
  ]);
  assert.deepEqual(result, { w: [changed, saved, added], another: current.another });
  assert.equal(result.w[0], changed); assert.equal(result.w[1], saved);
  assert.deepEqual(current.w, [changed, unchanged, added]);
});
