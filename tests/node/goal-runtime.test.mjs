import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const goalState = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalState.ts"));
const goalRuntime = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalRuntime.ts"));
const goalBudget = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalBudget.ts"));
const goalContext = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalContextStrategy.ts"));
const goalEngine = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalEngine.ts"));

function createIteration(index) {
  return {
    index,
    phase: "observe",
    startedAt: index,
    endedAt: index + 1,
    summary: `iteration ${index}`,
    toolCallCount: 1,
    filesModified: [],
    testsRun: [],
    testsPassed: null,
    unresolvedBlockers: [],
  };
}

test("Goal Runtime creates a versioned contract with structured completion criteria", () => {
  const goal = goalState.createGoalDefinition({
    objective: "重构 Capsule；完成标准：三大主题均通过 Playwright 测试；约束：保持兼容",
  });

  assert.equal(goal.schemaVersion, 2);
  assert.equal(goal.revision, 1);
  assert.ok(goal.criteria.length >= 1);
  assert.equal(goal.criteria[0].text, "三大主题均通过 Playwright 测试");
  assert.ok(goal.criteria.every((criterion) => criterion.status === "pending"));
  assert.deepEqual(goal.constraints, ["保持兼容"]);
});

test("tool result parsing accepts zero failures and rejects explicit failures", () => {
  assert.equal(goalRuntime.isGoalToolResultSuccessful("12 passed, 0 failed"), true);
  assert.equal(goalRuntime.isGoalToolResultSuccessful("0 errors"), true);
  assert.equal(goalRuntime.isGoalToolResultSuccessful("Tests failed: assertion mismatch"), false);
  assert.equal(goalRuntime.isGoalToolResultSuccessful('{"exitCode":1}'), false);
});

test("a completion marker without fresh execution evidence is only a candidate", () => {
  const goal = goalState.createGoalDefinition({ objective: "重构 Goal Runtime 并运行测试" });
  const result = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [],
    completionCandidate: true,
  });

  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("no_fresh_execution_evidence"));
  assert.ok(result.reasons.includes("mutation_evidence_required"));
  assert.ok(result.reasons.includes("verification_evidence_required"));
});

test("mutation goals require both a file change and a recognized verification result", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and verify with lint" });
  const fileOnly = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 100,
    observations: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
  });
  const genericCommand = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 200,
    observations: [{ name: "run_command", arguments: { command: "pwd" }, result: "ok" }],
  });

  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...fileOnly, ...genericCommand],
    completionCandidate: true,
  }).passed, false);

  const lintEvidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 300,
    observations: [{ name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" }],
  });
  const completed = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...fileOnly, ...lintEvidence],
    completionCandidate: true,
  });

  assert.equal(completed.passed, true);
  assert.ok(completed.criteria.every((criterion) => criterion.status === "satisfied"));
});

test("editing a goal invalidates evidence from the previous revision", () => {
  const original = goalState.createGoalDefinition({ objective: "Fix the capsule and run tests" });
  const oldEvidence = goalRuntime.createGoalEvidenceEntries({
    goal: original,
    iteration: 1,
    observations: [
      { name: "apply_patch", target: "src/components/ChatArea.tsx", result: "Done" },
      { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
    ],
  });
  const edited = goalState.updateGoalDefinitionText(original, "Fix the capsule, tests, and light theme");
  const result = goalRuntime.evaluateGoalCompletion({ goal: edited, evidence: oldEvidence, completionCandidate: true });

  assert.equal(edited.revision, 2);
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("no_fresh_execution_evidence"));
});

test("a later passing verification supersedes an earlier failure for the same target", () => {
  const goal = goalState.createGoalDefinition({ objective: "Fix runtime and run npm test" });
  const fileEvidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 100,
    observations: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
  });
  const failedTest = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 200,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: '{"exitCode":1}' }],
  });
  const passingRetry = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 300,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: "14 passed, 0 failed" }],
  });

  const result = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...fileEvidence, ...failedTest, ...passingRetry],
    completionCandidate: true,
  });
  assert.equal(result.passed, true);
  assert.ok(!result.reasons.includes("verification_failed"));
});

test("read-only repetition is still treated as no progress", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor the runtime" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  const iterations = [createIteration(1), createIteration(2), createIteration(3)];
  progress.totalIterationsUsed = 3;
  progress.iterations = iterations;
  progress.evidence = iterations.flatMap((iteration) => goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: iteration.index,
    observations: [{ name: "read_file", target: "src/lib/goalRuntime.ts", result: "content" }],
  }));

  const check = goalBudget.checkGoalBudget({
    goal,
    progress,
    budget: goalBudget.resolveGoalBudget({ maxNoProgressIterations: 3, userConfirmInterval: 0 }),
    recentIterations: iterations,
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "no_progress");
});

test("read-only shell inspection does not count as Goal execution progress", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor the runtime" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [{ name: "run_command", arguments: { command: "git status" }, result: "clean" }],
  });

  assert.equal(evidence[0].kind, "read");
  assert.equal(evidence[0].status, "observed");
  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal,
    evidence,
    completionCandidate: true,
  }).passed, false);
});

test("GoalTurnContract is revisioned, bounded, and asks for runtime-gated completion", () => {
  const goal = goalState.createGoalDefinition({ objective: "实现持久目标并运行测试", iterationBudget: 25 });
  const contract = goalContext.buildGoalTurnContract({
    goal,
    checkpoint: null,
    latestVerification: null,
    nextIteration: 4,
    language: "zh",
  });

  assert.equal(contract.iteration, 4);
  assert.equal(contract.maxIterations, 25);
  assert.match(contract.cacheKey, new RegExp(`^${goal.id}:1:4:`));
  assert.match(contract.context, /有界执行切片/);
  assert.match(contract.context, /GOAL_COMPLETION_CANDIDATE/);
  assert.match(contract.context, /不要在模型内部自行开启无限循环/);
  assert.match(contract.context, /不要修改 `.MAIN\/goals\/` 中的运行时状态文件/);
  assert.doesNotMatch(contract.context, /完成本轮任务后，更新/);
});

test("restoring an interrupted Goal pauses it and excludes offline time", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  progress.usage.activeDurationMs = 4_000;
  progress.usage.activeStartedAt = 10_000;
  const snapshot = {
    ...goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" }),
    updatedAt: 16_000,
  };

  const restored = goalRuntime.restoreGoalRuntimeSnapshot(snapshot, 100_000);
  assert.equal(restored.status, "paused");
  assert.equal(restored.goal.status, "paused");
  assert.equal(restored.phase, "re_plan");
  assert.equal(restored.progress.usage.activeDurationMs, 10_000);
  assert.equal(restored.progress.usage.activeStartedAt, null);
  assert.match(restored.pauseReason, /resume explicitly/);
});

test("normalizing a live Goal snapshot does not apply cold-start pause semantics", () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  const snapshot = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });
  const normalized = goalRuntime.normalizeGoalRuntimeSnapshot(snapshot);

  assert.equal(normalized.status, "active");
  assert.equal(normalized.goal.status, "active");
  assert.equal(normalized.progress.usage.activeStartedAt, progress.usage.activeStartedAt);
});

function createEngineCallbacks(runAgentIteration) {
  const writes = [];
  const outcomes = [];
  const runtimeUpdates = [];
  return {
    writes,
    outcomes,
    runtimeUpdates,
    callbacks: {
      getPreferredLanguage: () => "en",
      getWorkspacePath: () => "/tmp/goal-runtime-test",
      runAgentIteration,
      writeFile: async (filePath, content) => writes.push({ filePath, content }),
      readFile: async () => null,
      isAborted: () => false,
      onGoalProgressUpdate: () => {},
      onGoalRuntimeUpdate: (runtime) => runtimeUpdates.push(runtime),
      onGoalIterationStart: () => {},
      onGoalIterationEnd: () => {},
      onGoalCheckpointSaved: () => {},
      onGoalUserConfirmNeeded: async () => false,
      onGoalOutcome: (outcome) => outcomes.push(outcome),
    },
  };
}

test("Goal Engine completes only after a tool-backed mutation and verification slice", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Implemented and verified. GOAL_COMPLETION_CANDIDATE",
    toolCalls: [
      { name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
    ],
    tokensUsed: 120,
    completed: true,
    outcomeStatus: "completed",
  }));

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.iterationsUsed, 1);
  assert.equal(harness.outcomes.at(-1).status, "completed");
  assert.ok(harness.writes.some((write) => write.filePath.endsWith(`/.MAIN/goals/${goal.id}/state.json`)));
  assert.ok(harness.writes.some((write) => write.filePath.endsWith(`/.MAIN/goals/${goal.id}/evidence.jsonl`)));
});

test("Goal Engine checkpoints and pauses an inner-loop error without silently restarting", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    runs += 1;
    return {
      assistantText: "Unable to finish this slice",
      toolCalls: [],
      tokensUsed: 40,
      completed: false,
      outcomeStatus: "error",
      error: "provider stream failed",
    };
  });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(runs, 1);
  assert.equal(outcome.status, "paused");
  assert.match(outcome.reason, /provider stream failed/);
  assert.equal(outcome.finalCheckpoint.iteration, 1);
  assert.equal(harness.runtimeUpdates.at(-1).status, "paused");
});

test("Goal Engine carries a continuation checkpoint into every fresh slice", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  const seenContracts = [];
  let runs = 0;
  const harness = createEngineCallbacks(async (input) => {
    runs += 1;
    seenContracts.push(input.goalTurnContract);
    if (runs === 1) {
      return {
        assistantText: "Patched the runtime.\n## Next\n- Run lint",
        toolCalls: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
        tokensUsed: 80,
        completed: true,
        outcomeStatus: "completed",
      };
    }
    return {
      assistantText: "Lint passed. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [{ name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" }],
      tokensUsed: 40,
      completed: true,
      outcomeStatus: "completed",
    };
  });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(runs, 2);
  assert.equal(seenContracts[1].iteration, 2);
  assert.match(seenContracts[1].context, /Iteration 1/);
  assert.match(seenContracts[1].context, /src\/lib\/goalRuntime\.ts/);
  assert.match(seenContracts[1].context, /Run lint/);
});

test("periodic user confirmation pause is persisted before Goal Engine returns", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Analyze a large repository", iterationBudget: 10 });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  progress.totalIterationsUsed = 2;
  progress.currentIteration = 2;
  const harness = createEngineCallbacks(async () => {
    throw new Error("agent iteration should not run before confirmation");
  });

  const outcome = await goalEngine.executeGoalLoop({
    goal,
    callbacks: harness.callbacks,
    existingProgress: progress,
    budgetOverrides: { userConfirmInterval: 2, maxIterations: 10 },
  });
  assert.equal(outcome.status, "paused");
  assert.ok(harness.writes.length >= 3);
  assert.ok(harness.writes.some((write) => write.filePath.endsWith(`/.MAIN/goals/${goal.id}/progress.md`)));
  assert.equal(harness.runtimeUpdates.at(-1).status, "paused");
});
