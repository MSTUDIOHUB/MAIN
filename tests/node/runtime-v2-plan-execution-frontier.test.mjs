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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
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
  cache.set(normalized, module.exports);
  return module.exports;
}

const runtime = loadTs(
  path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
);
const adapter = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/workPlanAdapter.ts"),
);
const providerContext = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/executionProviderContext.ts"),
);
const workspaceMutationTools = loadTs(
  path.join(workspaceRoot, "src/lib/workspaceMutationTools.ts"),
);

const turn = {
  workspaceKey: "/fixture",
  sessionKey: "session-plan-frontier",
  sessionEpoch: "epoch-plan-frontier",
  clientSubmissionId: "submission-plan-frontier",
  turnId: "turn-plan-frontier",
};

const run = {
  sessionKey: turn.sessionKey,
  sessionEpoch: turn.sessionEpoch,
  turnId: turn.turnId,
  runId: "run-plan-frontier",
  parentRunId: null,
  attemptId: "attempt-plan-frontier",
};

let eventCounter = 0;
function runtimeEvent(state, type, fields = {}) {
  return {
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state ? state.nextSequence : 0,
    eventId: `plan-frontier-event-${++eventCounter}`,
    at: state ? state.updatedAt + 1 : 1,
    type,
    ...fields,
  };
}

function applyEvent(state, type, fields = {}) {
  return runtime.transition(state, runtimeEvent(state, type, fields));
}

function sealSnakePlan(steps, validations = [{
  stepIndexes: steps.map((_, index) => index),
  kind: "finite_command",
  command: "python3 -m unittest -v",
  cwd: ".",
  expectedOutcome: "All approved snake tests pass.",
  required: true,
}]) {
  return runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Implement the approved Python snake game in dependency order.",
      summary: "Implement the game, then its tests, then its documentation.",
      findings: [],
      steps,
      validations,
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: steps.flatMap((step, index) =>
      step.operation === "modify"
        ? [{
            id: `E${index + 1}`,
            target: step.targets[0],
            version: `reviewed-${index + 1}`,
            statement: `Reviewed ${step.targets[0]}.`,
          }]
        : []
    ),
    id: `WP-snake-frontier-${steps.length}`,
    revision: 1,
    createdAt: 10,
  });
}

function approvedAggregate(plan) {
  let state = applyEvent(null, "turn.admitted", {
    turn,
    strategy: "plan",
    objective: plan.draft.objective,
    constraints: [],
    acceptanceCriteria: [],
  });
  state = applyEvent(state, "run.started", {
    run,
    phase: "planning",
  });
  const pendingReference = adapter.toRuntimeV2WorkPlanReference(
    plan,
    "pending_review",
  );
  const reviewCommit = adapter.createRuntimeV2PlanReviewCommit({
    plan,
    turn,
    run,
    requestId: "review-plan-frontier",
    createdAt: 20,
  });
  state = applyEvent(state, "work_plan.sealed", {
    run,
    workPlan: pendingReference,
    sealedPlan: plan,
    reviewCommit,
  });
  return applyEvent(state, "work_plan.approved", {
    run,
    workPlan: { ...pendingReference, status: "approved" },
  });
}

function commitMutation(
  state,
  key,
  target,
  version = `${key}-version`,
  toolOverride = "",
) {
  const operation = state.sealedWorkPlan?.draft.steps.find((step) =>
    step.targets.includes(target) &&
    !runtime.deriveRuntimeV2PlanExecutionFrontier(state)
      ?.completedStepIndexes.includes(
        state.sealedWorkPlan.draft.steps.indexOf(step),
      )
  )?.operation;
  const toolName = toolOverride || (operation === "modify"
    ? "replace_in_file"
    : operation === "delete"
      ? "delete_workspace_path"
      : "write_file");
  const argumentsForTool = toolName === "replace_in_file"
    ? { path: target, old_content: "before", new_content: "after" }
    : toolName === "delete_workspace_path"
      ? { path: target }
      : { path: target, content: `# ${key}` };
  const command = {
    idempotencyKey: key,
    kind: "execute_tool",
    run,
    phase: state.phase,
    payload: {
      actionFingerprint: `${toolName}:${key}`,
      attempt: 1,
      toolCallId: `${key}-call`,
      toolName,
      arguments: argumentsForTool,
    },
  };
  state = applyEvent(state, "command.scheduled", { run, command });
  return applyEvent(state, "tool.completed", {
    run,
    idempotencyKey: key,
    status: "succeeded",
    receiptOrigin: "executed",
    evidence: [{
      id: `${key}-mutation-evidence`,
      kind: "mutation",
      target,
      version,
    }],
    presentation: { toolName, target },
  });
}

function completePlanValidation(state, plan, index, passed) {
  const validation = plan.draft.validations[index];
  const authority = runtime.runtimeV2PlanValidationAuthority({
    plan,
    validationIndex: index,
  });
  const key = `validation-${index}-${state.nextSequence}`;
  const command = {
    idempotencyKey: key,
    kind: "execute_validation",
    run,
    phase: state.phase,
    payload: {
      toolCallId: `${key}-call`,
      toolName: "run_command",
      arguments: { command: validation.command, cwd: validation.cwd },
      validationAuthority: authority,
    },
  };
  state = applyEvent(state, "command.scheduled", { run, command });
  const boundary = runtime.deriveRuntimeV2ValidationBoundary(
    state,
    authority.targetPaths,
  );
  return applyEvent(state, "validation.completed", {
    run,
    idempotencyKey: key,
    passed,
    authority,
    mutationBoundarySequence: boundary.mutationBoundarySequence,
    validatedMutationVersions: boundary.validatedMutationVersions,
    failureKind: passed ? undefined : "assertion_failed",
    evidence: [{
      id: `${key}-evidence`,
      kind: "validation",
      target: validation.command,
      version: passed ? "passed" : "failed",
    }],
    presentation: {
      toolName: "run_command",
      target: validation.command,
      message: passed ? "passed" : "test_snake.py:20: assertion failed",
    },
  });
}

function preferredValidation(state) {
  const checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: state.nextSequence,
    aggregate: state,
    updatedAt: state.updatedAt,
  });
  return providerContext.preferredFiniteValidationCommand({
    get: () => ({
      runtimeV2Checkpoints: { [turn.turnId]: checkpoint },
    }),
    context: { turnId: turn.turnId },
  });
}

function snakeSteps() {
  return [{
    title: "Implement snake.py",
    operation: "create",
    targets: ["snake.py"],
    basis: [],
    change: "Implement core game logic and the standard-library GUI.",
    expectedOutcome: "The snake game is playable.",
    dependsOn: [],
  }, {
    title: "Implement test_snake.py",
    operation: "create",
    targets: ["test_snake.py"],
    basis: [],
    change: "Add unit tests for the implemented game logic.",
    expectedOutcome: "Core game logic has automated coverage.",
    dependsOn: [0],
  }, {
    title: "Document the game",
    operation: "create",
    targets: ["README.md"],
    basis: [],
    change: "Document installation, launch, controls, and tests.",
    expectedOutcome: "The approved game is documented accurately.",
    dependsOn: [1],
  }];
}

function stepStatusProjection(frontier) {
  return frontier.steps.map((step) => ({
    stepIndex: step.stepIndex,
    status: step.status,
    completionSequence: step.completionSequence,
    unsatisfiedDependencyIndexes: step.unsatisfiedDependencyIndexes,
  }));
}

test("approved WorkPlan derives one dependency-ordered mutation frontier", () => {
  const plan = sealSnakePlan(snakeSteps());
  let state = approvedAggregate(plan);

  let frontier = runtime.deriveRuntimeV2PlanExecutionFrontier(state);
  assert.deepEqual(stepStatusProjection(frontier), [{
    stepIndex: 0,
    status: "ready",
    completionSequence: null,
    unsatisfiedDependencyIndexes: [],
  }, {
    stepIndex: 1,
    status: "blocked",
    completionSequence: null,
    unsatisfiedDependencyIndexes: [0],
  }, {
    stepIndex: 2,
    status: "blocked",
    completionSequence: null,
    unsatisfiedDependencyIndexes: [1],
  }]);
  assert.deepEqual(frontier.completedStepIndexes, []);
  assert.deepEqual(frontier.readyStepIndexes, [0]);
  assert.deepEqual(frontier.blockedStepIndexes, [1, 2]);
  assert.deepEqual(frontier.readyMutationTargets, ["snake.py"]);
  assert.equal(frontier.allExecutableStepsCompleted, false);
  assert.equal(frontier.validationReady, false);

  state = commitMutation(state, "write-snake", "snake.py");
  frontier = runtime.deriveRuntimeV2PlanExecutionFrontier(state);
  assert.deepEqual(frontier.completedStepIndexes, [0]);
  assert.deepEqual(frontier.readyStepIndexes, [1]);
  assert.deepEqual(frontier.blockedStepIndexes, [2]);
  assert.deepEqual(frontier.readyMutationTargets, ["test_snake.py"]);
  assert.equal(frontier.steps[0].completionSequence, state.events.at(-1).sequence);
  assert.equal(frontier.validationReady, false);

  state = commitMutation(state, "write-tests", "test_snake.py");
  frontier = runtime.deriveRuntimeV2PlanExecutionFrontier(state);
  assert.deepEqual(frontier.completedStepIndexes, [0, 1]);
  assert.deepEqual(frontier.readyStepIndexes, [2]);
  assert.deepEqual(frontier.blockedStepIndexes, []);
  assert.deepEqual(frontier.readyMutationTargets, ["README.md"]);
  assert.equal(frontier.validationReady, false);

  state = commitMutation(state, "write-readme", "README.md");
  frontier = runtime.deriveRuntimeV2PlanExecutionFrontier(state);
  assert.deepEqual(frontier.completedStepIndexes, [0, 1, 2]);
  assert.deepEqual(frontier.readyStepIndexes, []);
  assert.deepEqual(frontier.blockedStepIndexes, []);
  assert.deepEqual(frontier.readyMutationTargets, []);
  assert.equal(frontier.allExecutableStepsCompleted, true);
  assert.equal(frontier.validationReady, true);
});

test("approved mutation and validation scopes reject work beyond the current frontier", () => {
  const plan = sealSnakePlan(snakeSteps());
  let state = approvedAggregate(plan);

  const mutationScope = (target) => runtime.resolveRuntimeV2PlanMutationScope({
    plan,
    aggregate: state,
    requestedTargets: [target],
  });
  const validationScope = () => runtime.resolveRuntimeV2PlanValidationScope({
    plan,
    aggregate: state,
    toolName: "run_command",
    args: { command: "python3 -m unittest -v", cwd: "." },
  });

  assert.deepEqual(mutationScope("snake.py").matchingReadyStepIndexes, [0]);
  assert.equal(mutationScope("snake.py").allowed, true);
  assert.deepEqual(mutationScope("test_snake.py").unexpectedTargets, []);
  assert.deepEqual(mutationScope("test_snake.py").blockedTargets, ["test_snake.py"]);
  assert.equal(mutationScope("test_snake.py").allowed, false);
  assert.deepEqual(mutationScope("README.md").blockedTargets, ["README.md"]);
  assert.equal(mutationScope("README.md").allowed, false);
  assert.equal(validationScope().allowed, false);

  state = commitMutation(state, "scope-write-snake", "snake.py");
  assert.deepEqual(mutationScope("test_snake.py").matchingReadyStepIndexes, [1]);
  assert.equal(mutationScope("test_snake.py").allowed, true);
  assert.deepEqual(mutationScope("README.md").blockedTargets, ["README.md"]);
  assert.equal(mutationScope("README.md").allowed, false);
  assert.equal(validationScope().allowed, false);

  state = commitMutation(state, "scope-write-tests", "test_snake.py");
  assert.deepEqual(mutationScope("README.md").matchingReadyStepIndexes, [2]);
  assert.equal(mutationScope("README.md").allowed, true);
  assert.equal(validationScope().allowed, false);

  state = commitMutation(state, "scope-write-readme", "README.md");
  assert.equal(validationScope().allowed, true);
  assert.deepEqual(validationScope().matchingValidationIndexes, [0]);
});

test("one mutation receipt can complete only one ready step when targets repeat", () => {
  const repeatedTargetSteps = [{
    title: "Refactor snake state",
    operation: "modify",
    targets: ["snake.py"],
    basis: ["E1"],
    change: "Refactor the reviewed state owner.",
    expectedOutcome: "The core state owner is separated from the GUI.",
    dependsOn: [],
  }, {
    title: "Wire snake controls",
    operation: "modify",
    targets: ["snake.py"],
    basis: ["E2"],
    change: "Wire controls after the state refactor is committed.",
    expectedOutcome: "Controls use the refactored state owner.",
    dependsOn: [0],
  }];
  const plan = sealSnakePlan(repeatedTargetSteps);
  let state = approvedAggregate(plan);

  assert.deepEqual(
    runtime.deriveRuntimeV2PlanExecutionFrontier(state).readyStepIndexes,
    [0],
  );
  state = commitMutation(state, "first-snake-receipt", "snake.py", "snake-v2");
  let frontier = runtime.deriveRuntimeV2PlanExecutionFrontier(state);
  assert.deepEqual(frontier.completedStepIndexes, [0]);
  assert.deepEqual(frontier.readyStepIndexes, [1]);
  assert.equal(frontier.steps[1].completionSequence, null);
  assert.equal(frontier.validationReady, false);
  assert.deepEqual(runtime.resolveRuntimeV2PlanMutationScope({
    plan,
    aggregate: state,
    requestedTargets: ["snake.py"],
  }).matchingReadyStepIndexes, [1]);

  state = commitMutation(state, "second-snake-receipt", "snake.py", "snake-v3");
  frontier = runtime.deriveRuntimeV2PlanExecutionFrontier(state);
  assert.deepEqual(frontier.completedStepIndexes, [0, 1]);
  assert.deepEqual(frontier.readyStepIndexes, []);
  assert.notEqual(
    frontier.steps[0].completionSequence,
    frontier.steps[1].completionSequence,
  );
  assert.equal(frontier.validationReady, true);
});

test("required Plan validators advance in order and a failed validator opens bounded correction", () => {
  const steps = snakeSteps();
  const plan = sealSnakePlan(steps, [{
    stepIndexes: [0, 1, 2],
    kind: "finite_command",
    command: "python3 -m compileall -q .",
    cwd: ".",
    expectedOutcome: "Every Python file compiles.",
    required: true,
  }, {
    stepIndexes: [0, 1, 2],
    kind: "finite_command",
    command: "python3 -m unittest -v",
    cwd: ".",
    expectedOutcome: "All Snake acceptance tests pass.",
    required: true,
  }]);
  let state = approvedAggregate(plan);
  state = commitMutation(state, "multi-write-snake", "snake.py");
  state = commitMutation(state, "multi-write-tests", "test_snake.py");
  state = commitMutation(state, "multi-write-readme", "README.md");

  assert.equal(preferredValidation(state), "python3 -m compileall -q .");
  state = completePlanValidation(state, plan, 0, true);
  assert.deepEqual(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state)
      .missingRequiredValidationIndexes,
    [1],
  );
  assert.equal(preferredValidation(state), "python3 -m unittest -v");

  state = completePlanValidation(state, plan, 1, false);
  const correction = runtime.deriveRuntimeV2PlanValidationCorrectionScope(
    state,
  );
  assert.equal(correction.active, true);
  assert.equal(correction.validationIndex, 1);
  assert.deepEqual(correction.stepIndexes, [0, 1, 2]);
  assert.deepEqual(correction.targets, ["snake.py", "test_snake.py", "README.md"]);

  state = commitMutation(
    state,
    "correct-tests-after-failure",
    "test_snake.py",
    "tests-corrected",
    "replace_in_file",
  );
  assert.equal(
    runtime.deriveRuntimeV2PlanValidationCorrectionScope(state).active,
    false,
  );
  assert.deepEqual(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state)
      .missingRequiredValidationIndexes,
    [0, 1],
    "a correction creates a new mutation boundary and reopens both required validators",
  );
  assert.equal(preferredValidation(state), "python3 -m compileall -q .");
  state = completePlanValidation(state, plan, 0, true);
  assert.equal(preferredValidation(state), "python3 -m unittest -v");
  state = completePlanValidation(state, plan, 1, true);
  assert.equal(preferredValidation(state), "");
  assert.equal(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state)
      .allRequiredValidationsPassed,
    true,
  );
});

test("approved Plan operation checks consume canonical apply_patch effects", () => {
  assert.deepEqual(
    workspaceMutationTools.resolveWorkspaceMutationRequests("apply_patch", {
      patch: [
        "--- a/snake.py",
        "+++ b/snake.py",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    }),
    [{ target: "snake.py", operation: "modify" }],
  );
  assert.deepEqual(
    workspaceMutationTools.resolveWorkspaceMutationRequests("apply_patch", {
      patch: [
        "--- /dev/null",
        "+++ b/test_snake.py",
        "@@ -0,0 +1 @@",
        "+import unittest",
      ].join("\n"),
    }),
    [{ target: "test_snake.py", operation: "create" }],
  );
  assert.deepEqual(
    workspaceMutationTools.resolveWorkspaceMutationRequests("apply_patch", {
      patch: [
        "--- a/legacy.py",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-legacy = True",
      ].join("\n"),
    }),
    [{ target: "legacy.py", operation: "delete" }],
  );
  assert.deepEqual(
    workspaceMutationTools.resolveWorkspaceMutationRequests("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: old_name.py",
        "*** Move to: new_name.py",
        "@@",
        "-old = True",
        "+new = True",
        "*** End Patch",
      ].join("\n"),
    }),
    [
      { target: "old_name.py", operation: "delete" },
      { target: "new_name.py", operation: "create" },
    ],
    "a move cannot masquerade as two modify operations",
  );
});
