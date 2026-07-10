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
  assert.equal(forcedEdit.attempts, 1);

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

  for (let i = 1; i <= MAX_EXECUTE_RECOVERY_ITERATIONS; i += 1) {
    const advanced = advanceExecuteRecoveryRuntimeIteration(state);
    state = advanced.state;
    assert.equal(advanced.reachedMaxIterations, i === MAX_EXECUTE_RECOVERY_ITERATIONS);
  }
  assert.equal(state.iterationCount, MAX_EXECUTE_RECOVERY_ITERATIONS);

  state = clearExecuteRecoveryRuntimeState(state);
  assert.equal(state.mode, "normal");
  assert.equal(state.reason, "");
  assert.equal(state.attempts, 0);
  assert.equal(state.iterationCount, 0);
  assert.equal(state.consecutiveBlockedReadFileCount, 1);
  assert.equal(state.repeatedEditValidationAttempts, 1);
});

test("execute recovery state records blocked-read and validation recovery counters", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    { mode: "mutation_first", reason: "read_loop" },
  );
  state = applyCrossIterationReadFileRecoveryState(state, {
    mode: "normal",
    reason: "",
    consecutiveBlockedReadFileCount: 0,
  });
  assert.equal(state.mode, "normal");
  assert.equal(state.reason, "");
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
