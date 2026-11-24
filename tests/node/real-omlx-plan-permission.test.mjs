import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const runtime = load("src/lib/runtime-v2/index.ts");
const adapter = load("src/store/runtimeV2/workPlanAdapter.ts");
const approval = load("src/store/runtimeV2/planApproval.ts");
const review = load("src/lib/pendingToolReview.ts");
const { validateRealOmlxPlannedPermission: validate } = load("tests/e2e/realOmlxPlanPermission.ts");

async function fixture(t, { toolName = "replace_in_file", args, extraSteps = [] } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "main-plan-permission-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = await fs.realpath(temporary);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/parser.ts"), "old\n");
  const turn = { workspaceKey: root, sessionKey: `${root}:1`, sessionEpoch: "epoch-1", turnId: "turn-1", clientSubmissionId: "submission-1" };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: "run-1", parentRunId: null, attemptId: "attempt-1" };
  let aggregate = null;
  let sequence = 0;
  const append = draft => {
    aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: aggregate?.nextSequence || 0, eventId: `event-${++sequence}`, at: sequence, ...draft });
  };
  append({ type: "turn.admitted", turn, strategy: "plan", objective: "Repair parser and run npm test", approvalRequiredCapabilities: ["workspace_write", "command"], constraints: [], acceptanceCriteria: ["Tests pass"] });
  append({ type: "run.started", run, phase: "planning" });
  const plan = runtime.sealWorkPlanV1({ id: "plan-1", revision: 1, createdAt: 2,
    draft: { schemaVersion: "work-plan.v1", objective: "Repair parser and run npm test", summary: "A narrow parser repair", findings: [],
      steps: [{ title: "Repair parser", operation: "modify", targets: ["src/parser.ts"], basis: ["E1"], change: "Fix the mapping", expectedOutcome: "Mapping passes", dependsOn: [] }, ...extraSteps],
      validations: [{ kind: "finite_command", command: "npm test", required: true, stepIndexes: [0], expectedOutcome: "Tests pass" }], risks: [], assumptions: [], blockingQuestions: [] },
    evidence: [{ id: "E1", target: "src/parser.ts", version: "v1", statement: "Read parser" }] });
  const documentRef = { owner: { workspace: root, sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId }, documentId: "doc-1", revision: 1,
    contentHash: createHash("sha256").update(plan.markdown).digest("hex"), path: `${root}/.MAIN/plans/doc-1/rev-1.md`, title: plan.draft.objective, kind: "plan" };
  const commit = adapter.createRuntimeV2PlanReviewCommit({ plan, turn, run, requestId: "review-1", createdAt: 3, documentRef });
  append({ type: "command.scheduled", run, command: { kind: "execute_tool", phase: "planning", run, idempotencyKey: "save-doc", payload: { toolName: "save_plan_document", target: "doc-1", runtimeOwnedPlanArtifact: true } } });
  append({ type: "tool.completed", run, idempotencyKey: "save-doc", status: "succeeded", modelContent: JSON.stringify({ planDocument: documentRef, markdown: plan.markdown }), evidence: [] });
  append({ type: "work_plan.sealed", run, workPlan: adapter.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit });
  let checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
  const request = { kind: "plan_review", status: "pending", requestId: commit.review.requestId,
    sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: run.runId,
    parentRunId: null, planRevision: plan.revision, artifactHash: plan.projectionHash, artifactPaths: [documentRef.path], documentRef };
  const result = await approval.approveRuntimeV2PlanReviewCheckpoint({ checkpoint,
    port: { async append(input) { const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input }); checkpoint = result.checkpoint || checkpoint; return result; } },
    request, expected: request, now: ++sequence, eventId: "approved-event" });
  assert.equal(result.ok, true);
  aggregate = checkpoint.aggregate;
  append({ type: "phase.changed", run, phase: "observing", reason: "Inspect current source" });
  const arguments_ = args || { path: "src/parser.ts", search_text: "old", replace_text: "new" };
  const call = { id: "provider-call-1", name: toolName, arguments: arguments_, source: "native" };
  append({ type: "command.scheduled", run, command: { kind: "request_model", run, phase: "observing", idempotencyKey: "request-model", payload: {} } });
  append({ type: "provider.responded", run, idempotencyKey: "request-model", result: { toolCalls: [call], diagnostics: [] } });
  append({ type: "phase.changed", run, phase: "acting", reason: "Execute exact planned action" });
  const command = { kind: "execute_tool", run, phase: "acting", idempotencyKey: "effect-command-1", payload: { toolName, arguments: arguments_, toolCallId: call.id } };
  append({ type: "command.scheduled", run, command });
  const pending = { toolCallId: command.idempotencyKey, name: toolName, arguments: arguments_, risk: toolName === "run_command" ? "shell" : "workspace_write",
    approvalRequiredCapability: toolName === "run_command" ? "command" : "workspace_write" };
  const permission = review.buildToolPermissionActionRequest({ sessionKey: run.sessionKey, turnId: run.turnId, runId: run.runId, parentRunId: run.parentRunId,
    title: "Exact planned action", taskId: 42, toolCall: pending, now: ++sequence });
  append({ type: "run.wait_started", run, requestId: permission.requestId, commandKey: command.idempotencyKey });
  return { root, expected: { plan, commit }, observed: { currentWorkspace: root, currentSessionKey: run.sessionKey, currentTurnId: run.turnId, sessionEpoch: run.sessionEpoch,
    marker: { sessionKey: run.sessionKey, turnId: run.turnId, runId: run.runId, parentRunId: null, status: "running" },
    request: permission, pendingReviewTaskId: 42, hasPendingResolver: true, pendingToolCall: pending, aggregate } };
}

test("an exact current planned replace uses the real permission identity", async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.observed);
  const approved = await validate(f.observed, f.expected, f.root);
  assert.deepEqual(approved.identity, { sessionKey: f.observed.currentSessionKey, turnId: "turn-1", runId: "run-1", requestId: f.observed.request.requestId, taskId: 42 });
  assert.deepEqual(approved.targets, [path.join(f.root, "src/parser.ts")]);
  assert.equal(JSON.stringify(f.observed), before, "test validation must not mutate canonical authority or approval requirements");
});

test("only exact sealed finite validation command bytes and cwd can be approved", async t => {
  const f = await fixture(t, { toolName: "run_command", args: { command: "npm test", description: "Run the sealed parser test", cwd: ".", timeout_ms: 60000 } });
  assert.equal((await validate(f.observed, f.expected, f.root)).commandKey, "effect-command-1");
});

test("write_file and a parsed one-file patch remain within the reviewed target", async t => {
  for (const [toolName, args] of [
    ["write_file", { path: "src/parser.ts", content: "new\n" }],
    ["apply_patch", { patch: "*** Begin Patch\n*** Update File: src/parser.ts\n@@\n-old\n+new\n*** End Patch" }],
  ]) {
    const f = await fixture(t, { toolName, args });
    assert.deepEqual((await validate(f.observed, f.expected, f.root)).targets, [path.join(f.root, "src/parser.ts")]);
  }
});

for (const [label, corrupt] of [
  ["session epoch", f => { f.observed.sessionEpoch = "replacement-epoch"; }],
  ["request parent", f => { f.observed.request.parentRunId = "another-parent"; }],
  ["request Turn", f => { f.observed.request.turnId = "other-turn"; }],
  ["process Run", f => { f.observed.marker.runId = "other-run"; }],
  ["request command identity", f => { f.observed.request.toolCallId = "new-effect"; }],
  ["canonical command epoch", f => { f.observed.aggregate = { ...f.observed.aggregate, scheduledCommands: f.observed.aggregate.scheduledCommands.map(command =>
    command.idempotencyKey === "effect-command-1" ? { ...command, run: { ...command.run, sessionEpoch: "old-epoch" } } : command) }; }],
  ["pending arguments", f => { f.observed.pendingToolCall = structuredClone(f.observed.pendingToolCall); f.observed.pendingToolCall.arguments.path = "src/extra.ts"; }],
  ["completed effect", f => { f.observed.aggregate = { ...f.observed.aggregate, completedCommands: [{ idempotencyKey: "effect-command-1" }] }; }],
  ["missing canonical approval", f => { f.observed.aggregate = { ...f.observed.aggregate, events: f.observed.aggregate.events.filter(event => event.type !== "work_plan.approved") }; }],
  ["changed document reference", f => { f.expected = structuredClone(f.expected); f.expected.commit.artifact.documentRef.contentHash = "0".repeat(64); }],
  ["pending review", f => { f.observed.aggregate = { ...f.observed.aggregate, workPlan: { ...f.observed.aggregate.workPlan, status: "pending_review" } }; }],
]) test(`refuses ${label} mismatch without resolving the permission`, async t => {
  const f = await fixture(t); corrupt(f);
  await assert.rejects(validate(f.observed, f.expected, f.root), /REAL_OMLX_UNEXPECTED_PLAN_PERMISSION/);
});

for (const [label, toolName, args] of [
  ["extra write target", "write_file", { path: "src/unreviewed.ts", content: "new" }],
  ["parent traversal", "replace_in_file", { path: "../outside.ts", search_text: "old", replace_text: "new" }],
  ["additional patch target", "apply_patch", { patch: "*** Begin Patch\n*** Update File: src/parser.ts\n@@\n-old\n+new\n*** Add File: src/extra.ts\n+extra\n*** End Patch" }],
  ["command suffix", "run_command", { command: "npm test; touch extra.txt", description: "Not just the planned test" }],
  ["different finite validation", "run_command", { command: "npm run build", description: "Finite but never approved" }],
  ["different command directory", "run_command", { command: "npm test", description: "Wrong package", cwd: "src" }],
  ["command stdin", "run_command", { command: "npm test", description: "Extra input", input: "mutate something" }],
]) test(`refuses ${label}`, async t => {
  const f = await fixture(t, { toolName, args });
  await assert.rejects(validate(f.observed, f.expected, f.root), /REAL_OMLX_UNEXPECTED_PLAN_PERMISSION/);
});

test("a reviewed textual path cannot authorize an escaping symlink", async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, "src/parser.ts"));
  await fs.symlink(path.join(os.tmpdir(), "outside-parser.ts"), path.join(f.root, "src/parser.ts"));
  await assert.rejects(validate(f.observed, f.expected, f.root), /symlink/);
});

async function actualBrowserAdapter(f) {
  // Execute the actual page.evaluate callback; do not duplicate its race fence.
  const { default: ts } = await import("typescript");
  const source = await fs.readFile("tests/e2e/real-omlx-plan-flow.spec.ts", "utf8");
  const ast = ts.createSourceFile("spec.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "inspectPlannedPermissionStore");
  assert.ok(declaration);
  const actual = declaration.getText(ast)
    .replace('await import("/src/store/useAppStore.ts")', "({ useAppStore: store })")
    .replace('await import("/src/lib/runtime-v2/checkpoint.ts")', "({ normalizeRuntimeV2Checkpoint: normalize })");
  const compiled = ts.transpileModule(actual, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const observed = f.observed;
  let callbacks = 0;
  const state = { currentWorkspace: observed.currentWorkspace, currentTurnId: observed.currentTurnId,
    getCurrentSessionKey: () => observed.currentSessionKey, planLifecycle: { sessionEpoch: observed.sessionEpoch },
    harnessRunMarker: observed.marker, activeActionRequest: observed.request, pendingReviewTaskId: observed.pendingReviewTaskId,
    pendingReviewResolve() {}, pendingToolCall: observed.pendingToolCall,
    runtimeV2Checkpoints: { [observed.currentTurnId]: { aggregate: observed.aggregate } },
    autoApproveTools: false,
    approvePendingReviewOnce(identity) {
      assert.deepEqual(identity, { sessionKey: observed.currentSessionKey, turnId: observed.currentTurnId,
        runId: observed.request.runId, requestId: observed.request.requestId, taskId: observed.request.taskId });
      callbacks += 1;
      state.activeActionRequest = null;
    },
  };
  const inspect = new Function("store", "normalize", `${compiled}; return inspectPlannedPermissionStore;`)(
    { getState: () => state }, checkpoint => checkpoint,
  );
  const page = { evaluate: (callback, value) => callback(value) };
  return { state, inspect: approval => inspect(page, approval), callbacks: () => callbacks };
}

test("actual browser callback uses approve_once without granting persistent auto-review", async t => {
  const f = await fixture(t);
  const adapter = await actualBrowserAdapter(f);
  const capture = await adapter.inspect(null);
  const decision = await validate(capture.observed, f.expected, f.root);
  const result = await adapter.inspect({ signature: capture.signature, identity: decision.identity });
  assert.equal(result.approved, true);
  assert.equal(adapter.callbacks(), 1);
  assert.equal(adapter.state.autoApproveTools, false);
  assert.deepEqual(adapter.state.runtimeV2Checkpoints[f.observed.currentTurnId].aggregate.objective.approvalRequiredCapabilities,
    ["workspace_write", "command"]);
});

for (const [label, replace] of [
  ["same-ID arguments", state => { state.pendingToolCall = { ...state.pendingToolCall, arguments: { ...state.pendingToolCall.arguments, path: "src/other.ts" } }; }],
  ["replacement epoch", state => { state.planLifecycle = { sessionEpoch: "new-generation" }; }],
  ["replacement permission", state => { state.activeActionRequest = { ...state.activeActionRequest, requestId: "new-request" }; }],
]) test(`actual browser callback leaves ${label} pending after host validation`, async t => {
  const f = await fixture(t);
  const adapter = await actualBrowserAdapter(f);
  const capture = await adapter.inspect(null);
  const decision = await validate(capture.observed, f.expected, f.root);
  replace(adapter.state);
  const result = await adapter.inspect({ signature: capture.signature, identity: decision.identity });
  assert.equal(result.approved, false);
  assert.equal(adapter.callbacks(), 0);
  assert.notEqual(adapter.state.activeActionRequest, null);
});
