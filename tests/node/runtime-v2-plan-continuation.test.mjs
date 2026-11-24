import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const runtime = load("src/lib/runtime-v2/index.ts");
const review = load("src/store/runtimeV2/workPlanAdapter.ts");
const planAuthorization = load("src/store/runtimeV2/executionPlanAuthorization.ts");
const toolAuthorization = load("src/store/runtimeV2/executionAuthorization.ts");
const { sha256Hex } = load("src/lib/sha256.ts");

let eventId = 0;
function event(state, fields) {
  return { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state?.nextSequence || 0, at: (state?.updatedAt || 0) + 1, eventId: `event-${++eventId}`, ...fields };
}
function append(state, fields) {
  return runtime.transition(state, event(state, fields));
}
function admit(id, continued = false, capabilityRestrictions = []) {
  const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: `submission-${id}`, turnId: `turn-${id}` };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: `run-${id}`, parentRunId: null, attemptId: `attempt-${id}` };
  let state = append(null, { type: "turn.admitted", turn, strategy: "plan", objective: "Deliver the reviewed steps", constraints: [],
    acceptanceCriteria: [], capabilityRestrictions, ...(continued ? { planPurpose: "plan" } : {}) });
  state = append(state, { type: "run.started", run, phase: "planning" });
  return state;
}
function sealFields(state, plan, continuation) {
  const run = state.run.identity;
  const reviewCommit = review.createRuntimeV2PlanReviewCommit({ plan, turn: state.turn, run, requestId: `review-${run.runId}`, createdAt: state.updatedAt });
  return { type: "work_plan.sealed", run, workPlan: review.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit,
    ...(continuation ? { continuation } : {}) };
}
function approve(state, continuation) {
  return append(state, { type: "work_plan.approved", run: state.run.identity, workPlan: { ...state.workPlan, status: "approved" },
    ...(continuation ? { continuationApprovalId: continuation.source.approvalEventId } : {}) });
}
function move(state, phase) {
  return append(state, { type: "phase.changed", run: state.run.identity, phase, reason: "fixture" });
}
function write(state, target, content) {
  const run = state.run.identity;
  const idempotencyKey = `write-${state.nextSequence}`;
  const command = { idempotencyKey, kind: "execute_tool", run, phase: state.phase,
    payload: { toolName: "write_file", arguments: { path: target, content } } };
  state = append(state, { type: "command.scheduled", run, command });
  return append(state, { type: "tool.completed", run, idempotencyKey, status: "succeeded",
    mutationRequests: [{ target, operation: "create" }], evidence: [{ id: `mutation-${target}`, target, kind: "mutation", version: null }] });
}
function cancel(state, resultKind = "canceled") {
  const run = state.run.identity;
  const reason = resultKind === "canceled" ? "user_cancelled" : "blocked";
  const finalProjection = runtime.buildRuntimeV2FinalProjection(state, "final", resultKind, reason);
  const outcome = { resultKind, reason, completedAt: state.updatedAt + 2, finalProjectionId: "final" };
  if (resultKind === "canceled") state = append(state, { type: "run.aborted", run, reason });
  state = append(state, { type: "run.completed", run, outcome, finalProjection });
  state = append(state, { type: "projection.published", run, audience: "final", projectionId: finalProjection.id, projection: finalProjection });
  return append(state, { type: "turn.completed", turn: state.turn, runId: run.runId, outcome });
}

function fixture(carried = 2, repeatedTarget = false) {
  const plan = runtime.sealWorkPlanV1({ createdAt: 1, evidence: [], draft: {
    schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION, objective: "Deliver the reviewed steps", summary: "Create files in order",
    findings: [], steps: ["a.txt", "b.txt", "c.txt"].map((target, index) => ({
      title: `Write ${target}`, operation: repeatedTarget && index === 1 ? "modify" : "create",
      targets: [repeatedTarget && index === 1 ? "a.txt" : target], basis: [], change: "Write the file.",
      expectedOutcome: "The exact file exists.", dependsOn: index ? [index - 1] : [],
    })), validations: [{ stepIndexes: [0, 1, 2], kind: "finite_command", command: "npm test", cwd: ".",
      expectedOutcome: "Pass", required: true }], risks: [], assumptions: [], blockingQuestions: [],
  } });
  let old = admit("old");
  old = append(old, sealFields(old, plan));
  old = move(approve(old), "acting");
  for (const target of ["a.txt", "b.txt", "c.txt"].slice(0, carried)) old = write(old, target, `bytes:${target}`);
  old = cancel(old);
  const previous = review.resolveHistoricalRuntimeV2ApprovedWorkPlan(old);
  assert.ok(previous);
  const continuation = {
    source: { turn: old.turn, run: old.run.identity, approvalEventId: previous.approvalEvent.eventId, workPlan: previous.approvalEvent.workPlan },
    completedStepIndexes: runtime.deriveRuntimeV2PlanExecutionFrontier(old).completedStepIndexes,
    carriedTargets: runtime.resolveRuntimeV2PlanContinuationPostImages(old),
  };
  return { old, plan, continuation };
}

test("continued Plan seeds dependency-ordered progress and validates the fresh version boundary", () => {
  const { old, plan, continuation } = fixture();
  assert.equal(review.resolveApprovedRuntimeV2WorkPlanFromAggregate(old), null);
  assert.deepEqual(continuation.carriedTargets.map(fact => fact.version), ["a.txt", "b.txt"].map(target => `sha256-${sha256Hex(`bytes:${target}`)}`));
  let current = admit("new", true);
  current = append(current, sealFields(current, plan, continuation));
  assert.equal(runtime.deriveRuntimeV2PlanExecutionFrontier(current), null);
  const invalidApproval = event(current, { type: "work_plan.approved", run: current.run.identity, workPlan: { ...current.workPlan, status: "approved" } });
  assert.equal(runtime.tryTransition(current, invalidApproval).reason, "plan_identity_mismatch");
  current = move(approve(current, continuation), "acting");
  assert.ok(review.resolveApprovedRuntimeV2WorkPlanFromAggregate(current));
  assert.deepEqual(runtime.deriveRuntimeV2PlanExecutionFrontier(current).completedStepIndexes, [0, 1]);
  assert.deepEqual(runtime.deriveRuntimeV2PlanExecutionFrontier(current).readyMutationTargets, ["c.txt"]);
  assert.deepEqual(runtime.deriveRuntimeV2PlanExecutionCoverage(current).committedMutationTargets, ["a.txt", "b.txt"]);
  assert.equal(current.evidence.filter(receipt => receipt.kind === "mutation").length, 0);

  current = write(current, "c.txt", "bytes:c.txt");
  assert.equal(runtime.deriveRuntimeV2PlanExecutionCoverage(current).allMutationTargetsCovered, true);
  const authority = runtime.runtimeV2PlanValidationAuthority({ plan, validationIndex: 0 });
  const boundary = runtime.deriveRuntimeV2ValidationBoundary(current, authority.targetPaths);
  assert.deepEqual(boundary.validatedMutationVersions.map(item => item.target), ["a.txt", "b.txt", "c.txt"]);
  assert.equal(boundary.validatedMutationVersions[0].version, continuation.carriedTargets[0].version);
  current = move(current, "validating");
  const run = current.run.identity;
  const command = { idempotencyKey: "fresh-validate", kind: "execute_validation", phase: "validating", run,
    payload: { toolName: "run_command", arguments: { command: "npm test", cwd: "." }, validationAuthority: authority } };
  current = append(current, { type: "command.scheduled", command, run });
  current = append(current, { type: "validation.completed", run, idempotencyKey: command.idempotencyKey, passed: true, authority, ...boundary, evidence: [] });
  assert.equal(runtime.deriveRuntimeV2PlanExecutionCoverage(current).allRequiredValidationsPassed, true);

  const checkpoint = runtime.createRuntimeV2Checkpoint({ revision: current.nextSequence, aggregate: current, updatedAt: current.updatedAt });
  const raw = JSON.parse(JSON.stringify(runtime.serializeRuntimeV2CheckpointMap({ [current.turn.turnId]: checkpoint })));
  const restored = runtime.normalizeRuntimeV2Checkpoint(raw[current.turn.turnId], current.turn).aggregate;
  assert.deepEqual(restored.planContinuation, continuation);
  assert.equal(runtime.deriveRuntimeV2PlanExecutionCoverage(restored).allRequiredValidationsPassed, true);
  assert.equal(old.terminalOutcome.resultKind, "canceled");
});

test("continued Plan rejects foreign, incomplete, or unverified carried baselines", () => {
  const { plan, continuation } = fixture();
  const current = admit("new", true);
  for (const invalid of [
    { ...continuation, source: { ...continuation.source, turn: { ...continuation.source.turn, sessionEpoch: "foreign" } } },
    { ...continuation, completedStepIndexes: [1], carriedTargets: continuation.carriedTargets.slice(1) },
    { ...continuation, carriedTargets: continuation.carriedTargets.slice(0, 1) },
    { ...continuation, carriedTargets: continuation.carriedTargets.map(item => ({ ...item, version: null })) },
  ]) {
    assert.equal(runtime.tryTransition(current, event(current, sealFields(current, plan, invalid))).reason, "plan_identity_mismatch");
  }
});

test("a pending edit of a previously created target expects its carried post-image", () => {
  const { plan, continuation } = fixture(1, true);
  let current = admit("repeated", true);
  current = move(approve(append(current, sealFields(current, plan, continuation)), continuation), "observing");
  const freshness = runtime.deriveRuntimeV2PlanSourceFreshness(current);
  assert.deepEqual(freshness.entries.map(({ target, expectedVersions, status }) => ({ target, expectedVersions, status })),
    [{ target: "a.txt", expectedVersions: [continuation.carriedTargets[0].version], status: "missing" }]);
});

test("continued Plan with only validation outstanding can continue again after cancellation", () => {
  const { old, plan, continuation } = fixture(3);
  const documentRef = { owner: { workspace: old.turn.workspaceKey, sessionKey: old.turn.sessionKey,
    sessionEpoch: old.turn.sessionEpoch, turnId: old.turn.turnId }, documentId: "fixture-doc", revision: 1,
    contentHash: sha256Hex(plan.markdown), path: ".MAIN/plans/fixture-doc/rev-1.md", title: "Fixture", kind: "plan" };
  const first = { ...continuation, source: { ...continuation.source, documentRef } };
  let current = admit("second", true);
  current = move(approve(append(current, sealFields(current, plan, first)), first), "observing");
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(current, { isMutationToolName: () => true }),
    { from: "observing", to: "validating", reason: "unvalidated_mutation_pending" });
  const canceled = cancel(current);
  const previous = review.resolveHistoricalRuntimeV2ApprovedWorkPlan(canceled);
  assert.ok(previous);
  assert.equal(previous.approvalEvent.continuationApprovalId, continuation.source.approvalEventId);
  assert.deepEqual(runtime.resolveRuntimeV2PlanContinuationPostImages(canceled), continuation.carriedTargets);
  const second = { ...first, source: { turn: canceled.turn, run: canceled.run.identity, approvalEventId: previous.approvalEvent.eventId,
    workPlan: previous.approvalEvent.workPlan, documentRef, documentTurn: old.turn } };
  const third = admit("third", true);
  assert.deepEqual(append(third, sealFields(third, plan, second)).planContinuation, second);
  assert.equal(runtime.tryTransition(third, event(third, sealFields(third, plan, { ...second, source: { ...second.source, documentTurn: undefined } }))).reason,
    "plan_identity_mismatch");
});

test("a historical blocked Run qualifies only for typed continued Plan drift", () => {
  const { plan, continuation } = fixture();
  let current = admit("drifted", true);
  current = move(approve(append(current, sealFields(current, plan, continuation)), continuation), "acting");
  assert.equal(review.resolveHistoricalRuntimeV2ApprovedWorkPlan(cancel(current, "blocked")), null);
  const observed = append(current, { type: "observation.recorded", run: current.run.identity,
    evidence: { id: "approved-plan-drift:0", kind: "tool", target: "a.txt", version: null } });
  assert.ok(review.resolveHistoricalRuntimeV2ApprovedWorkPlan(cancel(observed, "blocked")));
});

test("continued approval only grants exact ready file effects and reviewed finite validators", async () => {
  const { plan, continuation } = fixture();
  let current = admit("scoped", true);
  current = move(approve(append(current, sealFields(current, plan, continuation)), continuation), "acting");
  const state = { config: {}, currentTurnExecutionConsent: { granted: false, turnId: null }, get runtimeV2Checkpoints() {
    return { [current.turn.turnId]: runtime.createRuntimeV2Checkpoint({ revision: current.nextSequence, aggregate: current, updatedAt: current.updatedAt }) };
  } };
  const ports = { get: () => state, context: { runWorkspace: "/fixture", turnId: current.turn.turnId }, live: {} };
  const commandFor = (kind = "execute_tool") => ({ kind, run: current.run.identity, phase: current.phase, idempotencyKey: "check-scope", payload: {} });
  const authorize = (toolName, args, target, kind, writeFileTarget) => planAuthorization.validateToolAgainstApprovedPlan({
    ports, aggregate: current, command: commandFor(kind), toolName, args, target, writeFileTarget,
  });
  const content = { path: "c.txt", content: "approved" };
  assert.equal(authorize("write_file", content, "c.txt").allowed, true);
  assert.equal(authorize("write_file", content, "c.txt", undefined, { path: "c.txt", exists: true }).reasonCode, "continued_plan_mutation_scope");
  assert.equal(authorize("write_file", { ...content, path: "/other/c.txt" }, "/other/c.txt").allowed, false);
  assert.equal(authorize("replace_in_file", { path: "a.txt" }, "a.txt").allowed, false);
  assert.equal(authorize("apply_patch", { patch: "*** Begin Patch\n*** Add File: c.txt\n+ok\n*** Add File: extra.txt\n+no\n*** End Patch" }, "c.txt").allowed, false);
  assert.equal((await toolAuthorization.authorizeToolForCurrentTurn(ports, "write_file", content)).allowed, false);
  assert.equal((await toolAuthorization.authorizeToolForCurrentTurn(ports, "write_file", content, { command: commandFor(), target: "c.txt" })).allowed, true);
  assert.equal((await toolAuthorization.authorizeToolForCurrentTurn(ports, "write_file", { ...content, path: "extra.txt" }, { command: commandFor(), target: "extra.txt" })).allowed, false);
  const shell = { command: "npm test", cwd: "." };
  assert.equal(authorize("run_command", shell, "npm test", "execute_validation").allowed, false);
  current = move(write(current, "c.txt", "approved"), "validating");
  assert.equal(authorize("run_command", shell, "npm test", "execute_validation").allowed, true);
  assert.equal(authorize("run_command", shell, "npm test").allowed, false);
  assert.equal(authorize("run_command", { ...shell, command: "npm  test" }, "npm test", "execute_validation").allowed, false);
  assert.equal(authorize("run_command", { ...shell, cwd: "other" }, "npm test", "execute_validation").allowed, false);
  assert.equal(authorize("run_command", { ...shell, input: "unreviewed" }, "npm test", "execute_validation").allowed, false);

  current = admit("restricted", true, ["workspace_write"]);
  current = move(approve(append(current, sealFields(current, plan, continuation)), continuation), "acting");
  assert.equal((await toolAuthorization.authorizeToolForCurrentTurn({ ...ports, context: { ...ports.context, turnId: current.turn.turnId } }, "write_file", content, { command: commandFor(), target: "c.txt" })).allowed, false);
});
