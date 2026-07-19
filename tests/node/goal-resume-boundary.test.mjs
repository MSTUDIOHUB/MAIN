import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (fsSync.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildAcceptedGoalContinuationState,
  resolveGoalResumeTurnBoundary,
  shouldDetachGoalPresentationFromOwnerTurn,
} = loadTranspiledModuleSync(
  path.join(process.cwd(), "src/lib/goalResumeBoundary.ts"),
);

function turn(overrides = {}) {
  return {
    id: "turn-goal",
    userPrompt: "Keep fixing the runtime",
    status: "paused",
    summary: "",
    blockIds: [],
    collapsed: false,
    createdAt: 1,
    ...overrides,
  };
}

function pausedOutcome() {
  return {
    status: "paused",
    reason: "goal_checkpoint",
    pauseKind: "resumable",
    runId: "run-goal",
    parentRunId: null,
    updatedAt: 2,
  };
}

function closedOutcome(status, resultKind) {
  return {
    status,
    reason: `goal_${resultKind}`,
    resultKind,
    runId: "run-goal",
    parentRunId: null,
    updatedAt: 3,
  };
}

test("a genuine paused Goal owner continues as a child Run in the same Turn", () => {
  const result = resolveGoalResumeTurnBoundary({
    ownerTurnId: "turn-goal",
    sessionKey: "session-1",
    conversationTurns: [turn({ runtimeOutcome: pausedOutcome() })],
    runtimeEvents: [],
    createTurnId: () => "turn-new",
  });

  assert.deepEqual(result, {
    turnId: "turn-goal",
    previousOwnerTurnId: "turn-goal",
    parentRunId: "run-goal",
    reuseCurrentTurn: true,
    createVisibleTurnForHiddenMessage: false,
    reason: "paused_owner",
  });
});

test("canceled and blocked owner Turns resume the Goal in a fresh visible Turn", () => {
  for (const [status, resultKind] of [["aborted", "canceled"], ["completed", "blocked"]]) {
    const ownerTurn = turn({
      status: "done",
      runtimeOutcome: closedOutcome(status, resultKind),
    });
    const result = resolveGoalResumeTurnBoundary({
      ownerTurnId: ownerTurn.id,
      sessionKey: "session-1",
      conversationTurns: [ownerTurn],
      runtimeEvents: [],
      createTurnId: () => `turn-new-${resultKind}`,
    });

    assert.equal(result.turnId, `turn-new-${resultKind}`);
    assert.equal(result.parentRunId, null);
    assert.equal(result.reuseCurrentTurn, false);
    assert.equal(result.createVisibleTurnForHiddenMessage, true);
    assert.equal(result.reason, "closed_owner");
    assert.equal(shouldDetachGoalPresentationFromOwnerTurn({
      goalStatus: resultKind === "blocked" ? "blocked" : "paused",
      ownerTurn,
      ownerTurnId: ownerTurn.id,
      sessionKey: "session-1",
      runtimeEvents: [],
    }), true);
  }
});

test("a durable Turn terminal wins over a stale paused projection", () => {
  const ownerTurn = turn({ runtimeOutcome: pausedOutcome() });
  const runtimeEvents = [{
    schemaVersion: 2,
    type: "turn.completed",
    threadId: "session-1",
    turnId: ownerTurn.id,
    timestampMs: 4,
    resultKind: "canceled",
  }];
  const result = resolveGoalResumeTurnBoundary({
    ownerTurnId: ownerTurn.id,
    sessionKey: "session-1",
    conversationTurns: [ownerTurn],
    runtimeEvents,
    createTurnId: () => "turn-after-terminal",
  });

  assert.equal(result.turnId, "turn-after-terminal");
  assert.equal(result.reason, "closed_owner");
});

test("Goal presentation detaches only resumable business state from a closed owner", () => {
  const ownerTurn = turn({
    status: "done",
    runtimeOutcome: closedOutcome("completed", "success"),
  });
  const base = {
    ownerTurn,
    ownerTurnId: ownerTurn.id,
    sessionKey: "session-1",
    runtimeEvents: [],
  };

  assert.equal(shouldDetachGoalPresentationFromOwnerTurn({ ...base, goalStatus: "paused" }), true);
  assert.equal(shouldDetachGoalPresentationFromOwnerTurn({ ...base, goalStatus: "blocked" }), true);
  assert.equal(shouldDetachGoalPresentationFromOwnerTurn({ ...base, goalStatus: "completed" }), false);
});

test("a missing owner never reuses an old id", () => {
  const result = resolveGoalResumeTurnBoundary({
    ownerTurnId: "turn-missing",
    sessionKey: "session-1",
    conversationTurns: [],
    runtimeEvents: [],
    createTurnId: () => "turn-recovered",
  });

  assert.equal(result.turnId, "turn-recovered");
  assert.equal(result.parentRunId, null);
  assert.equal(result.reuseCurrentTurn, false);
  assert.equal(result.reason, "missing_owner");
});

test("Goal resume becomes active only after the exact continuation owner is accepted", () => {
  const goal = {
    id: "goal-1",
    revision: 4,
    objective: "Repair the runtime",
    definitionOfDone: ["tests pass"],
    createdAt: 1,
    updatedAt: 2,
    status: "blocked",
    iterationBudget: 20,
    ownerTurnId: "turn-old",
  };
  const progress = {
    goalId: goal.id,
    currentIteration: 5,
    totalIterationsUsed: 5,
    totalTokensUsed: 100,
    iterations: [],
    lastCheckpoint: null,
    progressFile: ".MAIN/goals/progress.md",
    lastUpdatedAt: 2,
    pauseReason: "same blocker repeated",
    lastStopReason: "tool_unavailable",
    stopClass: "blocked",
    recoveryState: {
      normalizedCause: "tool_unavailable",
      consecutiveCount: 3,
      lastReason: "same blocker repeated",
      updatedAt: 2,
    },
    usage: {
      modelIterations: 5,
      toolCalls: 8,
      totalTokensUsed: 100,
      activeDurationMs: 9_000,
      activeStartedAt: null,
      estimatedTokens: false,
    },
  };
  const runtime = {
    schemaVersion: 3,
    goal,
    progress,
    status: "blocked",
    phase: "re_plan",
    pauseReason: progress.pauseReason,
    stopClass: "blocked",
    updatedAt: 2,
  };

  const accepted = buildAcceptedGoalContinuationState({
    goal,
    progress,
    runtime,
    authorization: {
      goalId: goal.id,
      goalRevision: 4,
      ownerTurnId: "turn-old",
    },
    ownerTurnId: "turn-resumed",
    nowMs: 20_000,
  });

  assert.equal(accepted.previousStatus, "blocked");
  assert.equal(accepted.transitioned, true);
  assert.equal(accepted.goal.ownerTurnId, "turn-resumed");
  assert.equal(accepted.goal.status, "active");
  assert.equal(accepted.progress.recoveryState, undefined);
  assert.equal(accepted.progress.recoveryAuditStartIteration, 5);
  assert.equal(accepted.progress.stopClass, undefined);
  assert.equal(accepted.progress.usage.activeStartedAt, 20_000);
  assert.equal(accepted.runtime.goal, accepted.goal);
  assert.equal(accepted.runtime.progress, accepted.progress);
  assert.equal(accepted.runtime.status, "active");
});

test("Goal resume lease acceptance rejects a stale owner without changing the snapshot", () => {
  const goal = {
    id: "goal-1",
    revision: 4,
    objective: "Repair the runtime",
    definitionOfDone: [],
    createdAt: 1,
    status: "paused",
    iterationBudget: 20,
    ownerTurnId: "turn-current",
  };
  const progress = {
    goalId: goal.id,
    currentIteration: 1,
    totalIterationsUsed: 1,
    totalTokensUsed: 0,
    iterations: [],
    lastCheckpoint: null,
    progressFile: ".MAIN/goals/progress.md",
    lastUpdatedAt: 1,
    pauseReason: "user_paused",
  };

  assert.equal(buildAcceptedGoalContinuationState({
    goal,
    progress,
    runtime: null,
    authorization: {
      goalId: goal.id,
      goalRevision: 4,
      ownerTurnId: "turn-stale",
    },
    ownerTurnId: "turn-new",
    nowMs: 5,
  }), null);
  assert.equal(goal.status, "paused");
  assert.equal(goal.ownerTurnId, "turn-current");
  assert.equal(progress.pauseReason, "user_paused");
});

test("an already active Goal continuation for the same owner is idempotent", () => {
  const goal = {
    id: "goal-active",
    revision: 1,
    objective: "Keep working",
    definitionOfDone: [],
    createdAt: 1,
    status: "active",
    iterationBudget: 20,
    ownerTurnId: "turn-active",
  };
  const progress = {
    goalId: goal.id,
    currentIteration: 0,
    totalIterationsUsed: 0,
    totalTokensUsed: 0,
    iterations: [],
    lastCheckpoint: null,
    progressFile: ".MAIN/goals/progress.md",
    lastUpdatedAt: 1,
    usage: {
      modelIterations: 0,
      toolCalls: 0,
      totalTokensUsed: 0,
      activeDurationMs: 0,
      activeStartedAt: 1,
      estimatedTokens: false,
    },
  };
  const accepted = buildAcceptedGoalContinuationState({
    goal,
    progress,
    runtime: null,
    authorization: {
      goalId: goal.id,
      goalRevision: 1,
      ownerTurnId: "turn-active",
    },
    ownerTurnId: "turn-active",
    nowMs: 9,
  });

  assert.equal(accepted.transitioned, false);
  assert.equal(accepted.goal, goal);
  assert.equal(accepted.progress, progress);
  assert.equal(accepted.progress.usage.activeStartedAt, 1);
});
