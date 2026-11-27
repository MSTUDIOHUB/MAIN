import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const secret = "SYNTHETIC-unity-editor-token.123456";
const compilerLine = "Assets/Probe.cs(3,7): error CS1002: ; expected";
const stdout = `/Unity -accessToken ${secret} -projectPath /fixture\n${compilerLine}`;

const load = createTsModuleLoader({
  "@tauri-apps/api/core": { invoke: async (name, input) => {
    assert.equal(name, "run_command");
    assert.equal(input.command, "ps aux");
    return { command: input.command, stdout, stderr: `--ACCESS_TOKEN=\"${secret}\"`, exitCode: 1 };
  } },
  "@tauri-apps/api/event": {},
});
const { redactTerminalCredentials } = load("src/lib/terminalCredentials.ts");
const { planSessionTerminalCredentialCleanup, createTerminalCredentialProjection, projectTerminalCredentialModelMessages } = load("src/lib/terminalCredentialHistory.ts");
const { migrateRetiredFeatureSnapshots } = load("src/lib/retiredFeatureMigration.ts");
const runtime = load("src/lib/runtime-v2/index.ts");

function savedCheckpoint(terminal) {
  const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: "run", parentRunId: null, attemptId: "attempt" };
  let aggregate = null;
  let sequence = 0;
  const append = (type, body) => {
    aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      type, sequence, eventId: `event-${sequence}`, at: ++sequence, run, ...body });
  };
  append("turn.admitted", { turn, strategy: "plan", objective: "Read the Console", acceptanceCriteria: [], constraints: [] });
  append("run.started", { phase: "planning" });
  append("command.scheduled", { command: { kind: "execute_tool", run, phase: "planning", idempotencyKey: "shell", payload: { toolName: "run_command", toolCallId: "shell-call", arguments: { command: "ps aux" } } } });
  append("tool.completed", { idempotencyKey: "shell", status: "succeeded", evidence: [], modelContent: JSON.stringify({ stdout }),
    presentation: { toolName: "run_command", target: "ps aux", message: stdout } });
  if (terminal) {
    append("run.aborted", { reason: "user_cancelled" });
    const outcome = { resultKind: "canceled", reason: "user_cancelled", completedAt: sequence + 1, finalProjectionId: "final" };
    append("run.completed", { outcome });
    append("projection.published", { audience: "final", projectionId: "final", projection: { id: "final", audience: "final", kind: "final", dedupeKey: "final", markdown: `Echo ${secret}` } });
    append("turn.completed", { turn, runId: run.runId, outcome });
  } else {
    append("command.scheduled", { command: { kind: "execute_tool", run, phase: "planning", idempotencyKey: "pending-shell",
      payload: { toolName: "run_command", toolCallId: "pending-call", arguments: { command: `echo ${secret}` } } } });
  }
  return runtime.serializeRuntimeV2CheckpointMap({ turn: runtime.createRuntimeV2Checkpoint({ aggregate, revision: 5, updatedAt: aggregate.updatedAt }) }).turn;
}

test("terminal flags are redacted before JS tool consumers, while compiler evidence survives", async () => {
  const { runCommand } = load("src/lib/ipc.ts");
  const output = await runCommand("ps aux");
  assert.deepEqual(output, { command: "ps aux", stdout: `/Unity -accessToken [REDACTED] -projectPath /fixture\n${compilerLine}`,
    stderr: `--ACCESS_TOKEN="[REDACTED]"`, exitCode: 1 });
  const views = [String.raw`{"stdout":"-accessToken \"${secret}\"\nnext line"}`, `-access\x1b[32mToken ${secret}`, `-access-token='${secret}'`];
  for (const raw of views) {
    const clean = redactTerminalCredentials(raw);
    assert.equal(clean.includes(secret), false);
    assert.match(clean, /\[REDACTED\]/);
    assert.equal(redactTerminalCredentials(clean), clean);
  }
});

test("sealed history uses exact storage CAS and replays with its new digest", async () => {
  const before = savedCheckpoint(true);
  const messages = [{ type: "agent", content: `Echo ${secret}` }, { type: "user", content: "Original user request" }];
  const original = { id: "s1", messages, runtimeSnapshot: { runtimeV2Checkpoints: { turn: before } } };
  const ordinary = { id: "s2", messages: [{ type: "user", content: `How to use -accessToken ${secret} in docs?` }] };
  let committed;
  const result = await migrateRetiredFeatureSnapshots({
    list: async () => [
      { workspace: "/fixture", sessionId: "s1", revision: 12, snapshot: original },
      { workspace: "/fixture", sessionId: "s2", revision: 44, snapshot: ordinary },
    ],
    compareAndSwap: async input => {
      assert.equal(input.sessionId, "s1");
      assert.equal(input.expectedRevision, 12);
      committed = input.snapshot;
      return { revision: 13, snapshot: committed };
    },
    finalizeLegacyCopy: async input => { assert.equal(input.expectedRevision, input.sessionId === "s1" ? 13 : 44); },
    listLegacyFiles: async () => [], compareAndSwapLegacyFile: async () => assert.fail("no legacy files"),
    cleanupOutputs: async () => {}, planTerminalCredentialCleanup: planSessionTerminalCredentialCleanup,
  });
  assert.deepEqual(result, { scanned: 2, changed: 1 });
  assert.ok(!JSON.stringify(committed).includes(secret));
  assert.equal(committed.messages[1].content, messages[1].content);
  const checkpoint = committed.runtimeSnapshot.runtimeV2Checkpoints.turn;
  assert.notEqual(checkpoint.aggregateDigest, before.aggregateDigest);
  assert.deepEqual(checkpoint.events.map(event => event.eventId), before.events.map(event => event.eventId));
  assert.deepEqual(checkpoint.events[2], before.events[2]);
  assert.ok(checkpoint.events[3].modelContent.includes(compilerLine));
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(checkpoint)));
  assert.equal(restored?.aggregate.terminalOutcome?.resultKind, "canceled");
  assert.equal(restored?.aggregate.terminalOutcome?.reason, "user_cancelled");
  const repeated = planSessionTerminalCredentialCleanup(committed);
  assert.equal(repeated.disposition, "unchanged");
  assert.strictEqual(repeated.snapshot, committed);
});

test("affected resumable and invalid owners keep original CAS while another owner's history is redacted", async () => {
  const activeCheckpoint = savedCheckpoint(false);
  const active = { id: "active", imageStudio: {}, messages: [{ type: "agent", content: `Echo ${secret}` }],
    runtimeSnapshot: { runtimeV2Checkpoints: { turn: activeCheckpoint } } };
  assert.deepEqual(planSessionTerminalCredentialCleanup(active), { disposition: "deferred", reason: "resumable_checkpoint" });
  const bad = { id: "bad", runtimeSnapshot: { runtimeV2Checkpoints: { turn: { ...savedCheckpoint(true), aggregateDigest: "wrong" } } } };
  assert.deepEqual(planSessionTerminalCredentialCleanup(bad), { disposition: "deferred", reason: "invalid_checkpoint" });
  const terminal = { id: "terminal", runtimeSnapshot: { runtimeV2Checkpoints: { turn: savedCheckpoint(true) } } };
  const savedRows = [active, bad, terminal].map((snapshot, i) => ({ workspace: "/fixture", sessionId: snapshot.id, revision: 8 + i, snapshot }));
  const activeBytes = JSON.stringify(active);
  const copies = [{ workspace: "/fixture", sessionId: "active", fileName: "messages.jsonl", contentHash: "original",
    value: [{ type: "tool", toolName: "run_command", message: stdout }] }];
  const writes = [];
  const result = await migrateRetiredFeatureSnapshots({
    list: async () => savedRows, listLegacyFiles: async () => copies,
    compareAndSwap: async input => {
      writes.push([input.sessionId, input.expectedRevision]);
      assert.ok(!JSON.stringify(input.snapshot).includes(secret));
      return { snapshot: input.snapshot, revision: input.expectedRevision + 1 };
    },
    compareAndSwapLegacyFile: async () => assert.fail("deferred owner retains each original file"),
    finalizeLegacyCopy: async input => writes.push([input.sessionId, input.expectedRevision]),
    cleanupOutputs: async () => assert.fail("deferred owner retains its legacy artifacts"),
    planTerminalCredentialCleanup: planSessionTerminalCredentialCleanup,
  });
  assert.deepEqual(result, { scanned: 3, changed: 1, deferred: 2 });
  assert.deepEqual(writes, [["terminal", 10], ["terminal", 11]]);
  assert.equal(JSON.stringify(active), activeBytes);
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(activeCheckpoint)));
  assert.equal(restored.aggregate.scheduledCommands.find(command => command.idempotencyKey === "pending-shell").payload.arguments.command, `echo ${secret}`);
  const project = createTerminalCredentialProjection(active);
  assert.deepEqual(project(active.messages), [{ type: "agent", content: "Echo [REDACTED]" }]);
  const { extractExactReadFileWindow, formatReadFileWindowPayloadForModel } = load("src/lib/readFileWindow.ts");
  const exact = formatReadFileWindowPayloadForModel("Assets/Probe.cs", {
    content: secret, startLine: 1, endLine: 1, totalLines: 1, totalChars: secret.length,
    truncated: false, contentVersion: "old-source-version",
  });
  assert.ok(extractExactReadFileWindow(exact));
  const modelHistory = projectTerminalCredentialModelMessages([
    { role: "tool", content: stdout }, { role: "assistant", content: `Echo ${secret}` }, { role: "tool", content: exact },
  ], project);
  assert.ok(!JSON.stringify(modelHistory).includes(secret));
  assert.ok(modelHistory[0].content.includes(compilerLine));
  assert.equal(extractExactReadFileWindow(modelHistory[2].content), null);
});

test("legacy transcript copies redact exact echoes only within their own session", async () => {
  const fixture = (sessionId, fileName, value) => ({ workspace: "/fixture", sessionId, fileName, value, contentHash: `${sessionId}-${fileName}` });
  const files = [fixture("s1", "messages.jsonl", [{ type: "tool", toolName: "run_command", message: stdout }]),
    fixture("s1", "turns.jsonl", [{ id: "t", summary: `Echo ${secret}` }]),
    fixture("s2", "turns.jsonl", [{ id: "unrelated", summary: `Public example ${secret}` }])];
  const rewritten = [];
  await migrateRetiredFeatureSnapshots({
    list: async () => [], compareAndSwap: async () => assert.fail(), finalizeLegacyCopy: async () => assert.fail(),
    listLegacyFiles: async () => files,
    compareAndSwapLegacyFile: async input => { rewritten.push(input); },
    cleanupOutputs: async () => {}, planTerminalCredentialCleanup: planSessionTerminalCredentialCleanup,
  });
  assert.deepEqual(rewritten.map(({ sessionId, expectedHash }) => [sessionId, expectedHash]), [["s1", "s1-messages.jsonl"], ["s1", "s1-turns.jsonl"]]);
  assert.ok(!JSON.stringify(rewritten).includes(secret));
});
