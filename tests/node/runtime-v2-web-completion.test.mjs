import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const runtime = load("src/lib/runtime-v2/index.ts");
const { runtimeV2ExecuteTerminalDecision } = load("src/store/runtimeV2/executionOutcome.ts");
const outcome = aggregate => runtimeV2ExecuteTerminalDecision({ aggregate, signal: new AbortController().signal });
const turn = { workspaceKey: "__MAIN_GLOBAL_CHAT__", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" };
const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
let id = 0;
const apply = (state, type, fields) => runtime.transition(state, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
  type, eventId: `web-completion-${++id}`, at: (state?.updatedAt || 0) + 1, sequence: state?.nextSequence || 0, ...fields });
function base(requirement = null) {
  const admitted = apply(null, "turn.admitted", { turn, strategy: "execute", objective: "Inspect the requested remote source.",
    networkRead: { enabled: true, provider: "bing" }, acceptanceCriteria: ["Answer from the actual result."],
    acceptanceCriterionIds: ["goal"], acceptanceEvidenceRequirements: [requirement], constraints: [] });
  return apply(admitted, "run.started", { run, phase: "observing" });
}
function provider(state, result) {
  const request = runtime.decideNextCommands(state)[0];
  assert.equal(request.kind, "request_model");
  state = apply(state, "command.scheduled", { run, command: request });
  return apply(state, "provider.responded", { run, idempotencyKey: request.idempotencyKey,
    result: { toolCalls: [], diagnostics: [], ...result } });
}
function tool(state, name, { status = "succeeded", evidence = [{ id: `E${++id}`, kind: "tool", target: "remote-source", version: "v1" }], receiptOrigin, args } = {}) {
  state = provider(state, { toolCalls: [{ id: `call-${++id}`, name, arguments: args ||
    (name === "web_search" ? { query: "source" } : name === "web_fetch" ? { url: "https://example.test/source" } : { path: "source.txt" }) }] });
  const command = runtime.decideNextCommands(state)[0];
  state = apply(state, "command.scheduled", { run, command });
  return apply(state, "tool.completed", { run, idempotencyKey: command.idempotencyKey, status, evidence, ...(receiptOrigin ? { receiptOrigin } : {}) });
}
const answer = state => provider(state, { visibleText: "The requested source has been read; this is the complete answer." });

test("the exact real MDN ledger reaches one natural final through the production outcome/controller without new evidence", async () => {
  // Exact events 0..21 from the real failed run, ending at its first complete
  // 1651-character answer. No synthetic source/validation facts are appended.
  const events = JSON.parse(fs.readFileSync(new URL("./fixtures/mdn-web-completion-events.json", import.meta.url), "utf8"));
  const state = runtime.replayRuntimeV2Events(events);
  assert.deepEqual(state.events, events);
  assert.equal(state.phase, "observing");
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].kind, "tool");
  assert.deepEqual(state.objective.acceptanceEvidenceRequirements, [null]);
  assert.equal(state.pendingToolCalls.length, 0);
  assert.equal(state.scheduledCommands.length, 0);
  const expected = events.at(-1).result.visibleText;
  assert.equal(runtime.runtimeV2ProviderAnswerText(state, events.at(-1)).length, 1651);
  const decision = outcome(state);
  assert.equal(decision?.resultKind, "success");
  assert.equal(decision.finalMarkdown, expected);
  let checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate: state, revision: events.length, updatedAt: state.updatedAt });
  const original = JSON.stringify(checkpoint);
  let clock = state.updatedAt;
  const finals = [];
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: { append: async input => {
      const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
      if (result.checkpoint) checkpoint = result.checkpoint;
      return result;
    } },
    provider: { request: async () => { throw new Error("A complete answer must not trigger resynthesis"); } },
    tool: { execute: async () => { throw new Error("No additional source or effects are required"); } },
    projection: { publish: async input => { if (input.projection.audience === "final") finals.push(input.projection); } },
    clockId: { now: () => ++clock, nextId: kind => `${kind}-${++id}`, nextIdempotencyKey: ({ kind }) => `${kind}-${++id}` },
  }, { aggregate: runtime.normalizeRuntimeV2Checkpoint(JSON.parse(original)).aggregate, revision: checkpoint.revision });
  await controller.driveOnce(decision);
  await controller.resumeTerminalProjection();
  const completed = controller.snapshot().aggregate;
  assert.deepEqual(completed.events.slice(0, events.length), events);
  assert.deepEqual(completed.evidence, state.evidence);
  assert.equal(completed.terminalOutcome.resultKind, "success");
  assert.equal(completed.events.filter(event => event.type === "run.completed").length, 1);
  assert.equal(completed.events.filter(event => event.type === "turn.completed").length, 1);
  assert.equal(new Set(finals.map(projection => projection.id)).size, 1);
  assert.equal(finals[0].markdown.split(expected).length - 1, 1, "the existing status projection preserves the complete natural answer exactly once");
});

test("both successful web reads support an optional later natural answer but do not force finalization", () => {
  for (const name of ["web_search", "web_fetch"]) {
    const observed = tool(base(), name);
    assert.equal(outcome(observed), null, "a receipt alone cannot finish a task");
    assert.equal(runtime.decideNextCommands(observed)[0].payload.mode, "execute");
    const settled = answer(observed);
    assert.equal(outcome(settled)?.resultKind, "success", name);
    assert.deepEqual(outcome(runtime.replayRuntimeV2Events(settled.events)), outcome(settled));
  }
});

test("source, guidance and discovery receipts never become network completion evidence", () => {
  for (const name of ["read_file", "get_project_skeleton", "load_skill", "tool_search"]) {
    assert.equal(outcome(answer(tool(base(), name))), null, name);
  }
});

test("failed, blocked, empty or replayed web receipts cannot support success", () => {
  for (const name of ["web_search", "web_fetch"]) {
    for (const options of [{ status: "failed" }, { status: "blocked" }, { evidence: [] }, { receiptOrigin: "replayed" },
      { evidence: [{ id: "not-tool", kind: "source", target: "file.txt", version: "v1" }] },
      { evidence: [{ id: "not-tool", kind: "validation", target: "test", version: "pass" }] }]) {
      assert.equal(outcome(answer(tool(base(), name, options))), null, `${name} ${JSON.stringify(options)}`);
    }
  }
});

test("a previous failed command remains unresolved after an unrelated successful web read", () => {
  let state = tool(base(), "run_command", { status: "failed", args: { command: "service status", cwd: "." } });
  state = answer(tool(state, "web_fetch"));
  assert.equal(outcome(state), null);
});

test("one successful web read cannot discharge another web call that has only an empty acknowledgement", () => {
  let state = tool(base(), "web_fetch");
  state = answer(tool(state, "web_search", { evidence: [] }));
  assert.equal(outcome(state), null);
});

test("new pending work after a successful web answer cannot reuse that answer", () => {
  let state = answer(tool(base(), "web_fetch"));
  state = provider(state, { toolCalls: [{ id: "pending-read", name: "read_file", arguments: { path: "source.txt" } }] });
  assert.equal(outcome(state), null);
  assert.equal(state.pendingToolCalls.length, 1);
  assert.equal(runtime.latestRuntimeV2ProviderConclusionText(state), "");
});

test("explicit typed acceptance, file mutation and implementation contract debts still block a web-based natural final", () => {
  for (const requirement of ["static", "behavioral", "interaction"]) {
    assert.equal(outcome(answer(tool(base(requirement), "web_fetch"))), null, requirement);
  }
  const mutated = tool(base(), "write_file", { evidence: [{ id: "mutation", kind: "mutation", target: "file.txt", version: "v2" }] });
  assert.equal(outcome(answer(tool(mutated, "web_fetch"))), null, "a real mutation still needs matching validation");
  const contracted = tool(base(), "record_execution_contract", { evidence: [], args: {
    summary: "Implement a file", changes: [{ operation: "create", targets: ["file.txt"], change: "Implement", expected_outcome: "Works" }],
    validations: [{ kind: "finite_command", command: "npm test", expected_outcome: "Passes" }],
  } });
  assert.equal(outcome(answer(tool(contracted, "web_fetch"))), null, "declared implementation coverage remains mandatory");
  const pendingPlan = { ...answer(tool(base(), "web_fetch")), workPlan: { id: "plan", revision: 1, digest: "digest", status: "reviewing" } };
  assert.equal(outcome(pendingPlan), null, "a WorkPlan keeps its independent review/execution boundary");
});

test("ordinary command and MCP operation receipts retain their existing natural completion path", () => {
  for (const name of ["run_command", "mcp__service__inspect"]) {
    assert.equal(outcome(answer(tool(base(), name, { args: { command: "service status", cwd: "." } })))?.resultKind, "success", name);
  }
});
