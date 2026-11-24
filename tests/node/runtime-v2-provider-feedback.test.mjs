import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const runtime = load("src/lib/runtime-v2/index.ts");
const { buildRuntimeV2RepeatedActionReceipts: receipts } = load("src/store/runtimeV2/executionProviderFeedback.ts");
const { runtimeV2ProviderToolCallIdentity: identity } = load("src/store/runtimeV2/providerReadReceipts.ts");
const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submit", turnId: "turn" };
const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
const call = { id: "mutation", name: "replace_in_file", arguments: { path: "src/example.ts", search_text: "PRIVATE_OLD_BODY", replace_text: "PRIVATE_NEW_BODY" } };

function fixture() {
  let state = null;
  const append = (type, fields) => {
    state = runtime.transition(state, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type,
      sequence: state?.nextSequence || 0, eventId: `event-${state?.nextSequence || 0}`, at: state?.nextSequence || 0, ...fields });
  };
  append("turn.admitted", { turn, strategy: "execute", objective: "Repair the mapping and verify it", acceptanceCriteria: [], constraints: [] });
  append("run.started", { run, phase: "acting" });
  const mutation = (candidate, status = "succeeded") => {
    const command = { kind: "execute_tool", idempotencyKey: candidate.id, phase: "acting", run,
      payload: { toolName: candidate.name, arguments: candidate.arguments, toolCallId: candidate.id } };
    append("command.scheduled", { run, command });
    append("tool.completed", { run, idempotencyKey: command.idempotencyKey, status,
      evidence: status === "succeeded" ? [{ id: `${candidate.id}-effect`, kind: "mutation", target: candidate.arguments.path, version: `${candidate.id}-version` }] : [],
      ...(status === "succeeded" ? {} : { failureKind: "source_mismatch", failureReasonCode: "mutation_source_text_mismatch", presentation: { message: "Old source did not match" } }) });
  };
  const reflect = (receipt) => {
    const key = `request-${state.nextSequence}`;
    append("command.scheduled", { run, command: { kind: "request_model", idempotencyKey: key, phase: "acting", run, payload: {} } });
    append("provider.responded", { run, idempotencyKey: key,
      result: { toolCalls: [], diagnostics: [], visibleText: "", actionReceipts: [receipt] } });
  };
  let receiptId = 0;
  const repeated = (aggregate = state, reason = "already_rejected") => receipts({ calls: [call], aggregate, reason, workspace: "/fixture", visibleSourceTargets: [],
    observed: new Set([identity(call)]), nextId: () => `rejected-${++receiptId}` })[0];
  return { append, mutation, reflect, repeated, get state() { return state; } };
}

test("completed mutation provenance survives rejection reflections and cold restore at the same boundary", () => {
  const f = fixture();
  f.mutation(call);
  const first = f.repeated(f.state, "already_completed");
  f.reflect(first);
  const checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate: f.state, revision: f.state.nextSequence, updatedAt: f.state.updatedAt });
  const cold = runtime.normalizeRuntimeV2Checkpoint(runtime.serializeRuntimeV2CheckpointMap({ turn: checkpoint }).turn).aggregate;
  for (const aggregate of [f.state, cold]) {
    const before = JSON.stringify(aggregate);
    const receipt = f.repeated(aggregate);
    assert.equal(receipt.status, "rejected", "the duplicate still has no executable effect");
    assert.equal(receipt.reasonCode, "already_completed");
    assert.equal(receipt.priorFeedbackObserved, true);
    assert.match(receipt.feedback, /already completed/);
    assert.match(receipt.feedback, /committed result/i);
    assert.match(receipt.feedback, /validation/i);
    assert.doesNotMatch(receipt.feedback, /read_file|derive a materially different mutation|PRIVATE_OLD_BODY|PRIVATE_NEW_BODY|Original failure/);
    assert.equal(JSON.stringify(aggregate), before, "feedback cannot manufacture validation or conclusion evidence");
  }
});

test("an original failed mutation keeps its source recovery guidance", () => {
  const f = fixture();
  f.mutation(call, "failed");
  const receipt = f.repeated();
  assert.equal(receipt.reasonCode, "already_rejected");
  assert.match(receipt.feedback, /Original failure: failed: mutation_source_text_mismatch/);
  assert.match(receipt.feedback, /call read_file/);
});

test("new parent and child mutation boundaries do not inherit an older completed action", () => {
  for (const child of [false, true]) {
    const f = fixture();
    f.mutation(call);
    f.reflect(f.repeated(f.state, "already_completed"));
    if (child) {
      const scheduled = runtime.scheduleRuntimeV2Subagents({ parentRun: run, maxActiveJobs: 1, requestedAt: f.state.nextSequence, nextId: () => "child",
        candidates: [{ scopeKey: "other", taskKind: "implement", accessMode: "write", implementationOperation: "modify", implementationPlan: "Modify the independent source from its current content", objective: "Update independent source", allowedPaths: ["src/other.ts"] }] });
      f.append("subagents.scheduled", { run, maxActiveSubagents: 1, jobs: scheduled.jobs });
      const evidence = [{ id: "child-effect", kind: "mutation", target: "src/other.ts", version: "child-version" }];
      const report = runtime.compileRuntimeV2SubagentReport({ draft: { summary: "Updated independent source", findings: [{ statement: "The source changed", evidence_ids: ["child-effect"] }], unresolved: [] }, evidence });
      for (const phase of ["request_opened", "closed"]) f.append("subagent.telemetry", { run, telemetry: { jobId: "child", phase, at: f.state.nextSequence } });
      f.append("subagent.completed", { run, jobId: "child", status: "completed", summary: report.summary, report, evidence });
    }
    else f.mutation({ ...call, id: "other", arguments: { ...call.arguments, path: "src/other.ts" } });
    const receipt = f.repeated();
    assert.equal(receipt.reasonCode, "already_rejected");
    assert.doesNotMatch(receipt.feedback, /already completed/);
  }
});

test("a reflection alone cannot prove a completed mutation or override a real failure", () => {
  const f = fixture();
  f.mutation(call, "failed");
  f.reflect({ call, actionIdentity: identity(call), status: "rejected", reasonCode: "already_completed", feedback: "An old reflection claimed completion" });
  assert.equal(f.repeated().reasonCode, "already_rejected");
});

test("a current successful mutation supersedes its earlier failed attempt in feedback only", () => {
  const f = fixture();
  f.mutation({ ...call, id: "failed-first" }, "failed");
  f.mutation(call);
  const receipt = f.repeated();
  assert.equal(receipt.reasonCode, "already_completed");
  assert.doesNotMatch(receipt.feedback, /Original failure|Old source did not match|call read_file/);
  assert.equal(f.state.events.filter(event => event.type === "tool.completed").length, 2);
});
