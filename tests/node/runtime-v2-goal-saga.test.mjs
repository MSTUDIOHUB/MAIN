import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

function loadTsWithMocks(sourcePath, mocks, scopedCache = new Map()) {
  const normalized = path.resolve(sourcePath);
  if (scopedCache.has(normalized)) return scopedCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  scopedCache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTsWithMocks(candidate, mocks, scopedCache);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  scopedCache.set(normalized, module.exports);
  return module.exports;
}

const runtime = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
const goalRunner = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/goalRunner.ts"));
const goalCheckpointFile = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/goalCheckpointFilePort.ts"),
);
const goalState = loadTs(path.join(workspaceRoot, "src/lib/goalState.ts"));
const goalRuntime = loadTs(path.join(workspaceRoot, "src/lib/goalRuntime.ts"));

const owner = {
  workspaceKey: "/fixture",
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  goalId: "goal-a",
  goalRevision: 1,
  ownerTurnId: "goal-owner-turn",
};

function saga(overrides = {}) {
  return runtime.createRuntimeV2GoalSaga({
    owner,
    objective: {
      text: "Repair and verify the fixture",
      constraints: ["Stay inside the fixture"],
      acceptanceCriteria: ["Source fixed", "Tests pass"],
    },
    criteria: [
      { id: "criterion-source", text: "Source fixed", required: true },
      { id: "criterion-tests", text: "Tests pass", required: true },
    ],
    createdAt: 100,
    deadlineAt: 10_000,
    sliceDurationMs: 1_000,
    maxRecoveryAttempts: 2,
    ...overrides,
  });
}

function outcome(request, overrides = {}) {
  return {
    outcomeId: `outcome:${request.sliceId}`,
    sliceId: request.sliceId,
    turnId: request.turn.turnId,
    runId: request.run.runId,
    resultKind: "partial",
    reasonCode: "slice_boundary",
    reason: "Bounded slice reached a durable handoff.",
    evidence: [],
    acceptance: [],
    recoveryFingerprint: "diagnostic:fixture",
    recoverable: true,
    completedAt: request.deadlineAt,
    ...overrides,
  };
}

test("Goal saga uses ordinary finite Execute Turns and completes only from evidence receipts", () => {
  let state = saga();
  const firstDecision = runtime.decideRuntimeV2GoalSaga(state, 200);
  assert.equal(firstDecision.kind, "launch_slice");
  assert.equal(firstDecision.request.strategy, "execute");
  assert.equal(firstDecision.request.run.parentRunId, null);
  assert.deepEqual(firstDecision.request.objective.acceptanceCriteria, [
    "Source fixed",
    "Tests pass",
  ]);
  assert.deepEqual(
    runtime.runtimeV2GoalSliceExecuteAdmission(firstDecision.request),
    {
      objective: "Repair and verify the fixture",
      constraints: ["Stay inside the fixture"],
      acceptanceCriteria: [
        { id: "criterion-source", text: "Source fixed" },
        { id: "criterion-tests", text: "Tests pass" },
      ],
    },
  );
  assert.equal(firstDecision.request.deadlineAt, 10_000);

  state = runtime.recordRuntimeV2GoalSliceLaunch(state, firstDecision.request, 200);
  assert.equal(runtime.decideRuntimeV2GoalSaga(state, 250).kind, "observe_slice");
  state = runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(firstDecision.request, {
    evidence: [{
      id: "mutation-1",
      kind: "mutation",
      target: "src/main.ts",
      version: "v2",
    }],
    acceptance: [{
      criterionId: "criterion-source",
      status: "satisfied",
      evidenceIds: ["mutation-1"],
    }],
  }));
  const continueDecision = runtime.decideRuntimeV2GoalSaga(state, 1_201);
  assert.equal(continueDecision.kind, "continue_goal");
  state = runtime.continueRuntimeV2GoalSaga(
    state,
    continueDecision.fromSliceId,
    1_202,
  );

  const secondDecision = runtime.decideRuntimeV2GoalSaga(state, 1_203);
  assert.equal(secondDecision.kind, "launch_slice");
  assert.equal(secondDecision.request.ordinal, 2);
  assert.deepEqual(secondDecision.request.objective.acceptanceCriteria, ["Tests pass"]);
  state = runtime.recordRuntimeV2GoalSliceLaunch(state, secondDecision.request, 1_203);
  state = runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(secondDecision.request, {
    resultKind: "success",
    reasonCode: "objective_satisfied",
    reason: "All required acceptance receipts are present.",
    evidence: [{
      id: "validation-1",
      kind: "validation",
      target: "npm test",
      version: "exit-0",
    }],
    acceptance: [{
      criterionId: "criterion-tests",
      status: "satisfied",
      evidenceIds: ["validation-1"],
    }],
  }));
  const completeDecision = runtime.decideRuntimeV2GoalSaga(state, 2_300);
  assert.equal(completeDecision.kind, "complete_goal");
  assert.equal(completeDecision.outcome.resultKind, "success");
  state = runtime.completeRuntimeV2GoalSaga(state, completeDecision.outcome);
  assert.equal(state.status, "completed");
  assert.equal(runtime.decideRuntimeV2GoalSaga(state, 2_301).kind, "none");
  assert.equal(state.totalSlices, 2);
});

test("same structural no-progress failure remains a soft signal until a hard boundary", () => {
  let state = saga({
    criteria: [{ id: "criterion-tests", text: "Tests pass", required: true }],
  });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const launch = runtime.decideRuntimeV2GoalSaga(state, 200 + attempt);
    assert.equal(launch.kind, "launch_slice");
    state = runtime.recordRuntimeV2GoalSliceLaunch(state, launch.request, 200 + attempt);
    state = runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request, {
      outcomeId: `failure-${attempt}`,
      resultKind: "error",
      reasonCode: "execution_error",
      reason: `failure ${attempt}`,
      completedAt: 300 + attempt,
    }));
    const decision = runtime.decideRuntimeV2GoalSaga(state, 400 + attempt);
    assert.equal(decision.kind, "continue_goal");
    assert.equal(state.recovery.exhausted, false);
    state = runtime.continueRuntimeV2GoalSaga(
      state,
      decision.fromSliceId,
      400 + attempt,
    );
  }
  assert.equal(state.status, "ready");
  assert.equal("pauseReason" in state, false);
  assert.deepEqual(
    new Set(state.recentSlices.map((receipt) => receipt.request.sliceId)).size,
    4,
  );
});

test("new structured evidence resets recovery and iteration count is never terminal authority", () => {
  let state = saga({
    criteria: [{ id: "criterion-tests", text: "Tests pass", required: true }],
    nextSliceOrdinal: undefined,
  });
  let launch = runtime.decideRuntimeV2GoalSaga(state, 200);
  state = runtime.recordRuntimeV2GoalSliceLaunch(state, launch.request, 200);
  state = runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request, {
    outcomeId: "no-progress-1",
    completedAt: 300,
  }));
  assert.equal(state.recovery.count, 1);
  let next = runtime.decideRuntimeV2GoalSaga(state, 301);
  state = runtime.continueRuntimeV2GoalSaga(state, next.fromSliceId, 301);

  launch = runtime.decideRuntimeV2GoalSaga(state, 302);
  state = runtime.recordRuntimeV2GoalSliceLaunch(state, launch.request, 302);
  state = runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request, {
    outcomeId: "progress-2",
    evidence: [{
      id: "source-version-2",
      kind: "source",
      target: "src/main.ts",
      version: "sha256-v2",
    }],
    completedAt: 400,
  }));
  assert.deepEqual(state.recovery, {
    fingerprint: null,
    count: 0,
    exhausted: false,
  });
  assert.equal(runtime.decideRuntimeV2GoalSaga(state, 401).kind, "continue_goal");
});

test("hard boundaries are explicit terminal outcomes and never permanent pause", () => {
  const cases = [
    ["cancel_requested", "canceled"],
    ["authority_lost", "blocked"],
  ];
  for (const [kind, expected] of cases) {
    const state = runtime.recordRuntimeV2GoalBoundary(saga(), {
      kind,
      reason: `boundary:${kind}`,
      at: 500,
    });
    const decision = runtime.decideRuntimeV2GoalSaga(state, 501);
    assert.equal(decision.kind, "complete_goal");
    assert.equal(decision.outcome.resultKind, expected);
  }
  const deadline = runtime.decideRuntimeV2GoalSaga(saga(), 10_000);
  assert.equal(deadline.kind, "complete_goal");
  assert.equal(deadline.outcome.resultKind, "partial");
  assert.equal(deadline.outcome.reasonCode, "deadline_exceeded");
});

test("resource authority stops the next slice but never overwrites accepted success", () => {
  let state = saga({
    criteria: [{ id: "criterion-tests", text: "Tests pass", required: true }],
    tokenBudget: 5,
  });
  let launch = runtime.decideRuntimeV2GoalSaga(state, 200);
  state = runtime.recordRuntimeV2GoalSliceLaunch(state, launch.request, 200);
  state = runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request, {
    outcomeId: "budget-partial",
    usage: { tokensUsed: 5, toolCalls: 1 },
    completedAt: 300,
  }));
  let decision = runtime.decideRuntimeV2GoalSaga(state, 301);
  assert.equal(decision.kind, "complete_goal");
  assert.equal(decision.outcome.reasonCode, "resource_budget_exhausted");
  assert.equal(decision.outcome.resultKind, "partial");

  state = saga({
    criteria: [{ id: "criterion-tests", text: "Tests pass", required: true }],
    tokenBudget: 5,
  });
  launch = runtime.decideRuntimeV2GoalSaga(state, 200);
  state = runtime.recordRuntimeV2GoalSliceLaunch(state, launch.request, 200);
  state = runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request, {
    outcomeId: "budget-success",
    resultKind: "success",
    reasonCode: "objective_satisfied",
    evidence: [{
      id: "validation-budget",
      kind: "validation",
      target: "npm test",
      version: "exit-0",
    }],
    acceptance: [{
      criterionId: "criterion-tests",
      status: "satisfied",
      evidenceIds: ["validation-budget"],
    }],
    usage: { tokensUsed: 5, toolCalls: 1 },
    completedAt: 300,
  }));
  decision = runtime.decideRuntimeV2GoalSaga(state, 301);
  assert.equal(decision.outcome.resultKind, "success");
});

test("late or conflicting slice outcomes cannot mutate the current owner", () => {
  let state = saga();
  const launch = runtime.decideRuntimeV2GoalSaga(state, 200);
  state = runtime.recordRuntimeV2GoalSliceLaunch(state, launch.request, 200);
  assert.throws(
    () => runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request, {
      turnId: "stale-turn",
    })),
    /STALE_SLICE_OUTCOME/,
  );
  state = runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request));
  assert.equal(
    runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request)),
    state,
  );
  assert.throws(
    () => runtime.recordRuntimeV2GoalSliceOutcome(state, outcome(launch.request, {
      outcomeId: "conflicting-outcome",
    })),
    /DUPLICATE_CONFLICT/,
  );
});

function inMemoryCheckpointPort(options = {}) {
  let checkpoint = null;
  let launchCommitSeen = false;
  return {
    get checkpoint() { return checkpoint; },
    get launchCommitSeen() { return launchCommitSeen; },
    port: {
      async load({ owner: requestedOwner }) {
        return checkpoint && requestedOwner.goalId === checkpoint.owner.goalId
          ? checkpoint
          : null;
      },
      async commit({ owner: requestedOwner, expectedRevision, state }) {
        if (options.conflictOnActive && state.status === "slice_running") {
          return { disposition: "conflict", checkpoint: null };
        }
        const currentRevision = checkpoint?.revision || 0;
        if (currentRevision !== expectedRevision) {
          return { disposition: "conflict", checkpoint };
        }
        checkpoint = {
          schemaVersion: goalRunner.RUNTIME_V2_GOAL_SAGA_CHECKPOINT_SCHEMA_VERSION,
          revision: currentRevision + 1,
          owner: requestedOwner,
          state,
        };
        if (state.status === "slice_running") launchCommitSeen = true;
        return { disposition: "committed", checkpoint };
      },
    },
  };
}

test("Goal runner commits activeSlice before launch and cold recovery reuses one slice identity", async () => {
  const memory = inMemoryCheckpointPort();
  const launches = [];
  let observation = { status: "running" };
  const ports = {
    checkpoint: memory.port,
    slice: {
      async launch({ request }) {
        assert.equal(memory.launchCommitSeen, true);
        launches.push(request.sliceId);
      },
      async observe() { return observation; },
    },
  };
  const signal = new AbortController().signal;
  const initialState = saga();
  let result = await goalRunner.driveRuntimeV2GoalSagaOnce({
    ports,
    owner,
    initialState,
    signal,
    now: () => 200,
  });
  assert.equal(result.disposition, "launched");
  assert.equal(memory.checkpoint.revision, 2);

  result = await goalRunner.driveRuntimeV2GoalSagaOnce({
    ports,
    owner,
    signal,
    now: () => 250,
  });
  assert.equal(result.disposition, "running");

  observation = {
    status: "completed",
    outcome: outcome(result.request, {
      resultKind: "success",
      reasonCode: "objective_satisfied",
      evidence: [
        { id: "E1", kind: "mutation", target: "src/main.ts", version: "v2" },
        { id: "E2", kind: "validation", target: "npm test", version: "exit-0" },
      ],
      acceptance: [
        { criterionId: "criterion-source", status: "satisfied", evidenceIds: ["E1"] },
        { criterionId: "criterion-tests", status: "satisfied", evidenceIds: ["E2"] },
      ],
    }),
  };
  result = await goalRunner.driveRuntimeV2GoalSagaOnce({
    ports,
    owner,
    signal,
    now: () => 1_200,
  });
  assert.equal(result.disposition, "slice_settled");
  result = await goalRunner.driveRuntimeV2GoalSagaOnce({
    ports,
    owner,
    signal,
    now: () => 1_201,
  });
  assert.equal(result.disposition, "completed");
  assert.deepEqual(launches, ["goal-a:v1:slice:1"]);
});

test("CAS conflict prevents launch side effects", async () => {
  const memory = inMemoryCheckpointPort({ conflictOnActive: true });
  let launches = 0;
  const result = await goalRunner.driveRuntimeV2GoalSagaOnce({
    ports: {
      checkpoint: memory.port,
      slice: {
        async launch() { launches += 1; },
        async observe() { return { status: "running" }; },
      },
    },
    owner,
    initialState: saga(),
    signal: new AbortController().signal,
    now: () => 200,
  });
  assert.equal(result.disposition, "superseded");
  assert.equal(launches, 0);
});

test("cancel before launch concludes canonically without starting a slice", async () => {
  const memory = inMemoryCheckpointPort();
  let launches = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await goalRunner.driveRuntimeV2GoalSagaOnce({
    ports: {
      checkpoint: memory.port,
      slice: {
        async launch() { launches += 1; },
        async observe() { return { status: "running" }; },
      },
    },
    owner,
    initialState: saga(),
    signal: controller.signal,
    now: () => 200,
  });
  assert.equal(result.disposition, "completed");
  assert.equal(result.checkpoint.state.terminal.resultKind, "canceled");
  assert.equal(launches, 0);
});

test("uncertain launch resumes through the same idempotent slice identity", async () => {
  const memory = inMemoryCheckpointPort();
  const launches = [];
  let failFirst = true;
  const ports = {
    checkpoint: memory.port,
    slice: {
      async launch({ request }) {
        launches.push(request.sliceId);
        if (failFirst) {
          failFirst = false;
          throw new Error("transport closed after dispatch");
        }
      },
      async observe() { return { status: "missing" }; },
    },
  };
  const signal = new AbortController().signal;
  let result = await goalRunner.driveRuntimeV2GoalSagaOnce({
    ports,
    owner,
    initialState: saga(),
    signal,
    now: () => 200,
  });
  assert.equal(result.disposition, "launch_uncertain");
  result = await goalRunner.driveRuntimeV2GoalSagaOnce({
    ports,
    owner,
    signal,
    now: () => 201,
  });
  assert.equal(result.disposition, "resumed_launch");
  assert.equal(new Set(launches).size, 1);
  assert.deepEqual(launches, [
    "goal-a:v1:slice:1",
    "goal-a:v1:slice:1",
  ]);
});

test("Goal saga files are isolated by exact continuation owner", async () => {
  const replacementOwner = {
    ...owner,
    ownerTurnId: "goal-owner-turn-2",
  };
  const paths = new Map();
  const io = {
    async read(filePath) {
      return paths.get(filePath) || null;
    },
    async create(filePath, content) {
      if (paths.has(filePath)) throw new Error("already exists");
      paths.set(filePath, content);
    },
    async replace(filePath, content) {
      if (!paths.has(filePath)) throw new Error("missing");
      paths.set(filePath, content);
    },
  };
  const port = goalCheckpointFile.createRuntimeV2GoalCheckpointFilePort({
    workspace: "/fixture",
    io,
    isDeleted: () => false,
  });
  const first = saga();
  const second = runtime.createRuntimeV2GoalSaga({
    owner: replacementOwner,
    objective: first.objective,
    criteria: first.criteria,
    createdAt: first.createdAt,
    deadlineAt: first.deadlineAt,
  });
  assert.equal((await port.commit({
    owner,
    expectedRevision: 0,
    state: first,
  })).disposition, "committed");
  assert.equal((await port.commit({
    owner: replacementOwner,
    expectedRevision: 0,
    state: second,
  })).disposition, "committed");
  assert.equal(paths.size, 2);
  assert.notEqual(
    goalCheckpointFile.resolveRuntimeV2GoalSagaFilePath(owner),
    goalCheckpointFile.resolveRuntimeV2GoalSagaFilePath(replacementOwner),
  );
});

test("legacy Goal state is read once into v2 authority and is never the write schema", () => {
  const goal = goalState.createGoalDefinition({
    objective: "Repair the fixture",
    definitionOfDone: ["The fixture passes"],
    sessionKey: "session-a",
    ownerTurnId: "goal-owner-turn",
  });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  const legacyRuntime = goalRuntime.buildGoalRuntimeSnapshot({
    goal,
    progress,
    phase: "execute",
  });
  const state = goalRunner.createRuntimeV2GoalSagaFromBoundary({
    runtime: legacyRuntime,
    admission: {
      workspaceKey: "/fixture",
      sessionKey: "session-a",
      sessionEpoch: "epoch-a",
      ownerTurnId: "goal-owner-turn",
      authority: { kind: "creation", authorized: true },
    },
    now: goal.createdAt + 1,
  });
  assert.equal(state.schemaVersion, runtime.RUNTIME_V2_GOAL_SAGA_SCHEMA_VERSION);
  assert.equal(state.owner.goalId, goal.id);
  assert.equal(state.boundary, null);

  const checkpoint = {
    schemaVersion: goalRunner.RUNTIME_V2_GOAL_SAGA_CHECKPOINT_SCHEMA_VERSION,
    revision: 1,
    owner: state.owner,
    state,
  };
  const serialized = goalRunner.serializeRuntimeV2GoalSagaCheckpoint(checkpoint);
  assert.match(serialized, /runtime-v2-goal-saga-checkpoint\.v1/);
  assert.doesNotMatch(serialized, /"schemaVersion": 3/);
  assert.deepEqual(
    goalRunner.deserializeRuntimeV2GoalSagaCheckpoint(serialized, state.owner),
    checkpoint,
  );
  assert.equal(
    goalRunner.deserializeRuntimeV2GoalSagaCheckpoint(serialized, {
      ...state.owner,
      sessionEpoch: "replacement-epoch",
    }),
    null,
  );
  const corrupt = JSON.parse(serialized);
  corrupt.state.status = "slice_running";
  corrupt.state.activeSlice = null;
  assert.equal(
    goalRunner.normalizeRuntimeV2GoalSagaCheckpoint(corrupt, state.owner),
    null,
  );
});

test("a validated continuation migrates legacy blocked state into a fresh v2 slice", () => {
  const goal = goalState.createGoalDefinition({
    objective: "Repair the fixture",
    definitionOfDone: ["The fixture passes"],
    sessionKey: "session-a",
    ownerTurnId: "goal-owner-turn",
  });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  const legacyRuntime = {
    ...goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "re_plan" }),
    status: "blocked",
    goal: { ...goal, status: "blocked" },
  };
  const state = goalRunner.createRuntimeV2GoalSagaFromBoundary({
    runtime: legacyRuntime,
    admission: {
      workspaceKey: "/fixture",
      sessionKey: "session-a",
      sessionEpoch: "epoch-a",
      ownerTurnId: "goal-owner-turn",
      authority: {
        kind: "legacy_continuation",
        authorization: {
          kind: "goal_continuation_authorization",
          source: "goal_manual_resume",
          workspaceKey: "/fixture",
          sessionKey: "session-a",
          goalId: goal.id,
          goalRevision: goal.revision,
          ownerTurnId: "goal-owner-turn",
        },
      },
    },
    now: goal.createdAt + 1,
  });
  assert.equal(state.status, "ready");
  assert.equal(state.terminal, null);
  assert.equal(runtime.decideRuntimeV2GoalSaga(state, goal.createdAt + 2).kind, "launch_slice");
});

test("production Goal supervisor runs a finite Execute slice and closes one outer Turn", async () => {
  const goal = goalState.createGoalDefinition({
    objective: "Repair and verify the fixture",
    definitionOfDone: ["Source fixed", "Tests pass"],
    sessionKey: "session-a",
    ownerTurnId: "goal-owner-turn",
  });
  const progress = goalState.createGoalProgress(
    goal.id,
    ".MAIN/goals/progress.md",
  );
  const legacyRuntime = goalRuntime.buildGoalRuntimeSnapshot({
    goal,
    progress,
    phase: "execute",
  });
  const sagaMemory = inMemoryCheckpointPort();
  let launchedRequest = null;
  const slice = {
    async launch({ request }) {
      launchedRequest = request;
    },
    async observe({ request }) {
      const evidence = [
        { id: "mutation-production", kind: "mutation", target: "src/main.ts", version: "sha-v2" },
        { id: "validation-production", kind: "validation", target: "npm test", version: "exit-0" },
      ];
      return {
        status: "completed",
        outcome: {
          outcomeId: `outcome:${request.sliceId}`,
          sliceId: request.sliceId,
          turnId: request.turn.turnId,
          runId: request.run.runId,
          resultKind: "success",
          reasonCode: "objective_satisfied",
          reason: "The source change and validation are durably evidenced.",
          evidence,
          acceptance: request.criteria.map((criterion, index) => ({
            criterionId: criterion.id,
            status: "satisfied",
            evidenceIds: [evidence[index % evidence.length].id],
          })),
          recoveryFingerprint: "goal-production-success",
          recoverable: false,
          completedAt: goal.createdAt + 10,
        },
      };
    },
    async waitForChange() {},
  };

  let taskId = 0;
  let state = {
    conversationTurns: [{
      id: "goal-owner-turn",
      clientSubmissionId: "goal-submission",
      runtimeEngineVersion: "v2",
      userPrompt: goal.objective,
      status: "executing",
      blockIds: [],
    }],
    activeGoal: goal,
    goalProgress: progress,
    goalStatus: "active",
    goalRuntime: legacyRuntime,
    config: { language: "zh" },
    planLifecycle: {
      sessionKey: "session-a",
      sessionEpoch: "epoch-a",
    },
    runtimeV2Checkpoints: {},
    runtimeEvents: [],
    taskFlow: [],
    harnessRunMarker: {
      sessionKey: "session-a",
      turnId: "goal-owner-turn",
      runId: "goal-run-a",
      runtimeIntent: "goal",
      status: "running",
    },
    _nextTaskId() {
      taskId += 1;
      return taskId;
    },
  };
  const get = () => state;
  const set = (patchOrUpdater) => {
    const patch = typeof patchOrUpdater === "function"
      ? patchOrUpdater(state)
      : patchOrUpdater;
    state = { ...state, ...(patch || {}) };
  };
  const checkpointPort = {
    getRuntimeV2Checkpoint(current, requestedOwner) {
      return current.runtimeV2Checkpoints?.[requestedOwner.turnId] || null;
    },
    createRuntimeV2CheckpointPort() {
      return {
        async load({ owner: requestedOwner }) {
          return state.runtimeV2Checkpoints?.[requestedOwner.turnId] || null;
        },
        async append(input) {
          const current = state.runtimeV2Checkpoints?.[input.owner.turnId] || null;
          const result = runtime.appendRuntimeV2Checkpoint({
            checkpoint: current,
            owner: input.owner,
            expectedRevision: input.expectedRevision,
            event: input.event,
          });
          if (result.checkpoint) {
            state = {
              ...state,
              runtimeV2Checkpoints: {
                ...state.runtimeV2Checkpoints,
                [input.owner.turnId]: result.checkpoint,
              },
            };
          }
          return result;
        },
      };
    },
  };
  const mocks = new Map([
    ["../../lib/runtime-v2", runtime],
    ["./checkpointPort", checkpointPort],
    ["./projectionPort", {
      createRuntimeV2ProjectionPort: () => ({ async publish() {} }),
    }],
    ["./goalCheckpointFilePort", {
      createRuntimeV2GoalCheckpointFilePort() {
        throw new Error("test must use the injected saga checkpoint");
      },
    }],
    ["./goalSliceProductionPort", {
      createRuntimeV2GoalProductionSlicePort() {
        throw new Error("test must use the injected Execute slice");
      },
    }],
  ]);
  const production = loadTsWithMocks(
    path.join(workspaceRoot, "src/store/runtimeV2/goalProductionRunner.ts"),
    mocks,
  );
  const settlement = await production.runSubmitRuntimeV2Goal({
    get,
    set,
    context: {
      turnId: "goal-owner-turn",
      uiDisplayTurnId: "goal-owner-turn",
      runWorkspace: "/fixture",
      runSessionKey: "session-a",
      runSessionId: 1,
      runScopeKey: "/fixture",
      phaseLanguage: "zh",
      effectiveRunIntent: "goal",
      runtimeRunIntent: "goal",
      goalCreationAuthorization: {
        kind: "goal_creation_authorization",
        intent: "goal",
        source: "visible_goal_composer_capsule",
      },
      abortCtrl: new AbortController(),
      timerInterval: undefined,
      harnessRunId: "goal-run-a",
      turnInputContextSignals: { subagentPreference: "forbidden" },
    },
    goalCheckpoint: sagaMemory.port,
    goalSlice: slice,
    now: () => goal.createdAt + 1,
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    buildSessionRuntimeSnapshot: (state) => state,
    publishOwnerScopedRuntimeProjection: () => ({
      published: true,
      disposition: "published",
    }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: () => undefined,
  });

  assert.ok(launchedRequest);
  assert.equal(launchedRequest.strategy, "execute");
  assert.equal(settlement.outcome.resultKind, "success");
  assert.equal(state.goalStatus, "completed");
  assert.equal(sagaMemory.checkpoint.state.totalSlices, 1);
  assert.equal(
    state.runtimeV2Checkpoints["goal-owner-turn"].aggregate.events.filter(
      (event) => event.type === "turn.completed",
    ).length,
    1,
  );
});

test("Goal v2 source boundary excludes legacy executors, Store/UI and prose lifecycle rules", () => {
  const core = fs.readFileSync(
    path.join(workspaceRoot, "src/lib/runtime-v2/goalSaga.ts"),
    "utf8",
  );
  const adapter = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/goalRunner.ts"),
    "utf8",
  );
  const production = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/goalProductionRunner.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    core,
    /from\s+["'](?:react|zustand|@tauri-apps\/|\.\.\/store\/|\.\.\/orchestrator|\.\/goalEngine)/,
  );
  assert.doesNotMatch(
    adapter,
    /goalEngine|WorkflowEngine|AgentOrchestrator|useAppStore|executeRunner|planRunner/,
  );
  assert.doesNotMatch(
    production,
    /goalEngine|WorkflowEngine|AgentOrchestrator|useAppStore/,
  );
  assert.doesNotMatch(core, /\b(?:Qwen|OMLX|Ollama|LM\s*Studio|OpenAI|Anthropic)\b/i);
  assert.doesNotMatch(core, /visibleText\.(?:includes|match|search)|RegExp\([^)]*visibleText/);
  assert.doesNotMatch(core, /maxIterations|iteration_limit|status:\s*["']paused["']/);
  assert.match(adapter, /RuntimeV2GoalSlicePort/);
  assert.match(adapter, /expectedRevision/);
});
