import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();
function loadTs(sourcePath) {
  const absolute = path.resolve(sourcePath);
  if (cache.has(absolute)) return cache.get(absolute);
  const output = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: absolute,
  }).outputText;
  const module = { exports: {} };
  cache.set(absolute, module.exports);
  const localRequire = createRequire(absolute);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(absolute), specifier);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(absolute, module.exports);
  return module.exports;
}

const root = process.cwd();
const tools = loadTs(path.join(root, "src/lib/executeRecoveryTools.ts"));
const runtime = loadTs(path.join(root, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"));

function exhaustedState(attempted = [], readLease = null) {
  return {
    mode: readLease ? "patch_recovery_read" : "mutation_first",
    reason: "read_only_no_progress",
    expectedTarget: "src/main.ts",
    attempts: 1,
    phaseNoProgressCount: runtime.MAX_EXECUTE_RECOVERY_ITERATIONS + 1,
    protocolNoProgressCount: runtime.MAX_EXECUTE_RECOVERY_ITERATIONS,
    protocolNoProgressFingerprint: "read_file::src/main.ts",
    iterationCount: runtime.MAX_EXECUTE_RECOVERY_ITERATIONS + 1,
    readLease,
    sourceObservationKey: "src/main.ts::v1",
    decisionCheckpoint: {
      expectedTarget: "src/main.ts",
      sourceObservationKey: "src/main.ts::v1",
      nextRequiredCapability: readLease ? "targeted_read" : "mutation",
      planTaskId: "task-handle-open-file",
      requirementRef: "Implement handleOpenFile and verify behavior",
      noProgressStrategyPivots: attempted,
    },
  };
}

test("phase threshold pivots twice before the bounded recovery fuse pauses", () => {
  const first = runtime.resolveExecuteRecoveryNoProgressBoundary({
    state: exhaustedState([], {
      purpose: "context_restore",
      target: "src/main.ts",
      state: "available",
    }),
    cause: "execute_recovery_phase_budget",
    language: "en",
    availableToolNames: ["read_file", "apply_patch", "run_command"],
  });
  assert.equal(first.decision.action, "continue_with_pivot");
  assert.equal(first.decision.strategy, "current_task_action_lock");
  assert.equal(first.state.mode, "mutation_first");
  assert.equal(first.state.readLease, null, "the repeated read surface is closed");
  assert.equal(first.state.phaseNoProgressCount, 0);
  assert.deepEqual(first.state.decisionCheckpoint.noProgressStrategyPivots, [
    "current_task_action_lock",
  ]);
  assert.match(first.decision.prompt, /currentTaskId: task-handle-open-file/);
  assert.match(first.decision.prompt, /availableCapabilities: apply_patch, read_file, run_command/);

  const second = runtime.resolveExecuteRecoveryNoProgressBoundary({
    state: exhaustedState(first.state.decisionCheckpoint.noProgressStrategyPivots),
    cause: "execute_recovery_phase_budget",
    language: "en",
    availableToolNames: ["apply_patch", "run_command"],
  });
  assert.equal(second.decision.action, "continue_with_pivot");
  assert.equal(second.decision.strategy, "alternate_capability_reframe");
  assert.deepEqual(second.state.decisionCheckpoint.noProgressStrategyPivots, [
    "current_task_action_lock",
    "alternate_capability_reframe",
  ]);
  assert.equal(
    second.state.phaseNoProgressCount,
    runtime.MAX_EXECUTE_RECOVERY_ITERATIONS + 1,
    "a wording-only alternate strategy cannot refund the phase budget",
  );
  assert.equal(
    second.state.protocolNoProgressCount,
    runtime.MAX_EXECUTE_RECOVERY_ITERATIONS,
  );

  const finalBoundary = runtime.resolveExecuteRecoveryNoProgressBoundary({
    state: exhaustedState(second.state.decisionCheckpoint.noProgressStrategyPivots),
    cause: "execute_recovery_phase_budget",
    language: "en",
    availableToolNames: ["apply_patch", "run_command"],
  });
  assert.equal(finalBoundary.decision.action, "pause");
  assert.deepEqual(finalBoundary.decision.attemptedStrategies, [
    "current_task_action_lock",
    "alternate_capability_reframe",
  ]);
  assert.equal(
    finalBoundary.state.phaseNoProgressCount,
    runtime.MAX_EXECUTE_RECOVERY_ITERATIONS + 1,
    "strategy exhaustion does not silently expand or refund the hard budget",
  );
});

test("a targeting read cannot erase no-progress strategy history", () => {
  const targeting = {
    ...exhaustedState(["current_task_action_lock"]),
    mode: "action_plus_targeting",
    readLease: null,
    decisionCheckpoint: {
      ...exhaustedState(["current_task_action_lock"]).decisionCheckpoint,
      nextRequiredCapability: "targeting",
    },
  };
  const observed = runtime.transitionExecuteRecoveryRuntimeState(targeting, {
    freshReadTarget: "src/main.ts",
    sourceObservationKey: "src/main.ts::v2::1-120",
    sourceObservedVersion: "v2",
  });

  assert.equal(observed.transition, "context_to_mutation");
  assert.equal(observed.state.decisionCheckpoint.nextRequiredCapability, "mutation");
  assert.deepEqual(observed.state.decisionCheckpoint.noProgressStrategyPivots, [
    "current_task_action_lock",
  ]);

  const nextBoundary = runtime.resolveExecuteRecoveryNoProgressBoundary({
    state: observed.state,
    cause: "execute_recovery_phase_budget",
    language: "en",
    availableToolNames: ["apply_patch"],
  });
  assert.equal(nextBoundary.decision.action, "continue_with_pivot");
  assert.equal(nextBoundary.decision.strategy, "alternate_capability_reframe");
});

test("pinned validation pivots cannot multiply the same run_command-only budget", () => {
  const state = {
    ...exhaustedState(),
    mode: "validation_only",
    decisionCheckpoint: {
      ...exhaustedState().decisionCheckpoint,
      nextRequiredCapability: "validation",
      pendingFiniteValidation: { command: "npm test", cwd: "." },
    },
  };
  const pivot = runtime.resolveExecuteRecoveryNoProgressBoundary({
    state,
    cause: "execute_recovery_phase_budget",
    language: "en",
    availableToolNames: ["run_command"],
  });

  assert.equal(pivot.decision.action, "continue_with_pivot");
  assert.equal(pivot.state.mode, "validation_only");
  assert.equal(pivot.state.phaseNoProgressCount, state.phaseNoProgressCount);
  assert.equal(pivot.state.iterationCount, state.iterationCount);
  assert.equal(pivot.state.protocolNoProgressCount, state.protocolNoProgressCount);
  assert.equal(pivot.state.protocolNoProgressFingerprint, state.protocolNoProgressFingerprint);
});

test("strategy selection is capability-based and contains no provider or model branch", () => {
  const local = tools.resolveExecuteNoProgressStrategyDecision({
    attemptedStrategies: [],
    currentTaskId: "task-1",
    expectedTarget: "src/main.ts",
    unfinishedObjective: "apply the pending edit",
    availableToolNames: ["apply_patch"],
    cause: "cache_stub",
    language: "en",
  });
  const cloud = tools.resolveExecuteNoProgressStrategyDecision({
    attemptedStrategies: [],
    currentTaskId: "task-1",
    expectedTarget: "src/main.ts",
    unfinishedObjective: "apply the pending edit",
    availableToolNames: ["apply_patch"],
    cause: "cache_stub",
    language: "en",
  });
  assert.deepEqual(local, cloud);

  const loopSource = fs.readFileSync(
    path.join(root, "src/lib/orchestrator/loop/loopRecovery.ts"),
    "utf8",
  );
  assert.doesNotMatch(loopSource, /activeProfile\s*===/);
  assert.match(loopSource, /chat_repair_no_progress_strategy_pivot/);
  assert.match(loopSource, /strict_repeat_strategy_pivot/);
});
