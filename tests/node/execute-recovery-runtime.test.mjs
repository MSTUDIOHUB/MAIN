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
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  MAX_EXECUTE_RECOVERY_ITERATIONS,
  activateExecuteRecoveryRuntimeState,
  advanceExecuteRecoveryRuntimeIteration,
  applyCrossIterationReadFileRecoveryState,
  buildExecuteRecoveryMaxIterationsPrompt,
  clearExecuteRecoveryRuntimeState,
  createExecuteRecoveryRuntimeState,
  setRepeatedEditValidationRecoveryAttempts,
  transitionExecuteRecoveryRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"),
);

test("execute recovery state initializes forced edit recovery only for edit turns", () => {
  const forcedEdit = createExecuteRecoveryRuntimeState({
    workflowMode: "edit",
    forcedMode: "patch_recovery_read",
  });
  assert.equal(forcedEdit.mode, "patch_recovery_read");
  assert.equal(forcedEdit.reason, "forced_execute_recovery");
  assert.equal(forcedEdit.expectedTarget, null);
  assert.equal(forcedEdit.attempts, 1);

  const restoredTransaction = createExecuteRecoveryRuntimeState({
    workflowMode: "edit",
    forcedState: {
      mode: "validation_only",
      reason: "goal_slice_recovery_restored",
      expectedTarget: "src/App.tsx",
    },
  });
  assert.equal(restoredTransaction.mode, "validation_only");
  assert.equal(restoredTransaction.reason, "goal_slice_recovery_restored");
  assert.equal(restoredTransaction.expectedTarget, "src/App.tsx");

  const forcedChat = createExecuteRecoveryRuntimeState({
    workflowMode: "chat",
    forcedMode: "mutation_first",
  });
  assert.equal(forcedChat.mode, "normal");
  assert.equal(forcedChat.reason, "");
  assert.equal(forcedChat.attempts, 0);
});

test("execute recovery state activates, advances, and clears without losing loop counters", () => {
  let state = createExecuteRecoveryRuntimeState({ workflowMode: "plan" });
  state = {
    ...state,
    consecutiveBlockedReadFileCount: 1,
    repeatedEditValidationAttempts: 1,
  };

  state = activateExecuteRecoveryRuntimeState(state, {
    mode: "mutation_first",
    reason: "read_loop",
  });
  assert.equal(state.mode, "mutation_first");
  assert.equal(state.reason, "read_loop");
  assert.equal(state.attempts, 1);

  state = activateExecuteRecoveryRuntimeState(
    { ...state, expectedTarget: "src/App.tsx" },
    { mode: "mutation_first", reason: "same_transaction_retry" },
  );
  assert.equal(state.expectedTarget, "src/App.tsx", "reactivation preserves the active transaction target");

  for (let i = 1; i <= MAX_EXECUTE_RECOVERY_ITERATIONS; i += 1) {
    const advanced = advanceExecuteRecoveryRuntimeIteration(state);
    state = advanced.state;
    assert.equal(advanced.reachedMaxIterations, i === MAX_EXECUTE_RECOVERY_ITERATIONS);
  }
  assert.equal(state.iterationCount, MAX_EXECUTE_RECOVERY_ITERATIONS);

  state = clearExecuteRecoveryRuntimeState(state);
  assert.equal(state.mode, "normal");
  assert.equal(state.reason, "");
  assert.equal(state.expectedTarget, null);
  assert.equal(state.attempts, 0);
  assert.equal(state.iterationCount, 0);
  assert.equal(state.consecutiveBlockedReadFileCount, 1);
  assert.equal(state.repeatedEditValidationAttempts, 1);
});

test("execute recovery state records blocked-read and validation recovery counters", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    { mode: "mutation_first", reason: "read_loop", expectedTarget: "src/App.tsx" },
  );
  state = applyCrossIterationReadFileRecoveryState(state, {
    mode: "normal",
    reason: "",
    consecutiveBlockedReadFileCount: 0,
  });
  assert.equal(state.mode, "normal");
  assert.equal(state.reason, "");
  assert.equal(state.expectedTarget, null);
  assert.equal(state.attempts, 1);

  state = setRepeatedEditValidationRecoveryAttempts(state, 2);
  assert.equal(state.repeatedEditValidationAttempts, 2);
});

test("execute recovery max-iteration prompt is generated from the shared limit", () => {
  assert.match(
    buildExecuteRecoveryMaxIterationsPrompt({ language: "en" }),
    new RegExp(String(MAX_EXECUTE_RECOVERY_ITERATIONS)),
  );
  assert.match(
    buildExecuteRecoveryMaxIterationsPrompt({ language: "zh", maxIterations: 3 }),
    /3/,
  );
});

test("execute recovery transaction advances read to mutation to validation without spending attempts", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    { mode: "patch_recovery_read", reason: "read_only_loop" },
  );
  const attempts = state.attempts;

  const cached = transitionExecuteRecoveryRuntimeState(state, {});
  assert.equal(cached.transition, "none");
  assert.equal(cached.state.mode, "patch_recovery_read");

  const wrongRead = transitionExecuteRecoveryRuntimeState(state, {
    expectedTarget: "src/App.tsx",
    freshReadTarget: "src/other.ts",
  });
  assert.equal(wrongRead.transition, "none");
  assert.equal(wrongRead.state.mode, "patch_recovery_read");
  assert.equal(wrongRead.state.expectedTarget, "src/App.tsx");
  assert.equal(wrongRead.consumedExpectedRead, false);

  const read = transitionExecuteRecoveryRuntimeState(wrongRead.state, {
    freshReadTarget: "./src/App.tsx",
  });
  assert.equal(read.transition, "context_to_mutation");
  assert.equal(read.state.mode, "mutation_first");
  assert.equal(read.state.expectedTarget, "src/App.tsx");
  assert.equal(read.state.attempts, attempts);
  assert.equal(read.consumedExpectedRead, true);
  state = read.state;

  const validationTooEarly = transitionExecuteRecoveryRuntimeState(state, { validationTarget: "npm test" });
  assert.equal(validationTooEarly.transition, "none");
  assert.equal(validationTooEarly.state.mode, "mutation_first");

  const wrongMutation = transitionExecuteRecoveryRuntimeState(state, {
    mutationTarget: "src/other.ts",
  });
  assert.equal(wrongMutation.transition, "none");
  assert.equal(wrongMutation.state.mode, "mutation_first");
  assert.equal(wrongMutation.state.expectedTarget, "src/App.tsx");

  const mutation = transitionExecuteRecoveryRuntimeState(wrongMutation.state, {
    mutationTarget: "/tmp/workspace/src/App.tsx",
  });
  assert.equal(mutation.transition, "mutation_to_validation");
  assert.equal(mutation.state.mode, "validation_only");
  assert.equal(mutation.state.expectedTarget, "src/App.tsx");
  assert.equal(mutation.state.attempts, attempts);
  state = mutation.state;

  const verified = transitionExecuteRecoveryRuntimeState(state, { validationTarget: "npm test" });
  assert.equal(verified.transition, "validation_to_normal");
  assert.equal(verified.target, "src/App.tsx", "validation keeps the transaction target instead of its command label");
  assert.equal(verified.state.mode, "normal");
  assert.equal(verified.state.expectedTarget, null);
  assert.equal(verified.state.attempts, 0);
});
