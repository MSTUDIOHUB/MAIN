import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", transpiled)(module.exports, module, localRequire);
  return module.exports;
}

const runtime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnRuntimeContract.ts"),
);

const {
  TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
  createCanonicalTurnRuntime,
  decideTurnIngress,
  planCanonicalTurnCancellation,
  projectCanonicalRunTransaction,
  projectTurnRuntimeCompatibility,
  reduceCanonicalTurnRuntime,
} = runtime;

const baseTurn = Object.freeze({
  workspaceKey: "/workspace/project",
  sessionKey: "session-a",
  sessionEpoch: "epoch-1",
  clientSubmissionId: "submission-1",
  turnId: "turn-1",
});

const baseRun = Object.freeze({
  sessionKey: "session-a",
  sessionEpoch: "epoch-1",
  turnId: "turn-1",
  runId: "run-1",
  parentRunId: null,
  attemptId: "attempt-1",
});

const childRun = Object.freeze({
  ...baseRun,
  runId: "run-2",
  parentRunId: "run-1",
  attemptId: "attempt-2",
});

function create(strategy = "execute", admittedAt = 10) {
  return createCanonicalTurnRuntime({ turn: baseTurn, strategy, admittedAt });
}

function nextEvent(state, type, fields = {}, at = state.lastEventAt + 1) {
  return {
    schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    type,
    sequence: state.nextSequence,
    at,
    ...fields,
  };
}

function apply(state, type, fields = {}, at) {
  const result = reduceCanonicalTurnRuntime(state, nextEvent(state, type, fields, at));
  assert.equal(result.disposition, "applied", result.reason);
  return result.state;
}

function start(state, phase = state.turn.strategy === "plan" ? "planning" : "preparing") {
  return apply(state, "run.started", { run: baseRun, phase });
}

function complete(state, resultKind = "success", reason = `run_${resultKind}`) {
  const runClosed = apply(state, "run.completed", {
    run: baseRun,
    resultKind,
    reason,
  });
  return apply(runClosed, "turn.completed", {
    turn: baseTurn,
    runId: baseRun.runId,
    resultKind,
    reason,
  });
}

test("every workspace strategy starts as one admitted, open Turn before a Run exists", () => {
  for (const strategy of ["chat", "plan", "execute", "goal"]) {
    const state = create(strategy);
    assert.equal(state.turn.strategy, strategy);
    assert.equal(state.turn.status, "open");
    assert.equal(state.run, null);
    assert.equal(state.nextSequence, 1);
    assert.deepEqual(state.events.map((event) => event.type), ["turn.admitted"]);
    assert.equal(state.events[0].turn.clientSubmissionId, "submission-1");
  }
});

test("normal completion requires run.completed before matching turn.completed", () => {
  let state = start(create("execute"));
  state = apply(state, "run.phase_changed", { run: baseRun, phase: "executing" });
  state = apply(state, "run.phase_changed", { run: baseRun, phase: "validating" });

  const premature = reduceCanonicalTurnRuntime(state, nextEvent(state, "turn.completed", {
    turn: baseTurn,
    runId: baseRun.runId,
    resultKind: "success",
    reason: "done",
  }));
  assert.equal(premature.disposition, "rejected");
  assert.equal(premature.reason, "run_not_completed");

  state = complete(state, "success", "validated");
  assert.equal(state.run.status, "completed");
  assert.equal(state.turn.status, "completed");
  assert.deepEqual(state.events.map((event) => event.type), [
    "turn.admitted",
    "run.started",
    "run.phase_changed",
    "run.phase_changed",
    "run.completed",
    "turn.completed",
  ]);
  assert.deepEqual(projectTurnRuntimeCompatibility(state), {
    agentStatus: "idle",
    conversationTurnStatus: "done",
    visibleTurnStatus: "success",
    isTerminal: true,
    resultKind: "success",
    runtimeOutcome: {
      status: "completed",
      reason: "validated",
      resultKind: "success",
      runId: "run-1",
      parentRunId: null,
      updatedAt: 15,
    },
  });
});

test("all non-cancel completion result kinds retain exact terminal quality", () => {
  const expected = {
    success: ["idle", "done"],
    partial: ["idle", "done"],
    blocked: ["idle", "stopped_no_action"],
    error: ["error", "error"],
  };
  for (const resultKind of Object.keys(expected)) {
    const projection = projectTurnRuntimeCompatibility(
      complete(start(create("chat")), resultKind),
    );
    assert.equal(projection.isTerminal, true);
    assert.equal(projection.resultKind, resultKind);
    assert.equal(projection.visibleTurnStatus, resultKind);
    assert.equal(projection.agentStatus, expected[resultKind][0]);
    assert.equal(projection.conversationTurnStatus, expected[resultKind][1]);
  }
});

test("Plan artifact acceptance is a nonterminal pending-review approval checkpoint", () => {
  let state = start(create("plan"), "planning");
  state = apply(state, "plan.artifact_accepted", {
    run: baseRun,
    artifact: {
      path: ".MAIN/plans/plan.md",
      digest: "sha256:plan-v1",
      revision: 1,
    },
  });

  assert.equal(state.run.status, "paused");
  assert.equal(state.run.phase, "reviewing");
  assert.equal(state.turn.status, "open");
  assert.equal(state.planReviewStatus, "pending");
  assert.deepEqual(projectTurnRuntimeCompatibility(state), {
    agentStatus: "pending_review",
    conversationTurnStatus: "awaiting_approval",
    visibleTurnStatus: "awaiting_approval",
    isTerminal: false,
    resultKind: null,
    runtimeOutcome: {
      status: "paused",
      checkpointKind: "paused",
      reason: "plan_review_required",
      pauseKind: "approval",
      runId: "run-1",
      parentRunId: null,
      updatedAt: 12,
    },
  });

  const falseCompletion = reduceCanonicalTurnRuntime(state, nextEvent(state, "run.completed", {
    run: baseRun,
    resultKind: "success",
    reason: "plan_written",
  }));
  assert.equal(falseCompletion.disposition, "rejected");
  assert.equal(falseCompletion.reason, "run_not_running");

  const bypassReview = reduceCanonicalTurnRuntime(state, nextEvent(state, "run.resumed", {
    run: baseRun,
    resolution: "approval_granted",
    phase: "executing",
  }));
  assert.equal(bypassReview.disposition, "rejected");
  assert.equal(bypassReview.reason, "plan_review_resolution_required");
});

test("Plan review resolution either returns to planning or authorizes a same-Turn child Run", () => {
  let state = start(create("plan"), "planning");
  state = apply(state, "plan.artifact_accepted", {
    run: baseRun,
    artifact: { path: ".MAIN/plans/plan.md", digest: "sha256:v1", revision: 1 },
  });
  state = apply(state, "plan.review_resolved", {
    run: baseRun,
    decision: "changes_requested",
    reason: "cover_second_goal",
  });
  assert.equal(state.planReviewStatus, "changes_requested");
  assert.equal(state.run.status, "running");
  assert.equal(state.run.phase, "planning");
  assert.equal(state.turn.status, "open");

  state = apply(state, "plan.artifact_accepted", {
    run: baseRun,
    artifact: { path: ".MAIN/plans/plan.md", digest: "sha256:v2", revision: 2 },
  });
  state = apply(state, "plan.review_resolved", {
    run: baseRun,
    decision: "approved",
    reason: "user_approved_plan",
  });
  assert.equal(state.planReviewStatus, "approved");
  assert.equal(state.run.status, "paused");
  assert.equal(state.run.pause.kind, "recoverable");
  assert.equal(state.turn.status, "open");

  state = apply(state, "run.started", {
    run: childRun,
    phase: "executing",
  });
  assert.equal(state.priorRuns.length, 1);
  assert.equal(state.priorRuns[0].identity.runId, "run-1");
  assert.equal(state.priorRuns[0].status, "paused");
  assert.equal(state.run.identity.runId, "run-2");
  assert.equal(state.run.status, "running");
  assert.equal(state.run.phase, "executing");
  assert.equal(projectTurnRuntimeCompatibility(state).isTerminal, false);
});

test("non-Plan strategies cannot claim a Plan artifact acceptance", () => {
  const state = start(create("execute"), "investigating");
  const result = reduceCanonicalTurnRuntime(state, nextEvent(state, "plan.artifact_accepted", {
    run: baseRun,
    artifact: { path: ".MAIN/plans/plan.md", digest: "sha256:x", revision: 1 },
  }));
  assert.equal(result.disposition, "rejected");
  assert.equal(result.reason, "plan_strategy_required");
  assert.equal(result.state, state);
});

test("review, approval, input, and recovery pauses require matching typed resolutions", () => {
  const fixtures = [
    ["review", "review_completed", "paused"],
    ["approval", "approval_granted", "awaiting_approval"],
    ["input", "input_supplied", "awaiting_input"],
    ["recoverable", "recovery", "paused"],
  ];

  for (const [pauseKind, resolution, visibleStatus] of fixtures) {
    let state = start(create("execute"), "executing");
    state = apply(state, "run.paused", {
      run: baseRun,
      pauseKind,
      reason: `${pauseKind}_required`,
    });
    const pausedProjection = projectTurnRuntimeCompatibility(state);
    assert.equal(pausedProjection.isTerminal, false);
    assert.equal(pausedProjection.visibleTurnStatus, visibleStatus);

    const mismatched = reduceCanonicalTurnRuntime(state, nextEvent(state, "run.resumed", {
      run: baseRun,
      resolution: resolution === "recovery" ? "input_supplied" : "recovery",
      phase: "executing",
    }));
    assert.equal(mismatched.disposition, "rejected");
    assert.equal(mismatched.reason, "resume_resolution_mismatch");

    state = apply(state, "run.resumed", { run: baseRun, resolution, phase: "executing" });
    assert.equal(state.run.status, "running");
    assert.equal(state.run.pause, null);
  }
});

test("run.aborted remains nonterminal and cancellation has one ordered event transaction", () => {
  let state = start(create("execute"), "executing");
  state = apply(state, "run.paused", {
    run: baseRun,
    pauseKind: "input",
    reason: "awaiting_user_input",
  });

  const planned = planCanonicalTurnCancellation({
    state,
    reason: "user_canceled",
    at: 50,
  });
  assert.equal(planned.disposition, "planned");
  assert.deepEqual(planned.events.map((event) => event.type), [
    "run.aborted",
    "run.completed",
    "turn.completed",
  ]);
  assert.deepEqual(planned.events.map((event) => event.sequence), [3, 4, 5]);

  let transition = reduceCanonicalTurnRuntime(state, planned.events[0]);
  assert.equal(transition.disposition, "applied");
  state = transition.state;
  assert.equal(state.run.status, "aborted");
  assert.equal(state.turn.status, "open");
  assert.equal(projectTurnRuntimeCompatibility(state).isTerminal, false);
  assert.equal(projectTurnRuntimeCompatibility(state).runtimeOutcome.checkpointKind, "aborted");

  transition = reduceCanonicalTurnRuntime(state, planned.events[1]);
  assert.equal(transition.disposition, "applied");
  state = transition.state;
  assert.equal(state.run.status, "completed");
  assert.equal(state.run.resultKind, "canceled");
  assert.equal(state.turn.status, "open");
  assert.equal(projectTurnRuntimeCompatibility(state).isTerminal, false);

  transition = reduceCanonicalTurnRuntime(state, planned.events[2]);
  assert.equal(transition.disposition, "applied");
  state = transition.state;
  const projection = projectTurnRuntimeCompatibility(state);
  assert.equal(projection.isTerminal, true);
  assert.equal(projection.resultKind, "canceled");
  assert.equal(projection.visibleTurnStatus, "canceled");

  const duplicateConclusion = reduceCanonicalTurnRuntime(state, planned.events[2]);
  assert.equal(duplicateConclusion.disposition, "idempotent");
  const conflictingConclusion = reduceCanonicalTurnRuntime(state, {
    ...planned.events[2],
    resultKind: "error",
  });
  assert.equal(conflictingConclusion.disposition, "rejected");
  assert.equal(conflictingConclusion.reason, "event_sequence_conflict");
});

test("canceled completion without abort and non-canceled completion after abort are rejected", () => {
  const running = start(create("execute"), "executing");
  const skippedAbort = reduceCanonicalTurnRuntime(running, nextEvent(running, "run.completed", {
    run: baseRun,
    resultKind: "canceled",
    reason: "user_canceled",
  }));
  assert.equal(skippedAbort.disposition, "rejected");
  assert.equal(skippedAbort.reason, "cancellation_requires_abort");

  const aborted = apply(running, "run.aborted", { run: baseRun, reason: "user_canceled" });
  const falseError = reduceCanonicalTurnRuntime(aborted, nextEvent(aborted, "run.completed", {
    run: baseRun,
    resultKind: "error",
    reason: "rewritten_after_cancel",
  }));
  assert.equal(falseError.disposition, "rejected");
  assert.equal(falseError.reason, "aborted_run_requires_canceled_result");
});

test("run identity fence rejects stale epochs, attempts, and run ids", () => {
  const state = start(create("goal"), "investigating");
  for (const staleRun of [
    { ...baseRun, sessionEpoch: "epoch-old" },
    { ...baseRun, attemptId: "attempt-old" },
    { ...baseRun, runId: "run-old" },
  ]) {
    const result = reduceCanonicalTurnRuntime(state, nextEvent(state, "run.phase_changed", {
      run: staleRun,
      phase: "executing",
    }));
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, staleRun.sessionEpoch === "epoch-old"
      ? "run_identity_invalid"
      : "run_identity_mismatch");
    assert.equal(result.state, state);
  }
});

test("sequence, duplicate, conflict, and time guards make replay deterministic", () => {
  const initial = create("chat", 100);
  const startedEvent = nextEvent(initial, "run.started", {
    run: baseRun,
    phase: "preparing",
  }, 101);
  const applied = reduceCanonicalTurnRuntime(initial, startedEvent);
  assert.equal(applied.disposition, "applied");

  const duplicate = reduceCanonicalTurnRuntime(applied.state, startedEvent);
  assert.equal(duplicate.disposition, "idempotent");
  assert.equal(duplicate.state, applied.state);

  const conflict = reduceCanonicalTurnRuntime(applied.state, {
    ...startedEvent,
    phase: "executing",
  });
  assert.equal(conflict.disposition, "rejected");
  assert.equal(conflict.reason, "event_sequence_conflict");

  const skipped = reduceCanonicalTurnRuntime(applied.state, {
    ...nextEvent(applied.state, "run.phase_changed", { run: baseRun, phase: "executing" }),
    sequence: applied.state.nextSequence + 1,
  });
  assert.equal(skipped.disposition, "rejected");
  assert.equal(skipped.reason, "invalid_event_sequence");

  const regressed = reduceCanonicalTurnRuntime(applied.state, nextEvent(
    applied.state,
    "run.phase_changed",
    { run: baseRun, phase: "executing" },
    99,
  ));
  assert.equal(regressed.disposition, "rejected");
  assert.equal(regressed.reason, "event_time_regression");
});

test("active-run guidance attaches to the existing Run while queue creates a new Turn", () => {
  const active = start(create("execute"), "executing");
  assert.deepEqual(decideTurnIngress({ mode: "guidance", activeTurn: active }), {
    kind: "attach_guidance",
    createsTurn: false,
    admission: "active_run",
    target: baseRun,
  });
  assert.deepEqual(decideTurnIngress({
    mode: "queue",
    strategy: "plan",
    activeTurn: active,
  }), {
    kind: "admit_turn",
    createsTurn: true,
    admission: "fifo",
    strategy: "plan",
  });
  assert.deepEqual(decideTurnIngress({
    mode: "submit",
    strategy: "chat",
    activeTurn: active,
  }), {
    kind: "reject",
    createsTurn: false,
    reason: "active_run_requires_explicit_ingress",
  });
});

test("guidance fails closed without a running owner and a closed Turn admits immediately", () => {
  assert.deepEqual(decideTurnIngress({ mode: "guidance", activeTurn: null }), {
    kind: "reject",
    createsTurn: false,
    reason: "active_run_required",
  });

  let paused = start(create("execute"), "executing");
  paused = apply(paused, "run.paused", {
    run: baseRun,
    pauseKind: "approval",
    reason: "permission_required",
  });
  assert.deepEqual(decideTurnIngress({ mode: "guidance", activeTurn: paused }), {
    kind: "reject",
    createsTurn: false,
    reason: "active_run_not_guidable",
  });

  const closed = complete(start(create("chat")), "partial", "partial_done");
  assert.deepEqual(decideTurnIngress({
    mode: "submit",
    strategy: "goal",
    activeTurn: closed,
  }), {
    kind: "admit_turn",
    createsTurn: true,
    admission: "immediate",
    strategy: "goal",
  });
});

test("live transaction adapter makes Plan review nonterminal and cancellation terminal", () => {
  const review = projectCanonicalRunTransaction({
    turn: baseTurn,
    run: baseRun,
    strategy: "plan",
    outcome: { status: "paused", pauseKind: "approval", reason: "plan_review_required" },
    at: 50,
    closesTurn: false,
    planArtifact: { path: ".MAIN/plans/plan.md", digest: "plan-hash", revision: 1 },
  });
  assert.equal(review.disposition, "projected");
  assert.equal(review.compatibility.agentStatus, "pending_review");
  assert.equal(review.compatibility.conversationTurnStatus, "awaiting_approval");
  assert.equal(review.compatibility.isTerminal, false);

  const canceled = projectCanonicalRunTransaction({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    outcome: { status: "aborted", reason: "user_canceled" },
    at: 60,
    closesTurn: true,
  });
  assert.equal(canceled.disposition, "projected");
  assert.deepEqual(canceled.state.events.slice(-3).map((event) => event.type), [
    "run.aborted",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(canceled.compatibility.resultKind, "canceled");
});
