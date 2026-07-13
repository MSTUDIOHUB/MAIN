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
const goalContinuity = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalContinuity.ts"));
const goalSourceContext = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalSourceContext.ts"));
const goalEventIdentity = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalEventIdentity.ts"));

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

  assert.equal(goal.schemaVersion, 3);
  assert.equal(goal.revision, 1);
  assert.ok(goal.criteria.length >= 1);
  assert.equal(goal.criteria[0].text, "三大主题均通过 Playwright 测试");
  assert.ok(goal.criteria.every((criterion) => criterion.status === "pending"));
  assert.deepEqual(goal.constraints, ["保持兼容"]);
});

test("Goal events use the session runtime key and remain on the owner turn", () => {
  assert.deepEqual(goalEventIdentity.resolveGoalEventOwnerIdentity({
    goal: { sessionKey: "/workspace:42", ownerTurnId: "turn-goal" },
    currentWorkspace: "/other",
    currentSessionId: 9,
    currentTurnId: "turn-current",
  }), {
    threadId: "/workspace:42",
    turnId: "turn-goal",
  });

  assert.deepEqual(goalEventIdentity.resolveGoalEventOwnerIdentity({
    goal: {},
    currentWorkspace: "/workspace",
    currentSessionId: 42,
    currentTurnId: "turn-current",
  }), {
    threadId: "/workspace:42",
    turnId: "turn-current",
  });
});

test("each Goal slice contract includes revision and bounded prior evidence mappings", () => {
  const goal = goalState.createGoalDefinition({ objective: "Fix the capsule and run lint" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "apply_patch", target: "src/components/ExecutionCapsule.tsx", result: "Done" },
    ],
  });
  const context = goalContext.buildGoalIterationSystemContext({
    goal,
    checkpoint: null,
    latestVerification: null,
    nextIteration: 2,
    language: "en",
    evidence,
  });
  assert.match(context, /\*\*Revision\*\*: 1/);
  assert.match(context, /Existing Structured Evidence/);
  assert.match(context, /ExecutionCapsule\.tsx/);
  assert.match(context, /criteria=criterion_1/);
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

test("a test-or-typecheck completion criterion accepts either verified branch", () => {
  const goal = goalState.createGoalDefinition({
    objective: "修改 CSV 解析器。完成标准：源码已修改且运行测试或类型检查通过；约束：保持兼容",
  });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "replace_in_file", target: "src/hooks/useCsvParser.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npx tsc --noEmit" }, result: "0 errors" },
    ],
  });

  const result = goalRuntime.evaluateGoalCompletion({ goal, evidence, completionCandidate: true });
  assert.equal(result.passed, true);
  assert.equal(result.criteria[0].status, "satisfied");
  assert.equal(result.criteria[0].evidenceIds.length, 2);
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

test("a later mutation invalidates same-revision verification until validation runs again", () => {
  const goal = goalState.createGoalDefinition({ objective: "Fix runtime and verify with npm test" });
  const firstMutation = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 100,
    observations: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
  });
  const earlyVerification = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 200,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: "14 passed, 0 failed" }],
  });
  const laterMutation = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 300,
    observations: [{ name: "apply_patch", target: "src/lib/goalEngine.ts", result: "Done" }],
  });

  const stale = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...firstMutation, ...earlyVerification, ...laterMutation],
    completionCandidate: true,
  });
  assert.equal(stale.passed, false);
  assert.ok(stale.reasons.includes("verification_stale_after_mutation"));
  assert.ok(stale.reasons.includes("verification_evidence_required"));

  const finalVerification = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 2,
    now: 400,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: "15 passed, 0 failed" }],
  });
  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...firstMutation, ...earlyVerification, ...laterMutation, ...finalVerification],
    completionCandidate: true,
  }).passed, true);
});

test("mutation criteria invalidate old validation even when the referential objective is generic", () => {
  const goal = goalState.createGoalDefinition({
    objective: "完成上述计划",
    sourceContext: "[unfinished_criteria]\n- 修改 Goal 状态机\n- 运行 npm test 验证",
  });
  const earlyVerification = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 100,
    observations: [{ name: "run_command", arguments: { command: "npm test" }, result: "10 passed, 0 failed" }],
  });
  const laterMutation = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 200,
    observations: [{ name: "apply_patch", target: "src/lib/goalEngine.ts", result: "Done" }],
  });
  const result = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [...earlyVerification, ...laterMutation],
    completionCandidate: true,
  });

  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("verification_stale_after_mutation"));
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

test("GoalTurnContract is revisioned, continuous, and asks for runtime-gated completion", () => {
  const goal = goalState.createGoalDefinition({ objective: "实现持久目标并运行测试", iterationBudget: 25 });
  const contract = goalContext.buildGoalTurnContract({
    goal,
    checkpoint: null,
    latestVerification: null,
    nextIteration: 4,
    language: "zh",
  });

  assert.equal(contract.iteration, 4);
  assert.equal(contract.goalSliceId, `${goal.id}:slice:4`);
  assert.equal(contract.maxIterations, 25);
  assert.match(contract.cacheKey, new RegExp(`^${goal.id}:1:4:`));
  assert.match(contract.context, /同一个持续目标/);
  assert.doesNotMatch(contract.context, /连续执行 4\/25|迭代 4\/25/);
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

test("Goal Engine completes from verified evidence after a non-terminal provider stop without a model marker", async () => {
  const goal = goalState.createGoalDefinition({
    objective: "Update the parser. Definition of done: modify source and run typecheck",
    iterationBudget: 6,
  });
  const debugEvents = [];
  const harness = createEngineCallbacks(async () => ({
    assistantText: "The parser was updated and typecheck passed.",
    toolCalls: [
      { name: "apply_patch", target: "src/hooks/useCsvParser.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npx tsc --noEmit" }, result: "0 errors" },
    ],
    tokensUsed: 120,
    completed: false,
    outcomeStatus: "stopped_no_output",
    stopReason: "no_output",
    sliceBoundaryReached: false,
  }));
  harness.callbacks.onDebugEvent = (event, data) => debugEvents.push({ event, data });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.iterationsUsed, 1);
  assert.ok(debugEvents.some(({ event }) => event === "goal_runtime_evidence_completion_candidate"));
  assert.equal(
    debugEvents.find(({ event }) => event === "goal_continuation_start")?.data?.continuationId,
    `${goal.id}:slice:1`,
  );
  assert.ok(debugEvents.some(({ event, data }) =>
    event === "goal_completion_accepted"
    && data?.candidateSource === "runtime_evidence"
    && data?.continuationId === `${goal.id}:slice:1`
  ));
});

test("Goal Engine retries a normalized recoverable error and blocks on the third occurrence", async () => {
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
  assert.equal(runs, 3);
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.reason, /provider stream failed/);
  assert.equal(outcome.finalCheckpoint.iteration, 3);
  assert.equal(harness.runtimeUpdates.at(-1).status, "blocked");
  assert.equal(harness.runtimeUpdates.at(-1).progress.recoveryState.consecutiveCount, 3);
});

test("Goal Engine resumes from retained conclusions after a recoverable stream failure", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Update Goal Runtime and run lint", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async (input) => {
    runs += 1;
    if (runs === 1) {
      const error = new Error("provider stream failed");
      error.goalContinuationState = goalContinuity.createGoalContinuationState({
        sourceIteration: 1,
        messages: [
          { role: "assistant", content: "Root cause confirmed in `src/lib/goalRuntime.ts`; the next action is the patch." },
        ],
      });
      error.goalIterationUsage = { modelIterations: 1, toolCalls: 0, tokensUsed: 30, estimatedTokens: true };
      throw error;
    }

    assert.equal(input.continuation.messages[0].content.includes("Root cause confirmed"), true);
    return {
      assistantText: "Patched and linted. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [
        { name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" },
        { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
      ],
      tokensUsed: 60,
      completed: true,
      outcomeStatus: "completed",
    };
  });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(runs, 2);
  assert.equal(harness.runtimeUpdates.some((runtime) =>
    runtime.progress.continuation?.messages[0]?.content.includes("Root cause confirmed")
  ), true);
});

test("Goal Engine carries conclusions and operation context across internal continuations", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  const seenContracts = [];
  let runs = 0;
  const harness = createEngineCallbacks(async (input) => {
    runs += 1;
    seenContracts.push(input.goalTurnContract);
    if (runs === 1) {
      const continuation = goalContinuity.createGoalContinuationState({
        sourceIteration: 1,
        messages: [
          { role: "assistant", content: "Concrete finding: `src/lib/goalRuntime.ts` still needs lint verification." },
          {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call-patch",
              type: "function",
              function: { name: "apply_patch", arguments: JSON.stringify({ patch: "*** Update File: src/lib/goalRuntime.ts" }) },
            }],
          },
          { role: "tool", tool_call_id: "call-patch", content: "Done" },
        ],
      });
      return {
        assistantText: "I have finished reading the relevant files.\n\nConcrete finding: `src/lib/goalRuntime.ts` was patched and still needs lint verification.\n\n## Next\n- Run lint",
        toolCalls: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
        tokensUsed: 80,
        completed: true,
        outcomeStatus: "completed",
        continuation,
      };
    }
    assert.equal(input.continuation.messages[0].content.includes("Concrete finding"), true);
    assert.equal(input.continuation.messages[1].tool_calls[0].function.name, "apply_patch");
    assert.equal(input.continuation.messages[2].content, "Done");
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
  assert.match(seenContracts[1].context, /Continuation 1/);
  assert.match(seenContracts[1].context, /Concrete finding/);
  assert.match(seenContracts[1].context, /src\/lib\/goalRuntime\.ts/);
  assert.match(seenContracts[1].context, /Run lint/);
});

test("Goal continuation transport preserves complete tool pairs and strips runtime control messages", () => {
  const state = goalContinuity.createGoalContinuationState({
    sourceIteration: 3,
    messages: [
      { role: "system", content: "large regenerated system prompt" },
      { role: "user", content: '[goal_continuation goal_id="g" index="3"]\ncontinue\n[/goal_continuation]' },
      { role: "user", content: "EXECUTE_RECOVERY: Now immediately continue using tools." },
      { role: "assistant", content: "The root cause is in `src/main.ts:L120`: `editor.getValue()` is invalid for a textarea." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "read-1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/main.ts","start_line":110}' },
        }],
        reasoning_content: "private reasoning must not persist",
      },
      { role: "tool", tool_call_id: "read-1", content: "const editor = document.querySelector('textarea')" },
      { role: "tool", tool_call_id: "orphan", content: "orphan result" },
    ],
  });

  assert.equal(state.messages.some((message) => message.role === "system"), false);
  assert.equal(state.messages.some((message) => message.content.includes("goal_continuation")), false);
  assert.equal(state.messages.some((message) => message.content.includes("EXECUTE_RECOVERY")), false);
  assert.equal(state.messages.some((message) => message.content.includes("private reasoning")), false);
  assert.equal(state.messages.some((message) => message.tool_call_id === "orphan"), false);
  assert.equal(state.messages.find((message) => message.tool_calls)?.tool_calls[0].function.arguments.includes("src/main.ts"), true);
  assert.equal(state.messages.find((message) => message.role === "tool")?.content.includes("textarea"), true);
  assert.match(state.memoryPacket, /src\/main\.ts/);
});

test("Goal runtime normalization preserves durable continuation memory idempotently", () => {
  const goal = goalState.createGoalDefinition({ objective: "Continue one persistent task" });
  const progress = goalState.createGoalProgress(goal.id, ".MAIN/goals/progress.md");
  progress.continuation = goalContinuity.createGoalContinuationState({
    sourceIteration: 2,
    messages: [
      { role: "assistant", content: "Keep this exact conclusion about `src/lib/goalRuntime.ts`." },
    ],
  });
  progress.continuation.memoryPacket = "durable older operation memory";
  const snapshot = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });

  const once = goalRuntime.normalizeGoalRuntimeSnapshot(snapshot);
  const twice = goalRuntime.normalizeGoalRuntimeSnapshot(once);

  assert.equal(once.progress.continuation.memoryPacket, "durable older operation memory");
  assert.equal(twice.progress.continuation.memoryPacket, once.progress.continuation.memoryPacket);
  assert.deepEqual(twice.progress.continuation.messages, once.progress.continuation.messages);
});

test("Goal continuation compaction keeps bounded complete tool protocol groups", () => {
  const messages = [];
  for (let index = 0; index < 80; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: `call-${index}`,
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: `src/file-${index}.ts` }) },
      }],
    });
    messages.push({ role: "tool", tool_call_id: `call-${index}`, content: `content-${index}` });
  }
  messages.push({ role: "assistant", content: "Latest concrete conclusion must survive compaction." });

  const state = goalContinuity.createGoalContinuationState({ sourceIteration: 4, messages });
  const callIds = new Set(state.messages.flatMap((message) =>
    (message.tool_calls || []).map((call) => call.id)
  ));
  const resultIds = new Set(state.messages.flatMap((message) =>
    message.tool_call_id ? [message.tool_call_id] : []
  ));

  assert.equal(state.compacted, true);
  assert.equal(state.messages.length <= 72, true);
  assert.deepEqual([...callIds].sort(), [...resultIds].sort());
  assert.equal(state.messages.at(-1).content.includes("Latest concrete conclusion"), true);

  const next = goalContinuity.createGoalContinuationState({
    sourceIteration: 5,
    previous: { ...state, messages: state.messages.slice(-1) },
    messages: [
      state.messages.at(-1),
      { role: "assistant", content: "One more conclusion." },
    ],
  });
  assert.equal(next.compacted, true);
  assert.match(next.memoryPacket, /Latest concrete conclusion|One more conclusion/);
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
  assert.equal(outcome.status, "awaiting_input");
  assert.ok(harness.writes.length >= 3);
  assert.ok(harness.writes.some((write) => write.filePath.endsWith(`/.MAIN/goals/${goal.id}/progress.md`)));
  assert.equal(harness.runtimeUpdates.at(-1).status, "awaiting_input");
});

test("Goal v3 keeps a canonical objective and bounded prior-turn source context", () => {
  const wrapper = [
    "[turn_intake]",
    "workflowMode: edit",
    "imageParts: 0",
    "priority: internal runtime instruction that must not become the objective",
    "[user_request]",
    "修复这些问题",
    "[/user_request]",
    "[/turn_intake]",
  ].join("\n");
  const goal = goalState.createGoalDefinition({ objective: wrapper });

  assert.equal(goal.objective, "修复这些问题");
  assert.equal(goal.rawText, "修复这些问题");
  assert.ok(goal.sourceContext.length <= goalState.GOAL_SOURCE_CONTEXT_MAX_CHARS);
  assert.match(goal.sourceContext, /workflowMode: edit/);
  assert.doesNotMatch(goal.sourceContext, /priority:|\[turn_intake\]|internal runtime instruction/);
});

test("Goal source context snapshots retain prior canonical user and assistant conclusions", () => {
  const sourceContext = goalSourceContext.buildGoalSourceContextSnapshot({
    objective: "修复这些问题",
    agentMessages: [
      { role: "system", content: "runtime system prompt" },
      { role: "user", content: "[turn_intake]\n[user_request]\n先分析 Plan 渲染问题\n[/user_request]\n[/turn_intake]" },
      { role: "assistant", content: "Plan conclusion: the final artifact was not materialized." },
      { role: "tool", content: "large tool payload", tool_call_id: "tool-1" },
    ],
    conversationTurns: [{ summary: "上一轮确认：仅在 ChatArea 渲染了文本。", status: "done" }],
  });

  assert.match(sourceContext, /先分析 Plan 渲染问题/);
  assert.match(sourceContext, /Plan conclusion/);
  assert.match(sourceContext, /仅在 ChatArea 渲染了文本/);
  assert.doesNotMatch(sourceContext, /runtime system prompt|large tool payload|\[turn_intake\]/);
  assert.ok(sourceContext.length <= goalState.GOAL_SOURCE_CONTEXT_MAX_CHARS);
});

test("referential Goal expands durable unfinished work and Plan artifacts into separate criteria", () => {
  const sourceContext = goalSourceContext.buildGoalSourceContextSnapshot({
    objective: "修复这些问题",
    agentMessages: [],
    conversationTurns: [{
      summary: "上一轮尚未完成。",
      durableContext: {
        schemaVersion: 1,
        turnId: "turn-prior",
        visibleUserMessages: ["修复 Plan 和 Goal"],
        finalAssistantAnswer: "仍有两项待处理。",
        execution: {
          decisions: [],
          modifiedFiles: [],
          validations: [],
          failures: [],
          unfinished: ["修复 Plan 审批身份绑定", "验证 Goal slice 自动续跑"],
          artifacts: [".MAIN/plans/plan.md"],
        },
        committedAt: 1,
      },
    }],
    planArtifacts: [{
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      updatedAt: 1,
      content: "# Plan\n\n- 修复 Plan 审批身份绑定\n- 验证 Goal slice 自动续跑",
    }],
  });
  const goal = goalState.createGoalDefinition({ objective: "修复这些问题", sourceContext });

  assert.equal(goal.criteriaReviewRequired, false);
  assert.equal(goal.status, "active");
  assert.deepEqual(goal.definitionOfDone, ["修复 Plan 审批身份绑定", "验证 Goal slice 自动续跑"]);
  assert.equal(goal.criteria.length, 2);
});

test("referential Goal without structured source criteria pauses before any agent slice", async () => {
  const goal = goalState.createGoalDefinition({ objective: "修复这些问题" });
  assert.equal(goal.criteriaReviewRequired, true);
  assert.equal(goal.status, "awaiting_input");
  let iterations = 0;
  const harness = createEngineCallbacks(async () => {
    iterations += 1;
    throw new Error("ambiguous Goal must not execute");
  });

  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(iterations, 0);
  assert.equal(outcome.status, "awaiting_input");
  assert.equal(outcome.stopClass, "awaiting_input");
  assert.equal(outcome.reason, "goal_criteria_clarification_required");
});

test("polluted Goal v2 migration invalidates old evidence and requires review", () => {
  const pollutedText = [
    "[turn_intake]",
    "workflowMode: edit",
    "priority: runtime-only",
    "[user_request]",
    "Fix Goal Runtime and run tests",
    "[/user_request]",
    "[/turn_intake]",
  ].join("\n");
  const legacyGoal = {
    ...goalState.createGoalDefinition({ objective: "placeholder" }),
    schemaVersion: 2,
    objective: pollutedText,
    rawText: pollutedText,
    revision: 1,
    status: "active",
    criteria: [{ id: "criterion_1", text: pollutedText, required: true, status: "satisfied", evidenceIds: ["old"] }],
  };
  const progress = goalState.createGoalProgress(legacyGoal.id, ".MAIN/goals/progress.md");
  progress.evidence = [{
    id: "old",
    goalId: legacyGoal.id,
    goalRevision: 1,
    iteration: 1,
    kind: "test",
    status: "passed",
    sourceTool: "run_command",
    target: "npm test",
    summary: "passed",
    references: [],
    criterionIds: ["criterion_1"],
    createdAt: 1,
  }];
  const migrated = goalRuntime.normalizeGoalRuntimeSnapshot({
    schemaVersion: 2,
    goal: legacyGoal,
    progress,
    status: "active",
    phase: "execute",
    updatedAt: 10,
  });

  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.goal.objective, "Fix Goal Runtime and run tests");
  assert.equal(migrated.goal.revision, 2);
  assert.doesNotMatch(migrated.goal.sourceContext || "", /\[turn_intake\]|priority:/);
  assert.equal(migrated.status, "paused");
  assert.equal(migrated.pauseReason, "goal_definition_migrated_review_required");
  assert.ok(migrated.goal.criteria.every((criterion) => criterion.status === "pending"));
  assert.deepEqual(migrated.progress.evidence[0].criterionIds, []);
  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal: migrated.goal,
    evidence: migrated.progress.evidence,
    completionCandidate: true,
  }).passed, false);
});

test("clean Goal v2 migration upgrades in place without a review pause", () => {
  const legacyGoal = {
    ...goalState.createGoalDefinition({ objective: "Analyze the repository" }),
    schemaVersion: 2,
    revision: 4,
    status: "active",
  };
  const migrated = goalState.migrateGoalDefinition(legacyGoal);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.revision, 4);
  assert.equal(migrated.status, "active");
  assert.equal(migrated.migrationReviewRequired, false);
});

test("central Goal tool classification treats project skeleton as read and unknown tools as non-authoritative", () => {
  const goal = goalState.createGoalDefinition({ objective: "Analyze the repository" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "get_project_skeleton", result: "src/" },
      { name: "mystery_success_tool", result: "ok", success: true },
    ],
  });
  assert.equal(evidence[0].kind, "read");
  assert.equal(evidence[0].status, "observed");
  assert.equal(evidence[1].kind, "unknown");
  assert.equal(evidence[1].status, "observed");
  assert.equal(goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: [evidence[1]],
    completionCandidate: true,
  }).passed, false);
});

test("Goal MCP classification distinguishes reads, workspace mutations, and unknown actions", () => {
  const goal = goalState.createGoalDefinition({ objective: "修改 Unity 脚本并验证" });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    now: 20,
    observations: [
      { name: "mcp__unity__read_console", result: "no errors" },
      { name: "mcp__unity__script_apply_edits", target: "Assets/Foo.cs", result: "updated" },
      { name: "mcp__vendor__mystery", result: "ok" },
    ],
  });
  assert.deepEqual(evidence.map((entry) => entry.kind), ["read", "file_change", "unknown"]);
  assert.equal(evidence[0].status, "observed");
  assert.equal(evidence[1].status, "passed");
  assert.equal(evidence[2].status, "observed");
});

test("Goal observation reconciliation does not duplicate completed transcript tool calls", () => {
  const merged = goalRuntime.mergeGoalToolObservations(
    [
      {
        id: "call-write-a",
        name: "apply_patch",
        arguments: { path: "src/a.ts" },
        result: "Done",
      },
      {
        id: "call-write-b",
        name: "apply_patch",
        arguments: { path: "src/b.ts" },
        result: "Done",
      },
    ],
    [
      {
        id: "call-write-a",
        name: "apply_patch",
        target: "src/a.ts",
        result: "Applied patch",
        success: true,
      },
      {
        id: "legacy-runtime-b",
        name: "apply_patch",
        target: "src/b.ts",
        result: "Applied patch",
        success: true,
      },
    ],
  );

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((entry) => goalRuntime.resolveGoalToolTarget(entry)), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(merged.map((entry) => entry.success), [true, true]);

  const goal = goalState.createGoalDefinition({
    objective: "修改 src/a.ts 和 src/b.ts",
    definitionOfDone: ["修改 src/a.ts", "修改 src/b.ts"],
  });
  const evidence = goalRuntime.createGoalEvidenceEntries({ goal, iteration: 1, observations: merged, now: 10 });
  assert.equal(evidence.length, 2, "one runtime lifecycle block must map to one provider tool call");
});

test("completion evidence is assigned per criterion instead of blanket-copying all evidence", () => {
  const goal = goalState.createGoalDefinition({
    objective: "Ship the widget",
    definitionOfDone: ["Implement the widget", "npm test passes"],
  });
  const evidence = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "apply_patch", target: "src/widget.ts", result: "Done" },
      { name: "run_command", arguments: { command: "npm test" }, result: "12 passed, 0 failed" },
    ],
  });
  const result = goalRuntime.evaluateGoalCompletion({ goal, evidence, completionCandidate: true });
  assert.equal(result.passed, true);
  assert.deepEqual(result.criteria[0].evidenceIds, [evidence[0].id]);
  assert.deepEqual(result.criteria[1].evidenceIds, [evidence[1].id]);
});

test("one file change cannot satisfy two distinct mutation criteria", () => {
  const goal = goalState.createGoalDefinition({
    objective: "Implement both features",
    definitionOfDone: ["Implement feature alpha", "Implement feature beta"],
  });
  const alphaOnly = goalRuntime.createGoalEvidenceEntries({
    goal,
    iteration: 1,
    observations: [
      { name: "apply_patch", target: "src/feature-alpha.ts", result: "Done" },
    ],
  });
  const result = goalRuntime.evaluateGoalCompletion({
    goal,
    evidence: alphaOnly,
    completionCandidate: true,
  });

  assert.equal(result.passed, false);
  assert.equal(result.criteria[0].status, "satisfied");
  assert.equal(result.criteria[1].status, "pending");
  assert.deepEqual(result.criteria[0].evidenceIds, [alphaOnly[0].id]);
  assert.deepEqual(result.criteria[1].evidenceIds, []);
});

test("finite Goal budget normalization rejects NaN and Infinity overrides", () => {
  const budget = goalBudget.resolveGoalBudget({
    maxIterations: Number.NaN,
    maxTokens: Number.POSITIVE_INFINITY,
    maxToolCalls: Number.POSITIVE_INFINITY,
    maxDurationMs: Number.POSITIVE_INFINITY,
    checkpointInterval: Number.NaN,
    userConfirmInterval: Number.POSITIVE_INFINITY,
    maxNoProgressIterations: Number.NaN,
  });
  assert.equal(budget.maxIterations, goalBudget.DEFAULT_GOAL_BUDGET.maxIterations);
  assert.equal(budget.maxTokens, undefined);
  assert.equal(budget.maxToolCalls, goalBudget.DEFAULT_GOAL_BUDGET.maxToolCalls);
  assert.equal(budget.maxDurationMs, goalBudget.DEFAULT_GOAL_BUDGET.maxDurationMs);
  assert.ok(Object.values(budget).filter((value) => value !== undefined).every(Number.isFinite));
});

test("inner max-iterations is an automatic next slice with exact stop reason and usage", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    runs += 1;
    if (runs === 1) {
      return {
        assistantText: "Patched the runtime.\n## Next\n- Run lint",
        toolCalls: [{ name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" }],
        tokensUsed: 500,
        completed: false,
        outcomeStatus: "stopped_no_action",
        stopReason: "max_iterations_boundary",
        sliceBoundaryReached: true,
        usage: { modelIterations: 8, toolCalls: 1, tokensUsed: 500, estimatedTokens: true },
      };
    }
    return {
      assistantText: "Lint passed. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [{ name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" }],
      tokensUsed: 200,
      completed: true,
      outcomeStatus: "completed",
      stopReason: "agent_loop_completed",
      usage: { modelIterations: 2, toolCalls: 1, tokensUsed: 200, estimatedTokens: true },
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(runs, 2);
  assert.equal(outcome.usage.modelIterations, 10);
  assert.equal(outcome.usage.toolCalls, 2);
  assert.equal(outcome.usage.totalTokensUsed, 700);
  assert.equal(outcome.lastStopReason, "agent_loop_completed");
  assert.equal(harness.runtimeUpdates.at(-1).progress.iterations[0].stopReason, "max_iterations_boundary");
  assert.equal(harness.runtimeUpdates.at(-1).progress.iterations[0].stopClass, "slice_budget_exhausted");
});

test("read-only 8/8 slice preserves slice_budget_exhausted while recovery tracks no progress", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor Goal Runtime and run lint", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    runs += 1;
    if (runs === 1) {
      return {
        assistantText: "Inspected the project; implementation remains.",
        toolCalls: [{ name: "get_project_skeleton", result: "src/" }],
        tokensUsed: 300,
        completed: false,
        outcomeStatus: "stopped_no_action",
        stopReason: "max_iterations_boundary",
        sliceBoundaryReached: true,
        usage: { modelIterations: 8, toolCalls: 1, tokensUsed: 300, estimatedTokens: true },
      };
    }
    return {
      assistantText: "Implemented and verified. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [
        { name: "apply_patch", target: "src/lib/goalRuntime.ts", result: "Done" },
        { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
      ],
      tokensUsed: 200,
      completed: true,
      outcomeStatus: "completed",
      stopReason: "agent_loop_completed",
      usage: { modelIterations: 2, toolCalls: 2, tokensUsed: 200, estimatedTokens: true },
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  const firstSlice = harness.runtimeUpdates.at(-1).progress.iterations[0];
  assert.equal(firstSlice.stopClass, "slice_budget_exhausted");
});

test("permission and unrecoverable inner outcomes map to awaiting_input and failed", async () => {
  const permissionGoal = goalState.createGoalDefinition({ objective: "Fix runtime", iterationBudget: 10 });
  const permissionHarness = createEngineCallbacks(async () => ({
    assistantText: "Approval required",
    toolCalls: [],
    tokensUsed: 10,
    completed: false,
    outcomeStatus: "paused",
    stopReason: "permission_approval_required",
  }));
  const permissionOutcome = await goalEngine.executeGoalLoop({ goal: permissionGoal, callbacks: permissionHarness.callbacks });
  assert.equal(permissionOutcome.status, "awaiting_input");
  assert.equal(permissionOutcome.stopClass, "awaiting_input");

  const fatalGoal = goalState.createGoalDefinition({ objective: "Fix runtime", iterationBudget: 10 });
  const fatalHarness = createEngineCallbacks(async () => ({
    assistantText: "Model unavailable",
    toolCalls: [],
    tokensUsed: 10,
    completed: false,
    outcomeStatus: "error",
    stopReason: "model_not_found",
  }));
  const fatalOutcome = await goalEngine.executeGoalLoop({ goal: fatalGoal, callbacks: fatalHarness.callbacks });
  assert.equal(fatalOutcome.status, "failed");
  assert.equal(fatalOutcome.stopClass, "unrecoverable_error");
});

test("only the same normalized recoverable cause reaches blocked", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor runtime and run lint", iterationBudget: 10 });
  const results = [
    { outcomeStatus: "error", stopReason: "provider stream failed", assistantText: "retry", toolCalls: [] },
    { outcomeStatus: "stopped_no_output", stopReason: "no_output", assistantText: "retry", toolCalls: [] },
    { outcomeStatus: "error", stopReason: "provider stream failed", assistantText: "retry", toolCalls: [] },
    {
      outcomeStatus: "completed",
      stopReason: "agent_loop_completed",
      assistantText: "Done. GOAL_COMPLETION_CANDIDATE",
      toolCalls: [
        { name: "apply_patch", target: "src/runtime.ts", result: "Done" },
        { name: "run_command", arguments: { command: "npm run lint" }, result: "0 errors" },
      ],
    },
  ];
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    const result = results[runs++];
    return {
      ...result,
      tokensUsed: 10,
      completed: result.outcomeStatus === "completed",
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "completed");
  assert.equal(runs, 4);
});

test("three completed but evidence-free slices become no_progress blocked", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor runtime", iterationBudget: 10 });
  let runs = 0;
  const harness = createEngineCallbacks(async () => {
    runs += 1;
    return {
      assistantText: "Inspected only",
      toolCalls: [{ name: "get_project_skeleton", result: "src/" }],
      tokensUsed: 10,
      completed: true,
      outcomeStatus: "completed",
      stopReason: "agent_loop_completed",
    };
  });
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.stopClass, "blocked");
  assert.equal(outcome.reason, "no_progress");
  assert.equal(runs, 3);
  assert.equal(outcome.finalCheckpoint.iteration, 3);
});

test("an inner abort maps to paused instead of recovery", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor runtime", iterationBudget: 10 });
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Stopped",
    toolCalls: [],
    tokensUsed: 0,
    completed: false,
    outcomeStatus: "aborted",
    stopReason: "agent_loop_aborted",
  }));
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.stopClass, "user_paused");
});

test("total Goal slice budget pauses with an exact resumable stop class", async () => {
  const goal = goalState.createGoalDefinition({ objective: "Refactor runtime", iterationBudget: 1 });
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Patched one file; validation remains.",
    toolCalls: [{ name: "apply_patch", target: "src/runtime.ts", result: "Done" }],
    tokensUsed: 20,
    completed: false,
    outcomeStatus: "stopped_no_action",
    stopReason: "slice_work_remaining",
  }));
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.stopClass, "total_slice_budget_exhausted");
  assert.equal(outcome.lastStopReason, "iteration_limit");
  assert.equal(harness.runtimeUpdates.at(-1).status, "paused");
  assert.equal(harness.runtimeUpdates.at(-1).stopClass, "total_slice_budget_exhausted");
});

test("Goal tool-call budget is enforced independently from slice and token budgets", async () => {
  const goal = goalState.createGoalDefinition({
    objective: "Refactor runtime",
    iterationBudget: 10,
    toolCallBudget: 1,
  });
  const harness = createEngineCallbacks(async () => ({
    assistantText: "Patched one file; validation remains.",
    toolCalls: [{ name: "apply_patch", target: "src/runtime.ts", result: "Done" }],
    tokensUsed: 20,
    completed: false,
    outcomeStatus: "stopped_no_action",
    stopReason: "slice_work_remaining",
  }));
  const outcome = await goalEngine.executeGoalLoop({ goal, callbacks: harness.callbacks });
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.stopClass, "tool_call_budget_exhausted");
  assert.equal(outcome.usage.toolCalls, 1);
});
