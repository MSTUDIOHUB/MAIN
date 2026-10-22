import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const root = process.cwd();
const cache = new Map();
const sideEffects = [];
function loadTs(file) {
  const source = path.resolve(file);
  if (source === path.join(root, "src/lib/toolExecutor.ts")) return {
    executeTool: async (...args) => { sideEffects.push(args); return "unexpected execution"; },
  };
  if (source === path.join(root, "src/lib/ipc.ts")) return {
    shellPermissionPreflight: async (...args) => { sideEffects.push(args); throw new Error("unexpected approval preflight"); },
  };
  if (cache.has(source)) return cache.get(source);
  const module = { exports: {} };
  cache.set(source, module.exports);
  const output = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: source,
  }).outputText;
  const require = createRequire(source);
  new Function("exports", "module", "require", output)(module.exports, module, (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(source), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return loadTs(candidate);
      }
    }
    return require(specifier);
  });
  return module.exports;
}

const surface = loadTs("src/store/runtimeV2/providerToolSurface.ts");
const runtime = loadTs("src/lib/runtime-v2/index.ts");
const { createRuntimeV2ToolPort } = loadTs("src/store/runtimeV2/executionToolPort.ts");
const { createRuntimeV2LiveExecutionState } = loadTs("src/store/runtimeV2/executionTypes.ts");
const { deriveRuntimeV2ProviderEffectFacts } = loadTs("src/store/runtimeV2/executionProviderEffectFacts.ts");

const shellCalls = () => ["tool --version", "tool status", "tool inspect", "tool check"].map((command, index) => ({
  id: `shell-${index}`, name: "run_command", arguments: { command },
}));

function ledger(calls = shellCalls()) {
  const turn = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch", turnId: "turn", clientSubmissionId: "submission" };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: "run", parentRunId: null, attemptId: "attempt" };
  let sequence = 0;
  const event = (type, fields) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: sequence++, eventId: `event-${sequence}`, at: sequence, type, ...fields });
  let aggregate = runtime.transition(null, event("turn.admitted", { turn, strategy: "execute", objective: "Run the requested command checks", constraints: [], acceptanceCriteria: [] }));
  aggregate = runtime.transition(aggregate, event("run.started", { run, phase: "observing" }));
  const provider = { kind: "request_model", phase: "observing", run, idempotencyKey: "provider", payload: { mode: "execute" } };
  aggregate = runtime.transition(aggregate, event("command.scheduled", { run, command: provider }));
  aggregate = runtime.transition(aggregate, event("provider.responded", { run, idempotencyKey: provider.idempotencyKey, result: { visibleText: "", toolCalls: calls, diagnostics: [] } }));
  return {
    run, turn, event,
    get aggregate() { return aggregate; },
    apply(type, fields) { aggregate = runtime.transition(aggregate, event(type, fields)); return aggregate; },
  };
}

test("a homogeneous shell decision retains every novel command for sequential Runtime fences", () => {
  const calls = shellCalls();
  const batch = surface.boundRuntimeV2ProviderToolCalls(calls);
  assert.deepEqual(batch.accepted, calls);
  assert.deepEqual(batch.discarded, []);
  assert.equal(batch.selection, "sequential_shell_batch");
});

test("shell batching does not widen mixed file mutation or observation decisions", () => {
  for (const name of ["read_file", "replace_in_file", "spawn_subagent"]) {
    const calls = [shellCalls()[0], { id: "other", name, arguments: {} }];
    const batch = surface.boundRuntimeV2ProviderToolCalls(calls);
    assert.deepEqual(batch.accepted, [calls[0]]);
    assert.deepEqual(batch.discarded, [calls[1]]);
  }
});

test("shell batches filter completed, rejected and duplicate effects without replaying them", () => {
  const calls = shellCalls();
  const batch = surface.boundRuntimeV2ProviderToolCalls(
    [...calls, { ...calls[2], id: "same-effect" }],
    new Set([surface.runtimeV2ProviderToolCallIdentity(calls[0])]),
    new Set([surface.runtimeV2ProviderToolCallIdentity(calls[1])]),
  );
  assert.deepEqual(batch.accepted, [calls[2], calls[3]]);
});

test("the reducer schedules all retained shell commands one at a time with individual receipts", () => {
  const calls = shellCalls();
  const f = ledger(calls);
  for (const call of calls) {
    const [command] = runtime.decideNextCommands(f.aggregate);
    assert.equal(command.kind, "execute_tool");
    assert.equal(command.payload.toolCallId, call.id);
    f.apply("command.scheduled", { run: f.run, command });
    assert.deepEqual(runtime.decideNextCommands(f.aggregate), [], "another effect cannot start before the scheduled command settles");
    f.apply("tool.completed", { run: f.run, idempotencyKey: command.idempotencyKey, status: "succeeded", evidence: [] });
  }
  assert.deepEqual(f.aggregate.pendingToolCalls, []);
  assert.equal(f.aggregate.events.filter((event) => event.type === "tool.completed").length, 4);
});

test("canceling a queued shell batch stops before any remaining command is scheduled", async () => {
  const f = ledger();
  const abort = new AbortController();
  abort.abort();
  const invoked = [];
  let id = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: { append: async ({ expectedRevision }) => ({ disposition: "committed", checkpoint: { revision: expectedRevision + 1 } }) },
    provider: { request: async () => { invoked.push("provider"); throw new Error("Canceled batch requested inference"); } },
    tool: { execute: async () => { invoked.push("tool"); throw new Error("Canceled batch ran a command"); } },
    scheduler: { execute: async () => { invoked.push("scheduler"); throw new Error("Canceled batch scheduled work"); } },
    projection: { publish: async () => {} },
    clockId: { now: () => 100, nextId: (scope) => `${scope}-${++id}` },
  }, { aggregate: f.aggregate, revision: 1 }, { abortSignal: abort.signal });
  assert.equal(await controller.driveOnce(), false);
  assert.deepEqual(invoked, []);
  const after = controller.snapshot().aggregate;
  assert.equal(after.terminalOutcome.resultKind, "canceled");
  assert.equal(after.events.filter((event) => event.type === "command.scheduled" && event.command.kind === "execute_tool").length, 0);
});

test("a control-plane completion without an actual tool receipt cannot release the next shell command", async () => {
  sideEffects.length = 0;
  const f = ledger();
  const [first] = runtime.decideNextCommands(f.aggregate);
  f.apply("command.scheduled", { run: f.run, command: first });
  f.apply("command.completed", { run: f.run, idempotencyKey: first.idempotencyKey, status: "succeeded" });
  const [command] = runtime.decideNextCommands(f.aggregate);
  f.apply("command.scheduled", { run: f.run, command });
  const live = createRuntimeV2LiveExecutionState();
  live.messages.push({ role: "assistant", content: "", tool_calls: shellCalls().map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
  const port = createRuntimeV2ToolPort({
    get: () => ({ runtimeV2Checkpoints: { turn: runtime.createRuntimeV2Checkpoint({ revision: f.aggregate.nextSequence, aggregate: f.aggregate, updatedAt: f.aggregate.updatedAt }) } }),
    context: { turnId: "turn", runtimeRunIntent: "execute", runWorkspace: "/fixture", runSessionKey: "/fixture:1", phaseLanguage: "en" },
    live, nextId: (scope) => `${scope}-1`, now: () => 100, logStoreEvent() {},
  });
  const receipt = await port.execute({ run: f.run, command, signal: new AbortController().signal });
  assert.equal(receipt.type, "tool.completed");
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.failureReasonCode, "provider_batch_predecessor_unsettled");
  assert.deepEqual(sideEffects, []);
});

for (const status of ["failed", "blocked"]) {
  test(`a ${status} predecessor closes the remaining shell pairs without approvals or execution`, async () => {
    sideEffects.length = 0;
    const calls = shellCalls();
    const f = ledger(calls);
    const [first] = runtime.decideNextCommands(f.aggregate);
    f.apply("command.scheduled", { run: f.run, command: first });
    f.apply("tool.completed", { run: f.run, idempotencyKey: first.idempotencyKey, status, failureKind: "execution_failed", evidence: [] });
    const live = createRuntimeV2LiveExecutionState();
    live.messages.push({ role: "assistant", content: "", tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
    const port = createRuntimeV2ToolPort({
      get: () => ({ config: {}, currentTurnExecutionConsent: { turnId: "turn", granted: true }, runtimeV2Checkpoints: { turn: runtime.createRuntimeV2Checkpoint({ revision: f.aggregate.nextSequence, aggregate: f.aggregate, updatedAt: f.aggregate.updatedAt }) } }),
      context: { turnId: "turn", runtimeRunIntent: "execute", runWorkspace: "/fixture", runSessionKey: "/fixture:1", phaseLanguage: "en" },
      live, nextId: (scope) => `${scope}-${f.aggregate.nextSequence}`, now: () => 100, logStoreEvent() {},
    });
    for (const call of calls.slice(1)) {
      const [command] = runtime.decideNextCommands(f.aggregate);
      f.apply("command.scheduled", { run: f.run, command });
      const receipt = await port.execute({ run: f.run, command, signal: new AbortController().signal });
      assert.equal(receipt.type, "tool.completed");
      assert.equal(receipt.status, "blocked");
      assert.equal(receipt.failureReasonCode, "provider_batch_predecessor_failed");
      assert.deepEqual(receipt.evidence, []);
      assert.match(String(live.messages.at(-1)?.content), /not executed/i);
      assert.equal(live.messages.at(-1)?.tool_call_id, call.id);
      const { type, ...fields } = receipt;
      f.apply(type, fields);
    }
    assert.deepEqual(sideEffects, [], "skipped calls must not cross authorization, IPC or shell boundaries");
    assert.deepEqual(f.aggregate.pendingToolCalls, []);
    const effects = deriveRuntimeV2ProviderEffectFacts(f.aggregate);
    const attempted = surface.completedRuntimeV2ProviderToolCallIdentities(live.messages, effects);
    for (const call of calls.slice(1)) {
      assert.ok(effects.unexecutedToolCallIds.has(call.id));
      assert.ok(!attempted.has(surface.runtimeV2ProviderToolCallIdentity(call)), "a skipped command remains eligible for a fresh provider decision");
    }
  });
}

test("a skipped validator creates no validation evidence or failed-validator frontier", async () => {
  sideEffects.length = 0;
  const calls = [shellCalls()[0], { id: "validator", name: "run_command", arguments: { command: "npm test" } }];
  const f = ledger(calls);
  const [first] = runtime.decideNextCommands(f.aggregate);
  f.apply("command.scheduled", { run: f.run, command: first });
  f.apply("tool.completed", { run: f.run, idempotencyKey: first.idempotencyKey, status: "failed", failureKind: "execution_failed", evidence: [] });
  const live = createRuntimeV2LiveExecutionState();
  live.messages.push({ role: "assistant", content: "", tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
  const [command] = runtime.decideNextCommands(f.aggregate);
  assert.equal(command.kind, "execute_validation");
  f.apply("command.scheduled", { run: f.run, command });
  const port = createRuntimeV2ToolPort({
    get: () => ({ runtimeV2Checkpoints: { turn: runtime.createRuntimeV2Checkpoint({ revision: f.aggregate.nextSequence, aggregate: f.aggregate, updatedAt: f.aggregate.updatedAt }) } }),
    context: { turnId: "turn", runtimeRunIntent: "execute", runWorkspace: "/fixture", runSessionKey: "/fixture:1", phaseLanguage: "en" },
    live, nextId: (scope) => `${scope}-1`, now: () => 100, logStoreEvent() {},
  });
  const receipt = await port.execute({ run: f.run, command, signal: new AbortController().signal });
  assert.equal(receipt.type, "validation.completed");
  assert.equal(receipt.passed, false);
  assert.deepEqual(receipt.evidence, []);
  f.apply(receipt.type, receipt);
  const effects = deriveRuntimeV2ProviderEffectFacts(f.aggregate);
  assert.ok(effects.unexecutedToolCallIds.has("validator"));
  assert.ok(!effects.failedValidationToolCallIds.has("validator"));
  assert.ok(!surface.completedRuntimeV2ProviderToolCallIdentities(live.messages, effects).has(surface.runtimeV2ProviderToolCallIdentity(calls[1])));
  assert.deepEqual(sideEffects, []);
});

test("a new provider decision is not poisoned by a prior batch's failed predecessor", async () => {
  const f = ledger();
  const [first] = runtime.decideNextCommands(f.aggregate);
  f.apply("command.scheduled", { run: f.run, command: first });
  f.apply("tool.completed", { run: f.run, idempotencyKey: first.idempotencyKey, status: "failed", failureKind: "execution_failed", evidence: [] });
  const retry = { id: "fresh-inspection", name: "run_command", arguments: { command: "tool inspect" } };
  const request = { kind: "request_model", phase: "observing", run: f.run, idempotencyKey: "new-provider-decision", payload: { mode: "execute" } };
  f.apply("command.scheduled", { run: f.run, command: request });
  f.apply("provider.responded", { run: f.run, idempotencyKey: request.idempotencyKey, result: { visibleText: "", toolCalls: [retry], diagnostics: [] } });
  const [command] = runtime.decideNextCommands(f.aggregate);
  const { runtimeV2SequentialShellBatchInterruption } = loadTs("src/store/runtimeV2/executionSequentialShellBatch.ts");
  assert.equal(runtimeV2SequentialShellBatchInterruption(f.aggregate, command), null);
});
