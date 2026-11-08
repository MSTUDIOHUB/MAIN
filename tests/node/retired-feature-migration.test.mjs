import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const source = fs.readFileSync(new URL("../../src/lib/retiredFeatureMigration.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function("module", "exports", js)(module, module.exports);
const { retireRemovedFeatures, migrateRetiredFeatureSnapshots, cleanLegacySessionFiles } = module.exports;

test("mixed MAIN history removes only exact generation blocks and preserves text/attachments/exports", () => {
  const input = { id: 7, messages: [
    { id: 1, turnId: "arbitrary-admitted-id", type: "user", content: "Draw /image, then explain", images: ["data:user-image"], contextItems: [{ path: ".MAIN-chat-attachments/a.png" }] },
    { id: 2, turnId: "arbitrary-admitted-id", type: "imageGeneration", intent: "respond", imageUrl: "data:generated", outputPath: "/user/exports/keep.png" },
    { id: 3, type: "agent", content: "Your drawing is ready" },
    { id: 4, type: "user", content: "ordinary discussion", images: ["data:ordinary"] },
  ], runtimeSnapshot: { selectedMainModeKey: "main_mode", imageStudio: { config: { outputDirectory: "/user/exports" } },
    taskFlow: [{ id: 2, type: "imageGeneration" }, { id: 4, type: "user", content: "ordinary discussion" }],
    conversationTurns: [{ id: "arbitrary-admitted-id", intent: "respond", blockIds: [1, 2, 3] }] }, unknownMetadata: { path: "/user/exports/keep.png" } };
  const output = retireRemovedFeatures(input);
  assert.deepEqual(output.messages, [input.messages[0], input.messages[2], input.messages[3]]);
  assert.deepEqual(output.runtimeSnapshot.conversationTurns[0].blockIds, [1, 3]);
  assert.deepEqual(output.unknownMetadata, input.unknownMetadata);
  assert.equal("imageStudio" in output.runtimeSnapshot, false);
  assert.deepEqual(input.messages[1].type, "imageGeneration");
  assert.deepEqual(retireRemovedFeatures(output), output);
});

test("Goal archive keeps real terminal outcomes and cancels only unfinished autonomous history", () => {
  const input = { activeGoal: { id: "goal-a", ownerTurnId: "g" }, goalRuntime: { budget: {} },
    conversationTurns: [
      { id: "g", intent: "goal", displayIntent: "goal", status: "paused", userPrompt: "Fix all issues", summary: "One file updated", blockIds: [1] },
      { id: "finished", intent: "goal", status: "done", runtimeOutcome: { resultKind: "success", reason: "verified", runId: "actual" } },
    ], activeActionRequest: { kind: "user_choice", turnId: "g", requestId: "old" }, harnessRunMarker: { runtimeIntent: "goal" },
    messages: [{ type: "tool", toolName: "replace_in_file", toolOutcome: "succeeded", target: "src/file.ts" }] };
  const result = retireRemovedFeatures(input);
  assert.equal(result.conversationTurns[0].status, "done");
  assert.equal(result.conversationTurns[0].runtimeOutcome.resultKind, "canceled");
  assert.equal(result.conversationTurns[0].summary, "One file updated");
  assert.equal(result.conversationTurns[1].runtimeOutcome.runId, "actual");
  assert.equal(result.conversationTurns[1].runtimeOutcome.resultKind, "success");
  assert.equal(result.activeActionRequest, null);
  assert.equal(result.harnessRunMarker, null);
  assert.deepEqual(result.messages, input.messages);
});

test("retired typed FIFO items are removed without interpreting prose or clearing normal controls", () => {
  const ordinary = { instruction: { payload: { text: "Discuss a goal and image_studio", dispatchHints: { resolvedIntent: "plan" } } } };
  const result = retireRemovedFeatures({ workspaceTurnQueue: { version: 9, entries: [ordinary,
    { instruction: { payload: { dispatchHints: { goalCreationAuthorization: { kind: "goal_creation_authorization" } } } } },
    { instruction: { payload: { dispatchHints: { runtimeIntentOverride: "goal" } } } },
  ] }, queuedUserMessage: { text: "continue", goalContinuationAuthorization: { goalId: "old" } }, activeActionRequest: { kind: "plan_review", turnId: "p" } });
  assert.deepEqual(result.workspaceTurnQueue.entries, [ordinary]);
  assert.equal(result.workspaceTurnQueue.version, 9);
  assert.equal(result.queuedUserMessage, null);
  assert.deepEqual(result.activeActionRequest, { kind: "plan_review", turnId: "p" });
});

test("raw ledger Goal checkpoints cannot revive autonomous slices while Execute receipts survive", () => {
  const execute = { events: [{ type: "turn.admitted", strategy: "execute" }, { type: "tool.completed", evidence: "actual" }] };
  const result = retireRemovedFeatures({ runtimeV2Checkpoints: { old: { events: [{ type: "turn.admitted", strategy: "goal" }] }, execute },
    runtimeEvents: [{ type: "goal.state_changed" }, { type: "tool.completed", toolCallId: "actual" }] });
  assert.deepEqual(result.runtimeV2Checkpoints, { execute });
  assert.deepEqual(result.runtimeEvents, [{ type: "tool.completed", toolCallId: "actual" }]);
});

test("all native snapshots commit at their exact revisions before dedicated output cleanup", async () => {
  const trace = [];
  const entries = ["removed-workspace", "global", "legacy-import"].map((workspace, i) => ({ workspace, sessionId: String(i), revision: i + 3, snapshot: { imageStudio: {}, messages: [{ type: "user", content: workspace }] } }));
  const result = await migrateRetiredFeatureSnapshots({ listLegacyFiles: async () => [], compareAndSwapLegacyFile: async () => {}, finalizeLegacyCopy: async () => {}, list: async () => entries,
    compareAndSwap: async input => { trace.push(["cas", input.workspace, input.expectedRevision]); assert.deepEqual(input.snapshot.messages, entries.find(x => x.workspace === input.workspace).snapshot.messages); return { revision: input.expectedRevision + 1, snapshot: input.snapshot }; },
    cleanupOutputs: async () => trace.push(["cleanup"]) });
  assert.deepEqual(trace, [["cas", "removed-workspace", 3], ["cas", "global", 4], ["cas", "legacy-import", 5], ["cleanup"]]);
  assert.deepEqual(result, { scanned: 3, changed: 3 });
});

test("CAS conflict or unresolved legacy owner blocks output deletion and a fresh pass can retry", async () => {
  let cleanup = 0;
  await assert.rejects(migrateRetiredFeatureSnapshots({ listLegacyFiles: async () => [], compareAndSwapLegacyFile: async () => {}, finalizeLegacyCopy: async () => {}, list: async () => [{ workspace: "w", sessionId: "1", revision: 1, snapshot: { imageStudio: {} } }], compareAndSwap: async () => { throw new Error("CAS_CONFLICT"); }, cleanupOutputs: async () => cleanup++ }), /CAS_CONFLICT/);
  await assert.rejects(migrateRetiredFeatureSnapshots({ listLegacyFiles: async () => [], compareAndSwapLegacyFile: async () => {}, finalizeLegacyCopy: async () => {}, list: async () => { throw new Error("LEGACY_SESSION_OWNER_UNRESOLVED"); }, compareAndSwap: async () => {}, cleanupOutputs: async () => cleanup++ }), /OWNER_UNRESOLVED/);
  assert.equal(cleanup, 0);
  assert.deepEqual(await migrateRetiredFeatureSnapshots({ listLegacyFiles: async () => [], compareAndSwapLegacyFile: async () => {}, finalizeLegacyCopy: async () => {}, list: async () => [{ workspace: "w", sessionId: "1", revision: 2, snapshot: { messages: [{ type: "user", content: "retained" }] } }], compareAndSwap: async () => { assert.fail("already migrated snapshot must not be rewritten"); }, cleanupOutputs: async () => cleanup++ }), { scanned: 1, changed: 0 });
  assert.equal(cleanup, 1);
});

test("unfinished Goal closes exact canonical owner once without rewriting committed effects or another Run", () => {
  const original = { conversationTurns: [{ id: "g", intent: "goal", status: "running" }, { id: "p", intent: "execute", status: "running" }],
    runtimeEvents: [{ schemaVersion: 2, type: "run.started", threadId: "w:1", turnId: "g", runId: "goal-run", parentRunId: null, timestampMs: 10 },
      { schemaVersion: 2, type: "item.completed", threadId: "w:1", turnId: "g", item: { content: "committed file write" }, timestampMs: 11 },
      { schemaVersion: 2, type: "run.started", threadId: "w:1", turnId: "p", runId: "plan-child", timestampMs: 12 }] };
  const result = retireRemovedFeatures(original);
  assert.deepEqual(result.runtimeEvents.slice(0, 3), original.runtimeEvents);
  assert.deepEqual(result.runtimeEvents.slice(3).map(x => [x.type, x.turnId, x.resultKind]), [["run.aborted", "g", undefined], ["run.completed", "g", "canceled"], ["turn.completed", "g", "canceled"]]);
  assert.equal(result.conversationTurns[0].runtimeOutcome.runId, "goal-run");
  assert.equal(result.conversationTurns[1].status, "running");
  assert.deepEqual(retireRemovedFeatures(result), result);
});

test("same-named keys inside real tool arguments and unknown user metadata are ordinary evidence", () => {
  const evidence = { goalRuntime: { value: "user application state" }, imageStudio: "user source symbol", intent: "goal", type: "imageGeneration" };
  const input = { unknownMetadata: evidence, agentMessages: [{ role: "assistant", tool_calls: [{ function: { name: "write_file", arguments: evidence } }] }], messages: [{ id: 1, type: "tool", arguments: evidence }] };
  assert.deepEqual(retireRemovedFeatures(input), input);
});

test("legacy physical copies are finalized only at committed native revisions before image cleanup", async () => {
  const trace = [];
  const entry = { workspace: "w", sessionId: "1", revision: 4, snapshot: { id: "1", imageStudio: {}, messages: [{ type: "user", content: "retained" }] } };
  await assert.rejects(migrateRetiredFeatureSnapshots({ listLegacyFiles: async () => [], compareAndSwapLegacyFile: async () => {}, list: async () => [entry],
    compareAndSwap: async input => { trace.push("cas"); return { revision: 5, snapshot: { ...input.snapshot, storageRevision: 5 } }; },
    finalizeLegacyCopy: async input => { trace.push("finalize"); assert.equal(input.expectedRevision, 5); assert.equal(input.expectedSnapshot.storageRevision, 5); throw new Error("LEGACY_COPY_CONFLICT"); },
    cleanupOutputs: async () => trace.push("cleanup") }), /LEGACY_COPY_CONFLICT/);
  assert.deepEqual(trace, ["cas", "finalize"]);
});

test("legacy copies absent from SQLite are cleaned in place without resurrecting deleted chats", async () => {
  const files = [
    { fileName: "session.json", value: { id: "gone", title: "Preserved title", imageStudio: { old: true } } },
    { fileName: "messages.jsonl", value: [{ id: 1, type: "user", content: "ordinary text", images: ["ordinary attachment"] }, { id: 2, type: "imageGeneration", imageUrl: "old-base64" }] },
    { fileName: "turns.jsonl", value: [{ id: "t", intent: "goal", status: "paused", blockIds: [1, 2], userPrompt: "ordinary objective" }] },
    { fileName: "runtime.json", value: { activeGoal: { ownerTurnId: "t" }, custom: { goalRuntime: "user data" }, conversationTurns: [] } },
  ].map(file => ({ ...file, workspace: "old", sessionId: "gone", contentHash: `exact-${file.fileName}` }));
  const changed = cleanLegacySessionFiles(files);
  assert.equal(changed.length, 4);
  const transcript = changed.find(file => file.fileName === "messages.jsonl").value;
  assert.deepEqual(transcript, [files[1].value[0]]);
  const turns = changed.find(file => file.fileName === "turns.jsonl").value;
  assert.deepEqual(turns[0].blockIds, [1]);
  assert.equal(turns[0].runtimeOutcome.resultKind, "canceled");
  assert.deepEqual(changed.find(file => file.fileName === "runtime.json").value.custom, files[3].value.custom);
  const writes = [];
  await migrateRetiredFeatureSnapshots({ list: async () => [], compareAndSwap: async () => assert.fail("must not insert a deleted chat"),
    listLegacyFiles: async () => files, compareAndSwapLegacyFile: async input => writes.push(input), finalizeLegacyCopy: async () => assert.fail("no SQL owner to finalize"), cleanupOutputs: async () => writes.push("cleanup") });
  assert.equal(writes.length, 5);
  assert.equal(writes[0].expectedHash, "exact-session.json");
  assert.equal(writes[4], "cleanup");
});

test("legacy hash conflicts prevent both copy finalization and image-output cleanup", async () => {
  let later = 0;
  await assert.rejects(migrateRetiredFeatureSnapshots({ list: async () => [], compareAndSwap: async () => assert.fail(),
    listLegacyFiles: async () => [{ workspace: "w", sessionId: "s", fileName: "runtime.json", contentHash: "captured", value: { imageStudio: {} } }],
    compareAndSwapLegacyFile: async () => { throw new Error("LEGACY_SESSION_CONTENT_CONFLICT"); }, finalizeLegacyCopy: async () => later++, cleanupOutputs: async () => later++ }), /CONTENT_CONFLICT/);
  assert.equal(later, 0);
});

test("legacy Goal ownership without an intent tag or Run receipt is archived without fabricated execution", () => {
  const input = { activeGoal: { ownerTurnId: "legacy" }, conversationTurns: [{ id: "legacy", mode: "edit", status: "paused", userPrompt: "Retain this request" }] };
  const result = retireRemovedFeatures(input);
  assert.equal(result.conversationTurns[0].status, "done");
  assert.equal(result.conversationTurns[0].runtimeOutcome.resultKind, "canceled");
  assert.equal(result.conversationTurns[0].userPrompt, "Retain this request");
  assert.deepEqual(result.runtimeEvents, []);
  assert.equal(result.conversationTurns[0].runtimeOutcome.runId, undefined);
  assert.deepEqual(retireRemovedFeatures(result), result);
});
