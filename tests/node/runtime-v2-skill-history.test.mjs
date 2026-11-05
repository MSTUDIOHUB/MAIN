import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const root = process.cwd();
const cache = new Map();
function loadTs(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} };
  cache.set(file, module.exports);
  const require = createRequire(file);
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file,
  }).outputText;
  new Function("exports", "module", "require", output)(module.exports, module, (name) => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(file), name);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return loadTs(candidate);
      }
    }
    return require(name);
  });
  return module.exports;
}
const runtime = loadTs(path.join(root, "src/lib/runtime-v2/index.ts"));
const { createRuntimeV2LiveExecutionState } = loadTs(path.join(root, "src/store/runtimeV2/executionTypes.ts"));
const { createRuntimeV2ToolPort } = loadTs(path.join(root, "src/store/runtimeV2/executionToolPort.ts"));
const history = () => loadTs(path.join(root, "src/store/runtimeV2/executionSkillHistory.ts"));
const decision = loadTs(path.join(root, "src/store/runtimeV2/executionProviderDecisionView.ts"));
const transcript = loadTs(path.join(root, "src/store/runtimeV2/executionProviderSkillTranscript.ts"));
const { providerHistory } = loadTs(path.join(root, "src/store/runtimeV2/executionProviderHistory.ts"));

function fixture() {
  const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" };
  const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
  const body = "# Workflow\r\n## Bulk\r\n" + "Use the bulk builder, preserving permissions.🙂\r\n".repeat(190);
  const catalog = { entries: [{ id: "panel:workflow", name: "workflow", description: "Build guidance", content: body, source: "panel", version: "cafe1234", entryPath: null, basePath: null, supportingFiles: [], allowImplicitInvocation: true }], explicitSkillIds: [], warnings: [], loadedAt: 1 };
  const live = createRuntimeV2LiveExecutionState();
  const state = { config: {}, conversationTurns: [{ id: "turn", userPrompt: "Implement the requested artifact." }] };
  const ports = { get: () => state, live, context: { turnId: "turn", runWorkspace: "/fixture", runSessionKey: "session", runtimeRunIntent: "execute", phaseLanguage: "en", skillCatalog: catalog, runtimeContextBudget: { contextLimit: 32000, readWindowChars: 20000, inputBudget: 24000 } }, nextId: (scope) => `${scope}-fixture`, now: () => 10, logStoreEvent() {} };
  const call = { id: "skill-call", name: "load_skill", arguments: { skill_id: "panel:workflow", section: "L2", max_chars: 14000 } };
  const command = { idempotencyKey: "skill-command", kind: "execute_tool", phase: "observing", run, payload: { toolName: call.name, toolCallId: call.id, arguments: call.arguments } };
  live.messages.push({ role: "assistant", content: "Read the relevant workflow.", tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
  return { turn, run, body, catalog, ports, live, call, command };
}
function canonical(f, receipt) {
  let sequence = 0;
  const event = (type, fields) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: `e${sequence}`, sequence: sequence++, at: sequence, type, ...fields });
  let aggregate = runtime.transition(null, event("turn.admitted", { turn: f.turn, strategy: "execute", objective: "Implement the requested artifact.", constraints: [], acceptanceCriteria: ["Requested artifact exists."] }));
  const add = (type, fields) => { aggregate = runtime.transition(aggregate, event(type, fields)); };
  add("run.started", { run: f.run, phase: "observing" });
  const providerCommand = { ...f.command, kind: "request_model", idempotencyKey: "provider", payload: { mode: "execute" } };
  add("command.scheduled", { run: f.run, command: providerCommand });
  add("provider.responded", { run: f.run, idempotencyKey: "provider", result: { visibleText: "Read the relevant workflow.", toolCalls: [f.call], diagnostics: [] } });
  add("command.scheduled", { run: f.run, command: f.command });
  if (receipt) add("tool.completed", receipt);
  return { aggregate, add, snapshot: () => aggregate };
}
function coldCheckpoint(aggregate) {
  const checkpoint = runtime.createRuntimeV2Checkpoint({ revision: aggregate.nextSequence, aggregate, updatedAt: aggregate.updatedAt });
  const persisted = JSON.parse(JSON.stringify(runtime.serializeRuntimeV2CheckpointMap({ [aggregate.turn.turnId]: checkpoint })));
  return runtime.normalizeRuntimeV2Checkpoint(persisted[aggregate.turn.turnId], aggregate.turn).aggregate;
}

test("real Execute Skill ToolPort persists exact bounded guidance beyond the UI prefix", async () => {
  const f = fixture();
  const receipt = await createRuntimeV2ToolPort(f.ports).execute({ command: f.command, signal: new AbortController().signal });
  assert.equal(receipt.status, "succeeded");
  const sent = f.live.messages.find((m) => m.tool_call_id === f.call.id).content;
  assert.ok(sent.length > 4000);
  assert.equal(receipt.modelContent, sent, "Execute must persist what the provider read, not the bounded UI presentation");
  assert.notEqual(receipt.presentation.message, sent);
  assert.equal(receipt.evidence.some((e) => ["source", "mutation"].includes(e.kind)), false);
});

test("Skill-only JSON checkpoint restore preserves exact pairs through pressure without granting source authority", async () => {
  const f = fixture();
  const receipt = await createRuntimeV2ToolPort(f.ports).execute({ command: f.command, signal: new AbortController().signal });
  const aggregate = coldCheckpoint(canonical(f, receipt).aggregate);
  const live = createRuntimeV2LiveExecutionState();
  history().restoreRuntimeV2SkillHistory(live, aggregate, f.run);
  assert.equal(live.messages.length, 2);
  assert.equal(live.messages[1].content, receipt.modelContent);
  assert.equal(JSON.parse(live.messages[1].content).content, "## Bulk\r\n" + f.body.split("## Bulk\r\n")[1]);
  const copy = JSON.stringify(live.messages);
  history().restoreRuntimeV2SkillHistory(live, aggregate, f.run);
  assert.equal(JSON.stringify(live.messages), copy, "restoration is idempotent at the same canonical call identity");
  assert.deepEqual(live.latestProviderRequestSourceCoverage, []);
  assert.equal(live.authorization, null);
  assert.equal(live.permissionRejection, null);
  assert.equal(live.evidenceCounter, 0);
  const messages = providerHistory(live, { ...f.ports, live }).messages;
  const noisy = [...messages, { role: "assistant", content: "", tool_calls: [{ id: "old-query", type: "function", function: { name: "run_command", arguments: '{"command":"inspect"}' } }] }, { role: "tool", tool_call_id: "old-query", content: "old query ".repeat(14000) }, { role: "assistant", content: "", tool_calls: [{ id: "latest-query", type: "function", function: { name: "run_command", arguments: '{"command":"status"}' } }] }, { role: "tool", tool_call_id: "latest-query", content: "ready" }];
  const bounded = decision.boundRuntimeV2ProviderConversation(noisy, { contextLimit: 32000, reservedOutputTokens: 4096, inputBudget: 12000 });
  assert.equal(bounded.find((m) => m.tool_call_id === f.call.id)?.content, receipt.modelContent);
  assert.equal(transcript.runtimeV2TranscriptSkillGuidanceWindows(bounded).length, 1);
});

test("legacy prefixes, errors, different owners and terminal Runs cannot become recovered guidance", async () => {
  const f = fixture();
  const receipt = await createRuntimeV2ToolPort(f.ports).execute({ command: f.command, signal: new AbortController().signal });
  const aggregate = coldCheckpoint(canonical(f, receipt).aggregate);
  const restore = (candidate, run = f.run) => {
    const live = createRuntimeV2LiveExecutionState();
    history().restoreRuntimeV2SkillHistory(live, candidate, run);
    return live;
  };
  assert.deepEqual(restore(aggregate, { ...f.run, sessionEpoch: "replaced" }).messages, []);
  assert.deepEqual(restore(aggregate, { ...f.run, runId: "other-run" }).messages, []);
  assert.deepEqual(restore({ ...aggregate, terminalOutcome: { resultKind: "canceled" } }).messages, []);
  assert.deepEqual(restore({ ...aggregate, events: [...aggregate.events, { type: "run.aborted", run: f.run }] }).messages, []);
  for (const rewrite of [
    (e) => { const { modelContent, ...legacy } = e; return legacy; },
    (e) => ({ ...e, status: "failed" }),
    (e) => ({ ...e, modelContent: e.presentation.message }),
    (e) => ({ ...e, run: { ...e.run, attemptId: "other-attempt" } }),
  ]) {
    assert.deepEqual(restore({ ...aggregate, events: aggregate.events.map((e) => e.type === "tool.completed" ? rewrite(e) : e) }).messages, []);
  }
  const differentArgs = { ...aggregate, events: aggregate.events.map((e) => e.type === "command.scheduled" && e.command.kind === "execute_tool"
    ? { ...e, command: { ...e.command, payload: { ...e.command.payload, arguments: { skill_id: "unrelated" } } } } : e) };
  assert.deepEqual(restore(differentArgs).messages, [], "same call id cannot stand for different scheduled arguments");
  const reorderedArgs = { ...aggregate, events: aggregate.events.map((e) => e.type === "command.scheduled" && e.command.kind === "execute_tool"
    ? { ...e, command: { ...e.command, payload: { ...e.command.payload, arguments: Object.fromEntries(Object.entries(e.command.payload.arguments).reverse()) } } } : e) };
  assert.equal(restore(reorderedArgs).messages.length, 2, "the existing production identity accepts equivalent normalized object key order");
});

test("a cold pending Skill restores only its exact scheduled parent before the real ToolPort settles it", async () => {
  const f = fixture();
  const aggregate = coldCheckpoint(canonical(f).aggregate);
  const live = createRuntimeV2LiveExecutionState();
  history().restoreRuntimeV2SkillHistory(live, aggregate, f.run);
  assert.equal(live.messages.length, 1, "the admitted pending Skill needs its canonical parent, without invented output");
  assert.deepEqual(live.messages[0].tool_calls.map((call) => call.id), [f.call.id]);
  assert.deepEqual(transcript.runtimeV2TranscriptSkillGuidanceWindows(live.messages), [], "an unfinished read contains no guidance");
  const receipt = await createRuntimeV2ToolPort({ ...f.ports, live }).execute({ command: aggregate.scheduledCommands[0], signal: new AbortController().signal });
  assert.equal(receipt.status, "succeeded");
  assert.ok(receipt.modelContent.length > 4000);
  assert.equal(receipt.modelContent, live.messages[1].content);
  assert.equal(JSON.parse(receipt.modelContent).content, f.body.slice(f.body.indexOf("## Bulk")));
  const request = providerHistory(live, { ...f.ports, live }).messages;
  const calls = request.flatMap((m) => m.tool_calls?.map((call) => call.id) || []);
  const results = request.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(calls, results, "the next provider input is a complete original-id pair");
  assert.equal(transcript.runtimeV2TranscriptSkillGuidanceWindows(request).length, 1);
  const noSchedule = createRuntimeV2LiveExecutionState();
  history().restoreRuntimeV2SkillHistory(noSchedule, { ...aggregate, scheduledCommands: [] }, f.run);
  assert.deepEqual(noSchedule.messages, [], "an old proposal without the current command is never replayed");
});

test("a cold successful index-only newer document revision invalidates older guidance without inventing new bytes", async () => {
  const f = fixture();
  const first = await createRuntimeV2ToolPort(f.ports).execute({ command: f.command, signal: new AbortController().signal });
  const ledger = canonical(f, first);
  const call = { id: "index-call", name: "load_skill", arguments: { skill_id: "panel:workflow", section_cursor: "feedface:0", max_chars: 200 } };
  const command = { ...f.command, idempotencyKey: "index-command", payload: { toolName: call.name, toolCallId: call.id, arguments: call.arguments } };
  f.ports.context.skillCatalog = { ...f.catalog, entries: [{ ...f.catalog.entries[0], version: "feedface" }] };
  f.live.messages.push({ role: "assistant", content: "Inspect the current document index.", tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
  const second = await createRuntimeV2ToolPort(f.ports).execute({ command, signal: new AbortController().signal });
  assert.equal(second.status, "succeeded");
  assert.equal(JSON.parse(second.modelContent).content, "");
  ledger.add("command.scheduled", { run: f.run, command: { ...command, kind: "request_model", idempotencyKey: "index-provider", payload: { mode: "execute" } } });
  ledger.add("provider.responded", { run: f.run, idempotencyKey: "index-provider", result: { visibleText: "Inspect the current document index.", toolCalls: [call], diagnostics: [] } });
  ledger.add("command.scheduled", { run: f.run, command });
  ledger.add("tool.completed", second);
  const aggregate = coldCheckpoint(ledger.snapshot());
  const live = createRuntimeV2LiveExecutionState();
  history().restoreRuntimeV2SkillHistory(live, aggregate, f.run);
  assert.equal(live.messages.length, 4, "preserve both original canonical document revisions");
  assert.deepEqual(live.messages.filter((m) => m.role === "tool").map((m) => m.content), [first.modelContent, second.modelContent]);
  assert.deepEqual(transcript.activeRuntimeV2SkillGuidanceWindows(live.messages), [], "an empty newer read is revision evidence, never older instruction visibility");
});
