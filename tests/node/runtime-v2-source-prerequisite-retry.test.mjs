import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submit", turnId: "turn" };
const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
const patch = { name: "replace_in_file", arguments: { path: "target.txt", search_text: "before", replace_text: "after" } };

function fixture() {
  let reply;
  let sequence = 0;
  let id = 0;
  let aggregate = null;
  let failNextMutation = false;
  const files = new Map([["target.txt", "before\n"], ["other.txt", "unrelated\n"]]);
  const effects = [];
  const load = createTsModuleLoader({
    "../../lib/streaming": { isStreamOutputLimited: () => false, streamChatCompletion: async () => ({ content: "", toolCalls: [{ id: "wire-call", name: reply.name, arguments: JSON.stringify(reply.arguments) }], usage: {}, protocolViolation: null }) },
    "../../lib/providerLaneSettings": {
      deriveBudgetedStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "fixture", contextLimit: 32768 }),
      deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
    },
    "../../lib/modelLaneCoordinator": { acquireModelLane: async () => ({ markFirstToken() {}, reportFailure() {}, release() {}, setPressureHandler() {} }) },
    "../../lib/toolExecutor": { executeTool: async (name, args) => {
      if (name === "read_file") return files.get(args.path);
      assert.equal(name, "replace_in_file");
      const source = files.get(args.path);
      assert.ok(source.includes(args.search_text), "the actual mutation still checks current source");
      files.set(args.path, source.replace(args.search_text, args.replace_text));
      effects.push(args.path);
      if (failNextMutation) { failNextMutation = false; throw new Error("Mutation failed after a partial write"); }
      return JSON.stringify({ success: true, changedPaths: [args.path] });
    } },
    "../../lib/toolDiff": { buildToolDiffPreview: async () => undefined },
    "../../lib/ipc": { checkSourceSyntax: async () => ({ applicable: false, hasErrors: false, errors: [] }) },
  });
  const runtime = load("src/lib/runtime-v2/index.ts");
  const { createRuntimeV2LiveExecutionState } = load("src/store/runtimeV2/executionTypes.ts");
  const live = createRuntimeV2LiveExecutionState();
  live.providerLaneProfile = { schemaVersion: "provider-lane.v1", nativeTools: true, requiredToolChoice: false, streaming: true, textToolEnvelope: true, reasoning: false, imageInput: false, toolResultRole: "tool" };
  live.messages = [{ role: "system", content: "[MAIN RUNTIME V2] fixture authority" }, { role: "user", runtimeTurnId: turn.turnId, content: "Change before to after in target.txt using its current source." }];
  const state = { config: { language: "en", activeProfile: "local", local: { provider: "OMLX", model: "fixture", toolProtocol: "native" } },
    conversationTurns: [{ id: turn.turnId, userPrompt: "Change before to after in target.txt", status: "executing", blockIds: [] }],
    agentMessages: [], runtimeV2Checkpoints: {}, currentTurnId: turn.turnId, currentTurnExecutionConsent: { turnId: turn.turnId, granted: true }, autoApproveTools: true, autoApproveToolScopes: ["workspace_write"],
    _nextTaskId: () => ++id };
  const append = (type, fields) => {
    aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type, sequence: sequence++, eventId: `event-${sequence}`, at: sequence, ...fields });
    state.runtimeV2Checkpoints[turn.turnId] = runtime.createRuntimeV2Checkpoint({ aggregate, revision: sequence, updatedAt: sequence });
  };
  append("turn.admitted", { turn, strategy: "execute", objective: "Change before to after", acceptanceCriteria: [], constraints: [] });
  append("run.started", { run, phase: "acting" });
  const ports = { get: () => state, set: updater => Object.assign(state, typeof updater === "function" ? updater(state) : updater), live,
    context: { turnId: turn.turnId, runtimeRunIntent: "execute", runWorkspace: "/fixture", runSessionKey: turn.sessionKey, phaseLanguage: "en", runtimeContextBudget: { contextLimit: 32768, inputBudget: 28672, outputBudget: 4096, readWindowChars: 18000 } },
    nextId: scope => `${scope}-${++id}`, now: () => sequence, logStoreEvent() {} };
  const provider = load("src/store/runtimeV2/executionProviderPort.ts").createRuntimeV2ProviderPort(ports);
  const tool = load("src/store/runtimeV2/executionToolPort.ts").createRuntimeV2ToolPort(ports);
  const propose = async call => {
    reply = call;
    const command = { kind: "request_model", idempotencyKey: `request-${++id}`, phase: "acting", run, payload: { mode: "execute" } };
    append("command.scheduled", { run, command });
    const result = await provider.request({ command, signal: new AbortController().signal });
    append("provider.responded", { run, idempotencyKey: command.idempotencyKey, result });
    return result;
  };
  const execute = async call => {
    const command = { kind: "execute_tool", idempotencyKey: `tool-${++id}`, phase: "acting", run, payload: { toolName: call.name, arguments: call.arguments, toolCallId: call.id } };
    append("command.scheduled", { run, command });
    const receipt = await tool.execute({ command, signal: new AbortController().signal });
    append(receipt.type, receipt);
    return receipt;
  };
  const reject = (status = "blocked", failureKind = "protocol_invalid", failureReasonCode = "mutation_source_lease_missing") => {
    const command = { kind: "execute_tool", idempotencyKey: `rejected-${++id}`, phase: "acting", run, payload: { toolName: patch.name, arguments: patch.arguments, toolCallId: `rejected-call-${id}` } };
    append("command.scheduled", { run, command });
    append("tool.completed", { run, idempotencyKey: command.idempotencyKey, status, failureKind, failureReasonCode, evidence: [] });
  };
  const read = async path => execute((await propose({ name: "read_file", arguments: { path } })).toolCalls[0]);
  return { propose, execute, reject, read, files, effects, live, load, failMutation: () => { failNextMutation = true; }, get aggregate() { return aggregate; } };
}

test("ProviderPort retries an unexecuted missing-source patch after a fresh ToolPort source receipt in the same Run", async () => {
  const f = fixture();
  const first = await f.execute((await f.propose(patch)).toolCalls[0]);
  assert.equal(first.status, "blocked");
  assert.equal(first.failureReasonCode, "mutation_source_lease_missing");
  assert.deepEqual(f.effects, []);
  const read = await f.read("target.txt");
  assert.equal(read.status, "succeeded");
  assert.ok(read.evidence.some(entry => entry.kind === "source" && entry.version));
  const retry = await f.propose(patch);
  assert.equal(retry.toolCalls.length, 1, "fresh source repairs the prerequisite; the exact patch must reach its original guard again");
  const committed = await f.execute(retry.toolCalls[0]);
  assert.equal(committed.status, "succeeded");
  assert.equal(f.files.get("target.txt"), "after\n");
  assert.deepEqual(f.effects, ["target.txt"]);
  assert.equal(f.aggregate.events.filter(event => event.type === "run.started").length, 1);
  assert.equal(f.aggregate.terminalOutcome, null, "source recovery does not create completion or validation");
});

test("reopening proposal eligibility never grants a source lease for text missing from the fresh read", async () => {
  const f = fixture();
  await f.execute((await f.propose(patch)).toolCalls[0]);
  f.files.set("target.txt", "different current text\n");
  await f.read("target.txt");
  const retry = await f.propose(patch);
  assert.equal(retry.toolCalls.length, 1);
  const guarded = await f.execute(retry.toolCalls[0]);
  assert.equal(guarded.status, "blocked");
  assert.equal(guarded.failureReasonCode, "mutation_source_text_mismatch");
  assert.equal(f.files.get("target.txt"), "different current text\n");
  assert.deepEqual(f.effects, []);
});

test("a real ToolPort partial execution failure stays closed after a new parent source receipt", async () => {
  const f = fixture();
  await f.read("target.txt");
  f.failMutation();
  const failed = await f.execute((await f.propose(patch)).toolCalls[0]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureKind, "execution_failed");
  assert.equal(f.files.get("target.txt"), "after\n", "the failed executor already produced an effect");
  const call = { id: "post-failure-fresh-read", name: "read_file", arguments: { path: "target.txt" } };
  f.live.messages.push({ role: "assistant", content: "", tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
  const source = await f.execute(call);
  assert.equal(source.status, "succeeded");
  assert.ok(source.evidence.some(entry => entry.kind === "source" && entry.version));
  assert.equal((await f.propose(patch)).toolCalls.length, 0);
  assert.deepEqual(f.effects, ["target.txt"], "a new read cannot replay an executor that already ran");
});

for (const control of ["executed_failure", "permission_denied", "mismatched_target", "old_read", "later_permission_denied", "earlier_execution_failure", "earlier_permission_denied"]) test(`source prerequisite retry does not reopen ${control}`, async () => {
  const f = fixture();
  if (control === "old_read") await f.read("target.txt");
  if (control === "earlier_execution_failure") f.reject("failed", "execution_failed", "mutation_execution_failed");
  if (control === "earlier_permission_denied") f.reject("blocked", "not_authorized", "turn_capability_restricted");
  if (control === "executed_failure") f.reject("failed", "execution_failed", "mutation_execution_failed");
  else if (control === "permission_denied") f.reject("blocked", "not_authorized", "turn_capability_restricted");
  else f.reject();
  if (control === "later_permission_denied") f.reject("blocked", "not_authorized", "turn_capability_restricted");
  if (control !== "old_read") await f.read(control === "mismatched_target" ? "other.txt" : "target.txt");
  const retry = await f.propose(patch);
  assert.equal(retry.toolCalls.length, 0);
  assert.ok(retry.diagnostics.some(entry => entry.code === "repeated_action_rejected"));
  assert.deepEqual(f.effects, []);
});
